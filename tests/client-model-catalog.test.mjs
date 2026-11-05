import test from 'node:test';
import assert from 'node:assert/strict';
import { publicClientModel } from '../src/client-model-catalog.mjs';
import { capabilitiesFromCatalog } from '../src/model-capabilities.mjs';
import { contextDeclaration } from '../src/model-context.mjs';

test('public discovery carries safe names and capabilities without source credentials or identity', () => {
  const model = publicClientModel({ id: 'Claude-sonnet', name: 'Claude Sonnet', protocols: ['chat-completions'], email: 'PRIVATE',
    capabilities: { contextWindow: { support: true, tokens: 1000000 }, tools: { adapterSupport: true }, images: { support: true },
      reasoning: { support: true, efforts: ['low', 'high'] }, apiKey: 'PRIVATE' } });
  assert.equal(model.capabilities.contextWindow, 1000000);
  assert.equal(model.capabilities.toolCalls, true);
  assert.equal(model.capabilities.parallelToolCalls, undefined);
  assert.deepEqual(model.capabilities.inputModalities, ['text', 'image']);
  assert.doesNotMatch(JSON.stringify(model), /PRIVATE|apiKey|email/);
});

test('public discovery publishes a selected budget while keeping upstream defaults and supported tiers separate', () => {
  const source = { id: 'claude-codebuddy-opus-5-5', name: 'Opus', protocols: ['responses'],
    capabilities: { contextWindow: { support: true, tokens: 300000, maxTokens: 1000000, options: [300000, 600000, 1000000] } },
    contextSettings: { valid: true, defaultTokens: 300000, selectedTokens: 1000000, effectiveTokens: 1000000,
      apiKey: 'PRIVATE_CONTEXT' } };
  const before = structuredClone(source), publicModel = publicClientModel(source);
  assert.equal(publicModel.capabilities.contextWindow, 300000); assert.equal(publicModel.capabilities.clientContextWindow, 1000000);
  assert.equal(publicModel.capabilities.maxInputTokens, 1000000);
  assert.deepEqual(publicModel.capabilities.contextWindowOptions, [300000, 600000, 1000000]);
  assert.deepEqual(source, before); assert.doesNotMatch(JSON.stringify(publicModel), /PRIVATE_CONTEXT|contextSettings|selectedTokens/);

  const restored = publicClientModel({ ...source, contextSettings: { valid: true, selectedTokens: null, effectiveTokens: 300000 } });
  assert.equal(restored.capabilities.contextWindow, 300000);
  const narrowed = publicClientModel({ ...source,
    capabilities: { contextWindow: { support: true, tokens: 128000, maxTokens: 256000, options: [128000, 256000] } },
    contextSettings: { valid: false, selectedTokens: 1000000, effectiveTokens: 128000 } });
  assert.equal(narrowed.capabilities.contextWindow, 128000); assert.equal(narrowed.capabilities.maxInputTokens, 256000);
});

test('public discovery never re-expands an explicit maximum from stale context metadata', () => {
  const model = publicClientModel({ id: 'remote/bifrost/oversized-default', protocols: ['responses'],
    capabilities: capabilitiesFromCatalog({ contextWindow: 900000, contextWindowOptions: [300000, 600000, 1000000],
      maxInputTokens: 500000 }, { channel: 'Bifrost' }).capabilities });
  assert.ok(model.capabilities.contextWindow > 0 && model.capabilities.contextWindow <= 500000);
  assert.equal(model.capabilities.maxInputTokens, 500000);
  assert.deepEqual(model.capabilities.contextWindowOptions, [300000]);
});

test('an unknown source with an owner budget remains unknown through public discovery and context decoding', () => {
  const model = publicClientModel({ id: 'remote/bifrost/unknown-window', protocols: ['responses'],
    capabilities: { contextWindow: { support: null, tokens: null, maxTokens: null, options: [] } },
    contextSettings: { valid: true, selectedTokens: 1000000, effectiveTokens: 1000000 } });
  assert.equal(Object.hasOwn(model.capabilities, 'contextWindow'), false);
  assert.equal(Object.hasOwn(model.capabilities, 'maxInputTokens'), false);
  assert.equal(model.capabilities.clientContextWindow, 1000000);
  assert.deepEqual(contextDeclaration(model), { tokens: null, maxTokens: null, options: [], clientTokens: 1000000 });
});

test('a maximum-only source keeps its hard limit without inventing a default window', () => {
  const model = publicClientModel({ id: 'remote/bifrost/maximum-only', protocols: ['responses'],
    capabilities: capabilitiesFromCatalog({ maxInputTokens: 500000 }, { channel: 'Bifrost' }).capabilities });
  assert.equal(Object.hasOwn(model.capabilities, 'contextWindow'), false);
  assert.equal(model.capabilities.maxInputTokens, 500000);
  assert.deepEqual(contextDeclaration(model), { tokens: null, maxTokens: 500000, options: [] });
});
