import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ClientStateCodec } from '../src/client-state.mjs';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';
import { messagesJsonEvents } from '../src/protocols/responses-messages.mjs';

const secret = 'offline-snapshot-state-secret-without-live-credentials';
const parent = '11111111-1111-4111-8111-111111111111';
const snapshot = '22222222-2222-4222-8222-222222222222';
const unrelated = '33333333-3333-4333-8333-333333333333';
const model = 'Claude-opus', compactionPrefix = 'bifrost-messages-compaction-v1:';
const tool = { type: 'function', name: 'read_file', description: 'Read a client fixture.', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const base = { model, store: false, input: [{ role: 'user', content: 'Keep the observed fixture history.' }] };
const message = (content, stop_reason = 'end_turn') => ({ id: 'msg_snapshot_fixture', type: 'message', role: 'assistant', model,
  content, stop_reason, usage: { input_tokens: 12, output_tokens: 4 } });
function nativeResponse(value, streaming) {
  if (!streaming) return Response.json(value);
  return new Response([...messagesJsonEvents(value)].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
async function read(response, streaming = false) {
  assert.equal(response.status, 200, `Expected a complete fixture response, received HTTP ${response.status}.`);
  if (!streaming) return response.json();
  const events = (await response.text()).split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
  const completed = events.findLast(event => event.type === 'response.completed');
  assert.ok(completed, JSON.stringify(events.at(-1))); return completed.response;
}
function fixture({ streaming = false, stateSecret = secret } = {}) {
  const calls = [], control = { respond: () => message([{ type: 'text', text: 'Fixture complete.' }]) };
  const adapter = new MessagesResponsesAdapter({ stateSecret, requestMessages: async request => {
    calls.push({ ...request, body: structuredClone(request.body) });
    return nativeResponse(control.respond(request.body), streaming);
  } });
  return { adapter, calls, control, request: (body = base, options = {}) => adapter.request({ body, scope: parent,
    session: 'parent-live-session', ...options }) };
}
const rebind = (adapter, value, kind, options = {}) => adapter.rebindState(value, { fromScope: parent, scope: snapshot, model, kind, ...options });
const rejectsState = callback => assert.throws(callback, error => error.status === 409
  && !/PRIVATE_RAW_STATE|PRIVATE_SIGNATURE|PRIVATE_SUMMARY/.test(error.message));

for (const streaming of [false, true]) for (const redacted of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} ${redacted ? 'redacted' : 'signed'} thinking is authenticated and rebound without sharing live sessions`, async () => {
    const f = fixture({ streaming }), block = redacted ? { type: 'redacted_thinking', data: 'PRIVATE_RAW_STATE' }
      : { type: 'thinking', thinking: 'Observed reasoning text.', signature: 'PRIVATE_SIGNATURE' };
    f.control.respond = () => message([block, { type: 'text', text: 'Parent complete.' }]);
    const first = await read(await f.request({ ...base, stream: streaming }), streaming);
    const state = first.output.find(item => item.type === 'reasoning'); assert.ok(state);
    const original = state.encrypted_content;
    assert.equal(rebind(f.adapter, original, 'reasoning', { scope: parent }), original);
    const moved = rebind(f.adapter, original, 'reasoning'); assert.notEqual(moved, original);
    rejectsState(() => rebind(f.adapter, original, 'reasoning', { fromScope: snapshot, scope: snapshot }));
    rejectsState(() => rebind(f.adapter, moved, 'reasoning', { fromScope: parent }));
    f.control.respond = () => message([{ type: 'text', text: 'Child complete.' }]);
    const history = [...base.input, ...first.output.map(item => item === state ? { ...item, encrypted_content: moved } : item),
      { role: 'user', content: 'Continue in the child.' }];
    const child = await read(await f.request({ ...base, stream: streaming, input: history },
      { scope: snapshot, session: 'child-live-session' }), streaming);
    assert.equal(child.status, 'completed'); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].session, 'parent-live-session'); assert.equal(f.calls[1].session, 'child-live-session');
    const replayed = f.calls[1].body.messages.find(item => item.role === 'assistant').content;
    assert.deepEqual(replayed[0], block);
    const parentAgain = await f.request({ ...base, input: [...base.input, ...first.output, { role: 'user', content: 'Parent continues independently.' }] });
    assert.equal(parentAgain.status, 200); await parentAgain.text();
    assert.equal(state.encrypted_content, original, 'A fork must not rewrite the parent client history.');
  });
}

for (const streaming of [false, true]) for (const kind of ['compaction', 'context_compaction']) {
  test(`${streaming ? 'SSE' : 'JSON'} ${kind} preserves the authenticated summary when it is the only earlier history`, async () => {
    const f = fixture({ streaming }), summary = 'PRIVATE_SUMMARY\nChanged fixture.txt. Tests: 3 passed. Next: inspect the result.🙂';
    f.control.respond = () => message([{ type: 'text', text: summary }]);
    const compact = await read(await f.request({ ...base, stream: streaming, input: [...base.input, { type: 'compaction_trigger' }] }), streaming);
    const checkpoint = compact.output[0]; assert.equal(checkpoint.type, 'compaction');
    const original = checkpoint.encrypted_content, moved = rebind(f.adapter, original, kind);
    assert.equal(rebind(f.adapter, original, kind, { scope: parent }), original);
    rejectsState(() => rebind(f.adapter, original, kind, { fromScope: unrelated }));
    rejectsState(() => rebind(f.adapter, original, kind, { model: 'Claude-sonnet' }));
    assert.equal(f.adapter.openCompactionForHandoff(moved, { scope: snapshot, model }), summary);
    assert.equal(f.adapter.openCompactionForHandoff(original, { scope: parent, model }), summary);
    f.control.respond = () => message([{ type: 'text', text: 'Continue from the imported summary.' }]);
    const child = await read(await f.request({ ...base, stream: streaming, input: [{ type: kind, encrypted_content: moved },
      { role: 'user', content: 'Continue after the checkpoint.' }] }, { scope: snapshot, session: 'child-live-session' }), streaming);
    assert.equal(child.status, 'completed'); assert.equal(f.calls.length, 2);
    const text = JSON.stringify(f.calls[1].body.messages);
    assert.equal(text.split('PRIVATE_SUMMARY').length - 1, 1);
    assert.match(text, /Changed fixture\.txt/); assert.match(text, /Tests: 3 passed/);
    assert.doesNotMatch(text, /bifrost-messages-compaction-v1|bifrost-client-state-v1/);
  });
}

test('rebind rejects unknown, tampered, differently scoped or unrecognized payloads, including same-scope attempts', async () => {
  const f = fixture();
  f.control.respond = () => message([{ type: 'thinking', thinking: 'private thought', signature: 'PRIVATE_SIGNATURE' }, { type: 'text', text: 'Done.' }]);
  const first = await read(await f.request()), value = first.output.find(item => item.type === 'reasoning').encrypted_content;
  const cipher = new ClientStateCodec({ secret });
  const unsupported = cipher.seal(JSON.stringify({ type: 'thinking', thinking: 'x', signature: 'PRIVATE_SIGNATURE', pending_tool: 'PRIVATE_RAW_STATE' }), parent, model);
  const notThinking = cipher.seal(JSON.stringify({ type: 'tool_use', id: 'pending_tool', input: {} }), parent, model);
  const badCompaction = compactionPrefix + new ClientStateCodec({ secret: createHmac('sha256', secret)
    .update('bifrost-messages-compaction-v1').digest('hex') }).seal(JSON.stringify({ version: 1, summary: 'PRIVATE_SUMMARY', pending: true }), parent, model);
  for (const [token, kind, options] of [
    [value, 'reasoning', { fromScope: unrelated }], [value, 'reasoning', { model: 'Claude-sonnet' }],
    [value, 'reasoning', { fromScope: unrelated, scope: unrelated }], [value, 'reasoning', { scope: 'invalid' }],
    [value.slice(0, -8) + 'aaaaaaaa', 'reasoning', {}], ['PRIVATE_RAW_STATE', 'reasoning', {}],
    [value, 'compaction', {}], [value, 'thinking', {}], [unsupported, 'reasoning', {}], [notThinking, 'reasoning', {}],
    [badCompaction, 'compaction', {}], [unsupported, 'reasoning', { scope: parent }],
  ]) rejectsState(() => rebind(f.adapter, token, kind, options));
  const otherSecret = fixture({ stateSecret: 'another-source-secret-without-live-credentials-at-all' });
  rejectsState(() => rebind(otherSecret.adapter, value, 'reasoning'));
  assert.equal(f.calls.length, 1); assert.equal(otherSecret.calls.length, 0);
  const denied = await f.request({ ...base, input: [...base.input, ...first.output, { role: 'user', content: 'Raw old token must not be opened by legacyScopes.' }] },
    { scope: snapshot, legacyScopes: [parent] });
  assert.equal(denied.status, 409); assert.equal(f.calls.length, 1);
});

async function observedTool(f, streaming = false) {
  f.control.respond = body => message([{ type: 'tool_use', id: 'observed_call', name: body.tools[0].name,
    input: { path: 'fixture.txt' }, caller: { type: 'direct' } }], 'tool_use');
  const body = { ...base, stream: streaming, tools: [tool] };
  const first = await read(await f.request(body), streaming);
  return { body, first, history: [...base.input, ...first.output,
    { type: 'function_call_output', call_id: 'observed_call', output: 'REAL_CLIENT_TOOL_RESULT' }] };
}
for (const streaming of [false, true]) test(`${streaming ? 'SSE' : 'JSON'} verified legacy scopes migrate only exact observed direct-caller annotations`, async () => {
  const f = fixture({ streaming }), observed = await observedTool(f, streaming);
  f.control.respond = () => message([{ type: 'text', text: 'Client result read.' }]);
  const send = (scope, legacyScopes, input = observed.history, chosenModel = model) => f.request({ ...observed.body, model: chosenModel, input },
    { scope, legacyScopes, session: `live-${scope}` });
  const tampered = structuredClone(observed.history);
  tampered.find(item => item.type === 'function_call').arguments = '{"path":"changed.txt"}';
  const denied = await send(snapshot, [parent], tampered); assert.equal(denied.status, 409); assert.equal(f.calls.length, 1);
  const child = await read(await send(snapshot, [parent, parent]), streaming); assert.equal(child.status, 'completed');
  const childTool = f.calls[1].body.messages.find(item => item.role === 'assistant').content[0];
  assert.deepEqual(childTool.caller, { type: 'direct' }); assert.equal(childTool.id, 'observed_call');
  assert.deepEqual(childTool.input, { path: 'fixture.txt' });
  await read(await send(snapshot, []), streaming);
  assert.deepEqual(f.calls[2].body.messages.find(item => item.role === 'assistant').content[0].caller, { type: 'direct' });
  await read(await send(parent, []), streaming);
  assert.deepEqual(f.calls[3].body.messages.find(item => item.role === 'assistant').content[0].caller, { type: 'direct' });
  await read(await send(unrelated, []), streaming);
  assert.equal(f.calls[4].body.messages.find(item => item.role === 'assistant').content[0].caller, undefined);
  await read(await send(unrelated, [parent], observed.history, 'Claude-sonnet'), streaming);
  assert.equal(f.calls[5].body.messages.find(item => item.role === 'assistant').content[0].caller, undefined);
  assert.ok(f.calls.every(call => !Object.hasOwn(call, 'legacyScopes') && !Object.hasOwn(call.body, 'legacyScopes')));
});

test('migrating a direct-caller annotation never extends its original expiry or accepts invalid legacy scope selectors', async t => {
  let now = 1_790_000_000_000; t.mock.method(Date, 'now', () => now);
  const f = fixture(), observed = await observedTool(f);
  f.control.respond = () => message([{ type: 'text', text: 'Complete.' }]);
  now += 5 * 60 * 60 * 1000;
  await read(await f.request({ ...observed.body, input: observed.history }, { scope: snapshot, legacyScopes: [parent] }));
  now += 60 * 60 * 1000 + 1;
  const expired = await f.request({ ...observed.body, input: observed.history }, { scope: snapshot });
  assert.equal(expired.status, 409); assert.equal(f.calls.length, 2);
  for (const legacyScopes of [null, 'not-an-array', [null], ['invalid-scope']]) {
    const invalid = await f.request(base, { scope: snapshot, legacyScopes });
    assert.equal(invalid.status, 409); assert.equal(f.calls.length, 2);
  }
});

async function remoteFixture({ stateSecret = secret } = {}) {
  const calls = [], control = { response: body => message([{ type: 'text', text: `Reply for ${body.model}.` }]) };
  const remote = new BifrostRemote({ id: 'fixture', baseUrl: 'https://bifrost.invalid/v1', apiKey: 'bfk_' + 'a'.repeat(43),
    protocols: ['messages', 'responses', 'chat-completions'], stateSecret, fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [
        { id: model, protocols: ['messages'] }, { id: 'native-response', protocols: ['responses', 'messages'] },
        { id: 'chat-only', protocols: ['chat-completions'] }, { id: 'disabled-model', protocols: ['messages'], available: false },
      ] });
      const body = JSON.parse(options.body); calls.push({ url: String(url), body, headers: structuredClone(options.headers) });
      return Response.json(control.response(body));
    } });
  await remote.refreshCatalog(); return { remote, calls, control };
}

test('remote snapshot support is limited to available locally adapted Messages models and stops after source close', async () => {
  const f = await remoteFixture();
  // Explicitly omit stateSecret rather than using the fixture's default.
  const raw = new BifrostRemote({ baseUrl: 'https://bifrost.invalid/v1', apiKey: 'bfk_' + 'b'.repeat(43), protocols: ['messages'],
    fetchImpl: async () => Response.json({ data: [{ id: model, protocols: ['messages'] }] }) });
  await raw.refreshCatalog();
  assert.equal(f.remote.supportsSnapshotState(model), true);
  for (const [id, protocol] of [[model, 'messages'], ['native-response', 'responses'], ['chat-only', 'responses'],
    ['disabled-model', 'responses'], ['missing-model', 'responses']]) {
    assert.equal(f.remote.supportsSnapshotState(id, protocol), false);
  }
  assert.equal(raw.supportsSnapshotState(model), false);
  rejectsState(() => f.remote.rebindSnapshotState('PRIVATE_RAW_STATE', { fromScope: parent, scope: snapshot, model: 'native-response', kind: 'reasoning' }));
  assert.equal(f.calls.length, 0);
  await f.remote.close(); assert.equal(f.remote.supportsSnapshotState(model), false);
  await raw.close();
});

test('remote requests delegate inner rebinding and verified annotation migration without forwarding scope selectors on the network', async () => {
  const f = await remoteFixture();
  f.control.response = body => message([{ type: 'thinking', thinking: 'Observed state.', signature: 'PRIVATE_SIGNATURE' },
    { type: 'tool_use', id: 'observed_call', name: body.tools[0].name, input: { path: 'fixture.txt' }, caller: { type: 'direct' } }], 'tool_use');
  const body = { ...base, tools: [tool] };
  const first = await read(await f.remote.request('responses', { body, scope: parent, session: 'parent-live-session' }));
  const state = first.output.find(item => item.type === 'reasoning');
  const moved = f.remote.rebindSnapshotState(state.encrypted_content, { fromScope: parent, scope: snapshot, model, kind: 'reasoning' });
  f.control.response = () => message([{ type: 'text', text: 'Child finished.' }]);
  await read(await f.remote.request('responses', { body: { ...body, input: [...base.input,
    ...first.output.map(item => item === state ? { ...item, encrypted_content: moved } : item),
    { type: 'function_call_output', call_id: 'observed_call', output: 'OBSERVED_RESULT' }] },
    scope: snapshot, session: 'child-live-session', legacyScopes: [parent] }));
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].headers['x-session-id'], 'parent-live-session');
  assert.equal(f.calls[1].headers['x-session-id'], 'child-live-session');
  const assistant = f.calls[1].body.messages.find(row => row.role === 'assistant');
  assert.equal(assistant.content.find(block => block.type === 'thinking').signature, 'PRIVATE_SIGNATURE');
  assert.deepEqual(assistant.content.find(block => block.type === 'tool_use').caller, { type: 'direct' });
  assert.ok(f.calls.every(call => !Object.hasOwn(call.body, 'legacyScopes') && !Object.hasOwn(call.headers, 'legacyScopes')));
  f.control.response = body => ({ object: 'response', model: body.model,
    output: [{ type: 'reasoning', encrypted_content: 'RAW_SOURCE_OWNED_STATE' }] });
  const raw = await f.remote.request('responses', { body: { model: 'native-response', input: 'Native opaque state remains source-owned.' },
    scope: snapshot, session: 'independent-native-session', legacyScopes: [parent] });
  assert.equal(raw.status, 200); assert.equal((await raw.json()).output[0].encrypted_content, 'RAW_SOURCE_OWNED_STATE');
  assert.equal(f.calls[2].url, 'https://bifrost.invalid/v1/responses');
  assert.equal(Object.hasOwn(f.calls[2].body, 'legacyScopes'), false);
  await f.remote.close();
});
