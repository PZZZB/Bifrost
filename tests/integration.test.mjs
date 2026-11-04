import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Integration } from '../src/integration.mjs';

const copy = value => structuredClone(value);

function mergeConfig(base, overrides) {
  const result = copy(base);
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(result[key] && typeof result[key] === 'object' ? result[key] : {}, value)
      : copy(value);
  }
  return result;
}

class ConfigRpc {
  constructor(configPath, config, inherited = {}) {
    this.configPath = configPath;
    this.config = copy(config);
    this.inherited = copy(inherited);
    this.version = 1;
    this.writes = [];
    this.beforeWrite = null;
    this.afterWrite = null;
    this.layerEnabled = true;
    this.overrides = {};
  }

  async request(method, params) {
    if (method === 'config/read') {
      assert.deepEqual(params, { includeLayers: true });
      const effective = mergeConfig(mergeConfig(this.inherited, this.config), this.overrides);
      return {
        config: effective,
        origins: {},
        layers: [...(Object.keys(this.overrides).length ? [{
          name: { type: 'session' }, version: 'sha256:session', config: copy(this.overrides), disabledReason: null,
        }] : []), {
          name: { type: 'user', file: this.configPath, profile: null },
          version: `sha256:${this.version}`,
          config: copy(this.config),
          disabledReason: this.layerEnabled ? null : 'disabled for test',
        }, {
          name: { type: 'system', file: path.join(path.dirname(this.configPath), 'system.toml') },
          version: 'sha256:system', config: copy(this.inherited), disabledReason: null,
        }],
      };
    }
    assert.equal(method, 'config/batchWrite');
    this.writes.push(copy(params));
    await this.beforeWrite?.(this, params);
    assert.equal(params.filePath, this.configPath);
    assert.equal(params.reloadUserConfig, false);
    if (params.expectedVersion !== `sha256:${this.version}`) throw new Error('version mismatch');
    for (const edit of params.edits) {
      assert.equal(edit.mergeStrategy, 'replace');
      const keys = edit.keyPath.split('.');
      let object = this.config;
      for (const key of keys.slice(0, -1)) object = (object[key] ||= {});
      if (edit.value === null) delete object[keys.at(-1)];
      else object[keys.at(-1)] = copy(edit.value);
    }
    this.version += 1;
    await this.afterWrite?.(this, params);
    return { status: 'ok', filePath: this.configPath, version: `sha256:${this.version}`, overriddenMetadata: null };
  }
}

function originalConfig() {
  return {
    model: 'existing-model',
    model_provider: 'custom',
    model_reasoning_effort: 'high',
    model_providers: {
      custom: {
        name: 'Existing provider',
        base_url: 'https://original.example.invalid/v1',
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: true,
        http_headers: { 'X-Existing': 'keep this' },
      },
      other: { name: 'Other provider', base_url: 'https://other.example.invalid' },
    },
    mcp_servers: { existing: { command: 'keep-command' } },
  };
}

async function setup(t, config = originalConfig(), inherited) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-bridge-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.toml');
  const statePath = path.join(directory, 'integration.json');
  const rpc = new ConfigRpc(configPath, config, inherited);
  const options = { rpc, configPath, statePath, baseUrl: 'http://127.0.0.1:19437/v1', gatewayKey: 'test-local-gateway-key' };
  return { directory, configPath, statePath, rpc, options, integration: new Integration(options) };
}

async function setupLegacy(t, config = originalConfig(), inherited) {
  const context = await setup(t, config, inherited);
  const { configPath, statePath, rpc } = context;
  const provider = rpc.config.model_providers.custom;
  const descriptors = [
    ['base_url', { exists: Object.hasOwn(provider, 'base_url'), value: provider.base_url }, 'http://127.0.0.1:19437/v1'],
    ['supports_websockets', { exists: Object.hasOwn(provider, 'supports_websockets'), value: provider.supports_websockets }, false],
    ['http_headers.X-Account-Bridge-Key', {
      exists: Object.hasOwn(provider.http_headers || {}, 'X-Account-Bridge-Key'),
      value: provider.http_headers?.['X-Account-Bridge-Key'],
    }, 'test-local-gateway-key'],
  ];
  const state = {
    version: 1, configPath, providerId: 'custom', phase: 'installed',
    fields: descriptors.map(([field, original, value]) => ({
      keyPath: `model_providers.custom.${field}`,
      installed: { exists: true, value },
      original: original.exists ? original : { exists: false },
    })),
  };
  provider.base_url = descriptors[0][2];
  provider.supports_websockets = false;
  provider.http_headers ||= {};
  provider.http_headers['X-Account-Bridge-Key'] = descriptors[2][2];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return { ...context, legacyState: state };
}

test('install changes exactly four provider fields; repeat install is idempotent', async t => {
  const { integration, rpc, statePath, configPath } = await setup(t);
  const original = copy(rpc.config);
  const { routing, ...initial } = await integration.inspect();
  assert.deepEqual(initial, { installed: false, configPath, canInstall: true, needsUpgrade: false, providerId: 'custom' });
  assert.equal(routing.mode, 'other');
  assert.equal(routing.canSwitchGateway, false);
  const installed = await integration.install();
  assert.equal(installed.installed, true);
  const expected = copy(original);
  expected.model_providers.custom.base_url = 'http://127.0.0.1:19437/v1';
  expected.model_providers.custom.supports_websockets = false;
  expected.model_providers.custom.http_headers['X-Account-Bridge-Key'] = 'test-local-gateway-key';
  expected.model_providers.custom.model_catalog_url = 'http://127.0.0.1:19437/v1/models';
  assert.deepEqual(rpc.config, expected);
  assert.equal(rpc.writes.length, 1);
  assert.equal(rpc.writes[0].expectedVersion, 'sha256:1');
  assert.deepEqual(rpc.writes[0].edits.map(edit => edit.keyPath), [
    'model_providers.custom.base_url',
    'model_providers.custom.supports_websockets',
    'model_providers.custom.http_headers.X-Account-Bridge-Key',
    'model_providers.custom.model_catalog_url',
  ]);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.phase, 'installed');
  assert.equal(state.version, 2);
  assert.equal(state.fields.length, 4);
  assert.equal(JSON.stringify(state).includes('keep-command'), false);
  assert.equal(JSON.stringify(state).includes('existing-model'), false);
  if (process.platform !== 'win32') assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  await integration.install();
  assert.equal(rpc.writes.length, 1);
});

test('restore deletes originally absent keys and preserves later unrelated edits', async t => {
  const config = originalConfig();
  delete config.model_providers.custom.supports_websockets;
  const { integration, rpc, statePath } = await setup(t, config);
  await integration.install();
  rpc.config.model = 'user-selected-model';
  rpc.config.model_providers.custom.http_headers['X-Added-Later'] = 'keep later';
  rpc.version += 1;
  const result = await integration.restore();
  assert.equal(result.restored, true);
  assert.equal(result.installed, false);
  assert.equal(rpc.config.model, 'user-selected-model');
  assert.equal(rpc.config.model_provider, 'custom');
  assert.equal(rpc.config.model_providers.custom.base_url, config.model_providers.custom.base_url);
  assert.equal(rpc.config.model_providers.custom.requires_openai_auth, true);
  assert.equal(Object.hasOwn(rpc.config.model_providers.custom, 'supports_websockets'), false);
  assert.deepEqual(rpc.config.model_providers.custom.http_headers, { 'X-Existing': 'keep this', 'X-Added-Later': 'keep later' });
  const deletions = rpc.writes[1].edits.filter(edit => edit.value === null).map(edit => edit.keyPath);
  assert.deepEqual(deletions, [
    'model_providers.custom.supports_websockets',
    'model_providers.custom.http_headers.X-Account-Bridge-Key',
    'model_providers.custom.model_catalog_url',
  ]);
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });
  assert.equal((await integration.restore()).restored, false);
});

test('restore refuses a user edit to any managed field', async t => {
  for (const target of ['base_url', 'supports_websockets', 'header', 'model_catalog_url']) {
    const { integration, rpc, statePath } = await setup(t);
    await integration.install();
    if (target === 'header') rpc.config.model_providers.custom.http_headers['X-Account-Bridge-Key'] = 'user-key';
    else rpc.config.model_providers.custom[target] = target === 'supports_websockets' ? true : 'https://user.example.invalid';
    rpc.version += 1;
    const before = copy(rpc.config);
    await assert.rejects(integration.restore(), { code: 'INTEGRATION_CONFLICT' });
    assert.deepEqual(rpc.config, before);
    assert.equal(rpc.writes.length, 1);
    assert.equal((await integration.inspect()).canInstall, false);
    await readFile(statePath);
  }
});

test('optimistic version checks retain the baseline and allow retry after unrelated edits', async t => {
  const { integration, rpc, statePath } = await setup(t);
  rpc.beforeWrite = async server => {
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).phase, 'prepared');
    server.config.model_reasoning_effort = 'low';
    server.version += 1;
    server.beforeWrite = null;
  };
  await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(rpc.config.model_providers.custom.base_url, 'https://original.example.invalid/v1');
  assert.equal((await integration.inspect()).canInstall, true);
  await integration.install();
  assert.equal(rpc.config.model_reasoning_effort, 'low');
  await integration.restore();
  assert.equal(rpc.config.model_reasoning_effort, 'low');
});

test('a lost write response is recoverable after restarting the Integration instance', async t => {
  const { integration, rpc, options, statePath } = await setup(t);
  rpc.afterWrite = () => {
    rpc.afterWrite = null;
    throw new Error('connection closed after commit');
  };
  await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).phase, 'prepared');
  const restarted = new Integration(options);
  assert.equal((await restarted.inspect()).installed, true);
  await restarted.restore();
  assert.equal(rpc.config.model_providers.custom.base_url, 'https://original.example.invalid/v1');
});

test('restore handles a lost response after commit without overwriting new unrelated settings', async t => {
  const { integration, rpc, options } = await setup(t);
  await integration.install();
  rpc.afterWrite = () => { rpc.afterWrite = null; throw new Error('lost restore response'); };
  await assert.rejects(integration.restore(), { code: 'INTEGRATION_WRITE_FAILED' });
  rpc.config.model = 'changed-after-restore';
  rpc.version += 1;
  const result = await new Integration(options).restore();
  assert.equal(result.restored, true);
  assert.equal(rpc.config.model, 'changed-after-restore');
});

test('changing the selected provider does not prevent restoring the originally edited provider', async t => {
  const { integration, rpc } = await setup(t);
  await integration.install();
  rpc.config.model_provider = 'other';
  rpc.version += 1;
  assert.equal((await integration.inspect()).canInstall, false);
  await integration.restore();
  assert.equal(rpc.config.model_provider, 'other');
  assert.equal(rpc.config.model_providers.custom.base_url, 'https://original.example.invalid/v1');
});

test('restore removes user overrides when original values were inherited', async t => {
  const config = originalConfig();
  const inherited = { model_providers: { custom: copy(config.model_providers.custom) } };
  delete config.model_providers.custom.base_url;
  delete config.model_providers.custom.supports_websockets;
  const { integration, rpc } = await setup(t, config, inherited);
  await integration.install();
  await integration.restore();
  assert.equal(Object.hasOwn(rpc.config.model_providers.custom, 'base_url'), false);
  assert.equal(Object.hasOwn(rpc.config.model_providers.custom, 'supports_websockets'), false);
});

test('a new gateway address or key cannot silently replace an existing installation', async t => {
  const { integration, rpc, options } = await setup(t);
  await integration.install();
  const replacement = new Integration({ ...options, gatewayKey: 'changed-key' });
  assert.equal((await replacement.inspect()).canInstall, false);
  await assert.rejects(replacement.install(), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(rpc.writes.length, 1);
  // Restoring the previous connection remains possible using its recovery manifest.
  assert.equal((await replacement.restore()).restored, true);
});

test('invalid recovery data and disabled config layers never cause config writes', async t => {
  const { integration, rpc, statePath } = await setup(t);
  await writeFile(statePath, '{not json');
  await assert.rejects(integration.install(), { code: 'INTEGRATION_STATE_INVALID' });
  await assert.rejects(integration.restore(), { code: 'INTEGRATION_STATE_INVALID' });
  assert.equal(rpc.writes.length, 0);
  await rm(statePath);
  await integration.install();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.fields[0] = null;
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(integration.restore(), { code: 'INTEGRATION_STATE_INVALID' });
  assert.equal(rpc.writes.length, 1);
  await rm(statePath);
  rpc.layerEnabled = false;
  await assert.rejects(integration.inspect(), { code: 'INTEGRATION_CONFIG_UNAVAILABLE' });
  assert.equal(rpc.writes.length, 1);
});

test('unsupported provider configurations are reported without mutation or secret values', async t => {
  for (const mutate of [
    config => { config.model_provider = 'openai'; },
    config => { config.model_providers.custom.requires_openai_auth = false; },
    config => { config.model_providers.custom.wire_api = 'chat'; },
    config => { config.model_providers.custom.http_headers['x-account-bridge-key'] = 'existing-secret'; },
  ]) {
    const config = originalConfig();
    mutate(config);
    const { integration, rpc } = await setup(t, config);
    const status = await integration.inspect();
    assert.equal(status.canInstall, false);
    assert.equal(JSON.stringify(status).includes('example.invalid'), false);
    assert.equal(JSON.stringify(status).includes('existing-secret'), false);
    await assert.rejects(integration.install(), { code: 'INTEGRATION_CONFLICT' });
    assert.equal(rpc.writes.length, 0);
  }
});

test('concurrent installation requests share one original baseline', async t => {
  const { integration, rpc } = await setup(t);
  const results = await Promise.all([integration.install(), integration.install(), integration.install()]);
  assert.ok(results.every(result => result.installed));
  assert.equal(rpc.writes.length, 1);
  await integration.restore();
  assert.equal(rpc.config.model_providers.custom.base_url, 'https://original.example.invalid/v1');
});

test('originalProvider returns the effective original provider without changing state or exposing the bridge key', async t => {
  const config = originalConfig();
  config.model_providers.custom.http_headers.Authorization = 'original-private-value';
  config.model_providers.custom.env_http_headers = { 'X-Account-Bridge-Key': 'BRIDGE_KEY', 'X-Original': 'ORIGINAL_KEY' };
  const { integration, rpc, statePath } = await setup(t, config);
  const expected = copy(config.model_providers.custom);
  expected.model_catalog_url = null;
  delete expected.env_http_headers['X-Account-Bridge-Key'];
  assert.deepEqual(await integration.originalProvider(), { providerId: 'custom', config: expected });
  await integration.install();
  const before = await readFile(statePath, 'utf8');
  const result = await integration.originalProvider();
  assert.deepEqual(result, { providerId: 'custom', config: expected });
  assert.equal(JSON.stringify(result).includes('test-local-gateway-key'), false);
  assert.equal(await readFile(statePath, 'utf8'), before);
  result.config.name = 'caller mutated clone';
  assert.equal(rpc.config.model_providers.custom.name, 'Existing provider');
  assert.equal(rpc.writes.length, 1);
});

test('originalProvider resolves originally absent user fields from lower config layers', async t => {
  const config = originalConfig();
  const inherited = { model_providers: { custom: {
    base_url: 'https://inherited.example.invalid/v1', supports_websockets: true,
    model_catalog_url: 'https://inherited.example.invalid/catalog',
    http_headers: { 'X-Inherited': 'keep inherited' },
  } } };
  delete config.model_providers.custom.base_url;
  delete config.model_providers.custom.supports_websockets;
  const { integration, rpc } = await setup(t, config, inherited);
  const expected = mergeConfig(inherited, config).model_providers.custom;
  assert.deepEqual((await integration.originalProvider()).config, expected);
  await integration.install();
  assert.deepEqual((await integration.originalProvider()).config, expected);
  assert.equal(rpc.config.model_providers.custom.base_url, 'http://127.0.0.1:19437/v1');
  // The A route follows the same inherited settings that restoring the user override would reveal.
  rpc.inherited.model_providers.custom.base_url = 'https://updated-inherited.example.invalid/v1';
  assert.equal((await integration.originalProvider()).config.base_url, 'https://updated-inherited.example.invalid/v1');
});

test('originalProvider refuses a missing inherited address or a self-routing address', async t => {
  const config = originalConfig();
  delete config.model_providers.custom.base_url;
  const missing = await setup(t, config);
  await assert.rejects(missing.integration.originalProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
  const self = await setup(t);
  self.rpc.config.model_providers.custom.base_url = 'http://127.0.0.1:19437/v1';
  await assert.rejects(self.integration.originalProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
  assert.equal(missing.rpc.writes.length, 0);
  assert.equal(self.rpc.writes.length, 0);
});

test('v1 installation remains readable and upgrades its catalog without losing any original values', async t => {
  const { integration, rpc, statePath, legacyState } = await setupLegacy(t);
  const originalText = await readFile(statePath, 'utf8');
  const initial = await integration.inspect();
  assert.equal(initial.installed, true);
  assert.equal(initial.needsUpgrade, true);
  assert.equal(initial.canInstall, true);
  assert.deepEqual((await integration.originalProvider()).config, { ...originalConfig().model_providers.custom, model_catalog_url: null });
  assert.equal(await readFile(statePath, 'utf8'), originalText);
  const result = await integration.install();
  assert.equal(result.installed, true);
  assert.equal(result.needsUpgrade, false);
  assert.equal(rpc.writes.length, 1);
  assert.equal(rpc.config.model_providers.custom.model_catalog_url, 'http://127.0.0.1:19437/v1/models');
  const upgraded = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.phase, 'installed');
  assert.deepEqual(upgraded.fields.slice(0, 3), legacyState.fields);
  assert.deepEqual(upgraded.fields[3].original, { exists: false });
  await integration.install();
  assert.equal(rpc.writes.length, 1);
  await integration.restore();
  assert.deepEqual(rpc.config, originalConfig());
});

test('v1 can be restored directly without upgrading or changing its original provider', async t => {
  const { integration, rpc } = await setupLegacy(t);
  const result = await integration.restore();
  assert.equal(result.restored, true);
  assert.deepEqual(rpc.config, originalConfig());
  assert.equal(rpc.writes.length, 1);
  assert.equal(rpc.writes[0].edits.length, 3);
});

test('v1 upgrade records and restores an existing catalog value', async t => {
  const config = originalConfig();
  config.model_providers.custom.model_catalog_url = 'https://original.example.invalid/models';
  const { integration, rpc, statePath } = await setupLegacy(t, config);
  await integration.install();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state.fields[3].original, { exists: true, value: config.model_providers.custom.model_catalog_url });
  assert.equal((await integration.originalProvider()).config.model_catalog_url, config.model_providers.custom.model_catalog_url);
  await integration.restore();
  assert.deepEqual(rpc.config, config);
});

test('an interrupted v1 upgrade can retry without changing the legacy recovery baseline', async t => {
  const { integration, rpc, statePath, options, legacyState } = await setupLegacy(t);
  rpc.beforeWrite = server => {
    server.config.model_reasoning_effort = 'low';
    server.version += 1;
    server.beforeWrite = null;
  };
  await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
  const pending = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(pending.phase, 'upgrading');
  assert.deepEqual(pending.fields.slice(0, 3), legacyState.fields);
  assert.equal((await integration.inspect()).needsUpgrade, true);
  assert.equal((await integration.inspect()).canInstall, true);
  assert.equal((await integration.originalProvider()).config.base_url, originalConfig().model_providers.custom.base_url);
  const restarted = new Integration(options);
  await restarted.install();
  await restarted.restore();
  const expected = originalConfig();
  expected.model_reasoning_effort = 'low';
  assert.deepEqual(rpc.config, expected);
});

test('an interrupted v1 upgrade can restore directly, including retry after a version conflict', async t => {
  const { integration, rpc, statePath, options } = await setupLegacy(t);
  rpc.beforeWrite = () => { throw new Error('offline'); };
  await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
  rpc.beforeWrite = server => { server.version += 1; server.beforeWrite = null; };
  await assert.rejects(integration.restore(), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).phase, 'upgrading');
  const result = await new Integration(options).restore();
  assert.equal(result.restored, true);
  assert.deepEqual(rpc.config, originalConfig());
});

test('a committed v1 upgrade with a lost response is recognized and does not rewrite config on retry', async t => {
  const { integration, rpc, statePath, options } = await setupLegacy(t);
  rpc.afterWrite = () => { rpc.afterWrite = null; throw new Error('lost upgrade response'); };
  await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).phase, 'upgrading');
  const restarted = new Integration(options);
  const inspected = await restarted.inspect();
  assert.equal(inspected.installed, true);
  assert.equal(inspected.needsUpgrade, false);
  await restarted.install();
  assert.equal(rpc.writes.length, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).phase, 'installed');
});

test('a conflicting edit blocks v1 upgrade and originalProvider without changing the legacy manifest', async t => {
  const { integration, rpc, statePath } = await setupLegacy(t);
  const before = await readFile(statePath, 'utf8');
  rpc.config.model_providers.custom.base_url = 'https://user-edited.example.invalid';
  rpc.version += 1;
  await assert.rejects(integration.install(), { code: 'INTEGRATION_CONFLICT' });
  await assert.rejects(integration.originalProvider(), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(await readFile(statePath, 'utf8'), before);
  assert.equal(rpc.writes.length, 0);
});

test('official and saved gateway modes round-trip without changing accounts, models, or recovery settings', async t => {
  const { integration, rpc, statePath, options } = await setup(t);
  await integration.install();
  const installedConfig = copy(rpc.config);
  const recovery = await readFile(statePath, 'utf8');
  assert.equal((await integration.inspect()).routing.mode, 'gateway');

  const official = await integration.switchMode('official');
  assert.equal(official.installed, true);
  assert.equal(official.routing.mode, 'official');
  assert.equal(official.routing.canSwitchGateway, true);
  assert.deepEqual(rpc.config, { ...installedConfig, model_provider: 'openai' });
  assert.equal(await readFile(statePath, 'utf8'), recovery);
  assert.deepEqual(rpc.writes.at(-1).edits, [{ keyPath: 'model_provider', value: 'openai', mergeStrategy: 'replace' }]);
  assert.equal((await integration.originalProvider()).config.base_url, originalConfig().model_providers.custom.base_url);

  const restarted = new Integration(options);
  const gateway = await restarted.switchMode('gateway');
  assert.equal(gateway.routing.mode, 'gateway');
  assert.equal(gateway.routing.gatewayProviderId, 'custom');
  assert.deepEqual(rpc.config, installedConfig);
  assert.equal(await readFile(statePath, 'utf8'), recovery);
  const count = rpc.writes.length;
  await restarted.switchMode('gateway');
  assert.equal(rpc.writes.length, count);
  await restarted.restore();
  assert.deepEqual(rpc.config, originalConfig());
});

test('official mode works without a saved gateway and absent provider defaults to official', async t => {
  const config = originalConfig();
  delete config.model_provider;
  const { integration, rpc, statePath } = await setup(t, config);
  assert.equal((await integration.inspect()).routing.mode, 'official');
  await integration.switchMode('official');
  assert.equal(rpc.writes.length, 0);
  await assert.rejects(integration.switchMode('gateway'), { code: 'INTEGRATION_CONFLICT' });
  await assert.rejects(integration.switchMode('invalid'), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(rpc.writes.length, 0);
  await assert.rejects(readFile(statePath), { code: 'ENOENT' });

  rpc.config.model_provider = 'custom';
  rpc.version += 1;
  assert.equal((await integration.switchMode('official')).routing.mode, 'official');
  assert.deepEqual(rpc.config, { ...config, model_provider: 'openai' });
});

test('gateway switching refuses edited settings but official mode remains available', async t => {
  for (const field of ['base_url', 'model_catalog_url', 'requires_openai_auth', 'wire_api', 'header']) {
    const { integration, rpc } = await setup(t);
    await integration.install();
    const provider = rpc.config.model_providers.custom;
    if (field === 'header') provider.http_headers['X-Account-Bridge-Key'] = 'edited-private-key';
    else provider[field] = field === 'requires_openai_auth' ? false : 'user-change';
    rpc.version += 1;
    const changed = copy(rpc.config);
    await integration.switchMode('official');
    const status = await integration.inspect();
    assert.equal(status.routing.canSwitchGateway, false);
    assert.equal(JSON.stringify(status).includes('edited-private-key'), false);
    await assert.rejects(integration.switchMode('gateway'), { code: 'INTEGRATION_CONFLICT' });
    assert.deepEqual(rpc.config, { ...changed, model_provider: 'openai' });
    assert.equal(rpc.writes.length, 2);
  }
});

test('switching neither bypasses higher-priority provider locks nor effective gateway field overrides', async t => {
  const { integration, rpc } = await setup(t);
  await integration.install();
  rpc.overrides = { model_provider: 'custom' };
  let routing = (await integration.inspect()).routing;
  assert.equal(routing.canSwitchOfficial, false);
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(rpc.writes.length, 1);

  rpc.overrides = {};
  await integration.switchMode('official');
  rpc.overrides = { model_providers: { custom: { base_url: 'https://override.example.invalid' } } };
  routing = (await integration.inspect()).routing;
  assert.equal(routing.canSwitchGateway, false);
  await assert.rejects(integration.switchMode('gateway'), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(rpc.writes.length, 2);
});

test('a custom endpoint named openai cannot be advertised or selected as official', async t => {
  const config = originalConfig();
  config.model_providers.openai = { base_url: 'https://private-gateway.example.invalid/v1' };
  const { integration, rpc } = await setup(t, config);
  assert.equal((await integration.inspect()).routing.canSwitchOfficial, false);
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
  rpc.config.model_provider = 'openai';
  assert.equal((await integration.inspect()).routing.mode, 'other');
  assert.equal(rpc.writes.length, 0);
  assert.equal(JSON.stringify(await integration.inspect()).includes('private-gateway'), false);
});

test('a root or higher-priority OpenAI URL override prevents claiming official direct routing', async t => {
  for (const inherited of [false, true]) {
    const { integration, rpc } = await setup(t);
    await integration.install();
    await integration.switchMode('official');
    if (inherited) rpc.overrides = { openai_base_url: 'https://private-root.example.invalid/v1' };
    else rpc.config.openai_base_url = 'https://private-root.example.invalid/v1';
    const before = copy(rpc.config);
    const status = await integration.inspect();
    assert.equal(status.routing.mode, 'other');
    assert.equal(status.routing.canSwitchOfficial, false);
    assert.equal(JSON.stringify(status).includes('private-root'), false);
    await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
    assert.deepEqual(rpc.config, before);
    assert.equal(rpc.writes.length, 2);
  }
});

test('custom subscription endpoints cannot be labelled official while the native default remains usable', async t => {
  for (const address of ['https://subscription-proxy.example.invalid/backend-api', 'http://chatgpt.com/backend-api', 'not-a-url']) {
    const config = originalConfig();
    config.chatgpt_base_url = address;
    const { integration, rpc } = await setup(t, config);
    await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
    assert.equal(rpc.writes.length, 0);
  }
  const config = originalConfig();
  config.chatgpt_base_url = 'https://chatgpt.com/backend-api/';
  const { integration } = await setup(t, config);
  assert.equal((await integration.switchMode('official')).routing.mode, 'official');
});

test('switches retain optimistic concurrency and recover after a lost committed response', async t => {
  const { integration, rpc, options, statePath } = await setup(t);
  await integration.install();
  const recovery = await readFile(statePath, 'utf8');
  rpc.beforeWrite = server => {
    server.config.model_reasoning_effort = 'low';
    server.version += 1;
    server.beforeWrite = null;
  };
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(rpc.config.model_provider, 'custom');
  rpc.afterWrite = server => { server.afterWrite = null; throw new Error('lost response after switch'); };
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_WRITE_FAILED' });
  assert.equal(rpc.config.model_provider, 'openai');
  const count = rpc.writes.length;
  assert.equal((await new Integration(options).switchMode('official')).routing.mode, 'official');
  assert.equal(rpc.writes.length, count);
  assert.equal(rpc.config.model_reasoning_effort, 'low');
  assert.equal(await readFile(statePath, 'utf8'), recovery);
});

test('a new override during switching is reported instead of claiming that official mode is active', async t => {
  const { integration, rpc } = await setup(t);
  await integration.install();
  rpc.afterWrite = server => { server.afterWrite = null; server.overrides = { model_provider: 'custom' }; };
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
  assert.equal((await integration.inspect()).routing.mode, 'gateway');
  assert.equal(rpc.config.model_provider, 'openai');
});

test('concurrent connection switches serialize while retaining one recovery baseline', async t => {
  const { integration, rpc, statePath } = await setup(t);
  await integration.install();
  const recovery = await readFile(statePath, 'utf8');
  const results = await Promise.all([
    integration.switchMode('official'), integration.switchMode('gateway'), integration.switchMode('official'),
  ]);
  assert.deepEqual(results.map(item => item.routing.mode), ['official', 'gateway', 'official']);
  assert.equal(rpc.config.model_provider, 'openai');
  assert.equal(await readFile(statePath, 'utf8'), recovery);
});

const privateNativeBase = 'http://127.0.0.1:19437/native/private-capability/backend-api/codex';
const nativeIntegration = context => new Integration({ ...context.options, nativeBaseUrl: privateNativeBase });

test('native compatibility covers both provider families and official switching restores all owned routes', async t => {
  const context = await setup(t);
  const { rpc, statePath } = context, integration = nativeIntegration(context);
  const original = copy(rpc.config);
  const installed = await integration.install();
  assert.equal(installed.routing.mode, 'gateway');
  assert.equal(installed.routing.nativeThreadsSupported, true);
  assert.equal(installed.routing.nativeThreadsCovered, true);
  assert.equal(rpc.config.openai_base_url, privateNativeBase);
  assert.equal(rpc.config.model_providers.custom.base_url, context.options.baseUrl);
  assert.equal(rpc.writes[0].edits.length, 6);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.version, 3);
  assert.equal(state.fields.length, 5);
  assert.deepEqual(state.fields[4].original, { exists: false });
  assert.equal(JSON.stringify(installed).includes('private-capability'), false);
  assert.equal(JSON.stringify(installed).includes(context.options.gatewayKey), false);
  assert.equal((await integration.originalNativeProvider()).config.base_url, 'https://chatgpt.com/backend-api/codex');
  assert.equal((await integration.originalProvider()).config.base_url, original.model_providers.custom.base_url);
  const manifest = await readFile(statePath, 'utf8');
  rpc.config.model_reasoning_effort = 'low'; rpc.version++;
  const official = await integration.switchMode('official');
  assert.equal(official.routing.mode, 'official');
  assert.equal(official.routing.nativeThreadsCovered, false);
  assert.equal(official.installed, true);
  assert.equal(official.routing.canSwitchGateway, true);
  assert.deepEqual(rpc.config, { ...original, model_provider: 'openai', model_reasoning_effort: 'low' });
  assert.equal(await readFile(statePath, 'utf8'), manifest);
  const refreshed = nativeIntegration(context);
  await refreshed.switchMode('gateway');
  assert.equal(rpc.config.openai_base_url, privateNativeBase);
  assert.equal(rpc.config.model_providers.custom.model_catalog_url, `${context.options.baseUrl}/models`);
  const count = rpc.writes.length;
  await refreshed.switchMode('gateway'); assert.equal(rpc.writes.length, count);
  await refreshed.restore();
  assert.deepEqual(rpc.config, { ...original, model_reasoning_effort: 'low' });
});

test('an existing v2 gateway selection can upgrade in place without losing the custom baseline', async t => {
  const context = await setup(t);
  await context.integration.install();
  const oldManifest = JSON.parse(await readFile(context.statePath, 'utf8'));
  const integration = nativeIntegration(context);
  const before = await integration.inspect();
  assert.equal(before.needsUpgrade, true);
  assert.equal(before.routing.nativeThreadsSupported, true);
  assert.equal(before.routing.nativeThreadsCovered, false);
  assert.equal(before.routing.canSwitchGateway, true);
  const upgraded = await integration.switchMode('gateway');
  assert.equal(upgraded.needsUpgrade, false);
  assert.equal(upgraded.routing.nativeThreadsCovered, true);
  const state = JSON.parse(await readFile(context.statePath, 'utf8'));
  assert.deepEqual(state.fields.slice(0, 4), oldManifest.fields);
  assert.deepEqual(state.fields[4].original, { exists: false });
  assert.equal((await integration.originalProvider()).config.base_url, originalConfig().model_providers.custom.base_url);
  await integration.switchMode('official');
  assert.deepEqual(context.rpc.config, { ...originalConfig(), model_provider: 'openai' });
});

test('v1 and a previously selected official v2 mode migrate safely in either direction', async t => {
  for (const legacy of [true, false]) {
    const context = legacy ? await setupLegacy(t) : await setup(t);
    if (!legacy) { await context.integration.install(); await context.integration.switchMode('official'); }
    const integration = nativeIntegration(context);
    const result = await integration.switchMode(legacy ? 'official' : 'gateway');
    assert.equal(result.routing.mode, legacy ? 'official' : 'gateway');
    if (legacy) {
      assert.deepEqual(context.rpc.config, { ...originalConfig(), model_provider: 'openai' });
      await integration.switchMode('gateway');
    }
    assert.equal(context.rpc.config.openai_base_url, privateNativeBase);
    await integration.restore();
    assert.deepEqual(context.rpc.config, originalConfig());
  }
});

test('selecting official again upgrades legacy official mode and releases old custom routes idempotently', async t => {
  for (const version of [1, 2]) for (const lostResponse of [false, true]) {
    const original = originalConfig(); original.chatgpt_base_url = 'https://chat.openai.com/backend-api/';
    const context = version === 1 ? await setupLegacy(t, original) : await setup(t, original);
    if (version === 2) await context.integration.install();
    context.rpc.config.model_provider = 'openai'; context.rpc.version++;
    const before = JSON.parse(await readFile(context.statePath, 'utf8'));
    const integration = nativeIntegration(context);
    const status = await integration.inspect();
    assert.equal(status.routing.mode, 'official');
    assert.equal(status.needsUpgrade, true);
    assert.equal(status.routing.canSwitchOfficial, true);
    assert.equal((await integration.originalNativeProvider()).config.base_url, 'https://chat.openai.com/backend-api/codex');
    assert.equal((await integration.originalProvider()).config.base_url, original.model_providers.custom.base_url);
    if (lostResponse) {
      context.rpc.afterWrite = server => { server.afterWrite = null; throw new Error('lost official upgrade response'); };
      await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_WRITE_FAILED' });
    } else await integration.switchMode('official');
    const expected = { ...original, model_provider: 'openai' };
    assert.deepEqual(context.rpc.config, expected);
    const count = context.rpc.writes.length;
    const restarted = nativeIntegration(context);
    const complete = await restarted.switchMode('official');
    assert.equal(complete.routing.mode, 'official');
    assert.equal(complete.needsUpgrade, false);
    assert.equal(complete.routing.canSwitchOfficial, false);
    assert.equal(complete.routing.nativeThreadsCovered, false);
    assert.equal(context.rpc.writes.length, count);
    assert.deepEqual(context.rpc.config, expected);
    const saved = JSON.parse(await readFile(context.statePath, 'utf8'));
    assert.equal(saved.version, 3); assert.equal(saved.phase, 'installed');
    assert.equal(Object.hasOwn(saved, 'upgradeBaselineCount'), false);
    assert.deepEqual(saved.fields.slice(0, before.fields.length), before.fields);
    assert.deepEqual(await restarted.originalNativeProvider(), { providerId: 'openai', config: { base_url: 'https://chat.openai.com/backend-api/codex' } });
    assert.equal((await restarted.originalProvider()).config.base_url, original.model_providers.custom.base_url);
    await restarted.switchMode('official'); assert.equal(context.rpc.writes.length, count);
  }
});

test('native compatibility retains separate original native and custom routes including inherited roots', async t => {
  for (const inherited of [false, true]) {
    const original = originalConfig();
    const upstream = 'https://native-original.example.invalid/backend-api/codex';
    if (!inherited) original.openai_base_url = upstream;
    const context = await setup(t, original, inherited ? { openai_base_url: upstream } : {});
    const integration = nativeIntegration(context);
    await integration.install();
    assert.deepEqual(await integration.originalNativeProvider(), { providerId: 'openai', config: { base_url: upstream } });
    assert.equal((await integration.originalProvider()).config.base_url, original.model_providers.custom.base_url);
    if (inherited) {
      context.rpc.inherited.openai_base_url = 'https://updated-native.example.invalid/backend-api/codex';
      assert.equal((await integration.originalNativeProvider()).config.base_url, context.rpc.inherited.openai_base_url);
    }
    const restored = await integration.switchMode('official');
    assert.equal(restored.routing.mode, 'other');
    assert.equal(restored.routing.nativeSettingsRestored, true);
    assert.deepEqual(context.rpc.config, { ...original, model_provider: 'openai' });
    assert.equal(JSON.stringify(restored).includes('native-original'), false);
    await integration.restore();
    assert.deepEqual(context.rpc.config, { ...original, model_provider: 'openai' });
  }
  const original = originalConfig(); original.chatgpt_base_url = 'https://chat.openai.com/backend-api/';
  const context = await setup(t, original);
  assert.equal((await nativeIntegration(context).originalNativeProvider()).config.base_url, 'https://chat.openai.com/backend-api/codex');
});

test('native compatibility recovers committed writes and optimistic conflicts without recapturing originals', async t => {
  for (const legacy of [false, true]) {
    const context = await setup(t);
    if (legacy) await context.integration.install();
    const integration = nativeIntegration(context);
    context.rpc.beforeWrite = server => { server.config.model_reasoning_effort = 'low'; server.version++; server.beforeWrite = null; };
    await assert.rejects(legacy ? integration.switchMode('gateway') : integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
    const pending = JSON.parse(await readFile(context.statePath, 'utf8'));
    assert.equal(pending.phase, legacy ? 'upgrading' : 'prepared');
    assert.equal((await integration.inspect()).canInstall, true);
    context.rpc.afterWrite = server => { server.afterWrite = null; throw new Error('lost write after commit'); };
    await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
    const count = context.rpc.writes.length;
    await nativeIntegration(context).switchMode('gateway');
    assert.equal(context.rpc.writes.length, count);
    assert.equal(JSON.parse(await readFile(context.statePath, 'utf8')).phase, 'installed');
    context.rpc.afterWrite = server => { server.afterWrite = null; throw new Error('lost restore after commit'); };
    await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_WRITE_FAILED' });
    const officialCount = context.rpc.writes.length;
    await nativeIntegration(context).switchMode('official');
    assert.equal(context.rpc.writes.length, officialCount);
    assert.equal(context.rpc.config.openai_base_url, undefined);
    assert.equal(context.rpc.config.model_providers.custom.base_url, originalConfig().model_providers.custom.base_url);
    assert.equal(context.rpc.config.model_reasoning_effort, 'low');
  }
});

test('an interrupted native upgrade can restore before or after the config commit', async t => {
  for (const committed of [false, true]) {
    const context = await setupLegacy(t);
    const integration = nativeIntegration(context);
    const hook = committed ? 'afterWrite' : 'beforeWrite';
    context.rpc[hook] = server => { server[hook] = null; throw new Error('interrupted upgrade'); };
    await assert.rejects(integration.install(), { code: 'INTEGRATION_WRITE_FAILED' });
    assert.equal(JSON.parse(await readFile(context.statePath, 'utf8')).phase, 'upgrading');
    context.rpc.afterWrite = server => { server.afterWrite = null; throw new Error('lost restore response'); };
    await assert.rejects(nativeIntegration(context).restore(), { code: 'INTEGRATION_WRITE_FAILED' });
    assert.equal((await nativeIntegration(context).restore()).restored, true);
    assert.deepEqual(context.rpc.config, originalConfig());
  }
});

test('native compatibility refuses edited owned routes and higher-priority controls before writes', async t => {
  for (const key of ['openai_base_url', 'model_provider', 'custom']) {
    const context = await setup(t), integration = nativeIntegration(context);
    await integration.install();
    context.rpc.overrides = key === 'custom' ? { model_providers: { custom: { base_url: 'https://locked.invalid' } } }
      : { [key]: key === 'model_provider' ? 'custom' : 'https://locked.invalid' };
    const before = copy(context.rpc.config), count = context.rpc.writes.length;
    await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
    assert.deepEqual(context.rpc.config, before); assert.equal(context.rpc.writes.length, count);
  }
  for (const key of ['openai_base_url', 'custom']) {
    const context = await setup(t), integration = nativeIntegration(context);
    await integration.install();
    if (key === 'openai_base_url') context.rpc.config.openai_base_url = 'https://user-edit.invalid';
    else context.rpc.config.model_providers.custom.base_url = 'https://user-edit.invalid';
    context.rpc.version++;
    const before = copy(context.rpc.config);
    for (const mode of ['official', 'gateway']) await assert.rejects(integration.switchMode(mode), { code: 'INTEGRATION_CONFLICT' });
    await assert.rejects(integration.restore(), { code: 'INTEGRATION_CONFLICT' });
    assert.deepEqual(context.rpc.config, before);
    assert.equal(context.rpc.writes.length, 1);
    assert.equal(JSON.stringify(await integration.inspect()).includes('user-edit'), false);
  }
});

test('native mode reports a higher-priority route that arrives after a committed switch', async t => {
  const context = await setup(t), integration = nativeIntegration(context);
  await integration.install();
  context.rpc.afterWrite = server => { server.afterWrite = null; server.overrides = { openai_base_url: 'https://locked.invalid' }; };
  await assert.rejects(integration.switchMode('official'), { code: 'INTEGRATION_CONFLICT' });
  assert.equal((await integration.inspect()).routing.mode, 'other');
  assert.equal(context.rpc.config.model_provider, 'openai');
});

test('native original route rejects a bridge loop and changed credentials remain recoverable', async t => {
  const context = await setup(t), integration = nativeIntegration(context);
  await integration.install();
  const changed = new Integration({ ...context.options, nativeBaseUrl: privateNativeBase, gatewayKey: 'changed-key' });
  assert.equal((await changed.inspect()).canInstall, false);
  await assert.rejects(changed.switchMode('gateway'), { code: 'INTEGRATION_CONFLICT' });
  await changed.switchMode('official');
  await changed.restore();
  context.rpc.config.openai_base_url = privateNativeBase;
  await assert.rejects(integration.originalNativeProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
  assert.equal(JSON.stringify(await integration.inspect()).includes('private-capability'), false);
});

test('native upgrades reject known higher-priority roots and pre-existing loops before capturing a baseline', async t => {
  for (const legacy of [false, true]) {
    const context = await setup(t);
    if (legacy) await context.integration.install();
    context.rpc.overrides = { openai_base_url: 'https://higher-priority.invalid/backend-api/codex' };
    const integration = nativeIntegration(context), count = context.rpc.writes.length;
    await assert.rejects(legacy ? integration.switchMode('gateway') : integration.install(), { code: 'INTEGRATION_CONFLICT' });
    assert.equal(context.rpc.writes.length, count);
    if (legacy) assert.equal(JSON.parse(await readFile(context.statePath, 'utf8')).version, 2);
    else await assert.rejects(readFile(context.statePath), { code: 'ENOENT' });
  }
  const original = originalConfig(); original.openai_base_url = privateNativeBase;
  const context = await setup(t, original), integration = nativeIntegration(context);
  await assert.rejects(integration.install(), { code: 'INTEGRATION_CONFLICT' });
  assert.equal(context.rpc.writes.length, 0);
  await assert.rejects(readFile(context.statePath), { code: 'ENOENT' });
});

test('native recovery validates the manifest shape and an older optional adapter can still remove a v3 overlay', async t => {
  const context = await setup(t), integration = nativeIntegration(context);
  await integration.install();
  const manifest = JSON.parse(await readFile(context.statePath, 'utf8'));
  for (const mutate of [
    value => { value.fields[4].keyPath = 'unrelated'; },
    value => { value.fields[4].original.value = false; value.fields[4].original.exists = true; },
    value => { value.phase = 'upgrading'; value.upgradeBaselineCount = 5; },
    value => { value.upgradeBaselineCount = 4; },
  ]) {
    const corrupted = copy(manifest); mutate(corrupted);
    await writeFile(context.statePath, JSON.stringify(corrupted));
    await assert.rejects(integration.restore(), { code: 'INTEGRATION_STATE_INVALID' });
    assert.equal(context.rpc.writes.length, 1);
  }
  await writeFile(context.statePath, JSON.stringify(manifest));
  assert.equal((await context.integration.restore()).restored, true);
  assert.deepEqual(context.rpc.config, originalConfig());
});

test('concurrent native mode operations serialize and keep one baseline while preserving unrelated settings', async t => {
  const context = await setup(t), integration = nativeIntegration(context);
  await integration.install();
  const manifest = await readFile(context.statePath, 'utf8');
  const results = await Promise.all([integration.switchMode('official'), integration.switchMode('gateway'), integration.switchMode('official')]);
  assert.deepEqual(results.map(result => result.routing.mode), ['official', 'gateway', 'official']);
  assert.equal(await readFile(context.statePath, 'utf8'), manifest);
  assert.deepEqual(context.rpc.config, { ...originalConfig(), model_provider: 'openai' });
});

test('native and custom originals reject equivalent loopback bridge hosts before enabling gateway routes', async t => {
  for (const host of ['localhost', 'localhost.', '127.0.0.1', '127.1', '127.0.0.2', '[::1]', '[::ffff:127.0.0.1]']) {
    const alias = `http://${host}:19437/_bifrost/codex/private-capability/backend-api/codex`;
    const original = originalConfig(); original.openai_base_url = alias;
    const native = await setup(t, original), nativeControl = nativeIntegration(native);
    assert.equal((await nativeControl.inspect()).canInstall, false);
    await assert.rejects(nativeControl.originalNativeProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
    await assert.rejects(nativeControl.install(), { code: 'INTEGRATION_CONFLICT' });
    assert.equal(native.rpc.writes.length, 0);

    const customOriginal = originalConfig(); customOriginal.model_providers.custom.base_url = alias;
    const custom = await setupLegacy(t, customOriginal), customControl = nativeIntegration(custom);
    assert.equal((await customControl.inspect()).routing.canSwitchGateway, false);
    await assert.rejects(customControl.originalProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
    await assert.rejects(customControl.switchMode('gateway'), { code: 'INTEGRATION_CONFLICT' });
    assert.equal((await custom.integration.inspect()).routing.canSwitchGateway, false);
    await assert.rejects(custom.integration.originalProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
    assert.equal(custom.rpc.writes.length, 0);
  }
});

test('loopback protection preserves genuinely different ports and protocols and normalizes default ports', async t => {
  for (const address of ['http://localhost:19438/v1', 'http://[::1]:19438/v1', 'https://localhost:19437/v1']) {
    const original = originalConfig(); original.openai_base_url = address; original.model_providers.custom.base_url = address;
    const context = await setup(t, original), integration = nativeIntegration(context);
    assert.equal((await integration.inspect()).canInstall, true);
    await integration.install();
    assert.equal((await integration.originalProvider()).config.base_url, address);
    assert.equal((await integration.originalNativeProvider()).config.base_url, address);
    await integration.switchMode('official');
    assert.deepEqual(context.rpc.config, { ...original, model_provider: 'openai' });
  }
  const original = originalConfig(); original.openai_base_url = 'http://[::1]/backend-api/codex';
  const context = await setup(t, original);
  const integration = new Integration({ ...context.options, baseUrl: 'http://127.0.0.1:80/v1', nativeBaseUrl: 'http://127.0.0.1:80/native/private' });
  assert.equal((await integration.inspect()).canInstall, false);
  await assert.rejects(integration.originalNativeProvider(), { code: 'INTEGRATION_ORIGINAL_PROVIDER_UNAVAILABLE' });
  assert.equal(context.rpc.writes.length, 0);
});
