import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWire } from '../src/routing/desktop-wire.mjs';

const wire = new DesktopWire({ secret: 'wire-test-private-secret-'.repeat(3) });
const context = { id: 'remote/bifrost/Claude-sonnet', scope: '12d1704f-59be-4ae7-b28a-0f652f530f40', protocol: 'messages' };
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
function streaming(values) {
  const bytes = Buffer.from(values.map(event).join('')); let at = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (at === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(at, at + 3)); at = Math.min(bytes.length, at + 3);
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
test('Messages opaque state remains opaque, bound to source/model/auth/session/protocol, without rewriting tool JSON', async () => {
  const content = [{ type: 'thinking', thinking: 'summary', signature: 'opaque-upstream-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted-data' },
    { type: 'tool_use', id: 'call1', name: 'test', input: { model: 'user-tool-data', signature: 'user-tool-data' } }];
  const response = await wire.response(Response.json({ type: 'message', model: 'Claude-sonnet', content }), context);
  const data = await response.json(); assert.equal(data.model, context.id);
  assert.notEqual(data.content[0].signature, content[0].signature); assert.notEqual(data.content[1].data, content[1].data);
  assert.deepEqual(data.content[2], content[2]);
  const history = { model: context.id, messages: [{ role: 'assistant', content: data.content }] };
  assert.deepEqual(wire.input(history, context).messages[0].content, content);
  assert.throws(() => wire.input(history, { ...context, id: 'local/codebuddy/CodeBuddy-internal' }), error => error.status === 409);
  assert.throws(() => wire.input(history, { ...context, scope: '43b5525b-42f5-4e58-bc6e-6ed094b55bc2' }), error => error.status === 409);
  assert.throws(() => wire.input({ messages: [{ role: 'assistant', content }] }, context), error => error.status === 409);
});
test('split SSE signature deltas are sealed as one complete state and usage/terminal events survive', async () => {
  const values = [
    { type: 'message_start', message: { id: 'm1', model: 'Claude-sonnet' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary 🙂' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'second' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ];
  const response = await wire.response(streaming(values), context);
  const text = await response.text();
  const output = text.trim().split('\n\n').map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5)));
  assert.equal(output[0].message.model, context.id); assert.equal(output.at(-1).type, 'message_stop');
  const signatures = output.filter(value => value.delta?.type === 'signature_delta'); assert.equal(signatures.length, 1);
  const body = wire.input({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: signatures[0].delta.signature }] }] }, context);
  assert.equal(body.messages[0].content[0].signature, 'first-second');
  assert.deepEqual(output.find(value => value.type === 'message_delta').usage, { output_tokens: 8 });
  assert.doesNotMatch(text, /first-|second/);
});
test('Responses envelopes map the public model and refuse replay across source or session without opening vendor state', async () => {
  const ctx = { ...context, protocol: 'responses' };
  const reply = await wire.response(Response.json({ object: 'response', model: 'native-id',
    output: [{ type: 'reasoning', encrypted_content: 'opaque-remote-response-state' }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }), ctx);
  const data = await reply.json(); assert.equal(data.model, ctx.id);
  const request = { model: ctx.id, input: data.output };
  assert.equal(wire.input(request, ctx).input[0].encrypted_content, 'opaque-remote-response-state');
  assert.throws(() => wire.input(request, { ...ctx, id: 'local/codebuddy/other-model' }), error => error.status === 409);
  const events = await wire.response(streaming([{ type: 'response.completed', response: { model: 'native-id', output: data.output.slice(1) } }]), ctx);
  assert.match(await events.text(), /remote\/bifrost\/Claude-sonnet/);
});
test('canceling a transformed stream cancels its upstream, and incomplete signatures or malformed streams fail closed', async () => {
  let canceled = false;
  const upstream = new Response(new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from(': keepalive\n\n')); }, cancel() { canceled = true; } }, { highWaterMark: 0 }),
    { headers: { 'content-type': 'text/event-stream' } });
  const response = await wire.response(upstream, context); await response.body.cancel(); assert.equal(canceled, true);
  const unfinished = await wire.response(streaming([{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', signature: '' } }]), context);
  await assert.rejects(unfinished.text(), error => error.code === 'desktop_upstream_protocol');
  await assert.rejects(wire.response(new Response('<html>provider error</html>', { status: 503 }), context), error => error.status === 502);
});

test('self-describing Responses state authenticates public routing hints and its item kind for reasoning and compaction', async () => {
  const prefix = 'wire-remote-state:', described = new DesktopWire({ secret: 'wire-test-private-secret-'.repeat(3), prefix, selfDescribingState: true });
  const ctx = { ...context, protocol: 'responses' }, input = [
    { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'PRIVATE_INNER_THINKING_TOKEN' },
    { type: 'compaction', id: 'cmp_test', encrypted_content: 'PRIVATE_INNER_COMPACTION_TOKEN' },
  ];
  const data = await (await described.response(Response.json({ output: input }), ctx)).json();
  const original = structuredClone(data);
  for (const [index, item] of data.output.entries()) {
    assert.ok(item.encrypted_content.startsWith(prefix + 'v2.'));
    assert.deepEqual(described.stateHint(item.encrypted_content), { version: 2, model: ctx.id, protocol: 'responses', kind: item.type });
    assert.equal(described.openState(item.encrypted_content, ctx, { kind: item.type }), input[index].encrypted_content);
    const packet = JSON.parse(Buffer.from(item.encrypted_content.slice((prefix + 'v2.').length), 'base64url'));
    assert.deepEqual(Object.keys(packet).sort(), ['kind', 'model', 'protocol', 'state', 'version']);
    assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_INNER/);
    for (const changes of [{ model: 'remote/bifrost/Claude-opus' }, { protocol: 'messages' },
      { kind: item.type === 'reasoning' ? 'compaction' : 'reasoning' }, { version: 3 }, { unknown: true }]) {
      const edited = prefix + 'v2.' + Buffer.from(JSON.stringify({ ...packet, ...changes })).toString('base64url');
      assert.throws(() => described.openState(edited, { ...ctx, id: changes.model ?? ctx.id }, { kind: changes.kind ?? item.type }), error => error.status === 409);
    }
    assert.throws(() => described.openState(item.encrypted_content, { ...ctx, scope: '43b5525b-42f5-4e58-bc6e-6ed094b55bc2' }, { kind: item.type }), error => error.status === 409);
  }
  assert.deepEqual(described.input({ input: data.output }, ctx).input, input);
  assert.deepEqual(data, original);
  assert.throws(() => described.input({ input: [{ ...data.output[0], type: 'compaction' }] }, ctx), error => error.status === 409);
});

test('new wire still opens a legacy anonymous state only in its exact original context', async () => {
  const secret = 'wire-test-private-secret-'.repeat(3), prefix = 'wire-remote-state:';
  const legacy = new DesktopWire({ secret, prefix }), described = new DesktopWire({ secret, prefix, selfDescribingState: true });
  const ctx = { ...context, protocol: 'responses' };
  const data = await (await legacy.response(Response.json({ output: [{ type: 'reasoning', encrypted_content: 'PRIVATE_LEGACY_STATE' }] }), ctx)).json();
  const token = data.output[0].encrypted_content;
  assert.equal(described.stateHint(token), null);
  assert.equal(described.openState(token, ctx, { kind: 'reasoning' }), 'PRIVATE_LEGACY_STATE');
  assert.throws(() => described.openState(token, { ...ctx, id: 'remote/bifrost/Claude-opus' }, { kind: 'reasoning' }), error => error.status === 409);
});

test('split compaction SSE gets a bound envelope in every output position without leaking its inner checkpoint', async () => {
  const described = new DesktopWire({ secret: 'wire-test-private-secret-'.repeat(3), prefix: 'wire-remote-state:', selfDescribingState: true });
  const ctx = { ...context, protocol: 'responses' }, item = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'PRIVATE_COMPACTION_CHECKPOINT' };
  const response = await described.response(streaming([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { model: 'Claude-sonnet', output: [item], usage: { input_tokens: 40, output_tokens: 6 } } },
  ]), ctx);
  const text = await response.text(); assert.doesNotMatch(text, /PRIVATE_COMPACTION_CHECKPOINT/);
  const events = text.trim().split('\n\n').map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5)));
  for (const event of events) {
    const saved = event.item ?? event.response.output[0];
    assert.equal(described.openState(saved.encrypted_content, ctx, { kind: 'compaction' }), item.encrypted_content);
  }
  assert.deepEqual(events.at(-1).response.usage, { input_tokens: 40, output_tokens: 6 });
});
