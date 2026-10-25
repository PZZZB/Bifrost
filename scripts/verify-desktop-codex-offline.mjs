import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { CodeBuddyLocal } from '../src/providers/codebuddy-local.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';
import { ModelRouter } from '../src/routing/model-router.mjs';
import { createDesktopServer } from '../src/runtime/desktop-server.mjs';
import { createClientRegistry } from '../src/clients/index.mjs';
import { codexProviderConfig, codexConfigArgs } from '../src/clients/codex.mjs';
import { CodexRpc } from '../src/rpc.mjs';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';

// Real Codex, loopback inference, canned upstreams and a disposable local proof file.
// Never reads the user's login, sends an external request, or consumes model credits.
const work = await mkdtemp(join(tmpdir(), 'bifrost-desktop-codex-'));
const home = join(work, 'home'); await mkdir(home, { mode: 0o700 });
const identity = { apiKey: `bdk_${randomBytes(32).toString('base64url')}`, secret: randomBytes(32).toString('base64url') };
const macKey = `bfk_${randomBytes(32).toString('base64url')}`;
const proof = join(work, 'proof.txt'), expected = `bifrost-desktop-proof-${randomBytes(12).toString('hex')}`;
await writeFile(proof, expected + '\n', { mode: 0o600 });
const binary = await resolveCodexBinary();
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'TERM'].includes(name)));
Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home, TMPDIR: work, TEMP: work, TMP: work, BIFROST_DESKTOP_API_KEY: identity.apiKey });
const nativeUsage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
const totals = { company: 0, mac: 0 }, rounds = { company: 0, mac: 0 }, checked = { company: false, mac: false };
let child, rpc, timeout, server, router;
function toolArgs(schema) {
  const properties = schema?.properties || {};
  const command = process.platform === 'win32' ? `Get-Content -LiteralPath '${proof.replaceAll("'", "''")}' -Raw` : `/bin/cat '${proof.replaceAll("'", "'\\''")}'`;
  const args = {};
  if (Object.hasOwn(properties, 'cmd')) args.cmd = command;
  else if (Object.hasOwn(properties, 'command')) args.command = properties.command.type === 'array'
    ? process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] : ['/bin/sh', '-c', command] : command;
  else throw new Error('Codex did not declare a supported local shell tool.');
  if (Object.hasOwn(properties, 'workdir')) args.workdir = work;
  if (Object.hasOwn(properties, 'login')) args.login = false;
  if (Object.hasOwn(properties, 'yield_time_ms')) args.yield_time_ms = 10000;
  if (Object.hasOwn(properties, 'timeout_ms')) args.timeout_ms = 10000;
  if (Object.hasOwn(properties, 'max_output_tokens')) args.max_output_tokens = 1000;
  return args;
}
function shellTool(tools, messages = false) {
  const tool = tools?.find(tool => /Tool (?:exec_command|shell_command|shell):/.test(messages ? tool.description : tool.function?.description));
  assert.ok(tool, 'Real Codex must declare a client shell tool.');
  return messages ? { name: tool.name, args: toolArgs(tool.input_schema) } : { name: tool.function.name, args: toolArgs(tool.function.parameters) };
}
function chatSse(values) {
  const bytes = Buffer.from(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('')); let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(at, at + 13)); at = Math.min(bytes.length, at + 13);
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const provider = new CodeBuddyProvider({ loadThinkingState: () => new CodeBuddyThinkingState({ key: randomBytes(32) }), client: {
  status: async () => ({ authenticated: true, identity: { uid: 'offline-company-owner' } }),
  modelCatalog: async () => [{ id: 'internal-fixture', name: 'Company fixture', supportsToolCall: true }],
  async chatCompletions({ body }) {
    totals.company++; const round = ++rounds.company; assert.equal(body.model, 'internal-fixture');
    if (round === 1) {
      const tool = shellTool(body.tools);
      return chatSse([chunk({ role: 'assistant', reasoning_content: 'private fixture thinking', extra_fields: { fixture: true } }),
        chunk({ tool_calls: [{ index: 0, id: 'company_tool', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }),
        chunk({}, 'tool_calls'), { choices: [], usage: nativeUsage }, '[DONE]']);
    }
    assert.equal(round, 2);
    assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(expected)));
    assert.ok(body.messages.some(message => message.role === 'assistant' && message.reasoning_content === 'private fixture thinking'));
    checked.company = true;
    return chatSse([chunk({ role: 'assistant', content: expected }), chunk({}, 'stop'), { choices: [], usage: nativeUsage }, '[DONE]']);
  } } });
const local = new CodeBuddyLocal({ service: { provider, authorizationVersion: 0, getModels: options => provider.getModels(options), async close() {} } });
const remote = new BifrostRemote({ baseUrl: 'https://offline.invalid/v1', apiKey: macKey, stateSecret: identity.secret,
  fetchImpl: async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${macKey}`); assert.equal(options.redirect, 'manual');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'Claude-sonnet' }] });
    assert.equal(url, 'https://offline.invalid/v1/messages');
    totals.mac++; const round = ++rounds.mac, body = JSON.parse(options.body);
    assert.equal(body.model, 'Claude-sonnet');
    let content, stop_reason;
    if (round === 1) {
      const tool = shellTool(body.tools, true);
      content = [{ type: 'thinking', thinking: 'opaque fixture thinking', signature: 'OFFLINE_OPAQUE_SIGNATURE' },
        { type: 'tool_use', id: 'mac_tool', name: tool.name, input: tool.args }]; stop_reason = 'tool_use';
    } else {
      assert.equal(round, 2);
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes(expected))));
      assert.ok(body.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'thinking' && block.signature === 'OFFLINE_OPAQUE_SIGNATURE' && block.thinking === 'opaque fixture thinking')));
      checked.mac = true; content = [{ type: 'text', text: expected }]; stop_reason = 'end_turn';
    }
    return Response.json({ id: 'msg_offline', type: 'message', role: 'assistant', model: body.model, content, stop_reason,
      usage: { input_tokens: 10, output_tokens: 4 } });
  } });
try {
  router = new ModelRouter({ providers: [local, remote], secret: identity.secret }); await router.refresh();
  server = createDesktopServer({ router, apiKey: identity.apiKey, stateSecret: identity.secret, clients: createClientRegistry() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const tokenHelper = join(work, 'token-helper.mjs');
  await writeFile(tokenHelper, "process.stdout.write(process.env.BIFROST_DESKTOP_API_KEY);\n", { mode: 0o600 });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = codexProviderConfig({ baseUrl, tokenCommand: { command: process.execPath, args: [tokenHelper] } });
  const common = { ...config, cli_auth_credentials_store: 'file', check_for_update_on_startup: false, 'analytics.enabled': false, 'feedback.enabled': false };
  const nativeVersion = (await promisify(execFile)(binary, ['--version'], { env, cwd: work, timeout: 10000 })).stdout.trim();
  rpc = new CodexRpc({ binary, home, cwd: work, spawnImpl: (file, args, options) => spawn(file, [...args, ...codexConfigArgs(common)], { ...options, env }) });
  const modelList = await rpc.request('model/list', { includeHidden: false });
  const listed = modelList.data.map(model => model.model);
  const expectedModels = ['local/codebuddy/CodeBuddy-internal-fixture', 'remote/bifrost/Claude-sonnet'];
  assert.deepEqual(listed, expectedModels, 'Real Codex must see one merged list from its own catalog endpoint.');
  await rpc.close(); rpc = null;
  const runs = [];
  for (const model of expectedModels) {
    const events = [], errors = [];
    child = spawn(binary, ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', work,
      '--model', model, ...codexConfigArgs(common),
      'Read proof.txt using the provided client shell tool, then reply with exactly its contents. Do not access the network or any other file.'],
    { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.resume(); timeout = setTimeout(() => child.kill(), 60_000);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => { try { events.push(JSON.parse(line)); } catch { errors.push('non-json event'); } });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timeout); child = null;
    const reply = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text?.trim();
    const tools = events.filter(event => event.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'dynamic_tool_call'].includes(event.item?.type)).length;
    const complete = events.some(event => event.type === 'turn.completed');
    const errorMessages = events.filter(event => event.type === 'error').map(event => event.message);
    const result = { model, code, complete, tools, proofMatches: reply === expected, errors: [...errors, ...errorMessages] };
    runs.push(result); await writeFile(join(work, 'result.json'), JSON.stringify({ nativeVersion, listed, runs, totals, checked }, null, 2), { mode: 0o600 });
    assert.equal(code, 0, JSON.stringify(result)); assert.ok(complete && tools > 0 && reply === expected, JSON.stringify(result));
  }
  assert.deepEqual(totals, { company: 2, mac: 2 }); assert.deepEqual(checked, { company: true, mac: true });
  console.log(JSON.stringify({ passed: true, nativeVersion, mergedModelCount: listed.length, runs, totals, stateRoundtrip: checked, evidencePath: join(work, 'result.json') }, null, 2));
} finally {
  clearTimeout(timeout); child?.kill(); await rpc?.close();
  server?.stopRequests(); server?.closeAllConnections(); await router?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}
