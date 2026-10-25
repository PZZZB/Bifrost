import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { backupKey, createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup, atomicPrivateFile } from '../src/encrypted-backup.mjs';

const [command, configPath, archive, destination] = process.argv.slice(2);
if (!['create', 'verify', 'restore'].includes(command) || !configPath) {
  console.error('Usage: node scripts/encrypted-backup.mjs create|verify|restore CONFIG [ARCHIVE] [NEW_RESTORE_DIRECTORY]'); process.exit(2);
}
let config;
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
  if (command === 'create' && config.files.some(file => resolve(file.path) === resolve(config.keyFile)
    || resolve(file.path).startsWith(resolve(config.directory) + sep))) throw new Error('Recovery key and archives cannot be backup inputs.');
  const key = await backupKey(config.keyFile, { create: command === 'create' });
  const result = command === 'create' ? await createEncryptedBackup({ ...config, key })
    : command === 'verify' ? await verifyEncryptedBackup(archive, key)
    : await restoreEncryptedBackup({ path: archive, key, destination });
  if (command === 'create' && config.statusFile) await atomicPrivateFile(config.statusFile, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} catch {
  // No input filenames, contents, keys, or underlying filesystem error details in logs.
  if (command === 'create' && config?.statusFile) await atomicPrivateFile(config.statusFile,
    JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), error: 'backup_failed', externalCopy: false }) + '\n').catch(() => {});
  console.error('Encrypted backup operation failed; existing archives were preserved.'); process.exitCode = 1;
}
