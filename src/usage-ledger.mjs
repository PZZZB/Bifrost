import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, stat, truncate } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const FORMAT_VERSION = 1;
const ACCOUNTS = ['A', 'B', 'With', 'CodeBuddy', 'Claude'];
const RECENT_LIMIT = 100;
const MAX_LINE_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const TOKEN_FIELDS = [
  'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteTokens', 'reasoningTokens',
];

function ledgerError(code, message, line) {
  const error = new Error(message);
  error.code = code;
  if (line !== undefined) error.line = line;
  return error;
}

function text(value, field, { optional = false, max = 512 } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', `Invalid usage ledger field: ${field}.`);
  }
  return value.trim();
}

function token(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(usage, canonical = false) {
  if (usage === null || usage === undefined) return null;
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    if (canonical) throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Invalid normalized usage data.');
    return null;
  }
  let normalized;
  if (canonical) {
    normalized = Object.fromEntries(TOKEN_FIELDS.map(field => {
      if (usage[field] !== null && usage[field] !== undefined && token(usage[field]) === null) {
        throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Invalid normalized token count.');
      }
      return [field, token(usage[field])];
    }));
  } else {
    normalized = {
      inputTokens: token(usage.input_tokens),
      outputTokens: token(usage.output_tokens),
      totalTokens: token(usage.total_tokens),
      cachedInputTokens: token(usage.input_tokens_details?.cached_tokens),
      cacheWriteTokens: token(usage.input_tokens_details?.cache_write_tokens),
      reasoningTokens: token(usage.output_tokens_details?.reasoning_tokens),
    };
    if (normalized.totalTokens === null && normalized.inputTokens !== null && normalized.outputTokens !== null) {
      // Cached input is already included in input; reasoning is already included in output.
      normalized.totalTokens = token(normalized.inputTokens + normalized.outputTokens);
    }
  }
  return TOKEN_FIELDS.some(field => normalized[field] !== null) ? normalized : null;
}

function normalizeRecord(record, canonical = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'A usage ledger record must be an object.');
  }
  if (canonical && record.version !== FORMAT_VERSION) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Unsupported usage ledger record version.');
  }
  if (!ACCOUNTS.includes(record.account)) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Unsupported usage account.');
  }
  const time = record.time === undefined && !canonical ? new Date() : new Date(record.time);
  if (!Number.isFinite(time.getTime()) || record.time === null) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Invalid usage ledger timestamp.');
  }
  const httpStatus = record.httpStatus ?? null;
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw ledgerError('USAGE_LEDGER_INVALID_RECORD', 'Invalid usage ledger HTTP status.');
  }
  // Only this whitelist is retained. Raw usage attribution, request bodies, and credentials are never persisted.
  return {
    version: FORMAT_VERSION,
    requestId: text(record.requestId, 'requestId'),
    time: time.toISOString(),
    account: record.account,
    model: text(record.model, 'model', { max: 256 }),
    upstreamModel: text(record.upstreamModel, 'upstreamModel', { optional: true, max: 256 }),
    threadId: text(record.threadId, 'threadId', { optional: true }),
    responseId: text(record.responseId, 'responseId', { optional: true }),
    status: text(record.status, 'status', { max: 64 }),
    httpStatus,
    usage: normalizeUsage(record.usage, canonical),
  };
}

function emptyTotals() {
  return {
    requests: 0,
    withUsage: 0,
    missingUsage: 0,
    ...Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0])),
    usageFieldsMissing: Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0])),
  };
}

function addUsage(totals, entry) {
  totals.requests += 1;
  totals[entry.usage ? 'withUsage' : 'missingUsage'] += 1;
  for (const field of TOKEN_FIELDS) {
    const value = entry.usage?.[field];
    if (value === null || value === undefined) totals.usageFieldsMissing[field] += 1;
    else totals[field] += value;
  }
}

/** An append-only metadata ledger. The JSONL file is the only persistent source of truth. */
export class UsageLedger {
  #path;
  #timeZone;
  #startedAt = null;
  #totals = emptyTotals();
  #accounts = Object.fromEntries(ACCOUNTS.map(account => [account, emptyTotals()]));
  #models = new Map();
  #recent = [];
  #seen = new Set();
  #queue = Promise.resolve();
  #writeError = null;
  #recovery = { truncatedBytes: 0, appendedNewline: false, duplicateRecords: 0 };

  constructor({ path, timeZone = 'America/Los_Angeles' }) {
    if (typeof path !== 'string' || !path.trim()) throw new TypeError('Usage ledger path is required.');
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
    catch { throw new TypeError('Usage ledger timeZone is invalid.'); }
    this.#path = resolve(path);
    this.#timeZone = timeZone;
  }

  static async open(options) {
    const ledger = new UsageLedger(options);
    await mkdir(dirname(ledger.#path), { recursive: true, mode: 0o700 });
    const file = await open(ledger.#path, 'a', 0o600);
    await file.close();
    await chmod(ledger.#path, 0o600);
    await ledger.#replay();
    return ledger;
  }

  async record(record) {
    const entry = normalizeRecord(record);
    const operation = this.#queue.then(async () => {
      if (this.#writeError) throw this.#writeError;
      if (this.#seen.has(entry.requestId)) return { recorded: false, duplicate: true };
      try {
        await this.#append(`${JSON.stringify(entry)}\n`);
      } catch {
        this.#writeError = ledgerError('USAGE_LEDGER_WRITE_FAILED', 'Usage ledger append failed. Further writes are stopped until the ledger is reopened.');
        throw this.#writeError;
      }
      this.#accept(entry);
      return { recorded: true, duplicate: false };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  snapshot() {
    return structuredClone({
      timeZone: this.#timeZone,
      startedAt: this.#startedAt,
      totals: this.#totals,
      accounts: this.#accounts,
      models: [...this.#models.values()].sort((left, right) => left.account.localeCompare(right.account)
        || left.model.localeCompare(right.model) || (left.upstreamModel || '').localeCompare(right.upstreamModel || '')),
      recent: this.#recent,
      recovery: this.#recovery,
    });
  }

  async flush() {
    await this.#queue;
    if (this.#writeError) throw this.#writeError;
  }

  async #append(line) {
    const file = await open(this.#path, 'a', 0o600);
    try {
      await file.appendFile(line, 'utf8');
      // Make each accepted record durable before exposing it in the in-memory counters.
      await file.sync();
    } finally {
      await file.close();
    }
  }

  #accept(entry) {
    if (this.#seen.has(entry.requestId)) return false;
    this.#seen.add(entry.requestId);
    this.#startedAt ??= entry.time;
    addUsage(this.#totals, entry);
    addUsage(this.#accounts[entry.account], entry);
    const key = JSON.stringify([entry.account, entry.model, entry.upstreamModel]);
    if (!this.#models.has(key)) {
      this.#models.set(key, { account: entry.account, model: entry.model, upstreamModel: entry.upstreamModel, ...emptyTotals() });
    }
    addUsage(this.#models.get(key), entry);
    this.#recent.unshift(entry);
    if (this.#recent.length > RECENT_LIMIT) this.#recent.pop();
    return true;
  }

  #readLine(bytes, line) {
    let parsed;
    try { parsed = JSON.parse(UTF8.decode(bytes)); }
    catch { throw ledgerError('USAGE_LEDGER_CORRUPT', `Invalid JSON in usage ledger line ${line}.`, line); }
    try { return normalizeRecord(parsed, true); }
    catch { throw ledgerError('USAGE_LEDGER_CORRUPT', `Invalid record in usage ledger line ${line}.`, line); }
  }

  async #replay() {
    const size = (await stat(this.#path)).size;
    if (size === 0) return;
    let parts = [], length = 0, oversized = false, offset = 0, lineStart = 0, line = 1;
    const accumulate = bytes => {
      length += bytes.length;
      if (length > MAX_LINE_BYTES) { oversized = true; parts = []; }
      else if (!oversized) parts.push(bytes);
    };
    const consume = () => {
      if (oversized) throw ledgerError('USAGE_LEDGER_CORRUPT', `Usage ledger line ${line} exceeds the record size limit.`, line);
      const bytes = Buffer.concat(parts, length);
      if (bytes.toString('utf8').trim()) {
        if (!this.#accept(this.#readLine(bytes, line))) this.#recovery.duplicateRecords += 1;
      }
      parts = []; length = 0; oversized = false;
    };
    // Keep only one bounded line in memory; aggregates and deduplication span the whole file.
    for await (const chunk of createReadStream(this.#path, { end: size - 1 })) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline === -1 ? chunk.length : newline;
        accumulate(chunk.subarray(cursor, end));
        offset += end - cursor;
        if (newline !== -1) {
          offset += 1;
          consume();
          lineStart = offset;
          line += 1;
        }
        cursor = end + (newline === -1 ? 0 : 1);
      }
    }
    if (length === 0) return;
    const bytes = oversized ? null : Buffer.concat(parts, length);
    if (!bytes || !bytes.toString('utf8').trim()) {
      await truncate(this.#path, lineStart);
      this.#recovery.truncatedBytes = size - lineStart;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(UTF8.decode(bytes)); }
    catch {
      // A crash may leave only the final JSON prefix. Do not hide complete malformed lines.
      await truncate(this.#path, lineStart);
      this.#recovery.truncatedBytes = size - lineStart;
      return;
    }
    let entry;
    try { entry = normalizeRecord(parsed, true); }
    catch { throw ledgerError('USAGE_LEDGER_CORRUPT', `Invalid record in usage ledger line ${line}.`, line); }
    if (!this.#accept(entry)) this.#recovery.duplicateRecords += 1;
    await this.#append('\n');
    this.#recovery.appendedNewline = true;
  }
}
