import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CodeBuddyThinkingState, CODEBUDDY_STATE_PREFIX, CODEBUDDY_COMPACTION_STATE_PREFIX,
  ThinkingStateError } from '../src/codebuddy-thinking-state.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';

const prefix = 'bifrost-codebuddy-compaction-v1:';
const summary = 'PRIVATE_COMPACTION_SUMMARY\nUser goal: keep the fixture changes.\nExact paths and pending steps stay in context.🙂';
const payload = { summary, identity: 'employee-compaction-fixture', model: 'opus-compaction-fixture' };
const scope = '3409e1a0-23b9-4bc9-a3ba-774646d58088';
const otherScope = '3409e1a0-23b9-4bc9-a3ba-774646d58089';
const safeStateError = error => error instanceof ThinkingStateError && error.status === 400
  && !/PRIVATE_|employee-compaction-fixture|bifrost-codebuddy-compaction-v1:/.test(String(error));
const packetFor = (key, raw, aad = prefix) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(raw), cipher.final()]);
  return prefix + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
};

test('compaction uses opaque randomized AES-GCM state with its own authenticated purpose and persisted key', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const value = { ...payload, client_scope: scope }, first = state.sealCompaction(value), second = state.sealCompaction(value);
  assert.equal(CODEBUDDY_COMPACTION_STATE_PREFIX, prefix);
  assert.ok(first.startsWith(prefix)); assert.notEqual(first, second);
  assert.doesNotMatch(first, /PRIVATE_|employee-compaction-fixture|User goal/);
  assert.deepEqual(state.openCompaction(first), value);
  assert.deepEqual(new CodeBuddyThinkingState({ key }).openCompaction(second), value);
  const packet = Buffer.from(first.slice(prefix.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(prefix)); decipher.setAuthTag(packet.subarray(12, 28));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(packet.subarray(28)), decipher.final()]).toString()), value);
});

test('thinking and compaction cannot be relabelled or replayed under the other authenticated purpose', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const thinking = state.seal({ reasoning: 'PRIVATE_REASONING', identity: payload.identity, model: payload.model });
  const compact = state.sealCompaction(payload);
  assert.throws(() => state.openCompaction(thinking), safeStateError);
  assert.throws(() => state.openCompaction(prefix + thinking.slice(CODEBUDDY_STATE_PREFIX.length)), safeStateError);
  for (const signature of [compact, CODEBUDDY_STATE_PREFIX + compact.slice(prefix.length)]) {
    assert.throws(() => state.open({ type: 'thinking', thinking: '', signature }), safeStateError);
  }
  assert.throws(() => state.openCompaction(packetFor(key, Buffer.from(JSON.stringify(payload)), CODEBUDDY_STATE_PREFIX)), safeStateError);
});

test('compaction rejects tampering, wrong keys, noncanonical base64 and oversized packets before publishing any payload', () => {
  const state = new CodeBuddyThinkingState(), token = state.sealCompaction(payload);
  const packet = Buffer.from(token.slice(prefix.length), 'base64url');
  for (const index of [0, 11, 12, 27, 28, packet.length - 1]) {
    const changed = Buffer.from(packet); changed[index] ^= 1;
    assert.throws(() => state.openCompaction(prefix + changed.toString('base64url')), safeStateError);
  }
  assert.throws(() => new CodeBuddyThinkingState().openCompaction(token), safeStateError);
  for (const candidate of [null, {}, [token], token + '=', token + '\n', prefix, prefix + 'a',
    prefix + 'a'.repeat(Math.ceil((32 * 1024 * 1024 + 28) * 4 / 3) + 1)]) {
    assert.throws(() => state.openCompaction(candidate), safeStateError);
  }
});

test('compaction payload is exact, nonempty and bounded including JSON escapes and authenticated fields', () => {
  const state = new CodeBuddyThinkingState();
  for (const value of [null, [], { ...payload, summary: '' }, { ...payload, summary: ' \r\n' },
    { ...payload, summary: null }, { ...payload, reasoning: 'PRIVATE_REASONING' },
    { summary, identity: payload.identity }, { ...payload, identity: '' }, { ...payload, model: ' bad ' },
    { ...payload, client_scope: null }, { ...payload, client_scope: undefined },
    { ...payload, client_scope: '\nPRIVATE_SCOPE' }, { ...payload, summary: 'x'.repeat(32 * 1024 * 1024 + 1) },
    { ...payload, summary: '\0'.repeat(6 * 1024 * 1024) }]) {
    assert.throws(() => state.sealCompaction(value), safeStateError);
  }
  let calls = 0;
  const sideEffect = () => { calls++; throw new Error('PRIVATE_GETTER'); };
  const proxy = new Proxy({}, { get: sideEffect, ownKeys: sideEffect, getOwnPropertyDescriptor: sideEffect, getPrototypeOf: sideEffect });
  for (const value of [proxy, Object.defineProperty({ ...payload }, 'summary', { get: sideEffect, enumerable: true }),
    { ...payload, toJSON: sideEffect }]) assert.throws(() => state.sealCompaction(value), safeStateError);
  assert.equal(calls, 0);
});

test('authenticated compaction packets still require the summary schema and valid UTF-8', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  for (const bytes of [Buffer.from('PRIVATE_NOT_JSON'), Buffer.from([0xff]),
    Buffer.from(JSON.stringify({ reasoning: 'PRIVATE_REASONING', identity: payload.identity, model: payload.model })),
    Buffer.from(JSON.stringify({ ...payload, extra: true })), Buffer.from(JSON.stringify({ ...payload, summary: '' }))]) {
    assert.throws(() => state.openCompaction(packetFor(key, bytes)), safeStateError);
  }
});

const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const upstream = chunks => new Response(chunks.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const answer = (value = summary, finish = 'stop') => upstream([chunk({ role: 'assistant', content: value }), chunk({}, finish),
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }, '[DONE]']);
const body = { model: CODEBUDDY_MODEL.id, max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'Summarize the fixture.' }] };
const internalBlock = encrypted_content => ({ type: 'bifrost_compaction', encrypted_content });
const labelled = value => `[Bifrost conversation summary]\n${value}\n[/Bifrost conversation summary]`;
const tool = { name: 'fixture_echo', input_schema: { type: 'object', properties: {} } };

function fixture(key = randomBytes(32)) {
  const codec = new CodeBuddyThinkingState({ key });
  const client = { reads: 0, statuses: 0, calls: [], identity: payload.identity, authenticated: true,
    models: [{ id: payload.model, name: 'Claude Opus 5.5', supportsToolCall: true }],
    respond: () => answer(),
    async status() { this.statuses++; return { authenticated: this.authenticated, identity: { uid: this.identity } }; },
    async modelCatalog() { this.reads++; return this.models; },
    async chatCompletions(options) { this.calls.push(options); return this.respond(options); } };
  const provider = new CodeBuddyProvider({ client, loadThinkingState: () => codec });
  const request = (input = body, clientScope = null, signal) => provider.request({ path: '/v1/messages', body: input, clientScope, signal });
  return { codec, client, provider, request, key };
}

test('only complete actual text can be sealed, bound to actual account, upstream model and client scope', async () => {
  const { codec, client, request } = fixture();
  client.respond = () => upstream([chunk({ content: summary.slice(0, 20) }), chunk({ reasoning_content: 'PRIVATE_THINKING' }),
    chunk({ content: summary.slice(20) }), chunk({}, 'stop'), '[DONE]']);
  const response = await request(body, scope);
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.stop_reason, 'end_turn'); assert.equal(typeof response.bridgeSealCompaction, 'function');
  client.models[0].id = 'later-catalog-replacement';
  const token = response.bridgeSealCompaction(summary);
  assert.deepEqual(codec.openCompaction(token), { ...payload, client_scope: scope });
  assert.equal(client.calls.length, 1, 'Sealing is local cryptography, not another inference.');
  assert.equal(client.calls[0].expectedIdentity, payload.identity);
  assert.throws(() => response.bridgeSealCompaction(summary + 'invented'), error => error.status === 502 && !String(error).includes('PRIVATE_'));
});

test('a restarted provider restores only user-role summary text and never forwards its private marker or token', async () => {
  const key = randomBytes(32), first = fixture(key);
  const response = await first.request(body, scope); await response.json();
  const token = response.bridgeSealCompaction(summary), restarted = fixture(key);
  const next = await restarted.request({ ...body, messages: [
    { role: 'user', content: [internalBlock(token)] }, { role: 'user', content: 'Continue the fixture.' },
  ] }, scope);
  assert.equal(next.status, 200); await next.json();
  assert.deepEqual(restarted.client.calls[0].body.messages, [
    { role: 'user', content: labelled(summary) }, { role: 'user', content: 'Continue the fixture.' },
  ]);
  assert.doesNotMatch(JSON.stringify(restarted.client.calls[0].body), /bifrost_compaction|bifrost-codebuddy-compaction-v1:/);
  assert.equal(restarted.client.calls.length, 1);
});

test('foreign compaction account, actual upstream model and client scope fail before inference', async () => {
  const key = randomBytes(32), first = fixture(key);
  const response = await first.request(body, scope); await response.json();
  const token = response.bridgeSealCompaction(summary);
  for (const mismatch of ['identity', 'model', 'scope', 'unscoped']) {
    const next = fixture(key);
    if (mismatch === 'identity') next.client.identity = 'employee-other';
    if (mismatch === 'model') next.client.models = [{ id: 'opus-other-fixture', name: 'Claude Opus 5.5' }];
    const failed = await next.request({ ...body, messages: [{ role: 'user', content: [internalBlock(token)] }] },
      mismatch === 'scope' ? otherScope : mismatch === 'unscoped' ? null : scope);
    assert.equal(failed.status, 403, mismatch); assert.equal(next.client.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(await failed.json()), /PRIVATE_|employee-compaction-fixture|bifrost-codebuddy-compaction-v1:/);
  }
});

test('compaction may not enter assistant, system, pending-tool or nested tool-result content', async () => {
  const key = randomBytes(32), token = new CodeBuddyThinkingState({ key }).sealCompaction(payload);
  const toolCall = { role: 'assistant', content: [{ type: 'tool_use', id: 'call_fixture', name: tool.name, input: {} }] };
  for (const extra of [
    { messages: [...body.messages, { role: 'assistant', content: [internalBlock(token)] }, { role: 'user', content: 'Continue.' }] },
    { system: [internalBlock(token)] },
    { tools: [tool], messages: [...body.messages, toolCall, { role: 'user', content: [internalBlock(token)] }] },
    { tools: [tool], messages: [...body.messages, toolCall, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: [internalBlock(token)] }] }] },
  ]) {
    const f = fixture(key), response = await f.request({ ...body, ...extra });
    assert.equal(response.status, 400); assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
  }
});

test('invalid or wrong-purpose summary packets fail before authenticated catalog or inference', async () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  for (const token of ['PRIVATE_FORGED_PACKET', state.seal({ reasoning: 'PRIVATE_REASONING', identity: payload.identity, model: payload.model }),
    new CodeBuddyThinkingState().sealCompaction(payload)]) {
    const f = fixture(key), response = await f.request({ ...body, messages: [{ role: 'user', content: [internalBlock(token)] }] });
    assert.equal(response.status, 400); assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_|bifrost-codebuddy-compaction-v1:/);
  }
});

test('unfinished, truncated, tool-call and failed responses cannot seal a successful summary', async () => {
  const streaming = fixture(), unread = await streaming.request({ ...body, stream: true });
  assert.throws(() => unread.bridgeSealCompaction(summary), error => error.status === 502);
  await unread.text(); assert.ok(unread.bridgeSealCompaction(summary).startsWith(prefix));
  const truncated = fixture(); truncated.client.respond = () => answer(summary, 'length');
  const limited = await truncated.request(); await limited.json();
  assert.throws(() => limited.bridgeSealCompaction(summary), error => error.status === 502);
  const toolRun = fixture(); toolRun.client.respond = () => upstream([chunk({ content: summary, tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
    function: { name: tool.name, arguments: '{}' } }] }), chunk({}, 'tool_calls'), '[DONE]']);
  const tools = await toolRun.request({ ...body, tools: [tool] }); await tools.json();
  assert.throws(() => tools.bridgeSealCompaction(summary), error => error.status === 502);
  const failed = fixture(); failed.client.respond = () => new Response('PRIVATE_UPSTREAM_FAILURE', { status: 503 });
  assert.equal((await failed.request()).bridgeSealCompaction, undefined);
});

test('handoff opens only readable summary for the current account and scope, without target-model lookup or inference', async () => {
  const key = randomBytes(32), f = fixture(key), token = f.codec.sealCompaction({ ...payload, client_scope: scope });
  f.client.models = [{ id: 'some-other-target-model', name: 'Other model' }];
  assert.equal(await f.provider.openCompactionForHandoff(token, { clientScope: scope }), summary);
  assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
  assert.equal(f.client.statuses, 1);
  for (const clientScope of [null, otherScope]) {
    await assert.rejects(f.provider.openCompactionForHandoff(token, { clientScope }), error => error.status === 403);
  }
  f.client.identity = 'employee-other';
  await assert.rejects(f.provider.openCompactionForHandoff(token, { clientScope: scope }), error => error.status === 403);
  f.client.authenticated = false;
  await assert.rejects(f.provider.openCompactionForHandoff(token, { clientScope: scope }), error => error.status === 401);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.provider.openCompactionForHandoff(token, { clientScope: scope, signal: abort.signal }), error => error.status === 499);
  assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
});

test('handoff cannot expose hidden reasoning, wrong-key state or foreign unscoped state', async () => {
  const f = fixture(), thinking = f.codec.seal({ reasoning: 'PRIVATE_REASONING', identity: payload.identity, model: payload.model });
  for (const token of [thinking, new CodeBuddyThinkingState().sealCompaction(payload), 'PRIVATE_FORGED_PACKET']) {
    await assert.rejects(f.provider.openCompactionForHandoff(token), safeStateError);
  }
  const unscoped = f.codec.sealCompaction(payload);
  await assert.rejects(f.provider.openCompactionForHandoff(unscoped, { clientScope: scope }), error => error.status === 403);
  assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
});

const nativeThinking = signature => ({ type: 'thinking', thinking: '', signature });
const thinkingFor = (codec, model = payload.model, extra = {}) => nativeThinking(codec.seal({
  reasoning: 'PRIVATE_CONTINUATION_REASONING', extra_fields: { private: 'PRIVATE_CONTINUATION_METADATA' },
  identity: payload.identity, model, ...extra,
}));

test('continuation comparison returns only booleans for actual target models and performs no inference', async () => {
  const f = fixture();
  f.client.models.push({ id: 'other-fixture-model', name: 'Other fixture model', supportsToolCall: true });
  const blocks = [thinkingFor(f.codec, payload.model, { client_scope: scope }),
    thinkingFor(f.codec, 'other-fixture-model', { client_scope: scope })];
  assert.deepEqual(await f.provider.continuationModelMatches(blocks, CODEBUDDY_MODEL.id, { clientScope: scope }), [true, false]);
  assert.equal(f.client.statuses, 1); assert.equal(f.client.reads, 1);
  assert.deepEqual(await f.provider.continuationModelMatches(blocks, 'CodeBuddy-other-fixture-model', { clientScope: scope }), [false, true]);
  assert.equal(f.client.statuses, 2); assert.equal(f.client.reads, 1, 'The second metadata call can use the account catalog cache.');
  assert.equal(f.client.calls.length, 0);
  const untouched = fixture();
  assert.deepEqual(await untouched.provider.continuationModelMatches([], CODEBUDDY_MODEL.id), []);
  assert.equal(untouched.client.statuses, 0); assert.equal(untouched.client.reads, 0);
});

test('continuation comparison must authorize every state before allowing a model mismatch to be discarded', async () => {
  for (const mismatch of ['identity', 'scope', 'scoped-to-unscoped', 'unscoped-to-scoped']) {
    const f = fixture(), extra = mismatch === 'identity' ? { identity: 'employee-other' }
      : mismatch === 'unscoped-to-scoped' ? {} : { client_scope: mismatch === 'scope' ? otherScope : scope };
    const clientScope = mismatch === 'scope' || mismatch === 'unscoped-to-scoped' ? scope : null;
    const validExtra = clientScope === null ? {} : { client_scope: clientScope };
    const blocks = [thinkingFor(f.codec, payload.model, validExtra), thinkingFor(f.codec, 'some-previous-model', extra)];
    await assert.rejects(f.provider.continuationModelMatches(blocks, CODEBUDDY_MODEL.id, { clientScope }), error =>
      error.status === 403 && !/PRIVATE_|employee-compaction-fixture/.test(String(error)));
    assert.equal(f.client.calls.length, 0);
  }
});

test('malformed or wrong-purpose continuation blocks fail before authenticated model metadata is accessed', async () => {
  const f = fixture(), compact = f.codec.sealCompaction(payload);
  const valid = thinkingFor(f.codec);
  for (const blocks of [null, {}, [null], new Array(1), [{ ...valid, thinking: 'PRIVATE_EDITED_THINKING' }],
    [{ ...valid, extra: true }], [nativeThinking(compact)],
    [thinkingFor(new CodeBuddyThinkingState(), 'some-previous-model')], [valid, nativeThinking('PRIVATE_FORGED_STATE')]]) {
    await assert.rejects(f.provider.continuationModelMatches(blocks, CODEBUDDY_MODEL.id), error =>
      error.status === 400 && !String(error).includes('PRIVATE_'));
  }
  await assert.rejects(f.provider.continuationModelMatches([valid], 'not-a-codebuddy-model'), error => error.status === 400);
  assert.equal(f.client.statuses, 0); assert.equal(f.client.reads, 0); assert.equal(f.client.calls.length, 0);
});

test('continuation comparison cannot authorize a missing target model, logged-out account or cancelled lookup', async () => {
  const missing = fixture(), block = thinkingFor(missing.codec);
  await assert.rejects(missing.provider.continuationModelMatches([block], 'CodeBuddy-missing-fixture'), error => error.status === 503);
  assert.equal(missing.client.calls.length, 0);
  const loggedOut = fixture(); loggedOut.client.authenticated = false;
  await assert.rejects(loggedOut.provider.continuationModelMatches([thinkingFor(loggedOut.codec)], CODEBUDDY_MODEL.id), error => error.status === 401);
  const cancelled = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(cancelled.provider.continuationModelMatches([thinkingFor(cancelled.codec)], CODEBUDDY_MODEL.id, { signal: abort.signal }), error => error.status === 499);
  assert.equal(cancelled.client.statuses, 0);
  const duringLookup = fixture(), pendingAbort = new AbortController();
  duringLookup.client.status = async () => { pendingAbort.abort(); return { authenticated: true, identity: { uid: payload.identity } }; };
  await assert.rejects(duringLookup.provider.continuationModelMatches([thinkingFor(duringLookup.codec)], CODEBUDDY_MODEL.id, { signal: pendingAbort.signal }), error => error.status === 499);
  assert.equal(duringLookup.client.reads, 0); assert.equal(duringLookup.client.calls.length, 0);
});
