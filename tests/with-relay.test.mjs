import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WithRelayProvider, WITH_MCP_NAME } from '../src/with-relay.mjs';

const mcpKey = 'mock-with-relay-key-at-least-thirty-two-characters';
const mcpHost = '127.0.0.1:43158';
const input = {
  model: 'claude-opus-5.5', stream: true, max_tokens: 128,
  system: 'Follow the external client instructions.',
  messages: [{ role: 'user', content: 'Read a file using the client tool.' }],
};
const tool = { name: 'read_file', description: 'Read a file on the VM after its permission check.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function deadline(promise, label, milliseconds = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}

async function until(predicate, label) {
  const end = Date.now() + 1500;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(label);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

class MockDaemon {
  constructor({ delayedAck = false, createGate = null, initialEvents = [] } = {}) {
    this.delayedAck = delayedAck; this.createGate = createGate;
    this.initialEvents = initialEvents;
    this.installed = []; this.created = []; this.channels = []; this.cancelled = [];
    this.statusReads = 0; this.modelReads = 0;
  }
  async status() { this.statusReads++; return { authenticated: true, error: null }; }
  async models() { this.modelReads++; return [{ id: 'claude-opus-5.5', available: true }]; }
  async installMcp(config) { this.installed.push(JSON.parse(config)); }
  async createSession(params) {
    this.created.push(structuredClone(params));
    if (this.createGate) await this.createGate.promise;
    const id = params.sessionId || randomUUID();
    return id;
  }
  chatSend(params, { onEvent }) {
    const closed = deferred();
    const channel = { params: structuredClone(params), onEvent, closed, closeCalls: 0, acknowledged: false };
    const started = this.delayedAck ? closed.promise : Promise.resolve();
    channel.handle = { started, closed: closed.promise,
      close() { channel.closeCalls++; closed.resolve(); } };
    started.then(() => { channel.acknowledged = true; }, () => {});
    channel.emit = event => onEvent(event);
    this.channels.push(channel);
    for (const event of this.initialEvents) channel.emit(event);
    return channel.handle;
  }
  async cancel(params) { this.cancelled.push(structuredClone(params)); }
}

async function fixture(t, options = {}) {
  const daemon = new MockDaemon(options);
  const provider = new WithRelayProvider({ daemon, mcpKey, mcpBase: `http://${mcpHost}/mcp`,
    idleMs: options.idleMs ?? 30_000 });
  const server = provider.mcpServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await provider.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = (method, params = {}, extra = {}) => new Promise((resolve, reject) => {
    const request = http.request(base + '/mcp', { method: 'POST',
      headers: { Host: mcpHost, Authorization: `Bearer ${mcpKey}`, 'Content-Type': 'application/json', ...extra.headers },
      signal: extra.signal,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 'mock-rpc', method, params }));
  });
  const request = (body = input, signal = undefined) => provider.request({ path: '/v1/messages',
    body: structuredClone(body), headers: new Headers(), signal });
  if (options.prepare !== false) await provider.prepare();
  return { daemon, provider, rpc, request };
}

async function events(response) {
  const text = await deadline(response.text(), 'Relay response did not finish.');
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(part => JSON.parse(part.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
}

function blocks(wire) {
  const result = [];
  for (const event of wire) {
    if (event.type === 'content_block_start') result[event.index] = structuredClone(event.content_block);
    if (event.delta?.type === 'text_delta') result[event.index].text += event.delta.text;
    if (event.delta?.type === 'input_json_delta') result[event.index].input = JSON.parse(event.delta.partial_json);
  }
  return result.filter(Boolean);
}

function usage(channel, { prompt = 100, output = 20, cached = 60, written = 5, reasoning = 7 } = {}) {
  channel.emit({ type: 'STEP_FINISHED', rawEvent: { step_name: 'call_llm', token_usage: {
    prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    completion_tokens_details: { reasoning_tokens: reasoning },
  } } });
}

function finish(channel, text = 'Done.') {
  if (text) channel.emit({ type: 'TEXT_MESSAGE_CONTENT', delta: text });
  channel.emit({ type: 'RUN_FINISHED' });
}

async function pausedTool(context, { toolName = 'read_file', arguments: args = { path: 'vm-only.txt' }, beforeTool } = {}) {
  const body = { ...structuredClone(input), tools: [structuredClone(tool)] };
  const response = await deadline(context.request(body), 'New With turn waited for chat_send ACK.');
  const channel = context.daemon.channels.at(-1);
  assert.ok(channel);
  if (beforeTool) beforeTool(channel);
  const requestId = /request_id=([^\s,]+)/.exec(channel.params.message)?.[1];
  assert.ok(requestId, 'The prompt must identify the exact client tool session.');
  const pending = context.rpc('tools/call', { name: 'delegate_vm_tool', arguments: {
    request_id: requestId, name: toolName, arguments: args,
  } });
  pending.catch(() => {});
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  const wire = await events(response);
  const content = blocks(wire);
  const call = content.find(block => block.type === 'tool_use');
  assert.ok(call, 'The HTTP response must contain the VM tool request.');
  await response.bridgeUsage;
  return { body, response, channel, wire, content, call, pending, settled: () => settled };
}

function continuation(turn, result = { content: 'VM file contents', is_error: false }) {
  return { ...structuredClone(turn.body), messages: [
    ...structuredClone(turn.body.messages),
    { role: 'assistant', content: structuredClone(turn.content) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.call.id, ...result }] },
  ] };
}

test('status and MCP setup are read-only with respect to model inference', async t => {
  const { provider, daemon, rpc } = await fixture(t, { prepare: false });
  assert.equal((await provider.status()).ready, false);
  assert.equal(daemon.installed.length, 0);
  await provider.prepare();
  assert.equal((await provider.status()).ready, true);
  assert.equal(daemon.installed.length, 1);
  const config = daemon.installed[0];
  assert.deepEqual(Object.keys(config), [WITH_MCP_NAME]);
  assert.equal(config[WITH_MCP_NAME].url, `http://${mcpHost}/mcp`);
  assert.equal(config[WITH_MCP_NAME].headers.Authorization, `Bearer ${mcpKey}`);
  const initialized = await rpc('initialize'); assert.equal(initialized.status, 200);
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.body.result.tools.map(item => item.name), ['delegate_vm_tool']);
  assert.equal(daemon.created.length, 0); assert.equal(daemon.channels.length, 0);
});

test('text SSE forwards AGUI deltas and resolves trustworthy real usage without adding cache twice', async t => {
  const { request, daemon, provider } = await fixture(t);
  const response = await request();
  const channel = daemon.channels[0];
  assert.equal(Object.hasOwn(daemon.created[0], 'sessionId'), false);
  assert.equal(daemon.created[0].isPureChat, true);
  assert.equal(Object.hasOwn(channel.params, 'message_id'), false);
  assert.equal(Object.hasOwn(channel.params, 'client_uuid'), false);
  channel.emit({ type: 'TEXT_MESSAGE_CONTENT', delta: '中文 ' });
  channel.emit({ type: 'TEXT_MESSAGE_CONTENT', rawEvent: { content: 'response' } });
  channel.emit({ type: 'STEP_FINISHED', rawEvent: { step_name: 'unrelated_tool', token_usage: { prompt_tokens: 9999 } } });
  usage(channel); finish(channel, '');
  const wire = await events(response);
  assert.equal(wire[0].type, 'message_start');
  assert.equal(wire.at(-1).type, 'message_stop');
  assert.deepEqual(blocks(wire), [{ type: 'text', text: '中文 response' }]);
  assert.equal(wire.find(item => item.type === 'message_delta').delta.stop_reason, 'end_turn');
  assert.deepEqual(await response.bridgeUsage, {
    input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 7 },
  });
  assert.equal((await provider.status()).sessions, 0);
});

test('missing AGUI usage stays unknown despite SDK placeholder zeros', async t => {
  const { request, daemon } = await fixture(t);
  const response = await request(); finish(daemon.channels[0]);
  const wire = await events(response);
  assert.equal(wire[0].message.usage.input_tokens, 0);
  assert.equal(wire.find(item => item.type === 'message_delta').usage.output_tokens, 0);
  assert.equal(await response.bridgeUsage, null);
});

test('a nonstreaming request returns one Anthropic JSON message and the same trusted AGUI usage', async t => {
  const { request, daemon } = await fixture(t);
  const pending = request({ ...structuredClone(input), stream: false });
  await until(() => daemon.channels.length === 1, 'Nonstreaming chat was not started.');
  usage(daemon.channels[0], { prompt: 10, output: 2 }); finish(daemon.channels[0], 'JSON response');
  const response = await deadline(pending, 'Nonstreaming request did not finish.');
  const data = await response.json();
  assert.equal(data.type, 'message'); assert.equal(data.model, 'claude-opus-5-5');
  assert.deepEqual(data.content, [{ type: 'text', text: 'JSON response' }]);
  assert.equal(data.stop_reason, 'end_turn');
  assert.equal((await response.bridgeUsage).input_tokens, 10);
});

test('multiple authoritative AGUI LLM steps sum once while preserving unknown optional fields', async t => {
  const { request, daemon } = await fixture(t);
  const response = await request(), channel = daemon.channels[0];
  usage(channel, { prompt: 100, output: 20, cached: 60, written: 5, reasoning: 7 });
  channel.emit({ type: 'STEP_FINISHED', stepName: 'call_llm', token_usage: {
    prompt_tokens: 50, completion_tokens: 10, total_tokens: 60,
  } });
  finish(channel); await events(response);
  assert.deepEqual(await response.bridgeUsage, {
    input_tokens: 150, output_tokens: 30, total_tokens: 180,
    input_tokens_details: { cached_tokens: null, cache_write_tokens: null },
    output_tokens_details: { reasoning_tokens: null },
  });
});

test('VM tool call pauses MCP HTTP, returns tool_use, and resumes only after the matching VM tool_result', async t => {
  const context = await fixture(t);
  const turn = await pausedTool(context, { beforeTool: channel => {
    channel.emit({ type: 'TOOL_CALL_START', toolCallName: `mcp__${WITH_MCP_NAME}__delegate_vm_tool`,
      rawEvent: { server_name: WITH_MCP_NAME } });
    usage(channel, { prompt: 40, output: 5 });
  } });
  assert.equal(turn.wire.find(item => item.type === 'message_delta').delta.stop_reason, 'tool_use');
  assert.equal(turn.call.name, 'read_file'); assert.deepEqual(turn.call.input, { path: 'vm-only.txt' });
  assert.equal(turn.settled(), false, 'MCP must wait for execution and permission in the external client.');
  assert.equal((await context.provider.status()).pendingTools, 1);
  assert.deepEqual(turn.channel.params.workspaces, []);
  assert.equal(turn.channel.params.is_pure_chat, true);
  assert.deepEqual(turn.channel.params.attached_mcp_list, [{ server_name: WITH_MCP_NAME }]);
  assert.match(turn.channel.params.message, /external client executes tools and obtains user permission/i);
  const next = await context.request(continuation(turn));
  const mcp = await deadline(turn.pending, 'VM tool result did not release MCP.');
  assert.deepEqual(mcp.body.result, { content: [{ type: 'text', text: 'VM file contents' }], isError: false });
  assert.equal(context.daemon.channels.length, 1, 'Tool continuation must retain the same With run.');
  usage(turn.channel, { prompt: 30, output: 6 }); finish(turn.channel, 'Read on the VM.');
  assert.deepEqual(blocks(await events(next)), [{ type: 'text', text: 'Read on the VM.' }]);
  assert.equal((await turn.response.bridgeUsage).input_tokens, 40);
  assert.equal((await next.bridgeUsage).input_tokens, 30, 'The second HTTP request must not repeat first-round usage.');
  assert.equal((await context.provider.status()).pendingTools, 0);
  assert.equal(context.daemon.cancelled.length, 0);
});

test('a VM permission denial is returned as an MCP error without executing the client tool in the relay', async t => {
  const context = await fixture(t);
  const turn = await pausedTool(context);
  const next = await context.request(continuation(turn, { content: 'Permission denied by VM user.', is_error: true }));
  const mcp = await deadline(turn.pending, 'VM denial did not release MCP.');
  assert.deepEqual(mcp.body.result, { content: [{ type: 'text', text: 'Permission denied by VM user.' }], isError: true });
  finish(turn.channel, 'Permission was denied.');
  await events(next); await next.bridgeUsage;
  assert.equal(context.daemon.channels.length, 1);
});

test('extra user text beside a tool_result is rejected instead of silently discarded', async t => {
  const context = await fixture(t);
  const turn = await pausedTool(context);
  const mixed = continuation(turn);
  mixed.messages.at(-1).content.push({ type: 'text', text: 'Also follow this new user instruction.' });
  const response = await context.request(mixed);
  assert.equal([400, 501].includes(response.status), true, 'A continuation must preserve extra user text or explicitly reject it.');
  await response.json();
  assert.equal(turn.settled(), false);
  const next = await context.request(continuation(turn));
  await turn.pending; finish(turn.channel); await events(next); await next.bridgeUsage;
});

test('conversation, system, tool schema, and invocation tampering cannot release the pending tool', async t => {
  const context = await fixture(t);
  const turn = await pausedTool(context);
  const changedHistory = continuation(turn); changedHistory.messages[0].content = 'Changed earlier instruction';
  const changedSystem = continuation(turn); changedSystem.system = 'Changed system';
  const changedSchema = continuation(turn); changedSchema.tools[0].input_schema.properties.path.type = 'number';
  const changedArguments = continuation(turn); changedArguments.messages.at(-2).content[0].input.path = 'other.txt';
  const changedName = continuation(turn); changedName.messages.at(-2).content[0].name = 'write_file';
  for (const body of [changedHistory, changedSystem, changedSchema, changedArguments, changedName]) {
    const response = await context.request(body);
    assert.equal(response.status, 409); await response.json();
    assert.equal(turn.settled(), false);
    assert.equal((await context.provider.status()).pendingTools, 1);
  }
  const next = await context.request(continuation(turn));
  await turn.pending; finish(turn.channel); await events(next); await next.bridgeUsage;
});

test('an ACK delayed until stream close cannot deadlock a new turn or its VM tool round trip', async t => {
  const context = await fixture(t, { delayedAck: true });
  const turn = await pausedTool(context);
  assert.equal(turn.channel.acknowledged, false);
  const next = await deadline(context.request(continuation(turn)), 'Tool continuation waited for delayed chat_send ACK.');
  await deadline(turn.pending, 'Delayed ACK blocked MCP completion.');
  assert.equal(turn.channel.acknowledged, false);
  finish(turn.channel); await events(next); await next.bridgeUsage;
});

test('a real client tool argument named cache_control cannot be changed in the VM continuation', async t => {
  const context = await fixture(t);
  const turn = await pausedTool(context, { arguments: { path: 'vm-only.txt', cache_control: 'original-argument' } });
  const changed = continuation(turn);
  changed.messages.at(-2).content[0].input.cache_control = 'changed-argument';
  const rejected = await context.request(changed);
  assert.equal(rejected.status, 409, 'API cache hints must not erase semantic tool arguments from integrity checks.');
  await rejected.json();
  assert.equal(turn.settled(), false);
  const next = await context.request(continuation(turn));
  await turn.pending; finish(turn.channel); await events(next); await next.bridgeUsage;
});

test('aborting the external HTTP signal cancels and closes the With run', async t => {
  const { request, daemon, provider } = await fixture(t);
  const controller = new AbortController();
  const response = await request(input, controller.signal);
  daemon.channels[0].emit({ type: 'TEXT_MESSAGE_START', rawEvent: { message_id: 'native-message-mock' } });
  controller.abort();
  const wire = await events(response);
  assert.equal(wire.some(item => item.type === 'error'), true);
  await response.bridgeUsage;
  assert.equal(daemon.cancelled.length, 1); assert.equal(daemon.channels[0].closeCalls, 1);
  assert.deepEqual(daemon.cancelled[0], { session_id: daemon.channels[0].params.session_id,
    message_id: 'native-message-mock', disconnect_only: false });
  assert.equal((await provider.status()).sessions, 0);
});

test('cancelling the response body terminates the With run and settles its usage promise', async t => {
  const { request, daemon, provider } = await fixture(t);
  const response = await request();
  await response.body.cancel(); await deadline(response.bridgeUsage, 'Cancelled stream left accounting pending.');
  assert.equal(daemon.cancelled.length, 1); assert.equal(daemon.channels[0].closeCalls, 1);
  assert.equal((await provider.status()).sessions, 0);
});

test('an MCP transport disconnect cancels the session instead of inventing a tool result', async t => {
  const context = await fixture(t);
  const body = { ...structuredClone(input), tools: [structuredClone(tool)] };
  const response = await context.request(body), channel = context.daemon.channels[0];
  const requestId = /request_id=([^\s,]+)/.exec(channel.params.message)[1];
  const controller = new AbortController();
  const pending = context.rpc('tools/call', { name: 'delegate_vm_tool', arguments: {
    request_id: requestId, name: 'read_file', arguments: { path: 'vm-only.txt' },
  } }, { signal: controller.signal });
  pending.catch(() => {});
  await events(response); await response.bridgeUsage;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await until(() => context.daemon.cancelled.length === 1, 'MCP disconnect did not cancel With.');
  assert.equal((await context.provider.status()).pendingTools, 0);
});

test('a rejected daemon stream emits an error and clears the session', async t => {
  const { request, daemon, provider } = await fixture(t);
  const response = await request(); daemon.channels[0].closed.reject(new Error('mock transport disconnected'));
  const wire = await events(response);
  assert.equal(wire.some(item => item.type === 'error'), true);
  assert.equal(wire.some(item => item.type === 'message_stop'), false);
  await response.bridgeUsage;
  assert.equal((await provider.status()).sessions, 0); assert.equal(daemon.cancelled.length, 1);
});

test('a native host tool request is cancelled instead of being delegated or reported as completed', async t => {
  for (const event of [
    { type: 'TOOL_CALL_START', toolCallName: 'run_terminal' },
    { type: 'TOOL_CALL_START', toolCallName: 'other_server.delegate_vm_tool' },
    { type: 'TOOL_CALL_START', toolCallName: 'mcp__other_server__delegate_vm_tool' },
    { type: 'TOOL_CALL_START', toolCallName: 'delegate_vm_tool', rawEvent: { server_name: 'other_server' } },
  ]) {
    const { request, daemon, provider } = await fixture(t);
    const response = await request();
    daemon.channels[0].emit(event);
    const wire = await events(response);
    assert.equal(wire.some(item => item.type === 'error'), true);
    assert.equal(wire.some(item => item.type === 'message_stop'), false);
    await response.bridgeUsage;
    assert.equal(daemon.cancelled.length, 1); assert.equal(daemon.channels[0].closeCalls, 1);
    assert.equal((await provider.status()).pendingTools, 0);
  }
});

test('a forbidden tool event arriving synchronously during chat_send still closes the returned channel', async t => {
  const { request, daemon } = await fixture(t, { initialEvents: [{ type: 'TOOL_CALL_START', toolCallName: 'run_terminal' }] });
  const response = await request();
  const wire = await events(response);
  assert.equal(wire.some(item => item.type === 'error'), true);
  await response.bridgeUsage;
  assert.equal(daemon.cancelled.length, 1);
  assert.equal(daemon.channels[0].closeCalls, 1, 'Early cancellation must close the handle returned after the event.');
});

test('already-aborted requests cannot start a With chat', async t => {
  const { request, daemon } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  const outcome = await request(input, controller.signal).catch(error => error);
  if (outcome instanceof Response) { await outcome.body?.cancel(); await outcome.bridgeUsage; }
  assert.equal(daemon.channels.length, 0, 'A cancelled caller must not dispatch a model request.');
});

test('cancellation while creating a session prevents a later chat_send', async t => {
  const createGate = deferred();
  const { request, daemon } = await fixture(t, { createGate });
  const controller = new AbortController();
  const pending = request(input, controller.signal).catch(error => error);
  await until(() => daemon.created.length === 1, 'Session creation was not entered.');
  controller.abort(); createGate.resolve();
  const outcome = await pending;
  if (outcome instanceof Response) { await outcome.body?.cancel(); await outcome.bridgeUsage; }
  assert.equal(daemon.channels.length, 0, 'Session creation must not dispatch a chat after caller cancellation.');
});

test('initial images, Anthropic server tools, and authoritative token counting fail explicitly', async t => {
  const { request, daemon, provider } = await fixture(t);
  const image = { ...structuredClone(input), messages: [{ role: 'user', content: [{ type: 'image', source: {
    type: 'base64', media_type: 'image/png', data: 'mock-only',
  } }] }] };
  const serverTool = { ...structuredClone(input), tools: [{ type: 'web_search_20250305', name: 'web_search' }] };
  for (const body of [image, serverTool]) {
    const response = await request(body); assert.equal(response.status, 501); await response.json();
  }
  const counted = await provider.request({ path: '/v1/messages/count_tokens', body: input });
  assert.equal(counted.status, 501); await counted.json();
  assert.equal(daemon.created.length, 0); assert.equal(daemon.channels.length, 0);
});

test('the virtual MCP endpoint rejects wrong origins, hosts, keys, and unknown request identities', async t => {
  const { rpc, daemon } = await fixture(t);
  for (const headers of [{ Origin: 'https://untrusted.example' }, { Host: 'evil.example' }, { Authorization: 'Bearer unrelated' }]) {
    assert.equal((await rpc('tools/list', {}, { headers })).status, 403);
  }
  const unknown = await rpc('tools/call', { name: 'delegate_vm_tool', arguments: {
    request_id: randomUUID(), name: 'read_file', arguments: { path: 'must-not-run' },
  } });
  assert.equal(unknown.body.result.isError, true);
  assert.equal(daemon.channels.length, 0);
});
