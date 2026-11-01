(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let mode = 'register', csrf = '', busy = false, revealedKey = '', ready = false;
  let currentAccount = null, keyEpoch = 0;
  const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invitation && /^bfi_[A-Za-z0-9_-]{43}$/.test(invitation)) {
    $('invite').value = invitation;
    history.replaceState(null, '', location.pathname + location.search);
  }
  const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
  function clearKey() {
    keyEpoch++; revealedKey = ''; $('api-key').value = ''; $('api-key').type = 'password';
    $('view-key').textContent = '查看'; $('view-key').setAttribute('aria-pressed', 'false');
    $('view-key').setAttribute('aria-label', '显示 API key');
    $('key-reveal').hidden = !currentAccount?.apiKeyConfigured || !currentAccount?.apiKeyRevealSupported;
  }
  function authMode(next) {
    if (busy) return;
    mode = next; showError(''); $('status').textContent = '';
    $('register-tab').setAttribute('aria-pressed', String(mode === 'register'));
    $('login-tab').setAttribute('aria-pressed', String(mode === 'login'));
    $('registration-fields').hidden = mode !== 'register';
    $('auth-form').action = '/account/web/v1/' + mode;
    $('email').type = mode === 'register' ? 'email' : 'text';
    $('email').name = mode === 'register' ? 'email' : 'username';
    $('email-label').textContent = mode === 'register' ? '邮箱' : '邮箱或原用户名';
    $('email-note').textContent = mode === 'register' ? '请使用自己的邮箱。只检查地址格式和域名收信配置，不发送验证码。' : '旧版用户名账号可直接使用原用户名登录。';
    for (const id of ['password-confirm', 'invite', 'consent']) $(id).required = mode === 'register';
    $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('password').value = ''; $('password-confirm').value = '';
    $('form-title').textContent = mode === 'register' ? '创建你的网关账号' : '欢迎回来';
    $('form-note').textContent = mode === 'register' ? '使用管理员提供的邀请码开通。' : '登录后管理你的连接信息和密钥。';
    $('submit').textContent = mode === 'register' ? '注册并获取连接信息' : '登录';
  }
  function render(data) {
    const account = data.account; currentAccount = account ?? null; clearKey();
    $('loading').hidden = true; $('auth-view').hidden = !!account; $('account-view').hidden = !account;
    if (!account) { clearKey(); return; }
    $('account-name').textContent = account.username;
    $('email-status').hidden = !account.email;
    $('account-limits').textContent = `最多 ${account.limits.maxConcurrent} 个并发请求 · 每分钟 ${account.limits.requestsPerMinute} 次请求`;
    $('base-url').value = data.apiBaseUrl;
    $('key-state').textContent = !account.apiKeyConfigured ? '当前没有启用的 API key。'
      : account.apiKeyRecoverable ? '密钥已设置，可随时查看或复制。'
      : account.apiKeyRevealSupported ? '旧密钥尚未留存原文；从已配置的客户端使用一次后，即可在这里查看。'
      : '密钥已设置；此部署尚未启用再次查看。';
    $('key-note').textContent = account.apiKeyRevealSupported ? '默认隐藏。需要时可查看或复制，无需更换密钥。'
      : '请保存到客户端；此部署尚未启用再次查看。';
    $('reset-key').textContent = account.apiKeyConfigured ? '重置 API key' : '生成 API key';
    $('revoke-key').hidden = !account.apiKeyConfigured;
    if (data.apiKey && !document.hidden) { revealedKey = data.apiKey; $('api-key').value = revealedKey; $('key-reveal').hidden = false; }
  }
  async function ensureKey() {
    if (revealedKey) return revealedKey;
    if (!currentAccount?.apiKeyRevealSupported) throw new Error('此部署尚未启用密钥查看，请更新服务。');
    const epoch = keyEpoch, accountId = currentAccount.id;
    const data = await request('api-key/reveal');
    if (epoch !== keyEpoch || document.hidden || currentAccount?.id !== accountId) return '';
    if (data.account?.id !== accountId || !/^bfk_[A-Za-z0-9_-]{43}$/.test(data.apiKey || '')) throw new Error('密钥响应异常，请稍后重试。');
    render(data); return revealedKey;
  }
  async function request(action, body, method = 'POST') {
    let response, data;
    try {
      response = await fetch('/account/web/v1/' + action, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'x-bifrost-csrf': csrf } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
    } catch { throw new Error('网络暂时不可用，请稍后重试。'); }
    if (response.status === 429) {
      const value = response.headers.get('retry-after');
      const seconds = /^[1-9]\d{0,3}$/.test(value || '') && Number(value) <= 3600 ? Number(value) : null;
      const error = new Error(seconds ? `服务繁忙，请 ${seconds} 秒后再试。` : '服务繁忙，请稍后再试。');
      error.code = 'rate_limited'; throw error;
    }
    if ([502, 503, 504].includes(response.status)) throw new Error('服务暂时不可用，请稍后再试。');
    try { data = await response.json(); }
    catch { throw new Error('服务响应异常，请稍后再试。'); }
    if (!response.ok) {
      if (response.status === 401 && action !== 'login') { clearKey(); render({}); }
      const error = new Error(typeof data?.error?.message === 'string' ? data.error.message : '操作未完成，请稍后重试。');
      error.code = data?.error?.code; throw error;
    }
    return data;
  }
  async function boot() {
    $('loading').hidden = false;
    try {
      const data = await request('session', undefined, 'GET'); csrf = data.csrfToken; render(data);
      ready = true; $('retry-connect').hidden = true;
    } finally { $('loading').hidden = true; }
  }
  async function perform(action) {
    if (busy) return;
    busy = true; showError(''); $('status').textContent = '';
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    try { await action(); }
    catch (error) {
      if (error.code === 'csrf_rejected') { try { await boot(); } catch {} }
      showError(error.message || '操作未完成，请稍后重试。');
      if (!ready) $('retry-connect').hidden = false;
    } finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
  }
  $('register-tab').addEventListener('click', () => authMode('register'));
  $('retry-connect').addEventListener('click', () => void perform(boot));
  $('login-tab').addEventListener('click', () => authMode('login'));
  $('toggle-password').addEventListener('click', () => {
    const visible = $('password').type === 'password'; $('password').type = visible ? 'text' : 'password';
    $('toggle-password').textContent = visible ? '隐藏' : '显示';
    $('toggle-password').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  });
  $('auth-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('auth-form').reportValidity()) return;
    if (mode === 'register' && $('password').value !== $('password-confirm').value) { showError('两次输入的密码不一致。'); return; }
    void perform(async () => {
      const data = await request(mode, { [mode === 'register' ? 'email' : 'username']: $('email').value.trim(), password: $('password').value,
        ...(mode === 'register' ? { inviteCode: $('invite').value.trim(), privacyAccepted: $('consent').checked } : {}) });
      $('password').value = ''; $('password-confirm').value = ''; $('invite').value = ''; render(data);
    });
  });
  $('reset-key').addEventListener('click', () => {
    if (busy || !confirm('生成新密钥后，旧 API key 将无法发起新请求。需要更新各客户端配置。')) return;
    void perform(async () => { clearKey(); render(await request('api-key')); });
  });
  $('revoke-key').addEventListener('click', () => {
    if (busy || !confirm('停用后，当前 API key 将无法发起新请求。')) return;
    void perform(async () => { clearKey(); render(await request('api-key', undefined, 'DELETE')); });
  });
  $('logout').addEventListener('click', () => {
    authMode('login'); void perform(async () => { await request('logout'); clearKey(); render({}); });
  });
  $('delete-account').addEventListener('click', () => {
    if (busy || !confirm('注销会删除本账号记录并停用密钥。重新注册需要新的邀请码。确定注销？')) return;
    void perform(async () => { await request('me', undefined, 'DELETE'); clearKey(); render({}); });
  });
  async function copy(id, value) {
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(value); $('status').textContent = '已复制。';
    } catch {
      const input = $(id), previousType = input.type; input.type = 'text'; input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
      const copied = document.execCommand('copy');
      if (copied) input.type = previousType;
      else if (id === 'api-key') { $('view-key').textContent = '隐藏'; $('view-key').setAttribute('aria-pressed', 'true'); $('view-key').setAttribute('aria-label', '隐藏 API key'); }
      $('status').textContent = copied ? '已复制。' : '请长按输入框中的内容手动复制。';
    }
  }
  $('copy-url').addEventListener('click', () => void copy('base-url', $('base-url').value));
  $('view-key').addEventListener('click', () => {
    if (busy) return;
    if ($('api-key').type === 'text') { clearKey(); return; }
    void perform(async () => {
      if (!await ensureKey()) return;
      $('api-key').type = 'text'; $('view-key').textContent = '隐藏';
      $('view-key').setAttribute('aria-pressed', 'true'); $('view-key').setAttribute('aria-label', '隐藏 API key');
    });
  });
  $('copy-key').addEventListener('click', () => void perform(async () => { const key = await ensureKey(); if (key) await copy('api-key', key); }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKey(); });
  window.addEventListener('pagehide', clearKey);
  void perform(boot);
})();
