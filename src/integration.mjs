import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const STATE_VERSION = 2;
const NATIVE_STATE_VERSION = 3;
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

function sameBridgeEndpoint(left, right) {
  if (left.origin === right.origin) return true;
  const loopback = address => {
    const host = address.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
      || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
  };
  const port = address => address.port || (address.protocol === 'https:' ? '443' : '80');
  return left.protocol === right.protocol && port(left) === port(right) && loopback(left) && loopback(right);
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
 * Installs saved custom and optional built-in provider routes through Codex's native TOML editor.
 * The recovery file contains only edited fields, never the entire config.
 */
export class Integration {
  #rpc;
  #configPath;
  #statePath;
  #baseUrl;
  #gatewayKey;
  #nativeBaseUrl;
  #queue = Promise.resolve();

  constructor({ rpc, configPath, statePath, baseUrl, gatewayKey, nativeBaseUrl = null }) {
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
    if (nativeBaseUrl !== null) {
      const native = new URL(nativeBaseUrl);
      if (!['http:', 'https:'].includes(native.protocol) || native.username || native.password || native.search || native.hash
        || native.origin !== address.origin || native.pathname.replace(/\/+$/, '') === address.pathname.replace(/\/+$/, '')) {
        throw new TypeError('nativeBaseUrl must be a distinct endpoint on the gateway origin without credentials, query, or fragment.');
      }
      this.#nativeBaseUrl = nativeBaseUrl.replace(/\/+$/, '');
    } else this.#nativeBaseUrl = null;
  }

  inspect() {
    return this.#serial(async () => {
      const [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      return this.#describe(snapshot, state);
    });
  }

  /** Selects the saved connection, restoring all v3 route fields in official mode. */
  switchMode(mode) {
    if (this.#nativeBaseUrl) return this.#serial(() => this.#switchNative(mode));
    return this.#serial(async () => {
      if (!['official', 'gateway'].includes(mode)) {
        throw failure('INTEGRATION_CONFLICT', 'Select either the official or gateway connection.');
      }
      const [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      const description = this.#describe(snapshot, state);
      if (description.routing.mode === mode) return description;
      const available = mode === 'official' ? description.routing.canSwitchOfficial : description.routing.canSwitchGateway;
      if (!available) {
        throw failure('INTEGRATION_CONFLICT', description.routing.reason || 'The requested connection is unavailable.');
      }
      const providerId = mode === 'official' ? 'openai' : description.routing.gatewayProviderId;
      await this.#batchWrite(snapshot, [{ keyPath: 'model_provider', value: providerId, mergeStrategy: 'replace' }]);
      const updated = await this.#readConfig();
      const result = this.#describe(updated, state);
      if (fieldAt(updated.layer.config, 'model_provider').value !== providerId || result.routing.mode !== mode) {
        throw failure('INTEGRATION_CONFLICT', 'The selected provider is overridden or changed during the switch.');
      }
      return result;
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
        for (const field of state.fields.filter(field => field.keyPath.startsWith(`model_providers.${providerId}.`))) {
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
      if (!address || !['http:', 'https:'].includes(address.protocol) || sameBridgeEndpoint(address, new URL(this.#baseUrl))) {
        throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'The original provider address is unavailable or would route back to this bridge.');
      }
      return { providerId, config };
    });
  }

  /** Reconstruct the built-in provider's original route without following our private overlay. */
  originalNativeProvider() {
    return this.#serial(async () => {
      if (!this.#nativeBaseUrl) throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'Native gateway compatibility is not configured.');
      const [snapshot, state] = await Promise.all([this.#readConfig(), this.#readState()]);
      if (state && !this.#allMatch(snapshot, state, 'installed') && !this.#allMatch(snapshot, state, 'original')
        && !this.#upgradeBaselineMatches(snapshot, state)) {
        throw failure('INTEGRATION_CONFLICT', 'Provider fields were edited after installation. The original provider cannot be reconstructed safely.');
      }
      return { providerId: 'openai', config: { base_url: this.#originalNativeAddress(snapshot, state) } };
    });
  }

  install() {
    if (this.#nativeBaseUrl) return this.#serial(() => this.#installNative());
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
        delete state.upgradeBaselineCount;
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
    const fields = [this.#baseUrl, false, this.#gatewayKey, `${this.#baseUrl}/models`]
      .slice(0, version === 1 ? LEGACY_FIELDS.length : FIELDS.length).map((value, index) => ({
      keyPath: `model_providers.${providerId}.${FIELDS[index]}`,
      installed: { exists: true, value },
    }));
    if (version === NATIVE_STATE_VERSION) fields.push({ keyPath: 'openai_base_url', installed: { exists: true, value: this.#nativeBaseUrl } });
    return fields;
  }

  #allMatch(snapshot, state, which) {
    return state.fields.every(field => matches(fieldAt(snapshot.layer.config, field.keyPath), field[which]));
  }

  #upgradeBaselineMatches(snapshot, state) {
    if (state.version === NATIVE_STATE_VERSION) return state.phase === 'upgrading'
      && [3, 4].includes(state.upgradeBaselineCount)
      && state.fields.every((field, index) => matches(fieldAt(snapshot.layer.config, field.keyPath),
        index < state.upgradeBaselineCount ? field.installed : field.original));
    return state.version === 2 && state.phase === 'upgrading'
      && state.fields.every((field, index) => matches(fieldAt(snapshot.layer.config, field.keyPath),
        index < LEGACY_FIELDS.length ? field.installed : field.original));
  }

  #effectiveOriginal(snapshot, keyPath, original) {
    for (const layer of snapshot.layers) {
      if (layer.disabledReason) continue;
      const value = layer === snapshot.layer && original ? original : fieldAt(layer.config, keyPath);
      if (value.exists) return clone(value);
    }
    return { exists: false };
  }

  #higherControls(snapshot, state) {
    const fields = state?.fields ?? this.#desiredFields(snapshot.config.model_provider, NATIVE_STATE_VERSION);
    return snapshot.layers.slice(0, snapshot.layers.indexOf(snapshot.layer)).some(layer => !layer.disabledReason
      && ['model_provider', 'openai_base_url', ...fields.map(field => field.keyPath)].some(key => fieldAt(layer.config, key).exists));
  }

  #originalNativeAddress(snapshot, state) {
    const owned = state?.fields.find(field => field.keyPath === 'openai_base_url');
    const original = this.#effectiveOriginal(snapshot, 'openai_base_url', owned?.original);
    const chatGPTBase = snapshot.config.chatgpt_base_url ?? 'https://chatgpt.com/backend-api';
    const baseUrl = original.exists ? original.value : typeof chatGPTBase === 'string' ? `${chatGPTBase.replace(/\/+$/, '')}/codex` : null;
    let address;
    try { address = new URL(baseUrl); } catch {}
    if (!address || !['http:', 'https:'].includes(address.protocol) || address.username || address.password
      || sameBridgeEndpoint(address, new URL(this.#baseUrl))) {
      throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'The original native provider address is unavailable or would route back to this bridge.');
    }
    return baseUrl;
  }

  #originalCustomAddress(snapshot, state) {
    const providerId = state?.providerId ?? snapshot.config.model_provider;
    const keyPath = `model_providers.${providerId}.base_url`;
    const owned = state?.fields.find(field => field.keyPath === keyPath);
    const original = this.#effectiveOriginal(snapshot, keyPath, owned?.original);
    let address;
    try { address = new URL(original.value); } catch {}
    if (!address || !['http:', 'https:'].includes(address.protocol) || sameBridgeEndpoint(address, new URL(this.#baseUrl))) {
      throw failure('INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE', 'The original custom provider address is unavailable or would route back to this bridge.');
    }
    return original.value;
  }

  #nativeCoherent(snapshot, state) {
    return !state || this.#allMatch(snapshot, state, 'installed') || this.#allMatch(snapshot, state, 'original')
      || this.#upgradeBaselineMatches(snapshot, state);
  }

  #nativeProviderReason(provider) {
    if (!provider || typeof provider !== 'object' || provider.requires_openai_auth !== true) {
      return 'The existing custom provider must use requires_openai_auth = true.';
    }
    if (provider.wire_api !== undefined && provider.wire_api !== 'responses') return 'The existing provider must use the Responses API.';
    if (Object.keys(provider.http_headers || {}).some(key => key.toLowerCase() === HEADER_NAME.toLowerCase() && key !== HEADER_NAME)) {
      return 'The provider contains the gateway header under a different letter case.';
    }
    return null;
  }

  #describeNative(snapshot, state) {
    const providerId = snapshot.config.model_provider ?? 'openai';
    const candidateId = state?.providerId ?? providerId;
    const validCandidate = typeof candidateId === 'string' && /^[A-Za-z0-9_-]+$/.test(candidateId)
      && !['openai', 'ollama', 'lmstudio'].includes(candidateId);
    const coherent = this.#nativeCoherent(snapshot, state);
    const higher = this.#higherControls(snapshot, state);
    const expected = state && this.#desiredFields(state.providerId, state.version);
    const matchingEndpoint = !state || state.fields.every((field, index) => matches(field.installed, expected[index].installed));
    const providerReason = this.#nativeProviderReason(snapshot.config.model_providers?.[candidateId]);
    let nativeReason = null;
    try { this.#originalNativeAddress(snapshot, state); }
    catch { nativeReason = '原生模型的原始地址无效或指回本网关，请先检查其原始路由。'; }
    let customReason = null;
    try { this.#originalCustomAddress(snapshot, state); }
    catch { customReason = '自定义提供方的原始地址无效或指回本网关，请先检查其原始路由。'; }
    let reason = !coherent ? 'Provider fields were edited after installation. Restore refused to overwrite those changes.'
      : higher ? '更高优先级的配置固定了模型提供方或路由，请先解除覆盖。'
        : !matchingEndpoint ? 'The gateway address or key changed. Restore the previous connection first.'
          : !validCandidate ? 'Select an existing custom provider before connecting the gateway.' : providerReason || nativeReason || customReason;
    const hasNative = state?.version === NATIVE_STATE_VERSION;
    const allInstalled = hasNative && this.#allMatch(snapshot, state, 'installed');
    const allOriginal = hasNative && this.#allMatch(snapshot, state, 'original');
    const effectiveInstalled = allInstalled && state.fields.every(field => matches(fieldAt(snapshot.config, field.keyPath), field.installed));
    const configured = hasNative && coherent && (allInstalled || allOriginal);
    const needsUpgrade = !!state && (!hasNative || state.phase === 'upgrading' && !configured);
    const official = snapshot.config.model_providers?.openai;
    let chatGPTOverridden = false;
    if (snapshot.config.chatgpt_base_url != null) {
      try {
        const address = new URL(snapshot.config.chatgpt_base_url);
        chatGPTOverridden = address.protocol !== 'https:' || address.username !== '' || address.password !== ''
          || !['https://chatgpt.com', 'https://chat.openai.com'].includes(address.origin);
      } catch { chatGPTOverridden = true; }
    }
    const nativeOverridden = snapshot.config.openai_base_url != null || chatGPTOverridden
      || ['base_url', 'model_catalog_url'].some(key => official?.[key] != null);
    const nativeRestored = allOriginal && providerId === 'openai';
    const mode = effectiveInstalled && matchingEndpoint && !providerReason && !nativeReason && !customReason && ['openai', candidateId].includes(providerId) ? 'gateway'
      : providerId === 'openai' && !nativeOverridden && (!hasNative || allOriginal) ? 'official' : 'other';
    const canManage = coherent && !higher && validCandidate;
    const canGateway = !!state && canManage && matchingEndpoint && !providerReason && !nativeReason && !customReason;
    const canOfficial = !higher && coherent && (hasNative ? !nativeRestored
      : snapshot.config.openai_base_url == null && !chatGPTOverridden && !['base_url', 'model_catalog_url'].some(key => official?.[key] != null));
    if (!reason && nativeRestored && nativeOverridden) reason = '原生设置已恢复；原有自定义地址仍然生效。';
    return { installed: !!configured, configPath: this.#configPath, canInstall: canManage && matchingEndpoint && !providerReason && !nativeReason && !customReason
      && (!state || ['openai', candidateId].includes(providerId)),
      needsUpgrade, providerId,
      ...(reason ? { reason } : {}),
      routing: { supported: true, mode, providerId, gatewayProviderId: state?.providerId ?? null,
        canSwitchOfficial: (mode !== 'official' || needsUpgrade) && canOfficial,
        canSwitchGateway: canGateway && (mode !== 'gateway' || needsUpgrade),
        nativeThreadsSupported: true, nativeThreadsCovered: effectiveInstalled === true && matchingEndpoint, nativeSettingsRestored: nativeRestored,
        ...(reason ? { reason } : {}) } };
  }

  async #prepareNative(snapshot, state) {
    if (state?.version === NATIVE_STATE_VERSION) return state;
    const providerId = state?.providerId ?? snapshot.config.model_provider;
    const desired = this.#desiredFields(providerId, NATIVE_STATE_VERSION);
    const baselineCount = state && (this.#allMatch(snapshot, state, 'installed') ? state.fields.length
      : this.#upgradeBaselineMatches(snapshot, state) ? LEGACY_FIELDS.length : 0);
    const prepared = { version: NATIVE_STATE_VERSION, configPath: this.#configPath, providerId,
      phase: baselineCount ? 'upgrading' : 'prepared',
      ...(baselineCount ? { upgradeBaselineCount: baselineCount } : {}),
      fields: desired.map((field, index) => state?.fields[index] ? clone(state.fields[index])
        : { ...field, original: fieldAt(snapshot.layer.config, field.keyPath) }) };
    await this.#writeState(prepared, !state);
    return prepared;
  }

  async #finishNative(state) {
    if (state.phase !== 'installed' || hasOwn(state, 'upgradeBaselineCount')) {
      state.phase = 'installed'; delete state.upgradeBaselineCount;
      await this.#writeState(state);
    }
  }

  async #applyNative(snapshot, state, mode) {
    const which = mode === 'gateway' ? 'installed' : 'original';
    const providerId = mode === 'gateway' ? state.providerId : 'openai';
    const edits = state.fields.map(field => ({ keyPath: field.keyPath,
      value: field[which].exists ? field[which].value : null, mergeStrategy: 'replace' }));
    edits.push({ keyPath: 'model_provider', value: providerId, mergeStrategy: 'replace' });
    await this.#batchWrite(snapshot, edits);
    const updated = await this.#readConfig();
    if (!this.#allMatch(updated, state, which) || fieldAt(updated.layer.config, 'model_provider').value !== providerId
      || updated.config.model_provider !== providerId || this.#higherControls(updated, state)
      || which === 'installed' && !state.fields.every(field => matches(fieldAt(updated.config, field.keyPath), field.installed))) {
      throw failure('INTEGRATION_CONFLICT', 'The selected provider or route is overridden or changed during the switch.');
    }
    await this.#finishNative(state);
    return this.#describeNative(updated, state);
  }

  async #installNative() {
    const [snapshot, originalState] = await Promise.all([this.#readConfig(), this.#readState()]);
    const description = this.#describeNative(snapshot, originalState);
    if (!description.canInstall) throw failure('INTEGRATION_CONFLICT', description.reason || 'The provider cannot be connected.');
    if (description.routing.mode === 'gateway' && !description.needsUpgrade) {
      await this.#finishNative(originalState); return description;
    }
    const state = await this.#prepareNative(snapshot, originalState);
    return this.#applyNative(snapshot, state, 'gateway');
  }

  async #switchNative(mode) {
    if (!['official', 'gateway'].includes(mode)) throw failure('INTEGRATION_CONFLICT', 'Select either the official or gateway connection.');
    const [snapshot, originalState] = await Promise.all([this.#readConfig(), this.#readState()]);
    const description = this.#describeNative(snapshot, originalState);
    if (description.routing.mode === mode && !description.needsUpgrade) {
      if (originalState?.version === NATIVE_STATE_VERSION) await this.#finishNative(originalState);
      return description;
    }
    const available = mode === 'official' ? description.routing.canSwitchOfficial : description.routing.canSwitchGateway;
    if (!available) throw failure('INTEGRATION_CONFLICT', description.routing.reason || 'The requested connection is unavailable.');
    if (!originalState) {
      await this.#batchWrite(snapshot, [{ keyPath: 'model_provider', value: 'openai', mergeStrategy: 'replace' }]);
      const updated = await this.#readConfig();
      if ((updated.config.model_provider ?? 'openai') !== 'openai' || this.#higherControls(updated, null)) {
        throw failure('INTEGRATION_CONFLICT', 'The selected provider is overridden or changed during the switch.');
      }
      return this.#describeNative(updated, null);
    }
    const state = await this.#prepareNative(snapshot, originalState);
    return this.#applyNative(snapshot, state, mode);
  }

  #routing(snapshot, state, description) {
    const providerId = snapshot.config?.model_provider ?? 'openai';
    const gatewayProviderId = state?.providerId ?? null;
    const official = snapshot.config?.model_providers?.openai;
    let chatGPTOverridden = false;
    if (snapshot.config?.chatgpt_base_url != null) {
      try {
        const address = new URL(snapshot.config.chatgpt_base_url);
        chatGPTOverridden = address.protocol !== 'https:' || address.username !== '' || address.password !== ''
          || !['https://chatgpt.com', 'https://chat.openai.com'].includes(address.origin);
      } catch { chatGPTOverridden = true; }
    }
    // Do not call a custom endpoint stored under the built-in provider "official".
    const officialOverridden = snapshot.config?.openai_base_url != null || chatGPTOverridden
      || ['base_url', 'model_catalog_url'].some(key => official?.[key] != null);
    const higherLayer = snapshot.layers.slice(0, snapshot.layers.indexOf(snapshot.layer))
      .some(layer => !layer.disabledReason && fieldAt(layer.config, 'model_provider').exists);
    let gatewayReason = null;
    const provider = gatewayProviderId == null ? null : snapshot.config?.model_providers?.[gatewayProviderId];
    if (!state) gatewayReason = '尚未保存网关接入配置，请先完成 Codex 接入。';
    else if (description.needsUpgrade) gatewayReason = '请先更新已保存的网关模型路由。';
    else if (!description.installed || !state.fields.every(field => matches(fieldAt(snapshot.config, field.keyPath), field.installed))) {
      gatewayReason = '已保存的网关配置被修改或覆盖，请先检查 Codex 接入配置。';
    } else if (!state.fields.every((field, index) => matches(field.installed, this.#desiredFields(state.providerId, state.version)[index].installed))) {
      gatewayReason = '网关地址或密钥已变更，请先恢复并重新接入。';
    } else if (provider?.requires_openai_auth !== true || (provider.wire_api !== undefined && provider.wire_api !== 'responses')
      || Object.keys(provider.http_headers || {}).some(key => key.toLowerCase() === HEADER_NAME.toLowerCase() && key !== HEADER_NAME)) {
      gatewayReason = '已保存的提供方不再符合本网关的认证或协议要求。';
    }
    if (!gatewayReason) {
      try { this.#originalCustomAddress(snapshot, state); }
      catch { gatewayReason = '自定义提供方的原始地址无效或指回本网关，请先检查其原始路由。'; }
    }
    const mode = providerId === 'openai' && !officialOverridden ? 'official'
      : providerId === gatewayProviderId && !gatewayReason ? 'gateway' : 'other';
    const officialReason = officialOverridden ? '官方提供方包含自定义地址，请先检查其地址配置。' : null;
    return {
      supported: true, mode, providerId, gatewayProviderId,
      canSwitchOfficial: mode !== 'official' && !higherLayer && !officialReason,
      canSwitchGateway: mode !== 'gateway' && !higherLayer && !gatewayReason,
      ...(higherLayer ? { reason: '更高优先级的配置固定了模型提供方，请先解除覆盖。' }
        : gatewayReason || officialReason ? { reason: gatewayReason || officialReason } : {}),
    };
  }

  #describe(snapshot, state) {
    if (this.#nativeBaseUrl) return this.#describeNative(snapshot, state);
    const providerId = snapshot.config?.model_provider;
    const installed = !!state && this.#allMatch(snapshot, state, 'installed');
    const needsUpgrade = !!state && (state.version === 1 || (state.phase === 'upgrading' && !installed));
    const result = { installed, configPath: this.#configPath, canInstall: false, needsUpgrade };
    if (typeof providerId === 'string') result.providerId = providerId;
    const describeRouting = value => ({ ...value, routing: this.#routing(snapshot, state, value) });
    const refuse = reason => describeRouting({ ...result, reason });
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
    try { this.#originalCustomAddress(snapshot, state); }
    catch { return refuse('The original custom provider address is unavailable or would route back to this bridge.'); }
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
    return describeRouting({ ...result, canInstall: true });
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
    const validId = typeof state?.providerId === 'string' && /^[A-Za-z0-9_-]+$/.test(state.providerId)
      && !['openai', 'ollama', 'lmstudio'].includes(state.providerId);
    const desired = validId ? this.#desiredFields(state.providerId, state.version) : [];
    if (![1, STATE_VERSION, NATIVE_STATE_VERSION].includes(state?.version) || typeof state.configPath !== 'string' || !samePath(state.configPath, this.#configPath)
      || !validId || !['prepared', 'installed', 'restoring', ...(state.version >= 2 ? ['upgrading'] : [])].includes(state.phase)
      || state.version === NATIVE_STATE_VERSION && state.phase === 'upgrading' && ![3, 4].includes(state.upgradeBaselineCount)
      || state.version === NATIVE_STATE_VERSION && state.phase !== 'upgrading' && hasOwn(state, 'upgradeBaselineCount')
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
