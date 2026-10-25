import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupKey, createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup } from '../src/encrypted-backup.mjs';

test('encrypted rolling backups restore exact bytes and reject tampering, wrong keys, and overwrites', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-backup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'accounts.json'), keyFile = join(root, 'recovery.key'), directory = join(root, 'archives');
  const content = Buffer.from('private password hash and provider token\u0000\u00ff');
  await writeFile(source, content, { mode: 0o600 }); const key = await backupKey(keyFile, { create: true });
  const options = { files: [{ name: 'state/accounts.json', path: source }, { name: 'optional.json', path: join(root, 'missing'), optional: true }], key, directory, retain: 2 };
  const results = [];
  for (let day = 1; day <= 3; day++) results.push(await createEncryptedBackup({ ...options, now: new Date(`2026-01-0${day}T00:00:00Z`) }));
  assert.equal((await readdir(directory)).length, 2);
  const archive = results.at(-1).archive, encrypted = await readFile(archive);
  assert.equal(encrypted.includes(content), false); assert.equal((await stat(archive)).mode & 0o077, 0);
  assert.equal((await verifyEncryptedBackup(archive, key)).fileCount, 1);
  const destination = join(root, 'restore'); const restored = await restoreEncryptedBackup({ path: archive, key, destination });
  assert.equal(restored.verified, true); assert.deepEqual(await readFile(join(destination, 'state/accounts.json')), content);
  await assert.rejects(restoreEncryptedBackup({ path: archive, key, destination }));
  await assert.rejects(verifyEncryptedBackup(archive, Buffer.alloc(32)));
  encrypted[encrypted.length - 1] ^= 1; const damaged = join(root, 'damaged'); await writeFile(damaged, encrypted);
  await assert.rejects(restoreEncryptedBackup({ path: damaged, key, destination: join(root, 'bad-restore') }));
  assert.equal((await readdir(root)).includes('bad-restore'), false);
});

test('backup refuses symlinks and unsafe archive names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-backup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const key = await backupKey(join(root, 'recovery.key'), { create: true }), file = join(root, 'secret');
  await writeFile(file, 'secret'); await symlink(file, join(root, 'link'));
  for (const entry of [{ name: '../escape', path: file }, { name: 'safe', path: join(root, 'link') }]) {
    await assert.rejects(createEncryptedBackup({ files: [entry], key, directory: join(root, 'archives') }));
  }
});
