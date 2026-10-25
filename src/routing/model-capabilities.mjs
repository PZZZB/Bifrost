const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
/** A source-owned, data-only capability description; never contains credentials or endpoints. */
export function modelCapabilities(value = {}) {
  const result = {};
  for (const field of ['contextWindow', 'maxOutputTokens']) if (Number.isSafeInteger(value[field]) && value[field] > 0 && value[field] <= 10_000_000) result[field] = value[field];
  if (Array.isArray(value.inputModalities)) result.inputModalities = [...new Set(value.inputModalities.filter(item => ['text', 'image'].includes(item)))];
  if (Array.isArray(value.reasoningEfforts)) result.reasoningEfforts = [...new Set(value.reasoningEfforts.filter(item => EFFORTS.has(item)))];
  if (result.reasoningEfforts?.includes(value.defaultReasoningEffort)) result.defaultReasoningEffort = value.defaultReasoningEffort;
  for (const field of ['parallelToolCalls', 'reasoningSummaries']) if (typeof value[field] === 'boolean') result[field] = value[field];
  return result;
}
