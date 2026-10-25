import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const json = (data, status = 200) => Response.json(data, { status });
const now = Date.parse('2026-10-23T12:00:00Z');
const fixture = () => ({
  registration: { mode: 'invite', defaultKeyDays: 30 },
  accounts: [{ id: 'user-1', username: 'alice', enabled: true, allowedModels: ['model-a'],
    keyExpiresAtLimit: '2026-11-22T12:00:00Z', createdAt: '2026-10-22T12:00:00Z',
    keys: [{ id: 'key-1', name: 'Office', lastFour: 'wxyz', enabled: true,
      expiresAt: '2026-11-01T12:00:00Z', effectiveExpiresAt: '2026-11-01T12:00:00Z', status: 'active' }] },
  { id: 'user-2', username: 'bob', enabled: false, allowedModels: [], keys: [], createdAt: '2026-10-23T12:00:00Z', keyExpiresAtLimit: null }],
  invites: [{ id: 'invite-1', lastFour: 'abcd', status: 'active', maxUses: 3, uses: 1,
    expiresAt: '2026-11-22T12:00:00Z', allowedModels: ['model-a'] }],
  models: [{ id: 'model-a', name: 'Model A', channel: 'CodeBuddy', enabled: true, available: true },
    { id: 'model-b', name: 'Model B', channel: 'Cursor', enabled: false, available: true },
    { id: 'unsupported', name: 'Unsupported', channel: 'Cursor', enabled: true, available: false }],
  endpoint: { baseUrl: 'http://127.0.0.1:43159/v1', portalUrl: 'http://127.0.0.1:43159/register' },
  server: { enabled: true, ready: true },
});

class Element {
  constructor(tag = 'div', attributes = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.hidden = false; this.disabled = false; this.textContent = ''; this.className = ''; this.checked = false;
    this.style = {}; this.options = []; this.value = ''; this.tabIndex = -1;
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) this.setAttribute(name, doubleQuoted ?? singleQuoted ?? unquoted ?? '');
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  trigger(type, options = {}) {
    const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    if (type !== 'click' || !this.disabled) this.listeners.get(type)?.(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; if (this.tagName === 'SELECT') this.options = nodes; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
    if (key === 'value') this.value = String(value);
    if (key === 'tabindex') this.tabIndex = Number(value);
    if (key === 'hidden') this.hidden = true;
    if (key === 'disabled') this.disabled = true;
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'href') delete this.href; }
  add(option) { this.options.push(option); }
  matches(selector) {
    const excluded = [...selector.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
    if (excluded.some(value => this.matches(value))) return false;
    const included = selector.replace(/:not\([^)]+\)/g, '');
    const tag = included.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const id = included.match(/#([\w-]+)/)?.[1];
    if (id && this.id !== id) return false;
    return [...included.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)].every(([, name, value]) => value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) { return this.children.flatMap(node => node instanceof Element ? [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)] : []); }
}

function harness(overrides = {}) {
  const elements = new Map([...html.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, tag, attributes, id]) => [id, new Element(tag, attributes)]));
  const calls = [], intervals = [], copies = [], windowListeners = new Map();
  const location = new URL(overrides.location ?? 'http://127.0.0.1:43155/');
  let data = overrides.data ?? fixture();
  const document = { hidden: false, body: new Element('body'), activeElement: null,
    getElementById(id) { return elements.get(id) ?? null; },
    createElement(tag) { const node = new Element(tag); node.ownerDocument = document; return node; },
    addEventListener() {}, querySelectorAll(selector) { return [...new Set([...elements.values()].flatMap(element => [element, ...element.querySelectorAll('*')]))].filter(element => element.matches(selector)); } };
  for (const node of [...elements.values(), document.body]) node.ownerDocument = document;
  const fetch = async (path, options = {}) => {
    const call = { path, method: options.method ?? 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (overrides.fetch) { const result = await overrides.fetch(call, api); if (result !== undefined) return result; }
    if (path === '/api/client-admin') return json(data);
    if (path === '/api/status') return json({ csrfToken: 'fixture-csrf', ready: true, backend: { running: true, login: {} }, gateway: { accounts: {} }, integration: {}, verification: {} });
    if (path === '/api/service/status') return json({ supported: true, ready: true, independentOfCodex: true });
    if (path === '/api/model-settings') return json({ revision: 1, models: [] });
    if (path === '/api/cursor' || path === '/api/codebuddy' || path === '/api/with') return json({ configured: false });
    if (path === '/api/account-quotas') return json({ accounts: {} });
    if (path === '/api/token-usage') return json({ accounts: {}, totals: {}, recent: [] });
    if (path === '/api/request-diagnostics?limit=10') return json({ recent: [] });
    if (call.method === 'POST') return json({});
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  const api = { calls, elements, intervals, copies, location, document,
    set data(value) { data = value; }, get data() { return data; } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ document, fetch, Response, Headers, AbortSignal, URL, Date: Clock,
    navigator: { clipboard: { async writeText(value) { copies.push(value); } } },
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    window: { location, history: { replaceState(state, title, url) { location.href = new URL(url, location).href; } }, addEventListener(type, listener) { windowListeners.set(type, listener); } },
    clearTimeout() {}, setTimeout() { return 1; }, setInterval(callback, milliseconds) { intervals.push({ callback, milliseconds }); return 1; } });
  vm.runInContext(source, context, { filename: 'public/app.js' });
  api.run = expression => vm.runInContext(expression, context);
  return api;
}

async function settle() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); }
async function clientPage(overrides = {}) { const page = harness(overrides); await settle(); page.elements.get('tab-clients').trigger('click'); await settle(); return page; }
const postCalls = page => page.calls.filter(call => call.method === 'POST');
const bodyText = node => [node.textContent, ...node.children.map(bodyText)].join(' ');
function keyButton(page, label) { return page.elements.get('client-key-list').querySelectorAll('button').find(button => button.textContent === label); }

test('client administration loads lazily and only reads metadata until an explicit action', async () => {
  const page = harness(); await settle();
  assert.equal(page.calls.some(call => call.path === '/api/client-admin'), false);
  page.elements.get('tab-clients').trigger('click'); await settle();
  assert.equal(page.elements.get('panel-clients').hidden, false);
  assert.equal(page.elements.get('panel-accounts').hidden, true);
  assert.equal(page.elements.get('client-users-count').textContent, '2 位用户');
  assert.equal(page.elements.get('client-detail-title').textContent, 'alice');
  assert.match(bodyText(page.elements.get('client-key-list')), /••••wxyz.*实际到期/);
  assert.equal(postCalls(page).length, 0);
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/client-admin').length, 1, 'User data is not part of 3-second polling.');
});

test('model grants use the exact checked model set and preserve unsaved choices across navigation and polling', async () => {
  const page = await clientPage();
  const options = page.elements.get('client-model-list').querySelectorAll('input');
  assert.equal(options.find(input => input.value === 'unsupported').disabled, true);
  options.find(input => input.value === 'model-a').checked = false;
  options.find(input => input.value === 'model-a').trigger('change');
  options.find(input => input.value === 'model-b').checked = true;
  options.find(input => input.value === 'model-b').trigger('change');
  assert.match(bodyText(page.elements.get('client-model-list')), /全局未开放/);
  page.elements.get('tab-console').trigger('click');
  for (const interval of page.intervals) interval.callback(); await settle();
  page.elements.get('tab-clients').trigger('click');
  assert.equal(page.elements.get('client-model-save').disabled, false);
  assert.equal(postCalls(page).length, 0);
  page.elements.get('client-model-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page).map(call => ({ path: call.path, body: call.body })), [{ path: '/api/client-admin/accounts/user-1', body: { allowedModels: ['model-b'] } }]);
  assert.equal(postCalls(page)[0].headers['X-Bridge-CSRF'], 'fixture-csrf');
});

test('admin user creation sends a password only in POST and starts with no model grants', async () => {
  const page = await clientPage({ fetch(call, api) {
    if (call.path === '/api/client-admin/accounts' && call.method === 'POST') {
      const account = { id: 'user-new', username: call.body.username, enabled: true, allowedModels: [], keys: [] };
      api.data = { ...api.data, accounts: [...api.data.accounts, account] }; return json({ account });
    }
  } });
  page.elements.get('client-create-username').value = ' charlie ';
  page.elements.get('client-create-password').value = 'example-long-password';
  page.elements.get('client-user-create-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { username: 'charlie', password: 'example-long-password', allowedModels: [], enabled: true });
  assert.equal(page.elements.get('client-create-password').value, '');
  assert.equal(page.elements.get('client-detail-title').textContent, 'charlie');
  assert.doesNotMatch(page.elements.get('notice').textContent, /example-long-password/);
  assert.equal(page.calls.some(call => call.path.includes('example-long-password')), false);
});

test('new API Key is shown once, copied explicitly, and cleared on refresh without a secret read endpoint', async () => {
  const secret = 'bf_live_this_is_a_fake_test_key';
  const page = await clientPage({ fetch(call) {
    if (call.path === '/api/client-admin/accounts/user-1/keys' && call.method === 'POST') return json({ key: { id: 'key-new' }, secret });
  } });
  page.elements.get('client-key-name').value = 'Home CodeBuddy';
  page.elements.get('client-key-create-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { name: 'Home CodeBuddy', expiresInDays: 30 });
  assert.equal(page.elements.get('client-secret-value').value, secret);
  assert.equal(page.elements.get('client-secret-panel').hidden, false);
  assert.deepEqual(page.copies, []);
  page.elements.get('client-secret-copy').trigger('click'); await settle(); assert.deepEqual(page.copies, [secret]);
  page.elements.get('client-admin-refresh').trigger('click'); await settle();
  assert.equal(page.elements.get('client-secret-panel').hidden, true);
  assert.equal(page.elements.get('client-secret-value').value, '');
  assert.equal(page.calls.some(call => /secret|reveal/.test(call.path)), false);
  assert.doesNotMatch(page.elements.get('notice').textContent, /bf_live_this/);
});

test('secret values included accidentally in list metadata are never rendered or made copyable', async () => {
  const data = fixture(); data.accounts[0].keys[0].secret = 'never-show-from-list'; data.invites[0].token = 'never-show-invite-from-list';
  const page = await clientPage({ data });
  assert.doesNotMatch(bodyText(page.elements.get('client-key-list')), /never-show/);
  assert.doesNotMatch(bodyText(page.elements.get('client-invitation-list')), /never-show/);
  assert.equal(page.elements.get('client-secret-value').value, '');
  assert.equal(page.elements.get('client-secret-panel').hidden, true);
});

test('Key expiry accepts positive whole days and rejects invalid input before mutation', async () => {
  const page = await clientPage();
  for (const value of ['0', '-1', '1.5', '3651', 'NaN']) {
    page.elements.get('client-key-days').value = value;
    page.elements.get('client-key-create-form').trigger('submit'); await settle();
  }
  assert.equal(postCalls(page).length, 0);
  assert.match(page.elements.get('client-admin-error').textContent, /1–3650/);
});

test('Key enable and renewal mutate only the selected key and preserve explicit expiry semantics', async () => {
  const page = await clientPage();
  keyButton(page, '停用').trigger('click'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { enabled: false });
  assert.equal(postCalls(page)[0].path, '/api/client-admin/accounts/user-1/keys/key-1');
  keyButton(page, '续期').trigger('click'); await settle();
  assert.deepEqual(postCalls(page)[1].body, { expiresAt: '2026-12-01T12:00:00.000Z' });
  assert.equal(postCalls(page).some(call => call.path.endsWith('/revoke')), false);
});

test('Key revocation requires explicit confirmation and cancellation sends no revoke request', async () => {
  const page = await clientPage();
  keyButton(page, '撤销').trigger('click');
  assert.equal(postCalls(page).length, 0);
  keyButton(page, '取消').trigger('click');
  assert.equal(postCalls(page).length, 0);
  keyButton(page, '撤销').trigger('click'); keyButton(page, '确认撤销').trigger('click'); await settle();
  assert.deepEqual(postCalls(page).map(call => ({ path: call.path, body: call.body })), [{ path: '/api/client-admin/accounts/user-1/keys/key-1/revoke', body: {} }]);
});

test('account enable and account Key limit are independent of Key revocation', async () => {
  const page = await clientPage();
  page.elements.get('client-user-toggle').trigger('click'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { enabled: false });
  page.elements.get('client-user-key-limit').value = '';
  page.elements.get('client-user-limit-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page)[1].body, { keyExpiresAtLimit: null });
  assert.equal(postCalls(page).some(call => call.path.includes('/keys/')), false);
  page.elements.get('client-user-list').querySelectorAll('button')[1].trigger('click');
  assert.equal(page.elements.get('client-user-toggle').textContent, '启用用户');
  assert.match(bodyText(page.elements.get('client-key-list')), /还没有 API Key/);
});

test('registration mode and default Key days save explicitly without creating users or keys', async () => {
  const page = await clientPage();
  assert.equal(page.elements.get('client-registration-mode').value, 'invite');
  page.elements.get('client-registration-mode').value = 'closed';
  page.elements.get('client-registration-days').value = '14';
  page.elements.get('client-registration-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page).map(call => ({ path: call.path, body: call.body })), [{ path: '/api/client-admin/registration', body: { mode: 'closed', defaultKeyDays: 14 } }]);
});

test('invitations carry exact model grants and show a one-time token with explicit revoke confirmation', async () => {
  const page = await clientPage({ fetch(call) {
    if (call.path === '/api/client-admin/invites' && call.method === 'POST') return json({ invite: { id: 'invite-new' }, token: 'bf_invite_fake_once_only' });
  } });
  const option = page.elements.get('client-invitation-models').querySelectorAll('input').find(input => input.value === 'model-a');
  option.checked = true; option.trigger('change');
  page.elements.get('client-invitation-create-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { expiresInDays: 30, maxUses: 1, allowedModels: ['model-a'] });
  assert.equal(page.elements.get('client-secret-title').textContent, '新邀请码');
  assert.equal(page.elements.get('client-secret-value').value, 'bf_invite_fake_once_only');
  const buttons = page.elements.get('client-invitation-list').querySelectorAll('button');
  buttons.find(button => button.textContent === '撤销').trigger('click');
  assert.equal(postCalls(page).length, 1);
  buttons.find(button => button.textContent === '确认撤销').trigger('click'); await settle();
  assert.equal(postCalls(page)[1].path, '/api/client-admin/invites/invite-1/revoke');
  assert.equal(page.elements.get('client-secret-value').value, '');
});

test('old backend keeps user mutations disabled and leaves original dashboard usable', async () => {
  const page = await clientPage({ fetch(call) { if (call.path === '/api/client-admin') return json({ error: { message: 'missing' } }, 404); } });
  assert.equal(page.elements.get('client-user-create').disabled, true);
  assert.match(page.elements.get('client-admin-error').textContent, /更新并重启后台/);
  assert.equal(page.elements.get('connection-label').textContent, '本机服务已就绪');
  assert.equal(postCalls(page).length, 0);
});

test('invalid portal URLs and hostile display names remain text and never become markup or scripts', async () => {
  const data = fixture(); data.endpoint.portalUrl = 'javascript:alert(1)'; data.accounts[0].username = '<img src=x onerror=alert(1)>';
  const page = await clientPage({ data });
  assert.equal(page.elements.get('client-portal-link').hidden, true);
  assert.equal(page.elements.get('client-portal-link').href, undefined);
  assert.equal(page.elements.get('client-detail-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(page.elements.get('client-user-list').querySelectorAll('img').length, 0);
});

test('in-flight or failed client metadata reads disable writes without discarding the saved view', async () => {
  let block = false, fail = false, release;
  const page = await clientPage({ fetch(call) {
    if (call.path === '/api/client-admin' && block) return new Promise(resolve => { release = resolve; });
    if (call.path === '/api/client-admin' && fail) return json({ error: { message: 'unavailable' } }, 503);
  } });
  block = true;
  const refresh = page.run('refreshClientAdmin()'); await settle();
  assert.equal(page.elements.get('client-key-create').disabled, true);
  page.elements.get('client-key-create-form').trigger('submit'); await settle();
  assert.equal(postCalls(page).length, 0);
  release(json(fixture())); await refresh; await settle();
  assert.equal(page.elements.get('client-key-create').disabled, false);
  block = false; fail = true;
  await page.run('refreshClientAdmin()');
  assert.equal(page.elements.get('client-detail-title').textContent, 'alice');
  assert.equal(page.elements.get('client-key-create').disabled, true);
  assert.match(page.elements.get('client-admin-error').textContent, /更新并重启后台/);
});

test('secret close and copy remain local actions after a management disconnection', async () => {
  let disconnected = false;
  const page = await clientPage({ fetch(call) {
    if (call.path === '/api/status' && disconnected) throw new Error('offline fixture');
    if (call.path === '/api/client-admin/accounts/user-1/keys' && call.method === 'POST') return json({ key: { id: 'key-new' }, secret: 'bfk_local_only_fake' });
  } });
  page.elements.get('client-key-create-form').trigger('submit'); await settle();
  assert.deepEqual(postCalls(page)[0].body, { name: 'Default', expiresInDays: 30 });
  disconnected = true; await page.run('refreshStatus().catch(() => {})');
  assert.equal(page.elements.get('client-key-create').disabled, true);
  assert.equal(page.elements.get('client-secret-copy').disabled, false);
  page.elements.get('client-secret-copy').trigger('click'); await settle();
  assert.deepEqual(page.copies, ['bfk_local_only_fake']);
  page.elements.get('client-secret-close').trigger('click');
  assert.equal(page.elements.get('client-secret-value').value, '');
  assert.equal(page.elements.get('client-secret-panel').hidden, true);
});

test('a configured default Key lifetime is inherited without changing an edited create form', async () => {
  const data = fixture(); data.registration.defaultKeyDays = 7;
  const page = await clientPage({ data });
  assert.equal(page.elements.get('client-key-days').value, '7');
  page.elements.get('client-key-days').value = '14';
  data.registration.defaultKeyDays = 21;
  await page.run('refreshClientAdmin()');
  assert.equal(page.elements.get('client-registration-days').value, '21');
  assert.equal(page.elements.get('client-key-days').value, '14');
});
