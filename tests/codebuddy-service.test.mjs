import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodeBuddyService } from '../src/codebuddy-service.mjs';

async function fixture(t, overrides = {}, gatewayState = { running: true, baseUrl: 'http://192.168.168.1:43157', requests: 2 }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'codebuddy-service-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const timers = [], signals = [];
  let loggedOut = 0, modelCalls = 0;
  const client = {
    begin: async () => ({ state: 'private-state', authUrl: 'https://copilot.tencent.com/login?state=private-state', expiresAt: Date.now() + 300000 }),
    poll: async (_login, { signal }) => { signals.push(signal); return { pending: true }; },
    logout: async () => { loggedOut++; },
    chatCompletions: async () => { modelCalls++; throw new Error('must not infer'); },
    ...overrides,
  };
  const provider = { status: async () => ({ authenticated: false, ready: false, modelAvailable: false }) };
  const service = await startCodeBuddyService({ stateDir, client, provider, store: {},
    getGatewayStatus: () => gatewayState,
    setTimer: action => { const timer = { action, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; } });
  t.after(() => service.close());
  return { service, client, provider, timers, signals, stateDir,
    loggedOut: () => loggedOut, modelCalls: () => modelCalls };
}

test('newly installed service can start first login and saves no credential in its feature configuration', async t => {
  const { service, stateDir, timers, modelCalls } = await fixture(t);
  assert.equal((await service.status()).configured, true);
  const login = await service.beginLogin();
  assert.equal(login.url.startsWith('https://copilot.tencent.com/login'), true);
  const config = JSON.parse(await readFile(join(stateDir, 'codebuddy.json'), 'utf8'));
  assert.deepEqual(config, { version: 1, enabled: true });
  await timers[0].action();
  assert.equal((await service.status()).login.state, 'pending');
  assert.equal(modelCalls(), 0);
});

test('logout cancels an old login and a late result cannot restore its public completed state', async t => {
  let resolvePoll;
  const { service, timers, signals, loggedOut } = await fixture(t, {
    poll: (_login, { signal }) => { signals.push(signal); return new Promise(resolve => { resolvePoll = resolve; }); },
  });
  assert.equal(service.authorizationVersion, 0);
  await service.beginLogin(); assert.equal(service.authorizationVersion, 1);
  const polling = timers[0].action();
  await service.logout();
  assert.equal(service.authorizationVersion, 2);
  assert.equal(signals[0].aborted, true);
  resolvePoll({ pending: false }); await polling;
  assert.equal((await service.status()).login.state, 'not_started');
  assert.equal(loggedOut(), 1);
});

test('authorization completion only refreshes metadata and retains per-channel gateway counters', async t => {
  const { service, timers, provider, modelCalls } = await fixture(t, { poll: async () => ({ pending: false }) });
  provider.status = async () => ({ authenticated: true, ready: true, modelAvailable: true, username: 'employee',
    billing: { verified: false, employeeTokenMultiplier: null, sourceCredits: 'x2.17' },
    catalog: { source: 'native-cache', savedAt: 1792401859577, liveVerified: true, privateValue: 'never-export' } });
  await service.beginLogin(); await timers[0].action();
  const status = await service.status();
  assert.equal(status.login.state, 'complete'); assert.equal(status.provider.username, 'employee');
  assert.equal(status.gateway.requests, 2); assert.equal(status.provider.billing.verified, false);
  assert.equal(status.provider.billing.sourceCredits, 'x2.17');
  assert.deepEqual(status.provider.catalog, { source: 'native-cache', savedAt: 1792401859577, liveVerified: false, models: [] });
  assert.equal(modelCalls(), 0);
});

test('installing a replacement authorization invalidates catalogs captured during a pending attempt', async t => {
  let installed = false;
  const { service, provider, timers, modelCalls } = await fixture(t, {
    poll: async () => { installed = true; return { pending: false }; },
  });
  provider.getModels = async () => [{ id: `CodeBuddy-${installed ? 'new' : 'old'}-account-model`,
    upstream: `${installed ? 'new' : 'old'}-account-model`, name: 'CodeBuddy · Account model', available: true, reason: null }];
  assert.equal(service.authorizationVersion, 0);
  await service.beginLogin();
  const pendingVersion = service.authorizationVersion;
  const pendingModels = await service.getModels();
  assert.equal(pendingVersion, 1);
  assert.equal(pendingModels[0].upstream, 'old-account-model');
  await timers[0].action();
  assert.equal((await service.status()).login.state, 'complete');
  assert.equal(service.authorizationVersion, pendingVersion + 1);
  assert.equal((await service.getModels())[0].upstream, 'new-account-model');
  assert.equal(pendingModels[0].upstream, 'old-account-model');
  await service.logout();
  assert.equal(service.authorizationVersion, pendingVersion + 2);
  await service.close();
  assert.equal(service.authorizationVersion, pendingVersion + 3);
  assert.equal(modelCalls(), 0);
});

test('the management status exposes a sanitized channel error and clears it when gateway recovery clears it', async t => {
  const gatewayState = { running: true, requests: 1, failed: 1, active: 0,
    lastError: '此附件格式暂不能保真转换，请先解析为文本或图片后发送。' };
  const { service, modelCalls } = await fixture(t, {}, gatewayState);
  const status = await service.status();
  assert.equal(status.gateway.lastError, gatewayState.lastError);
  assert.equal(status.gateway.failed, 1);
  gatewayState.lastError = { message: 'Request rejected: Bearer PRIVATE_ACCESS_TOKEN',
    credential: 'PRIVATE_OTHER_TOKEN', body: 'PRIVATE_FILE_CONTENT' };
  const sanitized = await service.status();
  assert.equal(sanitized.gateway.lastError, 'Request rejected: Bearer [REDACTED]');
  assert.equal(JSON.stringify(sanitized).includes('PRIVATE_'), false);
  gatewayState.lastError = { body: 'PRIVATE_FILE_CONTENT' };
  assert.equal((await service.status()).gateway.lastError, null);
  gatewayState.lastError = null; gatewayState.completed = 1;
  assert.equal((await service.status()).gateway.lastError, null);
  assert.equal((await service.status()).gateway.failed, 1);
  assert.equal(modelCalls(), 0);
});

test('full service model catalogs expose only mapped public descriptors and preserve source availability', async t => {
  const { service, provider, modelCalls } = await fixture(t);
  const models = [{ id: 'CodeBuddy-gpt-6-astra', name: 'CodeBuddy · GPT-6-Astra', upstream: 'gpt-6-astra',
    available: true, reason: null, source: 'native-cache', efforts: ['low', 'high'], contextWindow: 300000, apiKey: 'PRIVATE' },
  { id: 'CodeBuddy-completion-gf', name: 'CodeBuddy · Completion', upstream: 'completion-gf', available: false, reason: 'PRIVATE_REASON', source: 'native-cache' }];
  provider.getModels = async () => models;
  provider.status = async () => ({ authenticated: true, ready: true, modelAvailable: true,
    catalog: { source: 'native-cache', savedAt: 1000, liveVerified: false, models, token: 'PRIVATE' } });
  const listed = await service.getModels(), status = await service.status();
  assert.equal(listed.length, 2); assert.deepEqual(status.provider.catalog.models, listed); assert.equal(listed[1].available, false);
  assert.equal(listed[0].source, 'native-cache'); assert.deepEqual(listed[0].efforts, ['low', 'high']);
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false); assert.equal(modelCalls(), 0);
});

test('the CodeBuddy management API exposes the optional Codex endpoint without changing the Messages endpoint', async t => {
  const { service } = await fixture(t, {}, { running: true, baseUrl: 'http://192.168.168.1:43157',
    codexBaseUrl: 'http://127.0.0.1:43155/backend-api/codex', requests: 4, completed: 3, failed: 1, active: 0 });
  const status = await service.status();
  assert.equal(status.gateway.baseUrl, 'http://192.168.168.1:43157');
  assert.equal(status.gateway.codexBaseUrl, 'http://127.0.0.1:43155/backend-api/codex');
  assert.equal(status.gateway.requests, 4);
});

test('the service lazily persists its own thinking key and restores hidden tool history after restart', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'codebuddy-service-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let record = null, loads = 0, saves = 0;
  const keyStore = { load: async () => { loads++; return structuredClone(record); },
    save: async value => { saves++; record = structuredClone(value); } };
  const calls = [];
  const client = { status: async () => ({ authenticated: true, identity: { uid: 'employee', username: 'employee' } }),
    modelCatalog: async () => [{ id: 'claude-opus-5.5', name: 'Claude-Opus-5.5' }],
    chatCompletions: async ({ body }) => {
      calls.push(body);
      const delta = calls.length === 1 ? { reasoning_content: 'PRIVATE_SERVICE_THOUGHT', tool_calls: [
        { index: 0, id: 'call_one', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ] } : { content: 'Done' };
      const finish_reason = calls.length === 1 ? 'tool_calls' : 'stop';
      return new Response([{ choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason }] }].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    } };
  const options = { stateDir, client, store: {}, thinkingKeyStore: keyStore };
  const first = await startCodeBuddyService(options);
  await first.status(); assert.equal(loads, 0); assert.equal(saves, 0);
  const body = { model: first.model.id, max_tokens: 64, stream: false,
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'mock only' }] };
  const response = await first.provider.request({ path: '/v1/messages', body }), message = await response.json();
  assert.equal(response.status, 200); assert.equal(loads, 1); assert.equal(saves, 1);
  assert.equal(JSON.stringify(message).includes('PRIVATE_SERVICE_THOUGHT'), false);
  await first.close();
  const second = await startCodeBuddyService(options); t.after(() => second.close());
  const next = await second.provider.request({ path: '/v1/messages', body: { ...body, messages: [...body.messages,
    { role: 'assistant', content: message.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_one', content: 'mock result' }] }] } });
  assert.equal(next.status, 200); await next.json();
  assert.equal(loads, 2); assert.equal(saves, 1);
  assert.equal(calls[1].messages[1].reasoning_content, 'PRIVATE_SERVICE_THOUGHT');
  assert.equal(JSON.stringify(await second.status()).includes(record.key), false);
});

test('a failed optional thinking-key load leaves management available and sends no model request', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'codebuddy-service-bad-key-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let modelCalls = 0;
  const service = await startCodeBuddyService({ stateDir, store: {},
    thinkingKeyStore: { load: async () => { throw new Error('PRIVATE_KEY_ERROR'); } },
    client: { status: async () => ({ authenticated: true, identity: { uid: 'employee' } }),
      modelCatalog: async () => [{ id: 'claude-opus-5.5' }], chatCompletions: async () => { modelCalls++; } } });
  t.after(() => service.close());
  assert.equal((await service.status()).provider.authenticated, true);
  const response = await service.provider.request({ path: '/v1/messages', body: { model: service.model.id,
    max_tokens: 64, messages: [{ role: 'user', content: 'mock only' }] } });
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('PRIVATE_KEY_ERROR'), false);
  assert.equal(modelCalls, 0);
});
