import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelPolicy } from '../src/model-policy.mjs';
import { ModelDiscovery } from '../src/model-discovery.mjs';
import { gatedAccountService } from '../src/upstream-accounts.mjs';
import { appendCursorModels } from '../src/models.mjs';
import { cursorModelAvailability } from '../src/cursor-service.mjs';

const legacyCB = 'claude-codebuddy-opus-5-5', legacyCU = 'Cursor-gemini-4-argon';
const tick = () => new Promise(resolve => setImmediate(resolve));
const cbModels = () => [{ id: legacyCB, name: 'CodeBuddy Opus 5.5', upstream: 'opus-source', available: true, source: 'native-cache' },
  { id: 'CodeBuddy-new-model', name: 'CodeBuddy New model', upstream: 'new-model', available: true, source: 'native-cache' },
  { id: 'CodeBuddy-image-model', name: 'CodeBuddy Image', upstream: 'image-model', available: false, reason: '图像生成尚未适配。', source: 'native-cache' }];
const cuModels = () => [{ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' }, { id: 'new-sdk-model', displayName: 'New SDK model' }];
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-model-discovery-')), path = join(directory, 'policy.json');
  const policy = await ModelPolicy.open({ path });
  await policy.observe({ models: [{ id: legacyCB, name: 'CodeBuddy Opus 5.5' }, { id: legacyCU, name: 'Cursor Gemini 4' }, { id: 'original-A', name: 'Original A' }] });
  const calls = { cb: 0, cu: 0 };
  const cb = { enabled: true, authorizationVersion: 0, getModels: async () => { calls.cb++; return cbModels(); } };
  const cu = { enabled: true, authorizationVersion: 0, getModels: async () => { calls.cu++; return cuModels(); } };
  const discovery = new ModelDiscovery({ modelPolicy: policy, codeBuddyService: cb, cursorService: cu, ...options });
  t.after(async () => { await discovery.close(); await rm(directory, { recursive: true, force: true }); });
  return { policy, discovery, cb, cu, calls, directory, path };
}

test('account gating preserves live authorization epochs and rejects a catalog from the previous login', async t => {
  let epoch = 1, enabled = true, resolveRead, calls = 0;
  const reading = new Promise(resolve => { resolveRead = resolve; });
  const service = { enabled: true, get authorizationVersion() { return epoch; },
    getModels: async () => { calls++; return reading; } };
  const gated = gatedAccountService(service, () => enabled);
  const { policy, discovery } = await fixture(t, { codeBuddyService: gated, cursorService: null });
  const pending = discovery.refresh(); await tick(); epoch++;
  resolveRead(cbModels()); await pending;
  assert.equal(policy.snapshot().models.find(m => m.id === legacyCB).available, false);
  assert.equal(discovery.snapshot().discovery.CodeBuddy.state, 'error');
  assert.equal(gated.authorizationVersion, 2);
  enabled = false; await discovery.refresh(); assert.equal(calls, 1);
});

test('management discovery includes full source catalogs while preserving legacy selections and defaulting new models off', async t => {
  const { policy, discovery, calls, path } = await fixture(t);
  const snapshot = await discovery.refresh();
  assert.deepEqual(calls, { cb: 1, cu: 1 }); assert.equal(snapshot.models.length, 6);
  assert.equal(snapshot.models.find(model => model.id === legacyCB).enabled, true);
  assert.equal(snapshot.models.find(model => model.id === legacyCU).enabled, true);
  for (const id of ['CodeBuddy-new-model', 'CodeBuddy-image-model', 'Cursor-new-sdk-model']) assert.equal(snapshot.models.find(model => model.id === id).enabled, false);
  assert.equal(snapshot.models.find(model => model.id === 'CodeBuddy-image-model').available, false);
  assert.deepEqual([snapshot.discovery.CodeBuddy.count, snapshot.discovery.Cursor.count], [3, 2]);
  const raw = await readFile(path, 'utf8');
  for (const forbidden of ['upstream', 'available', 'reason', 'source', 'native-cache']) assert.equal(raw.includes(`"${forbidden}"`), false);
  assert.throws(() => policy.assertEnabled('CodeBuddy-new-model'), error => error.code === 'model_disabled');
  const disabled = snapshot.disabledModels.filter(id => id !== 'CodeBuddy-new-model');
  await policy.update({ revision: snapshot.revision, disabledModels: disabled });
  assert.equal(policy.assertEnabled('CodeBuddy-new-model'), true);
  await discovery.refresh(); assert.equal(policy.assertEnabled('CodeBuddy-new-model'), true);
});

test('directory refresh bypasses CodeBuddy metadata caching and keeps newly discovered models disabled', async t => {
  const { discovery, cb } = await fixture(t);
  let reads = 0;
  cb.getModels = async ({ signal, force }) => {
    assert.equal(force, true);
    assert.equal(signal.aborted, false);
    return [...cbModels(), ...(reads++ ? [{ id: 'CodeBuddy-kimi-k3.1-pro', name: 'CodeBuddy Kimi K3.1 Pro',
      upstream: 'kimi-k3.1-pro', available: true, source: 'remote' }] : [])];
  };
  const initial = await discovery.refresh();
  assert.equal(initial.models.some(model => model.id === 'CodeBuddy-kimi-k3.1-pro'), false);
  const refreshed = await discovery.refresh();
  const added = refreshed.models.find(model => model.id === 'CodeBuddy-kimi-k3.1-pro');
  assert.equal(added.available, true);
  assert.equal(added.enabled, false);
  assert.equal(added.source, 'remote');
});

test('partial catalog failure preserves switches and safe cached names without blocking another channel', async t => {
  const { policy, discovery, cu } = await fixture(t);
  const before = await discovery.refresh(), saved = [...before.disabledModels];
  cu.getModels = async () => { throw new Error('PRIVATE_TOKEN https://private.invalid/path'); };
  const after = await discovery.refresh();
  assert.deepEqual(after.disabledModels, saved); assert.equal(after.discovery.CodeBuddy.state, 'ready');
  assert.equal(after.discovery.Cursor.state, 'error');
  assert.equal(after.models.find(model => model.id === legacyCU).enabled, true);
  assert.equal(after.models.find(model => model.id === legacyCU).available, false);
  assert.equal(JSON.stringify(after).includes('PRIVATE_TOKEN'), false); assert.equal(JSON.stringify(after).includes('private.invalid'), false);
  cu.getModels = async () => cuModels(); await discovery.refresh(); assert.equal(policy.assertEnabled(legacyCU), true);
});

test('catalog timeout aborts only the slow metadata read and simultaneous web refreshes coalesce', async t => {
  const { discovery, cb, calls } = await fixture(t, { timeoutMs: 20 });
  let aborted = false;
  cb.getModels = ({ signal }) => {
    calls.cb++; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); return new Promise(() => {});
  };
  const pending = discovery.refresh(), same = discovery.refresh(); assert.equal(pending, same);
  const snapshot = await pending;
  assert.equal(aborted, true); assert.equal(snapshot.discovery.CodeBuddy.state, 'error');
  assert.equal(snapshot.discovery.Cursor.state, 'ready'); assert.deepEqual(calls, { cb: 1, cu: 1 });
});

test('a completed catalog cannot be applied after its account changes while the other channel is still loading', async t => {
  const { discovery, cb, cu, policy } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  cb.getModels = async () => { await gate; return cbModels(); };
  const pending = discovery.refresh(); await tick();
  cu.authorizationVersion++; release();
  const result = await pending;
  assert.equal(result.discovery.Cursor.state, 'error');
  assert.equal(result.models.find(model => model.id === legacyCU).available, false);
  assert.equal(result.models.some(model => model.id === 'Cursor-new-sdk-model'), false);
  assert.throws(() => policy.assertEnabled(legacyCU), error => error.code === 'model_unavailable');
});

test('shutdown cancels metadata reads and never applies a late directory result', async t => {
  const { discovery, cb, cu, policy } = await fixture(t, { timeoutMs: 60000 });
  cb.getModels = cu.getModels = () => new Promise(() => {});
  const initial = policy.snapshot(), pending = discovery.refresh(); await tick(); await discovery.close(); await pending;
  assert.deepEqual(policy.snapshot(), initial); assert.deepEqual(discovery.snapshot().discovery, {});
});

test('duplicate or malformed channel metadata fails independently and cannot register another channel alias', async t => {
  const { discovery, cb } = await fixture(t);
  cb.getModels = async () => [{ id: 'Cursor-spoofed', name: 'Fake', available: true }];
  const snapshot = await discovery.refresh();
  assert.equal(snapshot.discovery.CodeBuddy.state, 'error'); assert.equal(snapshot.discovery.Cursor.state, 'ready');
  assert.equal(snapshot.models.some(model => model.id === 'Cursor-spoofed'), false);
});

test('a channel that changes during the other policy commit loses its ready count and all effective availability', async t => {
  const { discovery, cb, policy } = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const observe = policy.observe.bind(policy);
  policy.observe = async (...args) => { if (args[1] === 'Cursor') { entered(); await gate; } return observe(...args); };
  const pending = discovery.refresh(); await started; cb.authorizationVersion++; release();
  const result = await pending;
  assert.equal(result.discovery.CodeBuddy.state, 'error'); assert.equal(result.discovery.CodeBuddy.count, 0);
  assert.equal(result.models.filter(model => model.channel === 'CodeBuddy').every(model => model.available === false), true);
  assert.throws(() => policy.assertEnabled(legacyCB), error => error.code === 'model_unavailable');
});

test('discovery forwards safe source capabilities and the actual Cursor prompt mode without proving inference', async t => {
  const { discovery, cb, cu, path } = await fixture(t);
  cb.getModels = async () => [{ id: legacyCB, name: 'CodeBuddy Opus', upstream: 'opus-source', available: true,
    slug: 'Cursor-must-not-be-registered',
    source: 'native-cache', inputModalities: ['text', 'image'], supportsReasoning: true, efforts: ['high', 'xhigh'], defaultEffort: 'high', contextWindow: 300000,
    apiKey: 'PRIVATE_KEY', model_messages: { instructions_template: 'PRIVATE_PROMPT' } }];
  cu.promptMode = 'project-rules';
  cu.getModels = async () => [{ id: 'gemini-4-argon', displayName: 'SDK model', supportsImages: false, contextWindow: 500000,
    parameters: [{ id: 'effort', values: [{ value: 'medium' }, { value: 'high' }] }] }];
  const snapshot = await discovery.refresh(), codeBuddy = snapshot.models.find(model => model.id === legacyCB), cursor = snapshot.models.find(model => model.id === legacyCU);
  assert.equal(codeBuddy.capabilities.contextWindow.tokens, 300000); assert.deepEqual(codeBuddy.capabilities.reasoning.efforts, ['high', 'xhigh']);
  assert.equal(cursor.capabilities.images.support, false); assert.equal(cursor.capabilities.contextWindow.tokens, 500000);
  assert.deepEqual(cursor.capabilities.reasoning.efforts, ['medium', 'high']); assert.equal(cursor.compatibility.mode, 'project-rules');
  assert.equal(cursor.verification.state, 'unverified'); assert.equal(codeBuddy.verification.state, 'unverified');
  assert.equal(snapshot.models.some(model => model.id === 'Cursor-must-not-be-registered'), false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  const raw = await readFile(path, 'utf8'); assert.equal(raw.includes('capabilities'), false); assert.equal(raw.includes('verification'), false);
});

test('management and native Cursor catalogs keep canonical names and a stable settings revision', async t => {
  const { policy, discovery, cb, cu, path } = await fixture(t);
  const sources = [{ id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', contextWindow: 1000000,
    supportsImages: true, parameters: [{ id: 'effort', values: [{ value: 'medium' }, { value: 'high' }] }] },
  { id: 'new-sdk-model', displayName: 'New SDK model' }];
  cb.getModels = async () => cbModels().map(model => ({ ...model, contextWindow: 300000,
    contextWindowOptions: [300000, 600000, 1000000], maxInputTokens: 1000000 }));
  cu.getModels = async () => structuredClone(sources); cu.promptMode = 'project-rules';
  await discovery.refresh();
  await policy.update({ revision: policy.snapshot().revision, disabledModels: policy.snapshot().disabledModels,
    contextWindows: { [legacyCB]: 600000 } });
  const before = policy.snapshot(), bytes = await readFile(path, 'utf8');
  assert.equal(before.models.find(model => model.id === legacyCU).name, 'Cursor Gemini 4 Argon');
  assert.equal(before.models.find(model => model.id === 'Cursor-new-sdk-model').name, 'Cursor New SDK model');
  for (let iteration = 0; iteration < 3; iteration++) {
    // Match Gateway.catalog's authoritative Cursor entries and merged Codex view.
    await policy.observe({ models: sources.map(source => ({ id: `Cursor-${source.id}`,
      name: `Cursor ${source.displayName}`, ...cursorModelAvailability(source), source: 'account-catalog' })) },
    'Cursor', { defaultEnabled: false, authorizationVersion: cu.authorizationVersion });
    await policy.observe(appendCursorModels({ models: [] }, sources));
    const after = await discovery.refresh();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.models, before.models);
    assert.deepEqual(after.disabledModels, before.disabledModels);
    assert.deepEqual(after.contextWindows, { [legacyCB]: 600000 });
  }
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(policy.snapshot().models.find(model => model.id === legacyCU).compatibility.mode, 'project-rules');
});

test('canonical discovery names ignore conflicting display aliases without losing source capabilities or name fallbacks', async t => {
  const { policy, discovery, cb, cu } = await fixture(t);
  const codeBuddy = { id: legacyCB, name: 'CodeBuddy source name', available: true, source: 'remote',
    display_name: 'Wrong preferred alias', displayName: 'Wrong SDK alias', label: 'Wrong label', contextWindow: 600000 };
  const cursor = [{ id: 'gemini-4-argon', displayName: 'SDK model', display_name: 'Wrong native alias',
    label: 'Wrong label', name: 'Other source name', contextWindow: 1000000 },
  { id: 'new-sdk-model', name: 'SDK name fallback', label: 'Wrong label' }];
  const untouched = structuredClone({ codeBuddy, cursor });
  cb.getModels = async () => [codeBuddy]; cu.getModels = async () => cursor;
  const snapshot = await discovery.refresh();
  assert.equal(snapshot.models.find(model => model.id === legacyCB).name, 'CodeBuddy source name');
  assert.equal(snapshot.models.find(model => model.id === legacyCU).name, 'Cursor SDK model');
  assert.equal(snapshot.models.find(model => model.id === 'Cursor-new-sdk-model').name, 'SDK name fallback');
  assert.equal(snapshot.models.find(model => model.id === legacyCB).capabilities.contextWindow.tokens, 600000);
  assert.equal(snapshot.models.find(model => model.id === legacyCU).capabilities.contextWindow.tokens, 1000000);
  assert.deepEqual({ codeBuddy, cursor }, untouched);
  cu.authorizationVersion++;
  assert.equal(policy.snapshot().models.find(model => model.id === legacyCU).available, false);
  await discovery.refresh();
  assert.equal(policy.snapshot().models.find(model => model.id === legacyCU).available, true);
  assert.equal(policy.snapshot().models.find(model => model.id === legacyCU).name, 'Cursor SDK model');
});
