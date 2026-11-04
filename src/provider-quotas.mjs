// CodeBuddy/Cursor authorization exposes metadata, not subscription balances.
// Bifrost user balances come from the remote user's own read-only ledger API.
// Cursor Agent.getUsage is scoped to an agent; model credits in CodeBuddy are
// pricing metadata. Neither is a source for account-wide remaining allowance.
// https://cursor.com/docs/sdk/typescript#the-cursor-namespace
// https://www.codebuddy.cn/docs/ide/Account/usage
import { bifrostQuotaSnapshot } from './bifrost-quotas.mjs';

const providers = Object.freeze({
  CodeBuddy: Object.freeze({ source: 'codebuddy-account-metadata', usageUrl: 'https://www.codebuddy.cn/home/',
    notice: '当前员工认证和模型目录未返回套餐总额、已用、剩余或重置时间；模型积分倍率不等于账号余额。请在官网个人主页“套餐与用量”查看。' }),
  Cursor: Object.freeze({ source: 'cursor-sdk-account-metadata', usageUrl: 'https://cursor.com/dashboard/usage',
    notice: '当前 Cursor 用户授权的 SDK 不提供账号套餐余量或重置时间。Agent 用量只覆盖单个 Agent，不能作为账号套餐余量；请在官网用量页查看。' }),
  Bifrost: Object.freeze({ source: 'bifrost-remote-account', usageUrl: null,
    notice: '远端用户余额与 Token 配额由远端 Bifröst 账本提供。' }),
});
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 160
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : null;

function card(account, fetchedAt, fields = {}) {
  return { status: 'unknown', fetchedAt, error: null, planType: null, windows: [], credits: null,
    spendControlReached: null, authenticated: null, identity: null, ...providers[account], ...fields };
}
function unavailable(account, fetchedAt, error) { return card(account, fetchedAt, { status: 'error', error,
  ...(account === 'Bifrost' ? { sources: [] } : {}) }); }

function normalize(account, metadata, fetchedAt) {
  const authenticated = account === 'Cursor' ? metadata?.authReady : metadata?.provider?.authenticated;
  if (typeof authenticated !== 'boolean') throw new Error('INVALID_ACCOUNT_METADATA');
  if (!authenticated) return card(account, fetchedAt, { authenticated: false,
    notice: `当前未确认已授权的 ${account} 账号。请先在账号管理完成官方授权，再到官网查看套餐用量。` });
  const identity = account === 'Cursor' ? label(metadata.profile?.email) ?? label(metadata.profile?.name)
    : label(metadata.provider?.username);
  // Teams was declared by the user, not returned by Cursor.me. Preserve that
  // distinction rather than turning a local preference into a verified plan.
  const declaredPlan = account === 'Cursor' ? label(metadata.plan?.declared) : null;
  const planType = declaredPlan ? metadata.plan.verified === true ? declaredPlan : `${declaredPlan}（未核实）` : null;
  return card(account, fetchedAt, { authenticated: true, identity, planType });
}

/** Safe account cards. No inference, credential getters, admin API or scheduled polling. */
export class ProviderQuotas {
  #entries = new Map();
  #active = new Set();
  #closed = false;
  constructor({ codeBuddyService = null, cursorService = null, serverRemotes = null, getServerRemotes = () => serverRemotes,
    clock = Date.now, cacheMs = 30000, timeoutMs = 8000 } = {}) {
    if (typeof clock !== 'function' || !Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 3600000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || typeof getServerRemotes !== 'function') throw new TypeError('Invalid provider quota settings.');
    Object.assign(this, { codeBuddyService, cursorService, getServerRemotes, clock, cacheMs, timeoutMs });
  }
  #service(account) { return account === 'Bifrost' ? this.getServerRemotes() : account === 'Cursor' ? this.cursorService : this.codeBuddyService; }
  bindingKey(account) {
    const service = this.#service(account);
    return account === 'Bifrost' ? service?.quotaBindingKey?.() ?? service?.generation : service?.authorizationVersion;
  }
  async #read(account) {
    const service = this.#service(account), version = this.bindingKey(account);
    if (this.#closed) return unavailable(account, null, '账号用量查询服务已停止。');
    const remote = account === 'Bifrost';
    if (remote && !service) return bifrostQuotaSnapshot();
    if ((remote ? typeof service?.accountQuotas !== 'function' : typeof service?.status !== 'function') || service.enabled === false) return card(account, null, { authenticated: false,
      ...(remote ? { sources: [] } : {}),
      notice: `当前未配置 ${account} 账号，请先在账号管理完成官方授权。` });
    let entry = this.#entries.get(account);
    if (!entry || entry.version !== version) {
      entry = { version, cached: null, expiresAt: 0, pending: null };
      this.#entries.set(account, entry);
    }
    if (entry.cached && this.clock() < entry.expiresAt) return structuredClone(entry.cached);
    if (entry.pending) return structuredClone(await entry.pending);
    const abort = new AbortController(); this.#active.add(abort);
    let timer, timedOut = false;
    const pending = (async () => {
      let result;
      try {
        const metadata = await Promise.race([
          Promise.resolve().then(() => remote ? service.accountQuotas({ signal: abort.signal }) : service.status({ signal: abort.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; abort.abort(); reject(new Error('QUOTA_TIMEOUT')); }, this.timeoutMs); }),
          new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('QUOTA_CANCELLED')), { once: true })),
        ]);
        if (this.#closed) return unavailable(account, null, '账号用量查询服务已停止。');
        if (this.#service(account) !== service || this.bindingKey(account) !== version || this.#entries.get(account) !== entry) {
          return unavailable(account, null, `${account} 账号授权已变化，请重新查询。`);
        }
        if (remote && !Array.isArray(metadata?.sources)) throw new Error('INVALID_REMOTE_QUOTA_METADATA');
        result = remote ? bifrostQuotaSnapshot(metadata.sources, new Date(this.clock()).toISOString())
          : normalize(account, metadata, new Date(this.clock()).toISOString());
      } catch {
        result = unavailable(account, this.#closed ? null : new Date(this.clock()).toISOString(), this.#closed
          ? '账号用量查询服务已停止。' : timedOut ? `${account} 账号状态查询超时，请稍后刷新。` : `${account} 账号状态暂不可用，请稍后刷新。`);
      } finally { clearTimeout(timer); this.#active.delete(abort); }
      if (!this.#closed && this.#service(account) === service && this.bindingKey(account) === version && this.#entries.get(account) === entry) {
        entry.cached = result; entry.expiresAt = this.clock() + (result.status === 'error' ? Math.min(10000, this.cacheMs) : this.cacheMs);
      }
      return result;
    })();
    entry.pending = pending;
    void pending.finally(() => { if (entry.pending === pending) entry.pending = null; }).catch(() => {});
    return structuredClone(await pending);
  }
  async snapshot() {
    const accounts = ['CodeBuddy', 'Cursor', 'Bifrost'];
    const versions = accounts.map(account => this.bindingKey(account));
    const values = await Promise.all(accounts.map(account => this.#read(account)));
    return { timeZone: 'America/Los_Angeles', accounts: Object.fromEntries(accounts.map((account, index) => [account,
      this.#closed ? unavailable(account, null, '账号用量查询服务已停止。')
        : this.bindingKey(account) !== versions[index]
        ? unavailable(account, null, `${account} 账号授权已变化，请重新查询。`) : values[index]])) };
  }
  async close() {
    this.#closed = true;
    for (const abort of this.#active) abort.abort();
    await Promise.allSettled([...this.#entries.values()].map(entry => entry.pending));
    this.#entries.clear();
  }
}
