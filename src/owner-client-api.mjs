import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { ClientChatAdapter } from './client-chat.mjs';
import { ClientStateCodec } from './client-state.mjs';
import { publicClientModel } from './client-model-catalog.mjs';

export const OWNER_CLIENT_PATHS = Object.freeze({ models: '/owner/v1/models', chat: '/owner/v1/chat/completions' });
const paths = new Set(Object.values(OWNER_CLIENT_PATHS));
const channels = new Set(['B', 'CodeBuddy', 'Cursor', 'Bifrost']);
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (status, code, message) => Object.assign(new Error(message), { status, code, ownerClientError: true });
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
function authorized(req, key) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length !== 1) return false;
  const supplied = Buffer.from(value.slice(7)), expected = Buffer.from(key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function modelAllowed(model) {
  return object(model) && channels.has(model.channel) && model.sourceKind !== 'codex-client'
    && model.sourceCredential?.mode !== 'caller' && model.enabled === true && model.available === true
    && typeof model.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,279}$/.test(model.id) && !model.id.includes('..')
    && (!Array.isArray(model.protocols) || model.protocols.includes('responses'));
}
function ownerScope(key) {
  const hex = createHmac('sha256', key).update('bifrost-owner-client-scope-v1').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function readJson(req, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw error(415, 'owner_client_content_type', '请使用 application/json。');
  }
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
    throw error(415, 'owner_client_content_encoding', '本机所有者入口不接收压缩请求。');
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw error(413, 'owner_client_body_limit', '请求超过大小限制。');
  }
  let size = 0; const chunks = [];
  for await (const bytes of req) {
    size += bytes.length;
    if (size > maximum) throw error(413, 'owner_client_body_limit', '请求超过大小限制。');
    chunks.push(bytes);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw error(400, 'owner_client_invalid_json', '请求不是有效 JSON。'); }
  if (!object(value)) throw error(400, 'owner_client_invalid_json', '请求必须为 JSON 对象。');
  return value;
}

/** Loopback inference for the local owner. This API has no account, key or management mutations. */
export function createOwnerClientApi({ gatewayKey, getModels, requestResponses, isDraining = () => false,
  maxConcurrent = 4, maxBodyBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof gatewayKey !== 'string' || !/^[\x21-\x7e]{40,4096}$/.test(gatewayKey)
    || typeof getModels !== 'function' || typeof requestResponses !== 'function' || typeof isDraining !== 'function'
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024) {
    throw new TypeError('Invalid local owner client API options.');
  }
  const scope = ownerScope(gatewayKey), controllers = new Set();
  const codecSecret = createHmac('sha256', gatewayKey).update('bifrost-owner-client-codec-v1').digest('base64url');
  const codec = new ClientStateCodec({ secret: codecSecret });
  let active = 0, closed = false;
  async function models() {
    const value = await getModels();
    if (!Array.isArray(value) || value.length > 4096) throw error(503, 'owner_client_catalog_unavailable', '本机模型目录暂不可用。');
    const seen = new Set();
    return value.filter(model => {
      if (!modelAllowed(model) || seen.has(model.id)) return false;
      seen.add(model.id); return true;
    });
  }
  const chat = new ClientChatAdapter({ requestResponses: async request => {
    if (closed || isDraining()) return Response.json({ error: { message: '网关正在停止或重启。' } }, { status: 503 });
    if (!(await models()).some(model => model.id === request.body.model)) {
      return Response.json({ error: { message: '所选模型已停用或不可用。' } }, { status: 403 });
    }
    const body = codec.input(request.body, scope);
    const response = await requestResponses({ body, scope, signal: request.signal });
    if (!(response instanceof Response)) throw error(502, 'owner_client_upstream_failed', '模型渠道未返回有效响应。');
    return codec.response(response, scope, body.model);
  } });
  return {
    handles: pathname => paths.has(pathname),
    get activeRequests() { return active; },
    async handle(req, res) {
      let counted = false, controller = null, response = null;
      const cancel = () => controller?.abort();
      const disconnected = () => { if (!res.writableEnded) cancel(); };
      res.setHeader('x-content-type-options', 'nosniff');
      try {
        if (!loopback.has(req.socket?.remoteAddress)) throw error(403, 'owner_client_loopback_required', '此入口仅允许本机连接。');
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') {
          throw error(403, 'owner_client_origin_rejected', '此入口只接受本机客户端，不接受浏览器跨站请求。');
        }
        if (!authorized(req, gatewayKey)) throw error(401, 'owner_client_unauthorized', '请提供有效的本机网关 Key。');
        if (!paths.has(req.url)) throw error(404, 'owner_client_route_not_found', '本机模型接口不存在。');
        const method = req.url === OWNER_CLIENT_PATHS.models ? 'GET' : 'POST';
        if (req.method !== method) {
          res.setHeader('allow', method);
          throw error(405, 'owner_client_method_not_allowed', '请求方法不支持。');
        }
        if (closed) throw error(503, 'owner_client_closed', '本机所有者入口已停止。');
        if (method === 'GET') {
          json(res, 200, { object: 'list', data: (await models()).map(model => publicClientModel({ ...model, protocols: ['chat-completions'] })) });
          return;
        }
        if (isDraining()) throw error(503, 'owner_client_draining', '网关正在重启，请稍后重试。');
        if (active >= maxConcurrent) throw error(429, 'owner_client_concurrency_limit', '本机模型请求过多，请稍后重试。');
        active++; counted = true; controller = new AbortController(); controllers.add(controller);
        req.once('aborted', cancel); res.once('close', disconnected);
        const body = await readJson(req, maxBodyBytes);
        if (!(await models()).some(model => model.id === body.model)) throw error(403, 'owner_client_model_forbidden', '所选模型未开放、不可用或不属于本机独立授权来源。');
        response = await chat.request({ body, scope, signal: controller.signal });
        if (res.destroyed || controller.signal.aborted) return;
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
          'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        if (response.body) for await (const bytes of response.body) {
          if (!res.write(bytes)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } catch (cause) {
        cancel();
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(); return; }
        const known = cause?.ownerClientError === true;
        const status = known ? cause.status : cause?.name === 'AbortError' ? 499 : 503;
        json(res, status, { error: { type: status >= 500 ? 'server_error' : 'invalid_request_error',
          code: known ? cause.code : status === 499 ? 'owner_client_cancelled' : 'owner_client_unavailable',
          message: known ? cause.message : status === 499 ? '请求已取消。' : '本机模型入口暂不可用。' } });
      } finally {
        req.off('aborted', cancel); res.off('close', disconnected);
        if (controller) controllers.delete(controller);
        if (controller?.signal.aborted) await response?.body?.cancel().catch(() => {});
        if (counted) active--;
      }
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); chat.close(); },
  };
}
