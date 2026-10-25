import { CodeBuddyResponsesProvider } from '../codebuddy-responses.mjs';
import { ClientChatAdapter } from '../client-chat.mjs';
import { BridgeError } from '../storage.mjs';

/** Thin adapter over the existing employee OAuth and protocol implementations. */
export class CodeBuddyLocal {
  #service; #responses; #chat; #models = []; #version = null; #pending = null;
  #abort = new AbortController(); #state = 'not_refreshed';
  constructor({ id = 'codebuddy', service } = {}) {
    this.id = id; this.kind = 'codebuddy-local'; this.#service = service;
    this.#responses = new CodeBuddyResponsesProvider({ provider: service.provider });
    this.#chat = new ClientChatAdapter({ requestResponses: request => this.#responses.request({
      path: '/v1/responses', body: Buffer.from(JSON.stringify(request.body)), clientScope: request.scope, signal: request.signal }) });
  }
  get generation() { return this.#service.authorizationVersion; }
  catalogSnapshot() { return this.#version === this.generation ? structuredClone(this.#models) : []; }
  status() { return { state: this.#state, available: this.catalogSnapshot().length > 0,
    modelCount: this.catalogSnapshot().length, billingAuthority: 'company' }; }
  refreshCatalog(signal) {
    if (this.#pending) return this.#pending;
    const generation = this.generation;
    this.#pending = (async () => {
      try {
        if (this.#abort.signal.aborted) return;
        const models = await this.#service.getModels({ signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
        if (generation !== this.generation || this.#abort.signal.aborted) return;
        this.#models = models.filter(model => model.available).map(model => ({ id: model.id, name: model.name,
          available: true, protocols: ['chat-completions', 'responses', 'messages'] }));
        this.#version = generation; this.#state = 'ready';
      } catch { this.#models = []; this.#version = generation; this.#state = 'unavailable'; }
      finally { this.#pending = null; }
    })();
    return this.#pending;
  }
  async request(protocol, { body, scope, signal } = {}) {
    if (!this.catalogSnapshot().some(model => model.id === body.model)) throw new BridgeError('本地 CodeBuddy 尚未就绪，请先完成员工授权。', 503, 'desktop_local_unavailable');
    const linked = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
    if (protocol === 'chat-completions') return this.#chat.request({ body, scope, signal: linked });
    if (protocol === 'responses') return this.#responses.request({ path: '/v1/responses', body: Buffer.from(JSON.stringify(body)), clientScope: scope, signal: linked });
    if (protocol === 'messages') return this.#service.provider.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify(body)), clientScope: scope, signal: linked });
    throw new BridgeError('本地来源未提供此协议。', 501, 'desktop_protocol_unsupported');
  }
  async beginLogin() { const result = await this.#service.beginLogin(); this.#models = []; this.#state = 'login_pending'; return result; }
  async logout() { this.#models = []; this.#state = 'not_authenticated'; return this.#service.logout(); }
  async close() { this.#abort.abort(); this.#chat.close(); this.#models = []; this.#state = 'closed'; await this.#service.close(); await this.#pending; }
}
