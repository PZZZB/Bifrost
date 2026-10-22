import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServiceControl } from '../src/service-control.mjs';

function fixture({ configPatch = {}, identityPatch = {}, platform = 'win32', write } = {}) {
  const projectDir = 'D:/Bifrost-service-fixture';
  const stateDir = 'D:/Bifrost-service-fixture-state';
  const config = { Product: 'AgentBridge.Service', Version: 1, OwnerId: 'A'.repeat(64), ProjectDirectory: projectDir, StateDirectory: stateDir, ...configPatch };
  const identity = { Product: 'AgentBridge.Service.Process', OwnerId: config.OwnerId, RestartProtocol: 1, NodePid: 1234, RunnerPid: 1233,
    EntryScript: join(projectDir, 'src', 'main.mjs'), ...identityPatch };
  let active = 0, stopped = 0, removed = 0;
  const writes = [];
  const controller = createServiceControl({ stateDir, projectDir, processId: 1234, parentProcessId: 1233, platform, now: () => 1800000000000,
    getActiveRequests: () => active, onRestart: async () => { stopped++; },
    read: async path => path.endsWith('service.json') ? config : identity,
    write: write ?? (async (path, value) => { writes.push({ path, value }); }), remove: async () => { removed++; } });
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
  for (const body of [null, [], {}, { allowInterrupt: 'true' }, { allowInterrupt: true, command: 'untrusted' }]) {
    await assert.rejects(controller.request(body), error => error.code === 'invalid_restart_request');
  }
  setActive(null); await assert.rejects(controller.request({ allowInterrupt: true }), error => error.status === 503);
  assert.equal(stopped(), 0); assert.equal(controller.pending, false);
});

test('a lost acknowledgement can cancel a prepared restart without leaving the gateway draining', async () => {
  const { controller, writes, stopped } = fixture();
  await controller.request({ allowInterrupt: false }); assert.equal(controller.pending, true);
  assert.equal(controller.cancel(), true); await controller.activate();
  assert.equal(controller.pending, false); assert.equal(writes.length, 0); assert.equal(stopped(), 0);
  await controller.request({ allowInterrupt: false }); await controller.activate();
  assert.equal(controller.cancel(), false); assert.equal(stopped(), 1);
});
