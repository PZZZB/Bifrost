import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/portal.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/portal.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/portal.css', import.meta.url), 'utf8');
const miniApiSource = await readFile(new URL('../wechat-miniprogram/utils/api.js', import.meta.url), 'utf8');
const miniPageSource = await readFile(new URL('../wechat-miniprogram/pages/index/index.js', import.meta.url), 'utf8');
const json = (data, status = 200) => Response.json(data, { status });
const config = () => ({ registration: { enabled: true, invitationRequired: false }, keyDefaults: { expiresInDays: 30 },
  gateway: { baseUrl: 'https://bridge.example.org/v1', chatCompletionsUrl: 'https://bridge.example.org/v1/chat/completions',
    messagesUrl: 'https://bridge.example.org/v1/messages', modelsUrl: 'https://bridge.example.org/v1/models' } });
const user = () => ({ id: 'user_1', username: 'sample-user', enabled: true, keyExpiresAtLimit: '2099-01-01T00:00:00.000Z' });
const summary = () => ({ id: 'key_1', name: '办公电脑', lastFour: '12AB', status: 'active',
  createdAt: '2026-10-23T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', lastUsedAt: null });
const me = () => ({ user: user(), keys: [summary()], gateway: config().gateway, keyDefaults: { expiresInDays: 30 },
  models: [{ id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy Opus 5.5', protocols: ['chat-completions', 'responses', 'messages'] }] });

class Element {
  constructor(tag = 'div', attributes = '') {
    this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = []; this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = '';
    for (const [, name, value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) this.setAttribute(name, value ?? '');
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) { return this.attributes.get(name); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  trigger(name, event = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...event }); }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [...(selector === '*' || node.tagName === selector.toUpperCase() ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  focus() {}
}
function allText(element) { return [element.textContent, ...element.children.map(allText)].join(' '); }
function harness(options = {}) {
  const elements = new Map([...html.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attributes, id]) => [id, new Element(tag, attributes)]));
  const calls = [], copies = [], listeners = new Map();
  const api = { calls, copies, elements, listeners, userData: options.me ?? me(), confirm: true };
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    Date, URL, Response, AbortSignal, encodeURIComponent,
    navigator: { clipboard: { async writeText(value) { copies.push(value); } } },
    window: { location: new URL(options.location ?? 'http://127.0.0.1:43159/portal'),
      addEventListener(name, listener) { listeners.set(name, listener); }, confirm() { return api.confirm; } },
    fetch: async (path, request = {}) => {
      const call = { path, method: request.method ?? 'GET', headers: request.headers, credentials: request.credentials,
        body: request.body === undefined ? undefined : JSON.parse(request.body) }; calls.push(call);
      const result = await options.fetch?.(call, api); if (result !== undefined) return result;
      if (path === '/portal/api/config') return json(config());
      if (path === '/portal/api/session') return options.loggedIn ? json({ user: user(), csrfToken: 'user-csrf' }) : json({ error: {} }, 401);
      if (path === '/portal/api/me') return json(api.userData);
      if (path === '/portal/api/login') return json({ user: user(), csrfToken: 'user-csrf', sessionToken: 'ignore-browser-session-token' });
      if (path === '/portal/api/register') return json({ user: user(), csrfToken: 'user-csrf', sessionToken: 'ignore-browser-session-token', key: summary(), secret: 'bf_registration_secret' });
      if (path === '/portal/api/keys') return json({ key: summary(), secret: 'bf_creation_secret' });
      if (path === '/portal/api/keys/key_1') return json({ revoked: true });
      if (path === '/portal/api/logout') return json({ ok: true });
      throw new Error(`Unexpected portal fixture: ${path}`);
    } });
  vm.runInContext(source, context, { filename: 'public/portal.js' });
  api.run = code => vm.runInContext(code, context);
  return api;
}
async function settle() { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); }
function credentials(page) { page.elements.get('username').value = 'sample-user'; page.elements.get('password').value = 'correct-password-123'; }

test('portal initializes with read-only cookie requests and does not persist browser credentials', async () => {
  const page = harness(); await settle();
  assert.deepEqual(page.calls.map(call => [call.path, call.method]), [['/portal/api/config', 'GET'], ['/portal/api/session', 'GET']]);
  assert.ok(page.calls.every(call => call.credentials === 'same-origin'));
  assert.equal(page.elements.get('auth-submit').disabled, false);
  assert.equal(page.elements.get('dashboard-panel').hidden, true);
  assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|setInterval/);
});

test('portal registration uses optional inviteToken and displays complete key only from creation response', async () => {
  const page = harness(); await settle();
  page.elements.get('register-tab').trigger('click'); credentials(page);
  page.elements.get('invite-code').value = 'invitation-example';
  await page.elements.get('credentials-form').trigger('submit');
  const request = page.calls.find(call => call.path === '/portal/api/register');
  assert.deepEqual(request.body, { username: 'sample-user', password: 'correct-password-123', inviteToken: 'invitation-example' });
  assert.equal(page.elements.get('password').value, '');
  assert.equal(page.elements.get('invite-code').value, '');
  assert.equal(page.elements.get('dashboard-panel').hidden, false);
  assert.equal(page.elements.get('new-key-secret').value, 'bf_registration_secret');
  assert.equal(page.copies.length, 0);
  await page.elements.get('secret-copy').trigger('click');
  assert.deepEqual(page.copies, ['bf_registration_secret']);
  page.elements.get('secret-dismiss').trigger('click');
  assert.equal(page.elements.get('new-key-secret').value, '');
  assert.equal(page.elements.get('new-key-panel').hidden, true);
  await page.elements.get('portal-refresh').trigger('click');
  assert.equal(page.elements.get('new-key-secret').value, '');
});

test('authenticated key writes use user CSRF, not the returned session bearer token', async () => {
  const page = harness({ loggedIn: true }); await settle();
  page.elements.get('key-name').value = '办公电脑'; page.elements.get('key-days').value = '7';
  await page.elements.get('key-form').trigger('submit');
  const call = page.calls.find(call => call.path === '/portal/api/keys');
  assert.deepEqual(call.body, { name: '办公电脑', expiresInDays: 7 });
  assert.equal(call.headers['X-CSRF-Token'], 'user-csrf');
  assert.equal(call.headers.Authorization, undefined);
  assert.equal(page.elements.get('new-key-secret').value, 'bf_creation_secret');
  page.listeners.get('pagehide')();
  assert.equal(page.elements.get('new-key-secret').value, '');
  assert.equal(page.elements.get('new-key-panel').hidden, true);
});

test('key creation completion cannot redisplay a secret after the browser page was hidden', async () => {
  let complete;
  const page = harness({ loggedIn: true, fetch(call) {
    if (call.path === '/portal/api/keys') return new Promise(resolve => { complete = resolve; });
  } }); await settle();
  page.elements.get('key-name').value = 'another client';
  const pending = page.elements.get('key-form').trigger('submit'); await settle();
  page.listeners.get('pagehide')(); complete(json({ key: summary(), secret: 'never-redisplay-this-secret' }));
  await pending;
  assert.equal(page.elements.get('new-key-secret').value, '');
  assert.equal(page.elements.get('new-key-panel').hidden, true);
});

test('effective key expiry and account key deadline are visible without treating the login account as expired', async () => {
  const data = me(); data.user.keyExpiresAtLimit = '2020-01-01T00:00:00.000Z';
  data.keys[0].effectiveExpiresAt = '2020-01-01T00:00:00.000Z';
  const page = harness({ loggedIn: true, me: data }); await settle();
  assert.equal(page.elements.get('dashboard-panel').hidden, false);
  assert.equal(page.elements.get('key-create-button').disabled, true);
  assert.match(page.elements.get('account-banner').textContent, /账号仍可登录/);
  assert.match(allText(page.elements.get('keys-list')), /已到期/);
  assert.doesNotMatch(allText(page.elements.get('keys-list')), /2099/);
  assert.match(allText(page.elements.get('models-list')), /OpenAI Chat.*Responses.*Anthropic Messages/);
});

test('model names and account fields render as text and extra secret fields are not projected to key lists', async () => {
  const data = me(); data.keys[0].secret = 'unexpected-full-key'; data.keys[0].name = '<img src=x onerror=alert(1)>';
  data.models[0].name = '<script>alert(1)</script>';
  const page = harness({ loggedIn: true, me: data }); await settle();
  assert.match(allText(page.elements.get('keys-list')), /<img/);
  assert.match(allText(page.elements.get('models-list')), /<script>/);
  assert.doesNotMatch(allText(page.elements.get('keys-list')), /unexpected-full-key/);
  assert.equal(page.elements.get('new-key-secret').value, '');
});

test('revocation needs explicit confirmation and sends only the selected key ID', async () => {
  const page = harness({ loggedIn: true }); await settle();
  const revoke = page.elements.get('keys-list').querySelectorAll('button')[0];
  page.confirm = false; await revoke.trigger('click');
  assert.equal(page.calls.filter(call => call.method === 'DELETE').length, 0);
  page.confirm = true; await revoke.trigger('click');
  assert.equal(page.calls.filter(call => call.method === 'DELETE').length, 1);
  const call = page.calls.find(call => call.method === 'DELETE');
  assert.equal(call.path, '/portal/api/keys/key_1');
  assert.equal(call.headers['X-CSRF-Token'], 'user-csrf');
});

test('failed login clears the password and disabled-session response clears the secret and user view', async () => {
  const page = harness({ fetch(call) {
    if (call.path === '/portal/api/login') return json({ error: { code: 'invalid_credentials', message: '用户名或密码错误。' } }, 401);
  } }); await settle(); credentials(page); await page.elements.get('credentials-form').trigger('submit');
  assert.equal(page.elements.get('password').value, '');
  assert.match(page.elements.get('auth-error').textContent, /用户名或密码错误/);
  const signedIn = harness({ loggedIn: true, fetch(call, state) {
    if (call.path === '/portal/api/me' && state.rejectSession) return json({ error: { code: 'account_disabled', message: '账号已停用。' } }, 403);
  } }); await settle(); signedIn.run('showNewKey({key:{id:"key_1"},secret:"bf_once"})');
  signedIn.rejectSession = true; await signedIn.elements.get('portal-refresh').trigger('click');
  assert.equal(signedIn.elements.get('dashboard-panel').hidden, true);
  assert.equal(signedIn.elements.get('new-key-secret').value, '');
});

function miniApiHarness(root = 'https://bridge.example.org') {
  const globalData = { sessionToken: 'portal-session' }, requests = [], exports = {};
  const context = vm.createContext({ module: { exports }, require: () => ({ publicRoot: root }), getApp: () => ({ globalData }),
    wx: { request(options) { requests.push(options); } }, Promise, Error });
  vm.runInContext(miniApiSource, context, { filename: 'wechat-miniprogram/utils/api.js' });
  return { api: context.module.exports.api, globalData, requests };
}

test('mini program uses HTTPS Bearer session requests and checks HTTP errors inside wx.request success', async () => {
  const client = miniApiHarness(); const pending = client.api('me');
  assert.equal(client.requests[0].url, 'https://bridge.example.org/portal/api/me');
  assert.equal(client.requests[0].header.Authorization, 'Bearer portal-session');
  client.requests[0].success({ statusCode: 401, data: { error: { message: '登录已过期。' } } });
  await assert.rejects(pending, /登录已过期/);
  assert.equal(client.globalData.sessionToken, null);
  const login = client.api('login', { method: 'POST', auth: false, data: { username: 'sample-user', password: 'example-only-password' } });
  assert.equal(client.requests[1].header.Authorization, undefined);
  client.requests[1].success({ statusCode: 200, data: { sessionToken: 'replacement-session' } });
  assert.equal((await login).sessionToken, 'replacement-session');
});

test('mini program refuses placeholder and insecure server addresses before any request', async () => {
  for (const root of ['https://YOUR-BIFROST-DOMAIN.example', 'http://bridge.example.org', 'https://127.0.0.1', 'https://localhost', 'https://user:password@bridge.example.org']) {
    const client = miniApiHarness(root); await assert.rejects(client.api('config'), /HTTPS/); assert.equal(client.requests.length, 0);
  }
});

function miniPageHarness() {
  let definition;
  const globalData = { sessionToken: 'mini-session' };
  const context = vm.createContext({ require: () => ({ api: async () => me() }), getApp: () => ({ globalData }),
    Page(value) { definition = value; }, wx: { setClipboardData() {}, stopPullDownRefresh() {} }, Date, Number, String, Error,
    encodeURIComponent });
  vm.runInContext(miniPageSource, context, { filename: 'wechat-miniprogram/pages/index/index.js' });
  definition.data = structuredClone(definition.data); definition._config = config();
  definition.setData = updates => Object.assign(definition.data, updates);
  return definition;
}

test('mini program only projects key summaries and clears secret on hide, including late completion', () => {
  const page = miniPageHarness(), data = me(); data.keys[0].secret = 'must-not-project';
  data.keys[0].effectiveExpiresAt = '2020-01-01T00:00:00Z';
  page.render(data); assert.equal(page.data.keys[0].status, 'expired');
  assert.equal(JSON.stringify(page.data.keys).includes('must-not-project'), false);
  page.showSecret({ key: summary(), secret: 'one-time-secret' });
  assert.equal(page.data.newSecret, 'one-time-secret');
  page.onHide(); assert.equal(page.data.newSecret, '');
  page.showSecret({ key: summary(), secret: 'late-secret' }); assert.equal(page.data.newSecret, '');
  assert.doesNotMatch(miniPageSource + miniApiSource, /setStorage|console\.|wx\.login\(/);
});

test('customer register URL opens registration while login and the portal keep their existing entry mode', async () => {
  for (const [path, mode] of [['/register', 'register'], ['/login', 'login'], ['/portal', 'login']]) {
    const page = harness({ location: `http://127.0.0.1:43159${path}` }); await settle();
    assert.equal(page.elements.get(`${mode}-tab`).getAttribute('aria-selected'), 'true');
    assert.equal(page.elements.get('auth-submit').textContent, mode === 'register' ? '注册账号' : '登录');
    assert.deepEqual(page.calls.map(call => [call.path, call.method]), [['/portal/api/config', 'GET'], ['/portal/api/session', 'GET']]);
  }
});

test('disabled registration falls back to login on the register URL without creating an account', async () => {
  const page = harness({ location: 'http://127.0.0.1:43159/register', fetch(call) {
    if (call.path === '/portal/api/config') return json({ ...config(), registration: { enabled: false, invitationRequired: false } });
  } }); await settle();
  assert.equal(page.elements.get('login-tab').getAttribute('aria-selected'), 'true');
  assert.equal(page.elements.get('register-tab').disabled, true);
  assert.equal(page.calls.some(call => call.method !== 'GET'), false);
});

test('public ecosystem relationships describe adapted and candidate directions without private A or Claude subscription sources', async () => {
  const page = harness(); await settle();
  const topology = JSON.parse(page.run('JSON.stringify(portalEcosystemRelations())'));
  assert.deepEqual(topology.nodes.map(node => node.id).sort(), ['claude', 'codebuddy', 'codex', 'cursor', 'workbuddy']);
  assert.deepEqual(topology.routes.map(route => `${route.from}:${route.to}`).sort(), [
    'codex:codebuddy', 'codebuddy:codex', 'codex:cursor', 'claude:codebuddy',
    'workbuddy:codex', 'workbuddy:codebuddy', 'workbuddy:cursor', 'codebuddy:cursor',
  ].sort());
  assert.equal(topology.routes.some(route => route.from === 'cursor' || route.to === 'claude' || route.to === 'workbuddy'), false);
  assert.doesNotMatch(JSON.stringify(topology.routes), /claude-cli|native-opus|账号 A|account A|"channel":"A"/i);
  assert.equal(page.calls.some(call => !call.path.startsWith('/portal/api/')), false);
});

test('exploring customer tree nodes preserves registration inputs and never reads administrator state or submits credentials', async () => {
  const page = harness({ location: 'http://127.0.0.1:43159/register' }); await settle();
  credentials(page); page.elements.get('invite-code').value = 'optional-invite-in-progress';
  const calls = page.calls.length;
  for (const id of ['codebuddy', 'cursor', 'claude', 'workbuddy', 'codex']) {
    const node = page.elements.get(`portal-node-${id}`);
    assert.equal(node.getAttribute('type'), 'button');
    node.trigger('click');
    assert.equal(node.getAttribute('aria-pressed'), 'true');
    assert.equal(page.elements.get('username').value, 'sample-user');
    assert.equal(page.elements.get('password').value, 'correct-password-123');
    assert.equal(page.elements.get('invite-code').value, 'optional-invite-in-progress');
    assert.equal(page.elements.get('register-tab').getAttribute('aria-selected'), 'true');
    assert.equal(page.elements.get('credentials-form').getAttribute('aria-labelledby'), 'register-tab');
  }
  page.elements.get('portal-map-reset').trigger('click');
  for (const id of ['codebuddy', 'cursor', 'claude', 'workbuddy', 'codex']) {
    assert.equal(page.elements.get(`portal-node-${id}`).getAttribute('aria-pressed'), 'false');
  }
  assert.equal(page.calls.length, calls);
  assert.equal(page.elements.get('password').value, 'correct-password-123');
});

test('customer ecosystem stays explorable when the user service is unavailable and does not imply an authenticated session', async () => {
  const page = harness({ fetch(call) {
    if (call.path === '/portal/api/config') return json({ error: { message: '用户入口暂不可用。' } }, 503);
  } }); await settle();
  page.elements.get('portal-node-cursor').trigger('click');
  assert.equal(page.elements.get('portal-node-cursor').getAttribute('aria-pressed'), 'true');
  assert.match(page.elements.get('portal-ecosystem-title').textContent, /Cursor/);
  assert.equal(page.elements.get('auth-submit').disabled, true);
  assert.equal(page.elements.get('dashboard-panel').hidden, true);
  assert.equal(page.calls.some(call => call.method !== 'GET' || !call.path.startsWith('/portal/api/')), false);
});

test('tree exploration does not clear a one-time API Key after the user registers or signs in', async () => {
  const page = harness({ loggedIn: true }); await settle();
  page.run('showNewKey({key:{id:"key_1"},secret:"bf_customer_tree_once"})');
  page.elements.get('portal-node-codebuddy').trigger('click');
  assert.equal(page.elements.get('new-key-secret').value, 'bf_customer_tree_once');
  assert.equal(page.elements.get('new-key-panel').hidden, false);
  assert.equal(page.copies.length, 0);
  assert.equal(page.elements.get('dashboard-panel').hidden, false);
  assert.equal(page.elements.get('auth-panel').hidden, true);
});

test('customer ecosystem distinguishes three adapted directions from five desktop clients awaiting connection and acceptance', async () => {
  const page = harness(); await settle();
  const { routes } = JSON.parse(page.run('JSON.stringify(portalEcosystemRelations())'));
  const directions = stage => routes.filter(route => route.maturity === stage).map(route => `${route.from}:${route.to}`).sort();
  assert.deepEqual(directions('adapted'), ['codex:codebuddy', 'codex:cursor', 'claude:codebuddy'].sort());
  assert.deepEqual(directions('client_pending'), ['codebuddy:codex', 'codebuddy:cursor', 'workbuddy:codex', 'workbuddy:codebuddy', 'workbuddy:cursor'].sort());
  assert.ok(routes.every(route => ['adapted', 'client_pending'].includes(route.maturity)), 'An API capability needs an explicit maturity rather than an implied working client connection.');
});

test('adapted map paths never infer a reverse arrow from an available standard API', async () => {
  const page = harness(); await settle();
  const shared = page.elements.get('portal-route-codex-codebuddy');
  for (const selected of ['codex', 'codebuddy', 'workbuddy', 'cursor', 'claude', 'all']) {
    page.run(`selectPortalEcosystem(${JSON.stringify(selected)})`);
    assert.equal(shared.getAttribute('data-stage'), 'adapted');
    assert.equal(shared.getAttribute('marker-start'), 'none', 'The pending CodeBuddy client must not become a second arrow.');
    assert.equal(shared.getAttribute('marker-end'), 'url(#portal-route-arrow)');
  }
  for (const path of ['codex-cursor', 'claude-codebuddy']) assert.equal(page.elements.get(`portal-route-${path}`).getAttribute('data-stage'), 'adapted');
  for (const path of ['workbuddy-codex', 'workbuddy-codebuddy', 'workbuddy-cursor', 'codebuddy-cursor']) {
    assert.equal(page.elements.get(`portal-route-${path}`).getAttribute('data-stage'), 'client_pending');
  }
  assert.match(css, /\.portal-world-art\s+\.world-routes\s+path\[data-stage=["']?client_pending["']?\]\s*\{[^}]*display\s*:\s*none\b/);
});

test('initial customer map hides pending client arrows even before the JavaScript has loaded', () => {
  const path = id => {
    const match = html.match(new RegExp(`<path\\b([^>]*\\bid="portal-route-${id}"[^>]*)>`));
    assert.ok(match, id);
    return new Element('path', match[1]);
  };
  for (const id of ['codex-codebuddy', 'codex-cursor', 'claude-codebuddy']) {
    const line = path(id);
    assert.equal(line.getAttribute('data-stage'), 'adapted');
    assert.equal(line.getAttribute('marker-start') ?? 'none', 'none');
    assert.equal(line.getAttribute('marker-end'), 'url(#portal-route-arrow)');
  }
  for (const id of ['workbuddy-codex', 'workbuddy-codebuddy', 'workbuddy-cursor', 'codebuddy-cursor']) {
    const line = path(id);
    assert.equal(line.getAttribute('data-stage'), 'client_pending');
    assert.equal(line.getAttribute('marker-end') ?? 'none', 'none');
  }
});

test('default map keeps pending desktop client directions separate from adapted routes and avoids a mutual-connection legend', async () => {
  const page = harness(); await settle();
  const pending = allText(page.elements.get('portal-ecosystem-pending'));
  for (const route of [
    'CodeBuddy 客户端 → Codex 账号 B', 'CodeBuddy 客户端 → Cursor 额度',
    'WorkBuddy 客户端 → Codex 账号 B', 'WorkBuddy 客户端 → CodeBuddy 额度', 'WorkBuddy 客户端 → Cursor 额度',
  ]) assert.ok(pending.includes(route), route);
  assert.doesNotMatch(allText(page.elements.get('portal-ecosystem-routes')), /(?:CodeBuddy|WorkBuddy) 客户端/);
  assert.doesNotMatch(html, />双向调用</);
  assert.match(html, /(?:未完成|待)[^<>]{0,40}(?:桌面端|接入|验收)|(?:桌面端)[^<>]{0,40}(?:未完成|待)/);
});

test('CodeBuddy selection labels inbound adapted callers and keeps its own outbound desktop requests pending', async () => {
  const page = harness(); await settle();
  page.elements.get('portal-node-codebuddy').trigger('click');
  const adapted = allText(page.elements.get('portal-ecosystem-routes'));
  assert.ok(adapted.includes('Codex 客户端 → CodeBuddy 额度'));
  assert.ok(adapted.includes('Claude 客户端 → CodeBuddy 额度'));
  assert.doesNotMatch(adapted, /CodeBuddy 客户端/);
  const pending = allText(page.elements.get('portal-ecosystem-pending'));
  assert.ok(pending.includes('CodeBuddy 客户端 → Codex 账号 B'));
  assert.ok(pending.includes('CodeBuddy 客户端 → Cursor 额度'));
});

test('WorkBuddy selection shows only its pending desktop setup directions and expands their explanation without requests', async () => {
  const page = harness({ location: 'http://127.0.0.1:43159/register' }); await settle();
  credentials(page); page.elements.get('invite-code').value = 'keep-this-optional-invite';
  const calls = page.calls.length;
  page.elements.get('portal-node-workbuddy').trigger('click');
  assert.equal(page.elements.get('portal-node-workbuddy').getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(allText(page.elements.get('portal-ecosystem-routes')), /WorkBuddy 客户端/);
  const pending = allText(page.elements.get('portal-ecosystem-pending'));
  for (const source of ['Codex 账号 B', 'CodeBuddy 额度', 'Cursor 额度']) assert.ok(pending.includes(`WorkBuddy 客户端 → ${source}`));
  assert.equal(page.elements.get('portal-pending-details').open, true);
  assert.match(page.elements.get('portal-ecosystem-copy').textContent, /待接入|未完成|未接入|未验收/);
  assert.equal(page.elements.get('password').value, 'correct-password-123');
  assert.equal(page.elements.get('invite-code').value, 'keep-this-optional-invite');
  assert.equal(page.calls.length, calls);
});
