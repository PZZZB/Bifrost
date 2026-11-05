import { createHmac } from 'node:crypto';
import { readPrivateAccountFile } from './private-account-files.mjs';
import { BridgeError } from './storage.mjs';
import { validatedClaudeUsage, unavailableClaudeUsage } from './claude-subscription-usage.mjs';

/** Optional fixed upstream for the main account/billing service. No login here. */
export async function loadMacClaudeClient(path, { fetchImpl = fetch, onCatalog = async () => {} } = {}) {
  if (!path) return null;
  const config = JSON.parse(await readPrivateAccountFile(path, 8192));
  if (config.version !== 1 || config.upstreamPort !== 43157 || !config.webAccountsFile) throw new Error('Invalid Mac Claude configuration.');
  const key = (await readPrivateAccountFile(config.gatewayKeyFile, 8192)).trim();
  const sessionKey = (await readPrivateAccountFile(config.sessionKeyFile, 8192)).trim();
  if (![key, sessionKey].every(value => /^[\x21-\x7e]{40,4096}$/.test(value)) || key === sessionKey) throw new Error('Invalid private gateway keys.');
  const web = JSON.parse(await readPrivateAccountFile(config.webAccountsFile, 8192));
  if (web.version !== 1 || !Number.isInteger(web.maxAccounts) || web.maxAccounts < 1 || web.maxAccounts > 90
    || !Number.isInteger(web.maxConcurrent) || web.maxConcurrent < 1 || web.maxConcurrent > 8
    || !Number.isInteger(web.requestsPerMinute) || web.requestsPerMinute < 1 || web.requestsPerMinute > 600) throw new Error('Invalid website limits.');
  const csrfKey = (await readPrivateAccountFile(`${web.directory}/csrf.key`, 128)).trim();
  const root = 'http://127.0.0.1:43157';
  let models = [], timer, refreshPending = null, lastAvailable = false;
  let subscriptionUsage = unavailableClaudeUsage(), authorizationVersion = null;
  async function refresh() {
    if (refreshPending) return refreshPending;
    refreshPending = (async () => {
      try {
        const response = await fetchImpl(`${root}/v1/models`, { headers: { authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const bytes = await response.text();
        if (!response.ok || bytes.length > 131072) throw new Error();
        const data = JSON.parse(bytes);
        if (!Array.isArray(data.data) || data.data.length > 100) throw new Error();
        const entries = data.data.filter(model => /^claude-[a-z0-9][a-z0-9._-]{0,120}$/.test(model?.id));
        const discovered = entries.map(model => ({ id: `Claude-${model.id.slice(7)}`, upstream: model.id,
          name: typeof model.display_name === 'string' && model.display_name.length < 200 ? model.display_name : 'Claude',
          ...(typeof model.supportsReasoning === 'boolean' ? { supportsReasoning: model.supportsReasoning } : {}),
          ...(Array.isArray(model.efforts) ? { efforts: model.efforts.filter(e => ['low','medium','high','xhigh','max'].includes(e)) } : {}),
          ...(model.contextSource === 'official-cli-runtime' && Number.isSafeInteger(model.contextWindow)
            && model.contextWindow > 0 && model.contextWindow <= 1_000_000_000
            ? { contextWindow: model.contextWindow, contextSource: 'official-cli-runtime' } : {}),
          channel: 'Claude', enabled: true, available: true, protocols: ['chat-completions', 'messages'] }));
        if (new Set(discovered.map(m => m.id)).size !== discovered.length) throw new Error();
        try {
          const health = await fetchImpl(`${root}/health`, { headers: { authorization: `Bearer ${key}` }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
          const content = await health.text();
          if (!health.ok || content.length > 131072) throw new Error();
          const metadata = JSON.parse(content).providers?.Claude;
          subscriptionUsage = validatedClaudeUsage(metadata?.subscriptionUsage);
          authorizationVersion = typeof metadata?.authorizationVersion === 'string' && /^[a-f0-9]{64}$/.test(metadata.authorizationVersion) ? metadata.authorizationVersion : null;
        } catch { subscriptionUsage = unavailableClaudeUsage('fetch_failed'); authorizationVersion = null; }
        await onCatalog(discovered.map(({ upstream, ...model }) => model), authorizationVersion);
        models = discovered;
        lastAvailable = discovered.length > 0;
      } catch { models = []; lastAvailable = false; subscriptionUsage = unavailableClaudeUsage('fetch_failed'); authorizationVersion = null; await onCatalog([], null).catch(() => {}); }
      finally { refreshPending = null; }
    })();
    return refreshPending;
  }
  await refresh();
  timer = setInterval(() => { void refresh(); }, 15_000); timer.unref();
  async function request(protocol, { body, scope, session = '', signal }) {
    const model = models.find(model => model.id === body.model);
    if (!model) throw new BridgeError('模型服务尚未就绪，请稍后重试。', 503, 'client_upstream_unavailable');
    const path = protocol === 'chat' ? '/v1/chat/completions' : '/v1/messages';
    const payload = { ...body, model: model.upstream };
    // Billing must receive the authoritative terminal usage, even if a Chat
    // client omitted this optional streaming flag. No model content is logged.
    if (protocol === 'chat' && body.stream === true) payload.stream_options = { ...body.stream_options, include_usage: true };
    const namespace = 'client-' + createHmac('sha256', sessionKey).update(JSON.stringify([scope, session])).digest('hex');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-session-id': namespace };
    let response;
    try { response = await fetchImpl(root + path, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(600_000)]) }); }
    catch { throw new BridgeError('模型服务暂时不可用，请稍后重试。', 503, 'client_upstream_unavailable'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new BridgeError('模型服务返回异常。', 502, 'client_upstream_unavailable'); }
    // Preserve the response body for the meter: an upstream error can still
    // carry actual billable usage. Diagnostics never receive the request body.
    return response;
  }
  return { web, csrfKey, models: () => models.map(({ upstream, ...model }) => ({ ...model })), refresh,
    get authorizationVersion() { return authorizationVersion; },
    status: () => ({ available: lastAvailable, modelCount: models.length, subscriptionUsage: structuredClone(subscriptionUsage) }),
    requestChat: request.bind(null, 'chat'), requestMessages: request.bind(null, 'messages'),
    async close() { clearInterval(timer); await refreshPending; } };
}
