import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SubscriptionBackend } from '../src/backend.mjs';

const now = 2_000_000_000_000;
function jwt(accountId = 'workspace-b', userId = 'person-b', expiry = now + 3_600_000) {
  return `test.${Buffer.from(JSON.stringify({ exp: expiry / 1000, sub: userId,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId } })).toString('base64url')}.test`;
}
function fixture() {
  const rpc = new EventEmitter();
  rpc.running = true;
  rpc.account = { type: 'chatgpt', email: 'b@example.invalid', planType: 'business' };
  rpc.token = jwt(); rpc.calls = []; rpc.refreshed = jwt();
  rpc.request = async (method, params) => {
    rpc.calls.push({ method, params });
    if (method === 'account/read') return { account: rpc.account };
    if (method === 'getAuthStatus') return { authMethod: rpc.authMethod ?? 'chatgpt', authToken: params.refreshToken ? rpc.refreshed : rpc.token };
    if (method === 'account/login/start') return params.type === 'chatgptDeviceCode'
      ? { type: 'chatgptDeviceCode', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', loginId: 'device-b' }
      : { type: 'chatgpt', authUrl: 'https://auth.openai.com/oauth/authorize?test=1', loginId: 'login-b' };
    if (method === 'account/logout') { rpc.account = null; return {}; }
    return {};
  };
  const state = { enabled: false, pinnedAccount: null };
  let saves = 0;
  const backend = new SubscriptionBackend({ rpc, state, saveState: async () => { saves++; }, clock: () => now });
  return { backend, rpc, state, saves: () => saves };
}

test('unbound backend cannot export a credential for inference', async () => {
  const { backend, rpc } = fixture();
  await assert.rejects(backend.credentials(), /尚未绑定/);
  assert.equal(rpc.calls.length, 0);
});

test('binding pins both B user and workspace, without exposing the token', async () => {
  const { backend, state, saves } = fixture();
  const bound = await backend.bind();
  assert.deepEqual(bound, { email: 'b@example.invalid', planType: 'business' });
  assert.equal(state.pinnedAccount.accountId, 'workspace-b');
  assert.equal(state.pinnedAccount.userId, 'person-b');
  assert.equal(saves(), 1);
  assert.equal((await backend.credentials()).accountId, 'workspace-b');
  assert.ok(!JSON.stringify(state).includes('test.'));
});

test('account or workspace changes fail closed after native auth notification', async () => {
  const { backend, rpc } = fixture();
  await backend.bind();
  rpc.token = jwt('workspace-c', 'person-b');
  rpc.emit('notification', 'account/updated', {});
  await assert.rejects(backend.credentials(), /不一致/);
});

test('an API key cannot silently replace a subscription login', async () => {
  const { backend, rpc } = fixture();
  rpc.account = { type: 'apiKey' };
  await assert.rejects(backend.bind(), /不使用 API Key/);
  rpc.account = { type: 'chatgpt', email: 'b@example.invalid' };
  rpc.authMethod = 'apikey';
  await assert.rejects(backend.bind(), /订阅授权不可用/);
});

test('near-expiry credentials refresh once for concurrent requests', async () => {
  const { backend, rpc } = fixture();
  rpc.token = jwt('workspace-b', 'person-b', now + 60_000);
  const results = await Promise.all(Array.from({ length: 8 }, () => backend.credentials({ requireBinding: false })));
  assert.ok(results.every((result) => result.expiresAt === now + 3_600_000));
  assert.equal(rpc.calls.filter((call) => call.method === 'getAuthStatus' && call.params.refreshToken).length, 1);
});

test('a swallowed native refresh failure cannot return an expired token', async () => {
  const { backend, rpc } = fixture();
  rpc.token = rpc.refreshed = jwt('workspace-b', 'person-b', now - 1000);
  await assert.rejects(backend.bind(), /授权已过期/);
});

test('a forced refresh arriving during a normal token read still performs a forced refresh', async () => {
  const { backend, rpc } = fixture();
  rpc.refreshed = `${jwt()}.replacement`;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { entered = resolve; });
  const originalRequest = rpc.request;
  rpc.request = async (method, params) => {
    if (method === 'getAuthStatus' && !params.refreshToken) { entered(); await gate; }
    return originalRequest(method, params);
  };
  const normal = backend.credentials({ requireBinding: false });
  await called;
  const forced = backend.credentials({ force: true, requireBinding: false });
  release();
  const [, replacement] = await Promise.all([normal, forced]);
  assert.equal(replacement.value, rpc.refreshed);
  assert.equal(rpc.calls.filter((call) => call.method === 'getAuthStatus' && call.params.refreshToken).length, 1);
});

test('starting a new login disables previous routing; logout clears the binding', async () => {
  const { backend, state } = fixture();
  await backend.bind();
  const result = await backend.beginLogin();
  assert.ok(result.url.startsWith('https://auth.openai.com/'));
  assert.equal(state.enabled, false); assert.equal(state.pinnedAccount, null);
  await backend.logout();
  assert.deepEqual(backend.login, { state: 'idle' }); assert.equal(backend.account, null);
});

test('device login uses native device flow and reuses the same pending code', async () => {
  const { backend, rpc, state } = fixture();
  await backend.bind();
  const result = await backend.beginLogin({ deviceCode: true });
  assert.deepEqual(result, { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
  assert.equal(state.enabled, false); assert.equal(state.pinnedAccount, null);
  assert.equal(backend.login.method, 'deviceCode');
  assert.deepEqual(await backend.beginLogin({ deviceCode: true }), result);
  assert.equal(rpc.calls.filter((call) => call.method === 'account/login/start').length, 1);
  assert.equal(rpc.calls.find((call) => call.method === 'account/login/start').params.type, 'chatgptDeviceCode');
});

test('changing login mode cancels the old login and ignores its delayed completion', async () => {
  const { backend, rpc } = fixture();
  await backend.beginLogin();
  await backend.beginLogin({ deviceCode: true });
  assert.ok(rpc.calls.some((call) => call.method === 'account/login/cancel' && call.params.loginId === 'login-b'));
  rpc.emit('notification', 'account/login/completed', { loginId: 'login-b', success: false, error: 'cancelled' });
  assert.equal(backend.login.state, 'pending');
  rpc.emit('notification', 'account/login/completed', { loginId: 'device-b', success: true });
  assert.equal(backend.login.state, 'complete');
  assert.equal(backend.login.userCode, undefined);
  rpc.emit('notification', 'account/login/completed', { loginId: 'login-b', success: false, error: 'cancelled' });
  assert.equal(backend.login.state, 'complete');
  await backend.logout();
  rpc.emit('notification', 'account/login/completed', { loginId: 'device-b', success: true });
  assert.equal(backend.login.state, 'idle');
});

test('untrusted device authorization links cannot be presented to the user', async () => {
  const { backend, rpc } = fixture();
  rpc.request = async () => ({ verificationUrl: 'https://external.invalid/codex/device', userCode: 'ABCD-1234' });
  await assert.rejects(backend.beginLogin({ deviceCode: true }), /非预期授权地址/);
  assert.equal(backend.login.state, 'error');
  assert.equal(backend.login.url, undefined);
});
