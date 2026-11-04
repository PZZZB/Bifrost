import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAGIC = Buffer.from('BFBACK01');
const LIMIT = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = value => typeof value === 'string' && value.length < 1024 && !isAbsolute(value)
  && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');

/** The recovery-key CLI requires POSIX permissions; Windows ACL support is not implemented. */
export function assertBackupPlatform() {
  if (process.platform === 'win32') throw Object.assign(
    new Error('Encrypted backup commands require POSIX file permissions; Windows is not supported.'),
    { code: 'backup_platform_unsupported' },
  );
}

async function regular(path, limit = LIMIT, privateOnly = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || privateOnly && (stat.mode & 0o077)) throw new Error('Unsafe backup input.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new Error('Backup input exceeds size limit.');
    return { bytes, stat };
  } finally { await handle.close(); }
}

export async function backupKey(path, { create = false } = {}) {
  assertBackupPlatform();
  if (create) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(path, 'wx', 0o600); await handle.writeFile(randomBytes(32)); await handle.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await handle?.close(); }
  }
  const { bytes } = await regular(path, 32, true);
  if (bytes.length !== 32) throw new Error('Invalid recovery key.');
  return bytes;
}

export async function atomicPrivateFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync();
    await handle.close(); handle = null; await rename(temporary, path);
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

function decode(bytes, key) {
  if (bytes.length < 36 || bytes.length > LIMIT || !bytes.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid encrypted backup.');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8, 20));
  decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(20, 36));
  const packed = Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
  const data = JSON.parse(gunzipSync(packed, { maxOutputLength: LIMIT }).toString('utf8'));
  if (data.version !== 1 || !Number.isFinite(Date.parse(data.createdAt)) || !Array.isArray(data.files)
    || !data.files.length || data.files.length > 4096) throw new Error('Invalid backup manifest.');
  const names = new Set(); let total = 0;
  for (const file of data.files) {
    if (!safeName(file.name) || names.has(file.name) || !Number.isInteger(file.mode) || (file.mode & ~0o700)
      || typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('Invalid backup entry.');
    const bytes = Buffer.from(file.content, 'base64'); total += bytes.length;
    if (total > LIMIT || hash(bytes) !== file.sha256) throw new Error('Backup integrity check failed.');
    names.add(file.name);
  }
  return data;
}

/** Explicit allowlist only; no logs, disk images, or recursive directory capture. */
export async function createEncryptedBackup({ files, key, directory, retain = 14, now = new Date() }) {
  if (!Array.isArray(files) || !files.length || files.length > 4096 || !Buffer.isBuffer(key) || key.length !== 32
    || !Number.isInteger(retain) || retain < 1 || retain > 365) throw new TypeError('Invalid backup options.');
  const names = new Set();
  for (const file of files) {
    if (!safeName(file.name) || names.has(file.name) || typeof file.path !== 'string' || !isAbsolute(file.path)) throw new TypeError('Invalid backup file list.');
    names.add(file.name);
  }
  let entries;
  // Check the whole set before and after reading. Atomic account-store replacement
  // during a snapshot changes the inode and makes the entire attempt retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await Promise.all(files.map(async file => {
      try { const stat = await lstat(file.path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe backup input.'); return stat; }
      catch (error) { if (file.optional === true && error.code === 'ENOENT') return null; throw error; }
    }));
    entries = []; let total = 0, changed = false;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!before[index]) continue;
      try {
        const { bytes, stat } = await regular(file.path); total += bytes.length;
        if (total > LIMIT / 2) throw new Error('Backup exceeds size limit.');
        if (stat.ino !== before[index].ino || stat.mtimeMs !== before[index].mtimeMs || stat.size !== before[index].size) changed = true;
        entries.push({ name: file.name, mode: (stat.mode & 0o700) | 0o600, sha256: hash(bytes), content: bytes.toString('base64') });
      } catch (error) { if (error.code === 'ENOENT') { changed = true; continue; } throw error; }
    }
    const after = await Promise.all(files.map(file => lstat(file.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
    if (after.some((stat, index) => (!stat !== !before[index]) || stat && (stat.ino !== before[index].ino || stat.mtimeMs !== before[index].mtimeMs || stat.size !== before[index].size))) changed = true;
    if (!changed) break;
    if (attempt === 3) throw new Error('Backup inputs are changing; retry later.');
  }
  const payload = Buffer.from(JSON.stringify({ version: 1, createdAt: now.toISOString(), files: entries }));
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(payload)), cipher.final()]);
  const output = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  decode(output, key);
  const name = `bifrost-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}.bfbackup`;
  const path = resolve(directory, name); await atomicPrivateFile(path, output);
  await verifyEncryptedBackup(path, key);
  const old = (await readdir(directory)).filter(name => /^bifrost-[0-9TZ]+-[0-9a-f]{8}\.bfbackup$/.test(name)).sort().reverse();
  for (const name of old.slice(retain)) await rm(resolve(directory, name));
  return { version: 1, ok: true, createdAt: now.toISOString(), archive: path, fileCount: entries.length, encryptedBytes: output.length,
    sha256: hash(output), externalCopy: false };
}

export async function verifyEncryptedBackup(path, key) {
  const { bytes } = await regular(path); const data = decode(bytes, key);
  return { createdAt: data.createdAt, fileCount: data.files.length, encryptedBytes: bytes.length, sha256: hash(bytes) };
}

/** Restore into a NEW private directory. Existing files are never overwritten. */
export async function restoreEncryptedBackup({ path, key, destination }) {
  const { bytes } = await regular(path), data = decode(bytes, key);
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const file of data.files) {
      const target = resolve(destination, file.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, 'wx', file.mode);
      try { await handle.writeFile(Buffer.from(file.content, 'base64')); await handle.sync(); }
      finally { await handle.close(); }
      const restored = await regular(target);
      if (hash(restored.bytes) !== file.sha256) throw new Error('Restored file integrity check failed.');
    }
    return { ok: true, fileCount: data.files.length, createdAt: data.createdAt, verified: true };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
