import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCursorError } from '../src/cursor-errors.mjs';

test('only explicit system prompt denial is classified as the restricted SDK capability', () => {
  for (const message of ["[invalid_argument] unknown option '--system-prompt'", 'Permission denied: custom systemPrompt is not authorized']) {
    const result = describeCursorError(new Error(message));
    assert.equal(result.status, 403); assert.equal(result.code, 'cursor_system_prompt_denied');
  }
  assert.equal(describeCursorError(new Error('systemPrompt endpoint request timed out')).code, 'cursor_sdk_error');
  assert.equal(describeCursorError(new Error('systemPrompt service is not available')).code, 'cursor_sdk_error');
  assert.equal(describeCursorError(Object.assign(new Error('systemPrompt must be non-empty'), { name: 'ConfigurationError' })).code, 'cursor_configuration_error');
});

test('authentication, permissions, quota, configuration and network failures retain distinct safe classifications', () => {
  const cases = [
    [{ message: 'unauthorized' }, 401, 'cursor_auth_rejected'],
    [{ message: 'permission denied', status: 403 }, 403, 'cursor_permission_denied'],
    [{ message: 'unauthorized', status: 403 }, 403, 'cursor_permission_denied'],
    [{ name: 'AuthenticationError', message: 'Credential failed' }, 401, 'cursor_auth_rejected'],
    [{ code: 'unauthenticated' }, 401, 'cursor_auth_rejected'],
    [{ cause: { code: 7 } }, 403, 'cursor_permission_denied'],
    [{ code: 'resource_exhausted' }, 429, 'cursor_rate_limited'],
    [{ code: 'invalid_argument' }, 400, 'cursor_configuration_error'],
    [{ code: 'deadline_exceeded' }, 504, 'cursor_upstream_timeout'],
    [{ cause: { code: 14 } }, 503, 'cursor_upstream_unavailable'],
    [{ status: 401, code: 'unauthenticated', message: 'systemPrompt request failed: access token expired' }, 401, 'cursor_auth_rejected'],
    [{ status: 503, code: 'unavailable', message: 'systemPrompt service is not available' }, 503, 'cursor_upstream_unavailable'],
    [{ status: 429, message: 'systemPrompt access limit exceeded' }, 429, 'cursor_rate_limited'],
  ];
  for (const [error, status, code] of cases) {
    const result = describeCursorError(error); assert.equal(result.status, status); assert.equal(result.code, code);
    assert.equal(result.code === 'cursor_system_prompt_denied', false);
  }
});

test('raw SDK text, credentials, paths, URLs and cause cycles never leave the classifier', () => {
  const secret = 'PRIVATE_FIXTURE_CREDENTIAL', prompt = 'PRIVATE_FIXTURE_PROMPT';
  const error = Object.assign(new Error(`denied ${secret} ${prompt} https://private.invalid/request C:\\private\\fixture`), { code: 'private-upstream-code' });
  error.cause = error;
  const output = describeCursorError(error), text = JSON.stringify(output);
  assert.deepEqual(Object.keys(output).sort(), ['code', 'message', 'status']);
  for (const value of [secret, prompt, 'private.invalid', 'private-upstream-code', 'fixture']) assert.equal(text.includes(value), false);
  assert.equal(output.status, 502); assert.equal(output.code, 'cursor_sdk_error');
});
