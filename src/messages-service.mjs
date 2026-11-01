import { isIP } from 'node:net';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { readJson } from './storage.mjs';
import { startWithService } from './with-service.mjs';
import { createAnthropicGatewayServer } from './anthropic-gateway.mjs';
import { AnthropicHttpProvider } from './anthropic-http-provider.mjs';
import { startTcpForwarder, validateTcpForwarderConfig } from './tcp-forwarder.mjs';

class MessagesConfigError extends Error {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const providerReady = value => typeof value?.request === 'function' && typeof value?.status === 'function';
const emptyMetrics = () => ({ requests: 0, completed: 0, failed: 0, active: 0,
  lastError: null, lastUsage: null, usageError: null });

function invalid(field) {
  throw new MessagesConfigError(`Messages 网关配置无效，请检查 ${field}。`);
}

function validHost(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:[\]-]+$/.test(value)) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return Boolean(parsed.hostname) && parsed.pathname === '/' && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash;
  } catch { return false; }
}

function validKeyPath(value) {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.trim() !== value ||
      /[\x00-\x1f\x7f]/.test(value)) return false;
  const root = parse(value).root;
  // Keep authentication reads local; reject Windows network/device paths and alternate data streams.
  return !root.startsWith('\\\\') && !value.slice(root.length).includes(':');
}

function keyFileLoader(filePath) {
  const absolutePath = resolve(filePath);
  return async () => {
    let handle;
    try {
      // Inspect every component so a configured link cannot silently redirect an authentication read.
      for (let current = absolutePath;; current = dirname(current)) {
        const details = await lstat(current);
        if (details.isSymbolicLink() || current === absolutePath && !details.isFile()) throw new Error();
        if (dirname(current) === current) break;
      }
      handle = await open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const details = await handle.stat();
      if (!details.isFile() || details.size > 4098) throw new Error();
      const bytes = Buffer.alloc(4099);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4098) throw new Error();
      const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)).replace(/\r?\n$/, '');
      if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error();
      return key;
    } catch { throw new Error('Claude 上游独立认证文件暂不可用。'); }
    finally { await handle?.close().catch(() => {}); }
  };
}

function canonicalAddress(value) {
  const address = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(address) !== 6) return address;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const upper = Number.parseInt(mapped[1], 16), lower = Number.parseInt(mapped[2], 16);
  return `${upper >>> 8}.${upper & 255}.${lower >>> 8}.${lower & 255}`;
}

function loopsToListener(upstream, listener) {
  if (upstream.protocol !== 'http:' || Number(upstream.port || 80) !== listener.port) return false;
  const target = canonicalAddress(upstream.hostname), bound = canonicalAddress(listener.address);
  const wildcard = address => address === '0.0.0.0' || address === '::';
  const loopback = address => address === 'localhost' || address === '::1' || /^127\./.test(address);
  return target === bound || wildcard(target) ||
    loopback(target) && (loopback(bound) || wildcard(bound));
}

function validateConfig(config, { codeBuddyProvider, codeBuddyModel, codeBuddyEnabled, reservedPorts }) {
  if (!object(config) || config.version !== 1) invalid('version');
  const listener = config.listener;
  if (!object(listener) || typeof listener.address !== 'string' || !isIP(listener.address)) invalid('listener.address');
  if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) invalid('listener.port');
  if (!Array.isArray(reservedPorts) || !reservedPorts.every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) {
    invalid('reservedPorts');
  }
  if (reservedPorts.includes(listener.port)) invalid('listener.port（主服务保留端口）');
  if (!Array.isArray(listener.allowedHosts) || !listener.allowedHosts.length || !listener.allowedHosts.every(validHost)) {
    invalid('listener.allowedHosts');
  }
  if (!Array.isArray(listener.allowedPeers) || !listener.allowedPeers.length ||
      !listener.allowedPeers.every(value => typeof value === 'string' && isIP(value))) invalid('listener.allowedPeers');
  if (typeof config.gatewayKey !== 'string' || config.gatewayKey.length < 40 || config.gatewayKey.length > 4096 ||
      /[\x00-\x20\x7f]/.test(config.gatewayKey)) invalid('gatewayKey');
  if (!Array.isArray(config.routes) || !config.routes.length) invalid('routes');
  const seen = new Set();
  for (const route of config.routes) {
    if (!object(route) || !object(route.model) || !modelId(route.model.id) ||
        typeof route.model.name !== 'string' || !route.model.name.trim() || route.model.name.length > 256 ||
        /[\x00-\x1f\x7f]/.test(route.model.name) || seen.has(route.model.id) ||
        (route.model.upstream !== undefined && !modelId(route.model.upstream))) invalid('routes[].model');
    seen.add(route.model.id);
    if (route.provider === 'codebuddy') {
      if (route.account !== 'CodeBuddy') invalid('routes[].account');
      if (codeBuddyEnabled !== true || !providerReady(codeBuddyProvider) || !modelId(codeBuddyModel?.id)) {
        invalid('CodeBuddy 授权渠道');
      }
      if (route.model.id !== codeBuddyModel.id ||
          (route.model.upstream !== undefined && route.model.upstream !== codeBuddyModel.id)) invalid('CodeBuddy 模型');
    } else if (route.provider === 'claude-cli') {
      if (route.account !== 'Claude') invalid('routes[].account');
    } else invalid('routes[].provider');
  }
  if (config.routes.some(route => route.provider === 'claude-cli')) {
    if (!object(config.claudeCli) || typeof config.claudeCli.baseUrl !== 'string' ||
        /[\x00-\x20\x7f]/.test(config.claudeCli.baseUrl)) invalid('claudeCli.baseUrl');
    let upstream;
    try { upstream = new URL(config.claudeCli.baseUrl); } catch { invalid('claudeCli.baseUrl'); }
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
        upstream.search || upstream.hash) invalid('claudeCli.baseUrl');
    if (loopsToListener(upstream, listener)) invalid('claudeCli.baseUrl（不能指向当前 Messages 监听器）');
    if (config.claudeCli.cacheMode !== undefined && config.claudeCli.cacheMode !== 'cli') {
      invalid('claudeCli.cacheMode');
    }
    if (config.claudeCli.apiKeyFile !== undefined && !validKeyPath(config.claudeCli.apiKeyFile)) {
      invalid('claudeCli.apiKeyFile（需要本地绝对文件路径）');
    }
    if (config.claudeCli.tcpForward !== undefined) {
      let forward;
      try { forward = validateTcpForwarderConfig(config.claudeCli.tcpForward); }
      catch { invalid('claudeCli.tcpForward'); }
      if (reservedPorts.includes(forward.listener.port) || forward.listener.port === listener.port) {
        invalid('claudeCli.tcpForward.listener.port（保留或冲突端口）');
      }
      if (upstream.protocol !== 'http:' || canonicalAddress(upstream.hostname) !== forward.listener.address ||
          Number(upstream.port || 80) !== forward.listener.port || !['/', '/v1', '/v1/'].includes(upstream.pathname)) {
        invalid('claudeCli.baseUrl（必须指向配置的 TCP 回环监听器）');
      }
      const targetAddress = isIP(forward.target.ip) === 6 ? `[${forward.target.ip}]` : forward.target.ip;
      if (loopsToListener(new URL(`http://${targetAddress}:${forward.target.port}`), listener)) {
        invalid('claudeCli.tcpForward.target（不能指向当前 Messages 监听器）');
      }
    }
  }
}

function listen(server, port, address) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(port, address, () => { server.off('error', failed); resolve(); });
  });
}

function listenerUrl(listener) {
  const address = isIP(listener.address) === 6 ? `[${listener.address}]` : listener.address;
  return `http://${address}:${listener.port}`;
}

export async function startMessagesService({ stateDir, codeBuddyProvider = null, codeBuddyModel = null,
  codeBuddyEnabled = false, onUsage, onDiagnostic, getAuthorizationVersion, listenImpl = listen, readConfigImpl = readJson,
  startLegacyImpl = startWithService, createServerImpl = createAnthropicGatewayServer,
  createHttpProvider = options => new AnthropicHttpProvider(options), startTcpForwarderImpl = startTcpForwarder,
  reservedPorts = [], isDraining = () => false, isAccountEnabled = () => true, ...legacyOptions } = {}) {
  const missing = Symbol('missing messages configuration');
  let config, setupError = null;
  try { config = await readConfigImpl(join(stateDir, 'messages-gateway.json'), missing); }
  catch { setupError = 'Messages 网关配置无法读取，请检查 messages-gateway.json。'; }
  if (config === missing) {
    return startLegacyImpl({ stateDir, codeBuddyProvider, codeBuddyModel, codeBuddyEnabled,
      onUsage, onDiagnostic, getAuthorizationVersion, listenImpl, isDraining, isAccountEnabled, ...legacyOptions });
  }

  let server = null, tcpForwarder = null, running = false, baseUrl = null, closeOperation = null;
  const accounts = new Set(), ownedProviders = [];
  async function close() {
    if (closeOperation) return closeOperation;
    running = false;
    closeOperation = (async () => {
      if (server) {
        await new Promise(resolve => {
          try { server.close(() => resolve()); server.closeAllConnections?.(); }
          catch { resolve(); }
        });
      }
      await Promise.allSettled(ownedProviders.map(provider => Promise.resolve().then(() => provider.close?.())));
      try { await tcpForwarder?.close(); } catch {}
    })();
    return closeOperation;
  }

  if (!setupError) {
    try {
      if (Array.isArray(config?.routes)) config = { ...config, routes: config.routes.filter(route => isAccountEnabled(route.account, route.model?.id) === true) };
      validateConfig(config, { codeBuddyProvider, codeBuddyModel, codeBuddyEnabled, reservedPorts });
      baseUrl = listenerUrl(config.listener);
      const loadClaudeKey = !config.routes.some(route => route.provider === 'claude-cli') ||
        config.claudeCli.apiKeyFile === undefined ? undefined : keyFileLoader(config.claudeCli.apiKeyFile);
      if (config.routes.some(route => route.provider === 'claude-cli') && config.claudeCli.tcpForward !== undefined) {
        tcpForwarder = await startTcpForwarderImpl(config.claudeCli.tcpForward);
        if (typeof tcpForwarder?.close !== 'function') throw new Error();
      }
      const routes = config.routes.map(route => {
        accounts.add(route.account);
        const model = { id: route.model.id, name: route.model.name,
          ...(route.model.upstream === undefined ? {} : { upstream: route.model.upstream }) };
        let provider = codeBuddyProvider;
        if (route.provider === 'claude-cli') {
          provider = createHttpProvider({ baseUrl: config.claudeCli.baseUrl,
            model: model.upstream ?? model.id, cacheMode: config.claudeCli.cacheMode ?? 'cli',
            ...(loadClaudeKey === undefined ? {} : { loadKey: loadClaudeKey }) });
          ownedProviders.push(provider);
        }
        return { account: route.account, model, provider };
      });
      server = createServerImpl({ routes, gatewayKey: config.gatewayKey, isDraining, isAccountEnabled,
        allowedHosts: [...config.listener.allowedHosts], allowedPeers: [...config.listener.allowedPeers], onUsage, onDiagnostic, getAuthorizationVersion });
      await listenImpl(server, config.listener.port, config.listener.address);
      running = true;
    } catch (error) {
      setupError = error instanceof MessagesConfigError ? error.message : error?.code === 'EADDRINUSE'
        ? 'Messages 网关端口已被占用，请检查 listener.port。'
        : 'Messages 网关启动失败，请检查配置、上游地址及监听端口。';
      await close();
    }
  }

  function channelStatus(account) {
    const metrics = server?.gateway.status(account) ?? emptyMetrics();
    return { deployment: 'generic', running: running && accounts.has(account), baseUrl,
      ...metrics, ...(setupError ? { lastError: setupError } : {}) };
  }

  return {
    get activeRequests() { return server?.gateway.pendingRequests ?? 0; },
    channelStatus,
    async status() {
      return { deployment: 'generic', configured: false, running: false, manualVerification: true,
        provider: { authenticated: null, ready: false, error: setupError },
        gateway: channelStatus('With'), vm: { configured: false },
        channels: Object.fromEntries([...accounts].map(account => [account, channelStatus(account)])) };
    },
    close,
  };
}
