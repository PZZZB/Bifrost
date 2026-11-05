// A semantic preflight contract, not authentication or a parser for vendor
// state. Only trusted adapter declarations and locally checked evidence belong
// here; catalog presence alone never establishes conversation portability.
const PROTOCOLS = new Set(['responses', 'messages', 'chat-completions']);
const STATES = ['plain-history', 'authenticated-snapshot', 'completed-checkpoint', 'live-execution'];
const OPERATIONS = ['continue', 'fork', 'switch-model', 'switch-source', 'restart-recovery'];
const STATUSES = new Set(['supported', 'conditional', 'unsupported', 'unknown']);
const REASONS = new Set(['complete-history-required', 'completed-history-can-be-copied', 'destination-must-accept-history',
  'rebuild-from-complete-history', 'full-history-import-unsupported', 'full-history-import-unconfirmed',
  'snapshot-binding-must-be-verified', 'copy-data-without-live-callbacks', 'opaque-state-needs-plaintext-handoff',
  'snapshot-and-key-must-still-be-valid', 'copyable-snapshot-unsupported', 'copyable-snapshot-unconfirmed',
  'resume-verified-completed-checkpoint', 'native-checkpoint-is-not-a-copyable-snapshot', 'only-completed-checkpoints-can-recover',
  'completed-checkpoint-unsupported', 'completed-checkpoint-unconfirmed', 'resume-the-same-live-execution',
  'live-callbacks-cannot-be-copied', 'live-execution-is-source-and-model-bound', 'live-execution-does-not-survive-process-loss',
  'live-execution-not-used', 'live-execution-unconfirmed', 'protocol-unsupported', 'protocol-unconfirmed']);
const REQUIREMENTS = new Set(['completeHistory', 'noPendingTools', 'destinationAcceptsHistory', 'verifiedStateBinding',
  'completedCheckpointAvailable', 'matchingHistoryPrefix', 'liveExecutionAvailable']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flag = value => typeof value === 'boolean' ? value : null;
const known = (value, fallback) => flag(value) ?? fallback;
const cell = (status, reason, requires = []) => ({ status, reason, requires: [...requires] });
const unavailable = reason => Object.fromEntries(OPERATIONS.map(operation => [operation, cell('unsupported', reason)]));
const unconfirmed = reason => Object.fromEntries(OPERATIONS.map(operation => [operation, cell('unknown', reason)]));
const sameState = ['verifiedStateBinding'];

function snapshotDeclaration(provider, model, protocol, declared) {
  try {
    const inspect = provider?.supportsSnapshotState;
    if (typeof inspect !== 'function') return flag(declared);
    // The provider verifies which route actually owns a copyable snapshot. A
    // model being listed, a native checkpoint, or an SDK live handle is not it.
    return flag(inspect.call(provider, model, protocol));
  } catch { return null; }
}

/** Fixed public fields only. No provider identity, endpoint, error or token is copied. */
export function createConversationCompatibility({ protocol, protocols, provider, model, adapterCapabilities = {}, declarations = {} } = {}) {
  if (!PROTOCOLS.has(protocol) || protocols !== undefined && (!Array.isArray(protocols)
    || protocols.some(value => !PROTOCOLS.has(value))) || !object(adapterCapabilities) || !object(declarations)) {
    throw new TypeError('Invalid conversation compatibility input.');
  }
  const protocolSupport = protocols === undefined ? 'unknown' : protocols.includes(protocol) ? 'supported' : 'unsupported';
  // Interpret existing transport-neutral continuation modes, not provider names.
  // Explicit adapter declarations can narrow or clarify these legacy hints.
  const replayable = adapterCapabilities.continuation === 'bridge-owned-opaque-encrypted-state';
  const liveCheckpoint = adapterCapabilities.continuation === 'live-sdk-run-and-finished-checkpoint';
  const fullHistory = known(declarations.fullHistory, replayable ? true : liveCheckpoint ? false : null);
  const liveExecution = known(declarations.liveExecution, flag(adapterCapabilities.statefulAgent) ?? (replayable ? false : null));
  const completedCheckpoint = known(declarations.completedCheckpoint,
    adapterCapabilities.restartRecovery === 'completed-sdk-checkpoints-only' ? true : null);
  const snapshotState = snapshotDeclaration(provider, model, protocol, declarations.snapshotState);
  const states = {};
  if (fullHistory === true) {
    const complete = ['completeHistory'];
    const settled = [...complete, 'noPendingTools'];
    states['plain-history'] = {
      continue: cell('conditional', 'complete-history-required', complete),
      fork: cell('conditional', 'completed-history-can-be-copied', settled),
      'switch-model': cell('conditional', 'destination-must-accept-history', [...settled, 'destinationAcceptsHistory']),
      'switch-source': cell('conditional', 'destination-must-accept-history', [...settled, 'destinationAcceptsHistory']),
      'restart-recovery': cell('conditional', 'rebuild-from-complete-history', settled),
    };
  } else states['plain-history'] = fullHistory === false ? unavailable('full-history-import-unsupported') : unconfirmed('full-history-import-unconfirmed');
  if (snapshotState === true) states['authenticated-snapshot'] = {
    continue: cell('conditional', 'snapshot-binding-must-be-verified', sameState),
    fork: cell('conditional', 'copy-data-without-live-callbacks', [...sameState, 'noPendingTools']),
    'switch-model': cell('unsupported', 'opaque-state-needs-plaintext-handoff'),
    'switch-source': cell('unsupported', 'opaque-state-needs-plaintext-handoff'),
    'restart-recovery': cell('conditional', 'snapshot-and-key-must-still-be-valid', [...sameState, 'noPendingTools']),
  };
  else states['authenticated-snapshot'] = snapshotState === false ? unavailable('copyable-snapshot-unsupported') : unconfirmed('copyable-snapshot-unconfirmed');
  if (completedCheckpoint === true) {
    const checkpoint = [...sameState, 'completedCheckpointAvailable', 'matchingHistoryPrefix'];
    states['completed-checkpoint'] = {
      continue: cell('conditional', 'resume-verified-completed-checkpoint', checkpoint),
      fork: cell('unsupported', 'native-checkpoint-is-not-a-copyable-snapshot'),
      'switch-model': cell('unsupported', 'opaque-state-needs-plaintext-handoff'),
      'switch-source': cell('unsupported', 'opaque-state-needs-plaintext-handoff'),
      'restart-recovery': cell('conditional', 'only-completed-checkpoints-can-recover', [...checkpoint, 'noPendingTools']),
    };
  } else states['completed-checkpoint'] = completedCheckpoint === false ? unavailable('completed-checkpoint-unsupported') : unconfirmed('completed-checkpoint-unconfirmed');
  if (liveExecution === true) states['live-execution'] = {
    continue: cell('conditional', 'resume-the-same-live-execution', [...sameState, 'liveExecutionAvailable', 'matchingHistoryPrefix']),
    fork: cell('unsupported', 'live-callbacks-cannot-be-copied'),
    'switch-model': cell('unsupported', 'live-execution-is-source-and-model-bound'),
    'switch-source': cell('unsupported', 'live-execution-is-source-and-model-bound'),
    'restart-recovery': cell('unsupported', 'live-execution-does-not-survive-process-loss'),
  };
  else states['live-execution'] = liveExecution === false ? unavailable('live-execution-not-used') : unconfirmed('live-execution-unconfirmed');
  if (protocolSupport !== 'supported') {
    for (const state of STATES) states[state] = protocolSupport === 'unsupported'
      ? unavailable('protocol-unsupported') : unconfirmed('protocol-unconfirmed');
  }
  return { version: 1, protocol, protocolSupport, states,
    notGuaranteed: ['native-feature-equivalence', 'cache-equivalence'] };
}

function validContract(contract) {
  return object(contract) && contract.version === 1 && PROTOCOLS.has(contract.protocol)
    && ['supported', 'unsupported', 'unknown'].includes(contract.protocolSupport)
    && object(contract.states) && STATES.every(state => object(contract.states[state])
      && OPERATIONS.every(operation => {
        const entry = contract.states[state][operation];
        return object(entry) && STATUSES.has(entry.status) && (contract.protocolSupport === 'supported' || entry.status === contract.protocolSupport)
          && REASONS.has(entry.reason) && Array.isArray(entry.requires)
          && entry.requires.length <= REQUIREMENTS.size && entry.requires.every(requirement => REQUIREMENTS.has(requirement))
          && new Set(entry.requires).size === entry.requires.length;
      }));
}

/** Evidence comes from runtime validation, never untrusted client assertions.
 * This decision does not grant model permission, authenticate state, execute a
 * handoff, or restore a live process. Existing provider checks remain required.
 */
export function evaluateConversationOperation(contract, { state, operation, evidence = {}, target } = {}) {
  if (!validContract(contract) || !STATES.includes(state) || !OPERATIONS.includes(operation) || !object(evidence)
    || target !== undefined && !validContract(target)) throw new TypeError('Invalid conversation operation.');
  const entry = contract.states[state][operation];
  const missing = [];
  for (const requirement of entry.requires) {
    const satisfied = requirement === 'destinationAcceptsHistory'
      ? target !== undefined && ['supported', 'conditional'].includes(target.states['plain-history'].continue.status)
      : evidence[requirement] === true;
    if (!satisfied) missing.push(requirement);
  }
  return { allowed: ['supported', 'conditional'].includes(entry.status) && missing.length === 0,
    status: entry.status, reason: entry.reason, requires: [...entry.requires], missing };
}
