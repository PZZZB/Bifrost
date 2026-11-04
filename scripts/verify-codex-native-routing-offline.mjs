import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { createCodexNativeEntry } from '../src/codex-native-entry.mjs';
import { Gateway } from '../src/gateway.mjs';
import { CodexRpc } from '../src/rpc.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';
import { presentModels } from '../src/model-presentation.mjs';
import { resolveBModel } from '../src/models.mjs';

// Uses only synthetic credentials, disposable state, loopback servers and canned responses.
// The production gateway, real login and user's existing threads are never accessed.
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--binary' || !args[1])) {
  throw new Error('Usage: node scripts/verify-codex-native-routing-offline.mjs [--binary /absolute/path/to/codex]');
}
const binary = args[1] || await resolveCodexBinary();
const stateRoot = fileURLToPath(new URL('../.state/', import.meta.url));
await mkdir(stateRoot, { recursive: true, mode: 0o700 });
const work = await mkdtemp(join(stateRoot, 'codex-native-routing-offline-'));
const home = join(work, 'home'); await mkdir(home, { mode: 0o700 });
const evidencePath = join(work, 'proof.json');
const upstreamA = 'https://native-a.offline.invalid/backend-api/codex';
const upstreamCustomA = 'https://custom-a.offline.invalid/backend-api/codex';
const upstreamB = 'https://native-b.offline.invalid/backend-api/codex';
const gatewayKey = `offline-bridge-${randomBytes(32).toString('base64url')}`;
const bCredential = `offline-b-${randomBytes(24).toString('base64url')}`;
const accountA = 'offline-native-a-account', accountB = 'offline-native-b-account';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = { exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
  sub: 'offline-native-a-user', email: 'offline-native-a@example.invalid',
  'https://api.openai.com/auth': { chatgpt_account_id: accountA, chatgpt_user_id: 'offline-native-a-user', chatgpt_plan_type: 'team' } };
const aCredential = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.offline-fixture-not-a-real-token`;
await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: aCredential, access_token: aCredential, refresh_token: 'offline-not-a-real-refresh', account_id: accountA },
  last_refresh: new Date().toISOString() }), { mode: 0o600 });

const instructions = 'This is a local offline protocol test. Reply with the canned text. Do not run tools or access the network.';
function model(slug, priority) {
  return { slug, display_name: `Offline fixture ${slug}`, description: 'Synthetic routing fixture; no real inference.',
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Fixture default' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority, upgrade: null,
    additional_speed_tiers: [], service_tiers: [], default_service_tier: null, available_access_programs: null, availability_nux: null,
    base_instructions: instructions, model_messages: { instructions_template: instructions },
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none', support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 },
    context_window: 200000, max_context_window: 200000, effective_context_window_percent: 90,
    experimental_supported_tools: [], input_modalities: ['text'], supports_image_detail_original: false,
    supports_parallel_tool_calls: false, supports_search_tool: false, supports_experimental_context: false,
    use_responses_lite: false, supports_reasoning_effort_updates: false, prefer_websockets: false,
    tool_mode: 'direct', multi_agent_version: null };
}
const aCatalog = { models: [model('gpt-6.1-sol', 0), model('gpt-6-astra', 1)] };
const bCatalog = structuredClone(aCatalog);
bCatalog.models[0].display_name = 'GPT-6.1 Sol';
bCatalog.models[1].display_name = 'GPT-6 Astra';
bCatalog.models.push({ ...model('gpt-b-directory-fixture', 2), display_name: 'B directory fixture' });
const presentationAccounts = [
  { id: 'offline-caller-a', kind: 'codex-client', modelPresentation: { prefix: '', order: 0 } },
  { id: 'offline-managed-b', kind: 'codex', modelPresentation: { prefix: 'Team', order: 100 } },
];
const safeUrl = value => String(value).replace(/bfn_[A-Za-z0-9_-]+/g, '[local-capability]');
const hash = value => createHash('sha256').update(value).digest('hex');
function payload(bytes, headers) {
  let decoded = bytes;
  for (const encoding of (headers['content-encoding'] || 'identity').split(',').reverse()) {
    if (encoding.trim() === 'identity') continue;
    const decompress = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync,
      zstd: zlib.zstdDecompressSync }[encoding.trim()];
    assert.equal(typeof decompress, 'function', 'Unsupported fixture request compression.');
    decoded = decompress(decoded);
  }
  return JSON.parse(decoded.toString('utf8'));
}
function response(account, upstreamModel, count) {
  const text = account === 'A' ? 'OFFLINE_A_OK' : 'OFFLINE_B_OK';
  const message = { id: `msg_offline_${account}_${count}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const result = { id: `resp_offline_${account}_${count}`, object: 'response', status: 'completed', model: upstreamModel,
    output: [message], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } };
  const events = [
    { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: result },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

const received = [], upstreamRequests = [], bootstrapRequests = [], upgrades = [], errors = [], runs = [], seedRuns = [];
const counts = { A: 0, B: 0 };
let server, bootstrap, seedServer, rpc, nativeVersion, threadId, phase = 'bootstrap', listed = [], seedInferenceCalls = 0;
let displayNames = {};
let originalProvider, resumedProvider, persistedProvider;
const backend = { credentials: async () => ({ value: bCredential, accountId: accountB }) };
const gateway = new Gateway({ backend, gatewayKey, upstream: upstreamB, catalogWaitMs: 1500,
  presentCatalog: data => ({ ...data, models: presentModels(data.models, { accounts: presentationAccounts, codex: true,
    channelFor: entry => resolveBModel(entry.slug ?? entry.id) ? 'B' : 'A',
    accountFor: channel => presentationAccounts[channel === 'B' ? 1 : 0] }) }),
  getAProvider: async ({ native = false } = {}) => {
    assert.equal(native, true, 'Built-in caller must use its own original A endpoint.');
    return { providerId: 'openai', config: { base_url: native ? upstreamA : upstreamCustomA } };
  },
  fetchImpl: async (address, options = {}) => {
    const url = new URL(address), headers = new Headers(options.headers);
    const account = address.startsWith(upstreamA + '/') ? 'A' : address.startsWith(upstreamB + '/') ? 'B' : null;
    assert.ok(account, 'Gateway attempted an unexpected upstream URL.');
    assert.equal(headers.get('authorization'), `Bearer ${account === 'A' ? aCredential : bCredential}`);
    assert.equal(headers.get('chatgpt-account-id'), account === 'A' ? accountA : accountB);
    assert.equal(headers.has('x-account-bridge-key'), false, 'Bridge key must not cross either upstream boundary.');
    const summary = { account, method: options.method || 'GET', path: url.pathname, query: url.search,
      callerCredentialPreserved: account === 'A', managedBCredentialUsed: account === 'B', bridgeKeyRemoved: true };
    upstreamRequests.push(summary);
    if (url.pathname.endsWith('/models')) return Response.json(account === 'A' ? aCatalog : bCatalog);
    assert.equal(options.method, 'POST'); assert.ok(url.pathname.endsWith('/responses'));
    const body = Buffer.from(options.body);
    const incoming = received.findLast(item => item.phase === phase && item.method === 'POST');
    assert.ok(incoming?.bytes, 'The native client request must be observed before forwarding.');
    const original = payload(incoming.bytes, incoming.headers);
    const forwarded = payload(body, Object.fromEntries(headers));
    summary.requestBodyHash = hash(body);
    summary.clientModel = original.model; summary.upstreamModel = forwarded.model;
    if (account === 'A') {
      assert.equal(hash(body), hash(incoming.bytes), 'A body must be byte-for-byte unchanged.');
      assert.equal(headers.get('content-encoding'), incoming.headers['content-encoding'] ?? null);
      assert.equal(headers.get('originator'), incoming.headers.originator ?? null);
      summary.bodyUnchanged = true;
    } else {
      const alias = resolveBModel(original.model);
      assert.ok(alias && bCatalog.models.some(model => model.slug === alias.upstream));
      assert.equal(forwarded.model, alias.upstream);
      assert.deepEqual(forwarded, { ...original, model: alias.upstream }, 'Only the B model alias may change in the Responses body.');
      assert.equal(headers.has('content-encoding'), false);
      summary.onlyModelChanged = true;
    }
    return response(account, forwarded.model, ++counts[account]);
  } });

async function closeRpc() {
  const old = rpc; rpc = null;
  if (!old) return;
  const child = old.process;
  const closed = child && child.exitCode === null ? once(child, 'close').catch(() => {}) : Promise.resolve();
  await old.close(); await closed;
}
async function turn(modelName, expected) {
  const client = rpc, items = [];
  let timer, listener;
  const completion = new Promise((resolve, reject) => {
    listener = (method, params) => {
      if (params?.threadId !== threadId) return;
      if (method === 'item/completed') items.push(params.item);
      if (method === 'turn/completed') resolve(params.turn);
    };
    client.on('notification', listener);
    timer = setTimeout(() => reject(new Error('Offline native routing turn timed out.')), 30000);
  });
  // A failed or slow start must not leave the notification timeout unhandled.
  void completion.catch(() => {});
  try {
    const started = await client.request('turn/start', { threadId, model: modelName, effort: 'medium',
      input: [{ type: 'text', text: 'Reply with the canned fixture response. Do not run tools or use the network.' }] });
    const finished = await completion;
    assert.equal(finished.id, started.turn.id);
    assert.equal(finished.status, 'completed', finished.error?.message || 'The offline turn did not complete.');
    const replies = items.filter(item => item.type === 'agentMessage');
    const text = replies.at(-1)?.text;
    assert.equal(text, expected);
    runs.push({ model: modelName, status: finished.status, reply: text, threadId });
  } finally { clearTimeout(timer); client.off('notification', listener); }
}

try {
  bootstrap = http.createServer(async (req, res) => {
    if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
      bootstrapRequests.push({ method: req.method, path: '[blocked external HTTP]', blocked: true });
      res.writeHead(502); res.end('Offline fixture blocks external HTTP.'); return;
    }
    bootstrapRequests.push({ method: req.method, path: req.url, callerCredentialMatches: req.headers.authorization === `Bearer ${aCredential}` });
    let value;
    if (req.url.includes('/accounts/check')) value = { accounts: [{ id: accountA, workspace_backend_origin: 'https://chatgpt.com',
      account_routing_override: 'NO_CONSTRAINT', can_access_with_session: true }], account_ordering: [accountA], default_account_id: accountA };
    else if (req.url.includes('/models')) value = aCatalog;
    else if (req.url.includes('/config/bundle')) value = { config_toml: { enterprise_managed: [] } };
    else if (req.url.includes('/settings/user')) value = {};
    else { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  });
  bootstrap.on('connect', (req, socket) => {
    bootstrapRequests.push({ method: 'CONNECT', path: '[blocked external TLS]', blocked: true });
    socket.end('HTTP/1.1 502 Offline fixture blocks external TLS\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  bootstrap.listen(0, '127.0.0.1'); await once(bootstrap, 'listening');
  const bootstrapOrigin = `http://127.0.0.1:${bootstrap.address().port}`;
  // A durable rollout is materialized on the first turn, so seed it against a
  // separate canned original endpoint before enabling the actual bridge entry.
  seedServer = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${aCredential}`);
      assert.equal(req.headers['chatgpt-account-id'], accountA);
      if (req.url.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(aCatalog)); return; }
      assert.equal(req.method, 'POST'); assert.ok(req.url.endsWith('/responses'));
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = payload(Buffer.concat(chunks), req.headers);
      assert.equal(data.model, 'gpt-6.1-sol');
      const canned = response('A', data.model, ++seedInferenceCalls);
      res.writeHead(200, Object.fromEntries(canned.headers)); res.end(Buffer.from(await canned.arrayBuffer()));
    } catch (error) { errors.push({ code: 'seed_fixture_failed', message: safeUrl(error.message) }); res.writeHead(500); res.end('{}'); }
  });
  seedServer.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  seedServer.listen(0, '127.0.0.1'); await once(seedServer, 'listening');
  const originalEndpoint = `http://127.0.0.1:${seedServer.address().port}/original-native/backend-api/codex`;
  const nativeEntry = createCodexNativeEntry({ baseUrl: 'http://127.0.0.1:0/backend-api/codex', gatewayKey });
  server = createBridgeServer({ backend, gateway, codexNativeEntry: nativeEntry,
    state: { gatewayKey, enabled: true, pinnedAccount: { accountId: accountB } }, integration: {},
    publicDir: fileURLToPath(new URL('../public/', import.meta.url)), baseUrl: 'http://127.0.0.1:0/backend-api/codex' });
  server.on('request', req => {
    if (!nativeEntry.handles(new URL(req.url, 'http://offline.invalid').pathname)) return;
    const item = { phase, method: req.method, path: safeUrl(req.url), headers: { ...req.headers } };
    received.push(item);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { item.bytes = Buffer.concat(chunks); });
  });
  server.on('upgrade', req => { upgrades.push({ phase, path: safeUrl(req.url), method: req.method,
    hasCallerAuthorization: req.headers.authorization === `Bearer ${aCredential}`, hasAccountId: req.headers['chatgpt-account-id'] === accountA }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = new URL(nativeEntry.baseUrl); endpoint.port = String(server.address().port);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home, TEMP: work, TMP: work,
    HTTP_PROXY: bootstrapOrigin, HTTPS_PROXY: bootstrapOrigin, ALL_PROXY: bootstrapOrigin,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
  const configPath = join(home, 'config.toml');
  const saveConfig = address => writeFile(configPath, Object.entries({ model: 'gpt-6.1-sol', model_provider: 'openai',
    openai_base_url: address, chatgpt_base_url: `${bootstrapOrigin}/backend-api/`, cli_auth_credentials_store: 'file',
    model_reasoning_effort: 'medium', check_for_update_on_startup: false, approval_policy: 'never', sandbox_mode: 'read-only',
    'analytics.enabled': false, 'feedback.enabled': false, 'features.apps': false, 'features.plugins': false,
    'features.in_app_browser': false, 'features.remote_plugin': false }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n',
  { mode: 0o600 });
  const newRpc = () => new CodexRpc({ binary, home, cwd: work,
    spawnImpl: (file, options, settings) => spawn(file, options, { ...settings, env, windowsHide: true }) });
  nativeVersion = (await promisify(execFile)(binary, ['--version'], { env, cwd: work, windowsHide: true, timeout: 10000 })).stdout.trim();
  await saveConfig(originalEndpoint);
  rpc = newRpc();
  const created = await rpc.request('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'openai',
    cwd: work, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only' });
  threadId = created.thread.id; originalProvider = created.modelProvider;
  assert.equal(originalProvider, 'openai'); assert.equal(created.thread.modelProvider, 'openai');
  await turn('gpt-6.1-sol', 'OFFLINE_A_OK'); seedRuns.push(runs.pop());
  await closeRpc();
  await saveConfig(endpoint.href);
  rpc = newRpc();
  // No modelProvider override and no direct database or rollout edits.
  const resumed = await rpc.request('thread/resume', { threadId, excludeTurns: true });
  resumedProvider = resumed.modelProvider;
  assert.equal(resumedProvider, 'openai'); assert.equal(resumed.thread.id, threadId);
  const catalog = await rpc.request('model/list', { includeHidden: false });
  listed = catalog.data.map(item => item.model);
  assert.deepEqual(listed, ['gpt-6.1-sol', 'gpt-6-astra', 'B-gpt-6.1-sol', 'B-gpt-6-astra', 'B-gpt-b-directory-fixture'], 'The real client must list A first and keep the complete B source in native priority order.');
  displayNames = Object.fromEntries(catalog.data.map(item => [item.model, item.displayName]));
  assert.deepEqual(displayNames, {
    'gpt-6.1-sol': 'Offline fixture gpt-6.1-sol', 'gpt-6-astra': 'Offline fixture gpt-6-astra',
    'B-gpt-6-astra': 'Team · GPT-6 Astra', 'B-gpt-6.1-sol': 'Team · GPT-6.1 Sol',
    'B-gpt-b-directory-fixture': 'Team · B directory fixture',
  }, 'The source prefix changes display names while the existing routing model IDs remain unchanged.');
  phase = 'A'; await turn('gpt-6.1-sol', 'OFFLINE_A_OK');
  phase = 'B'; await turn('B-gpt-6.1-sol', 'OFFLINE_B_OK');
  phase = 'B-extra'; await turn('B-gpt-b-directory-fixture', 'OFFLINE_B_OK');
  const stored = await rpc.request('thread/read', { threadId, includeTurns: false });
  persistedProvider = stored.thread.modelProvider;
  assert.equal(persistedProvider, 'openai');
  assert.equal(seedInferenceCalls, 1);
  assert.deepEqual(counts, { A: 1, B: 2 });
  assert.ok(upgrades.length > 0, 'The built-in provider must exercise the real server 426 fallback.');
  assert.ok(upgrades.every(item => item.hasCallerAuthorization && item.hasAccountId));
  assert.equal(gateway.metrics.accounts.A.completed, 1); assert.equal(gateway.metrics.accounts.B.completed, 2);
  assert.equal(gateway.metrics.failed, 0);
  assert.equal(bootstrapRequests.some(item => item.blocked), false, 'No unexpected external request is needed for this proof.');
} catch (error) {
  errors.push({ code: error.code || 'offline_verification_failed', message: safeUrl(error.message) });
  process.exitCode = 1;
} finally {
  await closeRpc();
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  bootstrap?.closeAllConnections(); if (bootstrap?.listening) await new Promise(resolve => bootstrap.close(resolve));
  seedServer?.closeAllConnections(); if (seedServer?.listening) await new Promise(resolve => seedServer.close(resolve));
  const proof = { passed: errors.length === 0, nativeVersion, realCredentialsRead: false, userConfigModified: false,
    realInference: false, externalInference: false, fixtureDirectory: work, originalProvider, resumedProvider, persistedProvider,
    noProviderOverrideOnResume: true, sameThreadForBothAccounts: runs.length === 3 && runs.every(run => run.threadId === runs[0].threadId),
    listed, displayNames, seedRuns, seedInferenceCalls, runs, counts, upgrades, requests: received.map(item => ({ phase: item.phase, method: item.method, path: item.path,
      hasCallerAuthorization: item.headers.authorization === `Bearer ${aCredential}`, hasCallerAccountId: item.headers['chatgpt-account-id'] === accountA,
      originalBodyHash: item.bytes?.length ? hash(item.bytes) : null })), upstreamRequests, bootstrapRequests, errors };
  await writeFile(evidencePath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: proof.passed, nativeVersion, realInference: false, realCredentialsRead: false,
    sameThreadForBothAccounts: proof.sameThreadForBothAccounts, counts, evidencePath, errors }, null, 2));
}
