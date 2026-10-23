import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AccountQuotas, normalizeAccountQuota } from '../src/account-quotas.mjs';

const fetchedAt = '2026-10-19T20:00:00.000Z';
const bucket = (extra = {}) => ({ limitId: 'codex', planType: 'pro',
  primary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1792875177 }, ...extra });
const snapshot = (extra = {}) => ({ rateLimits: bucket(), ...extra });

function fixture({ readA = async () => snapshot(), readB = async () => snapshot({ accountId: 'account-b' }), ...options } = {}) {
  const accountARpc = Object.assign(new EventEmitter(), { request: readA });
  const accountBRpc = Object.assign(new EventEmitter(), { request: readB });
  const state = { enabled: true, pinnedAccount: { accountId: 'account-b', userId: 'user-b', email: 'b@example.invalid' } };
  const quotas = new AccountQuotas({ accountARpc, accountBRpc, state, ...options });
  return { quotas, accountARpc, accountBRpc, state };
}

test('weekly usage is displayed as remaining; null windows stay absent and only public fields leave the service', () => {
  const quota = normalizeAccountQuota(snapshot({ secret: 'PRIVATE', accountId: 'PRIVATE_ACCOUNT' }), fetchedAt);
  assert.deepEqual(quota.windows, [{ id: 'codex:primary', label: '周额度', remainingPercent: 28, resetsAt: 1792875177 }]);
  assert.equal(quota.fetchedAt, fetchedAt);
  assert.equal(quota.planType, 'pro');
  assert.equal(quota.credits, null);
  assert.ok(!JSON.stringify(quota).includes('PRIVATE'));
});

test('Business personal limit uses remainingPercent directly and does not invent shared workspace balance', () => {
  const quota = normalizeAccountQuota(snapshot({ rateLimits: bucket({ planType: 'business', primary: null, secondary: null,
    individualLimit: { limit: '8800', used: '278.29035913944244', remainingPercent: 97, resetsAt: 1793491200 },
    credits: { hasCredits: true, unlimited: false, balance: null } }) }), fetchedAt);
  assert.deepEqual(quota.windows, [{ id: 'codex:individual', label: '个人限额', remainingPercent: 97, resetsAt: 1793491200 }]);
  assert.deepEqual(quota.credits, { hasCredits: true, unlimited: false, balance: null });
});

test('multi-bucket data takes priority over legacy view and each actual duration supplies its label', () => {
  const quota = normalizeAccountQuota(snapshot({ rateLimitsByLimitId: {
    codex: bucket({ primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null } }),
    codex_other: bucket({ limitName: 'GPT-other', primary: { usedPercent: 40.5, windowDurationMins: 60 } }),
  } }), fetchedAt);
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0].label, 'codex · 5 小时额度');
  assert.equal(quota.windows[0].remainingPercent, 100);
  assert.equal(quota.windows[1].label, 'GPT-other · 1 小时额度');
  assert.equal(quota.windows[1].remainingPercent, 59.5);
});

test('unknown values do not coerce to zero, while exhausted and overused windows display zero remaining', () => {
  for (const [value, expected] of [[null, null], [undefined, null], ['72', null], [NaN, null], [Infinity, null],
    [100, 0], [150, 0], [-10, 100], [0, 100]]) {
    const quota = normalizeAccountQuota(snapshot({ rateLimits: bucket({ primary: { usedPercent: value, resetsAt: '1792875177' } }) }), fetchedAt);
    assert.equal(quota.windows[0].remainingPercent, expected);
    assert.equal(quota.windows[0].resetsAt, null);
  }
});

test('empty buckets preserve unknown quota and a numeric zero credit balance remains valid', () => {
  const quota = normalizeAccountQuota(snapshot({ rateLimitsByLimitId: {}, rateLimits: bucket({ primary: null,
    credits: { hasCredits: false, unlimited: false, balance: 0 }, spendControlReached: true }) }), fetchedAt);
  assert.deepEqual(quota.windows, []);
  assert.equal(quota.credits.balance, '0');
  assert.equal(quota.spendControlReached, true);
  assert.throws(() => normalizeAccountQuota({ rateLimits: null }, fetchedAt), /QUOTA_DATA_UNAVAILABLE/);
});

test('readers query only account metadata, join concurrent reads and reuse cache until expiry', async () => {
  let reads = 0, now = Date.parse(fetchedAt);
  const read = async (method, params, options) => {
    reads++;
    assert.equal(method, 'account/rateLimits/read');
    assert.deepEqual(params, {});
    assert.ok(options.timeoutMs > 0);
    return snapshot({ accountId: 'account-b' });
  };
  const { quotas } = fixture({ readA: read, readB: read, clock: () => now });
  const [first, second] = await Promise.all([quotas.snapshot(), quotas.snapshot()]);
  assert.deepEqual(first, second);
  assert.equal(reads, 2);
  await quotas.snapshot();
  assert.equal(reads, 2);
  now += 30001;
  await quotas.snapshot();
  assert.equal(reads, 4);
});

test('one account failure is isolated, raw backend errors are not returned, and retry can recover', async () => {
  let now = Date.parse(fetchedAt), fail = true;
  const { quotas } = fixture({ clock: () => now, readA: () => {
    if (fail) throw new Error('PRIVATE_TOKEN_PRIVATE_EMAIL');
    return snapshot();
  } });
  const first = await quotas.snapshot();
  assert.equal(first.accounts.A.status, 'error');
  assert.equal(first.accounts.B.status, 'ok');
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
  now += 10001;
  fail = false;
  const after = await quotas.snapshot();
  assert.equal(after.accounts.A.status, 'ok');
});

test('unbound B makes no RPC and account mismatch cannot publish a different account quota', async () => {
  let reads = 0;
  const { quotas, state } = fixture({ readB: async () => { reads++; return snapshot({ accountId: 'another-account' }); } });
  state.enabled = false;
  assert.equal((await quotas.snapshot()).accounts.B.status, 'error');
  assert.equal(reads, 0);
  state.enabled = true;
  const result = await quotas.snapshot();
  assert.equal(reads, 1);
  assert.equal(result.accounts.B.status, 'error');
  assert.match(result.accounts.B.error, /不一致/);
  assert.deepEqual(result.accounts.B.windows, []);
});

test('switching B while a read is pending discards the old quota and invalidates cached identity', async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { quotas, state } = fixture({ readB: async () => { started(); await pending; return snapshot({ accountId: 'account-b' }); } });
  const first = quotas.snapshot();
  await entered;
  state.enabled = false;
  release();
  assert.equal((await first).accounts.B.status, 'error');
  assert.equal((await quotas.snapshot()).accounts.B.fetchedAt, null);
});

test('account updates invalidate only that account cached quota', async () => {
  let readsA = 0, readsB = 0;
  const { quotas, accountARpc, accountBRpc } = fixture({
    readA: async () => { readsA++; return snapshot(); }, readB: async () => { readsB++; return snapshot({ accountId: 'account-b' }); },
  });
  await quotas.snapshot();
  accountARpc.emit('notification', 'account/updated', {});
  await quotas.snapshot();
  assert.equal(readsA, 2);
  assert.equal(readsB, 1);
  accountBRpc.emit('stopped');
  await quotas.snapshot();
  assert.equal(readsB, 2);
});

test('the initial native account notification retries the quota once instead of publishing stale identity or a false failure', async () => {
  let reads = 0;
  const { quotas, accountARpc } = fixture({ readA: async () => {
    if (++reads === 1) accountARpc.emit('notification', 'account/updated', {});
    return snapshot();
  } });
  const result = await quotas.snapshot();
  assert.equal(result.accounts.A.status, 'ok');
  assert.equal(reads, 2);
});

test('a stuck account has a bounded timeout while the other account remains readable', async () => {
  const { quotas } = fixture({ readA: () => new Promise(() => {}), timeoutMs: 25 });
  const result = await quotas.snapshot();
  assert.equal(result.accounts.A.status, 'error');
  assert.match(result.accounts.A.error, /超时/);
  assert.equal(result.accounts.B.status, 'ok');
});

test('quota snapshots include verified binding state and never attach a new B identity to an old result', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { quotas, state } = fixture({ readA: async () => { await gate; return snapshot(); } });
  state.pinnedAccount.email = 'old@example.test';
  const pending = quotas.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  state.pinnedAccount = { ...state.pinnedAccount, accountId: 'changed-account', email: 'new@example.test' };
  release(); const result = await pending;
  assert.equal(result.accounts.A.authenticated, true); assert.equal(result.accounts.A.source, 'codex-account-rate-limits');
  assert.equal(result.accounts.B.status, 'error'); assert.equal(result.accounts.B.identity, null);
  assert.equal(JSON.stringify(result.accounts.B).includes('new@example.test'), false);
});
