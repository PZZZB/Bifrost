import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientBilling } from '../src/client-billing.mjs';

const MODEL = 'claude-codebuddy-opus-5-5';
const PRICE = { model: MODEL, inputRateMicros: 2_000_000, cachedInputRateMicros: 500_000, outputRateMicros: 4_000_000,
  reserveInputTokens: 100, reserveOutputTokens: 20, enabled: true };
const USAGE = { inputTokens: 80, cachedInputTokens: 20, outputTokens: 10, totalTokens: 90 };
const code = (status, value) => cause => cause.status === status && cause.code === value;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-billing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'client-billing.json');
  let time = Date.parse('2026-10-24T10:00:00.000Z');
  const options = { path, now: () => time }, billing = await ClientBilling.open(options);
  const accountId = randomUUID(), keyId = randomUUID();
  const reserve = (changes = {}) => billing.reserve({ accountId, keyId, model: MODEL, requestId: randomUUID(), ...changes });
  const credit = (amountMicros = 1000, changes = {}) => billing.adjustBalance(accountId, { operationId: randomUUID(), amountMicros, ...changes });
  return { billing, path, directory, options, accountId, keyId, reserve, credit, advance: value => { time += value; } };
}

test('legacy users default to metering only, with no prices or automatic debt', async t => {
  const { billing, accountId, reserve, path } = await fixture(t);
  assert.deepEqual(billing.snapshot(), { revision: 0, currency: 'CNY', prices: [], accounts: [], recent: [], unresolved: [], unresolvedNextBefore: null });
  assert.deepEqual(billing.account(accountId), { accountId, enforceBalance: false, balanceMicros: 0, reservedMicros: 0, reservedTokens: 0,
    pendingCount: 0, unresolvedCount: 0, accountingBlocked: false, availableMicros: 0, tokenLimit: null, usedTokens: 0, lifetimeTokens: 0, remainingTokens: null });
  const request = await reserve();
  await billing.begin(request.requestId);
  const settled = await billing.settle(request.requestId, USAGE);
  assert.equal(settled.charged, false); assert.equal(settled.price, null); assert.equal(settled.amountMicros, 0);
  assert.equal(billing.account(accountId).usedTokens, 90); assert.equal(billing.account(accountId).balanceMicros, 0);
  const stored = await readFile(path, 'utf8');
  assert.equal(stored.includes('password'), false); assert.equal(stored.includes('Bearer'), false);
});

test('configured prices still do not charge a user until balance enforcement is enabled', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit();
  const request = await reserve();
  assert.equal(billing.account(accountId).reservedMicros, 0); assert.equal(billing.account(accountId).reservedTokens, 120);
  await billing.configureAccount(accountId, { enforceBalance: true });
  const settled = await billing.settle(request.requestId, USAGE);
  assert.equal(settled.charged, false); assert.equal(settled.amountMicros, 0); assert.equal(billing.account(accountId).balanceMicros, 1000);
});

test('charged requests reserve atomically, bill cached input separately, and release unused hold', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true, tokenLimit: 200 });
  const request = await reserve();
  assert.equal(billing.account(accountId).reservedMicros, 280); assert.equal(billing.account(accountId).availableMicros, 720);
  assert.equal(billing.account(accountId).remainingTokens, 80);
  await billing.begin(request.requestId);
  const settled = await billing.settle(request.requestId, USAGE);
  assert.equal(settled.amountMicros, 170); assert.equal(settled.reservedMicros, 280);
  const account = billing.account(accountId);
  assert.equal(account.balanceMicros, 830); assert.equal(account.reservedMicros, 0); assert.equal(account.reservedTokens, 0);
  assert.equal(account.usedTokens, 90); assert.equal(account.remainingTokens, 110);
  const row = billing.history(accountId).rows.find(item => item.type === 'settled');
  assert.equal(row.amountMicros, -170); assert.equal(row.balanceMicros, 830);
});

test('BigInt prices round the entire request once and preserve precision above floating products', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice({ ...PRICE, inputRateMicros: 9_007_199_254_740_001, cachedInputRateMicros: 9_007_199_254_740_001,
    outputRateMicros: 1, reserveInputTokens: 1, reserveOutputTokens: 1 });
  await credit(Number.MAX_SAFE_INTEGER); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  const result = await billing.settle(request.requestId, { inputTokens: 999_999, outputTokens: 1 });
  const expected = Number((999_999n * 9_007_199_254_740_001n + 1n + 999_999n) / 1_000_000n);
  assert.equal(result.amountMicros, expected); assert.equal(billing.account(accountId).balanceMicros, Number.MAX_SAFE_INTEGER - expected);
});

test('rounding cache and ordinary input independently would overcharge, so only final sum is rounded', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice({ ...PRICE, inputRateMicros: 1, cachedInputRateMicros: 1, outputRateMicros: 1 });
  await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  assert.equal((await billing.settle(request.requestId, { inputTokens: 2, cachedInputTokens: 1, outputTokens: 1 })).amountMicros, 1);
});

test('hold uses the larger cached or ordinary input rate and exact fee uses the price at acceptance', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice({ ...PRICE, cachedInputRateMicros: 5_000_000 }); await credit();
  await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve(); assert.equal(billing.account(accountId).reservedMicros, 580);
  await billing.setPrice({ ...PRICE, inputRateMicros: 0, cachedInputRateMicros: 0, outputRateMicros: 0 });
  await billing.configureAccount(accountId, { enforceBalance: false });
  assert.equal((await billing.settle(request.requestId, USAGE)).amountMicros, 260);
  assert.equal(billing.account(accountId).balanceMicros, 740);
});

test('explicit zero rates are free but still require positive reservation tokens and retain quota checks', async t => {
  const { billing, accountId, reserve } = await fixture(t);
  await billing.setPrice({ ...PRICE, inputRateMicros: 0, cachedInputRateMicros: 0, outputRateMicros: 0 });
  await billing.configureAccount(accountId, { enforceBalance: true, tokenLimit: 120 });
  const request = await reserve(); assert.equal(billing.account(accountId).availableMicros, 0);
  await assert.rejects(reserve(), code(429, 'client_billing_quota_exhausted'));
  assert.equal((await billing.settle(request.requestId, USAGE)).amountMicros, 0);
});

test('missing or disabled prices reject restricted users and leave unrestricted metering available', async t => {
  const { billing, accountId, reserve } = await fixture(t);
  await billing.configureAccount(accountId, { tokenLimit: 10000 });
  await assert.rejects(reserve(), code(503, 'client_billing_price_missing'));
  await billing.configureAccount(accountId, { tokenLimit: null, enforceBalance: true });
  await assert.rejects(reserve(), code(503, 'client_billing_price_missing'));
  await billing.setPrice({ ...PRICE, enabled: false });
  await assert.rejects(reserve(), code(503, 'client_billing_price_missing'));
  await billing.configureAccount(accountId, { enforceBalance: false });
  const request = await reserve(); await billing.settle(request.requestId, USAGE);
  assert.equal(billing.account(accountId).usedTokens, 90);
});

test('simultaneous reservations cannot spend the same money or token quota twice', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(300); await billing.configureAccount(accountId, { enforceBalance: true });
  const money = await Promise.allSettled([reserve(), reserve()]);
  assert.equal(money.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(money.find(result => result.status === 'rejected').reason.code, 'client_billing_balance_exhausted');
  await billing.release(money.find(result => result.status === 'fulfilled').value.requestId);
  await billing.configureAccount(accountId, { enforceBalance: false, tokenLimit: 120 });
  const tokens = await Promise.allSettled([reserve(), reserve()]);
  assert.equal(tokens.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(tokens.find(result => result.status === 'rejected').reason.code, 'client_billing_quota_exhausted');
});

test('balance adjustment idempotency persists, rejects operation collisions, and cannot consume holds', async t => {
  const { billing, accountId, reserve, credit, options } = await fixture(t);
  const operationId = randomUUID();
  await credit(1000, { operationId, note: '人工充值' });
  await credit(1000, { operationId, note: '人工充值' });
  assert.equal(billing.account(accountId).balanceMicros, 1000);
  await assert.rejects(credit(999, { operationId, note: '人工充值' }), code(409, 'client_billing_operation_conflict'));
  await assert.rejects(billing.adjustBalance(randomUUID(), { operationId, amountMicros: 1000, note: '人工充值' }), code(409, 'client_billing_operation_conflict'));
  await billing.setPrice(PRICE); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  await assert.rejects(credit(-721), code(409, 'client_billing_balance_reserved'));
  await credit(-720); assert.equal(billing.account(accountId).availableMicros, 0);
  await billing.release(request.requestId); await billing.close();
  const reopened = await ClientBilling.open(options);
  await reopened.adjustBalance(accountId, { operationId, amountMicros: 1000, note: '人工充值' });
  assert.equal(reopened.account(accountId).balanceMicros, 280);
});

test('settlement and rejection are idempotent without double charging or duplicate journal rows', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  await billing.settle(request.requestId, USAGE);
  const revision = billing.snapshot().revision;
  await billing.settle(request.requestId, USAGE); assert.equal(billing.snapshot().revision, revision);
  await assert.rejects(billing.settle(request.requestId, { ...USAGE, outputTokens: 11, totalTokens: 91 }), code(409, 'client_billing_request_final'));
  await assert.rejects(billing.reject(request.requestId), code(409, 'client_billing_request_final'));
  const rejected = await reserve(); await billing.begin(rejected.requestId);
  assert.equal((await billing.reject(rejected.requestId)).reason, 'upstream_rejected');
  const rejectedRevision = billing.snapshot().revision; await billing.reject(rejected.requestId);
  assert.equal(billing.snapshot().revision, rejectedRevision); assert.equal(billing.account(accountId).balanceMicros, 830);
});

test('actual usage beyond a reservation is retained and can create debt or exceed token quota', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(280); await billing.configureAccount(accountId, { enforceBalance: true, tokenLimit: 120 });
  const request = await reserve();
  await billing.settle(request.requestId, { inputTokens: 1000, outputTokens: 100 });
  const account = billing.account(accountId);
  assert.equal(account.balanceMicros, -2120); assert.equal(account.availableMicros, -2120);
  assert.equal(account.usedTokens, 1100); assert.equal(account.remainingTokens, 0);
  await assert.rejects(reserve(), code(402, 'client_billing_balance_exhausted'));
  await credit(100); assert.equal(billing.account(accountId).balanceMicros, -2020);
});

test('missing usage preserves holds, forbids automatic release after begin, and requires explicit resolution', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve(); await billing.begin(request.requestId);
  await assert.rejects(billing.release(request.requestId), code(409, 'client_billing_already_started'));
  await billing.markUnresolved(request.requestId, { reason: 'upstream_error' });
  assert.equal(billing.account(accountId).unresolvedCount, 1); assert.equal(billing.account(accountId).reservedMicros, 280);
  await assert.rejects(billing.settle(request.requestId, USAGE), code(409, 'client_billing_request_final'));
  const operationId = randomUUID();
  const settled = await billing.resolve(request.requestId, { operationId, action: 'settle', usage: USAGE });
  assert.equal(settled.reason, 'admin_settle'); assert.equal(settled.amountMicros, 170);
  const revision = billing.snapshot().revision;
  await billing.resolve(request.requestId, { operationId, action: 'settle', usage: USAGE });
  assert.equal(billing.snapshot().revision, revision);
  await assert.rejects(billing.resolve(request.requestId, { operationId, action: 'release' }), code(409, 'client_billing_operation_conflict'));
  assert.equal(billing.account(accountId).unresolvedCount, 0);
});

test('administrator resolution can release an unknown request but cannot discard already observed usage', async t => {
  const { billing, accountId, reserve } = await fixture(t);
  const request = await reserve();
  await assert.rejects(billing.resolve(request.requestId, { operationId: randomUUID(), action: 'release' }), code(409, 'client_billing_not_unresolved'));
  await billing.markUnresolved(request.requestId);
  await billing.resolve(request.requestId, { operationId: randomUUID(), action: 'release' });
  assert.equal(billing.account(accountId).reservedTokens, 0);
  await billing.setPrice({ ...PRICE, inputRateMicros: Number.MAX_SAFE_INTEGER, cachedInputRateMicros: Number.MAX_SAFE_INTEGER, outputRateMicros: 0,
    reserveInputTokens: 1, reserveOutputTokens: 1 });
  await billing.adjustBalance(accountId, { operationId: randomUUID(), amountMicros: Number.MAX_SAFE_INTEGER });
  await billing.configureAccount(accountId, { enforceBalance: true });
  const overflow = await reserve();
  await assert.rejects(billing.settle(overflow.requestId, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }), code(503, 'client_billing_overflow'));
  assert.equal(billing.account(accountId).accountingBlocked, true);
  const row = billing.history(accountId).rows[0]; assert.equal(row.usage.inputTokens, Number.MAX_SAFE_INTEGER);
  await assert.rejects(reserve(), code(503, 'client_billing_overflow'));
  await assert.rejects(billing.reject(overflow.requestId), code(409, 'client_billing_request_final'));
  await assert.rejects(billing.resolve(overflow.requestId, { operationId: randomUUID(), action: 'release' }), code(409, 'client_billing_usage_conflict'));
});

test('crash recovery persists unresolved status without refunding an accepted hold', async t => {
  const { billing, accountId, reserve, credit, options, path } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const first = await reserve(), second = await reserve(); await billing.begin(second.requestId);
  // This deliberately opens a second read/recovery instance only after the first writer is idle.
  const recovered = await ClientBilling.open(options);
  assert.equal(recovered.account(accountId).unresolvedCount, 2); assert.equal(recovered.account(accountId).reservedMicros, 560);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  for (const requestId of [first.requestId, second.requestId]) {
    const request = stored.requests.find(item => item.requestId === requestId);
    assert.equal(request.status, 'unresolved'); assert.equal(request.reason, 'process_restart');
  }
  const revision = recovered.snapshot().revision;
  const again = await ClientBilling.open(options); assert.equal(again.snapshot().revision, revision);
});

test('quota resets retain lifetime usage and cannot run while a request remains unresolved', async t => {
  const { billing, accountId, reserve } = await fixture(t);
  await billing.setPrice(PRICE); await billing.configureAccount(accountId, { tokenLimit: 200 });
  const first = await reserve(); await billing.settle(first.requestId, USAGE);
  await billing.configureAccount(accountId, { resetQuota: true, tokenLimit: 150 });
  assert.equal(billing.account(accountId).usedTokens, 0); assert.equal(billing.account(accountId).lifetimeTokens, 90);
  const second = await reserve(); await billing.markUnresolved(second.requestId);
  await assert.rejects(billing.configureAccount(accountId, { resetQuota: true }), code(409, 'client_billing_pending'));
  await billing.resolve(second.requestId, { operationId: randomUUID(), action: 'settle', usage: USAGE });
  assert.equal(billing.account(accountId).usedTokens, 90); assert.equal(billing.account(accountId).lifetimeTokens, 180);
});

test('cache writes and reasoning counts never get added twice, and unknown cache split uses ordinary input price', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  const result = await billing.settle(request.requestId, { inputTokens: 80, cachedInputTokens: null, outputTokens: 10,
    totalTokens: 90, cacheWriteTokens: 60, reasoningTokens: 8 });
  assert.equal(result.amountMicros, 200); assert.equal(billing.account(accountId).usedTokens, 90);
});

test('history is scoped, bounded, paginated by immutable row id, and returned data is detached', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await credit(100); await credit(100); await credit(100);
  const other = randomUUID(); await billing.adjustBalance(other, { operationId: randomUUID(), amountMicros: 1, note: 'private other note' });
  const first = billing.history(accountId, { limit: 2 });
  assert.equal(first.rows.length, 2); assert.equal(typeof first.nextBefore, 'string');
  const last = billing.history(accountId, { limit: 2, before: first.nextBefore });
  assert.equal(last.rows.length, 1); assert.equal(last.nextBefore, null);
  assert.equal(new Set([...first.rows, ...last.rows].map(row => row.id)).size, 3);
  assert.equal(JSON.stringify(first).includes('private other note'), false);
  await assert.rejects(async () => billing.history(accountId, { before: billing.history(other).rows[0].id }), code(400, 'invalid_client_billing_cursor'));
  first.rows[0].amountMicros = 999999;
  const snapshot = billing.snapshot(); snapshot.accounts[0].balanceMicros = 0;
  assert.equal(billing.account(accountId).balanceMicros, 300);
  const request = await reserve(); await billing.release(request.requestId);
  assert.equal(billing.history(accountId).rows[0].type, 'released');
});

test('unknown request ids and reused ids across users or terminal calls fail closed', async t => {
  const { billing, reserve } = await fixture(t);
  const requestId = randomUUID(); await reserve({ requestId }); await reserve({ requestId });
  await assert.rejects(reserve({ requestId, accountId: randomUUID() }), code(409, 'client_billing_request_conflict'));
  await billing.release(requestId); await assert.rejects(reserve({ requestId }), code(409, 'client_billing_request_conflict'));
  await assert.rejects(billing.begin(randomUUID()), code(404, 'client_billing_request_not_found'));
});

test('raw error strings, prompts, credentials, getters, and extra fields never become ledger metadata', async t => {
  const { billing, reserve, credit, accountId } = await fixture(t);
  const request = await reserve();
  await billing.markUnresolved(request.requestId, { reason: 'secret provider response text' });
  assert.equal(billing.history(accountId).rows[0].reason, 'other');
  await assert.rejects(credit(1, { note: 'Bearer bfk_' + 'x'.repeat(43) }));
  await assert.rejects(billing.setPrice({ ...PRICE, password: 'private' }));
  await assert.rejects(billing.setPrice({ ...PRICE, model: 'Cursor-sk-' + 'x'.repeat(24) }));
  await assert.rejects(billing.configureAccount(accountId, { get tokenLimit() { throw new Error('must not run'); } }));
  await assert.rejects(billing.resolve(request.requestId, { operationId: randomUUID(), action: 'release', prompt: 'private' }));
  assert.equal(JSON.stringify(billing.snapshot()).includes('secret provider response'), false);
});

test('invalid numbers, incomplete usage, inconsistent totals, and invalid prices do not change accounting', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  for (const amount of [0, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(credit(amount));
  for (const changes of [{ inputRateMicros: -1 }, { reserveInputTokens: 0, reserveOutputTokens: 0 }, { enabled: 1 }, { outputRateMicros: 0.1 }]) {
    await assert.rejects(billing.setPrice({ ...PRICE, ...changes }));
  }
  const request = await reserve(), revision = billing.snapshot().revision;
  for (const usage of [null, {}, { inputTokens: 1 }, { inputTokens: 1, outputTokens: -1 }, { ...USAGE, totalTokens: 91 },
    { ...USAGE, cachedInputTokens: 81 }, { ...USAGE, cacheWriteTokens: 81 }, { ...USAGE, cacheWriteTokens: 61 },
    { ...USAGE, reasoningTokens: 11 }, { ...USAGE, extra: 'x' }]) await assert.rejects(billing.settle(request.requestId, usage));
  assert.equal(billing.snapshot().revision, revision); assert.equal(billing.account(accountId).usedTokens, 0);
});

test('failed durable replacement does not publish a reservation or adjustment', async t => {
  const { billing, path, reserve, credit, accountId } = await fixture(t);
  await credit(1000); const revision = billing.snapshot().revision;
  await rename(path, path + '.saved'); await mkdir(path);
  await assert.rejects(reserve(), code(503, 'client_billing_write_failed'));
  await assert.rejects(credit(100), code(503, 'client_billing_write_failed'));
  assert.equal(billing.account(accountId).pendingCount, 0); assert.equal(billing.account(accountId).balanceMicros, 1000);
  assert.equal(billing.snapshot().revision, revision);
  await rm(path, { recursive: true }); await rename(path + '.saved', path);
  await credit(1); assert.equal(billing.account(accountId).balanceMicros, 1001);
});

test('corrupt files and changed financial totals fail closed instead of rebuilding missing balances', async t => {
  const { billing, options, path, accountId, credit, reserve } = await fixture(t);
  await credit(1000); const request = await reserve(); await billing.settle(request.requestId, USAGE); await billing.close();
  const good = await readFile(path, 'utf8');
  for (const contents of ['not json', '{}', JSON.stringify({ ...JSON.parse(good), version: 2 })]) {
    await writeFile(path, contents); await assert.rejects(ClientBilling.open(options), code(503, 'client_billing_unavailable'));
  }
  const balance = JSON.parse(good); balance.accounts.find(account => account.accountId === accountId).balanceMicros++;
  await writeFile(path, JSON.stringify(balance)); await assert.rejects(ClientBilling.open(options), code(503, 'client_billing_unavailable'));
  const usage = JSON.parse(good); usage.accounts[0].lifetimeTokens++;
  await writeFile(path, JSON.stringify(usage)); await assert.rejects(ClientBilling.open(options), code(503, 'client_billing_unavailable'));
  await writeFile(path, good); assert.equal((await ClientBilling.open(options)).account(accountId).balanceMicros, 1000);
});

test('symlinks are rejected on both load and commit', async t => {
  const { billing, path, options, directory, credit } = await fixture(t);
  const target = join(directory, 'outside.json'); await writeFile(target, '{}');
  try { await symlink(target, path); } catch (cause) { if (['EPERM', 'EACCES'].includes(cause.code)) return; throw cause; }
  await assert.rejects(ClientBilling.open(options), code(503, 'client_billing_unavailable'));
  await assert.rejects(credit(), code(503, 'client_billing_write_failed'));
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('price snapshots, quota resets, and manual reconciliation all survive reopening', async t => {
  const { billing, accountId, reserve, credit, options } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const first = await reserve(); await billing.settle(first.requestId, USAGE);
  await billing.configureAccount(accountId, { resetQuota: true });
  const second = await reserve(); await billing.begin(second.requestId); await billing.markUnresolved(second.requestId);
  const operationId = randomUUID(); await billing.resolve(second.requestId, { operationId, action: 'settle', usage: USAGE });
  await billing.close(); const reopened = await ClientBilling.open(options);
  assert.equal(reopened.account(accountId).balanceMicros, 660); assert.equal(reopened.account(accountId).usedTokens, 90);
  assert.equal(reopened.account(accountId).lifetimeTokens, 180);
  await reopened.resolve(second.requestId, { operationId, action: 'settle', usage: USAGE });
  assert.equal(reopened.account(accountId).balanceMicros, 660);
});

test('close flushes queued changes, conservatively preserves holds, and refuses later mutation', async t => {
  const { billing, reserve, accountId, options } = await fixture(t);
  const request = await reserve(); const pending = billing.begin(request.requestId);
  await billing.close(); await pending;
  await assert.rejects(billing.configureAccount(accountId, { tokenLimit: 1000 }), code(503, 'client_billing_unavailable'));
  assert.throws(() => billing.account(accountId), code(503, 'client_billing_unavailable'));
  const reopened = await ClientBilling.open(options); assert.equal(reopened.account(accountId).unresolvedCount, 1);
});

test('queued writes retain validated values even when a caller changes its argument objects', async t => {
  const { billing, accountId, keyId } = await fixture(t);
  const adjustment = { operationId: randomUUID(), amountMicros: 100, note: 'approved adjustment' };
  const pendingAdjustment = billing.adjustBalance(accountId, adjustment);
  adjustment.amountMicros = Number.MAX_SAFE_INTEGER; adjustment.note = 'mutated';
  await pendingAdjustment; assert.equal(billing.account(accountId).balanceMicros, 100);
  const configuration = { enforceBalance: false, tokenLimit: null };
  const pendingConfiguration = billing.configureAccount(accountId, configuration);
  configuration.enforceBalance = true;
  await pendingConfiguration; assert.equal(billing.account(accountId).enforceBalance, false);
  const options = { accountId, keyId, requestId: randomUUID(), model: MODEL };
  const originalRequestId = options.requestId, pendingReserve = billing.reserve(options);
  options.accountId = randomUUID(); options.model = 'Cursor-sk-' + 'x'.repeat(24); options.secret = 'sensitive credential';
  const reserved = await pendingReserve; assert.equal(reserved.requestId, originalRequestId);
  await billing.markUnresolved(reserved.requestId);
  const resolution = { operationId: randomUUID(), action: 'settle', usage: USAGE };
  const pendingResolution = billing.resolve(reserved.requestId, resolution);
  resolution.action = 'release'; resolution.usage = { inputTokens: 0, outputTokens: 0 };
  const settled = await pendingResolution;
  assert.equal(settled.status, 'settled'); assert.equal(settled.usage.totalTokens, 90);
  assert.equal(JSON.stringify(billing.snapshot()).includes('sensitive credential'), false);
});

test('a full request journal refuses new work and adjustments remain durable without pruning history', async t => {
  const { billing, accountId, reserve, path, options } = await fixture(t);
  const first = await reserve(); await billing.release(first.requestId); await billing.close();
  const state = JSON.parse(await readFile(path, 'utf8')), requestTemplate = state.requests[0];
  const reserveTemplate = state.ledger.find(row => row.type === 'reserved'), releaseTemplate = state.ledger.find(row => row.type === 'released');
  state.requests = []; state.ledger = [];
  for (let index = 0; index < 10000; index++) {
    const requestId = randomUUID(); state.requests.push({ ...requestTemplate, requestId });
    state.ledger.push({ ...reserveTemplate, id: randomUUID(), sequence: state.ledger.length + 1, requestId });
    state.ledger.push({ ...releaseTemplate, id: randomUUID(), sequence: state.ledger.length + 1, requestId });
  }
  await writeFile(path, JSON.stringify(state));
  const full = await ClientBilling.open(options);
  const revision = full.snapshot().revision;
  await assert.rejects(full.reserve({ accountId, keyId: randomUUID(), requestId: randomUUID(), model: MODEL }), code(503, 'client_billing_limit'));
  assert.equal(full.snapshot().revision, revision);
  assert.equal(full.snapshot().recent.length, 100);
  const credited = await full.adjustBalance(accountId, { operationId: randomUUID(), amountMicros: 1 });
  assert.equal(credited.balanceMicros, 1);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.requests.length, 10000); assert.equal(stored.ledger.length, 20001);
});

test('safe revision exhaustion rejects mutations rather than overwriting committed financial history', async t => {
  const { billing, credit, path, options } = await fixture(t);
  await credit(100); await billing.close();
  const state = JSON.parse(await readFile(path, 'utf8')); state.revision = Number.MAX_SAFE_INTEGER;
  await writeFile(path, JSON.stringify(state));
  const exhausted = await ClientBilling.open(options);
  await assert.rejects(exhausted.setPrice(PRICE), code(503, 'client_billing_limit'));
  assert.equal(exhausted.snapshot().revision, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).prices.length, 0);
});

test('cache input split must fit total input and valid read plus write partitions are counted once', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  await billing.setPrice(PRICE); await credit(); await billing.configureAccount(accountId, { enforceBalance: true });
  const request = await reserve();
  for (const usage of [{ ...USAGE, cacheWriteTokens: 81 }, { ...USAGE, cacheWriteTokens: 61 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1, outputTokens: 0 }]) {
    await assert.rejects(billing.settle(request.requestId, usage), code(400, 'invalid_client_billing'));
  }
  const settled = await billing.settle(request.requestId, { ...USAGE, cacheWriteTokens: 60 });
  assert.equal(settled.amountMicros, 170); assert.equal(billing.account(accountId).usedTokens, 90);
  const unknownCache = await reserve();
  await assert.rejects(billing.settle(unknownCache.requestId, { inputTokens: 1, cachedInputTokens: null, cacheWriteTokens: 2, outputTokens: 0 }), code(400, 'invalid_client_billing'));
  const result = await billing.settle(unknownCache.requestId, { inputTokens: 1, cachedInputTokens: null, cacheWriteTokens: 1, outputTokens: 0 });
  assert.equal(result.amountMicros, 2);
});

test('outstanding pagination contains only unresolved requests and scoped cursors cannot cross accounts', async t => {
  const { billing, accountId, reserve } = await fixture(t), otherId = randomUUID();
  const first = await reserve(), second = await reserve();
  const running = await reserve(); await billing.begin(running.requestId);
  const notStarted = await reserve();
  const last = await reserve(), other = await reserve({ accountId: otherId });
  for (const request of [first, second, last, other]) await billing.markUnresolved(request.requestId);
  const page = billing.outstanding({ accountId, limit: 2 });
  assert.deepEqual(page.rows.map(row => row.requestId), [last.requestId, second.requestId]);
  assert.equal(page.nextBefore, second.requestId);
  assert.equal(page.rows.every(row => row.status === 'unresolved'), true);
  assert.equal(page.rows[0].time, page.rows[0].createdAt);
  await billing.resolve(second.requestId, { operationId: randomUUID(), action: 'release' });
  const next = billing.outstanding({ accountId, limit: 2, before: page.nextBefore });
  assert.deepEqual(next.rows.map(row => row.requestId), [first.requestId]); assert.equal(next.nextBefore, null);
  assert.equal(billing.outstanding().rows[0].requestId, other.requestId);
  assert.equal(billing.outstanding().rows.some(row => [running.requestId, notStarted.requestId, second.requestId].includes(row.requestId)), false);
  assert.throws(() => billing.outstanding({ accountId, before: other.requestId }), code(400, 'invalid_client_billing_cursor'));
  for (const options of [{ limit: 0 }, { limit: 201 }, { before: 'bad' }, { accountId: 'bad' }, { phase: 'started' }]) assert.throws(() => billing.outstanding(options));
  page.rows[0].status = 'released'; page.rows[0].usage = { inputTokens: 0 };
  assert.equal(billing.outstanding({ accountId }).rows[0].status, 'unresolved');
});

test('old unresolved requests remain discoverable after recent financial rows are replaced by newer activity', async t => {
  const { billing, accountId, reserve, credit } = await fixture(t);
  const request = await reserve(); await billing.markUnresolved(request.requestId);
  for (let index = 0; index < 101; index++) await credit(1);
  const snapshot = billing.snapshot();
  assert.equal(snapshot.recent.some(row => row.requestId === request.requestId), false);
  assert.equal(snapshot.unresolved.length, 1); assert.equal(snapshot.unresolved[0].requestId, request.requestId);
  assert.equal(snapshot.unresolved[0].accountId, accountId); assert.equal(snapshot.unresolvedNextBefore, null);
});

test('snapshot exposes a cursor when more than 100 unresolved requests need reconciliation', async t => {
  const { billing, reserve } = await fixture(t), requests = [];
  for (let index = 0; index < 103; index++) {
    const request = await reserve(); requests.push(request); await billing.markUnresolved(request.requestId);
  }
  const snapshot = billing.snapshot();
  assert.equal(snapshot.unresolved.length, 100); assert.equal(snapshot.unresolved[0].requestId, requests.at(-1).requestId);
  assert.equal(snapshot.unresolvedNextBefore, requests[3].requestId);
  const rest = billing.outstanding({ before: snapshot.unresolvedNextBefore });
  assert.deepEqual(rest.rows.map(row => row.requestId), requests.slice(0, 3).reverse().map(request => request.requestId));
  assert.equal(rest.nextBefore, null);
});
