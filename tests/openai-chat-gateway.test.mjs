import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeGatewayServer, ChatHistoryStore, translateChatRequest } from '../src/openai-chat-gateway.mjs';
import { ClaudeCliHub } from '../src/claude-cli-provider.mjs';
import http from 'node:http';
import { Readable } from 'node:stream';

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => resolve(new Response(Readable.toWeb(response), {
      status: response.statusCode, headers: response.headers,
    })));
    request.on('error', reject); request.end(options.body);
  });
}

const model = 'claude-vm-fixture', key = 'fixture-client-key-'.repeat(3);
const encode = events => new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
function reply(blocks = [{ type: 'text', text: '你好 🌍' }], reason = 'end_turn') {
  return [{ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [],
    usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
  ...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 4 } }, { type: 'message_stop' }];
}
function response(events) { return new Response(encode(events), { headers: { 'content-type': 'text/event-stream' } }); }
async function fixture(t, { request, history, provider } = {}) {
  const calls = [];
  const backend = provider ?? { status: async () => ({ ready: true, modelAvailable: true }), request: async value => {
    calls.push(value); return request ? request(value, calls.length) : response(reply());
  } };
  const server = createClaudeGatewayServer({ gatewayKey: key, allowedHosts: ['fixture'], allowedPeers: ['127.0.0.1'],
    routes: [{ account: 'Claude', model: { id: model, name: 'Fixture', upstream: 'fixture-sonnet' }, provider: backend }] }, { history });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  const send = (body = { model, messages: [{ role: 'user', content: 'Hello' }] }, options = {}) => httpFetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { host: 'fixture', authorization: `Bearer ${key}`, 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body), signal: options.signal,
  });
  return { server, calls, send };
}

test('JSON maps text, cache-inclusive usage and finish reason without invoking a real CLI', async t => {
  const f = await fixture(t), result = await f.send();
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.choices[0].message.content, '你好 🌍');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } });
  assert.equal(f.calls[0].body.model, 'fixture-sonnet');
  assert.equal(f.calls[0].body.thinking.type, 'disabled');
});

test('streaming survives split UTF-8 and emits usage followed by exactly one DONE', async t => {
  const bytes = encode(reply());
  const f = await fixture(t, { request: () => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const stream = await (await f.send({ model, messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true } })).text();
  const frames = stream.trim().split('\n\n').map(frame => frame.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  assert.equal(frames.filter(frame => frame === '[DONE]').length, 1);
  const data = frames.slice(0, -1).map(JSON.parse);
  assert.equal(data[0].choices[0].delta.role, 'assistant');
  assert.equal(data.find(item => item.choices[0]?.delta.content === '你好 🌍').choices[0].delta.content, '你好 🌍');
  assert.equal(data.at(-1).usage.total_tokens, 19);
});

test('parallel tool results restore exact interleaved native blocks and signed thinking after persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'history.json'), history = new ChatHistoryStore({ path });
  const canonical = [{ type: 'thinking', thinking: 'Consider both files', signature: 'PRIVATE_SIGNATURE' },
    { type: 'text', text: 'First ' }, { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a' } },
    { type: 'text', text: 'second' }, { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b' } }];
  const f = await fixture(t, { history, request: () => response(reply(canonical, 'tool_use')) });
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const original = { model, messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Read both' }], tools, reasoning_effort: 'high' };
  const first = await (await f.send(original)).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  assert.equal(first.choices[0].message.tool_calls.length, 2);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_SIGNATURE'));
  // Windows stat.mode does not describe the file's ACL.
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const restored = new ChatHistoryStore({ path }); await restored.load();
  const request = translateChatRequest({ ...original, messages: [...original.messages, first.choices[0].message,
    { role: 'tool', tool_call_id: 'call_a', content: 'A content' }, { role: 'tool', tool_call_id: 'call_b', content: 'B content' }] }, restored);
  assert.deepEqual(request.body.messages[1].content, canonical);
  assert.deepEqual(request.body.messages[2].content.map(block => block.tool_use_id), ['call_a', 'call_b']);
  assert.equal(request.body.messages.length, 3);
});

test('generation changes preserve completed signed history while applying new output settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-chat-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'history.json'), history = new ChatHistoryStore({ path });
  const canonical = [{ type: 'thinking', thinking: 'Earlier readable reasoning.', signature: 'PERSISTED_THINKING_SIGNATURE' },
    { type: 'text', text: 'Completed answer.' }];
  const f = await fixture(t, { history, request: () => response(reply(canonical)) });
  const identity = 'generation-fixture';
  const original = { model, max_tokens: 128, reasoning_effort: 'high', messages: [{ role: 'user', content: 'Initial request.' }] };
  const first = await (await f.send(original, { headers: { 'x-session-id': identity } })).json();
  const loaded = new ChatHistoryStore({ path }); await loaded.load();
  const next = { ...original, max_tokens: 256, reasoning_effort: 'low',
    messages: [...original.messages, first.choices[0].message, { role: 'user', content: 'Next request.' }] };
  const translated = translateChatRequest(next, loaded, identity);
  assert.deepEqual(translated.body.messages[1].content, canonical);
  assert.equal(translated.body.max_tokens, 256); assert.equal(translated.body.output_config.effort, 'low');
  assert.notDeepEqual(translateChatRequest(next, loaded, 'another-caller').body.messages[1].content, canonical);

  const legacy = new ChatHistoryStore();
  const oldContext = { ...translated.context, maxTokens: 128, effort: 'high' };
  await legacy.save(legacy.keys(oldContext, translated.normalized.slice(0, -1)).at(-1), translated.body.messages.slice(0, 2));
  const unchanged = translateChatRequest({ ...next, max_tokens: 128, reasoning_effort: 'high' }, legacy, identity);
  assert.deepEqual(unchanged.body.messages[1].content, canonical, 'Existing generation-bound snapshots must remain readable.');
});

test('tool argument deltas become indexed OpenAI calls and replayable JSON', async t => {
  const events = reply([], 'tool_use');
  events.splice(1, 0,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_x', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x"}' } }, { type: 'content_block_stop', index: 0 });
  const f = await fixture(t, { request: () => response(events) });
  const text = await (await f.send({ model, messages: [{ role: 'user', content: 'Read x' }], stream: true })).text();
  const chunks = text.trim().split('\n\n').slice(0, -1).map(frame => JSON.parse(frame.slice(6)));
  const calls = chunks.flatMap(chunk => chunk.choices[0]?.delta.tool_calls ?? []);
  assert.equal(calls[0].id, 'call_x'); assert.ok(calls.every(call => call.index === 0));
  assert.deepEqual(JSON.parse(calls.map(call => call.function?.arguments ?? '').join('')), { path: 'x' });
});

test('tool-only dash placeholders restore persisted native blocks only for the exact original context and calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-chat-placeholder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'history.json'), history = new ChatHistoryStore({ path });
  const canonical = [{ type: 'thinking', thinking: 'Read the fixture', signature: 'PRIVATE_TOOL_SIGNATURE' },
    { type: 'tool_use', id: 'call_read', name: 'read_file', input: { path: 'check.txt' } }];
  const f = await fixture(t, { history, request: () => response(reply(canonical, 'tool_use')) });
  const identity = 'fixture-conversation';
  const base = { model, messages: [{ role: 'system', content: 'Read only' }, { role: 'user', content: 'Read check.txt' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
  const first = await (await f.send(base, { headers: { 'x-session-id': identity } })).json();
  const assistant = first.choices[0].message;
  assert.equal(assistant.content, null);
  assert.ok(!JSON.stringify(first).includes('PRIVATE_TOOL_SIGNATURE'));
  const wire = { ...base, messages: [...base.messages, { ...assistant, content: '-' },
    { role: 'tool', tool_call_id: 'call_read', content: 'FIXTURE_CONTENT' }] };
  const restored = new ChatHistoryStore({ path }); await restored.load();
  const translated = translateChatRequest(wire, restored, identity);
  assert.deepEqual(translated.body.messages[1].content, canonical);
  assert.equal(translated.body.messages[2].content[0].tool_use_id, 'call_read');
  assert.equal(wire.messages[2].content, '-');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);

  const differentText = structuredClone(wire); differentText.messages[2].content = 'Additional assistant instructions';
  const differentArgs = structuredClone(wire); differentArgs.messages[2].tool_calls[0].function.arguments = '{"path":"other.txt"}';
  const differentSystem = structuredClone(wire); differentSystem.messages[0].content = 'Different instructions';
  const differentUser = structuredClone(wire); differentUser.messages[1].content = 'Read another fixture';
  const differentTools = structuredClone(wire); differentTools.tools[0].function.description = 'A different tool contract';
  for (const changed of [differentText, differentArgs, differentSystem, differentUser, differentTools, { ...wire, model: 'other-model' }]) {
    assert.notDeepEqual(translateChatRequest(changed, restored, identity).body.messages[1].content, canonical);
  }
  assert.notDeepEqual(translateChatRequest(wire, restored, 'another-conversation').body.messages[1].content, canonical);
});

test('actual assistant text is never made equivalent to an empty tool-only reply', async t => {
  const history = new ChatHistoryStore();
  const canonical = [{ type: 'text', text: '-' }, { type: 'tool_use', id: 'call_text', name: 'read_file', input: {} }];
  const f = await fixture(t, { history, request: () => response(reply(canonical, 'tool_use')) });
  const base = { model, messages: [{ role: 'user', content: 'Read' }] };
  const first = await (await f.send(base)).json();
  assert.equal(first.choices[0].message.content, '-');
  const changed = { ...base, messages: [...base.messages, { ...first.choices[0].message, content: null },
    { role: 'tool', tool_call_id: 'call_text', content: 'result' }] };
  assert.notDeepEqual(translateChatRequest(changed, history).body.messages[1].content, canonical);
  assert.equal(history.records.size, 1);
});

test('bad credentials, hostile Host and unsupported options never reach a provider', async t => {
  const f = await fixture(t), base = { model, messages: [{ role: 'user', content: 'Hi' }] };
  assert.equal((await f.send(base, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.send(base, { headers: { host: 'evil.invalid' } })).status, 403);
  for (const extra of [{ temperature: .7 }, { model: 'not-configured' }, { tools: [{ type: 'web_search' }] },
    { tool_choice: 'required' }, { n: 2 }, { response_format: { type: 'json_schema' } }]) {
    assert.equal((await f.send({ ...base, ...extra })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('not logged in is a clear 503 and never a fake model answer', async t => {
  const f = await fixture(t, { request: () => Response.json({ type: 'error' }, { status: 503 }) });
  const result = await f.send(); assert.equal(result.status, 503);
  assert.match((await result.json()).error.message, /login inside the virtual machine/);
});

test('truncated upstream stream produces an error and no successful DONE marker', async t => {
  const f = await fixture(t, { request: () => response(reply().slice(0, -1)) });
  const value = await (await f.send({ model, messages: [{ role: 'user', content: 'Hi' }], stream: true })).text();
  assert.match(value, /"error"/); assert.ok(!value.includes('[DONE]'));
});

test('client cancellation cancels upstream reading and aborts the provider signal', async t => {
  let signal, cancelled = false;
  const f = await fixture(t, { request: value => {
    signal = value.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encode(reply().slice(0, 1))); },
      cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const abort = new AbortController();
  const result = await f.send({ model, messages: [{ role: 'user', content: 'Hi' }], stream: true }, { signal: abort.signal });
  const reader = result.body.getReader(); await reader.read(); abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !cancelled; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

for (const toolOnlyPlaceholder of [false, true]) test(`chat adapter continues a real ClaudeCliHub tool round through its permission-controlled client MCP${toolOnlyPlaceholder ? ' with a client dash placeholder' : ''}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-chat-hub-')), workers = [];
  class Worker {
    queue = []; waiters = []; sends = []; sessionId = '12345678-1234-1234-1234-123456789abc';
    events = { [Symbol.asyncIterator]: () => ({ next: () => this.queue.length ? Promise.resolve(this.queue.shift())
      : new Promise(done => this.waiters.push(done)) }) };
    constructor(options) { this.options = options; }
    async start() {}
    async send(value) { this.sends.push(value); }
    push(value) { const next = this.waiters.shift(); if (next) next(value); else this.queue.push(value); }
    emit(event) { this.push({ value: { type: 'stream_event', event }, done: false }); }
    async close() { this.push({ done: true }); }
  }
  const hub = new ClaudeCliHub({ binary: join(root, 'fake'), configDir: join(root, '.claude'), profileDir: root, stateDir: join(root, 'state'),
    mcpPort: 0, authStatus: async () => true, workerFactory: options => { const worker = new Worker(options); workers.push(worker); return worker; } });
  await hub.start();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const f = await fixture(t, { provider: hub.provider('fixture-sonnet') });
  const input = { model, messages: [{ role: 'user', content: 'Read a' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] };
  const firstPending = f.send(input);
  for (let i = 0; i < 100 && !workers[0]?.sends.length; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(workers.length, 1);
  const worker = workers[0];
  for (const event of reply([...(toolOnlyPlaceholder ? [] : [{ type: 'text', text: 'Reading ' }]),
    { type: 'tool_use', id: 'tool_native', name: 'mcp__client__read_file', input: { path: 'a' } }], 'tool_use')) worker.emit(event);
  const first = await (await firstPending).json();
  assert.equal(first.choices[0].message.tool_calls[0].function.name, 'read_file');
  const mcpPending = fetch(worker.options.mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${worker.options.mcpKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' }, _meta: { 'claudecode/toolUseId': 'tool_native' } } }) });
  const assistant = first.choices[0].message;
  if (toolOnlyPlaceholder) assert.equal(assistant.content, null);
  const secondPending = f.send({ ...input, messages: [...input.messages,
    toolOnlyPlaceholder ? { ...assistant, content: '-' } : assistant,
    { role: 'tool', tool_call_id: 'tool_native', content: 'Contents of a' }] });
  const mcp = await mcpPending;
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).result.content[0].text, 'Contents of a');
  for (const event of reply()) worker.emit(event);
  worker.push({ value: { type: 'result', subtype: 'success', is_error: false }, done: false });
  const second = await (await secondPending).json();
  assert.equal(second.choices[0].message.content, '你好 🌍');
  assert.equal(workers.length, 1);
});
