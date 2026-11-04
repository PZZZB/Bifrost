import { once } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { readBody } from './gateway.mjs';
import { paymentNotificationChannel } from './payments/http.mjs';

const WEB = new Set(['/register', '/account', '/account/', '/account/privacy', '/account/app.js', '/account/style.css',
  '/account/web/v1/session', '/account/web/v1/register', '/account/web/v1/login', '/account/web/v1/logout', '/account/web/v1/me', '/account/web/v1/api-key']);
const API = new Map([['/v1/account', 'GET'], ['/v1/models', 'GET'], ['/v1/chat/completions', 'POST'], ['/v1/messages', 'POST'], ['/v1/responses', 'POST']]);
const SESSION = ['x-session-id', 'x-claude-code-session-id', 'x-conversation-id', 'x-session-affinity', 'session_id', 'session-id', 'x-opencode-session'];
const fail = (status, code) => { throw Object.assign(new Error('Client gateway unavailable.'), { status, ...(code ? { code } : {}) }); };

// Node fetch rewrites Host to the loopback destination. This hop must preserve
// the already-validated public authority for origin-bound website CSRF checks.
export function loopbackHttpFetch(url, { method, headers, body, signal }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('Loopback HTTP required.');
  return new Promise((resolve, reject) => {
    const request = http.request(target, { method, headers: Object.fromEntries(headers), signal }, incoming => {
      const resultHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) resultHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
      const noBody = method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
      if (noBody) incoming.resume();
      resolve(new Response(noBody ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: resultHeaders }));
    });
    request.on('error', reject); request.end(body);
  });
}

/** A fixed loopback hop. No administrator route or caller-selected destination. */
export function createClientGatewayForwarder({ port = 43159, fetchImpl = loopbackHttpFetch } = {}) {
  if (port !== 43159) throw new TypeError('The unified account gateway must use its dedicated loopback port.');
  return {
    handles: url => url === '/v1/account' || WEB.has(url?.split('?')[0]) || url?.startsWith('/account/web/v1/'),
    async handle(req, res, signal) {
      const web = WEB.has(req.url?.split('?')[0]) || req.url?.startsWith('/account/web/v1/');
      const notification = paymentNotificationChannel(req.url);
      if (web) {
        if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(req.method)) fail(405);
      } else if (!API.has(req.url)) fail(404, 'client_gateway_route_not_found');
      else if (API.get(req.url) !== req.method) fail(405, 'client_gateway_method_not_allowed');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415);
      if (['GET', 'HEAD', 'DELETE'].includes(req.method) && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0))) fail(400);
      const headers = new Headers({ host: req.headers.host });
      const allowed = web ? ['origin', 'cookie', 'x-bifrost-csrf', 'sec-fetch-site', 'content-type', 'authorization', 'x-api-key']
        : ['authorization', 'x-api-key', 'content-type', 'accept', 'anthropic-version', 'anthropic-beta'];
      for (const name of allowed) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      if (notification === 'wechat') for (const name of ['wechatpay-timestamp', 'wechatpay-nonce', 'wechatpay-serial', 'wechatpay-signature']) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      }
      if (!web) {
        const session = SESSION.map(name => req.headers[name]).find(Boolean) ?? '';
        if (typeof session !== 'string' || session.length > 1024) fail(400);
        headers.set('x-session-id', session);
      }
      const body = req.method === 'POST' ? await readBody(req, notification ? 65_536 : web ? 8192 : 16 * 1024 * 1024) : undefined;
      const response = await fetchImpl(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body,
        redirect: 'manual', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(600_000)]) });
      if (response.status >= 300 && response.status < 400 && !(web && response.status === 303 && response.headers.get('location') === '/account/')) {
        await response.body?.cancel(); fail(502);
      }
      const output = {};
      for (const name of ['content-type', 'cache-control', 'retry-after', 'content-security-policy', 'x-content-type-options',
        'x-frame-options', 'referrer-policy', 'permissions-policy', 'location']) if (response.headers.has(name)) output[name] = response.headers.get(name);
      const cookies = response.headers.getSetCookie(); if (web && cookies.length) output['set-cookie'] = cookies;
      output['cache-control'] = 'no-store'; output['x-accel-buffering'] = 'no';
      res.writeHead(response.status, output);
      if (req.method === 'HEAD') { await response.body?.cancel(); res.end(); return; }
      try {
        if (response.body) for await (const bytes of response.body) {
          if (!res.write(bytes)) await once(res, 'drain', { ...(signal ? { signal } : {}) });
        }
        res.end();
      } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    },
  };
}
