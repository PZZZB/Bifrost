import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { BridgeError } from './storage.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ACCOUNTS = 2048;
const MAX_PRICES = 1024;
const MAX_REQUESTS = 10000;
const MAX_ROWS = 50000;
const ACTIVE = new Set(['reserved', 'started', 'unresolved']);
const STATUSES = ['reserved', 'started', 'unresolved', 'settled', 'released'];
const PRICE_FIELDS = ['model', 'inputRateMicros', 'cachedInputRateMicros', 'outputRateMicros', 'reserveInputTokens', 'reserveOutputTokens', 'enabled'];
const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens', 'cacheWriteTokens', 'reasoningTokens'];
const REASONS = new Set(['cancelled_before_upstream', 'upstream_not_started', 'client_disconnected', 'request_rejected', 'upstream_rejected',
  'usage_missing', 'stream_incomplete', 'upstream_error', 'billing_write_failed', 'process_restart', 'admin_release', 'admin_settle', 'accounting_overflow', 'other']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed, required = []) => object(value) && Reflect.ownKeys(value).every(key => typeof key === 'string'
  && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
  && required.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const signed = value => Number.isSafeInteger(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const error = (message = '计费参数无效。', status = 400, code = 'invalid_client_billing') => new BridgeError(message, status, code);
const unavailable = () => error('计费账本不可用。', 503, 'client_billing_unavailable');
const limited = () => error('计费账本达到保存上限；请先归档处理，原账目不会自动删除。', 503, 'client_billing_limit');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copied = value => structuredClone(value);
const terminal = request => !ACTIVE.has(request.status);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(value)
  && !value.replace(/^(?:CodeBuddy-|Cursor-)/, '').split(/[/:]/).some(part => part === '.' || part === '..' || /^(?:sk-|rt_|oat_|bfk_|bfs_|bfi_|eyJ|Bearer)/i.test(part));

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw error('计费记录标识无效。');
  return value;
}
function reason(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 128) throw error('计费状态原因无效。');
  // Provider messages and request bodies never become financial metadata.
  return REASONS.has(value) ? value : 'other';
}
function note(value = '') {
  if (typeof value !== 'string' || value.length > 240 || /[\x00-\x1f\x7f]/.test(value)
    || /(?:Bearer\s|\b(?:bfk_|bfs_|bfi_|sk-|rt_|oat_)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.)/i.test(value)) throw error('管理员备注须为不含凭证的 240 字以内文本。');
  return value.trim();
}
function number(value) {
  if (value > MAX_INTEGER || value < -MAX_INTEGER) throw error('计费金额或累计用量超出安全整数范围。', 503, 'client_billing_overflow');
  return Number(value);
}
function plus(...values) { return number(values.reduce((sum, value) => sum + BigInt(value), 0n)); }
function normalizedPrice(value) {
  if (!fields(value, PRICE_FIELDS, PRICE_FIELDS) || !modelId(value.model) || typeof value.enabled !== 'boolean'
    || !PRICE_FIELDS.slice(1, -1).every(key => integer(value[key]))
    || value.reserveInputTokens + value.reserveOutputTokens > Number.MAX_SAFE_INTEGER
    || value.reserveInputTokens + value.reserveOutputTokens === 0) throw error('模型费率或请求预留 Token 无效。');
  return Object.fromEntries(PRICE_FIELDS.map(key => [key, value[key]]));
}
function normalizedUsage(value) {
  if (!fields(value, USAGE_FIELDS, ['inputTokens', 'outputTokens']) || !integer(value.inputTokens) || !integer(value.outputTokens)
    || value.inputTokens + value.outputTokens > Number.MAX_SAFE_INTEGER) throw error('实际输入、输出 Token 必须为安全非负整数。');
  const result = { inputTokens: value.inputTokens, cachedInputTokens: value.cachedInputTokens ?? null,
    outputTokens: value.outputTokens, totalTokens: value.totalTokens ?? value.inputTokens + value.outputTokens,
    cacheWriteTokens: value.cacheWriteTokens ?? null, reasoningTokens: value.reasoningTokens ?? null };
  if (!integer(result.totalTokens) || result.totalTokens !== result.inputTokens + result.outputTokens
    || ['cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens'].some(key => result[key] !== null && !integer(result[key]))
    || result.cachedInputTokens !== null && result.cachedInputTokens > result.inputTokens
    || result.cacheWriteTokens !== null && result.cacheWriteTokens > result.inputTokens
    || BigInt(result.cachedInputTokens ?? 0) + BigInt(result.cacheWriteTokens ?? 0) > BigInt(result.inputTokens)
    || result.reasoningTokens !== null && result.reasoningTokens > result.outputTokens) throw error('Token 总数或缓存、思考拆分不一致。');
  return result;
}
function cost(price, usage, reserve = false) {
  const cached = usage.cachedInputTokens ?? 0;
  const inputRate = reserve ? Math.max(price.inputRateMicros, price.cachedInputRateMicros) : price.inputRateMicros;
  const numerator = BigInt(usage.inputTokens - cached) * BigInt(inputRate)
    + BigInt(cached) * BigInt(price.cachedInputRateMicros) + BigInt(usage.outputTokens) * BigInt(price.outputRateMicros);
  // Rates are CNY micro-units per one million tokens. Round the complete request once.
  return number((numerator + 999999n) / 1000000n);
}
function defaults(accountId, time) {
  return { accountId, enforceBalance: false, balanceMicros: 0, tokenLimit: null, usedTokens: 0, lifetimeTokens: 0,
    quotaVersion: 0, createdAt: time, updatedAt: time };
}
function pendingBudget(state) {
  let rows = 0, bytes = 0;
  for (const request of state.requests) {
    if (request.status === 'reserved') { rows += 3; bytes += 32768; }
    else if (request.status === 'started') { rows += 3; bytes += 24576; }
    else if (request.status === 'unresolved') { rows += request.usage === null ? 2 : 1; bytes += request.usage === null ? 16384 : 8192; }
  }
  return { rows, bytes };
}
function validateState(data) {
  if (!fields(data, ['version', 'revision', 'currency', 'prices', 'accounts', 'requests', 'ledger'], ['version', 'revision', 'currency', 'prices', 'accounts', 'requests', 'ledger'])
    || data.version !== 1 || data.currency !== 'CNY' || !integer(data.revision)
    || !Array.isArray(data.prices) || data.prices.length > MAX_PRICES || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS
    || !Array.isArray(data.requests) || data.requests.length > MAX_REQUESTS || !Array.isArray(data.ledger) || data.ledger.length > MAX_ROWS) throw error();
  const models = new Set(), accounts = new Map(), requests = new Map(), rowIds = new Set(), operationIds = new Set();
  for (const price of data.prices) {
    normalizedPrice(price);
    if (models.has(price.model)) throw error();
    models.add(price.model);
  }
  for (const account of data.accounts) {
    if (!fields(account, ['accountId', 'enforceBalance', 'balanceMicros', 'tokenLimit', 'usedTokens', 'lifetimeTokens', 'quotaVersion', 'createdAt', 'updatedAt'],
      ['accountId', 'enforceBalance', 'balanceMicros', 'tokenLimit', 'usedTokens', 'lifetimeTokens', 'quotaVersion', 'createdAt', 'updatedAt'])
      || !UUID.test(account.accountId) || accounts.has(account.accountId) || typeof account.enforceBalance !== 'boolean' || !signed(account.balanceMicros)
      || account.tokenLimit !== null && !integer(account.tokenLimit) || !integer(account.usedTokens) || !integer(account.lifetimeTokens)
      || account.usedTokens > account.lifetimeTokens || !integer(account.quotaVersion) || !iso(account.createdAt) || !iso(account.updatedAt)) throw error();
    accounts.set(account.accountId, account);
  }
  for (const request of data.requests) {
    if (!fields(request, ['requestId', 'accountId', 'keyId', 'model', 'status', 'charged', 'price', 'reservedMicros', 'reservedTokens', 'quotaVersion', 'createdAt',
      'startedAt', 'updatedAt', 'endedAt', 'usage', 'amountMicros', 'reason', 'resolutionOperationId'],
    ['requestId', 'accountId', 'keyId', 'model', 'status', 'charged', 'price', 'reservedMicros', 'reservedTokens', 'quotaVersion', 'createdAt',
      'startedAt', 'updatedAt', 'endedAt', 'usage', 'amountMicros', 'reason', 'resolutionOperationId'])
      || !UUID.test(request.requestId) || requests.has(request.requestId) || !accounts.has(request.accountId) || !UUID.test(request.keyId)
      || !modelId(request.model) || !STATUSES.includes(request.status) || typeof request.charged !== 'boolean'
      || request.price !== null && (!same(normalizedPrice(request.price), request.price) || request.price.model !== request.model || !request.price.enabled)
      || request.charged && request.price === null || !integer(request.reservedMicros) || !integer(request.reservedTokens)
      || !request.charged && request.reservedMicros !== 0 || !integer(request.quotaVersion) || request.quotaVersion > accounts.get(request.accountId).quotaVersion
      || !iso(request.createdAt) || !iso(request.updatedAt) || request.startedAt !== null && !iso(request.startedAt)
      || request.endedAt !== null && !iso(request.endedAt) || request.reason !== null && !REASONS.has(request.reason)
      || request.resolutionOperationId !== null && !UUID.test(request.resolutionOperationId)
      || request.usage !== null && !same(normalizedUsage(request.usage), request.usage)
      || request.amountMicros !== null && !integer(request.amountMicros)
      || terminal(request) !== (request.endedAt !== null)
      || request.status === 'settled' && (request.usage === null || request.amountMicros === null)
      || request.status === 'released' && (request.usage !== null || request.amountMicros !== 0)
      || ['reserved', 'started'].includes(request.status) && (request.usage !== null || request.amountMicros !== null)
      || request.status === 'reserved' && request.startedAt !== null || request.status === 'started' && request.startedAt === null) throw error();
    const expectedTokens = request.price ? plus(request.price.reserveInputTokens, request.price.reserveOutputTokens) : 0;
    const expectedMoney = request.charged ? cost(request.price, { inputTokens: request.price.reserveInputTokens, outputTokens: request.price.reserveOutputTokens }, true) : 0;
    if (request.reservedTokens !== expectedTokens || request.reservedMicros !== expectedMoney
      || request.status === 'settled' && request.amountMicros !== (request.charged ? cost(request.price, request.usage) : 0)) throw error();
    requests.set(request.requestId, request);
  }
  const balances = new Map(), lifetimes = new Map(), used = new Map(), requestRows = new Map();
  for (let index = 0; index < data.ledger.length; index++) {
    const row = data.ledger[index];
    if (!fields(row, ['id', 'sequence', 'time', 'type', 'accountId', 'requestId', 'operationId', 'keyId', 'model', 'status', 'amountMicros', 'balanceMicros',
      'reservedMicros', 'reservedTokens', 'charged', 'price', 'usage', 'reason', 'note', 'configuration'],
    ['id', 'sequence', 'time', 'type', 'accountId', 'requestId', 'operationId', 'keyId', 'model', 'status', 'amountMicros', 'balanceMicros',
      'reservedMicros', 'reservedTokens', 'charged', 'price', 'usage', 'reason', 'note', 'configuration'])
      || !UUID.test(row.id) || rowIds.has(row.id) || row.sequence !== index + 1 || !iso(row.time)
      || !['price_updated', 'account_configured', 'balance_adjustment', 'reserved', 'unresolved', 'settled', 'released'].includes(row.type)
      || row.accountId !== null && !accounts.has(row.accountId) || row.requestId !== null && !requests.has(row.requestId)
      || row.operationId !== null && (!UUID.test(row.operationId) || operationIds.has(row.operationId))
      || row.keyId !== null && !UUID.test(row.keyId) || row.model !== null && !modelId(row.model)
      || row.status !== null && !STATUSES.includes(row.status) || !signed(row.amountMicros)
      || row.balanceMicros !== null && !signed(row.balanceMicros) || !integer(row.reservedMicros) || !integer(row.reservedTokens)
      || row.charged !== null && typeof row.charged !== 'boolean' || row.price !== null && !same(normalizedPrice(row.price), row.price)
      || row.usage !== null && !same(normalizedUsage(row.usage), row.usage) || row.reason !== null && !REASONS.has(row.reason)
      || note(row.note) !== row.note || row.configuration !== null && (!fields(row.configuration, ['enforceBalance', 'tokenLimit', 'resetQuota', 'quotaVersion'],
        ['enforceBalance', 'tokenLimit', 'resetQuota', 'quotaVersion']) || typeof row.configuration.enforceBalance !== 'boolean'
        || row.configuration.tokenLimit !== null && !integer(row.configuration.tokenLimit) || typeof row.configuration.resetQuota !== 'boolean'
        || !integer(row.configuration.quotaVersion))) throw error();
    if (row.type === 'balance_adjustment' && (!row.operationId || !row.accountId || row.amountMicros === 0 || row.requestId !== null)
      || row.type === 'price_updated' && (row.accountId !== null || row.price === null || row.model !== row.price.model || row.amountMicros !== 0)
      || row.type === 'account_configured' && (!row.accountId || row.configuration === null || row.amountMicros !== 0)) throw error();
    if (row.requestId !== null) {
      const request = requests.get(row.requestId);
      if (!['reserved', 'unresolved', 'settled', 'released'].includes(row.type) || row.accountId !== request.accountId || row.keyId !== request.keyId
        || row.model !== request.model || row.charged !== request.charged || !same(row.price, request.price)
        || row.reservedMicros !== request.reservedMicros || row.reservedTokens !== request.reservedTokens
        || row.type === 'settled' && (!request.usage || !same(row.usage, request.usage) || row.amountMicros !== -request.amountMicros)
        || row.type !== 'settled' && row.amountMicros !== 0) throw error();
      const rows = requestRows.get(row.requestId) ?? [];
      rows.push(row); requestRows.set(row.requestId, rows);
    }
    if (row.accountId !== null) balances.set(row.accountId, plus(balances.get(row.accountId) ?? 0, row.amountMicros));
    if (row.balanceMicros !== null && row.balanceMicros !== (balances.get(row.accountId) ?? 0)) throw error();
    rowIds.add(row.id); if (row.operationId !== null) operationIds.add(row.operationId);
  }
  for (const request of data.requests) {
    const rows = requestRows.get(request.requestId) ?? [];
    if (rows.filter(row => row.type === 'reserved').length !== 1 || rows.filter(row => ['settled', 'released'].includes(row.type)).length !== (terminal(request) ? 1 : 0)
      || request.resolutionOperationId !== null && !rows.some(row => row.operationId === request.resolutionOperationId)) throw error();
    if (request.status === 'settled') {
      lifetimes.set(request.accountId, plus(lifetimes.get(request.accountId) ?? 0, request.usage.totalTokens));
      if (request.quotaVersion === accounts.get(request.accountId).quotaVersion) used.set(request.accountId, plus(used.get(request.accountId) ?? 0, request.usage.totalTokens));
    }
  }
  for (const account of data.accounts) {
    if (account.balanceMicros !== (balances.get(account.accountId) ?? 0) || account.lifetimeTokens !== (lifetimes.get(account.accountId) ?? 0)
      || account.usedTokens !== (used.get(account.accountId) ?? 0)) throw error();
  }
  if (data.ledger.length + pendingBudget(data).rows > MAX_ROWS) throw error();
}

/** Single-owner atomic financial journal. It contains no prompts or upstream credentials. */
export class ClientBilling {
  #path;
  #now;
  #state = { version: 1, revision: 0, currency: 'CNY', prices: [], accounts: [], requests: [], ledger: [] };
  #queue = Promise.resolve();
  #closing = false;
  #closed = false;
  constructor({ path, now = Date.now } = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0') || typeof now !== 'function') throw new TypeError('Invalid ClientBilling options.');
    this.#path = resolve(path); this.#now = now;
  }
  static async open(options) {
    const billing = new ClientBilling(options);
    await billing.#load(); await billing.#recover();
    return billing;
  }
  #time() {
    const time = this.#now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 8_000_000_000_000_000) throw unavailable();
    return new Date(time).toISOString();
  }
  #ready() { if (this.#closed || this.#closing) throw unavailable(); }
  async #load() {
    let handle;
    try {
      const info = await lstat(this.#path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw error();
      handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw error();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw error();
      const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
      validateState(state); this.#state = state;
    } catch (cause) { if (cause.code !== 'ENOENT') throw unavailable(); }
    finally { await handle?.close(); }
  }
  #serialize(operation) {
    try { this.#ready(); } catch (cause) { return Promise.reject(cause); }
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {}); return result;
  }
  async #commit(next) {
    if (this.#state.revision >= Number.MAX_SAFE_INTEGER) throw limited();
    next.revision = this.#state.revision + 1;
    const future = pendingBudget(next), bytes = `${JSON.stringify(next)}\n`;
    if (next.accounts.length > MAX_ACCOUNTS || next.prices.length > MAX_PRICES || next.requests.length > MAX_REQUESTS
      || next.ledger.length + future.rows > MAX_ROWS || Buffer.byteLength(bytes) + future.bytes > MAX_FILE_BYTES) throw limited();
    const temporary = `${this.#path}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      try { const target = await lstat(this.#path); if (!target.isFile() || target.isSymbolicLink()) throw error(); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.#path);
    } catch { throw error('计费账本保存失败，原账目继续生效。', 503, 'client_billing_write_failed'); }
    finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
    this.#state = next;
  }
  #ensure(state, accountId, time) {
    let account = state.accounts.find(item => item.accountId === accountId);
    if (!account) { account = defaults(accountId, time); state.accounts.push(account); }
    return account;
  }
  #holds(state, accountId) {
    const holds = state.requests.filter(request => request.accountId === accountId && ACTIVE.has(request.status));
    return { reservedMicros: plus(...holds.map(request => request.reservedMicros)), reservedTokens: plus(...holds.map(request => request.reservedTokens)),
      pendingCount: holds.filter(request => request.status !== 'unresolved').length, unresolvedCount: holds.filter(request => request.status === 'unresolved').length,
      accountingBlocked: holds.some(request => request.reason === 'accounting_overflow') };
  }
  #publicAccount(state, accountId) {
    const account = state.accounts.find(item => item.accountId === accountId) ?? defaults(accountId, this.#time());
    const holds = this.#holds(state, accountId);
    return { accountId, enforceBalance: account.enforceBalance, balanceMicros: account.balanceMicros, ...holds,
      availableMicros: plus(account.balanceMicros, -holds.reservedMicros), tokenLimit: account.tokenLimit,
      usedTokens: account.usedTokens, lifetimeTokens: account.lifetimeTokens,
      remainingTokens: account.tokenLimit === null ? null : Number([0n, BigInt(account.tokenLimit) - BigInt(account.usedTokens) - BigInt(holds.reservedTokens)]
        .reduce((largest, value) => value > largest ? value : largest)) };
  }
  #request(state, requestId) {
    const request = state.requests.find(item => item.requestId === requestId);
    if (!request) throw error('计费请求不存在。', 404, 'client_billing_request_not_found');
    return request;
  }
  #row(state, { type, time, account = null, request = null, operationId = null, amountMicros = 0, price = null, configuration = null, note: text = '' }) {
    const row = { id: randomUUID(), sequence: state.ledger.length + 1, time, type, accountId: account?.accountId ?? null,
      requestId: request?.requestId ?? null, operationId, keyId: request?.keyId ?? null, model: request?.model ?? price?.model ?? null,
      status: request?.status ?? null, amountMicros, balanceMicros: account?.balanceMicros ?? null,
      reservedMicros: request?.reservedMicros ?? 0, reservedTokens: request?.reservedTokens ?? 0,
      charged: request?.charged ?? null, price: copied(request?.price ?? price), usage: copied(request?.usage ?? null),
      reason: request?.reason ?? null, note: text, configuration: copied(configuration) };
    state.ledger.push(row); return row;
  }
  async #recover() {
    const pending = this.#state.requests.filter(request => ['reserved', 'started'].includes(request.status));
    if (!pending.length) return;
    const next = copied(this.#state), time = this.#time();
    for (const old of pending) {
      const request = this.#request(next, old.requestId);
      request.status = 'unresolved'; request.reason = 'process_restart'; request.updatedAt = time;
      this.#row(next, { type: 'unresolved', time, account: this.#ensure(next, request.accountId, time), request });
    }
    await this.#commit(next);
  }
  snapshot() {
    this.#ready();
    const unresolved = this.outstanding({ limit: 100 });
    return { revision: this.#state.revision, currency: 'CNY', prices: copied(this.#state.prices),
      accounts: this.#state.accounts.map(account => this.#publicAccount(this.#state, account.accountId)), recent: copied(this.#state.ledger.slice(-100).reverse()),
      unresolved: unresolved.rows, unresolvedNextBefore: unresolved.nextBefore };
  }
  account(accountId) { this.#ready(); return this.#publicAccount(this.#state, id(accountId)); }
  outstanding(options = {}) {
    this.#ready();
    if (!fields(options, ['accountId', 'limit', 'before']) || options.accountId !== undefined && (typeof options.accountId !== 'string' || !UUID.test(options.accountId))
      || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)
      || options.before !== undefined && (typeof options.before !== 'string' || !UUID.test(options.before))) throw error('待核销分页参数无效。');
    const limit = options.limit ?? 50;
    let before = this.#state.requests.length;
    if (options.before !== undefined) {
      before = this.#state.requests.findIndex(request => request.requestId === options.before
        && (options.accountId === undefined || request.accountId === options.accountId));
      // A resolved cursor remains valid, so processing a page never invalidates the next page.
      if (before < 0) throw error('待核销分页位置不存在。', 400, 'invalid_client_billing_cursor');
    }
    const rows = [];
    for (let index = before - 1; index >= 0 && rows.length <= limit; index--) {
      const request = this.#state.requests[index];
      if (request.status === 'unresolved' && (options.accountId === undefined || request.accountId === options.accountId)) rows.push(request);
    }
    const page = rows.slice(0, limit);
    return { rows: page.map(request => ({ ...copied(request), time: request.createdAt })), nextBefore: rows.length > limit ? page.at(-1).requestId : null };
  }
  history(accountId, options = {}) {
    this.#ready(); id(accountId);
    if (!fields(options, ['limit', 'before']) || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)
      || options.before !== undefined && (typeof options.before !== 'string' || !UUID.test(options.before))) throw error('账单分页参数无效。');
    let before = Infinity;
    if (options.before !== undefined) {
      const row = this.#state.ledger.find(item => item.id === options.before && item.accountId === accountId);
      if (!row) throw error('账单分页位置不存在。', 400, 'invalid_client_billing_cursor');
      before = row.sequence;
    }
    const rows = this.#state.ledger.filter(row => row.accountId === accountId && row.sequence < before).reverse();
    const page = rows.slice(0, options.limit ?? 50);
    return { rows: copied(page), nextBefore: rows.length > page.length ? page.at(-1).id : null };
  }
  async setPrice(value) {
    const price = normalizedPrice(value);
    return this.#serialize(async () => {
      const next = copied(this.#state), index = next.prices.findIndex(item => item.model === price.model);
      if (index >= 0 && same(next.prices[index], price)) return copied(price);
      if (index >= 0) next.prices[index] = price; else next.prices.push(price);
      this.#row(next, { type: 'price_updated', time: this.#time(), price });
      await this.#commit(next); return copied(price);
    });
  }
  async configureAccount(accountId, options) {
    id(accountId);
    if (!fields(options, ['enforceBalance', 'tokenLimit', 'resetQuota']) || Object.keys(options).length === 0
      || options.enforceBalance !== undefined && typeof options.enforceBalance !== 'boolean'
      || options.tokenLimit !== undefined && options.tokenLimit !== null && !integer(options.tokenLimit)
      || options.resetQuota !== undefined && typeof options.resetQuota !== 'boolean') throw error('用户余额或 Token 配额设置无效。');
    const changes = copied(options);
    return this.#serialize(async () => {
      const next = copied(this.#state), time = this.#time(), account = this.#ensure(next, accountId, time);
      if (changes.resetQuota && next.requests.some(request => request.accountId === accountId && ACTIVE.has(request.status))) {
        throw error('此用户仍有未结算请求，请先核销再重置 Token 配额。', 409, 'client_billing_pending');
      }
      if (changes.enforceBalance !== undefined) account.enforceBalance = changes.enforceBalance;
      if (changes.tokenLimit !== undefined) account.tokenLimit = changes.tokenLimit;
      if (changes.resetQuota) { account.usedTokens = 0; account.quotaVersion = plus(account.quotaVersion, 1); }
      account.updatedAt = time;
      this.#row(next, { type: 'account_configured', time, account, configuration: {
        enforceBalance: account.enforceBalance, tokenLimit: account.tokenLimit, resetQuota: changes.resetQuota ?? false, quotaVersion: account.quotaVersion } });
      await this.#commit(next); return this.#publicAccount(next, accountId);
    });
  }
  async adjustBalance(accountId, options) {
    id(accountId);
    if (!fields(options, ['operationId', 'amountMicros', 'note'], ['operationId', 'amountMicros']) || !signed(options.amountMicros) || options.amountMicros === 0) throw error('余额调整须为非零安全整数微元。');
    const operationId = id(options.operationId), text = note(options.note), amountMicros = options.amountMicros;
    return this.#serialize(async () => {
      const previous = this.#state.ledger.find(row => row.operationId === operationId);
      if (previous) {
        if (previous.type !== 'balance_adjustment' || previous.accountId !== accountId || previous.amountMicros !== amountMicros || previous.note !== text) {
          throw error('相同操作标识已用于其他计费操作。', 409, 'client_billing_operation_conflict');
        }
        return this.#publicAccount(this.#state, accountId);
      }
      const next = copied(this.#state), time = this.#time(), account = this.#ensure(next, accountId, time);
      const balance = plus(account.balanceMicros, amountMicros);
      if (amountMicros < 0 && balance < this.#holds(next, accountId).reservedMicros) throw error('余额扣减不能占用已预留金额。', 409, 'client_billing_balance_reserved');
      account.balanceMicros = balance; account.updatedAt = time;
      this.#row(next, { type: 'balance_adjustment', time, account, operationId, amountMicros, note: text });
      await this.#commit(next); return this.#publicAccount(next, accountId);
    });
  }
  async reserve(options) {
    if (!fields(options, ['accountId', 'keyId', 'model', 'requestId'], ['accountId', 'keyId', 'model', 'requestId']) || !modelId(options.model)) throw error();
    id(options.accountId); id(options.keyId); id(options.requestId);
    const requestOptions = copied(options);
    return this.#serialize(async () => {
      const prior = this.#state.requests.find(request => request.requestId === requestOptions.requestId);
      if (prior) {
        if (prior.accountId !== requestOptions.accountId || prior.keyId !== requestOptions.keyId || prior.model !== requestOptions.model || terminal(prior)) {
          throw error('计费请求标识已被使用。', 409, 'client_billing_request_conflict');
        }
        return { requestId: prior.requestId };
      }
      const next = copied(this.#state), time = this.#time(), account = this.#ensure(next, requestOptions.accountId, time), holds = this.#holds(next, requestOptions.accountId);
      if (holds.accountingBlocked) throw error('此用户有计费溢出待核销，请联系管理员。', 503, 'client_billing_overflow');
      const price = copied(next.prices.find(item => item.model === requestOptions.model && item.enabled) ?? null);
      if (!price && (account.enforceBalance || account.tokenLimit !== null)) throw error('此模型尚未配置有效费率和请求预留 Token。', 503, 'client_billing_price_missing');
      const reservedTokens = price ? plus(price.reserveInputTokens, price.reserveOutputTokens) : 0;
      const reservedMicros = account.enforceBalance ? cost(price, { inputTokens: price.reserveInputTokens, outputTokens: price.reserveOutputTokens }, true) : 0;
      plus(holds.reservedTokens, reservedTokens); plus(holds.reservedMicros, reservedMicros);
      if (account.enforceBalance && plus(account.balanceMicros, -holds.reservedMicros) < reservedMicros) throw error('可用余额不足。', 402, 'client_billing_balance_exhausted');
      if (account.tokenLimit !== null && BigInt(account.usedTokens) + BigInt(holds.reservedTokens) + BigInt(reservedTokens) > BigInt(account.tokenLimit)) {
        throw error('可用 Token 配额不足。', 429, 'client_billing_quota_exhausted');
      }
      const request = { ...requestOptions, status: 'reserved', charged: account.enforceBalance, price, reservedMicros, reservedTokens, quotaVersion: account.quotaVersion,
        createdAt: time, startedAt: null, updatedAt: time, endedAt: null, usage: null, amountMicros: null, reason: null, resolutionOperationId: null };
      next.requests.push(request); this.#row(next, { type: 'reserved', time, account, request });
      await this.#commit(next); return { requestId: request.requestId };
    });
  }
  async begin(requestId) {
    id(requestId);
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId);
      if (current.status === 'started') return copied(current);
      if (current.status !== 'reserved') throw error('此请求不能再次开始。', 409, 'client_billing_request_final');
      const next = copied(this.#state), request = this.#request(next, requestId), time = this.#time();
      request.status = 'started'; request.startedAt = time; request.updatedAt = time;
      await this.#commit(next); return copied(request);
    });
  }
  #settlement(next, request, usage, time, operationId = null) {
    const account = this.#ensure(next, request.accountId, time);
    let amount, balance, used, lifetime;
    try {
      amount = request.charged ? cost(request.price, usage) : 0;
      balance = plus(account.balanceMicros, -amount); lifetime = plus(account.lifetimeTokens, usage.totalTokens);
      used = request.quotaVersion === account.quotaVersion ? plus(account.usedTokens, usage.totalTokens) : account.usedTokens;
      plus(balance, -this.#holds(next, request.accountId).reservedMicros, request.reservedMicros);
    } catch (cause) {
      if (cause.code !== 'client_billing_overflow') throw cause;
      const first = request.usage === null;
      request.status = 'unresolved'; request.usage = usage; request.reason = 'accounting_overflow'; request.updatedAt = time;
      if (first) this.#row(next, { type: 'unresolved', time, account, request });
      return false;
    }
    account.balanceMicros = balance; account.usedTokens = used; account.lifetimeTokens = lifetime; account.updatedAt = time;
    request.status = 'settled'; request.usage = usage; request.amountMicros = amount; request.updatedAt = time; request.endedAt = time;
    request.reason = operationId ? 'admin_settle' : null; request.resolutionOperationId = operationId;
    this.#row(next, { type: 'settled', time, account, request, operationId, amountMicros: -amount });
    return true;
  }
  async settle(requestId, usage) {
    id(requestId); const normalized = normalizedUsage(usage);
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId);
      if (current.status === 'settled' && same(current.usage, normalized)) return copied(current);
      if (terminal(current) || current.status === 'unresolved') throw error('此请求已结束或须由管理员核销。', 409, 'client_billing_request_final');
      const next = copied(this.#state), request = this.#request(next, requestId), settled = this.#settlement(next, request, normalized, this.#time());
      await this.#commit(next);
      if (!settled) throw error('实际用量已保留，计费溢出须由管理员处理。', 503, 'client_billing_overflow');
      return copied(request);
    });
  }
  #release(next, request, time, fixedReason, operationId = null) {
    request.status = 'released'; request.reason = fixedReason; request.updatedAt = time; request.endedAt = time;
    request.usage = null; request.amountMicros = 0; request.resolutionOperationId = operationId;
    this.#row(next, { type: 'released', time, account: this.#ensure(next, request.accountId, time), request, operationId });
  }
  async release(requestId, options = {}) {
    id(requestId);
    if (!fields(options, ['reason'])) throw error();
    const fixedReason = reason(options.reason, 'cancelled_before_upstream');
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId);
      if (current.status === 'released') return copied(current);
      if (current.status !== 'reserved') throw error('上游可能已执行，须保留预留并核销。', 409, 'client_billing_already_started');
      const next = copied(this.#state), request = this.#request(next, requestId);
      this.#release(next, request, this.#time(), fixedReason); await this.#commit(next); return copied(request);
    });
  }
  async reject(requestId) {
    id(requestId);
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId);
      if (current.status === 'released') return copied(current);
      if (current.status === 'settled') throw error('实际用量已结算，不能自动退款。', 409, 'client_billing_request_final');
      if (current.usage !== null) throw error('此请求已记录实际用量，不能自动退款。', 409, 'client_billing_request_final');
      const next = copied(this.#state), request = this.#request(next, requestId);
      this.#release(next, request, this.#time(), 'upstream_rejected'); await this.#commit(next); return copied(request);
    });
  }
  async markUnresolved(requestId, options = {}) {
    id(requestId);
    if (!fields(options, ['reason'])) throw error();
    const fixedReason = reason(options.reason, 'usage_missing');
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId);
      if (terminal(current) || current.status === 'unresolved') return copied(current);
      const next = copied(this.#state), request = this.#request(next, requestId), time = this.#time();
      request.status = 'unresolved'; request.reason = fixedReason; request.updatedAt = time;
      this.#row(next, { type: 'unresolved', time, account: this.#ensure(next, request.accountId, time), request });
      await this.#commit(next); return copied(request);
    });
  }
  async resolve(requestId, options) {
    id(requestId);
    if (!fields(options, ['operationId', 'action', 'usage'], ['operationId', 'action']) || !['release', 'settle'].includes(options.action)
      || options.action === 'release' && options.usage !== undefined) throw error('人工核销参数无效。');
    const operationId = id(options.operationId), action = options.action, usage = action === 'settle' ? normalizedUsage(options.usage) : null;
    return this.#serialize(async () => {
      const current = this.#request(this.#state, requestId), previous = this.#state.ledger.find(row => row.operationId === operationId);
      if (previous) {
        if (previous.requestId !== requestId || previous.type !== (action === 'release' ? 'released' : 'settled') || !same(previous.usage, usage)) {
          throw error('相同操作标识已用于其他计费操作。', 409, 'client_billing_operation_conflict');
        }
        return copied(current);
      }
      if (current.status !== 'unresolved') throw error('仅待核销请求可以人工处理。', 409, 'client_billing_not_unresolved');
      if (current.usage !== null && (action === 'release' || !same(current.usage, usage))) throw error('已有实际用量，不能丢弃或替换。', 409, 'client_billing_usage_conflict');
      const next = copied(this.#state), request = this.#request(next, requestId), time = this.#time();
      const settled = action === 'settle' ? this.#settlement(next, request, usage, time, operationId) : true;
      if (action === 'release') this.#release(next, request, time, 'admin_release', operationId);
      await this.#commit(next);
      if (!settled) throw error('实际用量已保留，计费溢出须由管理员处理。', 503, 'client_billing_overflow');
      return copied(request);
    });
  }
  async flush() { await this.#queue; }
  async close() {
    if (this.#closed) return;
    this.#closing = true; await this.#queue;
    try { await this.#recover(); } finally { this.#closed = true; }
  }
}
