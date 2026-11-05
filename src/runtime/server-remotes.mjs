import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError } from '../storage.mjs';
import { BifrostRemote } from '../providers/bifrost-remote.mjs';
import { ModelRouter } from '../routing/model-router.mjs';
import { DesktopWire } from '../routing/desktop-wire.mjs';
import { loadServerRemotesConfig, validateServerRemotes, serverRemoteCredentialStore } from './server-remotes-config.mjs';
import { adaptCrossProviderHistory } from '../protocols/cross-provider-history.mjs';
import { REMOTE_RESPONSES_STATE_PREFIX } from '../protocols/remote-state.mjs';
import { bifrostQuotaSnapshot, remoteQuotaCard } from '../bifrost-quotas.mjs';
import { ForkLineage } from '../fork-lineage.mjs';

export { REMOTE_RESPONSES_STATE_PREFIX } from '../protocols/remote-state.mjs';

const LEGACY_CACHE_LIMIT = 512;
const LEGACY_TOKEN_LIMIT = 8 * 1024 * 1024;
const LEGACY_SCAN_BYTE_LIMIT = 128 * 1024 * 1024;
const LEGACY_SCAN_ATTEMPT_LIMIT = 4096;
const LEGACY_SCAN_TIME_LIMIT_MS = 1000;
const legacyBudgetError = () => new BridgeError('旧版历史状态超过本地验证预算，请保留会话并联系管理员迁移。', 409, 'remote_legacy_state_budget_exceeded');

/** Reuse the same providers, router and protocol/state adapters as Desktop.
 * Server keeps its existing listener, local sources and Codex integration. */
export async function startServerRemotes({ stateDir, secret, config: suppliedConfig,
  loadKey = async source => (await serverRemoteCredentialStore(stateDir, source).load())?.apiKey,
  fetchImpl = fetch, refreshIntervalMs = 15_000 } = {}) {
  const config = suppliedConfig ? validateServerRemotes(suppliedConfig) : await loadServerRemotesConfig(stateDir);
  if (!config.sources.length) return null;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 100) throw new TypeError('Invalid remote refresh interval.');
  const providers = [];
  const lineage = await ForkLineage.open({ path: join(stateDir, 'remote-fork-lineage.json'), secret });
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
    const snapshotContext = context => context.provider.supportsSnapshotState?.(context.upstreamModel, context.protocol) === true
      ? { ...context, scope: context.snapshotScope } : context;
    const legacyIssuers = new Map(), legacyBudgets = new WeakMap();
    const readKnownState = async (token, id, { clientScope = null, session = '', fork = null, kind, signal } = {}, hint = null, budget = null, tokenBytes = 0) => {
      cancelled(signal);
      if (budget && performance.now() > budget.deadline) throw legacyBudgetError();
      const context = contextFor(id, { clientScope, session });
      const stateContext = snapshotContext(context), snapshot = stateContext.scope !== context.scope;
      const candidates = [stateContext];
      if (snapshot) {
        candidates.push(context);
        if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session)) for (const candidate of lineage.candidates({ owner: clientScope || 'server-owner', session,
          parentSession: fork?.parentSession ?? null, familySession: fork?.familySession ?? null })) {
          if (budget && performance.now() > budget.deadline) throw legacyBudgetError();
          candidates.push(contextFor(context.id, { clientScope, session: candidate }));
        }
      }
      let value, issuer, failure;
      for (const candidate of [...new Map(candidates.map(candidate => [candidate.scope, candidate])).values()]) {
        if (budget) {
          budget.attempts++; budget.bytes += tokenBytes;
          if (budget.attempts > LEGACY_SCAN_ATTEMPT_LIMIT || budget.bytes > LEGACY_SCAN_BYTE_LIMIT || performance.now() > budget.deadline) throw legacyBudgetError();
        }
        try { value = wire.openState(token, candidate, { kind }); issuer = candidate; break; }
        catch (error) { failure ??= error; }
      }
      if (!issuer) throw failure;
      if (snapshot) {
        // Only our Messages adapter can authenticate and rebind its own inner
        // thinking/summary state. Unknown remote live handles remain thread-bound.
        value = context.provider.rebindSnapshotState(value, { fromScope: issuer.scope, scope: stateContext.scope,
          model: context.upstreamModel, kind: hint?.kind ?? kind });
        if (issuer.scope !== stateContext.scope && fork?.parentSession) {
          try { await lineage.remember({ owner: clientScope || 'server-owner', session, parentSession: fork.parentSession }); }
          catch { throw new BridgeError('旧历史的分叉关系未能保存，请检查网关数据目录。', 503, 'remote_fork_lineage_unavailable'); }
        }
      }
      cancelled(signal);
      return { context, stateContext, value, kind: hint?.kind ?? kind, legacy: hint === null,
        legacyScope: issuer.scope !== stateContext.scope ? issuer.scope : null };
    };
    const readState = async (token, options = {}) => {
      const { clientScope = null, model = null, kind, signal } = options;
      cancelled(signal);
      const hint = wire.stateHint(token);
      if (hint) {
        if (hint.protocol !== 'responses' || kind != null && hint.kind !== kind) throw new BridgeError('远端历史条目的类型或协议不匹配。', 409, 'desktop_state_mismatch');
        return readKnownState(token, hint.model, options, hint);
      }
      const tokenBytes = Buffer.byteLength(token, 'utf8');
      if (tokenBytes > LEGACY_TOKEN_LIMIT) throw legacyBudgetError();
      const owner = clientScope || 'server-owner';
      const cacheKey = createHash('sha256').update(owner).update('\0').update(token).digest('hex');
      const cachedId = legacyIssuers.get(cacheKey);
      // A cache entry only orders candidates. Current authorization generation,
      // owner, model, protocol and ciphertext are authenticated again every time.
      legacyIssuers.delete(cacheKey);
      let budget = signal && typeof signal === 'object' ? legacyBudgets.get(signal) : null;
      if (!budget) {
        budget = { attempts: 0, bytes: 0, deadline: performance.now() + LEGACY_SCAN_TIME_LIMIT_MS };
        if (signal && typeof signal === 'object') legacyBudgets.set(signal, budget);
      }
      const registered = new Set(models().map(entry => entry.id));
      const ids = [...new Set([model, cachedId, ...registered])].filter(id => registered.has(id));
      for (const id of ids) {
        cancelled(signal);
        try {
          const opened = await readKnownState(token, id, options, null, budget, tokenBytes);
          legacyIssuers.set(cacheKey, opened.context.id);
          while (legacyIssuers.size > LEGACY_CACHE_LIMIT) legacyIssuers.delete(legacyIssuers.keys().next().value);
          return opened;
        } catch (error) {
          cancelled(signal);
          if (error.code === 'remote_legacy_state_budget_exceeded' || error.code === 'remote_fork_lineage_unavailable') throw error;
        }
      }
      throw new BridgeError('旧版远端历史状态未能通过当前已登记来源的本地认证，请保留会话并检查来源授权。', 409, 'remote_legacy_state_unavailable');
    };
    const inspectStateForHandoff = async (token, options) => {
      const opened = await readState(token, options);
      return { model: opened.context.id, kind: opened.kind, legacy: opened.legacy };
    };
    const openCompactionForHandoff = async (token, options = {}) => {
      const opened = await readState(token, { ...options, kind: options.kind ?? 'compaction' });
      if (!['compaction', 'context_compaction'].includes(opened.kind)
          || typeof opened.context.provider.openCompactionForHandoff !== 'function') {
        throw new BridgeError('远端来源不能恢复此历史摘要，请先使用原模型继续。', 409, 'remote_compaction_unavailable');
      }
      const summary = await opened.context.provider.openCompactionForHandoff(opened.value, {
        scope: opened.stateContext.scope, model: opened.context.upstreamModel, signal: options.signal,
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
      async request({ path, body, scope, session = '', fork = null, signal }) {
        if (path !== '/responses') throw new BridgeError('远端来源不支持该接口；请使用普通 Responses 请求。', 501, 'remote_protocol_unsupported');
        const context = contextFor(body?.model, { clientScope: scope, session });
        const stateContext = snapshotContext(context), legacyScopes = new Set();
        const history = await adaptCrossProviderHistory(body, { target: 'Bifrost', clientScope: scope, session, fork, signal,
          inspectRemoteState: inspectStateForHandoff, openRemoteCompaction: openCompactionForHandoff });
        const prepared = structuredClone(history.body);
        for (const item of Array.isArray(prepared.input) ? prepared.input : []) {
          if (!['reasoning', 'compaction', 'context_compaction'].includes(item?.type) || item.encrypted_content == null) continue;
          const opened = await readState(item.encrypted_content, { clientScope: scope, session, fork, model: context.id, kind: item.type, signal });
          if (opened.context.id !== context.id) throw new BridgeError('历史状态与所选模型不匹配。', 409, 'desktop_state_mismatch');
          item.encrypted_content = opened.value;
          if (opened.legacyScope) legacyScopes.add(opened.legacyScope);
        }
        const upstream = await router.request(context, { body: prepared, signal,
          snapshot: stateContext.scope !== context.scope, legacyScopes: [...legacyScopes] });
        try { return await wire.response(upstream, stateContext); }
        catch (error) { await upstream.body?.cancel().catch(() => {}); throw error; }
      },
      async close() { closed = true; clearInterval(timer); await router.close(); } };
  } catch (error) {
    clearInterval(timer);
    await Promise.allSettled(providers.map(provider => provider.close()));
    throw error;
  }
}
