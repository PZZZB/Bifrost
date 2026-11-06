import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { translateResponses } from '../src/protocols/responses-messages.mjs';

const model = 'CodeBuddy-hy4std';
const functionTool = (name = 'read_file') => ({ type: 'function', name, strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } } } });
const namespace = (name, tools) => ({ type: 'namespace', name, tools });
const profile = { model, sealCompaction: () => 'offline-summary-state' };
const translate = body => translateResponses({ model, input: 'Use the declared tool.', ...body }, 'offline-marker', profile);
const tool = name => ({ name, input_schema: { type: 'object', properties: { path: { type: 'string' } } } });
const body = { model, max_tokens: 32, stream: false, messages: [{ role: 'user', content: 'Inspect a fixture.' }], tools: [tool('wire_read')] };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function reply(parts = ['read_file'], argumentsText = '{ "path" : "文件.txt" }') {
  const frames = parts.map((name, index) => chunk({ tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call_1', type: 'function' } : {}),
    function: { name, ...(index === 0 ? { arguments: argumentsText } : {}) } }] }));
  frames.push(chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, '[DONE]');
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index === frames.length) { controller.close(); return; }
    const frame = frames[index++];
    controller.enqueue(Buffer.from(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`));
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture({ respond = () => reply(), loadThinkingState } = {}) {
  const calls = [], counts = { status: 0, catalog: 0 };
  const client = {
    status() { counts.status++; return { authenticated: true, identity: { uid: 'offline-alias-owner' } }; },
    async modelCatalog() { counts.catalog++; return [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }]; },
    async chatCompletions(request) { calls.push(request); return respond(request); },
  };
  const provider = new CodeBuddyProvider({ client,
    loadThinkingState: loadThinkingState ?? (() => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 3) })) });
  return { calls, counts, request: (value = body, options = {}) => provider.request({ path: '/v1/messages', body: value, ...options }) };
}
const check = value => value.error?.sourceDiagnostics?.check;

test('an explicit process-only alias maps a complete fragmented tool name without changing arguments or call identity', async () => {
  const state = fixture({ respond: () => reply(['read_', 'file']) });
  const response = await state.request(body, { toolNameAliases: new Map([['read_file', 'wire_read']]) });
  assert.equal(response.status, 200);
  const message = await response.json(), invocation = message.content.find(block => block.type === 'tool_use');
  assert.deepEqual(invocation, { type: 'tool_use', id: 'call_1', name: 'wire_read', input: { path: '文件.txt' } });
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].body.tools[0].function.name, 'wire_read');
  assert.equal(state.calls[0].body.toolNameAliases, undefined, 'The compatibility map is never an upstream request field.');
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 5 });
});

test('the provider snapshots process aliases before the first asynchronous state load', async () => {
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const state = fixture({ loadThinkingState: () => loading }), aliases = new Map([['read_file', 'wire_read']]);
  const pending = state.request(body, { toolNameAliases: aliases });
  aliases.clear(); aliases.set('read_file', 'NOT_A_DECLARED_TARGET');
  release(new CodeBuddyThinkingState({ key: Buffer.alloc(32, 5) }));
  const response = await pending;
  assert.equal(response.status, 200); assert.equal((await response.json()).content.at(-1).name, 'wire_read');
  assert.equal(state.calls.length, 1);
});

test('direct Messages requests keep exact declared-name behavior without an internal alias map', async () => {
  const state = fixture();
  const rejected = await state.request();
  assert.equal(rejected.status, 502); assert.equal(check(await rejected.json()), 'tool_not_declared');
  const direct = await state.request({ ...body, tools: [tool('read_file')] });
  assert.equal(direct.status, 200); assert.equal((await direct.json()).content.at(-1).name, 'read_file');
  assert.equal(state.calls.length, 2);
});

test('an HTTP JSON field cannot supply the process-only alias mapping', async () => {
  const state = fixture();
  const response = await state.request({ ...body, toolNameAliases: { read_file: 'wire_read' } });
  assert.equal(response.status, 400); await response.body.cancel();
  assert.deepEqual(state.counts, { status: 0, catalog: 0 }); assert.equal(state.calls.length, 0);
});

const invalidMaps = [
  ['object instead of Map', () => ({ read_file: 'wire_read' })],
  ['unknown target', () => new Map([['read_file', 'not_declared']])],
  ['canonical redirect', () => new Map([['wire_read', 'wire_other']])],
  ['non-string reference', () => new Map([[{ private: true }, 'wire_read']])],
  ['empty reference', () => new Map([['', 'wire_read']])],
  ['oversized reference', () => new Map([['a'.repeat(129), 'wire_read']])],
  ['control in reference', () => new Map([['private\nread', 'wire_read']])],
  ['non-string target', () => new Map([['read_file', {}]])],
  ['excessive map', () => new Map(Array.from({ length: 257 }, (_, index) => [`read_${index}`, 'wire_read']))],
];
for (const [description, aliases] of invalidMaps) test(`${description} cannot expand the provider's declared wire tool set`, async () => {
  const state = fixture(), response = await state.request({ ...body, tools: [...body.tools, tool('wire_other')] }, { toolNameAliases: aliases() });
  assert.equal(response.status, 400); const value = await response.json();
  assert.equal(JSON.stringify(value).includes('not_declared'), false);
  assert.deepEqual(state.counts, { status: 0, catalog: 0 }); assert.equal(state.calls.length, 0);
});

test('name normalization does not bypass a forced different tool or tool_choice none', async () => {
  for (const [tool_choice, expected] of [[{ type: 'tool', name: 'wire_other' }, 'forced_tool_mismatch'], [{ type: 'none' }, 'tools_forbidden']]) {
    const state = fixture(), response = await state.request({ ...body, tools: [...body.tools, tool('wire_other')], tool_choice },
      { toolNameAliases: new Map([['read_file', 'wire_read']]) });
    assert.equal(response.status, 502); assert.equal(check(await response.json()), expected); assert.equal(state.calls.length, 1);
  }
});

test('an overlength returned name is still rejected before any alias normalization', async () => {
  const state = fixture({ respond: () => reply(['r'.repeat(128), 'r']) });
  const response = await state.request(body, { toolNameAliases: new Map([['r'.repeat(128), 'wire_read']]) });
  assert.equal(response.status, 502); assert.equal(check(await response.json()), 'tool_name_size');
  assert.equal(state.calls.length, 1);
});

test('namespace and type ambiguities never pick a bare original name, while explicit dotted references remain exact', () => {
  const translated = translate({ tools: [namespace('alpha', [functionTool()]), namespace('beta', [functionTool()])] });
  const aliases = translated.tools.declaredNameAliases();
  assert.equal(aliases.has('read_file'), false);
  assert.equal(aliases.get('alpha.read_file'), translated.upstream.tools[0].name);
  assert.equal(aliases.get('beta.read_file'), translated.upstream.tools[1].name);
  assert.equal(aliases.has('alpha__read_file'), false);
  const differentTypes = translate({ tools: [functionTool(), { type: 'custom', name: 'read_file', format: { type: 'text' } }] });
  assert.equal(differentTypes.tools.declaredNameAliases().has('read_file'), false);
  const dottedCollision = translate({ tools: [namespace('alpha', [functionTool()]), functionTool('alpha.read_file')] });
  assert.equal(dottedCollision.tools.declaredNameAliases().has('alpha.read_file'), false);
});

test('a real wire alias wins even when it is another tool original display name', () => {
  const single = translate({ tools: [functionTool()] }), wire = single.upstream.tools[0].name;
  const translated = translate({ tools: [functionTool(), functionTool(wire)] });
  assert.equal(translated.upstream.tools[0].name, wire, 'Existing hash identities are unchanged.');
  assert.equal(translated.tools.declaredNameAliases().has(wire), false);
  assert.equal(translated.tools.byAlias.get(wire).name, 'read_file');
});

test('unloaded deferred and history-only tools cannot enter the current-name map', () => {
  const translated = translate({ tools: [functionTool('current'), { ...functionTool('deferred'), defer_loading: true }], input: [
    { role: 'user', content: 'Earlier request.' },
    { type: 'function_call', name: 'history_only', namespace: 'functions', call_id: 'past_call', arguments: '{}' },
    { type: 'function_call_output', call_id: 'past_call', output: 'Earlier result.' },
    { role: 'user', content: 'Continue.' },
  ] });
  const aliases = translated.tools.declaredNameAliases();
  assert.equal(aliases.has('current'), true); assert.equal(aliases.has('deferred'), false);
  assert.equal(aliases.has('history_only'), false); assert.equal(aliases.has('functions.history_only'), false);
});

for (const inactive of ['history-only', 'deferred']) test(`a known ${inactive} name prevents bare-name redirection to another active namespace`, () => {
  const translated = translate({ tools: [namespace('other', [functionTool()]),
    ...(inactive === 'deferred' ? [namespace('functions', [{ ...functionTool(), defer_loading: true }])] : [])],
  ...(inactive === 'history-only' ? { input: [{ role: 'user', content: 'Earlier request.' },
    { type: 'function_call', name: 'read_file', namespace: 'functions', call_id: 'past_read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'past_read', output: 'Earlier result.' },
    { role: 'user', content: 'Continue.' }] } : {}) });
  const aliases = translated.tools.declaredNameAliases();
  assert.equal(aliases.has('read_file'), false);
  assert.equal(aliases.has('functions.read_file'), false);
  assert.equal(aliases.get('other.read_file'), translated.upstream.tools[0].name);
});

test('client discovery explicitly loads deferred names, and filtering real wire declarations keeps compaction tool-free', () => {
  const search = { type: 'tool_search', execution: 'client' };
  const translated = translate({ tools: [search], input: [{ role: 'user', content: 'Discover.' },
    { type: 'tool_search_call', execution: 'client', call_id: 'search_call', arguments: {} },
    { type: 'tool_search_output', call_id: 'search_call', tools: [namespace('functions', [{ ...functionTool(), defer_loading: true }])] },
  ] });
  assert.equal(translated.tools.declaredNameAliases().has('functions.read_file'), true);
  const compact = translate({ tools: [functionTool()], input: [{ role: 'user', content: 'Summarize.' }, { type: 'compaction_trigger' }] });
  assert.equal(compact.upstream.tools, undefined);
  assert.equal(compact.tools.declaredNameAliases((compact.upstream.tools ?? []).map(entry => entry.name)).size, 0);
});
