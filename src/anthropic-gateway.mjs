import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { keyMatches, readBody, SseInspector } from './gateway.mjs';
import { BridgeError, redact } from './storage.mjs';
import { classifyDiagnosticFailure, normalizeDiagnosticRecord } from './request-diagnostics.mjs';

const ROUTES = new Map([
  ['/health', 'GET'],
  ['/v1/models', 'GET'],
  ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'],
]);
const INPUT_HEADERS = new Set([
  'accept', 'content-type', 'anthropic-version', 'anthropic-beta',
  'user-agent', 'x-client-request-id', 'x-request-id',
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-parent-agent-id',
  'x-session-id', 'x-conversation-id', 'x-session-affinity', 'session_id', 'session-id', 'x-opencode-session',
]);

function token(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sumTokens(...values) {
  return values.every(value => value !== null) ? token(values.reduce((sum, value) => sum + value, 0)) : null;
}

/** Normalize explicit Anthropic counts for the shared ledger's OpenAI-shaped input. */
export function normalizeAnthropicUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cached = token(raw.cache_read_input_tokens);
  const written = token(raw.cache_creation_input_tokens);
  const input = sumTokens(token(raw.input_tokens), cached, written);
  const output = token(raw.output_tokens);
  const reasoning = token(raw.output_tokens_details?.reasoning_tokens ?? raw.reasoning_tokens);
  if ([input, output, cached, written, reasoning].every(value => value === null)) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: sumTokens(input, output),
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function normalizeBridgeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = token(raw.input_tokens), output = token(raw.output_tokens);
  const cached = token(raw.input_tokens_details?.cached_tokens);
  const written = token(raw.input_tokens_details?.cache_write_tokens);
  const reasoning = token(raw.output_tokens_details?.reasoning_tokens);
  const total = token(raw.total_tokens) ?? sumTokens(input, output);
  if ([input, output, total, cached, written, reasoning].every(value => value === null)) return null;
  return {
    input_tokens: input, output_tokens: output, total_tokens: total,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function peerAddress(value) {
  return typeof value === 'string' && value.startsWith('::ffff:') ? value.slice(7) : value;
}

function requestHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (INPUT_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers.set(name, value);
  }
  // The dedicated gateway key, account A/B authorization, and cookies never reach the provider.
  headers.set('content-type', 'application/json');
  return headers;
}

function outputHeaders(response) {
  const headers = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  for (const [name, value] of response.headers) {
    if (['content-type', 'retry-after', 'request-id', 'x-request-id', 'anthropic-version', 'anthropic-beta'].includes(name) ||
      name.startsWith('anthropic-ratelimit-')) headers[name] = value;
  }
  return headers;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function errorType(status) {
  return ({
    400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
    404: 'not_found_error', 405: 'invalid_request_error', 413: 'request_too_large',
    415: 'invalid_request_error', 429: 'rate_limit_error', 501: 'not_implemented_error',
  })[status] ?? 'api_error';
}

function emptyMetrics() {
  return { requests: 0, completed: 0, failed: 0, active: 0,
    lastError: null, lastUsage: null, usageError: null };
}

export class AnthropicGateway {
  constructor({ routes = [], gatewayKey, allowedHosts = [], allowedPeers = [],
    onUsage = async () => {}, onDiagnostic = () => {}, getAuthorizationVersion = () => null,
    maxBodyBytes = 64 * 1024 * 1024, isDraining = () => false, isAccountEnabled = () => true } = {}) {
    if (typeof gatewayKey !== 'string' || !gatewayKey) throw new TypeError('A dedicated gatewayKey is required.');
    if (!Array.isArray(routes)) throw new TypeError('Anthropic model routes must be an array.');
    if (!Array.isArray(allowedHosts) || !allowedHosts.every(host => typeof host === 'string' && host)) {
      throw new TypeError('Gateway allowedHosts must be an array of Host values.');
    }
    if (!Array.isArray(allowedPeers) || !allowedPeers.every(peer => typeof peer === 'string' && peer)) {
      throw new TypeError('Gateway allowedPeers must be an array of peer addresses.');
    }
    if (typeof onDiagnostic !== 'function' || typeof getAuthorizationVersion !== 'function') throw new TypeError('Invalid request diagnostic hooks.');
    this.gatewayKey = gatewayKey;
    this.allowedHosts = new Set([...allowedHosts].map(host => host.toLowerCase()));
    this.allowedPeers = new Set([...allowedPeers].map(peerAddress));
    this.onUsage = onUsage;
    this.onDiagnostic = onDiagnostic; this.getAuthorizationVersion = getAuthorizationVersion;
    this.maxBodyBytes = maxBodyBytes;
    this.isDraining = isDraining;
    this.isAccountEnabled = isAccountEnabled;
    this.metrics = emptyMetrics();
    this.pendingRequests = 0;
    this.routes = new Map();
    this.accountMetrics = new Map();
    for (const route of routes) {
      if (!route || typeof route.account !== 'string' || !route.account ||
          typeof route.model?.id !== 'string' || !route.model.id ||
          typeof route.model.name !== 'string' || !route.model.name || this.routes.has(route.model.id) ||
          (route.model.upstream !== undefined && (typeof route.model.upstream !== 'string' || !route.model.upstream)) ||
          typeof route.provider?.request !== 'function' || typeof route.provider?.status !== 'function') {
        throw new TypeError('Invalid Anthropic model route.');
      }
      if (!this.accountMetrics.has(route.account)) this.accountMetrics.set(route.account, emptyMetrics());
      this.routes.set(route.model.id, { account: route.account, model: { ...route.model },
        provider: route.provider, metrics: this.accountMetrics.get(route.account) });
    }
    this.metrics = this.routes.values().next().value?.metrics ?? this.metrics;
  }

  status(account = this.routes.values().next().value?.account) {
    return structuredClone(this.accountMetrics.get(account) ?? emptyMetrics());
  }

  safeError(error) {
    return redact(String(error?.message ?? error ?? '网关请求失败。').split(this.gatewayKey).join('[REDACTED]'));
  }

  gatewayError(code, status = 400, message = null) {
    const messages = {
      peer_denied: '此客户端地址未获准访问网关。', host_denied: '网关 Host 不允许。',
      invalid_gateway_key: '网关认证失败。', invalid_target: '请求目标无效。',
      unknown_endpoint: '网关未提供该接口。', invalid_method: '接口不支持该请求方法。',
      compressed_body: '网关不支持压缩请求正文。', invalid_json: '请求不是有效 JSON。',
      unsupported_model: `网关仅支持模型 ${[...this.routes.keys()].join('、')}。`,
    };
    return new BridgeError(message ?? messages[code], status, `anthropic_${code}`);
  }

  providerMetadata(_route, metadata) {
    return { authenticated: typeof metadata?.authenticated === 'boolean' ? metadata.authenticated : null, ready: metadata?.ready === true,
      modelAvailable: metadata?.modelAvailable === true, error: metadata?.error ? this.safeError(metadata.error) : null };
  }

  async modelAvailable(route) {
    try { return (await route.provider.status()).modelAvailable === true; } catch { return false; }
  }

  authorize(req) {
    if (!this.allowedPeers.has(peerAddress(req.socket.remoteAddress))) {
      throw this.gatewayError('peer_denied', 403);
    }
    let hostCount = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index].toLowerCase() === 'host') hostCount++;
    }
    if (hostCount !== 1 || typeof req.headers.host !== 'string' || !this.allowedHosts.has(req.headers.host.toLowerCase())) {
      throw this.gatewayError('host_denied', 403);
    }
    const supplied = [];
    if (req.headers.authorization !== undefined) {
      const match = typeof req.headers.authorization === 'string' && /^Bearer\s+(\S+)$/i.exec(req.headers.authorization);
      supplied.push(match ? match[1] : null);
    }
    if (req.headers['x-api-key'] !== undefined) supplied.push(req.headers['x-api-key']);
    if (!supplied.length || supplied.some(value => !keyMatches(value, this.gatewayKey))) {
      throw this.gatewayError('invalid_gateway_key', 401);
    }
  }

  async handle(req, res) {
    this.pendingRequests++;
    const diagnostic = typeof req.url === 'string' && req.url.split('?')[0] === '/v1/messages' ? {
      requestId: randomUUID(), time: new Date().toISOString(), started: performance.now(), stage: 'authentication',
      account: null, model: null, upstreamModel: null, httpStatus: null, firstResponseMs: null,
      complete: false, delivered: false, terminalVerified: false, authorizationVersion: null,
    } : null;
    try { return await this.dispatch(req, res, diagnostic); }
    finally {
      if (diagnostic) {
        const complete = diagnostic.complete && diagnostic.delivered && diagnostic.httpStatus >= 200 && diagnostic.httpStatus < 300 && !diagnostic.failure;
        const status = diagnostic.interrupted ? 'interrupted' : diagnostic.failure ? 'failed'
          : complete && diagnostic.toolPending ? 'tool_pending' : complete ? 'completed' : 'incomplete';
        const record = normalizeDiagnosticRecord({ ...diagnostic, status, durationMs: diagnostic.durationMs ?? performance.now() - diagnostic.started,
          ...(diagnostic.failure ?? { errorCode: 'incomplete_response', failureStage: 'upstream_response' }) });
        if (record) {
          try { Promise.resolve(this.onDiagnostic({ ...record, terminalVerified: status === 'completed' && diagnostic.terminalVerified === true,
            authorizationVersion: diagnostic.authorizationVersion })).catch(() => {}); } catch { /* Diagnostics must never change forwarding. */ }
        }
      }
      this.pendingRequests--;
    }
  }

  async dispatch(req, res, diagnostic = null) {
    try {
      this.authorize(req);
      if (diagnostic) diagnostic.stage = 'routing';
      if (this.isDraining()) throw this.gatewayError('gateway_restarting', 503, '网关正在重启，请稍后重试。');
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) {
        throw this.gatewayError('invalid_target');
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const method = ROUTES.get(url.pathname);
      if (!method) throw this.gatewayError('unknown_endpoint', 404);
      if (req.method !== method) throw this.gatewayError('invalid_method', 405);
      if (url.pathname === '/health') {
        const providers = Object.create(null);
        const primary = this.routes.values().next().value;
        let primaryMetadata = null;
        for (const route of this.routes.values()) {
          let metadata;
          try { metadata = await route.provider.status(); } catch { metadata = { authenticated: false, ready: false }; }
          const current = this.providerMetadata(route, metadata);
          if (route === primary) primaryMetadata = current;
          const previous = providers[route.account];
          if (!previous) providers[route.account] = current;
          else {
            const ready = previous.ready === true || current.ready === true;
            providers[route.account] = {
              ...previous,
              authenticated: previous.authenticated === true || current.authenticated === true ? true
                : previous.authenticated === false && current.authenticated === false ? false : null,
              ...(previous.ready !== undefined || current.ready !== undefined ? { ready } : {}),
              ...(previous.modelAvailable !== undefined || current.modelAvailable !== undefined
                ? { modelAvailable: previous.modelAvailable === true || current.modelAvailable === true } : {}),
              error: ready ? null : previous.error ?? current.error,
            };
          }
        }
        json(res, 200, { ok: Object.values(providers).some(item => item.ready ?? item.authenticated === true),
          model: primary?.model.id ?? null, provider: primaryMetadata, providers, gateway: this.status() });
        return;
      }
      if (url.pathname === '/v1/models') {
        const data = [];
        for (const route of this.routes.values()) {
          if (this.isAccountEnabled(route.account, route.model.id) === true && await this.modelAvailable(route)) {
            data.push({ id: route.model.id, type: 'model', display_name: route.model.name });
          }
        }
        json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
        return;
      }
      await this.forward(req, res, url.pathname + url.search, diagnostic);
    } catch (error) {
      if (diagnostic) {
        diagnostic.interrupted ||= res.destroyed === true;
        diagnostic.failure = classifyDiagnosticFailure(error, { httpStatus: diagnostic.httpStatus, stage: diagnostic.stage,
          interrupted: diagnostic.interrupted || res.destroyed });
        diagnostic.httpStatus ??= Number.isInteger(error?.status) ? error.status : 502;
      }
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      json(res, status, { type: 'error', error: { type: errorType(status), message: this.safeError(error) } });
    }
  }

  async forward(req, res, path, diagnostic = null) {
    if (diagnostic) diagnostic.stage = 'validation';
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      throw this.gatewayError('compressed_body', 415);
    }
    const abort = new AbortController();
    const onDisconnect = () => { if (!res.writableEnded) abort.abort(new Error('客户端连接已中断。')); };
    req.once('aborted', onDisconnect);
    res.once('close', onDisconnect);
    let data, route, rawBody;
    try {
      rawBody = await readBody(req, this.maxBodyBytes);
      try { data = JSON.parse(rawBody.toString('utf8')); } catch { throw this.gatewayError('invalid_json'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !(route = this.routes.get(data.model))) {
        throw this.gatewayError('unsupported_model');
      }
      if (this.isAccountEnabled(route.account, data.model) !== true) throw new BridgeError('此上游账号已停用或尚未登记。', 503, 'upstream_account_disabled');
      if (diagnostic) {
        diagnostic.account = route.account; diagnostic.model = route.model.id; diagnostic.upstreamModel = route.model.upstream ?? null;
        diagnostic.stage = 'routing';
        try { diagnostic.authorizationVersion = this.getAuthorizationVersion(route.account); } catch { /* Unknown authorization generation is not guessed. */ }
      }
      if (data.stream !== undefined && typeof data.stream !== 'boolean') throw new BridgeError('stream 必须是布尔值。');
    } catch (error) {
      if (diagnostic) diagnostic.interrupted = abort.signal.aborted;
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
      throw error;
    }

    const { provider, model, account, metrics } = route;

    const inference = new URL(path, 'http://anthropic.invalid').pathname === '/v1/messages';
    const requestId = diagnostic?.requestId ?? randomUUID();
    let complete = false, streamError = false, responseId = null, httpStatus = null;
    let rawUsage = null, reader = null, readerDone = false;
    let upstreamModel = model.upstream ?? null;
    let hasBridgeUsage = false, bridgeUsage = null;
    let jsonBytes = 0;
    let stopReason = null, toolPending = false, messageStarted = false, messageStopped = false, evidenceInvalid = false, answerText = false;
    const textBlocks = new Set(), openBlocks = new Set();
    const jsonChunks = [];
    const mergeUsage = update => {
      if (hasBridgeUsage) return;
      if (!update || typeof update !== 'object' || Array.isArray(update)) return;
      const previous = rawUsage || {};
      rawUsage = { ...previous, ...update };
      if (update.output_tokens_details) rawUsage.output_tokens_details = {
        ...previous.output_tokens_details, ...update.output_tokens_details,
      };
    };
    const inspectEvent = event => {
      if (event.type === 'message_start') {
        if (messageStarted || event.message?.type !== 'message' || event.message?.role !== 'assistant' || !Array.isArray(event.message?.content)) evidenceInvalid = true;
        else {
          messageStarted = true;
          answerText ||= event.message.content.some(item => item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0);
        }
        responseId = event.message?.id ?? responseId;
        mergeUsage(event.message?.usage);
        toolPending ||= Array.isArray(event.message?.content) && event.message.content.some(item => item?.type === 'tool_use');
      }
      if (event.type === 'content_block_start') {
        if (!messageStarted || messageStopped || !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= 4096 || openBlocks.has(event.index)) evidenceInvalid = true;
        else {
          openBlocks.add(event.index);
          if (event.content_block?.type === 'text') {
            textBlocks.add(event.index);
            answerText ||= typeof event.content_block.text === 'string' && event.content_block.text.length > 0;
          }
        }
        if (event.content_block?.type === 'tool_use') toolPending = true;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (!messageStarted || messageStopped || !openBlocks.has(event.index) || !textBlocks.has(event.index)) evidenceInvalid = true;
        else answerText ||= typeof event.delta.text === 'string' && event.delta.text.length > 0;
      }
      if (event.type === 'content_block_stop') {
        if (!openBlocks.delete(event.index)) evidenceInvalid = true;
      }
      if (event.type === 'message_delta') {
        if (!messageStarted || messageStopped) evidenceInvalid = true;
        mergeUsage(event.usage);
        if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
      }
      if (event.type === 'message_stop') {
        complete = !streamError;
        if (diagnostic) diagnostic.terminalVerified = messageStarted && !evidenceInvalid && answerText && openBlocks.size === 0 &&
          ['end_turn', 'stop_sequence'].includes(stopReason) && !toolPending && !streamError;
        messageStopped = true;
      }
      if (event.type === 'error') {
        streamError = true; complete = false;
        if (diagnostic) diagnostic.failure = classifyDiagnosticFailure({ code: event.error?.type ?? event.error?.code }, { httpStatus, stage: 'stream' });
        metrics.lastError = this.safeError(event.error?.message || `${account} 上游返回错误事件。`);
      }
    };
    const readJson = updateCompletion => {
      if (!inference || !jsonChunks.length || jsonBytes > 8 * 1024 * 1024) return;
      try {
        const message = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
        responseId = message.id ?? responseId;
        mergeUsage(message.usage);
        stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : stopReason;
        toolPending ||= Array.isArray(message.content) && message.content.some(item => item?.type === 'tool_use');
        if (diagnostic) diagnostic.terminalVerified = message.type === 'message' && message.role === 'assistant' &&
          Array.isArray(message.content) && message.content.some(item => item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0) &&
          ['end_turn', 'stop_sequence'].includes(stopReason) && !toolPending;
        if (updateCompletion) complete = message.type === 'message' && typeof message.stop_reason === 'string' && Boolean(message.stop_reason);
        if (message.type === 'error') {
          if (diagnostic) diagnostic.failure = classifyDiagnosticFailure({ code: message.error?.type ?? message.error?.code }, { httpStatus, stage: 'upstream_response' });
          metrics.lastError = this.safeError(message.error?.message || `${account} 上游请求失败。`);
        }
      } catch { /* Incomplete JSON has unknown usage. */ }
    };
    if (inference) { metrics.requests++; metrics.active++; }
    const cancelReader = () => { void reader?.cancel(abort.signal.reason).catch(() => {}); };
    abort.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      abort.signal.throwIfAborted();
      if (diagnostic) diagnostic.stage = 'upstream_request';
      const response = await provider.request({
        path, rawBody, body: { ...data, model: model.upstream ?? model.id },
        headers: requestHeaders(req.headers), signal: abort.signal,
      });
      if (typeof response.bridgeModel === 'string' && response.bridgeModel.length <= 256 && !/[\r\n\0]/.test(response.bridgeModel)) {
        upstreamModel = response.bridgeModel;
      }
      httpStatus = response.status;
      if (diagnostic) {
        diagnostic.httpStatus = httpStatus; diagnostic.upstreamModel = upstreamModel; diagnostic.stage = 'upstream_response';
        if (!response.ok) diagnostic.failure = classifyDiagnosticFailure(null, { httpStatus, stage: 'upstream_response' });
      }
      if (inference && response.bridgeUsage && typeof response.bridgeUsage.then === 'function') {
        hasBridgeUsage = true;
        // Attach both handlers immediately so a rejection cannot become unhandled during streaming.
        bridgeUsage = Promise.resolve(response.bridgeUsage).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      }
      if (!inference && [404, 405, 501].includes(response.status)) {
        await response.body?.cancel();
        throw this.gatewayError('count_tokens_unavailable', 501, `${account} 上游未提供 Token 计数接口。`);
      }
      abort.signal.throwIfAborted();
      const contentType = response.headers.get('content-type') || '';
      const isSse = contentType.includes('text/event-stream') || (data.stream === true && response.ok && !contentType.includes('application/json'));
      const sse = new SseInspector(inspectEvent);
      res.writeHead(response.status, outputHeaders(response));
      if (response.body) {
        reader = response.body.getReader();
        if (abort.signal.aborted) cancelReader();
        while (true) {
          if (diagnostic) diagnostic.stage = 'stream';
          const { done, value } = await reader.read();
          if (done) { readerDone = true; break; }
          if (diagnostic && diagnostic.firstResponseMs === null && value.byteLength) diagnostic.firstResponseMs = performance.now() - diagnostic.started;
          if (inference && isSse) sse.push(value);
          else if (inference) {
            jsonBytes += value.byteLength;
            if (jsonBytes <= 8 * 1024 * 1024) jsonChunks.push(Buffer.from(value));
          }
          abort.signal.throwIfAborted();
          if (diagnostic) diagnostic.stage = 'downstream';
          if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
        }
      }
      abort.signal.throwIfAborted();
      if (!isSse) readJson(true);
      if (!response.ok) complete = false;
      if (!inference) complete = response.ok;
      res.end();
      if (diagnostic) diagnostic.delivered = true;
    } catch (error) {
      if (!inference && [404, 405, 501].includes(error?.status)) {
        throw this.gatewayError('count_tokens_unavailable', 501, `${account} 上游未提供 Token 计数接口。`);
      }
      if (inference) metrics.lastError = this.safeError(error);
      throw error;
    } finally {
      if (diagnostic) Object.assign(diagnostic, { complete, toolPending: toolPending || stopReason === 'tool_use',
        httpStatus, interrupted: abort.signal.aborted, durationMs: performance.now() - diagnostic.started });
      req.removeListener('aborted', onDisconnect);
      res.removeListener('close', onDisconnect);
      abort.signal.removeEventListener('abort', cancelReader);
      if (reader) {
        if (!readerDone) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (inference) {
        readJson(false);
        complete = complete && !streamError && httpStatus >= 200 && httpStatus < 300;
        metrics.active--;
        metrics[complete ? 'completed' : 'failed']++;
        if (complete) metrics.lastError = null;
        else metrics.lastError ??= abort.signal.aborted ? '客户端连接已中断。' : `${account} 上游请求未完成（HTTP ${httpStatus ?? '未知'}）。`;
        const trusted = hasBridgeUsage ? await bridgeUsage : null;
        const usageFailure = trusted?.ok === false ? this.safeError(trusted.error ?? `${account} 服务端用量读取失败。`) : null;
        const usage = hasBridgeUsage ? normalizeBridgeUsage(trusted?.value) : normalizeAnthropicUsage(rawUsage);
        if (diagnostic) {
          diagnostic.usage = usage;
          diagnostic.complete = complete && (stopReason === null || ['end_turn', 'stop_sequence', 'tool_use'].includes(stopReason));
        }
        metrics.lastUsage = usage;
        try {
          await this.onUsage({ requestId, time: new Date().toISOString(), account,
            model: model.id, upstreamModel, responseId, httpStatus,
            status: complete ? 'completed' : abort.signal.aborted ? 'interrupted' : 'failed', usage });
          metrics.usageError = usageFailure;
        } catch (error) { metrics.usageError = this.safeError(error); }
      }
    }
  }
}

/** Creates a server without listening or sending any provider request. */
export function createAnthropicGatewayServer(options) {
  const gateway = new AnthropicGateway(options);
  const server = http.createServer((req, res) => { void gateway.handle(req, res); });
  server.gateway = gateway;
  return server;
}
