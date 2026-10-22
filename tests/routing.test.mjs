import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Gateway } from '../src/gateway.mjs';
import { zstdCompressSync } from 'node:zlib';

const key = 'routing-gateway-key';
const completed = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
async function fixture(t, fetchImpl, bOffline = false) {
  let bReads = 0;
  const backend = { credentials: async () => {
    bReads++;
    if (bOffline) throw Object.assign(new Error('B offline'), { status: 503 });
    return { value: 'token-b', accountId: 'workspace-b' };
  } };
  const gateway = new Gateway({ backend, gatewayKey: key, fetchImpl,
    getAProvider: async () => ({ config: { base_url: 'https://account-a.example.invalid/codex' } }) });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://bridge.invalid')); }
    catch (error) { res.writeHead(error.status ?? 500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, gateway, bReads: () => bReads };
}
const headers = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer token-a',
  'ChatGPT-Account-ID': 'workspace-a', 'Content-Type': 'application/json' };

test('normal models preserve A identity and exact request bytes even while B is offline', async t => {
  let sent;
  const { url, gateway, bReads } = await fixture(t, async (address, options) => {
    sent = { address, ...options }; return new Response(completed);
  }, true);
  const body = '{ "model" : "gpt-6.1-sol", "input": [{"role":"user","content":"原样","internal_chat_message_metadata_passthrough":{"turn_id":"native-a-turn"}}], "tools": [] }';
  const response = await fetch(`${url}/responses`, { method: 'POST', body,
    headers: { ...headers, Cookie: 'original-a=value; bridge_session=must-not-forward', 'X-Original-Provider-Header': 'kept' } });
  assert.equal(response.status, 200); await response.text();
  assert.equal(sent.address, 'https://account-a.example.invalid/codex/responses');
  assert.equal(sent.body.toString(), body);
  assert.equal(sent.headers.get('authorization'), 'Bearer token-a');
  assert.equal(sent.headers.get('chatgpt-account-id'), 'workspace-a');
  assert.equal(sent.headers.get('x-original-provider-header'), 'kept');
  assert.equal(sent.headers.get('x-account-bridge-key'), null);
  assert.equal(sent.headers.get('cookie'), 'original-a=value');
  assert.equal(bReads(), 0);
  assert.equal(gateway.metrics.accounts.A.completed, 1);
  assert.equal(gateway.metrics.accounts.B.requests, 0);
});

test('B aliases change only model identity and never forward A credentials', async t => {
  let sent;
  const { url, gateway } = await fixture(t, async (address, options) => {
    sent = { address, ...options }; return new Response(completed);
  });
  const body = { model: 'B-gpt-6-astra', input: [{ type: 'function_call_output', call_id: 'one', output: '工具结果',
    internal_chat_message_metadata_passthrough: { turn_id: 'native-b-turn', tool_calls_complete: true } }],
    tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }] };
  const response = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers, Cookie: 'a=secret' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(sent.address, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(JSON.parse(sent.body), { ...body, model: 'gpt-6-astra' });
  assert.equal(sent.headers.get('authorization'), 'Bearer token-b');
  assert.equal(sent.headers.get('chatgpt-account-id'), 'workspace-b');
  assert.equal(sent.headers.get('cookie'), null);
  assert.equal(gateway.metrics.accounts.B.completed, 1);
  assert.equal(gateway.metrics.accounts.A.requests, 0);
});

test('unavailable B fails without falling back to A', async t => {
  let sent = 0;
  const { url, gateway } = await fixture(t, async () => { sent++; return new Response(completed); }, true);
  const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol"}' });
  assert.equal(response.status, 503); await response.text();
  assert.equal(sent, 0);
  assert.equal(gateway.metrics.accounts.B.failed, 1);
  assert.equal(gateway.metrics.accounts.A.requests, 0);
});

test('unknown B aliases and missing A credentials do not reach either model account', async t => {
  let sent = 0;
  const { url, bReads } = await fixture(t, async () => { sent++; return new Response(completed); });
  assert.equal((await fetch(`${url}/responses`, { method: 'POST', headers, body: '{"model":"B-unknown"}' })).status, 400);
  assert.equal((await fetch(`${url}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{"model":"gpt-6.1-sol"}' })).status, 401);
  assert.equal(sent, 0); assert.equal(bReads(), 0);
});

test('compaction uses the same B alias route', async t => {
  let sent;
  const { url } = await fixture(t, async (address, options) => { sent = { address, ...options }; return new Response('{}'); });
  const response = await fetch(`${url}/responses/compact`, { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol","input":[]}' });
  assert.equal(response.status, 200); await response.text();
  assert.equal(sent.address, 'https://chatgpt.com/backend-api/codex/responses/compact');
  assert.equal(JSON.parse(sent.body).model, 'gpt-6.1-sol');
  assert.equal(sent.headers.get('authorization'), 'Bearer token-b');
});

test('catalog keeps all A models, adds exactly two B aliases, and A remains available without B', async t => {
  const a = { models: [{ slug: 'a-original', visibility: 'list', base_instructions: 'A original', priority: 1 }] };
  const b = { models: ['gpt-6-astra', 'gpt-6.1-sol', 'unused-b-model'].map(slug => ({ slug, visibility: 'list', base_instructions: slug, priority: 1 })) };
  const fetchImpl = async address => new Response(JSON.stringify(address.startsWith('https://account-a.') ? a : b));
  const active = await fixture(t, fetchImpl);
  const data = await (await fetch(`${active.url}/models?client_version=test`, { headers })).json();
  assert.deepEqual(data.models.map(model => model.slug), ['a-original', 'B-gpt-6-astra', 'B-gpt-6.1-sol']);
  assert.deepEqual(data.models[0], a.models[0]);
  const offline = await fixture(t, fetchImpl, true);
  assert.deepEqual(await (await fetch(`${offline.url}/models`, { headers })).json(), a);
});

test('native zstd requests preserve original A bytes and strip compression after B model translation', async t => {
  const sent = [];
  const { url } = await fixture(t, async (address, options) => { sent.push({ address, ...options }); return new Response(completed); });
  const aBytes = zstdCompressSync(Buffer.from('{ "model":"gpt-6.1-sol", "input":[] }'));
  const a = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'zstd' }, body: aBytes });
  assert.equal(a.status, 200); await a.text();
  assert.deepEqual(sent[0].body, aBytes);
  assert.equal(sent[0].headers.get('content-encoding'), 'zstd');
  const b = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers, 'Content-Encoding': 'zstd' },
    body: zstdCompressSync(Buffer.from('{"model":"B-gpt-6.1-sol","input":[]}')) });
  assert.equal(b.status, 200); await b.text();
  assert.equal(sent[1].headers.get('content-encoding'), null);
  assert.deepEqual(JSON.parse(sent[1].body), { model: 'gpt-6.1-sol', input: [] });
});

test('a stalled B catalog refresh cannot block the native A catalog deadline', async t => {
  const a = { models: [{ slug: 'a-original', visibility: 'list' }] };
  const { url, gateway } = await fixture(t, async address => address.startsWith('https://account-a.')
    ? new Response(JSON.stringify(a)) : new Promise(() => {}));
  gateway.catalogWaitMs = 20;
  const response = await fetch(`${url}/models`, { headers, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(await response.json(), a);
});

test('thread counters distinguish concurrent A and B sessions without storing prompts or credentials', async t => {
  const { url, gateway } = await fixture(t, async () => new Response(completed));
  const aThread = '10000000-0000-0000-0000-000000000001';
  const bThread = '10000000-0000-0000-0000-000000000002';
  await Promise.all([[aThread, 'gpt-6.1-sol'], [bThread, 'B-gpt-6.1-sol']].map(async ([thread, model]) => {
    const response = await fetch(`${url}/responses`, { method: 'POST', headers: { ...headers, 'session-id': thread },
      body: JSON.stringify({ model, input: 'private-prompt-must-not-be-recorded' }) });
    await response.text();
  }));
  assert.equal(gateway.traffic(aThread).accounts.A.completed, 1);
  assert.equal(gateway.traffic(aThread).accounts.B.requests, 0);
  assert.equal(gateway.traffic(bThread).accounts.B.completed, 1);
  assert.equal(gateway.traffic(bThread).accounts.A.requests, 0);
  const stored = JSON.stringify([...gateway.threadTraffic.values()]);
  assert.ok(!stored.includes('token-a')); assert.ok(!stored.includes('token-b'));
  assert.ok(!stored.includes('private-prompt'));
});

test('the real thread id takes precedence over a different cache affinity session id', async t => {
  const { url, gateway } = await fixture(t, async () => new Response(completed));
  const thread = '10000000-0000-0000-0000-000000000003';
  const affinity = '10000000-0000-0000-0000-000000000004';
  const response = await fetch(`${url}/responses`, { method: 'POST',
    headers: { ...headers, 'thread-id': thread, 'session-id': affinity }, body: '{"model":"B-gpt-6.1-sol"}' });
  await response.text();
  assert.equal(gateway.traffic(thread).accounts.B.completed, 1);
  assert.equal(gateway.traffic(affinity), null);
});
