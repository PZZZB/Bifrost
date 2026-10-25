import test from 'node:test';
import assert from 'node:assert/strict';
import { EmployeeOAuthClient } from '../src/employee-oauth.mjs';

const now = 1000000;
const token = { accessToken: 'private-access', refreshToken: 'private-refresh', expiresIn: 3600 };
const employee = { idp: 'ioa_auth', uid: 'employee-1', enterpriseUserName: 'employee', pluginEnabled: true, lastLogin: true,
  enterpriseId: 'enterprise-1', tenantId: 'tenant-1' };
const login = { state: 'nonce', expiresAt: now + 300000 };
const reply = (data, code = 0) => Response.json({ code, data });

test('Desktop may disable inference replay after 401 without changing the default Server policy', async () => {
  const requests = [];
  const value = new EmployeeOAuthClient({ now: () => now, retryUnauthorizedInference: false,
    loadAuth: async () => ({ version: 1, auth: { ...token, expiresAt: now + 3600000 }, identity: employee }),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(null, { status: 401 }); } });
  const response = await value.chatCompletions({ body: { model: 'test-model', stream: true } });
  assert.equal(response.status, 401); assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  assert.throws(() => new EmployeeOAuthClient({ retryUnauthorizedInference: 'false' }));
});

function client(steps) {
  const requests = [];
  const value = new EmployeeOAuthClient({ now: () => now, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const next = steps.shift();
    assert.ok(next, `unexpected request: ${url.pathname}`);
    return typeof next === 'function' ? next(url, options) : next;
  } });
  return { value, requests };
}

test('login URL stays on the official HTTPS host and keeps the server state', async () => {
  for (const authUrl of ['https://untrusted.example/login', 'http://copilot.tencent.com/login',
    'https://copilot.tencent.com/login?state=another']) {
    const { value } = client([reply({ state: 'nonce', authUrl })]);
    await assert.rejects(value.begin(), /invalid_login_url|login_state_mismatch/);
  }
  const { value, requests } = client([reply({ state: 'nonce', authUrl: 'https://copilot.tencent.com/login?state=nonce' })]);
  assert.equal((await value.begin()).state, 'nonce');
  assert.equal(requests[0].url.href, 'https://copilot.tencent.com/v2/plugin/auth/state?platform=ide');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.headers['User-Agent'], 'Bifrost/0.1.0 (compatible; CodeBuddy/4.12.2)');
});

test('account selection can remain pending after token exchange without exchanging again', async () => {
  const { value, requests } = client([reply(null, 11217), reply(token), reply(null, 12151), reply(employee)]);
  assert.equal((await value.poll(login)).stage, 'login');
  assert.equal((await value.poll(login)).stage, 'account');
  const result = await value.poll(login);
  assert.equal(result.identity.uid, 'employee-1');
  assert.equal(requests.filter((r) => r.url.pathname.endsWith('/auth/token')).length, 2);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('non-employee identity cannot become an authenticated session', async () => {
  const { value } = client([reply(token), reply({ idp: 'wechat', uid: 'external' })]);
  await assert.rejects(value.poll(login), /employee_account_required/);
  await assert.rejects(value.refresh(), /not_authenticated/);
});

test('concurrent refresh calls rotate once and validate the same employee', async () => {
  const rotated = { ...token, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' };
  const { value, requests } = client([reply(token), reply(employee), reply(rotated), reply({ accounts: [employee] })]);
  await value.poll(login);
  const results = await Promise.all([value.refresh(), value.refresh()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(requests.filter((r) => r.url.pathname.endsWith('/refresh')).length, 1);
  const refresh = requests[2].options.headers;
  assert.equal(refresh['X-Refresh-Token'], 'private-refresh');
  assert.equal(refresh.Authorization, undefined);
  assert.equal(requests[3].options.headers.Authorization, 'Bearer rotated-access');
  assert.equal(JSON.stringify(results).includes('rotated-'), false);
});

test('a different identity after rotation invalidates the local session', async () => {
  const { value } = client([reply(token), reply(employee), reply(token),
    reply({ accounts: [{ ...employee, uid: 'employee-2' }] })]);
  await value.poll(login);
  await assert.rejects(value.refresh(), /identity_changed/);
  await assert.rejects(value.refresh(), /not_authenticated/);
});

test('invalid rotated credentials cannot cause reuse of the previous refresh token', async () => {
  const { value, requests } = client([reply(token), reply(employee), reply({ ...token, expiresIn: -1 })]);
  await value.poll(login);
  await assert.rejects(value.refresh(), /invalid_token_expiry/);
  await assert.rejects(value.refresh(), /not_authenticated/);
  assert.equal(requests.length, 3);
});

test('errors do not include credential values or remote response bodies', async () => {
  const { value } = client([reply(token), reply(employee), new Response('private-refresh', { status: 401 })]);
  await value.poll(login);
  await assert.rejects(value.refresh(), (error) => error.status === 401 && !String(error).includes('private-refresh'));
  await assert.rejects(value.refresh(), /not_authenticated/);
});

test('expired login does not make a network request', async () => {
  const { value, requests } = client([]);
  await assert.rejects(value.poll({ ...login, expiresAt: now }), /login_expired/);
  assert.equal(requests.length, 0);
});

const stored = (auth = token, identity = employee) => ({ version: 1,
  auth: { accessToken: auth.accessToken, refreshToken: auth.refreshToken, expiresAt: now + 3600000,
    domain: 'copilot.tencent.com', ...auth }, identity: { idp: identity.idp, uid: identity.uid, username: 'employee',
    enterpriseId: identity.enterpriseId, tenantId: identity.tenantId } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('new OAuth is saved only after employee validation and restored privately by a new client', async () => {
  let cache = null;
  const first = new EmployeeOAuthClient({ now: () => now, saveAuth: async record => { cache = structuredClone(record); },
    fetchImpl: async url => url.pathname.endsWith('/auth/token') ? reply({ ...token, unnecessary: 'discarded' }) : reply(employee) });
  await first.poll(login);
  assert.deepEqual(Object.keys(cache.auth).sort(), ['accessToken', 'domain', 'expiresAt', 'refreshToken']);
  assert.deepEqual(Object.keys(cache.identity).sort(), ['enterpriseId', 'idp', 'tenantId', 'uid', 'username']);
  const requests = [];
  const second = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => cache,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return reply({ models: [{ id: 'claude-opus-5.5' }], unrelated: 'not-exported' });
    } });
  assert.deepEqual(await second.status(), { authenticated: true,
    identity: { idp: 'ioa_auth', uid: 'employee-1', username: 'employee', enterpriseId: 'enterprise-1', tenantId: 'tenant-1' },
    expiresAt: now + 3600000 });
  assert.deepEqual(await second.modelCatalog(), { models: [{ id: 'claude-opus-5.5' }], source: 'remote', liveVerified: true });
  assert.equal(requests[0].url.href, 'https://copilot.tencent.com/v3/config');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-access');
  assert.equal(requests[0].options.headers['X-User-Id'], 'employee-1');
  assert.equal(requests[0].options.headers['X-Domain'], 'copilot.tencent.com');
  assert.equal(requests[0].options.headers['X-Enterprise-Id'], 'enterprise-1');
  assert.equal(requests[0].options.headers['X-Tenant-Id'], 'tenant-1');
  assert.equal(requests[0].options.headers['User-Agent'], 'Bifrost/0.1.0 (compatible; CodeBuddy/4.12.2)');
  assert.equal(requests[0].options.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(await second.status()), /private-|unnecessary/);
});

test('status alone restores expired cached OAuth before any model request', async () => {
  const requests = [], saved = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored({ ...token, expiresAt: now - 1 }),
    saveAuth: async record => saved.push(record), fetchImpl: async url => {
      requests.push(url.pathname);
      if (url.pathname.endsWith('/refresh')) return reply({ ...token, accessToken: 'fresh-access' });
      if (url.pathname.endsWith('/accounts')) return reply({ accounts: [employee] });
      return reply({ models: [] });
    } });
  assert.equal((await value.status()).authenticated, true);
  assert.deepEqual(requests, ['/v2/plugin/auth/token/refresh', '/v2/plugin/accounts']);
  await value.modelCatalog();
  assert.deepEqual(requests, ['/v2/plugin/auth/token/refresh', '/v2/plugin/accounts', '/v3/config']);
  assert.equal(saved[0].auth.accessToken, 'fresh-access');
  assert.equal((await value.status()).authenticated, true);
});

test('logout during cache restoration prevents a later authenticated model request', async () => {
  const restored = deferred();
  let requests = 0;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => restored.promise,
    fetchImpl: async () => { requests++; throw new Error('must not call'); } });
  const catalog = value.modelCatalog();
  const logout = value.logout();
  restored.resolve(stored());
  await logout;
  await assert.rejects(catalog, error => error.code === 'not_authenticated' || error.code === 'aborted');
  assert.equal(requests, 0);
  assert.deepEqual(await value.status(), { authenticated: false, identity: null, expiresAt: null });
});

test('status alone refreshes expired cached credentials and a rejected refresh clears the cache', async () => {
  const paths = [], saved = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored({ ...token, expiresAt: now - 1 }),
    saveAuth: async record => saved.push(record), fetchImpl: async url => {
      paths.push(url.pathname);
      return new Response('mock rejected credential', { status: 401 });
    } });
  await assert.rejects(value.status(), error => error.status === 401);
  assert.deepEqual(paths, ['/v2/plugin/auth/token/refresh']);
  assert.deepEqual(saved, [null]);
  assert.deepEqual(await value.status(), { authenticated: false, identity: null, expiresAt: null });
});

test('catalog and chat share one refresh at the sixty-second boundary', async () => {
  let clock = now;
  const requests = [];
  const value = new EmployeeOAuthClient({ now: () => clock, loadAuth: async () => stored(), fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.pathname.endsWith('/refresh')) return reply({ ...token, accessToken: 'fresh-access' });
    if (url.pathname.endsWith('/accounts')) return reply({ accounts: [employee] });
    if (url.pathname === '/v3/config') return reply({ models: [] });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  await value.status();
  clock += 3540000;
  const [, response] = await Promise.all([value.modelCatalog(), value.chatCompletions({
    body: { model: 'claude-opus-5.5', stream: true, messages: [{ role: 'user', content: 'mock only' }] } })]);
  assert.equal(requests.filter(item => item.url.pathname.endsWith('/refresh')).length, 1);
  const chat = requests.find(item => item.url.pathname === '/v2/chat/completions');
  assert.equal(chat.options.method, 'POST');
  assert.equal(chat.url.href, 'https://copilot.tencent.com/v2/chat/completions');
  assert.equal(chat.options.headers.Authorization, 'Bearer fresh-access');
  assert.equal(chat.options.headers['X-Enterprise-Id'], 'enterprise-1');
  assert.equal(chat.options.headers['X-Tenant-Id'], 'tenant-1');
  assert.equal(chat.options.headers['User-Agent'], 'Bifrost/0.1.0 (compatible; CodeBuddy/4.12.2)');
  assert.equal(chat.options.headers.Accept, 'text/event-stream');
  assert.equal(chat.options.signal, undefined, 'A short metadata timeout must not terminate a model stream.');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /DONE/);
});

test('one HTTP 401 refreshes and retries the fixed request only once', async () => {
  const requests = [], saved = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), saveAuth: async record => saved.push(record),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname.endsWith('/refresh')) return reply({ ...token, accessToken: 'fresh-access' });
      if (url.pathname.endsWith('/accounts')) return reply({ accounts: [employee] });
      return new Response('unauthorized', { status: 401 });
    } });
  const response = await value.chatCompletions({ body: { model: 'claude-opus-5.5', stream: true, messages: [] } });
  assert.equal(response.status, 401);
  assert.equal(requests.filter(item => item.url.pathname.endsWith('/chat/completions')).length, 2);
  assert.equal(requests.filter(item => item.url.pathname.endsWith('/refresh')).length, 1);
  assert.equal((await value.status()).authenticated, false);
  assert.equal(saved.at(-1), null);
});

test('model calls bind to the validated employee identity before sending any prompt', async () => {
  const requests = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
    fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response('data: [DONE]\n\n'); } });
  const body = { model: 'claude-opus-5.5', stream: true, messages: [{ role: 'user', content: 'mock only' }] };
  await assert.rejects(value.chatCompletions({ body, expectedIdentity: 'another-employee' }), /identity_changed/);
  assert.equal(requests.length, 0);
  const response = await value.chatCompletions({ body, expectedIdentity: employee.uid });
  await response.text();
  assert.equal(requests.length, 1); assert.equal(requests[0].options.headers['X-User-Id'], employee.uid);
  assert.equal(JSON.parse(requests[0].options.body).expectedIdentity, undefined);
});

test('late concurrent 401 reuses an already-rotated credential without rotating twice', async () => {
  const late = deferred(), submitted = deferred();
  let oldRequests = 0, refreshes = 0;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), fetchImpl: async (url, options) => {
    if (url.pathname.endsWith('/refresh')) { refreshes++; return reply({ ...token, accessToken: 'fresh-access' }); }
    if (url.pathname.endsWith('/accounts')) return reply({ accounts: [employee] });
    if (options.headers.Authorization === 'Bearer private-access') {
      if (++oldRequests === 2) { submitted.resolve(); return late.promise; }
      return new Response('', { status: 401 });
    }
    return reply({ models: [] });
  } });
  const first = value.modelCatalog(), second = value.modelCatalog();
  await submitted.promise;
  await first;
  late.resolve(new Response('', { status: 401 }));
  await second;
  assert.equal(refreshes, 1);
});

test('a successful stream is never replayed when its body later fails', async () => {
  let requests = 0;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), fetchImpl: async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('mock stream disconnected')); } }));
  } });
  const response = await value.chatCompletions({ body: { model: 'claude-opus-5.5', stream: true } });
  await assert.rejects(response.text(), /mock stream disconnected/);
  assert.equal(requests, 1);
});

test('logout while employee verification is pending cannot save or restore the old login', async () => {
  const account = deferred(), submitted = deferred(), saved = [];
  const value = new EmployeeOAuthClient({ now: () => now, saveAuth: async record => saved.push(record), fetchImpl: async url => {
    if (url.pathname.endsWith('/auth/token')) return reply(token);
    submitted.resolve(); return account.promise;
  } });
  const pending = value.poll(login);
  await submitted.promise;
  await value.logout();
  account.resolve(reply(employee));
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.deepEqual(saved, [null]);
  assert.deepEqual(await value.status(), { authenticated: false, identity: null, expiresAt: null });
});

test('logout during token refresh prevents follow-up account calls and credential resurrection', async () => {
  const refreshed = deferred(), submitted = deferred(), saved = [], paths = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), saveAuth: async record => saved.push(record),
    fetchImpl: async url => { paths.push(url.pathname); submitted.resolve(); return refreshed.promise; } });
  const pending = value.refresh();
  await submitted.promise;
  await value.logout();
  refreshed.resolve(reply({ ...token, accessToken: 'new-access' }));
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.deepEqual(paths, ['/v2/plugin/auth/token/refresh']);
  assert.deepEqual(saved, [null]);
  assert.equal((await value.status()).identity, null);
});

test('logout clears a save already in flight after that save finishes', async () => {
  const saving = deferred(), continueSave = deferred();
  let cache = stored();
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => cache, saveAuth: async record => {
    if (record) { saving.resolve(); await continueSave.promise; }
    cache = record;
  }, fetchImpl: async url => url.pathname.endsWith('/refresh') ? reply(token) : reply({ accounts: [employee] }) });
  const pending = value.refresh();
  await saving.promise;
  const logout = value.logout();
  continueSave.resolve();
  await assert.rejects(pending, error => error.code === 'aborted');
  await logout;
  assert.equal(cache, null);
  assert.equal((await value.status()).authenticated, false);
});

test('an aborted poll cannot publish or save a newly validated identity', async () => {
  const abort = new AbortController(), saved = [];
  const value = new EmployeeOAuthClient({ now: () => now, saveAuth: async record => saved.push(record), fetchImpl: async url => {
    if (url.pathname.endsWith('/auth/token')) return reply(token);
    abort.abort(); return reply(employee);
  } });
  await assert.rejects(value.poll(login, { signal: abort.signal }), error => error.code === 'aborted');
  assert.deepEqual(saved, []);
  assert.equal((await value.status()).authenticated, false);
});

test('cache failures expose only stable error codes and an explicit login can replace a broken cache', async () => {
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => { throw new Error('private-refresh'); },
    fetchImpl: async url => url.pathname.endsWith('/auth/state') ? reply({ state: 'nonce', authUrl: 'https://copilot.tencent.com/login?state=nonce' }) :
      url.pathname.endsWith('/auth/token') ? reply(token) : reply(employee) });
  await assert.rejects(value.status(), error => error.code === 'credential_load_failed' && !String(error).includes('private-refresh'));
  const started = await value.begin();
  await value.poll(started);
  assert.equal((await value.status()).authenticated, true);
});

test('nonstream or invalid chat input cannot reach any model endpoint', async () => {
  const { value, requests } = client([]);
  await assert.rejects(value.chatCompletions({ body: { model: 'claude-opus-5.5', stream: false } }), /stream_required/);
  await assert.rejects(value.chatCompletions({ body: null }), /invalid_chat_request/);
  assert.equal(requests.length, 0);
});

test('OAuth and catalog metadata keep a deadline even when the caller supplies its own signal', async () => {
  for (const operation of ['begin', 'modelCatalog']) {
    const caller = new AbortController();
    let received;
    const value = new EmployeeOAuthClient({ now: () => now, requestTimeoutMs: 15,
      loadAuth: async () => operation === 'modelCatalog' ? stored() : null,
      fetchImpl: async (_url, options) => {
        received = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      } });
    // Keep the event loop alive while AbortSignal.timeout's unref'd deadline fires.
    const keepAlive = setTimeout(() => {}, 500);
    try { await assert.rejects(value[operation]({ signal: caller.signal }), error => error.code === 'timeout'); }
    finally { clearTimeout(keepAlive); }
    assert.notEqual(received, caller.signal);
    assert.equal(received.aborted, true);
    assert.equal(caller.signal.aborted, false);
  }
});

test('model POST preserves the caller signal without adding the metadata deadline', async () => {
  const caller = new AbortController();
  let received;
  const value = new EmployeeOAuthClient({ now: () => now, requestTimeoutMs: 1, loadAuth: async () => stored(),
    fetchImpl: async (_url, options) => { received = options.signal; return new Response('mock SSE'); } });
  const response = await value.chatCompletions({ body: { model: 'claude-opus-5.5', stream: true }, signal: caller.signal });
  assert.equal(received, caller.signal);
  assert.equal(await response.text(), 'mock SSE');
});

test('a new begin permanently supersedes the previous login object before polling', async () => {
  const requests = [];
  let sequence = 0;
  const value = new EmployeeOAuthClient({ now: () => now, fetchImpl: async url => {
    requests.push(url.pathname);
    if (url.pathname.endsWith('/auth/state')) {
      const state = `nonce-${++sequence}`;
      return reply({ state, authUrl: `https://copilot.tencent.com/login?state=${state}` });
    }
    return url.pathname.endsWith('/auth/token') ? reply(token) : reply(employee);
  } });
  const old = await value.begin();
  const current = await value.begin();
  await assert.rejects(value.poll(old), error => error.code === 'login_superseded');
  assert.deepEqual(requests, ['/v2/plugin/auth/state', '/v2/plugin/auth/state']);
  assert.equal((await value.poll(current)).pending, false);
});

test('late successful model responses after logout or caller cancellation are discarded and cancelled', async () => {
  for (const method of ['modelCatalog', 'chatCompletions']) {
    for (const stop of ['logout', 'abort']) {
      const response = deferred(), submitted = deferred(), abort = new AbortController();
      let cancelled = false;
      const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), fetchImpl: async () => {
        submitted.resolve(); return response.promise;
      } });
      const pending = method === 'modelCatalog' ? value.modelCatalog({ signal: abort.signal }) : value.chatCompletions({
        body: { model: 'claude-opus-5.5', stream: true }, signal: abort.signal });
      await submitted.promise;
      if (stop === 'logout') await value.logout(); else abort.abort();
      response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }));
      await assert.rejects(pending, error => error.code === 'aborted');
      assert.equal(cancelled, true, `${method}/${stop} left its late response body open.`);
    }
  }
});

test('catalog parsed after logout cannot publish the previous account model list', async () => {
  const parsed = deferred(), submitted = deferred();
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), fetchImpl: async () => ({
    ok: true, status: 200, json() { submitted.resolve(); return parsed.promise; },
  }) });
  const pending = value.modelCatalog();
  await submitted.promise;
  await value.logout();
  parsed.resolve({ code: 0, data: { models: [{ id: 'old-account-model' }] } });
  await assert.rejects(pending, error => error.code === 'aborted');
});

test('verified optional account identifiers are normalized and only whitelisted fields persist', async () => {
  let saved;
  const value = new EmployeeOAuthClient({ now: () => now, saveAuth: async record => { saved = record; }, fetchImpl: async url =>
    url.pathname.endsWith('/auth/token') ? reply(token) : reply({ ...employee, enterpriseId: 123, tenantId: 456,
      department: 'not-needed', unrelated: 'not-persisted' }) });
  await value.poll(login);
  assert.deepEqual(saved.identity, { idp: 'ioa_auth', uid: 'employee-1', username: 'employee', enterpriseId: '123', tenantId: '456' });
  for (const field of ['enterpriseId', 'tenantId']) {
    for (const invalid of [{ secret: 'not-an-id' }, Number.MAX_SAFE_INTEGER + 1, '..', 'bad\r\nHeader: injected']) {
      const { value } = client([reply(token), reply({ ...employee, [field]: invalid })]);
      await assert.rejects(value.poll(login), error => /^invalid_(enterprise|tenant)_id$/.test(error.code));
      assert.equal((await value.status()).authenticated, false);
    }
  }
});

test('older cached OAuth backfills only the same current enabled employee without refresh or writes', async () => {
  const cache = stored(), requests = [], saved = [];
  delete cache.identity.enterpriseId;
  delete cache.identity.tenantId;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => cache,
    saveAuth: async record => saved.push(record), fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname.endsWith('/accounts')) return reply({ accounts: [
        { ...employee, uid: 'another-employee', enterpriseId: 'wrong-enterprise' },
        { ...employee, idp: 'wechat', enterpriseId: 'wrong-enterprise' },
        { ...employee, pluginEnabled: false, enterpriseId: 'wrong-enterprise' },
        { ...employee, lastLogin: false, enterpriseId: 'wrong-enterprise' }, employee,
      ] });
      return reply({ models: [{ id: 'mock-model' }] });
    } });
  assert.equal((await value.status()).authenticated, true);
  assert.equal(requests.length, 0, 'A fresh access token does not need refreshing for status.');
  await value.modelCatalog();
  await value.modelCatalog();
  assert.deepEqual(requests.map(item => item.url.pathname), ['/v2/plugin/accounts', '/v3/config', '/v3/config']);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-access');
  assert.equal(requests[0].options.headers['User-Agent'], 'Bifrost/0.1.0 (compatible; CodeBuddy/4.12.2)');
  for (const item of requests.slice(1)) {
    assert.equal(item.options.headers['X-Enterprise-Id'], 'enterprise-1');
    assert.equal(item.options.headers['X-Tenant-Id'], 'tenant-1');
    assert.equal(item.options.headers['X-User-Id'], 'employee-1');
    assert.equal(item.options.headers['X-Product'], undefined);
  }
  assert.deepEqual(saved, []);
  assert.equal(cache.identity.enterpriseId, undefined);
  assert.equal((await value.status()).identity.enterpriseId, 'enterprise-1');
});

test('an absent optional tenant defaults its request header to the verified enterprise without changing identity', async () => {
  const withoutTenant = { ...employee, tenantId: undefined };
  const requests = [];
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(token, withoutTenant),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname.endsWith('/accounts')) return reply({ accounts: [withoutTenant] });
      return url.pathname.endsWith('/chat/completions') ? new Response('mock SSE') : reply({ models: [] });
    } });
  await value.modelCatalog();
  await value.chatCompletions({ body: { model: 'mock-model', stream: true } });
  assert.equal(requests.filter(item => item.url.pathname.endsWith('/accounts')).length, 1);
  for (const item of requests.slice(1)) {
    assert.equal(item.options.headers['X-Enterprise-Id'], 'enterprise-1');
    assert.equal(item.options.headers['X-Tenant-Id'], 'enterprise-1');
  }
  assert.equal(Object.hasOwn((await value.status()).identity, 'tenantId'), false);
});

test('legacy scope lookup cannot switch employee, use a disabled account, or reuse a previous selection', async () => {
  const variants = [
    { ...employee, uid: 'another-employee' }, { ...employee, idp: 'wechat' },
    { ...employee, pluginEnabled: false }, { ...employee, lastLogin: false },
    { ...employee, enterpriseId: undefined },
  ];
  for (const candidate of variants) {
    const cache = stored();
    delete cache.identity.enterpriseId; delete cache.identity.tenantId;
    const paths = [];
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => cache, fetchImpl: async url => {
      paths.push(url.pathname); return reply({ accounts: [candidate] });
    } });
    await assert.rejects(value.modelCatalog(), error =>
      ['identity_changed', 'current_employee_account_required', 'enterprise_required'].includes(error.code));
    assert.deepEqual(paths, ['/v2/plugin/accounts']);
    assert.equal((await value.status()).identity.uid, 'employee-1');
  }
});

test('logout while legacy scope lookup is pending cannot publish metadata or send a model request', async () => {
  const cache = stored(), account = deferred(), submitted = deferred(), saved = [], paths = [];
  delete cache.identity.enterpriseId; delete cache.identity.tenantId;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => cache, saveAuth: async record => saved.push(record),
    fetchImpl: async url => { paths.push(url.pathname); submitted.resolve(); return account.promise; } });
  const pending = value.modelCatalog();
  await submitted.promise;
  await value.logout();
  account.resolve(reply({ accounts: [employee] }));
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.deepEqual(paths, ['/v2/plugin/accounts']);
  assert.deepEqual(saved, [null]);
  assert.equal((await value.status()).identity, null);
});

test('loadCatalog must be a function when supplied', () => {
  for (const loadCatalog of [null, true, {}, []]) {
    assert.throws(() => new EmployeeOAuthClient({ loadCatalog }), /loadCatalog must be a function/);
  }
});

test('explicit live model lists including an empty list never use the native cache', async () => {
  for (const models of [[], [{ id: 'remote-model' }]]) {
    let cacheReads = 0;
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
      loadCatalog: async () => { cacheReads++; throw new Error('must not use cache'); },
      fetchImpl: async () => reply({ models, privateConfiguration: 'not-exported' }) });
    assert.deepEqual(await value.modelCatalog(), { models, source: 'remote', liveVerified: true });
    assert.equal(cacheReads, 0);
  }
});

test('successful feature-only configuration can use an identity-bound native cache with explicit provenance', async () => {
  const signal = new AbortController().signal;
  let calls = 0, received;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
    fetchImpl: async url => { assert.equal(url.href, 'https://copilot.tencent.com/v3/config'); return reply({ productFeatures: {} }); },
    loadCatalog: async options => {
      calls++; received = options;
      assert.deepEqual(options.identity, { idp: 'ioa_auth', uid: 'employee-1', username: 'employee',
        enterpriseId: 'enterprise-1', tenantId: 'tenant-1' });
      options.identity.uid = 'mutated-callback-copy';
      return { models: [{ id: 'native-model' }], source: 'native-cache', savedAt: now - 1000, liveVerified: false,
        privateMetadata: 'not-exported' };
    } });
  assert.deepEqual(await value.modelCatalog({ signal }), { models: [{ id: 'native-model' }], source: 'native-cache',
    savedAt: now - 1000, liveVerified: false });
  assert.equal(calls, 1);
  assert.equal(received.signal, signal);
  assert.equal((await value.status()).identity.uid, 'employee-1');
  assert.doesNotMatch(JSON.stringify(received.identity), /private-access|private-refresh/);
});

test('HTTP or business rejection and malformed live configuration cannot fall back to cache', async () => {
  const failures = [
    () => new Response('mock unauthorized', { status: 401 }),
    () => new Response('mock forbidden', { status: 403 }),
    () => new Response('mock server error', { status: 500 }),
    () => reply({ productFeatures: {} }, 12151),
    () => Response.json({ data: { productFeatures: {} } }),
    () => reply(null), () => reply([]), () => reply('invalid data'),
    () => reply({ models: null }), () => reply({ models: {} }),
    () => new Response('not JSON', { status: 200 }),
  ];
  for (const response of failures) {
    let cacheReads = 0;
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), fetchImpl: async () => response(),
      loadCatalog: async () => { cacheReads++; return { models: [], source: 'native-cache', savedAt: now, liveVerified: false }; } });
    await assert.rejects(value.modelCatalog());
    assert.equal(cacheReads, 0);
  }
});

test('HTTP 201 cannot authorize a native catalog fallback even with a successful business code', async () => {
  let cacheReads = 0;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
    fetchImpl: async () => Response.json({ code: 0, data: { productFeatures: {} } }, { status: 201 }),
    loadCatalog: async () => { cacheReads++; return { models: [], source: 'native-cache', savedAt: now, liveVerified: false }; } });
  await assert.rejects(value.modelCatalog(), error => error.code === 'http_error' && error.status === 201);
  assert.equal(cacheReads, 0);
});

test('missing or failed native catalog readers expose safe catalog error codes', async () => {
  for (const loadCatalog of [undefined, async () => { throw new Error('private-access private-path'); }]) {
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), loadCatalog,
      fetchImpl: async () => reply({ productFeatures: {} }) });
    await assert.rejects(value.modelCatalog(), error => error.code === 'catalog_cache_unavailable' && !/private-/.test(String(error)));
  }
  const valid = { models: [], source: 'native-cache', savedAt: now, liveVerified: false };
  for (const invalid of [null, { ...valid, models: null }, { ...valid, source: 'remote' }, { ...valid, liveVerified: true },
    { ...valid, savedAt: undefined }, { ...valid, savedAt: '2026-10-19T00:00:00Z' }, { ...valid, savedAt: -1 }]) {
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(), loadCatalog: async () => invalid,
      fetchImpl: async () => reply({ productFeatures: {} }) });
    await assert.rejects(value.modelCatalog(), error => error.code === 'invalid_cached_catalog');
  }
});

test('logout, a new login, or cancellation while reading native models discards the cached result', async () => {
  for (const stop of ['logout', 'begin', 'abort']) {
    const result = deferred(), submitted = deferred(), abort = new AbortController();
    const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
      loadCatalog: async () => { submitted.resolve(); return result.promise; }, fetchImpl: async url =>
        url.pathname.endsWith('/auth/state') ? reply({ state: 'next', authUrl: 'https://copilot.tencent.com/login?state=next' }) :
          reply({ productFeatures: {} }) });
    const pending = value.modelCatalog({ signal: abort.signal });
    await submitted.promise;
    if (stop === 'abort') abort.abort(); else await value[stop]();
    result.resolve({ models: [{ id: 'previous-account-model' }], source: 'native-cache', savedAt: now, liveVerified: false });
    await assert.rejects(pending, error => error.code === 'aborted');
  }
});

test('configuration parsed after logout cannot start a native cache read', async () => {
  const parsed = deferred(), submitted = deferred();
  let cacheReads = 0;
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
    loadCatalog: async () => { cacheReads++; return { models: [], source: 'native-cache', savedAt: now, liveVerified: false }; },
    fetchImpl: async () => ({ ok: true, status: 200, json() { submitted.resolve(); return parsed.promise; } }) });
  const pending = value.modelCatalog();
  await submitted.promise;
  await value.logout();
  parsed.resolve({ code: 0, data: { productFeatures: {} } });
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.equal(cacheReads, 0);
});

test('a session invalidated during a native cache read cannot return its model list', async () => {
  const result = deferred(), submitted = deferred();
  const value = new EmployeeOAuthClient({ now: () => now, loadAuth: async () => stored(),
    loadCatalog: async () => { submitted.resolve(); return result.promise; },
    fetchImpl: async url => url.pathname.endsWith('/refresh') ? new Response('unauthorized', { status: 401 }) : reply({ productFeatures: {} }) });
  const pending = value.modelCatalog();
  await submitted.promise;
  await assert.rejects(value.refresh(), error => error.status === 401);
  result.resolve({ models: [{ id: 'invalidated-session-model' }], source: 'native-cache', savedAt: now, liveVerified: false });
  await assert.rejects(pending, error => error.code === 'not_authenticated');
  assert.equal((await value.status()).authenticated, false);
});
