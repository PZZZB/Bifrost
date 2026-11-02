import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { switchCodexMode } from '../scripts/switch-codex-mode.mjs';

const refuseConnection = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
const forbiddenRpc = () => { assert.fail('A running gateway must own configuration writes.'); };

async function fixture(t, { port = 43155 } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bifrost-codex-mode-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const home = join(stateDir, 'client-home');
  await mkdir(home);
  await mkdir(join(stateDir, 'service'));
  await writeFile(join(stateDir, 'service', 'service.json'), JSON.stringify({ Port: port, CodexHome: home, CodexBinary: 'fixture-codex' }));
  await writeFile(join(stateDir, 'bridge.json'), JSON.stringify({ gatewayKey: 'fixture-local-key-that-is-longer-than-forty-characters' }));
  const auth = '{"fixture":"private authentication canary"}\n';
  await writeFile(join(home, 'auth.json'), auth);
  return { stateDir, home, auth, options: { stateDir, env: {}, rpcFactory: forbiddenRpc } };
}

async function managementServer(t, { reject, supported = true, reportedMode, postClose = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/') {
      res.setHeader('set-cookie', ['unrelated=keep', 'bridge_session=fixture-session; HttpOnly; SameSite=Strict; Path=/']);
      res.end('<html>fixture</html>'); return;
    }
    assert.equal(req.headers.cookie, 'bridge_session=fixture-session');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/status') {
      res.end(JSON.stringify({ csrfToken: 'fixture-csrf', integration: { routing: { supported, mode: 'official' } } })); return;
    }
    assert.equal(req.url, '/api/integration/mode');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-bridge-csrf'], 'fixture-csrf');
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const { mode, ...extra } = JSON.parse(body);
    assert.deepEqual(extra, {});
    if (postClose) { req.socket.destroy(); return; }
    if (reject) { res.statusCode = reject.status; res.end(JSON.stringify({ error: reject.error })); return; }
    res.end(JSON.stringify({ routing: { mode: reportedMode ?? mode } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, calls };
}

function configRpc(home, { overridden = false, rejectWrite = false } = {}) {
  const config = { model_provider: 'custom', model: 'existing-model', notify: ['keep-command'],
    model_providers: { custom: { base_url: 'https://existing.example.invalid/v1', requires_openai_auth: true,
      http_headers: { 'X-Keep': 'private provider canary' } } } };
  const original = structuredClone(config), writes = [];
  const rpc = { config, original, writes, closed: false,
    async request(method, params) {
      if (method === 'config/read') return { config: { ...config, ...(overridden ? { model_provider: 'managed' } : {}) },
        layers: [...(overridden ? [{ name: { type: 'system' }, config: { model_provider: 'managed' } }] : []),
          { name: { type: 'user', file: join(home, 'config.toml') }, config: structuredClone(config), version: 'fixture-version' }] };
      assert.equal(method, 'config/batchWrite');
      assert.equal(params.expectedVersion, 'fixture-version');
      assert.equal(params.filePath, join(home, 'config.toml'));
      assert.equal(params.reloadUserConfig, false);
      if (rejectWrite) throw new Error('Concurrent native config edit.');
      writes.push(params.edits);
      for (const edit of params.edits) { assert.equal(edit.keyPath, 'model_provider'); config.model_provider = edit.value; }
      return { status: 'ok', filePath: join(home, 'config.toml') };
    },
    async close() { this.closed = true; },
  };
  return rpc;
}

test('shortcut uses the gateway session and CSRF, submitting only the selected mode', async t => {
  const { port, calls } = await managementServer(t);
  const { options } = await fixture(t, { port });
  assert.deepEqual(await switchCodexMode({ ...options, mode: 'gateway' }), {
    success: true, mode: 'gateway', changed: true, restartRequired: true, transport: 'management-api',
  });
  assert.deepEqual(calls, ['GET /', 'GET /api/status', 'POST /api/integration/mode']);
});

test('already selected official mode still obtains server confirmation', async t => {
  const { port } = await managementServer(t);
  const { options } = await fixture(t, { port });
  const result = await switchCodexMode({ ...options, mode: 'official' });
  assert.equal(result.changed, false);
  assert.equal(result.transport, 'management-api');
});

test('an older running gateway is not bypassed or restarted', async t => {
  const { port, calls } = await managementServer(t, { supported: false });
  const { options } = await fixture(t, { port });
  await assert.rejects(switchCodexMode({ ...options, mode: 'official' }), { code: 'mode_api_unavailable' });
  assert.deepEqual(calls, ['GET /', 'GET /api/status']);
});

for (const [name, status, code] of [['management conflict', 409, 'busy'], ['account validation refusal', 409, 'account_changed'], ['missing API', 404, 'not_found']]) {
  test(`${name} never falls back to a local write`, async t => {
    const { port } = await managementServer(t, { reject: { status, error: { message: 'Fixture refusal.', code } } });
    const { options } = await fixture(t, { port });
    await assert.rejects(switchCodexMode({ ...options, mode: 'official' }), { code });
  });
}

test('a mismatched confirmation is not reported as success', async t => {
  const { port } = await managementServer(t, { reportedMode: 'other' });
  const { options } = await fixture(t, { port });
  await assert.rejects(switchCodexMode({ ...options, mode: 'gateway' }), { code: 'mode_not_confirmed' });
});

test('disconnect during a write never retries or uses the offline fallback', async t => {
  const { port, calls } = await managementServer(t, { postClose: true });
  const { options } = await fixture(t, { port });
  await assert.rejects(switchCodexMode({ ...options, mode: 'official' }));
  assert.equal(calls.filter(call => call === 'POST /api/integration/mode').length, 1);
});

test('offline official switching preserves provider settings, authentication, and bridge state', async t => {
  const { options, stateDir, home, auth } = await fixture(t);
  const beforeState = await readFile(join(stateDir, 'bridge.json'), 'utf8');
  const rpc = configRpc(home);
  const result = await switchCodexMode({ ...options, mode: 'official', fetchImpl: refuseConnection,
    rpcFactory: settings => { assert.equal(settings.home, home); assert.equal(settings.binary, 'fixture-codex'); return rpc; } });
  assert.equal(result.transport, 'local-config');
  assert.equal(result.changed, true);
  assert.deepEqual(rpc.writes, [[{ keyPath: 'model_provider', value: 'openai', mergeStrategy: 'replace' }]]);
  assert.deepEqual(rpc.config, { ...rpc.original, model_provider: 'openai' });
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), auth);
  assert.equal(await readFile(join(stateDir, 'bridge.json'), 'utf8'), beforeState);
  assert.equal(rpc.closed, true);
});

test('offline gateway mode cannot bypass service/account checks', async t => {
  const { options } = await fixture(t);
  await assert.rejects(switchCodexMode({ ...options, mode: 'gateway', fetchImpl: refuseConnection }), { code: 'mode_gateway_offline' });
});

test('a timeout does not establish that the service is absent', async t => {
  const { options } = await fixture(t);
  await assert.rejects(switchCodexMode({ ...options, mode: 'official', fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }),
    { code: 'mode_connection_failed' });
});

for (const [name, rpcOptions, code] of [['higher-priority override', { overridden: true }, 'INTEGRATION_CONFLICT'],
  ['concurrent config write', { rejectWrite: true }, 'INTEGRATION_WRITE_FAILED']]) {
  test(`offline official mode respects ${name} and closes its native process`, async t => {
    const { options, home } = await fixture(t);
    const rpc = configRpc(home, rpcOptions);
    await assert.rejects(switchCodexMode({ ...options, mode: 'official', fetchImpl: refuseConnection, rpcFactory: () => rpc }), { code });
    assert.deepEqual(rpc.config, rpc.original);
    assert.equal(rpc.closed, true);
  });
}

test('invalid target is rejected before connecting or reading settings', async () => {
  await assert.rejects(switchCodexMode({ mode: 'invalid', stateDir: 'does-not-exist', fetchImpl: () => assert.fail('No request allowed.') }),
    { code: 'mode_invalid' });
});
