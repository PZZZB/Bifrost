import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startTcpForwarder, validateTcpForwarderConfig } from '../src/tcp-forwarder.mjs';

const configuration = (listenerPort, targetPort) => ({ version: 1,
  listener: { address: '127.0.0.1', port: listenerPort }, target: { ip: '127.0.0.1', port: targetPort } });

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function localTarget(testContext, handler) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    handler(socket);
  });
  const port = await listen(server);
  testContext.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, port, sockets };
}

async function forwarderFor(testContext, targetPort, options) {
  const listenerPort = await freePort();
  const forwarder = await startTcpForwarder(configuration(listenerPort, targetPort), options);
  testContext.after(() => forwarder.close());
  return { forwarder, listenerPort };
}

async function connect(testContext, port) {
  const socket = net.createConnection({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => {});
  socket.on('end', () => socket.end());
  testContext.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}

function readToEnd(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'loopback connection cleanup timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const invalidConfigurations = [
  ['version', value => { value.version = 2; }],
  ['unknown field', value => { value.gatewayKey = 'must-not-be-accepted'; }],
  ['IPv4 wildcard', value => { value.listener.address = '0.0.0.0'; }],
  ['LAN listener', value => { value.listener.address = '192.168.168.1'; }],
  ['IPv6 wildcard', value => { value.listener.address = '::'; }],
  ['listener hostname', value => { value.listener.address = 'localhost'; }],
  ['ephemeral listener', value => { value.listener.port = 0; }],
  ['target hostname', value => { value.target.ip = 'localhost'; }],
  ['target URL', value => { value.target.ip = 'http://private-value@127.0.0.1'; }],
  ['IPv4 unspecified target', value => { value.target.ip = '0.0.0.0'; }],
  ['IPv6 unspecified target', value => { value.target.ip = '::'; }],
  ['IPv4 multicast target', value => { value.target.ip = '224.0.0.1'; }],
  ['IPv6 multicast target', value => { value.target.ip = 'ff02::1'; }],
  ['scoped target', value => { value.target.ip = 'fe80::1%1'; }],
  ['invalid target port', value => { value.target.port = 65536; }],
  ['direct loop', value => { value.target.port = value.listener.port; }],
  ['mapped IPv6 loop', value => { value.target.ip = '::ffff:127.0.0.1'; value.target.port = value.listener.port; }],
];

for (const [name, mutate] of invalidConfigurations) {
  test(`invalid ${name} is rejected before opening a socket`, async () => {
    const config = configuration(32125, 32126);
    mutate(config);
    await assert.rejects(startTcpForwarder(config), error => {
      assert.equal(error.message, 'TCP forwarder configuration is invalid.');
      assert.doesNotMatch(error.message, /private-value|must-not-be-accepted/);
      return true;
    });
  });
}

test('configuration snapshots exact endpoints without retaining caller objects', () => {
  const config = configuration(32125, 32126);
  const validated = validateTcpForwarderConfig(config);
  config.target.ip = '192.0.2.8';
  assert.deepEqual(validated, configuration(32125, 32126));
  assert.equal(validateTcpForwarderConfig({ version: 1,
    listener: { address: '::1', port: 32125 }, target: { ip: '0:0:0:0:0:0:0:1', port: 32126 } }).target.ip, '::1');
});

test('binary bytes survive slow upstream backpressure and client half-close', { timeout: 10000 }, async testContext => {
  const payload = Buffer.alloc(5 * 1024 * 1024);
  for (let index = 0; index < payload.length; index++) payload[index] = index % 256;
  let received;
  const target = await localTarget(testContext, socket => {
    socket.pause();
    setTimeout(() => socket.resume(), 30);
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => { received = Buffer.concat(chunks); socket.end(received); });
  });
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port);
  const client = await connect(testContext, listenerPort);
  const response = readToEnd(client);
  client.write(payload);
  client.end();
  assert.deepEqual(await response, payload);
  assert.deepEqual(received, payload);
  await until(() => forwarder.status().active === 0);
  assert.deepEqual(forwarder.status(), { running: true, accepted: 1, failed: 0, active: 0, lastError: null });
});

test('upstream streaming bytes reach the client before the stream ends', { timeout: 5000 }, async testContext => {
  let release;
  const released = new Promise(resolve => { release = resolve; });
  testContext.after(() => release());
  const target = await localTarget(testContext, socket => {
    socket.once('data', () => {
      socket.write('data: first\n\n');
      void released.then(() => socket.end('data: second\n\n'));
    });
  });
  const { listenerPort } = await forwarderFor(testContext, target.port);
  const client = await connect(testContext, listenerPort);
  const response = readToEnd(client);
  const first = once(client, 'data');
  client.end('offline stream fixture');
  assert.equal((await first)[0].toString(), 'data: first\n\n');
  assert.equal(client.readableEnded, false);
  release();
  assert.equal((await response).toString(), 'data: first\n\ndata: second\n\n');
});

test('client reset cancels its upstream connection', { timeout: 5000 }, async testContext => {
  let upstream;
  const target = await localTarget(testContext, socket => { upstream = socket; socket.on('end', () => socket.end()); });
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port);
  const client = await connect(testContext, listenerPort);
  await until(() => upstream !== undefined);
  const closed = once(upstream, 'close');
  client.resetAndDestroy();
  // A reset/complete close must tear down both legs rather than leave a waiting upstream.
  upstream.resume();
  await closed;
  await until(() => forwarder.status().active === 0);
});

test('normal upstream close drains a large response to a slow-reading client', { timeout: 10000 }, async testContext => {
  const response = Buffer.alloc(12 * 1024 * 1024, 0x6b);
  const target = await localTarget(testContext, socket => { socket.once('end', () => socket.end(response)); socket.resume(); });
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port);
  const client = await connect(testContext, listenerPort);
  client.pause();
  const result = readToEnd(client);
  client.pause();
  client.end('slow response fixture');
  setTimeout(() => client.resume(), 50);
  assert.deepEqual(await result, response);
  await until(() => forwarder.status().active === 0);
  assert.equal(forwarder.status().failed, 0);
});

test('upstream connection failure closes the client and keeps the listener available', { timeout: 5000 }, async testContext => {
  const targetPort = await freePort();
  const { forwarder, listenerPort } = await forwarderFor(testContext, targetPort);
  const client = await connect(testContext, listenerPort);
  const closed = once(client, 'close');
  client.resume();
  await closed;
  assert.equal(forwarder.status().running, true);
  assert.equal(forwarder.status().failed, 1);
  assert.equal(forwarder.status().active, 0);
  assert.equal(forwarder.status().lastError, 'TCP upstream connection failed.');
});

test('upstream disconnect ends the corresponding client', { timeout: 5000 }, async testContext => {
  const target = await localTarget(testContext, socket => socket.once('data', () => socket.destroy()));
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port);
  const client = await connect(testContext, listenerPort);
  const closed = once(client, 'close');
  client.end('disconnect fixture'); client.resume();
  await closed;
  await until(() => forwarder.status().active === 0);
});

test('close is idempotent and tears down all active socket pairs', { timeout: 5000 }, async testContext => {
  const target = await localTarget(testContext, () => {});
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port);
  const clients = await Promise.all([connect(testContext, listenerPort), connect(testContext, listenerPort)]);
  await until(() => target.sockets.size === 2);
  const closed = clients.map(socket => { socket.resume(); return once(socket, 'close'); });
  await Promise.all([forwarder.close(), forwarder.close()]);
  await Promise.all(closed);
  assert.equal(forwarder.status().running, false);
  assert.equal(forwarder.status().active, 0);
  const rejected = net.createConnection({ host: '127.0.0.1', port: listenerPort });
  assert.equal((await once(rejected, 'error'))[0].code, 'ECONNREFUSED');
});

test('AbortSignal cleans active pairs and the listening socket', { timeout: 5000 }, async testContext => {
  const controller = new AbortController();
  const target = await localTarget(testContext, () => {});
  const { forwarder, listenerPort } = await forwarderFor(testContext, target.port, { signal: controller.signal });
  const client = await connect(testContext, listenerPort);
  await until(() => target.sockets.size === 1);
  client.resume();
  const closed = once(client, 'close');
  controller.abort();
  await forwarder.close(); await closed;
  assert.equal(forwarder.status().active, 0);
  assert.equal(forwarder.status().running, false);
});

test('cancellation during startup does not leave an orphan listener', { timeout: 5000 }, async () => {
  const listenerPort = await freePort(), targetPort = await freePort();
  const controller = new AbortController();
  const startup = startTcpForwarder(configuration(listenerPort, targetPort), { signal: controller.signal });
  controller.abort();
  await assert.rejects(startup, { name: 'AbortError' });
  const probe = net.createConnection({ host: '127.0.0.1', port: listenerPort });
  assert.equal((await once(probe, 'error'))[0].code, 'ECONNREFUSED');
});

test('occupied listener does not fall back to another address or port', { timeout: 5000 }, async testContext => {
  const occupied = await localTarget(testContext, () => {});
  const targetPort = await freePort();
  await assert.rejects(startTcpForwarder(configuration(occupied.port, targetPort)),
    { message: 'TCP loopback listener could not start.' });
});

test('independent CLI reports only fixed startup metadata and forwards local bytes', { timeout: 10000 }, async testContext => {
  const target = await localTarget(testContext, socket => socket.pipe(socket));
  const listenerPort = await freePort();
  const directory = await mkdtemp(join(tmpdir(), 'tcp-forwarder-cli-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'forwarder.json');
  await writeFile(configPath, JSON.stringify(configuration(listenerPort, target.port)));
  const script = fileURLToPath(new URL('../scripts/start-tcp-forwarder.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  testContext.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await until(() => stdout.includes('\n') || child.exitCode !== null);
  const metadata = JSON.parse(stdout.trim());
  assert.equal(metadata.event, 'ready');
  assert.equal(metadata.pid, child.pid);
  assert.equal(metadata.listener.address, '127.0.0.1');
  assert.equal(metadata.listener.port, listenerPort);
  const client = await connect(testContext, listenerPort);
  const response = readToEnd(client);
  const privateFixture = 'Authorization: Bearer offline-secret-not-for-logs\r\n\r\n';
  client.end(privateFixture);
  assert.equal((await response).toString(), privateFixture);
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(stdout + stderr, /offline-secret|Authorization/);
});

test('independent CLI errors do not print configuration contents or paths', { timeout: 5000 }, async testContext => {
  const directory = await mkdtemp(join(tmpdir(), 'tcp-forwarder-private-marker-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'private-config-marker.json');
  await writeFile(configPath, '{"privateBody":"private-contents-marker"}');
  const script = fileURLToPath(new URL('../scripts/start-tcp-forwarder.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal((await once(child, 'exit'))[0], 1);
  assert.equal(stdout, '');
  assert.equal(stderr, 'TCP forwarder could not start. Check the explicit configuration and loopback port.\n');
  assert.doesNotMatch(stderr, /private-config-marker|private-contents-marker|private-marker/);
});
