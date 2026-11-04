import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeBuddyResponsesProvider, CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyThinkingState, CODEBUDDY_STATE_PREFIX } from '../src/codebuddy-thinking-state.mjs';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';
import { translateResponses, ResponsesConversion, messagesJsonEvents, AdapterError } from '../src/protocols/responses-messages.mjs';
import { ClaudeCliHub } from '../src/claude-cli-provider.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';

const model = CODEBUDDY_MODEL.id;
const scope = '1d8f353b-3799-49d0-b962-debbaf1f788f';
const otherScope = 'eb853eef-88ba-494d-b84c-1504f01d4dce';
const compactionPrefix = 'bifrost-codebuddy-compaction-v1:';
const usage = { prompt_tokens: 60, completion_tokens: 11, total_tokens: 71,
  prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } };
const wireUsage = { input_tokens: 60, output_tokens: 11, total_tokens: 71,
  input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 4 } };
const tool = { type: 'function', name: 'read_fixture', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const base = { model, store: false, input: [{ role: 'user', content: 'Update the fixture and retain the verification result.' }] };
const summary = 'Goal: update the fixture. Verified result: EXACT_LOCAL_TOOL_RESULT. Next: check the remaining change.🙂';
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
function chat(frames) {
  const bytes = Buffer.from(frames.map(frame).join('')); let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(at, at + 17)); at = Math.min(bytes.length, at + 17);
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
const answer = (text, finish = 'stop') => chat([chunk({ role: 'assistant', reasoning_content: 'PRIVATE_COMPACTION_THINKING' }),
  chunk({ content: text }), chunk({}, finish), { choices: [], usage }, '[DONE]']);

function fixture({ extraModels = [] } = {}) {
  const key = Buffer.alloc(32, 81), counts = { seals: 0 };
  class State extends CodeBuddyThinkingState {
    sealCompaction(value) { counts.seals++; return super.sealCompaction(value); }
  }
  const client = {
    identity: 'compaction-fixture-employee', sourceModel: 'employee-opus-55', calls: [],
    status() { return { authenticated: true, identity: { uid: this.identity } }; },
    async modelCatalog() { return [{ id: this.sourceModel, name: 'Claude Opus 5.5', supportsToolCall: true }, ...structuredClone(extraModels)]; },
    respond: () => answer(summary),
    async chatCompletions(request) { this.calls.push(structuredClone(request.body)); return this.respond(request); },
  };
  const native = () => new CodeBuddyProvider({ client, loadThinkingState: () => new State({ key }) });
  const make = () => new CodeBuddyResponsesProvider({ provider: native() });
  const provider = make();
  const request = (body, { chosen = provider, clientScope = scope, signal } = {}) => chosen.request({ path: '/responses',
    body: Buffer.from(JSON.stringify(body)), clientScope, signal,
    headers: new Headers({ authorization: 'Bearer PRIVATE_CALLER_TOKEN', 'chatgpt-account-id': 'PRIVATE_CALLER_ACCOUNT' }) });
  return { client, counts, native, make, provider, request };
}
async function read(response, stream) {
  if (!stream || !response.headers.get('content-type')?.includes('text/event-stream')) {
    const value = await response.json(); return { value, events: [], text: JSON.stringify(value) };
  }
  const text = await response.text();
  const events = text.split(/\r?\n\r?\n/).filter(Boolean).map(raw => JSON.parse(raw.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
  return { value: events.findLast(event => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type))?.response,
    events, text };
}
const inputText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('');
const compactBody = (stream = false) => ({ ...base, stream, input: [...base.input, { type: 'compaction_trigger' }] });
function unitProfile(sealCompaction = value => `unit-summary:${value}`) {
  return { model: 'unit-model', allowedEfforts: ['low', 'medium', 'high'],
    openState: () => { throw new AdapterError('Foreign thinking state.', 400); }, sealState: () => 'unit-thinking-state',
    openCompaction: value => {
      if (value !== 'unit-summary:trusted') throw new AdapterError('Foreign compaction state.', 400, 'input.compaction');
      return [{ type: 'text', text: '[Prior conversation summary]\ntrusted\n[/Prior conversation summary]' }];
    }, sealCompaction };
}
const translate = (body, profile = unitProfile()) => translateResponses({ model: 'unit-model', store: false, ...body }, 'unit-priority', profile);

test('a compaction trigger retains completed tool history and requests one text-only summary without mutating input', () => {
  const input = [{ role: 'developer', content: 'Keep the fixture constraint.' }, { role: 'user', content: 'Update the fixture.' },
    { role: 'assistant', content: 'Reading the current file.' },
    { type: 'function_call', name: tool.name, call_id: 'read_done', arguments: '{"path":"fixture.txt"}' },
    { type: 'function_call_output', call_id: 'read_done', output: 'EXACT_LOCAL_TOOL_RESULT' }, { type: 'compaction_trigger' }];
  const body = { input, tools: [tool], tool_choice: 'auto' }, original = structuredClone(body);
  const request = translate(body);
  assert.equal(request.compaction, true); assert.deepEqual(body, original);
  assert.equal(request.upstream.tools, undefined); assert.equal(request.upstream.tool_choice.type, 'none');
  assert.ok(request.upstream.system.some(part => part.text === 'Keep the fixture constraint.'));
  const assistant = request.upstream.messages.find(message => message.role === 'assistant' && message.content.some(part => part.type === 'tool_use'));
  assert.equal(assistant.content.find(part => part.type === 'tool_use').id, 'read_done');
  assert.equal(request.upstream.messages.find(message => message.content.some(part => part.type === 'tool_result')).content[0].content[0].text,
    'EXACT_LOCAL_TOOL_RESULT');
  const last = request.upstream.messages.at(-1);
  assert.equal(last.role, 'user'); assert.match(inputText(last), /summari/i);
  assert.doesNotMatch(JSON.stringify(request.upstream), /compaction_trigger/);
});

test('malformed, repeated, nonterminal and tool-incomplete compaction controls fail before transport', () => {
  const trigger = { type: 'compaction_trigger' }, user = { role: 'user', content: 'hello' };
  for (const body of [
    { input: [trigger] }, { input: [user, trigger, user] }, { input: [user, trigger, trigger] },
    { input: [user, { ...trigger, payload: 'PRIVATE_CONTROL_PAYLOAD' }] },
    { tools: [tool], input: [user, { type: 'function_call', name: tool.name, call_id: 'pending', arguments: '{}' }, trigger] },
    { tools: [tool], tool_choice: 'required', input: [user, trigger] },
    { tools: [tool], tool_choice: { type: 'function', name: tool.name }, input: [user, trigger] },
  ]) assert.throws(() => translate(body), error => error.status === 400 && !error.message.includes('PRIVATE_CONTROL_PAYLOAD'));
});

test('configuration updates affect the current reasoning control without becoming conversation text', () => {
  const body = { reasoning: { effort: 'medium' }, input: [{ role: 'user', content: 'first' },
    { type: 'configuration_update', reasoning: { effort: 'low' } }, { role: 'assistant', content: 'prior result' },
    { type: 'configuration_update', reasoning: { effort: 'high' } }, { role: 'user', content: 'continue' }] };
  const before = structuredClone(body), request = translate(body);
  assert.equal(request.upstream.output_config.effort, 'high'); assert.deepEqual(body, before);
  assert.doesNotMatch(JSON.stringify(request.upstream.messages), /configuration_update|"effort"/);
  assert.deepEqual(request.upstream.messages.map(message => message.role), ['user', 'assistant', 'user']);
  for (const update of [{}, { reasoning: null }, { reasoning: {} }, { reasoning: { effort: 'unverified' } },
    { reasoning: { effort: 'high', private: 'PRIVATE_CONTROL_PAYLOAD' } }]) {
    assert.throws(() => translate({ input: [{ role: 'user', content: 'hello' }, { type: 'configuration_update', ...update }] }),
      error => error.status === 400 && !error.message.includes('PRIVATE_CONTROL_PAYLOAD'));
  }
});

test('only the actual completed text is sealed and emitted as one canonical compaction item', () => {
  const sealed = [], profile = unitProfile(value => { sealed.push(value); return 'unit-summary:sealed'; });
  const request = translate({ stream: true, input: [{ role: 'user', content: 'history' }, { type: 'compaction_trigger' }] }, profile);
  const conversion = new ResponsesConversion(request, profile), emitted = [];
  const message = { type: 'message', role: 'assistant', model: 'unit-model', stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: 'PRIVATE_SUMMARY_THINKING', signature: 'private-signature' },
    { type: 'text', text: 'First preserved fact.\n' }, { type: 'text', text: 'Second preserved fact.🙂' },
  ] };
  for (const event of messagesJsonEvents(message)) emitted.push(...conversion.accept(event));
  assert.deepEqual(emitted.map(event => event.type), ['response.created', 'response.in_progress']); assert.deepEqual(sealed, []);
  emitted.push(...conversion.finishEvents(wireUsage));
  assert.deepEqual(emitted.map(event => event.type), ['response.created', 'response.in_progress',
    'response.output_item.added', 'response.output_item.done', 'response.completed']);
  assert.deepEqual(emitted.map(event => event.sequence_number), emitted.map((_, index) => index));
  assert.deepEqual(sealed, ['First preserved fact.\nSecond preserved fact.🙂']);
  const final = emitted.at(-1).response;
  assert.equal(final.output.length, 1); assert.equal(final.output[0].type, 'compaction');
  assert.equal(final.output[0].encrypted_content, 'unit-summary:sealed'); assert.deepEqual(final.usage, wireUsage);
  assert.deepEqual(emitted.find(event => event.type === 'response.output_item.done').item, final.output[0]);
  assert.doesNotMatch(JSON.stringify(emitted), /PRIVATE_SUMMARY_THINKING|First preserved fact|Second preserved fact/);
});

for (const stream of [false, true]) test(`CodeBuddy ${stream ? 'SSE' : 'JSON'} compacts a completed tool round and resumes after restart without extra inference`, async () => {
  const f = fixture();
  f.client.respond = ({ body }) => chat([chunk({ role: 'assistant', reasoning_content: 'PRIVATE_TOOL_THINKING' }),
    chunk({ tool_calls: [{ index: 0, id: 'compaction_tool_read', type: 'function', function: { name: body.tools[0].function.name,
      arguments: '{"path":"fixture.txt"}' } }] }), chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]']);
  const firstResponse = await f.request({ ...base, stream, tools: [tool] }); assert.equal(firstResponse.status, 200);
  const first = await read(firstResponse, stream), call = first.value.output.find(item => item.type === 'function_call');
  assert.equal(call.name, tool.name); assert.equal(f.client.calls.length, 1);
  f.client.respond = () => answer(summary);
  const body = { ...base, stream, tools: [tool], input: [...base.input, ...first.value.output,
    { type: 'function_call_output', call_id: call.call_id, output: 'EXACT_LOCAL_TOOL_RESULT' }, { type: 'compaction_trigger' }] };
  const before = structuredClone(body), compactResponse = await f.request(body); assert.equal(compactResponse.status, 200);
  const compact = await read(compactResponse, stream); assert.deepEqual(body, before);
  assert.equal(compact.value.status, 'completed'); assert.equal(compact.value.output.length, 1);
  const item = compact.value.output[0]; assert.equal(item.type, 'compaction'); assert.ok(item.encrypted_content.startsWith(compactionPrefix));
  assert.doesNotMatch(compact.text, /EXACT_LOCAL_TOOL_RESULT|PRIVATE_(?:TOOL|COMPACTION)_THINKING/);
  assert.equal(f.counts.seals, 1); assert.equal(f.client.calls.length, 2);
  assert.equal(f.client.calls[1].tools, undefined); assert.equal(f.client.calls[1].tool_choice, 'none');
  assert.ok(f.client.calls[1].messages.some(message => message.role === 'tool' && message.content === 'EXACT_LOCAL_TOOL_RESULT'));
  assert.deepEqual(compact.value.usage, wireUsage); assert.equal((await compactResponse.bridgeUsage).total_tokens, usage.total_tokens);
  if (stream) {
    assert.deepEqual(compact.events.map(event => event.sequence_number), compact.events.map((_, index) => index));
    assert.deepEqual(compact.events.find(event => event.type === 'response.output_item.done').item, item);
    assert.ok(compact.events.every(event => !['response.output_text.delta', 'response.function_call_arguments.delta'].includes(event.type)));
  }
  f.client.respond = () => answer('CONTINUED_FROM_SUMMARY');
  const resumedResponse = await f.request({ ...base, stream, input: [item, { role: 'user', content: 'Continue the remaining change.' }] }, { chosen: f.make() });
  assert.equal(resumedResponse.status, 200); const resumed = await read(resumedResponse, stream);
  assert.equal(resumed.value.output.find(item => item.type === 'message').content[0].text, 'CONTINUED_FROM_SUMMARY');
  assert.equal(f.client.calls.length, 3); assert.equal(f.counts.seals, 1);
  const incomingSummary = f.client.calls[2].messages.find(message => inputText(message).includes(summary));
  assert.equal(incomingSummary?.role, 'user'); assert.equal(inputText(incomingSummary).split(summary).length - 1, 1);
  assert.doesNotMatch(JSON.stringify(f.client.calls[2]), /bifrost_compaction|bifrost-codebuddy-compaction-v1|PRIVATE_CALLER_(?:TOKEN|ACCOUNT)|PRIVATE_TOOL_THINKING/);
});

test('foreign, tampered and differently scoped CodeBuddy compaction packets cannot trigger inference or expose their plaintext', async () => {
  const f = fixture(), first = await read(await f.request(compactBody()), false), token = first.value.output[0].encrypted_content;
  const tampered = token.slice(0, compactionPrefix.length) + (token[compactionPrefix.length] === 'A' ? 'B' : 'A') + token.slice(compactionPrefix.length + 1);
  for (const [encrypted_content, clientScope, identity] of [
    ['gAAAA_PRIVATE_OPENAI_COMPACTION', scope, f.client.identity], [tampered, scope, f.client.identity],
    [token, otherScope, f.client.identity], [token, scope, 'different-employee'],
  ]) {
    f.client.identity = identity;
    const response = await f.request({ ...base, input: [{ type: 'compaction', encrypted_content }, { role: 'user', content: 'continue' }] }, { clientScope, chosen: f.make() });
    assert.ok(response.status >= 400); const text = await response.text();
    assert.equal(text.includes(summary), false); assert.equal(text.includes(encrypted_content), false);
    assert.equal(f.client.calls.length, 1);
  }
});

test('a compaction packet remains bound to its actual CodeBuddy model at the native Messages boundary', async () => {
  const f = fixture(), compact = await read(await f.request(compactBody()), false), token = compact.value.output[0].encrypted_content;
  f.client.sourceModel = 'different-employee-model';
  const response = await f.native().request({ path: '/v1/messages', clientScope: scope, body: {
    model, max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'bifrost_compaction', encrypted_content: token }, { type: 'text', text: 'Continue.' }] }],
  } });
  assert.equal(response.status, 403); assert.equal(f.client.calls.length, 1); assert.equal((await response.text()).includes(summary), false);
});

for (const stream of [false, true]) for (const failure of ['length', 'blank', 'tool', 'missing-end']) {
  test(`CodeBuddy ${stream ? 'SSE' : 'JSON'} never seals ${failure} summarization output`, async () => {
    const f = fixture();
    f.client.respond = () => failure === 'length' ? answer('PARTIAL_SUMMARY', 'length') : failure === 'blank' ? answer(' \n\t')
      : failure === 'tool' ? chat([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'forbidden_summary_tool', type: 'function',
        function: { name: 'undeclared_tool', arguments: '{}' } }] }), chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]'])
        : chat([chunk({ role: 'assistant', content: 'PARTIAL_SUMMARY' })]);
    const response = await f.request(compactBody(stream)), result = await read(response, stream);
    assert.ok(response.status >= 400 || result.value?.status === 'failed'); assert.equal(f.counts.seals, 0); assert.equal(f.client.calls.length, 1);
    assert.equal(result.text.includes(compactionPrefix), false); assert.equal(result.text.includes('PARTIAL_SUMMARY'), false);
    assert.equal(result.events.some(event => event.type === 'response.completed'), false);
  });
}

test('cancelling an in-flight summary never publishes a compaction checkpoint', async () => {
  const f = fixture(), abort = new AbortController(); let cancelled = false;
  f.client.respond = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(frame(chunk({ role: 'assistant', content: 'UNFINISHED_SUMMARY' })))); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await f.request(compactBody(true), { signal: abort.signal }), reading = read(response, true);
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  const result = await reading;
  assert.equal(f.counts.seals, 0); assert.equal(f.client.calls.length, 1); assert.equal(cancelled, true);
  assert.equal(result.events.some(event => event.type === 'response.completed'), false);
  assert.doesNotMatch(result.text, /bifrost-codebuddy-compaction-v1|UNFINISHED_SUMMARY/);
});

test('generic Messages compaction uses the same protocol and preserves a scoped summary across adapter restart', async () => {
  const calls = [], secret = 'generic-compaction-fixed-test-secret-that-is-not-a-credential';
  const make = () => new MessagesResponsesAdapter({ stateSecret: secret, requestMessages: async value => {
    calls.push(structuredClone(value.body));
    return Response.json({ type: 'message', role: 'assistant', model: 'unit-model', stop_reason: 'end_turn',
      content: [{ type: 'text', text: summary }], usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 } });
  } });
  const body = { model: 'unit-model', store: false, input: [{ role: 'user', content: 'history' }, { type: 'compaction_trigger' }] };
  const first = await make().request({ body, scope }); assert.equal(first.status, 200);
  const checkpoint = (await first.json()).output[0]; assert.equal(checkpoint.type, 'compaction');
  assert.equal(calls.length, 1); assert.equal(calls[0].tools, undefined); assert.equal(calls[0].tool_choice.type, 'none');
  const follow = { model: 'unit-model', store: false, input: [checkpoint, { role: 'user', content: 'continue' }] };
  const second = await make().request({ body: follow, scope }); assert.equal(second.status, 200); await second.body.cancel();
  assert.ok(calls[1].messages.some(message => message.role === 'user' && inputText(message).includes(summary)));
  for (const [nextScope, nextModel] of [[otherScope, 'unit-model'], [scope, 'different-model']]) {
    const denied = await make().request({ body: { ...follow, model: nextModel }, scope: nextScope });
    assert.equal(denied.status, 409); assert.equal((await denied.text()).includes(summary), false);
  }
  assert.equal(calls.length, 2);
});

for (const stream of [false, true]) test(`remote Claude CLI ${stream ? 'SSE' : 'JSON'} accepts a tool-free compaction and restores its summary after adapter restart`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'remote-cli-compaction-'));
  const workers = [], remotes = [], calls = [], remoteModel = 'unit-opus-model';
  const hub = new ClaudeCliHub({ binary: join(root, 'not-a-real-cli'), configDir: join(root, 'config'),
    profileDir: join(root, 'profile'), stateDir: join(root, 'state'), mcpPort: 0, authStatus: async () => true,
    workerFactory: options => {
      let controller, closed = false;
      const events = new ReadableStream({ start(value) { controller = value; } });
      const worker = { options, events, sessionId: randomUUID(), sends: [], async start() {},
        async send(value) {
          this.sends.push(structuredClone(value));
          const text = workers.indexOf(this) === 0 ? summary : 'CONTINUED_FROM_CLI_SUMMARY';
          const message = { id: 'msg-cli-summary-fixture', type: 'message', role: 'assistant', model: remoteModel,
            stop_reason: 'end_turn', content: [{ type: 'text', text }],
            usage: { input_tokens: 13, output_tokens: 3, cache_read_input_tokens: 4 } };
          for (const event of messagesJsonEvents(message)) {
            if (event.type === 'message_start') event.message.usage.output_tokens = 0;
            if (event.type === 'message_delta') event.usage = { output_tokens: 3 };
            controller.enqueue({ type: 'stream_event', event });
          }
          controller.enqueue({ type: 'result', subtype: 'success', is_error: false });
        },
        async close() { if (!closed) { closed = true; controller.close(); } },
      };
      workers.push(worker); return worker;
    } });
  t.after(async () => { for (const remote of remotes) await remote.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.start();
  const make = async () => {
    const remote = new BifrostRemote({ id: 'home', baseUrl: 'https://bifrost.example.test/v1', apiKey: 'bfk_' + 'x'.repeat(43),
      protocols: ['messages'], stateSecret: 'remote-cli-summary-test-secret-without-credentials',
      fetchImpl: async (url, options) => {
        if (url === 'https://bifrost.example.test/v1/models') return Response.json({ data: [{ id: remoteModel, protocols: ['messages'] }] });
        assert.equal(url, 'https://bifrost.example.test/v1/messages'); assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body); calls.push(body);
        return hub.provider(remoteModel).request({ path: '/v1/messages', body, headers: new Headers(options.headers), signal: options.signal });
      } });
    remotes.push(remote); await remote.refreshCatalog(); return remote;
  };
  const remote = await make();
  const body = { model: remoteModel, stream, store: false, tools: [tool], input: [
    { role: 'developer', content: 'Keep the verified tool result in the summary.' },
    { role: 'user', content: 'Update the fixture.' },
    { type: 'function_call', name: tool.name, call_id: 'cli_read_done', arguments: '{"path":"fixture.txt"}' },
    { type: 'function_call_output', call_id: 'cli_read_done', output: 'EXACT_LOCAL_TOOL_RESULT' },
    { type: 'compaction_trigger' },
  ] };
  const response = await remote.request('responses', { body, scope, session: 'remote-cli-compaction' });
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
  const compact = await read(response, stream), checkpoint = compact.value.output[0];
  assert.equal(compact.value.status, 'completed'); assert.equal(checkpoint.type, 'compaction');
  assert.equal(calls.length, 1); assert.equal(workers.length, 1); assert.equal(workers[0].sends.length, 1);
  assert.equal(calls[0].tools, undefined); assert.deepEqual(calls[0].tool_choice, { type: 'none' });
  assert.match(JSON.stringify(workers[0].sends[0]), /EXACT_LOCAL_TOOL_RESULT/);
  assert.ok(workers[0].options.systemPrompt.includes('Keep the verified tool result in the summary.'));
  assert.doesNotMatch(compact.text, /EXACT_LOCAL_TOOL_RESULT|PRIVATE_COMPACTION_THINKING/);
  assert.equal(await remote.openCompactionForHandoff(checkpoint.encrypted_content, { scope, model: remoteModel }), summary);
  assert.equal(compact.value.usage.output_tokens, 3);

  await remote.close();
  const restarted = await make();
  const resumed = await restarted.request('responses', { body: { model: remoteModel, stream, store: false,
    input: [checkpoint, { role: 'user', content: 'Continue the remaining change.' }] }, scope, session: 'remote-cli-compaction' });
  assert.equal(resumed.status, 200);
  const result = await read(resumed, stream);
  assert.equal(result.value.output.find(item => item.type === 'message').content[0].text, 'CONTINUED_FROM_CLI_SUMMARY');
  assert.equal(calls.length, 2); assert.equal(workers.length, 2); assert.equal(workers[1].sends.length, 1);
  assert.match(JSON.stringify(workers[1].sends[0]), /Goal: update the fixture/);
  assert.doesNotMatch(JSON.stringify(calls[1]), /bifrost-messages-compaction-v1/);
});

const alternateSource = { id: 'employee-second-model', name: 'Employee second model', supportsToolCall: true,
  supportsReasoning: true, reasoning: { supportedEfforts: ['low', 'high'] } };
const alternateModel = `CodeBuddy-${alternateSource.id}`;
function tamperThinkingItem(item) {
  assert.ok(item.encrypted_content.startsWith(CODEBUDDY_RESPONSES_STATE_PREFIX));
  const envelope = JSON.parse(Buffer.from(item.encrypted_content.slice(CODEBUDDY_RESPONSES_STATE_PREFIX.length), 'base64url').toString('utf8'));
  const signature = envelope.blocks[0].signature;
  assert.ok(signature.startsWith(CODEBUDDY_STATE_PREFIX));
  const position = CODEBUDDY_STATE_PREFIX.length;
  envelope.blocks[0].signature = signature.slice(0, position) + (signature[position] === 'A' ? 'B' : 'A') + signature.slice(position + 1);
  return { ...item, encrypted_content: CODEBUDDY_RESPONSES_STATE_PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64url') };
}

for (const stream of [false, true]) test(`CodeBuddy ${stream ? 'SSE' : 'JSON'} can switch models and back while retaining visible tool history and matching-model state`, async () => {
  const f = fixture({ extraModels: [alternateSource] });
  const firstThought = 'PRIVATE_FIRST_MODEL_THINKING', secondThought = 'PRIVATE_SECOND_MODEL_THINKING';
  const firstMetadata = 'PRIVATE_FIRST_MODEL_METADATA', secondMetadata = 'PRIVATE_SECOND_MODEL_METADATA';
  f.client.respond = ({ body }) => chat([chunk({ role: 'assistant', reasoning_content: firstThought, extra_fields: { checkpoint: firstMetadata } }),
    chunk({ content: 'VISIBLE_FIRST_MODEL_TOOL_NOTE' }),
    chunk({ tool_calls: [{ index: 0, id: 'cross_model_read', type: 'function', function: { name: body.tools[0].function.name,
      arguments: '{"path":"fixture.txt"}' } }] }), chunk({}, 'tool_calls'), { choices: [], usage }, '[DONE]']);
  const first = await read(await f.request({ ...base, stream, tools: [tool] }), stream);
  assert.equal(first.value?.status, 'completed'); assert.equal(f.client.calls[0].model, f.client.sourceModel);
  const firstCall = first.value.output.find(item => item.type === 'function_call');
  assert.equal(firstCall.name, tool.name); assert.ok(first.value.output.some(item => item.type === 'reasoning'));
  const toolResult = { type: 'function_call_output', call_id: firstCall.call_id, output: 'EXACT_CROSS_MODEL_TOOL_RESULT' };
  const secondInput = [...base.input, ...first.value.output, toolResult, { role: 'user', content: 'Continue with the second model.' }];
  const secondBody = { ...base, model: alternateModel, stream, tools: [tool], input: secondInput }, secondBefore = structuredClone(secondBody);
  f.client.respond = () => chat([chunk({ role: 'assistant', reasoning_content: secondThought, extra_fields: { checkpoint: secondMetadata } }),
    chunk({ content: 'VISIBLE_SECOND_MODEL_RESULT' }), chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
  const secondResponse = await f.request(secondBody); assert.equal(secondResponse.status, 200);
  const second = await read(secondResponse, stream); assert.equal(second.value?.status, 'completed'); assert.deepEqual(secondBody, secondBefore);
  assert.equal(f.client.calls.length, 2); assert.equal(f.client.calls[1].model, alternateSource.id);
  const sentSecond = JSON.stringify(f.client.calls[1]);
  assert.ok(sentSecond.includes('VISIBLE_FIRST_MODEL_TOOL_NOTE')); assert.ok(sentSecond.includes('EXACT_CROSS_MODEL_TOOL_RESULT'));
  assert.doesNotMatch(sentSecond, /PRIVATE_FIRST_MODEL_(?:THINKING|METADATA)|bifrost-codebuddy-responses-v1|bridge-codebuddy-v1/);
  const replayedCall = f.client.calls[1].messages.flatMap(message => message.tool_calls ?? []).find(call => call.id === firstCall.call_id);
  assert.equal(replayedCall?.function.arguments, firstCall.arguments);
  const replayedResult = f.client.calls[1].messages.find(message => message.role === 'tool');
  assert.equal(replayedResult?.tool_call_id, firstCall.call_id); assert.equal(replayedResult?.content, toolResult.output);

  const backBody = { ...base, stream, tools: [tool], input: [...secondInput, ...second.value.output,
    { role: 'user', content: 'Continue with the original model again.' }] }, backBefore = structuredClone(backBody);
  f.client.respond = () => answer('VISIBLE_RETURN_TO_FIRST_MODEL');
  const backResponse = await f.request(backBody, { chosen: f.make() }); assert.equal(backResponse.status, 200);
  const back = await read(backResponse, stream); assert.equal(back.value?.status, 'completed'); assert.deepEqual(backBody, backBefore);
  assert.equal(back.value.output.find(item => item.type === 'message').content[0].text, 'VISIBLE_RETURN_TO_FIRST_MODEL');
  assert.equal(f.client.calls.length, 3); assert.equal(f.client.calls[2].model, f.client.sourceModel); assert.equal(f.counts.seals, 0);
  const sentBack = JSON.stringify(f.client.calls[2]);
  assert.ok(sentBack.includes('VISIBLE_FIRST_MODEL_TOOL_NOTE')); assert.ok(sentBack.includes('VISIBLE_SECOND_MODEL_RESULT'));
  assert.ok(sentBack.includes('EXACT_CROSS_MODEL_TOOL_RESULT')); assert.doesNotMatch(sentBack, /PRIVATE_SECOND_MODEL_(?:THINKING|METADATA)/);
  assert.ok(f.client.calls[2].messages.some(message => message.role === 'assistant' && message.reasoning_content === firstThought));
  assert.ok(f.client.calls[2].messages.some(message => message.role === 'assistant' && message.extra_fields?.checkpoint === firstMetadata));

  const originalIdentity = f.client.identity, tamperedOutput = structuredClone(first.value.output);
  const reasoningIndex = tamperedOutput.findIndex(item => item.type === 'reasoning');
  tamperedOutput[reasoningIndex] = tamperThinkingItem(tamperedOutput[reasoningIndex]);
  for (const [identity, clientScope, history] of [[originalIdentity, otherScope, first.value.output],
    ['different-employee', scope, first.value.output], [originalIdentity, scope, tamperedOutput]]) {
    f.client.identity = identity;
    const denied = await f.request({ ...base, model: alternateModel, input: [...base.input, ...history, toolResult,
      { role: 'user', content: 'Do not infer with unauthorized state.' }] }, { chosen: f.make(), clientScope });
    assert.ok(denied.status >= 400); const text = await denied.text();
    assert.equal(f.client.calls.length, 3); assert.equal(text.includes(firstThought), false); assert.equal(text.includes(firstMetadata), false);
  }
});

for (const stream of [false, true]) test(`CodeBuddy ${stream ? 'SSE' : 'JSON'} hands an authenticated summary to a different model and back without leaking opaque state`, async () => {
  const f = fixture({ extraModels: [alternateSource] });
  const checkpointResponse = await f.request(compactBody(stream)), compact = await read(checkpointResponse, stream);
  assert.equal(checkpointResponse.status, 200); assert.equal(compact.value?.status, 'completed');
  const checkpoint = compact.value.output[0]; assert.equal(checkpoint.type, 'compaction');
  assert.equal(f.client.calls.length, 1); assert.equal(f.counts.seals, 1);
  f.client.respond = () => chat([chunk({ role: 'assistant', reasoning_content: 'PRIVATE_COMPACTED_SECOND_MODEL_THINKING' }),
    chunk({ content: 'VISIBLE_SECOND_MODEL_AFTER_SUMMARY' }), chunk({}, 'stop'), { choices: [], usage }, '[DONE]']);
  const secondInput = [checkpoint, { role: 'user', content: 'Continue the summarized task in the second model.' }];
  const secondBody = { ...base, model: alternateModel, stream, input: secondInput }, secondBefore = structuredClone(secondBody);
  const secondResponse = await f.request(secondBody, { chosen: f.make() }); assert.equal(secondResponse.status, 200);
  const second = await read(secondResponse, stream); assert.equal(second.value?.status, 'completed'); assert.deepEqual(secondBody, secondBefore);
  assert.equal(f.client.calls.length, 2); assert.equal(f.client.calls[1].model, alternateSource.id);
  const imported = f.client.calls[1].messages.find(message => inputText(message).includes(summary));
  assert.equal(imported?.role, 'user'); assert.equal(inputText(imported).split(summary).length - 1, 1);
  assert.doesNotMatch(JSON.stringify(f.client.calls[1]), /bifrost-codebuddy-compaction-v1|bifrost_compaction|PRIVATE_COMPACTION_THINKING/);

  f.client.respond = () => answer('VISIBLE_ORIGINAL_MODEL_AFTER_SUMMARY');
  const backBody = { ...base, stream, input: [...secondInput, ...second.value.output,
    { role: 'user', content: 'Continue the same summarized task in the original model.' }] }, backBefore = structuredClone(backBody);
  const backResponse = await f.request(backBody, { chosen: f.make() }); assert.equal(backResponse.status, 200);
  const back = await read(backResponse, stream); assert.equal(back.value?.status, 'completed'); assert.deepEqual(backBody, backBefore);
  assert.equal(back.value.output.find(item => item.type === 'message').content[0].text, 'VISIBLE_ORIGINAL_MODEL_AFTER_SUMMARY');
  assert.equal(f.client.calls.length, 3); assert.equal(f.client.calls[2].model, f.client.sourceModel); assert.equal(f.counts.seals, 1);
  const sentBack = JSON.stringify(f.client.calls[2]);
  assert.ok(sentBack.includes(summary)); assert.ok(sentBack.includes('VISIBLE_SECOND_MODEL_AFTER_SUMMARY'));
  assert.doesNotMatch(sentBack, /bifrost-codebuddy-compaction-v1|bifrost_compaction|PRIVATE_COMPACTED_SECOND_MODEL_THINKING/);

  const originalIdentity = f.client.identity, token = checkpoint.encrypted_content;
  const tampered = { ...checkpoint, encrypted_content: token.slice(0, compactionPrefix.length)
    + (token[compactionPrefix.length] === 'A' ? 'B' : 'A') + token.slice(compactionPrefix.length + 1) };
  for (const [identity, clientScope, item] of [[originalIdentity, otherScope, checkpoint],
    ['different-employee', scope, checkpoint], [originalIdentity, scope, tampered]]) {
    f.client.identity = identity;
    const denied = await f.request({ ...base, model: alternateModel, input: [item, { role: 'user', content: 'Unauthorized summary continuation.' }] },
      { chosen: f.make(), clientScope });
    assert.ok(denied.status >= 400); assert.equal((await denied.text()).includes(summary), false); assert.equal(f.client.calls.length, 3);
  }
});

async function abortAfterCheckpointFrame(response, abort, frameType) {
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const events = []; let reachedFrame = false, pending = '';
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const raw = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data); events.push(event);
        if (!reachedFrame && event.type === frameType) {
          assert.equal(event.item?.type, 'compaction'); assert.equal(typeof event.item.encrypted_content, 'string');
          // Abort at the observable wire boundary, before requesting another
          // frame. This does not cancel the already completed model response.
          assert.equal(pending, ''); reachedFrame = true; abort.abort();
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  assert.equal(reachedFrame, true);
  const published = events.slice(events.findIndex(event => event.type === frameType) + 1);
  assert.equal(published.some(event => event.type === 'response.completed'), false);
  if (frameType === 'response.output_item.added') assert.equal(published.some(event => event.type === 'response.output_item.done'), false);
  return events;
}

for (const after of ['response.output_item.added', 'response.output_item.done']) {
  test(`CodeBuddy cancellation after ${after} cannot commit a canonical compaction response`, async () => {
    const f = fixture(), abort = new AbortController();
    const response = await f.request(compactBody(true), { signal: abort.signal });
    await abortAfterCheckpointFrame(response, abort, after);
    assert.equal(f.client.calls.length, 1); assert.equal(f.counts.seals, 1);
  });

  test(`generic Messages cancellation after ${after} cannot commit a canonical compaction response`, async () => {
    const abort = new AbortController(); let calls = 0;
    const adapter = new MessagesResponsesAdapter({ stateSecret: 'late-cancel-summary-fixed-test-secret-without-credentials',
      requestMessages: async () => {
        calls++;
        return Response.json({ type: 'message', role: 'assistant', model: 'unit-model', stop_reason: 'end_turn',
          content: [{ type: 'text', text: summary }], usage: { input_tokens: 9, output_tokens: 3 } });
      } });
    const response = await adapter.request({ body: { model: 'unit-model', stream: true, store: false,
      input: [{ role: 'user', content: 'history' }, { type: 'compaction_trigger' }] }, scope, signal: abort.signal });
    await abortAfterCheckpointFrame(response, abort, after);
    assert.equal(calls, 1);
  });
}
