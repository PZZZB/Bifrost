import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CodexRpc } from './rpc.mjs';
import { SubscriptionBackend } from './backend.mjs';
import { Gateway } from './gateway.mjs';
import { Integration } from './integration.mjs';
import { createBridgeServer } from './server.mjs';
import { readJson, writeJson, redact } from './storage.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import { AccountQuotas } from './account-quotas.mjs';
import { startMessagesService } from './messages-service.mjs';
import { startCodeBuddyService } from './codebuddy-service.mjs';
import { CodeBuddyResponsesProvider } from './codebuddy-responses.mjs';
import { ModelPolicy } from './model-policy.mjs';
import { B_MODELS, CODEBUDDY_CODEX_MODEL } from './models.mjs';
import { startCursorService, CURSOR_MODELS } from './cursor-service.mjs';
import { createServiceControl } from './service-control.mjs';
import { createServiceVersion } from './service-version.mjs';
import { RequestDiagnostics } from './request-diagnostics.mjs';
import { CursorResponsesProvider } from './cursor-responses.mjs';
import { ModelDiscovery } from './model-discovery.mjs';
import { ProviderQuotas } from './provider-quotas.mjs';
import { createMagpieDelegationServer, loadMagpieDelegation } from './magpie-delegation.mjs';
import { ClientAccess } from './client-access.mjs';
import { ClientAdmin } from './client-admin.mjs';
import { ClientStateCodec } from './client-state.mjs';
import { startClientService } from './client-service.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceVersion = await createServiceVersion({ projectDir });
const port = Number(process.env.BRIDGE_PORT || 43155);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BRIDGE_PORT 必须介于 1024 和 65535。');
// Keep the established data path so the Bifrost rename retains existing accounts and keys.
const stateDir = resolve(process.env.BRIDGE_STATE_DIR || join(homedir(), '.codex-account-bridge'));
// Read the migration latch before constructing any old Codex credential owner.
const delegation = await loadMagpieDelegation(join(stateDir, 'magpie-delegation.json'));
const aHome = resolve(process.env.BRIDGE_CLIENT_CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex'));
const bHome = join(stateDir, 'accounts', 'account-b');
if (aHome.toLowerCase() === bHome.toLowerCase()) throw new Error('A、B 不能使用同一个 CODEX_HOME。');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const statePath = join(stateDir, 'bridge.json');
const storedState = await readJson(statePath, null);
if (delegation && !storedState) throw new Error('Magpie 委托需要既有的本机网关密钥文件。');
const state = storedState ?? {
  gatewayKey: randomBytes(32).toString('base64url'), enabled: false, pinnedAccount: null,
};
if (typeof state.gatewayKey !== 'string' || state.gatewayKey.length < 40) throw new Error('本机网关密钥文件无效。');
const saveState = () => writeJson(statePath, state);
if (!delegation) await saveState();
const baseUrl = `http://127.0.0.1:${port}/backend-api/codex`;
let usageLedger = null;
try { usageLedger = await UsageLedger.open({ path: join(stateDir, 'usage.jsonl'), timeZone: 'America/Los_Angeles' }); }
catch (error) { console.error(`Token statistics unavailable: ${redact(error.message)}`); }
let backendRpc, configRpc, backend, integration, gateway, clientVersion, accountQuotas, serviceControl;
let withService, cursorProvider, requestDiagnostics, clientAccess = null, clientService = null, clientAdmin = null;
const modelPolicy = await ModelPolicy.open({ path: join(stateDir, 'model-policy.json') });
try { requestDiagnostics = await RequestDiagnostics.open({ path: join(stateDir, 'request-diagnostics.jsonl') }); }
catch { console.error('Request diagnostics unavailable; model forwarding remains enabled.'); }
function authorizationVersion(account) {
  return account === 'CodeBuddy' ? codeBuddyService.authorizationVersion : account === 'Cursor' ? cursorService.authorizationVersion : null;
}
async function recordDiagnostic(record) {
  if (record.terminalVerified === true || ['failed', 'interrupted', 'incomplete'].includes(record.status)
      && ['upstream_request', 'upstream_response', 'stream', 'downstream'].includes(record.failureStage)) {
    const categories = { authentication_failed: 'authentication', access_denied: 'permission',
      quota_or_rate_limited: 'quota', network_failed: 'network', payload_rejected: 'protocol',
      request_interrupted: 'cancelled', incomplete_response: 'protocol' };
    modelPolicy.recordVerification({ model: record.model, account: record.account,
      authorizationVersion: record.authorizationVersion, time: record.time,
      outcome: record.terminalVerified === true ? 'passed' : 'failed',
      completed: record.terminalVerified === true, pendingTools: record.status === 'tool_pending',
      category: categories[record.errorCode] ?? 'unknown' });
  }
  await requestDiagnostics?.record(record);
}
if (modelPolicy.snapshot().available) {
  try {
    const cachedCatalog = await readJson(join(aHome, 'models_cache.json'), null);
    if (Array.isArray(cachedCatalog?.models)) await modelPolicy.observe(cachedCatalog);
    await modelPolicy.observe({ models: [...B_MODELS, CODEBUDDY_CODEX_MODEL, ...CURSOR_MODELS] });
  } catch (error) { console.error(`Model settings: ${redact(error.message)}`); }
}
const cursorService = await startCursorService({ stateDir, getGatewayStatus: () => gateway?.cursorStatus() });
cursorProvider = new CursorResponsesProvider({ cursorService, stateDir, promptMode: cursorService.promptMode ?? 'project-rules' });
const codeBuddyService = await startCodeBuddyService({ stateDir,
  getGatewayStatus: () => {
    const messages = withService?.channelStatus('CodeBuddy');
    const codex = gateway?.codeBuddyStatus();
    const channels = [messages, codex].filter(Boolean);
    return { running: channels.some(channel => channel.running === true),
      baseUrl: messages?.baseUrl || baseUrl,
      codexBaseUrl: codex?.running ? baseUrl : null,
      ...Object.fromEntries(['requests', 'completed', 'failed', 'active'].map(name => [name,
        channels.reduce((total, channel) => total + (channel[name] || 0), 0)])),
      lastError: channels.map(channel => channel.lastError).find(Boolean) ?? null };
  } });
const modelDiscovery = new ModelDiscovery({ modelPolicy, codeBuddyService, cursorService });
const providerQuotas = new ProviderQuotas({ codeBuddyService, cursorService });
const clientModels = () => modelPolicy.snapshot().models.filter(model => ['B', 'CodeBuddy', 'Cursor'].includes(model.channel))
  .map(model => ({ id: model.id, name: model.name, channel: model.channel, enabled: model.enabled, available: model.available,
    protocols: ['chat-completions', 'responses', ...(model.channel === 'CodeBuddy' ? ['messages'] : [])] }));
try {
  clientAccess = await ClientAccess.open({ path: join(stateDir, 'client-access.json'), allowedModelIds: () => clientModels().map(model => model.id) });
  clientAdmin = new ClientAdmin({ access: clientAccess, getModels: clientModels,
    getEndpoint: () => clientService?.endpoint() ?? null,
    getServerStatus: () => clientService?.status() ?? { enabled: false, ready: false, message: '用户入口尚未启动。' } });
} catch { console.error('Client access unavailable; existing model routing remains enabled.'); }
// Load optional account catalogs without delaying the gateway or starting inference.
void modelDiscovery.refresh().catch(error => console.error(`Model discovery: ${redact(error.message)}`));
if (!delegation) {
  const binary = process.env.CODEX_BINARY || 'codex';
  const { stdout: versionOutput } = await promisify(execFile)(binary, ['--version'], {
    windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
  });
  clientVersion = versionOutput.match(/codex-cli\s+(\S+)/)?.[1];
  if (!clientVersion) throw new Error('无法识别官方 Codex CLI 的版本。');
  backendRpc = new CodexRpc({ binary, home: bHome, cwd: bHome, isolated: true });
  configRpc = new CodexRpc({ binary, home: aHome, cwd: homedir() });
  backend = new SubscriptionBackend({ rpc: backendRpc, state, saveState });
  accountQuotas = new AccountQuotas({ accountARpc: configRpc, accountBRpc: backendRpc, state });
  integration = new Integration({ rpc: configRpc, configPath: join(aHome, 'config.toml'),
    statePath: join(stateDir, 'integration.json'), baseUrl, gatewayKey: state.gatewayKey });
  gateway = new Gateway({ backend, gatewayKey: state.gatewayKey,
    getAProvider: () => integration.originalProvider(),
    codeBuddyProvider: new CodeBuddyResponsesProvider({ provider: codeBuddyService.provider }),
    codeBuddyEnabled: () => codeBuddyService.enabled,
    getCodeBuddyModels: () => codeBuddyService.getModels(),
    getCodeBuddyAuthorizationVersion: () => codeBuddyService.authorizationVersion,
    modelPolicy,
    cursorProvider, cursorEnabled: () => cursorService.enabled, getCursorModels: () => cursorService.getModels(),
    getCursorAuthorizationVersion: () => cursorService.authorizationVersion,
    isDraining: () => serviceControl?.draining === true,
    onDiagnostic: recordDiagnostic, getAuthorizationVersion: authorizationVersion,
    onUsage: record => {
      if (!usageLedger) throw new Error('Token 记录文件暂不可用，模型转发继续运行。');
      return usageLedger.record(record);
    } });
  // Prime B metadata without delaying A traffic or the local management page.
  void gateway.readBCatalog(`/models?client_version=${encodeURIComponent(clientVersion)}`).catch(() => {});
}
const verificationPath = join(stateDir, 'verification.json');
withService = await startMessagesService({ stateDir, reservedPorts: [port],
  isDraining: () => serviceControl?.draining === true,
  onDiagnostic: recordDiagnostic, getAuthorizationVersion: authorizationVersion,
  codeBuddyProvider: codeBuddyService.provider, codeBuddyModel: codeBuddyService.model, codeBuddyEnabled: codeBuddyService.enabled, onUsage: record => {
  if (!usageLedger) throw new Error('Token 记录文件暂不可用。');
  return usageLedger.record(record);
} });
serviceControl = createServiceControl({ stateDir, projectDir, version: serviceVersion,
  getActiveRequests: () => (gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) +
    Math.max(0, (cursorProvider?.activeRuns ?? 0) - (gateway?.metrics.accounts.Cursor.active ?? 0)) +
    (server?.activeAdminOperations ?? 0) + (clientService?.activeRequests ?? 0),
  onRestart: () => shutdown(0) });
const server = delegation ? createMagpieDelegationServer({ gatewayKey: state.gatewayKey, baseUrl }) :
  createBridgeServer({ backend, gateway, integration, state, baseUrl,
  usageLedger, accountQuotas, providerQuotas, requestDiagnostics, serviceControl, modelPolicy, modelDiscovery, cursorService, cursorProvider, clientAdmin,
  getWithStatus: () => withService.status(),
  codeBuddyService,
  publicDir: join(projectDir, 'public'),
  defaultModel: process.env.BRIDGE_DEFAULT_MODEL || 'B-gpt-6.1-sol',
  clientVersion,
  initialVerification: await readJson(verificationPath, { status: 'not_run' }),
  saveVerification: (value) => writeJson(verificationPath, value),
});
let closing = false;
server.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被使用。请打开已有管理页面，或设置 BRIDGE_PORT。` : redact(error.message));
  void shutdown(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Bifrost: http://127.0.0.1:${port}`);
  console.log(`Source: ${projectDir}`);
  if (delegation) console.log('Codex delegation: Magpie');
  else console.log(`Account B storage: ${bHome}`);
});
if (clientAccess && !delegation) {
  const codec = new ClientStateCodec({ secret: state.gatewayKey });
  clientService = await startClientService({ stateDir, reservedPorts: [port, 43157], publicDir: join(projectDir, 'public'), access: clientAccess,
    getModels: clientModels, csrfSecret: state.gatewayKey, isDraining: () => serviceControl?.draining === true,
    requestResponses: async ({ body, scope, signal }) => {
      const input = codec.input(body, scope);
      const response = await fetch(`${baseUrl}/responses`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.gatewayKey}`, 'x-bifrost-client-scope': scope,
          originator: 'codex_account_bridge', 'user-agent': `codex-account-bridge/0.1.0 codex/${clientVersion}` }, body: JSON.stringify(input) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return Response.json({ error: { message: '所选模型渠道拒绝了请求，请联系管理员查看诊断。', code: 'client_upstream_rejected' } }, { status: response.status });
      }
      return codec.response(response, scope, body.model);
    },
    requestMessages: ({ body, scope, signal }) => codeBuddyService.provider.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify(body)),
      clientScope: scope, signal }),
  });
  const clientStatus = clientService.status();
  if (clientStatus.ready) console.log(`Bifrost user portal: ${clientService.endpoint().portalUrl}`);
  else if (clientStatus.message) console.error(clientStatus.message);
}
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  try { await serviceControl?.close(); }
  catch {
    console.error('Shutdown deferred: restart marker cleanup failed. Retry cancellation from the management page.');
    closing = false;
    return;
  }
  server.close(); server.closeAllConnections();
  await clientService?.close();
  await Promise.allSettled([modelDiscovery.close(), providerQuotas.close()]);
  await Promise.allSettled([backendRpc?.close(), configRpc?.close(), withService.close(), codeBuddyService.close(), cursorProvider.close(), cursorService.close()]);
  // Account for response-finally work triggered by closing sockets before flushing.
  const deadline = Date.now() + 5000;
  while ((gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) > 0 && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  await usageLedger?.flush();
  await requestDiagnostics?.close();
  await clientAccess?.close();
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
