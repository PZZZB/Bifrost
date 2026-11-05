import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/routing/model-router.mjs';

function fixture() {
  const provider = { id: 'remote-source', kind: 'bifrost-remote', generation: 'generation-one',
    catalogSnapshot: () => ['opus', 'sonnet'].map(id => ({ id, name: id, protocols: ['responses'] })),
    async refreshCatalog() {}, async request() { throw new Error('No inference in router checks.'); }, status: () => ({}), async close() {} };
  const router = new ModelRouter({ providers: [provider], secret: 'router-session-private-secret-'.repeat(3) });
  const resolve = (id, options = {}) => router.resolve('responses', { body: { model: `remote/remote-source/${id}` }, owner: 'owner-one', session: 'actual-chat', ...options });
  return { router, provider, resolve };
}

test('explicit Server routing skips session pinning but keeps the full owner/session/model/authorization scope', () => {
  const { provider, resolve } = fixture();
  const opus = resolve('opus'), sonnet = resolve('sonnet', { trackSession: false });
  assert.notEqual(opus.scope, sonnet.scope);
  assert.equal(resolve('opus', { trackSession: false }).scope, opus.scope);
  assert.notEqual(resolve('opus', { trackSession: false, session: 'other-chat' }).scope, opus.scope);
  assert.notEqual(resolve('opus', { trackSession: false, owner: 'owner-two' }).scope, opus.scope);
  provider.generation = 'generation-two';
  assert.notEqual(resolve('opus', { trackSession: false }).scope, opus.scope);
});

test('Desktop retains its default source pin after a Server-only untracked resolution', () => {
  const { resolve } = fixture();
  const original = resolve('opus');
  assert.throws(() => resolve('sonnet'), { code: 'desktop_session_source_changed', status: 409 });
  resolve('sonnet', { trackSession: false });
  assert.throws(() => resolve('sonnet'), { code: 'desktop_session_source_changed', status: 409 });
  assert.equal(resolve('opus').scope, original.scope);
  assert.throws(() => resolve('opus', { trackSession: 'false' }), { code: 'desktop_session_invalid', status: 400 });
});

test('read-only snapshots share owner/model/authorization while execution sessions remain independent', async () => {
  const { router, provider, resolve } = fixture(), calls = [];
  const parent = resolve('opus', { trackSession: false }), child = resolve('opus', { trackSession: false, session: 'side-chat' });
  assert.notEqual(parent.scope, child.scope); assert.equal(parent.snapshotScope, child.snapshotScope);
  assert.notEqual(parent.snapshotScope, parent.scope);
  assert.notEqual(parent.snapshotScope, resolve('sonnet', { trackSession: false }).snapshotScope);
  assert.notEqual(parent.snapshotScope, resolve('opus', { trackSession: false, owner: 'other-owner' }).snapshotScope);
  provider.request = async (protocol, value) => { calls.push({ protocol, ...value }); return Response.json({}); };
  await assert.rejects(router.request(child, { body: { model: child.id }, snapshot: true }), { code: 'desktop_state_mismatch' });
  assert.equal(calls.length, 0);
  provider.supportsSnapshotState = () => true;
  await router.request(parent, { body: { model: parent.id }, snapshot: true });
  await router.request(child, { body: { model: child.id }, snapshot: true });
  assert.equal(calls[0].scope, calls[1].scope); assert.equal(calls[0].scope, parent.snapshotScope);
  assert.equal(calls[0].session, parent.scope); assert.equal(calls[1].session, child.scope);
  provider.generation = 'changed-authorization';
  const reauthorized = resolve('opus', { trackSession: false });
  assert.notEqual(reauthorized.snapshotScope, parent.snapshotScope);
  await assert.rejects(router.request(parent, { body: { model: parent.id }, snapshot: true }), { code: 'desktop_source_changed' });
  assert.equal(calls.length, 2);
});
