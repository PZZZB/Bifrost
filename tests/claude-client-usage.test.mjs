import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliHub } from '../src/claude-cli-provider.mjs';
import { ChatHistoryStore, createClaudeGatewayServer } from '../src/openai-chat-gateway.mjs';
import { ClientChatAdapter } from '../src/client-chat.mjs';
import { ClientBilling } from '../src/client-billing.mjs';
import { meterClientResponse, getClientMeter } from '../src/client-meter.mjs';
import { loopbackHttpFetch } from '../src/client-gateway-forwarder.mjs';
import { MessagesResponsesAdapter } from '../src/protocols/messages-responses-adapter.mjs';
import { messagesJsonEvents } from '../src/protocols/responses-messages.mjs';

const model = 'claude-usage-fixture', key = 'offline-public-usage-fixture-key-'.repeat(3);
const expected = { inputTokens: 16, outputTokens: 3, totalTokens: 19, cachedInputTokens: 4, cacheWriteTokens: 2, reasoningTokens: 0 };
const rawUsage = { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 3 };
const cases = ['chat', 'messages', 'responses', 'chat-via-responses'].flatMap(protocol => [false, true].map(stream => ({ protocol, stream })));
const frames = text => text.split(/\r?\n\r?\n/).flatMap(frame => {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
  return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
});
function messageFromFrames(values) {
  const message = structuredClone(values.find(v => v.type === 'message_start').message), blocks = new Map();
  for (const value of values) {
    if (value.type === 'content_block_start') blocks.set(value.index, structuredClone(value.content_block));
    else if (value.type === 'content_block_delta') {
      const block = blocks.get(value.index), delta = value.delta;
      if (delta.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
      else if (delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
    }
    else if (value.type === 'message_delta') { Object.assign(message.usage, value.usage); Object.assign(message, value.delta); }
  }
  message.content = [...blocks.values()]; return message;
}

for (const variant of cases) test(`shared Claude history and billing: ${variant.protocol} ${variant.stream ? 'SSE' : 'JSON'}, without a client-specific integration`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-client-usage-')), workers = [], calls = [];
  const accountId = randomUUID(), keyId = randomUUID();
  const billing = await ClientBilling.open({ path: join(root, 'ledger.json') });
  await billing.configureAccount(accountId, { enforceBalance: true });
  await billing.adjustBalance(accountId, { operationId: randomUUID(), amountMicros: 1000, note: 'Offline fixture' });
  await billing.setPrice({ model, enabled: true, inputRateMicros: 1000000, cachedInputRateMicros: 500000,
    outputRateMicros: 2000000, reserveInputTokens: 200, reserveOutputTokens: 100 });
  class Worker {
    constructor(options) {
      this.options = options; this.sessionId = options.resumeSessionId ?? randomUUID(); this.sends = []; this.closed = false;
      this.events = new ReadableStream({ start: controller => { this.controller = controller; } });
    }
    async start() {}
    async send(value) {
      this.sends.push(structuredClone(value));
      const message = { id: 'msg-usage-fixture', type: 'message', role: 'assistant', model: 'opus', stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'Fixture readable reasoning.', signature: 'PRIVATE_NATIVE_SIGNATURE' },
          { type: 'text', text: 'Fixture answer.' }], usage: { ...rawUsage } };
      for (const event of messagesJsonEvents(message)) {
        if (event.type === 'message_start') event.message.usage.output_tokens = 0;
        if (event.type === 'message_delta') event.usage = { output_tokens: rawUsage.output_tokens };
        this.controller.enqueue({ type: 'stream_event', event });
      }
      // The SDK result is session-wide, not this API message's billable usage.
      this.controller.enqueue({ type: 'result', subtype: 'success', is_error: false,
        usage: { input_tokens: 999999, output_tokens: 999999 } });
    }
    async close() { if (!this.closed) { this.closed = true; this.controller.close(); } }
  }
  const hub = new ClaudeCliHub({ binary: join(root, 'no-real-cli'), configDir: join(root, 'auth'), profileDir: root,
    stateDir: join(root, 'state'), mcpPort: 0, authStatus: async () => true,
    workerFactory: options => { const worker = new Worker(options); workers.push(worker); return worker; } });
  await hub.start();
  const provider = hub.provider('opus');
  const server = createClaudeGatewayServer({ gatewayKey: key, allowedHosts: ['usage-fixture'], allowedPeers: ['127.0.0.1'],
    routes: [{ account: 'Claude', model: { id: model, name: 'Fixture Claude', upstream: 'opus' }, provider: {
      status: provider.status, request: request => { calls.push(structuredClone(request.body)); return provider.request(request); },
    } }] }, { history: new ChatHistoryStore({ path: join(root, 'chat-history.json') }) });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const native = (path, body) => loopbackHttpFetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
    headers: new Headers({ host: 'usage-fixture', authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: JSON.stringify(body) });
  const responses = new MessagesResponsesAdapter({ stateSecret: 'offline-cross-client-reasoning-secret-'.repeat(3),
    requestMessages: ({ body }) => native('/v1/messages', body) });
  const requestResponses = request => responses.request({ ...request, capabilities: { reasoningEfforts: ['high'] } });
  const chat = new ClientChatAdapter({ requestResponses });
  t.after(async () => {
    chat.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await hub.close(); await billing.close();
    await rm(root, { recursive: true, force: true });
  });
  const history = [];
  for (const [round, prompt] of ['Initial fixture question.', 'Follow-up question.', 'New output limit.'].entries()) {
    const limit = round === 2 ? 256 : 128;
    let body, response, protocol;
    if (variant.protocol.startsWith('chat')) {
      history.push({ role: 'user', content: prompt });
      body = { model, messages: structuredClone(history), max_tokens: limit, reasoning_effort: 'high', stream: variant.stream,
        ...(variant.stream ? { stream_options: { include_usage: true } } : {}) };
      protocol = 'chat';
    } else if (variant.protocol === 'messages') {
      history.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
      body = { model, messages: structuredClone(history), max_tokens: limit, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, stream: variant.stream };
      protocol = 'messages';
    } else {
      history.push({ role: 'user', content: prompt });
      body = { model, input: structuredClone(history), max_output_tokens: limit, reasoning: { effort: 'high' }, stream: variant.stream, store: false };
      protocol = 'responses';
    }
    const requestId = randomUUID();
    await billing.reserve({ accountId, keyId, model, requestId }); await billing.begin(requestId);
    if (variant.protocol === 'chat') response = await native('/v1/chat/completions', body);
    else if (variant.protocol === 'messages') response = await native('/v1/messages', body);
    else response = await (variant.protocol === 'responses' ? requestResponses : chat.request.bind(chat))({ body, scope: accountId, session: '' });
    assert.equal(response.status, 200);
    let settlements = 0;
    const metered = meterClientResponse(response, { protocol, onResult: async result => {
      settlements++; assert.equal(result.status, 'completed'); assert.deepEqual(result.usage, expected);
      await billing.settle(requestId, result.usage);
    } });
    const wire = await metered.text(), output = variant.stream ? frames(wire) : JSON.parse(wire);
    await getClientMeter(metered).finish; assert.equal(settlements, 1);
    if (protocol === 'chat') {
      const assistant = variant.stream ? { role: 'assistant', content: output.flatMap(v => v.choices ?? []).map(c => c.delta?.content ?? '').join('') }
        : output.choices[0].message;
      // Clients may omit readable reasoning or replay text as content parts.
      history.push({ role: 'assistant', content: variant.stream ? [{ type: 'text', text: assistant.content }] : assistant.content });
      const usage = variant.stream ? output.find(v => v.usage)?.usage : output.usage;
      assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 4, cache_write_tokens: 2 });
      assert.doesNotMatch(wire, /PRIVATE_NATIVE_SIGNATURE/);
    } else if (protocol === 'messages') {
      const message = variant.stream ? messageFromFrames(output) : output;
      history.push({ role: 'assistant', content: message.content });
    } else {
      const result = variant.stream ? output.find(v => v.type === 'response.completed').response : output;
      history.push(...result.output); assert.doesNotMatch(wire, /PRIVATE_NATIVE_SIGNATURE/);
    }
    const wallet = billing.account(accountId);
    assert.equal(wallet.balanceMicros, 1000 - (round + 1) * 20);
    assert.equal(wallet.usedTokens, (round + 1) * 19); assert.equal(wallet.reservedMicros, 0); assert.equal(wallet.unresolvedCount, 0);
  }
  assert.equal(calls.length, 3, 'One native model request per user turn, with no automatic retries.');
  assert.equal(workers.length, 2, 'Changing generation settings resumes the same transcript.');
  assert.equal(workers[1].options.resumeSessionId, workers[0].sessionId);
  assert.deepEqual(workers.flatMap(w => w.sends), ['Initial fixture question.', 'Follow-up question.', 'New output limit.']
    .map(text => [{ type: 'text', text }]));
  assert.equal(billing.history(accountId).rows.filter(row => row.type === 'settled').length, 3);
});
