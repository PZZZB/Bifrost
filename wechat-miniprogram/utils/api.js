const config = require('../config');

function configuredRoot() {
  const root = String(config.publicRoot || '').replace(/\/+$/, '');
  const match = root.match(/^https:\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?$/);
  if (!match || match[1] === 'localhost' || /^\d+(?:\.\d+){3}$/.test(match[1]) || /\.example$/i.test(match[1])) {
    throw new Error('请先在 config.js 配置已备案并已加入 request 合法域名的 HTTPS 服务地址。');
  }
  return root;
}

function api(path, options = {}) {
  let root;
  try { root = configuredRoot(); } catch (error) { return Promise.reject(error); }
  const header = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const token = getApp().globalData.sessionToken;
  if (options.auth !== false && token) header.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${root}/portal/api/${path}`,
      method: options.method || 'GET',
      data: options.data,
      header,
      timeout: 15000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300 && response.data && typeof response.data === 'object') {
          resolve(response.data); return;
        }
        if (response.statusCode === 401) getApp().globalData.sessionToken = null;
        const payload = response.data && response.data.error;
        const message = payload && typeof payload.message === 'string' && payload.message.length <= 1000
          ? payload.message : '操作未完成，请稍后重试。';
        const error = new Error(message); error.status = response.statusCode; error.code = payload && payload.code;
        reject(error);
      },
      fail() { reject(new Error('无法连接用户中心，请检查网络和 HTTPS 服务配置。')); },
    });
  });
}

module.exports = { api, configuredRoot };
