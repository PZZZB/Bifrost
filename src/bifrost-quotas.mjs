const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const amount = Number.isSafeInteger;
const sourceId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160
  && !/[\x00-\x1f\x7f]/.test(value) && !/(?:bfk_|bfs_|bfi_|sk-|rt_|oat_|oaist|Bearer\s|https?:\/\/|[a-z]:\\)/i.test(value) ? value : null;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const messages = Object.freeze({
  unsupported: '远端余额查询尚未开放，可能是服务或公网入口尚未更新。请更新远端 Bifröst（含公网入口）后重试。',
  no_billing: '远端尚未提供计费账本，无法读取余额。',
  unauthorized: '远端用户 Key 已失效或无权查询，请检查该来源授权。',
  unavailable: '远端余额暂时无法读取，请稍后刷新。',
  invalid_response: '远端返回的余额数据不完整或格式不正确。',
  disabled: '远端来源已停用。',
});
const notice = '余额与 Token 配额来自远端用户账本，不代表模型厂商的订阅余量。';

/** Rebuild remote metadata from public scalar fields; never expose credentials or provider errors. */
export function remoteQuotaCard(id, { code = null, fetchedAt = null, identity = null, wallet = null, tokenQuota = null, key = null, authenticated = null } = {}) {
  if (!sourceId(id)) throw new TypeError('Invalid remote quota source.');
  const known = Object.hasOwn(messages, code) ? code : code === null ? null : 'unavailable';
  const status = known === null ? 'ok' : ['unsupported', 'no_billing', 'disabled'].includes(known) ? 'unknown' : 'error';
  const authorized = known === 'unauthorized' || known === 'disabled' ? false : typeof authenticated === 'boolean' ? authenticated : null;
  return { id, name: `Bifröst · ${id}`, status, authenticated: authorized,
  identity: authorized === true ? label(identity) : null, planType: null, source: 'bifrost-remote-account', fetchedAt: time(fetchedAt),
  error: status === 'error' ? messages[known] : null, errorCode: known, notice: known ? messages[known] : notice,
  wallet: known === null ? wallet : null, tokenQuota: known === null ? tokenQuota : null, key: authorized === true ? key : null };
}

function billingFields(value) {
  if (!object(value) || value.currency !== 'CNY' || typeof value.enforceBalance !== 'boolean'
      || !amount(value.balanceMicros) || !count(value.reservedMicros) || !amount(value.availableMicros)
      || BigInt(value.availableMicros) !== BigInt(value.balanceMicros) - BigInt(value.reservedMicros)
      || value.tokenLimit !== null && !count(value.tokenLimit) || !count(value.usedTokens) || !count(value.reservedTokens)
      || value.remainingTokens !== null && !count(value.remainingTokens)) throw new TypeError('Invalid remote account billing.');
  const remaining = value.tokenLimit === null ? null : [0n, BigInt(value.tokenLimit) - BigInt(value.usedTokens) - BigInt(value.reservedTokens)]
    .reduce((a, b) => a > b ? a : b);
  if (remaining === null ? value.remainingTokens !== null : BigInt(value.remainingTokens ?? -1) !== remaining) throw new TypeError('Inconsistent remote token quota.');
  return { wallet: { currency: 'CNY', enforceBalance: value.enforceBalance, balanceMicros: value.balanceMicros,
    reservedMicros: value.reservedMicros, availableMicros: value.availableMicros },
  tokenQuota: { limit: value.tokenLimit, used: value.usedTokens, reserved: value.reservedTokens, remaining: value.remainingTokens } };
}

export function normalizeRemoteAccount(value, { id, fetchedAt } = {}) {
  if (!object(value) || value.object !== 'account' || !object(value.account) || !uuid(value.account.id)
      || !label(value.account.username) || !object(value.key) || !uuid(value.key.id)
      || value.key.expiresAt !== null && !time(value.key.expiresAt)) throw new TypeError('Invalid remote account response.');
  const fields = { authenticated: true, identity: value.account.username, fetchedAt,
    key: { expiresAt: value.key.expiresAt === null ? null : time(value.key.expiresAt) } };
  if (value.billing === null) return remoteQuotaCard(id, { ...fields, code: 'no_billing' });
  return remoteQuotaCard(id, { ...fields, ...billingFields(value.billing) });
}

export function bifrostQuotaSnapshot(sources = [], fetchedAt = null) {
  if (!Array.isArray(sources) || sources.length > 8) throw new TypeError('Invalid remote quota snapshot.');
  const seen = new Set();
  const cards = sources.map(value => {
    if (!object(value) || !sourceId(value.id) || seen.has(value.id)) throw new TypeError('Invalid remote quota source.');
    seen.add(value.id);
    const code = value.errorCode === null ? null : Object.hasOwn(messages, value.errorCode) ? value.errorCode : 'unavailable';
    const key = value.key === null ? null : object(value.key) && (value.key.expiresAt === null || time(value.key.expiresAt))
      ? { expiresAt: value.key.expiresAt === null ? null : time(value.key.expiresAt) } : null;
    let financial = {};
    if (code === null) financial = billingFields({ ...value.wallet, tokenLimit: value.tokenQuota?.limit, usedTokens: value.tokenQuota?.used,
      reservedTokens: value.tokenQuota?.reserved, remainingTokens: value.tokenQuota?.remaining });
    return remoteQuotaCard(value.id, { code, fetchedAt: value.fetchedAt, identity: value.identity, authenticated: value.authenticated, key, ...financial });
  });
  const ok = cards.filter(card => card.status === 'ok').length;
  return { status: !cards.length ? 'not_connected' : ok === cards.length ? 'ok' : ok ? 'partial'
    : cards.some(card => card.status === 'error') ? 'error' : 'unknown',
  authenticated: cards.some(card => card.authenticated === true) ? true : cards.every(card => card.authenticated === false) ? false : null,
  identity: null, planType: null, source: 'bifrost-remote-account', fetchedAt: time(fetchedAt), windows: [], credits: null,
  error: null, notice: cards.length ? notice : '未配置远端 Bifröst 账号。', sources: cards };
}
