import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { BridgeError } from './storage.mjs';
import { readBody } from './gateway.mjs';
import { ClientChatAdapter } from './client-chat.mjs';
import { meterClientResponse, getClientMeter } from './client-meter.mjs';

const STATIC = { '/portal': ['portal.html', 'text/html; charset=utf-8'],
  '/portal/': ['portal.html', 'text/html; charset=utf-8'], '/register': ['portal.html', 'text/html; charset=utf-8'],
  '/login': ['portal.html', 'text/html; charset=utf-8'], '/portal.js': ['portal.js', 'text/javascript; charset=utf-8'],
  '/portal.css': ['portal.css', 'text/css; charset=utf-8'] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const fail = (message, status = 400, code = 'client_invalid_request') => new BridgeError(message, status, code);
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
function secretHeader(req) {
  const bearer = req.headers.authorization;
  if (bearer !== undefined && (typeof bearer !== 'string' || !/^Bearer [A-Za-z0-9_-]{1,256}$/.test(bearer))) throw fail('认证凭证格式无效。', 401, 'client_unauthorized');
  const values = [bearer?.slice(7), req.headers['x-api-key']].filter(value => value !== undefined);
  if (!values.length || values.some(value => typeof value !== 'string' || !same(value, values[0]))) throw fail('请提供有效 API Key。', 401, 'client_unauthorized');
  return values[0];
}
async function bodyJson(req, limit) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fail('此入口不支持压缩请求。', 415);
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('请使用 application/json。', 415);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, limit))); }
  catch (error) { if (error.status === 413) throw error; throw fail('请求不是有效 JSON。'); }
  if (!object(data)) throw fail('请求必须是 JSON 对象。');
  return data;
}

/** Public user API and inference listener. The local administrator APIs never mount here. */
export function createClientServer({ access, publicDir, publicBaseUrl, allowedHosts, getModels,
  requestResponses, requestMessages = null, requestChat = null, prepareResponses = null, billing = null, webAccounts = null,
  isDraining = () => false, csrfSecret, now = Date.now,
  maxConcurrentPerAccount = 4, maxConcurrent = 32, requestsPerMinute = 120 } = {}) {
  const publicUrl = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) throw new TypeError('Public client URL must be an origin.');
  if (typeof csrfSecret !== 'string' || csrfSecret.length < 40) throw new TypeError('A private CSRF secret is required.');
  const hosts = new Set([publicUrl.host, ...allowedHosts]);
  const origins = new Set([publicUrl.origin, ...[...hosts].flatMap(host => [`http://${host}`, `https://${host}`])]);
  const rates = new Map(), running = new Map();
  let active = 0, authenticationActive = 0;
  const csrf = token => createHmac('sha256', csrfSecret).update(`bifrost-client-csrf-v1\0${token}`).digest('base64url');
  const cookieName = 'bifrost_user_session';
  const billingRequests = new Map();
  async function dispatch(request, protocol, source) {
    const prepared = protocol === 'responses' && prepareResponses
      ? { ...request, body: prepareResponses(request.body, request.scope) } : request;
    if (!billing) return source(prepared);
    const context = billingRequests.get(request.requestId);
    if (!context || context.accountId !== request.scope) throw fail('计费请求上下文无效。', 503, 'client_billing_unavailable');
    if (request.signal?.aborted) throw fail('请求已取消。', 499, 'client_cancelled');
    await billing.begin(request.requestId); context.started = true;
    context.assertCurrent();
    if (request.signal?.aborted) throw fail('请求已取消。', 499, 'client_cancelled');
    context.dispatched = true;
    const response = await source(prepared);
    const metered = meterClientResponse(response, { protocol, signal: request.signal,
      onResult: async ({ usage, status }) => {
        if (usage && status === 'completed') await billing.settle(request.requestId, usage);
        else if (status === 'rejected') await billing.reject(request.requestId);
        else await billing.markUnresolved(request.requestId, { reason: 'usage_missing' });
      } });
    context.meter = getClientMeter(metered);
    if (!metered.ok) {
      // Chat clients cancel rejected bodies immediately. Read a bounded error
      // body here so authoritative usage is settled before that cancellation.
      const chunks = []; let size = 0;
      if (metered.body) for await (const bytes of metered.body) {
        size += bytes.byteLength;
        if (size > 64 * 1024 * 1024) throw fail('上游错误响应超过大小限制。', 502, 'client_upstream_protocol');
        chunks.push(bytes);
      }
      await context.meter.finish;
      return new Response(Buffer.concat(chunks), { status: metered.status, headers: metered.headers });
    }
    return metered;
  }
  const meteredResponses = request => dispatch(request, 'responses', requestResponses);
  const chat = new ClientChatAdapter({ requestResponses: meteredResponses });
  function endpoint() {
    const root = webAccounts ? new URL(webAccounts.apiBaseUrl).origin : publicUrl.origin;
    return { baseUrl: `${root}/v1`, portalUrl: webAccounts ? `${webAccounts.publicOrigin}/account/` : `${root}/portal`, modelsUrl: `${root}/v1/models`,
      responsesUrl: `${root}/v1/responses`, messagesUrl: `${root}/v1/messages`, chatCompletionsUrl: `${root}/v1/chat/completions` };
  }
  function rate(key, maximum, interval) {
    const at = now();
    if (rates.size > 2048) for (const [id, row] of rates) if (row.resetAt <= at) rates.delete(id);
    const previous = rates.get(key), row = previous && previous.resetAt > at ? previous : { count: 0, resetAt: at + interval };
    if (!previous && rates.size >= 4096) throw fail('请求过于频繁，请稍后重试。', 429, 'client_rate_limited');
    row.count++; rates.set(key, row);
    if (row.count > maximum) throw fail('请求过于频繁，请稍后重试。', 429, 'client_rate_limited');
  }
  function writeOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('拒绝跨站请求。', 403, 'client_origin_rejected');
    if (req.headers.origin && !origins.has(req.headers.origin)) throw fail('请求来源不允许。', 403, 'client_origin_rejected');
  }
  function session(req, write = false) {
    let token, bearer = false;
    if (req.headers.authorization) { token = secretHeader(req); bearer = true; }
    else token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const principal = access.authenticateSession(token);
    if (!principal) throw fail('请重新登录用户中心。', 401, 'client_session_required');
    if (write) { writeOrigin(req); if (!bearer && !same(req.headers['x-csrf-token'], csrf(token))) throw fail('会话校验失败，请刷新用户中心。', 403, 'client_csrf_rejected'); }
    return { token, principal, csrfToken: csrf(token) };
  }
  function userModels(principal) {
    return getModels().filter(model => principal.allowedModels.includes(model.id) && model.enabled !== false && model.available !== false);
  }
  function userBilling(principal, before) {
    if (!billing) return null;
    const history = billing.history(principal.accountId, { limit: 50, ...(before === undefined ? {} : { before }) });
    return { ...billing.account(principal.accountId), history: history.rows, nextBefore: history.nextBefore };
  }
  function cookie(res, value, expiresAt) {
    res.setHeader('set-cookie', `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/portal/api/; ${publicUrl.protocol === 'https:' ? 'Secure; ' : ''}${expiresAt ? `Expires=${new Date(expiresAt).toUTCString()}` : 'Max-Age=0'}`);
  }
  async function login(res, credentials) {
    const logged = await access.login(credentials); cookie(res, logged.sessionToken, logged.expiresAt);
    return { user: logged.account, sessionToken: logged.sessionToken, expiresAt: logged.expiresAt, csrfToken: csrf(logged.sessionToken) };
  }
  async function relay(req, res, response, abort) {
    if (!(response instanceof Response)) throw fail('模型渠道暂不可用。', 502, 'client_upstream_unavailable');
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    try {
      if (response.body) for await (const bytes of response.body) {
        if (!res.write(bytes)) await once(res, 'drain', { signal: abort.signal });
      }
      res.end();
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('x-frame-options', 'DENY');
    let counted = false;
    try {
      if (!hosts.has(req.headers.host)) throw fail('Host 不允许。', 403, 'client_host_rejected');
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fail('请求目标不允许。', 403);
      const url = new URL(req.url, publicUrl);
      if (url.origin !== publicUrl.origin || url.hash) throw fail('请求目标不允许。', 403);
      const path = url.pathname;
      if (webAccounts?.handles(req.url)) { await webAccounts.handle(req, res); return; }
      if (req.method === 'GET' && STATIC[path]) {
        const [file, type] = STATIC[path], content = await readFile(join(publicDir, file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(content); return;
      }
      if (path === '/' && req.method === 'GET') { res.writeHead(302, { location: '/portal' }).end(); return; }
      if (path === '/health' && req.method === 'GET') { json(res, 200, { ok: true, service: 'bifrost-client' }); return; }
      if (path === '/portal/api/config' && req.method === 'GET') {
        const policy = access.registrationPolicy();
        json(res, 200, { registration: { enabled: policy.mode !== 'closed', invitationRequired: policy.mode === 'invite', mode: policy.mode },
          gateway: endpoint(), keyDefaults: { expiresInDays: policy.defaultKeyDays } }); return;
      }
      if (path.startsWith('/api/')) throw fail('此入口不提供管理员接口。', 404, 'client_route_not_found');
      if (isDraining() && req.method !== 'GET') throw fail('网关正在重启，请稍后重试。', 503, 'gateway_restarting');
      active++; counted = true;
      if (path === '/portal/api/register' || path === '/portal/api/login') {
        if (req.method !== 'POST') throw fail('请求方法不支持。', 405);
        writeOrigin(req);
        rate(`auth:${req.socket.remoteAddress}`, 20, 60_000);
        const body = await bodyJson(req, 8192);
        if (authenticationActive >= 2) throw fail('登录请求较多，请稍后重试。', 429, 'client_rate_limited');
        authenticationActive++;
        try {
          if (path.endsWith('/register')) {
            const registered = await access.register(body);
            cookie(res, registered.sessionToken, registered.expiresAt);
            json(res, 201, { user: registered.account, sessionToken: registered.sessionToken, expiresAt: registered.expiresAt,
              csrfToken: csrf(registered.sessionToken), key: registered.key, secret: registered.secret });
          } else json(res, 200, await login(res, body));
          return;
        } finally { authenticationActive--; }
      }
      if (path.startsWith('/portal/api/')) {
        const auth = session(req, req.method !== 'GET');
        if (path === '/portal/api/session' && req.method === 'GET') { json(res, 200, { user: access.publicAccount(auth.principal.accountId), csrfToken: auth.csrfToken }); return; }
        if (path === '/portal/api/me' && req.method === 'GET') {
          const user = access.publicAccount(auth.principal.accountId);
          const prices = billing?.snapshot().prices ?? [];
          json(res, 200, { user, keys: user.keys, billing: userBilling(auth.principal), models: userModels(auth.principal).map(model => ({ ...model,
            pricing: prices.find(price => price.model === model.id && price.enabled) ?? null })), gateway: endpoint(), keyDefaults: { expiresInDays: access.registrationPolicy().defaultKeyDays } }); return;
        }
        if (path === '/portal/api/billing' && req.method === 'GET') {
          if (!billing) throw fail('计费账本尚未就绪。', 503, 'client_billing_unavailable');
          const models = userModels(auth.principal);
          json(res, 200, { ...userBilling(auth.principal, url.searchParams.get('before') ?? undefined),
            prices: billing.snapshot().prices.filter(price => price.enabled && models.some(model => model.id === price.model)) }); return;
        }
        if (path === '/portal/api/logout' && req.method === 'POST') { await bodyJson(req, 1024); const current = session(req, true); await access.logout(current.token); cookie(res, '', null); json(res, 200, { ok: true }); return; }
        if (path === '/portal/api/keys' && req.method === 'POST') {
          rate(`key:${auth.principal.accountId}`, 20, 60_000);
          const body = await bodyJson(req, 4096), current = session(req, true);
          json(res, 201, await access.createKey(current.principal.accountId, body)); return;
        }
        const match = /^\/portal\/api\/keys\/([0-9a-f-]{36})$/.exec(path);
        if (match && req.method === 'DELETE') { await access.revokeKey(auth.principal.accountId, match[1]); json(res, 200, { revoked: true }); return; }
        throw fail('用户接口不存在。', 404, 'client_route_not_found');
      }
      if (!['/v1/models', '/v1/responses', '/v1/chat/completions', '/v1/messages'].includes(path)) throw fail('接口不存在。', 404, 'client_route_not_found');
      const suppliedKey = secretHeader(req), principal = access.authenticateKey(suppliedKey);
      if (!principal) throw fail('API Key 无效、已停用或已过期。', 401, 'client_key_invalid');
      if (req.headers.origin !== undefined) throw fail('模型入口不接受浏览器跨站调用。', 403, 'client_origin_rejected');
      if (path === '/v1/models' && req.method === 'GET') {
        json(res, 200, { object: 'list', data: userModels(principal).map(model => ({ id: model.id, object: 'model', owned_by: 'bifrost' })) }); return;
      }
      if (req.method !== 'POST' || path === '/v1/models') throw fail('请求方法不支持。', 405);
      const used = running.get(principal.accountId) ?? 0;
      if (used >= maxConcurrentPerAccount || [...running.values()].reduce((a, b) => a + b, 0) >= maxConcurrent) throw fail('并发请求已达上限，请稍后重试。', 429, 'client_concurrency_limit');
      rate(`inference:${principal.accountId}`, requestsPerMinute, 60_000);
      const abort = new AbortController();
      const disconnected = () => { if (!res.writableEnded) abort.abort(); };
      req.once('aborted', disconnected); res.once('close', disconnected);
      running.set(principal.accountId, used + 1);
      let billingContext;
      try {
        const body = await bodyJson(req, 64 * 1024 * 1024), current = access.authenticateKey(suppliedKey);
        if (!current) throw fail('API Key 无效、已停用或已过期。', 401, 'client_key_invalid');
        const model = userModels(current).find(model => model.id === body.model);
        if (!model) throw fail('此 Key 未获准访问所选模型，或模型当前不可用。', 403, 'client_model_forbidden');
        if (billing) {
          const requestId = randomUUID();
          await billing.reserve({ accountId: current.accountId, keyId: current.keyId, model: body.model, requestId });
          billingContext = { requestId, accountId: current.accountId, started: false, dispatched: false, meter: null,
            assertCurrent: () => {
              const latest = access.authenticateKey(suppliedKey);
              if (!latest) throw fail('API Key 无效、已停用或已过期。', 401, 'client_key_invalid');
              if (!userModels(latest).some(model => model.id === body.model)) throw fail('此模型已停止授权。', 403, 'client_model_forbidden');
            } };
          billingRequests.set(requestId, billingContext);
        }
        const session = req.headers['x-session-id'] ?? '';
        if (typeof session !== 'string' || session.length > 1024) throw fail('会话标识无效。');
        const request = { body, scope: principal.accountId, session, signal: abort.signal, ...(billingContext ? { requestId: billingContext.requestId } : {}) };
        let response;
        if (path === '/v1/chat/completions') response = model.channel === 'Claude' && requestChat
          ? await dispatch(request, 'chat', requestChat) : await chat.request(request);
        else if (path === '/v1/responses') {
          if (model.channel === 'Claude') throw fail('此模型支持 Chat Completions 和 Messages。', 501, 'client_protocol_unsupported');
          response = await meteredResponses(request);
        }
        else {
          if (!['CodeBuddy', 'Claude'].includes(model.channel) || !requestMessages) throw fail('此模型暂未提供 Messages 接入，请使用 Chat Completions 或 Responses。', 501, 'client_protocol_unsupported');
          response = await dispatch(request, 'messages', requestMessages);
        }
        if (model.channel === 'Claude' && !response.ok) {
          // dispatch has already inspected error usage. Public errors must not
          // reveal host addresses, operating systems, or upstream credentials.
          await response.body?.cancel().catch(() => {});
          response = Response.json({ error: { message: '模型服务暂时不可用，请稍后重试或联系管理员。', code: 'client_upstream_rejected' } },
            { status: [400, 413, 422, 429].includes(response.status) ? response.status : 503 });
        }
        await relay(req, res, response, abort);
      } finally {
        try {
          if (billingContext) {
            if (billingContext.meter) { await billingContext.meter.cancel(); await billingContext.meter.finish; }
            else if (billingContext.dispatched) await billing.markUnresolved(billingContext.requestId, { reason: 'client_disconnected' });
            else if (billingContext.started) await billing.reject(billingContext.requestId);
            else await billing.release(billingContext.requestId, { reason: 'upstream_not_started' });
          }
        } finally {
          if (billingContext) billingRequests.delete(billingContext.requestId);
          const remaining = (running.get(principal.accountId) ?? 1) - 1;
          if (remaining) running.set(principal.accountId, remaining); else running.delete(principal.accountId);
          req.removeListener('aborted', disconnected); res.removeListener('close', disconnected);
        }
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof BridgeError;
      json(res, known ? error.status : 500, { error: { message: known ? error.message : '用户接入服务暂不可用。',
        type: 'invalid_request_error', code: known ? error.code : 'client_internal_error' } });
    } finally { if (counted) active--; }
  });
  server.requestTimeout = 300_000; server.headersTimeout = 20_000;
  Object.defineProperty(server, 'activeRequests', { get: () => active });
  server.once('close', () => chat.close());
  server.clientEndpoint = endpoint;
  return server;
}
