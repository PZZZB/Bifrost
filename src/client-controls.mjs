import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError, readJson, writeJson, redact } from './storage.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const bad = () => new BridgeError('客户端管理状态无效，已保留现有配置。', 503, 'client_controls_invalid');
const empty = value => object(value) && !Object.keys(value).length;
const fresh = () => ({ autoSync: true, lastSyncAt: null, lastRevision: null, modelCount: 0, lastError: null });
function validate(value) {
  if (!object(value) || value.version !== 1 || !object(value.clients) || Object.keys(value).some(key => !['version', 'clients'].includes(key))) throw bad();
  for (const [id, row] of Object.entries(value.clients)) {
    if (!idPattern.test(id) || !object(row) || typeof row.autoSync !== 'boolean'
      || Object.keys(row).some(key => !Object.hasOwn(fresh(), key))
      || row.lastSyncAt !== null && !Number.isFinite(Date.parse(row.lastSyncAt))
      || row.lastRevision !== null && !/^[a-f0-9]{64}$/.test(row.lastRevision)
      || !Number.isSafeInteger(row.modelCount) || row.modelCount < 0
      || row.lastError !== null && (typeof row.lastError !== 'string' || row.lastError.length > 1200)) throw bad();
  }
  return value;
}
const revision = models => createHash('sha256').update(JSON.stringify(models.map(model => ({ id: model.id,
  name: model.name, protocols: model.protocols, capabilities: model.capabilities })))).digest('hex');

/** Local application controls do not own upstream credentials or choose inference providers. */
export class ClientControls {
  #queue = Promise.resolve(); #closed = false; #active = 0;
  constructor({ path, adapters, apps, getModels, refreshModels = async () => {}, read = readJson, write = writeJson, now = Date.now }) {
    if (typeof path !== 'string' || !Array.isArray(adapters) || typeof apps?.snapshot !== 'function'
      || typeof apps?.launch !== 'function' || typeof getModels !== 'function' || typeof refreshModels !== 'function') throw new TypeError('Invalid local client controls.');
    const ids = new Set();
    for (const adapter of adapters) {
      if (!idPattern.test(adapter?.id) || ids.has(adapter.id) || typeof adapter.name !== 'string' || typeof adapter.inspect !== 'function') throw new TypeError('Invalid client control adapter.');
      ids.add(adapter.id);
    }
    Object.assign(this, { path, adapters, apps, getModels, refreshModels, read, write, now });
    this.state = { version: 1, clients: {} };
  }
  static async open(options) {
    const controls = new ClientControls(options);
    controls.state = validate(await controls.read(controls.path, { version: 1, clients: {} }));
    return controls;
  }
  get activeOperations() { return this.#active; }
  #serial(operation) {
    const pending = this.#queue.then(async () => {
      if (this.#closed) throw new BridgeError('客户端管理已停止。', 503, 'client_controls_closed');
      this.#active++;
      try { return await operation(); } finally { this.#active--; }
    });
    this.#queue = pending.catch(() => {}); return pending;
  }
  #adapter(id) {
    const adapter = this.adapters.find(row => row.id === id);
    if (!adapter) throw new BridgeError('客户端尚未登记。', 404, 'client_control_not_found');
    return adapter;
  }
  #models(adapter, catalog) {
    if (!adapter.protocol) return [];
    return catalog.filter(model => model && typeof model.id === 'string' && model.enabled !== false && model.available !== false
      && (adapter.id === 'codex' || model.channel !== 'A')
      && (!adapter.protocol || Array.isArray(model.protocols) && model.protocols.includes(adapter.protocol)));
  }
  async #catalog() {
    const models = await this.getModels();
    if (!Array.isArray(models) || models.length > 8192) throw bad();
    return models;
  }
  async #save(id, changes) {
    const next = structuredClone(this.state);
    next.clients[id] = { ...(next.clients[id] ?? fresh()), ...changes };
    if (isDeepStrictEqual(next, this.state)) return;
    validate(next); await this.write(this.path, next); this.state = next;
  }
  async #inspect(adapter) {
    try { return await adapter.inspect(); }
    catch (error) { return { mode: 'unknown', reason: redact(error.message), configured: false }; }
  }
  async #snapshot() {
    let catalogAvailable = true;
    const [catalog, installed] = await Promise.all([
      this.#catalog().catch(() => { catalogAvailable = false; return []; }),
      this.apps.snapshot().catch(() => []),
    ]);
    const clients = await Promise.all(this.adapters.map(async adapter => {
      const current = await this.#inspect(adapter), saved = this.state.clients[adapter.id] ?? fresh();
      const app = installed.find(row => row.id === adapter.id), models = this.#models(adapter, catalog);
      const supported = typeof adapter.sync === 'function';
      const mode = ['native', 'gateway', 'conflict', 'manual'].includes(current.mode) ? current.mode : 'unknown';
      const modeLabel = mode === 'gateway' ? adapter.id === 'codex' ? 'Bifröst 网关' : '网关模型已加入'
        : mode === 'native' ? '原生模式' : mode === 'conflict' ? '配置存在冲突' : '手动配置';
      const syncState = mode === 'native' ? 'native' : mode === 'conflict' ? 'conflict'
        : !catalogAvailable ? 'unavailable'
        : mode !== 'gateway' || !supported ? 'unavailable' : saved.lastError ? 'conflict'
          : saved.lastRevision === revision(models) ? 'current' : 'pending';
      return { id: adapter.id, name: adapter.name, protocol: adapter.protocol ?? null,
        installed: app?.installed === true, mode, modeLabel,
        supports: { launch: app?.installed === true && app.launchSupported !== false,
          mode: typeof adapter.setMode === 'function', sync: supported, autoSync: supported },
        autoSync: saved.autoSync, modelCount: supported ? current.modelCount ?? current.managedModelCount ?? saved.modelCount : null,
        latestModelCount: catalogAvailable && supported ? models.length : null, lastSyncAt: saved.lastSyncAt, syncState,
        reloadNote: current.reloadNote || (adapter.id === 'codex'
          ? 'Codex 按模型目录地址读取更新；当前窗口请刷新模型列表，或完全退出后重开。'
          : supported ? '已同步表示配置已写入；模型列表是否已重载，以客户端实际显示为准。' : null),
        reason: saved.lastError || current.reason || (!catalogAvailable ? '模型目录暂不可读取；仍可恢复原生或启动应用。'
          : !app?.installed ? app?.reason || '本机未检测到此客户端；远端客户端需在所在电脑管理。' : null) };
    }));
    return { version: 1, autoSyncDefault: true, catalogAvailable, checkedAt: new Date(this.now()).toISOString(), clients };
  }
  snapshot() { return this.#serial(() => this.#snapshot()); }
  async #sync(adapter, catalog) {
    if (typeof adapter.sync !== 'function') throw new BridgeError('该客户端尚未提供目录同步适配。', 409, 'client_sync_unsupported');
    const current = await adapter.inspect();
    if (current.mode !== 'gateway') throw new BridgeError('请先启用该客户端的 Bifröst 网关，再同步目录。', 409, 'client_not_gateway');
    const models = this.#models(adapter, catalog);
    await adapter.sync(models);
    await this.#save(adapter.id, { lastSyncAt: new Date(this.now()).toISOString(), lastRevision: revision(models),
      modelCount: models.length, lastError: null });
  }
  mutate(id, action, body) {
    return this.#serial(async () => {
      const adapter = this.#adapter(id);
      if (action === 'settings') {
        if (!object(body) || Object.keys(body).length !== 1 || typeof body.autoSync !== 'boolean'
          || typeof adapter.sync !== 'function') throw new BridgeError('自动同步设置无效。', 400, 'client_control_invalid');
        await this.#save(id, { autoSync: body.autoSync });
      } else if (action === 'launch') {
        if (!empty(body)) throw new BridgeError('启动操作只接受空对象。', 400, 'client_control_invalid');
        await this.apps.launch(id);
      } else if (action === 'mode') {
        if (!object(body) || Object.keys(body).length !== 1 || !['native', 'gateway'].includes(body.mode)) throw new BridgeError('请选择 native 或 gateway。', 400, 'client_control_invalid');
        if (typeof adapter.setMode !== 'function') throw new BridgeError('该客户端尚未提供模式切换适配。', 409, 'client_mode_unsupported');
        if (body.mode === 'gateway') {
          await this.refreshModels();
          const catalog = await this.#catalog();
          await adapter.setMode('gateway', { models: this.#models(adapter, catalog) });
          await this.#sync(adapter, catalog);
        } else {
          await adapter.setMode('native', { models: [] });
          await this.#save(id, { lastError: null });
        }
      } else if (action === 'sync') {
        if (!empty(body)) throw new BridgeError('目录同步只接受空对象。', 400, 'client_control_invalid');
        await this.refreshModels(); await this.#sync(adapter, await this.#catalog());
      } else throw new BridgeError('客户端管理操作不存在。', 404, 'client_control_not_found');
      return this.#snapshot();
    });
  }
  autoSync() {
    return this.#serial(async () => {
      const catalog = await this.#catalog();
      for (const adapter of this.adapters) {
        const saved = this.state.clients[adapter.id] ?? fresh();
        if (!saved.autoSync || typeof adapter.sync !== 'function') continue;
        try {
          const current = await adapter.inspect();
          if (current.mode !== 'gateway' || saved.lastRevision === revision(this.#models(adapter, catalog))) continue;
          await this.#sync(adapter, catalog);
        } catch (error) { await this.#save(adapter.id, { lastError: redact(error.message) }); }
      }
    });
  }
  async close() { this.#closed = true; await this.#queue; }
}
