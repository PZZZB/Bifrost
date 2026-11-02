import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServiceControl } from '../src/service-control.mjs';

function fixture({ configPatch = {}, identityPatch = {}, platform = 'win32', write, read, onRestart, controlOptions = {} } = {}) {
  const projectDir = 'D:/Bifrost-service-fixture';
  const stateDir = 'D:/Bifrost-service-fixture-state';
  const config = { Product: 'AgentBridge.Service', Version: 1, OwnerId: 'A'.repeat(64), ProjectDirectory: projectDir, StateDirectory: stateDir, ...configPatch };
  const identity = { Product: 'AgentBridge.Service.Process', OwnerId: config.OwnerId, RestartProtocol: 1, NodePid: 1234, RunnerPid: 1233,
    EntryScript: join(projectDir, 'src', 'main.mjs'), ...identityPatch };
  let active = 0, stopped = 0, removed = 0;
  const writes = [];
  const controller = createServiceControl({ stateDir, projectDir, processId: 1234, parentProcessId: 1233, platform, now: () => 1800000000000,
    supervisorOwner: async () => ({ OwnerId: config.OwnerId, NodePid: 1234, RunnerPid: 1233 }),
    getActiveRequests: () => active, onRestart: async () => { stopped++; await onRestart?.(controller); },
    read: read ?? (async path => path.endsWith('service.json') ? config : identity),
    write: write ?? (async (path, value) => { writes.push({ path, value }); }), remove: async () => { removed++; }, ...controlOptions });
  return { controller, writes, config, identity, setActive: value => { active = value; }, stopped: () => stopped, removed: () => removed };
}

test('web restart is a two-phase operation and never stops the process before activation', async () => {
  const { controller, writes, stopped } = fixture();
  assert.equal((await controller.status()).supported, true);
  assert.equal((await controller.status()).independentOfCodex, true);
  assert.equal((await controller.request({ allowInterrupt: false })).accepted, true);
  assert.equal(stopped(), 0); assert.equal(writes.length, 0);
  assert.equal((await controller.status()).pending, true);
  await controller.activate();
  assert.equal(stopped(), 1); assert.equal(writes.length, 1);
  assert.equal(writes[0].value.NodePid, 1234); assert.equal(writes[0].value.OwnerId, 'A'.repeat(64));
  assert.equal(writes[0].value.Product, 'Bifrost.Service.Restart');
  assert.equal(Date.parse(writes[0].value.ExpiresAt) - Date.parse(writes[0].value.RequestedAt), 120000);
  assert.match(writes[0].value.Nonce, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(writes[0].value).sort(), ['ExpiresAt', 'NodePid', 'Nonce', 'OwnerId', 'Product', 'RequestedAt', 'Version']);
});

test('active requests require explicit interrupt approval and a duplicate restart cannot be scheduled', async () => {
  const { controller, setActive, writes, stopped } = fixture(); setActive(2);
  await assert.rejects(controller.request({ allowInterrupt: false }), error => error.code === 'gateway_busy' && error.activeRequests === 2);
  assert.equal(controller.pending, false); assert.equal(stopped(), 0); assert.equal(writes.length, 0);
  await controller.request({ allowInterrupt: true });
  await assert.rejects(controller.request({ allowInterrupt: true }), error => error.code === 'restart_pending');
  await Promise.all([controller.activate(), controller.activate()]);
  assert.equal(writes.length, 1); assert.equal(stopped(), 1);
});

test('a newly active request cancels an unforced restart and permits a later retry', async () => {
  const { controller, setActive, writes, stopped } = fixture();
  await controller.request({ allowInterrupt: false }); setActive(1); await controller.activate();
  assert.equal(writes.length, 0); assert.equal(stopped(), 0); assert.equal(controller.pending, false);
  assert.match((await controller.status()).error, /新的活跃请求/);
  setActive(0); await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(stopped(), 1); assert.equal(writes.length, 1);
});

test('unsupported, orphaned, mismatched and old supervisors fail without a restart marker', async () => {
  for (const options of [{ platform: 'linux' }, { identityPatch: { NodePid: 2222 } }, { identityPatch: { RestartProtocol: undefined } },
    { identityPatch: { OwnerId: 'B'.repeat(64) } }, { identityPatch: { RunnerPid: 5555 } }, { configPatch: { ProjectDirectory: 'D:/another-project' } }]) {
    const { controller, writes, stopped } = fixture(options);
    assert.equal((await controller.status()).supported, false);
    await assert.rejects(controller.request({ allowInterrupt: false }), error => error.code === 'restart_unsupported');
    assert.equal(stopped(), 0); assert.equal(writes.length, 0);
  }
});

test('matching saved Windows identity cannot enable restart without a live supervisor', async () => {
  for (const supervisorOwner of [null, async () => null,
    async () => ({ OwnerId: 'A'.repeat(64), NodePid: 1234, RunnerPid: 9999 }),
    async () => ({ OwnerId: 'A'.repeat(64), NodePid: 9999, RunnerPid: 1233 }),
    async () => ({ OwnerId: 'B'.repeat(64), NodePid: 1234, RunnerPid: 1233 }),
    async () => { throw new Error('private supervisor error'); }]) {
    const { controller, writes, stopped } = fixture({ controlOptions: { supervisorOwner } });
    const status = await controller.status();
    assert.equal(status.supported, false);
    assert.equal(status.independentOfCodex, false);
    assert.equal(JSON.stringify(status).includes('private supervisor error'), false);
    await assert.rejects(controller.request({ allowInterrupt: false }), error => error.code === 'restart_unsupported');
    assert.equal(stopped(), 0);
    assert.equal(writes.length, 0);
  }
});

test('a Windows supervisor dying before or after marker persistence leaves the gateway running', async () => {
  for (const duringWrite of [false, true]) {
    let alive = true;
    const liveOwner = { OwnerId: 'A'.repeat(64), NodePid: 1234, RunnerPid: 1233 };
    const subject = fixture({
      ...(duringWrite ? { write: async () => { alive = false; } } : {}),
      controlOptions: { supervisorOwner: async () => alive ? liveOwner : null },
    });
    await subject.controller.request({ allowInterrupt: false });
    if (!duringWrite) alive = false;
    await subject.controller.activate();
    assert.equal(subject.stopped(), 0);
    assert.equal(subject.controller.pending, false);
    assert.equal(subject.controller.draining, false);
    assert.equal(subject.removed(), duringWrite ? 1 : 0);
    assert.match((await subject.controller.status()).error, /身份已变化/);
  }
});

test('restart identity changes and failed durable writes cannot stop the current service', async () => {
  const changing = fixture(); await changing.controller.request({ allowInterrupt: false });
  changing.identity.NodePid = 8888; await changing.controller.activate();
  assert.equal(changing.stopped(), 0); assert.equal(changing.writes.length, 0);
  const denied = fixture({ write: async () => { throw new Error('disk denied'); } });
  await denied.controller.request({ allowInterrupt: false }); await denied.controller.activate();
  assert.equal(denied.stopped(), 0); assert.equal(denied.controller.pending, false);
  assert.equal((await denied.controller.status()).error, 'disk denied');
});

test('invalid restart options and unknown active counts never arm a restart', async () => {
  const { controller, setActive, stopped } = fixture();
  for (const body of [null, [], {}, { allowInterrupt: 'true' }, { allowInterrupt: true, command: 'untrusted' },
    { mode: 'unknown', allowInterrupt: false }, { mode: 'when-idle', allowInterrupt: true }, { mode: 'when-idle', command: 'untrusted' }]) {
    await assert.rejects(controller.request(body), error => error.code === 'invalid_restart_request');
  }
  setActive(null); await assert.rejects(controller.request({ allowInterrupt: true }), error => error.status === 503);
  assert.equal(stopped(), 0); assert.equal(controller.pending, false);
});

test('a lost acknowledgement can cancel a prepared restart without leaving the gateway draining', async () => {
  const { controller, writes, stopped } = fixture();
  await controller.request({ allowInterrupt: false }); assert.equal(controller.pending, true);
  assert.equal(await controller.cancel(), true); await controller.activate();
  assert.equal(controller.pending, false); assert.equal(writes.length, 0); assert.equal(stopped(), 0);
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(await controller.cancel(), false); assert.equal(stopped(), 1);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function manualClock() {
  const timers = new Map();
  return {
    schedule(callback) { const timer = { unref() {} }; timers.set(timer, callback); return timer; },
    unschedule(timer) { timers.delete(timer); },
    get size() { return timers.size; },
    async tick() {
      assert.equal(timers.size, 1, 'exactly one idle check should be scheduled');
      const [timer, callback] = timers.entries().next().value;
      timers.delete(timer); callback(); await flush();
    },
  };
}

test('idle restart waits for whole Runs, preserves tool continuations and requires two idle observations', async () => {
  const clock = manualClock();
  const { controller, setActive, writes, stopped } = fixture({ controlOptions: clock });
  setActive(1); // A Cursor Run can remain active while its HTTP request waits for client tools.
  assert.deepEqual(await controller.request({ mode: 'when-idle' }), { accepted: true, mode: 'when-idle', queued: true, reconnectAfterMs: 750 });
  assert.equal(clock.size, 0, 'queue must not activate before the acknowledgement finishes');
  assert.equal(controller.pending, true); assert.equal(controller.draining, false);
  const activation = controller.activate(); await flush();
  let status = await controller.status();
  assert.deepEqual(status.restart, { mode: 'when-idle', state: 'queued', queuedAt: new Date(1800000000000).toISOString() });
  assert.equal(status.activeRequests, 1); assert.equal(status.draining, false);
  assert.deepEqual(status.capabilities, { whenIdle: true, cancelQueued: true, version: false });
  await clock.tick(); assert.equal(stopped(), 0); assert.equal(writes.length, 0);
  setActive(0); await clock.tick();
  assert.equal(writes.length, 0); assert.equal(controller.draining, false);
  await clock.tick(); await activation;
  assert.equal(stopped(), 1); assert.equal(writes.length, 1); assert.equal(controller.draining, true); assert.equal(clock.size, 0);
  status = await controller.status(); assert.equal(status.restart.state, 'restarting');
});

test('new activity resets idle confirmation and a queued restart is cancellable without leftover timers', async () => {
  const clock = manualClock();
  const { controller, setActive, stopped, writes } = fixture({ controlOptions: clock });
  await controller.request({ mode: 'when-idle', allowInterrupt: false });
  const activation = controller.activate(); await flush();
  setActive(2); await clock.tick();
  setActive(0); await clock.tick();
  assert.equal(writes.length, 0); assert.equal(controller.draining, false);
  assert.equal(await controller.cancel(), true); await activation;
  assert.equal(clock.size, 0); assert.equal(controller.pending, false); assert.equal(controller.draining, false); assert.equal(stopped(), 0);
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(stopped(), 1);
});

test('idle restart rechecks active Runs after durable marker I/O and returns to the queue if needed', async () => {
  const clock = manualClock();
  let markerWrites = 0, activeFixture;
  const subject = fixture({ controlOptions: clock, write: async () => { if (++markerWrites === 1) activeFixture.setActive(1); } });
  activeFixture = subject;
  await subject.controller.request({ mode: 'when-idle' });
  const activation = subject.controller.activate(); await flush(); await clock.tick();
  assert.equal(markerWrites, 1); assert.equal(subject.removed(), 1); assert.equal(subject.stopped(), 0);
  assert.equal(subject.controller.draining, false); assert.equal((await subject.controller.status()).restart.state, 'queued');
  subject.setActive(0); await clock.tick(); assert.equal(markerWrites, 1);
  await clock.tick(); await activation;
  assert.equal(markerWrites, 2); assert.equal(subject.stopped(), 1);
});

test('idle restart binds immutable supervisor identity and removes a marker if identity changes during the write', async () => {
  for (const duringWrite of [false, true]) {
    const clock = manualClock();
    let subject;
    const changeOwner = () => { subject.config.OwnerId = 'B'.repeat(64); subject.identity.OwnerId = subject.config.OwnerId; };
    subject = fixture({ controlOptions: clock, ...(duringWrite ? { write: async () => changeOwner() } : {}) });
    await subject.controller.request({ mode: 'when-idle' });
    const activation = subject.controller.activate(); await flush();
    if (!duringWrite) changeOwner();
    await clock.tick(); await activation;
    assert.equal(subject.stopped(), 0); assert.equal(subject.controller.pending, false); assert.equal(subject.controller.draining, false);
    assert.equal(subject.removed(), duringWrite ? 1 : 0); assert.equal(clock.size, 0);
    assert.match((await subject.controller.status()).error, /身份已变化/);
  }
});

test('cancel waits for a marker write to be removed before a new restart can reuse the marker path', async () => {
  let releaseWrite, notifyWrite, markerWrites = 0;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { notifyWrite = resolve; });
  const subject = fixture({ write: async () => { if (++markerWrites === 1) { notifyWrite(); await blocked; } } });
  await subject.controller.request({ allowInterrupt: false });
  const activation = subject.controller.activate(); await started;
  const cancelling = subject.controller.cancel();
  assert.equal(subject.controller.draining, false);
  await assert.rejects(subject.controller.request({ allowInterrupt: false }), error => error.code === 'restart_pending');
  releaseWrite(); assert.equal(await cancelling, true); await activation;
  assert.equal(subject.removed(), 1); assert.equal(subject.stopped(), 0);
  await subject.controller.request({ allowInterrupt: false }); await subject.controller.activate();
  assert.equal(subject.stopped(), 1); assert.equal(markerWrites, 2);
});

test('failed cancellation cleanup retains the marker owner, blocks admission and rejects success until cleanup retries', async () => {
  let releaseWrite, notifyWrite, marker = false, canRemove = false, writes = 0;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { notifyWrite = resolve; });
  const { controller, stopped } = fixture({ write: async () => { marker = true; if (++writes === 1) { notifyWrite(); await blocked; } },
    controlOptions: { remove: async () => { if (!canRemove) throw Object.assign(new Error('private marker path'), { code: 'EACCES' }); marker = false; } } });
  await controller.request({ allowInterrupt: false });
  const activation = controller.activate(); await started;
  const cancelling = controller.cancel(); releaseWrite();
  await assert.rejects(cancelling, error => error.code === 'restart_cleanup_failed' && error.status === 503);
  await activation;
  let status = await controller.status();
  assert.equal(marker, true); assert.equal(stopped(), 0); assert.equal(status.pending, true); assert.equal(status.draining, true);
  assert.equal(status.ready, false); assert.equal(status.restart.state, 'cleanup_failed'); assert.match(status.error, /清理失败/);
  assert.equal(JSON.stringify(status).includes('private marker path'), false);
  await assert.rejects(controller.request({ allowInterrupt: true }), error => error.code === 'restart_cleanup_failed');
  await controller.activate(); assert.equal(stopped(), 0); assert.equal(writes, 1);
  await assert.rejects(controller.cancel(), error => error.code === 'restart_cleanup_failed');
  canRemove = true; assert.equal(await controller.cancel(), true);
  status = await controller.status();
  assert.equal(marker, false); assert.equal(status.pending, false); assert.equal(status.draining, false); assert.equal(status.ready, true); assert.equal(status.error, null);
  await controller.request({ allowInterrupt: false }); await controller.activate(); assert.equal(stopped(), 1);
});

test('failed close cleanup stays visible and can recover the uncommitted service through cancellation', async () => {
  let releaseWrite, notifyWrite, marker = false, canRemove = false;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { notifyWrite = resolve; });
  const { controller, stopped } = fixture({ write: async () => { marker = true; notifyWrite(); await blocked; },
    controlOptions: { remove: async () => { if (!canRemove) throw Object.assign(new Error('private marker path'), { code: 'EACCES' }); marker = false; } } });
  await controller.request({ allowInterrupt: false });
  const activation = controller.activate(); await started;
  const closing = controller.close(); releaseWrite();
  await assert.rejects(closing, error => error.code === 'restart_cleanup_failed'); await activation;
  let status = await controller.status();
  assert.equal(marker, true); assert.equal(stopped(), 0); assert.equal(status.pending, true); assert.equal(status.draining, true);
  assert.equal(status.ready, false); assert.equal(status.restart.state, 'cleanup_failed'); assert.match(status.error, /清理失败/);
  canRemove = true; await controller.cancel();
  status = await controller.status();
  assert.equal(marker, false); assert.equal(status.draining, false); assert.equal(status.ready, true);
  await controller.request({ allowInterrupt: false }); await controller.activate(); assert.equal(stopped(), 1);
});

test('cleanup retry cannot reopen a previously committed shutdown', async () => {
  let canRemove = false;
  const { controller } = fixture({ onRestart: async control => { await control.close(); throw new Error('shutdown fixture failure'); },
    controlOptions: { remove: async () => { if (!canRemove) throw Object.assign(new Error('private path'), { code: 'EACCES' }); } } });
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal((await controller.status()).restart.state, 'cleanup_failed');
  canRemove = true; await controller.cancel();
  assert.equal(controller.pending, false); assert.equal(controller.draining, true); assert.equal((await controller.status()).ready, false);
  await assert.rejects(controller.request({ allowInterrupt: false }), error => error.code === 'service_closing');
});

test('close clears queued timers and rejects further restart requests', async () => {
  const clock = manualClock();
  const { controller, setActive, stopped } = fixture({ controlOptions: clock }); setActive(1);
  await controller.request({ mode: 'when-idle' });
  const activation = controller.activate(); await flush();
  await controller.close(); await activation;
  assert.equal(clock.size, 0); assert.equal(controller.pending, false); assert.equal(controller.draining, true); assert.equal(stopped(), 0);
  await controller.cancel(); assert.equal(controller.draining, true, 'a lost acknowledgement must not reopen a closing listener');
  await assert.rejects(controller.request({ mode: 'when-idle' }), error => error.code === 'service_closing');
});

test('close waits for an uncommitted marker write so shutdown cannot leave a live restart marker', async () => {
  let releaseWrite, notifyWrite;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { notifyWrite = resolve; });
  const { controller, stopped, removed } = fixture({ write: async () => { notifyWrite(); await blocked; } });
  await controller.request({ allowInterrupt: false });
  const activation = controller.activate(); await started;
  let closeFinished = false;
  const closing = controller.close().then(() => { closeFinished = true; });
  await flush(); assert.equal(closeFinished, false);
  releaseWrite(); await closing; await activation;
  assert.equal(removed(), 1); assert.equal(stopped(), 0); assert.equal(controller.pending, false);
});

test('an unknown whole-Run count cancels the queue instead of treating it as idle', async () => {
  const clock = manualClock();
  const { controller, setActive, writes, stopped } = fixture({ controlOptions: clock });
  setActive(1); await controller.request({ mode: 'when-idle' });
  const activation = controller.activate(); await flush();
  setActive(null); await clock.tick(); await activation;
  assert.equal(controller.pending, false); assert.equal(controller.draining, false); assert.equal(clock.size, 0);
  assert.equal(stopped(), 0); assert.equal(writes.length, 0);
  assert.match((await controller.status()).error, /活跃请求数不可用/);
});

test('onRestart can await shutdown close without waiting for its own activation', { timeout: 1000 }, async () => {
  const { controller, stopped, removed } = fixture({ onRestart: async control => { await control.close(); } });
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(stopped(), 1); assert.equal(removed(), 0);
  assert.equal((await controller.status()).ready, false);
});

test('a shutdown failure after close never reopens request admission', async () => {
  const { controller, removed } = fixture({ onRestart: async control => { await control.close(); throw new Error('shutdown fixture failure'); } });
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(removed(), 1); assert.equal(controller.pending, false); assert.equal(controller.draining, true);
  assert.equal((await controller.status()).ready, false);
});

test('service status exposes captured version metadata and handles unavailable optional metadata safely', async () => {
  const metadata = { running: { revision: '1'.repeat(40), fingerprint: 'a'.repeat(64), dirty: false, startedAt: '2026-10-23T00:00:00.000Z' },
    installed: { revision: '2'.repeat(40), fingerprint: 'b'.repeat(64), dirty: true }, updatePending: true, state: 'update_pending' };
  const ready = fixture({ controlOptions: { version: { status: async () => metadata } } });
  const status = await ready.controller.status(); assert.deepEqual(status.version, metadata); assert.equal(status.capabilities.version, true);
  const missing = fixture({ controlOptions: { version: { status: async () => { throw new Error('secret private path'); } } } });
  const safe = await missing.controller.status();
  assert.deepEqual(safe.version, { running: null, installed: null, updatePending: null, state: 'unknown' });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});

test('a verified Mac supervisor uses the same idle and acknowledgement gates and rechecks identity before exit', async () => {
  let identity = { OwnerId: 'B'.repeat(64) };
  const f = fixture({ platform: 'darwin', controlOptions: { supervisorOwner: async () => identity } });
  assert.equal((await f.controller.status()).supported, true);
  f.setActive(1); await assert.rejects(f.controller.request({ allowInterrupt: false }), e => e.code === 'gateway_busy');
  f.setActive(0); await f.controller.request({ allowInterrupt: false }); assert.equal(f.stopped(), 0);
  identity = null; await f.controller.activate(); assert.equal(f.stopped(), 0);
  identity = { OwnerId: 'B'.repeat(64) };
  await f.controller.request({ allowInterrupt: false }); await f.controller.activate(); assert.equal(f.stopped(), 1);
});
