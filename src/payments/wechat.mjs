import { createDecipheriv, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { paymentError } from './topups.mjs';

const reject = () => { throw paymentError('payment_verification_failed', 400); };
const merchant = value => typeof value === 'string' && /^\d{5,32}$/.test(value);
const keyId = value => typeof value === 'string' && /^(?:PUB_KEY_ID_[A-Za-z0-9]+|[A-Fa-f0-9]{1,64})$/.test(value);
const oneLine = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);

/** WeChat APIv3 Native, direct or service-provider mode. Pinned official keys
 * verify BOTH API replies and callbacks. Merchant eligibility is separate. */
export class WechatPayments {
  constructor({ appId, mchId, subMchId = null, serialNo, privateKey, apiV3Key, publicKeys, notifyUrl, fetchImpl = fetch, clock = Date.now }) {
    if (!/^wx[A-Za-z0-9]{16}$/.test(appId) || !merchant(mchId) || subMchId !== null && !merchant(subMchId)
      || !/^[A-Fa-f0-9]{1,64}$/.test(serialNo) || typeof apiV3Key !== 'string' || Buffer.byteLength(apiV3Key) !== 32
      || !publicKeys || Object.keys(publicKeys).length < 1 || Object.keys(publicKeys).length > 8) throw new TypeError('Invalid WeChat merchant.');
    const notify = new URL(notifyUrl);
    if (notify.protocol !== 'https:' || notify.username || notify.password || notify.search || notify.hash) throw new TypeError('Invalid payment callback.');
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new TypeError('RSA key required.');
    this.publicKeys = new Map();
    for (const [id, pem] of Object.entries(publicKeys)) {
      const publicKey = createPublicKey(pem);
      if (!keyId(id) || publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 2048) throw new TypeError('Invalid WeChat verification key.');
      this.publicKeys.set(id, publicKey);
    }
    Object.assign(this, { id: 'wechat', appId, mchId, subMchId, serialNo, privateKey: key, apiV3Key, notifyUrl, fetchImpl, clock });
    this.binding = JSON.stringify(['wechat', mchId, appId, subMchId]);
    this.basePath = `/v3/pay/${subMchId ? 'partner/' : ''}transactions`;
  }
  #verify(bytes, headers) {
    const timestamp = headers['wechatpay-timestamp'], nonce = headers['wechatpay-nonce'], serial = headers['wechatpay-serial'], signature = headers['wechatpay-signature'];
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || Math.abs(this.clock() / 1000 - Number(timestamp)) > 300
      || !oneLine(nonce) || !keyId(serial) || !this.publicKeys.has(serial) || typeof signature !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 1024) return reject();
    const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), bytes, Buffer.from('\n')]);
    if (!verify('RSA-SHA256', message, this.publicKeys.get(serial), Buffer.from(signature, 'base64'))) return reject();
  }
  async #request(method, path, input) {
    const body = input === undefined ? '' : JSON.stringify(input), nonce = randomBytes(16).toString('hex');
    const timestamp = Math.floor(this.clock() / 1000).toString();
    const signature = sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), this.privateKey).toString('base64');
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.serialNo}"`;
    let response;
    try {
      response = await this.fetchImpl('https://api.mch.weixin.qq.com' + path, { method,
        headers: { authorization, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length; if (size > 65_536) throw new Error('Payment response too large.'); chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      this.#verify(bytes, Object.fromEntries(response.headers));
      return { status: response.status, data: bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : null };
    } catch { await response?.body?.cancel().catch(() => {}); throw paymentError('payments_unavailable', 503); }
  }
  #merchantBody() {
    return this.subMchId ? { sp_appid: this.appId, sp_mchid: this.mchId, sub_mchid: this.subMchId } : { appid: this.appId, mchid: this.mchId };
  }
  #queryString() { return this.subMchId ? `sp_mchid=${this.mchId}&sub_mchid=${this.subMchId}` : `mchid=${this.mchId}`; }
  async create(order) {
    const result = await this.#request('POST', this.basePath + '/native', { ...this.#merchantBody(), description: order.title,
      out_trade_no: order.id, time_expire: order.expiresAt, notify_url: this.notifyUrl, amount: { total: order.amountFen, currency: 'CNY' } });
    if (result.status !== 200) throw paymentError('payments_unavailable', 503);
    return { type: 'qr', url: result.data.code_url };
  }
  #proof(data) {
    if (!data) return reject();
    const matches = this.subMchId ? data.sp_appid === this.appId && data.sp_mchid === this.mchId && data.sub_mchid === this.subMchId
      : data.appid === this.appId && data.mchid === this.mchId;
    if (!matches) return reject();
    const status = { SUCCESS: 'paid', NOTPAY: 'pending', USERPAYING: 'pending', CLOSED: 'closed', REVOKED: 'closed' }[data.trade_state];
    if (!status || !Number.isSafeInteger(data.amount?.total) || data.amount.currency !== 'CNY') return reject();
    let paidAt;
    if (status === 'paid') {
      if (typeof data.success_time !== 'string' || !Number.isFinite(Date.parse(data.success_time))) return reject();
      paidAt = new Date(data.success_time).toISOString();
    }
    return { orderId: data.out_trade_no, binding: this.binding, amountFen: data.amount.total, currency: 'CNY', status,
      ...(status === 'paid' ? { transactionId: data.transaction_id, paidAt } : {}) };
  }
  async query(order) {
    const result = await this.#request('GET', `${this.basePath}/out-trade-no/${order.id}?${this.#queryString()}`);
    if (result.status === 404 && result.data?.code === 'ORDER_NOT_EXIST') return null;
    if (result.status !== 200) throw paymentError('payments_unavailable', 503);
    if (result.data?.out_trade_no !== order.id) return reject();
    return this.#proof(result.data);
  }
  async close(order) {
    const result = await this.#request('POST', `${this.basePath}/out-trade-no/${order.id}/close`,
      this.subMchId ? { sp_mchid: this.mchId, sub_mchid: this.subMchId } : { mchid: this.mchId });
    if (result.status !== 204 && !['ORDERPAID', 'ORDERCLOSED', 'ORDER_NOT_EXIST'].includes(result.data?.code)) throw paymentError('payments_unavailable', 503);
    return result.status === 204 || ['ORDERCLOSED', 'ORDER_NOT_EXIST'].includes(result.data?.code);
  }
  verifyNotification(bytes, headers) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] ?? '') || bytes.length > 65_536) return reject();
    this.#verify(bytes, headers);
    let event, data;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (event.event_type !== 'TRANSACTION.SUCCESS' || event.resource_type !== 'encrypt-resource'
        || event.resource?.algorithm !== 'AEAD_AES_256_GCM' || event.resource.original_type !== 'transaction'
        || typeof event.resource.nonce !== 'string' || Buffer.byteLength(event.resource.nonce) !== 12
        || typeof event.resource.ciphertext !== 'string' || event.resource.associated_data !== undefined && typeof event.resource.associated_data !== 'string') return reject();
      const encrypted = Buffer.from(event.resource.ciphertext, 'base64');
      if (encrypted.length <= 16) return reject();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.apiV3Key), Buffer.from(event.resource.nonce));
      decipher.setAuthTag(encrypted.subarray(-16)); decipher.setAAD(Buffer.from(event.resource.associated_data ?? ''));
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()])));
    } catch { return reject(); }
    if (data.trade_state !== 'SUCCESS') return reject();
    return this.#proof(data);
  }
}
