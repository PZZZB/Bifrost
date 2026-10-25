import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MianbaoduoPaymentClient, mianbaoduoSign } from '../src/payments/mianbaoduo.mjs';

const key = 'offline-only-mbd-test-key-12345', id = 'a'.repeat(32);
const order = { id, channel: 'alipay', amountFen: 1000 };
const paid = { order_id: id, charge_id: 'offline-transaction', amount: '1000', state: '1', create_time: '1792929600', payway: '2', refund_state: '0', refund_amount: '0' };
const event = { type: 'charge_succeeded', data: { out_trade_no: id, amount: 1000, payway: 2, charge_id: paid.charge_id } };
function client(data = paid) { return new MianbaoduoPaymentClient({ appId: '12345', appKey: key, fetchImpl: async () => Response.json(data) }); }

test('Mianbaoduo signing follows ASCII sorting and retains integer zero, without encoding content twice', () => {
  const text = 'amount_total=1000&app_id=12345&description=中文 + & %=x&out_trade_no=abc&zero=0&key=' + key;
  const fields = { out_trade_no: 'abc', app_id: '12345', amount_total: 1000, description: '中文 + & %=x', zero: 0, absent: null, empty: '', sign: 'not-signed' };
  assert.equal(mianbaoduoSign(fields, key), createHash('md5').update(text).digest('hex'));
  assert.throws(() => mianbaoduoSign({ nested: { invalid: true } }, key));
});

test('an unsigned success notification requires an independent credentialed HTTPS query', async () => {
  let calls = 0;
  const api = new MianbaoduoPaymentClient({ appId: '12345', appKey: key, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://newapi.mbd.pub/release/main/search_order'); assert.equal(options.redirect, 'manual');
    const body = JSON.parse(options.body); assert.equal(body.app_id, '12345'); assert.equal(body.out_trade_no, id);
    assert.equal(body.sign, createHash('md5').update('app_id=12345&out_trade_no=' + id + '&key=' + key).digest('hex'));
    assert.equal(options.body.includes(key), false);
    return Response.json({ ...paid, payer_phone: 'do-not-retain', openid: 'do-not-retain' });
  } });
  const proof = await api.confirmNotification(event, order);
  assert.equal(calls, 1); assert.equal(proof.status, 'paid'); assert.equal(proof.amountFen, 1000);
  assert.equal(JSON.stringify(proof).includes('do-not-retain'), false); assert.equal(JSON.stringify(api).includes(key), false);
});

test('forged success cannot credit an unpaid order, and mismatched/refunded/disputed results reject', async () => {
  assert.equal(await client({ ...paid, state: '0' }).confirmNotification(event, order), null);
  for (const changes of [{ amount: '999' }, { order_id: 'b'.repeat(32) }, { payway: '1' }, { refund_state: '1' },
    { refund_amount: '1' }, { state: '3' }, { charge_id: 'wrong-transaction' }, { state: 'unknown' }, { amount: '1e3' },
    { currency: 'USD' }, { create_time: '999999999999' }]) {
    await assert.rejects(client({ ...paid, ...changes }).confirmNotification(event, order));
  }
  await assert.rejects(client().confirmNotification({ type: 'complaint', data: event.data }, order));
  await assert.rejects(client().confirmNotification(event, { ...order, id: '../../other' }));
});

test('duplicate webhook queries coalesce and respect a cooldown; provider errors never confirm funds', async () => {
  let calls = 0, now = Date.parse('2026-10-26T00:00:00+08:00');
  const api = new MianbaoduoPaymentClient({ appId: '12345', appKey: key, clock: () => now, fetchImpl: async () => { calls++; return Response.json(paid); } });
  await Promise.all(Array.from({ length: 20 }, () => api.confirmNotification(event, order))); assert.equal(calls, 1);
  now += 30_001; await api.confirmNotification(event, order); assert.equal(calls, 2);
  for (const response of [() => new Response('', { status: 302, headers: { location: 'https://attacker.example' } }),
    () => Response.json({ error: 'raw-provider-error-never-exposed' }), () => new Response('not-json'), () => Response.json({ padding: 'x'.repeat(70_000) })]) {
    const bad = new MianbaoduoPaymentClient({ appId: '12345', appKey: key, fetchImpl: async () => response() });
    await assert.rejects(bad.confirmNotification(event, order), error => error.code === 'payments_unavailable' && !error.message.includes('raw-provider-error'));
  }
});

test('query budget caps distinct unpaid orders rather than allowing callbacks to exhaust provider quotas', async () => {
  let calls = 0;
  const api = new MianbaoduoPaymentClient({ appId: '12345', appKey: key, fetchImpl: async (_url, options) => {
    calls++; return Response.json({ ...paid, order_id: JSON.parse(options.body).out_trade_no, state: '0' });
  } });
  for (let index = 0; index < 20; index++) await api.queryPaid({ ...order, id: index.toString(16).padStart(32, '0') });
  await assert.rejects(api.queryPaid({ ...order, id: 'f'.repeat(32) }), error => error.code === 'payment_limit'); assert.equal(calls, 20);
});
