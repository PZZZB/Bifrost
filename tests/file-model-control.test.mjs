import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileModelControl } from '../src/clients/file-model-control.mjs';

const key = 'owner-gateway-KEY-fixture-only-123456789';
const url = 'http://127.0.0.1:43155/owner/v1/chat/completions';
const models = [{ id: 'B-model', name: 'Managed model', capabilities: { tools: { support: true }, images: { support: false } } }];
async function fixture(t, original) {
  // macOS aliases /var to /private/var; keep the fixture itself free of links.
  const temporaryRoot = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(join(temporaryRoot, 'bifrost-client-files-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), temporaryRoot); assert.ok(basename(root).startsWith('bifrost-client-files-'));
    await fs.rm(root, { recursive: true, force: true }); });
  const configPath = join(root, 'client', 'models.json'), statePath = join(root, 'bridge', 'client.json');
  if (original !== undefined) { await fs.mkdir(dirname(configPath), { recursive: true }); await fs.writeFile(configPath, typeof original === 'string' ? original : JSON.stringify(original)); }
  const options = { id: 'codebuddy', name: 'CodeBuddy', configPath, statePath, gatewayUrl: url, gatewayKey: key };
  return { root, configPath, statePath, options, control: createFileModelControl(options), read: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}

test('gateway mode merges its own models and native mode preserves other models, fields and filter choices', async t => {
  const foreign = { id: 'foreign', name: 'Own API', apiKey: 'DO-NOT-RETURN-PRIVATE', url: 'https://api.example.test/chat/completions' };
  const original = { models: [foreign], availableModels: ['built-in', 'foreign'], customSetting: { retained: true } };
  const f = await fixture(t, original), status = await f.control.setMode('gateway', { models });
  assert.equal(status.mode, 'gateway'); assert.equal(status.managedModelCount, 1);
  const data = await f.read(); assert.deepEqual(data.models[0], foreign); assert.deepEqual(data.customSetting, original.customSetting);
  assert.equal(data.models[1].apiKey, key); assert.equal(data.models[1].url, url); assert.equal(data.models[1].supportsToolCall, true);
  assert.deepEqual(data.availableModels, ['built-in', 'foreign', 'B-model']);
  assert.doesNotMatch(JSON.stringify(status), /apiKey|DO-NOT-RETURN|owner-gateway-KEY/);
  const restored = await f.control.setMode('native'); assert.equal(restored.mode, 'native'); assert.deepEqual(await f.read(), original);
});

test('native sync never creates state or client files, and native mode leaves unmanaged bytes unchanged', async t => {
  const f = await fixture(t);
  assert.equal((await f.control.sync(models)).synced, false);
  await assert.rejects(fs.stat(f.configPath), e => e.code === 'ENOENT'); await assert.rejects(fs.stat(f.statePath), e => e.code === 'ENOENT');
  const raw = '{ "models": [], "keep": "unchanged whitespace" }';
  await fs.mkdir(dirname(f.configPath), { recursive: true }); await fs.writeFile(f.configPath, raw);
  assert.equal((await f.control.setMode('native')).changed, false); assert.equal(await fs.readFile(f.configPath, 'utf8'), raw);
  await assert.rejects(fs.stat(f.statePath), e => e.code === 'ENOENT');
});

test('client model names use the configured source prefix once and prefix updates keep model IDs stable', async t => {
  const f = await fixture(t, { models: [], availableModels: ['built-in'] });
  const model = { id: 'remote/home/Claude-opus', name: 'Bifröst · Claude Opus' };
  await f.control.setMode('gateway', { models: [model] });
  assert.equal((await f.read()).models[0].name, model.name);
  await f.control.sync([{ ...model, name: 'Home · Claude Opus' }]);
  const after = await f.read();
  assert.equal(after.models[0].name, 'Home · Claude Opus'); assert.equal(after.models[0].id, model.id);
  assert.deepEqual(after.availableModels, ['built-in', model.id]);
  assert.equal(after.models[0].vendor, 'Bifröst');
});

test('sync updates and removes only owned models, respects explicit negative capabilities and is idempotent', async t => {
  const f = await fixture(t, { models: [{ id: 'foreign', apiKey: 'PRIVATE' }], availableModels: [] });
  await f.control.setMode('gateway', { models });
  const before = await fs.readFile(f.configPath), stateBefore = await fs.readFile(f.statePath);
  assert.equal((await f.control.sync(models)).changed, false);
  assert.deepEqual(await fs.readFile(f.configPath), before); assert.deepEqual(await fs.readFile(f.statePath), stateBefore);
  const replacement = [{ id: 'CodeBuddy-new', name: 'New', supportsToolCall: true, capabilities: { tools: { support: false } } }];
  await f.control.sync(replacement);
  assert.deepEqual((await f.read()).models.map(m => m.id), ['foreign', 'CodeBuddy-new']);
  assert.equal((await f.read()).models[1].supportsToolCall, false);
  assert.deepEqual((await f.read()).availableModels, []);
  await f.control.sync([{ id: 'B-tools', name: 'Native tool bridge', adapterCapabilities: { tools: true } }]);
  assert.equal((await f.read()).models[1].supportsToolCall, true, 'A known client-tool adapter can accept tool calls without asserting a model verification');
  await f.control.sync([{ id: 'B-tools', name: 'Explicitly unsupported model', adapterCapabilities: { tools: true }, capabilities: { tools: { support: false } } }]);
  assert.equal((await f.read()).models[1].supportsToolCall, false, 'An explicit source denial takes precedence over adapter support');
});

test('native removes a file created only for the bridge but retains later unrelated user additions', async t => {
  const f = await fixture(t);
  await f.control.setMode('gateway', { models }); await f.control.setMode('native');
  await assert.rejects(fs.stat(f.configPath), e => e.code === 'ENOENT');
  await f.control.setMode('gateway', { models });
  const data = await f.read(); data.userField = 'retained'; await fs.writeFile(f.configPath, JSON.stringify(data));
  await f.control.setMode('native'); assert.deepEqual(await f.read(), { userField: 'retained' });
});

test('taking ownership again records the current baseline rather than deleting a later user-created file', async t => {
  const f = await fixture(t); await f.control.setMode('gateway', { models }); await f.control.setMode('native');
  await fs.writeFile(f.configPath, JSON.stringify({ models: [] }));
  await f.control.setMode('gateway', { models }); await f.control.setMode('native');
  assert.deepEqual(await f.read(), { models: [] });
});

test('unowned ID conflicts and malformed files fail without changing configuration', async t => {
  const f = await fixture(t, { models: [{ id: 'B-model', name: 'Foreign definition' }], keep: true }), before = await fs.readFile(f.configPath);
  await assert.rejects(f.control.setMode('gateway', { models }), e => e.code === 'client_model_id_conflict');
  assert.deepEqual(await fs.readFile(f.configPath), before); await assert.rejects(fs.stat(f.statePath), e => e.code === 'ENOENT');
  for (const raw of ['{bad json', '[]', '{"models":{}}', '{"models":[{"id":"x"},{"id":"x"}]}']) {
    await fs.writeFile(f.configPath, raw);
    await assert.rejects(f.control.setMode('gateway', { models }), e => e.code === 'client_config_invalid');
    assert.equal(await fs.readFile(f.configPath, 'utf8'), raw);
  }
});

test('external edits to bridge-owned entries or filter IDs are never overwritten and inspect returns no secrets', async t => {
  const f = await fixture(t, { availableModels: ['native'] }); await f.control.setMode('gateway', { models });
  const data = await f.read(); data.models[0].name = 'User edited'; data.models[0].apiKey = 'OTHER-PRIVATE';
  await fs.writeFile(f.configPath, JSON.stringify(data)); const raw = await fs.readFile(f.configPath);
  const status = await f.control.inspect(); assert.equal(status.mode, 'conflict'); assert.doesNotMatch(JSON.stringify(status), /OTHER-PRIVATE|owner-gateway-KEY|apiKey/);
  await assert.rejects(f.control.setMode('native'), e => e.code === 'client_config_conflict');
  await assert.rejects(f.control.sync(models), e => e.code === 'client_config_conflict'); assert.deepEqual(await fs.readFile(f.configPath), raw);
});

test('configuration write failure rolls back the private ownership state without changing existing bytes', async t => {
  const f = await fixture(t, '{ "keep": true }'), before = await fs.readFile(f.configPath); let fail = true;
  const control = createFileModelControl({ ...f.options, fs: { async rename(from, to) {
    if (to === f.configPath && fail) { fail = false; throw new Error('simulated disk full PRIVATE'); } return fs.rename(from, to);
  } } });
  await assert.rejects(control.setMode('gateway', { models }), e => e.code === 'client_config_write_failed' && !e.message.includes('PRIVATE'));
  assert.deepEqual(await fs.readFile(f.configPath), before); assert.equal((await control.inspect()).mode, 'native');
});

test('ownership commit failure restores the exact original configuration bytes', async t => {
  const f = await fixture(t, '{ "keep": true }'), before = await fs.readFile(f.configPath); let commits = 0;
  const control = createFileModelControl({ ...f.options, fs: { async rename(from, to) {
    if (to === f.statePath && ++commits === 2) throw new Error('state disk full'); return fs.rename(from, to);
  } } });
  await assert.rejects(control.setMode('gateway', { models }), e => e.code === 'client_config_write_failed');
  assert.deepEqual(await fs.readFile(f.configPath), before); assert.equal((await control.inspect()).mode, 'native');
});

test('a retained write-ahead journal completes a known applied configuration after recovery', async t => {
  const f = await fixture(t, '{ "keep": true }'); let states = 0, configs = 0;
  const control = createFileModelControl({ ...f.options, fs: { async rename(from, to) {
    if (to === f.statePath && ++states === 2 || to === f.configPath && ++configs === 2) throw new Error('simulated interruption');
    return fs.rename(from, to);
  } } });
  await assert.rejects(control.setMode('gateway', { models }), e => e.code === 'client_config_recovery_required');
  assert.ok(JSON.parse(await fs.readFile(f.statePath, 'utf8')).pending);
  const restarted = createFileModelControl(f.options), status = await restarted.inspect();
  assert.equal(status.mode, 'gateway'); assert.equal(status.managedModelCount, 1);
  assert.equal(JSON.parse(await fs.readFile(f.statePath, 'utf8')).pending, undefined);
  await restarted.setMode('native'); assert.deepEqual(await f.read(), { keep: true });
});

test('a racing external write is retained with the journal instead of overwritten or rolled back', async t => {
  const f = await fixture(t, { keep: 'before' }), external = '{"keep":"external edit","models":[{"id":"other"}]}'; let changed = false;
  const control = createFileModelControl({ ...f.options, fs: { async rename(from, to) {
    await fs.rename(from, to);
    if (to === f.statePath && !changed) { changed = true; await fs.writeFile(f.configPath, external); }
  } } });
  await assert.rejects(control.setMode('gateway', { models }), e => e.code === 'client_config_recovery_required');
  assert.equal(await fs.readFile(f.configPath, 'utf8'), external);
  assert.equal((await createFileModelControl(f.options).inspect()).mode, 'conflict');
  assert.ok(JSON.parse(await fs.readFile(f.statePath, 'utf8')).pending);
});

test('multiple local controllers serialize operations and never adopt an unrecorded entry', async t => {
  const f = await fixture(t), second = createFileModelControl(f.options);
  await Promise.all([f.control.setMode('gateway', { models }), second.sync([{ id: 'second', name: 'Second' }])]);
  assert.deepEqual((await f.read()).models.map(m => m.id), ['second']);
  await second.setMode('native'); await assert.rejects(fs.stat(f.configPath), e => e.code === 'ENOENT');
});

test('configuration paths with links and relative injected paths are rejected', async t => {
  const f = await fixture(t), real = join(f.root, 'real'), link = join(f.root, 'linked'); await fs.mkdir(real);
  try { await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes(error.code)) return t.skip('Host cannot create a test link'); throw error; }
  const control = createFileModelControl({ ...f.options, configPath: join(link, 'models.json') });
  await assert.rejects(control.setMode('gateway', { models }), e => e.code === 'client_config_link');
  await assert.rejects(fs.stat(join(real, 'models.json')), e => e.code === 'ENOENT');
  assert.throws(() => createFileModelControl({ ...f.options, configPath: 'relative.json' }), TypeError);
});

test('a merge exceeding the complete model limit fails before writing any recovery state', async t => {
  const f = await fixture(t, { models: Array.from({ length: 2048 }, (_, i) => ({ id: `foreign-${i}` })) });
  const before = await fs.readFile(f.configPath);
  await assert.rejects(f.control.setMode('gateway', { models }), e => e.code === 'client_config_limit');
  assert.deepEqual(await fs.readFile(f.configPath), before);
  await assert.rejects(fs.stat(f.statePath), e => e.code === 'ENOENT');
  assert.equal((await f.control.inspect()).mode, 'native');
});

test('a merge exceeding the complete byte limit leaves the original readable file and no pending journal', async t => {
  const f = await fixture(t, { models: [], retained: 'x'.repeat(2 * 1024 * 1024 - 100) }), before = await fs.readFile(f.configPath);
  assert.ok(before.length < 2 * 1024 * 1024);
  await assert.rejects(f.control.setMode('gateway', { models }), e => e.code === 'client_config_limit');
  assert.deepEqual(await fs.readFile(f.configPath), before);
  await assert.rejects(fs.stat(f.statePath), e => e.code === 'ENOENT');
  assert.equal((await f.control.inspect()).mode, 'native');
});
