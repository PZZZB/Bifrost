import test from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { codeBuddySourceError } from '../src/codebuddy-source-errors.mjs';
import { classifyDiagnosticFailure, normalizeDiagnosticRecord } from '../src/request-diagnostics.mjs';

const model = 'CodeBuddy-hy4std';
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const prefix = [chunk({ role: 'assistant', reasoning_content: 'PRIVATE_THINKING' }), chunk({ content: 'Checking.' })];
const wireFrame = value => new TextEncoder().encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
function source(frames, disconnect = false) {
  let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at < frames.length) controller.enqueue(wireFrame(frames[at++]));
    else if (disconnect) controller.error(new Error('PRIVATE_CONNECTION_DETAILS'));
    else controller.close();
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(reply) {
  const client = {
    status: () => ({ authenticated: true, identity: { uid: 'employee-one', username: 'employee' } }),
    modelCatalog: async () => [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }],
    chatCompletions: async request => reply(request),
  };
  const provider = new CodeBuddyResponsesProvider({ provider: new CodeBuddyProvider({ client,
    loadThinkingState: () => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 9) }) }) });
  return (stream, overrides = {}) => provider.request({ path: '/responses', body: Buffer.from(JSON.stringify({ model, stream,
    store: false, input: [{ role: 'user', content: 'Inspect without changing files.' }], ...overrides })) });
}

const probeTool = { type: 'function', name: 'read_only_format_probe', strict: false,
  parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
for (const stream of [true, false]) {
  test(`HY4 ${stream ? 'SSE' : 'JSON'} accepts its observed empty legacy placeholder while preserving real tool calls`, async () => {
    const request = fixture(({ body }) => source([
      chunk({ role: 'assistant', content: '', reasoning_content: '', function_call: null, tool_calls: [], extra_fields: null }),
      ...prefix,
      chunk({ tool_calls: [{ index: 0, id: 'real_hy4_call', type: 'function',
        function: { name: body.tools[0].function.name, arguments: '{"ok":true}' } }], function_call: { name: '', arguments: '' } }),
      chunk({ content: '', tool_calls: [], function_call: { name: '', arguments: '' } }, 'tool_calls'),
      chunk({ function_call: { name: '', arguments: '' } }),
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }, '[DONE]',
    ]));
    const response = await request(stream, { tools: [probeTool] }), wire = await response.text();
    const events = stream ? wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : [];
    const result = stream ? events.at(-1).response : JSON.parse(wire);
    assert.equal(response.status, 200); assert.equal(result.status, 'completed');
    const calls = result.output.filter(item => item.type === 'function_call');
    assert.equal(calls.length, 1); assert.equal(calls[0].name, probeTool.name); assert.equal(calls[0].call_id, 'real_hy4_call');
    assert.deepEqual(JSON.parse(calls[0].arguments), { ok: true }); assert.equal(result.usage.total_tokens, 28);
    assert.equal(result.output.find(item => item.type === 'message').content[0].text, 'Checking.');
    assert.doesNotMatch(wire, /PRIVATE_THINKING|"function_call"\s*:\s*\{/);
    if (stream) assert.equal(events.filter(event => event.type === 'response.output_item.done' && event.item.type === 'function_call').length, 1);
  });

  test(`HY4 ${stream ? 'SSE' : 'JSON'} cannot fabricate a tool call from an empty legacy placeholder`, async () => {
    const response = await fixture(() => source([...prefix,
      chunk({ function_call: { name: '', arguments: '' } }, 'tool_calls'), '[DONE]']))(stream, { tools: [probeTool] });
    const wire = await response.text(), data = stream
      ? JSON.parse(wire.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice(6)).response : JSON.parse(wire);
    assert.equal(data.error.code, 'codebuddy_upstream_protocol_error');
    if (stream) assert.deepEqual(data.output, []); else assert.equal(response.status, 502);
  });

  for (const value of [
    { name: 'PRIVATE_LEGACY_NAME', arguments: '{}' }, { name: '', arguments: 'PRIVATE_ARGUMENTS' },
    { name: '', arguments: '', future_content: 'PRIVATE_FUTURE_CONTENT' },
    { name: '', arguments: 0 }, [], 'PRIVATE_LEGACY_VALUE',
  ]) test(`HY4 ${stream ? 'SSE' : 'JSON'} rejects populated or extended legacy field ${JSON.stringify(value).length}`, async () => {
    const response = await fixture(() => source([...prefix, chunk({ function_call: value }), chunk({}, 'stop'), '[DONE]']))(stream);
    const wire = await response.text(), data = stream
      ? JSON.parse(wire.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice(6)).response : JSON.parse(wire);
    assert.equal(data.error.code, 'codebuddy_unsupported_delta'); assert.doesNotMatch(wire, /PRIVATE_LEGACY|PRIVATE_ARGUMENTS|PRIVATE_FUTURE/);
    if (stream) assert.deepEqual(data.output, []); else assert.equal(response.status, 502);
  });
}

const failures = [
  ['source error event', () => source([...prefix, { error: { code: 'claude_rate_limited', message: 'PRIVATE_PROVIDER_TEXT' } }]), 'codebuddy_upstream_failed'],
  ['failed finish', () => source([...prefix, { ...chunk({}, 'error'), message: 'PRIVATE_PROVIDER_TEXT', code: 502 }]), 'codebuddy_upstream_failed'],
  ['unsupported delta', () => source([...prefix, chunk({ reasoning_details: [{ text: 'PRIVATE_PROVIDER_TEXT' }] })]), 'codebuddy_unsupported_delta'],
  ['unsupported finish', () => source([...prefix, chunk({}, 'content_filter')]), 'codebuddy_unsupported_finish'],
  ['missing finish', () => source(prefix), 'codebuddy_upstream_truncated'],
  ['malformed frame', () => source([...prefix, '{PRIVATE_PROVIDER_TEXT']), 'codebuddy_upstream_protocol_error'],
  ['connection lost', () => source(prefix, true), 'codebuddy_upstream_connection_error'],
];
for (const [label, reply, code] of failures) for (const stream of [true, false]) {
  test(`HY4 ${stream ? 'SSE' : 'JSON'} retains safe category for ${label}`, async () => {
    const response = await fixture(reply)(stream);
    const wire = await response.text();
    const events = stream ? wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))) : null;
    const error = stream ? events.at(-1).response.error : JSON.parse(wire).error;
    assert.equal(error.code, code);
    assert.equal(error.message, codeBuddySourceError(code).message);
    assert.doesNotMatch(wire, /PRIVATE_THINKING|PRIVATE_PROVIDER_TEXT|PRIVATE_CONNECTION_DETAILS|claude_rate_limited/);
    if (stream) {
      assert.equal(response.status, 200);
      assert.equal(events.at(-1).type, 'response.failed');
      assert.ok(events.some(event => event.type === 'response.output_text.delta' && event.delta === 'Checking.'));
      assert.ok(events.every(event => event.type !== 'response.output_item.done'));
      assert.deepEqual(events.at(-1).response.output, []);
      assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
    } else assert.equal(response.status, codeBuddySourceError(code).status);
  });
}

test('CodeBuddy diagnostics retain only defined categories and reject prototype keys', () => {
  for (const [, , code] of failures) {
    const sourceError = codeBuddySourceError(code);
    const failure = classifyDiagnosticFailure({ code, message: 'PRIVATE_PROVIDER_TEXT' }, { httpStatus: 200, stage: 'stream' });
    assert.equal(failure.errorCode, code); assert.equal(failure.message, sourceError.message);
    const record = normalizeDiagnosticRecord({ requestId: '12345678-1234-1234-1234-123456789abc',
      time: '2026-11-05T05:51:28.207Z', account: 'CodeBuddy', model, status: 'failed', httpStatus: 200,
      durationMs: 40, failureStage: 'stream', errorCode: code, message: 'PRIVATE_PROVIDER_TEXT' });
    assert.equal(record.errorCode, code); assert.equal(record.message, sourceError.message);
    assert.equal(JSON.stringify(record).includes('PRIVATE_PROVIDER_TEXT'), false);
  }
  for (const code of [null, 3, {}, 'constructor', '__proto__', 'toString', 'codebuddy_unknown_error']) {
    assert.equal(codeBuddySourceError(code), null);
  }
  assert.equal(classifyDiagnosticFailure({ code: 'PRIVATE_PROVIDER_TEXT' }).errorCode, 'unknown_error');
  const sourceError = codeBuddySourceError('codebuddy_upstream_failed'); sourceError.message = 'MUTATED';
  assert.notEqual(codeBuddySourceError(sourceError.code).message, 'MUTATED');
});
