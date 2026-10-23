import test from 'node:test';
import assert from 'node:assert/strict';
import { startMessagesService } from '../src/messages-service.mjs';
import { WithGateway } from '../src/with-gateway.mjs';

const model = { id: 'claude-codebuddy-opus-5-5', name: 'Offline CodeBuddy' };
const provider = { status: async () => ({ authenticated: true, ready: true, modelAvailable: true }),
  request() { throw new Error('Provider inference is forbidden in this wiring test.'); } };
const gatewayKey = 'independent-offline-diagnostics-wiring-key-long-enough';

test('generic and legacy Messages service construction preserve the diagnostic callback and account generation getter', async () => {
  const onDiagnostic = () => {}, getAuthorizationVersion = () => 9;
  let legacyOptions, genericOptions;
  const legacy = {};
  assert.equal(await startMessagesService({ stateDir: 'unused-offline-state', onDiagnostic, getAuthorizationVersion,
    readConfigImpl: async (_path, fallback) => fallback,
    startLegacyImpl(options) { legacyOptions = options; return legacy; } }), legacy);
  assert.equal(legacyOptions.onDiagnostic, onDiagnostic); assert.equal(legacyOptions.getAuthorizationVersion, getAuthorizationVersion);
  const service = await startMessagesService({ stateDir: 'unused-offline-state', onDiagnostic, getAuthorizationVersion,
    codeBuddyProvider: provider, codeBuddyModel: model, codeBuddyEnabled: true, listenImpl: async () => {},
    readConfigImpl: async () => ({ version: 1, gatewayKey,
      listener: { address: '127.0.0.1', port: 54321, allowedHosts: ['127.0.0.1:54321'], allowedPeers: ['127.0.0.1'] },
      routes: [{ account: 'CodeBuddy', provider: 'codebuddy', model }] }),
    createServerImpl(options) { genericOptions = options; return { close(callback) { callback(); } }; } });
  assert.equal(genericOptions.onDiagnostic, onDiagnostic); assert.equal(genericOptions.getAuthorizationVersion, getAuthorizationVersion);
  await service.close();
});

test('the legacy With gateway passes diagnostic and authorization hooks into its shared Anthropic implementation', () => {
  const onDiagnostic = () => {}, getAuthorizationVersion = () => 4;
  const gateway = new WithGateway({ withEnabled: false, gatewayKey, additionalRoutes: [{ account: 'CodeBuddy', model, provider }],
    onDiagnostic, getAuthorizationVersion });
  assert.equal(gateway.onDiagnostic, onDiagnostic); assert.equal(gateway.getAuthorizationVersion, getAuthorizationVersion);
  assert.equal(gateway.getAuthorizationVersion('CodeBuddy'), 4);
});
