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
import { CursorResponsesProvider } from './cursor-responses.mjs';
import { createMagpieDelegationServer, loadMagpieDelegation } from './magpie-delegation.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
let withService, cursorProvider;
const modelPolicy = await ModelPolicy.open({ path: join(stateDir, 'model-policy.json') });
if (modelPolicy.snapshot().available) {
  try {
    const cachedCatalog = await readJson(join(aHome, 'models_cache.json'), null);
    if (Array.isArray(cachedCatalog?.models)) await modelPolicy.observe(cachedCatalog);
    await modelPolicy.observe({ models: [...B_MODELS, CODEBUDDY_CODEX_MODEL, ...CURSOR_MODELS] });
  } catch (error) { console.error(`Model settings: ${redact(error.message)}`); }
}
const cursorService = await startCursorService({ stateDir, getGatewayStatus: () => gateway?.cursorStatus() });
cursorProvider = new CursorResponsesProvider({ cursorService, stateDir });
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
    modelPolicy,
    cursorProvider, cursorEnabled: () => cursorService.enabled, getCursorModels: () => cursorService.getModels(),
    isDraining: () => serviceControl?.pending === true,
    onUsage: record => {
      if (!usageLedger) throw new Error('Token 记录文件暂不可用，模型转发继续运行。');
      return usageLedger.record(record);
    } });
  // Prime B metadata without delaying A traffic or the local management page.
  void gateway.readBCatalog(`/models?client_version=${encodeURIComponent(clientVersion)}`).catch(() => {});
}
const verificationPath = join(stateDir, 'verification.json');
withService = await startMessagesService({ stateDir, reservedPorts: [port],
  isDraining: () => serviceControl?.pending === true,
  codeBuddyProvider: codeBuddyService.provider, codeBuddyModel: codeBuddyService.model, codeBuddyEnabled: codeBuddyService.enabled, onUsage: record => {
  if (!usageLedger) throw new Error('Token 记录文件暂不可用。');
  return usageLedger.record(record);
} });
serviceControl = createServiceControl({ stateDir, projectDir,
  getActiveRequests: () => (gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) +
    Math.max(0, (cursorProvider?.activeRuns ?? 0) - (gateway?.metrics.accounts.Cursor.active ?? 0)),
  onRestart: () => shutdown(0) });
const server = delegation ? createMagpieDelegationServer({ gatewayKey: state.gatewayKey, baseUrl }) :
  createBridgeServer({ backend, gateway, integration, state, baseUrl,
  usageLedger, accountQuotas, serviceControl, modelPolicy, cursorService, cursorProvider,
  getWithStatus: () => withService.status(),
  codeBuddyService,
  publicDir: join(projectDir, 'public'),
  defaultModel: process.env.BRIDGE_DEFAULT_MODEL || 'B-gpt-6.1-sol',
  clientVersion,
  initialVerification: await readJson(verificationPath, { status: 'not_run' }),
  saveVerification: (value) => writeJson(verificationPath, value),
});
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
let closing = false;
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  server.close(); server.closeAllConnections();
  await Promise.allSettled([backendRpc?.close(), configRpc?.close(), withService.close(), codeBuddyService.close(), cursorProvider.close(), cursorService.close()]);
  // Account for response-finally work triggered by closing sockets before flushing.
  const deadline = Date.now() + 5000;
  while ((gateway?.pendingRequests ?? 0) + (withService?.activeRequests ?? 0) > 0 && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  await usageLedger?.flush();
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
