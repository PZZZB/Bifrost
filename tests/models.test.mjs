import test from 'node:test';
import assert from 'node:assert/strict';
import { B_MODELS, mergeCatalog, resolveBModel } from '../src/models.mjs';
import { BridgeError } from '../src/storage.mjs';

function fixture() {
  const aData = {
    catalog_version: 'catalog-a',
    features: { defaults: ['original'] },
    models: [
      {
        slug: 'a-first', display_name: 'First original model', priority: 9,
        visibility: 'list', supported_in_api: false,
        supported_reasoning_levels: [{ effort: 'high', description: 'Original reasoning' }],
        model_messages: { instructions_template: 'A instructions', variables: ['original'] },
      },
      { slug: 'a-second', display_name: 'Second original model', priority: 2, context_window: 240000 },
    ],
  };
  const bData = {
    catalog_version: 'catalog-b',
    models: [
      { slug: 'b-other', display_name: 'Do not add this model', priority: 0 },
      {
        slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', priority: 1,
        visibility: 'hide', upgrade: { model: 'future-model' }, supported_in_api: false,
        context_window: 400000, max_context_window: 800000,
        supported_reasoning_levels: [{ effort: 'ultra', description: 'Full reasoning' }],
        default_reasoning_level: 'high', input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true, shell_type: 'shell_command',
        model_messages: { instructions_template: 'Astra instructions', variables: { tools: ['apply_patch'] } },
      },
      {
        slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', priority: 5,
        visibility: 'list', upgrade: null, supported_in_api: false,
        context_window: 256000, max_context_window: 512000,
        supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced reasoning' }],
        default_reasoning_level: 'medium', input_modalities: ['text'],
        supports_parallel_tool_calls: false, shell_type: 'local',
        model_messages: { instructions_template: 'Sol instructions', variables: { tools: ['read_file'] } },
      },
    ],
  };
  return { aData, bData };
}

test('only the two exact reserved aliases resolve to B models', () => {
  assert.deepEqual(B_MODELS, [
    { id: 'B-gpt-6-astra', name: 'B-GPT-6 Astra', upstream: 'gpt-6-astra' },
    { id: 'B-gpt-6.1-sol', name: 'B-GPT-6.1 Sol', upstream: 'gpt-6.1-sol' },
  ]);
  assert.equal(resolveBModel('B-gpt-6-astra'), B_MODELS[0]);
  assert.equal(resolveBModel('B-gpt-6.1-sol'), B_MODELS[1]);
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'B-gpt-6-sol', 'B-GPT-6 Astra', '', null, undefined]) {
    assert.equal(resolveBModel(model), null);
  }
});

test('catalog keeps A metadata and order, appending only the two B aliases', () => {
  const { aData, bData } = fixture();
  const merged = mergeCatalog(aData, bData);
  assert.deepEqual(merged.models.slice(0, aData.models.length), aData.models);
  assert.equal(merged.models.length, aData.models.length + 2);
  assert.deepEqual(merged.models.map((model) => model.slug), ['a-first', 'a-second', 'B-gpt-6-astra', 'B-gpt-6.1-sol']);
  assert.equal(merged.catalog_version, 'catalog-a');
  assert.deepEqual(merged.features, aData.features);
  assert.deepEqual(merged.models.slice(-2).map((model) => model.display_name), ['B-GPT-6 Astra', 'B-GPT-6.1 Sol']);
  assert.deepEqual(merged.models.slice(-2).map((model) => model.priority), [10, 11]);
});

test('B aliases retain the full upstream context, reasoning, tools, and instructions metadata', () => {
  const { aData, bData } = fixture();
  const aliases = mergeCatalog(aData, bData).models.slice(-2);
  for (const [index, alias] of aliases.entries()) {
    const source = bData.models.find((model) => model.slug === B_MODELS[index].upstream);
    const retained = structuredClone(alias);
    const original = structuredClone(source);
    for (const key of ['slug', 'display_name', 'visibility', 'upgrade', 'priority', 'supported_in_api']) {
      delete retained[key]; delete original[key];
    }
    assert.deepEqual(retained, original);
    assert.equal(alias.visibility, 'list');
    assert.equal(alias.upgrade, null);
    assert.equal(alias.supported_in_api, true);
  }
});

test('catalog merging does not mutate inputs or retain shared metadata references', () => {
  const { aData, bData } = fixture();
  const beforeA = structuredClone(aData);
  const beforeB = structuredClone(bData);
  const merged = mergeCatalog(aData, bData);
  assert.deepEqual(aData, beforeA);
  assert.deepEqual(bData, beforeB);
  merged.features.defaults.push('changed');
  merged.models[0].model_messages.variables.push('changed');
  merged.models.at(-2).model_messages.variables.tools.push('changed');
  assert.deepEqual(aData, beforeA);
  assert.deepEqual(bData, beforeB);
});

test('missing either required B upstream refuses the merge instead of inventing metadata', () => {
  for (const upstream of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const { aData, bData } = fixture();
    bData.models = bData.models.filter((model) => model.slug !== upstream);
    const before = structuredClone({ aData, bData });
    assert.throws(() => mergeCatalog(aData, bData), (error) => (
      error instanceof BridgeError && error.code === 'model_catalog_missing' && error.message.includes(upstream)
    ));
    assert.deepEqual({ aData, bData }, before);
  }
  assert.throws(() => mergeCatalog(fixture().aData, { models: [] }), BridgeError);
});

test('an existing reserved alias in A fails without replacing an original model', () => {
  for (const alias of B_MODELS) {
    for (const field of ['slug', 'id']) {
      const { aData, bData } = fixture();
      aData.models.push({ [field]: alias.id, display_name: 'Existing model' });
      const before = structuredClone(aData);
      assert.throws(() => mergeCatalog(aData, bData), (error) => (
        error instanceof BridgeError && error.code === 'model_alias_conflict' && error.status === 409
      ));
      assert.deepEqual(aData, before);
    }
  }
});

test('invalid full catalogs fail with BridgeError', () => {
  const { aData, bData } = fixture();
  for (const invalid of [null, [], {}, { models: null }, { models: {} }]) {
    assert.throws(() => mergeCatalog(invalid, bData), BridgeError);
    assert.throws(() => mergeCatalog(aData, invalid), BridgeError);
  }
});
