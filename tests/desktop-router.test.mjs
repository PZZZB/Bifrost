import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/routing/model-router.mjs';

const secret = 'router-private-test-secret-'.repeat(3);
function source(id, kind, upstream = 'same-model') {
  return { id, kind, generation: 0, calls: [],
    catalogSnapshot: () => [{ id: upstream, protocols: ['messages'], available: true }],
    async refreshCatalog() {}, status: () => ({ available: true }), async close() {},
    async request(protocol, request) { this.calls.push({ protocol, ...request }); return Response.json({ model: upstream }); } };
}
test('one registry merges both sources without collisions and resolves exact registered models only', async () => {
  const local = source('codebuddy', 'codebuddy-local'), remote = source('bifrost', 'bifrost-remote');
  const router = new ModelRouter({ secret, providers: [local, remote] });
  const models = router.models();
  assert.deepEqual(models.map(model => model.id), ['local/codebuddy/same-model', 'remote/bifrost/same-model']);
  assert.deepEqual(models.map(model => model.billing_authority), ['company', 'remote-bifrost']);
  const body = { model: models[1].id, messages: [], baseUrl: 'https://attacker.test' };
  const context = router.resolve('messages', { body });
  await router.request(context, { body });
  assert.equal(remote.calls[0].body.model, 'same-model'); assert.equal(local.calls.length, 0);
  assert.throws(() => router.resolve('messages', { body: { model: 'remote/https://attacker.test/model' } }), error => error.code === 'desktop_model_unavailable');
  assert.throws(() => router.resolve('responses', { body }), error => error.status === 501);
  assert.equal(remote.calls.length, 1);
});
test('no fallback on a rejected local call; sessions and source credential generations remain bound', async () => {
  const local = source('codebuddy', 'codebuddy-local'), remote = source('bifrost', 'bifrost-remote');
  const router = new ModelRouter({ secret, providers: [local, remote] });
  local.request = async () => { throw new Error('local quota exhausted'); };
  const body = { model: 'local/codebuddy/same-model' };
  const context = router.resolve('messages', { body, session: 'client-session' });
  await assert.rejects(router.request(context, { body })); assert.equal(remote.calls.length, 0);
  assert.throws(() => router.resolve('messages', { body: { model: 'remote/bifrost/same-model' }, session: 'client-session' }), error => error.status === 409);
  const first = router.resolve('messages', { body }).scope;
  local.generation++;
  await assert.rejects(router.request(context, { body }), error => error.code === 'desktop_source_changed');
  assert.notEqual(router.resolve('messages', { body }).scope, first);
  assert.throws(() => router.resolve('messages', { body, session: 'client-session' }), error => error.status === 409);
});
test('duplicate source instances and aliases fail closed; status and catalog are synchronous', () => {
  const local = source('codebuddy', 'codebuddy-local');
  assert.throws(() => new ModelRouter({ secret, providers: [local, local] }));
  const router = new ModelRouter({ secret, providers: [local] });
  local.catalogSnapshot = () => [{ id: 'same', protocols: ['messages'] }, { id: 'same', protocols: ['messages'] }];
  assert.throws(() => router.models(), /Duplicate model/);
});
