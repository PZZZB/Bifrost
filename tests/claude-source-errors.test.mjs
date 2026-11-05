import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeSourceError, classifyClaudeSourceError, classifyClaudeSourceException, readClaudeSourceError } from '../src/claude-source-errors.mjs';

const privateText = 'PRIVATE_SOURCE_ERROR_sk-secret_/Users/private/profile';
const assistant = [
  ['authentication_failed', 'claude_authentication_failed'], ['oauth_org_not_allowed', 'claude_oauth_org_not_allowed'],
  ['account_on_hold', 'claude_account_on_hold'], ['verification_required', 'claude_verification_required'],
  ['billing_error', 'claude_billing_error'], ['rate_limit', 'claude_rate_limited'], ['overloaded', 'claude_overloaded'],
  ['invalid_request', 'claude_invalid_request'], ['model_not_found', 'claude_model_not_found'],
  ['server_error', 'claude_server_error'], ['unknown', 'claude_source_unknown'],
  ['max_output_tokens', 'claude_output_limit'], ['cloud_credential_error', 'claude_cloud_credential_error'],
];

test('pinned SDK assistant errors and result subtypes map only to static source categories', () => {
  for (const [error, code] of assistant) {
    const value = classifyClaudeSourceError({ type: 'assistant', error, message: { content: [privateText] }, request_id: privateText });
    assert.deepEqual(value, claudeSourceError(code)); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SOURCE_ERROR|sk-secret|\/Users/);
  }
  for (const [subtype, code] of [
    ['error_during_execution', 'claude_execution_failed'], ['error_max_turns', 'claude_turn_limit'],
    ['error_max_budget_usd', 'claude_budget_limit'], ['error_max_structured_output_retries', 'claude_output_schema_failed'],
  ]) {
    assert.deepEqual(classifyClaudeSourceError({ type: 'result', subtype, is_error: true, errors: [privateText] }), claudeSourceError(code));
  }
  assert.equal(classifyClaudeSourceError({ type: 'result', subtype: 'success', is_error: true, result: privateText }).code, 'claude_execution_failed');
  assert.doesNotMatch(claudeSourceError('claude_invalid_request').message, /上下文|超窗|context/i);
});

test('normal packets and unknown categories are never inferred from error text', () => {
  for (const value of [null, {}, { type: 'assistant', message: { content: [privateText] } },
    { type: 'assistant', error: { code: 'rate_limit' } }, { type: 'assistant', error: privateText },
    { type: 'result', subtype: 'success', is_error: false }, { type: 'result', subtype: privateText, is_error: true },
    { type: 'error', error: { type: privateText, message: 'rate_limit authentication_failed context length' } },
    { type: 'error', error: { code: privateText, message: 'claude_rate_limited' } }]) {
    assert.equal(classifyClaudeSourceError(value), null);
  }
  for (const value of [undefined, null, {}, '__proto__', 'rate_limit', privateText, ' claude_rate_limited']) assert.equal(claudeSourceError(value), null);
  const modified = claudeSourceError('claude_rate_limited'); modified.message = privateText;
  assert.notEqual(claudeSourceError('claude_rate_limited').message, privateText);
});

test('known Messages error types and whitelisted source codes discard arbitrary source messages', () => {
  for (const [type, code] of [['rate_limit_error', 'claude_rate_limited'], ['invalid_request_error', 'claude_invalid_request'],
    ['api_error', 'claude_server_error'], ['authentication_error', 'claude_authentication_failed']]) {
    assert.deepEqual(classifyClaudeSourceError({ type: 'error', error: { type, message: privateText } }), claudeSourceError(code));
  }
  assert.deepEqual(classifyClaudeSourceError({ type: 'error', error: { type: 'api_error', code: 'claude_tool_session_missing', message: privateText } }),
    claudeSourceError('claude_tool_session_missing'));
});

test('exceptions use only explicit finite codes, types and numeric statuses, with cancellation taking priority', () => {
  for (const [fields, code] of [[{ status: 429 }, 'claude_rate_limited'], [{ type: 'authentication_error' }, 'claude_authentication_failed'],
    [{ code: 'ECONNRESET' }, 'claude_network_error'], [{ cause: { code: 'ETIMEDOUT', message: privateText } }, 'claude_network_error'],
    [{ code: 'claude_budget_limit' }, 'claude_budget_limit'], [{ code: 'rate_limit' }, 'claude_rate_limited'],
    [{ type: 'error_max_turns' }, 'claude_turn_limit'], [{ name: 'AbortError', status: 429 }, 'claude_request_interrupted'],
    [{ code: 'ABORT_ERR', type: 'rate_limit_error' }, 'claude_request_interrupted']]) {
    assert.deepEqual(classifyClaudeSourceException(Object.assign(new Error(privateText), fields)), claudeSourceError(code));
  }
  for (const value of [null, privateText, [], new Error('rate_limit authentication_failed 429 ' + privateText),
    { code: privateText, status: '429' }, { type: privateText, status: 999 }, { status: 429.5 },
    Object.defineProperty({}, 'code', { get() { throw new Error(privateText); } })]) {
    assert.equal(classifyClaudeSourceException(value), null);
  }
});

test('bounded HTTP error reads retain only a recognized source code and static message', async () => {
  const response = Response.json({ error: { code: 'claude_tool_session_missing', message: privateText, path: privateText }, key: privateText }, { status: 409 });
  assert.deepEqual(await readClaudeSourceError(response), claudeSourceError('claude_tool_session_missing'));
  for (const error of [{ code: privateText, message: 'claude_rate_limited' }, { type: 'rate_limit_error', message: privateText }, {}]) {
    assert.equal(await readClaudeSourceError(Response.json({ error })), null);
  }
  assert.equal(await readClaudeSourceError(Response.json({ error: { code: 'claude_authentication_failed' } }, { status: 409 })), null);
});

test('HTTP error JSON beyond eight KiB is cancelled without accepting a valid code at its beginning', async () => {
  let cancelled = false, pulls = 0;
  const bytes = Buffer.from(JSON.stringify({ error: { code: 'claude_rate_limited', message: privateText }, extra: '🙂'.repeat(3000) }));
  const response = new Response(new ReadableStream({ pull(controller) {
    pulls++; controller.enqueue(bytes);
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 429, headers: { 'content-type': 'application/json' } });
  assert.equal(await readClaudeSourceError(response), null); assert.equal(cancelled, true); assert.equal(pulls, 1);
});

test('non-JSON, oversized declarations, malformed JSON and invalid UTF-8 do not expose or classify their bodies', async () => {
  for (const response of [new Response(privateText), new Response('{"error":', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } })]) assert.equal(await readClaudeSourceError(response), null);
  let cancelled = false, pulls = 0;
  const response = new Response(new ReadableStream({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }),
    { headers: { 'content-type': 'application/json', 'content-length': '8193' } });
  assert.equal(await readClaudeSourceError(response), null); assert.equal(cancelled, true); assert.equal(pulls, 0);
});

test('aborting a stalled error body cancels its reader without requiring model inference', async () => {
  const abort = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }),
    { headers: { 'content-type': 'application/json' } });
  const pending = readClaudeSourceError(response, { signal: abort.signal });
  abort.abort(); assert.equal(await pending, null); assert.equal(cancelled, true);
});

test('a never-ending JSON error body reaches the internal deadline and is cancelled without accepting its code', { timeout: 6000 }, async () => {
  const abort = new AbortController(); let cancelled = false, fallback = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('{"error":{"code":"claude_tool_session_missing"}}')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 409, headers: { 'content-type': 'application/json' } });
  const timer = setTimeout(() => { fallback = true; abort.abort(); }, 4000);
  try { assert.equal(await readClaudeSourceError(response, { signal: abort.signal }), null); }
  finally { clearTimeout(timer); }
  assert.equal(cancelled, true); assert.equal(fallback, false);
});
