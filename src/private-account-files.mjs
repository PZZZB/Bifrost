import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function readPrivateAccountFile(path, limit = 262_144) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Private file required.');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > limit || process.platform !== 'win32' &&
      ((metadata.mode & 0o077) || metadata.uid !== process.getuid())) throw new Error('Private file required.');
  return readFile(path, 'utf8');
}

export async function writePrivateAccountRecord(path, record) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(record) + '\n');
    await file.sync(); await file.close(); file = null;
    // Windows sharing violations can briefly block atomic replacement. Retry
    // only the same rename; keep the old file and the transaction lock intact.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } finally { await file?.close(); await rm(temporary, { force: true }); }
}

export class PrivateAccountFile {
  constructor(directory, validate) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || typeof validate !== 'function') throw new TypeError('Invalid private account file.');
    this.directory = directory; this.validate = validate;
    this.path = join(directory, 'accounts.json'); this.lock = join(directory, 'accounts.lock');
  }

  async read() {
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || process.platform !== 'win32' &&
        ((directory.mode & 0o077) || directory.uid !== process.getuid())) throw new Error('Private directory required.');
    return this.validate(JSON.parse(await readPrivateAccountFile(this.path)));
  }

  async transaction(operation) {
    await this.read();
    let locked = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await mkdir(this.lock, { mode: 0o700 }); locked = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; await delay(25); }
    }
    if (!locked) throw Object.assign(new Error('Account store busy.'), { status: 503, code: 'account_store_busy' });
    try {
      const record = await this.read();
      const result = await operation(record);
      this.validate(record);
      await writePrivateAccountRecord(this.path, record);
      return result;
    } finally { await rm(this.lock, { recursive: true, force: true }); }
  }
}

export async function initializePrivateAccounts(directory, keyName) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || !['identity.key', 'csrf.key'].includes(keyName)) throw new Error('Absolute private directory required.');
  await mkdir(directory, { mode: 0o700 });
  const file = await open(join(directory, keyName), 'wx', 0o600);
  try { await file.writeFile(randomBytes(32).toString('base64url') + '\n'); await file.sync(); } finally { await file.close(); }
  await writePrivateAccountRecord(join(directory, 'accounts.json'), { version: 1, accounts: [], invites: [] });
}
