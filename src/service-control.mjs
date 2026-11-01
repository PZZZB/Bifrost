import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { BridgeError, readJson, writeJson, redact } from './storage.mjs';

/** Requests a child restart from its existing independent supervisor. */
export function createServiceControl({ stateDir, projectDir, getActiveRequests, onRestart,
  processId = process.pid, parentProcessId = process.ppid, platform = process.platform, now = Date.now,
  read = readJson, write = writeJson, remove = unlink, version = null,
  supervisorOwner = null,
  idleCheckMs = 1_000, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  if (!Number.isFinite(idleCheckMs) || idleCheckMs < 1) throw new TypeError('idleCheckMs must be positive.');
  const directory = join(stateDir, 'service');
  const requestPath = join(directory, 'restart-request.json');
  let pending = null, preparing = null, activation = null, lastError = null;
  let draining = false, closed = false, generation = 0, waiter = null;
  let cleanupFailure = null, cleanupOwner = null, cleanupOperation = null;
  const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' &&
    resolve(left).toLowerCase() === resolve(right).toLowerCase();
  function activeCount() {
    const count = getActiveRequests();
    if (!Number.isSafeInteger(count) || count < 0) throw new BridgeError('当前活跃请求数不可用，暂不能重启。', 503);
    return count;
  }
  async function owner() {
    if (platform === 'darwin' && typeof supervisorOwner === 'function') {
      const identity = await supervisorOwner();
      return /^[A-F0-9]{64}$/.test(identity?.OwnerId ?? '') ? identity : null;
    }
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
  const current = approved => !closed && pending === approved && generation === approved.generation;
  function clearWait() {
    const waiting = waiter;
    waiter = null;
    if (waiting) { unschedule(waiting.timer); waiting.resolve(false); }
  }
  function waitForIdleCheck(approved) {
    if (!current(approved)) return Promise.resolve(false);
    return new Promise(resolveWait => {
      const waiting = { timer: null, resolve: resolveWait };
      waiter = waiting;
      waiting.timer = schedule(() => {
        if (waiter === waiting) waiter = null;
        resolveWait(current(approved));
      }, idleCheckMs);
      waiting.timer?.unref?.();
    });
  }
  async function removeMarker(approved) {
    if (cleanupOperation) return cleanupOperation;
    const operation = (async () => {
      try { await remove(requestPath); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          cleanupFailure = new BridgeError('重启标记清理失败，服务保持停止接入。请重试取消，清理成功前无法确认取消。', 503, 'restart_cleanup_failed');
          cleanupOwner = approved;
          approved.state = 'cleanup_failed';
          pending = approved;
          lastError = cleanupFailure.message;
          draining = true;
          throw cleanupFailure;
        }
      }
      if (cleanupOwner === approved) {
        cleanupFailure = null;
        cleanupOwner = null;
        if (pending === approved) pending = null;
        lastError = null;
        draining = closed;
      }
    })().finally(() => { if (cleanupOperation === operation) cleanupOperation = null; });
    cleanupOperation = operation;
    return operation;
  }
  function becameBusy(approved) {
    if (approved.mode === 'when-idle') return 'busy';
    throw new BridgeError('出现了新的活跃请求，本次重启已取消。', 409);
  }
  async function restart(approved) {
    let markerWritten = false;
    try {
      if (!current(approved)) return 'cancelled';
      draining = true;
      approved.state = 'restarting';
      if (!approved.allowInterrupt && activeCount() > 0) return becameBusy(approved);
      const identity = await owner();
      if (!current(approved)) return 'cancelled';
      if (!identity || identity.OwnerId !== approved.ownerId) throw new BridgeError('后台服务身份已变化，本次重启已取消。', 409);
      if (!approved.allowInterrupt && activeCount() > 0) return becameBusy(approved);
      const requestedAt = now();
      await write(requestPath, { Product: 'Bifrost.Service.Restart', Version: 1,
        OwnerId: approved.ownerId, NodePid: processId, Nonce: approved.nonce,
        RequestedAt: new Date(requestedAt).toISOString(), ExpiresAt: new Date(requestedAt + 120_000).toISOString() });
      markerWritten = true;
      if (!current(approved)) return 'cancelled';
      // Recheck after durable I/O, including a Run waiting for its client tools.
      const finalIdentity = await owner();
      if (!current(approved)) return 'cancelled';
      if (!finalIdentity || finalIdentity.OwnerId !== approved.ownerId) throw new BridgeError('后台服务身份已变化，本次重启已取消。', 409);
      if (!approved.allowInterrupt && activeCount() > 0) return becameBusy(approved);
      approved.committed = true;
      try { await onRestart(); }
      catch (error) { approved.committed = false; throw error; }
      return 'restarted';
    } finally {
      if (markerWritten && !approved.committed) await removeMarker(approved);
      if (current(approved) && !approved.committed) draining = false;
    }
  }
  async function run(approved) {
    try {
      if (approved.mode !== 'when-idle') { await restart(approved); return; }
      approved.state = 'queued';
      let idleObservations = 0;
      while (current(approved)) {
        idleObservations = activeCount() === 0 ? idleObservations + 1 : 0;
        if (idleObservations >= 2) {
          const result = await restart(approved);
          if (result !== 'busy') return;
          idleObservations = 0;
          if (current(approved)) approved.state = 'queued';
        }
        if (!await waitForIdleCheck(approved)) return;
      }
    } catch (error) {
      // Cleanup failure is safety-critical even if cancel/close invalidated
      // this generation. removeMarker retains its owner and blocks admission.
      if (error.code === 'restart_cleanup_failed') return;
      if (pending === approved && generation === approved.generation) {
        lastError = redact(error.message);
        pending = null;
        draining = closed;
      }
    }
  }
  return {
    get pending() { return pending !== null || preparing !== null; },
    get draining() { return draining; },
    async cancel() {
      if (pending?.committed) return false;
      generation++;
      preparing = null;
      clearWait();
      if (cleanupOwner) {
        await removeMarker(cleanupOwner);
        return true;
      }
      pending = null;
      draining = closed;
      // Finish a cancelled marker write before a new restart can use its path.
      if (activation) await activation;
      if (cleanupFailure) throw cleanupFailure;
      return true;
    },
    async close() {
      const wasClosed = closed;
      closed = true;
      draining = true;
      clearWait();
      // onRestart may call shutdown -> close: never await that same activation.
      if (!pending?.committed) {
        generation++;
        preparing = null;
        try {
          if (cleanupOwner) await removeMarker(cleanupOwner);
          else {
            pending = null;
            if (activation) await activation;
            if (cleanupFailure) throw cleanupFailure;
          }
        } catch (error) {
          // A failed uncommitted shutdown may recover through the dashboard.
          // A previously committed close must never reopen request admission.
          if (!wasClosed) closed = false;
          draining = true;
          throw error;
        }
      }
    },
    async status() {
      let supported = false;
      try { supported = Boolean(await owner()); }
      catch { /* An invalid optional supervisor must not stop the dashboard. */ }
      let activeRequests = null;
      try { activeRequests = activeCount(); } catch {}
      let build;
      if (version) {
        try { build = await version.status(); }
        catch { build = { running: null, installed: null, updatePending: null, state: 'unknown' }; }
      }
      return { supported, platform, pending: pending !== null || preparing !== null, draining, activeRequests,
        restart: pending ? { mode: pending.mode, state: pending.state, queuedAt: pending.queuedAt } : null,
        capabilities: { whenIdle: true, cancelQueued: true, version: Boolean(version) },
        ...(version ? { version: build } : {}),
        ready: !closed && !cleanupFailure, independentOfCodex: supported, error: lastError,
        message: supported ? null : platform === 'win32'
          ? '当前进程没有可验证的独立后台托管；请在项目目录运行 .\\Start-Bridge.ps1 -Restart -Open。'
          : '当前运行方式暂不支持网页重启，请通过所用进程管理器手动重启服务。' };
    },
    async request(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).some(key => key !== 'allowInterrupt' && key !== 'mode') ||
          (body.mode === 'when-idle'
            ? body.allowInterrupt !== undefined && body.allowInterrupt !== false
            : body.mode !== undefined && body.mode !== 'immediate' || typeof body.allowInterrupt !== 'boolean')) {
        throw new BridgeError('请使用 mode: "when-idle"，或提供布尔值 allowInterrupt。', 400, 'invalid_restart_request');
      }
      if (cleanupFailure) throw cleanupFailure;
      if (closed) throw new BridgeError('网关正在关闭。', 503, 'service_closing');
      if (pending || preparing || activation) throw new BridgeError('网关正在准备重启。', 409, 'restart_pending');
      const preparation = { generation: ++generation };
      preparing = preparation;
      try {
        const config = await owner();
        if (closed || generation !== preparation.generation) throw new BridgeError('本次重启已取消。', 409, 'restart_cancelled');
        if (!config) throw new BridgeError(platform === 'win32'
          ? '当前服务不支持网页重启，请在项目目录运行 .\\Start-Bridge.ps1 -Restart -Open。'
          : '当前服务不支持网页重启，请通过所用进程管理器手动重启。', 503, 'restart_unsupported');
        const active = activeCount();
        const mode = body.mode === 'when-idle' ? 'when-idle' : 'immediate';
        if (active > 0 && mode !== 'when-idle' && !body.allowInterrupt) {
          const error = new BridgeError(`当前有 ${active} 个活跃请求。请等待完成，或明确允许中断后重试。`, 409, 'gateway_busy');
          error.activeRequests = active;
          throw error;
        }
        pending = { ownerId: config.OwnerId, allowInterrupt: body.allowInterrupt === true, nonce: randomUUID(),
          generation: preparation.generation, mode, state: 'prepared', committed: false,
          queuedAt: mode === 'when-idle' ? new Date(now()).toISOString() : null };
        lastError = null;
        return { accepted: true, mode, queued: mode === 'when-idle', reconnectAfterMs: 750 };
      } finally { if (preparing === preparation) preparing = null; }
    },
    // Called only once the HTTP acknowledgement has finished writing.
    activate() {
      if (!pending || closed || cleanupFailure) return Promise.resolve();
      if (activation) return activation;
      const approved = pending;
      const operation = run(approved).finally(() => { if (!approved.committed && activation === operation) activation = null; });
      activation = operation;
      return activation;
    },
  };
}
