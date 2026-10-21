import http from 'node:http';
import { AnthropicGateway } from './anthropic-gateway.mjs';

export { normalizeAnthropicUsage } from './anthropic-gateway.mjs';

export const WITH_MODEL = Object.freeze({
  id: 'claude-opus-5-5', name: 'With · Opus 5.5', upstream: 'claude-opus-5.5',
});

export class WithGateway extends AnthropicGateway {
  constructor({ provider, gatewayKey, allowedHosts = ['192.168.168.1:43157'],
    allowedPeers = ['192.168.168.10'], onUsage = async () => {}, maxBodyBytes = 64 * 1024 * 1024,
    additionalRoutes = [], withEnabled = true } = {}) {
    if (typeof withEnabled !== 'boolean') throw new TypeError('With enabled must be a boolean.');
    if (withEnabled && (typeof provider?.request !== 'function' || typeof provider?.status !== 'function')) {
      throw new TypeError('With provider request() and status() are required.');
    }
    if (typeof gatewayKey !== 'string' || !gatewayKey) throw new TypeError('A dedicated With gatewayKey is required.');
    const routes = withEnabled ? [{ account: 'With', model: WITH_MODEL, provider }] : [];
    const modelIds = new Set([WITH_MODEL.id]);
    for (const route of additionalRoutes) {
      if (!route || route.account !== 'CodeBuddy' || typeof route.model?.id !== 'string' || !route.model.id ||
          modelIds.has(route.model.id) || typeof route.provider?.request !== 'function' ||
          typeof route.provider?.status !== 'function') throw new TypeError('Invalid additional VM model route.');
      modelIds.add(route.model.id);
      routes.push(route);
    }
    super({ routes, gatewayKey, allowedHosts, allowedPeers, onUsage, maxBodyBytes });
    this.provider = withEnabled ? provider : null;
  }

  status(account = this.routes.has(WITH_MODEL.id) ? 'With' : 'CodeBuddy') {
    return super.status(account);
  }

  gatewayError(code, status, message) {
    const error = super.gatewayError(code, status, message);
    error.code = `with_${code}`;
    return error;
  }

  providerMetadata(route, metadata) {
    return route.account === 'With' ? {
      authenticated: typeof metadata?.authenticated === 'boolean' ? metadata.authenticated : null,
      ...(typeof metadata?.ready === 'boolean' ? { ready: metadata.ready } : {}),
      error: metadata?.error ? this.safeError(metadata.error) : null,
    } : super.providerMetadata(route, { ...metadata, authenticated: metadata?.authenticated === true });
  }

  async modelAvailable(route) {
    return route.account === 'With' || await super.modelAvailable(route);
  }
}

export function createWithGatewayServer(options) {
  const gateway = new WithGateway(options);
  const server = http.createServer((req, res) => { void gateway.handle(req, res); });
  server.gateway = gateway;
  return server;
}
