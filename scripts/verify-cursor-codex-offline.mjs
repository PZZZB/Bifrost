import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { Gateway } from '../src/gateway.mjs';
import { CursorResponsesProvider, CURSOR_RESPONSES_STATE_PREFIX } from '../src/cursor-responses.mjs';
import { CURSOR_MODELS, resolveCursorModel } from '../src/cursor-service.mjs';
import { appendCursorModels } from '../src/models.mjs';
import { redact } from '../src/storage.mjs';

// Only the native Codex executable is real. The SDK, account, models, run and
// Responses gateway are local fixtures. No existing account data is loaded.
// Native background connection attempts are rejected by the loopback proxy;
// the report records them separately without inferring their purpose.
const argument = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
};
const binary = argument('--binary', process.env.CODEX_BINARY || 'codex');
const requestedModel = argument('--model', CURSOR_MODELS[0].id);
const selectedModel = resolveCursorModel(requestedModel);
if (!selectedModel) throw new Error('--model must name one of the two Cursor aliases.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, '.state', `cursor-codex-offline-${Date.now()}-${randomBytes(3).toString('hex')}`);
const codexHome = join(work, 'home');
await mkdir(codexHome, { recursive: true, mode: 0o700 });
const expected = `bifrost-cursor-offline-tool-${randomBytes(16).toString('hex')}`;
const proofPath = join(work, 'bridge-proof.txt');
await writeFile(proofPath, expected + '\n', { mode: 0o600 });
const sdkModels = CURSOR_MODELS.map(model => ({ id: model.upstream, displayName: model.name }));
const catalog = appendCursorModels({ models: [] }, sdkModels);
assert.ok(catalog.models.every(model => model.supports_parallel_tool_calls === false));
assert.ok(catalog.models.every(model => model.supported_reasoning_levels.length === 0));
const catalogPath = join(work, 'catalog.json');
await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });

const gatewayKey = 'offline-cursor-gateway-key';
const sdkKey = 'offline-cursor-sdk-key';
const sdkRunId = 'cursor-offline-run-one';
const sdkUsage = { inputTokens: 50, outputTokens: 15, cacheReadTokens: 12, cacheWriteTokens: 3, totalTokens: 80, reasoningTokens: 5 };
const requests = [], clientEvents = [], responseItems = [], terminalResponses = [], responseReads = [], usageEvents = [], errors = [];
const sdkCreated = [], sdkSends = [], sdkCallbacks = [], sdkCancellations = [], sdkClosed = [], httpTasks = [];
const blockedNetworkRequests = [];
let child, timer, nativeVersion = null, exitCode = null, selectedTool = null, callbackReturned = false;
let adapterCalls = 0, originalInferenceCalls = 0, externalEndpointAttempts = 0;
const hash = value => createHash('sha256').update(value).digest('hex');

function summarize(body) {
  return { fields: Object.keys(body).sort(), model: body.model, parallelToolCalls: body.parallel_tool_calls,
    reasoningFields: Object.keys(body.reasoning ?? {}).sort(), reasoningEffort: body.reasoning?.effort ?? null,
    include: body.include ?? [], tools: (body.tools ?? []).map(tool => ({ type: tool.type, name: tool.name ?? null,
      namespaceTools: tool.tools?.map(child => ({ type: child.type, name: child.name })) })),
    input: (Array.isArray(body.input) ? body.input : []).map(item => ({ type: item.type ?? 'message', role: item.role ?? null,
      id: item.id ?? null, phase: item.phase ?? null, callId: item.call_id ?? null,
      encryptedPrefixMatches: item.encrypted_content?.startsWith(CURSOR_RESPONSES_STATE_PREFIX) === true,
      encryptedHash: typeof item.encrypted_content === 'string' ? hash(item.encrypted_content) : null })) };
}
function readPayload(bytes, headers) {
  const decoders = { zstd: zlib.zstdDecompressSync, gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync };
  for (const encoding of (headers['content-encoding'] ?? 'identity').split(',').map(value => value.trim()).reverse()) {
    if (encoding !== 'identity') {
      if (!decoders[encoding]) throw new Error('Unexpected fixture request encoding.');
      bytes = decoders[encoding](bytes);
    }
  }
  return JSON.parse(bytes.toString('utf8'));
}
function toolArguments(schema) {
  const properties = schema.properties ?? {};
  const command = `Get-Content -LiteralPath '${proofPath.replaceAll("'", "''")}' -Raw`;
  const args = {};
  if (Object.hasOwn(properties, 'cmd')) args.cmd = command;
  else if (Object.hasOwn(properties, 'command')) args.command = properties.command.type === 'array'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] : command;
  else throw new Error('Native Codex did not declare a supported local shell tool.');
  for (const [key, value] of Object.entries({ workdir: work, login: false, yield_time_ms: 10000, timeout_ms: 10000, max_output_tokens: 1000 })) {
    if (Object.hasOwn(properties, key)) args[key] = value;
  }
  return args;
}
class Messages {
  items = []; waiting = null; ended = false;
  push(value) { if (!this.ended) this.items.push(value); this.waiting?.(); this.waiting = null; }
  end() { this.ended = true; this.waiting?.(); this.waiting = null; }
  async *stream() {
    while (!this.ended || this.items.length) {
      if (!this.items.length) { await new Promise(resolveNext => { this.waiting = resolveNext; }); continue; }
      yield this.items.shift();
    }
  }
}
const cursorService = {
  enabled: true,
  credential: async () => ({ apiKey: sdkKey, apiKeyExpiresAtMs: Date.now() + 3600000, teamId: 42 }),
  getModels: async () => structuredClone(sdkModels),
  status: async () => ({ enabled: true, authReady: true, error: null, catalog: { models: structuredClone(sdkModels) },
    profile: { email: 'offline-cursor@example.test' } }),
};
const fakeSdk = {
  JsonlLocalAgentStore: class { constructor(path) { this.path = path; } },
  Agent: { async create(options) {
    assert.equal(options.apiKey, sdkKey); assert.equal(options.teamId, 42);
    assert.deepEqual(options.model, { id: selectedModel.upstream });
    assert.deepEqual(options.tools, ['mcp']); assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.local.settingSources, []); assert.equal(options.local.enableAgentRetries, false);
    assert.ok(options.local.cwd.startsWith(work)); assert.ok(options.local.store.path.startsWith(work));
    assert.equal(sdkCreated.length, 0, 'A tool round must create exactly one SDK agent.');
    sdkCreated.push({ model: options.model, tools: options.tools, settingsSources: options.local.settingSources, storeIsolated: true });
    const agent = { agentId: 'cursor-offline-agent-one', close() { sdkClosed.push(agent.agentId); }, async send(message, sendOptions) {
      assert.equal(sdkSends.length, 0, 'The original SDK Run must resume; a second send is not allowed.');
      assert.deepEqual(sendOptions.model, { id: selectedModel.upstream });
      assert.deepEqual(sendOptions.mcpServers, {});
      sdkSends.push({ runId: sdkRunId, model: sendOptions.model, messageType: typeof message.text });
      const events = new Messages(); let finish;
      const done = new Promise(resolveDone => { finish = resolveDone; });
      const run = { id: sdkRunId, stream: () => events.stream(), wait: () => done,
        async cancel() { sdkCancellations.push(run.id); events.end(); finish({ status: 'cancelled' }); } };
      void Promise.resolve().then(async () => {
        try {
          const entry = Object.entries(sendOptions.local.customTools).find(([name, tool]) => name !== 'bifrost_client_dispatch'
            && /Tool (?:exec_command|shell_command|shell):/.test(tool.description));
          assert.ok(entry, 'Native Codex must expose a local client shell tool.');
          const [alias, tool] = entry;
          selectedTool = { alias, description: tool.description.split('\n').find(line => line.startsWith('Tool '))?.slice(0, 160),
            parameterNames: Object.keys(tool.inputSchema?.properties ?? {}) };
          events.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Read the local fixture.' }] } });
          // The SDK may invoke callbacks together even when the catalogue asks
          // Codex for serial tools. Each original promise must settle only when
          // its own real client result arrives on a later HTTP request.
          const pending = ['offline-sdk-tool-one', 'offline-sdk-tool-two'].map((sdkToolCallId, index) => {
            const callback = { runId: run.id, alias, sdkToolCallId, requestedAfterHttp: requests.length, returned: false };
            sdkCallbacks.push(callback);
            return tool.execute(toolArguments(tool.inputSchema), { toolCallId: sdkToolCallId }).then(result => {
              assert.ok(requests.length >= index + 2, 'Each callback requires a subsequent HTTP tool result.');
              assert.ok(Array.isArray(result.content));
              const raw = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
              const match = /bifrost-cursor-offline-tool-[0-9a-f]{32}/.exec(raw);
              assert.equal(match?.[0], expected, 'The SDK must receive the exact real client file-read result.');
              callback.returned = true; callback.returnedAfterHttp = requests.length;
              return match[0];
            });
          });
          const matches = await Promise.all(pending);
          callbackReturned = true;
          events.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: matches[1] }] } });
          events.push({ type: 'usage', usage: sdkUsage }); events.end();
          finish({ status: 'finished', model: { id: selectedModel.upstream }, usage: sdkUsage });
        } catch (error) { events.end(); finish({ status: 'error', error: { message: error.message } }); }
      });
      return run;
    } };
    return agent;
  } },
};
const responses = new CursorResponsesProvider({ cursorService, stateDir: work, sdkLoader: async () => fakeSdk, requestTimeoutMs: 45000 });
const requestResponses = responses.request.bind(responses);
responses.request = async options => {
  const requestIndex = adapterCalls++, response = await requestResponses(options);
  responseReads.push(response.clone().text().then(body => {
    if (!response.ok) { errors.push({ phase: 'adapter', status: response.status, message: redact(body) }); return; }
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data), item = event.type === 'response.output_item.done' ? event.item : null;
      if (item) responseItems.push({ requestIndex, type: item.type, id: item.id, phase: item.phase ?? null, callId: item.call_id ?? null,
        encryptedHash: typeof item.encrypted_content === 'string' ? hash(item.encrypted_content) : null });
      if (['response.completed', 'response.failed'].includes(event.type)) terminalResponses.push({ requestIndex, status: event.response?.status,
        reasoning: event.response?.reasoning, usage: event.response?.usage ?? null });
    }
  }).catch(error => errors.push({ phase: 'response-capture', message: redact(error.message) })));
  return response;
};
const gateway = new Gateway({ gatewayKey, backend: { credentials: async () => { throw new Error('Offline B backend unavailable.'); } },
  getAProvider: async () => ({ config: { base_url: 'http://127.0.0.1:1/v1' } }), cursorProvider: responses,
  cursorEnabled: () => true, getCursorModels: cursorService.getModels, onUsage: async event => usageEvents.push(event),
  fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith('/models') && (!options?.method || options.method === 'GET')) return Response.json({ models: [] });
    originalInferenceCalls++; throw new Error('The Cursor fixture must never route inference to A, B or CodeBuddy.');
  } });
let fixtureOrigin;
function recordBlockedNetwork(req, transport) {
  externalEndpointAttempts++;
  try {
    const target = new URL(transport === 'CONNECT' ? `https://${req.url}` : req.url);
    blockedNetworkRequests.push({ transport, method: req.method, host: target.hostname, port: target.port || (target.protocol === 'https:' ? '443' : '80'),
      ...(transport === 'HTTP' ? { path: target.pathname } : {}), blocked: true, responseStatus: 502, tunnelEstablished: false, source: 'unverified' });
  } catch { blockedNetworkRequests.push({ transport, method: req.method, host: null,
    blocked: true, responseStatus: 502, tunnelEstablished: false, source: 'unverified' }); }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, fixtureOrigin);
  if (url.origin !== fixtureOrigin) {
    recordBlockedNetwork(req, 'HTTP'); res.writeHead(502); res.end('Offline fixture blocks external network endpoints.'); return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (req.method === 'POST') {
      try { requests.push(summarize(readPayload(Buffer.concat(chunks), req.headers))); }
      catch (error) { errors.push({ phase: 'capture', message: redact(error.message) }); }
    }
  });
  const task = gateway.proxy(req, res, url).catch(error => {
    errors.push({ phase: 'gateway', status: error.status ?? 500, message: redact(error.message) });
    if (!res.headersSent) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: { message: redact(error.message) } }));
  });
  httpTasks.push(task);
});
server.on('connect', (req, socket) => { recordBlockedNetwork(req, 'CONNECT'); socket.end('HTTP/1.1 502 Offline fixture blocks external endpoints\r\n\r\n'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
const env = { CODEX_HOME: codexHome, BIFROST_CURSOR_OFFLINE_KEY: 'offline-fixture-client-key',
  // Unexpected proxy-aware background traffic is trapped by this local server.
  HTTP_PROXY: fixtureOrigin, HTTPS_PROXY: fixtureOrigin, ALL_PROXY: fixtureOrigin,
  NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
  if (process.env[key]) env[key] = process.env[key];
}
const config = { model_provider: 'bifrost_cursor_offline', model_catalog_json: catalogPath, cli_auth_credentials_store: 'file',
  model_reasoning_effort: 'max', model_reasoning_summary: 'detailed', approval_policy: 'never',
  'analytics.enabled': false, 'model_providers.bifrost_cursor_offline.name': 'Bifrost Cursor offline fixture',
  'model_providers.bifrost_cursor_offline.base_url': fixtureOrigin + '/v1', 'model_providers.bifrost_cursor_offline.wire_api': 'responses',
  'model_providers.bifrost_cursor_offline.requires_openai_auth': false, 'model_providers.bifrost_cursor_offline.supports_websockets': false,
  'model_providers.bifrost_cursor_offline.env_key': 'BIFROST_CURSOR_OFFLINE_KEY',
  'model_providers.bifrost_cursor_offline.http_headers': { 'X-Account-Bridge-Key': gatewayKey } };
const serialize = value => typeof value === 'object' && value !== null
  ? '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(',') + '}' : JSON.stringify(value);
try {
  nativeVersion = (await promisify(execFile)(binary, ['--version'], { env, cwd: work, windowsHide: true, timeout: 10000 })).stdout.trim();
  const args = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', work,
    '--model', selectedModel.id, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${serialize(value)}`]),
    'Read bridge-proof.txt using the provided local shell tool. Reply with exactly the file contents. Do not access the network or any other file.'];
  child = spawn(binary, args, { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => { try { clientEvents.push(JSON.parse(line)); }
    catch { errors.push({ phase: 'client-json', message: 'Native Codex emitted a non-JSON output line.' }); } });
  child.stderr.on('data', () => {});
  timer = setTimeout(() => { errors.push({ phase: 'timeout', message: 'Offline Cursor/Codex tool round timed out.' }); child.kill(); }, 60000);
  exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  lines.close(); await Promise.allSettled(httpTasks); await Promise.all(responseReads);
  const commands = clientEvents.filter(event => event.type === 'item.completed' && ['command_execution', 'commandExecution'].includes(event.item?.type));
  const replies = clientEvents.filter(event => event.type === 'item.completed' && ['agent_message', 'agentMessage'].includes(event.item?.type));
  assert.equal(exitCode, 0); assert.ok(clientEvents.some(event => event.type === 'turn.completed'));
  assert.ok(commands.some(event => event.item.exit_code === 0 || event.item.exitCode === 0));
  assert.equal(replies.at(-1)?.item.text?.trim(), expected); assert.equal(callbackReturned, true);
  assert.equal(requests.length, 3); assert.equal(adapterCalls, 3); assert.equal(sdkCreated.length, 1);
  assert.equal(sdkSends.length, 1); assert.equal(sdkCallbacks.length, 2); assert.equal(sdkCancellations.length, 0);
  assert.equal(originalInferenceCalls, 0);
  assert.equal(externalEndpointAttempts, blockedNetworkRequests.length);
  assert.ok(blockedNetworkRequests.every(attempt => attempt.blocked && attempt.responseStatus === 502 && !attempt.tunnelEstablished),
    'Every trapped external connection must be rejected without establishing a tunnel.');
  assert.ok(requests.every(request => typeof request.parallelToolCalls === 'boolean'));
  assert.deepEqual(sdkCallbacks.map(callback => callback.requestedAfterHttp), [1, 1]);
  assert.deepEqual(sdkCallbacks.map(callback => callback.returnedAfterHttp), [2, 3]);
  assert.equal(commands.length, 2);
  for (let index = 0; index < 2; index++) {
    const calls = responseItems.filter(item => item.requestIndex === index && item.type === 'function_call');
    assert.equal(calls.length, 1, 'Concurrent SDK callbacks must be exposed one per HTTP response.');
    const result = requests[index + 1].input.filter(item => item.type === 'function_call_output').at(-1);
    assert.equal(result?.callId, calls[0].callId, 'Each real client output must return to its original pending call.');
  }
  assert.equal(responseItems.filter(item => item.requestIndex === 2 && item.type === 'function_call').length, 0);
  assert.ok(requests.every(request => !request.reasoningFields.includes('summary')));
  assert.ok(terminalResponses.every(response => response.status === 'completed' && !response.reasoning?.effort));
  for (let index = 0; index < 2; index++) {
    const states = responseItems.filter(item => item.requestIndex === index && item.encryptedHash);
    assert.ok(states.length > 0);
    for (const item of states) assert.ok(requests[index + 1].input.some(input => input.id === item.id && input.encryptedHash === item.encryptedHash && input.encryptedPrefixMatches));
  }
  assert.equal(gateway.metrics.accounts.Cursor.completed, 3); assert.equal(gateway.metrics.accounts.Cursor.failed, 0);
  assert.equal(usageEvents.length, 3); assert.ok(usageEvents.every(event => event.usage === null));
  const runUsage = (await responses.status()).runUsageDiagnostics;
  assert.equal(runUsage.length, 1); assert.equal(runUsage[0].httpAttribution, 'unknown'); assert.equal(runUsage[0].usage.total_tokens, 80);
  const proof = { passed: true, nativeVersion, realInference: false, existingAuthLoaded: false, model: selectedModel.id,
    fixtureDirectory: work, globalReasoningEffort: 'max', sdkReasoning: 'cursor-default',
    catalogParallelToolCalls: false, clientParallelToolCalls: requests.map(request => request.parallelToolCalls), externalToolExecution: 'serial',
    exactLocalToolOutput: true, finalReplyMatched: true, sameSdkRunResumed: true, sdkAgentCreates: sdkCreated.length,
    sdkSends: sdkSends.length, sdkToolCallbacks: sdkCallbacks, opaqueStateReplayedUnchanged: true,
    httpUsageUnknown: true, runUsageDiagnostics: runUsage, localToolCalls: commands.length,
    gateway: { accounts: gateway.metrics.accounts, originalInferenceCalls }, externalEndpointAttempts, blockedNetworkRequests,
    proxyTunnelEstablished: false, backgroundConnectionSource: 'unverified',
    selectedTool, requests, responseItems, terminalResponses, sdkCreated, sdkSends, usageRecords: usageEvents.length, errors };
  await writeFile(join(work, 'result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, nativeVersion, model: selectedModel.id, realInference: false, existingAuthLoaded: false,
    localToolCalls: commands.length, sameSdkRunResumed: true, sdkSends: 1, httpUsageUnknown: true,
    inheritedMaxUsesCursorDefault: true, evidencePath: join(work, 'result.json') }, null, 2));
} catch (error) {
  const proof = { passed: false, nativeVersion, realInference: false, existingAuthLoaded: false, model: selectedModel.id,
    exitCode, failure: redact(error.message), callbackReturned, selectedTool, requests, responseItems, terminalResponses,
    sdkCreated, sdkSends, sdkCallbacks, originalInferenceCalls, externalEndpointAttempts, blockedNetworkRequests,
    clientEvents: clientEvents.map(event => ({ type: event.type, message: event.type === 'error' ? redact(event.message) : undefined,
      itemType: event.item?.type, commandExitCode: event.item?.exit_code })), errors };
  await writeFile(join(work, 'result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify({ passed: false, failure: proof.failure, evidencePath: join(work, 'result.json') }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer); if (child && child.exitCode === null && !child.killed) child.kill();
  await responses.close(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
}
