import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { startWithService, WITH_GATEWAY_ALLOWED_HOSTS } from '../src/with-service.mjs';
import { WithGateway } from '../src/with-gateway.mjs';

const dedicatedKey = 'with-loopback-forwarder-dedicated-mock-key';
const guest = '192.168.168.10';
const loopbackHost = '127.0.0.1:43157';

function accessFixture() {
  let providerCalls = 0;
  const provider = { status() { providerCalls++; }, request() { providerCalls++; } };
  const gateway = new WithGateway({ provider, gatewayKey: dedicatedKey,
    allowedHosts: WITH_GATEWAY_ALLOWED_HOSTS, allowedPeers: [guest] });
  const request = (headers = {}, peer = guest) => ({ socket: { remoteAddress: peer },
    headers: { host: loopbackHost, authorization: `Bearer ${dedicatedKey}`, ...headers },
    rawHeaders: ['Host', headers.host ?? loopbackHost] });
  return { gateway, request, providerCalls: () => providerCalls };
}

for (const content of [null, '{invalid-json']) {
  test(`optional With ${content === null ? 'missing' : 'damaged'} configuration does not prevent Codex startup`, async t => {
    const stateDir = await mkdtemp(join(tmpdir(), 'with-isolation-'));
    t.after(() => rm(stateDir, { recursive: true, force: true }));
    if (content !== null) await writeFile(join(stateDir, 'with.json'), content);
    let charged = false;
    const service = await startWithService({ stateDir, onUsage: () => { charged = true; } });
    const status = await service.status();
    assert.equal(status.running, false);
    assert.equal(status.configured, false);
    assert.equal(Boolean(status.provider.error), content !== null);
    assert.equal(charged, false);
    await service.close();
  });
}

test('the fixed service Host list accepts only the LAN endpoint and guest loopback forwarder alias', () => {
  assert.deepEqual(WITH_GATEWAY_ALLOWED_HOSTS, ['192.168.168.1:43157', loopbackHost]);
  assert.equal(Object.isFrozen(WITH_GATEWAY_ALLOWED_HOSTS), true);
  const { gateway, request, providerCalls } = accessFixture();
  for (const host of WITH_GATEWAY_ALLOWED_HOSTS) {
    assert.doesNotThrow(() => gateway.authorize(request({ host })));
  }
  assert.doesNotThrow(() => gateway.authorize(request({ authorization: undefined, 'x-api-key': dedicatedKey })));
  assert.equal(providerCalls(), 0);
});

test('the loopback Host alias still requires the actual guest Peer and ignores forwarded address claims', () => {
  const { gateway, request, providerCalls } = accessFixture();
  for (const peer of ['127.0.0.1', '::1', '192.168.168.11', '192.168.168.1']) {
    assert.throws(() => gateway.authorize(request({
      'x-forwarded-for': guest, 'x-real-ip': guest, forwarded: `for=${guest}`,
    }, peer)), error => error.status === 403 && error.code === 'with_peer_denied');
  }
  assert.doesNotThrow(() => gateway.authorize(request({}, `::ffff:${guest}`)));
  assert.equal(providerCalls(), 0);
});

test('the loopback Host alias does not bypass the independent gateway key', () => {
  const { gateway, request, providerCalls } = accessFixture();
  for (const headers of [{ authorization: undefined }, { authorization: 'Bearer account-a-key' },
    { authorization: undefined, 'x-api-key': 'account-b-key' },
    { authorization: 'Bearer unrelated-key', 'x-api-key': dedicatedKey }]) {
    assert.throws(() => gateway.authorize(request(headers)), error => error.status === 401 && error.code === 'with_invalid_gateway_key');
  }
  assert.equal(providerCalls(), 0);
});

test('other loopback names, ports, and duplicate Host headers remain denied', () => {
  const { gateway, request, providerCalls } = accessFixture();
  for (const host of ['localhost:43157', '[::1]:43157', '127.0.0.1', '127.0.0.1:43158',
    '127.0.0.1:43157.evil.example', '192.168.168.1:43158']) {
    assert.throws(() => gateway.authorize(request({ host, 'x-forwarded-host': loopbackHost })),
      error => error.status === 403 && error.code === 'with_host_denied');
  }
  const duplicate = request(); duplicate.rawHeaders.push('Host', loopbackHost);
  assert.throws(() => gateway.authorize(duplicate), error => error.status === 403 && error.code === 'with_host_denied');
  assert.equal(providerCalls(), 0);
});

async function serviceFixture(t, { withEnabled = false, codeBuddyEnabled = true, config, damaged = false,
  failListen = false } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'with-service-routes-'));
  const path = join(stateDir, 'with.json');
  const installed = config === undefined ? { enabled: withEnabled, gatewayKey: dedicatedKey,
    mcpKey: 'separate-native-with-mcp-key-for-offline-tests' } : config;
  if (installed !== null) await writeFile(path, damaged ? '{invalid-json' : JSON.stringify(installed));
  const before = installed === null ? null : await readFile(path, 'utf8');
  const nativeCalls = [], listens = [], buddyCalls = [];
  const daemon = { close() { nativeCalls.push('daemon.close'); } };
  const provider = {
    mcpServer() { nativeCalls.push('mcpServer'); return http.createServer((_request, response) => response.end()); },
    async prepare() { nativeCalls.push('prepare'); },
    async status() { nativeCalls.push('status'); return { authenticated: true, ready: true, modelAvailable: true }; },
    async request() { nativeCalls.push('request'); throw new Error('No native inference is allowed.'); },
    async close() { nativeCalls.push('provider.close'); },
  };
  const buddyModel = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' };
  const buddy = { async status() { buddyCalls.push('status'); return { authenticated: true, ready: true, modelAvailable: true }; },
    async request() { buddyCalls.push('request'); throw new Error('No real inference is allowed.'); } };
  const service = await startWithService({ stateDir, daemon, provider, codeBuddyEnabled,
    codeBuddyProvider: buddy, codeBuddyModel: buddyModel,
    listenImpl: async (server, port, address) => {
      listens.push({ server, port, address });
      if (failListen) throw new Error(`mock listener failed ${dedicatedKey}`);
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
    } });
  t.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { service, stateDir, path, before, nativeCalls, buddyCalls, listens, buddyModel };
}

test('CodeBuddy-only starts the shared listener without With native, MCP, or a native MCP key', async t => {
  const { service, path, before, nativeCalls, buddyCalls, listens, buddyModel } = await serviceFixture(t, {
    config: { enabled: false, gatewayKey: dedicatedKey, retainedNativeAuthorization: 'mock-retained' },
  });
  assert.deepEqual(listens.map(item => [item.port, item.address]), [[43157, '192.168.168.1']]);
  const gateway = listens[0].server.gateway;
  assert.equal(gateway.provider, null);
  assert.deepEqual([...gateway.routes.keys()], [buddyModel.id]);
  assert.deepEqual([...gateway.allowedHosts], [...WITH_GATEWAY_ALLOWED_HOSTS]);
  assert.deepEqual([...gateway.allowedPeers], [guest]);
  assert.equal((await service.status()).running, false);
  assert.equal(service.channelStatus('With').running, false);
  assert.equal(service.channelStatus('CodeBuddy').running, true);
  assert.deepEqual(nativeCalls, []); assert.deepEqual(buddyCalls, []);
  assert.equal(await readFile(path, 'utf8'), before, 'Starting a channel must not rewrite retained credentials or its enabled flag.');
  await service.close();
  assert.equal(service.channelStatus('CodeBuddy').running, false);
  assert.deepEqual(nativeCalls, []);
});

for (const codeBuddyEnabled of [false, true]) {
  test(`legacy ${codeBuddyEnabled ? 'both-channel' : 'With-only'} startup retains native/MCP lifecycle`, async t => {
    const { service, nativeCalls, listens, buddyModel } = await serviceFixture(t, { withEnabled: true, codeBuddyEnabled });
    assert.deepEqual(listens.map(item => [item.port, item.address]), [[43158, '127.0.0.1'], [43157, '192.168.168.1']]);
    assert.deepEqual([...listens[1].server.gateway.routes.keys()], ['claude-opus-5-5', ...(codeBuddyEnabled ? [buddyModel.id] : [])]);
    assert.equal((await service.status()).running, true);
    assert.equal(service.channelStatus('With').running, true);
    assert.equal(service.channelStatus('CodeBuddy').running, codeBuddyEnabled);
    assert.deepEqual(nativeCalls.slice(0, 2), ['mcpServer', 'prepare']);
    await service.close();
    assert.equal(nativeCalls.includes('provider.close'), true);
    assert.equal(nativeCalls.includes('daemon.close'), true);
  });
}

test('disabling both channels leaves the shared listener and native With unopened', async t => {
  const { service, nativeCalls, listens } = await serviceFixture(t, { codeBuddyEnabled: false });
  assert.equal(listens.length, 0); assert.deepEqual(nativeCalls, []);
  assert.equal((await service.status()).running, false);
  assert.equal(service.channelStatus('CodeBuddy').running, false);
});

test('CodeBuddy-only fails closed for missing, damaged, or invalid independent gateway keys', async t => {
  for (const options of [{ config: null }, { damaged: true }, { config: { enabled: false } },
    { config: { enabled: false, gatewayKey: 'short-mock-key' } },
    { config: { enabled: false, gatewayKey: dedicatedKey + '\r\n' } }]) {
    const { service, nativeCalls, buddyCalls, listens } = await serviceFixture(t, options);
    assert.equal(listens.length, 0); assert.deepEqual(nativeCalls, []); assert.deepEqual(buddyCalls, []);
    assert.equal(service.channelStatus('CodeBuddy').running, false);
    assert.ok(service.channelStatus('CodeBuddy').lastError);
    assert.doesNotMatch(JSON.stringify(await service.status()), /short-mock-key|with-loopback-forwarder/);
  }
});

test('a shared-listener failure stays isolated and reports a safe channel error', async t => {
  const { service, nativeCalls } = await serviceFixture(t, { failListen: true });
  assert.equal(service.channelStatus('CodeBuddy').running, false);
  assert.doesNotMatch(service.channelStatus('CodeBuddy').lastError, /with-loopback-forwarder/);
  assert.deepEqual(nativeCalls, []);
});
