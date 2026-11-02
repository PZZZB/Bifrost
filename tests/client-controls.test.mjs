import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientControls } from '../src/client-controls.mjs';
import { createCodexClientControl } from '../src/clients/codex-control.mjs';

const models = () => [
  { id: 'gpt-6.1-sol', name: 'Native A', channel: 'A', enabled: true, available: true, protocols: ['responses'] },
  { id: 'B-gpt-6.1-sol', name: 'B', channel: 'B', enabled: true, available: true, protocols: ['responses', 'chat-completions'] },
  { id: 'remote/work/Claude-opus', name: 'Opus', channel: 'Bifrost', enabled: true, available: true, protocols: ['responses', 'chat-completions'] },
  { id: 'disabled', name: 'Disabled', channel: 'CodeBuddy', enabled: false, available: true, protocols: ['responses', 'chat-completions'] },
];
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-controls-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let catalog = models();
  const modes = { codex: 'gateway', codebuddy: 'native', workbuddy: 'native' };
  const adapters = Object.keys(modes).map(id => ({ id, name: id, protocol: id === 'codex' ? 'responses' : 'chat-completions',
    inspect: async () => ({ mode: modes[id] }), setMode: async mode => { calls.push(['mode', id, mode]); modes[id] = mode; },
    sync: async entries => { calls.push(['sync', id, entries.map(entry => entry.id)]); } }));
  adapters.push({ id: 'cursor', name: 'Cursor', inspect: async () => ({ mode: 'manual', reason: 'Manual configuration only' }) });
  const apps = { snapshot: async () => adapters.map(adapter => ({ id: adapter.id, installed: true, launchSupported: true })),
    launch: async id => { calls.push(['launch', id]); } };
  const options = { path: join(directory, 'controls.json'), adapters, apps, getModels: () => catalog,
    refreshModels: async () => { calls.push(['refresh']); } };
  const controls = await ClientControls.open(options); t.after(() => controls.close());
  return { controls, options, calls, modes, adapters, set catalog(value) { catalog = value; } };
}

test('reading client status never starts apps, changes modes or writes model files', async t => {
  const f = await fixture(t), snapshot = await f.controls.snapshot();
  assert.deepEqual(f.calls, []); assert.equal(snapshot.clients[0].autoSync, true);
  assert.equal(snapshot.clients[0].latestModelCount, 3);
  assert.equal(snapshot.clients[1].latestModelCount, 2);
  assert.equal(snapshot.clients[1].syncState, 'native');
  assert.equal(snapshot.clients[3].supports.mode, false);
  await assert.rejects(readFile(f.options.path), error => error.code === 'ENOENT');
});

test('automatic sync runs only in gateway mode and tracks changes without switching or launching clients', async t => {
  const f = await fixture(t);
  await f.controls.autoSync();
  assert.deepEqual(f.calls, [['sync', 'codex', ['gpt-6.1-sol', 'B-gpt-6.1-sol', 'remote/work/Claude-opus']]]);
  await f.controls.autoSync(); assert.equal(f.calls.length, 1);
  f.catalog = [...models(), { id: 'new-model', name: 'New', channel: 'CodeBuddy', enabled: true, available: true,
    protocols: ['responses', 'chat-completions'] }];
  await f.controls.autoSync(); assert.equal(f.calls.length, 2);
  assert.equal((await f.controls.snapshot()).clients[0].syncState, 'current');
  const restored = await ClientControls.open(f.options); t.after(() => restored.close());
  assert.equal((await restored.snapshot()).clients[0].syncState, 'current');
});

test('manual sync remains usable with auto sync off and native mode never receives automatic model writes', async t => {
  const f = await fixture(t);
  await f.controls.mutate('codebuddy', 'mode', { mode: 'gateway' });
  const companySync = f.calls.find(call => call[0] === 'sync' && call[1] === 'codebuddy');
  assert.deepEqual(companySync[2], ['B-gpt-6.1-sol', 'remote/work/Claude-opus']);
  await f.controls.mutate('codebuddy', 'settings', { autoSync: false });
  f.calls.length = 0;
  f.catalog = [...models(), { id: 'new', channel: 'B', enabled: true, available: true, protocols: ['chat-completions', 'responses'] }];
  await f.controls.autoSync(); assert.equal(f.calls.some(call => call[1] === 'codebuddy'), false);
  await f.controls.mutate('codebuddy', 'sync', {});
  assert.equal(f.calls.filter(call => call[0] === 'sync' && call[1] === 'codebuddy').length, 1);
  await f.controls.mutate('codebuddy', 'mode', { mode: 'native' });
  f.calls.length = 0; await f.controls.autoSync();
  assert.equal(f.calls.some(call => call[1] === 'codebuddy'), false);
  await assert.rejects(f.controls.mutate('codebuddy', 'sync', {}), error => error.code === 'client_not_gateway');
});

test('a sync error preserves the previous synced revision and does not prevent another client from updating', async t => {
  const f = await fixture(t); f.modes.codebuddy = 'gateway';
  f.adapters[0].sync = async () => { throw new Error('Catalog write rejected'); };
  await f.controls.autoSync();
  const snapshot = await f.controls.snapshot();
  assert.equal(snapshot.clients[0].syncState, 'conflict'); assert.equal(snapshot.clients[0].lastSyncAt, null);
  assert.equal(snapshot.clients[1].syncState, 'current');
  f.adapters[0].sync = async () => {}; await f.controls.mutate('codex', 'sync', {});
  assert.equal((await f.controls.snapshot()).clients[0].syncState, 'current');
});

test('restoring native mode and launching remain available when the model catalog cannot be read', async t => {
  const f = await fixture(t);
  f.controls.getModels = () => { throw new Error('Catalog unavailable'); };
  const restored = await f.controls.mutate('codex', 'mode', { mode: 'native' });
  assert.deepEqual(f.calls, [['mode', 'codex', 'native']]);
  assert.equal(restored.clients[0].mode, 'native'); assert.equal(restored.catalogAvailable, false);
  assert.equal(restored.clients[0].latestModelCount, null);
  await f.controls.mutate('cursor', 'launch', {});
  assert.deepEqual(f.calls.at(-1), ['launch', 'cursor']);
  assert.equal(f.calls.some(call => call[0] === 'refresh' || call[0] === 'sync'), false);
});

test('actions validate exact bodies and fixed client IDs without accepting commands or paths', async t => {
  const f = await fixture(t);
  await assert.rejects(f.controls.mutate('missing', 'launch', {}), error => error.status === 404);
  for (const [action, body] of [['launch', { command: 'arbitrary' }], ['sync', { path: 'C:/arbitrary' }],
    ['mode', { mode: 'gateway', command: 'arbitrary' }], ['settings', { autoSync: true, mode: 'gateway' }]]) {
    await assert.rejects(f.controls.mutate('codex', action, body), error => error.status === 400);
  }
  await assert.rejects(f.controls.mutate('cursor', 'mode', { mode: 'gateway' }), error => error.code === 'client_mode_unsupported');
  assert.deepEqual(f.calls, []);
  await f.controls.mutate('cursor', 'launch', {}); assert.deepEqual(f.calls, [['launch', 'cursor']]);
});

test('Codex mode control reuses the native editor and sync never rewrites authentication or provider fields', async () => {
  let mode = 'official'; const calls = [];
  const adapter = createCodexClientControl({ integration: {
    inspect: async () => ({ installed: true, routing: { mode } }),
    switchMode: async value => { calls.push(value); mode = value; },
  } });
  assert.equal((await adapter.inspect()).mode, 'native');
  await assert.rejects(adapter.sync(), error => error.code === 'client_codex_catalog_unavailable');
  await adapter.setMode('gateway'); await adapter.sync();
  assert.deepEqual(calls, ['gateway']);
  await adapter.setMode('native'); assert.deepEqual(calls, ['gateway', 'official']);
});
