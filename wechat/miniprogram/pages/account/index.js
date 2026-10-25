const account = require('../../services/account');
Page({
  data: { configured: false, account: null, apiBaseUrl: '', apiKey: '', inviteCode: '', consent: false,
    busy: false, error: '' },
  async onShow() {
    this.setData({ configured: account.configured() });
    if (account.session()) await this.perform(async () => {
      const data = await account.request('me'); this.setData({ account: data.account, apiBaseUrl: data.apiBaseUrl });
    });
  },
  onHide() { this.setData({ apiKey: '' }); },
  onUnload() { this.setData({ apiKey: '' }); },
  onInvite(event) { this.setData({ inviteCode: event.detail.value.trim() }); },
  onConsent(event) { this.setData({ consent: event.detail.value.includes('accepted') }); },
  onPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }); },
  async perform(operation) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await operation(); }
    catch (error) {
      if (!account.session()) this.setData({ account: null, apiKey: '', apiBaseUrl: '' });
      this.setData({ error: error.message || '操作未完成，请稍后重试。' });
    } finally { this.setData({ busy: false }); }
  },
  async onLogin() {
    if (!this.data.consent) { this.setData({ error: '请先阅读并同意账号隐私说明。' }); return; }
    await this.perform(async () => {
      const data = await account.login(this.data.inviteCode);
      this.setData({ account: data.account, apiBaseUrl: data.apiBaseUrl, apiKey: data.apiKey || '', inviteCode: '' });
    });
  },
  confirm(content) {
    return new Promise(resolve => wx.showModal({ title: '请确认', content,
      success: result => resolve(result.confirm), fail: () => resolve(false) }));
  },
  async onResetKey() {
    if (this.data.busy || !await this.confirm('重置后，旧 API key 将无法发起新请求。需要更新各客户端的配置。')) return;
    await this.perform(async () => {
      const data = await account.request('resetKey'); this.setData({ account: data.account, apiKey: data.apiKey });
    });
  },
  async onRevokeKey() {
    if (this.data.busy || !await this.confirm('停用后，当前 API key 将无法发起新请求。')) return;
    await this.perform(async () => {
      const data = await account.request('revokeKey'); this.setData({ account: data.account, apiKey: '' });
    });
  },
  onCopyUrl() { if (this.data.apiBaseUrl) wx.setClipboardData({ data: this.data.apiBaseUrl }); },
  onCopyKey() { if (this.data.apiKey) wx.setClipboardData({ data: this.data.apiKey }); },
  async onLogout() {
    await this.perform(async () => {
      await account.request('logout'); account.clearSession();
      this.setData({ account: null, apiKey: '', apiBaseUrl: '', consent: false });
    });
  },
  async onDeleteAccount() {
    if (this.data.busy || !await this.confirm('注销后将删除本账号记录并停用 API key。重新注册需要新的邀请码。')) return;
    await this.perform(async () => {
      await account.request('deleteAccount'); account.clearSession();
      this.setData({ account: null, apiKey: '', apiBaseUrl: '', consent: false });
    });
  },
});
