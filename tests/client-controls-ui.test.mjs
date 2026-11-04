import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/client-controls.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve)); };
class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(target) { return this === target || this.children.some(child => child instanceof Element && child.contains(target)); }
  fire(type) { if (!this.disabled) this.listeners.get(type)?.({ preventDefault() {} }); }
}
const walk = node => [node, ...node.children.flatMap(child => child instanceof Element ? walk(child) : [])];
const text = node => [node.textContent, ...node.children.map(child => child instanceof Element ? text(child) : String(child))].filter(Boolean).join(' ');
const find = (node, predicate) => walk(node).find(predicate);
const client = (id, overrides = {}) => ({ id, name: { codex: 'Codex', codebuddy: 'CodeBuddy', workbuddy: 'WorkBuddy', cursor: 'Cursor', claude: 'Claude' }[id],
  installed: true, mode: 'gateway', modeLabel: '网关模式', protocol: id === 'codex' ? 'responses' : 'chat-completions',
  supports: { launch: true, mode: true, sync: true, autoSync: true }, autoSync: true,
  modelCount: 2, latestModelCount: 3, lastSyncAt: '2026-11-01T10:00:00.000Z', syncState: 'pending',
  reloadNote: id === 'codex' ? '请完全退出并重新打开 Codex，模型菜单由客户端重新加载。' : '请在客户端重新读取模型目录后选择模型。', reason: null, ...overrides });
const fixture = () => ({ version: 1, csrfToken: 'csrf-initial', autoSyncDefault: true, clients: [client('codex'), client('codebuddy'), client('workbuddy'),
  client('cursor', { mode: 'native', modeLabel: '原生模式', syncState: 'native', supports: { launch: true, mode: false, sync: false, autoSync: false },
    reason: 'Cursor 当前只作为上游额度来源，接入网关尚未适配。' }),
  client('claude', { installed: false, mode: 'manual', modeLabel: '手动配置', syncState: 'unavailable', supports: { launch: false, mode: false, sync: false, autoSync: false },
    reason: '宿主机未安装 Claude，不控制虚拟机中的客户端。' })] });

async function page({ value = fixture(), onRequest = null, mounted = true } = {}) {
  let snapshot = structuredClone(value);
  const panel = new Element('section'), unrelated = new Element('section'); unrelated.textContent = 'existing integration controls';
  const calls = [], intervals = [], events = new Map(), windowEvents = new Map();
  const document = { hidden: false, activeElement: null, getElementById: id => id === 'client-controls-panel' && mounted ? panel : null,
    createElement: tag => new Element(tag), addEventListener: (name, listener) => events.set(name, listener) };
  const api = { panel, unrelated, calls, document, intervals, events, windowEvents,
    get snapshot() { return snapshot; }, set snapshot(value) { snapshot = structuredClone(value); },
    card: id => find(panel, node => node.getAttribute('data-client-id') === id),
    action(id, operation) { return find(this.card(id), node => node.getAttribute('data-client-action') === operation); },
    async click(id, operation) { this.action(id, operation).fire(operation === 'settings' ? 'change' : 'click'); await settle(); },
    async poll() { intervals[0]?.(); await settle(); } };
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null, call = { path, options, body }; calls.push(call);
    const override = await onRequest?.(call, api); if (override !== undefined) return override;
    if (path === '/api/client-controls' && options.method !== 'POST') return Response.json(snapshot);
    const match = /^\/api\/client-controls\/([a-z]+)\/(launch|mode|sync|settings)$/.exec(path);
    if (match && options.method === 'POST') {
      const [, id, operation] = match, row = snapshot.clients.find(client => client.id === id); assert.ok(row);
      assert.equal(options.headers['x-bridge-csrf'], snapshot.csrfToken);
      if (operation === 'mode') { row.mode = body.mode; row.modeLabel = body.mode === 'gateway' ? '网关模式' : '原生模式'; row.syncState = body.mode === 'gateway' ? 'pending' : 'native'; }
      if (operation === 'settings') row.autoSync = body.autoSync;
      if (operation === 'sync') { row.modelCount = row.latestModelCount; row.syncState = 'current'; }
      return Response.json(snapshot);
    }
    throw new Error(`Unexpected endpoint: ${path}`);
  };
  vm.runInNewContext(source, { document, window: { addEventListener: (name, listener) => windowEvents.set(name, listener) },
    location: { hash: '#connections' }, fetch, AbortSignal, Date, Intl,
    setInterval(callback, milliseconds) { intervals.push(callback); assert.equal(milliseconds, 15000); } }, { filename: 'public/client-controls.js' });
  await settle(); return api;
}

test('initial rendering only reads state, preserves other controls, and gates each installed client operation separately', async () => {
  const p = await page();
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].path, '/api/client-controls');
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
  assert.equal(p.unrelated.textContent, 'existing integration controls');
  assert.equal(p.action('codex', 'launch').disabled, false); assert.equal(p.action('codex', 'mode').disabled, false);
  assert.equal(p.action('cursor', 'launch').disabled, false); assert.equal(p.action('cursor', 'mode').disabled, true);
  assert.equal(p.action('claude', 'launch').disabled, true); assert.equal(p.action('claude', 'settings').disabled, true);
  assert.match(text(p.card('cursor')), /上游额度来源.*尚未适配/);
  assert.match(text(p.card('claude')), /不控制虚拟机/);
  assert.match(text(p.card('codex')), /完全退出并重新打开 Codex/);
});

test('CodeBuddy mode switching posts explicit mode and preserves the original-model coexistence explanation', async () => {
  const p = await page(); await p.click('codebuddy', 'mode');
  const writes = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/client-controls/codebuddy/mode');
  assert.deepEqual(writes[0].body, { mode: 'native' });
  assert.match(text(p.card('codebuddy')), /原模型仍保留.*当前会话需在客户端选择模型/);
  assert.equal(p.action('codebuddy', 'mode').textContent, '启用网关');
  assert.equal(p.action('codebuddy', 'sync').disabled, true);
  await p.click('codebuddy', 'mode');
  assert.deepEqual(p.calls.filter(call => call.options.method === 'POST').at(-1).body, { mode: 'gateway' });
});

test('upgrading an existing Codex gateway is a distinct explicit action from restoring native mode', async () => {
  const value = fixture(); value.clients[0].modeUpdateRequired = true;
  const p = await page({ value });
  assert.equal(p.action('codex', 'mode').textContent, '恢复原生');
  const upgrade = find(p.card('codex'), node => node.textContent === '更新网关连接');
  assert.ok(upgrade); upgrade.fire('click'); await settle();
  const writes = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/client-controls/codex/mode');
  assert.deepEqual(writes[0].body, { mode: 'gateway' });
});

test('a legacy native selection offers a native connection update without turning the gateway on', async () => {
  const value = fixture(); Object.assign(value.clients[0], { mode: 'native', modeUpdateRequired: true });
  const p = await page({ value });
  const upgrade = find(p.card('codex'), node => node.textContent === '更新原生连接');
  assert.ok(upgrade); upgrade.fire('click'); await settle();
  const writes = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { mode: 'native' });
});

test('automatic sync defaults on, persists an explicit opt-out, and does not imply client menus updated in place', async () => {
  const data = fixture(); delete data.clients[0].autoSync;
  const p = await page({ value: data }); assert.equal(p.action('codex', 'settings').checked, true);
  p.action('codex', 'settings').checked = false; await p.click('codex', 'settings');
  const saved = p.calls.find(call => call.path === '/api/client-controls/codex/settings');
  assert.deepEqual(saved.body, { autoSync: false }); assert.equal(p.action('codex', 'settings').checked, false);
  await p.click('codex', 'sync');
  assert.equal(p.snapshot.clients[0].modelCount, 3); assert.match(text(p.card('codex')), /目录已同步/);
  assert.match(text(p.card('codex')), /模型菜单由客户端重新加载/);
});

test('each operation re-reads the current service CSRF token and supports before issuing its one write', async () => {
  let reads = 0;
  const p = await page({ onRequest(call, api) { if (call.path === '/api/client-controls') {
    const value = api.snapshot; value.csrfToken = `csrf-service-${++reads}`; api.snapshot = value;
  } } });
  await p.poll(); await p.click('workbuddy', 'launch');
  const write = p.calls.find(call => call.options.method === 'POST'); assert.equal(write.options.headers['x-bridge-csrf'], 'csrf-service-3');
  assert.deepEqual(write.body, {}); assert.equal(write.path, '/api/client-controls/workbuddy/launch');
  assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a refreshed unsupported capability prevents a stale button from writing', async () => {
  let reads = 0;
  const p = await page({ onRequest(call, api) { if (call.path === '/api/client-controls' && ++reads > 1) {
    const data = api.snapshot; data.clients[0].supports.mode = false; data.clients[0].reason = '配置发生冲突，请先处理现有修改。'; api.snapshot = data;
  } } });
  await p.click('codex', 'mode');
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
  assert.match(text(p.panel), /配置发生冲突/); assert.equal(p.action('codex', 'mode').disabled, true);
});

test('older server errors give a pending-update explanation without affecting the rest of the page', async () => {
  for (const status of [404, 503]) {
    const p = await page({ onRequest: () => Response.json({ error: { message: 'old backend' } }, { status }) });
    assert.match(text(p.panel), /空闲重启网关加载新版/); assert.equal(p.calls.length, 1);
    assert.equal(p.unrelated.textContent, 'existing integration controls');
    assert.equal(walk(p.panel).filter(node => node.getAttribute('data-client-id')).length, 0);
  }
  const absent = await page({ mounted: false }); assert.equal(absent.calls.length, 0);
});

test('failed writes are read back once and never automatically replayed', async () => {
  const p = await page({ onRequest(call) { if (call.options.method === 'POST') return Response.json({ error: { message: '模式保存被拒绝。' } }, { status: 409 }); } });
  await p.click('codex', 'mode');
  assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(p.calls.filter(call => call.path === '/api/client-controls').length, 3);
  assert.match(text(p.panel), /模式保存被拒绝/); assert.equal(p.snapshot.clients[0].mode, 'gateway');
});

test('polling pauses while focused or a command is pending, and client data stays plain text', async () => {
  const data = fixture(); data.clients[0].name = '<img src=x onerror=alert(1)>';
  let finish;
  const p = await page({ value: data, onRequest(call) { if (call.options.method === 'POST') return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(walk(p.panel).some(node => node.tagName === 'IMG'), false);
  p.document.activeElement = p.action('codex', 'settings'); const before = p.calls.length; await p.poll(); assert.equal(p.calls.length, before);
  p.document.activeElement = null; p.action('codex', 'launch').fire('click'); await settle();
  assert.equal(p.action('workbuddy', 'mode').disabled, true); const active = p.calls.length; await p.poll(); assert.equal(p.calls.length, active);
  finish(Response.json(p.snapshot)); await settle(); assert.equal(p.action('workbuddy', 'mode').disabled, false);
});
