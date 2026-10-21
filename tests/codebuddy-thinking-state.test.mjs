import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CodeBuddyThinkingState, CODEBUDDY_STATE_PREFIX, ThinkingStateError, loadThinkingStateKey } from '../src/codebuddy-thinking-state.mjs';

const value = { reasoning: 'mock-private-reasoning\n分析与续接', identity: 'employee-mock', model: 'claude-opus-5.5' };
const block = signature => ({ type: 'thinking', thinking: '', signature });
const safeError = error => error instanceof ThinkingStateError && error.status === 400 &&
  !/mock-private|employee-mock|bridge-codebuddy-v1:/.test(String(error));
const memoryStore = (initial = null) => ({ record: initial, loads: 0, saves: 0,
  async load() { this.loads++; return structuredClone(this.record); },
  async save(record) { this.saves++; this.record = structuredClone(record); } });

function packetFor(key, plain, aad = CODEBUDDY_STATE_PREFIX) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return CODEBUDDY_STATE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

test('encrypted continuation is opaque, randomized, and restores its exact text and scopes', () => {
  const state = new CodeBuddyThinkingState();
  const first = state.seal(value), second = state.seal(value);
  assert.ok(first.startsWith(CODEBUDDY_STATE_PREFIX));
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /mock-private|employee-mock|分析/);
  assert.deepEqual(state.open(block(first)), value);
  assert.deepEqual(state.open(block(second)), value);
});

test('wire format is AES-256-GCM with prefix AAD, a 12-byte IV, and a 16-byte tag', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const packet = Buffer.from(state.seal(value).slice(CODEBUDDY_STATE_PREFIX.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(CODEBUDDY_STATE_PREFIX));
  decipher.setAuthTag(packet.subarray(12, 28));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(packet.subarray(28)), decipher.final()]).toString()), value);
  assert.throws(() => state.open(block(packetFor(key, Buffer.from(JSON.stringify(value)), 'wrong-aad'))), safeError);
});

test('the same key restores state across instances and constructor copies caller key bytes', () => {
  const key = randomBytes(32), saved = Buffer.from(key), first = new CodeBuddyThinkingState({ key });
  key.fill(0);
  const token = first.seal(value);
  assert.deepEqual(new CodeBuddyThinkingState({ key: saved }).open(block(token)), value);
  assert.throws(() => new CodeBuddyThinkingState().open(block(token)), safeError);
  for (const key of ['private-key', Buffer.alloc(31), Buffer.alloc(33), new Float64Array(4)]) {
    assert.throws(() => new CodeBuddyThinkingState({ key }), safeError);
  }
  for (const options of [null, 123, [], { get key() { throw new Error('mock-private-key'); } }]) {
    assert.throws(() => new CodeBuddyThinkingState(options), safeError);
  }
});

test('editing any authenticated envelope region or using the wrong key is rejected safely', () => {
  const state = new CodeBuddyThinkingState(), token = state.seal(value);
  const original = Buffer.from(token.slice(CODEBUDDY_STATE_PREFIX.length), 'base64url');
  for (const index of [0, 11, 12, 27, 28, original.length - 1]) {
    const changed = Buffer.from(original); changed[index] ^= 1;
    assert.throws(() => state.open(block(CODEBUDDY_STATE_PREFIX + changed.toString('base64url'))), safeError);
  }
  assert.throws(() => new CodeBuddyThinkingState().open(block(token)), safeError);
});

test('only exact hidden thinking blocks carrying this bridge prefix are accepted', () => {
  const state = new CodeBuddyThinkingState(), token = state.seal(value);
  const inherited = Object.create({ type: 'thinking' }); inherited.thinking = ''; inherited.signature = token;
  for (const candidate of [null, [], {}, inherited, { ...block(token), type: 'text' },
    { ...block(token), thinking: 'mock-private-edited-summary' }, { ...block(token), thinking: null },
    { ...block(token), extra: true }, { ...block(token), [Symbol('hidden')]: true },
    block('vendor-signature'), block(token.replace('bridge-codebuddy-v1:', 'bridge-codebuddy-v2:'))]) {
    assert.throws(() => state.open(candidate), safeError);
  }
});

test('base64url must be unpadded, canonical, and bounded before decoding', () => {
  const state = new CodeBuddyThinkingState();
  let token;
  for (const reasoning of ['', 'a', 'aa']) {
    token = state.seal({ ...value, reasoning });
    if (token.slice(CODEBUDDY_STATE_PREFIX.length).length % 4 !== 0) break;
  }
  const encoded = token.slice(CODEBUDDY_STATE_PREFIX.length), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)) | 1];
  assert.deepEqual(Buffer.from(alias, 'base64url'), Buffer.from(encoded, 'base64url'));
  for (const invalid of [encoded + '=', encoded + '\n', encoded + ' ', 'a', '', encoded.replace(/.$/, '+'), alias,
    'a'.repeat(Math.ceil((32 * 1024 * 1024 + 28) * 4 / 3) + 1)]) {
    assert.throws(() => state.open(block(CODEBUDDY_STATE_PREFIX + invalid)), safeError);
  }
});

test('authenticated malformed JSON, invalid UTF-8, and invalid payload schemas remain rejected', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const invalid = [Buffer.from('not-json-mock-private'), Buffer.from([0xff]),
    ...[null, [], { ...value, extra: true }, { reasoning: value.reasoning, identity: value.identity },
      { ...value, reasoning: {} }, { ...value, identity: '' }, { ...value, identity: 'x'.repeat(257) },
      { ...value, model: 'model\r\ninjected' }].map(item => Buffer.from(JSON.stringify(item)))];
  for (const plain of invalid) assert.throws(() => state.open(block(packetFor(key, plain))), safeError);
});

test('seal enforces text, escaped JSON payload, and bounded scope limits', () => {
  const state = new CodeBuddyThinkingState();
  for (const invalid of [null, { ...value, extra: true }, { ...value, reasoning: 123 }, { ...value, identity: ' ' },
    { ...value, model: 'x'.repeat(257) }, { ...value, reasoning: 'a'.repeat(32 * 1024 * 1024 + 1) },
    { ...value, reasoning: '\\'.repeat(16 * 1024 * 1024) }]) {
    assert.throws(() => state.seal(invalid), safeError);
  }
  const large = { ...value, reasoning: '多行\n'.repeat(128 * 1024) };
  assert.deepEqual(state.open(block(state.seal(large))), large);
  assert.deepEqual(state.open(block(state.seal({ ...value, reasoning: '' }))), { ...value, reasoning: '' });
});

test('optional metadata keeps old three-field packets compatible and omits only top-level nullish metadata', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const legacy = packetFor(key, Buffer.from(JSON.stringify(value)));
  assert.deepEqual(state.open(block(legacy)), value);
  for (const extra_fields of [undefined, null]) {
    const restored = state.open(block(state.seal({ ...value, extra_fields })));
    assert.deepEqual(restored, value);
    assert.deepEqual(Object.keys(restored), ['reasoning', 'identity', 'model']);
  }
  const hidden = { ...value, reasoning: '', extra_fields: {} };
  assert.deepEqual(state.open(block(state.seal(hidden))), hidden);
});

test('metadata preserves every JSON value, empty containers, nested null, and negative zero', () => {
  const state = new CodeBuddyThinkingState();
  const fixtures = [{}, [], '', false, true, 0, -0, 123.5, Number.MAX_VALUE, Number.MIN_VALUE,
    { empty: {}, array: [], text: 'opaque\n密文', nested: [null, false, 0, '', { value: ['retained'] }] }];
  for (const extra_fields of fixtures) {
    const input = { ...value, reasoning: '', extra_fields };
    const restored = state.open(block(state.seal(input)));
    assert.deepEqual(restored, input);
    assert.ok(Object.hasOwn(restored, 'extra_fields'));
    if (Object.is(extra_fields, -0)) assert.ok(Object.is(restored.extra_fields, -0));
  }
});

test('own prototype-like JSON keys survive without changing any object prototype', () => {
  const state = new CodeBuddyThinkingState();
  const extra_fields = JSON.parse('{"__proto__":{"codecPolluted":true},"constructor":{"prototype":{"codecPolluted":true}},"prototype":[{"__proto__":"preserved"}]}');
  const restored = state.open(block(state.seal({ ...value, extra_fields })));
  assert.deepEqual(restored.extra_fields, extra_fields);
  assert.ok(Object.hasOwn(restored.extra_fields, '__proto__'));
  assert.equal(Object.getPrototypeOf(restored.extra_fields), Object.prototype);
  assert.equal(restored.extra_fields.__proto__.codecPolluted, true);
  assert.equal({}.codecPolluted, undefined);
  const nullPrototype = Object.create(null);
  Object.defineProperty(nullPrototype, '__proto__', { value: { keep: 'own data' }, enumerable: true });
  assert.deepEqual(state.open(block(state.seal({ ...value, extra_fields: nullPrototype }))).extra_fields,
    JSON.parse('{"__proto__":{"keep":"own data"}}'));
});

test('metadata is copied before encryption and remains authenticated with the original text and scopes', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const extra_fields = { opaque: ['mock-private-metadata'], nested: { empty: {} } };
  const expected = { ...value, extra_fields: structuredClone(extra_fields) };
  const token = state.seal({ ...value, extra_fields });
  extra_fields.opaque[0] = 'changed'; extra_fields.nested.empty.added = true;
  assert.doesNotMatch(token, /mock-private|employee-mock/);
  assert.deepEqual(new CodeBuddyThinkingState({ key }).open(block(token)), expected);
  const packet = Buffer.from(token.slice(CODEBUDDY_STATE_PREFIX.length), 'base64url');
  packet[packet.length - 1] ^= 1;
  assert.throws(() => state.open(block(CODEBUDDY_STATE_PREFIX + packet.toString('base64url'))), safeError);
  assert.throws(() => new CodeBuddyThinkingState().open(block(token)), safeError);
});

test('non-JSON or lossy metadata values fail instead of being silently rewritten', () => {
  const state = new CodeBuddyThinkingState();
  const sparse = [1, , 3], extraArrayProperty = [1], hiddenProperty = {};
  extraArrayProperty.extra = true;
  Object.defineProperty(hiddenProperty, 'lost', { value: 'non-enumerable' });
  for (const extra_fields of [NaN, Infinity, -Infinity, 1n, Symbol('private'), () => {},
    { missing: undefined }, [undefined], sparse, extraArrayProperty, hiddenProperty,
    { [Symbol('lost')]: true }, new Date(), new Map([['lost', true]]), new Set([1]),
    Buffer.from('private'), new Number(1), new String('private'), /private/]) {
    assert.throws(() => state.seal({ ...value, extra_fields }), error => safeError(error) && error.code === 'invalid_thinking_state_payload');
  }
});

test('validation does not execute getters, toJSON methods, or proxy traps', () => {
  const state = new CodeBuddyThinkingState();
  let executions = 0;
  const call = () => { executions++; throw new Error('mock-private-side-effect'); };
  const accessor = Object.defineProperty({}, 'secret', { get: call, enumerable: true });
  const arrayAccessor = Object.defineProperty([], '0', { get: call, enumerable: true });
  const inheritedToJson = Object.create({ toJSON: call }); inheritedToJson.present = true;
  const proxy = new Proxy({}, { get: call, ownKeys: call, getOwnPropertyDescriptor: call, getPrototypeOf: call });
  for (const extra_fields of [accessor, arrayAccessor, { toJSON: call }, { nested: { toJSON: call } }, inheritedToJson, proxy]) {
    assert.throws(() => state.seal({ ...value, extra_fields }), safeError);
  }
  assert.throws(() => state.seal(Object.defineProperty({ ...value }, 'extra_fields', { get: call, enumerable: true })), safeError);
  assert.throws(() => state.seal(Object.defineProperty({ ...value }, 'reasoning', { get: call, enumerable: true })), safeError);
  const token = state.seal(value);
  assert.throws(() => state.open(Object.defineProperty(block(token), 'signature', { get: call, enumerable: true })), safeError);
  assert.equal(executions, 0);
  // A data key named toJSON is ordinary JSON when its value is not callable.
  assert.deepEqual(state.open(block(state.seal({ ...value, extra_fields: { toJSON: 'data' } }))).extra_fields, { toJSON: 'data' });
});

test('cycles and excessive nesting fail safely while repeated references and bounded nesting remain valid', () => {
  const state = new CodeBuddyThinkingState(), cycle = {};
  cycle.self = cycle;
  assert.throws(() => state.seal({ ...value, extra_fields: cycle }), safeError);
  let deep = 'end';
  for (let index = 0; index < 200; index++) deep = [deep];
  assert.deepEqual(state.open(block(state.seal({ ...value, extra_fields: deep }))).extra_fields, deep);
  for (let index = 0; index < 10_000; index++) deep = [deep];
  assert.throws(() => state.seal({ ...value, extra_fields: deep }), safeError);
  const shared = { keep: null }, metadata = { first: shared, second: shared };
  assert.deepEqual(state.open(block(state.seal({ ...value, extra_fields: metadata }))).extra_fields, metadata);
});

test('the full 32 MiB limit includes metadata, JSON escaping, and fixed payload fields', () => {
  const state = new CodeBuddyThinkingState();
  assert.throws(() => state.seal({ ...value, reasoning: 'r'.repeat(32 * 1024 * 1024 - 256), extra_fields: 'm'.repeat(1024) }), safeError);
  assert.throws(() => state.seal({ ...value, extra_fields: '\0'.repeat(6 * 1024 * 1024) }), safeError);
});

test('authenticated malformed metadata still fails after decryption without exposing payload data', () => {
  const key = randomBytes(32), state = new CodeBuddyThinkingState({ key });
  const prefix = JSON.stringify(value).slice(0, -1);
  for (const raw of [`${prefix},"extra_fields":1e400}`, `${prefix},"extra_fields":{"lost":undefined}}`,
    `${prefix},"extra_fields":${'['.repeat(1000)}0${']'.repeat(1000)}}`]) {
    assert.throws(() => state.open(block(packetFor(key, Buffer.from(raw)))), error => safeError(error) && error.code === 'invalid_thinking_state');
  }
});

test('a missing dedicated key record is created once and restored through load/save without other fields', async () => {
  const store = memoryStore(), first = await loadThinkingStateKey(store);
  assert.equal(first.length, 32);
  assert.deepEqual(Object.keys(store.record).sort(), ['key', 'version']);
  assert.equal(store.record.version, 1);
  assert.equal(store.record.key, first.toString('base64'));
  const token = new CodeBuddyThinkingState({ key: first }).seal(value);
  const second = await loadThinkingStateKey(store);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  assert.equal(store.saves, 1);
  assert.deepEqual(new CodeBuddyThinkingState({ key: second }).open(block(token)), value);
});

test('corrupt key records fail closed without creating or saving a replacement', async () => {
  const canonical = Buffer.alloc(32).toString('base64');
  for (const record of [{}, [], false, { version: 2, key: canonical }, { version: 1, key: canonical, extra: true },
    { version: 1, key: canonical.slice(0, -1) }, { version: 1, key: canonical.slice(0, -2) + 'B=' },
    { version: 1, key: Buffer.alloc(31).toString('base64') }, { version: 1, key: 'mock-private-invalid-key' }]) {
    const store = memoryStore(record);
    await assert.rejects(loadThinkingStateKey(store), error => safeError(error) && error.code === 'invalid_thinking_state_key');
    assert.equal(store.saves, 0);
  }
});

test('key store failures never include underlying errors or secret values', async () => {
  for (const store of [null, {}, { async load() { throw new Error('mock-private-store-error'); }, async save() {} },
    { async load() { return null; }, async save() { throw new Error('mock-private-key'); } },
    { get load() { throw new Error('mock-private-store'); }, async save() {} }]) {
    await assert.rejects(loadThinkingStateKey(store), error => safeError(error) && error.code === 'thinking_state_key_store_failed');
  }
});

test('concurrent initialization of one store shares one generated key and returns independent buffers', async () => {
  let resume;
  const pending = new Promise(resolve => { resume = resolve; }), store = memoryStore();
  store.load = async function () { this.loads++; await pending; return null; };
  const first = loadThinkingStateKey(store), second = loadThinkingStateKey(store);
  resume();
  const keys = await Promise.all([first, second]);
  assert.deepEqual(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[1]);
  keys[0].fill(0);
  assert.notEqual(keys[1].toString('base64'), keys[0].toString('base64'));
  assert.equal(store.loads, 1); assert.equal(store.saves, 1);
});

test('a rejected key load can be retried and a later corruption is not hidden by an in-memory cache', async () => {
  const store = memoryStore(), load = store.load;
  store.load = async () => { throw new Error('mock-private-read'); };
  await assert.rejects(loadThinkingStateKey(store), safeError);
  store.load = load;
  await loadThinkingStateKey(store);
  store.record = { version: 1, key: 'mock-private-corruption' };
  await assert.rejects(loadThinkingStateKey(store), error => safeError(error) && error.code === 'invalid_thinking_state_key');
  assert.equal(store.saves, 1);
});
