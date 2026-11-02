import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sourceCredential, sourceRoutes } from '../src/source-profiles.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/account-pool.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.textContent = ''; this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(target) { return this === target || this.children.some(child => child instanceof Element && child.contains(target)); }
  fire(type) { if (type !== 'click' || !this.disabled) this.listeners.get(type)?.({ preventDefault() {} }); }
  reset() { this.value = ''; }
  focus() {}
  scrollIntoView() {}
}
const walk = node => [node, ...node.children.flatMap(child => child instanceof Element ? walk(child) : [])];
const text = node => [node.textContent, ...node.children.map(child => child instanceof Element ? text(child) : String(child))].filter(Boolean).join(' ');
const find = (node, predicate) => walk(node).find(predicate);
const buttons = node => walk(node).filter(child => child.tagName === 'BUTTON');

const routes = (kind, { available = true } = {}) => ['responses', 'chat-completions', 'messages'].map(protocol => {
  const supported = kind === 'caller' ? protocol === 'responses' : protocol !== 'messages';
  return { protocol, label: { responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages' }[protocol],
    supported, available: supported && available, mode: !supported ? 'unsupported' : protocol === 'responses' ? 'passthrough' : 'adapted',
    modeLabel: !supported ? '尚未支持' : protocol === 'responses' ? '原生转发' : '协议转换', upstreamProtocol: 'responses',
    description: !supported ? '当前入口尚未适配。' : protocol === 'responses' ? '使用同一套 Responses 协议。' : '将 Chat 请求与响应转换为 Responses。',
    reason: !supported ? '当前入口尚未适配。' : null, verification: 'not_verified' };
});
const account = (kind = 'codex', overrides = {}) => ({ id: kind === 'codex-client' ? 'caller-a' : 'managed-b', kind,
  name: kind === 'codex-client' ? 'Codex 当前客户端 A' : 'Codex 员工账号 B', typeName: 'Codex', enabled: true,
  state: kind === 'codex-client' ? 'caller_required' : 'ready', modelCount: 1, publishedModelCount: 1,
  editor: null, managed: false, authorization: '授权位置', quota: { status: 'unknown', label: '未返回可靠余额' },
  credential: { mode: kind === 'codex-client' ? 'caller' : 'managed', label: kind === 'codex-client' ? '当前客户端身份透传' : '网关独立授权',
    reusable: kind !== 'codex-client', description: kind === 'codex-client' ? '使用本次请求携带的 OpenAI 认证。' : '由网关维护独立账号授权。' },
  routes: routes(kind === 'codex-client' ? 'caller' : 'managed'), ...overrides });
const fixture = (overrides = {}) => ({ revision: 7, csrfToken: 'fixture-csrf', capabilities: { clientIntegration: true, userManagement: true },
  accounts: [account('codex-client'), account()], accountTypes: [{ kind: 'codex', label: 'Codex 订阅', canAdd: false, maxAccounts: 1 }],
  models: [{ id: 'gpt-6.1-sol', channel: 'A', enabled: true, available: true }, { id: 'B-gpt-6.1-sol', channel: 'B', enabled: true, available: true }], ...overrides });

async function page(value = fixture()) {
  let snapshot = structuredClone(value);
  const nodes = new Map([...html.matchAll(/<([A-Za-z][A-Za-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, tag, attributes, id]) => {
    const node = new Element(tag); node.id = id; node.hidden = /\bhidden\b/.test(attributes); return [id, node];
  }));
  if (!nodes.has('pool-route-preview')) nodes.set('pool-route-preview', new Element('section'));
  const calls = [], intervals = [];
  const document = { hidden: false, activeElement: null, createElement: tag => new Element(tag), addEventListener() {},
    getElementById(id) { return nodes.get(id) ?? [...nodes.values()].flatMap(walk).find(node => node.id === id) ?? null; },
    querySelectorAll() { return []; } };
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ path, options, body });
    if (path === '/api/model-settings') return Response.json({});
    if (path === '/api/upstream-accounts' && options.method !== 'POST') return Response.json(snapshot);
    const id = path.startsWith('/api/upstream-accounts/') ? decodeURIComponent(path.slice('/api/upstream-accounts/'.length)) : null;
    if (id && options.method === 'POST') {
      assert.equal(body.revision, snapshot.revision); assert.equal(options.headers['x-bridge-csrf'], 'fixture-csrf');
      const row = snapshot.accounts.find(row => row.id === id); assert.ok(row, 'only a real account can be mutated');
      if (body.name !== undefined) row.name = body.name;
      if (body.enabled !== undefined) { row.enabled = body.enabled; row.state = row.enabled ? 'ready' : 'disabled'; }
      snapshot.revision++; return Response.json(snapshot);
    }
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  vm.runInNewContext(source, { document, window: { addEventListener() {} }, location: { hash: '#accounts' }, fetch,
    setInterval(callback) { intervals.push(callback); }, Intl, Date }, { filename: 'public/account-pool.js' });
  await settle();
  return { nodes, calls, document, refresh: async () => { intervals[0](); await settle(); }, get snapshot() { return snapshot; } };
}

test('account pool distinguishes caller A from independently authorized B without manufacturing reusable A credentials', async () => {
  const p = await page();
  assert.equal(buttons(p.nodes.get('pool-list')).length, 2);
  assert.match(text(p.nodes.get('pool-list')), /当前客户端身份透传/);
  assert.match(text(p.nodes.get('pool-list')), /网关独立授权/);
  assert.match(text(p.nodes.get('pool-detail')), /仅持有网关 Key 的其他客户端不能复用此身份/);
  assert.match(text(p.nodes.get('pool-detail')), /授权方式/);
  assert.equal(buttons(p.nodes.get('pool-detail')).some(node => node.textContent === '管理授权'), false);
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
});

test('read-only path preview selects by protocol and source without changing any gateway or client settings', async () => {
  const p = await page(), panel = p.nodes.get('pool-route-preview');
  assert.match(text(panel), /Responses.*原生转发/);
  let sourceSelect = p.document.getElementById('pool-route-source'); sourceSelect.value = 'managed-b'; sourceSelect.fire('change');
  let protocolSelect = p.document.getElementById('pool-route-client'); protocolSelect.value = 'chat-completions'; protocolSelect.fire('change');
  assert.match(text(panel), /网关独立授权/);
  assert.match(text(panel), /Chat Completions.*协议转换/);
  assert.match(text(panel), /上游接口：Responses/);
  assert.match(text(panel), /客户端验收：未确认/);
  protocolSelect = p.document.getElementById('pool-route-client'); protocolSelect.value = 'messages'; protocolSelect.fire('change');
  assert.match(text(panel), /尚未支持.*当前入口尚未适配/);
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
  p.document.activeElement = p.document.getElementById('pool-route-source');
  const before = p.calls.length; await p.refresh(); assert.equal(p.calls.length, before);
  p.document.activeElement = null;
  await p.refresh();
  assert.equal(p.document.getElementById('pool-route-client').value, 'messages');
  assert.equal(p.document.getElementById('pool-route-source').value, 'managed-b');
});

test('implemented but unavailable paths remain distinct from unsupported interfaces and never claim client acceptance', async () => {
  const p = await page(fixture({ accounts: [account('codex', { state: 'disabled', enabled: false, routes: routes('managed', { available: false }) })] }));
  buttons(p.nodes.get('pool-list')).at(-1).fire('click');
  assert.match(text(p.nodes.get('pool-detail')), /协议路径已提供，当前来源尚不可用/);
  assert.match(text(p.nodes.get('pool-detail')), /客户端验收：未确认/);
  const routesNode = find(p.nodes.get('pool-detail'), node => node.className === 'pool-routes');
  routesNode.open = true; routesNode.fire('toggle'); await p.refresh();
  assert.equal(find(p.nodes.get('pool-detail'), node => node.className === 'pool-routes').open, true);
});

test('old servers get a read-only caller source and explicit pending protocol metadata instead of a fake mutable account', async () => {
  const managed = account(); delete managed.credential; delete managed.routes;
  const p = await page(fixture({ accounts: [managed] }));
  assert.equal(buttons(p.nodes.get('pool-list')).length, 2);
  assert.match(text(p.nodes.get('pool-detail')), /只读展示/);
  assert.match(text(p.nodes.get('pool-detail')), /尚未返回协议路径/);
  assert.equal(buttons(p.nodes.get('pool-detail')).length, 0);
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
  buttons(p.nodes.get('pool-list'))[1].fire('click');
  const toggle = buttons(p.nodes.get('pool-detail')).find(node => node.textContent === '停用账号'); toggle.fire('click'); await settle();
  assert.equal(p.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(p.calls.find(call => call.options.method === 'POST').path, '/api/upstream-accounts/managed-b');
});

test('an isolated node never invents a Codex caller source and source content remains plain text', async () => {
  const managed = account('claude', { id: 'claude', name: '<img src=x onerror=alert(1)>', typeName: '隔离 Claude',
    credential: { mode: 'managed', label: '隔离环境授权', description: 'CLI 所在环境登录。' }, routes: [{
      protocol: 'messages', supported: true, available: true, mode: 'cli', modeLabel: 'CLI 适配', upstreamProtocol: 'cli',
      description: '<script>not executable</script>', verification: 'not_verified' }] });
  const p = await page(fixture({ capabilities: { clientIntegration: false, userManagement: true }, accounts: [managed] }));
  assert.equal(buttons(p.nodes.get('pool-list')).length, 1);
  assert.match(text(p.nodes.get('pool-detail')), /CLI 适配/);
  assert.match(text(p.nodes.get('pool-detail')), /<script>not executable<\/script>/);
  assert.equal(walk(p.nodes.get('pool-detail')).some(node => ['SCRIPT', 'IMG'].includes(node.tagName)), false);
});

test('real source profiles render Claude CLI protocol labels without assuming HTTP passthrough', async () => {
  const row = { id: 'claude-live-contract', kind: 'claude', name: 'Claude CLI', enabled: true };
  const managed = account('claude', { ...row, credential: sourceCredential('claude'),
    routes: sourceRoutes(row, { metadata: { transport: 'claude-cli', supportedProtocols: ['messages', 'chat-completions'] },
      usable: true, capabilities: { userManagement: true } }) });
  const p = await page(fixture({ capabilities: { clientIntegration: false, userManagement: true }, accounts: [managed] }));
  const messages = find(p.nodes.get('pool-detail'), node => node.getAttribute('data-pool-protocol') === 'messages');
  assert.match(text(messages), /CLI 会话适配/);
  assert.match(text(messages), /上游接口：Claude CLI/);
  assert.doesNotMatch(text(messages), /原生协议转发|上游接口：claude-cli/);
});
