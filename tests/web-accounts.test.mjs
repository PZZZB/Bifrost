import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { initializeWebAccounts, WebAccountStore } from '../src/web-account-store.mjs';
import { createWebAccounts } from '../src/web-accounts.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';

const ORIGIN = 'https://api.example.net:47846';
const PASSWORD = 'A long offline password 123!';
const gatewayKey = 'private-gateway-fixture-'.repeat(3), sessionKey = 'private-namespace-fixture-'.repeat(3);
const legacyKey = 'legacy-key-fixture-'.repeat(3);
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { clock = Date.now, ...settings } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'bifrost-web-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'web'); await initializeWebAccounts(directory);
  const store = new WebAccountStore({ directory, clock, checkEmailDomain: async () => 'mx', ...settings });
  const webAccounts = createWebAccounts({ store, csrfKey: (await readFile(join(directory, 'csrf.key'), 'utf8')).trim(),
    publicOrigin: ORIGIN, apiBaseUrl: ORIGIN + '/v1', clock });
  const sessions = [];
  const server = createExternalClaudeGateway({ gatewayKey, sessionKey, allowedHosts: ['api.example.net:47846', 'fallback.example.net'],
    webAccounts, accountApi: { handle: async (_req, res) => { res.writeHead(200); res.end('{"wechat":true}'); } },
    getClients: async () => [{ id: 'legacy', keySha256: sha(legacyKey), maxConcurrent: 2, requestsPerMinute: 30 }, ...await webAccounts.getClients()],
    fetchImpl: async (_url, { headers }) => { sessions.push(headers.get('x-session-id')); return Response.json({ data: [] }); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  function client() {
    const jar = new Map(); let csrf = '';
    const send = (path, { method = 'GET', body, headers = {}, cookie = true } = {}) => new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { host: 'api.example.net:47846', ...(cookie && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          ...(method === 'GET' || method === 'HEAD' ? {} : { origin: ORIGIN, 'x-bifrost-csrf': csrf }),
          ...(bytes === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }), ...headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          for (const value of response.headers['set-cookie'] ?? []) {
            const [part] = value.split(';'), [name, ...rest] = part.split('=');
            if (rest.join('=')) jar.set(name, rest.join('=')); else jar.delete(name);
          }
          const text = Buffer.concat(chunks).toString('utf8'); let data;
          try { data = JSON.parse(text); } catch {}
          if (data?.csrfToken) csrf = data.csrfToken;
          resolve({ status: response.statusCode, data, text, headers: response.headers });
        });
      });
      request.on('error', reject); request.end(bytes);
    });
    return { send, jar, session: () => send('/account/web/v1/session'),
      register: (email, inviteCode, extra = {}) => send('/account/web/v1/register', { method: 'POST',
        body: { email, password: PASSWORD, inviteCode, privacyAccepted: true, ...extra } }),
      login: (username, password = PASSWORD) => send('/account/web/v1/login', { method: 'POST', body: { username, password } }) };
  }
  return { client, store, sessions };
}

test('web pages are anonymous, have restrictive headers, and tolerate WeChat share tracking parameters', async t => {
  const { client } = await fixture(t); const visitor = client();
  for (const path of ['/account/', '/account/?from=singlemessage&isappinstalled=0', '/account/app.js', '/account/style.css', '/account/privacy']) {
    const response = await visitor.send(path); assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await visitor.send('/register?from=singlemessage')).headers.location, '/account/');
  assert.equal((await visitor.send('/account/v1/login')).data.wechat, true);
  assert.equal((await visitor.send('/account/', { headers: { host: 'fallback.example.net' } })).status, 403);
  assert.equal((await visitor.send('/account/', { headers: { authorization: 'Bearer ' + legacyKey } })).status, 403);
});

test('registration persists only salted passwords and hashes, with a Secure HttpOnly browser session', async t => {
  const { client, store } = await fixture(t); const alice = client();
  const initial = await alice.session(); assert.equal(initial.data.authenticated, false);
  assert.equal(initial.data.registrationMode, 'email_invite'); assert.equal(initial.data.emailVerificationRequired, false);
  const invite = await store.invite();
  const response = await alice.register('Alice@example.test', invite.inviteCode); assert.equal(response.status, 200);
  assert.equal(response.data.account.username, 'alice@example.test'); assert.match(response.data.apiKey, /^bfk_[A-Za-z0-9_-]{43}$/);
  assert.equal(response.data.sessionToken, undefined);
  assert.equal(response.data.account.email, 'alice@example.test'); assert.equal(response.data.account.emailVerified, false);
  assert.equal(response.data.account.emailDomainCheck.method, 'mx');
  for (const value of response.headers['set-cookie']) {
    assert.match(value, /Secure/); assert.match(value, /HttpOnly/); assert.match(value, /SameSite=Strict/); assert.match(value, /Path=\//);
  }
  assert.equal((await alice.session()).data.account.id, response.data.account.id);
  const raw = await readFile(store.path, 'utf8'), cookie = alice.jar.get('__Host-bifrost_session');
  for (const value of [PASSWORD, invite.inviteCode, response.data.apiKey, cookie]) assert.ok(!raw.includes(value));
  assert.equal((await store.read()).accounts[0].passwordHash.algorithm, 'scrypt-131072-8-1');
  assert.equal((await store.clients())[0].keySha256, sha(response.data.apiKey));
});

test('cross-site requests, missing CSRF, spoofed identities and credential headers cannot mutate an account', async t => {
  const { client, store } = await fixture(t); const visitor = client(); await visitor.session();
  const invite = (await store.invite()).inviteCode;
  const body = { email: 'alice@example.test', password: PASSWORD, inviteCode: invite, privacyAccepted: true };
  for (const [headers, status] of [
    [{ origin: 'https://attacker.example.net' }, 403], [{ origin: '' }, 403],
    [{ 'x-bifrost-csrf': 'forged' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'x-api-key': legacyKey }, 403], [{ authorization: 'Bearer ' + legacyKey }, 403],
    [{ 'content-type': 'application/x-www-form-urlencoded' }, 400], [{ 'content-encoding': 'gzip' }, 400],
  ]) assert.equal((await visitor.send('/account/web/v1/register', { method: 'POST', body, headers })).status, status);
  for (const extra of [{ accountId: 'victim' }, { emailVerified: true }, { username: 'victim' }])
    assert.equal((await visitor.register('alice@example.test', invite, extra)).status, 400);
  assert.equal((await visitor.send('/account/web/v1/register?target=http://127.0.0.1', { method: 'POST', body })).status, 404);
  assert.equal((await visitor.send('/account/web/v1/register', { method: 'POST', body: { padding: 'x'.repeat(9000) } })).status, 413);
  assert.equal((await store.read()).accounts.length, 0);
  assert.equal((await store.read()).invites.length, 1);
});

test('a single invitation cannot create two accounts under concurrent requests', async t => {
  const { store } = await fixture(t), inviteCode = (await store.invite()).inviteCode;
  const results = await Promise.allSettled(['alice@example.test', 'bobby@example.test'].map(email => store.register({ email, password: PASSWORD,
    inviteCode, privacyAccepted: true })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'registration_rejected');
  assert.equal((await store.read()).accounts.length, 1); assert.equal((await store.read()).invites.length, 0);
});

test('bad passwords, disabled users, login replacement and browser logout leave API credentials scoped', async t => {
  const { client, store } = await fixture(t); const alice = client(), second = client();
  await alice.session(); await second.session();
  const registered = await alice.register('alice@example.test', (await store.invite()).inviteCode);
  assert.equal((await second.login('alice@example.test', 'incorrect password 123')).status, 401);
  assert.equal((await second.login('missing@example.test', 'incorrect password 123')).status, 401);
  assert.equal((await second.login('ALICE@example.test')).status, 200);
  assert.equal((await alice.session()).data.authenticated, false);
  assert.equal((await second.send('/account/web/v1/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await second.session()).data.authenticated, false);
  assert.equal((await second.send('/v1/models', { headers: { authorization: 'Bearer ' + registered.data.apiKey } })).status, 200);
  await store.administer('alice@example.test', 'disable');
  assert.equal((await second.login('alice@example.test')).data.error.code, 'login_rejected');
  assert.equal((await second.send('/v1/models', { headers: { authorization: 'Bearer ' + registered.data.apiKey } })).status, 401);
});

test('key rotation, revocation and deletion preserve other users, legacy keys and model Origin denial', async t => {
  const { client, store, sessions } = await fixture(t); const alice = client(), bob = client();
  await alice.session(); await bob.session();
  const a = (await alice.register('alice@example.test', (await store.invite()).inviteCode)).data;
  const b = (await bob.register('bobby@example.test', (await store.invite()).inviteCode)).data;
  for (const key of [a.apiKey, b.apiKey, legacyKey]) {
    assert.equal((await alice.send('/v1/models', { headers: { authorization: 'Bearer ' + key, 'x-session-id': 'same' } })).status, 200);
  }
  assert.equal(new Set(sessions).size, 3);
  assert.equal((await alice.send('/v1/models')).status, 401);
  assert.equal((await alice.send('/v1/models', { headers: { authorization: 'Bearer ' + a.apiKey, origin: ORIGIN } })).status, 403);
  assert.equal((await alice.send('/api/admin', { headers: { authorization: 'Bearer ' + a.apiKey } })).status, 404);
  const reset = await alice.send('/account/web/v1/api-key', { method: 'POST', body: {} });
  assert.equal(reset.status, 200); assert.notEqual(reset.data.apiKey, a.apiKey);
  assert.equal((await alice.send('/v1/models', { headers: { authorization: 'Bearer ' + a.apiKey } })).status, 401);
  assert.equal((await alice.send('/account/web/v1/api-key', { method: 'DELETE' })).data.account.apiKeyConfigured, false);
  assert.equal((await alice.send('/v1/models', { headers: { authorization: 'Bearer ' + reset.data.apiKey } })).status, 401);
  assert.equal((await bob.send('/account/web/v1/me', { method: 'DELETE' })).status, 200);
  assert.equal((await bob.send('/v1/models', { headers: { authorization: 'Bearer ' + b.apiKey } })).status, 401);
  assert.equal((await alice.send('/v1/models', { headers: { authorization: 'Bearer ' + legacyKey } })).status, 200);
});

test('registration policy, expiry, corrupt storage and local password recovery fail safely', async t => {
  let now = 1000;
  const { client, store } = await fixture(t, { clock: () => now, maxAccounts: 1, sessionTtlMs: 60_000 });
  await assert.rejects(store.register({ email: 'alice@example.test', password: PASSWORD, privacyAccepted: false }), { code: 'privacy_required' });
  await assert.rejects(store.register({ email: 'alice@example.test', password: 'short', privacyAccepted: true }), { code: 'invalid_password' });
  const alice = client(); await alice.session();
  await alice.register('alice@example.test', (await store.invite()).inviteCode);
  await assert.rejects(store.register({ email: 'bobby@example.test', password: PASSWORD, inviteCode: (await store.invite()).inviteCode,
    privacyAccepted: true }), { code: 'registration_full' });
  now += 60_001; assert.equal((await alice.session()).data.authenticated, false);
  const recovery = await store.administer('alice@example.test', 'reset-password'); assert.ok(recovery.password.length >= 12);
  assert.equal((await store.clients()).length, 0);
  assert.equal((await alice.login('alice@example.test')).status, 401);
  assert.equal((await alice.login('alice@example.test', recovery.password)).status, 200);
  await chmod(store.path, 0o644);
  assert.equal((await alice.session()).status, 503);
  await chmod(store.path, 0o600);
});

test('login attempts are bounded per login identifier and duplicate browser cookies cannot select identities', async t => {
  const { client } = await fixture(t); const visitor = client(); await visitor.session();
  for (let i = 0; i < 5; i++) assert.equal((await visitor.login('missing@example.test')).status, 401);
  assert.equal((await visitor.login('missing@example.test')).status, 429);
  const response = await visitor.send('/account/web/v1/session', { headers: { cookie: '__Host-bifrost_session=a; __Host-bifrost_session=b' } });
  assert.equal(response.status, 400);
});

test('invalid email and temporary domain checks preserve invitations; login never depends on live DNS', async t => {
  let available = false, queries = 0;
  const { client, store } = await fixture(t, { checkEmailDomain: async () => {
    queries++;
    if (!available) throw Object.assign(new Error('DNS unavailable'), { status: 503, code: 'email_domain_unavailable' });
    return 'mx';
  } });
  const visitor = client(); await visitor.session(); const invite = (await store.invite()).inviteCode;
  assert.equal((await visitor.register('not-an-email', invite)).data.error.code, 'invalid_email');
  assert.equal(queries, 0);
  assert.equal((await visitor.register('alice@example.test', 'invalid-invite')).status, 403); assert.equal(queries, 0);
  assert.equal((await visitor.register('alice@example.test', invite)).status, 503);
  assert.equal((await store.read()).invites.length, 1); assert.equal((await store.read()).accounts.length, 0);
  available = true;
  const registered = await visitor.register('Alice@EXAMPLE.TEST', invite); assert.equal(registered.status, 200);
  assert.equal(registered.data.account.emailVerified, false);
  available = false; const previous = queries;
  await visitor.send('/account/web/v1/logout', { method: 'POST', body: {} });
  assert.equal((await visitor.login('ALICE@example.test')).status, 200); assert.equal(queries, previous);
  const id = registered.data.account.id;
  assert.equal((await visitor.register('alice@EXAMPLE.test', (await store.invite()).inviteCode)).status, 403);
  assert.equal((await store.read()).accounts.length, 1); assert.equal((await store.read()).accounts[0].id, id);
  assert.equal((await visitor.send('/account/web/v1/reset-password', { method: 'POST', body: {} })).status, 404);
  await assert.rejects(store.transaction(record => { record.accounts[0].emailVerified = true; }), /Invalid web account store/);
  assert.equal((await store.read()).accounts[0].emailVerified, false);
});

test('legacy username records keep their ID, password, session and API key without being merged with email accounts', async t => {
  const { client, store } = await fixture(t); const old = client(); await old.session();
  const registered = await old.register('owner@example.test', (await store.invite()).inviteCode);
  // Exact pre-email record format, with no new fields or changes to credentials.
  await store.transaction(record => {
    const account = record.accounts[0]; account.username = 'original_owner'; delete account.emailVerified; delete account.emailDomainCheck;
  });
  const session = await old.session(); assert.equal(session.data.account.id, registered.data.account.id);
  assert.equal(session.data.account.email, null);
  const next = client(); await next.session();
  const login = await next.login('ORIGINAL_OWNER'); assert.equal(login.status, 200);
  assert.equal(login.data.account.id, registered.data.account.id);
  assert.equal((await next.send('/v1/models', { headers: { authorization: 'Bearer ' + registered.data.apiKey } })).status, 200);
  const email = await next.register('original_owner@example.test', (await store.invite()).inviteCode);
  assert.equal(email.status, 200); assert.notEqual(email.data.account.id, registered.data.account.id);
  assert.equal((await store.read()).accounts.length, 2);
});
