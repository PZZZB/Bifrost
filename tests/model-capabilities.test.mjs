import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesFromCatalog, verificationFromRecord } from '../src/model-capabilities.mjs';

test('native projection copies only explicit capability values and never treats cache flags as observed hits', () => {
  const source = { supports_tools: true, input_modalities: ['text', 'image'], context_window: 240000,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'PRIVATE_PARAMETER' }], default_reasoning_level: 'high',
    supports_prompt_cache: true, api_key: 'PRIVATE_KEY', model_messages: { instructions_template: 'PRIVATE_INSTRUCTIONS' },
    capabilities: { note: 'PRIVATE_NOTE' } };
  const result = capabilitiesFromCatalog(source, { channel: 'A' }), { capabilities } = result;
  assert.equal(capabilities.tools.support, true); assert.equal(capabilities.images.support, true);
  assert.deepEqual(capabilities.reasoning.efforts, ['low', 'high']); assert.equal(capabilities.reasoning.defaultEffort, 'high');
  assert.equal(capabilities.contextWindow.tokens, 240000); assert.equal(capabilities.cache.support, null);
  assert.equal(capabilities.tools.source, 'native-catalog'); assert.equal(result.compatibility.mode, 'passthrough');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('unknown SDK fields remain unknown and configured project rules do not promise original system priority', () => {
  const result = capabilitiesFromCatalog({ id: 'unknown-sdk-model' }, { channel: 'Cursor', promptMode: 'project-rules' });
  for (const field of ['tools', 'images', 'reasoning', 'contextWindow', 'cache']) assert.equal(result.capabilities[field].support, null);
  assert.equal(result.capabilities.contextWindow.tokens, null); assert.deepEqual(result.capabilities.reasoning.efforts, []);
  assert.equal(result.compatibility.mode, 'project-rules'); assert.match(result.compatibility.note, /不保留原 system\/developer 优先级/);
  assert.equal(result.capabilities.promptMode.source, 'bridge-configuration');
  const strict = capabilitiesFromCatalog({}, { channel: 'Cursor', promptMode: 'system' });
  assert.equal(strict.compatibility.mode, 'system'); assert.match(strict.compatibility.note, /不代表.*已获/);
  assert.equal(capabilitiesFromCatalog({}, { channel: 'Cursor' }).compatibility.mode, 'unknown');
});

test('explicit negative capabilities win over positive modalities or reasoning parameters', () => {
  const result = capabilitiesFromCatalog({ supportsImages: false, inputModalities: ['text', 'image'], supportsReasoning: false,
    capabilities: { tools: false, supportsToolCalls: true }, contextWindow: 0,
    parameters: [{ id: 'effort', values: [{ value: 'high' }, { value: 'xhigh' }] }] }, { channel: 'Cursor' });
  assert.equal(result.capabilities.images.support, false); assert.equal(result.capabilities.tools.support, false);
  assert.equal(result.capabilities.reasoning.support, false); assert.deepEqual(result.capabilities.reasoning.efforts, []);
  assert.equal(result.capabilities.contextWindow.tokens, null);
});

test('SDK exact effort values and default variants remain source values without invented aliases', () => {
  const result = capabilitiesFromCatalog({ supportsTools: true, supportsImages: true, contextWindow: 500000,
    parameters: [{ id: 'reasoning', values: [{ value: 'medium' }, { value: 'vendor-extra-high' }, { value: 'xhigh' }] }],
    variants: [{ isDefault: true, params: [{ id: 'reasoning', value: 'xhigh' }] }] }, { channel: 'Cursor', promptMode: 'system' });
  assert.deepEqual(result.capabilities.reasoning.efforts, ['medium', 'xhigh']); assert.equal(result.capabilities.reasoning.defaultEffort, 'xhigh');
  assert.equal(result.capabilities.contextWindow.tokens, 500000); assert.equal(result.capabilities.cache.support, null);
});

test('CodeBuddy source declarations and the established Opus adapter profile use distinct provenance', () => {
  const legacy = capabilitiesFromCatalog({ id: 'claude-codebuddy-opus-5-5', source: 'native-cache', supportsToolCall: true,
    inputModalities: ['text', 'image'], efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 300000 }, { channel: 'CodeBuddy' });
  assert.equal(legacy.capabilities.images.source, 'adapter-profile'); assert.equal(legacy.capabilities.tools.source, 'native-cache');
  assert.equal(legacy.capabilities.contextWindow.source, 'native-cache'); assert.equal(legacy.compatibility.mode, 'protocol-adapter');
  const generic = capabilitiesFromCatalog({ id: 'CodeBuddy-model', source: 'remote', supportsImages: false,
    inputModalities: ['text', 'image'], efforts: ['high', 'vendor-extra'], contextWindow: Number.MAX_SAFE_INTEGER }, { channel: 'CodeBuddy' });
  assert.equal(generic.capabilities.images.support, false); assert.equal(generic.capabilities.images.source, 'remote');
  assert.deepEqual(generic.capabilities.reasoning.efforts, ['high']); assert.equal(generic.capabilities.contextWindow.tokens, null);
});

test('validation records require terminal completion and expose fixed failure notes without raw diagnostics', () => {
  const time = '2026-10-23T02:00:00.000Z';
  assert.equal(verificationFromRecord({ outcome: 'passed', time }), null);
  assert.equal(verificationFromRecord({ outcome: 'passed', completed: true, pendingTools: true, time }), null);
  assert.equal(verificationFromRecord({ outcome: 'passed', completed: true, time: 'not-a-time' }), null);
  assert.equal(verificationFromRecord({ outcome: 'passed', completed: true, pendingTools: false, time, kind: 'plain' }).state, 'passed');
  const failed = verificationFromRecord({ outcome: 'failed', time, category: 'network', error: 'PRIVATE_ERROR', headers: { key: 'PRIVATE_KEY' } });
  assert.equal(failed.state, 'failed'); assert.equal(failed.category, 'network'); assert.match(failed.reason, /未据此改变模型能力/);
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
});
