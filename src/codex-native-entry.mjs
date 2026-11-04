import { createHmac } from 'node:crypto';
import { backendPath, keyMatches } from './gateway.mjs';
import { BridgeError } from './storage.mjs';

export const CODEX_NATIVE_PREFIX = '/_bifrost/codex/';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The built-in OpenAI provider supports a base URL, but no custom bridge header. */
export function createCodexNativeEntry({ baseUrl, gatewayKey }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/backend-api/codex'
    || typeof gatewayKey !== 'string' || !gatewayKey || /[\r\n]/.test(gatewayKey)) {
    throw new TypeError('The Codex native entry requires a loopback bridge endpoint and key.');
  }
  // Domain separation keeps the local URL capability independent of all public API keys.
  const token = `bfn_${createHmac('sha256', gatewayKey).update('bifrost-codex-native-entry-v1').digest('base64url')}`;
  const pathname = `${CODEX_NATIVE_PREFIX}${token}/backend-api/codex`;
  const allowedHosts = new Set([base.host, `127.0.0.1:${base.port}`, `localhost:${base.port}`, `[::1]:${base.port}`]);
  return Object.freeze(Object.defineProperties({
    handles: path => typeof path === 'string' && path.startsWith(CODEX_NATIVE_PREFIX),
    authorize(req, url) {
      if (!loopback.has(req.socket?.remoteAddress)) throw new BridgeError('此 Codex 接入仅允许本机连接。', 403, 'native_codex_loopback_required');
      // The server validates Host against its actual listener too (including ephemeral test ports).
      if (base.port !== '0' && !allowedHosts.has(req.headers.host)) throw new BridgeError('Host 不允许。', 403, 'native_codex_host_rejected');
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new BridgeError('此 Codex 接入只接受本机客户端。', 403, 'native_codex_origin_rejected');
      }
      const match = /^\/_bifrost\/codex\/([^/]+)(\/backend-api\/codex\/.*)$/.exec(url.pathname);
      if (!match || !keyMatches(match[1], token)) throw new BridgeError('Codex 本机接入认证失败。', 401, 'native_codex_unauthorized');
      if (!backendPath(match[2])) throw new BridgeError('未实现该 Codex 模型接口。', 404, 'native_codex_route_not_found');
      const authorization = req.headers.authorization;
      const bearer = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization)?.[1] : null;
      if (!bearer || keyMatches(bearer, gatewayKey) || keyMatches(bearer, token)) {
        throw new BridgeError('内置 Codex 接入需要当前客户端的原生授权。', 401, 'native_codex_caller_required');
      }
      if (req.rawHeaders && req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) {
        throw new BridgeError('Codex 授权头重复。', 400, 'native_codex_duplicate_authorization');
      }
      const rewritten = new URL(url.href); rewritten.pathname = match[2];
      // Only this authenticated local route can supply the bridge header internally.
      req.headers['x-account-bridge-key'] = gatewayKey;
      return rewritten;
    },
  }, { baseUrl: { get: () => `${base.origin}${pathname}`, enumerable: false } }));
}
