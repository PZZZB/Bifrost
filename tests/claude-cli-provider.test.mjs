import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliHub } from '../src/claude-cli-provider.mjs';

const model = 'claude-opus-fixture';
const tool = { name: 'read_file', description: 'Client permission controls this operation.', input_schema: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} };
const input = { model, max_tokens: 128, messages: [{ role: 'user', content: 'Fixture question.' }] };

class Events {
  values = [];
  readers = [];
  ended = false;
  push(value) {
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false }); else this.values.push(value);
  }
  end() {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ done: true });
  }
  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise(resolve => this.readers.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
}

class Worker {
  events = new Events();
  sends = [];
  starts = 0;
  closes = 0;
  constructor(options, startFailure = false, startGate = async () => {}) {
    this.options = options;
    this.sessionId = options.resumeSessionId ?? randomUUID();
    this.startFailure = startFailure;
    this.startGate = startGate;
  }
  async start() {
    this.starts++;
    if (this.startFailure) throw new Error('Private worker fixture failure.');
    await this.startGate(this.options);
  }
  async send(value) { this.sends.push(structuredClone(value)); }
  async close() { this.closes++; this.events.end(); }
  emit(event) { this.events.push({ type: 'stream_event', event }); }
  result(overrides = {}) { this.events.push({ type: 'result', subtype: 'success', is_error: false, ...overrides }); }
}

async function until(predicate, message = 'Fixture did not reach its expected state.') {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function fixture(testContext, { authenticated = true, workerStartFailure = false, idleMs = 3_600_000,
  workerStartGate } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-hub-fixture-'));
  const workers = [], hubs = [];
  let current, clock = 1000, authCalls = 0;
  const build = () => new ClaudeCliHub({ binary: join(root, 'not-a-real-cli.exe'),
    configDir: join(root, 'profile', '.claude'), profileDir: join(root, 'profile'), stateDir: join(root, 'state'),
    mcpPort: 0, idleMs, clock: () => clock, authStatus: async () => { authCalls++; return authenticated; },
    workerFactory: options => { const worker = new Worker(options, workerStartFailure, workerStartGate); workers.push(worker); return worker; } });
  current = build(); hubs.push(current); await current.start();
  testContext.after(async () => { for (const hub of hubs) await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workers, get hub() { return current; }, authCalls: () => authCalls,
    advanceClock(value) { clock += value; },
    setAuthenticated(value) { authenticated = value; clock += 31_000; },
    request(body = input, { identity = 'client-session-one', agent, parent, signal, path = '/v1/messages' } = {}) {
      const headers = new Headers(identity === null ? {} : { 'x-claude-code-session-id': identity });
      if (agent !== undefined) headers.set('x-claude-code-agent-id', agent);
      if (parent !== undefined) headers.set('x-claude-code-parent-agent-id', parent);
      return current.provider(body.model).request({ path, body: structuredClone(body), signal,
        headers });
    },
    async restart() { await current.close(); current = build(); hubs.push(current); await current.start(); },
  };
}

function startMessage(worker, usage = {}) {
  worker.emit({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, ...usage } } });
}

function answer(worker, text = 'Fixture answer.', { output = 4, input = 10, resultUsage = 1000 } = {}) {
  startMessage(worker, { input_tokens: input });
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  worker.emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  worker.emit({ type: 'content_block_stop', index: 0 });
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } });
  worker.emit({ type: 'message_stop' });
  worker.result({ usage: { input_tokens: resultUsage, output_tokens: resultUsage } });
}

function truncateAnswer(worker, text = 'First truncated answer.') {
  startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  worker.emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  worker.emit({ type: 'content_block_stop', index: 0 });
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } });
  worker.emit({ type: 'message_stop' });
}

function callTools(worker, calls) {
  startMessage(worker);
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    worker.emit({ type: 'content_block_start', index,
      content_block: { type: 'tool_use', id: call.id, name: `mcp__client__${call.name ?? tool.name}`, input: {} } });
    worker.emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    worker.emit({ type: 'content_block_stop', index });
  }
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } });
  worker.emit({ type: 'message_stop' });
}

function continuation(body, message, content) {
  return { ...structuredClone(body), messages: [...structuredClone(body.messages),
    { role: 'assistant', content: structuredClone(message.content) }, { role: 'user', content }] };
}

async function completed(state, body = input, { workerIndex = state.workers.length, ...options } = {}) {
  const pending = state.request(body, options);
  await until(() => state.workers[workerIndex]?.sends.length);
  const worker = state.workers[workerIndex]; answer(worker);
  const response = await pending;
  assert.equal(response.status, 200);
  return { worker, message: await response.json(), body };
}

function rpc(worker, method, params, { headers = {}, requestMethod = 'POST' } = {}) {
  const address = new URL(worker.options.mcpUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method: requestMethod, headers: {
      authorization: `Bearer ${worker.options.mcpKey}`, 'content-type': 'application/json', ...headers,
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, value: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }));
  });
}

const toolParams = (id, args = { path: 'fixture.txt' }, name = tool.name) => ({ name, arguments: args,
  _meta: { 'claudecode/toolUseId': id } });

async function toolTurn(state, calls = [{ id: 'tool-one', input: { path: 'fixture.txt' } }]) {
  const body = { ...input, tools: [tool] };
  const pending = state.request(body);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0]; callTools(worker, calls);
  const response = await pending;
  assert.equal(response.status, 200);
  return { worker, body, message: await response.json() };
}

test('single-turn JSON uses stream usage without replacing it with cumulative SDK result usage', async t => {
  const state = await fixture(t);
  const { worker, message } = await completed(state);
  assert.deepEqual(worker.sends, ['Fixture question.']);
  assert.equal(message.content[0].text, 'Fixture answer.');
  assert.equal(message.usage.input_tokens, 10);
  assert.equal(message.usage.output_tokens, 4);
  assert.equal(message.usage.cache_read_input_tokens, 3);
  assert.equal(worker.starts, 1);
});

test('normal continuation sends only new user input to the same native session', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const secondBody = continuation(input, first.message, 'Second question.');
  const pending = state.request(secondBody);
  await until(() => first.worker.sends.length === 2);
  answer(first.worker, 'Second answer.', { input: 7, output: 3, resultUsage: 99999 });
  const response = await pending; assert.equal(response.status, 200);
  const second = await response.json();
  assert.equal(state.workers.length, 1);
  assert.deepEqual(first.worker.sends, ['Fixture question.', 'Second question.']);
  assert.equal(second.usage.input_tokens, 7); assert.equal(second.usage.output_tokens, 3);
});

test('moving cache breakpoint hints does not rebuild an unchanged native conversation', async t => {
  const state = await fixture(t);
  const body = { ...input,
    system: [{ type: 'text', text: 'Fixture system.', cache_control: { type: 'ephemeral' } }],
    tools: [{ ...tool, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture question.', cache_control: { type: 'ephemeral' } }] }],
  };
  const first = await completed(state, body);
  const nextBody = continuation(body, first.message, [{ type: 'text', text: 'New cached question.',
    cache_control: { type: 'ephemeral' } }]);
  delete nextBody.system[0].cache_control;
  delete nextBody.tools[0].cache_control;
  delete nextBody.messages[0].content[0].cache_control;
  const pending = state.request(nextBody);
  await until(() => first.worker.sends.length === 2 || state.workers[1]?.sends.length);
  assert.equal(state.workers.length, 1);
  assert.deepEqual(first.worker.sends[1], nextBody.messages.at(-1).content);
  answer(first.worker); assert.equal((await pending).status, 200);
});

test('a meaningful schema property named cache_control still isolates tool contexts', async t => {
  const state = await fixture(t);
  const body = { ...input, tools: [{ ...tool, input_schema: { type: 'object',
    properties: { cache_control: { type: 'string', enum: ['original'] } } } }] };
  const first = await completed(state, body);
  const nextBody = continuation(body, first.message, 'Different schema meaning.');
  nextBody.tools[0].input_schema.properties.cache_control.enum = ['changed'];
  const next = state.request(nextBody);
  await until(() => first.worker.sends.length === 2 || state.workers[1]?.sends.length);
  assert.equal(state.workers.length, 2);
  assert.equal(state.workers[1].options.resumeSessionId, undefined);
  answer(state.workers[1]); assert.equal((await next).status, 200);
});

test('an imported history is rebuilt explicitly once and later turns are incremental', async t => {
  const state = await fixture(t);
  const imported = { ...input, messages: [{ role: 'user', content: 'Earlier user.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier assistant.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Current question.' }] }] };
  const first = await completed(state, imported);
  assert.equal(first.worker.options.resumeSessionId, undefined);
  assert.deepEqual(first.worker.sends[0], [
    { type: 'text', text: '[Imported user history]' }, { type: 'text', text: 'Earlier user.' },
    { type: 'text', text: '[/Imported history]' },
    { type: 'text', text: '[Imported assistant history]' }, { type: 'text', text: 'Earlier assistant.' },
    { type: 'text', text: '[/Imported history]' }, { type: 'text', text: 'Current question.' },
  ]);
  const next = state.request(continuation(imported, first.message, 'New incremental question.'));
  await until(() => first.worker.sends.length === 2); answer(first.worker);
  assert.equal((await next).status, 200);
  assert.equal(first.worker.sends[1], 'New incremental question.');
});

test('imported image and document history retain their original content blocks', async t => {
  const state = await fixture(t);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } };
  const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'ZG9jdW1lbnQ=' },
    title: 'Fixture document' };
  const body = { ...input, messages: [{ role: 'user', content: [image, document] },
    { role: 'assistant', content: 'Earlier description.' }, { role: 'user', content: 'Continue.' }] };
  const first = await completed(state, body);
  assert.deepEqual(first.worker.sends[0].filter(block => ['image', 'document'].includes(block.type)), [image, document]);
  assert.equal(first.worker.sends[0].at(-1).text, 'Continue.');
});

for (const stream of [false, true]) test(`fresh ${stream ? 'SSE' : 'JSON'} history imports omit opaque reasoning bytes without losing readable history`, async t => {
  const state = await fixture(t);
  const signature = 'OPAQUE_SIGNATURE_FIXTURE_' + 'S'.repeat(480_000);
  const redacted = 'OPAQUE_REDACTED_FIXTURE_' + 'R'.repeat(320_000);
  const blocks = [
    { type: 'thinking', thinking: 'Readable earlier reasoning.', signature },
    { type: 'thinking', thinking: '', signature },
    { type: 'redacted_thinking', data: redacted },
    { type: 'text', text: 'Earlier assistant decision.' },
    { type: 'tool_use', id: 'historical-tool', name: 'read_file', input: { path: 'fixture.txt' } },
  ];
  const result = { type: 'tool_result', tool_use_id: 'historical-tool', content: 'Exact earlier tool result.', is_error: true };
  const body = { ...input, stream, tools: [], tool_choice: { type: 'none' }, messages: [
    { role: 'user', content: 'Earlier task.' }, { role: 'assistant', content: blocks },
    { role: 'user', content: [result] }, { role: 'assistant', content: 'Keep the decision and failure.' },
    { role: 'user', content: 'Summarize the work.' },
  ] };
  const original = structuredClone(body), pending = state.request(body);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0], sent = JSON.stringify(worker.sends[0]);
  assert.doesNotMatch(sent, /OPAQUE_SIGNATURE_FIXTURE_|OPAQUE_REDACTED_FIXTURE_/);
  assert.ok(Buffer.byteLength(sent) < 2000, 'Opaque protocol bytes must not inflate the imported user prompt.');
  assert.ok(worker.sends[0].some(block => block.text === JSON.stringify({ type: 'thinking', thinking: blocks[0].thinking })));
  assert.ok(worker.sends[0].some(block => block.text === blocks[3].text));
  assert.ok(worker.sends[0].some(block => block.text === JSON.stringify(blocks[4])));
  assert.ok(worker.sends[0].some(block => block.text === result.content));
  assert.ok(worker.sends[0].some(block => block.text?.includes('"tool_use_id":"historical-tool"') && block.text.includes('"is_error":true')));
  assert.equal(worker.sends[0].at(-1).text, 'Summarize the work.');
  assert.deepEqual((await rpc(worker, 'tools/list')).value.result.tools, []);
  answer(worker); const response = await pending;
  assert.equal(response.status, 200);
  const wire = await response.text();
  if (stream) assert.match(wire, /event: message_stop/);
  else assert.equal(JSON.parse(wire).stop_reason, 'end_turn');
  assert.deepEqual(body, original, 'The original signed history must remain intact.');
});

test('history import does not redact ordinary text or tool data that resembles a thinking block', async t => {
  const state = await fixture(t);
  const literal = JSON.stringify({ type: 'thinking', thinking: 'Fixture data.', signature: 'literal-user-data' });
  const toolResult = { type: 'tool_result', tool_use_id: 'old-tool', content: literal };
  const body = { ...input, messages: [{ role: 'user', content: literal },
    { role: 'assistant', content: [{ type: 'text', text: literal }] },
    { role: 'user', content: [toolResult] }, { role: 'assistant', content: 'Preserve the fixture.' },
    { role: 'user', content: 'Continue.' }] };
  const first = await completed(state, body);
  assert.equal(first.worker.sends[0].filter(block => block.text === literal).length, 3);
  assert.ok(first.worker.sends[0].some(block => block.text?.includes('"tool_use_id":"old-tool"')));
});

test('imported tool result media remain native blocks instead of base64 prompt text', async t => {
  const state = await fixture(t);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1h'.repeat(32_000) } };
  const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'ZG9j'.repeat(32_000) } };
  const text = 'Exact command output: "quoted"\n\\path\n'.repeat(20);
  const blocks = [{ type: 'tool_result', tool_use_id: 'old-image', is_error: true,
    content: [{ type: 'text', text }, image, document, { type: 'fixture_extension', value: 'Keep unknown historical data.' }] },
  { type: 'tool_result', tool_use_id: 'old-text', content: text }];
  const body = { ...input, messages: [{ role: 'user', content: blocks },
    { role: 'assistant', content: 'Previously inspected results.' }, { role: 'user', content: 'Continue.' }] };
  const original = structuredClone(body), first = await completed(state, body), sent = first.worker.sends[0];
  assert.deepEqual(sent.filter(block => ['image', 'document'].includes(block.type)), [image, document]);
  assert.equal(sent.filter(block => block.type === 'text' && block.text === text).length, 2);
  assert.ok(sent.some(block => block.text?.includes('"tool_use_id":"old-image"') && block.text.includes('"is_error":true')));
  const texts = sent.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.ok(!texts.includes(image.source.data) && !texts.includes(document.source.data));
  assert.ok(texts.includes(JSON.stringify(blocks[0].content[3])), 'Unknown result data must not disappear.');
  assert.deepEqual(body, original);
});

test('signed ordinary replies retain exact native continuation across a hub restart', async t => {
  const state = await fixture(t), pending = state.request(input);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0], signature = 'NATIVE_REASONING_SIGNATURE_FIXTURE';
  startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  worker.emit({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Readable native reasoning.' } });
  worker.emit({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } });
  worker.emit({ type: 'content_block_stop', index: 0 });
  worker.emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Native answer.' } });
  worker.emit({ type: 'content_block_stop', index: 1 });
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
  worker.emit({ type: 'message_stop' }); worker.result();
  const message = await (await pending).json();
  assert.equal(message.content[0].signature, signature);
  await state.restart();
  const body = continuation(input, message, 'Incremental continuation.'), original = structuredClone(body);
  const next = state.request(body);
  await until(() => state.workers[1]?.sends.length);
  assert.equal(state.workers[1].options.resumeSessionId, worker.sessionId);
  assert.deepEqual(state.workers[1].sends, ['Incremental continuation.']);
  answer(state.workers[1]); assert.equal((await next).status, 200);
  assert.deepEqual(body, original);
});

test('a completed ordinary session resumes natively after hub restart', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  await state.restart();
  const body = continuation(input, first.message, 'After restart.');
  const next = state.request(body);
  await until(() => state.workers[1]?.sends.length);
  assert.equal(state.workers[1].options.resumeSessionId, first.worker.sessionId);
  assert.deepEqual(state.workers[1].sends, ['After restart.']);
  answer(state.workers[1]); assert.equal((await next).status, 200);
});

test('a worker that exits after a completed turn is replaced through native resume', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const run = [...state.hub.runs.values()][0];
  first.worker.events.end();
  await run.pump;
  const next = await state.request({ ...continuation(input, first.message, 'After native worker exit.'), stream: true });
  await until(() => first.worker.sends.length === 2 || state.workers[1]?.sends.length);
  assert.equal(state.workers.length, 2);
  assert.equal(state.workers[1].options.resumeSessionId, first.worker.sessionId);
  assert.deepEqual(state.workers[1].sends, ['After native worker exit.']);
  answer(state.workers[1]); assert.doesNotMatch(await next.text(), /event: error/);
});

test('concurrent requests cannot claim the same saved native session twice', async t => {
  let releaseStart;
  const gate = new Promise(resolve => { releaseStart = resolve; });
  const state = await fixture(t, { workerStartGate: async options => { if (options.resumeSessionId) await gate; } });
  const first = await completed(state);
  await state.restart();
  const body = continuation(input, first.message, 'Concurrent saved continuation.');
  const pending = [state.request(body), state.request(body)];
  try {
    // Starting a saved session holds the creation lock. Release its worker
    // before waiting for the competing request to observe the claimed index.
    await until(() => state.workers[1]?.starts === 1);
  } finally { releaseStart(); }
  await until(() => state.workers.slice(1).every(worker => worker.sends.length));
  for (const worker of state.workers.slice(1)) answer(worker);
  const statuses = (await Promise.all(pending)).map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(state.workers.length, 2);
});

test('an idle completed ordinary session retains its native resume index', async t => {
  const state = await fixture(t, { idleMs: 10 });
  const first = await completed(state);
  state.advanceClock(11);
  await until(() => first.worker.closes === 1);
  const body = continuation(input, first.message, 'After idle worker cleanup.');
  const next = state.request(body);
  await until(() => state.workers[1]?.sends.length);
  assert.equal(state.workers[1].options.resumeSessionId, first.worker.sessionId);
  assert.deepEqual(state.workers[1].sends, ['After idle worker cleanup.']);
  answer(state.workers[1]); assert.equal((await next).status, 200);
});

test('interrupted ordinary history cannot be resumed as a clean completed native transcript', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const body = continuation(input, first.message, 'Unfinished question.');
  const pending = await state.request({ ...body, stream: true });
  const read = pending.text();
  await until(() => first.worker.sends.length === 2);
  const duringTurn = JSON.parse(await readFile(join(state.root, 'state', 'sessions.json'), 'utf8'));
  assert.equal(duringTurn.find(record => record.nativeId === first.worker.sessionId)?.pending, true,
    'The completed prefix must be marked pending before new native input is sent.');
  await state.restart();
  assert.match(await read, /event: error/);
  const stopped = JSON.parse(await readFile(join(state.root, 'state', 'sessions.json'), 'utf8'));
  assert.ok(!stopped.some(record => record.nativeId === first.worker.sessionId),
    'Stopping an incomplete native transcript must invalidate its earlier completed prefix.');
  const next = state.request(body);
  await until(() => state.workers[1]?.sends.length);
  assert.equal(state.workers[1].options.resumeSessionId, undefined);
  assert.ok(Array.isArray(state.workers[1].sends[0]));
  answer(state.workers[1]); assert.equal((await next).status, 200);
});

for (const tools of [undefined, []]) test(`tool_choice none with ${tools === undefined ? 'omitted' : 'empty'} tools starts an isolated tool-free session and continues incrementally`, async t => {
  const state = await fixture(t), first = await completed(state, { ...input, tools: [tool] });
  const body = { ...continuation(input, first.message, 'Summarize without calling tools.'), tool_choice: { type: 'none' },
    ...(tools === undefined ? {} : { tools }) };
  const second = await completed(state, body);
  assert.equal(state.workers.length, 2); assert.equal(second.worker.options.resumeSessionId, undefined);
  assert.notEqual(second.worker.sessionId, first.worker.sessionId);
  const listed = await rpc(second.worker, 'tools/list');
  assert.equal(listed.status, 200); assert.deepEqual(listed.value.result.tools, []);
  assert.equal((await rpc(first.worker, 'tools/list')).value.result.tools.length, 1);
  const nextBody = continuation(body, second.message, 'Continue without tools.');
  const pending = state.request(nextBody);
  await until(() => second.worker.sends.length === 2);
  assert.equal(state.workers.length, 2); assert.deepEqual(second.worker.sends[1], 'Continue without tools.');
  assert.deepEqual((await rpc(second.worker, 'tools/list')).value.result.tools, []);
  answer(second.worker); assert.equal((await pending).status, 200);
});

test('tool_choice none never drops declared tools or extra choice restrictions before starting a worker', async t => {
  const state = await fixture(t);
  for (const body of [
    { ...input, tools: [tool], tool_choice: { type: 'none' } },
    { ...input, tools: null, tool_choice: { type: 'none' } },
    { ...input, tool_choice: { type: 'none', disable_parallel_tool_use: true } },
    { ...input, tools: [], tool_choice: { type: 'none', unexpected_option: true } },
    { ...input, tool_choice: { type: 'any' } },
    { ...input, tool_choice: { type: 'tool', name: tool.name } },
    { ...input, tool_choice: 'none' },
    { ...input, tool_choice: null },
  ]) {
    const response = await state.request(body);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.type, 'invalid_request_error');
  }
  assert.equal(state.authCalls(), 0); assert.equal(state.workers.length, 0);
});

test('tool_choice none cannot execute a native builtin tool when no client tools are declared', async t => {
  const state = await fixture(t), pending = state.request({ ...input, tool_choice: { type: 'none' } });
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0];
  assert.deepEqual((await rpc(worker, 'tools/list')).value.result.tools, []);
  startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'native-read', name: 'Read', input: { file_path: 'private.txt' } } });
  const response = await pending;
  assert.equal(response.status, 502); assert.equal((await response.json()).type, 'error');
  assert.equal(worker.sends.length, 1); assert.equal(worker.closes, 1);
});

test('tools/list preserves complete nested schemas and reversible client names', async t => {
  const state = await fixture(t);
  const schema = { type: 'object', properties: { choice: { oneOf: [{ $ref: '#/$defs/file' }, { type: 'null' }] } },
    $defs: { file: { type: 'object', properties: { kind: { enum: ['a', 'b'] } }, required: ['kind'], additionalProperties: false } },
    required: ['choice'], additionalProperties: false };
  const body = { ...input, stream: true, tools: [{ name: 'folder.read/中文', description: 'Full schema fixture.', input_schema: schema }] };
  const response = await state.request(body);
  const listed = await rpc(state.workers[0], 'tools/list');
  assert.equal(listed.status, 200);
  const [listedTool] = listed.value.result.tools;
  assert.deepEqual(listedTool.inputSchema, schema);
  assert.equal(listedTool.description, 'Full schema fixture.');
  assert.match(listedTool.name, /^[A-Za-z0-9_-]+$/);
  callTools(state.workers[0], [{ id: 'mapped-tool', name: listedTool.name, input: { choice: null } }]);
  const wire = await response.text();
  assert.match(wire, /folder.read\/中文/);
});

test('client permission denial returns the matching isError MCP result without inventing an answer', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state);
  const returned = rpc(first.worker, 'tools/call', toolParams('tool-one'));
  await until(() => [...state.hub.runs.values()][0].calls.size === 1);
  const pending = state.request(continuation(first.body, first.message, [
    { type: 'tool_result', tool_use_id: 'tool-one', content: 'User denied file access.', is_error: true },
  ]));
  const mcp = await returned;
  assert.equal(mcp.status, 200);
  assert.deepEqual(mcp.value.result, { content: [{ type: 'text', text: 'User denied file access.' }], isError: true });
  assert.equal(first.worker.sends.length, 1);
  answer(first.worker, 'Acknowledged denial.');
  assert.equal((await pending).status, 200);
});

test('tool results arriving before MCP calls are paired by native ID', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state);
  const pending = state.request(continuation(first.body, first.message, [
    { type: 'tool_result', tool_use_id: 'tool-one', content: 'Verified client result.' },
  ]));
  await until(() => [...state.hub.runs.values()][0].early.size === 1);
  const mcp = await rpc(first.worker, 'tools/call', toolParams('tool-one'));
  assert.deepEqual(mcp.value.result, { content: [{ type: 'text', text: 'Verified client result.' }] });
  answer(first.worker); assert.equal((await pending).status, 200);
});

test('late MCP calls cannot change the arguments attached to an early client result', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state);
  const pending = state.request(continuation(first.body, first.message, [
    { type: 'tool_result', tool_use_id: 'tool-one', content: 'Private result for original arguments.' },
  ]));
  await until(() => [...state.hub.runs.values()][0].early.size === 1);
  const mcp = await rpc(first.worker, 'tools/call', toolParams('tool-one', { path: 'different.txt' }));
  assert.equal(mcp.status, 403);
  assert.doesNotMatch(JSON.stringify(mcp.value), /Private result/);
  assert.equal((await pending).status, 502);
});

test('late MCP calls cannot change the tool name attached to an early client result', async t => {
  const state = await fixture(t);
  const body = { ...input, tools: [tool, { ...tool, name: 'another_tool' }] };
  const request = state.request(body);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0]; callTools(worker, [{ id: 'tool-one', input: { path: 'fixture.txt' } }]);
  const message = await (await request).json();
  const pending = state.request(continuation(body, message, [
    { type: 'tool_result', tool_use_id: 'tool-one', content: 'Private original-tool result.' },
  ]));
  await until(() => [...state.hub.runs.values()][0].early.size === 1);
  const mcp = await rpc(worker, 'tools/call', toolParams('tool-one', { path: 'fixture.txt' }, 'another_tool'));
  assert.equal(mcp.status, 403);
  assert.doesNotMatch(JSON.stringify(mcp.value), /Private original-tool/);
  assert.equal((await pending).status, 502);
});

test('an MCP call arriving before its stream block must match the later native arguments', async t => {
  const state = await fixture(t);
  const pending = state.request({ ...input, tools: [tool] });
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0];
  const mcp = rpc(worker, 'tools/call', toolParams('tool-one', { path: 'changed.txt' }));
  await until(() => [...state.hub.runs.values()][0].calls.size === 1);
  callTools(worker, [{ id: 'tool-one', input: { path: 'fixture.txt' } }]);
  assert.equal((await pending).status, 502);
  const result = (await mcp).value.result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /工具身份/);
  assert.equal(worker.sends.length, 1);
});

test('AskUserQuestion waits for the client answer and forwards that answer unchanged', async t => {
  const state = await fixture(t);
  const question = { name: 'AskUserQuestion', description: 'Ask the current desktop user.', input_schema: {
    type: 'object', properties: { questions: { type: 'array', items: { type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['question', 'options'], additionalProperties: false } } }, required: ['questions'], additionalProperties: false,
  } };
  const body = { ...input, tools: [question] };
  const first = state.request(body);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0];
  const args = { questions: [{ question: 'Which fixture?', options: ['One', 'Two'] }] };
  callTools(worker, [{ id: 'ask-user-one', name: question.name, input: args }]);
  const message = await (await first).json();
  assert.equal(message.content[0].name, 'AskUserQuestion');
  assert.deepEqual(message.content[0].input, args);
  const waiting = rpc(worker, 'tools/call', toolParams('ask-user-one', args, question.name));
  await until(() => [...state.hub.runs.values()][0].calls.size === 1);
  assert.equal(worker.sends.length, 1);
  const exactAnswer = '{"Which fixture?":"Two"}';
  const next = state.request(continuation(body, message, [
    { type: 'tool_result', tool_use_id: 'ask-user-one', content: exactAnswer },
  ]));
  assert.deepEqual((await waiting).value.result, { content: [{ type: 'text', text: exactAnswer }] });
  answer(worker, 'The user selected Two.');
  assert.equal((await next).status, 200);
  assert.equal(state.workers.length, 1);
});

test('concurrent identical tool arguments remain separated by distinct native IDs', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state, [{ id: 'tool-a', input: { path: 'fixture.txt' } },
    { id: 'tool-b', input: { path: 'fixture.txt' } }]);
  const callA = rpc(first.worker, 'tools/call', toolParams('tool-a'));
  const callB = rpc(first.worker, 'tools/call', toolParams('tool-b'));
  await until(() => [...state.hub.runs.values()][0].calls.size === 2);
  const pending = state.request(continuation(first.body, first.message, [
    { type: 'tool_result', tool_use_id: 'tool-b', content: 'Result B.' },
    { type: 'tool_result', tool_use_id: 'tool-a', content: 'Result A.' },
  ]));
  assert.deepEqual((await callA).value.result.content, [{ type: 'text', text: 'Result A.' }]);
  assert.deepEqual((await callB).value.result.content, [{ type: 'text', text: 'Result B.' }]);
  answer(first.worker); assert.equal((await pending).status, 200);
});

test('tool results from another client identity cannot resume a pending tool session', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state);
  const body = continuation(first.body, first.message, [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'Wrong client.' }]);
  const response = await state.request(body, { identity: 'another-client' });
  assert.equal(response.status, 409);
  assert.equal(first.worker.sends.length, 1);
  assert.equal([...state.hub.runs.values()][0].expected.size, 1);
});

test('missing native tool-use identity fails closed and stops the affected run', async t => {
  const state = await fixture(t);
  const first = await toolTurn(state);
  const response = await rpc(first.worker, 'tools/call', { name: tool.name, arguments: { path: 'fixture.txt' } });
  assert.equal(response.status, 400);
  await until(() => first.worker.closes === 1);
  assert.equal(state.hub.runs.size, 0);
});

test('model and client identity changes create isolated native sessions', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const nextBody = continuation(input, first.message, 'Another session.');
  const second = await completed(state, nextBody, { identity: 'different-client' });
  assert.equal(second.worker.options.resumeSessionId, undefined);
  const third = await completed(state, { ...nextBody, model: 'claude-sonnet-fixture' });
  assert.equal(third.worker.options.model, 'claude-sonnet-fixture');
  assert.equal(third.worker.options.resumeSessionId, undefined);
  assert.equal(state.workers.length, 3);
});

for (const changed of ['agent', 'parent']) {
  test(`concurrent agents with a shared session and different ${changed} identities resume their own workers`, async t => {
    let releaseStart;
    const gate = new Promise(resolve => { releaseStart = resolve; });
    const state = await fixture(t, { workerStartGate: async () => gate });
    const identityA = { identity: 'shared-desktop-session', agent: 'child-agent', parent: 'root-agent' };
    const identityB = { ...identityA, [changed]: `${identityA[changed]}-other` };
    const firstA = state.request(input, identityA);
    let firstB;
    try {
      await until(() => state.workers[0]?.starts);
      firstB = state.request(input, identityB);
      await until(() => state.workers[1]?.starts);
    } finally { releaseStart(); }
    await until(() => state.workers[0]?.sends.length && state.workers[1]?.sends.length);
    answer(state.workers[0], 'Identical first answer.'); answer(state.workers[1], 'Identical first answer.');
    const messageA = await (await firstA).json(), messageB = await (await firstB).json();
    const bodyA = continuation(input, messageA, 'Identical next question.');
    const bodyB = continuation(input, messageB, 'Identical next question.');
    const nextA = state.request(bodyA, identityA), nextB = state.request(bodyB, identityB);
    await until(() => state.workers[0].sends.length === 2 && state.workers[1].sends.length === 2);
    assert.equal(state.workers.length, 2);
    assert.equal(state.workers[0].options.resumeSessionId, undefined);
    assert.equal(state.workers[1].options.resumeSessionId, undefined);
    assert.notEqual(state.workers[0].sessionId, state.workers[1].sessionId);
    answer(state.workers[0], 'Answer from original worker A.');
    answer(state.workers[1], 'Answer from original worker B.');
    assert.equal((await (await nextA).json()).content[0].text, 'Answer from original worker A.');
    assert.equal((await (await nextB).json()).content[0].text, 'Answer from original worker B.');
    assert.equal(state.workers[0].sends[1], 'Identical next question.');
    assert.equal(state.workers[1].sends[1], 'Identical next question.');
  });
}

test('fully absent session and agent headers retain the anonymous native session identity', async t => {
  const state = await fixture(t);
  const first = await completed(state, input, { identity: null });
  assert.equal([...state.hub.runs.values()][0].identity, null);
  const pending = state.request(continuation(input, first.message, 'Anonymous continuation.'), { identity: null });
  await until(() => first.worker.sends.length === 2);
  assert.equal(state.workers.length, 1);
  answer(first.worker); assert.equal((await pending).status, 200);
});

test('changing generation options resumes a completed session with the new limits', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const body = { ...continuation(input, first.message, 'Changed options.'), max_tokens: 64, output_config: { effort: 'low' } };
  const next = state.request(body);
  await until(() => state.workers[1]?.sends.length);
  assert.equal(state.workers[1].options.resumeSessionId, first.worker.sessionId);
  assert.equal(state.workers[1].options.maxTokens, 64);
  assert.equal(state.workers[1].options.effort, 'low');
  assert.deepEqual(state.workers[1].sends, ['Changed options.']);
  answer(state.workers[1]); assert.equal((await next).status, 200);
});

test('cancellation stops the worker and returns an error without a fabricated assistant answer', async t => {
  const state = await fixture(t);
  const abort = new AbortController();
  const response = await state.request({ ...input, stream: true }, { signal: abort.signal });
  const body = response.text();
  abort.abort();
  const wire = await body;
  assert.match(wire, /event: error/);
  assert.doesNotMatch(wire, /event: message_start/);
  await until(() => state.workers[0].closes === 1);
  assert.equal(state.hub.runs.size, 0);
});

test('an unread SSE response applies bounded backpressure and cancellation unblocks the worker', async t => {
  const state = await fixture(t);
  const response = await state.request({ ...input, stream: true });
  const worker = state.workers[0], run = [...state.hub.runs.values()][0];
  startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let index = 0; index < 400; index++) worker.emit({ type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: 'x'.repeat(8192) } });
  await until(() => run.turn.queue.writers.length > 0);
  assert.ok(run.turn.queue.bytes <= 1_048_576);
  assert.ok(run.turn.queue.values.length <= 256);
  assert.ok(worker.events.values.length > 0, 'The native event source must stop advancing while the client is idle.');
  await response.body.cancel();
  await run.pump;
  assert.equal(worker.closes, 1);
  assert.equal(state.hub.runs.size, 0);
  assert.equal(state.workers.length, 1);
});

test('draining a previously unread SSE response preserves all deltas and one successful stop', async t => {
  const state = await fixture(t);
  const response = await state.request({ ...input, stream: true });
  const worker = state.workers[0], run = [...state.hub.runs.values()][0];
  startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let index = 0; index < 400; index++) worker.emit({ type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: `${index}:` + 'x'.repeat(8192) } });
  worker.emit({ type: 'content_block_stop', index: 0 });
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 400 } });
  worker.emit({ type: 'message_stop' }); worker.result();
  await until(() => run.turn.queue.writers.length > 0);
  const wire = await response.text();
  assert.equal((wire.match(/event: content_block_delta\n/g) ?? []).length, 400);
  assert.equal((wire.match(/event: message_stop\n/g) ?? []).length, 1);
  assert.match(wire, /399:/);
  assert.doesNotMatch(wire, /event: error/);
  assert.equal(worker.closes, 0);
});

test('SDK errors after a model stop do not produce a successful JSON message', async t => {
  const state = await fixture(t);
  const pending = state.request(input);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0]; startMessage(worker);
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
  worker.emit({ type: 'message_stop' }); worker.result({ subtype: 'error_max_turns', is_error: true });
  const response = await pending; assert.equal(response.status, 502);
  assert.equal((await response.json()).type, 'error');
  assert.equal(worker.closes, 1);
});

test('an SDK failure after message_stop never emits a successful SSE stop', async t => {
  const state = await fixture(t);
  const response = await state.request({ ...input, stream: true });
  const worker = state.workers[0];
  startMessage(worker);
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
  worker.emit({ type: 'message_stop' });
  worker.result({ subtype: 'error_during_execution', is_error: true });
  const wire = await response.text();
  assert.match(wire, /event: error/);
  assert.doesNotMatch(wire, /event: message_stop/);
  assert.equal(worker.closes, 1);
});

for (const reason of ['max_tokens', 'stop_sequence', 'pause_turn', 'refusal', 'model_context_window_exceeded']) {
  test(`the valid ${reason} stop reason preserves the native final status`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0]; startMessage(worker);
    worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Native final text.' } });
    worker.emit({ type: 'content_block_stop', index: 0 });
    worker.emit({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 3 } });
    worker.emit({ type: 'message_stop' }); worker.result();
    const response = await pending;
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.stop_reason, reason);
    assert.equal(message.content[0].text, 'Native final text.');
    assert.equal(message.usage.output_tokens, 3);
    assert.equal(worker.sends.length, 1);
  });
}

for (const invalid of ['tool_use_without_tool', 'tool_with_end_turn', 'unclosed_text_block']) {
  test(`invalid ${invalid} termination fails without a successful assistant reply`, async t => {
    const state = await fixture(t);
    const pending = state.request({ ...input, tools: [tool] });
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0]; startMessage(worker);
    if (invalid === 'tool_with_end_turn') {
      worker.emit({ type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'unfinished-tool', name: `mcp__client__${tool.name}`, input: {} } });
      worker.emit({ type: 'content_block_stop', index: 0 });
    } else if (invalid === 'unclosed_text_block') {
      worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Unfinished text.' } });
    }
    worker.emit({ type: 'message_delta', delta: { stop_reason: invalid === 'tool_use_without_tool' ? 'tool_use' : 'end_turn' } });
    worker.emit({ type: 'message_stop' }); worker.result();
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal((await response.json()).type, 'error');
    assert.equal(worker.closes, 1);
  });
}

test('a native builtin tool is rejected without returning it as a desktop tool request', async t => {
  const state = await fixture(t);
  const pending = state.request({ ...input, tools: [tool] });
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0]; startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'native-read', name: 'Read', input: { file_path: 'private.txt' } } });
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).type, 'error');
  assert.equal(worker.sends.length, 1);
  assert.equal(worker.closes, 1);
});

const messageStartError = 'CLI 消息起始字段或顺序无效。';
const privateMessageFixture = 'PRIVATE_CLI_START_DIAGNOSTIC_FIXTURE';
const startDiagnostic = {
  existing_message: false, previous_message_stopped: false, previous_stop_reason: null,
  message_object: true, id_type: 'string', message_type_valid: true, role_valid: true,
};

function diagnosticMessage() {
  return { id: `${privateMessageFixture}:id`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: `${privateMessageFixture}:content` }],
    usage: { input_tokens: 1, output_tokens: 0 } };
}

async function assertStartDiagnostic(response, expected) {
  assert.equal(response.status, 502);
  const wire = await response.text();
  assert.ok(!wire.includes(privateMessageFixture), 'Diagnostics must not disclose original message values.');
  const body = JSON.parse(wire);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'api_error');
  assert.ok(body.error.message.startsWith(messageStartError));
  assert.deepEqual(JSON.parse(body.error.message.slice(messageStartError.length).trim()), expected);
}

test('a valid first CLI message start still produces a successful assistant response', async t => {
  const state = await fixture(t);
  const { worker, message } = await completed(state);
  assert.equal(message.id, 'msg-fixture');
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.content[0].text, 'Fixture answer.');
  assert.equal(worker.closes, 0);
});

for (const field of ['id', 'type', 'role']) {
  test(`a CLI message start missing ${field} reports only the failing field shape`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0], message = diagnosticMessage();
    delete message[field];
    worker.emit({ type: 'message_start', message });
    await assertStartDiagnostic(await pending, { ...startDiagnostic,
      ...(field === 'id' ? { id_type: 'undefined' }
        : field === 'type' ? { message_type_valid: false } : { role_valid: false }) });
    assert.equal(worker.closes, 1);
  });
}

for (const [field, value, expected] of [
  ['id', { value: privateMessageFixture }, { id_type: 'object' }],
  ['type', `${privateMessageFixture}:type`, { message_type_valid: false }],
  ['role', `${privateMessageFixture}:role`, { role_valid: false }],
]) {
  test(`a CLI message start with invalid ${field} never discloses its original value`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0];
    worker.emit({ type: 'message_start', message: { ...diagnosticMessage(), [field]: value } });
    await assertStartDiagnostic(await pending, { ...startDiagnostic, ...expected });
    assert.equal(worker.closes, 1);
  });
}

for (const [description, message] of [
  ['null', null], ['string', privateMessageFixture], ['array', [privateMessageFixture]],
]) {
  test(`a non-object CLI start message (${description}) reports its invalid shape without message content`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0];
    worker.emit({ type: 'message_start', message });
    await assertStartDiagnostic(await pending, { ...startDiagnostic,
      message_object: false, id_type: 'undefined', message_type_valid: false, role_valid: false });
    assert.equal(worker.closes, 1);
  });
}

for (const [reason, stopped] of [
  [null, false], ['max_tokens', false], ['refusal', false], ['refusal', true],
]) {
  test(`a repeated CLI message start after ${reason ?? 'no stop reason'} with stopped=${stopped} reports prior state`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0]; startMessage(worker);
    if (reason) worker.emit({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 1 } });
    if (stopped) worker.emit({ type: 'message_stop' });
    worker.emit({ type: 'message_start', message: diagnosticMessage() });
    await assertStartDiagnostic(await pending, { ...startDiagnostic,
      existing_message: true, previous_message_stopped: stopped, previous_stop_reason: reason });
    assert.equal(worker.closes, 1);
  });
}

for (const stream of [false, true]) {
  const format = stream ? 'SSE' : 'JSON';
  test(`a complete max_tokens API message finishes ${format} without an SDK result`, { timeout: 2000 }, async t => {
    const state = await fixture(t);
    const pending = state.request({ ...input, max_tokens: 1, stream });
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0], run = [...state.hub.runs.values()][0];
    truncateAnswer(worker);
    const response = await pending;
    assert.equal(response.status, 200);
    if (stream) {
      const wire = await response.text();
      assert.equal((wire.match(/event: message_start\n/g) ?? []).length, 1);
      assert.equal((wire.match(/event: message_stop\n/g) ?? []).length, 1);
      assert.match(wire, /"stop_reason":"max_tokens"/);
      assert.match(wire, /"output_tokens":1/);
      assert.match(wire, /First truncated answer\./);
      assert.doesNotMatch(wire, /event: error/);
    } else {
      const message = await response.json();
      assert.equal(message.stop_reason, 'max_tokens');
      assert.equal(message.content[0].text, 'First truncated answer.');
      assert.equal(message.usage.input_tokens, 10);
      assert.equal(message.usage.output_tokens, 1);
      assert.equal(message.usage.cache_read_input_tokens, 3);
      assert.equal(message.usage.cache_creation_input_tokens, 2);
    }
    await run.stopping;
    assert.equal(worker.closes, 1);
    assert.equal(state.hub.runs.size, 0);
    assert.equal(state.hub.saved.size, 0);
    assert.deepEqual(JSON.parse(await readFile(join(state.root, 'state', 'sessions.json'), 'utf8')), []);
  });

  test(`a max_tokens ${format} reply excludes queued CLI continuation and later SDK errors`, { timeout: 2000 }, async t => {
    const state = await fixture(t);
    const pending = state.request({ ...input, max_tokens: 1, stream });
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0], run = [...state.hub.runs.values()][0];
    truncateAnswer(worker);
    const privateContinuation = 'PRIVATE_CLI_AUTOCONTINUATION_FIXTURE';
    worker.emit({ type: 'message_start', message: { ...diagnosticMessage(), id: privateContinuation,
      usage: { input_tokens: 777777, output_tokens: 777777 } } });
    worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: privateContinuation } });
    worker.emit({ type: 'content_block_stop', index: 0 });
    worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 777777 } });
    worker.emit({ type: 'message_stop' });
    worker.result({ subtype: 'error_during_execution', is_error: true,
      usage: { input_tokens: 777777, output_tokens: 777777 } });
    const response = await pending;
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.match(wire, /First truncated answer\./);
    assert.match(wire, /"stop_reason":"max_tokens"/);
    assert.match(wire, /"output_tokens":1/);
    assert.ok(!wire.includes(privateContinuation));
    assert.ok(!wire.includes(privateMessageFixture));
    assert.doesNotMatch(wire, /777777|event: error/);
    if (stream) assert.equal((wire.match(/event: message_stop\n/g) ?? []).length, 1);
    await run.stopping;
    assert.equal(worker.closes, 1);
    assert.equal(state.hub.saved.size, 0);
  });
}

test('a max_tokens turn invalidates its existing native prefix and rebuilds the follow-up without resume', { timeout: 2000 }, async t => {
  const state = await fixture(t);
  const first = await completed(state);
  const secondBody = continuation(input, first.message, 'Question that gets truncated.');
  const pending = state.request(secondBody);
  await until(() => first.worker.sends.length === 2);
  const run = [...state.hub.runs.values()][0], nativeId = first.worker.sessionId;
  assert.equal(state.workers.length, 1);
  truncateAnswer(first.worker);
  const response = await pending;
  assert.equal(response.status, 200);
  const truncated = await response.json();
  assert.equal(truncated.stop_reason, 'max_tokens');
  await run.stopping;
  assert.equal(state.hub.runs.size, 0);
  assert.equal(state.hub.saved.size, 0);
  assert.deepEqual(JSON.parse(await readFile(join(state.root, 'state', 'sessions.json'), 'utf8')), []);
  const followUp = continuation(secondBody, truncated, 'Continue from the truncated answer.');
  const next = await completed(state, followUp);
  assert.equal(state.workers.length, 2);
  assert.notEqual(next.worker.sessionId, nativeId);
  assert.equal(next.worker.options.resumeSessionId, undefined);
  assert.equal(first.worker.closes, 1);
  assert.ok(Array.isArray(next.worker.sends[0]));
  assert.ok(next.worker.sends[0].some(block => block.text === 'First truncated answer.'));
  assert.ok(next.worker.sends[0].some(block => block.text === 'Continue from the truncated answer.'));
});

test('max_tokens does not make an unclosed content block a successful API message', { timeout: 2000 }, async t => {
  const state = await fixture(t);
  const pending = state.request(input);
  await until(() => state.workers[0]?.sends.length);
  const worker = state.workers[0]; startMessage(worker);
  worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Incomplete block.' } });
  worker.emit({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } });
  worker.emit({ type: 'message_stop' });
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).type, 'error');
  assert.equal(worker.closes, 1);
});

for (const cancellation of ['stream cancellation', 'AbortSignal']) {
  test(`${cancellation} releases an unread retired max_tokens turn under backpressure`, { timeout: 3000 }, async t => {
    const state = await fixture(t), controller = new AbortController();
    const response = await state.request({ ...input, stream: true }, { signal: controller.signal });
    const worker = state.workers[0], run = [...state.hub.runs.values()][0], turn = run.turn;
    startMessage(worker);
    worker.emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (let index = 0; index < 253; index++) worker.emit({ type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'x' } });
    worker.emit({ type: 'content_block_stop', index: 0 });
    worker.emit({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 128 } });
    worker.emit({ type: 'message_stop' });
    await until(() => worker.closes === 1 && turn.queue.writers.length > 0);
    assert.equal(state.hub.runs.size, 0);
    if (cancellation === 'stream cancellation') await response.body.cancel();
    else controller.abort();
    await run.pump;
    assert.equal(turn.queue.writers.length, 0);
    assert.equal(turn.queue.ended, true);
    assert.equal(state.hub.saved.size, 0);
    assert.equal(worker.closes, 1);
    if (cancellation === 'AbortSignal') {
      const wire = await response.text();
      assert.match(wire, /event: error/);
      assert.doesNotMatch(wire, /event: message_stop/);
    }
  });
}

for (const missing of ['message_start', 'stop_reason']) {
  test(`a successful SDK result with missing ${missing} cannot fabricate an empty successful reply`, async t => {
    const state = await fixture(t);
    const pending = state.request(input);
    await until(() => state.workers[0]?.sends.length);
    const worker = state.workers[0];
    if (missing !== 'message_start') startMessage(worker);
    if (missing !== 'stop_reason') worker.emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    worker.emit({ type: 'message_stop' }); worker.result();
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal((await response.json()).type, 'error');
    assert.equal(worker.closes, 1);
  });
}

test('authentication and unsupported options fail before any worker is started', async t => {
  const state = await fixture(t, { authenticated: false });
  assert.equal((await state.request()).status, 503);
  state.setAuthenticated(true);
  for (const body of [{ ...input, temperature: 0 }, { ...input, tool_choice: { type: 'any' } },
    { ...input, tool_choice: { type: 'auto', disable_parallel_tool_use: true } },
    { ...input, tool_choice: { type: 'auto', unexpected_option: true } },
    { ...input, thinking: { type: 'enabled', budget_tokens: 1000 } },
    { ...input, tools: [{ type: 'computer_20250124', name: 'computer', input_schema: {} }] }]) {
    assert.equal((await state.request(body)).status, 400);
  }
  assert.equal((await state.request(input, { path: '/v1/messages/count_tokens' })).status, 501);
  const abort = new AbortController(); abort.abort();
  assert.equal((await state.request(input, { signal: abort.signal })).status, 499);
  assert.equal(state.workers.length, 0);
});

test('worker startup failure returns a safe error without retry or fallback', async t => {
  const state = await fixture(t, { workerStartFailure: true });
  const response = await state.request();
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /Private worker fixture/);
  assert.equal(state.workers.length, 1);
});

test('concurrent distinct conversations cannot exceed the six-worker capacity', async t => {
  const state = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 7 }, (_, index) =>
    state.request({ ...input, stream: true }, { identity: `capacity-${index}` })));
  assert.equal(responses.filter(response => response.status === 200).length, 6);
  assert.equal(responses.filter(response => response.status === 503).length, 1);
  assert.equal(state.workers.length, 6);
  assert.equal(state.hub.runs.size, 6);
  await Promise.all(responses.filter(response => response.status === 200).map(response => response.body.cancel()));
  assert.equal(state.hub.runs.size, 0);
});

test('MCP requires the per-run key, exact Host, no Origin, and POST', async t => {
  const state = await fixture(t);
  const first = await completed(state);
  for (const headers of [{ authorization: 'Bearer another-key' }, { host: 'localhost:1' }, { origin: 'https://outside.invalid' }]) {
    assert.equal((await rpc(first.worker, 'tools/list', undefined, { headers })).status, 403);
  }
  assert.equal((await rpc(first.worker, 'tools/list', undefined, { requestMethod: 'GET' })).status, 405);
  assert.equal(first.worker.closes, 0);
});
