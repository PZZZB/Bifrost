import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './storage.mjs';

const MAX_BODY = 64 * 1024 * 1024;
const MAX_EVENT = 16 * 1024 * 1024;
const MAX_STATE = 1024 * 1024;
const MAX_CACHE = 32 * 1024 * 1024;
const DAY = 86_400_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const stable = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
}
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const validName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

class ChatError extends BridgeError {
  constructor(message, status = 400, code = 'client_chat_invalid_request', param = null) { super(message, status, code); this.param = param; }
}
const invalid = (message, param) => { throw new ChatError(message, 400, 'client_chat_invalid_request', param); };
const protocol = () => { throw new ChatError('上游 Responses 内容无法完整转换为 Chat Completions。', 502, 'client_chat_upstream_protocol'); };
const stateLost = () => { throw new ChatError('此工具回合的网关接续状态已失效或历史已变化，请新建会话。', 409, 'client_chat_state_missing'); };
function shape(value, allowed, where) {
  if (!object(value)) invalid(`${where} 必须为对象。`, where);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      invalid(`不支持 ${where} 中的此字段。`, where);
    }
  }
}
function text(value, where, limit = MAX_BODY) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit) invalid(`${where} 不是有效文本或超过大小限制。`, where);
  return value;
}
function finite(value, where, depth = 0) {
  if (depth > 64 || typeof value === 'number' && !Number.isFinite(value)) invalid(`${where} 包含无效 JSON 值。`, where);
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value) && !object(value)) invalid(`${where} 包含无效 JSON 对象。`, where);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(`${where} 包含无效 JSON 字段。`, where);
      finite(value[key], where, depth + 1);
    }
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) invalid(`${where} 包含无效 JSON 值。`, where);
}
function parseBody(raw) {
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const bytes = Buffer.from(raw);
    if (bytes.byteLength > MAX_BODY) throw new ChatError('请求超过大小限制。', 413, 'client_chat_body_limit');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { invalid('请求不是有效 JSON。', 'body'); }
  }
  finite(raw, 'body');
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > MAX_BODY) throw new ChatError('请求超过大小限制。', 413, 'client_chat_body_limit');
  return structuredClone(raw);
}
function parts(value, role, where) {
  if (typeof value === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: value }];
  if (!Array.isArray(value)) invalid(`${where} 必须为文本或内容数组。`, where);
  return value.map(part => {
    if (part?.type === 'text') {
      shape(part, ['type', 'text'], where);
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: text(part.text, where) };
    }
    if (part?.type === 'image_url') {
      shape(part, ['type', 'image_url'], where);
      shape(part.image_url, ['url', 'detail'], `${where}.image_url`);
      if (!['user', 'tool'].includes(role)) invalid('图片只能出现在用户消息或工具结果中。', where);
      const url = text(part.image_url.url, where);
      if (!/^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(url)
        || part.image_url.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(part.image_url.detail)) invalid('图片地址或 detail 无效。', where);
      return { type: 'input_image', image_url: url, ...(part.image_url.detail !== undefined ? { detail: part.image_url.detail } : {}) };
    }
    invalid('尚未适配此附件类型；请提供文本或 image_url 图片。', where);
  });
}
function canonicalParts(value) {
  // Text strings and equivalent text arrays have the same history identity.
  const result = [];
  for (const item of value) {
    if (['input_text', 'output_text'].includes(item.type)) {
      if (result.at(-1)?.type === 'text') result.at(-1).text += item.text;
      else result.push({ type: 'text', text: item.text });
    } else result.push({ type: 'image_url', image_url: { url: item.image_url, detail: item.detail ?? 'auto' } });
  }
  return result.filter(item => item.type !== 'text' || item.text !== '');
}
function canonicalAssistant(content, calls = []) {
  return { role: 'assistant', content: canonicalParts([{ type: 'output_text', text: content ?? '' }]),
    tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) };
}
function argumentsText(value, where) {
  const string = text(value, where);
  let parsed;
  try { parsed = JSON.parse(string); } catch { invalid('工具 arguments 不是有效 JSON。', where); }
  if (!object(parsed)) invalid('工具 arguments 必须表示 JSON 对象。', where);
  return string;
}
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 8192) invalid('messages 须包含 1–8192 条消息。', 'messages');
  const normalized = [], pending = new Set(), seen = new Set();
  for (const message of messages) {
    shape(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal'], 'messages');
    const { role } = message;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) invalid('不支持此消息 role。', 'messages.role');
    if (message.refusal != null && message.refusal !== '') invalid('无法保真接续 refusal 历史。', 'messages.refusal');
    if (role !== 'assistant' && message.tool_calls !== undefined || role !== 'tool' && message.tool_call_id !== undefined) invalid('消息工具字段与 role 不匹配。', 'messages');
    if (pending.size && !['tool', 'system', 'developer'].includes(role)) invalid('工具结果须完整返回后再发送下一条消息。', 'messages');
    if (role === 'tool') {
      if (!validId(message.tool_call_id) || !pending.has(message.tool_call_id)) invalid('工具结果没有匹配的调用。', 'messages.tool_call_id');
      pending.delete(message.tool_call_id);
      const content = parts(message.content, role, 'messages.content');
      normalized.push({ canonical: { role, content: canonicalParts(content), tool_call_id: message.tool_call_id },
        input: [{ type: 'function_call_output', call_id: message.tool_call_id,
          output: typeof message.content === 'string' ? message.content : content.map(part => part.type === 'input_text' ? { ...part } : part) }] });
      continue;
    }
    const content = message.content == null && role === 'assistant' ? [] : parts(message.content, role, 'messages.content');
    const calls = [];
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128) invalid('tool_calls 格式无效。', 'messages.tool_calls');
      for (const call of message.tool_calls) {
        shape(call, ['id', 'type', 'function'], 'messages.tool_calls'); shape(call.function, ['name', 'arguments'], 'messages.tool_calls.function');
        if (call.type !== 'function' || !validId(call.id) || seen.has(call.id) || !validName(call.function.name)) invalid('工具调用标识或名称无效。', 'messages.tool_calls');
        const args = argumentsText(call.function.arguments, 'messages.tool_calls.function.arguments');
        calls.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: args } });
        seen.add(call.id); pending.add(call.id);
      }
    }
    const canonical = role === 'assistant' ? { role, content: canonicalParts(content), tool_calls: calls }
      : { role, content: canonicalParts(content) };
    const input = [];
    if (content.length) input.push({ role, content });
    input.push(...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })));
    normalized.push({ canonical, input, hasTools: calls.length > 0 });
  }
  if (pending.size) invalid('请求缺少工具结果。', 'messages');
  if (!['user', 'tool'].includes(messages.at(-1).role)) invalid('请求须以用户消息或工具结果结束。', 'messages');
  return normalized;
}
function toolDeclarations(tools) {
  if (!Array.isArray(tools) || tools.length > 128) invalid('tools 格式无效。', 'tools');
  const names = new Set();
  return tools.map(tool => {
    shape(tool, ['type', 'function'], 'tools');
    shape(tool.function, ['name', 'description', 'parameters', 'strict'], 'tools.function');
    if (tool.type !== 'function' || !validName(tool.function.name) || names.has(tool.function.name)) invalid('工具类型、名称或重复声明无效。', 'tools');
    names.add(tool.function.name);
    if (tool.function.description !== undefined) text(tool.function.description, 'tools.function.description', 65536);
    if (tool.function.parameters !== undefined && !object(tool.function.parameters)) invalid('工具 parameters 必须为 JSON Schema 对象。', 'tools.function.parameters');
    if (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') invalid('工具 strict 无效。', 'tools.function.strict');
    return { type: 'function', ...tool.function };
  });
}
function translate(raw) {
  const body = parseBody(raw);
  shape(body, ['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options',
    'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'reasoning_effort', 'response_format',
    'n', 'store', 'metadata', 'prompt_cache_key', 'service_tier', 'stop', 'frequency_penalty', 'presence_penalty'], 'body');
  if (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,511}$/.test(body.model)) invalid('model 无效。', 'model');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream 必须为布尔值。', 'stream');
  if (body.n !== undefined && body.n !== 1) invalid('当前仅支持 n=1。', 'n');
  if (body.store !== undefined && body.store !== false) invalid('当前不提供服务端对话存储。', 'store');
  if (body.stop != null && (!Array.isArray(body.stop) || body.stop.length !== 0)) invalid('Responses 后端不提供 stop 的保真映射。', 'stop');
  for (const key of ['frequency_penalty', 'presence_penalty']) if (body[key] !== undefined && body[key] !== 0) invalid(`不支持 ${key}。`, key);
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid('max_tokens 与 max_completion_tokens 不能同时指定。', 'max_tokens');
  const output = { model: body.model, input: [], stream: true, store: false, include: ['reasoning.encrypted_content'] };
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) {
    if (!Number.isSafeInteger(max) || max < 1) invalid('输出 Token 上限须为正整数。', 'max_tokens');
    output.max_output_tokens = max;
  }
  for (const [key, maximum] of [['temperature', 2], ['top_p', 1]]) if (body[key] !== undefined) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > maximum) invalid(`${key} 超出范围。`, key);
    output[key] = body[key];
  }
  if (body.reasoning_effort !== undefined) {
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.reasoning_effort)) invalid('reasoning_effort 无效。', 'reasoning_effort');
    output.reasoning = { effort: body.reasoning_effort };
  }
  if (body.tools !== undefined) output.tools = toolDeclarations(body.tools);
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls 无效。', 'parallel_tool_calls');
    output.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.tool_choice !== undefined) {
    if (['auto', 'none', 'required'].includes(body.tool_choice)) output.tool_choice = body.tool_choice;
    else {
      shape(body.tool_choice, ['type', 'function'], 'tool_choice'); shape(body.tool_choice.function, ['name'], 'tool_choice.function');
      if (body.tool_choice.type !== 'function' || !validName(body.tool_choice.function.name)) invalid('tool_choice 无效。', 'tool_choice');
      output.tool_choice = { type: 'function', name: body.tool_choice.function.name };
    }
  }
  let includeUsage = false;
  if (body.stream_options !== undefined) {
    shape(body.stream_options, ['include_usage'], 'stream_options');
    if (typeof body.stream_options.include_usage !== 'boolean') invalid('stream_options.include_usage 须为布尔值。', 'stream_options');
    includeUsage = body.stream_options.include_usage;
  }
  if (body.response_format !== undefined) {
    shape(body.response_format, ['type', 'json_schema'], 'response_format');
    const format = body.response_format;
    if (['text', 'json_object'].includes(format.type) && format.json_schema === undefined) output.text = { format: { type: format.type } };
    else if (format.type === 'json_schema') {
      shape(format.json_schema, ['name', 'description', 'schema', 'strict'], 'response_format.json_schema');
      if (!validName(format.json_schema.name) || !object(format.json_schema.schema)
        || format.json_schema.strict !== undefined && typeof format.json_schema.strict !== 'boolean') invalid('json_schema 格式无效。', 'response_format');
      if (format.json_schema.description !== undefined) text(format.json_schema.description, 'response_format.json_schema.description', 65536);
      output.text = { format: { type: 'json_schema', ...format.json_schema } };
    } else invalid('不支持此 response_format。', 'response_format');
  }
  if (body.metadata !== undefined) {
    if (!object(body.metadata) || Object.keys(body.metadata).length > 16 || Object.entries(body.metadata).some(([key, value]) => key.length > 64 || typeof value !== 'string' || value.length > 512)) invalid('metadata 无效。', 'metadata');
    output.metadata = body.metadata;
  }
  if (body.prompt_cache_key !== undefined) output.prompt_cache_key = text(body.prompt_cache_key, 'prompt_cache_key', 512);
  if (body.service_tier !== undefined) {
    if (!['auto', 'default', 'flex', 'priority'].includes(body.service_tier)) invalid('service_tier 无效。', 'service_tier');
    output.service_tier = body.service_tier;
  }
  return { output, messages: normalizeMessages(body.messages), stream: body.stream === true, includeUsage };
}
function errorBody(cause) {
  const known = cause instanceof ChatError;
  const status = known ? cause.status : cause?.name === 'AbortError' ? 499 : 502;
  return { status, body: { error: { message: known ? cause.message : status === 499 ? '请求已取消。' : '网关未能完成 Chat Completions 请求。',
    type: status >= 500 ? 'server_error' : status === 499 ? 'api_error' : 'invalid_request_error',
    code: known ? cause.code : status === 499 ? 'request_cancelled' : 'client_chat_upstream_error', param: known ? cause.param : null } } };
}
async function* responseEvents(response, signal) {
  if (!response.body) protocol();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  let total = 0, buffer = '', ended = false;
  const json = response.headers.get('content-type')?.includes('application/json');
  try {
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      total += value.byteLength; if (total > MAX_BODY) protocol();
      buffer += decoder.decode(value, { stream: true });
      if (!json) {
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const segment = buffer.slice(0, boundary), delimiter = /^\r?\n\r?\n/.exec(buffer.slice(boundary))[0];
          buffer = buffer.slice(boundary + delimiter.length);
          const data = segment.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          if (data === '[DONE]') { ended = true; continue; }
          if (ended) protocol();
          let event; try { event = JSON.parse(data); } catch { protocol(); }
          if (!object(event) || typeof event.type !== 'string') protocol();
          yield event;
        }
        if (Buffer.byteLength(buffer) > MAX_EVENT) protocol();
      }
    }
    if (json) {
      let final; try { final = JSON.parse(buffer); } catch { protocol(); }
      if (!object(final) || !['completed', 'incomplete'].includes(final.status)) protocol();
      yield { type: final.status === 'completed' ? 'response.completed' : 'response.incomplete', response: final };
    } else if (buffer.trim()) protocol();
  } finally { signal.removeEventListener('abort', onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function usage(value) {
  if (!object(value)) return null;
  const prompt = count(value.input_tokens), completion = count(value.output_tokens);
  const total = count(value.total_tokens) ?? (prompt !== null && completion !== null ? prompt + completion : null);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total,
    ...(count(value.input_tokens_details?.cached_tokens) !== null ? { prompt_tokens_details: { cached_tokens: value.input_tokens_details.cached_tokens } } : {}),
    ...(count(value.output_tokens_details?.reasoning_tokens) !== null ? { completion_tokens_details: { reasoning_tokens: value.output_tokens_details.reasoning_tokens } } : {}) };
}

class ChatOutput {
  constructor({ model, now }) {
    this.model = model; this.id = `chatcmpl-bf-${randomUUID().replaceAll('-', '')}`; this.created = Math.floor(now / 1000);
    this.text = ''; this.refusal = ''; this.calls = new Map(); this.callItems = new Map(); this.started = false; this.terminal = false;
  }
  chunk(delta, finish = null) { return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] }; }
  ensureRole(chunks) { if (!this.started) { this.started = true; chunks.push(this.chunk({ role: 'assistant', content: '' })); } }
  tool(item, outputIndex, chunks) {
    if (!validId(item.call_id) || !validName(item.name) || item.namespace != null && item.namespace !== '') protocol();
    let call = this.calls.get(outputIndex);
    if (!call) {
      call = { id: item.call_id, name: item.name, arguments: '', index: this.calls.size };
      if ([...this.calls.values()].some(existing => existing.id === item.call_id)) protocol();
      this.calls.set(outputIndex, call); if (item.id) this.callItems.set(item.id, outputIndex);
      this.ensureRole(chunks); chunks.push(this.chunk({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
    } else if (call.id !== item.call_id || call.name !== item.name) protocol();
    return call;
  }
  final(response) {
    if (!object(response) || response.error != null || !Array.isArray(response.output) || !['completed', 'incomplete'].includes(response.status)) protocol();
    const chunks = [], calls = [], states = [];
    let textValue = '', refusal = '';
    for (let index = 0; index < response.output.length; index++) {
      const item = response.output[index];
      if (item?.status !== undefined && (response.status === 'completed' ? item.status !== 'completed'
        : !['completed', 'incomplete', 'in_progress'].includes(item.status))) protocol();
      if (item?.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content)) protocol();
        for (const part of item.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string' && (!part.annotations || Array.isArray(part.annotations) && part.annotations.length === 0)) textValue += part.text;
          else if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal += part.refusal;
          else protocol();
        }
      } else if (item?.type === 'function_call') {
        const call = this.tool(item, index, chunks);
        if (typeof item.arguments !== 'string' || !item.arguments.startsWith(call.arguments)) protocol();
        if (response.status === 'completed') {
          if (item.status !== undefined && item.status !== 'completed') protocol();
          try { if (!object(JSON.parse(item.arguments))) protocol(); } catch { protocol(); }
        }
        const tail = item.arguments.slice(call.arguments.length);
        if (tail) chunks.push(this.chunk({ tool_calls: [{ index: call.index, function: { arguments: tail } }] }));
        call.arguments = item.arguments;
        calls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } });
      } else if (item?.type === 'reasoning') {
        if (item.encrypted_content != null) {
          if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) protocol();
          states.push(item.encrypted_content);
        }
      } else protocol();
    }
    if (!textValue.startsWith(this.text) || !refusal.startsWith(this.refusal) || calls.length !== this.calls.size) protocol();
    this.ensureRole(chunks);
    if (textValue.length > this.text.length) chunks.push(this.chunk({ content: textValue.slice(this.text.length) }));
    if (refusal.length > this.refusal.length) chunks.push(this.chunk({ refusal: refusal.slice(this.refusal.length) }));
    this.text = textValue; this.refusal = refusal;
    let finish = calls.length ? 'tool_calls' : 'stop';
    if (response.status === 'incomplete') {
      if (response.incomplete_details?.reason === 'max_output_tokens') finish = 'length';
      else if (response.incomplete_details?.reason === 'content_filter') finish = 'content_filter';
      else protocol();
    }
    const message = { role: 'assistant', content: textValue || (calls.length || refusal ? null : ''),
      ...(calls.length ? { tool_calls: calls } : {}), ...(refusal ? { refusal } : {}) };
    this.terminal = true;
    return { chunks, states, message, finish, canonical: canonicalAssistant(textValue, calls), usage: usage(response.usage),
      completion: { id: this.id, object: 'chat.completion', created: this.created, model: this.model,
        choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], ...(usage(response.usage) ? { usage: usage(response.usage) } : {}) } };
  }
  event(event) {
    if (this.terminal) protocol();
    const chunks = [];
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta !== 'string') protocol();
      this.ensureRole(chunks);
      if (event.type === 'response.output_text.delta') { this.text += event.delta; chunks.push(this.chunk({ content: event.delta })); }
      else { this.refusal += event.delta; chunks.push(this.chunk({ refusal: event.delta })); }
    } else if (event.type === 'response.output_item.added') {
      if (!Number.isInteger(event.output_index) || event.output_index < 0) protocol();
      if (event.item?.type === 'function_call') this.tool(event.item, event.output_index, chunks);
      else if (!['message', 'reasoning'].includes(event.item?.type)) protocol();
    } else if (event.type === 'response.output_item.done') {
      if (!['message', 'function_call', 'reasoning'].includes(event.item?.type)) protocol();
    } else if (event.type === 'response.function_call_arguments.delta') {
      const index = event.output_index ?? this.callItems.get(event.item_id), call = this.calls.get(index);
      if (!call || typeof event.delta !== 'string') protocol();
      call.arguments += event.delta;
      chunks.push(this.chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta } }] }));
    } else if (['response.completed', 'response.incomplete'].includes(event.type)) {
      if (event.response?.status !== event.type.slice('response.'.length)) protocol();
      return this.final(event.response);
    }
    else if (['error', 'response.failed', 'response.error', 'response.cancelled'].includes(event.type)) throw new ChatError('上游未能完成响应。', 502, 'client_chat_upstream_failed');
    else if (!['response.created', 'response.in_progress', 'response.queued',
      'response.content_part.added', 'response.content_part.done', 'response.output_text.done', 'response.refusal.done',
      'response.function_call_arguments.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
      'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta',
      'response.reasoning_text.done'].includes(event.type)) protocol();
    return { chunks };
  }
}

/** OpenAI Chat compatibility with tenant-bound, memory-only opaque continuation state. */
export class ClientChatAdapter {
  #request;
  #now;
  #maxEntries;
  #ttl;
  #cache = new Map();
  #cacheBytes = 0;
  #closed = false;
  constructor({ requestResponses, now = Date.now, maxEntries = 1024, ttlMs = DAY } = {}) {
    if (typeof requestResponses !== 'function' || typeof now !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DAY) throw new TypeError('Invalid ClientChatAdapter options.');
    this.#request = requestResponses; this.#now = now; this.#maxEntries = maxEntries; this.#ttl = ttlMs;
  }
  #key(scope, model, messages) { return digest({ scope, model, messages }); }
  #prune() {
    const now = this.#now();
    for (const [key, value] of this.#cache) if (value.expiresAt <= now) { this.#cache.delete(key); this.#cacheBytes -= value.bytes; }
  }
  #save(key, states) {
    if (this.#closed) throw new ChatError('Chat 适配器已关闭。', 503, 'client_chat_unavailable');
    const bytes = Buffer.byteLength(JSON.stringify(states));
    if (bytes > MAX_STATE) throw new ChatError('上游接续状态超过缓存限制，不能完成此工具回合。', 502, 'client_chat_state_limit');
    const existing = this.#cache.get(key);
    if (existing) { this.#cacheBytes -= existing.bytes; this.#cache.delete(key); }
    this.#prune();
    while (this.#cache.size >= this.#maxEntries || this.#cacheBytes + bytes > MAX_CACHE) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cacheBytes -= this.#cache.get(oldest).bytes; this.#cache.delete(oldest);
    }
    this.#cache.set(key, { states: [...states], bytes, expiresAt: this.#now() + this.#ttl, used: false });
    this.#cacheBytes += bytes;
  }
  status() { this.#prune(); return { entries: this.#cache.size, maximum: this.#maxEntries, ttlMs: this.#ttl, memoryOnly: true }; }
  close() { this.#closed = true; this.#cache.clear(); this.#cacheBytes = 0; }
  async request({ body, scope, signal } = {}) {
    let translated, linkedSignal, abort;
    try {
      if (this.#closed) throw new ChatError('Chat 适配器已关闭。', 503, 'client_chat_unavailable');
      if (typeof scope !== 'string' || scope.length < 1 || scope.length > 512 || /[\x00-\x1f\x7f]/.test(scope)) invalid('缺少有效的用户隔离标识。', 'scope');
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      translated = translate(body); this.#prune();
      const history = [], input = []; let latestEntry, stateStarted = false;
      for (const message of translated.messages) {
        history.push(message.canonical);
        if (message.canonical.role === 'assistant') {
          const entry = this.#cache.get(this.#key(scope, translated.output.model, history));
          if (!entry && (message.hasTools || stateStarted)) stateLost();
          if (entry) {
            stateStarted = true; latestEntry = entry;
            input.push(...entry.states.map(encrypted_content => ({ type: 'reasoning', encrypted_content, summary: [] })));
          }
        }
        input.push(...message.input);
      }
      if (latestEntry?.used) stateLost();
      translated.output.input = input;
      abort = new AbortController(); linkedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      // A dispatched live SDK continuation cannot be replayed safely after a lost HTTP response.
      if (latestEntry) latestEntry.used = true;
      const response = await this.#request({ body: translated.output, scope, signal: linkedSignal });
      if (!(response instanceof Response)) protocol();
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChatError(`上游拒绝请求（HTTP ${response.status}）。`, response.status, 'client_chat_upstream_error');
      }
      const output = new ChatOutput({ model: translated.output.model, now: this.#now() }), events = responseEvents(response, linkedSignal);
      const finish = result => {
        // Length/content-filter responses are incomplete and cannot seed a tool continuation.
        if (result.finish === 'tool_calls' || result.finish === 'stop') {
          this.#save(this.#key(scope, translated.output.model, [...history, result.canonical]), result.states);
        }
      };
      if (!translated.stream) {
        let final;
        try {
          for await (const event of events) { const result = output.event(event); if (result.completion) final = result; }
          if (!final) protocol();
          finish(final);
          return Response.json(final.completion, { headers: { 'Cache-Control': 'no-store' } });
        } catch (cause) { abort.abort(); throw cause; }
      }
      const encoder = new TextEncoder();
      const frames = async function* () {
        let final;
        try {
          for await (const event of events) {
            const result = output.event(event);
            if (result.completion) final = result;
            for (const chunk of result.chunks) yield `data: ${JSON.stringify(chunk)}\n\n`;
            // Finish is delayed until EOF to reject events following a forged terminal marker.
          }
          if (!final) protocol();
          finish(final);
          yield `data: ${JSON.stringify(output.chunk({}, final.finish))}\n\n`;
          if (translated.includeUsage) yield `data: ${JSON.stringify({ id: output.id, object: 'chat.completion.chunk', created: output.created,
            model: output.model, choices: [], usage: final.usage })}\n\n`;
          yield 'data: [DONE]\n\n';
        } catch (cause) {
          abort.abort(); const failure = errorBody(cause);
          yield `data: ${JSON.stringify(failure.body)}\n\n`;
        }
      }();
      const stream = new ReadableStream({
        async pull(controller) {
          try { const next = await frames.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)); }
          catch { abort.abort(); controller.error(new Error('Chat stream failed.')); }
        },
        async cancel() { abort.abort(); await events.return().catch(() => {}); await frames.return().catch(() => {}); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    } catch (cause) {
      abort?.abort(); const failure = errorBody(cause);
      return Response.json(failure.body, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
    }
  }
}
