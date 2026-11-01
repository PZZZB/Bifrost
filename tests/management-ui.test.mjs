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
  let integration = overrides.integration ?? {}, verification = overrides.verification ?? {};
  let quotas = overrides.quotas ?? { accounts: { A: { status: 'ok', windows: [] }, B: { status: 'ok', windows: [] } } };
  let diagnostics = overrides.diagnostics ?? { recent: [] };
  const control = { supported: true, platform: 'win32', pending: false, activeRequests: 0, ready: true, independentOfCodex: true,
    ...overrides.control };
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
    backend, integration, verification, ...(overrides.node ? { node: overrides.node } : {}) });
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
    if (path === '/api/request-diagnostics?limit=10') return json(diagnostics);
    if (path === '/api/account-quotas') return json(quotas);
    if (path === '/api/client-admin') return json({ accounts: [], invites: [], models: [], registration: { mode: 'invite', defaultKeyDays: 30 }, server: {} });
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  const api = { calls, elements, intervals, tabs, control, document, location, historyCalls,
    set token(value) { token = value; }, get token() { return token; },
    set models(value) { models = value; }, get models() { return models; },
    set cursor(value) { cursor = value; }, get cursor() { return cursor; },
    set backend(value) { backend = value; }, get backend() { return backend; },
    set integration(value) { integration = value; }, get integration() { return integration; },
    set verification(value) { verification = value; }, get verification() { return verification; },
    set codebuddy(value) { codebuddy = value; }, get codebuddy() { return codebuddy; },
    set quotas(value) { quotas = value; }, get quotas() { return quotas; },
    set diagnostics(value) { diagnostics = value; }, get diagnostics() { return diagnostics; },
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

function integrationFixture(mode = 'gateway', overrides = {}) {
  return { installed: true, providerId: mode === 'official' ? 'openai' : 'custom',
    routing: { supported: true, mode, providerId: mode === 'official' ? 'openai' : 'custom', gatewayProviderId: 'custom',
      canSwitchOfficial: true, canSwitchGateway: true }, ...overrides };
}

const boundBackend = () => ({ running: true, account: { email: 'bound@example.test' }, pinnedAccount: { email: 'bound@example.test' } });

test('a managed node hides client configuration and never polls unrelated account adapters', async () => {
  const page = harness({ node: { capabilities: { clientIntegration: false, userManagement: true, activeKinds: ['claude'] } },
    location: 'http://127.0.0.1:43155/#connections' });
  await settle();
  assert.equal(page.elements.get('tab-connections').hidden, true);
  assert.equal(page.elements.get('tab-clients').hidden, false);
  assert.equal(page.elements.get('tab-console').getAttribute('aria-selected'), 'true');
  const foreign = ['/api/codebuddy', '/api/cursor', '/api/with', '/api/account-quotas', '/api/token-usage'];
  assert.equal(page.calls.some(call => foreign.includes(call.path)), false);
  page.run("selectManagementTab('connections')");
  assert.equal(page.elements.get('panel-connections').hidden, true);
  assert.equal(page.elements.get('connection-label').textContent, '当前网关已连接');
});

test('an ordinary local node hides downstream user management and polls only configured account types', async () => {
  const page = harness({ node: { capabilities: { clientIntegration: true, userManagement: false, activeKinds: ['codebuddy'] } },
    location: 'http://127.0.0.1:43155/#clients' });
  await settle();
  assert.equal(page.elements.get('tab-clients').hidden, true);
  assert.equal(page.elements.get('tab-connections').hidden, false);
  assert.equal(page.elements.get('panel-clients').hidden, true);
  assert.equal(page.calls.some(call => ['/api/client-admin', '/api/cursor', '/api/with'].includes(call.path)), false);
  assert.equal(page.calls.some(call => call.path === '/api/codebuddy'), true);
});

test('saving visible model choices preserves disabled models owned by inactive accounts', async () => {
  const page = harness({ models: { ...originalModels(), disabledModels: ['old-unloaded-model'] } }); await settle();
  const checkbox = page.elements.get('model-settings-list').querySelectorAll('input')[0];
  checkbox.checked = false; checkbox.trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const saved = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(saved.body.disabledModels, ['old-unloaded-model', 'gpt-6.1-sol']);
});

test('Codex official configuration stays distinct from retained gateway fields and never advertises gateway ingress', async () => {
  const page = harness({ integration: integrationFixture('official'), backend: boundBackend(), verification: { status: 'passed' } });
  await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, '官方直连');
  assert.equal(page.elements.get('integration-state').textContent, '路由配置已保存');
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.equal(page.elements.get('integration-gateway-button').disabled, false);
  assert.match(page.elements.get('integration-description').textContent, /实际连接模式见上方/);
  const topology = topologyFor(page, worldFixture({ integration: page.integration }));
  assert.equal(topology.routes.filter(route => route.from === 'codex').every(route => route.state === 'pending' && route.label === '官方直连'), true);
  assert.equal(topology.local.find(route => route.from === 'codex').state, 'pending');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('Codex mode buttons submit explicit directions with CSRF and refresh the saved configuration without restarting services', async () => {
  const page = harness({ integration: integrationFixture(), backend: boundBackend(), verification: { status: 'passed' },
    fetch(call, api) {
      if (call.path === '/api/integration/mode') {
        assert.equal(call.method, 'POST'); assert.equal(call.headers['X-Bridge-CSRF'], api.token);
        api.integration = integrationFixture(call.body.mode);
        return json(api.integration);
      }
    } });
  await settle();
  page.elements.get('integration-official-button').trigger('click'); await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, '官方直连');
  assert.equal(page.elements.get('integration-gateway-button').disabled, false);
  assert.match(page.elements.get('notice').textContent, /完全退出并重新打开 Codex.*选择该模式可用的模型/);
  page.elements.get('integration-gateway-button').trigger('click'); await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, 'Bifröst 网关');
  assert.equal(page.elements.get('integration-official-button').disabled, false);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]), [
    ['/api/integration/mode', { mode: 'official' }], ['/api/integration/mode', { mode: 'gateway' }],
  ]);
});

test('Codex gateway selection requires saved route capability and confirmed verified B while official selection remains available', async () => {
  for (const change of [
    { backend: { running: true, account: { email: 'new@example.test' }, pinnedAccount: { email: 'old@example.test' } } },
    { verification: { status: 'not_run' } },
    { integration: integrationFixture('official', { routing: { supported: true, mode: 'official', canSwitchOfficial: true, canSwitchGateway: false, reason: '请先完成网关接入。' } }) },
  ]) {
    const page = harness({ integration: integrationFixture('official'), backend: boundBackend(), verification: { status: 'passed' }, ...change });
    await settle();
    assert.equal(page.elements.get('integration-gateway-button').disabled, true);
    page.elements.get('integration-gateway-button').trigger('click'); await settle();
    assert.equal(page.calls.some(call => call.method === 'POST'), false);
    assert.equal(page.elements.get('integration-mode-error').hidden, false);
  }
  const page = harness({ integration: integrationFixture(), backend: { running: true } }); await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, false);
});

test('old mode backends preserve official status and disable mode mutation with an upgrade explanation', async () => {
  const page = harness({ integration: { installed: true, providerId: 'openai' }, backend: boundBackend(), verification: { status: 'passed' } });
  await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, '官方直连');
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.match(page.elements.get('integration-mode-error').textContent, /重启网关服务后可用/);
  assert.equal(page.elements.get('service-restart-button').disabled, false);
  page.elements.get('integration-gateway-button').trigger('click'); await settle();
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  const topology = topologyFor(page, worldFixture({ integration: page.integration }));
  assert.equal(topology.routes.filter(route => route.from === 'codex').every(route => route.state === 'pending'), true);
});

test('official switching remains usable during B verification while gateway switching waits for verification', async () => {
  const page = harness({ integration: integrationFixture(), backend: boundBackend(), verification: { status: 'running' },
    fetch(call, api) {
      if (call.path === '/api/integration/mode') {
        api.integration = integrationFixture(call.body.mode);
        return json(api.integration);
      }
    } }); await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, false);
  page.elements.get('integration-official-button').trigger('click'); await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, '官方直连');
  assert.equal(page.verification.status, 'running');
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  page.elements.get('integration-gateway-button').trigger('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]), [
    ['/api/integration/mode', { mode: 'official' }],
  ]);
});

test('an explicit other mode overrides an openai provider name in both controls and topology', async () => {
  const integration = integrationFixture('other', { providerId: 'openai', routing: { supported: true,
    mode: 'other', providerId: 'openai', gatewayProviderId: 'custom', canSwitchOfficial: false, canSwitchGateway: false,
    reason: '官方提供方包含自定义地址，请先检查其地址配置。' } });
  const page = harness({ integration, backend: boundBackend(), verification: { status: 'passed' } }); await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, '其他提供方（openai）');
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  const topology = topologyFor(page, worldFixture({ integration }));
  const outgoing = topology.routes.filter(route => route.from === 'codex');
  assert.equal(outgoing.every(route => route.state === 'pending' && route.label === '待接入'), true);
  assert.equal(topology.local.find(route => route.from === 'codex').label, '待确认');
  assert.doesNotMatch(JSON.stringify([...outgoing, topology.local.find(route => route.from === 'codex')]), /官方直连/);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('pending mode writes suppress duplicate clicks and rejected writes recover controls without changing modes', async () => {
  const waiting = deferred();
  const page = harness({ integration: integrationFixture(), fetch(call) {
    if (call.path === '/api/integration/mode') return waiting.promise;
  } }); await settle();
  page.elements.get('integration-official-button').trigger('click');
  page.elements.get('integration-official-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/integration/mode').length, 1);
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.equal(page.elements.get('integration-mode-value').textContent, 'Bifröst 网关');
  waiting.resolve(json({ error: { message: '配置版本已变化，请刷新后重试。' } }, 409)); await settle();
  assert.match(page.elements.get('notice').textContent, /配置版本已变化/);
  assert.equal(page.elements.get('integration-mode-value').textContent, 'Bifröst 网关');
  assert.equal(page.elements.get('integration-official-button').disabled, false);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
});

test('a missing mode endpoint stays disabled for the old process and becomes available after service replacement', async () => {
  const page = harness({ integration: integrationFixture(), fetch(call) {
    if (call.path === '/api/integration/mode') return json({ error: { message: 'missing' } }, 404);
  } }); await settle();
  page.elements.get('integration-official-button').trigger('click'); await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.match(page.elements.get('notice').textContent, /后台尚未提供连接模式切换/);
  await page.run('refreshStatus()'); await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  page.token = 'updated-mode-service'; await page.run('refreshStatus()'); await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, false);
});

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
  for (const name of ['console', 'accounts', 'connections', 'clients']) {
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
  for (const [from, key, to] of [['console', 'ArrowLeft', 'clients'], ['clients', 'ArrowRight', 'console'],
    ['console', 'ArrowRight', 'accounts'], ['accounts', 'ArrowLeft', 'console'],
    ['accounts', 'ArrowRight', 'connections'], ['connections', 'ArrowRight', 'clients'], ['clients', 'ArrowLeft', 'connections'],
    ['console', 'End', 'clients'], ['accounts', 'Home', 'console']]) {
    const event = page.elements.get(`tab-${from}`).trigger('keydown', { key });
    assert.equal(event.defaultPrevented, true); assertSelectedTab(page, to);
    assert.equal(page.document.activeElement, page.elements.get(`tab-${to}`));
    assert.equal(page.location.hash, `#${to}`);
  }
  const ignored = page.elements.get('tab-console').trigger('keydown', { key: 'Escape' });
  assert.equal(ignored.defaultPrevented, false); assertSelectedTab(page, 'console');
  await settle(); assert.equal(page.calls.length, beforeCalls + 1);
  assert.equal(page.calls.at(-1).path, '/api/client-admin', 'New user management loads only when first selected.');
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
  page.elements.get('tab-console').trigger('keydown', { key: 'End' }); assertSelectedTab(page, 'clients');
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

const modernControl = () => ({ capabilities: { whenIdle: true, cancelQueued: true }, restart: null,
  version: { state: 'outdated', updatePending: true,
    running: { revision: '1111111111111111111111111111111111111111', startedAt: '2026-10-23T00:00:00.000Z' },
    installed: { revision: '2222222222222222222222222222222222222222', dirty: true } } });
const modernPage = (fetch, options = {}) => harness({ models: completeModels(), control: modernControl(), fetch, ...options });
const evidenceFor = (page, id) => page.elements.get('model-settings-list').querySelectorAll('details')
  .filter(element => element.className === 'model-evidence')[modelInputs(page).findIndex(input => input.value === id)];
function detailFields(element) {
  const fields = element.tagName === 'DL' ? element : element.querySelectorAll('dl')[0];
  return Object.fromEntries(fields.children.map(row => [row.children[0].textContent, row.children[1].textContent]));
}
const diagnosticRecord = (requestId = 'request_fixture', extra = {}) => ({ requestId, time: '2026-10-23T00:00:00.000Z',
  account: 'CodeBuddy', model: 'CodeBuddy-fixture', upstreamModel: 'fixture', status: 'completed', httpStatus: 200,
  durationMs: 1234.5, firstResponseMs: 50, usage: { inputTokens: 10, outputTokens: 20 }, ...extra });

test('service version panel distinguishes installed changes from the running process without restarting automatically', async () => {
  const page = modernPage(); await settle();
  assert.match(page.elements.get('service-running-version').textContent, /111111111111/);
  assert.match(page.elements.get('service-installed-version').textContent, /222222222222.*未提交/);
  assert.doesNotMatch(page.elements.get('service-started-at').textContent, /未返回/);
  assert.equal(page.elements.get('service-update-state').textContent, '有更新，重启网关后生效');
  assert.equal(page.elements.get('service-state').textContent, '有待生效更新');
  assert.equal(page.elements.get('service-idle-restart-button').disabled, false);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  page.control.version = { ...modernControl().version, updatePending: false, state: 'current' };
  await page.run('refreshServiceStatus()');
  assert.equal(page.elements.get('service-update-state').textContent, '后台代码已生效');
});

test('old backends leave version, idle restart and diagnostics unavailable while preserving model editing and native statistics', async () => {
  const page = harness({ fetch(call) {
    if (call.path === '/api/request-diagnostics?limit=10') return json({ error: { message: 'not installed' } }, 404);
  } }); await settle();
  assert.match(page.elements.get('service-running-version').textContent, /未返回/);
  assert.match(page.elements.get('service-update-state').textContent, /未取得/);
  assert.equal(page.elements.get('service-idle-restart-button').disabled, true);
  assert.equal(page.elements.get('service-idle-cancel-button').hidden, true);
  assert.equal(page.elements.get('diagnostics-state').textContent, '待更新后台');
  assert.match(page.elements.get('diagnostics-error').textContent, /历史请求不会补造/);
  const input = modelInputs(page)[0]; input.checked = false; input.trigger('change');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.equal(page.elements.get('metric-a-requests').textContent, '7');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('failed service reads disable cached idle controls until a fresh service status succeeds', async () => {
  for (const errorStatus of [404, 503]) for (const queued of [false, true]) {
    let failed = false;
    const page = modernPage(call => {
      if (failed && call.path === '/api/service/status') return json({ error: { message: 'Fixture service unreadable' } }, errorStatus);
    }, { control: { ...modernControl(), pending: queued,
      restart: queued ? { mode: 'when-idle', state: 'queued' } : null } });
    await settle();
    assert.equal(page.elements.get(queued ? 'service-idle-cancel-button' : 'service-idle-restart-button').disabled, false);
    failed = true; await page.run('refreshServiceStatus()'); await settle();
    assert.equal(page.elements.get('service-idle-restart-button').disabled, true);
    assert.equal(page.elements.get('service-idle-cancel-button').disabled, true);
    await page.run('queueServiceRestart()'); await page.run('cancelQueuedRestart()');
    assert.equal(page.calls.some(call => call.method === 'POST'), false, 'Cached capabilities cannot authorize controls after a failed status read.');
    failed = false; await page.run('refreshServiceStatus()'); await settle();
    assert.equal(page.elements.get(queued ? 'service-idle-cancel-button' : 'service-idle-restart-button').disabled, false);
  }
});

test('marker cleanup failures expose a retry cancellation for both immediate and idle restarts', async () => {
  for (const mode of ['immediate', 'when-idle']) {
    const page = modernPage((call, api) => {
      if (call.path === '/api/service/restart/cancel' && call.method === 'POST') {
        api.control.pending = false; api.control.draining = false; api.control.restart = null; api.control.error = null;
        return json({ cancelled: true });
      }
    }, { control: { ...modernControl(), pending: true, draining: true,
      restart: { mode, state: 'cleanup_failed' }, error: 'Fixture marker cleanup failed' } });
    await settle();
    assert.equal(page.elements.get('service-state').textContent, '清理失败');
    const cancel = page.elements.get('service-idle-cancel-button');
    assert.equal(cancel.hidden, false); assert.equal(cancel.disabled, false); assert.equal(cancel.textContent, '重试取消');
    assert.match(page.elements.get('service-queue-message').textContent, /清理失败.*重试取消/);
    assert.equal(page.elements.get('service-restart-button').disabled, true);
    assert.equal(page.elements.get('service-idle-restart-button').disabled, true);
    cancel.trigger('click'); await settle();
    assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/service/restart/cancel']);
    assert.equal(cancel.hidden, true); assert.equal(page.elements.get('service-idle-restart-button').disabled, false);
  }
});

test('idle restart queues exactly one noninterrupting request and leaves current model drafts editable', async () => {
  const page = modernPage((call, api) => {
    if (call.path === '/api/service/restart' && call.method === 'POST') {
      api.control.pending = true; api.control.restart = { mode: 'when-idle', state: 'queued' };
      return json({ accepted: true }, 202);
    }
  }); page.control.activeRequests = 4; await settle();
  page.elements.get('service-idle-restart-button').trigger('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]),
    [['/api/service/restart', { mode: 'when-idle' }]]);
  assert.equal(page.elements.get('service-state').textContent, '等待空闲重启');
  assert.match(page.elements.get('service-queue-message').textContent, /当前进行中 4 项/);
  assert.equal(page.elements.get('service-idle-cancel-button').hidden, false);
  assert.equal(page.run('restartInProgress'), false);
  const input = inputFor(page, 'cb-other'); assert.equal(input.disabled, false); input.checked = true; input.trigger('change');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('service-idle-restart-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('cancelling an idle queue sends only its cancellation and restores the restart controls', async () => {
  const page = modernPage((call, api) => {
    if (call.path === '/api/service/restart/cancel' && call.method === 'POST') {
      api.control.pending = false; api.control.restart = null; return json({ ok: true });
    }
  }, { control: { ...modernControl(), pending: true, restart: { mode: 'when-idle', state: 'queued' } } });
  await settle(); assert.equal(page.elements.get('service-idle-cancel-button').hidden, false);
  page.elements.get('service-idle-cancel-button').trigger('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/service/restart/cancel']);
  assert.equal(page.elements.get('service-idle-cancel-button').hidden, true);
  assert.equal(page.elements.get('service-idle-restart-button').disabled, false);
  assert.match(page.elements.get('service-message').textContent, /已取消排队重启/);
  assert.equal(page.run('queuedRestartToken'), null);
});

test('queued restart is completed only after a new CSRF token arrives and later saves use that token', async () => {
  const page = modernPage((call, api) => {
    if (call.path === '/api/service/restart' && call.method === 'POST') {
      api.control.pending = true; api.control.restart = { mode: 'when-idle', state: 'queued' };
      return json({ accepted: true }, 202);
    }
  }); await settle(); await page.run('queueServiceRestart()'); await settle();
  await page.run('refreshStatus()'); await settle();
  assert.doesNotMatch(page.elements.get('service-message').textContent, /已完成重启/);
  page.token = 'queued-restart-fresh-csrf'; page.control.pending = false; page.control.restart = null;
  page.control.version = { ...modernControl().version, updatePending: false, state: 'current' };
  await page.run('refreshStatus()'); await settle();
  assert.match(page.elements.get('service-message').textContent, /已完成重启/);
  assert.equal(page.run('queuedRestartToken'), null);
  await page.run("post('/api/model-settings', { revision: 7, disabledModels: [] })");
  assert.equal(page.calls.findLast(call => call.method === 'POST').headers['X-Bridge-CSRF'], 'queued-restart-fresh-csrf');
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('a new service token discards old catalog reads and their cleanup while preserving model drafts', async () => {
  for (const oldFails of [false, true]) {
    const oldRead = deferred(), freshRead = deferred();
    let phase = 'initial';
    const page = modernPage(call => {
      if (call.path === '/api/model-settings' && call.method === 'GET') {
        if (phase === 'old') return oldRead.promise;
        if (phase === 'fresh') return freshRead.promise;
      }
    });
    await settle();
    const draft = inputFor(page, 'cb-other'); draft.checked = true; draft.trigger('change');
    phase = 'old'; const oldPending = page.run('refreshModelSettings()'); await settle();
    const before = page.calls.filter(call => call.path === '/api/model-settings').length;
    phase = 'fresh'; page.token = 'replacement-service-csrf';
    await page.run('refreshStatus()'); await settle();
    assert.equal(page.calls.filter(call => call.path === '/api/model-settings').length, before + 1, 'The new service must start its own catalog read without waiting for the old one.');
    oldRead.resolve(oldFails ? json({ error: { message: 'Fixture stale catalog error' } }, 503) : json({ revision: 1, models: [] }));
    await oldPending; await settle();
    assert.equal(page.run('modelSettingsLoaded'), false);
    assert.equal(page.run('modelSettingsRequest !== null'), true, 'An old finally block must not clear the current catalog request.');
    assert.equal(page.elements.get('model-settings-error').hidden, true);
    assert.equal(inputFor(page, 'cb-other').checked, true);
    const currentPending = page.run('refreshModelSettings()');
    assert.equal(page.calls.filter(call => call.path === '/api/model-settings').length, before + 1);
    const fresh = completeModels(); fresh.revision = 8;
    fresh.models.push({ id: 'CodeBuddy-after-restart', name: 'New model', channel: 'CodeBuddy', enabled: false, available: true });
    freshRead.resolve(json(fresh)); await currentPending; await settle();
    assert.equal(inputFor(page, 'CodeBuddy-after-restart').checked, false);
    assert.equal(inputFor(page, 'cb-other').checked, true);
    assert.equal(page.run('modelSettings.revision'), 7, 'Unsaved choices retain their original revision for conflict protection.');
    assert.equal(page.run('modelSettingsLoaded'), true);
    assert.equal(page.run('modelSettingsRequest'), null);
    assert.equal(page.elements.get('model-settings-save-button').disabled, false);
    assert.equal(page.calls.some(call => call.method === 'POST'), false);
  }
});

test('a rejected idle restart remains an explicit failed action and never falls back to interrupting work', async () => {
  const page = modernPage(call => {
    if (call.path === '/api/service/restart' && call.method === 'POST') return json({ error: { message: 'Fixture queue unavailable' } }, 503);
  }); await settle(); await page.run('queueServiceRestart()'); await settle();
  assert.match(page.elements.get('notice').textContent, /Fixture queue unavailable/);
  assert.equal(page.run('queuedRestartToken'), null); assert.equal(page.run('restartInProgress'), false);
  assert.equal(page.elements.get('service-idle-restart-button').disabled, false);
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => call.body), [{ mode: 'when-idle' }]);
});

test('missing model capability and validation metadata never become support or a successful real test', async () => {
  const page = catalogPage(); await settle();
  const evidence = evidenceFor(page, 'cb-opus'), fields = detailFields(evidence);
  for (const key of ['图片', '客户端工具', '思考', '缓存', '上下文']) assert.equal(fields[key], '未确认');
  assert.equal(fields['调用验证'], '尚未验证'); assert.equal(fields['指令处理'], '尚未取得接入方式');
  assert.match(listText(evidence), /未知能力不会标成支持/);
  assert.equal(inputFor(page, 'cb-opus').checked, true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('model capability detail separates explicit support, precise effort levels and compatibility from a completed call', async () => {
  const models = completeModels(), target = models.models.find(model => model.id === 'cb-opus');
  target.capabilities = { images: { support: false, source: 'remote', note: '目录不支持图片' }, tools: { support: true, source: 'remote' },
    reasoning: { support: true, efforts: ['medium', 'xhigh'], source: 'remote' }, cache: { support: null, source: 'unknown' },
    contextWindow: { tokens: 300000, support: true, source: 'remote' } };
  target.compatibility = { mode: 'protocol-adapter', label: '协议适配', note: '只保证已适配的协议字段。' };
  target.verification = { state: 'passed', checkedAt: '2026-10-23T01:00:00.000Z', reason: '完成一次真实调用。' };
  const page = catalogPage(models); await settle();
  const evidence = evidenceFor(page, 'cb-opus'), fields = detailFields(evidence);
  assert.match(fields['图片'], /^不支持/); assert.equal(fields['客户端工具'], '支持');
  assert.match(fields['思考'], /medium、xhigh/); assert.equal(fields['缓存'], '未确认');
  assert.equal(fields['上下文'], '300,000 Token'); assert.equal(fields['指令处理'], '协议适配');
  assert.equal(fields['调用验证'], '已完成真实调用'); assert.ok(fields['验证时间']);
  assert.match(listText(evidence), /一次调用完成不代表图片、工具和缓存均已验证/);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('a failed network call preserves declared model capability and all evidence strings remain inert text', async () => {
  const models = completeModels(), target = models.models.find(model => model.id === 'cb-opus');
  target.capabilities = { tools: { support: true, note: '<img src=x onerror=fixture>' }, cache: { support: null }, contextWindow: { tokens: -1 } };
  target.compatibility = { label: '项目规则兼容模式', note: '<script>fixture</script>' };
  target.verification = { state: 'failed', reason: '网络错误，不代表模型不支持工具。' };
  const page = catalogPage(models); await settle();
  const evidence = evidenceFor(page, 'cb-opus'), fields = detailFields(evidence);
  assert.match(fields['客户端工具'], /^支持.*<img/); assert.equal(fields['上下文'], '未确认');
  assert.equal(fields['调用验证'], '最近调用失败'); assert.match(fields['验证说明'], /网络错误/);
  assert.equal(evidence.querySelectorAll('img').length + evidence.querySelectorAll('script').length, 0);
  assert.equal(fields['兼容说明'], '<script>fixture</script>');
});

test('request diagnostics poll read-only, limit visible records and export only the selected same-origin report', async () => {
  const records = Array.from({ length: 12 }, (_, index) => diagnosticRecord(`request_${index}`, { model: `<img data-fixture=${index}>` }));
  const page = modernPage(call => {
    if (call.path === '/api/request-diagnostics/request_0') return json({ request: { ...records[0], exportUrl: 'https://evil.invalid/private' } });
  }, { diagnostics: { recent: records } }); await settle();
  assert.equal(page.elements.get('diagnostics-recent-body').children.length, 10);
  const before = page.calls.filter(call => call.path === '/api/request-diagnostics?limit=10').length;
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.ok(page.calls.filter(call => call.path === '/api/request-diagnostics?limit=10').length > before);
  page.elements.get('diagnostics-recent-body').querySelectorAll('button')[0].trigger('click'); await settle();
  const fields = detailFields(page.elements.get('diagnostics-fields'));
  assert.equal(fields['请求 ID'], 'request_0'); assert.equal(fields['使用渠道'], 'CodeBuddy');
  assert.equal(fields['所选模型'], '<img data-fixture=0>'); assert.equal(fields['总耗时'], '1,234.5 ms');
  assert.equal(fields['首响应耗时'], '50 ms'); assert.equal(fields['缓存命中 Token'], '未返回');
  assert.equal(page.elements.get('diagnostics-fields').querySelectorAll('img').length, 0);
  const link = page.elements.get('diagnostics-export-link');
  assert.equal(link.hidden, false); assert.equal(link.href, '/api/request-diagnostics/request_0/export');
  assert.equal(new URL(link.href, page.location).origin, page.location.origin);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('invalid IDs, missing reports and mismatched records never produce a diagnostic export link', async () => {
  const page = modernPage(call => {
    if (call.path === '/api/request-diagnostics/valid') return json({ request: diagnosticRecord('valid') });
    if (call.path === '/api/request-diagnostics/missing') return json({ error: { message: 'not found' } }, 404);
    if (call.path === '/api/request-diagnostics/mismatch') return json({ request: diagnosticRecord('different') });
  }, { diagnostics: { recent: [diagnosticRecord('../private')] } }); await settle();
  assert.equal(page.elements.get('diagnostics-recent-body').querySelectorAll('button')[0].disabled, true);
  const count = page.calls.length;
  await page.run("loadRequestDiagnostic('../private')"); assert.equal(page.calls.length, count);
  await page.run("loadRequestDiagnostic('valid')");
  assert.equal(page.elements.get('diagnostics-export-link').href, '/api/request-diagnostics/valid/export');
  await page.run("loadRequestDiagnostic('missing')");
  assert.match(page.elements.get('diagnostics-detail-note').textContent, /超出保留范围/);
  assert.equal(page.elements.get('diagnostics-export-link').hidden, true);
  assert.equal(page.elements.get('diagnostics-export-link').href, undefined, 'A missing report must clear the prior selected export.');
  await page.run("loadRequestDiagnostic('mismatch')");
  assert.match(page.elements.get('diagnostics-detail-note').textContent, /不一致/);
  assert.equal(page.elements.get('diagnostics-export-link').hidden, true);
  assert.equal(page.elements.get('diagnostics-export-link').hasAttribute('href'), false);
});

test('late diagnostic successes and failures cannot replace the newer selected report', async () => {
  for (const staleResponse of [json({ request: diagnosticRecord('older') }), json({ error: { message: 'Fixture stale failure' } }, 503)]) {
    const waiting = deferred();
    const page = modernPage(call => {
      if (call.path === '/api/request-diagnostics/older') return waiting.promise;
      if (call.path === '/api/request-diagnostics/newer') return json({ request: diagnosticRecord('newer') });
    }); await settle();
    const old = page.run("loadRequestDiagnostic('older')"); await settle();
    await page.run("loadRequestDiagnostic('newer')"); waiting.resolve(staleResponse); await old; await settle();
    assert.equal(detailFields(page.elements.get('diagnostics-fields'))['请求 ID'], 'newer');
    assert.equal(page.elements.get('diagnostics-detail-title').textContent, '请求详情');
    assert.equal(page.elements.get('diagnostics-export-link').href, '/api/request-diagnostics/newer/export');
    assert.doesNotMatch(page.elements.get('diagnostics-detail-note').textContent, /Fixture stale failure/);
  }
});

function worldFixture(overrides = {}) {
  return { connected: true, gateway: { enabled: true }, integration: { installed: true },
    backend: { running: true, account: { email: 'bound@example.test' }, pinnedAccount: { email: 'bound@example.test' } },
    models: ['B', 'CodeBuddy', 'Cursor'].map(channel => ({ id: `fixture-${channel}`, channel, enabled: true, available: true })),
    codebuddy: { configured: true, enabled: true, running: true, provider: { authenticated: true, ready: true } },
    cursor: { configured: true, enabled: true, authReady: true, gateway: { running: true } },
    messages: { deployment: 'generic', running: false, channels: { Claude: { running: true }, CodeBuddy: { running: true } } },
    clients: { server: { enabled: true, ready: true } }, ...overrides };
}

function topologyFor(page, data) {
  return JSON.parse(page.run(`JSON.stringify(bridgeTopology(${JSON.stringify(data)}))`));
}

test('world tree directions describe callers and quota sources without inventing Cursor or WorkBuddy providers', async () => {
  const page = harness(); await settle();
  const topology = topologyFor(page, worldFixture());
  assert.deepEqual(topology.routes.map(route => `${route.from}:${route.to}`).sort(), [
    'claude:codebuddy', 'codebuddy:codex', 'codebuddy:cursor', 'codex:codebuddy', 'codex:cursor',
    'workbuddy:codebuddy', 'workbuddy:codex', 'workbuddy:cursor',
  ].sort());
  const adapted = topology.routes.filter(route => route.maturity === 'adapted');
  const awaitingClient = topology.routes.filter(route => route.maturity === 'client_pending');
  assert.deepEqual(adapted.map(route => `${route.from}:${route.to}`).sort(), ['codex:codebuddy', 'codex:cursor', 'claude:codebuddy'].sort());
  assert.equal(adapted.every(route => route.state === 'configured'), true);
  assert.equal(awaitingClient.length, 5);
  assert.equal(awaitingClient.every(route => route.state === 'pending' && route.label === '客户端待接入'), true);
  assert.equal(topology.routes.some(route => route.from === 'cursor' || route.to === 'workbuddy'), false);
  assert.match(topology.nodes.find(node => node.id === 'cursor').copy, /尚未适配 Cursor 客户端/);
  assert.equal(/orient="auto-start-reverse"/.test(html), true);
  assert.equal(/箭头从调用方指向额度来源/.test(html), true);
  const paths = [...html.matchAll(/<path\b[^>]*\bid="(world-route-[^"]+)"[^>]*>/g)];
  const illustrated = paths.filter(match => !/data-stage="client_pending"/.test(match[0])).map(match => match[1]);
  assert.deepEqual(illustrated.sort(), ['world-route-codex-codebuddy', 'world-route-codex-cursor', 'world-route-claude-codebuddy'].sort());
  for (const [, id] of paths) assert.equal(page.elements.get(id).getAttribute('marker-start'), 'none');
  for (const [attributes, id] of paths.filter(match => /data-stage="client_pending"/.test(match[0]))) {
    assert.equal(/marker-end="none"/.test(attributes), true, `${id} must not briefly display an unsupported arrow before script initialization.`);
    assert.equal(page.elements.get(id).getAttribute('marker-end'), 'none');
  }
  assert.equal(/<path\b[^>]*id="world-route-codex-codebuddy"[^>]*marker-start="none"/.test(html), true);
  const styles = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.equal(/\.world-routes path\[data-stage=client_pending\]\s*\{\s*display:\s*none/.test(styles), true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree never promotes an unconfigured desktop caller merely because its public API is ready', async () => {
  const page = harness(); await settle();
  for (const clients of [null, { server: { enabled: false, ready: false } }, { server: { enabled: true, ready: false } },
    { server: { enabled: true, ready: true } }]) {
    const topology = topologyFor(page, worldFixture({ clients }));
    const forward = topology.routes.find(route => route.from === 'codex' && route.to === 'codebuddy');
    const reverse = topology.routes.find(route => route.from === 'codebuddy' && route.to === 'codex');
    assert.equal(forward.state, 'configured'); assert.equal(reverse.state, 'pending');
    assert.equal(reverse.label, '客户端待接入');
    assert.equal(topology.routes.filter(route => route.maturity === 'client_pending').every(route => route.state === 'pending'), true);
    assert.equal(topology.routes.filter(route => route.state === 'configured').length, 3);
  }
});

test('world tree requires saved available models and current authorization for provider connections', async () => {
  const page = harness(); await settle();
  for (const change of [
    { modelError: 'catalog unavailable' },
    { models: worldFixture().models.map(model => ({ ...model, enabled: false })) },
    { models: worldFixture().models.map(model => ({ ...model, available: false })) },
    { codebuddy: { configured: true, enabled: true, provider: { authenticated: false, ready: true } },
      cursor: { configured: true, enabled: true, authReady: false } },
    { codebuddy: { configured: true, enabled: false, provider: { authenticated: true, ready: true } },
      cursor: { configured: true, enabled: false, authReady: true } },
  ]) {
    const topology = topologyFor(page, worldFixture(change));
    assert.equal(topology.routes.filter(route => route.from === 'codex').every(route => route.state === 'pending'), true);
  }
  page.run('modelDraft.set("fixture-CodeBuddy", true)');
  const topology = topologyFor(page, worldFixture({ models: worldFixture().models.map(model => ({ ...model, enabled: false })) }));
  assert.equal(topology.routes.find(route => route.from === 'codex' && route.to === 'codebuddy').state, 'pending', 'An unsaved model checkbox is not an enabled route.');
});

test('world tree uses generic Messages channel state instead of the legacy top-level running flag', async () => {
  const page = harness(); await settle();
  const configured = topologyFor(page, worldFixture());
  assert.equal(configured.routes.find(route => route.from === 'claude').state, 'configured');
  const subscription = configured.local.find(route => route.from === 'claude');
  assert.equal(subscription.state, 'configured'); assert.match(subscription.reason, /未验证 CLI 登录/);
  const stopped = topologyFor(page, worldFixture({ messages: { deployment: 'generic', running: true, channels: {} } }));
  assert.equal(stopped.routes.find(route => route.from === 'claude').state, 'pending');
  assert.equal(stopped.local.find(route => route.from === 'claude').state, 'pending');
});

test('world tree never treats a previous B binding as a confirmed new account', async () => {
  const page = harness(); await settle();
  const topology = topologyFor(page, worldFixture({ backend: { running: true,
    account: { email: 'new@example.test' }, pinnedAccount: { email: 'old@example.test' } } }));
  const routes = topology.routes.filter(route => route.to === 'codex');
  assert.equal(routes.every(route => route.state === 'pending' && route.label === '客户端待接入'), true);
  assert.equal(routes.every(route => /当前登录必须匹配已确认的绑定/.test(route.reason)), true);
  assert.equal(routes.some(route => /账号 B 已绑定/.test(route.reason)), false);
});

test('world tree remains explorable offline and clears configured states while preserving selection', async () => {
  let offline = false;
  const page = harness({ fetch(call) {
    if (offline && call.path === '/api/status') throw new Error('Fixture offline');
  } }); await settle();
  page.elements.get('world-node-codex').trigger('click');
  assert.equal(page.elements.get('world-node-codex').getAttribute('aria-pressed'), 'true');
  offline = true; await page.run('refreshStatus().catch(() => {})'); await settle();
  assert.equal(page.elements.get('world-canvas').getAttribute('data-selection'), 'codex');
  assert.equal(page.elements.get('world-ready-count').textContent, '0');
  assert.match(page.elements.get('world-connection-note').textContent, /连接未确认/);
  const count = page.calls.length;
  for (const id of ['codex', 'claude', 'codebuddy', 'workbuddy', 'cursor']) assert.equal(page.elements.get(`world-node-${id}`).disabled, false);
  page.elements.get('world-node-workbuddy').trigger('click');
  assert.equal(page.elements.get('world-canvas').getAttribute('data-selection'), 'workbuddy');
  assert.equal(page.calls.length, count, 'Offline exploration sends no user or inference requests.');
  page.elements.get('world-reset').trigger('click');
  assert.equal(page.elements.get('world-canvas').getAttribute('data-selection'), 'all');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree loads user entrance metadata only when needed and retains the selected node during polling', async () => {
  const page = harness({ fetch(call) {
    if (call.path === '/api/client-admin') return json({ accounts: [], invites: [], models: [],
      registration: { mode: 'open', defaultKeyDays: 30 }, server: { enabled: true, ready: true } });
  } }); await settle();
  assert.equal(page.calls.some(call => call.path === '/api/client-admin'), false);
  page.elements.get('world-node-workbuddy').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/client-admin').length, 1);
  assert.equal(page.elements.get('world-detail-title').textContent, 'WorkBuddy');
  assert.equal(page.elements.get('world-node-workbuddy').getAttribute('aria-pressed'), 'true');
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(page.elements.get('world-canvas').getAttribute('data-selection'), 'workbuddy');
  assert.equal(page.elements.get('world-detail-title').textContent, 'WorkBuddy');
  assert.equal(page.calls.filter(call => call.path === '/api/client-admin').length, 1);
  page.elements.get('world-node-codebuddy').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/client-admin').length, 1, 'Switching nodes reuses the existing read-only user metadata.');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree draws only adapted one-way callers and separates pending desktop directions in a foldout', async () => {
  const page = worldPage(); await settle();
  assert.equal(page.elements.get('world-route-count').textContent, '3');
  assert.equal(page.elements.get('world-ready-count').textContent, '3');
  assert.equal(page.elements.get('world-route-codex-codebuddy').getAttribute('data-state'), 'configured');
  assert.equal(page.elements.get('world-route-codex-cursor').getAttribute('data-state'), 'configured');
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'configured');
  assert.equal(page.elements.get('world-pending-details').tagName, 'DETAILS');
  assert.equal(page.elements.get('world-pending-list').children.length, 5);
  assert.equal(page.elements.get('world-pending-list').children.every(row => row.getAttribute('data-state') === 'pending'), true);
  page.elements.get('world-node-codex').trigger('click');
  assert.equal(page.elements.get('world-route-codex-codebuddy').getAttribute('data-highlight'), 'true');
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-highlight'), 'false');
  assert.match(listText(page.elements.get('world-route-list')), /Codex 客户端 → CodeBuddy 额度/);
  assert.doesNotMatch(listText(page.elements.get('world-route-list')), /CodeBuddy 客户端 → Codex 账号 B/);
  assert.match(listText(page.elements.get('world-pending-list')), /CodeBuddy 客户端 → Codex 账号 B/);
  assert.match(listText(page.elements.get('world-pending-list')), /客户端待接入/);
  assert.equal(page.elements.get('world-route-list').querySelectorAll('script').length, 0);
  assert.equal(page.elements.get('world-route-list').querySelectorAll('a').length, 0);
  assert.equal(page.elements.get('world-pending-list').querySelectorAll('script').length, 0);
  assert.equal(page.elements.get('world-pending-list').querySelectorAll('a').length, 0);
});

function worldPage(fetchOverride) {
  const fixture = worldFixture();
  return harness({ models: { revision: 1, models: fixture.models }, backend: fixture.backend,
    codebuddy: fixture.codebuddy, cursor: fixture.cursor, fetch(call, api) {
      const intercepted = fetchOverride?.(call, api);
      if (intercepted !== undefined) return intercepted;
      if (call.path === '/api/status') return json({ csrfToken: api.token, ready: true,
        gateway: fixture.gateway, backend: api.backend, integration: fixture.integration, verification: {} });
      if (call.path === '/api/with') return json(fixture.messages);
      if (call.path === '/api/client-admin') return json({ accounts: [], invites: [], models: [],
        registration: { mode: 'open', defaultKeyDays: 30 }, server: { enabled: true, ready: true } });
    } });
}

test('world tree invalidates prior user entrance readiness on service replacement and rereads selected client metadata', async () => {
  let replacement = false;
  const fresh = deferred();
  const page = worldPage(call => {
    if (replacement && call.path === '/api/client-admin') return fresh.promise;
  }); await settle();
  assert.equal(page.calls.some(call => call.path === '/api/client-admin'), false);
  page.elements.get('world-node-workbuddy').trigger('click'); await settle();
  assert.equal(page.elements.get('world-ready-count').textContent, '3');
  assert.equal(page.run('clientAdminData.server.ready'), true);
  replacement = true; page.token = 'world-new-service-csrf';
  await page.run('refreshStatus()'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/api/client-admin').length, 2);
  assert.equal(page.elements.get('world-canvas').getAttribute('data-selection'), 'workbuddy');
  assert.equal(page.run('clientAdminData'), null);
  assert.equal(page.elements.get('world-pending-list').children.length, 3);
  assert.equal(page.elements.get('world-pending-list').children.every(row => row.getAttribute('data-state') === 'pending'), true);
  fresh.resolve(json({ accounts: [], invites: [], models: [], registration: { mode: 'open', defaultKeyDays: 30 },
    server: { enabled: false, ready: false } })); await settle();
  assert.equal(page.run('clientAdminData.server.ready'), false);
  assert.equal(page.elements.get('world-pending-list').children.every(row => row.getAttribute('data-state') === 'pending'), true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree ignores old user metadata and its cleanup after a new service starts a separate read', async () => {
  const old = deferred(), fresh = deferred();
  let reads = 0;
  const page = worldPage(call => {
    if (call.path === '/api/client-admin') return ++reads === 1 ? old.promise : fresh.promise;
  }); await settle();
  page.elements.get('world-node-workbuddy').trigger('click'); await settle();
  page.token = 'world-next-service-csrf'; await page.run('refreshStatus()'); await settle();
  assert.equal(reads, 2);
  old.resolve(json({ accounts: [], invites: [], models: [], registration: { mode: 'open', defaultKeyDays: 30 },
    server: { enabled: true, ready: true } })); await settle();
  assert.equal(page.run('clientAdminRequest !== null'), true, 'An old cleanup cannot clear the replacement service read.');
  assert.equal(page.run('clientAdminData'), null);
  assert.equal(page.elements.get('world-pending-list').children.every(row => row.getAttribute('data-state') === 'pending'), true);
  fresh.resolve(json({ accounts: [], invites: [], models: [], registration: { mode: 'open', defaultKeyDays: 30 },
    server: { enabled: false, ready: false } })); await settle();
  assert.equal(page.run('clientAdminRequest'), null);
  assert.equal(page.run('clientAdminData.server.ready'), false);
  assert.equal(page.elements.get('world-pending-list').children.every(row => row.getAttribute('data-state') === 'pending'), true);
});

test('world tree key-management action opens the existing user page without creating a user or key', async () => {
  const page = worldPage(); await settle();
  page.elements.get('world-node-workbuddy').trigger('click'); await settle();
  page.elements.get('world-manage-clients').trigger('click'); await settle();
  assert.equal(page.elements.get('tab-clients').getAttribute('aria-selected'), 'true');
  assert.equal(page.elements.get('panel-clients').hidden, false);
  assert.equal(page.document.activeElement, page.elements.get('tab-clients'));
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree clears CodeBuddy and Cursor source states immediately when their authorization is invalidated', async () => {
  const page = worldPage(); await settle();
  assert.equal(page.elements.get('world-route-codex-codebuddy').getAttribute('data-state'), 'configured');
  assert.equal(page.elements.get('world-route-codex-cursor').getAttribute('data-state'), 'configured');
  page.run("invalidateAccountStatus('codebuddy')");
  assert.equal(page.elements.get('world-route-codex-codebuddy').getAttribute('data-state'), 'pending');
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'pending');
  assert.equal(page.elements.get('world-route-codex-cursor').getAttribute('data-state'), 'configured');
  assert.equal(page.elements.get('world-ready-count').textContent, '1');
  page.run("invalidateAccountStatus('cursor')");
  assert.equal(page.elements.get('world-route-codex-cursor').getAttribute('data-state'), 'pending');
  assert.equal(page.elements.get('world-ready-count').textContent, '0');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('world tree ignores a late Messages state from the replaced service until a fresh read confirms its channels', async () => {
  const old = deferred(); let phase = 'initial';
  const page = worldPage(call => {
    if (call.path === '/api/with' && phase === 'old') return old.promise;
    if (call.path === '/api/with' && phase === 'fresh') return json({ deployment: 'generic', channels: {} });
  }); await settle();
  page.elements.get('world-node-claude').trigger('click');
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'configured');
  phase = 'old'; const oldRead = page.run('refreshWith()'); await settle();
  phase = 'fresh'; page.token = 'world-messages-next-csrf'; await page.run('refreshStatus()'); await settle();
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'pending');
  old.resolve(json(worldFixture().messages)); await oldRead; await settle();
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'pending');
  assert.equal(page.run('messagesStatus'), null);
  await page.run('refreshWith()'); await settle();
  assert.equal(page.elements.get('world-route-claude-codebuddy').getAttribute('data-state'), 'pending');
  assert.equal(page.elements.get('world-detail-title').textContent, 'Claude');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});
