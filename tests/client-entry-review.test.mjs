import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createClientServer } from '../src/client-server.mjs';
import { ClientStateCodec } from '../src/client-state.mjs';

const accountId = '12345678-1234-1234-1234-123456789abc';
const key = `bfk_${'a'.repeat(43)}`;
const sessionToken = `bfs_${'b'.repeat(43)}`;
const model = 'B-gpt-6.1-sol';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, overrides = {}) {
  let enabled = true, allowedModels = [model], observed;
  const authenticationObserved = new Promise(resolve => { observed = resolve; });
  const calls = { inference: 0, createKey: 0 };
  const authenticate = () => {
    observed();
    return enabled ? { accountId, username: 'alice', allowedModels: [...allowedModels] } : null;
  };
  const access = { registrationPolicy: () => ({ mode: 'open', defaultKeyDays: 30 }),
    authenticateKey: authenticate, authenticateSession: authenticate,
    async createKey() { calls.createKey++; return { key: { id: 'fake-key' }, secret: key }; },
    ...overrides.access };
  const server = createClientServer({ access, publicDir: new URL('../public', import.meta.url).pathname,
    publicBaseUrl: 'http://client.example', allowedHosts: [], getModels: () => [{ id: model, channel: 'B', enabled: true, available: true }],
    csrfSecret: 'offline-test-csrf-secret'.repeat(4), requestResponses: async () => {
      calls.inference++; return Response.json({ id: 'resp_fake', status: 'completed', output: [] });
    }, ...overrides.server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  function start(path, authorization = key) {
    let response;
    const result = new Promise((resolve, reject) => {
      response = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
        host: 'client.example', 'content-type': 'application/json', authorization: `Bearer ${authorization}`,
      } }, incoming => {
        const chunks = []; incoming.on('data', value => chunks.push(value));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      response.on('error', reject);
    });
    return { request: response, result };
  }
  return { authenticationObserved, calls, start, disable() { enabled = false; }, removeModels() { allowedModels = []; }, server };
}

test('revoked Key cannot finish an admitted partial request and reach a model', async t => {
  const page = await fixture(t), pending = page.start('/v1/responses');
  pending.request.write(`{"model":"${model}","input":`);
  await page.authenticationObserved;
  page.disable(); pending.request.end('"hello"}');
  const result = await pending.result;
  assert.equal(result.status, 401);
  assert.equal(page.calls.inference, 0);
});

test('model grants removed during body upload apply before upstream forwarding', async t => {
  const page = await fixture(t), pending = page.start('/v1/responses');
  pending.request.write(`{"model":"${model}","input":`);
  await page.authenticationObserved;
  page.removeModels(); pending.request.end('"hello"}');
  const result = await pending.result;
  assert.equal(result.status, 403);
  assert.equal(page.calls.inference, 0);
});

test('revoked portal session cannot create another Key after a partial upload', async t => {
  const page = await fixture(t), pending = page.start('/portal/api/keys', sessionToken);
  pending.request.write('{"name":');
  await page.authenticationObserved;
  page.disable(); pending.request.end('"office","expiresInDays":30}');
  const result = await pending.result;
  assert.equal(result.status, 401);
  assert.equal(page.calls.createKey, 0);
});

test('inference concurrency includes requests still uploading their bodies', async t => {
  const page = await fixture(t, { server: { maxConcurrentPerAccount: 1, maxConcurrent: 1 } });
  const first = page.start('/v1/responses');
  first.request.write(`{"model":"${model}","input":`);
  await page.authenticationObserved; await nextTurn();
  const second = page.start('/v1/responses');
  second.request.end(JSON.stringify({ model, input: 'second' }));
  const denied = await second.result;
  assert.equal(denied.status, 429);
  assert.equal(page.calls.inference, 0);
  first.request.end('"first"}');
  assert.equal((await first.result).status, 200);
  assert.equal(page.calls.inference, 1);
});

test('client continuation state remains bound to its original user and model', () => {
  const codec = new ClientStateCodec({ secret: 'offline-state-secret'.repeat(4) });
  const encoded = codec.seal('upstream-opaque-state', accountId, model);
  assert.equal(codec.open(encoded, accountId, model), 'upstream-opaque-state');
  assert.throws(() => codec.open(encoded, '12345678-1234-1234-1234-123456789abd', model));
  assert.throws(() => codec.open(encoded, accountId, 'B-gpt-6-astra'));
});
