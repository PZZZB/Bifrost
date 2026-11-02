import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError, redact } from './storage.mjs';
import { backendPath, keyMatches, readBody, SseInspector } from './gateway.mjs';
import { B_MODELS, resolveBModel } from './models.mjs';

const STATIC_FILES = { '/': ['index.html', 'text/html; charset=utf-8'],
  '/account-pool.js': ['account-pool.js', 'text/javascript; charset=utf-8'],
  '/account-pool.css': ['account-pool.css', 'text/css; charset=utf-8'],
  '/client-controls.js': ['client-controls.js', 'text/javascript; charset=utf-8'],
  '/client-controls.css': ['client-controls.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createBridgeServer({ backend, gateway, integration, state, publicDir, baseUrl,
  usageLedger = null, accountQuotas = null, providerQuotas = null, requestDiagnostics = null, clientAdmin = null, accountPool = null,
  codeBuddyService = null, serviceControl = null, modelPolicy = null, modelDiscovery = null, cursorService = null, cursorProvider = null,
  ownerClientApi = null, clientControls = null,
  getWithStatus = async () => ({ configured: false, running: false,
    model: { id: 'claude-opus-5-5', name: 'With · Opus 5.5' },
    gateway: { baseUrl: 'http://192.168.168.1:43157' },
    provider: { authenticated: null }, vm: { address: '192.168.168.10', configured: false },
    manualVerification: true }),
  defaultModel = 'B-gpt-6.1-sol', clientVersion = '0.162.0', fetchImpl = fetch,
  saveVerification = async () => {}, initialVerification = { status: 'not_run' } }) {
  const csrf = randomBytes(32).toString('base64url');
  const browserSession = randomBytes(32).toString('base64url');
  const base = new URL(baseUrl);
  const allowedHosts = new Set([base.host, `localhost:${base.port}`]);
  let verification = initialVerification;
  let verifying = null;
  let adminBusy = false;
  let adminOperation = null;

  async function requireCodexGateway() {
    if (!backend) throw new BridgeError('请先添加并验证独立订阅账号。', 503);
    if (verifying) throw new BridgeError('请等待当前推理验证结束。', 409);
    const token = await backend.credentials();
    if (verification.status !== 'passed' || verification.accountId !== token.accountId || verification.accountEmail !== token.email) {
      throw new BridgeError('请先完成账户 B 的真实推理验证。', 409);
    }
  }

  function checkBrowser(req) {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith('bridge_session='))?.slice('bridge_session='.length);
    if (!keyMatches(cookie, browserSession)) throw new BridgeError('请先打开本机管理页面。', 401);
    if (req.method !== 'GET') {
      if (!keyMatches(req.headers['x-bridge-csrf'], csrf)) throw new BridgeError('管理请求校验失败，请刷新页面。', 403);
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new BridgeError('Origin 无效。', 403); }
        if (origin.protocol !== 'http:' || !allowedHosts.has(origin.host)) throw new BridgeError('拒绝跨站管理请求。', 403);
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError('拒绝跨站管理请求。', 403);
    }
  }

  async function bodyJson(req, limit = 64 * 1024) {
    const bytes = await readBody(req, limit);
    if (!bytes.length) return {};
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new BridgeError('请求不是有效 JSON。'); }
  }

  async function models() {
    const data = await gateway.readBCatalog(`/models?client_version=${encodeURIComponent(clientVersion)}`);
    return { models: B_MODELS.filter(alias => data.models?.some(model => model.slug === alias.upstream))
      .map(({ id, name }) => ({ id, name })) };
  }

  async function verify(model) {
    const credentials = await backend.credentials();
    verification = { status: 'running', accountEmail: credentials.email };
    try {
      const before = await backend.limits().catch(() => null);
      const response = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST', signal: AbortSignal.timeout(180_000),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.gatewayKey}`,
          'originator': 'codex_account_bridge', 'user-agent': `codex-account-bridge/0.1.0 codex/${clientVersion}` },
        body: JSON.stringify({ model, instructions: 'You are verifying a private Codex connection.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: Account B connected.' }] }],
          tools: [], store: false, stream: true }),
      });
      if (!response.ok) {
        let detail = '';
        try { const data = await response.json(); detail = data.error?.message ?? ''; } catch {}
        throw new BridgeError(`真实推理未完成（HTTP ${response.status}）。${redact(detail)}`, 502);
      }
      let text = '', completed = null, failure = null;
      const sse = new SseInspector((event) => {
        if (event.type === 'response.output_text.delta') text += event.delta ?? '';
        if (event.type === 'response.completed') completed = event.response;
        if (event.type === 'response.failed' || event.type === 'error') failure = event.response?.error?.message ?? event.error?.message ?? event.message;
      });
      for await (const bytes of response.body) sse.push(bytes);
      if (!text && completed) text = (completed.output ?? []).flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text').map((item) => item.text).join('');
      if (completed?.status !== 'completed' || !text.trim()) {
        throw new BridgeError(redact(failure ?? '未收到已完成且非空的模型回复。'), 502);
      }
      const after = await backend.limits().catch(() => null);
      await backend.credentials();
      verification = { status: 'passed', model, text: text.slice(0, 2000), accountEmail: credentials.email,
        accountId: credentials.accountId, checkedAt: new Date().toISOString(),
        usage: completed.usage ?? null, rateLimitsBefore: before, rateLimitsAfter: after,
        responseId: completed.id ?? null };
    } catch (error) {
      verification = { status: 'failed', model, error: redact(error.message), accountEmail: credentials.email,
        checkedAt: new Date().toISOString() };
    }
    await saveVerification(verification);
    return verification;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (!allowedHosts.has(req.headers.host)) throw new BridgeError('Host 不允许。', 403);
      const url = new URL(req.url, base);
      if (url.origin !== base.origin) throw new BridgeError('请求目标不允许。', 403);
      if (backendPath(url.pathname)) { if (!gateway) throw new BridgeError('当前网关未启用此协议入口。', 404); await gateway.proxy(req, res, url); return; }
      if (ownerClientApi?.handles(url.pathname)) { await ownerClientApi.handle(req, res); return; }
      if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true, version: '0.1.0' }); return; }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        if (url.pathname === '/') res.setHeader('Set-Cookie', `bridge_session=${browserSession}; HttpOnly; SameSite=Strict; Path=/`);
        const content = await readFile(join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) throw new BridgeError('页面不存在。', 404);
      checkBrowser(req);
      const sourceManagement = accountPool?.rows?.().some(a => a.enabled && (a.kind === 'cursor' && cursorService && /^\/api\/cursor(?:\/|$)/.test(url.pathname)
        || a.kind === 'codebuddy' && codeBuddyService && /^\/api\/codebuddy(?:\/|$)/.test(url.pathname)));
      if (accountPool && !accountPool.capabilities().clientIntegration && !sourceManagement && !/^\/api\/(?:status$|node$|upstream-account-types$|upstream-accounts(?:\/|$)|client-admin(?:\/|$)|service\/|model-settings$|request-diagnostics(?:\/|$)|token-usage$)/.test(url.pathname)) {
        throw new BridgeError('当前网关未启用此管理能力。', 404, 'node_capability_unavailable');
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/client-controls') {
          if (!clientControls) throw new BridgeError('本机客户端管理尚未加载，请空闲重启网关后查看。', 503, 'client_controls_unavailable');
          json(res, 200, { ...await clientControls.snapshot(), csrfToken: csrf }); return;
        }
        if (url.pathname === '/api/node') { if (!accountPool) throw new BridgeError('账号池需重启加载。', 503); json(res, 200, { capabilities: accountPool.capabilities(), csrfToken: csrf }); return; }
        if (url.pathname === '/api/upstream-accounts' || url.pathname === '/api/upstream-account-types') {
          if (!accountPool) throw new BridgeError('账号池需重启加载。', 503);
          const snapshot = await accountPool.snapshot();
          json(res, 200, url.pathname.endsWith('-types') ? { accountTypes: snapshot.accountTypes } : { ...snapshot, csrfToken: csrf }); return;
        }
        if (url.pathname === '/api/client-admin/billing/unresolved') {
          if (!clientAdmin) throw new BridgeError('接入用户管理尚未就绪。', 503, 'client_admin_unavailable');
          json(res, 200, clientAdmin.outstanding({ limit: 50,
            ...(url.searchParams.has('accountId') ? { accountId: url.searchParams.get('accountId') } : {}),
            ...(url.searchParams.has('before') ? { before: url.searchParams.get('before') } : {}) })); return;
        }
        const billingHistory = /^\/api\/client-admin\/accounts\/([0-9a-f-]{36})\/billing\/history$/.exec(url.pathname);
        if (billingHistory) {
          if (!clientAdmin) throw new BridgeError('接入用户管理尚未就绪。', 503, 'client_admin_unavailable');
          json(res, 200, clientAdmin.history(billingHistory[1], { limit: 50, ...(url.searchParams.has('before') ? { before: url.searchParams.get('before') } : {}) })); return;
        }
        if (url.pathname === '/api/client-admin') {
          if (!clientAdmin) throw new BridgeError('当前后台尚未启用接入用户管理，请重启加载。', 503, 'client_admin_unavailable');
          json(res, 200, await clientAdmin.snapshot()); return;
        }
        if (url.pathname === '/api/request-diagnostics' || url.pathname.startsWith('/api/request-diagnostics/')) {
          if (!requestDiagnostics) throw new BridgeError('当前后台尚未启用请求诊断。', 503, 'diagnostics_unavailable');
          if (url.pathname === '/api/request-diagnostics') {
            const rawLimit = url.searchParams.get('limit');
            if (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) throw new BridgeError('诊断记录数量必须介于 1 和 100。', 400);
            json(res, 200, await requestDiagnostics.snapshot({ limit: rawLimit === null ? 10 : Number(rawLimit) })); return;
          }
          const match = /^\/api\/request-diagnostics\/([A-Za-z0-9_-]{1,128})(\/export)?$/.exec(url.pathname);
          if (!match) throw new BridgeError('诊断记录不存在。', 404, 'diagnostic_not_found');
          const record = await (match[2] ? requestDiagnostics.exportReport(match[1]) : requestDiagnostics.detail(match[1]));
          if (!record) throw new BridgeError('诊断记录尚未保存或已超出保留范围。', 404, 'diagnostic_not_found');
          if (match[2]) res.setHeader('Content-Disposition', `attachment; filename="bifrost-request-${match[1]}.json"`);
          json(res, 200, match[2] ? record : { request: record }); return;
        }
        if (url.pathname === '/api/service/status') {
          if (!serviceControl) throw new BridgeError('当前运行版本尚未启用网页服务控制。', 503);
          json(res, 200, await serviceControl.status()); return;
        }
        if (url.pathname === '/api/model-settings') {
          if (!modelPolicy) throw new BridgeError('当前运行版本尚未启用模型管理。', 503);
          json(res, 200, accountPool ? await accountPool.modelSettings() : modelDiscovery ? await modelDiscovery.refresh() : modelPolicy.snapshot()); return;
        }
        if (url.pathname === '/api/cursor') {
          if (!cursorService) throw new BridgeError('Cursor 渠道尚未配置。', 503);
          json(res, 200, await cursorService.status()); return;
        }
        if (url.pathname === '/api/status') {
          if (accountPool && !accountPool.capabilities().clientIntegration) {
            json(res, 200, { csrfToken: csrf, ready: accountPool.catalog().some(m => m.enabled && m.available), version: '0.1.0',
              node: { capabilities: accountPool.capabilities() }, backend: null, integration: null, gateway: null }); return;
          }
          let backendError = null;
          try { await backend?.readAccount(); } catch (error) { backendError = redact(error.message); }
          let info;
          try { info = await integration.inspect(); }
          catch (error) { info = { installed: false, canInstall: false, reason: redact(error.message) }; }
          json(res, 200, { csrfToken: csrf, ready: !backendError, version: '0.1.0',
            gateway: { baseUrl, enabled: Boolean(state.enabled && state.pinnedAccount), ...gateway.metrics },
            backend: { running: backend?.rpc.running === true, account: backend?.account ?? null, login: backend?.login ?? {},
              pinnedAccount: backend?.publicBinding() ?? null, error: backendError }, integration: info, verification,
            ...(accountPool ? { node: { capabilities: accountPool.capabilities() } } : {}) });
          return;
        }
        if (url.pathname === '/api/models') { json(res, 200, await models()); return; }
        if (url.pathname === '/api/with') { json(res, 200, await getWithStatus()); return; }
        if (url.pathname === '/api/codebuddy') {
          const info = codeBuddyService ? await codeBuddyService.status() : {
            configured: false, running: false,
            model: { id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' },
            provider: { authenticated: false, ready: false, modelAvailable: false, username: null,
              transport: null, error: null, billing: { verified: false, employeeTokenMultiplier: null,
                sourceCredits: null, sourcePromotion: null } },
            gateway: { baseUrl: null, requests: 0, completed: 0, failed: 0, active: 0 },
            login: { state: 'idle', url: null, expiresAt: null, error: null }, manualVerification: true,
          };
          json(res, 200, info); return;
        }
        if (url.pathname === '/api/account-quotas') {
          if (!accountQuotas && !providerQuotas) throw new BridgeError('账号额度查询暂不可用。', 503);
          const codeBuddyVersion = codeBuddyService?.authorizationVersion, cursorVersion = cursorService?.authorizationVersion;
          const bVersion = typeof accountQuotas?.bindingKey === 'function' ? accountQuotas.bindingKey() : null;
          const [native, external] = await Promise.all([accountQuotas?.snapshot(), providerQuotas?.snapshot()]);
          const accounts = { ...native?.accounts, ...external?.accounts };
          const staleCard = (account) => ({ ...accounts[account], status: 'error', authenticated: null, identity: null,
            planType: null, windows: [], credits: null, spendControlReached: null, fetchedAt: null,
            error: `${account} 账号授权已变化，请重新查询。` });
          if (codeBuddyVersion !== codeBuddyService?.authorizationVersion) accounts.CodeBuddy = staleCard('CodeBuddy');
          if (cursorVersion !== cursorService?.authorizationVersion) accounts.Cursor = staleCard('Cursor');
          if (typeof accountQuotas?.bindingKey === 'function' && bVersion !== accountQuotas.bindingKey()) accounts.B = staleCard('B');
          json(res, 200, { timeZone: native?.timeZone ?? external?.timeZone ?? 'America/Los_Angeles',
            accounts }); return;
        }
        if (url.pathname === '/api/token-usage') {
          if (!usageLedger) throw new BridgeError('Token 统计暂不可用，请检查本机记录文件。', 503);
          const snapshot = usageLedger.snapshot();
          json(res, 200, { ...snapshot, error: gateway?.metrics.usageError ?? snapshot.error ?? null }); return;
        }
        if (url.pathname === '/api/traffic') {
          const threadId = url.searchParams.get('threadId');
          if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId ?? '')) throw new BridgeError('会话 ID 无效。');
          json(res, 200, { traffic: gateway.traffic(threadId) }); return;
        }
        if (url.pathname === '/api/usage') { json(res, 200, await backend.limits()); return; }
        if (url.pathname === '/api/integration') {
          const info = await integration.inspect();
          const providerId = [info.routing?.gatewayProviderId, info.providerId].find(value =>
            typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
            && !['openai', 'ollama', 'lmstudio'].includes(value)) ?? 'account_b';
          const toml = `[model_providers.${JSON.stringify(providerId)}]\nname = "Account A/B Bridge"\nbase_url = ${JSON.stringify(baseUrl)}\nmodel_catalog_url = ${JSON.stringify(`${baseUrl}/models`)}\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nhttp_headers = { "X-Account-Bridge-Key" = ${JSON.stringify(state.gatewayKey)} }\n`;
          json(res, 200, { toml, baseUrl, gatewayKey: state.gatewayKey }); return;
        }
        throw new BridgeError('管理接口不存在。', 404);
      }
      if (req.method !== 'POST') throw new BridgeError('请求方法不支持。', 405);
      if (serviceControl?.draining && url.pathname !== '/api/service/restart/cancel') {
        throw new BridgeError('网关正在重启，请恢复连接后再操作。', 503, 'gateway_restarting');
      }
      if (adminBusy) throw new BridgeError('另一个管理操作正在执行。', 409);
      adminBusy = true;
      adminOperation = url.pathname;
      try {
        const body = await bodyJson(req, url.pathname === '/api/model-settings' ? 1024 * 1024 : 64 * 1024);
        const localClient = /^\/api\/client-controls\/([a-z][a-z0-9-]{0,31})\/(launch|mode|sync|settings)$/.exec(url.pathname);
        if (localClient) {
          if (!clientControls) throw new BridgeError('本机客户端管理尚未加载，请空闲重启网关后查看。', 503, 'client_controls_unavailable');
          if (localClient[1] === 'codex' && localClient[2] === 'mode' && body?.mode === 'gateway') await requireCodexGateway();
          json(res, 200, { ...await clientControls.mutate(localClient[1], localClient[2], body), csrfToken: csrf }); return;
        }
        if (url.pathname === '/api/upstream-accounts') {
          if (!accountPool) throw new BridgeError('账号池需重启加载。', 503);
          json(res, 200, await accountPool.create(body)); return;
        }
        const upstreamAccount = /^\/api\/upstream-accounts\/([a-z0-9-]{1,96})$/.exec(url.pathname);
        if (upstreamAccount) {
          if (!accountPool) throw new BridgeError('账号池需重启加载。', 503);
          json(res, 200, await accountPool.update(upstreamAccount[1], body)); return;
        }
        if (url.pathname.startsWith('/api/client-admin/')) {
          if (!clientAdmin) throw new BridgeError('当前后台尚未启用接入用户管理，请重启加载。', 503, 'client_admin_unavailable');
          json(res, 200, await clientAdmin.mutate(url.pathname, body)); return;
        }
        if (url.pathname === '/api/service/restart/cancel') {
          if (!serviceControl) throw new BridgeError('当前运行版本尚未启用网页服务控制。', 503);
          if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BridgeError('取消排队只接受空对象。', 400);
          const cancelled = await serviceControl.cancel();
          if (!cancelled) throw new BridgeError('重启已开始，无法取消。', 409, 'restart_committed');
          json(res, 200, { cancelled: true }); return;
        }
        if (url.pathname === '/api/service/restart') {
          if (!serviceControl) throw new BridgeError('当前运行版本尚未启用网页服务控制。', 503);
          const result = await serviceControl.request(body);
          if (res.destroyed) { await serviceControl.cancel(); return; }
          res.once('close', () => { if (!res.writableFinished) void Promise.resolve(serviceControl.cancel()).catch(() => {}); });
          res.once('finish', () => { void serviceControl.activate(); });
          json(res, 202, result); return;
        }
        if (url.pathname === '/api/model-settings') {
          if (!modelPolicy) throw new BridgeError('当前运行版本尚未启用模型管理。', 503);
          const updated = await modelPolicy.update(body);
          void clientControls?.autoSync().catch(() => {});
          json(res, 200, updated); return;
        }
        if (url.pathname === '/api/cursor/login' || url.pathname === '/api/cursor/logout') {
          if (!cursorService) throw new BridgeError('Cursor 渠道尚未配置。', 503);
          // Invalidate credentials before waiting for any SDK cancellation.
          const clearing = cursorService.logout();
          await Promise.all([clearing, cursorProvider?.cancelAll()]);
          const result = url.pathname.endsWith('/login') ? await cursorService.beginLogin() : { ok: true };
          json(res, 200, result ?? { ok: true }); return;
        }
        if (url.pathname === '/api/codebuddy/login' || url.pathname === '/api/codebuddy/logout') {
          if (!codeBuddyService) throw new BridgeError('CodeBuddy 通道尚未配置。', 503);
          if (url.pathname === '/api/codebuddy/login') {
            const { url: loginUrl, expiresAt } = await codeBuddyService.beginLogin();
            json(res, 200, { url: loginUrl, expiresAt }); return;
          }
          await codeBuddyService.logout(); json(res, 200, { ok: true }); return;
        }
        if (url.pathname === '/api/verify') {
          if (!backend) throw new BridgeError('请先添加订阅账号并空闲重启服务。', 503);
          if (verifying) throw new BridgeError('推理验证正在执行。', 409);
          await backend.credentials();
          const model = body.model || defaultModel;
          if (!resolveBModel(model)) throw new BridgeError('请只选择新增的 B 模型进行 B 账户验证。');
          verification = { status: 'running' };
          verifying = verify(model).catch((error) => {
            verification = { status: 'failed', error: redact(error.message) };
          }).finally(() => { verifying = null; });
          json(res, 202, { status: 'running' }); return;
        }
        if (url.pathname === '/api/integration/mode') {
          if (body === null || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'mode')
            || !['official', 'gateway'].includes(body.mode)) {
            throw new BridgeError('切换连接只接受 mode：official 或 gateway。', 400);
          }
          if (typeof integration.switchMode !== 'function') {
            throw new BridgeError('当前后台尚未启用 Codex 连接切换，请重启网关加载。', 503, 'integration_mode_unavailable');
          }
          if (body.mode === 'gateway') await requireCodexGateway();
          let result;
          try { result = await integration.switchMode(body.mode); }
          catch (error) {
            const conflict = error?.code === 'INTEGRATION_CONFLICT';
            const known = ['INTEGRATION_CONFLICT', 'INTEGRATION_CONFIG_UNAVAILABLE',
              'INTEGRATION_STATE_INVALID', 'INTEGRATION_WRITE_FAILED'].includes(error?.code);
            throw new BridgeError(conflict
              ? 'Codex 配置已变化，切换未覆盖其他设置。请刷新页面后重试。'
              : 'Codex 未确认连接切换。请刷新页面检查配置后重试。',
              conflict ? 409 : 503, known ? error.code : 'integration_switch_failed');
          }
          json(res, 200, result); return;
        }
        if (verifying) throw new BridgeError('请等待当前推理验证结束。', 409);
        if (['/api/login', '/api/logout', '/api/bind', '/api/integration/install'].includes(url.pathname) && !backend) throw new BridgeError('请先添加订阅账号并空闲重启服务。', 503);
        if (url.pathname === '/api/login') {
          if (body.deviceCode !== undefined && typeof body.deviceCode !== 'boolean') throw new BridgeError('deviceCode 必须是布尔值。');
          verification = { status: 'not_run' }; await saveVerification(verification);
          json(res, 200, await backend.beginLogin({ deviceCode: body.deviceCode === true })); return;
        }
        if (url.pathname === '/api/logout') {
          await backend.logout(); verification = { status: 'not_run' }; await saveVerification(verification);
          json(res, 200, { ok: true }); return;
        }
        if (url.pathname === '/api/bind') {
          verification = { status: 'not_run' }; await saveVerification(verification);
          json(res, 200, await backend.bind()); return;
        }
        if (url.pathname === '/api/integration/install') {
          const token = await backend.credentials();
          if (verification.status !== 'passed' || verification.accountId !== token.accountId || verification.accountEmail !== token.email) {
            throw new BridgeError('请先完成账户 B 的真实推理验证。', 409);
          }
          await integration.install(); json(res, 200, await integration.inspect()); return;
        }
        if (url.pathname === '/api/integration/restore') {
          await integration.restore(); json(res, 200, await integration.inspect()); return;
        }
        throw new BridgeError('管理接口不存在。', 404);
      } finally { adminBusy = false; adminOperation = null; }
    } catch (error) {
      if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
      json(res, error.status ?? 500, { error: { message: redact(error.message), code: error.code ?? 'bridge_error',
        ...(error.code === 'gateway_busy' && Number.isSafeInteger(error.activeRequests) ? { activeRequests: error.activeRequests } : {}) } });
    }
  });
  Object.defineProperty(server, 'activeAdminOperations', { get: () =>
    (adminBusy && !adminOperation?.startsWith('/api/service/') ? 1 : 0) + (verifying ? 1 : 0) });
  server.requestTimeout = 300_000;
  server.headersTimeout = 20_000;
  server.once('listening', () => {
    if (base.port === '0') {
      base.port = String(server.address().port);
      baseUrl = base.href.replace(/\/$/, '');
      allowedHosts.clear(); allowedHosts.add(base.host); allowedHosts.add(`localhost:${base.port}`);
    }
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUse HTTP/SSE for this provider.');
  });
  return server;
}
