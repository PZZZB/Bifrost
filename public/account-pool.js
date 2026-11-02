'use strict';
(() => {
  const byId = id => document.getElementById(id);
  let snapshot = null, selected = '', busy = false, pending = null, token = '', formKind = '', previewProtocol = 'responses', previewAccount = '';
  const routeExpanded = new Map();
  const labels = { ready: '就绪', disabled: '已停用', not_ready: '待确认', authorization_required: '待授权', activation_required: '待重启加载', caller_required: '随客户端身份' };
  const protocolLabels = { responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages',
    cli: 'Claude CLI', 'claude-cli': 'Claude CLI', 'official-claude-sdk': 'Claude CLI', 'cursor-sdk': 'Cursor SDK' };
  const element = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const message = value => { byId('pool-message').textContent = value || ''; };
  const percent = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '未返回';
  function failure(error) { byId('pool-error').textContent = error.message || '账号池暂不可用。'; byId('pool-error').hidden = false; }
  function normalize(value) {
    const models = Array.isArray(value.models) ? value.models : [];
    if (!value.capabilities.clientIntegration || value.accounts.some(account => account.kind === 'codex-client')) return { ...value, models };
    const owned = models.filter(model => model.channel === 'A');
    // Older servers do not own this definition. Display it without inventing a mutable account or credential.
    const caller = { id: 'current-client-codex', kind: 'codex-client', name: 'Codex · 当前客户端（A）', typeName: 'Codex 当前客户端',
      enabled: true, state: 'caller_required', readOnly: true, metadataPending: true, editor: null,
      modelCount: owned.length, publishedModelCount: owned.filter(model => model.enabled && model.available).length,
      authorization: '请求携带的 OpenAI 登录认证', credential: { mode: 'caller', label: '当前客户端身份透传', reusable: false,
        description: '使用发起请求的客户端所携带的 OpenAI 认证；没有保存可供其他客户端复用的账号凭证。' },
      quota: { status: 'unknown', label: '随调用者账号' } };
    return { ...value, models, accounts: [caller, ...value.accounts] };
  }
  function routeCard(account, route) {
    const row = element('article', undefined, 'pool-route'); row.setAttribute('data-pool-protocol', route.protocol);
    const header = element('div', undefined, 'pool-route-heading');
    header.append(element('strong', route.label || protocolLabels[route.protocol] || '接口'),
      element('span', route.modeLabel || (route.supported === true ? '已提供路径' : '尚未提供路径'), `pill ${route.available === true ? 'success' : 'pending'}`));
    row.append(header);
    const upstream = typeof route.upstreamProtocol === 'string' ? protocolLabels[route.upstreamProtocol] || route.upstreamProtocol : '未确认';
    row.append(element('p', `客户端入口：${protocolLabels[route.protocol] || route.label || '未确认'} · 上游接口：${upstream}`, 'pool-route-endpoints'));
    if (route.description) row.append(element('p', route.description, 'panel-copy'));
    if (route.reason) row.append(element('p', route.reason, 'pool-route-reason'));
    if (route.supported === true && route.available !== true) row.append(element('p', '协议路径已提供，当前来源尚不可用。', 'pool-route-reason'));
    if (route.supported === true) row.append(element('small', '客户端验收：未确认。需按具体客户端、模型和能力分别验证。', 'pool-route-verification'));
    if (account.credential?.mode === 'caller') row.append(element('p', '身份要求：本次请求携带调用者自己的 OpenAI 登录认证；网关 Key 不能代替。', 'pool-route-reason'));
    return row;
  }
  function renderRoutePreview(rows) {
    const panel = byId('pool-route-preview'); if (!panel) return;
    panel.replaceChildren();
    const heading = element('div', undefined, 'panel-heading'); heading.append(element('h2', '查看调用路径'), element('span', '只读预览', 'pill')); panel.append(heading);
    panel.append(element('p', '选择客户端使用的接口与账号来源，查看是否需要转换。这里不会切换客户端配置或发送请求。', 'panel-copy'));
    const fields = element('div', undefined, 'pool-fields');
    const clientLabel = element('label', '客户端与入口接口'), client = element('select'); client.id = 'pool-route-client';
    for (const [value, label] of [['responses', 'Codex · Responses'], ['chat-completions', 'CodeBuddy / WorkBuddy · Chat Completions'], ['messages', 'Claude · Messages']]) {
      const option = element('option', label); option.value = value; client.append(option);
    }
    client.value = previewProtocol; clientLabel.append(client);
    client.addEventListener('change', () => { previewProtocol = client.value; renderRoutePreview(rows); });
    const sourceLabel = element('label', '账号来源'), source = element('select'); source.id = 'pool-route-source';
    for (const account of rows) { const option = element('option', account.name); option.value = account.id; source.append(option); }
    if (!rows.some(account => account.id === previewAccount)) previewAccount = rows[0]?.id || '';
    source.value = previewAccount; source.disabled = !rows.length; sourceLabel.append(source);
    source.addEventListener('change', () => { previewAccount = source.value; renderRoutePreview(rows); });
    fields.append(clientLabel, sourceLabel); panel.append(fields);
    const account = rows.find(row => row.id === previewAccount);
    if (!account) { panel.append(element('p', '添加来源后可查看调用路径。', 'panel-copy')); return; }
    if (account.credential?.label) panel.append(element('p', `授权方式：${account.credential.label}`, 'pool-preview-authorization'));
    const route = Array.isArray(account.routes) ? account.routes.find(row => row.protocol === previewProtocol) : null;
    if (!route) panel.append(element('p', '当前服务尚未返回这条协议路径，请空闲重启加载新版后查看。', 'panel-copy'));
    else panel.append(routeCard(account, route));
    panel.append(element('p', '客户端名称仅提示常见接入方式；实际路由按接口协议和所选模型决定。', 'footnote'));
  }
  function renderRoutes(account, detail) {
    const section = element('details', undefined, 'pool-routes'); section.open = routeExpanded.get(account.id) === true;
    section.addEventListener('toggle', () => { routeExpanded.set(account.id, section.open); });
    const summary = element('summary'); summary.append(element('span', '客户端接入与协议路径'), element('small', '按接口查看'));
    section.append(summary);
    if (!Array.isArray(account.routes) || !account.routes.length) {
      section.append(element('p', '当前服务尚未返回协议路径。请空闲重启网关加载新版后查看；此处不推断客户端兼容性。', 'panel-copy'));
    } else {
      section.append(element('p', '是否需要转换，由客户端入口与上游接口共同决定。路径可用不代表每个客户端、每项模型能力均已验收。', 'panel-copy'));
      const routes = element('div', undefined, 'pool-route-list');
      for (const route of account.routes) routes.append(routeCard(account, route));
      section.append(routes);
    }
    detail.append(section);
  }
  async function request(path, body) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-csrf': token }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 404 || response.status === 503 ? data.error?.message || '请空闲重启网关以加载账号池。' : data.error?.message || '账号操作未完成。');
    return data;
  }
  async function load() {
    if (pending || busy) return pending;
    pending = (async () => {
      try {
        const value = await request('/api/upstream-accounts');
        if (!Array.isArray(value.accounts) || !Array.isArray(value.accountTypes) || !value.capabilities) throw new Error('当前网关未返回完整账号池。');
        snapshot = normalize(value); token = value.csrfToken || token;
        if (!snapshot.accounts.some(a => a.id === selected)) selected = snapshot.accounts[0]?.id || '';
        byId('pool-error').hidden = true; render();
      } catch (error) { failure(error); }
      finally { pending = null; }
    })(); return pending;
  }
  function hideEditors() {
    byId('pool-legacy-forms').hidden = true;
    for (const kind of ['codex', 'codebuddy', 'cursor', 'with']) byId(`pool-${kind}-form`).hidden = true;
  }
  function applyCapabilities() {
    const caps = snapshot.capabilities;
    byId('tab-connections').hidden = !caps.clientIntegration;
    byId('tab-clients').hidden = !caps.userManagement;
    for (const panel of document.querySelectorAll('[data-client-integration-only]')) panel.hidden = !caps.clientIntegration || panel.hasAttribute('data-legacy-overview');
    for (const panel of document.querySelectorAll('[data-legacy-overview]')) panel.hidden = true;
  }
  function render() {
    if (!snapshot) return;
    applyCapabilities();
    const rows = snapshot.accounts, list = byId('pool-list'); list.replaceChildren();
    renderRoutePreview(rows);
    byId('pool-add').disabled = busy;
    byId('pool-add').title = '查看当前网关支持的账号类型与添加条件';
    byId('pool-refresh').disabled = busy;
    if (!rows.length) list.append(element('p', '尚未添加上游账号。请选择当前网关支持的账号类型完成接入。', 'panel-copy'));
    for (const account of rows) {
      const button = element('button', undefined, 'pool-account'); button.type = 'button'; button.disabled = busy;
      button.setAttribute('aria-pressed', String(account.id === selected));
      const name = element('span'); name.append(element('strong', account.name), element('small', account.typeName));
      if (account.credential?.label) name.append(element('small', account.credential.label, 'pool-credential-label'));
      button.append(name, element('span', labels[account.state] || '状态未知', `pill ${account.state === 'ready' ? 'success' : 'pending'}`),
        element('span', `${account.publishedModelCount} / ${account.modelCount} 个模型`, 'pool-model-count'), element('small', account.quota.label));
      button.addEventListener('click', () => { selected = account.id; hideEditors(); render(); }); list.append(button);
    }
    const overview = byId('pool-overview'); overview.replaceChildren();
    const heading = element('div', undefined, 'panel-heading'); const title = element('div');
    title.append(element('div', 'CURRENT GATEWAY', 'eyebrow'), element('h2', '当前网关'));
    heading.append(title, element('span', `${rows.length} 个账号来源`, 'pill')); overview.append(heading);
    const metrics = element('div', undefined, 'metrics');
    for (const [value, label] of [[rows.filter(a => a.state === 'ready').length, '就绪来源'],
      [snapshot.models.filter(m => m.enabled && m.available).length, '已开放模型']]) {
      const cell = element('div'); cell.append(element('strong', String(value)), element('span', label)); metrics.append(cell);
    }
    overview.append(metrics, element('p', rows.map(a => a.name).join(' · ') || '添加账号后读取可用模型。', 'panel-copy'));
    const account = rows.find(a => a.id === selected), detail = byId('pool-detail'); detail.hidden = !account; detail.replaceChildren();
    if (!account) { hideEditors(); return; }
    const header = element('div', undefined, 'panel-heading'); header.append(element('h3', account.name), element('span', account.typeName, 'pill')); detail.append(header);
    const fields = element('dl', undefined, 'account-summary');
    for (const [label, value] of [['授权方式', account.credential?.label || account.authorization], [account.quota.kind === 'subscription' ? '订阅用量' : '上游额度', account.quota.label],
      ['已开放模型', `${account.publishedModelCount} / ${account.modelCount}`], ...(account.endpoint ? [['用户 API', account.endpoint]] : [])]) {
      const row = element('div'); row.append(element('dt', label), element('dd', value)); fields.append(row);
    }
    detail.append(fields);
    if (account.credential?.description) detail.append(element('p', account.credential.description, 'pool-identity-note'));
    if (account.credential?.mode === 'caller') detail.append(element('p', '仅持有网关 Key 的其他客户端不能复用此身份；要使用同一账号额度，需另行完成独立授权。', 'footnote'));
    renderRoutes(account, detail);
    if (account.quota.kind === 'subscription') {
      const quota = account.quota, windows = element('section', undefined, 'pool-usage');
      const plans = { pro: 'Claude Pro', max: 'Claude Max', ultra: 'Claude Ultra', team: 'Claude Team', enterprise: 'Claude Enterprise' };
      windows.append(element('h4', plans[quota.plan] || 'Claude 订阅用量'));
      for (const window of quota.windows || []) {
        const row = element('div', undefined, 'pool-usage-window');
        row.append(element('strong', window.label), element('span', typeof window.usedPercent === 'number' ? `已用 ${percent(window.usedPercent)}% · 剩余 ${percent(window.remainingPercent)}%` : '用量比例未返回'));
        if (typeof window.usedPercent === 'number') {
          const progress = element('progress'); progress.max = 100; progress.value = window.usedPercent;
          progress.setAttribute('aria-label', `${window.label}已用 ${percent(window.usedPercent)}%`); row.append(progress);
        }
        row.append(element('small', `重置：${time(window.resetsAt)}（北京时间）`)); windows.append(row);
      }
      if (quota.status !== 'ok') windows.append(element('p', quota.reason === 'stale' ? '上次数据已过期，等待重新读取。' : quota.label, 'panel-copy'));
      windows.append(element('p', `虚拟机内查询，沿用 VPS 出口，约每 5 分钟更新；上次检查：${time(quota.checkedAt)}（北京时间）。订阅用量与本站用户余额分别管理。`, 'footnote'));
      detail.append(windows);
    }
    if (account.readOnly === true) {
      detail.append(element('p', '这是当前客户端来源的只读展示。请空闲重启加载新版账号定义，再管理名称和启用状态。', 'footnote'));
      hideEditors(); return;
    }
    const rename = element('form', undefined, 'pool-rename');
    const label = element('label', '账号名称'), input = element('input'); input.value = account.name; input.maxLength = 80; input.required = true; label.append(input);
    const save = element('button', '保存名称', 'button secondary'); save.type = 'submit'; save.disabled = busy; rename.append(label, save);
    rename.addEventListener('submit', event => { event.preventDefault(); void mutate(account.id, { name: input.value.trim() }); }); detail.append(rename);
    const actions = element('div', undefined, 'button-row');
    const toggle = element('button', account.enabled ? '停用账号' : '启用账号', 'button secondary'); toggle.type = 'button'; toggle.disabled = busy;
    toggle.addEventListener('click', () => { void mutate(account.id, { enabled: !account.enabled }); }); actions.append(toggle);
    if (account.editor && !account.restartRequired) {
      const edit = element('button', '管理授权', 'button primary'); edit.type = 'button'; edit.disabled = busy;
      edit.addEventListener('click', () => { hideEditors(); const target = byId(`pool-${account.editor}-form`);
        if (target) { byId('pool-legacy-forms').hidden = false; target.hidden = false; target.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }); actions.append(edit);
    }
    detail.append(actions);
    if (account.managed) detail.append(element('p', '该账号在所属隔离环境中管理登录；这里管理本节点是否开放该来源。新增账号需独立的授权环境。', 'footnote'));
    if (account.restartRequired) detail.append(element('p', '来源已保存。请在概览中空闲重启服务以加载账号，随后按该类型完成授权。', 'footnote'));
  }
  async function mutate(id, patch) {
    if (busy || !snapshot) return;
    busy = true; render();
    try {
      const result = await request(`/api/upstream-accounts/${encodeURIComponent(id)}`, { revision: snapshot.revision, ...patch });
      snapshot = normalize(result);
      message(result.restartRequired ? '启用已保存，请在概览中空闲重启服务。' : '账号设置已保存。新请求按当前账号状态执行。');
    } catch (error) { failure(error); }
    finally { busy = false; hideEditors(); render(); }
  }
  function typeFields() {
    const kind = byId('pool-kind').value, type = snapshot?.accountTypes.find(t => t.kind === kind);
    if (formKind !== kind) byId('pool-remote-key').value = '';
    formKind = kind; byId('pool-kind-note').textContent = type ? `${type.authorization} · 当前最多 ${type.maxAccounts} 个实例` : '';
    const canAdd = type?.canAdd === true;
    byId('pool-kind-blocked').textContent = type?.addBlockedReason || (type ? '' : '当前网关没有可用的账号适配器。');
    byId('pool-kind-blocked').hidden = canAdd;
    byId('pool-name').disabled = !canAdd;
    byId('pool-create-submit').disabled = busy || !canAdd;
    byId('pool-remote-fields').hidden = kind !== 'bifrost';
    byId('pool-remote-url').required = kind === 'bifrost'; byId('pool-remote-key').required = kind === 'bifrost';
  }
  byId('pool-add').addEventListener('click', () => {
    if (!snapshot || busy) return;
    const select = byId('pool-kind'); select.replaceChildren();
    for (const type of snapshot.accountTypes) { const option = element('option', `${type.label}${type.canAdd ? '' : '（查看接入条件）'}`); option.value = type.kind; select.append(option); }
    select.value = snapshot.accountTypes.find(t => t.canAdd)?.kind || snapshot.accountTypes[0]?.kind || '';
    typeFields(); byId('pool-create').hidden = false; byId('pool-name').focus();
  });
  byId('pool-kind').addEventListener('change', typeFields);
  byId('pool-refresh').addEventListener('click', () => { void request('/api/model-settings').then(() => load()).catch(failure); });
  byId('pool-create-cancel').addEventListener('click', () => { byId('pool-create').reset(); byId('pool-create').hidden = true; });
  byId('pool-create').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !snapshot) return;
    if (!snapshot.accountTypes.some(t => t.kind === formKind && t.canAdd)) return;
    const body = { kind: formKind, name: byId('pool-name').value.trim(), ...(formKind === 'bifrost'
      ? { baseUrl: byId('pool-remote-url').value.trim(), apiKey: byId('pool-remote-key').value.trim() } : {}) };
    byId('pool-remote-key').value = ''; busy = true; byId('pool-create-submit').disabled = true;
    void request('/api/upstream-accounts', body).then(result => { snapshot = normalize(result); byId('pool-create').reset(); byId('pool-create').hidden = true;
      message(result.restartRequired ? '账号已保存，请空闲重启服务后管理授权及模型。' : '账号已保存。');
    }).catch(failure).finally(() => { delete body.apiKey; busy = false; byId('pool-create-submit').disabled = false; hideEditors(); render(); });
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#accounts') void load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  void load();
  setInterval(() => { if (!document.hidden && !busy && !byId('pool-create').contains(document.activeElement)
    && !byId('pool-detail').contains(document.activeElement) && !byId('pool-route-preview')?.contains(document.activeElement)) void load(); }, 15000);
})();
