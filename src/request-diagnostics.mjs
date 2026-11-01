import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ACCOUNTS = new Set(['A', 'B', 'CodeBuddy', 'Cursor', 'Claude', 'With', 'Bifrost']);
const STATUSES = new Set(['completed', 'tool_pending', 'incomplete', 'failed', 'interrupted']);
const STAGES = new Set(['authentication', 'validation', 'routing', 'upstream_request', 'upstream_response', 'stream', 'downstream']);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens'];
const REQUEST_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_LINE_BYTES = 16 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

const MESSAGES = Object.freeze({
  authentication_failed: '认证未通过，请检查所选渠道的授权状态。',
  access_denied: '请求未获准，请检查所选渠道的访问权限。',
  invalid_request: '请求格式或参数未通过网关检查。',
  payload_rejected: '上游拒绝了请求格式或参数；这不表示模型本身不支持。',
  model_disabled: '所选模型尚未在本网关开放。',
  model_unavailable: '所选模型当前未在该账号的可用目录中。',
  routing_rejected: '请求无法按当前渠道配置分流。',
  gateway_restarting: '网关正在重启，请稍后重试。',
  quota_or_rate_limited: '上游返回额度或速率限制，请查看该账号的官方用量页面。',
  provider_unavailable: '所选渠道当前未就绪。',
  upstream_failed: '上游未能完成请求。',
  network_failed: '连接上游时发生网络错误。',
  request_interrupted: '请求在完整返回前中断。',
  incomplete_response: '上游未返回可确认的完整结束结果。',
  tool_pending: '模型已返回工具调用，完整回合仍等待工具结果。',
  unknown_error: '请求未完成，未取得可安全公开的具体错误类别。',
});

/** Classify only explicit codes/statuses. Provider error text is never retained. */
export function classifyDiagnosticFailure(error, { httpStatus = null, stage = 'upstream_request', interrupted = false } = {}) {
  let code = 'unknown_error';
  const supplied = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const status = Number.isInteger(error?.status) ? error.status : httpStatus;
  if (interrupted || error?.name === 'AbortError') code = 'request_interrupted';
  else if (['invalid_gateway_key', 'account_a_auth_required', 'anthropic_invalid_gateway_key', 'with_invalid_gateway_key',
    'authentication_error', 'unauthenticated', 'auth_required', 'not_authenticated'].includes(supplied) || status === 401) code = 'authentication_failed';
  else if (['gateway_restarting', 'anthropic_gateway_restarting', 'with_gateway_restarting'].includes(supplied)) code = 'gateway_restarting';
  else if (['model_disabled', 'model_not_enabled'].includes(supplied)) code = 'model_disabled';
  else if (['model_not_found', 'model_unavailable', 'unsupported_model', 'unknown_model', 'cursor_model_unavailable',
    'codebuddy_model_unavailable', 'anthropic_unsupported_model', 'with_unsupported_model'].includes(supplied)) code = 'model_unavailable';
  else if (status === 403 || ['permission_error', 'permission_denied'].includes(supplied)) code = 'access_denied';
  else if (status === 402 || status === 429 || ['rate_limit_error', 'rate_limit_exceeded', 'insufficient_quota', 'quota_exceeded'].includes(supplied)) code = 'quota_or_rate_limited';
  else if (['cursor_unavailable', 'codebuddy_unavailable', 'provider_unavailable', 'not_ready'].includes(supplied)) code = 'provider_unavailable';
  else if (/^(?:unknown_(?:b|cursor|codebuddy)_model|(?:cursor|codebuddy)_history_channel_mismatch)$/.test(supplied)) code = 'routing_rejected';
  else if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'].includes(error?.code) || error?.name === 'TimeoutError' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.cause?.code)) code = 'network_failed';
  else if (status >= 400 && status < 500) code = ['authentication', 'validation', 'routing'].includes(stage) ? 'invalid_request' : 'payload_rejected';
  else if (status >= 500 && status <= 599) code = 'upstream_failed';
  return { errorCode: code, message: MESSAGES[code], failureStage: STAGES.has(stage) ? stage : 'upstream_request' };
}

function token(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function normalizeDiagnosticUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const canonical = USAGE_FIELDS.some(field => Object.hasOwn(raw, field));
  const result = canonical ? Object.fromEntries(USAGE_FIELDS.map(field => [field, token(raw[field])])) : {
    inputTokens: token(raw.input_tokens), outputTokens: token(raw.output_tokens), totalTokens: token(raw.total_tokens),
    cachedInputTokens: token(raw.input_tokens_details?.cached_tokens), cacheWriteTokens: token(raw.input_tokens_details?.cache_write_tokens),
    reasoningTokens: token(raw.output_tokens_details?.reasoning_tokens),
  };
  if (result.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) {
    result.totalTokens = token(result.inputTokens + result.outputTokens);
  }
  return USAGE_FIELDS.some(field => result[field] !== null) ? result : null;
}

function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(value)) return null;
  const stripChannel = part => part.replace(/^(?:claude-codebuddy-|CodeBuddy-|Cursor-|B-)+/i, '');
  const source = stripChannel(value);
  // Check the source as well as the public alias, so adding a channel prefix
  // cannot turn a pasted credential or local path into a publishable model ID.
  return source && !/^(?:\/|[A-Za-z]:\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(source) &&
    !source.split(/[/:]/).some(part => /^(?:sk-|rt_|oat_|oaist|eyJ|Bearer(?:-|:|$))/i.test(stripChannel(part))) &&
    !value.split('/').some(part => part === '.' || part === '..') ? value : null;
}
function milliseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.round(value * 1000) / 1000 : null;
}

/** Rebuild every public record, including replayed records, from this whitelist. */
export function normalizeDiagnosticRecord(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !REQUEST_ID.test(raw.requestId)) return null;
    const time = new Date(raw.time);
    if (raw.time === null || !Number.isFinite(time.getTime())) return null;
    const status = STATUSES.has(raw.status) ? raw.status : 'failed';
    const errorCode = status === 'completed' ? null : status === 'tool_pending' ? 'tool_pending'
      : status === 'interrupted' ? 'request_interrupted' : Object.hasOwn(MESSAGES, raw.errorCode) ? raw.errorCode
        : status === 'incomplete' ? 'incomplete_response' : 'unknown_error';
    const durationMs = milliseconds(raw.durationMs), first = milliseconds(raw.firstResponseMs);
    return {
      requestId: raw.requestId.toLowerCase(), time: time.toISOString(),
      account: ACCOUNTS.has(raw.account) ? raw.account : raw.account === 'CB' ? 'CodeBuddy' : null,
      model: modelId(raw.model), upstreamModel: modelId(raw.upstreamModel), status,
      httpStatus: Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599 ? raw.httpStatus : null,
      durationMs, firstResponseMs: first !== null && durationMs !== null ? Math.min(first, durationMs) : first,
      failureStage: status === 'completed' || status === 'tool_pending' ? null : STAGES.has(raw.failureStage) ? raw.failureStage : null,
      errorCode, message: errorCode ? MESSAGES[errorCode] : '请求已完整返回。', usage: normalizeDiagnosticUsage(raw.usage),
    };
  } catch { return null; }
}

/** Terminal status alone cannot attest a final assistant answer or client tool completion. */
export function responsesTerminalEvidence(response) {
  const output = Array.isArray(response?.output) ? response.output : null;
  const pending = output?.some(item => ['function_call', 'custom_tool_call', 'computer_call', 'local_shell_call',
    'shell_call', 'apply_patch_call', 'mcp_approval_request'].includes(item?.type) ||
    typeof item?.type === 'string' && item.type.endsWith('_call') && item.status !== 'completed') === true;
  const consistent = output?.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
    (item.status === undefined || item.status === null || item.status === 'completed')) === true;
  const answer = output?.some(item => item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content) && item.content.length > 0 &&
    item.content.every(block => block?.type === 'output_text' && typeof block.text === 'string' && block.text.length > 0 ||
      block?.type === 'refusal' && typeof block.refusal === 'string' && block.refusal.length > 0)) === true;
  return { toolPending: pending, terminalVerified: response?.status === 'completed' && consistent && answer && !pending };
}

async function checkPath(path) {
  for (let current = path;; current = dirname(current)) {
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || current === path && !details.isFile()) throw new Error('Unsafe diagnostics file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}

/** Bounded metadata journal. Persistence failures never throw into an inference request. */
export class RequestDiagnostics {
  #path; #maxRecords; #maxBytes; #entries = new Map(); #bytes = 0;
  #queue = Promise.resolve(); #error = null; #closed = false;

  constructor({ path, maxRecords = 256, maxBytes = 1024 * 1024 } = {}) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('Diagnostics path is required.');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096) throw new TypeError('Invalid diagnostics record limit.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 8 * 1024 * 1024) throw new TypeError('Invalid diagnostics byte limit.');
    this.#path = resolve(path); this.#maxRecords = maxRecords; this.#maxBytes = maxBytes;
  }

  static async open(options) {
    const journal = new RequestDiagnostics(options);
    try {
      await checkPath(journal.#path);
      await mkdir(dirname(journal.#path), { recursive: true, mode: 0o700 });
      await checkPath(journal.#path);
      const file = await open(journal.#path, constants.O_CREAT | constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const { size } = await file.stat();
        const start = Math.max(0, size - journal.#maxBytes), bytes = Buffer.alloc(size - start);
        await file.read(bytes, 0, bytes.length, start);
        const content = start ? bytes.subarray(Math.max(0, bytes.indexOf(10) + 1)) : bytes;
        for (const line of content.toString('binary').split('\n')) {
          if (!line.trim() || line.length > MAX_LINE_BYTES) continue;
          try {
            const record = normalizeDiagnosticRecord(JSON.parse(decoder.decode(Buffer.from(line, 'binary'))));
            if (record) journal.#accept(record);
          } catch { /* Corrupt, incomplete, oversized and private fields are never published. */ }
        }
      } finally { await file.close(); }
      // Remove corrupt tails and fields from older/untrusted records before accepting appends.
      await journal.#rewrite();
    } catch { journal.#error = 'diagnostics_unavailable'; }
    return journal;
  }

  record(raw) {
    const record = normalizeDiagnosticRecord(raw);
    if (!record || this.#closed) return Promise.resolve({ recorded: false, persisted: false });
    const operation = this.#queue.then(async () => {
      if (this.#entries.has(record.requestId)) return { recorded: false, duplicate: true, persisted: !this.#error };
      const evicted = this.#accept(record);
      if (this.#error) return { recorded: true, persisted: false };
      try {
        const line = `${JSON.stringify(record)}\n`;
        if (evicted || this.#bytes + Buffer.byteLength(line) > this.#maxBytes) await this.#rewrite();
        else {
          await checkPath(this.#path);
          const file = await open(this.#path, constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
          try { await file.appendFile(line, 'utf8'); await file.sync(); this.#bytes += Buffer.byteLength(line); }
          finally { await file.close(); }
        }
        return { recorded: true, persisted: true };
      } catch { this.#error = 'diagnostics_write_failed'; return { recorded: true, persisted: false }; }
    });
    this.#queue = operation.catch(() => { this.#error = 'diagnostics_write_failed'; });
    return operation.catch(() => ({ recorded: false, persisted: false }));
  }

  #accept(record) {
    if (this.#entries.has(record.requestId)) return false;
    this.#entries.set(record.requestId, record);
    let evicted = false;
    while (this.#entries.size > this.#maxRecords || Buffer.byteLength(this.#serialized()) > this.#maxBytes) {
      this.#entries.delete(this.#entries.keys().next().value); evicted = true;
    }
    return evicted;
  }
  #serialized() { return [...this.#entries.values()].map(record => `${JSON.stringify(record)}\n`).join(''); }
  async #rewrite() {
    await checkPath(this.#path);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      const content = this.#serialized();
      try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
      await checkPath(this.#path); await rename(temporary, this.#path); await chmod(this.#path, 0o600);
      this.#bytes = Buffer.byteLength(content);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  snapshot({ limit = 50 } = {}) {
    const count = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, this.#maxRecords) : 50;
    return structuredClone({ recent: [...this.#entries.values()].reverse().slice(0, count),
      retained: this.#entries.size, capacity: this.#maxRecords, error: this.#error });
  }
  detail(id) { return typeof id === 'string' ? structuredClone(this.#entries.get(id.toLowerCase()) ?? null) : null; }
  exportReport(id) {
    const request = id === undefined ? null : this.detail(id);
    if (id !== undefined && request === null) return null;
    return { version: 1, generatedAt: new Date().toISOString(), scope: 'gateway-request-metadata',
      ...(request ? { request } : { requests: this.snapshot({ limit: this.#maxRecords }).recent }),
      notice: '仅包含经本网关的请求元数据；未保存请求正文、响应正文、认证凭证或原始错误内容。' };
  }
  async flush() { await this.#queue; return { ok: this.#error === null, error: this.#error }; }
  async close() { this.#closed = true; return this.flush(); }
}
