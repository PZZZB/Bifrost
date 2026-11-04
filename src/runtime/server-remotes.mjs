import { createHash } from 'node:crypto';
import { BridgeError } from '../storage.mjs';
import { BifrostRemote } from '../providers/bifrost-remote.mjs';
import { ModelRouter } from '../routing/model-router.mjs';
import { DesktopWire } from '../routing/desktop-wire.mjs';
import { loadServerRemotesConfig, validateServerRemotes, serverRemoteCredentialStore } from './server-remotes-config.mjs';
import { adaptCrossProviderHistory } from '../protocols/cross-provider-history.mjs';
import { REMOTE_RESPONSES_STATE_PREFIX } from '../protocols/remote-state.mjs';
import { bifrostQuotaSnapshot, remoteQuotaCard } from '../bifrost-quotas.mjs';

export { REMOTE_RESPONSES_STATE_PREFIX } from '../protocols/remote-state.mjs';

/** Reuse the same providers, router and protocol/state adapters as Desktop.
 * Server keeps its existing listener, local sources and Codex integration. */
export async function startServerRemotes({ stateDir, secret, config: suppliedConfig,
  loadKey = async source => (await serverRemoteCredentialStore(stateDir, source).load())?.apiKey,
  fetchImpl = fetch, refreshIntervalMs = 15_000 } = {}) {
  const config = suppliedConfig ? validateServerRemotes(suppliedConfig) : await loadServerRemotesConfig(stateDir);
  if (!config.sources.length) return null;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 100) throw new TypeError('Invalid remote refresh interval.');
  const providers = [];
  let router, timer, closed = false;
  try {
    for (const source of config.sources) {
      providers.push(new BifrostRemote({ ...source, apiKey: await loadKey(source), stateSecret: secret, fetchImpl }));
    }
    router = new ModelRouter({ providers, secret });
    const wire = new DesktopWire({ secret, prefix: REMOTE_RESPONSES_STATE_PREFIX, selfDescribingState: true });
    const generation = createHash('sha256').update(JSON.stringify(providers.map(provider => [provider.id, provider.generation]))).digest('hex');
    const models = () => router.models().filter(model => model.protocols.includes('responses'));
    const model = id => {
      try {
        const context = router.resolve('responses', { body: { model: id }, trackSession: false });
        return { ...context.public, upstreamModel: context.upstreamModel };
      } catch { return null; }
    };
    const refresh = () => router.refresh();
    const quotaBindingKey = () => createHash('sha256').update(JSON.stringify([closed,
      providers.map(provider => [provider.id, provider.generation, provider.status().state === 'closed'])])).digest('hex');
    const accountQuotas = async ({ signal } = {}) => {
      const cards = await Promise.all(providers.map(async provider => {
        if (closed) return remoteQuotaCard(provider.id, { code: 'disabled' });
        try { return await provider.accountQuota({ signal }); }
        catch { return remoteQuotaCard(provider.id, { code: 'unavailable', fetchedAt: new Date().toISOString() }); }
      }));
      return bifrostQuotaSnapshot(cards, new Date().toISOString());
    };
    const cancelled = signal => { if (signal?.aborted) throw new BridgeError('请求已取消。', 499, 'desktop_cancelled'); };
    const contextFor = (id, { clientScope = null, session = '' } = {}) => router.resolve('responses', {
      body: { model: id }, owner: clientScope || 'server-owner', session, trackSession: false,
    });
    const readState = (token, { clientScope = null, session = '', model = null, kind, signal } = {}) => {
      cancelled(signal);
      const hint = wire.stateHint(token);
      if (!hint && !model) throw new BridgeError('旧版远端接续状态没有原模型标识，请先回到原模型继续或生成明文交接摘要。', 409, 'remote_legacy_state_unavailable');
      if (hint && (hint.protocol !== 'responses' || kind != null && hint.kind !== kind)) throw new BridgeError('远端历史条目的类型或协议不匹配。', 409, 'desktop_state_mismatch');
      const context = contextFor(hint?.model ?? model, { clientScope, session });
      const value = wire.openState(token, context, { kind });
      return { context, value, kind: hint?.kind ?? kind, legacy: hint === null };
    };
    const inspectStateForHandoff = async (token, options) => {
      const opened = readState(token, options);
      return { model: opened.context.id, kind: opened.kind, legacy: opened.legacy };
    };
    const openCompactionForHandoff = async (token, options = {}) => {
      const opened = readState(token, { ...options, kind: options.kind ?? 'compaction' });
      if (!['compaction', 'context_compaction'].includes(opened.kind)
          || typeof opened.context.provider.openCompactionForHandoff !== 'function') {
        throw new BridgeError('远端来源不能恢复此历史摘要，请先使用原模型继续。', 409, 'remote_compaction_unavailable');
      }
      const summary = await opened.context.provider.openCompactionForHandoff(opened.value, {
        scope: opened.context.scope, model: opened.context.upstreamModel, signal: options.signal,
      });
      cancelled(options.signal);
      const current = contextFor(opened.context.id, options);
      if (current.scope !== opened.context.scope || current.generation !== opened.context.generation) throw new BridgeError('来源授权已变化，请重新选择模型。', 409, 'desktop_source_changed');
      return summary;
    };
    void refresh();
    timer = setInterval(() => { void refresh(); }, refreshIntervalMs); timer.unref();
    return { generation, models, model, refresh, inspectStateForHandoff, openCompactionForHandoff, quotaBindingKey, accountQuotas, status: () => router.status(),
      async stopSource(id) { await router.provider(id).close(); },
      async request({ path, body, scope, session = '', signal }) {
        if (path !== '/responses') throw new BridgeError('远端来源不支持该接口；请使用普通 Responses 请求。', 501, 'remote_protocol_unsupported');
        const context = contextFor(body?.model, { clientScope: scope, session });
        const history = await adaptCrossProviderHistory(body, { target: 'Bifrost', clientScope: scope, session, signal,
          inspectRemoteState: inspectStateForHandoff, openRemoteCompaction: openCompactionForHandoff });
        const prepared = wire.input(history.body, context);
        const upstream = await router.request(context, { body: prepared, signal });
        try { return await wire.response(upstream, context); }
        catch (error) { await upstream.body?.cancel().catch(() => {}); throw error; }
      },
      async close() { closed = true; clearInterval(timer); await router.close(); } };
  } catch (error) {
    clearInterval(timer);
    await Promise.allSettled(providers.map(provider => provider.close()));
    throw error;
  }
}
