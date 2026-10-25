(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let mode = 'register', csrf = '', busy = false, revealedKey = '';
  const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invitation && /^bfi_[A-Za-z0-9_-]{43}$/.test(invitation)) {
    $('invite').value = invitation;
    history.replaceState(null, '', location.pathname + location.search);
  }
  const showError = message => { $('error').textContent = message; $('error').hidden = !message; };
  function clearKey() { revealedKey = ''; $('api-key').value = ''; $('key-reveal').hidden = true; }
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
    if (!data.apiKey) clearKey();
    const account = data.account;
    $('loading').hidden = true; $('auth-view').hidden = !!account; $('account-view').hidden = !account;
    if (!account) { clearKey(); return; }
    $('account-name').textContent = account.username;
    $('email-status').hidden = !account.email;
    $('account-limits').textContent = `最多 ${account.limits.maxConcurrent} 个并发请求 · 每分钟 ${account.limits.requestsPerMinute} 次请求`;
    $('base-url').value = data.apiBaseUrl;
    $('key-state').textContent = account.apiKeyConfigured ? '密钥已设置，完整内容不会再次显示。' : '当前没有启用的 API key。';
    $('reset-key').textContent = account.apiKeyConfigured ? '重置 API key' : '生成 API key';
    $('revoke-key').hidden = !account.apiKeyConfigured;
    if (data.apiKey) { revealedKey = data.apiKey; $('api-key').value = revealedKey; $('api-key').type = 'password'; $('key-reveal').hidden = false; }
  }
  async function request(action, body, method = 'POST') {
    let response, data;
    try {
      response = await fetch('/account/web/v1/' + action, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'x-bifrost-csrf': csrf } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}) });
      data = await response.json();
    } catch { throw new Error('网络暂时不可用，请稍后重试。'); }
    if (!response.ok) {
      if (response.status === 401 && action !== 'login') { clearKey(); render({}); }
      const error = new Error(typeof data.error?.message === 'string' ? data.error.message : '操作未完成，请稍后重试。');
      error.code = data.error?.code; throw error;
    }
    return data;
  }
  async function boot() {
    const data = await request('session', undefined, 'GET'); csrf = data.csrfToken; render(data);
  }
  async function perform(action) {
    if (busy) return;
    busy = true; showError(''); $('status').textContent = '';
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    try { await action(); }
    catch (error) {
      if (error.code === 'csrf_rejected') { try { await boot(); } catch {} }
      showError(error.message || '操作未完成，请稍后重试。');
    } finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
  }
  $('register-tab').addEventListener('click', () => authMode('register'));
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
      const input = $(id); input.type = 'text'; input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
      $('status').textContent = document.execCommand('copy') ? '已复制。' : '请长按输入框中的内容手动复制。';
    }
  }
  $('copy-url').addEventListener('click', () => void copy('base-url', $('base-url').value));
  $('copy-key').addEventListener('click', () => void copy('api-key', revealedKey));
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKey(); });
  window.addEventListener('pagehide', clearKey);
  void perform(boot).finally(() => { $('loading').hidden = true; });
})();
