import { BridgeError } from './storage.mjs';

export function decodeClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const auth = claims['https://api.openai.com/auth'] ?? {};
    if (!auth.chatgpt_account_id || !Number.isFinite(claims.exp)) throw new Error();
    return { accountId: auth.chatgpt_account_id, userId: auth.chatgpt_user_id ?? claims.sub ?? null,
      expiresAt: claims.exp * 1000, planType: auth.chatgpt_plan_type ?? null };
  } catch { throw new BridgeError('原生 Codex 未返回可识别的 ChatGPT 授权，请重新登录 B。', 401); }
}

export class SubscriptionBackend {
  constructor({ rpc, state, saveState, clock = Date.now }) {
    Object.assign(this, { rpc, state, saveState, clock });
    this.account = null; this.token = null; this.refreshing = null; this.refreshIsForced = false;
    this.login = { state: 'idle' };
    rpc.on('notification', (method, params) => {
      if (method === 'account/login/completed') {
        if (this.login.state !== 'pending' || !params.loginId || params.loginId !== this.login.loginId) return;
        this.token = null;
        this.login = params.success ? { state: 'complete' } : { state: 'error', error: params.error ?? '登录未完成' };
      }
      if (method === 'account/updated') this.token = null;
    });
    rpc.on('stopped', () => { this.token = null; });
  }

  async readAccount() {
    const { account } = await this.rpc.request('account/read', { refreshToken: false });
    this.account = account ? { type: account.type, email: account.email ?? null, planType: account.planType ?? null } : null;
    return this.account;
  }

  async beginLogin({ deviceCode = false } = {}) {
    const method = deviceCode ? 'deviceCode' : 'browser';
    if (this.login.state === 'pending' && this.login.method === method && this.login.url) {
      return { url: this.login.url, ...(this.login.userCode ? { userCode: this.login.userCode } : {}) };
    }
    if (this.login.loginId) {
      await this.rpc.request('account/login/cancel', { loginId: this.login.loginId });
    }
    this.token = null;
    this.state.enabled = false; this.state.pinnedAccount = null; await this.saveState();
    try {
      const result = await this.rpc.request('account/login/start', { type: deviceCode ? 'chatgptDeviceCode' : 'chatgpt' });
      const url = new URL(deviceCode ? result.verificationUrl : result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password || url.port) {
        throw new BridgeError('Codex 返回了非预期授权地址。', 502);
      }
      if (deviceCode && (typeof result.userCode !== 'string' || !/^[A-Z0-9 -]{1,64}$/i.test(result.userCode))) {
        throw new BridgeError('Codex 未返回有效的设备授权码。', 502);
      }
      this.login = { state: 'pending', method, url: url.href, loginId: result.loginId,
        ...(deviceCode ? { userCode: result.userCode } : {}) };
      return { url: this.login.url, ...(deviceCode ? { userCode: result.userCode } : {}) };
    } catch (error) {
      this.login = { state: 'error', error: error.message };
      throw error;
    }
  }

  async logout() {
    if (this.login.loginId) await this.rpc.request('account/login/cancel', { loginId: this.login.loginId }).catch(() => {});
    await this.rpc.request('account/logout');
    this.state.enabled = false; this.state.pinnedAccount = null;
    this.token = null; this.account = null; this.login = { state: 'idle' };
    await this.saveState();
  }

  async #loadToken(force) {
    const account = await this.readAccount();
    if (account?.type !== 'chatgpt') {
      throw new BridgeError('请在独立后端登录账户 B 的 ChatGPT 订阅。此版本不使用 API Key 计费。', 401);
    }
    let auth = await this.rpc.request('getAuthStatus', { includeToken: true, refreshToken: force });
    if (!['chatgpt', 'chatgptAuthTokens'].includes(auth.authMethod) || !auth.authToken) {
      throw new BridgeError('B 的订阅授权不可用，请重新登录。', 401);
    }
    let claims = decodeClaims(auth.authToken);
    if (!force && claims.expiresAt < this.clock() + 300_000) {
      this.refreshIsForced = true;
      auth = await this.rpc.request('getAuthStatus', { includeToken: true, refreshToken: true });
      if (!auth.authToken) throw new BridgeError('B 的授权刷新失败，请重新登录。', 401);
      claims = decodeClaims(auth.authToken);
    }
    if (claims.expiresAt <= this.clock() + 5000) throw new BridgeError('B 的授权已过期，刷新未成功。', 401);
    this.token = { value: auth.authToken, ...claims, email: account.email, planType: account.planType };
    return this.token;
  }

  async #refresh(force) {
    if (this.refreshing) {
      const pending = this.refreshing;
      const alreadyForcing = this.refreshIsForced;
      try { await pending; }
      catch (error) { if (!force || alreadyForcing) throw error; }
      if (!force || alreadyForcing) return;
      // A 401 must not merely wait for an ordinary credential read and reuse
      // the same rejected token. Join a forced refresh, or start one now.
      return this.#refresh(true);
    }
    this.refreshIsForced = force;
    const pending = this.#loadToken(force);
    this.refreshing = pending;
    try { await pending; }
    finally {
      if (this.refreshing === pending) { this.refreshing = null; this.refreshIsForced = false; }
    }
  }

  async credentials({ force = false, requireBinding = true } = {}) {
    if (requireBinding && (!this.state.enabled || !this.state.pinnedAccount)) {
      throw new BridgeError('尚未绑定账户 B，请在管理页面确认推理账户。', 503, 'account_not_bound');
    }
    if (force || this.refreshing || !this.token || this.token.expiresAt < this.clock() + 300_000) await this.#refresh(force);
    const token = this.token;
    const pinned = this.state.pinnedAccount;
    if (requireBinding && (!this.state.enabled || !pinned || pinned.accountId !== token.accountId || pinned.userId !== token.userId || pinned.email !== token.email)) {
      throw new BridgeError('后端账号与已绑定的 B 不一致，已停止转发。请核对后重新绑定。', 409, 'account_changed');
    }
    return token;
  }

  async bind() {
    const token = await this.credentials({ requireBinding: false });
    this.state.pinnedAccount = { accountId: token.accountId, userId: token.userId,
      email: token.email, planType: token.planType };
    this.state.enabled = true; await this.saveState();
    return this.publicBinding();
  }

  publicBinding() {
    const pinned = this.state.pinnedAccount;
    return pinned ? { email: pinned.email, planType: pinned.planType } : null;
  }

  async limits() { return this.rpc.request('account/rateLimits/read'); }
}
