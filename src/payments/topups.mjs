import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readPrivateAccountFile, writePrivateAccountRecord } from '../private-account-files.mjs';
import { BridgeError } from '../storage.mjs';

export const PAYMENT_ERRORS = {
  payments_unavailable: '自动充值暂未开放。', payment_invalid: '充值请求不正确。',
  payment_not_found: '充值订单不存在。', payment_conflict: '订单信息不一致，请刷新页面。',
  payment_limit: '待处理订单较多，请稍后重试。', payment_verification_failed: '支付结果校验失败。',
  payment_write_failed: '订单保存暂时失败，请稍后查询订单状态。',
  payment_billing_required: '此账号尚未启用余额计费，请联系管理员。',
  payment_account_pending: '此账号仍有余额或未处理的充值订单，暂不能注销。',
};
export const paymentError = (code = 'payment_invalid', status = 400) => new BridgeError(PAYMENT_ERRORS[code], status, code);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{32}$/;
const CHANNELS = new Set(['alipay', 'wechat']);
const MAX_ORDERS = 20_000, MAX_BYTES = 32 * 1024 * 1024;
const active = row => ['pending', 'received', 'review'].includes(row.status);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const text = (value, length = 256) => typeof value === 'string' && value.length > 0 && value.length <= length && !/[\x00-\x1f\x7f]/.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const fen = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;

export function validCheckout(channel, value) {
  if (!exact(value, ['type', 'url']) || value.type !== 'qr' || !text(value.url, 2048)) return false;
  try {
    const url = new URL(value.url);
    if (url.username || url.password || url.hash) return false;
    return channel === 'alipay' ? url.protocol === 'https:' && url.hostname === 'qr.alipay.com' && !url.port
      : url.protocol === 'weixin:' && url.hostname === 'wxpay' && url.pathname === '/bizpayurl';
  } catch { return false; }
}

function validate(data) {
  if (!exact(data, ['version', 'orders']) || data.version !== 1 || !Array.isArray(data.orders) || data.orders.length > MAX_ORDERS) throw paymentError();
  const ids = new Set(), requests = new Set(), operations = new Set(), transactions = new Set();
  for (const row of data.orders) {
    if (!exact(row, ['id', 'accountId', 'requestId', 'operationId', 'channel', 'binding', 'sku', 'title', 'amountFen', 'creditMicros',
      'createdAt', 'expiresAt', 'status', 'checkout', 'receipt', 'creditedAt']) || !ID.test(row.id) || !UUID.test(row.accountId)
      || !UUID.test(row.requestId) || !UUID.test(row.operationId) || !CHANNELS.has(row.channel) || !text(row.binding)
      || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(row.sku) || !text(row.title, 80) || !fen(row.amountFen)
      || row.creditMicros !== row.amountFen * 10_000 || !iso(row.createdAt) || !iso(row.expiresAt)
      || Date.parse(row.expiresAt) <= Date.parse(row.createdAt) || !['pending', 'received', 'credited', 'closed', 'review'].includes(row.status)
      || row.checkout !== null && !validCheckout(row.channel, row.checkout)
      || row.creditedAt !== null && !iso(row.creditedAt) || (row.status === 'credited') !== (row.creditedAt !== null)) throw paymentError();
    const request = row.accountId + ':' + row.requestId;
    if (ids.has(row.id) || requests.has(request) || operations.has(row.operationId)) throw paymentError();
    ids.add(row.id); requests.add(request); operations.add(row.operationId);
    if (row.receipt !== null) {
      if (!exact(row.receipt, ['transactionId', 'paidAt']) || !text(row.receipt.transactionId, 128) || !iso(row.receipt.paidAt)
        || !['received', 'credited', 'review'].includes(row.status)) throw paymentError();
      const transaction = JSON.stringify([row.channel, row.binding, row.receipt.transactionId]);
      if (transactions.has(transaction)) throw paymentError();
      transactions.add(transaction);
    } else if (['received', 'credited', 'review'].includes(row.status)) throw paymentError();
  }
  return data;
}

/** Own this journal in the SAME process as ClientBilling. Receipts are an outbox,
 * never an independent balance store. No provider credentials or payer PII here. */
export class PaymentTopups {
  #data = { version: 1, orders: [] };
  #queue = Promise.resolve();
  #closed = false;
  #inflight = new Set();
  #cursor = 0;
  constructor({ path, billing, access, providers = [], products = [], clock = Date.now }) {
    if (!path || !billing || !access || typeof clock !== 'function' || !Array.isArray(providers) || providers.length > 2
      || !Array.isArray(products) || products.length > 16) throw new TypeError('Invalid payment settings.');
    this.path = resolve(path); this.billing = billing; this.access = access; this.clock = clock;
    this.providers = new Map(); this.products = new Map();
    for (const provider of providers) {
      if (!CHANNELS.has(provider.id) || this.providers.has(provider.id) || !text(provider.binding)
        || ['create', 'query', 'close', 'verifyNotification'].some(name => typeof provider[name] !== 'function')) throw new TypeError('Invalid payment provider.');
      this.providers.set(provider.id, provider);
    }
    for (const product of products) {
      if (!exact(product, ['id', 'title', 'amountFen']) || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(product.id)
        || !text(product.title, 80) || !fen(product.amountFen) || this.products.has(product.id)) throw new TypeError('Invalid payment product.');
      this.products.set(product.id, Object.freeze({ ...product }));
    }
  }
  static async open(options) {
    const service = new PaymentTopups(options);
    try { service.#data = validate(JSON.parse(await readPrivateAccountFile(service.path, MAX_BYTES))); }
    catch (error) { if (error.code !== 'ENOENT') throw paymentError('payments_unavailable', 503); }
    return service;
  }
  #run(operation) {
    if (this.#closed) return Promise.reject(paymentError('payments_unavailable', 503));
    const result = this.#queue.then(operation); this.#queue = result.catch(() => {}); return result;
  }
  async #save(next) {
    validate(next);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw paymentError('payment_limit', 503);
    try { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await writePrivateAccountRecord(this.path, next); }
    catch { throw paymentError('payment_write_failed', 503); }
    this.#data = next;
  }
  #identity(accountId) {
    let account;
    try { account = this.access.publicAccount(accountId); } catch {}
    if (!account?.enabled) throw paymentError('payment_not_found', 404);
    return account;
  }
  #public(row) {
    return { orderId: row.id, channel: row.channel, product: row.sku, title: row.title, amountFen: row.amountFen,
      creditMicros: row.creditMicros, currency: 'CNY', createdAt: row.createdAt, expiresAt: row.expiresAt,
      status: row.status, creditedAt: row.creditedAt,
      checkout: row.status === 'pending' && this.clock() < Date.parse(row.expiresAt) ? structuredClone(row.checkout) : null };
  }
  catalog() {
    return { enabled: !this.#closed && this.providers.size > 0 && this.products.size > 0
        && !this.#data.orders.some(row => row.receipt && row.status !== 'credited'),
      channels: [...this.providers.keys()], currency: 'CNY', products: [...this.products.values()].map(value => ({ ...value, creditMicros: value.amountFen * 10_000 })) };
  }
  list(accountId) {
    this.#identity(accountId);
    return { ...this.catalog(), orders: this.#data.orders.filter(row => row.accountId === accountId).slice(-20).reverse().map(row => this.#public(row)) };
  }
  get(accountId, id) {
    this.#identity(accountId);
    const row = this.#data.orders.find(value => value.id === id && value.accountId === accountId);
    if (!row) throw paymentError('payment_not_found', 404);
    return this.#public(row);
  }
  hasPending(accountId) { return this.#data.orders.some(row => row.accountId === accountId && active(row)); }
  status() {
    return { enabled: this.catalog().enabled, received: this.#data.orders.filter(row => row.status === 'received').length,
      review: this.#data.orders.filter(row => row.status === 'review').length,
      pending: this.#data.orders.filter(row => row.status === 'pending').length };
  }
  async create(accountId, input) {
    if (!exact(input, ['channel', 'product', 'requestId']) || !UUID.test(input.requestId)) throw paymentError();
    let created = false;
    const order = await this.#run(async () => {
      this.#identity(accountId);
      const previous = this.#data.orders.find(row => row.accountId === accountId && row.requestId === input.requestId);
      if (previous) {
        if (previous.channel !== input.channel || previous.sku !== input.product) throw paymentError('payment_conflict', 409);
        return structuredClone(previous);
      }
      if (!this.catalog().enabled || !this.providers.has(input.channel)) throw paymentError('payments_unavailable', 503);
      const product = this.products.get(input.product);
      if (!product) throw paymentError();
      if (!this.billing.account(accountId).enforceBalance) throw paymentError('payment_billing_required', 409);
      const mine = this.#data.orders.filter(row => row.accountId === accountId), now = this.clock();
      if (mine.filter(active).length >= 3 || mine.filter(row => now - Date.parse(row.createdAt) < 15 * 60_000).length >= 10
        || this.#data.orders.length >= MAX_ORDERS) throw paymentError('payment_limit', 429);
      const row = { id: randomBytes(16).toString('hex'), accountId, requestId: input.requestId, operationId: randomUUID(),
        channel: input.channel, binding: this.providers.get(input.channel).binding, sku: product.id, title: product.title,
        amountFen: product.amountFen, creditMicros: product.amountFen * 10_000, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 15 * 60_000).toISOString(), status: 'pending', checkout: null, receipt: null, creditedAt: null };
      const next = structuredClone(this.#data); next.orders.push(row); await this.#save(next); created = true;
      return structuredClone(row);
    });
    if (!created) return this.#public(order);
    const action = (async () => {
      try {
        const checkout = await this.providers.get(order.channel).create(order);
        if (!validCheckout(order.channel, checkout)) throw paymentError('payment_verification_failed', 502);
        await this.#run(async () => {
          const next = structuredClone(this.#data), row = next.orders.find(value => value.id === order.id);
          if (row.status === 'pending') { row.checkout = checkout; await this.#save(next); }
        });
      } catch {
        // A timed-out request may have reached the provider. Keep its SAME order
        // ID, show processing, and query it; never blindly create a replacement.
      }
    })();
    this.#inflight.add(action); try { await action; } finally { this.#inflight.delete(action); }
    return this.get(accountId, order.id);
  }
  async #credit(id) {
    const current = this.#data.orders.find(row => row.id === id);
    if (!current?.receipt || current.status === 'credited') return;
    const next = structuredClone(this.#data), row = next.orders.find(value => value.id === id);
    // A deleted identity is held for review/refund; never credit a newly created
    // account with the same email. Disabled accounts retain their original ledger.
    try { this.access.publicAccount(row.accountId); }
    catch { if (row.status !== 'review') { row.status = 'review'; await this.#save(next); } return; }
    await this.billing.adjustBalance(row.accountId, { operationId: row.operationId, amountMicros: row.creditMicros,
      note: `payment:${row.channel}:${row.id}` });
    row.status = 'credited'; row.creditedAt = new Date(this.clock()).toISOString(); await this.#save(next);
  }
  async #accept(channel, proof) {
    if (!proof || !ID.test(proof.orderId) || !text(proof.binding) || !['paid', 'pending', 'closed'].includes(proof.status)) {
      throw paymentError('payment_verification_failed', 400);
    }
    return this.#run(async () => {
      const current = this.#data.orders.find(row => row.id === proof.orderId && row.channel === channel);
      if (!current) throw paymentError('payment_not_found', 404);
      if (proof.binding !== current.binding || proof.currency !== 'CNY' || proof.amountFen !== current.amountFen) throw paymentError('payment_verification_failed', 400);
      if (proof.status !== 'paid') {
        if (proof.status === 'closed' && !current.receipt && current.status !== 'closed') {
          const next = structuredClone(this.#data); next.orders.find(row => row.id === current.id).status = 'closed'; await this.#save(next);
        }
        return;
      }
      if (!text(proof.transactionId, 128) || !iso(proof.paidAt)) throw paymentError('payment_verification_failed', 400);
      if (current.receipt && current.receipt.transactionId !== proof.transactionId || this.#data.orders.some(row => row.id !== current.id
        && row.channel === channel && row.binding === proof.binding && row.receipt?.transactionId === proof.transactionId)) throw paymentError('payment_conflict', 409);
      if (!current.receipt) {
        const next = structuredClone(this.#data), row = next.orders.find(value => value.id === current.id);
        row.receipt = { transactionId: proof.transactionId, paidAt: proof.paidAt }; row.status = 'received';
        await this.#save(next); // The outbox is durable BEFORE the balance write.
      }
      await this.#credit(current.id);
    });
  }
  async notify(channel, bytes, headers) {
    const provider = this.providers.get(channel);
    if (!provider) throw paymentError('payments_unavailable', 503);
    const proof = await provider.verifyNotification(bytes, headers);
    if (proof) await this.#accept(channel, proof);
  }
  async reconcile() {
    await this.#run(async () => {
      for (const row of this.#data.orders.filter(value => ['received', 'review'].includes(value.status))) {
        try { await this.#credit(row.id); } catch { /* Keep the durable receipt for retry. */ }
      }
    });
    const pending = this.#data.orders.filter(row => row.status === 'pending');
    for (let offset = 0; offset < Math.min(5, pending.length); offset++) {
      const row = pending[(this.#cursor + offset) % pending.length], provider = this.providers.get(row.channel);
      if (!provider || provider.binding !== row.binding) continue;
      try {
        const proof = await provider.query(row);
        if (proof) await this.#accept(row.channel, proof);
        if (this.#data.orders.find(value => value.id === row.id).status === 'pending' && this.clock() >= Date.parse(row.expiresAt)) {
          // Closing is provider-side. A verified late success is still accepted.
          const closed = await provider.close(row);
          const final = await provider.query(row); if (final) await this.#accept(row.channel, final);
          else if (closed === true) await this.#accept(row.channel, { orderId: row.id, binding: row.binding, amountFen: row.amountFen, currency: 'CNY', status: 'closed' });
        }
      } catch { /* A network error never means paid or closed. */ }
    }
    this.#cursor = pending.length ? (this.#cursor + 5) % pending.length : 0;
  }
  async close() {
    await Promise.allSettled([...this.#inflight]); await this.#queue; this.#closed = true;
  }
}
