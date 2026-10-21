const INPUT_HEADERS = new Set([
  'accept', 'content-type', 'anthropic-version', 'anthropic-beta',
  'user-agent', 'x-client-request-id', 'x-request-id',
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id',
  'x-session-id', 'x-conversation-id', 'x-session-affinity', 'session_id', 'session-id', 'x-opencode-session',
]);
const CATALOG_ERROR = '无法读取 Claude 上游模型目录。';
const MODEL_ERROR = 'Claude 上游模型目录未包含配置模型。';
const REQUEST_ERROR = 'Claude 上游请求失败。';
const TRANSPORT = 'anthropic-http';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class ProviderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function errorResponse(message, status) {
  const type = ({ 400: 'invalid_request_error', 404: 'not_found_error', 503: 'api_error' })[status] || 'api_error';
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

function normalizeBase(value) {
  let url;
  try {
    if (typeof value !== 'string' || /[\x00-\x20\x7f\\?#]/.test(value)) throw new Error();
    url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        !['/', '/v1', '/v1/'].includes(url.pathname) ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error();
  } catch { throw new TypeError('Claude 上游地址必须是 HTTPS 或 HTTP 回环地址，仅支持根路径或 /v1。'); }
  return `${url.origin}/v1`;
}

function targetPath(path) {
  if (typeof path !== 'string' || /[\x00-\x20\x7f#]/.test(path) ||
      !/^\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(path)) {
    throw new ProviderError('Claude 上游未提供此接口。', 404);
  }
  return path.slice('/v1'.length);
}

function outgoingBody(body, rawBody, model) {
  if (!object(body) || !Object.hasOwn(body, 'model') || body.model !== model) {
    throw new ProviderError('Claude 上游模型与配置不匹配。');
  }
  if (rawBody === undefined || rawBody === null) {
    try { return JSON.stringify(body); }
    catch { throw new ProviderError('模型请求不是有效 JSON。'); }
  }
  try {
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) throw new Error();
    const text = typeof rawBody === 'string' ? rawBody : new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const original = JSON.parse(text, (_key, value, context) =>
      typeof value === 'number' ? JSON.rawJSON(context.source) : value);
    if (!object(original) || typeof original.model !== 'string' || !original.model) throw new Error();
    if (original.model === model) return rawBody;
    original.model = model;
    return JSON.stringify(original);
  } catch { throw new ProviderError('模型请求不是有效 JSON。'); }
}

function businessHeaders(incoming, key) {
  const source = new Headers(incoming);
  const hop = new Set((source.get('connection') || '').toLowerCase().split(',').map(value => value.trim()));
  const headers = new Headers();
  for (const [name, value] of source) {
    if (INPUT_HEADERS.has(name) && !hop.has(name)) headers.set(name, value);
  }
  headers.set('content-type', 'application/json');
  if (key) headers.set('authorization', `Bearer ${key}`);
  return headers;
}

export class AnthropicHttpProvider {
  #cache = null;
  #closed = false;

  constructor({ baseUrl, model, loadKey, fetchImpl = fetch, cacheMs = 30_000,
    clock = Date.now, cacheMode = 'cli' } = {}) {
    this.baseUrl = normalizeBase(baseUrl);
    if (typeof model !== 'string' || !model || model.length > 512 || /[\x00-\x20\x7f]/.test(model)) {
      throw new TypeError('Claude 上游需要固定的精确模型 ID。');
    }
    if (loadKey !== undefined && typeof loadKey !== 'function' || typeof fetchImpl !== 'function' ||
        typeof clock !== 'function' || !Number.isFinite(cacheMs) || cacheMs < 0 ||
        cacheMode !== 'cli') throw new TypeError('Claude HTTP 上游配置无效。');
    this.model = model; this.loadKey = loadKey; this.fetchImpl = fetchImpl;
    this.cacheMs = cacheMs; this.clock = clock;
  }

  async #key() {
    let key;
    try { key = await this.loadKey?.(); }
    catch { throw new ProviderError('Claude 上游独立认证暂不可用。', 503); }
    if (key === undefined || key === null || key === '') return null;
    if (typeof key !== 'string' || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) {
      throw new ProviderError('Claude 上游独立认证暂不可用。', 503);
    }
    return key;
  }

  #view(metadata) {
    return { connected: metadata.connected, authenticated: null,
      ready: metadata.modelAvailable, modelAvailable: metadata.modelAvailable,
      transport: TRANSPORT, upstreamModel: this.model, error: metadata.error,
      cacheControl: { behavior: 'upstream_cli_managed',
        usage: 'upstream_reported_only' } };
  }

  async #metadata(key, signal) {
    signal?.throwIfAborted();
    if (this.#closed) return { connected: false, modelAvailable: false, error: 'Claude HTTP 上游已停止。' };
    if (this.#cache?.key === key && this.#cache.expires > this.clock()) return this.#cache.metadata;
    let metadata;
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await this.fetchImpl(`${this.baseUrl}/models`, { method: 'GET',
        headers: businessHeaders(undefined, key), redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const catalog = await response.json();
      if (!object(catalog) || !Array.isArray(catalog.data) ||
          !catalog.data.every(item => object(item) && typeof item.id === 'string')) throw new Error();
      const modelAvailable = catalog.data.some(item => item.id === this.model);
      metadata = { connected: true, modelAvailable, error: modelAvailable ? null : MODEL_ERROR };
    } catch {
      signal?.throwIfAborted();
      metadata = { connected: false, modelAvailable: false, error: CATALOG_ERROR };
    }
    this.#cache = { key, expires: this.clock() + this.cacheMs, metadata };
    return metadata;
  }

  async status() {
    try { return this.#view(await this.#metadata(await this.#key())); }
    catch { return this.#view({ connected: false, modelAvailable: false, error: CATALOG_ERROR }); }
  }

  async request({ path, body, rawBody, headers, signal } = {}) {
    try {
      signal?.throwIfAborted();
      const suffix = targetPath(path);
      const outgoing = outgoingBody(body, rawBody, this.model);
      const key = await this.#key();
      const forwarded = businessHeaders(headers, key);
      const metadata = await this.#metadata(key, signal);
      if (!metadata.modelAvailable) return errorResponse(metadata.error, 503);
      signal?.throwIfAborted();
      const response = await this.fetchImpl(`${this.baseUrl}${suffix}`, {
        method: 'POST', headers: forwarded, body: outgoing, signal, redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        this.#cache = null;
        await response.body?.cancel();
        return errorResponse('Claude 上游返回了不允许的重定向。', 502);
      }
      if (!response.ok) this.#cache = null;
      return response;
    } catch (error) {
      this.#cache = null;
      if (signal?.aborted) return errorResponse('Claude 上游请求已取消。', 499);
      return errorResponse(error instanceof ProviderError ? error.message : REQUEST_ERROR,
        error instanceof ProviderError ? error.status : 502);
    }
  }

  close() { this.#closed = true; this.#cache = null; }
}
