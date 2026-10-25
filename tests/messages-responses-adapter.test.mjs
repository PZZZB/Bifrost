import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';

const scope = '203cc356-cb05-4a8e-8f5e-363b768eb97e';
const request = { model: 'plain-provider-model', input: 'hello', store: false };
const reply = content => Response.json({ type: 'message', role: 'assistant', model: request.model, content, stop_reason: 'end_turn',
  usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } });
test('generic Responses conversion preserves native opaque thinking and real usage without a client or provider-specific alias', async () => {
  const calls = [];
  const content = [{ type: 'thinking', thinking: 'opaque native text', signature: 'opaque native signature' }, { type: 'redacted_thinking', data: 'opaque redacted data' }, { type: 'text', text: 'reply' }];
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async value => { calls.push(value); return reply(content); } });
  const response = await adapter.request({ body: request, scope }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.model, request.model);
  assert.equal(data.usage.input_tokens, 9); assert.equal(data.usage.output_tokens, 3); assert.equal(data.usage.input_tokens_details.cached_tokens, 2);
  assert.doesNotMatch(JSON.stringify(data), /opaque native|opaque redacted/);
  const history = { ...request, input: [...data.output, { role: 'user', content: 'continue' }] };
  assert.equal((await adapter.request({ body: history, scope })).status, 200);
  assert.deepEqual(calls[1].body.messages[0].content.slice(0, 2), content.slice(0, 2));
  const foreign = await adapter.request({ body: history, scope: '07334b69-7c47-42a3-985f-63971a306eca' });
  assert.equal(foreign.status, 409); assert.equal(calls.length, 2);
});
test('unsupported state/storage and parameters fail before dispatch; inherited effort uses explicit upstream defaults', async () => {
  let calls = 0, captured;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async value => { calls++; captured = value; return reply([{ type: 'text', text: 'reply' }]); } });
  for (const body of [{ ...request, store: true }, { ...request, previous_response_id: 'other-state' },
    { ...request, input: [{ type: 'reasoning', encrypted_content: 'foreign-state' }] }, { ...request, reasoning: { effort: 'made-up' } }]) {
    assert.ok((await adapter.request({ body, scope })).status >= 400);
  }
  assert.equal(calls, 0);
  const defaults = await adapter.request({ body: { ...request, reasoning: { effort: 'high' } }, scope });
  assert.equal(defaults.status, 200); const body = await defaults.json();
  assert.equal(body.reasoning.effort, undefined); assert.equal(captured.body.output_config, undefined); assert.equal(captured.body.thinking, undefined);
});
test('an upstream rejection causes exactly one dispatch and preserves a retry delay without exposing its body', async () => {
  let calls = 0;
  const adapter = new MessagesResponsesAdapter({ stateSecret: randomBytes(32).toString('base64url'), requestMessages: async () => {
    calls++; return new Response('PRIVATE_ERROR_BODY_WITH_ADDRESS', { status: 429, headers: { 'retry-after': '8' } });
  } });
  const response = await adapter.request({ body: request, scope }); assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '8'); assert.equal(calls, 1); assert.doesNotMatch(await response.text(), /PRIVATE_ERROR/);
});
