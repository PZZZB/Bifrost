import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BridgeError } from './storage.mjs';

const derive = promisify(scrypt);
const DAY = 86_400_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ACCOUNTS = 2048;
const MAX_KEYS = 256;
const MAX_ACTIVE_KEYS = 10;
const MAX_SESSIONS = 16;
const MAX_INVITES = 1024;
const SESSION_LIFETIME = DAY;
const HASH_PARAMETERS = Object.freeze({ version: 1, algorithm: 'scrypt', N: 32768, r: 8, p: 1, keyLength: 64 });
const TOKEN_PATTERNS = Object.freeze({ key: /^bfk_[A-Za-z0-9_-]{43}$/, session: /^bfs_[A-Za-z0-9_-]{43}$/, invite: /^bfi_[A-Za-z0-9_-]{43}$/ });
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed, required = []) => object(value) && Reflect.ownKeys(value).every(key => typeof key === 'string'
  && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
  && required.every(key => Object.hasOwn(value, key));
const error = (message = '用户接入参数无效。', status = 400, code = 'invalid_client_access') => new BridgeError(message, status, code);
const digest = (kind, value) => createHash('sha256').update(`bifrost-client-${kind}-v1\0${value}`).digest('hex');
const secret = kind => ({ key: 'bfk_', session: 'bfs_', invite: 'bfi_' }[kind]) + randomBytes(32).toString('base64url');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..')
  && (['B-gpt-6-astra', 'B-gpt-6.1-sol', 'claude-codebuddy-opus-5-5'].includes(value)
    || /^(?:CodeBuddy-|Cursor-)[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]*$/.test(value))
  && !value.replace(/^(?:CodeBuddy-|Cursor-)/, '').split(/[/:]/).some(part => /^(?:sk-|rt_|oat_|eyJ|Bearer)/i.test(part));

function username(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(value)) throw error('用户名须为 3–64 位英文字母、数字、点、下划线或连字符。');
  return value.toLowerCase();
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || value.includes('\0') || Buffer.byteLength(value) > 1024) {
    throw error('密码须为 12–256 个字符。');
  }
  return value;
}
function label(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw error('Key 名称须为 1–80 个可显示字符。');
  return value;
}
function days(value, fallback = 30) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < 1 || result > 3650) throw error('有效期须为 1–3650 天。');
  return result;
}
function storedModels(value) {
  return Array.isArray(value) && value.length <= 512 && value.every(modelId) && new Set(value).size === value.length;
}
function validPasswordHash(value) {
  return fields(value, [...Object.keys(HASH_PARAMETERS), 'salt', 'hash'], [...Object.keys(HASH_PARAMETERS), 'salt', 'hash'])
    && Object.entries(HASH_PARAMETERS).every(([key, expected]) => value[key] === expected)
    && typeof value.salt === 'string' && /^[0-9a-f]{32}$/.test(value.salt)
    && typeof value.hash === 'string' && /^[0-9a-f]{128}$/.test(value.hash);
}
async function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(value, Buffer.from(salt, 'hex'), HASH_PARAMETERS.keyLength,
    { N: HASH_PARAMETERS.N, r: HASH_PARAMETERS.r, p: HASH_PARAMETERS.p, maxmem: 64 * 1024 * 1024 });
  return { ...HASH_PARAMETERS, salt, hash: hash.toString('hex') };
}
async function passwordMatches(value, stored) {
  const salt = stored?.salt ?? '00000000000000000000000000000000';
  const computed = await derive(value, Buffer.from(salt, 'hex'), HASH_PARAMETERS.keyLength,
    { N: HASH_PARAMETERS.N, r: HASH_PARAMETERS.r, p: HASH_PARAMETERS.p, maxmem: 64 * 1024 * 1024 });
  return stored !== undefined && timingSafeEqual(computed, Buffer.from(stored.hash, 'hex'));
}

function validateState(data) {
  if (!fields(data, ['version', 'revision', 'registrationPolicy', 'accounts', 'invites', 'sessions'],
    ['version', 'revision', 'registrationPolicy', 'accounts', 'invites', 'sessions'])
    || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0
    || !fields(data.registrationPolicy, ['mode', 'defaultKeyDays'], ['mode', 'defaultKeyDays'])
    || !['invite', 'open', 'closed'].includes(data.registrationPolicy.mode)
    || !Number.isInteger(data.registrationPolicy.defaultKeyDays) || data.registrationPolicy.defaultKeyDays < 1 || data.registrationPolicy.defaultKeyDays > 3650
    || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS
    || !Array.isArray(data.invites) || data.invites.length > MAX_INVITES
    || !Array.isArray(data.sessions) || data.sessions.length > MAX_ACCOUNTS * MAX_SESSIONS) throw error();
  const accountIds = new Set(), usernames = new Set(), keyIds = new Set(), keyHashes = new Set();
  for (const account of data.accounts) {
    if (!fields(account, ['id', 'username', 'password', 'enabled', 'allowedModels', 'createdAt', 'updatedAt', 'keyExpiresAtLimit', 'keys'],
      ['id', 'username', 'password', 'enabled', 'allowedModels', 'createdAt', 'updatedAt', 'keyExpiresAtLimit', 'keys'])
      || !UUID.test(account.id) || accountIds.has(account.id) || username(account.username) !== account.username || usernames.has(account.username)
      || !validPasswordHash(account.password) || typeof account.enabled !== 'boolean' || !storedModels(account.allowedModels)
      || !iso(account.createdAt) || !iso(account.updatedAt) || account.keyExpiresAtLimit !== null && !iso(account.keyExpiresAtLimit)
      || !Array.isArray(account.keys) || account.keys.length > MAX_KEYS) throw error();
    accountIds.add(account.id); usernames.add(account.username);
    for (const key of account.keys) {
      if (!fields(key, ['id', 'name', 'hash', 'lastFour', 'enabled', 'createdAt', 'expiresAt', 'revokedAt'],
        ['id', 'name', 'hash', 'lastFour', 'enabled', 'createdAt', 'expiresAt', 'revokedAt'])
        || !UUID.test(key.id) || keyIds.has(key.id) || label(key.name) !== key.name || !HEX64.test(key.hash) || keyHashes.has(key.hash)
        || typeof key.lastFour !== 'string' || !/^[A-Za-z0-9_-]{4}$/.test(key.lastFour) || typeof key.enabled !== 'boolean'
        || !iso(key.createdAt) || !iso(key.expiresAt) || key.revokedAt !== null && !iso(key.revokedAt)) throw error();
      keyIds.add(key.id); keyHashes.add(key.hash);
    }
  }
  const inviteIds = new Set(), inviteHashes = new Set();
  for (const invite of data.invites) {
    if (!fields(invite, ['id', 'hash', 'lastFour', 'createdAt', 'expiresAt', 'revokedAt', 'maxUses', 'uses', 'allowedModels'],
      ['id', 'hash', 'lastFour', 'createdAt', 'expiresAt', 'revokedAt', 'maxUses', 'uses', 'allowedModels'])
      || !UUID.test(invite.id) || inviteIds.has(invite.id) || !HEX64.test(invite.hash) || inviteHashes.has(invite.hash)
      || typeof invite.lastFour !== 'string' || !/^[A-Za-z0-9_-]{4}$/.test(invite.lastFour)
      || !iso(invite.createdAt) || !iso(invite.expiresAt) || invite.revokedAt !== null && !iso(invite.revokedAt)
      || !Number.isInteger(invite.maxUses) || invite.maxUses < 1 || invite.maxUses > 10000
      || !Number.isInteger(invite.uses) || invite.uses < 0 || invite.uses > invite.maxUses || !storedModels(invite.allowedModels)) throw error();
    inviteIds.add(invite.id); inviteHashes.add(invite.hash);
  }
  const sessionHashes = new Set(), sessionCounts = new Map();
  for (const session of data.sessions) {
    if (!fields(session, ['hash', 'accountId', 'createdAt', 'expiresAt'], ['hash', 'accountId', 'createdAt', 'expiresAt'])
      || !HEX64.test(session.hash) || sessionHashes.has(session.hash) || !accountIds.has(session.accountId)
      || !iso(session.createdAt) || !iso(session.expiresAt)) throw error();
    sessionHashes.add(session.hash);
    sessionCounts.set(session.accountId, (sessionCounts.get(session.accountId) ?? 0) + 1);
    if (sessionCounts.get(session.accountId) > MAX_SESSIONS) throw error();
  }
}

/** Password accounts and scoped client credentials. No upstream credentials are stored here. */
export class ClientAccess {
  #path;
  #now;
  #allowedModelIds;
  #state = { version: 1, revision: 0, registrationPolicy: { mode: 'open', defaultKeyDays: 30 }, accounts: [], invites: [], sessions: [] };
  #queue = Promise.resolve();
  #closed = false;
  #closing = false;

  constructor({ path, now = Date.now, allowedModelIds = [] } = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0') || typeof now !== 'function'
      || !(typeof allowedModelIds === 'function' || Array.isArray(allowedModelIds))) throw new TypeError('Invalid ClientAccess options.');
    this.#path = resolve(path); this.#now = now; this.#allowedModelIds = allowedModelIds;
  }
  static async open(options) {
    const store = new ClientAccess(options);
    await store.#load();
    return store;
  }
  #time() {
    const value = Number(this.#now());
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) throw error('用户接入时钟不可用。', 503, 'client_access_unavailable');
    return value;
  }
  async #load() {
    let handle;
    try {
      const info = await lstat(this.#path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw error();
      handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (!(await handle.stat()).isFile()) throw error();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw error();
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
      validateState(data); this.#state = data;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw error('用户接入配置损坏或无法读取。', 503, 'client_access_unavailable');
    } finally { await handle?.close(); }
  }
  #serialize(operation) {
    if (this.#closed || this.#closing) return Promise.reject(error('用户接入服务已关闭。', 503, 'client_access_unavailable'));
    const result = this.#queue.then(() => {
      if (this.#closed) throw error('用户接入服务已关闭。', 503, 'client_access_unavailable');
      return operation();
    });
    this.#queue = result.catch(() => {}); return result;
  }
  async #commit(next) {
    if (this.#state.revision >= Number.MAX_SAFE_INTEGER) throw error('用户接入配置版本已耗尽。', 503, 'client_access_unavailable');
    next.revision = this.#state.revision + 1;
    const bytes = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw error('用户接入配置达到保存上限。', 503, 'client_access_limit');
    const temporary = `${this.#path}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      try { if (!(await lstat(this.#path)).isFile()) throw error(); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.#path);
    } catch {
      throw error('用户接入配置保存失败，原有配置继续生效。', 503, 'client_access_write_failed');
    } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
    this.#state = next;
  }
  #models(values) {
    if (!storedModels(values)) throw error('授权模型列表无效；须选择明确的 B、CodeBuddy 或 Cursor 模型。');
    if (values.length === 0) return [];
    let available;
    try { available = typeof this.#allowedModelIds === 'function' ? this.#allowedModelIds() : this.#allowedModelIds; }
    catch { throw error('当前模型目录不可用，请刷新目录后重试。', 503, 'client_model_catalog_unavailable'); }
    if (!Array.isArray(available)) throw error('当前模型目录不可用，请刷新目录后重试。', 503, 'client_model_catalog_unavailable');
    const known = new Set(available.filter(modelId));
    if (values.some(value => !known.has(value))) throw error('授权列表包含当前目录中不存在的模型。', 400, 'client_model_not_available');
    return [...values];
  }
  #account(state, id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw error('用户不存在。', 404, 'client_account_not_found');
    const account = state.accounts.find(item => item.id === id);
    if (!account) throw error('用户不存在。', 404, 'client_account_not_found');
    return account;
  }
  #key(account, id) {
    const key = typeof id === 'string' && account.keys.find(item => item.id === id);
    if (!key) throw error('API Key 不存在。', 404, 'client_key_not_found');
    return key;
  }
  #publicKey(key, now = this.#time(), limit = null) {
    const effectiveExpiresAt = limit !== null && Date.parse(limit) < Date.parse(key.expiresAt) ? limit : key.expiresAt;
    return { id: key.id, name: key.name, lastFour: key.lastFour, enabled: key.enabled, createdAt: key.createdAt,
      expiresAt: key.expiresAt, effectiveExpiresAt, revokedAt: key.revokedAt,
      status: key.revokedAt ? 'revoked' : !key.enabled ? 'disabled' : Date.parse(effectiveExpiresAt) <= now ? 'expired' : 'active' };
  }
  #publicAccount(account) {
    const now = this.#time();
    return { id: account.id, username: account.username, enabled: account.enabled, allowedModels: [...account.allowedModels],
      createdAt: account.createdAt, updatedAt: account.updatedAt, keyExpiresAtLimit: account.keyExpiresAtLimit,
      keys: account.keys.map(key => this.#publicKey(key, now, account.keyExpiresAtLimit)) };
  }
  #publicInvite(invite) {
    return { id: invite.id, lastFour: invite.lastFour, createdAt: invite.createdAt, expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt, maxUses: invite.maxUses, uses: invite.uses, allowedModels: [...invite.allowedModels],
      status: invite.revokedAt ? 'revoked' : Date.parse(invite.expiresAt) <= this.#time() ? 'expired' : invite.uses >= invite.maxUses ? 'used' : 'active' };
  }
  #newKey(account, { name = 'Default', expiresInDays } = {}) {
    if (account.keys.length >= MAX_KEYS) throw error('此用户的 API Key 记录已达到保存上限。', 409, 'client_key_limit');
    const nameValue = label(name), lifetime = days(expiresInDays, this.#state.registrationPolicy.defaultKeyDays);
    const value = secret('key'), now = this.#time();
    if (account.keyExpiresAtLimit !== null && Date.parse(account.keyExpiresAtLimit) <= now) {
      throw error('此用户的 Key 授权期已结束，请联系管理员续期。', 403, 'client_key_term_expired');
    }
    if (account.keys.filter(key => this.#publicKey(key, now, account.keyExpiresAtLimit).status === 'active').length >= MAX_ACTIVE_KEYS) {
      throw error('此用户最多同时启用 10 个有效 API Key。', 409, 'client_active_key_limit');
    }
    const expiresAt = Math.min(now + lifetime * DAY, account.keyExpiresAtLimit === null ? Infinity : Date.parse(account.keyExpiresAtLimit));
    const key = { id: randomUUID(), name: nameValue, hash: digest('key', value), lastFour: value.slice(-4), enabled: true,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), revokedAt: null };
    account.keys.push(key); return { key, secret: value };
  }
  snapshot() {
    return { version: 1, revision: this.#state.revision, registrationPolicy: { ...this.#state.registrationPolicy },
      accounts: this.#state.accounts.map(account => this.#publicAccount(account)), invites: this.#state.invites.map(invite => this.#publicInvite(invite)) };
  }
  publicAccount(id) { return this.#publicAccount(this.#account(this.#state, id)); }
  registrationPolicy() { return { ...this.#state.registrationPolicy }; }

  async configureRegistration(options) {
    if (!fields(options, ['mode', 'defaultKeyDays']) || Object.keys(options).length === 0
      || options.mode !== undefined && !['invite', 'open', 'closed'].includes(options.mode)) throw error('注册策略无效。');
    if (options.defaultKeyDays !== undefined) days(options.defaultKeyDays);
    return this.#serialize(async () => {
      const next = structuredClone(this.#state);
      if (options.mode !== undefined) next.registrationPolicy.mode = options.mode;
      if (options.defaultKeyDays !== undefined) next.registrationPolicy.defaultKeyDays = options.defaultKeyDays;
      await this.#commit(next); return { ...next.registrationPolicy };
    });
  }
  async createInvite(options = {}) {
    if (!fields(options, ['expiresInDays', 'maxUses', 'allowedModels'])) throw error();
    const lifetime = days(options.expiresInDays, 7), maxUses = options.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) throw error('邀请使用次数须为 1–10000。');
    const models = this.#models(options.allowedModels ?? []);
    return this.#serialize(async () => {
      if (this.#state.invites.length >= MAX_INVITES) throw error('邀请已达到保存上限。', 409, 'client_invite_limit');
      const next = structuredClone(this.#state), now = this.#time(), token = secret('invite');
      const invite = { id: randomUUID(), hash: digest('invite', token), lastFour: token.slice(-4), createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + lifetime * DAY).toISOString(), revokedAt: null, maxUses, uses: 0, allowedModels: models };
      next.invites.push(invite); await this.#commit(next); return { invite: this.#publicInvite(invite), token };
    });
  }
  async revokeInvite(id) {
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), invite = typeof id === 'string' && next.invites.find(item => item.id === id);
      if (!invite) throw error('邀请不存在。', 404, 'client_invite_not_found');
      invite.revokedAt ??= new Date(this.#time()).toISOString(); await this.#commit(next); return this.#publicInvite(invite);
    });
  }
  async createAccount(options) {
    if (!fields(options, ['username', 'password', 'allowedModels', 'enabled', 'keyExpiresAtLimit'], ['username', 'password'])
      || options.keyExpiresAtLimit !== undefined && options.keyExpiresAtLimit !== null && !iso(options.keyExpiresAtLimit)) throw error();
    const name = username(options.username), credential = await passwordHash(password(options.password));
    const models = this.#models(options.allowedModels ?? []), enabled = options.enabled ?? true;
    if (typeof enabled !== 'boolean') throw error();
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), now = new Date(this.#time()).toISOString();
      if (next.accounts.length >= MAX_ACCOUNTS) throw error('用户数量达到保存上限。', 409, 'client_account_limit');
      if (next.accounts.some(account => account.username === name)) throw error('此用户名已注册。', 409, 'client_username_exists');
      const account = { id: randomUUID(), username: name, password: credential, allowedModels: models, enabled, createdAt: now, updatedAt: now,
        keyExpiresAtLimit: options.keyExpiresAtLimit === undefined ? new Date(Date.parse(now) + next.registrationPolicy.defaultKeyDays * DAY).toISOString() : options.keyExpiresAtLimit, keys: [] };
      next.accounts.push(account); await this.#commit(next); return this.#publicAccount(account);
    });
  }
  async register(options) {
    if (!fields(options, ['username', 'password', 'inviteToken'], ['username', 'password'])) throw error();
    const name = username(options.username), credential = await passwordHash(password(options.password));
    if (options.inviteToken !== undefined && (typeof options.inviteToken !== 'string' || !TOKEN_PATTERNS.invite.test(options.inviteToken))) {
      throw error('邀请无效或已到期。', 403, 'client_invite_invalid');
    }
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), now = this.#time();
      if (next.registrationPolicy.mode === 'closed') throw error('当前未开放注册。', 403, 'client_registration_closed');
      let invite;
      if (options.inviteToken !== undefined) invite = next.invites.find(item => item.hash === digest('invite', options.inviteToken));
      if ((next.registrationPolicy.mode === 'invite' || options.inviteToken !== undefined)
        && (!invite || invite.revokedAt || invite.uses >= invite.maxUses || Date.parse(invite.expiresAt) <= now)) {
        throw error('邀请无效或已到期。', 403, 'client_invite_invalid');
      }
      if (next.accounts.length >= MAX_ACCOUNTS) throw error('用户数量达到保存上限。', 409, 'client_account_limit');
      if (next.accounts.some(account => account.username === name)) throw error('此用户名已注册。', 409, 'client_username_exists');
      const account = { id: randomUUID(), username: name, password: credential, allowedModels: this.#models(invite?.allowedModels ?? []),
        enabled: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        keyExpiresAtLimit: new Date(now + next.registrationPolicy.defaultKeyDays * DAY).toISOString(), keys: [] };
      const created = this.#newKey(account);
      const sessionToken = secret('session'), expiresAt = new Date(now + SESSION_LIFETIME).toISOString();
      next.accounts.push(account); if (invite) invite.uses++;
      next.sessions = next.sessions.filter(session => Date.parse(session.expiresAt) > now);
      next.sessions.push({ hash: digest('session', sessionToken), accountId: account.id, createdAt: new Date(now).toISOString(), expiresAt });
      await this.#commit(next); return { account: this.#publicAccount(account), key: this.#publicKey(created.key, now, account.keyExpiresAtLimit),
        secret: created.secret, sessionToken, expiresAt };
    });
  }
  async updateAccount(id, options) {
    if (!fields(options, ['enabled', 'allowedModels', 'password', 'keyExpiresAtLimit']) || Object.keys(options).length === 0
      || options.enabled !== undefined && typeof options.enabled !== 'boolean'
      || options.keyExpiresAtLimit !== undefined && options.keyExpiresAtLimit !== null && !iso(options.keyExpiresAtLimit)) throw error();
    const models = options.allowedModels === undefined ? undefined : this.#models(options.allowedModels);
    const credential = options.password === undefined ? undefined : await passwordHash(password(options.password));
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), account = this.#account(next, id);
      if (options.enabled !== undefined) account.enabled = options.enabled;
      if (models !== undefined) account.allowedModels = models;
      if (credential !== undefined) account.password = credential;
      if (options.keyExpiresAtLimit !== undefined) account.keyExpiresAtLimit = options.keyExpiresAtLimit;
      if (!account.enabled || credential !== undefined) next.sessions = next.sessions.filter(session => session.accountId !== id);
      account.updatedAt = new Date(this.#time()).toISOString(); await this.#commit(next); return this.#publicAccount(account);
    });
  }
  async login(options) {
    if (!fields(options, ['username', 'password'], ['username', 'password'])) throw error();
    let name, value;
    try { name = username(options.username); value = password(options.password); }
    catch { throw error('用户名或密码无效。', 401, 'client_login_failed'); }
    const candidate = this.#state.accounts.find(account => account.username === name);
    const matched = await passwordMatches(value, candidate?.password);
    return this.#serialize(async () => {
      const account = this.#state.accounts.find(item => item.username === name);
      if (!matched || !account || !account.enabled || account.password.hash !== candidate.password.hash) throw error('用户名或密码无效。', 401, 'client_login_failed');
      const next = structuredClone(this.#state), now = this.#time(), token = secret('session');
      next.sessions = next.sessions.filter(session => Date.parse(session.expiresAt) > now);
      const existing = next.sessions.filter(session => session.accountId === account.id);
      if (existing.length >= MAX_SESSIONS) {
        const removed = new Set(existing.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, existing.length - MAX_SESSIONS + 1).map(session => session.hash));
        next.sessions = next.sessions.filter(session => !removed.has(session.hash));
      }
      const expiresAt = new Date(now + SESSION_LIFETIME).toISOString();
      next.sessions.push({ hash: digest('session', token), accountId: account.id, createdAt: new Date(now).toISOString(), expiresAt });
      await this.#commit(next); return { account: this.#publicAccount(account), sessionToken: token, expiresAt };
    });
  }
  authenticateSession(token) {
    if (this.#closed || typeof token !== 'string' || !TOKEN_PATTERNS.session.test(token)) return null;
    const now = this.#time(), hash = digest('session', token);
    const session = this.#state.sessions.find(item => item.hash === hash && Date.parse(item.expiresAt) > now);
    const account = session && this.#state.accounts.find(item => item.id === session.accountId && item.enabled);
    return account ? { accountId: account.id, username: account.username, allowedModels: [...account.allowedModels] } : null;
  }
  async logout(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERNS.session.test(token)) return false;
    return this.#serialize(async () => {
      const hash = digest('session', token), next = structuredClone(this.#state);
      next.sessions = next.sessions.filter(session => session.hash !== hash);
      if (next.sessions.length === this.#state.sessions.length) return false;
      await this.#commit(next); return true;
    });
  }
  async createKey(accountId, options = {}) {
    if (!fields(options, ['name', 'expiresInDays'])) throw error();
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), account = this.#account(next, accountId), created = this.#newKey(account, options);
      account.updatedAt = new Date(this.#time()).toISOString(); await this.#commit(next);
      return { key: this.#publicKey(created.key, this.#time(), account.keyExpiresAtLimit), secret: created.secret };
    });
  }
  async updateKey(accountId, keyId, options) {
    if (!fields(options, ['name', 'enabled', 'expiresAt', 'expiresInDays']) || Object.keys(options).length === 0
      || options.enabled !== undefined && typeof options.enabled !== 'boolean'
      || options.expiresAt !== undefined && !iso(options.expiresAt)
      || options.expiresAt !== undefined && options.expiresInDays !== undefined) throw error();
    if (options.name !== undefined) label(options.name);
    if (options.expiresInDays !== undefined) days(options.expiresInDays);
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), account = this.#account(next, accountId), key = this.#key(account, keyId), now = this.#time();
      if (key.revokedAt) throw error('API Key 已撤销，请创建新 Key。', 409, 'client_key_revoked');
      const expiresAt = options.expiresInDays !== undefined ? new Date(now + options.expiresInDays * DAY).toISOString() : options.expiresAt;
      if (expiresAt !== undefined && (Date.parse(expiresAt) <= now || Date.parse(expiresAt) > now + 3650 * DAY)) throw error('新的截止时间须在未来，且不超过 3650 天。');
      if (expiresAt !== undefined && account.keyExpiresAtLimit !== null && Date.parse(expiresAt) > Date.parse(account.keyExpiresAtLimit)) {
        throw error('Key 有效期不能超过此用户的授权截止时间。', 403, 'client_key_term_exceeded');
      }
      const nextEnabled = options.enabled ?? key.enabled;
      const nextExpiry = expiresAt ?? key.expiresAt;
      const becomesActive = nextEnabled && Date.parse(nextExpiry) > now
        && (account.keyExpiresAtLimit === null || Date.parse(account.keyExpiresAtLimit) > now);
      if (becomesActive && this.#publicKey(key, now, account.keyExpiresAtLimit).status !== 'active'
        && account.keys.filter(item => this.#publicKey(item, now, account.keyExpiresAtLimit).status === 'active').length >= MAX_ACTIVE_KEYS) {
        throw error('此用户最多同时启用 10 个有效 API Key。', 409, 'client_active_key_limit');
      }
      if (options.name !== undefined) key.name = options.name;
      if (options.enabled !== undefined) key.enabled = options.enabled;
      if (expiresAt !== undefined) key.expiresAt = expiresAt;
      account.updatedAt = new Date(now).toISOString(); await this.#commit(next); return this.#publicKey(key, now, account.keyExpiresAtLimit);
    });
  }
  async revokeKey(accountId, keyId) {
    return this.#serialize(async () => {
      const next = structuredClone(this.#state), account = this.#account(next, accountId), key = this.#key(account, keyId);
      key.revokedAt ??= new Date(this.#time()).toISOString(); account.updatedAt = key.revokedAt;
      await this.#commit(next); return this.#publicKey(key, this.#time(), account.keyExpiresAtLimit);
    });
  }
  authenticateKey(value) {
    if (this.#closed || typeof value !== 'string' || !TOKEN_PATTERNS.key.test(value)) return null;
    const hash = digest('key', value), now = this.#time();
    for (const account of this.#state.accounts) {
      if (!account.enabled || account.keyExpiresAtLimit !== null && Date.parse(account.keyExpiresAtLimit) <= now) continue;
      const key = account.keys.find(item => item.hash === hash && item.enabled && !item.revokedAt && Date.parse(item.expiresAt) > now);
      if (key) return { accountId: account.id, keyId: key.id, username: account.username, allowedModels: [...account.allowedModels] };
    }
    return null;
  }
  async flush() { await this.#queue; }
  async close() { this.#closing = true; await this.#queue; this.#closed = true; }
}
