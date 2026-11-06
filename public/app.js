'use strict';

// Windows supervisor verification can take up to ten seconds before version metadata is read.
const SERVICE_STATUS_TIMEOUT_MS = 15000;

const byId = (id) => document.getElementById(id);

function paintOfficialBrandIcons() {
  if (typeof document.querySelectorAll !== 'function' || typeof createImageBitmap !== 'function'
    || typeof Blob !== 'function' || typeof atob !== 'function') return;
  for (const canvas of document.querySelectorAll('canvas[data-brand-image]')) {
    const encoded = canvas.getAttribute('data-brand-image'), mime = canvas.getAttribute('data-brand-mime');
    if (!encoded || encoded.length > 500_000 || !['image/png', 'image/webp'].includes(mime)) continue;
    try {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      void createImageBitmap(new Blob([bytes], { type: mime })).then(bitmap => {
        try {
          const context = canvas.getContext('2d');
          if (!context) return;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          canvas.setAttribute('data-icon-ready', 'true');
        } finally { bitmap.close(); }
      }).catch(() => { canvas.hidden = true; });
    } catch { canvas.hidden = true; }
  }
}

function installDirectionalArrowLayout(prefix, groupId) {
  const svg = document.getElementById(groupId)?.ownerSVGElement;
  if (!svg || typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') return;
  const layout = () => {
    const matrix = svg.getScreenCTM();
    if (!matrix || !svg.getBoundingClientRect().width) return;
    const point = (x, y) => { const value = svg.createSVGPoint(); value.x = x; value.y = y; return value.matrixTransform(matrix.inverse()); };
    const box = id => document.getElementById(`${prefix}node-${id}`).getBoundingClientRect();
    const codex = box('codex'), claude = box('claude'), buddy = box('codebuddy'), cursor = box('cursor');
    const paths = [
      ['codex-codebuddy', point((codex.left + codex.right) / 2, codex.bottom + 5), point((buddy.left + buddy.right) / 2, buddy.top - 10), -90, 25, -90, -40],
      ['codex-cursor', point(codex.right + 5, (codex.top + codex.bottom) / 2), point((cursor.left + cursor.right) / 2, cursor.top - 10), 70, 15, -70, -50],
      ['claude-codebuddy', point((claude.left + claude.right) / 2, claude.bottom + 5), point((buddy.left + buddy.right) / 2 + buddy.width / 4, buddy.top - 10), -60, 35, 120, -80],
    ];
    for (const [id, start, end, a, b, c, d] of paths) {
      document.getElementById(`${prefix}route-${id}`)?.setAttribute('d', `M${start.x} ${start.y}C${start.x + a} ${start.y + b} ${end.x + c} ${end.y + d} ${end.x} ${end.y}`);
    }
  };
  layout();
  window.addEventListener('resize', layout);
  if (typeof ResizeObserver === 'function') new ResizeObserver(layout).observe(svg.parentElement);
}
const elements = Object.fromEntries([
  'connection-dot', 'connection-label', 'version', 'notice', 'setup-state',
  'tab-console', 'tab-accounts', 'tab-connections', 'tab-clients', 'panel-console', 'panel-accounts', 'panel-connections', 'panel-clients',
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
  'client-billing-state', 'client-billing-note', 'client-billing-metrics', 'client-billing-policy-form', 'client-billing-enforce',
  'client-billing-token-limit', 'client-billing-policy-save', 'client-billing-reset-confirm', 'client-billing-quota-reset',
  'client-balance-form', 'client-balance-amount', 'client-balance-note', 'client-balance-submit', 'client-balance-pending',
  'client-prices-state', 'client-prices-form', 'client-price-model', 'client-price-input', 'client-price-cached', 'client-price-output',
  'client-price-reserve-input', 'client-price-reserve-output', 'client-price-enabled', 'client-price-save',
  'client-ledger-count', 'client-ledger-note', 'client-ledger-list', 'client-ledger-error', 'client-ledger-more',
  'client-unresolved-count', 'client-unresolved-error', 'client-unresolved-list', 'client-unresolved-more',
  ...['a', 'b', 'codebuddy', 'cursor'].flatMap(account =>
    ['state', 'identity', 'plan', 'method', 'catalog', 'enabled'].map(field => `account-${account}-${field}`)),
  'step-login', 'step-bind', 'step-verify', 'login-button', 'device-login-button', 'authorization-link',
  'device-authorization', 'device-user-code', 'device-authorization-link',
  'login-state', 'account-card', 'account-email', 'account-plan', 'logout-button',
  'bind-button', 'bind-description', 'bound-account', 'model-select', 'verify-button',
  'verification-result', 'verification-label', 'verification-text', 'verification-meta',
  'integration-state', 'integration-description', 'config-path', 'install-button',
  'integration-mode-value', 'integration-mode-description', 'integration-mode-error',
  'integration-official-button', 'integration-gateway-button',
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
  'account-quotas-panel', 'quota-bifrost-state', 'quota-bifrost-notice', 'quota-bifrost-sources', 'quota-bifrost-updated',
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
let integrationModeUnavailableToken = null;
let modelsLoaded = false;
let modelsRequest = null;
let noticeTimer = null;
let tokenUsageRequest = null;
let withRequest = null;
let messagesStatus = null;
let worldSelection = 'all';
let worldRenderSignature = '';
let worldServiceGeneration = 0;
const worldProviderGeneration = { codebuddy: -1, cursor: -1 };
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
let modelSettingsRevisionFloor = -1;
let modelSettingsConfirmation = null;
let modelSettingsUnavailable = false;
let modelSettingsError = '';
let modelDraft = new Map();
let modelContextDraft = new Map();
let modelContextControls = [];
let modelGroupActions = [];
const modelGroupExpanded = new Map();
let modelGroupViews = [];
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
const clientBillingOperations = new Map();
let clientBillingRenderedId = '';
let clientUnresolvedRows = [];
let clientUnresolvedNextBefore = null;
let clientUnresolvedLoading = false;
let clientUnresolvedError = '';
let clientUnresolvedGeneration = 0;
let clientLedgerRows = [];
let clientLedgerNextBefore = null;
let clientLedgerLoading = false;
let clientLedgerError = '';
let clientLedgerGeneration = 0;
const clientBillingStorageKey = 'bifrost.admin.billing.pending.v1';
try {
  const stored = JSON.parse(window.sessionStorage?.getItem(clientBillingStorageKey) || '[]');
  if (Array.isArray(stored)) for (const item of stored) {
    if (!item || typeof item.slot !== 'string' || typeof item.path !== 'string' || !item.body || typeof item.body !== 'object'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.body.operationId)) continue;
    const balance = /^balance:([0-9a-f-]{36})$/i.exec(item.slot), resolve = /^resolve:([0-9a-f-]{36})$/i.exec(item.slot);
    const { operationId, ...body } = item.body;
    if (balance && item.path === `/api/client-admin/accounts/${balance[1]}/balance`
      && Number.isSafeInteger(body.amountMicros) && body.amountMicros !== 0 && Object.keys(body).every(key => ['amountMicros', 'note'].includes(key))
      && (body.note === undefined || typeof body.note === 'string' && body.note.length <= 240)
      || resolve && item.path === `/api/client-admin/billing/requests/${resolve[1]}/resolve` && ['release', 'settle'].includes(body.action)
      && Object.keys(body).every(key => ['action', 'usage'].includes(key)) && (body.action === 'release' && body.usage === undefined
        || body.action === 'settle' && body.usage && ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(body.usage[key]) && body.usage[key] >= 0)
        && body.usage.cachedInputTokens <= body.usage.inputTokens && body.usage.inputTokens + body.usage.outputTokens === body.usage.totalTokens)) {
      clientBillingOperations.set(item.slot, { path: item.path, body: item.body, signature: JSON.stringify({ path: item.path, body }), uncertain: true });
    }
  }
} catch { /* New mutations verify session persistence before sending a request. */ }

function persistClientBillingOperations() {
  try {
    if (typeof window.sessionStorage?.setItem !== 'function') return false;
    window.sessionStorage.setItem(clientBillingStorageKey, JSON.stringify([...clientBillingOperations].map(([slot, item]) => ({ slot, path: item.path, body: item.body }))));
    return true;
  } catch { return false; }
}

function text(id, value) {
  elements[id].textContent = value == null ? '' : String(value);
}

function pill(id, label, kind = '') {
  text(id, label);
  elements[id].className = `pill${kind ? ` ${kind}` : ''}`;
}

function canReadAccountQuotas(caps = status?.node?.capabilities) {
  return !caps || caps.clientIntegration === true || caps.activeKinds?.includes('bifrost') === true;
}

function selectManagementTab(name, { focus = false, updateLocation = true } = {}) {
  const requested = ['accounts', 'connections', 'clients'].includes(name) ? name : 'console';
  const caps = status?.node?.capabilities;
  const selected = requested === 'clients' && caps?.userManagement === false || requested === 'connections' && caps?.clientIntegration === false ? 'console' : requested;
  for (const tab of ['console', 'accounts', 'connections', 'clients']) {
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
  const billingReady = ready && clientAdminData?.billing?.available === true;
  for (const id of ['client-billing-policy-save', 'client-balance-submit']) elements[id].disabled = !billingReady || !selected || !clientAccount()?.billing;
  elements['client-price-save'].disabled = !billingReady || !elements['client-price-model'].value;
  const accountBilling = clientAccount()?.billing;
  elements['client-billing-quota-reset'].disabled = !billingReady || !accountBilling || !elements['client-billing-reset-confirm'].checked
    || accountBilling.pendingCount !== 0 || accountBilling.unresolvedCount !== 0;
  for (const button of document.querySelectorAll('[data-client-billing-write]')) button.disabled = !billingReady;
  elements['client-unresolved-more'].disabled = !billingReady || clientUnresolvedLoading;
  elements['client-ledger-more'].disabled = !billingReady || clientLedgerLoading;
  const pendingBalance = clientBillingOperations.get(`balance:${clientSelectedId}`);
  text('client-balance-pending', pendingBalance ? '上次提交结果尚未确认。再次提交将重试同一笔调整，金额与备注暂不可修改。' : '');
  for (const id of ['client-balance-amount', 'client-balance-note']) elements[id].disabled = !billingReady || Boolean(pendingBalance);
  text('client-balance-submit', pendingBalance ? '重试同一笔余额调整' : '提交余额调整');
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

function clientDecimalMicros(value, { signed = false, nonzero = false, label = '金额' } = {}) {
  const normalized = String(value).trim();
  if (!(signed ? /^-?\d+(?:\.\d{1,6})?$/ : /^\d+(?:\.\d{1,6})?$/).test(normalized)) throw new Error(`${label}需为十进制数字，最多 6 位小数。`);
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = normalized.replace(/^-/, '').split('.');
  const amount = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (negative ? -1n : 1n);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER) || nonzero && amount === 0n) throw new Error(`${label}超出范围或为零。`);
  return Number(amount);
}

function clientMoney(value, { unit = true } = {}) {
  if (!Number.isSafeInteger(value)) return '未返回';
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${absolute / 1000000n}${fraction ? `.${fraction}` : ''}${unit ? ' 元' : ''}`;
}

function clientTokenValue(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未返回'; }

function clientNonnegativeInteger(value, label, { optional = false } = {}) {
  const normalized = String(value).trim();
  if (optional && !normalized) return null;
  const number = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(number) || number < 0) throw new Error(`${label}需为非负整数。`);
  return number;
}

function clientBillingReady() { return clientAdminReady() && clientAdminData?.billing?.available === true; }

async function clientIdempotentPost(slot, path, body) {
  const signature = JSON.stringify({ path, body });
  let pending = clientBillingOperations.get(slot);
  if (pending && pending.signature !== signature) throw new Error('上次操作结果尚未确认，请先重试原操作，再填写新的调整。');
  if (!pending) {
    if (clientBillingOperations.size >= 100) throw new Error('已有 100 笔未确认操作。请先重试并核对原操作，再提交新的调整。');
    if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('当前浏览器无法生成安全操作标识，请使用本机地址或 HTTPS。');
    pending = { signature, path, body: { ...body, operationId: globalThis.crypto.randomUUID() }, uncertain: false };
    clientBillingOperations.set(slot, pending);
    if (!persistClientBillingOperations()) {
      clientBillingOperations.delete(slot);
      throw new Error('当前浏览器无法保存未确认操作，尚未发送调整。请在允许会话存储的浏览器窗口中重试。');
    }
  }
  renderClientAdminControls();
  try {
    const response = await fetch(pending.path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-CSRF': status.csrfToken }, body: JSON.stringify(pending.body), signal: AbortSignal.timeout(15000) });
    let data;
    try { data = await response.json(); }
    catch { throw new Error('服务响应不完整，结果尚未确认。请重试同一操作。'); }
    if (!response.ok) {
      if (!pending.uncertain && response.status >= 400 && response.status < 500 && response.status !== 408) { clientBillingOperations.delete(slot); persistClientBillingOperations(); }
      throw Object.assign(new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`), { status: response.status });
    }
    const confirmed = slot.startsWith('balance:') ? data?.billing?.accountId === slot.slice(8) && Number.isSafeInteger(data.billing.balanceMicros)
      : slot.startsWith('resolve:') ? data?.record?.requestId === slot.slice(8) && ['settled', 'released'].includes(data.record.status) : false;
    if (!confirmed) throw new Error('服务响应不完整，结果尚未确认。请重试同一操作。');
    clientBillingOperations.delete(slot);
    persistClientBillingOperations();
    return data;
  } catch (error) {
    if (clientBillingOperations.has(slot)) { pending.uncertain = true; error.message = `${error.message || '连接中断。'} 操作结果尚未确认，重试会复用原操作标识。`; }
    if (slot.startsWith('resolve:')) renderClientUnresolved();
    throw error;
  }
}

function renderClientAccountBilling(account) {
  const billing = account?.billing;
  const available = clientAdminData?.billing?.available === true && billing && typeof billing === 'object';
  pill('client-billing-state', available ? billing.accountingBlocked ? '计费需人工处理' : billing.enforceBalance ? '余额计费已启用' : '仅统计 Token' : '待更新后台', available && !billing.accountingBlocked ? 'success' : 'pending');
  text('client-billing-note', available ? `${billing.pendingCount || 0} 个进行中预留 · ${billing.unresolvedCount || 0} 个待核对请求。${billing.accountingBlocked ? '计费异常正在阻止新调用，请核对挂单。' : ''}充值由管理员记账，不包含线上支付。` : '余额与配额未返回。更新并重启后台后读取，当前不按零余额展示。');
  const metrics = available ? [['账户余额', clientMoney(billing.balanceMicros)], ['预留金额', clientMoney(billing.reservedMicros)], ['可用余额', clientMoney(billing.availableMicros)],
    ['本周期已用 Token', clientTokenValue(billing.usedTokens)], ['预留 Token', clientTokenValue(billing.reservedTokens)], ['剩余 Token', billing.tokenLimit === null ? '未设上限' : clientTokenValue(billing.remainingTokens)]] : [];
  elements['client-billing-metrics'].replaceChildren(...metrics.map(([label, value]) => {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value; row.append(term, detail); return row;
  }));
  elements['client-billing-enforce'].checked = available && billing.enforceBalance === true;
  elements['client-billing-token-limit'].value = available && Number.isSafeInteger(billing.tokenLimit) ? String(billing.tokenLimit) : '';
  elements['client-billing-reset-confirm'].checked = false;
  if (clientBillingRenderedId !== account?.id) {
    clientBillingRenderedId = account?.id || '';
    const pending = clientBillingOperations.get(`balance:${account?.id}`);
    elements['client-balance-amount'].value = pending ? clientMoney(pending.body.amountMicros, { unit: false }) : '';
    elements['client-balance-note'].value = pending?.body.note || '';
  }
  renderClientLedger(account);
}

function renderClientPriceFields() {
  const price = clientAdminData?.billing?.prices?.find(item => item.model === elements['client-price-model'].value);
  for (const [id, key] of [['client-price-input', 'inputRateMicros'], ['client-price-cached', 'cachedInputRateMicros'], ['client-price-output', 'outputRateMicros']]) elements[id].value = price && Number.isSafeInteger(price[key]) ? clientMoney(price[key], { unit: false }) : '';
  for (const [id, key] of [['client-price-reserve-input', 'reserveInputTokens'], ['client-price-reserve-output', 'reserveOutputTokens']]) elements[id].value = price && Number.isSafeInteger(price[key]) ? String(price[key]) : '';
  elements['client-price-enabled'].checked = price?.enabled === true;
  renderClientAdminControls();
}

function renderClientPrices() {
  const available = clientAdminData?.billing?.available === true;
  const prices = Array.isArray(clientAdminData?.billing?.prices) ? clientAdminData.billing.prices : [];
  pill('client-prices-state', available ? `${prices.filter(item => item.enabled).length} 个模型启用计费` : '待更新后台', available ? 'success' : 'pending');
  const previous = elements['client-price-model'].value;
  const models = Array.isArray(clientAdminData?.models) ? clientAdminData.models : [];
  elements['client-price-model'].replaceChildren(...models.map(model => {
    const option = document.createElement('option'); option.value = model.id;
    option.textContent = `${model.name || model.id}${prices.some(price => price.model === model.id) ? '' : ' · 价格未设置'}`; return option;
  }));
  elements['client-price-model'].value = models.some(model => model.id === previous) ? previous : models[0]?.id || '';
  renderClientPriceFields();
}

function clientLedgerLabel(entry) {
  const types = { balance_adjustment: '余额调整', account_configured: '计费与配额设置', price_updated: '模型价格更新', adjustment: '余额调整', credit: '充值', debit: '扣减', reserve: '请求预留', reserved: '请求预留', settle: '用量结算', settled: '用量结算', release: '预留释放', released: '预留释放', unresolved: '待核对', quota_reset: '配额周期重置', policy: '计费设置', resolve: '人工核销' };
  const states = { pending: '进行中', started: '调用中', reserved: '预留中', unresolved: '待核对', settled: '已结算', released: '已释放', failed: '失败', completed: '已完成' };
  const type = entry.type === 'account_configured' && entry.configuration?.resetQuota === true ? '配额周期重置' : types[entry.type] || entry.type || '账单', state = states[entry.status] || entry.status;
  return `${type}${state && state !== type ? ` · ${state}` : ''}`;
}

function renderClientLedger(account) {
  const available = clientAdminData?.billing?.available === true;
  const entries = account ? clientLedgerRows : [];
  text('client-ledger-count', !available ? '待更新后台' : clientLedgerLoading ? '正在读取…' : clientLedgerError ? '读取失败' : `${entries.length} 条${clientLedgerNextBefore ? '（有更多）' : ''}`);
  text('client-ledger-note', account ? `${account.username} · 最近账单。余额预留尚未扣费，待核对请求需查明真实用量后处理。` : '选择用户查看最近账单。');
  text('client-ledger-error', clientLedgerError); elements['client-ledger-error'].hidden = !clientLedgerError; elements['client-ledger-more'].hidden = !clientLedgerNextBefore;
  const cards = entries.map(entry => {
    const card = document.createElement('article'); card.className = 'client-ledger-entry';
    const heading = document.createElement('div'); heading.className = 'client-access-item-heading';
    const title = document.createElement('strong'); title.textContent = clientLedgerLabel(entry);
    const amount = document.createElement('span'); amount.className = 'client-ledger-amount'; amount.textContent = entry.type === 'settled' && entry.charged === false ? '仅统计 Token' : Number.isSafeInteger(entry.amountMicros) ? clientMoney(entry.amountMicros) : '—'; heading.append(title, amount); card.append(heading);
    for (const value of [entry.createdAt || entry.time ? clientTime(entry.createdAt || entry.time) : '', entry.model || '', entry.note || '',
      entry.usage ? `输入 ${clientTokenValue(entry.usage.inputTokens)} · 缓存 ${clientTokenValue(entry.usage.cachedInputTokens)} · 输出 ${clientTokenValue(entry.usage.outputTokens)} · 合计 ${clientTokenValue(entry.usage.totalTokens)} Token` : '',
      Number.isSafeInteger(entry.reservedMicros) ? `预留 ${clientMoney(entry.reservedMicros)} · ${clientTokenValue(entry.reservedTokens)} Token` : '', entry.requestId ? `请求 ${entry.requestId}` : '']) {
      if (!value) continue; const line = document.createElement('p'); line.textContent = value; card.append(line);
    }
    return card;
  });
  if (!cards.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = !available ? '计费账本需更新并重启后台后读取。' : clientLedgerLoading ? '正在读取账单…' : clientLedgerError ? '暂时无法确认账单，请刷新用户重试。' : account ? '此用户暂无账单。' : '选择用户查看账单。'; cards.push(empty); }
  elements['client-ledger-list'].replaceChildren(...cards);
}

async function refreshClientLedger({ more = false } = {}) {
  const accountId = clientSelectedId, generation = ++clientLedgerGeneration;
  if (!more) { clientLedgerRows = []; clientLedgerNextBefore = null; }
  if (clientAdminData?.billing?.available !== true || !accountId) { clientLedgerLoading = false; clientLedgerError = ''; renderClientLedger(clientAccount()); return; }
  const before = more ? clientLedgerNextBefore : null;
  if (more && !before) return;
  clientLedgerLoading = true; clientLedgerError = ''; renderClientLedger(clientAccount()); renderClientAdminControls();
  try {
    const data = await request(`${clientAccountPath(accountId)}/billing/history${before ? `?before=${encodeURIComponent(before)}` : ''}`, { signal: AbortSignal.timeout(15000) });
    if (generation !== clientLedgerGeneration || clientSelectedId !== accountId) return;
    if (!Array.isArray(data.rows) || data.rows.some(row => row?.accountId !== accountId || typeof row.id !== 'string')
      || data.nextBefore !== null && (typeof data.nextBefore !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.nextBefore))) throw new Error('账单列表返回不完整，请更新后台。');
    const seen = new Set(more ? clientLedgerRows.map(row => row.id) : []);
    clientLedgerRows = [...(more ? clientLedgerRows : []), ...data.rows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; })]; clientLedgerNextBefore = data.nextBefore;
  } catch (error) {
    if (generation === clientLedgerGeneration && clientSelectedId === accountId) clientLedgerError = `账单读取失败：${error.message || '请重试。'}`;
  } finally {
    if (generation === clientLedgerGeneration) { clientLedgerLoading = false; renderClientLedger(clientAccount()); renderClientAdminControls(); }
  }
}

function renderClientUnresolved() {
  const available = clientAdminData?.billing?.available === true;
  text('client-unresolved-count', !available ? '待更新后台' : clientUnresolvedLoading ? '正在读取…' : clientUnresolvedError ? '读取失败' : `${clientUnresolvedRows.length} 个${clientUnresolvedNextBefore ? '（有更多）' : ''}`);
  text('client-unresolved-error', clientUnresolvedError); elements['client-unresolved-error'].hidden = !clientUnresolvedError;
  elements['client-unresolved-more'].hidden = !clientUnresolvedNextBefore;
  const cards = clientUnresolvedRows.map(entry => {
    const card = document.createElement('article'); card.className = 'client-ledger-entry';
    const title = document.createElement('strong'); title.textContent = entry.model || '待核对请求'; card.append(title);
    for (const value of [entry.requestId ? `请求 ${entry.requestId}` : '', clientTime(entry.time || entry.createdAt),
      `预留 ${clientMoney(entry.reservedMicros)} · ${clientTokenValue(entry.reservedTokens)} Token`,
      entry.usage ? `已报告用量：输入 ${clientTokenValue(entry.usage.inputTokens)} · 输出 ${clientTokenValue(entry.usage.outputTokens)} Token` : '未返回可结算的完整用量。']) {
      const detail = document.createElement('p'); detail.textContent = value; card.append(detail);
    }
    if (typeof entry.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.requestId)) renderClientResolution(card, entry);
    return card;
  });
  if (!cards.length) { const empty = document.createElement('p'); empty.className = 'model-settings-empty'; empty.textContent = !available ? '待核对列表需更新并重启后台后读取。' : clientUnresolvedLoading ? '正在读取待核对请求…' : clientUnresolvedError ? '暂时无法确认待核对请求，请刷新用户重试。' : !clientAccount() ? '选择用户查看待核对请求。' : '此用户暂无待核对请求。'; cards.push(empty); }
  elements['client-unresolved-list'].replaceChildren(...cards); renderClientAdminControls();
}

async function refreshClientUnresolved({ more = false } = {}) {
  const accountId = clientSelectedId;
  const generation = ++clientUnresolvedGeneration;
  if (!more) { clientUnresolvedRows = []; clientUnresolvedNextBefore = null; }
  if (clientAdminData?.billing?.available !== true || !accountId) { clientUnresolvedLoading = false; clientUnresolvedError = ''; renderClientUnresolved(); return; }
  const before = more ? clientUnresolvedNextBefore : null;
  if (more && !before) return;
  clientUnresolvedLoading = true; clientUnresolvedError = ''; renderClientUnresolved();
  try {
    const path = `/api/client-admin/billing/unresolved?accountId=${encodeURIComponent(accountId)}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const data = await request(path, { signal: AbortSignal.timeout(15000) });
    if (generation !== clientUnresolvedGeneration || clientSelectedId !== accountId) return;
    if (!Array.isArray(data.rows) || data.rows.some(row => row?.status !== 'unresolved' || row.accountId !== accountId || typeof row.requestId !== 'string')
      || data.nextBefore !== null && (typeof data.nextBefore !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.nextBefore))) throw new Error('待核对列表返回不完整，请更新后台。');
    const seen = new Set(more ? clientUnresolvedRows.map(row => row.requestId) : []);
    clientUnresolvedRows = [...(more ? clientUnresolvedRows : []), ...data.rows.filter(row => { if (seen.has(row.requestId)) return false; seen.add(row.requestId); return true; })];
    clientUnresolvedNextBefore = data.nextBefore;
  } catch (error) {
    if (generation === clientUnresolvedGeneration && clientSelectedId === accountId) clientUnresolvedError = `待核对请求读取失败：${error.message || '请重试。'}`;
  } finally {
    if (generation === clientUnresolvedGeneration) { clientUnresolvedLoading = false; renderClientUnresolved(); }
  }
}

function renderClientResolution(card, entry) {
  const slot = `resolve:${entry.requestId}`, pending = clientBillingOperations.get(slot);
  const form = document.createElement('form'); form.className = 'client-resolution-form';
  const selectLabel = document.createElement('label'); selectLabel.className = 'client-field'; selectLabel.textContent = '核对结果';
  const select = document.createElement('select');
  for (const [value, label] of [['settle', '按核实用量结算'], ['release', '确认未产生用量，释放预留']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  select.value = pending?.body.action || 'settle'; select.disabled = Boolean(pending); selectLabel.append(select); form.append(selectLabel);
  const fields = document.createElement('div'); fields.className = 'client-resolution-fields'; const inputs = {};
  for (const [key, label] of [['inputTokens', '输入 Token'], ['cachedInputTokens', '其中缓存输入'], ['outputTokens', '输出 Token'], ['totalTokens', '合计 Token']]) {
    const field = document.createElement('label'); field.className = 'client-field'; field.textContent = label;
    const input = document.createElement('input'); input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 16; input.placeholder = '核实后的非负整数';
    input.value = pending?.body.usage && Number.isSafeInteger(pending.body.usage[key]) ? String(pending.body.usage[key]) : ''; input.disabled = Boolean(pending); field.append(input); inputs[key] = input; fields.append(field);
  }
  const update = () => { fields.hidden = select.value !== 'settle'; }; select.addEventListener('change', update); update(); form.append(fields);
  const note = document.createElement('p'); note.className = 'footnote'; note.textContent = pending ? '上次核销结果尚未确认。重试同一笔核销，继续复用原操作标识。' : '仅填写已核实的用量。释放预留不会伪造零 Token 账单。'; form.append(note);
  const confirm = document.createElement('label'); confirm.className = 'client-checkbox'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(pending); const confirmationText = document.createElement('span'); confirmationText.textContent = '已核实此请求的真实用量'; confirm.append(checkbox, confirmationText); form.append(confirm);
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'button secondary'; button.textContent = pending ? '重试同一笔核销' : '确认核销'; button.setAttribute('data-client-billing-write', ''); form.append(button);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!clientBillingReady()) return;
    void runClientAdminAction(async () => {
      if (!checkbox.checked) throw new Error('请先确认已经核实此请求的真实用量。');
      const currentPending = clientBillingOperations.get(slot);
      const body = currentPending ? { action: currentPending.body.action, ...(currentPending.body.usage ? { usage: currentPending.body.usage } : {}) } : { action: select.value };
      if (!currentPending && body.action === 'settle') {
        const usage = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, clientNonnegativeInteger(input.value, key)]));
        if (usage.cachedInputTokens > usage.inputTokens || usage.inputTokens + usage.outputTokens !== usage.totalTokens) throw new Error('缓存输入不得大于输入；合计 Token 必须等于输入加输出。'); body.usage = usage;
      }
      await clientIdempotentPost(slot, `/api/client-admin/billing/requests/${encodeURIComponent(entry.requestId)}/resolve`, body);
    });
  }); card.append(form);
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
  renderClientAccountBilling(account);
  void refreshClientLedger();
  void refreshClientUnresolved();
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
  renderClientPrices();
  renderClientInvitations(); renderClientAdminControls();
}

async function refreshClientAdmin({ clearSecret = false, replaceDraft = false } = {}) {
  if (clearSecret) clearClientSecret();
  if (clientAdminRequest) return clientAdminRequest;
  const generation = worldServiceGeneration;
  const pending = (async () => {
    try {
      const data = await request('/api/client-admin', { signal: AbortSignal.timeout(10000) });
      if (generation !== worldServiceGeneration) return;
      if (!Array.isArray(data.accounts) || !Array.isArray(data.invites)) throw new Error('用户管理返回格式不完整，请更新后台。');
      clientAdminData = data; clientAdminError = ''; clientAdminUnavailable = false; clientAdminLoaded = true;
      renderClientAdmin({ replaceDraft });
    } catch (error) {
      if (generation !== worldServiceGeneration) return;
      clientAdminLoaded = true; clientAdminUnavailable = true;
      clientAdminError = error.status === 404 || error.status === 503 ? '接入用户管理需在更新并重启后台后可用。' : `用户管理读取失败：${error.message || '请重试。'}`;
      pill('client-admin-state', error.status === 404 || error.status === 503 ? '待更新后台' : '读取失败', 'pending');
    } finally { if (clientAdminRequest === pending) clientAdminRequest = null; renderClientAdminControls(); renderWorldTree(); }
  })();
  clientAdminRequest = pending; renderClientAdminControls(); return pending;
}

async function runClientAdminAction(operation) {
  if (!clientAdminReady()) return;
  await action('client-admin', async () => {
    clientAdminError = ''; renderClientAdminControls();
    try { await operation(); await refreshClientAdmin(); text('client-admin-message', clientAdminUnavailable ? '操作已提交，列表刷新失败。请刷新核对结果。' : '已保存，用户配置已刷新。'); }
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
  renderWorldTree();
}

function codexGatewaySelected(integration) {
  if (integration?.routing?.supported === true) return integration.routing.mode === 'gateway';
  return integration?.installed === true && integration.providerId !== 'openai';
}

function codexOfficialSelected(integration) {
  if (integration?.routing?.supported === true) return integration.routing.mode === 'official';
  return integration?.providerId === 'openai';
}

// Only adapted caller-to-quota directions appear in the drawing. A standard API
// or a configured listener does not establish that a desktop app is integrated.
function bridgeTopology({ connected, gateway, integration, models, modelError, backend, codebuddy, cursor, messages, clients }) {
  const nodes = [
    { id: 'codex', name: 'Codex', copy: '调用方。已适配 Codex 客户端使用 CodeBuddy 与 Cursor 额度。其他桌面客户端调用账号 B 的方向仍待接入与验收。' },
    { id: 'claude', name: 'Claude', copy: 'Claude 客户端通过 Messages 网关调用 CLI 订阅或 CodeBuddy。CLI 保留在它的部署机器。' },
    { id: 'codebuddy', name: 'CodeBuddy', copy: '模型来源。当前由 Codex、Claude 客户端调用；CodeBuddy 客户端反向调用其他来源，尚未完成接入和完整回合验证。' },
    { id: 'workbuddy', name: 'WorkBuddy', copy: '调用方。macOS WorkBuddy 5.9.3 已通过公网用户 Key 调用隔离 Claude 的聊天和客户端文件工具验收。图中账号 B、CodeBuddy 与 Cursor 来源尚未完成桌面端验收。' },
    { id: 'cursor', name: 'Cursor', copy: '目前提供账号额度与模型。尚未适配 Cursor 客户端调用本网关，因此只显示指向 Cursor 的箭头。' },
  ];
  const pending = (reason, label = '待配置') => ({ state: 'pending', label, reason });
  const configured = reason => ({ state: 'configured', label: '入口已配置', reason });
  const modelCount = channel => Array.isArray(models) && !modelError
    ? models.filter(model => model.channel === channel && model.enabled === true && model.available !== false).length : null;
  const source = (channel, { messagesRoute = false } = {}) => {
    if (!connected) return pending('管理服务连接中断，先前状态不能作为当前连接证明。', '待确认');
    if (channel === 'CodeBuddy' && messagesRoute) {
      if (!codebuddy || codebuddy.configured !== true) return pending('CodeBuddy 渠道状态未确认。', '待确认');
      if (codebuddy.provider?.authenticated !== true) return pending('CodeBuddy 尚未完成授权。', '待授权');
      return codebuddy.provider.ready === true ? configured('CodeBuddy 已授权；使用 Messages 入口单独配置的模型范围。')
        : pending('CodeBuddy 模型渠道尚未就绪。', '待确认');
    }
    const count = modelCount(channel);
    if (count === null) return pending('模型目录状态未确认。请刷新模型目录。', '待确认');
    if (count === 0) return pending('此来源尚无已保存并可用的模型。请在模型选择中开启。', '未开放模型');
    if (channel === 'B') {
      if (!backend || backend.error) return pending('账号 B 状态未确认。', '待确认');
      if (!backend.account || !backend.pinnedAccount || !backend.account.email
        || backend.account.email !== backend.pinnedAccount.email) return pending('请登录并确认当前账号 B；当前登录必须匹配已确认的绑定。', '待授权');
      if (gateway?.enabled !== true) return pending('账号 B 网关尚未启用。');
      return configured(`账号 B 已绑定；已开放 ${count} 个模型。不包含账号 A。`);
    }
    const provider = channel === 'CodeBuddy' ? codebuddy : cursor;
    if (!provider) return pending(`${channel} 状态未返回。`, '待确认');
    if (provider.configured !== true) return pending(`${channel} 渠道尚未配置。`);
    if (provider.enabled !== true) return pending(provider.enabled === false ? `${channel} 渠道未启用。` : '后台未返回渠道启用状态，请更新服务后确认。', provider.enabled === false ? '未启用' : '待确认');
    const authenticated = channel === 'CodeBuddy' ? provider.provider?.authenticated : provider.authReady;
    if (authenticated !== true) return pending(`${channel} 尚未完成授权，或授权状态未确认。`, '待授权');
    if (channel === 'CodeBuddy' && provider.provider?.ready !== true) return pending('CodeBuddy 模型渠道尚未就绪。', '待确认');
    return configured(`${channel} 已授权；已开放 ${count} 个模型。实际权限与额度以该账号为准。`);
  };
  const ingress = client => {
    if (!connected) return pending('管理服务连接中断。', '待确认');
    if (client === 'codex') return codexGatewaySelected(integration) ? configured('本机 Codex 已选择网关路由；配置变更需重开 Codex 生效。')
      : codexOfficialSelected(integration)
        ? pending('本机 Codex 当前保存为官方直连。可在账号管理切换到 Bifröst 网关后重开 Codex。', '官方直连')
        : pending('本机 Codex 网关路由尚未确认，请到账号管理检查。', '待接入');
    if (client === 'claude') {
      const running = messages?.channels?.CodeBuddy?.running;
      return running === true ? configured('Claude Messages 入口已启动。') : pending('Claude Messages 入口尚未确认。', '待确认');
    }
    if (!clients) return pending('用户入口状态未确认，请在接入用户页检查。', '待确认');
    if (clients.server?.ready !== true) return pending(clients.server?.enabled === false ? '独立 API Key 用户入口未启用。' : '独立 API Key 用户入口尚未就绪。', '待接入');
    return configured('用户入口已就绪；客户端仍需填写 URL、Key 与获准模型。');
  };
  const specs = [
    ['codex', 'codebuddy', 'CodeBuddy', 'Responses', 'world-route-codex-codebuddy'],
    ['codebuddy', 'codex', 'B', 'Chat Completions / Responses', 'world-route-codex-codebuddy'],
    ['codex', 'cursor', 'Cursor', 'Responses', 'world-route-codex-cursor'],
    ['claude', 'codebuddy', 'CodeBuddy', 'Messages', 'world-route-claude-codebuddy'],
    ['workbuddy', 'codex', 'B', 'Chat Completions / Responses', 'world-route-workbuddy-codex'],
    ['workbuddy', 'codebuddy', 'CodeBuddy', 'Chat Completions / Responses', 'world-route-workbuddy-codebuddy'],
    ['workbuddy', 'cursor', 'Cursor', 'Chat Completions / Responses', 'world-route-workbuddy-cursor'],
    ['codebuddy', 'cursor', 'Cursor', 'Chat Completions / Responses', 'world-route-codebuddy-cursor'],
  ];
  const routes = specs.map(([from, to, channel, protocol, path]) => {
    const entry = ingress(from), target = source(channel, { messagesRoute: from === 'claude' });
    const readiness = entry.state !== 'configured' ? entry : target;
    const maturity = ['codex', 'claude'].includes(from) ? 'adapted' : 'client_pending';
    return { from, to, protocol, path, sourceName: channel === 'B' ? 'Codex 账号 B' : `${channel} 额度`, maturity, ...readiness,
      ...(maturity === 'client_pending' ? { state: 'pending', label: '客户端待接入' } : {}),
      reason: `${maturity === 'client_pending' ? '仅通用 API 已实现；尚未完成桌面客户端接入与完整回合验证。 ' : ''}${entry.reason} ${target.reason}${['workbuddy', 'codebuddy'].includes(from) ? ' 每个用户只能调用其 Key 获准的模型。' : ''}` };
  });
  const local = [
    { from: 'codex', to: 'codex', name: '原模型 A / B', protocol: 'Responses',
      ...(connected && codexGatewaySelected(integration) ? configured('原模型 A 随 Codex 请求携带认证；B 需要独立绑定与模型授权。A 不通过公共用户 Key 开放。')
        : connected && codexOfficialSelected(integration)
          ? pending('本机 Codex 已保存官方直连配置。账号 B 需切回网关模式后使用。', '官方直连')
          : pending('原模型接入状态未确认。', '待确认')) },
    { from: 'claude', to: 'claude', name: 'Claude 原订阅', protocol: 'Messages / CLI',
      ...(connected && messages?.channels?.Claude?.running === true ? configured('CLI 订阅入口已启动；此状态未验证 CLI 登录、模型权限或真实推理。') : pending('CLI 订阅入口尚未确认。', '待确认')) },
    { from: 'codebuddy', to: 'codebuddy', name: 'CodeBuddy 自有额度', protocol: '客户端原生 / 网关',
      ...source('CodeBuddy') },
  ];
  return { nodes, routes, local };
}

function renderWorldTree() {
  if (!byId('world-canvas')) return;
  const topology = bridgeTopology({ connected: managementConnected && !managementStatusError && !restartInProgress,
    gateway: status?.gateway, integration: status?.integration, backend: status?.backend,
    models: modelSettings?.models, modelError: modelSettingsError || modelSettingsUnavailable || !modelSettingsLoaded,
    codebuddy: codeBuddyReadError || worldProviderGeneration.codebuddy !== worldServiceGeneration ? null : codeBuddyStatus,
    cursor: cursorReadError || worldProviderGeneration.cursor !== worldServiceGeneration ? null : cursorStatus,
    messages: messagesStatus, clients: clientAdminUnavailable ? null : clientAdminData });
  const signature = JSON.stringify([worldSelection, topology]);
  if (signature === worldRenderSignature) return;
  worldRenderSignature = signature;
  const selected = topology.nodes.find(node => node.id === worldSelection);
  const adaptedRoutes = topology.routes.filter(route => route.maturity === 'adapted');
  const selectedRoutes = adaptedRoutes.filter(route => !selected || route.from === selected.id || route.to === selected.id);
  const pendingRoutes = topology.routes.filter(route => route.maturity === 'client_pending'
    && (!selected || route.from === selected.id || route.to === selected.id));
  const related = new Set(selectedRoutes.flatMap(route => [route.from, route.to]));
  byId('world-canvas').setAttribute('data-selection', worldSelection);
  for (const node of topology.nodes) {
    const button = byId(`world-node-${node.id}`);
    button.setAttribute('aria-pressed', String(node.id === worldSelection));
    button.setAttribute('class', `world-node node-${node.id}${selected && !related.has(node.id) && node.id !== selected.id ? ' node-muted' : ''}`);
    const relevant = [...adaptedRoutes, ...topology.local].filter(route => route.from === node.id || route.to === node.id);
    const count = relevant.filter(route => route.state === 'configured').length;
    byId(`world-indicator-${node.id}`).setAttribute('data-state', relevant.length && count === relevant.length ? 'configured' : count ? 'partial' : 'pending');
  }
  for (const path of new Set(topology.routes.map(route => route.path))) {
    const directions = adaptedRoutes.filter(route => route.path === path);
    const count = directions.filter(route => route.state === 'configured').length;
    byId(path).setAttribute('data-stage', directions.length ? 'adapted' : 'client_pending');
    byId(path).setAttribute('marker-start', 'none');
    byId(path).setAttribute('marker-end', directions.length ? 'url(#route-arrow)' : 'none');
    byId(path).setAttribute('data-state', directions.length && count === directions.length ? 'configured' : count ? 'partial' : 'pending');
    byId(path).setAttribute('data-highlight', selected ? String(directions.some(route => route.from === selected.id || route.to === selected.id)) : 'all');
  }
  byId('world-detail-eyebrow').textContent = selected ? 'EXPLORE / CONNECTION DETAILS' : 'EXPLORE THE CONNECTIONS';
  byId('world-detail-title').textContent = selected ? selected.name : '调用方 → 模型来源';
  byId('world-detail-copy').textContent = selected ? selected.copy : '例如：Codex 客户端使用 CodeBuddy 额度。反向桌面接入未完成，不表示双向可用。';
  byId('world-node-count').textContent = String(topology.nodes.length);
  byId('world-route-count').textContent = String(adaptedRoutes.length);
  byId('world-ready-count').textContent = String(adaptedRoutes.filter(route => route.state === 'configured').length);
  byId('world-connection-note').textContent = !managementConnected ? '当前连接未确认。可查看适配关系；恢复连接后更新状态。'
    : selected?.id === 'cursor' ? 'Cursor 当前只提供额度，不接收来自本网关的客户端配置。'
      : '主图仅显示已适配方向。API 入口就绪，不代表桌面客户端已接入。';
  const rows = items => items.map(route => {
    const row = document.createElement('div'); row.className = 'world-route-row'; row.setAttribute('data-state', route.state);
    const heading = document.createElement('div'); heading.className = 'world-route-heading';
    const title = document.createElement('strong'), state = document.createElement('span'), copy = document.createElement('p');
    const name = id => topology.nodes.find(node => node.id === id).name;
    title.textContent = route.name || `${name(route.from)} 客户端 → ${route.sourceName}`;
    state.textContent = route.label; copy.textContent = `${route.protocol} · ${route.reason}`;
    heading.append(title, state); row.append(heading, copy); return row;
  });
  byId('world-route-list').replaceChildren(...rows([...selectedRoutes, ...topology.local.filter(route => selected && route.from === selected.id)]));
  byId('world-pending-list')?.replaceChildren(...rows(pendingRoutes));
  const pendingDetails = byId('world-pending-details');
  if (byId('world-pending-count')) byId('world-pending-count').textContent = String(pendingRoutes.length);
  if (pendingDetails) {
    pendingDetails.hidden = pendingRoutes.length === 0;
    pendingDetails.open = Boolean(selected && selectedRoutes.length === 0 && pendingRoutes.length);
  }
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
      serviceStatus = await request('/api/service/status', { signal: AbortSignal.timeout(SERVICE_STATUS_TIMEOUT_MS) });
      serviceUnavailable = false; serviceError = '';
      if (restartConfirmation && Number.isSafeInteger(serviceStatus.activeRequests) && serviceStatus.activeRequests >= 0) restartActiveRequests = serviceStatus.activeRequests;
    } catch (error) {
      serviceUnavailable = error.status === 404;
      serviceError = serviceUnavailable ? '' : ['TimeoutError', 'AbortError'].includes(error.name)
        ? '服务状态查询超时，请稍后重试。' : error.message || '暂时无法读取服务状态。';
    } finally { serviceRequest = null; renderServiceControl(); }
  })();
  return serviceRequest;
}

const contextTokenCount = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const contextTokenLabel = value => value % 1_000_000 === 0 ? `${value / 1_000_000}M`
  : value % 1000 === 0 ? `${value / 1000}K` : value.toLocaleString('zh-CN');
function modelContextSettings(model) {
  const value = model.contextSettings;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !contextTokenCount(value.minimumTokens) || !contextTokenCount(value.maximumTokens)
    || value.minimumTokens > value.maximumTokens
    || ![null, undefined].includes(value.defaultTokens) && !contextTokenCount(value.defaultTokens)
    || ![null, undefined].includes(value.maxTokens) && !contextTokenCount(value.maxTokens)
    || ![null, undefined].includes(value.selectedTokens) && !contextTokenCount(value.selectedTokens)
    || !Array.isArray(value.options) || value.options.length > 64 || value.options.some(token => !contextTokenCount(token))) return null;
  return value;
}
function savedModelContextDraft(model) {
  const context = modelContextSettings(model), tokens = context?.selectedTokens ?? null;
  return { selection: tokens === null ? '' : context.options.includes(tokens) ? String(tokens) : 'custom',
    customValue: tokens === null ? '' : String(tokens) };
}
function modelContextDraftValue(model) {
  const context = modelContextSettings(model);
  if (!context) return { value: null, error: '' };
  const draft = modelContextDraft.get(model.id) ?? savedModelContextDraft(model);
  if (draft.selection === '') return { value: null, error: '' };
  const raw = draft.selection === 'custom' ? draft.customValue.trim() : draft.selection;
  const tokens = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const maximum = Math.min(context.maxTokens ?? context.maximumTokens, context.maximumTokens);
  if (!Number.isSafeInteger(tokens) || tokens < context.minimumTokens || tokens > maximum) {
    return { value: null, error: `请输入 ${context.minimumTokens.toLocaleString('zh-CN')}–${maximum.toLocaleString('zh-CN')} 之间的整数 Token。` };
  }
  if (draft.selection === 'custom' ? context.customAllowed !== true : !context.options.includes(tokens)) {
    return { value: null, error: '当前模型不支持此上下文选项，请重新选择。' };
  }
  return { value: tokens, error: '' };
}
function modelContextDirty(model) {
  if (!modelContextSettings(model)) return false;
  const saved = model.contextSettings.selectedTokens ?? null;
  const draft = modelContextDraft.get(model.id) ?? savedModelContextDraft(model);
  const raw = draft.selection === 'custom' ? draft.customValue.trim() : draft.selection;
  if (draft.selection === '' && saved === null || /^\d+$/.test(raw) && Number(raw) === saved) return false;
  const parsed = modelContextDraftValue(model);
  return Boolean(parsed.error) || parsed.value !== saved;
}
function resetModelContextDraft() {
  modelContextDraft = new Map((modelSettings?.models ?? []).filter(model => modelContextSettings(model))
    .map(model => [model.id, savedModelContextDraft(model)]));
}
function validateModelSettingsSnapshot(data) {
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.models)
    || data.models.some(model => typeof model?.id !== 'string' || typeof model.enabled !== 'boolean'
      || model.available !== undefined && typeof model.available !== 'boolean' || model.reason !== undefined && typeof model.reason !== 'string')
    || data.disabledModels !== undefined && (!Array.isArray(data.disabledModels) || data.disabledModels.some(id => typeof id !== 'string'))) {
    throw new Error('服务返回的模型列表格式无效。');
  }
  return data;
}
function captureModelSettingsChanges() {
  const checkboxes = new Map(), contexts = new Map(), originals = new Map();
  for (const model of modelSettings.models) {
    originals.set(model.id, model);
    if (modelDraft.get(model.id) !== model.enabled) checkboxes.set(model.id, { from: model.enabled, to: modelDraft.get(model.id) === true });
    if (modelContextDirty(model)) {
      const parsed = modelContextDraftValue(model);
      if (parsed.error) throw new Error(`${model.name || model.id}：${parsed.error}`);
      contexts.set(model.id, { from: model.contextSettings.selectedTokens ?? null, to: parsed.value,
        draft: { ...(modelContextDraft.get(model.id) ?? savedModelContextDraft(model)) } });
    }
  }
  return { checkboxes, contexts, originals };
}
function adoptModelSettingsSnapshot(data, changes = null) {
  const known = new Set(data.models.map(model => model.id));
  const missing = changes ? [...new Set([...changes.checkboxes.keys(), ...changes.contexts.keys()])].filter(id => !known.has(id)) : [];
  modelSettings = { ...data, models: [...data.models, ...missing.map(id => ({ ...changes.originals.get(id), available: false,
    reason: '当前目录已移除此模型，未保存的设置仍保留；请刷新目录后重试。' }))] };
  modelCatalogModels = data.models;
  modelDraft = new Map(modelSettings.models.map(model => [model.id, model.enabled]));
  resetModelContextDraft();
  if (changes) {
    for (const [id, change] of changes.checkboxes) modelDraft.set(id, change.to);
    for (const [id, change] of changes.contexts) {
      const model = modelSettings.models.find(model => model.id === id), context = model && modelContextSettings(model);
      if (!context) continue;
      const draft = { ...change.draft };
      if (draft.selection !== '' && draft.selection !== 'custom' && !context.options.includes(change.to)) {
        draft.selection = 'custom'; draft.customValue = String(change.to);
      }
      modelContextDraft.set(id, draft);
    }
  }
  renderModelSettingsList();
}
function modelSettingField(snapshot, id, kind) {
  const model = Array.isArray(snapshot?.models) ? snapshot.models.find(model => model?.id === id) : null;
  let rowKnown, rowValue, rootKnown = false, rootValue;
  if (kind === 'context') {
    const settings = model?.contextSettings;
    rowKnown = settings && Object.hasOwn(settings, 'selectedTokens')
      && (settings.selectedTokens === null || contextTokenCount(settings.selectedTokens));
    rowValue = settings?.selectedTokens;
    const windows = snapshot?.contextWindows;
    if (windows && typeof windows === 'object' && !Array.isArray(windows)) {
      rootValue = Object.hasOwn(windows, id) ? windows[id] : null;
      rootKnown = rootValue === null || contextTokenCount(rootValue);
    }
  } else {
    rowKnown = typeof model?.enabled === 'boolean'; rowValue = model?.enabled;
    if (Array.isArray(snapshot?.disabledModels) && snapshot.disabledModels.every(value => typeof value === 'string')) {
      rootKnown = true; rootValue = !snapshot.disabledModels.includes(id);
    }
  }
  return { known: Boolean(rowKnown || rootKnown), consistent: !(rowKnown && rootKnown && rowValue !== rootValue),
    value: rowKnown ? rowValue : rootValue };
}
function modelSettingsConfirmed(snapshot, changes) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.available === false) return false;
  return [...changes.checkboxes].every(([id, change]) => {
    const field = modelSettingField(snapshot, id, 'checkbox'); return field.known && field.consistent && field.value === change.to;
  }) && [...changes.contexts].every(([id, change]) => {
    const field = modelSettingField(snapshot, id, 'context'); return field.known && field.consistent && field.value === change.to;
  });
}
function rememberModelSettingsConfirmation(snapshot, changes) {
  const previous = modelSettingsConfirmation?.changes;
  const checks = { checkboxes: new Map(), contexts: new Map() };
  for (const [kind, field] of [['checkboxes', 'checkbox'], ['contexts', 'context']]) {
    for (const id of new Set([...(previous?.[kind]?.keys() ?? []), ...changes[kind].keys()])) {
      const current = modelSettingField(snapshot, id, field);
      if (current.known && current.consistent) checks[kind].set(id, { to: current.value });
    }
  }
  modelSettingsRevisionFloor = Math.max(modelSettingsRevisionFloor, snapshot.revision);
  modelSettingsConfirmation = { revision: snapshot.revision, changes: checks };
}
function acceptModelSettingsRevision(data) {
  if (data.revision < modelSettingsRevisionFloor) throw new Error('目录回读仍为较旧版本，已保留当前设置，请稍后刷新。');
  const confirmed = modelSettingsConfirmation;
  if (confirmed) {
    const fields = [...confirmed.changes.checkboxes.keys()].map(id => modelSettingField(data, id, 'checkbox'))
      .concat([...confirmed.changes.contexts.keys()].map(id => modelSettingField(data, id, 'context')));
    if (fields.some(field => !field.known || !field.consistent) || data.revision === confirmed.revision && !modelSettingsConfirmed(data, confirmed.changes)) {
      throw new Error('目录回读与已确认设置不一致，已保留确认值，请稍后刷新。');
    }
    if (data.revision > confirmed.revision) rememberModelSettingsConfirmation(data, confirmed.changes);
  }
  modelSettingsRevisionFloor = Math.max(modelSettingsRevisionFloor, data.revision);
}
function modelSettingsMergeConflict(snapshot, changes) {
  const rows = new Map(snapshot.models.map(model => [model.id, model]));
  for (const [id, change] of changes.checkboxes) {
    const model = rows.get(id), field = modelSettingField(snapshot, id, 'checkbox');
    if (!model || !field.known || !field.consistent || field.value !== change.from && field.value !== change.to
      || change.to && model.available === false) return `${model?.name || id} 的模型开关或可用状态已变化。`;
  }
  for (const [id, change] of changes.contexts) {
    const model = rows.get(id), field = modelSettingField(snapshot, id, 'context'), settings = model && modelContextSettings(model);
    if (!model || !settings || !field.known || !field.consistent) return `${model?.name || id} 的上下文配置暂时无法核对。`;
    if (field.value !== change.from && field.value !== change.to) return `${model.name || id} 的上下文已由其他页面修改。`;
    if (change.to !== null && (change.to < settings.minimumTokens || change.to > Math.min(settings.maxTokens ?? settings.maximumTokens, settings.maximumTokens)
      || settings.customAllowed !== true && !settings.options.includes(change.to) || model.available === false)) {
      return `${model.name || id} 当前不能使用所选上下文预算。`;
    }
  }
  return '';
}
function modelSettingsPayload(snapshot, changes) {
  const disabled = new Set(snapshot.disabledModels ?? snapshot.models.filter(model => !model.enabled).map(model => model.id));
  for (const [id, change] of changes.checkboxes) {
    if (change.to) disabled.delete(id); else disabled.add(id);
  }
  const windows = Object.fromEntries([...changes.contexts].filter(([id, change]) => {
    const field = modelSettingField(snapshot, id, 'context');
    return !field.known || !field.consistent || field.value !== change.to;
  }).map(([id, change]) => [id, change.to]));
  const visible = new Set(snapshot.models.map(model => model.id));
  const disabledModels = [...[...disabled].filter(id => !visible.has(id)), ...snapshot.models.filter(model => disabled.has(model.id)).map(model => model.id)];
  return { revision: snapshot.revision, disabledModels, ...(Object.keys(windows).length ? { contextWindows: windows } : {}) };
}
function confirmedModelSettingsSnapshot(base, acknowledgement) {
  const rows = new Map((Array.isArray(acknowledgement.models) ? acknowledgement.models : []).map(model => [model.id, model]));
  return { ...base, revision: acknowledgement.revision,
    ...(Array.isArray(acknowledgement.disabledModels) ? { disabledModels: acknowledgement.disabledModels } : {}),
    ...(acknowledgement.contextWindows && typeof acknowledgement.contextWindows === 'object' && !Array.isArray(acknowledgement.contextWindows)
      ? { contextWindows: acknowledgement.contextWindows } : {}),
    models: base.models.map(model => {
      const checkbox = modelSettingField(acknowledgement, model.id, 'checkbox'), context = modelSettingField(acknowledgement, model.id, 'context');
      return { ...model, ...(checkbox.known && checkbox.consistent ? { enabled: checkbox.value } : {}),
        ...(model.contextSettings && context.known && context.consistent ? { contextSettings: { ...model.contextSettings,
          ...rows.get(model.id)?.contextSettings, selectedTokens: context.value,
          effectiveTokens: context.value ?? model.contextSettings.defaultTokens } } : {}) };
    }) };
}
function modelSettingsDirty() {
  return modelSettings?.models.some(model => modelDraft.get(model.id) !== model.enabled || modelContextDirty(model)) === true;
}

function completeModelDiscoverySupported() {
  return modelSettings?.discovery !== null && typeof modelSettings?.discovery === 'object' && !Array.isArray(modelSettings.discovery);
}

const modelChannel = model => model.channel === 'CursorTeams' ? 'Cursor' : model.channel || '其他渠道';
const modelChannelLabels = { A: '账号 A', B: '账号 B', CodeBuddy: 'CodeBuddy', Cursor: 'Cursor Teams' };
const modelSourceKey = model => typeof model.sourceAccountId === 'string' && model.sourceAccountId
  ? `account:${model.sourceAccountId}` : `channel:${modelChannel(model)}`;
const modelSourceName = model => typeof model.sourceAccountName === 'string' && model.sourceAccountName.trim()
  ? model.sourceAccountName : modelChannelLabels[modelChannel(model)] || modelChannel(model);
function modelSettingsEditable() {
  return managementConnected && !busyAction && !restartInProgress && !modelSettingsUnavailable && !modelSettingsError && modelSettings !== null;
}
function filteredModels() {
  const query = elements['model-settings-search'].value.trim().toLocaleLowerCase();
  return (modelSettings?.models ?? []).filter(model => !query || [model.id, model.name, modelChannel(model),
    modelChannelLabels[modelChannel(model)], modelSourceName(model), model.reason].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)));
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
  const invalidContext = (modelSettings?.models ?? []).some(model => modelContextDirty(model) && modelContextDraftValue(model).error);
  elements['model-settings-save-button'].disabled = !available || !dirty || invalidContext;
  elements['model-settings-reset-button'].disabled = !available || !dirty;
  elements['model-settings-refresh-button'].disabled = !managementConnected || Boolean(busyAction) || restartInProgress || Boolean(modelSettingsRequest);
  text('model-settings-save-button', busyAction === 'model-settings-save' ? '正在保存…' : '保存模型设置');
  text('model-settings-refresh-button', modelSettingsRequest ? '正在刷新目录…' : '刷新账号目录');
  elements['model-settings-search'].disabled = !modelSettings || restartInProgress;
  const byModelId = new Map((modelSettings?.models ?? []).map(model => [model.id, model]));
  elements['model-settings-list'].querySelectorAll('input[data-model-choice]').forEach(input => { input.disabled = !available || byModelId.get(input.value)?.available === false; });
  for (const control of modelContextControls) {
    const model = byModelId.get(control.model.id), draft = modelContextDraft.get(control.model.id) ?? savedModelContextDraft(control.model);
    const disabled = !available || model?.available === false;
    control.select.disabled = disabled;
    control.custom.hidden = draft.selection !== 'custom';
    control.custom.disabled = disabled || draft.selection !== 'custom' || control.model.contextSettings.customAllowed !== true;
    const error = modelContextDraftValue(control.model).error;
    control.custom.setAttribute('aria-invalid', draft.selection === 'custom' && error ? 'true' : 'false');
    control.error.textContent = error || '';
    control.error.hidden = !error;
  }
  for (const { button, ids, enabled } of modelGroupActions) {
    button.disabled = !available || !ids.some(id => modelDraft.get(id) !== enabled);
  }
  for (const { count, models, matches } of modelGroupViews) {
    const selectable = models.filter(model => model.available !== false);
    const selected = selectable.filter(model => modelDraft.get(model.id) === true).length;
    count.textContent = `已勾选 ${selected} / 可用 ${selectable.length} · 共 ${models.length} 项${matches === null ? '' : ` · 匹配 ${matches} 项`}`;
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

function modelContextFields(model) {
  const context = modelContextSettings(model);
  if (!context) return null;
  const draft = modelContextDraft.get(model.id) ?? savedModelContextDraft(model);
  const row = document.createElement('div'); row.className = 'model-context'; row.setAttribute('data-model-context', model.id);
  const label = document.createElement('label'); label.textContent = '上下文';
  const select = document.createElement('select'); select.id = `model-context-choice-${modelContextControls.length}`;
  label.setAttribute('for', select.id); select.setAttribute('aria-label', `${model.name || model.id}：上下文`);
  const maximum = Math.min(context.maxTokens ?? context.maximumTokens, context.maximumTokens);
  const choices = [...new Set(context.options)].filter(value => value >= context.minimumTokens && value <= maximum).sort((a, b) => a - b);
  const options = [new Option(`跟随模型默认${context.defaultTokens ? `（${contextTokenLabel(context.defaultTokens)}）` : ''}`, ''),
    ...choices.map(tokens => new Option(contextTokenLabel(tokens), String(tokens)))];
  if (/^\d+$/.test(draft.selection) && contextTokenCount(Number(draft.selection)) && !choices.includes(Number(draft.selection))) {
    const previous = new Option(`${contextTokenLabel(Number(draft.selection))}（当前不可用）`, draft.selection);
    previous.disabled = true; options.push(previous);
  }
  if (context.customAllowed === true || draft.selection === 'custom') options.push(new Option('自定义', 'custom'));
  select.replaceChildren(...options); select.value = draft.selection;
  const custom = document.createElement('input'); custom.type = 'number'; custom.min = String(context.minimumTokens);
  custom.max = String(maximum); custom.step = '1'; custom.inputMode = 'numeric'; custom.autocomplete = 'off';
  custom.placeholder = 'Token 数'; custom.value = draft.customValue;
  custom.setAttribute('aria-label', `${model.name || model.id}：自定义上下文 Token 数`);
  const note = document.createElement('small'); note.className = 'model-context-note';
  const effective = contextTokenCount(context.effectiveTokens) ? context.effectiveTokens : context.defaultTokens;
  const source = `${context.defaultTokens ? `目录默认 ${contextTokenLabel(context.defaultTokens)}` : '默认窗口未知'} · ${effective
    ? `已保存预算 ${contextTokenLabel(effective)}${context.selectedTokens === null ? '（跟随默认）' : ''}` : '尚未取得当前预算'} · ${context.maxTokens
    ? `上游声明上限 ${contextTokenLabel(context.maxTokens)}` : '上游未声明上限，自定义值仅作为客户端预算'}`;
  note.textContent = source + (context.valid === false && typeof context.note === 'string' && context.note ? ` · ${context.note}` : '');
  const error = document.createElement('small'); error.className = 'model-context-error'; error.setAttribute('role', 'status');
  error.id = `model-context-error-${modelContextControls.length}`;
  select.setAttribute('aria-describedby', error.id); custom.setAttribute('aria-describedby', error.id);
  const change = () => {
    if (!modelSettingsEditable() || model.available === false || select.disabled) return;
    modelContextDraft.set(model.id, { selection: select.value, customValue: custom.value });
    renderModelSettingsControls();
  };
  select.addEventListener('change', () => {
    if (select.value === 'custom' && !custom.value) {
      const tokens = context.effectiveTokens ?? context.defaultTokens;
      if (contextTokenCount(tokens)) custom.value = String(tokens);
    }
    change();
  });
  custom.addEventListener('input', change);
  row.append(label, select, custom, note, error);
  modelContextControls.push({ model, select, custom, error });
  return row;
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
  if (model.sourceAccountId) appendField('额度来源', modelSourceName(model));
  if (typeof model.sourceCredential?.label === 'string') appendField('授权方式', model.sourceCredential.label);
  const support = value => value?.adapterSupport === true ? '适配器已支持，模型待实测'
    : value?.source === 'response-usage' ? '按响应计量'
    : value?.support === true ? '支持' : value?.support === false ? '不支持' : '目录未声明';
  for (const [key, label] of [['images', '图片'], ['tools', '客户端工具'], ['reasoning', '思考'], ['cache', '缓存']]) {
    const value = capabilities?.[key];
    const efforts = key === 'reasoning' && Array.isArray(value?.efforts) ? value.efforts.filter(effort => typeof effort === 'string').join('、') : '';
    const observed = verification?.state === 'passed' && verification.observed?.[key] === true;
    const note = observed ? key === 'cache' ? '真实响应用量中包含缓存读取 Token；后续请求是否命中仍以实际响应为准。'
      : key === 'tools' ? '已收到客户端工具结果并正常结束，工具由客户端执行。' : '已记录当前账号含图片请求正常完成，识别效果取决于具体任务。' : value?.note;
    appendField(label, `${observed ? key === 'cache' ? '已观察到缓存命中' : key === 'tools' ? '已记录工具回传后的完整调用' : '已记录含图片的成功调用' : support(value)}${efforts ? `（${efforts}）` : ''}${typeof note === 'string' && note ? ` · ${note}` : ''}`);
  }
  const context = capabilities?.contextWindow;
  appendField('上下文', `${Number.isSafeInteger(context?.tokens) && context.tokens > 0 ? `目录默认 ${context.tokens.toLocaleString('zh-CN')} Token${context.source === 'official-cli-runtime' ? '（官方 CLI 当前上限）' : ''}` : '未取得当前模型上限'}${context?.note ? ` · ${context.note}` : ''}`);
  const settings = modelContextSettings(model);
  if (settings) appendField('客户端预算', contextTokenCount(settings.effectiveTokens)
    ? `${settings.effectiveTokens.toLocaleString('zh-CN')} Token（已保存${settings.selectedTokens === null ? '，跟随模型默认' : ''}）${settings.valid === false ? ' · 保存值已失效，当前采用默认预算。' : ''}`
    : '尚未取得当前预算');
  appendField('指令处理', model.compatibility?.label || '尚未取得接入方式');
  if (typeof model.compatibility?.note === 'string') appendField('兼容说明', model.compatibility.note);
  const conversation = model.compatibility?.conversation;
  if (conversation?.version === 1 && conversation.states) {
    const labels = { supported: '支持', conditional: '有条件', unsupported: '不支持', unknown: '未确认' };
    const operations = [['continue', '续聊'], ['fork', '分叉'], ['switch-model', '换模型'],
      ['switch-source', '换来源'], ['restart-recovery', '重启恢复']];
    for (const [state, label] of [['plain-history', '完整明文历史'], ['authenticated-snapshot', '加密历史快照'],
      ['completed-checkpoint', '已完成检查点'], ['live-execution', '执行中的工具回合']]) {
      const row = conversation.states[state];
      if (row) appendField(label, operations.map(([operation, name]) => `${name}：${labels[row[operation]?.status] || '未确认'}`).join('；'));
    }
    appendField('会话条件', '“有条件”需要完整历史、工具回传及来源校验。检查点与正在执行的回调分别处理；来源密文不能直接交给其他模型解码。');
  }
  appendField('调用验证', verificationLabel);
  if (verification?.checkedAt) appendField('验证时间', `${tokenTime(verification.checkedAt, 'Asia/Shanghai')}（北京时间）`);
  if (typeof verification?.reason === 'string' && verification.reason) appendField('验证说明', verification.reason);
  const note = document.createElement('p'); note.className = 'footnote';
  note.textContent = capabilities ? '目录能力与实际调用验证分别展示；一次调用完成不代表图片、工具和缓存均已验证。刷新账号目录可更新调用验证状态。'
    : '当前后台未提供模型能力信息；更新并重启网关后查看，未知能力不会标成支持。';
  details.append(summary, fields, note);
  return details;
}

function renderModelSettingsList() {
  // Capture native disclosure state before replacing rows; toggle events can be queued.
  for (const view of modelGroupViews) {
    if (!view.searching) modelGroupExpanded.set(view.key, view.group.open);
  }
  const searching = elements['model-settings-search'].value.trim() !== '';
  const groups = new Map();
  for (const model of filteredModels()) {
    const key = modelSourceKey(model);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  modelGroupActions = [];
  modelContextControls = [];
  modelGroupViews = [];
  const nodes = [];
  for (const [key, models] of groups) {
    const channel = modelChannel(models[0]), sourceName = modelSourceName(models[0]);
    const group = document.createElement('details'); group.className = 'model-settings-group';
    group.setAttribute('data-model-channel', channel);
    if (models[0].sourceAccountId) group.setAttribute('data-source-account-id', models[0].sourceAccountId);
    group.open = searching || modelGroupExpanded.get(key) === true;
    const summary = document.createElement('summary'); summary.className = 'model-group-summary';
    const name = document.createElement('strong'); name.textContent = sourceName;
    const count = document.createElement('small'); count.className = 'model-group-count';
    summary.append(name, count);
    const view = { key, channel, group, count, searching, matches: searching ? models.length : null,
      models: modelSettings.models.filter(model => modelSourceKey(model) === key) };
    modelGroupViews.push(view);
    group.addEventListener('toggle', () => {
      if (!view.searching && modelGroupViews.includes(view)) modelGroupExpanded.set(key, group.open);
    });
    const content = document.createElement('div'); content.className = 'model-group-content';
    group.append(summary, content);
    const actions = document.createElement('div'); actions.className = 'model-group-actions';
    const selectable = models.filter(model => model.available !== false).map(model => model.id);
    for (const [enabled, title] of [[true, '全选可用项'], [false, '全关可用项']]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet small';
      button.textContent = title; button.setAttribute('aria-label', `${sourceName}：${title}（当前搜索结果）`);
      button.addEventListener('click', () => {
        if (!modelSettingsEditable() || button.disabled) return;
        for (const id of selectable) modelDraft.set(id, enabled);
        renderModelSettingsList();
        text('model-settings-message', '批量选择仅作用于本账号当前搜索结果中的可用模型；点击保存后生效。');
      });
      actions.append(button); modelGroupActions.push({ button, ids: selectable, enabled });
    }
    content.append(actions);
    for (const model of models) {
      const label = document.createElement('label'); label.className = 'model-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = model.id; checkbox.checked = modelDraft.get(model.id) === true;
      checkbox.setAttribute('data-model-choice', model.id);
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
      label.append(checkbox, details); content.append(label);
      const context = modelContextFields(model);
      if (context) content.append(context);
      content.append(modelEvidenceDetails(model));
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

async function refreshModelSettings({ replaceDraft = false, rebaseChanges = null } = {}) {
  if (modelSettingsRequest) return modelSettingsRequest;
  const generation = modelSettingsGeneration;
  const pending = (async () => {
    try {
      const data = validateModelSettingsSnapshot(await request('/api/model-settings', { signal: AbortSignal.timeout(15000) }));
      if (generation !== modelSettingsGeneration) return;
      acceptModelSettingsRevision(data);
      modelSettingsLoaded = true;
      modelCatalogModels = data.models;
      modelSettingsUnavailable = false; modelSettingsError = typeof data.error === 'string' ? data.error : data.error?.message || '';
      const changed = !modelSettings || JSON.stringify(data) !== JSON.stringify(modelSettings);
      if (rebaseChanges) {
        adoptModelSettingsSnapshot(data, rebaseChanges);
      } else if (replaceDraft || !modelSettingsDirty()) {
        modelSettings = data;
        if (changed || replaceDraft) {
          modelDraft = new Map(data.models.map(model => [model.id, model.enabled])); resetModelContextDraft(); renderModelSettingsList();
        }
      } else if (changed) {
        const previous = modelSettings, prior = new Map(previous.models.map(model => [model.id, model]));
        modelSettings = { ...data, revision: previous.revision, contextWindows: previous.contextWindows,
          models: data.models.map(model => ({ ...model, enabled: prior.get(model.id)?.enabled ?? model.enabled,
            ...(modelContextSettings(model) && modelContextSettings(prior.get(model.id) ?? {}) ? {
              contextSettings: { ...model.contextSettings, selectedTokens: prior.get(model.id).contextSettings.selectedTokens ?? null },
            } : {}) })) };
        // A newly unavailable model cannot retain an unsaved enable request.
        // Already saved selections remain intact until the user changes them.
        modelDraft = new Map(data.models.map(model => [model.id, model.available === false && !model.enabled
          ? false : modelDraft.has(model.id) ? modelDraft.get(model.id) : model.enabled]));
        modelContextDraft = new Map(data.models.filter(model => modelContextSettings(model))
          .map(model => [model.id, modelContextDraft.get(model.id) ?? savedModelContextDraft(model)]));
        renderModelSettingsList();
        if (data.revision !== previous.revision) text('model-settings-message', '账号目录已更新，未保存的勾选和上下文设置已保留。保存时会核对版本；发生冲突时请重新选择。');
      }
      const discovery = Object.entries(data.discovery ?? {}).filter(([, value]) => value?.state === 'error')
        .map(([channel, value]) => `${modelChannelLabels[channel] || channel}：${typeof value.message === 'string' ? value.message : '目录暂不可用'}`);
      if (!completeModelDiscoverySupported()) discovery.unshift('当前后台尚未加载完整模型目录功能，下面仅显示旧目录中的已保存模型。请先重启网关服务，恢复后再刷新账号目录；仅刷新网页不会更新后台。');
      text('model-settings-discovery', discovery.join(' · ')); elements['model-settings-discovery'].hidden = !discovery.length;
      return data;
    } catch (error) {
      if (generation !== modelSettingsGeneration) return;
      modelSettingsUnavailable = error.status === 404;
      modelSettingsError = modelSettingsUnavailable ? '' : error.message || '暂时无法读取模型列表。';
      if (!modelSettings) {
        const empty = document.createElement('p'); empty.className = 'model-settings-empty';
        empty.textContent = modelSettingsUnavailable ? '重启服务后可用。' : '模型列表暂时无法读取。';
        elements['model-settings-list'].replaceChildren(empty);
      }
      return null;
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
async function readModelSettingsForSave(changes, generation) {
  if (modelSettingsRequest) await modelSettingsRequest;
  if (generation !== modelSettingsGeneration) return null;
  return refreshModelSettings({ rebaseChanges: changes });
}
function retainedModelSettingsDraft(changes) {
  if (changes.contexts.size === 1) {
    const tokens = [...changes.contexts.values()][0].to;
    return `${tokens === null ? '跟随默认的' : `${contextTokenLabel(tokens)} 的`}上下文草稿已保留`;
  }
  return '你的模型和上下文草稿已保留';
}
function modelSettingsSaveNotice(message, isError = false) {
  text('model-settings-message', message);
  if (isError) notify(message, true);
}
async function saveModelSettingsChanges() {
  if (!modelSettings || !modelSettingsDirty()) return;
  const changes = captureModelSettingsChanges(), generation = modelSettingsGeneration;
  let baseline = modelSettings;
  const initialConflict = modelSettingsMergeConflict(baseline, changes);
  if (initialConflict) {
    modelSettingsSaveNotice(`${initialConflict}${retainedModelSettingsDraft(changes)}，请刷新目录后核对。`, true);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let acknowledgement;
    try { acknowledgement = await post('/api/model-settings', modelSettingsPayload(baseline, changes)); }
    catch (error) {
      if (generation !== modelSettingsGeneration) {
        modelSettingsSaveNotice('服务已重新连接，旧保存结果未确认；请核对当前草稿后再次保存。', true);
        return;
      }
      if (error.status !== 409) {
        modelSettingsSaveNotice(`未能确认保存：${error.message || '网络请求失败'}。${retainedModelSettingsDraft(changes)}，请检查后再次保存。`, true);
        return;
      }
      const fresh = await readModelSettingsForSave(changes, generation);
      if (generation !== modelSettingsGeneration) return;
      if (!fresh) {
        modelSettingsSaveNotice(`配置版本已变化，暂时无法读取最新目录。${retainedModelSettingsDraft(changes)}，请刷新后再次保存。`, true);
        return;
      }
      const conflict = modelSettingsMergeConflict(fresh, changes);
      if (conflict) {
        modelSettingsSaveNotice(`${conflict}${retainedModelSettingsDraft(changes)}，请核对后再次保存。`, true);
        return;
      }
      if (modelSettingsConfirmed(fresh, changes)) {
        rememberModelSettingsConfirmation(fresh, changes);
        modelSettingsSaveNotice('已确认所选模型和上下文设置生效。请在客户端刷新模型目录，或重开客户端。');
        return;
      }
      if (attempt === 1) {
        modelSettingsSaveNotice(`目录持续更新，本次未完成保存。${retainedModelSettingsDraft(changes)}，请稍后再次保存。`, true);
        return;
      }
      baseline = fresh;
      continue;
    }
    if (generation !== modelSettingsGeneration) {
      modelSettingsSaveNotice('服务已重新连接，旧保存结果未确认；请核对当前草稿后再次保存。', true);
      return;
    }
    const acknowledged = modelSettingsConfirmed(acknowledgement, changes) && acknowledgement.revision >= modelSettingsRevisionFloor;
    if (acknowledged) rememberModelSettingsConfirmation(acknowledgement, changes);
    const confirmed = acknowledged ? confirmedModelSettingsSnapshot(baseline, acknowledgement) : null;
    const fresh = await readModelSettingsForSave(changes, generation);
    if (generation !== modelSettingsGeneration) return;
    if (fresh && modelSettingsConfirmed(fresh, changes) && (!acknowledged || fresh.revision >= acknowledgement.revision)) {
      rememberModelSettingsConfirmation(fresh, changes);
      const changedCapability = modelSettingsMergeConflict(fresh, changes);
      if (changedCapability) {
        modelSettingsSaveNotice(`保存值已确认，但${changedCapability}已保留最新目录，请核对后重新选择。`, true);
        return;
      }
      modelSettingsSaveNotice('已保存并确认所选模型和上下文。请在客户端刷新模型目录，或重开客户端。');
      return;
    }
    if (confirmed && (!fresh || fresh.revision <= acknowledgement.revision
      || [...changes.contexts.keys()].some(id => !modelSettingField(fresh, id, 'context').consistent)
      || [...changes.checkboxes.keys()].some(id => !modelSettingField(fresh, id, 'checkbox').consistent))) {
      adoptModelSettingsSnapshot(confirmed, changes);
      modelSettingsSaveNotice('后台已确认保存，但目录回读尚未同步；已保留确认值，请刷新目录后核对。', true);
      return;
    }
    modelSettingsSaveNotice(`${acknowledged ? '保存后设置又发生变化' : '保存结果尚未得到一致确认'}。${retainedModelSettingsDraft(changes)}，请核对后再次保存。`, true);
    return;
  }
}

async function bootstrapManagementSession(signal) {
  const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`管理页面暂不可用（HTTP ${response.status}）。`);
  await response.text();
}

async function waitForServiceRestart(previousToken, reconnectAfterMs = 1500) {
  const deadline = Date.now() + 60000;
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const remainingSignal = maximum => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('等待服务恢复超时。');
    return AbortSignal.timeout(Math.min(maximum, remaining));
  };
  await pause(Math.min(10000, Math.max(750, Number.isFinite(reconnectAfterMs) ? reconnectAfterMs : 1500)));
  let reconnected = false;
  while (Date.now() < deadline) {
    try {
      const health = await request('/health', { signal: remainingSignal(2000) });
      if (health.ok !== true) throw new Error('服务尚未就绪。');
      await bootstrapManagementSession(remainingSignal(2000));
      await refreshStatus({ duringRestart: true, signal: remainingSignal(5000) });
      if (status?.csrfToken && status.csrfToken !== previousToken) reconnected = true;
      serviceStatus = await request('/api/service/status', { signal: remainingSignal(SERVICE_STATUS_TIMEOUT_MS) });
      serviceUnavailable = false; serviceError = ''; renderServiceControl();
      const reportedError = typeof serviceStatus?.error === 'string' ? serviceStatus.error : serviceStatus?.error?.message;
      if (reportedError && !serviceStatus.pending) {
        const error = new Error(`服务重启未完成：${reportedError}`); error.restartFailed = true; throw error;
      }
      if (!status?.csrfToken || status.csrfToken === previousToken) throw new Error('正在等待新服务接管。');
      reconnected = true;
      if (serviceUnavailable || serviceError || serviceStatus?.pending || serviceStatus?.ready !== true) throw new Error('服务已连接，正在等待就绪。');
      if (Date.now() >= deadline) throw new Error('等待服务恢复超时。');
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
  const worldGeneration = worldServiceGeneration;
  if (cursorRequest && cursorRequestEpoch === epoch) return cursorRequest;
  const pending = (async () => {
    try {
      const previous = cursorStatus;
      const incoming = await request('/api/cursor', { signal: AbortSignal.timeout(20000) });
      if (epoch !== accountStateEpoch.cursor) return;
      cursorStatus = incoming; cursorReadError = '';
      if (worldGeneration === worldServiceGeneration) worldProviderGeneration.cursor = worldGeneration;
      renderCursor(cursorStatus);
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

function renderIntegrationMode({ integration, idle, bound, passed, verifying }) {
  const routing = integration.routing || {};
  const supported = routing.supported === true
    && integrationModeUnavailableToken !== (status?.csrfToken || 'unknown-service');
  const mode = routing.supported === true ? ['official', 'gateway', 'other'].includes(routing.mode) ? routing.mode : 'other'
    : codexOfficialSelected(integration) ? 'official' : codexGatewaySelected(integration) ? 'gateway' : 'other';
  const needsConnectionUpdate = routing.nativeThreadsSupported === true && integration.needsUpgrade === true;
  const updateGateway = needsConnectionUpdate && mode !== 'official';
  const updateOfficial = needsConnectionUpdate && mode === 'official';
  const enabled = supported && idle && managementConnected && !managementStatusError && !restartInProgress;
  text('integration-mode-value', mode === 'official' ? '官方直连' : mode === 'gateway' ? 'Bifröst 网关'
    : integration.providerId ? `其他提供方（${integration.providerId}）` : '尚未确认');
  text('integration-mode-description', mode === 'official' ? '已保存官方直连配置。重开 Codex 后使用当前登录账号；原会话若仍选着网关模型，请改选普通 GPT 模型。'
    : mode === 'gateway' ? routing.nativeThreadsCovered === true
      ? '已保存原生及网关会话的连接配置。完全退出并重开 Codex 后，原会话可切换普通模型和网关模型。'
      : '默认连接已指向网关，原生旧会话的连接仍需更新。'
      : '请选择官方连接，或使用已保存的 Bifröst 网关配置。');
  elements['integration-official-button'].disabled = !enabled || mode === 'official' && !updateOfficial || routing.canSwitchOfficial !== true;
  elements['integration-gateway-button'].disabled = !enabled || verifying || mode === 'gateway' && !updateGateway || routing.canSwitchGateway !== true || !bound || !passed;
  text('integration-official-button', busyAction === 'integration-mode-official' ? '正在保存官方配置…' : updateOfficial ? '更新原生连接' : mode === 'official' ? '官方配置已保存' : '切换到官方');
  text('integration-gateway-button', busyAction === 'integration-mode-gateway' ? '正在保存网关配置…' : updateGateway ? '更新网关连接' : mode === 'gateway' ? '网关配置已保存' : '切换到 Bifröst 网关');
  const error = !supported ? '切换功能需重启网关服务后可用。请在控制台点击“重启网关服务”，恢复连接后刷新页面。'
    : updateOfficial && routing.canSwitchOfficial === true ? '请更新原生连接以恢复旧会话的原始路由，然后完全退出并重新打开 Codex。'
    : mode !== 'gateway' && routing.canSwitchGateway !== true ? routing.reason || '尚无可切换的网关路由，请先完成下方网关接入配置。'
      : mode !== 'gateway' && (!bound || !passed) ? '切换到网关前，请登录并确认账号 B，完成推理验证。'
        : updateGateway ? '请更新网关连接以覆盖原生旧会话，然后完全退出并重新打开 Codex。'
          : mode === 'gateway' && routing.nativeThreadsSupported !== true ? '当前后台尚未提供旧会话兼容切换，请先空闲重启网关加载新版。'
            : routing.reason || '';
  text('integration-mode-error', error);
  elements['integration-mode-error'].hidden = !error;
}

function render() {
  if (!status) return;
  const caps = status.node?.capabilities;
  if (caps) {
    elements['tab-connections'].hidden = !caps.clientIntegration;
    elements['tab-clients'].hidden = !caps.userManagement;
    for (const panel of document.querySelectorAll('[data-client-integration-only]')) panel.hidden = !caps.clientIntegration || panel.hasAttribute('data-legacy-overview');
    elements['account-quotas-panel'].hidden = !canReadAccountQuotas(caps);
    for (const card of document.querySelectorAll('[data-local-quota]')) card.hidden = caps.clientIntegration !== true;
    if (!caps.userManagement && elements['tab-clients'].getAttribute('aria-selected') === 'true'
      || !caps.clientIntegration && elements['tab-connections'].getAttribute('aria-selected') === 'true') selectManagementTab('console');
    if (!caps.clientIntegration) {
      elements['connection-dot'].className = 'status-dot connected';
      text('connection-label', '当前网关已连接'); text('version', status.version ? `v${status.version}` : '');
      renderServiceControl(); renderModelSettingsControls(); renderClientAdminControls();
      return;
    }
  }
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
  text('bind-description', bound ? '已固定下方账号 B。已开放的 B 模型使用该账号的授权。' : '核对上方邮箱，确认它就是你要使用订阅额度的账号 B。');
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

  renderIntegrationMode({ integration, idle, bound, passed, verifying });
  pill('integration-state', needsUpgrade ? '待更新路由' : integration.installed ? '路由配置已保存' : '未配置网关', needsUpgrade ? 'pending' : integration.installed ? 'success' : '');
  text('integration-description', needsUpgrade ? '请更新已保存的网关模型路由。' : integration.installed ? '网关路由已保存。实际连接模式见上方“当前配置”。' : integration.reason || '完成推理验证后，可配置本机 Codex 的网关模型路由。');
  text('config-path', integration.configPath || '未检测到配置路径');
  elements['install-button'].disabled = !idle || !passed || !bound || !integration.canInstall || (integration.installed && !needsUpgrade) || verifying;
  text('install-button', busyAction === 'install' ? '正在写入配置…' : needsUpgrade ? '更新模型路由' : integration.installed ? '网关路由已配置' : '配置网关路由');
  elements['copy-button'].disabled = !idle || !passed || !bound || verifying;
  text('copy-button', busyAction === 'copy' ? '正在复制…' : '复制接入配置');
  elements['restore-button'].hidden = !integration.installed;
  elements['restore-button'].disabled = !idle || verifying;
  text('restore-button', busyAction === 'restore' ? '正在恢复…' : '恢复接入前的提供方配置');

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
        modelSettingsRevisionFloor = -1;
        modelSettingsConfirmation = null;
        modelSettingsRequest = null;
        modelSettingsLoaded = false;
        worldServiceGeneration++;
        messagesStatus = null;
        clientAdminData = null;
        clientAdminLoaded = false;
        clientAdminUnavailable = true;
        clientAdminRequest = null;
        accountQuotaStatus = null;
        accountQuotasRequest = null;
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
        const caps = status.node?.capabilities;
        const active = kind => !caps || caps.activeKinds?.includes(kind);
        if (status.backend?.account && !modelsLoaded) void loadModels();
        if (!status.backend?.account) modelsLoaded = false;
        if (!caps) void refreshTokenUsage();
        void refreshRequestDiagnostics();
        if (active('with') || !caps) void refreshWith();
        if (active('codebuddy')) void refreshCodeBuddy();
        if (active('cursor')) void refreshCursor();
        if (canReadAccountQuotas(caps) && !accountQuotaStatus && !accountQuotasRequest) void refreshAccountQuotas();
        void refreshServiceStatus();
        if (!modelSettingsLoaded) void refreshModelSettings();
        if (!clientAdminLoaded && (elements['tab-clients'].getAttribute('aria-selected') === 'true'
          || ['codebuddy', 'workbuddy'].includes(worldSelection))) void refreshClientAdmin();
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
      document.querySelectorAll('button:not(#quota-refresh-button):not([role="tab"]):not([data-world-action])').forEach((button) => { button.disabled = true; });
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

function quotaNode(tag, value, className = '') {
  const node = document.createElement(tag);
  node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
}

function remoteQuotaWallet(value) {
  return value?.currency === 'CNY' && typeof value.enforceBalance === 'boolean'
    && [value.balanceMicros, value.reservedMicros, value.availableMicros].every(Number.isSafeInteger)
    && value.reservedMicros >= 0
    && BigInt(value.balanceMicros) - BigInt(value.reservedMicros) === BigInt(value.availableMicros) ? value : null;
}

function remoteTokenQuota(value) {
  if (!value || ![value.used, value.reserved].every(number => Number.isSafeInteger(number) && number >= 0)) return null;
  if (value.limit === null) return value.remaining === null ? value : null;
  if (![value.limit, value.remaining].every(number => Number.isSafeInteger(number) && number >= 0)) return null;
  const remaining = BigInt(value.limit) - BigInt(value.used) - BigInt(value.reserved);
  return BigInt(value.remaining) === (remaining < 0n ? 0n : remaining) ? value : null;
}

function renderBifrostQuotas(group, timeZone) {
  const missing = group == null, unavailable = group?.status === 'not_connected';
  const state = missing ? ['待更新服务', 'pending'] : unavailable ? ['未绑定', 'pending']
    : group.status === 'ok' ? ['已更新', 'success'] : group.status === 'error' ? ['需检查', 'error']
      : group.status === 'partial' ? ['部分需检查', 'pending'] : ['未提供余额', 'pending'];
  pill('quota-bifrost-state', ...state);
  const notice = typeof group?.notice === 'string' ? group.notice : '';
  text('quota-bifrost-notice', notice); elements['quota-bifrost-notice'].hidden = !notice;
  text('quota-bifrost-updated', group?.fetchedAt ? `查询时间：${quotaTime(group.fetchedAt, timeZone)}` : '尚未取得查询时间');
  const sources = Array.isArray(group?.sources) ? group.sources.filter(source => source && typeof source === 'object').slice(0, 8) : [];
  const cards = sources.map((source, index) => {
    const card = quotaNode('section', null, 'quota-remote-source');
    card.setAttribute('data-bifrost-source-index', index);
    const titleId = `quota-bifrost-source-title-${index}`;
    card.setAttribute('aria-labelledby', titleId);
    const heading = quotaNode('div', null, 'quota-account-heading'), title = quotaNode('h4', source.name || 'Bifröst 远端账号');
    title.setAttribute('id', titleId);
    const succeeded = source.status === 'ok' && source.authenticated === true;
    const failed = source.status === 'error';
    heading.append(title, quotaNode('span', failed ? '需检查' : source.authenticated === false ? '未授权' : succeeded ? '已更新' : '未提供余额',
      `pill ${failed || source.authenticated === false ? 'error' : succeeded ? 'success' : 'pending'}`));
    card.append(heading);
    const metadata = quotaNode('dl', null, 'quota-account-meta');
    const identity = source.authenticated === true ? typeof source.identity === 'string' && source.identity.trim()
      ? source.identity : '已绑定（账号标识未返回）' : source.authenticated === false ? '未确认有效的远端 Key' : '账号状态未返回';
    for (const [label, value] of [['绑定账号', identity], ['来源', source.id || '远端 Bifröst']]) {
      const row = quotaNode('div'); row.append(quotaNode('dt', label), quotaNode('dd', value)); metadata.append(row);
    }
    card.append(metadata);
    const wallet = succeeded ? remoteQuotaWallet(source.wallet) : null;
    if (wallet) {
      const balance = quotaNode('div', null, 'quota-remote-balance');
      balance.append(quotaNode('span', wallet.enforceBalance ? '可用余额（CNY）' : '账面余额（CNY）'),
        quotaNode('strong', clientMoney(wallet.enforceBalance ? wallet.availableMicros : wallet.balanceMicros)));
      card.append(balance);
      const amounts = quotaNode('dl', null, 'quota-remote-metrics');
      for (const [label, value] of [[wallet.enforceBalance ? '总余额' : '可用账面金额', wallet.enforceBalance ? wallet.balanceMicros : wallet.availableMicros], ['已预留金额', wallet.reservedMicros]]) {
        const row = quotaNode('div'); row.append(quotaNode('dt', label), quotaNode('dd', clientMoney(value))); amounts.append(row);
      }
      card.append(amounts);
      if (!wallet.enforceBalance) card.append(quotaNode('p', '远端未启用余额限制；金额仅为账面记录，不代表可用模型额度。', 'quota-notice'));
    } else card.append(quotaNode('p', failed ? '本次未取得远端余额。' : source.authenticated === false
      ? '请检查远端用户 Key 的授权与有效期。' : '远端未提供可靠余额。', 'quota-empty'));
    const quota = succeeded ? remoteTokenQuota(source.tokenQuota) : null;
    if (quota) {
      card.append(quotaNode('p', quota.limit === null ? 'Token 配额：未设置限额' : `Token 配额：剩余 ${clientTokenValue(quota.remaining)} / ${clientTokenValue(quota.limit)}`, 'quota-credits'));
      card.append(quotaNode('p', `本周期已用 ${clientTokenValue(quota.used)} Token · 已预留 ${clientTokenValue(quota.reserved)} Token`, 'quota-notice'));
    } else if (succeeded) card.append(quotaNode('p', 'Token 配额：未返回', 'quota-notice'));
    const expiresAt = source.authenticated === true && source.key && Object.hasOwn(source.key, 'expiresAt') ? source.key.expiresAt : undefined;
    const expiry = expiresAt === null ? '未设置到期时间' : typeof expiresAt === 'string' && Number.isFinite(new Date(expiresAt).getTime())
      ? `至 ${quotaTime(expiresAt, timeZone)}` : '未返回';
    card.append(quotaNode('p', `Key 有效期：${expiry}`, 'quota-notice'));
    if (typeof source.notice === 'string' && source.notice) card.append(quotaNode('p', source.notice, 'quota-notice'));
    if (failed) card.append(quotaNode('p', typeof source.error === 'string' && source.error ? source.error : '远端余额暂时无法读取，请稍后刷新。', 'gateway-error'));
    card.append(quotaNode('p', source.fetchedAt ? `查询时间：${quotaTime(source.fetchedAt, timeZone)}` : '尚未取得查询时间', 'quota-updated'));
    return card;
  });
  if (!cards.length) cards.push(quotaNode('p', missing ? '当前服务未提供远端账号余额，请更新并重启网关。'
    : unavailable ? '未配置远端 Bifröst 来源。' : group?.status === 'error' ? '远端余额暂时无法读取，请稍后刷新。' : '远端未提供账号余额。', 'quota-empty'));
  elements['quota-bifrost-sources'].replaceChildren(...cards);
}

function renderAccountQuotas(data) {
  accountQuotaStatus = data;
  const timeZone = data.timeZone || 'America/Los_Angeles';
  renderBifrostQuotas(data.accounts?.Bifrost, timeZone);
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
  if (!canReadAccountQuotas()) return;
  if (accountQuotasRequest) return accountQuotasRequest;
  elements['quota-refresh-button'].disabled = true;
  text('quota-refresh-button', '查询中…');
  for (const accountId of ['a', 'b', 'codebuddy', 'cursor']) pill(`quota-${accountId}-state`, '查询中', 'pending');
  pill('quota-bifrost-state', '查询中', 'pending');
  const generation = worldServiceGeneration;
  const pending = (async () => {
    try {
      const data = await request('/api/account-quotas', { signal: AbortSignal.timeout(30_000) });
      if (generation === worldServiceGeneration) renderAccountQuotas(data);
    } catch (error) {
      if (generation !== worldServiceGeneration) return;
      const message = error.name === 'TimeoutError' ? '官方额度查询超时，请稍后重试。' : error.message || '官方额度暂时无法读取，请稍后重试。';
      renderAccountQuotas({ accounts: { ...Object.fromEntries(['A', 'B', 'CodeBuddy', 'Cursor'].map(account => [account, { status: 'error', error: message }])),
        Bifrost: { status: 'error', notice: message, sources: [] } } });
    } finally {
      if (accountQuotasRequest === pending) {
        accountQuotasRequest = null;
        elements['quota-refresh-button'].disabled = false;
        text('quota-refresh-button', '刷新额度');
      }
    }
  })();
  accountQuotasRequest = pending;
  return pending;
}
async function refreshAuthorizedAccountQuotas() {
  if (!canReadAccountQuotas()) return;
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
  const generation = worldServiceGeneration;
  withRequest = (async () => {
    try {
      const incoming = await request('/api/with');
      if (generation !== worldServiceGeneration) return;
      messagesStatus = incoming;
      renderWith(messagesStatus);
    } catch (error) {
      if (generation !== worldServiceGeneration) return;
      messagesStatus = null;
      pill('with-state', '读取失败', 'error');
      elements['with-error'].hidden = false;
      text('with-error', `With 状态暂时无法读取：${error.message || '请稍后重试。'}`);
    } finally {
      withRequest = null;
      renderWorldTree();
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
    const transport = record.requestBodyDiagnostics;
    if (transport?.version === 1 && Array.isArray(transport.encodings)) {
      const byteSize = value => Number.isSafeInteger(value) && value >= 0 ? `${(value / 1048576).toFixed(2)} MiB（${value} B）` : '未知';
      const stages = { wire: '读取正文', decode: '解压正文', complete: '解码完成' };
      const kinds = { wire_limit: '传输正文超限', decoded_limit: '解压后正文超限', invalid_compression: '压缩数据无效',
        unsupported_encoding: '编码不支持', zstd_window_limit: 'zstd 窗口超限', zstd_dictionary_error: 'zstd 字典错误',
        aborted: '请求中断', read_failed: '正文读取失败' };
      fields.push(['请求编码', transport.encodings.filter(value => ['identity', 'zstd', 'gzip', 'deflate', 'br', 'unknown'].includes(value)).join(', ') || '未知'],
        ['传输正文大小', byteSize(transport.wireBytes)], ['解压后正文大小', byteSize(transport.decodedBytes)],
        ['传输正文上限', byteSize(transport.wireLimitBytes)], ['解压后正文上限', byteSize(transport.decodedLimitBytes)],
        ['正文处理阶段', Object.hasOwn(stages, transport.stage) ? stages[transport.stage] : '未知']);
      if (Object.hasOwn(kinds, transport.errorKind)) fields.push(['正文错误类别', kinds[transport.errorKind]]);
      if ([16, 30, 32].includes(transport.zstdErrorCode)) fields.push(['zstd 错误码', transport.zstdErrorCode]);
    }
    const shape = record.sourceDiagnostics;
    if (shape?.version === 1 && shape.kind === 'codebuddy_protocol_check' && typeof shape.description === 'string') {
      fields.push(['协议校验项', shape.description]);
      const observation = shape.observation;
      if (observation) fields.push(['结构信息', [typeof observation.valueType === 'string' ? `类型 ${observation.valueType}` : '',
        ...[['length', '长度'], ['count', '数量'], ['limit', '上限']].flatMap(([key, label]) =>
          Number.isSafeInteger(observation[key]) && observation[key] >= 0 ? [`${label} ${observation[key]}`] : [])].filter(Boolean).join('；') || '未提供']);
    }
    if (shape?.version === 1 && shape.kind === 'codebuddy_delta_shape' && Array.isArray(shape.fields)) {
      const describe = field => `${field.field} (${field.type}${Number.isSafeInteger(field.length) ? `, 长度 ${field.length}` : ''})`;
      fields.push(['未适配字段', shape.fields.slice(0, 8).map(field => `${describe(field)}${Array.isArray(field.children)
        ? ` · ${field.children.slice(0, 3).map(describe).join('、')}` : ''}`).join('；')]);
    }
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
  const worldGeneration = worldServiceGeneration;
  if (codeBuddyRequest && codeBuddyRequestEpoch === epoch) return codeBuddyRequest;
  const pending = (async () => {
    try {
      const previous = codeBuddyStatus;
      const incoming = await request('/api/codebuddy', { signal: AbortSignal.timeout(20000) });
      if (epoch !== accountStateEpoch.codebuddy) return;
      codeBuddyStatus = incoming;
      codeBuddyReadError = '';
      if (worldGeneration === worldServiceGeneration) worldProviderGeneration.codebuddy = worldGeneration;
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

async function switchIntegrationMode(mode) {
  if (!['official', 'gateway'].includes(mode)
    || elements[`integration-${mode}-button`].disabled) return;
  await action(`integration-mode-${mode}`, async () => {
    let integration;
    try { integration = await post('/api/integration/mode', { mode }); }
    catch (error) {
      if (error.status === 404) {
        integrationModeUnavailableToken = status?.csrfToken || 'unknown-service';
        throw new Error('当前后台尚未提供连接模式切换。请先在控制台重启网关服务，恢复连接后重试。');
      }
      throw error;
    }
    if (status) status = { ...status, integration };
    notify(mode === 'official'
      ? '已恢复官方连接配置。请完全退出并重开 Codex，并将原会话中选着的网关模型改为普通 GPT 模型。'
      : integration.routing?.nativeThreadsCovered === true
        ? '已保存网关配置并覆盖原生旧会话。请完全退出并重开 Codex，然后可在原会话切换普通模型和网关模型。'
        : '默认网关配置已保存；此后台尚未确认旧会话接入。请更新网关服务后重试。');
  });
}

for (const mode of ['official', 'gateway']) {
  elements[`integration-${mode}-button`].addEventListener('click', () => { void switchIntegrationMode(mode); });
}

elements['install-button'].addEventListener('click', () => {
  void action('install', async () => {
    await post('/api/integration/install');
    notify('已接入已开放的 B 模型并启用账号分流。保存当前工作，重启 Codex 后可在模型选择器中切换。');
  });
});

elements['restore-button'].addEventListener('click', () => {
  void action('restore', async () => {
    await post('/api/integration/restore');
    notify('已恢复接入前的提供方配置。请重开 Codex；官方直连与网关模式请使用上方切换按钮。');
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

const managementTabs = ['console', 'accounts', 'connections', 'clients'];
for (const [index, name] of managementTabs.entries()) {
  elements[`tab-${name}`].addEventListener('click', () => selectManagementTab(name));
  elements[`tab-${name}`].addEventListener('keydown', event => {
    const visible = managementTabs.filter(tab => !elements[`tab-${tab}`].hidden), at = visible.indexOf(name);
    const next = event.key === 'Home' ? visible[0] : event.key === 'End' ? visible.at(-1)
      : event.key === 'ArrowLeft' ? visible[(at + visible.length - 1) % visible.length]
        : event.key === 'ArrowRight' ? visible[(at + 1) % visible.length] : null;
    if (next) { event.preventDefault(); selectManagementTab(next, { focus: true }); }
  });
}
window.addEventListener('hashchange', () => selectManagementTab(window.location.hash.slice(1), { updateLocation: false }));
selectManagementTab(window.location?.hash?.slice(1), { updateLocation: false });

elements['client-admin-refresh'].addEventListener('click', () => { void refreshClientAdmin({ clearSecret: true }); });
elements['client-price-model'].addEventListener('change', renderClientPriceFields);
elements['client-unresolved-more'].addEventListener('click', () => { if (clientBillingReady() && !clientUnresolvedLoading) void refreshClientUnresolved({ more: true }); });
elements['client-ledger-more'].addEventListener('click', () => { if (clientBillingReady() && !clientLedgerLoading) void refreshClientLedger({ more: true }); });
elements['client-billing-reset-confirm'].addEventListener('change', renderClientAdminControls);
elements['client-billing-policy-form'].addEventListener('submit', event => {
  event.preventDefault(); if (!clientBillingReady() || !clientAccount()?.billing) return;
  void runClientAdminAction(async () => {
    await post(`${clientAccountPath()}/billing`, { enforceBalance: elements['client-billing-enforce'].checked,
      tokenLimit: clientNonnegativeInteger(elements['client-billing-token-limit'].value, 'Token 总配额', { optional: true }) });
  });
});
elements['client-billing-quota-reset'].addEventListener('click', () => {
  const billing = clientAccount()?.billing;
  if (!clientBillingReady() || !billing || !elements['client-billing-reset-confirm'].checked || billing.pendingCount !== 0 || billing.unresolvedCount !== 0) return;
  void runClientAdminAction(async () => { await post(`${clientAccountPath()}/billing`, { enforceBalance: billing.enforceBalance,
    tokenLimit: billing.tokenLimit, resetQuota: true }); });
});
elements['client-balance-form'].addEventListener('submit', event => {
  event.preventDefault(); if (!clientBillingReady() || !clientAccount()?.billing) return;
  const accountId = clientSelectedId, slot = `balance:${accountId}`;
  void runClientAdminAction(async () => {
    const pending = clientBillingOperations.get(slot);
    const body = pending ? Object.fromEntries(Object.entries(pending.body).filter(([key]) => key !== 'operationId'))
      : { amountMicros: clientDecimalMicros(elements['client-balance-amount'].value, { signed: true, nonzero: true }), note: elements['client-balance-note'].value.trim() };
    if (body.note?.length > 240) throw new Error('备注最多 240 个字符。');
    await clientIdempotentPost(slot, `${clientAccountPath(accountId)}/balance`, body);
    elements['client-balance-amount'].value = ''; elements['client-balance-note'].value = '';
  });
});
elements['client-prices-form'].addEventListener('submit', event => {
  event.preventDefault(); if (!clientBillingReady()) return;
  void runClientAdminAction(async () => {
    const model = elements['client-price-model'].value;
    if (!clientAdminData?.models?.some(item => item.id === model)) throw new Error('请先选择目录中的模型。');
    const reserveInputTokens = clientNonnegativeInteger(elements['client-price-reserve-input'].value, '预留输入 Token');
    const reserveOutputTokens = clientNonnegativeInteger(elements['client-price-reserve-output'].value, '预留输出 Token');
    if (!Number.isSafeInteger(reserveInputTokens + reserveOutputTokens) || reserveInputTokens + reserveOutputTokens === 0) throw new Error('请求预留 Token 合计需为正的安全整数。');
    await post('/api/client-admin/billing/prices', { model,
      inputRateMicros: clientDecimalMicros(elements['client-price-input'].value, { label: '输入价格' }),
      cachedInputRateMicros: clientDecimalMicros(elements['client-price-cached'].value, { label: '缓存输入价格' }),
      outputRateMicros: clientDecimalMicros(elements['client-price-output'].value, { label: '输出价格' }),
      reserveInputTokens, reserveOutputTokens, enabled: elements['client-price-enabled'].checked });
  });
});
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
  void action('model-settings-save', saveModelSettingsChanges);
});
elements['model-settings-reset-button'].addEventListener('click', () => {
  if (busyAction || !modelSettings) return;
  modelDraft = new Map(modelSettings.models.map(model => [model.id, model.enabled]));
  resetModelContextDraft(); renderModelSettingsList(); text('model-settings-message', '已恢复为最近保存的模型和上下文设置。');
});
elements['model-settings-refresh-button'].addEventListener('click', () => {
  if (busyAction || restartInProgress) return;
  text('model-settings-message', '正在读取各账号模型目录，只查询元数据。');
  void refreshModelSettings().then(() => {
    if (!modelSettingsError && !modelSettingsUnavailable) text('model-settings-message', !completeModelDiscoverySupported()
      ? '当前后台仍使用旧目录接口。请先点击“重启网关服务”，恢复后再刷新账号目录。'
      : modelSettingsDirty() ? '账号目录已刷新，未保存的可用勾选已保留，上下文设置已保留；不可用的未保存启用已撤回。保存时仍会核对目录版本。'
        : '账号目录已刷新。新增模型默认关闭，勾选并保存后在 Codex 中刷新模型目录。');
  });
});
elements['model-settings-search'].addEventListener('input', renderModelSettingsList);

for (const id of ['codex', 'claude', 'codebuddy', 'workbuddy', 'cursor']) {
  const button = byId(`world-node-${id}`);
  button?.setAttribute('data-world-action', '');
  button?.addEventListener('click', () => {
    worldSelection = worldSelection === id ? 'all' : id;
    renderWorldTree();
    if (['codebuddy', 'workbuddy'].includes(worldSelection) && !clientAdminLoaded && managementConnected) void refreshClientAdmin();
  });
}
for (const id of ['world-reset', 'world-manage-models', 'world-manage-accounts', 'world-manage-clients']) byId(id)?.setAttribute('data-world-action', '');
byId('world-reset')?.addEventListener('click', () => { worldSelection = 'all'; renderWorldTree(); });
byId('world-manage-models')?.addEventListener('click', () => {
  selectManagementTab('console');
  byId('model-settings-title')?.scrollIntoView?.({ block: 'start' });
  byId('model-settings-search')?.focus();
});
byId('world-manage-accounts')?.addEventListener('click', () => { selectManagementTab('accounts', { focus: true }); });
byId('world-manage-clients')?.addEventListener('click', () => { selectManagementTab('clients', { focus: true }); });
renderWorldTree();
paintOfficialBrandIcons();
installDirectionalArrowLayout('world-', 'world-routes');

void refreshStatus().catch(() => {});
setInterval(() => { void refreshStatus().catch(() => {}); }, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshStatus().catch(() => {});
});
