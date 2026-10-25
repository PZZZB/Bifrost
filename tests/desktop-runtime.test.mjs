import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { startDesktop } from '../src/runtime/desktop.mjs';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';

const LOCAL = 'local/codebuddy/CodeBuddy-internal-model', REMOTE = 'remote/bifrost/Claude-sonnet';
const key = `bdk_${randomBytes(32).toString('base64url')}`, remoteKey = `bfk_${randomBytes(32).toString('base64url')}`;
const identity = { version: 1, apiKey: key, secret: randomBytes(32).toString('base64url') };
function send(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, data }); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const message = model => ({ model, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] });
const nativeReply = () => new Response([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Internal reply' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, '[DONE]',
].map(data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function fixture(t, { mixed = true, pendingCatalog = false, remoteInference } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-desktop-'));
  const localCalls = [], remoteCalls = [], keyReads = [];
  let authorizationVersion = 0, available = true, localError = null, remoteAvailable = true;
  const client = { status: async () => ({ authenticated: available, identity: { uid: 'local-employee', username: 'test' } }),
    modelCatalog: async () => [{ id: 'internal-model', name: 'Internal model', supportsToolCall: true }],
    async chatCompletions(request) { localCalls.push(request); if (localError) return new Response(null, { status: localError }); return nativeReply(); } };
  const provider = new CodeBuddyProvider({ client, loadThinkingState: () => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 5) }) });
  const local = { provider, get authorizationVersion() { return authorizationVersion; },
    getModels: options => provider.getModels(options),
    async beginLogin() { authorizationVersion++; return { url: 'https://copilot.tencent.com/login' }; },
    async logout() { authorizationVersion++; available = false; return { ok: true }; }, async close() {} };
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = { version: 1, port, sources: [{ id: 'codebuddy', kind: 'codebuddy-local' },
    ...(mixed ? [{ id: 'bifrost', kind: 'bifrost-remote', baseUrl: 'https://mac.example.test/v1', protocols: ['chat-completions', 'messages'] }] : [])] };
  const fetchImpl = async (url, options) => {
    remoteCalls.push({ url, options });
    if (url.endsWith('/models')) {
      if (pendingCatalog) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (!remoteAvailable) throw new Error('Mac offline');
      return Response.json({ data: [{ id: 'Claude-sonnet' }] });
    }
    const body = JSON.parse(options.body);
    if (remoteInference) return remoteInference(url, options);
    if (url.endsWith('/messages')) return Response.json({ type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Remote reply' }], usage: { input_tokens: 4, output_tokens: 2 } });
    return Response.json({ id: 'remote-one', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Remote reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  };
  const runtime = await startDesktop({ stateDir: directory, config, identity, startLocalService: async () => local,
    loadRemoteKey: async id => { keyReads.push(id); return remoteKey; }, fetchImpl });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.router.refresh('codebuddy');
  if (mixed && !pendingCatalog) await runtime.router.refresh('bifrost');
  return { runtime, directory, localCalls, remoteCalls, keyReads, port, send: (path, options) => send(port, path, options),
    rejectLocal(status) { localError = status; }, macOffline() { remoteAvailable = false; } };
}
test('the single endpoint lists both sources and routes all existing local protocols without sending payloads to Mac', async t => {
  const f = await fixture(t);
  const catalog = await f.send('/v1/models'); assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.data.map(model => model.id), [LOCAL, REMOTE]);
  for (const [path, body] of [['/v1/messages', message(LOCAL)], ['/v1/chat/completions', { model: LOCAL, messages: message(LOCAL).messages }],
    ['/v1/responses', { model: LOCAL, input: 'hello', store: false }]]) {
    const reply = await f.send(path, { method: 'POST', body, headers: { 'x-forwarded-host': 'attacker.test', 'x-upstream-url': 'https://attacker.test' } });
    assert.equal(reply.status, 200, reply.text); assert.equal(reply.data.model, LOCAL); assert.equal(reply.headers['x-bifrost-source'], 'codebuddy');
    assert.equal(reply.headers['x-bifrost-billing-authority'], 'company');
  }
  assert.equal(f.localCalls.length, 3); assert.ok(f.localCalls.every(call => call.body.model === 'internal-model'));
  assert.equal(f.remoteCalls.filter(call => call.options.method === 'POST').length, 0);
});
test('remote calls use the registered native ID and personal Mac Key exactly once; no local billing database appears', async t => {
  const f = await fixture(t);
  const reply = await f.send('/v1/chat/completions', { method: 'POST', body: { model: REMOTE, messages: message(REMOTE).messages },
    headers: { 'x-session-id': 'personal-chat', cookie: 'company-cookie=secret', 'x-bifrost-client-scope': 'fake-scope' } });
  assert.equal(reply.status, 200); assert.equal(reply.data.model, REMOTE);
  const calls = f.remoteCalls.filter(call => call.options.method === 'POST'); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mac.example.test/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${remoteKey}`); assert.equal(calls[0].options.headers.cookie, undefined);
  assert.notEqual(calls[0].options.headers['x-session-id'], 'personal-chat');
  assert.equal(JSON.parse(calls[0].options.body).model, 'Claude-sonnet'); assert.equal(f.localCalls.length, 0);
  assert.deepEqual(await readdir(f.directory), []);
  const unsupported = await f.send('/v1/responses', { method: 'POST', body: { model: REMOTE, input: 'hello' } });
  assert.equal(unsupported.status, 501); assert.equal(f.remoteCalls.filter(call => call.options.method === 'POST').length, 1);
});
test('local-only never reads any remote Key or contacts Mac, and a stalled remote catalog cannot delay a local call', async t => {
  const local = await fixture(t, { mixed: false });
  assert.deepEqual(local.keyReads, []); assert.deepEqual(local.remoteCalls, []);
  assert.equal((await local.send('/v1/messages', { method: 'POST', body: message(LOCAL) })).status, 200);
  const mixed = await fixture(t, { pendingCatalog: true });
  const result = await Promise.race([mixed.send('/v1/messages', { method: 'POST', body: message(LOCAL) }),
    new Promise((_resolve, reject) => { const timeout = setTimeout(() => reject(new Error('local waited for remote')), 1000); timeout.unref(); })]);
  assert.equal(result.status, 200); assert.deepEqual((await mixed.send('/v1/models')).data.data.map(model => model.id), [LOCAL]);
});
test('Mac outage and local 401/403/429/timeout-class failures never reroute inference', async t => {
  const f = await fixture(t); f.macOffline(); await f.runtime.router.refresh('bifrost');
  assert.deepEqual((await f.send('/v1/models')).data.data.map(model => model.id), [LOCAL]);
  for (const status of [401, 403, 429, 504]) {
    f.rejectLocal(status);
    const reply = await f.send('/v1/messages', { method: 'POST', body: message(LOCAL) }); assert.equal(reply.status, status);
  }
  assert.equal(f.remoteCalls.filter(call => call.options.method === 'POST').length, 0);
});
test('loopback API rejects foreign hosts, browser Origins, unknown proxies/admin paths, remote Keys and source changes in a session', async t => {
  const f = await fixture(t);
  for (const headers of [{ host: 'attacker.test' }, { origin: `http://127.0.0.1:${f.port}` }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.send('/v1/models', { headers })).status, 403);
  }
  assert.equal((await f.send('/v1/models', { headers: { authorization: `Bearer ${remoteKey}` } })).status, 401);
  for (const path of ['/api/accounts', '/account/', '/portal/api/keys', '/v1/models?target=https://attacker.test', '//attacker.test/v1/models']) {
    assert.equal((await f.send(path)).status, 404);
  }
  const headers = { 'x-session-id': 'same-chat' };
  assert.equal((await f.send('/v1/messages', { method: 'POST', headers, body: message(LOCAL) })).status, 200);
  const changed = await f.send('/v1/messages', { method: 'POST', headers, body: message(REMOTE) });
  assert.equal(changed.status, 409); assert.equal(f.remoteCalls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(f.runtime.server.address().address, '127.0.0.1');
});

test('a disconnected HTTP client aborts remote inference and releases its slot without dispatching another source', async t => {
  let started, finished;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const abortedPromise = new Promise(resolve => { finished = resolve; });
  const f = await fixture(t, { remoteInference: async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { finished(); reject(new Error('client left')); }, { once: true }));
  } });
  const request = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  request.on('error', () => {}); request.end(JSON.stringify({ model: REMOTE, messages: message(REMOTE).messages }));
  await startedPromise; request.destroy();
  await Promise.race([abortedPromise, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('abort did not propagate')), 1000); timer.unref(); })]);
  assert.equal(f.remoteCalls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(f.localCalls.length, 0);
});
