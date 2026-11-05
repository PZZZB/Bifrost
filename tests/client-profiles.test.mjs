import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRegistry } from '../src/clients/registry.mjs';
import { codexClient, codexProviderConfig, codexConfigArgs, codexConfigText } from '../src/clients/codex.mjs';
import { modelCapabilities } from '../src/routing/model-capabilities.mjs';
import { resolveCodexBinary } from '../src/clients/codex-binary.mjs';
import { publicClientModel } from '../src/client-model-catalog.mjs';

const models = [{ id: 'local/codebuddy/CodeBuddy-one', name: '本地 · CodeBuddy · One', protocols: ['responses', 'chat-completions'],
  source: { id: 'codebuddy', location: 'local' }, capabilities: { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', contextWindow: 128000, inputModalities: ['text', 'image'] } },
{ id: 'remote/bifrost/Claude-sonnet', name: '远端 · Bifrost · Claude', protocols: ['responses', 'messages'], source: { id: 'bifrost', location: 'remote' } },
{ id: 'remote/chat-only/model', protocols: ['chat-completions'] }];

test('Codex catalogs preserve route IDs and source limits while enabling native client tools', () => {
  const clients = new ClientRegistry([codexClient]);
  const catalog = clients.catalog('codex', models, new URLSearchParams('client_version=0.163.0-alpha.11.2'));
  assert.deepEqual(catalog.models.map(model => model.slug), models.slice(0, 2).map(model => model.id));
  assert.equal(catalog.models[0].display_name, models[0].name);
  assert.equal(catalog.models[0].default_reasoning_level, 'high'); assert.equal(catalog.models[0].context_window, 128000);
  assert.equal(catalog.models[1].default_reasoning_level, null); assert.deepEqual(catalog.models[1].supported_reasoning_levels, []);
  assert.deepEqual(catalog.models[1].input_modalities, ['text']);
  for (const model of catalog.models) {
    assert.equal(model.apply_patch_tool_type, 'freeform');
    assert.equal(model.multi_agent_version, 'v2');
    assert.equal(model.tool_mode, 'direct');
  }
  for (const query of ['target=https://attacker.test', 'client_version=a&client_version=b', 'client_version=bad%0Aversion']) {
    assert.throws(() => clients.catalog('codex', models, new URLSearchParams(query)), error => error.status === 400);
  }
  assert.throws(() => clients.catalog('unknown', models), error => error.status === 404);
});

test('Codex catalogs retain remote million-token declarations and selected public client budgets', () => {
  const remote = { id: 'remote/bifrost/Claude-opus', name: 'Remote Opus', protocols: ['responses'],
    capabilities: { contextWindow: 1000000, inputModalities: ['text', 'image'] } };
  const selected = publicClientModel({ id: 'claude-codebuddy-opus-5-5', name: 'Opus', protocols: ['responses'],
    capabilities: { contextWindow: { support: true, tokens: 300000, maxTokens: 1000000, options: [300000, 600000, 1000000] } },
    contextSettings: { valid: true, selectedTokens: 600000, effectiveTokens: 600000 } });
  const input = [remote, selected], before = structuredClone(input), catalog = codexClient.catalog(input);
  assert.deepEqual(catalog.models.map(model => [model.context_window, model.max_context_window]), [[1000000, 1000000], [600000, 600000]]);
  assert.ok(catalog.models.every(model => model.effective_context_window_percent === 90));
  assert.deepEqual(input, before);
});

test('Codex remote catalogs honor explicit input maxima even when a default or tier list is stale', () => {
  const catalog = codexClient.catalog([
    { id: 'remote/bifrost/oversized-default', capabilities: { contextWindow: 900000,
      contextWindowOptions: [300000, 600000, 1000000], maxInputTokens: 500000 } },
    { id: 'remote/bifrost/unknown-default', capabilities: { maxInputTokens: 16000 } },
  ]);
  for (const [index, model] of catalog.models.entries()) {
    const maximum = index === 0 ? 500000 : 16000;
    assert.ok(model.context_window > 0 && model.context_window <= maximum);
    assert.ok(model.max_context_window > 0 && model.max_context_window <= maximum);
  }
});
test('a new client catalog can register independently without changing the router or existing Codex format', () => {
  const generic = { id: 'fixture-chat', name: 'Fixture Chat', protocols: ['chat-completions'], query: {}, catalog: models => ({ data: models.map(model => ({ id: model.id })) }) };
  const clients = new ClientRegistry([codexClient, generic]);
  assert.deepEqual(clients.catalog('fixture-chat', models).data.map(model => model.id), [models[0].id, models[2].id]);
  assert.deepEqual(clients.catalog('codex', models).models.map(model => model.slug), models.slice(0, 2).map(model => model.id));
  assert.throws(() => new ClientRegistry([generic, generic]));
});
test('Codex config keeps secrets out of files and argv, uses a fixed loopback provider, and disables inference retries', () => {
  const tokenCommand = { command: 'C:\\Node\\node.exe', args: ['C:\\Bifrost\\scripts\\desktop.mjs', 'key', '--state-dir', 'C:\\private'] };
  const config = codexProviderConfig({ baseUrl: 'http://127.0.0.1:43160/v1', tokenCommand });
  assert.equal(config['model_providers.bifrost_desktop.auth.command'], tokenCommand.command);
  assert.equal(config['model_providers.bifrost_desktop.env_key'], undefined);
  assert.equal(config['model_providers.bifrost_desktop.requires_openai_auth'], undefined);
  assert.equal(config['model_providers.bifrost_desktop.request_max_retries'], 0); assert.equal(config['model_providers.bifrost_desktop.stream_max_retries'], 0);
  assert.equal(config['model_providers.bifrost_desktop.model_catalog_url'], 'http://127.0.0.1:43160/clients/codex/models');
  assert.ok(codexConfigArgs(config).every(value => typeof value === 'string'));
  assert.doesNotMatch(codexConfigText(config), /bdk_|bfk_|api_key|approval_policy|sandbox_mode/);
  for (const baseUrl of ['https://mac.test/v1', 'http://0.0.0.0:43160/v1', 'http://127.0.0.1:43160/v1?target=x']) assert.throws(() => codexProviderConfig({ baseUrl }));
});
test('capabilities never carry private source metadata or invented reasoning/image guarantees', () => {
  assert.deepEqual(modelCapabilities({ apiKey: 'secret', baseUrl: 'private-host', inputModalities: ['text', 'video'],
    reasoningEfforts: ['high', 'made-up'], defaultReasoningEffort: 'made-up' }), { inputModalities: ['text'], reasoningEfforts: ['high'] });
});
test('Windows launch resolves a native executable without sending credentials through shell arguments', async () => {
  const path = await resolveCodexBinary({ platform: 'win32', execFileImpl(file, args, options, done) {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-Command codex/); assert.match(script, /CODEX_BINARY/); assert.match(script, /codex\.exe/);
    assert.doesNotMatch(script, /bdk_|bfk_|Bearer|desktop\.mjs key/); assert.equal(options.windowsHide, true);
    done(null, 'C:\\Tools with spaces\\codex.exe');
  } });
  assert.equal(path, 'C:\\Tools with spaces\\codex.exe');
  await assert.rejects(resolveCodexBinary({ platform: 'win32', execFileImpl(_file, _args, _options, done) { done(null, 'codex.cmd'); } }));
});
