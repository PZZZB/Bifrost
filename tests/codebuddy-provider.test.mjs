import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState, CODEBUDDY_STATE_PREFIX } from '../src/codebuddy-thinking-state.mjs';
const catalogProvenance = ({ models, ...metadata }) => metadata;

const actualId = 'employee-opus-route-55';
const catalog = [{ id: actualId, name: 'Claude-5.5-Opus', supportsToolCall: true,
  credits: '0.5x', promotions: [{ priority: 1, discount: { factor: 0.25, discountedCredits: '0.25x' },
    badge: { label: 'Preview', color: '#ffffff' }, secret: 'must-not-be-disclosed',
    hover: { textZh: '公开活动', action: { labelZh: '查看', token: 'must-not-be-disclosed' } } }],
  apiKey: 'must-not-be-disclosed' }];
const tool = { name: 'read_file', description: 'Read using the client permission check.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const secondTool = { name: 'list_files', input_schema: { type: 'object', properties: {} } };
const input = { model: CODEBUDDY_MODEL.id, max_tokens: 128, stream: true,
  messages: [{ role: 'user', content: '检查文件。' }] };

const chunk = (delta = {}, finish_reason = null) => ({ id: 'chatcmpl_mock', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason }] });
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 },
  completion_tokens_details: { reasoning_tokens: 7 } };
const frame = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
function upstream(data, { split = false } = {}) {
  const bytes = Buffer.from(data.map(frame).join(''));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (let at = 0; at < bytes.length; at += 3) controller.enqueue(bytes.subarray(at, at + 3));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const answer = (text = 'Done.', { finish = 'stop', withUsage = true, split = false } = {}) => upstream([
  chunk({ role: 'assistant', content: text }), chunk({}, finish),
  ...(withUsage ? [{ choices: [], usage }] : []), '[DONE]',
], { split });

class Client {
  reads = 0;
  calls = [];
  authenticated = true;
  identity = 'employee-one';
  models = structuredClone(catalog);
  respond = () => answer();
  status() { return { authenticated: this.authenticated, identity: { uid: this.identity, username: 'employee.user' } }; }
  async modelCatalog() { this.reads++; if (this.catalogError) throw this.catalogError; return structuredClone(this.models); }
  async chatCompletions(options) { this.calls.push(options); return this.respond(options); }
}
function fixture(options = {}) {
  const client = new Client();
  const provider = new CodeBuddyProvider({ client, ...options });
  const request = (body = input, signal) => provider.request({ path: '/v1/messages', body: structuredClone(body),
    headers: new Headers({ authorization: 'Bearer client-key-must-not-be-forwarded' }), signal });
  return { client, provider, request };
}
async function events(response) {
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(event => JSON.parse(event.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
}
function content(events) {
  const result = [];
  for (const event of events) {
    if (event.type === 'content_block_start') result[event.index] = structuredClone(event.content_block);
    if (event.delta?.type === 'text_delta') result[event.index].text += event.delta.text;
    if (event.delta?.type === 'thinking_delta') result[event.index].thinking += event.delta.thinking;
    if (event.delta?.type === 'signature_delta') result[event.index].signature += event.delta.signature;
    if (event.delta?.type === 'input_json_delta') result[event.index].input = JSON.parse(event.delta.partial_json);
  }
  return result;
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const embeddedImage = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
const chatImage = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
const summaries = { type: 'adaptive', display: 'summarized' };

test('mixed images and extracted documents preserve payload and order through the complete adapter', async () => {
  const { client, request } = fixture();
  const body = { ...input, stream: false, messages: [{ role: 'user', content: [
    { type: 'text', text: 'Before\n' }, { ...embeddedImage(), cache_control: { type: 'ephemeral' } },
    { type: 'document', title: '附件', context: '背景', cache_control: { type: 'ephemeral', ttl: '1h' },
      source: { type: 'content', content: [
        { type: 'text', text: '正文一\n', cache_control: { type: 'ephemeral' } },
        { type: 'image', source: { type: 'url', url: 'https://images.example.com/chart.png' } },
        { type: 'text', text: '\n正文二' },
      ] } },
    { type: 'text', text: '\nAfter' },
  ] }] };
  const before = structuredClone(body);
  const response = await request(body);
  assert.equal(response.status, 200); await response.json();
  assert.deepEqual(body, before);
  assert.equal(response.bridgeCacheControl.ignoredHints, 3);
  assert.deepEqual(client.calls[0].body.messages, [{ role: 'user', content: [
    { type: 'text', text: 'Before\n' }, chatImage,
    { type: 'text', text: '[Document title]\n附件\n' }, { type: 'text', text: '[Document context]\n背景\n' },
    { type: 'text', text: '[Document content]\n' },
    { type: 'text', text: '正文一\n' }, { type: 'image_url', image_url: { url: 'https://images.example.com/chart.png' } },
    { type: 'text', text: '\n正文二' }, { type: 'text', text: '\nAfter' },
  ] }]);
});

test('plain-text document metadata remains separated after content parts collapse to a string', async () => {
  const { client, request } = fixture();
  const response = await request({ ...input, stream: false, messages: [{ role: 'user', content: [
    { type: 'document', title: 'a.txt', context: '背景', source: { type: 'text', media_type: 'text/plain', data: '正文\n第二行' } },
  ] }] });
  await response.text();
  assert.equal(client.calls[0].body.messages[0].content, '[Document title]\na.txt\n[Document context]\n背景\n[Document content]\n正文\n第二行');
});

test('visible summaries and image tool results round-trip across two mock turns without a vendor signature', async () => {
  const { client, request } = fixture();
  const body = { ...input, thinking: summaries, output_config: { effort: 'xhigh' }, tools: [tool] };
  client.respond = () => upstream([
    chunk({ role: 'assistant', reasoning_content: '先看图。🙂' }),
    chunk({ reasoning_content: '\n需要工具。' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_image', type: 'function', function: { name: 'read_file', arguments: '{"path":"image.png"}' } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]',
  ], { split: true });
  const response = await request(body), wire = await events(response), blocks = content(wire);
  assert.deepEqual(blocks, [{ type: 'thinking', thinking: '先看图。🙂\n需要工具。', signature: '' },
    { type: 'tool_use', id: 'call_image', name: 'read_file', input: { path: 'image.png' } }]);
  assert.equal(wire.some(event => event.delta?.type === 'signature_delta'), false);
  assert.ok(wire.findIndex(event => event.type === 'content_block_stop' && event.index === 0) <
    wire.findIndex(event => event.type === 'content_block_start' && event.index === 1));
  assert.equal(wire.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');
  assert.equal(client.calls[0].body.reasoning_effort, 'xhigh');
  assert.equal(client.calls[0].body.reasoning_summary, 'auto');
  client.respond = () => upstream([chunk({ reasoning_content: '图已读取。', content: '已完成。' }),
    chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
  const next = { ...body, stream: false, messages: [...body.messages,
    { role: 'assistant', content: blocks }, { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_image', content: [
        { type: 'text', text: '截图：' }, embeddedImage(),
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '\n提取文字。' } },
      ] }, { type: 'text', text: '说明图片。' },
    ] }] };
  const second = await request(next), message = await second.json();
  assert.deepEqual(client.calls[1].body.messages.slice(-3), [
    { role: 'assistant', content: null, reasoning: blocks[0].thinking, reasoning_content: blocks[0].thinking,
      tool_calls: [{ id: 'call_image', type: 'function', function: { name: 'read_file', arguments: '{"path":"image.png"}' } }] },
    { role: 'tool', tool_call_id: 'call_image', content: [
      { type: 'text', text: '截图：' }, chatImage, { type: 'text', text: '\n提取文字。' },
    ] }, { role: 'user', content: '说明图片。' },
  ]);
  assert.deepEqual(message.content, [{ type: 'thinking', thinking: '图已读取。', signature: '' }, { type: 'text', text: '已完成。' }]);
  assert.equal((await second.bridgeUsage).output_tokens_details.reasoning_tokens, 7);
});

test('interleaved thought and text chunks produce sequential, closed Anthropic blocks', async () => {
  const { client, request } = fixture();
  client.respond = () => upstream([
    chunk({ reasoning_content: '分析一' }), chunk({ content: '回答一' }),
    chunk({ reasoning_content: '分析二', content: '回答二' }), chunk({}, 'stop'), '[DONE]',
  ], { split: true });
  const wire = await events(await request({ ...input, thinking: summaries }));
  assert.deepEqual(content(wire), [
    { type: 'thinking', thinking: '分析一', signature: '' }, { type: 'text', text: '回答一' },
    { type: 'thinking', thinking: '分析二', signature: '' }, { type: 'text', text: '回答二' },
  ]);
  let active = null;
  for (const event of wire) {
    if (event.type === 'content_block_start') { assert.equal(active, null); active = event.index; }
    if (event.type === 'content_block_delta') assert.equal(event.index, active);
    if (event.type === 'content_block_stop') { assert.equal(event.index, active); active = null; }
  }
  assert.equal(active, null); assert.equal(wire.at(-1).type, 'message_stop');
});

test('omitted summaries remain hidden while reported reasoning tokens remain in usage', async () => {
  for (const thinking of [undefined, { type: 'adaptive' }, { type: 'adaptive', display: 'omitted' }]) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ reasoning_content: 'Internal summary', content: 'Visible answer' }),
      chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
    const response = await request({ ...input, thinking }), wire = await events(response);
    const blocks = content(wire);
    assert.equal(blocks[0].type, 'thinking'); assert.equal(blocks[0].thinking, '');
    assert.equal(blocks[0].signature.startsWith(CODEBUDDY_STATE_PREFIX), true);
    assert.deepEqual(blocks[1], { type: 'text', text: 'Visible answer' });
    assert.equal(JSON.stringify(wire).includes('Internal summary'), false);
    assert.equal((await response.bridgeUsage).output_tokens_details.reasoning_tokens, 7);
  }
});

test('hidden thinking survives a tool round and provider restart using a scoped encrypted bridge marker', async () => {
  const key = Buffer.alloc(32, 0x71), codec = new CodeBuddyThinkingState({ key });
  const { client, request } = fixture({ loadThinkingState: async () => codec });
  const body = { ...input, tools: [tool] };
  client.respond = () => upstream([chunk({ reasoning_content: 'PRIVATE_HIDDEN_SUMMARY' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_hidden', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]']);
  const wire = await events(await request(body)), blocks = content(wire);
  assert.equal(JSON.stringify(wire).includes('PRIVATE_HIDDEN_SUMMARY'), false);
  assert.equal(blocks[0].thinking, ''); assert.equal(blocks[0].signature.startsWith(CODEBUDDY_STATE_PREFIX), true);
  assert.equal(codec.open(blocks[0]).reasoning, 'PRIVATE_HIDDEN_SUMMARY');
  const next = { ...body, stream: false, messages: [...body.messages, { role: 'assistant', content: blocks },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_hidden', content: '工具完成。' }] }] };
  const restarted = fixture({ loadThinkingState: async () => new CodeBuddyThinkingState({ key }) });
  assert.equal((await restarted.request(next)).status, 200);
  const history = restarted.client.calls[0].body.messages[1];
  assert.equal(history.reasoning, 'PRIVATE_HIDDEN_SUMMARY'); assert.equal(history.reasoning_content, history.reasoning);
  assert.equal(JSON.stringify(restarted.client.calls[0].body).includes(CODEBUDDY_STATE_PREFIX), false);
  for (const mode of ['wrong-key', 'wrong-identity', 'wrong-model']) {
    const other = fixture({ loadThinkingState: async () => new CodeBuddyThinkingState({ key: mode === 'wrong-key' ? Buffer.alloc(32, 0x72) : key }) });
    if (mode === 'wrong-identity') other.client.identity = 'another-employee';
    if (mode === 'wrong-model') other.client.models[0].id = 'another-opus-route';
    const denied = await other.request(next);
    assert.equal(denied.status, mode === 'wrong-key' ? 400 : 403);
    assert.equal((await denied.text()).includes('PRIVATE_'), false);
    assert.equal(other.client.calls.length, 0);
    if (mode === 'wrong-key') assert.equal(other.client.reads, 0);
  }
});

test('opaque extra_fields of every JSON type survive a restarted adapter without readable disclosure', async () => {
  const key = Buffer.alloc(32, 0x73), codec = new CodeBuddyThinkingState({ key });
  for (const value of [{}, [], false, 0, '', 1.5, 'PRIVATE_METADATA', { nonce: 'PRIVATE_NONCE', nested: [null, false, {}] }]) {
    for (const stream of [false, true]) {
      const { client, request } = fixture({ loadThinkingState: async () => codec });
      client.respond = () => upstream([chunk({ extra_fields: { previous: 'PRIVATE_OLD_STATE' } }, ''),
        chunk({ content: 'Answer' }, ''), chunk({ extra_fields: value }, ''), chunk({}, 'stop'),
        chunk({ extra_fields: null }, ''), '[DONE]']);
      const response = await request({ ...input, stream }); assert.equal(response.status, 200);
      let blocks, serialized;
      if (stream) {
        const wire = await events(response); assert.equal(wire.at(-1).type, 'message_stop');
        blocks = content(wire); serialized = JSON.stringify(wire);
      } else {
        const message = await response.json(); assert.equal(message.stop_reason, 'end_turn');
        blocks = message.content; serialized = JSON.stringify(message);
      }
      assert.equal(serialized.includes('PRIVATE_'), false);
      assert.deepEqual(blocks[0], { type: 'text', text: 'Answer' }); assert.equal(blocks.length, 2);
      assert.equal(blocks[1].thinking, '');
      assert.deepEqual(codec.open(blocks[1]), { reasoning: '', identity: 'employee-one', model: actualId, extra_fields: value });
      const restarted = fixture({ loadThinkingState: async () => new CodeBuddyThinkingState({ key }) });
      const next = { ...input, stream: false, messages: [...input.messages,
        { role: 'assistant', content: blocks }, { role: 'user', content: 'Continue.' }] };
      assert.equal((await restarted.request(next)).status, 200);
      const history = restarted.client.calls[0].body.messages[1];
      assert.deepEqual(history.extra_fields, value); assert.equal(Object.hasOwn(history, 'reasoning'), false);
      assert.equal(JSON.stringify(restarted.client.calls[0].body).includes(CODEBUDDY_STATE_PREFIX), false);
    }
  }
});

test('metadata preserves the last nonnull snapshot before and after tools without duplicating thinking', async () => {
  const key = Buffer.alloc(32, 0x74), codec = new CodeBuddyThinkingState({ key });
  for (const visible of [false, true]) for (const stream of [false, true]) {
    const summary = visible ? 'Visible summary' : 'PRIVATE_HIDDEN_SUMMARY';
    const final = { nonce: 'PRIVATE_TERMINAL_STATE', nested: [false, {}] };
    const { client, request } = fixture({ loadThinkingState: async () => codec });
    const body = { ...input, tools: [tool], stream, ...(visible ? { thinking: summaries } : {}) };
    client.respond = () => upstream([chunk({ extra_fields: { before: 'PRIVATE_OLD' } }, ''),
      chunk({ reasoning_content: summary.slice(0, 5), tool_calls: [] }, ''),
      chunk({ reasoning_content: summary.slice(5), tool_calls: [] }, ''),
      chunk({ content: 'Use client tool.', tool_calls: [], extra_fields: { during: 'PRIVATE_MIDDLE' } }, ''),
      chunk({ tool_calls: [{ index: 0, id: 'call_metadata', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, ''),
      chunk({ extra_fields: { afterTool: 'PRIVATE_OLD_TOOL_STATE' } }, 'tool_calls'),
      chunk({ extra_fields: final, role: 'assistant', content: '', reasoning_content: null, refusal: '', tool_calls: [] }, ''),
      chunk({ extra_fields: null, content: null, reasoning_content: '', refusal: null, tool_calls: [] }, null), '[DONE]']);
    const response = await request(body); assert.equal(response.status, 200);
    const blocks = stream ? content(await events(response)) : (await response.json()).content;
    const decoded = blocks.filter(block => block.type === 'thinking' && block.signature.startsWith(CODEBUDDY_STATE_PREFIX))
      .map(block => codec.open(block));
    assert.equal(decoded.filter(state => Object.hasOwn(state, 'extra_fields')).length, 1);
    assert.deepEqual(decoded.find(state => Object.hasOwn(state, 'extra_fields')).extra_fields, final);
    assert.deepEqual(blocks.filter(block => block.type !== 'thinking'), [{ type: 'text', text: 'Use client tool.' },
      { type: 'tool_use', id: 'call_metadata', name: 'read_file', input: {} }]);
    if (visible) assert.equal(blocks[0].thinking, summary);
    else assert.equal(decoded.filter(state => state.reasoning).map(state => state.reasoning).join(''), summary);
    assert.equal(JSON.stringify(blocks).includes('PRIVATE_'), false);
    client.respond = () => answer();
    const next = { ...body, stream: false, messages: [...body.messages, { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_metadata', content: 'Client result.' }] }] };
    assert.equal((await request(next)).status, 200);
    const history = client.calls[1].body.messages[1];
    assert.equal(history.reasoning, summary); assert.equal(history.reasoning_content, summary);
    assert.deepEqual(history.extra_fields, final);
  }
});

test('metadata markers restore each assistant independently and reject duplicate markers or wrong scopes', async () => {
  const key = Buffer.alloc(32, 0x75), codec = new CodeBuddyThinkingState({ key });
  const marker = value => ({ type: 'thinking', thinking: '', signature: codec.seal({ reasoning: '',
    identity: 'employee-one', model: actualId, extra_fields: value }) });
  const first = marker({ nonce: 'PRIVATE_FIRST' }), second = marker({ nonce: 'PRIVATE_SECOND' });
  const body = { ...input, stream: false, messages: [...input.messages,
    { role: 'assistant', content: [{ type: 'text', text: 'First' }, first] }, { role: 'user', content: 'Next.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Second' }, second] }, { role: 'user', content: 'Continue.' }] };
  const { client, request } = fixture({ loadThinkingState: async () => codec });
  assert.equal((await request(body)).status, 200);
  assert.deepEqual(client.calls[0].body.messages[1].extra_fields, { nonce: 'PRIVATE_FIRST' });
  assert.deepEqual(client.calls[0].body.messages[3].extra_fields, { nonce: 'PRIVATE_SECOND' });
  for (const duplicate of [first, second]) {
    const other = fixture({ loadThinkingState: async () => codec });
    const bad = structuredClone(body); bad.messages[1].content.push(duplicate);
    const response = await other.request(bad); assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /重复/); assert.equal(other.client.reads, 0);
  }
  for (const mode of ['wrong-key', 'wrong-identity', 'wrong-model']) {
    const other = fixture({ loadThinkingState: async () => new CodeBuddyThinkingState({ key: mode === 'wrong-key' ? Buffer.alloc(32, 0x76) : key }) });
    if (mode === 'wrong-identity') other.client.identity = 'another-employee';
    if (mode === 'wrong-model') other.client.models[0].id = 'another-opus-route';
    const denied = await other.request(body); assert.equal(denied.status, mode === 'wrong-key' ? 400 : 403);
    assert.equal((await denied.text()).includes('PRIVATE_'), false); assert.equal(other.client.calls.length, 0);
  }
});

test('metadata cannot bypass terminal content checks or replace a complete termination', async () => {
  const cases = [
    [chunk({ extra_fields: {} }, ''), '[DONE]'],
    [chunk({ content: 'Done.' }, ''), chunk({}, 'stop'), chunk({ extra_fields: {} }, '')],
    ...[{ content: 'Late text' }, { reasoning_content: 'PRIVATE_LATE_THOUGHT' },
      { refusal: 'PRIVATE_REFUSAL' }, { role: 'user' }, { tool_calls: [{ index: 0 }] },
      { metadata: null }, { PRIVATE_DYNAMIC_FIELD: '' }].map(delta => [chunk({ content: 'Done.' }, ''), chunk({}, 'stop'),
      chunk({ extra_fields: {}, ...delta }, ''), '[DONE]']),
    [chunk({ content: 'Done.' }, ''), chunk({}, 'stop'), chunk({ extra_fields: {} }, 'stop'), '[DONE]'],
  ];
  for (const chunks of cases) for (const stream of [false, true]) {
    const { client, request } = fixture(); client.respond = () => upstream(chunks);
    const response = await request({ ...input, stream });
    if (stream) {
      const wire = await events(response); assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false);
      assert.equal(JSON.stringify(wire.at(-1)).includes('PRIVATE_'), false);
    } else {
      assert.equal(response.status, 502); assert.equal((await response.text()).includes('PRIVATE_'), false);
    }
  }
  for (const stream of [false, true]) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ content: 'Done.', extra_fields: null }, ''), chunk({}, 'stop'), '[DONE]']);
    const response = await request({ ...input, stream }); assert.equal(response.status, 200);
    const blocks = stream ? content(await events(response)) : (await response.json()).content;
    assert.deepEqual(blocks, [{ type: 'text', text: 'Done.' }]);
  }
});

test('empty tool call placeholders preserve one continuous text block', async () => {
  const { client, request } = fixture();
  client.respond = () => upstream([chunk({ content: 'Con', tool_calls: [] }, ''), chunk({ content: 'tinuous', tool_calls: [] }, ''),
    chunk({ content: ' text.', tool_calls: [], reasoning_content: '' }, ''), chunk({}, 'stop'), '[DONE]']);
  const wire = await events(await request());
  assert.deepEqual(content(wire), [{ type: 'text', text: 'Continuous text.' }]);
  assert.equal(wire.filter(event => event.type === 'content_block_start').length, 1);
  assert.equal(wire.filter(event => event.type === 'content_block_stop').length, 1);
  assert.equal(wire.at(-1).type, 'message_stop');
});

test('invalid or nonfinite metadata fails safely rather than serializing to a different JSON value', async () => {
  let deep = { text: 'PRIVATE_DEEP_VALUE' };
  for (let level = 0; level < 260; level++) deep = { nested: deep };
  for (const event of [chunk({ extra_fields: deep }, ''),
    '{"choices":[{"index":0,"delta":{"extra_fields":{"PRIVATE_NUMBER":1e400}},"finish_reason":""}]}']) {
    for (const stream of [false, true]) {
      const { client, request } = fixture(); client.respond = () => upstream([event, chunk({}, 'stop'), '[DONE]']);
      const response = await request({ ...input, stream }); let error;
      if (stream) {
        const wire = await events(response); assert.equal(wire.at(-1).type, 'error');
        assert.equal(wire.some(event => event.type === 'message_stop'), false); error = wire.at(-1).error;
      } else { assert.equal(response.status, 502); error = (await response.json()).error; }
      assert.match(error.message, /extra_fields:object/); assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
    }
  }
});

test('output accounting uses UTF-8 and replaces metadata snapshots without accumulating obsolete values', async () => {
  const separateEvents = data => {
    let index = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (index === data.length) controller.close(); else controller.enqueue(Buffer.from(frame(data[index++])));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const { client, request } = fixture();
  const snapshot = 'x'.repeat(4 * 1024 * 1024);
  client.respond = () => separateEvents([...Array.from({ length: 9 }, () => chunk({ extra_fields: snapshot }, '')),
    chunk({ content: 'Done.' }, ''), chunk({}, 'stop'), '[DONE]']);
  const replaced = await request({ ...input, stream: false }); assert.equal(replaced.status, 200);
  const blocks = (await replaced.json()).content; assert.equal(blocks.length, 2);
  const unicode = '\u6c49'.repeat(2 * 1024 * 1024);
  client.respond = () => separateEvents([...Array.from({ length: 5 }, () => chunk({ content: unicode }, '')),
    chunk({ extra_fields: 'x'.repeat(3 * 1024 * 1024) }, ''), chunk({}, 'stop'), '[DONE]']);
  const oversized = await request({ ...input, stream: false }); assert.equal(oversized.status, 502);
  assert.equal((await oversized.json()).error.message, 'CodeBuddy extra_fields 接续状态超过大小限制。');
});

test('a buffered upstream chunk cannot emit pending content or finish after the caller aborts', async () => {
  for (const abortAfter of ['message_start', 'message_delta']) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ reasoning_content: 'Hidden first' }), chunk({ reasoning_content: 'Hidden second', content: 'Text' }),
      chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
    const abort = new AbortController(), response = await request(input, abort.signal), reader = response.body.getReader();
    const decoder = new TextDecoder(); let first = '';
    while (!first.includes(`event: ${abortAfter}\n`)) {
      const item = await reader.read(); assert.equal(item.done, false); first += decoder.decode(item.value, { stream: true });
    }
    abort.abort(); let after = '';
    for (;;) { const item = await reader.read(); if (item.done) break; after += decoder.decode(item.value, { stream: true }); }
    assert.match(after, /event: error/);
    assert.doesNotMatch(after, /content_block|message_stop/);
    assert.equal(client.calls[0].signal.aborted, true); assert.equal((await response.bridgeUsage).total_tokens, 120);
    reader.releaseLock();
  }
});

test('unsupported raw attachments, native thought state and excessive images fail before authentication metadata', async () => {
  const { client, request } = fixture();
  const user = block => ({ ...input, messages: [{ role: 'user', content: [block] }] });
  const history = block => ({ ...input, messages: [{ role: 'assistant', content: [block] }, ...input.messages] });
  const bad = [
    ...['video', 'audio', 'file', 'input_file', 'container_upload'].map(type => user({ type, source: { data: 'PRIVATE_PAYLOAD' } })),
    user({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'PRIVATE_PAYLOAD' } }),
    user({ type: 'document', source: { type: 'file', file_id: 'PRIVATE_FILE' } }),
    history({ type: 'thinking', thinking: 'PRIVATE_THOUGHT', signature: 'PRIVATE_SIGNATURE' }),
    history({ type: 'redacted_thinking', data: 'PRIVATE_ENCRYPTED' }),
    { ...input, messages: [{ role: 'user', content: Array.from({ length: 101 }, embeddedImage) }] },
  ];
  for (const body of bad) {
    const response = await request(body); assert.equal(response.status, 400);
    assert.equal((await response.text()).includes('PRIVATE_'), false);
  }
  assert.equal(client.reads, 0); assert.equal(client.calls.length, 0);
});

test('abort or malformed reasoning stops an in-progress thinking block without completing a turn', async () => {
  for (const mode of ['abort', 'malformed']) {
    const { client, request } = fixture(); let cancelled = false;
    client.respond = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(frame({ ...chunk({ reasoning_content: 'Partial summary' }), usage: { prompt_tokens: 9 } })));
      if (mode === 'malformed') controller.enqueue(Buffer.from(frame(chunk({ reasoning_content: { token: 'PRIVATE_REASONING' } }))));
    }, cancel() { cancelled = true; } }));
    const abort = new AbortController();
    const response = await request({ ...input, thinking: summaries }, abort.signal), reader = response.body.getReader();
    const decoder = new TextDecoder(); let wire = '';
    while (!wire.includes('thinking_delta')) wire += decoder.decode((await reader.read()).value, { stream: true });
    if (mode === 'abort') abort.abort();
    for (;;) { const item = await reader.read(); if (item.done) break; wire += decoder.decode(item.value, { stream: true }); }
    assert.equal(wire.includes('event: message_stop'), false); assert.equal(wire.includes('event: error'), true);
    assert.equal(wire.includes('PRIVATE_REASONING'), false); assert.equal(cancelled, true);
    assert.equal((await response.bridgeUsage).input_tokens, 9);
    reader.releaseLock();
  }
});

test('selects only a catalog-confirmed Opus 5.5 ID, caches metadata and exposes public billing without claiming a Token rate', async () => {
  let time = 1000;
  const { client, provider } = fixture({ now: () => time });
  const status = await provider.status();
  assert.equal(status.ready, true);
  assert.equal(status.transport, 'codebuddy-chat-completions');
  assert.equal(status.upstreamModel, actualId);
  assert.deepEqual(catalogProvenance(status.catalog), { source: 'remote', savedAt: null, liveVerified: true });
  assert.equal(status.username, 'employee.user');
  assert.equal(status.cacheControl.behavior, 'validated_hints_ignored');
  assert.deepEqual(status.billing, { verified: false, employeeTokenMultiplier: null, sourceCredits: '0.5x',
    sourcePromotion: [{ priority: 1, discount: { factor: 0.25, discountedCredits: '0.25x' },
      badge: { label: 'Preview', color: '#ffffff' }, hover: { textZh: '公开活动', action: { labelZh: '查看' } } }] });
  assert.equal(JSON.stringify(status).includes('must-not-be-disclosed'), false);
  assert.equal(client.calls.length, 0);
  await provider.status(); assert.equal(client.reads, 1);
  time += 31_000; await provider.status(); assert.equal(client.reads, 2);
  client.identity = 'employee-two'; await provider.status(); assert.equal(client.reads, 3);
});

test('explicit catalog refresh reveals newly added models immediately while ordinary reads retain their TTL', async () => {
  let time = 1000;
  const { client, provider } = fixture({ now: () => time });
  await provider.getModels();
  client.models.push({ id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', supportsToolCall: true });
  assert.equal((await provider.status()).catalog.models.some(model => model.id === 'CodeBuddy-kimi-k3.1-pro'), false);
  assert.equal((await provider.getModels({ force: 'true' })).length, 1);
  assert.equal(client.reads, 1);
  const refreshed = await provider.getModels({ force: true });
  assert.equal(refreshed.some(model => model.id === 'CodeBuddy-kimi-k3.1-pro'), true);
  assert.equal(client.reads, 2);
  assert.deepEqual((await provider.status()).catalog.models, refreshed);
  assert.deepEqual(await provider.getModels(), refreshed);
  time += 29999; await provider.status(); assert.equal(client.reads, 2);
  time++; await provider.status(); assert.equal(client.reads, 3);
  assert.equal(client.calls.length, 0);
});

function deferredCatalog() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const freshCatalog = () => ({ source: 'remote', liveVerified: true,
  models: [{ id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', supportsToolCall: true }] });

test('older concurrent catalog success or failure cannot replace or clear a forced refresh', async () => {
  for (const outcome of ['success', 'failure']) {
    const { client, provider } = fixture();
    const started = deferredCatalog(), oldCatalog = deferredCatalog();
    client.modelCatalog = async () => {
      client.reads++;
      if (client.reads === 1) { started.resolve(); return oldCatalog.promise; }
      return freshCatalog();
    };
    const older = provider.getModels(); await started.promise;
    const refreshed = await provider.getModels({ force: true });
    assert.equal(refreshed[0].id, 'CodeBuddy-kimi-k3.1-pro');
    if (outcome === 'success') {
      oldCatalog.resolve({ source: 'native-cache', savedAt: 1, models: catalog });
      await older;
    } else {
      const failure = new Error('Fixture old catalog failure');
      const rejected = assert.rejects(older, error => error === failure);
      oldCatalog.reject(failure); await rejected;
    }
    assert.deepEqual(await provider.getModels(), refreshed);
    const status = await provider.status();
    assert.equal(status.ready, true); assert.deepEqual(status.catalog.models, refreshed);
    assert.deepEqual(catalogProvenance(status.catalog), { source: 'remote', savedAt: null, liveVerified: true });
    assert.equal(client.reads, 2); assert.equal(client.calls.length, 0);
  }
});

test('an older call waiting for account status cannot overwrite a newer forced catalog', async () => {
  const { client, provider } = fixture();
  const oldStatus = deferredCatalog(); let statusReads = 0;
  client.status = () => ++statusReads === 1 ? oldStatus.promise : Client.prototype.status.call(client);
  client.modelCatalog = async () => ++client.reads === 1 ? freshCatalog() : { source: 'native-cache', savedAt: 1, models: catalog };
  const older = provider.getModels({ force: true });
  const refreshed = await provider.getModels({ force: true });
  oldStatus.resolve(Client.prototype.status.call(client)); await older;
  assert.deepEqual(await provider.getModels(), refreshed);
  assert.deepEqual(catalogProvenance((await provider.status()).catalog), { source: 'remote', savedAt: null, liveVerified: true });
  assert.equal(client.reads, 2); assert.equal(client.calls.length, 0);
});

test('ordinary cached status reads do not invalidate an in-flight forced refresh', async () => {
  const { client, provider } = fixture();
  const before = await provider.getModels();
  const started = deferredCatalog(), pending = deferredCatalog();
  client.modelCatalog = async () => { client.reads++; started.resolve(); return pending.promise; };
  const refresh = provider.getModels({ force: true }); await started.promise;
  assert.deepEqual((await provider.status()).catalog.models, before);
  pending.resolve(freshCatalog());
  const refreshed = await refresh;
  assert.deepEqual((await provider.status()).catalog.models, refreshed);
  assert.deepEqual(await provider.getModels(), refreshed);
  assert.equal(client.reads, 2); assert.equal(client.calls.length, 0);
});

test('aborted model discovery neither starts a catalog read nor caches a late cancelled response', async () => {
  const { client, provider } = fixture();
  const early = new AbortController(); early.abort();
  await assert.rejects(provider.getModels({ force: true, signal: early.signal }), error => error.status === 499);
  assert.equal(client.reads, 0);
  const started = deferredCatalog(), oldCatalog = deferredCatalog(), abort = new AbortController();
  client.modelCatalog = async ({ signal }) => {
    client.reads++;
    if (client.reads === 1) { assert.equal(signal, abort.signal); started.resolve(); return oldCatalog.promise; }
    return freshCatalog();
  };
  const older = provider.getModels({ force: true, signal: abort.signal }); await started.promise;
  const refreshed = await provider.getModels({ force: true });
  abort.abort();
  const rejected = assert.rejects(older, error => error.status === 499);
  oldCatalog.resolve(catalog); await rejected;
  assert.deepEqual(await provider.getModels(), refreshed);
  assert.equal(client.reads, 2); assert.equal(client.calls.length, 0);
});

test('logout invalidates in-flight model reads even when the old client ignores the auth change', async () => {
  const { client, provider } = fixture();
  const started = deferredCatalog(), oldCatalog = deferredCatalog();
  client.modelCatalog = async () => {
    client.reads++;
    if (client.reads === 1) { started.resolve(); return oldCatalog.promise; }
    return freshCatalog();
  };
  const older = provider.getModels(); await started.promise;
  client.authenticated = false;
  assert.equal((await provider.status()).authenticated, false);
  oldCatalog.resolve(catalog); await older;
  client.authenticated = true;
  assert.equal((await provider.getModels())[0].id, 'CodeBuddy-kimi-k3.1-pro');
  assert.equal(client.reads, 2); assert.equal(client.calls.length, 0);
});

test('native catalog metadata preserves its saved time without claiming live permission or a verified Token rate', async () => {
  const savedAt = Date.parse('2026-10-19T12:00:00.000Z');
  let time = savedAt + 1000;
  const { client, provider, request } = fixture({ now: () => time });
  client.models = { models: [{ id: 'claude-opus-5.5', name: 'Claude-Opus-5.5', credits: 'x2.17',
    supportsToolCall: true, apiKey: 'PRIVATE_MODEL_FIELD' }],
    source: 'native-cache', savedAt, liveVerified: true, token: 'PRIVATE_CATALOG_FIELD', userId: 'PRIVATE_ACCOUNT_FIELD' };
  const status = await provider.status();
  assert.equal(status.ready, true);
  assert.equal(status.modelAvailable, true);
  assert.equal(status.upstreamModel, 'claude-opus-5.5');
  assert.deepEqual(catalogProvenance(status.catalog), { source: 'native-cache', savedAt, liveVerified: false });
  assert.deepEqual(status.billing, { verified: false, employeeTokenMultiplier: null, sourceCredits: 'x2.17', sourcePromotion: null });
  assert.equal(JSON.stringify(status).includes('PRIVATE_'), false);
  assert.equal(client.calls.length, 0);
  status.catalog.liveVerified = true;
  status.catalog.savedAt = 0;
  assert.deepEqual(catalogProvenance((await provider.status()).catalog), { source: 'native-cache', savedAt, liveVerified: false });
  time += 31_000;
  assert.deepEqual(catalogProvenance((await provider.status()).catalog), { source: 'native-cache', savedAt, liveVerified: false });
  assert.equal(client.reads, 2);
  const response = await request();
  await response.text();
  assert.equal(client.calls[0].body.model, 'claude-opus-5.5');
  assert.equal(response.bridgeModel, 'claude-opus-5.5');
  assert.equal((await response.bridgeUsage).total_tokens, 120);
});

test('remote object catalogs expose only normalized provenance and replace native metadata after refresh', async () => {
  let time = 1000;
  const { client, provider } = fixture({ now: () => time });
  client.models = { models: catalog, source: 'native-cache', savedAt: 'PRIVATE_INVALID_TIME', liveVerified: false };
  assert.deepEqual(catalogProvenance((await provider.status()).catalog), { source: 'native-cache', savedAt: null, liveVerified: false });
  time += 31_000;
  client.models = { models: catalog, source: 'remote', liveVerified: true, savedAt: time, credential: 'PRIVATE_CATALOG_FIELD' };
  const status = await provider.status();
  assert.deepEqual(catalogProvenance(status.catalog), { source: 'remote', savedAt: null, liveVerified: true });
  assert.equal(JSON.stringify(status).includes('PRIVATE_'), false);
  client.authenticated = false;
  const loggedOut = await provider.status();
  assert.equal(loggedOut.modelAvailable, false);
  assert.deepEqual(catalogProvenance(loggedOut.catalog), { source: 'remote', savedAt: null, liveVerified: false });
  assert.equal(client.calls.length, 0);
});

test('missing, disabled, ambiguous or unreadable catalogs fail closed without a model request', async () => {
  for (const models of [[], [{ ...catalog[0], disabled: true }],
    [catalog[0], { ...catalog[0], id: 'another-opus-route' }]]) {
    const { client, provider, request } = fixture(); client.models = models;
    const status = await provider.status();
    assert.equal(status.authenticated, true); assert.equal(status.modelAvailable, false);
    assert.equal((await request()).status, 503); assert.equal(client.calls.length, 0);
  }
  const { client, provider, request } = fixture(); client.catalogError = new Error('Bearer credential-must-stay-private');
  const status = await provider.status(); assert.equal(status.ready, false);
  assert.equal(JSON.stringify(status).includes('credential'), false);
  assert.equal((await request()).status, 502); assert.equal(client.calls.length, 0);
  client.authenticated = false;
  assert.equal((await request()).status, 401); assert.equal((await provider.status()).authenticated, false);
});

test('full catalogs expose safe descriptors and specialize unavailable entries without requiring Opus', async () => {
  const { client, provider, request } = fixture();
  client.models = { source: 'native-cache', savedAt: 1000, liveVerified: false, models: [
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', supportsToolCall: true, supportsImages: false,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high', summary: 'auto' }, apiKey: 'PRIVATE' },
    { id: 'completion-gf', name: 'Completion' }, { id: 'default-image-generation', name: 'Image' },
    { id: 'explicitly-disabled', name: 'Disabled', disabledReason: 'PRIVATE_DISABLED_REASON' },
  ] };
  const models = await provider.getModels(), status = await provider.status();
  assert.deepEqual(models.map(model => [model.id, model.available]), [['CodeBuddy-gpt-6-astra', true], ['CodeBuddy-completion-gf', false],
    ['CodeBuddy-default-image-generation', false], ['CodeBuddy-explicitly-disabled', false]]);
  assert.equal(models.every(model => model.source === 'native-cache'), true); assert.equal(status.ready, true); assert.equal(status.modelAvailable, true);
  assert.equal(status.upstreamModel, null); assert.deepEqual(status.catalog.models, models); assert.equal(status.catalog.liveVerified, false);
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false); assert.equal((await request()).status, 503);
  models[0].name = 'mutated'; assert.equal((await provider.getModels())[0].name, 'CodeBuddy · GPT-6-Astra');
  assert.equal(client.calls.length, 0);
});

test('a disabled older Opus entry cannot hide the one available legacy Opus route', async () => {
  const { client, provider, request } = fixture();
  client.models = [catalog[0], { id: 'old-opus-route', name: 'Claude Opus 5.5', disabled: true }];
  const models = await provider.getModels();
  assert.deepEqual(models.map(model => [model.id, model.available]), [[CODEBUDDY_MODEL.id, true], ['CodeBuddy-old-opus-route', false]]);
  const response = await request({ ...input, stream: false });
  assert.equal(response.status, 200); await response.json(); assert.equal(client.calls[0].body.model, actualId);
  assert.equal((await request({ ...input, model: 'CodeBuddy-old-opus-route' })).status, 503); assert.equal(client.calls.length, 1);
});

test('generic models use exact account IDs and upstream default thinking while rejecting unsupported explicit controls and images', async () => {
  const { client, request } = fixture();
  client.models = [{ id: 'model-no-thinking-controls', name: 'Text model', supportsToolCall: true }];
  const body = { ...input, model: 'CodeBuddy-model-no-thinking-controls', stream: false };
  const response = await request(body), message = await response.json();
  assert.equal(response.status, 200); assert.equal(message.model, body.model); assert.equal(response.bridgeModel, 'model-no-thinking-controls');
  assert.equal(client.calls[0].body.model, 'model-no-thinking-controls');
  assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_effort'), false); assert.equal(Object.hasOwn(client.calls[0].body, 'reasoning_summary'), false);
  for (const extra of [{ output_config: { effort: 'high' } }, { thinking: { type: 'disabled' } }, { thinking: { type: 'adaptive' } },
    { messages: [{ role: 'user', content: [embeddedImage()] }] }]) {
    assert.equal((await request({ ...body, ...extra })).status, 400);
  }
  assert.equal((await request({ ...body, model: 'CodeBuddy-not-in-this-account' })).status, 503);
  assert.equal(client.calls.length, 1);
});

test('generic effort and image capabilities follow the actual model and opaque state cannot cross model IDs', async () => {
  const key = Buffer.alloc(32, 0x55), { client, provider, request } = fixture({ loadThinkingState: () => new CodeBuddyThinkingState({ key }) });
  client.models = ['one', 'two'].map(id => ({ id, name: id, supportsImages: true, supportsReasoning: true,
    reasoning: { supportedEfforts: ['low', 'max'], summary: 'auto' } }));
  client.respond = () => upstream([chunk({ reasoning_content: 'PRIVATE_MODEL_REASONING' }), chunk({ content: 'Done.' }), chunk({}, 'stop'), '[DONE]']);
  const body = { ...input, model: 'CodeBuddy-one', stream: false, output_config: { effort: 'max' }, messages: [{ role: 'user', content: [embeddedImage()] }] };
  const response = await request(body), message = await response.json();
  assert.equal(response.status, 200); assert.equal(client.calls[0].body.reasoning_effort, 'max'); assert.equal(client.calls[0].body.reasoning_summary, undefined);
  const marker = message.content.find(block => block.type === 'thinking');
  assert.equal(new CodeBuddyThinkingState({ key }).open(marker).model, 'one');
  assert.equal(JSON.stringify(message).includes('PRIVATE_MODEL_REASONING'), false);
  const next = { ...body, model: 'CodeBuddy-two', messages: [...body.messages, { role: 'assistant', content: message.content }, { role: 'user', content: 'Next.' }] };
  assert.equal((await request(next)).status, 403); assert.equal(client.calls.length, 1);
  assert.equal((await request({ ...body, output_config: { effort: 'high' } })).status, 400);
  client.identity = 'employee-two'; await provider.getModels(); assert.equal(client.reads, 2);
});

test('generic image requests cannot bypass explicit negative catalog flags with a conflicting modality list', async () => {
  for (const negative of [{ supportsImages: false }, { disabledMultimodal: true }, { supportsImages: true, disabledMultimodal: true }]) {
    const { client, provider, request } = fixture();
    client.models = [{ id: 'text-only-conflict', name: 'Text only', inputModalities: ['text', 'image'], ...negative }];
    assert.deepEqual((await provider.getModels())[0].inputModalities, ['text']);
    const response = await request({ ...input, model: 'CodeBuddy-text-only-conflict', messages: [{ role: 'user', content: [embeddedImage()] }] });
    assert.equal(response.status, 400); assert.equal(client.calls.length, 0);
  }
});

test('translates system/text/options and buffers upstream SSE for a nonstream Anthropic response', async () => {
  const { client, request } = fixture();
  const body = { ...input, stream: false, system: [{ type: 'text', text: '规则一', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: '规则二' }], messages: [{ role: 'user', content: [
      { type: 'text', text: '检查文件。', cache_control: { type: 'ephemeral' } }] }],
    cache_control: { type: 'ephemeral', ttl: '5m' },
    temperature: 0.4, top_p: 0.9, metadata: { user_id: 'client-user' } };
  const original = structuredClone(body);
  client.respond = () => answer('核实完成。');
  const response = await request(body), message = await response.json();
  assert.equal(response.status, 200); assert.equal(response.bridgeModel, actualId);
  assert.deepEqual(response.bridgeCacheControl, { ignoredHints: 3, usage: 'upstream_reported_only' });
  assert.deepEqual(body, original);
  assert.deepEqual(client.calls[0].body, { model: actualId, stream: true, stream_options: { include_usage: true }, max_tokens: 128,
    reasoning_effort: 'high', reasoning_summary: 'auto',
    temperature: 0.4, top_p: 0.9, user: 'client-user', messages: [
      { role: 'system', content: '规则一' }, { role: 'system', content: '规则二' }, { role: 'user', content: '检查文件。' }] });
  assert.deepEqual(Object.keys(client.calls[0]).sort(), ['body', 'expectedIdentity', 'signal']);
  assert.equal(client.calls[0].expectedIdentity, 'employee-one');
  assert.equal(JSON.stringify(client.calls[0].body).includes('client-key'), false);
  assert.equal(message.model, CODEBUDDY_MODEL.id); assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{ type: 'text', text: '核实完成。' }]);
  assert.deepEqual(message.usage, { input_tokens: 35, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 5 });
});

test('parallel fragmented tool calls round-trip as client-owned tool_result messages without executing tools', async () => {
  const { client, request } = fixture();
  const body = { ...input, tools: [{ ...tool, cache_control: { type: 'ephemeral', ttl: '5m' } }, secondTool],
    tool_choice: { type: 'any', disable_parallel_tool_use: false } };
  client.respond = () => upstream([
    chunk({ role: 'assistant', content: '先检查。' }),
    chunk({ tool_calls: [{ index: 1, id: 'call_two', type: 'function', function: { name: 'list_', arguments: '{' } },
      { index: 0, id: 'call_', type: 'function', function: { name: 'read_', arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ index: 0, id: 'one', function: { name: 'file', arguments: '"vm.txt"}' } },
      { index: 1, function: { name: 'files', arguments: '}' } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]',
  ], { split: true });
  const response = await request(body), wire = await events(response), blocks = content(wire);
  assert.equal(response.bridgeCacheControl.ignoredHints, 1);
  assert.equal(wire.at(-1).type, 'message_stop');
  assert.equal(wire.find(event => event.type === 'message_delta').delta.stop_reason, 'tool_use');
  assert.deepEqual(blocks, [{ type: 'text', text: '先检查。' },
    { type: 'tool_use', id: 'call_one', name: 'read_file', input: { path: 'vm.txt' } },
    { type: 'tool_use', id: 'call_two', name: 'list_files', input: {} }]);
  assert.equal(client.calls[0].body.tool_choice, 'required');
  assert.equal(client.calls[0].body.parallel_tool_calls, true);
  assert.deepEqual(client.calls[0].body.tools[0], { type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.input_schema } });
  client.respond = () => answer('工具结果已读取。');
  const next = { ...body, stream: false, messages: [...body.messages, { role: 'assistant', content: blocks },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_two', content: [{ type: 'text', text: 'a.txt' }] },
      { type: 'tool_result', tool_use_id: 'call_one', content: 'Permission denied', is_error: true },
      { type: 'text', text: '解释失败原因。' }] }] };
  delete next.tool_choice;
  assert.equal((await request(next)).status, 200);
  const translated = client.calls[1].body.messages;
  assert.deepEqual(translated.slice(-3), [{ role: 'tool', tool_call_id: 'call_two', content: 'a.txt' },
    { role: 'tool', tool_call_id: 'call_one', content: '[Tool error]\nPermission denied' }, { role: 'user', content: '解释失败原因。' }]);
  assert.equal(translated.at(-4).tool_calls[0].function.arguments, '{"path":"vm.txt"}');
});

test('streaming preserves split UTF-8, Anthropic event ordering and explicit cache/reasoning subsets', async () => {
  const { client, request } = fixture(); client.respond = () => answer('中文🙂\n完成', { split: true });
  const response = await request(), wire = await events(response);
  assert.deepEqual(wire.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop']);
  assert.deepEqual(content(wire), [{ type: 'text', text: '中文🙂\n完成' }]);
  assert.deepEqual(await response.bridgeUsage, { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 7 } });
});

test('length termination is max_tokens; missing usage stays unknown in the ledger contract', async () => {
  const { client, request } = fixture(); client.respond = () => answer('未完成的文本', { finish: 'length', withUsage: false });
  const response = await request({ ...input, stream: false }), message = await response.json();
  assert.equal(message.stop_reason, 'max_tokens'); assert.equal(await response.bridgeUsage, null);
  client.respond = () => upstream([chunk({ content: 'Done.' }), chunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 12 } }, '[DONE]']);
  const partial = await request(); await partial.text();
  assert.deepEqual(await partial.bridgeUsage, { input_tokens: 12, output_tokens: null, total_tokens: null,
    input_tokens_details: { cached_tokens: null, cache_write_tokens: null }, output_tokens_details: { reasoning_tokens: null } });
  client.respond = () => upstream([chunk({ content: 'Done.' }),
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 13 },
      completion_tokens_details: { reasoning_tokens: 9 } } },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } }, chunk({}, 'stop'), '[DONE]']);
  const updated = await request(); await updated.text();
  assert.deepEqual(await updated.bridgeUsage, { input_tokens: 12, output_tokens: 5, total_tokens: 17,
    input_tokens_details: { cached_tokens: null, cache_write_tokens: null }, output_tokens_details: { reasoning_tokens: null } });
});

test('truncated and upstream-error streams never emit message_stop and retain only reported usage', async () => {
  for (const failure of ['eof', 'error']) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ content: 'Partial' }), { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ...(failure === 'error' ? [{ error: { message: 'Bearer private-upstream-credential' } }] : [chunk({}, 'stop')])]);
    const response = await request(), wire = await events(response);
    assert.equal(wire.at(-1).type, 'error'); assert.equal(wire.some(event => event.type === 'message_stop'), false);
    assert.equal(JSON.stringify(wire).includes('private-upstream'), false);
    assert.equal((await response.bridgeUsage).output_tokens, 3);
    const json = await request({ ...input, stream: false }); assert.equal(json.status, 502);
    assert.equal((await json.json()).type, 'error');
  }
});

test('empty intermediate finish reasons preserve text and fragmented tools until a known terminal reason', async () => {
  const cases = [
    { chunks: [chunk({ role: 'assistant', content: '' }, ''), chunk({ content: '中文' }, ''),
      chunk({ content: '', reasoning_content: '' }, ''), chunk({ content: '完成。' }, ''), chunk({}, 'stop')],
    stop: 'end_turn', blocks: [{ type: 'text', text: '中文完成。' }] },
    { chunks: [chunk({ role: 'assistant', content: '' }, ''), chunk({ tool_calls: [
      { index: 0, id: 'call_one', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, ''),
    chunk({ content: '', tool_calls: [{ index: 0, function: { name: '', arguments: '"vm.txt"}' } }] }, ''),
    chunk({}, 'tool_calls')], stop: 'tool_use',
    blocks: [{ type: 'tool_use', id: 'call_one', name: 'read_file', input: { path: 'vm.txt' } }] },
  ];
  for (const item of cases) for (const stream of [false, true]) {
    const { client, request } = fixture();
    client.respond = () => upstream([...item.chunks, { choices: [], usage }, '[DONE]'], { split: true });
    const response = await request({ ...input, tools: [tool], stream });
    assert.equal(response.status, 200);
    if (stream) {
      const wire = await events(response);
      assert.equal(wire.at(-1).type, 'message_stop');
      assert.equal(wire.find(event => event.type === 'message_delta').delta.stop_reason, item.stop);
      assert.deepEqual(content(wire), item.blocks);
    } else {
      const message = await response.json();
      assert.equal(message.stop_reason, item.stop); assert.deepEqual(message.content, item.blocks);
    }
    assert.equal((await response.bridgeUsage).total_tokens, 120);
  }
});

test('empty finish reasons never replace a known terminal reason or the DONE marker', async () => {
  const cases = [
    [chunk({ content: 'Partial' }, ''), chunk({}, ''), '[DONE]'],
    [chunk({ content: 'Partial' }, ''), chunk({}, '')],
    [chunk({ content: 'Partial' }, ''), chunk({}, 'stop')],
  ];
  for (const chunks of cases) for (const stream of [false, true]) {
    const { client, request } = fixture(); client.respond = () => upstream(chunks);
    const response = await request({ ...input, stream });
    if (stream) {
      const wire = await events(response);
      assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false);
    } else {
      assert.equal(response.status, 502);
      assert.match((await response.json()).error.message, /未完整结束/);
    }
  }
});

test('an empty chunk after termination is accepted but further content or terminal reasons are rejected', async () => {
  for (const stream of [false, true]) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ content: 'Done.' }, ''), chunk({}, 'stop'), chunk({}, ''),
      chunk({}, null), { choices: [], usage }, '[DONE]']);
    const response = await request({ ...input, stream }); assert.equal(response.status, 200);
    if (stream) assert.equal((await events(response)).at(-1).type, 'message_stop');
    else assert.equal((await response.json()).stop_reason, 'end_turn');
    for (const after of [chunk({ content: 'Unexpected' }, ''), chunk({}, 'stop')]) {
      client.respond = () => upstream([chunk({ content: 'Done.' }, ''), chunk({}, 'stop'), after, '[DONE]']);
      const rejected = await request({ ...input, stream });
      if (stream) {
        const wire = await events(rejected);
        assert.equal(wire.at(-1).type, 'error');
        assert.equal(wire.some(event => event.type === 'message_stop'), false);
      } else assert.equal(rejected.status, 502);
    }
  }
});

test('native error finish reasons fail with only safe integer upstream codes', async () => {
  for (const fields of [{ status_code: 429, code: 12403 },
    { status_code: 'PRIVATE_STATUS', code: 12403.25 }, { status_code: Number.MAX_SAFE_INTEGER + 1, code: false }]) {
    for (const withErrorBody of [false, true]) for (const stream of [false, true]) {
      const { client, request } = fixture();
      client.respond = () => upstream([chunk({ content: 'Partial' }, ''), { ...chunk({}, 'error'), ...fields,
        msg: 'PRIVATE_UPSTREAM_MESSAGE', messages: ['PRIVATE_UPSTREAM_BODY'],
        ...(withErrorBody ? { error: { message: 'Bearer PRIVATE_UPSTREAM_CREDENTIAL', code: 'PRIVATE_NESTED_CODE' } } : {}) }, '[DONE]']);
      const response = await request({ ...input, stream });
      let message;
      if (stream) {
        const wire = await events(response);
        assert.equal(wire.at(-1).type, 'error');
        assert.equal(wire.some(event => event.type === 'message_stop'), false);
        message = wire.at(-1).error.message;
      } else {
        assert.equal(response.status, 502); message = (await response.json()).error.message;
      }
      assert.match(message, /finish_reason=error/); assert.equal(message.includes('PRIVATE_'), false);
      if (fields.status_code === 429) assert.match(message, /status_code=429,code=12403/);
      else assert.doesNotMatch(message, /status_code=|\bcode=/);
    }
  }
});

test('unsupported finish reasons expose only approved enums or value types and string lengths', async () => {
  const enums = ['content_filter', 'end_turn', 'max_tokens', 'tool_use', 'tool_call', 'stop_sequence', 'pause_turn', 'refusal'];
  const unknown = ['Bearer PRIVATE_FINISH_TOKEN', 'PRIVATE_\nFINISH', 0, false, ['PRIVATE_FINISH'], { token: 'PRIVATE_FINISH' }];
  for (const reason of [...enums, ...unknown]) for (const stream of [false, true]) {
    const { client, request } = fixture(); client.respond = () => upstream([chunk({ content: 'Partial' }, ''), chunk({}, reason), '[DONE]']);
    const response = await request({ ...input, stream });
    let message;
    if (stream) {
      const wire = await events(response);
      assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false);
      message = wire.at(-1).error.message;
    } else {
      assert.equal(response.status, 502); message = (await response.json()).error.message;
    }
    assert.equal(message.includes('PRIVATE_'), false);
    if (enums.includes(reason)) assert.ok(message.includes(`finish_reason=${reason}`));
    else {
      assert.ok(message.includes(`type=${Array.isArray(reason) ? 'array' : typeof reason}`));
      if (typeof reason === 'string') assert.ok(message.includes(`length=${reason.length}`));
    }
  }
});

test('unsupported public delta fields expose names and types without content or child objects', async () => {
  const cases = [
    ['name', 'PRIVATE_NAME', 'string,length=12'],
    ['tool_call_id', 'PRIVATE_CALL', 'string,length=12'],
    ['audio', { data: 'PRIVATE_AUDIO', transcript: 'PRIVATE_TRANSCRIPT' }, 'object'],
    ['reasoning', 'PRIVATE_THOUGHT', 'string,length=15'],
    ['reasoning_details', [{ text: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' }], 'array,length=1'],
    ['metadata', { token: 'PRIVATE_TOKEN', body: { text: 'PRIVATE_BODY' } }, 'object'],
    ['index', 0, 'number'], ['usage', false, 'boolean'],
  ];
  for (const [key, value, expected] of cases) for (const stream of [false, true]) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ content: 'Partial' }, ''), chunk({ [key]: value }, ''), chunk({}, 'stop'), '[DONE]']);
    const response = await request({ ...input, stream });
    let error;
    if (stream) {
      const wire = await events(response); assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false); error = wire.at(-1).error;
    } else {
      assert.equal(response.status, 502); error = (await response.json()).error;
    }
    assert.equal(error.message, `CodeBuddy 返回了尚未支持的内容类型（${key}:${expected}）。`);
    assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(error).includes('transcript'), false);
  }
});

test('dynamic delta field names and values remain hidden in streaming and buffered errors', async () => {
  for (const value of ['PRIVATE_VALUE', ['PRIVATE_CHILD'], { token: 'PRIVATE_TOKEN' }]) for (const stream of [false, true]) {
    const key = 'Bearer PRIVATE_DYNAMIC_FIELD';
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ [key]: value }, ''), chunk({}, 'stop'), '[DONE]']);
    const response = await request({ ...input, stream });
    let error;
    if (stream) {
      const wire = await events(response); assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false); error = wire.at(-1).error;
    } else {
      assert.equal(response.status, 502); error = (await response.json()).error;
    }
    const type = Array.isArray(value) ? 'array' : typeof value;
    const length = typeof value === 'string' || Array.isArray(value) ? `,length=${value.length}` : '';
    assert.equal(error.message, `CodeBuddy 返回了尚未支持的内容类型（unknown_key,keyLength=${key.length},valueType=${type}${length}）。`);
    assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
    assert.equal(JSON.stringify(error).includes('Bearer'), false);
  }
});

test('unsupported delta diagnostics contain at most eight field descriptions', async () => {
  for (const stream of [false, true]) {
    const delta = { role: 'assistant', name: 'PRIVATE_NAME', tool_call_id: 'PRIVATE_CALL', audio: {}, reasoning: 'PRIVATE_THOUGHT',
      reasoning_details: [], reasoning_signature: 'PRIVATE_SIGNATURE', extra_content: {}, metadata: {},
      thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE', annotations: [], function_call: {},
      PRIVATE_DYNAMIC_FIELD: { token: 'PRIVATE_TOKEN' } };
    const { client, request } = fixture();
    client.respond = () => upstream([chunk(delta, ''), chunk({}, 'stop'), '[DONE]']);
    const response = await request({ ...input, stream });
    let message;
    if (stream) {
      const wire = await events(response); assert.equal(wire.at(-1).type, 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), false); message = wire.at(-1).error.message;
    } else {
      assert.equal(response.status, 502); message = (await response.json()).error.message;
    }
    const details = /（(.*)）。$/u.exec(message)[1].split(';');
    assert.equal(details.length, 8);
    assert.deepEqual(details.map(item => item.split(':')[0]), ['name', 'tool_call_id', 'audio', 'reasoning',
      'reasoning_details', 'reasoning_signature', 'extra_content', 'metadata']);
    assert.equal(message.includes('PRIVATE_'), false); assert.equal(message.includes('unknown_key'), false);
  }
});

test('delta diagnostics preserve the existing null and empty-string exception without accepting empty containers', async () => {
  for (const value of [null, '', [], {}, false, 0]) for (const stream of [false, true]) {
    const { client, request } = fixture();
    client.respond = () => upstream([chunk({ content: 'Done.', metadata: value }, ''), chunk({}, 'stop'), '[DONE]']);
    const response = await request({ ...input, stream }), accepted = value === null || value === '';
    if (stream) {
      const wire = await events(response);
      assert.equal(wire.at(-1).type, accepted ? 'message_stop' : 'error');
      assert.equal(wire.some(event => event.type === 'message_stop'), accepted);
    } else {
      assert.equal(response.status, accepted ? 200 : 502);
      const body = await response.json(); assert.equal(body.type, accepted ? 'message' : 'error');
    }
  }
});

test('HTTP errors and invalid tool completions fail without exposing upstream bodies or completing a turn', async () => {
  const { client, request } = fixture();
  client.respond = () => Response.json({ error: { message: 'Bearer secret-value' } }, { status: 401 });
  const denied = await request(); assert.equal(denied.status, 401);
  assert.equal((await denied.text()).includes('secret-value'), false); assert.equal(await denied.bridgeUsage, null);
  for (const call of [
    { name: 'read_file', arguments: '{"path":' }, { name: 'undeclared_tool', arguments: '{}' },
    { name: 'read_file', arguments: '[]' },
  ]) {
    client.respond = () => upstream([chunk({ tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: call }] }),
      chunk({}, 'tool_calls'), '[DONE]']);
    const response = await request({ ...input, tools: [tool] }), wire = await events(response);
    assert.equal(wire.at(-1).type, 'error'); assert.equal(wire.some(event => event.type === 'message_stop'), false);
    assert.equal(wire.some(event => event.content_block?.type === 'tool_use'), false);
  }
});

test('consumer cancellation and AbortSignal cancel the upstream and settle known usage without completing', async () => {
  for (const mode of ['consumer', 'signal']) {
    const { client, request } = fixture(); let cancelled = false;
    client.respond = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(frame({ ...chunk({ content: 'Partial' }), usage: { prompt_tokens: 9 } })));
    }, cancel() { cancelled = true; } }));
    const abort = new AbortController(), response = await request(input, abort.signal), reader = response.body.getReader();
    const first = await reader.read(); assert.equal(first.done, false);
    if (mode === 'consumer') await reader.cancel();
    else {
      abort.abort();
      let wire = new TextDecoder().decode(first.value);
      while (true) { const item = await reader.read(); if (item.done) break; wire += new TextDecoder().decode(item.value); }
      assert.equal(wire.includes('event: message_stop'), false); assert.equal(wire.includes('event: error'), true);
    }
    assert.equal(client.calls[0].signal.aborted, true); assert.equal(cancelled, true);
    assert.equal((await response.bridgeUsage).input_tokens, 9);
    reader.releaseLock();
  }
});

test('unsupported input fails before metadata or inference; count_tokens is explicitly unavailable', async () => {
  const { client, provider, request } = fixture();
  const bad = [
    { ...input, model: 'claude-opus-5.5' }, { ...input, thinking: { type: 'enabled', budget_tokens: 2048 } },
    { ...input, thinking: { type: 'disabled' } },
    { ...input, system: [{ type: 'text', text: 'Cache', cache_control: { type: 'ephemeral', ttl: '24h' } }] },
    { ...input, messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    { ...input, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] }] },
    { ...input, tools: [{ input_schema: {} }] }, { ...input, output_config: { effort: 'max' } },
  ];
  for (const body of bad) assert.equal((await request(body)).status, 400);
  assert.equal((await provider.request({ path: '/v1/messages/count_tokens', body: input })).status, 501);
  assert.equal((await provider.request({ path: 'https://other.invalid/v1/messages', body: input })).status, 400);
  assert.equal(client.reads, 0); assert.equal(client.calls.length, 0);
  client.respond = () => upstream([chunk({ tool_calls: [{ index: 0, id: 'forced', type: 'function',
    function: { name: 'read_file', arguments: '{}' } }] }), chunk({}, 'tool_calls'), '[DONE]']);
  const forced = await request({ ...input, tools: [tool], tool_choice: { type: 'tool', name: 'read_file', disable_parallel_tool_use: true } });
  await forced.text();
  assert.deepEqual(client.calls[0].body.tool_choice, { type: 'function', function: { name: 'read_file' } });
  assert.equal(client.calls[0].body.parallel_tool_calls, false);
});
