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

/** Initializes an empty streaming input to read metadata; never yields a prompt. */
async function withClaudeMetadata({ binary, configDir, profileDir, stateDir, env = process.env, queryImpl, signal, timeoutMs = 12000 }, read) {
  if (![binary, configDir, profileDir, stateDir].every(p => typeof p === 'string' && isAbsolute(p))) throw new Error('Invalid Claude catalog paths.');
  const query = queryImpl ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  const controller = new AbortController(); const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, timeoutMs); let release, instance;
  const wait = new Promise(resolve => { release = resolve; }); async function* emptyInput() { await wait; }
  try {
    instance = query({ prompt: emptyInput(), options: { pathToClaudeCodeExecutable: binary, cwd: stateDir,
      env: buildClaudeEnvironment({ configDir, profileDir, env }), abortController: controller,
      tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false,
      settings: { disableAllHooks: true, disableClaudeAiConnectors: true }, stderr: () => {} } });
    return await Promise.race([read(instance), new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('Claude catalog cancelled.'));
      else controller.signal.addEventListener('abort', () => reject(new Error('Claude catalog cancelled.')), { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); release(); instance?.close(); }
}
export function discoverClaudeModels(options) {
  return withClaudeMetadata(options, async query => claudeCatalogModels(await query.supportedModels()));
}
export function discoverClaudeMetadata(options) {
  return withClaudeMetadata(options, async query => {
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
  });
}

async function bounded(read, timeoutMs) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Claude metadata timed out.')), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
