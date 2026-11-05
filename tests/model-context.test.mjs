import test from 'node:test';
import assert from 'node:assert/strict';
import { contextDeclaration, modelContextSettings, applyCodexContext,
  MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS } from '../src/model-context.mjs';

test('context metadata preserves source defaults, selectable tiers and independent native limits', () => {
  const raw = { contextWindow: { defaultLength: 300000, supportedLengths: [1000000, 300000, 600000, 300000], secret: 'PRIVATE' },
    maxInputTokens: 1000000, apiKey: 'PRIVATE' };
  const before = structuredClone(raw);
  const declared = contextDeclaration(raw);
  assert.deepEqual(declared, { tokens: 300000, maxTokens: 1000000, options: [300000, 600000, 1000000] });
  assert.deepEqual(contextDeclaration({ contextWindow: 300000, contextWindowOptions: [300000, 600000, 1000000], maxInputTokens: 1000000 }), declared);
  assert.deepEqual(raw, before); assert.doesNotMatch(JSON.stringify(declared), /PRIVATE|apiKey|secret/);
  assert.deepEqual(contextDeclaration({ context_window: 272000, max_context_window: 1000000,
    contextWindow: 32000, maxInputTokens: 64000 }, { native: true }), { tokens: 272000, maxTokens: 1000000, options: [] });
  assert.deepEqual(contextDeclaration({ capabilities: { contextWindow: 1000000, maxInputTokens: 1000000 } }),
    { tokens: 1000000, maxTokens: 1000000, options: [] });
});

test('an advertised maximum does not invent a model default or a tested context window', () => {
  assert.deepEqual(contextDeclaration({ maxInputTokens: 1000000 }), { tokens: null, maxTokens: 1000000, options: [] });
  assert.deepEqual(contextDeclaration({}), { tokens: null, maxTokens: null, options: [] });
  const settings = modelContextSettings({}, 1000000);
  assert.equal(settings.valid, true); assert.equal(settings.defaultTokens, null); assert.equal(settings.maxTokens, null);
  assert.equal(settings.effectiveTokens, 1000000); assert.match(settings.note, /未声明/);
});

test('a forwarded client budget remains separate from source capacity and is bounded by a declared maximum', () => {
  assert.deepEqual(contextDeclaration({ capabilities: { clientContextWindow: 1000000 } }),
    { tokens: null, maxTokens: null, options: [], clientTokens: 1000000 });
  const declared = contextDeclaration({ capabilities: { contextWindow: 300000, clientContextWindow: 1000000, maxInputTokens: 500000 } });
  assert.deepEqual(declared, { tokens: 300000, maxTokens: 500000, options: [], clientTokens: 500000 });
  const settings = modelContextSettings({ tokens: 300000, maxTokens: 1000000, clientTokens: 600000 });
  assert.equal(settings.defaultTokens, 600000); assert.equal(settings.effectiveTokens, 600000);
  assert.equal(settings.maxTokens, 1000000); assert.equal(settings.selectedTokens, null);
});

test('invalid context option arrays cannot partially publish a private or malformed tier', () => {
  const invalid = [[300000, 'PRIVATE'], [300000, 1.5], [300000, 0], [300000, 1000000001],
    [300000, undefined], [300000, ...new Array(1)], Array.from({ length: 33 }, () => 300000)];
  for (const options of invalid) {
    assert.deepEqual(contextDeclaration({ contextWindow: { defaultLength: 300000, supportedLengths: options } }),
      { tokens: 300000, maxTokens: 300000, options: [] });
    const settings = modelContextSettings({ tokens: 300000, options });
    assert.deepEqual(settings.options, []); assert.equal(settings.defaultTokens, 300000);
  }
});

test('custom client budgets can fall between upstream tiers but cannot exceed a known limit', () => {
  const source = { tokens: 300000, maxTokens: 1000000, options: [300000, 600000, 1000000] };
  const selected = modelContextSettings(source, 450000);
  assert.equal(selected.valid, true); assert.equal(selected.effectiveTokens, 450000);
  assert.equal(selected.defaultTokens, 300000); assert.equal(selected.maxTokens, 1000000);
  for (const tokens of [MIN_CONTEXT_TOKENS - 1, -1, 0, 450000.5, Number.NaN, Number.POSITIVE_INFINITY,
    '600000', true, {}, 1000001]) {
    const settings = modelContextSettings(source, tokens);
    assert.equal(settings.valid, false); assert.equal(settings.effectiveTokens, 300000);
  }
  assert.equal(modelContextSettings(source, MIN_CONTEXT_TOKENS).valid, true);
  assert.equal(modelContextSettings({}, MAX_CONTEXT_TOKENS).valid, true);
  assert.equal(modelContextSettings({}, MAX_CONTEXT_TOKENS + 1).valid, false);
  const restored = modelContextSettings(source, null);
  assert.equal(restored.valid, true); assert.equal(restored.effectiveTokens, 300000);
});

test('a shrinking source limit invalidates a saved budget and falls back without silently rewriting the selection', () => {
  const settings = modelContextSettings({ tokens: 128000, maxTokens: 256000, options: [128000, 256000] }, 1000000);
  assert.equal(settings.valid, false); assert.equal(settings.selectedTokens, 1000000);
  assert.equal(settings.effectiveTokens, 128000); assert.equal(settings.maximumTokens, 256000);
  assert.match(settings.note, /默认/);
});

test('an explicit source maximum overrides stale larger tiers and an oversized default', () => {
  const staleOptions = [300000, 600000, 1000000];
  const source = contextDeclaration({ contextWindow: 300000, contextWindowOptions: staleOptions, maxInputTokens: 500000 });
  assert.deepEqual(source, { tokens: 300000, maxTokens: 500000, options: [300000] });
  const selected = modelContextSettings({ tokens: 300000, maxTokens: 500000, options: staleOptions }, 1000000);
  assert.equal(selected.valid, false); assert.equal(selected.selectedTokens, 1000000);
  assert.equal(selected.effectiveTokens, 300000); assert.equal(selected.maxTokens, 500000);
  assert.deepEqual(selected.options, [300000]);
  assert.equal(modelContextSettings(source, 450000).valid, true);

  const oversized = contextDeclaration({ contextWindow: 900000, contextWindowOptions: staleOptions, maxInputTokens: 500000 });
  assert.ok(oversized.tokens > 0 && oversized.tokens <= 500000);
  assert.equal(oversized.maxTokens, 500000); assert.deepEqual(oversized.options, [300000]);
  const defaults = modelContextSettings({ tokens: 900000, maxTokens: 500000, options: staleOptions });
  assert.ok(defaults.effectiveTokens > 0 && defaults.effectiveTokens <= 500000);
});

test('Codex context overrides clear stale fixed compaction thresholds while defaults preserve native metadata', () => {
  const native = { slug: 'native', context_window: 272000, max_context_window: 1000000,
    auto_compact_token_limit: 250000, effective_context_window_percent: 95,
    model_messages: { instructions_template: 'Preserve source instructions' } };
  const before = structuredClone(native);
  const source = { tokens: 272000, maxTokens: 1000000 };
  assert.deepEqual(applyCodexContext(native, modelContextSettings(source)), before);
  assert.deepEqual(applyCodexContext(native, modelContextSettings(source, 1000001)), before);
  const selected = applyCodexContext(native, modelContextSettings(source, 128000));
  assert.equal(selected.context_window, 128000); assert.equal(selected.max_context_window, 128000);
  assert.equal(selected.auto_compact_token_limit, null); assert.equal(selected.effective_context_window_percent, 95);
  assert.deepEqual(selected.model_messages, native.model_messages); assert.deepEqual(native, before);
  assert.equal(Object.hasOwn(applyCodexContext({ slug: 'no-fixed-threshold' }, modelContextSettings(source, 128000)),
    'auto_compact_token_limit'), false);
});
