import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { MacKeychainCrypto } from './mac-keychain-crypto.mjs';

const MAX_BYTES = 256 * 1024;

export class CredentialStoreError extends Error {
  constructor(code) { super(`Current-user credential store: ${code}`); this.code = code; }
}

function dpapiScript(operation, entropy) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$credentialBytes = $null
$credentialResult = $null
try {
  $credentialBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $credentialEntropy = [Convert]::FromBase64String('${entropy}')
  $credentialResult = [Security.Cryptography.ProtectedData]::${operation}($credentialBytes, $credentialEntropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($credentialResult))
} catch { [Console]::Error.Write('Current-user credential protection failed.'); exit 1 }
finally {
  if ($credentialBytes) { [Array]::Clear($credentialBytes, 0, $credentialBytes.Length) }
  if ($credentialResult) { [Array]::Clear($credentialResult, 0, $credentialResult.Length) }
}`;
}

/** Stores bridge-owned records; never reads another application's credential storage. */
export class CurrentUserCredentialStore {
  #path;
  #entropy;
  #platform;
  #execFile;
  #shell;
  #mac;
  #queue = Promise.resolve();

  constructor({ path, namespace, platform = process.platform, execFileImpl = execFile,
    powershellPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('A private credential path is required.');
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9.:-]{1,128}$/.test(namespace)) throw new TypeError('A fixed credential namespace is required.');
    this.#entropy = Buffer.from(namespace).toString('base64');
    this.#path = resolve(path); this.#platform = platform; this.#execFile = execFileImpl; this.#shell = powershellPath;
    if (platform === 'darwin') this.#mac = new MacKeychainCrypto({ path: this.#path, namespace, execFileImpl });
  }

  #serial(action) {
    const next = this.#queue.then(async () => {
      if (!['win32', 'darwin'].includes(this.#platform)) throw new CredentialStoreError('unsupported_platform');
      return action();
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  #crypt(operation, bytes) {
    if (this.#mac) return this.#mac.transform(operation, bytes).catch(() => { throw new CredentialStoreError('keychain_failed'); });
    return new Promise((resolveValue, reject) => {
      let child, settled = false;
      const finish = (error, stdout) => {
        if (settled) return;
        settled = true;
        if (error) { reject(new CredentialStoreError('dpapi_failed')); return; }
        const text = String(stdout ?? '').trim();
        if (!text || text.length > MAX_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4) {
          reject(new CredentialStoreError('invalid_dpapi_result')); return;
        }
        resolveValue(Buffer.from(text, 'base64'));
      };
      try {
        child = this.#execFile(this.#shell, ['-NoProfile', '-NonInteractive', '-Command', dpapiScript(operation, this.#entropy)],
          { windowsHide: true, timeout: 15000, maxBuffer: MAX_BYTES * 2, encoding: 'utf8' }, finish);
        if (!child?.stdin) { finish(true); return; }
        child.stdin.on('error', () => finish(true));
        // Only stdin carries credential data. Arguments contain the fixed DPAPI operation.
        child.stdin.end(bytes.toString('base64'));
      } catch { finish(true); }
    });
  }

  load() {
    return this.#serial(async () => {
      let content;
      try { content = await readFile(this.#path); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new CredentialStoreError('read_failed'); }
      let envelope;
      try {
        if (content.length > MAX_BYTES * 2) throw new Error();
        envelope = JSON.parse(content.toString('utf8'));
        if (envelope?.version !== 1 || envelope.protection !== (this.#mac ? 'macos-keychain-aes-gcm' : 'dpapi-current-user') ||
            typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) ||
            envelope.ciphertext.length % 4) throw new Error();
      } catch { throw new CredentialStoreError('invalid_envelope'); }
      const plain = await this.#crypt('Unprotect', Buffer.from(envelope.ciphertext, 'base64'));
      try {
        if (!plain.length || plain.length > MAX_BYTES) throw new Error();
        const record = JSON.parse(plain.toString('utf8'));
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error();
        return record;
      } catch { throw new CredentialStoreError('invalid_record'); }
      finally { plain.fill(0); }
    });
  }

  save(record) {
    return this.#serial(async () => {
      if (record == null) { await this.#clear(); return; }
      let plain;
      try {
        if (typeof record !== 'object' || Array.isArray(record)) throw new Error();
        plain = Buffer.from(JSON.stringify(record), 'utf8');
        if (!plain.length || plain.length > MAX_BYTES) throw new Error();
      } catch { throw new CredentialStoreError('invalid_record'); }
      let cipher;
      try { cipher = await this.#crypt('Protect', plain); }
      finally { plain.fill(0); }
      const content = `${JSON.stringify({ version: 1, protection: this.#mac ? 'macos-keychain-aes-gcm' : 'dpapi-current-user', ciphertext: cipher.toString('base64') })}\n`;
      const temporary = `${this.#path}.${randomBytes(12).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.#path);
      } catch { throw new CredentialStoreError('write_failed'); }
      finally { try { await unlink(temporary); } catch {} }
    });
  }

  async #clear() {
    try { await unlink(this.#path); }
    catch (error) { if (error.code !== 'ENOENT') throw new CredentialStoreError('clear_failed'); }
  }

  clear() { return this.save(null); }
}
