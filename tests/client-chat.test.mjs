import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientChatAdapter } from '../src/client-chat.mjs';

const MODEL = 'claude-codebuddy-opus-5-5';
const user = text => ({ role: 'user', content: text });
const initial = (extra = {}) => ({ model: MODEL, messages: [user('Hello')], ...extra });
const reasoning = encrypted_content => ({ type: 'reasoning', encrypted_content, summary: [] });
const textItem = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const callItem = (args = '{"path":"a.txt"}', call_id = 'call_1') => ({ type: 'function_call', id: 'fc_1', call_id, name: 'read_file', arguments: args, status: 'completed' });
const final = (output = [textItem('Hello back')], extra = {}) => ({ object: 'response', status: 'completed', model: MODEL,
  output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } }, ...extra });
const toolHistory = (assistant, prefix = [user('Hello')]) => [...prefix, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'file text' }];
const tool = { type: 'function', function: { name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } };
function jsonResponse(output, extra) { return Response.json(final(output, extra)); }
function sse(events, { split = false, end = true } = {}) {
  const encoded = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + (end ? 'data: [DONE]\n\n' : ''));
  const bytes = split ? Array.from({ length: encoded.length }, (_, index) => encoded.subarray(index, index + 1)) : [encoded];
  return new Response(new ReadableStream({ pull(controller) { const next = bytes.shift(); if (next) controller.enqueue(next); else controller.close(); } }),
    { headers: { 'Content-Type': 'text/event-stream' } });
}
function chunks(text) { return text.split(/\n\n/).filter(Boolean).map(frame => frame.slice(6)).map(value => value === '[DONE]' ? value : JSON.parse(value)); }

test('maps Chat text, instructions, tools, images, and response format without executing tools', async () => {
  let received;
  const adapter = new ClientChatAdapter({ requestResponses: async value => { received = value; return jsonResponse(); } });
  const request = initial({ messages: [{ role: 'system', content: 'System rule' }, { role: 'developer', content: 'Developer rule' },
    { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }] }],
    tools: [tool], tool_choice: { type: 'function', function: { name: 'read_file' } }, parallel_tool_calls: false,
    temperature: 0.5, top_p: 0.9, max_completion_tokens: 40, reasoning_effort: 'high', n: 1, store: false,
    response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' }, strict: true } } });
  const response = await adapter.request({ body: request, scope: 'tenant-one' });
  assert.equal(response.status, 200);
  assert.equal(received.scope, 'tenant-one'); assert.equal(received.body.stream, true); assert.equal(received.body.store, false);
  assert.deepEqual(received.body.include, ['reasoning.encrypted_content']);
  assert.equal(received.body.input[0].role, 'system'); assert.equal(received.body.input[1].role, 'developer');
  assert.deepEqual(received.body.input[2].content[1], { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'high' });
  assert.deepEqual(received.body.tools, [{ type: 'function', ...tool.function }]);
  assert.deepEqual(received.body.tool_choice, { type: 'function', name: 'read_file' });
  assert.equal(received.body.max_output_tokens, 40); assert.deepEqual(received.body.reasoning, { effort: 'high' });
  assert.deepEqual(received.body.text.format, { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: true });
  assert.equal(request.messages[2].content[1].type, 'image_url');
  const result = await response.json();
  assert.equal(result.object, 'chat.completion'); assert.equal(result.choices[0].message.content, 'Hello back');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } });
});

test('tool continuations recover only opaque state tied to scope, model, and the complete history', async () => {
  const received = [];
  const adapter = new ClientChatAdapter({ requestResponses: async value => { received.push(value); return received.length === 1
    ? jsonResponse([reasoning('opaque-encrypted-value'), callItem()]) : jsonResponse([reasoning('opaque-new-checkpoint'), textItem('Done')]); } });
  const first = await (await adapter.request({ body: initial({ tools: [tool] }), scope: 'account-one' })).json();
  const assistant = first.choices[0].message, history = toolHistory(assistant);
  assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(assistant.tool_calls[0].id, 'call_1');
  for (const value of [
    { scope: 'account-two', body: { model: MODEL, messages: history } },
    { scope: 'account-one', body: { model: 'Cursor-grok-4.7', messages: history } },
    { scope: 'account-one', body: { model: MODEL, messages: toolHistory(assistant, [user('Changed history')]) } },
  ]) {
    const response = await adapter.request(value); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'client_chat_state_missing');
  }
  assert.equal(received.length, 1);
  const second = await adapter.request({ body: { model: MODEL, messages: history, tools: [tool] }, scope: 'account-one' });
  assert.equal(second.status, 200);
  assert.deepEqual(received[1].body.input.filter(item => item.type === 'reasoning'), [reasoning('opaque-encrypted-value')]);
  assert.deepEqual(received[1].body.input.find(item => item.type === 'function_call'), { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' });
  assert.deepEqual(received[1].body.input.at(-1), { type: 'function_call_output', call_id: 'call_1', output: 'file text' });
  assert.equal((await adapter.request({ body: { model: MODEL, messages: history }, scope: 'account-one' })).status, 409);
});

test('the next turn can include earlier consumed checkpoints and an equivalent text-array history', async () => {
  const received = [];
  const adapter = new ClientChatAdapter({ requestResponses: async value => {
    received.push(value); return received.length === 1 ? jsonResponse([reasoning('state-1'), callItem()]) : jsonResponse([reasoning(`state-${received.length}`), textItem('Done')]);
  } });
  const one = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  const history = toolHistory(one.choices[0].message);
  history[0] = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
  const two = await (await adapter.request({ body: { model: MODEL, messages: history }, scope: 'scope' })).json();
  const three = await adapter.request({ body: { model: MODEL, messages: [...history, two.choices[0].message, user('Next')] }, scope: 'scope' });
  assert.equal(three.status, 200);
  assert.deepEqual(received[2].body.input.filter(item => item.type === 'reasoning').map(item => item.encrypted_content), ['state-1', 'state-2']);
});

test('a tool response without reasoning is tracked, but a lost gateway cache fails explicitly before dispatch', async () => {
  let called = 0;
  const adapter = new ClientChatAdapter({ requestResponses: async () => { called++; return jsonResponse([callItem()]); } });
  const first = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  const other = new ClientChatAdapter({ requestResponses: async () => { throw new Error('must not dispatch'); } });
  const history = toolHistory(first.choices[0].message);
  assert.equal((await other.request({ body: { model: MODEL, messages: history }, scope: 'scope' })).status, 409);
  assert.equal((await adapter.request({ body: { model: MODEL, messages: history }, scope: 'scope' })).status, 200);
  assert.equal(called, 2);
});

test('cache entries expire, evict by the bounded capacity, and expose no prompts in status', async () => {
  let now = 0;
  const adapter = new ClientChatAdapter({ now: () => now, maxEntries: 1, ttlMs: 100,
    requestResponses: async () => jsonResponse([reasoning('encrypted-only'), callItem()]) });
  const one = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  await (await adapter.request({ body: initial({ messages: [user('Different text')] }), scope: 'scope' })).json();
  assert.deepEqual(adapter.status(), { entries: 1, maximum: 1, ttlMs: 100, memoryOnly: true });
  assert.equal((await adapter.request({ body: initial({ messages: toolHistory(one.choices[0].message) }), scope: 'scope' })).status, 409);
  now = 100; assert.equal(adapter.status().entries, 0);
});

test('SSE converts text and function argument deltas, preserves UTF-8, and ends with usage and DONE', async () => {
  const item = callItem('{"path":"中文.txt"}');
  const adapter = new ClientChatAdapter({ requestResponses: async () => sse([
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, delta: '检查' },
    { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: item.id, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: item.id, delta: '"中文.txt"}' },
    { type: 'response.completed', response: final([textItem('检查'), item]) },
  ], { split: true }) });
  const response = await adapter.request({ body: initial({ stream: true, stream_options: { include_usage: true } }), scope: 'scope' });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const values = chunks(await response.text());
  assert.equal(values.at(-1), '[DONE]'); assert.equal(values.at(-2).choices.length, 0); assert.equal(values.at(-2).usage.total_tokens, 14);
  assert.equal(values.at(-3).choices[0].finish_reason, 'tool_calls');
  assert.equal(values[0].choices[0].delta.role, 'assistant');
  assert.equal(values.filter(value => value !== '[DONE]').flatMap(value => value.choices).map(choice => choice.delta.content ?? '').join(''), '检查');
  const calls = values.flatMap(value => value === '[DONE]' ? [] : value.choices.flatMap(choice => choice.delta.tool_calls ?? []));
  assert.equal(calls[0].id, 'call_1'); assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls.map(call => call.function.arguments).join(''), '{"path":"中文.txt"}');
});

test('parallel tool calls use stable Chat indexes and map each result by call_id', async () => {
  let turn = 0, received;
  const firstCall = callItem('{}', 'call_a'), secondCall = { ...callItem('{}', 'call_b'), id: 'fc_b', name: 'write_file' };
  const adapter = new ClientChatAdapter({ requestResponses: async value => {
    received = value; return ++turn === 1 ? jsonResponse([reasoning('opaque'), firstCall, secondCall]) : jsonResponse([textItem('All done')]);
  } });
  const first = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  const assistant = first.choices[0].message;
  const response = await adapter.request({ body: initial({ messages: [user('Hello'), assistant,
    { role: 'tool', tool_call_id: 'call_b', content: [{ type: 'text', text: 'write result' }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: 'read result' }] }), scope: 'scope' });
  assert.equal(response.status, 200);
  assert.deepEqual(received.body.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['call_b', 'call_a']);
  assert.equal(received.body.input.at(-2).output[1].type, 'input_image');
});

test('unknown request fields, unsupported files, invalid histories, and unsupported options reject before dispatch', async () => {
  let called = 0;
  const adapter = new ClientChatAdapter({ requestResponses: async () => { called++; return jsonResponse(); } });
  const cases = [initial({ unknown: true }), initial({ n: 2 }), initial({ store: true }), initial({ stop: 'END' }),
    initial({ frequency_penalty: 0.5 }), initial({ max_tokens: 1, max_completion_tokens: 1 }), initial({ stream: 'yes' }),
    initial({ temperature: 3 }), initial({ tool_choice: { type: 'custom' } }), initial({ tools: [{ type: 'web_search' }] }),
    initial({ response_format: { type: 'unsupported' } }), initial({ messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file_1' } }] }] }),
    initial({ messages: [{ role: 'tool', tool_call_id: 'unmatched', content: 'result' }] }),
    initial({ messages: [{ role: 'assistant', content: 'No final user' }] }),
    initial({ messages: [{ role: 'user', name: 'extra', content: 'text' }] }),
    initial({ messages: [user('Hello'), { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'x', arguments: '[]' } }] }] }),
  ];
  for (const body of cases) { const response = await adapter.request({ body, scope: 'scope' }); assert.equal(response.status, 400, JSON.stringify(body)); }
  assert.equal((await adapter.request({ body: initial(), scope: '' })).status, 400); assert.equal(called, 0);
});

test('JSON byte bodies are decoded strictly and getters or nonfinite values are never passed upstream', async () => {
  let called = 0;
  const adapter = new ClientChatAdapter({ requestResponses: async () => { called++; return jsonResponse(); } });
  assert.equal((await adapter.request({ body: Buffer.from(JSON.stringify(initial())), scope: 'scope' })).status, 200);
  for (const body of ['not JSON', Buffer.from([0xff]), initial({ top_p: Infinity }), { get model() { throw new Error('must not run'); } }]) {
    assert.equal((await adapter.request({ body, scope: 'scope' })).status, 400);
  }
  assert.equal(called, 1);
});

test('truncated, failed, and malformed SSE produce an explicit error without success DONE', async () => {
  for (const events of [
    [{ type: 'response.output_text.delta', delta: 'Partial' }],
    [{ type: 'response.output_text.delta', delta: 'Partial' }, { type: 'response.failed', response: { status: 'failed' } }],
    [{ type: 'response.unknown_event' }],
    [{ type: 'response.completed', response: final([textItem('Good')]) }, { type: 'response.output_text.delta', delta: 'Forged extra' }],
  ]) {
    const adapter = new ClientChatAdapter({ requestResponses: async () => sse(events) });
    const response = await adapter.request({ body: initial({ stream: true }), scope: 'scope' });
    const values = chunks(await response.text());
    assert.ok(values.at(-1).error); assert.equal(values.includes('[DONE]'), false);
    assert.equal(values.some(value => value.choices?.some(choice => choice.finish_reason !== null)), false);
    assert.equal(adapter.status().entries, 0);
  }
  const malformed = new ClientChatAdapter({ requestResponses: async () => new Response('data: {bad}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) });
  assert.equal((await malformed.request({ body: initial(), scope: 'scope' })).status, 502);
});

test('unknown or unrepresentable Responses output is not silently discarded', async () => {
  for (const output of [[{ type: 'custom_tool_call', call_id: 'c', name: 'x', input: 'raw' }],
    [{ ...callItem(), arguments: 'invalid JSON' }], [{ ...callItem(), status: 'in_progress' }],
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Cited', annotations: [{ type: 'url_citation' }] }] }],
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_image', image_url: 'data:image/png;base64,YQ==' }] }]]) {
    const adapter = new ClientChatAdapter({ requestResponses: async () => jsonResponse(output) });
    const response = await adapter.request({ body: initial(), scope: 'scope' }); assert.equal(response.status, 502); assert.equal(adapter.status().entries, 0);
  }
});

test('assistant tool history may omit content, as permitted by Chat Completions', async () => {
  let turn = 0;
  const adapter = new ClientChatAdapter({ requestResponses: async () => ++turn === 1 ? jsonResponse([callItem()]) : jsonResponse([textItem('Done')]) });
  const first = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  delete first.choices[0].message.content;
  assert.equal((await adapter.request({ body: initial({ messages: toolHistory(first.choices[0].message) }), scope: 'scope' })).status, 200);
});

test('nonstream length and content filter endings are represented without creating resumable state', async () => {
  for (const [reason, expected] of [['max_output_tokens', 'length'], ['content_filter', 'content_filter']]) {
    const adapter = new ClientChatAdapter({ requestResponses: async () => jsonResponse([textItem('Partial')], { status: 'incomplete', incomplete_details: { reason } }) });
    const result = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
    assert.equal(result.choices[0].finish_reason, expected); assert.equal(adapter.status().entries, 0);
  }
});

test('refusal output maps to the Chat refusal field', async () => {
  const adapter = new ClientChatAdapter({ requestResponses: async () => jsonResponse([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot do that' }] }]) });
  const result = await (await adapter.request({ body: initial(), scope: 'scope' })).json();
  assert.equal(result.choices[0].message.content, null); assert.equal(result.choices[0].message.refusal, 'Cannot do that');
});

test('upstream HTTP errors retain status and never expose provider body or unexpected exception messages', async () => {
  for (const requestResponses of [async () => Response.json({ error: { message: 'private bearer sk-do-not-leak' } }, { status: 403 }),
    async () => { throw new Error('private password do-not-leak'); }]) {
    const adapter = new ClientChatAdapter({ requestResponses });
    const response = await adapter.request({ body: initial(), scope: 'scope' }), serialized = await response.text();
    assert.ok([403, 502].includes(response.status)); assert.equal(serialized.includes('do-not-leak'), false);
  }
});

test('already cancelled requests do not dispatch and downstream cancellation aborts the upstream reader', async () => {
  let called = 0, upstreamSignal, cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const adapter = new ClientChatAdapter({ requestResponses: async ({ signal }) => {
    called++; upstreamSignal = signal;
    return new Response(new ReadableStream({ cancel() { cancelled(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.equal((await adapter.request({ body: initial(), scope: 'scope', signal: AbortSignal.abort() })).status, 499); assert.equal(called, 0);
  const response = await adapter.request({ body: initial({ stream: true }), scope: 'scope' });
  await response.body.cancel(); await cancellation;
  assert.equal(upstreamSignal.aborted, true);
});

test('closing the adapter removes continuation state and rejects new requests', async () => {
  const adapter = new ClientChatAdapter({ requestResponses: async () => jsonResponse([reasoning('private-state'), callItem()]) });
  await adapter.request({ body: initial(), scope: 'scope' }); assert.equal(adapter.status().entries, 1);
  adapter.close(); assert.equal(adapter.status().entries, 0);
  assert.equal((await adapter.request({ body: initial(), scope: 'scope' })).status, 503);
});
