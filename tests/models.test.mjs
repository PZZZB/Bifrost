import test from 'node:test';
import assert from 'node:assert/strict';
import { B_MODELS, CODEBUDDY_CODEX_MODEL, appendCodeBuddyModel, mergeCatalog, resolveBModel, resolveCodeBuddyModel } from '../src/models.mjs';
import { BridgeError } from '../src/storage.mjs';
import { CODEBUDDY_MODEL } from '../src/codebuddy-provider.mjs';
import { CODEBUDDY_EFFORTS } from '../src/codebuddy-thinking.mjs';

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

test('only the CodeBuddy wire id resolves to the external model', () => {
  assert.equal(CODEBUDDY_CODEX_MODEL.id, CODEBUDDY_MODEL.id);
  assert.equal(CODEBUDDY_CODEX_MODEL.name, 'CodeBuddy Opus 5.5');
  assert.equal(resolveCodeBuddyModel(CODEBUDDY_MODEL.id), CODEBUDDY_CODEX_MODEL);
  for (const model of ['claude-opus-5.5', 'CodeBuddy Opus 5.5', 'CLAUDE-CODEBUDDY-OPUS-5-5', 'gpt-6-astra', '', null, undefined]) {
    assert.equal(resolveCodeBuddyModel(model), null);
  }
});

test('CodeBuddy appends after original A models and B aliases without changing their metadata or order', () => {
  const { aData, bData } = fixture();
  const existing = mergeCatalog(aData, bData);
  const before = structuredClone(existing);
  const result = appendCodeBuddyModel(existing);
  assert.deepEqual(result.models.slice(0, -1), existing.models);
  assert.equal(result.models.at(-1).slug, CODEBUDDY_MODEL.id);
  assert.equal(result.models.at(-1).display_name, 'CodeBuddy Opus 5.5');
  assert.equal(result.models.at(-1).priority, 12);
  assert.equal(result.catalog_version, existing.catalog_version);
  assert.deepEqual(result.features, existing.features);
  result.features.defaults.push('changed');
  result.models[0].model_messages.variables.push('changed');
  result.models.at(-2).model_messages.variables.tools.push('changed');
  assert.deepEqual(existing, before);
});

test('CodeBuddy can append to A alone when B is unavailable or to an empty valid catalog', () => {
  const { aData } = fixture();
  const result = appendCodeBuddyModel(aData);
  assert.deepEqual(result.models.slice(0, -1), aData.models);
  assert.equal(result.models.at(-1).priority, 10);
  assert.deepEqual(appendCodeBuddyModel({ models: [] }).models.map(model => [model.slug, model.priority]), [[CODEBUDDY_MODEL.id, 0]]);
});

test('CodeBuddy declares the adapter capabilities and does not inherit GPT-specific hints or policies', () => {
  const { aData } = fixture();
  Object.assign(aData.models[0], {
    guardian: { shell: 'gpt-only-policy' },
    experimental_supported_tools: ['gpt-only-tool'],
    additional_speed_tiers: ['fast'],
    comp_hash: 'gpt-only-compaction',
    model_specialty: 'gpt-only-specialty',
    multi_agent_version: 'v2',
    auto_review_model_override: 'gpt-only-reviewer',
  });
  const model = appendCodeBuddyModel(aData).models.at(-1);
  assert.deepEqual(model.supported_reasoning_levels.map(({ effort }) => effort), CODEBUDDY_EFFORTS);
  assert.equal(model.default_reasoning_level, 'high');
  assert.deepEqual(model.input_modalities, ['text', 'image']);
  assert.equal(model.supports_parallel_tool_calls, true);
  assert.equal(model.tool_mode, 'direct');
  assert.equal(model.context_window, 200000);
  assert.equal(model.max_context_window, 200000);
  assert.equal(model.supports_search_tool, true);
  assert.equal(model.supports_experimental_context, false);
  assert.equal(model.supports_reasoning_effort_updates, false);
  assert.equal(model.supports_reasoning_summary_parameter, false);
  assert.equal(model.default_reasoning_summary, 'none');
  assert.equal(model.support_verbosity, false);
  assert.deepEqual(model.experimental_supported_tools, []);
  assert.deepEqual(model.additional_speed_tiers, []);
  assert.equal(model.multi_agent_version, null);
  assert.equal(model.upgrade, null);
  assert.equal(model.availability_nux, null);
  for (const key of ['guardian', 'comp_hash', 'model_specialty', 'auto_review_model_override']) {
    assert.equal(Object.hasOwn(model, key), false);
  }
  assert.equal(typeof model.base_instructions, 'string');
  assert.ok(model.base_instructions.length > 0);
  assert.equal(model.model_messages.instructions_template, model.base_instructions);
  assert.match(model.description, /client tools/);
  assert.match(model.description, /client tool discovery/);
  assert.match(model.description, /OpenAI hosted web search is unavailable/);
  assert.match(model.base_instructions, /OpenAI hosted web search is unavailable/);
  assert.match(model.base_instructions, /Use only the client tools provided/);
  assert.match(model.base_instructions, /Do not claim to have browsed the web/);
  assert.equal(JSON.stringify(model).includes('gpt-only'), false);
  assert.equal(model.base_instructions.includes('A instructions'), false);
});

test('a reserved CodeBuddy alias conflict leaves the existing catalog untouched', () => {
  for (const field of ['slug', 'id']) {
    const { aData } = fixture();
    aData.models.push({ [field]: CODEBUDDY_MODEL.id, display_name: 'Existing model' });
    const before = structuredClone(aData);
    assert.throws(() => appendCodeBuddyModel(aData), error => (
      error instanceof BridgeError && error.code === 'model_alias_conflict' && error.status === 409
    ));
    assert.deepEqual(aData, before);
  }
});

test('CodeBuddy rejects invalid catalogs or an unrepresentable trailing priority before any mutation', () => {
  for (const data of [null, [], {}, { models: null }, { models: {} },
    { models: [{ slug: 'existing', priority: 2147483647 }] },
    { models: [{ slug: 'existing', priority: 2.5 }] }]) {
    const before = structuredClone(data);
    assert.throws(() => appendCodeBuddyModel(data), error => error instanceof BridgeError && error.code === 'invalid_model_catalog');
    assert.deepEqual(data, before);
  }
});
