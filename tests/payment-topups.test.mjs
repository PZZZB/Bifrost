import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientBilling } from '../src/client-billing.mjs';
import { PaymentTopups } from '../src/payments/topups.mjs';
import { loadPaymentRuntime } from '../src/payments/runtime.mjs';

const denied = code => error => error.code === code;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-payments-'));
  const path = join(directory, 'payment-orders.json');
  const billing = await ClientBilling.open({ path: join(directory, 'billing.json') });
  let time = Date.parse('2026-10-25T12:00:00.000Z');
  const alice = randomUUID(), bob = randomUUID(), accounts = new Map([[alice, { id: alice, enabled: true }], [bob, { id: bob, enabled: true }]]);
  const access = { publicAccount(id) { if (!accounts.has(id)) throw new Error('Missing account'); return structuredClone(accounts.get(id)); } };
  await billing.configureAccount(alice, { enforceBalance: true }); await billing.configureAccount(bob, { enforceBalance: true });
  const queries = new Map(), creates = [], closes = [];
  const providers = ['alipay', 'wechat'].map(id => ({ id, binding: `${id}:offline-fixture`,
    async create(order) { creates.push(order.id); return { type: 'qr', url: id === 'alipay' ? 'https://qr.alipay.com/offline-fixture' : 'weixin://wxpay/bizpayurl?pr=offline-fixture' }; },
    async query(order) { return queries.get(order.id) ?? null; }, async close(order) { closes.push(order.id); },
    verifyNotification(bytes, headers) {
      if (headers.fixture !== 'trusted-test-only') throw Object.assign(new Error('Not signed'), { code: 'payment_verification_failed' });
      return JSON.parse(bytes);
    } }));
  const options = { path, access, billing, providers, products: [{ id: 'cny-10', title: '离线测试商品', amountFen: 1000 }], clock: () => time };
  const service = await PaymentTopups.open(options);
  const services = [service];
  t.after(async () => { for (const current of services) await current.close(); await billing.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (accountId = alice, changes = {}) => service.create(accountId, { channel: 'alipay', product: 'cny-10', requestId: randomUUID(), ...changes });
  const proof = (order, changes = {}) => ({ orderId: order.orderId, binding: `${order.channel}:offline-fixture`, status: 'paid',
    transactionId: 'offline-' + order.orderId, amountFen: order.amountFen, currency: 'CNY', paidAt: new Date(time).toISOString(), ...changes });
  const notify = (order, changes = {}) => service.notify(order.channel, Buffer.from(JSON.stringify(proof(order, changes))), { fixture: 'trusted-test-only' });
  return { directory, path, options, billing, access, accounts, service, services, providers, creates, closes, queries, alice, bob, create, proof, notify,
    advance: amount => { time += amount; } };
}

test('fixed CNY products bind to the logged-in identity, with idempotent creation and canonical billing', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const [first, repeated] = await Promise.all([f.create(f.alice, { requestId }), f.create(f.alice, { requestId })]);
  assert.equal(first.orderId, repeated.orderId); assert.equal(f.creates.length, 1);
  assert.equal(first.amountFen, 1000); assert.equal(first.creditMicros, 10_000_000);
  assert.equal(first.status, 'pending'); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  await assert.rejects(f.create(f.alice, { requestId, channel: 'wechat' }), denied('payment_conflict'));
  await assert.rejects(f.create(f.alice, { accountId: f.bob }), denied('payment_invalid'));
  assert.throws(() => f.service.get(f.bob, first.orderId), denied('payment_not_found'));
  await f.notify(first);
  assert.equal(f.service.get(f.alice, first.orderId).status, 'credited');
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000); assert.equal(f.billing.account(f.bob).balanceMicros, 0);
  assert.equal(f.billing.history(f.alice).rows.filter(row => row.type === 'balance_adjustment').length, 1);
  assert.equal(f.service.get(f.alice, first.orderId).checkout, null);
});

test('wrong amount, currency, merchant, unknown transaction and forged notifications never credit', async t => {
  const f = await fixture(t), order = await f.create(), original = await readFile(f.path, 'utf8');
  for (const change of [{ amountFen: 1 }, { amountFen: '1000' }, { currency: 'USD' }, { binding: 'another-merchant' },
    { orderId: 'f'.repeat(32) }, { transactionId: '' }, { paidAt: 'yesterday' }]) await assert.rejects(f.notify(order, change));
  await assert.rejects(f.service.notify('alipay', Buffer.from(JSON.stringify(f.proof(order))), {}), denied('payment_verification_failed'));
  assert.equal(f.billing.account(f.alice).balanceMicros, 0); assert.equal(await readFile(f.path, 'utf8'), original);
});

test('concurrent replays credit once, and a transaction cannot be reassigned to another account/order', async t => {
  const f = await fixture(t), first = await f.create(), second = await f.create(f.bob);
  await Promise.all(Array.from({ length: 20 }, () => f.notify(first)));
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
  await assert.rejects(f.notify(second, { transactionId: f.proof(first).transactionId }), denied('payment_conflict'));
  assert.equal(f.billing.account(f.bob).balanceMicros, 0);
  await assert.rejects(f.notify(first, { transactionId: 'replacement' }), denied('payment_conflict'));
});

test('a crash after the canonical balance commit resumes from the receipt without duplicate credit', async t => {
  const f = await fixture(t), order = await f.create();
  const original = f.billing.adjustBalance.bind(f.billing);
  f.service.billing = { account: f.billing.account.bind(f.billing), async adjustBalance(...args) { await original(...args); throw new Error('Simulated crash after canonical ledger commit'); } };
  await assert.rejects(f.notify(order));
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).orders[0].status, 'received');
  await f.service.close();
  const restarted = await PaymentTopups.open(f.options); f.services.push(restarted); await restarted.reconcile();
  assert.equal(restarted.get(f.alice, order.orderId).status, 'credited');
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
  assert.equal(f.billing.history(f.alice).rows.filter(row => row.type === 'balance_adjustment').length, 1);
});

test('failed ledger writes keep a durable receipt and retry automatically', async t => {
  const f = await fixture(t), order = await f.create();
  f.service.billing = { async adjustBalance() { throw new Error('Disk temporarily unavailable'); } };
  await assert.rejects(f.notify(order));
  assert.equal(f.service.status().received, 1); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  f.service.billing = f.billing; await f.service.reconcile();
  assert.equal(f.service.status().received, 0); assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
});

test('missed callbacks reconcile by authenticated provider query; network errors never imply payment', async t => {
  const f = await fixture(t), order = await f.create();
  f.providers[0].query = async () => { throw new Error('Offline'); };
  await f.service.reconcile(); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  f.providers[0].query = async () => f.proof(order); await f.service.reconcile();
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
  await f.service.reconcile(); assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
});

test('expired orders hide payment instructions, close at the provider, and still honor verified late success', async t => {
  const f = await fixture(t), order = await f.create(); f.advance(16 * 60_000);
  assert.equal(f.service.get(f.alice, order.orderId).checkout, null);
  f.queries.set(order.orderId, f.proof(order, { status: 'closed' })); await f.service.reconcile();
  assert.equal(f.service.get(f.alice, order.orderId).status, 'closed');
  await f.notify(order); assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
});

test('confirmed closure of a never-created order releases the pending slot without inventing payment', async t => {
  const f = await fixture(t), order = await f.create(); f.advance(16 * 60_000);
  f.providers[0].close = async () => true; await f.service.reconcile();
  assert.equal(f.service.get(f.alice, order.orderId).status, 'closed');
  assert.equal(f.service.hasPending(f.alice), false); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
});

test('deleted identities hold paid receipts for review; disabled identities retain credit without reactivation', async t => {
  const f = await fixture(t), first = await f.create(), second = await f.create(f.bob);
  f.accounts.delete(f.alice); await f.notify(first);
  assert.equal(f.service.status().review, 1); assert.equal(f.billing.account(f.alice).balanceMicros, 0);
  assert.equal(f.service.catalog().enabled, false);
  f.accounts.set(f.bob, { id: f.bob, enabled: false }); await f.notify(second);
  assert.equal(f.billing.account(f.bob).balanceMicros, 10_000_000); assert.equal(f.accounts.get(f.bob).enabled, false);
  assert.throws(() => f.service.list(f.bob), denied('payment_not_found'));
});

test('an unknown create result retains one order, and unsafe checkout URLs never reach customers', async t => {
  const f = await fixture(t), requestId = randomUUID();
  f.providers[0].create = async () => { throw new Error('Timeout after provider accepted'); };
  const order = await f.create(f.alice, { requestId });
  assert.equal(order.checkout, null); assert.equal(order.status, 'pending');
  assert.equal((await f.create(f.alice, { requestId })).orderId, order.orderId);
  f.queries.set(order.orderId, f.proof(order)); await f.service.reconcile();
  f.providers[0].create = async () => ({ type: 'qr', url: 'https://attacker.example/collect' });
  assert.equal((await f.create()).checkout, null);
});

test('configuration changes do not replace the original amount or merchant binding', async t => {
  const f = await fixture(t), order = await f.create(); await f.service.close();
  const restarted = await PaymentTopups.open({ ...f.options, products: [{ id: 'cny-10', title: 'New price', amountFen: 2000 }] });
  f.services.push(restarted); await restarted.notify('alipay', Buffer.from(JSON.stringify(f.proof(order))), { fixture: 'trusted-test-only' });
  assert.equal(f.billing.account(f.alice).balanceMicros, 10_000_000);
  assert.equal(restarted.get(f.alice, order.orderId).amountFen, 1000);
  f.providers[0].binding = 'new-merchant';
  assert.equal(restarted.get(f.alice, order.orderId).amountFen, 1000);
});

test('creation requires enforced balance billing and limits uncompleted orders', async t => {
  const f = await fixture(t); await f.billing.configureAccount(f.alice, { enforceBalance: false });
  await assert.rejects(f.create(), denied('payment_billing_required'));
  await f.billing.configureAccount(f.alice, { enforceBalance: true });
  await f.create(); await f.create(); await f.create();
  await assert.rejects(f.create(), denied('payment_limit'));
});

test('no configuration means disabled, and journal corruption/unsafe permissions fail closed', async t => {
  assert.equal(await loadPaymentRuntime({}), null);
  const f = await fixture(t); await f.create(); await f.service.close();
  const disabled = await PaymentTopups.open({ ...f.options, path: join(f.directory, 'disabled.json'), providers: [] }); f.services.push(disabled);
  assert.equal(disabled.catalog().enabled, false);
  await assert.rejects(disabled.create(f.alice, { channel: 'alipay', product: 'cny-10', requestId: randomUUID() }), denied('payments_unavailable'));
  if (process.platform !== 'win32') {
    await chmod(f.path, 0o644); await assert.rejects(PaymentTopups.open(f.options), denied('payments_unavailable')); await chmod(f.path, 0o600);
  }
  await writeFile(f.path, '{broken', { mode: 0o600 }); await assert.rejects(PaymentTopups.open(f.options), denied('payments_unavailable'));
});
