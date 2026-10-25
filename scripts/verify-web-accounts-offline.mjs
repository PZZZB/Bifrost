import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeWebAccounts, WebAccountStore } from '../src/web-account-store.mjs';
import { createWebAccounts } from '../src/web-accounts.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';

// Local fixture only: new browser profile, self-signed loopback TLS, simulated
// model upstream, disposable accounts. Never loads production configuration.
let browser, gateway, front, temporary;
try {
  const output = resolve(process.argv[2] || '.state/web-account-browser');
  let playwright;
  if (process.env.BIFROST_PLAYWRIGHT_MODULE) {
    if (!isAbsolute(process.env.BIFROST_PLAYWRIGHT_MODULE)) throw new Error('Playwright module must be absolute.');
    playwright = await import(pathToFileURL(process.env.BIFROST_PLAYWRIGHT_MODULE).href);
  } else playwright = await import('playwright');
  playwright = playwright.chromium ? playwright : playwright.default;
  temporary = await mkdtemp(join(tmpdir(), 'bifrost-web-browser-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=accounts.localhost',
    '-keyout', join(temporary, 'tls.key'), '-out', join(temporary, 'tls.pem')], { stdio: 'ignore' });
  let targetPort;
  front = https.createServer({ key: await readFile(join(temporary, 'tls.key')), cert: await readFile(join(temporary, 'tls.pem')) }, (req, res) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); }); req.pipe(outgoing);
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const origin = 'https://accounts.localhost:' + front.address().port;
  await initializeWebAccounts(join(temporary, 'accounts'));
  const store = new WebAccountStore({ directory: join(temporary, 'accounts') });
  const webAccounts = createWebAccounts({ store, publicOrigin: origin, apiBaseUrl: origin + '/v1',
    csrfKey: (await readFile(join(temporary, 'accounts/csrf.key'), 'utf8')).trim() });
  gateway = createExternalClaudeGateway({ gatewayKey: randomBytes(32).toString('base64url'), sessionKey: randomBytes(32).toString('base64url'),
    getClients: () => store.clients(), allowedHosts: [new URL(origin).host], webAccounts,
    fetchImpl: async () => Response.json({ data: [] }) });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); targetPort = gateway.address().port;
  await mkdir(output, { recursive: true, mode: 0o700 });
  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.BIFROST_CHROME_PATH ? { executablePath: process.env.BIFROST_CHROME_PATH } : {}),
    args: ['--disable-background-networking', '--host-resolver-rules=MAP accounts.localhost 127.0.0.1', '--proxy-server=direct://'] });
  const checks = [];
  const password = 'Offline browser password ' + randomBytes(12).toString('base64url');
  for (const [name, viewport, userAgent] of [
    ['desktop', { width: 1280, height: 980 }, undefined],
    ['mobile', { width: 390, height: 844 }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.64'],
  ]) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...(userAgent ? { userAgent, isMobile: true, hasTouch: true } : {}) });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.name));
    const { inviteCode } = await store.invite();
    await page.goto(origin + '/account/?from=singlemessage&isappinstalled=0#invite=' + inviteCode);
    await page.locator('#auth-view').waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#invite').inputValue(), inviteCode);
    await page.fill('#invite', '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(output, name + '-registration.png'), fullPage: true });
    await page.fill('#username', name + 'owner'); await page.fill('#password', password);
    await page.fill('#password-confirm', password); await page.fill('#invite', inviteCode); await page.check('#consent');
    await page.click('#submit'); await page.locator('#account-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#account-name').textContent(), name + 'owner');
    const cookies = await context.cookies();
    assert.ok(cookies.filter(cookie => cookie.name.startsWith('__Host-bifrost_')).every(cookie => cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict'));
    assert.ok(!await page.evaluate(() => localStorage.length || sessionStorage.length));
    const firstKey = await page.locator('#api-key').inputValue(); assert.match(firstKey, /^bfk_/);
    page.once('dialog', dialog => dialog.accept()); await page.click('#reset-key');
    await page.waitForFunction(old => document.getElementById('api-key').value && document.getElementById('api-key').value !== old, firstKey);
    const secondKey = await page.locator('#api-key').inputValue();
    const request = key => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: targetPort, path: '/v1/models',
        headers: { host: new URL(origin).host, authorization: 'Bearer ' + key } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(await request(firstKey), 401); assert.equal(await request(secondKey), 200);
    await page.goto(origin + '/account/privacy'); await page.goBack();
    await page.locator('#account-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#api-key').inputValue(), '');
    await page.click('#logout'); await page.locator('#auth-view').waitFor({ state: 'visible' });
    await page.click('#login-tab'); await page.fill('#username', name + 'owner'); await page.fill('#password', password); await page.click('#submit');
    await page.locator('#account-view').waitFor({ state: 'visible' }); await page.reload();
    await page.locator('#account-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#api-key').inputValue(), '');
    assert.deepEqual(errors, []);
    checks.push({ viewport: name, registration: true, rotation_and_old_key_rejection: true,
      logout_and_login: true, reload_keeps_session: true, navigation_hides_key: true, no_storage_credentials: true, no_page_errors: true });
    await context.close();
  }
  const report = { passed: true, fixture_only: true, checks, real_wechat_phone_verified: false, real_model_requests: 0 };
  await writeFile(join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(report) + '\n');
} catch (error) {
  process.stderr.write('Offline web account browser verification failed: ' + error.name + ': ' + error.message.replace(/bfi_[A-Za-z0-9_-]+|bfk_[A-Za-z0-9_-]+|bws_[A-Za-z0-9_-]+/g, '[REDACTED]') + '\n');
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of [front, gateway]) if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
