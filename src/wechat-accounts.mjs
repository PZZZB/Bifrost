import { join, isAbsolute } from 'node:path';
import { readBody } from './gateway.mjs';
import { validateExternalAuthorities } from './external-claude-gateway.mjs';
import { createWeChatLogin } from './wechat-login.mjs';
import { WeChatAccountStore, readPrivateAccountFile, ACCOUNT_PRIVACY_VERSION } from './wechat-account-store.mjs';

const ROUTES = new Map([
  ['/account/v1/login', ['POST']], ['/account/v1/me', ['GET', 'DELETE']],
  ['/account/v1/logout', ['POST']], ['/account/v1/api-key', ['POST', 'DELETE']],
]);
const failure = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const MESSAGES = {
  invalid_request: '请求格式不正确。', method_not_allowed: '请求方法不支持。', not_found: '接口不存在。',
  privacy_required: '请先阅读并同意账号隐私说明。', invite_required: '首次注册需要有效的邀请码。',
  registration_full: '当前暂不接受新账号，请联系管理员。', account_disabled: '账号已停用，请联系管理员。',
  session_expired: '登录已过期，请重新使用微信登录。', wechat_login_rejected: '微信登录凭证已失效，请重试。',
  invalid_login_code: '微信登录凭证不正确，请重试。', wechat_unavailable: '微信登录暂时不可用，请稍后重试。',
  rate_limited: '操作过于频繁，请稍后再试。', body_too_large: '请求内容过大。',
  account_unavailable: '账号服务暂时不可用，请稍后重试。',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(status === 429 ? { 'retry-after': '60' } : {}) });
  res.end(JSON.stringify(body));
}

export function createWeChatAccounts({ store, exchangeCode, apiBaseUrl, clock = Date.now } = {}) {
  if (!store || typeof exchangeCode !== 'function') throw new TypeError('Invalid account service.');
  const base = new URL(apiBaseUrl);
  validateExternalAuthorities([base.host]);
  if (base.protocol !== 'https:' || base.pathname !== '/v1' || base.search || base.hash || base.username || base.password) {
    throw new TypeError('Invalid account API base URL.');
  }
  let windowEnd = 0, requests = 0, logins = 0, loginActive = 0;
  return {
    getClients: () => store.clients(),
    async handle(req, res) {
      let reserved = false;
      try {
        if (!ROUTES.has(req.url)) failure(404, 'not_found');
        if (!ROUTES.get(req.url).includes(req.method)) failure(405, 'method_not_allowed');
        if (clock() >= windowEnd) { requests = 0; logins = 0; windowEnd = clock() + 60_000; }
        if (++requests > 300) failure(429, 'rate_limited');
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity' ||
            req.headers['x-api-key'] !== undefined || req.headers.cookie !== undefined) failure(400, 'invalid_request');
        if (Number(req.headers['content-length'] ?? 0) > 8192) failure(413, 'body_too_large');
        const login = req.url === '/account/v1/login';
        let sessionToken;
        if (login) {
          if (req.headers.authorization !== undefined) failure(400, 'invalid_request');
          if (++logins > 30 || loginActive >= 2) failure(429, 'rate_limited');
          loginActive++; reserved = true;
        } else {
          sessionToken = /^Bearer (bfs_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
          if (!sessionToken) failure(401, 'session_expired');
          await store.me(sessionToken);
        }
        let body = {};
        if (req.method === 'GET' || req.method === 'DELETE') {
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0)) failure(400, 'invalid_request');
        } else {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) failure(400, 'invalid_request');
          const bytes = await readBody(req, 8192);
          try { body = JSON.parse(bytes.toString('utf8')); } catch { failure(400, 'invalid_request'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) failure(400, 'invalid_request');
          const allowed = login ? ['code', 'inviteCode', 'privacyAccepted'] : [];
          if (Object.keys(body).some(name => !allowed.includes(name)) || login &&
              (typeof body.code !== 'string' || body.inviteCode !== undefined &&
                (typeof body.inviteCode !== 'string' || body.inviteCode.length > 128) ||
                body.privacyAccepted !== true)) failure(400, 'invalid_request');
        }
        let result;
        if (login) {
          const openid = await exchangeCode(body.code);
          result = await store.login({ openid, inviteCode: body.inviteCode, privacyAccepted: body.privacyAccepted });
        } else if (req.url === '/account/v1/me' && req.method === 'GET') result = await store.me(sessionToken);
        else result = await store.change(sessionToken, req.url.endsWith('/logout') ? 'logout'
          : req.url.endsWith('/me') ? 'delete' : req.method === 'POST' ? 'reset-key' : 'revoke-key');
        json(res, 200, { ...result, apiBaseUrl: base.href, privacyVersion: ACCOUNT_PRIVACY_VERSION });
      } catch (error) {
        const code = Object.hasOwn(MESSAGES, error.code) ? error.code : error.status === 413 ? 'body_too_large' : 'account_unavailable';
        const status = code === 'account_unavailable' ? 503 : code === 'body_too_large' ? 413 : error.status;
        if (!res.destroyed) json(res, status, { error: { code, message: MESSAGES[code] } });
      } finally { if (reserved) loginActive--; }
    },
  };
}

export async function loadWeChatAccountStore(directory, settings = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('Private account directory required.');
  const identityKey = (await readPrivateAccountFile(join(directory, 'identity.key'), 128)).trim();
  const store = new WeChatAccountStore({ ...settings, directory, identityKey });
  await store.read();
  return store;
}

export async function loadWeChatAccounts(path) {
  const config = JSON.parse(await readPrivateAccountFile(path, 8192));
  if (config?.version !== 1 || typeof config.appSecretFile !== 'string') throw new TypeError('Invalid WeChat configuration.');
  const store = await loadWeChatAccountStore(config.directory, { appId: config.appId,
    maxAccounts: config.maxAccounts ?? 50, maxConcurrent: config.maxConcurrent ?? 1,
    requestsPerMinute: config.requestsPerMinute ?? 20, sessionTtlMs: config.sessionTtlMs ?? 86_400_000 });
  const appSecret = (await readPrivateAccountFile(config.appSecretFile, 256)).trim();
  const exchangeCode = createWeChatLogin({ appId: config.appId, appSecret });
  return createWeChatAccounts({ store, exchangeCode, apiBaseUrl: config.apiBaseUrl });
}
