import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

export const MAC_CREDENTIAL_KEY_SERVICE = 'Bifrost.CredentialEncryption.v1';
const failed = () => Object.assign(new Error('macOS credential protection is unavailable.'), { code: 'keychain_failed' });
/** Own generic-password entries only. Secret material never appears in argv. */
export class MacKeychainCrypto {
  constructor({ path, namespace, execFileImpl = execFile }) {
    this.account = createHash('sha256').update(JSON.stringify([path, namespace])).digest('hex');
    this.exec = execFileImpl;
    this.aad = Buffer.from(JSON.stringify([MAC_CREDENTIAL_KEY_SERVICE, this.account]));
  }
  run(args, input) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.exec('/usr/bin/security', args, { timeout: 15000, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => {
          if (error) { if (input === undefined && error.code === 44) resolve(null); else reject(failed()); }
          else resolve(String(stdout ?? '').trim());
        });
        if (input !== undefined) {
          if (!child?.stdin) { reject(failed()); return; }
          child.stdin.on('error', () => reject(failed())); child.stdin.end(input);
        }
      } catch { reject(failed()); }
    });
  }
  async key(create) {
    const args = ['find-generic-password', '-s', MAC_CREDENTIAL_KEY_SERVICE, '-a', this.account, '-w'];
    let hex = await this.run(args);
    if (hex === null && create) {
      const candidate = randomBytes(32);
      try {
        // No -U: concurrent creators cannot overwrite the winning key. Re-read it.
        await this.run(['-i'], `add-generic-password -s ${MAC_CREDENTIAL_KEY_SERVICE} -a ${this.account} -w ${candidate.toString('hex')}\n`);
      } finally { candidate.fill(0); }
      hex = await this.run(args);
    }
    if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/.test(hex)) throw failed();
    return Buffer.from(hex, 'hex');
  }
  async transform(operation, bytes) {
    const key = await this.key(operation === 'Protect');
    try {
      if (operation === 'Protect') {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(this.aad);
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
      }
      if (bytes.length < 29) throw failed();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(this.aad); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    } catch { throw failed(); } finally { key.fill(0); }
  }
}
