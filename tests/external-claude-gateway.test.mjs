import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createExternalClaudeGateway, validateExternalClients, validateExternalAuthorities } from '../src/external-claude-gateway.mjs';

const localKey = 'local-private-fixture-'.repeat(3), sessionKey = 'namespace-fixture-'.repeat(3);
const aliceKey = 'external-alice-fixture-'.repeat(3), bobKey = 'external-bob-fixture-'.repeat(3);
const client = (id, value, extra = {}) => ({ id, keySha256: createHash('sha256').update(value).digest('hex'),
  maxConcurrent: 2, requestsPerMinute: 30, ...extra });

async function fixture(t, { fetchImpl = async () => Response.json({ data: [] }), clients,
  getClients, ...options } = {}) {
  const server = createExternalClaudeGateway({ gatewayKey: localKey, sessionKey,
    getClients: getClients ?? (() => clients ?? [client('alice', aliceKey), client('bob', bobKey)]),
    allowedHosts: ['fixture'], fetchImpl, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const send = (path = '/v1/models', { body, key = aliceKey, headers, ...options } = {}) => new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${server.address().port}${path}`, {
      ...options, headers: { host: 'fixture', authorization: `Bearer ${key}`, ...headers },
    }, response => resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })));
    request.on('error', reject); request.end(body);
  });
  return { server, send };
}

test('remote keys and cookies are replaced before calling the fixed local gateway', async t => {
  let seen;
  const { send } = await fixture(t, { fetchImpl: async (url, options) => {
    seen = { url, options }; return Response.json({ data: [] }, { headers: { 'set-cookie': 'private=secret' } });
  } });
  const response = await send('/v1/models', { headers: { cookie: 'private-cookie', 'x-api-key': aliceKey,
    'x-forwarded-for': 'private-ip', 'x-claude-code-agent-id': 'forged-agent' } });
  assert.equal(response.status, 200); await response.json();
  assert.equal(seen.url, 'http://127.0.0.1:43157/v1/models');
  assert.equal(seen.options.headers.get('authorization'), `Bearer ${localKey}`);
  for (const name of ['cookie', 'x-api-key', 'x-forwarded-for', 'x-claude-code-agent-id']) assert.equal(seen.options.headers.get(name), null);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('account reads never enter the legacy private-key route and expose safe ingress-specific error codes', async t => {
  let calls = 0;
  const { send } = await fixture(t, { fetchImpl: async () => { calls++; return Response.json({}); } });
  const legacy = await send('/v1/account');
  assert.equal(legacy.status, 401); assert.equal((await legacy.json()).error.code, 'external_personal_key_required');
  const unavailable = await send('/v1/account', { key: 'bfk_' + 'x'.repeat(43) });
  assert.equal(unavailable.status, 404); assert.equal((await unavailable.json()).error.code, 'external_account_route_unavailable');
  const missing = await send('/api/admin');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'external_route_not_found');
  const wrongMethod = await send('/v1/models', { method: 'POST' });
  assert.equal(wrongMethod.status, 405); assert.equal((await wrongMethod.json()).error.code, 'external_method_not_allowed');
  assert.equal(calls, 0);
});

test('agent SDK tracing headers fit ingress without being forwarded or bypassing authentication', async t => {
  let calls = 0;
  const headers = Object.fromEntries(Array.from({ length: 48 }, (_, index) => [`x-client-trace-${index}`, 'trace']));
  const { send } = await fixture(t, { fetchImpl: async (_url, options) => {
    calls++;
    assert.equal([...options.headers.keys()].some(name => name.startsWith('x-client-trace-')), false);
    return Response.json({ data: [] });
  } });
  assert.equal((await send('/v1/models', { headers })).status, 200);
  assert.equal((await send('/v1/models', { headers, key: 'invalid' })).status, 401);
  assert.equal((await send('/v1/models', { headers: { ...headers, authorization: [`Bearer ${aliceKey}`, `Bearer ${aliceKey}`] } })).status, 400);
  assert.equal((await send('/v1/models', { headers: { ...headers, 'x-oversized': 'x'.repeat(16_384) } })).status, 431);
  assert.equal(calls, 1);
});

test('matching attacker-controlled sessions cannot share identities across clients', async t => {
  const sessions = [];
  const { send } = await fixture(t, { fetchImpl: async (_url, options) => {
    sessions.push(options.headers.get('x-session-id')); return Response.json({ data: [] });
  } });
  for (const key of [aliceKey, bobKey, aliceKey]) {
    await (await send('/v1/models', { key, headers: { 'x-session-id': 'same-session', 'x-conversation-id': 'forged' } })).json();
  }
  assert.match(sessions[0], /^external-[a-f0-9]{64}$/);
  assert.notEqual(sessions[0], sessions[1]); assert.equal(sessions[0], sessions[2]);
  assert.ok(sessions.every(value => !value.includes('same-session')));
});

test('authentication, hosts, browser origins, paths and methods fail before forwarding', async t => {
  let calls = 0;
  const { send } = await fixture(t, { fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const [path, options, status] of [
    ['/v1/models', { key: 'bad' }, 401],
    ['/v1/models', { key: localKey }, 401],
    ['/v1/models', { headers: { 'x-api-key': bobKey } }, 401],
    ['/v1/models', { headers: { host: 'external.invalid' } }, 403],
    ['/v1/models', { headers: { origin: 'https://external.invalid' } }, 403],
    ['/health', {}, 404], ['/api/admin', {}, 404], ['/v1/models?target=other', {}, 404],
    ['/account/v1/login', { method: 'POST', body: '{}' }, 404], ['/account/v1/me', {}, 404],
    ['/account/', {}, 404], ['/register', {}, 404],
    ['/v1/models', { method: 'POST' }, 405],
    ['/v1/messages', { method: 'POST', headers: { 'content-encoding': 'gzip' }, body: 'body' }, 415],
    ['/v1/models', { headers: { authorization: [`Bearer ${aliceKey}`, `Bearer ${aliceKey}`] } }, 400],
  ]) {
    const response = await send(path, options); assert.equal(response.status, status); await response.json();
  }
  assert.equal(calls, 0);
});

test('client revocation and unreadable credentials immediately deny new requests', async t => {
  let clients = [client('alice', aliceKey)], broken = false, calls = 0;
  const { send } = await fixture(t, { getClients: () => { if (broken) throw new Error('secret-path'); return clients; },
    fetchImpl: async () => { calls++; return Response.json({}); } });
  await (await send()).json(); clients = [];
  assert.equal((await send()).status, 401); broken = true;
  const response = await send(); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret-path/); assert.equal(calls, 1);
});

test('per-client rate limits reset while retaining independent quotas', async t => {
  let now = 0;
  const { send } = await fixture(t, { clients: [client('alice', aliceKey, { requestsPerMinute: 1 }), client('bob', bobKey)], clock: () => now });
  await (await send()).json();
  const rejected = await send(); assert.equal(rejected.status, 429); assert.equal(rejected.headers.get('retry-after'), '60'); await rejected.json();
  assert.equal((await send('/v1/models', { key: bobKey })).status, 200);
  now = 60_001; assert.equal((await send()).status, 200);
});

test('stream bytes are delivered before completion and concurrency is bounded until disconnect', async t => {
  let controller, canceled;
  const cancelSeen = new Promise(resolve => { canceled = resolve; });
  const { send } = await fixture(t, { clients: [client('alice', aliceKey, { maxConcurrent: 1 })],
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({ start(value) {
      controller = value;
      signal.addEventListener('abort', () => { value.error(new Error('aborted')); canceled(); }, { once: true });
      value.enqueue(new TextEncoder().encode('data: first\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await send(); const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  const busy = await send(); assert.equal(busy.status, 429); await busy.json();
  await reader.cancel(); await cancelSeen;
  assert.ok(controller);
});

test('body limits apply before the fixed gateway receives data', async t => {
  let calls = 0;
  const { send } = await fixture(t, { maxBodyBytes: 8,
    fetchImpl: async () => { calls++; return Response.json({}); } });
  const response = await send('/v1/messages', { method: 'POST', body: 'larger-than-eight-bytes' });
  assert.equal(response.status, 413); await response.json(); assert.equal(calls, 0);
});

test('redirects and upstream failure do not escape the fixed gateway', async t => {
  let redirect = true;
  const { send } = await fixture(t, { fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    if (redirect) return new Response(null, { status: 302, headers: { location: 'https://other.invalid' } });
    throw new Error('sensitive-key-or-address');
  } });
  assert.equal((await send()).status, 502); redirect = false;
  const response = await send(); assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive-key-or-address|other.invalid/);
});

test('the local gateway key cannot be configured as an external credential', async t => {
  const { send } = await fixture(t, { clients: [client('local', localKey)] });
  assert.equal((await send('/v1/models', { key: localKey })).status, 503);
});

test('client configuration rejects duplicate identities, keys and invalid limits', () => {
  for (const value of [null, [{}], [client(undefined, aliceKey)], [client('alice', aliceKey), client('alice', bobKey)],
    [client('alice', aliceKey), client('bob', aliceKey)], [client('alice', aliceKey, { maxConcurrent: 0 })],
    [client('alice', aliceKey, { requestsPerMinute: 0 })]]) assert.throws(() => validateExternalClients(value));
  assert.deepEqual(validateExternalClients([]), []);
});

test('public authority configuration cannot introduce wildcards, URLs, headers or invalid ports', () => {
  const valid = ['api.example.net:47846', 'gateway.example.net'];
  assert.deepEqual(validateExternalAuthorities(valid), valid);
  assert.deepEqual(validateExternalAuthorities(), []);
  for (const value of [null, 'api.example.net', [''], ['*.example.net'], ['https://api.example.net'],
    ['user@api.example.net'], ['api.example.net/path'], ['api.example.net\r\nx-injected: yes'],
    ['api.example.net:0'], ['api.example.net:65536'], ['api.example.net:0443'], ['127.0.0.1:43157'],
    ['localhost'], ['api..example.net'], ['-api.example.net'], ['API.example.net'],
    ['api.example.net', 'api.example.net'], Array.from({ length: 9 }, (_, i) => `api${i}.example.net`)]) {
    assert.throws(() => validateExternalAuthorities(value));
  }
});

test('preserved public authorities keep authentication and an explicit host and port whitelist', async t => {
  let calls = 0;
  const { send } = await fixture(t, { allowedHosts: ['gateway.example.net', 'api.example.net', 'api.example.net:47846'],
    fetchImpl: async url => { assert.equal(url, 'http://127.0.0.1:43157/v1/models'); calls++; return Response.json({ data: [] }); } });
  for (const [host, key, status] of [
    ['gateway.example.net', aliceKey, 200], ['api.example.net:47846', aliceKey, 200],
    ['api.example.net', aliceKey, 200], ['api.example.net:43157', aliceKey, 403],
    ['other.example.net:47846', aliceKey, 403], ['api.example.net:47846', bobKey + 'invalid', 401],
  ]) {
    const response = await send('/v1/models', { key, headers: { host } });
    assert.equal(response.status, status); await response.json();
  }
  assert.equal(calls, 3);
});

test('one client shares its quota across existing and additional public authorities', async t => {
  const { send } = await fixture(t, { allowedHosts: ['gateway.example.net', 'api.example.net:47846'],
    clients: [client('alice', aliceKey, { requestsPerMinute: 1 })] });
  const first = await send('/v1/models', { headers: { host: 'gateway.example.net' } });
  assert.equal(first.status, 200); await first.json();
  const second = await send('/v1/models', { headers: { host: 'api.example.net:47846' } });
  assert.equal(second.status, 429); await second.json();
});
