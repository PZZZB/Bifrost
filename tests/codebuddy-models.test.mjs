import test from 'node:test';
import assert from 'node:assert/strict';
import { codeBuddyModelAlias, resolveCodeBuddyAlias, publicCodeBuddyModel, CODEBUDDY_MODEL } from '../src/codebuddy-models.mjs';

test('CodeBuddy aliases parse exact syntax without claiming account membership', () => {
  assert.deepEqual(resolveCodeBuddyAlias(CODEBUDDY_MODEL.id), { id: CODEBUDDY_MODEL.id, upstream: null });
  assert.deepEqual(resolveCodeBuddyAlias('CodeBuddy-vendor/model-v1'), { id: 'CodeBuddy-vendor/model-v1', upstream: 'vendor/model-v1' });
  for (const value of [null, {}, '', 'CodeBuddy-', 'codebuddy-gpt-6', 'CodeBuddy-../secret', 'CodeBuddy-a?token=secret', 'CodeBuddy-a\n', 'CodeBuddy-' + 'a'.repeat(257)]) assert.equal(resolveCodeBuddyAlias(value), null);
});

test('complete descriptors preserve explicit capabilities and never export arbitrary fields', () => {
  const value = codeBuddyModelAlias({ id: 'gpt-6-astra', name: 'GPT-6-Astra', supportsImages: true, supportsToolCall: true,
    supportsReasoning: true, reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', summary: 'auto', secret: 'PRIVATE' },
    contextWindow: { defaultLength: 300000, secret: 'PRIVATE' }, maxInputTokens: 290000, maxOutputTokens: 32000,
    apiKey: 'PRIVATE', headers: { Authorization: 'PRIVATE' }, disabledReason: false });
  assert.equal(value.id, 'CodeBuddy-gpt-6-astra'); assert.equal(value.upstream, 'gpt-6-astra'); assert.equal(value.available, true);
  assert.deepEqual(value.efforts, ['low', 'high', 'max']); assert.deepEqual(value.inputModalities, ['text', 'image']);
  assert.equal(value.contextWindow, 300000); assert.equal(value.maxOutputTokens, 32000);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  const minimal = codeBuddyModelAlias({ id: 'unknown-capabilities', name: 'Unknown' });
  for (const field of ['efforts', 'inputModalities', 'contextWindow', 'supportsToolCall', 'supportsReasoning']) assert.equal(Object.hasOwn(minimal, field), false);
});

test('specialized and explicitly disabled models remain visible with fixed safe reasons', () => {
  for (const id of ['completion-gf', 'codewise-rewrite', 'codewise-jump', 'default-image-generation']) {
    const value = codeBuddyModelAlias({ id, name: id }); assert.equal(value.available, false); assert.match(value.reason, /尚未适配/);
  }
  for (const extra of [{ disabled: true }, { available: false }, { enabled: false }, { error: { secret: 'PRIVATE' } }, { supportsToolCall: false }]) {
    const value = codeBuddyModelAlias({ id: 'disabled-model', name: 'Disabled', ...extra });
    assert.equal(value.available, false); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  }
});

test('explicit image denials override conflicting positive modality metadata', () => {
  for (const negative of [{ supportsImages: false }, { disabledMultimodal: true }, { supportsImages: true, disabledMultimodal: true }]) {
    const value = codeBuddyModelAlias({ id: 'text-only', name: 'Text only', inputModalities: ['text', 'image'], ...negative });
    assert.equal(value.supportsImages, false); assert.deepEqual(value.inputModalities, ['text']);
    assert.deepEqual(publicCodeBuddyModel({ ...value, inputModalities: ['text', 'image'] }).inputModalities, ['text']);
  }
});

test('legacy Opus keeps its original alias while public descriptors revalidate alias and provenance', () => {
  const value = { ...codeBuddyModelAlias({ id: 'employee-opus-route', name: 'Claude Opus 5.5' }), source: 'native-cache', token: 'PRIVATE' };
  assert.equal(value.id, CODEBUDDY_MODEL.id); assert.deepEqual(value.efforts, ['low', 'medium', 'high', 'xhigh']);
  const publicValue = publicCodeBuddyModel(value); assert.equal(publicValue.source, 'native-cache'); assert.equal(JSON.stringify(publicValue).includes('PRIVATE'), false);
  assert.equal(publicCodeBuddyModel({ ...value, id: 'CodeBuddy-another-model' }), null);
  for (const source of [{}, { id: null }, { id: '../secret' }]) assert.equal(codeBuddyModelAlias(source), null);
});
