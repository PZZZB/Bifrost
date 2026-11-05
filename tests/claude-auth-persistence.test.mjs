import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ClaudeCliHub, readClaudeAuthorization } from '../src/claude-cli-provider.mjs';

const now = 1_800_000_000_000;
const saved = { claudeAiOauth: { accessToken: 'inert-fixture-access', refreshToken: 'inert-fixture-refresh',
  expiresAt: now + 3_600_000, scopes: ['user:inference', 'user:profile'] } };
async function fixture(t, value = saved) {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-saved-auth-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const path = join(configDir, '.credentials.json');
  const save = data => writeFile(path, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  await save(value);
  return { configDir, path, save, read: options => readClaudeAuthorization({ configDir, now, platform: 'linux', ...options }) };
}

test('repeated health checks and a new hub read the same persistent credentials without starting Claude or rewriting tokens', async t => {
  const f = await fixture(t), marker = join(f.configDir, 'cli-was-started');
  const binary = join(f.configDir, 'not-an-official-cli');
  await writeFile(binary, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const before = await lstat(f.path), original = await readFile(f.path);
  let clock = now;
  const build = () => new ClaudeCliHub({ binary, configDir: f.configDir,
    profileDir: f.configDir, stateDir: join(f.configDir, 'state'), clock: () => clock, mcpPort: 0 });
  let hub = build(); await hub.start(); t.after(() => hub.close());
  for (let i = 0; i < 4; i++) {
    const status = await hub.status();
    assert.equal(status.authenticated, true); assert.equal(status.renewable, true);
    assert.doesNotMatch(JSON.stringify(status), /inert-fixture|accessToken|refreshToken|scopes/);
    clock += 31_000;
  }
  await hub.close(); hub = build(); await hub.start();
  assert.equal((await hub.status()).ready, true);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.path), original);
  const after = await lstat(f.path);
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
});

test('expired access with a saved refresh token remains renewable; the inspector never refreshes it itself', async t => {
  const f = await fixture(t, { claudeAiOauth: { ...saved.claudeAiOauth, expiresAt: now - 1 } });
  const original = await readFile(f.path);
  assert.deepEqual(await f.read(), { authenticated: true, renewable: true, credentialState: 'refresh_required' });
  assert.deepEqual(await readFile(f.path), original);
  await f.save({ claudeAiOauth: { ...saved.claudeAiOauth, accessToken: '', expiresAt: 0 } });
  assert.equal((await f.read()).authenticated, true);
});

test('missing, blank and expired nonrenewable authorization are distinct from storage failures', async t => {
  const f = await fixture(t, { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } });
  assert.deepEqual(await f.read(), { authenticated: false, renewable: false, credentialState: 'missing' });
  await f.save({ claudeAiOauth: { ...saved.claudeAiOauth, refreshToken: '', expiresAt: now - 1 } });
  assert.equal((await f.read()).credentialState, 'expired');
  await f.save({ apiKey: 'inert-other-auth-method' });
  assert.equal((await f.read()).authenticated, false);
  await f.save('{invalid'); assert.equal((await f.read()).credentialState, 'invalid');
  await f.save('x'.repeat(65_537)); assert.equal((await f.read()).authenticated, false);
  await rm(f.path); assert.equal((await f.read()).credentialState, 'missing');
});

test('read-only inspection refuses symlinked and publicly readable credential files without fixing them in place', {
  skip: process.platform === 'win32',
}, async t => {
  const f = await fixture(t);
  await chmod(f.path, 0o644);
  assert.equal((await f.read()).credentialState, 'unreadable');
  assert.equal((await lstat(f.path)).mode & 0o777, 0o644);
  await rm(f.path);
  const target = join(f.configDir, 'other-private-file');
  await writeFile(target, JSON.stringify(saved), { mode: 0o600 }); await symlink(target, f.path);
  assert.equal((await f.read()).credentialState, 'unreadable');
  assert.equal((await lstat(f.path)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), saved);
});

test('macOS inspects the pinned profile Keychain entry through the OS without launching Claude or exporting a token', async () => {
  const configDir = '/private/isolated-profile/auth', calls = [];
  const state = await readClaudeAuthorization({ configDir, platform: 'darwin', now, execFileImpl: async (...args) => {
    calls.push(args); return { stdout: JSON.stringify(saved) };
  } });
  assert.equal(state.authenticated, true); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/security');
  assert.equal(calls[0][1].at(-1), `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`);
  assert.doesNotMatch(JSON.stringify([state, calls]), /inert-fixture/);
  const denied = await readClaudeAuthorization({ configDir, platform: 'darwin', now, execFileImpl: async () => {
    throw Object.assign(new Error('private OS diagnostic'), { code: 36 });
  } });
  assert.deepEqual(denied, { authenticated: false, renewable: false, credentialState: 'unreadable' });
});

test('unreadable storage reports a storage problem instead of telling the operator to log in again', async t => {
  const f = await fixture(t);
  const hub = new ClaudeCliHub({ binary: '/not-a-cli', configDir: f.configDir, profileDir: f.configDir,
    stateDir: f.configDir, authStatus: async () => ({ authenticated: false, credentialState: 'unreadable' }) });
  const status = await hub.status();
  assert.equal(status.ready, false); assert.match(status.error, /凭据暂不可读取/); assert.doesNotMatch(status.error, /重新授权|完成.*登录/);
});
