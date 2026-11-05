import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Gateway } from '../src/gateway.mjs';
import { createAnthropicGatewayServer } from '../src/anthropic-gateway.mjs';

const key = 'offline-diagnostic-gateway-key';
const nativeHeaders = { 'x-account-bridge-key': key, authorization: 'Bearer private-account-a', 'chatgpt-account-id': 'private-workspace' };
const usage = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 1 } };
const completed = (output = [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'private model output' }] }]) => ({ id: 'private-response-id', status: 'completed', output, usage });
const sse = response => `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
async function settle() { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); }

async function nativeFixture(t, options = {}) {
  const records = [], usageRecords = [], calls = [];
  const gateway = new Gateway({ gatewayKey: key,
    backend: { credentials: async () => ({ value: 'private-account-b', accountId: 'private-b-workspace' }) },
    getAProvider: async () => ({ config: { base_url: 'https://upstream.invalid/codex' } }),
    fetchImpl: async (address, request) => { calls.push({ address, request }); return options.fetchImpl?.(address, request) ?? Response.json(completed()); },
    ...options, onUsage: async record => { usageRecords.push(record); },
    onDiagnostic: record => { records.push(record); return options.onDiagnostic?.(record); } });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://gateway.invalid')); }
    catch (error) { if (res.headersSent) res.destroy(); else { res.writeHead(error.status ?? 502); res.end('fixture request failed'); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { gateway, records, usageRecords, calls,
    send: (body = { model: 'B-gpt-6.1-sol', input: 'private prompt' }, path = '/responses', extra = {}) => fetch(baseUrl + path, {
      method: 'POST', headers: nativeHeaders, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra,
    }) };
}

test('Responses diagnostics share the usage request ID once and preserve exact streamed bytes without private data', async t => {
  const bytes = `: first response bytes\n\n${sse(completed())}${sse(completed())}`;
  const state = await nativeFixture(t, { fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'private-upstream-request-id' } }) });
  const response = await state.send(undefined, '/responses?credential=private-query');
  assert.equal(response.headers.get('x-request-id'), 'private-upstream-request-id'); assert.equal(await response.text(), bytes); await settle();
  assert.equal(state.records.length, 1); assert.equal(state.usageRecords.length, 1);
  const record = state.records[0];
  assert.equal(record.requestId, state.usageRecords[0].requestId); assert.equal(record.account, 'B');
  assert.equal(record.model, 'B-gpt-6.1-sol'); assert.equal(record.upstreamModel, 'gpt-6.1-sol');
  assert.equal(record.status, 'completed'); assert.equal(record.terminalVerified, true);
  assert.equal(record.usage.totalTokens, 12); assert.equal(record.usage.cachedInputTokens, 5);
  assert.ok(record.durationMs >= record.firstResponseMs); assert.ok(record.firstResponseMs >= 0);
  assert.doesNotMatch(JSON.stringify(record), /private|Bearer|workspace|prompt|output_text|response-id|query|headers/);
});

test('Responses pre-route authentication and validation failures are recorded once without reading provider credentials', async t => {
  let providerCalls = 0;
  const state = await nativeFixture(t, { fetchImpl: async () => { providerCalls++; return Response.json(completed()); } });
  assert.equal((await state.send(undefined, '/responses', { headers: { authorization: 'Bearer wrong-key' } })).status, 401);
  assert.equal((await state.send('{broken-json')).status, 400); await settle();
  assert.equal(providerCalls, 0); assert.equal(state.records.length, 2);
  assert.equal(state.records[0].errorCode, 'authentication_failed'); assert.equal(state.records[0].httpStatus, 401);
  assert.equal(state.records[1].errorCode, 'invalid_request');
  for (const record of state.records) { assert.equal(record.account, null); assert.equal(record.model, null); assert.equal(record.terminalVerified, false); }
});

test('Responses HTTP payload rejection uses fixed diagnostics and does not become a model support error or retry', async t => {
  let count = 0;
  const rejected = { error: { message: 'private secret; unsupported model assertion from reflected body' } };
  const state = await nativeFixture(t, { fetchImpl: async () => { count++; return Response.json(rejected, { status: 400 }); } });
  assert.deepEqual(await (await state.send()).json(), rejected); await settle();
  assert.equal(count, 1); assert.equal(state.records[0].errorCode, 'payload_rejected');
  assert.equal(state.records[0].failureStage, 'upstream_response'); assert.equal(state.records[0].httpStatus, 400);
  assert.equal(state.records[0].terminalVerified, false); assert.doesNotMatch(JSON.stringify(state.records[0]), /private|reflected body/);
});

test('Responses tool callbacks and HTTP 200 without terminal evidence never verify a complete model turn', async t => {
  let result = completed([{ type: 'function_call', status: 'completed', name: 'private_tool', arguments: 'private arguments' }]);
  const state = await nativeFixture(t, { fetchImpl: async () => Response.json(result) });
  await (await state.send()).text(); await settle();
  assert.equal(state.records[0].status, 'tool_pending'); assert.equal(state.records[0].terminalVerified, false);
  result = { status: 'in_progress', usage: { input_tokens: 0, output_tokens: 0 } };
  await (await state.send()).text(); await settle();
  assert.equal(state.records[1].status, 'incomplete'); assert.equal(state.records[1].terminalVerified, false);
  result = { status: 'completed' };
  await (await state.send()).text(); await settle(); assert.equal(state.records[2].terminalVerified, false);
  result = completed([]);
  await (await state.send(undefined, '/responses/compact')).text(); await settle();
  assert.equal(state.records[3].status, 'completed'); assert.equal(state.records[3].terminalVerified, false);
});

test('Responses completion with contradictory message status or missing final content preserves bytes without marking verification passed', async t => {
  let result;
  const state = await nativeFixture(t, { fetchImpl: async () => Response.json(result) });
  for (const output of [[], [{ ...completed().output[0], status: 'incomplete' }], [{ ...completed().output[0], content: [] }],
    [{ ...completed().output[0], content: [{ type: 'output_text', text: '' }] }]]) {
    result = completed(output);
    assert.deepEqual(await (await state.send()).json(), result); await settle();
    assert.equal(state.records.at(-1).terminalVerified, false);
  }
});

test('legal long CodeBuddy source IDs with brackets survive routing and diagnostic verification', async t => {
  const source = `vendor[fast]-${'m'.repeat(243)}`, model = `CodeBuddy-${source}`;
  const provider = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true }), request: async () => {
    const response = Response.json(completed()); response.bridgeModel = source; return response;
  } };
  const state = await nativeFixture(t, { codeBuddyProvider: provider, getAuthorizationVersion: () => 2 });
  await (await state.send({ model, input: 'private prompt' })).text(); await settle();
  assert.ok(model.length > 255); assert.equal(state.records[0].model, model); assert.equal(state.records[0].upstreamModel, source);
  assert.equal(state.records[0].terminalVerified, true);
});

for (const [account, model, option] of [['CodeBuddy', 'claude-codebuddy-opus-5-5', 'codeBuddyProvider'], ['Cursor', 'Cursor-gemini-4-argon', 'cursorProvider']]) {
  test(`${account} diagnostics bind authorization to the request generation and use authoritative bridge usage`, async t => {
    let version = 7, requests = 0;
    const provider = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true }), request: async () => {
      requests++; version = 8;
      const response = new Response(sse({ ...completed(), usage: { input_tokens: 0, output_tokens: 0 } }), { headers: { 'content-type': 'text/event-stream' } });
      response.bridgeUsage = Promise.resolve(usage); response.bridgeModel = 'actual-provider-model'; return response;
    } };
    const state = await nativeFixture(t, { [option]: provider, getAuthorizationVersion: channel => channel === account ? version : null });
    await (await state.send({ model, input: 'private prompt' })).text(); await settle();
    assert.equal(requests, 1); assert.equal(state.records[0].account, account); assert.equal(state.records[0].authorizationVersion, 7);
    assert.equal(state.records[0].upstreamModel, 'actual-provider-model'); assert.equal(state.records[0].usage.totalTokens, 12);
    assert.equal(state.records[0].terminalVerified, true);
  });
}

test('firstResponseMs measures the first upstream body bytes including comments, rather than pretending to measure a token', async t => {
  const first = ': connection comment before output\n\n', last = sse(completed());
  const state = await nativeFixture(t, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    setTimeout(() => controller.enqueue(Buffer.from(first)), 15);
    setTimeout(() => { controller.enqueue(Buffer.from(last)); controller.close(); }, 45);
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(await (await state.send()).text(), first + last); await settle();
  const record = state.records[0];
  assert.ok(record.firstResponseMs >= 8); assert.ok(record.durationMs > record.firstResponseMs + 10);
  assert.equal(Object.hasOwn(record, 'firstTokenMs'), false);
});

test('a diagnostic sink rejection cannot change response bytes, status or native request accounting', async t => {
  const state = await nativeFixture(t, { onDiagnostic: async () => { throw new Error('private disk path'); } });
  const response = await state.send(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), completed()); await settle();
  assert.equal(state.gateway.metrics.completed, 1); assert.equal(state.gateway.pendingRequests, 0); assert.equal(state.records.length, 1);
});

test('downstream failure and client cancellation never verify terminal content received before delivery', async () => {
  for (const interrupted of [false, true]) {
    const records = []; let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gateway = new Gateway({ gatewayKey: key, backend: { credentials: async () => ({ value: 'private-b', accountId: 'private-workspace' }) },
      getAProvider: async () => ({ config: { base_url: 'https://upstream.invalid' } }), onDiagnostic: record => records.push(record),
      fetchImpl: async (_address, { signal }) => interrupted ? new Promise((_resolve, reject) => {
        entered(); signal.addEventListener('abort', () => reject(new Error('private client failure')), { once: true });
      }) : Response.json(completed()) });
    const req = { method: 'POST', headers: nativeHeaders, async *[Symbol.asyncIterator]() { yield Buffer.from('{"model":"B-gpt-6.1-sol"}'); } };
    const res = new EventEmitter(); res.writableEnded = false; res.writeHead = () => {}; res.write = () => { throw new Error('private downstream failure'); };
    const operation = gateway.proxy(req, res, new URL('http://gateway.invalid/responses'));
    if (interrupted) { await started; res.emit('close'); }
    await assert.rejects(operation); assert.equal(records.length, 1); assert.equal(records[0].terminalVerified, false);
    assert.equal(records[0].status, interrupted ? 'interrupted' : 'failed'); assert.doesNotMatch(JSON.stringify(records[0]), /private/);
    assert.equal(gateway.pendingRequests, 0);
  }
});

const anthropicModel = { id: 'claude-codebuddy-opus-5-5', name: 'Offline CodeBuddy', upstream: 'actual-opus-model' };
const message = (stopReason = 'end_turn') => ({ id: 'private-message-id', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'private output' }],
  stop_reason: stopReason, usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 2 } });
const event = (type, extra = {}) => `data: ${JSON.stringify({ type, ...extra })}\n\n`;
async function anthropicFixture(t, options = {}) {
  const records = [], usageRecords = [], calls = [];
  const provider = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true }), request: async request => {
    calls.push(request); return options.request?.(request) ?? Response.json(message());
  } };
  const server = createAnthropicGatewayServer({ routes: [{ account: options.account ?? 'CodeBuddy', model: anthropicModel, provider }], gatewayKey: key,
    allowedPeers: ['127.0.0.1'], getAuthorizationVersion: options.getAuthorizationVersion ?? (() => 3),
    onUsage: record => usageRecords.push(record), onDiagnostic: record => { records.push(record); return options.onDiagnostic?.(record); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = `127.0.0.1:${server.address().port}`; server.gateway.allowedHosts.add(address);
  return { records, calls, usageRecords, gateway: server.gateway,
    send: (body = { model: anthropicModel.id, messages: [{ role: 'user', content: 'private prompt' }] }, path = '/v1/messages', options = {}) => fetch(`http://${address}${path}`, {
      method: 'POST', headers: { 'x-api-key': key }, body: typeof body === 'string' ? body : JSON.stringify(body), ...options,
    }) };
}

test('Anthropic end_turn diagnostics use actual completion evidence, cache counts and the same usage request ID', async t => {
  const state = await anthropicFixture(t); const response = await state.send(undefined, '/v1/messages?private=query');
  assert.deepEqual(await response.json(), message()); await settle();
  assert.equal(state.records.length, 1); assert.equal(state.records[0].requestId, state.usageRecords[0].requestId);
  assert.equal(state.records[0].account, 'CodeBuddy'); assert.equal(state.records[0].authorizationVersion, 3);
  assert.equal(state.records[0].status, 'completed'); assert.equal(state.records[0].terminalVerified, true);
  assert.equal(state.records[0].usage.inputTokens, 10); assert.equal(state.records[0].usage.totalTokens, 12);
  assert.doesNotMatch(JSON.stringify(state.records[0]), /private|query|prompt|content/);
});

test('Anthropic tool_use, truncated output and a message_stop without end_turn do not verify a complete turn', async t => {
  let response = Response.json({ ...message('tool_use'), content: [{ type: 'tool_use', id: 'private-tool', name: 'private-function', input: {} }] });
  const state = await anthropicFixture(t, { request: async () => response });
  await (await state.send()).text(); await settle(); assert.equal(state.records[0].status, 'tool_pending'); assert.equal(state.records[0].terminalVerified, false);
  response = Response.json(message('max_tokens'));
  await (await state.send()).text(); await settle(); assert.equal(state.records[1].status, 'incomplete'); assert.equal(state.records[1].terminalVerified, false);
  const bytes = event('message_start', { message: { id: 'private-id', usage: {} } }) + event('message_stop');
  response = new Response(bytes, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await (await state.send()).text(), bytes); await settle(); assert.equal(state.records[2].terminalVerified, false);
});

test('Anthropic end_turn without a valid answer or a valid streaming message start never marks verification passed', async t => {
  let response;
  const state = await anthropicFixture(t, { request: async () => response });
  for (const content of [undefined, [], [{ type: 'text', text: '' }]]) {
    const result = { ...message(), content };
    response = Response.json(result);
    assert.deepEqual(await (await state.send()).json(), JSON.parse(JSON.stringify(result))); await settle();
    assert.equal(state.records.at(-1).terminalVerified, false);
  }
  for (const prefix of ['', event('message_start', { message: { type: 'message', role: 'assistant', content: [] } }),
    event('message_start', { message: { type: 'message', role: 'user', content: [] } })]) {
    const bytes = prefix + event('message_delta', { delta: { stop_reason: 'end_turn' } }) + event('message_stop');
    response = new Response(bytes, { headers: { 'content-type': 'text/event-stream' } });
    assert.equal(await (await state.send()).text(), bytes); await settle(); assert.equal(state.records.at(-1).terminalVerified, false);
  }
});

test('Anthropic streamed completion requires message_stop and end_turn; fixed errors never publish reflected bodies', async t => {
  const end = event('message_start', { message: { id: 'private-id', type: 'message', role: 'assistant', content: [], usage: {} } }) +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'private answer' } }) + event('content_block_stop', { index: 0 }) +
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  let bytes = end + event('message_stop');
  const state = await anthropicFixture(t, { request: async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(await (await state.send()).text(), bytes); await settle(); assert.equal(state.records[0].terminalVerified, true);
  bytes = end; await (await state.send()).text(); await settle(); assert.equal(state.records[1].status, 'incomplete');
  bytes = event('error', { error: { type: 'rate_limit_error', message: 'private reflected upstream secret' } });
  await (await state.send()).text(); await settle(); assert.equal(state.records[2].errorCode, 'quota_or_rate_limited');
  assert.equal(state.records[2].httpStatus, 200); assert.equal(state.records[2].terminalVerified, false);
  assert.doesNotMatch(JSON.stringify(state.records), /private|secret|reflected/);
});

for (const stream of [false, true]) {
  test(`Anthropic ${stream ? 'SSE' : 'JSON'} diagnostics prefer a defined CodeBuddy code over api_error`, async t => {
    const data = { type: 'error', error: { type: 'api_error', code: 'codebuddy_unsupported_delta', message: 'private reflected provider data' } };
    const bytes = stream ? event('error', { error: data.error }) : JSON.stringify(data);
    const state = await anthropicFixture(t, { request: async () => new Response(bytes, { status: stream ? 200 : 502,
      headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } }) });
    assert.equal(await (await state.send()).text(), bytes); await settle();
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].status, 'failed');
    assert.equal(state.records[0].errorCode, 'codebuddy_unsupported_delta');
    assert.equal(state.records[0].failureStage, stream ? 'stream' : 'upstream_response');
    assert.equal(state.records[0].terminalVerified, false);
    assert.doesNotMatch(JSON.stringify(state.records), /private|reflected|provider data/);
  });
}

test('Anthropic diagnostics isolate unknown account names and skip metadata/token-count endpoints', async t => {
  const state = await anthropicFixture(t, { account: 'private person@example.test' });
  await (await state.send()).text(); await settle(); assert.equal(state.records[0].account, null);
  await (await state.send(undefined, '/v1/messages/count_tokens')).text();
  await (await state.send(undefined, '/health', { method: 'GET', body: undefined })).text();
  await (await state.send(undefined, '/v1/models', { method: 'GET', body: undefined })).text(); await settle();
  assert.equal(state.records.length, 1);
});

test('Anthropic auth/payload failures are safe and diagnostic sink failure cannot alter returned content', async t => {
  let bad = false;
  const state = await anthropicFixture(t, { request: async () => bad ? Response.json({ error: { message: 'private unsupported model claim' } }, { status: 400 }) : Response.json(message()),
    onDiagnostic: () => { throw new Error('private journal failure'); } });
  assert.equal((await state.send(undefined, '/v1/messages', { headers: { 'x-api-key': 'wrong-key' } })).status, 401); await settle();
  assert.equal(state.records[0].errorCode, 'authentication_failed'); assert.equal(state.records[0].account, null); assert.equal(state.calls.length, 0);
  bad = true; assert.equal((await state.send()).status, 400); await settle();
  assert.equal(state.records[1].errorCode, 'payload_rejected'); assert.doesNotMatch(JSON.stringify(state.records), /private|claim/);
  bad = false; assert.deepEqual(await (await state.send()).json(), message()); await settle();
  assert.equal(state.records[2].terminalVerified, true); assert.equal(state.gateway.pendingRequests, 0);
});
