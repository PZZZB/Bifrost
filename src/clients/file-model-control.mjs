import * as filesystem from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from '../storage.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'client_config_conflict', status = 409) => new BridgeError(message, status, code);
const queues = new Map();
const sameSnapshot = (a, b) => a.exists === b.exists && a.hash === b.hash;
const snapshot = bytes => bytes === null ? { exists: false, hash: null, bytes: null }
  : { exists: true, hash: hash(bytes), bytes: bytes.toString('base64') };
const bytesOf = value => value.exists ? Buffer.from(value.bytes, 'base64') : null;
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const own = (value, key) => Object.hasOwn(value, key);

function knownFlag(...values) { return values.includes(false) ? false : values.includes(true); }
function desiredModels(models, gatewayUrl, gatewayKey) {
  if (!Array.isArray(models) || models.length > 512) throw fail('模型目录无效，未写入客户端。', 'client_models_invalid', 400);
  const ids = new Set();
  return models.map(model => {
    if (!object(model) || typeof model.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,279}$/.test(model.id)
      || model.id.includes('..') || ids.has(model.id)) throw fail('模型目录包含无效或重复 ID，未写入客户端。', 'client_models_invalid', 400);
    ids.add(model.id);
    const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id;
    if (name.length > 256 || /[\x00-\x1f\x7f]/.test(name)) throw fail('模型名称无效，未写入客户端。', 'client_models_invalid', 400);
    const capabilities = object(model.capabilities) ? model.capabilities : {};
    return { id: model.id, name, vendor: 'Bifröst', url: gatewayUrl, apiKey: gatewayKey,
      supportsToolCall: knownFlag(model.supportsToolCall, capabilities.toolCalls, capabilities.tools?.support,
        capabilities.tools?.adapterSupport, model.adapterCapabilities?.tools),
      supportsImages: knownFlag(model.supportsImages, capabilities.images?.support,
        Array.isArray(capabilities.inputModalities) ? capabilities.inputModalities.includes('image') : undefined),
      supportsReasoning: knownFlag(model.supportsReasoning, capabilities.reasoning?.support) };
  });
}

/** A file adapter owns only its recorded model entries, never another model or login. */
export function createFileModelControl({ id, name, configPath, statePath, gatewayUrl, gatewayKey, fs = filesystem } = {}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || typeof name !== 'string' || !name.trim()
    || typeof configPath !== 'string' || !isAbsolute(configPath) || typeof statePath !== 'string' || !isAbsolute(statePath)
    || resolve(configPath) === resolve(statePath) || /[\x00-\x1f\x7f]/.test(configPath + statePath)
    || typeof gatewayKey !== 'string' || gatewayKey.length < 12 || gatewayKey.length > 4096 || /[\x00-\x20\x7f]/.test(gatewayKey)) throw new TypeError('Invalid client file adapter.');
  const url = new URL(gatewayUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || !url.pathname.endsWith('/chat/completions')) throw new TypeError('Client requires a complete Chat endpoint.');
  configPath = resolve(configPath); statePath = resolve(statePath);
  const io = { ...filesystem, ...fs };

  async function assertPath(path) {
    const ancestors = []; let cursor = path;
    while (true) {
      ancestors.push(cursor);
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    // Reject an untrusted ancestor before inspecting any descendant through
    // it. Windows can report UNKNOWN for a missing file beneath a junction.
    for (const cursor of ancestors.reverse()) {
      try { if ((await io.lstat(cursor)).isSymbolicLink()) throw fail('客户端配置路径包含链接，未修改配置。', 'client_config_link'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function read(path, maximum = MAX_FILE_BYTES) {
    await assertPath(path);
    try {
      const stat = await io.lstat(path);
      if (!stat.isFile() || stat.size > maximum) throw fail('客户端配置文件无效或过大，未修改配置。', 'client_config_invalid');
      const bytes = await io.readFile(path);
      if (bytes.length > maximum) throw fail('客户端配置文件过大，未修改配置。', 'client_config_invalid');
      return snapshot(bytes);
    } catch (error) { if (error.code === 'ENOENT') return snapshot(null); throw error; }
  }
  function parseConfig(value) {
    if (!value.exists) return {};
    let data;
    try { data = JSON.parse(bytesOf(value).toString('utf8').replace(/^\uFEFF/, '')); } catch { throw fail('客户端模型文件不是有效 JSON，未修改配置。', 'client_config_invalid'); }
    if (!object(data) || own(data, 'models') && (!Array.isArray(data.models) || data.models.length > 2048)
      || own(data, 'availableModels') && (!Array.isArray(data.availableModels) || data.availableModels.length > 4096 || data.availableModels.some(v => typeof v !== 'string'))) {
      throw fail('客户端模型文件格式未知，未修改配置。', 'client_config_invalid');
    }
    const seen = new Set();
    for (const model of data.models ?? []) {
      if (!object(model) || typeof model.id !== 'string' || !model.id || seen.has(model.id)) throw fail('客户端模型文件存在无效或重复模型，未修改配置。', 'client_config_invalid');
      seen.add(model.id);
    }
    return data;
  }
  function validateRecord(record, pending = true) {
    if (!object(record) || record.version !== 1 || record.id !== id || record.configPath !== configPath
      || !['native', 'gateway'].includes(record.mode) || typeof record.originalMissing !== 'boolean'
      || typeof record.modelsOriginallyPresent !== 'boolean' || !Array.isArray(record.managedModels) || record.managedModels.length > 512
      || !Array.isArray(record.availableModelIds) || record.availableModelIds.length > 512 || record.availableModelIds.some(v => typeof v !== 'string')
      || record.managedModels.some(v => !object(v) || typeof v.id !== 'string' || typeof v.apiKey !== 'string')
      || new Set(record.managedModels.map(v => v.id)).size !== record.managedModels.length
      || new Set(record.availableModelIds).size !== record.availableModelIds.length
      || record.availableModelIds.some(modelId => !record.managedModels.some(model => model.id === modelId))
      || record.mode === 'native' && record.managedModels.length) throw fail('客户端接入恢复记录无效，未修改配置。', 'client_config_state_invalid');
    if (record.pending !== undefined) {
      if (!pending || !object(record.pending) || !object(record.pending.next)) throw fail('客户端接入恢复记录无效，未修改配置。', 'client_config_state_invalid');
      for (const part of [record.pending.before, record.pending.after]) {
        if (!object(part) || typeof part.exists !== 'boolean' || part.exists && (typeof part.bytes !== 'string'
          || typeof part.hash !== 'string' || hash(bytesOf(part)) !== part.hash) || !part.exists && (part.bytes !== null || part.hash !== null)) {
          throw fail('客户端接入恢复快照无效，未修改配置。', 'client_config_state_invalid');
        }
      }
      validateRecord(record.pending.next, false);
    }
    return record;
  }
  async function readRecord() {
    const image = await read(statePath, 12 * MAX_FILE_BYTES);
    if (!image.exists) return { image, record: null };
    try { return { image, record: validateRecord(JSON.parse(bytesOf(image).toString('utf8'))) }; }
    catch (error) { if (error instanceof BridgeError) throw error; throw fail('客户端接入恢复记录无法读取，未修改配置。', 'client_config_state_invalid'); }
  }
  async function compare(path, expected, maximum) {
    if (!sameSnapshot(await read(path, maximum), expected)) throw fail('客户端配置刚被其他程序修改，请刷新后重试。');
  }
  async function replace(path, desired, expected, maximum = MAX_FILE_BYTES) {
    await assertPath(path); await io.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await compare(path, expected, maximum);
    if (!desired.exists) { if (expected.exists) await io.unlink(path); return; }
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytesOf(desired)); await handle.sync(); await handle.close(); handle = null;
      await compare(path, expected, maximum); await io.rename(temporary, path);
      if (!sameSnapshot(await read(path, maximum), desired)) throw fail('客户端配置写入后的内容发生变化，请重新检查。');
    } finally { await handle?.close(); await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function saveRecord(record, expected) {
    const image = snapshot(encode(record)); await replace(statePath, image, expected, 12 * MAX_FILE_BYTES); return image;
  }
  function verifyOwned(record, config) {
    for (const expected of record?.managedModels ?? []) {
      const found = (config.models ?? []).find(model => model.id === expected.id);
      if (!found || !isDeepStrictEqual(found, expected)) throw fail('本桥管理的模型已被外部修改，未覆盖这些修改。');
    }
    for (const modelId of record?.availableModelIds ?? []) if (!Array.isArray(config.availableModels)
      || config.availableModels.filter(value => value === modelId).length !== 1) throw fail('本桥管理的模型筛选项已被外部修改，未覆盖这些修改。');
  }
  async function recover(loaded) {
    if (!loaded.record?.pending) return loaded;
    const { pending, ...base } = loaded.record, current = await read(configPath);
    let record;
    if (sameSnapshot(current, pending.after)) record = pending.next;
    else if (sameSnapshot(current, pending.before)) record = base;
    else throw fail('上次接入操作待恢复，客户端配置又有修改；现有内容和恢复记录均已保留。');
    return { record, image: await saveRecord(record, loaded.image) };
  }
  const publicStatus = (record, configImage, extra = {}) => ({ id, name, protocol: 'chat-completions', mode: record?.mode ?? 'native',
    configured: configImage.exists, managedModelCount: record?.managedModels.length ?? 0,
    reloadNote: '这里只管理本桥模型是否出现在列表；当前会话模型仍由客户端选择。配置已同步不代表客户端已加载。', ...extra });

  function serialize(operation) {
    const previous = queues.get(statePath) ?? Promise.resolve();
    const next = previous.then(operation, operation); queues.set(statePath, next.catch(() => {})); return next;
  }
  async function status() {
    try {
      const loaded = await recover(await readRecord()), image = await read(configPath), data = parseConfig(image);
      verifyOwned(loaded.record, data); return publicStatus(loaded.record, image);
    } catch (error) { return { id, name, protocol: 'chat-completions', mode: 'conflict', configured: false, managedModelCount: 0,
      reason: error instanceof BridgeError ? error.message : '客户端配置暂不可读取，现有内容未被覆盖。',
      reloadNote: '先解决配置冲突，再同步本桥模型。' }; }
  }
  async function change(mode, models, syncOnly = false) {
    let loaded = await recover(await readRecord());
    if (syncOnly && loaded.record?.mode !== 'gateway') return { ...await status(), changed: false, synced: false };
    const before = await read(configPath), data = parseConfig(before); verifyOwned(loaded.record, data);
    if (mode === 'native' && (!loaded.record || loaded.record.mode === 'native')) return publicStatus(loaded.record, before, { changed: false, synced: false });
    const previous = loaded.record ?? { version: 1, id, configPath, mode: 'native', originalMissing: !before.exists,
      modelsOriginallyPresent: own(data, 'models'), managedModels: [], availableModelIds: [] };
    const desired = mode === 'gateway' ? desiredModels(models, gatewayUrl, gatewayKey) : [];
    const ownedIds = new Set(previous.managedModels.map(model => model.id));
    const remaining = (data.models ?? []).filter(model => !ownedIds.has(model.id));
    if (desired.some(model => remaining.some(existing => existing.id === model.id))) throw fail('所选模型 ID 已被其他配置占用，未覆盖原模型。', 'client_model_id_conflict');
    const next = { ...previous, mode, managedModels: desired, availableModelIds: [] };
    if (previous.mode !== 'gateway' && mode === 'gateway') {
      next.originalMissing = !before.exists; next.modelsOriginallyPresent = own(data, 'models');
    }
    delete next.pending;
    const config = { ...data }, allModels = [...remaining, ...desired];
    if (allModels.length || next.modelsOriginallyPresent) config.models = allModels;
    else delete config.models;
    if (Array.isArray(data.availableModels)) {
      const filterIds = new Set(previous.availableModelIds);
      config.availableModels = data.availableModels.filter(value => !filterIds.has(value));
      if (mode === 'gateway' && data.availableModels.length) {
        next.availableModelIds = desired.map(model => model.id).filter(modelId => !config.availableModels.includes(modelId));
        config.availableModels.push(...next.availableModelIds);
      }
    }
    const after = !before.exists && !Object.keys(config).length || mode === 'native' && next.originalMissing && !Object.keys(config).length
      ? snapshot(null) : snapshot(encode(config));
    // Check the complete result before persisting a journal or replacing a
    // valid native file. Recovery must always be able to read our own output.
    if (allModels.length > 2048 || after.exists && bytesOf(after).length > MAX_FILE_BYTES) {
      throw fail('合并后的客户端模型文件超过大小或模型数量上限，未修改配置。', 'client_config_limit', 400);
    }
    parseConfig(after);
    if (sameSnapshot(before, after) && loaded.record && isDeepStrictEqual(loaded.record, next)) return publicStatus(next, before, { changed: false, synced: syncOnly });
    const prepared = { ...previous, pending: { before, after, next } };
    const preparedImage = await saveRecord(prepared, loaded.image);
    try {
      await replace(configPath, after, before);
      await saveRecord(next, preparedImage);
    } catch (error) {
      // Restore only bytes that are still ours. An external edit preserves the
      // durable journal and is never replaced by a speculative rollback.
      try {
        const latest = await readRecord();
        if (!isDeepStrictEqual(latest.record, prepared) && !isDeepStrictEqual(latest.record, next)) throw fail('客户端恢复记录已变化。');
        const current = await read(configPath);
        if (sameSnapshot(current, after)) await replace(configPath, before, after);
        else if (!sameSnapshot(current, before)) throw fail('客户端配置已变化，恢复记录保留。');
        await saveRecord(previous, latest.image);
      } catch { throw fail('客户端配置更新未完成，恢复记录已保留；请检查后重试。', 'client_config_recovery_required'); }
      throw error instanceof BridgeError ? error : fail('客户端模型配置未能保存，已恢复原配置。', 'client_config_write_failed', 503);
    }
    return publicStatus(next, after, { changed: !sameSnapshot(before, after), synced: syncOnly });
  }
  return { id, name, protocol: 'chat-completions', inspect: () => serialize(status),
    setMode(mode, { models = [] } = {}) {
      if (!['native', 'gateway'].includes(mode)) return Promise.reject(fail('客户端模式无效。', 'client_mode_invalid', 400));
      return serialize(() => change(mode, models)).catch(error => { throw error instanceof BridgeError ? error
        : fail('客户端接入设置未能保存；现有配置和恢复记录已保留。', 'client_config_write_failed', 503); });
    }, sync: models => serialize(() => change('gateway', models, true)).catch(error => { throw error instanceof BridgeError ? error
      : fail('客户端模型同步未完成；现有配置和恢复记录已保留。', 'client_config_write_failed', 503); }) };
}
