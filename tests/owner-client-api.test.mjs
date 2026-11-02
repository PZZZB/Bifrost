import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnerClientApi, OWNER_CLIENT_PATHS } from '../src/owner-client-api.mjs';

const KEY = 'owner-local-key-' + 'k'.repeat(48), MODEL = 'B-gpt-6.1-sol';
const user = content => ({ role: 'user', content });
const request = extra => ({ model: MODEL, messages: [user('Hello')], ...extra });
const model = (extra = {}) => ({ id: MODEL, name: 'Managed Codex', channel: 'B', enabled: true, available: true, ...extra });
const textItem = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const final = (output = [textItem('Hello back')], extra = {}) => ({ object: 'response', id: 'resp_owner', model: MODEL,
  status: 'completed', output, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, ...extra });
const response = (output, extra) => Response.json(final(output, extra));
const event = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } };
const call = { type: 'function_call', id: 'fc_owner', call_id: 'call_owner', name: 'read_file', arguments: '{"path":"a.txt"}', status: 'completed' };

async function fixture(t, options = {}) {
  const calls = [], mutable = { models: [model()], draining: false };
  const api = createOwnerClientApi({ gatewayKey: KEY, getModels: () => mutable.models,
    requestResponses: async value => { calls.push(value); return response(); }, isDraining: () => mutable.draining, ...options });
  const server = http.createServer((req, res) => { void api.handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const get = (path = OWNER_CLIENT_PATHS.models, headers = {}) => fetch(root + path, { headers: { authorization: `Bearer ${KEY}`, ...headers } });
  const post = (body = request(), extra = {}) => fetch(root + OWNER_CLIENT_PATHS.chat, { method: 'POST',
    ...extra, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...extra.headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
  return { api, calls, mutable, root, get, post, server };
}
async function waitFor(predicate, message = 'Condition did not settle') {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await delay(10); }
  assert.fail(message);
}

test('local owner catalog requires the gateway bearer key and projects only enabled independent Responses sources', async t => {
  const f = await fixture(t);
  f.mutable.models = [model({ authToken: 'PRIVATE-TOKEN', endpoint: 'https://private.invalid', binding: { credentialRef: 'PRIVATE-REF' } }),
    model({ id: 'gpt-6.1-sol', channel: 'A' }), model({ id: 'hidden-disabled', enabled: false }),
    model({ id: 'hidden-unavailable', available: false }), model({ id: 'hidden-unknown' , available: undefined }),
    model({ id: 'hidden-caller', sourceCredential: { mode: 'caller' } }),
    model({ id: 'hidden-client-kind', sourceKind: 'codex-client' }), model({ id: 'hidden-channel', channel: 'Other' }),
    model({ id: 'Claude-opus', channel: 'Claude', protocols: ['messages'] }),
    model({ id: 'remote/one/Claude-sonnet', channel: 'Bifrost', protocols: ['messages'] }), model()];
  const unauthenticated = await fetch(f.root + OWNER_CLIENT_PATHS.models, { headers: { cookie: `bridge_session=${KEY}` } });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await f.get(undefined, { authorization: 'Bearer wrong' })).status, 401);
  const catalog = await f.get(); assert.equal(catalog.status, 200); assert.equal(catalog.headers.get('cache-control'), 'no-store');
  const data = await catalog.json(); assert.deepEqual(data.data.map(entry => entry.id), [MODEL]);
  assert.deepEqual(data.data[0].protocols, ['chat-completions']);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE|private\.invalid|credentialRef|authToken|binding/);
  assert.equal(f.calls.length, 0); assert.equal(f.api.activeRequests, 0);
});

test('owner API accepts exact model paths and methods, rejects browser origins and has no management capability', async t => {
  const f = await fixture(t);
  assert.equal(f.api.handles(OWNER_CLIENT_PATHS.models), true); assert.equal(f.api.handles('/api/status'), false);
  assert.equal(f.api.handles('/owner/v1/models/'), false);
  for (const path of ['/owner/v1/models?redirect=https://private.invalid', '/owner/v1/models/', '/owner/v1/responses', '/api/service/restart']) {
    const result = await f.get(path); assert.equal(result.status, 404); await result.text();
  }
  const method = await fetch(f.root + OWNER_CLIENT_PATHS.chat, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await f.post(request(), { headers: { origin: f.root } })).status, 403);
  assert.equal((await f.post(request(), { headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.post(request(), { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('Chat requests convert into Responses with a private owner scope and never forward incoming credentials', async t => {
  const f = await fixture(t);
  const result = await f.post(request({ messages: [{ role: 'system', content: 'Keep the rule' }, user('Hello')], tools: [tool] }),
    { headers: { cookie: 'private_cookie=do-not-forward', 'x-bifrost-client-scope': 'external-caller', 'x-api-key': 'wrong-other-key' } });
  assert.equal(result.status, 200);
  const data = await result.json(); assert.equal(data.object, 'chat.completion'); assert.equal(data.choices[0].message.content, 'Hello back');
  assert.equal(f.calls.length, 1); const upstream = f.calls[0];
  assert.deepEqual(Object.keys(upstream).sort(), ['body', 'scope', 'signal']);
  assert.match(upstream.scope, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.equal(upstream.body.model, MODEL); assert.equal(upstream.body.store, false); assert.equal(upstream.body.stream, true);
  assert.equal(upstream.body.input[0].role, 'system'); assert.equal(upstream.body.tools[0].name, 'read_file');
  assert.doesNotMatch(JSON.stringify(upstream), /external-caller|private_cookie|wrong-other-key|owner-local-key/);
  assert.equal(f.api.activeRequests, 0);
});

test('A, unknown, disabled and unavailable model requests never reach the upstream', async t => {
  const f = await fixture(t);
  f.mutable.models = [model(), model({ id: 'gpt-6.1-sol', channel: 'A' }), model({ id: 'disabled', enabled: false }), model({ id: 'unavailable', available: false })];
  for (const id of ['gpt-6.1-sol', 'unknown-model', 'disabled', 'unavailable']) {
    const result = await f.post(request({ model: id })); assert.equal(result.status, 403);
    assert.equal((await result.json()).error.code, 'owner_client_model_forbidden');
  }
  f.mutable.models = [model({ enabled: false })];
  assert.equal((await f.post()).status, 403); assert.equal(f.calls.length, 0);
  assert.deepEqual((await (await f.get()).json()).data, []);
});

test('opaque tool state is kept inside the owner adapter, restored on a matching turn and rejected after a model switch', async t => {
  const received = [];
  const f = await fixture(t, { requestResponses: async value => { received.push(value); return received.length === 1
    ? response([{ type: 'reasoning', encrypted_content: 'opaque-upstream-private-state', summary: [] }, call])
    : response([textItem('Done')]); } });
  f.mutable.models.push(model({ id: 'B-gpt-6-astra' }));
  const first = await (await f.post(request({ tools: [tool] }))).json();
  const assistant = first.choices[0].message;
  assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(assistant.tool_calls[0].id, call.call_id);
  assert.doesNotMatch(JSON.stringify(first), /opaque-upstream-private-state|bifrost-client-state/);
  const history = [user('Hello'), assistant, { role: 'tool', tool_call_id: call.call_id, content: 'File contents' }];
  const changed = await f.post(request({ model: 'B-gpt-6-astra', messages: history, tools: [tool] }));
  assert.equal(changed.status, 409); assert.equal(received.length, 1);
  const next = await f.post(request({ messages: history, tools: [tool] })); assert.equal(next.status, 200); await next.text();
  assert.equal(received.length, 2);
  assert.equal(received[1].body.input.find(item => item.type === 'reasoning').encrypted_content, 'opaque-upstream-private-state');
  assert.equal(received[1].body.input.at(-1).type, 'function_call_output');
});

test('streaming keeps Chat chunks, terminal DONE and authoritative usage without exposing upstream headers', async t => {
  const f = await fixture(t, { requestResponses: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(event({ type: 'response.output_text.delta', delta: 'Hello back' }));
    controller.enqueue(event({ type: 'response.completed', response: final() })); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-private-token': KEY } }) });
  const result = await f.post(request({ stream: true, stream_options: { include_usage: true } }));
  assert.equal(result.status, 200); assert.match(result.headers.get('content-type'), /text\/event-stream/);
  assert.equal(result.headers.get('x-private-token'), null);
  const output = await result.text(); assert.match(output, /Hello back/); assert.match(output, /\[DONE\]/); assert.match(output, /"prompt_tokens":7/);
  assert.doesNotMatch(output, /owner-local-key|x-private-token/); assert.equal(f.api.activeRequests, 0);
});

test('body limits, encoding, invalid JSON and unsupported Chat fields fail before inference', async t => {
  const f = await fixture(t, { maxBodyBytes: 256 });
  assert.equal((await f.post(request(), { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(request(), { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.post('not json')).status, 400);
  assert.equal((await f.post('null')).status, 400);
  assert.equal((await f.post(request({ unsupported_option: true }))).status, 400);
  assert.equal((await f.post(request({ messages: [user('x'.repeat(400))] }))).status, 413);
  assert.equal(f.calls.length, 0);
});

test('concurrency and draining reject new calls, client disconnect cancels the existing upstream', async t => {
  let upstreamSignal, cancelled = false;
  const f = await fixture(t, { maxConcurrent: 1, requestResponses: async ({ signal }) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(event({ type: 'response.output_text.delta', delta: 'Started' })); },
      cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const abort = new AbortController(), first = await f.post(request({ stream: true }), { signal: abort.signal });
  assert.equal(first.status, 200); assert.equal(f.api.activeRequests, 1);
  assert.equal((await f.post()).status, 429);
  f.mutable.draining = true; assert.equal((await f.post()).status, 503); assert.equal((await f.get()).status, 200);
  abort.abort(); await first.body.cancel().catch(() => {});
  await waitFor(() => upstreamSignal.aborted && cancelled && f.api.activeRequests === 0, 'Disconnect did not release the upstream and request slot');
  f.api.close(); assert.equal((await f.get()).status, 503);
});

test('catalog and transport failures do not disclose arbitrary errors or private state', async t => {
  const f = await fixture(t, { requestResponses: async () => { throw new Error('PRIVATE-UPSTREAM-TOKEN https://private.invalid'); } });
  const failed = await f.post(); assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /PRIVATE|private\.invalid/);
  const g = await fixture(t, { getModels: () => { throw new Error('PRIVATE-CATALOG'); } });
  const catalog = await g.get(); assert.equal(catalog.status, 503); assert.doesNotMatch(await catalog.text(), /PRIVATE/);
});
