import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrivateAccountFile, initializePrivateAccounts } from './private-account-files.mjs';
import { webEmail, checkEmailDomain as defaultEmailDomainCheck } from './email-address.mjs';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sessionToken = value => typeof value === 'string' && /^bws_[A-Za-z0-9_-]{43}$/.test(value);
const invitation = value => typeof value === 'string' && /^bfi_[A-Za-z0-9_-]{43}$/.test(value);
const mint = prefix => prefix + randomBytes(32).toString('base64url');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
export const WEB_PRIVACY_VERSION = '2026-11-01.1';
const PASSWORD_ALGORITHM = 'scrypt-131072-8-1';
const DUMMY = { algorithm: PASSWORD_ALGORITHM, salt: Buffer.alloc(16).toString('base64url'), hash: Buffer.alloc(64).toString('base64url') };
let passwordWork = 0;

export function webUsername(value) {
  if (typeof value === 'string' && value.includes('@')) return webEmail(value);
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(value)) fail(400, 'invalid_username');
  return value.toLowerCase();
}

function validIdentity(account) {
  if (typeof account.username !== 'string') return false;
  if (!account.username.includes('@')) return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(account.username) &&
    account.emailVerified === undefined && account.emailDomainCheck === undefined;
  try { return webEmail(account.username) === account.username && account.emailVerified === false &&
    ['mx', 'address'].includes(account.emailDomainCheck?.method) && Number.isSafeInteger(account.emailDomainCheck.checkedAt); }
  catch { return false; }
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || Buffer.byteLength(value) > 256) fail(400, 'invalid_password');
}

async function passwordDigest(password, salt) {
  if (passwordWork >= 2) fail(429, 'rate_limited');
  passwordWork++;
  try { return await derive(password, Buffer.from(salt, 'base64url'), 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }); }
  finally { passwordWork--; }
}

async function makePassword(password) {
  validPassword(password);
  const salt = randomBytes(16).toString('base64url');
  return { algorithm: PASSWORD_ALGORITHM, salt, hash: (await passwordDigest(password, salt)).toString('base64url') };
}

async function matchesPassword(password, record = DUMMY) {
  validPassword(password);
  return timingSafeEqual(await passwordDigest(password, record.salt), Buffer.from(record.hash, 'base64url'));
}

function validate(record) {
  if (record?.version !== 1 || !Array.isArray(record.accounts) || record.accounts.length > 90 ||
      !Array.isArray(record.invites) || record.invites.length > 200) throw new Error('Invalid web account store.');
  const ids = new Set(), names = new Set(), keys = new Set(), sessions = new Set(), invites = new Set();
  for (const account of record.accounts) {
    if (!/^web_[a-f0-9]{24}$/.test(account.id) || ids.has(account.id) ||
        !validIdentity(account) || names.has(account.username) ||
        !['active', 'disabled'].includes(account.status) || !Number.isSafeInteger(account.createdAt) ||
        !Number.isSafeInteger(account.acceptedAt) || account.privacyVersion !== WEB_PRIVACY_VERSION ||
        account.passwordHash?.algorithm !== PASSWORD_ALGORITHM || !/^[A-Za-z0-9_-]{22}$/.test(account.passwordHash.salt) ||
        !/^[A-Za-z0-9_-]{86}$/.test(account.passwordHash.hash) ||
        !Number.isInteger(account.maxConcurrent) || account.maxConcurrent < 1 || account.maxConcurrent > 8 ||
        !Number.isInteger(account.requestsPerMinute) || account.requestsPerMinute < 1 || account.requestsPerMinute > 600 ||
        account.keySha256 !== null && (!hex(account.keySha256) || keys.has(account.keySha256)) ||
        account.session !== null && (!hex(account.session?.hash) || sessions.has(account.session.hash) ||
          !Number.isSafeInteger(account.session.expiresAt))) throw new Error('Invalid web account store.');
    ids.add(account.id); names.add(account.username);
    if (account.keySha256) keys.add(account.keySha256);
    if (account.session) sessions.add(account.session.hash);
  }
  for (const invite of record.invites) {
    if (!hex(invite.keySha256) || invites.has(invite.keySha256) || !Number.isSafeInteger(invite.expiresAt)) throw new Error('Invalid web account store.');
    invites.add(invite.keySha256);
  }
  return record;
}

export class WebAccountStore extends PrivateAccountFile {
  async read() {
    const migrated = await lstat(join(this.directory, 'migrated-to.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (migrated) throw new Error('This account store was migrated. Use the main local account administrator.');
    return super.read();
  }
  constructor({ directory, maxAccounts = 50, maxConcurrent = 1, requestsPerMinute = 20,
    sessionTtlMs = 86_400_000, clock = Date.now, checkEmailDomain = defaultEmailDomainCheck } = {}) {
    super(directory, validate);
    if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 90 ||
        !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8 ||
        !Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 600 ||
        !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 7 * 86_400_000 ||
        typeof checkEmailDomain !== 'function') throw new TypeError('Invalid web account settings.');
    Object.assign(this, { maxAccounts, maxConcurrent, requestsPerMinute, sessionTtlMs, clock, checkEmailDomain });
  }

  publicAccount(account) {
    return { id: account.id, username: account.username, email: account.username.includes('@') ? account.username : null,
      emailVerified: false, ...(account.emailDomainCheck ? { emailDomainCheck: account.emailDomainCheck } : {}),
      status: account.status, createdAt: account.createdAt,
      apiKeyConfigured: !!account.keySha256,
      limits: { maxConcurrent: account.maxConcurrent, requestsPerMinute: account.requestsPerMinute } };
  }

  newSession(account) {
    const token = mint('bws_'), expiresAt = this.clock() + this.sessionTtlMs;
    account.session = { hash: digest(token), expiresAt };
    return { account: this.publicAccount(account), sessionToken: token, expiresAt };
  }

  async register({ email, password, inviteCode, privacyAccepted }) {
    const username = webEmail(email); validPassword(password);
    if (privacyAccepted !== true) fail(400, 'privacy_required');
    const available = record => invitation(inviteCode) ? record.invites.findIndex(invite =>
      invite.keySha256 === digest(inviteCode) && invite.expiresAt > this.clock()) : -1;
    const snapshot = await this.read();
    if (available(snapshot) < 0 || snapshot.accounts.some(account => account.username === username)) fail(403, 'registration_rejected');
    if (snapshot.accounts.length >= this.maxAccounts) fail(409, 'registration_full');
    const method = await this.checkEmailDomain(username);
    if (!['mx', 'address'].includes(method)) throw new Error('Invalid email DNS result.');
    const emailDomainCheck = { method, checkedAt: this.clock() };
    const passwordHash = await makePassword(password);
    return this.transaction(record => {
      const index = available(record);
      if (index < 0 || record.accounts.some(account => account.username === username)) fail(403, 'registration_rejected');
      if (record.accounts.length >= this.maxAccounts) fail(409, 'registration_full');
      const apiKey = mint('bfk_');
      const account = { id: 'web_' + randomBytes(12).toString('hex'), username, emailVerified: false, emailDomainCheck, passwordHash, status: 'active',
        createdAt: this.clock(), acceptedAt: this.clock(), privacyVersion: WEB_PRIVACY_VERSION,
        keySha256: digest(apiKey), session: null, maxConcurrent: this.maxConcurrent, requestsPerMinute: this.requestsPerMinute };
      record.invites.splice(index, 1); record.accounts.push(account);
      return { ...this.newSession(account), apiKey };
    });
  }

  async login({ username, password }) {
    username = webUsername(username); validPassword(password);
    const previous = (await this.read()).accounts.find(account => account.username === username);
    const matched = await matchesPassword(password, previous?.passwordHash);
    if (!matched || !previous || previous.status !== 'active') fail(401, 'login_rejected');
    return this.transaction(record => {
      const account = record.accounts.find(item => item.id === previous.id);
      if (!account || account.status !== 'active' || account.passwordHash.hash !== previous.passwordHash.hash) fail(401, 'login_rejected');
      return this.newSession(account);
    });
  }

  sessionAccount(record, token) {
    const account = sessionToken(token) && record.accounts.find(item => item.status === 'active' &&
      item.session?.hash === digest(token) && item.session.expiresAt > this.clock());
    if (!account) fail(401, 'session_expired');
    return account;
  }

  async me(token) {
    const account = this.sessionAccount(await this.read(), token);
    return { account: this.publicAccount(account), expiresAt: account.session.expiresAt };
  }

  async change(token, operation) {
    return this.transaction(record => {
      const account = this.sessionAccount(record, token);
      if (operation === 'logout') account.session = null;
      else if (operation === 'revoke-key') account.keySha256 = null;
      else if (operation === 'delete') record.accounts.splice(record.accounts.indexOf(account), 1);
      else if (operation === 'reset-key') {
        const apiKey = mint('bfk_'); account.keySha256 = digest(apiKey);
        return { account: this.publicAccount(account), apiKey };
      } else throw new TypeError('Unknown web account operation.');
      return { ok: true, ...(operation === 'revoke-key' ? { account: this.publicAccount(account) } : {}) };
    });
  }

  async clients() {
    return (await this.read()).accounts.filter(account => account.status === 'active' && account.keySha256)
      .map(({ id, keySha256, maxConcurrent, requestsPerMinute }) => ({ id, keySha256, maxConcurrent, requestsPerMinute }));
  }

  async invite() {
    return this.transaction(record => {
      record.invites = record.invites.filter(invite => invite.expiresAt > this.clock());
      if (record.invites.length >= 200) fail(409, 'invite_limit');
      const inviteCode = mint('bfi_'), expiresAt = this.clock() + 86_400_000;
      record.invites.push({ keySha256: digest(inviteCode), expiresAt }); return { inviteCode, expiresAt };
    });
  }

  async administer(username, operation) {
    username = webUsername(username);
    const password = operation === 'reset-password' ? mint('Bifrost-') : undefined;
    const passwordHash = password ? await makePassword(password) : undefined;
    return this.transaction(record => {
      const account = record.accounts.find(item => item.username === username);
      if (!account) fail(404, 'account_missing');
      if (operation === 'enable') account.status = 'active';
      else if (['disable', 'revoke-key', 'reset-password'].includes(operation)) {
        account.keySha256 = null;
        if (operation !== 'revoke-key') account.session = null;
        if (operation === 'disable') account.status = 'disabled';
        if (passwordHash) account.passwordHash = passwordHash;
      } else throw new TypeError('Unknown administrator operation.');
      return { account: this.publicAccount(account), ...(password ? { password } : {}) };
    });
  }
}

export async function initializeWebAccounts(directory) { await initializePrivateAccounts(directory, 'csrf.key'); }
