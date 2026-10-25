import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createCipheriv, sign, verify } from 'node:crypto';
import { AlipayPayments, alipaySigningText } from '../src/payments/alipay.mjs';
import { WechatPayments } from '../src/payments/wechat.mjs';
import { signedJsonEnvelope } from '../src/payments/signed-json.mjs';

const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const merchantKey = keys(), providerKey = keys(), wrongKey = keys();
const now = Date.parse('2026-10-25T12:00:00.000Z'), orderId = 'a'.repeat(32);
const order = { id: orderId, amountFen: 1000, title: '离线充值测试', expiresAt: new Date(now + 15 * 60_000).toISOString() };
const alipayConfig = { appId: '2026000000000001', sellerId: '2088000000000001', privateKey: merchantKey.privateKey,
  alipayPublicKey: providerKey.publicKey, notifyUrl: 'https://payments.example.test/account/web/v1/payments/notify/alipay', clock: () => now };
const alipayResult = { code: '10000', seller_id: alipayConfig.sellerId, out_trade_no: orderId, trade_no: '2026-offline-transaction',
  total_amount: '10.00', trade_status: 'TRADE_SUCCESS', send_pay_date: '2026-10-25 20:00:00' };
function alipayResponse(method, data, key = providerKey.privateKey, transform = raw => raw) {
  const raw = transform(JSON.stringify(data));
  return new Response(`{"${method.replaceAll('.', '_')}_response": ${raw},"sign":"${sign('RSA-SHA256', Buffer.from(raw), key).toString('base64')}"}`);
}
function alipayNotification(changes = {}, key = providerKey.privateKey) {
  const fields = { ...alipayResult, app_id: alipayConfig.appId, sign_type: 'RSA2', gmt_payment: '2026-10-25 20:00:00', ...changes };
  const signature = sign('RSA-SHA256', Buffer.from(alipaySigningText(fields)), key).toString('base64');
  return Buffer.from(new URLSearchParams({ ...fields, sign: signature }).toString());
}

test('Alipay signs requests, verifies original response JSON, and preserves exact CNY amount and merchant', async () => {
  const calls = [];
  const provider = new AlipayPayments({ ...alipayConfig, fetchImpl: async (url, options) => {
    calls.push({ url, options }); const form = Object.fromEntries(new URLSearchParams(options.body));
    const signed = Object.keys(form).filter(key => key !== 'sign').sort().map(key => `${key}=${form[key]}`).join('&');
    assert.ok(verify('RSA-SHA256', Buffer.from(signed), merchantKey.publicKey, Buffer.from(form.sign, 'base64')));
    assert.equal(form.app_id, alipayConfig.appId); assert.equal(form.timestamp, '2026-10-25 20:00:00');
    assert.equal(options.redirect, 'manual'); assert.equal(url, 'https://openapi.alipay.com/gateway.do');
    const body = JSON.parse(form.biz_content); assert.equal(body.out_trade_no, orderId);
    if (form.method === 'alipay.trade.precreate') {
      assert.equal(body.total_amount, '10.00'); assert.equal(form.notify_url, alipayConfig.notifyUrl);
      return alipayResponse(form.method, { code: '10000', out_trade_no: orderId, qr_code: 'https://qr.alipay.com/fixture' });
    }
    return alipayResponse(form.method, alipayResult, providerKey.privateKey, raw => raw.replaceAll(',', ', '));
  } });
  assert.deepEqual(await provider.create(order), { type: 'qr', url: 'https://qr.alipay.com/fixture' });
  const proof = await provider.query(order);
  assert.equal(proof.amountFen, 1000); assert.equal(proof.currency, 'CNY'); assert.equal(proof.status, 'paid');
  assert.equal(proof.paidAt, new Date(now).toISOString()); assert.equal(calls.length, 2);
});

test('Alipay rejects unsigned replies, wrong signing keys, redirects and order substitution', async () => {
  for (const response of [() => Response.json({ alipay_trade_query_response: alipayResult }),
    () => alipayResponse('alipay.trade.query', alipayResult, wrongKey.privateKey),
    () => new Response('', { status: 302, headers: { location: 'https://attacker.example/' } }),
    () => alipayResponse('alipay.trade.query', { ...alipayResult, out_trade_no: 'b'.repeat(32) }),
    () => alipayResponse('alipay.trade.query', { ...alipayResult, seller_id: '2088999999999999' }),
    () => alipayResponse('alipay.trade.query', { ...alipayResult, trans_currency: 'USD' })]) {
    let calls = 0;
    const provider = new AlipayPayments({ ...alipayConfig, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(provider.query(order)); assert.equal(calls, 1);
  }
});

test('Alipay validates notifications without double-decoding, and rejects duplicate fields, wrong merchant and amount syntax', () => {
  const provider = new AlipayPayments(alipayConfig), headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
  const valid = alipayNotification({ subject: '中文 + %2B & paid' });
  assert.equal(provider.verifyNotification(valid, headers).amountFen, 1000);
  for (const value of [Buffer.concat([valid, Buffer.from('&out_trade_no=other')]),
    alipayNotification({}, wrongKey.privateKey), alipayNotification({ app_id: '2026999999999999' }),
    alipayNotification({ seller_id: '2088999999999999' }), alipayNotification({ total_amount: '1e3' }),
    alipayNotification({ total_amount: '10.001' }), alipayNotification({ sign_type: 'RSA' }),
    Buffer.concat([valid, Buffer.from('&__proto__=polluted')])]) assert.throws(() => provider.verifyNotification(value, headers));
  assert.throws(() => provider.verifyNotification(valid, { 'content-type': 'application/json' }));
});

test('signed JSON preserves escaped text/nesting and rejects unsigned duplicate envelope shadowing', () => {
  const raw = ' { "result" : {"unicode":"\\u4e2d\\u6587", "nested":[{"quote":"\\\"sign\\\""}]}, "sign":"YWJj" } ';
  const result = signedJsonEnvelope(raw, 'result');
  assert.equal(result.data.unicode, '中文'); assert.ok(result.signed.includes('\\u4e2d'));
  for (const invalid of ['{"result":{},"result":{"amount":999},"sign":"YWJj"}',
    '{"result":{},"sign":"YWJj","sign":"ZXZpbA=="}', '{"result":{},"sign":"YWJj","extra":1}',
    '{"result":null,"sign":"YWJj"}', '{"result":{},"sign":"YWJj"} trailing']) assert.throws(() => signedJsonEnvelope(invalid, 'result'));
});

const wechatConfig = { appId: 'wx0123456789abcdef', mchId: '1900000001', serialNo: '012345ABCDEF', privateKey: merchantKey.privateKey,
  apiV3Key: '0123456789abcdef0123456789abcdef', publicKeys: { PUB_KEY_ID_OFFLINE: providerKey.publicKey },
  notifyUrl: 'https://payments.example.test/account/web/v1/payments/notify/wechat', clock: () => now };
const transaction = { appid: wechatConfig.appId, mchid: wechatConfig.mchId, out_trade_no: orderId, transaction_id: '4200-offline-fixture',
  trade_state: 'SUCCESS', amount: { total: 1000, payer_total: 900, currency: 'CNY' }, success_time: '2026-10-25T20:00:00+08:00' };
function signedWechat(bytes, { time = now, key = providerKey.privateKey, serial = 'PUB_KEY_ID_OFFLINE' } = {}) {
  const timestamp = String(Math.floor(time / 1000)), nonce = 'offline-signature-nonce';
  return { 'content-type': 'application/json', 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': serial,
    'wechatpay-signature': sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), bytes, Buffer.from('\n')]), key).toString('base64') };
}
function wechatNotification(data = transaction, changes = {}) {
  const nonce = '0123456789ab', aad = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(wechatConfig.apiV3Key), Buffer.from(nonce)); cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]);
  const event = { event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: { original_type: 'transaction',
    algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: aad, ciphertext: encrypted.toString('base64') }, ...changes };
  const bytes = Buffer.from(JSON.stringify(event)); return { bytes, headers: signedWechat(bytes) };
}

test('WeChat verifies signatures before authenticated AES-GCM decryption, using total order amount rather than discounted payer amount', () => {
  const provider = new WechatPayments(wechatConfig), event = wechatNotification();
  const proof = provider.verifyNotification(event.bytes, event.headers);
  assert.equal(proof.status, 'paid'); assert.equal(proof.amountFen, 1000); assert.equal(proof.paidAt, new Date(now).toISOString());
  for (const headers of [signedWechat(event.bytes, { key: wrongKey.privateKey }), signedWechat(event.bytes, { time: now - 301_000 }),
    signedWechat(event.bytes, { time: now + 301_000 }), signedWechat(event.bytes, { serial: 'PUB_KEY_ID_UNPINNED' }),
    { ...event.headers, 'wechatpay-nonce': 'two\nlines' }]) assert.throws(() => provider.verifyNotification(event.bytes, headers));
  const corrupt = Buffer.from(event.bytes.toString().replace('SUCCESS', 'FAILURE'));
  assert.throws(() => provider.verifyNotification(corrupt, event.headers));
  const encryptedCorrupt = JSON.parse(event.bytes); encryptedCorrupt.resource.ciphertext = Buffer.alloc(48).toString('base64');
  const bytes = Buffer.from(JSON.stringify(encryptedCorrupt)); assert.throws(() => provider.verifyNotification(bytes, signedWechat(bytes)));
});

test('WeChat direct/service-provider merchant IDs and success states must match the frozen route', () => {
  const provider = new WechatPayments(wechatConfig);
  for (const data of [{ ...transaction, mchid: '1900000002' }, { ...transaction, appid: 'wx1111111111111111' },
    { ...transaction, trade_state: 'REFUND' }, { ...transaction, amount: { total: 1000, currency: 'USD' } }]) {
    const event = wechatNotification(data); assert.throws(() => provider.verifyNotification(event.bytes, event.headers));
  }
  const partner = new WechatPayments({ ...wechatConfig, subMchId: '1900000002' });
  const event = wechatNotification({ ...transaction, sp_appid: wechatConfig.appId, sp_mchid: wechatConfig.mchId, sub_mchid: '1900000002' });
  assert.equal(partner.verifyNotification(event.bytes, event.headers).binding, partner.binding);
  const wrong = wechatNotification({ ...transaction, sp_appid: wechatConfig.appId, sp_mchid: wechatConfig.mchId, sub_mchid: '1900000003' });
  assert.throws(() => partner.verifyNotification(wrong.bytes, wrong.headers));
});

test('WeChat signs exact API path/body and verifies signed replies; unsigned replies and redirects fail closed', async () => {
  let requestCount = 0;
  const fetchImpl = async (url, options) => {
    requestCount++; const auth = Object.fromEntries([...options.headers.authorization.matchAll(/([a-z_]+)="([^"]+)"/g)].map(value => [value[1], value[2]]));
    const parsed = new URL(url), path = parsed.pathname + parsed.search;
    assert.equal(parsed.origin, 'https://api.mch.weixin.qq.com'); assert.equal(options.redirect, 'manual');
    const message = `${options.method}\n${path}\n${auth.timestamp}\n${auth.nonce_str}\n${options.body ?? ''}\n`;
    assert.ok(verify('RSA-SHA256', Buffer.from(message), merchantKey.publicKey, Buffer.from(auth.signature, 'base64')));
    const data = options.method === 'POST' ? { code_url: 'weixin://wxpay/bizpayurl?pr=fixture' } : transaction;
    const bytes = Buffer.from(JSON.stringify(data)); return new Response(bytes, { headers: signedWechat(bytes) });
  };
  const provider = new WechatPayments({ ...wechatConfig, fetchImpl });
  assert.equal((await provider.create(order)).type, 'qr'); assert.equal((await provider.query(order)).amountFen, 1000); assert.equal(requestCount, 2);
  for (const response of [() => Response.json(transaction), () => new Response('', { status: 302, headers: { location: 'https://attacker.example/' } })]) {
    let calls = 0; const bad = new WechatPayments({ ...wechatConfig, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(bad.query(order)); assert.equal(calls, 1);
  }
});
