import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { normalizeRemoteAccount, remoteQuotaCard, bifrostQuotaSnapshot } from '../src/bifrost-quotas.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';
import { startServerRemotes } from '../src/runtime/server-remotes.mjs';

const stamp = '2026-11-03T18:00:00.000Z';
const accountId = '71111111-1111-4111-8111-111111111111';
const keyId = '72222222-2222-4222-8222-222222222222';
const apiKey = `bfk_${'Q'.repeat(43)}`;
function payload(patch = {}) {
  return { object: 'account', account: { id: accountId, username: 'remote.owner' },
    key: { id: keyId, expiresAt: '2026-12-03T18:00:00.000Z' },
    billing: { currency: 'CNY', enforceBalance: true, balanceMicros: 12_345_678, reservedMicros: 1_000_001,
      availableMicros: 11_345_677, tokenLimit: 10_000, usedTokens: 2_000, reservedTokens: 300, remainingTokens: 7_700 }, ...patch };
}
const normalize = value => normalizeRemoteAccount(value, { id: 'home', fetchedAt: stamp });
function transport(respond) {
  const requests = [];
  const provider = new BifrostRemote({ id: 'home', baseUrl: 'https://remote.example.invalid:47846/v1', apiKey,
    fetchImpl: async (url, options) => { requests.push({ url: String(url), options }); return respond(url, options); } });
  return { provider, requests };
}

test('remote account cards retain exact available, reserved and token allowance without summing sources', () => {
  const first = normalize(payload());
  assert.equal(first.status, 'ok'); assert.equal(first.authenticated, true); assert.equal(first.identity, 'remote.owner');
  assert.deepEqual(first.wallet, { currency: 'CNY', enforceBalance: true, balanceMicros: 12_345_678,
    reservedMicros: 1_000_001, availableMicros: 11_345_677 });
  assert.deepEqual(first.tokenQuota, { limit: 10_000, used: 2_000, reserved: 300, remaining: 7_700 });
  assert.deepEqual(first.key, { expiresAt: '2026-12-03T18:00:00.000Z' });
  const other = normalizeRemoteAccount(payload({ account: { id: accountId, username: 'other.owner' } }), { id: 'office', fetchedAt: stamp });
  const snapshot = bifrostQuotaSnapshot([first, other], stamp);
  assert.equal(snapshot.status, 'ok'); assert.equal(snapshot.sources.length, 2);
  assert.equal(Object.hasOwn(snapshot, 'wallet'), false); assert.equal(Object.hasOwn(snapshot, 'tokenQuota'), false);
  assert.deepEqual(snapshot.sources.map(card => [card.id, card.identity, card.wallet.availableMicros]),
    [['home', 'remote.owner', 11_345_677], ['office', 'other.owner', 11_345_677]]);
});

test('signed money, zero real balances, disabled enforcement and unset token limits stay distinct', () => {
  const body = payload();
  const negative = normalize({ ...body, billing: { ...body.billing, balanceMicros: -500_000, reservedMicros: 250_000, availableMicros: -750_000 } });
  assert.equal(negative.wallet.availableMicros, -750_000);
  const unrestricted = normalize({ ...body, key: { id: keyId, expiresAt: null }, billing: { ...body.billing,
    enforceBalance: false, balanceMicros: 0, reservedMicros: 0, availableMicros: 0, tokenLimit: null, remainingTokens: null } });
  assert.equal(unrestricted.status, 'ok'); assert.equal(unrestricted.wallet.enforceBalance, false);
  assert.equal(unrestricted.wallet.balanceMicros, 0); assert.equal(unrestricted.tokenQuota.limit, null);
  assert.equal(unrestricted.tokenQuota.remaining, null); assert.equal(unrestricted.key.expiresAt, null);
  const spent = normalize({ ...body, billing: { ...body.billing, tokenLimit: 1000, usedTokens: 3000, remainingTokens: 0 } });
  assert.equal(spent.tokenQuota.remaining, 0);
});

test('missing billing remains unknown and cannot be mistaken for zero or an unlimited wallet', () => {
  const card = normalize(payload({ billing: null }));
  assert.equal(card.status, 'unknown'); assert.equal(card.errorCode, 'no_billing'); assert.equal(card.authenticated, true);
  assert.equal(card.identity, 'remote.owner'); assert.equal(card.wallet, null); assert.equal(card.tokenQuota, null);
  assert.ok(card.key.expiresAt); assert.equal(card.error, null);
  assert.equal(bifrostQuotaSnapshot().status, 'not_connected');
});

test('financial metadata validates exact integer arithmetic, currency and quota consistency', () => {
  const body = payload();
  for (const patch of [
    { currency: 'USD' }, { enforceBalance: 'true' }, { balanceMicros: '12345678' }, { balanceMicros: 1.5 },
    { balanceMicros: Number.MAX_SAFE_INTEGER + 1 }, { reservedMicros: -1 }, { availableMicros: 11_345_678 },
    { tokenLimit: -1 }, { tokenLimit: '10000' }, { usedTokens: 1.1 }, { reservedTokens: Number.MAX_SAFE_INTEGER + 1 },
    { remainingTokens: 10_000 }, { remainingTokens: null }, { tokenLimit: null, remainingTokens: 0 },
  ]) assert.throws(() => normalize({ ...body, billing: { ...body.billing, ...patch } }), TypeError);
  for (const invalid of [null, {}, { ...body, object: 'different' }, { ...body, account: { id: 'not-an-id', username: 'User' } },
    { ...body, account: { id: accountId, username: 'bfk_PRIVATE_TOKEN' } }, { ...body, key: { id: keyId, expiresAt: 'invalid' } },
    { ...body, billing: undefined }]) assert.throws(() => normalize(invalid), TypeError);
});

test('remote metadata rebuilds a whitelist and never publishes credential, ledger, URL or other-key fields', () => {
  const original = payload();
  original.apiKey = 'PRIVATE_ACCOUNT_KEY'; original.ledger = [{ note: 'PRIVATE_LEDGER' }];
  original.account.passwordHash = 'PRIVATE_PASSWORD'; original.key.secret = 'PRIVATE_OTHER_KEY';
  original.billing.headers = { authorization: 'PRIVATE_AUTHORIZATION' };
  original.billing.usageUrl = 'https://private.invalid/?token=PRIVATE_TOKEN';
  const card = normalize(original);
  card.credentials = 'PRIVATE_NEW_METADATA'; card.wallet.private = 'PRIVATE_WALLET_FIELD';
  card.key.secret = 'PRIVATE_DUPLICATE_KEY'; card.notice = 'PRIVATE_PROVIDER_NOTICE'; card.error = 'PRIVATE_PROVIDER_ERROR';
  const snapshot = bifrostQuotaSnapshot([card], stamp), json = JSON.stringify(snapshot);
  assert.doesNotMatch(json, /PRIVATE_|private\.invalid|passwordHash|authorization|credentials|ledger/);
  assert.equal(snapshot.sources[0].identity, 'remote.owner');
  assert.deepEqual(Object.keys(snapshot.sources[0].key), ['expiresAt']);
  const denied = remoteQuotaCard('home', { code: 'unauthorized', identity: 'old.owner', key: { expiresAt: stamp }, authenticated: true });
  assert.equal(denied.authenticated, false); assert.equal(denied.identity, null); assert.equal(denied.key, null);
});

test('bound read-only transport uses exactly one fixed account GET, no catalog, inference, redirect or local credentials', async () => {
  const f = transport(async () => Response.json(payload()));
  const card = await f.provider.accountQuota();
  assert.equal(card.status, 'ok'); assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, 'https://remote.example.invalid:47846/v1/account');
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.redirect, 'manual');
  assert.deepEqual(request.options.headers, { authorization: `Bearer ${apiKey}` });
  assert.equal(request.options.body, undefined); assert.ok(request.options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(card), /bfk_|remote\.example|Bearer/);
  assert.equal(f.provider.status().state, 'not_refreshed', 'An account read must not rewrite catalog state.');
  await f.provider.close();
});

for (const status of [404, 405, 501]) test(`old remote HTTP ${status} returns an unsupported account card without a fabricated balance`, async () => {
  let cancelled = false;
  const f = transport(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }));
  const card = await f.provider.accountQuota();
  assert.equal(card.status, 'unknown'); assert.equal(card.errorCode, 'unsupported'); assert.equal(card.wallet, null);
  assert.equal(card.tokenQuota, null); assert.equal(card.identity, null); assert.match(card.notice, /更新远端/);
  assert.equal(cancelled, true); assert.equal(f.requests.length, 1); await f.provider.close();
});

for (const status of [401, 403, 429, 500, 302]) test(`remote HTTP ${status} cannot expose private error content or become a zero balance`, async () => {
  const f = transport(async () => new Response('PRIVATE_ERROR_TOKEN', { status, headers: { location: 'https://evil.invalid/?key=PRIVATE_TOKEN' } }));
  const card = await f.provider.accountQuota();
  assert.equal(card.status, 'error'); assert.equal(card.authenticated, [401, 403].includes(status) ? false : null);
  assert.equal(card.wallet, null); assert.equal(card.tokenQuota, null); assert.equal(card.identity, null);
  assert.doesNotMatch(JSON.stringify(card), /PRIVATE_|evil\.invalid/); assert.equal(f.requests.length, 1);
  await f.provider.close();
});

test('malformed, non-JSON, oversized and contradictory remote responses never enter the balance view', async () => {
  const invalid = payload(); invalid.billing.availableMicros++;
  for (const respond of [
    () => new Response('{bad PRIVATE_TOKEN', { headers: { 'content-type': 'application/json' } }),
    () => new Response('PRIVATE_HTML', { headers: { 'content-type': 'text/html' } }),
    () => Response.json(invalid),
    () => Response.json({ ...payload(), private: 'x'.repeat(33 * 1024) }),
  ]) {
    const f = transport(respond), card = await f.provider.accountQuota();
    assert.equal(card.status, 'error'); assert.equal(card.errorCode, 'invalid_response');
    assert.equal(card.wallet, null); assert.equal(card.tokenQuota, null); assert.doesNotMatch(JSON.stringify(card), /PRIVATE_|"private"/);
    await f.provider.close();
  }
});

test('metadata transport cancellation and a closed source cannot publish a prior successful balance', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = transport((_url, { signal }) => new Promise((_resolve, reject) => {
    entered(signal); signal.addEventListener('abort', () => reject(new Error('PRIVATE_CANCEL_REASON')), { once: true });
  }));
  const abort = new AbortController(), pending = f.provider.accountQuota({ signal: abort.signal });
  const observed = await started; abort.abort();
  const card = await pending; assert.equal(observed.aborted, true); assert.equal(card.wallet, null); assert.equal(card.status, 'error');
  assert.doesNotMatch(JSON.stringify(card), /PRIVATE_CANCEL_REASON/);
  await f.provider.close();
  const disabled = await f.provider.accountQuota();
  assert.equal(disabled.authenticated, false); assert.equal(disabled.errorCode, 'disabled'); assert.equal(disabled.wallet, null);
  assert.equal(f.requests.length, 1);
});

test('runtime keeps sources separate, isolates an old server, and invalidates bindings when one source closes', async t => {
  const tempRoot = await realpath(tmpdir()), stateDir = await mkdtemp(join(tempRoot, 'bifrost-quota-runtime-'));
  t.after(async () => {
    assert.equal(dirname(stateDir), tempRoot); assert.match(basename(stateDir), /^bifrost-quota-runtime-/);
    await rm(stateDir, { recursive: true, force: true });
  });
  const requests = [], config = { version: 1, sources: ['home', 'office'].map(id => ({ id, kind: 'bifrost-remote',
    baseUrl: `https://${id}.example.invalid/v1`, protocols: ['messages'], credentialRef: randomUUID() })) };
  const runtime = await startServerRemotes({ config, stateDir, secret: 'remote-balance-fixture-secret-'.repeat(3),
    refreshIntervalMs: 3_600_000, loadKey: async () => apiKey,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method || 'GET' });
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'Claude-opus' }] });
      assert.ok(String(url).endsWith('/account')); assert.equal(options.method, 'GET');
      return String(url).includes('office.') ? Response.json({ error: 'PRIVATE_OLD_ERROR' }, { status: 404 }) : Response.json(payload());
    } });
  try {
    await runtime.refresh(); requests.length = 0;
    const binding = runtime.quotaBindingKey(), snapshot = await runtime.accountQuotas();
    assert.equal(snapshot.status, 'partial'); assert.equal(snapshot.sources.length, 2);
    assert.equal(snapshot.sources.find(card => card.id === 'home').wallet.availableMicros, 11_345_677);
    assert.equal(snapshot.sources.find(card => card.id === 'office').wallet, null);
    assert.deepEqual(requests.map(row => row.url).sort(), ['https://home.example.invalid/v1/account', 'https://office.example.invalid/v1/account']);
    assert.doesNotMatch(JSON.stringify(snapshot), /bfk_|PRIVATE_|example\.invalid/);
    await runtime.stopSource('home'); assert.notEqual(runtime.quotaBindingKey(), binding);
    requests.length = 0;
    const disabled = await runtime.accountQuotas();
    assert.equal(disabled.sources.find(card => card.id === 'home').authenticated, false);
    assert.equal(disabled.sources.find(card => card.id === 'home').wallet, null);
    assert.equal(requests.length, 1); assert.ok(requests[0].url.includes('office.'));
    await runtime.close(); requests.length = 0;
    assert.ok((await runtime.accountQuotas()).sources.every(card => card.wallet === null && card.authenticated === false));
    assert.equal(requests.length, 0);
  } finally { await runtime.close(); }
});
