import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createHandler } = require('../wechat/cloudfunctions/bifrost-account/index.js');
const sessionToken = 'bfs_' + 'a'.repeat(43);
const apiKey = 'bfk_' + 'b'.repeat(43);

function httpsFixture({ status = 200, text = JSON.stringify({ account: { id: 'fixture' } }), fail = false } = {}) {
  const calls = [];
  return { calls, requestImpl(url, options, callback) {
    const request = new EventEmitter(); request.destroy = () => request.emit('close');
    request.end = body => {
      calls.push({ url, options, body });
      queueMicrotask(() => {
        if (fail) request.emit('error', new Error('private-platform-secret'));
        else {
          const response = new EventEmitter(); response.statusCode = status; response.destroy = () => {};
          callback(response); response.emit('data', Buffer.from(text)); response.emit('end');
        }
        request.emit('close');
      });
    };
    return request;
  } };
}

test('cloud function forwards only fixed account routes with bounded session authentication', async () => {
  const fixture = httpsFixture();
  const handle = createHandler({ origin: 'https://api.example.net:47846', requestImpl: fixture.requestImpl });
  const response = await handle({ action: 'me', sessionToken, url: 'https://attacker.example.net/admin',
    headers: { authorization: 'gateway-admin-secret', host: 'attacker.example.net' } });
  assert.equal(response.status, 200);
  assert.equal(fixture.calls[0].url.href, 'https://api.example.net:47846/account/v1/me');
  assert.equal(fixture.calls[0].options.headers.authorization, `Bearer ${sessionToken}`);
  assert.equal(fixture.calls[0].options.headers.host, undefined);
  for (const action of ['models', 'https://attacker.example.net', '/api/admin', 'toString', '__proto__']) {
    assert.equal((await handle({ action, sessionToken })).status, 503);
  }
  assert.equal((await handle({ action: 'me', sessionToken: apiKey })).status, 401);
  assert.equal(fixture.calls.length, 1);
});

test('cloud function refuses redirects, oversized responses, invalid destinations and raw exceptions', async () => {
  for (const options of [{ status: 302, text: '{}' }, { text: 'x'.repeat(17000) },
    { text: 'private-platform-secret' }, { fail: true }]) {
    const fixture = httpsFixture(options);
    const response = await createHandler({ origin: 'https://api.example.net', requestImpl: fixture.requestImpl })({ action: 'me', sessionToken });
    assert.equal(response.status, 503); assert.ok(!JSON.stringify(response).includes('private-platform-secret'));
    assert.equal(fixture.calls.length, 1);
  }
  for (const origin of ['http://api.example.net', 'https://127.0.0.1', 'https://localhost',
    'https://user:secret@api.example.net', 'https://api.example.net/admin', 'https://api.example.net?target=other']) {
    const fixture = httpsFixture();
    assert.equal((await createHandler({ origin, requestImpl: fixture.requestImpl })({ action: 'me', sessionToken })).status, 503);
    assert.equal(fixture.calls.length, 0);
  }
});

test('cloud function retains an ordinary login body but cannot pass its caller session as administrator auth', async () => {
  const fixture = httpsFixture();
  const handle = createHandler({ origin: 'https://api.example.net', requestImpl: fixture.requestImpl });
  const body = { code: 'one-use-code-123', privacyAccepted: true, inviteCode: '邀请码' };
  assert.equal((await handle({ action: 'login', body, sessionToken: 'admin-secret' })).status, 200);
  assert.deepEqual(JSON.parse(fixture.calls[0].body), body);
  assert.equal(fixture.calls[0].options.headers['content-length'], Buffer.byteLength(fixture.calls[0].body));
  assert.equal(fixture.calls[0].options.headers.authorization, undefined);
  assert.equal((await handle({ action: 'login', body: { padding: 'x'.repeat(9000) } })).status, 503);
  assert.equal(fixture.calls.length, 1);
});

async function miniProgramFixture() {
  const memory = new Map(), requests = [], config = { transport: 'cloud', cloudEnv: 'test-env', cloudFunction: 'bifrost-account' };
  let pageDefinition;
  const wx = {
    cloud: { callFunction: async options => {
      requests.push(options);
      return { result: { status: 200, data: { sessionToken, apiKey, account: { id: 'alice', apiKeyConfigured: true },
        apiBaseUrl: 'https://api.example.net/v1' } } };
    } },
    getStorageSync: key => memory.get(key), setStorageSync: (key, value) => memory.set(key, value),
    removeStorageSync: key => memory.delete(key), login: options => options.success({ code: 'one-use-code-123' }),
    showModal: options => options.success({ confirm: false }),
  };
  const serviceSource = await readFile(new URL('../wechat/miniprogram/services/account.js', import.meta.url), 'utf8');
  const serviceModule = { exports: {} };
  vm.runInNewContext(`(function(require,module,wx){${serviceSource}\n})`, {})(() => config, serviceModule, wx);
  const source = await readFile(new URL('../wechat/miniprogram/pages/account/index.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { require: () => serviceModule.exports, wx, Page: definition => { pageDefinition = definition; } });
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(value) { Object.assign(this.data, value); } };
  return { page, memory, requests, wx, service: serviceModule.exports, config };
}

test('mini program waits for consent, persists only the session, and hides keys on leaving the page', async () => {
  const { page, memory, requests } = await miniProgramFixture();
  await page.onLogin(); assert.equal(requests.length, 0); assert.match(page.data.error, /隐私/);
  page.data.consent = true; page.data.inviteCode = 'bfi-fixture';
  await page.onLogin();
  assert.equal(requests.length, 1); assert.equal(requests[0].data.action, 'login');
  assert.equal(requests[0].data.body.privacyAccepted, true);
  assert.equal(page.data.apiKey, apiKey); assert.equal(memory.size, 1);
  assert.equal([...memory.values()][0], sessionToken);
  page.onHide(); assert.equal(page.data.apiKey, '');
});

test('mini program confirms destructive key changes and fails clearly when deployment is not configured', async () => {
  const { page, requests, config } = await miniProgramFixture();
  await page.onResetKey(); await page.onRevokeKey(); await page.onDeleteAccount();
  assert.equal(requests.length, 0);
  config.cloudEnv = ''; page.data.consent = true;
  await page.onLogin(); assert.equal(requests.length, 0); assert.match(page.data.error, /配置/);
});

test('a rejected login session is cleared rather than repeatedly reused by the mini program', async () => {
  const { page, service, wx, memory } = await miniProgramFixture();
  await service.login('fixture'); assert.equal(memory.size, 1);
  wx.cloud.callFunction = async () => ({ result: { status: 401, data: { error: { code: 'session_expired', message: '请重新登录。' } } } });
  page.data.account = { id: 'alice' }; page.data.apiKey = apiKey;
  await page.onShow();
  assert.equal(memory.size, 0); assert.equal(page.data.account, null); assert.equal(page.data.apiKey, '');
});
