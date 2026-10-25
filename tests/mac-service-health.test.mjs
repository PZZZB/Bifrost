import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMacHealth } from '../src/mac-service-health.mjs';

test('health distinguishes public ingress, isolated services, and missing model login', () => {
  const components = { accountWebsite: { ok: true }, publicWebsite: { ok: true }, modelRelay: { ok: true }, dedicatedVpsExit: { ok: true } };
  assert.equal(classifyMacHealth(components, 0).state, 'ready_without_model');
  assert.equal(classifyMacHealth(components, 0).modelReady, false);
  assert.equal(classifyMacHealth(components, 2).state, 'healthy');
  const down = classifyMacHealth({ ...components, publicWebsite: { ok: false } }, 2);
  assert.equal(down.state, 'degraded'); assert.deepEqual(down.failed, ['publicWebsite']); assert.equal(down.modelReady, true);
});
