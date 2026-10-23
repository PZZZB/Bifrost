import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Gateway } from '../src/gateway.mjs';
import { CURSOR_MODELS, resolveCursorModel } from '../src/cursor-service.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';
import { CursorResponsesProvider, CURSOR_RESPONSES_STATE_PREFIX } from '../src/cursor-responses.mjs';
import { CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';

const key = 'local-cursor-fixture-key';
const headers = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer private-a-auth', 'ChatGPT-Account-ID': 'private-a-account',
  Cookie: 'private-a-session=secret', 'Content-Type': 'application/json' };
const ready = { authenticated: true, ready: true, modelAvailable: true };
async function sdkProvider(t, { events, result, gateAfterFirst = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-cursor-gateway-'));
  const counts = { created: 0, sends: 0, cancelled: 0, closed: 0 };
  let release;
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const provider = new CursorResponsesProvider({ stateDir: directory,
    cursorService: { credential: async () => ({ apiKey: 'private-cursor-fixture-key', apiKeyExpiresAtMs: Date.now() + 60000 }),
      getModels: async () => CURSOR_MODELS.map(model => ({ id: model.upstream })), status: async () => ready },
    sdkLoader: async () => ({ JsonlLocalAgentStore: class {}, Agent: { async create() {
      counts.created++;
      return { agentId: 'fixture-agent', close() { counts.closed++; }, async send() {
        counts.sends++;
        return { async *stream() {
          for (const event of events) { await new Promise(resolveTick => setImmediate(resolveTick)); yield event; if (gateAfterFirst) await gate; }
        }, async wait() { return result; }, async cancel() { counts.cancelled++; release(); } };
      } };
    } } }) });
  t.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, counts };
}

async function fixture(t, { enabled = () => true, provider, sourceModels = CURSOR_MODELS.map(model => ({ id: model.upstream })), modelPolicy = null } = {}) {
  const calls = [], records = [];
  let nativeCalls = 0;
  const gateway = new Gateway({ gatewayKey: key, cursorEnabled: enabled, modelPolicy,
    cursorProvider: provider ?? { status: async () => ready, request: async options => {
      calls.push(options);
      const model = resolveCursorModel(JSON.parse(options.body).model);
      if (!model || !sourceModels.some(source => source.id === model.upstream)) return Response.json({ error: { code: 'cursor_model_unavailable' } }, { status: 403 });
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

test('disabled Cursor aliases and malformed reserved names fail without using another subscription', async t => {
  const { url, nativeCalls, calls } = await fixture(t, { enabled: () => false });
  for (const [model, expected] of [[CURSOR_MODELS[0].id, 503], ['Cursor-gemini-4-wrong', 503], ['Cursor-/invalid', 400], ['cursor/grok', 400]]) {
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
  assert.deepEqual(data.models.map(model => model.slug), ['a-model', 'B-gpt-6-astra', 'B-gpt-6.1-sol', 'claude-codebuddy-opus-5-5', CURSOR_MODELS[1].id, 'Cursor-unrequested-model']);
  assert.deepEqual(data.models[0].preserved, { data: true });
});

test('full Cursor discovery does not publish or execute a new alias before the user enables it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-cursor-switches-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = await ModelPolicy.open({ path: join(directory, 'policy.json') }), id = 'Cursor-future-model';
  await policy.observe({ models: CURSOR_MODELS });
  const { url, calls, gateway } = await fixture(t, { modelPolicy: policy, sourceModels: [...CURSOR_MODELS.map(model => ({ id: model.upstream })), { id: 'future-model' }] });
  const listing = await (await fetch(`${url}/models`, { headers })).json();
  assert.equal(listing.models.some(model => model.slug === id), false);
  assert.equal(policy.snapshot().models.find(model => model.id === id).enabled, false);
  const blocked = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: id }) });
  assert.equal(blocked.status, 400); assert.equal((await blocked.json()).error.code, 'model_disabled'); assert.equal(calls.length, 0);
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [] });
  const published = await (await fetch(`${url}/models`, { headers })).json(); assert.equal(published.models.some(model => model.slug === id), true);
  const accepted = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: id }) });
  assert.equal(accepted.status, 200); await accepted.text(); assert.equal(calls.length, 1);
  assert.equal(gateway.metrics.accounts.Cursor.completed, 1); assert.equal(gateway.metrics.accounts.A.requests, 0);
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [id] });
  const closed = await fetch(`${url}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: id }) });
  assert.equal(closed.status, 400); await closed.text(); assert.equal(calls.length, 1);
});

test('the final catalog drops an earlier channel that reauthorizes while another source is still pending', async () => {
  let version = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const provider = { status: async () => ready, request() { assert.fail('Metadata must not infer'); } };
  const gateway = new Gateway({ gatewayKey: key, catalogWaitMs: 2000,
    backend: { credentials: async () => ({ value: 'b-fixture', accountId: 'b-fixture' }) },
    getAProvider: async () => ({ config: { base_url: 'https://a.invalid/codex' } }),
    fetchImpl: async address => Response.json(address.startsWith('https://a.invalid/') ? { models: [{ slug: 'a-model' }] }
      : { models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-6.1-sol' }] }),
    codeBuddyProvider: provider, getCodeBuddyModels: async () => [{ id: 'CodeBuddy-old-model', name: 'Old model', available: true }],
    getCodeBuddyAuthorizationVersion: () => version,
    cursorProvider: { ...provider, status: async () => { await gate; return ready; } }, getCursorModels: async () => [{ id: 'current-model' }],
  });
  let data;
  const pending = gateway.catalog({ headers }, { writeHead() {}, end: value => { data = JSON.parse(value); } }, new URL('http://fixture.invalid/models'));
  await new Promise(resolve => setImmediate(resolve)); version++; release(); await pending;
  assert.equal(data.models.some(model => model.slug === 'CodeBuddy-old-model'), false);
  assert.equal(data.models.some(model => model.slug === 'Cursor-current-model'), true);
  assert.equal(data.models[0].slug, 'a-model');
});

test('Cursor asynchronous SDK startup rejection reaches Codex as a terminal HTTP error before SSE headers', async t => {
  for (const [message, status, code] of [
    ["[invalid_argument] unknown option '--system-prompt'", 403, 'cursor_system_prompt_denied'],
    ['unauthorized', 401, 'cursor_auth_rejected'],
  ]) {
    const { provider, counts } = await sdkProvider(t, { events: [{ type: 'status', status: 'ERROR', message }],
      result: { status: 'error', error: { message, status } } });
    const { url, records, gateway, nativeCalls, settle } = await fixture(t, { provider });
    const response = await fetch(`${url}/responses`, { method: 'POST', headers,
      body: JSON.stringify({ model: CURSOR_MODELS[0].id, instructions: 'Trusted fixture instruction.', input: 'fixture', stream: true }) });
    assert.equal(response.status, status); assert.equal(response.headers.get('content-type'), 'application/json');
    const text = await response.text(); assert.equal(JSON.parse(text).error.code, code); assert.equal(text.includes('response.created'), false);
    await settle();
    assert.deepEqual(counts, { created: 1, sends: 1, cancelled: 1, closed: 1 }); assert.equal(nativeCalls(), 0);
    assert.equal(records.length, 1); assert.equal(records[0].httpStatus, status); assert.equal(records[0].status, 'failed');
    assert.equal(records[0].usage, null); assert.equal(gateway.pendingRequests, 0); assert.equal(gateway.metrics.accounts.Cursor.active, 0);
  }
});

test('a client disconnect after successful Cursor preflight cancels the SDK run and settles gateway accounting', { timeout: 3000 }, async t => {
  const { provider, counts } = await sdkProvider(t, {
    events: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Started.' }] } }],
    result: { status: 'finished' }, gateAfterFirst: true,
  });
  const { url, records, gateway, settle } = await fixture(t, { provider }), abort = new AbortController();
  const response = await fetch(`${url}/responses`, { method: 'POST', headers, signal: abort.signal,
    body: JSON.stringify({ model: CURSOR_MODELS[0].id, input: 'fixture', stream: true }) });
  assert.equal(response.status, 200);
  const first = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /response.created/); abort.abort();
  await settle();
  assert.equal(counts.sends, 1); assert.equal(counts.cancelled, 1); assert.equal(counts.closed, 1);
  assert.equal(provider.activeRuns, 0); assert.equal(gateway.pendingRequests, 0);
  assert.equal(records.length, 1); assert.equal(records[0].status, 'interrupted'); assert.equal(records[0].usage, null);
});

test('a client disconnect while Cursor preflight awaits first output closes the pending SDK run', { timeout: 3000 }, async t => {
  const { provider, counts } = await sdkProvider(t, { events: [{ type: 'usage', usage: null }],
    result: { status: 'finished' }, gateAfterFirst: true });
  const { url, records, gateway, settle } = await fixture(t, { provider });
  const request = http.request(`${url}/responses`, { method: 'POST', headers });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: CURSOR_MODELS[0].id, input: 'fixture', stream: true }));
  while (!counts.sends) await new Promise(resolveTick => setImmediate(resolveTick));
  request.destroy(); await settle();
  assert.equal(counts.sends, 1); assert.equal(counts.cancelled, 1); assert.equal(counts.closed, 1);
  assert.equal(provider.activeRuns, 0); assert.equal(gateway.pendingRequests, 0);
  assert.equal(records.length, 1); assert.equal(records[0].status, 'interrupted'); assert.equal(records[0].usage, null);
});
