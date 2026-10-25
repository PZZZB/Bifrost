import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readBody } from './gateway.mjs';

const ROUTES = new Map([['/v1/models', 'GET'], ['/v1/chat/completions', 'POST'],
  ['/v1/messages', 'POST'], ['/v1/messages/count_tokens', 'POST']]);
const SESSION_HEADERS = ['x-session-id', 'x-claude-code-session-id', 'x-conversation-id',
  'x-session-affinity', 'session_id', 'session-id', 'x-opencode-session'];
const FORWARDED_HEADERS = ['accept', 'content-type', 'anthropic-version', 'anthropic-beta'];
const sha256 = value => createHash('sha256').update(value).digest();
const key = value => typeof value === 'string' && /^[\x21-\x7e]{40,4096}$/.test(value);
const fail = status => { throw Object.assign(new Error(), { status }); };

/** Explicit HTTP authorities for ingress processes which preserve the public Host.
 * These names never select a network destination; the upstream remains loopback. */
export function validateExternalAuthorities(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('Invalid external authorities.');
  const seen = new Set();
  return value.map(authority => {
    const match = typeof authority === 'string' && authority.length <= 259 &&
      /^([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(authority);
    const labels = match ? match[1].split('.') : [];
    if (!match || match[1].length > 253 || labels.length < 2 ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !/[a-z]/.test(labels.at(-1)) || match[2] && Number(match[2]) > 65535 || seen.has(authority)) {
      throw new TypeError('Invalid external authorities.');
    }
    seen.add(authority);
    return authority;
  });
}

export function validateExternalClients(clients) {
  if (!Array.isArray(clients) || clients.length > 100) throw new TypeError('Invalid external clients.');
  const ids = new Set(), hashes = new Set();
  return clients.map(client => {
    if (!client || typeof client.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(client.id) || ids.has(client.id) ||
        typeof client.keySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(client.keySha256) || hashes.has(client.keySha256) ||
        !Number.isInteger(client.maxConcurrent) || client.maxConcurrent < 1 || client.maxConcurrent > 8 ||
        !Number.isInteger(client.requestsPerMinute) || client.requestsPerMinute < 1 || client.requestsPerMinute > 600) {
      throw new TypeError('Invalid external clients.');
    }
    ids.add(client.id); hashes.add(client.keySha256);
    return { id: client.id, keySha256: client.keySha256,
      maxConcurrent: client.maxConcurrent, requestsPerMinute: client.requestsPerMinute };
  });
}

function errorResponse(res, status) {
  const message = ({ 400: 'Invalid request.', 401: 'Invalid external API key.', 403: 'Access denied.',
    404: 'Endpoint not available.', 405: 'Method not allowed.', 413: 'Request body too large.',
    415: 'Compressed requests are not supported.', 429: 'Request limit reached.',
    502: 'Gateway response unavailable.', 503: 'Gateway temporarily unavailable.' })[status] ?? 'Request failed.';
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(status === 429 ? { 'retry-after': '60' } : {}), connection: 'close' });
  res.end(JSON.stringify({ error: { type: status === 401 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error' : 'api_error', message } }));
}

/** HTTPS is terminated at the public ingress. This process accepts only a fixed
 * loopback tunnel endpoint, keeps the local gateway key private, and namespaces
 * all remote sessions by the authenticated client rather than caller headers. */
export function createExternalClaudeGateway({ gatewayKey, sessionKey, getClients,
  allowedHosts, upstreamPort = 43157, maxConcurrent = 4, maxBodyBytes = 16 * 1024 * 1024,
  headerTimeoutMs = 20_000, requestTimeoutMs = 10 * 60_000, fetchImpl = fetch, clock = Date.now,
  accountApi = null, webAccounts = null, clientGateway = null } = {}) {
  if (!key(gatewayKey) || !key(sessionKey) || gatewayKey === sessionKey || typeof getClients !== 'function' ||
      !Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.some(host => typeof host !== 'string' || !host) ||
      !Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32 ||
      !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024) {
    throw new TypeError('Invalid external gateway configuration.');
  }
  const hosts = new Set(allowedHosts.map(host => host.toLowerCase()));
  const states = new Map(); let active = 0;
  const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => { void (async () => {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    req.once('aborted', disconnect); res.once('close', disconnect);
    let state, reserved = false, reader, headerTimer, requestTimer;
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403);
      const counts = new Map();
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index].toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if (counts.get('host') !== 1 || !hosts.has(req.headers.host?.toLowerCase())) fail(403);
      if (['authorization', 'x-api-key', 'cookie', 'origin', 'x-bifrost-csrf', ...SESSION_HEADERS].some(name => (counts.get(name) ?? 0) > 1)) fail(400);
      if (clientGateway?.handles(req.url)) { await clientGateway.handle(req, res, abort.signal); return; }
      if (webAccounts?.handles(req.url)) {
        await webAccounts.handle(req, res); return;
      }
      if (req.headers.origin !== undefined) fail(403);
      if (accountApi && req.url.startsWith('/account/v1/')) {
        await accountApi.handle(req, res); return;
      }
      const supplied = [];
      if (req.headers.authorization !== undefined) supplied.push(/^Bearer (\S+)$/i.exec(req.headers.authorization)?.[1]);
      if (req.headers['x-api-key'] !== undefined) supplied.push(req.headers['x-api-key']);
      if (!supplied.length || supplied.some(value => !key(value))) fail(401);
      const clients = validateExternalClients(await getClients());
      if (clients.some(client => client.keySha256 === sha256(gatewayKey).toString('hex') ||
          client.keySha256 === sha256(sessionKey).toString('hex'))) fail(503);
      const hashes = supplied.map(sha256);
      const client = clients.find(candidate => hashes.every(hash => timingSafeEqual(hash, Buffer.from(candidate.keySha256, 'hex'))));
      if (!client && clientGateway && supplied.every(value => /^bfk_[A-Za-z0-9_-]{43}$/.test(value) && value === supplied[0])) {
        if (active >= maxConcurrent) fail(429);
        active++; state = { active: 1 }; reserved = true;
        await clientGateway.handle(req, res, abort.signal); return;
      }
      if (!client) fail(401);
      if (!ROUTES.has(req.url)) fail(404);
      if (ROUTES.get(req.url) !== req.method) fail(405);
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415);
      if (req.method === 'GET' && (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)) fail(400);
      if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) fail(413);
      const session = SESSION_HEADERS.map(name => req.headers[name]).find(Boolean) ?? '';
      if (typeof session !== 'string' || session.length > 1024) fail(400);
      for (const [id, value] of states) if (!value.active && !clients.some(client => client.id === id)) states.delete(id);
      state = states.get(client.id);
      if (!state) { state = { active: 0, requests: 0, resetAt: clock() + 60_000 }; states.set(client.id, state); }
      if (clock() >= state.resetAt) { state.requests = 0; state.resetAt = clock() + 60_000; }
      if (active >= maxConcurrent || state.active >= client.maxConcurrent || state.requests >= client.requestsPerMinute) fail(429);
      active++; state.active++; state.requests++; reserved = true;
      requestTimer = setTimeout(() => abort.abort(), requestTimeoutMs); requestTimer.unref();
      const body = req.method === 'POST' ? await readBody(req, maxBodyBytes) : undefined;
      abort.signal.throwIfAborted();
      const headers = new Headers({ authorization: `Bearer ${gatewayKey}` });
      for (const name of FORWARDED_HEADERS) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      headers.set('x-session-id', 'external-' + createHmac('sha256', sessionKey).update(JSON.stringify([client.id, session])).digest('hex'));
      headerTimer = setTimeout(() => abort.abort(), headerTimeoutMs); headerTimer.unref();
      const response = await fetchImpl(`http://127.0.0.1:${upstreamPort}${req.url}`, {
        method: req.method, headers, body, signal: abort.signal, redirect: 'manual',
      });
      clearTimeout(headerTimer);
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail(502); }
      const output = { 'content-type': response.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store', 'x-accel-buffering': 'no' };
      if (response.headers.has('retry-after')) output['retry-after'] = response.headers.get('retry-after');
      res.writeHead(response.status, output); res.flushHeaders();
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          abort.signal.throwIfAborted();
          if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
        }
      }
      res.end();
    } catch (error) {
      abort.abort();
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else errorResponse(res, [400, 401, 403, 404, 405, 413, 415, 429, 502].includes(error.status) ? error.status : 503);
    } finally {
      clearTimeout(headerTimer); clearTimeout(requestTimer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (reserved) { active--; state.active--; }
      req.removeListener('aborted', disconnect); res.removeListener('close', disconnect);
    }
  })(); });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  server.maxHeadersCount = 40; server.maxConnections = 64; server.keepAliveTimeout = 5_000;
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
