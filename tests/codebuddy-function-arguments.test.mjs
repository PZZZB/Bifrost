import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';

const model = 'CodeBuddy-gpt-6.1-sol';
const tool = { type: 'function', name: 'lookup', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} };
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function reply(values) {
  return new Response(values.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function toolReply(name, argumentsText) {
  const middle = Math.floor(argumentsText.length / 2);
  return reply([
    chunk({ tool_calls: [{ index: 0, id: 'call_bad_args', type: 'function',
      function: { name, arguments: argumentsText.slice(0, middle) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(middle) } }] }),
    chunk({}, 'tool_calls'), '[DONE]',
  ]);
}
function fixture() {
  const calls = [];
  const client = {
    async status() { return { authenticated: true, identity: { uid: 'offline-employee' } }; },
    async modelCatalog() { return [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', supportsToolCall: true }]; },
    async chatCompletions({ body }) { calls.push(body); return client.respond(body); },
  };
  const provider = new CodeBuddyProvider({ client });
  const adapter = new CodeBuddyResponsesProvider({ provider });
  const request = body => adapter.request({ path: '/responses', body: Buffer.from(JSON.stringify(body)) });
  return { client, provider, request, calls };
}
const input = { model, stream: false, tools: [tool], input: [{ role: 'user', content: 'Offline tool fixture.' }] };
async function responseBody(response, streaming) {
  if (!streaming) return response.json();
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean)
    .map(event => JSON.parse(event.split(/\r?\n/).find(line => line.startsWith('data: ')).slice(6)));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.some(event => event.type === 'error' || event.type === 'response.failed'), false);
  return events.at(-1).response;
}

test('Responses preserves ordinary function arguments and replays client validation errors to CodeBuddy', async () => {
  for (const streaming of [false, true]) for (const argumentsText of [
    '{"path":', '', '[]', '{"value":1e400}', '{"path":"unescaped\nnewline"}', ' { "path" : "x.txt" }\n',
  ]) {
    const { client, request, calls } = fixture();
    client.respond = body => toolReply(body.tools[0].function.name, argumentsText);
    const first = await request({ ...input, stream: streaming });
    assert.equal(first.status, 200);
    const response = await responseBody(first, streaming);
    const call = response.output.find(item => item.type === 'function_call');
    assert.equal(call.name, 'lookup'); assert.equal(call.arguments, argumentsText);
    client.respond = () => reply([chunk({ content: 'Client feedback accepted.' }), chunk({}, 'stop'), '[DONE]']);
    const next = await request({ ...input, input: [...input.input, call,
      { type: 'function_call_output', call_id: call.call_id, output: 'CLIENT_ARGUMENT_VALIDATION_ERROR' }] });
    assert.equal(next.status, 200);
    assert.equal((await next.json()).status, 'completed');
    const history = calls[1].messages.find(item => item.tool_calls?.length);
    assert.equal(history.tool_calls[0].function.arguments, argumentsText);
    assert.equal(history.tool_calls[0].id, call.call_id);
    assert.equal(calls[1].messages.find(item => item.role === 'tool').content, 'CLIENT_ARGUMENT_VALIDATION_ERROR');
    assert.equal(calls.length, 2);
  }
});

test('Responses keeps malformed namespaced history when tools are disabled for the next request', async () => {
  const { client, request, calls } = fixture();
  client.respond = body => toolReply(body.tools[0].function.name, '{"path":');
  const first = await request({ ...input, tools: [{ type: 'namespace', name: 'workspace', tools: [tool] }] });
  const call = (await first.json()).output.find(item => item.type === 'function_call');
  assert.equal(call.namespace, 'workspace'); assert.deepEqual(call.encrypted_function_args, []);
  client.respond = () => reply([chunk({ content: 'Feedback retained.' }), chunk({}, 'stop'), '[DONE]']);
  const next = await request({ ...input, tools: [], tool_choice: 'none', input: [...input.input, call,
    { type: 'function_call_output', call_id: call.call_id, output: 'CLIENT_ARGUMENT_VALIDATION_ERROR' }] });
  assert.equal(next.status, 200); assert.equal((await next.json()).status, 'completed');
  assert.equal(calls[1].messages.find(item => item.tool_calls?.length).tool_calls[0].function.arguments, '{"path":');
  assert.equal(calls[1].tool_choice, 'none');
});

test('custom tools and tool search still require their structured argument envelope', async () => {
  for (const declaration of [
    { type: 'custom', name: 'patch', format: { type: 'text' } },
    { type: 'tool_search', execution: 'client' },
  ]) {
    const { client, request } = fixture();
    client.respond = body => toolReply(body.tools[0].function.name, 'PRIVATE_UNSTRUCTURED_ARGUMENTS');
    const response = await request({ ...input, tools: [declaration] });
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.error.sourceDiagnostics.check, 'tool_arguments_json');
    assert.equal(JSON.stringify(failure).includes('PRIVATE_UNSTRUCTURED_ARGUMENTS'), false);
  }
});

test('tool declarations and forced choices remain enforced before raw argument delivery', async () => {
  for (const variant of ['unknown', 'forbidden', 'forced']) {
    const { client, request } = fixture();
    client.respond = body => toolReply(variant === 'unknown' ? 'unknown_private_tool' : body.tools[0].function.name, '{');
    const second = { ...tool, name: 'other_lookup' };
    const response = await request({ ...input, tools: [tool, second],
      ...(variant === 'forbidden' ? { tool_choice: 'none' } : {}),
      ...(variant === 'forced' ? { tool_choice: { type: 'function', name: second.name } } : {}) });
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.error.sourceDiagnostics.check,
      { unknown: 'tool_not_declared', forbidden: 'tools_forbidden', forced: 'forced_tool_mismatch' }[variant]);
  }
});

const messagesInput = { model, max_tokens: 128, stream: true, tools: [
  { name: 'lookup', input_schema: tool.parameters }], messages: [{ role: 'user', content: 'Offline.' }] };
test('the Messages endpoint keeps object validation and rejects raw-mode HTTP fields', async () => {
  const { client, provider } = fixture();
  client.respond = () => toolReply('lookup', '{"path":');
  const first = await provider.request({ path: '/v1/messages', body: messagesInput });
  const wire = await first.text();
  assert.match(wire, /tool_arguments_json/); assert.equal(wire.includes('message_stop'), false);
  const forbidden = await provider.request({ path: '/v1/messages', body: {
    ...messagesInput, rawFunctionTools: ['lookup'], rawFunctionArguments: {},
  } });
  assert.equal(forbidden.status, 400);
});

test('private raw argument history must match a unique placeholder call and its result', async () => {
  for (const variant of ['name', 'missing', 'nonempty', 'result']) {
    const { client, provider, calls } = fixture();
    client.respond = () => reply([chunk({ content: 'Done.' }), chunk({}, 'stop'), '[DONE]']);
    const response = await provider.request({ path: '/v1/messages', body: {
      ...messagesInput, messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_history', name: 'lookup',
          input: variant === 'nonempty' ? { path: 'do not overwrite' } : {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: variant === 'result' ? 'other_call' : 'call_history', content: 'Error.' }] },
      ],
    }, rawFunctionArguments: new Map([[variant === 'missing' ? 'other_call' : 'call_history', {
      name: variant === 'name' ? 'other_lookup' : 'lookup', arguments: '{"path":',
    }]]) });
    assert.equal(response.status, 400); assert.equal(calls.length, 0);
  }
});

test('private raw argument options are snapshotted before asynchronous metadata reads', async () => {
  const { client, provider, calls } = fixture();
  client.respond = body => {
    assert.equal(body.messages[0].tool_calls[0].function.arguments, '{"path":');
    return toolReply('lookup', '{"path":');
  };
  const rawFunctionTools = new Set(['lookup']);
  const saved = { name: 'lookup', arguments: '{"path":' };
  const rawFunctionArguments = new Map([['call_history', saved]]);
  const pending = provider.request({ path: '/v1/messages', body: { ...messagesInput, messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_history', name: 'lookup', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_history', content: 'Error.' }] },
  ] }, rawFunctionTools, rawFunctionArguments });
  rawFunctionTools.clear(); rawFunctionTools.add('undeclared');
  saved.arguments = 'MUTATED_PRIVATE_ARGUMENTS'; rawFunctionArguments.clear();
  const response = await pending;
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /message_stop/); assert.equal(wire.includes('MUTATED_PRIVATE_ARGUMENTS'), false);
  assert.equal(calls.length, 1);
});

test('providers without raw argument support retain structured Messages history', async () => {
  let captured;
  const adapter = new CodeBuddyResponsesProvider({ provider: {
    async status() { return {}; },
    async request(options) {
      captured = options;
      return Response.json({ id: 'msg_legacy', type: 'message', role: 'assistant', model: CODEBUDDY_MODEL.id,
        content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    },
  } });
  const response = await adapter.request({ path: '/responses', body: { ...input, model: CODEBUDDY_MODEL.id, input: [
    ...input.input, { type: 'function_call', call_id: 'call_history', name: tool.name, arguments: '{"path":"x.txt"}' },
    { type: 'function_call_output', call_id: 'call_history', output: 'File contents.' },
  ] } });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'completed');
  const history = JSON.parse(captured.body).messages.find(message => message.role === 'assistant');
  assert.deepEqual(history.content[0].input, { path: 'x.txt' });
  assert.equal(Object.hasOwn(captured, 'rawFunctionArguments'), false);
  assert.equal(Object.hasOwn(captured, 'rawFunctionTools'), false);
});
