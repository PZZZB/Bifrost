import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Gateway, SseInspector } from '../src/gateway.mjs';

const key = 'local-gateway-test-key-000000000000000000000';
const credentials = { value: 'subscription-b-test-value', accountId: 'workspace-b' };
function stream(text) {
  const bytes = Buffer.from(text);
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(index, index + 7)); index += 7;
  } });
}
async function fixture(t, fetchImpl) {
  const backend = { calls: [], async credentials(options) { this.calls.push(options); return credentials; } };
  const gateway = new Gateway({ backend, gatewayKey: key, fetchImpl,
    getAProvider: async () => ({ config: { base_url: 'https://account-a.example.invalid/backend-api/codex' } }) });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) { if (res.headersSent) res.destroy(); else { res.writeHead(error.status ?? 500); res.end(error.message); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { gateway, backend, url: `http://127.0.0.1:${server.address().port}` };
}

test('gateway replaces A auth and preserves request tools and SSE bytes exactly', async (t) => {
  const events = [
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"echo 测试"}', call_id: 'call-one' } },
    { type: 'response.completed', response: { id: 'resp-test', status: 'completed', usage: { input_tokens: 5, output_tokens: 4 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  let received;
  const { gateway, url } = await fixture(t, async (address, options) => {
    received = { address, ...options };
    return new Response(stream(events), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-test' } });
  });
  const body = JSON.stringify({ model: 'B-gpt-6.1-sol', stream: true, tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
    input: [{ type: 'function_call_output', call_id: 'existing-call', output: 'output from current PC' }] });
  const response = await fetch(`${url}/backend-api/codex/responses?test=1`, { method: 'POST', body,
    headers: { 'X-Account-Bridge-Key': key, Authorization: 'Bearer account-a-must-not-leak',
      'ChatGPT-Account-ID': 'workspace-a', Cookie: 'a_session=private', 'Content-Type': 'application/json',
      'x-client-request-id': 'client-request', 'x-codex-turn-state': 'sticky-turn-state',
      'session-id': 'session-one', 'thread-id': 'thread-one' } });
  assert.equal(response.status, 200); assert.equal(await response.text(), events);
  assert.equal(received.address, 'https://chatgpt.com/backend-api/codex/responses?test=1');
  assert.deepEqual(JSON.parse(received.body.toString()), { ...JSON.parse(body), model: 'gpt-6.1-sol' });
  assert.equal(received.headers.get('authorization'), `Bearer ${credentials.value}`);
  assert.equal(received.headers.get('chatgpt-account-id'), 'workspace-b');
  assert.equal(received.headers.get('cookie'), null);
  assert.equal(received.headers.get('x-account-bridge-key'), null);
  assert.equal(received.headers.get('x-client-request-id'), 'client-request');
  assert.equal(received.headers.get('x-codex-turn-state'), 'sticky-turn-state');
  assert.equal(received.headers.get('session-id'), 'session-one');
  assert.equal(received.headers.get('thread-id'), 'thread-one');
  assert.equal(received.redirect, 'error');
  assert.equal(gateway.metrics.completed, 1); assert.equal(gateway.metrics.failed, 0);
});

test('missing gateway key never reaches B; A bearer alone is insufficient', async (t) => {
  let upstreamCalls = 0;
  const { url } = await fixture(t, async () => { upstreamCalls++; return new Response('bad'); });
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer token-a' }, body: '{}' });
  assert.equal(response.status, 401); assert.equal(upstreamCalls, 0);
});

test('SSE without Content-Type preserves bytes and records completed inference', async (t) => {
  const usage = { input_tokens: 7, output_tokens: 3 };
  const events = [
    { type: 'response.output_text.delta', delta: '中文回复' },
    { type: 'response.completed', response: { status: 'completed', usage } },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const { gateway, url } = await fixture(t, async () => new Response(stream(events)));
  const response = await fetch(`${url}/responses`, { method: 'POST',
    headers: { Authorization: `Bearer ${key}` }, body: '{"model":"B-gpt-6.1-sol"}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(events));
  assert.equal(gateway.metrics.requests, 1);
  assert.equal(gateway.metrics.completed, 1);
  assert.equal(gateway.metrics.failed, 0);
  assert.equal(gateway.metrics.lastError, null);
  assert.deepEqual(gateway.metrics.lastUsage, usage);
});

test('401 refreshes B once and replays the identical request body', async (t) => {
  const calls = [];
  const { url, backend } = await fixture(t, async (_address, options) => {
    calls.push(options.body.toString());
    return calls.length === 1 ? new Response('expired', { status: 401 }) :
      new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{"model":"B-gpt-6.1-sol","opaque":"keep me"}' });
  await response.text();
  assert.deepEqual(calls, ['{"model":"gpt-6.1-sol","opaque":"keep me"}', '{"model":"gpt-6.1-sol","opaque":"keep me"}']);
  assert.equal(backend.calls.filter((options) => options?.force === true).length, 1);
});

test('HTTP 200 without response.completed is not counted as successful inference', async (t) => {
  const { gateway, url } = await fixture(t, async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }));
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{"model":"B-gpt-6.1-sol"}' });
  await response.text();
  assert.equal(gateway.metrics.completed, 0); assert.equal(gateway.metrics.failed, 1);
});

test('SSE parser handles split Unicode and multiline data events', () => {
  const received = [];
  const inspector = new SseInspector((event) => received.push(event));
  const bytes = Buffer.from('event: example\ndata: {"type":"example",\ndata: "text":"中文"}\n\ndata: [DONE]\n\n');
  for (const byte of bytes) inspector.push(Uint8Array.of(byte));
  assert.deepEqual(received, [{ type: 'example', text: '中文' }]);
});
