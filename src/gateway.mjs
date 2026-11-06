import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { clientScope } from './client-scope.mjs';
import { once } from 'node:events';
import { BridgeError, redact } from './storage.mjs';
import { readModelRequestBody } from './request-body.mjs';
import { B_MODELS, bCatalogModels, mergeCatalog, resolveBModel, appendCodeBuddyModel, appendCodeBuddyModels, resolveCodeBuddyModel, appendCursorModels } from './models.mjs';
import { resolveCursorModel, cursorModelAvailability } from './cursor-service.mjs';
import { classifyDiagnosticFailure, normalizeDiagnosticRecord, responsesTerminalEvidence } from './request-diagnostics.mjs';
import { codexClient } from './clients/codex.mjs';
import { adaptCrossProviderHistory } from './protocols/cross-provider-history.mjs';

export function keyMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BridgeError('请求内容超过大小限制。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function backendPath(pathname) {
  const normalized = pathname.replace(/^\/(?:backend-api\/codex|v1)/, '');
  if (!['/models', '/responses', '/responses/compact', '/alpha/search'].includes(normalized)) return null;
  return normalized;
}

export function upstreamHeaders(incoming, credentials) {
  const headers = new Headers();
  const allowed = new Set(['content-type', 'content-encoding', 'accept', 'openai-beta',
    'originator', 'user-agent', 'session_id', 'conversation_id', 'session-id', 'thread-id',
    'x-codex-turn-state', 'x-codex-beta-features', 'x-request-id',
    'x-client-request-id', 'x-codex-turn-metadata', 'x-codex-thread-id',
    'x-codex-turn-id', 'x-codex-window-id', 'x-codex-client-id']);
  for (const [name, value] of Object.entries(incoming)) {
    if (allowed.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
  }
  // Client A credentials and cookies never cross this boundary.
  headers.set('Authorization', `Bearer ${credentials.value}`);
  headers.set('ChatGPT-Account-ID', credentials.accountId);
  if (!headers.has('originator')) headers.set('originator', 'codex_account_bridge');
  if (!headers.has('user-agent')) headers.set('user-agent', 'codex-account-bridge/0.1.0');
  return headers;
}

function accountAHeaders(incoming, gatewayKey) {
  const headers = new Headers();
  const blocked = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
    'x-account-bridge-key', ...(incoming.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  for (const [name, value] of Object.entries(incoming)) {
    if (!blocked.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
  }
  const authorization = headers.get('authorization');
  if (!authorization || keyMatches(authorization.replace(/^Bearer\s+/i, ''), gatewayKey)) {
    throw new BridgeError('原有模型需要当前 Codex 的账户 A 授权。', 401, 'account_a_auth_required');
  }
  const cookies = headers.get('cookie')?.split(';').filter(value => !value.trim().startsWith('bridge_session='));
  if (cookies?.some(value => value.trim())) headers.set('cookie', cookies.join(';'));
  else headers.delete('cookie');
  return headers;
}

function appendPath(baseUrl, suffix) {
  let address;
  try { address = new URL(baseUrl); } catch { throw new BridgeError('账户 A 的原始路由无效。', 503); }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) {
    throw new BridgeError('账户 A 的原始路由无效。', 503);
  }
  const relative = new URL(suffix, 'http://bridge.invalid');
  address.pathname = address.pathname.replace(/\/+$/, '') + relative.pathname;
  for (const [name, value] of relative.searchParams) address.searchParams.set(name, value);
  return address.href;
}

function parseModel(body) {
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new BridgeError('模型请求不是有效 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.model !== 'string' || !data.model) {
    throw new BridgeError('模型请求缺少 model。');
  }
  const alias = resolveBModel(data.model);
  if (!alias && /^b-/i.test(data.model)) throw new BridgeError('未知的 B 模型，已停止请求。', 400, 'unknown_b_model');
  const codeBuddy = resolveCodeBuddyModel(data.model);
  if (!codeBuddy && /^(?:claude-codebuddy-|codebuddy[-:/])/i.test(data.model)) {
    throw new BridgeError('未知的 CodeBuddy 模型，已停止请求。', 400, 'unknown_codebuddy_model');
  }
  const cursor = resolveCursorModel(data.model);
  if (!cursor && /^cursor[-:/]/i.test(data.model)) throw new BridgeError('未知的 Cursor 模型，已停止请求。', 400, 'unknown_cursor_model');
  return { data, alias, codeBuddy, cursor };
}

function accountCounters() { return { requests: 0, completed: 0, failed: 0, active: 0, lastModel: null, lastError: null }; }

function requestThreadId(headers) {
  return ['thread-id', 'x-codex-thread-id', 'conversation_id', 'session-id', 'session_id']
    .map(name => headers[name]).find(value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) ?? null;
}

function requestFork(headers, thread) {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const raw = headers['x-codex-turn-metadata'];
  if (!thread || typeof raw !== 'string' || raw.length > 32768) return null;
  try {
    const metadata = JSON.parse(raw);
    if (!uuid(metadata?.thread_id)
        || metadata.thread_id.toLowerCase() !== thread.toLowerCase()
        || !uuid(metadata.forked_from_thread_id) || metadata.forked_from_thread_id.toLowerCase() === thread.toLowerCase()) return null;
    const family = ['session-id', 'session_id'].map(name => headers[name]).find(uuid);
    // Candidate issuers only. A hint never authorizes state: the remote adapter
    // must authenticate it under the current user, source, model and credentials.
    return { parentSession: metadata.forked_from_thread_id.toLowerCase(),
      familySession: family ? family.toLowerCase() : null };
  } catch { return null; }
}

export class SseInspector {
  constructor(onEvent) { this.decoder = new TextDecoder(); this.text = ''; this.onEvent = onEvent; }
  push(bytes) {
    this.text += this.decoder.decode(bytes, { stream: true });
    if (this.text.length > 16 * 1024 * 1024) throw new BridgeError('上游 SSE 事件超过大小限制。', 502);
    let end;
    while ((end = this.text.search(/\r?\n\r?\n/)) !== -1) {
      const event = this.text.slice(0, end);
      const delimiter = this.text.slice(end).match(/^\r?\n\r?\n/)[0];
      this.text = this.text.slice(end + delimiter.length);
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      this.onEvent(parsed);
    }
  }
}

export class Gateway {
  constructor({ backend, gatewayKey, getAProvider, fetchImpl = fetch,
    upstream = 'https://chatgpt.com/backend-api/codex', catalogWaitMs = 1200, onUsage = async () => {},
    codeBuddyProvider = null, codeBuddyEnabled = () => codeBuddyProvider !== null, modelPolicy = null,
    isDraining = () => false, cursorProvider = null, cursorEnabled = () => cursorProvider !== null,
    getCursorModels = async () => [], getCodeBuddyModels = null,
    getCursorAuthorizationVersion = () => null, getCodeBuddyAuthorizationVersion = () => null,
    onDiagnostic = () => {}, getAuthorizationVersion = null, remoteSources = null, sourceEnabled = () => true,
    presentCatalog = data => data, getBCatalogPath = () => '/models', getBAuthorizationVersion = null }) {
    if (typeof getAProvider !== 'function') throw new TypeError('getAProvider is required for account routing.');
    if (codeBuddyProvider !== null && (typeof codeBuddyProvider.status !== 'function' || typeof codeBuddyProvider.request !== 'function') ||
        typeof codeBuddyEnabled !== 'function' || getCodeBuddyModels !== null && typeof getCodeBuddyModels !== 'function') throw new TypeError('Invalid CodeBuddy Responses provider.');
    if (cursorProvider !== null && (typeof cursorProvider.status !== 'function' || typeof cursorProvider.request !== 'function') ||
        typeof cursorEnabled !== 'function' || typeof getCursorModels !== 'function') throw new TypeError('Invalid Cursor Responses provider.');
    if (typeof getCursorAuthorizationVersion !== 'function' || typeof getCodeBuddyAuthorizationVersion !== 'function') throw new TypeError('Invalid account catalog version getters.');
    if (typeof onDiagnostic !== 'function' || getAuthorizationVersion !== null && typeof getAuthorizationVersion !== 'function' || typeof presentCatalog !== 'function') throw new TypeError('Invalid request diagnostic hooks.');
    if (typeof getBCatalogPath !== 'function' || getBAuthorizationVersion !== null && typeof getBAuthorizationVersion !== 'function') throw new TypeError('Invalid B catalog settings.');
    if (remoteSources !== null && ['models', 'model', 'request', 'status'].some(name => typeof remoteSources[name] !== 'function')) throw new TypeError('Invalid remote sources.');
    Object.assign(this, { backend, gatewayKey, getAProvider, fetchImpl, upstream, catalogWaitMs, onUsage,
      codeBuddyProvider, codeBuddyEnabled, modelPolicy, isDraining, cursorProvider, cursorEnabled, getCursorModels, getCodeBuddyModels,
      getCursorAuthorizationVersion, getCodeBuddyAuthorizationVersion, onDiagnostic, remoteSources, sourceEnabled, presentCatalog });
    this.getAuthorizationVersion = getAuthorizationVersion ?? (account => account === 'Cursor' ? getCursorAuthorizationVersion()
      : account === 'CodeBuddy' ? getCodeBuddyAuthorizationVersion() : account === 'Bifrost' ? remoteSources?.generation : null);
    this.getBCatalogPath = getBCatalogPath;
    this.getBAuthorizationVersion = getBAuthorizationVersion ?? (() => this.getAuthorizationVersion('B'));
    this.modelPolicy?.setAuthorizationVersionGetter?.('B', this.getBAuthorizationVersion);
    this.pendingRequests = 0;
    this.bCatalog = null; this.catalogRefresh = null;
    this.bCatalogs = new Map(); this.bCatalogRequests = new Map(); this.bCatalogIdentity = null;
    this.bModelDiscovery = { state: 'not_refreshed', count: 0 };
    this.threadTraffic = new Map();
    this.metrics = { requests: 0, completed: 0, failed: 0, active: 0, lastError: null, lastUsage: null,
      accounts: Object.fromEntries(['A', 'B', 'CodeBuddy', 'Cursor', ...(remoteSources ? ['Bifrost'] : [])].map(account => [account, accountCounters()])) };
  }

  traffic(threadId) { return structuredClone(this.threadTraffic.get(threadId) ?? null); }

  codeBuddyStatus() {
    return { running: this.codeBuddyProvider !== null && this.codeBuddyEnabled() === true,
      ...structuredClone(this.metrics.accounts.CodeBuddy) };
  }

  cursorStatus() {
    return { running: this.cursorProvider !== null && this.cursorEnabled() === true,
      ...structuredClone(this.metrics.accounts.Cursor) };
  }

  recordThread(headers, account, model) {
    const threadId = requestThreadId(headers);
    if (!threadId) return null;
    if (!this.threadTraffic.has(threadId)) {
      this.threadTraffic.set(threadId, { threadId, accounts: Object.fromEntries(Object.keys(this.metrics.accounts).map(name => [name,
        accountCounters()])) });
      if (this.threadTraffic.size > 256) this.threadTraffic.delete(this.threadTraffic.keys().next().value);
    }
    const counter = this.threadTraffic.get(threadId).accounts[account];
    counter.requests++; counter.lastModel = model;
    return counter;
  }

  async fetchUpstream(path, { method = 'GET', headers = {}, body, signal } = {}) {
    let credentials = await this.backend.credentials();
    const send = () => this.fetchImpl(`${this.upstream}${path}`, {
      method, headers: upstreamHeaders(headers, credentials), body, signal, redirect: 'error',
    });
    let result = await send();
    if (result.status === 401) {
      await result.body?.cancel();
      credentials = await this.backend.credentials({ force: true });
      result = await send();
    }
    return result;
  }

  async fetchAccountA(path, { headers, method = 'GET', body, signal, nativeCaller = false } = {}) {
    const { config } = await this.getAProvider({ native: nativeCaller });
    return this.fetchImpl(appendPath(config.base_url, path), {
      method, headers: accountAHeaders(headers ?? {}, this.gatewayKey), body, signal, redirect: 'error',
    });
  }

  async #bScope() {
    if (this.sourceEnabled('B') !== true) throw new BridgeError('订阅账号已停用或尚未登记。', 503, 'upstream_account_disabled');
    if (typeof this.backend?.credentials !== 'function') throw new BridgeError('订阅账号尚未接入。', 503, 'account_not_bound');
    const credential = await this.backend.credentials();
    if (this.sourceEnabled('B') !== true) throw new BridgeError('订阅账号已停用或尚未登记。', 503, 'upstream_account_disabled');
    const authorizationVersion = this.getBAuthorizationVersion();
    const identity = createHash('sha256').update(JSON.stringify([credential.accountId, credential.userId ?? null,
      credential.email ?? null, authorizationVersion])).digest('hex');
    return { identity, authorizationVersion };
  }

  async #assertBCatalog(entry) {
    const current = await this.#bScope();
    if (entry.identity !== current.identity || entry.authorizationVersion !== current.authorizationVersion
      || this.bCatalogs.get(entry.key) !== entry) throw new BridgeError('B 账号或目录已变化，请重新刷新。', 409, 'account_changed');
  }

  async #readBCatalogEntry(path, { signal, force = false } = {}) {
    let address;
    try { address = new URL(path, 'https://bifrost.invalid'); } catch {}
    if (typeof path !== 'string' || path.length > 4096 || !address || address.origin !== 'https://bifrost.invalid'
      || address.pathname !== '/models' || address.hash) throw new BridgeError('B 模型目录地址无效。', 400, 'invalid_model_catalog');
    address.searchParams.sort(); path = `/models${address.search}`;
    const scope = await this.#bScope(), key = `${scope.identity}:${path}`;
    if (this.bCatalogIdentity !== scope.identity) {
      this.bCatalogs.clear(); this.bCatalogRequests.clear(); this.bCatalog = null;
      this.bCatalogIdentity = scope.identity;
    }
    if (this.bCatalogRequests.has(key)) return this.bCatalogRequests.get(key);
    const cached = this.bCatalogs.get(key);
    if (!force && cached?.expiresAt > Date.now()) return cached;
    if (this.bCatalogRequests.size >= 16) throw new BridgeError('B 目录正在查询，请稍后刷新。', 503, 'model_catalog_busy');
    const pending = Promise.resolve().then(async () => {
      try {
        const response = await this.fetchUpstream(path, { signal: signal ?? AbortSignal.timeout(10_000) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new BridgeError(`账户 B 的模型目录暂不可用（HTTP ${response.status}）。`, 502, 'model_catalog_unavailable');
        }
        const data = await response.json();
        bCatalogModels(data);
        const current = await this.#bScope();
        if (scope.identity !== current.identity || scope.authorizationVersion !== current.authorizationVersion) {
          throw new BridgeError('B 账号已变化，请重新刷新目录。', 409, 'account_changed');
        }
        const entry = { ...scope, key, path, expiresAt: Date.now() + 300_000, data };
        this.bCatalogs.set(key, entry); this.bCatalog = entry;
        while (this.bCatalogs.size > 16) this.bCatalogs.delete(this.bCatalogs.keys().next().value);
        return entry;
      } catch (error) {
        if (this.bCatalogIdentity === scope.identity && this.bCatalogRequests.get(key) === pending) {
          this.bCatalogs.delete(key);
          if (this.bCatalog?.key === key) this.bCatalog = null;
        }
        throw error;
      } finally {
        if (this.bCatalogRequests.get(key) === pending) this.bCatalogRequests.delete(key);
        if (this.catalogRefresh === pending) this.catalogRefresh = null;
      }
    });
    this.bCatalogRequests.set(key, pending); this.catalogRefresh = pending;
    return pending;
  }

  async readBCatalog(path = this.getBCatalogPath(), options = {}) {
    const entry = await this.#readBCatalogEntry(path, options);
    await this.#assertBCatalog(entry);
    return structuredClone(entry.data);
  }

  async refreshBModels({ path = this.getBCatalogPath(), force = false, signal, complete = true } = {}) {
    const authorizationVersion = this.getBAuthorizationVersion();
    const previousCatalog = this.bCatalog;
    let entry = null;
    try {
      entry = await this.#readBCatalogEntry(path, { force, signal });
      await this.#assertBCatalog(entry);
      const models = bCatalogModels(entry.data);
      if (this.modelPolicy) {
        const known = new Set(this.modelPolicy.snapshot().models.map(model => model.id));
        const defaults = B_MODELS.filter(model => !known.has(model.id) && models.some(source => source.slug === model.id));
        if (defaults.length) await this.modelPolicy.observe({ models: defaults }, 'B', {
          defaultEnabled: true, authorizationVersion: entry.authorizationVersion,
        });
        await this.modelPolicy.observe({ models }, 'B', {
          defaultEnabled: false, complete, authorizationVersion: entry.authorizationVersion,
        });
      }
      await this.#assertBCatalog(entry);
      this.bModelDiscovery = { state: 'ready', count: models.length, checkedAt: new Date().toISOString() };
      return models;
    } catch (error) {
      // An old request must not invalidate a newer identity's successful catalog.
      if (authorizationVersion === this.getBAuthorizationVersion()
        && (!this.bCatalog || this.bCatalog === previousCatalog || this.bCatalog === entry)) {
        const message = this.sourceEnabled('B') === true ? 'B 账号目录暂不可用，请检查登录后刷新。' : 'B 账号已停用或尚未登记。';
        if (this.modelPolicy) await this.modelPolicy.observe({ models: [] }, 'B', {
          defaultEnabled: false, complete: true, authorizationVersion, unavailableReason: message,
        });
        if (authorizationVersion === this.getBAuthorizationVersion()) this.bModelDiscovery = {
          state: this.sourceEnabled('B') === true ? 'error' : 'disabled', count: 0, checkedAt: new Date().toISOString(), message,
        };
      }
      throw error;
    }
  }

  async catalog(req, res, url, signal, nativeCaller = false) {
    const started = Date.now();
    let aCatalog = { models: [] };
    if (this.sourceEnabled('A') === true) {
      const response = await this.fetchAccountA(`/models${url.search}`, { headers: req.headers, signal, nativeCaller });
      if (!response.ok) {
        res.writeHead(response.status, { 'Cache-Control': 'no-store', 'Content-Type': response.headers.get('content-type') || 'application/json' });
        res.end(await response.text()); return;
      }
      aCatalog = await response.json();
      if (!Array.isArray(aCatalog.models)) throw new BridgeError('账户 A 的完整模型目录格式无效。', 502);
    }
    // B- is reserved for independently authenticated B routes, including aliases
    // that have disappeared from B's current directory.
    let data = mergeCatalog(aCatalog, { models: [] });
    const codeBuddyVersion = this.getCodeBuddyAuthorizationVersion(), cursorVersion = this.getCursorAuthorizationVersion();
    const codeBuddyCurrent = () => this.codeBuddyEnabled() === true && this.getCodeBuddyAuthorizationVersion() === codeBuddyVersion;
    const cursorCurrent = () => this.cursorEnabled() === true && this.getCursorAuthorizationVersion() === cursorVersion;
    const codeBuddyMetadata = this.codeBuddyProvider !== null && this.codeBuddyEnabled() === true
      ? Promise.resolve().then(() => this.getCodeBuddyModels ? this.getCodeBuddyModels() : this.codeBuddyProvider.status()).catch(() => null) : Promise.resolve(null);
    const cursorMetadata = this.cursorProvider !== null && this.cursorEnabled() === true
      ? Promise.resolve().then(async () => {
        const metadata = await this.cursorProvider.status();
        return metadata?.authenticated === true && metadata.ready === true && metadata.modelAvailable === true
          ? this.getCursorModels() : null;
      }).catch(() => null) : Promise.resolve(null);
    const bPath = `/models${url.search}`;
    let bEntry = null;
    const refresh = this.refreshBModels({ path: bPath, complete: false, signal: AbortSignal.timeout(10_000) })
      .then(async () => {
        const entry = await this.#readBCatalogEntry(bPath);
        await this.#assertBCatalog(entry);
        return entry;
      });
    let timer;
    try {
      // The native catalog deadline is short. Cached metadata is usable immediately;
      // credential reads and slow B refreshes continue in the background.
      const remaining = Math.max(0, Math.min(this.catalogWaitMs, 4000 - (Date.now() - started)));
      const entry = await Promise.race([
        refresh,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('B 目录刷新中，暂保留 A 模型。', 503)), remaining); }),
      ]);
      data = mergeCatalog(aCatalog, entry.data); bEntry = entry;
    }
    catch (error) {
      // B login or catalog availability must not prevent selecting A models.
      if (error.code === 'model_alias_conflict') throw error;
      this.metrics.lastError = redact(error.message);
    }
    finally { clearTimeout(timer); void refresh.catch(() => {}); }
    try {
      const remaining = Math.max(0, Math.min(this.catalogWaitMs, 4000 - (Date.now() - started)));
      const metadata = await Promise.race([codeBuddyMetadata,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); })]);
      if (Array.isArray(metadata) && codeBuddyCurrent()) {
        if (this.modelPolicy) await this.modelPolicy.observe({ models: metadata }, 'CodeBuddy', { defaultEnabled: false, authorizationVersion: codeBuddyVersion });
        if (codeBuddyCurrent()) data = appendCodeBuddyModels(data, metadata);
        else if (this.modelPolicy) await this.modelPolicy.observe({ models: [] }, 'CodeBuddy', { complete: true, defaultEnabled: false,
          unavailableReason: 'CodeBuddy 授权已变化，请刷新账号目录。', authorizationVersion: this.getCodeBuddyAuthorizationVersion() });
        this.metrics.accounts.CodeBuddy.lastError = null;
      } else if (metadata?.authenticated === true && metadata.ready === true && metadata.modelAvailable === true &&
          codeBuddyCurrent()) {
        data = appendCodeBuddyModel(data);
        this.metrics.accounts.CodeBuddy.lastError = null;
      }
    } catch (error) {
      // A CodeBuddy failure must not replace or prevent the original A/B catalog.
      if (error.code === 'model_alias_conflict') throw error;
      this.metrics.accounts.CodeBuddy.lastError = redact(error.message);
    } finally { clearTimeout(timer); }
    try {
      const remaining = Math.max(0, Math.min(this.catalogWaitMs, 4000 - (Date.now() - started)));
      const sourceModels = await Promise.race([cursorMetadata,
        new Promise(resolveWait => { timer = setTimeout(() => resolveWait(null), remaining); })]);
      if (Array.isArray(sourceModels) && cursorCurrent()) {
        const entries = sourceModels.map(source => ({ id: `Cursor-${source.id}`,
          name: source.displayName ? `Cursor ${source.displayName}` : resolveCursorModel(`Cursor-${source.id}`)?.name ?? `Cursor ${source.id}`,
          ...cursorModelAvailability(source), source: source.source ?? 'account-catalog' }));
        if (this.modelPolicy) await this.modelPolicy.observe({ models: entries }, 'Cursor', { defaultEnabled: false, authorizationVersion: cursorVersion });
        if (cursorCurrent()) data = appendCursorModels(data, sourceModels);
        else if (this.modelPolicy) await this.modelPolicy.observe({ models: [] }, 'Cursor', { complete: true, defaultEnabled: false,
          unavailableReason: 'Cursor 授权已变化，请刷新账号目录。', authorizationVersion: this.getCursorAuthorizationVersion() });
      }
    } catch (error) {
      if (error.code === 'model_alias_conflict') throw error;
      this.metrics.accounts.Cursor.lastError = redact(error.message);
    } finally { clearTimeout(timer); }
    if (this.remoteSources) {
      await this.observeRemotes();
      const entries = codexClient.catalog(this.remoteSources.models()).models;
      const ids = new Set(data.models.map(model => model.slug ?? model.id));
      if (entries.some(model => ids.has(model.slug))) throw new BridgeError('远端模型别名与本地目录冲突。', 503, 'model_alias_conflict');
      const firstPriority = data.models.reduce((last, model) => Number.isFinite(model?.priority) ? Math.max(last, model.priority) : last, data.models.length - 1) + 1;
      data = { ...data, models: [...data.models, ...entries.map((model, index) => ({ ...model, priority: firstPriority + index }))] };
    }
    if (this.modelPolicy) {
      await this.modelPolicy.observe(data);
      data = this.modelPolicy.filterCatalog(data);
    }
    let bCurrent = false;
    if (bEntry) {
      try { await this.#assertBCatalog(bEntry); bCurrent = true; }
      catch { /* A stale B directory must not affect the current caller's A models. */ }
    }
    // Recheck both sources after all awaited metadata/policy operations. No
    // await separates this filter from the committed catalog response.
    data.models = data.models.filter(model => (bCurrent && bEntry.authorizationVersion === this.getBAuthorizationVersion() || !resolveBModel(model?.slug ?? model?.id))
      && (codeBuddyCurrent() || !resolveCodeBuddyModel(model?.slug ?? model?.id))
      && (cursorCurrent() || !resolveCursorModel(model?.slug ?? model?.id))
      && (!/^remote\//i.test(model?.slug ?? model?.id) || this.remoteSources?.model(model.slug ?? model.id))
      && this.sourceEnabled(this.remoteSources?.model(model.slug ?? model.id) ? 'Bifrost' : resolveCursorModel(model.slug ?? model.id)
        ? 'Cursor' : resolveCodeBuddyModel(model.slug ?? model.id) ? 'CodeBuddy' : resolveBModel(model.slug ?? model.id) ? 'B' : 'A', model.slug ?? model.id));
    data = this.presentCatalog(data);
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  async observeRemotes() {
    if (this.modelPolicy && this.remoteSources) await this.modelPolicy.observe({ models: this.remoteSources.models().map(model => ({
      ...model, available: true,
    })) }, 'Bifrost', { complete: true, defaultEnabled: true, authorizationVersion: this.remoteSources.generation });
  }

  async proxy(req, res, url, { nativeCaller = false } = {}) {
    this.pendingRequests++;
    const path = backendPath(url.pathname);
    const diagnostic = ['/responses', '/responses/compact'].includes(path) ? {
      requestId: randomUUID(), time: new Date().toISOString(), started: performance.now(), stage: 'authentication',
      account: null, model: null, upstreamModel: null, httpStatus: null, firstResponseMs: null,
      complete: false, delivered: false, terminalVerified: false, authorizationVersion: null,
    } : null;
    try { return await this.forward(req, res, url, diagnostic, { nativeCaller }); }
    catch (error) {
      if (diagnostic) {
        if (!diagnostic.failure) diagnostic.failure = classifyDiagnosticFailure(error, { stage: diagnostic.stage,
          httpStatus: diagnostic.httpStatus, interrupted: diagnostic.interrupted });
        diagnostic.httpStatus ??= Number.isInteger(error?.status) ? error.status : null;
      }
      throw error;
    } finally {
      if (diagnostic) {
        const complete = diagnostic.complete && diagnostic.delivered && diagnostic.httpStatus >= 200 && diagnostic.httpStatus < 300 && !diagnostic.failure;
        const status = diagnostic.interrupted ? 'interrupted' : diagnostic.failure ? 'failed'
          : complete && diagnostic.toolPending ? 'tool_pending' : complete ? 'completed' : 'incomplete';
        const record = normalizeDiagnosticRecord({ ...diagnostic, status, usage: diagnostic.usage,
          durationMs: diagnostic.durationMs ?? performance.now() - diagnostic.started,
          ...(diagnostic.failure ?? { errorCode: 'incomplete_response', failureStage: 'upstream_response' }) });
        if (record) {
          try { Promise.resolve(this.onDiagnostic({ ...record, terminalVerified: status === 'completed' && diagnostic.terminalVerified === true,
            authorizationVersion: diagnostic.authorizationVersion })).catch(() => {}); } catch { /* Diagnostics must never change forwarding. */ }
        }
      }
      this.pendingRequests--;
    }
  }

  async forward(req, res, url, diagnostic = null, { nativeCaller = false } = {}) {
    const key = req.headers['x-account-bridge-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!keyMatches(key, this.gatewayKey)) throw new BridgeError('网关认证失败。', 401, 'invalid_gateway_key');
    if (diagnostic) diagnostic.stage = 'routing';
    if (this.isDraining()) throw new BridgeError('网关正在重启，请稍后重试。', 503, 'gateway_restarting');
    const path = backendPath(url.pathname);
    if (!path) throw new BridgeError('未实现该模型接口。', 404);
    if ((path === '/models' && req.method !== 'GET') || (path !== '/models' && req.method !== 'POST')) {
      throw new BridgeError('请求方法不支持。', 405);
    }
    const inference = path === '/responses';
    const modelRequest = inference || path === '/responses/compact';
    const requestId = diagnostic?.requestId ?? randomUUID();
    if (inference) { this.metrics.requests++; this.metrics.active++; }
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let complete = false, delivered = false, requestError = null, accountMetrics = null, threadMetrics = null;
    let usage = null, responseId = null, httpStatus = null, route = null, response = null;
    let inspectJson = false, jsonBytes = 0;
    const jsonChunks = [];
    const readJsonUsage = (updateCompletion = false) => {
      if (!inspectJson || jsonBytes > 8 * 1024 * 1024) return;
      try {
        const data = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
        usage = data.usage ?? null; responseId = data.id ?? null;
        if (typeof data.error?.message === 'string') requestError = redact(data.error.message);
        if (diagnostic && data.error) diagnostic.failure = classifyDiagnosticFailure({ code: data.error.code ?? data.error.type,
          sourceDiagnostics: data.error.sourceDiagnostics },
          { httpStatus, stage: 'upstream_response' });
        if (updateCompletion) complete = path === '/responses/compact'
          ? httpStatus >= 200 && httpStatus < 300 : data.status === 'completed';
        if (diagnostic && updateCompletion && path === '/responses') Object.assign(diagnostic, responsesTerminalEvidence(data));
        if (!response?.bridgeUsage) this.metrics.lastUsage = usage;
      } catch { /* Incomplete JSON has unknown usage. Never estimate it. */ }
    };
    try {
      if (path === '/models') { await this.catalog(req, res, url, abort.signal, nativeCaller); return; }
      if (diagnostic) diagnostic.stage = 'validation';
      const requestBody = await readModelRequestBody(req, { signal: abort.signal,
        ...(modelRequest ? {} : { wireLimitBytes: 64 * 1024 * 1024, decodedLimitBytes: 64 * 1024 * 1024 }) });
      const originalBody = requestBody.wireBody;
      if (diagnostic) diagnostic.requestBodyDiagnostics = requestBody.diagnostics;
      {
        const parsed = parseModel(requestBody.body);
        let data = parsed.data;
        const { alias, codeBuddy, cursor } = parsed;
        const remote = this.remoteSources?.model(data.model);
        if (/^remote\//i.test(data.model) && !remote) throw new BridgeError('远端模型未就绪或已撤销权限，请刷新目录。', 503, 'remote_model_unavailable');
        if (remote) await this.observeRemotes();
        if (diagnostic) {
          diagnostic.account = remote ? 'Bifrost' : cursor ? 'Cursor' : codeBuddy ? 'CodeBuddy' : alias ? 'B' : 'A';
          diagnostic.model = data.model; diagnostic.upstreamModel = remote?.upstreamModel ?? cursor?.upstream ?? alias?.upstream ?? data.model;
          diagnostic.stage = 'routing';
          try { diagnostic.authorizationVersion = this.getAuthorizationVersion(diagnostic.account); } catch { /* Unknown authorization generation is not guessed. */ }
        }
        const account = remote ? 'Bifrost' : cursor ? 'Cursor' : codeBuddy ? 'CodeBuddy' : alias ? 'B' : 'A';
        if (this.sourceEnabled(account, data.model) !== true) throw new BridgeError('此上游账号已停用或尚未登记。', 503, 'upstream_account_disabled');
        if (alias && (this.modelPolicy || !B_MODELS.some(model => model.id === alias.id))) {
          // Explicitly disabled models need no metadata request. Persisted
          // selections still recheck the current B directory after a restart.
          if (this.modelPolicy?.snapshot().disabledModels.includes(data.model)) this.modelPolicy.assertEnabled(data.model);
          const models = await this.refreshBModels({ signal: abort.signal });
          if (!models.some(model => model.slug === alias.id)) {
            if (this.modelPolicy?.snapshot().models.some(model => model.id === alias.id)) this.modelPolicy.assertEnabled(alias.id);
            throw new BridgeError('当前 B 账号目录没有此模型，请刷新目录后选择。', 400, 'unknown_b_model');
          }
        }
        this.modelPolicy?.assertEnabled(data.model);
        route = { account, model: data.model, upstreamModel: remote?.upstreamModel ?? cursor?.upstream ?? alias?.upstream ?? data.model };
        accountMetrics = this.metrics.accounts[account];
        if (inference) {
          accountMetrics.requests++; accountMetrics.active++; accountMetrics.lastModel = data.model;
          threadMetrics = this.recordThread(req.headers, account, data.model);
          if (threadMetrics) threadMetrics.active++;
        }
        const scope = clientScope(req.headers['x-bifrost-client-scope']);
        const session = requestThreadId(req.headers) ?? '', fork = requestFork(req.headers, session);
        const history = await adaptCrossProviderHistory(data, { target: account, clientScope: scope, session, fork, signal: abort.signal,
          openCodeBuddyCompaction: typeof this.codeBuddyProvider?.openCompactionForHandoff === 'function'
            ? (token, options) => this.codeBuddyProvider.openCompactionForHandoff(token, options) : null,
          inspectRemoteState: typeof this.remoteSources?.inspectStateForHandoff === 'function'
            ? (token, options) => this.remoteSources.inspectStateForHandoff(token, options) : null,
          openRemoteCompaction: typeof this.remoteSources?.openCompactionForHandoff === 'function'
            ? (token, options) => this.remoteSources.openCompactionForHandoff(token, options) : null });
        data = history.body;
        if (remote) {
          if (diagnostic) diagnostic.stage = 'upstream_request';
          response = await this.remoteSources.request({ path: `${path}${url.search}`, body: data,
            scope, session, fork, signal: abort.signal });
        } else if (codeBuddy || cursor) {
          const provider = cursor ? this.cursorProvider : this.codeBuddyProvider;
          if (provider === null || (cursor ? this.cursorEnabled() : this.codeBuddyEnabled()) !== true) {
            throw new BridgeError(`${cursor ? 'Cursor' : 'CodeBuddy'} Responses 通道尚未启用。`, 503, cursor ? 'cursor_unavailable' : 'codebuddy_unavailable');
          }
          if (diagnostic) diagnostic.stage = 'upstream_request';
          // Only content negotiation reaches the adapter. Neither A/B auth nor
          // the management key, cookies or native routing headers cross over.
          response = await provider.request({ path: `${path}${url.search}`,
            clientScope: scope,
            body: Buffer.from(JSON.stringify(data)), headers: new Headers({
              'content-type': 'application/json', ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
            }), signal: abort.signal });
          if (cursor && typeof response?.bridgePreflight === 'function') response = await response.bridgePreflight();
          if (typeof response?.bridgeModel === 'string') route.upstreamModel = response.bridgeModel;
        } else {
          let body = originalBody;
          if (alias) data.model = alias.upstream;
          if (alias || history.changed) body = Buffer.from(JSON.stringify(data));
          const headers = { ...req.headers };
          if (alias || history.changed) { delete headers['content-encoding']; delete headers['content-length']; }
          const options = { method: req.method, headers, body, signal: abort.signal, nativeCaller };
          if (diagnostic) diagnostic.stage = 'upstream_request';
          response = alias ? await this.fetchUpstream(`${path}${url.search}`, options) :
            await this.fetchAccountA(`${path}${url.search}`, options);
        }
      }
      httpStatus = response.status;
      if (diagnostic) {
        diagnostic.httpStatus = httpStatus; diagnostic.upstreamModel = route.upstreamModel; diagnostic.stage = 'upstream_response';
        if (!response.ok) diagnostic.failure = classifyDiagnosticFailure(null, { httpStatus, stage: 'upstream_response' });
      }
      const outputHeaders = { 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
      for (const [name, value] of response.headers) {
        if (['content-type', 'retry-after', 'x-request-id'].includes(name) ||
          name.startsWith('x-codex-') || name.startsWith('x-ratelimit-')) outputHeaders[name] = value;
      }
      res.writeHead(response.status, outputHeaders);
      const sse = new SseInspector((event) => {
        if (event.response?.id) responseId = event.response.id;
        if (event.response?.usage) usage = event.response.usage;
        if (event.type === 'response.completed' && event.response?.status === 'completed') {
          complete = true;
          if (diagnostic) Object.assign(diagnostic, responsesTerminalEvidence(event.response));
          if (!response?.bridgeUsage) this.metrics.lastUsage = event.response.usage ?? null;
        }
        if (['error', 'response.failed'].includes(event.type)) {
          if (diagnostic) diagnostic.failure = classifyDiagnosticFailure({ code: event.error?.code ?? event.error?.type ?? event.response?.error?.code,
            sourceDiagnostics: event.error?.sourceDiagnostics ?? event.response?.error?.sourceDiagnostics },
            { httpStatus, stage: 'stream' });
          requestError = redact(event.error?.message ?? event.response?.error?.message ?? '模型请求失败');
          this.metrics.lastError = requestError;
        }
      });
      inspectJson = modelRequest && (path === '/responses/compact' || response.headers.get('content-type')?.includes('application/json'));
      if (response.body) {
        for await (const bytes of response.body) {
          if (diagnostic) {
            if (diagnostic.firstResponseMs === null && bytes.byteLength) diagnostic.firstResponseMs = performance.now() - diagnostic.started;
            diagnostic.stage = 'stream';
          }
          if (inference && !inspectJson) sse.push(bytes);
          if (inspectJson) {
            jsonBytes += bytes.length;
            if (jsonBytes <= 8 * 1024 * 1024) jsonChunks.push(bytes);
          }
          if (diagnostic) diagnostic.stage = 'downstream';
          if (!res.write(bytes)) await once(res, 'drain', { signal: abort.signal });
          if (diagnostic) diagnostic.stage = 'stream';
        }
      }
      readJsonUsage(true);
      if (path === '/responses/compact') complete = response.ok;
      res.end();
      delivered = true;
      if (inference) {
        if (complete) {
          this.metrics.completed++; accountMetrics.completed++; accountMetrics.lastError = null;
          if (threadMetrics) threadMetrics.completed++;
          this.metrics.lastError = null;
        } else {
          this.metrics.failed++; accountMetrics.failed++; if (threadMetrics) threadMetrics.failed++;
          this.metrics.lastError = requestError ?? `上游请求未完成（HTTP ${response.status}）。`;
          accountMetrics.lastError = this.metrics.lastError;
        }
      }
    } catch (error) {
      if (inference) {
        this.metrics.failed++; if (accountMetrics) accountMetrics.failed++; if (threadMetrics) threadMetrics.failed++;
        this.metrics.lastError = redact(error.message);
        if (accountMetrics) accountMetrics.lastError = this.metrics.lastError;
      }
      throw error;
    } finally {
      if (diagnostic) Object.assign(diagnostic, { complete, delivered, httpStatus, usage,
        interrupted: abort.signal.aborted, durationMs: performance.now() - diagnostic.started });
      if (modelRequest && route) {
        // A complete JSON chunk may already have arrived before downstream write failed.
        readJsonUsage();
        if (response?.bridgeUsage) {
          try { usage = await response.bridgeUsage; }
          catch { usage = null; }
          this.metrics.lastUsage = usage;
        }
        if (diagnostic) diagnostic.usage = usage;
        try {
          await this.onUsage({ requestId, time: new Date().toISOString(), ...route,
            threadId: requestThreadId(req.headers), responseId, httpStatus,
            status: complete && delivered ? 'completed' : abort.signal.aborted ? 'interrupted' : 'failed', usage });
          this.metrics.usageError = null;
        } catch (error) { this.metrics.usageError = redact(error.message); }
      }
      if (inference) {
        this.metrics.active--; if (accountMetrics) accountMetrics.active--; if (threadMetrics) threadMetrics.active--;
      }
    }
  }
}
