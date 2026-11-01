import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { readPrivateAccountFile } from '../private-account-files.mjs';
import { writeJson } from '../storage.mjs';
import { CurrentUserCredentialStore } from '../current-user-credential-store.mjs';
import { validateBifrostUrl } from '../providers/bifrost-remote.mjs';
import { PROTOCOL_PATHS } from '../routing/model-router.mjs';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

export function validateServerRemotes(value) {
  if (!fields(value, ['version', 'sources']) || value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 8) {
    throw new TypeError('Invalid Server remote sources configuration.');
  }
  const seen = new Set();
  const sources = value.sources.map(source => {
    if (!fields(source, ['id', 'kind', 'baseUrl', 'protocols', 'credentialRef'])
      || typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(source.id) || seen.has(source.id) || source.kind !== 'bifrost-remote'
      || typeof source.credentialRef !== 'string' || !uuid.test(source.credentialRef) || typeof source.baseUrl !== 'string'
      || !Array.isArray(source.protocols) || !source.protocols.length
      || source.protocols.some(protocol => !Object.hasOwn(PROTOCOL_PATHS, protocol))) throw new TypeError('Invalid Server remote source.');
    seen.add(source.id);
    return { ...source, baseUrl: validateBifrostUrl(source.baseUrl), protocols: [...new Set(source.protocols)] };
  });
  return { version: 1, sources };
}

export async function loadServerRemotesConfig(stateDir) {
  let text;
  try { text = await readPrivateAccountFile(join(stateDir, 'remote-sources.json'), 65_536); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, sources: [] }; throw error; }
  return validateServerRemotes(JSON.parse(text));
}

export function serverRemoteCredentialStore(stateDir, source) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(source.id) || !uuid.test(source.credentialRef)) throw new TypeError('Invalid remote credential reference.');
  return new CurrentUserCredentialStore({ path: join(stateDir, 'remote-credentials', `${source.credentialRef}.dpapi.json`),
    namespace: `Bifrost.ServerRemote.${source.id}.${source.credentialRef}.v1` });
}

/** Publish an immutable protected credential before atomically selecting it.
 * A failed config write cannot replace an existing source's credential. */
export async function configureServerRemote({ stateDir, id = 'bifrost', baseUrl, apiKey,
  storeFactory = serverRemoteCredentialStore, writeConfig = writeJson } = {}) {
  if (typeof apiKey !== 'string' || !/^bfk_[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new TypeError('A personal Bifrost user Key is required.');
  const lock = join(stateDir, 'remote-sources.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const previous = await loadServerRemotesConfig(stateDir);
    const source = { id, kind: 'bifrost-remote', baseUrl, protocols: ['chat-completions', 'messages'], credentialRef: randomUUID() };
    const next = validateServerRemotes({ version: 1, sources: [...previous.sources.filter(item => item.id !== id), source] });
    const store = storeFactory(stateDir, source);
    await store.save({ version: 1, apiKey });
    try { await writeConfig(join(stateDir, 'remote-sources.json'), next); }
    catch (error) { await store.clear().catch(() => {}); throw error; }
    return { sourceId: id, sourceCount: next.sources.length };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
