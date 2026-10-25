import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWeChatLogin } from '../src/wechat-login.mjs';
import { WeChatAccountStore, initializeWeChatAccounts } from '../src/wechat-account-store.mjs';
import { createWeChatAccounts } from '../src/wechat-accounts.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';

const appId = 'wx0123456789abcdef', appSecret = 'test-app-secret-never-returned-123456';
const localKey = 'local-private-fixture-'.repeat(3), sessionKey = 'namespace-fixture-'.repeat(3);
const legacyKey = 'legacy-client-fixture-'.repeat(3);
const hash = value => createHash('sha256').update(value).digest('hex');

async function storeFixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'bifrost-wechat-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'accounts');
  await initializeWeChatAccounts(directory);
  const identityKey = (await readFile(join(directory, 'identity.key'), 'utf8')).trim();
  return new WeChatAccountStore({ directory, identityKey, appId, ...options });
}

async function fixture(t, { store, exchangeCode = async code => 'openid-' + code,
  clock = Date.now, ...options } = {}) {
  store ??= await storeFixture(t, { clock });
  const sessions = [];
  const accountApi = createWeChatAccounts({ store, exchangeCode, apiBaseUrl: 'https://api.example.net:47846/v1', clock });
  const legacy = { id: 'legacy', keySha256: hash(legacyKey), maxConcurrent: 2, requestsPerMinute: 30 };
  const server = createExternalClaudeGateway({ gatewayKey: localKey, sessionKey, allowedHosts: ['fixture'],
    accountApi, getClients: async () => [legacy, ...await accountApi.getClients()],
    fetchImpl: async (url, { headers }) => {
      assert.equal(url, 'http://127.0.0.1:43157/v1/models');
      assert.equal(headers.get('authorization'), `Bearer ${localKey}`);
      sessions.push(headers.get('x-session-id')); return Response.json({ data: [] });
    }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const send = (path, { method = 'GET', body, token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'fixture', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)), headers: response.headers }));
    });
    request.on('error', reject); request.end(encoded);
  });
  const login = (code, inviteCode, extra = {}) => send('/account/v1/login', { method: 'POST',
    body: { code, ...(inviteCode ? { inviteCode } : {}), privacyAccepted: true, ...extra } });
  return { store, server, send, login, sessions };
}

test('WeChat exchange uses only the official endpoint and never exposes platform secrets', async () => {
  let seen;
  const exchange = createWeChatLogin({ appId, appSecret, fetchImpl: async (url, options) => {
    seen = { url, options }; return Response.json({ openid: 'openid-alice-123', session_key: 'private-platform-session' });
  } });
  assert.equal(await exchange('one-use-code-123'), 'openid-alice-123');
  assert.equal(seen.url.origin, 'https://api.weixin.qq.com');
  assert.equal(seen.url.pathname, '/sns/jscode2session');
  assert.equal(seen.url.searchParams.get('appid'), appId);
  assert.equal(seen.url.searchParams.get('secret'), appSecret);
  assert.equal(seen.options.redirect, 'error');
  for (const fetchImpl of [async () => { throw new Error(appSecret); },
    async () => Response.json({ errcode: -1, errmsg: appSecret }),
    async () => new Response('x'.repeat(17000))]) {
    await assert.rejects(createWeChatLogin({ appId, appSecret, fetchImpl })('one-use-code-123'), error =>
      error.code === 'wechat_unavailable' && !error.message.includes(appSecret));
  }
  await assert.rejects(createWeChatLogin({ appId, appSecret, fetchImpl: async () =>
    Response.json({ errcode: 40029 }) })('one-use-code-123'), { code: 'wechat_login_rejected' });
  await assert.rejects(exchange('bad/redirect'), { code: 'invalid_login_code' });
});

test('registration issues independent credentials and persists only identity and credential hashes', async t => {
  const { store, login, send, sessions } = await fixture(t);
  const { inviteCode } = await store.invite();
  const response = await login('alice-code-123', inviteCode);
  assert.equal(response.status, 200);
  const alice = response.data;
  assert.equal(alice.isNew, true); assert.match(alice.apiKey, /^bfk_[A-Za-z0-9_-]{43}$/);
  assert.match(alice.sessionToken, /^bfs_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(alice.apiKey, alice.sessionToken);
  assert.equal(alice.apiBaseUrl, 'https://api.example.net:47846/v1');
  assert.equal((await send('/account/v1/me', { token: alice.sessionToken })).data.account.id, alice.account.id);
  assert.equal((await send('/v1/models', { token: alice.apiKey, headers: { 'x-session-id': 'shared' } })).status, 200);
  assert.equal((await send('/v1/models', { token: legacyKey, headers: { 'x-session-id': 'shared' } })).status, 200);
  assert.notEqual(sessions[0], sessions[1]);
  assert.equal((await send('/v1/models', { token: alice.sessionToken })).status, 401);
  assert.equal((await send('/account/v1/me', { token: alice.apiKey })).status, 401);
  const persisted = await readFile(store.path, 'utf8');
  for (const value of [inviteCode, alice.apiKey, alice.sessionToken, 'openid-alice-code-123', 'alice-code-123']) {
    assert.ok(!persisted.includes(value));
  }
  assert.equal((await store.read()).invites.length, 0);
  const reopened = new WeChatAccountStore({ directory: store.directory, identityKey: store.identityKey, appId });
  assert.equal((await reopened.me(alice.sessionToken)).account.id, alice.account.id);
  assert.equal((await reopened.clients())[0].keySha256, hash(alice.apiKey));
});

test('one-use invitations cannot be raced by two registrations', async t => {
  const store = await storeFixture(t);
  const { inviteCode } = await store.invite();
  const results = await Promise.allSettled(['openid-alice-123', 'openid-bob-123'].map(openid =>
    store.login({ openid, inviteCode, privacyAccepted: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'invite_required');
  assert.equal((await store.read()).accounts.length, 1);
});

test('registration requires privacy consent, live invite, capacity and server-verified identity', async t => {
  let now = 10_000;
  const store = await storeFixture(t, { maxAccounts: 1, clock: () => now });
  const { inviteCode } = await store.invite({ lifetimeMs: 60_000 });
  await assert.rejects(store.login({ openid: 'openid-alice-123', inviteCode }), { code: 'privacy_required' });
  now += 60_001;
  await assert.rejects(store.login({ openid: 'openid-alice-123', inviteCode, privacyAccepted: true }), { code: 'invite_required' });
  const first = await store.invite(), second = await store.invite();
  await store.login({ openid: 'openid-alice-123', inviteCode: first.inviteCode, privacyAccepted: true });
  await assert.rejects(store.login({ openid: 'openid-bob-123', inviteCode: second.inviteCode, privacyAccepted: true }), { code: 'registration_full' });
  assert.ok((await store.read()).invites.some(invite => invite.keySha256 === hash(second.inviteCode)));
  const { send, login } = await fixture(t, { store });
  assert.equal((await login('alice-code-123', undefined, { openid: 'openid-bob-123' })).status, 400);
  assert.equal((await send('/account/v1/login', { method: 'POST', body: { code: 'alice-code-123', privacyAccepted: false } })).status, 400);
});

test('logging in again keeps the existing API key and replaces the previous login session', async t => {
  const { store, login, send } = await fixture(t);
  const first = (await login('alice-code-123', (await store.invite()).inviteCode)).data;
  const second = (await login('alice-code-123')).data;
  assert.equal(second.isNew, false); assert.equal(second.apiKey, undefined); assert.equal(second.account.id, first.account.id);
  assert.equal((await send('/account/v1/me', { token: first.sessionToken })).status, 401);
  assert.equal((await send('/account/v1/me', { token: second.sessionToken })).status, 200);
  assert.equal((await send('/v1/models', { token: first.apiKey })).status, 200);
});

test('reset, revoke and deletion deny old keys without affecting another account or legacy clients', async t => {
  const { store, login, send } = await fixture(t);
  const alice = (await login('alice-code-123', (await store.invite()).inviteCode)).data;
  const bob = (await login('bob-code-123', (await store.invite()).inviteCode)).data;
  const reset = await send('/account/v1/api-key', { method: 'POST', body: {}, token: alice.sessionToken });
  assert.equal(reset.status, 200); assert.notEqual(reset.data.apiKey, alice.apiKey);
  assert.equal((await send('/v1/models', { token: alice.apiKey })).status, 401);
  assert.equal((await send('/v1/models', { token: reset.data.apiKey })).status, 200);
  assert.equal((await send('/v1/models', { token: bob.apiKey })).status, 200);
  const revoke = await send('/account/v1/api-key', { method: 'DELETE', token: alice.sessionToken });
  assert.equal(revoke.data.account.apiKeyConfigured, false);
  assert.equal((await send('/v1/models', { token: reset.data.apiKey })).status, 401);
  assert.equal((await send('/account/v1/me', { method: 'DELETE', token: bob.sessionToken })).status, 200);
  assert.equal((await send('/account/v1/me', { token: bob.sessionToken })).status, 401);
  assert.equal((await send('/v1/models', { token: bob.apiKey })).status, 401);
  assert.equal((await send('/v1/models', { token: legacyKey })).status, 200);
  assert.ok(!(await store.read()).accounts.some(account => account.id === bob.account.id));
});

test('logout and expiry revoke login sessions; administrative disable also removes the API key', async t => {
  let now = 0;
  const store = await storeFixture(t, { clock: () => now, sessionTtlMs: 60_000 });
  const { login, send } = await fixture(t, { store, clock: () => now });
  const alice = (await login('alice-code-123', (await store.invite()).inviteCode)).data;
  assert.equal((await send('/account/v1/logout', { method: 'POST', body: {}, token: alice.sessionToken })).status, 200);
  assert.equal((await send('/account/v1/me', { token: alice.sessionToken })).status, 401);
  assert.equal((await send('/v1/models', { token: alice.apiKey })).status, 200);
  const second = (await login('alice-code-123')).data;
  now = 60_001;
  assert.equal((await send('/account/v1/me', { token: second.sessionToken })).status, 401);
  await store.administer(alice.account.id, 'disable');
  assert.equal((await send('/v1/models', { token: alice.apiKey })).status, 401);
  assert.equal((await login('alice-code-123')).data.error.code, 'account_disabled');
  await store.administer(alice.account.id, 'enable');
  const third = (await login('alice-code-123')).data;
  assert.equal(third.account.apiKeyConfigured, false);
});

test('account endpoints preserve host, browser, authentication and route boundaries', async t => {
  let exchanges = 0;
  const { send } = await fixture(t, { exchangeCode: async () => { exchanges++; return 'openid-fixture-123'; } });
  for (const [path, options, status] of [
    ['/account/v1/login', { method: 'POST', body: { code: 'fixture-code-123', privacyAccepted: true }, headers: { origin: 'https://foreign.example.net' } }, 403],
    ['/account/v1/login', { method: 'POST', body: {}, headers: { host: 'foreign.example.net' } }, 403],
    ['/account/v1/login', { method: 'POST', body: {}, token: legacyKey }, 400],
    ['/account/v1/login', { method: 'POST', body: {}, headers: { 'x-api-key': legacyKey } }, 400],
    ['/account/v1/login', { method: 'POST', body: {}, headers: { cookie: 'session=forged' } }, 400],
    ['/account/v1/login', { method: 'POST', body: {}, headers: { 'content-encoding': 'gzip' } }, 400],
    ['/account/v1/login', { method: 'GET' }, 405],
    ['/account/v1/login?target=https://foreign.example.net', { method: 'POST', body: {} }, 404],
    ['/account/v1/admin', {}, 404],
    ['/account/v1/me', { token: localKey }, 401],
    ['/account/v1/me', { headers: { authorization: ['Bearer ' + 'bfs_' + 'a'.repeat(43), 'Bearer ' + 'bfs_' + 'a'.repeat(43)] } }, 400],
    ['/account/v1/login', { method: 'POST', body: { padding: 'x'.repeat(8192) } }, 413],
  ]) assert.equal((await send(path, options)).status, status);
  assert.equal(exchanges, 0);
});

test('global login limits bound platform exchanges, including failed registrations', async t => {
  let exchanges = 0;
  const { login } = await fixture(t, { exchangeCode: async () => { exchanges++; return 'openid-fixture-123'; } });
  for (let i = 0; i < 30; i++) assert.equal((await login('fixture-code-123')).status, 403);
  const response = await login('fixture-code-123');
  assert.equal(response.status, 429); assert.equal(response.headers['retry-after'], '60'); assert.equal(exchanges, 30);
});

test('private store permission errors fail closed for registered API keys', async t => {
  const { store, login, send } = await fixture(t);
  const alice = (await login('alice-code-123', (await store.invite()).inviteCode)).data;
  await chmod(store.path, 0o644);
  const response = await send('/v1/models', { token: alice.apiKey });
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response.data).includes(store.directory));
  await chmod(store.path, 0o600);
});
