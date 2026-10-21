import { timingSafeEqual, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as zlib from 'node:zlib';
import { BridgeError, redact } from './storage.mjs';
import { mergeCatalog, resolveBModel } from './models.mjs';

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

function parseModel(body, headers) {
  const decompressors = { zstd: zlib.zstdDecompressSync, gzip: zlib.gunzipSync,
    deflate: zlib.inflateSync, br: zlib.brotliDecompressSync };
  for (const encoding of (headers['content-encoding'] ?? 'identity').toLowerCase().split(',').reverse()) {
    if (encoding.trim() === 'identity') continue;
    const decompress = decompressors[encoding.trim()];
    if (typeof decompress !== 'function') throw new BridgeError('不支持此请求压缩格式，请检查 Node.js 版本。', 415);
    try { body = decompress(body, { maxOutputLength: 64 * 1024 * 1024 }); }
    catch { throw new BridgeError('模型请求解压失败或正文超过大小限制。', 400); }
  }
  let data;
  try { data = JSON.parse(body.toString('utf8')); } catch { throw new BridgeError('模型请求不是有效 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.model !== 'string' || !data.model) {
    throw new BridgeError('模型请求缺少 model。');
  }
  const alias = resolveBModel(data.model);
  if (!alias && /^b-/i.test(data.model)) throw new BridgeError('未知的 B 模型，已停止请求。', 400, 'unknown_b_model');
  return { data, alias };
}

function requestThreadId(headers) {
  return ['thread-id', 'x-codex-thread-id', 'conversation_id', 'session-id', 'session_id']
    .map(name => headers[name]).find(value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) ?? null;
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
    upstream = 'https://chatgpt.com/backend-api/codex', catalogWaitMs = 1200, onUsage = async () => {} }) {
    if (typeof getAProvider !== 'function') throw new TypeError('getAProvider is required for account routing.');
    Object.assign(this, { backend, gatewayKey, getAProvider, fetchImpl, upstream, catalogWaitMs, onUsage });
    this.bCatalog = null; this.catalogRefresh = null;
    this.threadTraffic = new Map();
    this.metrics = { requests: 0, completed: 0, failed: 0, lastError: null, lastUsage: null,
      accounts: Object.fromEntries(['A', 'B'].map(account => [account,
        { requests: 0, completed: 0, failed: 0, lastModel: null }])) };
  }

  traffic(threadId) { return structuredClone(this.threadTraffic.get(threadId) ?? null); }

  recordThread(headers, account, model) {
    const threadId = requestThreadId(headers);
    if (!threadId) return null;
    if (!this.threadTraffic.has(threadId)) {
      this.threadTraffic.set(threadId, { threadId, accounts: Object.fromEntries(['A', 'B'].map(name => [name,
        { requests: 0, completed: 0, failed: 0, lastModel: null }])) });
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

  async fetchAccountA(path, { headers, method = 'GET', body, signal } = {}) {
    const { config } = await this.getAProvider();
    return this.fetchImpl(appendPath(config.base_url, path), {
      method, headers: accountAHeaders(headers ?? {}, this.gatewayKey), body, signal, redirect: 'error',
    });
  }

  async readBCatalog(path = '/models', { signal } = {}) {
    // Check the binding even when model metadata is cached. No A credential is used here.
    const credential = await this.backend.credentials();
    if (this.bCatalog?.accountId === credential.accountId && this.bCatalog.expiresAt > Date.now()) return this.bCatalog.data;
    if (this.catalogRefresh) return this.catalogRefresh;
    this.catalogRefresh = (async () => {
      const response = await this.fetchUpstream(path, { signal: signal ?? AbortSignal.timeout(10_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BridgeError(`账户 B 的模型目录暂不可用（HTTP ${response.status}）。`, 502);
      }
      const data = await response.json();
      this.bCatalog = { accountId: credential.accountId, expiresAt: Date.now() + 300_000, data };
      return data;
    })();
    try { return await this.catalogRefresh; } finally { this.catalogRefresh = null; }
  }

  async catalog(req, res, url, signal) {
    const started = Date.now();
    const response = await this.fetchAccountA(`/models${url.search}`, { headers: req.headers, signal });
    if (!response.ok) {
      res.writeHead(response.status, { 'Cache-Control': 'no-store', 'Content-Type': response.headers.get('content-type') || 'application/json' });
      res.end(await response.text()); return;
    }
    const aCatalog = await response.json();
    if (!Array.isArray(aCatalog.models)) throw new BridgeError('账户 A 的完整模型目录格式无效。', 502);
    let data = aCatalog;
    const refresh = this.readBCatalog(`/models${url.search}`, { signal: AbortSignal.timeout(10_000) });
    let timer;
    try {
      // The native catalog deadline is short. Cached metadata is usable immediately;
      // credential reads and slow B refreshes continue in the background.
      const remaining = Math.max(0, Math.min(this.catalogWaitMs, 4000 - (Date.now() - started)));
      const bCatalog = this.bCatalog?.data ?? await Promise.race([
        refresh,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('B 目录刷新中，暂保留 A 模型。', 503)), remaining); }),
      ]);
      data = mergeCatalog(aCatalog, bCatalog);
    }
    catch (error) {
      // B login or catalog availability must not prevent selecting A models.
      this.metrics.lastError = redact(error.message);
    }
    finally { clearTimeout(timer); void refresh.catch(() => {}); }
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  async proxy(req, res, url) {
    const key = req.headers['x-account-bridge-key'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!keyMatches(key, this.gatewayKey)) throw new BridgeError('网关认证失败。', 401, 'invalid_gateway_key');
    const path = backendPath(url.pathname);
    if (!path) throw new BridgeError('未实现该模型接口。', 404);
    if ((path === '/models' && req.method !== 'GET') || (path !== '/models' && req.method !== 'POST')) {
      throw new BridgeError('请求方法不支持。', 405);
    }
    const inference = path === '/responses';
    const modelRequest = inference || path === '/responses/compact';
    const requestId = randomUUID();
    if (inference) this.metrics.requests++;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    let complete = false, accountMetrics = null, threadMetrics = null;
    let usage = null, responseId = null, httpStatus = null, route = null;
    let inspectJson = false, jsonBytes = 0;
    const jsonChunks = [];
    const readJsonUsage = (updateCompletion = false) => {
      if (!inspectJson || jsonBytes > 8 * 1024 * 1024) return;
      try {
        const data = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
        usage = data.usage ?? null; responseId = data.id ?? null;
        if (updateCompletion) complete = path === '/responses/compact'
          ? httpStatus >= 200 && httpStatus < 300 : data.status === 'completed';
        this.metrics.lastUsage = usage;
      } catch { /* Incomplete JSON has unknown usage. Never estimate it. */ }
    };
    try {
      if (path === '/models') { await this.catalog(req, res, url, abort.signal); return; }
      const originalBody = await readBody(req);
      let response;
      {
        const { data, alias } = parseModel(originalBody, req.headers);
        const account = alias ? 'B' : 'A';
        route = { account, model: data.model, upstreamModel: alias?.upstream ?? data.model };
        accountMetrics = this.metrics.accounts[account];
        if (inference) {
          accountMetrics.requests++; accountMetrics.lastModel = data.model;
          threadMetrics = this.recordThread(req.headers, account, data.model);
        }
        let body = originalBody;
        if (alias) { data.model = alias.upstream; body = Buffer.from(JSON.stringify(data)); }
        const headers = { ...req.headers };
        if (alias) { delete headers['content-encoding']; delete headers['content-length']; }
        const options = { method: req.method, headers, body, signal: abort.signal };
        response = alias ? await this.fetchUpstream(`${path}${url.search}`, options) :
          await this.fetchAccountA(`${path}${url.search}`, options);
      }
      httpStatus = response.status;
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
          complete = true; this.metrics.lastUsage = event.response.usage ?? null;
        }
        if (['error', 'response.failed'].includes(event.type)) {
          this.metrics.lastError = redact(event.error?.message ?? event.response?.error?.message ?? '模型请求失败');
        }
      });
      inspectJson = modelRequest && (path === '/responses/compact' || response.headers.get('content-type')?.includes('application/json'));
      if (response.body) {
        for await (const bytes of response.body) {
          if (inference && !inspectJson) sse.push(bytes);
          if (inspectJson) {
            jsonBytes += bytes.length;
            if (jsonBytes <= 8 * 1024 * 1024) jsonChunks.push(bytes);
          }
          if (!res.write(bytes)) await once(res, 'drain', { signal: abort.signal });
        }
      }
      readJsonUsage(true);
      if (path === '/responses/compact') complete = response.ok;
      res.end();
      if (inference) {
        if (complete) {
          this.metrics.completed++; accountMetrics.completed++; if (threadMetrics) threadMetrics.completed++;
          this.metrics.lastError = null;
        } else {
          this.metrics.failed++; accountMetrics.failed++; if (threadMetrics) threadMetrics.failed++;
          this.metrics.lastError ??= `上游请求未完成（HTTP ${response.status}）。`;
        }
      }
    } catch (error) {
      if (inference) {
        this.metrics.failed++; if (accountMetrics) accountMetrics.failed++; if (threadMetrics) threadMetrics.failed++;
        this.metrics.lastError = redact(error.message);
      }
      throw error;
    } finally {
      if (modelRequest && route) {
        // A complete JSON chunk may already have arrived before downstream write failed.
        readJsonUsage();
        try {
          await this.onUsage({ requestId, time: new Date().toISOString(), ...route,
            threadId: requestThreadId(req.headers), responseId, httpStatus,
            status: complete ? 'completed' : abort.signal.aborted ? 'interrupted' : 'failed', usage });
          this.metrics.usageError = null;
        } catch (error) { this.metrics.usageError = redact(error.message); }
      }
    }
  }
}
