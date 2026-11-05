import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { capabilitiesFromCatalog } from '../src/model-capabilities.mjs';
import { describeCodeBuddyDeltaFields, describeCodeBuddyProtocolCheck } from '../src/codebuddy-source-diagnostics.mjs';

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
    const call = { path, method: options.method ?? 'GET', headers: options.headers, signal: options.signal,
      body: options.body ? JSON.parse(options.body) : null };
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
      if (call.method === 'POST') {
        const windows = { ...models.contextWindows };
        for (const [id, tokens] of Object.entries(call.body.contextWindows ?? {})) {
          if (tokens === null) delete windows[id]; else windows[id] = tokens;
        }
        models = { ...models, revision: models.revision + 1, disabledModels: [...call.body.disabledModels],
          ...(Object.hasOwn(call.body, 'contextWindows') ? { contextWindows: windows } : {}),
          models: models.models.map(model => ({ ...model, enabled: !call.body.disabledModels.includes(model.id),
            ...(model.contextSettings ? { contextSettings: { ...model.contextSettings,
              selectedTokens: windows[model.id] ?? null, effectiveTokens: windows[model.id] ?? model.contextSettings.defaultTokens } } : {}) })) };
      }
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
    advance(milliseconds) { clock += milliseconds; },
    get elapsed() { return clock; } };
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, fetch, Response, Headers, AbortSignal: overrides.AbortSignal ?? AbortSignal, URL, navigator: {}, Date: Clock,
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
      canSwitchOfficial: true, canSwitchGateway: true, nativeThreadsSupported: true, nativeThreadsCovered: mode === 'gateway' }, ...overrides };
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
  assert.match(page.elements.get('notice').textContent, /完全退出并重开 Codex.*普通 GPT 模型/);
  page.elements.get('integration-gateway-button').trigger('click'); await settle();
  assert.equal(page.elements.get('integration-mode-value').textContent, 'Bifröst 网关');
  assert.equal(page.elements.get('integration-official-button').disabled, false);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.match(page.elements.get('notice').textContent, /已保存网关配置并覆盖原生旧会话.*完全退出并重开 Codex/);
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]), [
    ['/api/integration/mode', { mode: 'official' }], ['/api/integration/mode', { mode: 'gateway' }],
  ]);
});

test('an existing gateway selection can explicitly upgrade old native threads without migrating conversation history', async () => {
  const old = integrationFixture(); old.needsUpgrade = true; old.routing.nativeThreadsCovered = false;
  const page = harness({ integration: old, backend: boundBackend(), verification: { status: 'passed' },
    fetch(call, api) { if (call.path === '/api/integration/mode') {
      assert.deepEqual(call.body, { mode: 'gateway' }); api.integration = integrationFixture(); return json(api.integration);
    } } });
  await settle();
  assert.equal(page.elements.get('integration-gateway-button').disabled, false);
  assert.equal(page.elements.get('integration-gateway-button').textContent, '更新网关连接');
  assert.match(page.elements.get('integration-mode-error').textContent, /原生旧会话/);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
  page.elements.get('integration-gateway-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.match(page.elements.get('notice').textContent, /完全退出并重开 Codex/);
  assert.equal(page.calls.some(call => /thread|service\/restart/.test(call.path)), false);
});

test('an old gateway backend does not claim that existing native threads have been connected', async () => {
  const old = integrationFixture(); delete old.routing.nativeThreadsSupported; delete old.routing.nativeThreadsCovered;
  const page = harness({ integration: old, backend: boundBackend(), verification: { status: 'passed' } }); await settle();
  assert.equal(page.elements.get('integration-gateway-button').disabled, true);
  assert.match(page.elements.get('integration-mode-error').textContent, /空闲重启网关加载新版/);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('an existing official selection can explicitly restore legacy custom threads without enabling the gateway', async () => {
  const old = integrationFixture('official'); old.needsUpgrade = true; old.routing.nativeThreadsCovered = false;
  const page = harness({ integration: old, backend: { running: true }, verification: { status: 'not_run' },
    fetch(call, api) { if (call.path === '/api/integration/mode') {
      assert.deepEqual(call.body, { mode: 'official' }); api.integration = integrationFixture('official'); return json(api.integration);
    } } });
  await settle();
  assert.equal(page.elements.get('integration-official-button').disabled, false);
  assert.equal(page.elements.get('integration-official-button').textContent, '更新原生连接');
  assert.match(page.elements.get('integration-mode-error').textContent, /更新原生连接/);
  page.elements.get('integration-official-button').trigger('click'); await settle();
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(page.elements.get('integration-official-button').disabled, true);
  assert.equal(page.elements.get('integration-mode-value').textContent, '官方直连');
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

const budgetSignals = { timeout: milliseconds => ({ budgetMs: milliseconds }) };
const statusTimeout = () => Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });

test('a slow live supervisor check remains visible and usable beyond the old five-second budget', async () => {
  const page = harness({ AbortSignal: budgetSignals, fetch(call, api) {
    if (call.path !== '/api/service/status') return;
    if (call.signal.budgetMs < 7800) throw statusTimeout();
    api.advance(7800);
  } });
  await settle();
  assert.equal(page.elements.get('service-ready').textContent, '已就绪');
  assert.match(page.elements.get('service-independent').textContent, /独立运行/);
  assert.equal(page.elements.get('service-error').hidden, true);
  assert.equal(page.elements.get('service-restart-button').disabled, false);
});

test('a restarted process with a slow supervisor check reconnects without submitting another restart', async () => {
  let accepted = false, slowChecks = 0;
  const page = harness({ AbortSignal: budgetSignals, fetch(call, api) {
    if (call.path === '/api/service/restart') {
      accepted = true; api.token = 'new-slow-service-csrf';
      return json({ accepted: true, reconnectAfterMs: 750 }, 202);
    }
    if (accepted && call.path === '/api/service/status') {
      if (call.signal.budgetMs < 7800) throw statusTimeout();
      api.advance(7800); slowChecks++;
    }
  } });
  await settle(); await page.run('restartService(false)'); await settle();
  assert.ok(slowChecks >= 1);
  assert.ok(page.elapsed < 60000);
  assert.match(page.elements.get('service-message').textContent, /已重启并恢复连接/);
  assert.equal(page.elements.get('service-error').hidden, true);
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('slow recovery checks keep the remaining deadline and cannot report success after sixty seconds', async () => {
  let accepted = false, advanced = false, remainingBudget;
  const page = harness({ AbortSignal: budgetSignals, fetch(call, api) {
    if (call.path === '/api/service/restart') {
      accepted = true; api.token = 'new-late-service-csrf';
      return json({ accepted: true, reconnectAfterMs: 750 }, 202);
    }
    if (accepted && !advanced && call.path === '/api/status') { api.advance(59000); advanced = true; }
    if (accepted && remainingBudget === undefined && call.path === '/api/service/status') {
      remainingBudget = call.signal.budgetMs;
      api.advance(1000);
    }
  } });
  await settle(); await page.run('restartService(false)'); await settle();
  assert.ok(remainingBudget > 0 && remainingBudget <= 250);
  assert.doesNotMatch(page.elements.get('service-message').textContent, /已重启并恢复连接/);
  assert.match(page.elements.get('notice').textContent, /已重新连接.*60 秒内尚未就绪/);
  assert.equal(page.calls.filter(call => call.path === '/api/service/restart').length, 1);
});

test('a real status timeout has a readable error and a later successful read restores controls', async () => {
  let timedOut = true;
  const page = harness({ fetch(call) {
    if (timedOut && call.path === '/api/service/status') throw statusTimeout();
  } });
  await settle();
  assert.match(page.elements.get('service-error').textContent, /服务状态查询超时/);
  assert.doesNotMatch(page.elements.get('service-error').textContent, /signal timed out/);
  assert.equal(page.elements.get('service-restart-button').disabled, true);
  timedOut = false;
  await page.run('refreshServiceStatus()');
  assert.equal(page.elements.get('service-error').hidden, true);
  assert.equal(page.elements.get('service-restart-button').disabled, false);
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

test('repeated model revision conflicts retain checkbox edits and the latest baseline without overwriting another page', async () => {
  const page = harness({ fetch(call, api) {
    if (call.path === '/api/model-settings' && call.method === 'POST') {
      api.models = { revision: 2, models: originalModels().models.map(model => ({ ...model, enabled: model.channel === 'A' })) };
      return json({ error: { message: 'Revision conflict' } }, 409);
    }
  } }); await settle();
  const checkbox = page.elements.get('model-settings-list').querySelectorAll('input')[0];
  checkbox.checked = false; checkbox.trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.deepEqual(page.elements.get('model-settings-list').querySelectorAll('input').map(input => input.checked), [false, false]);
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.equal(page.run('modelSettings.revision'), 2);
  assert.match(page.elements.get('model-settings-message').textContent, /目录持续更新.*草稿已保留/);
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').length, 2);
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
const modelInputs = page => page.elements.get('model-settings-list').querySelectorAll('input').filter(input => input.type === 'checkbox');
const inputFor = (page, id) => modelInputs(page).find(input => input.value === id);
const listText = element => [element.textContent, ...element.children.map(child => child instanceof Element ? listText(child) : String(child))].join(' ');
const groupButton = (page, channel, title) => page.elements.get('model-settings-list').querySelectorAll('button')
  .find(button => button.attributes.get('aria-label') === `${channel}：${title}（当前搜索结果）`);
const modelGroups = page => page.elements.get('model-settings-list').querySelectorAll('details[data-model-channel]');
const modelGroupFor = (page, channel) => modelGroups(page).find(group => group.getAttribute('data-model-channel') === channel);
const setModelGroupOpen = (group, open) => { group.open = open; group.trigger('toggle'); };

const contextSettingsFixture = (overrides = {}) => ({ defaultTokens: 300000, maxTokens: 1000000,
  options: [300000, 600000, 1000000], selectedTokens: null, effectiveTokens: 300000,
  customAllowed: true, valid: true, note: '', minimumTokens: 1000, maximumTokens: 10000000, ...overrides });
function contextModelCatalog(settings = contextSettingsFixture()) {
  const data = completeModels();
  data.contextWindows = settings.selectedTokens === null ? {} : { 'cb-opus': settings.selectedTokens };
  data.models.find(model => model.id === 'cb-opus').contextSettings = settings;
  return data;
}
const contextRowFor = (page, id = 'cb-opus') => page.elements.get('model-settings-list').querySelectorAll('[data-model-context]')
  .find(row => row.getAttribute('data-model-context') === id);
const contextChoiceFor = (page, id) => contextRowFor(page, id)?.querySelectorAll('select')[0];
const customContextFor = (page, id) => contextRowFor(page, id)?.querySelectorAll('input')[0];

test('metadata-only revision conflict retries once and merges the user delta without dropping newly disabled or hidden settings', async () => {
  let posts = 0;
  const original = contextModelCatalog();
  original.disabledModels = ['inactive-hidden-model', ...original.models.filter(model => !model.enabled).map(model => model.id)];
  original.contextWindows['remote/inactive/model'] = 750000;
  const page = catalogPage(original, (call, api) => {
    if (call.path !== '/api/model-settings' || call.method !== 'POST' || ++posts !== 1) return;
    api.models = { ...api.models, revision: 8,
      contextWindows: { ...api.models.contextWindows, 'remote/inactive/model': 800000 },
      disabledModels: [...api.models.disabledModels.filter(id => id !== 'cursor-first'), 'new-default-disabled'],
      models: [...api.models.models.map(model => model.id === 'cursor-first' ? { ...model, enabled: true } : model),
        { id: 'new-default-disabled', name: 'New native model', channel: 'A', enabled: false, available: true }] };
    return json({ error: { message: 'Metadata changed' } }, 409);
  });
  await settle();
  contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  const checkbox = inputFor(page, 'original-a'); checkbox.checked = false; checkbox.trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const attempts = page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.revision, 7); assert.equal(attempts[1].body.revision, 8);
  assert.deepEqual(attempts[1].body.contextWindows, { 'cb-opus': 600000 });
  for (const id of ['inactive-hidden-model', 'new-default-disabled', 'original-a']) assert.ok(attempts[1].body.disabledModels.includes(id));
  assert.equal(attempts[1].body.disabledModels.includes('cursor-first'), false);
  assert.equal(page.models.contextWindows['remote/inactive/model'], 800000);
  assert.equal(page.models.models.find(model => model.id === 'new-default-disabled').enabled, false);
  assert.equal(contextChoiceFor(page).value, '600000');
  assert.match(listText(contextRowFor(page)), /目录默认 300K.*已保存预算 600K/);
  assert.equal(detailFields(evidenceFor(page, 'cb-opus'))['客户端预算'], '600,000 Token（已保存）');
  assert.match(page.elements.get('model-settings-message').textContent, /已保存并确认/);
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
});

test('same-field context conflict preserves 600K and requires a second explicit save against the latest baseline', async () => {
  let posts = 0;
  const page = catalogPage(contextModelCatalog(), (call, api) => {
    if (call.path !== '/api/model-settings' || call.method !== 'POST' || ++posts !== 1) return;
    api.models = contextModelCatalog(contextSettingsFixture({ selectedTokens: 1000000, effectiveTokens: 1000000 }));
    api.models.revision = 8;
    return json({ error: { message: 'Another page changed this budget' } }, 409);
  });
  await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(posts, 1); assert.equal(contextChoiceFor(page).value, '600000');
  assert.equal(page.run('modelSettings.revision'), 8);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.selectedTokens'), 1000000);
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.match(page.elements.get('model-settings-message').textContent, /其他页面修改.*600K 的上下文草稿已保留/);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const latest = page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').at(-1);
  assert.equal(posts, 2); assert.equal(latest.body.revision, 8); assert.deepEqual(latest.body.contextWindows, { 'cb-opus': 600000 });
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  assert.equal(contextChoiceFor(page).value, '600000');
});

test('repeated conflicts are bounded to two posts per click and retain the 600K draft for an explicit retry', async () => {
  let posts = 0;
  const page = catalogPage(contextModelCatalog(), (call, api) => {
    if (call.path !== '/api/model-settings' || call.method !== 'POST') return;
    if (++posts > 2) return;
    api.models = { ...api.models, revision: api.models.revision + 1 };
    return json({ error: { message: 'Directory is changing' } }, 409);
  });
  await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(posts, 2); assert.equal(contextChoiceFor(page).value, '600000');
  assert.equal(page.run('modelSettings.revision'), 9); assert.equal(page.run('modelSettingsDirty()'), true);
  assert.match(page.elements.get('model-settings-message').textContent, /目录持续更新.*600K 的上下文草稿已保留/);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(posts, 3); assert.equal(contextChoiceFor(page).value, '600000');
  assert.equal(page.run('modelSettingsDirty()'), false);
});

test('confirmed 600K survives both immediate and later stale or inconsistent directory reads', async () => {
  for (const mismatch of ['older-revision', 'same-revision-stale-row', 'same-revision-consistent-wrong-value']) {
    let saved = false;
    const acknowledgement = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 }));
    acknowledgement.revision = 8;
    const page = catalogPage(contextModelCatalog(), call => {
      if (call.path !== '/api/model-settings') return;
      if (call.method === 'POST') { saved = true; return json(acknowledgement); }
      if (saved) {
        const stale = contextModelCatalog();
        if (mismatch !== 'older-revision') stale.revision = 8;
        if (mismatch === 'same-revision-stale-row') stale.contextWindows = { 'cb-opus': 600000 };
        return json(stale);
      }
    });
    await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
    page.elements.get('model-settings-save-button').trigger('click'); await settle();
    assert.equal(contextChoiceFor(page).value, '600000', mismatch);
    assert.equal(page.run('modelSettings.revision'), 8, mismatch);
    assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.selectedTokens'), 600000);
    assert.match(page.elements.get('model-settings-message').textContent, /后台已确认保存.*回读尚未同步/);
    assert.doesNotMatch(page.elements.get('model-settings-message').textContent, /^已保存并确认/);
    await page.run('refreshModelSettings()'); await settle();
    assert.equal(contextChoiceFor(page).value, '600000', `A later refresh must keep the confirmed budget: ${mismatch}`);
    assert.equal(page.run('modelSettings.revision'), 8);
    assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').length, 1);
  }
});

test('an acknowledgement missing fields uses consistent readback while an unconfirmed 200 response retains the context draft', async () => {
  for (const committed of [false, true]) {
    const page = catalogPage(contextModelCatalog(), (call, api) => {
      if (call.path !== '/api/model-settings' || call.method !== 'POST') return;
      if (committed) {
        api.models = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 }));
        api.models.revision = 8;
      }
      return json({ ok: true });
    });
    await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
    page.elements.get('model-settings-save-button').trigger('click'); await settle();
    assert.equal(contextChoiceFor(page).value, '600000');
    assert.equal(page.run('modelSettingsDirty()'), !committed);
    if (committed) assert.match(page.elements.get('model-settings-message').textContent, /已保存并确认/);
    else assert.match(page.elements.get('model-settings-message').textContent, /尚未得到一致确认.*600K 的上下文草稿已保留/);
  }
});

test('confirmed field protection permits capability changes and newer saved preferences but rejects missing fields until a new service starts', async () => {
  const page = catalogPage(contextModelCatalog()); await settle();
  contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(page.run('modelSettingsRevisionFloor'), 8);
  const narrower = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, maxTokens: 300000,
    options: [300000], effectiveTokens: 300000, valid: false, note: '目录已缩小，当前回退默认。' }));
  narrower.revision = 8; page.models = narrower;
  await page.run('refreshModelSettings()'); await settle();
  assert.match(listText(contextRowFor(page)), /目录已缩小/);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.valid'), false);
  const newer = contextModelCatalog(contextSettingsFixture({ selectedTokens: 1000000, effectiveTokens: 1000000 }));
  newer.revision = 9; page.models = newer;
  await page.run('refreshModelSettings()'); await settle();
  assert.equal(contextChoiceFor(page).value, '1000000'); assert.equal(page.run('modelSettingsRevisionFloor'), 9);
  const incomplete = completeModels(); incomplete.revision = 10; page.models = incomplete;
  await page.run('refreshModelSettings()'); await settle();
  assert.equal(contextChoiceFor(page).value, '1000000'); assert.equal(page.run('modelSettingsRevisionFloor'), 9);
  assert.match(page.elements.get('model-settings-error').textContent, /回读与已确认设置不一致/);
  const replacement = contextModelCatalog(); replacement.revision = 2; page.models = replacement; page.token = 'context-guard-new-service-csrf';
  await page.run('refreshStatus()'); await settle();
  assert.equal(contextChoiceFor(page).value, ''); assert.equal(page.run('modelSettingsRevisionFloor'), 2);
  assert.equal(page.run('modelSettingsConfirmation'), null);
});

test('consistent saved preferences with a reduced same-revision capability retain the latest limit rather than restoring acknowledgement metadata', async () => {
  let posted = false;
  const acknowledgement = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 }));
  acknowledgement.revision = 8;
  const narrower = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, maxTokens: 500000,
    options: [300000], effectiveTokens: 300000, valid: false, note: '上游上限已缩小，当前采用默认预算。' }));
  narrower.revision = 8;
  const page = catalogPage(contextModelCatalog(), call => {
    if (call.path !== '/api/model-settings') return;
    if (call.method === 'POST') { posted = true; return json(acknowledgement); }
    if (posted) return json(narrower);
  });
  await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.selectedTokens'), 600000);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.maxTokens'), 500000);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.valid'), false);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.effectiveTokens'), 300000);
  assert.match(page.elements.get('model-settings-message').textContent, /保存值已确认.*当前不能使用所选上下文预算.*已保留最新目录/);
  assert.match(listText(contextRowFor(page)), /上游声明上限 500K.*上游上限已缩小/);
});

test('a model settings POST network failure preserves 600K without an automatic retry or false saved message', async () => {
  const page = catalogPage(contextModelCatalog(), call => {
    if (call.path === '/api/model-settings' && call.method === 'POST') throw new TypeError('Fixture network failure');
  });
  await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  assert.equal(contextChoiceFor(page).value, '600000'); assert.equal(page.run('modelSettingsDirty()'), true);
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.match(page.elements.get('model-settings-message').textContent, /未能确认保存.*网络|未能确认保存.*network/);
  assert.match(page.elements.get('model-settings-message').textContent, /600K 的上下文草稿已保留/);
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').length, 1);
});

test('a late old-service save acknowledgement cannot restore its revision or confirmation after service replacement', async () => {
  const waiting = deferred(); let posted = false;
  const page = catalogPage(contextModelCatalog(), call => {
    if (call.path === '/api/model-settings' && call.method === 'POST') { posted = true; return waiting.promise; }
  });
  await settle(); contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle(); assert.equal(posted, true);
  const current = contextModelCatalog(); current.revision = 2;
  current.models.push({ id: 'new-service-model', name: 'Fresh service model', channel: 'A', enabled: false });
  page.models = current; page.token = 'new-model-save-service-csrf';
  await page.run('refreshStatus()'); await settle();
  const oldAck = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 })); oldAck.revision = 999;
  const before = page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'GET').length;
  waiting.resolve(json(oldAck)); await settle();
  assert.equal(page.run('modelSettingsConfirmation'), null);
  assert.equal(page.run('modelSettingsRevisionFloor'), 2);
  assert.notEqual(page.run('modelSettings.revision'), 999);
  assert.equal(contextChoiceFor(page).value, '600000'); assert.ok(inputFor(page, 'new-service-model'));
  assert.match(page.elements.get('model-settings-message').textContent, /服务已重新连接.*旧保存结果未确认/);
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'GET').length, before);
});

test('model context tiers save per-model changes alongside checkboxes and reset to the source default', async () => {
  const page = catalogPage(contextModelCatalog()); await settle();
  const choice = contextChoiceFor(page);
  assert.deepEqual(choice.options.map(option => [option.value, option.textContent]), [
    ['', '跟随模型默认（300K）'], ['300000', '300K'], ['600000', '600K'], ['1000000', '1M'], ['custom', '自定义'],
  ]);
  assert.equal(choice.value, ''); assert.equal(customContextFor(page).hidden, true);
  assert.equal(modelInputs(page).length, 8);
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  choice.value = '1000000'; choice.trigger('change');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.equal(inputFor(page, 'cb-opus').checked, true);
  groupButton(page, 'CodeBuddy', '全选可用项').trigger('click');
  assert.equal(contextChoiceFor(page).value, '1000000');
  assert.equal(inputFor(page, 'cb-other').checked, true);
  assert.equal(modelInputs(page).some(input => input.value === '1000000'), false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(save.body, { revision: 7, disabledModels: ['original-b', 'cursor-first', 'cursor-second', 'cursor-unavailable'],
    contextWindows: { 'cb-opus': 1000000 } });
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  assert.equal(contextChoiceFor(page).value, '1000000');
  contextChoiceFor(page).value = ''; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const latest = page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').at(-1);
  assert.deepEqual(latest.body.contextWindows, { 'cb-opus': null });
  assert.deepEqual(page.models.contextWindows, {});
  assert.equal(page.models.models.find(model => model.id === 'cb-opus').contextSettings.effectiveTokens, 300000);
});

test('custom context accepts bounded integer budgets and rejects incomplete, fractional and oversized values before saving', async () => {
  const page = catalogPage(contextModelCatalog()); await settle();
  const choice = contextChoiceFor(page); choice.value = 'custom'; choice.trigger('change');
  const input = customContextFor(page);
  assert.equal(input.hidden, false); assert.equal(input.value, '300000');
  assert.equal(input.min, '1000'); assert.equal(input.max, '1000000');
  assert.equal(input.getAttribute('aria-label'), 'Opus：自定义上下文 Token 数');
  for (const raw of ['', '0', '999', '300000.5', '1e6', '-20000', '1000001']) {
    input.value = raw; input.trigger('input');
    assert.equal(input.getAttribute('aria-invalid'), 'true', raw);
    assert.equal(page.elements.get('model-settings-save-button').disabled, true, raw);
    assert.equal(page.elements.get('model-settings-reset-button').disabled, false, raw);
    assert.match(listText(contextRowFor(page)), /1,000–1,000,000 之间的整数/);
    page.elements.get('model-settings-save-button').trigger('click');
  }
  assert.equal(page.calls.some(call => call.path === '/api/model-settings' && call.method === 'POST'), false);
  input.value = '450000'; input.trigger('input');
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(save.body.contextWindows, { 'cb-opus': 450000 });
  assert.equal(contextChoiceFor(page).value, 'custom'); assert.equal(customContextFor(page).value, '450000');
});

test('unknown model limits stay unknown while custom budgets retain the explicit application bound', async () => {
  const data = contextModelCatalog(contextSettingsFixture({ defaultTokens: null, maxTokens: null, options: [], effectiveTokens: 32000 }));
  const page = catalogPage(data); await settle();
  assert.deepEqual(contextChoiceFor(page).options.map(option => option.value), ['', 'custom']);
  assert.match(listText(contextRowFor(page)), /默认窗口未知.*上游未声明上限/);
  contextChoiceFor(page).value = 'custom'; contextChoiceFor(page).trigger('change');
  const input = customContextFor(page); assert.equal(input.max, '10000000');
  input.value = '10000001'; input.trigger('input'); assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  input.value = '2000000'; input.trigger('input'); assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(save.body.contextWindows, { 'cb-opus': 2000000 });
  assert.match(listText(contextRowFor(page)), /上游未声明上限/);
});

test('context drafts survive search and catalog refresh while a same-field conflict retains the desired budget', async () => {
  const page = catalogPage(contextModelCatalog(), (call, api) => {
    if (call.path === '/api/model-settings' && call.method === 'POST') {
      return json({ error: { message: '模型列表或开关已更新，请刷新后重试。' } }, 409);
    }
  });
  await settle(); setModelGroupOpen(modelGroupFor(page, 'CodeBuddy'), true);
  contextChoiceFor(page).value = '1000000'; contextChoiceFor(page).trigger('change');
  const search = page.elements.get('model-settings-search'); search.value = 'Cursor'; search.trigger('input');
  assert.equal(contextRowFor(page), undefined);
  search.value = ''; search.trigger('input'); assert.equal(contextChoiceFor(page).value, '1000000');
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, true);
  const fresh = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 })); fresh.revision = 8;
  page.models = fresh; await page.run('refreshModelSettings()'); await settle();
  assert.equal(contextChoiceFor(page).value, '1000000');
  assert.equal(page.run('modelSettings.revision'), 7);
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.selectedTokens'), null);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const attempted = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.equal(attempted.body.revision, 7); assert.deepEqual(attempted.body.contextWindows, { 'cb-opus': 1000000 });
  assert.equal(contextChoiceFor(page).value, '1000000');
  assert.equal(page.run('modelSettings.models.find(model => model.id === "cb-opus").contextSettings.selectedTokens'), 600000);
  assert.equal(page.run('modelSettings.revision'), 8);
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  assert.match(page.elements.get('model-settings-message').textContent, /上下文已由其他页面修改.*1M 的上下文草稿已保留/);
  assert.equal(page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').length, 1);
});

test('reduced source limits revalidate unsaved budgets and reset restores both settings without a write', async () => {
  const page = catalogPage(contextModelCatalog()); await settle();
  contextChoiceFor(page).value = '1000000'; contextChoiceFor(page).trigger('change');
  const input = inputFor(page, 'original-a'); input.checked = false; input.trigger('change');
  const fresh = contextModelCatalog(contextSettingsFixture({ maxTokens: 600000, options: [300000, 600000] }));
  page.models = fresh; await page.run('refreshModelSettings()'); await settle();
  assert.equal(contextChoiceFor(page).value, '1000000');
  assert.match(contextChoiceFor(page).options.find(option => option.value === '1000000').textContent, /当前不可用/);
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  contextChoiceFor(page).value = '600000'; contextChoiceFor(page).trigger('change');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('model-settings-reset-button').trigger('click');
  assert.equal(contextChoiceFor(page).value, ''); assert.equal(inputFor(page, 'original-a').checked, true);
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  assert.equal(page.calls.some(call => call.path === '/api/model-settings' && call.method === 'POST'), false);
});

test('unchanged and inactive source context settings are omitted from the patch and legacy backends receive only checkbox fields', async () => {
  const data = contextModelCatalog(contextSettingsFixture({ selectedTokens: 600000, effectiveTokens: 600000 }));
  data.contextWindows['remote/offline/model'] = 750000;
  const page = catalogPage(data); await settle();
  contextChoiceFor(page).value = 'custom'; contextChoiceFor(page).trigger('change');
  assert.equal(customContextFor(page).value, '600000');
  assert.equal(page.elements.get('model-settings-save-button').disabled, true, 'Changing how the same saved number is entered is not a budget change.');
  const input = inputFor(page, 'original-a'); input.checked = false; input.trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.equal(Object.hasOwn(save.body, 'contextWindows'), false);
  assert.equal(page.models.contextWindows['remote/offline/model'], 750000);
  const legacy = catalogPage(); await settle();
  assert.equal(legacy.elements.get('model-settings-list').querySelectorAll('select').length, 0);
  const oldInput = inputFor(legacy, 'original-a'); oldInput.checked = false; oldInput.trigger('change');
  legacy.elements.get('model-settings-save-button').trigger('click'); await settle();
  const oldSave = legacy.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(Object.keys(oldSave.body).sort(), ['disabledModels', 'revision']);
});

test('a saved budget invalidated by source changes can be reset without blocking unrelated checkbox changes', async () => {
  const page = catalogPage(contextModelCatalog(contextSettingsFixture({ selectedTokens: 1000000, maxTokens: 600000,
    options: [300000, 600000], effectiveTokens: 300000, valid: false, note: '上游上限已变化，当前采用默认预算。' })));
  await settle();
  assert.equal(contextChoiceFor(page).value, 'custom');
  assert.match(listText(contextRowFor(page)), /上游上限已变化，当前采用默认预算/);
  assert.equal(page.elements.get('model-settings-save-button').disabled, true);
  const input = inputFor(page, 'original-a'); input.checked = false; input.trigger('change');
  assert.equal(page.elements.get('model-settings-save-button').disabled, false);
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.equal(Object.hasOwn(save.body, 'contextWindows'), false);
  contextChoiceFor(page).value = ''; contextChoiceFor(page).trigger('change');
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const reset = page.calls.filter(call => call.path === '/api/model-settings' && call.method === 'POST').at(-1);
  assert.deepEqual(reset.body.contextWindows, { 'cb-opus': null });
});

test('account model groups start collapsed with native summaries, counts and separate bulk actions', async () => {
  const page = catalogPage(); await settle();
  const groups = modelGroups(page);
  assert.deepEqual(groups.map(group => group.getAttribute('data-model-channel')), ['A', 'B', 'CodeBuddy', 'Cursor']);
  assert.ok(groups.every(group => group.open === false));
  for (const group of groups) {
    const summary = group.children[0];
    assert.equal(summary.tagName, 'SUMMARY');
    assert.equal(summary.querySelectorAll('button').length, 0);
    assert.equal(group.children[1].querySelectorAll('button').length, 2);
  }
  const summary = modelGroupFor(page, 'CodeBuddy').children[0];
  assert.match(listText(summary), /CodeBuddy/);
  assert.match(listText(summary), /已勾选 1 \/ 可用 2 · 共 3 项/);
  assert.equal(inputFor(page, 'cb-unsupported').disabled, true);
  assert.match(listText(modelGroupFor(page, 'CodeBuddy')), /暂未适配视频输出/);
});

test('model disclosure groups use account identities rather than merging sources on the same channel', async () => {
  const page = harness({ models: { revision: 4, discovery: {}, models: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', channel: 'A', enabled: true,
      sourceAccountId: 'legacy-codex-client', sourceAccountName: 'Codex · 当前客户端（A）' },
    { id: 'B-gpt-6.1-sol', name: 'B-GPT-6.1 Sol', channel: 'B', enabled: true,
      sourceAccountId: 'legacy-codex', sourceAccountName: 'Codex员工账号' },
    { id: 'remote/one/Claude-opus', name: 'Claude Opus', channel: 'Bifrost', enabled: false,
      sourceAccountId: 'one', sourceAccountName: '个人账号' },
    { id: 'remote/two/Claude-opus', name: 'Claude Opus', channel: 'Bifrost', enabled: false,
      sourceAccountId: 'two', sourceAccountName: '工作账号' },
  ] } });
  await settle();
  const groups = modelGroups(page);
  assert.deepEqual(groups.map(group => group.getAttribute('data-source-account-id')), ['legacy-codex-client', 'legacy-codex', 'one', 'two']);
  assert.deepEqual(groups.map(group => group.children[0].children[0].textContent), ['Codex · 当前客户端（A）', 'Codex员工账号', '个人账号', '工作账号']);
  assert.ok(groups.every(group => group.open === false));
  groups[2].querySelectorAll('button')[0].trigger('click');
  assert.equal(inputFor(page, 'remote/one/Claude-opus').checked, true);
  assert.equal(inputFor(page, 'remote/two/Claude-opus').checked, false);
  assert.match(listText(modelGroups(page)[2].children[0]), /已勾选 1 \/ 可用 1 · 共 1 项/);
  assert.match(listText(modelGroups(page)[3].children[0]), /已勾选 0 \/ 可用 1 · 共 1 项/);
});

test('the B account group displays its full directory while only two saved choices are enabled', async () => {
  const ids = ['B-gpt-6-astra', 'B-gpt-6.1-sol', 'B-gpt-directory-extra', 'B-gpt-directory-other'];
  const models = ids.map((id, index) => ({ id, name: `Team model ${index + 1}`, channel: 'B',
    enabled: index < 2, available: true, sourceAccountId: 'legacy-codex', sourceAccountName: 'Codex员工账号' }));
  const page = harness({ models: { revision: 8, discovery: { B: { state: 'ready', count: 4 } }, models } });
  await settle();
  const group = modelGroupFor(page, 'B');
  assert.deepEqual(group.querySelectorAll('input').map(input => input.value), ids);
  assert.deepEqual(group.querySelectorAll('input').map(input => input.checked), [true, true, false, false]);
  assert.ok(group.querySelectorAll('input').every(input => input.disabled === false));
  assert.match(listText(group.children[0]), /已勾选 2 \/ 可用 4 · 共 4 项/);
  setModelGroupOpen(group, true);
  for (const [id, checked] of [[ids[0], false], [ids[2], true]]) {
    const input = inputFor(page, id); input.checked = checked; input.trigger('change');
  }
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const saved = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(saved.body, { revision: 8, disabledModels: [ids[0], ids[3]] });
  assert.deepEqual(modelGroupFor(page, 'B').querySelectorAll('input').map(input => input.checked), [false, true, true, false]);
  assert.match(listText(modelGroupFor(page, 'B').children[0]), /已勾选 2 \/ 可用 4 · 共 4 项/);
});

test('search matches account names and a rename preserves account disclosure and draft selections', async () => {
  const model = { id: 'remote/work/Claude-sonnet', name: 'Claude Sonnet', channel: 'Bifrost', enabled: false,
    sourceAccountId: 'work', sourceAccountName: '工作订阅' };
  const page = harness({ models: { revision: 3, discovery: {}, models: [model] } }); await settle();
  setModelGroupOpen(modelGroups(page)[0], true);
  const input = inputFor(page, model.id); input.checked = true; input.trigger('change');
  const search = page.elements.get('model-settings-search'); search.value = '工作订阅'; search.trigger('input');
  assert.equal(modelGroups(page).length, 1); assert.equal(modelGroups(page)[0].open, true);
  search.value = ''; search.trigger('input');
  page.models = { revision: 3, discovery: {}, models: [{ ...model, sourceAccountName: '新账号名称' }] };
  await page.run('refreshModelSettings()');
  assert.equal(modelGroups(page)[0].open, true);
  assert.equal(inputFor(page, model.id).checked, true);
  assert.equal(modelGroups(page)[0].children[0].children[0].textContent, '新账号名称');
  assert.match(listText(page.elements.get('model-settings-list')), /额度来源.*新账号名称/);
  search.value = '不存在的账号'; search.trigger('input'); assert.equal(modelGroups(page).length, 0);
  search.value = ''; search.trigger('input'); assert.equal(modelGroups(page)[0].open, true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('individual account disclosure choices and unsaved model selections survive polling and catalog replacement', async () => {
  const page = catalogPage(); await settle();
  setModelGroupOpen(modelGroupFor(page, 'CodeBuddy'), true);
  setModelGroupOpen(modelGroupFor(page, 'Cursor'), true);
  const edited = inputFor(page, 'cb-other'); edited.checked = true; edited.trigger('change');
  assert.match(listText(modelGroupFor(page, 'CodeBuddy').children[0]), /已勾选 2 \/ 可用 2/);
  setModelGroupOpen(modelGroupFor(page, 'CodeBuddy'), false);
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, false);
  assert.equal(modelGroupFor(page, 'Cursor').open, true);
  page.models = { ...completeModels(), revision: 8, models: [...completeModels().models,
    { id: 'cb-new', name: 'New CodeBuddy model', channel: 'CodeBuddy', enabled: false, available: true }] };
  await page.run('refreshModelSettings()');
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, false);
  assert.equal(modelGroupFor(page, 'Cursor').open, true);
  assert.equal(inputFor(page, 'cb-other').checked, true);
  assert.match(listText(modelGroupFor(page, 'CodeBuddy').children[0]), /已勾选 2 \/ 可用 3 · 共 4 项/);
});

test('search temporarily expands matching accounts and clearing it restores independent disclosure choices', async () => {
  const page = catalogPage(); await settle();
  setModelGroupOpen(modelGroupFor(page, 'A'), true);
  const search = page.elements.get('model-settings-search'); search.value = 'CodeBuddy'; search.trigger('input');
  assert.equal(modelGroups(page).length, 1);
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, true);
  assert.match(listText(modelGroupFor(page, 'CodeBuddy').children[0]), /共 3 项 · 匹配 3 项/);
  search.value = 'Opus'; search.trigger('input');
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, true);
  assert.match(listText(modelGroupFor(page, 'CodeBuddy').children[0]), /共 3 项 · 匹配 1 项/);
  setModelGroupOpen(modelGroupFor(page, 'CodeBuddy'), false);
  search.value = ''; search.trigger('input');
  assert.equal(modelGroupFor(page, 'A').open, true);
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, false);
  assert.equal(modelGroupFor(page, 'Cursor').open, false);
});

test('bulk selection preserves an account opened before its native toggle event is delivered', async () => {
  const page = catalogPage(); await settle();
  modelGroupFor(page, 'CodeBuddy').open = true;
  groupButton(page, 'CodeBuddy', '全选可用项').trigger('click');
  assert.equal(modelGroupFor(page, 'CodeBuddy').open, true);
  assert.equal(modelGroupFor(page, 'Cursor').open, false);
  assert.equal(inputFor(page, 'cb-other').checked, true);
});

test('saving choices includes edits inside multiple collapsed account groups', async () => {
  const page = catalogPage(); await settle();
  for (const [channel, id] of [['CodeBuddy', 'cb-other'], ['Cursor', 'cursor-first']]) {
    setModelGroupOpen(modelGroupFor(page, channel), true);
    const input = inputFor(page, id); input.checked = true; input.trigger('change');
    setModelGroupOpen(modelGroupFor(page, channel), false);
  }
  page.elements.get('model-settings-save-button').trigger('click'); await settle();
  const save = page.calls.find(call => call.path === '/api/model-settings' && call.method === 'POST');
  assert.deepEqual(save.body, { revision: 7, disabledModels: ['original-b', 'cursor-second', 'cursor-unavailable'] });
  assert.ok(modelGroups(page).every(group => group.open === false));
  assert.equal(inputFor(page, 'cb-other').checked, true);
  assert.equal(inputFor(page, 'cursor-first').checked, true);
  assert.equal(inputFor(page, 'cb-unsupported').checked, true);
});

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

const bifrostQuotaSource = (overrides = {}) => ({ id: 'home', name: 'Bifröst · Home', status: 'ok', authenticated: true,
  identity: 'remote-user', source: 'bifrost-remote-account', fetchedAt: '2026-11-03T20:00:00.000Z', error: null, notice: '',
  wallet: { currency: 'CNY', enforceBalance: true, balanceMicros: 12_345_678, reservedMicros: 2_000_000, availableMicros: 10_345_678 },
  tokenQuota: { limit: 1000, used: 850, reserved: 150, remaining: 0 }, key: { expiresAt: '2026-11-30T20:00:00.000Z' }, ...overrides });
const withBifrostQuota = (sources = [bifrostQuotaSource()], overrides = {}) => {
  const snapshot = quotaSnapshot();
  snapshot.accounts.Bifrost = { status: 'ok', authenticated: true, source: 'bifrost-remote-account', fetchedAt: '2026-11-03T20:00:00.000Z',
    notice: '余额由各远端账本提供，不与本机 Token 统计混算。', sources, ...overrides };
  return snapshot;
};

test('Bifrost balances render each source separately with exact CNY amounts, reservations, quotas and Key validity', async () => {
  const other = bifrostQuotaSource({ id: 'second', name: 'Bifröst · Second', identity: 'second-user',
    wallet: { currency: 'CNY', enforceBalance: false, balanceMicros: 9_000_000, reservedMicros: 1_000_000, availableMicros: 8_000_000 },
    tokenQuota: { limit: null, used: 88, reserved: 20, remaining: null }, key: { expiresAt: null } });
  const page = quotaPage(withBifrostQuota([bifrostQuotaSource(), other])); await settle();
  const sources = page.elements.get('quota-bifrost-sources').children;
  assert.equal(sources.length, 2); assert.equal(page.elements.get('quota-bifrost-state').textContent, '已更新');
  const first = listText(sources[0]), second = listText(sources[1]);
  assert.match(first, /remote-user/); assert.match(first, /可用余额（CNY） 10\.345678 元/);
  assert.match(first, /总余额 12\.345678 元/); assert.match(first, /已预留金额 2 元/);
  assert.match(first, /Token 配额：剩余 0 \/ 1,000/); assert.match(first, /本周期已用 850 Token · 已预留 150 Token/);
  assert.match(first, /Key 有效期：至 2026\/11\/30 12:00:00/);
  assert.match(second, /second-user/); assert.match(second, /账面余额（CNY） 9 元/);
  assert.match(second, /可用账面金额 8 元/); assert.match(second, /远端未启用余额限制/);
  assert.match(second, /Token 配额：未设置限额/); assert.match(second, /Key 有效期：未设置到期时间/);
  assert.doesNotMatch(first + second, /无限|不限量|18\.345678|21\.345678/);
  assert.equal(sources[0].querySelectorAll('progress').length, 0);
  assert.match(page.elements.get('quota-bifrost-updated').textContent, /查询时间/);
});

test('Bifrost wallet formatting preserves legitimate zero, negative and safe-integer precision', async () => {
  const wallets = [
    { currency: 'CNY', enforceBalance: true, balanceMicros: 0, reservedMicros: 0, availableMicros: 0 },
    { currency: 'CNY', enforceBalance: true, balanceMicros: -1_000_001, reservedMicros: 0, availableMicros: -1_000_001 },
    { currency: 'CNY', enforceBalance: true, balanceMicros: Number.MAX_SAFE_INTEGER, reservedMicros: 0, availableMicros: Number.MAX_SAFE_INTEGER },
  ];
  const page = quotaPage(withBifrostQuota(wallets.map((wallet, index) => bifrostQuotaSource({ id: `source-${index}`, wallet })))); await settle();
  const [zero, negative, large] = page.elements.get('quota-bifrost-sources').children.map(listText);
  assert.match(zero, /可用余额（CNY） 0 元/); assert.doesNotMatch(zero, /无限|不限量/);
  assert.match(negative, /可用余额（CNY） -1\.000001 元/);
  assert.match(large, /可用余额（CNY） 9007199254\.740991 元/);
});

test('unknown and failed Bifrost sources never render monetary placeholders, old identities or raw markup', async () => {
  const unknown = bifrostQuotaSource({ id: '<script>source</script>', name: '<img src=x onerror=fixture>', status: 'unknown',
    identity: '<b>remote-user</b>', notice: '<script>notice</script>', usageUrl: 'javascript:fixture()',
    wallet: { currency: 'CNY', enforceBalance: true, balanceMicros: 0, reservedMicros: 0, availableMicros: 0 } });
  const failed = bifrostQuotaSource({ id: 'broken', name: 'Broken source', status: 'error', authenticated: false,
    identity: 'old-identity-must-not-display', error: '远端 Key 已过期。' });
  const page = quotaPage(withBifrostQuota([unknown, failed], { status: 'partial' })); await settle();
  const [unknownCard, failedCard] = page.elements.get('quota-bifrost-sources').children;
  assert.equal(page.elements.get('quota-bifrost-state').textContent, '部分需检查');
  assert.match(listText(unknownCard), /未提供余额.*远端未提供可靠余额/);
  assert.doesNotMatch(listText(unknownCard), /0 元|剩余 0|无限/);
  assert.match(listText(unknownCard), /<img src=x onerror=fixture>/); assert.match(listText(unknownCard), /<script>notice<\/script>/);
  assert.equal(unknownCard.querySelectorAll('img').length + unknownCard.querySelectorAll('script').length, 0);
  assert.equal(unknownCard.querySelectorAll('a').length, 0);
  assert.equal(unknownCard.getAttribute('aria-labelledby'), 'quota-bifrost-source-title-0');
  assert.match(listText(failedCard), /需检查.*未确认有效的远端 Key/);
  assert.match(listText(failedCard), /远端 Key 已过期/);
  assert.doesNotMatch(listText(failedCard), /old-identity-must-not-display|10\.345678|12\.345678|1,000/);
});

test('authenticated Bifrost accounts retain verified Key expiry when the remote has no billing ledger', async () => {
  const verified = bifrostQuotaSource({ status: 'unknown', wallet: null, tokenQuota: null,
    key: { expiresAt: '2026-11-30T20:00:00.000Z' } });
  const unverified = { ...verified, id: 'unverified', authenticated: null };
  const page = quotaPage(withBifrostQuota([verified, unverified], { status: 'unknown' })); await settle();
  const [verifiedCard, unverifiedCard] = page.elements.get('quota-bifrost-sources').children.map(listText);
  assert.match(verifiedCard, /未提供余额/);
  assert.match(verifiedCard, /Key 有效期：至 2026\/11\/30 12:00:00/);
  assert.doesNotMatch(verifiedCard, /可用余额|总余额|已预留金额|Token 配额：剩余|0 元/);
  assert.match(unverifiedCard, /Key 有效期：未返回/);
  assert.doesNotMatch(unverifiedCard, /2026\/11\/30/);
});

test('malformed Bifrost balances and token quota values remain unknown instead of borrowing valid-looking numbers', async () => {
  for (const wallet of [
    { currency: 'USD', enforceBalance: true, balanceMicros: 100, reservedMicros: 0, availableMicros: 100 },
    { currency: 'CNY', enforceBalance: true, balanceMicros: 100, reservedMicros: 20, availableMicros: 100 },
    { currency: 'CNY', enforceBalance: true, balanceMicros: 1.5, reservedMicros: 0, availableMicros: 1.5 },
  ]) {
    const source = bifrostQuotaSource({ wallet, tokenQuota: { limit: 100, used: 90, reserved: 10, remaining: 100 } });
    const page = quotaPage(withBifrostQuota([source])); await settle();
    const card = page.elements.get('quota-bifrost-sources').children[0];
    assert.match(listText(card), /远端未提供可靠余额/); assert.match(listText(card), /Token 配额：未返回/);
    assert.doesNotMatch(listText(card), /可用余额|总余额|剩余 100|无限/);
  }
});

test('Bifrost quota refresh clears removed sources and distinguishes a missing backend from no configured source', async () => {
  const page = quotaPage(withBifrostQuota()); await settle();
  assert.match(listText(page.elements.get('quota-bifrost-sources')), /remote-user/);
  page.setQuotas(withBifrostQuota([], { status: 'not_connected', authenticated: false, notice: '' }));
  page.elements.get('quota-refresh-button').trigger('click'); await settle();
  assert.equal(page.elements.get('quota-bifrost-state').textContent, '未绑定');
  assert.match(listText(page.elements.get('quota-bifrost-sources')), /未配置远端 Bifröst 来源/);
  assert.doesNotMatch(listText(page.elements.get('quota-bifrost-sources')), /remote-user|10\.345678/);
  page.setQuotas(quotaSnapshot()); page.elements.get('quota-refresh-button').trigger('click'); await settle();
  assert.equal(page.elements.get('quota-bifrost-state').textContent, '待更新服务');
  assert.match(listText(page.elements.get('quota-bifrost-sources')), /当前服务未提供远端账号余额/);
});

test('remote-only nodes display remote balances and permit manual refresh without polling local accounts or scheduling balance reads', async () => {
  const page = harness({ quotas: withBifrostQuota(), node: { capabilities: {
    clientIntegration: false, userManagement: true, activeKinds: ['bifrost'],
  } } }); await settle();
  const count = () => page.calls.filter(call => call.path === '/api/account-quotas').length;
  assert.equal(page.elements.get('account-quotas-panel').hidden, false);
  assert.ok(page.document.querySelectorAll('[data-local-quota]').every(element => element.hidden));
  assert.equal(count(), 1); assert.match(listText(page.elements.get('quota-bifrost-sources')), /10\.345678 元/);
  for (const interval of page.intervals) interval.callback(); await settle(); assert.equal(count(), 1);
  page.elements.get('quota-refresh-button').trigger('click'); await settle(); assert.equal(count(), 2);
  assert.equal(page.calls.some(call => ['/api/cursor', '/api/codebuddy', '/api/with', '/api/token-usage'].includes(call.path)), false);
});

test('service replacement refreshes Bifrost balances once and does not retain the former source list', async () => {
  const page = harness({ quotas: withBifrostQuota(), node: { capabilities: { clientIntegration: true, activeKinds: ['bifrost'] } } }); await settle();
  const count = () => page.calls.filter(call => call.path === '/api/account-quotas').length;
  assert.equal(count(), 1);
  page.token = 'new-service-token';
  page.quotas = withBifrostQuota([bifrostQuotaSource({ id: 'new', identity: 'new-remote-user' })]);
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(count(), 2); assert.match(listText(page.elements.get('quota-bifrost-sources')), /new-remote-user/);
  for (const interval of page.intervals) interval.callback(); await settle(); assert.equal(count(), 2);
});

test('late Bifrost quota results from a replaced service cannot restore the old account or release a newer query', async () => {
  const waiting = [], page = harness({ fetch(call) {
    if (call.path === '/api/account-quotas') return new Promise(resolve => waiting.push(resolve));
  } }); await settle();
  assert.equal(waiting.length, 1);
  page.token = 'replacement-service-csrf';
  await page.run('refreshStatus()'); await settle(); assert.equal(waiting.length, 2);
  waiting[0](json(withBifrostQuota([bifrostQuotaSource({ identity: 'former-remote-owner' })]))); await settle();
  assert.equal(page.elements.get('quota-refresh-button').disabled, true);
  assert.doesNotMatch(listText(page.elements.get('quota-bifrost-sources')), /former-remote-owner/);
  waiting[1](json(withBifrostQuota([bifrostQuotaSource({ identity: 'current-remote-owner' })]))); await settle();
  assert.equal(page.elements.get('quota-refresh-button').disabled, false);
  assert.match(listText(page.elements.get('quota-bifrost-sources')), /current-remote-owner/);
  for (const interval of page.intervals) interval.callback(); await settle(); assert.equal(waiting.length, 2);
});

test('modern local nodes keep quota windows visible and refresh them only on load, manual action, or authorization change', async () => {
  const page = harness({ quotas: quotaSnapshot(), node: { capabilities: {
    clientIntegration: true, userManagement: false, activeKinds: ['codex-client', 'codex', 'codebuddy', 'cursor'],
  } } });
  await settle();
  const count = () => page.calls.filter(call => call.path === '/api/account-quotas').length;
  assert.equal(count(), 1, 'A modern local node must read its account quotas on initial load.');
  const panel = page.elements.get('account-quotas-panel');
  assert.ok(panel, 'The quota section must have a stable DOM identity.');
  assert.equal(panel.hidden, false);
  assert.equal(panel.hasAttribute('data-client-integration-only'), false, 'Remote-only nodes also have account balances.');
  assert.equal(panel.hasAttribute('data-legacy-overview'), false);
  assert.match(listText(page.elements.get('quota-a-windows')), /剩余 25%/);
  assert.match(listText(page.elements.get('quota-b-windows')), /剩余 75%/);
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(count(), 1, 'Ordinary status polling must not repeatedly query account quotas.');
  const changed = quotaSnapshot(); changed.accounts.B.windows[0].remainingPercent = 68;
  page.quotas = changed;
  page.elements.get('quota-refresh-button').trigger('click'); await settle();
  assert.equal(count(), 2); assert.match(listText(page.elements.get('quota-b-windows')), /剩余 68%/);
  changed.accounts.Cursor.identity = 'after-local-authorization@example.test';
  page.cursor = { ...page.cursor, configured: true, enabled: true, authReady: true,
    profile: { email: 'after-local-authorization@example.test' } };
  await page.run('refreshCursor()'); await settle();
  assert.equal(count(), 3, 'A newly authorized local provider must refresh account quota metadata.');
  assert.equal(page.elements.get('quota-cursor-identity').textContent, 'after-local-authorization@example.test');
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(count(), 3); assert.equal(panel.hidden, false);
  assert.ok(page.document.querySelectorAll('[data-legacy-overview]').every(element => element.hidden),
    'Restoring the quota section must not restore other legacy sections.');
});

test('legacy backends retain a visible quota section and their initial quota lookup', async () => {
  const page = quotaPage(); await settle();
  const panel = page.elements.get('account-quotas-panel');
  assert.ok(panel, 'The quota section must have a stable DOM identity.');
  assert.equal(panel.hidden, false);
  assert.equal(page.calls.filter(call => call.path === '/api/account-quotas').length, 1);
  assert.match(listText(page.elements.get('quota-a-windows')), /剩余 25%/);
});

test('managed nodes keep quota controls hidden and cannot query unrelated quotas through manual or authorization refresh', async () => {
  const page = harness({ node: { capabilities: { clientIntegration: false, userManagement: true, activeKinds: ['claude'] } } });
  await settle();
  const panel = page.elements.get('account-quotas-panel');
  assert.ok(panel, 'The quota section must have a stable DOM identity.');
  assert.equal(panel.hidden, true);
  page.elements.get('quota-refresh-button').trigger('click');
  await page.run('refreshAuthorizedAccountQuotas()'); await settle();
  for (const interval of page.intervals) interval.callback(); await settle();
  assert.equal(page.calls.some(call => call.path === '/api/account-quotas'), false);
});

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
  for (const key of ['图片', '客户端工具', '思考', '缓存']) assert.equal(fields[key], '目录未声明');
  assert.equal(fields['上下文'], '未取得当前模型上限');
  assert.equal(fields['调用验证'], '尚未验证'); assert.equal(fields['指令处理'], '尚未取得接入方式');
  assert.match(listText(evidence), /未知能力不会标成支持/);
  assert.equal(inputFor(page, 'cb-opus').checked, true);
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('model details distinguish completed history, copyable snapshots, checkpoints and active tool callbacks', async () => {
  const models = completeModels(), target = models.models.find(model => model.id === 'cb-opus');
  target.compatibility = capabilitiesFromCatalog({}, { channel: 'Cursor' }).compatibility;
  const page = catalogPage(models); await settle();
  const fields = detailFields(evidenceFor(page, 'cb-opus'));
  assert.match(fields['完整明文历史'], /分叉：不支持/);
  assert.match(fields['已完成检查点'], /重启恢复：有条件/);
  assert.match(fields['执行中的工具回合'], /续聊：有条件.*分叉：不支持.*重启恢复：不支持/);
  assert.match(fields['加密历史快照'], /换来源：不支持/);
  assert.match(fields['会话条件'], /来源校验/);
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
  assert.match(fields['思考'], /medium、xhigh/); assert.equal(fields['缓存'], '目录未声明');
  assert.equal(fields['上下文'], '目录默认 300,000 Token'); assert.equal(fields['指令处理'], '协议适配');
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
  assert.match(fields['客户端工具'], /^支持.*<img/); assert.equal(fields['上下文'], '未取得当前模型上限');
  assert.equal(fields['调用验证'], '最近调用失败'); assert.match(fields['验证说明'], /网络错误/);
  assert.equal(evidence.querySelectorAll('img').length + evidence.querySelectorAll('script').length, 0);
  assert.equal(fields['兼容说明'], '<script>fixture</script>');
});

test('Claude evidence separates adapter support, CLI budget and observed features instead of a repeated unknown label', async () => {
  const models = completeModels(), target = models.models.find(model => model.id === 'cb-opus');
  target.capabilities = { images: { support: null, adapterSupport: true }, tools: { support: null, adapterSupport: true },
    cache: { support: null, source: 'response-usage' }, contextWindow: { tokens: 1000000, source: 'official-cli-runtime', note: '未进行满窗口压力测试。' } };
  const page = catalogPage(models); await settle();
  let fields = detailFields(evidenceFor(page, 'cb-opus'));
  assert.match(fields['图片'], /适配器已支持，模型待实测/); assert.match(fields['客户端工具'], /适配器已支持，模型待实测/);
  assert.equal(fields['缓存'], '按响应计量'); assert.match(fields['上下文'], /1,000,000 Token（官方 CLI 当前上限）.*未进行满窗口压力测试/);
  target.verification = { state: 'passed', checkedAt: '2026-11-01T08:00:00Z', observed: { images: true, tools: true, cache: true } };
  const verified = catalogPage(models); await settle(); fields = detailFields(evidenceFor(verified, 'cb-opus'));
  assert.match(fields['图片'], /^已记录含图片的成功调用.*正常完成/); assert.match(fields['客户端工具'], /^已记录工具回传后的完整调用.*工具由客户端执行/);
  assert.match(fields['缓存'], /^已观察到缓存命中.*实际响应为准/); assert.match(fields['验证时间'], /北京时间/);
  assert.doesNotMatch(fields['图片'] + fields['客户端工具'], /待实测|仍需.*验证/);
  assert.equal(verified.calls.some(call => call.method === 'POST'), false);
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

test('request details expose sanitized rejected-field shapes without source field values', async () => {
  const record = diagnosticRecord('shape_error', { errorCode: 'codebuddy_unsupported_delta',
    sourceDiagnostics: describeCodeBuddyDeltaFields({ function_call: { name: 'PRIVATE_TOOL_NAME', arguments: 'PRIVATE_ARGUMENTS' } }, ['function_call']) });
  const page = modernPage(call => call.path === '/api/request-diagnostics/shape_error' ? json({ request: record }) : undefined,
    { diagnostics: { recent: [record] } }); await settle();
  page.elements.get('diagnostics-recent-body').querySelectorAll('button')[0].trigger('click'); await settle();
  const fields = detailFields(page.elements.get('diagnostics-fields'));
  assert.match(fields['未适配字段'], /function_call \(object\).*name \(string, 长度 17\).*arguments/);
  assert.doesNotMatch(listText(page.elements.get('diagnostics-fields')), /PRIVATE_TOOL_NAME|PRIVATE_ARGUMENTS/);
});

test('request details show the fixed protocol check and bounded structural information', async () => {
  const record = diagnosticRecord('protocol_check', { errorCode: 'codebuddy_upstream_protocol_error',
    sourceDiagnostics: describeCodeBuddyProtocolCheck('tool_calls_type', { valueType: 'null', count: 0, limit: 128 }) });
  const page = modernPage(call => call.path === '/api/request-diagnostics/protocol_check' ? json({ request: record }) : undefined,
    { diagnostics: { recent: [record] } }); await settle();
  page.elements.get('diagnostics-recent-body').querySelectorAll('button')[0].trigger('click'); await settle();
  const fields = detailFields(page.elements.get('diagnostics-fields'));
  assert.equal(fields['协议校验项'], '工具调用增量不是数组。');
  assert.equal(fields['结构信息'], '类型 null；数量 0；上限 128');
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
