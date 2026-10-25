import { modelCapabilities } from '../routing/model-capabilities.mjs';

const instructions = 'You are a coding assistant. Follow the user instructions and use the client tools when needed. '
  + 'Respect the configured sandbox, permissions and approval requirements. '
  + 'Hosted web search is unavailable. Use only the tools provided by the client; never claim a tool action that was not executed.';

/** Codex-native view of the same route IDs; no Codex concepts enter the core registry. */
export const codexClient = Object.freeze({ id: 'codex', name: 'Codex', protocols: ['responses'], binaryEnv: 'CODEX_BINARY',
  async resolveBinary() { return (await import('./codex-binary.mjs')).resolveCodexBinary(); },
  query: { client_version: /^[A-Za-z0-9.+_-]{1,80}$/ },
  configuration(options) {
    const config = codexProviderConfig(options);
    return { command: 'codex', args: codexConfigArgs(config), text: codexConfigText(config) };
  },
  catalog(models) {
    return { models: models.map((model, priority) => {
      const capability = modelCapabilities(model.capabilities);
      const context = Math.min(capability.contextWindow ?? 32_000, 200_000);
      return { slug: model.id, display_name: model.name || model.id,
        description: `${model.source?.location === 'local' ? '公司额度' : '远端 Bifrost 用户额度'} · ${model.source?.id || 'Bifrost'}。客户端执行工具；不支持托管搜索。`,
        visibility: 'list', supported_in_api: true, priority,
        default_reasoning_level: capability.defaultReasoningEffort ?? null,
        supported_reasoning_levels: (capability.reasoningEfforts ?? []).map(effort => ({ effort, description: effort })),
        base_instructions: instructions, model_messages: { instructions_template: instructions },
        shell_type: 'shell_command', context_window: context, max_context_window: context, effective_context_window_percent: 90,
        input_modalities: capability.inputModalities?.length ? capability.inputModalities : ['text'],
        supports_reasoning_summary_parameter: capability.reasoningSummaries === true, default_reasoning_summary: 'none',
        supports_parallel_tool_calls: capability.parallelToolCalls === true,
        additional_speed_tiers: [], service_tiers: [], default_service_tier: null,
        available_access_programs: null, availability_nux: null, upgrade: null,
        include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
        support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null, web_search_tool_type: 'text',
        truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false,
        experimental_supported_tools: [], supports_search_tool: true, supports_experimental_context: false,
        use_responses_lite: false, supports_reasoning_effort_updates: false, prefer_websockets: false,
        tool_mode: 'direct', multi_agent_version: null };
    }) };
  } });

export function codexProviderConfig({ baseUrl, tokenCommand, model } = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password) throw new TypeError('Codex must point to the Desktop loopback endpoint.');
  const root = 'model_providers.bifrost_desktop';
  const values = { model_provider: 'bifrost_desktop', [`${root}.name`]: 'Bifrost Desktop', [`${root}.base_url`]: baseUrl,
    [`${root}.wire_api`]: 'responses', [`${root}.model_catalog_url`]: `${url.origin}/clients/codex/models`,
    [`${root}.supports_websockets`]: false, [`${root}.request_max_retries`]: 0, [`${root}.stream_max_retries`]: 0 };
  if (model) values.model = model;
  if (tokenCommand) {
    if (typeof tokenCommand.command !== 'string' || !tokenCommand.command || !Array.isArray(tokenCommand.args) || tokenCommand.args.some(value => typeof value !== 'string')) throw new TypeError('Invalid local token command.');
    values[`${root}.auth.command`] = tokenCommand.command; values[`${root}.auth.args`] = tokenCommand.args;
    values[`${root}.auth.timeout_ms`] = 20_000; values[`${root}.auth.refresh_interval_ms`] = 0;
  } else {
    values[`${root}.env_key`] = 'BIFROST_DESKTOP_API_KEY'; values[`${root}.requires_openai_auth`] = false;
  }
  return values;
}
export const codexConfigArgs = values => Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
export const codexConfigText = values => Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n';
