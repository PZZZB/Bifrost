import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientAccess } from '../src/client-access.mjs';
import { startClientService } from '../src/client-service.mjs';

const MODEL = 'claude-codebuddy-opus-5-5';
const PASSWORD = 'Offline service password 123';
const config = () => ({ version: 1, enabled: true,
  listener: { address: '127.0.0.1', port: 43159, allowedHosts: ['client.test:43159'] }, publicBaseUrl: 'http://127.0.0.1:43159' });
function get(port, path = '/health', headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path, headers: { host: 'client.test:43159', connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    request.on('error', reject);
  });
}
async function closeServer(server) {
  if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
async function primaryGateway(t) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true,"service":"offline-primary"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => closeServer(server));
  return server;
}
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-client-service-'));
  if (options.config !== undefined) await writeFile(join(stateDir, 'client-gateway.json'),
    typeof options.config === 'string' ? options.config : JSON.stringify(options.config));
  const access = await ClientAccess.open({ path: join(stateDir, 'clients.json'), allowedModelIds: [MODEL] });
  const listens = [], calls = [];
  let server = null;
  const service = await startClientService({ stateDir, access, publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    csrfSecret: 'offline-service-csrf-secret-'.repeat(3), getModels: () => [{ id: MODEL, name: 'Offline model', channel: 'CodeBuddy' }],
    requestResponses: async value => { calls.push(value); return Response.json({ status: 'completed', output: [] }); },
    listen: async (createdServer, port, address) => {
      listens.push({ port, address }); server = createdServer;
      if (options.listenFailure) throw new Error('private listener failure should not leak');
      createdServer.listen(0, '127.0.0.1'); await once(createdServer, 'listening');
    }, ...options.service });
  t.after(async () => { await service.close(); await access.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { stateDir, access, service, listens, calls, server: () => server };
}

test('missing configuration starts an independent loopback user listener with a reachable portal', async t => {
  const primary = await primaryGateway(t), f = await fixture(t);
  assert.deepEqual(f.listens, [{ port: 43159, address: '127.0.0.1' }]);
  assert.equal(f.service.status().ready, true); assert.equal(f.service.status().enabled, true);
  assert.equal(f.service.endpoint().chatCompletionsUrl, 'http://127.0.0.1:43159/v1/chat/completions');
  assert.equal(f.service.activeRequests, 0);
  const page = await get(f.server().address().port, '/portal', { host: '127.0.0.1:43159' }); assert.equal(page.status, 200); assert.match(page.text, /Bifröst/);
  const health = await get(f.server().address().port, '/health', { host: '127.0.0.1:43159' }); assert.equal(health.status, 200); assert.equal(JSON.parse(health.text).service, 'bifrost-client');
  assert.equal((await get(primary.address().port)).status, 200); assert.equal(f.calls.length, 0);
});

test('disabled user service mounts no listener and leaves the separate primary gateway running', async t => {
  const primary = await primaryGateway(t), installed = config(); installed.enabled = false;
  const f = await fixture(t, { config: installed });
  assert.equal(f.service.status().enabled, false); assert.equal(f.service.status().ready, false);
  assert.equal(f.service.endpoint(), null); assert.equal(f.service.activeRequests, 0); assert.deepEqual(f.listens, []);
  await f.service.close(); await f.service.close();
  assert.equal((await get(primary.address().port)).status, 200); assert.equal(f.calls.length, 0);
});

test('malformed, public-bind, insecure-public and reserved-port configurations fail closed without touching the main listener', async t => {
  const primary = await primaryGateway(t);
  const cases = ['{invalid-json', { ...config(), version: 2 }, { ...config(), listener: { ...config().listener, address: '0.0.0.0' } },
    { ...config(), publicBaseUrl: 'http://untrusted.example.org' }, { ...config(), publicBaseUrl: 'https://public.example.org/path' },
    { ...config(), listener: { ...config().listener, allowedHosts: ['unsafe/path'] } }];
  for (const installed of cases) {
    const f = await fixture(t, { config: installed });
    assert.equal(f.service.status().ready, false); assert.match(f.service.status().message, /用户接入入口未启动/);
    assert.deepEqual(f.listens, []); assert.equal(f.service.activeRequests, 0); await f.service.close();
    assert.equal((await get(primary.address().port)).status, 200);
  }
  const reserved = await fixture(t, { config: config(), service: { reservedPorts: [43159] } });
  assert.equal(reserved.service.status().ready, false); assert.deepEqual(reserved.listens, []);
  assert.equal(primary.listening, true);
});

test('a listener failure exposes only a fixed message and cannot close the shared model source or primary gateway', async t => {
  const primary = await primaryGateway(t), f = await fixture(t, { config: config(), listenFailure: true });
  assert.equal(f.service.status().ready, false); assert.equal(f.service.activeRequests, 0);
  assert.match(f.service.status().message, /用户接入入口未启动/);
  assert.doesNotMatch(JSON.stringify(f.service.status()), /private listener/);
  assert.equal(f.server().listening, false);
  await f.service.close();
  assert.equal((await get(primary.address().port)).status, 200); assert.equal(f.calls.length, 0);
  const account = await f.access.createAccount({ username: 'still-independent', password: PASSWORD, allowedModels: [MODEL] });
  const issued = await f.access.createKey(account.id); assert.equal(f.access.authenticateKey(issued.secret).accountId, account.id);
});

test('a real port collision is contained within the user service and does not disturb the occupied gateway', async t => {
  const primary = await primaryGateway(t), installed = config();
  installed.listener.port = primary.address().port;
  installed.listener.allowedHosts = [`127.0.0.1:${primary.address().port}`];
  installed.publicBaseUrl = `http://127.0.0.1:${primary.address().port}`;
  const f = await fixture(t, { config: installed, service: { listen: (server, port, address) => new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, address, resolve);
  }) } });
  assert.equal(f.service.status().ready, false); assert.match(f.service.status().message, /用户接入入口未启动/);
  assert.equal((await get(primary.address().port)).status, 200);
});

test('closing the user listener is idempotent and leaves access data and the primary gateway usable', async t => {
  const primary = await primaryGateway(t), f = await fixture(t, { config: config() });
  const account = await f.access.createAccount({ username: 'independent-user', password: PASSWORD, allowedModels: [MODEL] });
  const issued = await f.access.createKey(account.id);
  const directory = await get(f.server().address().port, '/v1/models', { authorization: `Bearer ${issued.secret}` });
  assert.equal(directory.status, 200); assert.equal(JSON.parse(directory.text).data[0].id, MODEL);
  const port = f.server().address().port;
  await f.service.close(); await f.service.close();
  assert.equal(f.service.status().ready, false); assert.equal(f.service.activeRequests, 0);
  assert.equal(f.server().listening, false);
  await assert.rejects(get(port));
  assert.equal(f.access.authenticateKey(issued.secret).accountId, account.id);
  assert.equal((await get(primary.address().port)).status, 200); assert.equal(f.calls.length, 0);
});

test('HTTPS public origins advertise HTTPS endpoints and mark portal cookies Secure', async t => {
  const installed = config(); installed.publicBaseUrl = 'https://bridge.example.org';
  const f = await fixture(t, { config: installed });
  const account = await f.access.register({ username: 'https-user', password: PASSWORD });
  assert.equal(f.service.status().ready, true); assert.equal(f.service.endpoint().baseUrl, 'https://bridge.example.org/v1');
  assert.equal(f.access.authenticateKey(account.secret).accountId, account.account.id);
  const port = f.server().address().port;
  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'https-user', password: PASSWORD });
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: '/portal/api/login', method: 'POST',
      headers: { host: 'client.test:43159', origin: 'https://bridge.example.org', 'content-type': 'application/json', connection: 'close' } }, response => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode, cookie: response.headers['set-cookie'][0] }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
  assert.equal(result.status, 200); assert.match(result.cookie, /; Secure;/); assert.match(result.cookie, /HttpOnly/);
  assert.equal(f.calls.length, 0);
});
