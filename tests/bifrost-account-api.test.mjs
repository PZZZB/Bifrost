import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientAccess } from '../src/client-access.mjs';
import { ClientBilling } from '../src/client-billing.mjs';
import { createClientServer } from '../src/client-server.mjs';

const DAY = 86_400_000;
const PASSWORD = 'Offline account metadata password 123';
const MODEL = 'claude-codebuddy-opus-5-5';
const HOST = 'account-api.test';
const BILLING_FIELDS = ['currency', 'enforceBalance', 'balanceMicros', 'reservedMicros', 'availableMicros',
  'tokenLimit', 'usedTokens', 'reservedTokens', 'remainingTokens'];
const price = { model: MODEL, enabled: true, inputRateMicros: 1_000_000, cachedInputRateMicros: 0,
  outputRateMicros: 2_000_000, reserveInputTokens: 50, reserveOutputTokens: 25 };

async function fixture(t, { withBilling = true, server: options = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-account-api-'));
  const accessPath = join(directory, 'access.json'), billingPath = join(directory, 'billing.json');
  let at = Date.parse('2026-11-03T00:00:00.000Z'), remembered = 0, modelQueries = 0;
  const access = await ClientAccess.open({ path: accessPath, now: () => at, allowedModelIds: [MODEL] });
  const billing = withBilling ? await ClientBilling.open({ path: billingPath, now: () => at }) : null;
  const rememberKey = access.rememberKey.bind(access);
  access.rememberKey = async value => { remembered++; return rememberKey(value); };
  const calls = [];
  const server = createClientServer({ access, billing,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), publicBaseUrl: `http://${HOST}`, allowedHosts: [],
    getModels: () => { modelQueries++; return [{ id: MODEL, name: 'Offline fixture', channel: 'CodeBuddy', enabled: true, available: true }]; },
    csrfSecret: 'offline-account-api-csrf-secret-'.repeat(3), now: () => at,
    requestResponses: async request => { calls.push(request); return Response.json({ object: 'response', status: 'completed', output: [] }); },
    ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await access.close(); await billing?.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bifrost-account-api-'));
    await rm(directory, { recursive: true, force: true });
  });
  const send = (path = '/v1/account', { method = 'GET', key, headers = {}, body } = {}) => new Promise((done, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: HOST, connection: 'close', ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data;
        try { data = JSON.parse(text); } catch {}
        done({ status: response.statusCode, headers: response.headers, text, data });
      });
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const account = async username => {
    const user = await access.createAccount({ username, password: PASSWORD, allowedModels: [MODEL] });
    return { user, ...await access.createKey(user.id, { name: 'Metadata fixture', expiresInDays: 30 }) };
  };
  return { access, billing, accessPath, billingPath, send, account, calls, advance(ms) { at += ms; },
    get now() { return at; }, get remembered() { return remembered; }, get modelQueries() { return modelQueries; } };
}

test('API Key account reads return only the caller wallet and effective current-Key expiry without side effects', async t => {
  const f = await fixture(t), alice = await f.account('metadata-alice'), bob = await f.account('metadata-bob');
  const extra = await f.access.createKey(alice.user.id, { name: 'PRIVATE_OTHER_KEY', expiresInDays: 7 });
  const deadline = new Date(f.now + 3 * DAY).toISOString();
  await f.access.updateAccount(alice.user.id, { keyExpiresAtLimit: deadline });
  await f.billing.setPrice(price);
  await f.billing.configureAccount(alice.user.id, { enforceBalance: true, tokenLimit: 10_000 });
  await f.billing.adjustBalance(alice.user.id, { operationId: randomUUID(), amountMicros: 1_234_567, note: 'PRIVATE_BILLING_NOTE' });
  await f.billing.adjustBalance(bob.user.id, { operationId: randomUUID(), amountMicros: 9_876_543, note: 'PRIVATE_BOB_NOTE' });
  const settledId = randomUUID();
  await f.billing.reserve({ requestId: settledId, accountId: alice.user.id, keyId: alice.key.id, model: MODEL });
  await f.billing.begin(settledId);
  await f.billing.settle(settledId, { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 0 });
  await f.billing.reserve({ requestId: randomUUID(), accountId: alice.user.id, keyId: alice.key.id, model: MODEL });
  const expectedWallet = f.billing.account(alice.user.id), before = f.billing.snapshot();
  const files = await Promise.all([readFile(f.accessPath), readFile(f.billingPath)]);
  f.billing.history = () => assert.fail('An API Key metadata read must not fetch billing history.');
  const response = await f.send(undefined, { key: alice.secret });
  assert.equal(response.status, 200, response.text); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.data), ['object', 'account', 'key', 'billing']);
  assert.deepEqual(response.data.account, { id: alice.user.id, username: 'metadata-alice' });
  assert.deepEqual(response.data.key, { id: alice.key.id, expiresAt: deadline });
  assert.equal(response.data.object, 'account');
  assert.deepEqual(Object.keys(response.data.billing), BILLING_FIELDS);
  assert.deepEqual(response.data.billing, { currency: 'CNY', enforceBalance: true,
    ...Object.fromEntries(BILLING_FIELDS.filter(field => !['currency', 'enforceBalance'].includes(field)).map(field => [field, expectedWallet[field]])) });
  assert.equal(response.data.billing.balanceMicros, 1_234_507);
  assert.equal(response.data.billing.reservedMicros, 100); assert.equal(response.data.billing.availableMicros, 1_234_407);
  assert.equal(response.data.billing.usedTokens, 50); assert.equal(response.data.billing.reservedTokens, 75);
  assert.equal(response.data.billing.remainingTokens, 9_875);
  for (const secret of [alice.secret, bob.secret, extra.secret, bob.user.id, bob.key.id, extra.key.id, PASSWORD,
    'PRIVATE_BILLING_NOTE', 'PRIVATE_BOB_NOTE', 'PRIVATE_OTHER_KEY', f.accessPath, f.billingPath]) assert.equal(response.text.includes(secret), false);
  assert.doesNotMatch(response.text, /"(?:keys|allowedModels|history|nextBefore|hash|salt|sealedSecret|lastFour|lifetimeTokens|accountId)"/);
  const bobResponse = await f.send(undefined, { key: bob.secret });
  assert.equal(bobResponse.status, 200); assert.equal(bobResponse.data.account.id, bob.user.id);
  assert.equal(bobResponse.data.billing.balanceMicros, 9_876_543);
  assert.equal(bobResponse.data.billing.enforceBalance, false); assert.equal(bobResponse.data.billing.tokenLimit, null);
  assert.equal(bobResponse.data.billing.remainingTokens, null);
  assert.equal(bobResponse.text.includes(alice.user.id), false); assert.equal(bobResponse.text.includes(alice.key.id), false);
  assert.deepEqual(f.billing.snapshot(), before);
  const after = await Promise.all([readFile(f.accessPath), readFile(f.billingPath)]);
  assert.ok(files.every((bytes, index) => bytes.equals(after[index])));
  assert.equal(f.remembered, 0); assert.equal(f.calls.length, 0); assert.equal(f.modelQueries, 0);
});

test('an absent billing service stays null and does not invent zero or unlimited allowance', async t => {
  const f = await fixture(t, { withBilling: false }), user = await f.account('unmetered-metadata');
  const response = await f.send(undefined, { key: user.secret });
  assert.equal(response.status, 200, response.text); assert.equal(response.data.billing, null);
  assert.deepEqual(response.data.account, { id: user.user.id, username: 'unmetered-metadata' });
  assert.deepEqual(response.data.key, { id: user.key.id, expiresAt: user.key.effectiveExpiresAt });
  assert.doesNotMatch(response.text, /balanceMicros|tokenLimit|remainingTokens/);
  assert.equal(f.remembered, 0); assert.equal(f.calls.length, 0); assert.equal(f.modelQueries, 0);
});

test('overrun debt remains a signed balance and is never clamped to zero by the metadata API', async t => {
  const f = await fixture(t), user = await f.account('metadata-overrun');
  await f.billing.setPrice(price); await f.billing.configureAccount(user.user.id, { enforceBalance: true });
  await f.billing.adjustBalance(user.user.id, { operationId: randomUUID(), amountMicros: 100 });
  const requestId = randomUUID();
  await f.billing.reserve({ requestId, accountId: user.user.id, keyId: user.key.id, model: MODEL });
  await f.billing.begin(requestId);
  await f.billing.settle(requestId, { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cachedInputTokens: 0 });
  const response = await f.send(undefined, { key: user.secret });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.data.billing.balanceMicros, -920); assert.equal(response.data.billing.availableMicros, -920);
  assert.equal(response.data.billing.reservedMicros, 0); assert.equal(response.data.billing.remainingTokens, null);
  assert.equal(f.calls.length, 0); assert.equal(f.remembered, 0);
});

test('account metadata rejects arbitrary account selectors, writes, browser origins and session credentials', async t => {
  let draining = false;
  const f = await fixture(t, { withBilling: false, server: { isDraining: () => draining } });
  const user = await f.account('metadata-boundary'), other = await f.account('metadata-other');
  for (const path of [`/v1/account?accountId=${other.user.id}`, `/v1/account?keyId=${other.key.id}`, '/v1/account?history=true']) {
    const result = await f.send(path, { key: user.secret });
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'client_account_query_unsupported');
    assert.equal(result.text.includes(other.user.id), false); assert.equal(result.text.includes(other.key.id), false);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.equal((await f.send(undefined, { key: user.secret, method })).status, 405);
  }
  for (const origin of [`http://${HOST}`, 'https://other.invalid', 'null']) {
    const result = await f.send(undefined, { key: user.secret, headers: { origin } });
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'client_origin_rejected');
  }
  const login = await f.access.login({ username: user.user.username, password: PASSWORD });
  for (const options of [{}, { key: 'bfk_invalid' }, { key: login.sessionToken },
    { headers: { cookie: `bifrost_user_session=${login.sessionToken}` } },
    { key: user.secret, headers: { 'x-api-key': other.secret } }]) {
    assert.equal((await f.send(undefined, options)).status, 401);
  }
  assert.equal((await f.send(undefined, { key: user.secret, headers: { host: 'other.invalid' } })).status, 403);
  assert.equal((await f.send('/v1/account/', { key: user.secret })).status, 404);
  assert.equal((await f.send(`/v1/account/${other.user.id}`, { key: user.secret })).status, 404);
  draining = true;
  assert.equal((await f.send(undefined, { key: user.secret })).status, 200, 'Read-only wallet metadata remains available during a drain.');
  assert.equal(f.calls.length, 0); assert.equal(f.remembered, 0); assert.equal(f.modelQueries, 0);
});

test('disabled, revoked and expired keys or accounts cannot read a prior wallet', async t => {
  const f = await fixture(t), user = await f.account('metadata-key-status');
  await f.billing.adjustBalance(user.user.id, { operationId: randomUUID(), amountMicros: 1_234_567 });
  const denied = async key => {
    const result = await f.send(undefined, { key });
    assert.equal(result.status, 401); assert.equal(result.data.error.code, 'client_key_invalid');
    assert.doesNotMatch(result.text, /1_?234_?567|balanceMicros|metadata-key-status/);
  };
  await f.access.updateKey(user.user.id, user.key.id, { enabled: false }); await denied(user.secret);
  await f.access.updateKey(user.user.id, user.key.id, { enabled: true });
  assert.equal((await f.send(undefined, { key: user.secret })).status, 200);
  await f.access.updateAccount(user.user.id, { enabled: false }); await denied(user.secret);
  await f.access.updateAccount(user.user.id, { enabled: true });
  await f.access.revokeKey(user.user.id, user.key.id); await denied(user.secret);
  const expiring = await f.access.createKey(user.user.id, { expiresInDays: 1 });
  f.advance(DAY); await denied(expiring.secret);
  const limited = await f.access.createKey(user.user.id, { expiresInDays: 30 });
  await f.access.updateAccount(user.user.id, { keyExpiresAtLimit: new Date(f.now + DAY).toISOString() });
  f.advance(DAY); await denied(limited.secret);
  assert.equal(f.calls.length, 0); assert.equal(f.remembered, 0); assert.equal(f.modelQueries, 0);
});

test('account metadata rate limits are per account, include all its keys, and do not charge inference', async t => {
  const f = await fixture(t, { withBilling: false }), alice = await f.account('metadata-rate-alice'), bob = await f.account('metadata-rate-bob');
  for (let index = 0; index < 60; index++) assert.equal((await f.send(undefined, { key: alice.secret })).status, 200);
  const blocked = await f.send(undefined, { key: alice.secret });
  assert.equal(blocked.status, 429); assert.equal(blocked.data.error.code, 'client_rate_limited');
  const another = await f.access.createKey(alice.user.id, { name: 'Same account limit' });
  assert.equal((await f.send(undefined, { key: another.secret })).status, 429);
  assert.equal((await f.send(undefined, { key: bob.secret })).status, 200);
  f.advance(60_000); assert.equal((await f.send(undefined, { key: alice.secret })).status, 200);
  assert.equal(f.remembered, 0); assert.equal(f.calls.length, 0); assert.equal(f.modelQueries, 0);
});

test('wallet response projection does not leak injected private fields or another account record', async t => {
  let wallet;
  const billing = { account: () => wallet, history: () => assert.fail('No history read is permitted.') };
  const f = await fixture(t, { withBilling: false, server: { billing } }), user = await f.account('metadata-projection');
  wallet = { accountId: user.user.id, enforceBalance: false, balanceMicros: 0, reservedMicros: 0, availableMicros: 0,
    tokenLimit: null, usedTokens: 0, reservedTokens: 0, remainingTokens: null,
    PRIVATE_TOKEN: 'PRIVATE_CREDENTIAL', history: ['PRIVATE_LEDGER'], prices: ['PRIVATE_PRICING'] };
  const response = await f.send(undefined, { key: user.secret });
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(response.data.billing), BILLING_FIELDS);
  assert.doesNotMatch(response.text, /PRIVATE_/);
  wallet.accountId = randomUUID();
  const wrongAccount = await f.send(undefined, { key: user.secret });
  assert.equal(wrongAccount.status, 503); assert.equal(wrongAccount.data.error.code, 'client_billing_unavailable');
  assert.equal(wrongAccount.text.includes(wallet.accountId), false);
  wallet = null;
  assert.equal((await f.send(undefined, { key: user.secret })).status, 503, 'A configured but broken ledger is not an absent billing service.');
  assert.equal(f.remembered, 0); assert.equal(f.calls.length, 0);
});
