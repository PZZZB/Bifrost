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
import { readJson, writeJson, redact, BridgeError } from './storage.mjs';
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
import { ClientBilling } from './client-billing.mjs';
import { loadMacClaudeClient } from './mac-claude-client.mjs';
import { UnifiedWebAccounts } from './unified-web-accounts.mjs';
import { createWebAccounts } from './web-accounts.mjs';
import { loadPaymentRuntime } from './payments/runtime.mjs';
import { startServerRemotes } from './runtime/server-remotes.mjs';
import { UpstreamAccountStore } from './upstream-account-store.mjs';
import { UpstreamAccounts, gatedAccountService } from './upstream-accounts.mjs';
import { readLaunchdOwner } from './launchd-owner.mjs';
import { startClientCatalogSync } from './runtime/client-sync.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceVersion = await createServiceVersion({ projectDir });
const port = Number(process.env.BRIDGE_PORT || 43155);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BRIDGE_PORT 必须介于 1024 和 65535。');
// Keep the established data path so the Bifrost rename retains existing accounts and keys.
const stateDir = resolve(process.env.BRIDGE_STATE_DIR || join(homedir(), '.codex-account-bridge'));
// Read the migration latch before constructing any old Codex credential owner.
const delegation = await loadMagpieDelegation(join(stateDir, 'magpie-delegation.json'));
const modelPolicy = await ModelPolicy.open({ path: join(stateDir, 'model-policy.json') });
let claudeAuthorizationVersion = null;
if (process.env.BRIDGE_MAC_CLAUDE_CONFIG) modelPolicy.setAuthorizationVersionGetter('Claude', () => claudeAuthorizationVersion);
const macClaude = await loadMacClaudeClient(process.env.BRIDGE_MAC_CLAUDE_CONFIG, { onCatalog: async (models, version) => {
  claudeAuthorizationVersion = version;
  await modelPolicy.observe({ models: models.filter(m => ['Claude-opus', 'Claude-sonnet'].includes(m.id)) }, 'Claude', { authorizationVersion: version });
  await modelPolicy.observe({ models }, 'Claude', { complete: true, defaultEnabled: false, authorizationVersion: version });
} });
const nativeIntegration = !macClaude && !delegation;
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
let withService, cursorProvider, requestDiagnostics, clientAccess = null, clientService = null, clientAdmin = null, clientBilling = null;
let paymentRuntime = null, paymentsFault = false, serverRemotes = null, accountPool = null;
let clientCatalogSync = null;
const seeds = [];
const configured = async name => await readJson(join(stateDir, name), null);
const userEntryConfiguration = await configured('client-gateway.json');
const legacyUserAccounts = userEntryConfiguration === null ? await configured('client-access.json') : null;
const userManagementRequested = Boolean(macClaude || userEntryConfiguration?.enabled === true || userEntryConfiguration === null
  && ((legacyUserAccounts?.accounts?.length ?? 0) > 0 || (legacyUserAccounts?.invites?.length ?? 0) > 0));
if (macClaude) seeds.push({ kind: 'claude', name: '隔离 Claude' });
else if (!delegation) {
  if (state.pinnedAccount || state.enabled || await configured('verification.json')) seeds.push({ kind: 'codex', name: 'Codex 订阅' });
  if (await configured('codebuddy.json')) seeds.push({ kind: 'codebuddy', name: 'CodeBuddy 员工账号' });
  if (await configured('cursor.json')) seeds.push({ kind: 'cursor', name: 'Cursor 账号' });
  if ((await configured('with.json'))?.enabled) seeds.push({ kind: 'with', name: 'With 兼容来源' });
  if ((await configured('messages-gateway.json'))?.routes?.some(r => r.account === 'Claude')) seeds.push({ kind: 'claude', name: '受管 Claude 来源' });
}
const accountStore = delegation ? null : await UpstreamAccountStore.open({ stateDir, seeds });
const hasSlot = slot => accountStore?.snapshot().accounts.some(a => a.enabled && a.binding.slot === slot) === true;
const sourceAllowed = (channel, model) => accountPool ? accountPool.allows(channel, model) : channel === 'A' || hasSlot(channel);
try { requestDiagnostics = await RequestDiagnostics.open({ path: join(stateDir, 'request-diagnostics.jsonl') }); }
catch { console.error('Request diagnostics unavailable; model forwarding remains enabled.'); }
function authorizationVersion(account) {
  return account === 'CodeBuddy' ? codeBuddyService?.authorizationVersion : account === 'Cursor' ? cursorService?.authorizationVersion
    : account === 'Bifrost' ? serverRemotes?.generation ?? null : account === 'Claude' ? claudeAuthorizationVersion : null;
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
if (nativeIntegration && modelPolicy.snapshot().available) {
  try {
    const cachedCatalog = await readJson(join(aHome, 'models_cache.json'), null);
    if (Array.isArray(cachedCatalog?.models)) await modelPolicy.observe(cachedCatalog);
    await modelPolicy.observe({ models: [...B_MODELS, CODEBUDDY_CODEX_MODEL, ...CURSOR_MODELS] });
  } catch (error) { console.error(`Model settings: ${redact(error.message)}`); }
}
const cursorService = !delegation && hasSlot('Cursor') ? await startCursorService({ stateDir, getGatewayStatus: () => gateway?.cursorStatus() }) : null;
cursorProvider = cursorService ? new CursorResponsesProvider({ cursorService, stateDir, promptMode: cursorService.promptMode ?? 'project-rules' }) : null;
const codeBuddyService = !delegation && hasSlot('CodeBuddy') ? await startCodeBuddyService({ stateDir,
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
  } }) : null;
const gatedCodeBuddy = gatedAccountService(codeBuddyService, () => sourceAllowed('CodeBuddy'));
const gatedCursor = gatedAccountService(cursorService, () => sourceAllowed('Cursor'));
const modelDiscovery = new ModelDiscovery({ modelPolicy, codeBuddyService: gatedCodeBuddy, cursorService: gatedCursor });
const providerQuotas = nativeIntegration ? new ProviderQuotas({ codeBuddyService: gatedCodeBuddy, cursorService: gatedCursor }) : null;
const knownClientModels = () => modelPolicy.snapshot().models.filter(model => ['B', 'CodeBuddy', 'Cursor', 'Bifrost', ...(macClaude ? ['Claude'] : [])].includes(model.channel));
const clientModels = () => knownClientModels().filter(model => accountStore?.snapshot().accounts.some(account => model.channel === 'Bifrost'
    ? account.kind === 'bifrost' && model.id.startsWith(`remote/${account.binding.sourceId}/`) : account.binding.slot === model.channel))
  .map(model => ({ id: model.id, name: model.name, channel: model.channel,
    enabled: model.enabled !== false && sourceAllowed(model.channel, model.id) && !modelPolicy.snapshot().disabledModels.includes(model.id), available: model.available,
    capabilities: model.capabilities,
    protocols: model.protocols ?? (model.channel === 'Claude' ? ['chat-completions', 'messages']
      : ['chat-completions', 'responses', ...(model.channel === 'CodeBuddy' ? ['messages'] : [])]) }));
if (userManagementRequested) try {
  clientAccess = await ClientAccess.open({ path: join(stateDir, 'client-access.json'), allowedModelIds: () => knownClientModels().map(model => model.id),
    ...(macClaude ? { maxAccounts: macClaude.web.maxAccounts } : {}) });
  try { clientBilling = await ClientBilling.open({ path: join(stateDir, 'client-billing.json') }); }
  catch { console.error('Client billing unavailable; client inference remains closed until the ledger is repaired.'); }
  clientAdmin = new ClientAdmin({ access: clientAccess, billing: clientBilling, getModels: clientModels,
    getPaymentsStatus: () => paymentRuntime?.service.status() ?? { enabled: false, unavailable: paymentsFault },
    getEndpoint: () => clientService?.endpoint() ?? null,
    getServerStatus: () => clientService?.status() ?? { enabled: false, ready: false,
      message: clientBilling ? '用户入口尚未启动。' : '用户计费账本未就绪，入口已停止接入。' } });
} catch { console.error('Client access unavailable; existing model routing remains enabled.'); }
// Load optional account catalogs without delaying the gateway or starting inference.
if (!delegation) void modelDiscovery.refresh().catch(error => console.error(`Model discovery: ${redact(error.message)}`));
if (!delegation) {
  try { serverRemotes = await startServerRemotes({ stateDir, secret: state.gatewayKey }); }
  catch { console.error('Remote sources unavailable; existing local sources remain enabled. Check the protected remote configuration.'); }
  modelPolicy.setAuthorizationVersionGetter('Bifrost', () => serverRemotes?.generation ?? null);
  if (nativeIntegration) {
    const binary = process.env.CODEX_BINARY || 'codex';
    const { stdout: versionOutput } = await promisify(execFile)(binary, ['--version'], {
      windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
    });
    clientVersion = versionOutput.match(/codex-cli\s+(\S+)/)?.[1];
    if (!clientVersion) throw new Error('无法识别官方 Codex CLI 的版本。');
    backendRpc = hasSlot('B') ? new CodexRpc({ binary, home: bHome, cwd: bHome, isolated: true }) : null;
    configRpc = new CodexRpc({ binary, home: aHome, cwd: homedir() });
    backend = backendRpc ? new SubscriptionBackend({ rpc: backendRpc, state, saveState }) : null;
    accountQuotas = backendRpc ? new AccountQuotas({ accountARpc: configRpc, accountBRpc: backendRpc, state }) : null;
    integration = new Integration({ rpc: configRpc, configPath: join(aHome, 'config.toml'),
      statePath: join(stateDir, 'integration.json'), baseUrl, gatewayKey: state.gatewayKey });
  }
  gateway = new Gateway({ backend, gatewayKey: state.gatewayKey,
    getAProvider: () => {
      if (!integration) throw new BridgeError('当前网关未装配本机 Codex 官方连接。', 503, 'node_capability_unavailable');
      return integration.originalProvider();
    },
    codeBuddyProvider: codeBuddyService ? new CodeBuddyResponsesProvider({ provider: codeBuddyService.provider }) : null,
    codeBuddyEnabled: () => codeBuddyService?.enabled === true && sourceAllowed('CodeBuddy'),
    getCodeBuddyModels: () => codeBuddyService?.getModels() ?? [],
    getCodeBuddyAuthorizationVersion: () => codeBuddyService?.authorizationVersion,
    modelPolicy, remoteSources: serverRemotes,
    cursorProvider, cursorEnabled: () => cursorService?.enabled === true && sourceAllowed('Cursor'), getCursorModels: () => cursorService?.getModels() ?? [],
    getCursorAuthorizationVersion: () => cursorService?.authorizationVersion,
    sourceEnabled: (channel, model) => channel === 'A' ? nativeIntegration : sourceAllowed(channel, model),
    isDraining: () => serviceControl?.draining === true,
    onDiagnostic: recordDiagnostic, getAuthorizationVersion: authorizationVersion,
    onUsage: record => {
      if (!usageLedger) throw new Error('Token 记录文件暂不可用，模型转发继续运行。');
      return usageLedger.record(record);
    } });
  // Prime B metadata without delaying A traffic or the local management page.
  if (nativeIntegration) void gateway.readBCatalog(`/models?client_version=${encodeURIComponent(clientVersion)}`).catch(() => {});
}
const verificationPath = join(stateDir, 'verification.json');
withService = nativeIntegration && ['With', 'CodeBuddy', 'Claude'].some(hasSlot) ? await startMessagesService({ stateDir, reservedPorts: [port],
  isDraining: () => serviceControl?.draining === true,
  isAccountEnabled: sourceAllowed,
  onDiagnostic: recordDiagnostic, getAuthorizationVersion: authorizationVersion,
  codeBuddyProvider: codeBuddyService?.provider, codeBuddyModel: codeBuddyService?.model, codeBuddyEnabled: codeBuddyService?.enabled === true, onUsage: record => {
  if (!usageLedger) throw new Error('Token 记录文件暂不可用。');
  return usageLedger.record(record);
} }) : null;
if (accountStore) {
  accountPool = new UpstreamAccounts({ store: accountStore,
    types: [...(macClaude ? ['claude'] : ['codex']), ...(['win32', 'darwin'].includes(process.platform) ? ['codebuddy', 'cursor', 'bifrost'] : []), ...seeds.filter(s => ['with', 'claude', 'codebuddy', 'cursor'].includes(s.kind)).map(s => s.kind)],
    readers: {
      claude: () => macClaude ? { configured: true, ready: macClaude.status().available, authenticated: null,
        subscriptionUsage: macClaude.status().subscriptionUsage } : withService?.status(),
      codex: () => ({ configured: Boolean(backend), authenticated: Boolean(backend?.account), bound: Boolean(state.enabled && state.pinnedAccount && backend?.account) }),
      codebuddy: () => codeBuddyService?.status(), cursor: () => cursorService?.status(), with: () => withService?.status() },
    getRemotes: () => serverRemotes, modelPolicy,
    getModels: () => modelPolicy.snapshot().models,
    refreshModels: async () => {
      if (macClaude) {
        await macClaude.refresh();
      }
      const discovered = await modelDiscovery.refresh(); await gateway?.observeRemotes();
      return { discovery: { ...Object.fromEntries(Object.entries(discovered.discovery ?? {}).filter(([kind]) => hasSlot(kind))),
        ...(macClaude ? { Claude: { state: !sourceAllowed('Claude') ? 'disabled' : macClaude.status().available ? 'ready' : 'error', count: macClaude.models().length } } : {}) } };
    },
    capabilities: () => ({ accountPool: true, clientIntegration: Boolean(integration), userManagement: clientService?.status().enabled === true,
      billing: Boolean(clientBilling), diagnostics: Boolean(requestDiagnostics), activeKinds: accountPool?.rows().filter(a => a.enabled
        && (a.kind === 'claude' || a.kind === 'cursor' && cursorService || a.kind === 'codebuddy' && codeBuddyService
          || a.kind === 'codex' && backend || a.kind === 'bifrost' && serverRemotes || a.kind === 'with' && withService)).map(a => a.kind) ?? [] }),
  });
}
const sourceCatalogTimer = delegation ? null : setInterval(() => {
  void modelDiscovery.refresh().then(() => gateway?.observeRemotes()).catch(() => {});
}, 30000);
sourceCatalogTimer?.unref();
serviceControl = createServiceControl({ stateDir, projectDir, version: serviceVersion,
  supervisorOwner: () => readLaunchdOwner({ label: process.env.BRIDGE_LAUNCHD_LABEL, stateDir, projectDir }),
  getActiveRequests: () => (gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) +
    Math.max(0, (cursorProvider?.activeRuns ?? 0) - (gateway?.metrics.accounts.Cursor.active ?? 0)) +
    (server?.activeAdminOperations ?? 0) + (clientService?.activeRequests ?? 0),
  onRestart: () => shutdown(0) });
const server = delegation ? createMagpieDelegationServer({ gatewayKey: state.gatewayKey, baseUrl }) :
  createBridgeServer({ backend, gateway, integration, state, baseUrl,
  usageLedger, accountQuotas, providerQuotas, requestDiagnostics, serviceControl, modelPolicy, modelDiscovery, cursorService, cursorProvider, clientAdmin, accountPool,
  getWithStatus: () => withService?.status(),
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
  else if (backend) console.log(`Account B storage: ${bHome}`);
});
if (clientAccess && clientBilling && !delegation) {
  const codec = new ClientStateCodec({ secret: state.gatewayKey });
  if (process.env.BRIDGE_PAYMENTS_CONFIG) {
    try { paymentRuntime = await loadPaymentRuntime({ configPath: process.env.BRIDGE_PAYMENTS_CONFIG, stateDir,
      access: clientAccess, billing: clientBilling, publicOrigin: macClaude?.web.publicOrigin }); }
    catch { paymentsFault = true; console.error('Payments unavailable; automatic top-ups remain closed. Check the private payment configuration and journal.'); }
  }
  const webAccounts = macClaude ? createWebAccounts({ ...macClaude.web, csrfKey: macClaude.csrfKey,
    payments: paymentRuntime?.service, publicDir: join(projectDir, 'public/accounts'),
    store: new UnifiedWebAccounts({ access: clientAccess, billing: clientBilling, ...macClaude.web, payments: paymentRuntime?.service }) }) : null;
  clientService = await startClientService({ stateDir, reservedPorts: [port, 43157], publicDir: join(projectDir, 'public'), access: clientAccess, billing: clientBilling,
    webAccounts, ...(macClaude ? { requestChat: macClaude.requestChat, maxConcurrent: 4, maxConcurrentPerAccount: macClaude.web.maxConcurrent,
      useDirectChat: model => clientModels().find(entry => entry.id === model)?.channel === 'Claude',
      requestsPerMinute: macClaude.web.requestsPerMinute,
      getUpstreamAuthorizationVersion: model => model.startsWith('Claude-') ? claudeAuthorizationVersion : null,
      onModelResult: result => {
        if (!result.model.startsWith('Claude-')) return;
        modelPolicy.recordVerification({ ...result, account: 'Claude', outcome: 'passed', completed: true });
      } } : {}),
    getModels: clientModels, csrfSecret: state.gatewayKey, isDraining: () => serviceControl?.draining === true,
    prepareResponses: (body, scope) => codec.input(body, scope),
    requestResponses: async ({ body, scope, signal }) => {
      const response = await fetch(`${baseUrl}/responses`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${state.gatewayKey}`, 'x-bifrost-client-scope': scope,
          originator: 'codex_account_bridge', 'user-agent': `codex-account-bridge/0.1.0 codex/${clientVersion}` }, body: JSON.stringify(body) });
      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json') || contentType.includes('text/event-stream')) {
          return codec.response(response, scope, body.model);
        }
        await response.body?.cancel().catch(() => {});
        return Response.json({ error: { message: '所选模型渠道拒绝了请求，请联系管理员查看诊断。', code: 'client_upstream_rejected' } }, { status: response.status });
      }
      return codec.response(response, scope, body.model);
    },
    requestMessages: request => clientModels().find(model => model.id === request.body.model)?.channel === 'Claude'
      ? macClaude.requestMessages(request) : codeBuddyService.provider.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify(request.body)),
        clientScope: request.scope, signal: request.signal }),
  });
  const clientStatus = clientService.status();
  if (clientStatus.ready) console.log(`Bifrost user portal: ${clientService.endpoint().portalUrl}`);
  else if (clientStatus.message) console.error(clientStatus.message);
}
if (!delegation) clientCatalogSync = await startClientCatalogSync({ stateDir });
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  try { await serviceControl?.close(); }
  catch {
    console.error('Shutdown deferred: restart marker cleanup failed. Retry cancellation from the management page.');
    closing = false;
    return;
  }
  server.close(); server.closeAllConnections();
  clearInterval(sourceCatalogTimer);
  await clientService?.close();
  await clientCatalogSync?.close();
  await paymentRuntime?.close();
  await macClaude?.close();
  await serverRemotes?.close();
  await Promise.allSettled([modelDiscovery.close(), providerQuotas?.close()]);
  await Promise.allSettled([backendRpc?.close(), configRpc?.close(), withService?.close(), codeBuddyService?.close(), cursorProvider?.close(), cursorService?.close()]);
  // Account for response-finally work triggered by closing sockets before flushing.
  const deadline = Date.now() + 5000;
  while ((gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) > 0 && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  await usageLedger?.flush();
  await requestDiagnostics?.close();
  await clientAccess?.close();
  await clientBilling?.close();
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
