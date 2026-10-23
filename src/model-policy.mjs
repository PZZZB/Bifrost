import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BridgeError, writeJson } from './storage.mjs';
import { resolveBModel, resolveCodeBuddyModel } from './models.mjs';
import { CURSOR_MODELS } from './cursor-service.mjs';

export const MODEL_POLICY_CHANNELS = Object.freeze(['A', 'B', 'CodeBuddy', 'Cursor']);
const MAX_DISABLED = 2048;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LEGACY_EXTERNAL_DEFAULTS = new Set(['claude-codebuddy-opus-5-5', ...CURSOR_MODELS.map(model => model.id)]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const safeId = value => safeText(value) && !/\s/.test(value);
const fields = (value, names) => object(value) && Reflect.ownKeys(value).length === names.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && names.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

function invalid(message = '模型开关参数无效。') {
  return new BridgeError(message, 400, 'invalid_model_policy');
}
function fixedChannel(id) {
  if (resolveBModel(id)) return 'B';
  if (resolveCodeBuddyModel(id)) return 'CodeBuddy';
  if (/^(?:claude-codebuddy-|codebuddy[-:/])/i.test(id)) return 'CodeBuddy';
  if (/^cursor[-:/]/i.test(id)) return 'Cursor';
  return null;
}
function modelId(model) {
  if (!object(model)) return null;
  const id = typeof model.slug === 'string' ? model.slug : model.id;
  return safeId(id) ? id : null;
}
function modelName(model) {
  for (const field of ['display_name', 'displayName', 'label', 'name']) {
    if (safeText(model[field])) return model[field];
  }
  return null;
}
function catalogModels(catalog) {
  if (!object(catalog) || !Array.isArray(catalog.models)) throw invalid('模型目录格式无效。');
  return catalog.models;
}

/** Persistent model switches; observed catalog entries are discovery, not entitlement checks. */
export class ModelPolicy {
  #path;
  #models = new Map();
  #disabled = new Set();
  #availability = new Map();
  #authorizationSources = new Map();
  #revision = 0;
  #queue = Promise.resolve();
  #available = false;
  #error = { code: 'model_policy_unavailable', message: '模型开关配置尚未载入。' };

  constructor({ path } = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('ModelPolicy path is required.');
    this.#path = resolve(path);
  }

  static async open(options) {
    const policy = new ModelPolicy(options);
    await policy.#load();
    return policy;
  }

  async #load() {
    let bytes;
    try { bytes = await readFile(this.#path); }
    catch (error) {
      if (error.code === 'ENOENT') { this.#available = true; this.#error = null; return; }
      this.#loadFailed(); return;
    }
    try {
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error();
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!fields(data, ['version', 'revision', 'disabledModels', 'models']) || data.version !== 1
        || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.models)
        || !Array.isArray(data.disabledModels) || data.disabledModels.length > MAX_DISABLED) throw new Error();
      const models = new Map();
      for (const model of data.models) {
        if (!fields(model, ['id', 'name', 'channel']) || !safeId(model.id) || !safeText(model.name)
          || !MODEL_POLICY_CHANNELS.includes(model.channel) || models.has(model.id)
          || fixedChannel(model.id) !== null && fixedChannel(model.id) !== model.channel) throw new Error();
        models.set(model.id, { id: model.id, name: model.name, channel: model.channel });
      }
      const disabled = new Set();
      for (const id of data.disabledModels) {
        if (!safeId(id) || !models.has(id) || disabled.has(id)) throw new Error();
        disabled.add(id);
      }
      this.#models = models; this.#disabled = disabled; this.#revision = data.revision;
      this.#available = true; this.#error = null;
    } catch { this.#loadFailed(); }
  }

  #loadFailed() {
    this.#available = false;
    this.#error = { code: 'model_policy_unavailable', message: '模型开关配置损坏或无法读取。请修复配置后重新载入。' };
  }
  #requireAvailable() {
    if (!this.#available) throw new BridgeError(this.#error.message, 503, 'model_policy_unavailable');
  }
  #serialize(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #commit(models, disabled) {
    if (this.#revision === Number.MAX_SAFE_INTEGER) throw new BridgeError('模型开关配置版本已耗尽，无法保存。', 503, 'model_policy_unavailable');
    const revision = this.#revision + 1;
    const data = { version: 1, revision, disabledModels: [...disabled].sort(), models: [...models.values()] };
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_FILE_BYTES) throw new BridgeError('已发现模型目录超过保存大小限制。', 503, 'model_policy_write_failed');
    try { await writeJson(this.#path, data); }
    catch { throw new BridgeError('模型开关配置保存失败，原有开关仍然生效。', 503, 'model_policy_write_failed'); }
    // Never expose an in-memory switch before its atomic file replacement succeeds.
    this.#models = models; this.#disabled = disabled; this.#revision = revision;
  }
  setAuthorizationVersionGetter(channel, getter) {
    if (!['CodeBuddy', 'Cursor'].includes(channel) || typeof getter !== 'function') throw new TypeError('Invalid model authorization source.');
    this.#authorizationSources.set(channel, getter);
  }
  #modelAvailability(id) {
    const value = this.#availability.get(id), channel = this.#models.get(id)?.channel;
    const getter = this.#authorizationSources.get(channel);
    if (getter && (!value || value.authorizationVersion !== getter())) {
      return { available: false, reason: '账号授权已变化或尚未取得当前账号目录，请刷新后重试。' };
    }
    if (!value) return undefined;
    const { authorizationVersion: _version, ...publicValue } = value;
    return publicValue;
  }

  async observe(catalog, channelHint, { defaultEnabled = true, complete = false,
    unavailableReason = '当前账号目录未返回此模型，请刷新目录后重试。', authorizationVersion } = {}) {
    this.#requireAvailable();
    if (channelHint !== undefined && !MODEL_POLICY_CHANNELS.includes(channelHint)) throw invalid('模型渠道无效。');
    if (typeof defaultEnabled !== 'boolean' || typeof complete !== 'boolean' || complete && channelHint === undefined
      || !safeText(unavailableReason)) throw invalid('模型目录更新参数无效。');
    // Extract only public metadata. Never retain prompts, headers, credentials,
    // account records, or capability declarations from an upstream catalog.
    const observed = catalogModels(catalog).flatMap(model => {
      const id = modelId(model);
      if (id === null) return [];
      const availability = typeof model.available === 'boolean' ? { available: model.available,
        ...(!model.available ? { reason: safeText(model.reason) ? model.reason : '当前账号暂不能使用此模型。' } : {}),
        ...(['remote', 'native-cache', 'account-catalog'].includes(model.source) ? { source: model.source } : {}),
        ...(authorizationVersion !== undefined ? { authorizationVersion } : {}) } : null;
      return [{ id, name: modelName(model), channel: fixedChannel(id) ?? channelHint ?? 'A', availability }];
    });
    return this.#serialize(async () => {
      this.#requireAvailable();
      const getter = this.#authorizationSources.get(channelHint);
      if (getter && authorizationVersion !== undefined && getter() !== authorizationVersion) return this.snapshot();
      const models = new Map(this.#models), disabled = new Set(this.#disabled), availability = new Map(this.#availability);
      let changed = false;
      for (const entry of observed) {
        const previous = models.get(entry.id);
        const next = { id: entry.id, name: entry.name ?? previous?.name ?? entry.id, channel: entry.channel };
        if (!previous || previous.name !== next.name || previous.channel !== next.channel) {
          models.set(entry.id, next); changed = true;
        }
        if (!previous && (!defaultEnabled || ['CodeBuddy', 'Cursor'].includes(next.channel) && !LEGACY_EXTERNAL_DEFAULTS.has(next.id))) {
          disabled.add(entry.id);
        }
        if (entry.availability && JSON.stringify(availability.get(entry.id)) !== JSON.stringify(entry.availability)) {
          availability.set(entry.id, entry.availability); changed = true;
        }
      }
      if (complete) {
        const seen = new Set(observed.map(entry => entry.id));
        for (const model of models.values()) if (model.channel === channelHint && !seen.has(model.id)) {
          const next = { available: false, reason: unavailableReason, ...(authorizationVersion !== undefined ? { authorizationVersion } : {}) };
          if (JSON.stringify(availability.get(model.id)) !== JSON.stringify(next)) {
            availability.set(model.id, next); changed = true;
          }
        }
      }
      if (disabled.size > MAX_DISABLED) throw new BridgeError('模型开关数量超过保存限制。', 503, 'model_policy_write_failed');
      if (changed) {
        await this.#commit(models, disabled);
        this.#availability = availability;
      }
      return this.snapshot();
    });
  }

  filterCatalog(catalog) {
    this.#requireAvailable();
    catalogModels(catalog);
    const result = structuredClone(catalog);
    result.models = result.models.filter(model => !this.#disabled.has(modelId(model)) && this.#modelAvailability(modelId(model))?.available !== false);
    return result;
  }

  assertEnabled(model) {
    this.#requireAvailable();
    if (!this.#models.has(model) && ['CodeBuddy', 'Cursor'].includes(fixedChannel(model))) {
      throw new BridgeError('此模型尚未在管理页启用，请刷新账号目录后选择。', 400, 'model_disabled');
    }
    if (this.#disabled.has(model)) throw new BridgeError(`模型 ${model} 已在管理页禁用。`, 400, 'model_disabled');
    if (this.#modelAvailability(model)?.available === false) {
      throw new BridgeError(this.#modelAvailability(model).reason, 403, 'model_unavailable');
    }
    return true;
  }

  snapshot() {
    return { available: this.#available, discoveryOnly: true, revision: this.#revision,
      disabledModels: [...this.#disabled].sort(),
      models: [...this.#models.values()].map(model => ({ ...model, enabled: !this.#disabled.has(model.id), ...this.#modelAvailability(model.id) })),
      error: this.#error ? { ...this.#error } : null };
  }

  async update(input) {
    this.#requireAvailable();
    if (!fields(input, ['revision', 'disabledModels']) || !Number.isSafeInteger(input.revision) || input.revision < 0
      || !Array.isArray(input.disabledModels) || input.disabledModels.length > MAX_DISABLED
      || input.disabledModels.some(id => !safeId(id)) || new Set(input.disabledModels).size !== input.disabledModels.length) throw invalid();
    const revision = input.revision, ids = [...input.disabledModels];
    return this.#serialize(async () => {
      this.#requireAvailable();
      if (revision !== this.#revision) throw new BridgeError('模型列表或开关已更新，请刷新后重试。', 409, 'model_policy_conflict');
      if (ids.some(id => !this.#models.has(id))) throw invalid('禁用列表包含尚未发现的模型。');
      const disabled = new Set(ids);
      for (const id of this.#disabled) if (!disabled.has(id) && this.#modelAvailability(id)?.available === false) {
        throw invalid('当前账号不可用的模型不能启用，请先刷新账号目录。');
      }
      if (disabled.size !== this.#disabled.size || [...disabled].some(id => !this.#disabled.has(id))) {
        await this.#commit(new Map(this.#models), disabled);
      }
      return this.snapshot();
    });
  }
}
