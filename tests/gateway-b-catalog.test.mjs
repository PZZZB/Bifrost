import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Gateway } from '../src/gateway.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';
import { B_MODELS } from '../src/models.mjs';

const gatewayKey = 'offline-b-catalog-gateway-key-'.repeat(3);
const bBase = 'https://chatgpt.com/backend-api/codex';
const aBase = 'https://caller-a.example.invalid/backend-api/codex';
const firstPath = '/models?client_version=0.166.0';
const legacyIds = ['B-gpt-6-astra', 'B-gpt-6.1-sol'];
const extraId = 'B-gpt-b-directory-fixture';
const alternateId = 'B-o4-directory-fixture';
const aliasId = model => model.slug ?? model.id;
const ids = models => models.map(aliasId);
const sort = values => [...values].sort();
const aCatalog = () => ({ catalog_version: 'original-a', metadata: { retained: true }, models: [
  { slug: 'gpt-6.1-sol', display_name: 'Original A model', priority: 1, model_messages: { instructions_template: 'A fixture instructions' } },
] });
function sourceModel(slug, index = 0) {
  return { slug, display_name: `Official ${slug}`, priority: index, visibility: 'list', supported_in_api: false,
    context_window: 128000 + index, max_context_window: 256000 + index,
    default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'Official high effort' }],
    supports_parallel_tool_calls: true, input_modalities: ['text', 'image'], shell_type: 'shell_command',
    model_messages: { instructions_template: `B fixture instructions for ${slug}`, variables: { test: slug } } };
}
const bCatalog = (...slugs) => ({ catalog_version: 'official-b', models: (slugs.length ? slugs : [
  'gpt-6-astra', 'gpt-6.1-sol', 'gpt-b-directory-fixture', 'o4-directory-fixture',
]).map(sourceModel) });
const terminal = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","usage":{"input_tokens":8,"output_tokens":3}}}\n\n';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, message, milliseconds = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, { policy = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-b-catalog-')));
  const path = join(directory, 'models.json');
  const controls = { enabled: true, version: 'binding-one', path: firstPath, catalog: bCatalog(), metadataStatus: 200,
    readCatalog: null, credentialsError: null,
    credentials: { accountId: 'workspace-b', userId: 'user-b', email: 'b@example.invalid', value: 'fixture-b-token' } };
  const calls = { credentials: [], bCatalog: [], bInference: [], aCatalog: [], aInference: [] };
  const modelPolicy = policy ? await ModelPolicy.open({ path }) : null;
  if (modelPolicy) {
    await modelPolicy.observe({ models: [...aCatalog().models, ...B_MODELS] });
    modelPolicy.setAuthorizationVersionGetter('B', () => controls.version);
  }
  const backend = { async credentials(options) {
    calls.credentials.push(options ?? {});
    if (controls.credentialsError) throw controls.credentialsError;
    return structuredClone(controls.credentials);
  } };
  const gateway = new Gateway({ backend, gatewayKey, modelPolicy, catalogWaitMs: 100,
    getAProvider: async () => ({ config: { base_url: aBase } }),
    getBCatalogPath: () => controls.path,
    getAuthorizationVersion: account => account === 'B' ? controls.version : null,
    sourceEnabled: account => account !== 'B' || controls.enabled,
    fetchImpl: async (address, options = {}) => {
      const url = new URL(address), captured = { address, method: options.method ?? 'GET',
        headers: new Headers(options.headers), body: options.body };
      if (address.startsWith(aBase)) {
        if (url.pathname.endsWith('/models')) { calls.aCatalog.push(captured); return Response.json(aCatalog()); }
        calls.aInference.push(captured); return new Response(terminal, { headers: { 'content-type': 'text/event-stream' } });
      }
      assert.ok(address.startsWith(bBase + '/'), 'The fixture must not contact any other destination.');
      if (url.pathname.endsWith('/models')) {
        calls.bCatalog.push(captured);
        const snapshot = structuredClone(controls.catalog);
        if (controls.readCatalog) return controls.readCatalog(captured, snapshot);
        return controls.metadataStatus === 200 ? Response.json(snapshot)
          : new Response('PRIVATE_UPSTREAM_FAILURE_AND_CREDENTIAL', { status: controls.metadataStatus });
      }
      calls.bInference.push(captured);
      return new Response(terminal, { headers: { 'content-type': 'text/event-stream' } });
    } });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.ok(resolve(directory).startsWith(resolve(await realpath(tmpdir())) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/backend-api/codex`;
  const headers = { 'x-account-bridge-key': gatewayKey, authorization: 'Bearer fixture-a-token',
    'chatgpt-account-id': 'workspace-a', cookie: 'caller-a-cookie=private; bridge_session=local', 'content-type': 'application/json' };
  const send = async (route, options = {}) => {
    const response = await fetch(base + route, { headers, ...options });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { /* Streaming results stay bytes. */ }
    return { status: response.status, text, data, headers: response.headers };
  };
  const catalog = () => send(controls.path);
  const post = (model, extra = {}) => send('/responses', { method: 'POST', body: JSON.stringify({ model, input: 'Offline fixture prompt', ...extra }) });
  const refresh = (options = {}) => gateway.refreshBModels({ path: controls.path, force: true, ...options });
  return { directory, path, controls, calls, backend, modelPolicy, gateway, catalog, post, refresh };
}

test('management discovers every B account model while preserving the two existing choices and keeping new models closed', async t => {
  const f = await fixture(t), aliases = await f.refresh();
  assert.deepEqual(sort(ids(aliases)), sort([...legacyIds, extraId, alternateId]));
  const bModels = f.modelPolicy.snapshot().models.filter(model => model.channel === 'B');
  assert.deepEqual(sort(bModels.map(model => model.id)), sort([...legacyIds, extraId, alternateId]));
  assert.deepEqual(sort(bModels.filter(model => model.enabled).map(model => model.id)), sort(legacyIds));
  assert.ok(bModels.every(model => model.available === true));
  const directoryRead = f.calls.bCatalog[0];
  assert.equal(directoryRead.address, bBase + firstPath);
  assert.equal(directoryRead.headers.get('authorization'), 'Bearer fixture-b-token');
  assert.equal(directoryRead.headers.get('chatgpt-account-id'), 'workspace-b');
  assert.equal(directoryRead.headers.get('cookie'), null);
  assert.equal(directoryRead.headers.get('x-account-bridge-key'), null);
  const saved = await readFile(f.path, 'utf8');
  for (const privateValue of ['fixture-b-token', 'b@example.invalid', 'B fixture instructions']) assert.ok(!saved.includes(privateValue));
  const published = await f.catalog(); assert.equal(published.status, 200);
  assert.deepEqual(sort(published.data.models.filter(model => model.slug.startsWith('B-')).map(model => model.slug)), sort(legacyIds));
  assert.deepEqual(published.data.models.find(model => model.slug === 'gpt-6.1-sol'), aCatalog().models[0]);
  assert.equal(published.data.catalog_version, 'original-a');
  assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
});

test('explicit choices can replace one old B model with a newly discovered model without changing native A traffic', async t => {
  const f = await fixture(t); await f.refresh();
  const snapshot = f.modelPolicy.snapshot(), selected = new Set(['B-gpt-6.1-sol', extraId]);
  await f.modelPolicy.update({ revision: snapshot.revision,
    disabledModels: snapshot.models.filter(model => model.channel === 'B' && !selected.has(model.id)).map(model => model.id) });
  const published = await f.catalog(); assert.equal(published.status, 200);
  assert.deepEqual(sort(published.data.models.filter(model => model.slug.startsWith('B-')).map(model => model.slug)), sort(selected));
  const payload = { input: [{ role: 'user', content: 'Preserve every byte of this text.' }], stream: true,
    tools: [{ type: 'function', name: 'fixture_tool', parameters: { type: 'object', properties: { value: { type: 'string' } } } }],
    reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'], custom_fixture_metadata: { retained: true } };
  const response = await f.post(extraId, payload);
  assert.equal(response.status, 200); assert.equal(response.text, terminal);
  const sent = f.calls.bInference[0];
  assert.deepEqual(JSON.parse(sent.body), { model: 'gpt-b-directory-fixture', ...payload });
  assert.equal(sent.headers.get('authorization'), 'Bearer fixture-b-token');
  assert.equal(sent.headers.get('chatgpt-account-id'), 'workspace-b'); assert.equal(sent.headers.get('cookie'), null);
  assert.ok(!sent.body.toString().includes('fixture-a-token')); assert.equal(f.calls.aInference.length, 0);
  const original = await f.post('gpt-6.1-sol', { opaque: ['original', 7] });
  assert.equal(original.status, 200); assert.equal(original.text, terminal);
  assert.deepEqual(JSON.parse(f.calls.aInference[0].body), { model: 'gpt-6.1-sol', input: 'Offline fixture prompt', opaque: ['original', 7] });
  assert.equal(f.calls.aInference[0].headers.get('authorization'), 'Bearer fixture-a-token');
  assert.equal(f.calls.aInference[0].headers.get('chatgpt-account-id'), 'workspace-a');
});

test('refresh keeps saved B choices, exposes added models closed, and retires only the models absent from the new directory', async t => {
  const f = await fixture(t); await f.refresh();
  const before = f.modelPolicy.snapshot();
  await f.modelPolicy.update({ revision: before.revision, disabledModels: before.disabledModels.filter(id => id !== extraId) });
  f.controls.catalog = bCatalog('gpt-6.1-sol', 'gpt-b-directory-fixture', 'gpt-newly-added-fixture');
  await f.refresh();
  const rows = new Map(f.modelPolicy.snapshot().models.map(model => [model.id, model]));
  assert.equal(rows.get('B-gpt-6.1-sol').enabled, true); assert.equal(rows.get(extraId).enabled, true);
  assert.equal(rows.get('B-gpt-6-astra').available, false); assert.equal(rows.get(alternateId).available, false);
  assert.equal(rows.get('B-gpt-newly-added-fixture').enabled, false); assert.equal(rows.get('B-gpt-newly-added-fixture').available, true);
  const published = await f.catalog(); assert.equal(published.status, 200);
  assert.deepEqual(sort(published.data.models.filter(model => model.slug.startsWith('B-')).map(model => model.slug)), sort(['B-gpt-6.1-sol', extraId]));
  const reopened = await ModelPolicy.open({ path: f.path });
  assert.equal(reopened.snapshot().models.find(model => model.id === extraId).enabled, true);
  assert.equal(reopened.snapshot().models.find(model => model.id === 'B-gpt-newly-added-fixture').enabled, false);
});

test('a manual force refresh bypasses B metadata caching while ordinary reads reuse the same identity and version', async t => {
  const f = await fixture(t);
  await f.gateway.readBCatalog(firstPath); await f.gateway.readBCatalog(firstPath);
  assert.equal(f.calls.bCatalog.length, 1);
  f.controls.catalog = bCatalog('gpt-6-astra', 'gpt-6.1-sol', 'gpt-force-refresh-fixture');
  const ordinary = await f.gateway.readBCatalog(firstPath);
  assert.equal(ordinary.models.some(model => model.slug === 'gpt-force-refresh-fixture'), false);
  const refreshed = await f.refresh();
  assert.equal(f.calls.bCatalog.length, 2);
  assert.ok(ids(refreshed).includes('B-gpt-force-refresh-fixture'));
  assert.equal(f.modelPolicy.snapshot().models.find(model => model.id === 'B-gpt-force-refresh-fixture').enabled, false);
});

test('B catalogs for different client versions never share metadata or an in-progress refresh', async t => {
  const f = await fixture(t), firstStarted = deferred(), releaseFirst = deferred();
  const first = '/models?client_version=0.162.0', second = '/models?client_version=0.166.0';
  f.controls.readCatalog = async (call, data) => {
    const version = new URL(call.address).searchParams.get('client_version');
    if (version === '0.162.0') { firstStarted.resolve(); await releaseFirst.promise; }
    return Response.json({ ...data, fixture_client_version: version });
  };
  const old = f.gateway.readBCatalog(first);
  try {
    await firstStarted.promise;
    const current = await bounded(f.gateway.readBCatalog(second), 'The second client version incorrectly joined the first version refresh.');
    assert.equal(current.fixture_client_version, '0.166.0');
    releaseFirst.resolve(); assert.equal((await old).fixture_client_version, '0.162.0');
    assert.equal((await f.gateway.readBCatalog(second)).fixture_client_version, '0.166.0');
    assert.ok(f.calls.bCatalog.some(call => call.address === bBase + first));
    assert.ok(f.calls.bCatalog.some(call => call.address === bBase + second));
  } finally { releaseFirst.resolve(); await old.catch(() => {}); }
});

test('B metadata caching distinguishes users inside the same workspace', async t => {
  const f = await fixture(t);
  await f.gateway.readBCatalog(firstPath);
  f.controls.credentials = { ...f.controls.credentials, userId: 'different-user', email: 'different-b@example.invalid', value: 'different-b-token' };
  f.controls.catalog = bCatalog('gpt-different-user-fixture');
  const current = await f.gateway.readBCatalog(firstPath);
  assert.deepEqual(current.models.map(model => model.slug), ['gpt-different-user-fixture']);
  assert.equal(f.calls.bCatalog.length, 2);
  assert.equal(f.calls.bCatalog[1].headers.get('authorization'), 'Bearer different-b-token');
});

test('a late old B refresh is rejected without overwriting or disabling the already refreshed new binding', async t => {
  const f = await fixture(t), started = deferred(), releaseOld = deferred();
  f.controls.catalog = bCatalog('gpt-old-binding-fixture');
  f.controls.readCatalog = async (call, data) => {
    if (call.headers.get('authorization') === 'Bearer fixture-b-token') { started.resolve(); await releaseOld.promise; }
    return Response.json(data);
  };
  const old = f.refresh().then(value => ({ value }), error => ({ error }));
  try {
    await started.promise;
    f.controls.version = 'binding-two';
    f.controls.credentials = { accountId: 'workspace-new-b', userId: 'new-user-b', email: 'new-b@example.invalid', value: 'new-b-token' };
    f.controls.catalog = bCatalog('gpt-new-binding-fixture');
    const current = await bounded(f.refresh(), 'The new B binding incorrectly joined the previous binding refresh.');
    assert.deepEqual(ids(current), ['B-gpt-new-binding-fixture']);
    releaseOld.resolve();
    const late = await old;
    assert.ok(late.error, 'Metadata from the old B binding must never be returned as a successful refresh.');
    const stillCurrent = await f.gateway.readBCatalog(firstPath);
    assert.deepEqual(stillCurrent.models.map(model => model.slug), ['gpt-new-binding-fixture']);
    const currentRow = f.modelPolicy.snapshot().models.find(model => model.id === 'B-gpt-new-binding-fixture');
    assert.equal(currentRow.available, true); assert.equal(currentRow.enabled, false);
    assert.equal(f.modelPolicy.snapshot().models.some(model => model.id === 'B-gpt-old-binding-fixture'), false);
  } finally { releaseOld.resolve(); await old; }
});

test('a B authorization epoch change invalidates model availability and forces fresh metadata', async t => {
  const f = await fixture(t); await f.refresh();
  f.controls.version = 'new-authorization-epoch';
  assert.equal(f.modelPolicy.snapshot().models.find(model => model.id === 'B-gpt-6.1-sol').available, false);
  await f.gateway.readBCatalog(firstPath);
  assert.equal(f.calls.bCatalog.length, 2);
  await f.refresh({ force: false });
  assert.equal(f.modelPolicy.snapshot().models.find(model => model.id === 'B-gpt-6.1-sol').available, true);
});

test('B directory failures close old B models while leaving A available, and recovery preserves saved switches', async t => {
  const f = await fixture(t); await f.refresh();
  f.controls.metadataStatus = 503;
  await assert.rejects(f.refresh());
  let snapshot = f.modelPolicy.snapshot();
  assert.ok(snapshot.models.filter(model => model.channel === 'B').every(model => model.available === false));
  assert.equal(snapshot.models.find(model => model.id === 'gpt-6.1-sol').available, undefined);
  assert.deepEqual(sort(snapshot.models.filter(model => model.channel === 'B' && model.enabled).map(model => model.id)), sort(legacyIds));
  const catalog = await f.catalog(); assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.models.map(model => model.slug), ['gpt-6.1-sol']);
  assert.ok(!catalog.text.includes('PRIVATE_UPSTREAM_FAILURE_AND_CREDENTIAL'));
  f.controls.metadataStatus = 200; await f.refresh(); snapshot = f.modelPolicy.snapshot();
  assert.equal(snapshot.models.find(model => model.id === extraId).available, true);
  assert.equal(snapshot.models.find(model => model.id === extraId).enabled, false);
  assert.equal(snapshot.models.find(model => model.id === 'B-gpt-6.1-sol').enabled, true);
});

test('paused B sources reject inference and metadata before reading credentials while A still works', async t => {
  const f = await fixture(t); await f.refresh();
  const beforeCredentials = f.calls.credentials.length, beforeCatalogs = f.calls.bCatalog.length;
  f.controls.enabled = false;
  await assert.rejects(f.refresh());
  const denied = await f.post('B-gpt-6.1-sol'); assert.ok(denied.status >= 400);
  const catalog = await f.catalog(); assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.models.map(model => model.slug), ['gpt-6.1-sol']);
  assert.equal(f.calls.credentials.length, beforeCredentials); assert.equal(f.calls.bCatalog.length, beforeCatalogs);
  assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
});

test('new B aliases require explicit policy selection and unknown B aliases never fall through to A', async t => {
  const f = await fixture(t);
  const closed = await f.post(extraId); assert.ok(closed.status >= 400);
  assert.equal(f.modelPolicy.snapshot().models.find(model => model.id === extraId).enabled, false);
  assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
  for (const model of ['B-not-in-the-current-directory', 'B-', 'B-../escape', 'b-gpt-b-directory-fixture']) {
    const response = await f.post(model); assert.ok(response.status >= 400, model);
  }
  assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
});

test('policy-free legacy aliases retain their direct path while new aliases still require current B directory membership', async t => {
  const f = await fixture(t, { policy: false });
  const original = await f.post('B-gpt-6.1-sol'); assert.equal(original.status, 200);
  assert.equal(f.calls.bCatalog.length, 0);
  const added = await f.post(extraId); assert.equal(added.status, 200);
  assert.equal(f.calls.bInference.length, 2); assert.equal(f.calls.bCatalog.length, 1);
  assert.equal(JSON.parse(f.calls.bInference[1].body).model, 'gpt-b-directory-fixture');
  const missing = await f.post('B-unregistered-model'); assert.ok(missing.status >= 400);
  assert.equal(f.calls.bInference.length, 2); assert.equal(f.calls.aInference.length, 0);
});

test('a late failed refresh for another user in the same workspace cannot poison the current user even without an epoch change', async t => {
  const f = await fixture(t); await f.refresh();
  const started = deferred(), releaseOld = deferred(), originalEpoch = f.controls.version;
  f.controls.readCatalog = async (call, data) => {
    if (call.headers.get('authorization') === 'Bearer fixture-b-token') {
      started.resolve(); await releaseOld.promise;
      throw new Error('PRIVATE_OLD_USER_REFRESH_FAILURE');
    }
    return Response.json(data);
  };
  const old = f.refresh().then(value => ({ value }), error => ({ error }));
  try {
    await started.promise;
    f.controls.credentials = { ...f.controls.credentials, userId: 'second-user-same-workspace',
      email: 'second-user@example.invalid', value: 'second-user-token' };
    f.controls.catalog = bCatalog('gpt-current-user-fixture');
    const current = await bounded(f.refresh(), 'A different user in the same workspace incorrectly joined an old refresh.');
    assert.deepEqual(ids(current), ['B-gpt-current-user-fixture']);
    assert.equal(f.controls.version, originalEpoch);
    releaseOld.resolve(); assert.ok((await old).error);
    const row = f.modelPolicy.snapshot().models.find(model => model.id === 'B-gpt-current-user-fixture');
    assert.equal(row.available, true); assert.equal(row.enabled, false);
    assert.equal(f.gateway.bModelDiscovery.state, 'ready');
    const cached = await f.gateway.readBCatalog(firstPath);
    assert.deepEqual(cached.models.map(model => model.slug), ['gpt-current-user-fixture']);
    assert.equal(f.calls.bCatalog.length, 3);
    assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
  } finally { releaseOld.resolve(); await old; }
});

test('merged client catalogs cannot replace authoritative B availability or relabel stale capabilities as a new binding', async t => {
  const f = await fixture(t); await f.refresh();
  const before = f.modelPolicy.snapshot().models.find(model => model.id === extraId);
  assert.equal(before.available, true); assert.equal(before.capabilities.contextWindow.tokens, 128002);
  const catalog = await f.catalog(); assert.equal(catalog.status, 200);
  let after = f.modelPolicy.snapshot().models.find(model => model.id === extraId);
  assert.equal(after.available, true); assert.deepEqual(after.capabilities, before.capabilities);
  const forgedClientMetadata = { slug: extraId, display_name: 'Merged display only', available: false,
    context_window: 7, input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'low', description: 'Client-only metadata' }] };
  await f.modelPolicy.observe({ models: [forgedClientMetadata] });
  after = f.modelPolicy.snapshot().models.find(model => model.id === extraId);
  assert.equal(after.available, true); assert.deepEqual(after.capabilities, before.capabilities);
  f.controls.version = 'changed-binding-after-client-catalog';
  await f.modelPolicy.observe({ models: [{ ...forgedClientMetadata, available: true }] });
  after = f.modelPolicy.snapshot().models.find(model => model.id === extraId);
  assert.equal(after.available, false);
  assert.equal(after.capabilities.contextWindow.tokens, null);
  assert.equal(after.capabilities.reasoning.support, null);
  assert.equal(f.calls.bInference.length, 0); assert.equal(f.calls.aInference.length, 0);
});
