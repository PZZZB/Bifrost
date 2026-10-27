import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WatchaEntitlements, WatchaInsufficientQuota } from '../src/payments/watcha.mjs';
import { EntitlementCredits } from '../src/payments/entitlement-credits.mjs';
import { ClientBilling } from '../src/client-billing.mjs';

const secret = 'offline-watcha-key-never-persisted';
const accountId = randomUUID(), operationId = randomUUID();
const configuration = { apiKey: secret, applicationId: 'app_offline', entitlementId: 'ent_offline', environment: 'sandbox' };
const granted = { access: 'granted', entitlement: { type: 'quota', remaining: 5 }, purchase: { url: 'https://pay.watcha.cn/purchase/offline-ticket' } };
const receipt = { consumed: 5, entitlement: { type: 'quota', remaining: 0 } };

test('Watcha uses a fixed HTTPS origin, stable account UUID and operation ID, with app/environment binding', async () => {
  const calls = [];
  const source = new WatchaEntitlements({ ...configuration, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(url.endsWith('/access') ? granted : receipt);
  } });
  const access = await source.access(accountId);
  assert.equal(access.remaining, 5); assert.equal(access.purchase.url, granted.purchase.url);
  await source.consume(accountId, { points: 5, operationId }); await source.consume(accountId, { points: 5, operationId });
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://pay.watcha.cn/v1/entitlements/')); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, 'Bearer ' + secret);
    const body = JSON.parse(options.body); assert.equal(body.user_id, accountId); assert.equal(body.entitlement_id, configuration.entitlementId);
    assert.equal(options.body.includes(secret), false);
  }
  assert.equal(JSON.parse(calls[1].options.body).idempotency_key, operationId);
  assert.equal(calls[1].options.body, calls[2].options.body);
  assert.notEqual(source.binding, new WatchaEntitlements({ ...configuration, environment: 'live' }).binding);
  assert.equal(JSON.stringify(source).includes(secret), false);
});

test('unknown states, invalid quota and unsafe checkout URLs never become an offer or confirmed debit', async () => {
  for (const data of [
    { ...granted, access: 'paid' }, { ...granted, entitlement: { type: 'permanent', remaining: 5 } },
    { ...granted, entitlement: { type: 'quota', remaining: -1 } },
    { ...granted, entitlement: { type: 'quota', remaining: '5' } },
    { ...granted, purchase: { url: 'https://pay.watcha.cn.attacker.example/collect' } },
    { ...granted, purchase: { url: 'https://user:password@pay.watcha.cn/collect' } },
    { ...granted, purchase: { url: 'javascript:alert(1)' } },
    { access: 'unavailable', reason: { code: 'unknown' }, entitlement: { type: 'quota', remaining: 0 } },
  ]) {
    const source = new WatchaEntitlements({ ...configuration, fetchImpl: async () => Response.json(data) });
    await assert.rejects(source.access(accountId));
  }
  const deepLink = 'alipays://platformapi/startapp?appId=offline-example';
  const source = new WatchaEntitlements({ ...configuration, fetchImpl: async () => Response.json({
    ...granted, purchase: { url: deepLink, qr_code_url: 'https://attacker.example/image' },
  }) });
  assert.deepEqual((await source.access(accountId)).purchase, { url: deepLink });
  const suspended = new WatchaEntitlements({ ...configuration, fetchImpl: async () => Response.json({
    access: 'unavailable', reason: { code: 'purchasing_suspended' }, entitlement: { type: 'quota', remaining: 0 },
  }) });
  assert.equal((await suspended.access(accountId)).remaining, 0);
  const malformed = new WatchaEntitlements({ ...configuration, fetchImpl: async () => Response.json({ ...receipt, consumed: 4 }) });
  await assert.rejects(malformed.consume(accountId, { points: 5, operationId }));
});

test('only explicit insufficient_quota is a definitive rejection; transport errors and redirects remain unknown', async () => {
  const insufficient = new WatchaEntitlements({ ...configuration, fetchImpl: async () =>
    Response.json({ error: { code: 'insufficient_quota' } }, { status: 409 }) });
  await assert.rejects(insufficient.consume(accountId, { points: 5, operationId }), WatchaInsufficientQuota);
  for (const respond of [
    () => Response.json({ error: { code: 'idempotency_conflict' } }, { status: 409 }),
    () => new Response('', { status: 302, headers: { location: 'https://attacker.example/' } }),
    () => new Response('not-json'), () => Response.json({ padding: 'x'.repeat(70_000) }),
    () => { throw new Error(secret + ' private-provider-error'); },
  ]) {
    const source = new WatchaEntitlements({ ...configuration, fetchImpl: async () => respond() });
    await assert.rejects(source.consume(accountId, { points: 5, operationId }), error =>
      !(error instanceof WatchaInsufficientQuota) && !error.message.includes(secret) && error.code === 'payments_unavailable');
  }
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-entitlement-'));
  const alice = randomUUID(), bob = randomUUID(), accounts = new Map([[alice, { enabled: true }], [bob, { enabled: true }]]);
  const access = { publicAccount(id) { if (!accounts.has(id)) throw new Error('Not found'); return accounts.get(id); } };
  const billing = await ClientBilling.open({ path: join(directory, 'billing.json') });
  await billing.configureAccount(alice, { enforceBalance: true }); await billing.configureAccount(bob, { enforceBalance: true });
  const balances = new Map([[alice, 5], [bob, 0]]), receipts = new Map(), calls = [];
  const source = {
    binding: JSON.stringify(['watcha', 'app_offline', 'sandbox', 'ent_offline']),
    async access(id) { return { access: balances.get(id) ? 'granted' : 'purchase_required', remaining: balances.get(id) ?? 0,
      purchase: { url: 'https://pay.watcha.cn/purchase/private-ticket' } }; },
    async consume(id, { points, operationId }) {
      calls.push({ id, points, operationId });
      if (receipts.has(operationId)) {
        const previous = receipts.get(operationId); assert.equal(previous.id, id); assert.equal(previous.points, points); return previous.receipt;
      }
      if ((balances.get(id) ?? 0) < points) throw new WatchaInsufficientQuota();
      balances.set(id, balances.get(id) - points);
      const receipt = { consumed: points, remaining: balances.get(id) }; receipts.set(operationId, { id, points, receipt }); return receipt;
    },
  };
  const options = { path: join(directory, 'credits.json'), access, billing, source, microsPerPoint: 1_000_000 };
  const service = await EntitlementCredits.open(options), services = [service], billings = [billing];
  t.after(async () => { for (const item of services) await item.close(); for (const item of billings) await item.close();
    await rm(directory, { recursive: true, force: true }); });
  return { directory, alice, bob, accounts, access, billing, billings, source, balances, receipts, calls, options, service, services };
}

test('concurrent delivery credits only the stable account once in canonical ClientBilling', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => f.service.sync(f.alice)));
  assert.equal(f.billing.account(f.alice).balanceMicros, 5_000_000); assert.equal(f.billing.account(f.bob).balanceMicros, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.balances.get(f.alice), 0);
  assert.equal(f.billing.history(f.alice).rows.filter(row => row.type === 'balance_adjustment').length, 1);
  assert.equal(f.service.hasPending(f.alice), false);
  const raw = await readFile(f.options.path, 'utf8');
  assert.equal(raw.includes(secret), false); assert.equal(raw.includes('purchase/'), false);
  assert.equal(raw.includes('private-ticket'), false); assert.equal(raw.includes('transactionId'), false);
  await assert.rejects(f.service.sync('alice@example.test')); assert.equal(f.calls.length, 1);
});

test('lost consume responses recover with the original key even when its remaining snapshot is stale', async t => {
  const f = await fixture(t), consume = f.source.consume.bind(f.source);
  f.source.consume = async (...args) => { await consume(...args); throw new Error('Response lost after remote commit'); };
  await assert.rejects(f.service.sync(f.alice));
  assert.equal(f.balances.get(f.alice), 0); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  assert.equal(f.service.status().prepared, 1);
  const originalOperation = f.calls[0].operationId;
  f.balances.set(f.alice, 2); // A later purchase is separate from the old debit.
  f.source.consume = consume; await f.service.close();
  const restarted = await EntitlementCredits.open(f.options); f.services.push(restarted); await restarted.recover();
  assert.equal(f.calls[1].operationId, originalOperation); assert.equal(f.billing.account(f.alice).balanceMicros, 5_000_000);
  assert.equal(f.balances.get(f.alice), 2);
  await restarted.sync(f.alice); assert.notEqual(f.calls.at(-1).operationId, originalOperation);
  assert.equal(f.billing.account(f.alice).balanceMicros, 7_000_000); assert.equal(f.balances.get(f.alice), 0);
});

test('a committed ledger write with lost acknowledgement reopens and replays once at the original conversion rate', async t => {
  const f = await fixture(t), adjust = f.billing.adjustBalance.bind(f.billing);
  f.service.billing = { account: f.billing.account.bind(f.billing), async adjustBalance(...args) { await adjust(...args); throw new Error('Commit acknowledgement lost'); } };
  await assert.rejects(f.service.sync(f.alice)); assert.equal(f.service.status().consumed, 1);
  await f.service.close(); await f.billing.close();
  const billing = await ClientBilling.open({ path: join(f.directory, 'billing.json') }); f.billings.push(billing);
  const restarted = await EntitlementCredits.open({ ...f.options, billing, microsPerPoint: 10_000 }); f.services.push(restarted);
  await Promise.all([restarted.recover(), restarted.recover()]);
  assert.equal(billing.account(f.alice).balanceMicros, 5_000_000);
  assert.equal(billing.history(f.alice).rows.filter(row => row.type === 'balance_adjustment').length, 1);
  assert.equal(f.calls.length, 1); assert.equal(restarted.status().credited, 1);
  await assert.rejects(EntitlementCredits.open({ ...f.options, source: { ...f.source, binding: 'different-live-environment' } }));
});

test('an explicit insufficient result cancels the attempt without a credit, allowing a later fresh operation', async t => {
  const f = await fixture(t), consume = f.source.consume.bind(f.source);
  f.source.consume = async (id, input) => { f.balances.set(id, 0); return consume(id, input); };
  assert.equal((await f.service.sync(f.alice)).deliveredPoints, 0);
  assert.equal(f.service.status().cancelled, 1); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  f.source.consume = consume; f.balances.set(f.alice, 3); await f.service.sync(f.alice);
  assert.notEqual(f.calls[0].operationId, f.calls[1].operationId); assert.equal(f.billing.account(f.alice).balanceMicros, 3_000_000);
});

test('missing identities retain the original delivery for review; disabled originals receive their existing credit', async t => {
  const f = await fixture(t), consume = f.source.consume.bind(f.source);
  f.source.consume = async (...args) => { const result = await consume(...args); f.accounts.delete(f.alice); throw new Error('Reply lost'); };
  await assert.rejects(f.service.sync(f.alice)); await f.service.recover();
  assert.equal(f.service.status().review, 1); assert.equal(f.service.hasPending(f.alice), true);
  assert.equal(f.billing.account(f.bob).balanceMicros, 0); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  f.accounts.set(f.alice, { enabled: false }); f.source.consume = consume; await f.service.recover();
  assert.equal(f.billing.account(f.alice).balanceMicros, 5_000_000); assert.equal(f.accounts.get(f.alice).enabled, false);
  await assert.rejects(f.service.sync(f.alice)); assert.equal(f.calls.length, 2);
});

test('deletion during a successful remote debit holds its receipt without recreating the missing identity', async t => {
  const f = await fixture(t), consume = f.source.consume.bind(f.source);
  f.source.consume = async (...args) => { const result = await consume(...args); f.accounts.delete(f.alice); return result; };
  assert.equal((await f.service.sync(f.alice)).pending, true);
  assert.equal(f.service.status().review, 1); assert.equal(f.balances.get(f.alice), 0);
  assert.equal(f.billing.account(f.alice).balanceMicros, 0); assert.equal(f.billing.account(f.bob).balanceMicros, 0);
});

test('recovery rotates past blocked identities instead of starving later durable receipts', async t => {
  const f = await fixture(t); await f.service.close();
  const accounts = [...Array.from({ length: 20 }, () => randomUUID()), f.alice];
  const deliveries = accounts.map(accountId => ({ id: randomUUID(), accountId, points: 5, unitMicros: 1_000_000,
    creditMicros: 5_000_000, createdAt: '2026-10-27T00:00:00.000Z', status: 'consumed',
    receipt: { consumed: 5, remaining: 0 }, creditedAt: null }));
  await writeFile(f.options.path, JSON.stringify({ version: 1, binding: f.source.binding, deliveries }), { mode: 0o600 });
  const restarted = await EntitlementCredits.open(f.options); f.services.push(restarted);
  await restarted.recover(); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  await restarted.recover(); assert.equal(f.billing.account(f.alice).balanceMicros, 5_000_000);
  assert.equal(restarted.status().review, 20); assert.equal(restarted.status().credited, 1);
});

test('invalid consumption evidence and failed journal writes never create local credit', async t => {
  const f = await fixture(t), consume = f.source.consume.bind(f.source);
  f.source.consume = async (...args) => ({ ...await consume(...args), consumed: 4 });
  await assert.rejects(f.service.sync(f.alice)); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  assert.equal(f.service.status().prepared, 1);
  f.source.consume = consume; await f.service.recover(); assert.equal(f.billing.account(f.alice).balanceMicros, 5_000_000);
  const path = join(f.directory, 'parent-file', 'credits.json');
  const unwritable = await EntitlementCredits.open({ ...f.options, path }); f.services.push(unwritable);
  await writeFile(join(f.directory, 'parent-file'), 'not a directory');
  f.balances.set(f.bob, 2); const before = f.calls.length;
  await assert.rejects(unwritable.sync(f.bob)); assert.equal(f.calls.length, before); assert.equal(f.balances.get(f.bob), 2);
});

test('unmetered accounts, overflow, source changes, unsafe file permissions and corruption fail closed', async t => {
  const f = await fixture(t);
  await f.billing.configureAccount(f.alice, { enforceBalance: false }); await assert.rejects(f.service.sync(f.alice));
  assert.equal(f.calls.length, 0); await f.billing.configureAccount(f.alice, { enforceBalance: true });
  f.balances.set(f.alice, Number.MAX_SAFE_INTEGER); await assert.rejects(f.service.sync(f.alice)); assert.equal(f.calls.length, 0);
  f.balances.set(f.alice, 1); await f.service.sync(f.alice);
  const originalBinding = f.source.binding; f.source.binding = 'changed'; await assert.rejects(f.service.sync(f.bob)); f.source.binding = originalBinding;
  await f.service.close();
  if (process.platform !== 'win32') {
    await chmod(f.options.path, 0o644); await assert.rejects(EntitlementCredits.open(f.options)); await chmod(f.options.path, 0o600);
  }
  await writeFile(f.options.path, '{broken', { mode: 0o600 }); await assert.rejects(EntitlementCredits.open(f.options));
});
