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
    set codebuddy(value) { codebuddy = value; }, get codebuddy() { return codebuddy; },
    set quotas(value) { quotas = value; }, get quotas() { return quotas; },
    set diagnostics(value) { diagnostics = value; }, get diagnostics() { return diagnostics; },
    changeHash(value) { location.hash = value; windowListeners.get('hashchange')?.({ type: 'hashchange' }); },
    get elapsed() { return clock; } };
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ document, fetch, Response, Headers, AbortSignal, URL, navigator: {}, Date: Clock,
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    crypto: overrides.crypto ?? { randomUUID: () => '33333333-3333-4333-8333-333333333333' }, window: { location, sessionStorage: overrides.storage, history: { replaceState(state, title, url) { historyCalls.push({ state, title, url }); location.href = new URL(url, location).href; } },
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

const accountId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const accountBilling = () => ({ accountId, enforceBalance: false, balanceMicros: 10000001, reservedMicros: 2000000,
  availableMicros: 8000001, tokenLimit: 10000, usedTokens: 500, reservedTokens: 100, remainingTokens: 9400, pendingCount: 0, unresolvedCount: 0 });
const adminData = () => ({ accounts: [{ id: accountId, username: 'billing-user', enabled: true, allowedModels: [], keys: [], billing: accountBilling() }],
  invites: [], models: [{ id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy Opus 5.5', channel: 'CodeBuddy', enabled: true }],
  registration: { mode: 'open', defaultKeyDays: 30 }, server: {}, billing: { available: true, currency: 'CNY', prices: [], recent: [] } });
function billingHarness(options = {}) {
  const data = options.data ?? adminData();
  const storageValues = new Map(), storage = options.storage ?? { getItem: key => storageValues.get(key), setItem: (key, value) => storageValues.set(key, value) };
  const page = harness({ ...options, storage, fetch(call, api) {
    const custom = options.fetch?.(call, api); if (custom !== undefined) return custom;
    if (call.path === '/api/client-admin') return json(data);
    if (call.path.startsWith('/api/client-admin/billing/unresolved?')) return json({ rows: (data.billing?.unresolved ?? data.billing?.recent ?? []).filter(row => row.status === 'unresolved'), nextBefore: null });
    if (call.path.includes('/billing/history')) return json({ rows: (data.billing?.recent ?? []).map((row, index) => ({ ...row, id: String(index) })), nextBefore: null });
  } });
  page.data = data; return page;
}
async function openBilling(page) { await settle(); page.elements.get('tab-clients').trigger('click'); await settle(); }
function allText(element) { return [element.textContent, ...element.children.map(allText)].join(' '); }

test('billing parses decimal CNY exactly and rejects exponent, excess precision, unsafe amount and signed prices', async () => {
  const page = billingHarness(); await openBilling(page);
  assert.equal(page.run("clientDecimalMicros('0.100001')"), 100001);
  assert.equal(page.run("clientDecimalMicros('9007199254.740991')"), Number.MAX_SAFE_INTEGER);
  assert.equal(page.run("clientDecimalMicros('-0.000001', {signed:true})"), -1);
  assert.equal(page.run('clientMoney(-100001)'), '-0.100001 元');
  for (const input of ['1e3', '1.0000001', '-1', '+1', 'NaN', '9007199254.740992', '.5', '1.']) assert.throws(() => page.run(`clientDecimalMicros(${JSON.stringify(input)})`));
  assert.throws(() => page.run("clientDecimalMicros('0', {signed:true, nonzero:true})"));
});

test('legacy client admin never invents zero balance or default prices and disables billing writes', async () => {
  const data = adminData(); delete data.billing; delete data.accounts[0].billing;
  const page = billingHarness({ data }); await openBilling(page);
  assert.equal(page.elements.get('client-billing-state').textContent, '待更新后台');
  assert.equal(page.elements.get('client-billing-metrics').children.length, 0);
  assert.match(page.elements.get('client-billing-note').textContent, /当前不按零余额展示/);
  assert.equal(page.elements.get('client-balance-submit').disabled, true);
  assert.equal(page.elements.get('client-price-save').disabled, true);
  assert.equal(page.elements.get('client-price-input').value, '');
  assert.equal(page.calls.some(call => call.method === 'POST'), false);
});

test('manual prices submit complete exact micro amounts without changing another model or inventing rates', async () => {
  const page = billingHarness({ fetch(call) { if (call.path === '/api/client-admin/billing/prices') return json({ price: call.body }); } }); await openBilling(page);
  assert.equal(page.elements.get('client-price-input').value, '');
  for (const [id, value] of [['client-price-input', '12.100001'], ['client-price-cached', '0.000001'], ['client-price-output', '50'], ['client-price-reserve-input', '1000'], ['client-price-reserve-output', '256']]) page.elements.get(id).value = value;
  page.elements.get('client-price-enabled').checked = true;
  page.elements.get('client-prices-form').trigger('submit'); await settle();
  assert.deepEqual(page.calls.find(call => call.path === '/api/client-admin/billing/prices').body, { model: 'claude-codebuddy-opus-5-5', inputRateMicros: 12100001,
    cachedInputRateMicros: 1, outputRateMicros: 50000000, reserveInputTokens: 1000, reserveOutputTokens: 256, enabled: true });
  assert.equal(page.calls.find(call => call.path === '/api/client-admin/billing/prices').headers['X-Bridge-CSRF'], 'old-service-csrf');
});

test('uncertain balance adjustment retries the original payload and operation ID after reload', async () => {
  const store = new Map(), storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
  let tries = 0;
  const fetch = call => {
    if (!call.path.endsWith('/balance')) return;
    if (++tries === 1) return Promise.reject(new Error('connection reset'));
    return json({ billing: { ...accountBilling(), balanceMicros: 12200002 } });
  };
  const first = billingHarness({ storage, fetch }); await openBilling(first);
  first.elements.get('client-balance-amount').value = '2.200001'; first.elements.get('client-balance-note').value = '充值测试';
  first.elements.get('client-balance-form').trigger('submit'); await settle();
  const original = first.calls.find(call => call.path.endsWith('/balance'));
  assert.equal(original.body.amountMicros, 2200001);
  assert.equal(first.elements.get('client-balance-amount').disabled, true);
  assert.match(first.elements.get('client-balance-pending').textContent, /重试同一笔/);
  const reloaded = billingHarness({ storage, fetch }); await openBilling(reloaded);
  assert.equal(reloaded.elements.get('client-balance-amount').value, '2.200001');
  reloaded.elements.get('client-balance-form').trigger('submit'); await settle();
  assert.deepEqual(reloaded.calls.find(call => call.path.endsWith('/balance')).body, original.body);
  assert.equal(reloaded.elements.get('client-balance-pending').textContent, '');
  assert.equal(JSON.parse([...store.values()][0]).length, 0);
});

test('HTTP success without a confirmed billing object preserves the pending operation', async () => {
  let response = json({});
  const page = billingHarness({ fetch(call) { if (call.path.endsWith('/balance')) return response; } }); await openBilling(page);
  page.elements.get('client-balance-amount').value = '-0.000001'; page.elements.get('client-balance-note').value = '';
  page.elements.get('client-balance-form').trigger('submit'); await settle();
  const first = page.calls.find(call => call.path.endsWith('/balance'));
  assert.match(page.elements.get('client-balance-pending').textContent, /尚未确认/);
  response = json({ billing: accountBilling() });
  page.elements.get('client-balance-form').trigger('submit'); await settle();
  assert.deepEqual(page.calls.filter(call => call.path.endsWith('/balance'))[1].body, first.body);
});

test('authorization failure after an uncertain credit never discards the original operation ID', async () => {
  let attempts = 0;
  const page = billingHarness({ fetch(call) {
    if (!call.path.endsWith('/balance')) return;
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('network reset'));
    if (attempts === 2) return json({ error: { message: 'CSRF expired' } }, 403);
    return json({ billing: accountBilling() });
  } }); await openBilling(page);
  page.elements.get('client-balance-amount').value = '1'; page.elements.get('client-balance-note').value = '';
  for (let index = 0; index < 3; index++) { page.elements.get('client-balance-form').trigger('submit'); await settle(); }
  const calls = page.calls.filter(call => call.path.endsWith('/balance'));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, calls[0].body); assert.deepEqual(calls[2].body, calls[0].body);
});

test('busy and rate-limited responses after an uncertain credit keep retrying one operation ID', async () => {
  let attempts = 0;
  const page = billingHarness({ fetch(call) {
    if (!call.path.endsWith('/balance')) return;
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('network reset'));
    if (attempts === 2) return json({ error: { message: 'admin busy', code: 'admin_busy' } }, 409);
    if (attempts === 3) return json({ error: { message: 'rate limited' } }, 429);
    return json({ billing: accountBilling() });
  } }); await openBilling(page);
  page.elements.get('client-balance-amount').value = '1'; page.elements.get('client-balance-note').value = '';
  for (let index = 0; index < 4; index++) { page.elements.get('client-balance-form').trigger('submit'); await settle(); }
  const calls = page.calls.filter(call => call.path.endsWith('/balance'));
  assert.equal(calls.length, 4);
  for (const call of calls.slice(1)) assert.deepEqual(call.body, calls[0].body);
});

test('unavailable session storage refuses a new credit before sending any mutation', async () => {
  const page = billingHarness({ storage: { getItem() { return null; }, setItem() { throw new Error('blocked'); } } }); await openBilling(page);
  page.elements.get('client-balance-amount').value = '1'; page.elements.get('client-balance-form').trigger('submit'); await settle();
  assert.equal(page.calls.some(call => call.path.endsWith('/balance')), false);
  assert.match(page.elements.get('client-admin-error').textContent, /尚未发送调整/);
});

test('a full pending operation store rejects new credits without dropping older uncertain IDs', async () => {
  const stored = Array.from({ length: 100 }, (_, index) => {
    const otherId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return { slot: `balance:${otherId}`, path: `/api/client-admin/accounts/${otherId}/balance`, body: { amountMicros: 1000000, operationId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}` } };
  });
  let saved = JSON.stringify(stored);
  const page = billingHarness({ storage: { getItem: () => saved, setItem: (key, value) => { saved = value; } } }); await openBilling(page);
  page.elements.get('client-balance-amount').value = '1'; page.elements.get('client-balance-form').trigger('submit'); await settle();
  assert.equal(page.calls.some(call => call.path.endsWith('/balance')), false);
  assert.deepEqual(JSON.parse(saved), stored);
  assert.equal(page.run('clientBillingOperations.size'), 100);
  assert.match(page.elements.get('client-admin-error').textContent, /100 笔未确认操作/);
});

test('Token quota saves independently from balance enforcement and pending requests prevent a reset', async () => {
  const data = adminData(); data.accounts[0].billing.pendingCount = 1;
  const page = billingHarness({ data, fetch(call) { if (call.path.endsWith('/billing')) return json({ billing: accountBilling() }); } }); await openBilling(page);
  page.elements.get('client-billing-enforce').checked = false; page.elements.get('client-billing-token-limit').value = '900';
  page.elements.get('client-billing-policy-form').trigger('submit'); await settle();
  assert.deepEqual(page.calls.find(call => call.path.endsWith('/billing')).body, { enforceBalance: false, tokenLimit: 900 });
  page.elements.get('client-billing-reset-confirm').checked = true; page.elements.get('client-billing-reset-confirm').trigger('change');
  assert.equal(page.elements.get('client-billing-quota-reset').disabled, true);
  data.accounts[0].billing.pendingCount = 0; page.elements.get('client-admin-refresh').trigger('click'); await settle();
  page.elements.get('client-billing-reset-confirm').checked = true; page.elements.get('client-billing-reset-confirm').trigger('change');
  page.elements.get('client-billing-quota-reset').trigger('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.path.endsWith('/billing'))[1].body, { enforceBalance: false, tokenLimit: 10000, resetQuota: true });
});

test('unresolved settlement validates totals and retains its operation ID across network failure and 409 busy', async () => {
  const data = adminData(); data.accounts[0].billing.unresolvedCount = 1;
  data.billing.recent = [{ type: 'unresolved', status: 'unresolved', accountId, requestId, model: 'claude-codebuddy-opus-5-5', time: '2026-10-23T00:00:00Z', reservedMicros: 1000000, reservedTokens: 500 }];
  let count = 0;
  const page = billingHarness({ data, fetch(call) {
    if (!call.path.endsWith('/resolve')) return;
    if (++count === 1) return Promise.reject(new Error('network reset'));
    if (count === 2) return json({ error: { message: 'admin busy', code: 'admin_busy' } }, 409);
    return json({ record: { requestId, status: 'settled' } });
  } }); await openBilling(page);
  let form = page.elements.get('client-unresolved-list').querySelectorAll('form')[0];
  const inputs = form.querySelectorAll('input'), values = ['10', '3', '5', '20'];
  values.forEach((value, index) => { inputs[index].value = value; }); inputs[4].checked = true;
  form.trigger('submit'); await settle();
  assert.equal(page.calls.some(call => call.path.endsWith('/resolve')), false);
  inputs[3].value = '15'; form.trigger('submit'); await settle();
  const first = page.calls.find(call => call.path.endsWith('/resolve'));
  assert.deepEqual(first.body.usage, { inputTokens: 10, cachedInputTokens: 3, outputTokens: 5, totalTokens: 15 });
  form.trigger('submit'); await settle(); form.trigger('submit'); await settle();
  const calls = page.calls.filter(call => call.path.endsWith('/resolve'));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, first.body); assert.deepEqual(calls[2].body, first.body);
});

test('unresolved requests use a separate paginated endpoint and old ledger events cannot be resolved again', async () => {
  const data = adminData(), cursor = '55555555-5555-4555-8555-555555555555';
  data.billing.recent = [{ type: 'settled', status: 'settled', accountId, requestId }, { type: 'unresolved', status: 'unresolved', accountId, requestId }];
  const first = { accountId, requestId: '66666666-6666-4666-8666-666666666666', status: 'unresolved', reservedMicros: 1, reservedTokens: 10 };
  const second = { accountId, requestId: '77777777-7777-4777-8777-777777777777', status: 'unresolved', reservedMicros: 2, reservedTokens: 20 };
  const page = billingHarness({ data, fetch(call) {
    if (call.path.startsWith('/api/client-admin/billing/unresolved?')) return json({ rows: call.path.includes('&before=') ? [second] : [first], nextBefore: call.path.includes('&before=') ? null : cursor });
  } }); await openBilling(page);
  assert.equal(page.elements.get('client-ledger-list').querySelectorAll('form').length, 0);
  assert.equal(page.elements.get('client-unresolved-list').querySelectorAll('form').length, 1);
  assert.equal(page.elements.get('client-unresolved-more').hidden, false);
  page.elements.get('client-unresolved-more').trigger('click'); await settle();
  assert.equal(page.elements.get('client-unresolved-list').querySelectorAll('form').length, 2);
  assert.equal(page.elements.get('client-unresolved-more').hidden, true);
  assert.ok(page.calls.some(call => call.path === `/api/client-admin/billing/unresolved?accountId=${accountId}&before=${cursor}`));
  page.elements.get('client-admin-refresh').trigger('click'); await settle();
  assert.equal(page.elements.get('client-unresolved-list').querySelectorAll('form').length, 1);
});

test('user ledger paginates its own full history rather than filtering global recent events', async () => {
  const data = adminData(), cursor = '55555555-5555-4555-8555-555555555555';
  data.billing.recent = [{ id: 'unrelated-global-event', accountId: 'other-user', type: 'balance_adjustment', amountMicros: 99 }];
  const page = billingHarness({ data, fetch(call) {
    if (call.path.includes('/billing/history')) return json({ rows: [{ id: call.path.includes('?before=') ? 'old-user-entry' : 'first-user-entry', accountId,
      type: 'balance_adjustment', amountMicros: call.path.includes('?before=') ? 2000000 : 1000000 }], nextBefore: call.path.includes('?before=') ? null : cursor });
  } }); await openBilling(page);
  assert.equal(page.elements.get('client-ledger-list').children.length, 1);
  assert.match(allText(page.elements.get('client-ledger-list')), /1 元/);
  assert.equal(page.elements.get('client-ledger-more').hidden, false);
  page.elements.get('client-ledger-more').trigger('click'); await settle();
  assert.equal(page.elements.get('client-ledger-list').children.length, 2);
  assert.match(allText(page.elements.get('client-ledger-list')), /2 元/);
  assert.equal(page.elements.get('client-ledger-more').hidden, true);
  assert.ok(page.calls.some(call => call.path === `/api/client-admin/accounts/${accountId}/billing/history?before=${cursor}`));
});

test('late user ledger responses cannot overwrite another selected account', async () => {
  const data = adminData(), secondId = '88888888-8888-4888-8888-888888888888';
  data.accounts.push({ ...data.accounts[0], id: secondId, username: 'second-user', billing: { ...accountBilling(), accountId: secondId } });
  let finishFirst;
  const page = billingHarness({ data, fetch(call) {
    if (call.path === `/api/client-admin/accounts/${accountId}/billing/history`) return new Promise(resolve => { finishFirst = resolve; });
    if (call.path === `/api/client-admin/accounts/${secondId}/billing/history`) return json({ rows: [{ id: 'second-only-entry', accountId: secondId, note: 'second only', type: 'balance_adjustment', amountMicros: 1 }], nextBefore: null });
    if (call.path.includes('/billing/unresolved?')) return json({ rows: [], nextBefore: null });
  } }); await openBilling(page);
  page.elements.get('client-user-list').children[1].trigger('click'); await settle();
  finishFirst(json({ rows: [{ id: 'first-delayed-entry', accountId, note: 'first delayed', type: 'balance_adjustment', amountMicros: 1 }], nextBefore: null })); await settle();
  assert.match(allText(page.elements.get('client-ledger-list')), /second only/);
  assert.doesNotMatch(allText(page.elements.get('client-ledger-list')), /first delayed/);
  assert.equal(page.elements.get('client-detail-title').textContent, 'second-user');
});

const portalHtml = await readFile(new URL('../public/portal.html', import.meta.url), 'utf8');
const portalSource = await readFile(new URL('../public/portal.js', import.meta.url), 'utf8');
function portalHarness(data) {
  const elements = new Map([...portalHtml.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, tag, attrs, id]) => [id, new Element(tag, attrs)]));
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) }, Date, URL, Response, AbortSignal, navigator: {},
    window: { addEventListener() {} }, fetch: async path => path.endsWith('/config') ? json({ registration: {}, gateway: {} }) : path.endsWith('/session') ? json({ user: data.user, csrfToken: 'csrf' }) : json(data) });
  vm.runInContext(portalSource, context); return { elements };
}

test('portal shows only returned billing values, caps recent entries at 50 and never exposes extra secret fields', async () => {
  const data = { user: { username: 'client', enabled: true }, billing: { ...accountBilling(), enforceBalance: true, history: Array.from({ length: 60 }, (_, index) => ({ type: 'settle', status: 'settled', amountMicros: 1, model: '<script>text</script>', usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 }, secret: 'do-not-render', time: '2026-10-23T00:00:00Z', requestId: String(index) })) }, models: [], keys: [] };
  const page = portalHarness(data); await settle();
  assert.match(allText(page.elements.get('portal-billing-metrics')), /10.000001 元.*2 元.*8.000001 元.*500.*100.*9,400/);
  assert.equal(page.elements.get('portal-billing-history').children.length, 50);
  assert.match(allText(page.elements.get('portal-billing-history')), /<script>text<\/script>/);
  assert.doesNotMatch(allText(page.elements.get('portal-billing-history')), /do-not-render/);
  const legacy = portalHarness({ ...data, billing: undefined }); await settle();
  assert.equal(legacy.elements.get('portal-billing-state').textContent, '待更新后台');
  assert.equal(legacy.elements.get('portal-billing-metrics').children.length, 0);
});

test('mini program projects billing read-only, caps history at 50 and clears it when session resets', async () => {
  const miniSource = await readFile(new URL('../wechat-miniprogram/pages/index/index.js', import.meta.url), 'utf8');
  let page;
  vm.runInNewContext(miniSource, { require: () => ({ api() { throw new Error('No write expected'); } }), Page: value => { page = value; }, getApp: () => ({ globalData: {} }), wx: {} });
  page.setData = update => Object.assign(page.data, update); page._config = { gateway: {} };
  page.render({ user: { username: 'client', enabled: true }, models: [], keys: [], billing: { ...accountBilling(), history: Array.from({ length: 55 }, () => ({ type: 'settle', status: 'settled', amountMicros: 100001, secret: 'hidden' })) } });
  assert.equal(page.data.billingReady, true);
  assert.equal(page.data.billingMetrics[0].value, '10.000001 元');
  assert.equal(page.data.billingHistory.length, 50);
  assert.equal(page.data.billingHistory[0].amount, '0.100001 元');
  assert.equal(page.data.billingHistory[0].secret, undefined);
  page.resetSession(); assert.equal(page.data.billingHistory.length, 0); assert.equal(page.data.billingReady, false);
});

test('portal and mini program display configured per-million prices and mark missing prices without implying free use', async () => {
  const data = { user: { username: 'client', enabled: true }, billing: accountBilling(), keys: [], models: [
    { id: 'priced-model', pricing: { enabled: true, inputRateMicros: 100001, cachedInputRateMicros: 1, outputRateMicros: 2000000 } }, { id: 'unpriced-model' }] };
  const page = portalHarness(data); await settle();
  assert.match(allText(page.elements.get('models-list')), /每百万 Token：输入 0.100001 元.*缓存 0.000001 元.*输出 2 元/);
  assert.match(allText(page.elements.get('models-list')), /未配置计费价格/);
  assert.match(page.elements.get('models-pricing-note').textContent, /当前只统计 Token，不扣余额/);
  const miniSource = await readFile(new URL('../wechat-miniprogram/pages/index/index.js', import.meta.url), 'utf8');
  let mini;
  vm.runInNewContext(miniSource, { require: () => ({ api() {} }), Page: value => { mini = value; }, getApp: () => ({ globalData: {} }), wx: {} });
  mini.setData = update => Object.assign(mini.data, update); mini._config = { gateway: {} }; mini.render(data);
  assert.match(mini.data.models[0].pricingText, /每百万 Token：输入 0.100001 元.*缓存输入 0.000001 元.*输出 2 元/);
  assert.equal(mini.data.models[1].pricingText, '未配置计费价格');
  assert.match(mini.data.modelPricingNote, /当前只统计 Token，不扣余额/);
});
