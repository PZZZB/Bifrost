import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { CurrentUserCredentialStore } from '../current-user-credential-store.mjs';
import { readPrivateAccountFile, writePrivateAccountRecord } from '../private-account-files.mjs';
import { createClientRegistry } from '../clients/index.mjs';

export function clientCatalogUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    || !['/v1', '/v1/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('client_sync_source_invalid');
  return url.origin + '/v1';
}
export function validateClientSync(value) {
  if (value?.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 8) throw new Error('client_sync_config_invalid');
  const ids = new Set(), targets = new Set(), clients = createClientRegistry();
  return { version: 1, profiles: value.profiles.map(profile => {
    if (!profile || Object.keys(profile).some(k => !['id','client','enabled','baseUrl','credentialRef','targetFile','intervalMs'].includes(k))
      || !/^[a-z][a-z0-9-]{0,31}$/.test(profile.id) || ids.has(profile.id) || typeof profile.enabled !== 'boolean'
      || typeof clients.profile(profile.client).fileModels !== 'function' || !/^[a-f0-9-]{36}$/.test(profile.credentialRef)
      || !isAbsolute(profile.targetFile ?? '') || !profile.targetFile.endsWith('models.json')
      || targets.has(resolve(profile.targetFile).toLowerCase()) || !Number.isSafeInteger(profile.intervalMs)
      || profile.intervalMs < 5000 || profile.intervalMs > 3600000) throw new Error('client_sync_config_invalid');
    ids.add(profile.id); targets.add(resolve(profile.targetFile).toLowerCase());
    return { ...profile, baseUrl: clientCatalogUrl(profile.baseUrl) };
  }) };
}
export async function loadClientSyncConfig(stateDir) {
  try { return validateClientSync(JSON.parse(await readPrivateAccountFile(join(stateDir, 'client-sync.json'), 32768))); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, profiles: [] }; throw error; }
}
export function clientSyncCredentialStore(stateDir, profile) {
  return new CurrentUserCredentialStore({ path: join(stateDir, 'client-sync-credentials', profile.credentialRef + '.dpapi.json'),
    namespace: `Bifrost.ClientSync.${profile.id}.${profile.credentialRef}.v1` });
}
export async function configureClientSync({ stateDir, id = 'codebuddy', client = 'codebuddy', baseUrl, targetFile,
  apiKey, intervalMs = 30000, credentialStore = clientSyncCredentialStore, write = writePrivateAccountRecord }) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{40,4096}$/.test(apiKey)) throw new Error('client_sync_key_invalid');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const existing = await loadClientSyncConfig(stateDir), profile = { id, client, baseUrl, targetFile, intervalMs, enabled: true, credentialRef: randomUUID() };
  const config = validateClientSync({ version: 1, profiles: [...existing.profiles.filter(p => p.id !== id), profile] });
  await credentialStore(stateDir, profile).save({ version: 1, apiKey, baseUrl: clientCatalogUrl(baseUrl) });
  await write(join(stateDir, 'client-sync.json'), config);
  return { id, client, enabled: true };
}
