import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes, randomUUID, sign, createCipheriv } from 'node:crypto';
import { ClientAccess } from '../src/client-access.mjs';
import { ClientBilling } from '../src/client-billing.mjs';
import { ClientAdmin } from '../src/client-admin.mjs';
import { UnifiedWebAccounts } from '../src/unified-web-accounts.mjs';
import { createWebAccounts } from '../src/web-accounts.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';
import { createClientGatewayForwarder, loopbackHttpFetch } from '../src/client-gateway-forwarder.mjs';
import { PaymentTopups } from '../src/payments/topups.mjs';
import { AlipayPayments, alipaySigningText } from '../src/payments/alipay.mjs';
import { WechatPayments } from '../src/payments/wechat.mjs';

test('offline acceptance: signed WeChat and Alipay payments traverse the public gateway and credit the real shared account immediately once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-payment-acceptance-'));
  const makeKey = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const merchant = makeKey(), platform = makeKey(), origin = 'https://payments.example.test';
  const access = await ClientAccess.open({ path: join(directory, 'access.json'), allowedModelIds: [] });
  const billing = await ClientBilling.open({ path: join(directory, 'billing.json') });
  const password = 'Offline-acceptance-only-12345', account = await access.createAccount({ username: 'payer@example.test', password });
  await billing.configureAccount(account.id, { enforceBalance: true });
  const signedWechat = bytes => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'offline-acceptance';
    return { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'PUB_KEY_ID_ACCEPTANCE',
      'wechatpay-signature': sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), bytes, Buffer.from('\n')]), platform.privateKey).toString('base64') };
  };
  const alipay = new AlipayPayments({ appId: '2026000000000001', sellerId: '2088000000000001', privateKey: merchant.privateKey,
    alipayPublicKey: platform.publicKey, notifyUrl: origin + '/account/web/v1/payments/notify/alipay',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openapi.alipay.com/gateway.do');
      const fields = Object.fromEntries(new URLSearchParams(options.body)); assert.equal(fields.method, 'alipay.trade.precreate');
      const input = JSON.parse(fields.biz_content), raw = JSON.stringify({ code: '10000', out_trade_no: input.out_trade_no, qr_code: 'https://qr.alipay.com/offline-acceptance' });
      return new Response(`{"alipay_trade_precreate_response":${raw},"sign":"${sign('RSA-SHA256', Buffer.from(raw), platform.privateKey).toString('base64')}"}`);
    } });
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const wechat = new WechatPayments({ appId: 'wx0123456789abcdef', mchId: '1900000001', serialNo: '012345ABCDEF', privateKey: merchant.privateKey,
    apiV3Key, publicKeys: { PUB_KEY_ID_ACCEPTANCE: platform.publicKey }, notifyUrl: origin + '/account/web/v1/payments/notify/wechat',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/native'); assert.equal(options.method, 'POST');
      const bytes = Buffer.from(JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=offline-acceptance' }));
      return new Response(bytes, { headers: signedWechat(bytes) });
    } });
  const payments = await PaymentTopups.open({ path: join(directory, 'payment-orders.json'), access, billing, providers: [alipay, wechat],
    products: [{ id: 'cny-10', title: '离线验收商品', amountFen: 1000 }] });
  const store = new UnifiedWebAccounts({ access, billing, payments });
  const web = createWebAccounts({ store, payments, publicOrigin: origin, apiBaseUrl: origin + '/v1', csrfKey: randomBytes(32).toString('base64url') });
  const backend = http.createServer((req, res) => web.handle(req, res));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const forwarder = createClientGatewayForwarder({ fetchImpl: (url, options) => loopbackHttpFetch(url.replace(':43159/', `:${backend.address().port}/`), options) });
  const front = createExternalClaudeGateway({ gatewayKey: 'g'.repeat(64), sessionKey: 's'.repeat(64), allowedHosts: [new URL(origin).host],
    clientGateway: forwarder, getClients: () => [], fetchImpl: () => { throw new Error('No actual model or payment network requests allowed.'); } });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [front, backend]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await payments.close(); await access.close(); await billing.close(); await rm(directory, { recursive: true, force: true });
  });
  const jar = new Map(); let csrf;
  const request = (path, { method = 'GET', body, raw, headers = {}, callback = false } = {}) => new Promise((resolve, reject) => {
    const bytes = raw ?? (body ? Buffer.from(JSON.stringify(body)) : undefined);
    const req = http.request({ hostname: '127.0.0.1', port: front.address().port, path, method,
      headers: { host: new URL(origin).host, ...(!callback && jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(!callback && method !== 'GET' ? { origin, 'x-bifrost-csrf': csrf ?? '' } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers } }, res => {
      const parts = []; res.on('data', bytes => parts.push(bytes)); res.on('error', reject);
      res.on('end', () => {
        for (const value of res.headers['set-cookie'] ?? []) { const [part] = value.split(';'), index = part.indexOf('='); jar.set(part.slice(0, index), part.slice(index + 1)); }
        const text = Buffer.concat(parts).toString(); let data; try { data = JSON.parse(text); } catch {}
        if (data?.csrfToken) csrf = data.csrfToken; resolve({ status: res.statusCode, data, text });
      });
    }); req.on('error', reject); req.end(bytes);
  });
  await request('/account/web/v1/session');
  assert.equal((await request('/account/web/v1/login', { method: 'POST', body: { username: 'payer@example.test', password } })).status, 200);
  let expected = 0;
  for (const channel of ['alipay', 'wechat']) {
    const created = await request('/account/web/v1/topups', { method: 'POST', body: { channel, product: 'cny-10', requestId: randomUUID() } });
    assert.equal(created.status, 200); const id = created.data.order.orderId;
    let raw, headers;
    if (channel === 'alipay') {
      const fields = { app_id: alipay.appId, seller_id: alipay.sellerId, out_trade_no: id, trade_no: 'offline-' + id,
        total_amount: '10.00', trade_status: 'TRADE_SUCCESS', gmt_payment: '2026-10-25 20:00:00', sign_type: 'RSA2' };
      fields.sign = sign('RSA-SHA256', Buffer.from(alipaySigningText(fields)), platform.privateKey).toString('base64');
      raw = Buffer.from(new URLSearchParams(fields).toString()); headers = { 'content-type': 'application/x-www-form-urlencoded' };
    } else {
      const transaction = { appid: wechat.appId, mchid: wechat.mchId, out_trade_no: id, transaction_id: 'offline-' + id,
        trade_state: 'SUCCESS', amount: { total: 1000, currency: 'CNY' }, success_time: new Date().toISOString() };
      const nonce = '0123456789ab', cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce)); cipher.setAAD(Buffer.from('transaction'));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]);
      raw = Buffer.from(JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: {
        algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', nonce, associated_data: 'transaction', ciphertext: encrypted.toString('base64') } }));
      headers = signedWechat(raw);
    }
    const path = '/account/web/v1/payments/notify/' + channel;
    const notification = await request(path, { method: 'POST', raw, headers, callback: true });
    assert.equal(notification.status, channel === 'alipay' ? 200 : 204);
    expected += 10_000_000;
    assert.equal((await request('/account/web/v1/session')).data.billing.balanceMicros, expected);
    assert.equal((await request('/account/web/v1/topups/' + id)).data.order.status, 'credited');
    await request(path, { method: 'POST', raw, headers, callback: true }); assert.equal(billing.account(account.id).balanceMicros, expected);
  }
  const admin = new ClientAdmin({ access, billing, getModels: () => [], getEndpoint: () => ({}), getPaymentsStatus: () => payments.status() });
  const snapshot = await admin.snapshot(); assert.equal(snapshot.accounts.length, 1); assert.equal(snapshot.accounts[0].id, account.id);
  assert.equal(snapshot.accounts[0].billing.balanceMicros, 20_000_000); assert.equal(snapshot.payments.received, 0);
  assert.equal((await request('/account/web/v1/me', { method: 'DELETE' })).status, 409);
});
