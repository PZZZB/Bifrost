import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const manifestFiles = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const unknownSnapshot = () => ({ revision: null, fingerprint: null, dirty: null });

async function gitMetadata(projectDir) {
  try {
    const options = { cwd: projectDir, windowsHide: true, timeout: 2_000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
    const results = await Promise.allSettled([
      exec('git', ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD'], options),
      exec('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], options),
    ]);
    if (results.some(result => result.status !== 'fulfilled')) return { revision: null, dirty: null };
    const [head, working] = results.map(result => result.value);
    const revision = head.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) return { revision: null, dirty: null };
    return { revision: revision.toLowerCase(), dirty: working.stdout.length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

async function codeManifest(projectDir) {
  const files = [];
  async function visit(relative, required = true) {
    let info;
    try { info = await lstat(join(projectDir, relative)); }
    catch (error) { if (!required && error.code === 'ENOENT') return; throw error; }
    // Do not follow code links into private state or a different checkout.
    if (info.isSymbolicLink()) throw new Error('Linked runtime files cannot be fingerprinted.');
    if (info.isDirectory()) {
      const entries = await readdir(join(projectDir, relative));
      for (const name of entries.sort()) await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      files.push({ relative, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino });
      if (files.length > 4096) throw new Error('Runtime manifest is too large.');
    } else throw new Error('Unsupported runtime file.');
  }
  await visit('src');
  for (const name of manifestFiles) await visit(name, false);
  files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
  if (!files.some(file => file.relative.startsWith('src/')) || files.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) {
    throw new Error('Runtime manifest is unavailable.');
  }
  return files;
}

/** Capture startup source identity once; disk snapshots never replace it. */
export async function createServiceVersion({ projectDir, now = Date.now, startedAt = new Date(now()).toISOString(),
  readGitMetadata = gitMetadata } = {}) {
  const directory = resolve(projectDir);
  const started = new Date(startedAt).toISOString();
  async function snapshot() {
    // A concurrent checkout must not produce a mixture of old and new files.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await codeManifest(directory);
      const hash = createHash('sha256');
      for (const file of before) {
        const content = await readFile(join(directory, file.relative));
        hash.update(`${Buffer.byteLength(file.relative)}:${file.relative}:${content.length}:`);
        hash.update(content);
      }
      let metadata;
      try { metadata = await readGitMetadata(directory); } catch { metadata = null; }
      const after = await codeManifest(directory);
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      return {
        revision: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(metadata?.revision ?? '') ? metadata.revision.toLowerCase() : null,
        fingerprint: hash.digest('hex'),
        dirty: typeof metadata?.dirty === 'boolean' ? metadata.dirty : null,
      };
    }
    throw new Error('Runtime files changed while fingerprinting.');
  }
  let captured;
  try { captured = await snapshot(); } catch { captured = unknownSnapshot(); }
  const running = Object.freeze({ ...captured, startedAt: started });
  let reading = null;
  return {
    async status() {
      // Dashboard callers share one disk read rather than racing separate scans.
      if (!reading) reading = snapshot().catch(() => unknownSnapshot()).finally(() => { reading = null; });
      const installed = await reading;
      const updatePending = running.fingerprint && installed.fingerprint ? running.fingerprint !== installed.fingerprint : null;
      return { running: { ...running }, installed: { ...installed }, updatePending,
        state: updatePending === null ? 'unknown' : updatePending ? 'update_pending' : 'current' };
    },
  };
}
