import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCredential, sourceRoutes } from '../src/source-profiles.mjs';

const routes = (kind, options = {}, binding = {}) => sourceRoutes({ kind, enabled: true, binding }, {
  usable: true, capabilities: { clientIntegration: true, userManagement: true }, ...options,
});
const protocol = (rows, name) => rows.find(row => row.protocol === name);

test('caller and managed Codex use the same native protocol but separate credential ownership', () => {
  const caller = protocol(routes('codex-client'), 'responses'), managed = protocol(routes('codex'), 'responses');
  assert.equal(caller.mode, 'passthrough'); assert.equal(managed.mode, 'passthrough');
  assert.equal(caller.upstreamProtocol, managed.upstreamProtocol);
  assert.equal(caller.credentialRequirement, 'caller-openai'); assert.equal(managed.credentialRequirement, 'gateway-key');
  assert.equal(sourceCredential('codex-client').reusable, false); assert.equal(sourceCredential('codex').reusable, true);
  assert.equal(protocol(routes('codex-client'), 'chat-completions').supported, false);
});

test('the same managed Codex account requires conversion for Chat and rejects the unimplemented Messages path', () => {
  const rows = routes('codex');
  assert.equal(protocol(rows, 'responses').mode, 'passthrough');
  assert.equal(protocol(rows, 'chat-completions').mode, 'adapted');
  assert.equal(protocol(rows, 'chat-completions').upstreamProtocol, 'responses');
  assert.equal(protocol(rows, 'messages').supported, false); assert.equal(protocol(rows, 'messages').available, false);
  assert.equal(protocol(rows, 'chat-completions').verification, 'not_verified');
});

test('protocol support and live entry availability are independent, including caller-only native ingress', () => {
  const closed = routes('codex', { capabilities: { clientIntegration: true, userManagement: false } });
  assert.equal(protocol(closed, 'responses').available, true);
  assert.equal(protocol(closed, 'chat-completions').supported, true);
  assert.equal(protocol(closed, 'chat-completions').available, false);
  assert.match(protocol(closed, 'chat-completions').reason, /入口/);
  const caller = routes('codex-client', { capabilities: { userManagement: true } });
  assert.equal(protocol(caller, 'responses').supported, true); assert.equal(protocol(caller, 'responses').available, false);
  const pending = routes('codex', { usable: false });
  assert.equal(protocol(pending, 'responses').available, false); assert.match(protocol(pending, 'responses').reason, /尚未就绪/);
});

test('an enabled user portal with a failed inference listener never advertises its protocols as available', () => {
  const capabilities = { clientIntegration: true, userManagement: true, userInferenceReady: false };
  const codex = routes('codex', { capabilities });
  assert.equal(protocol(codex, 'responses').available, true);
  assert.equal(protocol(codex, 'chat-completions').supported, true);
  assert.equal(protocol(codex, 'chat-completions').available, false);
  const company = routes('codebuddy', { capabilities });
  assert.equal(protocol(company, 'messages').supported, true);
  assert.equal(protocol(company, 'messages').available, false);
  assert.match(protocol(company, 'messages').reason, /入口/);
  const dedicated = routes('codebuddy', { capabilities, metadata: { messageEntryAvailable: true } });
  assert.equal(protocol(dedicated, 'messages').available, true);
  const restored = routes('codex', { capabilities: { ...capabilities, userInferenceReady: true } });
  assert.equal(protocol(restored, 'chat-completions').available, true);
  const owner = routes('codex', { capabilities: { ...capabilities, ownerChatReady: true } });
  assert.equal(protocol(owner, 'chat-completions').available, true);
  assert.equal(protocol(owner, 'messages').available, false);
  const cli = routes('claude', { capabilities: { ...capabilities, ownerChatReady: true }, metadata: {
    supportedProtocols: ['chat-completions', 'messages'], transport: 'claude-cli',
  } });
  assert.equal(protocol(cli, 'chat-completions').supported, true);
  assert.equal(protocol(cli, 'chat-completions').available, false);
});

test('CodeBuddy and Cursor describe their actual adapters rather than infer routing from an account label', () => {
  const company = routes('codebuddy'), cursor = routes('cursor');
  for (const row of company) { assert.equal(row.supported, true); assert.equal(row.mode, 'adapted'); assert.equal(row.upstreamProtocol, 'chat-completions'); }
  assert.equal(protocol(cursor, 'responses').upstreamProtocol, 'cursor-sdk');
  assert.equal(protocol(cursor, 'messages').supported, false);
  const messages = routes('codebuddy', { capabilities: {}, metadata: { messageEntryAvailable: true } });
  assert.equal(protocol(messages, 'messages').available, true); assert.equal(protocol(messages, 'responses').available, false);
});

test('Claude declarations distinguish no configured path, a Messages-only relay and a CLI-backed Chat entry', () => {
  assert.ok(routes('claude').every(row => !row.supported && !row.available));
  const windows = routes('claude', { capabilities: {}, metadata: {
    supportedProtocols: ['messages'], transport: 'claude-cli', messageEntryAvailable: true,
  } });
  assert.equal(protocol(windows, 'messages').mode, 'cli'); assert.equal(protocol(windows, 'messages').available, true);
  assert.equal(protocol(windows, 'chat-completions').supported, false);
  const mac = routes('claude', { metadata: { supportedProtocols: ['messages', 'chat-completions'], transport: 'official-claude-sdk' } });
  assert.equal(protocol(mac, 'messages').mode, 'cli'); assert.equal(protocol(mac, 'chat-completions').mode, 'cli');
  assert.equal(protocol(mac, 'responses').supported, false);
  const native = routes('claude', { metadata: { supportedProtocols: ['messages'], transport: 'anthropic-messages' } });
  assert.equal(protocol(native, 'messages').mode, 'passthrough');
});

test('remote routing describes this node and its configured upstream interface without inventing remote internals', () => {
  const messages = routes('bifrost', {}, { protocols: ['messages', 'chat-completions'] });
  assert.equal(protocol(messages, 'responses').mode, 'adapted');
  assert.equal(protocol(messages, 'responses').upstreamProtocol, 'messages');
  assert.equal(protocol(messages, 'messages').supported, false);
  const native = routes('bifrost', {}, { protocols: ['responses'] });
  assert.equal(protocol(native, 'responses').mode, 'passthrough');
  assert.equal(protocol(native, 'chat-completions').mode, 'adapted');
  const mixed = routes('bifrost', {}, { protocols: ['responses', 'messages'] });
  assert.equal(protocol(mixed, 'responses').mode, 'unknown'); assert.equal(protocol(mixed, 'responses').upstreamProtocol, null);
  assert.equal(protocol(mixed, 'chat-completions').mode, 'adapted'); assert.equal(protocol(mixed, 'chat-completions').upstreamProtocol, null);
  assert.match(protocol(mixed, 'responses').description, /所选模型/);
  const chatOnly = routes('bifrost', {}, { protocols: ['chat-completions'] });
  assert.ok(chatOnly.every(row => !row.supported));
  assert.doesNotThrow(() => routes('claude', { metadata: null }));
});
