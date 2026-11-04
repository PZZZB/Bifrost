import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { modelPresentationFor, originalModelName, presentModels } from '../src/model-presentation.mjs';
import { UpstreamAccountStore } from '../src/upstream-account-store.mjs';
import { UpstreamAccounts } from '../src/upstream-accounts.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';
import { Gateway } from '../src/gateway.mjs';
import { createFileModelControl } from '../src/clients/file-model-control.mjs';

test('display names use one source prefix and retain upstream model-family labels', () => {
  const samples = [
    ['B', 'B-GPT-6.1 Sol', 'GPT-6.1 Sol'], ['CodeBuddy', 'CodeBuddy Opus 5.5', 'Opus 5.5'],
    ['CodeBuddy', 'CodeBuddy · Kimi-K3.1-Pro', 'Kimi-K3.1-Pro'], ['Cursor', 'Cursor Gemini 4', 'Gemini 4'],
    ['Bifrost', '远端 · Bifrost · Claude Opus 5.5', 'Claude Opus 5.5'], ['A', 'GPT-6.1 Sol', 'GPT-6.1 Sol'],
  ];
  for (const [channel, name, expected] of samples) assert.equal(originalModelName({ id: 'stable-model', name, channel }), expected);
  assert.equal(originalModelName({ name: 'Claude Opus 5.5', channel: 'CodeBuddy' }), 'Claude Opus 5.5');
  assert.deepEqual(modelPresentationFor({ kind: 'codex', modelPresentation: { prefix: '', order: 2 } }),
    { prefix: '', order: 2, defaultPrefix: 'Codex B', defaultOrder: 100 });
  const source = { id: 'cb', kind: 'codebuddy', modelPresentation: { prefix: 'Work', order: 10 } };
  const raw = { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5', channel: 'CodeBuddy', enabled: false };
  const options = { accounts: [source], accountFor: () => source };
  const once = presentModels([raw], options), twice = presentModels(once, options);
  assert.equal(once[0].name, 'Work · Opus 5.5'); assert.deepEqual(twice, once);
  assert.equal(once[0].id, raw.id); assert.equal(once[0].enabled, false); assert.equal(raw.name, 'CodeBuddy · Opus 5.5');
});

test('each source stays contiguous, native models stay first, and source ties do not interleave model priorities', () => {
  const accounts = [{ id: 'b', kind: 'codex' }, { id: 'first', kind: 'bifrost', modelPresentation: { prefix: 'Home', order: 1 } },
    { id: 'second', kind: 'bifrost', modelPresentation: { prefix: 'Other', order: 1 } }, { id: 'a', kind: 'codex-client', modelPresentation: { prefix: '', order: 9999 } }];
  const models = [{ id: 'r2a', name: 'R2', source: 'second', channel: 'Bifrost', priority: 0 },
    { id: 'native-slow', name: 'Native slow', source: 'a', channel: 'A', priority: 20 },
    { id: 'b', name: 'B-GPT-6.1 Sol', source: 'b', channel: 'B', priority: 21 },
    { id: 'r1a', name: 'R1A', source: 'first', channel: 'Bifrost', priority: 8 },
    { id: 'r2b', name: 'R2B', source: 'second', channel: 'Bifrost', priority: 1 },
    { id: 'r1b', name: 'R1B', source: 'first', channel: 'Bifrost', priority: 0 },
    { id: 'native-fast', name: 'Native fast', source: 'a', channel: 'A', priority: 10 }];
  const accountFor = (_channel, id) => accounts.find(account => account.id === models.find(model => model.id === id).source);
  const output = presentModels(models, { accounts, accountFor, codex: true });
  assert.deepEqual(output.map(model => model.id), ['native-fast', 'native-slow', 'r1b', 'r1a', 'r2a', 'r2b', 'b']);
  assert.deepEqual(output.map(model => model.priority), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(models.map(model => model.priority), [0, 20, 21, 8, 1, 0, 10]);
});

test('long valid Unicode prefixes publish usable client labels without truncating a surrogate pair or changing IDs', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-presentation-length-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const account = { id: 'home', kind: 'bifrost', modelPresentation: { prefix: '🌈'.repeat(48), order: 1 } };
  const raw = { id: 'remote/home/Claude-opus', channel: 'Bifrost', name: 'x'.repeat(158) + '🌈' + 'y'.repeat(30) };
  const options = { accounts: [account], accountFor: () => account };
  const projected = presentModels([raw], options), codex = presentModels([raw], { ...options, codex: true });
  assert.equal(projected[0].name, codex[0].display_name);
  assert.ok(projected[0].name.length <= 256); assert.ok(projected[0].name.endsWith('…'));
  assert.equal(projected[0].name.isWellFormed(), true); assert.equal(projected[0].originalName, raw.name);
  const configPath = join(directory, 'client-models.json');
  const control = createFileModelControl({ id: 'codebuddy', name: 'CodeBuddy', configPath, statePath: join(directory, 'owned.json'),
    gatewayUrl: 'http://127.0.0.1:43155/owner/v1/chat/completions', gatewayKey: 'local-fixture-key' });
  await control.setMode('gateway', { models: projected });
  const { readFile } = await import('node:fs/promises');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.models[0].id, raw.id); assert.equal(saved.models[0].name, projected[0].name);
});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-model-presentation-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await UpstreamAccountStore.open({ stateDir: directory, seeds: [
    { kind: 'codex', name: 'B subscription' }, { kind: 'codebuddy', name: 'Employee' }, { kind: 'cursor', name: 'Cursor user' },
    { kind: 'codex-client', name: 'A caller' }] });
  for (const id of ['home', 'second']) await store.setRemote({ id, kind: 'bifrost-remote', baseUrl: 'https://remote.example.invalid/v1',
    protocols: ['responses'], credentialRef: randomUUID() }, id);
  const policy = await ModelPolicy.open({ path: join(directory, 'model-policy.json') });
  const remotes = ['home', 'second'].flatMap(id => [{ id: `remote/${id}/Claude-opus`, name: '远端 · Bifrost · Claude Opus',
    source: { id, location: 'remote' }, protocols: ['responses', 'chat-completions'] },
  { id: `remote/${id}/Claude-sonnet`, name: '远端 · Bifrost · Claude Sonnet', source: { id, location: 'remote' }, protocols: ['responses'] }]);
  const sources = { models: () => remotes, model: id => remotes.find(m => m.id === id), status: () => [], request: () => assert.fail('No inference in catalog test.') };
  let changes = 0;
  const manager = new UpstreamAccounts({ store, types: ['codex-client', 'codex', 'codebuddy', 'cursor', 'bifrost'], modelPolicy: policy,
    getModels: () => policy.snapshot().models, getRemotes: () => sources, onChange: () => { changes++; } });
  const nativeModels = [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', priority: 20,
    model_messages: { instructions_template: 'Preserve native instructions verbatim' }, context_window: 256000 },
  { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', priority: 10, supported_reasoning_levels: [{ effort: 'high' }] }];
  const key = 'model-presentation-fixture-gateway-key', upstreamCalls = [];
  const gateway = new Gateway({ gatewayKey: key, modelPolicy: policy, remoteSources: sources,
    backend: { credentials: async () => ({ value: 'fake-b-credential', accountId: 'workspace-b' }) },
    getAProvider: async () => ({ config: { base_url: 'https://native-a.example.invalid/codex' } }),
    fetchImpl: async (url, options) => { upstreamCalls.push({ url, options }); return Response.json({ catalog_version: 'native', models: nativeModels }); },
    getCodeBuddyModels: async () => [{ id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy Opus 5.5' }],
    codeBuddyProvider: { request: () => assert.fail('No inference'), status: async () => ({ ready: true, authenticated: true, modelAvailable: true }) },
    cursorProvider: { request: () => assert.fail('No inference'), status: async () => ({ ready: true, authenticated: true, modelAvailable: true }) },
    getCursorModels: async () => [{ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' }],
    presentCatalog: data => manager.presentCodexCatalog(data), sourceEnabled: (channel, model) => manager.allows(channel, model) });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) { res.writeHead(500); res.end(error.message); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const catalog = async () => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/backend-api/codex/models?client_version=0.166.0`,
      { headers: { authorization: 'Bearer fake-a-credential', 'x-account-bridge-key': key } });
    assert.equal(result.status, 200); return result.json();
  };
  return { store, manager, policy, gateway, sources, remotes, nativeModels, catalog, upstreamCalls, changes: () => changes };
}

test('published Codex catalogs honor configured prefixes and source order without changing IDs, metadata or saved model choices', async t => {
  const f = await fixture(t); let catalog = await f.catalog();
  // Discover optional provider models before explicitly opening them, like the management page.
  let settings = f.policy.snapshot(); await f.policy.update({ revision: settings.revision, disabledModels: [] });
  catalog = await f.catalog();
  const ids = catalog.models.map(m => m.slug);
  assert.deepEqual(ids, ['gpt-6-astra', 'gpt-6.1-sol', 'B-gpt-6-astra', 'B-gpt-6.1-sol', 'claude-codebuddy-opus-5-5',
    'Cursor-gemini-4-argon', 'remote/home/Claude-opus', 'remote/home/Claude-sonnet', 'remote/second/Claude-opus', 'remote/second/Claude-sonnet']);
  assert.equal(catalog.models.find(m => m.slug === 'B-gpt-6.1-sol').display_name, 'Codex B · GPT-6.1 Sol');
  assert.equal(catalog.models.find(m => m.slug === 'claude-codebuddy-opus-5-5').display_name, 'CodeBuddy · Opus 5.5');
  assert.equal(catalog.models.find(m => m.slug === 'remote/home/Claude-opus').display_name, 'Bifröst · Claude Opus');
  assert.deepEqual(catalog.models.map(m => m.priority), ids.map((_, index) => index));
  const b = f.store.snapshot().accounts.find(a => a.kind === 'codex'), home = f.store.snapshot().accounts.find(a => a.kind === 'bifrost' && a.binding.sourceId === 'home');
  const policyBefore = f.policy.snapshot();
  await f.manager.update(b.id, { revision: f.store.snapshot().revision, modelPresentation: { prefix: 'Team', order: 250 } });
  const updated = await f.manager.update(home.id, { revision: f.store.snapshot().revision, modelPresentation: { prefix: 'Home', order: 1 } });
  assert.equal(updated.restartRequired, false); assert.equal(f.changes(), 2);
  catalog = await f.catalog();
  assert.deepEqual(catalog.models.map(m => m.slug), ['gpt-6-astra', 'gpt-6.1-sol', 'remote/home/Claude-opus', 'remote/home/Claude-sonnet',
    'claude-codebuddy-opus-5-5', 'B-gpt-6-astra', 'B-gpt-6.1-sol', 'Cursor-gemini-4-argon', 'remote/second/Claude-opus', 'remote/second/Claude-sonnet']);
  assert.equal(catalog.models.find(m => m.slug === 'B-gpt-6.1-sol').display_name, 'Team · GPT-6.1 Sol');
  assert.equal(catalog.models.find(m => m.slug === 'remote/home/Claude-opus').display_name, 'Home · Claude Opus');
  const native = catalog.models.find(m => m.slug === 'gpt-6.1-sol');
  assert.deepEqual(native.model_messages, f.nativeModels[0].model_messages); assert.equal(native.context_window, 256000);
  assert.equal(catalog.catalog_version, 'native');
  assert.deepEqual(f.policy.snapshot(), policyBefore, 'Presentation must not overwrite observed raw names, switches or policy revisions.');
  const named = f.manager.catalog();
  assert.equal(named.find(m => m.id === 'B-gpt-6.1-sol').name, 'Team · GPT-6.1 Sol');
  assert.equal(named.find(m => m.id === 'remote/home/Claude-opus').originalName, 'Claude Opus');
  assert.deepEqual(f.manager.presentModels(named), named, 'Client sync must not add the prefix twice.');
});

test('separate remote accounts keep separate display settings and changing an account name does not alter model prefixes', async t => {
  const f = await fixture(t); await f.catalog();
  const row = f.store.snapshot().accounts.find(a => a.kind === 'bifrost');
  await f.manager.update(row.id, { revision: f.store.snapshot().revision, modelPresentation: { prefix: '', order: 10 } });
  await f.manager.update(row.id, { revision: f.store.snapshot().revision, name: 'Changed source label' });
  const data = await f.manager.snapshot();
  assert.equal(data.capabilities.modelPresentation, true);
  assert.equal(data.models.find(m => m.id === 'remote/home/Claude-opus').name, 'Claude Opus');
  assert.equal(data.models.find(m => m.id === 'remote/home/Claude-opus').sourceAccountName, 'Changed source label');
  assert.equal(data.models.find(m => m.id === 'remote/second/Claude-opus').name, 'Bifröst · Claude Opus');
  assert.deepEqual(data.accounts.find(a => a.id === row.id).modelPresentation, { prefix: '', order: 10, defaultPrefix: 'Bifröst', defaultOrder: 600 });
  const reopened = await UpstreamAccountStore.open({ stateDir: f.store.directory });
  assert.deepEqual(reopened.snapshot(), f.store.snapshot());
});

test('offline remotes keep saved presentation ownership and stable grouping without becoming usable', async t => {
  const f = await fixture(t); await f.catalog();
  const home = f.store.snapshot().accounts.find(a => a.kind === 'bifrost' && a.binding.sourceId === 'home');
  await f.manager.update(home.id, { revision: f.store.snapshot().revision, modelPresentation: { prefix: 'Home', order: 1 } });
  f.manager.getRemotes = () => null;
  const historical = [f.remotes[0], f.remotes[2], f.remotes[1], f.remotes[3]]
    .map(model => ({ ...model, channel: 'Bifrost' }));
  const presented = f.manager.presentModels(historical);
  assert.deepEqual(presented.map(model => model.id), ['remote/home/Claude-opus', 'remote/home/Claude-sonnet',
    'remote/second/Claude-opus', 'remote/second/Claude-sonnet']);
  assert.equal(presented[0].name, 'Home · Claude Opus'); assert.equal(presented[2].name, 'Bifröst · Claude Opus');
  const catalog = f.manager.catalog().filter(model => model.channel === 'Bifrost');
  assert.equal(catalog.length, 4); assert.ok(catalog.every(model => model.available === false));
  assert.equal(catalog[0].sourceAccountId, home.id);
  assert.equal(f.manager.allows('Bifrost', catalog[0].id), false);
  assert.equal(f.manager.presentationAccountFor('Bifrost', 'remote/home-extra/Claude-opus'), null);
});

test('a status read held across a presentation save keeps its original revision instead of overwriting the new result', async t => {
  const f = await fixture(t); await f.catalog();
  const account = f.store.snapshot().accounts.find(a => a.kind === 'codex');
  const beforeRevision = f.store.snapshot().revision;
  let release, entered; const held = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { entered = resolve; });
  let firstRead = true;
  f.manager.readers.codex = async () => {
    if (firstRead) { firstRead = false; entered(); await held; }
    return { configured: true, bound: true };
  };
  const pending = f.manager.snapshot(); await reading;
  const updated = await f.manager.update(account.id, { revision: beforeRevision, modelPresentation: { prefix: 'Team', order: 1 } });
  release(); const old = await pending;
  assert.equal(old.revision, beforeRevision); assert.equal(updated.revision, beforeRevision + 1);
  assert.equal(old.accounts.find(a => a.id === account.id).modelPresentation.prefix, 'Codex B');
  assert.equal(updated.accounts.find(a => a.id === account.id).modelPresentation.prefix, 'Team');
  assert.equal(old.models.find(m => m.channel === 'B').name.startsWith('Codex B · '), true);
  assert.equal(updated.models.find(m => m.channel === 'B').name.startsWith('Team · '), true);
});
