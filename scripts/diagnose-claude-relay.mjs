import { constants } from 'node:fs';
import { open, opendir, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyClaudeSourceError, classifyClaudeSourceException } from '../src/claude-source-errors.mjs';

const MAX_CONFIG = 65_536, MAX_TAIL = 2 * 1024 * 1024, MAX_FILES = 16;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new Error('Invalid diagnostic input.'); };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

async function limitedEntries(path, maximum) {
  const entries = [], directory = await opendir(path);
  for await (const entry of directory) {
    if (entries.length === maximum) return { entries, truncated: true };
    entries.push(entry);
  }
  return { entries, truncated: false };
}

async function readTail(path, maximum, allowTail = false) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !allowTail && stat.size > maximum) invalid();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || !allowTail && opened.size > maximum || opened.dev !== stat.dev || opened.ino !== stat.ino) invalid();
    const offset = Math.max(0, opened.size - maximum), buffer = Buffer.alloc(Math.min(opened.size, maximum));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
    return { text, truncated: offset > 0 };
  } finally { await file.close(); }
}

/** Read only isolated CLI transcripts. Never invoke a model or output transcript text. */
export async function diagnoseClaudeRelay({ configPath, since, until = new Date().toISOString() } = {}) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) invalid();
  const end = time(until), start = since === undefined ? end - 30 * 60_000 : time(since);
  if (end === null || start === null || start > end || end - start > 24 * 60 * 60_000) invalid();
  const config = JSON.parse((await readTail(configPath, MAX_CONFIG)).text);
  if (!object(config) || config.version !== 1 || typeof config.cli?.configDir !== 'string' || !isAbsolute(config.cli.configDir)) invalid();
  const root = join(config.cli.configDir, 'projects'), rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid();
  const files = [];
  let incomplete = false;
  const directories = await limitedEntries(root, 128); incomplete ||= directories.truncated;
  for (const directory of directories.entries) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const folder = join(root, directory.name), entries = await limitedEntries(folder, 256); incomplete ||= entries.truncated;
    for (const entry of entries.entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i.test(entry.name)) continue;
      const path = join(folder, entry.name), stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs >= start) files.push({ path, modified: stat.mtimeMs });
    }
  }
  files.sort((a, b) => b.modified - a.modified);
  if (files.length > MAX_FILES) incomplete = true;
  const events = [];
  let malformedLines = 0, unclassifiedErrors = 0, scannedFiles = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    const tail = await readTail(file.path, MAX_TAIL, true); incomplete ||= tail.truncated; scannedFiles++;
    for (const line of tail.text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { malformedLines++; continue; }
      if (!object(row)) continue;
      const timestamp = time(row.timestamp);
      if (timestamp === null || timestamp < start || timestamp > end) continue;
      const explicitError = row.type === 'error' || row.type === 'api_error' || row.isApiErrorMessage === true
        || row.type === 'result' && row.is_error === true || row.type === 'assistant' && row.error !== undefined;
      const failure = classifyClaudeSourceError(row)
        ?? (explicitError ? classifyClaudeSourceException(row.error ?? row.apiError) : null);
      if (failure) events.push({ session: `session-${scannedFiles}`, time: new Date(timestamp).toISOString(), code: failure.code, status: failure.status });
      else if (explicitError) unclassifiedErrors++;
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return { version: 1, readOnly: true, realInference: false, status: events.length ? 'errors_found' : 'no_classified_error',
    window: { since: new Date(start).toISOString(), until: new Date(end).toISOString() },
    scannedFiles, incomplete, malformedLines, unclassifiedErrors, events: events.slice(-32) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [configPath, ...args] = process.argv.slice(2), options = { configPath };
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!['--since', '--until'].includes(flag) || !value || Object.hasOwn(options, flag.slice(2))) invalid();
      options[flag.slice(2)] = value;
    }
    process.stdout.write(JSON.stringify(await diagnoseClaudeRelay(options), null, 2) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ version: 1, readOnly: true, realInference: false, status: 'diagnostic_unavailable',
      code: 'claude_diagnostic_unavailable', message: '无法读取诊断。请在 Claude CLI 所在环境使用中继配置路径，并确认有读取权限。' }) + '\n');
    process.exitCode = 1;
  }
}
