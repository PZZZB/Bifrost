export const CODEBUDDY_MODEL = Object.freeze({ id: 'claude-codebuddy-opus-5-5', name: 'CodeBuddy · Opus 5.5' });
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:[\]/-]{0,255}$/;
const sourceId = value => typeof value === 'string' && SOURCE_ID.test(value) && !value.includes('..');
const EFFORT = /^[A-Za-z0-9_-]{1,64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const contextOptions = value => Array.isArray(value) && value.length > 0 && value.length <= 32
  && Array.from(value).every(positive) ? [...new Set(value)].sort((a, b) => a - b) : null;
const specialized = Object.freeze({ 'completion-gf': '此条目用于代码补全，尚未适配文本工具对话。',
  'codewise-rewrite': '此条目用于代码重写，尚未适配文本工具对话。',
  'codewise-jump': '此条目用于代码跳转，尚未适配文本工具对话。',
  'default-image-generation': '此条目用于图像生成，尚未适配文本工具对话。' });
const reasons = Object.freeze({ disabled: '账号目录标记此模型不可用。',
  text: '账号目录明确未提供文本输入，尚不能用于 Codex 工具对话。',
  tools: '账号目录明确不支持工具调用，尚不能用于 Codex 工具对话。',
  ambiguous: '目录存在重复或多个 Opus 5.5 候选，已停止自动选择。' });

export function isCodeBuddyOpus55(source) {
  const opus = value => typeof value === 'string' && /^(?:claude)?(?:opus55|55opus)$/.test(value.toLowerCase().replace(/[\s._-]+/g, ''));
  return object(source) && (opus(source.id) || opus(source.name));
}

/** Parse bridge aliases only. Account membership is checked by the provider. */
export function resolveCodeBuddyAlias(id) {
  if (id === CODEBUDDY_MODEL.id) return { id, upstream: null };
  if (typeof id !== 'string' || !id.startsWith('CodeBuddy-')) return null;
  const upstream = id.slice('CodeBuddy-'.length);
  return sourceId(upstream) ? { id, upstream } : null;
}

function capabilities(source) {
  const result = {};
  for (const field of ['supportsToolCall', 'supportsReasoning']) if (typeof source[field] === 'boolean') result[field] = source[field];
  if (source.supportsImages === false || source.disabledMultimodal === true) result.supportsImages = false;
  else if (source.supportsImages === true) result.supportsImages = true;
  if (Array.isArray(source.inputModalities) && source.inputModalities.length <= 8 && source.inputModalities.every(value => ['text', 'image', 'audio', 'video'].includes(value))) {
    result.inputModalities = [...new Set(source.inputModalities)];
  } else if (typeof result.supportsImages === 'boolean') result.inputModalities = result.supportsImages ? ['text', 'image'] : ['text'];
  if (result.supportsImages === false && result.inputModalities) result.inputModalities = result.inputModalities.filter(value => value !== 'image');
  const reasoning = object(source.reasoning) ? source.reasoning : {};
  const efforts = reasoning.supportedEfforts ?? source.efforts;
  if (Array.isArray(efforts) && efforts.length <= 32 && efforts.every(value => typeof value === 'string' && EFFORT.test(value))) result.efforts = [...new Set(efforts)];
  if (result.efforts?.includes(reasoning.defaultEffort ?? source.defaultEffort)) result.defaultEffort = reasoning.defaultEffort ?? source.defaultEffort;
  if (reasoning.summary === 'auto' || source.supportsReasoningSummary === true) result.supportsReasoningSummary = true;
  if (typeof reasoning.canDisableThinking === 'boolean') result.canDisableThinking = reasoning.canDisableThinking;
  const context = positive(source.contextWindow) ? source.contextWindow : source.contextWindow?.defaultLength;
  if (positive(context)) result.contextWindow = context;
  const options = contextOptions(object(source.contextWindow) ? source.contextWindow.supportedLengths : source.contextWindowOptions);
  if (options) result.contextWindowOptions = options;
  for (const field of ['maxInputTokens', 'maxOutputTokens']) if (positive(source[field])) result[field] = source[field];
  return result;
}

/** Construct a bounded public descriptor from explicit account catalog metadata. */
export function codeBuddyModelAlias(source, { legacyOpus = true, ambiguous = false } = {}) {
  if (!object(source) || !sourceId(source.id)) return null;
  const legacy = legacyOpus && isCodeBuddyOpus55(source);
  const id = legacy ? CODEBUDDY_MODEL.id : `CodeBuddy-${source.id}`;
  const reason = ambiguous ? reasons.ambiguous
    : Object.hasOwn(specialized, source.id) ? specialized[source.id]
      : source.disabled === true || source.available === false || source.enabled === false || source.error || source.disabledReason ? reasons.disabled
        : Array.isArray(source.inputModalities) && !source.inputModalities.includes('text') ? reasons.text
          : source.supportsToolCall === false ? reasons.tools : null;
  const result = { id, name: legacy ? CODEBUDDY_MODEL.name : `CodeBuddy · ${text(source.name) ? source.name : source.id}`,
    upstream: source.id, available: reason === null, reason, ...capabilities(source) };
  if (legacy) {
    // This is the existing, separately adapted Opus 5.5 route. Do not extend
    // its compatibility settings to other models based on their names.
    result.efforts = ['low', 'medium', 'high', 'xhigh']; result.defaultEffort = 'high';
    result.inputModalities = ['text', 'image']; result.supportsImages = true; result.supportsReasoning = true;
    result.supportsReasoningSummary = true;
  }
  return result;
}

/** Recheck already mapped descriptors before exposing an injected provider. */
export function publicCodeBuddyModel(value) {
  if (!object(value) || !resolveCodeBuddyAlias(value.id) || !sourceId(value.upstream) || !text(value.name, 280)) return null;
  const alias = resolveCodeBuddyAlias(value.id);
  if (alias.upstream !== null && alias.upstream !== value.upstream) return null;
  const reason = value.available === true ? null : [...Object.values(reasons), ...Object.values(specialized)].includes(value.reason) ? value.reason : reasons.disabled;
  return { id: value.id, name: value.name, upstream: value.upstream, available: value.available === true, reason, ...capabilities(value),
    ...(['remote', 'native-cache'].includes(value.source) ? { source: value.source } : {}) };
}
