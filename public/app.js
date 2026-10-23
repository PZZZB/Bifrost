'use strict';

const byId = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'connection-dot', 'connection-label', 'version', 'notice', 'setup-state',
  'tab-console', 'tab-accounts', 'tab-clients', 'panel-console', 'panel-accounts', 'panel-clients',
  'client-admin-refresh', 'client-admin-error', 'client-admin-message', 'client-admin-state',
  'client-api-base', 'client-portal-link', 'client-access-note', 'client-users-count', 'client-user-list',
  'client-user-create-form', 'client-create-username', 'client-create-password', 'client-user-create',
  'client-detail-title', 'client-user-state', 'client-user-empty', 'client-user-detail', 'client-user-meta', 'client-user-toggle',
  'client-user-limit-form', 'client-user-key-limit', 'client-user-limit-save',
  'client-model-form', 'client-model-list', 'client-model-save', 'client-model-message',
  'client-key-list', 'client-key-create-form', 'client-key-name', 'client-key-days', 'client-key-create',
  'client-registration-form', 'client-registration-mode', 'client-registration-days', 'client-registration-save',
  'client-invitation-list', 'client-invitation-create-form', 'client-invitation-days', 'client-invitation-uses', 'client-invitation-models', 'client-invitation-create',
  'client-secret-panel', 'client-secret-title', 'client-secret-note', 'client-secret-label', 'client-secret-value', 'client-secret-copy', 'client-secret-close',
  ...['a', 'b', 'codebuddy', 'cursor'].flatMap(account =>
    ['state', 'identity', 'plan', 'method', 'catalog', 'enabled'].map(field => `account-${account}-${field}`)),
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
  'codebuddy-authentication', 'codebuddy-model-available', 'codebuddy-enabled-models', 'codebuddy-gateway-url', 'codebuddy-codex-url',
  'codebuddy-transport', 'codebuddy-billing-multiplier', 'codebuddy-source-credits',
  'codebuddy-catalog-source', 'codebuddy-catalog-saved-at', 'codebuddy-catalog-note',
  'codebuddy-source-promotion', 'codebuddy-requests', 'codebuddy-completed',
  'codebuddy-failed', 'codebuddy-active', 'codebuddy-error',
  'token-codebuddy-input', 'token-codebuddy-output', 'token-codebuddy-cached', 'token-codebuddy-reasoning',
  'token-claude-row', 'token-claude-input', 'token-claude-output', 'token-claude-cached', 'token-claude-reasoning',
  'quota-refresh-button', ...['a', 'b', 'codebuddy', 'cursor'].flatMap(account =>
    ['plan', 'state', 'identity', 'source', 'windows', 'credits', 'error', 'updated', 'notice', 'usage-link'].map(field => `quota-${account}-${field}`)),
  'service-state', 'service-ready', 'service-independent', 'service-active', 'service-restart-button',
  'service-message', 'service-error', 'service-confirmation', 'service-confirmation-message', 'service-confirm-button', 'service-cancel-button',
  'service-running-version', 'service-installed-version', 'service-started-at', 'service-update-state',
  'service-idle-restart-button', 'service-idle-cancel-button', 'service-queue-message',
  'diagnostics-state', 'diagnostics-recent-body', 'diagnostics-error', 'diagnostics-detail',
  'diagnostics-detail-title', 'diagnostics-export-link', 'diagnostics-fields', 'diagnostics-detail-note',
  'model-settings-state', 'model-settings-list', 'model-settings-save-button', 'model-settings-reset-button', 'model-settings-refresh-button',
  'model-settings-message', 'model-settings-error', 'model-settings-search', 'model-settings-summary', 'model-settings-discovery',
  'cursor-state', 'cursor-login-button', 'cursor-logout-button', 'cursor-authorization-link', 'cursor-login-state',
  'cursor-account', 'cursor-plan', 'cursor-prompt-mode', 'cursor-prompt-priority', 'cursor-prompt-note', 'cursor-catalog-models', 'cursor-enabled-models',
  'cursor-requests', 'cursor-completed', 'cursor-failed', 'cursor-active', 'cursor-error'
].map((id) => [id, byId(id)]));

let status = null;
let statusRequest = null;
let statusRequestEpoch = -1;
let busyAction = null;
let modelsLoaded = false;
let modelsRequest = null;
let noticeTimer = null;
let tokenUsageRequest = null;
let withRequest = null;
let codeBuddyRequest = null;
let codeBuddyRequestEpoch = -1;
let codeBuddyStatus = null;
let managementConnected = false;
let accountQuotasRequest = null;
let accountQuotaStatus = null;
let managementStatusError = false;
let codeBuddyReadError = '';
let cursorReadError = '';
let serviceStatus = null;
let serviceRequest = null;
let serviceUnavailable = false;
let serviceError = '';
let restartInProgress = false;
let restartConfirmation = false;
let restartActiveRequests = 0;
let queuedRestartToken = null;
let diagnosticsRequest = null;
let diagnosticsData = null;
let diagnosticDetailGeneration = 0;
let modelSettings = null;
let modelCatalogModels = null;
let modelSettingsRequest = null;
let modelSettingsGeneration = 0;
let modelSettingsUnavailable = false;
let modelSettingsError = '';
let modelDraft = new Map();
let modelGroupActions = [];
let modelSettingsLoaded = false;
let cursorStatus = null;
let cursorRequest = null;
let cursorRequestEpoch = -1;
const accountStateEpoch = { b: 0, codebuddy: 0, cursor: 0 };
const accountMetadataNeedsRefresh = new Set();
let clientAdminData = null;
let clientAdminRequest = null;
let clientAdminLoaded = false;
let clientAdminError = '';
let clientAdminUnavailable = true;
let clientSelectedId = '';
let clientModelDraft = new Set();
let clientInviteDraft = new Set();
let clientSecret = '';
let clientDefaultDays = 30;

function text(id, value) {
  elements[id].textContent = value == null ? '' : String(value);
}

function pill(id, label, kind = '') {
  text(id, label);
  elements[id].className = `pill${kind ? ` ${kind}` : ''}`;
}

function selectManagementTab(name, { focus = false, updateLocation = true } = {}) {
  const selected = ['accounts', 'clients'].includes(name) ? name : 'console';
  for (const tab of ['console', 'accounts', 'clients']) {
    const active = selected === tab;
    elements[`tab-${tab}`].setAttribute('aria-selected', String(active));
    elements[`tab-${tab}`].tabIndex = active ? 0 : -1;
    elements[`panel-${tab}`].hidden = !active;
  }
  if (focus) elements[`tab-${selected}`].focus();
  if (updateLocation && window.history?.replaceState) window.history.replaceState(null, '', `#${selected}`);
  if (selected === 'clients' && !clientAdminLoaded && managementConnected) void refreshClientAdmin();
}

function clientAccount() {
  return clientAdminData?.accounts?.find(account => account.id === clientSelectedId) ?? null;
}

function clientAdminReady() {
  return managementConnected && !busyAction && !restartInProgress && !clientAdminRequest && !clientAdminUnavailable && clientAdminData !== null;
}

function clientModelSelectionDirty() {
  const saved = new Set(clientAccount()?.allowedModels ?? []);
  return saved.size !== clientModelDraft.size || [...saved].some(id => !clientModelDraft.has(id));
}

function renderClientAdminControls() {
  const ready = clientAdminReady();
  const selected = Boolean(clientAccount());
  elements['client-secret-close'].disabled = false;
  elements['client-secret-copy'].disabled = !clientSecret;
  elements['client-admin-refresh'].disabled = !managementConnected || Boolean(busyAction) || restartInProgress || Boolean(clientAdminRequest);
  for (const id of ['client-user-create', 'client-registration-save', 'client-invitation-create']) elements[id].disabled = !ready;
  for (const id of ['client-user-toggle', 'client-user-limit-save', 'client-key-create']) elements[id].disabled = !ready || !selected;
  elements['client-model-save'].disabled = !ready || !selected || !clientModelSelectionDirty();
  for (const button of document.querySelectorAll('[data-client-write]')) button.disabled = !ready;
  text('client-admin-error', clientAdminError);
  elements['client-admin-error'].hidden = !clientAdminError;
}

function clientLocalDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
}

function clientTime(value) {
  return value ? tokenTime(value, 'America/Los_Angeles') : '未设置';
}

function clientInteger(id, label, maximum = 3650) {
  const value = elements[id].value.trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${label}需为 1–${maximum} 的整数。`);
  return number;
}

function clientAccountPath(id = clientSelectedId) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('用户标识无效，请刷新用户列表。');
  return `/api/client-admin/accounts/${encodeURIComponent(id)}`;
}

function clientKeyPath(id, accountId = clientSelectedId) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Key 标识无效，请刷新用户列表。');
  return `${clientAccountPath(accountId)}/keys/${encodeURIComponent(id)}`;
}

function clientInvitationPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('邀请码标识无效，请刷新用户列表。');
  return `/api/client-admin/invites/${encodeURIComponent(id)}`;
}

function clearClientSecret() {
  clientSecret = '';
  elements['client-secret-value'].value = '';
  elements['client-secret-panel'].hidden = true;
}

function showClientSecret(value, invitation = false) {
  clearClientSecret();
  if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('服务未返回完整凭证。请检查列表；已生成的凭证无法再次读取。');
  clientSecret = value;
  elements['client-secret-value'].value = value;
  text('client-secret-title', invitation ? '新邀请码' : '新 API Key');
  text('client-secret-label', invitation ? '邀请码' : 'API Key');
  text('client-secret-note', invitation ? '完整邀请码只展示这一次。请立即复制；刷新后无法重新读取。' : '完整 Key 只展示这一次。请立即复制；刷新后只能看到前缀。');
  elements['client-secret-panel'].hidden = false;
}

function clientModelOptions(containerId, selected, onChange) {
  const models = Array.isArray(clientAdminData?.models) ? [...clientAdminData.models] : [];
  const known = new Set(models.map(model => model.id));
  for (const id of selected) if (!known.has(id)) models.push({ id, name: id, available: false, missing: true });
  const options = models.filter(model => typeof model?.id === 'string' && model.id).map(model => {
    const label = document.createElement('label'); label.className = 'model-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = model.id; input.checked = selected.has(model.id);
    input.disabled = model.available === false && !input.checked;
    input.addEventListener('change', () => {
      if (input.checked) selected.add(model.id); else selected.delete(model.id);
      onChange?.();
    });
    const content = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = model.name || model.id;
    const detail = document.createElement('small'); detail.textContent = `${model.channel || '模型'} · ${model.id}${model.missing ? ' · 当前目录未返回' : model.available === false ? ' · 当前不可用' : model.enabled === false ? ' · 全局未开放' : ''}`;
    content.append(title, detail); label.append(input, content); return label;
  });
  if (!options.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = '模型目录尚未返回；可先创建用户，刷新目录后再授权。'; options.push(empty); }
  elements[containerId].replaceChildren(...options);
}

function clientWriteButton(label, operation, { danger = false } = {}) {
  const button = document.createElement('button'); button.type = 'button'; button.className = `button ${danger ? 'danger' : 'secondary'} small`;
  button.textContent = label; button.setAttribute('data-client-write', '');
  button.addEventListener('click', () => { void runClientAdminAction(operation); }); return button;
}

function clientRevocationControls(container, label, operation) {
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'button quiet small'; trigger.textContent = '撤销'; trigger.setAttribute('data-client-write', '');
  const confirmation = document.createElement('div'); confirmation.className = 'client-item-confirm'; confirmation.hidden = true;
  const warning = document.createElement('p'); warning.textContent = `${label}撤销后无法恢复。确认撤销？`;
  const buttons = document.createElement('div'); buttons.className = 'button-row';
  const confirm = clientWriteButton('确认撤销', operation, { danger: true });
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button quiet small'; cancel.textContent = '取消';
  cancel.addEventListener('click', () => { confirmation.hidden = true; trigger.hidden = false; });
  trigger.addEventListener('click', () => { confirmation.hidden = false; trigger.hidden = true; });
  buttons.append(confirm, cancel); confirmation.append(warning, buttons); container.append(trigger, confirmation);
}

function renderClientKeys(account) {
  const keys = Array.isArray(account.keys) ? account.keys : [];
  const nodes = keys.map(key => {
    const card = document.createElement('section'); card.className = 'client-access-item';
    const heading = document.createElement('div'); heading.className = 'client-access-item-heading';
    const title = document.createElement('div'); const name = document.createElement('strong'); name.textContent = key.name || '未命名 Key';
    const prefix = document.createElement('code'); prefix.textContent = typeof key.lastFour === 'string' ? `••••${key.lastFour}` : '尾号未返回'; title.append(name, prefix);
    const state = document.createElement('span');
    const revoked = Boolean(key.revokedAt) || key.status === 'revoked';
    const labels = { active: '有效', expired: '已过期', disabled: '已停用', revoked: '已撤销', account_disabled: '用户已停用', account_expired: '账号到期上限已过' };
    state.className = `pill ${key.status === 'active' && account.enabled !== false ? 'success' : 'pending'}`;
    state.textContent = revoked ? '已撤销' : account.enabled === false ? '用户已停用' : labels[key.status] || (key.enabled === false ? '已停用' : '状态未返回');
    heading.append(title, state); card.append(heading);
    const expiry = document.createElement('p'); expiry.textContent = `Key 到期：${clientTime(key.expiresAt)} · 实际到期：${clientTime(key.effectiveExpiresAt ?? key.expiresAt)}`; card.append(expiry);
    if (!revoked) {
      const actions = document.createElement('div'); actions.className = 'client-item-actions';
      actions.append(clientWriteButton(key.enabled === false ? '启用' : '停用', async () => {
        await post(clientKeyPath(key.id, account.id), { enabled: key.enabled === false });
      }));
      const renewal = document.createElement('label'); renewal.className = 'client-field'; renewal.textContent = '增加天数';
      const days = document.createElement('input'); days.type = 'number'; days.min = '1'; days.max = '3650'; days.value = '30'; renewal.append(days);
      actions.append(renewal, clientWriteButton('续期', async () => {
        const number = Number(days.value);
        if (!/^\d+$/.test(days.value) || !Number.isSafeInteger(number) || number < 1 || number > 3650) throw new Error('续期天数需为 1–3650 的整数。');
        const currentExpiry = new Date(key.expiresAt).getTime();
        const expiresAt = new Date(Math.max(Date.now(), Number.isFinite(currentExpiry) ? currentExpiry : 0) + number * 86400000).toISOString();
        await post(clientKeyPath(key.id, account.id), { expiresAt });
      }));
      clientRevocationControls(actions, '此 Key ', async () => { await post(`${clientKeyPath(key.id, account.id)}/revoke`); clearClientSecret(); });
      card.append(actions);
    }
    return card;
  });
  if (!nodes.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = '此用户还没有 API Key。'; nodes.push(empty); }
  elements['client-key-list'].replaceChildren(...nodes);
}

function selectClientAccount(id, { preserveDraft = false } = {}) {
  clientSelectedId = id;
  const account = clientAccount();
  if (!preserveDraft) clientModelDraft = new Set(account?.allowedModels ?? []);
  elements['client-user-empty'].hidden = Boolean(account);
  elements['client-user-detail'].hidden = !account;
  text('client-detail-title', account?.username || '选择一个用户');
  pill('client-user-state', account ? account.enabled === false ? '已停用' : '已启用' : '—', account?.enabled ? 'success' : 'pending');
  text('client-model-message', '');
  if (account) {
    const fields = [['用户名', account.username], ['创建时间', clientTime(account.createdAt)], ['Key 到期上限', account.keyExpiresAtLimit ? clientTime(account.keyExpiresAtLimit) : '无账号上限']];
    elements['client-user-meta'].replaceChildren(...fields.map(([name, value]) => {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; row.append(dt, dd); return row;
    }));
    text('client-user-toggle', account.enabled === false ? '启用用户' : '停用用户');
    elements['client-user-key-limit'].value = clientLocalDate(account.keyExpiresAtLimit);
    clientModelOptions('client-model-list', clientModelDraft, renderClientAdminControls);
    renderClientKeys(account);
  }
  for (const button of elements['client-user-list'].querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.getAttribute('data-client-id') === id));
  renderClientAdminControls();
}

function renderClientInvitations() {
  const invites = Array.isArray(clientAdminData?.invites) ? clientAdminData.invites : [];
  const nodes = invites.map(invite => {
    const card = document.createElement('section'); card.className = 'client-access-item';
    const heading = document.createElement('div'); heading.className = 'client-access-item-heading';
    const name = document.createElement('strong'); name.textContent = typeof invite.lastFour === 'string' ? `邀请码 ••••${invite.lastFour}` : `邀请码 ${invite.id}`;
    const status = document.createElement('span'); status.className = 'pill pending';
    const labels = { active: '有效', used: '已用完', exhausted: '已用完', expired: '已过期', revoked: '已撤销' };
    status.textContent = invite.revokedAt ? '已撤销' : labels[invite.status] || '状态未返回'; heading.append(name, status);
    const description = document.createElement('p'); description.textContent = `到期：${clientTime(invite.expiresAt)} · 已使用 ${Number.isSafeInteger(invite.uses) ? invite.uses : 0} / ${Number.isSafeInteger(invite.maxUses) ? invite.maxUses : '未返回'} · 模型 ${Array.isArray(invite.allowedModels) ? invite.allowedModels.length : 0} 项`;
    card.append(heading, description);
    if (!invite.revokedAt && invite.status !== 'revoked') {
      const actions = document.createElement('div'); actions.className = 'client-item-actions';
      clientRevocationControls(actions, '此邀请码', async () => { await post(`${clientInvitationPath(invite.id)}/revoke`); clearClientSecret(); }); card.append(actions);
    }
    return card;
  });
  if (!nodes.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = '尚未创建邀请码。'; nodes.push(empty); }
  elements['client-invitation-list'].replaceChildren(...nodes);
}

function renderClientAdmin({ replaceDraft = false } = {}) {
  const data = clientAdminData;
  if (!data) { renderClientAdminControls(); return; }
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  text('client-api-base', data.endpoint?.baseUrl || '入口尚未配置');
  const portal = typeof data.endpoint?.portalUrl === 'string' ? data.endpoint.portalUrl : '/register';
  try {
    const url = new URL(portal, window.location);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid portal URL');
    elements['client-portal-link'].href = url.href; elements['client-portal-link'].hidden = false;
  } catch { elements['client-portal-link'].removeAttribute('href'); elements['client-portal-link'].hidden = true; }
  pill('client-admin-state', data.server?.ready ? '接入已就绪' : data.server?.enabled ? '入口尚未就绪' : '入口待启用', data.server?.ready ? 'success' : 'pending');
  text('client-access-note', data.server?.message || '客户端配置基础地址、独立 API Key 和获准模型。Key 的到期与撤销不删除用户账号。');
  text('client-users-count', `${accounts.length} 位用户`);
  const users = accounts.map(account => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'client-user-option'; button.setAttribute('data-client-id', account.id);
    const identity = document.createElement('span'), title = document.createElement('strong'), detail = document.createElement('small');
    title.textContent = account.username; detail.textContent = `${account.allowedModels?.length ?? 0} 个模型 · ${account.keys?.length ?? 0} 个 Key`;
    identity.append(title, detail); const state = document.createElement('span'); state.className = `pill ${account.enabled ? 'success' : 'pending'}`; state.textContent = account.enabled ? '已启用' : '已停用';
    button.append(identity, state); button.addEventListener('click', () => { if (!busyAction) selectClientAccount(account.id); }); return button;
  });
  if (!users.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = '尚无接入用户。可在此创建，或通过用户页面注册。'; users.push(empty); }
  elements['client-user-list'].replaceChildren(...users);
  const selectedStillPresent = accounts.some(account => account.id === clientSelectedId);
  selectClientAccount(selectedStillPresent ? clientSelectedId : accounts[0]?.id || '', { preserveDraft: selectedStillPresent && !replaceDraft });
  elements['client-registration-mode'].value = ['open', 'invite', 'closed'].includes(data.registration?.mode) ? data.registration.mode : 'closed';
  const defaultDays = Number.isSafeInteger(data.registration?.defaultKeyDays) ? data.registration.defaultKeyDays : 30;
  elements['client-registration-days'].value = String(defaultDays);
  if (!elements['client-key-days'].value || elements['client-key-days'].value === String(clientDefaultDays)) elements['client-key-days'].value = String(defaultDays);
  clientDefaultDays = defaultDays;
  clientModelOptions('client-invitation-models', clientInviteDraft);
  renderClientInvitations(); renderClientAdminControls();
}

async function refreshClientAdmin({ clearSecret = false, replaceDraft = false } = {}) {
  if (clearSecret) clearClientSecret();
  if (clientAdminRequest) return clientAdminRequest;
  const pending = (async () => {
    try {
      const data = await request('/api/client-admin', { signal: AbortSignal.timeout(10000) });
      if (!Array.isArray(data.accounts) || !Array.isArray(data.invites)) throw new Error('用户管理返回格式不完整，请更新后台。');
      clientAdminData = data; clientAdminError = ''; clientAdminUnavailable = false; clientAdminLoaded = true;
      renderClientAdmin({ replaceDraft });
    } catch (error) {
      clientAdminLoaded = true; clientAdminUnavailable = true;
      clientAdminError = error.status === 404 || error.status === 503 ? '接入用户管理需在更新并重启后台后可用。' : `用户管理读取失败：${error.message || '请重试。'}`;
      pill('client-admin-state', error.status === 404 || error.status === 503 ? '待更新后台' : '读取失败', 'pending');
    } finally { if (clientAdminRequest === pending) clientAdminRequest = null; renderClientAdminControls(); }
  })();
  clientAdminRequest = pending; renderClientAdminControls(); return pending;
}

async function runClientAdminAction(operation) {
  if (!clientAdminReady()) return;
  await action('client-admin', async () => {
    clientAdminError = ''; renderClientAdminControls();
    try { await operation(); await refreshClientAdmin(); text('client-admin-message', '已保存，接入权限立即生效。'); }
    catch (error) { clientAdminError = error.message || '操作未完成，请重试。'; renderClientAdminControls(); throw error; }
  });
}

function channelModelCounts(channel, authenticated) {
  if (authenticated !== true) return { catalog: authenticated === false ? '登录后读取' : '登录状态未确认', enabled: '登录后生效' };
  const models = modelCatalogModels?.filter(model => modelChannel(model) === channel);
  const discovery = modelSettings?.discovery?.[channel];
  const currentCount = discovery?.state === 'ready' && Number.isSafeInteger(discovery.count) && discovery.count >= 0 ? discovery.count : null;
  const catalog = currentCount !== null ? `${currentCount} 项（当前账号目录）`
    : discovery ? '当前账号目录未读取'
      : models ? channel === 'B' ? `${models.length} 项（网关别名）` : channel === 'A' ? `${models.length} 项（已发现）`
        : `已发现 ${models.length} 项，当前账号目录未返回` : '请刷新账号目录';
  return { catalog, enabled: models ? `${models.filter(model => model.enabled && model.available !== false).length} 项（已保存）` : '尚未读取' };
}

function renderAccountSummary(id, { authenticated, identity, plan, method, pending = false, loggingOut = false,
  readError = '', loading = false }) {
  const error = managementStatusError ? '连接中断' : readError;
  const confirmed = !error && !pending && !loggingOut && authenticated === true;
  const label = error || (loggingOut ? '正在退出' : pending ? '等待授权' : loading ? '读取中'
    : authenticated === true ? '已登录' : authenticated === false ? '未登录' : '未确认');
  pill(`account-${id}-state`, label, confirmed ? 'success' : error && error !== '待更新服务' ? 'error' : 'pending');
  const display = value => typeof value === 'string' && value.trim() ? value : '未返回';
  text(`account-${id}-identity`, confirmed ? display(identity) : authenticated === false && !error && !pending && !loggingOut ? '未登录' : '未确认');
  text(`account-${id}-plan`, confirmed ? display(plan) : '未返回');
  text(`account-${id}-method`, method);
  const channels = { a: 'A', b: 'B', codebuddy: 'CodeBuddy', cursor: 'Cursor' };
  const counts = channelModelCounts(channels[id], confirmed ? true : authenticated === false && !error ? false : null);
  text(`account-${id}-catalog`, counts.catalog);
  text(`account-${id}-enabled`, counts.enabled);
}

function renderAccountSummaries() {
  const original = accountQuotaStatus?.accounts?.A;
  renderAccountSummary('a', {
    authenticated: original?.status !== 'error' ? original?.authenticated : null,
    identity: original?.identity, plan: original?.planType, method: '由当前 Codex 管理（认证方式未返回）',
    readError: original?.status === 'error' ? '读取失败' : '', loading: accountQuotaStatus === null,
  });
  const backend = status?.backend;
  const account = backend?.error ? null : backend?.account;
  renderAccountSummary('b', {
    authenticated: backend && !backend.error ? Boolean(account) : null,
    identity: account?.email, plan: account?.planType, method: '独立 Codex 官方授权',
    pending: backend?.login?.state === 'pending' || ['login', 'device-login'].includes(busyAction),
    loggingOut: busyAction === 'logout', readError: backend?.error ? '读取失败' : '', loading: !status,
  });
  const provider = codeBuddyStatus?.provider;
  renderAccountSummary('codebuddy', {
    authenticated: provider?.authenticated, identity: provider?.username, plan: null, method: '独立 CodeBuddy 员工授权',
    pending: ['starting', 'pending'].includes(codeBuddyStatus?.login?.state) || busyAction === 'codebuddy-login',
    loggingOut: busyAction === 'codebuddy-logout', readError: codeBuddyReadError, loading: !codeBuddyStatus && !codeBuddyReadError,
  });
  const plan = cursorStatus?.plan?.name || cursorStatus?.plan?.declared;
  renderAccountSummary('cursor', {
    authenticated: cursorStatus?.authReady, identity: cursorStatus?.profile?.email || cursorStatus?.profile?.userEmail || cursorStatus?.profile?.name,
    plan: plan ? `${plan}${cursorStatus.plan.verified === true ? '（已核实）' : '（待核实）'}` : null,
    method: '独立 Cursor 官方 SDK 授权',
    pending: ['starting', 'pending'].includes(cursorStatus?.login?.state) || busyAction === 'cursor-login',
    loggingOut: busyAction === 'cursor-logout', readError: cursorReadError, loading: !cursorStatus && !cursorReadError,
  });
}

function invalidateAccountStatus(account) {
  accountStateEpoch[account]++;
  accountMetadataNeedsRefresh.add(account);
  if (account === 'b' && status) {
    status = { ...status, backend: { ...status.backend, account: null, pinnedAccount: null, login: {}, error: null },
      gateway: { ...status.gateway, enabled: false }, verification: { status: 'not_run' } };
  } else if (account === 'codebuddy') {
    codeBuddyStatus = codeBuddyStatus ? { configured: codeBuddyStatus.configured, running: codeBuddyStatus.running,
      provider: { authenticated: false }, login: {} } : null;
    codeBuddyReadError = '';
    text('codebuddy-username', '未确认'); text('codebuddy-authentication', '未确认');
    elements['codebuddy-authorization-link'].hidden = true; elements['codebuddy-authorization-link'].removeAttribute('href');
    pill('codebuddy-state', '读取中', 'pending');
  } else if (account === 'cursor') {
    cursorStatus = cursorStatus ? { configured: cursorStatus.configured, enabled: false, authReady: false,
      promptMode: cursorStatus.promptMode, preservesSystemPromptPriority: cursorStatus.preservesSystemPromptPriority, login: {} } : null;
    cursorReadError = '';
    text('cursor-account', '未确认'); text('cursor-plan', '未返回');
    elements['cursor-authorization-link'].hidden = true; elements['cursor-authorization-link'].removeAttribute('href');
    pill('cursor-state', '读取中', 'pending');
  }
  renderChannelModelCounts();
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
  const data = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-CSRF': status.csrfToken },
    body: JSON.stringify(body)
  });
  const mutatedAccounts = { '/api/login': 'b', '/api/logout': 'b',
    '/api/codebuddy/login': 'codebuddy', '/api/codebuddy/logout': 'codebuddy',
    '/api/cursor/login': 'cursor', '/api/cursor/logout': 'cursor' };
  if (Object.hasOwn(mutatedAccounts, path)) invalidateAccountStatus(mutatedAccounts[path]);
  return data;
}

function renderServiceControl() {
  const data = serviceStatus;
  const reportedError = serviceError || (typeof data?.error === 'string' ? data.error : data?.error?.message || '');
  const idle = managementConnected && !busyAction && !restartInProgress;
  const readable = !serviceUnavailable && serviceError === '';
  const cleanupFailed = data?.restart?.state === 'cleanup_failed';
  text('service-ready', data ? data.ready === true ? '已就绪' : '尚未就绪' : '未取得状态');
  text('service-independent', data ? data.independentOfCodex === true ? '独立运行，关闭 Codex 后继续服务' : '尚未确认独立运行' : '未取得状态');
  text('service-active', Number.isSafeInteger(data?.activeRequests) && data.activeRequests >= 0 ? data.activeRequests.toLocaleString('zh-CN') : '未返回');
  const version = data?.version;
  const versionLabel = value => value ? `${typeof value.revision === 'string' ? value.revision.slice(0, 12)
    : typeof value.fingerprint === 'string' ? value.fingerprint.slice(0, 12) : '未取得版本'}${typeof value.revision === 'string' && typeof value.fingerprint === 'string' ? ` · ${value.fingerprint.slice(0, 8)}` : ''}${value.dirty === true ? '（含未提交改动）' : ''}` : '未返回（需更新后台）';
  text('service-running-version', versionLabel(version?.running));
  text('service-installed-version', versionLabel(version?.installed));
  text('service-started-at', version?.running?.startedAt ? tokenTime(version.running.startedAt, 'America/Los_Angeles') : '未返回');
  text('service-update-state', version?.updatePending === true ? '有更新，重启网关后生效'
    : version?.state === 'current' ? '后台代码已生效' : '尚未取得版本状态');
  if (restartInProgress) pill('service-state', '正在重启', 'pending');
  else if (serviceUnavailable) pill('service-state', '待更新服务', 'pending');
  else if (cleanupFailed && readable) pill('service-state', '清理失败', 'error');
  else if (reportedError) pill('service-state', '状态需检查', 'error');
  else if (data?.restart?.state === 'queued' || data?.restart?.state === 'prepared' && data.restart.mode === 'when-idle') pill('service-state', '等待空闲重启', 'pending');
  else if (data?.pending) pill('service-state', '等待重启', 'pending');
  else if (version?.updatePending === true) pill('service-state', '有待生效更新', 'pending');
  else pill('service-state', data?.ready ? '已就绪' : '尚未就绪', data?.ready ? 'success' : 'pending');
  elements['service-restart-button'].disabled = !idle || serviceUnavailable || serviceError !== '' || data?.supported !== true || data?.pending === true || restartConfirmation;
  text('service-restart-button', restartInProgress || data?.draining ? '正在重启…' : '立即重启');
  const queued = data?.restart?.mode === 'when-idle' && ['prepared', 'queued'].includes(data.restart.state);
  elements['service-idle-restart-button'].disabled = !idle || !readable || data?.supported !== true || data?.capabilities?.whenIdle !== true || Boolean(data?.pending) || restartConfirmation;
  elements['service-idle-cancel-button'].hidden = !queued && !cleanupFailed;
  elements['service-idle-cancel-button'].disabled = !idle || !readable || data?.capabilities?.cancelQueued !== true;
  text('service-idle-cancel-button', cleanupFailed ? '重试取消' : '取消排队');
  text('service-queue-message', cleanupFailed ? '重启请求文件清理失败，网关仍暂停接收新请求。请重试取消，清理成功后恢复服务。'
    : queued ? `已排队，等待网关请求与受管理的工具回合空闲后重启。${data.activeRequests ? `当前进行中 ${data.activeRequests} 项。` : '正在确认空闲状态。'}可随时取消排队。`
    : data && data.capabilities?.whenIdle !== true ? '空闲重启与版本信息需在更新后台后可用。' : '等待网关请求与 Cursor 工具回合；客户端本地任务继续由客户端管理。');
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

async function queueServiceRestart() {
  if (!managementConnected || busyAction || restartInProgress || serviceUnavailable || serviceError !== ''
    || serviceStatus?.supported !== true || serviceStatus?.pending || serviceStatus?.capabilities?.whenIdle !== true) return;
  await action('service-queue', async () => {
    const previousToken = status.csrfToken;
    await post('/api/service/restart', { mode: 'when-idle' });
    queuedRestartToken = previousToken;
    await refreshServiceStatus();
    text('service-message', '已安排空闲后重启，当前回合可以继续。');
  });
}

async function cancelQueuedRestart() {
  if (!managementConnected || busyAction || restartInProgress || serviceUnavailable || serviceError !== ''
    || serviceStatus?.capabilities?.cancelQueued !== true) return;
  await action('service-queue-cancel', async () => {
    await post('/api/service/restart/cancel');
    queuedRestartToken = null;
    await refreshServiceStatus();
    text('service-message', '已取消排队重启。');
  });
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

function completeModelDiscoverySupported() {
  return modelSettings?.discovery !== null && typeof modelSettings?.discovery === 'object' && !Array.isArray(modelSettings.discovery);
}

const modelChannel = model => model.channel === 'CursorTeams' ? 'Cursor' : model.channel || '其他渠道';
const modelChannelLabels = { A: '账号 A', B: '账号 B', CodeBuddy: 'CodeBuddy', Cursor: 'Cursor Teams' };
function modelSettingsEditable() {
  return managementConnected && !busyAction && !restartInProgress && !modelSettingsUnavailable && !modelSettingsError && modelSettings !== null;
}
function filteredModels() {
  const query = elements['model-settings-search'].value.trim().toLocaleLowerCase();
  return (modelSettings?.models ?? []).filter(model => !query || [model.id, model.name, modelChannel(model),
    modelChannelLabels[modelChannel(model)], model.reason].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)));
}
function renderChannelModelCounts() {
  for (const [channel, catalogId, enabledId, authenticated] of [
    ['CodeBuddy', 'codebuddy-model-available', 'codebuddy-enabled-models', codeBuddyStatus?.provider?.authenticated === true
      && !['starting', 'pending'].includes(codeBuddyStatus?.login?.state) && !['codebuddy-login', 'codebuddy-logout'].includes(busyAction)],
    ['Cursor', 'cursor-catalog-models', 'cursor-enabled-models', cursorStatus?.authReady === true
      && !['starting', 'pending'].includes(cursorStatus?.login?.state) && !['cursor-login', 'cursor-logout'].includes(busyAction)],
  ]) {
    const counts = channelModelCounts(channel, authenticated);
    text(catalogId, counts.catalog); text(enabledId, counts.enabled);
  }
  renderAccountSummaries();
}

function renderModelSettingsControls() {
  const dirty = modelSettingsDirty();
  const available = modelSettingsEditable();
  elements['model-settings-save-button'].disabled = !available || !dirty;
  elements['model-settings-reset-button'].disabled = !available || !dirty;
  elements['model-settings-refresh-button'].disabled = !managementConnected || Boolean(busyAction) || restartInProgress || Boolean(modelSettingsRequest);
  text('model-settings-save-button', busyAction === 'model-settings-save' ? '正在保存…' : '保存模型选择');
  text('model-settings-refresh-button', modelSettingsRequest ? '正在刷新目录…' : '刷新账号目录');
  elements['model-settings-search'].disabled = !modelSettings || restartInProgress;
  const byModelId = new Map((modelSettings?.models ?? []).map(model => [model.id, model]));
  elements['model-settings-list'].querySelectorAll('input').forEach(input => { input.disabled = !available || byModelId.get(input.value)?.available === false; });
  for (const { button, ids, enabled } of modelGroupActions) {
    button.disabled = !available || !ids.some(id => modelDraft.get(id) !== enabled);
  }
  if (modelSettingsUnavailable) pill('model-settings-state', '待更新服务', 'pending');
  else if (modelSettingsError) pill('model-settings-state', '读取失败', 'error');
  else if (modelSettings) {
    const selected = modelSettings.models.filter(model => modelDraft.get(model.id) && model.available !== false).length;
    const legacy = !completeModelDiscoverySupported();
    pill('model-settings-state', dirty ? '有未保存更改' : legacy ? '待重启加载目录' : `${selected} / ${modelSettings.models.length} 已开放`, dirty || legacy ? 'pending' : 'success');
    const visible = filteredModels().length, unavailable = modelSettings.models.filter(model => model.available === false).length;
    text('model-settings-summary', `显示 ${visible} / ${modelSettings.models.length} 项 · 当前勾选可用 ${selected} 项${unavailable ? ` · ${unavailable} 项源端不可用或尚未适配` : ''}`);
  }
  text('model-settings-error', modelSettingsUnavailable ? '重启服务后可用。当前服务尚未提供模型选择接口。' : modelSettingsError);
  elements['model-settings-error'].hidden = !modelSettingsUnavailable && !modelSettingsError;
}

function modelEvidenceDetails(model) {
  const details = document.createElement('details'); details.className = 'model-evidence';
  const verification = model.verification;
  const verificationLabel = verification?.state === 'passed' ? '已完成真实调用'
    : verification?.state === 'failed' ? '最近调用失败' : '尚未验证';
  const summary = document.createElement('summary'); summary.textContent = `能力与验证 · ${verificationLabel}`;
  const fields = document.createElement('dl'); fields.className = 'model-capabilities';
  const appendField = (name, value) => {
    const row = document.createElement('div'), label = document.createElement('dt'), content = document.createElement('dd');
    label.textContent = name; content.textContent = value; row.append(label, content); fields.append(row);
  };
  const capabilities = model.capabilities;
  const support = value => value?.support === true ? '支持' : value?.support === false ? '不支持' : '未确认';
  for (const [key, label] of [['images', '图片'], ['tools', '客户端工具'], ['reasoning', '思考'], ['cache', '缓存']]) {
    const value = capabilities?.[key];
    const efforts = key === 'reasoning' && Array.isArray(value?.efforts) ? value.efforts.filter(effort => typeof effort === 'string').join('、') : '';
    appendField(label, `${support(value)}${efforts ? `（${efforts}）` : ''}${typeof value?.note === 'string' && value.note ? ` · ${value.note}` : ''}`);
  }
  const context = capabilities?.contextWindow;
  appendField('上下文', Number.isSafeInteger(context?.tokens) && context.tokens > 0 ? `${context.tokens.toLocaleString('zh-CN')} Token` : '未确认');
  appendField('指令处理', model.compatibility?.label || '尚未取得接入方式');
  if (typeof model.compatibility?.note === 'string') appendField('兼容说明', model.compatibility.note);
  appendField('调用验证', verificationLabel);
  if (verification?.checkedAt) appendField('验证时间', tokenTime(verification.checkedAt, 'America/Los_Angeles'));
  if (typeof verification?.reason === 'string' && verification.reason) appendField('验证说明', verification.reason);
  const note = document.createElement('p'); note.className = 'footnote';
  note.textContent = capabilities ? '目录能力与实际调用验证分别展示；一次调用完成不代表图片、工具和缓存均已验证。刷新账号目录可更新调用验证状态。'
    : '当前后台未提供模型能力信息；更新并重启网关后查看，未知能力不会标成支持。';
  details.append(summary, fields, note);
  return details;
}

function renderModelSettingsList() {
  const groups = new Map();
  for (const model of filteredModels()) {
    const channel = modelChannel(model);
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(model);
  }
  modelGroupActions = [];
  const nodes = [];
  for (const [channel, models] of groups) {
    const group = document.createElement('fieldset'); group.className = 'model-settings-group';
    const legend = document.createElement('legend'); legend.textContent = `${modelChannelLabels[channel] || channel} · ${models.length} 项`;
    group.append(legend);
    const actions = document.createElement('div'); actions.className = 'model-group-actions';
    const selectable = models.filter(model => model.available !== false).map(model => model.id);
    for (const [enabled, title] of [[true, '全选可用项'], [false, '全关可用项']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet small';
      button.textContent = title; button.setAttribute('aria-label', `${modelChannelLabels[channel] || channel}：${title}（当前搜索结果）`);
      button.addEventListener('click', () => {
        if (!modelSettingsEditable() || button.disabled) return;
        for (const id of selectable) modelDraft.set(id, enabled);
        renderModelSettingsList();
        text('model-settings-message', '批量选择仅作用于本渠道当前搜索结果中的可用模型；点击保存后生效。');
      });
      actions.append(button); modelGroupActions.push({ button, ids: selectable, enabled });
    }
    group.append(actions);
    for (const model of models) {
      const label = document.createElement('label'); label.className = 'model-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = model.id; checkbox.checked = modelDraft.get(model.id) === true;
      checkbox.addEventListener('change', () => {
        if (checkbox.disabled || model.available === false) return;
        modelDraft.set(model.id, checkbox.checked); renderModelSettingsControls();
      });
      const details = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = model.name || model.id;
      const identifier = document.createElement('small'); identifier.textContent = model.id;
      details.append(title, identifier);
      if (model.available === false) {
        const reason = document.createElement('small'); reason.className = 'model-unavailable-reason';
        reason.textContent = model.reason || '源端当前不可用或尚未适配。';
        details.append(reason);
      }
      label.append(checkbox, details); group.append(label, modelEvidenceDetails(model));
    }
    nodes.push(group);
  }
  if (!nodes.length) {
    const empty = document.createElement('p'); empty.className = 'model-settings-empty';
    empty.textContent = modelSettings?.models.length ? '没有匹配的模型，换个关键词试试。' : '暂时没有可显示的模型。请先确认渠道授权，再刷新账号目录。'; nodes.push(empty);
  }
  elements['model-settings-list'].replaceChildren(...nodes);
  renderChannelModelCounts();
  renderModelSettingsControls();
}

async function refreshModelSettings({ replaceDraft = false } = {}) {
  if (modelSettingsRequest) return modelSettingsRequest;
  const generation = modelSettingsGeneration;
  const pending = (async () => {
    try {
      const data = await request('/api/model-settings', { signal: AbortSignal.timeout(15000) });
      if (generation !== modelSettingsGeneration) return;
      if (data.revision == null || !Array.isArray(data.models) || data.models.some(model => typeof model?.id !== 'string' || typeof model.enabled !== 'boolean'
        || model.available !== undefined && typeof model.available !== 'boolean' || model.reason !== undefined && typeof model.reason !== 'string')) throw new Error('服务返回的模型列表格式无效。');
      modelSettingsLoaded = true;
      modelCatalogModels = data.models;
      modelSettingsUnavailable = false; modelSettingsError = typeof data.error === 'string' ? data.error : data.error?.message || '';
      const changed = !modelSettings || JSON.stringify(data) !== JSON.stringify(modelSettings);
      if (replaceDraft || !modelSettingsDirty()) {
        modelSettings = data;
        if (changed || replaceDraft) { modelDraft = new Map(data.models.map(model => [model.id, model.enabled])); renderModelSettingsList(); }
      } else if (changed) {
        const previous = modelSettings, prior = new Map(previous.models.map(model => [model.id, model]));
        modelSettings = { ...data, revision: previous.revision, models: data.models.map(model => ({ ...model, enabled: prior.get(model.id)?.enabled ?? model.enabled })) };
        // A newly unavailable model cannot retain an unsaved enable request.
        // Already saved selections remain intact until the user changes them.
        modelDraft = new Map(data.models.map(model => [model.id, model.available === false && !model.enabled
          ? false : modelDraft.has(model.id) ? modelDraft.get(model.id) : model.enabled]));
        renderModelSettingsList();
        if (data.revision !== previous.revision) text('model-settings-message', '账号目录已更新，未保存的勾选已保留。保存时会核对版本；发生冲突时请重新勾选。');
      }
      const discovery = Object.entries(data.discovery ?? {}).filter(([, value]) => value?.state === 'error')
        .map(([channel, value]) => `${modelChannelLabels[channel] || channel}：${typeof value.message === 'string' ? value.message : '目录暂不可用'}`);
      if (!completeModelDiscoverySupported()) discovery.unshift('当前后台尚未加载完整模型目录功能，下面仅显示旧目录中的已保存模型。请先重启网关服务，恢复后再刷新账号目录；仅刷新网页不会更新后台。');
      text('model-settings-discovery', discovery.join(' · ')); elements['model-settings-discovery'].hidden = !discovery.length;
    } catch (error) {
      if (generation !== modelSettingsGeneration) return;
      modelSettingsUnavailable = error.status === 404;
      modelSettingsError = modelSettingsUnavailable ? '' : error.message || '暂时无法读取模型列表。';
      if (!modelSettings) {
        const empty = document.createElement('p'); empty.className = 'model-settings-empty';
        empty.textContent = modelSettingsUnavailable ? '重启服务后可用。' : '模型列表暂时无法读取。';
        elements['model-settings-list'].replaceChildren(empty);
      }
    } finally {
      if (modelSettingsRequest === pending) {
        modelSettingsRequest = null; renderChannelModelCounts(); renderModelSettingsControls();
      }
    }
  })();
  modelSettingsRequest = pending;
  renderModelSettingsControls();
  return pending;
}
async function refreshAuthorizedModelSettings() {
  if (modelSettingsRequest) await modelSettingsRequest;
  await refreshModelSettings();
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
      modelSettingsLoaded = false;
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
  const login = data.login || {}, gateway = data.gateway || {};
  const pending = ['starting', 'pending'].includes(login.state) || busyAction === 'cursor-login';
  const authenticated = data.authReady === true && !pending && busyAction !== 'cursor-logout';
  const idle = managementConnected && !busyAction && !restartInProgress;
  const url = safeCursorAuthorizationUrl(login.url);
  text('cursor-account', authenticated ? data.profile?.email || data.profile?.userEmail || data.profile?.name || '已登录（账号资料未返回）' : '未登录');
  const plan = authenticated && (data.plan?.name || data.plan?.declared);
  text('cursor-plan', plan ? `${plan}${data.plan?.verified === true ? '（已核实）' : '（待核实）'}` : '未返回');
  const promptModes = {
    'project-rules': { name: '项目规则兼容模式', note: '保留 Cursor 内置系统提示；Codex 指令写入本次隔离目录的 AGENTS.md，按项目规则读取，不能保证原 system/developer 优先级。' },
    system: { name: '系统指令模式', note: 'Codex 指令通过 Cursor SDK systemPrompt 传入；需要 Cursor 开放这项权限。' },
  };
  const promptMode = Object.hasOwn(promptModes, data.promptMode) ? promptModes[data.promptMode] : null;
  text('cursor-prompt-mode', promptMode?.name || (data.configured === false && data.error ? '配置无效，渠道已停用' : '未返回（待重启服务）'));
  text('cursor-prompt-priority', data.preservesSystemPromptPriority === true ? 'SDK 系统提示优先级'
    : data.preservesSystemPromptPriority === false ? '项目规则优先级' : '未返回（待重启服务）');
  text('cursor-prompt-note', promptMode && typeof data.preservesSystemPromptPriority === 'boolean' ? promptMode.note
    : '当前服务未返回完整接入模式；重启网关后查看实际模式与指令优先级。');
  renderChannelModelCounts();
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
      : authenticated ? data.enabled ? 'Cursor 已授权。请在控制台刷新账号目录，勾选并保存要开放的模型。' : 'Cursor 已授权，渠道尚未启用。'
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
  const epoch = accountStateEpoch.cursor;
  if (cursorRequest && cursorRequestEpoch === epoch) return cursorRequest;
  const pending = (async () => {
    try {
      const previous = cursorStatus;
      const incoming = await request('/api/cursor', { signal: AbortSignal.timeout(20000) });
      if (epoch !== accountStateEpoch.cursor) return;
      cursorStatus = incoming; cursorReadError = ''; renderCursor(cursorStatus);
      const refreshMetadata = accountMetadataNeedsRefresh.delete('cursor');
      if (refreshMetadata || previous && (previous.authReady !== cursorStatus.authReady || previous.profile?.email !== cursorStatus.profile?.email)) {
        void refreshAuthorizedModelSettings(); void refreshAuthorizedAccountQuotas();
      }
    }
    catch (error) {
      if (epoch !== accountStateEpoch.cursor) return;
      cursorReadError = error.status === 404 ? '待更新服务' : '读取失败';
      cursorStatus = null; pill('cursor-state', error.status === 404 ? '待更新服务' : '读取失败', error.status === 404 ? 'pending' : 'error');
      text('cursor-account', '未确认'); text('cursor-plan', '未返回');
      text('cursor-catalog-models', '登录状态未确认'); text('cursor-enabled-models', '登录后生效');
      text('cursor-login-state', error.status === 404 ? '重启服务后可用。' : 'Cursor 状态暂时无法读取。');
      text('cursor-prompt-mode', error.status === 404 ? '待重启服务' : '未返回');
      text('cursor-prompt-priority', '未返回');
      text('cursor-prompt-note', '当前服务未返回接入模式，请在服务更新后查看。');
      text('cursor-error', error.status === 404 ? '当前服务尚未提供 Cursor 授权接口。' : error.message || '请稍后重试。');
      elements['cursor-error'].hidden = false;
      elements['cursor-login-button'].disabled = true; elements['cursor-logout-button'].disabled = true;
      elements['cursor-authorization-link'].hidden = true; elements['cursor-authorization-link'].removeAttribute('href');
    } finally { if (cursorRequest === pending) cursorRequest = null; if (epoch === accountStateEpoch.cursor) renderAccountSummaries(); }
  })();
  cursorRequest = pending; cursorRequestEpoch = epoch;
  return pending;
}

function render() {
  if (!status) return;
  const backend = status.backend || {};
  const gateway = status.gateway || {};
  const integration = status.integration || {};
  const needsUpgrade = Boolean(integration.installed && integration.needsUpgrade);
  const verification = status.verification || {};
  const login = backend.login || {};
  const account = backend.error ? null : backend.account;
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
  renderAccountSummaries();
  renderClientAdminControls();
}

async function refreshStatus({ duringRestart = false, signal } = {}) {
  if (restartInProgress && !duringRestart) return status;
  const epoch = accountStateEpoch.b;
  if (statusRequest && statusRequestEpoch === epoch) return statusRequest;
  const pending = (async () => {
    try {
      let incoming;
      try { incoming = await request('/api/status', { signal: signal ?? AbortSignal.timeout(5000) }); }
      catch (error) {
        if (epoch !== accountStateEpoch.b) return status;
        if (error.status !== 401 || restartInProgress) throw error;
        await bootstrapManagementSession(AbortSignal.timeout(5000));
        if (epoch !== accountStateEpoch.b) return status;
        incoming = await request('/api/status', { signal: AbortSignal.timeout(5000) });
      }
      if (epoch !== accountStateEpoch.b) return status;
      const previousToken = status?.csrfToken;
      status = incoming;
      if (previousToken && status.csrfToken && status.csrfToken !== previousToken) {
        modelSettingsGeneration++;
        modelSettingsRequest = null;
        modelSettingsLoaded = false;
      }
      if (queuedRestartToken && status.csrfToken && status.csrfToken !== queuedRestartToken) {
        queuedRestartToken = null;
        text('service-message', '网关已完成重启，新后台已连接。');
        notify('网关已完成重启，请核对版本和模型目录。');
        modelSettingsLoaded = false;
      }
      managementConnected = true;
      managementStatusError = false;
      render();
      if (!restartInProgress) {
        if (status.backend?.account && !modelsLoaded) void loadModels();
        if (!status.backend?.account) modelsLoaded = false;
        void refreshTokenUsage();
        void refreshRequestDiagnostics();
        void refreshWith();
        void refreshCodeBuddy();
        void refreshCursor();
        void refreshServiceStatus();
        if (!modelSettingsLoaded) void refreshModelSettings();
        if (elements['tab-clients'].getAttribute('aria-selected') === 'true' && !clientAdminLoaded) void refreshClientAdmin();
        if (!status.backend?.error && accountMetadataNeedsRefresh.delete('b')) {
          void refreshAuthorizedModelSettings(); void refreshAuthorizedAccountQuotas();
        }
      }
      return status;
    } catch (error) {
      if (epoch !== accountStateEpoch.b) return status;
      managementConnected = false;
      managementStatusError = true;
      elements['connection-dot'].className = 'status-dot failed';
      text('connection-label', restartInProgress || queuedRestartToken ? '正在等待网关恢复连接' : '本机服务连接中断，正在重试');
      document.querySelectorAll('button:not(#quota-refresh-button):not([role="tab"])').forEach((button) => { button.disabled = true; });
      renderAccountSummaries();
      renderClientAdminControls();
      throw error;
    } finally {
      if (statusRequest === pending) statusRequest = null;
    }
  })();
  statusRequest = pending; statusRequestEpoch = epoch;
  return pending;
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

function safeQuotaUsageUrl(accountId, value) {
  if (typeof value !== 'string') return null;
  const hosts = { A: ['chatgpt.com'], B: ['chatgpt.com'], CodeBuddy: ['www.codebuddy.cn'], Cursor: ['cursor.com'] };
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts[accountId]?.includes(url.hostname)) return url.href;
  } catch { /* Only the corresponding provider's official HTTPS origin is linked. */ }
  return null;
}

function renderAccountQuotas(data) {
  accountQuotaStatus = data;
  const timeZone = data.timeZone || 'America/Los_Angeles';
  for (const accountId of ['A', 'B', 'CodeBuddy', 'Cursor']) {
    const prefix = `quota-${accountId.toLowerCase()}`;
    const account = data.accounts?.[accountId];
    const succeeded = account?.status === 'ok';
    const notConnected = account?.status === 'not_connected' || account?.authenticated === false;
    const unknown = account?.status === 'unknown' && !notConnected;
    const missing = account == null;
    text(`${prefix}-plan`, account?.planType || '套餐未返回');
    text(`${prefix}-identity`, missing ? '服务未返回账号信息' : account.authenticated === true
      ? typeof account.identity === 'string' && account.identity.trim() ? account.identity : '已绑定（账号标识未返回）'
      : account.authenticated === false ? '未绑定本网关账号' : '账号状态未返回');
    const sourceLabels = { 'codex-account-rate-limits': 'Codex 官方账号限额',
      'codebuddy-account-metadata': 'CodeBuddy 官方账号信息', 'cursor-sdk-account-metadata': 'Cursor 官方账号信息' };
    text(`${prefix}-source`, Object.hasOwn(sourceLabels, account?.source) ? sourceLabels[account.source]
      : typeof account?.source === 'string' && account.source ? account.source : '来源未返回');
    const notice = typeof account?.notice === 'string' ? account.notice : '';
    text(`${prefix}-notice`, notice); elements[`${prefix}-notice`].hidden = !notice;
    const usageUrl = safeQuotaUsageUrl(accountId, account?.usageUrl);
    const link = elements[`${prefix}-usage-link`]; link.hidden = !usageUrl;
    if (usageUrl) link.href = usageUrl; else link.removeAttribute('href');
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
      empty.textContent = missing ? '当前服务未提供此账号的额度状态，请更新并重启网关。'
        : unknown ? '未提供剩余额度'
          : notConnected ? '绑定账号后可读取该渠道的额度状态。'
            : succeeded ? '官方未返回额度窗口' : '本次未取得官方额度';
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
    const error = succeeded || unknown || notConnected || missing ? ''
      : typeof account?.error === 'string' && account.error ? account.error : '官方额度暂时无法读取，请稍后重试。';
    text(`${prefix}-error`, error);
    elements[`${prefix}-error`].hidden = !error;
    text(`${prefix}-updated`, account?.fetchedAt ? `${succeeded ? '更新时间' : '查询时间'}：${quotaTime(account.fetchedAt, timeZone)}` : '尚未取得查询时间');
    pill(`${prefix}-state`, missing ? '待更新服务' : unknown ? '未提供余额' : notConnected ? '未绑定' : succeeded ? '已更新' : '需检查',
      succeeded ? 'success' : missing || unknown || notConnected ? 'pending' : 'error');
  }
  renderAccountSummaries();
}

async function refreshAccountQuotas() {
  if (accountQuotasRequest) return accountQuotasRequest;
  elements['quota-refresh-button'].disabled = true;
  text('quota-refresh-button', '查询中…');
  for (const accountId of ['a', 'b', 'codebuddy', 'cursor']) pill(`quota-${accountId}-state`, '查询中', 'pending');
  accountQuotasRequest = (async () => {
    try {
      renderAccountQuotas(await request('/api/account-quotas', { signal: AbortSignal.timeout(30_000) }));
    } catch (error) {
      const message = error.name === 'TimeoutError' ? '官方额度查询超时，请稍后重试。' : error.message || '官方额度暂时无法读取，请稍后重试。';
      renderAccountQuotas({ accounts: Object.fromEntries(['A', 'B', 'CodeBuddy', 'Cursor'].map(account => [account, { status: 'error', error: message }])) });
    } finally {
      accountQuotasRequest = null;
      elements['quota-refresh-button'].disabled = false;
      text('quota-refresh-button', '刷新额度');
    }
  })();
  return accountQuotasRequest;
}
async function refreshAuthorizedAccountQuotas() {
  if (accountQuotasRequest) await accountQuotasRequest;
  await refreshAccountQuotas();
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

const diagnosticStatusLabels = { completed: '完成', tool_pending: '等待工具结果', incomplete: '未完成', failed: '失败', interrupted: '已中断' };
const diagnosticStages = { gateway_auth: '网关认证', request_validation: '请求格式', model_policy: '模型开关',
  account_auth: '账号认证', adapter: '协议适配', upstream: '上游服务', stream: '响应流', client_disconnect: '客户端断开',
  gateway: '网关', validation: '请求格式', routing: '模型分流', authentication: '账号认证', transport: '上游连接', response: '上游响应',
  upstream_request: '上游请求', upstream_response: '上游响应', downstream: '返回客户端' };
function diagnosticDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ms` : '未返回';
}
function diagnosticId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }

function renderRequestDiagnostics() {
  const recent = Array.isArray(diagnosticsData?.recent) ? diagnosticsData.recent.slice(0, 10) : [];
  const rows = recent.map(record => {
    const row = document.createElement('tr');
    for (const value of [tokenTime(record.time, 'America/Los_Angeles'), record.account || '尚未识别', record.model || '尚未识别',
      diagnosticStatusLabels[record.status] || '未知', diagnosticDuration(record.durationMs)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const cell = document.createElement('td'), button = document.createElement('button');
    button.type = 'button'; button.className = 'button quiet small'; button.textContent = '查看';
    const id = diagnosticId(record.requestId); button.disabled = !id;
    button.addEventListener('click', () => { if (id) void loadRequestDiagnostic(id); });
    cell.append(button); row.append(cell); return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'empty-table';
    cell.textContent = diagnosticsData ? '诊断启用后尚无请求记录' : '等待诊断服务'; row.append(cell); rows.push(row);
  }
  elements['diagnostics-recent-body'].replaceChildren(...rows);
}

async function refreshRequestDiagnostics() {
  if (diagnosticsRequest) return diagnosticsRequest;
  diagnosticsRequest = (async () => {
    try {
      diagnosticsData = await request('/api/request-diagnostics?limit=10', { signal: AbortSignal.timeout(5000) });
      if (!Array.isArray(diagnosticsData.recent)) throw new Error('诊断记录格式无效。');
      renderRequestDiagnostics();
      const error = typeof diagnosticsData.error === 'string' ? diagnosticsData.error : diagnosticsData.error?.message;
      text('diagnostics-error', error || ''); elements['diagnostics-error'].hidden = !error;
      pill('diagnostics-state', error ? '记录需检查' : '已连接', error ? 'error' : 'success');
    } catch (error) {
      const unavailable = error.status === 404 || error.status === 503;
      pill('diagnostics-state', unavailable ? '待更新后台' : '读取失败', unavailable ? 'pending' : 'error');
      text('diagnostics-error', unavailable ? '当前后台尚未提供请求诊断；更新并重启网关后记录新请求。历史请求不会补造诊断数据。' : error.message || '请求诊断暂时无法读取。');
      elements['diagnostics-error'].hidden = false;
    } finally { diagnosticsRequest = null; }
  })();
  return diagnosticsRequest;
}

async function loadRequestDiagnostic(id) {
  if (!diagnosticId(id)) return;
  const generation = ++diagnosticDetailGeneration;
  elements['diagnostics-detail'].hidden = false;
  elements['diagnostics-export-link'].hidden = true; elements['diagnostics-export-link'].removeAttribute('href');
  elements['diagnostics-fields'].replaceChildren();
  text('diagnostics-detail-title', '正在读取请求详情'); text('diagnostics-detail-note', '');
  try {
    const data = await request(`/api/request-diagnostics/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
    if (generation !== diagnosticDetailGeneration) return;
    const record = data.request;
    if (!record || record.requestId !== id) throw new Error('请求详情与所选记录不一致。');
    const fields = [
      ['请求 ID', id], ['时间', tokenTime(record.time, 'America/Los_Angeles')], ['使用渠道', record.account || '尚未识别'],
      ['所选模型', record.model || '尚未识别'], ['上游模型', record.upstreamModel || '未返回'],
      ['结果', diagnosticStatusLabels[record.status] || '未知'], ['HTTP 状态', record.httpStatus ?? '未返回'],
      ['总耗时', diagnosticDuration(record.durationMs)], ['首响应耗时', diagnosticDuration(record.firstResponseMs)],
      ['失败阶段', record.failureStage ? diagnosticStages[record.failureStage] || record.failureStage : '无'],
      ['错误代码', record.errorCode || '无'], ['说明', record.message || '无错误'],
      ['输入 Token', tokenCount(record.usage?.inputTokens)], ['输出 Token', tokenCount(record.usage?.outputTokens)],
      ['缓存命中 Token', tokenCount(record.usage?.cachedInputTokens)], ['思考 Token', tokenCount(record.usage?.reasoningTokens)],
    ];
    elements['diagnostics-fields'].replaceChildren(...fields.map(([name, value]) => {
      const row = document.createElement('div'), label = document.createElement('dt'), content = document.createElement('dd');
      label.textContent = name; content.textContent = String(value); row.append(label, content); return row;
    }));
    text('diagnostics-detail-title', '请求详情');
    text('diagnostics-detail-note', '首响应耗时不等于模型首 Token 耗时；渠道指本网关实际使用的账号来源。用量缺失保持未知。');
    elements['diagnostics-export-link'].href = `/api/request-diagnostics/${encodeURIComponent(id)}/export`;
    elements['diagnostics-export-link'].hidden = false;
  } catch (error) {
    if (generation !== diagnosticDetailGeneration) return;
    text('diagnostics-detail-title', '请求详情暂不可用');
    text('diagnostics-detail-note', error.status === 404 ? '该记录尚未保存、早于诊断启用，或已经超出保留范围。' : error.message || '请稍后重试。');
  }
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
  const authenticated = provider.authenticated === true && !pending && busyAction !== 'codebuddy-logout';
  const idle = managementConnected && !busyAction;
  const url = safeCodeBuddyAuthorizationUrl(login.url);
  text('codebuddy-title', 'CodeBuddy');
  text('codebuddy-username', authenticated ? provider.username || '已登录（账号资料未返回）' : '未登录');
  text('codebuddy-authentication', authenticated ? '已登录' : provider.authenticated === false ? '待登录' : '未返回');
  renderChannelModelCounts();
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
  const epoch = accountStateEpoch.codebuddy;
  if (codeBuddyRequest && codeBuddyRequestEpoch === epoch) return codeBuddyRequest;
  const pending = (async () => {
    try {
      const previous = codeBuddyStatus;
      const incoming = await request('/api/codebuddy', { signal: AbortSignal.timeout(20000) });
      if (epoch !== accountStateEpoch.codebuddy) return;
      codeBuddyStatus = incoming;
      codeBuddyReadError = '';
      renderCodeBuddy(codeBuddyStatus);
      const refreshMetadata = accountMetadataNeedsRefresh.delete('codebuddy');
      if (refreshMetadata || previous && (previous.provider?.authenticated !== codeBuddyStatus.provider?.authenticated
        || previous.provider?.username !== codeBuddyStatus.provider?.username)) {
        void refreshAuthorizedModelSettings(); void refreshAuthorizedAccountQuotas();
      }
    } catch (error) {
      if (epoch !== accountStateEpoch.codebuddy) return;
      codeBuddyReadError = error.status === 404 ? '待更新服务' : '读取失败';
      codeBuddyStatus = null;
      text('codebuddy-username', '未确认'); text('codebuddy-authentication', '未确认');
      text('codebuddy-model-available', '登录状态未确认'); text('codebuddy-enabled-models', '登录后生效');
      elements['codebuddy-authorization-link'].hidden = true; elements['codebuddy-authorization-link'].removeAttribute('href');
      pill('codebuddy-state', '读取失败', 'error');
      elements['codebuddy-login-button'].disabled = true;
      elements['codebuddy-logout-button'].disabled = true;
      elements['codebuddy-error'].hidden = false;
      text('codebuddy-error', `CodeBuddy 状态暂时无法读取：${error.message || '请稍后重试。'}`);
    } finally {
      if (codeBuddyRequest === pending) codeBuddyRequest = null;
      if (epoch === accountStateEpoch.codebuddy) renderAccountSummaries();
    }
  })();
  codeBuddyRequest = pending; codeBuddyRequestEpoch = epoch;
  return pending;
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

const managementTabs = ['console', 'accounts', 'clients'];
for (const [index, name] of managementTabs.entries()) {
  elements[`tab-${name}`].addEventListener('click', () => selectManagementTab(name));
  elements[`tab-${name}`].addEventListener('keydown', event => {
    const next = event.key === 'Home' ? 'console' : event.key === 'End' ? 'clients'
      : event.key === 'ArrowLeft' ? managementTabs[(index + managementTabs.length - 1) % managementTabs.length]
        : event.key === 'ArrowRight' ? managementTabs[(index + 1) % managementTabs.length] : null;
    if (next) { event.preventDefault(); selectManagementTab(next, { focus: true }); }
  });
}
window.addEventListener('hashchange', () => selectManagementTab(window.location.hash.slice(1), { updateLocation: false }));
selectManagementTab(window.location?.hash?.slice(1), { updateLocation: false });

elements['client-admin-refresh'].addEventListener('click', () => { void refreshClientAdmin({ clearSecret: true }); });
elements['client-secret-close'].addEventListener('click', clearClientSecret);
elements['client-secret-copy'].addEventListener('click', () => {
  if (!clientSecret) return;
  void copyText(clientSecret).then(() => notify('完整凭证已复制，请妥善保存。')).catch(error => notify(error.message || '复制失败，请选中凭证复制。', true));
});
elements['client-user-create-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    const username = elements['client-create-username'].value.trim();
    const password = elements['client-create-password'].value;
    if (username.length < 3 || username.length > 64) throw new Error('用户名需为 3–64 个字符。');
    if (password.length < 12 || password.length > 256) throw new Error('密码需为 12–256 个字符。');
    elements['client-create-password'].value = '';
    const result = await post('/api/client-admin/accounts', { username, password, allowedModels: [], enabled: true });
    if (typeof result.account?.id === 'string') { clientSelectedId = result.account.id; clientModelDraft = new Set(result.account.allowedModels ?? []); }
    elements['client-create-username'].value = '';
  });
});
elements['client-user-toggle'].addEventListener('click', () => {
  const account = clientAccount(); if (!account) return;
  void runClientAdminAction(async () => { await post(clientAccountPath(account.id), { enabled: account.enabled === false }); });
});
elements['client-user-limit-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    const value = elements['client-user-key-limit'].value;
    const date = value ? new Date(value) : null;
    if (date && !Number.isFinite(date.getTime())) throw new Error('Key 到期上限格式无效。');
    await post(clientAccountPath(), { keyExpiresAtLimit: date ? date.toISOString() : null });
  });
});
elements['client-model-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    await post(clientAccountPath(), { allowedModels: [...clientModelDraft].sort() });
  });
});
elements['client-key-create-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    const expiresInDays = clientInteger('client-key-days', 'Key 有效天数');
    const name = elements['client-key-name'].value.trim() || 'Default';
    if (name.length > 80) throw new Error('Key 名称最多 80 个字符。');
    clearClientSecret();
    const result = await post(`${clientAccountPath()}/keys`, { name, expiresInDays });
    showClientSecret(result.secret); elements['client-key-name'].value = '';
  });
});
elements['client-registration-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    const mode = elements['client-registration-mode'].value;
    if (!['open', 'invite', 'closed'].includes(mode)) throw new Error('注册方式无效。');
    const defaultKeyDays = clientInteger('client-registration-days', '默认有效天数');
    await post('/api/client-admin/registration', { mode, defaultKeyDays });
  });
});
elements['client-invitation-create-form'].addEventListener('submit', event => {
  event.preventDefault();
  void runClientAdminAction(async () => {
    const expiresInDays = clientInteger('client-invitation-days', '邀请码有效天数');
    const maxUses = clientInteger('client-invitation-uses', '可注册人数', 10000);
    clearClientSecret();
    const result = await post('/api/client-admin/invites', { expiresInDays, maxUses, allowedModels: [...clientInviteDraft].sort() });
    showClientSecret(result.token, true);
  });
});

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
elements['service-idle-restart-button'].addEventListener('click', () => { void queueServiceRestart(); });
elements['service-idle-cancel-button'].addEventListener('click', () => { void cancelQueuedRestart(); });
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
  text('model-settings-message', '正在读取各账号模型目录，只查询元数据。');
  void refreshModelSettings().then(() => {
    if (!modelSettingsError && !modelSettingsUnavailable) text('model-settings-message', !completeModelDiscoverySupported()
      ? '当前后台仍使用旧目录接口。请先点击“重启网关服务”，恢复后再刷新账号目录。'
      : modelSettingsDirty() ? '账号目录已刷新，未保存的可用勾选已保留；不可用的未保存启用已撤回。保存时仍会核对目录版本。'
        : '账号目录已刷新。新增模型默认关闭，勾选并保存后在 Codex 中刷新模型目录。');
  });
});
elements['model-settings-search'].addEventListener('input', renderModelSettingsList);

void refreshAccountQuotas();
void refreshStatus().catch(() => {});
setInterval(() => { void refreshStatus().catch(() => {}); }, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshStatus().catch(() => {});
});
