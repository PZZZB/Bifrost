import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createWithGatewayServer, normalizeAnthropicUsage, WITH_MODEL } from '../src/with-gateway.mjs';

const key = 'dedicated-with-test-key-separate-from-a-b';
const host = '192.168.168.1:43157';
const authHeaders = { Host: host, 'x-api-key': key, 'Content-Type': 'application/json' };
const modelBody = { model: WITH_MODEL.id, max_tokens: 64, messages: [{ role: 'user', content: 'Mock only' }] };

function chunked(text, size = 7) {
  const bytes = Buffer.from(text); let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset + size)); offset += size;
  } });
}

function event(type, data) { return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`; }

function message(usage = undefined) {
  return { id: 'msg-mock', type: 'message', role: 'assistant', model: WITH_MODEL.upstream,
    content: [{ type: 'text', text: 'Mock response' }], stop_reason: 'end_turn', usage };
}

function localFetch(address, options = {}) {
  // Node's fetch may replace Host. Native HTTP preserves the explicit allowlist test target.
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method: options.method || 'GET', headers: options.headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])),
      })));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

async function fixture(t, request = async () => new Response(JSON.stringify(message()), {
  headers: { 'content-type': 'application/json' },
}), options = {}) {
  const records = [], calls = [];
  let statusCalls = 0;
  const provider = {
    status() { statusCalls++; return { authenticated: true, error: null, token: 'must-not-leak' }; },
    async request(params) { calls.push(params); return request(params); },
  };
  const server = createWithGatewayServer({ provider, gatewayKey: key, allowedHosts: [host],
    allowedPeers: ['127.0.0.1'], onUsage: async record => { records.push(record); }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path = '/v1/messages', body = modelBody, extra = {}) => localFetch(base + path, {
    method: 'POST', body: JSON.stringify(body), headers: authHeaders, ...extra,
  });
  return { base, send, server, gateway: server.gateway, records, calls, statusCalls: () => statusCalls };
}

test('dedicated authenticated health and model listing are read-only and expose only Opus 5.5', async t => {
  const { base, calls, statusCalls, gateway } = await fixture(t);
  const health = await localFetch(base + '/health', { headers: authHeaders });
  const status = await health.json();
  assert.equal(health.status, 200); assert.equal(status.ok, true);
  assert.deepEqual(status.provider, { authenticated: true, error: null });
  assert.equal(JSON.stringify(status).includes('must-not-leak'), false);
  const models = await localFetch(base + '/v1/models', { headers: { Host: host, Authorization: `Bearer ${key}` } });
  assert.deepEqual((await models.json()).data, [{ id: WITH_MODEL.id, type: 'model', display_name: WITH_MODEL.name }]);
  assert.equal(calls.length, 0); assert.equal(statusCalls(), 1);
  assert.equal(gateway.status().requests, 0);
});

test('missing, unrelated A/B, and conflicting credentials cannot reach the With provider', async t => {
  const { send, calls } = await fixture(t);
  for (const headers of [
    { Host: host },
    { Host: host, Authorization: 'Bearer account-a-b-credential' },
    { Host: host, 'x-api-key': 'account-a-b-key' },
    { ...authHeaders, Authorization: 'Bearer unrelated' },
  ]) {
    const response = await send('/v1/messages', modelBody, { headers });
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
  assert.equal(calls.length, 0);
});

test('CodeBuddy alias routes independently and its failure never falls back to With', async t => {
  const buddyModel = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' };
  const buddyCalls = [];
  const buddy = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true }),
    async request(params) {
      buddyCalls.push(params);
      const response = new Response(JSON.stringify(message()), { headers: { 'content-type': 'application/json' } });
      response.bridgeModel = 'actual-opus-id-from-catalog';
      return response;
    } };
  const { send, base, calls, records, gateway } = await fixture(t, undefined, {
    additionalRoutes: [{ account: 'CodeBuddy', model: buddyModel, provider: buddy }],
  });
  const catalog = await localFetch(base + '/v1/models', { headers: authHeaders });
  assert.deepEqual((await catalog.json()).data.map(model => model.id), [WITH_MODEL.id, buddyModel.id]);
  assert.equal((await send('/v1/messages', { ...modelBody, model: buddyModel.id })).status, 200);
  assert.equal(calls.length, 0); assert.equal(buddyCalls.length, 1);
  assert.equal(buddyCalls[0].body.model, buddyModel.id);
  assert.equal(records[0].account, 'CodeBuddy');
  assert.equal(records[0].upstreamModel, 'actual-opus-id-from-catalog');
  assert.equal(gateway.status('CodeBuddy').completed, 1);
  assert.equal(gateway.status().requests, 0);
  buddy.request = async () => { throw new Error('CodeBuddy unavailable'); };
  assert.equal((await send('/v1/messages', { ...modelBody, model: buddyModel.id })).status, 502);
  assert.equal(calls.length, 0);
  assert.equal(gateway.status('CodeBuddy').failed, 1);
});

test('unverified CodeBuddy model stays out of the catalog and health exposes no credentials', async t => {
  const buddy = { status: async () => ({ authenticated: false, ready: false, modelAvailable: false, token: 'private-must-not-leak' }),
    request: async () => { throw new Error('not_authenticated'); } };
  const { base } = await fixture(t, undefined, { additionalRoutes: [{ account: 'CodeBuddy',
    model: { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' }, provider: buddy }] });
  const catalog = await localFetch(base + '/v1/models', { headers: authHeaders });
  assert.deepEqual((await catalog.json()).data.map(model => model.id), [WITH_MODEL.id]);
  const health = await localFetch(base + '/health', { headers: authHeaders });
  const metadata = await health.json();
  assert.equal(metadata.providers.CodeBuddy.authenticated, false);
  assert.equal(JSON.stringify(metadata).includes('private-must-not-leak'), false);
});

test('CodeBuddy-only health and catalog use only its route and reject the paused With model without fallback', async t => {
  const model = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' };
  const buddyCalls = [];
  const buddy = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true, privateToken: 'must-not-leak' }),
    request: async params => { buddyCalls.push(params); return Response.json(message()); } };
  const { base, send, calls, statusCalls, records, gateway } = await fixture(t, undefined, {
    withEnabled: false, additionalRoutes: [{ account: 'CodeBuddy', model, provider: buddy }],
  });
  const health = await localFetch(base + '/health', { headers: authHeaders });
  const metadata = await health.json();
  assert.equal(metadata.ok, true); assert.equal(metadata.model, model.id);
  assert.deepEqual(Object.keys(metadata.providers), ['CodeBuddy']);
  assert.equal(metadata.providers.CodeBuddy.ready, true);
  assert.deepEqual(metadata.provider, metadata.providers.CodeBuddy);
  assert.equal(JSON.stringify(metadata).includes('must-not-leak'), false);
  const catalog = await localFetch(base + '/v1/models', { headers: authHeaders });
  assert.deepEqual((await catalog.json()).data.map(item => item.id), [model.id]);
  assert.equal((await send()).status, 400, 'The paused With alias cannot reach any provider.');
  assert.equal(buddyCalls.length, 0); assert.equal(calls.length, 0); assert.equal(statusCalls(), 0);
  assert.equal((await send('/v1/messages', { ...modelBody, model: model.id })).status, 200);
  assert.equal(buddyCalls.length, 1); assert.equal(calls.length, 0); assert.equal(statusCalls(), 0);
  assert.equal(records[0].account, 'CodeBuddy'); assert.equal(gateway.status().completed, 1);
  assert.equal(gateway.status('With').requests, 0);
});

test('CodeBuddy-only returns a safe empty catalog when the channel or every route is unavailable', async t => {
  for (const additionalRoutes of [[], [{ account: 'CodeBuddy', model: { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy' },
    provider: { status: async () => ({ authenticated: false, ready: false, modelAvailable: false }),
      request: async () => { throw new Error('must not infer'); } } }]]) {
    const { base, calls, statusCalls } = await fixture(t, undefined, { withEnabled: false, provider: undefined, additionalRoutes });
    const catalog = await localFetch(base + '/v1/models', { headers: authHeaders });
    assert.deepEqual(await catalog.json(), { data: [], has_more: false, first_id: null, last_id: null });
    const health = await localFetch(base + '/health', { headers: authHeaders });
    const metadata = await health.json();
    assert.equal(metadata.ok, false); assert.equal(Object.hasOwn(metadata.providers, 'With'), false);
    assert.equal(calls.length, 0); assert.equal(statusCalls(), 0);
  }
});

test('CodeBuddy-only retains exact Host, real Peer, and dedicated key authorization', async t => {
  const model = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy' };
  let reads = 0;
  const buddy = { status: async () => { reads++; return { authenticated: true, ready: true, modelAvailable: true }; },
    request: async () => { throw new Error('must not infer'); } };
  const options = { withEnabled: false, allowedHosts: [host, '127.0.0.1:43157'],
    additionalRoutes: [{ account: 'CodeBuddy', model, provider: buddy }] };
  const normal = await fixture(t, undefined, options);
  const accepted = await localFetch(normal.base + '/health', { headers: { Host: '127.0.0.1:43157', 'x-api-key': key } });
  assert.equal(accepted.status, 200); assert.equal(reads, 1);
  for (const [headers, status] of [[{ Host: '127.0.0.1:43158', 'x-api-key': key }, 403],
    [{ Host: '127.0.0.1:43157', 'x-api-key': 'unrelated-a-b-key' }, 401]]) {
    assert.equal((await localFetch(normal.base + '/health', { headers })).status, status);
  }
  const blocked = await fixture(t, undefined, { ...options, allowedPeers: ['192.168.168.10'] });
  assert.equal((await localFetch(blocked.base + '/health', { headers: {
    Host: '127.0.0.1:43157', 'x-api-key': key, 'x-forwarded-for': '192.168.168.10',
  } })).status, 403);
  assert.equal(reads, 1, 'Rejected metadata requests must not touch any provider.');
});

test('the paused With alias cannot be registered as an additional CodeBuddy route', () => {
  const provider = { status: async () => ({ authenticated: true }), request: async () => { throw new Error('must not infer'); } };
  assert.throws(() => createWithGatewayServer({ withEnabled: false, gatewayKey: key,
    additionalRoutes: [{ account: 'CodeBuddy', model: WITH_MODEL, provider }] }), /Invalid additional VM model route/);
  assert.throws(() => createWithGatewayServer({ gatewayKey: key }), /With provider request\(\) and status\(\) are required/);
});

test('Host is exact and forwarded peer headers cannot bypass the peer allowlist', async t => {
  const normal = await fixture(t);
  for (const badHost of ['evil.example', '192.168.168.1', '192.168.168.1:43158', host + '.evil.example']) {
    const response = await normal.send('/v1/messages', modelBody, { headers: { ...authHeaders, Host: badHost } });
    assert.equal(response.status, 403); await response.arrayBuffer();
  }
  const blocked = await fixture(t, undefined, { allowedPeers: ['192.168.168.10'] });
  const response = await blocked.send('/v1/messages', modelBody, { headers: {
    ...authHeaders, 'X-Forwarded-For': '192.168.168.10', 'X-Real-IP': '192.168.168.10',
  } });
  assert.equal(response.status, 403); await response.arrayBuffer();
  assert.equal(normal.calls.length, 0); assert.equal(blocked.calls.length, 0);
});

test('only the four routes and their methods are available', async t => {
  const { base, send, calls } = await fixture(t);
  for (const path of ['/v1/responses', '/v1/chat/completions', '/invoke', '/v1/messages/other']) {
    const response = await send(path);
    assert.equal(response.status, 404); await response.arrayBuffer();
  }
  for (const [path, method] of [['/health', 'POST'], ['/v1/models', 'POST'], ['/v1/messages', 'GET'], ['/v1/messages/count_tokens', 'GET']]) {
    const response = await localFetch(base + path, { method, headers: authHeaders });
    assert.equal(response.status, 405); await response.arrayBuffer();
  }
  assert.equal(calls.length, 0);
});

test('all other model names are rejected without fallback', async t => {
  const { send, calls, records } = await fixture(t);
  for (const model of ['claude-opus-5.5', 'claude-sonnet-5', 'gpt-6-astra', '', null, undefined]) {
    const response = await send('/v1/messages', { ...modelBody, model });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /仅支持模型/);
  }
  assert.equal(calls.length, 0); assert.equal(records.length, 0);
});

test('JSON forwards tools and messages intact, maps only the model, and records normalized usage once', async t => {
  const rawUsage = { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2,
    output_tokens: 4, output_tokens_details: { reasoning_tokens: 3 } };
  const upstream = JSON.stringify(message(rawUsage));
  const { send, calls, records, gateway } = await fixture(t, async () => new Response(upstream, { headers: {
    'content-type': 'application/json', 'request-id': 'upstream-request',
    'set-cookie': 'private=never-forward', 'anthropic-ratelimit-input-tokens-remaining': '100',
  } }));
  const body = { ...modelBody, tools: [{ name: 'read_file', description: 'Read on client', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-one', content: '中文工具结果' }] }],
    system: [{ type: 'text', text: 'Preserve instructions', cache_control: { type: 'ephemeral' } }] };
  const response = await send('/v1/messages', body, { headers: {
    ...authHeaders, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta',
    Cookie: 'account-a-private=must-not-forward', 'ChatGPT-Account-ID': 'account-a',
  } });
  assert.equal(response.status, 200); assert.equal(await response.text(), upstream);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('request-id'), 'upstream-request');
  assert.equal(response.headers.get('anthropic-ratelimit-input-tokens-remaining'), '100');
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/v1/messages');
  assert.deepEqual(calls[0].body, { ...body, model: WITH_MODEL.upstream });
  assert.ok(calls[0].headers instanceof Headers);
  assert.equal(calls[0].headers.get('anthropic-beta'), 'test-beta');
  for (const header of ['authorization', 'x-api-key', 'cookie', 'chatgpt-account-id', 'host']) {
    assert.equal(calls[0].headers.get(header), null);
  }
  assert.equal(records.length, 1); assert.equal(records[0].account, 'With');
  assert.equal(records[0].model, WITH_MODEL.id); assert.equal(records[0].upstreamModel, WITH_MODEL.upstream);
  assert.equal(records[0].status, 'completed');
  assert.deepEqual(records[0].usage, {
    input_tokens: 10, output_tokens: 4, total_tokens: 14,
    input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
  });
  assert.equal(gateway.status().completed, 1); assert.equal(gateway.status().active, 0);
});

test('SSE bytes are transparent and start/delta usage is cumulative rather than added repeatedly', async t => {
  const wire = event('message_start', { message: { id: 'msg-stream', usage: {
    input_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 0, output_tokens: 1,
  } } }) + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } }) +
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"中文.txt"}' } }) +
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }) +
    event('message_delta', { delta: {}, usage: { output_tokens: 9 } }) + event('message_stop', {}) + event('message_stop', {});
  const { send, records, gateway } = await fixture(t, async () => new Response(chunked(wire, 1), {
    headers: { 'content-type': 'text/event-stream' },
  }));
  const response = await send('/v1/messages', { ...modelBody, stream: true });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(wire));
  assert.equal(records.length, 1); assert.equal(records[0].responseId, 'msg-stream');
  assert.equal(records[0].usage.input_tokens, 10); assert.equal(records[0].usage.output_tokens, 9);
  assert.equal(records[0].usage.total_tokens, 19); assert.equal(records[0].status, 'completed');
  assert.equal(gateway.status().requests, 1); assert.equal(gateway.status().completed, 1);
});

test('unknown counts remain null, explicit zero survives, and reasoning is already part of output', () => {
  assert.equal(normalizeAnthropicUsage(null), null);
  assert.equal(normalizeAnthropicUsage({}), null);
  const partial = normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 4, reasoning_tokens: 2 });
  assert.equal(partial.input_tokens, null); assert.equal(partial.total_tokens, null);
  assert.equal(partial.input_tokens_details.cached_tokens, null);
  assert.equal(partial.input_tokens_details.cache_write_tokens, null);
  assert.equal(partial.output_tokens, 4); assert.equal(partial.output_tokens_details.reasoning_tokens, 2);
  assert.deepEqual(normalizeAnthropicUsage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }), {
    input_tokens: 0, output_tokens: 0, total_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: null },
  });
});

test('missing JSON usage is recorded once as unknown instead of estimated', async t => {
  const { send, records } = await fixture(t);
  const response = await send(); await response.arrayBuffer();
  assert.equal(records.length, 1); assert.equal(records[0].usage, null);
  assert.equal(records[0].status, 'completed');
});

test('trusted bridgeUsage overrides placeholder stream counts without adding cache twice', async t => {
  const wire = event('message_start', { message: { id: 'msg-bridge', usage: {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  } } }) + event('message_delta', { usage: { output_tokens: 0 } }) + event('message_stop', {});
  const { send, records, gateway } = await fixture(t, async () => {
    const response = new Response(chunked(wire), { headers: { 'content-type': 'text/event-stream' } });
    response.bridgeUsage = Promise.resolve({ input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 12 } });
    return response;
  });
  const response = await send('/v1/messages', { ...modelBody, stream: true });
  assert.equal(await response.text(), wire);
  assert.equal(records.length, 1); assert.equal(records[0].usage.input_tokens, 100);
  assert.equal(records[0].usage.total_tokens, 120);
  assert.equal(records[0].usage.input_tokens_details.cached_tokens, 80);
  assert.equal(records[0].usage.output_tokens_details.reasoning_tokens, 12);
  assert.equal(gateway.status().usageError, null);
});

test('null or rejected bridgeUsage stays unknown and never uses placeholder zero usage', async t => {
  for (const rejected of [false, true]) {
    const wire = event('message_start', { message: { id: 'msg-unknown', usage: {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } } }) + event('message_stop', {});
    const { send, records, gateway } = await fixture(t, async () => {
      const response = new Response(chunked(wire), { headers: { 'content-type': 'text/event-stream' } });
      response.bridgeUsage = rejected ? Promise.reject(new Error(`usage failed ${key}`)) : Promise.resolve(null);
      return response;
    });
    const response = await send('/v1/messages', { ...modelBody, stream: true });
    assert.equal(await response.text(), wire);
    assert.equal(records.length, 1); assert.equal(records[0].usage, null);
    assert.equal(records[0].status, 'completed'); assert.equal(gateway.status().completed, 1);
    assert.equal(Boolean(gateway.status().usageError), rejected);
    if (rejected) assert.equal(gateway.status().usageError.includes(key), false);
  }
});

test('count_tokens is forwarded without an inference record or counters', async t => {
  const { send, records, calls, gateway } = await fixture(t, async () => new Response('{"input_tokens":42}', {
    headers: { 'content-type': 'application/json' },
  }));
  const response = await send('/v1/messages/count_tokens');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { input_tokens: 42 });
  assert.equal(calls[0].path, '/v1/messages/count_tokens'); assert.equal(calls[0].body.model, WITH_MODEL.upstream);
  assert.equal(records.length, 0); assert.equal(gateway.status().requests, 0); assert.equal(gateway.status().active, 0);
});

test('unsupported upstream token counting returns 501 with one call and no estimate', async t => {
  for (const status of [404, 405, 501]) {
    const { send, records, calls, gateway } = await fixture(t, async () => new Response('unsupported', { status }));
    const response = await send('/v1/messages/count_tokens');
    assert.equal(response.status, 501);
    assert.match((await response.json()).error.message, /未提供 Token 计数接口/);
    assert.equal(calls.length, 1); assert.equal(records.length, 0); assert.equal(gateway.status().requests, 0);
  }
});

test('upstream auth errors pass through without retry or fallback', async t => {
  const { send, calls, records, gateway } = await fixture(t, async () => new Response('{"type":"error","error":{"message":"auth failed"}}', {
    status: 401, headers: { 'content-type': 'application/json' },
  }));
  const response = await send(); assert.equal(response.status, 401); await response.arrayBuffer();
  assert.equal(calls.length, 1); assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed'); assert.equal(gateway.status().failed, 1);
});

test('an incomplete or errored SSE is not counted as completed', async t => {
  for (const suffix of ['', event('error', { error: { message: 'mock upstream error' } }) + event('message_stop', {})]) {
    const wire = event('message_start', { message: { id: 'msg-incomplete', usage: {
      input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
    } } }) + suffix;
    const { send, records, gateway } = await fixture(t, async () => new Response(chunked(wire), {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const response = await send('/v1/messages', { ...modelBody, stream: true }); await response.arrayBuffer();
    assert.equal(records.length, 1); assert.equal(records[0].status, 'failed');
    assert.equal(gateway.status().completed, 0); assert.equal(gateway.status().failed, 1);
  }
});

test('client disconnect aborts provider work and records one interrupted message', async t => {
  let aborted, recorded;
  const sawAbort = new Promise(resolve => { aborted = resolve; });
  const sawRecord = new Promise(resolve => { recorded = resolve; });
  let cancelled = false;
  const { base, records, gateway } = await fixture(t, async ({ signal }) => {
    signal.addEventListener('abort', () => { aborted(); }, { once: true });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(event('message_start', { message: { id: 'msg-cancel', usage: {
          input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0,
        } } })));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }, { onUsage: async record => { records.push(record); recorded(); } });
  const request = http.request(base + '/v1/messages', { method: 'POST', headers: authHeaders });
  request.on('error', () => {});
  request.end(JSON.stringify({ ...modelBody, stream: true }));
  const [response] = await once(request, 'response');
  response.once('data', () => { response.destroy(); });
  response.resume();
  await Promise.race([
    Promise.all([sawAbort, sawRecord]),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('disconnect was not propagated')), 2000); timer.unref(); }),
  ]);
  assert.equal(cancelled, true); assert.equal(records.length, 1);
  assert.equal(records[0].status, 'interrupted'); assert.equal(records[0].usage.input_tokens, 3);
  assert.equal(gateway.status().active, 0); assert.equal(gateway.status().failed, 1);
});

test('provider exceptions and ledger failures are sanitized without leaking the dedicated key', async t => {
  const failed = await fixture(t, async () => { throw new Error(`provider failed: ${key}`); });
  const response = await failed.send(); assert.equal(response.status, 502);
  assert.equal((await response.text()).includes(key), false);
  assert.equal(failed.records.length, 1); assert.equal(failed.records[0].usage, null);
  assert.equal(failed.gateway.status().active, 0); assert.equal(failed.gateway.status().failed, 1);
  const ledger = await fixture(t, undefined, { onUsage: async () => { throw new Error(`ledger failed ${key}`); } });
  const valid = await ledger.send(); assert.equal(valid.status, 200); await valid.arrayBuffer();
  assert.equal(ledger.gateway.status().completed, 1);
  assert.equal(ledger.gateway.status().usageError.includes(key), false);
});
