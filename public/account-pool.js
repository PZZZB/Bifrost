'use strict';
(() => {
  const byId = id => document.getElementById(id);
  let snapshot = null, selected = '', busy = false, pending = null, token = '', formKind = '';
  const labels = { ready: '就绪', disabled: '已停用', not_ready: '待确认', authorization_required: '待授权', activation_required: '待重启加载' };
  const element = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const message = value => { byId('pool-message').textContent = value || ''; };
  function failure(error) { byId('pool-error').textContent = error.message || '账号池暂不可用。'; byId('pool-error').hidden = false; }
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
        snapshot = value; token = value.csrfToken || token;
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
    byId('pool-add').disabled = busy;
    byId('pool-add').title = '查看当前网关支持的账号类型与添加条件';
    byId('pool-refresh').disabled = busy;
    if (!rows.length) list.append(element('p', '尚未添加上游账号。请选择当前网关支持的账号类型完成接入。', 'panel-copy'));
    for (const account of rows) {
      const button = element('button', undefined, 'pool-account'); button.type = 'button'; button.disabled = busy;
      button.setAttribute('aria-pressed', String(account.id === selected));
      const name = element('span'); name.append(element('strong', account.name), element('small', account.typeName));
      button.append(name, element('span', labels[account.state] || '状态未知', `pill ${account.state === 'ready' ? 'success' : 'pending'}`),
        element('span', `${account.publishedModelCount} / ${account.modelCount} 个模型`, 'pool-model-count'), element('small', account.quota.label));
      button.addEventListener('click', () => { selected = account.id; hideEditors(); render(); }); list.append(button);
    }
    const overview = byId('pool-overview'); overview.replaceChildren();
    const heading = element('div', undefined, 'panel-heading'); const title = element('div');
    title.append(element('div', 'CURRENT GATEWAY', 'eyebrow'), element('h2', '当前网关'));
    heading.append(title, element('span', `${rows.length} 个上游账号`, 'pill')); overview.append(heading);
    const metrics = element('div', undefined, 'metrics');
    for (const [value, label] of [[rows.filter(a => a.state === 'ready').length, '就绪账号'],
      [snapshot.models.filter(m => m.enabled && m.available).length, '已开放模型']]) {
      const cell = element('div'); cell.append(element('strong', String(value)), element('span', label)); metrics.append(cell);
    }
    overview.append(metrics, element('p', rows.map(a => a.name).join(' · ') || '添加账号后读取可用模型。', 'panel-copy'));
    const account = rows.find(a => a.id === selected), detail = byId('pool-detail'); detail.hidden = !account; detail.replaceChildren();
    if (!account) { hideEditors(); return; }
    const header = element('div', undefined, 'panel-heading'); header.append(element('h3', account.name), element('span', account.typeName, 'pill')); detail.append(header);
    const fields = element('dl', undefined, 'account-summary');
    for (const [label, value] of [['授权位置', account.authorization], ['上游额度', account.quota.label],
      ['已开放模型', `${account.publishedModelCount} / ${account.modelCount}`], ...(account.endpoint ? [['用户 API', account.endpoint]] : [])]) {
      const row = element('div'); row.append(element('dt', label), element('dd', value)); fields.append(row);
    }
    detail.append(fields);
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
      snapshot = result;
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
    void request('/api/upstream-accounts', body).then(result => { snapshot = result; byId('pool-create').reset(); byId('pool-create').hidden = true;
      message(result.restartRequired ? '账号已保存，请空闲重启服务后管理授权及模型。' : '账号已保存。');
    }).catch(failure).finally(() => { delete body.apiKey; busy = false; byId('pool-create-submit').disabled = false; hideEditors(); render(); });
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#accounts') void load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  void load();
  setInterval(() => { if (!document.hidden && !busy && !byId('pool-create').contains(document.activeElement) && !byId('pool-detail').contains(document.activeElement)) void load(); }, 15000);
})();
