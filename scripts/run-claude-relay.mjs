import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import { createClaudeGatewayServer, ChatHistoryStore } from '../src/openai-chat-gateway.mjs';
import { ClaudeCliHub } from '../src/claude-cli-provider.mjs';
import { startRelayControl } from '../src/relay-control.mjs';
import { ClaudeMetadataReader } from '../src/claude-model-catalog.mjs';
import { unavailableClaudeUsage } from '../src/claude-subscription-usage.mjs';

let hub, server, control, controlStart, closing;
let catalogTimer, catalogPending, metadataReader;
let lastAuthorizationState;
let subscriptionUsage = unavailableClaudeUsage(), usageAttemptAt = 0, authorizationVersion = null;
const catalogAbort = new AbortController();
function close() {
  return closing ??= (async () => {
    clearInterval(catalogTimer); catalogAbort.abort(); await metadataReader?.close(); await catalogPending?.catch(() => {});
    await controlStart?.then(value => value.close(), () => {});
    const results = await Promise.allSettled([
      server && new Promise(done => { server.close(done); server.closeAllConnections(); }),
      hub?.close(),
    ]);
    if (results.some(result => result.status === 'rejected')) throw new Error('Claude relay could not close.');
  })();
}
try {
  const [configPath, ...extra] = process.argv.slice(2);
  if (!configPath || !isAbsolute(configPath) || extra.length) throw new Error();
  const bytes = await readFile(configPath);
  if (bytes.length > 65_536) throw new Error();
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (config.version !== 1 || !isIP(config.listener?.address) ||
      !Number.isInteger(config.listener.port) || config.listener.port < 1024 || config.listener.port > 65535 ||
      !Array.isArray(config.listener.allowedHosts) || !config.listener.allowedHosts.length ||
      !Array.isArray(config.listener.allowedPeers) || !config.listener.allowedPeers.length ||
      config.listener.allowedPeers.some(value => !isIP(value)) ||
      typeof config.gatewayKeyFile !== 'string' || !isAbsolute(config.gatewayKeyFile) ||
      !Array.isArray(config.models) || !config.models.length || config.models.some(model =>
        !model || typeof model.id !== 'string' || typeof model.name !== 'string' || typeof model.upstream !== 'string') ||
      ![config.cli?.binary, config.cli?.configDir, config.cli?.profileDir, config.cli?.stateDir]
        .every(value => typeof value === 'string' && isAbsolute(value))) throw new Error();
  const mcpPort = config.mcpPort ?? 3436;
  if (!Number.isInteger(mcpPort) || mcpPort < 1 || mcpPort > 65535 || mcpPort === config.listener.port) throw new Error();
  const gatewayKey = (await readFile(config.gatewayKeyFile, 'utf8')).replace(/\r?\n$/, '');
  if (!/^[\x21-\x7e]{40,4096}$/.test(gatewayKey)) throw new Error();
  // Loading the official SDK is metadata-only. A missing dependency must not advertise ready models.
  await import('@anthropic-ai/claude-agent-sdk');
  hub = new ClaudeCliHub({ binary: config.cli.binary, configDir: config.cli.configDir,
    profileDir: config.cli.profileDir, stateDir: config.cli.stateDir, mcpPort });
  await hub.start();
  const routeFor = model => {
    const provider = hub.provider(model.upstream);
    return { account: 'Claude', model, provider: { ...provider,
      status: async () => ({ ...(await provider.status()), subscriptionUsage: structuredClone(subscriptionUsage), authorizationVersion }) } };
  };
  const history = new ChatHistoryStore({ path: join(config.cli.stateDir, 'chat-history.json') });
  await history.load();
  server = createClaudeGatewayServer({ gatewayKey,
    allowedHosts: config.listener.allowedHosts, allowedPeers: config.listener.allowedPeers,
    routes: config.models.map(routeFor) }, { history });
  if (config.modelDiscovery?.enabled === true) {
    metadataReader = new ClaudeMetadataReader({ ...config.cli, signal: catalogAbort.signal, identitySecret: gatewayKey });
    const refreshCatalog = () => catalogPending ??= (async () => {
      try {
        const status = await hub.status(), authenticated = status.authenticated;
        const authorizationState = JSON.stringify({ authenticated, credentialState: status.credentialState, renewable: status.renewable });
        if (authorizationState !== lastAuthorizationState) {
          lastAuthorizationState = authorizationState;
          process.stdout.write(`${JSON.stringify({ event: 'authorization_state', checkedAt: new Date().toISOString(),
            authenticated, credentialState: status.credentialState, renewable: status.renewable })}\n`);
        }
        const includeUsage = Date.now() - usageAttemptAt >= 300000;
        if (includeUsage) usageAttemptAt = Date.now();
        const metadata = authenticated ? await metadataReader.read({ includeUsage })
          : { models: [], subscriptionUsage: unavailableClaudeUsage('not_authenticated') };
        if (!catalogAbort.signal.aborted) {
          if (metadata.subscriptionUsage) subscriptionUsage = metadata.subscriptionUsage;
          authorizationVersion = metadata.authorizationVersion ?? null;
          server.gateway.replaceRoutes(metadata.models.map(routeFor));
        }
      } catch { if (!catalogAbort.signal.aborted) { subscriptionUsage = unavailableClaudeUsage('fetch_failed'); authorizationVersion = null; server.gateway.replaceRoutes([]); } }
    })().finally(() => { catalogPending = null; });
    await refreshCatalog();
    catalogTimer = setInterval(() => { void refreshCatalog(); }, 60000); catalogTimer.unref();
  }
  await new Promise((yes, no) => {
    server.once('error', no); server.listen(config.listener.port, config.listener.address, () => {
      server.off('error', no); yes();
    });
  });
  controlStart = startRelayControl({ key: gatewayKey, address: process.platform === 'win32'
    ? `\\\\.\\pipe\\CodexAccountBridge-ClaudeRelay-${process.pid}` : join(config.cli.stateDir, `control-${process.pid}.sock`),
  onStop: () => close().catch(() => { process.exitCode = 1; }) });
  control = await controlStart;
  server.on('error', () => { process.exitCode = 1; void close().catch(() => {}); });
  const signalStop = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
  process.stdout.write(`${JSON.stringify({ event: 'ready', transport: 'official-claude-sdk',
    listener: server.address(), controlPipe: control.address(),
    configuredModels: [...server.gateway.routes.keys()], realInference: false })}\n`);
} catch {
  await close().catch(() => {});
  process.stderr.write('Claude relay could not start. Check the private configuration, official CLI and listener.\n');
  process.exitCode = 1;
}
