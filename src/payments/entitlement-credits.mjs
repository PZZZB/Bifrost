import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readPrivateAccountFile, writePrivateAccountRecord } from '../private-account-files.mjs';
import { paymentError } from './topups.mjs';
import { WatchaInsufficientQuota } from './watcha.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const integer = value => Number.isSafeInteger(value) && value > 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exact = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name));
const pending = row => ['prepared', 'consumed', 'review'].includes(row.status);
const MAX_BYTES = 32 * 1024 * 1024, MAX_ROWS = 20_000;
const unavailable = () => paymentError('payments_unavailable', 503);

function sourceBinding(value) {
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 4 && parts[0] === 'watcha'
      && typeof parts[1] === 'string' && /^app_[a-z0-9]{1,100}$/.test(parts[1])
      && ['sandbox', 'live'].includes(parts[2]) && typeof parts[3] === 'string' && /^ent_[a-z0-9]{1,100}$/.test(parts[3]);
  } catch { return false; }
}

function validate(data, binding) {
  if (!exact(data, ['version', 'binding', 'deliveries']) || data.version !== 1 || data.binding !== binding
    || !Array.isArray(data.deliveries) || data.deliveries.length > MAX_ROWS) throw unavailable();
  const ids = new Set(), unfinished = new Set();
  for (const row of data.deliveries) {
    if (!exact(row, ['id', 'accountId', 'points', 'unitMicros', 'creditMicros', 'createdAt', 'status', 'receipt', 'creditedAt'])
      || !UUID.test(row.id) || !UUID.test(row.accountId) || ids.has(row.id) || !integer(row.points) || !integer(row.unitMicros)
      || !integer(row.creditMicros) || BigInt(row.points) * BigInt(row.unitMicros) !== BigInt(row.creditMicros)
      || !iso(row.createdAt) || !['prepared', 'consumed', 'credited', 'review', 'cancelled'].includes(row.status)
      || row.creditedAt !== null && !iso(row.creditedAt) || (row.status === 'credited') !== (row.creditedAt !== null)) throw unavailable();
    ids.add(row.id);
    if (row.receipt !== null) {
      if (!exact(row.receipt, ['consumed', 'remaining']) || row.receipt.consumed !== row.points
        || !Number.isSafeInteger(row.receipt.remaining) || row.receipt.remaining < 0
        || !['consumed', 'credited', 'review'].includes(row.status)) throw unavailable();
    } else if (['consumed', 'credited'].includes(row.status)) throw unavailable();
    if (pending(row)) {
      if (unfinished.has(row.accountId)) throw unavailable();
      unfinished.add(row.accountId);
    }
  }
  return data;
}

/** An entitlement-delivery outbox, NOT a payment/order ledger or another wallet.
 * Own it in the SAME process as ClientBilling, with a single owner of this file.
 * Authenticated server code supplies the stable account UUID. No public routes,
 * automatic polling, or production enablement are installed by this module. */
export class EntitlementCredits {
  #data;
  #queue = Promise.resolve();
  #closed = false;
  #binding;
  #cursor = 0;
  constructor({ path, access, billing, source, microsPerPoint, clock = Date.now } = {}) {
    if (!path || typeof access?.publicAccount !== 'function' || typeof billing?.account !== 'function'
      || typeof billing?.adjustBalance !== 'function' || typeof source?.access !== 'function'
      || typeof source?.consume !== 'function' || typeof source.binding !== 'string' || !sourceBinding(source.binding)
      || !integer(microsPerPoint) || typeof clock !== 'function') throw new TypeError('Invalid entitlement delivery configuration.');
    this.path = resolve(path); this.access = access; this.billing = billing; this.source = source;
    this.microsPerPoint = microsPerPoint; this.clock = clock; this.#binding = source.binding;
    this.#data = { version: 1, binding: this.#binding, deliveries: [] };
  }
  static async open(options) {
    const service = new EntitlementCredits(options);
    try { service.#data = validate(JSON.parse(await readPrivateAccountFile(service.path, MAX_BYTES)), service.#binding); }
    catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
    return service;
  }
  #run(operation) {
    if (this.#closed) return Promise.reject(unavailable());
    const result = this.#queue.then(operation); this.#queue = result.catch(() => {}); return result;
  }
  async #save(next) {
    validate(next, this.#binding);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw paymentError('payment_limit', 503);
    try { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await writePrivateAccountRecord(this.path, next); }
    catch { throw paymentError('payment_write_failed', 503); }
    this.#data = next;
  }
  #account(id, starting = false) {
    if (typeof id !== 'string' || !UUID.test(id)) throw paymentError('payment_invalid', 400);
    let account;
    try { account = this.access.publicAccount(id); } catch {}
    if (!account || starting && !account.enabled) throw paymentError('payment_not_found', 404);
    if (starting && !this.billing.account(id).enforceBalance) throw paymentError('payment_billing_required', 409);
  }
  #checkBinding() { if (this.source.binding !== this.#binding) throw unavailable(); }
  hasPending(accountId) { return this.#data.deliveries.some(row => row.accountId === accountId && pending(row)); }
  status() {
    return Object.fromEntries(['prepared', 'consumed', 'credited', 'review', 'cancelled']
      .map(status => [status, this.#data.deliveries.filter(row => row.status === status).length]));
  }
  async #finish(id) {
    this.#checkBinding();
    let row = this.#data.deliveries.find(value => value.id === id);
    try { this.#account(row.accountId); }
    catch {
      if (row.status !== 'review') {
        const next = structuredClone(this.#data); next.deliveries.find(value => value.id === id).status = 'review'; await this.#save(next);
      }
      return { deliveredPoints: 0, creditMicros: 0, pending: true };
    }
    if (!row.receipt) {
      let receipt;
      try { receipt = await this.source.consume(row.accountId, { points: row.points, operationId: row.id }); }
      catch (error) {
        if (!(error instanceof WatchaInsufficientQuota)) throw error;
        const next = structuredClone(this.#data); next.deliveries.find(value => value.id === id).status = 'cancelled';
        await this.#save(next); return { deliveredPoints: 0, creditMicros: 0, pending: false };
      }
      const next = structuredClone(this.#data), target = next.deliveries.find(value => value.id === id);
      // Persist a minimal authenticated consumption receipt BEFORE local credit.
      // Its remaining balance is a historical snapshot, never a new grant.
      target.receipt = { consumed: receipt?.consumed, remaining: receipt?.remaining }; target.status = 'consumed';
      await this.#save(next); row = this.#data.deliveries.find(value => value.id === id);
    }
    // Identity can disappear while the remote request is in flight. Keep the
    // receipt for the original UUID; never recreate or substitute an identity.
    try { this.#account(row.accountId); }
    catch {
      const next = structuredClone(this.#data); next.deliveries.find(value => value.id === id).status = 'review';
      await this.#save(next); return { deliveredPoints: 0, creditMicros: 0, pending: true };
    }
    await this.billing.adjustBalance(row.accountId, { operationId: row.id, amountMicros: row.creditMicros,
      note: 'entitlement:watcha:' + row.id });
    const next = structuredClone(this.#data), target = next.deliveries.find(value => value.id === id);
    target.status = 'credited'; target.creditedAt = new Date(this.clock()).toISOString(); await this.#save(next);
    return { deliveredPoints: row.points, creditMicros: row.creditMicros, pending: false };
  }
  async sync(accountId) {
    return this.#run(async () => {
      this.#checkBinding();
      if (typeof accountId !== 'string' || !UUID.test(accountId)) throw paymentError('payment_invalid', 400);
      const previous = this.#data.deliveries.find(row => row.accountId === accountId && pending(row));
      if (previous) return this.#finish(previous.id);
      this.#account(accountId, true);
      const state = await this.source.access(accountId);
      if (!state || !['granted', 'purchase_required', 'unavailable'].includes(state.access)
        || !Number.isSafeInteger(state.remaining) || state.remaining < 0
        || state.access === 'unavailable' && state.remaining !== 0) throw unavailable();
      if (state.remaining === 0) return { deliveredPoints: 0, creditMicros: 0, pending: false };
      const credit = BigInt(state.remaining) * BigInt(this.microsPerPoint);
      if (credit > BigInt(Number.MAX_SAFE_INTEGER)) throw paymentError('payment_limit', 503);
      if (this.#data.deliveries.length >= MAX_ROWS) throw paymentError('payment_limit', 503);
      const row = { id: randomUUID(), accountId, points: state.remaining, unitMicros: this.microsPerPoint,
        creditMicros: Number(credit), createdAt: new Date(this.clock()).toISOString(), status: 'prepared', receipt: null, creditedAt: null };
      const next = structuredClone(this.#data); next.deliveries.push(row);
      await this.#save(next); // Stable operation ID exists before the remote debit.
      return this.#finish(row.id);
    });
  }
  async recover() {
    return this.#run(async () => {
      this.#checkBinding();
      const rows = this.#data.deliveries.filter(pending), count = Math.min(20, rows.length);
      for (let offset = 0; offset < count; offset++) {
        const row = rows[(this.#cursor + offset) % rows.length];
        try { await this.#finish(row.id); } catch { /* Keep the SAME durable operation for retry. */ }
      }
      this.#cursor = rows.length ? (this.#cursor + count) % rows.length : 0;
      return this.status();
    });
  }
  async close() { this.#closed = true; await this.#queue; }
}
