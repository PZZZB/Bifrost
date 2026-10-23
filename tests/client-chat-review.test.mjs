import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientChatAdapter } from '../src/client-chat.mjs';

const model = 'claude-codebuddy-opus-5-5';
const request = (stream = false) => ({ model, stream, messages: [{ role: 'user', content: 'Hello' }] });
const message = (extra = {}) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished', annotations: [] }], ...extra });
const completed = (output = [message()]) => ({ id: 'resp_fake', status: 'completed', output });
function eventResponse(events) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('an incomplete SSE event cannot become successful Chat stop merely because its nested status says completed', async () => {
  const adapter = new ClientChatAdapter({ requestResponses: async () => eventResponse([
    { type: 'response.incomplete', response: completed() },
  ]) });
  const response = await adapter.request({ body: request(true), scope: 'tenant-one' });
  const text = await response.text();
  assert.equal(text.includes('[DONE]'), false);
  assert.equal(text.includes('"finish_reason":"stop"'), false);
  assert.match(text, /"error"/);
  assert.equal(adapter.status().entries, 0);
});

test('a completed SSE event with nested incomplete status is rejected as contradictory protocol evidence', async () => {
  const adapter = new ClientChatAdapter({ requestResponses: async () => eventResponse([
    { type: 'response.completed', response: { ...completed(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ]) });
  const response = await adapter.request({ body: request(), scope: 'tenant-one' });
  assert.equal(response.status, 502);
  assert.equal(adapter.status().entries, 0);
});

test('unfinished message or reasoning output cannot seed a completed Chat continuation', async () => {
  for (const output of [
    [message({ status: 'in_progress' })],
    [message({ status: 'incomplete' })],
    [{ type: 'reasoning', status: 'in_progress', encrypted_content: 'unfinished-opaque-state', summary: [] }, message()],
  ]) {
    const adapter = new ClientChatAdapter({ requestResponses: async () => Response.json(completed(output)) });
    const response = await adapter.request({ body: request(), scope: 'tenant-one' });
    assert.equal(response.status, 502);
    assert.equal(adapter.status().entries, 0);
  }
});

test('incomplete function arguments retain length ending without becoming a resumable tool turn', async () => {
  const adapter = new ClientChatAdapter({ requestResponses: async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'function_call', id: 'fc_partial', call_id: 'call_partial', name: 'read_file', arguments: '{"path":', status: 'in_progress' }] }) });
  const response = await adapter.request({ body: request(), scope: 'tenant-one' });
  const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'length');
  assert.equal(adapter.status().entries, 0);
});
