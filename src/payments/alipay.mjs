import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { paymentError } from './topups.mjs';
import { signedJsonEnvelope } from './signed-json.mjs';

const reject = () => { throw paymentError('payment_verification_failed', 400); };
const amount = value => {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) return reject();
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result <= 0 || result > 1_000_000) return reject();
  return result;
};
const paymentTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return reject();
  const date = new Date(value.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(date.getTime())) return reject();
  return date.toISOString();
};

export const alipaySigningText = fields => Object.keys(fields).filter(key => !['sign', 'sign_type'].includes(key) && fields[key] !== '')
  .sort().map(key => `${key}=${fields[key]}`).join('&');

/** Official Alipay APIv2, RSA2 and signed API responses. Product/category approval
 * is required separately; this adapter does not convert a personal QR to an API. */
export class AlipayPayments {
  constructor({ appId, sellerId, privateKey, alipayPublicKey, notifyUrl, fetchImpl = fetch, clock = Date.now }) {
    if (!/^\d{16}$/.test(appId) || !/^2088\d{12}$/.test(sellerId)) throw new TypeError('Invalid Alipay merchant.');
    const notify = new URL(notifyUrl);
    if (notify.protocol !== 'https:' || notify.username || notify.password || notify.search || notify.hash) throw new TypeError('Invalid payment callback.');
    const privateObject = createPrivateKey(privateKey), publicObject = createPublicKey(alipayPublicKey);
    if (![privateObject, publicObject].every(key => key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048)) throw new TypeError('RSA2 keys required.');
    this.id = 'alipay'; this.appId = appId; this.sellerId = sellerId; this.notifyUrl = notifyUrl;
    this.binding = JSON.stringify([this.id, appId, sellerId]);
    this.privateKey = privateObject; this.publicKey = publicObject; this.fetchImpl = fetchImpl; this.clock = clock;
  }
  async #exec(method, body, extra = {}) {
    const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(this.clock());
    const fields = { app_id: this.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', version: '1.0', timestamp,
      ...extra, biz_content: JSON.stringify(body) };
    // Request signatures INCLUDE sign_type. Alipay payment notifications omit it.
    const signed = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
    fields.sign = sign('RSA-SHA256', Buffer.from(signed), this.privateKey).toString('base64');
    let response;
    try {
      response = await this.fetchImpl('https://openapi.alipay.com/gateway.do', { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' },
        body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(10_000) });
      if (response.status !== 200) throw new Error('Payment API unavailable.');
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length; if (size > 65_536) throw new Error('Payment response too large.'); chunks.push(chunk);
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const envelope = signedJsonEnvelope(raw, method.replaceAll('.', '_') + '_response');
      if (!verify('RSA-SHA256', Buffer.from(envelope.signed), this.publicKey, Buffer.from(envelope.signature, 'base64'))) return reject();
      return envelope.data;
    } catch { await response?.body?.cancel().catch(() => {}); throw paymentError('payments_unavailable', 503); }
  }
  async create(order) {
    const result = await this.#exec('alipay.trade.precreate', { out_trade_no: order.id,
      total_amount: (order.amountFen / 100).toFixed(2), subject: order.title, timeout_express: '15m' }, { notify_url: this.notifyUrl });
    if (result.code !== '10000' || result.out_trade_no !== order.id) throw paymentError('payments_unavailable', 503);
    return { type: 'qr', url: result.qr_code };
  }
  #proof(data, notification = false) {
    if (notification && data.app_id !== this.appId || data.seller_id !== this.sellerId) return reject();
    const status = { TRADE_SUCCESS: 'paid', TRADE_FINISHED: 'paid', TRADE_CLOSED: 'closed', WAIT_BUYER_PAY: 'pending' }[data.trade_status];
    if (!status || data.trans_currency !== undefined && data.trans_currency !== 'CNY') return reject();
    return { orderId: data.out_trade_no, binding: this.binding, amountFen: amount(data.total_amount), currency: 'CNY', status,
      ...(status === 'paid' ? { transactionId: data.trade_no, paidAt: paymentTime(data.gmt_payment ?? data.send_pay_date) } : {}) };
  }
  async query(order) {
    const result = await this.#exec('alipay.trade.query', { out_trade_no: order.id });
    if (result.code !== '10000') {
      if (result.sub_code === 'ACQ.TRADE_NOT_EXIST') return null;
      throw paymentError('payments_unavailable', 503);
    }
    if (result.out_trade_no !== order.id) return reject();
    return this.#proof(result);
  }
  async close(order) {
    const result = await this.#exec('alipay.trade.close', { out_trade_no: order.id });
    if (result.code !== '10000' && !['ACQ.TRADE_NOT_EXIST', 'ACQ.TRADE_HAS_CLOSE', 'ACQ.TRADE_STATUS_ERROR'].includes(result.sub_code)) {
      throw paymentError('payments_unavailable', 503);
    }
    return result.code === '10000' || ['ACQ.TRADE_NOT_EXIST', 'ACQ.TRADE_HAS_CLOSE'].includes(result.sub_code);
  }
  verifyNotification(bytes, headers) {
    if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '') || bytes.length > 65_536) return reject();
    let values;
    try { values = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return reject(); }
    const fields = Object.create(null);
    for (const [key, value] of values) {
      if (Object.hasOwn(fields, key) || ['__proto__', 'prototype', 'constructor'].includes(key) || Object.keys(fields).length >= 100) return reject();
      fields[key] = value;
    }
    if (fields.sign_type !== 'RSA2' || typeof fields.sign !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields.sign)
      || fields.sign.length > 1024 || !verify('RSA-SHA256', Buffer.from(alipaySigningText(fields)), this.publicKey, Buffer.from(fields.sign, 'base64'))) return reject();
    return this.#proof(fields, true);
  }
}
