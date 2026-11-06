import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyResponsesProvider, CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';

const model = CODEBUDDY_MODEL.id;
const actualModel = 'employee-opus-55';
const base = { model, stream: true, store: false, input: [{ role: 'user', content: '检查项目。' }],
  reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'] };
const optionalIncludes = ['reasoning.encrypted_content', 'output.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results',
  'code_interpreter_call.outputs', 'computer_call_output.output.image_url', 'file_search_call.results', 'message.input_image.image_url'];
const realUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 7 } };
const fn = { type: 'function', name: 'read_file', description: 'Read a client file.', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const custom = { type: 'custom', name: 'apply_patch', description: 'Apply a patch.', format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function source(frames, split = 7) {
  const bytes = Buffer.from(frames.map(frame).join('')); let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(at, at + split)); at = Math.min(bytes.length, at + split);
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
const answer = (value = '完成。🙂', usage = realUsage) => source([chunk({ role: 'assistant', reasoning_content: 'SECRET_NATIVE_THINKING' }),
  chunk({ content: value, extra_fields: { continuation: 'REAL_UPSTREAM_OPAQUE_METADATA' } }), chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
class Client {
  reads = 0;
  calls = [];
  identity = 'employee-one';
  respond = () => answer();
  status() { return { authenticated: true, identity: { uid: this.identity, username: 'employee.user' } }; }
  async modelCatalog() { this.reads++; return [{ id: actualModel, name: 'Claude Opus 5.5', supportsToolCall: true }]; }
  async chatCompletions(request) { this.calls.push(request); return this.respond(request); }
}
function fixture() {
  const client = new Client(), key = Buffer.alloc(32, 7);
  const make = () => new CodeBuddyResponsesProvider({ provider: new CodeBuddyProvider({ client,
    loadThinkingState: () => new CodeBuddyThinkingState({ key }) }) });
  const provider = make();
  return { client, provider, make,
    request: (body = base, signal, chosen = provider) => chosen.request({ path: '/responses', body: Buffer.from(JSON.stringify(body)),
      headers: new Headers({ authorization: 'Bearer MUST_NOT_REACH_CODEBUDDY', 'chatgpt-account-id': 'A_PRIVATE_ID' }), signal }) };
}
async function events(response) {
  return (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
}
const completion = values => values.findLast(value => ['response.completed', 'response.incomplete', 'response.failed'].includes(value.type));
const output = values => completion(values)?.response.output;

test('real provider chain streams text, true usage, and opaque thinking without forwarding client identity', async () => {
  const { client, provider, request } = fixture();
  const response = await request({ ...base, instructions: '顶层指令', input: [
    { role: 'system', content: '系统一' }, { role: 'developer', content: [{ type: 'input_text', text: '开发者二' }] }, ...base.input,
  ], client_metadata: { thread_id: 'LOCAL_ONLY' }, prompt_cache_key: 'LOCAL_CACHE_HINT' });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const wire = await events(response), final = completion(wire);
  assert.equal(wire[0].type, 'response.created');
  assert.equal(final.type, 'response.completed');
  assert.deepEqual(wire.map(event => event.sequence_number), wire.map((_, index) => index));
  assert.equal(wire.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), '完成。🙂');
  assert.equal(final.response.output.find(item => item.type === 'message').phase, 'final_answer');
  assert.ok(wire.some(event => event.type === 'response.content_part.added'));
  assert.ok(wire.some(event => event.type === 'response.output_item.done' && event.item.type === 'reasoning'));
  const serialized = JSON.stringify(wire);
  assert.equal(serialized.includes('SECRET_NATIVE_THINKING'), false);
  assert.equal(serialized.includes('REAL_UPSTREAM_OPAQUE_METADATA'), false);
  const thinking = final.response.output.filter(item => item.type === 'reasoning');
  assert.equal(thinking.length, 2);
  assert.ok(thinking.every(item => item.encrypted_content.startsWith(CODEBUDDY_RESPONSES_STATE_PREFIX)));
  assert.deepEqual(final.response.usage, { input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
    output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 }, total_tokens: 120 });
  assert.equal((await response.bridgeUsage).input_tokens_details.cache_write_tokens, 5);
  assert.equal(response.bridgeModel, actualModel);
  assert.deepEqual(client.calls[0].body.messages.slice(0, 3), [
    { role: 'system', content: '顶层指令' }, { role: 'system', content: '系统一' }, { role: 'system', content: '开发者二' },
  ]);
  assert.equal(JSON.stringify(client.calls[0].body).includes('MUST_NOT_REACH_CODEBUDDY'), false);
  assert.equal(JSON.stringify(client.calls[0].body).includes('LOCAL_ONLY'), false);
  assert.equal((await provider.status()).responsesCapabilities.hostedWebSearch, false);
});

test('JSON response preserves actual thinking through provider restart and full-history replay', async () => {
  const { client, make, request } = fixture();
  const first = await (await request({ ...base, stream: false })).json();
  client.respond = () => source([chunk({ content: '第二回合' }), chunk({}, 'stop'), { choices: [], usage: realUsage }, '[DONE]']);
  const nullContent = first.output.map(item => item.type === 'reasoning' ? { ...item, content: null, status: null } : item);
  const second = await request({ ...base, stream: false, input: [...base.input, ...nullContent,
    { role: 'user', content: '继续' }] }, undefined, make());
  assert.equal(second.status, 200);
  const assistant = client.calls[1].body.messages.find(message => message.role === 'assistant');
  assert.equal(assistant.reasoning, 'SECRET_NATIVE_THINKING');
  assert.deepEqual(assistant.extra_fields, { continuation: 'REAL_UPSTREAM_OPAQUE_METADATA' });
  assert.equal((await second.json()).output.at(-1).content[0].text, '第二回合');
});

for (const stream of [false, true]) for (const include of [null, ['output.encrypted_content'], optionalIncludes]) {
  test(`CodeBuddy ${stream ? 'SSE' : 'JSON'} accepts ${include === null ? 'null' : include.length === 1 ? 'encrypted output selector' : 'optional selectors'} without losing images or a client tool turn`, async () => {
    const { client, request } = fixture();
    client.respond = ({ body }) => source([chunk({ reasoning_content: 'PRIVATE_INCLUDE_TOOL_STATE', extra_fields: { checkpoint: 'include-turn' } }),
      chunk({ tool_calls: [{ index: 0, id: 'include_tool_call', type: 'function',
        function: { name: body.tools[0].function.name, arguments: '{"path":"fixture.txt"}' } }] }),
      chunk({}, 'tool_calls'), { choices: [], usage: realUsage }, '[DONE]']);
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Read the file and this image.' },
      { type: 'input_image', image_url: `data:image/png;base64,${png}` }] }];
    const body = { ...base, stream, include, tools: [fn], input }, before = structuredClone(body);
    const firstResponse = await request(body); assert.equal(firstResponse.status, 200);
    const first = stream ? completion(await events(firstResponse)).response : await firstResponse.json();
    const call = first.output.find(item => item.type === 'function_call');
    assert.equal(call.name, fn.name); assert.equal(call.call_id, 'include_tool_call');
    assert.deepEqual(JSON.parse(call.arguments), { path: 'fixture.txt' });
    assert.deepEqual(first.tools, [fn]);
    assert.ok(first.output.every(item => ['reasoning', 'function_call'].includes(item.type)), 'Selectors must not fabricate hosted outputs.');
    assert.equal(client.calls[0].body.include, undefined);
    const firstUser = client.calls[0].body.messages.find(message => message.role === 'user');
    assert.deepEqual(firstUser.content.map(part => part.type), ['text', 'image_url']);
    assert.equal(firstUser.content[0].text, 'Read the file and this image.');
    assert.equal(firstUser.content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.deepEqual(body, before, 'Optional selector handling must not mutate the original input.');

    client.respond = () => answer('Tool result accepted.');
    const followResponse = await request({ ...body, input: [...input, ...first.output,
      { type: 'function_call_output', call_id: call.call_id, output: [{ type: 'input_text', text: 'EXACT_CLIENT_FILE_OUTPUT' },
        { type: 'input_image', image_url: `data:image/png;base64,${png}` }] }] });
    assert.equal(followResponse.status, 200);
    const follow = stream ? completion(await events(followResponse)).response : await followResponse.json();
    assert.equal(follow.status, 'completed');
    assert.equal(follow.output.findLast(item => item.type === 'message').content[0].text, 'Tool result accepted.');
    assert.equal(client.calls.length, 2); assert.equal(client.calls[1].body.include, undefined);
    const replay = client.calls[1].body.messages.find(message => message.role === 'assistant');
    assert.equal(replay.reasoning, 'PRIVATE_INCLUDE_TOOL_STATE');
    assert.deepEqual(replay.extra_fields, { checkpoint: 'include-turn' });
    const tool = client.calls[1].body.messages.find(message => message.role === 'tool');
    assert.equal(tool.tool_call_id, call.call_id); assert.equal(tool.content[0].text, 'EXACT_CLIENT_FILE_OUTPUT');
    assert.equal(tool.content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.equal(follow.usage.total_tokens, realUsage.total_tokens);
    const serialized = JSON.stringify(follow);
    assert.doesNotMatch(serialized, /PRIVATE_INCLUDE_TOOL_STATE|"sources"\s*:/);
    for (const part of follow.output.flatMap(item => item.content ?? [])) {
      if (part.logprobs !== undefined && part.logprobs !== null) assert.deepEqual(part.logprobs, [], 'The schema may contain an empty list, never fabricated token scores.');
    }
  });
}

test('invalid CodeBuddy include types and private unknown values fail before account metadata or transport', async () => {
  const { client, request } = fixture();
  for (const include of [17, {}, 'reasoning.encrypted_content', [null], [true], [{ token: 'PRIVATE_INCLUDE_VALUE' }],
    ['PRIVATE_INCLUDE_VALUE'], ['reasoning.encrypted_content', 'PRIVATE_INCLUDE_VALUE']]) {
    const response = await request({ ...base, include }); assert.equal(response.status, 400);
    const body = await response.json(); assert.equal(body.error.param, 'include');
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_INCLUDE_VALUE/);
  }
  assert.equal(client.reads, 0); assert.equal(client.calls.length, 0);
});

test('CodeBuddy rejects requested logprobs with a specific explanation before account metadata or transport', async () => {
  const { client, request } = fixture();
  const response = await request({ ...base, include: ['message.output_text.logprobs'] });
  assert.equal(response.status, 400); const body = await response.json();
  assert.equal(body.error.param, 'include'); assert.match(body.error.message, /logprobs/);
  assert.notEqual(body.error.message, '不支持请求的 include 字段。');
  assert.equal(client.reads, 0); assert.equal(client.calls.length, 0);
});

test('Responses generic models use dynamic account effort metadata and never invent default reasoning controls', async () => {
  const { client, request } = fixture();
  client.modelCatalog = async () => [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', supportsToolCall: true, supportsImages: false,
    supportsReasoning: true, reasoning: { supportedEfforts: ['low', 'max'], summary: 'auto' } }];
  const body = { model: 'CodeBuddy-gpt-6-astra', stream: false, input: 'Hello.', include: optionalIncludes };
  const response = await request(body), json = await response.json();
  assert.equal(response.status, 200); assert.equal(json.model, body.model); assert.deepEqual(json.reasoning, {});
  assert.equal(response.bridgeModel, 'gpt-6-astra'); assert.equal(client.calls[0].body.model, 'gpt-6-astra');
  assert.equal(Object.hasOwn(client.calls[0].body, 'include'), false);
  assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_effort'), false); assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_summary'), false);
  const explicit = await request({ ...body, reasoning: { effort: 'max', summary: 'none' } });
  assert.equal(explicit.status, 200); await explicit.json(); assert.equal(client.calls[1].body.reasoning_effort, 'max');
  assert.equal((await request({ ...body, reasoning: { effort: 'high' } })).status, 400);
  assert.equal((await request({ ...body, input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png}` }] }] })).status, 400);
  assert.equal(client.calls.length, 2);
});

test('a generic model can complete a Responses client tool turn using its actual model-bound opaque state', async () => {
  const { client, request } = fixture();
  client.modelCatalog = async () => [{ id: 'generic-tools', name: 'Tools', supportsToolCall: true }];
  client.respond = ({ body }) => source([chunk({ extra_fields: { continuation: 'PRIVATE_GENERIC_STATE' },
    tool_calls: [{ index: 0, id: 'generic-call', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"path":"fixture"}' } }] }), chunk({}, 'tool_calls'), '[DONE]']);
  const body = { model: 'CodeBuddy-generic-tools', stream: false, input: 'Read.', tools: [fn] };
  const first = await (await request(body)).json();
  assert.equal(first.model, body.model); const call = first.output.find(item => item.type === 'function_call');
  assert.equal(call.name, 'read_file'); assert.equal(JSON.stringify(first).includes('PRIVATE_GENERIC_STATE'), false);
  client.respond = () => source([chunk({ content: 'Done.' }), chunk({}, 'stop'), '[DONE]']);
  const second = await request({ ...body, input: [{ role: 'user', content: 'Read.' }, ...first.output,
    { type: 'function_call_output', call_id: call.call_id, output: 'actual client result' }] });
  assert.equal(second.status, 200); await second.json(); assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].body.model, 'generic-tools');
  assert.deepEqual(client.calls[1].body.messages.find(message => message.role === 'assistant').extra_fields, { continuation: 'PRIVATE_GENERIC_STATE' });
});

test('generic models without mapped effort controls ignore only known inherited Codex hints without echoing them', async () => {
  const { client, request } = fixture();
  client.modelCatalog = async () => [{ id: 'upstream-default-model', name: 'Default model', supportsToolCall: true }];
  const body = { model: 'CodeBuddy-upstream-default-model', input: 'Hello.', stream: false, reasoning: { effort: 'max' } };
  const response = await request(body), result = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(result.reasoning, {});
  assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_summary'), false);
  assert.equal(body.reasoning.effort, 'max');
  assert.equal((await request({ ...body, reasoning: { effort: 'unknown-effort' } })).status, 400);
  assert.equal(client.calls.length, 1);
});

for (const toolNameStyle of ['wire', 'original', 'qualified']) {
test(`namespace function and custom tool calls preserve history and raw input with ${toolNameStyle} names`, async () => {
  const { client, request } = fixture();
  const raw = '*** Begin Patch\n*** Add File: x.txt\n+ 中 文\t🙂\n*** End Patch\n';
  const tools = [{ type: 'namespace', name: 'functions', description: 'Local client tools.', tools: [fn, custom] },
    { ...fn, name: 'functions__read_file' }];
  client.respond = ({ body }) => source([chunk({ reasoning_content: 'SECRET_TOOL_THINKING' }), chunk({ content: '读取文件并修改。' }),
    chunk({ tool_calls: [
      { index: 0, id: 'call_read:1', type: 'function', function: { name: toolNameStyle === 'wire' ? body.tools[0].function.name
        : toolNameStyle === 'qualified' ? 'functions.read_file' : 'read_file', arguments: '{ "path" : "x.txt" }' } },
      { index: 1, id: 'call_patch:2', type: 'function', function: { name: toolNameStyle === 'wire' ? body.tools[1].function.name
        : toolNameStyle === 'qualified' ? 'functions.apply_patch' : 'apply_patch', arguments: JSON.stringify({ input: raw }) } },
    ], extra_fields: { tag: 'opaque-round' } }), chunk({}, 'tool_calls'), { choices: [], usage: realUsage }, '[DONE]'], 1);
  const response = await request({ ...base, tools }), wire = await events(response);
  const calls = output(wire).filter(item => item.type.endsWith('tool_call') || item.type === 'function_call');
  assert.deepEqual(calls.map(({ type, name, namespace, call_id }) => ({ type, name, namespace, call_id })), [
    { type: 'function_call', name: 'read_file', namespace: 'functions', call_id: 'call_read:1' },
    { type: 'custom_tool_call', name: 'apply_patch', namespace: 'functions', call_id: 'call_patch:2' },
  ]);
  assert.equal(calls[1].input, raw);
  assert.equal(output(wire).find(item => item.type === 'message').phase, 'commentary');
  assert.ok(wire.findIndex(event => event.type === 'response.output_item.done' && event.item.type === 'message') <
    wire.findIndex(event => event.type === 'response.output_item.done' && event.item.type === 'function_call'));
  assert.equal(wire.find(event => event.type === 'response.custom_tool_call_input.delta').delta, raw);
  assert.equal(new Set(client.calls[0].body.tools.map(tool => tool.function.name)).size, 3);
  assert.match(client.calls[0].body.tools[1].function.description, /lark grammar/);
  assert.match(client.calls[0].body.tools[1].function.description, /Local client tools/);
  client.respond = () => answer('已执行。');
  const follow = await request({ ...base, tools: [...tools].reverse(), stream: false, input: [...base.input, ...output(wire),
    { type: 'function_call_output', name: 'read_file', call_id: calls[0].call_id, output: [{ type: 'input_text', text: 'file contents' }, { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'high' }] },
    { type: 'custom_tool_call_output', call_id: calls[1].call_id, output: 'patch complete' },
  ] });
  assert.equal(follow.status, 200); await follow.json();
  const sent = client.calls[1].body.messages;
  const previous = sent.find(message => message.role === 'assistant');
  assert.equal(previous.reasoning, 'SECRET_TOOL_THINKING');
  assert.deepEqual(previous.extra_fields, { tag: 'opaque-round' });
  assert.equal(JSON.parse(previous.tool_calls[1].function.arguments).input, raw);
  assert.equal(previous.tool_calls[0].id, 'call_read:1');
  assert.deepEqual(previous.tool_calls.map(call => call.function.name), client.calls[0].body.tools.slice(0, 2).map(tool => tool.function.name),
    'History always uses the original stable wire aliases, including after the current declarations are reordered.');
  assert.equal(sent.filter(message => message.role === 'tool')[0].content[1].type, 'image_url');
});
}

for (const stream of [true, false]) {
test(`original tool names preserve the discovery, execution and continuation loop over ${stream ? 'SSE' : 'JSON'}`, async () => {
  const { client, request } = fixture();
  const search = { type: 'tool_search', execution: 'client', description: 'Discover client tools.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const loaded = { type: 'namespace', name: 'functions', description: 'Client file tools.', tools: [{ ...fn, defer_loading: true }] };
  const tools = [search, loaded], wireNames = new Map(); let round = 0;
  client.respond = ({ body }) => {
    const current = round++;
    if (current === 0) {
      assert.equal(body.tools.length, 1, 'Deferred tools are not executable until discovery returns their schemas.');
      wireNames.set('search', body.tools[0].function.name);
      return source([chunk({ reasoning_content: 'PRIVATE_DISCOVERY_REASONING' }), chunk({ tool_calls: [
        { index: 0, id: 'discover:1', type: 'function', function: { name: 'tool_search', arguments: '{"query":"file"}' } },
      ], extra_fields: { checkpoint: 'discovery' } }), chunk({}, 'tool_calls'), '[DONE]']);
    }
    if (current === 1) {
      assert.equal(body.tools.length, 2);
      assert.equal(body.messages.find(message => message.role === 'assistant').tool_calls[0].function.name, wireNames.get('search'));
      const file = body.tools.find(tool => /Tool read_file:/.test(tool.function.description));
      assert.ok(file); wireNames.set('file', file.function.name);
      assert.match(body.messages.find(message => message.role === 'tool').content, /Available tools:/);
      return source([chunk({ reasoning_content: 'PRIVATE_EXECUTION_REASONING' }), chunk({ tool_calls: [
        { index: 0, id: 'read:2', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.txt"}' } },
      ], extra_fields: { checkpoint: 'execution' } }), chunk({}, 'tool_calls'), '[DONE]']);
    }
    assert.equal(current, 2, 'One upstream response per phase; no implicit inference replay.');
    const history = body.messages.filter(message => message.role === 'assistant');
    assert.deepEqual(history.flatMap(message => message.tool_calls.map(call => call.function.name)), [wireNames.get('search'), wireNames.get('file')]);
    assert.deepEqual(history.map(message => message.extra_fields), [{ checkpoint: 'discovery' }, { checkpoint: 'execution' }]);
    assert.deepEqual(body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['discover:1', 'read:2']);
    assert.equal(body.messages.at(-1).content, 'Fixture file contents.');
    return answer('OFFLINE_DISCOVERY_EXECUTION_DONE');
  };
  const take = async input => {
    const response = await request({ ...base, stream, tools, input }); assert.equal(response.status, 200);
    const result = stream ? completion(await events(response)).response : await response.json();
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    return result.output;
  };
  const first = await take(base.input), searchCall = first.find(item => item.type === 'tool_search_call');
  assert.equal(searchCall.call_id, 'discover:1'); assert.deepEqual(searchCall.arguments, { query: 'file' });
  const discovered = [...base.input, ...first, { type: 'tool_search_output', call_id: searchCall.call_id, tools: [loaded] }];
  const second = await take(discovered), fileCall = second.find(item => item.type === 'function_call');
  assert.deepEqual({ name: fileCall.name, namespace: fileCall.namespace, callId: fileCall.call_id, arguments: JSON.parse(fileCall.arguments) },
    { name: 'read_file', namespace: 'functions', callId: 'read:2', arguments: { path: 'x.txt' } });
  const third = await take([...discovered, ...second, { type: 'function_call_output', call_id: fileCall.call_id, output: 'Fixture file contents.' }]);
  assert.equal(third.find(item => item.type === 'message').content[0].text, 'OFFLINE_DISCOVERY_EXECUTION_DONE');
  assert.equal(client.calls.length, 3);
});
}

for (const [label, tools, input, returned] of [
  ['ambiguous namespaces', [
    { type: 'namespace', name: 'one', tools: [fn] }, { type: 'namespace', name: 'two', tools: [fn] },
  ], base.input, 'read_file'],
  ['ambiguous tool types', [fn, { ...custom, name: 'read_file' }], base.input, 'read_file'],
  ['unloaded deferred tool', [{ ...fn, defer_loading: true }], base.input, 'read_file'],
  ['unloaded namesake in another namespace', [
    { type: 'namespace', name: 'old', tools: [{ ...fn, defer_loading: true }] },
    { type: 'namespace', name: 'current', tools: [fn] },
  ], base.input, 'read_file'],
  ['history-only namesake in another namespace', [{ type: 'namespace', name: 'current', tools: [fn] }], [...base.input,
    { type: 'function_call', name: 'read_file', namespace: 'old', call_id: 'old_call', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old_call', output: 'Earlier tool output.' },
  ], 'read_file'],
  ['history-only tool', [fn], [...base.input,
    { type: 'function_call', name: 'old_tool', namespace: 'functions', call_id: 'old_call', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old_call', output: 'Earlier tool output.' },
  ], 'old_tool'],
]) test(`name compatibility rejects ${label} without committing a client tool call`, async () => {
  const { client, request } = fixture();
  client.respond = () => source([chunk({ tool_calls: [
    { index: 0, id: 'must_not_execute', type: 'function', function: { name: returned, arguments: '{}' } },
  ] }), chunk({}, 'tool_calls'), '[DONE]']);
  const wire = await events(await request({ ...base, tools, input }));
  assert.equal(completion(wire).type, 'response.failed', 'An undeclared or ambiguous tool reference must never become an executable call.');
  assert.equal(completion(wire).response.error.sourceDiagnostics.check, 'tool_not_declared');
  assert.deepEqual(completion(wire).response.output, []);
  assert.equal(wire.some(event => event.type === 'response.output_item.done'), false);
  assert.equal(client.calls.length, 1);
});

test('a qualified current tool stays callable when an unloaded namesake makes its bare name ambiguous', async () => {
  const { client, request } = fixture();
  const tools = [{ type: 'namespace', name: 'old', tools: [{ ...fn, defer_loading: true }] },
    { type: 'namespace', name: 'current', tools: [fn] }];
  client.respond = () => source([chunk({ tool_calls: [
    { index: 0, id: 'current_scope', type: 'function', function: { name: 'current.read_file', arguments: '{"path":"x.txt"}' } },
  ] }), chunk({}, 'tool_calls'), '[DONE]']);
  const wire = await events(await request({ ...base, tools }));
  assert.equal(completion(wire).type, 'response.completed');
  const call = output(wire).find(item => item.type === 'function_call');
  assert.deepEqual({ namespace: call.namespace, name: call.name, callId: call.call_id },
    { namespace: 'current', name: 'read_file', callId: 'current_scope' });
  assert.equal(client.calls.length, 1);
});

test('client tool search loads function schemas and returns executable client search calls', async () => {
  const { client, request } = fixture();
  const search = { type: 'tool_search', execution: 'client', description: 'Discover tools.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  client.respond = ({ body }) => source([chunk({ tool_calls: [{ index: 0, id: 'search_one', type: 'function',
    function: { name: body.tools[0].function.name, arguments: '{"query":"file"}' } }] }), chunk({}, 'tool_calls'), { choices: [], usage: realUsage }, '[DONE]']);
  const first = await (await request({ ...base, stream: false, tools: [search] })).json();
  assert.equal(first.output[0].type, 'tool_search_call');
  assert.equal(first.output[0].execution, 'client');
  assert.deepEqual(first.output[0].arguments, { query: 'file' });
  client.respond = () => answer();
  const second = await request({ ...base, stream: false, tools: [search], input: [...base.input, ...first.output,
    { type: 'tool_search_output', call_id: 'search_one', tools: [{ type: 'namespace', name: 'functions', description: 'Files', tools: [{ ...fn, defer_loading: true }] }] }] });
  assert.equal(second.status, 200); await second.json();
  assert.equal(client.calls[1].body.tools.length, 2);
  assert.match(client.calls[1].body.messages.at(-1).content, /read_file/);
});

test('deferred schemas stay unloaded until an explicit client discovery result', async () => {
  const { client, request } = fixture();
  const tools = Array.from({ length: 150 }, (_, index) => ({ ...fn, name: `deferred_${index}`, defer_loading: true }));
  const response = await request({ ...base, tools, stream: false });
  assert.equal(response.status, 200); await response.json();
  assert.equal(client.calls[0].body.tools, undefined);
});

test('unavailable hosted web declaration is explicit, while forced or historical hosted operations fail', async () => {
  const { client, request } = fixture();
  const okay = await request({ ...base, stream: false, tools: [fn, { type: 'web_search', external_web_access: false }], tool_choice: 'auto' });
  assert.equal(okay.status, 200);
  assert.equal((await okay.json()).tools.length, 1);
  assert.equal(client.calls[0].body.tools.length, 1);
  assert.ok(client.calls[0].body.messages.some(message => message.role === 'system' && message.content.includes('web search is unavailable')));
  for (const variant of [
    { tools: [{ type: 'web_search' }], tool_choice: 'required' },
    { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } },
    { tools: [{ type: 'computer_use_preview' }] },
    { input: [...base.input, { type: 'web_search_call', id: 'ws_1', action: { query: 'PRIVATE_QUERY' } }] },
  ]) {
    const response = await request({ ...base, ...variant }); assert.equal(response.status, 400);
    assert.equal((await response.text()).includes('PRIVATE_QUERY'), false);
  }
  assert.equal(client.calls.length, 1);
});

test('OpenAI reasoning, damaged bridge envelopes, and account/model mismatch never reach model inference', async () => {
  const { client, request } = fixture();
  for (const encrypted_content of ['gAAAA-OPENAI-PRIVATE-CIPHERTEXT', CODEBUDDY_RESPONSES_STATE_PREFIX + 'badbase64']) {
    const response = await request({ ...base, input: [...base.input, { type: 'reasoning', id: 'rs_old', summary: [], encrypted_content }, { role: 'user', content: '继续' }] });
    assert.equal(response.status, 400); assert.equal((await response.text()).includes('PRIVATE-CIPHERTEXT'), false);
  }
  assert.equal(client.calls.length, 0); assert.equal(client.reads, 0);
  const first = await (await request({ ...base, stream: false })).json();
  client.identity = 'employee-two';
  const mismatched = await request({ ...base, stream: false, input: [...base.input, ...first.output, { role: 'user', content: '继续' }] });
  assert.equal(mismatched.status, 403); assert.equal(client.calls.length, 1);
});

test('rejects unsupported parameters, compact, media, and unfinished/mismatched tool history before catalog lookup', async () => {
  const { client, provider, request } = fixture();
  const variants = [
    { previous_response_id: 'resp_private' }, { context_management: [] }, { store: true }, { background: true },
    { reasoning: { effort: 'max' } }, { reasoning: { effort: 'none' } }, { reasoning: { summary: 'detailed' } },
    { logprobs: true }, { text: { format: { type: 'json_schema', schema: {} } } }, { max_output_tokens: 0 },
    { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'private' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_audio', data: 'private' }] }] },
    { input: [...base.input, { type: 'function_call_output', call_id: 'missing', output: 'x' }] },
    { input: [...base.input, { type: 'function_call', name: fn.name, call_id: 'one', arguments: '{}' }] },
  ];
  for (const variant of variants) {
    const response = await request({ ...base, ...variant });
    assert.equal(response.status, 400, JSON.stringify(variant)); await response.text();
  }
  assert.equal(client.reads, 0); assert.equal(client.calls.length, 0);
  const compact = await provider.request({ path: '/responses/compact', body: Buffer.from('{}') });
  assert.equal(compact.status, 501);
  const query = await provider.request({ path: '/responses?unknown=value', body: Buffer.from(JSON.stringify(base)) });
  assert.equal(query.status, 400); assert.match((await query.json()).error.message, /URL/);
});

test('late developer/system updates retain priority and position, including between parallel tool results', async () => {
  const { client, request } = fixture();
  const response = await request({ ...base, stream: false, tools: [fn], input: [
    ...base.input,
    { role: 'assistant', phase: 'partial_answer', content: [{ type: 'output_text', text: 'Reading.' }] },
    { type: 'function_call', name: fn.name, call_id: 'one', arguments: '{}', encrypted_function_args: [] },
    { type: 'function_call', name: fn.name, call_id: 'two', arguments: '{}' },
    { type: 'function_call_output', call_id: 'one', output: 'FIRST_RESULT' },
    { role: 'developer', content: 'LATE_DEVELOPER_UPDATE' },
    { type: 'function_call_output', call_id: 'two', output: 'SECOND_RESULT' },
    { role: 'system', content: 'FINAL_SYSTEM_UPDATE' },
  ] });
  assert.equal(response.status, 200); await response.json();
  const messages = client.calls[0].body.messages;
  const guide = messages.find(message => message.role === 'system' && message.content.includes('Priority updates'));
  assert.ok(guide); assert.equal(guide.content.includes('LATE_DEVELOPER_UPDATE'), false);
  const resultOne = messages.find(message => message.tool_call_id === 'one');
  const resultTwo = messages.find(message => message.tool_call_id === 'two');
  assert.equal(resultOne.content, 'FIRST_RESULT');
  assert.ok(resultTwo.content.indexOf('LATE_DEVELOPER_UPDATE') < resultTwo.content.indexOf('SECOND_RESULT'));
  assert.match(resultTwo.content, /role=developer/);
  assert.match(messages.at(-1).content, /role=system[\s\S]*FINAL_SYSTEM_UPDATE/);
});

test('unknown cache/reasoning counts remain unknown; total truth uses bridgeUsage, not Anthropic placeholders', async () => {
  const { client, request } = fixture();
  client.respond = () => source([chunk({ content: 'ok' }), chunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }, '[DONE]']);
  const response = await request({ ...base, stream: false }), json = await response.json();
  assert.deepEqual(json.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
  assert.equal((await response.bridgeUsage).input_tokens_details.cached_tokens, null);
  client.respond = () => source([chunk({ content: 'ok' }), chunk({}, 'stop'), '[DONE]']);
  const missing = await request({ ...base, stream: false });
  assert.equal((await missing.json()).usage, null); assert.equal(await missing.bridgeUsage, null);
});

test('length limit yields response.incomplete with truthful usage', async () => {
  const { client, request } = fixture();
  client.respond = () => source([chunk({ content: 'partial' }), chunk({}, 'length'), { choices: [], usage: realUsage }, '[DONE]']);
  const response = await request(), wire = await events(response);
  assert.equal(completion(wire).type, 'response.incomplete');
  assert.deepEqual(completion(wire).response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal((await response.bridgeUsage).total_tokens, 120);
});

function mockProvider(bodyFactory, usage = null) {
  return new CodeBuddyResponsesProvider({ provider: { status() { return { ready: true }; }, async request(options) {
    const response = await bodyFactory(options); response.bridgeUsage = Promise.resolve(usage); response.bridgeModel = actualModel; return response;
  } } });
}
const messagesFrame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const begin = { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', content: [] } };
const startText = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const stopText = { type: 'content_block_stop', index: 0 };
const stop = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
const ended = { type: 'message_stop' };
const rawResponse = value => new Response(value, { headers: { 'content-type': 'text/event-stream' } });

test('malformed, truncated, mismatched, trailing, and invalid UTF-8 SSE never complete successfully', async () => {
  const cases = [
    messagesFrame(begin) + 'data: {BROKEN}\n\n',
    messagesFrame(begin) + 'data: {"type":"message_stop"}',
    messagesFrame(begin) + messagesFrame(startText) + messagesFrame(stop),
    messagesFrame(begin) + messagesFrame(startText) + messagesFrame(stopText) + messagesFrame(stop) + messagesFrame(ended) + messagesFrame(ended),
    'event: message_stop\ndata: ' + JSON.stringify(begin) + '\n\n',
    Buffer.from([0xff, 0xfe]),
  ];
  for (const value of cases) {
    const provider = mockProvider(() => rawResponse(value));
    const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(base)) });
    const wire = await events(response);
    assert.equal(completion(wire).type, 'response.failed');
    assert.equal(wire.some(event => event.type === 'response.completed'), false);
  }
});

test('underlying Messages JSON is also converted, including initial text content and usage', async () => {
  const provider = mockProvider(() => Response.json({ id: 'msg_native', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'JSON🙂' }], stop_reason: 'end_turn' }), { input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify({ ...base, stream: false })) });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.output[0].content[0].text, 'JSON🙂');
  assert.equal(json.usage.total_tokens, 7);
});

test('downstream backpressure avoids eager reads; cancellation aborts provider and releases its stream', async () => {
  let pulls = 0, cancelled = false, upstreamSignal;
  const provider = mockProvider(({ signal }) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ pull(controller) {
      pulls++; controller.enqueue(Buffer.from(messagesFrame(begin)));
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(base)) });
  assert.equal(pulls, 0);
  const reader = response.body.getReader();
  const first = await reader.read(); assert.equal(first.done, false); assert.equal(pulls, 1);
  await reader.cancel();
  assert.equal(upstreamSignal.aborted, true); assert.equal(cancelled, true);
  assert.equal(pulls, 1);
});

test('real provider cancellation settles usage without completing a response', { timeout: 3000 }, async () => {
  const { client, request } = fixture(); let cancelled = false, sent = false;
  client.respond = () => new Response(new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(Buffer.from(frame({ ...chunk({ role: 'assistant', content: 'first' }), usage: { prompt_tokens: 9 } }))); }
    else return new Promise(() => {});
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await request(), reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(client.calls[0].signal.aborted, true); assert.equal(cancelled, true);
  const usage = await response.bridgeUsage; assert.equal(usage.input_tokens, 9); assert.equal(usage.output_tokens, null);
});

test('AbortSignal interrupts a pending read and emits failure; already aborted never calls provider', { timeout: 3000 }, async () => {
  let cancelled = false, calls = 0;
  const abort = new AbortController();
  const provider = mockProvider(() => { calls++; return new Response(new ReadableStream({ pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }); });
  const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(base)), signal: abort.signal });
  const reading = events(response); abort.abort();
  const wire = await reading;
  assert.equal(completion(wire).type, 'response.failed'); assert.equal(cancelled, true);
  const before = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(base)), signal: abort.signal });
  assert.equal(before.status, 499); assert.equal(calls, 1);
});

test('cancellation before first read still releases the acquired provider reader', async () => {
  let cancelled = false, stream;
  const provider = mockProvider(() => {
    stream = new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify(base)) });
  await response.body.cancel();
  await Promise.resolve();
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
