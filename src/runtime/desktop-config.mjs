import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readJson, writeJson } from '../storage.mjs';
import { CurrentUserCredentialStore } from '../current-user-credential-store.mjs';
import { validateBifrostUrl } from '../providers/bifrost-remote.mjs';
import { PROTOCOL_PATHS } from '../routing/model-router.mjs';

export const desktopStateDir = () => resolve(process.env.BIFROST_DESKTOP_STATE_DIR || join(homedir(), '.bifrost-desktop'));
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
export function validateDesktopConfig(value) {
  if (!fields(value, ['version', 'port', 'sources']) || value.version !== 1 || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 8) throw new TypeError('Invalid Desktop configuration.');
  const ids = new Set();
  for (const source of value.sources) {
    if (!fields(source, ['id', 'kind', 'baseUrl', 'protocols']) || !/^[a-z][a-z0-9-]{0,31}$/.test(source.id)
      || !['codebuddy-local', 'bifrost-remote'].includes(source.kind) || ids.has(source.id)) throw new TypeError('Invalid or duplicate Desktop source.');
    ids.add(source.id);
    if (source.kind === 'codebuddy-local') {
      if (source.baseUrl !== undefined || source.protocols !== undefined) throw new TypeError('CodeBuddy transport belongs to its local provider.');
    } else {
      validateBifrostUrl(source.baseUrl);
      if (!Array.isArray(source.protocols) || !source.protocols.length || source.protocols.some(value => !Object.hasOwn(PROTOCOL_PATHS, value))) throw new TypeError('Explicit remote protocols are required.');
    }
  }
  return structuredClone(value);
}
export async function loadDesktopConfig(stateDir) {
  const config = await readJson(join(stateDir, 'desktop.json'));
  if (!config) throw new Error('请先运行 npm run desktop -- init。');
  return validateDesktopConfig(config);
}
export function desktopCredentialStore(stateDir, id = 'identity') {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new TypeError('Invalid credential source.');
  return new CurrentUserCredentialStore({ path: join(stateDir, `${id}.dpapi.json`), namespace: `Bifrost.Desktop.${id}.v1` });
}
export async function loadDesktopIdentity(stateDir, store = desktopCredentialStore(stateDir)) {
  const identity = await store.load();
  if (!identity || identity.version !== 1 || !/^bdk_[A-Za-z0-9_-]{43}$/.test(identity.apiKey) || !/^[A-Za-z0-9_-]{43}$/.test(identity.secret)) {
    throw new Error('本地受保护凭据缺失或损坏，请检查当前 Windows 用户及 Desktop 初始化。');
  }
  return identity;
}
export async function initializeDesktop(stateDir, { port = 43160, store = desktopCredentialStore(stateDir) } = {}) {
  if (await readJson(join(stateDir, 'desktop.json')) || await store.load()) throw new Error('Desktop 已初始化，拒绝覆盖既有配置或密钥。');
  const config = validateDesktopConfig({ version: 1, port, sources: [{ id: 'codebuddy', kind: 'codebuddy-local' }] });
  const identity = { version: 1, apiKey: `bdk_${randomBytes(32).toString('base64url')}`, secret: randomBytes(32).toString('base64url') };
  await store.save(identity);
  await writeJson(join(stateDir, 'desktop.json'), config);
  return { config, identity };
}
