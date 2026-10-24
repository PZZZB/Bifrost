'use strict';

const portalElements = Object.fromEntries([
  'portal-notice', 'auth-panel', 'login-tab', 'register-tab', 'credentials-form', 'username', 'password',
  'invite-code', 'invite-field', 'registration-note', 'auth-error', 'auth-submit', 'dashboard-panel',
  'user-summary', 'portal-refresh', 'portal-logout', 'account-banner', 'connection-fields', 'key-form',
  'key-name', 'key-days', 'key-expiry-note', 'key-create-button', 'new-key-panel', 'new-key-secret',
  'secret-dismiss', 'secret-copy', 'secret-copy-status', 'key-count', 'keys-list', 'model-count', 'models-list', 'models-pricing-note',
  'portal-billing-state', 'portal-billing-note', 'portal-billing-metrics', 'portal-billing-count', 'portal-billing-history',
].map(id => [id, document.getElementById(id)]));

let portalConfig = null;
let portalUser = null;
let portalCsrfToken = null;
let portalAuthMode = 'login';
let portalBusy = false;
let portalGeneration = 0;
let displayedKeyId = null;
let portalVisible = true;

const portalStateLabels = { active: '有效', enabled: '有效', disabled: '已停用', suspended: '已停用',
  revoked: '已撤销', expired: '已到期', pending: '待分配' };

function portalNotice(message = '', success = false) {
  portalElements['portal-notice'].textContent = message;
  portalElements['portal-notice'].hidden = !message;
  portalElements['portal-notice'].className = `notice${success ? ' success' : ''}`;
}

function clearNewKey() {
  displayedKeyId = null;
  portalElements['new-key-secret'].value = '';
  portalElements['new-key-panel'].hidden = true;
  portalElements['secret-copy-status'].textContent = '';
}

function showNewKey(result) {
  clearNewKey();
  if (!portalVisible || typeof result?.secret !== 'string' || !result.secret || result.secret.length > 4096) return;
  displayedKeyId = typeof result.key?.id === 'string' ? result.key.id : null;
  portalElements['new-key-secret'].value = result.secret;
  portalElements['new-key-panel'].hidden = false;
}

function portalDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '—';
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
}

function portalMoney(value) {
  if (!Number.isSafeInteger(value)) return '未返回';
  const negative = value < 0, absolute = String(Math.abs(value)).padStart(7, '0');
  const fraction = absolute.slice(-6).replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute.slice(0, -6)}${fraction ? `.${fraction}` : ''} 元`;
}

function portalTokens(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未返回'; }

function portalBillingLabel(entry) {
  const types = { balance_adjustment: '余额调整', account_configured: '计费与配额设置', price_updated: '模型价格更新', adjustment: '余额调整', credit: '充值', debit: '扣减', reserve: '请求预留', reserved: '请求预留', settle: '用量结算', settled: '用量结算', release: '预留释放', released: '预留释放', unresolved: '待核对', quota_reset: '配额周期重置', policy: '计费设置', resolve: '人工核销' };
  const states = { pending: '进行中', started: '调用中', reserved: '预留中', unresolved: '待核对', settled: '已结算', released: '已释放', failed: '失败', completed: '已完成' };
  const type = entry.type === 'account_configured' && entry.configuration?.resetQuota === true ? '配额周期重置' : types[entry.type] || entry.type || '账单', state = states[entry.status] || entry.status;
  return `${type}${state && state !== type ? ` · ${state}` : ''}`;
}

function renderPortalBilling(billing) {
  const available = billing && typeof billing === 'object' && Number.isSafeInteger(billing.balanceMicros);
  portalElements['portal-billing-state'].textContent = available ? billing.enforceBalance === true ? '余额计费' : '仅统计 Token' : '待更新后台';
  portalElements['portal-billing-state'].className = `pill${available ? ' active' : ''}`;
  portalElements['portal-billing-note'].textContent = !available ? '计费信息尚未返回，请在网关更新并重启后刷新。'
    : `${billing.accountingBlocked ? '账户计费异常正在阻止新调用，请联系管理员。' : ''}${billing.enforceBalance ? '模型调用按管理员设置的价格扣费。充值或余额问题请联系管理员。' : '当前不扣余额，只记录 Token 用量。'}${billing.pendingCount || billing.unresolvedCount ? ` ${billing.pendingCount || 0} 个请求进行中，${billing.unresolvedCount || 0} 个请求待核对；预留金额暂不可用。` : ''}`;
  const metrics = available ? [['账户余额', portalMoney(billing.balanceMicros)], ['预留金额', portalMoney(billing.reservedMicros)], ['可用余额', portalMoney(billing.availableMicros)],
    ['本周期已用 Token', portalTokens(billing.usedTokens)], ['预留 Token', portalTokens(billing.reservedTokens)], ['剩余 Token', billing.tokenLimit === null ? '未设上限' : portalTokens(billing.remainingTokens)]] : [];
  portalElements['portal-billing-metrics'].replaceChildren(...metrics.map(([label, value]) => {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value; row.append(term, detail); return row;
  }));
  const history = available && Array.isArray(billing.history) ? billing.history.slice(0, 50) : [];
  portalElements['portal-billing-count'].textContent = available ? `（${history.length} 条）` : '';
  const rows = history.map(entry => {
    const row = document.createElement('article'); row.className = 'portal-billing-entry';
    const heading = document.createElement('div'), title = document.createElement('strong'), amount = document.createElement('span');
    heading.className = 'portal-billing-entry-heading'; title.textContent = portalBillingLabel(entry);
    amount.textContent = entry.type === 'settled' && entry.charged === false ? '仅统计 Token' : Number.isSafeInteger(entry.amountMicros) ? portalMoney(entry.amountMicros) : '—'; heading.append(title, amount); row.append(heading);
    for (const text of [portalDate(entry.createdAt || entry.time), entry.model || '', entry.note || '',
      entry.usage ? `输入 ${portalTokens(entry.usage.inputTokens)} · 缓存 ${portalTokens(entry.usage.cachedInputTokens)} · 输出 ${portalTokens(entry.usage.outputTokens)} · 合计 ${portalTokens(entry.usage.totalTokens)} Token` : '',
      Number.isSafeInteger(entry.reservedMicros) ? `预留 ${portalMoney(entry.reservedMicros)} · ${portalTokens(entry.reservedTokens)} Token` : '']) {
      if (!text) continue; const detail = document.createElement('p'); detail.textContent = text; row.append(detail);
    } return row;
  });
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = available ? '暂无账单。' : '账单信息尚未返回。'; rows.push(empty); }
  portalElements['portal-billing-history'].replaceChildren(...rows);
}

function userDisabled(user = portalUser) {
  return user?.enabled === false || ['disabled', 'suspended'].includes(user?.status);
}

function keyAccessExpired(user = portalUser) {
  return typeof user?.keyExpiresAtLimit === 'string' && Date.parse(user.keyExpiresAtLimit) <= Date.now();
}

function updatePortalControls() {
  const registrationAvailable = portalConfig?.registration?.enabled === true;
  portalElements['login-tab'].disabled = portalBusy;
  portalElements['register-tab'].disabled = portalBusy || !registrationAvailable;
  portalElements['auth-submit'].disabled = portalBusy || !portalConfig || portalAuthMode === 'register' && !registrationAvailable;
  portalElements['auth-submit'].textContent = portalBusy ? '处理中…' : portalAuthMode === 'register' ? '注册账号' : '登录';
  for (const id of ['username', 'password', 'invite-code', 'key-name', 'key-days', 'portal-refresh', 'portal-logout']) {
    portalElements[id].disabled = portalBusy;
  }
  portalElements['key-create-button'].disabled = portalBusy || !portalUser || userDisabled() || keyAccessExpired();
  for (const button of portalElements['keys-list'].querySelectorAll('button')) button.disabled = portalBusy;
}

function setPortalAuthMode(mode) {
  if (portalBusy || mode === 'register' && portalConfig?.registration?.enabled !== true) return;
  portalAuthMode = mode;
  portalElements.password.value = '';
  portalElements['auth-error'].hidden = true;
  for (const current of ['login', 'register']) {
    const selected = current === mode;
    portalElements[`${current}-tab`].setAttribute('aria-selected', String(selected));
    portalElements[`${current}-tab`].tabIndex = selected ? 0 : -1;
  }
  portalElements['credentials-form'].setAttribute('aria-labelledby', `${mode}-tab`);
  portalElements.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  portalElements['invite-field'].hidden = mode !== 'register';
  portalElements['invite-code'].required = mode === 'register' && portalConfig?.registration?.invitationRequired === true;
  portalElements['registration-note'].hidden = mode !== 'register';
  portalElements['registration-note'].textContent = portalConfig?.registration?.invitationRequired
    ? '请填写管理员提供的邀请码。密码至少 12 个字符。'
    : '密码至少 12 个字符。无邀请码注册后，由管理员分配可用模型。';
  updatePortalControls();
}

async function portalApi(path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && portalCsrfToken) headers['X-CSRF-Token'] = portalCsrfToken;
  let response;
  try {
    response = await fetch(`/portal/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store',
      headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(15000) });
  } catch { throw Object.assign(new Error('无法连接用户中心，请检查网络后重试。'), { status: 0 }); }
  let result;
  try { result = await response.json(); }
  catch { throw Object.assign(new Error('服务器返回了无法识别的响应，请稍后重试。'), { status: response.status }); }
  if (!response.ok) {
    const message = typeof result?.error?.message === 'string' && result.error.message.length <= 1000
      ? result.error.message : '操作未完成，请稍后重试。';
    throw Object.assign(new Error(message), { status: response.status, code: result?.error?.code });
  }
  return result;
}

function showPortalLogin() {
  portalGeneration++;
  portalUser = null;
  portalCsrfToken = null;
  clearNewKey();
  portalElements.password.value = '';
  portalElements['invite-code'].value = '';
  portalElements['keys-list'].replaceChildren();
  portalElements['models-list'].replaceChildren();
  portalElements['connection-fields'].replaceChildren();
  renderPortalBilling(null);
  portalElements['dashboard-panel'].hidden = true;
  portalElements['auth-panel'].hidden = false;
  updatePortalControls();
}

function handlePortalError(error, auth = false) {
  if (error.status === 401 || error.code === 'account_disabled' || error.code === 'user_disabled') showPortalLogin();
  if (auth) {
    portalElements['auth-error'].textContent = error.message;
    portalElements['auth-error'].hidden = false;
  } else portalNotice(error.message);
}

async function copyPortalText(value, target) {
  try {
    await navigator.clipboard.writeText(value);
    if (target) target.textContent = '已复制';
    else portalNotice('已复制。', true);
  } catch {
    if (target) target.textContent = '无法自动复制，请选中后手动复制。';
    else portalNotice('无法自动复制，请选中内容后手动复制。');
  }
}

function appendConnectionField(label, value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return;
  const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
  const code = document.createElement('code'), button = document.createElement('button');
  term.textContent = label; code.textContent = value;
  button.type = 'button'; button.className = 'copy-value'; button.textContent = '复制地址';
  button.addEventListener('click', () => copyPortalText(value));
  detail.append(code, button); row.append(term, detail); portalElements['connection-fields'].append(row);
}

function renderPortalConnections(gateway = {}) {
  portalElements['connection-fields'].replaceChildren();
  appendConnectionField('CodeBuddy / WorkBuddy · OpenAI Chat 完整接口地址', gateway.chatCompletionsUrl);
  appendConnectionField('支持 Base URL 的客户端', gateway.baseUrl);
  appendConnectionField('Anthropic Messages · 仅 CodeBuddy 渠道模型', gateway.messagesUrl);
  appendConnectionField('模型目录', gateway.modelsUrl);
  if (!portalElements['connection-fields'].children.length) {
    const note = document.createElement('p'); note.className = 'empty-state'; note.textContent = '管理员尚未配置接入地址。';
    portalElements['connection-fields'].append(note);
  }
}

function effectiveKeyStatus(key) {
  if (key.revokedAt || key.status === 'revoked') return 'revoked';
  const expiresAt = key.effectiveExpiresAt ?? key.expiresAt;
  if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) return 'expired';
  if (key.status === 'expired') return 'expired';
  if (userDisabled() || key.enabled === false || key.status === 'disabled') return 'disabled';
  return key.status === 'active' || key.status === 'enabled' ? 'active' : 'unknown';
}

function renderPortalKeys(keys = []) {
  const items = Array.isArray(keys) ? keys : [];
  portalElements['key-count'].textContent = `${items.length} 个 Key`;
  portalElements['keys-list'].replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = '尚无密钥。在上方创建第一个 API Key。';
    portalElements['keys-list'].append(empty);
  }
  for (const key of items) {
    if (!key || typeof key !== 'object') continue;
    const status = effectiveKeyStatus(key), row = document.createElement('article'), main = document.createElement('div');
    row.className = 'key-item';
    const title = document.createElement('div'), name = document.createElement('strong'), badge = document.createElement('span');
    title.className = 'key-title'; name.textContent = String(key.name || '未命名密钥');
    badge.className = `pill ${status}`; badge.textContent = portalStateLabels[status] ?? '状态未知'; title.append(name, badge);
    const prefix = document.createElement('code'); prefix.className = 'key-prefix';
    prefix.textContent = typeof key.lastFour === 'string' && /^[A-Za-z0-9_-]{4}$/.test(key.lastFour)
      ? `•••• •••• ${key.lastFour}` : '•••• ••••';
    const meta = document.createElement('div'); meta.className = 'key-meta';
    for (const [label, value] of [['创建', key.createdAt], ['到期', key.effectiveExpiresAt ?? key.expiresAt], ['最近使用', key.lastUsedAt]]) {
      const item = document.createElement('span'); item.textContent = `${label}：${portalDate(value)}`; meta.append(item);
    }
    main.append(title, prefix, meta); row.append(main);
    if (!['revoked', 'expired'].includes(status) && typeof key.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key.id)) {
      const actions = document.createElement('div'), revoke = document.createElement('button');
      actions.className = 'key-actions'; revoke.type = 'button'; revoke.className = 'button danger'; revoke.textContent = '撤销密钥';
      revoke.addEventListener('click', () => revokePortalKey(key.id, key.name)); actions.append(revoke); row.append(actions);
    }
    portalElements['keys-list'].append(row);
  }
}

function renderPortalModels(models = [], billing) {
  const billingKnown = billing && Number.isSafeInteger(billing.balanceMicros);
  portalElements['models-pricing-note'].textContent = billingKnown && billing.enforceBalance === false
    ? '当前只统计 Token，不扣余额。以下管理员单价供启用余额计费时参考。'
    : '单价由管理员配置，单位为元 / 百万 Token。缺少计费价格不代表免费。';
  const items = Array.isArray(models) ? models.filter(model => model && typeof model.id === 'string') : [];
  portalElements['model-count'].textContent = `${items.length} 个模型`;
  portalElements['models-list'].replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state';
    empty.textContent = '暂未分配可用模型，请联系管理员。'; portalElements['models-list'].append(empty);
  }
  for (const model of items) {
    const item = document.createElement('article'), name = document.createElement('h3'), id = document.createElement('code');
    const copy = document.createElement('button'); item.className = 'model-item';
    name.textContent = typeof model.name === 'string' ? model.name : model.id; id.textContent = model.id;
    copy.className = 'copy-value'; copy.type = 'button'; copy.textContent = '复制模型 ID';
    copy.addEventListener('click', () => copyPortalText(model.id)); item.append(name, id);
    const protocols = Array.isArray(model.protocols) ? model.protocols.filter(protocol => ['chat-completions', 'responses', 'messages'].includes(protocol)) : [];
    if (protocols.length) {
      const formats = document.createElement('p'); formats.className = 'model-protocols';
      formats.textContent = protocols.map(protocol => ({ 'chat-completions': 'OpenAI Chat', responses: 'Responses', messages: 'Anthropic Messages' })[protocol]).join(' · ');
      item.append(formats);
    }
    if (model.pricing && typeof model.pricing === 'object') {
      const price = document.createElement('p'); price.className = 'model-protocols';
      price.textContent = model.pricing.enabled === true
        ? `每百万 Token：输入 ${portalMoney(model.pricing.inputRateMicros)} · 缓存 ${portalMoney(model.pricing.cachedInputRateMicros)} · 输出 ${portalMoney(model.pricing.outputRateMicros)}` : '此模型计费未启用'; item.append(price);
    } else {
      const price = document.createElement('p'); price.className = 'model-protocols'; price.textContent = billingKnown ? '未配置计费价格' : '价格未返回，请联系管理员确认。'; item.append(price);
    }
    item.append(copy); portalElements['models-list'].append(item);
  }
}

function renderPortalUser(data) {
  portalUser = data.user;
  portalElements['user-summary'].textContent = `用户名：${String(portalUser?.username ?? '—')}`;
  const banner = portalElements['account-banner'];
  banner.hidden = !userDisabled() && !keyAccessExpired();
  banner.textContent = userDisabled() ? '账号已停用，所有 API Key 均无法调用。请联系管理员。'
    : keyAccessExpired() ? 'API Key 授权已到期。账号仍可登录，请联系管理员续期。' : '';
  const defaultDays = Number(data.keyDefaults?.expiresInDays ?? portalConfig?.keyDefaults?.expiresInDays ?? 30);
  if (Number.isInteger(defaultDays) && defaultDays > 0 && defaultDays <= 365) portalElements['key-days'].value = String(defaultDays);
  portalElements['key-expiry-note'].textContent = typeof portalUser?.keyExpiresAtLimit === 'string'
    ? `到期后 Key 自动失效。当前授权最晚截止：${portalDate(portalUser.keyExpiresAtLimit)}。新建 Key 不会延长该截止时间。`
    : '到期后此 Key 自动失效，账号仍可登录。';
  renderPortalConnections(data.gateway ?? portalConfig?.gateway);
  renderPortalKeys(data.keys);
  renderPortalModels(data.models, data.billing);
  renderPortalBilling(data.billing);
  portalElements['auth-panel'].hidden = true;
  portalElements['dashboard-panel'].hidden = false;
  updatePortalControls();
}

async function refreshPortal() {
  const generation = portalGeneration;
  const data = await portalApi('me');
  if (generation !== portalGeneration) return;
  if (!data.user || typeof data.user.username !== 'string') throw new Error('用户信息不完整，请重新登录。');
  renderPortalUser(data);
}

async function submitPortalCredentials(event) {
  event.preventDefault();
  if (portalBusy) return;
  const username = portalElements.username.value.trim(), password = portalElements.password.value;
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username) || password.length < 12 || password.length > 256) {
    handlePortalError(new Error('用户名需为 3–64 个字母、数字或 _.-；密码需为 12–256 个字符。'), true); return;
  }
  const mode = portalAuthMode;
  if (mode === 'register' && portalConfig?.registration?.enabled !== true) return;
  portalBusy = true; updatePortalControls(); portalElements['auth-error'].hidden = true; portalNotice('');
  const body = { username, password };
  if (mode === 'register' && portalElements['invite-code'].value.trim()) body.inviteToken = portalElements['invite-code'].value.trim();
  try {
    const result = await portalApi(mode, { method: 'POST', body });
    portalElements.password.value = '';
    portalElements['invite-code'].value = '';
    portalGeneration++;
    portalCsrfToken = typeof result.csrfToken === 'string' ? result.csrfToken : null;
    portalUser = result.user;
    if (mode === 'register') showNewKey(result);
    renderPortalUser({ user: result.user, keys: result.key ? [result.key] : [], models: [],
      gateway: portalConfig?.gateway, keyDefaults: portalConfig?.keyDefaults });
    await refreshPortal();
  } catch (error) { handlePortalError(error, portalElements['dashboard-panel'].hidden); }
  finally { portalElements.password.value = ''; portalBusy = false; updatePortalControls(); }
}

async function createPortalKey(event) {
  event.preventDefault();
  if (portalBusy || !portalUser || userDisabled() || keyAccessExpired()) return;
  const name = portalElements['key-name'].value.trim(), expiresInDays = Number(portalElements['key-days'].value);
  if (!name || name.length > 80 || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    portalNotice('请填写密钥名称和 1–365 的整数有效天数。'); return;
  }
  portalBusy = true; updatePortalControls(); clearNewKey(); portalNotice('');
  try {
    const result = await portalApi('keys', { method: 'POST', body: { name, expiresInDays } });
    showNewKey(result); portalElements['key-name'].value = '';
    await refreshPortal();
    portalNotice('密钥已创建，请保存本次显示的完整 Key。', true);
  } catch (error) { handlePortalError(error); }
  finally { portalBusy = false; updatePortalControls(); }
}

async function revokePortalKey(id, name) {
  if (portalBusy || !portalUser) return;
  if (!window.confirm(`撤销“${String(name || '此密钥')}”后，使用它的客户端将无法继续调用。确定撤销？`)) return;
  portalBusy = true; updatePortalControls(); portalNotice('');
  try {
    await portalApi(`keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (displayedKeyId === id) clearNewKey();
    await refreshPortal(); portalNotice('密钥已撤销。', true);
  } catch (error) { handlePortalError(error); }
  finally { portalBusy = false; updatePortalControls(); }
}

async function logoutPortal() {
  if (portalBusy) return;
  portalBusy = true; updatePortalControls(); portalNotice(''); clearNewKey();
  try { await portalApi('logout', { method: 'POST', body: {} }); showPortalLogin(); }
  catch (error) { handlePortalError(error); }
  finally { portalBusy = false; updatePortalControls(); }
}

async function initializePortal() {
  portalBusy = true; updatePortalControls();
  try {
    portalConfig = await portalApi('config');
    setPortalAuthMode('login');
    try {
      const session = await portalApi('session');
      if (session.user) {
        portalCsrfToken = typeof session.csrfToken === 'string' ? session.csrfToken : null;
        portalUser = session.user; await refreshPortal();
      }
    } catch (error) { if (error.status !== 401) handlePortalError(error); }
  } catch (error) { portalNotice(error.message); }
  finally { portalBusy = false; setPortalAuthMode('login'); updatePortalControls(); }
}

portalElements['login-tab'].addEventListener('click', () => setPortalAuthMode('login'));
portalElements['register-tab'].addEventListener('click', () => setPortalAuthMode('register'));
for (const mode of ['login', 'register']) {
  portalElements[`${mode}-tab`].addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : mode === 'login' ? 'register' : 'login';
    if (next === 'register' && portalConfig?.registration?.enabled !== true) return;
    setPortalAuthMode(next); portalElements[`${next}-tab`].focus();
  });
}
portalElements['credentials-form'].addEventListener('submit', submitPortalCredentials);
portalElements['key-form'].addEventListener('submit', createPortalKey);
portalElements['secret-dismiss'].addEventListener('click', clearNewKey);
portalElements['secret-copy'].addEventListener('click', () => {
  if (!portalElements['new-key-secret'].value) return;
  copyPortalText(portalElements['new-key-secret'].value, portalElements['secret-copy-status']);
});
portalElements['portal-logout'].addEventListener('click', logoutPortal);
portalElements['portal-refresh'].addEventListener('click', async () => {
  if (portalBusy) return;
  portalBusy = true; updatePortalControls(); portalNotice('');
  try { await refreshPortal(); }
  catch (error) { handlePortalError(error); }
  finally { portalBusy = false; updatePortalControls(); }
});
window.addEventListener('pagehide', () => { portalVisible = false; clearNewKey(); });
window.addEventListener('pageshow', () => { portalVisible = true; });
initializePortal();
