import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderQuotas } from '../src/provider-quotas.mjs';

const epoch = Date.UTC(2026, 9, 23, 0, 0);
const codeBuddy = () => ({ provider: { authenticated: true, username: 'employee.user',
  billing: { sourceCredits: 'x2.17', employeeTokenMultiplier: 2.17 }, catalog: { source: 'native-cache' } },
  quota: { remaining: 5000 }, gateway: { requests: 300 }, tokenUsage: { total_tokens: 10000 } });
const cursor = () => ({ authReady: true, profile: { email: 'person@example.test', name: 'Person' },
  plan: { declared: 'Teams', verified: false }, runUsageDiagnostics: [{ usage: { total_tokens: 100000 } }] });
function fixture({ codeBuddyStatus = async () => codeBuddy(), cursorStatus = async () => cursor(), ...options } = {}) {
  let now = epoch;
  const calls = { CodeBuddy: 0, Cursor: 0 };
  const source = (account, status) => ({ authorizationVersion: 0, status: async (...args) => { calls[account]++; return status(...args); },
    credential() { assert.fail('Quota cards must not read credentials'); }, getModels() { assert.fail('Quota cards must not send model queries'); },
    request() { assert.fail('Quota cards must not infer'); }, getUsage() { assert.fail('Single-agent usage is not an account balance'); } });
  const codeBuddyService = source('CodeBuddy', codeBuddyStatus), cursorService = source('Cursor', cursorStatus);
  const quotas = new ProviderQuotas({ codeBuddyService, cursorService, clock: () => now, ...options });
  return { quotas, calls, codeBuddyService, cursorService, advance: ms => { now += ms; } };
}
function deferred() { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; }

test('bound provider cards retain authentication and labels without inventing balances from pricing or run counts', async () => {
  const f = fixture(), snapshot = await f.quotas.snapshot();
  assert.equal(snapshot.timeZone, 'America/Los_Angeles');
  assert.equal(snapshot.accounts.CodeBuddy.identity, 'employee.user');
  assert.equal(snapshot.accounts.Cursor.identity, 'person@example.test');
  assert.equal(snapshot.accounts.Cursor.planType, 'Teams（未核实）');
  for (const card of Object.values(snapshot.accounts)) {
    assert.equal(card.status, 'unknown'); assert.equal(card.authenticated, true);
    assert.deepEqual(card.windows, []); assert.equal(card.credits, null); assert.equal(card.spendControlReached, null);
    assert.equal(card.fetchedAt, new Date(epoch).toISOString()); assert.equal(card.error, null);
    const url = new URL(card.usageUrl); assert.equal(url.protocol, 'https:'); assert.equal(url.search, '');
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.ok(card.notice);
  }
  assert.equal(snapshot.accounts.CodeBuddy.planType, null);
  assert.deepEqual(f.calls, { CodeBuddy: 1, Cursor: 1 });
  await f.quotas.close();
});

test('unbound, missing and malformed accounts stay unknown or error rather than becoming zero allowance', async () => {
  const f = fixture({ codeBuddyStatus: async () => ({ provider: { authenticated: false, username: 'old user' } }),
    cursorStatus: async () => ({ authReady: false, profile: { email: 'old@example.test' }, plan: { declared: 'Teams' } }) });
  const snapshot = await f.quotas.snapshot();
  for (const card of Object.values(snapshot.accounts)) {
    assert.equal(card.authenticated, false); assert.equal(card.identity, null); assert.equal(card.planType, null);
    assert.equal(card.status, 'unknown'); assert.deepEqual(card.windows, []); assert.equal(card.credits, null);
  }
  const empty = new ProviderQuotas(), missing = await empty.snapshot();
  assert.ok(Object.values(missing.accounts).every(card => card.authenticated === false && card.status === 'unknown'));
  const broken = fixture({ cursorStatus: async () => ({}) });
  assert.equal((await broken.quotas.snapshot()).accounts.Cursor.status, 'error');
  await Promise.all([f.quotas.close(), empty.close(), broken.quotas.close()]);
});

test('provider cards copy only safe display fields and fixed URLs, never raw private objects or errors', async () => {
  const f = fixture({ codeBuddyStatus: async () => ({ ...codeBuddy(), apiKey: 'PRIVATE_TOKEN',
    usageUrl: 'https://evil.invalid/?token=PRIVATE_TOKEN', provider: { ...codeBuddy().provider, headers: { Authorization: 'PRIVATE_TOKEN' } } }),
  cursorStatus: async () => ({ ...cursor(), apiKey: 'PRIVATE_TOKEN', usageUrl: 'https://evil.invalid/',
    source: 'PRIVATE_TOKEN', profile: { email: 'bad\nPRIVATE_TOKEN', name: 'Safe display' }, plan: { declared: 'bad\nPRIVATE_TOKEN' } }) });
  const snapshot = await f.quotas.snapshot(), json = JSON.stringify(snapshot);
  assert.equal(json.includes('PRIVATE_TOKEN'), false); assert.equal(json.includes('evil.invalid'), false);
  assert.equal(snapshot.accounts.Cursor.identity, 'Safe display'); assert.equal(snapshot.accounts.Cursor.planType, null);
  assert.equal(snapshot.accounts.CodeBuddy.usageUrl, 'https://www.codebuddy.cn/home/');
  assert.equal(snapshot.accounts.Cursor.usageUrl, 'https://cursor.com/dashboard/usage');
  await f.quotas.close();
});

test('manual concurrent reads coalesce, cache for 30 seconds, and return detached snapshots', async () => {
  const waiting = deferred(), f = fixture({ cursorStatus: () => waiting.promise });
  const first = f.quotas.snapshot(), second = f.quotas.snapshot();
  waiting.resolve(cursor()); const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(f.calls, { CodeBuddy: 1, Cursor: 1 }); assert.deepEqual(a, b);
  a.accounts.Cursor.identity = 'tampered'; a.accounts.CodeBuddy.windows.push({ remainingPercent: 0 });
  const cached = await f.quotas.snapshot(); assert.equal(cached.accounts.Cursor.identity, 'person@example.test');
  assert.deepEqual(cached.accounts.CodeBuddy.windows, []);
  f.advance(29999); await f.quotas.snapshot(); assert.equal(f.calls.Cursor, 1);
  f.advance(1); await f.quotas.snapshot(); assert.deepEqual(f.calls, { CodeBuddy: 2, Cursor: 2 });
  await f.quotas.close();
});

test('one provider timeout or rejection does not hide the other card or expose upstream errors', async () => {
  const f = fixture({ timeoutMs: 10, codeBuddyStatus: () => new Promise(() => {}) });
  const snapshot = await f.quotas.snapshot();
  assert.equal(snapshot.accounts.CodeBuddy.status, 'error'); assert.match(snapshot.accounts.CodeBuddy.error, /超时/);
  assert.equal(snapshot.accounts.CodeBuddy.authenticated, null); assert.equal(snapshot.accounts.Cursor.authenticated, true);
  const g = fixture({ cursorStatus: async () => { throw new Error('PRIVATE_ERROR_TOKEN'); } });
  const rejected = await g.quotas.snapshot(); assert.equal(rejected.accounts.Cursor.status, 'error');
  assert.equal(JSON.stringify(rejected).includes('PRIVATE_ERROR_TOKEN'), false);
  assert.equal(rejected.accounts.CodeBuddy.authenticated, true);
  await Promise.all([f.quotas.close(), g.quotas.close()]);
});

test('re-authorization invalidates a cached identity and late results cannot repopulate the old account', async () => {
  const waiting = deferred(), f = fixture({ cursorStatus: () => waiting.promise });
  const pending = f.quotas.snapshot(); await new Promise(resolve => setImmediate(resolve));
  f.cursorService.authorizationVersion++;
  waiting.resolve({ ...cursor(), profile: { email: 'old@example.test' } });
  const old = await pending; assert.equal(old.accounts.Cursor.identity, null); assert.equal(old.accounts.Cursor.authenticated, null);
  f.cursorService.status = async () => ({ ...cursor(), profile: { email: 'new@example.test' } });
  const fresh = await f.quotas.snapshot(); assert.equal(fresh.accounts.Cursor.identity, 'new@example.test');
  f.cursorService.authorizationVersion++;
  f.cursorService.status = async () => ({ authReady: false });
  const loggedOut = await f.quotas.snapshot(); assert.equal(loggedOut.accounts.Cursor.authenticated, false); assert.equal(loggedOut.accounts.Cursor.identity, null);
  await f.quotas.close();
});

test('an authorization change while waiting for another provider also removes already-read identity', async () => {
  const waiting = deferred(), f = fixture({ codeBuddyStatus: () => waiting.promise });
  const pending = f.quotas.snapshot(); await new Promise(resolve => setImmediate(resolve));
  f.cursorService.authorizationVersion++;
  waiting.resolve(codeBuddy());
  assert.equal((await pending).accounts.Cursor.identity, null);
  await f.quotas.close();
});

test('close cancels bounded reads and ignores later metadata without starting another status request', async () => {
  const waiting = deferred(), f = fixture({ cursorStatus: () => waiting.promise });
  const pending = f.quotas.snapshot(); await new Promise(resolve => setImmediate(resolve));
  await f.quotas.close(); assert.ok(Object.values((await pending).accounts).every(card => card.identity === null));
  waiting.resolve(cursor());
  const closed = await f.quotas.snapshot(); assert.equal(closed.accounts.Cursor.status, 'error');
  assert.deepEqual(f.calls, { CodeBuddy: 1, Cursor: 1 });
});
