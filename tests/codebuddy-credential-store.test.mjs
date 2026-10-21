import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { CodeBuddyCredentialStore } from '../src/codebuddy-credential-store.mjs';

const record = { version: 1, auth: { accessToken: 'mock-private-access', refreshToken: 'mock-private-refresh',
  expiresAt: 5000000, domain: 'copilot.tencent.com' }, identity: { idp: 'ioa_auth', uid: 'employee-mock', username: 'mock' } };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-store-test-'));
  const path = join(directory, 'auth.dpapi');
  t.after(async () => {
    try { await unlink(path); } catch {}
    await rmdir(directory);
  });
  return { path, store: new CodeBuddyCredentialStore({ path, platform: 'win32', ...options }) };
}

// This reversible codec exists only in the process mock. The production path is DPAPI CurrentUser.
function fakeProcess(calls, failure = null) {
  return (file, args, options, callback) => {
    const chunks = [];
    const stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); }, final(done) {
      const bytes = Buffer.from(Buffer.concat(chunks).toString(), 'base64');
      calls.push({ file, args, options, bytes: Buffer.from(bytes) });
      if (failure) callback(new Error(failure));
      else {
        const protect = args.at(-1).includes('::Protect(');
        const output = protect ? Buffer.concat([Buffer.from('encrypted-mock:'), Buffer.from(bytes).reverse()]) :
          Buffer.from(bytes.subarray('encrypted-mock:'.length)).reverse();
        callback(null, output.toString('base64'));
      }
      done();
    } });
    return { stdin };
  };
}

test('new credential store has no credentials and deletion is idempotent', async t => {
  const calls = [];
  const { store } = await fixture(t, { execFileImpl: fakeProcess(calls) });
  assert.equal(await store.load(), null);
  await store.clear();
  assert.equal(calls.length, 0);
});

test('encrypted atomic save survives another store instance and clear removes it', async t => {
  const calls = [];
  const { store, path } = await fixture(t, { execFileImpl: fakeProcess(calls) });
  await store.save(record);
  const encrypted = await readFile(path, 'utf8');
  assert.doesNotMatch(encrypted, /mock-private|employee-mock/);
  assert.equal(JSON.parse(encrypted).protection, 'dpapi-current-user');
  const restarted = new CodeBuddyCredentialStore({ path, platform: 'win32', execFileImpl: fakeProcess(calls) });
  assert.deepEqual(await restarted.load(), record);
  await restarted.clear();
  assert.equal(await restarted.load(), null);
});

test('DPAPI receives plaintext only through stdin, with CurrentUser and a hidden bounded process', async t => {
  const calls = [];
  const { store } = await fixture(t, { execFileImpl: fakeProcess(calls) });
  await store.save(record);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.deepEqual(JSON.parse(call.bytes.toString()), record);
  assert.doesNotMatch(JSON.stringify(call.args), /mock-private|employee-mock/);
  assert.match(call.args.at(-1), /DataProtectionScope\]::CurrentUser/);
  assert.doesNotMatch(call.args.at(-1), /LocalMachine/);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 15000);
});

test('DPAPI errors never expose process errors or credential content and leave the old file intact', async t => {
  const calls = [];
  const { store, path } = await fixture(t, { execFileImpl: fakeProcess(calls) });
  await store.save(record);
  const previous = await readFile(path, 'utf8');
  const failing = new CodeBuddyCredentialStore({ path, platform: 'win32', execFileImpl: fakeProcess([], 'mock-private-refresh') });
  await assert.rejects(failing.save(record), error => error.code === 'dpapi_failed' && !String(error).includes('mock-private-refresh'));
  assert.equal(await readFile(path, 'utf8'), previous);
});

test('bad envelopes are rejected before decryption and queue recovers for a later save', async t => {
  const calls = [];
  const { store, path } = await fixture(t, { execFileImpl: fakeProcess(calls) });
  await writeFile(path, '{"version":1,"protection":"plaintext","ciphertext":"mock-private-refresh"}');
  await assert.rejects(store.load(), error => error.code === 'invalid_envelope' && !String(error).includes('mock-private-refresh'));
  assert.equal(calls.length, 0);
  await store.save(record);
  assert.deepEqual(await store.load(), record);
});

test('save, load and clear are serialized in invocation order', async t => {
  const { store } = await fixture(t, { execFileImpl: fakeProcess([]) });
  const saved = store.save(record), loaded = store.load(), cleared = store.clear(), empty = store.load();
  assert.deepEqual(await loaded, record);
  await Promise.all([saved, cleared]);
  assert.equal(await empty, null);
});

test('unsupported platforms fail explicitly without writing a plaintext fallback', async t => {
  const { path } = await fixture(t);
  const store = new CodeBuddyCredentialStore({ path, platform: 'linux', execFileImpl() { throw new Error('must not run'); } });
  await assert.rejects(store.save(record), error => error.code === 'unsupported_platform');
  await assert.rejects(readFile(path), error => error.code === 'ENOENT');
});

test('actual Windows CurrentUser DPAPI roundtrip persists no plaintext', { skip: process.platform !== 'win32' }, async t => {
  const { store, path } = await fixture(t);
  await store.save(record);
  assert.doesNotMatch(await readFile(path, 'utf8'), /mock-private|employee-mock/);
  assert.deepEqual(await store.load(), record);
  const next = { ...record, auth: { ...record.auth, accessToken: 'mock-rotated-access' } };
  await store.save(next);
  assert.deepEqual(await store.load(), next);
  await store.clear();
});
