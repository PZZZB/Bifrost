import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlLocalAgentStore } from '@cursor/sdk';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider, CODEBUDDY_RESPONSES_STATE_PREFIX } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState, ThinkingStateError } from '../src/codebuddy-thinking-state.mjs';
import { CursorResponsesProvider } from '../src/cursor-responses.mjs';
import { clientScope } from '../src/client-scope.mjs';

const FIRST = 'fd87a754-1056-4998-8d74-6f1d89c6ed8e', SECOND = 'a7a55a9c-c865-40d9-b6fe-35edaf7e0edb';
const CB_MODEL = CODEBUDDY_MODEL.id;
const CB_INPUT = { model: CB_MODEL, max_tokens: 128, stream: false,
  messages: [{ role: 'user', content: 'Read file' }],
  tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function codeBuddySource({ tools = false, toolName = 'read_file' } = {}) {
  const frames = [chunk({ role: 'assistant', reasoning_content: 'private thinking' }),
    tools ? chunk({ tool_calls: [{ index: 0, id: 'call_file', type: 'function', function: { name: toolName, arguments: '{"path":"test.txt"}' } }] })
      : chunk({ content: 'Done' }), chunk({}, tools ? 'tool_calls' : 'stop'), '[DONE]'];
  return new Response(frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
function codeBuddyFixture() {
  const state = new CodeBuddyThinkingState({ key: Buffer.alloc(32, 3) });
  const calls = [];
  const client = { status: () => ({ authenticated: true, identity: { uid: 'employee-one', username: 'employee.user' } }),
    modelCatalog: async () => [{ id: 'employee-opus-55', name: 'Claude Opus 5.5', supportsToolCall: true }],
    async chatCompletions(options) { calls.push(options); return codeBuddySource({ tools: calls.length === 1,
      toolName: options.body.tools?.[0]?.function?.name ?? 'read_file' }); } };
  const provider = new CodeBuddyProvider({ client, loadThinkingState: () => state });
  return { provider, calls, state, request: (body, scope) => provider.request({ path: '/v1/messages', body, clientScope: scope }) };
}

test('client scope accepts legacy unscoped requests and rejects malformed identifiers', () => {
  assert.equal(clientScope(undefined), null); assert.equal(clientScope(null), null); assert.equal(clientScope(FIRST), FIRST);
  for (const value of ['', 'tenant-other', FIRST.toUpperCase(), FIRST + '\n', 123, {}, 'Bearer private']) {
    assert.throws(() => clientScope(value), error => error.status === 400 && error.code === 'client_scope_invalid');
  }
});

test('CodeBuddy encrypted state authenticates client_scope while legacy packets remain unchanged', () => {
  const state = new CodeBuddyThinkingState(), old = { reasoning: 'private', identity: 'employee-one', model: 'employee-opus-55' };
  const block = signature => ({ type: 'thinking', thinking: '', signature });
  assert.deepEqual(state.open(block(state.seal(old))), old);
  const scoped = { ...old, client_scope: FIRST }, token = state.seal(scoped);
  assert.deepEqual(state.open(block(token)), scoped); assert.equal(token.includes(FIRST), false);
  for (const value of ['', null, 123, 'bad\nscope']) assert.throws(() => state.seal({ ...old, client_scope: value }), ThinkingStateError);
});

test('CodeBuddy Messages never restores another user or unscoped thinking state', async () => {
  const { request, calls, state } = codeBuddyFixture();
  const firstResponse = await request(CB_INPUT, FIRST), first = await firstResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  const hidden = first.content.find(item => item.type === 'thinking'); assert.ok(hidden);
  assert.equal(state.open(hidden).client_scope, FIRST);
  const toolCall = first.content.find(item => item.type === 'tool_use'); assert.ok(toolCall);
  const continued = { ...CB_INPUT, messages: [...CB_INPUT.messages, { role: 'assistant', content: first.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'file result' }] }] };
  for (const scope of [SECOND, null]) {
    const rejected = await request(continued, scope); assert.equal(rejected.status, 403); await rejected.text(); assert.equal(calls.length, 1);
  }
  const resumed = await request(continued, FIRST); assert.equal(resumed.status, 200); await resumed.json(); assert.equal(calls.length, 2);
  assert.equal(calls[1].body.messages[1].reasoning, 'private thinking');
  assert.equal(JSON.stringify(calls).includes(FIRST), false);
});

test('CodeBuddy Responses passes the tenant through its inner provider and preserves scope in opaque envelopes', async () => {
  const { provider, state, calls } = codeBuddyFixture();
  const responses = new CodeBuddyResponsesProvider({ provider });
  const base = { model: CB_MODEL, stream: false, store: false, input: [{ role: 'user', content: 'Read file' }],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }],
    include: ['reasoning.encrypted_content'] };
  const firstResponse = await responses.request({ path: '/responses', body: base, clientScope: FIRST }), first = await firstResponse.json();
  assert.equal(firstResponse.status, 200, JSON.stringify(first));
  const encrypted = first.output.find(item => item.type === 'reasoning').encrypted_content;
  const envelope = JSON.parse(Buffer.from(encrypted.slice(CODEBUDDY_RESPONSES_STATE_PREFIX.length), 'base64url').toString());
  assert.equal(state.open(envelope.blocks[0]).client_scope, FIRST);
  const call = first.output.find(item => item.type === 'function_call');
  const body = { ...base, input: [...base.input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'result' }] };
  const rejected = await responses.request({ path: '/responses', body, clientScope: SECOND });
  assert.equal(rejected.status, 403); await rejected.text(); assert.equal(calls.length, 1);
  const accepted = await responses.request({ path: '/responses', body, clientScope: FIRST });
  assert.equal(accepted.status, 200); await accepted.json(); assert.equal(calls.length, 2);
});

class EventQueue {
  values = []; waiter = null; ended = false;
  push(value) { this.values.push(value); this.waiter?.(); this.waiter = null; }
  end() { this.ended = true; this.waiter?.(); this.waiter = null; }
  async *stream() {
    while (!this.ended || this.values.length) {
      if (!this.values.length) { await new Promise(resolve => { this.waiter = resolve; }); continue; }
      yield this.values.shift();
    }
  }
}
const CURSOR_INPUT = { model: 'Cursor-gemini-4-argon', stream: false, instructions: 'Trusted rule',
  input: [{ role: 'user', content: 'Read file' }], tools: [{ type: 'function', name: 'read_file', strict: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } } } }] };
async function cursorFixture(t, { tool = false, checkpoint = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-client-tenancy-'));
  const providers = [], created = [], resumed = [], sends = [], results = [];
  const service = { credential: async () => ({ apiKey: 'cursor-tenant-fixture', apiKeyExpiresAtMs: Date.now() + 60000 }),
    getModels: async () => [{ id: 'gemini-4-argon' }], status: async () => ({ enabled: true, authReady: true, catalog: { models: [{ id: 'gemini-4-argon' }] } }) };
  let agentNumber = 0;
  function agent(options, agentId = `agent-${++agentNumber}`) {
    return { agentId, close() {}, async send(message, local) {
      let document;
      if (checkpoint) {
        document = await options.local.store.agents.get({ agentId });
        if (!document) document = await options.local.store.agents.create({ agent: { agentId, cwd: options.local.cwd, status: 'running', createdAt: Date.now(), updatedAt: Date.now() } });
        else await options.local.store.agents.update({ agent: { ...document, status: 'running', activeRunId: 'fixture-run' } });
      }
      const queue = new EventQueue(); let settle;
      const done = new Promise(resolve => { settle = resolve; });
      const run = { id: `run-${sends.length + 1}`, stream: () => queue.stream(), wait: () => done,
        async cancel() { queue.end(); settle({ status: 'cancelled' }); } };
      sends.push({ message, options: local, run });
      void Promise.resolve().then(async () => {
        if (tool) {
          const callback = Object.entries(local.local.customTools).find(([id, value]) => id !== 'bifrost_client_dispatch' && value.description?.includes('Tool read_file:'))?.[1];
          assert.ok(callback);
          results.push(await callback.execute({ path: 'test.txt' }, { toolCallId: 'sdk-call-one' }));
        }
        queue.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } });
        if (checkpoint) {
          const rootBlobId = `fixture-blob-${sends.length}`;
          await options.local.store.checkpoints.create({ agentId, blobId: rootBlobId, data: new TextEncoder().encode('opaque-sdk-checkpoint') });
          await options.local.store.agents.update({ agent: { ...document, status: 'idle', activeRunId: null, latestCheckpoint: { schemaVersion: 1, rootBlobId }, updatedAt: Date.now() } });
        }
        queue.end(); settle({ status: 'finished' });
      }).catch(error => { queue.end(); settle({ status: 'error', error: { message: error.message } }); });
      return run;
    } };
  }
  const sdk = { JsonlLocalAgentStore: checkpoint ? JsonlLocalAgentStore : class { constructor(path) { this.path = path; } },
    Agent: { async create(options) { created.push(options); return agent(options); }, async resume(id, options) { resumed.push({ id, options }); return agent(options, id); } } };
  const make = () => { const provider = new CursorResponsesProvider({ cursorService: service, stateDir: directory, sdkLoader: async () => sdk }); providers.push(provider); return provider; };
  const provider = make();
  t.after(async () => { for (const value of providers) await value.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, make, directory, created, resumed, sends, results,
    request: (body = CURSOR_INPUT, scope = FIRST, target = provider) => target.request({ path: '/responses', body: structuredClone(body), clientScope: scope }) };
}

test('Cursor live tool callbacks reject another client scope without creating or sending a second run', async t => {
  const f = await cursorFixture(t, { tool: true });
  const firstResponse = await f.request(), first = await firstResponse.json(); assert.equal(firstResponse.status, 200);
  const call = first.output.find(item => item.type === 'function_call'); assert.ok(call);
  const body = { ...CURSOR_INPUT, input: [...CURSOR_INPUT.input, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'client output' }] };
  for (const scope of [SECOND, null]) {
    const rejected = await f.request(body, scope); assert.equal(rejected.status, 403); assert.equal((await rejected.json()).error.code, 'cursor_session_scope');
  }
  assert.equal(f.results.length, 0); assert.equal(f.sends.length, 1);
  const accepted = await f.request(body, FIRST); assert.equal(accepted.status, 200); await accepted.json();
  assert.deepEqual(f.results[0], { content: [{ type: 'text', text: 'client output' }] });
  assert.equal(f.created.length, 1); assert.equal(f.sends.length, 1);
  assert.equal(JSON.stringify(f.created).includes(FIRST), false);
});

test('Cursor completed checkpoints bind tenant in authHash and reject foreign tenants before SDK resume', async t => {
  const f = await cursorFixture(t, { checkpoint: true });
  const firstResponse = await f.request(), first = await firstResponse.json(); assert.equal(firstResponse.status, 200);
  const root = join(f.directory, 'cursor-sdk', 'resume'), files = await readdir(root); assert.equal(files.length, 1);
  const serialized = await readFile(join(root, files[0]), 'utf8'), index = JSON.parse(serialized);
  assert.equal(index.authHash, createHash('sha256').update(`cursor-tenant-fixture\n\nclient:${FIRST}`).digest('hex'));
  assert.equal(serialized.includes(FIRST), false); assert.equal(serialized.includes('cursor-tenant-fixture'), false);
  await f.provider.close();
  const next = f.make(), body = { ...CURSOR_INPUT, input: [...CURSOR_INPUT.input, ...first.output, { role: 'user', content: 'Continue' }] };
  for (const scope of [SECOND, null]) {
    const rejected = await f.request(body, scope, next); assert.equal(rejected.status, 403); await rejected.text(); assert.equal(f.resumed.length, 0);
  }
  const accepted = await f.request(body, FIRST, next); assert.equal(accepted.status, 200); await accepted.json();
  assert.equal(f.resumed.length, 1); assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[1].message, { text: 'Continue' });
});

test('malformed provider scopes fail before metadata or SDK inference', async t => {
  const cb = codeBuddyFixture(), cursor = await cursorFixture(t);
  const first = await cb.request(CB_INPUT, 'invalid-scope'); assert.equal(first.status, 400); await first.text(); assert.equal(cb.calls.length, 0);
  const second = await cursor.request(CURSOR_INPUT, 'invalid-scope'); assert.equal(second.status, 400); await second.text(); assert.equal(cursor.created.length, 0);
});
