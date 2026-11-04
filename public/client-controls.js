'use strict';
(() => {
  const panel = document.getElementById('client-controls-panel');
  if (!panel) return;
  const element = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  const modeLabels = { native: '原生模式', gateway: '网关模式', unknown: '模式未确认', manual: '手动配置' };
  const syncLabels = { current: '目录已同步', pending: '目录待同步', native: '原生目录', unavailable: '目录暂不可用', conflict: '配置有冲突' };
  const protocolLabels = { responses: 'Responses', 'chat-completions': 'Chat Completions', messages: 'Messages' };
  const operationLabels = { launch: '启动', mode: '模式设置', sync: '目录同步', settings: '自动同步设置' };
  let snapshot = null, csrfToken = '', pending = null, busy = false, readFailed = false, errorText = '', statusText = '';
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '尚未同步';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未返回';
  const supported = (client, action) => client?.supports?.[action === 'settings' ? 'autoSync' : action] === true;
  function ingest(value, fromRead = false) {
    if (!value || value.version !== 1 || !Array.isArray(value.clients)
      || value.clients.some(client => !client || typeof client.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(client.id))) {
      throw new Error('服务未返回完整的客户端控制状态，请刷新后重试。');
    }
    snapshot = value;
    if (fromRead) csrfToken = typeof value.csrfToken === 'string' ? value.csrfToken : '';
    else if (typeof value.csrfToken === 'string') csrfToken = value.csrfToken;
  }
  async function request(path, body) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(body === undefined ? 15000 : 30000), ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-csrf': csrfToken }, body: JSON.stringify(body) }) });
    let data; try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error(body === undefined && [404, 503].includes(response.status)
        ? '当前服务尚未提供客户端控制接口，请空闲重启网关加载新版后刷新。'
        : data?.error?.message || `客户端操作未完成（HTTP ${response.status}）。`);
      error.status = response.status; throw error;
    }
    return data;
  }
  async function refresh(insideAction = false) {
    if (pending) return pending;
    if (busy && !insideAction) return false;
    pending = (async () => {
      try { ingest(await request('/api/client-controls'), true); readFailed = false; errorText = ''; return true; }
      catch (error) { readFailed = true; errorText = error.name === 'TimeoutError' ? '读取客户端状态超时，请稍后刷新。' : error.message; return false; }
      finally { pending = null; render(); }
    })();
    return pending;
  }
  async function act(id, operation, body) {
    if (busy) return;
    busy = true; errorText = ''; statusText = ''; render();
    try {
      // Each operation uses the current service's CSRF token and capabilities.
      if (!await refresh(true)) return;
      const client = snapshot.clients.find(row => row.id === id);
      if (!supported(client, operation) || operation === 'launch' && client.installed !== true
        || operation === 'sync' && client.mode !== 'gateway') throw new Error(client?.reason || '当前客户端尚不支持这项操作。');
      if (!csrfToken) throw new Error('服务未返回操作校验信息，请刷新或空闲重启网关后重试。');
      ingest(await request(`/api/client-controls/${encodeURIComponent(id)}/${operation}`, body));
      readFailed = false;
      const result = snapshot.clients.find(row => row.id === id);
      statusText = `${client.name || client.id}：${operationLabels[operation]}已完成。${result?.reloadNote || ''}`;
    } catch (error) {
      // A failed write can have a partial result. Read back state, never retry the write.
      await refresh(true);
      errorText = error.name === 'TimeoutError' ? '客户端操作超时，请刷新确认状态后重试。' : error.message;
    } finally { busy = false; render(); }
  }
  function control(client, label, operation, body, className = 'button secondary') {
    const button = element('button', label, className); button.type = 'button';
    button.disabled = busy || readFailed || !supported(client, operation)
      || operation === 'launch' && client.installed !== true || operation === 'sync' && client.mode !== 'gateway';
    button.setAttribute('data-client-action', operation);
    if (button.disabled && client.reason) button.title = client.reason;
    button.addEventListener('click', () => { if (!button.disabled) void act(client.id, operation, body); });
    return button;
  }
  function clientCard(client) {
    const card = element('article', undefined, 'client-control-card'); card.setAttribute('data-client-id', client.id);
    const heading = element('div', undefined, 'client-control-heading'), title = element('div');
    title.append(element('h3', client.name || client.id), element('small', client.installed === true ? '本机已安装' : '本机未检测到安装'));
    heading.append(title, element('span', client.modeLabel || modeLabels[client.mode] || modeLabels.unknown,
      `pill ${client.mode === 'gateway' ? 'success' : 'pending'}`)); card.append(heading);
    const fields = element('dl', undefined, 'client-control-summary');
    for (const [label, value] of [['接入协议', protocolLabels[client.protocol] || '未确认'], ['模型目录', syncLabels[client.syncState] || '状态未确认'],
      ['已同步 / 最新目录', `${count(client.modelCount)} / ${count(client.latestModelCount)}`], ['上次同步', time(client.lastSyncAt)]]) {
      const row = element('div'); row.append(element('dt', label), element('dd', value)); fields.append(row);
    }
    card.append(fields);
    const actions = element('div', undefined, 'button-row');
    actions.append(control(client, '启动', 'launch', {}, 'button primary'),
      control(client, client.mode === 'gateway' ? '恢复原生' : '启用网关', 'mode', { mode: client.mode === 'gateway' ? 'native' : 'gateway' }),
      control(client, '立即同步', 'sync', {})); card.append(actions);
    if (client.modeUpdateRequired === true) actions.append(control(client, client.mode === 'native' ? '更新原生连接' : '更新网关连接',
      'mode', { mode: client.mode === 'native' ? 'native' : 'gateway' }));
    const auto = element('label', undefined, 'client-control-auto'), checkbox = element('input'); checkbox.type = 'checkbox';
    checkbox.checked = client.autoSync === true || client.autoSync === undefined && snapshot.autoSyncDefault === true;
    checkbox.disabled = busy || readFailed || !supported(client, 'settings'); checkbox.setAttribute('data-client-action', 'settings');
    checkbox.addEventListener('change', () => { if (!checkbox.disabled) void act(client.id, 'settings', { autoSync: checkbox.checked }); });
    auto.append(checkbox, element('span', '自动同步模型目录')); card.append(auto);
    if (supported(client, 'settings')) card.append(element('p', client.mode === 'gateway'
      ? '自动同步只更新本网关发布的模型配置；菜单何时刷新由客户端决定。'
      : '启用网关后，按此设置自动同步模型目录。', 'footnote'));
    if (['codebuddy', 'workbuddy'].includes(client.id)) card.append(element('p', '启用网关会添加本桥模型；恢复原生仅撤销本桥模型，原模型仍保留。当前会话需在客户端选择模型。', 'client-control-note'));
    if (client.reloadNote) card.append(element('p', client.reloadNote, 'client-control-note'));
    if (client.reason) card.append(element('p', client.reason, 'client-control-reason'));
    return card;
  }
  function render() {
    panel.replaceChildren();
    const heading = element('div', undefined, 'panel-heading'), title = element('div');
    title.append(element('div', 'CLIENTS', 'eyebrow'), element('h2', '本机客户端'));
    const reload = element('button', '刷新状态', 'button secondary'); reload.type = 'button'; reload.disabled = busy || Boolean(pending);
    reload.addEventListener('click', () => { void refresh(); }); heading.append(title, reload); panel.append(heading);
    panel.append(element('p', '集中启动客户端、管理网关接入和同步模型目录。模式设置与客户端当前会话分别生效。', 'panel-copy'));
    const error = element('p', errorText, 'gateway-error'); error.hidden = !errorText; error.setAttribute('role', 'status'); panel.append(error);
    const status = element('p', statusText, 'inline-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
    if (!snapshot) { panel.append(element('p', readFailed ? '刷新后重试读取客户端状态。' : '正在读取本机客户端…', 'panel-copy')); return; }
    if (readFailed) panel.append(element('p', '显示上次读取的状态；操作已暂停，请刷新状态后再试。', 'footnote'));
    const list = element('div', undefined, 'client-control-list');
    for (const client of snapshot.clients) list.append(clientCard(client));
    if (!snapshot.clients.length) list.append(element('p', '当前节点未提供可管理的本机客户端。', 'panel-copy'));
    panel.append(list);
  }
  render(); void refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy && !panel.contains(document.activeElement)) void refresh(); });
  window.addEventListener('hashchange', () => { if (location.hash === '#connections' && !busy && !panel.contains(document.activeElement)) void refresh(); });
  setInterval(() => { if (!document.hidden && !busy && !panel.contains(document.activeElement)) void refresh(); }, 15000);
})();
