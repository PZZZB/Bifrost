import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { Gateway } from '../src/gateway.mjs';

const key = 'usage-gateway-key';
const headers = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer token-a', 'ChatGPT-Account-ID': 'workspace-a' };
const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25,
  input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 2 } };
async function fixture(t, fetchImpl, onUsage) {
  const records = [];
  const gateway = new Gateway({ gatewayKey: key, fetchImpl,
    backend: { credentials: async () => ({ value: 'token-b', accountId: 'workspace-b' }) },
    getAProvider: async () => ({ config: { base_url: 'https://account-a.example.invalid/codex' } }),
    onUsage: onUsage ?? (async record => { records.push(record); }) });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://bridge.invalid')); }
    catch (error) { if (res.headersSent) res.destroy(); else { res.writeHead(error.status ?? 500); res.end(error.message); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { gateway, records, url: `http://127.0.0.1:${server.address().port}` };
}
const event = (type, response) => `data: ${JSON.stringify({ type, response })}\n\n`;

test('a completed SSE request reports usage once, even if the terminal event is duplicated', async t => {
  const bytes = event('response.completed', { id: 'resp-one', status: 'completed', usage }).repeat(2);
  const { url, records } = await fixture(t, async () => new Response(bytes));
  const response = await fetch(`${url}/responses`, { method: 'POST', headers,
    body: '{"model":"B-gpt-6.1-sol","input":"not-recorded"}' });
  assert.equal(await response.text(), bytes);
  assert.equal(records.length, 1);
  assert.equal(records[0].account, 'B');
  assert.equal(records[0].model, 'B-gpt-6.1-sol');
  assert.equal(records[0].upstreamModel, 'gpt-6.1-sol');
  assert.equal(records[0].status, 'completed');
  assert.equal(records[0].responseId, 'resp-one');
  assert.deepEqual(records[0].usage, usage);
  assert.ok(!JSON.stringify(records[0]).includes('not-recorded'));
  assert.ok(!JSON.stringify(records[0]).includes('token-a'));
  assert.ok(!JSON.stringify(records[0]).includes('token-b'));
});

test('failed and incomplete streams keep authoritative usage instead of estimating a completed result', async t => {
  const bytes = event('response.failed', { id: 'resp-failed', status: 'failed', usage, error: { message: 'failed' } });
  const { url, records } = await fixture(t, async () => new Response(bytes));
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: '{"model":"gpt-6.1-sol"}' })).text();
  assert.equal(records[0].account, 'A'); assert.equal(records[0].status, 'failed');
  assert.deepEqual(records[0].usage, usage);
});

test('missing terminal usage remains null', async t => {
  const { url, records } = await fixture(t, async () => new Response(event('response.completed', { status: 'completed' })));
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: '{"model":"B-gpt-6-astra"}' })).text();
  assert.equal(records.length, 1); assert.equal(records[0].usage, null);
});

test('JSON compaction and non-stream responses report their returned usage', async t => {
  const data = { id: 'json-one', status: 'completed', usage, output: [] };
  const { url, records } = await fixture(t, async () => Response.json(data));
  for (const path of ['/responses/compact', '/responses']) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol"}' });
    assert.deepEqual(await response.json(), data);
  }
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.status === 'completed' && record.usage.total_tokens === 25));
});

test('a token recorder failure cannot change a successful model response', async t => {
  const bytes = event('response.completed', { status: 'completed', usage });
  const { url, gateway } = await fixture(t, async () => new Response(bytes), async () => { throw new Error('disk unavailable'); });
  const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol"}' });
  assert.equal(response.status, 200); assert.equal(await response.text(), bytes);
  assert.equal(gateway.metrics.completed, 1); assert.equal(gateway.metrics.failed, 0);
  assert.equal(gateway.metrics.usageError, 'disk unavailable');
});

test('native web-search requests use the same A/B model and credential routing without requiring SSE', async t => {
  const sent = [];
  const result = { search_results: [] };
  const { url, gateway, records } = await fixture(t, async (address, options) => {
    sent.push({ address, ...options }); return Response.json(result);
  });
  const aBody = '{ "model":"gpt-6-astra", "queries":["official docs"] }';
  assert.deepEqual(await (await fetch(`${url}/backend-api/codex/alpha/search`, { method: 'POST', headers, body: aBody })).json(), result);
  assert.deepEqual(await (await fetch(`${url}/v1/alpha/search`, { method: 'POST', headers,
    body: '{"model":"B-gpt-6.1-sol","queries":["official docs"]}' })).json(), result);
  assert.equal(sent[0].address, 'https://account-a.example.invalid/codex/alpha/search');
  assert.equal(sent[0].headers.get('authorization'), 'Bearer token-a');
  assert.equal(sent[0].body.toString(), aBody);
  assert.equal(sent[1].address, 'https://chatgpt.com/backend-api/codex/alpha/search');
  assert.equal(sent[1].headers.get('authorization'), 'Bearer token-b');
  assert.equal(JSON.parse(sent[1].body).model, 'gpt-6.1-sol');
  assert.equal(gateway.metrics.failed, 0); assert.equal(records.length, 0);
});

test('complete JSON usage survives downstream failure after receiving the full chunk', async () => {
  const records = [];
  const gateway = new Gateway({ gatewayKey: key,
    backend: { credentials: async () => ({ value: 'token-b', accountId: 'workspace-b' }) },
    getAProvider: async () => ({ config: { base_url: 'https://account-a.example.invalid/codex' } }),
    fetchImpl: async () => Response.json({ id: 'json-before-disconnect', status: 'completed', usage }),
    onUsage: async record => { records.push(record); } });
  const req = { method: 'POST', headers: Object.fromEntries(Object.entries(headers).map(([name,value]) => [name.toLowerCase(),value])),
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"model":"B-gpt-6.1-sol"}'); } };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = () => {};
  res.write = () => { throw new Error('downstream closed'); };
  await assert.rejects(gateway.proxy(req, res, new URL('http://bridge.invalid/responses')), /downstream closed/);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].usage, usage);
  assert.equal(records[0].responseId, 'json-before-disconnect');
  assert.equal(records[0].status, 'failed');
});
