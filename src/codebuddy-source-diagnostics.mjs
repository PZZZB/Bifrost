// Shape metadata only. Neither arbitrary field names nor any field value is
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
    if (code !== 'codebuddy_unsupported_delta' || !object(value) || !own(value, 'version') || value.version !== 1
      || !own(value, 'kind') || value.kind !== 'codebuddy_delta_shape' || !own(value, 'fields') || !Array.isArray(value.fields)) return null;
    const fields = value.fields.slice(0, MAX_FIELDS).map(field => normalizeField(field)).filter(Boolean);
    if (!fields.length) return null;
    return { version: 1, kind: 'codebuddy_delta_shape',
      ...(own(value, 'fieldCount') && size(value.fieldCount) ? { fieldCount: value.fieldCount } : {}), fields };
  } catch { return null; }
}
