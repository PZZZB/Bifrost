import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WithDaemonClient, discoverWithPipes } from '../src/with-desktop.mjs';

const pipe = '\\\\.\\pipe\\with-1234-test';
function fakeSocket(onRequest) {
  const socket = new EventEmitter();
  Object.assign(socket, { destroyed: false, writable: true, requests: [], scope: null });
  socket.write = (bytes) => {
    assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
    socket.scope = bytes.readUInt32LE(4);
    assert.ok(socket.scope < 0xffffff00, 'never claim the Electron shell control segment');
    const request = JSON.parse(bytes.subarray(8).toString());
    socket.requests.push(request); onRequest?.(request, socket); return true;
  };
  socket.frame = (message, scope = socket.scope) => {
    const raw = Buffer.from(JSON.stringify(message));
    const bytes = Buffer.alloc(raw.length + 8);
    bytes.writeUInt32LE(raw.length + 4); bytes.writeUInt32LE(scope, 4); raw.copy(bytes, 8);
    return bytes;
  };
  socket.reply = (request, data) => socket.emit('data', socket.frame({ id: request.id, ok: true, data }));
  socket.destroy = () => { socket.destroyed = true; socket.writable = false; socket.emit('close'); };
  queueMicrotask(() => socket.emit('connect'));
  return socket;
}
function clientWith(onRequest, options = {}) {
  const sockets = [];
  const client = new WithDaemonClient({ discoverPipes: async () => [pipe], connectImpl: () => {
    const socket = fakeSocket(onRequest); sockets.push(socket); return socket;
  }, ...options });
  return { client, sockets };
}

test('discovery only accepts native With pipe names and queries current Windows user ownership', async () => {
  let invocation;
  const paths = await discoverWithPipes({ platform: 'win32', readdirImpl: async () =>
    ['with-1234-test', 'with-1234-test', 'with-5678-unowned', 'other', 'https://untrusted.invalid'], execFileImpl: (...args) => {
    invocation = args;
    args[3](null, JSON.stringify(['1234']));
  } });
  assert.deepEqual(paths, [pipe]);
  assert.equal(invocation[0], 'powershell.exe');
  assert.equal(invocation[2].windowsHide, true);
  assert.match(invocation[1][3], /GetOwnerSid/);
  assert.match(invocation[1][3], /WindowsIdentity/);
  await assert.rejects(discoverWithPipes({ platform: 'linux' }), /With/);
});

test('status and model directory use native readonly RPC and discard personal login fields', async () => {
  const { client, sockets } = clientWith((request, socket) => {
    if (request.cmd === 'login_status') socket.reply(request, {
      success: true, user_name: 'private-user', device_id: 'private-device', token: 'private-token',
    });
    if (request.cmd === 'get_agent_models') socket.reply(request, { code: 0, msg: '', data: { models: [
      { model_name: 'claude-opus-5.5', display_name: 'Claude-5.5-Opus', error: null },
      { model_name: 'blocked', error: 'private failure detail' },
    ] } });
  });
  try {
    assert.deepEqual(await client.status(), { connected: true, authenticated: true, modelAvailable: true, error: null });
    assert.deepEqual(await client.models(), [
      { id: 'claude-opus-5.5', name: 'Claude-5.5-Opus', available: true },
      { id: 'blocked', name: 'blocked', available: false },
    ]);
    assert.deepEqual(sockets[0].requests.map((request) => request.cmd), ['login_status', 'get_agent_models', 'get_agent_models']);
  } finally { client.close(); }
});

test('native error text cannot leak tokens or request content through status', async () => {
  const { client } = clientWith((request, socket) => socket.emit('data', socket.frame({
    id: request.id, ok: false, error: 'Bearer SECRET private prompt',
  })));
  try {
    const result = await client.status();
    assert.equal(result.authenticated, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|private prompt|Bearer/);
  } finally { client.close(); }
});

test('channel frames handle byte fragmentation, batched events, and events after invoke acknowledgement', async () => {
  let request, channel;
  const events = [];
  const { client, sockets } = clientWith((message, socket) => {
    if (message.cmd !== 'chat_send') return;
    request = message; channel = Number(message.args.onEvent.split(':')[1]);
    const frame = socket.frame({ id: message.id, channel, payload: [{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CONTENT', delta: 'a' }] });
    socket.emit('data', frame.subarray(0, 3)); socket.emit('data', frame.subarray(3, 11)); socket.emit('data', frame.subarray(11));
    socket.reply(message, { accepted: true });
  });
  const stream = client.chatSend({ model: 'claude-opus-5.5', message: 'mock only', extra_headers: { Test: 'value' } }, {
    onEvent: (event) => events.push(event),
  });
  try {
    assert.deepEqual(await stream.started, { accepted: true });
    sockets[0].emit('data', sockets[0].frame({ id: request.id, channel, payload: [{ type: 'RUN_FINISHED' }] }));
    assert.deepEqual(events.map((event) => event.type), ['RUN_STARTED', 'TEXT_MESSAGE_CONTENT', 'RUN_FINISHED']);
    assert.equal(request.args.params.extra_headers['X-Internal-Oauth-Type'], 'oauth2');
    assert.equal(request.args.params.extra_headers.Test, 'value');
    stream.close(); await stream.closed;
    assert.deepEqual(sockets[0].requests.at(-1), { type: 'channel_close', channel });
    sockets[0].emit('data', sockets[0].frame({ id: request.id, channel, payload: [{ type: 'late' }] }));
    assert.equal(events.length, 3);
  } finally { client.close(); }
});

test('another scope and another channel cannot inject events into the active stream', async () => {
  let request, channel;
  const events = [];
  const { client, sockets } = clientWith((message, socket) => {
    if (message.cmd !== 'chat_send') return;
    request = message; channel = Number(message.args.onEvent.split(':')[1]); socket.reply(message, {});
  });
  const stream = client.chatSend({}, { onEvent: (event) => events.push(event) });
  try {
    await stream.started;
    sockets[0].emit('data', sockets[0].frame({ id: request.id, channel, payload: [{ type: 'wrong scope' }] }, sockets[0].scope + 1));
    sockets[0].emit('data', sockets[0].frame({ id: request.id, channel: channel + 1, payload: [{ type: 'wrong channel' }] }));
    assert.deepEqual(events, []);
    stream.close(); await stream.closed;
  } finally { client.close(); }
});

test('already aborted streams never connect or submit a chat request', async () => {
  let discoveries = 0;
  const { client } = clientWith(() => {}, { discoverPipes: async () => { discoveries++; return [pipe]; } });
  const controller = new AbortController(); controller.abort();
  const stream = client.chatSend({}, { signal: controller.signal });
  await assert.rejects(stream.started, (error) => error.code === 'with_aborted');
  await assert.rejects(stream.closed, (error) => error.code === 'with_aborted');
  assert.equal(discoveries, 0);
});

test('abort closes subscription and rejects pending turn without implicitly approving or cancelling tools', async () => {
  let submitted;
  const submittedPromise = new Promise((resolve) => { submitted = resolve; });
  const { client, sockets } = clientWith((request) => { if (request.cmd === 'chat_send') submitted(); });
  const controller = new AbortController();
  const stream = client.chatSend({}, { signal: controller.signal });
  try {
    await submittedPromise; controller.abort();
    await assert.rejects(stream.started, (error) => error.code === 'with_aborted');
    await assert.rejects(stream.closed, (error) => error.code === 'with_aborted');
    assert.deepEqual(sockets[0].requests.map((request) => request.cmd || request.type), ['chat_send', 'channel_close']);
  } finally { client.close(); }
});

test('disconnect rejects active work and old socket events cannot affect a replacement connection', async () => {
  let reply, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  let count = 0;
  const { client, sockets } = clientWith((request, socket) => {
    count++;
    if (count === 1) socket.destroy();
    else { reply = () => socket.reply(request, { models: [] }); entered(); }
  });
  await assert.rejects(client.models(), (error) => error.code === 'with_disconnected');
  const next = client.models(); await waiting;
  sockets[0].emit('close'); reply();
  assert.deepEqual(await next, []);
  client.close();
});

test('oversized frames reject pending requests and destroy only the client connection', async () => {
  const { client, sockets } = clientWith((_request, socket) => {
    const length = Buffer.alloc(4); length.writeUInt32LE(2048); socket.emit('data', length);
  }, { maxFrameBytes: 1024 });
  await assert.rejects(client.models(), (error) => error.code === 'with_invalid_frame');
  assert.equal(sockets[0].destroyed, true);
});

test('timeout never repeats a potentially delivered chat request', async () => {
  const { client, sockets } = clientWith(() => {}, { streamTimeoutMs: 15 });
  const stream = client.chatSend({});
  try {
    await assert.rejects(stream.started, (error) => error.code === 'with_timeout');
    await assert.rejects(stream.closed, (error) => error.code === 'with_timeout');
    assert.equal(sockets[0].requests.filter((request) => request.cmd === 'chat_send').length, 1);
  } finally { client.close(); }
});

test('session, MCP registration and cancellation helpers preserve exact native envelopes in mocks', async () => {
  const { client, sockets } = clientWith((request, socket) => socket.reply(request, {}));
  try {
    const config = { codex_vm_gateway: { url: 'http://127.0.0.1:12345/mcp', transportType: 'streamable-http' } };
    await client.installMcp(config);
    await client.createSession({ isPureChat: true, title: 'mock session' });
    await client.cancel({ session_id: 'mock-session', message_id: 'mock-message', disconnect_only: false });
    assert.deepEqual(sockets[0].requests.map(({ cmd, args }) => ({ cmd, args })), [
      { cmd: 'mcp_install_custom', args: { config_json: JSON.stringify(config) } },
      { cmd: 'session_create', args: { isPureChat: true, title: 'mock session' } },
      { cmd: 'chat_cancel', args: { params: { session_id: 'mock-session', message_id: 'mock-message', disconnect_only: false } } },
    ]);
    await assert.rejects(client.invoke('login_cmd'), /不支持/);
    await assert.rejects(client.invoke('chat_send'), /不支持/);
    assert.throws(() => client.installMcp({ mcpServers: config }), (error) => error.code === 'with_invalid_mcp_config');
  } finally { client.close(); }
});

test('nonzero native business envelopes preserve known login status and hide upstream error details', async () => {
  const { client } = clientWith((request, socket) => socket.reply(request,
    request.cmd === 'login_status' ? { success: true } : { code: 42, msg: 'Bearer SECRET', data: null }));
  try {
    const status = await client.status();
    assert.equal(status.authenticated, true);
    assert.equal(status.modelAvailable, false);
    assert.doesNotMatch(JSON.stringify(status), /SECRET|Bearer/);
  } finally { client.close(); }
});

test('close during discovery prevents a late connection from being created', async () => {
  let discovered;
  const discovery = new Promise((resolve) => { discovered = resolve; });
  let connections = 0;
  const client = new WithDaemonClient({ discoverPipes: () => discovery,
    connectImpl: () => { connections++; return fakeSocket(); } });
  const pending = client.models(); client.close(); discovered([pipe]);
  await assert.rejects(pending, (error) => error.code === 'with_aborted');
  assert.equal(connections, 0);
});

const expectedMcp = { codex_vm_gateway: { url: 'http://127.0.0.1:12345/mcp',
  transportType: 'streamable-http', headers: { Authorization: 'Bearer mock-private-key' }, timeout: 1800000 } };

test('matching owner-file MCP configuration is reused without connecting or registering', async () => {
  let connections = 0;
  const client = new WithDaemonClient({
    readFileImpl: async () => JSON.stringify({ mcpServers: { ...expectedMcp, unrelated: { command: 'existing' } } }),
    discoverPipes: async () => { connections++; throw new Error('must not connect'); },
  });
  assert.deepEqual(await client.ensureMcp(expectedMcp), { installed: true, reused: true });
  assert.equal(connections, 0);
});

test('different existing credentials or user edits are rejected without registration or secret leakage', async () => {
  for (const edit of [ { url: 'http://127.0.0.1:9999/mcp' }, { disabled: true },
    { headers: { Authorization: 'Bearer changed-private-key' } } ]) {
    const client = new WithDaemonClient({ readFileImpl: async () => JSON.stringify({ mcpServers: {
      codex_vm_gateway: { ...expectedMcp.codex_vm_gateway, ...edit },
    } }), discoverPipes: async () => { throw new Error('must not connect'); } });
    await assert.rejects(client.ensureMcp(expectedMcp), (error) => {
      assert.doesNotMatch(error.message, /changed-private-key|mock-private-key|9999/);
      return error.code === 'with_mcp_conflict';
    });
  }
});

test('malformed or unreadable owner files fail closed before registration', async () => {
  for (const reader of [async () => '{', async () => JSON.stringify({ unexpected: {} }),
    async () => { throw Object.assign(new Error('private path details'), { code: 'EACCES' }); }]) {
    const client = new WithDaemonClient({ readFileImpl: reader,
      discoverPipes: async () => { throw new Error('must not connect'); } });
    await assert.rejects(client.ensureMcp(expectedMcp), (error) => error.code === 'with_mcp_unreadable');
  }
});

test('missing target registers one native entry, verifies unrelated entries and serializes concurrent preparation', async () => {
  let document = { mcpServers: { unrelated: { command: 'existing', env: { PRIVATE: 'preserve-me' } } } };
  const { client, sockets } = clientWith((request, socket) => {
    if (request.cmd === 'mcp_list') socket.reply(request, { list: [], total_count: 0 });
    if (request.cmd === 'mcp_install_custom') {
      Object.assign(document.mcpServers, JSON.parse(request.args.config_json)); socket.reply(request, null);
    }
  }, { readFileImpl: async () => JSON.stringify(document) });
  try {
    const result = await Promise.all([client.ensureMcp(expectedMcp), client.ensureMcp(expectedMcp)]);
    assert.deepEqual(result, [{ installed: true, reused: false }, { installed: true, reused: true }]);
    assert.equal(sockets[0].requests.filter((item) => item.cmd === 'mcp_install_custom').length, 1);
    assert.equal(document.mcpServers.unrelated.env.PRIVATE, 'preserve-me');
  } finally { client.close(); }
});

test('a catalog-only name collision is rejected without overwriting its configuration', async () => {
  const { client, sockets } = clientWith((request, socket) => socket.reply(request,
    { list: [{ server_name: 'codex_vm_gateway', installed: true }], total_count: 1 }),
  { readFileImpl: async () => JSON.stringify({ mcpServers: {} }) });
  try {
    await assert.rejects(client.ensureMcp(expectedMcp), (error) => error.code === 'with_mcp_conflict');
    assert.equal(sockets[0].requests.filter((item) => item.cmd === 'mcp_install_custom').length, 0);
  } finally { client.close(); }
});

test('an owner-file edit during preparation prevents the native write', async () => {
  let document = { mcpServers: { unrelated: { command: 'original' } } };
  const { client, sockets } = clientWith((request, socket) => {
    document.mcpServers.unrelated.command = 'user-edited'; socket.reply(request, { list: [] });
  }, { readFileImpl: async () => JSON.stringify(document) });
  try {
    await assert.rejects(client.ensureMcp(expectedMcp), (error) => error.code === 'with_mcp_config_changed');
    assert.equal(sockets[0].requests.filter((item) => item.cmd === 'mcp_install_custom').length, 0);
  } finally { client.close(); }
});

test('registration readback detects a native write that changes an unrelated server', async () => {
  let document = { mcpServers: { unrelated: { command: 'existing' } } };
  const { client } = clientWith((request, socket) => {
    if (request.cmd === 'mcp_list') socket.reply(request, { list: [] });
    if (request.cmd === 'mcp_install_custom') {
      document = { mcpServers: { ...expectedMcp } }; socket.reply(request, null);
    }
  }, { readFileImpl: async () => JSON.stringify(document) });
  try { await assert.rejects(client.ensureMcp(expectedMcp), (error) => error.code === 'with_mcp_verification_failed'); }
  finally { client.close(); }
});

test('closing during owner-file inspection prevents a later registration or reconnection', async () => {
  let read, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const file = new Promise((resolve) => { read = resolve; });
  let discoveries = 0;
  const client = new WithDaemonClient({ readFileImpl: () => { entered(); return file; },
    discoverPipes: async () => { discoveries++; return [pipe]; } });
  const ensuring = client.ensureMcp(expectedMcp); await waiting;
  client.close(); read(JSON.stringify({ mcpServers: {} }));
  await assert.rejects(ensuring, (error) => error.code === 'with_aborted');
  assert.equal(discoveries, 0);
});
