import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStateCodec } from '../src/client-state.mjs';
import { ClientChatAdapter } from '../src/client-chat.mjs';

const scope = 'fd87a754-1056-4998-8d74-6f1d89c6ed8e';
const codec = new ClientStateCodec({ secret: 'offline-state-scope-secret'.repeat(3) });
const body = { model: 'B-gpt-6.1-sol', input: [{ role: 'user', content: 'Explicit input' }] };

test('shared upstream stored prompt references cannot bypass explicit client history', () => {
  for (const prompt of [{ id: 'pmpt_private_shared_prompt' }, { id: 'pmpt_private_shared_prompt', version: '1', variables: { name: 'other-user' } }]) {
    assert.throws(() => codec.input({ ...body, prompt }, scope), error => error.status === 400 && error.code === 'client_server_state_unsupported');
  }
  assert.deepEqual(codec.input(body, scope), { ...body, store: false });
});

const marker = 'PRIVATE_SHARED_ACCOUNT_DETAILS';
const providerError = () => ({ type: marker, message: marker, code: marker, param: marker,
  details: { account: marker }, stack: marker, cause: marker });
const rawUsage = { input_tokens: 12, output_tokens: 3, total_tokens: 15,
  input_tokens_details: { cached_tokens: 4, private_account: marker }, output_tokens_details: { reasoning_tokens: 1 }, secret: marker };
const safeUsage = { input_tokens: 12, output_tokens: 3, total_tokens: 15,
  input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } };
function eventResponse(events) {
  return new Response(events.map(event => `: provider detail ${marker}\nevent: ${event.type}\nid: ${marker}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}

test('failed JSON responses replace provider error fields while preserving failure status and valid token counts', async () => {
  const upstream = { id: 'resp_fixture', object: 'response', status: 'failed', error: providerError(), usage: rawUsage, output: [] };
  const response = await codec.response(Response.json(upstream), scope, body.model);
  assert.equal(response.status, 200);
  const serialized = await response.text(), result = JSON.parse(serialized);
  assert.equal(serialized.includes(marker), false);
  assert.equal(result.status, 'failed'); assert.equal(result.id, 'resp_fixture'); assert.deepEqual(result.output, []);
  assert.deepEqual(result.usage, safeUsage);
  assert.deepEqual(result.error, { type: 'server_error', code: 'client_upstream_failed',
    message: '所选模型未能完成请求，请联系管理员查看诊断。', param: null });
  assert.equal(upstream.error.message, marker);
});

test('ordinary JSON error envelopes expose only the rebuilt error and whitelisted usage', async () => {
  const response = await codec.response(Response.json({ error: providerError(), vendor_debug: marker, usage: rawUsage }), scope, body.model);
  const serialized = await response.text(), result = JSON.parse(serialized);
  assert.equal(serialized.includes(marker), false); assert.deepEqual(Object.keys(result).sort(), ['error', 'usage']);
  assert.equal(result.error.code, 'client_upstream_failed'); assert.deepEqual(result.usage, safeUsage);
});

test('HTTP 200 failed SSE frames remove raw error values and error metadata without losing terminal evidence or usage', async () => {
  const upstream = eventResponse([{ type: 'response.failed', sequence_number: 9,
    response: { id: 'resp_fixture', object: 'response', status: 'failed', error: providerError(), output: [], usage: rawUsage } }]);
  const response = await codec.response(upstream, scope, body.model), serialized = await response.text();
  assert.equal(response.status, 200); assert.equal(serialized.includes(marker), false); assert.match(serialized, /^event: response.failed\n/);
  const event = JSON.parse(serialized.split('\n').find(line => line.startsWith('data:')).slice(6));
  assert.equal(event.type, 'response.failed'); assert.equal(event.sequence_number, 9); assert.equal(event.response.status, 'failed');
  assert.equal(event.response.error.code, 'client_upstream_failed'); assert.deepEqual(event.response.usage, safeUsage);
});

test('top-level and nested error SSE shapes are rebuilt without private provider fields', async () => {
  for (const event of [{ ...providerError(), type: 'error', sequence_number: 5, vendor_private: marker, usage: rawUsage },
    { type: 'response.error', sequence_number: 6, error: providerError(), vendor_private: marker, usage: rawUsage }]) {
    const response = await codec.response(eventResponse([event]), scope, body.model), serialized = await response.text();
    assert.equal(serialized.includes(marker), false);
    const sanitized = JSON.parse(serialized.split('\n').find(line => line.startsWith('data:')).slice(6));
    assert.equal(sanitized.type, event.type); assert.equal(sanitized.sequence_number, event.sequence_number);
    assert.equal((sanitized.error ?? sanitized).code, 'client_upstream_failed');
    assert.deepEqual(sanitized.usage, safeUsage);
  }
});

test('sanitized failure remains a Chat stream error and cannot produce successful DONE or cache state', async () => {
  for (const event of [{ type: 'error', message: marker, code: marker, param: marker },
    { type: 'response.failed', response: { status: 'failed', error: providerError(), output: [], usage: rawUsage } }]) {
    const chat = new ClientChatAdapter({ requestResponses: async () => codec.response(eventResponse([event]), scope, body.model) });
    const response = await chat.request({ body: { model: body.model, stream: true, messages: [{ role: 'user', content: 'Hello' }] }, scope });
    const serialized = await response.text();
    assert.equal(serialized.includes(marker), false); assert.equal(serialized.includes('[DONE]'), false);
    assert.match(serialized, /"error"/); assert.equal(chat.status().entries, 0);
  }
});

test('normal model text is preserved; error filtering does not alter conversation output', async () => {
  const upstream = { object: 'response', status: 'completed', error: null, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: marker }] }] };
  const result = await (await codec.response(Response.json(upstream), scope, body.model)).json();
  assert.equal(result.output[0].content[0].text, marker); assert.equal(result.error, null); assert.equal(result.status, 'completed');
});
