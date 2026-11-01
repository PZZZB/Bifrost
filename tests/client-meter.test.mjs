import test from 'node:test';
import assert from 'node:assert/strict';
import { getClientMeter, meterClientResponse } from '../src/client-meter.mjs';

const encoder = new TextEncoder();
const usage = (input = 20, output = 6) => ({ input_tokens: input, output_tokens: output, total_tokens: input + output,
  input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } });
const expected = { inputTokens: 20, outputTokens: 6, totalTokens: 26, cachedInputTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3 };
const completed = (extra = {}) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: usage(), ...extra } });
const frame = value => value === '[DONE]' ? 'data: [DONE]\n\n' : `event: ${value.type ?? 'message'}\ndata: ${JSON.stringify(value)}\n\n`;
function sse(values, { split = false, tail = '', error = null } = {}) {
  const bytes = encoder.encode(values.map(value => typeof value === 'string' && value !== '[DONE]' ? value : frame(value)).join('') + tail);
  return new Response(new ReadableStream({
    start(controller) {
      if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      if (error) controller.error(error); else controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
function wrap(response, protocol = 'responses', onResult) {
  const results = [];
  const output = meterClientResponse(response, { protocol, onResult: async result => { results.push(result); await onResult?.(result); } });
  return { output, results, meter: getClientMeter(output) };
}
const chat = value => `data: ${JSON.stringify(value)}\n\n`;
const chatUsage = (prompt = 20, completion = 6) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
const choices = (finish = null, delta = {}) => ({ id: 'chat_1', choices: [{ index: 0, delta, finish_reason: finish }] });

test('HTTP conflict without model output is rejected, while actual conflict usage is retained', async () => {
  for (const actualUsage of [null, chatUsage()]) {
    const { output, results } = wrap(Response.json({ error: { message: 'Session conflict' },
      ...(actualUsage ? { usage: actualUsage } : {}) }, { status: 409 }), 'chat');
    await output.text();
    assert.deepEqual(results, [{ usage: actualUsage ? expected : null,
      status: actualUsage ? 'completed' : 'rejected' }]);
  }
});
const messageStart = (counts = {}) => ({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [],
  usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 8, cache_creation_input_tokens: 2, ...counts } } });
const messageDelta = (output, reason = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: output } });
const messageStop = { type: 'message_stop' };

test('protocol observations distinguish finished text, pending tool calls and length-limited turns across JSON and SSE', async () => {
  const cases = [
    ['chat', Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: chatUsage() }), true, false],
    ['chat', Response.json({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: chatUsage() }), false, false],
    ['chat', Response.json({ choices: [{ message: { content: 'working', tool_calls: [{}] }, finish_reason: 'tool_calls' }], usage: chatUsage() }), false, true],
    ['chat', sse([chat(choices(null, { content: 'ok' })), chat({ ...choices('stop'), usage: chatUsage() }), '[DONE]']), true, false],
    ['messages', Response.json({ type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), true, false],
    ['messages', sse([messageStart(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, messageDelta(5), messageStop]), true, false],
  ];
  for (const [protocol, response, normalStop, pendingTools] of cases) {
    let record, settled = false;
    const output = meterClientResponse(response, { protocol, onResult: () => { settled = true; }, onProtocolResult: result => { assert.equal(settled, true); record = result; } });
    await output.text(); assert.equal(record.status, 'completed'); assert.equal(record.answerText, true);
    assert.equal(record.normalStop, normalStop); assert.equal(record.pendingTools, pendingTools);
    assert.doesNotMatch(JSON.stringify(record), /working|partial/);
  }
});

test('JSON preserves original bytes and exposes them only after durable settlement', async () => {
  let release, saving;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { saving = resolve; });
  const bytes = '  {"id":"resp_1","status":"completed","usage":' + JSON.stringify(usage()) + ',"output":[]}\r\n';
  const { output, results, meter } = wrap(new Response(bytes, { headers: { 'content-type': 'application/json', 'x-test': 'preserved' } }), 'responses', async () => { saving(); await blocked; });
  const read = output.text(); let exposed = false; read.then(() => { exposed = true; });
  await entered; assert.equal(exposed, false); assert.equal(results.length, 1); assert.deepEqual(results[0], { usage: expected, status: 'completed' });
  release(); assert.equal(await read, bytes); assert.equal(output.headers.get('x-test'), 'preserved');
  assert.deepEqual(await meter.finish, results[0]); await meter.cancel(); assert.equal(results.length, 1);
});

test('Responses terminal frames and EOF wait for settlement while earlier deltas pass through', async () => {
  let release, saving;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { saving = resolve; });
  const early = { type: 'response.output_text.delta', delta: '中文' }, last = completed();
  const { output, results } = wrap(sse([early, last, '[DONE]'], { split: true }), 'responses', async () => { saving(); await gate; });
  const reader = output.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), frame(early));
  const final = reader.read(); let exposed = false; final.then(() => { exposed = true; });
  await entered; assert.equal(exposed, false); release();
  let tail = new TextDecoder().decode((await final).value);
  while (true) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  assert.equal(tail, frame(last) + frame('[DONE]')); assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
});

test('UTF-8, SSE comments, BOM and mixed CRLF/bare CR bytes remain unchanged', async () => {
  const bytes = '\uFEFF: hello\r\n\r\n' + `event: response.output_text.delta\rdata: {"type":"response.output_text.delta","delta":"中文💫"}\r\r`
    + frame(completed()).replaceAll('\n', '\r\n') + 'data: [DONE]\r\r';
  const { output, results } = wrap(sse([bytes], { split: true }));
  assert.deepEqual(Buffer.from(await output.arrayBuffer()), Buffer.from(bytes)); assert.equal(results[0].status, 'completed');
});

test('Responses incomplete, failed and complete tool handoffs all retain authoritative usage', async () => {
  for (const status of ['completed', 'incomplete', 'failed']) {
    const value = { type: `response.${status}`, response: { id: 'resp_1', status, usage: usage(),
      output: [{ type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{}' }],
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } };
    const { output, results } = wrap(sse([value])); await output.text();
    assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
  }
});

test('created usage is a placeholder and duplicate terminal snapshots never add counts twice', async () => {
  const last = completed();
  const { output, results } = wrap(sse([{ type: 'response.created', response: { status: 'in_progress', usage: usage(900, 100) } }, last, last]));
  await output.text(); assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
});

test('missing, zero-filled, invalid and contradictory final usage stay unresolved', async () => {
  const values = [null, {}, { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, usage(-1, 6), usage(20, 1),
    { ...usage(), total_tokens: 999 }, { ...usage(), input_tokens_details: { cached_tokens: 21 } },
    { ...usage(), input_tokens_details: { cached_tokens: 19, cache_write_tokens: 2 } },
    { ...usage(), output_tokens_details: { reasoning_tokens: 100 } },
    { ...usage(), input_tokens: Number.MAX_SAFE_INTEGER }];
  for (const value of values) {
    const { output, results } = wrap(sse([completed({ usage: value })])); await output.text();
    assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
  }
});

test('bridgeUsage is authoritative and suppresses known wire placeholders', async () => {
  for (const raw of [null, usage()]) {
    const response = sse([completed({ usage: { input_tokens: 0, output_tokens: 0 } })]);
    response.bridgeUsage = Promise.resolve(raw);
    const { output, results } = wrap(response); await output.text();
    assert.deepEqual(results, [{ usage: raw ? expected : null, status: raw ? 'completed' : 'unresolved' }]);
  }
});

test('authority rejection cannot fall back to wire usage and pending authority remains cancellable', async () => {
  const failed = sse([completed()]); failed.bridgeUsage = Promise.reject(new Error('usage unavailable'));
  const first = wrap(failed); await first.output.text();
  assert.deepEqual(first.results, [{ usage: null, status: 'unresolved' }]);
  const response = sse([completed()]); response.bridgeUsage = new Promise(() => {});
  const { output, meter, results } = wrap(response), reading = output.text();
  await new Promise(resolve => setImmediate(resolve));
  await meter.cancel(); await assert.rejects(reading);
  assert.deepEqual(await meter.finish, { usage: null, status: 'unresolved' }); assert.equal(results.length, 1);
  assert.equal(response.body.locked, false);
});

test('Chat consumes only terminal cumulative usage, including tool_calls, and requires DONE', async () => {
  const frames = [chat({ ...choices(null, { content: 'ok' }), usage: chatUsage(999, 999) }),
    chat(choices('tool_calls')), chat({ choices: [], usage: chatUsage(20, 4) }),
    chat({ choices: [], usage: chatUsage() }), chat({ choices: [], usage: chatUsage() }), 'data: [DONE]\n\n'];
  const { output, results } = wrap(sse(frames, { split: true }), 'chat');
  assert.equal(await output.text(), frames.join('')); assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
});

test('Chat early usage without a final usage packet and decreasing cumulative counts remain unresolved', async () => {
  const cases = [
    [chat({ ...choices(null, { content: 'ok' }), usage: chatUsage() }), chat(choices('stop')), 'data: [DONE]\n\n'],
    [chat(choices('length')), chat({ choices: [], usage: chatUsage() }), chat({ choices: [], usage: chatUsage(20, 5) }), 'data: [DONE]\n\n'],
  ];
  for (const frames of cases) {
    const { output, results } = wrap(sse(frames), 'chat'); await output.text();
    assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
  }
});

test('Chat JSON and Anthropic JSON use protocol-specific cache semantics', async () => {
  const values = [
    ['chat', { choices: [{ finish_reason: 'stop' }], usage: chatUsage() }, expected],
    ['messages', { type: 'message', stop_reason: 'tool_use', content: [], usage: { input_tokens: 10, output_tokens: 6,
      cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } }, { ...expected, reasoningTokens: 0 }],
  ];
  for (const [protocol, value, counts] of values) {
    const { output, results } = wrap(Response.json(value), protocol); assert.deepEqual(await output.json(), value);
    assert.deepEqual(results, [{ usage: counts, status: 'completed' }]);
  }
});

test('Messages cumulative output is replaced, not added; cache reads and writes add to uncached input', async () => {
  const values = [messageStart(), messageDelta(2, null), messageDelta(4, null), messageDelta(6, 'tool_use'), messageDelta(6, 'tool_use'), messageStop];
  const { output, results } = wrap(sse(values), 'messages'); await output.text();
  assert.deepEqual(results, [{ usage: { ...expected, reasoningTokens: 0 }, status: 'completed' }]);
});

test('Messages start output placeholder never substitutes for final usage', async () => {
  const values = [messageStart(), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, messageStop];
  const { output, results } = wrap(sse(values), 'messages'); await output.text();
  assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
});

test('Messages can use authoritative bridge usage despite placeholder envelopes', async () => {
  const response = sse([messageStart({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, messageStop]);
  response.bridgeUsage = Promise.resolve(usage());
  const { output, results } = wrap(response, 'messages'); await output.text();
  assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
});

test('HTTP refusal is released, including body cancellation before any read; 5xx is unresolved', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503]) {
    for (const consume of [true, false]) {
      const { output, results, meter } = wrap(Response.json({ error: { message: 'rejected' } }, { status }));
      if (consume) await output.text(); else await output.body.cancel();
      const wanted = status < 500 ? 'rejected' : 'unresolved';
      assert.deepEqual(await meter.finish, { usage: null, status: wanted }); assert.equal(results.length, 1);
    }
  }
});

test('HTTP failure with explicit final usage remains billable rather than becoming free', async () => {
  for (const status of [200, 400, 500]) {
    const { output, results } = wrap(Response.json({ error: { message: 'failed after generation' }, usage: usage() }, { status }));
    await output.text(); assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
  }
  const { output, results } = wrap(sse([{ type: 'error', error: { message: 'failed' }, usage: usage() }]));
  await output.text(); assert.deepEqual(results, [{ usage: expected, status: 'completed' }]);
});

test('transport error stays visible and incomplete streams never establish real counts', async () => {
  const cases = [
    ['responses', sse([completed()], { error: new Error('transport disconnected') })],
    ['responses', sse([completed()], { tail: 'data: {"type":' })],
    ['responses', sse([{ type: 'response.output_text.delta', delta: 'partial' }])],
    ['chat', sse([chat(choices('stop')), chat({ choices: [], usage: chatUsage() })])],
    ['messages', sse([messageStart(), messageDelta(6)])],
  ];
  for (const [protocol, response] of cases) {
    const { output, results } = wrap(response, protocol); await assert.rejects(output.text());
    assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
  }
});

test('protocol contradictions after terminal reject and discard otherwise valid usage', async () => {
  const cases = [
    ['responses', [completed(), { type: 'response.output_text.delta', delta: 'extra' }]],
    ['responses', [completed(), completed({ usage: usage(21, 6) })]],
    ['responses', [{ type: 'response.completed', response: { status: 'incomplete', usage: usage() } }]],
    ['chat', [chat(choices('stop')), chat({ choices: [], usage: chatUsage() }), 'data: [DONE]\n\n', chat(choices())]],
    ['messages', [messageStart(), messageDelta(6), messageStop, { type: 'content_block_start', index: 0 }]],
    ['messages', [messageStart(), { type: 'content_block_start', index: 0 }, messageDelta(6), messageStop]],
  ];
  for (const [protocol, values] of cases) {
    const { output, results } = wrap(sse(values), protocol); await assert.rejects(output.text());
    assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
  }
});

test('invalid JSON, invalid UTF-8 and oversized SSE frames fail closed without inventing markers', async () => {
  for (const response of [sse(['data: {broken}\n\n']), new Response(Uint8Array.from([0xff, 0xff]), { headers: { 'content-type': 'application/json' } }),
    sse(['data: ' + 'x'.repeat(16 * 1024 * 1024) + '\n\n'])]) {
    const { output, results } = wrap(response); await assert.rejects(output.text());
    assert.deepEqual(results, [{ usage: null, status: 'unresolved' }]);
  }
});

test('body cancellation and external cancellation settle exactly once and stop upstream reads', async () => {
  for (const kind of ['body', 'external', 'signal']) {
    let reads = 0, cancels = 0;
    const response = new Response(new ReadableStream({ pull(controller) { reads++; controller.enqueue(encoder.encode(frame({ type: 'response.output_text.delta', delta: 'partial' }))); },
      cancel() { cancels++; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    const results = [], abort = new AbortController();
    const output = meterClientResponse(response, { protocol: 'responses', signal: abort.signal, onResult: result => { results.push(result); } });
    assert.equal(reads, 0); const reader = output.body.getReader(); await reader.read(); assert.equal(reads, 1);
    if (kind === 'body') await reader.cancel();
    else if (kind === 'external') await getClientMeter(output).cancel();
    else abort.abort();
    assert.deepEqual(await getClientMeter(output).finish, { usage: null, status: 'unresolved' });
    await getClientMeter(output).cancel(); assert.equal(results.length, 1); assert.equal(cancels, 1); assert.equal(reads, 1);
  }
});

test('billing persistence failure prevents terminal success and remains observable through finish', async () => {
  const failure = new Error('ledger write failed');
  const { output, results, meter } = wrap(sse([completed(), '[DONE]']), 'responses', async () => { throw failure; });
  await assert.rejects(output.text(), error => error === failure);
  await assert.rejects(meter.finish, error => error === failure); assert.equal(results.length, 1);
  await meter.cancel(); assert.equal(results.length, 1);
});

test('aborted before first read is unresolved and does not invoke inference body pull', async () => {
  let reads = 0;
  const abort = new AbortController(); abort.abort();
  const response = new Response(new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  const results = [], output = meterClientResponse(response, { protocol: 'responses', signal: abort.signal, onResult: result => { results.push(result); } });
  await assert.rejects(output.text()); assert.equal(reads, 0);
  assert.deepEqual(await getClientMeter(output).finish, { usage: null, status: 'unresolved' }); assert.equal(results.length, 1);
});
