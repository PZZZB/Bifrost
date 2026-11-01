import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { startMessagesService } from '../src/messages-service.mjs';
import { AnthropicHttpProvider } from '../src/anthropic-http-provider.mjs';

const gatewayKey = 'messages-service-only-dedicated-offline-key';
const buddyModel = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy Opus 5.5' };

function config() {
  return { version: 1, listener: { address: '127.0.0.1', port: 32123,
    allowedHosts: ['client.test:32123'], allowedPeers: ['127.0.0.1'] }, gatewayKey,
  routes: [
    { account: 'Claude', model: { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', upstream: 'opus' }, provider: 'claude-cli' },
    { account: 'Claude', model: { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, provider: 'claude-cli' },
    { account: 'CodeBuddy', model: { ...buddyModel }, provider: 'codebuddy' },
  ], claudeCli: { baseUrl: 'http://127.0.0.1:32124', cacheMode: 'cli' } };
}

function providerFixture() {
  const calls = [], closed = [];
  return {
    calls, closed,
    provider: {
      async status() { return { authenticated: true, ready: true, modelAvailable: true }; },
      async request(request) {
        calls.push(request);
        return new Response(JSON.stringify({ id: 'mock-response', type: 'message', role: 'assistant',
          model: request.body.model, content: [{ type: 'text', text: 'offline fixture' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        { headers: { 'content-type': 'application/json' } });
      },
      close() { closed.push(true); },
    },
  };
}

async function fixture(testContext, { installed = config(), damaged = false, missing = false,
  codeBuddyEnabled = true, listenFailure = null, providerFailure = false, reservedPorts = [],
  startTcpForwarderImpl, httpFetch } = {}) {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'messages-service-')));
  const path = join(stateDir, 'messages-gateway.json');
  const source = damaged ? '{invalid-json' : JSON.stringify(installed);
  if (!missing) await writeFile(path, source);
  const buddy = providerFixture(), created = [], listens = [], records = [];
  let legacyCalls = 0, server = null;
  const legacy = { status() { return { deployment: 'legacy' }; }, channelStatus() { return {}; }, close() {} };
  const service = await startMessagesService({ stateDir, codeBuddyProvider: buddy.provider, codeBuddyModel: buddyModel,
    codeBuddyEnabled, reservedPorts, onUsage: record => { records.push(record); },
    ...(startTcpForwarderImpl === undefined ? {} : { startTcpForwarderImpl }),
    startLegacyImpl() { legacyCalls++; return legacy; },
    createHttpProvider(options) {
      if (providerFailure) throw new Error(`private constructor detail ${gatewayKey}`);
      const createdProvider = providerFixture();
      if (httpFetch) createdProvider.provider = new AnthropicHttpProvider({ ...options, fetchImpl: httpFetch });
      created.push({ options, ...createdProvider });
      return createdProvider.provider;
    },
    listenImpl: async (createdServer, port, address) => {
      server = createdServer; listens.push({ port, address });
      if (listenFailure) throw Object.assign(new Error(`private listener detail ${gatewayKey}`), { code: listenFailure });
      createdServer.listen(0, '127.0.0.1'); await once(createdServer, 'listening');
    } });
  testContext.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { service, legacy, stateDir, path, source, buddy, created, listens, records,
    legacyCalls: () => legacyCalls, server: () => server };
}

test('missing generic configuration returns the legacy adapter unchanged', async testContext => {
  const state = await fixture(testContext, { missing: true, reservedPorts: [32123] });
  assert.equal(state.service, state.legacy);
  assert.equal(state.legacyCalls(), 1);
  assert.deepEqual(state.listens, []);
  assert.deepEqual(state.created, []);
});

for (const address of ['127.0.0.1', '0.0.0.0', '::', '::1']) {
  test(`generic listener ${address} cannot take a reserved primary port`, async testContext => {
    const installed = config();
    installed.listener.address = address;
    const state = await fixture(testContext, { installed, reservedPorts: [32123] });
    assert.equal(state.legacyCalls(), 0);
    assert.deepEqual(state.created, []);
    assert.deepEqual(state.listens, []);
    assert.equal(state.service.channelStatus('Claude').running, false);
    assert.match(state.service.channelStatus('CodeBuddy').lastError, /主服务保留端口/);
    assert.deepEqual(state.buddy.closed, []);
    assert.equal(await readFile(state.path, 'utf8'), state.source);
  });
}

const selfLoopCases = [
  ['same IPv4', '127.0.0.1', 'http://127.0.0.1:32123'],
  ['localhost alias', '127.0.0.1', 'http://localhost:32123/v1'],
  ['IPv4 shorthand', '127.0.0.1', 'http://127.1:32123/v1'],
  ['canonical IPv6', '::1', 'http://[0:0:0:0:0:0:0:1]:32123/v1'],
  ['IPv4 wildcard bind', '0.0.0.0', 'http://127.0.0.1:32123/v1'],
  ['IPv6 wildcard bind', '::', 'http://localhost:32123/v1'],
  ['mapped IPv6 upstream', '127.0.0.1', 'http://[::ffff:127.0.0.1]:32123/v1'],
  ['mapped IPv6 bind', '::ffff:127.0.0.1', 'http://127.0.0.1:32123/v1'],
  ['same LAN address', '192.168.168.1', 'http://192.168.168.1:32123/v1'],
  ['wildcard upstream', '127.0.0.1', 'http://0.0.0.0:32123/v1'],
];

for (const [name, address, baseUrl] of selfLoopCases) {
  test(`Claude upstream ${name} cannot recursively query the same listener`, async testContext => {
    const installed = config();
    installed.listener.address = address;
    installed.claudeCli.baseUrl = baseUrl;
    const state = await fixture(testContext, { installed });
    assert.equal(state.legacyCalls(), 0);
    assert.deepEqual(state.created, []);
    assert.deepEqual(state.listens, []);
    assert.equal(state.service.channelStatus('Claude').running, false);
    assert.match(state.service.channelStatus('Claude').lastError, /不能指向当前 Messages 监听器/);
  });
}

test('a LAN listener can use a distinct loopback upstream on the same unreserved port', async testContext => {
  const installed = config();
  installed.listener.address = '192.168.168.1';
  installed.claudeCli.baseUrl = 'http://127.0.0.1:32123/v1';
  const state = await fixture(testContext, { installed, reservedPorts: [43155] });
  assert.equal(state.service.channelStatus('Claude').running, true);
  assert.equal(state.created.length, 2);
  assert.equal(state.listens.length, 1);
});

test('legacy delegation preserves existing injected lifecycle options', async testContext => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'messages-legacy-options-')));
  testContext.after(() => rm(stateDir, { recursive: true, force: true }));
  const daemon = {}, provider = {}, listenImpl = () => {}, onUsage = () => {};
  let received;
  const legacy = {};
  const result = await startMessagesService({ stateDir, codeBuddyEnabled: false, daemon, provider, listenImpl, onUsage,
    startLegacyImpl(options) { received = options; return legacy; } });
  assert.equal(result, legacy);
  assert.equal(received.daemon, daemon);
  assert.equal(received.provider, provider);
  assert.equal(received.listenImpl, listenImpl);
  assert.equal(received.onUsage, onUsage);
  assert.equal(received.stateDir, stateDir);
});

test('generic routes use explicit listener policy and separate per-model Claude providers', async testContext => {
  const state = await fixture(testContext);
  assert.equal(state.legacyCalls(), 0);
  assert.deepEqual(state.listens, [{ address: '127.0.0.1', port: 32123 }]);
  assert.deepEqual(state.created.map(item => item.options), [
    { baseUrl: 'http://127.0.0.1:32124', model: 'opus', cacheMode: 'cli' },
    { baseUrl: 'http://127.0.0.1:32124', model: 'claude-sonnet-5', cacheMode: 'cli' },
  ]);
  const routes = state.server().gateway.routes;
  assert.equal(routes.get(buddyModel.id).provider, state.buddy.provider);
  assert.notEqual(routes.get('claude-opus-5-5').provider, routes.get('claude-sonnet-5').provider);
  assert.deepEqual([...state.server().gateway.allowedHosts], ['client.test:32123']);
  assert.deepEqual([...state.server().gateway.allowedPeers], ['127.0.0.1']);
  assert.equal(state.service.channelStatus('Claude').running, true);
  assert.equal(state.service.channelStatus('CodeBuddy').running, true);
  assert.equal(state.service.channelStatus('With').running, false);
  assert.equal((await state.service.status()).configured, false);
  assert.equal((await state.service.status()).deployment, 'generic');
  assert.doesNotMatch(JSON.stringify(await state.service.status()), new RegExp(gatewayKey));
  assert.equal(await readFile(state.path, 'utf8'), state.source);
  assert.deepEqual(state.created.flatMap(item => item.calls), []);
  assert.deepEqual(state.buddy.calls, []);
});

test('configured models reach only their provider and preserve account accounting', async testContext => {
  const state = await fixture(testContext);
  for (const model of ['claude-opus-5-5', buddyModel.id]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: state.server().address().port,
        path: '/v1/messages', method: 'POST',
        headers: { host: 'client.test:32123', authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' } }, result => {
        const chunks = [];
        result.on('data', chunk => chunks.push(chunk));
        result.on('error', reject);
        result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'offline mock' }] }));
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.type, 'message');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.created[0].calls.length, 1);
  assert.equal(state.created[0].calls[0].body.model, 'opus');
  assert.equal(state.created[1].calls.length, 0);
  assert.equal(state.buddy.calls.length, 1);
  assert.equal(state.buddy.calls[0].body.model, buddyModel.id);
  assert.deepEqual(state.records.map(record => record.account), ['Claude', 'CodeBuddy']);
  assert.equal(state.service.channelStatus('Claude').completed, 1);
  assert.equal(state.service.channelStatus('CodeBuddy').completed, 1);
});

test('generic CodeBuddy-only setup never creates an unconfigured Claude upstream', async testContext => {
  const installed = config();
  installed.routes = [installed.routes[2]];
  delete installed.claudeCli;
  const state = await fixture(testContext, { installed });
  assert.deepEqual(state.created, []);
  assert.equal(state.service.channelStatus('Claude').running, false);
  assert.equal(state.service.channelStatus('CodeBuddy').running, true);
});

test('Claude-only setup works with CodeBuddy disabled and defaults cache ownership to CLI', async testContext => {
  const installed = config();
  installed.routes = [installed.routes[0]];
  delete installed.claudeCli.cacheMode;
  const state = await fixture(testContext, { installed, codeBuddyEnabled: false });
  assert.equal(state.created[0].options.cacheMode, 'cli');
  assert.equal(state.service.channelStatus('Claude').running, true);
  assert.equal(state.service.channelStatus('CodeBuddy').running, false);
});

async function privateKeyFixture(testContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'messages-private-key-')));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'independent-upstream-key.txt') };
}

test('explicit upstream key file is loaded lazily and supports key rotation', async testContext => {
  const keyFile = await privateKeyFixture(testContext);
  const installed = config();
  installed.claudeCli.apiKeyFile = keyFile.path;
  const state = await fixture(testContext, { installed });
  assert.equal(state.service.channelStatus('Claude').running, true);
  const first = state.created[0].options.loadKey, second = state.created[1].options.loadKey;
  assert.equal(typeof first, 'function');
  assert.equal(first, second);
  await assert.rejects(first(), { message: 'Claude 上游独立认证文件暂不可用。' });
  await writeFile(keyFile.path, 'offline-upstream-key-one\r\n', { mode: 0o600 });
  assert.equal(await first(), 'offline-upstream-key-one');
  await writeFile(keyFile.path, 'offline-upstream-key-two\n', { mode: 0o600 });
  assert.equal(await second(), 'offline-upstream-key-two');
  const status = JSON.stringify(await state.service.status());
  assert.doesNotMatch(status, /offline-upstream-key|independent-upstream-key/);
  assert.deepEqual(state.buddy.calls, []);
});

for (const [name, content] of [
  ['empty', ''], ['whitespace', 'private key'], ['embedded newline', 'private\nkey'],
  ['multiple ending newlines', 'private-key\n\n'], ['Unicode', 'private-key-密文'],
  ['oversized key', 'a'.repeat(4097)], ['oversized file', 'a'.repeat(10000)],
]) {
  test(`invalid ${name} key file fails without leaking its content or path`, async testContext => {
    const keyFile = await privateKeyFixture(testContext);
    await writeFile(keyFile.path, content);
    const installed = config(); installed.claudeCli.apiKeyFile = keyFile.path;
    const state = await fixture(testContext, { installed });
    await assert.rejects(state.created[0].options.loadKey(), error => {
      assert.equal(error.message, 'Claude 上游独立认证文件暂不可用。');
      assert.doesNotMatch(error.message, /private|independent-upstream-key|密文/);
      return true;
    });
  });
}

test('key loader accepts the full key bound with a single CRLF terminator', async testContext => {
  const keyFile = await privateKeyFixture(testContext);
  await writeFile(keyFile.path, `${'a'.repeat(4096)}\r\n`);
  const installed = config(); installed.claudeCli.apiKeyFile = keyFile.path;
  const state = await fixture(testContext, { installed });
  assert.equal((await state.created[0].options.loadKey()).length, 4096);
});

test('key loader rejects directories and linked parent paths', async testContext => {
  const keyFile = await privateKeyFixture(testContext);
  const actual = join(keyFile.directory, 'actual'), linked = join(keyFile.directory, 'linked');
  await mkdir(actual);
  await writeFile(join(actual, 'key.txt'), 'offline-upstream-private-key');
  await symlink(actual, linked, 'junction');
  for (const path of [actual, join(linked, 'key.txt')]) {
    const installed = config(); installed.claudeCli.apiKeyFile = path;
    const state = await fixture(testContext, { installed });
    await assert.rejects(state.created[0].options.loadKey(), { message: 'Claude 上游独立认证文件暂不可用。' });
  }
});

test('only the independent upstream key reaches HTTP upstream and client credentials stay private', async testContext => {
  const keyFile = await privateKeyFixture(testContext);
  const upstreamKey = 'offline-independent-upstream-key';
  await writeFile(keyFile.path, upstreamKey);
  const installed = config(); installed.claudeCli.apiKeyFile = keyFile.path;
  const outgoing = [];
  const state = await fixture(testContext, { installed, httpFetch: async (url, options) => {
    outgoing.push({ url, options });
    if (options.method === 'GET') return Response.json({ data: [{ id: 'opus' }, { id: 'claude-sonnet-5' }] });
    return Response.json({ id: 'offline-response', type: 'message', role: 'assistant', model: 'opus',
      content: [{ type: 'text', text: 'offline fixture' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: state.server().address().port,
      path: '/v1/messages', method: 'POST', headers: { host: 'client.test:32123',
        authorization: `Bearer ${gatewayKey}`, cookie: 'client-private-cookie', 'content-type': 'application/json' } }, result => {
      const chunks = []; result.on('data', chunk => chunks.push(chunk)); result.on('error', reject);
      result.on('end', () => resolve({ status: result.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'offline mock' }] }));
  });
  assert.equal(response.status, 200);
  assert.equal(outgoing.length, 2);
  for (const { options } of outgoing) {
    assert.equal(options.headers.get('authorization'), `Bearer ${upstreamKey}`);
    assert.equal(options.headers.get('cookie'), null);
    assert.equal(options.headers.get('x-api-key'), null);
    assert.doesNotMatch(JSON.stringify([...options.headers]), new RegExp(gatewayKey));
  }
  assert.deepEqual(state.buddy.calls, []);
  assert.doesNotMatch(response.text + JSON.stringify(await state.service.status()), /offline-independent-upstream-key|client-private-cookie/);
});

function withTcpForward(installed = config()) {
  installed.claudeCli.tcpForward = { version: 1, listener: { address: '127.0.0.1', port: 32124 },
    target: { ip: '192.0.2.8', port: 3435 } };
  return installed;
}

test('one shared TCP forwarder starts before Messages binds and is owned by its lifecycle', async testContext => {
  const installed = withTcpForward();
  let startCount = 0, closeCount = 0, received;
  const state = await fixture(testContext, { installed, startTcpForwarderImpl: async options => {
    startCount++; received = options;
    return { close() { closeCount++; } };
  } });
  assert.equal(startCount, 1);
  assert.deepEqual(received, installed.claudeCli.tcpForward);
  assert.equal(state.created.length, 2);
  assert.equal(state.listens.length, 1);
  assert.equal(state.service.channelStatus('Claude').running, true);
  await Promise.all([state.service.close(), state.service.close()]);
  assert.equal(closeCount, 1);
  assert.deepEqual(state.buddy.closed, []);
});

test('TCP startup failure does not bind Messages, construct providers, or fall back', async testContext => {
  const state = await fixture(testContext, { installed: withTcpForward(), startTcpForwarderImpl: async () => {
    throw new Error('private forwarder failure');
  } });
  assert.equal(state.legacyCalls(), 0);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.listens, []);
  assert.equal(state.service.channelStatus('Claude').running, false);
  assert.doesNotMatch(JSON.stringify(await state.service.status()), /private forwarder failure/);
  assert.deepEqual(state.buddy.closed, []);
});

for (const failure of ['provider', 'listener']) {
  test(`Messages ${failure} failure closes the already started TCP forwarder`, async testContext => {
    let closeCount = 0;
    const state = await fixture(testContext, { installed: withTcpForward(),
      providerFailure: failure === 'provider', listenFailure: failure === 'listener' ? 'EADDRINUSE' : null,
      startTcpForwarderImpl: async () => ({ close() { closeCount++; } }) });
    assert.equal(closeCount, 1);
    assert.equal(state.service.channelStatus('Claude').running, false);
    assert.equal(state.legacyCalls(), 0);
    await state.service.close();
    assert.equal(closeCount, 1);
    assert.deepEqual(state.buddy.closed, []);
  });
}

test('CodeBuddy-only routes ignore unused Claude TCP forwarding and authentication settings', async testContext => {
  const installed = withTcpForward();
  installed.routes = [installed.routes[2]];
  installed.claudeCli.apiKeyFile = 'unused-invalid-key-path';
  installed.claudeCli.tcpForward = 'unused-invalid-forwarder';
  let starts = 0;
  const state = await fixture(testContext, { installed, startTcpForwarderImpl: async () => { starts++; throw new Error(); } });
  assert.equal(starts, 0);
  assert.deepEqual(state.created, []);
  assert.equal(state.service.channelStatus('CodeBuddy').running, true);
});

const invalidForwardCases = [
  ['wildcard listener', value => { value.claudeCli.tcpForward.listener.address = '0.0.0.0'; }],
  ['reserved listener port', value => { value.claudeCli.tcpForward.listener.port = 43155; value.claudeCli.baseUrl = 'http://127.0.0.1:43155'; }],
  ['Messages listener port', value => { value.claudeCli.tcpForward.listener.port = 32123; value.claudeCli.baseUrl = 'http://127.0.0.1:32123'; }],
  ['mismatched base URL port', value => { value.claudeCli.baseUrl = 'http://127.0.0.1:32127'; }],
  ['mismatched loopback address', value => { value.claudeCli.baseUrl = 'http://[::1]:32124'; }],
  ['HTTPS loopback forwarding', value => { value.claudeCli.baseUrl = 'https://127.0.0.1:32124'; }],
  ['forward to Messages itself', value => { value.claudeCli.tcpForward.target = { ip: '127.0.0.1', port: 32123 }; }],
];

for (const [name, mutate] of invalidForwardCases) {
  test(`invalid TCP forwarding ${name} fails before any listener opens`, async testContext => {
    const installed = withTcpForward(); mutate(installed);
    let starts = 0;
    const state = await fixture(testContext, { installed, reservedPorts: [43155],
      startTcpForwarderImpl: async () => { starts++; throw new Error(); } });
    assert.equal(starts, 0);
    assert.deepEqual(state.created, []); assert.deepEqual(state.listens, []);
    assert.equal(state.legacyCalls(), 0);
    assert.match(state.service.channelStatus('Claude').lastError, /配置无效/);
  });
}

test('close is idempotent and never takes ownership of the shared CodeBuddy provider', async testContext => {
  const state = await fixture(testContext);
  await Promise.all([state.service.close(), state.service.close()]);
  assert.equal(state.service.channelStatus('Claude').running, false);
  assert.equal(state.service.channelStatus('CodeBuddy').running, false);
  assert.deepEqual(state.created.map(item => item.closed.length), [1, 1]);
  assert.deepEqual(state.buddy.closed, []);
});

for (const listenFailure of ['EADDRINUSE', 'EACCES']) {
  test(`generic listener failure ${listenFailure} stays optional without alternate binding`, async testContext => {
    const state = await fixture(testContext, { listenFailure });
    assert.equal(state.legacyCalls(), 0);
    assert.equal(state.listens.length, 1);
    assert.equal(state.service.channelStatus('Claude').running, false);
    assert.match(state.service.channelStatus('CodeBuddy').lastError, /端口|启动失败/);
    assert.doesNotMatch(JSON.stringify(await state.service.status()), /private listener|dedicated-offline-key/);
    assert.deepEqual(state.created.map(item => item.closed.length), [1, 1]);
    assert.deepEqual(state.buddy.closed, []);
  });
}

test('provider construction failures stay isolated and never expose private error text', async testContext => {
  const state = await fixture(testContext, { providerFailure: true });
  assert.equal(state.legacyCalls(), 0);
  assert.deepEqual(state.listens, []);
  assert.match(state.service.channelStatus('Claude').lastError, /启动失败/);
  assert.doesNotMatch(JSON.stringify(await state.service.status()), /private constructor|dedicated-offline-key/);
});

const invalidCases = [
  ['null document', () => null],
  ['version', value => { value.version = 2; }],
  ['listener address', value => { value.listener.address = 'invalid-address'; }],
  ['listener port', value => { value.listener.port = 0; }],
  ['empty hosts', value => { value.listener.allowedHosts = []; }],
  ['malformed hosts', value => { value.listener.allowedHosts = ['http://localhost']; }],
  ['empty peers', value => { value.listener.allowedPeers = []; }],
  ['non-IP peers', value => { value.listener.allowedPeers = ['localhost']; }],
  ['key', value => { value.gatewayKey = 'short-private-key'; }],
  ['empty routes', value => { value.routes = []; }],
  ['duplicate models', value => { value.routes[1].model.id = value.routes[0].model.id; }],
  ['unknown provider', value => { value.routes[0].provider = 'automatic'; }],
  ['Claude account mismatch', value => { value.routes[0].account = 'CodeBuddy'; }],
  ['CodeBuddy account mismatch', value => { value.routes[2].account = 'Claude'; }],
  ['unsupported CodeBuddy model', value => { value.routes[2].model.id = 'claude-unknown'; }],
  ['unsupported CodeBuddy upstream', value => { value.routes[2].model.upstream = 'another-model'; }],
  ['missing Claude settings', value => { delete value.claudeCli; }],
  ['upstream credentials', value => { value.claudeCli.baseUrl = 'http://user:private-value@localhost'; }],
  ['upstream query', value => { value.claudeCli.baseUrl += '?key=private-value'; }],
  ['cache mode', value => { value.claudeCli.cacheMode = 'automatic'; }],
  ['removed client cache mode', value => { value.claudeCli.cacheMode = 'client'; }],
  ['relative key path', value => { value.claudeCli.apiKeyFile = 'private-relative-key.txt'; }],
  ['key path URL', value => { value.claudeCli.apiKeyFile = 'https://private-value/key'; }],
  ['key path newline', value => { value.claudeCli.apiKeyFile = join(tmpdir(), 'private-value\n.txt'); }],
  ['network key path', value => { value.claudeCli.apiKeyFile = '\\\\private-server\\share\\key.txt'; }],
  ['alternate key data stream', value => { value.claudeCli.apiKeyFile = `${join(tmpdir(), 'private-key')}:stream`; }],
];

for (const [name, mutate] of invalidCases) {
  test(`invalid ${name} fails closed without legacy fallback or provider construction`, async testContext => {
    const installed = config();
    const result = mutate(installed);
    const state = await fixture(testContext, { installed: result === null ? null : installed });
    assert.equal(state.legacyCalls(), 0);
    assert.deepEqual(state.listens, []);
    assert.deepEqual(state.created, []);
    assert.equal(state.service.channelStatus('CodeBuddy').running, false);
    assert.match(state.service.channelStatus('CodeBuddy').lastError, /配置无效/);
    assert.doesNotMatch(JSON.stringify(await state.service.status()), /short-private-key|private-value|dedicated-offline-key/);
  });
}

test('unreadable generic JSON cannot activate the legacy listener', async testContext => {
  const state = await fixture(testContext, { damaged: true });
  assert.equal(state.legacyCalls(), 0);
  assert.deepEqual(state.listens, []);
  assert.match(state.service.channelStatus('CodeBuddy').lastError, /配置无法读取/);
});

test('an explicitly disabled CodeBuddy channel cannot be re-enabled by generic configuration', async testContext => {
  const state = await fixture(testContext, { codeBuddyEnabled: false });
  assert.deepEqual(state.listens, []);
  assert.deepEqual(state.created, []);
  assert.match(state.service.channelStatus('CodeBuddy').lastError, /CodeBuddy 授权渠道/);
});
