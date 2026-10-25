const { api } = require('../../utils/api');

function formatDate(value) {
  const date = new Date(value);
  if (typeof value !== 'string' || !Number.isFinite(date.getTime())) return '—';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function disabled(user) { return user && (user.enabled === false || ['disabled', 'suspended'].includes(user.status)); }
function expired(user) { return user && typeof user.keyExpiresAtLimit === 'string' && Date.parse(user.keyExpiresAtLimit) <= Date.now(); }

function money(value) {
  if (!Number.isSafeInteger(value)) return '未返回';
  const absolute = String(Math.abs(value)).padStart(7, '0'), fraction = absolute.slice(-6).replace(/0+$/, '');
  return `${value < 0 ? '-' : ''}${absolute.slice(0, -6)}${fraction ? `.${fraction}` : ''} 元`;
}
function tokens(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '未返回'; }
function billingView(billing) {
  const available = billing && typeof billing === 'object' && Number.isSafeInteger(billing.balanceMicros);
  if (!available) return { billingReady: false, billingLabel: '待更新后台', billingNote: '计费信息尚未返回，请在网关更新并重启后刷新。', billingMetrics: [], billingHistory: [] };
  const typeLabels = { balance_adjustment: '余额调整', account_configured: '计费与配额设置', price_updated: '模型价格更新', adjustment: '余额调整', credit: '充值', debit: '扣减', reserve: '请求预留', reserved: '请求预留', settle: '用量结算', settled: '用量结算', release: '预留释放', released: '预留释放', unresolved: '待核对', quota_reset: '配额周期重置', policy: '计费设置', resolve: '人工核销' };
  const statusLabels = { pending: '进行中', started: '调用中', reserved: '预留中', unresolved: '待核对', settled: '已结算', released: '已释放', completed: '已完成', failed: '失败' };
  return { billingReady: true, billingLabel: billing.enforceBalance ? '余额计费' : '仅统计 Token',
    billingNote: `${billing.accountingBlocked ? '账户计费异常正在阻止新调用，请联系管理员。' : ''}${billing.enforceBalance ? '按管理员设置的模型价格扣费，充值请联系管理员。' : '当前只记录 Token，不扣余额。'} ${billing.pendingCount || 0} 个进行中，${billing.unresolvedCount || 0} 个待核对；预留暂不可用。`,
    billingMetrics: [['账户余额', money(billing.balanceMicros)], ['预留金额', money(billing.reservedMicros)], ['可用余额', money(billing.availableMicros)], ['本周期已用 Token', tokens(billing.usedTokens)], ['预留 Token', tokens(billing.reservedTokens)], ['剩余 Token', billing.tokenLimit === null ? '未设上限' : tokens(billing.remainingTokens)]].map(([label, value]) => ({ label, value })),
    billingHistory: (Array.isArray(billing.history) ? billing.history : []).slice(0, 50).map((entry, index) => ({ id: `${entry.id || entry.requestId || entry.operationId || 'entry'}-${index}`,
      title: `${typeLabels[entry.type] || entry.type || '账单'}${entry.status ? ` · ${statusLabels[entry.status] || entry.status}` : ''}`,
      amount: entry.type === 'settled' && entry.charged === false ? '仅统计 Token' : Number.isSafeInteger(entry.amountMicros) ? money(entry.amountMicros) : '—', time: formatDate(entry.createdAt || entry.time), model: String(entry.model || ''), note: String(entry.note || ''),
      usage: entry.usage ? `输入 ${tokens(entry.usage.inputTokens)} · 缓存 ${tokens(entry.usage.cachedInputTokens)} · 输出 ${tokens(entry.usage.outputTokens)} · 合计 ${tokens(entry.usage.totalTokens)} Token` : '',
      reserved: Number.isSafeInteger(entry.reservedMicros) ? `预留 ${money(entry.reservedMicros)} · ${tokens(entry.reservedTokens)} Token` : '' })) };
}

Page({
  data: {
    busy: false, configLoaded: false, authMode: 'login', username: '', password: '', inviteToken: '',
    registrationEnabled: false, invitationRequired: false, loggedIn: false, userLabel: '', accountNotice: '',
    keyName: '', keyDays: '30', keyDeadline: '', canCreateKey: false, keys: [], models: [], modelPricingNote: '',
    chatCompletionsUrl: '', baseUrl: '', messagesUrl: '', newSecret: '', error: '', message: '',
    billingReady: false, billingLabel: '尚未读取', billingNote: '', billingMetrics: [], billingHistory: [],
  },

  onLoad() { this.initialize(); },
  onShow() { this._visible = true; },
  onHide() { this._visible = false; this.clearSecret(); this.setData({ password: '', inviteToken: '' }); },
  onUnload() { this._visible = false; this.clearSecret(); this.setData({ password: '', inviteToken: '' }); },
  async onPullDownRefresh() {
    if (this.data.busy) { wx.stopPullDownRefresh(); return; }
    try { if (this.data.loggedIn) await this.run(() => this.refresh()); else await this.initialize(); }
    finally { wx.stopPullDownRefresh(); }
  },

  clearSecret() { this._newKeyId = null; this.setData({ newSecret: '' }); },
  showSecret(result) {
    this.clearSecret();
    if (this._visible !== false && typeof result.secret === 'string' && result.secret && result.secret.length <= 4096) {
      this._newKeyId = result.key && result.key.id;
      this.setData({ newSecret: result.secret });
    }
  },
  resetSession() {
    getApp().globalData.sessionToken = null;
    this._user = null; this.clearSecret();
    this.setData({ loggedIn: false, userLabel: '', accountNotice: '', keys: [], models: [], modelPricingNote: '',
      password: '', inviteToken: '', chatCompletionsUrl: '', baseUrl: '', messagesUrl: '', canCreateKey: false,
      ...billingView(null) });
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', message: '' });
    try { await action(); }
    catch (error) {
      if (error.status === 401 || error.code === 'account_disabled' || error.code === 'user_disabled') this.resetSession();
      this.setData({ error: error.message || '操作未完成，请稍后重试。' });
    } finally { this.setData({ busy: false }); }
  },
  async initialize() {
    await this.run(async () => {
      const config = await api('config', { auth: false }); this._config = config;
      this.setData({ configLoaded: true, registrationEnabled: config.registration && config.registration.enabled === true,
        invitationRequired: config.registration && config.registration.invitationRequired === true });
      if (getApp().globalData.sessionToken) await this.refresh();
    });
  },
  setAuthMode(event) {
    if (this.data.busy) return;
    const mode = event.currentTarget.dataset.mode;
    if (!['login', 'register'].includes(mode) || mode === 'register' && !this.data.registrationEnabled) return;
    this.setData({ authMode: mode, password: '', error: '', message: '' });
  },
  input(event) {
    const field = event.currentTarget.dataset.field;
    if (this.data.busy || !['username', 'password', 'inviteToken', 'keyName', 'keyDays'].includes(field)) return;
    this.setData({ [field]: event.detail.value });
  },
  async submitCredentials() {
    if (this.data.busy || !this.data.configLoaded) return;
    const mode = this.data.authMode, username = this.data.username.trim(), password = this.data.password;
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) {
      this.setData({ error: '用户名需为 3–64 个字母、数字或 _.-；密码需为 12–256 个字符。' }); return;
    }
    if (mode === 'register' && !this.data.registrationEnabled) return;
    const data = { username, password };
    if (mode === 'register' && this.data.inviteToken.trim()) data.inviteToken = this.data.inviteToken.trim();
    await this.run(async () => {
      let result;
      try { result = await api(mode, { method: 'POST', data, auth: false }); }
      finally { this.setData({ password: '', inviteToken: '' }); }
      if (typeof result.sessionToken !== 'string' || !result.sessionToken) throw new Error('登录响应缺少会话信息，请重新登录。');
      getApp().globalData.sessionToken = result.sessionToken;
      if (mode === 'register') this.showSecret(result);
      this.render({ user: result.user, keys: result.key ? [result.key] : [], models: [], gateway: this._config.gateway,
        keyDefaults: this._config.keyDefaults });
      await this.refresh();
    });
  },
  render(data) {
    const user = data.user;
    if (!user || typeof user.username !== 'string') throw new Error('用户信息不完整，请重新登录。');
    this._user = user;
    const keys = (Array.isArray(data.keys) ? data.keys : []).filter(key => key && typeof key.id === 'string').map(key => {
      const effectiveExpiry = key.effectiveExpiresAt || key.expiresAt;
      const status = key.revokedAt || key.status === 'revoked' ? 'revoked'
        : typeof effectiveExpiry === 'string' && Date.parse(effectiveExpiry) <= Date.now() || key.status === 'expired' ? 'expired'
          : disabled(user) || key.enabled === false || key.status === 'disabled' ? 'disabled'
            : ['active', 'enabled'].includes(key.status) ? 'active' : 'unknown';
      return { id: key.id, name: String(key.name || '未命名密钥'), prefix: typeof key.lastFour === 'string' && /^[A-Za-z0-9_-]{4}$/.test(key.lastFour)
        ? `•••• •••• ${key.lastFour}` : '•••• ••••',
        status, statusLabel: ({ active: '有效', expired: '已到期', revoked: '已撤销', disabled: '已停用' })[status] || '状态未知',
        expiresAt: formatDate(effectiveExpiry), createdAt: formatDate(key.createdAt), lastUsedAt: formatDate(key.lastUsedAt),
        canRevoke: !['revoked', 'expired'].includes(status) && /^[A-Za-z0-9_-]{1,128}$/.test(key.id) };
    });
    const models = (Array.isArray(data.models) ? data.models : []).filter(model => model && typeof model.id === 'string').map(model => ({
      id: model.id, name: typeof model.name === 'string' ? model.name : model.id,
      protocols: (Array.isArray(model.protocols) ? model.protocols : []).map(protocol => ({
        'chat-completions': 'OpenAI Chat', responses: 'Responses', messages: 'Anthropic Messages',
      })[protocol]).filter(Boolean).join(' · '),
      pricingText: model.pricing && typeof model.pricing === 'object' ? model.pricing.enabled === true
        ? `每百万 Token：输入 ${money(model.pricing.inputRateMicros)} · 缓存输入 ${money(model.pricing.cachedInputRateMicros)} · 输出 ${money(model.pricing.outputRateMicros)}`
        : '此模型计费未启用' : data.billing && Number.isSafeInteger(data.billing.balanceMicros) ? '未配置计费价格' : '价格未返回，请联系管理员确认。',
    }));
    const gateway = data.gateway || this._config.gateway || {};
    const days = Number(data.keyDefaults && data.keyDefaults.expiresInDays || 30);
    this.setData({ loggedIn: true, userLabel: user.username, keys, models,
      modelPricingNote: data.billing && data.billing.enforceBalance === false ? '当前只统计 Token，不扣余额。以下管理员单价供启用余额计费时参考。' : '单价由管理员配置，单位为元 / 百万 Token。缺少计费价格不代表免费。',
      accountNotice: disabled(user) ? '账号已停用，所有 Key 均无法调用。请联系管理员。'
        : expired(user) ? 'API Key 授权已到期，账号仍可登录。请联系管理员续期。' : '',
      canCreateKey: !disabled(user) && !expired(user), keyDeadline: formatDate(user.keyExpiresAtLimit),
      keyDays: Number.isInteger(days) && days >= 1 && days <= 365 ? String(days) : '30',
      chatCompletionsUrl: typeof gateway.chatCompletionsUrl === 'string' ? gateway.chatCompletionsUrl : '',
      baseUrl: typeof gateway.baseUrl === 'string' ? gateway.baseUrl : '',
      messagesUrl: typeof gateway.messagesUrl === 'string' ? gateway.messagesUrl : '',
      ...billingView(data.billing),
    });
  },
  async refresh() { const result = await api('me'); this.render(result); },
  refreshButton() { this.run(() => this.refresh()); },
  async createKey() {
    if (!this.data.canCreateKey || this.data.busy) return;
    const name = this.data.keyName.trim(), expiresInDays = Number(this.data.keyDays);
    if (!name || name.length > 80 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      this.setData({ error: '请填写密钥名称和 1–365 的整数有效天数。' }); return;
    }
    await this.run(async () => {
      this.clearSecret();
      const result = await api('keys', { method: 'POST', data: { name, expiresInDays } });
      this.showSecret(result); this.setData({ keyName: '' }); await this.refresh();
      this.setData({ message: '密钥已创建，请保存本次显示的完整 Key。' });
    });
  },
  revokeKey(event) {
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    wx.showModal({ title: '撤销密钥', content: '撤销后，使用此 Key 的客户端将无法继续调用。确定撤销？',
      confirmText: '撤销', confirmColor: '#ad4430', success: result => {
        if (!result.confirm) return;
        this.run(async () => {
          await api(`keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
          if (this._newKeyId === id) this.clearSecret(); await this.refresh(); this.setData({ message: '密钥已撤销。' });
        });
      } });
  },
  copySecret() {
    if (!this.data.newSecret) return;
    wx.setClipboardData({ data: this.data.newSecret, fail: () => this.setData({ error: '复制失败，请重新点击复制。' }) });
  },
  copyValue(event) {
    const kind = event.currentTarget.dataset.kind;
    const value = kind === 'model' ? event.currentTarget.dataset.id
      : ['chatCompletionsUrl', 'baseUrl', 'messagesUrl'].includes(kind) ? this.data[kind] : '';
    if (typeof value === 'string' && value) wx.setClipboardData({ data: value });
  },
  async logout() {
    if (this.data.busy) return;
    this.clearSecret();
    await this.run(async () => { await api('logout', { method: 'POST', data: {} }); this.resetSession(); });
  },
});
