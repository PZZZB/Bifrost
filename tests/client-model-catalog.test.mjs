import test from 'node:test';
import assert from 'node:assert/strict';
import { publicClientModel } from '../src/client-model-catalog.mjs';

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
