import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CurrentUserCredentialStore } from './current-user-credential-store.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const KEY = /^bfk_[A-Za-z0-9_-]{43}$/;
const unavailable = () => new Error('Client API key protection is unavailable.');
export const isSealedClientKey = value => typeof value === 'string' && /^bke1_[A-Za-z0-9_-]{100}$/.test(value);

/** The account DB holds authenticated ciphertext; one OS-protected wrapping
 * key is backed up separately. Public account projections never expose either. */
export class ClientKeyProtector {
  #store; #master = null; #closed = false;
  constructor({ path, store = null } = {}) {
    this.#store = store ?? new CurrentUserCredentialStore({ path, namespace: 'Bifrost.ClientKeyReveal.v1' });
  }
  #context({ accountId, keyId }) {
    if (!UUID.test(accountId) || !UUID.test(keyId)) throw unavailable();
    return Buffer.from(JSON.stringify(['Bifrost.ClientKey.v1', accountId, keyId]));
  }
  #key(create = false) {
    if (this.#closed) throw unavailable();
    return this.#master ??= (async () => {
      let record = await this.#store.load();
      if (record === null && create) {
        record = { version: 1, key: randomBytes(32).toString('hex') };
        await this.#store.save(record);
      }
      if (record?.version !== 1 || Object.keys(record).length !== 2 || typeof record.key !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.key)) throw unavailable();
      return Buffer.from(record.key, 'hex');
    })().catch(() => { this.#master = null; throw unavailable(); });
  }
  async seal(value, context) {
    if (!KEY.test(value)) throw unavailable();
    const aad = this.#context(context), key = await this.#key(true), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return 'bke1_' + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  async reveal(value, context) {
    if (!isSealedClientKey(value)) throw unavailable();
    try {
      const aad = this.#context(context), key = await this.#key(), bytes = Buffer.from(value.slice(5), 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(12, 28));
      const plain = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
      try { const secret = plain.toString('utf8'); if (!KEY.test(secret)) throw unavailable(); return secret; }
      finally { plain.fill(0); }
    } catch { throw unavailable(); }
  }
  async close() { this.#closed = true; try { (await this.#master)?.fill(0); } catch {} this.#master = null; }
}
