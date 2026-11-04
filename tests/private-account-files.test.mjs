import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateAccountFile, writePrivateAccountRecord } from '../src/private-account-files.mjs';

const windowsOnly = {
  skip: process.platform !== 'win32' ? 'Requires Windows file sharing locks.' : false,
  timeout: 15_000,
};

function deadline(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bifrost-private-record-')), finalizers = [];
  t.after(async () => {
    for (const finalize of finalizers.reverse()) await finalize();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  return { root, finalizers };
}

async function readLock(path, fixture) {
  // The static program receives its path through the environment, never shell interpolation.
  // FileShare.Read allows this test to inspect the original while denying replacement/deletion.
  const program = `
$ErrorActionPreference = 'Stop'
$file = [System.IO.File]::Open($env:BIFROST_PRIVATE_FILE_TEST_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  $file.Dispose()
}
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BIFROST_PRIVATE_FILE_TEST_PATH: path },
  });
  let output = '', errors = '', ready = false;
  child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4096); });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const release = async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('RELEASE\n');
    const result = await deadline(exited, 5000, 'File-lock helper did not exit after release.');
    if (result.error) throw result.error;
    assert.equal(result.code, 0, `File-lock helper failed: ${errors}`);
  };
  fixture.finalizers.push(async () => {
    try { await release(); }
    catch {
      child.kill();
      await deadline(exited, 5000, 'File-lock helper did not stop during cleanup.');
    }
  });
  await deadline(new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => {
      output = (output + bytes).slice(-4096);
      if (/^READY\r?$/m.test(output)) { ready = true; resolve(); }
    });
    exited.then(result => {
      if (!ready) reject(result.error ?? new Error(`File-lock helper exited before READY: ${errors}`));
    });
  }), 5000, 'File-lock helper did not become READY.');
  return { release };
}

test('private account records replace the complete file atomically and leave no temporary files', async t => {
  const f = await fixture(t), path = join(f.root, 'accounts.json');
  await writePrivateAccountRecord(path, { version: 1, accounts: [{ id: 'old' }] });
  const record = { version: 1, accounts: [{ id: 'new', name: 'Fixture 🌈' }], invites: [] };
  await writePrivateAccountRecord(path, record);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(record) + '\n');
  assert.deepEqual(await readdir(f.root), ['accounts.json']);
});

test('Windows atomic transaction waits out a brief read lock without overwriting the old file or replaying its operation', windowsOnly, async t => {
  const f = await fixture(t), path = join(f.root, 'accounts.json'), original = '{"version":1,"marker":"old"}\n';
  await writeFile(path, original);
  const lock = await readLock(path, f), store = new PrivateAccountFile(f.root, record => record);
  let settled, operations = 0;
  const writing = store.transaction(record => { operations++; record.marker = 'new'; return 'updated'; }).then(
    value => (settled = { ok: true, value }), error => (settled = { ok: false, error }),
  );
  let staged = [];
  for (let attempt = 0; attempt < 100 && !staged.length && !settled; attempt++) {
    staged = (await readdir(f.root)).filter(name => /^accounts\.json\.[0-9a-f]{16}\.tmp$/.test(name));
    if (!staged.length) await delay(1);
  }
  assert.equal(staged.length, 1, `The replacement was not staged: ${settled?.error?.code}`);
  // Keep the real sharing lock across the initial rename attempt and a short retry delay.
  await delay(40);
  assert.equal(settled, undefined, `The write settled while replacement was locked: ${settled?.error?.code}`);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(operations, 1);
  await lock.release();
  const result = await deadline(writing, 2000, 'The same write did not complete after its lock was released.');
  assert.equal(result.ok, true, result.error?.stack);
  assert.equal(result.value, 'updated'); assert.equal(operations, 1);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ version: 1, marker: 'new' }) + '\n');
  assert.deepEqual(await readdir(f.root), ['accounts.json']);
});

test('Windows atomic record replacement fails after bounded retries and preserves the old file under a persistent read lock', windowsOnly, async t => {
  const f = await fixture(t), path = join(f.root, 'accounts.json'), original = '{"version":1,"marker":"old"}\n';
  await writeFile(path, original);
  const lock = await readLock(path, f);
  const result = await deadline(writePrivateAccountRecord(path, { version: 1, marker: 'new' }).then(
    () => ({ ok: true }), error => ({ ok: false, error }),
  ), 2000, 'The write did not stop after bounded retries.');
  assert.equal(result.ok, false);
  assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(result.error.code), result.error.stack);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(f.root), ['accounts.json']);
  await lock.release();
  assert.equal(await readFile(path, 'utf8'), original);
});
