import { join } from 'node:path';
import { readJson, writeJson, BridgeError, redact } from './storage.mjs';
import { EmployeeOAuthClient } from './employee-oauth.mjs';
import { CodeBuddyCredentialStore } from './codebuddy-credential-store.mjs';
import { NativeCodeBuddyCatalog } from './codebuddy-catalog.mjs';
import { CodeBuddyProvider, CODEBUDDY_MODEL } from './codebuddy-provider.mjs';
import { CodeBuddyThinkingState, loadThinkingStateKey } from './codebuddy-thinking-state.mjs';

function publicBilling(value) {
  const scalar = value => typeof value === 'string' ? value.slice(0, 160)
    : typeof value === 'number' && Number.isFinite(value) ? value : null;
  let promotion = scalar(value?.sourcePromotion);
  if (promotion === null && value?.sourcePromotion) {
    const list = Array.isArray(value.sourcePromotion) ? value.sourcePromotion : [value.sourcePromotion];
    promotion = list.slice(0, 3).map(item => {
      if (!item || typeof item !== 'object') return scalar(item);
      return [scalar(item.name), scalar(item.labelZh ?? item.label ?? item.badge?.label),
        item.discount?.discountedCredits != null ? `积分 ${scalar(item.discount.discountedCredits) ?? '未返回'}` : null]
        .filter(value => value !== null && value !== '').join(' · ');
    }).filter(Boolean).join('；').slice(0, 160) || null;
  }
  return { verified: value?.verified === true && typeof value.employeeTokenMultiplier === 'number',
    employeeTokenMultiplier: value?.verified === true ? scalar(value.employeeTokenMultiplier) : null,
    sourceCredits: scalar(value?.sourceCredits), sourcePromotion: promotion };
}

function publicCatalog(value) {
  if (!value || !['remote', 'native-cache'].includes(value.source)) return null;
  return { source: value.source, savedAt: Number.isSafeInteger(value.savedAt) ? value.savedAt : null,
    liveVerified: value.source === 'remote' && value.liveVerified === true };
}

/** Independent employee authorization and model metadata. Never runs inference. */
export async function startCodeBuddyService({ stateDir, getGatewayStatus = () => ({}),
  client: injectedClient, provider: injectedProvider, store: injectedStore,
  thinkingKeyStore: injectedThinkingKeyStore,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const configPath = join(stateDir, 'codebuddy.json');
  let config, setupError = null;
  try { config = await readJson(configPath, { enabled: false }); }
  catch { config = { enabled: false }; setupError = 'CodeBuddy 配置文件无法读取。'; }
  const store = injectedStore || new CodeBuddyCredentialStore({ path: join(stateDir, 'codebuddy-auth.dpapi.json') });
  const nativeCatalog = new NativeCodeBuddyCatalog();
  const client = injectedClient || new EmployeeOAuthClient({ loadAuth: () => store.load(), saveAuth: value => store.save(value),
    loadCatalog: options => nativeCatalog.load(options) });
  const thinkingKeyStore = injectedThinkingKeyStore || new CodeBuddyCredentialStore({ path: join(stateDir, 'codebuddy-thinking-key.dpapi.json') });
  // Local bridge state is encrypted with its own key. Loading is lazy, so a
  // damaged optional key cannot prevent Codex/With or management from starting.
  const provider = injectedProvider || new CodeBuddyProvider({ client,
    loadThinkingState: async () => {
      const key = await loadThinkingStateKey(thinkingKeyStore);
      try { return new CodeBuddyThinkingState({ key }); }
      finally { key.fill(0); }
    } });
  let login = null, timer = null, closed = false, generation = 0, polling = false, loginAbort = null;
  let publicLogin = { state: 'not_started' };

  function schedule(currentGeneration) {
    if (closed || currentGeneration !== generation) return;
    timer = setTimer(() => { timer = null; return poll(currentGeneration); }, 1000);
    timer?.unref?.();
  }

  async function poll(currentGeneration) {
    if (closed || currentGeneration !== generation || !login) return;
    if (polling) { schedule(currentGeneration); return; }
    if (Date.now() >= login.expiresAt) {
      publicLogin = { state: 'expired', error: '本轮登录等待已超时，请重新发起。' }; login = null; return;
    }
    polling = true;
    try {
      const result = await client.poll(login, { signal: loginAbort?.signal });
      if (closed || currentGeneration !== generation) return;
      if (result.pending) schedule(currentGeneration);
      else {
        publicLogin = { state: 'complete' }; login = null;
        // Catalog verification is read-only; it must not send a verification prompt.
        void provider.status().catch(() => {});
      }
    } catch (error) {
      if (closed || currentGeneration !== generation) return;
      if (['network_error', 'timeout'].includes(error.code)) schedule(currentGeneration);
      else { publicLogin = { state: 'error', error: 'CodeBuddy 员工授权未完成，请重新登录。' }; login = null; }
    } finally { polling = false; }
  }

  return {
    provider,
    model: CODEBUDDY_MODEL,
    get enabled() { return config.enabled === true; },
    async beginLogin() {
      if (closed) throw new BridgeError('CodeBuddy 服务已停止。', 503);
      generation++;
      if (timer) clearTimer(timer);
      loginAbort?.abort(); loginAbort = new AbortController();
      const started = await client.begin({ signal: loginAbort.signal });
      config.enabled = true;
      await writeJson(configPath, { version: 1, enabled: true });
      setupError = null;
      login = started;
      publicLogin = { state: 'pending', url: started.authUrl, expiresAt: started.expiresAt };
      schedule(generation);
      return { url: started.authUrl, expiresAt: started.expiresAt };
    },
    async logout() {
      generation++; if (timer) clearTimer(timer); timer = null; login = null;
      loginAbort?.abort(); loginAbort = null;
      publicLogin = { state: 'not_started' };
      await client.logout();
      return { ok: true };
    },
    async status() {
      let metadata = { authenticated: false, ready: false, modelAvailable: false };
      try { metadata = await provider.status(); }
      catch { metadata.error = 'CodeBuddy 状态暂不可用。'; }
      const gateway = getGatewayStatus() || {};
      const lastError = typeof gateway.lastError === 'string' ? gateway.lastError
        : typeof gateway.lastError?.message === 'string' ? gateway.lastError.message : null;
      return { configured: true, enabled: config.enabled === true, running: gateway.running === true,
        model: { id: CODEBUDDY_MODEL.id, name: CODEBUDDY_MODEL.name },
        provider: { authenticated: metadata.authenticated === true, ready: metadata.ready === true,
          modelAvailable: metadata.modelAvailable === true, username: metadata.username ?? metadata.identity?.username ?? null,
          transport: metadata.transport || 'CodeBuddy OAuth / Chat Completions',
          billing: publicBilling(metadata.billing),
          catalog: publicCatalog(metadata.catalog),
          error: setupError || metadata.error || null },
        gateway: { baseUrl: gateway.baseUrl || 'http://192.168.168.1:43157',
          codexBaseUrl: typeof gateway.codexBaseUrl === 'string' ? gateway.codexBaseUrl : null,
          requests: gateway.requests || 0, completed: gateway.completed || 0, failed: gateway.failed || 0, active: gateway.active || 0,
          lastError: lastError ? redact(lastError) : null },
        login: { ...publicLogin }, manualVerification: true };
    },
    async close() {
      closed = true; generation++; if (timer) clearTimer(timer); timer = null; login = null;
      loginAbort?.abort(); loginAbort = null;
      await client.close?.();
    },
  };
}
