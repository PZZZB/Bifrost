import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';
import { CursorResponsesProvider } from '../src/cursor-responses.mjs';
import { MessagesSseParser } from '../src/protocols/responses-messages.mjs';

const scope = 'be4b191d-1810-4874-85b6-4614f1ecc86e';
const tool = { type: 'function', name: 'read_file', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const input = [{ role: 'user', content: 'Inspect without changing files.' }];
const tokenUsage = { input_tokens: 20, output_tokens: 5, total_tokens: 25 };
const chatUsage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
  prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } };
const sdkUsage = { inputTokens: 15, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 25 };
const terminalTypes = new Set(['response.completed', 'response.incomplete', 'response.failed']);
const nativePoints = {
  CodeBuddy: [['before-start', 0], ['after-thinking', 2], ['after-text', 3], ['after-finish-reason', 4], ['after-usage', 5]],
  Messages: [['before-start', 0], ['thinking-open', 2], ['thinking-closed', 3], ['after-text', 5], ['text-closed', 6], ['after-finish-reason', 7]],
  Cursor: [['before-output', 0], ['after-progress', 1], ['after-answer', 2], ['after-usage', 3]],
};
const providers = Object.keys(nativePoints);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
async function within(value, message, ms = 2000) {
  let timer;
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const frame = packet => Buffer.from(`data: ${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n\n`);
const chat = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

function messagesPackets(body, outcome) {
  const packets = [
    { type: 'message_start', message: { type: 'message', role: 'assistant', content: [],
      usage: { input_tokens: 15, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'PRIVATE_SOURCE_SIGNATURE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Progress.' } },
    { type: 'content_block_stop', index: 1 },
  ];
  if (outcome === 'tool') packets.push(
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'matrix_read', name: body.tools[0].name, input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"project.json"}' } },
    { type: 'content_block_stop', index: 2 });
  packets.push({ type: 'message_delta', delta: { stop_reason: outcome === 'tool' ? 'tool_use' : outcome === 'length' ? 'max_tokens' : 'end_turn' },
    usage: { output_tokens: 5 } }, { type: 'message_stop' });
  return packets;
}
function chatPackets(body, outcome) {
  const packets = [chat({ role: 'assistant' }), chat({ reasoning_content: 'PRIVATE_THINKING' }), chat({ content: 'Progress.' })];
  if (outcome === 'tool') packets.push(chat({ tool_calls: [{ index: 0, id: 'matrix_read', type: 'function',
    function: { name: body.tools[0].function.name, arguments: '{"path":"project.json"}' } }] }));
  packets.push(chat({}, outcome === 'tool' ? 'tool_calls' : outcome === 'length' ? 'length' : 'stop'),
    { choices: [], usage: chatUsage }, '[DONE]');
  return packets;
}

function controlledResponse(packets, settings, metrics, gates) {
  let at = 0, failed = false;
  const cut = settings.cut ?? packets.length, hold = deferred(), cancel = deferred();
  gates.push(hold, cancel);
  const response = new Response(new ReadableStream({
    async pull(controller) {
      if (at < Math.min(cut, packets.length)) { controller.enqueue(frame(packets[at++])); return; }
      if (failed) { controller.close(); return; }
      failed = true;
      if (settings.hold) { await hold.promise; return; }
      if (settings.fault === 'stream-error') { controller.error(new Error('PRIVATE_SOURCE_CONNECTION')); return; }
      if (settings.fault === 'source-error') {
        controller.enqueue(frame(settings.kind === 'CodeBuddy' ? { error: { message: 'PRIVATE_SOURCE_FAILURE' } }
          : { type: 'error', error: { type: 'api_error', code: 'claude_network_error', message: 'PRIVATE_SOURCE_FAILURE' } }));
        return;
      }
      controller.close();
    },
    cancel() { metrics.cancelled++; hold.resolve(); return settings.stubbornCancel ? cancel.promise : undefined; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  metrics.sources.push(response); return response;
}

async function fixture(t, kind, settings = {}) {
  const metrics = { calls: 0, created: 0, closed: 0, cancelled: 0, sources: [], requests: [], toolResults: [] }, gates = [];
  let provider;
  t.after(async () => { for (const gate of gates) gate.resolve(); await provider?.close?.(); });
  const model = kind === 'CodeBuddy' ? 'CodeBuddy-hy4std' : kind === 'Cursor' ? 'Cursor-gemini-4-argon' : 'fixture-model';
  const body = extra => ({ model, input: structuredClone(input), store: false, tools: [tool], stream: true, ...extra });
  if (kind === 'CodeBuddy') {
    provider = new CodeBuddyResponsesProvider({ provider: new CodeBuddyProvider({ client: {
      status: async () => ({ authenticated: true, identity: { uid: 'offline-matrix-employee' } }),
      modelCatalog: async () => [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }],
      chatCompletions: async request => {
        metrics.calls++; metrics.requests.push(structuredClone(request.body));
        return controlledResponse(chatPackets(request.body, settings.outcome), { ...settings, kind }, metrics, gates);
      },
    }, loadThinkingState: () => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 13) }) }) });
  } else if (kind === 'Messages') {
    provider = new MessagesResponsesAdapter({ stateSecret: 'offline-lifecycle-matrix-state-without-credentials', requestMessages: async request => {
      metrics.calls++; metrics.requests.push(structuredClone(request.body));
      return controlledResponse(messagesPackets(request.body, settings.outcome), { ...settings, kind }, metrics, gates);
    } });
  } else {
    const tempRoot = await realpath(tmpdir()), directory = await mkdtemp(join(tempRoot, 'bifrost-lifecycle-matrix-'));
    t.after(async () => {
      for (const gate of gates) gate.resolve(); await provider?.close();
      assert.equal(dirname(directory), tempRoot); assert.ok(basename(directory).startsWith('bifrost-lifecycle-matrix-'));
      await rm(directory, { recursive: true, force: true });
    });
    const sdk = { JsonlLocalAgentStore: class {}, Agent: { async create() {
      metrics.created++;
      return { agentId: 'offline-matrix-agent', close() { metrics.closed++; }, async send(_message, options) {
        metrics.calls++;
        const result = deferred(), hold = deferred(), cancel = deferred(); gates.push(result, hold, cancel);
        const sdkPackets = [
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Progress.' }] } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] } },
          { type: 'usage', usage: sdkUsage },
        ];
        const run = { id: 'offline-matrix-run', async *stream() {
          const cut = settings.cut ?? sdkPackets.length;
          for (const packet of sdkPackets.slice(0, cut)) yield packet;
          if (settings.hold) { await hold.promise; return; }
          if (settings.fault === 'stream-error') throw new Error('PRIVATE_SOURCE_CONNECTION');
          if (settings.fault) {
            if (settings.fault === 'source-error') yield { type: 'status', status: 'ERROR', message: 'PRIVATE_SOURCE_FAILURE' };
            result.resolve({ status: settings.fault === 'premature-end' ? 'cancelled' : 'error', error: { message: 'PRIVATE_SOURCE_FAILURE' } }); return;
          }
          if (settings.outcome === 'tool') {
            const selected = Object.entries(options.local.customTools).find(([name]) => name !== 'bifrost_client_dispatch');
            try { metrics.toolResults.push(await selected[1].execute({ path: 'project.json' }, { toolCallId: 'matrix_read' })); }
            catch { return; }
            yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Tool acknowledged.' }] } };
          }
          result.resolve({ status: 'finished' });
        }, wait: () => result.promise, cancel() {
          metrics.cancelled++; hold.resolve(); result.resolve({ status: 'cancelled' });
          return settings.stubbornCancel ? cancel.promise : Promise.resolve();
        } };
        return run;
      } };
    } } };
    provider = new CursorResponsesProvider({ stateDir: directory, sdkLoader: async () => sdk, cursorService: {
      enabled: true, credential: async () => ({ apiKey: 'offline-matrix-key', apiKeyExpiresAtMs: Date.now() + 60_000 }),
      status: async () => ({ enabled: true, authReady: true }), getModels: async () => [{ id: 'gemini-4-argon' }],
    } });
  }
  return { provider, metrics, setOutcome(value) { settings.outcome = value; }, release() { for (const gate of gates) gate.resolve(); },
    request: (extra = {}, signal) => provider.request({ path: '/responses', body: body(extra), scope, signal }) };
}

async function consume(response, onBatch) {
  if (!response.ok) return { events: [], chunks: [], failure: (await response.json()).error };
  const parser = new MessagesSseParser(), reader = response.body.getReader(), events = [], chunks = [];
  try {
    while (true) {
      const next = await reader.read(), batch = parser.push(next.value, next.done);
      if (batch.length) { chunks.push(batch); events.push(...batch); onBatch?.(batch); }
      if (next.done) break;
    }
  } finally { reader.releaseLock(); }
  return { events, chunks, terminal: events.findLast(event => terminalTypes.has(event.type)) };
}
const doneItems = events => events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
function sequence(events) { assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index)); }
function failed(result) {
  assert.deepEqual(doneItems(result.events), []);
  if (result.failure) assert.ok(result.failure.code);
  else {
    assert.equal(result.events.filter(event => terminalTypes.has(event.type)).length, 1);
    assert.equal(result.terminal.type, 'response.failed'); assert.deepEqual(result.terminal.response.output, []);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOURCE|PRIVATE_THINKING|PRIVATE_SOURCE_SIGNATURE/);
  sequence(result.events);
}
async function released(state, { pending = false } = {}) {
  for (let index = 0; index < 4; index++) await tick();
  assert.ok(state.metrics.sources.every(source => !source.body.locked), 'Upstream readers must be released after delivery.');
  if ('activeRuns' in state.provider) assert.equal(state.provider.activeRuns, pending ? 1 : 0);
}

for (const kind of providers) {
  test(`${kind} fails every uncommitted native prefix without persisting output or replaying inference`, async t => {
    for (const fault of ['stream-error', 'source-error', 'premature-end']) for (const [name, cut] of nativePoints[kind]) {
      await t.test(`${fault} ${name}`, async child => {
        const state = await fixture(child, kind, { cut, fault });
        const result = await within(consume(await state.request()), 'A source failure must terminate delivery.');
        failed(result); assert.equal(state.metrics.calls, 1); await released(state);
      });
    }
  });

  test(`${kind} cancellation at each visible boundary cannot persist a half turn`, async t => {
    const boundaries = [
      ['response.created', () => true], ['response.output_item.added', event => event.item.type === 'reasoning'],
      ['response.output_text.delta', () => true], ['response.output_text.done', () => true],
      ['response.function_call_arguments.done', () => true],
    ];
    for (const [type, matches] of boundaries) await t.test(type, async child => {
      const state = await fixture(child, kind, { outcome: type === 'response.function_call_arguments.done' ? 'tool' : 'text' }), abort = new AbortController();
      let reached = false;
      const result = await within(consume(await state.request({}, abort.signal), batch => {
        if (!reached && batch.some(event => event.type === type && matches(event))) { reached = true; abort.abort(); }
      }), 'Cancellation must terminate delivery before committing history.');
      assert.equal(reached, true); failed(result); assert.equal(state.metrics.calls, 1); await released(state);
    });
  });

  test(`${kind} JSON and SSE preserve successful text, tool payloads, sequence and actual usage`, async t => {
    for (const stream of [false, true]) for (const outcome of ['text', 'tool']) await t.test(`${stream ? 'SSE' : 'JSON'} ${outcome}`, async child => {
      const state = await fixture(child, kind, { outcome }), response = await state.request({ stream });
      assert.equal(response.status, 200);
      const result = stream ? await consume(response) : null, answer = stream ? result.terminal.response : await response.json();
      assert.equal(answer.status, 'completed'); assert.equal(state.metrics.calls, 1);
      assert.equal(answer.output.find(item => item.type === 'message').content[0].text, 'Progress.');
      const calls = answer.output.filter(item => item.type === 'function_call');
      assert.equal(calls.length, outcome === 'tool' ? 1 : 0);
      if (calls.length) { assert.equal(calls[0].name, 'read_file'); assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'project.json' }); }
      assert.equal(answer.usage.total_tokens, tokenUsage.total_tokens);
      if (stream) {
        assert.equal(result.terminal.type, 'response.completed'); assert.deepEqual(doneItems(result.events), answer.output); sequence(result.events);
        const commit = result.chunks.find(batch => batch.some(event => event.type === 'response.output_item.done'));
        assert.equal(commit.at(-1).type, 'response.completed');
        assert.ok(commit.filter(event => event.type === 'response.output_item.done').length === answer.output.length);
      }
      await released(state, { pending: kind === 'Cursor' && outcome === 'tool' });
    });
  });

  test(`${kind} committing a tool turn is not interrupted by local cancellation after its first durable item`, async t => {
    const state = await fixture(t, kind, { outcome: 'tool' }), abort = new AbortController(); let reached = false;
    const result = await consume(await state.request({}, abort.signal), batch => {
      if (!reached && batch.some(event => event.type === 'response.output_item.done')) {
        reached = true; assert.equal(batch.at(-1).type, 'response.completed'); abort.abort();
      }
    });
    assert.equal(reached, true); assert.equal(result.terminal.type, 'response.completed');
    assert.equal(result.events.some(event => event.type === 'response.failed'), false);
    assert.deepEqual(doneItems(result.events), result.terminal.response.output); sequence(result.events);
    await released(state, { pending: kind === 'Cursor' });
  });

  test(`${kind} JSON source failures remain HTTP errors without exposing partial output`, async t => {
    const cut = kind === 'Cursor' ? 1 : kind === 'Messages' ? 5 : 3;
    const state = await fixture(t, kind, { cut, fault: 'source-error' }), response = await state.request({ stream: false });
    assert.ok(response.status >= 400); assert.equal(response.headers.get('content-type').includes('application/json'), true);
    const body = await response.json(); assert.ok(body.error.code); assert.equal(body.output, undefined);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_SOURCE|PRIVATE_THINKING|PRIVATE_SOURCE_SIGNATURE/);
    assert.equal(state.metrics.calls, 1); await released(state);
  });

  test(`${kind} a tool result continues the right conversation without replaying a live callback`, async t => {
    const state = await fixture(t, kind, { outcome: 'tool' }), first = await (await state.request({ stream: false })).json();
    const call = first.output.find(item => item.type === 'function_call'); assert.ok(call);
    state.setOutcome('text');
    const second = await (await state.request({ stream: false, input: [...input, ...first.output,
      { type: 'function_call_output', call_id: call.call_id, output: 'EXACT_MATRIX_TOOL_RESULT' }] })).json();
    assert.equal(second.status, 'completed'); assert.equal(second.output.some(item => item.type === 'function_call'), false);
    if (kind === 'Cursor') {
      assert.equal(state.metrics.calls, 1); assert.equal(state.metrics.created, 1);
      assert.deepEqual(state.metrics.toolResults, [{ content: [{ type: 'text', text: 'EXACT_MATRIX_TOOL_RESULT' }] }]);
      assert.equal(second.output.find(item => item.type === 'message').content[0].text, 'Tool acknowledged.');
      assert.equal(second.usage, null, 'A multi-HTTP SDK run cannot fabricate per-HTTP cumulative usage.');
    } else {
      assert.equal(state.metrics.calls, 2);
      const request = state.metrics.requests[1];
      const observed = kind === 'CodeBuddy' ? request.messages.find(message => message.role === 'tool').content
        : request.messages.flatMap(message => message.content).find(block => block.type === 'tool_result').content[0].text;
      assert.equal(observed, 'EXACT_MATRIX_TOOL_RESULT'); assert.equal(second.usage.total_tokens, 25);
    }
    await released(state);
  });

  test(`${kind} consumer cancellation does not wait for an uncooperative source cleanup`, async t => {
    const cut = kind === 'Cursor' ? 1 : kind === 'Messages' ? 5 : 3;
    const state = await fixture(t, kind, { hold: true, cut, stubbornCancel: true }), response = await state.request();
    const parser = new MessagesSseParser(), reader = response.body.getReader(), seen = [];
    while (!seen.some(event => event.type === 'response.output_text.delta')) {
      const next = await reader.read(); assert.equal(next.done, false); seen.push(...parser.push(next.value));
    }
    assert.deepEqual(doneItems(seen), []);
    try { await within(reader.cancel(), 'Consumer cancellation waited for a stuck upstream cleanup.', 500); }
    finally { state.release(); reader.releaseLock(); }
    for (let index = 0; index < 4; index++) await tick();
    assert.ok(state.metrics.cancelled > 0); if ('activeRuns' in state.provider) assert.equal(state.provider.activeRuns, 0);
  });

  test(`${kind} an upstream failure is delivered even while source cleanup never settles`, async t => {
    const cut = kind === 'Cursor' ? 1 : kind === 'Messages' ? 5 : 3;
    const state = await fixture(t, kind, { fault: 'source-error', cut, stubbornCancel: true });
    try {
      const result = await within(consume(await state.request()), 'A failed source must not hide its error behind cleanup.');
      failed(result); assert.equal(state.metrics.calls, 1);
    } finally { state.release(); }
    await released(state);
  });
}

test('Cursor preflight reserves only the first response event and never replays an SDK request', async t => {
  for (const cut of [0, 1]) await t.test(cut ? 'failure after progress' : 'failure before output', async child => {
    const state = await fixture(child, 'Cursor', { cut, fault: 'source-error' }), response = await state.request();
    const preflight = await response.bridgePreflight();
    if (cut === 0) {
      assert.ok(preflight.status >= 400); assert.notEqual(preflight, response);
      assert.ok((await preflight.json()).error.code); assert.equal(response.bodyUsed, true);
    } else {
      assert.equal(preflight, response);
      const result = await consume(response); failed(result);
      assert.ok(result.events.some(event => event.type === 'response.output_text.delta'));
      assert.equal(result.events[0].type, 'response.created');
    }
    assert.equal(state.metrics.calls, 1); assert.equal(state.metrics.created, 1); await released(state);
  });
});

// Cursor's SDK exposes no max_output_tokens setting or native length terminal;
// do not manufacture that capability merely to make the matrix rectangular.
for (const kind of ['CodeBuddy', 'Messages']) test(`${kind} a confirmed native length limit commits an incomplete response with real usage`, async t => {
  for (const stream of [false, true]) await t.test(stream ? 'SSE' : 'JSON', async child => {
    const state = await fixture(child, kind, { outcome: 'length' }), response = await state.request({ stream });
    const result = stream ? await consume(response) : null, answer = stream ? result.terminal.response : await response.json();
    assert.equal(answer.status, 'incomplete'); assert.equal(answer.incomplete_details.reason, 'max_output_tokens');
    assert.equal(answer.usage.total_tokens, 25); assert.equal(state.metrics.calls, 1);
    if (stream) { assert.equal(result.terminal.type, 'response.incomplete'); assert.deepEqual(doneItems(result.events), answer.output); sequence(result.events); }
    await released(state);
  });
});
