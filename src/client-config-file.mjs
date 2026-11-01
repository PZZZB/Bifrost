import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, readFile, rm, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { writePrivateAccountRecord, readPrivateAccountFile } from './private-account-files.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(id);
function managedMap(value) {
  if (!object(value) || Object.keys(value).length > 512 || Object.entries(value).some(([id, digest]) => !validId(id) || !/^[a-f0-9]{64}$/.test(digest))) throw new Error('client_sync_state_invalid');
  return value;
}
async function readTarget(path, allowPartial = false) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return { text: '', value: { models: [] } }; throw error; }
  if (!stat.isFile() || stat.size > 1024 * 1024 || process.platform !== 'win32' && stat.uid !== process.getuid()) throw new Error('client_sync_target_invalid');
  const bytes = await readFile(path), text = bytes.toString('utf8'); let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { if (allowPartial) return { text, bytes, value: null }; throw error; }
  if (!object(value) || !Array.isArray(value.models) || value.models.length > 1024
    || value.models.some(item => !object(item)) || value.availableModels !== undefined && (!Array.isArray(value.availableModels)
      || value.availableModels.some(id => typeof id !== 'string'))) throw new Error('client_sync_target_invalid');
  return { text, value };
}

/** Keep the inode: CodeBuddy's watcher can stop following rename replacements.
 * A private recovery copy is committed before this function is called. */
async function writeWatchedFile(path, text, expected) {
  let file;
  try { file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code !== 'ENOENT' || expected !== '') throw error;
    file = await open(path, 'wx+', 0o600);
  }
  try {
    const current = await file.readFile('utf8');
    if (current !== expected) throw new Error('client_sync_target_changed');
    const bytes = Buffer.from(text); let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('client_sync_write_failed'); offset += bytesWritten;
    }
    await file.truncate(bytes.length);
    if (process.platform !== 'win32') await file.chmod(0o600);
    await file.sync();
  } finally { await file.close(); }
}

function partialWrite(before, after, actual) {
  const old = Buffer.from(before), next = Buffer.from(after), value = Buffer.from(actual);
  if (value.length <= next.length && next.subarray(0, value.length).equals(value)) return true;
  if (value.length !== old.length) return false;
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(value.length, next.length) && value[prefix] === next[prefix]) prefix++;
  while (suffix < value.length && value[value.length - suffix - 1] === old[old.length - suffix - 1]) suffix++;
  return prefix + suffix >= value.length;
}

/** One file owner per profile, with crash recovery and no overwrite of edited entries. */
export async function reconcileClientFile({ targetFile, stateFile, models, write = writePrivateAccountRecord, writeTarget = writeWatchedFile }) {
  if (![targetFile, stateFile].every(isAbsolute) || !Array.isArray(models) || models.length > 512
    || models.some(item => !validId(item?.id)) || new Set(models.map(item => item.id)).size !== models.length) throw new Error('client_sync_config_invalid');
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = stateFile + '.lock', nonce = randomUUID();
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readPrivateAccountFile(lock + '/owner.json', 1024)); } catch { throw new Error('client_sync_busy'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('client_sync_busy');
    try { process.kill(owner.pid, 0); throw new Error('client_sync_busy'); }
    catch (check) { if (check.code !== 'ESRCH') throw new Error('client_sync_busy'); }
    await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  }
  try { await writePrivateAccountRecord(lock + '/owner.json', { pid: process.pid, nonce }); }
  catch (error) { await rm(lock, { recursive: true }); throw error; }
  try {
    let state;
    try { state = JSON.parse(await readPrivateAccountFile(stateFile, 262144)); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('client_sync_state_invalid'); state = { version: 1, managed: {}, pending: null }; }
    if (state.version !== 1) throw new Error('client_sync_state_invalid');
    let current = await readTarget(targetFile, state.pending?.watchedFile === true);
    const recoveryFile = stateFile + '.recovery.json';
    if (state.pending?.watchedFile && !current.value) {
      const recovery = JSON.parse(await readPrivateAccountFile(recoveryFile, 6 * 1024 * 1024));
      if (recovery.targetFile !== targetFile || typeof recovery.before !== 'string' || typeof recovery.after !== 'string'
        || hash(recovery.before) !== state.pending.beforeHash || hash(recovery.after) !== state.pending.afterHash
        || !partialWrite(recovery.before, recovery.after, current.bytes)) throw new Error('client_sync_recovery_conflict');
      await writeTarget(targetFile, recovery.after, current.text);
      current = await readTarget(targetFile);
    }
    const managed = { ...managedMap(state.managed) };
    if (state.pending) {
      const pending = state.pending;
      if (!/^[a-f0-9]{64}$/.test(pending.beforeHash) || !/^[a-f0-9]{64}$/.test(pending.afterHash)) throw new Error('client_sync_state_invalid');
      const proposed = managedMap(pending.managed);
      if (hash(current.text) === pending.afterHash) Object.assign(managed, proposed);
      else if (hash(current.text) !== pending.beforeHash) for (const item of current.value.models) {
        if (Object.hasOwn(proposed, item.id) && proposed[item.id] === hash(item)) managed[item.id] = proposed[item.id];
      }
    }
    const desired = new Map(models.map(item => [item.id, item])), remaining = [], nextManaged = {}, conflicts = new Set();
    const counts = new Map(); for (const item of current.value.models) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    for (const item of current.value.models) {
      const owned = Object.hasOwn(managed, item.id);
      if (owned && counts.get(item.id) === 1 && managed[item.id] === hash(item)) continue;
      remaining.push(item);
      if (desired.has(item.id) || owned) conflicts.add(item.id);
      if (owned) nextManaged[item.id] = managed[item.id];
    }
    // A user's deliberate edit or deletion is retained instead of being undone
    // every timer tick. Disabling/reconfiguring sync is an explicit reset.
    for (const id of Object.keys(managed)) if (!counts.has(id) && desired.has(id)) { conflicts.add(id); nextManaged[id] = managed[id]; }
    const added = [];
    for (const item of models) {
      if (conflicts.has(item.id)) continue;
      remaining.push(item); nextManaged[item.id] = hash(item); added.push(item.id);
    }
    const value = { ...current.value, models: remaining };
    if (Array.isArray(value.availableModels) && value.availableModels.length) {
      value.availableModels = [...new Set([...value.availableModels, ...added])];
    }
    const changed = JSON.stringify(value) !== JSON.stringify(current.value);
    if (changed) {
      await mkdir(dirname(targetFile), { recursive: true, mode: 0o700 });
      if ((await lstat(dirname(targetFile))).isSymbolicLink()) throw new Error('client_sync_target_invalid');
      const afterText = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(afterText) > 1024 * 1024) throw new Error('client_sync_target_invalid');
      // This short-lived recovery file contains the client's own configuration
      // and keys. It stays private, never enters status/logs and is removed after commit.
      await write(recoveryFile, { targetFile, before: current.text, after: afterText });
      await write(stateFile, { version: 1, managed, pending: { watchedFile: true, beforeHash: hash(current.text), afterHash: hash(afterText), managed: nextManaged } });
      if ((await readTarget(targetFile)).text !== current.text) throw new Error('client_sync_target_changed');
      await writeTarget(targetFile, afterText, current.text);
      if ((await readTarget(targetFile)).text !== afterText) throw new Error('client_sync_target_changed');
    }
    if (changed || state.pending || JSON.stringify(state.managed) !== JSON.stringify(nextManaged)) await write(stateFile, { version: 1, managed: nextManaged, pending: null });
    await rm(recoveryFile, { force: true });
    return { changed, managedCount: added.length, conflictCount: conflicts.size };
  } finally {
    try { const owner = JSON.parse(await readPrivateAccountFile(lock + '/owner.json', 1024)); if (owner.nonce === nonce) await rm(lock, { recursive: true }); } catch {}
  }
}
