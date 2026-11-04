import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateAccountFile } from './private-account-files.mjs';
import { BridgeError, writeJson } from './storage.mjs';
import { validateBifrostUrl } from './providers/bifrost-remote.mjs';
import { PROTOCOL_PATHS } from './routing/model-router.mjs';

export const LEGACY_SLOTS = Object.freeze({ 'codex-client': 'A', codex: 'B', codebuddy: 'CodeBuddy', cursor: 'Cursor', claude: 'Claude', with: 'With' });
export const UPSTREAM_KINDS = Object.freeze([...Object.keys(LEGACY_SLOTS), 'bifrost']);
const fields = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const invalid = () => new BridgeError('上游账号配置无效，未覆盖现有配置。', 503, 'upstream_accounts_invalid');
export function upstreamName(v) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 80 || /[\x00-\x1f\x7f]|bfk_|Bearer\s|\bsk-/i.test(v)) throw new BridgeError('账号名称须为 1–80 个字符，不能包含密钥。', 400, 'upstream_name_invalid');
  return v.trim();
}
export function validateModelPresentation(value) {
  const invalidPresentation = () => new BridgeError('模型展示须包含前缀和排序；前缀最多 48 个字符，不能包含控制字符或凭证，排序须为 0–9999 的整数。', 400, 'upstream_model_presentation_invalid');
  if (!fields(value, ['prefix', 'order']) || typeof value.prefix !== 'string' || !Number.isInteger(value.order)
    || value.order < 0 || value.order > 9999) throw invalidPresentation();
  const prefix = value.prefix.trim();
  if (prefix.length > 96 || [...prefix].length > 48 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.prefix)
    || /bf[ksin]_|bearer(?:\b|_)|(?:^|[^A-Za-z0-9])(?:sk-|rt_|oat_|oaist[a-z_]*|eyJ)/i.test(value.prefix)) throw invalidPresentation();
  return { prefix, order: value.order };
}
export function validateRemoteBinding(v) {
  if (!fields(v, ['sourceId', 'baseUrl', 'protocols', 'credentialRef']) || typeof v.sourceId !== 'string'
    || !/^[a-z][a-z0-9-]{0,31}$/.test(v.sourceId) || typeof v.baseUrl !== 'string' || typeof v.credentialRef !== 'string'
    || !uuid.test(v.credentialRef) || !Array.isArray(v.protocols) || !v.protocols.length
    || v.protocols.some(p => !Object.hasOwn(PROTOCOL_PATHS, p))) throw invalid();
  return { ...v, baseUrl: validateBifrostUrl(v.baseUrl), protocols: [...new Set(v.protocols)] };
}
export function validateUpstreamAccounts(value) {
  if (!fields(value, ['version', 'revision', 'accounts']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.accounts) || value.accounts.length > 64) throw invalid();
  const ids = new Set(), slots = new Set(); let remotes = 0;
  for (const a of value.accounts) {
    const presentation = a && Object.hasOwn(a, 'modelPresentation');
    if (!fields(a, ['id', 'kind', 'name', 'enabled', 'binding', 'createdAt', ...(presentation ? ['modelPresentation'] : [])]) || typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(a.id)
      || ids.has(a.id) || !UPSTREAM_KINDS.includes(a.kind) || typeof a.enabled !== 'boolean' || upstreamName(a.name) !== a.name
      || typeof a.createdAt !== 'string' || !Number.isFinite(Date.parse(a.createdAt))) throw invalid();
    if (presentation) {
      try { if (validateModelPresentation(a.modelPresentation).prefix !== a.modelPresentation.prefix) throw invalid(); }
      catch { throw invalid(); }
    }
    ids.add(a.id);
    if (a.kind === 'bifrost') { validateRemoteBinding(a.binding); if (++remotes > 8) throw invalid(); }
    else if (!fields(a.binding, ['slot']) || a.binding.slot !== LEGACY_SLOTS[a.kind]) throw invalid();
    const slot = a.kind === 'bifrost' ? `remote:${a.binding.sourceId}` : a.binding.slot;
    if (slots.has(slot)) throw invalid(); slots.add(slot);
  }
  return structuredClone(value);
}
export async function readUpstreamAccounts(stateDir) {
  try { return validateUpstreamAccounts(JSON.parse(await readPrivateAccountFile(join(stateDir, 'upstream-accounts.json')))); }
  catch (e) { if (e.code === 'ENOENT') return null; throw invalid(); }
}
export const remoteSource = a => ({ id: a.binding.sourceId, kind: 'bifrost-remote', baseUrl: a.binding.baseUrl,
  protocols: [...a.binding.protocols], credentialRef: a.binding.credentialRef });

/** Canonical instance metadata. Existing auth files remain owned by their adapters. */
export class UpstreamAccountStore {
  #state; #queue = Promise.resolve();
  constructor({ stateDir, write = writeJson }) { this.directory = stateDir; this.write = write; }
  static async open({ stateDir, seeds = [], write = writeJson }) {
    const store = new UpstreamAccountStore({ stateDir, write });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await store.#transaction(async current => {
      if (!current) {
        current = { version: 1, revision: 0, accounts: [] };
        let legacy;
        try { legacy = JSON.parse(await readPrivateAccountFile(join(stateDir, 'remote-sources.json'), 65536)); }
        catch (e) { if (e.code !== 'ENOENT') throw invalid(); }
        if (legacy) {
          if (!fields(legacy, ['version', 'sources']) || legacy.version !== 1 || !Array.isArray(legacy.sources)) throw invalid();
          for (const source of legacy.sources) {
            if (!fields(source, ['id', 'kind', 'baseUrl', 'protocols', 'credentialRef']) || source.kind !== 'bifrost-remote') throw invalid();
            const binding = validateRemoteBinding({ sourceId: source.id, baseUrl: source.baseUrl, protocols: source.protocols, credentialRef: source.credentialRef });
            current.accounts.push({ id: `remote-${source.id}`, kind: 'bifrost', name: `Bifröst · ${source.id}`, enabled: true, binding, createdAt: new Date().toISOString() });
          }
        }
      }
      for (const seed of seeds) if (!current.accounts.some(a => a.kind === seed.kind && a.binding.slot === LEGACY_SLOTS[seed.kind])) {
        current.accounts.push({ id: `legacy-${seed.kind}`, kind: seed.kind, name: upstreamName(seed.name), enabled: true,
          binding: { slot: LEGACY_SLOTS[seed.kind] }, createdAt: new Date().toISOString() });
      }
      return current;
    });
    return store;
  }
  #transaction(change) {
    const next = this.#queue.then(async () => {
      const lock = join(this.directory, 'upstream-accounts.lock');
      try { await mkdir(lock, { mode: 0o700 }); }
      catch { throw new BridgeError('上游账号配置正在更新，请稍后重试。', 409, 'upstream_accounts_busy'); }
      try {
        const previous = await readUpstreamAccounts(this.directory), value = await change(structuredClone(previous));
        validateUpstreamAccounts(value);
        if (JSON.stringify(previous) !== JSON.stringify(value)) {
          value.revision = (previous?.revision ?? -1) + 1;
          await this.write(join(this.directory, 'upstream-accounts.json'), value);
        }
        this.#state = value;
        return this.snapshot();
      } finally { await rm(lock, { recursive: true, force: true }); }
    });
    this.#queue = next.catch(() => {}); return next;
  }
  snapshot() { return structuredClone(this.#state); }
  async reload() { const state = await readUpstreamAccounts(this.directory); if (!state) throw invalid(); this.#state = state; return this.snapshot(); }
  async update(id, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['revision', 'name', 'enabled', 'modelPresentation'].includes(k))
      || !Number.isSafeInteger(patch.revision) || patch.revision < 0 || patch.name === undefined && patch.enabled === undefined && !Object.hasOwn(patch, 'modelPresentation')
      || patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new BridgeError('账号更新参数无效。', 400);
    const presentation = Object.hasOwn(patch, 'modelPresentation') ? validateModelPresentation(patch.modelPresentation) : null;
    return this.#transaction(state => {
      if (state.revision !== patch.revision) throw new BridgeError('账号配置已更新，请刷新后重试。', 409, 'upstream_accounts_conflict');
      const row = state.accounts.find(a => a.id === id); if (!row) throw new BridgeError('上游账号不存在。', 404);
      if (patch.name !== undefined) row.name = upstreamName(patch.name);
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
      if (presentation) row.modelPresentation = presentation;
      return state;
    });
  }
  async addLegacy(kind, name) {
    if (!Object.hasOwn(LEGACY_SLOTS, kind)) throw new BridgeError('账号类型无效。', 400);
    return this.#transaction(state => {
      if (state.accounts.some(a => a.kind === kind)) throw new BridgeError('当前适配器已达到单实例上限，请管理已有账号。', 409, 'upstream_account_capacity');
      state.accounts.push({ id: randomUUID(), kind, name: upstreamName(name), enabled: true, binding: { slot: LEGACY_SLOTS[kind] }, createdAt: new Date().toISOString() });
      return state;
    });
  }
  async setRemote(source, name) {
    const binding = validateRemoteBinding({ sourceId: source.id, baseUrl: source.baseUrl, protocols: source.protocols, credentialRef: source.credentialRef });
    return this.#transaction(state => {
      const existing = state.accounts.find(a => a.kind === 'bifrost' && a.binding.sourceId === source.id);
      if (existing) { existing.binding = binding; if (name !== undefined) existing.name = upstreamName(name); }
      else state.accounts.push({ id: randomUUID(), kind: 'bifrost', name: upstreamName(name ?? `Bifröst · ${source.id}`), enabled: true, binding, createdAt: new Date().toISOString() });
      return state;
    });
  }
}
