import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { UpstreamAccountStore, readUpstreamAccounts, validateUpstreamAccounts, validateModelPresentation } from '../src/upstream-account-store.mjs';
import { UpstreamAccounts } from '../src/upstream-accounts.mjs';
import { loadServerRemotesConfig } from '../src/runtime/server-remotes-config.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';
import { claudeSubscriptionUsage } from '../src/claude-subscription-usage.mjs';

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

test('model presentation validates complete bounded metadata and counts Unicode codepoints', () => {
  assert.deepEqual(validateModelPresentation({ prefix: '  Codex B ·  ', order: 9999 }), { prefix: 'Codex B ·', order: 9999 });
  assert.deepEqual(validateModelPresentation({ prefix: '   ', order: 0 }), { prefix: '', order: 0 });
  assert.deepEqual(validateModelPresentation({ prefix: '🌈'.repeat(48), order: 5 }), { prefix: '🌈'.repeat(48), order: 5 });
  const invalid = [null, [], {}, { prefix: '' }, { order: 1 }, { prefix: '', order: 1, extra: true },
    { prefix: 5, order: 1 }, { prefix: 'B', order: '1' }, { prefix: 'B', order: -1 }, { prefix: 'B', order: 10000 },
    { prefix: 'B', order: 0.5 }, { prefix: 'B', order: NaN }, { prefix: 'B', order: Infinity },
    { prefix: 'x'.repeat(49), order: 1 }, { prefix: '🌈'.repeat(49), order: 1 }];
  const unsafePrefixes = ['B\n', '\tB', 'B\u0000', 'B\u0085', 'B\u2028', 'B\u2029', 'B\u202e', 'B\u200b', 'B\ud800',
    'Bearer', 'bearer secret', 'B-BEARER:secret', 'Bearer.private', 'bfk_private', 'bfs_private', 'bfi_private', 'bfn_private',
    'Account-BFN_private', 'B-sk-private', 'rt_private', 'oat_private', 'oaistb_private', 'eyJprivate'];
  invalid.push(...unsafePrefixes.map(prefix => ({ prefix, order: 1 })));
  for (const value of invalid) assert.throws(() => validateModelPresentation(value), e => e.status === 400 && e.code === 'upstream_model_presentation_invalid');
});

test('legacy accounts remain byte-for-byte unchanged on read or reopen without presentation defaults', async t => {
  const stateDir = await directory(t);
  const store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'codex', name: 'Existing B' }, { kind: 'codebuddy', name: 'Existing CodeBuddy' }] });
  const path = join(stateDir, 'upstream-accounts.json'), before = await readFile(path, 'utf8');
  let writes = 0;
  const reopened = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'codex', name: 'Ignored default' }], write: async () => { writes++; } });
  assert.deepEqual(reopened.snapshot(), store.snapshot());
  assert.deepEqual(await readUpstreamAccounts(stateDir), store.snapshot());
  await reopened.reload();
  assert.equal(writes, 0);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.ok(reopened.snapshot().accounts.every(account => !Object.hasOwn(account, 'modelPresentation')));
});

test('presentation updates persist canonical values while retaining identities, bindings and sibling accounts', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir,
    seeds: [{ kind: 'codex-client', name: 'Caller A' }, { kind: 'codex', name: 'Managed B' }] });
  await store.setRemote(remote('preserved'), 'Other server');
  const original = store.snapshot(), target = original.accounts.find(account => account.kind === 'codex');
  const updated = await store.update(target.id, { revision: original.revision, name: 'Renamed B', enabled: false,
    modelPresentation: { prefix: '  B account · ', order: 8 } });
  assert.equal(updated.revision, original.revision + 1);
  const current = updated.accounts.find(account => account.id === target.id);
  assert.deepEqual(current, { ...target, name: 'Renamed B', enabled: false, modelPresentation: { prefix: 'B account ·', order: 8 } });
  assert.deepEqual(updated.accounts.filter(account => account.id !== target.id), original.accounts.filter(account => account.id !== target.id));
  const reopened = await UpstreamAccountStore.open({ stateDir });
  assert.deepEqual(reopened.snapshot(), updated);
  const beforeNoop = await readFile(join(stateDir, 'upstream-accounts.json'), 'utf8');
  await reopened.update(target.id, { revision: updated.revision, modelPresentation: { prefix: 'B account ·', order: 8 } });
  assert.equal(reopened.snapshot().revision, updated.revision);
  assert.equal(await readFile(join(stateDir, 'upstream-accounts.json'), 'utf8'), beforeNoop);
  current.modelPresentation.prefix = 'modified snapshot';
  assert.equal(store.snapshot().accounts.find(account => account.id === target.id).modelPresentation.prefix, 'B account ·');
  const empty = await reopened.update(target.id, { revision: updated.revision, modelPresentation: { prefix: '', order: 0 } });
  assert.deepEqual(empty.accounts.find(account => account.id === target.id).modelPresentation, { prefix: '', order: 0 });
});

test('presentation writes retain revision conflicts and disk failures without publishing partial metadata', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'cursor', name: 'Cursor' }] });
  const before = store.snapshot(), id = before.accounts[0].id;
  const writes = await Promise.allSettled([
    store.update(id, { revision: before.revision, modelPresentation: { prefix: 'First', order: 1 } }),
    store.update(id, { revision: before.revision, modelPresentation: { prefix: 'Second', order: 2 } }),
  ]);
  assert.deepEqual(writes.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(writes[1].reason.code, 'upstream_accounts_conflict');
  const saved = store.snapshot();
  assert.deepEqual(saved.accounts[0].modelPresentation, { prefix: 'First', order: 1 });
  store.write = async () => { throw new Error('disk full'); };
  await assert.rejects(store.update(id, { revision: saved.revision, modelPresentation: { prefix: 'Not saved', order: 3 } }));
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(await readUpstreamAccounts(stateDir), saved);
});

test('invalid presentation patches and stored metadata fail closed without changing existing files', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'claude', name: 'Claude' }] });
  const before = store.snapshot(), id = before.accounts[0].id, path = join(stateDir, 'upstream-accounts.json');
  const originalText = await readFile(path, 'utf8');
  const invalid = [undefined, null, {}, { prefix: 'B' }, { prefix: 'B', order: 10000 }, { prefix: 'B', order: 2, credential: 'PRIVATE' },
    { prefix: 'B\n', order: 2 }, { prefix: 'Bearer PRIVATE', order: 2 }, { prefix: 'x'.repeat(49), order: 2 }];
  for (const modelPresentation of invalid) {
    await assert.rejects(store.update(id, { revision: before.revision, modelPresentation }), e => e.code === 'upstream_model_presentation_invalid');
    assert.deepEqual(store.snapshot(), before);
    assert.equal(await readFile(path, 'utf8'), originalText);
  }
  for (const modelPresentation of [...invalid, { prefix: '  B  ', order: 1 }]) {
    const corrupted = structuredClone(before); corrupted.accounts[0].modelPresentation = modelPresentation;
    assert.throws(() => validateUpstreamAccounts(corrupted), e => e.code === 'upstream_accounts_invalid');
    if (modelPresentation === undefined) continue; // JSON omits absent optional properties.
    const text = JSON.stringify(corrupted); await writeFile(path, text, { mode: 0o600 });
    await assert.rejects(UpstreamAccountStore.open({ stateDir }), e => e.code === 'upstream_accounts_invalid');
    assert.equal(await readFile(path, 'utf8'), text);
  }
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

test('managed Claude displays subscription percentages separately from customer money and skips disabled status reads', async t => {
  let reads = 0;
  const usage = claudeSubscriptionUsage({ subscription_type: 'pro', rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 3, resets_at: new Date(Date.now() + 3600000).toISOString() } } });
  const f = await fixture(t, { readers: { claude: () => { reads++; return { configured: true, ready: true, subscriptionUsage: usage,
    balanceMicros: 99999999, apiKey: 'PRIVATE' }; } } });
  let snapshot = await f.manager.snapshot(); assert.equal(snapshot.accounts[0].quota.kind, 'subscription');
  assert.equal(snapshot.accounts[0].quota.windows[0].usedPercent, 3); assert.doesNotMatch(JSON.stringify(snapshot), /balanceMicros|PRIVATE/);
  const before = reads;
  snapshot = await f.manager.update(snapshot.accounts[0].id, { revision: snapshot.revision, enabled: false });
  assert.equal(reads, before); assert.equal(snapshot.accounts[0].quota.status, 'unavailable');
  assert.deepEqual(snapshot.accounts[0].quota.windows, []); assert.match(snapshot.accounts[0].quota.label, /停用/);
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

test('registering the caller source preserves existing managed accounts, authorization files and model choices', async t => {
  const stateDir = await directory(t), managed = await UpstreamAccountStore.open({ stateDir,
    seeds: [{ kind: 'codex', name: 'Employee subscription' }] });
  const b = managed.snapshot().accounts[0];
  await managed.update(b.id, { revision: managed.snapshot().revision, name: 'Named B', enabled: false });
  await managed.setRemote(remote('retained'), 'Named remote');
  const before = managed.snapshot(), privateFiles = ['bridge.json', 'model-policy.json', 'auth.json'];
  for (const file of privateFiles) await writeFile(join(stateDir, file), `untouched-${file}`, { mode: 0o600 });
  const reopened = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'codex-client', name: 'Codex · 当前客户端（A）' },
    { kind: 'codex', name: 'Ignored old name' }] });
  assert.deepEqual(reopened.snapshot().accounts.filter(a => a.kind !== 'codex-client'), before.accounts);
  const caller = reopened.snapshot().accounts.find(a => a.kind === 'codex-client');
  assert.equal(caller.binding.slot, 'A'); assert.equal(caller.id, 'legacy-codex-client');
  assert.equal(reopened.snapshot().revision, before.revision + 1);
  await reopened.update(caller.id, { revision: reopened.snapshot().revision, name: 'Caller source', enabled: false });
  const again = await UpstreamAccountStore.open({ stateDir, seeds: [{ kind: 'codex-client', name: 'Default' }] });
  assert.equal(again.snapshot().accounts.length, before.accounts.length + 1);
  assert.equal(again.snapshot().accounts.find(a => a.id === caller.id).name, 'Caller source');
  assert.equal(again.snapshot().accounts.find(a => a.id === caller.id).enabled, false);
  for (const file of privateFiles) assert.equal(await readFile(join(stateDir, file), 'utf8'), `untouched-${file}`);
});

test('caller accounts own A model metadata without owning reusable credentials or consuming the managed Codex slot', async t => {
  const stateDir = await directory(t), store = await UpstreamAccountStore.open({ stateDir,
    seeds: [{ kind: 'codex-client', name: 'Current client' }] });
  const sourceModels = [{ id: 'gpt-native', name: 'Native', channel: 'A', enabled: false, available: true },
    { id: 'B-model', name: 'Managed', channel: 'B', available: true }];
  let reads = 0;
  const manager = new UpstreamAccounts({ store, types: ['codex-client', 'codex'], getModels: () => sourceModels,
    readers: { 'codex-client': () => { reads++; return { configured: true, ready: true, authToken: 'PRIVATE', email: 'not-a-global-identity' }; } },
    capabilities: () => ({ clientIntegration: true, userManagement: true }) });
  let data = await manager.snapshot(), caller = data.accounts[0];
  assert.equal(caller.state, 'caller_required'); assert.equal(caller.credential.mode, 'caller'); assert.equal(caller.credential.reusable, false);
  assert.equal(caller.modelCount, 1); assert.equal(caller.publishedModelCount, 0);
  assert.equal(data.models[0].sourceAccountId, caller.id); assert.equal(data.models[0].sourceCredential.mode, 'caller');
  assert.equal(data.accountTypes.find(a => a.kind === 'codex').canAdd, true);
  assert.equal(data.accountTypes.find(a => a.kind === 'codex-client').canAdd, false);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE|not-a-global-identity|authToken/);
  await assert.rejects(manager.create({ kind: 'codex-client', name: 'Another caller' }), e => e.code === 'upstream_type_unavailable');
  data = await manager.create({ kind: 'codex', name: 'Independent B' });
  assert.equal(data.accounts.filter(a => a.kind === 'codex').length, 1);
  const beforeReads = reads;
  data = await manager.update(caller.id, { revision: data.revision, enabled: false });
  assert.equal(reads, beforeReads); assert.equal(manager.allows('A'), false);
  assert.equal(data.models.find(m => m.channel === 'A').enabled, false);
  assert.equal(data.models.find(m => m.channel === 'A').available, false);
  assert.equal(data.accounts.find(a => a.id === caller.id).state, 'disabled');
  assert.ok(data.accounts.find(a => a.id === caller.id).routes.every(r => !r.available));
});
