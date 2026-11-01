import { randomUUID } from 'node:crypto';
import { BridgeError } from './storage.mjs';
import { LEGACY_SLOTS, upstreamName } from './upstream-account-store.mjs';
import { BifrostRemote } from './providers/bifrost-remote.mjs';
import { configureServerRemote } from './runtime/server-remotes-config.mjs';

const TYPES = Object.freeze({
  codex: { label: 'Codex 订阅', authorization: '本机独立订阅登录', maxAccounts: 1, editor: 'codex' },
  codebuddy: { label: 'CodeBuddy 员工账号', authorization: '本机官方员工授权', maxAccounts: 1, editor: 'codebuddy' },
  cursor: { label: 'Cursor 账号', authorization: '本机官方账号授权', maxAccounts: 1, editor: 'cursor' },
  claude: { label: 'Claude 隔离账号', authorization: '隔离环境内授权', maxAccounts: 1, managed: true },
  with: { label: 'With 兼容来源', authorization: '受管理的 With 环境', maxAccounts: 1, managed: true, editor: 'with' },
  bifrost: { label: 'Bifröst 用户账号', authorization: '用户 API 与个人 Key', maxAccounts: 8, restartRequired: true },
});
const notFound = () => new BridgeError('当前网关未登记该账号。', 404, 'upstream_account_not_found');

// Preserve live authorization getters; spreading a service freezes its epoch.
export const gatedAccountService = (service, isEnabled) => service && Object.create(service, {
  enabled: { get: () => service.enabled === true && isEnabled() === true },
});

/** Management of upstream instances. No downstream identity or money is owned here. */
export class UpstreamAccounts {
  constructor({ store, types, readers = {}, getModels = () => [], getRemotes = () => null,
    capabilities = () => ({}), modelPolicy, refreshModels = async () => {}, configureRemote = configureServerRemote,
    remoteFetch = fetch, onChange = async () => {} }) {
    if (!store || !Array.isArray(types) || types.some(k => !Object.hasOwn(TYPES, k))) throw new TypeError('Invalid upstream account adapters.');
    Object.assign(this, { store, kinds: [...new Set(types)], readers, getModels, getRemotes, capabilities, modelPolicy, refreshModels, configureRemote, remoteFetch, onChange });
  }
  rows() { return this.store.snapshot().accounts.filter(a => this.kinds.includes(a.kind)); }
  accountFor(channel, model) {
    if (channel === 'Bifrost') {
      const id = this.getRemotes()?.model(model)?.source?.id;
      return this.rows().find(a => a.kind === 'bifrost' && a.binding.sourceId === id) ?? null;
    }
    if (!Object.values(LEGACY_SLOTS).includes(channel)) return null;
    return this.rows().find(a => a.binding.slot === channel) ?? null;
  }
  allows(channel, model) { return channel === 'A' || this.accountFor(channel, model)?.enabled === true; }
  sourceId(channel, model) { return this.accountFor(channel, model)?.id ?? null; }
  catalog() {
    return this.getModels().flatMap(model => {
      const account = this.accountFor(model.channel, model.id), allowed = model.channel === 'A' || account?.enabled === true;
      if (!account && model.channel !== 'A') return [];
      return { ...model, enabled: model.enabled !== false, available: model.available !== false && allowed,
        ...(!allowed ? { reason: '所属上游账号已停用或尚未就绪。' } : {}),
        sourceAccountId: account?.id ?? null, sourceAccountName: account?.name ?? (model.channel === 'A' ? '当前客户端' : '来源未就绪') };
    });
  }
  async modelSettings() {
    await this.refreshModels();
    const snapshot = this.modelPolicy.snapshot();
    return { ...snapshot, models: this.catalog() };
  }
  async snapshot() {
    const models = this.catalog(), remotes = this.getRemotes();
    const accounts = await Promise.all(this.rows().map(async row => {
      let metadata = {};
      if (row.enabled) {
        try { metadata = row.kind === 'bifrost' ? remotes?.status().find(s => s.id === row.binding.sourceId) ?? {}
          : await this.readers[row.kind]?.(); }
        catch { metadata = { ready: false, unavailable: true }; }
      }
      const owned = models.filter(m => m.sourceAccountId === row.id);
      const ready = row.enabled && (row.kind === 'bifrost' ? metadata?.available === true
        : metadata?.ready === true || metadata?.provider?.ready === true || metadata?.authReady === true || metadata?.bound === true);
      const connected = row.enabled && (metadata?.authenticated === true || metadata?.provider?.authenticated === true || metadata?.authReady === true || metadata?.authenticated === null && ready);
      return { id: row.id, kind: row.kind, name: row.name, enabled: row.enabled, typeName: TYPES[row.kind].label,
        authorization: TYPES[row.kind].authorization, editor: TYPES[row.kind].editor ?? null, managed: TYPES[row.kind].managed === true,
        state: !row.enabled ? 'disabled' : (row.kind === 'bifrost' ? !metadata?.state || metadata.state === 'closed' : metadata == null || metadata.configured === false) ? 'activation_required'
          : ready ? 'ready' : connected ? 'not_ready' : 'authorization_required',
        modelCount: owned.length, publishedModelCount: owned.filter(m => m.enabled && m.available).length,
        quota: { status: 'unknown', label: row.kind === 'bifrost' ? '远端用户额度，以远端账本为准' : '上游未提供可靠余额' },
        restartRequired: row.enabled && (row.kind === 'bifrost' ? !metadata?.state || metadata.state === 'closed' : metadata == null || metadata.configured === false),
        ...(row.kind === 'bifrost' ? { endpoint: row.binding.baseUrl } : {}) };
    }));
    return { version: 1, revision: this.store.snapshot().revision, capabilities: this.capabilities(),
      accountTypes: this.kinds.map(kind => ({ kind, ...TYPES[kind], count: accounts.filter(a => a.kind === kind).length,
        canAdd: TYPES[kind].managed !== true && accounts.filter(a => a.kind === kind).length < TYPES[kind].maxAccounts })),
      accounts, models };
  }
  async ensureLegacy(kind) {
    if (!this.kinds.includes(kind) || !Object.hasOwn(LEGACY_SLOTS, kind)) throw new BridgeError('当前网关未启用该账号适配器。', 403);
    if (!this.rows().some(a => a.kind === kind)) await this.store.addLegacy(kind, TYPES[kind].label);
  }
  async create(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['kind', 'name', 'baseUrl', 'apiKey'].includes(k))) throw new BridgeError('账号创建参数无效。', 400);
    const type = this.kinds.includes(body.kind) && TYPES[body.kind];
    if (!type || type.managed) throw new BridgeError('此账号类型需由所属受控环境接入。', 400, 'upstream_type_unavailable');
    if (this.rows().filter(a => a.kind === body.kind).length >= type.maxAccounts) throw new BridgeError('当前账号类型已达到实例上限。', 409, 'upstream_account_capacity');
    const name = upstreamName(body.name);
    if (body.kind !== 'bifrost') {
      if (body.baseUrl !== undefined || body.apiKey !== undefined) throw new BridgeError('此类型只能使用自己的官方授权流程。', 400);
      await this.store.addLegacy(body.kind, name);
    } else {
      const id = `bifrost-${randomUUID().slice(0, 8)}`;
      const probe = new BifrostRemote({ id, baseUrl: body.baseUrl, apiKey: body.apiKey, fetchImpl: this.remoteFetch });
      let available = false;
      try { await probe.refreshCatalog(); available = probe.catalogSnapshot().length > 0; } finally { await probe.close(); }
      if (!available) throw new BridgeError('未取得远端用户的可用模型，请核对地址、Key 与权限。', 400, 'upstream_remote_unavailable');
      await this.configureRemote({ stateDir: this.store.directory, id, name, baseUrl: body.baseUrl, apiKey: body.apiKey });
      await this.store.reload();
    }
    await this.onChange();
    return { ...(await this.snapshot()), restartRequired: true };
  }
  async update(id, body) {
    const previous = this.rows().find(a => a.id === id); if (!previous) throw notFound();
    await this.store.update(id, body);
    const row = this.rows().find(a => a.id === id);
    if (previous.enabled && !row.enabled && row.kind === 'bifrost') {
      try { await this.getRemotes()?.stopSource(row.binding.sourceId); }
      catch (e) { if (e.code !== 'desktop_source_not_found') throw new BridgeError('停用已保存，新请求已停止；请空闲重启以回收来源资源。', 503); }
    }
    await this.onChange();
    return { ...(await this.snapshot()), restartRequired: row.kind === 'bifrost' && row.enabled && !previous.enabled };
  }
}
