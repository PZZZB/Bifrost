import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { types } from 'node:util';

// This is the bridge's encrypted continuation state, never a vendor signature.
export const CODEBUDDY_STATE_PREFIX = 'bridge-codebuddy-v1:';
const AAD = Buffer.from(CODEBUDDY_STATE_PREFIX, 'utf8');
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_SCOPE_LENGTH = 256;
const MAX_JSON_DEPTH = 256;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = IV_BYTES + TAG_BYTES;
const MAX_TOKEN_LENGTH = CODEBUDDY_STATE_PREFIX.length + Math.ceil((MAX_PAYLOAD_BYTES + HEADER_BYTES) * 4 / 3);
const keyLoads = new WeakMap();
const messages = {
  invalid_thinking_state: 'CodeBuddy 思考接续状态无效或已失效。',
  invalid_thinking_state_payload: 'CodeBuddy 思考接续内容无效或超过大小限制。',
  invalid_thinking_state_key: 'CodeBuddy 思考接续密钥无效。',
  thinking_state_key_store_failed: '无法读取或保存 CodeBuddy 思考接续密钥。',
};

export class ThinkingStateError extends Error {
  constructor(code = 'invalid_thinking_state') {
    const safeCode = Object.hasOwn(messages, code) ? code : 'invalid_thinking_state';
    super(messages[safeCode]);
    this.name = 'ThinkingStateError';
    this.code = safeCode;
    this.status = 400;
  }
}

function shape(value, fields) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && fields.includes(key) && descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

function scope(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SCOPE_LENGTH &&
    value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

// Validate before JSON.stringify: it would silently discard unsupported values,
// invoke accessors/toJSON, fill array holes, or coerce non-finite numbers to null.
// A fresh data-only clone also prevents __proto__ from invoking a setter.
function jsonValue(value, depth = 0, ancestors = new WeakSet()) {
  if (depth > MAX_JSON_DEPTH) throw new Error();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_PAYLOAD_BYTES || Buffer.byteLength(value, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error();
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) throw new Error();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) throw new Error();
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (array && keys.length !== value.length + 1) throw new Error();
  const copy = array ? [] : {};
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
          (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) throw new Error();
      Object.defineProperty(copy, key, { value: jsonValue(descriptor.value, depth + 1, ancestors),
        enumerable: true, writable: true, configurable: true });
    }
  } finally { ancestors.delete(value); }
  return copy;
}

function payload(value) {
  if ((!shape(value, ['reasoning', 'identity', 'model']) && !shape(value, ['reasoning', 'identity', 'model', 'extra_fields'])) ||
      typeof value.reasoning !== 'string' ||
      value.reasoning.length > MAX_PAYLOAD_BYTES || Buffer.byteLength(value.reasoning, 'utf8') > MAX_PAYLOAD_BYTES ||
      !scope(value.identity) || !scope(value.model)) throw new Error();
  const result = { reasoning: value.reasoning, identity: value.identity, model: value.model };
  if (Object.hasOwn(value, 'extra_fields') && value.extra_fields != null) result.extra_fields = jsonValue(value.extra_fields);
  return result;
}

export class CodeBuddyThinkingState {
  #key;

  constructor(options = {}) {
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error();
      const { key = randomBytes(32) } = options;
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error();
      this.#key = Buffer.from(key);
    } catch { throw new ThinkingStateError('invalid_thinking_state_key'); }
  }

  seal(value) {
    let plain;
    try {
      // JSON's -0 number is valid and can be retained without a lossy 0 rewrite.
      const json = JSON.stringify(payload(value), (_, item) => Object.is(item, -0) ? JSON.rawJSON('-0') : item);
      if (json.length > MAX_PAYLOAD_BYTES || Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error();
      plain = Buffer.from(json, 'utf8');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      return CODEBUDDY_STATE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    } catch { throw new ThinkingStateError('invalid_thinking_state_payload'); }
    finally { plain?.fill(0); }
  }

  open(block) {
    let plain;
    try {
      if (!shape(block, ['type', 'thinking', 'signature']) || block.type !== 'thinking' || block.thinking !== '' ||
          typeof block.signature !== 'string' || block.signature.length > MAX_TOKEN_LENGTH ||
          !block.signature.startsWith(CODEBUDDY_STATE_PREFIX)) throw new Error();
      const encoded = block.signature.slice(CODEBUDDY_STATE_PREFIX.length);
      if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const packet = Buffer.from(encoded, 'base64url');
      if (packet.length <= HEADER_BYTES || packet.length > MAX_PAYLOAD_BYTES + HEADER_BYTES ||
          packet.toString('base64url') !== encoded) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, packet.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(AAD);
      decipher.setAuthTag(packet.subarray(IV_BYTES, HEADER_BYTES));
      plain = Buffer.concat([decipher.update(packet.subarray(HEADER_BYTES)), decipher.final()]);
      const json = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      return payload(JSON.parse(json));
    } catch { throw new ThinkingStateError(); }
    finally { plain?.fill(0); }
  }
}

async function readOrCreateKey(store) {
  let record;
  try { record = await store.load(); }
  catch { throw new ThinkingStateError('thinking_state_key_store_failed'); }
  if (record == null) {
    const key = randomBytes(32);
    try { await store.save({ version: 1, key: key.toString('base64') }); }
    catch { key.fill(0); throw new ThinkingStateError('thinking_state_key_store_failed'); }
    return key;
  }
  try {
    if (!shape(record, ['version', 'key']) || record.version !== 1 || typeof record.key !== 'string' ||
        !/^[A-Za-z0-9+/]{43}=$/.test(record.key)) throw new Error();
    const key = Buffer.from(record.key, 'base64');
    if (key.length !== 32 || key.toString('base64') !== record.key) throw new Error();
    return key;
  } catch { throw new ThinkingStateError('invalid_thinking_state_key'); }
}

/** Uses a separate bridge-owned store; never accesses native CodeBuddy storage. */
export async function loadThinkingStateKey(store) {
  try {
    if (!store || !['object', 'function'].includes(typeof store) ||
        typeof store.load !== 'function' || typeof store.save !== 'function') throw new Error();
  } catch { throw new ThinkingStateError('thinking_state_key_store_failed'); }
  let pending = keyLoads.get(store);
  if (!pending) {
    pending = readOrCreateKey(store);
    keyLoads.set(store, pending);
    void pending.finally(() => { if (keyLoads.get(store) === pending) keyLoads.delete(store); }).catch(() => {});
  }
  return Buffer.from(await pending);
}
