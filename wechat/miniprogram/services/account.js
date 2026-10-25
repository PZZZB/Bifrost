const config = require('../config');
const SESSION_KEY = 'bifrost-account-session-v1';
const ROUTES = {
  login: ['POST', '/account/v1/login'], me: ['GET', '/account/v1/me'],
  logout: ['POST', '/account/v1/logout'], resetKey: ['POST', '/account/v1/api-key'],
  revokeKey: ['DELETE', '/account/v1/api-key'], deleteAccount: ['DELETE', '/account/v1/me'],
};
function clearSession() { wx.removeStorageSync(SESSION_KEY); }
function session() { return wx.getStorageSync(SESSION_KEY) || ''; }
function configured() {
  return config.transport === 'cloud' ? !!config.cloudEnv && !!wx.cloud : /^https:\/\/[^/]+$/.test(config.requestOrigin);
}
function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve,
    fail: () => reject(new Error('网络暂时不可用，请稍后重试。')) }));
}
async function request(action, body) {
  if (!configured()) throw new Error('小程序尚未完成服务配置，请联系管理员。');
  const route = ROUTES[action];
  if (!route) throw new Error('操作不支持。');
  const sessionToken = action === 'login' ? '' : session();
  let response;
  if (config.transport === 'cloud') {
    try {
      const result = await wx.cloud.callFunction({ name: config.cloudFunction,
        data: { action, body: body || {}, sessionToken } });
      response = result.result;
    } catch { throw new Error('账号服务暂时不可用，请稍后重试。'); }
  } else {
    const [method, path] = route;
    const result = await wxCall('request', { url: config.requestOrigin + path, method,
      ...(method === 'POST' ? { data: body || {} } : {}), timeout: 15000,
      header: { 'content-type': 'application/json', ...(sessionToken ? { authorization: 'Bearer ' + sessionToken } : {}) } });
    response = { status: result.statusCode, data: result.data };
  }
  if (!response || !response.data || typeof response.data !== 'object') throw new Error('账号服务返回异常，请稍后重试。');
  if (response.status !== 200) {
    if (response.status === 401 && action !== 'login') clearSession();
    const error = new Error(typeof response.data.error?.message === 'string'
      ? response.data.error.message.slice(0, 120) : '操作未完成，请稍后重试。');
    error.code = response.data.error?.code;
    throw error;
  }
  return response.data;
}
async function login(inviteCode) {
  const result = await wxCall('login', { timeout: 10000 });
  if (!result.code) throw new Error('微信登录未完成，请重试。');
  const data = await request('login', { code: result.code, inviteCode, privacyAccepted: true });
  wx.setStorageSync(SESSION_KEY, data.sessionToken);
  return data;
}
module.exports = { configured, session, clearSession, request, login };
