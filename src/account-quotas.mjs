function remainingPercent(value, used = false) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, used ? 100 - value : value)) : null;
}

function resetTime(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000 ? value : null;
}

function windowLabel(minutes, index) {
  if (minutes === 10080) return '周额度';
  if (minutes === 1440) return '每日额度';
  if (Number.isSafeInteger(minutes) && minutes > 0) {
    return minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`;
  }
  return `额度窗口 ${index + 1}`;
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:+ -]{1,80}$/.test(value) ? value : null;
}

function decimal(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof text === 'string' && /^-?\d{1,24}(?:\.\d{1,16})?$/.test(text) ? text : null;
}

export function normalizeAccountQuota(snapshot, fetchedAt) {
  const mapped = snapshot?.rateLimitsByLimitId;
  let buckets = mapped && typeof mapped === 'object' && !Array.isArray(mapped)
    ? Object.entries(mapped).filter(([, bucket]) => bucket && typeof bucket === 'object' && !Array.isArray(bucket)) : [];
  if (!buckets.length && snapshot?.rateLimits && typeof snapshot.rateLimits === 'object' && !Array.isArray(snapshot.rateLimits)) {
    buckets = [[safeName(snapshot.rateLimits.limitId) || 'codex', snapshot.rateLimits]];
  }
  if (!buckets.length) throw new Error('QUOTA_DATA_UNAVAILABLE');
  const main = buckets.find(([id]) => id === 'codex')?.[1] ?? buckets[0][1];
  const windows = [];
  for (const [bucketIndex, [bucketId, bucket]] of buckets.entries()) {
    const id = safeName(bucketId) || `bucket-${bucketIndex + 1}`;
    const prefix = buckets.length > 1 ? `${safeName(bucket.limitName) || id} · ` : '';
    for (const [index, field] of ['primary', 'secondary'].entries()) {
      const window = bucket[field];
      if (!window || typeof window !== 'object' || Array.isArray(window)) continue;
      windows.push({ id: `${id}:${field}`, label: prefix + windowLabel(window.windowDurationMins, index),
        remainingPercent: remainingPercent(window.usedPercent, true), resetsAt: resetTime(window.resetsAt) });
    }
    const individual = bucket.individualLimit;
    if (individual && typeof individual === 'object' && !Array.isArray(individual)) {
      windows.push({ id: `${id}:individual`, label: prefix + '个人限额',
        remainingPercent: remainingPercent(individual.remainingPercent), resetsAt: resetTime(individual.resetsAt) });
    }
  }
  const sourceCredits = main.credits;
  const credits = sourceCredits && typeof sourceCredits === 'object' && !Array.isArray(sourceCredits) ? {
    hasCredits: typeof sourceCredits.hasCredits === 'boolean' ? sourceCredits.hasCredits : null,
    unlimited: typeof sourceCredits.unlimited === 'boolean' ? sourceCredits.unlimited : null,
    balance: decimal(sourceCredits.balance),
  } : null;
  return { status: 'ok', fetchedAt, error: null, planType: safeName(main.planType), windows, credits,
    spendControlReached: typeof main.spendControlReached === 'boolean' ? main.spendControlReached : null };
}

function failure(message, fetchedAt) {
  return { status: 'error', fetchedAt, error: message, planType: null, windows: [], credits: null, spendControlReached: null };
}

export class AccountQuotas {
  constructor({ accountARpc, accountBRpc, state, clock = Date.now, cacheMs = 30_000, timeoutMs = 12_000 }) {
    Object.assign(this, { accountARpc, accountBRpc, state, clock, cacheMs, timeoutMs });
    this.entries = new Map();
    for (const [account, rpc] of [['A', accountARpc], ['B', accountBRpc]]) {
      rpc.on('notification', method => {
        if (method === 'account/updated' || method === 'account/login/completed') this.entries.delete(account);
      });
      rpc.on('stopped', () => this.entries.delete(account));
    }
  }

  bindingKey() {
    const pinned = this.state.pinnedAccount;
    return this.state.enabled && pinned?.accountId
      ? JSON.stringify([pinned.accountId, pinned.userId, pinned.email]) : null;
  }

  async read(account, retry = true) {
    const bindingKey = account === 'B' ? this.bindingKey() : 'A';
    if (bindingKey === null) {
      this.entries.delete(account);
      return failure('请先登录并确认账号 B。', null);
    }
    let entry = this.entries.get(account);
    if (!entry || entry.bindingKey !== bindingKey) {
      entry = { bindingKey, cached: null, expiresAt: 0, pending: null };
      this.entries.set(account, entry);
    }
    if (entry.cached && this.clock() < entry.expiresAt) return entry.cached;
    if (entry.pending) return entry.pending;
    const expectedAccountId = account === 'B' ? this.state.pinnedAccount.accountId : null;
    entry.pending = (async () => {
      let timer;
      try {
        const rpc = account === 'A' ? this.accountARpc : this.accountBRpc;
        const snapshot = await Promise.race([
          Promise.resolve().then(() => rpc.request('account/rateLimits/read', {}, { timeoutMs: Math.max(1, this.timeoutMs - 1000) })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QUOTA_TIMEOUT')), this.timeoutMs); }),
        ]);
        if (account === 'B' && this.bindingKey() !== bindingKey) {
          return failure(`账号 ${account} 已变更，请重新查询。`, null);
        }
        if (this.entries.get(account) !== entry) {
          return retry ? this.read(account, false) : failure(`账号 ${account} 已变更，请重新查询。`, null);
        }
        if (account === 'B' && snapshot?.accountId !== expectedAccountId) {
          throw new Error('QUOTA_ACCOUNT_CHANGED');
        }
        entry.cached = normalizeAccountQuota(snapshot, new Date(this.clock()).toISOString());
        entry.expiresAt = this.clock() + this.cacheMs;
      } catch (error) {
        const message = error?.message === 'QUOTA_ACCOUNT_CHANGED' ? '额度返回的账号与已确认的 B 不一致，请核对登录。'
          : error?.message === 'QUOTA_TIMEOUT' ? `账号 ${account} 额度查询超时，请稍后重试。`
            : `账号 ${account} 额度暂时无法读取，请检查登录或稍后重试。`;
        entry.cached = failure(message, new Date(this.clock()).toISOString());
        entry.expiresAt = this.clock() + Math.min(this.cacheMs, 10_000);
      } finally {
        clearTimeout(timer);
        entry.pending = null;
      }
      return entry.cached;
    })();
    return entry.pending;
  }

  async snapshot() {
    const [A, B] = await Promise.all([this.read('A'), this.read('B')]);
    return { timeZone: 'America/Los_Angeles', accounts: { A, B } };
  }
}
