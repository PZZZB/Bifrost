import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, open as openFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { BridgeError } from './storage.mjs';

const MAX_ENTRIES = 8192;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 64;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).length === names.length
  && Object.keys(value).every(key => names.includes(key));
const invalid = () => new BridgeError('聊天分叉关系参数无效。', 400, 'fork_lineage_invalid');
const conflict = () => new BridgeError('聊天分叉关系与已有记录冲突。', 409, 'fork_lineage_conflict');
const unavailable = () => new BridgeError('已保存的聊天分叉关系不可读取。', 503, 'fork_lineage_unavailable');
const writeFailure = () => new BridgeError('聊天分叉关系未能保存。', 503, 'fork_lineage_write_failed');

function thread(value, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

function ownerName(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
      || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}

function assertAcyclic(rows) {
  const done = new Set();
  for (const key of rows.keys()) {
    const seen = new Set();
    let current = key;
    while (rows.has(current) && !done.has(current)) {
      if (seen.has(current)) throw conflict();
      seen.add(current);
      const row = rows.get(current);
      current = `${row.ownerHash}/${row.parent}`;
    }
    for (const visited of seen) done.add(visited);
  }
}

async function readIndex(path) {
  const file = await openFile(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid fork index.');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new Error('Oversized fork index.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}

async function saveIndex(path, rows) {
  const directory = dirname(path), temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const data = JSON.stringify({ version: 1, entries: [...rows.values()] }) + '\n';
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw writeFailure();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    const file = await openFile(temporary, 'wx', 0o600); created = true;
    try { await file.writeFile(data); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { if (created) await unlink(temporary).catch(() => {}); }
}

/** Ancestor IDs are only decryption hints; they never authorize access to state. */
export class ForkLineage {
  #path;
  #secret;
  #maxEntries;
  #rows = new Map();
  #queue = Promise.resolve();
  #available = false;
  #error = null;

  constructor({ path, secret, maxEntries = MAX_ENTRIES } = {}) {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)
        || parse(path).root.startsWith('\\\\') || path.slice(parse(path).root.length).includes(':')
        || typeof secret !== 'string' || secret.length < 40
        || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
      throw new TypeError('Invalid fork lineage configuration.');
    }
    this.#path = resolve(path); this.#secret = secret; this.#maxEntries = maxEntries;
  }

  static async open(options) {
    const index = new ForkLineage(options);
    await index.#load();
    return index;
  }

  async #load() {
    try {
      const data = await readIndex(this.#path);
      if (!fields(data, ['version', 'entries']) || data.version !== 1 || !Array.isArray(data.entries)
          || data.entries.length > MAX_ENTRIES) throw new Error('Invalid fork index.');
      const rows = new Map();
      for (const row of data.entries) {
        if (!fields(row, ['ownerHash', 'child', 'parent']) || typeof row.ownerHash !== 'string' || !HASH.test(row.ownerHash)
            || thread(row.child) !== row.child
            || thread(row.parent) !== row.parent || row.child === row.parent) throw new Error('Invalid fork entry.');
        const key = `${row.ownerHash}/${row.child}`;
        if (rows.has(key)) throw new Error('Duplicate fork entry.');
        rows.set(key, { ...row });
      }
      assertAcyclic(rows);
      while (rows.size > this.#maxEntries) rows.delete(rows.keys().next().value);
      this.#rows = rows; this.#available = true;
    } catch (error) {
      if (error.code === 'ENOENT') this.#available = true;
      else this.#error = { code: 'fork_lineage_unavailable', message: '已保存的聊天分叉关系不可读取。' };
    }
  }

  #owner(value) {
    return createHmac('sha256', this.#secret).update('bifrost-fork-lineage-v1\0' + ownerName(value)).digest('hex');
  }

  status() { return { available: this.#available, entries: this.#rows.size, error: this.#error && { ...this.#error } }; }

  candidates({ owner, session, parentSession = null, familySession = null } = {}) {
    const ownerHash = this.#owner(owner);
    const pending = [thread(session), thread(parentSession, true), thread(familySession, true)], found = new Set();
    for (let at = 0; at < pending.length && found.size < MAX_CANDIDATES; at++) {
      const candidate = pending[at];
      if (candidate === null || found.has(candidate)) continue;
      found.add(candidate);
      const row = this.#rows.get(`${ownerHash}/${candidate}`);
      if (row) pending.push(row.parent);
    }
    return [...found];
  }

  async remember({ owner, session, parentSession } = {}) {
    // Copy and validate before joining the write queue; callers may reuse input objects.
    const ownerHash = this.#owner(owner), child = thread(session), parent = thread(parentSession);
    const operation = async () => {
      if (!this.#available) throw unavailable();
      if (child === parent) throw conflict();
      const key = `${ownerHash}/${child}`, previous = this.#rows.get(key);
      if (previous) {
        if (previous.parent !== parent) throw conflict();
        return false;
      }
      const rows = new Map(this.#rows);
      rows.set(key, { ownerHash, child, parent });
      assertAcyclic(rows);
      while (rows.size > this.#maxEntries) rows.delete(rows.keys().next().value);
      try { await saveIndex(this.#path, rows); }
      catch {
        this.#error = { code: 'fork_lineage_write_failed', message: '聊天分叉关系未能保存。' };
        throw writeFailure();
      }
      this.#rows = rows; this.#error = null;
      return true;
    };
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }
}
