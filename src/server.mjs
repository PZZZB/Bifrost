import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError, redact } from './storage.mjs';
import { backendPath, keyMatches, readBody, SseInspector } from './gateway.mjs';
import { B_MODELS, resolveBModel } from './models.mjs';

const STATIC_FILES = { '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createBridgeServer({ backend, gateway, integration, state, publicDir, baseUrl,
  usageLedger = null, accountQuotas = null,
  codeBuddyService = null, serviceControl = null, modelPolicy = null, cursorService = null, cursorProvider = null,
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

  async function bodyJson(req) {
    const bytes = await readBody(req, 64 * 1024);
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
      if (backendPath(url.pathname)) { await gateway.proxy(req, res, url); return; }
      if (url.pathname === '/health' && req.method === 'GET') { json(res, 200, { ok: true, version: '0.1.0' }); return; }
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        if (url.pathname === '/') res.setHeader('Set-Cookie', `bridge_session=${browserSession}; HttpOnly; SameSite=Strict; Path=/`);
        const content = await readFile(join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) throw new BridgeError('页面不存在。', 404);
      checkBrowser(req);
      if (req.method === 'GET') {
        if (url.pathname === '/api/service/status') {
          if (!serviceControl) throw new BridgeError('当前运行版本尚未启用网页服务控制。', 503);
          json(res, 200, await serviceControl.status()); return;
        }
        if (url.pathname === '/api/model-settings') {
          if (!modelPolicy) throw new BridgeError('当前运行版本尚未启用模型管理。', 503);
          json(res, 200, modelPolicy.snapshot()); return;
        }
        if (url.pathname === '/api/cursor') {
          if (!cursorService) throw new BridgeError('Cursor 渠道尚未配置。', 503);
          json(res, 200, await cursorService.status()); return;
        }
        if (url.pathname === '/api/status') {
          let backendError = null;
          try { await backend.readAccount(); } catch (error) { backendError = redact(error.message); }
          let info;
          try { info = await integration.inspect(); }
          catch (error) { info = { installed: false, canInstall: false, reason: redact(error.message) }; }
          json(res, 200, { csrfToken: csrf, ready: !backendError, version: '0.1.0',
            gateway: { baseUrl, enabled: Boolean(state.enabled && state.pinnedAccount), ...gateway.metrics },
            backend: { running: backend.rpc.running, account: backend.account, login: backend.login,
              pinnedAccount: backend.publicBinding(), error: backendError }, integration: info, verification });
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
          if (!accountQuotas) throw new BridgeError('账号额度查询暂不可用。', 503);
          json(res, 200, await accountQuotas.snapshot()); return;
        }
        if (url.pathname === '/api/token-usage') {
          if (!usageLedger) throw new BridgeError('Token 统计暂不可用，请检查本机记录文件。', 503);
          const snapshot = usageLedger.snapshot();
          json(res, 200, { ...snapshot, error: gateway.metrics.usageError ?? snapshot.error ?? null }); return;
        }
        if (url.pathname === '/api/traffic') {
          const threadId = url.searchParams.get('threadId');
          if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId ?? '')) throw new BridgeError('会话 ID 无效。');
          json(res, 200, { traffic: gateway.traffic(threadId) }); return;
        }
        if (url.pathname === '/api/usage') { json(res, 200, await backend.limits()); return; }
        if (url.pathname === '/api/integration') {
          const info = await integration.inspect();
          const providerId = info.providerId ?? 'account_b';
          const toml = `[model_providers.${JSON.stringify(providerId)}]\nname = "Account A/B Bridge"\nbase_url = ${JSON.stringify(baseUrl)}\nmodel_catalog_url = ${JSON.stringify(`${baseUrl}/models`)}\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nhttp_headers = { "X-Account-Bridge-Key" = ${JSON.stringify(state.gatewayKey)} }\n`;
          json(res, 200, { toml, baseUrl, gatewayKey: state.gatewayKey }); return;
        }
        throw new BridgeError('管理接口不存在。', 404);
      }
      if (req.method !== 'POST') throw new BridgeError('请求方法不支持。', 405);
      if (adminBusy) throw new BridgeError('另一个管理操作正在执行。', 409);
      adminBusy = true;
      try {
        const body = await bodyJson(req);
        if (url.pathname === '/api/service/restart') {
          if (!serviceControl) throw new BridgeError('当前运行版本尚未启用网页服务控制。', 503);
          const result = await serviceControl.request(body);
          if (res.destroyed) { serviceControl.cancel(); return; }
          res.once('close', () => { if (!res.writableFinished) serviceControl.cancel(); });
          res.once('finish', () => { void serviceControl.activate(); });
          json(res, 202, result); return;
        }
        if (url.pathname === '/api/model-settings') {
          if (!modelPolicy) throw new BridgeError('当前运行版本尚未启用模型管理。', 503);
          json(res, 200, await modelPolicy.update(body)); return;
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
        if (verifying) throw new BridgeError('请等待当前推理验证结束。', 409);
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
      } finally { adminBusy = false; }
    } catch (error) {
      if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
      json(res, error.status ?? 500, { error: { message: redact(error.message), code: error.code ?? 'bridge_error',
        ...(error.code === 'gateway_busy' && Number.isSafeInteger(error.activeRequests) ? { activeRequests: error.activeRequests } : {}) } });
    }
  });
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
