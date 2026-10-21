import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startRelayControl } from '../src/relay-control.mjs';

const key = 'offline-relay-control-key-'.repeat(3);
const invalid = { error: 'Invalid control request.' };
const command = value => `${JSON.stringify({ command: 'shutdown', key: value })}\n`;
const addressFor = directory => process.platform === 'win32'
  ? `\\\\.\\pipe\\CodexAccountBridge-ClaudeRelay-test-${randomUUID()}` : join(directory, 'control.sock');

async function fixture(t, onStop) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-control-'));
  const address = addressFor(directory);
  let stops = 0;
  const control = await startRelayControl({ key, address, onStop: async () => { stops++; await onStop?.(control); } });
  t.after(async () => { await control.close(); await rm(directory, { recursive: true, force: true }); });
  return { control, address, stops: () => stops };
}

async function connect(t, address) {
  const socket = net.createConnection(address);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}

function readReply(socket) {
  return new Promise((yes, no) => {
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', no);
    socket.once('close', () => yes(Buffer.concat(chunks).toString('utf8')));
  });
}

async function request(t, address, payload, { halfClose = false } = {}) {
  const socket = await connect(t, address), reply = readReply(socket);
  if (halfClose) socket.end(payload); else socket.write(payload);
  return reply;
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'control completion timed out');
    await new Promise(done => setTimeout(done, 5));
  }
}

test('a valid shutdown ACK survives reentrant close and invokes onStop once', { timeout: 5000 }, async t => {
  const state = await fixture(t, control => control.close());
  assert.equal(state.control.address(), state.address);
  assert.equal(await request(t, state.address, command(key)), '{"stopping":true}\n');
  await until(() => state.stops() === 1);
  await state.control.close();
  const failed = net.createConnection(state.address);
  failed.on('error', () => {});
  const [error] = await once(failed, 'error');
  assert.ok(['ENOENT', 'ECONNREFUSED'].includes(error.code));
  assert.equal(state.stops(), 1);
});

test('close does not await an onStop callback that owns application shutdown', { timeout: 5000 }, async t => {
  let release;
  const stopped = new Promise(done => { release = done; });
  t.after(() => release());
  const state = await fixture(t, () => stopped);
  assert.deepEqual(JSON.parse(await request(t, state.address, command(key))), { stopping: true });
  await until(() => state.stops() === 1);
  await state.control.close();
  release();
});

test('shutdown accepts fragmented UTF-8 JSON and CRLF', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const socket = await connect(t, state.address), result = readReply(socket);
  const body = command(key).replace('\n', '\r\n');
  socket.write(body.slice(0, 17));
  await new Promise(done => setImmediate(done));
  socket.write(body.slice(17));
  assert.deepEqual(JSON.parse(await result), { stopping: true });
  await until(() => state.stops() === 1);
});

for (const [name, payload] of [
  ['incorrect key', command('wrong-private-key-that-must-never-appear-in-output')],
  ['short key', command('x')],
  ['missing key', '{"command":"shutdown"}\n'],
  ['unknown command', `${JSON.stringify({ command: 'status', key })}\n`],
  ['unknown field', `${JSON.stringify({ command: 'shutdown', key, leaked: 'secret' })}\n`],
  ['array', `${JSON.stringify([{ command: 'shutdown', key }])}\n`],
  ['null', 'null\n'],
  ['malformed JSON', '{bad-private-value}\n'],
  ['two lines', `${command(key)}${command(key)}`],
  ['HTTP request', 'POST /shutdown HTTP/1.1\r\nHost: private-host\r\n\r\n'],
  ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a])],
]) {
  test(`${name} returns the same sanitized error without shutting down`, { timeout: 5000 }, async t => {
    const state = await fixture(t);
    const reply = await request(t, state.address, payload);
    assert.equal(reply, `${JSON.stringify(invalid)}\n`);
    assert.equal(state.stops(), 0);
    assert.deepEqual(JSON.parse(await request(t, state.address, command(key))), { stopping: true });
    await until(() => state.stops() === 1);
  });
}

test('an incomplete closed request never shuts down the application', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const reply = await request(t, state.address, '{"command":', { halfClose: true });
  // Windows named-pipe EOF disconnects the peer; it cannot receive an error after closing.
  if (process.platform === 'win32') assert.equal(reply, '');
  else assert.deepEqual(JSON.parse(reply), invalid);
  assert.equal(state.stops(), 0);
});

test('the 8192 byte request boundary includes its terminating newline', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const line = command(key), payload = `${line.slice(0, -1)}${' '.repeat(8192 - Buffer.byteLength(line))}\n`;
  assert.equal(Buffer.byteLength(payload), 8192);
  assert.deepEqual(JSON.parse(await request(t, state.address, payload)), { stopping: true });
  await until(() => state.stops() === 1);
});

test('oversized requests are rejected before JSON parsing', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const line = command(key), payload = `${line.slice(0, -1)}${' '.repeat(8193 - Buffer.byteLength(line))}\n`;
  assert.equal(Buffer.byteLength(payload), 8193);
  assert.deepEqual(JSON.parse(await request(t, state.address, payload)), invalid);
  assert.equal(state.stops(), 0);
});

test('the two second deadline cannot be extended by a slowly sending peer', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const socket = await connect(t, state.address), result = readReply(socket), started = Date.now();
  socket.write('{');
  const timer = setInterval(() => { if (!socket.destroyed) socket.write(' '); }, 100);
  t.after(() => clearInterval(timer));
  const reply = await result;
  clearInterval(timer);
  assert.deepEqual(JSON.parse(reply), invalid);
  assert.ok(Date.now() - started >= 1700);
  assert.equal(state.stops(), 0);
});

test('concurrent authenticated requests can trigger application shutdown only once', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const sockets = await Promise.all(Array.from({ length: 4 }, () => connect(t, state.address)));
  const replies = sockets.map(readReply);
  sockets.forEach(socket => socket.write(command(key)));
  const results = await Promise.allSettled(replies);
  assert.ok(results.some(result => result.status === 'fulfilled' && result.value === '{"stopping":true}\n'));
  await until(() => state.stops() === 1);
  await state.control.close();
  assert.equal(state.stops(), 1);
});

test('concurrent close calls share completion and remove every owned connection', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  const sockets = await Promise.all(Array.from({ length: 4 }, () => connect(t, state.address)));
  const closed = sockets.map(socket => once(socket, 'close'));
  sockets.forEach(socket => socket.write('{'));
  const first = state.control.close(), second = state.control.close();
  assert.strictEqual(first, second);
  await Promise.all([first, ...closed]);
  assert.equal(state.stops(), 0);
  const replacement = await startRelayControl({ key, address: state.address, onStop() {} });
  await replacement.close();
});

test('an occupied address fails with a fixed message and preserves its owner', { timeout: 5000 }, async t => {
  const state = await fixture(t);
  await assert.rejects(startRelayControl({ key, address: state.address, onStop() {} }), { message: 'Relay control could not start.' });
  assert.deepEqual(JSON.parse(await request(t, state.address, command(key))), { stopping: true });
});

for (const [name, change] of [
  ['weak key', { key: 'short' }],
  ['credential with newline', { key: `${key}\n` }],
  ['TCP endpoint', { address: '127.0.0.1:43157' }],
  ['remote pipe', { address: '\\\\remote-host\\pipe\\private-name' }],
  ['control character in address', { address: 'private\npath' }],
  ['missing callback', { onStop: undefined }],
]) {
  test(`invalid ${name} is rejected without a listener`, async () => {
    await assert.rejects(startRelayControl({ key, address: process.platform === 'win32'
      ? '\\\\.\\pipe\\CodexAccountBridge-ClaudeRelay-invalid' : '/tmp/bridge-control-invalid.sock', onStop() {}, ...change }),
    { name: 'TypeError', message: 'Relay control configuration is invalid.' });
  });
}

test('the Windows default is the fixed local per-process pipe', { skip: process.platform !== 'win32', timeout: 5000 }, async t => {
  const control = await startRelayControl({ key, onStop() {} });
  t.after(() => control.close());
  assert.equal(control.address(), `\\\\.\\pipe\\CodexAccountBridge-ClaudeRelay-${process.pid}`);
});

for (const [name, mcpPort, apiPort = 3435] of [
  ['ephemeral MCP port', 0], ['negative MCP port', -1], ['oversized MCP port', 65536],
  ['string MCP port', '3436'], ['same API and MCP port', 3435], ['default MCP collides with API', undefined, 3436],
]) {
  test(`entry rejects ${name} before creating a hub or loading the CLI`, { timeout: 5000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-entry-control-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateDir = join(directory, 'uncreated-state');
    const configPath = join(directory, 'entry.json');
    await writeFile(configPath, JSON.stringify({ version: 1,
      listener: { address: '127.0.0.1', port: apiPort, allowedHosts: [`127.0.0.1:${apiPort}`], allowedPeers: ['127.0.0.1'] },
      gatewayKeyFile: join(directory, 'unread-key'), models: [{ id: 'fixture', name: 'Fixture', upstream: 'fixture' }],
      cli: { binary: join(directory, 'unstarted-cli.exe'), configDir: join(directory, 'config'),
        profileDir: join(directory, 'profile'), stateDir }, mcpPort }));
    await assert.rejects(promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../scripts/run-claude-relay.mjs', import.meta.url)), configPath]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, 'Claude relay could not start. Check the private configuration, official CLI and listener.\n');
      return true;
    });
    await assert.rejects(stat(stateDir), { code: 'ENOENT' });
  });
}
