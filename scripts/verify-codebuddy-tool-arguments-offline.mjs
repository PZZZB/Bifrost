import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';
import { appendCodeBuddyModels } from '../src/models.mjs';
import { codeBuddyModelAlias } from '../src/codebuddy-models.mjs';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { Gateway } from '../src/gateway.mjs';
import { CodexRpc } from '../src/rpc.mjs';

// Exercise real native argument validation through the complete adapter chain.
// All accounts, responses, usage and tool inputs are synthetic. Only loopback
// networking is available, and each case uses an isolated native configuration.
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--binary' || !args[1] || args[1].startsWith('--'))) {
  throw new Error('Expected [--binary /path/to/native/codex].');
}
const work = fileURLToPath(new URL(`../.state/codebuddy-tool-arguments-offline-${Date.now()}-${randomBytes(3).toString('hex')}/`, import.meta.url));
await mkdir(work, { recursive: true, mode: 0o700 });
const source = { id: 'gpt-6.1-sol', name: 'Offline GPT-6.1 Sol', supportsToolCall: true,
  inputModalities: ['text'], efforts: ['medium'], defaultEffort: 'medium', contextWindow: 200000, maxOutputTokens: 32768 };
const model = codeBuddyModelAlias(source).id;
const catalog = appendCodeBuddyModels({ models: [] }, [codeBuddyModelAlias(source)]);
catalog.models[0].base_instructions = 'Offline protocol fixture. Process the supplied canned response. Do not run commands or use the network.';
catalog.models[0].model_messages = { instructions_template: catalog.models[0].base_instructions };
const catalogPath = join(work, 'catalog.json');
await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
const gatewayKey = 'offline-tool-arguments-gateway-key';
const invalidArguments = '{"cmd":';
const marker = 'OFFLINE_TOOL_ARGUMENTS_RECOVERED';
const usage = { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 };
const nameVariants = ['wire-alias', 'original-name'];
const cases = [], failures = [], blockedNetworkRequests = [], sockets = new Set();
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
  'path', 'systemroot', 'windir', 'comspec', 'pathext', 'processor_architecture', 'number_of_processors',
].includes(key.toLowerCase())));
let active, binary, nativeVersion;

function cannedStream(chunks) {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index === chunks.length) { controller.close(); return; }
    const frame = chunks[index++];
    controller.enqueue(Buffer.from(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`));
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function decode(bytes, headers) {
  for (const encoding of (headers['content-encoding'] ?? 'identity').split(',').reverse().map(value => value.trim())) {
    if (encoding === 'identity') continue;
    const decompress = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync,
      zstd: zlib.zstdDecompressSync }[encoding];
    assert.equal(typeof decompress, 'function', 'Unexpected fixture request compression.');
    bytes = decompress(bytes);
  }
  return JSON.parse(bytes.toString('utf8'));
}
function functionTools(tools, namespace = null) {
  return (tools ?? []).flatMap(tool => tool.type === 'namespace' ? functionTools(tool.tools, tool.name)
    : tool.type === 'function' ? [{ ...tool, namespace }] : []);
}
function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

const provider = new CodeBuddyProvider({ loadThinkingState: () => new CodeBuddyThinkingState(), client: {
  status: async () => ({ authenticated: true, identity: { uid: 'offline-tool-arguments-owner' } }),
  modelCatalog: async () => [structuredClone(source)],
  chatCompletions: async ({ body }) => {
    assert.ok(active, 'Every provider call must belong to an active case.');
    active.modelCalls++;
    assert.equal(body.model, source.id);
    if (active.modelCalls === 1) {
      const tool = body.tools?.find(tool => /(?:^|\n)Tool exec_command:/.test(tool.function.description));
      const native = active.nativeRequests[0]?.functionTools.find(tool => tool.name === 'exec_command');
      assert.ok(tool, 'The complete adapter must declare the native exec_command tool.');
      assert.ok(native, 'The real native request must declare exec_command as a function.');
      assert.notEqual(tool.function.name, native.name, 'Wire alias and native tool name must differ.');
      assert.deepEqual(tool.function.parameters, native.parameters, 'Native argument schema must be preserved.');
      active.tool = { wireName: tool.function.name, nativeName: native.name, namespace: native.namespace };
      active.returnedToolName = active.nameVariant === 'original-name' ? native.name : tool.function.name;
      return cannedStream([
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: active.callId, type: 'function',
          function: { name: active.returnedToolName, arguments: invalidArguments.slice(0, 4) } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: invalidArguments.slice(4) } }] }),
        chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]',
      ]);
    }
    assert.equal(active.modelCalls, 2, 'Only two canned provider responses are allowed per case.');
    const priorCalls = body.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
    assert.equal(priorCalls.length, 1, 'The failed native tool call must survive history translation.');
    assert.equal(priorCalls[0].id, active.callId);
    assert.equal(priorCalls[0].function.name, active.tool.wireName);
    assert.equal(priorCalls[0].function.arguments, invalidArguments, 'Malformed arguments must round-trip without rewriting.');
    const results = body.messages.filter(message => message.role === 'tool');
    assert.equal(results.length, 1, 'The native client must return exactly one tool parsing error.');
    assert.equal(results[0].tool_call_id, active.callId);
    assert.equal(typeof results[0].content, 'string');
    assert.match(results[0].content, /^failed to parse function arguments:/);
    active.upstreamHistory = { arguments: priorCalls[0].function.arguments, toolResult: results[0].content };
    return cannedStream([chunk({ role: 'assistant', content: marker }), chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
  },
} });
const gateway = new Gateway({ gatewayKey, codeBuddyProvider: new CodeBuddyResponsesProvider({ provider }), codeBuddyEnabled: () => true,
  backend: { credentials: async () => { throw new Error('Fixture must not load account credentials.'); } },
  getAProvider: async () => { throw new Error('Fixture must not use the native account route.'); },
  fetchImpl: async () => { throw new Error('Fixture must not call a real upstream.'); },
});
const server = http.createServer(async (req, res) => {
  if (/^https?:/i.test(req.url) || req.method !== 'POST' || req.url !== '/v1/responses') {
    blockedNetworkRequests.push({ method: req.method, kind: /^https?:/i.test(req.url) ? 'external-proxy' : 'unexpected-route' });
    res.writeHead(502); res.end('{}'); return;
  }
  const result = active, parts = [];
  req.on('data', part => parts.push(part));
  req.on('end', () => {
    try {
      const body = decode(Buffer.concat(parts), req.headers);
      result.nativeRequests.push({ functionTools: functionTools(body.tools),
        functionCalls: (body.input ?? []).filter(item => item.type === 'function_call'),
        functionOutputs: (body.input ?? []).filter(item => item.type === 'function_call_output') });
    } catch (error) { result.errors.push({ phase: 'capture', message: error.message }); }
  });
  // The observer captures bytes driven by the gateway's async iterator.
  req.pause();
  try { await gateway.proxy(req, res, new URL(req.url, 'http://offline-tool-arguments.invalid')); }
  catch (error) {
    result.errors.push({ phase: 'gateway', message: error.message });
    if (!res.headersSent) res.writeHead(error.status ?? 500);
    res.end('{}');
  }
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
});
server.on('connect', (_req, socket) => {
  blockedNetworkRequests.push({ kind: 'external-connect' });
  socket.end('HTTP/1.1 502 Offline\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
server.on('upgrade', (_req, socket) => { blockedNetworkRequests.push({ kind: 'unexpected-upgrade' }); socket.destroy(); });
server.on('clientError', (_error, socket) => socket.destroy());

async function runCase(nameVariant, origin) {
  const result = { nameVariant, callId: `call_bad_arguments_${nameVariant.replaceAll('-', '_')}`, modelCalls: 0,
    reconnects: 0, nativeErrors: [], commandExecutionNotifications: 0, nativeRequests: [], errors: [] };
  active = result;
  cases.push(result);
  const home = join(work, nameVariant);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = { ...inherited, CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TEMP: home, TMP: home,
    BIFROST_TOOL_ARGUMENTS_KEY: 'offline-tool-arguments-client',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, http_proxy: origin, https_proxy: origin, all_proxy: origin,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  const config = { model, model_provider: 'offline', model_catalog_json: catalogPath, cli_auth_credentials_store: 'file',
    approval_policy: 'never', sandbox_mode: 'read-only', model_reasoning_effort: 'medium', model_reasoning_summary: 'none',
    check_for_update_on_startup: false, 'analytics.enabled': false, 'feedback.enabled': false,
    'features.apps': false, 'features.plugins': false, 'features.in_app_browser': false, 'features.remote_plugin': false,
    'model_providers.offline.name': 'Offline CodeBuddy tool argument fixture', 'model_providers.offline.base_url': `${origin}/v1`,
    'model_providers.offline.requires_openai_auth': false, 'model_providers.offline.supports_websockets': false,
    'model_providers.offline.wire_api': 'responses', 'model_providers.offline.env_key': 'BIFROST_TOOL_ARGUMENTS_KEY',
    'model_providers.offline.http_headers.X-Account-Bridge-Key': gatewayKey };
  await writeFile(join(home, 'config.toml'), Object.entries(config).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  const rpc = new CodexRpc({ binary, home, cwd: home,
    spawnImpl: (file, args, settings) => spawn(file, args, { ...settings, env, windowsHide: true }) });
  let complete, fail;
  const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const finished = bounded(completed, 20000, 'Native tool argument fixture turn timed out.');
  void finished.catch(() => {});
  rpc.on('notification', (method, params) => {
    if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'commandExecution') result.commandExecutionNotifications++;
    if (method === 'error') {
      result.nativeErrors.push({ willRetry: params.willRetry === true });
      if (params.willRetry === true) result.reconnects++;
      fail(new Error(params.error?.message ?? 'Native Codex reported a turn error.'));
    }
    if (method === 'turn/completed') complete(params.turn);
  });
  try {
    const thread = await rpc.request('thread/start', { model, cwd: home, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    await rpc.request('turn/start', { threadId: thread.thread.id, model, effort: 'medium',
      input: [{ type: 'text', text: 'Complete the supplied canned offline response. Do not run commands or use the network.' }] });
    result.turn = await finished;
    assert.equal(result.turn.status, 'completed', result.turn.error?.message ?? 'Native turn did not complete.');
    assert.ok(result.turn.items.some(item => item.type === 'agentMessage' && item.text === marker));
    assert.equal(result.modelCalls, 2, 'Exactly two provider calls must complete the recovery.');
    assert.equal(result.nativeRequests.length, 2, 'Native Codex must send one result continuation without reconnecting.');
    assert.equal(result.reconnects, 0);
    assert.equal(result.nativeErrors.length, 0);
    assert.equal(result.commandExecutionNotifications, 0, 'Bad arguments must be rejected before command execution.');
    const continuation = result.nativeRequests[1];
    assert.equal(continuation.functionCalls.length, 1);
    assert.equal(continuation.functionCalls[0].arguments, invalidArguments);
    assert.equal(continuation.functionOutputs.length, 1);
    assert.equal(continuation.functionOutputs[0].call_id, result.callId);
    assert.equal(continuation.functionOutputs[0].output, result.upstreamHistory.toolResult);
    assert.equal(result.errors.length, 0);
    result.passed = true;
  } catch (error) {
    result.errors.push({ phase: 'native', message: error.message });
    result.passed = false;
  } finally {
    fail(new Error('Fixture is closing.'));
    await rpc.close();
  }
  return result;
}

try {
  binary = args[1] ?? await resolveCodexBinary();
  nativeVersion = (await promisify(execFile)(binary, ['--version'], {
    cwd: work, env: { ...inherited, CODEX_HOME: work, HOME: work, USERPROFILE: work },
    timeout: 10000, maxBuffer: 8192, windowsHide: true,
  })).stdout.trim();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const nameVariant of nameVariants) await runCase(nameVariant, origin);
  assert.equal(cases.length, 2);
  assert.ok(cases.every(result => result.passed), 'At least one tool argument recovery case failed.');
  assert.equal(blockedNetworkRequests.length, 0);
} catch (error) {
  failures.push(error.message);
} finally {
  await provider.close?.();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  const passed = failures.length === 0 && cases.length === 2 && cases.every(result => result.passed);
  const evidencePath = join(work, 'proof.json');
  await writeFile(evidencePath, JSON.stringify({ passed, nativeVersion, realInference: false, existingAuthLoaded: false,
    userConfigurationModified: false, model, sourceModel: source.id, invalidArguments, expectedProviderCallsPerCase: 2,
    nameVariants, cases, blockedNetworkRequests, failures }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed, nativeVersion, realInference: false, evidencePath,
    cases: cases.map(({ nameVariant, passed, modelCalls, nativeRequests, reconnects, nativeErrors, tool, returnedToolName,
      commandExecutionNotifications, upstreamHistory, turn, errors }) => ({ nameVariant, passed, modelCalls,
      nativeRequests: nativeRequests.length, reconnects, nativeErrors, tool, returnedToolName, commandExecutionNotifications,
      upstreamHistory, turnStatus: turn?.status ?? null, errors })), failures }, null, 2));
  if (!passed) process.exitCode = 1;
}
