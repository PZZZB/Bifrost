import { paymentError } from './topups.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quota = value => object(value) && value.type === 'quota' && Number.isSafeInteger(value.remaining) && value.remaining >= 0;
const invalid = () => { throw paymentError('payment_verification_failed', 502); };

function purchaseUrl(value, image = false) {
  if (typeof value !== 'string' || value.length > 8192) return invalid();
  let url;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password || url.port || url.hash) return invalid();
  const https = url.protocol === 'https:' && (url.hostname === 'pay.watcha.cn'
    || url.hostname === 'alipay.com' || url.hostname.endsWith('.alipay.com'));
  const app = !image && url.protocol === 'alipays:' && url.hostname === 'platformapi' && url.pathname === '/startapp';
  if (!https && !app) return invalid();
  return url.href;
}

/** An explicit rejection, unlike a timeout, proves this attempt did not debit. */
export class WatchaInsufficientQuota extends Error {
  constructor() { super('Provider quota is insufficient.'); this.code = 'watcha_insufficient_quota'; }
}

/** App-scoped entitlement API only. This does not verify payment orders, create
 * charges, sign contracts, issue refunds, or accept an unsigned payment event. */
export class WatchaEntitlements {
  #key;
  #entitlement;
  #fetch;
  #binding;
  constructor({ apiKey, applicationId, entitlementId, environment, fetchImpl = fetch } = {}) {
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(apiKey)
      || typeof applicationId !== 'string' || !/^app_[a-z0-9]{1,100}$/.test(applicationId)
      || typeof entitlementId !== 'string' || !/^ent_[a-z0-9]{1,100}$/.test(entitlementId)
      || !['sandbox', 'live'].includes(environment) || typeof fetchImpl !== 'function') {
      throw new TypeError('Private Watcha entitlement configuration required.');
    }
    this.#key = apiKey; this.#entitlement = entitlementId; this.#fetch = fetchImpl;
    this.#binding = JSON.stringify(['watcha', applicationId, environment, entitlementId]);
  }
  get binding() { return this.#binding; }
  async #request(path, body, consuming = false) {
    let response;
    try {
      response = await this.#fetch('https://pay.watcha.cn/v1/entitlements/' + path, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { authorization: 'Bearer ' + this.#key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ entitlement_id: this.#entitlement, ...body }),
      });
      if (response.status !== 200 && !(consuming && response.status === 409)) throw new Error();
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65_536) throw new Error();
        chunks.push(chunk);
      }
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (consuming && response.status === 409 && data?.error?.code === 'insufficient_quota') throw new WatchaInsufficientQuota();
      if (response.status !== 200 || !object(data) || Object.hasOwn(data, 'error')) throw new Error();
      return data;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof WatchaInsufficientQuota) throw error;
      // Raw errors can contain the key, the request body or a checkout ticket.
      throw paymentError('payments_unavailable', 503);
    }
  }
  async access(accountId) {
    if (typeof accountId !== 'string' || !UUID.test(accountId)) return invalid();
    const data = await this.#request('access', { user_id: accountId });
    if (!['granted', 'purchase_required', 'unavailable'].includes(data.access) || !quota(data.entitlement)) return invalid();
    if (data.access === 'unavailable' && (data.reason?.code !== 'purchasing_suspended' || data.entitlement.remaining !== 0)) return invalid();
    let purchase = null;
    if (data.purchase !== undefined) {
      if (!object(data.purchase) || data.access === 'unavailable') return invalid();
      purchase = { url: purchaseUrl(data.purchase.url) };
      // The purchase URL is sufficient; an optional image on another host is
      // omitted rather than making arbitrary image URLs available to clients.
      if (data.purchase.qr_code_url !== undefined) {
        try { purchase.qrCodeUrl = purchaseUrl(data.purchase.qr_code_url, true); } catch {}
      }
    }
    return { access: data.access, remaining: data.entitlement.remaining, purchase };
  }
  async consume(accountId, { points, operationId } = {}) {
    if (typeof accountId !== 'string' || !UUID.test(accountId) || !Number.isSafeInteger(points) || points <= 0
      || typeof operationId !== 'string' || !UUID.test(operationId)) return invalid();
    const data = await this.#request('consume', { user_id: accountId, amount: points, idempotency_key: operationId }, true);
    if (data.consumed !== points || !quota(data.entitlement)) return invalid();
    return { consumed: data.consumed, remaining: data.entitlement.remaining };
  }
}
