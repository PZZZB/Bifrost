import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientAccess } from '../src/client-access.mjs';
import { ClientKeyProtector } from '../src/client-key-protector.mjs';

const PASSWORD = 'Only-for-offline-key-tests-123';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-key-reveal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'access.json'); let record = null, clock = Date.now(), saves = 0;
  const protectedStore = { load: async () => structuredClone(record), save: async value => { saves++; record = structuredClone(value); } };
  let access, protector;
  const open = async (protectedKeys = true) => {
    await access?.close(); protector = new ClientKeyProtector({ store: protectedStore });
    access = await ClientAccess.open({ path, now: () => clock, ...(protectedKeys ? { keyProtector: protector } : {}) });
    return access;
  };
  t.after(async () => { await access?.close(); });
  return { path, open, get protector() { return protector; }, get access() { return access; },
    register: name => access.register({ username: name, password: PASSWORD }),
    advance: value => { clock += value; }, forgetMaster: () => { record = null; }, get saves() { return saves; } };
}

test('keys survive logout and process reopen, while account state and projections contain no plaintext', async t => {
  const f = await fixture(t), access = await f.open(), user = await f.register('reveal-owner');
  assert.equal((await access.revealSessionKey(user.sessionToken)).secret, user.secret);
  const bytes = await readFile(f.path, 'utf8'); assert.equal(bytes.includes(user.secret), false);
  assert.equal(bytes.includes('bke1_'), true); assert.equal(JSON.stringify(access.snapshot()).includes('bke1_'), false);
  assert.equal(JSON.stringify(access.snapshot()).includes(user.secret), false);
  await access.logout(user.sessionToken);
  await assert.rejects(access.revealSessionKey(user.sessionToken), error => error.status === 401);
  const reopened = await f.open(), logged = await reopened.login({ username: 'reveal-owner', password: PASSWORD });
  assert.equal((await reopened.revealSessionKey(logged.sessionToken)).secret, user.secret);
});

test('ciphertext is bound to its account and key, and a missing master never creates a replacement', async t => {
  const f = await fixture(t), access = await f.open(), first = await f.register('first-owner'), second = await f.register('second-owner');
  assert.equal((await access.revealSessionKey(second.sessionToken)).secret, second.secret);
  await access.close(); const state = JSON.parse(await readFile(f.path, 'utf8'));
  state.accounts[0].keys[0].sealedSecret = state.accounts[1].keys[0].sealedSecret;
  await writeFile(f.path, JSON.stringify(state)); const reopened = await f.open();
  await assert.rejects(reopened.revealSessionKey(first.sessionToken), error => error.code === 'client_key_protection_unavailable');
  assert.equal((await reopened.revealSessionKey(second.sessionToken)).secret, second.secret);
  await reopened.close(); f.forgetMaster(); const saves = f.saves, missing = await f.open();
  await assert.rejects(missing.revealSessionKey(second.sessionToken), error => error.code === 'client_key_protection_unavailable');
  assert.equal(f.saves, saves);
});

test('legacy keys are escrowed only after exact authentication, without rotating keys or changing permissions', async t => {
  const f = await fixture(t), original = await f.open(false), user = await f.register('legacy-owner');
  const before = original.snapshot().accounts[0], reopened = await f.open();
  await assert.rejects(reopened.revealSessionKey(user.sessionToken), error => error.code === 'client_key_not_saved');
  assert.equal(await reopened.rememberKey('bfk_' + 'x'.repeat(43)), false);
  const results = await Promise.all([reopened.rememberKey(user.secret), reopened.rememberKey(user.secret)]);
  assert.deepEqual(results, [true, false]);
  assert.equal((await reopened.revealSessionKey(user.sessionToken)).secret, user.secret);
  const after = reopened.snapshot().accounts[0];
  assert.equal(after.id, before.id); assert.deepEqual(after.allowedModels, before.allowedModels);
  assert.equal(after.keys[0].id, before.keys[0].id); assert.equal(after.keys[0].expiresAt, before.keys[0].expiresAt);
  assert.equal((await readFile(f.path, 'utf8')).includes(user.secret), false);
});

test('reset failures keep the old key; rotation, disable and revocation cannot reveal an inactive key', async t => {
  const f = await fixture(t), access = await f.open(), user = await f.register('lifecycle-owner');
  const seal = f.protector.seal.bind(f.protector); f.protector.seal = async () => { throw new Error('PRIVATE OS error'); };
  await assert.rejects(access.changeSession(user.sessionToken, 'reset-key'), error => error.code === 'client_key_protection_unavailable' && !String(error).includes('PRIVATE'));
  assert.ok(access.authenticateKey(user.secret)); f.protector.seal = seal;
  const replacement = await access.changeSession(user.sessionToken, 'reset-key');
  assert.equal(access.authenticateKey(user.secret), null);
  assert.equal((await access.revealSessionKey(user.sessionToken)).secret, replacement.secret);
  const state = JSON.parse(await readFile(f.path, 'utf8')); assert.equal(state.accounts[0].keys[0].sealedSecret, undefined);
  const id = replacement.account.keys.at(-1).id;
  await access.updateKey(user.account.id, id, { enabled: false });
  await assert.rejects(access.revealSessionKey(user.sessionToken), error => error.code === 'client_key_not_available');
  await access.updateKey(user.account.id, id, { enabled: true });
  assert.equal((await access.revealSessionKey(user.sessionToken)).secret, replacement.secret);
  await access.changeSession(user.sessionToken, 'revoke-key');
  await assert.rejects(access.revealSessionKey(user.sessionToken), error => error.code === 'client_key_not_available');
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).accounts[0].keys.some(key => key.sealedSecret), false);
});

test('expiry during OS decryption still prevents revealing a key', async t => {
  const f = await fixture(t), access = await f.open(), user = await f.register('expiry-owner');
  await access.updateKey(user.account.id, user.key.id, { expiresAt: new Date(Date.now() + 1000).toISOString() });
  const reveal = f.protector.reveal.bind(f.protector); let unblock, entered;
  const started = new Promise(done => { entered = done; });
  f.protector.reveal = async (...args) => { entered(); await new Promise(done => { unblock = done; }); return reveal(...args); };
  const pending = access.revealSessionKey(user.sessionToken); await started; f.advance(2000); unblock();
  await assert.rejects(pending, error => error.code === 'client_key_not_available');
});
