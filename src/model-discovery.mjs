import { resolveCodeBuddyModel } from './models.mjs';
import { resolveCursorModel, CURSOR_MODELS, cursorModelAvailability } from './cursor-service.mjs';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const sources = new Set(['remote', 'native-cache', 'account-catalog']);

/** Account metadata only. This service never creates an agent or sends a prompt. */
export class ModelDiscovery {
  #pending = null;
  #closed = false;
  #active = new Set();
  #status = {};
  constructor({ modelPolicy, codeBuddyService = null, cursorService = null, timeoutMs = 5000, now = Date.now } = {}) {
    if (typeof modelPolicy?.observe !== 'function' || typeof modelPolicy?.snapshot !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof now !== 'function') throw new TypeError('Invalid model discovery settings.');
    Object.assign(this, { modelPolicy, codeBuddyService, cursorService, timeoutMs, now });
    for (const [channel, service] of [['CodeBuddy', codeBuddyService], ['Cursor', cursorService]]) {
      this.modelPolicy.setAuthorizationVersionGetter?.(channel, () => service?.authorizationVersion);
    }
  }
  snapshot() { return { ...this.modelPolicy.snapshot(), discovery: structuredClone(this.#status) }; }
  async #read(channel, service) {
    const message = `${channel} 账号目录暂不可用，请检查授权后刷新。`;
    if (!service || service.enabled === false || typeof service.getModels !== 'function') {
      return { channel, models: [], state: 'disabled', message: `${channel} 渠道尚未启用或授权。` };
    }
    const authorizationVersion = service.authorizationVersion;
    const abort = new AbortController(); this.#active.add(abort);
    let timer;
    try {
      const pending = Promise.resolve().then(() => service.getModels({ signal: abort.signal }));
      const list = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error()); }, this.timeoutMs);
      }), new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error()), { once: true }))]);
      if (!Array.isArray(list) || list.length > 512) throw new Error();
      const seen = new Set(), models = list.map(source => {
        const alias = channel === 'Cursor' ? resolveCursorModel(`Cursor-${source?.id}`) : resolveCodeBuddyModel(source?.id);
        if (!alias || seen.has(alias.id)) throw new Error();
        seen.add(alias.id);
        const fallback = channel === 'Cursor' ? CURSOR_MODELS.find(model => model.id === alias.id)?.name ?? `Cursor ${alias.upstream}` : alias.id;
        const name = channel === 'Cursor' && text(source.displayName) ? `Cursor ${source.displayName}`
          : text(source.name) ? source.name : fallback;
        const availability = channel === 'Cursor' ? cursorModelAvailability(source) : { available: source.available !== false, reason: source.reason };
        return { id: alias.id, name, available: availability.available,
          ...(!availability.available ? { reason: text(availability.reason) ? availability.reason : '此模型暂未适配当前客户端。' } : {}),
          source: sources.has(source.source) ? source.source : 'account-catalog' };
      });
      return { channel, models, state: 'ready', authorizationVersion };
    } catch { return { channel, models: [], state: 'error', message }; }
    finally { clearTimeout(timer); this.#active.delete(abort); }
  }
  refresh() {
    if (this.#closed || !this.modelPolicy.snapshot().available) return Promise.resolve(this.snapshot());
    return this.#pending ??= (async () => {
      const results = await Promise.all([this.#read('CodeBuddy', this.codeBuddyService), this.#read('Cursor', this.cursorService)]);
      if (this.#closed) return this.snapshot();
      for (const result of results) {
        const service = result.channel === 'Cursor' ? this.cursorService : this.codeBuddyService;
        const stale = () => result.state === 'ready' && (service?.enabled === false
          || result.authorizationVersion !== service?.authorizationVersion);
        if (stale()) Object.assign(result, { models: [], state: 'error', message: `${result.channel} 授权已变化，请重新刷新账号目录。` });
        await this.modelPolicy.observe({ models: result.models }, result.channel, { defaultEnabled: false, complete: true,
          unavailableReason: result.message ?? '当前账号目录未返回此模型，请刷新目录后重试。',
          authorizationVersion: result.authorizationVersion ?? service?.authorizationVersion });
        if (stale()) {
          Object.assign(result, { models: [], state: 'error', message: `${result.channel} 授权已变化，请重新刷新账号目录。` });
          await this.modelPolicy.observe({ models: [] }, result.channel, { defaultEnabled: false, complete: true,
            unavailableReason: result.message, authorizationVersion: service?.authorizationVersion });
        }
        this.#status[result.channel] = { state: result.state, count: result.models.length,
          checkedAt: new Date(this.now()).toISOString(), ...(result.message ? { message: result.message } : {}) };
      }
      // The first channel may change while the second policy write is in
      // progress. Version-bound policy rows already fail closed; finalize
      // the displayed source counts in the same synchronous snapshot.
      for (const result of results) {
        const service = result.channel === 'Cursor' ? this.cursorService : this.codeBuddyService;
        if (result.state === 'ready' && (service?.enabled === false || result.authorizationVersion !== service?.authorizationVersion)) {
          this.#status[result.channel] = { state: 'error', count: 0, checkedAt: new Date(this.now()).toISOString(),
            message: `${result.channel} 授权已变化，请重新刷新账号目录。` };
        }
      }
      return this.snapshot();
    })().finally(() => { this.#pending = null; });
  }
  async close() {
    this.#closed = true;
    for (const abort of this.#active) abort.abort();
    await this.#pending?.catch(() => {});
  }
}
