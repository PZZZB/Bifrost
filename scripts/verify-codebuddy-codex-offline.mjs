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
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider, CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { appendCodeBuddyModel } from '../src/models.mjs';
import { redact } from '../src/storage.mjs';

// This is a local protocol fixture. It never loads the user's Codex or CodeBuddy
// credentials and never sends a model request outside the loopback gateway.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binaryIndex = process.argv.indexOf('--binary');
const binary = binaryIndex < 0 ? process.env.CODEX_BINARY || 'codex' : process.argv[binaryIndex + 1];
if (!binary || binary.startsWith('--')) throw new Error('--binary requires a Codex executable.');
const work = join(root, '.state', `codebuddy-codex-offline-${Date.now()}-${randomBytes(3).toString('hex')}`);
const codexHome = join(work, 'home');
await mkdir(codexHome, { recursive: true, mode: 0o700 });
const expected = `bifrost-offline-tool-${randomBytes(16).toString('hex')}`;
const proofPath = join(work, 'bridge-proof.txt');
await writeFile(proofPath, expected + '\n', { mode: 0o600 });
const catalogPath = join(work, 'catalog.json');
await writeFile(catalogPath, JSON.stringify(appendCodeBuddyModel({ models: [] })), { mode: 0o600 });
const gatewayKey = 'offline-fixture-gateway-key';
const summary = 'Read the local fixture with the provided client tool.';
const extraFields = { fixture: 'opaque-continuation', round: 1, nested: [true, 17] };
const upstreamModel = 'claude-opus-5.5';
const requests = [], upstreamRequests = [], clientEvents = [], errors = [], usageEvents = [], responseItems = [], responseReads = [];
let child, timer, selectedTool = null, nativeVersion = null, fakeCalls = 0;
let sawReasoning = false, sawExtraFields = false, sawLocalOutput = false;
const hash = value => createHash('sha256').update(value).digest('hex');

function summarize(body) {
  return { fields: Object.keys(body).sort(), model: body.model,
    reasoningFields: Object.keys(body.reasoning ?? {}).sort(), include: body.include ?? [],
    tools: (body.tools ?? []).map(tool => ({ type: tool.type, name: tool.name ?? null,
      strict: tool.strict ?? null, namespaceTools: Array.isArray(tool.tools) ? tool.tools.map(item => ({ type: item.type, name: item.name })) : undefined })),
    input: (Array.isArray(body.input) ? body.input : []).map(item => ({ type: item.type ?? 'message', role: item.role ?? null,
      id: item.id ?? null, phase: item.phase ?? null, callId: item.call_id ?? null,
      encryptedPresent: typeof item.encrypted_content === 'string',
      encryptedPrefixMatches: item.encrypted_content?.startsWith(CODEBUDDY_RESPONSES_STATE_PREFIX) === true,
      encryptedHash: typeof item.encrypted_content === 'string' ? hash(item.encrypted_content) : null,
      contentTypes: Array.isArray(item.content) ? item.content.map(part => part.type) : typeof item.content })) };
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

function mockStream(chunks) {
  const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
  const bytes = Buffer.from(chunks.map(frame).join(''));
  // Split UTF-8 and SSE boundaries to exercise both adapters' incremental parsers.
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 19) controller.enqueue(bytes.subarray(at, at + 19));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl_offline_fixture', object: 'chat.completion.chunk',
  model: upstreamModel, choices: [{ index: 0, delta, finish_reason }] });
const usage = { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65,
  prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 5 } };

function toolArguments(tool) {
  const properties = tool.function.parameters?.properties ?? {};
  const command = `Get-Content -LiteralPath '${proofPath.replaceAll("'", "''")}' -Raw`;
  const args = {};
  if (Object.hasOwn(properties, 'cmd')) args.cmd = command;
  else if (Object.hasOwn(properties, 'command')) args.command = properties.command.type === 'array'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command] : command;
  else throw new Error('Native Codex did not declare a supported local shell tool.');
  if (Object.hasOwn(properties, 'workdir')) args.workdir = work;
  if (Object.hasOwn(properties, 'login')) args.login = false;
  if (Object.hasOwn(properties, 'yield_time_ms')) args.yield_time_ms = 10000;
  if (Object.hasOwn(properties, 'timeout_ms')) args.timeout_ms = 10000;
  if (Object.hasOwn(properties, 'max_output_tokens')) args.max_output_tokens = 1000;
  return args;
}

const native = new CodeBuddyProvider({ loadThinkingState: () => new CodeBuddyThinkingState(), client: {
  status: async () => ({ authenticated: true, identity: { uid: 'offline-fixture-employee' } }),
  modelCatalog: async () => ({ models: [{ id: upstreamModel, name: 'Claude Opus 5.5', supportsImages: true,
    supportsReasoning: true, supportsToolCall: true }], source: 'remote', liveVerified: true }),
  async chatCompletions({ body }) {
    fakeCalls++;
    assert.equal(body.model, upstreamModel);
    upstreamRequests.push({ fields: Object.keys(body).sort(), roles: body.messages.map(message => message.role),
      tools: (body.tools ?? []).map(tool => ({ name: tool.function.name, parameters: Object.keys(tool.function.parameters?.properties ?? {}) })) });
    if (fakeCalls === 1) {
      const tool = body.tools?.find(tool => /Tool (?:exec_command|shell_command|shell):/.test(tool.function.description));
      assert.ok(tool, 'Native Codex must provide a local shell tool.');
      selectedTool = { alias: tool.function.name, description: tool.function.description.split('\n').find(line => line.startsWith('Tool '))?.slice(0, 160),
        parameterNames: Object.keys(tool.function.parameters?.properties ?? {}) };
      return mockStream([chunk({ role: 'assistant', reasoning_content: summary, extra_fields: extraFields }),
        chunk({ content: 'Read the local fixture.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_offline_fixture_read', type: 'function',
          function: { name: tool.function.name, arguments: JSON.stringify(toolArguments(tool)) } }] }),
        chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]']);
    }
    assert.equal(fakeCalls, 2, 'The offline fixture permits exactly two canned model responses.');
    const assistant = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call_offline_fixture_read'));
    assert.ok(assistant, 'The client must replay the original assistant tool call.');
    assert.equal(assistant.reasoning_content, summary); sawReasoning = true;
    assert.deepEqual(assistant.extra_fields, extraFields); sawExtraFields = true;
    const output = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_offline_fixture_read');
    assert.ok(output, 'The client must send the real local tool result.');
    const raw = typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
    const match = /bifrost-offline-tool-[0-9a-f]{32}/.exec(raw);
    assert.equal(match?.[0], expected); sawLocalOutput = true;
    return mockStream([chunk({ role: 'assistant', content: match[0] }), chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
  },
} });
const responses = new CodeBuddyResponsesProvider({ provider: native });
const requestResponses = responses.request.bind(responses);
responses.request = async options => {
  const response = await requestResponses(options);
  responseReads.push(response.clone().text().then(body => {
    if (!response.ok) { errors.push({ phase: 'adapter', status: response.status, message: redact(body) }); return; }
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data), item = event.type === 'response.output_item.done' ? event.item : null;
      if (item) responseItems.push({ type: item.type, id: item.id, phase: item.phase ?? null,
        encryptedHash: typeof item.encrypted_content === 'string' ? hash(item.encrypted_content) : null });
    }
  }).catch(error => { errors.push({ phase: 'response-capture', message: redact(error.message) }); }));
  return response;
};
let originalInferenceCalls = 0;
const gateway = new Gateway({ backend: { credentials: async () => { throw new Error('Offline B backend unavailable.'); } }, gatewayKey,
  getAProvider: async () => ({ config: { base_url: 'http://127.0.0.1:1/v1' } }), codeBuddyProvider: responses,
  codeBuddyEnabled: () => true, onUsage: async event => { usageEvents.push(event); },
  fetchImpl: async (address, options) => {
    if (new URL(address).pathname.endsWith('/models') && (!options?.method || options.method === 'GET')) return Response.json({ models: [] });
    originalInferenceCalls++; throw new Error('The offline fixture must never route inference to A or B.');
  } });
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', data => chunks.push(data));
  req.on('end', () => {
    if (req.method === 'POST') {
      try { requests.push(summarize(readPayload(Buffer.concat(chunks), req.headers))); }
      catch (error) { errors.push({ phase: 'capture', message: redact(error.message) }); }
    }
  });
  try { await gateway.proxy(req, res, new URL(req.url, 'http://offline-fixture.invalid')); }
  catch (error) { errors.push({ phase: 'gateway', status: error.status ?? 500, message: redact(error.message) });
    if (!res.headersSent) res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: redact(error.message) } })); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { CODEX_HOME: codexHome, BIFROST_CODEBUDDY_OFFLINE_KEY: 'offline-fixture-client-key' };
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
  if (process.env[key]) env[key] = process.env[key];
}
const config = { model_provider: 'bifrost_offline', model_catalog_json: catalogPath, cli_auth_credentials_store: 'file',
  // A global summary preference must not leak into a model that cannot honor it.
  model_reasoning_effort: 'high', model_reasoning_summary: 'detailed', approval_policy: 'never',
  'analytics.enabled': false, 'model_providers.bifrost_offline.name': 'Bifrost offline protocol fixture',
  'model_providers.bifrost_offline.base_url': baseUrl, 'model_providers.bifrost_offline.wire_api': 'responses',
  'model_providers.bifrost_offline.requires_openai_auth': false, 'model_providers.bifrost_offline.supports_websockets': false,
  'model_providers.bifrost_offline.env_key': 'BIFROST_CODEBUDDY_OFFLINE_KEY',
  'model_providers.bifrost_offline.http_headers': { 'X-Account-Bridge-Key': gatewayKey } };
const serialize = value => typeof value === 'object' && value !== null
  ? '{' + Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}=${JSON.stringify(entry)}`).join(',') + '}' : JSON.stringify(value);
let exitCode = null;
try {
  nativeVersion = (await promisify(execFile)(binary, ['--version'], { env, cwd: work, windowsHide: true, timeout: 10000 })).stdout.trim();
  const args = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', work,
    '--model', CODEBUDDY_MODEL.id, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${serialize(value)}`]),
    'Read bridge-proof.txt using the provided local shell tool. Reply with exactly the file contents. Do not access the network or any other file.'];
  child = spawn(binary, args, { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try { const event = JSON.parse(line); clientEvents.push(event); }
    catch { errors.push({ phase: 'client-json', message: 'Native Codex emitted a non-JSON output line.' }); }
  });
  child.stderr.on('data', () => {});
  timer = setTimeout(() => { errors.push({ phase: 'timeout', message: 'Offline native Codex round trip timed out.' }); child.kill(); }, 60000);
  exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  lines.close();
  await Promise.all(responseReads);
  const completed = clientEvents.some(event => event.type === 'turn.completed');
  const commands = clientEvents.filter(event => event.type === 'item.completed' && ['command_execution', 'commandExecution'].includes(event.item?.type));
  const replies = clientEvents.filter(event => event.type === 'item.completed' && ['agent_message', 'agentMessage'].includes(event.item?.type));
  const reply = replies.at(-1)?.item.text?.trim();
  assert.equal(exitCode, 0); assert.equal(completed, true); assert.ok(commands.length > 0);
  assert.equal(reply, expected); assert.equal(fakeCalls, 2); assert.equal(originalInferenceCalls, 0);
  assert.equal(gateway.metrics.accounts.CodeBuddy.completed, 2); assert.equal(gateway.metrics.accounts.CodeBuddy.failed, 0);
  assert.equal(sawReasoning && sawExtraFields && sawLocalOutput, true);
  assert.ok(requests.at(-1).input.some(item => item.encryptedPrefixMatches));
  assert.ok(requests.every(request => !request.reasoningFields.includes('summary')));
  assert.ok(requests.every(request => request.include.includes('reasoning.encrypted_content')));
  const replayedReasoning = requests.at(-1).input.filter(item => item.encryptedPresent);
  const emittedReasoning = responseItems.filter(item => item.encryptedHash);
  assert.ok(emittedReasoning.length > 0);
  for (const item of emittedReasoning) assert.ok(replayedReasoning.some(replayed => replayed.id === item.id && replayed.encryptedHash === item.encryptedHash));
  assert.ok(requests[0].tools.some(tool => tool.type === 'function' && tool.name === 'request_user_input'));
  const defaultHostedWebDeclared = requests[0].tools.some(tool => ['web_search', 'web_search_preview'].includes(tool.type));
  const proof = { passed: true, nativeVersion, realInference: false, existingAuthLoaded: false, fixtureDirectory: work,
    exactLocalToolOutput: true, finalReplyMatched: true, reasoningPreserved: sawReasoning, extraFieldsPreserved: sawExtraFields,
    opaqueReasoningReplayedUnchanged: true, userQuestionToolDeclared: true, defaultHostedWebDeclared,
    unsupportedSummaryPreferenceOmitted: true, encryptedReasoningRequested: true,
    gateway: { accounts: gateway.metrics.accounts, originalInferenceCalls }, selectedTool, requests, responseItems, upstreamRequests,
    localToolCalls: commands.length, usageRecords: usageEvents.length, errors };
  await writeFile(join(work, 'result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, nativeVersion, realInference: false, existingAuthLoaded: false,
    localToolCalls: commands.length, reasoningPreserved: sawReasoning, extraFieldsPreserved: sawExtraFields,
    opaqueReasoningReplayedUnchanged: true, userQuestionToolDeclared: true, defaultHostedWebDeclared,
    evidencePath: join(work, 'result.json') }, null, 2));
} catch (error) {
  const proof = { passed: false, nativeVersion, realInference: false, existingAuthLoaded: false, exitCode,
    failure: redact(error.message), selectedTool, requests, responseItems, upstreamRequests,
    clientEvents: clientEvents.map(event => ({ type: event.type, message: event.type === 'error' ? redact(event.message) : undefined,
      itemType: event.item?.type, commandExitCode: event.item?.exit_code })), errors };
  await writeFile(join(work, 'result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.error(JSON.stringify({ passed: false, failure: proof.failure, evidencePath: join(work, 'result.json') }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer); if (child && child.exitCode === null && !child.killed) child.kill();
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
}
