import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeSubscriptionUsage, validatedClaudeUsage, readClaudeSubscriptionUsage } from '../src/claude-subscription-usage.mjs';

const now = Date.parse('2026-11-01T08:00:00Z');
const raw = percent => ({ subscription_type: 'pro', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: percent, resets_at: '2026-11-01T12:00:00+00:00' },
    seven_day: { utilization: 0, resets_at: '2026-11-06T08:00:00Z' } },
  session: { total_cost_usd: 100, email: 'PRIVATE_EMAIL' }, behaviors: 'PRIVATE_BEHAVIORS', api_key: 'PRIVATE_KEY' });

test('subscription projection keeps real zero, fixed windows and reset times, excluding session cost and identity', () => {
  const dto = claudeSubscriptionUsage(raw(3), { now });
  assert.equal(dto.status, 'ok'); assert.equal(dto.plan, 'pro'); assert.match(dto.label, /5 小时已用 3%.*7 天已用 0%/);
  assert.deepEqual(dto.windows[0], { key: 'five_hour', label: '5 小时', usedPercent: 3, remainingPercent: 97, resetsAt: '2026-11-01T12:00:00.000Z' });
  assert.equal(dto.windows[1].usedPercent, 0); assert.equal(dto.windows[1].remainingPercent, 100);
  assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|cost|email|api_key|behaviors/);
  assert.deepEqual(validatedClaudeUsage(dto, { now }), dto);
});

test('missing or invalid percentages never become zero and absent rate windows stay unavailable', () => {
  for (const value of [null, undefined, '3', NaN, Infinity, -1, 101]) {
    const dto = claudeSubscriptionUsage(raw(value), { now });
    assert.equal(dto.windows[0].usedPercent, null); assert.equal(dto.windows[0].remainingPercent, null);
  }
  for (const value of [null, {}, { ...raw(3), rate_limits_available: false }, { subscription_type: '__proto__' }]) {
    const dto = claudeSubscriptionUsage(value, { now }); assert.equal(dto.status, 'unavailable'); assert.deepEqual(dto.windows, []);
  }
});

test('relay validation rejects stale/future/unknown/duplicate DTOs and rebuilds labels and percentages', () => {
  const dto = claudeSubscriptionUsage(raw(3), { now });
  for (const value of [{ ...dto, checkedAt: new Date(now - 600001).toISOString() },
    { ...dto, checkedAt: new Date(now + 60001).toISOString() }, { ...dto, source: 'foreign' },
    { ...dto, windows: [...dto.windows, dto.windows[0]] }, { ...dto, windows: [{ key: 'foreign', usedPercent: 0 }] }]) {
    const rejected = validatedClaudeUsage(value, { now }); assert.equal(rejected.status, 'unavailable'); assert.deepEqual(rejected.windows, []);
  }
  const changed = structuredClone(dto); changed.label = 'PRIVATE'; changed.windows[0].label = 'PRIVATE'; changed.windows[0].remainingPercent = 999;
  assert.deepEqual(validatedClaudeUsage(changed, { now }), dto);
});

test('experimental SDK method is feature-detected, skips behaviors and fails softly without exposing errors', async () => {
  let options;
  const query = { async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(value) { options = value; return raw(3); } };
  assert.equal((await readClaudeSubscriptionUsage(query, { now: () => now })).status, 'ok');
  assert.deepEqual(options, { skipBehaviors: true });
  for (const query of [{}, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() { throw new Error('PRIVATE'); } },
    { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) }]) {
    const dto = await readClaudeSubscriptionUsage(query, { timeoutMs: 5, now: () => now });
    assert.equal(dto.status, 'unavailable'); assert.deepEqual(dto.windows, []); assert.doesNotMatch(JSON.stringify(dto), /PRIVATE/);
  }
});
