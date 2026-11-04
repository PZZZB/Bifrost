import { createHash } from 'node:crypto';
import { BridgeError } from '../storage.mjs';
import { modelId, PROTOCOL_PATHS } from '../routing/model-router.mjs';
import { MessagesResponsesAdapter } from '../protocols/messages-responses-adapter.mjs';
import { modelCapabilities } from '../routing/model-capabilities.mjs';
import { normalizeRemoteAccount, remoteQuotaCard } from '../bifrost-quotas.mjs';

const fail = (status = 503, code = 'desktop_remote_unavailable') => new BridgeError('远端 Bifrost 暂不可用，请检查网络、用户 Key 或模型权限。', status, code);
export function validateBifrostUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Remote Bifrost requires a fixed HTTPS /v1 URL.'); }
  if (url.protocol !== 'https:' || !['/v1', '/v1/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new TypeError('Remote Bifrost requires a fixed HTTPS /v1 URL.');
  }
  return `${url.origin}/v1`;
}
async function boundedJson(response, maximum = 256 * 1024) {
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) { await response.body?.cancel(); throw fail(502); }
  const chunks = []; let size = 0;
  for await (const bytes of response.body) {
    size += bytes.byteLength;
    if (size > maximum) throw fail(502);
    chunks.push(bytes);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw fail(502); }
}

/** Personal user Key, fixed user API paths, verified TLS, no redirects or retries. */
export class BifrostRemote {
  #url; #key; #fetch; #models = []; #pending = null; #abort = new AbortController(); #state = 'not_refreshed';
  #responses;
  constructor({ id = 'bifrost', baseUrl, apiKey, protocols = ['chat-completions', 'messages'], fetchImpl = fetch, stateSecret } = {}) {
    this.id = id; this.kind = 'bifrost-remote'; this.#url = validateBifrostUrl(baseUrl);
    if (typeof apiKey !== 'string' || !/^bfk_[A-Za-z0-9_-]{43}$/.test(apiKey) || !Array.isArray(protocols) || !protocols.length
      || protocols.some(value => !Object.hasOwn(PROTOCOL_PATHS, value))) throw new TypeError('A personal Bifrost user Key and explicit protocols are required.');
    this.#key = apiKey; this.#fetch = fetchImpl; this.protocols = [...new Set(protocols)];
    this.generation = createHash('sha256').update(JSON.stringify([this.#url, apiKey])).digest('hex');
    if (stateSecret) this.#responses = new MessagesResponsesAdapter({ stateSecret, requestMessages: request => this.#requestNative('messages', request) });
  }
  catalogSnapshot() {
    return structuredClone(this.#models).map(model => ({ ...model,
      protocols: [...new Set([...model.protocols, ...(this.#responses && model.protocols.includes('messages') ? ['responses'] : [])])] }));
  }
  status() { return { state: this.#state, available: this.#state === 'ready', modelCount: this.#models.length, billingAuthority: 'remote-bifrost' }; }
  async accountQuota({ signal } = {}) {
    const stamp = () => new Date().toISOString();
    if (this.#abort.signal.aborted) return remoteQuotaCard(this.id, { code: 'disabled', fetchedAt: stamp() });
    let received = false;
    try {
      const response = await this.#fetch(`${this.#url}/account`, { method: 'GET', redirect: 'manual',
        headers: { authorization: `Bearer ${this.#key}` },
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(6000), ...(signal ? [signal] : [])]) });
      if (!response.ok) {
        await response.body?.cancel();
        return remoteQuotaCard(this.id, { fetchedAt: stamp(), code: [404, 405, 501].includes(response.status) ? 'unsupported'
          : [401, 403].includes(response.status) ? 'unauthorized' : 'unavailable' });
      }
      received = true;
      const value = await boundedJson(response, 32 * 1024);
      if (signal?.aborted || this.#abort.signal.aborted) return remoteQuotaCard(this.id, { fetchedAt: stamp(), code: 'unavailable' });
      return normalizeRemoteAccount(value, { id: this.id, fetchedAt: stamp() });
    } catch { return remoteQuotaCard(this.id, { fetchedAt: stamp(), code: received ? 'invalid_response' : 'unavailable' }); }
  }
  refreshCatalog(signal) {
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      try {
        const response = await this.#fetch(`${this.#url}/models`, { redirect: 'manual',
          headers: { authorization: `Bearer ${this.#key}` },
          signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
        if (!response.ok) { await response.body?.cancel(); throw fail(response.status); }
        const data = await boundedJson(response);
        if (!Array.isArray(data?.data) || data.data.length > 512) throw fail(502);
        const seen = new Set();
        const models = data.data.map(model => {
          if (!modelId(model?.id) || seen.has(model.id)) throw fail(502);
          seen.add(model.id);
          // An advertised capability may narrow the owner's configuration, never expand it.
          const protocols = Array.isArray(model.protocols) ? this.protocols.filter(value => model.protocols.includes(value)) : this.protocols;
          return { id: model.id, name: typeof model.name === 'string' && model.name.length < 200 ? model.name : model.id,
            available: model.available !== false, protocols, capabilities: modelCapabilities(model.capabilities) };
        }).filter(model => model.protocols.length);
        this.#models = models; this.#state = 'ready';
      } catch {
        this.#models = []; this.#state = this.#abort.signal.aborted ? 'closed' : 'unavailable';
      } finally { this.#pending = null; }
    })();
    return this.#pending;
  }
  async request(protocol, { body, scope, session, signal } = {}) {
    const native = this.#models.find(model => model.id === body?.model && model.available);
    if (protocol === 'responses' && !native?.protocols.includes('responses') && native?.protocols.includes('messages') && this.#responses) {
      return this.#responses.request({ body, scope, session, signal, capabilities: native.capabilities });
    }
    return this.#requestNative(protocol, { body, scope, session, signal });
  }
  async openCompactionForHandoff(token, { scope, model, signal } = {}) {
    if (signal?.aborted || this.#abort.signal.aborted) throw fail(signal?.aborted ? 499 : 503);
    if (!this.#models.some(entry => entry.id === model && entry.available && entry.protocols.includes('messages'))
        || typeof this.#responses?.openCompactionForHandoff !== 'function') {
      throw new BridgeError('当前远端来源不能恢复此模型的历史摘要，请先使用原模型继续。', 409, 'remote_compaction_unavailable');
    }
    return this.#responses.openCompactionForHandoff(token, { scope, model, signal });
  }
  async #requestNative(protocol, { body, scope, session, signal } = {}) {
    if (this.#abort.signal.aborted || !this.#models.some(model => model.id === body.model && model.available && model.protocols.includes(protocol))) throw fail();
    let response;
    try {
      response = await this.#fetch(new URL(PROTOCOL_PATHS[protocol], this.#url).href, { method: 'POST', redirect: 'manual',
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-session-id': session || scope },
        body: JSON.stringify(body), signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]) });
    } catch { throw fail(signal?.aborted ? 499 : 503); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail(502, 'desktop_remote_redirect'); }
    // The server already authenticates, reserves and settles this one request.
    // Preserve its status/usage stream; no local ledger or inference retry.
    return response;
  }
  async close() { this.#abort.abort(); this.#models = []; this.#key = ''; this.#state = 'closed'; await this.#pending; }
}
