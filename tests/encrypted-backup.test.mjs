import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, readdir, stat, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupKey, createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup } from '../src/encrypted-backup.mjs';

const run = promisify(execFile);
const posixOnly = { skip: process.platform === 'win32' ? 'Requires POSIX private permissions and no-follow reads.' : false };
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-specific fail-closed platform guard.' : false };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-backup-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('encrypted rolling backups restore exact bytes and reject tampering, wrong keys, and overwrites', async t => {
  const root = await fixture(t), source = join(root, 'accounts.json'), directory = join(root, 'archives');
  const content = Buffer.from('private password hash and provider token\u0000\u00ff'), key = randomBytes(32);
  await writeFile(source, content, { mode: 0o600 });
  const options = { files: [{ name: 'state/accounts.json', path: source }, { name: 'optional.json', path: join(root, 'missing'), optional: true }], key, directory, retain: 2 };
  const results = [];
  for (let day = 1; day <= 3; day++) results.push(await createEncryptedBackup({ ...options, now: new Date(`2026-01-0${day}T00:00:00Z`) }));
  assert.equal((await readdir(directory)).length, 2);
  const archive = results.at(-1).archive, encrypted = await readFile(archive);
  assert.equal(encrypted.includes(content), false);
  assert.equal((await verifyEncryptedBackup(archive, key)).fileCount, 1);
  const destination = join(root, 'restore'); const restored = await restoreEncryptedBackup({ path: archive, key, destination });
  assert.equal(restored.verified, true); assert.deepEqual(await readFile(join(destination, 'state/accounts.json')), content);
  await assert.rejects(restoreEncryptedBackup({ path: archive, key, destination }));
  await assert.rejects(verifyEncryptedBackup(archive, Buffer.alloc(32)));
  encrypted[encrypted.length - 1] ^= 1; const damaged = join(root, 'damaged'); await writeFile(damaged, encrypted);
  await assert.rejects(restoreEncryptedBackup({ path: damaged, key, destination: join(root, 'bad-restore') }));
  assert.equal((await readdir(root)).includes('bad-restore'), false);
});

test('backup rejects unsafe archive names, duplicates, and non-file inputs before creating an archive', async t => {
  const root = await fixture(t), key = randomBytes(32), file = join(root, 'secret'), directory = join(root, 'archives');
  await writeFile(file, 'secret');
  for (const name of ['../escape', 'state/../escape', '/absolute', 'state\\escape', './file', 'state//file', 'bad\u0000name', '']) {
    await assert.rejects(createEncryptedBackup({ files: [{ name, path: file }], key, directory }), /Invalid backup file list/);
  }
  await assert.rejects(createEncryptedBackup({ files: [{ name: 'same', path: file }, { name: 'same', path: file }], key, directory }), /Invalid backup file list/);
  await assert.rejects(createEncryptedBackup({ files: [{ name: 'directory', path: root }], key, directory }), /Unsafe backup input/);
  assert.equal((await readdir(root)).includes('archives'), false);
});

test('POSIX recovery keys, encrypted archives, and restored files retain private permissions', posixOnly, async t => {
  const root = await fixture(t), keyFile = join(root, 'recovery', 'master.key'), source = join(root, 'source');
  const key = await backupKey(keyFile, { create: true });
  assert.equal(key.length, 32); assert.deepEqual(await backupKey(keyFile, { create: true }), key);
  assert.deepEqual(await backupKey(keyFile), key);
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'recovery'))).mode & 0o777, 0o700);
  await writeFile(source, 'private', { mode: 0o600 });
  const backup = await createEncryptedBackup({ files: [{ name: 'state/source', path: source }], key, directory: join(root, 'archives') });
  assert.equal((await stat(backup.archive)).mode & 0o077, 0);
  const destination = join(root, 'restore');
  await restoreEncryptedBackup({ path: backup.archive, key, destination });
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(join(destination, 'state/source'))).mode & 0o777, 0o600);
  await chmod(keyFile, 0o644);
  await assert.rejects(backupKey(keyFile), /Unsafe backup input/);
  await chmod(keyFile, 0o600);
  await writeFile(keyFile, Buffer.alloc(31));
  await assert.rejects(backupKey(keyFile), /Invalid recovery key/);
});

test('POSIX backup and recovery-key reads reject symlinks', posixOnly, async t => {
  const root = await fixture(t), key = randomBytes(32), file = join(root, 'secret'), link = join(root, 'link');
  await writeFile(file, key, { mode: 0o600 }); await symlink(file, link);
  await assert.rejects(backupKey(link));
  await assert.rejects(backupKey(link, { create: true }));
  await assert.rejects(createEncryptedBackup({ files: [{ name: 'safe', path: link }], key, directory: join(root, 'archives') }));
  assert.equal((await readdir(root)).includes('archives'), false);
  assert.deepEqual(await readFile(file), key);
});

test('Windows recovery keys reject the platform before creating directories or changing files', windowsOnly, async t => {
  const root = await fixture(t), keyFile = join(root, 'recovery', 'master.key'), existing = join(root, 'existing.key');
  await assert.rejects(backupKey(keyFile, { create: true }), { code: 'backup_platform_unsupported' });
  await assert.rejects(backupKey(keyFile), { code: 'backup_platform_unsupported' });
  assert.deepEqual(await readdir(root), []);
  const original = randomBytes(32); await writeFile(existing, original);
  await assert.rejects(backupKey(existing, { create: true }), { code: 'backup_platform_unsupported' });
  assert.deepEqual(await readFile(existing), original);
});

test('Windows backup CLI rejects all operations without creating keys, archives, restore data, or status files', windowsOnly, async t => {
  const root = await fixture(t), configPath = join(root, 'config.json'), source = join(root, 'source');
  const keyFile = join(root, 'recovery', 'master.key'), directory = join(root, 'archives'), statusFile = join(root, 'status.json');
  await writeFile(source, 'offline fixture');
  await writeFile(configPath, JSON.stringify({ keyFile, directory, statusFile, files: [{ name: 'source', path: source }] }));
  const script = fileURLToPath(new URL('../scripts/encrypted-backup.mjs', import.meta.url));
  const before = (await readdir(root)).sort();
  for (const command of ['create', 'verify', 'restore']) {
    await assert.rejects(run(process.execPath, [script, command, configPath, join(root, 'missing.bfbackup'), join(root, 'restore')]), error => {
      assert.equal(error.code, 1); assert.equal(error.stdout, '');
      assert.match(error.stderr, /Windows is not supported \(backup_platform_unsupported\)/);
      assert.ok(!error.stderr.includes(root));
      return true;
    });
    assert.deepEqual((await readdir(root)).sort(), before);
  }
  const previousStatus = 'previous verified backup status\n'; await writeFile(statusFile, previousStatus);
  await assert.rejects(run(process.execPath, [script, 'create', configPath]), { code: 1 });
  assert.equal(await readFile(statusFile, 'utf8'), previousStatus);
});
