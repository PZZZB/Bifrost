const https = require('node:https');
const ROUTES = {
  login: ['POST', '/account/v1/login'], me: ['GET', '/account/v1/me'],
  logout: ['POST', '/account/v1/logout'], resetKey: ['POST', '/account/v1/api-key'],
  revokeKey: ['DELETE', '/account/v1/api-key'], deleteAccount: ['DELETE', '/account/v1/me'],
};
const unavailable = () => ({ status: 503, data: { error: { code: 'account_unavailable', message: '账号服务暂时不可用，请稍后重试。' } } });

// This function handles account operations only. It cannot select a destination,
// pass arbitrary headers, follow redirects, or call the model/admin endpoints.
function createHandler({ origin = process.env.BIFROST_ACCOUNT_ORIGIN, requestImpl = https.request } = {}) {
  return async event => {
    try {
      const base = new URL(origin);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(base.hostname)) return unavailable();
      if (!event || !Object.hasOwn(ROUTES, event.action)) return unavailable();
      const [method, path] = ROUTES[event.action];
      if (event.action !== 'login' && !/^bfs_[A-Za-z0-9_-]{43}$/.test(event.sessionToken)) {
        return { status: 401, data: { error: { code: 'session_expired', message: '请重新使用微信登录。' } } };
      }
      const body = method === 'POST' ? JSON.stringify(event.body || {}) : undefined;
      if (body && Buffer.byteLength(body) > 8192) return unavailable();
      return await new Promise(resolve => {
        const request = requestImpl(new URL(path, base), { method, headers: {
          accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          ...(event.action === 'login' ? {} : { authorization: 'Bearer ' + event.sessionToken }),
        } }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 16384) { response.destroy(); request.destroy(); resolve(unavailable()); }
            else chunks.push(chunk);
          });
          response.on('error', () => resolve(unavailable()));
          response.on('aborted', () => resolve(unavailable()));
          response.on('end', () => {
            if (![200, 400, 401, 403, 404, 405, 409, 413, 429, 502, 503].includes(response.statusCode)) { resolve(unavailable()); return; }
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
              resolve({ status: response.statusCode, data });
            } catch { resolve(unavailable()); }
          });
        });
        const timer = setTimeout(() => { request.destroy(); resolve(unavailable()); }, 12000);
        request.on('close', () => clearTimeout(timer));
        request.on('error', () => resolve(unavailable()));
        request.end(body);
      });
    } catch { return unavailable(); }
  };
}
exports.main = createHandler();
exports.createHandler = createHandler;
