import { BridgeError } from '../storage.mjs';

/** Reuses Codex's native configuration editor; model catalogs remain served by the gateway. */
export function createCodexClientControl({ integration }) {
  return { id: 'codex', name: 'Codex', protocol: 'responses',
    async inspect() {
      const state = await integration.inspect();
      return { mode: state.routing?.mode === 'official' ? 'native' : state.routing?.mode === 'gateway' ? 'gateway' : 'unknown',
        configured: state.installed === true, reason: state.routing?.reason ?? null,
        modeUpdateRequired: state.routing?.nativeThreadsSupported === true && state.needsUpgrade === true,
        reloadNote: state.routing?.nativeThreadsSupported === true
          ? state.needsUpgrade ? state.routing?.mode === 'official'
            ? '请更新原生连接以恢复旧会话原始路由，再完全退出并重开 Codex。'
            : '请先更新网关连接，补齐原生旧会话接入，再完全退出并重开 Codex。'
            : '模式连接配置已保存。完全退出并重开 Codex 后原会话生效，历史保留；原生模式请选择普通 GPT 模型。'
          : '模式配置通过 Codex 官方接口保存。完全退出后重开以切换；目录同步不保证当前模型菜单即时刷新。' };
    },
    async setMode(mode) {
      try { await integration.switchMode(mode === 'native' ? 'official' : 'gateway'); }
      catch (error) { throw new BridgeError('Codex 配置存在冲突或尚未接入，切换未确认。请检查下方 Codex 连接模式。', 409, error.code || 'client_codex_mode_conflict'); }
    },
    async sync() {
      const state = await integration.inspect();
      if (state.routing?.mode !== 'gateway' || state.needsUpgrade) throw new BridgeError('请先完成并更新 Codex 网关接入。', 409, 'client_codex_catalog_unavailable');
      // The configured model_catalog_url is the live catalog. Do not replace
      // Codex's provider, prompt template, authentication or model preferences.
      return { changed: false };
    } };
}
