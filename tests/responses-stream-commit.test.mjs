import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';
import { CursorResponsesProvider } from '../src/cursor-responses.mjs';
import { translateResponses, ResponsesConversion, messagesJsonEvents, MessagesSseParser } from '../src/protocols/responses-messages.mjs';

const model = 'CodeBuddy-hy4std';
const base = { model, stream: true, input: [
  { role: 'user', content: 'Earlier question.' },
  { role: 'assistant', content: 'Earlier completed answer.' },
  { role: 'user', content: 'Inspect the project.' },
] };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = value => Buffer.from(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
const reasoning = chunk({ role: 'assistant', reasoning_content: 'PRIVATE_TEST_REASONING' });
const text = chunk({ content: 'Checking the project.' });
const answer = () => [reasoning, text, chunk({}, 'stop'), '[DONE]'];

function fixture(frames) {
  const calls = [], sources = []; let cancelled = 0;
  const client = {
    status: () => ({ authenticated: true, identity: { uid: 'offline-stream-test' } }),
    modelCatalog: async () => [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }],
    async chatCompletions(request) {
      calls.push(request); let index = 0;
      const values = typeof frames === 'function' ? frames(request) : frames;
      const response = new Response(new ReadableStream({
        // Separate pulls reproduce a reasoning item already delivered before a
        // later upstream packet fails, rather than one rejected buffered packet.
        pull(controller) {
          if (index < values.length) controller.enqueue(frame(values[index++]));
          else controller.close();
        },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
      sources.push(response); return response;
    },
  };
  const provider = new CodeBuddyResponsesProvider({ provider: new CodeBuddyProvider({ client,
    loadThinkingState: () => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 7) }) }) });
  return { calls, sources, get cancelled() { return cancelled; },
    request: (body = base, signal) => provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(body)), signal }) };
}

async function events(response) {
  const parser = new MessagesSseParser();
  return parser.push(Buffer.from(await response.text()), true);
}
const completedItems = values => values.filter(event => event.type === 'response.output_item.done').map(event => event.item);
const terminal = values => values.findLast(event => ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type));
const assertSequence = values => assert.deepEqual(values.map(event => event.sequence_number), values.map((_, index) => index));

test('a later HY4 source error cannot commit reasoning or poison the automatic retry', async () => {
  let attempt = 0;
  const state = fixture(() => ++attempt === 1 ? [reasoning, text, { error: { message: 'PRIVATE_SOURCE_ERROR' } }] : answer());
  const before = structuredClone(base);
  const first = await state.request(), wire = await events(first);
  assert.equal(first.status, 200);
  assert.ok(wire.some(event => event.type === 'response.output_text.delta' && event.delta === 'Checking the project.'));
  assert.equal(terminal(wire).type, 'response.failed');
  assert.deepEqual(completedItems(wire), []);
  assert.deepEqual(terminal(wire).response.output, []);
  assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_TEST_REASONING|PRIVATE_SOURCE_ERROR|bridge-codebuddy-v1:/);
  assertSequence(wire);

  const retry = await state.request({ ...base, input: [...base.input, ...completedItems(wire)] });
  assert.equal(retry.status, 200);
  const second = await events(retry);
  assert.equal(terminal(second).type, 'response.completed');
  assert.equal(state.calls.length, 2, 'The retry must reach the source instead of failing local input validation.');
  assert.deepEqual(state.calls[1].body.messages, state.calls[0].body.messages);
  assert.deepEqual(base, before, 'Earlier completed history and the latest user message remain intact.');
  assertSequence(second);
});

test('truncated HY4 output cannot expose a replayable reasoning-only tail', async () => {
  const state = fixture([reasoning, text]), response = await state.request(), wire = await events(response);
  assert.equal(terminal(wire).type, 'response.failed');
  assert.deepEqual(completedItems(wire), []);
  assert.deepEqual(terminal(wire).response.output, []);
  assert.ok(wire.some(event => event.type === 'response.output_text.delta'));
  assertSequence(wire);
});

test('cancelling after live text leaves no committed reasoning or tool calls', async () => {
  const state = fixture(answer()), abort = new AbortController();
  const response = await state.request(base, abort.signal), reader = response.body.getReader(), parser = new MessagesSseParser();
  const wire = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      wire.push(...parser.push(value, done));
      if (wire.some(event => event.type === 'response.output_text.delta')) abort.abort();
      if (done) break;
    }
  } finally { reader.releaseLock(); }
  assert.equal(terminal(wire).type, 'response.failed');
  assert.equal(terminal(wire).response.error.code, 'request_cancelled');
  assert.deepEqual(completedItems(wire), []);
  assert.deepEqual(terminal(wire).response.output, []);
  assert.ok(state.cancelled > 0);
  assertSequence(wire);
});

const tool = { type: 'function', name: 'read_file', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 10 } };
const profile = { model: 'fixture-model', sealState: () => 'PRIVATE_STATE_TOKEN' };
function conversion() {
  const request = translateResponses({ model: profile.model, input: 'Inspect.', tools: [tool] }, 'test-instructions', profile);
  return { request, conversion: new ResponsesConversion(request, profile) };
}

test('successful thinking, multiple text blocks and tool calls commit together with phases, arguments and usage', () => {
  const { request, conversion: current } = conversion();
  const native = { type: 'message', role: 'assistant', content: [
    { type: 'thinking', thinking: '', signature: 'SOURCE_STATE' },
    { type: 'text', text: 'First progress update.' },
    { type: 'text', text: 'Second progress update.' },
    { type: 'tool_use', id: 'call_read', name: request.upstream.tools[0].name, input: { path: 'project.json' } },
  ], stop_reason: 'tool_use' };
  const live = [];
  for (const event of messagesJsonEvents(native)) live.push(...current.accept(event));
  assert.deepEqual(completedItems(live), []);
  assert.equal(live.filter(event => event.type === 'response.output_text.delta').length, 2);
  assert.ok(live.some(event => event.type === 'response.function_call_arguments.done'));
  const final = [...current.finishEvents(usage)], wire = [...live, ...final], result = terminal(wire).response;
  assert.deepEqual(final.map(event => event.type), [
    'response.output_item.done', 'response.output_item.done', 'response.output_item.done', 'response.output_item.done', 'response.completed',
  ]);
  assert.deepEqual(completedItems(wire), result.output);
  assert.deepEqual(result.output.map(item => item.type), ['reasoning', 'message', 'message', 'function_call']);
  assert.deepEqual(result.output.filter(item => item.type === 'message').map(item => item.phase), ['commentary', 'commentary']);
  assert.equal(result.output.at(-1).name, 'read_file');
  assert.equal(result.output.at(-1).arguments, '{"path":"project.json"}');
  assert.equal(result.output.at(-1).call_id, 'call_read');
  assert.equal(result.usage.input_tokens, 20); assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.usage.input_tokens_details.cached_tokens, 10);
  assertSequence(wire);
});

for (const stopReason of ['end_turn', 'max_tokens']) {
  test(`successful ${stopReason} commits text phases and preserves its terminal status`, () => {
    const { conversion: current } = conversion(), live = [];
    for (const event of messagesJsonEvents({ type: 'message', role: 'assistant', content: [
      { type: 'text', text: 'Progress.' }, { type: 'text', text: 'Final answer.' },
    ], stop_reason: stopReason })) live.push(...current.accept(event));
    assert.deepEqual(completedItems(live), []);
    const wire = [...live, ...current.finishEvents(usage)], result = terminal(wire);
    assert.deepEqual(completedItems(wire).map(item => item.phase), ['commentary', 'final_answer']);
    assert.equal(result.type, stopReason === 'max_tokens' ? 'response.incomplete' : 'response.completed');
    assert.equal(result.response.incomplete_details?.reason ?? null, stopReason === 'max_tokens' ? 'max_output_tokens' : null);
    assertSequence(wire);
  });
}

test('a missing message_stop or invalid trailing event cannot commit even closed content blocks', () => {
  for (const failure of ['missing_stop', 'trailing_event']) {
    const { conversion: current } = conversion(), live = [];
    const native = [...messagesJsonEvents({ type: 'message', role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'SOURCE_STATE' }, { type: 'text', text: 'Partial answer.' },
    ], stop_reason: 'end_turn' })];
    for (const event of failure === 'missing_stop' ? native.slice(0, -1) : native) live.push(...current.accept(event));
    assert.deepEqual(completedItems(live), []);
    if (failure === 'missing_stop') assert.throws(() => [...current.finishEvents(usage)], /未完整结束/);
    else assert.throws(() => current.accept({ type: 'ping' }), /事件顺序无效/);
    assert.deepEqual(current.response('failed').output, []);
    assertSequence(live);
  }
});

async function abortAtCommittedReasoning(response, abort) {
  const reader = response.body.getReader(), parser = new MessagesSseParser(), wire = [];
  let reached = false;
  try {
    while (true) {
      const { done, value } = await reader.read(), batch = parser.push(value, done);
      for (const event of batch) {
        wire.push(event);
        if (!reached && event.type === 'response.output_item.done' && event.item.type === 'reasoning') {
          reached = true;
          assert.equal(batch.at(-1).type, 'response.completed', 'The terminal response is already in the same enqueued chunk.');
          abort.abort();
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  assert.equal(reached, true);
  assert.equal(wire.some(event => event.type === 'response.failed'), false);
  assert.equal(terminal(wire).type, 'response.completed');
  assert.deepEqual(completedItems(wire), terminal(wire).response.output);
  assertSequence(wire);
  return wire;
}

test('CodeBuddy publishes the whole successful reasoning and tool commit before a local abort can interrupt it', async () => {
  const state = fixture(({ body }) => [reasoning, text, chunk({ tool_calls: [
    { index: 0, id: 'committed_read', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"path":"project.json"}' } },
  ] }), chunk({}, 'tool_calls'), '[DONE]']), abort = new AbortController();
  const wire = await abortAtCommittedReasoning(await state.request({ ...base, tools: [tool] }, abort.signal), abort);
  assert.equal(state.calls.length, 1);
  const call = completedItems(wire).find(item => item.type === 'function_call');
  assert.equal(call.name, 'read_file'); assert.equal(call.call_id, 'committed_read');
  assert.equal(call.arguments, '{"path":"project.json"}');
  assert.equal(completedItems(wire).find(item => item.type === 'message').phase, 'commentary');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(state.sources.every(source => !source.body.locked), 'The completed source reader is released after the terminal batch.');
});

test('Messages publishes the whole successful reasoning and tool commit before a local abort can interrupt it', async () => {
  let calls = 0, source;
  const adapter = new MessagesResponsesAdapter({ stateSecret: 'offline-atomic-stream-secret-without-credentials', requestMessages: async ({ body }) => {
    calls++;
    source = Response.json({ type: 'message', role: 'assistant', model: 'fixture-model', content: [
      { type: 'thinking', thinking: '', signature: 'OPAQUE_SOURCE_SIGNATURE' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'messages_read', name: body.tools[0].name, input: { path: 'project.json' } },
    ], stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 5 } });
    return source;
  } }), abort = new AbortController();
  const response = await adapter.request({ body: { model: 'fixture-model', stream: true, input: 'Inspect.', tools: [tool] },
    scope: '39d276e4-f1fc-4ab0-919c-5e6dc3022cdf', signal: abort.signal });
  const wire = await abortAtCommittedReasoning(response, abort);
  assert.equal(calls, 1);
  assert.equal(completedItems(wire).find(item => item.type === 'function_call').call_id, 'messages_read');
  assert.equal(terminal(wire).response.usage.input_tokens, 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(source.body.locked, false);
});

test('Cursor publishes its complete continuation and terminal response before a local abort', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-stream-commit-cursor-')));
  let provider;
  t.after(async () => { await provider?.close(); await rm(directory, { recursive: true, force: true }); });
  const sdk = { JsonlLocalAgentStore: class {}, Agent: { async create() {
    return { agentId: 'offline-atomic-agent', close() {}, async send() {
      return { id: 'offline-atomic-run', async *stream() {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] } };
      }, wait: async () => ({ status: 'finished' }), cancel: async () => {} };
    } };
  } } };
  provider = new CursorResponsesProvider({ stateDir: directory, sdkLoader: async () => sdk, cursorService: { enabled: true,
    credential: async () => ({ apiKey: 'offline-test-key', apiKeyExpiresAtMs: Date.now() + 60_000 }),
    status: async () => ({ enabled: true, authReady: true }),
    getModels: async () => [{ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' }] } });
  const abort = new AbortController(), response = await provider.request({ path: '/responses',
    body: { model: 'Cursor-gemini-4-argon', stream: true, input: 'Inspect.' }, signal: abort.signal });
  const wire = await abortAtCommittedReasoning(response, abort);
  assert.equal(completedItems(wire).find(item => item.type === 'message').content[0].text, 'Finished.');
  assert.equal(provider.activeRuns, 0);
});

test('an earlier HY4 reasoning-only retry tail recovers after an explicit new user message without dropping state or history', async () => {
  const state = fixture(answer()), first = terminal(await events(await state.request())).response;
  const earlierReasoning = first.output.find(item => item.type === 'reasoning');
  const tail = [...base.input, earlierReasoning], before = structuredClone(tail);
  const rejected = await state.request({ ...base, input: tail });
  assert.equal(rejected.status, 400); await rejected.text();
  assert.equal(state.calls.length, 1);
  const recovered = await state.request({ ...base, input: [...tail, { role: 'user', content: 'Continue the inspection.' }] });
  assert.equal(recovered.status, 200); assert.equal(terminal(await events(recovered)).type, 'response.completed');
  assert.equal(state.calls.length, 2);
  assert.deepEqual(tail, before);
  const replay = state.calls[1].body.messages;
  assert.ok(replay.some(message => message.role === 'assistant' && message.content === 'Earlier completed answer.'));
  assert.ok(replay.some(message => message.role === 'assistant' && message.reasoning === 'PRIVATE_TEST_REASONING'));
  assert.equal(replay.at(-1).content, 'Continue the inspection.');
});
