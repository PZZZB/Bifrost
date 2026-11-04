import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHistoryStore, translateChatRequest } from '../src/openai-chat-gateway.mjs';

const keyA = 'a'.repeat(64), keyB = 'b'.repeat(64), keyC = 'c'.repeat(64);
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Small history fixture.' }] }];
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-chat-cache-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('two public spellings persist one bounded native snapshot and both survive reload', async t => {
  const root = await directory(t), path = join(root, 'history.json');
  const maxBytes = Buffer.byteLength(JSON.stringify([{ key: keyA, aliases: [keyB], messages }])) + 4;
  const store = new ChatHistoryStore({ path, maxBytes, maxEntries: 1 });
  await store.saveAliases([keyA, keyB], messages);
  assert.deepEqual(store.records.get(keyA), messages); assert.deepEqual(store.records.get(keyB), messages);
  const raw = await readFile(path), disk = JSON.parse(raw);
  assert.equal(disk.length, 1); assert.deepEqual(disk[0].aliases, [keyB]); assert.ok(raw.byteLength <= maxBytes);
  const loaded = new ChatHistoryStore({ path, maxBytes, maxEntries: 1 }); await loaded.load();
  assert.deepEqual(loaded.records.get(keyA), messages); assert.deepEqual(loaded.records.get(keyB), messages);
  assert.equal(loaded.snapshot(loaded.records).length, 1);
});

test('oversized saves leave valid memory and persisted history untouched', async t => {
  const path = join(await directory(t), 'history.json'), store = new ChatHistoryStore({ path, maxBytes: 300 });
  await store.save(keyA, messages); const before = await readFile(path);
  await assert.rejects(store.save(keyB, [{ role: 'user', content: 'x'.repeat(1000) }]), error => error.status === 413);
  assert.deepEqual(store.records.get(keyA), messages); assert.equal(store.records.has(keyB), false);
  assert.deepEqual(await readFile(path), before);
});

test('capacity eviction removes a whole old snapshot while preserving both newest aliases', async () => {
  const store = new ChatHistoryStore({ maxEntries: 1 }); await store.save(keyC, messages);
  await store.saveAliases([keyA, keyB], messages);
  assert.deepEqual([...store.records.keys()], [keyA, keyB]);
  assert.equal(store.records.has(keyC), false);
});

test('failed persistence retains bounded live aliases and removes temporary files', async t => {
  const root = await directory(t), path = join(root, 'history.json'); await mkdir(path);
  const store = new ChatHistoryStore({ path });
  await assert.rejects(store.saveAliases([keyA, keyB], messages));
  assert.deepEqual(store.records.get(keyA), messages); assert.deepEqual(store.records.get(keyB), messages);
  assert.deepEqual(await readdir(root), ['history.json']);
});

test('legacy loads remain supported and colliding aliases cannot partially replace live state', async t => {
  const path = join(await directory(t), 'history.json'), store = new ChatHistoryStore({ path });
  await writeFile(path, JSON.stringify([{ key: keyA, messages }]), { mode: 0o600 }); await store.load();
  assert.deepEqual(store.records.get(keyA), messages);
  await writeFile(path, JSON.stringify([{ key: keyB, aliases: [keyC], messages }, { key: keyC, messages }]));
  await assert.rejects(store.load(), /private chat history index/);
  assert.deepEqual([...store.records.keys()], [keyA]);
});

test('mixed old and new indexes select the longest exact signed prefix and prefer new keys on ties', async () => {
  const store = new ChatHistoryStore();
  const body = { model: 'fixture', messages: [{ role: 'user', content: 'One.' }, { role: 'assistant', content: 'Answer one.' },
    { role: 'user', content: 'Two.' }, { role: 'assistant', content: 'Answer two.' }, { role: 'user', content: 'Three.' }] };
  const converted = translateChatRequest(body, store, 'fixture-owner'), native = structuredClone(converted.body.messages);
  native[1].content.unshift({ type: 'thinking', thinking: '', signature: 'PRIVATE_FIRST_SIGNATURE' });
  native[3].content.unshift({ type: 'thinking', thinking: '', signature: 'PRIVATE_LONGER_SIGNATURE' });
  await store.save(store.keys(converted.context, converted.normalized)[1], native.slice(0, 2));
  const legacy = { ...converted.context, maxTokens: 8192, effort: 'none' };
  await store.save(store.keys(legacy, converted.normalized)[3], native.slice(0, 4));
  assert.deepEqual(translateChatRequest(body, store, 'fixture-owner').body.messages.slice(0, 4), native.slice(0, 4));
  const newer = structuredClone(native.slice(0, 4)); newer[3].content[0].signature = 'PRIVATE_NEWER_SIGNATURE';
  await store.save(store.keys(converted.context, converted.normalized)[3], newer);
  assert.deepEqual(translateChatRequest(body, store, 'fixture-owner').body.messages.slice(0, 4), newer);
});

test('invalid cache limits fail instead of entering an unbounded eviction loop', () => {
  for (const maxEntries of [0, -1, NaN, Infinity]) assert.throws(() => new ChatHistoryStore({ maxEntries }), TypeError);
  for (const maxBytes of [0, -1, NaN, Infinity]) assert.throws(() => new ChatHistoryStore({ maxBytes }), TypeError);
});
