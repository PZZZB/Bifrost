import { BridgeError } from './storage.mjs';
import { CODEBUDDY_MODEL } from './codebuddy-provider.mjs';
import { CODEBUDDY_EFFORTS } from './codebuddy-thinking.mjs';
import { CURSOR_MODELS, resolveCursorModel, cursorEffortParameter, cursorImageCapability, cursorModelAvailability } from './cursor-service.mjs';
import { resolveCodeBuddyAlias } from './codebuddy-models.mjs';
import { contextDeclaration } from './model-context.mjs';

// Retain the original two default selections and their public IDs.
export const B_MODELS = [
  { id: 'B-gpt-6-astra', name: 'B-GPT-6 Astra', upstream: 'gpt-6-astra' },
  { id: 'B-gpt-6.1-sol', name: 'B-GPT-6.1 Sol', upstream: 'gpt-6.1-sol' },
];

const B_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const bSourceId = value => typeof value === 'string' && B_SOURCE_ID.test(value) && !value.includes('..')
  && !/^(?:bfk_|bfs_|bfi_|bfn_|bdk_|sk-|rt_|oat_|oaist|eyJ|bearer)/i.test(value);

/** Parse bridge aliases only. The caller must verify current account membership. */
export function resolveBModel(model) {
  const legacy = B_MODELS.find(({ id }) => id === model);
  if (legacy) return legacy;
  if (typeof model !== 'string' || !model.startsWith('B-')) return null;
  const upstream = model.slice(2);
  return bSourceId(upstream) ? { id: model, name: model, upstream } : null;
}

export const CODEBUDDY_CODEX_MODEL = Object.freeze({
  id: CODEBUDDY_MODEL.id, name: 'CodeBuddy Opus 5.5',
});

export function resolveCodeBuddyModel(model) {
  return model === CODEBUDDY_CODEX_MODEL.id ? CODEBUDDY_CODEX_MODEL : resolveCodeBuddyAlias(model);
}

const codeBuddyInstructions = 'You are a coding assistant. Follow the user\'s instructions and use available tools when needed. '
  + 'Respect the configured tool permissions, approval requirements, and sandbox restrictions. '
  + 'OpenAI hosted web search is unavailable. Use only the client tools provided in this request. '
  + 'Do not claim to have browsed the web unless an available client tool actually retrieved the information.';
const effortDescriptions = {
  low: 'Lighter reasoning for straightforward tasks',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Deeper reasoning for complex tasks',
  xhigh: 'Extra high reasoning for difficult tasks',
};

function requireCatalog(data, account) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.models)) {
    throw new BridgeError(`账户 ${account} 未返回有效的 Codex 模型目录。`, 502, 'invalid_model_catalog');
  }
}

/** Clone the complete B directory; this supplies metadata, not model authorization. */
export function bCatalogModels(bData) {
  requireCatalog(bData, 'B');
  if (bData.models.length > 512) {
    throw new BridgeError('账户 B 的 Codex 模型目录超过大小限制。', 502, 'invalid_model_catalog');
  }
  const seen = new Set();
  return Array.from(bData.models, (source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !bSourceId(source.slug)
      || seen.has(source.slug)) {
      throw new BridgeError('账户 B 的 Codex 模型目录包含无效或重复模型。', 502, 'invalid_model_catalog');
    }
    seen.add(source.slug);
    if (source.priority !== undefined && (!Number.isInteger(source.priority)
      || source.priority < -2147483648 || source.priority > 2147483647)) {
      throw new BridgeError('账户 B 的 Codex 模型目录包含无效优先级。', 502, 'invalid_model_catalog');
    }
    let copy;
    try { copy = structuredClone(source); }
    catch { throw new BridgeError('账户 B 未返回有效的 Codex 模型元数据。', 502, 'invalid_model_catalog'); }
    const name = typeof source.display_name === 'string' && source.display_name.trim()
      && source.display_name.length <= 510 && !/[\x00-\x1f\x7f]/.test(source.display_name)
      ? source.display_name.trim() : source.slug;
    return { ...copy, slug: `B-${source.slug}`, display_name: `B-${name}`,
      visibility: 'list', upgrade: null, supported_in_api: true,
      priority: source.priority ?? index, available: source.available !== false };
  });
}

export function mergeCatalog(aData, bData) {
  requireCatalog(aData, 'A');
  const models = bCatalogModels(bData);

  for (const model of aData.models) {
    const conflict = [model?.slug, model?.id].find(value => resolveBModel(value));
    if (conflict) {
      throw new BridgeError(`账户 A 的模型目录包含保留别名 ${conflict}，无法安全合并。`, 409, 'model_alias_conflict');
    }
  }

  const lastPriority = aData.models.reduce((maximum, model) => (
    typeof model?.priority === 'number' && Number.isFinite(model.priority)
      ? Math.max(maximum, model.priority)
      : maximum
  ), aData.models.length - 1);

  if (models.length && (!Number.isInteger(lastPriority) || lastPriority + models.length > 2147483647)) {
    throw new BridgeError('模型目录无法为账户 B 分配有效的末尾优先级。', 502, 'invalid_model_catalog');
  }
  // The native picker orders by priority. Stable sorting preserves source order
  // for equal priorities before assigning this account one continuous range.
  const aliases = models.sort((a, b) => a.priority - b.priority)
    .map((model, index) => ({ ...model, priority: lastPriority + index + 1 }));

  const merged = structuredClone(aData);
  merged.models.push(...aliases);
  return merged;
}

/** Append an independently defined external model without inheriting GPT metadata. */
export function appendCodeBuddyModel(data) {
  requireCatalog(data, 'A');
  const { id, name } = CODEBUDDY_CODEX_MODEL;
  if (data.models.some(model => model?.slug === id || model?.id === id)) {
    throw new BridgeError(`模型目录包含保留别名 ${id}，无法安全追加 CodeBuddy。`, 409, 'model_alias_conflict');
  }
  const priority = data.models.reduce((maximum, model) => (
    typeof model?.priority === 'number' && Number.isFinite(model.priority)
      ? Math.max(maximum, model.priority) : maximum
  ), data.models.length - 1) + 1;
  if (!Number.isInteger(priority) || priority > 2147483647) {
    throw new BridgeError('模型目录无法为 CodeBuddy 分配有效的末尾优先级。', 502, 'invalid_model_catalog');
  }
  const result = structuredClone(data);
  result.models.push({
    slug: id,
    display_name: name,
    description: 'Claude Opus 5.5 through CodeBuddy with client tools and client tool discovery. OpenAI hosted web search is unavailable.',
    default_reasoning_level: 'high',
    supported_reasoning_levels: CODEBUDDY_EFFORTS.map(effort => ({ effort, description: effortDescriptions[effort] })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    available_access_programs: null,
    availability_nux: null,
    upgrade: null,
    // Current and legacy Codex catalog parsers both require an instruction template.
    // Keep this model neutral instead of copying another provider's prompt or policy.
    base_instructions: codeBuddyInstructions,
    model_messages: { instructions_template: codeBuddyInstructions },
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    // These tools run in Codex, not at the model provider. Omitting these
    // declarations removes native patch editing and collaboration tools.
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_image_detail_original: false,
    // Fallback only when no current account metadata is available. Discovered
    // models use their own default window without a fixed bridge ceiling.
    context_window: 200000,
    max_context_window: 200000,
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_parallel_tool_calls: true,
    // This flag enables client-side tool discovery, not hosted web search.
    supports_search_tool: true,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
    prefer_websockets: false,
    tool_mode: 'direct',
    multi_agent_version: 'v2',
  });
  return result;
}

const knownEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const publicName = (value, fallback) => typeof value === 'string' && value.trim() && value.length <= 512
  && !/[\x00-\x1f\x7f]/.test(value) ? value : fallback;
function nextPriority(models, label) {
  const priority = models.reduce((maximum, model) => Number.isFinite(model?.priority)
    ? Math.max(maximum, model.priority) : maximum, models.length - 1) + 1;
  if (!Number.isInteger(priority) || priority > 2147483647) {
    throw new BridgeError(`模型目录无法为 ${label} 分配有效的末尾优先级。`, 502, 'invalid_model_catalog');
  }
  return priority;
}
function checkAlias(models, id, label) {
  if (models.some(model => model?.slug === id || model?.id === id)) {
    throw new BridgeError(`模型目录包含保留别名 ${id}，无法安全追加 ${label}。`, 409, 'model_alias_conflict');
  }
}

/** Publish every usable account model; unsupported catalog entries remain visible in management. */
export function appendCodeBuddyModels(data, sources) {
  requireCatalog(data, 'A');
  if (!Array.isArray(sources) || sources.length > 512) throw new BridgeError('CodeBuddy 未返回有效的账号模型目录。', 502, 'invalid_model_catalog');
  const result = structuredClone(data), seen = new Set();
  for (const source of sources) {
    const alias = resolveCodeBuddyModel(source?.id);
    if (!alias || seen.has(alias.id)) throw new BridgeError('CodeBuddy 目录含无效或重复模型。', 502, 'invalid_model_catalog');
    seen.add(alias.id);
    checkAlias(result.models, alias.id, 'CodeBuddy');
    if (source.available === false) continue;
    const value = appendCodeBuddyModel({ models: [] }).models[0];
    const legacy = alias.id === CODEBUDDY_CODEX_MODEL.id;
    const efforts = [...new Set((source.efforts ?? (legacy ? CODEBUDDY_EFFORTS : []))
      .filter(effort => knownEfforts.has(effort)))];
    const preferred = source.defaultEffort ?? (legacy ? 'high' : null);
    const context = contextDeclaration(source), fallback = legacy ? 200000 : 128000;
    const contextWindow = context.clientTokens ?? context.tokens ?? Math.min(fallback, context.maxTokens ?? fallback);
    Object.assign(value, { slug: alias.id, display_name: publicName(source.name, alias.id),
      description: 'CodeBuddy account model with Codex client tools. OpenAI hosted web search is unavailable.'
        + (efforts.length ? '' : ' Uses upstream default reasoning; Codex effort levels do not apply.'),
      priority: nextPriority(result.models, 'CodeBuddy'),
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: effortDescriptions[effort] ?? `CodeBuddy ${effort}` })),
      default_reasoning_level: efforts.includes(preferred) ? preferred : null,
      context_window: contextWindow, max_context_window: contextWindow,
      input_modalities: source.supportsImages !== false && (source.inputModalities?.includes('image') || legacy && source.inputModalities === undefined) ? ['text', 'image'] : ['text'],
      supports_parallel_tool_calls: source.supportsParallelToolCalls === true || legacy,
    });
    result.models.push(value);
  }
  return result;
}

/** Append the complete account SDK catalog in its original order. */
export function appendCursorModels(data, sdkSourceModels) {
  requireCatalog(data, 'A');
  if (!Array.isArray(sdkSourceModels) || sdkSourceModels.length > 512) throw new BridgeError('Cursor 未返回有效的 SDK 模型目录。', 502, 'invalid_model_catalog');
  const result = structuredClone(data), seen = new Set();
  for (const source of sdkSourceModels) {
    const alias = typeof source?.id === 'string' ? resolveCursorModel(`Cursor-${source.id}`) : null;
    if (!alias || seen.has(alias.id)) throw new BridgeError('Cursor SDK 模型目录包含无效或重复模型。', 502, 'invalid_model_catalog');
    seen.add(alias.id);
    const { id, upstream } = alias;
    const name = source.displayName ? `Cursor ${publicName(source.displayName, upstream)}`
      : CURSOR_MODELS.find(model => model.id === id)?.name ?? `Cursor ${upstream}`;
    checkAlias(result.models, id, 'Cursor');
    if (!cursorModelAvailability(source).available) continue;
    const priority = nextPriority(result.models, 'Cursor'), parameter = cursorEffortParameter(source);
    const images = cursorImageCapability(source);
    const efforts = [...new Set((parameter?.values ?? []).map(item => item.value).filter(value => knownEfforts.has(value)))];
    const preferred = source.variants?.find(variant => variant.isDefault)?.params?.find(item => item.id === parameter?.id)?.value;
    const context = contextDeclaration(source);
    const contextWindow = context.clientTokens ?? context.tokens ?? Math.min(128000, context.maxTokens ?? 128000);
    const instructions = 'You are a coding assistant using the Cursor Agent SDK. Follow the user instructions and configured tool permissions. '
      + 'Use only the provided client tools and client tool discovery. OpenAI hosted web search is unavailable. '
      + 'Do not claim to have browsed the web unless a client tool retrieved the information. '
      + 'Ask questions through an available client question tool. Native Cursor approval requests cannot be forwarded.';
    result.models.push({
      slug: id, display_name: name,
      description: parameter ? 'Cursor Agent SDK with account-advertised reasoning values and Codex client tools.'
        : 'Cursor Agent SDK with Codex client tools. Uses Cursor default reasoning; Codex effort levels do not apply.',
      default_reasoning_level: efforts.includes(preferred) ? preferred : null,
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: `Cursor SDK ${effort}` })),
      shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority,
      additional_speed_tiers: [], service_tiers: [], default_service_tier: null,
      available_access_programs: null, availability_nux: null, upgrade: null,
      base_instructions: instructions, model_messages: { instructions_template: instructions },
      include_skills_usage_instructions: true, include_plugin_usage_instructions: true, include_apps_usage_instructions: true,
      supports_reasoning_summary_parameter: false, default_reasoning_summary: 'none',
      support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false,
      // Prefer an explicit account declaration. Unknown SDK windows keep a fallback budget.
      context_window: contextWindow, max_context_window: contextWindow, effective_context_window_percent: 90,
      experimental_supported_tools: [],
      // The SDK's public model list omits per-model image capabilities. Preserve
      // that unknown value: Codex defaults an omitted modality list to text/image,
      // allowing the SDK image path without inventing a source declaration.
      ...(images === null ? {} : { input_modalities: images ? ['text', 'image'] : ['text'] }),
      supports_parallel_tool_calls: false,
      supports_search_tool: true, supports_experimental_context: false, use_responses_lite: false,
      supports_reasoning_effort_updates: false, prefer_websockets: false, tool_mode: 'direct', multi_agent_version: 'v2',
    });
  }
  return result;
}
