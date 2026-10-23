import { readJson } from './storage.mjs';
import { join } from 'node:path';
import { WithDaemonClient } from './with-desktop.mjs';
import { WithRelayProvider } from './with-relay.mjs';
import { createWithGatewayServer, WITH_MODEL } from './with-gateway.mjs';

const HOST = '192.168.168.1';
const GUEST = '192.168.168.10';
const PORT = 43157;
// The guest TCP loopback forwarder preserves Desktop's original Host header.
export const WITH_GATEWAY_ALLOWED_HOSTS = Object.freeze([`${HOST}:${PORT}`, `127.0.0.1:${PORT}`]);

function listen(server, port, address) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('With gateway listener is unavailable.'));
    server.once('error', failed);
    server.listen(port, address, () => { server.off('error', failed); resolve(); });
  });
}

/** Optional VM listener with independent With and CodeBuddy channel switches. */
export async function startWithService({ stateDir, onUsage, onDiagnostic, getAuthorizationVersion, codeBuddyProvider = null, codeBuddyModel = null,
  codeBuddyEnabled = false, listenImpl = listen, daemon: injectedDaemon = null, provider: injectedProvider = null,
  isDraining = () => false }) {
  let config = null, configError = false;
  try { config = await readJson(join(stateDir, 'with.json'), null); }
  catch { configError = true; }
  const withEnabled = config?.enabled === true;
  const view = { configured: withEnabled, running: false, manualVerification: true,
    model: { id: WITH_MODEL.id, name: WITH_MODEL.name },
    gateway: { baseUrl: `http://${HOST}:${PORT}`, requests: 0, completed: 0, failed: 0, active: 0 },
    provider: { authenticated: null, ready: false }, vm: { address: GUEST, configured: config?.vmConfigured === true } };
  let daemon, provider, mcp, server;
  let gatewayRunning = false;
  let setupError = configError ? 'With 配置文件读取失败；请检查 with.json。' : null;
  let closed = false;
  async function close() {
    closed = true;
    await provider?.close();
    daemon?.close();
    for (const item of [server, mcp]) { item?.close(); item?.closeAllConnections(); }
    view.running = false; gatewayRunning = false;
  }
  if (withEnabled || codeBuddyEnabled === true) {
    try {
      if (typeof config?.gatewayKey !== 'string' || config.gatewayKey.length < 40 ||
          config.gatewayKey.length > 4096 || /[\x00-\x20\x7f]/.test(config.gatewayKey)) throw new Error('invalid');
      if (codeBuddyEnabled === true && (!codeBuddyProvider || !codeBuddyModel)) throw new Error('invalid');
      if (withEnabled) {
        if (typeof config.mcpKey !== 'string' || config.mcpKey.length < 40 || config.gatewayKey === config.mcpKey) throw new Error('invalid');
        daemon = injectedDaemon || new WithDaemonClient();
        provider = injectedProvider || new WithRelayProvider({ daemon, mcpKey: config.mcpKey });
        mcp = provider.mcpServer();
        await listenImpl(mcp, 43158, '127.0.0.1');
      }
      server = createWithGatewayServer({ provider, withEnabled, gatewayKey: config.gatewayKey, onUsage, onDiagnostic, getAuthorizationVersion, isDraining,
        allowedHosts: WITH_GATEWAY_ALLOWED_HOSTS, allowedPeers: [GUEST],
        additionalRoutes: codeBuddyEnabled === true
          ? [{ account: 'CodeBuddy', model: codeBuddyModel, provider: codeBuddyProvider }] : [] });
      await listenImpl(server, PORT, HOST);
      gatewayRunning = true; view.running = withEnabled;
      if (withEnabled) void provider.prepare().catch(() => { if (!closed) setupError = 'With MCP 注册未完成，请检查 With 桌面状态。'; });
    } catch {
      setupError = withEnabled ? 'With 接入准备失败，请检查桌面登录、Opus 5.5 权限及本机 MCP 注册。' :
        'CodeBuddy VM 网关准备失败，请检查独立网关密钥及端口配置。';
      // Failed optional VM setup must not stop the independent Codex routes.
      if (!gatewayRunning) await close();
    }
  }
  return {
    get activeRequests() { return server?.gateway.pendingRequests ?? 0; },
    channelStatus(account) {
      const enabled = account === 'CodeBuddy' ? codeBuddyEnabled === true : account === 'With' && withEnabled;
      return { running: gatewayRunning && enabled, baseUrl: `http://${HOST}:${PORT}`, ...(server?.gateway.status(account) ?? {}),
        ...(!gatewayRunning && setupError ? { lastError: setupError } : {}) };
    },
    async status() {
      let metadata = view.provider;
      try { if (provider && !closed) metadata = await provider.status(); }
      catch { metadata = { authenticated: false, ready: false, error: 'With 状态暂不可用。' }; }
      return { ...view, provider: { authenticated: metadata.authenticated, ready: metadata.ready,
        modelAvailable: metadata.modelAvailable, transport: metadata.transport,
        error: setupError || metadata.error || null },
      gateway: { ...view.gateway, ...(server?.gateway.status('With') ?? {}) } };
    },
    close,
  };
}
