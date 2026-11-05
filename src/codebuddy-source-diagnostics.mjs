// Bounded failure metadata only. Neither arbitrary field names nor any field value is
// retained. Rebuild this envelope at every public or persistence boundary.
const PUBLIC_FIELDS = new Set(['role', 'content', 'tool_calls', 'refusal', 'reasoning_content',
  'name', 'arguments', 'tool_call_id', 'audio', 'reasoning', 'reasoning_details',
  'reasoning_signature', 'extra_fields', 'extra_content', 'thinking', 'signature',
  'annotations', 'function_call', 'metadata', 'content_type', 'type', 'usage', 'logprobs', 'index']);
const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined', 'unknown']);
const MAX_FIELDS = 8;
const MAX_CHILDREN = 3;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const size = value => Number.isSafeInteger(value) && value >= 0;
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

// Checks identify the adapter guard, never a provider's message or tool data.
export const CODEBUDDY_PROTOCOL_CHECKS = Object.freeze({
  sse_utf8: '流事件不是有效 UTF-8。',
  sse_event_size: '流事件超过大小限制。',
  sse_event_truncated: '流事件在完整分隔符前结束。',
  sse_json: '流事件不是有效 JSON。',
  metadata_json: '扩展接续状态无法序列化。',
  metadata_size: '扩展接续状态超过大小限制。',
  data_after_done: '流结束标记后仍有数据。',
  choices_shape: '候选回复列表格式无效。',
  choices_count: '候选回复数量超过接口限制。',
  usage_only_chunk: '无候选回复的事件缺少用量对象。',
  choice_shape: '候选回复不是对象。',
  choice_index: '候选回复索引不符合单回复接口。',
  delta_shape: '内容增量不是对象。',
  delta_after_finish: '结束原因之后仍有内容增量。',
  duplicate_finish_reason: '结束原因重复返回。',
  assistant_role: '回复角色不是 assistant。',
  assistant_refusal: '回复包含尚不能映射的拒绝内容。',
  reasoning_type: '思考增量不是文本。',
  content_type: '正文增量不是文本。',
  output_size: '累计输出超过大小限制。',
  tool_calls_type: '工具调用增量不是数组。',
  tools_forbidden: '禁止工具的请求返回了工具调用。',
  tool_call_shape: '工具调用增量不是对象。',
  tool_call_index: '工具调用索引无效或超出范围。',
  tool_call_type: '工具调用类型不是 function。',
  tool_function_shape: '工具函数增量不是对象。',
  tool_id_fragment_type: '工具调用标识增量不是文本。',
  tool_name_fragment_type: '工具名增量不是文本。',
  tool_arguments_fragment_type: '工具参数增量不是文本。',
  tool_id_size: '工具调用标识超过长度限制。',
  tool_name_size: '工具名超过长度限制。',
  tool_finish_without_calls: '工具调用结束原因未附带工具调用。',
  stop_finish_with_calls: '普通结束原因仍附带工具调用。',
  required_tool_missing: '强制工具请求没有返回工具调用。',
  tool_index_sequence: '工具调用索引不连续。',
  tool_id_invalid: '工具调用标识格式无效。',
  tool_id_duplicate: '工具调用标识重复。',
  tool_not_declared: '返回的工具名不在本次声明中。',
  forced_tool_mismatch: '返回的工具不符合本次指定工具。',
  tool_arguments_json: '工具参数不是完整 JSON。',
  tool_arguments_object: '工具参数解析后不是对象。',
  state_seal: '思考接续状态无法生成。',
  metadata_seal: '扩展接续状态无法生成。',
  compaction_incomplete: '文本摘要尚未完整结束或与原回复不一致。',
});
const OBSERVATION_COUNTS = ['length', 'count', 'limit'];

function normalizeProtocolCheck(value) {
  if (!object(value) || !own(value, 'check') || typeof value.check !== 'string'
    || !own(CODEBUDDY_PROTOCOL_CHECKS, value.check)) return null;
  const result = { version: 1, kind: 'codebuddy_protocol_check', check: value.check,
    description: CODEBUDDY_PROTOCOL_CHECKS[value.check] };
  if (own(value, 'observation') && object(value.observation)) {
    const raw = value.observation, observation = {};
    if (own(raw, 'valueType') && TYPES.has(raw.valueType)) observation.valueType = raw.valueType;
    for (const key of OBSERVATION_COUNTS) if (own(raw, key) && size(raw[key])) observation[key] = raw[key];
    if (Object.keys(observation).length) result.observation = observation;
  }
  return result;
}

/** Safe guard metadata; callers choose the check at the actual failure point. */
export function describeCodeBuddyProtocolCheck(check, observation) {
  try { return normalizeProtocolCheck({ check, observation }); }
  catch { return null; }
}

function describeField(field, value, child = false) {
  const type = typeOf(value), result = { field: PUBLIC_FIELDS.has(field) ? field : 'unknown_key',
    type: TYPES.has(type) ? type : 'unknown' };
  if (result.field === 'unknown_key') result.keyLength = field.length;
  if (type === 'string' || type === 'array') result.length = value.length;
  if (!child && field === 'function_call' && type === 'object') {
    const names = Object.keys(value);
    result.children = names.slice(0, MAX_CHILDREN).map(name => describeField(name, value[name], true));
    result.childCount = names.length;
  }
  return result;
}

/** Describe only fields already rejected by the adapter; never inspect values recursively. */
export function describeCodeBuddyDeltaFields(delta, fields) {
  try {
    if (!object(delta) || !Array.isArray(fields)) return null;
    const names = fields.slice(0, MAX_FIELDS).filter(field => typeof field === 'string' && own(delta, field));
    if (!names.length) return null;
    return { version: 1, kind: 'codebuddy_delta_shape', fieldCount: fields.length,
      fields: names.map(field => describeField(field, delta[field])) };
  } catch { return null; }
}

function normalizeField(raw, child = false) {
  if (!object(raw) || !own(raw, 'field') || typeof raw.field !== 'string' || !own(raw, 'type')) return null;
  const field = PUBLIC_FIELDS.has(raw.field) ? raw.field : 'unknown_key';
  const type = TYPES.has(raw.type) ? raw.type : 'unknown';
  const result = { field, type };
  if (field === 'unknown_key') {
    const keyLength = raw.field === 'unknown_key' && own(raw, 'keyLength') ? raw.keyLength : raw.field.length;
    if (size(keyLength)) result.keyLength = keyLength;
  }
  if (['string', 'array'].includes(type) && own(raw, 'length') && size(raw.length)) result.length = raw.length;
  if (!child && field === 'function_call' && type === 'object' && own(raw, 'children') && Array.isArray(raw.children)) {
    result.children = raw.children.slice(0, MAX_CHILDREN).map(value => normalizeField(value, true)).filter(Boolean);
    if (own(raw, 'childCount') && size(raw.childCount)) result.childCount = raw.childCount;
  }
  return result;
}

/** Unknown codes or envelope versions cannot turn provider data into diagnostics. */
export function normalizeCodeBuddySourceDiagnostics(code, value) {
  try {
    if (!object(value) || !own(value, 'version') || value.version !== 1 || !own(value, 'kind')) return null;
    if (code === 'codebuddy_upstream_protocol_error' && value.kind === 'codebuddy_protocol_check') return normalizeProtocolCheck(value);
    if (code !== 'codebuddy_unsupported_delta' || value.kind !== 'codebuddy_delta_shape'
      || !own(value, 'fields') || !Array.isArray(value.fields)) return null;
    const fields = value.fields.slice(0, MAX_FIELDS).map(field => normalizeField(field)).filter(Boolean);
    if (!fields.length) return null;
    return { version: 1, kind: 'codebuddy_delta_shape',
      ...(own(value, 'fieldCount') && size(value.fieldCount) ? { fieldCount: value.fieldCount } : {}), fields };
  } catch { return null; }
}
