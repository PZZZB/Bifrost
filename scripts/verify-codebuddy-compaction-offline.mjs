import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { CodexRpc } from '../src/rpc.mjs';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';
import { Gateway } from '../src/gateway.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { appendCodeBuddyModel } from '../src/models.mjs';
import { startServerRemotes } from '../src/runtime/server-remotes.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';

// Actual native Codex, synthetic credentials, canned loopback inference only.
// No existing login/configuration, real model, production gateway or user thread.
const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--binary', '--context-window'].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error('Expected [--binary /path/to/codex] [--context-window TOKENS].');
  options.set(args[index], args[index + 1]);
}
const contextWindow = options.has('--context-window') ? Number(options.get('--context-window')) : null;
if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow < 1000 || contextWindow > 1000000)) throw new Error('Fixture context window must be an integer from 1000 to 1000000.');
const binary = options.get('--binary') ?? await resolveCodexBinary();
const work = fileURLToPath(new URL(`../.state/codebuddy-compaction-offline-${Date.now()}-${randomBytes(3).toString('hex')}/`, import.meta.url));
const home = join(work, 'home'); await mkdir(home, { recursive: true, mode: 0o700 });
const marker = `OFFLINE_CONTEXT_${randomBytes(12).toString('hex')}`;
const summary = `${marker}: The earlier task requested a canned fixture reply. Continue using the exact fixture marker.`;
const remoteSummary = `${summary}\nThe remote fixture also completed its canned reply.`;
const key = randomBytes(32), gatewayKey = 'offline-compaction-gateway-key';
const model = CODEBUDDY_MODEL.id, actualModel = 'claude-opus-5.5';
const upstreamA = 'https://offline-native-a.invalid/backend-api/codex', upstreamB = 'https://offline-native-b.invalid/backend-api/codex';
const requests = [], upstreamRequests = [], steps = [], errors = [], usage = [], notifications = [];
let phase = 'initial', rpc, threadId, waiter, timer, nativeVersion;
const hash = value => createHash('sha256').update(value).digest('hex');
function decode(bytes, headers) {
  for (const encoding of (headers['content-encoding'] || 'identity').split(',').reverse().map(value => value.trim())) {
    if (encoding !== 'identity') bytes = ({ gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync, zstd: zlib.zstdDecompressSync })[encoding](bytes);
  }
  return JSON.parse(bytes.toString('utf8'));
}
function chat(text, thinking = false) {
  const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
  return new Response([
    ...(thinking ? [chunk({ reasoning_content: 'OFFLINE_PRIVATE_CODEBUDDY_THINKING', extra_fields: { fixture: true } })] : []),
    chunk({ role: 'assistant', content: text }), chunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }, '[DONE]',
  ].map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function nativeResponse(model, text) {
  const item = { type: 'message', id: `msg_${phase}`, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
  const reasoning = { type: 'reasoning', id: `rs_${phase}`, summary: [], encrypted_content: 'OFFLINE_OPENAI_OPAQUE_NOT_REAL' };
  const response = { id: `resp_${phase}`, object: 'response', model, status: 'completed', output: [reasoning, item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
  const events = [{ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: reasoning }, { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, item_id: item.id, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 1, item }, { type: 'response.completed', response }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const native = new CodeBuddyProvider({ loadThinkingState: () => new CodeBuddyThinkingState({ key }), client: {
  status: async () => ({ authenticated: true, identity: { uid: 'offline-compaction-owner' } }),
  modelCatalog: async () => [{ id: actualModel, name: 'Claude Opus 5.5', supportsToolCall: true }],
  chatCompletions: async ({ body }) => {
    assert.equal(body.model, actualModel);
    const content = JSON.stringify(body.messages);
    const hasSummary = content.includes(summary);
    upstreamRequests.push({ phase, account: 'CodeBuddy', model: body.model, hasSummary, roles: body.messages.map(item => item.role),
      includesCiphertext: content.includes('bifrost-codebuddy-compaction-v1:') || content.includes('OFFLINE_OPENAI_OPAQUE_NOT_REAL') });
    assert.equal(upstreamRequests.at(-1).includesCiphertext, false);
    if (phase === 'compact') {
      assert.equal(body.tool_choice, 'none'); assert.equal(body.tools, undefined);
      assert.ok(body.messages.at(-1).content.includes('Summarize the preceding conversation'));
      return chat(summary, true);
    }
    if (phase !== 'initial') assert.ok(hasSummary, 'Continuation must contain the authenticated real summary.');
    return chat(`${marker}_${phase}`, true);
  },
} });
const provider = new CodeBuddyResponsesProvider({ provider: native });
const remotes = await startServerRemotes({ stateDir: work, secret: randomBytes(48).toString('base64url'),
  config: { version: 1, sources: [{ id: 'fixture', kind: 'bifrost-remote', baseUrl: 'https://offline-remote.invalid/v1',
    protocols: ['messages'], credentialRef: '11111111-1111-4111-8111-111111111111' }] },
  loadKey: async () => `bfk_${'X'.repeat(43)}`,
  fetchImpl: async (url, options) => {
    assert.ok(String(url).startsWith('https://offline-remote.invalid/v1/'));
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'Claude-opus' }, { id: 'Claude-sonnet' }] });
    assert.ok(String(url).endsWith('/messages'));
    const body = JSON.parse(options.body), content = JSON.stringify(body.messages);
    const plain = body.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
      : message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n');
    upstreamRequests.push({ phase, account: 'Bifrost', model: body.model, hasSummary: plain.includes(remoteSummary),
      includesCiphertext: /bifrost-remote-responses-v1:|bifrost-codebuddy-|bridge-codebuddy-v1:/.test(content) });
    assert.equal(upstreamRequests.at(-1).includesCiphertext, false);
    const compact = phase === 'remote-compact';
    if (compact) { assert.equal(body.tools, undefined); assert.equal(body.tool_choice.type, 'none'); }
    if (!['remote-initial', 'remote-compact'].includes(phase)) assert.ok(plain.includes(remoteSummary));
    return Response.json({ type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'OFFLINE_PRIVATE_REMOTE_THINKING', signature: 'OFFLINE_REMOTE_SIGNATURE' },
        { type: 'text', text: compact ? remoteSummary : `${marker}_${phase}` }], usage: { input_tokens: 20, output_tokens: 10 } });
  } });
await remotes.refresh();
const gateway = new Gateway({ gatewayKey, codeBuddyProvider: provider, codeBuddyEnabled: () => true,
  remoteSources: remotes,
  backend: { credentials: async () => ({ value: 'offline-b-token', accountId: 'offline-b-account' }) }, upstream: upstreamB,
  getAProvider: async () => ({ config: { base_url: upstreamA } }), onUsage: value => usage.push(value),
  fetchImpl: async (address, options) => {
    const account = String(address).startsWith(upstreamA) ? 'A' : String(address).startsWith(upstreamB) ? 'B' : null;
    assert.ok(account, 'No unexpected upstream endpoint is permitted.');
    const body = JSON.parse(Buffer.from(options.body).toString('utf8')), content = JSON.stringify(body.input);
    assert.ok(content.includes(summary));
    assert.doesNotMatch(content, /bifrost-codebuddy-|bridge-codebuddy-v1:|bifrost-remote-responses-v1:/);
    upstreamRequests.push({ phase, account, model: body.model, hasSummary: true, includesCiphertext: false });
    return nativeResponse(body.model, `${marker}_${phase}`);
  } });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) { res.writeHead(502); res.end('{}'); return; }
    const chunks = []; req.on('data', value => chunks.push(value)); req.on('end', () => {
      if (req.method !== 'POST') return;
      const body = decode(Buffer.concat(chunks), req.headers);
      requests.push({ phase, model: body.model, types: body.input.map(item => item.type || 'message'),
        encrypted: body.input.filter(item => typeof item.encrypted_content === 'string').map(item => ({ type: item.type, hash: hash(item.encrypted_content) })) });
    });
    await gateway.proxy(req, res, new URL(req.url, 'http://fixture.invalid'));
  } catch (error) { errors.push({ phase, code: error.code || error.name, message: error.message }); if (!res.headersSent) res.writeHead(error.status || 500); res.end('{}'); }
});
server.on('connect', (_req, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 502 Offline\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let baseModel = appendCodeBuddyModel({ models: [] }).models[0];
if (contextWindow !== null) {
  const policy = await ModelPolicy.open({ path: join(work, 'model-settings.json') });
  await policy.observe({ models: [{ id: model, name: 'Offline Opus', available: true,
    contextWindow: 300000, contextWindowOptions: [300000, 600000, 1000000], maxInputTokens: 1000000 }] }, 'CodeBuddy');
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [], contextWindows: { [model]: contextWindow } });
  baseModel = policy.filterCatalog({ models: [baseModel] }).models[0];
}
const observedWindows = [];
const catalogPath = join(work, 'catalog.json');
await writeFile(catalogPath, JSON.stringify({ models: [baseModel,
  ...['gpt-6.1-sol', 'B-gpt-6.1-sol', 'remote/fixture/Claude-opus', 'remote/fixture/Claude-sonnet'].map((slug, index) => ({ ...baseModel, slug, display_name: slug, priority: index + 1 }))] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(name)));
Object.assign(env, { CODEX_HOME: home, HOME: home, USERPROFILE: home, TEMP: work, TMP: work, BIFROST_OFFLINE_KEY: 'offline-client-key',
  HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
const config = { model, model_provider: 'offline', model_catalog_json: catalogPath, cli_auth_credentials_store: 'file', approval_policy: 'never',
  model_reasoning_effort: 'high', model_reasoning_summary: 'none', check_for_update_on_startup: false, 'analytics.enabled': false, 'feedback.enabled': false,
  'features.apps': false, 'features.plugins': false, 'features.in_app_browser': false, 'features.remote_plugin': false,
  'model_providers.offline.name': 'Bifrost offline compaction fixture', 'model_providers.offline.base_url': `${origin}/v1`,
  'model_providers.offline.requires_openai_auth': false, 'model_providers.offline.supports_websockets': false, 'model_providers.offline.wire_api': 'responses',
  'model_providers.offline.env_key': 'BIFROST_OFFLINE_KEY', 'model_providers.offline.http_headers': { 'X-Account-Bridge-Key': gatewayKey },
  'model_providers.offline.capabilities.remote_compaction': 'v2' };
const serialize = value => value && typeof value === 'object' ? '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(',') + '}' : JSON.stringify(value);
rpc = new CodexRpc({ binary, home, cwd: work, spawnImpl: (file, args, options) => spawn(file,
  [...args, ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${serialize(value)}`])], { ...options, env, windowsHide: true }) });
rpc.on('notification', (method, params) => {
  if (method === 'thread/tokenUsage/updated' && Number.isSafeInteger(params.tokenUsage?.modelContextWindow)) {
    observedWindows.push({ phase, tokens: params.tokenUsage.modelContextWindow });
  }
  if (method === 'item/completed' || method === 'turn/completed') notifications.push({ phase, method, type: params.item?.type, status: params.turn?.status });
  if (method === 'turn/completed') waiter?.(params.turn);
});
async function step(nextPhase, selected = model, compact = false) {
  phase = nextPhase;
  const done = new Promise((resolve, reject) => { waiter = resolve; timer = setTimeout(() => reject(new Error(`Offline ${phase} timed out.`)), 15000); });
  void done.catch(() => {});
  try {
    await rpc.request(compact ? 'thread/compact/start' : 'turn/start', compact ? { threadId } : { threadId, model: selected,
      input: [{ type: 'text', text: 'Continue the canned offline fixture. Do not run tools or access the network.' }] });
    const turn = await done;
    assert.equal(turn.status, 'completed', turn.error?.message || `${phase} did not complete.`);
    steps.push({ phase, model: selected, status: turn.status });
  } finally { clearTimeout(timer); waiter = null; }
}
try {
  nativeVersion = (await promisify(execFile)(binary, ['--version'], { cwd: work, env, timeout: 10000, windowsHide: true })).stdout.trim();
  const thread = await rpc.request('thread/start', { model, cwd: work, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
  threadId = thread.thread.id;
  await step('initial'); await step('compact', model, true); await step('continue');
  await step('switch-a', 'gpt-6.1-sol'); await step('switch-b', 'B-gpt-6.1-sol'); await step('switch-back');
  await step('remote-initial', 'remote/fixture/Claude-opus');
  await step('remote-compact', 'remote/fixture/Claude-opus', true);
  await step('remote-continue', 'remote/fixture/Claude-opus');
  await step('remote-switch-model', 'remote/fixture/Claude-sonnet');
  await step('remote-switch-a', 'gpt-6.1-sol');
  await step('remote-switch-back', 'remote/fixture/Claude-opus');
  await step('remote-switch-cb');
  assert.ok(requests.find(item => item.phase === 'compact').types.includes('compaction_trigger'));
  assert.ok(requests.find(item => item.phase === 'continue').types.includes('compaction'));
  assert.ok(requests.find(item => item.phase === 'remote-compact').types.includes('compaction_trigger'));
  assert.ok(requests.find(item => item.phase === 'remote-continue').types.includes('compaction'));
  assert.equal(upstreamRequests.length, steps.length, 'Each client inference must make exactly one model request.');
  assert.equal(errors.length, 0);
  if (contextWindow !== null) {
    const expectedWindow = Math.floor(contextWindow * baseModel.effective_context_window_percent / 100);
    assert.ok(observedWindows.some(value => value.phase === 'initial' && value.tokens === expectedWindow), 'Native Codex must use the configured effective context window.');
  }
} catch (error) { errors.push({ phase, message: error.message }); process.exitCode = 1; }
finally {
  clearTimeout(timer); await rpc.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await remotes.close();
  const proof = { passed: errors.length === 0, nativeVersion, realInference: false, existingAuthLoaded: false, userConfigModified: false,
    sameThread: true, contextWindow, observedWindows, summaryHash: hash(summary), steps, requests, upstreamRequests, notifications, usageRecords: usage.length, errors };
  const path = join(work, 'proof.json'); await writeFile(path, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: proof.passed, nativeVersion, realInference: false, steps, evidencePath: path, errors }, null, 2));
}
