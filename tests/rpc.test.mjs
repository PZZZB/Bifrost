import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRpc } from '../src/rpc.mjs';

function fakeChild(onMessage) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false });
  child.respond = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.kill = () => { child.killed = true; return true; };
  let input = '';
  child.stdin.on('data', (bytes) => {
    input += bytes.toString();
    let end;
    while ((end = input.indexOf('\n')) !== -1) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      if (line) onMessage(JSON.parse(line), child);
    }
  });
  return child;
}

test('failed initialization discards the child and next request performs a new handshake', async () => {
  const children = [];
  const rpc = new CodexRpc({ spawnImpl: () => {
    const index = children.length;
    const child = fakeChild((message, process) => {
      if (message.method === 'initialize') process.respond(index === 0 ?
        { id: message.id, error: { message: 'handshake rejected' } } : { id: message.id, result: { userAgent: 'test/1' } });
      if (message.method === 'account/read') process.respond({ id: message.id, result: { account: null } });
    });
    children.push(child); return child;
  } });
  await assert.rejects(rpc.request('account/read'), /handshake rejected/);
  assert.equal(children[0].killed, true);
  assert.deepEqual(await rpc.request('account/read'), { account: null });
  assert.equal(children.length, 2);
});

test('an old child exit cannot reject requests on its replacement', async () => {
  const children = [];
  let entered, reply;
  const pendingRead = new Promise((resolve) => { entered = resolve; });
  const rpc = new CodexRpc({ spawnImpl: () => {
    const index = children.length;
    const child = fakeChild((message, process) => {
      if (message.method === 'initialize') process.respond(index === 0 ?
        { id: message.id, error: { message: 'first failed' } } : { id: message.id, result: {} });
      if (message.method === 'account/read') {
        reply = () => process.respond({ id: message.id, result: { account: null } }); entered();
      }
    });
    children.push(child); return child;
  } });
  await assert.rejects(rpc.request('account/read'), /first failed/);
  const request = rpc.request('account/read');
  await pendingRead;
  children[0].emit('exit', 1);
  reply();
  assert.deepEqual(await request, { account: null });
});

test('isolated B child never inherits account A credential environment variables', async () => {
  const names = ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL'];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'test-value-must-not-reach-b';
  let childEnvironment;
  try {
    const rpc = new CodexRpc({ isolated: true, spawnImpl: (_binary, _args, options) => {
      childEnvironment = options.env;
      return fakeChild((message, child) => {
        if (message.id) child.respond({ id: message.id, result: {} });
      });
    } });
    await rpc.request('account/read');
    for (const name of names) assert.equal(childEnvironment[name], undefined);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
  }
});
