import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientAccess } from '../src/client-access.mjs';
import { BridgeError } from '../src/storage.mjs';

const DAY = 86_400_000;
const PASSWORD = 'A strong client password 123';
const CB = 'claude-codebuddy-opus-5-5', CURSOR = 'Cursor-gemini-4-argon', B = 'B-gpt-6-astra';
const isError = (status, code) => value => value instanceof BridgeError && value.status === status && value.code === code;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-client-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'clients.json');
  let currentTime = Date.parse('2026-10-23T12:00:00.000Z');
  let models = [CB, CURSOR, B];
  const settings = { path, now: () => currentTime, allowedModelIds: () => models, ...options };
  const store = await ClientAccess.open(settings);
  return { directory, path, store, settings, advance: value => { currentTime += value; }, setModels: value => { models = value; } };
}

test('open registration creates one secret with a 30 day limit and no implicit model access', async t => {
  const { store, path } = await fixture(t);
  assert.deepEqual(store.registrationPolicy(), { mode: 'open', defaultKeyDays: 30 });
  const created = await store.register({ username: 'Alice.Test', password: PASSWORD });
  assert.equal(created.account.username, 'alice.test');
  assert.deepEqual(created.account.allowedModels, []);
  assert.equal(created.key.status, 'active'); assert.match(created.secret, /^bfk_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.expiresAt, '2026-11-22T12:00:00.000Z');
  assert.equal(created.account.keyExpiresAtLimit, created.key.expiresAt);
  assert.equal(created.expiresAt, '2026-10-24T12:00:00.000Z');
  assert.equal(store.authenticateSession(created.sessionToken).accountId, created.account.id);
  assert.deepEqual(store.authenticateKey(created.secret), { accountId: created.account.id, keyId: created.key.id, username: 'alice.test', allowedModels: [] });
  const saved = await readFile(path, 'utf8');
  assert.equal(saved.includes(PASSWORD), false); assert.equal(saved.includes(created.secret), false); assert.equal(saved.includes(created.sessionToken), false);
  const publicData = JSON.stringify(store.snapshot());
  for (const privateField of ['"hash"', '"password"', '"salt"', '"sessions"', created.secret]) assert.equal(publicData.includes(privateField), false);
  const detached = store.snapshot(); detached.accounts[0].allowedModels.push(CB); detached.accounts[0].keys[0].enabled = false;
  assert.deepEqual(store.authenticateKey(created.secret).allowedModels, []); assert.equal(store.publicAccount(created.account.id).keys[0].enabled, true);
});

test('passwords use distinct versioned scrypt salts and sessions persist as digests only', async t => {
  const { store, path, settings } = await fixture(t);
  const first = await store.createAccount({ username: 'first', password: PASSWORD, allowedModels: [CB] });
  await store.createAccount({ username: 'second', password: PASSWORD });
  const login = await store.login({ username: 'FIRST', password: PASSWORD });
  assert.match(login.sessionToken, /^bfs_[A-Za-z0-9_-]{43}$/);
  assert.equal(login.expiresAt, '2026-10-24T12:00:00.000Z');
  assert.deepEqual(store.authenticateSession(login.sessionToken), { accountId: first.id, username: 'first', allowedModels: [CB] });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.accounts[0].password.algorithm, 'scrypt'); assert.equal(saved.accounts[0].password.N, 32768);
  assert.notEqual(saved.accounts[0].password.salt, saved.accounts[1].password.salt);
  assert.notEqual(saved.accounts[0].password.hash, saved.accounts[1].password.hash);
  assert.equal(JSON.stringify(saved).includes(login.sessionToken), false);
  const reopened = await ClientAccess.open(settings);
  assert.equal(reopened.authenticateSession(login.sessionToken).accountId, first.id);
  assert.equal(await reopened.logout(login.sessionToken), true); assert.equal(reopened.authenticateSession(login.sessionToken), null);
  assert.equal(await reopened.logout(login.sessionToken), false);
});

test('wrong password, unknown account, and disabled account return the same login failure', async t => {
  const { store } = await fixture(t);
  const account = await store.createAccount({ username: 'present', password: PASSWORD });
  for (const value of [{ username: 'missing', password: PASSWORD }, { username: 'present', password: 'wrong password long enough' }]) {
    await assert.rejects(store.login(value), isError(401, 'client_login_failed'));
  }
  await store.updateAccount(account.id, { enabled: false });
  await assert.rejects(store.login({ username: 'present', password: PASSWORD }), isError(401, 'client_login_failed'));
});

test('disabling an account leaves its keys intact, revokes sessions, and scope changes apply immediately', async t => {
  const { store } = await fixture(t);
  const account = await store.createAccount({ username: 'scoped', password: PASSWORD, allowedModels: [CB] });
  const key = await store.createKey(account.id), login = await store.login({ username: 'scoped', password: PASSWORD });
  await store.updateAccount(account.id, { allowedModels: [CURSOR], enabled: false });
  assert.equal(store.authenticateKey(key.secret), null); assert.equal(store.authenticateSession(login.sessionToken), null);
  assert.equal(store.publicAccount(account.id).keys[0].enabled, true);
  await store.updateAccount(account.id, { enabled: true });
  assert.deepEqual(store.authenticateKey(key.secret).allowedModels, [CURSOR]); assert.equal(store.authenticateSession(login.sessionToken), null);
  await store.updateAccount(account.id, { password: 'Changed password long enough' });
  await assert.rejects(store.login({ username: 'scoped', password: PASSWORD }), isError(401, 'client_login_failed'));
  assert.ok((await store.login({ username: 'scoped', password: 'Changed password long enough' })).sessionToken);
});

test('key expiry and account term are separate; users cannot evade the term by creating or renewing keys', async t => {
  const { store, advance } = await fixture(t);
  const created = await store.register({ username: 'monthuser', password: PASSWORD });
  advance(29 * DAY);
  const later = await store.createKey(created.account.id, { expiresInDays: 365 });
  assert.equal(later.key.expiresAt, created.account.keyExpiresAtLimit);
  await assert.rejects(store.updateKey(created.account.id, created.key.id, { expiresInDays: 31 }), isError(403, 'client_key_term_exceeded'));
  advance(DAY);
  assert.equal(store.publicAccount(created.account.id).enabled, true);
  assert.equal(store.publicAccount(created.account.id).keys[0].status, 'expired');
  assert.equal(store.authenticateKey(created.secret), null);
  await assert.rejects(store.createKey(created.account.id), isError(403, 'client_key_term_expired'));
  await store.updateAccount(created.account.id, { keyExpiresAtLimit: '2026-12-22T12:00:00.000Z' });
  assert.equal(store.authenticateKey(created.secret), null); // Existing key's own expiry does not change.
  await store.updateKey(created.account.id, created.key.id, { expiresInDays: 30 });
  assert.equal(store.authenticateKey(created.secret).accountId, created.account.id);
});

test('shortening an account term changes effective key status without mutating key expiry', async t => {
  const { store, advance } = await fixture(t);
  const account = await store.createAccount({ username: 'shortterm', password: PASSWORD, keyExpiresAtLimit: null });
  const created = await store.createKey(account.id, { expiresInDays: 90 });
  await store.updateAccount(account.id, { keyExpiresAtLimit: '2026-10-24T12:00:00.000Z' });
  const key = store.publicAccount(account.id).keys[0];
  assert.equal(key.expiresAt, created.key.expiresAt); assert.equal(key.effectiveExpiresAt, '2026-10-24T12:00:00.000Z');
  advance(DAY); assert.equal(store.authenticateKey(created.secret), null);
  assert.equal(store.publicAccount(account.id).keys[0].status, 'expired');
  await store.updateAccount(account.id, { keyExpiresAtLimit: null }); assert.ok(store.authenticateKey(created.secret));
});

test('key disable, re-enable, and irreversible revocation remain independent of account status', async t => {
  const { store } = await fixture(t);
  const account = await store.createAccount({ username: 'keyuser', password: PASSWORD });
  const created = await store.createKey(account.id, { name: 'My CodeBuddy', expiresInDays: 2 });
  await store.updateKey(account.id, created.key.id, { enabled: false }); assert.equal(store.authenticateKey(created.secret), null);
  assert.equal(store.publicAccount(account.id).enabled, true);
  await store.updateKey(account.id, created.key.id, { enabled: true, expiresInDays: 4 }); assert.ok(store.authenticateKey(created.secret));
  const revoked = await store.revokeKey(account.id, created.key.id); assert.equal(revoked.status, 'revoked');
  await assert.rejects(store.updateKey(account.id, created.key.id, { enabled: true }), isError(409, 'client_key_revoked'));
  assert.equal(store.authenticateKey(created.secret), null);
  const replacement = await store.createKey(account.id); assert.notEqual(replacement.secret, created.secret);
});

test('model grants require explicit safe adapter ids in the current catalog and never expose native A', async t => {
  const { store, setModels } = await fixture(t);
  for (const values of [['gpt-6-astra'], ['B-fake'], ['Cursor-unknown'], [CB, CB], ['CodeBuddy-sk-secretcredential'], ['Cursor-../x']]) {
    await assert.rejects(store.createAccount({ username: 'invalid', password: PASSWORD, allowedModels: values }), error => error.status === 400);
  }
  const account = await store.createAccount({ username: 'granted', password: PASSWORD, allowedModels: [CB, CURSOR, B] });
  const key = await store.createKey(account.id); assert.deepEqual(store.authenticateKey(key.secret).allowedModels, [CB, CURSOR, B]);
  setModels([]);
  await assert.rejects(store.updateAccount(account.id, { allowedModels: [CB] }), isError(400, 'client_model_not_available'));
  assert.deepEqual(store.authenticateKey(key.secret).allowedModels, [CB, CURSOR, B]);
  await store.updateAccount(account.id, { allowedModels: [] }); assert.deepEqual(store.authenticateKey(key.secret).allowedModels, []);
});

test('invitations are optional in open mode and grant only their explicit scope', async t => {
  const { store, path } = await fixture(t);
  const invite = await store.createInvite({ allowedModels: [CB], maxUses: 2 });
  assert.match(invite.token, /^bfi_[A-Za-z0-9_-]{43}$/);
  const created = await store.register({ username: 'invited', password: PASSWORD, inviteToken: invite.token });
  assert.deepEqual(created.account.allowedModels, [CB]); assert.equal(store.snapshot().invites[0].uses, 1);
  assert.equal((await readFile(path, 'utf8')).includes(invite.token), false);
  const uninvited = await store.register({ username: 'notinvited', password: PASSWORD }); assert.deepEqual(uninvited.account.allowedModels, []);
  await assert.rejects(store.register({ username: 'badinvite', password: PASSWORD, inviteToken: 'bfi_' + 'x'.repeat(43) }), isError(403, 'client_invite_invalid'));
});

test('invite-only and closed policies enforce expiry, usage, revocation, and concurrent consumption', async t => {
  const { store, advance } = await fixture(t);
  await store.configureRegistration({ mode: 'invite', defaultKeyDays: 14 });
  await assert.rejects(store.register({ username: 'noinvite', password: PASSWORD }), isError(403, 'client_invite_invalid'));
  const invite = await store.createInvite({ maxUses: 1, allowedModels: [CURSOR] });
  const attempts = await Promise.allSettled(['racerone', 'racertwo'].map(value => store.register({ username: value, password: PASSWORD, inviteToken: invite.token })));
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected')[0].reason.code, 'client_invite_invalid');
  assert.equal(store.snapshot().invites[0].status, 'used');
  const old = await store.createInvite({ expiresInDays: 1 }); advance(DAY);
  await assert.rejects(store.register({ username: 'oldinvite', password: PASSWORD, inviteToken: old.token }), isError(403, 'client_invite_invalid'));
  const revoked = await store.createInvite(); await store.revokeInvite(revoked.invite.id);
  await assert.rejects(store.register({ username: 'revokedinvite', password: PASSWORD, inviteToken: revoked.token }), isError(403, 'client_invite_invalid'));
  await store.configureRegistration({ mode: 'closed' });
  await assert.rejects(store.register({ username: 'closeduser', password: PASSWORD }), isError(403, 'client_registration_closed'));
  const manual = await store.createAccount({ username: 'admincreated', password: PASSWORD }); assert.ok(manual.id);
});

test('at most ten active keys can be created or enabled, while disabled and expired keys do not consume slots', async t => {
  const { store } = await fixture(t);
  const account = await store.createAccount({ username: 'manykeys', password: PASSWORD });
  const keys = [];
  for (let index = 0; index < 10; index++) keys.push(await store.createKey(account.id, { name: `Key ${index}` }));
  await assert.rejects(store.createKey(account.id), isError(409, 'client_active_key_limit'));
  await store.updateKey(account.id, keys[0].key.id, { enabled: false });
  await store.createKey(account.id);
  await assert.rejects(store.updateKey(account.id, keys[0].key.id, { enabled: true }), isError(409, 'client_active_key_limit'));
  await store.revokeKey(account.id, keys[1].key.id);
  await store.updateKey(account.id, keys[0].key.id, { enabled: true });
  assert.equal(store.publicAccount(account.id).keys.filter(key => key.status === 'active').length, 10);
});

test('expiry boundaries and token types prevent API keys from acting as sessions or invites', async t => {
  const { store, advance } = await fixture(t);
  const created = await store.register({ username: 'expiryuser', password: PASSWORD });
  const login = await store.login({ username: 'expiryuser', password: PASSWORD });
  assert.equal(store.authenticateSession(created.secret), null); assert.equal(store.authenticateKey(login.sessionToken), null);
  for (const value of ['', null, 123, created.secret + ' ', 'Bearer ' + created.secret, 'bfk_' + 'x'.repeat(100000)]) assert.equal(store.authenticateKey(value), null);
  advance(DAY); assert.equal(store.authenticateSession(login.sessionToken), null); assert.ok(store.authenticateKey(created.secret));
  advance(29 * DAY); assert.equal(store.authenticateKey(created.secret), null);
});

test('unknown fields, getters, invalid dates, and cross-account keys are rejected', async t => {
  const { store } = await fixture(t);
  for (const options of [null, [], { username: 'short', password: 'short' }, { username: '__bad', password: PASSWORD },
    { username: 'valid', password: PASSWORD, admin: true }, { get username() { throw new Error('must not run'); }, password: PASSWORD }]) {
    await assert.rejects(store.createAccount(options));
  }
  const first = await store.createAccount({ username: 'ownerone', password: PASSWORD }), second = await store.createAccount({ username: 'ownertwo', password: PASSWORD });
  const key = await store.createKey(first.id);
  await assert.rejects(store.updateKey(second.id, key.key.id, { enabled: false }), isError(404, 'client_key_not_found'));
  for (const options of [{ expiresInDays: 0 }, { expiresInDays: 3651 }, { expiresAt: '2026-13-01' }, { expiresAt: '2020-01-01T00:00:00.000Z' }, { secret: 'overwrite' }]) {
    await assert.rejects(store.updateKey(first.id, key.key.id, options));
  }
  assert.ok(store.authenticateKey(key.secret));
});

test('concurrent writes preserve both accounts and reject duplicate names atomically', async t => {
  const { store, settings } = await fixture(t);
  await Promise.all(['parallelone', 'paralleltwo', 'parallelthree'].map(value => store.createAccount({ username: value, password: PASSWORD })));
  const results = await Promise.allSettled(['SAMEUSER', 'sameuser'].map(value => store.createAccount({ username: value, password: PASSWORD })));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.filter(value => value.status === 'rejected')[0].reason.code, 'client_username_exists');
  assert.equal((await ClientAccess.open(settings)).snapshot().accounts.length, 4);
});

test('failed atomic replacement keeps the committed in-memory authorization intact', async t => {
  const { store, path } = await fixture(t);
  const created = await store.register({ username: 'committed', password: PASSWORD });
  await rename(path, path + '.saved'); await mkdir(path);
  const revision = store.snapshot().revision;
  await assert.rejects(store.updateAccount(created.account.id, { enabled: false }), isError(503, 'client_access_write_failed'));
  assert.equal(store.snapshot().revision, revision); assert.ok(store.authenticateKey(created.secret));
  await rm(path, { recursive: true }); await rename(path + '.saved', path);
  await store.updateAccount(created.account.id, { enabled: false }); assert.equal(store.authenticateKey(created.secret), null);
});

test('corrupt, oversized, malicious, and symlinked stored credentials fail closed', async t => {
  const { path, settings, directory } = await fixture(t);
  for (const data of ['not json', '{}', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await writeFile(path, data); await assert.rejects(ClientAccess.open(settings), isError(503, 'client_access_unavailable'));
  }
  await rm(path); const clean = await ClientAccess.open(settings);
  await clean.createAccount({ username: 'validstore', password: PASSWORD });
  const saved = JSON.parse(await readFile(path, 'utf8')); saved.accounts[0].password.N = 2 ** 30;
  await writeFile(path, JSON.stringify(saved)); await assert.rejects(ClientAccess.open(settings), isError(503, 'client_access_unavailable'));
  await rm(path); const target = join(directory, 'target.json'); await writeFile(target, '{}');
  try { await symlink(target, path); } catch (cause) { if (['EPERM', 'EACCES'].includes(cause.code)) return; throw cause; }
  await assert.rejects(ClientAccess.open(settings), isError(503, 'client_access_unavailable'));
});

test('closing flushes queued writes and refuses further authorization or mutation', async t => {
  const { store } = await fixture(t);
  const created = await store.register({ username: 'closeuser', password: PASSWORD });
  const pending = store.updateAccount(created.account.id, { allowedModels: [CB] });
  await store.close(); await pending;
  assert.equal(store.authenticateKey(created.secret), null);
  await assert.rejects(store.createKey(created.account.id), isError(503, 'client_access_unavailable'));
});
