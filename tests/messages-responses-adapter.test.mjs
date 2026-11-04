import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';

const scope = '203cc356-cb05-4a8e-8f5e-363b768eb97e';
const request = { model: 'plain-provider-model', input: 'hello', store: false };
const codexIncludes = ['reasoning.encrypted_content', 'output.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results'];
const optionalIncludes = [...codexIncludes, 'code_interpreter_call.outputs', 'computer_call_output.output.image_url',
  'file_search_call.results', 'message.input_image.image_url'];
const reply = content => Response.json({ type: 'message', role: 'assistant', model: request.model, content, stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });

test('adapter reconstruction preserves scoped priority markers and exact native history', async () => {
  const calls = [], secret = randomBytes(32).toString('base64url');
  const body = { ...request, input: [{ role: 'user', content: 'Original task.' },
    { role: 'assistant', content: 'Earlier answer.' }, { role: 'developer', content: 'A later priority update.' },
    { role: 'user', content: 'Continue with that update.' }] };
  const send = async (stateSecret, scope, input = body) => {
    const adapter = new MessagesResponsesAdapter({ stateSecret, requestMessages: async value => {
      calls.push(structuredClone(value.body)); return reply([{ type: 'text', text: 'Earlier answer.' }]);
    } });
    const response = await adapter.request({ body: input, scope });
    assert.equal(response.status, 200); await response.text();
  };
  await send(secret, scope, { ...request, input: body.input.slice(0, 1) });
  await send(secret, scope); await send(secret, scope);
  assert.deepEqual(calls[1].system, calls[0].system, 'The first late priority update must not replace the global native prompt.');
  assert.deepEqual(calls[1].messages.slice(0, -1), [...calls[0].messages,
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer.' }] }], 'The completed native prefix must not include a new, separate priority-update turn.');
  assert.equal(calls[1].messages.at(-1).content.length, 2);
  assert.match(calls[1].messages.at(-1).content[0].text, /role=developer/);
  assert.equal(calls[1].messages.at(-1).content[1].text, 'Continue with that update.');
  assert.deepEqual(calls[2], calls[1], 'Recreating an adapter with persisted state must not rewrite native context.');
  await send(secret, 'different-caller'); await send(randomBytes(32).toString('base64url'), scope);
  assert.notDeepEqual(calls[3].system, calls[1].system, 'Other callers must have distinct private markers.');
  assert.notDeepEqual(calls[4].system, calls[1].system, 'Rotated private state must change the marker.');
  assert.equal(calls.length, 5, 'Each client request must dispatch once.');
});

async function result(response, stream) {
  if (!stream) return response.json();
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = (await response.text()).trim().split(/\r?\n\r?\n/).map(frame =>
    JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5)));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.filter(event => event.type === 'response.completed').length, 1);
  assert.ok(events.every(event => event.type !== 'response.failed'));
  return events.at(-1).response;
}

for (const stream of [false, true]) test(`Codex web-source include is optional metadata for ${stream ? 'SSE' : 'JSON'} and never enables hosted search`, async () => {
  const calls = [], session = 'adapter-fixture-session';
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async value => { calls.push(value); return reply([{ type: 'text', text: 'fixture reply' }]); } });
  const clientTool = { type: 'function', name: 'local_echo', parameters: { type: 'object', properties: { value: { type: 'string' } } } };
  const body = { ...request, stream, include: [...codexIncludes], tools: [clientTool, { type: stream ? 'web_search_preview' : 'web_search' }], tool_choice: 'auto' };
  const original = structuredClone(body);
  const response = await adapter.request({ body, scope, session });
  assert.equal(response.status, 200); const data = await result(response, stream);
  assert.equal(calls.length, 1); assert.equal(calls[0].scope, scope); assert.equal(calls[0].session, session);
  assert.equal(calls[0].body.model, request.model); assert.equal(calls[0].body.include, undefined);
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.equal(calls[0].body.tools.length, 1); assert.ok(calls[0].body.tools[0].name.startsWith('cb_'));
  assert.ok(calls[0].body.system.some(block => block.text.includes('web search is unavailable')));
  assert.ok(calls[0].body.tools.every(tool => !['web_search', 'web_search_preview'].includes(tool.type)));
  assert.equal(data.model, request.model); assert.equal(data.status, 'completed');
  assert.deepEqual(data.tools, [clientTool]); assert.equal(data.output[0].content[0].text, 'fixture reply');
  assert.equal(data.usage.input_tokens, 9); assert.equal(data.usage.output_tokens, 3);
  assert.equal(data.usage.input_tokens_details.cached_tokens, 2);
  assert.ok(data.output.every(item => item.type !== 'web_search_call'));
  assert.doesNotMatch(JSON.stringify(data), /"sources"\s*:/);
  assert.deepEqual(body, original, 'translation must not mutate the client request');
});

test('null, empty and individual optional includes never require or fabricate extra tool results', async () => {
  const calls = [];
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async value => { calls.push(value); return reply([{ type: 'text', text: 'fixture reply' }]); } });
  for (const include of [null, [], ...optionalIncludes.map(value => [value]), optionalIncludes]) {
    const response = await adapter.request({ body: { ...request, include }, scope });
    assert.equal(response.status, 200); const data = await response.json();
    assert.equal(data.output[0].content[0].text, 'fixture reply');
    assert.ok(data.output.every(item => item.type === 'message'));
    assert.doesNotMatch(JSON.stringify(data), /"sources"\s*:/);
    for (const part of data.output.flatMap(item => item.content ?? [])) {
      if (part.logprobs !== undefined && part.logprobs !== null) assert.deepEqual(part.logprobs, [], 'The schema may contain an empty list, never fabricated token scores.');
    }
    assert.equal(calls.at(-1).body.include, undefined);
  }
  assert.equal(calls.length, 11);
});

test('invalid or unsupported include values fail before transport without reflecting private values', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async () => { calls++; return reply([{ type: 'text', text: 'unexpected' }]); } });
  for (const include of [12, {}, 'reasoning.encrypted_content', [null], [12], [{ private: 'PRIVATE_INCLUDE_VALUE' }],
    ['PRIVATE_INCLUDE_VALUE'], ['reasoning.encrypted_content', 'PRIVATE_INCLUDE_VALUE'],
    ['message.output_text.logprobs']]) {
    const response = await adapter.request({ body: { ...request, include }, scope });
    assert.equal(response.status, 400); const data = await response.json();
    assert.equal(data.error.param, 'include'); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_INCLUDE_VALUE/);
  }
  assert.equal(calls, 0);
});

test('Messages rejects requested logprobs explicitly instead of treating it as an unknown selector', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async () => { calls++; return reply([{ type: 'text', text: 'unexpected' }]); } });
  const response = await adapter.request({ body: { ...request, include: ['message.output_text.logprobs'] }, scope });
  assert.equal(response.status, 400); const body = await response.json();
  assert.equal(body.error.param, 'include'); assert.match(body.error.message, /logprobs/);
  assert.notEqual(body.error.message, '不支持请求的 include 字段。'); assert.equal(calls, 0);
});

test('optional result selectors cannot enable unsupported hosted tools or replay their historical operations', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async () => { calls++; return reply([{ type: 'text', text: 'unexpected' }]); } });
  for (const extra of [
    { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
    { tools: [{ type: 'file_search', vector_store_ids: ['fixture-store'] }] },
    { tools: [{ type: 'computer_use_preview' }] },
    ...['code_interpreter_call', 'file_search_call', 'computer_call_output'].map(type => ({ input: [
      { role: 'user', content: 'hello' }, { type, id: 'hosted-fixture', output: 'PRIVATE_HOSTED_RESULT' },
    ] })),
  ]) {
    const response = await adapter.request({ body: { ...request, include: optionalIncludes, ...extra }, scope });
    assert.equal(response.status, 400); const body = await response.json();
    assert.notEqual(body.error.param, 'include', 'The optional selector must pass before the unsupported actual operation is rejected.');
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_HOSTED_RESULT/);
  }
  assert.equal(calls, 0);
});

test('a web-source include cannot authorize forced or historical hosted search', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'),
    requestMessages: async () => { calls++; return reply([{ type: 'text', text: 'unexpected' }]); } });
  for (const [extra, param] of [
    [{ tools: [{ type: 'web_search' }], tool_choice: 'required' }, 'tool_choice'],
    [{ tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } }, 'tool_choice'],
    [{ input: [{ role: 'user', content: 'hello' }, { type: 'web_search_call', id: 'ws_fixture', action: { query: 'PRIVATE_WEB_QUERY' } }] }, 'input'],
  ]) {
    const response = await adapter.request({ body: { ...request, include: codexIncludes, ...extra }, scope });
    assert.equal(response.status, 400); const data = await response.json();
    assert.equal(data.error.param, param); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_WEB_QUERY/);
  }
  assert.equal(calls, 0);
});
test('generic Responses conversion preserves native opaque thinking and real usage without a client or provider-specific alias', async () => {
  const calls = [];
  const content = [{ type: 'thinking', thinking: 'opaque native text', signature: 'opaque native signature' }, { type: 'redacted_thinking', data: 'opaque redacted data' }, { type: 'text', text: 'reply' }];
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async value => { calls.push(value); return reply(content); } });
  const response = await adapter.request({ body: request, scope }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.model, request.model);
  assert.equal(data.usage.input_tokens, 9); assert.equal(data.usage.output_tokens, 3); assert.equal(data.usage.input_tokens_details.cached_tokens, 2);
  assert.doesNotMatch(JSON.stringify(data), /opaque native|opaque redacted/);
  const history = { ...request, input: [...data.output, { role: 'user', content: 'continue' }] };
  assert.equal((await adapter.request({ body: history, scope })).status, 200);
  assert.deepEqual(calls[1].body.messages[0].content.slice(0, 2), content.slice(0, 2));
  const foreign = await adapter.request({ body: history, scope: '07334b69-7c47-42a3-985f-63971a306eca' });
  assert.equal(foreign.status, 409); assert.equal(calls.length, 2);
});
test('unsupported state/storage and parameters fail before dispatch; inherited effort uses explicit upstream defaults', async () => {
  let calls = 0, captured;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async value => { calls++; captured = value; return reply([{ type: 'text', text: 'reply' }]); } });
  for (const body of [{ ...request, store: true }, { ...request, previous_response_id: 'other-state' },
    { ...request, input: [{ type: 'reasoning', encrypted_content: 'foreign-state' }] }, { ...request, reasoning: { effort: 'made-up' } }]) {
    assert.ok((await adapter.request({ body, scope })).status >= 400);
  }
  assert.equal(calls, 0);
  const defaults = await adapter.request({ body: { ...request, reasoning: { effort: 'high' } }, scope });
  assert.equal(defaults.status, 200); const body = await defaults.json();
  assert.equal(body.reasoning.effort, undefined); assert.equal(captured.body.output_config, undefined); assert.equal(captured.body.thinking, undefined);
});
test('an upstream rejection causes exactly one dispatch and preserves a retry delay without exposing its body', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async () => {
    calls++; return new Response('PRIVATE_ERROR_BODY_WITH_ADDRESS', { status: 429, headers: { 'retry-after': '8' } });
  } });
  const response = await adapter.request({ body: request, scope }); assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '8'); assert.equal(calls, 1); assert.doesNotMatch(await response.text(), /PRIVATE_ERROR/);
});
