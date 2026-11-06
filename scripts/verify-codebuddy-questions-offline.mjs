import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';
import { appendCodeBuddyModel } from '../src/models.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { Gateway } from '../src/gateway.mjs';

// Run the installed native Codex against a loopback gateway and canned CodeBuddy
// responses. Both credentials and question answers are fixtures. No existing
// account, user configuration, production service or real inference is used.
// Each native mode runs with the declared wire alias and with the original
// question name. The latter checks normalization against the current declarations
// instead of assuming that every model obeys a hashed alias perfectly.
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--binary' || !args[1] || args[1].startsWith('--'))) {
  throw new Error('Expected [--binary /path/to/native/codex].');
}
const work = fileURLToPath(new URL(`../.state/codebuddy-questions-offline-${Date.now()}-${randomBytes(3).toString('hex')}/`, import.meta.url));
await mkdir(work, { recursive: true, mode: 0o700 });
const model = CODEBUDDY_MODEL.id, actualModel = 'claude-opus-5.5';
const gatewayKey = 'offline-question-gateway-key', marker = 'OFFLINE_QUESTION_DONE';
const catalogPath = join(work, 'catalog.json');
await writeFile(catalogPath, JSON.stringify(appendCodeBuddyModel({ models: [] })), { mode: 0o600 });
const questionArgs = { questions: [
  { id: 'fixture_choice', header: 'Choice', question: 'Choose the first offline fixture option.', options: [
    { label: 'Fixture A (Recommended)', description: 'Choose the first fixture option.' },
    { label: 'Fixture B', description: 'Choose the second fixture option.' },
  ] },
  { id: 'fixture_theme', header: 'Theme', question: '选择离线测试主题。', options: [
    { label: 'Light (Recommended)', description: 'Use the light fixture theme.' },
    { label: 'Dark', description: 'Use the dark fixture theme.' },
  ] },
] };
const answerPayload = { answers: {
  fixture_choice: { answers: ['Fixture A (Recommended)'] }, fixture_theme: { answers: ['Dark'] },
} };
const unavailable = 'request_user_input is unavailable in Default mode';
const nameVariants = ['wire-alias', 'original-name'];
const cases = [], failures = [], blockedNetworkRequests = [], sockets = new Set();
let active, binary, nativeVersion;
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => [
  'path', 'systemroot', 'windir', 'comspec', 'pathext', 'processor_architecture', 'number_of_processors',
].includes(name.toLowerCase())));

function stream(chunks) {
  return new Response(chunks.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const serialize = value => value && typeof value === 'object'
  ? '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(',') + '}' : JSON.stringify(value);
function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
function decode(bytes, headers) {
  for (const encoding of (headers['content-encoding'] || 'identity').split(',').reverse().map(value => value.trim())) {
    if (encoding === 'identity') continue;
    const decompress = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync }[encoding];
    assert.ok(decompress, 'Unexpected fixture request compression.');
    bytes = decompress(bytes);
  }
  return JSON.parse(bytes.toString('utf8'));
}
function questionTools(tools, namespace = null) {
  return (tools ?? []).flatMap(tool => tool.type === 'namespace' ? questionTools(tool.tools, tool.name)
    : tool.type === 'function' && tool.name === 'request_user_input' ? [{ ...tool, namespace }] : []);
}

const provider = new CodeBuddyProvider({ loadThinkingState: () => new CodeBuddyThinkingState(), client: {
  status: async () => ({ authenticated: true, identity: { uid: 'offline-question-owner' } }),
  modelCatalog: async () => [{ id: actualModel, name: 'Claude Opus 5.5', supportsToolCall: true }],
  chatCompletions: async ({ body }) => {
    assert.ok(active, 'An inference request must belong to a fixture case.');
    active.modelCalls++;
    assert.equal(body.model, actualModel);
    if (active.modelCalls === 1) {
      const tool = body.tools?.find(tool => /(?:^|\n)Tool request_user_input:/.test(tool.function.description));
      assert.ok(tool, 'The full adapter must declare the native question tool upstream.');
      const nativeTool = active.nativeRequests[0]?.questionTools[0];
      assert.ok(nativeTool, 'Native Codex must declare the question tool.');
      assert.equal(nativeTool.name, 'request_user_input');
      assert.notEqual(tool.function.name, nativeTool.name, 'The fixture must exercise distinct wire and original tool names.');
      assert.deepEqual(tool.function.parameters, nativeTool.parameters, 'The adapter must preserve the native question schema.');
      active.upstreamQuestionTool = tool;
      active.returnedToolName = active.nameVariant === 'original-name' ? nativeTool.name : tool.function.name;
      return stream([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: active.callId, type: 'function',
        function: { name: active.returnedToolName, arguments: JSON.stringify(questionArgs) } }] }), chunk({}, 'tool_calls'), '[DONE]']);
    }
    assert.equal(active.modelCalls, 2, 'A case permits exactly two canned model responses.');
    active.upstreamToolOutputs = body.messages.filter(message => message.role === 'tool').map(message => ({
      callId: message.tool_call_id, content: message.content,
    }));
    assert.equal(active.upstreamToolOutputs.length, 1, 'The question must have exactly one result.');
    assert.equal(active.upstreamToolOutputs[0].callId, active.callId);
    const result = active.upstreamToolOutputs[0].content;
    if (active.mode === 'default' && !active.enableDefault) assert.equal(result, unavailable);
    else assert.deepEqual(JSON.parse(result), answerPayload, 'The user answers must reach the next upstream request unchanged.');
    return stream([chunk({ role: 'assistant', content: marker }), chunk({}, 'stop'), '[DONE]']);
  },
} });
const gateway = new Gateway({ gatewayKey, codeBuddyProvider: new CodeBuddyResponsesProvider({ provider }), codeBuddyEnabled: () => true,
  backend: { credentials: async () => { throw new Error('No account credentials allowed.'); } },
  getAProvider: async () => { throw new Error('No original provider allowed.'); },
  fetchImpl: async () => { throw new Error('No real upstream allowed.'); },
});
const server = http.createServer(async (req, res) => {
  if (/^https?:/i.test(req.url) || req.method !== 'POST' || req.url !== '/v1/responses') {
    blockedNetworkRequests.push({ kind: /^https?:/i.test(req.url) ? 'http-proxy' : 'unexpected-route', method: req.method });
    res.writeHead(502); res.end('{}'); return;
  }
  const result = active, parts = [];
  req.on('data', part => parts.push(part));
  req.on('end', () => {
    try {
      const body = decode(Buffer.concat(parts), req.headers);
      result.nativeRequests.push({ questionTools: questionTools(body.tools),
        functionOutputs: (body.input ?? []).filter(item => item.type === 'function_call_output') });
    } catch (error) { result.errors.push({ phase: 'capture', message: error.message }); }
  });
  try { await gateway.proxy(req, res, new URL(req.url, 'http://offline-question.invalid')); }
  catch (error) {
    result.errors.push({ phase: 'gateway', message: error.message });
    if (!res.headersSent) res.writeHead(error.status ?? 500);
    res.end('{}');
  }
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
server.on('connect', (_req, socket) => {
  blockedNetworkRequests.push({ kind: 'https-proxy' });
  socket.end('HTTP/1.1 502 Offline\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
server.on('upgrade', (_req, socket) => { blockedNetworkRequests.push({ kind: 'upgrade' }); socket.destroy(); });
server.on('clientError', (_error, socket) => socket.destroy());

async function runCase(name, mode, enableDefault, nameVariant, origin) {
  assert.ok(nameVariants.includes(nameVariant));
  const result = { name, mode, enableDefault, nameVariant, callId: `call_question_${name}`, modelCalls: 0,
    reconnects: 0, nativeErrorNotifications: 0, nativeRequests: [], hostRequests: [], errors: [] };
  active = result; cases.push(result);
  const home = join(work, name); await mkdir(home, { recursive: true, mode: 0o700 });
  const env = { ...inherited, CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TEMP: home, TMP: home, BIFROST_QUESTION_KEY: 'offline-question-client',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, http_proxy: origin, https_proxy: origin, all_proxy: origin,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
  const config = { model, model_provider: 'offline', model_catalog_json: catalogPath, cli_auth_credentials_store: 'file', approval_policy: 'never',
    model_reasoning_effort: 'high', model_reasoning_summary: 'none', check_for_update_on_startup: false,
    'analytics.enabled': false, 'feedback.enabled': false, 'features.apps': false, 'features.plugins': false,
    'features.in_app_browser': false, 'features.remote_plugin': false, 'features.default_mode_request_user_input': enableDefault,
    'model_providers.offline.name': 'Bifrost offline question fixture', 'model_providers.offline.base_url': `${origin}/v1`,
    'model_providers.offline.requires_openai_auth': false, 'model_providers.offline.supports_websockets': false,
    'model_providers.offline.wire_api': 'responses', 'model_providers.offline.env_key': 'BIFROST_QUESTION_KEY',
    'model_providers.offline.http_headers': { 'X-Account-Bridge-Key': gatewayKey },
  };
  const cliArgs = ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${serialize(value)}`])];
  const child = spawn(binary, cliArgs, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let nextId = 1, turnWaiter, stopping = false, rpcFailure;
  const closed = new Promise(resolve => child.once('close', resolve));
  const abort = error => {
    rpcFailure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); turnWaiter?.reject(error);
  };
  child.once('error', error => abort(new Error(`Cannot start native Codex: ${error.code || error.message}`)));
  child.once('exit', (code, signal) => { if (!stopping) abort(new Error(`Native Codex exited before cleanup (${code ?? signal}).`)); });
  child.stdin.on('error', error => { if (!stopping) abort(new Error(`Native Codex input closed: ${error.code || error.message}`)); });
  // Native stderr may contain authorization URLs; neither print nor persist it.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const send = message => {
    if (rpcFailure) throw rpcFailure;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (rpcFailure) { reject(rpcFailure); return; }
    const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  lines.on('line', line => {
    try {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const waiting = pending.get(message.id); if (!waiting) return;
        pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        if (message.method !== 'item/tool/requestUserInput') {
          result.hostRequests.push({ method: message.method });
          send({ id: message.id, error: { code: -32601, message: 'Offline fixture does not support this host request.' } });
          return;
        }
        result.hostRequests.push({ method: message.method, questions: message.params.questions, isBlocking: message.params.isBlocking });
        const questions = message.params.questions.map(({ id, header, question, options }) => ({ id, header, question, options }));
        assert.deepEqual(questions, questionArgs.questions, 'The native host must receive the original question structure.');
        assert.equal(message.params.isBlocking, mode === 'plan');
        send({ id: message.id, result: answerPayload });
      } else if (message.method === 'turn/completed') turnWaiter?.resolve(message.params.turn);
      else if (message.method === 'error') {
        result.nativeErrorNotifications++;
        if (message.params?.willRetry === true) result.reconnects++;
        abort(new Error(message.params?.error?.message || 'Native Codex reported a turn error.'));
      }
    } catch (error) { abort(error); }
  });
  try {
    const initialized = await request('initialize', { clientInfo: { name: 'bifrost_offline_question', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    result.userAgent = initialized.userAgent; send({ method: 'initialized' });
    const thread = await request('thread/start', { model, cwd: home, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    const completed = new Promise((resolve, reject) => { turnWaiter = { resolve, reject }; });
    const done = bounded(completed, 15000, 'Question fixture turn timed out.');
    void done.catch(() => {});
    await request('turn/start', { threadId: thread.thread.id,
      collaborationMode: { mode, settings: { model, reasoning_effort: 'high', developer_instructions: null } },
      input: [{ type: 'text', text: 'This is a canned offline fixture. Ask the supplied question tool, then finish with the canned marker. Do not run commands or use the network.' }] });
    result.turn = await done;
    assert.equal(result.turn.status, 'completed', result.turn.error?.message || 'Native question turn did not complete.');
    assert.ok(result.turn.items.some(item => item.type === 'agentMessage' && item.text === marker), 'Native Codex must receive the canned final reply.');
    assert.equal(result.modelCalls, 2, 'Native Codex must continue with the question result.');
    assert.equal(result.nativeRequests.length, 2);
    assert.equal(result.reconnects, 0, 'The native question round must not reconnect.');
    assert.equal(result.nativeErrorNotifications, 0, 'The native question round must not report a stream error.');
    for (const native of result.nativeRequests) assert.equal(native.questionTools.length, 1);
    const outputs = result.nativeRequests[1].functionOutputs;
    assert.equal(outputs.length, 1); assert.equal(outputs[0].call_id, result.callId);
    if (mode === 'default' && !enableDefault) {
      assert.equal(result.hostRequests.length, 0, 'Disabled Default mode must not ask the host.');
      assert.equal(outputs[0].output, unavailable);
    } else {
      assert.equal(result.hostRequests.length, 1, 'An enabled question must ask the native host exactly once.');
      assert.equal(result.hostRequests[0].method, 'item/tool/requestUserInput');
      assert.deepEqual(JSON.parse(outputs[0].output), answerPayload, 'The native question result must preserve both answers.');
    }
    assert.equal(result.errors.length, 0, 'No capture or adapter error is permitted.');
    result.passed = true;
  } catch (error) { result.errors.push({ phase: 'native-question', message: error.message }); result.passed = false; }
  finally {
    stopping = true; abort(new Error('Fixture is closing.'));
    child.stdin.end();
    try {
      await bounded(closed, 1000, 'Native Codex did not exit gracefully.').catch(async () => {
        child.kill(); await bounded(closed, 5000, 'Native Codex did not exit after termination.');
      });
    } catch (error) {
      result.errors.push({ phase: 'cleanup', message: error.message }); result.passed = false;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }
    lines.close();
  }
  return result;
}

try {
  binary = args[1] ?? await resolveCodexBinary();
  nativeVersion = (await promisify(execFile)(binary, ['--version'], {
    cwd: work, env: { ...inherited, CODEX_HOME: work, HOME: work, USERPROFILE: work }, timeout: 10000, maxBuffer: 8192, windowsHide: true,
  })).stdout.trim();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const nameVariant of nameVariants) {
    const suffix = nameVariant === 'wire-alias' ? '' : '-original-name';
    await runCase(`default-off${suffix}`, 'default', false, nameVariant, origin);
    await runCase(`plan${suffix}`, 'plan', false, nameVariant, origin);
    await runCase(`default-on${suffix}`, 'default', true, nameVariant, origin);
  }
  assert.equal(cases.length, 6); assert.ok(cases.every(result => result.passed), 'At least one native question case failed.');
} catch (error) { failures.push(error.message); }
finally {
  await provider.close?.();
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  const passed = failures.length === 0 && cases.length === 6 && cases.every(result => result.passed);
  const evidencePath = join(work, 'proof.json');
  await writeFile(evidencePath, JSON.stringify({ passed, nativeVersion, realInference: false, existingAuthLoaded: false,
    userConfigurationModified: false, nameVariants, expectedCases: 6, questionArgs, answerPayload, cases, blockedNetworkRequests, failures }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed, nativeVersion, realInference: false, evidencePath,
    cases: cases.map(({ name, nameVariant, passed, returnedToolName, upstreamQuestionTool, modelCalls, nativeRequests,
      reconnects, nativeErrorNotifications, hostRequests, turn, errors }) => ({ name, nameVariant, passed,
      returnedToolName, declaredWireName: upstreamQuestionTool?.function.name ?? null, modelCalls, nativeRequests: nativeRequests.length,
      reconnects, nativeErrorNotifications, hostRequests: hostRequests.length, turnStatus: turn?.status ?? null, errors })), failures }, null, 2));
  if (!passed) process.exitCode = 1;
}
