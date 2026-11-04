import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { zstdCompressSync } from 'node:zlib';
import { Gateway } from '../src/gateway.mjs';
import { adaptCrossProviderHistory } from '../src/protocols/cross-provider-history.mjs';
import { CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';
import { CODEBUDDY_COMPACTION_STATE_PREFIX } from '../src/codebuddy-thinking-state.mjs';
import { CURSOR_RESPONSES_STATE_PREFIX } from '../src/cursor-responses.mjs';
import { REMOTE_RESPONSES_STATE_PREFIX } from '../src/runtime/server-remotes.mjs';

const privateCodeBuddy = CODEBUDDY_RESPONSES_STATE_PREFIX + 'PRIVATE_CODEBUDDY_TOKEN';
const privateCursor = CURSOR_RESPONSES_STATE_PREFIX + 'PRIVATE_CURSOR_TOKEN';
const privateRemote = REMOTE_RESPONSES_STATE_PREFIX + 'PRIVATE_REMOTE_TOKEN';
const privateOpenAI = 'gAAAA_PRIVATE_OPENAI_TOKEN';
const privateCompaction = CODEBUDDY_COMPACTION_STATE_PREFIX + 'PRIVATE_COMPACTION_TOKEN';
const scope = '035a4873-24ef-46b7-b81f-636a5360b044';
const reasoning = encrypted_content => ({ type: 'reasoning', id: 'rs_private', summary: [], encrypted_content });
const visible = [
  { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Preserve the original permission boundary.' }] },
  { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Keep exact tool results.' }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the fixture.' }] },
  { type: 'message', id: 'msg_cb', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading the fixture.' }] },
  { type: 'function_call', call_id: 'call_fixture', name: 'read_file', arguments: '{"path":"fixture.txt"}', status: 'completed' },
  { type: 'function_call_output', call_id: 'call_fixture', output: 'EXACT_TOOL_OUTPUT\nsecond line' },
  { type: 'custom_tool_call', call_id: 'patch_fixture', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
  { type: 'custom_tool_call_output', call_id: 'patch_fixture', output: 'No files changed.' },
  { type: 'tool_search_call', call_id: 'find_fixture', execution: 'client', arguments: { query: 'fixture tool' } },
  { type: 'tool_search_output', call_id: 'find_fixture', execution: 'client', tools: [] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue using this exact history.' }] },
];
const body = input => ({ model: 'fixture-model', input, instructions: 'Preserve the task.', tools: [], store: false,
  prompt_cache_key: 'original-cache-hint', reasoning: { effort: 'high' } });

for (const target of ['A', 'B']) test(`${target} preserves native OpenAI reasoning and compaction without rewriting the request`, async () => {
  const source = body([visible[0], reasoning(privateOpenAI), { type: 'compaction', encrypted_content: 'gAAAA_NATIVE_COMPACTION' }, ...visible.slice(1)]);
  const before = structuredClone(source);
  const result = await adaptCrossProviderHistory(source, { target });
  assert.equal(result.changed, false); assert.equal(result.body, source); assert.deepEqual(source, before);
});

for (const target of ['A', 'B', 'Cursor', 'Bifrost']) test(`CodeBuddy visible tool history can pass to ${target} without its private continuation`, async () => {
  const source = body([...visible.slice(0, 3), reasoning(privateCodeBuddy), ...visible.slice(3)]);
  const before = structuredClone(source);
  const result = await adaptCrossProviderHistory(source, { target });
  assert.equal(result.changed, true); assert.notEqual(result.body, source);
  assert.deepEqual(result.body, { ...source, input: visible });
  assert.deepEqual(source, before);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_CODEBUDDY_TOKEN/);
});

test('CodeBuddy keeps its own opaque continuation while removing foreign reasoning from a return trip', async () => {
  const source = body([visible[0], reasoning(privateCodeBuddy), visible[1], reasoning(privateOpenAI),
    visible[2], reasoning(privateRemote), ...visible.slice(3)]);
  const checked = [];
  const result = await adaptCrossProviderHistory(source, { target: 'CodeBuddy', session: 'fixture-session', clientScope: scope,
    inspectRemoteState: async (token, options) => {
      checked.push({ token, options });
      assert.equal(token, privateRemote); assert.equal(options.clientScope, scope); assert.equal(options.session, 'fixture-session');
      return { model: 'remote/bifrost/old-model', kind: 'reasoning' };
    } });
  assert.deepEqual(result.body.input, [visible[0], reasoning(privateCodeBuddy), ...visible.slice(1)]);
  assert.ok(JSON.stringify(result.body).includes(privateCodeBuddy));
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_OPENAI_TOKEN|PRIVATE_REMOTE_TOKEN/);
  assert.equal(checked.length, 1);
});

test('readable reasoning summaries remain explicit assistant history when the private continuation is omitted', async () => {
  const text = 'Preserve line one.\n  Preserve indentation.\n';
  const original = body([visible[0], { ...reasoning(privateOpenAI), summary: [{ type: 'summary_text', text }] }, ...visible.slice(1)]);
  const result = await adaptCrossProviderHistory(original, { target: 'CodeBuddy' });
  const summary = result.body.input[1];
  assert.equal(summary.type, 'message'); assert.equal(summary.role, 'assistant'); assert.equal(summary.phase, 'commentary');
  assert.equal(summary.content[0].type, 'output_text'); assert.ok(summary.content[0].text.includes(text));
  assert.equal(Object.hasOwn(summary, 'encrypted_content'), false);
  assert.equal(original.input[1].encrypted_content, privateOpenAI);
});

test('malformed or unreadable foreign state is not silently discarded or reflected in an error', async () => {
  for (const extra of [
    { encrypted_content: { token: 'PRIVATE_UNKNOWN' } },
    { summary: 'PRIVATE_UNKNOWN' },
    { summary: [{ type: 'summary_text', text: 'hello', unknown: 'PRIVATE_UNKNOWN' }] },
    { content: [{ type: 'reasoning_text', text: 'PRIVATE_UNKNOWN' }] },
    { encrypted_content: privateCompaction },
    { encrypted_content: 'bifrost-messages-compaction-v1:PRIVATE_COMPACTION_TOKEN' },
    { status: 'in_progress' }, { unknown: 'PRIVATE_UNKNOWN' },
  ]) {
    const source = body([visible[0], { ...reasoning(privateOpenAI), ...extra }, ...visible.slice(1)]);
    const before = structuredClone(source);
    await assert.rejects(adaptCrossProviderHistory(source, { target: 'CodeBuddy' }), error => error.status === 400 && !error.message.includes('PRIVATE_UNKNOWN'));
    assert.deepEqual(source, before);
  }
});

test('OpenAI replay metadata is removed only alongside an explicit complete message or tool payload', async () => {
  const message = { ...visible[3], encrypted_content: 'PRIVATE_MESSAGE_METADATA' };
  const call = { ...visible[4], encrypted_content: 'PRIVATE_CALL_METADATA', encrypted_function_args: ['PRIVATE_ARGUMENT_METADATA'] };
  const source = body([...visible.slice(0, 3), message, call, ...visible.slice(5)]);
  const result = await adaptCrossProviderHistory(source, { target: 'CodeBuddy' });
  assert.deepEqual(result.body.input, visible);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_.*METADATA/);
  assert.equal(message.encrypted_content, 'PRIVATE_MESSAGE_METADATA');
  for (const item of [{ type: 'message', role: 'assistant', content: [], encrypted_content: 'PRIVATE_ONLY_CONTENT' },
    { type: 'function_call', name: 'read_file', call_id: 'one', encrypted_function_args: ['PRIVATE_ONLY_ARGUMENTS'] }]) {
    await assert.rejects(adaptCrossProviderHistory(body([visible[0], item, visible.at(-1)]), { target: 'CodeBuddy' }), { status: 400 });
  }
});

test('a mixed-provider Cursor request cannot accidentally reuse its old live handle', async () => {
  const source = body([visible[0], reasoning(privateCursor), visible[1], reasoning(privateOpenAI), ...visible.slice(2)]);
  const result = await adaptCrossProviderHistory(source, { target: 'Cursor' });
  assert.deepEqual(result.body.input, visible);
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_CURSOR_TOKEN|PRIVATE_OPENAI_TOKEN/);
  assert.deepEqual((await adaptCrossProviderHistory(body([visible[0], reasoning(privateCursor), ...visible.slice(1)]), { target: 'Cursor' })).body.input,
    [visible[0], reasoning(privateCursor), ...visible.slice(1)], 'Unmixed destination state is still validated by its owning adapter.');
});

for (const type of ['compaction', 'context_compaction']) test(`materializing authenticated remote ${type} cannot retain an old Cursor live handle`, async () => {
  const token = REMOTE_RESPONSES_STATE_PREFIX + 'v2.PRIVATE_REMOTE_COMPACTION';
  const checkpoint = { type, id: 'remote_compaction_fixture', encrypted_content: token };
  const source = body([visible[0], reasoning(privateCursor), visible[3], checkpoint, visible.at(-1)]);
  const before = structuredClone(source), checked = [], opened = [];
  const result = await adaptCrossProviderHistory(source, { target: 'Cursor', clientScope: scope, session: 'fixture-session',
    inspectRemoteState: async (value, options) => {
      checked.push({ value, options });
      return { model: 'remote/bifrost/old-model', kind: type };
    },
    openRemoteCompaction: async (value, options) => {
      opened.push({ value, options });
      return 'AUTHENTICATED_REMOTE_TASK_SUMMARY';
    } });
  assert.equal(checked.length, 1); assert.equal(opened.length, 1);
  for (const call of [...checked, ...opened]) {
    assert.equal(call.value, token); assert.equal(call.options.kind, type);
    assert.equal(call.options.clientScope, scope); assert.equal(call.options.session, 'fixture-session');
  }
  assert.deepEqual(result.body.input.slice(0, 2), [visible[0], visible[3]], 'Readable prior messages retain their original roles and order.');
  assert.equal(result.body.input[2].role, 'user'); assert.match(result.body.input[2].content[0].text, /AUTHENTICATED_REMOTE_TASK_SUMMARY/);
  assert.deepEqual(result.body.input.at(-1), visible.at(-1));
  assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_CURSOR_TOKEN|PRIVATE_REMOTE_COMPACTION/);
  assert.deepEqual(source, before, 'The old handle remains in the durable client history, never in this derived request.');
});

test('CodeBuddy compaction stays opaque to its owner and becomes authenticated user summary for another destination', async () => {
  const compact = { type: 'compaction', id: 'cmp_fixture', encrypted_content: privateCompaction };
  const source = body([visible[0], compact, ...visible.slice(1)]), before = structuredClone(source), calls = [];
  const openCodeBuddyCompaction = async (token, options) => { calls.push({ token, options }); return 'EXACT_COMPACTED_TASK\nAll tests pending.'; };
  assert.equal((await adaptCrossProviderHistory(source, { target: 'CodeBuddy', openCodeBuddyCompaction })).changed, false);
  assert.equal(calls.length, 0);
  for (const target of ['A', 'B', 'Cursor', 'Bifrost']) {
    const controller = new AbortController();
    const result = await adaptCrossProviderHistory(source, { target, clientScope: scope, signal: controller.signal, openCodeBuddyCompaction });
    assert.equal(result.changed, true); assert.equal(result.body.input[1].role, 'user');
    assert.equal(result.body.input[1].content[0].text, '[Bifrost conversation summary]\nEXACT_COMPACTED_TASK\nAll tests pending.\n[/Bifrost conversation summary]');
    assert.deepEqual(result.body.input.slice(2), visible.slice(1));
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_COMPACTION_TOKEN/);
    assert.equal(calls.at(-1).token, privateCompaction); assert.equal(calls.at(-1).options.clientScope, scope);
    assert.equal(calls.at(-1).options.signal, controller.signal);
  }
  assert.deepEqual(source, before);
});

test('unknown, unreadable and unauthenticated compaction is never erased to permit a model switch', async () => {
  for (const [target, encrypted_content, status] of [['CodeBuddy', 'gAAAA_PRIVATE_OPENAI_COMPACTION', 400],
    ['Cursor', privateRemote, 409], ['A', 'bifrost-messages-compaction-v1:PRIVATE_REMOTE_SUMMARY', 400],
    ['B', 'bifrost-unknown-compaction-v9:PRIVATE_FUTURE_SUMMARY', 400]]) {
    const source = body([visible[0], { type: 'compaction', encrypted_content }, visible.at(-1)]);
    await assert.rejects(adaptCrossProviderHistory(source, { target }), { status, code: 'history_compaction_unavailable' });
    assert.equal(source.input[1].encrypted_content, encrypted_content);
  }
  await assert.rejects(adaptCrossProviderHistory(body([visible[0], { type: 'compaction', encrypted_content: privateCompaction }]), { target: 'A' }),
    { status: 409, code: 'history_compaction_unavailable' });
  let attempts = 0;
  await assert.rejects(adaptCrossProviderHistory(body([{ type: 'compaction', encrypted_content: privateCompaction }]), {
    target: 'A', openCodeBuddyCompaction: async () => { attempts++; throw Object.assign(new Error('Scoped state rejected.'), { status: 403 }); },
  }), { status: 403 });
  assert.equal(attempts, 1);
});

test('cancellation stops summary handoff before dispatch and never mutates client history', async () => {
  const source = body([{ type: 'compaction', encrypted_content: privateCompaction }, visible.at(-1)]), before = structuredClone(source);
  const controller = new AbortController(); let called = 0;
  await assert.rejects(adaptCrossProviderHistory(source, { target: 'A', signal: controller.signal,
    openCodeBuddyCompaction: async () => { called++; controller.abort(); return 'A valid but cancelled summary.'; } }), { status: 499 });
  assert.equal(called, 1); assert.deepEqual(source, before);
  await assert.rejects(adaptCrossProviderHistory(source, { target: 'A', signal: controller.signal,
    openCodeBuddyCompaction: async () => { called++; return 'Must not run.'; } }), { status: 499 });
  assert.equal(called, 1);
});

test('an opaque-only history remains unusable instead of being forwarded as an empty conversation', async () => {
  for (const [target, encrypted_content, code] of [['A', privateCodeBuddy, 'codebuddy_history_channel_mismatch'],
    ['CodeBuddy', privateCursor, 'cursor_history_channel_mismatch']]) {
    await assert.rejects(adaptCrossProviderHistory(body([reasoning(encrypted_content)]), { target }), { status: 400, code });
  }
});

async function gatewayFixture(t) {
  const key = 'cross-provider-fixture-key', calls = [], opens = [];
  const answer = () => Response.json({ id: 'resp_fixture', status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture completed.' }] },
  ] });
  const provider = { status: async () => ({ ready: true }),
    request: async options => { calls.push({ account: 'CodeBuddy', body: JSON.parse(options.body), headers: options.headers }); return answer(); },
    openCompactionForHandoff: async (token, options) => {
      opens.push({ token, options });
      if (token !== privateCompaction || options.clientScope !== scope) throw Object.assign(new Error('Invalid compaction authorization.'), { status: 403 });
      return 'AUTHENTICATED_TASK_SUMMARY';
    } };
  const gateway = new Gateway({ gatewayKey: key, codeBuddyProvider: provider,
    backend: { credentials: async () => ({ value: 'fixture-b-credential', accountId: 'fixture-b-account' }) },
    getAProvider: async () => ({ config: { base_url: 'https://a.invalid/codex' } }),
    fetchImpl: async (address, options) => { calls.push({ account: address.startsWith('https://a.invalid/') ? 'A' : 'B',
      raw: options.body.toString(), body: JSON.parse(options.body), headers: options.headers }); return answer(); } });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://fixture.invalid')); }
    catch (error) { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: error.code } })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const headers = { 'content-type': 'application/json', 'x-account-bridge-key': key,
    authorization: 'Bearer fixture-a-credential', 'chatgpt-account-id': 'fixture-a-account', 'x-bifrost-client-scope': scope };
  const post = (value, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/responses`, {
    method: 'POST', headers: { ...headers, ...extra.headers }, body: extra.body ?? JSON.stringify(value),
  });
  return { post, calls, opens, gateway };
}

test('gateway switches CodeBuddy history to A/B while preserving visible tools and corrected compression headers', async t => {
  const { post, calls } = await gatewayFixture(t);
  for (const model of ['gpt-6.1-sol', 'B-gpt-6.1-sol']) {
    const original = body([...visible.slice(0, 3), reasoning(privateCodeBuddy), ...visible.slice(3)]); original.model = model;
    const response = await post(original, { body: zstdCompressSync(Buffer.from(JSON.stringify(original))), headers: { 'content-encoding': 'zstd' } });
    assert.equal(response.status, 200); await response.text();
    assert.deepEqual(calls.at(-1).body, { ...original, model: 'gpt-6.1-sol', input: visible });
    assert.equal(calls.at(-1).headers.has('content-encoding'), false);
    assert.doesNotMatch(calls.at(-1).raw, /PRIVATE_CODEBUDDY_TOKEN/);
    assert.equal(calls.at(-1).headers.get('authorization'), model.startsWith('B-') ? 'Bearer fixture-b-credential' : 'Bearer fixture-a-credential');
  }
});

test('gateway supports the CodeBuddy to A to CodeBuddy round trip without changing the persisted client history', async t => {
  const { post, calls } = await gatewayFixture(t);
  const clientHistory = [...visible.slice(0, 3), reasoning(privateCodeBuddy), ...visible.slice(3)];
  const initial = structuredClone(clientHistory);
  const toA = await post({ ...body(clientHistory), model: 'gpt-6.1-sol' }); assert.equal(toA.status, 200); await toA.text();
  assert.deepEqual(calls.at(-1).body.input, visible); assert.deepEqual(clientHistory, initial);
  clientHistory.push(reasoning(privateOpenAI), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A model reply.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Return to CodeBuddy.' }] });
  const toCodeBuddy = await post({ ...body(clientHistory), model: 'claude-codebuddy-opus-5-5' });
  assert.equal(toCodeBuddy.status, 200); await toCodeBuddy.text();
  assert.equal(calls.at(-1).account, 'CodeBuddy');
  assert.ok(calls.at(-1).body.input.some(item => item.encrypted_content === privateCodeBuddy));
  assert.ok(clientHistory.some(item => item.encrypted_content === privateOpenAI));
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /PRIVATE_OPENAI_TOKEN/);
  assert.deepEqual(calls.at(-1).body.input.filter(item => item.type !== 'reasoning'), clientHistory.filter(item => item.type !== 'reasoning'));
});

test('gateway authenticates a CodeBuddy compaction handoff before forwarding its plaintext summary', async t => {
  const { post, calls, opens } = await gatewayFixture(t);
  const source = { ...body([{ type: 'compaction', id: 'cmp_fixture', encrypted_content: privateCompaction }, visible.at(-1)]), model: 'gpt-6.1-sol' };
  const response = await post(source); assert.equal(response.status, 200); await response.text();
  assert.equal(opens.length, 1); assert.equal(opens[0].options.clientScope, scope);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.input[0].role, 'user');
  assert.match(calls[0].body.input[0].content[0].text, /AUTHENTICATED_TASK_SUMMARY/);
  assert.doesNotMatch(calls[0].raw, /PRIVATE_COMPACTION_TOKEN/);
  const tampered = await post({ ...source, input: [{ ...source.input[0], encrypted_content: privateCompaction + 'tampered' }, visible.at(-1)] });
  assert.equal(tampered.status, 403); await tampered.text(); assert.equal(calls.length, 1);
  const unknown = await post({ ...source, input: [{ type: 'compaction', encrypted_content: 'bifrost-messages-compaction-v1:unknown' }, visible.at(-1)] });
  assert.equal(unknown.status, 400); await unknown.text(); assert.equal(calls.length, 1);
});
