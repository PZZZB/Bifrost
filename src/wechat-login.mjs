/** Only the server exchanges a one-use WeChat login code. Never return the
 * platform session key or log the URL, which contains the application secret. */
export function createWeChatLogin({ appId, appSecret, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!/^wx[a-f0-9]{16}$/.test(appId) || typeof appSecret !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(appSecret)) throw new TypeError('Invalid WeChat configuration.');
  return async code => {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(code)) {
      throw Object.assign(new Error('Invalid login code.'), { status: 400, code: 'invalid_login_code' });
    }
    const unavailable = () => Object.assign(new Error('WeChat login unavailable.'), { status: 502, code: 'wechat_unavailable' });
    let response;
    try {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      for (const [name, value] of Object.entries({ appid: appId, secret: appSecret,
        js_code: code, grant_type: 'authorization_code' })) url.searchParams.set(name, value);
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' } });
      if (!response.ok) throw unavailable();
      const parts = []; let size = 0;
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > 16_384) throw unavailable();
        parts.push(Buffer.from(bytes));
      }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if ([40029, 40163, 40226].includes(data.errcode)) {
        throw Object.assign(new Error('Please sign in again.'), { status: 401, code: 'wechat_login_rejected' });
      }
      if (data.errcode && data.errcode !== 0 || typeof data.openid !== 'string' ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(data.openid) || typeof data.session_key !== 'string' ||
          !data.session_key || data.session_key.length > 256) throw unavailable();
      return data.openid;
    } catch (error) {
      if (error.code === 'wechat_login_rejected') throw error;
      throw unavailable();
    } finally { await response?.body?.cancel().catch(() => {}); }
  };
}
