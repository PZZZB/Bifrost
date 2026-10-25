import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PrivateAccountFile, initializePrivateAccounts } from './private-account-files.mjs';
export { readPrivateAccountFile } from './private-account-files.mjs';

export const ACCOUNT_PRIVACY_VERSION = '2026-10-25';
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const token = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(value);
const accountError = (status, code) => Object.assign(new Error(code), { status, code });
const mint = prefix => prefix + randomBytes(32).toString('base64url');

function validateRecord(record) {
  if (record?.version !== 1 || !Array.isArray(record.accounts) || record.accounts.length > 90 ||
      !Array.isArray(record.invites) || record.invites.length > 200) throw new Error('Invalid account store.');
  const ids = new Set(), identities = new Set(), keys = new Set(), sessions = new Set(), invites = new Set();
  for (const account of record.accounts) {
    if (!/^wx_[a-f0-9]{24}$/.test(account.id) || ids.has(account.id) ||
        !hash(account.identityHash) || identities.has(account.identityHash) ||
        !['active', 'disabled'].includes(account.status) || !Number.isSafeInteger(account.createdAt) ||
        !Number.isSafeInteger(account.acceptedAt) || account.privacyVersion !== ACCOUNT_PRIVACY_VERSION ||
        !Number.isInteger(account.maxConcurrent) || account.maxConcurrent < 1 || account.maxConcurrent > 8 ||
        !Number.isInteger(account.requestsPerMinute) || account.requestsPerMinute < 1 || account.requestsPerMinute > 600 ||
        account.keySha256 !== null && (!hash(account.keySha256) || keys.has(account.keySha256)) ||
        account.session !== null && (!hash(account.session?.hash) || sessions.has(account.session.hash) ||
          !Number.isSafeInteger(account.session.expiresAt))) throw new Error('Invalid account store.');
    ids.add(account.id); identities.add(account.identityHash);
    if (account.keySha256) keys.add(account.keySha256);
    if (account.session) sessions.add(account.session.hash);
  }
  for (const invite of record.invites) {
    if (!hash(invite.keySha256) || invites.has(invite.keySha256) || !Number.isSafeInteger(invite.expiresAt)) {
      throw new Error('Invalid account store.');
    }
    invites.add(invite.keySha256);
  }
  return record;
}

/** Small, bounded single-Mac store. A filesystem lock serializes transactions
 * across the gateway and local administration CLI; atomic rename commits them.
 * Only HMAC identities and hashes of credentials are persisted. */
export class WeChatAccountStore extends PrivateAccountFile {
  constructor({ directory, identityKey, appId, maxAccounts = 50, maxConcurrent = 1,
    requestsPerMinute = 20, sessionTtlMs = 86_400_000, clock = Date.now } = {}) {
    if (typeof directory !== 'string' || !isAbsolute(directory) ||
        typeof identityKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(identityKey) ||
        !/^wx[a-f0-9]{16}$/.test(appId) || !Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 90 ||
        !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8 ||
        !Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 600 ||
        !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 7 * 86_400_000) {
      throw new TypeError('Invalid account store configuration.');
    }
    super(directory, validateRecord);
    Object.assign(this, { identityKey, appId, maxAccounts, maxConcurrent, requestsPerMinute, sessionTtlMs, clock });
  }

  publicAccount(account) {
    return { id: account.id, status: account.status, createdAt: account.createdAt,
      apiKeyConfigured: !!account.keySha256,
      limits: { maxConcurrent: account.maxConcurrent, requestsPerMinute: account.requestsPerMinute } };
  }

  identity(openid) {
    if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(openid)) throw accountError(401, 'wechat_login_rejected');
    return createHmac('sha256', this.identityKey).update(JSON.stringify([this.appId, openid])).digest('hex');
  }

  async login({ openid, inviteCode, privacyAccepted }) {
    const identityHash = this.identity(openid);
    return this.transaction(record => {
      let account = record.accounts.find(item => item.identityHash === identityHash), apiKey;
      const isNew = !account;
      if (account?.status === 'disabled') throw accountError(403, 'account_disabled');
      if (!account) {
        if (privacyAccepted !== true) throw accountError(400, 'privacy_required');
        const index = token(inviteCode, 'bfi_') ? record.invites.findIndex(invite =>
          invite.keySha256 === digest(inviteCode) && invite.expiresAt > this.clock()) : -1;
        if (index < 0) throw accountError(403, 'invite_required');
        if (record.accounts.length >= this.maxAccounts) throw accountError(409, 'registration_full');
        apiKey = mint('bfk_');
        account = { id: 'wx_' + randomBytes(12).toString('hex'), identityHash, status: 'active',
          createdAt: this.clock(), acceptedAt: this.clock(), privacyVersion: ACCOUNT_PRIVACY_VERSION,
          keySha256: digest(apiKey), session: null, maxConcurrent: this.maxConcurrent,
          requestsPerMinute: this.requestsPerMinute };
        record.invites.splice(index, 1); record.accounts.push(account);
      }
      const sessionToken = mint('bfs_'), expiresAt = this.clock() + this.sessionTtlMs;
      account.session = { hash: digest(sessionToken), expiresAt };
      return { account: this.publicAccount(account), sessionToken, expiresAt, isNew,
        ...(apiKey ? { apiKey } : {}) };
    });
  }

  sessionAccount(record, sessionToken) {
    const account = token(sessionToken, 'bfs_') && record.accounts.find(item =>
      item.status === 'active' && item.session?.hash === digest(sessionToken) && item.session.expiresAt > this.clock());
    if (!account) throw accountError(401, 'session_expired');
    return account;
  }

  async me(sessionToken) {
    const account = this.sessionAccount(await this.read(), sessionToken);
    return { account: this.publicAccount(account), expiresAt: account.session.expiresAt };
  }

  async change(sessionToken, operation) {
    return this.transaction(record => {
      const account = this.sessionAccount(record, sessionToken);
      if (operation === 'logout') account.session = null;
      else if (operation === 'revoke-key') account.keySha256 = null;
      else if (operation === 'delete') record.accounts.splice(record.accounts.indexOf(account), 1);
      else if (operation === 'reset-key') {
        const apiKey = mint('bfk_'); account.keySha256 = digest(apiKey);
        return { account: this.publicAccount(account), apiKey };
      } else throw new TypeError('Unknown account operation.');
      return { ok: true, ...(operation === 'revoke-key' ? { account: this.publicAccount(account) } : {}) };
    });
  }

  async clients() {
    return (await this.read()).accounts.filter(account => account.status === 'active' && account.keySha256)
      .map(({ id, keySha256, maxConcurrent, requestsPerMinute }) => ({ id, keySha256, maxConcurrent, requestsPerMinute }));
  }

  async invite({ lifetimeMs = 86_400_000 } = {}) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > 7 * 86_400_000) throw new TypeError('Invalid invitation lifetime.');
    return this.transaction(record => {
      record.invites = record.invites.filter(invite => invite.expiresAt > this.clock());
      if (record.invites.length >= 200) throw accountError(409, 'invite_limit');
      const inviteCode = mint('bfi_'), expiresAt = this.clock() + lifetimeMs;
      record.invites.push({ keySha256: digest(inviteCode), expiresAt });
      return { inviteCode, expiresAt };
    });
  }

  async administer(id, operation) {
    return this.transaction(record => {
      const account = record.accounts.find(item => item.id === id);
      if (!account) throw accountError(404, 'account_missing');
      if (operation === 'disable') { account.status = 'disabled'; account.session = null; account.keySha256 = null; }
      else if (operation === 'enable') account.status = 'active';
      else if (operation === 'revoke-key') account.keySha256 = null;
      else throw new TypeError('Unknown account operation.');
      return this.publicAccount(account);
    });
  }
}

export async function initializeWeChatAccounts(directory) {
  await initializePrivateAccounts(directory, 'identity.key');
}
