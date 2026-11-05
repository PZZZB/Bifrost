import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { CODEBUDDY_PROTOCOL_CHECKS, describeCodeBuddyProtocolCheck, normalizeCodeBuddySourceDiagnostics } from '../src/codebuddy-source-diagnostics.mjs';
import { RequestDiagnostics, classifyDiagnosticFailure } from '../src/request-diagnostics.mjs';

const code = 'codebuddy_upstream_protocol_error';
const model = 'CodeBuddy-hy4std';
const tool = { name: 'offline_read', input_schema: { type: 'object', properties: {} } };
const secondTool = { name: 'offline_second', input_schema: { type: 'object', properties: {} } };
const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const text = chunk({ role: 'assistant', content: 'Fixture progress.' });
const stop = chunk({}, 'stop');
const call = (options = {}) => ({ index: 0, id: 'offline_call', type: 'function',
  function: { name: tool.name, arguments: '{}' }, ...options });
const calls = (...values) => chunk({ tool_calls: values });
const PRIVATE = 'PRIVATE_PROVIDER_DATA_NOT_FOR_DIAGNOSTICS';
const privateFree = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /PRIVATE_|Bearer|secret-tool|private-call|rawArguments/);
const frame = value => Buffer.from(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);

function source(values, raw) {
  const bytes = raw ?? Buffer.concat(values.map(frame)); let sent = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (sent) controller.close(); else { sent = true; controller.enqueue(bytes); }
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(values, options = {}) {
  const client = { status: async () => ({ authenticated: true, identity: { uid: 'offline-protocol-diagnostics' } }),
    modelCatalog: async () => [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }],
    chatCompletions: async () => source(values, options.raw) };
  const provider = new CodeBuddyProvider({ client, loadThinkingState: () => options.state ?? new CodeBuddyThinkingState({ key: Buffer.alloc(32, 19) }) });
  return { provider,
    request: (stream, overrides = {}) => provider.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify({ model,
      stream, max_tokens: 64, messages: [{ role: 'user', content: 'Offline protocol fixture.' }], tools: [tool, secondTool], ...overrides })) }) };
}
const events = wire => wire.split(/\r?\n\r?\n/).filter(Boolean).map(value => JSON.parse(value.split(/\r?\n/)
  .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));
async function sourceError(f, stream, overrides) {
  const response = await f.request(stream, overrides), wire = await response.text();
  privateFree(wire); assert.equal(response.status, stream ? 200 : 502);
  const result = stream ? events(wire).at(-1).error : JSON.parse(wire).error;
  assert.equal(result.code, code); return result;
}

test('protocol check metadata accepts only fixed checks and generates its own description', () => {
  const sourceDiagnostics = normalizeCodeBuddySourceDiagnostics(code, { version: 1, kind: 'codebuddy_protocol_check',
    check: 'tool_not_declared', description: PRIVATE, toolName: PRIVATE, rawArguments: PRIVATE,
    observation: { valueType: 'string', length: 18, count: 2, limit: 128, name: PRIVATE, value: PRIVATE, index: PRIVATE } });
  assert.deepEqual(sourceDiagnostics, { version: 1, kind: 'codebuddy_protocol_check', check: 'tool_not_declared',
    description: CODEBUDDY_PROTOCOL_CHECKS.tool_not_declared, observation: { valueType: 'string', length: 18, count: 2, limit: 128 } });
  privateFree(sourceDiagnostics);
  assert.deepEqual(describeCodeBuddyProtocolCheck('tool_not_declared', { valueType: 'string', length: 18, count: 2, limit: 128 }), sourceDiagnostics);
  for (const check of [PRIVATE, '__proto__', 'constructor', 'toString', 'TOOL_NOT_DECLARED', null, {}, []]) {
    assert.equal(describeCodeBuddyProtocolCheck(check), null);
    assert.equal(normalizeCodeBuddySourceDiagnostics(code, { version: 1, kind: 'codebuddy_protocol_check', check }), null);
  }
  for (const other of ['codebuddy_unsupported_delta', 'codebuddy_upstream_failed', 'claude_upstream_error', 'invalid_request', null]) {
    assert.equal(normalizeCodeBuddySourceDiagnostics(other, sourceDiagnostics), null);
  }
  assert.equal(normalizeCodeBuddySourceDiagnostics(code, { version: 1, kind: 'codebuddy_delta_shape', fields: [{ field: 'name', type: 'string' }] }), null);
  assert.equal(normalizeCodeBuddySourceDiagnostics(code, { ...sourceDiagnostics, version: 2 }), null);
  assert.equal(normalizeCodeBuddySourceDiagnostics(code, Object.create(sourceDiagnostics)), null);
  assert.deepEqual(describeCodeBuddyProtocolCheck('content_type', { valueType: PRIVATE, length: -1, count: Infinity, limit: 0.5 }),
    { version: 1, kind: 'codebuddy_protocol_check', check: 'content_type', description: CODEBUDDY_PROTOCOL_CHECKS.content_type });
  const broken = { version: 1, kind: 'codebuddy_protocol_check', get check() { throw new Error(PRIVATE); } };
  assert.equal(normalizeCodeBuddySourceDiagnostics(code, broken), null);
});

const cases = [
  ['sse_json', [PRIVATE]],
  ['choices_shape', [{ choices: { secret: PRIVATE } }]],
  ['choices_count', [{ choices: [{ delta: {} }, { delta: {} }] }]],
  ['usage_only_chunk', [{ choices: [], usage: PRIVATE }]],
  ['choice_shape', [{ choices: [PRIVATE] }]],
  ['choice_index', [{ choices: [{ index: 3, delta: {} }] }]],
  ['delta_shape', [{ choices: [{ index: 0, delta: [PRIVATE] }] }]],
  ['delta_after_finish', [text, stop, chunk({ content: PRIVATE })]],
  ['duplicate_finish_reason', [text, stop, stop]],
  ['assistant_role', [chunk({ role: PRIVATE })]],
  ['assistant_refusal', [chunk({ refusal: PRIVATE })]],
  ['reasoning_type', [chunk({ reasoning_content: { rawArguments: PRIVATE } })]],
  ['content_type', [chunk({ content: [PRIVATE] })]],
  ['tool_calls_type', [chunk({ tool_calls: { rawArguments: PRIVATE } })]],
  ['tools_forbidden', [calls(call())], { tool_choice: { type: 'none' } }],
  ['tool_call_shape', [calls(PRIVATE)]],
  ['tool_call_index', [calls(call({ index: 128 }))]],
  ['tool_call_type', [calls(call({ type: PRIVATE }))]],
  ['tool_function_shape', [calls(call({ function: [PRIVATE] }))]],
  ['tool_id_fragment_type', [calls(call({ id: { rawArguments: PRIVATE } }))]],
  ['tool_name_fragment_type', [calls(call({ function: { name: [PRIVATE] } }))]],
  ['tool_arguments_fragment_type', [calls(call({ function: { arguments: { rawArguments: PRIVATE } } }))]],
  ['tool_id_size', [calls(call({ id: 'private-call-'.repeat(30) }))]],
  ['tool_name_size', [calls(call({ function: { name: 'secret-tool-'.repeat(15), arguments: '{}' } }))]],
  ['tool_finish_without_calls', [text, chunk({}, 'tool_calls'), '[DONE]']],
  ['stop_finish_with_calls', [calls(call()), stop, '[DONE]']],
  ['required_tool_missing', [text, stop, '[DONE]'], { tool_choice: { type: 'any' } }],
  ['tool_index_sequence', [calls(call({ index: 1 })), chunk({}, 'tool_calls'), '[DONE]']],
  ['tool_id_invalid', [calls(call({ id: `private-call invalid ${PRIVATE}` })), chunk({}, 'tool_calls'), '[DONE]']],
  ['tool_id_duplicate', [calls(call(), call({ index: 1 })), chunk({}, 'tool_calls'), '[DONE]']],
  ['tool_not_declared', [calls(call({ function: { name: 'secret-tool-not-declared', arguments: '{}' } })), chunk({}, 'tool_calls'), '[DONE]']],
  ['forced_tool_mismatch', [calls(call({ function: { name: secondTool.name, arguments: '{}' } })), chunk({}, 'tool_calls'), '[DONE]'], { tool_choice: { type: 'tool', name: tool.name } }],
  ['tool_arguments_json', [calls(call({ function: { name: tool.name, arguments: `{"rawArguments":"${PRIVATE}"` } })), chunk({}, 'tool_calls'), '[DONE]']],
  ['tool_arguments_object', [calls(call({ function: { name: tool.name, arguments: JSON.stringify([PRIVATE]) } })), chunk({}, 'tool_calls'), '[DONE]']],
  ['data_after_done', [text, stop, '[DONE]', chunk({ content: PRIVATE })]],
];
for (const stream of [true, false]) for (const [check, frames, overrides] of cases) {
  test(`Messages ${stream ? 'SSE' : 'JSON'} identifies ${check} without exposing upstream data`, async () => {
    const error = await sourceError(fixture(frames), stream, overrides);
    assert.equal(error.sourceDiagnostics.check, check);
    assert.equal(error.sourceDiagnostics.description, CODEBUDDY_PROTOCOL_CHECKS[check]);
    assert.equal(error.sourceDiagnostics.kind, 'codebuddy_protocol_check');
  });
}

test('SSE framing and UTF-8 checks are explicit even when no content event could be decoded', async () => {
  for (const [check, raw] of [
    ['sse_event_truncated', Buffer.from('data: {"PRIVATE_TRUNCATED_DATA":')],
    ['sse_utf8', Buffer.from([0xff])],
    ['sse_utf8', Buffer.from([0xe4, 0xb8])],
    ['sse_event_size', Buffer.from(':' + 'x'.repeat(16 * 1024 * 1024))],
  ]) {
    const error = await sourceError(fixture([], { raw }), true);
    assert.equal(error.sourceDiagnostics.check, check);
  }
});

test('metadata and thinking sealing checks do not reveal opaque state or local key failures', async () => {
  const failing = { seal() { throw new Error(PRIVATE); } };
  const sealMetadata = await sourceError(fixture([chunk({ extra_fields: { rawArguments: PRIVATE } })], { state: failing }), true);
  assert.equal(sealMetadata.sourceDiagnostics.check, 'metadata_seal');
  const sealThinking = await sourceError(fixture([chunk({ reasoning_content: PRIVATE }), text], { state: failing }), true);
  assert.equal(sealThinking.sourceDiagnostics.check, 'state_seal');
});

test('compaction precondition failure has an explicit guard without serializing the proposed summary', async () => {
  const f = fixture([text, stop, '[DONE]']), response = await f.request(false); await response.json();
  assert.throws(() => response.bridgeSealCompaction(PRIVATE), error => {
    assert.equal(error.code, code); assert.equal(error.sourceDiagnostics.check, 'compaction_incomplete');
    privateFree(JSON.stringify({ code: error.code, message: error.message, sourceDiagnostics: error.sourceDiagnostics })); return true;
  });
});

test('a protocol check survives Responses conversion, diagnostic persistence, reopening and export', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-protocol-check-'))), path = join(root, 'diagnostics.jsonl');
  const journal = await RequestDiagnostics.open({ path });
  let reopened;
  t.after(async () => { await journal.close(); await reopened?.close(); await rm(root, { recursive: true, force: true }); });
  const f = fixture([calls(call({ function: { name: 'secret-tool-not-declared', arguments: '{}' } })), chunk({}, 'tool_calls'), '[DONE]']);
  const provider = new CodeBuddyResponsesProvider({ provider: f.provider });
  const response = await provider.request({ path: '/responses', body: Buffer.from(JSON.stringify({ model, stream: true, store: false,
    input: [{ role: 'user', content: 'Offline protocol fixture.' }], tools: [
      { type: 'function', name: 'declared_fixture_tool', strict: false, parameters: { type: 'object', properties: {} } },
    ] })) });
  const wire = await response.text(), terminal = events(wire).at(-1); privateFree(wire);
  assert.equal(response.status, 200); assert.equal(terminal.type, 'response.failed');
  assert.deepEqual(terminal.response.output, []);
  const failure = classifyDiagnosticFailure(terminal.response.error, { httpStatus: 200, stage: 'stream' });
  assert.equal(failure.errorCode, code); assert.equal(failure.sourceDiagnostics.check, 'tool_not_declared');
  const entry = { requestId: randomUUID(), time: '2026-11-05T21:00:00.000Z', account: 'CodeBuddy', model,
    status: 'failed', httpStatus: 200, durationMs: 10, ...failure };
  await journal.record(entry); await journal.close();
  const untrusted = JSON.parse(await readFile(path, 'utf8'));
  untrusted.sourceDiagnostics.description = PRIVATE;
  untrusted.sourceDiagnostics.observation.toolName = PRIVATE;
  await writeFile(path, JSON.stringify(untrusted) + '\n');
  reopened = await RequestDiagnostics.open({ path });
  const saved = reopened.detail(entry.requestId);
  assert.equal(saved.sourceDiagnostics.description, CODEBUDDY_PROTOCOL_CHECKS.tool_not_declared);
  assert.equal(saved.sourceDiagnostics.check, 'tool_not_declared');
  privateFree(await readFile(path, 'utf8')); privateFree(reopened.exportReport(entry.requestId));
});
