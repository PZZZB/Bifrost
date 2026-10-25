import { join } from 'node:path';
import { readJson } from './storage.mjs';
import { createClientServer } from './client-server.mjs';

export async function startClientService({ stateDir, reservedPorts = [], readConfig = readJson,
  listen = (server, port, address) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => { server.off('error', reject); resolve(); });
  }), ...options }) {
  let server, error = null, configured = true, endpoint = null;
  try {
    const config = await readConfig(join(stateDir, 'client-gateway.json'), {
      version: 1, enabled: true, listener: { address: '127.0.0.1', port: 43159, allowedHosts: ['localhost:43159', '127.0.0.1:43159'] },
      publicBaseUrl: 'http://127.0.0.1:43159',
    });
    if (!config || config.version !== 1 || typeof config.enabled !== 'boolean') throw new Error();
    configured = config.enabled;
    if (!configured) return { status: () => ({ enabled: false, ready: false, message: '用户接入入口已在配置中关闭。' }), endpoint: () => null,
      get activeRequests() { return 0; }, async close() {} };
    const { listener } = config;
    if (!listener || !['127.0.0.1', '::1'].includes(listener.address) || !Number.isInteger(listener.port) || listener.port < 1024 || listener.port > 65535
      || reservedPorts.includes(listener.port) || !Array.isArray(listener.allowedHosts) || listener.allowedHosts.length > 32
      || listener.allowedHosts.some(host => typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host))) throw new Error();
    const publicUrl = new URL(config.publicBaseUrl);
    if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname))) throw new Error();
    server = createClientServer({ ...options, publicBaseUrl: config.publicBaseUrl, allowedHosts: listener.allowedHosts });
    endpoint = server.clientEndpoint();
    await listen(server, listener.port, listener.address);
  } catch {
    error = '用户接入入口未启动，请检查 client-gateway.json、用户数据库及端口占用。';
    server?.close(); server?.closeAllConnections(); server = null;
  }
  return { status: () => ({ enabled: configured, ready: server?.listening === true, message: error }), endpoint: () => endpoint,
    get activeRequests() { return server?.activeRequests ?? 0; },
    async close() { if (server) { const current = server; server = null; await new Promise(resolve => { current.close(resolve); current.closeAllConnections(); }); } } };
}
