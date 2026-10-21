import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AnthropicGateway, createAnthropicGatewayServer } from '../src/anthropic-gateway.mjs';

const gatewayKey = 'independent-anthropic-gateway-test-key';
const gatewayHost = 'custom-gateway.example:46321';
const requestHeaders = { Host: gatewayHost, 'x-api-key': gatewayKey, 'content-type': 'application/json' };
const firstModel = { id: 'example-opus', name: 'Example Opus', upstream: 'vendor-opus-id' };
const secondModel = { id: 'other-opus', name: 'Other Opus' };

function providerFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    status: async () => ({ authenticated: true, ready: true, modelAvailable: true }),
    request: async params => {
      calls.push(params);
      if (params.path.startsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 5 });
      return Response.json({ id: 'msg-example', type: 'message', role: 'assistant', model: params.body.model,
        content: [{ type: 'text', text: 'Mock only' }], stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    },
    ...overrides,
  };
}

function localRequest(address, { method = 'POST', headers = requestHeaders, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers,
      })));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function gatewayFixture(t, routes, options = {}) {
  const records = [];
  const server = createAnthropicGatewayServer({ routes, gatewayKey, allowedHosts: [gatewayHost],
    allowedPeers: ['127.0.0.1'], onUsage: async record => { records.push(record); }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { gateway: server.gateway, records,
    send: (path, body, extra = {}) => localRequest(baseUrl + path, {
      body: typeof body === 'string' ? body : JSON.stringify(body), ...extra,
    }) };
}

test('arbitrary provider names and multiple models share account usage with exact routes', async t => {
  const first = providerFixture(), second = providerFixture();
  const thirdModel = { id: 'example-sonnet', name: 'Example Sonnet' };
  const { gateway, send, records } = await gatewayFixture(t, [
    { account: 'Example', model: firstModel, provider: first },
    { account: 'Example', model: thirdModel, provider: first },
    { account: 'Another vendor', model: secondModel, provider: second },
  ]);
  const catalog = await send('/v1/models', undefined, { method: 'GET' });
  assert.deepEqual((await catalog.json()).data.map(model => model.id), [firstModel.id, thirdModel.id, secondModel.id]);
  for (const model of [firstModel.id, thirdModel.id, secondModel.id]) {
    assert.equal((await send('/v1/messages', { model, messages: [] })).status, 200);
  }
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls[0].body.model, firstModel.upstream);
  assert.equal(first.calls[1].body.model, thirdModel.id);
  assert.equal(gateway.status('Example').completed, 2);
  assert.equal(gateway.status('Another vendor').completed, 1);
  assert.deepEqual(records.map(record => record.account), ['Example', 'Example', 'Another vendor']);
  const snapshot = gateway.status('Example'); snapshot.requests = 999;
  assert.equal(gateway.status('Example').requests, 2);
});

test('provider receives original JSON bytes and only allowlisted business headers', async t => {
  const provider = providerFixture();
  const { send } = await gatewayFixture(t, [{ account: 'Native', model: firstModel, provider }]);
  const rawBody = ' {\n "model" : "example-opus", "large" : 9007199254740993, "negativeZero": -0, "exponent": 1e+3, "messages":[{"role":"user","content":"中文"}], "future_block":{"type":"new"} }\n';
  const response = await send('/v1/messages?example=kept', rawBody, { headers: {
    ...requestHeaders, Authorization: `Bearer ${gatewayKey}`, Cookie: 'private=not-upstream',
    'ChatGPT-Account-ID': 'private-account', 'X-Forwarded-For': 'spoofed',
    'X-Account-Bridge-Key': 'different-route-key', 'Anthropic-Beta': 'example-beta',
    'Anthropic-Version': '2023-06-01', 'X-Client-Request-Id': 'client-request',
    'X-Claude-Code-Session-Id': 'original-session', 'X-Claude-Code-Agent-Id': 'original-agent',
  } });
  assert.equal(response.status, 200);
  const forwarded = provider.calls[0];
  assert.equal(forwarded.path, '/v1/messages?example=kept');
  assert.ok(Buffer.isBuffer(forwarded.rawBody));
  assert.deepEqual(forwarded.rawBody, Buffer.from(rawBody));
  assert.equal(forwarded.body.model, firstModel.upstream);
  assert.deepEqual(forwarded.body.messages, [{ role: 'user', content: '中文' }]);
  assert.deepEqual(forwarded.body.future_block, { type: 'new' });
  assert.equal(forwarded.headers.get('anthropic-beta'), 'example-beta');
  assert.equal(forwarded.headers.get('x-client-request-id'), 'client-request');
  assert.equal(forwarded.headers.get('x-claude-code-session-id'), 'original-session');
  assert.equal(forwarded.headers.get('x-claude-code-agent-id'), 'original-agent');
  for (const header of ['authorization', 'x-api-key', 'cookie', 'chatgpt-account-id',
    'x-forwarded-for', 'x-account-bridge-key', 'host']) assert.equal(forwarded.headers.get(header), null);
});

test('unknown model, invalid JSON and compressed bodies fail before any provider request', async t => {
  const provider = providerFixture();
  const { send, records } = await gatewayFixture(t, [{ account: 'Example', model: firstModel, provider }]);
  for (const model of ['Example-opus', 'example-opus-extra', secondModel.id, null, {}]) {
    assert.equal((await send('/v1/messages', { model, messages: [] })).status, 400);
  }
  assert.equal((await send('/v1/messages', '{invalid-json')).status, 400);
  assert.equal((await send('/v1/messages', { model: firstModel.id }, {
    headers: { ...requestHeaders, 'content-encoding': 'gzip' },
  })).status, 415);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(records, []);
});

test('provider failure stays on its selected route without retry or fallback', async t => {
  let failures = 0;
  const failing = providerFixture({ request: async () => { failures++; throw new Error('mock route unavailable'); } });
  const other = providerFixture();
  const { send, gateway, records } = await gatewayFixture(t, [
    { account: 'Unavailable', model: firstModel, provider: failing },
    { account: 'Other', model: secondModel, provider: other },
  ]);
  const response = await send('/v1/messages', { model: firstModel.id, messages: [] });
  assert.equal(response.status, 502);
  assert.equal(failures, 1); assert.equal(other.calls.length, 0);
  assert.equal(gateway.status('Unavailable').failed, 1);
  assert.equal(gateway.status('Other').requests, 0);
  assert.equal(records.length, 1); assert.equal(records[0].account, 'Unavailable');
});

test('model discovery requires provider availability and health exposes only safe metadata', async t => {
  const available = providerFixture({ status: async () => ({ authenticated: true, ready: true,
    modelAvailable: true, token: 'must-not-leak' }) });
  const unavailable = providerFixture({ status: async () => ({ authenticated: false, ready: false,
    modelAvailable: false, error: `provider rejected ${gatewayKey}`, token: 'private-token' }) });
  const { send } = await gatewayFixture(t, [
    { account: '__proto__', model: firstModel, provider: available },
    { account: 'Unavailable', model: secondModel, provider: unavailable },
  ]);
  const catalog = await send('/v1/models', undefined, { method: 'GET' });
  assert.deepEqual((await catalog.json()).data.map(model => model.id), [firstModel.id]);
  const health = await send('/health', undefined, { method: 'GET' });
  const metadata = await health.json();
  assert.equal(metadata.ok, true);
  assert.equal(Object.hasOwn(metadata.providers, '__proto__'), true);
  assert.deepEqual(metadata.providers.__proto__, { authenticated: true, ready: true, modelAvailable: true, error: null });
  assert.equal(metadata.providers.Unavailable.authenticated, false);
  assert.equal(JSON.stringify(metadata).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(metadata).includes('private-token'), false);
  assert.equal(JSON.stringify(metadata).includes(gatewayKey), false);
  assert.equal(available.calls.length, 0); assert.equal(unavailable.calls.length, 0);
});

for (const availableFirst of [true, false]) {
  test(`health aggregates shared-account models with ${availableFirst ? 'available' : 'unavailable'} primary`, async t => {
    const available = providerFixture({ status: async () => ({ authenticated: null, ready: true, modelAvailable: true }) });
    const unavailable = providerFixture({ status: async () => ({ authenticated: null, ready: false,
      modelAvailable: false, error: 'Fixture model unavailable.' }) });
    const { send, records } = await gatewayFixture(t, [
      { account: 'Claude', model: firstModel, provider: availableFirst ? available : unavailable },
      { account: 'Claude', model: secondModel, provider: availableFirst ? unavailable : available },
    ]);
    const catalog = await send('/v1/models', undefined, { method: 'GET' });
    assert.deepEqual((await catalog.json()).data.map(model => model.id), [availableFirst ? firstModel.id : secondModel.id]);
    const response = await send('/health', undefined, { method: 'GET' });
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.model, firstModel.id);
    assert.deepEqual(health.provider, { authenticated: null, ready: availableFirst, modelAvailable: availableFirst,
      error: availableFirst ? null : 'Fixture model unavailable.' });
    assert.deepEqual(health.providers.Claude, { authenticated: null, ready: true, modelAvailable: true, error: null });
    assert.equal(available.calls.length, 0);
    assert.equal(unavailable.calls.length, 0);
    assert.deepEqual(records, []);
  });
}

test('generic access requires explicit real peer, exact Host and dedicated key', () => {
  const provider = providerFixture();
  const routes = [{ account: 'Example', model: firstModel, provider }];
  const gateway = new AnthropicGateway({ routes, gatewayKey, allowedHosts: [gatewayHost], allowedPeers: ['127.0.0.1'] });
  const makeRequest = ({ peer = '127.0.0.1', host = gatewayHost, headers = {} } = {}) => ({
    socket: { remoteAddress: peer }, rawHeaders: ['Host', host], headers: {
      host, authorization: `Bearer ${gatewayKey}`, ...headers,
    },
  });
  assert.doesNotThrow(() => gateway.authorize(makeRequest()));
  assert.doesNotThrow(() => gateway.authorize(makeRequest({ peer: '::ffff:127.0.0.1' })));
  assert.throws(() => gateway.authorize(makeRequest({ peer: '192.0.2.5',
    headers: { 'x-forwarded-for': '127.0.0.1' } })), error => error.code === 'anthropic_peer_denied');
  assert.throws(() => gateway.authorize(makeRequest({ host: 'custom-gateway.example:46322' })),
    error => error.code === 'anthropic_host_denied');
  assert.throws(() => gateway.authorize(makeRequest({ headers: { 'x-api-key': 'unrelated-key' } })),
    error => error.code === 'anthropic_invalid_gateway_key');
  const duplicate = makeRequest(); duplicate.rawHeaders.push('Host', gatewayHost);
  assert.throws(() => gateway.authorize(duplicate), error => error.code === 'anthropic_host_denied');
  const unconfigured = new AnthropicGateway({ routes, gatewayKey });
  assert.throws(() => unconfigured.authorize(makeRequest()), error => error.code === 'anthropic_peer_denied');
  assert.equal(provider.calls.length, 0);
});

test('token counts use exact selected route and preserve bytes without usage records', async t => {
  const provider = providerFixture();
  const { send, gateway, records } = await gatewayFixture(t, [{ account: 'Example', model: firstModel, provider }]);
  const body = '{ "model":"example-opus", "messages":[], "system":"Preserve" }';
  const response = await send('/v1/messages/count_tokens', body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { input_tokens: 5 });
  assert.deepEqual(provider.calls[0].rawBody, Buffer.from(body));
  assert.equal(provider.calls[0].body.model, firstModel.upstream);
  assert.equal(gateway.status('Example').requests, 0);
  assert.deepEqual(records, []);
});

test('duplicate models and invalid route contracts fail during construction', () => {
  const provider = providerFixture();
  const route = { account: 'Example', model: firstModel, provider };
  for (const routes of [null, [route, { ...route, account: 'Other' }], [{ ...route, account: '' }],
    [{ ...route, model: { id: firstModel.id } }], [{ ...route, model: { ...firstModel, upstream: '' } }],
    [{ ...route, provider: { request() {} } }]]) {
    assert.throws(() => new AnthropicGateway({ routes, gatewayKey }), TypeError);
  }
  assert.throws(() => new AnthropicGateway({ routes: [route], gatewayKey, allowedHosts: gatewayHost }), TypeError);
  assert.throws(() => new AnthropicGateway({ routes: [route], gatewayKey, allowedPeers: '127.0.0.1' }), TypeError);
});
