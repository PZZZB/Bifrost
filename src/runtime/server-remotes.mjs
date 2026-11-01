import { createHash } from 'node:crypto';
import { BridgeError } from '../storage.mjs';
import { BifrostRemote } from '../providers/bifrost-remote.mjs';
import { ModelRouter } from '../routing/model-router.mjs';
import { DesktopWire } from '../routing/desktop-wire.mjs';
import { loadServerRemotesConfig, validateServerRemotes, serverRemoteCredentialStore } from './server-remotes-config.mjs';

export const REMOTE_RESPONSES_STATE_PREFIX = 'bifrost-remote-responses-v1:';

/** Reuse the same providers, router and protocol/state adapters as Desktop.
 * Server keeps its existing listener, local sources and Codex integration. */
export async function startServerRemotes({ stateDir, secret, config: suppliedConfig,
  loadKey = async source => (await serverRemoteCredentialStore(stateDir, source).load())?.apiKey,
  fetchImpl = fetch, refreshIntervalMs = 15_000 } = {}) {
  const config = suppliedConfig ? validateServerRemotes(suppliedConfig) : await loadServerRemotesConfig(stateDir);
  if (!config.sources.length) return null;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 100) throw new TypeError('Invalid remote refresh interval.');
  const providers = [];
  let router, timer;
  try {
    for (const source of config.sources) {
      providers.push(new BifrostRemote({ ...source, apiKey: await loadKey(source), stateSecret: secret, fetchImpl }));
    }
    router = new ModelRouter({ providers, secret });
    const wire = new DesktopWire({ secret, prefix: REMOTE_RESPONSES_STATE_PREFIX });
    const generation = createHash('sha256').update(JSON.stringify(providers.map(provider => [provider.id, provider.generation]))).digest('hex');
    const models = () => router.models().filter(model => model.protocols.includes('responses'));
    const model = id => {
      try {
        const context = router.resolve('responses', { body: { model: id } });
        return { ...context.public, upstreamModel: context.upstreamModel };
      } catch { return null; }
    };
    const refresh = () => router.refresh();
    void refresh();
    timer = setInterval(() => { void refresh(); }, refreshIntervalMs); timer.unref();
    return { generation, models, model, refresh, status: () => router.status(),
      async request({ path, body, scope, session = '', signal }) {
        if (path !== '/responses') throw new BridgeError('远端来源不支持该接口；请使用普通 Responses 请求。', 501, 'remote_protocol_unsupported');
        const context = router.resolve('responses', { body, owner: scope || 'server-owner', session });
        const prepared = wire.input(body, context);
        const upstream = await router.request(context, { body: prepared, signal });
        try { return await wire.response(upstream, context); }
        catch (error) { await upstream.body?.cancel().catch(() => {}); throw error; }
      },
      async close() { clearInterval(timer); await router.close(); } };
  } catch (error) {
    clearInterval(timer);
    await Promise.allSettled(providers.map(provider => provider.close()));
    throw error;
  }
}
