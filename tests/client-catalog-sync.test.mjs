import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codeBuddyClient } from '../src/clients/codebuddy.mjs';
import { publicClientModel } from '../src/client-model-catalog.mjs';
import { reconcileClientFile } from '../src/client-config-file.mjs';
import { startClientCatalogSync } from '../src/runtime/client-sync.mjs';
import { configureClientSync, validateClientSync, clientCatalogUrl } from '../src/runtime/client-sync-config.mjs';
import { writePrivateAccountRecord } from '../src/private-account-files.mjs';

const apiKey = 'fixture-key-not-real-'.repeat(3), baseUrl = 'https://gateway.example.test/v1';
const source = id => ({ id, name: id, protocols: ['chat-completions'], capabilities: { toolCalls: true, inputModalities: ['text','image'], contextWindow: 100000 } });
const entries = (...ids) => codeBuddyClient.fileModels(ids.map(source), { baseUrl, apiKey });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-client-sync-'));t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, targetFile: join(dir, 'models.json'), stateFile: join(dir, 'managed.json') };
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('CodeBuddy projection uses fixed gateway paths, exact IDs and bounded source-owned capabilities', () => {
  const models = codeBuddyClient.fileModels([{ ...source('remote/x/Claude-sonnet'), apiKey: 'PRIVATE', url: 'https://attacker.invalid' },
    { id: 'messages-only', protocols: ['messages'] }], { baseUrl, apiKey });
  assert.equal(models.length, 1);assert.equal(models[0].id, 'remote/x/Claude-sonnet');assert.equal(models[0].url, baseUrl + '/chat/completions');
  assert.equal(models[0].supportsToolCall, true);assert.equal(models[0].supportsImages, true);assert.equal(models[0].maxInputTokens, 100000);
  assert.doesNotMatch(JSON.stringify(models), /PRIVATE|attacker/);
  const unknown = codeBuddyClient.fileModels([{ id: 'unknown', protocols: ['chat-completions'] }], { baseUrl, apiKey })[0];
  assert.equal(unknown.supportsImages, false);assert.equal(unknown.supportsToolCall, false);
});

test('public discovery adds only safe names, protocols and capability data, separating basic tools from parallel tools', () => {
  const model = publicClientModel({ id: 'Claude-sonnet', name: 'Claude Sonnet', protocols: ['chat-completions'], email: 'PRIVATE',
    capabilities: { contextWindow: { support: true, tokens: 1000000 }, tools: { adapterSupport: true }, images: { support: true },
      reasoning: { support: true, efforts: ['low','high'] }, apiKey: 'PRIVATE' } });
  assert.equal(model.capabilities.contextWindow, 1000000);assert.equal(model.capabilities.toolCalls, true);
  assert.equal(model.capabilities.parallelToolCalls, undefined);assert.deepEqual(model.capabilities.inputModalities, ['text','image']);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE|apiKey|email/);
});

test('automatic add/remove preserves other models, root settings and existing availability filters', async t => {
  const f = await fixture(t), custom = { id: 'my-own-model', name: 'Manual', apiKey: 'PRIVATE_OTHER_KEY' };
  await writePrivateAccountRecord(f.targetFile, { models: [custom], availableModels: ['my-own-model'], extra: { user: true } });
  let result = await reconcileClientFile({ ...f, models: entries('one','two') });assert.equal(result.changed, true);
  let target = await json(f.targetFile);assert.deepEqual(target.models[0], custom);assert.deepEqual(target.extra, { user: true });
  assert.deepEqual(target.availableModels, ['my-own-model','one','two']);
  await reconcileClientFile({ ...f, models: entries('two','three') });target = await json(f.targetFile);
  assert.deepEqual(target.models.map(m => m.id), ['my-own-model','two','three']);assert.deepEqual(target.models[0], custom);
  await reconcileClientFile({ ...f, models: [] });assert.deepEqual((await json(f.targetFile)).models, [custom]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|fixture-key/);assert.doesNotMatch(await readFile(f.stateFile, 'utf8'), /PRIVATE|fixture-key/);
});

test('an unchanged catalog does not rewrite configuration or disturb the client selection', async t => {
  const f = await fixture(t);await reconcileClientFile({ ...f, models: entries('one') });let writes = 0;
  const result = await reconcileClientFile({ ...f, models: entries('one'), write: async (...args) => { writes++;return writePrivateAccountRecord(...args); } });
  assert.equal(result.changed, false);assert.equal(writes, 0);
});

test('manual edits/deletions and ID collisions remain untouched with an explicit conflict status', async t => {
  const f = await fixture(t);await writePrivateAccountRecord(f.targetFile, { models: [{ id: 'collision', apiKey: 'USER_KEY' }] });
  await reconcileClientFile({ ...f, models: entries('collision','edited','deleted') });const edited = await json(f.targetFile);
  edited.models.find(m => m.id === 'edited').name = 'User edit';edited.models = edited.models.filter(m => m.id !== 'deleted');
  await writePrivateAccountRecord(f.targetFile, edited);
  const result = await reconcileClientFile({ ...f, models: entries('collision','edited','deleted') });
  assert.equal(result.conflictCount, 3);assert.deepEqual(await json(f.targetFile), edited);
});

test('a crash between target and journal commit is recovered without duplicate entries', async t => {
  const f = await fixture(t);let journalWrites = 0;
  await assert.rejects(reconcileClientFile({ ...f, models: entries('one'), write: async (path, record) => {
    if (path === f.stateFile && ++journalWrites === 2) throw new Error('disk full');return writePrivateAccountRecord(path, record);
  } }));
  assert.ok((await json(f.stateFile)).pending);assert.equal((await json(f.targetFile)).models.length, 1);
  await reconcileClientFile({ ...f, models: entries('one','two') });
  assert.deepEqual((await json(f.targetFile)).models.map(m => m.id), ['one','two']);assert.equal((await json(f.stateFile)).pending, null);
});

test('interrupted watched-file writes recover from a private intent, while unrelated invalid edits remain untouched', async t => {
  const f = await fixture(t), models = entries('one');models[0].name = '自动同步验证';
  await writePrivateAccountRecord(f.targetFile, { models: [] });
  await assert.rejects(reconcileClientFile({ ...f, models, writeTarget: async (path, body) => {
    const bytes = Buffer.from(body), firstChineseByte = bytes.indexOf(Buffer.from('自'));
    await writeFile(path, bytes.subarray(0, firstChineseByte + 1));throw new Error('Interrupted');
  } }));
  assert.ok((await json(f.stateFile)).pending);await reconcileClientFile({ ...f, models });
  assert.equal((await json(f.targetFile)).models[0].name, '自动同步验证');
  await assert.rejects(readFile(f.stateFile + '.recovery.json'), error => error.code === 'ENOENT');
  await assert.rejects(reconcileClientFile({ ...f, models: entries('one','two'), writeTarget: async path => {
    await writeFile(path, 'USER INVALID DRAFT');throw new Error('Concurrent edit');
  } }));
  await assert.rejects(reconcileClientFile({ ...f, models: entries('one','two') }), /client_sync_recovery_conflict/);
  assert.equal(await readFile(f.targetFile, 'utf8'), 'USER INVALID DRAFT');
});

test('watched model updates preserve file identity for the native client watcher', async t => {
  const f = await fixture(t);await reconcileClientFile({ ...f, models: entries('one') });
  const { stat } = await import('node:fs/promises');const before = await stat(f.targetFile);
  await reconcileClientFile({ ...f, models: entries('one','two') });const after = await stat(f.targetFile);
  assert.equal(after.ino, before.ino);assert.equal(after.dev, before.dev);
});

test('a concurrent user edit detected before replacement is preserved on retry', async t => {
  const f = await fixture(t);await writePrivateAccountRecord(f.targetFile, { models: [] });
  await assert.rejects(reconcileClientFile({ ...f, models: entries('one'), write: async (path, record) => {
    await writePrivateAccountRecord(path, record);
    if (path === f.stateFile && record.pending) await writePrivateAccountRecord(f.targetFile, { models: [{ id: 'user-added' }] });
  } }), /client_sync_target_changed/);
  await reconcileClientFile({ ...f, models: entries('one') });
  assert.deepEqual((await json(f.targetFile)).models.map(m => m.id), ['user-added','one']);
});

test('invalid files and symlinks are rejected without rewriting the target', async t => {
  const f = await fixture(t);await writeFile(f.targetFile, '{invalid');
  await assert.rejects(reconcileClientFile({ ...f, models: entries('one') }));assert.equal(await readFile(f.targetFile, 'utf8'), '{invalid');
  if (process.platform !== 'win32') {
    const link = join(f.dir, 'link-models.json');await symlink(f.targetFile, link);
    await assert.rejects(reconcileClientFile({ ...f, targetFile: link, models: entries('one') }));
  }
});

test('sync configuration rejects credential-bearing URLs, redirects by design and unsafe client targets', async t => {
  for (const url of ['http://company.lan/v1','https://user:secret@example.test/v1','https://example.test/v1?key=x','https://example.test/other']) assert.throws(() => clientCatalogUrl(url));
  const f = await fixture(t), p = { id: 'codebuddy', client: 'codebuddy', enabled: true, baseUrl, credentialRef: randomUUID(), targetFile: f.targetFile, intervalMs: 30000 };
  assert.throws(() => validateClientSync({ version: 1, profiles: [p,p] }));assert.throws(() => validateClientSync({ version: 1, profiles: [{ ...p, apiKey }] }));
  assert.throws(() => validateClientSync({ version: 1, profiles: [{ ...p, targetFile: 'relative/models.json' }] }));
  let saved;
  await configureClientSync({ stateDir: f.dir, baseUrl, targetFile: f.targetFile, apiKey,
    credentialStore: () => ({ save: value => { saved = value; } }) });
  assert.equal(saved.apiKey, apiKey);assert.doesNotMatch(await readFile(join(f.dir, 'client-sync.json'), 'utf8'), /fixture-key/);
});

test('running synchronizer discovers new profiles and models without restart, retaining last good files on failure', async t => {
  const f = await fixture(t);let at = Date.now(), current = [source('one')], fail = false;const calls = [];
  const service = await startClientCatalogSync({ stateDir: f.dir, now: () => at, pollMs: 100000,
    credentialStore: () => ({ load: async () => ({ version: 1, apiKey, baseUrl }) }), fetchImpl: async (url, options) => {
      calls.push({ url, options });return fail ? new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }) : Response.json({ data: current });
    } });t.after(() => service.close());await service.refresh();
  await configureClientSync({ stateDir: f.dir, baseUrl, targetFile: f.targetFile, apiKey, credentialStore: () => ({ save() {} }) });
  await service.refresh({ force: true });assert.deepEqual((await json(f.targetFile)).models.map(m => m.id), ['one']);
  current.push(source('two'));at += 30001;await service.refresh();assert.deepEqual((await json(f.targetFile)).models.map(m => m.id), ['one','two']);
  const lastGood = await readFile(f.targetFile, 'utf8');fail = true;at += 30001;await service.refresh();
  assert.equal(await readFile(f.targetFile, 'utf8'), lastGood);assert.equal(service.status()[0].state, 'unavailable');
  assert.ok(calls.every(c => c.url === baseUrl + '/models' && c.options.redirect === 'manual' && c.options.headers.authorization === `Bearer ${apiKey}`));
  assert.doesNotMatch(JSON.stringify(service.status()), /fixture-key|attacker/);
  const configFile = join(f.dir, 'client-sync.json'), config = await json(configFile), beforeTamper = calls.length;
  config.profiles[0].baseUrl = 'https://attacker.invalid/v1';await writePrivateAccountRecord(configFile, config);await service.refresh({ force: true });
  assert.equal(calls.length, beforeTamper, 'A changed source must not receive an existing encrypted credential');
  config.profiles[0].baseUrl = baseUrl;await writePrivateAccountRecord(configFile, config);
  fail = false;current = [];at += 30001;await service.refresh();assert.deepEqual((await json(f.targetFile)).models, []);
  config.profiles[0].enabled = false;await writePrivateAccountRecord(configFile, config);await service.refresh({ force: true });
  assert.deepEqual(service.status(), []);assert.deepEqual((await json(join(f.dir, 'client-sync-status.json'))).profiles, []);
});
