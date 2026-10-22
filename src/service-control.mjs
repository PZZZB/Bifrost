import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { BridgeError, readJson, writeJson, redact } from './storage.mjs';

/** Requests a child restart from its existing independent supervisor. */
export function createServiceControl({ stateDir, projectDir, getActiveRequests, onRestart,
  processId = process.pid, parentProcessId = process.ppid, platform = process.platform, now = Date.now,
  read = readJson, write = writeJson, remove = unlink } = {}) {
  const directory = join(stateDir, 'service');
  const requestPath = join(directory, 'restart-request.json');
  let pending = null, preparing = false, activation = null, lastError = null;
  const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    resolve(left).toLowerCase() === resolve(right).toLowerCase();
  function activeCount() {
    const count = getActiveRequests();
    if (!Number.isSafeInteger(count) || count < 0) throw new BridgeError('当前活跃请求数不可用，暂不能重启。', 503);
    return count;
  }
  async function owner() {
    if (platform !== 'win32') return null;
    const config = await read(join(directory, 'service.json'), null);
    const identity = await read(join(directory, 'process.json'), null);
    if (config?.Product !== 'AgentBridge.Service' || config.Version !== 1 ||
        !/^[0-9A-F]{64}$/.test(config.OwnerId ?? '') ||
        !samePath(config.ProjectDirectory, projectDir) || !samePath(config.StateDirectory, stateDir) ||
        identity?.Product !== 'AgentBridge.Service.Process' || identity.OwnerId !== config.OwnerId ||
        identity.NodePid !== processId || identity.RestartProtocol !== 1 ||
        !Number.isSafeInteger(identity.RunnerPid) || identity.RunnerPid !== parentProcessId ||
        !samePath(identity.EntryScript, join(projectDir, 'src', 'main.mjs'))) return null;
    return config;
  }
  return {
    get pending() { return pending !== null || preparing; },
    cancel() {
      if (activation) return false;
      pending = null;
      return true;
    },
    async status() {
      let supported = false;
      try { supported = Boolean(await owner()); }
      catch { /* An invalid optional supervisor must not stop the dashboard. */ }
      let activeRequests = null;
      try { activeRequests = activeCount(); } catch {}
      return { supported, platform, pending: pending !== null || preparing, activeRequests,
        ready: true, independentOfCodex: supported, error: lastError,
        message: supported ? null : '当前进程没有可验证的独立后台托管；请使用桌面重启快捷方式。' };
    },
    async request(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => key !== 'allowInterrupt') || typeof body.allowInterrupt !== 'boolean') {
        throw new BridgeError('allowInterrupt 必须是布尔值。', 400, 'invalid_restart_request');
      }
      if (pending || preparing) throw new BridgeError('网关正在准备重启。', 409, 'restart_pending');
      preparing = true;
      try {
        const config = await owner();
        if (!config) throw new BridgeError('当前服务不支持网页重启，请使用桌面重启快捷方式。', 503, 'restart_unsupported');
        const active = activeCount();
        if (active > 0 && !body.allowInterrupt) {
          const error = new BridgeError(`当前有 ${active} 个活跃请求。请等待完成，或明确允许中断后重试。`, 409, 'gateway_busy');
          error.activeRequests = active;
          throw error;
        }
        pending = { config, allowInterrupt: body.allowInterrupt, nonce: randomUUID() };
        lastError = null;
        return { accepted: true, reconnectAfterMs: 750 };
      } finally { preparing = false; }
    },
    // Called only once the HTTP acknowledgement has finished writing.
    activate() {
      if (!pending) return Promise.resolve();
      if (activation) return activation;
      const approved = pending;
      activation = (async () => {
        let markerWritten = false;
        try {
          if (!approved.allowInterrupt && activeCount() > 0) throw new BridgeError('出现了新的活跃请求，本次重启已取消。', 409);
          const current = await owner();
          if (!current || current.OwnerId !== approved.config.OwnerId) throw new BridgeError('后台服务身份已变化，本次重启已取消。', 409);
          await write(requestPath, { Product: 'Bifrost.Service.Restart', Version: 1,
            OwnerId: current.OwnerId, NodePid: processId, Nonce: approved.nonce,
            RequestedAt: new Date(now()).toISOString(), ExpiresAt: new Date(now() + 120_000).toISOString() });
          markerWritten = true;
          await onRestart();
        } catch (error) {
          if (markerWritten) await remove(requestPath).catch(() => {});
          lastError = redact(error.message); pending = null;
        }
      })().finally(() => { if (!pending) activation = null; });
      return activation;
    },
  };
}
