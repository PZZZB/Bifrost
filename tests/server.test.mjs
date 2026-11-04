import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from '../src/server.mjs';

async function fixture(t, extra = {}) {
  const state = { gatewayKey: 'private-gateway-key-test', enabled: false, pinnedAccount: null };
  const backend = { rpc: { running: true }, account: null, login: { state: 'idle' },
    readAccount: async () => null, publicBinding: () => null };
  const gateway = { metrics: { requests: 0, completed: 0, failed: 0 }, proxy: async (_req, res) => { res.end('gateway'); } };
  const integration = { inspect: async () => ({ installed: false, canInstall: true, configPath: 'test/config.toml', providerId: 'custom' }) };
  const server = createBridgeServer({ state, backend, gateway, integration,
    ...extra,
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), baseUrl: 'http://127.0.0.1:0/backend-api/codex' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = await fetch(`${url}/`);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const statusResponse = await fetch(`${url}/api/status`, { headers: { cookie } });
  const status = await statusResponse.json();
  return { url, cookie, status, root, backend, server };
}

test('management requires an HttpOnly session and does not publish gateway credentials in status', async (t) => {
  const { url, root, status } = await fixture(t);
  assert.match(root.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(root.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${url}/api/status`)).status, 401);
  assert.equal(status.ready, true);
  assert.ok(!JSON.stringify(status).includes('private-gateway-key-test'));
});

test('client account administration stays behind the local administrator cookie and CSRF gate', async t => {
  const calls=[];
  const {url,cookie,status}=await fixture(t,{clientAdmin:{snapshot:()=>({accounts:[],registration:{mode:'open'}}),
    mutate:async(path,body)=>{calls.push({path,body});return{account:{id:'safe-user'}};}}});
  assert.equal((await fetch(url+'/api/client-admin')).status,401);
  const headers={cookie,'X-Bridge-CSRF':status.csrfToken,'content-type':'application/json'};
  assert.deepEqual((await(await fetch(url+'/api/client-admin',{headers:{cookie}})).json()).accounts,[]);
  const path=url+'/api/client-admin/accounts';
  assert.equal((await fetch(path,{method:'POST',headers:{cookie},body:'{}'})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await fetch(path,{method:'POST',headers,body:'{"username":"sample"}'})).status,200);
  assert.deepEqual(calls,[{path:'/api/client-admin/accounts',body:{username:'sample'}}]);
});

test('node account administration uses the existing browser session, CSRF and origin boundary', async t => {
  const mutations = [];
  const accountPool = { capabilities: () => ({ clientIntegration: false, userManagement: false }),
    catalog: () => [], snapshot: async () => ({ accounts: [], accountTypes: [] }),
    create: async body => { mutations.push(body); return { accounts: [] }; },
    update: async (id, body) => { mutations.push({ id, body }); return { accounts: [] }; } };
  const { url, cookie, status } = await fixture(t, { backend: null, gateway: null, integration: null, accountPool });
  for (const path of ['/api/node', '/api/upstream-accounts', '/api/upstream-account-types']) {
    assert.equal((await fetch(url + path)).status, 401);
    assert.equal((await fetch(url + path, { headers: { cookie } })).status, 200);
  }
  const path = url + '/api/upstream-accounts';
  const headers = { cookie, 'X-Bridge-CSRF': status.csrfToken, 'content-type': 'application/json' };
  assert.equal((await fetch(path, { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  assert.deepEqual(mutations, []);
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{"kind":"codex","name":"fixture"}' })).status, 200);
  assert.equal((await fetch(path + '/fixture-account', { method: 'POST', headers, body: '{"revision":0,"enabled":false}' })).status, 200);
  assert.equal((await fetch(path + '/invalid%2Fpath', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal(mutations.length, 2);
  for (const legacy of ['/api/codebuddy', '/api/cursor', '/api/integration', '/api/login/start']) {
    assert.equal((await fetch(url + legacy, { headers: { cookie } })).status, 404);
  }
});

test('diagnostic history, detail and download require the local session and validate identifiers', async t => {
  const id = 'e053b2e4-d1a6-4b0e-b3ef-5df7c434aa34';
  const record = { requestId: id, account: 'CodeBuddy', model: 'safe-model', upstreamModel: 'actual-model',
    status: 'failed', httpStatus: 502, failureStage: 'upstream_request', errorCode: 'network_failed' };
  const reads = [];
  const { url, cookie } = await fixture(t, { requestDiagnostics: {
    snapshot: ({ limit }) => { reads.push(['list', limit]); return { recent: [record] }; },
    detail: value => { reads.push(['detail', value]); return value === id ? record : null; },
    exportReport: value => { reads.push(['export', value]); return value === id ? { version: 1, request: record } : null; },
  } });
  for (const path of ['/api/request-diagnostics', `/api/request-diagnostics/${id}`, `/api/request-diagnostics/${id}/export`]) {
    assert.equal((await fetch(url + path)).status, 401);
  }
  assert.deepEqual(reads, []);
  const headers = { cookie };
  assert.deepEqual((await (await fetch(`${url}/api/request-diagnostics?limit=7`, { headers })).json()).recent, [record]);
  assert.deepEqual(await (await fetch(`${url}/api/request-diagnostics/${id}`, { headers })).json(), { request: record });
  const exported = await fetch(`${url}/api/request-diagnostics/${id}/export`, { headers });
  assert.equal(exported.status, 200); assert.equal(exported.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(exported.headers.get('content-disposition'), `attachment; filename="bifrost-request-${id}.json"`);
  assert.deepEqual((await exported.json()).request, record);
  const before = reads.length;
  for (const suffix of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=bad']) {
    assert.equal((await fetch(`${url}/api/request-diagnostics${suffix}`, { headers })).status, 400);
  }
  assert.equal(reads.length, before);
  assert.equal((await fetch(`${url}/api/request-diagnostics/not-saved`, { headers })).status, 404);
  assert.equal((await fetch(`${url}/api/request-diagnostics/${id}/extra/path`, { headers })).status, 404);
});

test('queued restart cancellation is authenticated, does not activate restart, and reports committed transitions', async t => {
  let cancelled = 0, activated = 0, canCancel = true;
  const { url, cookie, status } = await fixture(t, { serviceControl: {
    cancel: async () => { cancelled++; return canCancel; }, activate: () => { activated++; },
  } });
  const path = `${url}/api/service/restart/cancel`;
  assert.equal((await fetch(path, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  const headers = { cookie, 'X-Bridge-CSRF': status.csrfToken };
  assert.equal((await fetch(path, { method: 'POST', headers, body: '{"command":"untrusted"}' })).status, 400);
  for (const body of ['null', '[]', '0', 'false']) assert.equal((await fetch(path, { method: 'POST', headers, body })).status, 400);
  assert.equal(cancelled, 0);
  assert.deepEqual(await (await fetch(path, { method: 'POST', headers, body: '{}' })).json(), { cancelled: true });
  assert.equal(cancelled, 1); assert.equal(activated, 0);
  canCancel = false;
  const committed = await fetch(path, { method: 'POST', headers, body: '{}' });
  assert.equal(committed.status, 409); assert.equal((await committed.json()).error.code, 'restart_committed');
});

test('draining blocks new account mutations while queued restart can still be cancelled', async t => {
  let logins = 0;
  const { url, cookie, status, server } = await fixture(t, { backend: { rpc: { running: true }, account: null, login: {},
    readAccount: async () => null, publicBinding: () => null, beginLogin: () => { logins++; } },
    serviceControl: { draining: true, cancel: async () => true } });
  const headers = { cookie, 'X-Bridge-CSRF': status.csrfToken };
  const blocked = await fetch(`${url}/api/login`, { method: 'POST', headers, body: '{}' });
  assert.equal(blocked.status, 503); assert.equal((await blocked.json()).error.code, 'gateway_restarting');
  assert.equal(logins, 0); assert.equal(server.activeAdminOperations, 0);
  assert.equal((await fetch(`${url}/api/service/restart/cancel`, { method: 'POST', headers, body: '{}' })).status, 200);
});

test('idle accounting includes account writes but excludes the service control acknowledgement itself', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let managedServer;
  const page = await fixture(t, { backend: { rpc: { running: true }, account: null, login: {},
    readAccount: async () => null, publicBinding: () => null, beginLogin: async () => { entered(); await gate; return { url: 'https://auth.openai.com/' }; } },
    serviceControl: { request: async body => { assert.deepEqual(body, { mode: 'when-idle' }); assert.equal(managedServer.activeAdminOperations, 0); return { accepted: true }; },
      activate: async () => {} } });
  managedServer = page.server;
  const headers = { cookie: page.cookie, 'X-Bridge-CSRF': page.status.csrfToken };
  const login = fetch(`${page.url}/api/login`, { method: 'POST', headers, body: '{}' }); await started;
  assert.equal(page.server.activeAdminOperations, 1);
  release(); assert.equal((await login).status, 200); assert.equal(page.server.activeAdminOperations, 0);
  const queued = await fetch(`${page.url}/api/service/restart`, { method: 'POST', headers, body: '{"mode":"when-idle"}' });
  assert.equal(queued.status, 202); assert.equal(page.server.activeAdminOperations, 0);
});

test('CSRF and cross-origin requests cannot change login or configuration', async (t) => {
  const { url, cookie, status } = await fixture(t);
  const missing = await fetch(`${url}/api/login`, { method: 'POST', headers: { cookie }, body: '{}' });
  assert.equal(missing.status, 403);
  const crossOrigin = await fetch(`${url}/api/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken, Origin: 'https://external.invalid' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
});

test('service restart requires the management session and CSRF, and acknowledgement precedes activation', async t => {
  let requested = 0, activated = 0;
  const { url, cookie, status } = await fixture(t, { serviceControl: {
    status: async () => ({ supported: true, activeRequests: 0 }),
    request: async body => { assert.deepEqual(body, { allowInterrupt: false }); requested++; return { accepted: true }; },
    activate: async () => { activated++; }, cancel: () => {},
  } });
  assert.equal((await fetch(`${url}/api/service/status`)).status, 401);
  assert.equal((await fetch(`${url}/api/service/restart`, { method: 'POST', headers: { cookie }, body: '{"allowInterrupt":false}' })).status, 403);
  assert.equal(requested, 0); assert.equal(activated, 0);
  const response = await fetch(`${url}/api/service/restart`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"allowInterrupt":false}' });
  assert.equal(response.status, 202); assert.equal((await response.json()).accepted, true);
  assert.equal(requested, 1); assert.equal(activated, 1);
});

test('model settings and Cursor account mutations share local authentication and do not run inference', async t => {
  let saved = 0, logins = 0;
  const settings = { revision: 1, models: [{ id: 'a-model', name: 'A model', channel: 'A', enabled: true }] };
  const { url, cookie, status } = await fixture(t, {
    modelPolicy: { snapshot: () => settings, update: async body => { assert.deepEqual(body, { revision: 1, disabledModels: ['a-model'] }); saved++; return { ...settings, revision: 2 }; } },
    cursorService: { status: async () => ({ authReady: false }), logout: async () => ({ ok: true }),
      beginLogin: async () => { logins++; return { url: 'https://cursor.com/login' }; } },
  });
  for (const path of ['/api/model-settings', '/api/cursor']) assert.equal((await fetch(`${url}${path}`)).status, 401);
  for (const path of ['/api/model-settings', '/api/cursor/login']) {
    assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  }
  assert.equal(saved + logins, 0);
  assert.deepEqual(await (await fetch(`${url}/api/model-settings`, { headers: { cookie } })).json(), settings);
  const auth = { cookie, 'X-Bridge-CSRF': status.csrfToken };
  const savedResponse = await fetch(`${url}/api/model-settings`, { method: 'POST', headers: auth,
    body: JSON.stringify({ revision: 1, disabledModels: ['a-model'] }) });
  assert.equal(savedResponse.status, 200); assert.equal((await savedResponse.json()).revision, 2);
  const loginResponse = await fetch(`${url}/api/cursor/login`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(loginResponse.status, 200); assert.equal((await loginResponse.json()).url, 'https://cursor.com/login');
  assert.equal(saved, 1); assert.equal(logins, 1);
});

test('the authenticated model-settings GET discovers complete account directories without a Codex model request', async t => {
  let discoveryCalls = 0;
  const snapshot = { available: true, revision: 4, disabledModels: ['Cursor-new'],
    models: [{ id: 'Cursor-new', name: 'Cursor New', channel: 'Cursor', enabled: false, available: true }] };
  const { url, cookie } = await fixture(t, { modelPolicy: { snapshot: () => ({ ...snapshot, models: [] }) },
    modelDiscovery: { refresh: async () => { discoveryCalls++; return snapshot; } } });
  assert.equal((await fetch(`${url}/api/model-settings`)).status, 401); assert.equal(discoveryCalls, 0);
  assert.deepEqual(await (await fetch(`${url}/api/model-settings`, { headers: { cookie } })).json(), snapshot);
  assert.equal(discoveryCalls, 1);
});

test('the B verification selector refreshes the complete directory with the current client version and exposes only public labels', async t => {
  const calls = [], models = ['B-gpt-6-astra', 'B-gpt-6.1-sol', 'B-gpt-directory-extra'];
  const { url, cookie } = await fixture(t, { clientVersion: '0.166.0-alpha.5.1', gateway: {
    metrics: {}, async refreshBModels(options) {
      calls.push(options);
      return models.map(slug => ({ slug, display_name: `Public ${slug}`, base_instructions: 'PRIVATE B INSTRUCTIONS' }));
    },
  } });
  assert.equal((await fetch(`${url}/api/models`)).status, 401); assert.deepEqual(calls, []);
  const response = await fetch(`${url}/api/models`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: models.map(id => ({ id, name: `Public ${id}` })) });
  assert.deepEqual(calls, [{ path: '/models?client_version=0.166.0', force: true }]);
});

test('local client controls use the administrator session and CSRF gate without exposing model credentials', async t => {
  const mutations = [];
  const snapshot = { version: 1, clients: [{ id: 'codebuddy', name: 'CodeBuddy', mode: 'native' }] };
  const { url, cookie, status } = await fixture(t, { clientControls: {
    snapshot: async () => snapshot,
    mutate: async (...args) => { mutations.push(args); return snapshot; },
  } });
  assert.equal((await fetch(url + '/api/client-controls')).status, 401);
  const read = await (await fetch(url + '/api/client-controls', { headers: { cookie } })).json();
  assert.equal(read.clients[0].mode, 'native'); assert.equal(read.csrfToken, status.csrfToken);
  assert.deepEqual(mutations, []);
  const path = url + '/api/client-controls/codebuddy/sync';
  assert.equal((await fetch(path, { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);
  const result = await fetch(path, { method: 'POST', headers: { cookie, 'x-bridge-csrf': status.csrfToken }, body: '{}' });
  assert.equal(result.status, 200); assert.equal((await result.json()).csrfToken, status.csrfToken);
  assert.deepEqual(mutations, [['codebuddy', 'sync', {}]]);
});

test('the unified Codex gateway action retains the original bound-account verification requirement', async t => {
  const mutations = [];
  const backend = { rpc: { running: true }, account: null, login: {}, readAccount: async () => null, publicBinding: () => null,
    credentials: async () => ({ accountId: 'workspace-b', email: 'fixture@example.test' }) };
  const { url, cookie, status } = await fixture(t, { backend, clientControls: {
    snapshot: async () => ({ version: 1, clients: [] }),
    mutate: async (...args) => { mutations.push(args); return { version: 1, clients: [] }; },
  } });
  const path = url + '/api/client-controls/codex/mode';
  const headers = { cookie, 'x-bridge-csrf': status.csrfToken, 'content-type': 'application/json' };
  const denied = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ mode: 'gateway' }) });
  assert.equal(denied.status, 409); assert.deepEqual(mutations, []);
  const restored = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ mode: 'native' }) });
  assert.equal(restored.status, 200); assert.deepEqual(mutations, [['codex', 'mode', { mode: 'native' }]]);
});

test('quota API combines every bound provider without replacing the native account windows', async t => {
  let nativeReads = 0, externalReads = 0;
  const native = { A: { status: 'ok', windows: [{ remainingPercent: 25 }] }, B: { status: 'ok', windows: [{ remainingPercent: 90 }] } };
  const external = { CodeBuddy: { status: 'unknown', authenticated: true, identity: 'Employee', windows: [], credits: null },
    Cursor: { status: 'unknown', authenticated: true, identity: 'Cursor user', windows: [], credits: null },
    Bifrost: { status: 'partial', authenticated: true, sources: [
      { id: 'home', status: 'ok', wallet: { currency: 'CNY', availableMicros: 9_000_000 } },
      { id: 'office', status: 'unknown', wallet: null },
    ] } };
  const { url, cookie } = await fixture(t, { accountQuotas: { snapshot: async () => { nativeReads++; return { timeZone: 'America/Los_Angeles', accounts: native }; } },
    providerQuotas: { snapshot: async () => { externalReads++; return { accounts: external }; } } });
  assert.equal((await fetch(`${url}/api/account-quotas`)).status, 401); assert.equal(nativeReads + externalReads, 0);
  const snapshot = await (await fetch(`${url}/api/account-quotas`, { headers: { cookie } })).json();
  assert.deepEqual(snapshot.accounts, { ...native, ...external }); assert.equal(nativeReads, 1); assert.equal(externalReads, 1);
});

test('quota combination clears a changed external identity while awaiting slower native quota reads', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const cursorService = { authorizationVersion: 0 };
  const { url, cookie } = await fixture(t, { cursorService,
    accountQuotas: { snapshot: async () => { await gate; return { accounts: { A: { status: 'ok', windows: [] } } }; } },
    providerQuotas: { snapshot: async () => { entered(); return { accounts: { Cursor: { status: 'unknown', identity: 'OLD_PRIVATE_IDENTITY', authenticated: true, windows: [] } } }; } },
  });
  const pending = fetch(`${url}/api/account-quotas`, { headers: { cookie } }); await started;
  cursorService.authorizationVersion++; release(); const data = await (await pending).json();
  assert.equal(data.accounts.Cursor.status, 'error'); assert.equal(data.accounts.Cursor.identity, null);
  assert.equal(JSON.stringify(data).includes('OLD_PRIVATE_IDENTITY'), false); assert.equal(data.accounts.A.status, 'ok');
});

test('quota combination clears a changed B binding while awaiting a slower external card', async t => {
  let entered, release, binding = 'old';
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { url, cookie } = await fixture(t, { accountQuotas: { bindingKey: () => binding,
    snapshot: async () => { entered(); return { accounts: { B: { status: 'ok', identity: 'OLD_B', windows: [{ remainingPercent: 99 }] } } }; } },
    providerQuotas: { snapshot: async () => { await gate; return { accounts: { Cursor: { status: 'unknown', identity: 'Current Cursor' } } }; } },
  });
  const pending = fetch(`${url}/api/account-quotas`, { headers: { cookie } }); await started;
  binding = 'new'; release(); const data = await (await pending).json();
  assert.equal(data.accounts.B.status, 'error'); assert.equal(data.accounts.B.identity, null); assert.deepEqual(data.accounts.B.windows, []);
  assert.equal(data.accounts.Cursor.identity, 'Current Cursor');
});

test('remote-only nodes expose read-only account quotas through the existing browser session without native integration', async t => {
  let reads = 0;
  const remote = { status: 'ok', authenticated: true, sources: [{ id: 'home', identity: 'remote.owner',
    wallet: { currency: 'CNY', balanceMicros: 10_000_000, reservedMicros: 1_000_000, availableMicros: 9_000_000 } }] };
  const accountPool = { capabilities: () => ({ clientIntegration: false, userManagement: false }), catalog: () => [],
    snapshot: async () => ({ accounts: [{ id: 'registered-remote', kind: 'bifrost', enabled: true }], accountTypes: [] }),
    rows: () => [{ id: 'registered-remote', kind: 'bifrost', enabled: true }] };
  const { url, cookie } = await fixture(t, { backend: null, gateway: null, integration: null, accountPool,
    providerQuotas: { snapshot: async () => { reads++; return { accounts: { Bifrost: remote } }; } } });
  assert.equal((await fetch(`${url}/api/account-quotas`)).status, 401); assert.equal(reads, 0);
  const response = await fetch(`${url}/api/account-quotas`, { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual((await response.json()).accounts.Bifrost, remote); assert.equal(reads, 1);
});

test('quota combination clears old remote identities and wallets if their binding changes while native quotas wait', async t => {
  let entered, release, binding = 'original';
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { url, cookie } = await fixture(t, {
    accountQuotas: { snapshot: async () => { await gate; return { accounts: { A: { status: 'ok', windows: [{ remainingPercent: 25 }] } } }; } },
    providerQuotas: { bindingKey: account => account === 'Bifrost' ? binding : undefined,
      snapshot: async () => { entered(); return { accounts: { Bifrost: { status: 'ok', authenticated: true, sources: [
        { id: 'home', identity: 'OLD_REMOTE_PRIVATE_IDENTITY', wallet: { currency: 'CNY', availableMicros: 9_999_999 } },
      ] } } }; } },
  });
  const pending = fetch(`${url}/api/account-quotas`, { headers: { cookie } }); await started;
  binding = 'replacement'; release();
  const data = await (await pending).json();
  assert.equal(data.accounts.Bifrost.status, 'error'); assert.equal(data.accounts.Bifrost.identity, null);
  assert.deepEqual(data.accounts.Bifrost.sources, []); assert.equal(data.accounts.Bifrost.fetchedAt, null);
  assert.doesNotMatch(JSON.stringify(data), /OLD_REMOTE_PRIVATE_IDENTITY|9999999/);
  assert.deepEqual(data.accounts.A.windows, [{ remainingPercent: 25 }]);
});

test('a client disappearing before the restart acknowledgement cancels the prepared request', async t => {
  let started, finishRequest, cancelled;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finishRequest = resolve; });
  const cancelDone = new Promise(resolve => { cancelled = resolve; });
  let activated = 0;
  const { url, cookie, status } = await fixture(t, { serviceControl: {
    request: async () => { started(); await gate; return { accepted: true }; },
    activate: async () => { activated++; }, cancel: () => { cancelled(); },
  } });
  const controller = new AbortController();
  const sending = fetch(`${url}/api/service/restart`, { method: 'POST', signal: controller.signal,
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"allowInterrupt":false}' });
  await began; controller.abort(); await assert.rejects(sending);
  // Wait until the socket's close event is observed, then finish preparation.
  await new Promise(resolve => setTimeout(resolve, 10)); finishRequest();
  await Promise.race([cancelDone, new Promise((_, reject) => setTimeout(() => reject(new Error('Restart cancellation timed out.')), 1000).unref())]);
  assert.equal(activated, 0);
});

test('unexpected Host headers are rejected before account operations', async (t) => {
  const { url } = await fixture(t);
  // Node's fetch normalizes Host; use the raw HTTP client to exercise rebinding.
  const statusCode = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/`, { headers: { Host: 'rebind.invalid' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(statusCode, 403);
});

test('configuration containing gateway key is only available inside the local management session', async (t) => {
  const { url, cookie } = await fixture(t);
  assert.equal((await fetch(`${url}/api/integration`)).status, 401);
  const response = await fetch(`${url}/api/integration`, { headers: { cookie } });
  const data = await response.json();
  assert.equal(data.gatewayKey, 'private-gateway-key-test');
  assert.match(data.toml, /model_providers\."custom"/);
});

test('copied gateway settings target a custom provider while official mode is selected', async t => {
  for (const entry of [
    { providerId: 'openai', gatewayProviderId: 'saved_gateway', expected: 'saved_gateway' },
    { providerId: 'custom', gatewayProviderId: null, expected: 'custom' },
    { providerId: 'openai', gatewayProviderId: null, expected: 'account_b' },
    { providerId: 'ollama', gatewayProviderId: 'openai', expected: 'account_b' },
    { providerId: 'invalid\nprovider', gatewayProviderId: 'lmstudio', expected: 'account_b' },
  ]) await t.test(`${JSON.stringify(entry.providerId)} / ${JSON.stringify(entry.gatewayProviderId)}`, async t => {
    const { url, cookie } = await fixture(t, { integration: { inspect: async () => ({
      providerId: entry.providerId, routing: { gatewayProviderId: entry.gatewayProviderId },
    }) } });
    const response = await fetch(`${url}/api/integration`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const { toml } = await response.json();
    assert.match(toml, new RegExp(`^\\[model_providers\\.${JSON.stringify(entry.expected)}\\]`));
    assert.doesNotMatch(toml, /model_providers\."(?:openai|ollama|lmstudio)"/);
  });
});

test('Codex connection switching requires the local session, CSRF, and a local request origin', async t => {
  const switched = [];
  const integration = { inspect: async () => ({ installed: true }),
    switchMode: async mode => { switched.push(mode); return { routing: { mode } }; } };
  const { url, cookie, status } = await fixture(t, { integration });
  const send = headers => fetch(`${url}/api/integration/mode`, { method: 'POST', headers,
    body: '{"mode":"official"}' });
  assert.equal((await send({ 'X-Bridge-CSRF': status.csrfToken })).status, 401);
  assert.equal((await send({ cookie })).status, 403);
  assert.equal((await send({ cookie, 'X-Bridge-CSRF': status.csrfToken,
    Origin: 'https://external.invalid' })).status, 403);
  assert.equal((await send({ cookie, 'X-Bridge-CSRF': status.csrfToken,
    'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.deepEqual(switched, []);
  const response = await send({ cookie, 'X-Bridge-CSRF': status.csrfToken, Origin: url });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { routing: { mode: 'official' } });
  assert.deepEqual(switched, ['official']);
});

test('Codex connection switching rejects malformed, unknown, and oversized input before reading credentials or writing', async t => {
  const { url, cookie, status, backend } = await fixture(t, { integration: {
    inspect: async () => ({ installed: true }), switchMode: () => assert.fail('invalid input must not write config'),
  } });
  backend.credentials = () => assert.fail('invalid input must not read credentials');
  const headers = { cookie, 'X-Bridge-CSRF': status.csrfToken, 'Content-Type': 'application/json' };
  const send = body => fetch(`${url}/api/integration/mode`, { method: 'POST', headers, body });
  for (const body of ['', '{}', 'null', '[]', '1', 'false', '"official"', '{',
    '{"mode":null}', '{"mode":1}', '{"mode":"custom"}', '{"mode":"OPENAI"}',
    '{"mode":"official","providerId":"untrusted"}', '{"mode":"gateway","base_url":"https://external.invalid"}']) {
    assert.equal((await send(body)).status, 400, body);
  }
  const oversized = JSON.stringify({ mode: 'official', padding: 'x'.repeat(64 * 1024) });
  assert.equal((await send(oversized)).status, 413);
});

test('switching Codex to official works without account B, verification, or an upstream request', async t => {
  const modes = [];
  const expected = { installed: true, canInstall: false, routing: { supported: true,
    mode: 'official', providerId: 'openai', gatewayProviderId: 'custom', canSwitchOfficial: false, canSwitchGateway: true } };
  const { url, cookie, status } = await fixture(t, {
    backend: { rpc: { running: false }, account: null, login: { state: 'idle' }, publicBinding: () => null,
      readAccount: async () => { throw new Error('B is offline'); },
      credentials: () => assert.fail('official mode must not require account B') },
    integration: { inspect: async () => ({ installed: true }),
      switchMode: async mode => { modes.push(mode); return expected; } },
    fetchImpl: () => assert.fail('connection switching must not run inference'),
  });
  assert.equal(status.ready, false);
  const response = await fetch(`${url}/api/integration/mode`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"official"}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(modes, ['official']);
});

test('switching Codex to the gateway requires a bound account and verification for that exact account', async t => {
  const token = { email: 'account-b@example.invalid', accountId: 'current-b' };
  for (const scenario of [
    { name: 'unbound', authenticated: false, verification: { status: 'passed', accountId: token.accountId, accountEmail: token.email } },
    { name: 'not verified', authenticated: true, verification: { status: 'not_run' } },
    { name: 'different account', authenticated: true, verification: { status: 'passed', accountId: 'old-b', accountEmail: token.email } },
    { name: 'different identity', authenticated: true, verification: { status: 'passed', accountId: token.accountId, accountEmail: 'old-b@example.invalid' } },
    { name: 'current account', authenticated: true, verification: { status: 'passed', accountId: token.accountId, accountEmail: token.email }, allowed: true },
  ]) await t.test(scenario.name, async t => {
    const modes = [];
    const expected = { installed: true, routing: { supported: true, mode: 'gateway', providerId: 'custom' } };
    const { url, cookie, status, backend } = await fixture(t, { initialVerification: scenario.verification,
      integration: { inspect: async () => ({ installed: true }),
        switchMode: async mode => { modes.push(mode); return expected; } },
      fetchImpl: () => assert.fail('switching uses prior verification, never new inference') });
    backend.credentials = async () => {
      if (!scenario.authenticated) throw Object.assign(new Error('Bind B first.'), { status: 409 });
      return token;
    };
    const response = await fetch(`${url}/api/integration/mode`, { method: 'POST',
      headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"gateway"}' });
    assert.equal(response.status, scenario.allowed ? 200 : 409);
    assert.deepEqual(modes, scenario.allowed ? ['gateway'] : []);
    if (scenario.allowed) assert.deepEqual(await response.json(), expected);
  });
});

test('official mode stays available during B verification while gateway mode waits for its result', { timeout: 2000 }, async t => {
  let started, release, saved;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const completed = new Promise(resolve => { saved = resolve; });
  t.after(() => release());
  const token = { email: 'account-b@example.invalid', accountId: 'current-b' };
  const switched = [];
  const { url, cookie, status, backend } = await fixture(t, {
    integration: { inspect: async () => ({ installed: true }),
      switchMode: async mode => { switched.push(mode); return { routing: { mode } }; } },
    fetchImpl: async () => { started(); await gate; return new Response(
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"content":[{"type":"output_text","text":"Verified"}]}]}}\n\n'); },
    saveVerification: async result => { saved(result); },
  });
  backend.credentials = async () => token;
  backend.limits = async () => null;
  const headers = { cookie, 'X-Bridge-CSRF': status.csrfToken };
  const verifying = await fetch(`${url}/api/verify`, { method: 'POST', headers, body: '{}' });
  assert.equal(verifying.status, 202); await began;
  const send = mode => fetch(`${url}/api/integration/mode`, { method: 'POST', headers, body: JSON.stringify({ mode }) });
  assert.equal((await send('gateway')).status, 409);
  assert.deepEqual(switched, []);
  assert.equal((await send('official')).status, 200);
  assert.deepEqual(switched, ['official']);
  release(); assert.equal((await completed).status, 'passed');
});

test('Codex connection conflicts keep their error code without exposing private error detail', async t => {
  let fail = true;
  const { url, cookie, status } = await fixture(t, { integration: {
    inspect: async () => ({ installed: true }),
    switchMode: async mode => {
      if (fail) throw Object.assign(new Error('SECRET_PROVIDER_DETAIL private-gateway-key-test'), { code: 'INTEGRATION_CONFLICT' });
      return { routing: { mode } };
    },
  } });
  const send = () => fetch(`${url}/api/integration/mode`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"official"}' });
  const response = await send();
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.equal(data.error.code, 'INTEGRATION_CONFLICT');
  assert.equal(JSON.stringify(data).includes('SECRET_PROVIDER_DETAIL'), false);
  assert.equal(JSON.stringify(data).includes('private-gateway-key-test'), false);
  fail = false;
  assert.equal((await send()).status, 200);
});

test('Codex connection failures report an unavailable configuration without leaking internal errors', async t => {
  let code = 'INTEGRATION_CONFIG_UNAVAILABLE';
  const { url, cookie, status } = await fixture(t, { integration: {
    inspect: async () => ({ installed: true }),
    switchMode: async () => { throw Object.assign(new Error('SECRET_PROVIDER_DETAIL'), { code }); },
  } });
  for (const next of ['INTEGRATION_CONFIG_UNAVAILABLE', 'INTEGRATION_STATE_INVALID', 'INTEGRATION_WRITE_FAILED', 'PRIVATE_UNEXPECTED_CODE']) {
    code = next;
    const response = await fetch(`${url}/api/integration/mode`, { method: 'POST',
      headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"official"}' });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.error.code, next.startsWith('INTEGRATION_') ? next : 'integration_switch_failed');
    assert.equal(JSON.stringify(data).includes('SECRET_PROVIDER_DETAIL'), false);
    assert.equal(JSON.stringify(data).includes('PRIVATE_UNEXPECTED_CODE'), false);
  }
});

test('Codex connection switching reports a missing backend capability before reading B credentials', async t => {
  const { url, cookie, status, backend } = await fixture(t);
  backend.credentials = () => assert.fail('missing capability must not read credentials');
  const response = await fetch(`${url}/api/integration/mode`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"gateway"}' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'integration_mode_unavailable');
});

test('Codex connection writes use the shared management lock and release it after completion', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const modes = [];
  const { url, cookie, status, server } = await fixture(t, { integration: {
    inspect: async () => ({ installed: true }),
    switchMode: async mode => { modes.push(mode); entered(); await gate; return { routing: { mode } }; },
  } });
  const send = () => fetch(`${url}/api/integration/mode`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{"mode":"official"}' });
  const pending = send(); await started;
  assert.equal(server.activeAdminOperations, 1);
  assert.equal((await send()).status, 409);
  assert.deepEqual(modes, ['official']);
  release(); assert.equal((await pending).status, 200);
  assert.equal(server.activeAdminOperations, 0);
  assert.equal((await send()).status, 200);
});

test('device login is forwarded only after validating the requested mode', async (t) => {
  const { url, cookie, status, backend } = await fixture(t);
  let requested;
  backend.beginLogin = async (options) => {
    requested = options;
    return { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
  };
  const send = (deviceCode) => fetch(`${url}/api/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: JSON.stringify({ deviceCode }) });
  assert.equal((await send('true')).status, 400);
  assert.equal(requested, undefined);
  const response = await send(true);
  assert.equal(response.status, 200);
  assert.deepEqual(requested, { deviceCode: true });
  assert.equal((await response.json()).userCode, 'ABCD-1234');
});

test('token history is only available to the local management session', async t => {
  const snapshot = { totals: { inputTokens: 42 }, accounts: { A: {}, B: {} }, recent: [] };
  const { url, cookie } = await fixture(t, { usageLedger: { snapshot: () => snapshot } });
  assert.equal((await fetch(`${url}/api/token-usage`)).status, 401);
  const response = await fetch(`${url}/api/token-usage`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...snapshot, error: null });
});

test('account quotas require the local management session and only call the read-only quota service', async t => {
  let reads = 0;
  const snapshot = { timeZone: 'America/Los_Angeles', accounts: {
    A: { status: 'ok', windows: [{ label: '周额度', remainingPercent: 28 }] },
    B: { status: 'error', error: '账号 B 额度暂时无法读取。', windows: [] },
  } };
  const accountQuotas = { snapshot: async () => { reads++; return snapshot; } };
  const { url, cookie } = await fixture(t, { accountQuotas });
  assert.equal((await fetch(`${url}/api/account-quotas`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/account-quotas`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('With status requires the local session and does not run inference', async t => {
  let reads = 0;
  const snapshot = { configured: true, running: true, manualVerification: true,
    provider: { authenticated: true }, model: { id: 'claude-opus-5-5' } };
  const { url, cookie } = await fixture(t, { getWithStatus: async () => { reads++; return snapshot; } });
  assert.equal((await fetch(`${url}/api/with`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/with`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('an unconfigured CodeBuddy channel has a readable status and actionable login errors', async t => {
  const { url, cookie, status } = await fixture(t);
  const response = await fetch(`${url}/api/codebuddy`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, false);
  assert.equal(data.running, false);
  assert.equal(data.model.id, 'claude-codebuddy-opus-5-5');
  assert.equal(data.manualVerification, true);
  assert.equal(data.provider.billing.employeeTokenMultiplier, null);
  for (const operation of ['login', 'logout']) {
    const response = await fetch(`${url}/api/codebuddy/${operation}`, { method: 'POST',
      headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /CodeBuddy 通道尚未配置/);
  }
});

test('CodeBuddy status is session protected and only reads the service status', async t => {
  let reads = 0;
  const snapshot = { configured: true, running: true, manualVerification: true,
    provider: { authenticated: true, ready: true, modelAvailable: true,
      billing: { verified: false, employeeTokenMultiplier: null, sourceCredits: 2, sourcePromotion: 'catalog value' } },
    model: { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' } };
  const codeBuddyService = { status: async () => { reads++; return snapshot; },
    beginLogin: () => assert.fail('status must not start login'),
    request: () => assert.fail('status must not run inference') };
  const { url, cookie } = await fixture(t, { codeBuddyService });
  assert.equal((await fetch(`${url}/api/codebuddy`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${url}/api/codebuddy`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
  assert.equal(reads, 1);
});

test('CodeBuddy login and gateway-only logout use the existing session and CSRF checks', async t => {
  let logins = 0, logouts = 0;
  const login = { url: 'https://copilot.tencent.com/login?state=mock', expiresAt: '2026-10-19T20:00:00.000Z' };
  const initialVerification = { status: 'passed', accountEmail: 'account-b@example.invalid' };
  const codeBuddyService = { status: () => ({ configured: true }),
    beginLogin: async () => { logins++; return { ...login, accessToken: 'PRIVATE_SERVICE_ONLY' }; },
    logout: async () => { logouts++; } };
  const { url, cookie, status, backend } = await fixture(t, { codeBuddyService, initialVerification });
  backend.logout = () => assert.fail('CodeBuddy logout must not log out account B');
  const send = (operation, headers) => fetch(`${url}/api/codebuddy/${operation}`, {
    method: 'POST', headers, body: '{}' });
  for (const operation of ['login', 'logout']) {
    assert.equal((await send(operation, { 'X-Bridge-CSRF': status.csrfToken })).status, 401);
    assert.equal((await send(operation, { cookie })).status, 403);
    assert.equal((await send(operation, { cookie, 'X-Bridge-CSRF': status.csrfToken, Origin: 'https://external.invalid' })).status, 403);
  }
  assert.equal(logins, 0);
  assert.equal(logouts, 0);
  const response = await send('login', { cookie, 'X-Bridge-CSRF': status.csrfToken });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), login);
  assert.deepEqual(await (await send('logout', { cookie, 'X-Bridge-CSRF': status.csrfToken })).json(), { ok: true });
  assert.equal(logins, 1);
  assert.equal(logouts, 1);
  const after = await (await fetch(`${url}/api/status`, { headers: { cookie } })).json();
  assert.deepEqual(after.verification, initialVerification);
});

test('CodeBuddy failures leave existing status endpoints and later management actions usable', async t => {
  let attempts = 0;
  const codeBuddyService = { status: () => { throw new Error('CodeBuddy status unavailable'); },
    beginLogin: async () => { if (++attempts === 1) throw new Error('CodeBuddy login unavailable');
      return { url: 'https://copilot.tencent.com/login', expiresAt: null }; } };
  const { url, cookie, status } = await fixture(t, { codeBuddyService });
  assert.equal((await fetch(`${url}/api/codebuddy`, { headers: { cookie } })).status, 500);
  assert.equal((await fetch(`${url}/api/status`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${url}/api/with`, { headers: { cookie } })).status, 200);
  const login = () => fetch(`${url}/api/codebuddy/login`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
  assert.equal((await login()).status, 500);
  assert.equal((await login()).status, 200);
});

test('concurrent CodeBuddy session changes use the shared management lock', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let logouts = 0;
  const codeBuddyService = { beginLogin: async () => { started(); await pending;
    return { url: 'https://copilot.tencent.com/login', expiresAt: null }; },
  logout: async () => { logouts++; } };
  const { url, cookie, status } = await fixture(t, { codeBuddyService });
  const send = operation => fetch(`${url}/api/codebuddy/${operation}`, { method: 'POST',
    headers: { cookie, 'X-Bridge-CSRF': status.csrfToken }, body: '{}' });
  const first = send('login');
  await entered;
  assert.equal((await send('logout')).status, 409);
  assert.equal(logouts, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await send('logout')).status, 200);
  assert.equal(logouts, 1);
});
