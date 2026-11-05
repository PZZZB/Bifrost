import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverResponses } from '../src/protocols/responses-delivery.mjs';
import { translateResponses, ResponsesConversion, messagesJsonEvents } from '../src/protocols/responses-messages.mjs';

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
function fixture() {
  const request = translateResponses({ model: 'fixture', input: 'Question.' }, 'marker', { model: 'fixture' });
  const conversion = new ResponsesConversion(request);
  const prefix = [];
  for (const event of messagesJsonEvents({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Answer.' }], stop_reason: 'end_turn' })) {
    prefix.push(...conversion.accept(event));
  }
  return { conversion, prefix, commit: [...conversion.finishEvents(usage)] };
}
const parse = wire => wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));

test('a body reader taking over pending preflight receives and closes the same first source failure', async () => {
  const { conversion } = fixture(); let release, timer;
  const gate = new Promise(resolve => { release = resolve; });
  const events = async function* () { await gate; throw new Error('PRIVATE_FIRST_FAILURE'); };
  const response = await deliverResponses({ events: events(), conversion, stream: true, preflight: true });
  const preflight = response.bridgePreflight(), reader = response.body.getReader();
  try {
    const reading = reader.read(); release();
    const [checked, first] = await Promise.race([Promise.all([preflight, reading]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Preflight reader stalled')), 500); })]);
    assert.equal(checked, response); assert.equal(first.done, false);
    const wire = new TextDecoder().decode(first.value), values = parse(wire);
    assert.equal(values.length, 1); assert.equal(values[0].type, 'response.failed');
    assert.equal(values[0].sequence_number, 0); assert.doesNotMatch(wire, /PRIVATE_FIRST_FAILURE/);
    assert.equal((await reader.read()).done, true);
  } finally { clearTimeout(timer); release(); await reader.cancel(); reader.releaseLock(); }
});

test('cleanup failures cannot replace an already committed response or repeat its terminal batch', async () => {
  const { conversion, prefix, commit } = fixture(); let disposed = 0, returned = 0, committed = 0;
  const events = async function* () {
    try { yield* prefix; yield commit; assert.fail('Delivery must not request a second terminal batch'); }
    finally { returned++; throw new Error('PRIVATE_SOURCE_CLEANUP'); }
  };
  const response = await deliverResponses({ events: events(), conversion, stream: true,
    committed: () => { committed++; }, dispose: () => { disposed++; return Promise.reject(new Error('PRIVATE_DISPOSE')); } });
  const wire = await response.text(), values = parse(wire);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(values.at(-1).type, 'response.completed');
  assert.equal(values.filter(event => event.type === 'response.completed').length, 1);
  assert.equal(values.filter(event => event.type === 'response.failed').length, 0);
  assert.deepEqual(values.map(event => event.sequence_number), values.map((_, index) => index));
  assert.deepEqual([committed, disposed, returned], [1, 1, 1]);
  assert.doesNotMatch(wire, /PRIVATE_/);
});

test('a future adapter cannot expose durable history without its complete matching terminal batch', async () => {
  for (const invalid of ['single_done', 'missing_terminal', 'duplicate_terminal', 'wrong_item']) {
    const { conversion, commit } = fixture();
    const packet = invalid === 'single_done' ? commit[0] : invalid === 'missing_terminal' ? commit.slice(0, -1)
      : invalid === 'duplicate_terminal' ? [...commit, commit.at(-1)]
        : [{ ...commit[0], item: { ...commit[0].item, id: 'wrong' } }, ...commit.slice(1)];
    const events = async function* () { yield packet; };
    const response = await deliverResponses({ events: events(), conversion, stream: true }), values = parse(await response.text());
    assert.equal(values.length, 1); assert.equal(values[0].type, 'response.failed');
    assert.equal(values[0].sequence_number, 0); assert.deepEqual(values[0].response.output, []);
    assert.equal(values[0].response.error.code, 'upstream_protocol_error');
  }
});

for (const stream of [true, false]) test(`external abort interrupts a stalled ${stream ? 'SSE' : 'JSON'} source without waiting for return or disposal`, async () => {
  const { conversion, prefix } = fixture(), abort = new AbortController();
  let release, cancelled = 0, disposed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const events = async function* () { await gate; yield prefix[0]; };
  const pending = deliverResponses({ events: events(), conversion, stream, signal: abort.signal,
    cancel: () => { cancelled++; }, dispose: () => { disposed++; return gate; } });
  let timer;
  try {
    const reading = stream ? pending.then(response => response.text()).then(parse) : pending.then(response => response.json());
    queueMicrotask(() => abort.abort());
    const result = await Promise.race([reading, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Delivery stalled')), 500); })]);
    if (stream) {
      assert.equal(result.length, 1); assert.equal(result[0].type, 'response.failed');
      assert.equal(result[0].response.error.code, 'request_cancelled'); assert.equal(result[0].sequence_number, 0);
    } else assert.equal(result.error.code, 'request_cancelled');
    assert.deepEqual([cancelled, disposed], [1, 1]);
  } finally { clearTimeout(timer); release(); }
});
