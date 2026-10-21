import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const STATE_VERSION = 2;
const HEADER_NAME = 'X-Account-Bridge-Key';
const LEGACY_FIELDS = ['base_url', 'supports_websockets', `http_headers.${HEADER_NAME}`];
const FIELDS = [...LEGACY_FIELDS, 'model_catalog_url'];
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fieldAt(config, keyPath) {
  let value = config;
  for (const key of keyPath.split('.')) {
    if (!value || typeof value !== 'object' || !hasOwn(value, key)) return { exists: false };
    value = value[key];
  }
  return { exists: true, value: clone(value) };
}

function matches(actual, expected) {
  return actual.exists === expected.exists && (!actual.exists || isDeepStrictEqual(actual.value, expected.value));
}

function setField(config, keyPath, field) {
  const keys = keyPath.split('.');
  let parent = config;
  for (const key of keys.slice(0, -1)) {
    if (!parent[key] || typeof parent[key] !== 'object') {
      if (!field.exists) return;
      parent[key] = {};
    }
    parent = parent[key];
  }
  if (field.exists) parent[keys.at(-1)] = clone(field.value);
  else delete parent[keys.at(-1)];
}

/**
 * Installs a gateway on an existing custom provider through Codex's native TOML editor.
 * The recovery file contains only edited fields, never the entire config.
 */
export class Integration {
  #rpc;
  #configPath;
  #statePath;
  #baseUrl;
  #gatewayKey;
  #queue = Promise.resolve();

  constructor({ rpc, configPath, statePath, baseUrl, gatewayKey }) {
    if (!rpc || typeof rpc.request !== 'function') throw new TypeError('rpc.request is required.');
    if (!configPath || !statePath) throw new TypeError('configPath and statePath are required.');
    const address = new URL(baseUrl);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
      throw new TypeError('baseUrl must be an HTTP URL without credentials, query, or fragment.');
    }
    if (typeof gatewayKey !== 'string' || !gatewayKey || /[\r\n]/.test(gatewayKey)) {
      throw new TypeError('gatewayKey must be a nonempty single-line string.');
    }
    this.#rpc = rpc;
    this.#configPath = path.resolve(configPath);
    this.#statePath = path.resolve(statePath);
    if (samePath(this.#configPath, this.#statePath)) throw new TypeError('statePath must differ from configPath.');
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#gatewayKey = gatewayKey;
  }

  inspect() {
    return this.#serial(async () => {
      const [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      return this.#describe(snapshot, state);
    });
  }

  /** Returns private provider settings for internal A routing. Never expose this result through the management API. */
  originalProvider() {
    return this.#serial(async () => {
      const [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      const providerId = state?.providerId ?? snapshot.config?.model_provider;
      const current = typeof providerId === 'string' ? snapshot.config?.model_providers?.[providerId] : null;
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'The original custom provider is unavailable.');
      }
      if (state && !this.#allMatch(snapshot, state, 'installed')
        && !this.#allMatch(snapshot, state, 'original') && !this.#upgradeBaselineMatches(snapshot, state)) {
        throw failure('INTEGRATION_CONFLICT', 'Provider fields were edited after installation. The original provider cannot be reconstructed safely.');
      }
      const config = clone(current);
      if (state) {
        for (const field of state.fields) {
          let effective = { exists: false };
          // App-server layers are ordered from highest to lowest priority.
          for (const layer of snapshot.layers) {
            if (layer.disabledReason) continue;
            const value = layer === snapshot.layer ? field.original : fieldAt(layer.config, field.keyPath);
            if (value.exists) { effective = value; break; }
          }
          setField(config, field.keyPath.slice(`model_providers.${providerId}.`.length), effective);
        }
      }
      // Match app-server's effective defaults when the original user key was absent.
      config.supports_websockets ??= false;
      config.model_catalog_url ??= null;
      for (const kind of ['http_headers', 'env_http_headers']) {
        for (const key of Object.keys(config[kind] || {})) {
          if (key.toLowerCase() === HEADER_NAME.toLowerCase()) delete config[kind][key];
        }
      }
      let address;
      try { address = new URL(config.base_url); } catch {}
      if (!address || !['http:', 'https:'].includes(address.protocol) || address.origin === new URL(this.#baseUrl).origin) {
        throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'The original provider address is unavailable or would route back to this bridge.');
      }
      return { providerId, config };
    });
  }

  install() {
    return this.#serial(async () => {
      let [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      const description = this.#describe(snapshot, state);
      if (!description.canInstall) {
        throw failure('INTEGRATION_CONFLICT', description.reason || 'The provider cannot be connected.');
      }
      if (description.installed && !description.needsUpgrade) {
        if (state.phase !== 'installed') {
          state.phase = 'installed';
          await this.#writeState(state);
        }
        return description;
      }

      if (!state) {
        state = {
          version: STATE_VERSION,
          configPath: this.#configPath,
          providerId: description.providerId,
          phase: 'prepared',
          fields: this.#desiredFields(description.providerId).map(field => ({
            ...field,
            original: fieldAt(snapshot.layer.config, field.keyPath),
          })),
        };
        // Persist recovery information before changing the live config.
        await this.#writeState(state, true);
      } else if (state.version === 1) {
        // Preserve all three legacy original values before appending the catalog field.
        const catalog = this.#desiredFields(state.providerId).at(-1);
        state = {
          ...state,
          version: STATE_VERSION,
          phase: this.#allMatch(snapshot, state, 'installed') ? 'upgrading' : 'prepared',
          fields: [...state.fields, { ...catalog, original: fieldAt(snapshot.layer.config, catalog.keyPath) }],
        };
        await this.#writeState(state);
      }

      await this.#batchWrite(snapshot, state.fields.map(field => ({
        keyPath: field.keyPath,
        value: field.installed.value,
        mergeStrategy: 'replace',
      })));
      snapshot = await this.#readConfig();
      if (!this.#allMatch(snapshot, state, 'installed')) {
        throw failure('INTEGRATION_CONFLICT', 'Provider fields changed during installation. Recovery information was retained.');
      }
      state.phase = 'installed';
      await this.#writeState(state);
      return this.#describe(snapshot, state);
    });
  }

  restore() {
    return this.#serial(async () => {
      const state = await this.#readState();
      if (!state) {
        return { ...(await this.#describe(await this.#readConfig(), null)), restored: false };
      }
      let snapshot = await this.#readConfig();
      if (this.#allMatch(snapshot, state, 'original')) {
        // A previous restore may have completed before removing its recovery file.
        await unlink(this.#statePath);
        return { ...this.#describe(snapshot, null), restored: true };
      }
      const upgradeBaseline = this.#upgradeBaselineMatches(snapshot, state);
      if (!this.#allMatch(snapshot, state, 'installed') && !upgradeBaseline) {
        throw failure('INTEGRATION_CONFLICT', 'Provider fields were edited after installation. Restore refused to overwrite those changes.');
      }
      if (!upgradeBaseline) {
        state.phase = 'restoring';
        await this.#writeState(state);
      }
      await this.#batchWrite(snapshot, state.fields.map(field => ({
        keyPath: field.keyPath,
        // Codex's native TOML editor removes a key when value is null.
        value: field.original.exists ? field.original.value : null,
        mergeStrategy: 'replace',
      })));
      snapshot = await this.#readConfig();
      if (!this.#allMatch(snapshot, state, 'original')) {
        throw failure('INTEGRATION_CONFLICT', 'Provider fields changed during restoration. Recovery information was retained.');
      }
      await unlink(this.#statePath);
      return { ...this.#describe(snapshot, null), restored: true };
    });
  }

  #serial(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #readConfig() {
    const response = await this.#rpc.request('config/read', { includeLayers: true });
    const layer = response.layers?.find(candidate => candidate.name?.type === 'user'
      && !candidate.name.profile
      && typeof candidate.name.file === 'string'
      && samePath(candidate.name.file, this.#configPath));
    if (!layer || layer.disabledReason || typeof layer.version !== 'string' || !layer.config || typeof layer.config !== 'object') {
      throw failure('INTEGRATION_CONFIG_UNAVAILABLE', 'The requested base user config layer is unavailable or disabled.');
    }
    return { config: response.config, layer, layers: response.layers };
  }

  #desiredFields(providerId, version = STATE_VERSION) {
    return [this.#baseUrl, false, this.#gatewayKey, `${this.#baseUrl}/models`]
      .slice(0, version === 1 ? LEGACY_FIELDS.length : FIELDS.length).map((value, index) => ({
      keyPath: `model_providers.${providerId}.${FIELDS[index]}`,
      installed: { exists: true, value },
    }));
  }

  #allMatch(snapshot, state, which) {
    return state.fields.every(field => matches(fieldAt(snapshot.layer.config, field.keyPath), field[which]));
  }

  #upgradeBaselineMatches(snapshot, state) {
    return state.version === 2 && state.phase === 'upgrading'
      && state.fields.every((field, index) => matches(fieldAt(snapshot.layer.config, field.keyPath),
        index < LEGACY_FIELDS.length ? field.installed : field.original));
  }

  #describe(snapshot, state) {
    const providerId = snapshot.config?.model_provider;
    const installed = !!state && this.#allMatch(snapshot, state, 'installed');
    const needsUpgrade = !!state && (state.version === 1 || (state.phase === 'upgrading' && !installed));
    const result = { installed, configPath: this.#configPath, canInstall: false, needsUpgrade };
    if (typeof providerId === 'string') result.providerId = providerId;
    const refuse = reason => ({ ...result, reason });
    if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(providerId)
      || ['openai', 'ollama', 'lmstudio'].includes(providerId)) {
      return refuse('Select an existing custom provider before connecting the gateway.');
    }
    const provider = snapshot.config?.model_providers?.[providerId];
    if (!provider || typeof provider !== 'object' || provider.requires_openai_auth !== true) {
      return refuse('The existing custom provider must use requires_openai_auth = true.');
    }
    if (provider.wire_api !== undefined && provider.wire_api !== 'responses') {
      return refuse('The existing provider must use the Responses API.');
    }
    if (Object.keys(provider.http_headers || {}).some(key => key.toLowerCase() === HEADER_NAME.toLowerCase() && key !== HEADER_NAME)) {
      return refuse('The provider contains the gateway header under a different letter case.');
    }
    if (state) {
      if (providerId !== state.providerId) return refuse('The selected provider changed after installation. Restore the previous connection first.');
      const desired = this.#desiredFields(state.providerId, state.version);
      if (!state.fields.every((field, index) => matches(field.installed, desired[index].installed))) {
        return refuse('The gateway address or key changed. Restore the previous connection first.');
      }
      if (!installed && (state.phase !== 'prepared' || !this.#allMatch(snapshot, state, 'original'))
        && !this.#upgradeBaselineMatches(snapshot, state)) {
        return refuse('Provider fields were edited after installation. Restore refused to overwrite those changes.');
      }
    }
    return { ...result, canInstall: true };
  }

  async #batchWrite(snapshot, edits) {
    let response;
    try {
      response = await this.#rpc.request('config/batchWrite', {
        filePath: this.#configPath,
        expectedVersion: snapshot.layer.version,
        edits,
        reloadUserConfig: false,
      });
    } catch (cause) {
      throw failure('INTEGRATION_WRITE_FAILED', 'Codex rejected the config write or the connection was interrupted. Recovery information was retained.', cause);
    }
    if (response?.status !== 'ok' || !response.filePath || !samePath(response.filePath, this.#configPath)) {
      throw failure('INTEGRATION_WRITE_FAILED', 'Codex did not confirm the expected config write. Recovery information was retained.');
    }
  }

  async #readState() {
    let state;
    try {
      state = JSON.parse(await readFile(this.#statePath, 'utf8'));
    } catch (cause) {
      if (cause.code === 'ENOENT') return null;
      throw failure('INTEGRATION_STATE_INVALID', 'The recovery file is unreadable. No config changes were made.', cause);
    }
    const validId = typeof state?.providerId === 'string' && /^[A-Za-z0-9_-]+$/.test(state.providerId);
    const desired = validId ? this.#desiredFields(state.providerId, state.version) : [];
    if (![1, STATE_VERSION].includes(state?.version) || typeof state.configPath !== 'string' || !samePath(state.configPath, this.#configPath)
      || !validId || !['prepared', 'installed', 'restoring', ...(state.version === 2 ? ['upgrading'] : [])].includes(state.phase)
      || !Array.isArray(state.fields) || state.fields.length !== desired.length
      || !state.fields.every((field, index) => field && typeof field === 'object'
        && field.keyPath === desired[index].keyPath
        && field.installed?.exists === true && hasOwn(field.installed, 'value')
        && typeof field.installed.value === (index === 1 ? 'boolean' : 'string')
        && field.original && typeof field.original.exists === 'boolean'
        && (!field.original.exists || (hasOwn(field.original, 'value')
          && typeof field.original.value === (index === 1 ? 'boolean' : 'string'))))) {
      throw failure('INTEGRATION_STATE_INVALID', 'The recovery file does not match this config. No config changes were made.');
    }
    return state;
  }

  async #writeState(state, exclusive = false) {
    await mkdir(path.dirname(this.#statePath), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (exclusive) {
      try {
        await writeFile(this.#statePath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await chmod(this.#statePath, 0o600);
      } catch (cause) {
        throw failure('INTEGRATION_STATE_WRITE_FAILED', 'Could not create the recovery file. No config changes were made.', cause);
      }
      return;
    }
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#statePath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
