import { setTimeout as delay } from 'node:timers/promises';
import { EmployeeOAuthClient } from '../src/employee-oauth.mjs';

if (process.argv.includes('--help')) {
  console.log('node scripts/probe-employee-auth.mjs\n仅验证员工 OAuth 登录和一次续期；不调用模型，不保存或输出 Token。');
} else {
  const client = new EmployeeOAuthClient();
  let authenticated = false;
  try {
    const login = await client.begin();
    console.log('请打开官方页面，选择 IOA，使用你本人的员工身份登录。本探针最多等待 5 分钟。');
    console.log(login.authUrl);
    console.log('凭证仅保留在此进程内；身份验证后会测试一次官方续期。');
    while (Date.now() < login.expiresAt) {
      const result = await client.poll(login);
      if (!result.pending) {
        authenticated = true;
        console.log(JSON.stringify({ authenticated: true, username: result.identity.username,
          expiresAt: new Date(result.expiresAt).toISOString() }));
        const refreshed = await client.refresh();
        console.log(JSON.stringify({ refreshVerified: true, sameEmployee: refreshed.identity.uid === result.identity.uid,
          expiresAt: new Date(refreshed.expiresAt).toISOString(), modelInferencePerformed: false }));
        break;
      }
      await delay(1000);
    }
    if (!authenticated) throw new Error('login_expired');
  } catch (error) {
    // Remote response bodies, HTTP headers and credential objects are never printed.
    console.error(JSON.stringify({ authenticated, refreshVerified: false,
      code: error.code || 'probe_error', status: error.status || 0 }));
    process.exitCode = 1;
  }
}
