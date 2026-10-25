import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailDomainChecker, webEmail } from '../src/email-address.mjs';

const dnsError = code => Object.assign(new Error(code), { code });
function fixture(records = {}, timeoutMs = 1000) {
  const calls = []; let cancelled = false;
  const resolver = { cancel() { cancelled = true; } };
  for (const type of ['Mx', '4', '6']) resolver['resolve' + type] = async name => {
    calls.push({ type, name });
    const value = records[type] ?? dnsError('ENODATA');
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value() : value;
  };
  return { check: createEmailDomainChecker({ createResolver: () => resolver, timeoutMs }), calls, cancelled: () => cancelled };
}

test('ordinary email syntax is bounded and canonicalized without removing dots or plus suffixes', () => {
  assert.equal(webEmail(' Alice.Tag+Work@QQ.COM '), 'alice.tag+work@qq.com');
  assert.notEqual(webEmail('alice.tag@example.test'), webEmail('alicetag@example.test'));
  assert.notEqual(webEmail('alice+work@example.test'), webEmail('alice@example.test'));
  assert.equal(webEmail('a'.repeat(64) + '@example.test').length, 77);
  for (const value of [null, undefined, {}, '', 'alice', 'a@@example.com', '.a@example.com', 'a..b@example.com', 'a.@example.com',
    'a b@example.com', 'a@localhost', 'a@-example.com', 'a@example-.com', 'a@example..com', 'a@192.0.2.1', 'a@[::1]',
    'a@example.com.', 'a@example.com\n', 'a@例子.中国', '中文@example.com', '"a"@example.com', 'Alice <a@example.com>',
    'a'.repeat(65) + '@example.com', 'a@' + 'b'.repeat(64) + '.com', 'a'.repeat(257)]) {
    assert.throws(() => webEmail(value), { code: 'invalid_email', status: 400 });
  }
});

test('an MX check queries only the domain and does not claim mailbox existence', async () => {
  const { check, calls, cancelled } = fixture({ Mx: [{ exchange: 'mx.example.test.', priority: 10 }] });
  assert.equal(await check('Alice+work@example.test'), 'mx');
  assert.deepEqual(calls, [{ type: 'Mx', name: 'example.test' }]); assert.equal(cancelled(), true);
});

test('null MX is a rejection and cannot be bypassed with address fallback', async () => {
  for (const exchange of ['', '.']) {
    const { check, calls } = fixture({ Mx: [{ exchange, priority: 0 }], 4: ['192.0.2.1'] });
    await assert.rejects(check('a@example.test'), { code: 'invalid_email_domain', status: 400 });
    assert.equal(calls.length, 1);
  }
});

test('absence of MX permits RFC implicit MX using A or AAAA, without contacting those addresses', async () => {
  for (const records of [{ 4: ['192.0.2.1'] }, { Mx: [], 6: ['2001:db8::1'] }]) {
    const { check, calls } = fixture(records);
    assert.equal(await check('a@example.test'), 'address');
    assert.deepEqual(calls.map(item => item.type), ['Mx', '4', '6']);
  }
  await assert.rejects(fixture().check('a@example.test'), { code: 'invalid_email_domain' });
  const nx = fixture({ Mx: dnsError('ENOTFOUND') });
  await assert.rejects(nx.check('a@example.test'), { code: 'invalid_email_domain' }); assert.equal(nx.calls.length, 1);
});

test('temporary DNS errors and deadlines do not classify an email domain as nonexistent', async () => {
  for (const records of [{ Mx: dnsError('ETIMEOUT') }, { 4: dnsError('ESERVFAIL') }, { Mx: [{ exchange: 'broken', priority: 0 }] }]) {
    await assert.rejects(fixture(records).check('a@example.test'), { code: 'email_domain_unavailable', status: 503 });
  }
  const stalled = fixture({ Mx: () => new Promise(() => {}) }, 20);
  await assert.rejects(stalled.check('a@example.test'), { code: 'email_domain_unavailable', status: 503 });
  assert.equal(stalled.cancelled(), true);
});
