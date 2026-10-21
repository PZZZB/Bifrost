import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeCodeBuddyCatalog } from '../src/codebuddy-catalog.mjs';

const now = Date.UTC(2026, 9, 19, 10);
const opus = { id: 'claude-opus-5.5', name: 'Claude-Opus-5.5', credits: 'x2.17' };
const ownEntry = (data = {}) => ({ userId: 'owned-employee', ts: now - 60000,
  data: { models: [opus], ...data } });

async function fixture(t, entries, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.vscdb');
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
  database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('Tencent-Cloud.coding-copilot',
    JSON.stringify({ cloud_product_config_cache: entries, ...extra }));
  database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('secret://native-auth', 'must-never-be-read');
  database.close();
  return { path, reader: new NativeCodeBuddyCatalog({ databasePath: path, now: () => now }) };
}

test('reads only owned model metadata and leaves the native database unchanged', async t => {
  const { reader, path } = await fixture(t, [
    { ...ownEntry(), userId: 'another-account', data: { models: [{ id: 'wrong-model', name: 'wrong' }] } },
    ownEntry({ models: [{ ...opus, apiKey: 'never-export', headers: { Authorization: 'never-export' } }],
      authentication: { accessToken: 'never-export' } }),
  ], { authentication: { accessToken: 'never-export' } });
  const before = await readFile(path);
  const result = await reader.load({ identity: { uid: 'owned-employee' } });
  assert.deepEqual(result, { models: [opus], source: 'native-cache', savedAt: now - 60000, liveVerified: false });
  assert.equal(JSON.stringify(result).includes('never-export'), false);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(reader.load({ identity: { uid: 'unknown-account' } }), { code: 'native_catalog_owner_missing' });
});

test('keeps disabled flags and joins only matching promotion metadata', async t => {
  const { reader } = await fixture(t, [ownEntry({ models: [{ ...opus, disabled: true, available: false, enabled: false,
    error: { token: 'never-export' }, disabledReason: 'never-export' }], modelPromotions: [
    { id: 'owned-promotion', name: 'catalog offer', modelIds: [opus.id], enabled: true,
      discount: { discountedCredits: 2, factor: 0.9, apiKey: 'never-export' }, apiKey: 'never-export' },
    { id: 'unrelated-promotion', modelIds: ['another-model'], discount: { discountedCredits: 0 } },
  ] })]);
  const result = await reader.load({ identity: { uid: 'owned-employee' } });
  assert.deepEqual(result.models, [{ ...opus, disabled: true, available: false, enabled: false, error: true,
    disabledReason: true, promotions: [{ id: 'owned-promotion', name: 'catalog offer', enabled: true,
      discount: { discountedCredits: 2, factor: 0.9 } }] }]);
  assert.equal(JSON.stringify(result).includes('never-export'), false);
});

test('rejects old, future, duplicate-owner and malformed native catalogs', async t => {
  for (const entries of [
    [{ ...ownEntry(), ts: now - 30 * 24 * 60 * 60 * 1000 }],
    [{ ...ownEntry(), ts: now + 300001 }],
    [ownEntry(), ownEntry()],
    [ownEntry({ models: [{ ...opus, available: 'true' }] })],
    [ownEntry({ models: Array.from({ length: 513 }, () => opus) })],
  ]) {
    const { reader } = await fixture(t, entries);
    await assert.rejects(reader.load({ identity: { uid: 'owned-employee' } }), error =>
      ['native_catalog_expired', 'native_catalog_owner_missing', 'invalid_native_catalog'].includes(error.code));
  }
});

test('nested values in promotion price fields cannot export unselected metadata', async t => {
  const { reader } = await fixture(t, [ownEntry({ modelPromotions: [
    { id: 'offer', modelIds: [opus.id], discount: {
      discountedCredits: { apiKey: 'fixture-private-marker' }, factor: { apiKey: 'fixture-private-marker' },
    } },
  ] })]);
  const result = await reader.load({ identity: { uid: 'owned-employee' } });
  assert.deepEqual(result.models[0].promotions, [{ id: 'offer' }]);
  assert.equal(JSON.stringify(result).includes('fixture-private-marker'), false);
});

test('cancellation and missing cache never create a database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codebuddy-catalog-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'absent.vscdb');
  const reader = new NativeCodeBuddyCatalog({ databasePath: path });
  await assert.rejects(reader.load({ identity: { uid: 'owned-employee' }, signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(reader.load({ identity: { uid: 'owned-employee' } }), { code: 'native_catalog_unavailable' });
  await assert.rejects(access(path), { code: 'ENOENT' });
});
