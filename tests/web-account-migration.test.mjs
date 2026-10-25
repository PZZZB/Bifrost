import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeWebAccounts, WebAccountStore } from '../src/web-account-store.mjs';
import { ClientAccess } from '../src/client-access.mjs';

const run = promisify(execFile), script = fileURLToPath(new URL('../scripts/migrate-empty-web-accounts.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'legacy'); await initializeWebAccounts(directory);
  const old = new WebAccountStore({ directory, checkEmailDomain: async () => 'mx' }), owner = await old.invite();
  const config = join(root, 'config.json'), ownerFile = join(root, 'owner.json'), target = join(root, 'canonical');
  await writeFile(config, JSON.stringify({ directory }), { mode: 0o600 }); await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  const migrate = () => run(process.execPath, [script, config, ownerFile, target, '--writers-stopped']);
  return { old, owner, target, migrate, directory };
}
test('empty migration preserves the exact invitation and disables the old writer', async t => {
  const f = await fixture(t); assert.equal(JSON.parse((await f.migrate()).stdout).invitationPreserved, true);
  await assert.rejects(f.old.invite());
  const path = join(f.target, 'client-access.json'), original = await readFile(path);
  assert.equal((await stat(path)).mode & 0o077, 0); assert.equal(original.includes(f.owner.inviteCode), false);
  await assert.rejects(f.migrate()); assert.deepEqual(await readFile(path), original);
  const access = await ClientAccess.open({ path }); t.after(() => access.close());
  const created = await access.register({ username: 'migrated@example.com', password: 'Offline migration password', inviteToken: f.owner.inviteCode });
  assert.equal(created.account.username, 'migrated@example.com'); assert.deepEqual(created.account.allowedModels, []);
});
test('populated migration refuses to reset users or existing keys', async t => {
  const f = await fixture(t);
  const user = await f.old.register({ email: 'existing@example.com', password: 'Offline migration password', inviteCode: f.owner.inviteCode, privacyAccepted: true });
  const before = await readFile(join(f.directory, 'accounts.json'));
  await assert.rejects(f.migrate()); assert.deepEqual(await readFile(join(f.directory, 'accounts.json')), before);
  assert.equal((await f.old.clients()).length, 1); assert.equal((await f.old.me(user.sessionToken)).account.username, 'existing@example.com');
  await assert.rejects(stat(join(f.target, 'client-access.json')), error => error.code === 'ENOENT');
});
