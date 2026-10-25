// Independent employee OAuth. This does not extract the With desktop session.
// The endpoint contract comes from CodeBuddy's installed authentication provider.
const BASE_URL = 'https://copilot.tencent.com';
const DEFAULT_DOMAIN = 'copilot.tencent.com';
const USER_AGENT = 'Bifrost/0.1.0 (compatible; CodeBuddy/4.12.2)';
const LOGIN_HOSTS = new Set(['copilot.tencent.com', 'www.codebuddy.cn',
  'tencent.sso.codebuddy.cn', 'tencent.sso.copilot.tencent.com']);

export class EmployeeAuthError extends Error {
  constructor(code, status = 0) {
    super(`Employee OAuth: ${code}`);
    this.code = code;
    this.status = status;
  }
}

function validText(value, limit = 16384) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizedAuth(value, now, allowExpired = false) {
  if (!value || !validText(value.accessToken) || !validText(value.refreshToken)) {
    throw new EmployeeAuthError('invalid_token_response');
  }
  const expiresAt = value.expiresAt === undefined ? now + Number(value.expiresIn) * 1000 : Number(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || !allowExpired && expiresAt <= now) {
    throw new EmployeeAuthError('invalid_token_expiry');
  }
  // X-Domain is routing metadata, never a destination URL.
  const domain = value.domain || DEFAULT_DOMAIN;
  if (!validText(domain, 253) || !/^[A-Za-z0-9.-]+$/.test(domain)) throw new EmployeeAuthError('invalid_domain');
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, domain, expiresAt };
}

function optionalAccountId(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
    throw new EmployeeAuthError(`invalid_${field}`);
  }
  const id = String(value);
  if (!validText(id, 256) || !/^[\x21-\x7e]+$/.test(id) || id === '.' || id === '..') {
    throw new EmployeeAuthError(`invalid_${field}`);
  }
  return id;
}

function employeeIdentity(account) {
  if (account?.idp !== 'ioa_auth' || !['string', 'number'].includes(typeof account.uid) ||
      typeof account.uid === 'number' && !Number.isFinite(account.uid) || !validText(String(account.uid ?? ''), 256)) {
    throw new EmployeeAuthError('employee_account_required');
  }
  const identity = { idp: 'ioa_auth', uid: String(account.uid),
    username: [account.enterpriseUserName, account.nickname].find(value => validText(value, 256)) || '' };
  const enterpriseId = optionalAccountId(account.enterpriseId, 'enterprise_id');
  const tenantId = optionalAccountId(account.tenantId, 'tenant_id');
  if (enterpriseId !== undefined) identity.enterpriseId = enterpriseId;
  if (tenantId !== undefined) identity.tenantId = tenantId;
  return identity;
}

export class EmployeeOAuthClient {
  #auth = null;
  #refreshing = null;
  #pendingAuth = null;
  #identity = null;
  #loading;
  #loadError = null;
  #saveAuth;
  #loadCatalog;
  #saving = Promise.resolve();
  #generation = 0;
  #requestTimeoutMs;
  #retryUnauthorizedInference;
  #hasBegunLogin = false;
  #activeLogin = null;
  #scopeAuth = null;

  constructor({ fetchImpl = fetch, now = Date.now, loadAuth, saveAuth, loadCatalog, requestTimeoutMs = 15000, retryUnauthorizedInference = true } = {}) {
    if (loadAuth !== undefined && typeof loadAuth !== 'function' || saveAuth !== undefined && typeof saveAuth !== 'function') {
      throw new TypeError('OAuth credential callbacks must be functions.');
    }
    if (loadCatalog !== undefined && typeof loadCatalog !== 'function') {
      throw new TypeError('OAuth loadCatalog must be a function.');
    }
    if (typeof retryUnauthorizedInference !== 'boolean') throw new TypeError('Invalid inference retry policy.');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 0x7fffffff) {
      throw new TypeError('OAuth requestTimeoutMs must be a positive bounded integer.');
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.#saveAuth = saveAuth;
    this.#loadCatalog = loadCatalog;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#retryUnauthorizedInference = retryUnauthorizedInference;
    const generation = this.#generation;
    this.#loading = Promise.resolve().then(async () => {
      if (!loadAuth) return;
      const record = await loadAuth();
      if (generation !== this.#generation || record == null) return;
      if (record.version !== 1) throw new EmployeeAuthError('invalid_cached_credentials');
      const auth = normalizedAuth(record.auth, this.now(), true);
      const identity = employeeIdentity(record.identity);
      if (generation !== this.#generation) return;
      this.#auth = auth;
      this.#identity = { ...identity, username: validText(record.identity.username, 256) ? record.identity.username : identity.username };
    }).catch(() => { if (generation === this.#generation) this.#loadError = new EmployeeAuthError('credential_load_failed'); });
  }

  async status({ signal } = {}) {
    await this.#loading;
    if (this.#loadError) throw this.#loadError;
    if (this.#auth) await this.#readyAuth(signal);
    return { authenticated: !!this.#auth && this.#auth.expiresAt > this.now(),
      identity: this.#identity ? { ...this.#identity } : null, expiresAt: this.#auth?.expiresAt ?? null };
  }

  #persist(record, generation, signal) {
    const saving = this.#saving.then(async () => {
      this.#assertGeneration(generation, signal);
      if (!this.#saveAuth) return;
      try { await this.#saveAuth(record ? structuredClone(record) : null); }
      catch { throw new EmployeeAuthError('credential_save_failed'); }
    });
    this.#saving = saving.catch(() => {});
    return saving;
  }

  #record(auth, identity) { return { version: 1, auth: { ...auth }, identity: { ...identity } }; }

  #assertGeneration(generation, signal) {
    if (generation !== this.#generation || signal?.aborted) throw new EmployeeAuthError('aborted');
  }

  async #invalidate(generation) {
    if (generation !== this.#generation) return;
    this.#auth = null;
    this.#identity = null;
    this.#pendingAuth = null;
    this.#scopeAuth = null;
    await this.#persist(null, generation);
  }

  async logout() {
    const generation = ++this.#generation;
    this.#auth = null; this.#identity = null; this.#pendingAuth = null; this.#loadError = null;
    this.#refreshing = null;
    this.#scopeAuth = null;
    this.#hasBegunLogin = true; this.#activeLogin = null;
    await this.#loading;
    await this.#persist(null, generation);
  }

  #boundedSignal(signal) {
    const deadline = AbortSignal.timeout(this.#requestTimeoutMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  async #request(path, { method = 'GET', state, auth, refresh = false, signal } = {}) {
    const url = new URL(`/v2/plugin${path}`, BASE_URL);
    if (state !== undefined) {
      if (!validText(state, 4096)) throw new EmployeeAuthError('invalid_state');
      url.searchParams.set('state', state);
    }
    const headers = { Accept: 'application/json', 'X-Domain': auth?.domain || DEFAULT_DOMAIN, 'User-Agent': USER_AGENT };
    if (auth && !refresh) headers.Authorization = `Bearer ${auth.accessToken}`;
    if (refresh) {
      headers['X-Refresh-Token'] = auth.refreshToken;
      headers['X-Auth-Refresh-Source'] = 'plugin';
    }
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    let response;
    const requestSignal = this.#boundedSignal(signal);
    try {
      response = await this.fetchImpl(url, { method, headers, redirect: 'error',
        body: method === 'POST' ? '{}' : undefined,
        signal: requestSignal });
    } catch {
      throw new EmployeeAuthError(signal?.aborted ? 'aborted' : requestSignal.aborted ? 'timeout' : 'network_error');
    }
    if (!response.ok) throw new EmployeeAuthError('http_error', response.status);
    let body;
    try { body = await response.json(); } catch { throw new EmployeeAuthError('invalid_json'); }
    if (!body || typeof body !== 'object') throw new EmployeeAuthError('invalid_response');
    return body;
  }

  async begin({ signal } = {}) {
    await this.#loading;
    const generation = ++this.#generation;
    this.#hasBegunLogin = true; this.#activeLogin = null;
    this.#assertGeneration(generation, signal);
    this.#refreshing = null;
    // A fresh explicit login may replace a missing or damaged cache.
    this.#loadError = null;
    const body = await this.#request('/auth/state?platform=ide', { method: 'POST', signal });
    this.#assertGeneration(generation, signal);
    if (body.code && body.code !== 0) throw new EmployeeAuthError('login_start_rejected');
    const { state, authUrl } = body.data || {};
    if (!validText(state, 4096) || !validText(authUrl)) throw new EmployeeAuthError('invalid_login_response');
    let url;
    try { url = new URL(authUrl); } catch { throw new EmployeeAuthError('invalid_login_url'); }
    if (url.protocol !== 'https:' || !LOGIN_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new EmployeeAuthError('invalid_login_url');
    }
    if (url.searchParams.has('state') && url.searchParams.get('state') !== state) {
      throw new EmployeeAuthError('login_state_mismatch');
    }
    // The caller must show the actual official URL before user authorization.
    this.#pendingAuth = null;
    const login = { state, authUrl: url.href, createdAt: this.now(), expiresAt: this.now() + 300000 };
    this.#activeLogin = { login, generation };
    return login;
  }

  async poll(login, { signal } = {}) {
    await this.#loading;
    const generation = this.#generation;
    this.#assertGeneration(generation, signal);
    if (this.#hasBegunLogin && (this.#activeLogin?.login !== login || this.#activeLogin?.generation !== generation)) {
      throw new EmployeeAuthError('login_superseded');
    }
    if (!login || !Number.isFinite(login.expiresAt) || login.expiresAt <= this.now()) throw new EmployeeAuthError('login_expired');
    let auth = this.#pendingAuth?.state === login.state ? this.#pendingAuth.auth : null;
    if (!auth) {
      const body = await this.#request('/auth/token', { state: login.state, signal });
      this.#assertGeneration(generation, signal);
      if (body.code === 11217) return { pending: true, stage: 'login' };
      if (body.code && body.code !== 0) throw new EmployeeAuthError('login_rejected');
      auth = normalizedAuth(body.data, this.now());
      this.#assertGeneration(generation, signal);
      this.#pendingAuth = { state: login.state, auth };
    }
    // Validate the employee identity before making this credential available.
    let identity;
    try { identity = await this.#employee(auth, login.state, signal); }
    catch (error) {
      this.#assertGeneration(generation, signal);
      if (error.code === 'account_pending') return { pending: true, stage: 'account' };
      if (this.#pendingAuth?.state === login.state) this.#pendingAuth = null;
      throw error;
    }
    this.#assertGeneration(generation, signal);
    if (this.#identity && identity.uid !== this.#identity.uid) {
      this.#pendingAuth = null;
      throw new EmployeeAuthError('identity_changed');
    }
    await this.#persist(this.#record(auth, identity), generation, signal);
    this.#assertGeneration(generation, signal);
    this.#auth = auth; this.#identity = identity; this.#scopeAuth = auth;
    this.#pendingAuth = null;
    return { pending: false, identity: { ...identity }, expiresAt: auth.expiresAt };
  }

  async #employee(auth, state, signal) {
    const body = await this.#request('/login/account', { auth, state, signal });
    if (body.code === 12151) throw new EmployeeAuthError('account_pending');
    if (body.code && body.code !== 0) throw new EmployeeAuthError('account_rejected');
    return employeeIdentity(body.data);
  }

  async #accounts(auth, signal, expectedUid) {
    const body = await this.#request('/accounts', { auth, signal });
    if (body.code && body.code !== 0) throw new EmployeeAuthError('account_rejected');
    const accounts = body.data?.accounts;
    if (!Array.isArray(accounts)) throw new EmployeeAuthError('invalid_accounts');
    const enabled = accounts.filter((account) => account?.pluginEnabled === true && account.idp === 'ioa_auth');
    const current = enabled.filter((account) => account.lastLogin === true);
    const account = expectedUid === undefined ? current[0] || enabled[0] :
      current.find((account) => ['string', 'number'].includes(typeof account.uid) && String(account.uid) === expectedUid);
    if (expectedUid !== undefined && !account) {
      throw new EmployeeAuthError(current.length ? 'identity_changed' : 'current_employee_account_required');
    }
    return employeeIdentity(account);
  }

  async refresh({ signal } = {}) {
    await this.#loading;
    if (this.#loadError) throw this.#loadError;
    if (!this.#auth) throw new EmployeeAuthError('not_authenticated');
    if (this.#refreshing) return this.#refreshing;
    const generation = this.#generation;
    this.#assertGeneration(generation, signal);
    const previous = this.#auth;
    const refreshing = (async () => {
      const body = await this.#request('/auth/token/refresh', { method: 'POST', auth: previous, refresh: true, signal });
      if (body.code && body.code !== 0) throw new EmployeeAuthError('refresh_rejected');
      let auth, identity;
      try {
        this.#assertGeneration(generation, signal);
        auth = normalizedAuth(body.data, this.now());
        identity = await this.#accounts(auth, signal);
        this.#assertGeneration(generation, signal);
        if (identity.uid !== this.#identity.uid) throw new EmployeeAuthError('identity_changed');
      } catch (error) {
        // A rotated credential cannot safely fall back to the old refresh token.
        await this.#invalidate(generation);
        throw error;
      }
      await this.#persist(this.#record(auth, identity), generation, signal);
      this.#assertGeneration(generation, signal);
      this.#auth = auth;
      this.#identity = identity;
      this.#scopeAuth = auth;
      return { identity: { ...identity }, expiresAt: auth.expiresAt };
    })();
    this.#refreshing = refreshing;
    try { return await refreshing; }
    catch (error) {
      if (error.status === 401 || error.status === 403 || error.code === 'refresh_rejected' || error.code === 'credential_save_failed') {
        await this.#invalidate(generation);
      }
      throw error;
    } finally { if (this.#refreshing === refreshing) this.#refreshing = null; }
  }

  async #readyAuth(signal) {
    await this.#loading;
    if (this.#loadError) throw this.#loadError;
    if (!this.#auth) throw new EmployeeAuthError('not_authenticated');
    if (this.#auth.expiresAt <= this.now() + 60000) await this.refresh({ signal });
    if (!this.#auth) throw new EmployeeAuthError('not_authenticated');
    return this.#auth;
  }

  async #readyIdentity(auth, generation, signal) {
    this.#assertGeneration(generation, signal);
    if (!this.#identity) throw new EmployeeAuthError('not_authenticated');
    if (this.#identity.enterpriseId && (this.#identity.tenantId || this.#scopeAuth === auth)) return this.#identity;
    const identity = await this.#accounts(auth, signal, this.#identity.uid);
    this.#assertGeneration(generation, signal);
    // A concurrent refresh owns the newer identity and routing metadata.
    if (this.#auth !== auth) return null;
    if (!identity.enterpriseId) throw new EmployeeAuthError('enterprise_required');
    this.#identity = { ...identity, username: identity.username || this.#identity.username };
    this.#scopeAuth = auth;
    // Backfilling routing metadata from an older cache is read-only. New login
    // and refresh records persist their own verified account fields normally.
    return this.#identity;
  }

  async #modelRequest(path, { method = 'GET', body, signal, expectedIdentity } = {}) {
    await this.#loading;
    const generation = this.#generation;
    let auth = await this.#readyAuth(signal);
    const send = async () => {
      this.#assertGeneration(generation, signal);
      if (!this.#auth || !this.#identity) throw new EmployeeAuthError('not_authenticated');
      let identity;
      do {
        auth = this.#auth;
        if (!auth) throw new EmployeeAuthError('not_authenticated');
        identity = await this.#readyIdentity(auth, generation, signal);
      } while (!identity);
      this.#assertGeneration(generation, signal);
      if (expectedIdentity !== undefined && identity.uid !== expectedIdentity) throw new EmployeeAuthError('identity_changed');
      const headers = { Authorization: `Bearer ${auth.accessToken}`, 'X-User-Id': identity.uid,
        'X-Domain': auth.domain, 'User-Agent': USER_AGENT,
        Accept: method === 'POST' ? 'text/event-stream' : 'application/json' };
      if (identity.enterpriseId) headers['X-Enterprise-Id'] = identity.enterpriseId;
      const tenantId = identity.tenantId || identity.enterpriseId;
      if (tenantId) headers['X-Tenant-Id'] = tenantId;
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const requestSignal = method === 'GET' ? this.#boundedSignal(signal) : signal;
      let response;
      try {
        response = await this.fetchImpl(new URL(path, BASE_URL), { method, headers, body, redirect: 'error',
          // The caller's signal must stay alive for the streamed response body.
          signal: requestSignal });
      } catch { throw new EmployeeAuthError(signal?.aborted ? 'aborted' : requestSignal?.aborted ? 'timeout' : 'network_error'); }
      try { this.#assertGeneration(generation, signal); }
      catch (error) { try { await response.body?.cancel(); } catch {} throw error; }
      return response;
    };
    let response = await send();
    if (response.status === 401 && (method === 'GET' || this.#retryUnauthorizedInference)) {
      try { await response.body?.cancel(); } catch {}
      this.#assertGeneration(generation, signal);
      if (this.#auth === auth) await this.refresh({ signal });
      auth = this.#auth;
      if (!auth) throw new EmployeeAuthError('not_authenticated');
      response = await send();
      if (response.status === 401) await this.#invalidate(generation);
    }
    return response;
  }

  async modelCatalog({ signal } = {}) {
    await this.#loading;
    const generation = this.#generation;
    const response = await this.#modelRequest('/v3/config', { signal });
    if (response.status !== 200) throw new EmployeeAuthError('http_error', response.status);
    this.#assertGeneration(generation, signal);
    if (!this.#auth || !this.#identity) throw new EmployeeAuthError('not_authenticated');
    const identity = structuredClone(this.#identity), uid = identity.uid;
    const assertIdentity = () => {
      this.#assertGeneration(generation, signal);
      if (!this.#auth || !this.#identity) throw new EmployeeAuthError('not_authenticated');
      if (this.#identity.uid !== uid) throw new EmployeeAuthError('identity_changed');
    };
    let body;
    try { body = await response.json(); }
    catch { assertIdentity(); throw new EmployeeAuthError('invalid_json'); }
    assertIdentity();
    if (body?.code !== 0) throw new EmployeeAuthError('catalog_rejected');
    const data = body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EmployeeAuthError('invalid_catalog');
    if (Object.hasOwn(data, 'models')) {
      if (!Array.isArray(data.models)) throw new EmployeeAuthError('invalid_catalog');
      return { models: structuredClone(data.models), source: 'remote', liveVerified: true };
    }
    // Some official product configurations contain feature flags but no model
    // list. Only this successful, unambiguous shape permits a native cache read.
    if (!this.#loadCatalog) throw new EmployeeAuthError('catalog_cache_unavailable');
    let cached;
    try { cached = await this.#loadCatalog({ identity, signal }); }
    catch { assertIdentity(); throw new EmployeeAuthError('catalog_cache_unavailable'); }
    assertIdentity();
    if (!cached || !Array.isArray(cached.models) || cached.source !== 'native-cache' || cached.liveVerified !== false ||
        !Number.isSafeInteger(cached.savedAt) || cached.savedAt < 0) {
      throw new EmployeeAuthError('invalid_cached_catalog');
    }
    try {
      return { models: structuredClone(cached.models), source: 'native-cache', savedAt: cached.savedAt, liveVerified: false };
    } catch { throw new EmployeeAuthError('invalid_cached_catalog'); }
  }

  async chatCompletions({ body, signal, expectedIdentity } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validText(body.model, 256)) {
      throw new EmployeeAuthError('invalid_chat_request');
    }
    if (body.stream !== true) throw new EmployeeAuthError('stream_required');
    let json;
    try { json = JSON.stringify(body); } catch { throw new EmployeeAuthError('invalid_chat_request'); }
    return this.#modelRequest('/v2/chat/completions', { method: 'POST', body: json, signal, expectedIdentity });
  }

  // Deliberately no raw-token getter or general authenticated HTTP proxy.
}

export { EmployeeOAuthClient as CodeBuddyClient };
