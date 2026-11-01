import { isAbsolute } from 'node:path';
import { buildClaudeEnvironment } from './claude-sdk-worker.mjs';

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
export async function discoverClaudeModels({ binary, configDir, profileDir, stateDir, env = process.env, queryImpl, signal, timeoutMs = 12000 }) {
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
    const raw = await Promise.race([instance.supportedModels(), new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('Claude catalog cancelled.'));
      else controller.signal.addEventListener('abort', () => reject(new Error('Claude catalog cancelled.')), { once: true });
    })]);
    return claudeCatalogModels(raw);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); release(); instance?.close(); }
}
