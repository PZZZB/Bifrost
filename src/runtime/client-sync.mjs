import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createClientRegistry } from '../clients/index.mjs';
import { modelCapabilities } from '../routing/model-capabilities.mjs';
import { reconcileClientFile } from '../client-config-file.mjs';
import { writePrivateAccountRecord } from '../private-account-files.mjs';
import { loadClientSyncConfig, clientSyncCredentialStore } from './client-sync-config.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
async function readCatalog(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error('catalog_unavailable'); }
  const parts = []; let size = 0;
  for await (const part of response.body ?? []) { size += part.byteLength; if (size > 1024 * 1024) throw new Error('catalog_invalid'); parts.push(part); }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!Array.isArray(value.data) || value.data.length > 512 || value.data.some(model => !validId(model?.id))
    || new Set(value.data.map(model => model.id)).size !== value.data.length) throw new Error('catalog_invalid');
  return value.data.map(model => ({ id: model.id, name: name(model.name) ? model.name : name(model.display_name) ? model.display_name : model.id,
    protocols: Array.isArray(model.protocols) ? model.protocols.filter(p => ['responses','messages','chat-completions'].includes(p)) : ['chat-completions'],
    capabilities: modelCapabilities(model.capabilities ?? {}) }));
}

/** Metadata-only companion. Config changes are picked up without restarting the gateway. */
export async function startClientCatalogSync({ stateDir, fetchImpl = fetch, now = Date.now,
  credentialStore = clientSyncCredentialStore, reconcile = reconcileClientFile, pollMs = 5000 } = {}) {
  const clients = createClientRegistry(), state = new Map(), secrets = new Map();
  let pending, timer, closed = false, published = false;
  const abort = new AbortController();
  async function refresh({ force = false } = {}) {
    if (closed) return;
    return pending ??= (async () => {
      let config;
      try { config = await loadClientSyncConfig(stateDir); } catch {
        for (const [id, previous] of state) state.set(id, { ...previous, state: 'unavailable', message: '同步设置无效，已暂停，保留上次配置。' });
        return;
      }
      const active = new Set(config.profiles.filter(p => p.enabled).map(p => p.id));
      for (const id of state.keys()) if (!active.has(id)) { state.delete(id); secrets.delete(id); }
      for (const profile of config.profiles.filter(p => p.enabled)) {
        const previous = state.get(profile.id), revision = JSON.stringify(profile);
        if (!force && previous?.revision === revision && now() - previous.attemptedAt < profile.intervalMs) continue;
        const attemptedAt = now();
        try {
          if (secrets.get(profile.id)?.ref !== profile.credentialRef || secrets.get(profile.id)?.baseUrl !== profile.baseUrl) {
            const record = await credentialStore(stateDir, profile).load();
            if (record?.version !== 1 || record.baseUrl !== profile.baseUrl || typeof record.apiKey !== 'string' || !/^[\x21-\x7e]{40,4096}$/.test(record.apiKey)) throw new Error('credential_unavailable');
            secrets.set(profile.id, { ref: profile.credentialRef, apiKey: record.apiKey, baseUrl: profile.baseUrl });
          }
          const apiKey = secrets.get(profile.id).apiKey;
          const response = await fetchImpl(profile.baseUrl + '/models', { redirect: 'manual', headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
          const models = await readCatalog(response);
          if (closed) return;
          const result = await reconcile({ targetFile: profile.targetFile, stateFile: join(stateDir, 'client-sync-state', profile.id + '.json'),
            models: clients.profile(profile.client).fileModels(models, { baseUrl: profile.baseUrl, apiKey }) });
          state.set(profile.id, { revision, attemptedAt, id: profile.id, client: profile.client, state: result.conflictCount ? 'conflict' : 'ready',
            checkedAt: new Date(now()).toISOString(), ...result });
        } catch {
          state.set(profile.id, { revision, attemptedAt, id: profile.id, client: profile.client, state: 'unavailable',
            checkedAt: new Date(now()).toISOString(), message: '目录、凭据或配置文件暂不可同步，保留上次配置。' });
        }
      }
      if (state.size || published) {
        published = true;
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writePrivateAccountRecord(join(stateDir, 'client-sync-status.json'), { version: 1,
          profiles: [...state.values()].map(({ revision, attemptedAt, ...status }) => status) }).catch(() => {});
      }
    })().finally(() => { pending = null; });
  }
  timer = setInterval(() => { void refresh().catch(() => {}); }, pollMs); timer.unref();
  void refresh().catch(() => {});
  return { refresh, status: () => [...state.values()].map(({ revision, attemptedAt, ...status }) => ({ ...status })),
    async close() { closed = true; clearInterval(timer); abort.abort(); await pending?.catch(() => {}); secrets.clear(); } };
}
