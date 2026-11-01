import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelPolicy } from '../src/model-policy.mjs';
import { BridgeError } from '../src/storage.mjs';

const A = 'gpt-original-fixture', B = 'B-gpt-6-astra', CB = 'claude-codebuddy-opus-5-5';
const catalog = () => ({ catalog_version: 'original', metadata: { order: ['unchanged'] }, models: [
  { slug: A, display_name: 'Original model', priority: 9, context_window: 240000,
    model_messages: { instructions_template: 'Private provider instructions' } },
  { slug: B, display_name: 'B model', priority: 10 },
  { slug: CB, display_name: 'CodeBuddy Opus 5.5', priority: 11 },
] });
const isError = (status, code) => error => error instanceof BridgeError && error.status === status && error.code === code;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-model-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'models.json');
  return { directory, path, policy: await ModelPolicy.open({ path }) };
}

test('a missing policy starts with all models enabled, including unseen original models', async t => {
  const { policy, path } = await fixture(t);
  assert.equal(policy.snapshot().available, true);
  assert.equal(policy.snapshot().discoveryOnly, true);
  assert.equal(policy.snapshot().revision, 0);
  assert.deepEqual(policy.snapshot().disabledModels, []);
  await assert.rejects(access(path), error => error.code === 'ENOENT');
  const original = catalog();
  assert.deepEqual(policy.filterCatalog(original), original);
  assert.equal(policy.assertEnabled('new-original-model-not-discovered'), true);
});

test('observation persists only safe public names and actual adapter ids, preserving channel ownership', async t => {
  const { policy, path } = await fixture(t);
  const original = catalog();
  original.auth = { access_token: 'must-not-persist-auth' };
  original.models[0].api_key = 'must-not-persist-key';
  original.models[0].channel = 'B';
  original.models[1].channel = 'A';
  original.models[2].channel = 'A';
  original.models.push({ id: 'Cursor-adapter-supplied-id', label: 'Adapter supplied model', channel: 'A' });
  const snapshot = await policy.observe(original, 'A');
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.models.map(({ id, channel }) => [id, channel]), [[A, 'A'], [B, 'B'], [CB, 'CodeBuddy'], ['Cursor-adapter-supplied-id', 'Cursor']]);
  assert.equal(snapshot.models.at(-1).name, 'Adapter supplied model');
  assert.equal(snapshot.models.filter(model => model.channel !== 'Cursor').every(model => model.enabled), true);
  assert.equal(snapshot.models.at(-1).enabled, false);
  const raw = await readFile(path, 'utf8'), saved = JSON.parse(raw);
  assert.deepEqual(Object.keys(saved).sort(), ['disabledModels', 'models', 'revision', 'version']);
  assert.equal(saved.models.every(model => Object.keys(model).sort().join(',') === 'channel,id,name'), true);
  for (const privateText of ['access_token', 'api_key', 'must-not-persist', 'Private provider instructions', 'context_window']) assert.equal(raw.includes(privateText), false);
  assert.equal(snapshot.models.some(model => /gemini|grok/i.test(model.id)), false);
});

test('only explicitly disabled entries are removed from full catalogs without modifying metadata or order', async t => {
  const { policy } = await fixture(t);
  await policy.observe(catalog());
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [B] });
  const original = catalog();
  original.models.push({ slug: 'previously-unseen-original', display_name: 'Still enabled', extra: { fields: ['keep'] } });
  const before = structuredClone(original), filtered = policy.filterCatalog(original);
  assert.deepEqual(filtered.models, [original.models[0], original.models[2], original.models[3]]);
  assert.equal(filtered.catalog_version, original.catalog_version);
  assert.deepEqual(filtered.metadata, original.metadata);
  filtered.metadata.order.push('changed'); filtered.models[0].model_messages.instructions_template = 'changed';
  assert.deepEqual(original, before);
  assert.throws(() => policy.assertEnabled(B), isError(400, 'model_disabled'));
  assert.equal(policy.assertEnabled(A), true);
  assert.equal(policy.assertEnabled('previously-unseen-original'), true);
});

test('disabled models survive restart, catalog disappearance, and later reappearance', async t => {
  const { policy, path } = await fixture(t);
  await policy.observe(catalog());
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [CB] });
  await policy.observe({ models: [{ slug: A, display_name: 'Renamed original' }] });
  const reopened = await ModelPolicy.open({ path });
  assert.equal(reopened.snapshot().available, true);
  assert.equal(reopened.snapshot().models.find(model => model.id === A).name, 'Renamed original');
  assert.equal(reopened.snapshot().models.find(model => model.id === CB).enabled, false);
  assert.throws(() => reopened.assertEnabled(CB), isError(400, 'model_disabled'));
  assert.equal(reopened.filterCatalog(catalog()).models.some(model => model.slug === CB), false);
  await reopened.observe(catalog());
  assert.throws(() => reopened.assertEnabled(CB), isError(400, 'model_disabled'));
});

test('unchanged observations and set-equivalent updates do not write files or increase revisions', async t => {
  const { policy, path } = await fixture(t);
  await policy.observe(catalog());
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [A, B] });
  const before = policy.snapshot(), old = new Date('2000-01-01T00:00:00Z');
  await utimes(path, old, old);
  const beforeStat = await stat(path);
  await policy.observe(catalog());
  await policy.observe({ models: [] });
  await policy.update({ revision: before.revision, disabledModels: [B, A] });
  assert.deepEqual(policy.snapshot(), before);
  assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs);
});

test('revision compare-and-swap serializes simultaneous updates and does not poison the queue after rejection', async t => {
  const { policy, path } = await fixture(t);
  await policy.observe(catalog());
  const revision = policy.snapshot().revision;
  const outcomes = await Promise.allSettled([
    policy.update({ revision, disabledModels: [A] }),
    policy.update({ revision, disabledModels: [B] }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(isError(409, 'model_policy_conflict')(outcomes[1].reason), true);
  assert.deepEqual(policy.snapshot().disabledModels, [A]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).disabledModels, [A]);
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [] });
  assert.equal(policy.assertEnabled(A), true);
});

test('observation changes participate in revision checks and queued inputs are copied immediately', async t => {
  const { policy } = await fixture(t);
  await policy.observe(catalog());
  const revision = policy.snapshot().revision;
  await policy.observe({ models: [{ slug: A, display_name: 'Updated public label' }] });
  await assert.rejects(policy.update({ revision, disabledModels: [A] }), isError(409, 'model_policy_conflict'));
  const input = { revision: policy.snapshot().revision, disabledModels: [A] };
  const updating = policy.update(input);
  input.revision = 0; input.disabledModels.push(B);
  await updating;
  assert.deepEqual(policy.snapshot().disabledModels, [A]);
});

test('strict updates reject unknown ids, duplicate ids, malformed payloads and excess fields without changing policy', async t => {
  const { policy } = await fixture(t);
  await policy.observe(catalog());
  const before = policy.snapshot(), revision = before.revision;
  const invalid = [null, [], {}, { revision }, { revision, disabledModels: 'all' },
    { revision: -1, disabledModels: [] }, { revision: 1.5, disabledModels: [] }, { revision: String(revision), disabledModels: [] },
    { revision, disabledModels: ['not-discovered'] }, { revision, disabledModels: [A, A] },
    { revision, disabledModels: ['a'.repeat(257)] }, { revision, disabledModels: ['bad\nmodel'] },
    { revision, disabledModels: [], auth: 'must-not-persist' }, { revision, disabledModels: [], enabledModels: [A] }];
  for (const input of invalid) await assert.rejects(policy.update(input), isError(400, 'invalid_model_policy'));
  assert.deepEqual(policy.snapshot(), before);
});

test('the disabled set accepts 2048 known ids and rejects 2049 without weakening existing switches', async t => {
  const { policy } = await fixture(t);
  const ids = Array.from({ length: 2049 }, (_, index) => `original-${index}`);
  await policy.observe({ models: ids.map(id => ({ slug: id, display_name: id })) });
  await policy.update({ revision: policy.snapshot().revision, disabledModels: ids.slice(0, 2048) });
  const before = policy.snapshot();
  await assert.rejects(policy.update({ revision: before.revision, disabledModels: ids }), isError(400, 'invalid_model_policy'));
  assert.deepEqual(policy.snapshot(), before);
  assert.equal(policy.assertEnabled(ids[2048]), true);
  assert.throws(() => policy.assertEnabled(ids[2047]), isError(400, 'model_disabled'));
});

test('a failed atomic replacement leaves the last successfully persisted in-memory switches intact', async t => {
  const { policy, path, directory } = await fixture(t);
  await policy.observe(catalog());
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [B] });
  const before = policy.snapshot(), saved = await readFile(path, 'utf8'), originalPath = join(directory, 'last-successful.json');
  await rename(path, originalPath);
  await mkdir(path);
  await assert.rejects(policy.update({ revision: before.revision, disabledModels: [A] }), isError(503, 'model_policy_write_failed'));
  assert.deepEqual(policy.snapshot(), before);
  assert.equal(await readFile(originalPath, 'utf8'), saved);
  assert.equal(policy.assertEnabled(A), true);
  assert.throws(() => policy.assertEnabled(B), isError(400, 'model_disabled'));
  await assert.rejects(policy.observe({ models: [{ slug: 'new-model' }] }), isError(503, 'model_policy_write_failed'));
  assert.deepEqual(policy.snapshot(), before);
});

test('corrupt or unreadable policies become a feature error without throwing during service startup', async t => {
  const { path, directory } = await fixture(t);
  const base = { version: 1, revision: 2, disabledModels: [A], models: [{ id: A, name: 'Original', channel: 'A' }] };
  const invalid = ['{broken', 'null', '[]', '', Buffer.from([0xff, 0xfe]),
    JSON.stringify({ ...base, version: 99 }), JSON.stringify({ ...base, access_token: 'must-not-disclose' }),
    JSON.stringify({ ...base, revision: -1 }), JSON.stringify({ ...base, disabledModels: ['unknown'] }),
    JSON.stringify({ ...base, disabledModels: [A, A] }),
    JSON.stringify({ ...base, models: [base.models[0], base.models[0]] }),
    JSON.stringify({ ...base, models: [{ id: B, name: 'Spoofed B', channel: 'A' }], disabledModels: [] }),
    JSON.stringify({ ...base, models: [{ ...base.models[0], instructions: 'must-not-disclose' }] })];
  for (const body of invalid) {
    await writeFile(path, body);
    const policy = await ModelPolicy.open({ path });
    const snapshot = policy.snapshot();
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.error.code, 'model_policy_unavailable');
    assert.equal(JSON.stringify(snapshot).includes('must-not-disclose'), false);
    assert.throws(() => policy.filterCatalog(catalog()), isError(503, 'model_policy_unavailable'));
    assert.throws(() => policy.assertEnabled('unknown'), isError(503, 'model_policy_unavailable'));
    await assert.rejects(policy.update({ revision: 0, disabledModels: [] }), isError(503, 'model_policy_unavailable'));
    await assert.rejects(policy.observe(catalog()), isError(503, 'model_policy_unavailable'));
  }
  assert.equal((await ModelPolicy.open({ path: directory })).snapshot().available, false);
});

test('invalid observed metadata cannot hide an unseen original model or replace a safe existing label', async t => {
  const { policy } = await fixture(t);
  await policy.observe(catalog());
  const original = { models: [null, { slug: A, display_name: 'bad\nlabel' }, { slug: 'a'.repeat(513) },
    { slug: 'unknown-original', display_name: 'Safe unknown', auth: { token: 'must-not-persist' } }] };
  const result = await policy.observe(original);
  assert.equal(result.models.find(model => model.id === A).name, 'Original model');
  assert.equal(result.models.some(model => model.id.length > 512), false);
  assert.deepEqual(policy.filterCatalog(original), original);
  await assert.rejects(policy.observe(catalog(), 'Arbitrary channel'), isError(400, 'invalid_model_policy'));
  await assert.rejects(policy.observe({ data: [] }), isError(400, 'invalid_model_policy'));
});

test('snapshots are isolated copies and a constructor without open cannot bypass the saved policy', async t => {
  const { policy, path } = await fixture(t);
  await policy.observe(catalog());
  const snapshot = policy.snapshot();
  snapshot.models[0].enabled = false; snapshot.models[0].name = 'changed'; snapshot.disabledModels.push(A);
  assert.equal(policy.snapshot().models[0].name, 'Original model');
  assert.equal(policy.assertEnabled(A), true);
  const unopened = new ModelPolicy({ path });
  assert.equal(unopened.snapshot().available, false);
  assert.throws(() => unopened.assertEnabled(A), isError(503, 'model_policy_unavailable'));
});

test('new external models remain disabled through every observation entry point, including an A cache', async t => {
  const { policy, path } = await fixture(t);
  assert.throws(() => policy.assertEnabled('Cursor-new-model'), isError(400, 'model_disabled'));
  await policy.observe({ models: [{ id: 'Cursor-new-model', name: 'From A cache' }, { id: 'CodeBuddy-new-model', name: 'From A cache' }] }, 'A');
  assert.equal(policy.snapshot().models.every(model => !model.enabled), true);
  assert.equal(policy.snapshot().models.every(model => ['Cursor', 'CodeBuddy'].includes(model.channel)), true);
  await policy.observe({ models: [{ id: 'Cursor-new-model', name: 'From actual account' }] }, 'Cursor', { defaultEnabled: false });
  await policy.update({ revision: policy.snapshot().revision, disabledModels: ['CodeBuddy-new-model'] });
  assert.equal(policy.assertEnabled('Cursor-new-model'), true);
  const reopened = await ModelPolicy.open({ path });
  assert.equal(reopened.assertEnabled('Cursor-new-model'), true);
  assert.throws(() => reopened.assertEnabled('CodeBuddy-new-model'), isError(400, 'model_disabled'));
});

test('source unavailability stays separate from saved switches and cannot enable a new unavailable model', async t => {
  const { policy, path } = await fixture(t);
  const id = 'Cursor-catalog-model';
  await policy.observe({ models: [{ id, name: 'Catalog model', available: true, source: 'remote' }] }, 'Cursor', { defaultEnabled: false, complete: true });
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [] });
  const unavailable = await policy.observe({ models: [] }, 'Cursor', { complete: true });
  assert.equal(unavailable.models[0].enabled, true); assert.equal(unavailable.models[0].available, false);
  assert.throws(() => policy.assertEnabled(id), isError(403, 'model_unavailable'));
  await policy.update({ revision: unavailable.revision, disabledModels: [id] });
  await assert.rejects(policy.update({ revision: policy.snapshot().revision, disabledModels: [] }), isError(400, 'invalid_model_policy'));
  await policy.observe({ models: [{ id, name: 'Catalog model', available: true }] }, 'Cursor', { complete: true });
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [] });
  assert.equal(policy.assertEnabled(id), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.models[0]).sort(), ['channel', 'id', 'name']);
});

test('model availability follows the current authorization even during another channel write', async t => {
  const { policy, path } = await fixture(t), id = 'Cursor-version-bound';
  let version = 0; policy.setAuthorizationVersionGetter('Cursor', () => version);
  const models = [{ id, name: 'Version bound', available: true }];
  await policy.observe({ models }, 'Cursor', { authorizationVersion: 0 });
  await policy.update({ revision: policy.snapshot().revision, disabledModels: [] });
  assert.equal(policy.assertEnabled(id), true);
  version++;
  assert.equal(policy.snapshot().models[0].available, false);
  assert.throws(() => policy.assertEnabled(id), isError(403, 'model_unavailable'));
  const revision = policy.snapshot().revision;
  await policy.observe({ models }, 'Cursor', { authorizationVersion: 0 });
  assert.equal(policy.snapshot().revision, revision); assert.equal(policy.snapshot().models[0].available, false);
  await policy.observe({ models }, 'Cursor', { authorizationVersion: 1 });
  assert.equal(policy.assertEnabled(id), true);
  assert.equal(JSON.stringify(policy.snapshot()).includes('authorizationVersion'), false);
  assert.equal((await readFile(path, 'utf8')).includes('authorizationVersion'), false);
});

test('capabilities are detached runtime metadata and never enter the persisted switch schema or native payload', async t => {
  const { policy, path } = await fixture(t), original = catalog(), before = structuredClone(original);
  original.models[0].input_modalities = ['text', 'image'];
  original.models[0].supports_tools = true;
  await policy.observe(original);
  const row = policy.snapshot().models.find(model => model.id === A);
  assert.equal(row.capabilities.images.support, true); assert.equal(row.capabilities.contextWindow.tokens, 240000);
  assert.equal(row.verification.state, 'unverified');
  row.capabilities.images.support = false; row.capabilities.reasoning.efforts.push('max');
  assert.equal(policy.snapshot().models.find(model => model.id === A).capabilities.images.support, true);
  assert.deepEqual(policy.filterCatalog(original), original); assert.deepEqual(before.models[0].model_messages, original.models[0].model_messages);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.models.every(model => Object.keys(model).sort().join(',') === 'channel,id,name'), true);
  assert.equal(JSON.stringify(saved).includes('capabilities'), false); assert.equal(JSON.stringify(saved).includes('verification'), false);
  const reopened = await ModelPolicy.open({ path });
  assert.equal(reopened.snapshot().models.find(model => model.id === A).capabilities.contextWindow.tokens, null);
  assert.equal(reopened.snapshot().models.find(model => model.id === A).verification.state, 'unverified');
});

test('real verification is scoped to an observed model and current authorization without inferring unsupported features', async t => {
  const { policy, path } = await fixture(t), id = 'CodeBuddy-verification-model';
  let version = 1; policy.setAuthorizationVersionGetter('CodeBuddy', () => version);
  await policy.observe({ models: [{ id, name: 'Observed model', available: true, supportsImages: true, source: 'native-cache' }] },
    'CodeBuddy', { authorizationVersion: version });
  const record = { model: id, account: 'CodeBuddy', authorizationVersion: 1, outcome: 'passed',
    time: '2026-10-23T01:00:00.000Z', completed: true, pendingTools: false, kind: 'plain' };
  assert.equal(policy.snapshot().models[0].enabled, false); assert.equal(policy.snapshot().models[0].verification.state, 'unverified');
  assert.equal(policy.recordVerification({ ...record, completed: false }), false);
  assert.equal(policy.recordVerification({ ...record, pendingTools: true }), false);
  assert.equal(policy.recordVerification({ ...record, account: 'A' }), false);
  assert.equal(policy.recordVerification(record), true); assert.equal(policy.snapshot().models[0].verification.state, 'passed');
  assert.equal(policy.recordVerification({ ...record, outcome: 'failed', category: 'network', error: 'PRIVATE_ERROR', time: '2026-10-23T02:00:00.000Z' }), true);
  assert.equal(policy.snapshot().models[0].verification.state, 'failed'); assert.equal(policy.snapshot().models[0].capabilities.images.support, true);
  assert.match(policy.snapshot().models[0].verification.reason, /网络错误/);
  assert.equal(policy.recordVerification(record), false, 'An earlier completion cannot replace the later observed outcome.');
  version++;
  assert.equal(policy.snapshot().models[0].verification.state, 'unverified'); assert.equal(policy.snapshot().models[0].capabilities.images.support, null);
  assert.equal(policy.recordVerification({ ...record, authorizationVersion: 2 }), false);
  await policy.observe({ models: [{ id, name: 'Observed model', available: true, supportsImages: false }] }, 'CodeBuddy', { authorizationVersion: 2 });
  assert.equal(policy.recordVerification({ ...record, authorizationVersion: 1 }), false);
  assert.equal(policy.recordVerification({ ...record, authorizationVersion: 2 }), true);
  assert.equal(policy.snapshot().models[0].capabilities.images.support, false);
  assert.equal(JSON.stringify(policy.snapshot()).includes('PRIVATE_ERROR'), false);
  assert.equal((await readFile(path, 'utf8')).includes('gateway-observed-call'), false);
});

test('account-bound native capability metadata never changes passthrough or invents a verified account', async t => {
  const { policy } = await fixture(t), original = catalog();
  let version = 'native-account-one';
  policy.setAuthorizationVersionGetter('A', () => version);
  await policy.observe(original);
  const record = { model: A, account: 'A', authorizationVersion: version, outcome: 'passed',
    time: '2026-10-23T02:00:00.000Z', completed: true, pendingTools: false };
  assert.equal(policy.recordVerification(record), true);
  version = 'native-account-two';
  const row = policy.snapshot().models.find(model => model.id === A);
  assert.equal(row.capabilities.contextWindow.tokens, null); assert.equal(row.verification.state, 'unverified');
  assert.equal(policy.assertEnabled(A), true); assert.deepEqual(policy.filterCatalog(original), original);
  assert.equal(policy.recordVerification(record), false);
});

test('client alias summaries and later name-only observations cannot replace authoritative external capabilities', async t => {
  const { policy } = await fixture(t), id = 'Cursor-capability-model';
  policy.setAuthorizationVersionGetter('Cursor', () => 0);
  await policy.observe({ models: [{ id, name: 'SDK model', available: true, contextWindow: 500000, supportsImages: true }] },
    'Cursor', { authorizationVersion: 0, promptMode: 'project-rules' });
  await policy.observe({ models: [{ id, name: 'SDK model', available: true }] }, 'Cursor', { authorizationVersion: 0 });
  await policy.observe({ models: [{ slug: id, display_name: 'SDK model', context_window: 128000, input_modalities: ['text'] }] });
  const row = policy.snapshot().models[0];
  assert.equal(row.capabilities.images.support, true); assert.equal(row.capabilities.contextWindow.tokens, 500000);
  assert.equal(row.compatibility.mode, 'project-rules');
});

test('Claude call observations follow the authenticated account, accumulate features and clear stale context', async t => {
  const { policy } = await fixture(t); let version = 'claude-one';
  policy.setAuthorizationVersionGetter('Claude', () => version);
  const catalog = { models: [{ id: 'Claude-sonnet', name: 'Sonnet', available: true, contextWindow: 1000000, contextSource: 'official-cli-runtime' }] };
  await policy.observe(catalog, 'Claude', { authorizationVersion: version });
  const record = { model: 'Claude-sonnet', account: 'Claude', authorizationVersion: version,
    time: '2026-11-01T08:00:00Z', outcome: 'passed', completed: true, pendingTools: false,
    kind: 'tool', observed: { images: true, cache: true, privateData: 'PRIVATE' } };
  assert.equal(policy.recordVerification({ ...record, pendingTools: true }), false);
  assert.equal(policy.recordVerification(record), true);
  assert.equal(policy.recordVerification({ ...record, time: '2026-11-01T08:00:01Z', kind: 'plain', observed: { images: false, cache: false } }), true);
  let row = policy.snapshot().models.find(m => m.id === 'Claude-sonnet');
  assert.deepEqual(row.verification.observed, { images: true, tools: true, cache: true });
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|claude-one/);
  version = 'claude-two'; assert.equal(policy.recordVerification(record), false);
  assert.equal(policy.snapshot().models.find(m => m.id === 'Claude-sonnet').verification.state, 'unverified');
  await policy.observe({ models: [{ id: 'Claude-sonnet', name: 'Sonnet', available: true }] }, 'Claude', { authorizationVersion: version });
  row = policy.snapshot().models.find(m => m.id === 'Claude-sonnet'); assert.equal(row.capabilities.contextWindow.tokens, null);
});
