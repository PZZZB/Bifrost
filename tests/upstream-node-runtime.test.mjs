import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

const project = fileURLToPath(new URL('..', import.meta.url));
async function freePort() { const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }

test('a configured Claude node boots without Codex, discovers its own pool and preserves user Key and balance across restart', { timeout: 30000 }, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-node-runtime-'))), state = join(dir, 'state');
  await mkdir(state, { mode: 0o700 }); const web = join(dir, 'web'); await mkdir(web, { mode: 0o700 });
  const adminPort = await freePort(), userPort = await freePort(), userOrigin = `http://127.0.0.1:${userPort}`;
  const save = (path, data) => writeFile(path, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  const gatewayKey = randomBytes(32).toString('base64url'), sessionKey = randomBytes(32).toString('base64url');
  await save(join(dir, 'relay.key'), gatewayKey); await save(join(dir, 'session.key'), sessionKey); await save(join(web, 'csrf.key'), randomBytes(32).toString('base64url'));
  await save(join(dir, 'web.json'), { version: 1, directory: web, maxAccounts: 10, maxConcurrent: 1, requestsPerMinute: 20,
    publicOrigin: 'https://gateway.example.test', apiBaseUrl: 'https://gateway.example.test/v1' });
  await save(join(state, 'mac.json'), { version: 1, upstreamPort: 43157, gatewayKeyFile: join(dir, 'relay.key'),
    sessionKeyFile: join(dir, 'session.key'), webAccountsFile: join(dir, 'web.json') });
  await save(join(state, 'client-gateway.json'), { version: 1, enabled: true, listener: { address: '127.0.0.1', port: userPort,
    allowedHosts: [`127.0.0.1:${userPort}`] }, publicBaseUrl: userOrigin });
  // Historical foreign settings must not activate unrelated services in this node.
  await save(join(state, 'codebuddy.json'), { enabled: true }); await save(join(state, 'cursor.json'), { enabled: true });
  await save(join(state, 'model-policy.json'), { version: 1, revision: 1, disabledModels: [],
    models: [{ id: 'B-gpt-6.1-sol', name: 'Old unconfigured B model', channel: 'B' }] });
  const preload = join(dir, 'fixture-fetch.mjs');
  const catalogFile = join(dir, 'catalog.json');
  await save(catalogFile, { data: [{ id: 'claude-opus', display_name: 'Claude Opus' }, { id: 'claude-sonnet', display_name: 'Claude Sonnet' }] });
  await save(preload, `import{readFile}from'node:fs/promises';globalThis.fetch=async(url)=>{if(url==='http://127.0.0.1:43157/v1/models')return Response.json(JSON.parse(await readFile(${JSON.stringify(catalogFile)},'utf8')));throw new Error('Unexpected transport in isolated runtime test');};`);
  const root = `http://127.0.0.1:${adminPort}`; let child, cookie, csrf, output = '';
  const env = { PATH: process.env.PATH, BRIDGE_PORT: String(adminPort), BRIDGE_STATE_DIR: state,
    BRIDGE_CLIENT_CODEX_HOME: join(dir, 'unused-home'), BRIDGE_MAC_CLAUDE_CONFIG: join(state, 'mac.json'),
    CODEX_BINARY: join(dir, 'must-never-execute-codex') };
  const read = async (path, body) => {
    const response = await fetch(root + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { cookie, origin: root, 'content-type': 'application/json', 'x-bridge-csrf': csrf } });
    return { status: response.status, data: await response.json() };
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const current = child; current.kill('SIGTERM');
    await Promise.race([once(current, 'exit'), delay(3000).then(() => { if (current.exitCode === null) current.kill('SIGKILL'); })]); child = null; };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  async function start() {
    output = ''; child = spawn(process.execPath, ['--import', preload, join(project, 'src/main.mjs')], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(`Isolated node exited: ${output.slice(-1500)}`);
      try {
        const response = await fetch(root + '/'); cookie = response.headers.get('set-cookie').split(';')[0]; await response.text();
        const status = await (await fetch(root + '/api/status', { headers: { cookie } })).json(); csrf = status.csrfToken;
        if (status.node?.capabilities.userManagement) return status;
      } catch {} await delay(50);
    }
    assert.fail('Isolated node did not become ready.');
  }
  const initial = await start(); assert.equal(initial.backend, null); assert.equal(initial.integration, null); assert.equal(initial.ready, true);
  let pool = (await read('/api/upstream-accounts')).data;
  assert.deepEqual(pool.accounts.map(a => a.kind), ['claude']); assert.equal(pool.models.length, 2);
  assert.equal(pool.capabilities.clientIntegration, false); assert.deepEqual(pool.capabilities.activeKinds, ['claude']);
  assert.deepEqual((await read('/api/client-admin')).data.models.map(m => m.channel), ['Claude', 'Claude']);
  assert.doesNotMatch(JSON.stringify(pool), new RegExp(gatewayKey + '|' + sessionKey));
  for (const path of ['/api/codebuddy', '/api/cursor', '/api/integration', '/api/models']) assert.equal((await read(path)).status, 404);
  assert.equal((await read('/api/upstream-accounts', { kind: 'bifrost', name: 'Foreign', apiKey: 'bfk_' + 'x'.repeat(43) })).status, 400);
  assert.equal((await fetch(root + '/api/upstream-accounts')).status, 401);
  assert.equal((await fetch(root + '/api/upstream-accounts/legacy-claude', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  const created = await read('/api/client-admin/accounts', { username: 'pool-fixture', password: 'Local-fixture-password-0123', allowedModels: ['Claude-opus', 'Claude-sonnet'] });
  assert.equal(created.status, 200); const accountId = created.data.account.id;
  const issued = await read(`/api/client-admin/accounts/${accountId}/keys`, {}); assert.equal(issued.status, 200); const key = issued.data.secret;
  const userModels = async () => (await (await fetch(userOrigin + '/v1/models', { headers: { authorization: 'Bearer ' + key } })).json()).data;
  assert.equal((await userModels()).length, 2);
  assert.equal((await read(`/api/client-admin/accounts/${accountId}/billing`, { enforceBalance: true })).status, 200);
  assert.equal((await read('/api/client-admin/billing/prices', { model: 'Claude-opus', enabled: true,
    inputRateMicros: 1_000_000, cachedInputRateMicros: 1_000_000, outputRateMicros: 1_000_000,
    reserveInputTokens: 100, reserveOutputTokens: 20 })).status, 200);
  const noBalance = await fetch(userOrigin + '/v1/messages', { method: 'POST', headers: {
    authorization: 'Bearer ' + key, 'content-type': 'application/json',
  }, body: JSON.stringify({ model: 'Claude-opus', max_tokens: 16, messages: [{ role: 'user', content: 'No real upstream call' }] }) });
  assert.equal(noBalance.status, 402);
  assert.equal((await noBalance.json()).error.code, 'client_billing_balance_exhausted');
  const id = pool.accounts[0].id, oldRevision = pool.revision;
  const paused = await read(`/api/upstream-accounts/${id}`, { revision: oldRevision, enabled: false }); assert.equal(paused.status, 200);
  assert.equal((await userModels()).length, 0);
  const rejected = await fetch(userOrigin + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Claude-opus', max_tokens: 16, messages: [{ role: 'user', content: 'test' }] }) });
  assert.equal(rejected.status, 403); await rejected.text();
  assert.equal((await read(`/api/upstream-accounts/${id}`, { revision: oldRevision, name: 'Stale' })).status, 409);
  const restored = await read(`/api/upstream-accounts/${id}`, { revision: paused.data.revision, enabled: true, name: 'My isolated Claude' }); assert.equal(restored.status, 200);
  assert.equal((await userModels()).length, 2);
  const settings = await read('/api/model-settings'); assert.deepEqual(settings.data.models.map(m => m.id), ['Claude-opus', 'Claude-sonnet']);
  assert.equal(settings.data.discovery.Claude.state, 'ready'); assert.equal(settings.data.discovery.Claude.count, 2);
  assert.equal(settings.data.models[0].compatibility.mode, 'protocol-adapter');
  const selection = await read('/api/model-settings', { revision: settings.data.revision, disabledModels: ['Claude-opus'] }); assert.equal(selection.status, 200);
  assert.deepEqual((await userModels()).map(m => m.id), ['Claude-sonnet']);
  await save(catalogFile, { data: [{ id: 'claude-opus', display_name: 'Claude Opus' }, { id: 'claude-sonnet', display_name: 'Claude Sonnet' },
    { id: 'claude-haiku', display_name: 'Claude Haiku' }, { id: 'claude-fable-5-1-1m', display_name: 'Claude Fable' }] });
  const expanded = await read('/api/model-settings'); assert.equal(expanded.data.models.length, 4);
  for (const id of ['Claude-haiku', 'Claude-fable-5-1-1m']) assert.equal(expanded.data.models.find(m => m.id === id).enabled, false);
  assert.deepEqual((await userModels()).map(m => m.id), ['Claude-sonnet'], 'Newly discovered models do not gain permission or publication automatically');
  if (['darwin', 'win32'].includes(process.platform)) {
    const added = await read('/api/upstream-accounts', { kind: 'cursor', name: 'Independent Cursor' }); assert.equal(added.status, 200);
    assert.equal(added.data.accounts.find(a => a.kind === 'cursor').restartRequired, true);
  }
  const before = (await read('/api/client-admin')).data.accounts.find(a => a.id === accountId).billing;
  assert.equal(before.balanceMicros, 0); assert.equal(before.reservedMicros, 0);
  await stop(); await start(); pool = (await read('/api/upstream-accounts')).data;
  assert.equal(pool.accounts[0].name, 'My isolated Claude'); assert.equal(pool.accounts[0].id, id);
  assert.deepEqual((await userModels()).map(m => m.id), ['Claude-sonnet']);
  assert.equal((await read('/api/model-settings')).data.models.length, 4);
  if (['darwin', 'win32'].includes(process.platform)) {
    const cursor = await read('/api/cursor'); assert.equal(cursor.status, 200); assert.equal(cursor.data.configured, true); assert.equal(cursor.data.authReady, false);
  }
  const after = (await read('/api/client-admin')).data.accounts.find(a => a.id === accountId).billing;
  assert.deepEqual(after, before);
  for (const file of ['codebuddy-auth.dpapi.json', 'cursor-auth.dpapi.json', 'accounts/account-b/auth.json']) await assert.rejects(access(join(state, file)));
});
