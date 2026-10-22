import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, rename, symlink, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorResponsesProvider, CURSOR_RESPONSES_STATE_PREFIX } from '../src/cursor-responses.mjs';
import { JsonlLocalAgentStore } from '@cursor/sdk';

const model = 'Cursor-gemini-4-argon', upstream = 'gemini-4-argon';
const fn = { type: 'function', name: 'read_file', description: 'Read a file in the client.', strict: false,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const base = { model, stream: false, instructions: 'Trusted developer instruction.', input: [{ role: 'user', content: 'Read the file.' }], tools: [fn] };
const tokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 20, reasoningTokens: 2 };
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));
class Messages {
  items = []; wait = null; done = false;
  push(value) { this.items.push(value); this.wait?.(); this.wait = null; }
  end() { this.done = true; this.wait?.(); this.wait = null; }
  async *stream() {
    while (!this.done || this.items.length) {
      if (!this.items.length) { await new Promise(resolveNext => { this.wait = resolveNext; }); continue; }
      yield this.items.shift();
    }
  }
}
async function fixture(t, scenario, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-cursor-responses-'));
  const created = [], resumed = [], sends = [], results = [], cancelled = [], closed = [];
  let apiKey = 'cursor-fixture-key', catalog = [{ id: upstream, displayName: 'Gemini 4 Argon' }, { id: 'grok-4.7', displayName: 'Grok 4.7' }];
  const service = { enabled: true,
    credential: async () => ({ apiKey, apiKeyExpiresAtMs: Date.now() + 60000 }), getModels: async () => catalog,
    status: async () => ({ enabled: true, authReady: true, catalog: { models: catalog }, profile: { email: 'safe@example.invalid' } }) };
  const sdk = {
    JsonlLocalAgentStore: settings.realCheckpoint ? JsonlLocalAgentStore : class { constructor(path) { this.path = path; } },
    Agent: { async create(options) {
      created.push(options); if (settings.createError) throw settings.createError;
      if (settings.createGate) await settings.createGate;
      const agent = { agentId: `agent-${created.length}`, close() { closed.push(agent.agentId); }, async send(message, options) {
        let document;
        if (settings.realCheckpoint) {
          document = await agent.store.agents.get({ agentId: agent.agentId });
          if (!document) document = await agent.store.agents.create({ agent: { agentId: agent.agentId, cwd: agent.cwd, status: 'running', createdAt: Date.now(), updatedAt: Date.now() } });
          else await agent.store.agents.update({ agent: { ...document, status: 'running', activeRunId: 'fixture-run' } });
        }
        const events = new Messages(); let settle;
        const done = new Promise(resolveResult => { settle = resolveResult; });
        const run = { id: `run-${sends.length + 1}`, stream: () => events.stream(), wait: () => done,
          async cancel() { cancelled.push(run.id); events.end(); settle({ status: 'cancelled' }); } };
        sends.push({ message, options, run });
        const context = {
          options, message, emit: event => events.push(event),
          text: text => events.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
          usage: usage => events.push({ type: 'usage', usage }),
          tools: Object.entries(options.local.customTools),
          finish(result = { status: 'finished' }) {
            if (!settings.realCheckpoint) { events.end(); settle(result); return; }
            void (async () => {
              const rootBlobId = `fixture-blob-${sends.length}`;
              await agent.store.checkpoints.create({ agentId: agent.agentId, blobId: rootBlobId, data: new TextEncoder().encode('opaque-sdk-checkpoint') });
              await agent.store.agents.update({ agent: { ...document, status: 'idle', activeRunId: null, latestCheckpoint: { schemaVersion: 1, rootBlobId }, updatedAt: Date.now() } });
              events.end(); settle(result);
            })().catch(error => { events.end(); settle({ status: 'error', error: { message: error.message } }); });
          },
          async call(tool, args, callId) {
            const result = await tool.execute(args, { toolCallId: callId }); results.push(result); return result;
          },
        };
        void Promise.resolve().then(() => scenario(context)).catch(error => { events.end(); settle({ status: 'error', error: { message: error.message } }); });
        if (settings.sendGate) await settings.sendGate;
        return run;
      } };
      agent.store = options.local.store; agent.cwd = options.local.cwd;
      return agent;
    }, async resume(agentId, options) {
      resumed.push({ agentId, options });
      const agent = await sdk.Agent.create(options); created.pop(); agent.agentId = agentId; return agent;
    } },
  };
  const provider = new CursorResponsesProvider({ cursorService: service, stateDir: directory, sdkLoader: async () => sdk, ...settings });
  t.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, service, sdk, created, resumed, sends, results, cancelled, closed, directory,
    changeKey: value => { apiKey = value; }, setCatalog: value => { catalog = value; },
    request: (body = base, signal) => provider.request({ path: '/v1/responses', body: structuredClone(body),
      headers: new Headers({ authorization: 'Bearer must-not-forward-a' }), signal }) };
}
function history(first, outputs) { return [...base.input, ...first.output, ...outputs]; }
function calledTool(context, name = 'read_file') {
  const found = context.tools.find(([id, tool]) => id !== 'bifrost_client_dispatch' && tool.description?.includes(`Tool ${name}:`));
  assert.ok(found); return found[1];
}

test('text-only SDK run uses exact public options, isolated storage, actual model, and current-HTTP usage', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.usage(tokenUsage); context.finish(); });
  const response = await f.request(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, 'completed');
  assert.equal(f.provider.activeRuns, 0);
  assert.equal(body.output.find(item => item.type === 'message').content[0].text, 'Done.');
  assert.equal(body.output.find(item => item.type === 'reasoning').encrypted_content.startsWith(CURSOR_RESPONSES_STATE_PREFIX), true);
  assert.equal(response.bridgeModel, upstream);
  assert.deepEqual(await response.bridgeUsage, { input_tokens: 15, output_tokens: 5, total_tokens: 20,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 2 } });
  const options = f.created[0];
  assert.deepEqual(options.tools, ['mcp']); assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.local.settingSources, []); assert.equal(options.local.enableAgentRetries, false);
  assert.equal(options.systemPrompt, base.instructions); assert.deepEqual(options.model, { id: upstream });
  assert.equal(options.local.cwd.startsWith(f.directory), true); assert.equal(options.local.store.path.startsWith(f.directory), true);
  assert.equal(JSON.stringify(options).includes('must-not-forward-a'), false);
  assert.equal(Object.hasOwn(options, 'maxTurns'), false); assert.equal(Object.hasOwn(options, 'maxTokens'), false);
});

test('client result resumes the exact original SDK callback and live run without a second send', async t => {
  let callbackResult;
  const f = await fixture(t, async context => {
    callbackResult = await context.call(calledTool(context), { path: 'fixture.txt' }, 'sdk-call-one');
    context.text('Tool finished.'); context.usage(tokenUsage); context.finish();
  });
  const firstResponse = await f.request(), first = await firstResponse.json();
  const call = first.output.find(item => item.type === 'function_call');
  assert.equal(f.provider.activeRuns, 1);
  assert.equal(call.name, fn.name); assert.equal(f.sends.length, 1); assert.equal(callbackResult, undefined);
  const secondResponse = await f.request({ ...base, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'real client output' }]) });
  const second = await secondResponse.json();
  assert.equal(second.status, 'completed'); assert.equal(f.sends.length, 1);
  assert.equal(f.provider.activeRuns, 0);
  assert.deepEqual(callbackResult, { content: [{ type: 'text', text: 'real client output' }] });
  assert.equal(await firstResponse.bridgeUsage, null); assert.equal(await secondResponse.bridgeUsage, null);
  assert.deepEqual((await f.provider.status()).runUsageDiagnostics[0], { model: upstream, scope: 'sdk-run',
    usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 2 } },
    httpAttribution: 'unknown' });
});

test('multiple simultaneous SDK callbacks are exposed serially and all original promises settle', async t => {
  const f = await fixture(t, async context => {
    const tool = calledTool(context);
    await Promise.all([context.call(tool, { path: 'one.txt' }, 'sdk-one'), context.call(tool, { path: 'two.txt' }, 'sdk-two')]);
    context.text('Both finished.'); context.finish();
  });
  const body = { ...base, parallel_tool_calls: true };
  const first = await (await f.request(body)).json(), firstCall = first.output.find(item => item.type === 'function_call');
  assert.equal(first.output.filter(item => item.type === 'function_call').length, 1);
  const previous = history(first, [{ type: 'function_call_output', call_id: firstCall.call_id, output: 'one' }]);
  const second = await (await f.request({ ...body, input: previous })).json(), secondCall = second.output.find(item => item.type === 'function_call');
  assert.equal(second.output.filter(item => item.type === 'function_call').length, 1);
  const third = await (await f.request({ ...body, input: [...previous, ...second.output,
    { type: 'function_call_output', call_id: secondCall.call_id, output: 'two' }] })).json();
  assert.equal(third.status, 'completed'); assert.equal(f.sends.length, 1); assert.equal(f.results.length, 2);
});

test('namespace/custom tools preserve raw input and tool discovery invokes only newly declared client tools', async t => {
  const custom = { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch', format: { type: 'text' } }] };
  const f = await fixture(t, async context => {
    const tool = calledTool(context, 'apply_patch');
    await context.call(tool, { input: '*** Begin Patch\n*** End Patch\n' }, 'sdk-custom');
    context.text('Patched.'); context.finish();
  });
  const first = await (await f.request({ ...base, tools: [custom] })).json();
  const call = first.output.find(item => item.type === 'custom_tool_call');
  assert.equal(call.namespace, 'functions'); assert.equal(call.input, '*** Begin Patch\n*** End Patch\n');
  const next = await f.request({ ...base, tools: [custom], input: history(first, [{ type: 'custom_tool_call_output', call_id: call.call_id, output: 'ok' }]) });
  assert.equal(next.status, 200); await next.json();
});

test('opaque state binds full semantic history, account and model; used results cannot be replayed', async t => {
  const f = await fixture(t, async context => { await context.call(calledTool(context), { path: 'x' }); context.text('Done.'); context.finish(); });
  const first = await (await f.request()).json(), call = first.output.find(item => item.type === 'function_call');
  const input = history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }]);
  const changed = structuredClone(input); changed[0].content = 'Altered original history';
  assert.equal((await f.request({ ...base, input: changed })).status, 409);
  f.changeKey('different-account-key'); assert.equal((await f.request({ ...base, input })).status, 403);
  f.changeKey('cursor-fixture-key'); assert.equal((await f.request({ ...base, model: 'Cursor-grok-4.7', input })).status, 403);
  const accepted = await f.request({ ...base, input }); assert.equal(accepted.status, 200); await accepted.json();
  assert.equal((await f.request({ ...base, input })).status, 409); assert.equal(f.sends.length, 1);
});

test('unknown/foreign/restarted state and unsupported raw parameters fail before creating an agent', async t => {
  const f = await fixture(t, async context => { context.finish(); });
  for (const extra of [{ max_output_tokens: 1 }, { temperature: 0.5 }, { top_p: 0.9 }, { reasoning: { effort: 'invented' } },
    { tool_choice: 'required' }, { tool_choice: { type: 'function', name: 'read_file' } },
    { input: [...base.input, { type: 'reasoning', summary: [], encrypted_content: 'openai-state' }] },
    { input: [...base.input, { type: 'reasoning', summary: [], encrypted_content: CURSOR_RESPONSES_STATE_PREFIX + 'old-process' }] }]) {
    const response = await f.request({ ...base, ...extra }); assert.ok(response.status >= 400); await response.text();
  }
  assert.equal(f.created.length, 0);
});

test('SDK systemPrompt access denial is explicit and never retried as an ordinary user instruction', async t => {
  const f = await fixture(t, async context => { context.finish(); }, { createError: new Error('Permission denied: custom systemPrompt is not authorized') });
  const response = await f.request(), body = await response.json();
  assert.equal(response.status, 403); assert.equal(body.error.code, 'cursor_system_prompt_denied');
  assert.equal(f.created.length, 1); assert.equal(f.sends.length, 0);
});

test('tool_choice none registers no callbacks and unknown usage remains unknown', async t => {
  const f = await fixture(t, async context => { assert.deepEqual(context.options.local.customTools, {}); context.text('No tools.'); context.finish(); });
  const response = await f.request({ ...base, tool_choice: 'none' });
  assert.equal(response.status, 200); await response.json(); assert.equal(await response.bridgeUsage, null);
  assert.deepEqual(f.created[0].local.customTools, {});
});

test('backpressure starts no SDK agent before consumption; cancellation before reading discards the reserved session', async t => {
  const f = await fixture(t, async context => { context.text('not consumed'); context.finish(); });
  const response = await f.request({ ...base, stream: true });
  await tick(); assert.equal(f.created.length, 0);
  await response.body.cancel(); await tick(); assert.equal(f.created.length, 0); assert.equal(await response.bridgeUsage, null);
});

test('stream preflight exposes asynchronous SDK startup denial and authentication errors as JSON without replay', async t => {
  for (const [error, status, code] of [
    [{ message: "[invalid_argument] unknown option '--system-prompt'" }, 403, 'cursor_system_prompt_denied'],
    [{ message: 'unauthorized', status: 401 }, 401, 'cursor_auth_rejected'],
  ]) {
    const f = await fixture(t, async context => {
      await tick(); context.emit({ type: 'status', status: 'ERROR', message: error.message });
      context.finish({ status: 'error', error });
    });
    const original = await f.request({ ...base, stream: true });
    assert.equal(f.created.length, 0);
    const response = await original.bridgePreflight();
    assert.equal(response.status, status); assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal((await response.json()).error.code, code); assert.equal(await response.bridgeUsage, null);
    assert.equal(f.created.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.provider.activeRuns, 0);
    assert.equal(f.closed.length, 1); assert.equal((await original.body.getReader().read()).done, true);
    assert.equal(await original.bridgePreflight(), response);
  }
});

test('terminal SDK error codes take priority over generic or misleading status text', async t => {
  for (const [message, error, status, code] of [
    ['Request failed', { code: 'unauthenticated', message: 'token expired' }, 401, 'cursor_auth_rejected'],
    ["unknown option '--system-prompt'", { code: 'unauthenticated', message: 'token expired' }, 401, 'cursor_auth_rejected'],
    ['systemPrompt service is not available', { code: 'unavailable', message: 'offline' }, 503, 'cursor_upstream_unavailable'],
    ["unknown option '--system-prompt'", { code: 'invalid_argument', message: 'Request failed' }, 403, 'cursor_system_prompt_denied'],
  ]) {
    const f = await fixture(t, async context => {
      context.emit({ type: 'status', status: 'ERROR', message }); context.finish({ status: 'error', error });
    });
    const original = await f.request({ ...base, stream: true }), response = await original.bridgePreflight();
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    assert.equal(f.sends.length, 1); assert.equal(f.provider.activeRuns, 0);
  }
});

test('preflight waits through usage and preserves every normal SSE frame in order', async t => {
  let release, started;
  const ready = new Promise(resolveReady => { started = resolveReady; });
  const gate = new Promise(resolveGate => { release = resolveGate; });
  const f = await fixture(t, async context => {
    context.usage(tokenUsage); started(); await gate; context.text('First.'); context.text('Second.'); context.finish();
  });
  const response = await f.request({ ...base, stream: true });
  let primed = false;
  const preflight = response.bridgePreflight().then(value => { primed = true; return value; });
  await ready; await tick(); assert.equal(primed, false);
  release(); assert.equal(await preflight, response);
  assert.equal(response.bodyUsed, false);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ['response.created', 'response.in_progress']);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  assert.equal(events.filter(event => event.type === 'response.created').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), ['First.', 'Second.']);
  assert.equal(events.at(-1).type, 'response.completed'); assert.equal(f.sends.length, 1);
  assert.equal((await response.bridgeUsage).total_tokens, 20);
});

test('cancellation settles pending preflight and discards an unread preflighted run', async t => {
  const f = await fixture(t, async () => {}), abort = new AbortController();
  const response = await f.request({ ...base, stream: true }, abort.signal), preflight = response.bridgePreflight();
  while (!f.sends.length) await tick();
  abort.abort();
  const failure = await preflight;
  assert.equal(failure.status, 499); assert.equal((await failure.json()).error.code, 'request_cancelled');
  assert.equal(await failure.bridgeUsage, null); assert.equal(f.provider.activeRuns, 0); assert.equal(f.cancelled.length, 1);

  const unread = await fixture(t, async context => { context.text('First.'); });
  const prepared = await unread.request({ ...base, stream: true });
  assert.equal(await prepared.bridgePreflight(), prepared); assert.equal(unread.provider.activeRuns, 1);
  await prepared.body.cancel(); await tick();
  assert.equal(await prepared.bridgeUsage, null); assert.equal(unread.provider.activeRuns, 0); assert.equal(unread.cancelled.length, 1);
});

test('errors following text remain SSE failures after successful preflight and never replay the SDK run', async t => {
  const f = await fixture(t, async context => {
    context.text('Already started.'); context.emit({ type: 'status', status: 'ERROR', message: 'unauthorized' });
    context.finish({ status: 'error', error: { message: 'unauthorized', status: 401 } });
  });
  const response = await f.request({ ...base, stream: true });
  assert.equal(await response.bridgePreflight(), response); assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'cursor_auth_rejected');
  assert.equal(events.filter(event => event.type === 'response.output_text.delta')[0].delta, 'Already started.');
  assert.equal(f.sends.length, 1); assert.equal(f.provider.activeRuns, 0);
});

test('cancelAll rejects hanging callbacks and allows a later fresh authenticated request; close is permanent', async t => {
  let calls = 0;
  const f = await fixture(t, async context => {
    if (calls++ === 0) await context.call(calledTool(context), { path: 'pending' });
    context.text('Done.'); context.finish();
  });
  const first = await (await f.request()).json();
  await f.provider.cancelAll(); assert.ok(f.cancelled.length > 0); assert.ok(f.closed.length > 0);
  const call = first.output.find(item => item.type === 'function_call');
  assert.equal((await f.request({ ...base, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'late' }]) })).status, 409);
  const again = await f.request(); assert.equal(again.status, 200); await again.json();
  await f.provider.close(); assert.equal((await f.request()).status, 503);
});

test('aborts during authentication and pending streams never execute a late SDK run', async t => {
  const f = await fixture(t, async () => {});
  const abort = new AbortController();
  f.service.credential = async () => { abort.abort(); return { apiKey: 'fixture', apiKeyExpiresAtMs: Date.now() + 10000 }; };
  const response = await f.request({ ...base, stream: true }, abort.signal);
  await response.text(); assert.equal(f.created.length, 0);
});

test('idle expiry cancels a suspended tool run and subsequent HTTP must start a new chat', async t => {
  const f = await fixture(t, async context => { await context.call(calledTool(context), { path: 'x' }); context.finish(); }, { idleTimeoutMs: 20 });
  const first = await (await f.request()).json(), call = first.output.find(item => item.type === 'function_call');
  await new Promise(resolveWait => setTimeout(resolveWait, 45));
  assert.ok(f.cancelled.length > 0);
  assert.equal((await f.request({ ...base, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'late' }]) })).status, 409);
});

test('real model catalog values alone permit reasoning selections and active-run parameters cannot change', async t => {
  const f = await fixture(t, async context => { await context.call(calledTool(context), { path: 'x' }); context.finish(); });
  f.setCatalog([{ id: upstream, parameters: [{ id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] }] }]);
  const first = await (await f.request({ ...base, reasoning: { effort: 'low' } })).json(), call = first.output.find(item => item.type === 'function_call');
  assert.deepEqual(f.created[0].model, { id: upstream, params: [{ id: 'reasoning_effort', value: 'low' }] });
  const next = await f.request({ ...base, reasoning: { effort: 'high' }, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }]) });
  assert.equal(next.status, 409);
  assert.equal((await f.request({ ...base, reasoning: { effort: 'max' } })).status, 400);
});

test('a model without an effort parameter explicitly uses Cursor defaults and never echoes inherited Codex max', async t => {
  const f = await fixture(t, async context => { context.text('Default reasoning.'); context.finish(); });
  const response = await f.request({ ...base, reasoning: { effort: 'max' } }), body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(f.created[0].model, { id: upstream });
  assert.deepEqual(f.sends[0].options.model, { id: upstream }); assert.deepEqual(body.reasoning, {});
  assert.equal((await f.request({ ...base, reasoning: { effort: 'max', invented: true } })).status, 400);
});

test('client discovery adds tools to a live run through the checked dispatcher without another send', async t => {
  const search = { type: 'tool_search', execution: 'client', description: 'Discover tools.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const discovered = { type: 'namespace', name: 'functions', description: 'Files', tools: [{ ...fn, defer_loading: true }] };
  const f = await fixture(t, async context => {
    await context.call(calledTool(context, 'tool_search'), { query: 'read file' }, 'sdk-discover');
    assert.equal(context.tools.some(([name, tool]) => name !== 'bifrost_client_dispatch' && tool.description.includes('Tool read_file:')), false);
    await context.call(context.options.local.customTools.bifrost_client_dispatch,
      { type: 'function', namespace: 'functions', name: 'read_file', arguments: { path: 'newly-discovered.txt' } }, 'sdk-discovered-file');
    context.text('Discovered tool finished.'); context.finish();
  });
  const tools = [search], first = await (await f.request({ ...base, tools })).json();
  const searchCall = first.output.find(item => item.type === 'tool_search_call'); assert.ok(searchCall);
  const input = history(first, [{ type: 'tool_search_output', call_id: searchCall.call_id, tools: [discovered] }]);
  const second = await (await f.request({ ...base, tools, input })).json();
  const call = second.output.find(item => item.type === 'function_call');
  assert.equal(call.namespace, 'functions'); assert.equal(call.name, 'read_file');
  assert.deepEqual(JSON.parse(call.arguments), { path: 'newly-discovered.txt' });
  const third = await (await f.request({ ...base, tools, input: [...input, ...second.output,
    { type: 'function_call_output', call_id: call.call_id, output: 'actual client result' }] })).json();
  assert.equal(third.status, 'completed'); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.results.at(-1), { content: [{ type: 'text', text: 'actual client result' }] });
});

test('all static tool declarations remain fixed during a live run, including tools not currently pending', async t => {
  const other = { ...fn, name: 'write_file' }, tools = [fn, other];
  const f = await fixture(t, async context => { await context.call(calledTool(context), { path: 'x' }); context.finish(); });
  const first = await (await f.request({ ...base, tools })).json(), call = first.output.find(item => item.type === 'function_call');
  const input = history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }]);
  const changed = await f.request({ ...base, tools: [fn, { ...other, description: 'Changed SDK declaration' }], input });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).error.code, 'cursor_tool_schema_changed');
  const accepted = await f.request({ ...base, tools, input }); assert.equal(accepted.status, 200); await accepted.json();
});

test('finished runs can change real reasoning selection on the next genuine user turn', async t => {
  let sends = 0;
  const f = await fixture(t, async context => {
    if (sends++ === 1) await context.call(calledTool(context), { path: 'second' });
    context.text('Done.'); context.finish();
  });
  f.setCatalog([{ id: upstream, parameters: [{ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }] }]);
  const first = await (await f.request({ ...base, reasoning: { effort: 'low' } })).json();
  const input = history(first, [{ role: 'user', content: 'Second question' }]);
  const second = await (await f.request({ ...base, reasoning: { effort: 'high' }, input })).json();
  const call = second.output.find(item => item.type === 'function_call');
  const third = await f.request({ ...base, reasoning: { effort: 'high' }, input: [...input, ...second.output,
    { type: 'function_call_output', call_id: call.call_id, output: 'ok' }] });
  assert.equal(third.status, 200); await third.json(); assert.equal(f.sends.length, 2);
});

test('native SDK interaction requests and unknown assistant content fail explicitly and cancel the run', async t => {
  for (const event of [{ type: 'request', request_id: 'native-question' },
    { type: 'assistant', message: { content: [{ type: 'video', data: 'unsupported' }] } }]) {
    const f = await fixture(t, async context => { context.emit(event); });
    const response = await f.request(), body = await response.json();
    assert.ok(response.status >= 400); assert.match(body.error.code, /^cursor_(native_interaction|content)_unsupported$/);
    assert.ok(f.cancelled.length > 0);
  }
});

test('a single HTTP attributes terminal run usage once even without a stream usage event', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish({ status: 'finished', usage: tokenUsage }); });
  const response = await f.request(); await response.json();
  assert.equal((await response.bridgeUsage).total_tokens, 20);
  assert.equal((await f.provider.status()).runUsageDiagnostics[0].httpAttribution, 'single-http');
});

test('request timeout and cancellation during late create/send cancel every started SDK run', async t => {
  const timeout = await fixture(t, async () => {}, { requestTimeoutMs: 10 });
  const timed = await timeout.request(); assert.equal(timed.status, 504); assert.equal((await timed.json()).error.code, 'cursor_timeout');
  assert.equal(timeout.provider.activeRuns, 0); assert.ok(timeout.cancelled.length > 0);
  for (const kind of ['createGate', 'sendGate']) {
    let release;
    const gate = new Promise(resolveGate => { release = resolveGate; });
    const f = await fixture(t, async () => {}, { [kind]: gate }), abort = new AbortController();
    const response = await f.request({ ...base, stream: true }, abort.signal), reading = response.text();
    while (kind === 'createGate' ? !f.created.length : !f.sends.length) await tick();
    abort.abort(); release(); await reading; await tick();
    assert.ok(f.closed.length > 0); assert.equal(f.provider.activeRuns, 0);
    if (kind === 'createGate') assert.equal(f.sends.length, 0); else assert.ok(f.cancelled.length > 0);
  }
});

test('base64 and URL images use public SDKImage structures and invalid image data fails before SDK creation', async t => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const f = await fixture(t, async context => { context.text('Image.'); context.finish(); });
  const response = await f.request({ ...base, input: [{ role: 'user', content: [
    { type: 'input_text', text: 'Describe' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` },
    { type: 'input_image', image_url: 'https://example.com/image.png' }] }] });
  assert.equal(response.status, 200); await response.json();
  assert.deepEqual(f.sends[0].message.images, [{ data: png, mimeType: 'image/png' }, { url: 'https://example.com/image.png' }]);
  const invalid = await f.request({ ...base, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,bm90IGFuIGltYWdl' }] }] });
  assert.equal(invalid.status, 400); assert.equal(f.created.length, 1);
  assert.match((await invalid.json()).error.message, /图片/);
});

test('cancelAll invalidates requests waiting for credential or catalog metadata before any SDK call', async t => {
  for (const method of ['credential', 'getModels']) {
    const f = await fixture(t, async context => { context.text('Fresh login.'); context.finish(); });
    const previous = f.service[method]; let release, started;
    const waiting = new Promise(resolveWaiting => { started = resolveWaiting; });
    const gate = new Promise(resolveGate => { release = resolveGate; });
    f.service[method] = async () => { started(); await gate; return previous(); };
    const request = f.request(); await waiting; await f.provider.cancelAll(); release();
    const response = await request; assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'cursor_session_cancelled');
    assert.equal(f.created.length, 0); assert.equal(f.sends.length, 0);
    f.service[method] = previous;
    const fresh = await f.request(); assert.equal(fresh.status, 200); await fresh.json();
  }
});

test('a resumed HTTP clears the old idle timer while the SDK run continues processing', async t => {
  const f = await fixture(t, async context => {
    await context.call(calledTool(context), { path: 'x' });
    await new Promise(resolveWait => setTimeout(resolveWait, 45)); context.text('Done.'); context.finish();
  }, { idleTimeoutMs: 20 });
  const first = await (await f.request()).json(), call = first.output.find(item => item.type === 'function_call');
  const second = await f.request({ ...base, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'ok' }]) });
  assert.equal(second.status, 200); await second.json(); assert.deepEqual(f.cancelled, []);
});

test('completed SDK checkpoints resume after bridge restart with exact public store/options and no prompt copy in the index', async t => {
  const f = await fixture(t, async context => { context.text('Private answer content.'); context.finish(); }, { realCheckpoint: true });
  const first = await (await f.request()).json(), root = join(f.directory, 'cursor-sdk', 'resume');
  let files = await readdir(root); assert.equal(files.length, 1);
  const index = await readFile(join(root, files[0]), 'utf8');
  for (const secret of ['cursor-fixture-key', base.instructions, 'Read the file.', 'Private answer content.']) assert.equal(index.includes(secret), false);
  assert.equal(JSON.parse(index).historyCount, 2); assert.equal((await f.provider.status()).recoverableSessions, 1);
  const originalOptions = f.created[0], originalAgent = JSON.parse(index).agentId;
  await f.provider.close(); assert.equal((await readdir(root)).length, 1);
  const next = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk });
  t.after(() => next.close());
  const input = history(first, [{ role: 'user', content: 'Second turn only.' }]);
  const response = await next.request({ path: '/responses', body: { ...base, input } }), second = await response.json();
  assert.equal(response.status, 200); assert.equal(f.resumed.length, 1); assert.equal(f.resumed[0].agentId, originalAgent);
  assert.deepEqual(f.resumed[0].options.tools, ['mcp']); assert.deepEqual(f.resumed[0].options.local.settingSources, []);
  assert.equal(f.resumed[0].options.local.cwd, originalOptions.local.cwd);
  assert.equal(f.resumed[0].options.systemPrompt, base.instructions);
  assert.deepEqual(f.sends[1].message, { text: 'Second turn only.' }); assert.equal(f.sends.length, 2);
  files = await readdir(root); assert.equal(files.length, 1); assert.equal(JSON.parse(await readFile(join(root, files[0]), 'utf8')).stateHashes.length, 2);
  await next.close();
  const last = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk }); t.after(() => last.close());
  const replay = await last.request({ path: '/responses', body: { ...base, input } }); assert.equal(replay.status, 409);
  const final = await last.request({ path: '/responses', body: { ...base, input: [...input, ...second.output, { role: 'user', content: 'Third turn.' }] } });
  assert.equal(final.status, 200); await final.json(); assert.equal(f.resumed.length, 2);
  assert.deepEqual(f.sends.at(-1).message, { text: 'Third turn.' }); await last.close();
});

test('logout permanently invalidates completed recovery handles and pending tool callbacks remain unrecoverable', async t => {
  for (const pending of [false, true]) {
    const f = await fixture(t, async context => {
      if (pending) await context.call(calledTool(context), { path: 'x' });
      context.text('Done.'); context.finish();
    }, { realCheckpoint: true });
    const first = await (await f.request()).json();
    if (pending) await f.provider.close(); else { await f.provider.cancelAll(); await f.provider.close(); }
    const next = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk }); t.after(() => next.close());
    const call = first.output.find(item => item.type === 'function_call');
    const output = pending ? { type: 'function_call_output', call_id: call.call_id, output: 'late' } : { role: 'user', content: 'After logout' };
    const response = await next.request({ path: '/responses', body: { ...base, input: history(first, [output]) } });
    assert.equal(response.status, 409); assert.equal(f.resumed.length, 0); await next.close();
  }
});

test('completed recovery rejects expired, tampered, cross-account, cross-model and changed-system handles before SDK resume', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { realCheckpoint: true });
  const first = await (await f.request()).json(), root = join(f.directory, 'cursor-sdk', 'resume');
  const file = join(root, (await readdir(root))[0]), saved = JSON.parse(await readFile(file, 'utf8'));
  await f.provider.close();
  const input = history(first, [{ role: 'user', content: 'Next' }]);
  for (const change of [
    { data: { storeSession: '../outside' }, status: 409 }, { data: { expiresAt: Date.now() - 1 }, status: 409 },
    { data: { historyHash: '0'.repeat(64) }, status: 409 }, { data: { authHash: '0'.repeat(64) }, status: 403 },
    { body: { model: 'Cursor-grok-4.7' }, status: 403 }, { body: { instructions: 'Changed system' }, status: 409 },
  ]) {
    await writeFile(file, JSON.stringify({ ...saved, ...change.data }));
    const provider = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk });
    const response = await provider.request({ path: '/responses', body: { ...base, input, ...change.body } });
    assert.equal(response.status, change.status); assert.equal(f.resumed.length, 0); await provider.close();
  }
});

test('state root and resume junctions cannot authorize SDK calls or delete files outside their original parent', async t => {
  for (const name of ['cursor-sdk', 'resume']) {
    const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { realCheckpoint: true });
    const first = await (await f.request()).json(); await f.provider.close();
    const outside = await mkdtemp(join(tmpdir(), 'bifrost-cursor-external-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const original = name === 'cursor-sdk' ? join(f.directory, 'cursor-sdk') : join(f.directory, 'cursor-sdk', 'resume');
    const target = join(outside, 'relocated');
    assert.equal(target.startsWith(outside), true); assert.equal(original.startsWith(f.directory), true);
    await rename(original, target); await symlink(target, original, process.platform === 'win32' ? 'junction' : 'dir');
    const externalResume = name === 'cursor-sdk' ? join(target, 'resume') : target;
    const files = await readdir(externalResume); assert.equal(files.length, 1);
    const externalFile = join(externalResume, files[0]), saved = await readFile(externalFile, 'utf8');
    const provider = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk });
    const resumed = await provider.request({ path: '/responses', body: { ...base, input: history(first, [{ role: 'user', content: 'Next' }]) } });
    assert.equal(resumed.status, 503); assert.equal((await resumed.json()).error.code, 'cursor_state_path_invalid');
    const fresh = await provider.request({ path: '/responses', body: base }); assert.equal(fresh.status, 503); await fresh.json();
    assert.equal(f.created.length, 1); assert.equal(f.resumed.length, 0);
    await assert.rejects(provider.cancelAll(), error => error.code === 'cursor_state_path_invalid');
    assert.equal(await readFile(externalFile, 'utf8'), saved); await provider.close();
    await unlink(original);
  }
});

test('an SDK explicitly returning a different requested effort or model fails instead of claiming the selection ran', async t => {
  for (const event of [true, false]) {
    const f = await fixture(t, async context => {
      const observed = { id: upstream, params: [{ id: 'effort', value: 'high' }] };
      if (event) context.emit({ type: 'system', model: observed });
      context.finish({ status: 'finished', model: observed });
    });
    f.setCatalog([{ id: upstream, parameters: [{ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }] }]);
    const response = await f.request({ ...base, reasoning: { effort: 'low' } });
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'cursor_model_mismatch');
  }
});

test('a vanished persistent lease cannot be consumed after metadata was loaded', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { realCheckpoint: true });
  const first = await (await f.request()).json(), root = join(f.directory, 'cursor-sdk', 'resume'); await f.provider.close();
  const provider = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk }); t.after(() => provider.close());
  const response = await provider.request({ path: '/responses', body: { ...base, stream: true, input: history(first, [{ role: 'user', content: 'Next' }]) } });
  await unlink(join(root, (await readdir(root))[0]));
  const body = await response.text(); assert.match(body, /cursor_session_invalid/); assert.equal(f.resumed.length, 0);
});

test('project rules retain original instruction text without replacing the Cursor system prompt or loading other settings', async t => {
  const f = await fixture(t, async context => { context.text('Compatible.'); context.finish(); }, { promptMode: 'project-rules' });
  const body = { ...base, input: [{ role: 'system', content: 'Original system requirements.' },
    { role: 'developer', content: 'Original developer requirements.' }, ...base.input] };
  const response = await f.request(body); assert.equal(response.status, 200); await response.json();
  const options = f.created[0], file = join(options.local.cwd, 'AGENTS.md'), rules = await readFile(file, 'utf8');
  for (const instruction of [base.instructions, 'Original system requirements.', 'Original developer requirements.']) assert.ok(rules.includes(instruction));
  assert.equal(rules.includes('Read the file.'), false);
  assert.equal(Object.hasOwn(options, 'systemPrompt'), false);
  assert.deepEqual(options.local.settingSources, ['project']); assert.deepEqual(options.tools, ['mcp']);
  assert.deepEqual(options.mcpServers, {}); assert.equal(Object.hasOwn(options.local, 'dirs'), false);
  assert.deepEqual(await readdir(options.local.cwd), ['AGENTS.md']);
  const capabilities = (await f.provider.status()).responsesCapabilities;
  assert.equal(capabilities.promptMode, 'project-rules'); assert.equal(capabilities.preservesSystemPromptPriority, false);
});

test('project rules keep client question callbacks in the original run and send a later user message only once', async t => {
  const question = { ...fn, name: 'request_user_input', description: 'Ask the user for a decision.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
  let reply;
  const f = await fixture(t, async context => {
    if (!reply) reply = await context.call(calledTool(context, question.name), { question: 'Which file?' }, 'sdk-question');
    context.text(reply.content[0].text); context.finish();
  }, { promptMode: 'project-rules' });
  const body = { ...base, tools: [question] }, first = await (await f.request(body)).json();
  const call = first.output.find(item => item.type === 'function_call');
  assert.equal(call.name, question.name); assert.equal(reply, undefined);
  const input = history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'Use main.txt' }]);
  const second = await (await f.request({ ...body, input })).json();
  assert.equal(second.status, 'completed'); assert.equal(f.sends.length, 1); assert.equal(f.created.length, 1);
  assert.deepEqual(reply, { content: [{ type: 'text', text: 'Use main.txt' }] });
  const third = await f.request({ ...body, input: [...input, ...second.output, { role: 'user', content: 'Continue.' }] });
  assert.equal(third.status, 200); await third.json();
  assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[1].message, { text: 'Continue.' });
});

test('project-rules checkpoints bind the mode and resume with the same verified rules file', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { realCheckpoint: true, promptMode: 'project-rules' });
  const first = await (await f.request()).json(), root = join(f.directory, 'cursor-sdk', 'resume');
  const file = join(root, (await readdir(root))[0]), index = JSON.parse(await readFile(file, 'utf8'));
  const cwd = f.created[0].local.cwd, rules = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
  assert.equal(index.version, 2); assert.equal(index.promptMode, 'project-rules'); await f.provider.close();
  const input = history(first, [{ role: 'user', content: 'Next.' }]);
  const strict = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk });
  const rejected = await strict.request({ path: '/responses', body: { ...base, input } });
  assert.equal(rejected.status, 409); assert.equal(f.resumed.length, 0); await strict.close();
  const next = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk, promptMode: 'project-rules' });
  t.after(() => next.close());
  const response = await next.request({ path: '/responses', body: { ...base, input } });
  assert.equal(response.status, 200); await response.json(); assert.equal(f.resumed.length, 1);
  const options = f.resumed[0].options;
  assert.equal(options.local.cwd, cwd); assert.deepEqual(options.local.settingSources, ['project']);
  assert.equal(Object.hasOwn(options, 'systemPrompt'), false); assert.equal(await readFile(join(cwd, 'AGENTS.md'), 'utf8'), rules);
  assert.deepEqual(f.sends.at(-1).message, { text: 'Next.' });
});

test('legacy system checkpoints never migrate silently into project rules', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { realCheckpoint: true });
  const first = await (await f.request()).json(), root = join(f.directory, 'cursor-sdk', 'resume');
  const file = join(root, (await readdir(root))[0]), index = JSON.parse(await readFile(file, 'utf8'));
  await f.provider.close(); delete index.promptMode; index.version = 1; await writeFile(file, JSON.stringify(index));
  const body = { ...base, input: history(first, [{ role: 'user', content: 'Next.' }]) };
  const compatible = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk, promptMode: 'project-rules' });
  const rejected = await compatible.request({ path: '/responses', body });
  assert.equal(rejected.status, 409); assert.equal(f.resumed.length, 0); await compatible.close();
  const strict = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk });
  t.after(() => strict.close()); const response = await strict.request({ path: '/responses', body });
  assert.equal(response.status, 200); await response.json();
  assert.equal(f.resumed[0].options.systemPrompt, base.instructions); assert.deepEqual(f.resumed[0].options.local.settingSources, []);
});

test('tampered, missing, linked or additional project settings cannot release a client callback', async t => {
  for (const change of ['changed', 'missing', 'linked', 'settings']) {
    const f = await fixture(t, async context => {
      await context.call(calledTool(context), { path: 'x' }, 'sdk-pending'); context.text('Unexpected.'); context.finish();
    }, { promptMode: 'project-rules' });
    const first = await (await f.request()).json(), call = first.output.find(item => item.type === 'function_call');
    const cwd = f.created[0].local.cwd, file = join(cwd, 'AGENTS.md'), outside = join(f.directory, 'outside-rules.md');
    if (change === 'changed') await writeFile(file, 'Changed instructions.');
    else if (change === 'missing') await unlink(file);
    else if (change === 'settings') await mkdir(join(cwd, '.cursor'));
    else { await writeFile(outside, base.instructions); await unlink(file); await link(outside, file); }
    const response = await f.request({ ...base, input: history(first, [{ type: 'function_call_output', call_id: call.call_id, output: 'late answer' }]) });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'cursor_project_rules_invalid');
    assert.equal(f.results.length, 0); assert.equal(f.sends.length, 1); assert.equal(f.provider.activeRuns, 0);
    if (change === 'linked') assert.equal(await readFile(outside, 'utf8'), base.instructions);
  }
});

test('project rule tampering rejects a completed checkpoint before SDK resume', async t => {
  const f = await fixture(t, async context => { context.text('Done.'); context.finish(); }, { promptMode: 'project-rules', realCheckpoint: true });
  const first = await (await f.request()).json(), cwd = f.created[0].local.cwd; await f.provider.close();
  await writeFile(join(cwd, 'AGENTS.md'), 'Changed instructions.');
  const next = new CursorResponsesProvider({ cursorService: f.service, stateDir: f.directory, sdkLoader: async () => f.sdk, promptMode: 'project-rules' });
  t.after(() => next.close());
  const response = await next.request({ path: '/responses', body: { ...base, input: history(first, [{ role: 'user', content: 'Next.' }]) } });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'cursor_project_rules_invalid');
  assert.equal(f.resumed.length, 0); assert.equal(f.sends.length, 1);
});
