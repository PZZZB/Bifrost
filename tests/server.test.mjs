import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from '../src/server.mjs';

async function fixture(t, extra = {}) {
  const state = { gatewayKey: 'private-gateway-key-test', enabled: false, pinnedAccount: null };
  const backend = { rpc: { running: true }, account: null, login: { state: 'idle' },
    readAccount: async () => null, publicBinding: () => null };
  const gateway = { metrics: { requests: 0, completed: 0, failed: 0 }, proxy: async (_req, res) => { res.end('gateway'); } };
  const integration = { inspect: async () => ({ installed: false, canInstall: true, configPath: 'test/config.toml', providerId: 'custom' }) };
  const server = createBridgeServer({ state, backend, gateway, integration,
    ...extra,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), baseUrl: 'http://127.0.0.1:0/backend-api/codex' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = await fetch(`${url}/`);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const statusResponse = await fetch(`${url}/api/status`, { headers: { cookie } });
  const status = await statusResponse.json();
  return { url, cookie, status, root, backend };
}

test('management requires an HttpOnly session and does not publish gateway credentials in status', async (t) => {
  const { url, root, status } = await fixture(t);
  assert.match(root.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(root.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${url}/api/status`)).status, 401);
  assert.equal(status.ready, true);
  assert.ok(!JSON.stringify(status).includes('private-gateway-key-test'));
});

test('CSRF and cross-origin requests cannot change login or configuration', async (t) => {
  const { url, cookie, status } = await fixture(t);
  const missing = await fetch(`${url}/api/login`, { method: 'POST', headers: { cookie }, body: '{}' });
  assert.equal(missing.status, 403);
  const crossOrigin = await fetch(`${url}/api/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken, Origin: 'https://external.invalid' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
});

test('unexpected Host headers are rejected before account operations', async (t) => {
  const { url } = await fixture(t);
  // Node's fetch normalizes Host; use the raw HTTP client to exercise rebinding.
  const statusCode = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/`, { headers: { Host: 'rebind.invalid' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(statusCode, 403);
});

test('configuration containing gateway key is only available inside the local management session', async (t) => {
  const { url, cookie } = await fixture(t);
  assert.equal((await fetch(`${url}/api/integration`)).status, 401);
  const response = await fetch(`${url}/api/integration`, { headers: { cookie } });
  const data = await response.json();
  assert.equal(data.gatewayKey, 'private-gateway-key-test');
  assert.match(data.toml, /model_providers\."custom"/);
});

test('device login is forwarded only after validating the requested mode', async (t) => {
  const { url, cookie, status, backend } = await fixture(t);
  let requested;
  backend.beginLogin = async (options) => {
    requested = options;
    return { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
  };
  const send = (deviceCode) => fetch(`${url}/api/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: JSON.stringify({ deviceCode }) });
  assert.equal((await send('true')).status, 400);
  assert.equal(requested, undefined);
  const response = await send(true);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, { deviceCode: true });
  assert.equal((await response.json()).userCode, 'ABCD-1234');
});

test('token history is only available to the local management session', async t => {
  const snapshot = { totals: { inputTokens: 42 }, accounts: { A: {}, B: {} }, recent: [] };
  const { url, cookie } = await fixture(t, { usageLedger: { snapshot: () => snapshot } });
  assert.equal((await fetch(`${url}/api/token-usage`)).status, 401);
  const response = await fetch(`${url}/api/token-usage`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...snapshot, error: null });
});

test('account quotas require the local management session and only call the read-only quota service', async t => {
  let reads = 0;
  const snapshot = { timeZone: 'America/Los_Angeles', accounts: {
    A: { status: 'ok', windows: [{ label: '周额度', remainingPercent: 28 }] },
    B: { status: 'error', error: '账号 B 额度暂时无法读取。', windows: [] },
  } };
  const accountQuotas = { snapshot: async () => { reads++; return snapshot; } };
  const { url, cookie } = await fixture(t, { accountQuotas });
  assert.equal((await fetch(`${url}/api/account-quotas`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/account-quotas`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('With status requires the local session and does not run inference', async t => {
  let reads = 0;
  const snapshot = { configured: true, running: true, manualVerification: true,
    provider: { authenticated: true }, model: { id: 'claude-opus-5-5' } };
  const { url, cookie } = await fixture(t, { getWithStatus: async () => { reads++; return snapshot; } });
  assert.equal((await fetch(`${url}/api/with`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/with`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('an unconfigured CodeBuddy channel has a readable status and actionable login errors', async t => {
  const { url, cookie, status } = await fixture(t);
  const response = await fetch(`${url}/api/codebuddy`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, false);
  assert.equal(data.running, false);
  assert.equal(data.model.id, 'claude-codebuddy-opus-5-5');
  assert.equal(data.manualVerification, true);
  assert.equal(data.provider.billing.employeeTokenMultiplier, null);
  for (const operation of ['login', 'logout']) {
    const response = await fetch(`${url}/api/codebuddy/${operation}`, { method: 'POST',
      headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /CodeBuddy 通道尚未配置/);
  }
});

test('CodeBuddy status is session protected and only reads the service status', async t => {
  let reads = 0;
  const snapshot = { configured: true, running: true, manualVerification: true,
    provider: { authenticated: true, ready: true, modelAvailable: true,
      billing: { verified: false, employeeTokenMultiplier: null, sourceCredits: 2, sourcePromotion: 'catalog value' } },
    model: { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' } };
  const codeBuddyService = { status: async () => { reads++; return snapshot; },
    beginLogin: () => assert.fail('status must not start login'),
    request: () => assert.fail('status must not run inference') };
  const { url, cookie } = await fixture(t, { codeBuddyService });
  assert.equal((await fetch(`${url}/api/codebuddy`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/codebuddy`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('CodeBuddy login and gateway-only logout use the existing session and CSRF checks', async t => {
  let logins = 0, logouts = 0;
  const login = { url: 'https://copilot.tencent.com/login?state=mock', expiresAt: '2026-10-19T20:00:00.000Z' };
  const initialVerification = { status: 'passed', accountEmail: 'account-b@example.invalid' };
  const codeBuddyService = { status: () => ({ configured: true }),
    beginLogin: async () => { logins++; return { ...login, accessToken: 'PRIVATE_SERVICE_ONLY' }; },
    logout: async () => { logouts++; } };
  const { url, cookie, status, backend } = await fixture(t, { codeBuddyService, initialVerification });
  backend.logout = () => assert.fail('CodeBuddy logout must not log out account B');
  const send = (operation, headers) => fetch(`${url}/api/codebuddy/${operation}`, {
    method: 'POST', headers, body: '{}' });
  for (const operation of ['login', 'logout']) {
    assert.equal((await send(operation, { 'X-Bridge-CSRF': status.csrfToken })).status, 401);
    assert.equal((await send(operation, { cookie })).status, 403);
    assert.equal((await send(operation, { cookie, 'X-Bridge-CSRF': status.csrfToken, Origin: 'https://external.invalid' })).status, 403);
  }
  assert.equal(logins, 0);
  assert.equal(logouts, 0);
  const response = await send('login', { cookie, 'X-Bridge-CSRF': status.csrfToken });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), login);
  assert.deepEqual(await (await send('logout', { cookie, 'X-Bridge-CSRF': status.csrfToken })).json(), { ok: true });
  assert.equal(logins, 1);
  assert.equal(logouts, 1);
  const after = await (await fetch(`${url}/api/status`, { headers: { cookie } })).json();
  assert.deepEqual(after.verification, initialVerification);
});

test('CodeBuddy failures leave existing status endpoints and later management actions usable', async t => {
  let attempts = 0;
  const codeBuddyService = { status: () => { throw new Error('CodeBuddy status unavailable'); },
    beginLogin: async () => { if (++attempts === 1) throw new Error('CodeBuddy login unavailable');
      return { url: 'https://copilot.tencent.com/login', expiresAt: null }; } };
  const { url, cookie, status } = await fixture(t, { codeBuddyService });
  assert.equal((await fetch(`${url}/api/codebuddy`, { headers: { cookie } })).status, 500);
  assert.equal((await fetch(`${url}/api/status`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${url}/api/with`, { headers: { cookie } })).status, 200);
  const login = () => fetch(`${url}/api/codebuddy/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
  assert.equal((await login()).status, 500);
  assert.equal((await login()).status, 200);
});

test('concurrent CodeBuddy session changes use the shared management lock', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let logouts = 0;
  const codeBuddyService = { beginLogin: async () => { started(); await pending;
    return { url: 'https://copilot.tencent.com/login', expiresAt: null }; },
  logout: async () => { logouts++; } };
  const { url, cookie, status } = await fixture(t, { codeBuddyService });
  const send = operation => fetch(`${url}/api/codebuddy/${operation}`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
  const first = send('login');
  await entered;
  assert.equal((await send('logout')).status, 409);
  assert.equal(logouts, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await send('logout')).status, 200);
  assert.equal(logouts, 1);
});
