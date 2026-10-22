'use strict';

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'connection-dot', 'connection-label', 'version', 'notice', 'setup-state',
  'step-login', 'step-bind', 'step-verify', 'login-button', 'device-login-button', 'authorization-link',
  'device-authorization', 'device-user-code', 'device-authorization-link',
  'login-state', 'account-card', 'account-email', 'account-plan', 'logout-button',
  'bind-button', 'bind-description', 'bound-account', 'model-select', 'verify-button',
  'verification-result', 'verification-label', 'verification-text', 'verification-meta',
  'integration-state', 'integration-description', 'config-path', 'install-button',
  'copy-button', 'restore-button', 'gateway-state', 'gateway-url', 'metric-requests',
  'metric-completed', 'metric-failed', 'gateway-error',
  'metric-a-requests', 'metric-a-completed', 'metric-a-failed', 'account-a-last-model',
  'metric-b-requests', 'metric-b-completed', 'metric-b-failed', 'account-b-last-model',
  'token-state', 'token-total-input', 'token-total-output', 'token-total-all',
  'token-total-cached', 'token-total-reasoning', 'token-a-input', 'token-a-output',
  'token-a-cached', 'token-a-reasoning', 'token-b-input', 'token-b-output',
  'token-b-cached', 'token-b-reasoning', 'token-started-at', 'token-coverage',
  'token-error', 'token-recent-body',
  'with-title', 'with-state', 'with-vm-state', 'with-vm-address', 'with-gateway-url',
  'with-authentication', 'with-requests', 'with-completed', 'with-failed', 'with-active', 'with-error',
  'token-with-input', 'token-with-output', 'token-with-cached', 'token-with-reasoning',
  'codebuddy-title', 'codebuddy-state', 'codebuddy-login-button', 'codebuddy-logout-button',
  'codebuddy-authorization-link', 'codebuddy-login-state', 'codebuddy-username',
  'codebuddy-authentication', 'codebuddy-model-available', 'codebuddy-gateway-url', 'codebuddy-codex-url',
  'codebuddy-transport', 'codebuddy-billing-multiplier', 'codebuddy-source-credits',
  'codebuddy-catalog-source', 'codebuddy-catalog-saved-at', 'codebuddy-catalog-note',
  'codebuddy-source-promotion', 'codebuddy-requests', 'codebuddy-completed',
  'codebuddy-failed', 'codebuddy-active', 'codebuddy-error',
  'token-codebuddy-input', 'token-codebuddy-output', 'token-codebuddy-cached', 'token-codebuddy-reasoning',
  'token-claude-row', 'token-claude-input', 'token-claude-output', 'token-claude-cached', 'token-claude-reasoning',
  'quota-refresh-button', 'quota-a-plan', 'quota-a-state', 'quota-a-windows',
  'quota-a-credits', 'quota-a-error', 'quota-a-updated', 'quota-b-plan', 'quota-b-state',
  'quota-b-windows', 'quota-b-credits', 'quota-b-error', 'quota-b-updated',
  'service-state', 'service-ready', 'service-independent', 'service-active', 'service-restart-button',
  'service-message', 'service-error', 'service-confirmation', 'service-confirmation-message', 'service-confirm-button', 'service-cancel-button',
  'model-settings-state', 'model-settings-list', 'model-settings-save-button', 'model-settings-reset-button', 'model-settings-refresh-button',
  'model-settings-message', 'model-settings-error',
  'cursor-state', 'cursor-login-button', 'cursor-logout-button', 'cursor-authorization-link', 'cursor-login-state',
  'cursor-account', 'cursor-plan', 'cursor-gemini-state', 'cursor-grok-state',
  'cursor-requests', 'cursor-completed', 'cursor-failed', 'cursor-active', 'cursor-error'
].map((id) => [id, byId(id)]));

let status = null;
let statusRequest = null;
let busyAction = null;
let modelsLoaded = false;
let modelsRequest = null;
let noticeTimer = null;
let tokenUsageRequest = null;
let withRequest = null;
let codeBuddyRequest = null;
let codeBuddyStatus = null;
let managementConnected = false;
let accountQuotasRequest = null;
let serviceStatus = null;
let serviceRequest = null;
let serviceUnavailable = false;
let serviceError = '';
let restartInProgress = false;
let restartConfirmation = false;
let restartActiveRequests = 0;
let modelSettings = null;
let modelSettingsRequest = null;
let modelSettingsUnavailable = false;
let modelSettingsError = '';
let modelDraft = new Map();
let cursorStatus = null;
let cursorRequest = null;

function text(id, value) {
  elements[id].textContent = value == null ? '' : String(value);
}

function pill(id, label, kind = '') {
  text(id, label);
  elements[id].className = `pill${kind ? ` ${kind}` : ''}`;
}

function notify(message, isError = false) {
  clearTimeout(noticeTimer);
  text('notice', message);
  elements.notice.hidden = false;
  elements.notice.className = `notice${isError ? ' error' : ''}`;
  if (!isError) noticeTimer = setTimeout(() => { elements.notice.hidden = true; }, 9000);
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function post(path, body = {}) {
  if (!status?.csrfToken) await refreshStatus();
  if (!status?.csrfToken) throw new Error('本机服务尚未就绪，请稍后重试。');
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-CSRF': status.csrfToken },
    body: JSON.stringify(body)
  });
}

function renderServiceControl() {
  const data = serviceStatus;
  const reportedError = serviceError || (typeof data?.error === 'string' ? data.error : data?.error?.message || '');
  const idle = managementConnected && !busyAction && !restartInProgress;
  text('service-ready', data ? data.ready === true ? '已就绪' : '尚未就绪' : '未取得状态');
  text('service-independent', data ? data.independentOfCodex === true ? '独立运行，关闭 Codex 后继续服务' : '尚未确认独立运行' : '未取得状态');
  text('service-active', Number.isSafeInteger(data?.activeRequests) && data.activeRequests >= 0 ? data.activeRequests.toLocaleString('zh-CN') : '未返回');
  if (restartInProgress) pill('service-state', '正在重启', 'pending');
  else if (serviceUnavailable) pill('service-state', '待更新服务', 'pending');
  else if (reportedError) pill('service-state', '状态需检查', 'error');
  else if (data?.pending) pill('service-state', '等待重启', 'pending');
  else pill('service-state', data?.ready ? '已就绪' : '尚未就绪', data?.ready ? 'success' : 'pending');
  elements['service-restart-button'].disabled = !idle || serviceUnavailable || serviceError !== '' || data?.supported !== true || data?.pending === true || restartConfirmation;
  text('service-restart-button', restartInProgress || data?.pending ? '正在重启…' : '重启网关服务');
  elements['service-confirmation'].hidden = !restartConfirmation;
  text('service-confirmation-message', restartActiveRequests > 0
    ? `当前仍有 ${restartActiveRequests.toLocaleString('zh-CN')} 个请求进行中。现在重启会中断这些请求，是否继续？`
    : '当前已没有进行中的请求。确认重启网关服务？');
  text('service-confirm-button', restartActiveRequests > 0 ? '允许中断并重启' : '确认重启');
  elements['service-confirm-button'].disabled = !idle;
  elements['service-cancel-button'].disabled = !idle;
  text('service-error', serviceUnavailable ? '重启服务后可用。当前服务尚未提供网页重启接口；Windows 请在项目目录运行 .\\Start-Bridge.ps1 -Restart -Open，然后刷新本页。' : reportedError);
  elements['service-error'].hidden = !serviceUnavailable && !reportedError;
  if (!restartInProgress && !restartConfirmation && !serviceUnavailable && !serviceError && data?.message) text('service-message', data.message);
  else if (!restartInProgress && !restartConfirmation && !serviceUnavailable && !serviceError && data?.supported === false) text('service-message', '当前运行方式暂不支持网页重启，请按部署方式手动重启服务；Windows 可在项目目录运行 .\\Start-Bridge.ps1 -Restart -Open。');
}

async function refreshServiceStatus() {
  if (serviceRequest) return serviceRequest;
  serviceRequest = (async () => {
    try {
      serviceStatus = await request('/api/service/status', { signal: AbortSignal.timeout(5000) });
      serviceUnavailable = false; serviceError = '';
      if (restartConfirmation && Number.isSafeInteger(serviceStatus.activeRequests) && serviceStatus.activeRequests >= 0) restartActiveRequests = serviceStatus.activeRequests;
    } catch (error) {
      serviceUnavailable = error.status === 404;
      serviceError = serviceUnavailable ? '' : error.message || '暂时无法读取服务状态。';
    } finally { serviceRequest = null; renderServiceControl(); }
  })();
  return serviceRequest;
}

function modelSettingsDirty() {
  return modelSettings?.models.some(model => modelDraft.get(model.id) !== model.enabled) === true;
}

function renderModelSettingsControls() {
  const dirty = modelSettingsDirty();
  const available = managementConnected && !busyAction && !restartInProgress && !modelSettingsUnavailable && !modelSettingsError && modelSettings !== null;
  elements['model-settings-save-button'].disabled = !available || !dirty;
  elements['model-settings-reset-button'].disabled = !available || !dirty;
  elements['model-settings-refresh-button'].disabled = !managementConnected || Boolean(busyAction) || restartInProgress || Boolean(modelSettingsRequest);
  text('model-settings-save-button', busyAction === 'model-settings-save' ? '正在保存…' : '保存模型选择');
  elements['model-settings-list'].querySelectorAll('input').forEach(input => { input.disabled = !available; });
  if (modelSettingsUnavailable) pill('model-settings-state', '待更新服务', 'pending');
  else if (modelSettingsError) pill('model-settings-state', '读取失败', 'error');
  else if (modelSettings) {
    const selected = modelSettings.models.filter(model => modelDraft.get(model.id)).length;
    pill('model-settings-state', dirty ? '有未保存更改' : `${selected} / ${modelSettings.models.length} 已启用`, dirty ? 'pending' : 'success');
  }
  text('model-settings-error', modelSettingsUnavailable ? '重启服务后可用。当前服务尚未提供模型选择接口。' : modelSettingsError);
  elements['model-settings-error'].hidden = !modelSettingsUnavailable && !modelSettingsError;
}

function renderModelSettingsList() {
  const groups = new Map();
  for (const model of modelSettings?.models ?? []) {
    const channel = model.channel || '其他渠道';
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(model);
  }
  const labels = { A: '账号 A', B: '账号 B', CodeBuddy: 'CodeBuddy', Cursor: 'Cursor Teams', CursorTeams: 'Cursor Teams' };
  const nodes = [];
  for (const [channel, models] of groups) {
    const group = document.createElement('fieldset'); group.className = 'model-settings-group';
    const legend = document.createElement('legend'); legend.textContent = labels[channel] || channel;
    group.append(legend);
    for (const model of models) {
      const label = document.createElement('label'); label.className = 'model-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = modelDraft.get(model.id) === true;
      checkbox.addEventListener('change', () => { modelDraft.set(model.id, checkbox.checked); renderModelSettingsControls(); });
      const details = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = model.name || model.id;
      const identifier = document.createElement('small'); identifier.textContent = model.id;
      details.append(title, identifier); label.append(checkbox, details); group.append(label);
    }
    nodes.push(group);
  }
  if (!nodes.length) {
    const empty = document.createElement('p'); empty.className = 'model-settings-empty';
    empty.textContent = '暂时没有可显示的模型。请先确认渠道授权，再刷新列表。'; nodes.push(empty);
  }
  elements['model-settings-list'].replaceChildren(...nodes);
  renderModelSettingsControls();
}

async function refreshModelSettings({ replaceDraft = false } = {}) {
  if (modelSettingsRequest) return modelSettingsRequest;
  modelSettingsRequest = (async () => {
    try {
      const data = await request('/api/model-settings', { signal: AbortSignal.timeout(10000) });
      if (data.revision == null || !Array.isArray(data.models) || data.models.some(model => typeof model?.id !== 'string' || typeof model.enabled !== 'boolean')) throw new Error('服务返回的模型列表格式无效。');
      modelSettingsUnavailable = false; modelSettingsError = typeof data.error === 'string' ? data.error : data.error?.message || '';
      const changed = !modelSettings || JSON.stringify(data) !== JSON.stringify(modelSettings);
      if (replaceDraft || !modelSettingsDirty()) {
        modelSettings = data;
        if (changed || replaceDraft) { modelDraft = new Map(data.models.map(model => [model.id, model.enabled])); renderModelSettingsList(); }
      } else if (data.revision !== modelSettings.revision) text('model-settings-message', '模型列表已有更新。保存时会核对版本，也可以刷新列表重新选择。');
    } catch (error) {
      modelSettingsUnavailable = error.status === 404;
      modelSettingsError = modelSettingsUnavailable ? '' : error.message || '暂时无法读取模型列表。';
      if (!modelSettings) {
        const empty = document.createElement('p'); empty.className = 'model-settings-empty';
        empty.textContent = modelSettingsUnavailable ? '重启服务后可用。' : '模型列表暂时无法读取。';
        elements['model-settings-list'].replaceChildren(empty);
      }
    } finally { modelSettingsRequest = null; renderModelSettingsControls(); }
  })();
  return modelSettingsRequest;
}

async function bootstrapManagementSession(signal) {
  const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`管理页面暂不可用（HTTP ${response.status}）。`);
  await response.text();
}

async function waitForServiceRestart(previousToken, reconnectAfterMs = 1500) {
  const deadline = Date.now() + 60000;
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  await pause(Math.min(10000, Math.max(750, Number.isFinite(reconnectAfterMs) ? reconnectAfterMs : 1500)));
  let reconnected = false;
  while (Date.now() < deadline) {
    try {
      const health = await request('/health', { signal: AbortSignal.timeout(Math.min(2000, deadline - Date.now())) });
      if (health.ok !== true) throw new Error('服务尚未就绪。');
      await bootstrapManagementSession(AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))));
      await refreshStatus({ duringRestart: true, signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
      serviceStatus = await request('/api/service/status', { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
      serviceUnavailable = false; serviceError = ''; renderServiceControl();
      const reportedError = typeof serviceStatus?.error === 'string' ? serviceStatus.error : serviceStatus?.error?.message;
      if (reportedError && !serviceStatus.pending) {
        const error = new Error(`服务重启未完成：${reportedError}`); error.restartFailed = true; throw error;
      }
      if (!status?.csrfToken || status.csrfToken === previousToken) throw new Error('正在等待新服务接管。');
      reconnected = true;
      if (serviceUnavailable || serviceError || serviceStatus?.pending || serviceStatus?.ready !== true) throw new Error('服务已连接，正在等待就绪。');
      return;
    } catch (error) {
      if (error.restartFailed) throw error;
      // A restarting service can refuse connections or invalidate its old cookie.
    }
    text('service-message', reconnected ? '服务已重新连接，正在等待就绪…' : '正在等待网关服务恢复连接…');
    if (Date.now() < deadline) await pause(Math.min(1500, deadline - Date.now()));
  }
  throw new Error(reconnected ? '服务已重新连接，但 60 秒内尚未就绪。请查看当前服务状态。' : '60 秒内未确认新服务恢复。请检查服务状态后重试。');
}

async function restartService(allowInterrupt = false) {
  if (busyAction || restartInProgress) return;
  await action('service-restart', async () => {
    serviceError = ''; restartConfirmation = false;
    if (!status?.csrfToken) await refreshStatus();
    if (!status?.csrfToken) throw new Error('本机服务尚未就绪，请稍后重试。');
    const previousToken = status?.csrfToken;
    let accepted;
    try { accepted = await post('/api/service/restart', { allowInterrupt }); }
    catch (error) {
      let active = error.data?.activeRequests ?? error.data?.error?.activeRequests;
      const activeConflict = error.data?.error?.code === 'gateway_busy' || Number.isSafeInteger(active);
      if (error.status === 409 && activeConflict && !Number.isSafeInteger(active)) {
        await refreshServiceStatus();
        active = serviceStatus?.activeRequests;
      }
      if (error.status === 409 && activeConflict && Number.isSafeInteger(active) && active > 0) {
        restartActiveRequests = active; restartConfirmation = true; renderServiceControl(); return;
      }
      throw error;
    }
    if (accepted.accepted !== true) throw new Error('服务未确认重启请求，请查看当前状态。');
    restartInProgress = true;
    text('service-message', '已提交重启，正在等待网关恢复…'); renderServiceControl();
    try {
      await waitForServiceRestart(previousToken, accepted.reconnectAfterMs);
      text('service-message', '服务已重启并恢复连接。');
      notify('网关服务已重启并恢复连接。');
    } catch (error) {
      text('service-message', error.message || '尚未确认服务恢复。');
      throw error;
    } finally { restartInProgress = false; }
  });
}

function safeAuthorizationUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin === 'https://auth.openai.com' && !url.username && !url.password) return url.href;
  } catch { /* Invalid authorization links are never attached to the page. */ }
  return null;
}

function safeCodeBuddyAuthorizationUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const hosts = new Set(['copilot.tencent.com', 'www.codebuddy.cn',
      'tencent.sso.codebuddy.cn', 'tencent.sso.copilot.tencent.com']);
    if (url.protocol === 'https:' && !url.port && hosts.has(url.hostname) && !url.username && !url.password) return url.href;
  } catch { /* Only official HTTPS login pages may be opened. */ }
  return null;
}

function safeCursorAuthorizationUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'cursor.com' && !url.port && !url.username && !url.password) return url.href;
  } catch { /* Authorization stays on the verified official HTTPS origin. */ }
  return null;
}

function renderCursor(data) {
  const login = data.login || {}, gateway = data.gateway || {}, catalog = data.catalog || {};
  const pending = ['starting', 'pending'].includes(login.state) || busyAction === 'cursor-login';
  const authenticated = data.authReady === true;
  const idle = managementConnected && !busyAction && !restartInProgress;
  const url = safeCursorAuthorizationUrl(login.url);
  text('cursor-account', data.profile?.email || data.profile?.userEmail || data.profile?.name || (authenticated ? '已授权（未返回账号资料）' : '待授权'));
  const plan = data.plan?.name || data.plan?.declared;
  text('cursor-plan', plan ? `${plan}${data.plan?.verified === true ? '（已核实）' : '（待核实）'}` : '未返回');
  const models = Array.isArray(catalog.models) ? catalog.models : Array.isArray(catalog.targetModels) ? catalog.targetModels : [];
  for (const [element, modelId] of [['cursor-gemini-state', 'gemini-4-argon'], ['cursor-grok-state', 'grok-4.7']]) {
    text(element, !authenticated ? '登录后确认' : models.some(model => model?.id === modelId) ? '账号目录已确认' : '账号目录未返回');
  }
  for (const metric of ['requests', 'completed', 'failed', 'active']) text(`cursor-${metric}`, tokenCount(gateway[metric]));
  elements['cursor-login-button'].disabled = !idle || data.configured !== true || authenticated || pending;
  elements['cursor-logout-button'].disabled = !idle || data.configured !== true || !authenticated && !pending && data.enabled !== true;
  text('cursor-login-button', pending ? '等待官方授权…' : authenticated ? 'Cursor 已授权' : '官方网页登录');
  text('cursor-logout-button', busyAction === 'cursor-logout' ? '正在退出…' : '退出本网关会话');
  elements['cursor-authorization-link'].hidden = !pending || !url;
  if (pending && url) elements['cursor-authorization-link'].href = url;
  else elements['cursor-authorization-link'].removeAttribute('href');
  const expiry = login.expiresAt ? ` 有效期至 ${tokenTime(login.expiresAt, 'America/Los_Angeles')}。` : '';
  text('cursor-login-state', !data.configured ? 'Cursor 渠道尚未配置。'
    : pending ? `请在 Cursor 官方页面由本人完成账号授权，此处会自动更新。${expiry}`
      : authenticated ? data.enabled ? 'Cursor 已授权，模型会按账号目录加入可选列表。' : 'Cursor 已授权，渠道尚未启用。'
        : login.state === 'complete' ? '官方授权已完成，等待账号目录更新。'
          : login.state === 'error' || login.state === 'expired' ? login.error || '本次授权未完成，请重新登录。' : '通过官方页面登录提供额度的 Cursor Teams 账号。');
  const errors = [data.error, login.error].map(error => typeof error === 'string' ? error : error?.message).filter(Boolean);
  text('cursor-error', [...new Set(errors)].join(' · ')); elements['cursor-error'].hidden = !errors.length;
  if (errors.length) pill('cursor-state', '需检查', 'error');
  else if (!data.configured) pill('cursor-state', '待配置');
  else if (pending) pill('cursor-state', '等待授权', 'pending');
  else if (authenticated) pill('cursor-state', data.enabled ? '已授权' : '渠道未启用', data.enabled ? 'success' : 'pending');
  else pill('cursor-state', '待授权', 'pending');
}

async function refreshCursor() {
  if (cursorRequest) return cursorRequest;
  cursorRequest = (async () => {
    try { cursorStatus = await request('/api/cursor', { signal: AbortSignal.timeout(20000) }); renderCursor(cursorStatus); }
    catch (error) {
      cursorStatus = null; pill('cursor-state', error.status === 404 ? '待更新服务' : '读取失败', error.status === 404 ? 'pending' : 'error');
      text('cursor-login-state', error.status === 404 ? '重启服务后可用。' : 'Cursor 状态暂时无法读取。');
      text('cursor-error', error.status === 404 ? '当前服务尚未提供 Cursor 授权接口。' : error.message || '请稍后重试。');
      elements['cursor-error'].hidden = false;
      elements['cursor-login-button'].disabled = true; elements['cursor-logout-button'].disabled = true;
      elements['cursor-authorization-link'].hidden = true; elements['cursor-authorization-link'].removeAttribute('href');
    } finally { cursorRequest = null; }
  })();
  return cursorRequest;
}

function render() {
  if (!status) return;
  const backend = status.backend || {};
  const gateway = status.gateway || {};
  const integration = status.integration || {};
  const needsUpgrade = Boolean(integration.installed && integration.needsUpgrade);
  const verification = status.verification || {};
  const login = backend.login || {};
  const account = backend.account;
  const pinned = backend.pinnedAccount;
  const hasAccount = Boolean(account);
  const bound = Boolean(pinned && account && pinned.email === account.email);
  const passed = verification.status === 'passed';
  const verifying = verification.status === 'running' || busyAction === 'verify';
  const idle = !busyAction;

  elements['connection-dot'].className = 'status-dot connected';
  text('connection-label', status.ready ? '本机服务已就绪' : '本机服务已连接');
  text('version', status.version ? `v${status.version}` : '');

  elements['step-login'].className = `step${hasAccount ? ' complete' : ' active'}`;
  elements['step-bind'].className = `step${bound ? ' complete' : hasAccount ? ' active' : ''}`;
  elements['step-verify'].className = `step${passed ? ' complete' : bound ? ' active' : ''}`;
  if (passed) pill('setup-state', '验证通过', 'success');
  else if (verifying) pill('setup-state', '正在验证', 'pending');
  else if (bound) pill('setup-state', '待验证', 'pending');
  else if (hasAccount) pill('setup-state', '待确认账号', 'pending');
  else pill('setup-state', login.state === 'pending' ? '等待授权' : '待登录', login.state === 'pending' ? 'pending' : '');

  const loggingIn = login.state === 'pending' || busyAction === 'login' || busyAction === 'device-login';
  const deviceLogin = busyAction === 'device-login' || (busyAction !== 'login' && login.method === 'deviceCode');
  const browserPending = loggingIn && !deviceLogin;
  const devicePending = loggingIn && deviceLogin;
  elements['login-button'].disabled = !idle || browserPending || hasAccount;
  elements['device-login-button'].disabled = !idle || devicePending || hasAccount;
  text('login-button', hasAccount ? '账号已登录' : browserPending ? '等待浏览器授权…' : '浏览器登录');
  text('device-login-button', hasAccount ? '账号已登录' : devicePending ? '等待手机授权…' : '手机授权');
  const authUrl = safeAuthorizationUrl(login.url);
  elements['authorization-link'].hidden = !authUrl || !browserPending;
  if (authUrl) elements['authorization-link'].href = authUrl;
  else elements['authorization-link'].removeAttribute('href');
  elements['device-authorization'].hidden = !devicePending || !authUrl || !login.userCode;
  text('device-user-code', devicePending ? login.userCode : '');
  text('device-authorization-link', devicePending ? authUrl : '');
  if (authUrl && devicePending) elements['device-authorization-link'].href = authUrl;
  else elements['device-authorization-link'].removeAttribute('href');
  text('login-state', loggingIn ? deviceLogin ? '请在手机完成官方设备授权，此处会自动更新。' : '请在浏览器官方页面完成授权，此处会自动更新。' : login.state === 'error' ? (login.error || '登录未完成，请重试。') : '');
  elements['account-card'].hidden = !hasAccount;
  text('account-email', account?.email || '已登录账号（未返回邮箱）');
  text('account-plan', [account?.planType, account?.type].filter(Boolean).join(' · ') || '订阅信息由官方登录结果提供');
  elements['logout-button'].disabled = !idle || verifying;
  elements['bind-button'].disabled = !idle || !hasAccount || bound || verifying;
  text('bind-button', busyAction === 'bind' ? '正在确认…' : bound ? '已确认账号 B' : '确认此账号为 B');
  text('bind-description', bound ? '已固定下方账号 B。B-GPT-6 Astra 与 B-GPT-6.1 Sol 使用该账号的授权。' : '核对上方邮箱，确认它就是你要使用订阅额度的账号 B。');
  text('bound-account', pinned ? `已确认：${pinned.email || '账号 B'}${pinned.planType ? ` · ${pinned.planType}` : ''}` : '');

  elements['model-select'].disabled = !idle || !bound || verifying;
  elements['verify-button'].disabled = !idle || !bound || verifying;
  text('verify-button', verifying ? '正在推理…' : passed ? '重新验证' : '验证推理');
  elements['verification-result'].hidden = !verification.status || verification.status === 'not_run';
  elements['verification-result'].className = `verification-result${passed ? ' success' : verification.status === 'failed' ? ' error' : ''}`;
  text('verification-label', passed ? '真实推理已完成' : verification.status === 'failed' ? '推理未通过' : '正在等待模型回复');
  text('verification-text', verification.error || verification.text || (verifying ? '正在通过网关向账号 B 发送验证请求。' : ''));
  let checkedAt = '';
  if (verification.checkedAt) {
    const date = new Date(verification.checkedAt);
    if (!Number.isNaN(date.getTime())) checkedAt = date.toLocaleString('zh-CN');
  }
  text('verification-meta', [verification.accountEmail, checkedAt].filter(Boolean).join(' · '));

  pill('integration-state', needsUpgrade ? '待更新路由' : integration.installed ? '已接入' : '未接入', needsUpgrade ? 'pending' : integration.installed ? 'success' : '');
  text('integration-description', needsUpgrade ? '更新模型路由后，原有模型使用账号 A，新增的两个 B 模型使用账号 B。' : integration.installed ? '已为本机 Codex 添加两个 B 模型。原有模型使用账号 A，两个 B 模型使用账号 B。' : integration.reason || '完成推理验证后，在 Codex 模型选择器中添加两个 B 模型，并按模型分配账号。');
  text('config-path', integration.configPath || '未检测到配置路径');
  elements['install-button'].disabled = !idle || !passed || !bound || !integration.canInstall || (integration.installed && !needsUpgrade) || verifying;
  text('install-button', busyAction === 'install' ? '正在写入配置…' : needsUpgrade ? '更新模型路由' : integration.installed ? '本机 Codex 已接入' : '接入本机 Codex');
  elements['copy-button'].disabled = !idle || !passed || !bound || verifying;
  text('copy-button', busyAction === 'copy' ? '正在复制…' : '复制接入配置');
  elements['restore-button'].hidden = !integration.installed;
  elements['restore-button'].disabled = !idle || verifying;
  text('restore-button', busyAction === 'restore' ? '正在恢复…' : '恢复接入前配置');

  pill('gateway-state', gateway.enabled ? '可接收请求' : backend.running ? '等待确认账号' : '等待后端启动', gateway.enabled ? 'success' : '');
  text('gateway-url', gateway.baseUrl || '服务启动后显示');
  for (const [id, value] of [['requests', gateway.requests], ['completed', gateway.completed], ['failed', gateway.failed]]) {
    text(`metric-${id}`, Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '0');
  }
  for (const accountId of ['A', 'B']) {
    const accountUsage = gateway.accounts?.[accountId] || {};
    for (const metric of ['requests', 'completed', 'failed']) {
      const value = Number(accountUsage[metric]);
      text(`metric-${accountId.toLowerCase()}-${metric}`, Number.isFinite(value) ? value.toLocaleString('zh-CN') : '0');
    }
    text(`account-${accountId.toLowerCase()}-last-model`, accountUsage.lastModel || '尚无请求');
  }
  elements['gateway-error'].hidden = !gateway.lastError;
  text('gateway-error', typeof gateway.lastError === 'string' ? gateway.lastError : gateway.lastError?.message || '');
  if (codeBuddyStatus) renderCodeBuddy(codeBuddyStatus);
  if (cursorStatus) renderCursor(cursorStatus);
  renderServiceControl();
  renderModelSettingsControls();
}

async function refreshStatus({ duringRestart = false, signal } = {}) {
  if (restartInProgress && !duringRestart) return status;
  if (statusRequest) return statusRequest;
  statusRequest = (async () => {
    try {
      try { status = await request('/api/status', { signal: signal ?? AbortSignal.timeout(5000) }); }
      catch (error) {
        if (error.status !== 401 || restartInProgress) throw error;
        await bootstrapManagementSession(AbortSignal.timeout(5000));
        status = await request('/api/status', { signal: AbortSignal.timeout(5000) });
      }
      managementConnected = true;
      render();
      if (!restartInProgress) {
        if (status.backend?.account && !modelsLoaded) void loadModels();
        if (!status.backend?.account) modelsLoaded = false;
        void refreshTokenUsage();
        void refreshWith();
        void refreshCodeBuddy();
        void refreshCursor();
        void refreshServiceStatus();
        void refreshModelSettings();
      }
      return status;
    } catch (error) {
      managementConnected = false;
      elements['connection-dot'].className = 'status-dot failed';
      text('connection-label', restartInProgress ? '正在等待网关恢复连接' : '本机服务连接中断，正在重试');
      document.querySelectorAll('button:not(#quota-refresh-button)').forEach((button) => { button.disabled = true; });
      throw error;
    } finally {
      statusRequest = null;
    }
  })();
  return statusRequest;
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未返回';
}

function tokenTime(value, timeZone) {
  if (value == null || value === '') return '未返回';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未返回';
  try {
    return date.toLocaleString('zh-CN', { timeZone: timeZone || undefined, hour12: false });
  } catch {
    return String(value);
  }
}

function quotaTime(value, timeZone) {
  if (value == null || value === '') return '未返回';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未返回';
  try {
    return date.toLocaleString('zh-CN', { timeZone, hour12: false });
  } catch {
    return date.toLocaleString('zh-CN', { timeZone: 'America/Los_Angeles', hour12: false });
  }
}

function renderAccountQuotas(data) {
  const timeZone = data.timeZone || 'America/Los_Angeles';
  for (const accountId of ['A', 'B']) {
    const prefix = `quota-${accountId.toLowerCase()}`;
    const account = data.accounts?.[accountId];
    const succeeded = account?.status === 'ok';
    text(`${prefix}-plan`, account?.planType || '套餐未返回');
    const windows = succeeded && Array.isArray(account.windows) ? account.windows : [];
    const rows = windows.map((window) => {
      const row = document.createElement('div');
      row.className = 'quota-window';
      const heading = document.createElement('div');
      heading.className = 'quota-window-heading';
      const label = document.createElement('span');
      label.textContent = window.label || '额度窗口';
      const percentage = document.createElement('strong');
      const remaining = window.remainingPercent;
      const known = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100;
      percentage.textContent = known ? `剩余 ${remaining.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%` : '剩余额度未返回';
      heading.append(label, percentage);
      row.append(heading);
      if (known) {
        const progress = document.createElement('progress');
        progress.className = 'quota-progress';
        progress.max = 100;
        progress.value = remaining;
        progress.setAttribute('aria-label', `${label.textContent}：${percentage.textContent}`);
        row.append(progress);
      }
      const reset = document.createElement('small');
      reset.textContent = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
        ? `重置时间：${quotaTime(window.resetsAt * 1000, timeZone)}` : '重置时间：未返回';
      row.append(reset);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'quota-empty';
      empty.textContent = succeeded ? '官方未返回额度窗口' : '本次未取得官方额度';
      rows.push(empty);
    }
    elements[`${prefix}-windows`].replaceChildren(...rows);
    const credits = succeeded ? account.credits : null;
    const creditLabels = [];
    if (credits?.unlimited === true) creditLabels.push('额外额度：不限量');
    else if (typeof credits?.balance === 'string' && credits.balance.trim()) creditLabels.push(`额外额度余额：${credits.balance}`);
    else if (credits?.hasCredits === false) creditLabels.push('无额外额度');
    if (succeeded && account.spendControlReached === true) creditLabels.push('已达到消费限额');
    text(`${prefix}-credits`, creditLabels.join(' · '));
    elements[`${prefix}-credits`].hidden = !creditLabels.length;
    const error = succeeded ? '' : typeof account?.error === 'string' && account.error ? account.error : '官方额度暂时无法读取，请稍后重试。';
    text(`${prefix}-error`, error);
    elements[`${prefix}-error`].hidden = !error;
    text(`${prefix}-updated`, account?.fetchedAt ? `${succeeded ? '更新时间' : '查询时间'}：${quotaTime(account.fetchedAt, timeZone)}` : '尚无成功查询时间');
    pill(`${prefix}-state`, succeeded ? '已更新' : '查询失败', succeeded ? 'success' : 'error');
  }
}

async function refreshAccountQuotas() {
  if (accountQuotasRequest) return accountQuotasRequest;
  elements['quota-refresh-button'].disabled = true;
  text('quota-refresh-button', '查询中…');
  for (const accountId of ['a', 'b']) pill(`quota-${accountId}-state`, '查询中', 'pending');
  accountQuotasRequest = (async () => {
    try {
      renderAccountQuotas(await request('/api/account-quotas', { signal: AbortSignal.timeout(30_000) }));
    } catch (error) {
      const message = error.name === 'TimeoutError' ? '官方额度查询超时，请稍后重试。' : error.message || '官方额度暂时无法读取，请稍后重试。';
      renderAccountQuotas({ accounts: { A: { status: 'error', error: message }, B: { status: 'error', error: message } } });
    } finally {
      accountQuotasRequest = null;
      elements['quota-refresh-button'].disabled = false;
      text('quota-refresh-button', '刷新额度');
    }
  })();
  return accountQuotasRequest;
}

function renderWith(data) {
  const gateway = data.gateway || {};
  const provider = data.provider || {};
  text('with-title', data.model?.name || 'With · Opus 5.5');
  text('with-vm-address', data.vm?.address || '未配置');
  text('with-vm-state', data.vm?.configured ? '已配置' : '待配置');
  text('with-gateway-url', gateway.baseUrl || '未配置');
  text('with-authentication', provider.authenticated === true ? '已登录' : provider.authenticated === false ? '待登录' : '未返回');
  for (const metric of ['requests', 'completed', 'failed', 'active']) {
    text(`with-${metric}`, tokenCount(gateway[metric]));
  }
  if (!data.configured) pill('with-state', '待配置');
  else if (!data.running) pill('with-state', '未运行', 'pending');
  else if (provider.authenticated === true) pill('with-state', '已接入', 'success');
  else pill('with-state', provider.authenticated === false ? '待登录' : '登录状态未知', 'pending');
  const errors = [provider.error, gateway.lastError].map((error) => typeof error === 'string' ? error : error?.message).filter(Boolean);
  text('with-error', [...new Set(errors)].join(' · '));
  elements['with-error'].hidden = !errors.length;
  if (errors.length) pill('with-state', '需检查', 'error');
}

async function refreshWith() {
  if (withRequest) return withRequest;
  withRequest = (async () => {
    try {
      renderWith(await request('/api/with'));
    } catch (error) {
      pill('with-state', '读取失败', 'error');
      elements['with-error'].hidden = false;
      text('with-error', `With 状态暂时无法读取：${error.message || '请稍后重试。'}`);
    } finally {
      withRequest = null;
    }
  })();
  return withRequest;
}

function sourceMetadata(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('zh-CN');
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  return '未返回';
}

function renderCodeBuddy(data) {
  const gateway = data.gateway || {};
  const provider = data.provider || {};
  const login = data.login || {};
  const billing = provider.billing || {};
  const catalog = provider.catalog || {};
  const nativeCatalog = catalog.source === 'native-cache';
  const liveCatalog = catalog.source === 'remote' && catalog.liveVerified === true;
  const pending = login.state === 'pending' || busyAction === 'codebuddy-login';
  const authenticated = provider.authenticated === true;
  const idle = managementConnected && !busyAction;
  const url = safeCodeBuddyAuthorizationUrl(login.url);
  text('codebuddy-title', data.model?.name || 'CodeBuddy · Opus 5.5');
  text('codebuddy-username', provider.username || (authenticated ? '已登录（未返回账号名）' : '待登录'));
  text('codebuddy-authentication', authenticated ? '已登录' : provider.authenticated === false ? '待登录' : '未返回');
  text('codebuddy-model-available', !authenticated ? '登录后确认' : provider.modelAvailable === true
    ? nativeCatalog ? '本机目录已确认' : liveCatalog ? '实时目录已确认' : '目录已确认' : '当前不可用');
  text('codebuddy-catalog-source', nativeCatalog ? '本机 CodeBuddy 目录缓存' : catalog.source === 'remote' ? '远程模型目录' : '未返回');
  text('codebuddy-catalog-saved-at', typeof catalog.savedAt === 'number' ? tokenTime(catalog.savedAt) : '未返回');
  text('codebuddy-catalog-note', nativeCatalog
    ? '展示本机目录原始保存时间。实际可用性与计费待本人实测。'
    : liveCatalog ? '已读取实时模型目录。真实聊天和工具回合仍由本人验收。' : '目录来源尚待确认。实际可用性与计费待本人实测。');
  text('codebuddy-gateway-url', gateway.baseUrl || '未配置');
  text('codebuddy-codex-url', gateway.codexBaseUrl || '尚未启用');
  text('codebuddy-transport', provider.transport || '未返回');
  const multiplier = billing.employeeTokenMultiplier;
  text('codebuddy-billing-multiplier', billing.verified === true && typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 0
    ? `${multiplier.toLocaleString('zh-CN')} ×` : '待服务端确认');
  text('codebuddy-source-credits', sourceMetadata(billing.sourceCredits));
  text('codebuddy-source-promotion', sourceMetadata(billing.sourcePromotion));
  for (const metric of ['requests', 'completed', 'failed', 'active']) text(`codebuddy-${metric}`, tokenCount(gateway[metric]));
  elements['codebuddy-login-button'].disabled = !idle || !data.configured || authenticated || pending;
  elements['codebuddy-logout-button'].disabled = !idle || !data.configured;
  text('codebuddy-login-button', authenticated ? 'CodeBuddy 已登录' : pending ? '等待官方授权…' : '官方网页登录');
  text('codebuddy-logout-button', busyAction === 'codebuddy-logout' ? '正在退出…' : '退出本网关会话');
  elements['codebuddy-authorization-link'].hidden = !pending || !url;
  if (pending && url) elements['codebuddy-authorization-link'].href = url;
  else elements['codebuddy-authorization-link'].removeAttribute('href');
  const expiry = login.expiresAt ? ` 有效期至 ${tokenTime(login.expiresAt)}。` : '';
  text('codebuddy-login-state', !data.configured ? 'CodeBuddy 接入服务尚未配置。'
    : pending ? `请在官方页面完成登录与协议确认，此处会自动更新。${expiry}`
      : authenticated ? '本网关已获得独立 CodeBuddy 会话。'
        : login.state === 'complete' ? '官方授权已完成，等待账号状态更新。'
          : login.state === 'error' ? (login.error || '登录未完成，请重新登录。') : '通过官方页面登录，授权仅用于本网关会话。');
  if (!data.configured) pill('codebuddy-state', '待配置');
  else if (!data.running) pill('codebuddy-state', '未运行', 'pending');
  else if (pending) pill('codebuddy-state', '等待授权', 'pending');
  else if (authenticated && provider.ready === true && provider.modelAvailable === true) {
    pill('codebuddy-state', liveCatalog ? '目录已确认' : '待本人实测', liveCatalog ? 'success' : 'pending');
  }
  else if (authenticated) pill('codebuddy-state', '待模型就绪', 'pending');
  else pill('codebuddy-state', '待登录', 'pending');
  const errors = [provider.error, gateway.lastError, login.error].map((error) => typeof error === 'string' ? error : error?.message)
    .filter(error => error && !(!authenticated && error === 'CodeBuddy 员工账号尚未登录。'));
  text('codebuddy-error', [...new Set(errors)].join(' · '));
  elements['codebuddy-error'].hidden = !errors.length;
  if (errors.length) pill('codebuddy-state', '需检查', 'error');
}

async function refreshCodeBuddy() {
  if (codeBuddyRequest) return codeBuddyRequest;
  codeBuddyRequest = (async () => {
    try {
      codeBuddyStatus = await request('/api/codebuddy');
      renderCodeBuddy(codeBuddyStatus);
    } catch (error) {
      codeBuddyStatus = null;
      pill('codebuddy-state', '读取失败', 'error');
      elements['codebuddy-login-button'].disabled = true;
      elements['codebuddy-logout-button'].disabled = true;
      elements['codebuddy-error'].hidden = false;
      text('codebuddy-error', `CodeBuddy 状态暂时无法读取：${error.message || '请稍后重试。'}`);
    } finally {
      codeBuddyRequest = null;
    }
  })();
  return codeBuddyRequest;
}

function renderTokenUsage(data) {
  const totals = data.totals || {};
  for (const [id, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['all', 'totalTokens'], ['cached', 'cachedInputTokens'], ['reasoning', 'reasoningTokens']]) {
    text(`token-total-${id}`, tokenCount(totals[field]));
  }
  for (const accountId of ['A', 'B', 'With', 'CodeBuddy', 'Claude']) {
    const account = data.accounts?.[accountId] || {};
    for (const [id, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cached', 'cachedInputTokens'], ['reasoning', 'reasoningTokens']]) {
      text(`token-${accountId.toLowerCase()}-${id}`, tokenCount(account[field]));
    }
  }
  elements['token-claude-row'].hidden = !(data.accounts?.Claude?.requests > 0);
  text('token-started-at', data.startedAt ? `${tokenTime(data.startedAt, data.timeZone)} 起 · ${data.timeZone || '服务端时区'}` : '等待服务端记录时间');
  text('token-coverage', `已返回用量 ${tokenCount(totals.withUsage)} / ${tokenCount(totals.requests)} 次 · 未返回 ${tokenCount(totals.missingUsage)} 次`);

  const recent = Array.isArray(data.recent) ? [...data.recent].sort((a, b) => (
    (new Date(b?.time).getTime() || 0) - (new Date(a?.time).getTime() || 0)
  )).slice(0, 10) : [];
  const rows = recent.map((entry) => {
    const row = document.createElement('tr');
    const usage = entry.usage === undefined ? entry : entry.usage;
    const labels = { completed: '完成', succeeded: '完成', success: '完成', failed: '失败', cancelled: '已取消', incomplete: '未完成', running: '进行中' };
    const values = [tokenTime(entry.time, data.timeZone), entry.account || '未返回', entry.model || '未返回', tokenCount(usage?.inputTokens), tokenCount(usage?.outputTokens), labels[entry.status] || entry.status || '未返回'];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      if (index === 2) cell.className = 'token-model';
      row.append(cell);
    }
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-table';
    cell.textContent = '还没有请求记录';
    row.append(cell);
    rows.push(row);
  }
  elements['token-recent-body'].replaceChildren(...rows);
  const error = typeof data.error === 'string' ? data.error : data.error?.message;
  elements['token-error'].hidden = !error;
  text('token-error', error || '');
  pill('token-state', error ? '统计需检查' : '自动更新', error ? 'error' : 'success');
}

async function refreshTokenUsage() {
  if (tokenUsageRequest) return tokenUsageRequest;
  tokenUsageRequest = (async () => {
    try {
      renderTokenUsage(await request('/api/token-usage'));
    } catch (error) {
      pill('token-state', '更新失败', 'error');
      elements['token-error'].hidden = false;
      text('token-error', `用量暂时无法读取：${error.message || '请稍后重试。'}`);
    } finally {
      tokenUsageRequest = null;
    }
  })();
  return tokenUsageRequest;
}

async function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsRequest = (async () => {
    try {
      const data = await request('/api/models');
      const previous = elements['model-select'].value;
      elements['model-select'].replaceChildren(new Option('使用默认 B 模型', ''));
      for (const model of data.models || []) {
        if (model && typeof model.id === 'string') {
          elements['model-select'].add(new Option(model.name || model.id, model.id));
        }
      }
      if ([...elements['model-select'].options].some((option) => option.value === previous)) elements['model-select'].value = previous;
      modelsLoaded = true;
    } catch { /* Verification can still use the backend's default model. */ }
    finally { modelsRequest = null; }
  })();
  return modelsRequest;
}

async function action(name, operation) {
  if (busyAction) return;
  busyAction = name;
  render();
  try {
    await operation();
  } catch (error) {
    notify(error.message || '操作未完成，请重试。', true);
  } finally {
    busyAction = null;
    render();
    await refreshStatus().catch(() => {});
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Allow copying on local HTTP pages. */ }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  textarea.setAttribute('aria-hidden', 'true');
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请在本机地址打开管理台后重试。');
  } finally { textarea.remove(); }
}

elements['login-button'].addEventListener('click', () => {
  if (busyAction) return;
  const authorizationTab = window.open('about:blank', '_blank');
  if (authorizationTab) authorizationTab.opener = null;
  void action('login', async () => {
    try {
      const data = await post('/api/login');
      const url = safeAuthorizationUrl(data.url);
      if (!url) throw new Error('服务未返回有效的官方授权链接。');
      if (authorizationTab) authorizationTab.location.replace(url);
      else notify('授权页面未自动打开，请点击“打开授权页面”继续登录。');
    } catch (error) {
      if (authorizationTab) authorizationTab.close();
      throw error;
    }
  });
});

elements['device-login-button'].addEventListener('click', () => {
  void action('device-login', async () => {
    const data = await post('/api/login', { deviceCode: true });
    const url = safeAuthorizationUrl(data.url);
    if (!url || typeof data.userCode !== 'string' || !data.userCode) throw new Error('服务未返回有效的官方设备授权链接与代码。');
    status.backend.login = { state: 'pending', method: 'deviceCode', url, userCode: data.userCode };
    render();
  });
});

elements['codebuddy-login-button'].addEventListener('click', () => {
  if (busyAction) return;
  const authorizationTab = window.open('about:blank', '_blank');
  if (authorizationTab) authorizationTab.opener = null;
  void action('codebuddy-login', async () => {
    try {
      const data = await post('/api/codebuddy/login');
      const url = safeCodeBuddyAuthorizationUrl(data.url);
      if (!url) throw new Error('服务未返回有效的 CodeBuddy 官方授权链接。');
      codeBuddyStatus = { ...codeBuddyStatus, login: { state: 'pending', url, expiresAt: data.expiresAt } };
      if (authorizationTab) authorizationTab.location.replace(url);
      else notify('请点击“打开官方授权页面”，由本人完成登录与协议确认。');
    } catch (error) {
      if (authorizationTab) authorizationTab.close();
      throw error;
    }
  });
});

elements['codebuddy-logout-button'].addEventListener('click', () => {
  void action('codebuddy-logout', async () => {
    await post('/api/codebuddy/logout');
    await refreshCodeBuddy();
    notify('本网关的 CodeBuddy 会话已退出。');
  });
});

elements['logout-button'].addEventListener('click', () => {
  void action('logout', async () => {
    await post('/api/logout');
    modelsLoaded = false;
    elements['model-select'].replaceChildren(new Option('使用默认 B 模型', ''));
    notify('账号 B 已退出。');
  });
});

elements['bind-button'].addEventListener('click', () => {
  void action('bind', async () => {
    await post('/api/bind');
    notify('已确认账号 B。现在可以验证一次真实推理。');
  });
});

elements['verify-button'].addEventListener('click', () => {
  void action('verify', async () => {
    const model = elements['model-select'].value;
    await post('/api/verify', model ? { model } : {});
  });
});

elements['install-button'].addEventListener('click', () => {
  void action('install', async () => {
    await post('/api/integration/install');
    notify('已添加两个 B 模型并启用账号分流。保存当前工作，重启 Codex 后可在模型选择器中切换。');
  });
});

elements['restore-button'].addEventListener('click', () => {
  void action('restore', async () => {
    await post('/api/integration/restore');
    notify('已恢复接入前的 Codex 配置。重启 Codex 后生效。');
  });
});

elements['copy-button'].addEventListener('click', () => {
  void action('copy', async () => {
    const data = await request('/api/integration');
    if (typeof data.toml !== 'string' || !data.toml) throw new Error('服务未返回接入配置。');
    await copyText(data.toml);
    notify('接入配置已复制，包含网关地址、模型配置与网关密钥。');
  });
});

elements['quota-refresh-button'].addEventListener('click', () => { void refreshAccountQuotas(); });

elements['cursor-login-button'].addEventListener('click', () => {
  if (busyAction || restartInProgress) return;
  const authorizationTab = window.open('about:blank', '_blank');
  if (authorizationTab) authorizationTab.opener = null;
  void action('cursor-login', async () => {
    try {
      const data = await post('/api/cursor/login');
      const url = safeCursorAuthorizationUrl(data.url);
      if (!url) throw new Error('服务未返回已确认的 Cursor 官方授权链接。');
      cursorStatus = { ...cursorStatus, login: { state: 'pending', url, expiresAt: data.expiresAt } };
      renderCursor(cursorStatus);
      if (authorizationTab) authorizationTab.location.replace(url);
      else notify('请点击“打开官方授权页面”，由本人完成 Cursor 授权。');
    } catch (error) { if (authorizationTab) authorizationTab.close(); throw error; }
  });
});
elements['cursor-logout-button'].addEventListener('click', () => {
  void action('cursor-logout', async () => {
    await post('/api/cursor/logout'); await refreshCursor();
    notify('本网关的 Cursor 会话已退出。');
  });
});

elements['service-restart-button'].addEventListener('click', () => { void restartService(false); });
elements['service-confirm-button'].addEventListener('click', () => { void restartService(restartActiveRequests > 0); });
elements['service-cancel-button'].addEventListener('click', () => {
  if (busyAction || restartInProgress) return;
  restartConfirmation = false;
  text('service-message', '已取消重启。'); renderServiceControl();
});
elements['model-settings-save-button'].addEventListener('click', () => {
  void action('model-settings-save', async () => {
    if (!modelSettings || !modelSettingsDirty()) return;
    const disabledModels = modelSettings.models.filter(model => !modelDraft.get(model.id)).map(model => model.id);
    try { await post('/api/model-settings', { revision: modelSettings.revision, disabledModels }); }
    catch (error) {
      if (error.status !== 409) throw error;
      if (modelSettingsRequest) await modelSettingsRequest;
      await refreshModelSettings({ replaceDraft: true });
      text('model-settings-message', modelSettingsError || modelSettingsUnavailable
        ? '版本冲突，模型选择尚未保存。请刷新列表后重试。'
        : '模型列表已由其他页面更新，已重新加载。请重新勾选后保存。');
      return;
    }
    if (modelSettingsRequest) await modelSettingsRequest;
    await refreshModelSettings({ replaceDraft: true });
    text('model-settings-message', '已保存。请在 Codex 中刷新模型目录，或重开 Codex。');
  });
});
elements['model-settings-reset-button'].addEventListener('click', () => {
  if (busyAction || !modelSettings) return;
  modelDraft = new Map(modelSettings.models.map(model => [model.id, model.enabled]));
  renderModelSettingsList(); text('model-settings-message', '已恢复为最近保存的选择。');
});
elements['model-settings-refresh-button'].addEventListener('click', () => {
  if (busyAction || restartInProgress) return;
  void refreshModelSettings();
});

void refreshAccountQuotas();
void refreshStatus().catch(() => {});
setInterval(() => { void refreshStatus().catch(() => {}); }, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshStatus().catch(() => {});
});
