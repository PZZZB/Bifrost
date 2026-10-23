import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeVmGateway } from '../src/claude-vm-gateway.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';

const clientKey = 'client-fixture-key-'.repeat(3), relayKey = 'relay-fixture-key-'.repeat(3);
async function fixture(t, fetchImpl) {
  const server = createClaudeVmGateway({ gatewayKey: clientKey, relayKey, upstreamPort: 3435, allowedHosts: ['fixture'], fetchImpl });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  return (path = '/health', options = {}) => new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${server.address().port}${path}`, {
      ...options, headers: { host: 'fixture', authorization: `Bearer ${clientKey}`, ...options.headers },
    }, response => resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })));
    request.on('error', reject); request.end(options.body);
  });
}
test('host gateway replaces client credentials and forwards only approved headers to fixed loopback relay', async t => {
  let seen;
  const send = await fixture(t, async (url, options) => { seen = { url, options }; return Response.json({ ok: false }); });
  const response = await send('/health', { headers: { cookie: 'secret-cookie', 'x-api-key': clientKey, 'x-session-id': 'session-a' } });
  assert.equal(response.status, 200); assert.equal(seen.url, 'http://127.0.0.1:3435/health');
  assert.equal(seen.options.headers.get('authorization'), `Bearer ${relayKey}`);
  assert.equal(seen.options.headers.get('x-api-key'), null); assert.equal(seen.options.headers.get('cookie'), null);
  assert.equal(seen.options.headers.get('x-session-id'), 'session-a');
});
test('host gateway blocks unauthenticated requests, unlisted targets and redirects', async t => {
  let calls = 0;
  const send = await fixture(t, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://external.invalid' } }); });
  assert.equal((await send('/health', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await send('/api/admin')).status, 404);
  assert.equal((await send('/health')).status, 502); assert.equal(calls, 1);
});
test('VM offline remains a bounded 503 without a public fallback', async t => {
  const send = await fixture(t, async () => { throw new Error('private relay details'); });
  const response = await send(); assert.equal(response.status, 503);
  const value = JSON.stringify(await response.json());
  assert.ok(!value.includes('private relay details')); assert.match(value, /VM relay is unavailable/);
});
