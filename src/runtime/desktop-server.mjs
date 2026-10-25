import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError } from '../storage.mjs';
import { PROTOCOL_PATHS } from '../routing/model-router.mjs';
import { DesktopWire } from '../routing/desktop-wire.mjs';

const fail = (message, status = 400, code = 'desktop_invalid_request') => new BridgeError(message, status, code);
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const same = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw fail('请使用未压缩的 application/json。', 415);
  }
  const chunks = []; let size = 0;
  for await (const bytes of req) { size += bytes.length; if (size > 64 * 1024 * 1024) throw fail('请求内容超过大小限制。', 413); chunks.push(bytes); }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw fail('请求不是有效 JSON。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求必须是 JSON 对象。');
  return body;
}

/** Personal loopback endpoint. No public registration, account database or billing ledger. */
export function createDesktopServer({ router, apiKey, stateSecret, maxConcurrent = 4 } = {}) {
  if (!/^bdk_[A-Za-z0-9_-]{43}$/.test(apiKey) || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new TypeError('Invalid desktop listener configuration.');
  const wire = new DesktopWire({ secret: stateSecret }), active = new Set();
  let draining = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    let abort, disconnected;
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        || req.headers.host !== `127.0.0.1:${server.address()?.port}`) throw fail('只允许本机回环地址访问。', 403, 'desktop_host_rejected');
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') throw fail('本地 API 不接受浏览器跨站请求。', 403, 'desktop_origin_rejected');
      const protectedHeaders = ['authorization', 'x-api-key', 'x-session-id', 'host'];
      for (const name of protectedHeaders) {
        if (req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1) throw fail('重复的认证或会话请求头。', 400);
      }
      const bearer = req.headers.authorization;
      if (bearer !== undefined && !/^Bearer bdk_[A-Za-z0-9_-]{43}$/.test(bearer)) throw fail('本地 API Key 无效。', 401, 'desktop_key_invalid');
      const supplied = [bearer?.slice(7), req.headers['x-api-key']].filter(value => value !== undefined);
      if (!supplied.length || supplied.some(value => !same(value, apiKey))) throw fail('本地 API Key 无效。', 401, 'desktop_key_invalid');
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || /[?#\\]/.test(req.url)) throw fail('请求目标不允许。', 404, 'desktop_route_not_found');
      if (draining) throw fail('本地网关正在停止。', 503, 'desktop_draining');
      if (req.url === '/v1/models' && req.method === 'GET') { send(res, 200, { object: 'list', data: router.models() }); return; }
      if (req.url === '/desktop/status' && req.method === 'GET') {
        send(res, 200, { role: 'desktop', sources: router.status(), models: router.models(), activeRequests: active.size }); return;
      }
      const control = /^\/desktop\/sources\/([a-z][a-z0-9-]{0,31})\/(login|logout|refresh)$/.exec(req.url);
      if (control && req.method === 'POST') {
        await jsonBody(req);
        if (active.size) throw fail('请等待正在进行的模型调用结束。', 409, 'desktop_requests_active');
        const source = router.provider(control[1]);
        if (control[2] === 'refresh') { await source.refreshCatalog(); send(res, 200, source.status()); return; }
        const method = control[2] === 'login' ? 'beginLogin' : 'logout';
        if (typeof source[method] !== 'function') throw fail('此来源请在停止网关后更新用户 Key。', 400, 'desktop_source_credentials');
        send(res, 200, await source[method]()); return;
      }
      const protocol = Object.keys(PROTOCOL_PATHS).find(name => PROTOCOL_PATHS[name] === req.url);
      if (!protocol) throw fail('接口不存在。', 404, 'desktop_route_not_found');
      if (req.method !== 'POST') throw fail('请求方法不支持。', 405);
      if (active.size >= maxConcurrent) { res.setHeader('retry-after', '2'); throw fail('本地网关繁忙，请稍后重试。', 429, 'desktop_busy'); }
      abort = new AbortController(); active.add(abort);
      disconnected = () => { if (!res.writableEnded) abort.abort(); };
      req.once('aborted', disconnected); res.once('close', disconnected);
      const body = await jsonBody(req), context = router.resolve(protocol, { body, session: req.headers['x-session-id'] ?? '' });
      const prepared = wire.input(body, context);
      const upstream = await router.request(context, { body: prepared, signal: abort.signal });
      let response;
      try { response = await wire.response(upstream, context); }
      catch (error) { await upstream?.body?.cancel().catch(() => {}); throw error; }
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.setHeader('x-bifrost-source', context.provider.id);
      res.setHeader('x-bifrost-billing-authority', context.public.billing_authority);
      await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const known = error instanceof BridgeError;
      send(res, known ? error.status : 500, { error: { message: known ? error.message : '本地网关暂不可用。', code: known ? error.code : 'desktop_internal_error' } });
    } finally {
      if (abort) { active.delete(abort); abort.abort(); req.removeListener('aborted', disconnected); res.removeListener('close', disconnected); }
    }
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.requestTimeout = 300_000; server.headersTimeout = 20_000;
  server.stopRequests = () => { draining = true; for (const controller of active) controller.abort(); };
  return server;
}
