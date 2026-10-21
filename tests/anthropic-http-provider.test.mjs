import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AnthropicHttpProvider } from '../src/anthropic-http-provider.mjs';

const model = 'claude/claude-opus-5-5';
const catalog = () => Response.json({ data: [{ id: model, type: 'model' }] });
const body = { model, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 1 };
const request = (provider, options = {}) => provider.request({ path: '/v1/messages', body, ...options });

function fixture(options = {}) {
  const calls = [];
  const provider = new AnthropicHttpProvider({ baseUrl: 'http://127.0.0.1:3425', model,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return init.method === 'GET' ? catalog() : Response.json({ type: 'message', stop_reason: 'end_turn' });
    }, ...options });
  return { provider, calls };
}

test('upstream address is restricted to HTTPS or loopback HTTP and root or /v1', () => {
  for (const baseUrl of ['http://127.0.0.1:3425', 'http://localhost:3425/v1',
    'http://[::1]:3425/v1/', 'http://127.1:3425', 'https://gateway.example/v1']) {
    const provider = new AnthropicHttpProvider({ baseUrl, model });
    assert.match(provider.baseUrl, /\/v1$/);
  }
  for (const baseUrl of ['http://192.168.168.1:3425', 'http://example.com', 'ftp://127.0.0.1',
    'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret',
    'http://127.0.0.1/private/v1', 'http://127.0.0.1/anything', 'http://127.0.0.1/\n',
    'http://127.0.0.1/?', 'http://127.0.0.1/#']) {
    assert.throws(() => new AnthropicHttpProvider({ baseUrl, model }), TypeError);
  }
  for (const options of [{ model: '' }, { model: 'bad\nmodel' }, { loadKey: 'secret' },
    { fetchImpl: null }, { clock: null }, { cacheMs: -1 }, { cacheMode: 'untrusted' }]) {
    assert.throws(() => new AnthropicHttpProvider({ baseUrl: 'http://127.0.0.1', model, ...options }), TypeError);
  }
});

test('status only reads metadata, caches it and never treats it as account identity verification', async () => {
  let now = 100;
  const { provider, calls } = fixture({ clock: () => now, cacheMs: 30_000 });
  const first = await provider.status();
  assert.equal(first.connected, true); assert.equal(first.ready, true); assert.equal(first.modelAvailable, true);
  assert.equal(first.authenticated, null); assert.equal(first.error, null);
  assert.equal(first.transport, 'anthropic-http'); assert.equal(first.upstreamModel, model);
  first.modelAvailable = false;
  assert.equal((await provider.status()).modelAvailable, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3425/v1/models');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.redirect, 'manual');
  now += 30_000;
  await provider.status(); assert.equal(calls.length, 2);
});

test('conversation and subagent identifiers survive both user followups and tool round trips', async () => {
  const { provider, calls } = fixture();
  const headers = { 'x-claude-code-session-id': 'stable-session', 'x-claude-code-agent-id': 'subagent',
    'x-claude-code-parent-agent-id': 'parent', 'x-session-id': 'client-session', Authorization: 'Bearer private-client-key' };
  await request(provider, { headers });
  const forwarded = calls.at(-1).init.headers;
  assert.equal(forwarded.get('x-claude-code-session-id'), 'stable-session');
  assert.equal(forwarded.get('x-claude-code-agent-id'), 'subagent');
  assert.equal(forwarded.get('x-claude-code-parent-agent-id'), 'parent');
  assert.equal(forwarded.get('x-session-id'), 'client-session');
  assert.equal(forwarded.get('authorization'), null);
});

test('catalog failures and missing exact model never expose raw errors or fabricate readiness', async () => {
  const replies = [
    () => { throw new Error('Bearer private-upstream-key https://secret.example'); },
    () => Response.json({ error: { message: 'private-upstream-key' } }, { status: 401 }),
    () => new Response('private-upstream-key', { status: 200 }),
    () => Response.json({ data: [null] }),
    () => Response.json({ models: [{ id: model }] }),
    () => Response.json({ data: [{ id: 'claude-opus-5-5' }, { id: `${model}-different` }] }),
    () => Response.json({ data: [] }),
  ];
  for (const reply of replies) {
    const calls = [];
    const { provider } = fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(); } });
    const status = await provider.status();
    assert.equal(status.ready, false); assert.equal(status.modelAvailable, false); assert.equal(status.authenticated, null);
    assert.equal(JSON.stringify(status).includes('private-upstream-key'), false);
    assert.equal(JSON.stringify(status).includes('secret.example'), false);
    const response = await request(provider);
    assert.equal(response.status, 503);
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'GET');
  }
});

test('only Messages and token counting paths are forwarded and preserve the query', async () => {
  const { provider, calls } = fixture({ baseUrl: 'http://localhost:3425/v1/' });
  for (const path of ['/v1/messages?beta=true&x=a%2Fb', '/v1/messages/count_tokens?beta=true']) {
    const response = await request(provider, { path });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).url, `http://localhost:3425${path}`);
    assert.equal(calls.at(-1).init.redirect, 'manual');
    assert.equal(calls.at(-1).init.method, 'POST');
  }
  const before = calls.length;
  for (const path of ['https://evil.example/v1/messages', '//evil.example/v1/messages',
    '/v1/models', '/messages', '/v1/messages/extra', '/v1/messages#fragment',
    '/v1/../v1/messages', '/v1/messages\n', '/v1/messages?x=\rsecret']) {
    assert.equal((await request(provider, { path })).status, 404);
  }
  assert.equal(calls.length, before);
});

test('configured body model is mandatory and invalid JSON never reaches the upstream', async () => {
  const { provider, calls } = fixture();
  for (const invalid of [{ body: { ...body, model: 'another/model' } }, { body: null },
    { body: [] }, { body: Object.create({ model }) }, { rawBody: '{bad-json' },
    { rawBody: '[]' }, { rawBody: '{"messages":[]}' }, { rawBody: {} },
    { rawBody: Buffer.from([0xc0, 0xaf]) }]) {
    assert.equal((await request(provider, invalid)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('an already mapped model preserves every original request byte', async () => {
  const { provider, calls } = fixture();
  const rawBody = Buffer.from(` { "model" : "${model}", "metadata" : { "number":9007199254740993 }, "messages": [] }\n`);
  const response = await request(provider, { rawBody });
  assert.equal(response.status, 200);
  assert.strictEqual(calls.at(-1).init.body, rawBody);
});

test('model replacement preserves large integers, exponents and negative zero', async () => {
  const { provider, calls } = fixture();
  const numbers = ['9007199254740993', '-0', '1e400', '1.23000000000000000001', '1.00e-005'];
  const rawBody = `{"model":"public-alias","metadata":{"numbers":[${numbers.join(',')}]},"messages":[]}`;
  await request(provider, { rawBody: Buffer.from(rawBody) });
  assert.equal(calls.at(-1).init.body, rawBody.replace('public-alias', model));
});

test('only business headers and the independent upstream key are sent', async () => {
  let key = 'independent-upstream-key';
  const { provider, calls } = fixture({ loadKey: async () => key });
  await request(provider, { headers: new Headers({ Authorization: 'Bearer client-gateway-key',
    'X-Api-Key': 'client-api-key', Cookie: 'private=cookie', 'X-Account-Bridge-Key': 'bridge-key',
    'X-Bridge-CSRF': 'csrf-secret', 'Proxy-Authorization': 'proxy-secret',
    'X-Forwarded-For': 'client-host', Forwarded: 'for=client-host',
    'X-Magpie-Cache-Marks': 'client', 'Anthropic-Version': '2023-06-01',
    'Anthropic-Beta': 'fixture-beta', Accept: 'text/event-stream',
    'X-Client-Request-ID': 'fixture-request', 'Content-Length': '999', 'Content-Encoding': 'gzip' }) });
  const forwarded = calls.at(-1).init.headers;
  assert.equal(forwarded.get('authorization'), 'Bearer independent-upstream-key');
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer independent-upstream-key');
  for (const name of ['x-api-key', 'cookie', 'x-account-bridge-key', 'x-bridge-csrf',
    'proxy-authorization', 'x-forwarded-for', 'forwarded', 'x-magpie-cache-marks', 'content-length', 'content-encoding']) {
    assert.equal(forwarded.has(name), false);
  }
  assert.equal(forwarded.get('anthropic-version'), '2023-06-01');
  assert.equal(forwarded.get('anthropic-beta'), 'fixture-beta');
  assert.equal(forwarded.get('accept'), 'text/event-stream');
  assert.equal(forwarded.get('x-client-request-id'), 'fixture-request');
  assert.equal(forwarded.get('content-type'), 'application/json');
  key = 'rotated-upstream-key';
  await request(provider, { headers: { Connection: 'anthropic-beta', 'Anthropic-Beta': 'hop-only' } });
  assert.equal(calls.filter(call => call.init.method === 'GET').length, 2);
  assert.equal(calls.at(-1).init.headers.get('authorization'), 'Bearer rotated-upstream-key');
  assert.equal(calls.at(-1).init.headers.has('anthropic-beta'), false);
});

test('native CLI owns caching, request cache fields stay unchanged and removed cache modes fail closed', async () => {
  const rawBody = `{"model":"${model}","messages":[{"role":"user","content":[{"type":"text","text":"offline",` +
    '"cache_control":{"type":"ephemeral","ttl":"1h"}}]}]}';
  for (const options of [{}, { cacheMode: 'cli' }]) {
    const normal = fixture(options);
    await request(normal.provider, { rawBody, headers: { 'X-Magpie-Cache-Marks': 'client' } });
    assert.equal(normal.calls.at(-1).init.headers.has('authorization'), false);
    assert.equal(normal.calls.at(-1).init.headers.has('x-magpie-cache-marks'), false);
    assert.equal(normal.calls.at(-1).init.body, rawBody);
    assert.equal((await normal.provider.status()).cacheControl.behavior, 'upstream_cli_managed');
  }
  assert.throws(() => fixture({ cacheMode: 'client' }), TypeError);
});

test('key loader failures and network failures are sanitized with no automatic retry', async () => {
  for (const loadKey of [() => { throw new Error('private-secret'); }, () => 'bad\nprivate-secret', () => ({ token: 'private-secret' })]) {
    const { provider, calls } = fixture({ loadKey });
    assert.equal((await provider.status()).ready, false);
    const response = await request(provider);
    assert.ok([502, 503].includes(response.status));
    assert.equal((await response.text()).includes('private-secret'), false);
    assert.equal(calls.length, 0);
  }
  let posts = 0;
  const { provider } = fixture({ fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return catalog();
    posts++; throw new Error('https://private-secret.example Bearer private-secret');
  } });
  const response = await request(provider);
  assert.equal(response.status, 502); assert.equal(posts, 1);
  assert.equal((await response.text()).includes('private-secret'), false);
});

test('upstream redirects are never followed or returned to the client', async () => {
  for (const redirectOnGet of [true, false]) {
    const calls = [];
    const { provider } = fixture({ fetchImpl: async (_url, init) => {
      calls.push(init);
      if (init.method === 'GET' && !redirectOnGet) return catalog();
      return new Response('private-secret', { status: 307, headers: { Location: 'https://secret.example' } });
    } });
    const response = await request(provider);
    assert.equal(response.status, redirectOnGet ? 503 : 502);
    assert.equal(response.headers.has('location'), false);
    assert.equal((await response.text()).includes('private-secret'), false);
    assert.ok(calls.every(init => init.redirect === 'manual'));
    assert.equal(calls.length, redirectOnGet ? 1 : 2);
  }
});

test('responses including SSE bytes and upstream errors are returned without parsing', async () => {
  const bytes = new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe4, 0xb8, 0xad, 0x0d, 0x0a, 0x0d, 0x0a]);
  const upstream = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 7)); controller.enqueue(bytes.slice(7)); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream', 'Request-ID': 'fixture-upstream' } });
  const { provider } = fixture({ fetchImpl: async (_url, init) => init.method === 'GET' ? catalog() : upstream });
  const response = await request(provider);
  assert.strictEqual(response, upstream);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const rejected = Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture quota' } }, { status: 429 });
  const failure = fixture({ fetchImpl: async (_url, init) => init.method === 'GET' ? catalog() : rejected });
  assert.strictEqual(await request(failure.provider), rejected);
});

test('request signal reaches fetch and aborting a real local SSE stream closes it', async t => {
  let closed;
  const streamClosed = new Promise(resolve => { closed = resolve; });
  const server = http.createServer(async (incoming, outgoing) => {
    if (incoming.method === 'GET') {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ data: [{ id: model }] })); return;
    }
    for await (const _chunk of incoming) {}
    outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
    outgoing.write('data: fixture\n\n'); outgoing.once('close', closed);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const signals = [];
  const provider = new AnthropicHttpProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, model,
    fetchImpl: (url, init) => { if (init.method === 'POST') signals.push(init.signal); return fetch(url, init); } });
  const abort = new AbortController();
  const response = await request(provider, { signal: abort.signal });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: fixture\n\n');
  assert.strictEqual(signals[0], abort.signal);
  const next = reader.read();
  abort.abort(); await assert.rejects(next, error => error.name === 'AbortError');
  await Promise.race([streamClosed, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE did not close on abort')), 2000); timer.unref();
  })]);
});

test('an already cancelled request and a closed provider do not contact the upstream', async () => {
  const { provider, calls } = fixture();
  const abort = new AbortController(); abort.abort(new Error('private-secret'));
  const response = await request(provider, { signal: abort.signal });
  assert.equal(response.status, 499); assert.equal((await response.text()).includes('private-secret'), false);
  provider.close();
  assert.equal((await provider.status()).ready, false);
  assert.equal((await request(provider)).status, 503);
  assert.equal(calls.length, 0);
});
