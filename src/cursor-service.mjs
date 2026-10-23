import { join } from 'node:path';
import { CodeBuddyCredentialStore } from './codebuddy-credential-store.mjs';
import { BridgeError, readJson, writeJson } from './storage.mjs';

// Legacy defaults remain stable for existing configuration and offline fixtures.
// Production availability and variants come from the account's full SDK catalog.
export const CURSOR_TARGET_MODELS = Object.freeze([
  Object.freeze({ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }),
  Object.freeze({ id: 'grok-4.7', name: 'Grok 4.7' }),
]);
export const CURSOR_MODELS = Object.freeze([
  Object.freeze({ id: 'Cursor-gemini-4-argon', name: 'Cursor Gemini 4', upstream: 'gemini-4-argon' }),
  Object.freeze({ id: 'Cursor-grok-4.7', name: 'Cursor Grok 4.7', upstream: 'grok-4.7' }),
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const CAPABILITY_FLAGS = ['supportsImages', 'supportsVision', 'supportsImageInput', 'supportsTools', 'supportsToolCalls',
  'supportsParallelToolCalls', 'supportsReasoning', 'supportsStreaming'];
const NESTED_CAPABILITY_FLAGS = [...CAPABILITY_FLAGS, 'images', 'vision', 'imageInput', 'tools', 'toolCalls',
  'parallelToolCalls', 'reasoning', 'streaming'];
export function resolveCursorModel(id) {
  if (typeof id !== 'string' || !id.startsWith('Cursor-')) return null;
  const upstream = id.slice('Cursor-'.length);
  if (!ID.test(upstream)) return null;
  return CURSOR_MODELS.find(model => model.id === id) || { id, upstream, name: `Cursor ${upstream}` };
}
export function cursorEffortParameter(model) {
  for (const parameter of Array.isArray(model?.parameters) ? model.parameters : []) {
    if (!['reasoning_effort', 'reasoningEffort', 'effort', 'reasoning'].includes(parameter?.id) || !Array.isArray(parameter.values)) continue;
    const values = parameter.values.filter(option => CODEX_EFFORTS.has(option?.value));
    if (values.length) return { ...parameter, values };
  }
  return null;
}
export function cursorImageCapability(model) {
  const fields = ['supportsImages', 'supportsVision', 'supportsImageInput'];
  const values = [...fields.map(field => model?.[field]),
    ...[...fields, 'images', 'vision', 'imageInput'].map(field => model?.capabilities?.[field])];
  if (values.includes(false) || Array.isArray(model?.inputModalities) && !model.inputModalities.includes('image')) return false;
  return values.includes(true) || model?.inputModalities?.includes('image') ? true : null;
}
const unavailableReasons = Object.freeze({ account: '账号目录标记此模型不可用。',
  tools: '账号目录明确不支持工具调用，尚不能用于 Codex 工具对话。',
  streaming: '账号目录明确不支持当前适配所需的流式输出。',
  output: '此条目仅支持非文本输出，尚未适配 Codex 对话。' });
export function cursorModelAvailability(model) {
  if (!model || model.available === false || model.disabled === true || model.enabled === false) {
    return { available: false, reason: Object.values(unavailableReasons).includes(model?.reason) ? model.reason : unavailableReasons.account };
  }
  if (['supportsTools', 'supportsToolCalls'].some(field => model[field] === false || model.capabilities?.[field] === false)
    || model.capabilities?.tools === false || model.capabilities?.toolCalls === false) return { available: false, reason: unavailableReasons.tools };
  if (model.supportsStreaming === false || model.capabilities?.supportsStreaming === false || model.capabilities?.streaming === false) {
    return { available: false, reason: unavailableReasons.streaming };
  }
  if (Array.isArray(model.outputModalities) && !model.outputModalities.includes('text')) return { available: false, reason: unavailableReasons.output };
  return { available: true, reason: null };
}

function validKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[^\x21-\x7e]/.test(value);
}

function safeText(value, secret, limit = 320) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!text || (secret && text.includes(secret))) return null;
  return text.slice(0, limit);
}

function modelCatalog(value, secret) {
  if (!Array.isArray(value) || value.length > 4096) throw new BridgeError('Cursor 模型目录格式无法识别。', 502, 'cursor_catalog_invalid');
  const validId = id => typeof id === 'string' && ID.test(id) && (!secret || !id.includes(secret));
  const found = new Map();
  for (const item of value) {
    if (!validId(item?.id) || found.has(item.id)) continue;
    const model = { id: item.id, displayName: safeText(item.displayName, secret) || item.id };
    if (safeText(item.description, secret, 1000)) model.description = safeText(item.description, secret, 1000);
    const params = list => {
      if (!Array.isArray(list) || list.length > 128) throw new Error('Invalid parameters');
      const ids = new Set();
      return list.map(parameter => {
        if (!validId(parameter?.id) || ids.has(parameter.id) || !Array.isArray(parameter.values) || !parameter.values.length || parameter.values.length > 128) throw new Error('Invalid parameter');
        ids.add(parameter.id);
        const values = new Set();
        return { id: parameter.id,
          ...(safeText(parameter.displayName, secret) ? { displayName: safeText(parameter.displayName, secret) } : {}),
          values: parameter.values.map(option => {
            const value = safeText(option?.value, secret, 160);
            if (!value || value !== option.value || values.has(value)) throw new Error('Invalid value');
            values.add(value);
            return { value, ...(safeText(option.displayName, secret) ? { displayName: safeText(option.displayName, secret) } : {}) };
          }) };
      });
    };
    try {
      if (item.parameters !== undefined) model.parameters = params(item.parameters);
      if (item.variants !== undefined) {
        if (!Array.isArray(item.variants) || item.variants.length > 256) throw new Error('Invalid variants');
        model.variants = item.variants.map(variant => {
          if (!Array.isArray(variant?.params) || variant.params.length > 128) throw new Error('Invalid variant parameters');
          const result = { params: variant.params.map(parameter => {
            if (!validId(parameter?.id) || !safeText(parameter.value, secret, 160) || parameter.value !== safeText(parameter.value, secret, 160)) throw new Error('Invalid variant');
            return { id: parameter.id, value: parameter.value };
          }), displayName: safeText(variant.displayName, secret) || model.displayName };
          if (typeof variant.isDefault === 'boolean') result.isDefault = variant.isDefault;
          if (typeof variant.isMaxMode === 'boolean') result.isMaxMode = variant.isMaxMode;
          if (safeText(variant.description, secret, 1000)) result.description = safeText(variant.description, secret, 1000);
          return result;
        });
      }
      for (const field of CAPABILITY_FLAGS) if (typeof item[field] === 'boolean') model[field] = item[field];
      for (const field of ['contextWindow', 'maxInputTokens', 'maxOutputTokens']) {
        if (Number.isSafeInteger(item[field]) && item[field] > 0) model[field] = item[field];
      }
      for (const field of ['inputModalities', 'outputModalities']) {
        if (Array.isArray(item[field]) && item[field].length <= 4
          && item[field].every(modality => ['text', 'image', 'audio', 'video'].includes(modality))) model[field] = [...new Set(item[field])];
      }
      if (item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities)) {
        const capabilities = Object.fromEntries(NESTED_CAPABILITY_FLAGS
          .filter(field => typeof item.capabilities[field] === 'boolean').map(field => [field, item.capabilities[field]]));
        if (Object.keys(capabilities).length) model.capabilities = capabilities;
      }
      for (const field of ['available', 'disabled', 'enabled']) if (typeof item[field] === 'boolean') model[field] = item[field];
      if (cursorImageCapability(model) === false) {
        model.supportsImages = false;
        if (model.inputModalities) model.inputModalities = model.inputModalities.filter(modality => modality !== 'image');
      }
      const availability = cursorModelAvailability(model);
      if (!availability.available) Object.assign(model, availability);
      found.set(model.id, model);
    } catch { /* An incomplete model descriptor must not become an invented selection. */ }
  }
  return [...found.values()];
}

function safeProfile(value, record) {
  const secret = record.apiKey;
  const firstName = safeText(value?.userFirstName, secret), lastName = safeText(value?.userLastName, secret);
  return { email: safeText(value?.userEmail, secret) || safeText(record.email, secret),
    name: [firstName, lastName].filter(Boolean).join(' ') || null,
    userId: Number.isSafeInteger(value?.userId) && value.userId > 0 ? value.userId : null };
}

function loginUrl(value) {
  try {
    const url = new URL(value);
    if (typeof value !== 'string' || value.length > 8192 || url.protocol !== 'https:' || url.username || url.password ||
        url.hostname !== 'cursor.com' || url.port) throw new Error();
    return url.href;
  } catch { throw new BridgeError('Cursor 返回的授权地址无法识别。', 502, 'cursor_login_url_invalid'); }
}

function authenticationFailure(error) {
  return error?.name === 'AuthenticationError' || error?.status === 401 ||
    error?.statusCode === 401 || ['unauthenticated', 'authentication_error'].includes(error?.code);
}

/** Bridge-owned Cursor authorization and read-only metadata; never creates an agent. */
export async function startCursorService({ stateDir, sdkLoader = async () => import('@cursor/sdk'),
  credentialStore, getGatewayStatus = () => ({}), now = Date.now,
  metadataTtlMs = 30000, metadataTimeoutMs = 15000, loginUrlTimeoutMs = 30000,
  loginTimeoutMs = 20 * 60 * 1000 } = {}) {
  const configPath = join(stateDir, 'cursor.json');
  const store = credentialStore || new CodeBuddyCredentialStore({ path: join(stateDir, 'cursor-auth.dpapi.json') });
  let config, setupError = null, configurationError = null, record = null;
  try {
    const value = await readJson(configPath, {});
    const promptMode = value?.promptMode === undefined ? 'project-rules'
      : ['project-rules', 'system'].includes(value.promptMode) ? value.promptMode : null;
    if (promptMode === null) configurationError = 'Cursor promptMode 配置无效；仅支持 project-rules 或 system，渠道已停用。';
    config = { version: 1, enabled: value?.enabled === true, declaredPlan: 'Teams',
      promptMode,
      ...(Number.isSafeInteger(value?.teamId) && value.teamId > 0 ? { teamId: value.teamId } : {}) };
    if (configurationError) config.enabled = false;
  } catch {
    config = { version: 1, enabled: false, declaredPlan: 'Teams', promptMode: null };
    configurationError = 'Cursor 配置文件无法读取，渠道已停用。';
  }
  try {
    const value = await store.load();
    if (value != null) {
      if (value.version !== 1 || value.provider !== 'cursor' || !validKey(value.apiKey) || !Number.isSafeInteger(value.apiKeyExpiresAtMs)) throw new Error();
      record = { version: 1, provider: 'cursor', apiKey: value.apiKey, apiKeyExpiresAtMs: value.apiKeyExpiresAtMs,
        ...(safeText(value.email, value.apiKey) ? { email: safeText(value.email, value.apiKey) } : {}) };
    }
  } catch { setupError = 'Cursor 本桥凭证无法读取，请重新授权。'; }

  let closed = false, generation = 0, authorizationVersion = 0, metadataVersion = 0, rejectedCredential = false;
  let sdkPromise = null, cache = null, metadataPending = null, pendingLogin = null;
  let publicLogin = { state: 'not_started' }, mutationQueue = Promise.resolve();
  const serial = action => {
    const next = mutationQueue.then(action);
    mutationQueue = next.catch(() => {});
    return next;
  };
  const assertOpen = () => { if (closed) throw new BridgeError('Cursor 服务已停止。', 503, 'cursor_closed'); };
  const assertConfigured = () => { if (configurationError) throw new BridgeError(configurationError, 503, 'cursor_config_invalid'); };
  const usable = () => !closed && !configurationError && !rejectedCredential && record && record.apiKeyExpiresAtMs > now();
  const invalidate = () => { metadataVersion++; cache = null; metadataPending = null; };
  const sdk = async () => {
    if (!sdkPromise) sdkPromise = Promise.resolve().then(sdkLoader).then(value => {
      if (!value?.Cursor?.auth?.login || !value.Cursor.models?.list || !value.Cursor.me) throw new Error();
      return value.Cursor;
    }).catch(() => { sdkPromise = null; throw new BridgeError('Cursor SDK 无法加载，请检查安装。', 503, 'cursor_sdk_unavailable'); });
    return sdkPromise;
  };
  const cancelled = () => new BridgeError('本轮 Cursor 授权已取消。', 409, 'cursor_login_cancelled');
  function cancelLogin() {
    if (!pendingLogin) return;
    pendingLogin.abort.abort(); clearTimeout(pendingLogin.urlTimer); clearTimeout(pendingLogin.expiryTimer);
    pendingLogin.rejectUrl(cancelled()); pendingLogin = null;
  }
  function deadline(operation, onTimeout) {
    let timer;
    return Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new BridgeError('Cursor 元数据读取超时，请稍后重试。', 504, 'cursor_metadata_timeout'));
      }, metadataTimeoutMs);
      timer.unref?.();
    })]).finally(() => clearTimeout(timer));
  }
  async function metadata() {
    assertOpen();
    if (!usable()) return null;
    if (cache && cache.version === metadataVersion && now() - cache.checkedAt < metadataTtlMs) return cache;
    if (metadataPending) return metadataPending;
    const currentRecord = record, version = metadataVersion;
    const request = (async () => {
      let expired = false;
      try {
        const options = { apiKey: currentRecord.apiKey, ...(config.teamId ? { teamId: config.teamId } : {}) };
        const [identity, catalog] = await deadline((async () => {
          const cursor = await sdk();
          if (expired || closed || version !== metadataVersion || record !== currentRecord) return [];
          return Promise.allSettled([
            Promise.resolve().then(() => cursor.me(options)), Promise.resolve().then(() => cursor.models.list(options)),
          ]);
        })(), () => { expired = true; });
        if (closed || version !== metadataVersion || record !== currentRecord) return null;
        if ([identity, catalog].some(result => result.status === 'rejected' && authenticationFailure(result.reason))) rejectedCredential = true;
        const result = { version, checkedAt: now(), source: catalog.status === 'fulfilled' ? 'remote' : null,
          profile: safeProfile(identity.status === 'fulfilled' ? identity.value : null, currentRecord), models: [], error: null };
        if (catalog.status === 'fulfilled') result.models = modelCatalog(catalog.value, currentRecord.apiKey);
        else result.error = rejectedCredential ? 'Cursor 授权已失效，请重新登录。' : 'Cursor 模型目录暂不可用，请稍后重试。';
        if (identity.status === 'rejected' && !result.error) result.error = rejectedCredential ? 'Cursor 授权已失效，请重新登录。' : 'Cursor 账号资料暂不可用。';
        if (rejectedCredential) result.models = [];
        cache = result;
        return result;
      } catch (error) {
        if (closed || version !== metadataVersion || record !== currentRecord) return null;
        cache = { version, checkedAt: now(), source: null, models: [], profile: safeProfile(null, currentRecord),
          error: error?.code === 'cursor_sdk_unavailable' ? 'Cursor SDK 无法加载，请检查安装。' :
            error?.code === 'cursor_metadata_timeout' ? 'Cursor 元数据读取超时，请稍后重试。' : 'Cursor 模型目录暂不可用，请稍后重试。' };
        return cache;
      }
    })();
    metadataPending = request;
    void request.finally(() => { if (metadataPending === request) metadataPending = null; }).catch(() => {});
    return request;
  }
  function gatewayStatus() {
    let value;
    try { value = getGatewayStatus() || {}; } catch { value = {}; }
    return { running: value.running === true,
      ...Object.fromEntries(['requests', 'completed', 'failed', 'active'].map(name => [name,
        Number.isSafeInteger(value[name]) && value[name] >= 0 ? value[name] : 0])) };
  }

  return {
    get enabled() { return config.enabled === true; },
    get authorizationVersion() { return authorizationVersion; },
    get promptMode() { return config.promptMode; },
    async credential() {
      return usable() ? { apiKey: record.apiKey, apiKeyExpiresAtMs: record.apiKeyExpiresAtMs,
        ...(config.teamId ? { teamId: config.teamId } : {}) } : null;
    },
    async beginLogin() {
      assertOpen(); assertConfigured();
      generation++; authorizationVersion++; cancelLogin();
      const currentGeneration = generation, abort = new AbortController();
      let resolveUrl, rejectUrl;
      const urlPromise = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
      void urlPromise.catch(() => {});
      const attempt = { abort, resolveUrl, rejectUrl, urlTimer: null, expiryTimer: null, urlPublished: false };
      pendingLogin = attempt; publicLogin = { state: 'starting' };
      const current = () => !closed && currentGeneration === generation && pendingLogin === attempt && !abort.signal.aborted;
      try {
        await serial(async () => {
          if (!current()) throw cancelled();
          await writeJson(configPath, { ...config, enabled: true });
          if (current()) config.enabled = true;
        });
        if (!current()) throw cancelled();
      } catch (error) {
        if (current()) { publicLogin = { state: 'error', error: 'Cursor 授权准备失败，请重试。' }; cancelLogin(); }
        throw error?.code === 'cursor_login_cancelled' ? cancelled() : new BridgeError('Cursor 授权准备失败，请重试。', 500, 'cursor_login_failed');
      }
      const fail = (state, message) => {
        if (!current()) return;
        publicLogin = { state, error: message };
        abort.abort(); clearTimeout(attempt.urlTimer); clearTimeout(attempt.expiryTimer);
        rejectUrl(new BridgeError(message, 502, 'cursor_login_failed')); pendingLogin = null;
      };
      attempt.urlTimer = setTimeout(() => fail('error', 'Cursor 授权地址生成超时，请重试。'), loginUrlTimeoutMs);
      attempt.urlTimer.unref?.();
      attempt.expiryTimer = setTimeout(() => fail('expired', '本轮 Cursor 登录等待已超时，请重新发起。'), loginTimeoutMs);
      attempt.expiryTimer.unref?.();
      void (async () => {
        try {
          const cursor = await sdk();
          if (!current()) return;
          const result = await cursor.auth.login({ openBrowser: false, store: null, apiKeyName: 'Bifrost', signal: abort.signal,
            onLoginUrl: value => {
              if (!current()) return;
              try {
                const url = loginUrl(value);
                clearTimeout(attempt.urlTimer); publicLogin = { state: 'pending', url };
                attempt.urlPublished = true;
                resolveUrl({ url });
              } catch { fail('error', 'Cursor 返回的授权地址无法识别。'); }
            } });
          if (!current()) return;
          if (!attempt.urlPublished || !validKey(result?.apiKey) || !Number.isSafeInteger(result.apiKeyExpiresAtMs) || result.apiKeyExpiresAtMs <= now()) throw new Error();
          const candidate = { version: 1, provider: 'cursor', apiKey: result.apiKey, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
            ...(safeText(result.email, result.apiKey) ? { email: safeText(result.email, result.apiKey) } : {}) };
          await serial(async () => {
            if (!current()) return;
            await store.save(candidate);
            // Logout or another login can happen while DPAPI is writing. Its
            // newer state wins, including on disk before that operation returns.
            if (!current()) { if (record) await store.save(record); else await store.clear(); return; }
            record = candidate; authorizationVersion++; rejectedCredential = false; setupError = null; invalidate();
            publicLogin = { state: 'complete' };
            clearTimeout(attempt.urlTimer); clearTimeout(attempt.expiryTimer); pendingLogin = null;
          });
        } catch { fail('error', 'Cursor 授权未完成，请重新登录。'); }
      })();
      return urlPromise;
    },
    async getModels() {
      assertConfigured();
      const result = await metadata();
      if (result?.error && result.models.length === 0) throw new BridgeError(result.error, rejectedCredential ? 401 : 502, 'cursor_metadata_unavailable');
      return structuredClone(result?.models || []);
    },
    async status() {
      let result = null;
      if (!closed) result = await metadata();
      const authReady = Boolean(usable());
      return { configured: configurationError === null, enabled: config.enabled === true, authReady,
        promptMode: config.promptMode,
        preservesSystemPromptPriority: config.promptMode === null ? null : config.promptMode === 'system',
        profile: authReady ? structuredClone(result?.profile || safeProfile(null, record)) : null,
        plan: { declared: config.declaredPlan, verified: false },
        login: { ...publicLogin },
        catalog: { source: result?.source || null, checkedAt: result?.checkedAt ?? null,
          models: structuredClone(authReady ? result?.models || [] : []), liveVerified: authReady && result?.source === 'remote' },
        gateway: gatewayStatus(), error: configurationError || setupError || result?.error ||
          (rejectedCredential ? 'Cursor 授权已失效，请重新登录。' :
            record && record.apiKeyExpiresAtMs <= now() ? 'Cursor 授权已过期，请重新登录。' : null), manualVerification: true };
    },
    async logout() {
      generation++; authorizationVersion++; cancelLogin(); record = null; rejectedCredential = false; invalidate();
      publicLogin = { state: 'not_started' }; config.enabled = false;
      try {
        await serial(async () => { await store.clear(); await writeJson(configPath, config); });
        setupError = null;
      } catch { setupError = 'Cursor 本桥凭证清除失败，请重试。'; throw new BridgeError(setupError, 500, 'cursor_logout_failed'); }
      return { ok: true };
    },
    async close() {
      closed = true; generation++; authorizationVersion++; cancelLogin(); invalidate();
      await mutationQueue;
    },
  };
}
