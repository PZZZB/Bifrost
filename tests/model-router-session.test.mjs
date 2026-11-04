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
