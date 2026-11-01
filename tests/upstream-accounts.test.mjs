import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { UpstreamAccountStore, readUpstreamAccounts, validateUpstreamAccounts } from '../src/upstream-account-store.mjs';
import { UpstreamAccounts } from '../src/upstream-accounts.mjs';
import { loadServerRemotesConfig } from '../src/runtime/server-remotes-config.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';

async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-upstreams-')));
  t.after(() => rm(path, { recursive: true, force: true })); return path; }
const remote = id => ({ id, kind: 'bifrost-remote', baseUrl: 'https://gateway.example.test/v1',
  protocols: ['messages', 'chat-completions'], credentialRef: randomUUID() });

test('migration imports real bindings once and preserves aliases, credential references and original files', async t => {
  const stateDir = await directory(t), original = { version: 1, sources: [remote('bifrost')] };
  const old = join(stateDir, 'remote-sources.json'); await writeFile(old, JSON.stringify(original), { mode: 0o600 });
  const store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'claude', name: '隔离 Claude' }] });
  assert.equal(store.snapshot().accounts.length, 2);
  assert.deepEqual(await loadServerRemotesConfig(stateDir), original);
  assert.equal(await readFile(old, 'utf8'), JSON.stringify(original));
  const entry = store.snapshot().accounts.find(a => a.kind === 'claude'), revision = store.snapshot().revision;
  await store.update(entry.id, { revision, enabled: false, name: 'Named Claude' });
  const reopened = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'claude', name: 'Old default' }] });
  const row = reopened.snapshot().accounts.find(a => a.id === entry.id);
  assert.equal(row.name, 'Named Claude'); assert.equal(row.enabled, false); assert.equal(reopened.snapshot().accounts.length, 2);
});

test('canonical metadata owns the remote config after migration and malformed state never falls back', async t => {
  const stateDir = await directory(t), source = remote('original');
  const store = await UpstreamAccountStore.open({ stateDir }); await store.setRemote(source);
  await writeFile(join(stateDir, 'remote-sources.json'), JSON.stringify({ version: 1, sources: [remote('stale')] }), { mode: 0o600 });
  assert.deepEqual((await loadServerRemotesConfig(stateDir)).sources.map(s => s.id), ['original']);
  const path = join(stateDir, 'upstream-accounts.json'); await writeFile(path, '{corrupt', { mode: 0o600 });
  await assert.rejects(loadServerRemotesConfig(stateDir), e => e.code === 'upstream_accounts_invalid');
  await assert.rejects(UpstreamAccountStore.open({ stateDir })); assert.equal(await readFile(path, 'utf8'), '{corrupt');
});

test('instance updates reject lost writes and disk failures keep the running state unchanged', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'codebuddy', name: 'Company' }] });
  const before = store.snapshot(), id = before.accounts[0].id;
  store.write = async () => { throw new Error('disk full'); };
  await assert.rejects(store.update(id, { revision: before.revision, enabled: false })); assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await readUpstreamAccounts(stateDir), before);
  store.write = (await import('../src/storage.mjs')).writeJson;
  const writes = await Promise.allSettled([store.update(id, { revision: before.revision, name: 'First' }), store.update(id, { revision: before.revision, name: 'Second' })]);
  assert.deepEqual(writes.map(w => w.status), ['fulfilled', 'rejected']); assert.equal(writes[1].reason.code, 'upstream_accounts_conflict');
  await mkdir(join(stateDir, 'upstream-accounts.lock'));
  await assert.rejects(store.update(id, { revision: store.snapshot().revision, enabled: false }), e => e.code === 'upstream_accounts_busy');
});

test('types and metadata cannot carry credentials, arbitrary bindings, duplicate slots or unsupported protocols', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'claude', name: 'Claude' }] });
  const original = store.snapshot();
  for (const patch of [{ apiKey: 'secret' }, { binding: { slot: 'CodeBuddy' } }, { kind: 'cursor' }, { enabled: 'true' }, { name: 'bfk_' + 'x'.repeat(43) }]) {
    await assert.rejects(store.update(original.accounts[0].id, { revision: original.revision, ...patch }));
  }
  for (const change of [v => { v.accounts.push(v.accounts[0]); }, v => { v.accounts[0].binding.slot = 'Cursor'; },
    v => { v.accounts[0].credential = 'secret'; }, v => { v.version = 2; }]) {
    const value = structuredClone(original); change(value); assert.throws(() => validateUpstreamAccounts(value));
  }
  assert.deepEqual(store.snapshot(), original);
});

async function fixture(t, { kinds = ['claude'], readers = {}, seeds = [{ kind: 'claude', name: 'Managed Claude' }] } = {}) {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir, seeds });
  const policy = await ModelPolicy.open({ path: join(stateDir, 'models.json') });
  await policy.observe({ models: [{ id: 'Claude-opus', name: 'Opus', channel: 'Claude', enabled: true, available: true }] }, 'Claude');
  const calls = [], manager = new UpstreamAccounts({ store, types: kinds, modelPolicy: policy,
    readers: { claude: () => { calls.push('claude'); return { configured: true, ready: true, authenticated: null }; }, ...readers },
    getModels: () => policy.snapshot().models.map(m => ({ ...m, available: true })),
    capabilities: () => ({ clientIntegration: false, userManagement: true, billing: true }) });
  return { stateDir, store, policy, manager, calls };
}

test('current-node capability snapshots expose one managed Claude and no foreign provider placeholders or credential references', async t => {
  const f = await fixture(t), data = await f.manager.snapshot();
  assert.deepEqual(data.accountTypes.map(t => t.kind), ['claude']); assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].state, 'ready'); assert.equal(data.accountTypes[0].canAdd, false);
  assert.equal(data.models[0].sourceAccountId, data.accounts[0].id); assert.equal(data.accounts[0].publishedModelCount, 1);
  assert.doesNotMatch(JSON.stringify(data), /credentialRef|binding|192\.168|\/Users\/|CodeBuddy|Cursor/);
  await assert.rejects(f.manager.create({ kind: 'codebuddy', name: 'Foreign' }), e => e.code === 'upstream_type_unavailable');
  await assert.rejects(f.manager.create({ kind: 'claude', name: 'Duplicate environment' }));
});

test('disabling a source stops publication without changing its model preference or reading its credentials/status', async t => {
  const f = await fixture(t); const initial = await f.manager.snapshot(), account = initial.accounts[0];
  f.calls.length = 0;
  const updated = await f.manager.update(account.id, { revision: initial.revision, enabled: false });
  assert.equal(f.manager.allows('Claude'), false); assert.equal(updated.accounts[0].state, 'disabled');
  assert.equal(updated.models[0].enabled, true); assert.equal(updated.models[0].available, false); assert.deepEqual(f.calls, []);
  const restored = await f.manager.update(account.id, { revision: updated.revision, enabled: true });
  assert.equal(restored.accounts[0].id, account.id); assert.equal(restored.accounts[0].state, 'ready');
  assert.equal(f.manager.allows('A'), true); assert.equal(f.manager.allows('Cursor'), false); assert.equal(f.manager.allows(undefined), false);
});

test('local type creation records pending authorization and exposes the real adapter capacity', async t => {
  const f = await fixture(t, { kinds: ['codex', 'codebuddy', 'cursor', 'bifrost'], seeds: [] });
  assert.equal((await f.manager.snapshot()).accounts.length, 0);
  const created = await f.manager.create({ kind: 'codebuddy', name: 'Company quota' });
  assert.equal(created.accounts.length, 1); assert.equal(created.accounts[0].state, 'activation_required'); assert.equal(created.restartRequired, true);
  assert.equal(created.accountTypes.find(t => t.kind === 'codebuddy').maxAccounts, 1);
  await assert.rejects(f.manager.create({ kind: 'codebuddy', name: 'Duplicate' }), e => e.code === 'upstream_account_capacity');
  await assert.rejects(f.manager.create({ kind: 'cursor', name: 'Bad', apiKey: 'not-an-employee-login' }));
  await assert.rejects(f.manager.create({ kind: 'codex', name: 'Bad', command: 'injected' }));
});

test('remote sources use distinct immutable bindings, and stopping one does not stop another', async t => {
  const f = await fixture(t, { kinds: ['bifrost'], seeds: [] });
  const first = remote('first'), second = remote('second'); await f.store.setRemote(first); await f.store.setRemote(second);
  const models = [{ id: 'remote/first/Claude-opus', channel: 'Bifrost' }, { id: 'remote/second/Claude-opus', channel: 'Bifrost' }];
  const stopped = [];
  f.manager.getModels = () => models;
  f.manager.getRemotes = () => ({ model: id => ({ source: { id: id === models[0].id ? 'first' : 'second' } }),
    status: () => ['first', 'second'].map(id => ({ id, available: true, state: 'ready' })), stopSource: async id => stopped.push(id) });
  const before = await f.manager.snapshot(); assert.equal(before.accounts.length, 2);
  const a = before.accounts.find(a => a.endpoint && a.id === f.store.snapshot().accounts[0].id);
  await f.manager.update(a.id, { revision: before.revision, enabled: false });
  assert.deepEqual(stopped, ['first']); assert.equal(f.manager.allows('Bifrost', models[0].id), false);
  assert.equal(f.manager.allows('Bifrost', models[1].id), true);
  assert.deepEqual((await loadServerRemotesConfig(f.stateDir)).sources.map(s => s.id), ['second']);
});
