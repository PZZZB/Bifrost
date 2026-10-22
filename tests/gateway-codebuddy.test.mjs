import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { Gateway } from '../src/gateway.mjs';
import { CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';

const model = CODEBUDDY_MODEL.id;
const key = 'local-codebuddy-test-key-000000000000000000';
const threadId = 'e18d8b94-1b07-4c87-891d-38f8cc3c5d71';
const headers = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer private-account-a',
  'ChatGPT-Account-ID': 'private-workspace-a', Cookie: 'a-cookie=private; bridge_session=private',
  'Content-Type': 'application/json', 'thread-id': threadId };
const ready = { authenticated: true, ready: true, modelAvailable: true };
const aCatalog = { etag: 'native-a-metadata', models: [{ slug: 'a-model', priority: 1, native: { preserved: true } }] };
const bCatalog = { models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-6.1-sol' }] };
const terminal = response => `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;

async function fixture(t, { provider, enabled, fetchImpl, onUsage, catalogWaitMs = 50 } = {}) {
  const calls = { a: 0, b: 0, upstream: [], adapter: [] }, records = [];
  provider ??= {
    status: async () => ready,
    request: async options => {
      calls.adapter.push(options);
      return Response.json({ id: 'cb-response', status: 'completed', usage: { input_tokens: 6, output_tokens: 2 } });
    },
  };
  const gateway = new Gateway({ gatewayKey: key, catalogWaitMs,
    backend: { credentials: async () => { calls.b++; return { value: 'private-b', accountId: 'workspace-b' }; } },
    getAProvider: async () => { calls.a++; return { config: { base_url: 'https://a.invalid/codex' } }; },
    codeBuddyProvider: provider, ...(enabled === undefined ? {} : { codeBuddyEnabled: enabled }),
    fetchImpl: fetchImpl ?? (async (url, options) => {
      calls.upstream.push({ url, options });
      return Response.json(url.startsWith('https://a.invalid/') ? aCatalog : bCatalog);
    }),
    onUsage: onUsage ?? (async record => { records.push(record); }) });
  const pending = new Set();
  const server = http.createServer((req, res) => {
    const task = gateway.proxy(req, res, new URL(req.url, 'http://bridge.invalid')).catch(error => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: error.code, message: error.message } })); }
    });
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await Promise.allSettled(pending); });
  return { gateway, calls, records, settle: () => Promise.all([...pending]), url: `http://127.0.0.1:${server.address().port}` };
}

test('CodeBuddy route isolates credentials, keeps full tool history and records its own account', async t => {
  const { url, gateway, calls, records, settle } = await fixture(t);
  const body = { model, input: [{ type: 'function_call', name: 'exec_command', call_id: 'prior-call', arguments: '{"cmd":"read"}' },
    { type: 'function_call_output', call_id: 'prior-call', output: 'local result' }], tools: [{ type: 'function', name: 'exec_command' }] };
  const response = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200); await response.text(); await settle();
  assert.equal(calls.a, 0); assert.equal(calls.b, 0); assert.equal(calls.upstream.length, 0);
  assert.equal(calls.adapter.length, 1);
  assert.deepEqual(JSON.parse(calls.adapter[0].body), body);
  assert.deepEqual([...calls.adapter[0].headers.entries()], [['accept', '*/*'], ['content-type', 'application/json']]);
  assert.equal(records.length, 1); assert.equal(records[0].account, 'CodeBuddy');
  assert.equal(records[0].model, model); assert.equal(records[0].status, 'completed');
  assert.equal(gateway.metrics.accounts.A.requests, 0); assert.equal(gateway.metrics.accounts.B.requests, 0);
  assert.equal(gateway.traffic(threadId).accounts.CodeBuddy.completed, 1);
  assert.equal(gateway.metrics.active, 0); assert.equal(gateway.codeBuddyStatus().active, 0);
});

test('compressed CodeBuddy requests are decoded without forwarding compression or native authorization', async t => {
  const { url, calls } = await fixture(t);
  const body = { model, input: 'test', stream: true };
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip', Accept: 'text/event-stream' },
    body: gzipSync(Buffer.from(JSON.stringify(body))) });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(JSON.parse(calls.adapter[0].body), body);
  assert.deepEqual([...calls.adapter[0].headers.entries()], [['accept', 'text/event-stream'], ['content-type', 'application/json']]);
});

test('missing gateway key blocks CodeBuddy before the adapter and all account credentials', async t => {
  const { url, calls, gateway } = await fixture(t);
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: { Authorization: 'Bearer private-account-a' }, body: JSON.stringify({ model }) });
  assert.equal(response.status, 401); await response.text();
  assert.equal(calls.a + calls.b + calls.adapter.length, 0); assert.equal(gateway.metrics.requests, 0);
});

test('disabled CodeBuddy and unknown CodeBuddy aliases fail without falling back to A or B', async t => {
  const { url, calls, records, gateway, settle } = await fixture(t, { enabled: () => false });
  for (const [requested, status] of [[model, 503], ['claude-codebuddy-other', 400], ['CodeBuddy/opus', 400]]) {
    const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: requested }) });
    assert.equal(response.status, status); await response.text();
  }
  await settle();
  assert.equal(calls.a + calls.b + calls.adapter.length + calls.upstream.length, 0);
  assert.equal(records.length, 1); assert.equal(records[0].account, 'CodeBuddy'); assert.equal(records[0].usage, null);
  assert.equal(gateway.metrics.active, 0); assert.equal(gateway.metrics.failed, 3);
});

test('enabled callback permits CodeBuddy after login without changing the gateway or A/B provider', async t => {
  let enabled = false;
  const { url, calls } = await fixture(t, { enabled: () => enabled });
  let response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) });
  assert.equal(response.status, 503); await response.text(); enabled = true;
  response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) });
  assert.equal(response.status, 200); await response.text(); assert.equal(calls.adapter.length, 1);
});

test('catalog preserves A/B order and metadata, appending the ready CodeBuddy row last', async t => {
  const { url, calls } = await fixture(t);
  const response = await fetch(`${url}/models?client_version=test`, { headers });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.models[0], aCatalog.models[0]); assert.equal(result.etag, aCatalog.etag);
  assert.deepEqual(result.models.map(row => row.slug), ['a-model', 'B-gpt-6-astra', 'B-gpt-6.1-sol', model]);
  assert.equal(calls.adapter.length, 0);
});

test('CodeBuddy directory failure keeps the A/B catalog and never makes an inference request', async t => {
  for (const metadata of [null, { ...ready, authenticated: false }, { ...ready, modelAvailable: false }]) {
    let inferenceCalls = 0;
    const { url } = await fixture(t, { provider: { status: async () => metadata, request: async () => { inferenceCalls++; } } });
    const result = await (await fetch(`${url}/models`, { headers })).json();
    assert.deepEqual(result.models.map(row => row.slug), ['a-model', 'B-gpt-6-astra', 'B-gpt-6.1-sol']);
    assert.equal(inferenceCalls, 0);
  }
});

test('a slow optional CodeBuddy catalog stays within its deadline', async t => {
  const { url } = await fixture(t, { catalogWaitMs: 15,
    provider: { status: () => new Promise(() => {}), request: async () => { throw new Error('unexpected'); } } });
  const result = await (await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(2000) })).json();
  assert.equal(result.models.some(row => row.slug === model), false);
});

test('B catalog failure still permits A and ready CodeBuddy in the same catalog', async t => {
  const { url } = await fixture(t, { fetchImpl: async address => {
    if (address.startsWith('https://a.invalid/')) return Response.json(aCatalog);
    throw new Error('B offline');
  } });
  const result = await (await fetch(`${url}/models`, { headers })).json();
  assert.deepEqual(result.models.map(row => row.slug), ['a-model', model]);
});

test('reserved CodeBuddy catalog collision is reported instead of returning an ambiguously routed model', async t => {
  const { url } = await fixture(t, { fetchImpl: async address => Response.json(address.startsWith('https://a.invalid/')
    ? { models: [{ slug: model, display_name: 'unrelated model' }] } : bCatalog) });
  const response = await fetch(`${url}/models`, { headers });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'model_alias_conflict');
});

test('CodeBuddy encrypted continuation cannot leak to either native account', async t => {
  const { url, calls, records, settle } = await fixture(t);
  for (const requested of ['a-model', 'B-gpt-6.1-sol']) {
    const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: requested,
      input: [{ type: 'reasoning', encrypted_content: CODEBUDDY_RESPONSES_STATE_PREFIX + 'opaque-test' }] }) });
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'codebuddy_history_channel_mismatch');
  }
  await settle(); assert.equal(calls.a + calls.b + calls.upstream.length + calls.adapter.length, 0);
  assert.ok(records.every(record => record.usage === null && record.status === 'failed'));
});

test('real CodeBuddy usage overrides SSE placeholders and preserves the actual upstream model', async t => {
  const reported = { input_tokens: 17, output_tokens: 9, total_tokens: 26, input_tokens_details: { cached_tokens: 5 } };
  const { url, gateway, records, settle } = await fixture(t, { provider: { status: async () => ready, request: async () => {
    const response = new Response(terminal({ id: 'resp_cb', status: 'completed', usage: { input_tokens: 0, output_tokens: 0 } }),
      { headers: { 'content-type': 'text/event-stream' } });
    response.bridgeUsage = Promise.resolve(reported); response.bridgeModel = 'claude-opus-5.5'; return response;
  } } });
  const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) });
  await response.text(); await settle();
  assert.equal(records.length, 1); assert.deepEqual(records[0].usage, reported);
  assert.equal(records[0].upstreamModel, 'claude-opus-5.5'); assert.equal(records[0].responseId, 'resp_cb');
  assert.deepEqual(gateway.metrics.lastUsage, reported);
});

test('unknown authoritative usage remains unknown for JSON, even if wire protocol contains zeroes', async t => {
  const { url, gateway, records, settle } = await fixture(t, { provider: { status: async () => ready, request: async () => {
    const response = Response.json({ id: 'resp_unknown', status: 'completed', usage: { input_tokens: 0, output_tokens: 0 } });
    response.bridgeUsage = Promise.resolve(null); return response;
  } } });
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) })).text(); await settle();
  assert.equal(records[0].usage, null); assert.equal(gateway.metrics.lastUsage, null);
});

test('CodeBuddy error details reach its scoped status and clear after recovery', async t => {
  let rejected = true;
  const { url, gateway, settle } = await fixture(t, { provider: { status: async () => ready, request: async () => rejected
    ? Response.json({ error: { message: 'Unsupported attachment format' } }, { status: 400 })
    : Response.json({ status: 'completed' }) } });
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) })).text(); await settle();
  assert.equal(gateway.codeBuddyStatus().lastError, 'Unsupported attachment format');
  assert.equal(gateway.metrics.accounts.A.lastError, null); rejected = false;
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) })).text(); await settle();
  assert.equal(gateway.codeBuddyStatus().lastError, null); assert.equal(gateway.codeBuddyStatus().completed, 1);
});

test('a downstream failure after response.completed retains tokens but records a failed request consistently', async () => {
  const records = [], usage = { input_tokens: 5, output_tokens: 1 };
  const gateway = new Gateway({ gatewayKey: key, backend: {}, getAProvider: async () => { throw new Error('A must not be read'); },
    codeBuddyProvider: { status: async () => ready, request: async () => {
      const response = new Response(terminal({ id: 'completed-upstream', status: 'completed', usage }));
      response.bridgeUsage = Promise.resolve(usage); return response;
    } }, onUsage: async record => { records.push(record); } });
  const req = { method: 'POST', headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ model })); } };
  const res = new EventEmitter(); res.writableEnded = false; res.writeHead = () => {};
  res.write = () => { throw new Error('downstream closed'); };
  await assert.rejects(gateway.proxy(req, res, new URL('http://bridge.invalid/responses')), /downstream closed/);
  assert.equal(records[0].status, 'failed'); assert.deepEqual(records[0].usage, usage);
  assert.equal(gateway.metrics.completed, 0); assert.equal(gateway.metrics.failed, 1); assert.equal(gateway.metrics.active, 0);
  assert.equal(gateway.codeBuddyStatus().failed, 1); assert.equal(gateway.traffic(threadId).accounts.CodeBuddy.active, 0);
});

test('client cancellation aborts the adapter and releases active counters', async t => {
  let upstreamSignal, cancelUsage;
  const usageDone = new Promise(resolve => { cancelUsage = resolve; });
  const { url, gateway, records, settle } = await fixture(t, { provider: { status: async () => ready, request: async ({ signal }) => {
    upstreamSignal = signal;
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.created"}\n\n'));
      signal.addEventListener('abort', () => { cancelUsage(null); controller.error(signal.reason); }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
    response.bridgeUsage = usageDone; return response;
  } } });
  const controller = new AbortController();
  const response = await fetch(`${url}/responses`, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ model }) });
  const reader = response.body.getReader(); await reader.read();
  assert.equal(gateway.codeBuddyStatus().active, 1); controller.abort();
  await assert.rejects(reader.read());
  await new Promise(resolve => upstreamSignal.aborted ? resolve() : upstreamSignal.addEventListener('abort', resolve, { once: true }));
  await settle(); assert.equal(upstreamSignal.aborted, true);
  assert.equal(gateway.metrics.active, 0); assert.equal(gateway.codeBuddyStatus().active, 0);
  assert.equal(records[0].status, 'interrupted'); assert.equal(records[0].usage, null);
});

test('active requests include the final token-ledger write so an idle check cannot race persistence', async t => {
  let release;
  const persisted = new Promise(resolve => { release = resolve; });
  const { url, gateway, settle } = await fixture(t, { onUsage: () => persisted });
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) })).text();
  assert.equal(gateway.metrics.active, 1); assert.equal(gateway.codeBuddyStatus().active, 1);
  release(); await settle();
  assert.equal(gateway.metrics.active, 0); assert.equal(gateway.codeBuddyStatus().active, 0);
});
