import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServiceVersion } from '../src/service-version.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-service-version-'));
  t.after(async () => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('bifrost-service-version-'));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'main.mjs'), 'export const value = 1;\n');
  await writeFile(join(directory, 'package.json'), '{"name":"version-fixture","version":"1"}\n');
  return directory;
}
const clean = () => ({ revision: '1'.repeat(40), dirty: false });

test('running revision, dirty flag, fingerprint and start time stay captured after disk code changes', async t => {
  const directory = await fixture(t);
  let metadata = clean(), time = 1800000000000;
  const version = await createServiceVersion({ projectDir: directory, now: () => time, readGitMetadata: async () => metadata });
  const initial = await version.status();
  assert.equal(initial.state, 'current'); assert.equal(initial.updatePending, false);
  assert.match(initial.running.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(initial.running.startedAt, new Date(time).toISOString());
  time += 60_000; metadata = { revision: '2'.repeat(40), dirty: true };
  await writeFile(join(directory, 'src', 'main.mjs'), 'export const value = 2;\n');
  const changed = await version.status();
  assert.deepEqual(changed.running, initial.running);
  assert.equal(changed.installed.revision, metadata.revision); assert.equal(changed.installed.dirty, true);
  assert.notEqual(changed.installed.fingerprint, changed.running.fingerprint);
  assert.equal(changed.state, 'update_pending'); assert.equal(changed.updatePending, true);
  changed.running.fingerprint = 'mutated'; changed.installed.fingerprint = 'mutated';
  const next = await version.status();
  assert.deepEqual(next.running, initial.running); assert.notEqual(next.installed.fingerprint, 'mutated');
});

test('a different Git HEAD or static page alone does not imply running code needs a restart', async t => {
  const directory = await fixture(t);
  let metadata = clean();
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => metadata });
  const initial = await version.status();
  await mkdir(join(directory, 'public'));
  await writeFile(join(directory, 'public', 'index.html'), '<h1>Updated immediately</h1>');
  await writeFile(join(directory, 'README.md'), 'Documentation update.');
  metadata = { revision: '2'.repeat(40), dirty: true };
  const staticChange = await version.status();
  assert.equal(staticChange.updatePending, false); assert.equal(staticChange.state, 'current');
  assert.equal(staticChange.running.revision, initial.running.revision); assert.equal(staticChange.installed.revision, metadata.revision);
  assert.equal(staticChange.installed.dirty, true); assert.equal(staticChange.installed.fingerprint, initial.installed.fingerprint);
  await writeFile(join(directory, 'package.json'), '{"name":"version-fixture","version":"2"}\n');
  assert.equal((await version.status()).updatePending, true);
});

test('runtime fingerprints still detect updates without Git and never expose file paths', async t => {
  const directory = await fixture(t);
  const version = await createServiceVersion({ projectDir: directory });
  const initial = await version.status();
  assert.equal(initial.running.revision, null); assert.equal(initial.running.dirty, null);
  assert.equal(initial.installed.revision, null); assert.equal(initial.installed.dirty, null);
  assert.equal(initial.updatePending, false); assert.match(initial.running.fingerprint, /^[a-f0-9]{64}$/);
  await writeFile(join(directory, 'src', 'new.mjs'), 'export default 2;');
  const changed = await version.status();
  assert.equal(changed.updatePending, true);
  assert.equal(JSON.stringify(changed).includes(directory), false);
  assert.deepEqual(Object.keys(changed.running).sort(), ['dirty', 'fingerprint', 'revision', 'startedAt']);
  assert.deepEqual(Object.keys(changed.installed).sort(), ['dirty', 'fingerprint', 'revision']);
});

test('additions, removals and dependency manifests affect fingerprints while restored content clears the update', async t => {
  const directory = await fixture(t);
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => clean() });
  const initial = await version.status();
  const extra = join(directory, 'src', 'new.mjs');
  await writeFile(extra, 'export default 2;'); assert.equal((await version.status()).updatePending, true);
  await rm(extra); assert.equal((await version.status()).updatePending, false);
  await writeFile(join(directory, 'package-lock.json'), '{"lockfileVersion":3}\n');
  assert.equal((await version.status()).updatePending, true);
  await rm(join(directory, 'package-lock.json'));
  const restored = await version.status();
  assert.equal(restored.updatePending, false); assert.equal(restored.installed.fingerprint, initial.installed.fingerprint);
});

test('missing disk code is unknown, never a false current version or a leaked filesystem error', async t => {
  const directory = await fixture(t);
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => { throw new Error('Bearer sensitive-token C:/private/auth.json'); } });
  const captured = await version.status();
  assert.equal(captured.updatePending, false); assert.equal(captured.running.revision, null);
  await rm(join(directory, 'src', 'main.mjs'));
  const missing = await version.status();
  assert.equal(missing.state, 'unknown'); assert.equal(missing.updatePending, null);
  assert.deepEqual(missing.running, captured.running);
  assert.deepEqual(missing.installed, { revision: null, fingerprint: null, dirty: null });
  assert.equal(/private|sensitive|ENOENT|service-version-/.test(JSON.stringify(missing)), false);
});

test('a missing startup snapshot cannot later masquerade as code loaded by the current process', async t => {
  const directory = await fixture(t);
  await rm(join(directory, 'src', 'main.mjs'));
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => clean() });
  await writeFile(join(directory, 'src', 'main.mjs'), 'export default 1;');
  const status = await version.status();
  assert.equal(status.running.fingerprint, null); assert.match(status.installed.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(status.state, 'unknown'); assert.equal(status.updatePending, null);
});

test('runtime links are not followed into private state', async t => {
  const directory = await fixture(t);
  const privateState = join(directory, 'private-state');
  await mkdir(privateState); await writeFile(join(privateState, 'credentials.json'), '{"token":"sensitive-fixture"}');
  try { await symlink(privateState, join(directory, 'src', 'linked'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Directory links are unavailable.'); return; } throw error; }
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => clean() });
  const status = await version.status();
  assert.equal(status.state, 'unknown'); assert.equal(status.running.fingerprint, null);
  assert.equal(JSON.stringify(status).includes('sensitive-fixture'), false);
});

test('concurrent dashboard status calls share one installed snapshot', async t => {
  const directory = await fixture(t);
  let calls = 0, blocked = false, release, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const version = await createServiceVersion({ projectDir: directory, readGitMetadata: async () => {
    calls++; if (blocked) { notify(); await gate; } return clean();
  } });
  blocked = true;
  const first = version.status(); await started;
  const second = version.status(); release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(calls, 2); assert.deepEqual(left, right);
});
