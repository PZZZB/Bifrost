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
    this.hidden = /\shidden(?:\s|$)/.test(attributes); this.disabled = /\sdisabled(?:\s|$)/.test(attributes);
    this.textContent = ''; this.className = ''; this.checked = false; this.style = {};
    this.options = []; this.value = '';
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  trigger(type) { return this.listeners.get(type)?.({ target: this }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; if (this.tagName === 'SELECT') this.options = nodes; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'href') delete this.href; }
  add(option) { this.options.push(option); }
  querySelectorAll(tag) {
    return this.children.flatMap(node => node instanceof Element ? [...(node.tagName.toLowerCase() === tag ? [node] : []), ...node.querySelectorAll(tag)] : []);
  }
}

function harness(overrides = {}) {
  const elements = new Map([...html.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)]
    .map(([, tag, attributes, id]) => [id, new Element(tag, attributes)]));
  const calls = [], intervals = [], tabs = [];
  let clock = 0, token = 'old-service-csrf', models = originalModels(), cursor = { configured: true, enabled: false,
    authReady: false, profile: null, plan: { declared: 'Teams', verified: false }, login: { state: 'not_started' }, catalog: { models: [] }, gateway: {} };
  const control = { supported: true, platform: 'win32', pending: false, activeRequests: 0, ready: true, independentOfCodex: true };
  const document = { hidden: false, body: new Element('body'),
    getElementById(id) { return elements.get(id) ?? null; }, createElement(tag) { return new Element(tag); },
    addEventListener() {}, querySelectorAll() { return [...elements.values()].filter(element => element.tagName === 'BUTTON'); } };
  const snapshot = () => ({ csrfToken: token, ready: true, gateway: { requests: 12, completed: 11, failed: 1,
    accounts: { A: { requests: 7, completed: 7, failed: 0 }, B: { requests: 5, completed: 4, failed: 1 } } },
    backend: { running: true, login: {} }, integration: {}, verification: {} });
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
    if (path === '/api/codebuddy') return json({ configured: false });
    if (path === '/api/token-usage') return json({ accounts: {}, totals: {}, recent: [] });
    if (path === '/api/account-quotas') return json({ accounts: { A: { status: 'ok', windows: [] }, B: { status: 'ok', windows: [] } } });
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  const api = { calls, elements, intervals, tabs, control,
    set token(value) { token = value; }, get token() { return token; },
    set models(value) { models = value; }, get models() { return models; },
    set cursor(value) { cursor = value; }, get cursor() { return cursor; },
    get elapsed() { return clock; } };
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, fetch, Response, Headers, AbortSignal, URL, navigator: {}, Date: Clock,
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    window: { open() { const tab = { opener: {}, location: { replace(value) { tab.url = value; } }, close() { tab.closed = true; } }; tabs.push(tab); return tab; } },
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
  await page.run('refreshCursor()');
  assert.equal(page.elements.get('cursor-account').textContent, 'fixture@example.test');
  assert.equal(page.elements.get('cursor-plan').textContent, 'Teams（待核实）');
  assert.equal(page.elements.get('cursor-gemini-state').textContent, '账号目录已确认');
});
