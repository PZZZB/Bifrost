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
  modelPresentation: { prefix: kind === 'codex-client' ? '' : 'B', order: kind === 'codex-client' ? 0 : 100,
    defaultPrefix: kind === 'codex-client' ? '' : 'B', defaultOrder: kind === 'codex-client' ? 0 : 100 },
  routes: routes(kind === 'codex-client' ? 'caller' : 'managed'), ...overrides });
const fixture = (overrides = {}) => ({ revision: 7, csrfToken: 'fixture-csrf', capabilities: { clientIntegration: true, userManagement: true, modelPresentation: true },
  accounts: [account('codex-client'), account()], accountTypes: [{ kind: 'codex', label: 'Codex 订阅', canAdd: false, maxAccounts: 1 }],
  models: [{ id: 'gpt-6.1-sol', channel: 'A', sourceAccountId: 'caller-a', originalName: 'GPT-6.1 Sol', name: 'GPT-6.1 Sol', enabled: true, available: true },
    { id: 'B-gpt-6.1-sol', channel: 'B', sourceAccountId: 'managed-b', originalName: 'GPT-6.1 Sol', name: 'B · GPT-6.1 Sol', enabled: true, available: true }], ...overrides });

async function page(value = fixture()) {
  let snapshot = structuredClone(value);
  let nextReadPause = null, nextMutationError = null;
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
    if (path === '/api/upstream-accounts' && options.method !== 'POST') {
      const result = Response.json(snapshot), pause = nextReadPause; nextReadPause = null; if (pause) await pause;
      return result;
    }
    const id = path.startsWith('/api/upstream-accounts/') ? decodeURIComponent(path.slice('/api/upstream-accounts/'.length)) : null;
    if (id && options.method === 'POST') {
      if (nextMutationError) { const result = nextMutationError; nextMutationError = null; return Response.json({ error: { message: result.message } }, { status: result.status }); }
      assert.equal(body.revision, snapshot.revision); assert.equal(options.headers['x-bridge-csrf'], 'fixture-csrf');
      const row = snapshot.accounts.find(row => row.id === id); assert.ok(row, 'only a real account can be mutated');
      if (body.name !== undefined) row.name = body.name;
      if (body.enabled !== undefined) { row.enabled = body.enabled; row.state = row.enabled ? 'ready' : 'disabled'; }
      if (body.modelPresentation !== undefined) row.modelPresentation = { ...row.modelPresentation, ...body.modelPresentation };
      snapshot.revision++; return Response.json(snapshot);
    }
    throw new Error(`Unexpected fixture endpoint: ${path}`);
  };
  vm.runInNewContext(source, { document, window: { addEventListener() {} }, location: { hash: '#accounts' }, fetch,
    setInterval(callback) { intervals.push(callback); }, Intl, Date }, { filename: 'public/account-pool.js' });
  await settle();
  return { nodes, calls, document, refresh: async () => { intervals[0](); await settle(); },
    pauseNextRead: () => { let release; nextReadPause = new Promise(resolve => { release = resolve; }); return release; },
    failNextMutation: result => { nextMutationError = result; }, get snapshot() { return snapshot; } };
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

test('caller A can set a display prefix while its source remains first and stable model IDs are untouched', async () => {
  const p = await page(), detail = p.nodes.get('pool-detail');
  const prefix = p.document.getElementById('pool-model-prefix'), order = p.document.getElementById('pool-model-order');
  assert.equal(prefix.maxLength, 96, 'Allow 48 supplementary Unicode characters; validate codepoints on save.'); assert.equal(prefix.value, '');
  assert.equal(order.disabled, true); assert.match(text(detail), /当前客户端（A）固定排在首组/);
  const ids = p.snapshot.models.map(model => model.id);
  prefix.value = '我的 Codex'; prefix.fire('input');
  const preview = find(detail, node => node.className === 'pool-model-previews');
  assert.equal(preview.children.length, 2);
  assert.match(text(preview), /我的 Codex · GPT-6\.1 Sol/);
  assert.match(text(preview), /模型 ID：gpt-6\.1-sol/);
  assert.match(text(detail), /模型 ID、请求路由和已保存的模型选择保持不变/);
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  const call = p.calls.find(call => call.options.method === 'POST');
  assert.equal(call.path, '/api/upstream-accounts/caller-a');
  assert.deepEqual(call.body, { revision: 7, modelPresentation: { prefix: '我的 Codex', order: 0 } });
  assert.deepEqual(p.snapshot.models.map(model => model.id), ids);
  assert.equal(p.snapshot.accounts[0].name, 'Codex 当前客户端 A');
  assert.match(text(p.nodes.get('pool-message')), /客户端重新读取或同步模型目录后生效/);
});

test('each source previews its original names and can clear its prefix or change order independently of its account name', async () => {
  const data = fixture();
  data.models.push({ id: 'B-gpt-6-astra', channel: 'B', sourceAccountId: 'managed-b', originalName: 'GPT-6 Astra', name: 'B · GPT-6 Astra', enabled: true, available: true });
  const p = await page(data); buttons(p.nodes.get('pool-list'))[1].fire('click');
  let prefix = p.document.getElementById('pool-model-prefix'), order = p.document.getElementById('pool-model-order');
  assert.equal(order.disabled, false); assert.equal(order.min, '0'); assert.equal(order.max, '9999');
  let preview = find(p.nodes.get('pool-detail'), node => node.className === 'pool-model-previews');
  assert.match(text(preview), /B · GPT-6\.1 Sol/); assert.match(text(preview), /B · GPT-6 Astra/);
  assert.doesNotMatch(text(preview), /B · B ·/);
  prefix.value = ''; prefix.fire('input');
  assert.doesNotMatch(text(preview), /B · GPT/);
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  order = p.document.getElementById('pool-model-order'); order.value = '5'; order.fire('input');
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  const calls = p.calls.filter(call => call.options.method === 'POST');
  assert.deepEqual(calls.map(call => call.body), [
    { revision: 7, modelPresentation: { prefix: '', order: 100 } },
    { revision: 8, modelPresentation: { prefix: '', order: 5 } },
  ]);
  assert.equal(p.snapshot.accounts[1].name, 'Codex 员工账号 B');
  assert.equal(p.snapshot.accounts[1].enabled, true);
});

test('model presentation remains unavailable until the backend explicitly advertises support', async () => {
  const data = fixture(); delete data.capabilities.modelPresentation;
  const p = await page(data);
  const section = find(p.nodes.get('pool-detail'), node => node.className === 'pool-model-presentation');
  assert.match(text(section), /请空闲重启网关加载新版后设置/);
  assert.equal(find(section, node => node.tagName === 'INPUT'), undefined);
  assert.equal(buttons(section).length, 0);
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
});

test('saving a remote source prefix sends only presentation metadata and never requests a source restart', async () => {
  const remote = account('bifrost', { id: 'remote-source', name: '家里网关', typeName: 'Bifrost',
    modelPresentation: { prefix: 'Bifröst', order: 500, defaultPrefix: 'Bifröst', defaultOrder: 500 } });
  const p = await page(fixture({ capabilities: { clientIntegration: false, userManagement: true, modelPresentation: true },
    accounts: [remote], restartRequired: true,
    models: [{ id: 'remote/bifrost-fixture/Claude-opus', name: 'Bifröst · Opus', originalName: 'Opus',
      channel: 'Bifrost', sourceAccountId: remote.id, enabled: true, available: true }] }));
  const prefix = p.document.getElementById('pool-model-prefix'); prefix.value = '家里'; prefix.fire('input');
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  const calls = p.calls.filter(call => call.options.method === 'POST');
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/upstream-accounts/remote-source');
  assert.deepEqual(calls[0].body, { revision: 7, modelPresentation: { prefix: '家里', order: 500 } });
  assert.match(text(p.nodes.get('pool-message')), /模型前缀与排序已保存/);
  assert.doesNotMatch(text(p.nodes.get('pool-message')), /重启/);
  assert.equal(p.snapshot.accounts[0].name, '家里网关');
  assert.equal(p.snapshot.models[0].id, 'remote/bifrost-fixture/Claude-opus');
});

test('presentation drafts survive polling and source selection without hiding updates to untouched fields', async () => {
  const p = await page(); buttons(p.nodes.get('pool-list'))[1].fire('click');
  let prefix = p.document.getElementById('pool-model-prefix');
  prefix.value = '团队'; prefix.fire('input'); p.document.activeElement = prefix;
  const before = p.calls.length; await p.refresh(); assert.equal(p.calls.length, before);
  p.document.activeElement = null;
  p.snapshot.accounts[1].modelPresentation = { ...p.snapshot.accounts[1].modelPresentation, prefix: '远端名称', order: 32 };
  p.snapshot.revision++;
  await p.refresh();
  assert.equal(p.document.getElementById('pool-model-prefix').value, '团队');
  assert.equal(p.document.getElementById('pool-model-order').value, '32');
  buttons(p.nodes.get('pool-list'))[0].fire('click'); buttons(p.nodes.get('pool-list'))[1].fire('click');
  assert.equal(p.document.getElementById('pool-model-prefix').value, '团队');
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  assert.deepEqual(p.calls.find(call => call.options.method === 'POST').body,
    { revision: 8, modelPresentation: { prefix: '团队', order: 32 } });
});

test('a read already in flight never replaces the focused editor or silently clears a rejected presentation draft', async () => {
  const p = await page(); buttons(p.nodes.get('pool-list'))[1].fire('click');
  const release = p.pauseNextRead(); await p.refresh();
  const prefix = p.document.getElementById('pool-model-prefix'); prefix.value = '编辑中'; prefix.fire('input'); p.document.activeElement = prefix;
  release(); await settle();
  assert.equal(p.document.getElementById('pool-model-prefix'), prefix);
  assert.equal(prefix.value, '编辑中');
  p.document.activeElement = null;
  p.failNextMutation({ status: 409, message: '账号设置已变化，请刷新后重试。' });
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  assert.equal(p.document.getElementById('pool-model-prefix').value, '编辑中');
  assert.match(text(p.nodes.get('pool-error')), /账号设置已变化/);
});

test('an older poll response arriving after a successful save cannot restore the previous prefix', async () => {
  const p = await page(); buttons(p.nodes.get('pool-list'))[1].fire('click');
  const release = p.pauseNextRead(); await p.refresh();
  const prefix = p.document.getElementById('pool-model-prefix'); prefix.value = '已保存名称'; prefix.fire('input');
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  assert.equal(p.document.getElementById('pool-model-prefix').value, '已保存名称');
  release(); await settle();
  assert.equal(p.document.getElementById('pool-model-prefix').value, '已保存名称');
  assert.equal(p.snapshot.revision, 8);
});

test('presentation validation rejects invalid order and overlong prefixes while previews remain text only', async () => {
  const p = await page(); buttons(p.nodes.get('pool-list'))[1].fire('click');
  const prefix = p.document.getElementById('pool-model-prefix'), order = p.document.getElementById('pool-model-order');
  prefix.value = '<img src=x onerror=alert(1)>'; prefix.fire('input');
  const preview = find(p.nodes.get('pool-detail'), node => node.className === 'pool-model-previews');
  assert.match(text(preview), /<img src=x onerror=alert\(1\)> · GPT-6\.1 Sol/);
  assert.equal(walk(preview).some(node => ['SCRIPT', 'IMG'].includes(node.tagName)), false);
  for (const value of ['', '-1', '1.5', '10000']) {
    order.value = value; order.fire('input'); p.document.getElementById('pool-model-presentation-form').fire('submit');
  }
  order.value = '5'; prefix.value = '前'.repeat(49); prefix.fire('input');
  p.document.getElementById('pool-model-presentation-form').fire('submit'); await settle();
  assert.equal(p.calls.some(call => call.options.method === 'POST'), false);
  assert.match(text(p.nodes.get('pool-error')), /0–9999 的整数/);
});
