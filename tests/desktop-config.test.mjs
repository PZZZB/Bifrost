import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDesktop, loadDesktopIdentity, validateDesktopConfig } from '../src/runtime/desktop-config.mjs';

test('init stores secrets only through a protected store and never overwrites an existing identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let record = null;
  const store = { async load() { return structuredClone(record); }, async save(value) { record = structuredClone(value); } };
  const { identity, config } = await initializeDesktop(directory, { store });
  assert.match(identity.apiKey, /^bdk_/); assert.equal(config.port, 43160);
  assert.deepEqual(await loadDesktopIdentity(directory, store), identity);
  const publicConfig = await readFile(join(directory, 'desktop.json'), 'utf8');
  assert.equal(publicConfig.includes(identity.secret), false); assert.equal(publicConfig.includes(identity.apiKey), false);
  await assert.rejects(initializeDesktop(directory, { store }), /已初始化/);
});
test('config permits only explicit unique sources and never accepts inline secrets, listener hosts or arbitrary company destinations', () => {
  const config = { version: 1, port: 43160, sources: [{ id: 'codebuddy', kind: 'codebuddy-local' }] };
  assert.deepEqual(validateDesktopConfig(config), config);
  for (const bad of [{ ...config, host: '0.0.0.0' }, { ...config, sources: [config.sources[0], config.sources[0]] },
    { ...config, sources: [{ ...config.sources[0], baseUrl: 'https://arbitrary.test' }] },
    { ...config, sources: [{ id: 'bifrost', kind: 'bifrost-remote', baseUrl: 'https://mac.test/v1', protocols: ['messages'], apiKey: 'inline-secret' }] }]) assert.throws(() => validateDesktopConfig(bad));
});
