import { BridgeError } from '../storage.mjs';

/** Client-specific catalog/config views. Providers and model routing never depend on client names. */
export class ClientRegistry {
  #profiles = new Map();
  constructor(profiles = []) {
    for (const profile of profiles) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(profile?.id) || this.#profiles.has(profile.id) || typeof profile.catalog !== 'function'
        || !Array.isArray(profile.protocols) || !profile.query || typeof profile.query !== 'object') throw new TypeError('Invalid client profile.');
      this.#profiles.set(profile.id, profile);
    }
  }
  list() { return [...this.#profiles.values()].map(profile => ({ id: profile.id, name: profile.name,
    protocols: [...profile.protocols], catalogPath: `/clients/${profile.id}/models` })); }
  profile(id) {
    const profile = this.#profiles.get(id);
    if (!profile) throw new BridgeError('客户端适配尚未提供。', 404, 'desktop_client_not_found');
    return profile;
  }
  catalog(id, models, query = new URLSearchParams()) {
    const profile = this.#profiles.get(id);
    if (!profile) throw new BridgeError('客户端目录适配尚未提供。', 404, 'desktop_client_not_found');
    const seen = new Set();
    for (const [name, value] of query) {
      if (seen.has(name) || !Object.hasOwn(profile.query, name) || !profile.query[name].test(value)) throw new BridgeError('客户端目录参数无效。', 400, 'desktop_catalog_query');
      seen.add(name);
    }
    return profile.catalog(models.filter(model => profile.protocols.some(protocol => model.protocols.includes(protocol))));
  }
}
