import { createHash } from 'node:crypto';
import { paymentError } from './topups.mjs';

const invalid = () => { throw paymentError('payment_verification_failed', 400); };
const scalar = value => typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value);
const integer = value => typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : value;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The prose and PHP/Python examples specify ASCII sorting; the ordering printed
// in the documentation's hand-written example is inconsistent with that rule.
export function mianbaoduoSign(fields, key) {
  if (!object(fields) || typeof key !== 'string' || !key) throw new TypeError('Invalid signing input.');
  const names = Object.keys(fields).filter(name => name !== 'sign' && fields[name] !== '' && fields[name] !== null && fields[name] !== undefined).sort();
  if (names.some(name => !/^[a-z_]+$/.test(name) || !scalar(fields[name]))) throw new TypeError('Scalar payment parameters required.');
  return createHash('md5').update(names.map(name => `${name}=${fields[name]}`).join('&') + '&key=' + key, 'utf8').digest('hex');
}

/** Credentialed query/confirmation client, NOT an enabled checkout adapter.
 * The public unsigned webhook is only a wake-up hint. Funds are confirmed by a
 * fresh, credentialed request to the fixed HTTPS API, scoped to this app_id.
 * This client does not create charges, submit refunds or poll continuously. */
export class MianbaoduoPaymentClient {
  #appId;
  #key;
  #fetch;
  #clock;
  #cache = new Map();
  #windowEnd = 0;
  #queries = 0;
  constructor({ appId, appKey, fetchImpl = fetch, clock = Date.now } = {}) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(appId) || typeof appKey !== 'string'
      || !/^[\x21-\x7e]{16,256}$/.test(appKey) || typeof fetchImpl !== 'function' || typeof clock !== 'function') throw new TypeError('Private Mianbaoduo credentials required.');
    this.#appId = appId; this.#key = appKey; this.#fetch = fetchImpl; this.#clock = clock;
  }
  async #request(orderId) {
    const now = this.#clock();
    for (const [id, item] of this.#cache) if (item.until <= now && !item.inflight) this.#cache.delete(id);
    const cached = this.#cache.get(orderId);
    if (cached && (cached.inflight || cached.until > now)) return cached.promise;
    if (now >= this.#windowEnd) { this.#windowEnd = now + 60_000; this.#queries = 0; }
    // The provider warns against high-frequency queries. Coalesce duplicates,
    // cache for 30 seconds, and cap the complete client at 20 queries/minute.
    if (++this.#queries > 20) throw paymentError('payment_limit', 429);
    const fields = { app_id: this.#appId, out_trade_no: orderId };
    const entry = { inflight: true, until: now + 30_000, promise: null };
    entry.promise = (async () => {
      let response;
      try {
        response = await this.#fetch('https://newapi.mbd.pub/release/main/search_order', { method: 'POST', redirect: 'manual',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ...fields, sign: mianbaoduoSign(fields, this.#key) }), signal: AbortSignal.timeout(10_000) });
        if (response.status !== 200) throw new Error('Payment query unavailable.');
        const chunks = []; let size = 0;
        if (response.body) for await (const chunk of response.body) {
          size += chunk.length; if (size > 65_536) throw new Error('Payment response too large.'); chunks.push(chunk);
        }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!object(data) || Object.hasOwn(data, 'error')) throw new Error('Payment query unavailable.');
        // Never retain payer IDs, contact details, arbitrary provider messages or
        // refund/customer data beyond the fields necessary for this decision.
        return Object.fromEntries(['order_id', 'charge_id', 'amount', 'currency', 'state', 'create_time', 'payway', 'refund_state', 'refund_amount'].map(name => [name, data[name]]));
      } catch { await response?.body?.cancel().catch(() => {}); throw paymentError('payments_unavailable', 503); }
      finally { entry.inflight = false; }
    })();
    this.#cache.set(orderId, entry);
    // Retain failures briefly as well: forged repeat webhooks must not force an
    // unlimited stream of authenticated requests against the provider.
    return entry.promise;
  }
  #order(order) {
    if (!object(order) || !/^[a-f0-9]{32}$/.test(order.id) || !['wechat', 'alipay'].includes(order.channel)
      || !Number.isSafeInteger(order.amountFen) || order.amountFen < 1 || order.amountFen > 1_000_000) return invalid();
  }
  async queryPaid(order) {
    this.#order(order);
    const result = await this.#request(order.id), amount = integer(result.amount), payway = integer(result.payway), state = integer(result.state);
    if (result.order_id !== order.id || amount !== order.amountFen || payway !== (order.channel === 'wechat' ? 1 : 2)
      || result.currency !== undefined && result.currency !== 'CNY'
      || integer(result.refund_state) !== 0 || integer(result.refund_amount) !== 0 || ![0, 1, 2].includes(state)) return invalid();
    if (state === 0) return null;
    const seconds = integer(result.create_time);
    if (typeof result.charge_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result.charge_id)
      || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(this.#clock() / 1000) + 300) return invalid();
    return { orderId: order.id, transactionId: result.charge_id, amountFen: amount, currency: 'CNY', status: 'paid',
      paidAt: new Date(seconds * 1000).toISOString(), binding: JSON.stringify(['mianbaoduo', this.#appId, order.channel]) };
  }
  async confirmNotification(event, order) {
    this.#order(order);
    if (!object(event) || event.type !== 'charge_succeeded' || !object(event.data) || event.data.out_trade_no !== order.id
      || integer(event.data.amount) !== order.amountFen || integer(event.data.payway) !== (order.channel === 'wechat' ? 1 : 2)
      || typeof event.data.charge_id !== 'string') return invalid();
    const proof = await this.queryPaid(order);
    if (proof && proof.transactionId !== event.data.charge_id) return invalid();
    return proof; // null means unconfirmed, never permission to credit.
  }
}
