import { createHmac } from 'node:crypto';
import { BridgeError } from '../storage.mjs';
import { modelCapabilities } from './model-capabilities.mjs';

export const PROTOCOL_PATHS = Object.freeze({ 'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses', messages: '/v1/messages' });
export const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,279}$/.test(value) && !value.includes('..');
const fail = (message, status, code) => new BridgeError(message, status, code);

/** Registered destinations only. Catalog reads never wait for another source. */
export class ModelRouter {
  #sources = new Map();
  #sessions = new Map();
  #secret;
  #now;
  constructor({ providers, secret, now = Date.now } = {}) {
    if (!Array.isArray(providers) || !providers.length || providers.length > 8 || typeof secret !== 'string' || secret.length < 40) {
      throw new TypeError('Invalid model router configuration.');
    }
    this.#secret = secret; this.#now = now;
    for (const provider of providers) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider?.id) || !['codebuddy-local', 'bifrost-remote'].includes(provider.kind)
        || this.#sources.has(provider.id) || ['catalogSnapshot', 'refreshCatalog', 'request', 'status', 'close'].some(name => typeof provider[name] !== 'function')) {
        throw new TypeError('Invalid or duplicate provider.');
      }
      this.#sources.set(provider.id, provider);
    }
  }
  #routes() {
    const routes = new Map();
    for (const provider of this.#sources.values()) {
      const snapshot = provider.catalogSnapshot();
      if (!Array.isArray(snapshot) || snapshot.length > 512) throw new TypeError('Invalid provider catalog.');
      for (const model of snapshot) {
        if (!modelId(model?.id) || !Array.isArray(model.protocols) || !model.protocols.length
          || model.protocols.some(protocol => !Object.hasOwn(PROTOCOL_PATHS, protocol))) throw new TypeError('Invalid provider model.');
        if (model.available === false || model.enabled === false) continue;
        const local = provider.kind === 'codebuddy-local';
        const id = `${local ? 'local' : 'remote'}/${provider.id}/${model.id}`;
        if (routes.has(id)) throw new TypeError('Duplicate model alias.');
        routes.set(id, { id, upstreamModel: model.id, provider, generation: String(provider.generation),
          public: { id, object: 'model', owned_by: 'bifrost', name: `${local ? '本地 · CodeBuddy' : '远端 · Bifrost'} · ${model.name || model.id}`,
            source: { id: provider.id, kind: provider.kind, location: local ? 'local' : 'remote' },
            protocols: [...new Set(model.protocols)], capabilities: modelCapabilities(model.capabilities), billing_authority: local ? 'company' : 'remote-bifrost' } });
      }
    }
    return routes;
  }
  models() { return [...this.#routes().values()].map(route => structuredClone(route.public)); }
  status() { return [...this.#sources.values()].map(provider => ({ id: provider.id, kind: provider.kind, ...provider.status() })); }
  provider(id) {
    const provider = this.#sources.get(id);
    if (!provider) throw fail('模型来源不存在。', 404, 'desktop_source_not_found');
    return provider;
  }
  async refresh(id, signal) {
    if (id !== undefined) return this.provider(id).refreshCatalog(signal);
    return Promise.allSettled([...this.#sources.values()].map(provider => provider.refreshCatalog(signal)));
  }
  #binding(route, owner, session) {
    const bytes = createHmac('sha256', this.#secret)
      .update(JSON.stringify([owner, session, route.id, route.upstreamModel, route.generation])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const value = bytes.toString('hex');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
  resolve(protocol, { body, owner = 'desktop-owner', session = '', trackSession = true } = {}) {
    const route = this.#routes().get(body?.model);
    if (!route) throw fail('所选模型未就绪或未登记，请检查来源状态。', 503, 'desktop_model_unavailable');
    if (!route.public.protocols.includes(protocol)) throw fail('所选模型尚未支持此协议，请选择该模型支持的接口。', 501, 'desktop_protocol_unsupported');
    if (typeof trackSession !== 'boolean' || typeof owner !== 'string' || !owner || owner.length > 128 || typeof session !== 'string' || session.length > 1024 || /[\x00-\x1f\x7f]/.test(session)) {
      throw fail('会话标识无效。', 400, 'desktop_session_invalid');
    }
    const scope = this.#binding(route, owner, session);
    if (session && trackSession) {
      const at = this.#now();
      for (const [key, row] of this.#sessions) if (row.expires <= at) this.#sessions.delete(key);
      const key = createHmac('sha256', this.#secret).update(JSON.stringify([owner, session])).digest('hex');
      const previous = this.#sessions.get(key);
      if (previous && previous.scope !== scope) throw fail('当前会话已绑定另一模型来源或授权，请新建聊天后切换。', 409, 'desktop_session_source_changed');
      if (!previous && this.#sessions.size >= 1024) throw fail('会话数量已达上限，请稍后重试。', 429, 'desktop_session_limit');
      this.#sessions.set(key, { scope, expires: at + 6 * 60 * 60 * 1000 });
    }
    return { ...route, scope, protocol };
  }
  async request(context, { body, signal } = {}) {
    if (String(context.provider.generation) !== context.generation) throw fail('来源授权已变化，请刷新模型并新建聊天。', 409, 'desktop_source_changed');
    if (signal?.aborted) throw fail('请求已取消。', 499, 'desktop_cancelled');
    // The only dispatch. Failures are never replayed against another provider.
    return context.provider.request(context.protocol, { body: { ...body, model: context.upstreamModel },
      scope: context.scope, session: context.scope, signal });
  }
  async close() { this.#sessions.clear(); await Promise.allSettled([...this.#sources.values()].map(provider => provider.close())); }
}
