import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { BridgeError } from './storage.mjs';

export const MODEL_REQUEST_BODY_LIMIT = 128 * 1024 * 1024;
const MAX_ENCODING_LAYERS = 4;
const ENCODINGS = new Set(['identity', 'zstd', 'gzip', 'deflate', 'br']);
const STAGES = new Set(['wire', 'decode', 'complete']);
const ERROR_KINDS = new Set(['wire_limit', 'decoded_limit', 'invalid_compression', 'unsupported_encoding',
  'zstd_window_limit', 'zstd_dictionary_error', 'aborted', 'read_failed']);
const FAILURES = Object.freeze({
  wire_limit: [413, 'request_body_wire_too_large', '模型请求的传输正文超过网关大小限制。'],
  decoded_limit: [413, 'request_body_decoded_too_large', '模型请求解压后的正文超过网关大小限制。'],
  invalid_compression: [400, 'request_body_invalid_compression', '模型请求的压缩数据无效或不完整。'],
  unsupported_encoding: [415, 'request_body_unsupported_encoding', '模型请求的压缩格式不受支持或解码器不可用。'],
  zstd_window_limit: [400, 'request_body_zstd_window_limit', '模型请求的 zstd 窗口超过当前解码器限制。'],
  zstd_dictionary_error: [400, 'request_body_zstd_dictionary_error', '模型请求使用的 zstd 字典不可用或不匹配。'],
  aborted: [499, 'request_body_aborted', '模型请求正文读取或解码已取消。'],
  read_failed: [400, 'request_body_read_failed', '模型请求正文未能完整读取。'],
});
const DECODERS = new Map([
  ['zstd', zlib.zstdDecompress], ['gzip', zlib.gunzip], ['deflate', zlib.inflate], ['br', zlib.brotliDecompress],
].map(([name, decoder]) => [name, typeof decoder === 'function' ? promisify(decoder) : null]));
const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Rebuild safe transport metadata; never retain headers, body bytes, or decoder error text. */
export function normalizeRequestBodyDiagnostics(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return null;
    const encodings = Array.isArray(raw.encodings) && raw.encodings.length <= MAX_ENCODING_LAYERS
      && raw.encodings.every(value => ENCODINGS.has(value)) ? [...raw.encodings] : [];
    const errorKind = ERROR_KINDS.has(raw.errorKind) ? raw.errorKind : null;
    const result = { version: 1, encodings, wireBytes: bytes(raw.wireBytes),
      decodedBytes: raw.stage === 'complete' && errorKind === null ? bytes(raw.decodedBytes) : null,
      wireLimitBytes: bytes(raw.wireLimitBytes), decodedLimitBytes: bytes(raw.decodedLimitBytes),
      stage: STAGES.has(raw.stage) ? raw.stage : null, errorKind };
    if (encodings.includes('zstd') && (errorKind === 'zstd_window_limit' && raw.zstdErrorCode === 16
      || errorKind === 'zstd_dictionary_error' && [30, 32].includes(raw.zstdErrorCode))) {
      result.zstdErrorCode = raw.zstdErrorCode;
    }
    return result;
  } catch { return null; }
}

function failure(kind, context, numericCode = null) {
  const [status, code, message] = FAILURES[kind];
  const error = new BridgeError(message, status, code);
  error.requestBodyDiagnostics = normalizeRequestBodyDiagnostics({ ...context, errorKind: kind,
    ...(numericCode === null ? {} : { zstdErrorCode: numericCode }) });
  return error;
}

function limits(options) {
  const wireLimitBytes = options.wireLimitBytes ?? MODEL_REQUEST_BODY_LIMIT;
  const decodedLimitBytes = options.decodedLimitBytes ?? MODEL_REQUEST_BODY_LIMIT;
  if (![wireLimitBytes, decodedLimitBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Request body limits must be positive safe integers.');
  }
  return { wireLimitBytes, decodedLimitBytes };
}

function encodingChain(headers) {
  const raw = typeof headers?.get === 'function' ? headers.get('content-encoding') : headers?.['content-encoding'];
  const names = raw == null ? ['identity'] : typeof raw === 'string' ? raw.toLowerCase().split(',').map(value => value.trim()) : [];
  const valid = names.length > 0 && names.length <= MAX_ENCODING_LAYERS && names.every(value => ENCODINGS.has(value));
  return { valid, encodings: valid ? names : [] };
}

function assertNotAborted(signal, context) {
  if (signal?.aborted) throw failure('aborted', context);
}

// Node can finish a truncated zstd frame without an error and stop after the
// first concatenated frame. Locate boundaries, then let zlib decode each frame.
// Format: https://github.com/meta/zstd/blob/dev/doc/zstd_compression_format.md
function zstdFrame(body, start) {
  if (start + 4 > body.length) return null;
  const magic = body.readUInt32LE(start);
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
    if (start + 8 > body.length) return null;
    const end = start + 8 + body.readUInt32LE(start + 4);
    return end <= body.length ? { end, skippable: true } : null;
  }
  if (magic !== 0xfd2fb528 || start + 5 > body.length) return null;
  const descriptor = body[start + 4], single = (descriptor & 0x20) !== 0;
  // Only skip the FCS bytes. Never convert the untrusted 64-bit size to Number.
  const contentSizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  let offset = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
  let last = false;
  do {
    if (offset + 3 > body.length) return null;
    const block = body.readUIntLE(offset, 3), type = (block >>> 1) & 3;
    if (type === 3) return null;
    last = (block & 1) !== 0;
    offset += 3 + (type === 1 ? 1 : block >>> 3);
    if (offset > body.length) return null;
  } while (!last);
  if (descriptor & 4) offset += 4;
  return offset <= body.length ? { end: offset, skippable: false } : null;
}

async function decodeOne(decoder, encoding, body, maxOutputLength, context, signal) {
  try {
    const result = await decoder(body, { maxOutputLength: Math.max(1, maxOutputLength), signal, info: true });
    if (result.engine.bytesWritten !== body.length) throw failure('invalid_compression', context);
    return result.buffer;
  }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw failure('aborted', context);
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw failure('decoded_limit', context);
    if (encoding === 'zstd' && error?.errno === 16) throw failure('zstd_window_limit', context, 16);
    if (encoding === 'zstd' && [30, 32].includes(error?.errno)) throw failure('zstd_dictionary_error', context, error.errno);
    throw failure('invalid_compression', context);
  }
}

async function decodeZstd(decoder, body, context, signal) {
  if (!body.length) throw failure('invalid_compression', context);
  const segments = [];
  let offset = 0, total = 0, pending = [], pendingBytes = 0;
  while (offset < body.length) {
    assertNotAborted(signal, context);
    const frame = zstdFrame(body, offset);
    if (!frame) throw failure('invalid_compression', context);
    if (!frame.skippable) {
      const decoded = await decodeOne(decoder, 'zstd', body.subarray(offset, frame.end),
        context.decodedLimitBytes - total, context, signal);
      total += decoded.length;
      if (total > context.decodedLimitBytes) throw failure('decoded_limit', context);
      if (decoded.length) { pending.push(decoded); pendingBytes += decoded.length; }
      // Bound temporary metadata even for a stream containing many tiny frames.
      if (pending.length >= 256 || pendingBytes >= 1024 * 1024) {
        segments.push(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes));
        pending = []; pendingBytes = 0;
      }
    }
    offset = frame.end;
  }
  if (pending.length) segments.push(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes));
  return segments.length === 1 ? segments[0] : Buffer.concat(segments, total);
}

function nextChunk(iterator, signal, context) {
  if (!signal) return iterator.next();
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (callback, value) => {
      if (finished) return;
      finished = true; signal.removeEventListener('abort', onAbort); callback(value);
    };
    const onAbort = () => settle(reject, failure('aborted', context));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try { Promise.resolve(iterator.next()).then(value => settle(resolve, value), error => settle(reject, error)); }
    catch (error) { settle(reject, error); }
  });
}

async function readWireBody(req, context, signal) {
  assertNotAborted(signal, context);
  // IncomingMessage's default async iterator destroys the socket on an early
  // return. Keep it alive so a size rejection can reach the caller as HTTP 413.
  const iterator = typeof req.iterator === 'function'
    ? req.iterator({ destroyOnReturn: false }) : req[Symbol.asyncIterator]();
  const chunks = [];
  let ended = false;
  try {
    while (true) {
      const item = await nextChunk(iterator, signal, context);
      assertNotAborted(signal, context);
      if (item.done) { ended = true; break; }
      const chunk = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value);
      context.wireBytes += chunk.length;
      if (context.wireBytes > context.wireLimitBytes) throw failure('wire_limit', context);
      chunks.push(chunk);
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, context.wireBytes);
  } catch (error) {
    if (error?.requestBodyDiagnostics) throw error;
    const aborted = signal?.aborted || error?.name === 'AbortError'
      || ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error?.code);
    throw failure(aborted ? 'aborted' : 'read_failed', context);
  } finally {
    if (!ended) {
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Preserve the original rejection. */ }
      if (typeof req.resume === 'function' && !req.destroyed) req.resume();
    }
  }
}

/** Decode a bounded model body asynchronously, in reverse Content-Encoding order. */
export async function decodeModelRequestBody(wireBody, headers, options = {}) {
  if (!Buffer.isBuffer(wireBody)) throw new TypeError('Model request body must be a Buffer.');
  const chain = encodingChain(headers);
  const context = { version: 1, encodings: chain.encodings, wireBytes: wireBody.length, decodedBytes: null,
    ...limits(options), stage: 'wire', errorKind: null };
  assertNotAborted(options.signal, context);
  if (wireBody.length > context.wireLimitBytes) throw failure('wire_limit', context);
  context.stage = 'decode';
  if (!chain.valid) throw failure('unsupported_encoding', context);
  let body = wireBody;
  for (const encoding of [...chain.encodings].reverse()) {
    assertNotAborted(options.signal, context);
    if (encoding === 'identity') continue;
    const decoder = DECODERS.get(encoding);
    if (!decoder) throw failure('unsupported_encoding', context);
    body = encoding === 'zstd' ? await decodeZstd(decoder, body, context, options.signal)
      : await decodeOne(decoder, encoding, body, context.decodedLimitBytes, context, options.signal);
  }
  assertNotAborted(options.signal, context);
  if (body.length > context.decodedLimitBytes) throw failure('decoded_limit', context);
  context.stage = 'complete'; context.decodedBytes = body.length;
  return { wireBody, body, diagnostics: normalizeRequestBodyDiagnostics(context) };
}

/** Model transport only; unrelated management and relay body limits stay separate. */
export async function readModelRequestBody(req, options = {}) {
  const context = { version: 1, encodings: encodingChain(req.headers).encodings, wireBytes: 0, decodedBytes: null,
    ...limits(options), stage: 'wire', errorKind: null };
  const wireBody = await readWireBody(req, context, options.signal);
  return decodeModelRequestBody(wireBody, req.headers, options);
}
