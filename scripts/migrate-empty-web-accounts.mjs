import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { WebAccountStore } from '../src/web-account-store.mjs';
import { ClientAccess } from '../src/client-access.mjs';
import { readPrivateAccountFile, writePrivateAccountRecord } from '../src/private-account-files.mjs';

// Deliberately refuses populated stores: password and API-key hashes use
// different schemes. Never silently discard or reset an existing user/key.
try {
  const [configPath, ownerPath, stateDir, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length || confirmation !== '--writers-stopped' || ![configPath, ownerPath, stateDir].every(isAbsolute)) throw new Error();
  const config = JSON.parse(await readPrivateAccountFile(configPath));
  const source = new WebAccountStore(config), record = await source.read();
  const owner = JSON.parse(await readPrivateAccountFile(ownerPath));
  if (record.accounts.length || !/^bfi_[A-Za-z0-9_-]{43}$/.test(owner.inviteCode) || record.invites.length !== 1
    || record.invites[0].keySha256 !== createHash('sha256').update(owner.inviteCode).digest('hex')
    || record.invites[0].expiresAt !== owner.expiresAt) throw new Error();
  const createdAt = new Date().toISOString();
  const state = { version: 1, revision: 1, registrationPolicy: { mode: 'invite', defaultKeyDays: 30 }, accounts: [], sessions: [], invites: [{
    id: randomUUID(), hash: createHash('sha256').update(`bifrost-client-invite-v1\0${owner.inviteCode}`).digest('hex'), lastFour: owner.inviteCode.slice(-4),
    createdAt, expiresAt: new Date(owner.expiresAt).toISOString(), revokedAt: null, maxUses: 1, uses: 0, allowedModels: [] }] };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'client-access.json'), file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state) + '\n'); await file.sync(); } finally { await file.close(); }
  try {
    const access = await ClientAccess.open({ path }); await access.close();
    await writePrivateAccountRecord(join(config.directory, 'migrated-to.json'), { version: 1, stateDir, migratedAt: createdAt,
      accountCount: 0, invitationPreserved: true });
  } catch (error) { await rm(path, { force: true }); throw error; }
  console.log(JSON.stringify({ ok: true, accountCount: 0, invitationPreserved: true }));
} catch {
  console.error('Migration refused. Stop all writers, preserve an encrypted backup, and verify the legacy store has no users and exactly the known invitation. Existing canonical files are never overwritten.');
  process.exitCode = 1;
}
