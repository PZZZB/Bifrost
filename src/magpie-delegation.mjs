import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { BridgeError } from './storage.mjs';
import { keyMatches, readBody } from './gateway.mjs';

export const MAGPIE_DELEGATION_BASE_URL = 'http://127.0.0.1:3425/backend-api/codex';
const LEGACY_MODELS = Object.freeze({
  'B-gpt-6-astra': 'group/b-gpt-6-astra',
  'B-gpt-6.1-sol': 'group/b-gpt-6.1-sol',
});
const B_GROUP_MODELS = new Set(Object.values(LEGACY_MODELS));
const PREFIX = '/backend-api/codex';
const MODEL_PATHS = new Set(['/responses', '/responses/compact', '/alpha/search']);
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const MAX_BODY = 64 * 1024 * 1024;

/** Removing this marker restores the original startup branch on the next restart. */
export async function loadMagpieDelegation(path) {
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new BridgeError('Magpie 委托配置无法读取。', 503, 'invalid_delegation');
  }
  let data;
  try { if (bytes.length > 4096) throw new Error(); data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new BridgeError('Magpie 委托配置无效。', 503, 'invalid_delegation'); }
  if (!data || Array.isArray(data) || data.version !== 1 ||
      data.baseUrl !== MAGPIE_DELEGATION_BASE_URL ||
      Object.keys(data).length !== 2) {
    // An invalid marker must never restart the old owner of B's refresh token.
    throw new BridgeError('Magpie 委托配置无效。', 503, 'invalid_delegation');
  }
  return Object.freeze({ version: 1, baseUrl: MAGPIE_DELEGATION_BASE_URL });
}

function backendSuffix(pathname) {
  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) return pathname.slice(PREFIX.length) || '/';
  if (pathname.startsWith('/v1/')) return pathname.slice('/v1'.length);
  if (['/models', ...MODEL_PATHS].includes(pathname)) return pathname;
  return null;
}

function forwardedHeaders(incoming) {
  const blocked = new Set([...HOP_HEADERS,
    ...(incoming.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  const result = Object.create(null);
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower.startsWith('x-account-bridge-') || lower === 'x-bridge-csrf') continue;
    if (value !== undefined) result[lower] = value;
  }
  return result;
}

function requestBody(body, headers, path) {
  if (!body.length) {
    if (MODEL_PATHS.has(path)) throw new BridgeError('模型请求缺少 model。');
    return { body, isB: false };
  }
  // Future non-JSON Codex endpoints remain byte-for-byte passthrough.
  if (!MODEL_PATHS.has(path) && !/\bjson\b/i.test(headers['content-type'] ?? '')) return { body, isB: false };
  let decoded = body;
  const decompressors = { gzip: zlib.gunzipSync, zstd: zlib.zstdDecompressSync,
    deflate: zlib.inflateSync, br: zlib.brotliDecompressSync };
  for (const value of (headers['content-encoding'] ?? 'identity').toLowerCase().split(',').reverse()) {
    const encoding = value.trim();
    if (encoding === 'identity') continue;
    if (typeof decompressors[encoding] !== 'function') throw new BridgeError('不支持此请求压缩格式。', 415);
    try { decoded = decompressors[encoding](decoded, { maxOutputLength: MAX_BODY }); }
    catch { throw new BridgeError('模型请求解压失败或正文超过大小限制。', 400); }
  }
  let data;
  try {
    // Replacing only the model must not round integers, exponents, or negative zero.
    data = JSON.parse(decoded.toString('utf8'), (_key, value, context) =>
      typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  }
  catch { throw new BridgeError('模型请求不是有效 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      (MODEL_PATHS.has(path) && (typeof data.model !== 'string' || !data.model))) {
    throw new BridgeError('模型请求缺少 model。');
  }
  if (typeof data.model !== 'string') return { body, isB: false };
  const mapped = Object.hasOwn(LEGACY_MODELS, data.model) ? LEGACY_MODELS[data.model] : null;
  if (!mapped && /^b-/i.test(data.model)) throw new BridgeError('未知的 B 模型，已停止请求。', 400, 'unknown_b_model');
  if (!mapped) return { body, isB: B_GROUP_MODELS.has(data.model) };
  data.model = mapped;
  return { body: Buffer.from(JSON.stringify(data)), isB: true, reencoded: true };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** A compatibility transport only: no Codex RPC, credential store, or account fallback. */
export function createMagpieDelegationServer({ gatewayKey, baseUrl = 'http://127.0.0.1:43155',
  requestImpl = http.request, maxConcurrent = 16, requestTimeoutMs = 30 * 60_000 } = {}) {
  if (typeof gatewayKey !== 'string' || gatewayKey.length < 40) throw new TypeError('A private gateway key is required.');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('Invalid delegation limits.');
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new TypeError('The compatibility listener must use loopback.');
  const allowedHosts = new Set([base.host, `localhost:${base.port}`]);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let controller, timer;
    try {
      if (!allowedHosts.has(req.headers.host)) throw new BridgeError('Host 不允许。', 403);
      const url = new URL(req.url, base);
      if (url.origin !== base.origin || url.username || url.password) throw new BridgeError('请求目标不允许。', 403);
      if (url.pathname === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, version: '0.1.0', delegation: 'magpie', active }); return;
      }
      const path = backendSuffix(url.pathname);
      if (path === null) throw new BridgeError('Codex 已委托给 Magpie；旧管理接口已停用。', 410, 'delegated_to_magpie');
      // The old independent header remains mandatory. A's bearer is never a gateway key.
      if (!keyMatches(req.headers['x-account-bridge-key'], gatewayKey)) throw new BridgeError('网关认证失败。', 401, 'invalid_gateway_key');
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) throw new BridgeError('请求方法不支持。', 405);
      if (active >= maxConcurrent) { res.setHeader('Retry-After', '1'); throw new BridgeError('Magpie 委托请求过多，请稍后重试。', 429); }
      active++;
      controller = new AbortController();
      const abort = () => { if (!res.writableEnded) controller.abort(); };
      req.once('aborted', abort); res.once('close', abort);
      timer = setTimeout(() => controller.abort(new Error('delegation_timeout')), requestTimeoutMs);
      timer.unref?.();
      const original = await readBody(req, MAX_BODY);
      controller.signal.throwIfAborted();
      const { body, isB, reencoded } = requestBody(original, req.headers, path);
      const headers = forwardedHeaders(req.headers);
      const cookies = headers.cookie?.split(';').filter(value => !value.trim().startsWith('bridge_session='));
      if (cookies?.some(value => value.trim())) headers.cookie = cookies.join(';'); else delete headers.cookie;
      if (isB) {
        // A cannot become an accidental fallback if the requested group is unavailable.
        delete headers.authorization; delete headers['chatgpt-account-id']; delete headers.cookie;
        delete headers['x-oai-attestation'];
        if (reencoded) {
          delete headers['content-encoding']; delete headers['content-length'];
          headers['content-length'] = String(body.length);
        }
      } else if (!headers.authorization || keyMatches(headers.authorization.replace(/^Bearer\s+/i, ''), gatewayKey)) {
        throw new BridgeError('原有模型需要当前 Codex 的账户 A 授权。', 401, 'account_a_auth_required');
      }
      const upstream = await new Promise((resolve, reject) => {
        const target = `${MAGPIE_DELEGATION_BASE_URL}${path}${url.search}`;
        const outgoing = requestImpl(target, { method: req.method, headers, signal: controller.signal }, resolve);
        outgoing.once('error', reject);
        outgoing.end(body.length ? body : undefined);
      });
      const outputHeaders = forwardedHeaders(upstream.headers);
      for (const name of Object.keys(outputHeaders)) if (name.startsWith('access-control-')) delete outputHeaders[name];
      res.writeHead(upstream.statusCode, outputHeaders);
      await pipeline(upstream, res, { signal: controller.signal });
    } catch (error) {
      if (res.headersSent || res.destroyed) { if (!res.writableEnded) res.destroy(); return; }
      const known = error instanceof BridgeError;
      json(res, known ? error.status : controller?.signal.aborted ? 504 : 502, {
        error: { code: known ? error.code : 'magpie_delegation_failed',
          message: known ? error.message : 'Magpie 委托请求失败，请检查本机服务。' },
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) { controller.abort(); active--; }
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.once('listening', () => {
    if (base.port !== '0') return;
    base.port = String(server.address().port);
    allowedHosts.clear(); allowedHosts.add(base.host); allowedHosts.add(`localhost:${base.port}`);
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUse HTTP/SSE for this provider.'));
  return server;
}
