import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody } from './gateway.mjs';
import { validateExternalAuthorities } from './external-claude-gateway.mjs';
import { readPrivateAccountFile } from './private-account-files.mjs';
import { WebAccountStore, WEB_PRIVACY_VERSION, webUsername } from './web-account-store.mjs';
import { webEmail } from './email-address.mjs';

const STATIC = new Map([['/account/', ['index.html', 'text/html; charset=utf-8']],
  ['/account/privacy', ['privacy.html', 'text/html; charset=utf-8']],
  ['/account/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/account/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const PREFIX = '/account/web/v1/';
const ROUTES = new Map([['session', 'GET'], ['register', 'POST'], ['login', 'POST'], ['logout', 'POST'],
  ['me', 'DELETE'], ['api-key', ['POST', 'DELETE']]]);
const SESSION_COOKIE = '__Host-bifrost_session', CSRF_COOKIE = '__Host-bifrost_csrf';
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const ERRORS = {
  invalid_request: '请求格式不正确。', not_found: '页面或接口不存在。', method_not_allowed: '操作方式不支持。',
  access_denied: '请求来源校验失败，请重新打开注册网页。', csrf_rejected: '页面校验已过期，请刷新页面后重试。',
  invalid_username: '请输入邮箱地址；旧版账号可使用原用户名登录。',
  invalid_email: '请输入正确的邮箱地址，例如 name@qq.com。暂不支持中文或带引号的邮箱地址。',
  invalid_email_domain: '这个邮箱域名没有可用的收信 DNS 配置，请检查地址是否写错。',
  email_domain_unavailable: '暂时无法检查邮箱域名，请稍后重试。邀请码尚未使用。',
  invalid_password: '密码需为 12–128 个字符，且不超过 256 字节。', privacy_required: '请先阅读并同意账号隐私说明。',
  registration_rejected: '邮箱或邀请码不可用，请检查后重试。', registration_full: '暂不接受新账号，请联系管理员。',
  login_rejected: '账号或密码不正确。', session_expired: '登录已过期，请重新登录。',
  rate_limited: '操作过于频繁，请稍后重试。', body_too_large: '请求内容过大。',
  account_unavailable: '账号服务暂时不可用，请稍后重试。',
};
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length <= 256 &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

function cookies(req) {
  if (req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'cookie').length > 1) fail(400, 'invalid_request');
  const values = new Map();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const position = part.indexOf('=');
    if (position < 0) continue;
    const name = part.slice(0, position).trim(), value = part.slice(position + 1).trim();
    if (![SESSION_COOKIE, CSRF_COOKIE].includes(name)) continue;
    if (values.has(name)) fail(400, 'invalid_request');
    values.set(name, value);
  }
  return values;
}

export function createWebAccounts({ store, csrfKey, publicOrigin, apiBaseUrl,
  publicDir = fileURLToPath(new URL('../public/accounts/', import.meta.url)), clock = Date.now } = {}) {
  const origin = new URL(publicOrigin);
  validateExternalAuthorities([origin.host]);
  if (!store || typeof csrfKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrfKey) ||
      origin.protocol !== 'https:' || origin.origin !== publicOrigin || apiBaseUrl !== publicOrigin + '/v1') throw new TypeError('Invalid web account settings.');
  const mac = value => createHmac('sha256', csrfKey).update('bifrost-web-csrf-v1:' + value).digest('hex');
  function validCsrf(value) {
    const match = typeof value === 'string' && /^([0-9]{1,13})\.([A-Za-z0-9_-]{22})\.([a-f0-9]{64})$/.exec(value);
    return !!match && Number(match[1]) <= clock() && clock() - Number(match[1]) <= 86_400_000 &&
      safeEqual(match[3], mac(match[1] + '.' + match[2]));
  }
  function json(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(status === 429 ? { 'retry-after': '60' } : {}),
      ...(status >= 400 ? { connection: 'close' } : {}) });
    res.end(JSON.stringify(data));
  }
  let windowEnd = 0, requests = 0, authRequests = 0, authActive = 0;
  const attempts = new Map();
  return {
    publicOrigin, maxAccounts: store.maxAccounts,
    handles: url => typeof url === 'string' && (['/register', '/account'].includes(url.split('?')[0]) ||
      STATIC.has(url.split('?')[0]) || url.startsWith(PREFIX)),
    getClients: () => store.clients(),
    async handle(req, res) {
      let reserved = false;
      res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY'); res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
      res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
      try {
        if (req.headers.host?.toLowerCase() !== origin.host || req.headers.origin !== undefined && req.headers.origin !== publicOrigin ||
            req.headers.authorization !== undefined || req.headers['x-api-key'] !== undefined) fail(403, 'access_denied');
        if (!req.url.startsWith('/')) fail(400, 'invalid_request');
        const url = new URL(req.url, publicOrigin);
        if (url.origin !== publicOrigin) fail(403, 'access_denied');
        if (['/register', '/account'].includes(url.pathname)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method_not_allowed');
          res.writeHead(303, { location: '/account/' }); res.end(); return;
        }
        if (STATIC.has(url.pathname)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method_not_allowed');
          const [name, type] = STATIC.get(url.pathname), bytes = await readFile(join(publicDir, name));
          res.writeHead(200, { 'content-type': type }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
        }
        if (!req.url.startsWith(PREFIX) || url.search || req.url !== url.pathname) fail(404, 'not_found');
        const action = req.url.slice(PREFIX.length), methods = ROUTES.get(action);
        if (!methods) fail(404, 'not_found');
        if (!(Array.isArray(methods) ? methods : [methods]).includes(req.method)) fail(405, 'method_not_allowed');
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'access_denied');
        if (clock() >= windowEnd) { windowEnd = clock() + 60_000; requests = 0; authRequests = 0; attempts.clear(); }
        if (++requests > 300) fail(429, 'rate_limited');
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(400, 'invalid_request');
        if (Number(req.headers['content-length'] ?? 0) > 8192) fail(413, 'body_too_large');
        const values = cookies(req), session = values.get(SESSION_COOKIE);
        let csrf = values.get(CSRF_COOKIE);
        if (action === 'session') {
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0)) fail(400, 'invalid_request');
          if (!validCsrf(csrf)) {
            const payload = clock() + '.' + randomBytes(16).toString('base64url'); csrf = payload + '.' + mac(payload);
            res.setHeader('set-cookie', cookie(CSRF_COOKIE, csrf, 86_400));
          }
          let identity = null;
          if (session) {
            try { identity = await store.me(session); }
            catch (error) {
              if (error.code !== 'session_expired') throw error;
              const previous = res.getHeader('set-cookie');
              res.setHeader('set-cookie', [...(previous ? [previous] : []), cookie(SESSION_COOKIE, '', 0)]);
            }
          }
          json(res, 200, { authenticated: !!identity, ...(identity ?? {}), csrfToken: csrf, apiBaseUrl,
            registrationMode: 'email_invite', emailVerificationRequired: false, privacyVersion: WEB_PRIVACY_VERSION }); return;
        }
        if (req.headers.origin !== publicOrigin || !validCsrf(csrf) || !safeEqual(csrf, req.headers['x-bifrost-csrf'])) fail(403, 'csrf_rejected');
        let body = {};
        if (req.method === 'POST') {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) fail(400, 'invalid_request');
          const bytes = await readBody(req, 8192);
          try { body = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_request'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
        } else if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0)) fail(400, 'invalid_request');
        const allowed = action === 'register' ? ['email', 'password', 'inviteCode', 'privacyAccepted'] : action === 'login' ? ['username', 'password'] : [];
        if (Object.keys(body).some(name => !allowed.includes(name))) fail(400, 'invalid_request');
        let result;
        if (action === 'register' || action === 'login') {
          const username = action === 'register' ? webEmail(body.email) : webUsername(body.username);
          if (++authRequests > 30 || authActive >= 2 || (attempts.get(username) ?? 0) >= 5) fail(429, 'rate_limited');
          attempts.set(username, (attempts.get(username) ?? 0) + 1); authActive++; reserved = true;
          result = await store[action](body);
          res.setHeader('set-cookie', cookie(SESSION_COOKIE, result.sessionToken, Math.floor((result.expiresAt - clock()) / 1000)));
          delete result.sessionToken;
        } else {
          result = await store.change(session, action === 'logout' ? 'logout' : action === 'me' ? 'delete'
            : req.method === 'POST' ? 'reset-key' : 'revoke-key');
          if (action === 'logout' || action === 'me') res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', 0));
        }
        json(res, 200, { ...result, apiBaseUrl });
      } catch (error) {
        const code = Object.hasOwn(ERRORS, error.code) ? error.code : error.status === 413 ? 'body_too_large' : 'account_unavailable';
        const status = code === 'account_unavailable' ? 503 : code === 'body_too_large' ? 413 : error.status;
        if (!res.destroyed) json(res, status, { error: { code, message: ERRORS[code] } });
      } finally { if (reserved) authActive--; }
    },
  };
}

export async function loadWebAccounts(path) {
  const config = JSON.parse(await readPrivateAccountFile(path, 8192));
  if (config?.version !== 1) throw new TypeError('Invalid web accounts configuration.');
  const store = new WebAccountStore(config); await store.read();
  const csrfKey = (await readPrivateAccountFile(join(config.directory, 'csrf.key'), 128)).trim();
  return createWebAccounts({ store, csrfKey, publicOrigin: config.publicOrigin, apiBaseUrl: config.apiBaseUrl });
}
