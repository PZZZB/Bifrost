const WINDOW_LABELS = Object.freeze({ five_hour: '5 小时', seven_day: '7 天', seven_day_opus: 'Opus 7 天',
  seven_day_sonnet: 'Sonnet 7 天', seven_day_fable: 'Fable 7 天', seven_day_oauth_apps: '应用 7 天',
  seven_day_overage_included: '额外用量 7 天' });
const PLANS = { pro: 'Claude Pro', max: 'Claude Max', ultra: 'Claude Ultra', team: 'Claude Team', enterprise: 'Claude Enterprise' };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const percent = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const iso = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const display = v => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(v);
export function unavailableClaudeUsage(reason = 'not_loaded', checkedAt = null) {
  return { kind: 'subscription', source: 'official-claude-sdk', status: 'unavailable', reason, plan: null,
    label: '订阅用量暂不可读取', checkedAt: iso(checkedAt), windows: [] };
}
function build(plan, windows, checkedAt, reason) {
  const usable = windows.filter(w => w.usedPercent !== null);
  return { kind: 'subscription', source: 'official-claude-sdk', status: usable.length ? 'ok' : 'unavailable',
    reason: usable.length ? null : reason, plan,
    label: usable.length ? usable.slice(0, 2).map(w => `${w.label}已用 ${display(w.usedPercent)}%`).join(' · ') : '订阅用量暂不可读取',
    checkedAt, windows };
}
/** Only account plan windows, never session costs, identities, behaviors or credits. */
export function claudeSubscriptionUsage(raw, { now = Date.now() } = {}) {
  const plan = typeof raw?.subscription_type === 'string' && Object.hasOwn(PLANS, raw.subscription_type) ? raw.subscription_type : null, checkedAt = new Date(now).toISOString();
  const windows = raw?.rate_limits_available === true && object(raw.rate_limits) ? Object.entries(WINDOW_LABELS).flatMap(([key, label]) => {
    const value = raw.rate_limits[key]; if (!object(value)) return [];
    const usedPercent = percent(value.utilization);
    return [{ key, label, usedPercent, remainingPercent: usedPercent === null ? null : Math.round((100 - usedPercent) * 100) / 100,
      resetsAt: iso(value.resets_at) }];
  }) : [];
  return build(plan, windows, checkedAt, 'not_available');
}
/** Revalidate the private relay DTO. A failed or stale query cannot become 0%. */
export function validatedClaudeUsage(dto, { now = Date.now() } = {}) {
  if (!object(dto) || dto.kind !== 'subscription' || dto.source !== 'official-claude-sdk') return unavailableClaudeUsage('not_available');
  const checkedAt = iso(dto.checkedAt), plan = typeof dto.plan === 'string' && Object.hasOwn(PLANS, dto.plan) ? dto.plan : null;
  if (!checkedAt || Date.parse(checkedAt) > now + 60000 || now - Date.parse(checkedAt) > 600000) return unavailableClaudeUsage('stale', checkedAt);
  if (dto.status !== 'ok' || !Array.isArray(dto.windows) || dto.windows.length > Object.keys(WINDOW_LABELS).length) return unavailableClaudeUsage('not_available', checkedAt);
  const seen = new Set(), windows = [];
  for (const item of dto.windows) {
    if (!object(item) || typeof item.key !== 'string' || !Object.hasOwn(WINDOW_LABELS, item.key) || seen.has(item.key)) return unavailableClaudeUsage('invalid', checkedAt);
    seen.add(item.key); const usedPercent = percent(item.usedPercent);
    windows.push({ key: item.key, label: WINDOW_LABELS[item.key], usedPercent,
      remainingPercent: usedPercent === null ? null : Math.round((100 - usedPercent) * 100) / 100, resetsAt: iso(item.resetsAt) });
  }
  return build(plan, windows, checkedAt, 'not_available');
}
/** Pinned SDK capability, guarded because the official method is experimental. */
export async function readClaudeSubscriptionUsage(query, { timeoutMs = 4000, now = Date.now } = {}) {
  const method = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof method !== 'function') return unavailableClaudeUsage('unsupported');
  let timer;
  try {
    const raw = await Promise.race([Promise.resolve().then(() => method.call(query, { skipBehaviors: true })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Usage query timed out.')), timeoutMs); })]);
    return claudeSubscriptionUsage(raw, { now: now() });
  } catch { return unavailableClaudeUsage('fetch_failed', new Date(now()).toISOString()); }
  finally { clearTimeout(timer); }
}
