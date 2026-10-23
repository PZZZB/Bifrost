import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const json = (data, status = 200) => Response.json(data, { status });
const originalModels = () => ({ revision: 1, models: [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', channel: 'A', enabled: true },
  { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy Opus 5.5', channel: 'CodeBuddy', enabled: true },
] });

class Element {
  constructor(tag = 'div', attributes = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.hidden = false; this.disabled = false; this.tabIndex = this.tagName === 'BUTTON' ? 0 : -1;
    this.textContent = ''; this.className = ''; this.checked = false; this.style = {};
    this.options = []; this.value = '';
    for (const [, name, doubleQuoted, singleQuoted, unquoted] of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      this.setAttribute(name, doubleQuoted ?? singleQuoted ?? unquoted ?? '');
    }
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  trigger(type, options = {}) {
    const event = { target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...options };
    if (type !== 'click' || !this.disabled) this.listeners.get(type)?.(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; if (this.tagName === 'SELECT') this.options = nodes; }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'id') this.id = String(value);
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
    return [...included.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)]
      .every(([, name, value]) => value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) {
    return this.children.flatMap(node => node instanceof Element ? [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)] : []);
  }
}

function harness(overrides = {}) {
  const elements = new Map([...html.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attributes, id]) => [id, new Element(tag, attributes)]));
  const calls = [], intervals = [], tabs = [], historyCalls = [], windowListeners = new Map();
  const location = new URL(overrides.location ?? 'http://127.0.0.1:43155/');
  let clock = 0, token = 'old-service-csrf', models = overrides.models ?? originalModels(), cursor = overrides.cursor ?? { configured: true, enabled: false,
    authReady: false, profile: null, plan: { declared: 'Teams', verified: false }, login: { state: 'not_started' }, catalog: { models: [] }, gateway: {} };
  let backend = overrides.backend ?? { running: true, login: {} }, codebuddy = overrides.codebuddy ?? { configured: false };
  let quotas = overrides.quotas ?? { accounts: { A: { status: 'ok', windows: [] }, B: { status: 'ok', windows: [] } } };
  const control = { supported: true, platform: 'win32', pending: false, activeRequests: 0, ready: true, independentOfCodex: true };
  const document = { hidden: false, body: new Element('body'), activeElement: null,
    getElementById(id) { return elements.get(id) ?? null; },
    createElement(tag) { const element = new Element(tag); element.ownerDocument = document; return element; },
    addEventListener() {}, querySelectorAll(selector) {
      return [...new Set([...elements.values()].flatMap(element => [element, ...element.querySelectorAll('*')]))]
        .filter(element => element.matches(selector));
    } };
  for (const element of [...elements.values(), document.body]) element.ownerDocument = document;
  const snapshot = () => ({ csrfToken: token, ready: true, gateway: { requests: 12, completed: 11, failed: 1,
    accounts: { A: { requests: 7, completed: 7, failed: 0 }, B: { requests: 5, completed: 4, failed: 1 } } },
    backend, integration: {}, verification: {} });
  const fetch = async (path, options = {}) => {
    const call = { path, method: options.method ?? 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (overrides.fetch) {
      const result = await overrides.fetch(call, api);
      if (result !== undefined) return result;
    }
    if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
    if (path === '/health') return json({ ok: true });
    if (path === '/api/status') return json(snapshot());
    if (path === '/api/service/status') return json(control);
    if (path === '/api/model-settings') {
      if (call.method === 'POST') { models = { ...models, revision: models.revision + 1,
        models: models.models.map(model => ({ ...model, enabled: !call.body.disabledModels.includes(model.id) })) }; }
      return json(models);
    }
    if (path === '/api/cursor') return json(cursor);
    if (path === '/api/with') return json({ configured: false });
    if (path === '/api/codebuddy') return json(codebuddy);
    if (path === '/api/token-usage') return json({ accounts: {}, totals: {}, recent: [] });
    if (path === '/api/account-quotas') return json(quotas);
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  const api = { calls, elements, intervals, tabs, control, document, location, historyCalls,
    set token(value) { token = value; }, get token() { return token; },
    set models(value) { models = value; }, get models() { return models; },
    set cursor(value) { cursor = value; }, get cursor() { return cursor; },
    set backend(value) { backend = value; }, get backend() { return backend; },
    set codebuddy(value) { codebuddy = value; }, get codebuddy() { return codebuddy; },
    set quotas(value) { quotas = value; }, get quotas() { return quotas; },
    changeHash(value) { location.hash = value; windowListeners.get('hashchange')?.({ type: 'hashchange' }); },
    get elapsed() { return clock; } };
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, fetch, Response, Headers, AbortSignal, URL, navigator: {}, Date: Clock,
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    window: { location, history: { replaceState(state, title, url) { historyCalls.push({ state, title, url }); location.href = new URL(url, location).href; } },
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      open() { const tab = { opener: {}, location: { replace(value) { tab.url = value; } }, close() { tab.closed = true; } }; tabs.push(tab); return tab; } },
    clearTimeout() {}, setTimeout(callback, milliseconds) {
      if (milliseconds <= 2000) { clock += milliseconds; queueMicrotask(callback); }
      return 1;
    }, setInterval(callback, milliseconds) { intervals.push({ callback, milliseconds }); return 1; } });
  vm.runInContext(source, context, { filename: 'public/app.js' });
  api.run = expression => vm.runInContext(expression, context);
  return api;
}
async function settle() { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); }

test('dashboard initializes read-only, preserves A/B statistics, and does not periodically refresh account quotas', async () => {
  const page = harness(); await settle();
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  assert.equal(page.elements.get('metric-a-requests').textContent, '7');
  assert.equal(page.elements.get('metric-b-requests').textContent, '5');
  assert.equal(page.elements.get('service-restart-button').disabled, false);
  assert.equal(page.calls.filter(call => call.path === '/api/account-quotas').length, 1);
  for (const interval of page.intervals) interval.callback();
  await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/account-quotas').length, 1);
});

test('old backend 404 affects only new controls and never hides original account statistics', async () => {
  const page = harness({ fetch(call) {
    if (['/api/service/status', '/api/model-settings', '/api/cursor'].includes(call.path)) return json({ error: { message: 'missing' } }, 404);
  } }); await settle();
  assert.match(page.elements.get('service-error').textContent, /重启服务后可用/);
  assert.match(page.elements.get('model-settings-error').textContent, /重启服务后可用/);
  assert.equal(page.elements.get('service-restart-button').disabled, true);
  assert.equal(page.elements.get('connection-label').textContent, '本机服务已就绪');
  assert.equal(page.elements.get('metric-a-requests').textContent, '7');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('busy restart requires a separate explicit confirmation and cancellation sends no second POST', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/service/restart') {
      assert.equal(call.body.allowInterrupt, false); api.control.activeRequests = 3;
      // Older error envelopes contain no structured count; GET status supplies it.
      return json({ error: { message: 'Active requests', code: 'gateway_busy' } }, 409);
    }
  } }); await settle();
  await page.run('restartService(false)'); await settle();
  assert.equal(page.elements.get('service-confirmation').hidden, false);
  assert.match(page.elements.get('service-confirmation-message').textContent, /3 个请求/);
  assert.deepEqual(page.calls.filter(call => call.path === '/api/service/restart').map(call => call.body), [{ allowInterrupt: false }]);
  page.elements.get('service-cancel-button').trigger('click');
  assert.equal(page.elements.get('service-confirmation').hidden, true);
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('accepted restart waits for a new process token, bootstraps cookie, and subsequent POST uses fresh CSRF', async () => {
  let accepted = false, bootstraps = 0;
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/service/restart') { accepted = true; api.control.pending = true; return json({ accepted: true, reconnectAfterMs: 750 }, 202); }
    if (accepted && call.path === '/') {
      bootstraps++;
      if (bootstraps === 2) { api.token = 'new-service-csrf'; api.control.pending = false; }
    }
  } }); await settle();
  await page.run('restartService(false)'); await settle();
  assert.ok(bootstraps >= 2, 'Old healthy process is not reported as a completed restart.');
  assert.match(page.elements.get('service-message').textContent, /已重启并恢复连接/);
  await page.run("post('/api/model-settings', { revision: 1, disabledModels: [] })");
  assert.equal(page.calls.findLast(call => call.method === 'POST').headers['X-Bridge-CSRF'], 'new-service-csrf');
  const rootIndex = page.calls.findIndex(call => call.path === '/');
  assert.ok(page.calls.slice(rootIndex + 1).some(call => call.path === '/api/status'));
});

test('interrupting restart is submitted only after clicking its explicit confirmation button', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/service/restart') {
      if (call.body.allowInterrupt === false) {
        api.control.activeRequests = 2;
        return json({ activeRequests: 2, error: { message: 'Busy', code: 'gateway_busy' } }, 409);
      }
      api.token = 'new-confirmed-restart-csrf'; api.control.activeRequests = 0;
      return json({ accepted: true, reconnectAfterMs: 750 }, 202);
    }
  } }); await settle();
  await page.run('restartService(false)'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
  page.elements.get('service-confirm-button').trigger('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.path === '/api/service/restart').map(call => call.body), [
    { allowInterrupt: false }, { allowInterrupt: true },
  ]);
  assert.equal(page.elements.get('service-confirmation').hidden, true);
  assert.match(page.elements.get('service-message').textContent, /已重启并恢复连接/);
});

test('unchanged old service times out without claiming success or automatically retrying restart POST', async () => {
  const page = harness({ fetch(call) { if (call.path === '/api/service/restart') return json({ accepted: true, reconnectAfterMs: 750 }, 202); } });
  await settle(); await page.run('restartService(false)'); await settle();
  assert.ok(page.elapsed >= 60000);
  assert.match(page.elements.get('notice').textContent, /60 秒内未确认/);
  assert.doesNotMatch(page.elements.get('service-message').textContent, /已重启并恢复连接/);
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('a restart cancelled by the supervisor reports its real error promptly', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/service/restart') { api.control.error = '出现了新的活跃请求，本次重启已取消。'; return json({ accepted: true }, 202); }
  } }); await settle(); await page.run('restartService(false)'); await settle();
  assert.match(page.elements.get('service-error').textContent, /本次重启已取消/);
  assert.match(page.elements.get('notice').textContent, /服务重启未完成/);
  assert.ok(page.elapsed < 60000);
  assert.equal(page.elements.get('service-restart-button').disabled, false, 'A reported restart error must not permanently disable retry.');
});

test('model edits survive polling and are saved only by explicit button with exact revision', async () => {
  const page = harness(); await settle();
  const checkbox = page.elements.get('model-settings-list').querySelectorAll('input')[0];
  checkbox.checked = false; checkbox.trigger('change');
  await page.run('refreshModelSettings()');
  assert.equal(checkbox.checked, false);
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const saved = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(saved.body, { revision: 1, disabledModels: ['gpt-6.1-sol'] });
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  assert.match(page.elements.get('model-settings-message').textContent, /已保存.*刷新模型目录/);
});

test('model revision conflict reloads actual server selection instead of silently overwriting another page', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/model-settings' && call.method === 'POST') {
      api.models = { revision: 2, models: originalModels().models.map(model => ({ ...model, enabled: model.channel === 'A' })) };
      return json({ error: { message: 'Revision conflict' } }, 409);
    }
  } }); await settle();
  const checkbox = page.elements.get('model-settings-list').querySelectorAll('input')[0];
  checkbox.checked = false; checkbox.trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.deepEqual(page.elements.get('model-settings-list').querySelectorAll('input').map(input => input.checked), [true, false]);
  assert.match(page.elements.get('model-settings-message').textContent, /重新勾选后保存/);
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').length, 1);
});

test('Cursor authorization requires a click, checks exact official origin, and never displays credentials', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/cursor/login') {
      api.cursor = { ...api.cursor, login: { state: 'pending', url: 'https://cursor.com/login?fixture=1' } };
      return json({ url: api.cursor.login.url });
    }
  } }); await settle();
  assert.equal(page.calls.some(call => call.path === '/api/cursor/login'), false);
  page.elements.get('cursor-login-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/cursor/login').length, 1);
  assert.equal(page.tabs[0].url, 'https://cursor.com/login?fixture=1');
  assert.equal(page.tabs[0].opener, null);
  assert.equal(page.elements.get('cursor-authorization-link').hidden, false);
  for (const url of ['https://cursor.com.evil.example/login', 'https://user:pass@cursor.com/login', 'https://cursor.com:8443/login', 'http://cursor.com/login', 'https://auth.cursor.com/login']) {
    assert.equal(page.run(`safeCursorAuthorizationUrl(${JSON.stringify(url)})`), null);
  }
  page.cursor = { ...page.cursor, enabled: true, authReady: true, profile: { email: 'fixture@example.test' },
    plan: { declared: 'Teams', verified: false }, login: { state: 'complete' }, catalog: { models: [{ id: 'gemini-4-argon' }, { id: 'grok-4.7' }] } };
  page.models = { revision: 2, models: [...originalModels().models,
    { id: 'Cursor-gemini-4-argon', name: 'Cursor Gemini 4', channel: 'Cursor', enabled: false },
    { id: 'Cursor-grok-4.7', name: 'Cursor Grok 4.7', channel: 'Cursor', enabled: false }] };
  await page.run('refreshCursor()'); await settle();
  assert.equal(page.elements.get('cursor-account').textContent, 'fixture@example.test');
  assert.equal(page.elements.get('cursor-plan').textContent, 'Teams（待核实）');
  assert.equal(page.elements.get('cursor-catalog-models').textContent, '已发现 2 项，当前账号目录未返回');
  assert.equal(page.elements.get('cursor-enabled-models').textContent, '0 项（已保存）');
});

const completeModels = () => ({ revision: 7, discovery: { CodeBuddy: { state: 'ready', count: 3 }, Cursor: { state: 'ready', count: 3 } }, models: [
  { id: 'original-a', name: 'Original A', channel: 'A', enabled: true },
  { id: 'original-b', name: 'Original B', channel: 'B', enabled: false },
  { id: 'cb-opus', name: 'Opus', channel: 'CodeBuddy', enabled: true, available: true },
  { id: 'cb-other', name: 'Another CodeBuddy model', channel: 'CodeBuddy', enabled: false, available: true },
  { id: 'cb-unsupported', name: 'Video model', channel: 'CodeBuddy', enabled: true, available: false, reason: '暂未适配视频输出。' },
  { id: 'cursor-first', name: 'Another Cursor model', channel: 'Cursor', enabled: false, available: true },
  { id: 'cursor-second', name: 'Second Cursor model', channel: 'Cursor', enabled: false, available: true },
  { id: 'cursor-unavailable', name: 'Temporarily unavailable', channel: 'Cursor', enabled: false, available: false, reason: '账号当前未返回此模型。' },
] });
function catalogPage(data = completeModels(), fetch) {
  return harness({ fetch(call, api) {
    const overridden = fetch?.(call, api);
    if (overridden !== undefined) return overridden;
    if (call.path === '/api/model-settings' && call.method === 'GET' && api.models.revision === 1) api.models = structuredClone(data);
    if (call.path === '/api/cursor') return json({ ...api.cursor, enabled: true, authReady: true });
    if (call.path === '/api/codebuddy') return json({ configured: true, running: true, provider: { authenticated: true, ready: true, modelAvailable: true } });
  } });
}
const modelInputs = page => page.elements.get('model-settings-list').querySelectorAll('input');
const inputFor = (page, id) => modelInputs(page).find(input => input.value === id);
const listText = element => [element.textContent, ...element.children.map(child => child instanceof Element ? listText(child) : String(child))].join(' ');
const groupButton = (page, channel, title) => page.elements.get('model-settings-list').querySelectorAll('button')
  .find(button => button.attributes.get('aria-label') === `${channel}：${title}（当前搜索结果）`);

test('complete account catalogs include other models and keep source availability separate from saved selection', async () => {
  const page = catalogPage(); await settle();
  assert.deepEqual(modelInputs(page).map(input => input.value), completeModels().models.map(model => model.id));
  assert.equal(inputFor(page, 'cb-other').disabled, false, 'User-disabled models remain selectable.');
  assert.equal(inputFor(page, 'cb-unsupported').disabled, true);
  assert.equal(inputFor(page, 'cb-unsupported').checked, true, 'Upstream unavailability must not erase a saved selection.');
  assert.equal(inputFor(page, 'cursor-unavailable').disabled, true);
  assert.match(listText(page.elements.get('model-settings-list')), /暂未适配视频输出/);
  assert.equal(page.elements.get('codebuddy-title').textContent, 'CodeBuddy');
  assert.equal(page.elements.get('codebuddy-model-available').textContent, '3 项（当前账号目录）');
  assert.equal(page.elements.get('codebuddy-enabled-models').textContent, '1 项（已保存）');
  assert.equal(page.elements.get('cursor-catalog-models').textContent, '3 项（当前账号目录）');
  assert.equal(page.elements.get('cursor-enabled-models').textContent, '0 项（已保存）');
  for (const input of modelInputs(page).filter(input => ['original-a', 'original-b'].includes(input.value))) assert.equal(input.disabled, false);
});

test('search and bulk changes affect only available models in the current channel and filter', async () => {
  const page = catalogPage(); await settle();
  const search = page.elements.get('model-settings-search'); search.value = 'CodeBuddy'; search.trigger('input');
  assert.deepEqual(modelInputs(page).map(input => input.value), ['cb-opus', 'cb-other', 'cb-unsupported']);
  groupButton(page, 'CodeBuddy', '全选可用项').trigger('click');
  assert.equal(inputFor(page, 'cb-other').checked, true);
  search.value = 'Opus'; search.trigger('input');
  assert.deepEqual(modelInputs(page).map(input => input.value), ['cb-opus']);
  groupButton(page, 'CodeBuddy', '全关可用项').trigger('click');
  search.value = ''; search.trigger('input');
  assert.equal(inputFor(page, 'original-a').checked, true); assert.equal(inputFor(page, 'original-b').checked, false);
  assert.equal(inputFor(page, 'cb-opus').checked, false); assert.equal(inputFor(page, 'cb-other').checked, true);
  assert.equal(inputFor(page, 'cb-unsupported').checked, true); assert.equal(inputFor(page, 'cursor-first').checked, false);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(save.body, { revision: 7, disabledModels: ['original-b', 'cb-opus', 'cursor-first', 'cursor-second', 'cursor-unavailable'] });
});

test('manual catalog refresh updates all rows and unavailability while retaining edits and revision conflict protection', async () => {
  const page = catalogPage(); await settle();
  const edit = inputFor(page, 'original-a'); edit.checked = false; edit.trigger('change');
  const enabling = inputFor(page, 'cb-other'); enabling.checked = true; enabling.trigger('change');
  page.models = { revision: 8, discovery: {}, models: [...completeModels().models.map(model => model.id === 'cb-other'
    ? { ...model, available: false, reason: '提供方暂时停止服务。' } : model),
    { id: 'cursor-new', name: 'New Cursor model', channel: 'Cursor', enabled: false, available: true }] };
  page.elements.get('model-settings-refresh-button').trigger('click'); await settle();
  assert.equal(inputFor(page, 'original-a').checked, false);
  assert.equal(inputFor(page, 'cb-other').disabled, true);
  assert.equal(inputFor(page, 'cb-other').checked, false, 'A now-unavailable unsaved enable must not trap other edits behind an impossible save.');
  assert.equal(inputFor(page, 'cursor-new').checked, false);
  assert.match(listText(page.elements.get('model-settings-list')), /提供方暂时停止服务/);
  assert.match(page.elements.get('model-settings-message').textContent, /目录已刷新.*勾选已保留/);
  assert.equal(page.run('modelSettings.revision'), 7, 'Saving must still detect an intervening server revision.');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('statistics polling never rereads full catalogs while the manual refresh button does', async () => {
  const page = catalogPage(); await settle();
  const initial = page.calls.filter(call => call.path === '/api/model-settings').length;
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings').length, initial);
  page.elements.get('model-settings-refresh-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings').length, initial + 1);
  assert.equal(page.calls.some(call => call.path === '/api/models'), false);
});

test('one catalog discovery failure leaves other channels editable and exposes the safe reason as text', async () => {
  const snapshot = completeModels(); snapshot.discovery = { CodeBuddy: { state: 'error', message: '<img src=x onerror=fixture>目录超时', checkedAt: 1 } };
  const page = catalogPage(snapshot); await settle();
  assert.equal(page.elements.get('model-settings-discovery').hidden, false);
  assert.equal(page.elements.get('model-settings-discovery').textContent, 'CodeBuddy：<img src=x onerror=fixture>目录超时');
  assert.equal(page.elements.get('model-settings-discovery').children.length, 0);
  assert.equal(inputFor(page, 'cursor-first').disabled, false);
  assert.equal(page.elements.get('model-settings-error').hidden, true);
});

test('searching preserves hidden selections and reports an empty match without changing saved account counts', async () => {
  const page = catalogPage(); await settle();
  const edit = inputFor(page, 'cb-opus'); edit.checked = false; edit.trigger('change');
  assert.equal(page.elements.get('codebuddy-enabled-models').textContent, '1 项（已保存）');
  const search = page.elements.get('model-settings-search'); search.value = 'does-not-exist'; search.trigger('input');
  assert.equal(modelInputs(page).length, 0);
  assert.match(listText(page.elements.get('model-settings-list')), /没有匹配的模型/);
  assert.match(page.elements.get('model-settings-summary').textContent, /显示 0 \/ 8 项/);
  search.value = ''; search.trigger('input');
  assert.equal(inputFor(page, 'cb-opus').checked, false);
});

test('account card directory counts use current discovery instead of accumulated historical rows', async () => {
  const snapshot = completeModels(); snapshot.discovery.CodeBuddy.count = 1;
  const page = catalogPage(snapshot); await settle();
  assert.equal(page.elements.get('codebuddy-model-available').textContent, '1 项（当前账号目录）');
  assert.equal(modelInputs(page).filter(input => input.value.startsWith('cb-')).length, 3);
  page.models = { ...snapshot, discovery: { CodeBuddy: { state: 'error', count: 1, message: '目录暂不可用。' }, Cursor: { state: 'disabled', count: 3 } } };
  page.elements.get('model-settings-refresh-button').trigger('click'); await settle();
  assert.equal(page.elements.get('codebuddy-model-available').textContent, '当前账号目录未读取');
  assert.equal(page.elements.get('cursor-catalog-models').textContent, '当前账号目录未读取');
  assert.equal(modelInputs(page).length, 8, 'Historical records remain in the selectable directory with their availability reasons.');
});

const legacyModelSettings = () => ({ revision: 5, models: [...originalModels().models,
  { id: 'Cursor-gemini-4-argon', name: 'Cursor Gemini 4', channel: 'Cursor', enabled: false, available: true },
  { id: 'Cursor-grok-4.7', name: 'Cursor Grok 4.7', channel: 'Cursor', enabled: false, available: true },
] });

test('legacy model settings keep existing rows visible and explicitly require a gateway restart for full catalogs', async () => {
  for (const discovery of [undefined, null, [], 'legacy']) {
    const data = legacyModelSettings();
    if (discovery !== undefined) data.discovery = discovery;
    const page = catalogPage(data); await settle();
    const banner = page.elements.get('model-settings-discovery');
    assert.equal(banner.hidden, false);
    assert.match(banner.textContent, /重启网关服务/); assert.match(banner.textContent, /完整模型目录/);
    assert.equal(page.elements.get('model-settings-state').textContent, '待重启加载目录');
    assert.doesNotMatch(page.elements.get('model-settings-state').className, /\bsuccess\b/);
    assert.deepEqual(modelInputs(page).map(input => input.value), data.models.map(model => model.id));
    assert.equal(page.elements.get('model-settings-error').hidden, true);
    assert.equal(page.calls.some(call => call.method === 'POST'), false);
  }
});

test('manual refresh of a legacy backend retains the restart warning and never reports a completed full catalog refresh', async () => {
  const page = catalogPage(legacyModelSettings()); await settle();
  const initialReads = page.calls.filter(call => call.path === '/api/model-settings').length;
  page.elements.get('model-settings-refresh-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings').length, initialReads + 1);
  assert.equal(page.elements.get('model-settings-discovery').hidden, false);
  assert.match(page.elements.get('model-settings-message').textContent, /重启网关服务/);
  assert.doesNotMatch(page.elements.get('model-settings-message').textContent, /账号目录已刷新|账号目录已更新/);
  assert.equal(page.elements.get('model-settings-state').textContent, '待重启加载目录');
  assert.equal(page.calls.some(call => call.method === 'POST'), false, 'Reading a legacy directory must never restart or mutate the service automatically.');
});

test('a current backend clears the legacy catalog warning while preserving unsaved choices and revision protection', async () => {
  const page = catalogPage(legacyModelSettings()); await settle();
  const checkbox = inputFor(page, 'claude-codebuddy-opus-5-5'); checkbox.checked = false; checkbox.trigger('change');
  assert.equal(page.elements.get('model-settings-discovery').hidden, false);
  assert.equal(page.elements.get('model-settings-state').textContent, '有未保存更改');
  page.models = { revision: 6, discovery: { CodeBuddy: { state: 'ready', count: 2 }, Cursor: { state: 'ready', count: 2 } },
    models: [...legacyModelSettings().models, { id: 'CodeBuddy-new-fixture-model', name: 'New CodeBuddy model', channel: 'CodeBuddy', enabled: false, available: true }] };
  page.elements.get('model-settings-refresh-button').trigger('click'); await settle();
  assert.equal(page.elements.get('model-settings-discovery').hidden, true);
  assert.doesNotMatch(page.elements.get('model-settings-discovery').textContent, /重启网关服务/);
  assert.equal(inputFor(page, 'claude-codebuddy-opus-5-5').checked, false);
  assert.equal(inputFor(page, 'CodeBuddy-new-fixture-model').checked, false);
  assert.equal(page.elements.get('model-settings-state').textContent, '有未保存更改');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.match(page.elements.get('model-settings-message').textContent, /账号目录已刷新.*勾选已保留/);
  assert.equal(page.run('modelSettings.revision'), 5, 'Refreshing the server must not silently upgrade an unsaved draft revision.');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

const quotaSnapshot = () => ({ timeZone: 'America/Los_Angeles', accounts: {
  A: { status: 'ok', authenticated: true, identity: 'account-a@example.test', source: 'OpenAI account A', planType: 'Pro',
    fetchedAt: 1792713600000, windows: [{ label: '5 小时', remainingPercent: 25, resetsAt: 1792717200 }], credits: null },
  B: { status: 'ok', authenticated: true, identity: 'account-b@example.test', source: 'OpenAI account B', planType: 'Business',
    fetchedAt: 1792713600000, windows: [{ label: '每周', remainingPercent: 75 }], credits: null },
  CodeBuddy: { status: 'unknown', authenticated: true, identity: 'codebuddy-employee', source: 'CodeBuddy official session',
    planType: null, fetchedAt: 1792713600000, windows: [], credits: null, usageUrl: 'https://www.codebuddy.cn/home/',
    notice: 'CodeBuddy 未提供可靠的套餐剩余额度。' },
  Cursor: { status: 'unknown', authenticated: true, identity: 'cursor-user@example.test', source: 'Cursor official SDK',
    planType: 'Teams', fetchedAt: 1792713600000, windows: [], credits: null, usageUrl: 'https://cursor.com/dashboard/usage',
    notice: '请在 Cursor 官方页面确认套餐余量。' },
} });
function quotaPage(snapshot = quotaSnapshot()) {
  let current = snapshot;
  const page = harness({ fetch(call) { if (call.path === '/api/account-quotas') return json(current); } });
  page.setQuotas = value => { current = value; };
  return page;
}

test('four quota cards bind each provider identity and preserve real A/B percentages without inventing provider balances', async () => {
  const page = quotaPage(); await settle();
  for (const [prefix, identity] of [['a', 'account-a@example.test'], ['b', 'account-b@example.test'],
    ['codebuddy', 'codebuddy-employee'], ['cursor', 'cursor-user@example.test']]) {
    assert.equal(page.elements.get(`quota-${prefix}-identity`).textContent, identity);
  }
  assert.match(listText(page.elements.get('quota-a-windows')), /剩余 25%/);
  assert.match(listText(page.elements.get('quota-b-windows')), /剩余 75%/);
  assert.equal(page.elements.get('quota-a-windows').querySelectorAll('progress')[0].value, 25);
  assert.equal(page.elements.get('quota-b-windows').querySelectorAll('progress')[0].value, 75);
  for (const prefix of ['codebuddy', 'cursor']) {
    assert.equal(page.elements.get(`quota-${prefix}-state`).textContent, '未提供余额');
    assert.equal(listText(page.elements.get(`quota-${prefix}-windows`)).trim(), '未提供剩余额度');
    assert.equal(page.elements.get(`quota-${prefix}-windows`).querySelectorAll('progress').length, 0);
    assert.equal(page.elements.get(`quota-${prefix}-error`).hidden, true);
    assert.equal(page.elements.get(`quota-${prefix}-credits`).hidden, true);
    assert.equal(page.elements.get(`quota-${prefix}-usage-link`).hidden, false);
  }
  assert.equal(page.elements.get('quota-cursor-source').textContent, 'Cursor official SDK');
  assert.equal(page.elements.get('quota-codebuddy-notice').textContent, 'CodeBuddy 未提供可靠的套餐剩余额度。');
});

test('unknown quota ignores numeric placeholders and renders provider notices and identities only as text', async () => {
  const snapshot = quotaSnapshot();
  Object.assign(snapshot.accounts.Cursor, { identity: '<img src=x onerror=fixture>', notice: '<script>fixture</script>',
    windows: [{ remainingPercent: 0 }, { remainingPercent: 100 }], credits: { unlimited: true, balance: '0' } });
  const page = quotaPage(snapshot); await settle();
  assert.equal(page.elements.get('quota-cursor-identity').textContent, '<img src=x onerror=fixture>');
  assert.equal(page.elements.get('quota-cursor-identity').children.length, 0);
  assert.equal(page.elements.get('quota-cursor-notice').textContent, '<script>fixture</script>');
  assert.equal(page.elements.get('quota-cursor-notice').children.length, 0);
  assert.doesNotMatch(listText(page.elements.get('quota-cursor-windows')), /(?:0|100)%/);
  assert.equal(page.elements.get('quota-cursor-windows').querySelectorAll('progress').length, 0);
  assert.equal(page.elements.get('quota-cursor-credits').hidden, true);
});

test('legacy quota responses identify missing provider support instead of borrowing binding from account cards', async () => {
  const page = catalogPage(); await settle();
  for (const prefix of ['codebuddy', 'cursor']) {
    assert.equal(page.elements.get(`quota-${prefix}-state`).textContent, '待更新服务');
    assert.equal(page.elements.get(`quota-${prefix}-identity`).textContent, '服务未返回账号信息');
    assert.match(listText(page.elements.get(`quota-${prefix}-windows`)), /当前服务未提供/);
    assert.equal(page.elements.get(`quota-${prefix}-usage-link`).hidden, true);
    assert.equal(page.elements.get(`quota-${prefix}-error`).hidden, true);
  }
  assert.equal(page.elements.get('quota-a-state').textContent, '已更新');
  assert.equal(page.elements.get('quota-b-state').textContent, '已更新');
});

test('unbound and failed quota providers remain distinct and never display a different bound identity', async () => {
  const snapshot = quotaSnapshot();
  snapshot.accounts.CodeBuddy = { status: 'not_connected', authenticated: false, identity: 'must-not-display', windows: [], notice: '请先登录 CodeBuddy。' };
  snapshot.accounts.Cursor = { status: 'error', authenticated: true, identity: 'cursor-real-user', error: '官方元数据暂时不可用。', windows: [] };
  const page = quotaPage(snapshot); await settle();
  assert.equal(page.elements.get('quota-codebuddy-state').textContent, '未绑定');
  assert.equal(page.elements.get('quota-codebuddy-identity').textContent, '未绑定本网关账号');
  assert.equal(page.elements.get('quota-codebuddy-error').hidden, true);
  assert.equal(page.elements.get('quota-cursor-state').textContent, '需检查');
  assert.equal(page.elements.get('quota-cursor-identity').textContent, 'cursor-real-user');
  assert.equal(page.elements.get('quota-cursor-error').textContent, '官方元数据暂时不可用。');
});

test('quota usage links enforce provider-specific exact HTTPS origins and clear stale links', async () => {
  const page = quotaPage(); await settle();
  assert.equal(page.elements.get('quota-cursor-usage-link').href, 'https://cursor.com/dashboard/usage');
  for (const url of ['https://cursor.com.evil.example/dashboard', 'https://user:pass@cursor.com/dashboard',
    'https://cursor.com:8443/dashboard', 'http://cursor.com/dashboard', 'javascript:fixture()', 'https://www.codebuddy.cn/']) {
    assert.equal(page.run(`safeQuotaUsageUrl('Cursor', ${JSON.stringify(url)})`), null);
  }
  for (const url of ['https://codebuddy.cn.evil.example/', 'https://cursor.com/dashboard', 'https://www.codebuddy.cn:8443/']) {
    assert.equal(page.run(`safeQuotaUsageUrl('CodeBuddy', ${JSON.stringify(url)})`), null);
  }
  const changed = quotaSnapshot(); changed.accounts.Cursor.usageUrl = 'https://cursor.com.evil.example/';
  page.setQuotas(changed); page.elements.get('quota-refresh-button').trigger('click'); await settle();
  assert.equal(page.elements.get('quota-cursor-usage-link').hidden, true);
  assert.equal(page.elements.get('quota-cursor-usage-link').href, undefined);
});

test('provider quota identities refresh only on manual action or authorization change, never on statistics polling', async () => {
  const page = quotaPage(); await settle();
  const count = () => page.calls.filter(call => call.path === '/api/account-quotas').length;
  assert.equal(count(), 1);
  for (const interval of page.intervals) interval.callback(); await settle(); assert.equal(count(), 1);
  const changed = quotaSnapshot(); changed.accounts.Cursor.identity = 'after-manual@example.test'; page.setQuotas(changed);
  page.elements.get('quota-refresh-button').trigger('click'); await settle();
  assert.equal(count(), 2); assert.equal(page.elements.get('quota-cursor-identity').textContent, 'after-manual@example.test');
  changed.accounts.Cursor.identity = 'after-login@example.test';
  page.cursor = { ...page.cursor, authReady: true, enabled: true, profile: { email: 'after-login@example.test' } };
  await page.run('refreshCursor()'); await settle();
  assert.equal(count(), 3); assert.equal(page.elements.get('quota-cursor-identity').textContent, 'after-login@example.test');
  for (const interval of page.intervals) interval.callback(); await settle(); assert.equal(count(), 3);
});

function assertSelectedTab(page, selected) {
  for (const name of ['console', 'accounts']) {
    const tab = page.elements.get(`tab-${name}`), panel = page.elements.get(`panel-${name}`);
    assert.ok(tab && panel, `Missing management tab or panel: ${name}`);
    assert.equal(tab.getAttribute('role'), 'tab');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(tab.getAttribute('aria-controls'), panel.id);
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(tab.getAttribute('aria-selected'), String(name === selected));
    assert.equal(tab.tabIndex, name === selected ? 0 : -1);
    assert.equal(panel.hidden, name !== selected);
  }
}

test('management tab switches preserve unsaved model choices and search without requests or rebuilding rows', async () => {
  const page = catalogPage(); await settle(); assertSelectedTab(page, 'console');
  const search = page.elements.get('model-settings-search'); search.value = 'CodeBuddy'; search.trigger('input');
  const checkbox = inputFor(page, 'cb-other'); checkbox.checked = true; checkbox.trigger('change');
  const rows = [...page.elements.get('model-settings-list').children], beforeCalls = page.calls.length;
  page.elements.get('tab-accounts').trigger('click'); assertSelectedTab(page, 'accounts');
  assert.equal(page.location.hash, '#accounts');
  page.elements.get('tab-console').trigger('click'); assertSelectedTab(page, 'console');
  assert.equal(page.location.hash, '#console'); await settle();
  assert.equal(page.calls.length, beforeCalls, 'Changing tabs must not query metadata or submit an action.');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  assert.equal(search.value, 'CodeBuddy'); assert.equal(inputFor(page, 'cb-other'), checkbox);
  assert.equal(checkbox.checked, true); assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.deepEqual(page.elements.get('model-settings-list').children, rows);
});

test('management tabs support keyboard wrapping, Home and End with focus and roving tab stops', async () => {
  const page = harness(); await settle();
  const beforeCalls = page.calls.length;
  for (const [from, key, to] of [['console', 'ArrowLeft', 'accounts'], ['accounts', 'ArrowRight', 'console'],
    ['console', 'ArrowRight', 'accounts'], ['accounts', 'ArrowLeft', 'console'],
    ['console', 'End', 'accounts'], ['accounts', 'Home', 'console']]) {
    const event = page.elements.get(`tab-${from}`).trigger('keydown', { key });
    assert.equal(event.defaultPrevented, true); assertSelectedTab(page, to);
    assert.equal(page.document.activeElement, page.elements.get(`tab-${to}`));
    assert.equal(page.location.hash, `#${to}`);
  }
  const ignored = page.elements.get('tab-console').trigger('keydown', { key: 'Escape' });
  assert.equal(ignored.defaultPrevented, false); assertSelectedTab(page, 'console');
  await settle(); assert.equal(page.calls.length, beforeCalls);
});

test('management tabs honor account deep links and hash navigation without rewriting browser history or requesting data', async () => {
  const page = harness({ location: 'http://127.0.0.1:43155/#accounts' });
  assertSelectedTab(page, 'accounts'); assert.equal(page.historyCalls.length, 0); await settle();
  const beforeCalls = page.calls.length;
  page.changeHash('#console'); assertSelectedTab(page, 'console');
  page.changeHash('#accounts'); assertSelectedTab(page, 'accounts');
  page.changeHash('#unknown'); assertSelectedTab(page, 'console');
  assert.equal(page.historyCalls.length, 0);
  page.run("selectManagementTab('accounts', { focus: true, updateLocation: false })");
  assertSelectedTab(page, 'accounts'); assert.equal(page.location.hash, '#unknown');
  assert.equal(page.document.activeElement, page.elements.get('tab-accounts'));
  await settle(); assert.equal(page.calls.length, beforeCalls);
});

test('disconnected management service leaves tab navigation usable and clears stale account summaries', async () => {
  let disconnected = false;
  const page = allAccountsPage(call => {
    if (disconnected && call.path === '/api/status') throw new Error('Fixture service disconnected');
  }); await settle();
  assert.equal(accountSummary(page, 'b').identity, 'backend-b@example.test');
  disconnected = true; await page.run('refreshStatus().catch(() => {})'); await settle();
  assert.equal(page.elements.get('service-restart-button').disabled, true);
  const beforeCalls = page.calls.length;
  for (const name of ['accounts', 'console']) {
    assert.equal(page.elements.get(`tab-${name}`).disabled, false, 'Disconnected action controls must not disable navigation.');
    page.elements.get(`tab-${name}`).trigger('click'); assertSelectedTab(page, name);
  }
  page.elements.get('tab-console').trigger('keydown', { key: 'End' }); assertSelectedTab(page, 'accounts');
  for (const id of ['a', 'b', 'codebuddy', 'cursor']) {
    assert.equal(accountSummary(page, id).state, '连接中断');
    assert.equal(accountSummary(page, id).identity, '未确认');
    assert.equal(accountSummary(page, id).plan, '未返回');
  }
  await settle(); assert.equal(page.calls.length, beforeCalls);
});

const summaryFields = ['state', 'identity', 'plan', 'method', 'catalog', 'enabled'];
function accountSummary(page, account) {
  return Object.fromEntries(summaryFields.map(field => {
    const element = page.elements.get(`account-${account}-${field}`);
    assert.ok(element, `Missing common account field: ${account}.${field}`);
    return [field, element.textContent];
  }));
}
function allAccountsPage(fetch) {
  const models = completeModels();
  models.discovery = { A: { state: 'ready', count: 1 }, B: { state: 'ready', count: 1 },
    CodeBuddy: { state: 'ready', count: 1 }, Cursor: { state: 'ready', count: 2 } };
  models.models.find(model => model.id === 'cursor-first').enabled = true;
  const quotas = quotaSnapshot();
  Object.assign(quotas.accounts.B, { identity: 'quota-b-must-not-be-borrowed@example.test', planType: 'Quota-only B plan' });
  quotas.accounts.CodeBuddy.identity = 'quota-codebuddy-must-not-be-borrowed';
  quotas.accounts.Cursor.identity = 'quota-cursor-must-not-be-borrowed@example.test';
  return harness({ models, quotas,
    backend: { running: true, account: { email: 'backend-b@example.test', planType: 'Business' }, login: {} },
    codebuddy: { configured: true, running: true, login: {}, provider: { authenticated: true, username: 'codebuddy-session-user', ready: true, modelAvailable: true } },
    cursor: { configured: true, enabled: true, authReady: true, profile: { email: 'cursor-session@example.test' },
      plan: { declared: 'Teams', verified: false }, login: {}, catalog: { models: [{ id: 'current-cursor-1' }, { id: 'current-cursor-2' }] }, gateway: {} },
    fetch(call, api) {
      const overridden = fetch?.(call, api);
      if (overridden !== undefined) return overridden;
      if (call.path === '/api/models') return json({ models: [] });
    } });
}

test('four account summaries share common fields while binding identity, plan and authorization to their own current source', async () => {
  const page = allAccountsPage(); await settle();
  for (const [id, identity, plan, method, count, enabled] of [
    ['a', 'account-a@example.test', 'Pro', /Codex.*未返回/, 1, 1],
    ['b', 'backend-b@example.test', 'Business', /Codex.*授权/, 1, 0],
    ['codebuddy', 'codebuddy-session-user', '未返回', /CodeBuddy.*授权/, 1, 1],
    ['cursor', 'cursor-session@example.test', 'Teams（待核实）', /Cursor.*SDK.*授权/, 2, 1],
  ]) {
    const summary = accountSummary(page, id);
    assert.equal(summary.state, '已登录'); assert.equal(summary.identity, identity); assert.equal(summary.plan, plan);
    assert.match(summary.method, method); assert.equal(summary.catalog, `${count} 项（当前账号目录）`);
    assert.equal(summary.enabled, `${enabled} 项（已保存）`);
  }
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('account summary counts distinguish saved available choices from drafts and historical directory records', async () => {
  const page = allAccountsPage(); await settle();
  assert.equal(modelInputs(page).filter(input => input.value.startsWith('cb-')).length, 3);
  assert.equal(accountSummary(page, 'codebuddy').catalog, '1 项（当前账号目录）');
  const edit = inputFor(page, 'cb-other'); edit.checked = true; edit.trigger('change');
  assert.equal(accountSummary(page, 'codebuddy').enabled, '1 项（已保存）');
  assert.equal(accountSummary(page, 'cursor').catalog, '2 项（当前账号目录）');
  page.models = { ...page.models, revision: 8, discovery: { ...page.models.discovery,
    CodeBuddy: { state: 'error', count: 1, message: 'Fixture directory timeout' } } };
  await page.run('refreshModelSettings()'); await settle();
  assert.equal(accountSummary(page, 'codebuddy').catalog, '当前账号目录未读取');
  assert.equal(accountSummary(page, 'codebuddy').enabled, '1 项（已保存）');
  assert.equal(inputFor(page, 'cb-other').checked, true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('unknown account A authentication is never inferred from traffic, model records or other bound accounts', async () => {
  const page = allAccountsPage(); await settle();
  page.quotas = { accounts: { ...page.quotas.accounts, A: { status: 'unknown', authenticated: null,
    identity: 'unconfirmed-a-must-not-display', planType: 'Unconfirmed plan', windows: [] } } };
  await page.run('refreshAccountQuotas()'); await settle();
  const summary = accountSummary(page, 'a');
  assert.equal(summary.state, '未确认'); assert.equal(summary.identity, '未确认'); assert.equal(summary.plan, '未返回');
  assert.equal(summary.catalog, '登录状态未确认'); assert.equal(summary.enabled, '登录后生效');
  assert.equal(page.elements.get('metric-a-requests').textContent, '7');
  assert.equal(accountSummary(page, 'b').identity, 'backend-b@example.test');
  page.quotas = { accounts: { ...page.quotas.accounts, A: { status: 'error', authenticated: true,
    identity: 'stale-a-must-not-display', planType: 'Stale plan', error: 'Fixture metadata failure' } } };
  await page.run('refreshAccountQuotas()'); await settle();
  assert.equal(accountSummary(page, 'a').state, '读取失败');
  assert.equal(accountSummary(page, 'a').identity, '未确认'); assert.equal(accountSummary(page, 'a').plan, '未返回');
});

test('missing current identity fields never borrow names from quota cards or another account', async () => {
  const page = allAccountsPage(); await settle();
  page.backend = { ...page.backend, account: { planType: 'Business' } };
  page.codebuddy = { ...page.codebuddy, provider: { ...page.codebuddy.provider, username: null } };
  page.cursor = { ...page.cursor, profile: null };
  page.quotas.accounts.A.identity = null;
  await page.run('Promise.all([refreshStatus(), refreshAccountQuotas()])'); await settle();
  for (const id of ['a', 'b', 'codebuddy', 'cursor']) {
    assert.equal(accountSummary(page, id).state, '已登录');
    assert.equal(accountSummary(page, id).identity, '未返回');
  }
  assert.equal(page.elements.get('quota-b-identity').textContent, 'quota-b-must-not-be-borrowed@example.test');
  assert.equal(page.elements.get('quota-codebuddy-identity').textContent, 'quota-codebuddy-must-not-be-borrowed');
  assert.equal(page.elements.get('quota-cursor-identity').textContent, 'quota-cursor-must-not-be-borrowed@example.test');
});

test('backend and provider read failures clear old identities and plans while leaving healthy accounts intact', async () => {
  let providerFailure = false;
  const page = allAccountsPage(call => {
    if (providerFailure && ['/api/codebuddy', '/api/cursor'].includes(call.path)) return json({ error: { message: 'Fixture provider unavailable' } }, 503);
  }); await settle();
  providerFailure = true;
  page.backend = { ...page.backend, error: { message: 'Fixture backend unavailable' } };
  await page.run('refreshStatus()'); await settle();
  for (const id of ['b', 'codebuddy', 'cursor']) {
    assert.equal(accountSummary(page, id).state, '读取失败'); assert.equal(accountSummary(page, id).identity, '未确认');
    assert.equal(accountSummary(page, id).plan, '未返回');
  }
  assert.equal(accountSummary(page, 'a').identity, 'account-a@example.test');
  assert.equal(page.elements.get('account-card').hidden, true);
  assert.equal(page.elements.get('codebuddy-username').textContent, '未确认');
  assert.equal(page.elements.get('cursor-account').textContent, '未确认'); assert.equal(page.elements.get('cursor-plan').textContent, '未返回');
});

test('unauthenticated and pending account statuses hide retained source profiles and old plans', async () => {
  const page = allAccountsPage(); await settle();
  page.backend = { ...page.backend, login: { state: 'pending' } };
  page.codebuddy = { ...page.codebuddy, login: { state: 'pending' } };
  page.cursor = { ...page.cursor, login: { state: 'pending' } };
  await page.run('refreshStatus()'); await settle();
  for (const id of ['b', 'codebuddy', 'cursor']) {
    assert.equal(accountSummary(page, id).state, '等待授权');
    assert.equal(accountSummary(page, id).identity, '未确认'); assert.equal(accountSummary(page, id).plan, '未返回');
  }
  page.backend = { ...page.backend, account: null, pinnedAccount: { email: 'old-pinned-b@example.test' }, login: {} };
  page.codebuddy = { ...page.codebuddy, login: {}, provider: { ...page.codebuddy.provider, authenticated: false } };
  page.cursor = { ...page.cursor, login: {}, authReady: false };
  page.quotas.accounts.A = { ...page.quotas.accounts.A, status: 'not_connected', authenticated: false };
  await page.run('Promise.all([refreshStatus(), refreshAccountQuotas()])'); await settle();
  for (const id of ['a', 'b', 'codebuddy', 'cursor']) {
    assert.equal(accountSummary(page, id).state, '未登录'); assert.equal(accountSummary(page, id).identity, '未登录');
    assert.equal(accountSummary(page, id).plan, '未返回'); assert.equal(accountSummary(page, id).enabled, '登录后生效');
  }
  assert.equal(page.elements.get('codebuddy-username').textContent, '未登录');
  assert.equal(page.elements.get('cursor-account').textContent, '未登录'); assert.equal(page.elements.get('cursor-plan').textContent, '未返回');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function verifyLogoutRefreshIsolation(account, { oldRequest = true } = {}) {
  const routes = {
    b: { status: '/api/status', logout: '/api/logout', button: 'logout-button', refresh: 'refreshStatus', identity: 'backend-b@example.test' },
    codebuddy: { status: '/api/codebuddy', logout: '/api/codebuddy/logout', button: 'codebuddy-logout-button', refresh: 'refreshCodeBuddy', identity: 'codebuddy-session-user' },
    cursor: { status: '/api/cursor', logout: '/api/cursor/logout', button: 'cursor-logout-button', refresh: 'refreshCursor', identity: 'cursor-session@example.test' },
  };
  const route = routes[account], oldRead = deferred(), freshRead = deferred();
  let controlled = false, logoutSucceeded = false, freshGets = 0, oldGets = 0;
  const payload = api => account === 'b'
    ? { csrfToken: api.token, ready: true, gateway: { accounts: {} }, backend: structuredClone(api.backend), integration: {}, verification: {} }
    : structuredClone(account === 'codebuddy' ? api.codebuddy : api.cursor);
  const page = allAccountsPage((call, api) => {
    if (call.method === 'POST' && call.path === route.logout) {
      logoutSucceeded = true;
      if (account === 'b') api.backend = { ...api.backend, account: null, pinnedAccount: null, login: {} };
      if (account === 'codebuddy') api.codebuddy = { ...api.codebuddy, provider: { ...api.codebuddy.provider, authenticated: false } };
      if (account === 'cursor') api.cursor = { ...api.cursor, authReady: false };
      return json({ ok: true });
    }
    if (controlled && call.method === 'GET' && call.path === route.status) {
      if (logoutSucceeded) { freshGets++; return freshRead.promise.then(data => json(data)); }
      oldGets++; return oldRead.promise.then(data => json(data));
    }
  }); await settle();
  assert.equal(accountSummary(page, account).identity, route.identity);
  assert.equal(accountSummary(page, account).state, '已登录');
  const oldPayload = payload(page);
  let pendingOldRead;
  const assertCleared = () => {
    const summary = accountSummary(page, account);
    assert.notEqual(summary.identity, route.identity, 'A successful logout must immediately stop presenting the previous account.');
    assert.notEqual(summary.state, '已登录', 'An unresolved fresh read cannot restore an authenticated state after logout.');
    assert.doesNotMatch(page.elements.get(`account-${account}-state`).className, /\bsuccess\b/);
    assert.equal(summary.plan, '未返回');
  };
  try {
    controlled = true;
    if (oldRequest) {
      pendingOldRead = page.run(`${route.refresh}()`); await settle();
      assert.equal(oldGets, 1, 'The fixture must hold a read started before the logout mutation.');
    }
    page.elements.get(route.button).trigger('click'); await settle();
    assert.equal(logoutSucceeded, true); assertCleared();
    if (oldRequest) {
      oldRead.resolve(oldPayload); await pendingOldRead; await settle();
    }
    assert.ok(freshGets >= 1, 'Logout must query status again instead of adopting an earlier in-flight result.');
    assertCleared();
    assert.equal(accountSummary(page, 'a').identity, 'account-a@example.test');
    freshRead.resolve(payload(page)); await settle();
    assert.equal(accountSummary(page, account).state, '未登录');
    assert.equal(accountSummary(page, account).identity, '未登录');
    assert.equal(accountSummary(page, account).plan, '未返回');
    assert.equal(page.calls.filter(call => call.method === 'POST' && call.path === route.logout).length, 1);
  } finally {
    oldRead.resolve(oldPayload); freshRead.resolve(payload(page));
    await pendingOldRead?.catch(() => {}); await settle();
  }
}

for (const [account, label] of [['b', 'account B'], ['codebuddy', 'CodeBuddy'], ['cursor', 'Cursor']]) {
  test(`${label} logout ignores an older authenticated read while the fresh unauthenticated read is pending`, async () => {
    await verifyLogoutRefreshIsolation(account);
  });
}

test('account B logout clears its identity before a fresh status response even without an older in-flight read', async () => {
  await verifyLogoutRefreshIsolation('b', { oldRequest: false });
});
