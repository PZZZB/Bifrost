import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationCompatibility, evaluateConversationOperation } from '../src/protocols/conversation-compatibility.mjs';
import { CODEBUDDY_RESPONSES_CAPABILITIES } from '../src/codebuddy-responses.mjs';
import { CURSOR_RESPONSES_CAPABILITIES } from '../src/cursor-responses.mjs';
import { BifrostRemote } from '../src/providers/bifrost-remote.mjs';

const route = { protocol: 'responses', protocols: ['responses'] };
const declare = declarations => createConversationCompatibility({ ...route, declarations });
const allEvidence = { completeHistory: true, noPendingTools: true, verifiedStateBinding: true,
  completedCheckpointAvailable: true, matchingHistoryPrefix: true, liveExecutionAvailable: true };
const evaluate = (contract, state, operation, options = {}) => evaluateConversationOperation(contract, { state, operation, ...options });

test('a listed protocol and arbitrary positive model flags never imply conversation portability', () => {
  const contract = createConversationCompatibility({ ...route, model: 'MODEL_PRIVATE_NAME', adapterCapabilities: {
    images: true, clientTools: true, contextWindow: 1_000_000, ready: true, authenticated: true,
    apiKey: 'PRIVATE_API_KEY', endpoint: 'https://private.invalid',
  } });
  assert.equal(contract.protocolSupport, 'supported');
  for (const [state, operations] of Object.entries(contract.states)) for (const operation of Object.keys(operations)) {
    const decision = evaluate(contract, state, operation, { evidence: allEvidence, target: declare({ fullHistory: true }) });
    assert.equal(decision.allowed, false); assert.equal(decision.status, 'unknown');
  }
  assert.doesNotMatch(JSON.stringify(contract), /PRIVATE|private\.invalid|apiKey|endpoint|MODEL_PRIVATE_NAME/);
  assert.deepEqual(contract.notGuaranteed, ['native-feature-equivalence', 'cache-equivalence']);
});

test('an unsupported or unconfirmed protocol cannot inherit positive state declarations', () => {
  for (const [protocols, status] of [[['messages'], 'unsupported'], [undefined, 'unknown']]) {
    const contract = createConversationCompatibility({ protocol: 'responses', protocols,
      declarations: { fullHistory: true, liveExecution: true, snapshotState: true, completedCheckpoint: true } });
    for (const state of Object.keys(contract.states)) {
      const decision = evaluate(contract, state, 'continue', { evidence: allEvidence });
      assert.equal(decision.status, status); assert.equal(decision.allowed, false);
    }
  }
});

test('CodeBuddy replay declares complete history without promoting it to a copyable snapshot or live process', () => {
  const contract = createConversationCompatibility({ ...route, adapterCapabilities: CODEBUDDY_RESPONSES_CAPABILITIES });
  assert.deepEqual(evaluate(contract, 'plain-history', 'continue').missing, ['completeHistory']);
  assert.equal(evaluate(contract, 'plain-history', 'continue', { evidence: { completeHistory: true } }).allowed, true);
  const fork = evaluate(contract, 'plain-history', 'fork', { evidence: { completeHistory: true } });
  assert.equal(fork.allowed, false); assert.deepEqual(fork.missing, ['noPendingTools']);
  assert.equal(evaluate(contract, 'plain-history', 'fork', { evidence: allEvidence }).allowed, true);
  assert.equal(evaluate(contract, 'authenticated-snapshot', 'fork', { evidence: allEvidence }).status, 'unknown');
  assert.equal(evaluate(contract, 'live-execution', 'continue', { evidence: allEvidence }).status, 'unsupported');
});

test('plain history switches require a real destination contract rather than a claimed evidence flag', () => {
  const source = declare({ fullHistory: true });
  for (const operation of ['switch-model', 'switch-source']) {
    const claimed = evaluate(source, 'plain-history', operation, { evidence: { ...allEvidence, destinationAcceptsHistory: true } });
    assert.equal(claimed.allowed, false); assert.deepEqual(claimed.missing, ['destinationAcceptsHistory']);
    const accepted = evaluate(source, 'plain-history', operation, { evidence: allEvidence, target: declare({ fullHistory: true }) });
    assert.equal(accepted.allowed, true);
    for (const target of [declare({ fullHistory: false }), declare({})]) {
      assert.equal(evaluate(source, 'plain-history', operation, { evidence: allEvidence, target }).allowed, false);
    }
  }
});

test('Cursor live execution and completed checkpoints have different restart and fork boundaries', () => {
  const contract = createConversationCompatibility({ ...route, adapterCapabilities: CURSOR_RESPONSES_CAPABILITIES });
  assert.equal(evaluate(contract, 'plain-history', 'continue', { evidence: allEvidence }).status, 'unsupported');
  assert.equal(evaluate(contract, 'authenticated-snapshot', 'fork', { evidence: allEvidence }).status, 'unknown');
  const live = evaluate(contract, 'live-execution', 'continue', { evidence: { ...allEvidence, liveExecutionAvailable: false } });
  assert.equal(live.allowed, false); assert.deepEqual(live.missing, ['liveExecutionAvailable']);
  assert.equal(evaluate(contract, 'live-execution', 'continue', { evidence: allEvidence }).allowed, true);
  for (const operation of ['fork', 'switch-model', 'switch-source', 'restart-recovery']) {
    assert.equal(evaluate(contract, 'live-execution', operation, { evidence: allEvidence, target: declare({ fullHistory: true }) }).allowed, false);
  }
  const recovered = evaluate(contract, 'completed-checkpoint', 'restart-recovery', { evidence: allEvidence });
  assert.equal(recovered.allowed, true);
  assert.equal(evaluate(contract, 'completed-checkpoint', 'restart-recovery', {
    evidence: { ...allEvidence, completedCheckpointAvailable: false },
  }).allowed, false);
  assert.equal(evaluate(contract, 'completed-checkpoint', 'fork', { evidence: allEvidence }).allowed, false);
});

test('copyable snapshots require the current provider declaration and locally verified binding', () => {
  const calls = [];
  const provider = { supportsSnapshotState(model, protocol) { calls.push({ receiver: this, model, protocol }); return model === 'snapshot-model' && protocol === 'responses'; },
    status() { assert.fail('Status must not be queried'); }, request() { assert.fail('Inference must never be called'); } };
  const contract = createConversationCompatibility({ ...route, provider, model: 'snapshot-model' });
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, provider);
  assert.deepEqual([calls[0].model, calls[0].protocol], ['snapshot-model', 'responses']);
  assert.equal(evaluate(contract, 'authenticated-snapshot', 'continue').allowed, false);
  assert.equal(evaluate(contract, 'authenticated-snapshot', 'continue', { evidence: { verifiedStateBinding: true } }).allowed, true);
  assert.deepEqual(evaluate(contract, 'authenticated-snapshot', 'fork', { evidence: { verifiedStateBinding: true } }).missing, ['noPendingTools']);
  assert.equal(evaluate(contract, 'authenticated-snapshot', 'fork', { evidence: allEvidence }).allowed, true);
  for (const operation of ['switch-model', 'switch-source']) {
    const decision = evaluate(contract, 'authenticated-snapshot', operation, { evidence: allEvidence, target: declare({ fullHistory: true }) });
    assert.equal(decision.allowed, false); assert.equal(decision.reason, 'opaque-state-needs-plaintext-handoff');
  }
});

test('a provider denial beats fallback snapshot metadata; failing declarations remain unknown', () => {
  const denied = createConversationCompatibility({ ...route, model: 'same-model', declarations: { snapshotState: true },
    provider: { supportsSnapshotState: () => false } });
  assert.equal(evaluate(denied, 'authenticated-snapshot', 'continue', { evidence: allEvidence }).status, 'unsupported');
  for (const provider of [
    { supportsSnapshotState() { throw new Error('PRIVATE_PROVIDER_ERROR'); } },
    { get supportsSnapshotState() { throw new Error('PRIVATE_PROVIDER_ERROR'); } },
    { supportsSnapshotState: () => 'true' },
    { supportsSnapshotState: () => ({ supported: true }) },
    { supportsSnapshotState: () => Promise.resolve(true) },
  ]) {
    const contract = createConversationCompatibility({ ...route, provider, declarations: { snapshotState: true } });
    const decision = evaluate(contract, 'authenticated-snapshot', 'continue', { evidence: allEvidence });
    assert.equal(decision.status, 'unknown'); assert.equal(decision.allowed, false);
    assert.equal(JSON.stringify(contract).includes('PRIVATE_PROVIDER_ERROR'), false);
  }
});

test('BifrostRemote snapshot support follows the actual Responses-via-Messages path rather than a source label', async t => {
  const paths = [], key = 'bfk_' + 'x'.repeat(43);
  const provider = new BifrostRemote({ baseUrl: 'https://snapshot-fixture.invalid/v1', apiKey: key,
    protocols: ['responses', 'messages'], stateSecret: 'snapshot-fixture-state-secret-'.repeat(3),
    fetchImpl: async (url, options) => {
      paths.push(new URL(url).pathname); assert.equal(options.method ?? 'GET', 'GET');
      return Response.json({ data: [{ id: 'adapted', protocols: ['messages'] }, { id: 'native', protocols: ['responses'] }] });
    } });
  t.after(() => provider.close());
  await provider.refreshCatalog();
  for (const [model, expected] of [['adapted', 'conditional'], ['native', 'unsupported'], ['missing', 'unsupported']]) {
    const contract = createConversationCompatibility({ ...route, provider, model });
    assert.equal(evaluate(contract, 'authenticated-snapshot', 'fork', { evidence: allEvidence }).status, expected);
    assert.equal(JSON.stringify(contract).includes(key), false);
  }
  assert.deepEqual(paths, ['/v1/models'], 'No login, health or model inference is needed to inspect this declaration.');
  await provider.close();
  const closed = createConversationCompatibility({ ...route, provider, model: 'adapted' });
  assert.equal(evaluate(closed, 'authenticated-snapshot', 'continue', { evidence: allEvidence }).status, 'unsupported');
});

test('explicit declarations can narrow hints and evidence requires literal true without mutating contracts', () => {
  const contract = createConversationCompatibility({ ...route, adapterCapabilities: CODEBUDDY_RESPONSES_CAPABILITIES,
    declarations: { fullHistory: false } });
  assert.equal(evaluate(contract, 'plain-history', 'continue', { evidence: allEvidence }).allowed, false);
  for (const fullHistory of [1, 'true', {}, null]) {
    assert.equal(evaluate(declare({ fullHistory }), 'plain-history', 'continue', { evidence: allEvidence }).status, 'unknown');
  }
  const complete = declare({ fullHistory: true }), before = structuredClone(complete);
  for (const evidence of [{ completeHistory: 1 }, { completeHistory: 'true' }, { completeHistory: false }]) {
    assert.equal(evaluate(complete, 'plain-history', 'continue', { evidence }).allowed, false);
  }
  const result = evaluate(complete, 'plain-history', 'continue'); result.requires.push('MUTATED'); result.missing.length = 0;
  assert.deepEqual(complete, before);
});

test('invalid contract fields fail with fixed messages rather than reflecting arbitrary requirements or errors', () => {
  for (const options of [{}, { protocol: 'private-protocol' }, { ...route, protocols: 'responses' }, { ...route, declarations: [] }]) {
    assert.throws(() => createConversationCompatibility(options), /^TypeError: Invalid conversation compatibility input\.$/);
  }
  const contract = declare({ fullHistory: true });
  for (const options of [{ state: 'private-state', operation: 'fork' }, { state: 'plain-history', operation: 'private-operation' },
    { state: 'plain-history', operation: 'continue', target: {} }]) {
    assert.throws(() => evaluateConversationOperation(contract, options), /^TypeError: Invalid conversation operation\.$/);
  }
  for (const edit of [entry => { entry.reason = 'PRIVATE_REASON'; }, entry => { entry.requires = ['PRIVATE_REQUIREMENT']; }]) {
    const malformed = structuredClone(contract); edit(malformed.states['plain-history'].continue);
    assert.throws(() => evaluate(malformed, 'plain-history', 'continue'), /^TypeError: Invalid conversation operation\.$/);
  }
  const contradictory = structuredClone(contract); contradictory.protocolSupport = 'unsupported';
  assert.throws(() => evaluate(contradictory, 'plain-history', 'continue', { evidence: allEvidence }), /^TypeError: Invalid conversation operation\.$/);
});
