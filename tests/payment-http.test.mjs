import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWebAccounts } from '../src/web-accounts.mjs';
import { createClientGatewayForwarder, loopbackHttpFetch } from '../src/client-gateway-forwarder.mjs';
import { UnifiedWebAccounts } from '../src/unified-web-accounts.mjs';

const origin = 'https://payments.example.test';
async function fixture(t, { enabled = true } = {}) {
  const accounts = new Map([['fixture-alice', randomUUID()], ['fixture-bob', randomUUID()]]), orders = new Map(), callbacks = [];
  const store = { maxAccounts: 2,
    async me(token) {
      if (!accounts.has(token)) throw Object.assign(new Error('Expired'), { status: 401, code: 'session_expired' });
      return { account: { id: accounts.get(token) } };
    }, async clients() { return []; } };
  const payments = { catalog: () => ({ enabled: true }), list: accountId => ({ orders: [...orders.values()].filter(row => row.owner === accountId) }),
    get(accountId, id) {
      const row = orders.get(id);
      if (!row || row.owner !== accountId) throw Object.assign(new Error('Not found'), { status: 404, code: 'payment_not_found' });
      return row;
    }, async create(accountId, input) {
      const row = { orderId: randomBytes(16).toString('hex'), owner: accountId, product: input.product }; orders.set(row.orderId, row); return row;
    }, async notify(channel, bytes, headers) {
      callbacks.push({ channel, bytes, headers });
      if (channel === 'wechat' && headers['wechatpay-signature'] !== 'verified-in-provider-tests') throw new Error('Invalid signature');
    } };
  const web = createWebAccounts({ store, payments: enabled ? payments : null, csrfKey: randomBytes(32).toString('base64url'),
    publicOrigin: origin, apiBaseUrl: origin + '/v1' });
  const backend = http.createServer((req, res) => web.handle(req, res));
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const forwarder = createClientGatewayForwarder({ fetchImpl: (url, options) => {
    assert.equal(new URL(url).port, '43159');
    return loopbackHttpFetch(url.replace(':43159', ':' + backend.address().port), options);
  } });
  const front = http.createServer((req, res) => {
    if (!forwarder.handles(req.url)) { res.writeHead(404); res.end(); return; }
    void forwarder.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); });
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const server of [front, backend]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  function client(token) {
    const jar = new Map(token ? [['__Host-bifrost_session', token]] : []); let csrf;
    function send(path, { method = 'GET', body, raw, headers = {}, browser = true } = {}) {
      return new Promise((resolve, reject) => {
        const bytes = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
        const req = http.request({ hostname: '127.0.0.1', port: front.address().port, path, method, headers: { host: new URL(origin).host,
          ...(browser && jar.size ? { cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') } : {}),
          ...(browser && method !== 'GET' ? { origin, 'x-bifrost-csrf': csrf ?? '' } : {}),
          ...(bytes ? { 'content-type': raw ? 'application/json' : 'application/json', 'content-length': bytes.length } : {}), ...headers } }, res => {
          const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
          res.on('end', () => {
            for (const cookie of res.headers['set-cookie'] ?? []) {
              const [part] = cookie.split(';'), position = part.indexOf('='); jar.set(part.slice(0, position), part.slice(position + 1));
            }
            const text = Buffer.concat(chunks).toString('utf8'); let data;
            try { data = JSON.parse(text); } catch {}
            if (data?.csrfToken) csrf = data.csrfToken;
            resolve({ status: res.statusCode, data, text });
          });
        }); req.on('error', reject); req.end(bytes);
      });
    }
    return { send, boot: () => send('/account/web/v1/session') };
  }
  return { client, accounts, orders, callbacks };
}

test('top-up APIs traverse the fixed public forwarder with session ownership, CSRF, and strict input fields', async t => {
  const f = await fixture(t), alice = f.client('fixture-alice'), bob = f.client('fixture-bob'), anonymous = f.client();
  assert.equal((await alice.boot()).data.payments.enabled, true); await bob.boot();
  const body = { channel: 'alipay', product: 'cny-10', requestId: randomUUID() };
  assert.equal((await anonymous.send('/account/web/v1/topups')).status, 401);
  assert.equal((await alice.send('/account/web/v1/topups', { method: 'POST', body, headers: { 'x-bifrost-csrf': 'forged' } })).status, 403);
  assert.equal((await alice.send('/account/web/v1/topups', { method: 'POST', body: { ...body, accountId: f.accounts.get('fixture-bob') } })).status, 400);
  const created = await alice.send('/account/web/v1/topups', { method: 'POST', body }); assert.equal(created.status, 200);
  const id = created.data.order.orderId;
  assert.equal(created.data.order.owner, f.accounts.get('fixture-alice'));
  assert.equal((await alice.send('/account/web/v1/topups/' + id)).status, 200);
  assert.equal((await bob.send('/account/web/v1/topups/' + id)).status, 404);
  assert.equal((await alice.send('/account/web/v1/topups/' + id + '?account=other')).status, 404);
  assert.equal((await alice.send('/account/web/v1/topups/' + id, { method: 'POST', body: {} })).status, 405);
  assert.equal((await bob.send('/account/web/v1/topups')).data.orders.length, 0);
});

test('payment callbacks preserve raw bytes/signature headers through the public hop without browser CSRF', async t => {
  const f = await fixture(t), caller = f.client();
  const raw = Buffer.from(JSON.stringify({ ciphertext: 'x'.repeat(12_000) }));
  const path = '/account/web/v1/payments/notify/wechat';
  const response = await caller.send(path, { method: 'POST', raw, browser: false, headers: { 'wechatpay-signature': 'verified-in-provider-tests',
    'wechatpay-timestamp': '1792929600', 'wechatpay-nonce': 'nonce', 'wechatpay-serial': 'PUB_KEY_ID_OFFLINE' } });
  assert.equal(response.status, 204); assert.deepEqual(f.callbacks[0].bytes, raw);
  assert.equal(f.callbacks[0].headers['wechatpay-serial'], 'PUB_KEY_ID_OFFLINE');
  assert.equal((await caller.send(path, { method: 'POST', raw, browser: false })).status, 503);
  assert.equal((await caller.send(path + '?skipSignature=1', { method: 'POST', raw: Buffer.from('{}'), browser: false })).status, 404);
  assert.equal((await caller.send(path, { method: 'POST', raw, browser: false, headers: { authorization: 'Bearer cannot-authorize-payments' } })).status, 403);
  const alipay = await caller.send('/account/web/v1/payments/notify/alipay', { method: 'POST', browser: false,
    raw: Buffer.from('sign_type=RSA2&sign=offline'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(alipay.status, 200); assert.equal(alipay.text, 'success');
});

test('unconfigured merchants remain closed without breaking normal account sessions', async t => {
  const f = await fixture(t, { enabled: false }), client = f.client('fixture-alice');
  const session = await client.boot(); assert.equal(session.status, 200); assert.equal(session.data.authenticated, true); assert.equal(session.data.payments.enabled, false);
  assert.equal((await client.send('/account/web/v1/topups')).status, 503);
  assert.equal((await client.send('/account/web/v1/topups', { method: 'POST', body: { channel: 'alipay', product: 'cny-10', requestId: randomUUID() } })).status, 503);
  assert.equal((await client.send('/account/web/v1/payments/notify/alipay', { method: 'POST', raw: Buffer.from('anything'), browser: false })).status, 503);
});

test('website deletion blocks unfinished payments and nonzero balances', async () => {
  const id = randomUUID(); let deleted = false, balance = 1, pending = false;
  const accounts = new UnifiedWebAccounts({ access: { authenticateSession: () => ({ accountId: id }), async changeSession() { deleted = true; return { ok: true }; } },
    billing: { account: () => ({ balanceMicros: balance }) }, payments: { hasPending: () => pending } });
  await assert.rejects(accounts.change('session', 'delete'), error => error.code === 'payment_account_pending');
  balance = 0; pending = true; await assert.rejects(accounts.change('session', 'delete'), error => error.code === 'payment_account_pending');
  assert.equal(deleted, false); pending = false; await accounts.change('session', 'delete'); assert.equal(deleted, true);
});
