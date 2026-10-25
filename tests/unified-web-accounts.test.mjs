import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { ClientAccess } from '../src/client-access.mjs';
import { ClientBilling } from '../src/client-billing.mjs';
import { ClientAdmin } from '../src/client-admin.mjs';
import { UnifiedWebAccounts } from '../src/unified-web-accounts.mjs';
import { createWebAccounts } from '../src/web-accounts.mjs';
import { createClientServer } from '../src/client-server.mjs';
import { createClientGatewayForwarder, loopbackHttpFetch } from '../src/client-gateway-forwarder.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';

const HOST = 'bifrost.example.test', ORIGIN = `https://${HOST}`, MODEL = 'Claude-sonnet', PASSWORD = 'Offline-only-password-123';
async function fixture(t, { usage = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-unified-'));
  const access = await ClientAccess.open({ path: join(dir, 'access.json'), allowedModelIds: [MODEL], maxAccounts: 2 });
  const billing = await ClientBilling.open({ path: join(dir, 'billing.json') });
  await access.configureRegistration({ mode: 'invite' });
  const store = new UnifiedWebAccounts({ access, billing, checkEmailDomain: async () => 'mx' });
  const webAccounts = createWebAccounts({ store, csrfKey: randomBytes(32).toString('base64url'), publicOrigin: ORIGIN, apiBaseUrl: ORIGIN + '/v1' });
  const models = [{ id: MODEL, channel: 'Claude', enabled: true, available: true }], calls = [];
  const source = async request => {
    calls.push(request);
    return Response.json({ object: 'chat.completion', model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'offline' }, finish_reason: 'stop' }],
      ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) });
  };
  const server = createClientServer({ access, billing, webAccounts, publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    publicBaseUrl: ORIGIN, allowedHosts: [], getModels: () => models, requestChat: source, requestMessages: source,
    requestResponses: () => { throw new Error('Wrong provider'); }, csrfSecret: randomBytes(32).toString('base64url') });
  assert.equal(server.clientEndpoint().portalUrl, ORIGIN + '/account/');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixed = createClientGatewayForwarder({ fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:43159/'));
    return loopbackHttpFetch(url.replace(':43159/', `:${server.address().port}/`), options);
  } });
  const legacyKey = randomBytes(32).toString('hex'), legacyCalls = [];
  const front = createExternalClaudeGateway({ gatewayKey: 'g'.repeat(64), sessionKey: 's'.repeat(64), allowedHosts: [HOST], clientGateway: fixed,
    getClients: () => [{ id: 'legacy', keySha256: createHash('sha256').update(legacyKey).digest('hex'), maxConcurrent: 1, requestsPerMinute: 20 }],
    fetchImpl: async (url, options) => { legacyCalls.push({ url, options }); return Response.json({ object: 'list', data: [] }); } });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((done, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: front.address().port, path, method,
      headers: { host: HOST, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {}
        done({ status: response.statusCode, headers: response.headers, text, data }); });
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  async function register(email) {
    const invite = await access.createInvite({ allowedModels: [MODEL] });
    const initial = await send('/account/web/v1/session'); assert.equal(initial.status, 200, initial.text);
    const csrf = initial.data.csrfToken;
    const cookie = initial.headers['set-cookie'][0].split(';')[0];
    const result = await send('/account/web/v1/register', { method: 'POST', headers: { origin: ORIGIN, cookie, 'x-bifrost-csrf': csrf },
      body: { email, password: PASSWORD, inviteCode: invite.token, privacyAccepted: true } });
    assert.equal(result.status, 200, result.text);
    return { ...result.data, writeHeaders: { origin: ORIGIN, 'x-bifrost-csrf': csrf, cookie: cookie + '; ' + result.headers['set-cookie'][0].split(';')[0] } };
  }
  const admin = new ClientAdmin({ access, billing, getModels: () => models, getEndpoint: () => ({}) });
  t.after(async () => {
    for (const s of [front, server]) { s.closeAllConnections(); await new Promise(done => s.close(done)); }
    await access.close(); await billing.close(); await rm(dir, { recursive: true, force: true });
  });
  return { access, billing, admin, store, send, register, calls, legacyKey, legacyCalls, dir };
}

test('WeChat registration, local admin, API key rotation, limits and metering share one canonical account', async t => {
  const f = await fixture(t), user = await f.register('First@Example.com');
  const snapshot = await f.admin.snapshot(); assert.equal(snapshot.accounts.length, 1);
  const account = snapshot.accounts[0]; assert.equal(account.id, user.account.id); assert.equal(account.username, 'first@example.com');
  assert.equal(account.registration.emailVerified, false); assert.equal(account.registration.emailDomainCheck.method, 'mx');
  const auth = { authorization: `Bearer ${user.apiKey}` };
  assert.deepEqual((await f.send('/v1/models', { headers: auth })).data.data.map(model => model.id), [MODEL]);
  await f.admin.mutate(`/api/client-admin/accounts/${account.id}`, { enabled: false });
  assert.equal((await f.send('/v1/models', { headers: auth })).status, 401);
  assert.equal((await f.send('/account/web/v1/session', { headers: { cookie: user.writeHeaders.cookie } })).data.authenticated, false);
  await f.admin.mutate(`/api/client-admin/accounts/${account.id}`, { enabled: true });
  // Re-login after administrator disable invalidated all sessions.
  const logged = await f.send('/account/web/v1/login', { method: 'POST', headers: user.writeHeaders, body: { username: 'first@example.com', password: PASSWORD } });
  assert.equal(logged.status, 200); user.writeHeaders.cookie = user.writeHeaders.cookie.split('; ')[0] + '; ' + logged.headers['set-cookie'][0].split(';')[0];
  const rotated = await f.send('/account/web/v1/api-key', { method: 'POST', headers: user.writeHeaders, body: {} });
  assert.equal(rotated.status, 200, rotated.text); assert.notEqual(rotated.data.apiKey, user.apiKey);
  assert.equal((await f.send('/v1/models', { headers: auth })).status, 401);
  await f.admin.mutate('/api/client-admin/billing/prices', { model: MODEL, inputRateMicros: 1_000_000, cachedInputRateMicros: 0,
    outputRateMicros: 1_000_000, reserveInputTokens: 10, reserveOutputTokens: 5, enabled: true });
  await f.admin.mutate(`/api/client-admin/accounts/${account.id}/billing`, { enforceBalance: true, tokenLimit: 15 });
  await f.admin.mutate(`/api/client-admin/accounts/${account.id}/balance`, { operationId: randomUUID(), amountMicros: 1000 });
  const body = { model: MODEL, messages: [{ role: 'user', content: 'offline' }] };
  const headers = { authorization: `Bearer ${rotated.data.apiKey}`, 'x-session-id': 'same-client-session' };
  assert.equal((await f.send('/v1/chat/completions', { method: 'POST', headers, body })).status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].scope, account.id);
  const billed = (await f.admin.snapshot()).accounts[0].billing;
  assert.equal(billed.usedTokens, 15); assert.equal(billed.balanceMicros, 985);
  assert.equal((await f.send('/v1/chat/completions', { method: 'POST', headers, body })).status, 429); assert.equal(f.calls.length, 1);
  const saved = await readFile(join(f.dir, 'access.json'), 'utf8');
  for (const secret of [PASSWORD, user.apiKey, rotated.data.apiKey]) assert.equal(saved.includes(secret), false);
});

test('public forwarding excludes administrator routes and preserves the original static key and account scopes', async t => {
  const f = await fixture(t), first = await f.register('one@example.com'), second = await f.register('two@example.com');
  for (const user of [first, second]) {
    const headers = { authorization: `Bearer ${user.apiKey}`, 'x-session-id': 'same' };
    assert.equal((await f.send('/v1/chat/completions', { method: 'POST', headers, body: { model: MODEL, messages: [] } })).status, 200);
    for (const path of ['/api/client-admin', '/api/status', '/portal/api/me', '/v1/messages/count_tokens']) assert.equal((await f.send(path, { headers })).status, 404);
    assert.equal((await f.send('/v1/models', { headers: { ...headers, origin: ORIGIN } })).status, 403);
  }
  assert.notEqual(f.calls[0].scope, f.calls[1].scope);
  assert.equal((await f.send('/v1/models', { headers: { authorization: `Bearer ${f.legacyKey}` } })).status, 200);
  assert.equal(f.legacyCalls.length, 1); assert.equal(f.legacyCalls[0].url, 'http://127.0.0.1:43157/v1/models');
  assert.equal(f.legacyCalls[0].options.headers.get('authorization'), 'Bearer ' + 'g'.repeat(64));
  const deleted = await f.send('/account/web/v1/me', { method: 'DELETE', headers: first.writeHeaders });
  assert.equal(deleted.status, 200); assert.equal((await f.admin.snapshot()).accounts.length, 1);
  assert.equal((await f.send('/v1/models', { headers: { authorization: `Bearer ${first.apiKey}` } })).status, 401);
});

test('missing Claude usage remains unresolved instead of being silently billed as free', async t => {
  const f = await fixture(t, { usage: false }), user = await f.register('meter@example.com');
  const response = await f.send('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${user.apiKey}` }, body: { model: MODEL, messages: [] } });
  assert.equal(response.status, 200); assert.equal(f.billing.account(user.account.id).unresolvedCount, 1);
  assert.equal(f.billing.account(user.account.id).usedTokens, 0);
});

test('email DNS failures leave canonical invitations usable and keep ownership unverified', async t => {
  const f = await fixture(t), invite = await f.access.createInvite();
  f.store.checkEmailDomain = async () => { throw Object.assign(new Error(), { code: 'email_domain_unavailable', status: 503 }); };
  await assert.rejects(f.store.register({ email: 'dns@example.com', password: PASSWORD, inviteCode: invite.token, privacyAccepted: true }));
  assert.equal(f.access.snapshot().invites.find(item => item.id === invite.invite.id).uses, 0);
  assert.equal(f.access.snapshot().accounts.length, 0);
});
