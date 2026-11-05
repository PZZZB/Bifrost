import { isAbsolute } from 'node:path';
import { createHmac } from 'node:crypto';
import { buildClaudeEnvironment } from './claude-sdk-worker.mjs';
import { readClaudeSubscriptionUsage } from './claude-subscription-usage.mjs';

const text = v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
/** SDK-owned selectable options; no guessed historical model IDs or wire rewrites. */
export function claudeCatalogModels(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid Claude model catalog.');
  const found = new Map();
  for (const row of rows) {
    if (!text(row?.value) || !/^[a-z][a-z0-9._-]{0,120}(?:\[[1-9][0-9]*[km]\])?$/.test(row.value) || !text(row.displayName)) continue;
    if (row.value === 'default' && text(row.resolvedModel) && rows.some(r => r.value !== 'default' && r.resolvedModel === row.resolvedModel)) continue;
    const alias = row.value.replace(/\[([1-9][0-9]*[km])\]$/, '-$1');
    const id = alias.startsWith('claude-') ? alias : `claude-${alias}`;
    if (found.has(id)) throw new Error('Conflicting Claude model aliases.');
    const efforts = Array.isArray(row.supportedEffortLevels) ? [...new Set(row.supportedEffortLevels.filter(e => ['low','medium','high','xhigh','max'].includes(e)))] : [];
    found.set(id, { id, name: /^Claude\b/i.test(row.displayName) ? row.displayName : `Claude ${row.displayName}`, upstream: row.value,
      ...(text(row.resolvedModel) ? { resolvedModel: row.resolvedModel } : {}), ...(text(row.description) ? { description: row.description } : {}),
      ...(typeof row.supportsEffort === 'boolean' ? { supportsReasoning: row.supportsEffort } : {}),
      ...(efforts.length ? { efforts } : {}) });
  }
  return [...found.values()];
}

/** A relay-owned, empty SDK input. Polling metadata must not repeatedly start
 * and kill CLI initialization, which can race an OAuth refresh token rotation. */
export class ClaudeMetadataReader {
  constructor({ binary, configDir, profileDir, stateDir, env = process.env, queryImpl, signal, timeoutMs = 12000,
    identitySecret } = {}) {
    if (![binary, configDir, profileDir, stateDir].every(p => typeof p === 'string' && isAbsolute(p)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid Claude catalog configuration.');
    this.options = { binary, configDir, profileDir, stateDir, env, queryImpl, identitySecret };
    this.timeoutMs = timeoutMs; this.stop = new AbortController(); this.closed = false;
    this.signal = signal; this.cancel = () => { void this.close().catch(() => {}); };
    signal?.addEventListener('abort', this.cancel, { once: true }); if (signal?.aborted) this.cancel();
  }

  async session() {
    if (this.closed) throw new Error('Claude catalog closed.');
    if (this.current) return this.current;
    return this.starting ??= (async () => {
      const { binary, configDir, profileDir, stateDir, env, queryImpl } = this.options;
      const query = queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      if (this.closed) throw new Error('Claude catalog closed.');
      const controller = new AbortController(); let release;
      const wait = new Promise(resolve => { release = resolve; }); async function* emptyInput() { await wait; }
      const instance = query({ prompt: emptyInput(), options: { pathToClaudeCodeExecutable: binary, cwd: stateDir,
        env: buildClaudeEnvironment({ configDir, profileDir, env }), abortController: controller,
        tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false,
        settings: { disableAllHooks: true, disableClaudeAiConnectors: true }, stderr: () => {} } });
      const session = { instance, controller, release, exit: new AbortController() };
      this.current = session;
      // Consume only lifecycle events. The empty input never submits inference.
      // Recreate on a confirmed SDK exit, never merely on a slow metadata read.
      if (typeof instance[Symbol.asyncIterator] === 'function') session.drain = (async () => {
        try { for await (const _ of instance) { /* No prompts or outputs are logged. */ } }
        catch { /* Pending reads report a sanitized disconnected error below. */ }
        finally { release(); session.exit.abort(); if (this.current === session) this.current = null; }
      })();
      return session;
    })().finally(() => { this.starting = null; });
  }

  read({ includeUsage = true, modelsOnly = false } = {}) {
    if (this.closed) return Promise.reject(new Error('Claude catalog closed.'));
    // Coalesce overlapping refreshes, including calls whose caller timed out.
    // A timeout does not abort a CLI while it may be persisting renewed OAuth.
    this.pending ??= (async () => {
      const session = await this.session();
      return bounded(() => modelsOnly ? session.instance.supportedModels().then(claudeCatalogModels)
        : readMetadata(session.instance, { ...this.options, includeUsage }), undefined, session.exit.signal);
    })().finally(() => { this.pending = null; });
    const pending = this.pending;
    return bounded(() => pending, this.timeoutMs, this.stop.signal);
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.stop.abort(); this.signal?.removeEventListener('abort', this.cancel);
    return this.closing = (async () => {
      await this.starting?.catch(() => {});
      const session = this.current; this.current = null;
      if (session) {
        session.release();
        try { await session.instance.close(); } finally { session.controller.abort(); session.exit.abort(); }
      }
    })();
  }
}

/** One-shot helpers for offline tools; long-running relays own a reader. */
async function once(options, readOptions) {
  const reader = new ClaudeMetadataReader(options);
  try { return await reader.read(readOptions); } finally { await reader.close(); }
}
export function discoverClaudeModels(options) { return once(options, { modelsOnly: true }); }
export function discoverClaudeMetadata(options) { return once(options, { includeUsage: options.includeUsage }); }

async function readMetadata(query, options) {
    const usage = options.includeUsage === false ? Promise.resolve(null) : readClaudeSubscriptionUsage(query);
    const models = claudeCatalogModels(await query.supportedModels());
    let authorizationVersion = null;
    if (typeof options.identitySecret === 'string' && options.identitySecret.length >= 40 && typeof query.accountInfo === 'function') {
      try {
        const account = await bounded(() => query.accountInfo(), 1500);
        if (text(account?.email)) authorizationVersion = createHmac('sha256', options.identitySecret)
          .update(JSON.stringify([account.email, typeof account.organization === 'string' ? account.organization : null,
            typeof account.apiProvider === 'string' ? account.apiProvider : null])).digest('hex');
      } catch { /* Missing identity never becomes a guessed verification generation. */ }
    }
    // Read the selected CLI budget, without sending an inference prompt. Match
    // its resolved model so an alias fallback cannot label another model.
    if (typeof query.setModel === 'function' && typeof query.getContextUsage === 'function') {
      const deadline = Date.now() + 5000;
      for (const model of models.slice(0, 25)) {
        if (Date.now() >= deadline) break;
        try {
          const context = await bounded(async () => { await query.setModel(model.upstream); return query.getContextUsage({ detail: 'summary' }); }, Math.min(800, deadline - Date.now()));
          if (model.resolvedModel && context?.model === model.resolvedModel && Number.isSafeInteger(context.maxTokens)
            && context.maxTokens > 0 && context.maxTokens <= 1_000_000_000) {
            model.contextWindow = context.maxTokens; model.contextSource = 'official-cli-runtime';
          }
        } catch { break; }
      }
    }
    return { models, subscriptionUsage: await usage, authorizationVersion };
}

async function bounded(read, timeoutMs, signal) {
  let timer, cancel;
  try { return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    cancel = () => reject(new Error('Claude catalog cancelled.'));
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(new Error('Claude metadata timed out.')), timeoutMs);
  })]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
