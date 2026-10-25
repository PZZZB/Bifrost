import http from 'node:http';
import { once } from 'node:events';
import { AnthropicGateway } from './anthropic-gateway.mjs';
import { readBody } from './gateway.mjs';

const ROUTES = new Map([['/health', 'GET'], ['/v1/models', 'GET'], ['/v1/messages', 'POST'],
  ['/v1/messages/count_tokens', 'POST'], ['/v1/chat/completions', 'POST']]);
const HEADERS = new Set(['accept', 'content-type', 'anthropic-version', 'anthropic-beta',
  'x-session-id', 'x-conversation-id', 'session_id', 'session-id', 'x-claude-code-session-id',
  'x-claude-code-agent-id', 'x-claude-code-parent-agent-id', 'x-session-affinity', 'x-opencode-session']);
const errorJson = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type: status === 401 ? 'authentication_error' : 'api_error', message } }));
};

/** Local client key and VM relay key are independent. No client credentials,
 * redirects, alternative providers, or public network destinations are forwarded. */
export function createClaudeVmGateway({ gatewayKey, relayKey, upstreamPort, allowedHosts,
  maxBodyBytes = 64 * 1024 * 1024, fetchImpl = fetch, headerTimeoutMs = 20_000 } = {}) {
  if (typeof relayKey !== 'string' || !/^[\x21-\x7e]{40,4096}$/.test(relayKey) ||
      !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new TypeError('Invalid private VM gateway configuration.');
  const auth = new AnthropicGateway({ gatewayKey, allowedHosts, allowedPeers: ['127.0.0.1'], maxBodyBytes });
  return http.createServer((req, res) => { void (async () => {
    const abort = new AbortController();
    const cancel = () => { if (!res.writableEnded) abort.abort(new Error('Client disconnected.')); };
    req.once('aborted', cancel); res.once('close', cancel);
    let reader, timer;
    try {
      auth.authorize(req);
      if (!ROUTES.has(req.url)) { errorJson(res, 404, 'This endpoint is not provided.'); return; }
      if (req.method !== ROUTES.get(req.url)) { errorJson(res, 405, 'Invalid HTTP method.'); return; }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { errorJson(res, 415, 'Compressed requests are not supported.'); return; }
      const headers = new Headers({ authorization: `Bearer ${relayKey}` });
      for (const [name, value] of Object.entries(req.headers)) if (HEADERS.has(name) && typeof value === 'string') headers.set(name, value);
      const body = req.method === 'POST' ? await readBody(req, maxBodyBytes) : undefined;
      timer = setTimeout(() => abort.abort(new Error('VM relay connection timed out.')), headerTimeoutMs); timer.unref();
      const upstream = await fetchImpl(`http://127.0.0.1:${upstreamPort}${req.url}`, {
        method: req.method, headers, body, redirect: 'manual', signal: abort.signal,
      });
      clearTimeout(timer);
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); errorJson(res, 502, 'VM relay redirects are not permitted.'); return; }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      if (upstream.body) {
        reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          abort.signal.throwIfAborted();
          if (!res.write(value)) await once(res, 'drain', { signal: abort.signal });
        }
      }
      res.end();
    } catch (error) {
      if (!abort.signal.aborted) abort.abort();
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else errorJson(res, Number.isInteger(error.status) ? error.status : 503,
        error.status === 401 ? 'Invalid Bifrost gateway key.' : 'The VM relay is unavailable. Start the Claude virtual machine and check its relay service.');
    } finally {
      clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      req.removeListener('aborted', cancel); res.removeListener('close', cancel);
    }
  })(); });
}
