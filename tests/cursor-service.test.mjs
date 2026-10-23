import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { CURSOR_MODELS, cursorEffortParameter, resolveCursorModel, startCursorService } from '../src/cursor-service.mjs';

const EPOCH = 1800000000000;
const SECRET = 'mock-cursor-key-private-do-not-export';
const credential = (apiKey = SECRET) => ({ version: 1, provider: 'cursor', apiKey,
  apiKeyExpiresAtMs: EPOCH + 3600000, email: 'mock@example.test' });
const catalog = () => [
  { id: 'grok-4.7', displayName: 'Grok 4.7', privateToken: SECRET,
    parameters: [{ id: 'effort', values: [{ value: 'high', displayName: 'High' }, { value: 'xhigh' }] }],
    variants: [{ params: [{ id: 'effort', value: 'xhigh' }], displayName: 'Grok 4.7 Max', isDefault: false, isMaxMode: true }] },
  { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', parameters: [{ id: 'effort', values: [{ value: 'medium' }, { value: 'high' }] }] },
  { id: 'auto', displayName: 'Auto' },
  { id: 'gemini-3.1-pro', displayName: 'Gemini 4' },
  { id: 'gemini-4-argon-unverified', displayName: 'Gemini 4 Argon' },
  { id: 'grok-4.7-fast', displayName: 'Grok 4.7 Fast' },
  { id: 'grok-4.6', displayName: 'Grok 4.6' },
];
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await nextTick(); }
  assert.fail('The background metadata/login operation did not settle.');
}
async function fixture(t, { initial = null, config, loginImpl, modelImpl, meImpl, storeOverrides = {},
  sdkLoader: loadOverride, ...options } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-cursor-service-'));
  if (config !== undefined) await writeFile(join(stateDir, 'cursor.json'), JSON.stringify(config));
  let record = structuredClone(initial), clock = EPOCH;
  const calls = { load: 0, save: [], clear: 0, sdk: 0, models: [], me: [], logins: [] }, waits = [];
  const store = {
    load: async () => { calls.load++; return structuredClone(record); },
    save: async value => { calls.save.push(structuredClone(value)); record = structuredClone(value); },
    clear: async () => { calls.clear++; record = null; }, ...storeOverrides,
  };
  const sdk = { Cursor: {
    auth: { login: async value => {
      calls.logins.push(value);
      if (loginImpl) return loginImpl(value);
      const wait = deferred(); waits.push(wait);
      value.onLoginUrl('https://cursor.com/loginDeepControl?uuid=mock');
      return wait.promise;
    }, logout() { assert.fail('Must never access the SDK native credential store'); },
    status() { assert.fail('Must never access the SDK native credential store'); } },
    me: async value => { calls.me.push(value); return meImpl ? meImpl(value) :
      { userId: 42, userEmail: 'mock@example.test', userFirstName: 'Mock', userLastName: 'User', accessToken: SECRET }; },
    models: { list: async value => { calls.models.push(value); return modelImpl ? modelImpl(value) : catalog(); } },
  }, Agent: { create() { assert.fail('Authorization and metadata must never infer'); },
    send() { assert.fail('Authorization and metadata must never infer'); } } };
  const service = await startCursorService({ stateDir, credentialStore: store,
    sdkLoader: async () => { calls.sdk++; return loadOverride ? loadOverride() : sdk; }, now: () => clock, ...options });
  t.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { stateDir, service, calls, waits, sdk, store, saved: () => structuredClone(record),
    advance: ms => { clock += ms; } };
}
async function finishLogin(f, index = 0, apiKey = SECRET) {
  f.waits[index].resolve({ apiKey, apiKeyExpiresAtMs: EPOCH + 3600000, email: 'mock@example.test' });
  await until(async () => (await f.service.status()).login.state === 'complete');
}

test('unconfigured Cursor stays offline and never reads native SDK credentials', async t => {
  const f = await fixture(t);
  assert.equal(f.service.enabled, false);
  assert.equal(await f.service.credential(), null);
  assert.deepEqual(await f.service.getModels(), []);
  const status = await f.service.status();
  assert.equal(status.authReady, false);
  assert.equal(status.profile, null);
  assert.equal(f.service.promptMode, 'project-rules');
  assert.equal(status.promptMode, 'project-rules');
  assert.equal(status.preservesSystemPromptPriority, false);
  assert.deepEqual(status.plan, { declared: 'Teams', verified: false });
  assert.deepEqual(status.login, { state: 'not_started' });
  assert.equal(f.calls.sdk, 0);
  assert.equal(f.calls.load, 1);
});

test('safe exact provider aliases resolve without treating legacy defaults as an availability list', () => {
  assert.deepEqual(CURSOR_MODELS.map(model => model.id), ['Cursor-gemini-4-argon', 'Cursor-grok-4.7']);
  assert.equal(resolveCursorModel('Cursor-gemini-4-argon').upstream, 'gemini-4-argon');
  for (const upstream of ['auto-smart', 'default', 'composer-2.5', 'gpt-5.3-codex', 'grok-4.6', 'future-model-v20.4', 'vendor:model']) {
    const id = `Cursor-${upstream}`;
    assert.deepEqual(resolveCursorModel(id), { id, upstream, name: `Cursor ${upstream}` });
  }
  for (const id of ['gemini-4-argon', 'cursor-grok-4.7', 'auto', null, {}, 1,
    'Cursor-', 'Cursor-../model', 'Cursor-.hidden', 'Cursor-model/name', 'Cursor-grok?key=value', 'Cursor- model',
    'Cursor-model\n', 'Cursor-model%2fname', 'Cursor-' + 'x'.repeat(161)]) {
    assert.equal(resolveCursorModel(id), null);
  }
});

test('reasoning parameters expose only exact Codex levels and never invent aliases for vendor values', () => {
  assert.equal(cursorEffortParameter({ parameters: [{ id: 'reasoning', values: [{ value: 'extra-high' }] }] }), null);
  assert.equal(cursorEffortParameter({ parameters: [{ id: 'thinking', values: [{ value: 'true' }] }] }), null);
  assert.equal(cursorEffortParameter({ parameters: [{ id: 'reasoning_effort', values: [] }] }), null);
  const parameter = { id: 'reasoning', displayName: 'Reasoning', values: [{ value: 'low' }, { value: 'extra-high' }, { value: 'high' }] };
  assert.deepEqual(cursorEffortParameter({ parameters: [parameter] }), { ...parameter, values: [{ value: 'low' }, { value: 'high' }] });
  assert.equal(parameter.values.length, 3);
  assert.equal(cursorEffortParameter({ parameters: [{ id: 'effort', values: [{ value: 'vendor-special' }] },
    { id: 'reasoning_effort', values: [{ value: 'medium' }] }] }).id, 'reasoning_effort');
});

test('official browser login mints only a bridge-owned credential without touching Cursor auth files', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.beginLogin(), { url: 'https://cursor.com/loginDeepControl?uuid=mock' });
  const options = f.calls.logins[0];
  assert.equal(options.openBrowser, false);
  assert.equal(options.store, null);
  assert.equal(options.apiKeyName, 'Bifrost');
  assert.equal(options.signal.aborted, false);
  assert.equal((await f.service.status()).login.state, 'pending');
  assert.equal(await f.service.credential(), null);
  await finishLogin(f);
  assert.equal(f.service.enabled, true);
  assert.equal(f.saved().apiKey, SECRET);
  assert.deepEqual(await f.service.credential(), { apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 });
  const config = JSON.parse(await readFile(join(f.stateDir, 'cursor.json'), 'utf8'));
  assert.deepEqual(config, { version: 1, enabled: true, declaredPlan: 'Teams', promptMode: 'project-rules' });
  assert.equal(JSON.stringify(config).includes(SECRET), false);
  const status = await f.service.status();
  assert.equal(status.authReady, true);
  assert.deepEqual(status.profile, { email: 'mock@example.test', name: 'Mock User', userId: 42 });
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test('installing a replacement credential invalidates catalogs captured while login was pending', async t => {
  const replacement = 'mock-cursor-replacement-private';
  const f = await fixture(t, { initial: credential(), config: { enabled: true },
    modelImpl: ({ apiKey }) => [{ id: apiKey === SECRET ? 'old-account-model' : 'new-account-model' }] });
  assert.equal(f.service.authorizationVersion, 0);
  await f.service.beginLogin();
  const pendingVersion = f.service.authorizationVersion;
  const pendingModels = await f.service.getModels();
  assert.equal(pendingVersion, 1);
  assert.deepEqual(pendingModels.map(model => model.id), ['old-account-model']);
  await finishLogin(f, 0, replacement);
  assert.equal(f.service.authorizationVersion, pendingVersion + 1);
  assert.equal((await f.service.credential()).apiKey, replacement);
  assert.deepEqual((await f.service.getModels()).map(model => model.id), ['new-account-model']);
  assert.deepEqual(pendingModels.map(model => model.id), ['old-account-model']);
  await f.service.logout();
  assert.equal(f.service.authorizationVersion, pendingVersion + 2);
  assert.deepEqual(await f.service.getModels(), []);
  await f.service.close();
  assert.equal(f.service.authorizationVersion, pendingVersion + 3);
});

test('explicit Cursor prompt modes survive login and logout with their advertised priority', async t => {
  for (const promptMode of ['project-rules', 'system']) {
    const f = await fixture(t, { config: { enabled: true, promptMode } });
    assert.equal(f.service.promptMode, promptMode);
    const before = await f.service.status();
    assert.equal(before.promptMode, promptMode); assert.equal(before.preservesSystemPromptPriority, promptMode === 'system');
    await f.service.beginLogin(); await finishLogin(f); await f.service.logout();
    assert.equal(JSON.parse(await readFile(join(f.stateDir, 'cursor.json'), 'utf8')).promptMode, promptMode);
    const after = await f.service.status();
    assert.equal(after.promptMode, promptMode); assert.equal(after.preservesSystemPromptPriority, promptMode === 'system');
  }
});

test('invalid prompt modes disable Cursor and cannot be repaired implicitly by authorizing or logging out', async t => {
  for (const promptMode of [null, 'SYSTEM', 'rules', true, 0, {}, [], SECRET]) {
    const f = await fixture(t, { initial: credential(), config: { enabled: true, promptMode } });
    assert.equal(f.service.enabled, false); assert.equal(f.service.promptMode, null);
    assert.equal(await f.service.credential(), null);
    await assert.rejects(f.service.getModels(), error => error.status === 503 && error.code === 'cursor_config_invalid');
    await assert.rejects(f.service.beginLogin(), error => error.status === 503 && error.code === 'cursor_config_invalid');
    const status = await f.service.status();
    assert.equal(status.configured, false); assert.equal(status.authReady, false); assert.equal(status.promptMode, null);
    assert.equal(status.preservesSystemPromptPriority, null); assert.match(status.error, /promptMode/);
    assert.equal(JSON.stringify(status).includes(SECRET), false);
    await f.service.logout(); assert.match((await f.service.status()).error, /promptMode/);
    assert.equal(f.calls.sdk, 0); assert.equal(f.calls.save.length, 0);
  }
});

test('metadata passes only this bridge user key and its explicit team context', async t => {
  const f = await fixture(t, { initial: credential(), config: { enabled: true, teamId: 123, declaredPlan: 'Enterprise', planVerified: true } });
  await f.service.getModels();
  assert.deepEqual(f.calls.models, [{ apiKey: SECRET, teamId: 123 }]);
  assert.deepEqual(f.calls.me, [{ apiKey: SECRET, teamId: 123 }]);
  assert.deepEqual((await f.service.status()).plan, { declared: 'Teams', verified: false });
  assert.equal((await f.service.credential()).teamId, 123);
});

test('catalog retains every account-visible canonical model in remote order with real parameters and variants', async t => {
  const f = await fixture(t, { initial: credential() });
  const models = await f.service.getModels();
  assert.deepEqual(models.map(model => model.id), catalog().map(model => model.id));
  assert.deepEqual(models[0].parameters, catalog()[0].parameters);
  assert.deepEqual(models[0].variants, catalog()[0].variants);
  assert.equal(JSON.stringify(models).includes(SECRET), false);
  models[0].id = 'tampered'; models[1].parameters[0].values[0].value = 'tampered';
  assert.deepEqual((await f.service.getModels()).map(model => model.id), catalog().map(model => model.id));
  assert.equal((await f.service.getModels())[1].parameters[0].values[0].value, 'medium');
});

test('display names never substitute canonical IDs or introduce models missing from the account', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => [
    { id: 'auto', displayName: 'Grok 4.7' }, { id: 'gemini-3.1-pro', displayName: 'Gemini 4 Argon' },
  ] });
  assert.deepEqual((await f.service.getModels()).map(model => model.id), ['auto', 'gemini-3.1-pro']);
  assert.deepEqual((await f.service.status()).catalog.models.map(model => model.id), ['auto', 'gemini-3.1-pro']);
});

test('full Cursor directories preserve unavailable entries and explicit negative capabilities override positive claims', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => [
    { id: 'disabled-model', available: false, reason: SECRET }, { id: 'no-tools', supportsTools: false },
    { id: 'no-stream', capabilities: { streaming: false } }, { id: 'image-output', outputModalities: ['image'] },
    { id: 'conflicting-image', supportsVision: false, supportsImages: true, inputModalities: ['text', 'image'] },
  ] });
  const models = await f.service.getModels(); assert.equal(models.length, 5);
  for (const model of models.slice(0, 4)) { assert.equal(model.available, false); assert.equal(typeof model.reason, 'string'); }
  assert.equal(models[4].supportsImages, false); assert.deepEqual(models[4].inputModalities, ['text']);
  assert.equal(JSON.stringify(models).includes(SECRET), false);
});

test('full model catalog strips private fields, unsafe IDs and secret values while preserving only explicit capabilities', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => [
    { id: 'composer-2.5', displayName: 'Composer 2.5', aliases: [SECRET], credential: SECRET,
      privateToken: SECRET, description: SECRET, supportsImages: false, supportsTools: true, supportsReasoning: 'true',
      contextWindow: 200000, maxOutputTokens: -1, inputModalities: ['text'], outputModalities: ['text', SECRET],
      capabilities: { images: false, toolCalls: true, privateToken: SECRET, custom: true },
      parameters: [{ id: 'fast', displayName: 'Fast', privateToken: SECRET,
        values: [{ value: 'false', displayName: 'Normal', token: SECRET }, { value: 'true', displayName: SECRET }] }],
      variants: [{ params: [{ id: 'fast', value: 'false', token: SECRET }], displayName: 'Composer',
        isDefault: true, isMaxMode: false, description: SECRET, token: SECRET }] },
    { id: 'plain-model', displayName: 'Plain' },
    { id: 'composer-2.5', displayName: 'Duplicate must not overwrite' },
    { id: '../unsafe' }, { id: '.unsafe' }, { id: `model-${SECRET}` },
    { id: 'secret-parameter', parameters: [{ id: SECRET, values: [{ value: 'high' }] }] },
    { id: 'secret-value', parameters: [{ id: 'effort', values: [{ value: SECRET }] }] },
    { id: 'duplicate-parameter', parameters: [{ id: 'effort', values: [{ value: 'low' }] }, { id: 'effort', values: [{ value: 'high' }] }] },
    { id: 'duplicate-value', parameters: [{ id: 'effort', values: [{ value: 'high' }, { value: 'high' }] }] },
  ] });
  const models = await f.service.getModels();
  assert.deepEqual(models, [{ id: 'composer-2.5', displayName: 'Composer 2.5',
    parameters: [{ id: 'fast', displayName: 'Fast', values: [{ value: 'false', displayName: 'Normal' }, { value: 'true' }] }],
    variants: [{ params: [{ id: 'fast', value: 'false' }], displayName: 'Composer', isDefault: true, isMaxMode: false }],
    supportsImages: false, supportsTools: true, contextWindow: 200000, inputModalities: ['text'],
    capabilities: { images: false, toolCalls: true } }, { id: 'plain-model', displayName: 'Plain' }]);
  assert.equal(Object.hasOwn(models[1], 'supportsImages'), false);
  assert.equal(JSON.stringify(await f.service.status()).includes(SECRET), false);
});

test('read-only catalog and identity calls coalesce and cache for exactly 30 seconds', async t => {
  const waiting = deferred();
  const f = await fixture(t, { initial: credential(), modelImpl: () => waiting.promise });
  const first = f.service.getModels(), second = f.service.status(), third = f.service.getModels();
  await until(() => f.calls.models.length === 1);
  waiting.resolve(catalog()); await Promise.all([first, second, third]);
  await f.service.status(); f.advance(29999); await f.service.getModels();
  assert.equal(f.calls.models.length, 1); assert.equal(f.calls.me.length, 1);
  f.advance(1); await f.service.status();
  assert.equal(f.calls.models.length, 2); assert.equal(f.calls.me.length, 2);
});

test('logout aborts pending authorization and a late successful login cannot restore credentials', async t => {
  const f = await fixture(t);
  await f.service.beginLogin();
  await f.service.logout();
  assert.equal(f.calls.logins[0].signal.aborted, true);
  f.waits[0].resolve({ apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 });
  await nextTick(); await nextTick();
  assert.equal(f.saved(), null); assert.equal(f.calls.save.length, 0);
  assert.equal(await f.service.credential(), null);
  assert.equal(f.service.enabled, false);
  assert.deepEqual((await f.service.status()).login, { state: 'not_started' });
  assert.equal(f.calls.me.length, 0); assert.equal(f.calls.models.length, 0);
});

test('logout wins even while an old login is already inside credential persistence', async t => {
  const persist = deferred(), started = deferred();
  let persisted = null;
  const f = await fixture(t, { storeOverrides: {
    save: async value => { started.resolve(); await persist.promise; persisted = structuredClone(value); },
    clear: async () => { persisted = null; },
  } });
  await f.service.beginLogin();
  f.waits[0].resolve({ apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 });
  await started.promise;
  const logout = f.service.logout();
  persist.resolve(); await logout;
  assert.equal(persisted, null);
  assert.equal(await f.service.credential(), null);
  assert.equal((await f.service.status()).login.state, 'not_started');
});

test('a second authorization aborts the first and only the latest key can be saved', async t => {
  const f = await fixture(t);
  await f.service.beginLogin(); await f.service.beginLogin();
  assert.equal(f.calls.logins[0].signal.aborted, true);
  await finishLogin(f, 1, 'mock-latest-cursor-key');
  f.waits[0].resolve({ apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 });
  await nextTick(); await nextTick();
  assert.equal(f.saved().apiKey, 'mock-latest-cursor-key');
  assert.equal(f.calls.save.length, 1);
  assert.equal((await f.service.status()).login.state, 'complete');
});

test('close aborts pending authorization without removing an existing bridge login', async t => {
  const f = await fixture(t, { initial: credential() });
  await f.service.beginLogin(); await f.service.close();
  assert.equal(f.calls.logins[0].signal.aborted, true);
  f.waits[0].resolve({ apiKey: 'mock-new-key', apiKeyExpiresAtMs: EPOCH + 3600000 });
  await nextTick();
  assert.equal(f.saved().apiKey, SECRET);
  assert.equal(await f.service.credential(), null);
  await assert.rejects(f.service.beginLogin(), error => error.code === 'cursor_closed');
});

test('a catalog response finishing after logout cannot restore old profile or model state', async t => {
  const waiting = deferred();
  const f = await fixture(t, { initial: credential(), modelImpl: () => waiting.promise });
  const list = f.service.getModels(); await until(() => f.calls.models.length === 1);
  await f.service.logout(); waiting.resolve(catalog());
  assert.deepEqual(await list, []);
  const status = await f.service.status();
  assert.equal(status.profile, null); assert.deepEqual(status.catalog.models, []);
  assert.equal(status.catalog.checkedAt, null); assert.equal(status.authReady, false);
  assert.deepEqual(await f.service.getModels(), []);
  assert.equal(f.calls.models.length, 1);
});

test('expired or malformed bridge credentials stay offline and cannot leak through status', async t => {
  for (const initial of [{ ...credential(), apiKeyExpiresAtMs: EPOCH },
    { ...credential(), apiKey: `bad\n${SECRET}` }, { ...credential(), provider: 'other' }]) {
    const f = await fixture(t, { initial });
    assert.equal(await f.service.credential(), null);
    assert.deepEqual(await f.service.getModels(), []);
    const status = await f.service.status();
    assert.equal(status.authReady, false); assert.ok(status.error);
    assert.equal(JSON.stringify(status).includes(SECRET), false);
    assert.equal(f.calls.sdk, 0);
  }
});

test('SDK errors and untrusted metadata fields never expose keys or raw error bodies', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => { throw new Error(`Bearer ${SECRET} PRIVATE_BODY`); },
    meImpl: async () => ({ userEmail: SECRET, userFirstName: SECRET, refreshToken: SECRET }) });
  await assert.rejects(f.service.getModels(), error => error.code === 'cursor_metadata_unavailable' && !String(error).includes(SECRET));
  const status = await f.service.status();
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(JSON.stringify(status).includes('PRIVATE_BODY'), false);
  assert.equal(status.profile.email, 'mock@example.test');
  assert.equal(status.profile.name, null);
});

test('rejected identity disables this credential without falling back to native authentication', async t => {
  const f = await fixture(t, { initial: credential(), meImpl: async () => { throw Object.assign(new Error(SECRET), { status: 401 }); } });
  const status = await f.service.status();
  assert.equal(status.authReady, false);
  assert.ok(status.error); assert.deepEqual(status.catalog.models, []);
  assert.equal(await f.service.credential(), null);
  await f.service.status();
  assert.equal(f.calls.me.length, 1);
});

test('metadata permission errors do not mislabel a valid user key as an expired login', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => { throw Object.assign(new Error(SECRET), { status: 403 }); } });
  const status = await f.service.status();
  assert.equal(status.authReady, true);
  assert.ok(status.error); assert.deepEqual(status.catalog.models, []);
  assert.equal((await f.service.credential()).apiKey, SECRET);
});

test('malformed descriptors are excluded instead of partially inventing selectable variants', async t => {
  const f = await fixture(t, { initial: credential(), modelImpl: async () => [
    { id: 'gemini-4-argon', parameters: [{ id: 'effort', values: [] }] },
    { id: 'grok-4.7', variants: [{ params: [{ id: 'effort', value: `high\n${SECRET}` }] }] },
  ] });
  assert.deepEqual(await f.service.getModels(), []);
});

test('loader failure is sanitized and cached without invoking any model operation', async t => {
  const f = await fixture(t, { initial: credential(), sdkLoader: async () => { throw new Error(SECRET); } });
  const status = await f.service.status();
  assert.equal(status.error.includes('SDK'), true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  await f.service.status(); assert.equal(f.calls.sdk, 1);
  f.advance(30000); await f.service.status(); assert.equal(f.calls.sdk, 2);
});

test('login rejection before a URL becomes a sanitized failure and never saves a key', async t => {
  const f = await fixture(t, { loginImpl: async () => { throw new Error(SECRET); } });
  await assert.rejects(f.service.beginLogin(), error => !String(error).includes(SECRET));
  const status = await f.service.status();
  assert.equal(status.login.state, 'error');
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(f.saved(), null);
});

test('a non-Cursor authorization URL is rejected and even an ignored abort cannot save a key', async t => {
  const f = await fixture(t, { loginImpl: async options => {
    options.onLoginUrl(`https://cursor.com.evil.invalid/login?key=${SECRET}`);
    return { apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 };
  } });
  await assert.rejects(f.service.beginLogin(), error => !String(error).includes(SECRET));
  await nextTick();
  assert.equal(f.calls.logins[0].signal.aborted, true);
  assert.equal(f.saved(), null);
  assert.equal(JSON.stringify(await f.service.status()).includes(SECRET), false);
});

test('authorization accepts only the exact official HTTPS origin and its default port', async t => {
  for (const url of ['https://auth.cursor.com/login', 'https://www.cursor.com/login', 'https://cursor.com:8443/login',
    'http://cursor.com/login', 'https://user@cursor.com/login', 'https://user:password@cursor.com/login']) {
    const f = await fixture(t, { loginImpl: async options => {
      options.onLoginUrl(url);
      return { apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 };
    } });
    await assert.rejects(f.service.beginLogin(), error => error.code === 'cursor_login_failed');
    await nextTick();
    assert.equal(f.calls.logins[0].signal.aborted, true);
    assert.equal(f.saved(), null);
  }
  const f = await fixture(t, { loginImpl: async options => {
    options.onLoginUrl('https://cursor.com:443/loginDeepControl?uuid=mock');
    return new Promise(() => {});
  } });
  assert.deepEqual(await f.service.beginLogin(), { url: 'https://cursor.com/loginDeepControl?uuid=mock' });
});

test('successful authorization without its required URL is not persisted', async t => {
  const f = await fixture(t, { loginImpl: async () => ({ apiKey: SECRET, apiKeyExpiresAtMs: EPOCH + 3600000 }) });
  await assert.rejects(f.service.beginLogin());
  assert.equal(f.saved(), null);
});

test('metadata timeout does not let its later network result repopulate the cache', async t => {
  const waiting = deferred();
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const f = await fixture(t, { initial: credential(), modelImpl: () => waiting.promise, metadataTimeoutMs: 5 });
  await assert.rejects(f.service.getModels(), error => !String(error).includes(SECRET));
  waiting.resolve(catalog()); await nextTick();
  const status = await f.service.status();
  assert.deepEqual(status.catalog.models, []); assert.equal(status.catalog.source, null);
  assert.equal(f.calls.models.length, 1);
});

test('a slow SDK import is bounded and cannot start metadata calls after its timeout', async t => {
  const loading = deferred();
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  const f = await fixture(t, { initial: credential(), sdkLoader: () => loading.promise, metadataTimeoutMs: 5 });
  await assert.rejects(f.service.getModels());
  loading.resolve(f.sdk); await nextTick(); await nextTick();
  assert.equal(f.calls.me.length, 0); assert.equal(f.calls.models.length, 0);
  assert.deepEqual((await f.service.status()).catalog.models, []);
});

test('logout while the SDK is loading prevents the delayed login from even starting', async t => {
  const loading = deferred(), started = deferred();
  const f = await fixture(t, { sdkLoader: () => { started.resolve(); return loading.promise; } });
  const login = f.service.beginLogin();
  const rejected = assert.rejects(login, error => error.code === 'cursor_login_cancelled');
  await started.promise;
  await f.service.logout(); loading.resolve(f.sdk);
  await rejected; await nextTick();
  assert.equal(f.calls.logins.length, 0); assert.equal(f.saved(), null);
});

test('failed credential clearing reports a sanitized failure while immediately disabling in-memory access', async t => {
  const f = await fixture(t, { initial: credential(), storeOverrides: { clear: async () => { throw new Error(SECRET); } } });
  await assert.rejects(f.service.logout(), error => error.code === 'cursor_logout_failed' && !String(error).includes(SECRET));
  assert.equal(await f.service.credential(), null);
  assert.equal((await f.service.status()).authReady, false);
  assert.equal(JSON.stringify(await f.service.status()).includes(SECRET), false);
});

test('gateway status copies only bounded counters rather than arbitrary upstream errors', async t => {
  const f = await fixture(t, { getGatewayStatus: () => ({ running: true, requests: 9, completed: 6, failed: 2,
    active: 1, apiKey: SECRET, lastError: `upstream ${SECRET}`, baseUrl: `https://${SECRET}@example.test` }) });
  const status = await f.service.status();
  assert.deepEqual(status.gateway, { running: true, requests: 9, completed: 6, failed: 2, active: 1 });
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});
