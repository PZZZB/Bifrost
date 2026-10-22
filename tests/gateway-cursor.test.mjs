import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Gateway } from '../src/gateway.mjs';
import { CURSOR_MODELS } from '../src/cursor-service.mjs';
import { CURSOR_RESPONSES_STATE_PREFIX } from '../src/cursor-responses.mjs';
import { CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';

const key = 'local-cursor-fixture-key';
const headers = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer private-a-auth', 'ChatGPT-Account-ID': 'private-a-account',
  Cookie: 'private-a-session=secret', 'Content-Type': 'application/json' };
const ready = { authenticated: true, ready: true, modelAvailable: true };
async function fixture(t, { enabled = () => true, provider, sourceModels = CURSOR_MODELS.map(model => ({ id: model.upstream })) } = {}) {
  const calls = [], records = [];
  let nativeCalls = 0;
  const gateway = new Gateway({ gatewayKey: key, cursorEnabled: enabled,
    cursorProvider: provider ?? { status: async () => ready, request: async options => {
      calls.push(options);
      const model = CURSOR_MODELS.find(model => model.id === JSON.parse(options.body).model);
      const response = Response.json({ id: 'resp-cursor-fixture', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } });
      response.bridgeUsage = Promise.resolve(null); response.bridgeModel = model.upstream; return response;
    } }, getCursorModels: async () => sourceModels,
    codeBuddyProvider: { status: async () => ready, request: async () => { nativeCalls++; throw new Error('Unexpected CodeBuddy fallback'); } },
    backend: { credentials: async () => { nativeCalls++; return { value: 'b-auth', accountId: 'b-account' }; } },
    getAProvider: async () => { nativeCalls++; return { config: { base_url: 'https://a.invalid/codex' } }; },
    fetchImpl: async address => { nativeCalls++; return Response.json(address.startsWith('https://a.invalid/')
      ? { models: [{ slug: 'a-model', priority: 1, preserved: { data: true } }] }
      : { models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-6.1-sol' }] }); },
    onUsage: async record => { records.push(record); } });
  const tasks = new Set();
  const server = http.createServer((req, res) => {
    const task = gateway.proxy(req, res, new URL(req.url, 'http://fixture.invalid')).catch(error => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: error.code, message: error.message } })); }
    });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { gateway, calls, records, nativeCalls: () => nativeCalls, settle: () => Promise.all([...tasks]),
    url: `http://127.0.0.1:${server.address().port}` };
}

test('Cursor aliases route exclusively to the SDK bridge, preserving client tools without passing other credentials', async t => {
  const { url, gateway, calls, records, nativeCalls, settle } = await fixture(t);
  for (const model of CURSOR_MODELS) {
    const body = { model: model.id, input: 'fixture', tools: [{ type: 'function', name: 'request_user_input' }] };
    const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual(JSON.parse(calls.at(-1).body), body);
    assert.deepEqual([...calls.at(-1).headers.entries()], [['accept', '*/*'], ['content-type', 'application/json']]);
  }
  await settle(); assert.equal(nativeCalls(), 0);
  assert.deepEqual(records.map(record => [record.account, record.model, record.upstreamModel, record.usage]),
    CURSOR_MODELS.map(model => ['Cursor', model.id, model.upstream, null]));
  assert.equal(gateway.metrics.accounts.Cursor.completed, 2);
  assert.equal(gateway.metrics.accounts.A.requests + gateway.metrics.accounts.B.requests + gateway.metrics.accounts.CodeBuddy.requests, 0);
  assert.equal(gateway.pendingRequests, 0);
});

test('disabled or misspelled Cursor models fail locally without using another subscription', async t => {
  const { url, nativeCalls, calls } = await fixture(t, { enabled: () => false });
  for (const [model, expected] of [[CURSOR_MODELS[0].id, 503], ['Cursor-gemini-4-wrong', 400], ['cursor/grok', 400]]) {
    const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model }) });
    assert.equal(response.status, expected); await response.text();
  }
  assert.equal(nativeCalls(), 0); assert.equal(calls.length, 0);
});

test('Cursor live state is blocked on A/B/CodeBuddy and CodeBuddy state is blocked on Cursor', async t => {
  const { url, nativeCalls, calls } = await fixture(t);
  for (const model of ['a-model', 'B-gpt-6.1-sol', 'claude-codebuddy-opus-5-5', CURSOR_MODELS[0].id]) {
    const prefix = model === CURSOR_MODELS[0].id ? CODEBUDDY_RESPONSES_STATE_PREFIX : CURSOR_RESPONSES_STATE_PREFIX;
    const response = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model,
      input: [{ type: 'reasoning', encrypted_content: prefix + 'opaque-test' }] }) });
    assert.equal(response.status, 400); assert.match((await response.json()).error.code, /history_channel_mismatch/);
  }
  assert.equal(nativeCalls(), 0); assert.equal(calls.length, 0);
});

test('Cursor authoritative current-request usage reaches the ledger once and never substitutes protocol zeroes', async t => {
  const reported = { input_tokens: 21, output_tokens: 8, total_tokens: 29 };
  const { url, records, settle } = await fixture(t, { provider: { status: async () => ready, request: async () => {
    const response = new Response('data: {"type":"response.completed","response":{"id":"cursor-usage","status":"completed","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    response.bridgeUsage = Promise.resolve(reported); response.bridgeModel = CURSOR_MODELS[0].upstream; return response;
  } } });
  await (await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: CURSOR_MODELS[0].id }) })).text(); await settle();
  assert.equal(records.length, 1); assert.deepEqual(records[0].usage, reported); assert.equal(records[0].account, 'Cursor');
});

test('Cursor joins the catalog after the original A/B and CodeBuddy entries only for available source IDs', async t => {
  const { url } = await fixture(t, { sourceModels: [{ id: CURSOR_MODELS[1].upstream }, { id: 'unrequested-model' }] });
  const response = await fetch(`${url}/models`, { headers }); assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.models.map(model => model.slug), ['a-model', 'B-gpt-6-astra', 'B-gpt-6.1-sol', 'claude-codebuddy-opus-5-5', CURSOR_MODELS[1].id]);
  assert.deepEqual(data.models[0].preserved, { data: true });
});
