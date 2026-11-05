export const MIN_CONTEXT_TOKENS = 1_000;
export const MAX_CONTEXT_TOKENS = 10_000_000;
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Source declarations are metadata, never proof that a full window was tested. */
export function contextDeclaration(source = {}, { native = false } = {}) {
  const nested = object(source.capabilities) ? source.capabilities : {};
  const raw = native ? source.context_window : source.contextWindow ?? nested.contextWindow;
  const declaredDefault = positive(raw) ? raw : positive(raw?.defaultLength) ? raw.defaultLength : null;
  const choices = source.contextWindowOptions ?? raw?.supportedLengths ?? nested.contextWindowOptions;
  const declaredOptions = Array.isArray(choices) && choices.length <= 32 && Array.from(choices).every(positive)
    ? [...new Set(choices)].sort((a, b) => a - b) : [];
  const explicitMaximum = native ? source.max_context_window : source.maxInputTokens ?? nested.maxInputTokens;
  // An explicit hard limit wins even when stale tiers still advertise more.
  // A remotely configured client budget is separate from source declarations.
  const declarations = [declaredDefault, ...declaredOptions].filter(positive);
  const maxTokens = positive(explicitMaximum) ? explicitMaximum : declarations.length ? Math.max(...declarations) : null;
  const tokens = declaredDefault === null ? null : Math.min(declaredDefault, maxTokens ?? declaredDefault);
  const client = source.clientContextWindow ?? nested.clientContextWindow;
  return { tokens, maxTokens, options: declaredOptions.filter(value => maxTokens === null || value <= maxTokens),
    ...(positive(client) ? { clientTokens: Math.min(client, maxTokens ?? client) } : {}) };
}

/** An owner can reduce the client budget, but cannot increase a declared limit. */
export function modelContextSettings(capability = {}, selectedTokens = null) {
  const declaredDefault = positive(capability.tokens) ? capability.tokens : null;
  const declaredOptions = Array.isArray(capability.options) && capability.options.length <= 32 && Array.from(capability.options).every(positive)
    ? [...new Set(capability.options)].sort((a, b) => a - b) : [];
  const declared = [declaredDefault, ...declaredOptions].filter(positive);
  const maxTokens = positive(capability.maxTokens) ? capability.maxTokens : declared.length ? Math.max(...declared) : null;
  const preferred = positive(capability.clientTokens) ? capability.clientTokens : declaredDefault;
  const defaultTokens = preferred === null ? null : Math.min(preferred, maxTokens ?? preferred);
  const options = declaredOptions.filter(value => maxTokens === null || value <= maxTokens);
  const maximumTokens = Math.min(maxTokens ?? MAX_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS);
  const valid = selectedTokens === null || Number.isSafeInteger(selectedTokens)
    && selectedTokens >= MIN_CONTEXT_TOKENS && selectedTokens <= maximumTokens;
  const effectiveTokens = valid && selectedTokens !== null ? selectedTokens : defaultTokens;
  return { defaultTokens, maxTokens, options, selectedTokens, effectiveTokens,
    minimumTokens: MIN_CONTEXT_TOKENS, maximumTokens, customAllowed: true, valid,
    note: !valid ? '已保存的预算超过当前模型声明的范围，当前采用模型默认值；请选择有效值或恢复默认。'
      : maxTokens === null ? '目录未声明模型上限；自定义值仅设置客户端预算，不代表上游支持该容量。'
        : '设置客户端上下文预算；自动压缩仍由客户端决定，实际可用容量以上游限制为准。' };
}

export function applyCodexContext(model, settings) {
  if (!settings.valid || settings.selectedTokens === null) return model;
  const result = { ...model, context_window: settings.effectiveTokens, max_context_window: settings.effectiveTokens };
  // A model's old fixed threshold must not outlive a smaller owner budget.
  // Omission/null lets the current Codex version derive its default threshold.
  if (Object.hasOwn(result, 'auto_compact_token_limit')) result.auto_compact_token_limit = null;
  return result;
}
