import { randomUUID } from 'node:crypto';
import { clientScope as validateClientScope } from './client-scope.mjs';
import { imagePart, ImageConversionError } from './codebuddy-images.mjs';
import { documentParts, DocumentConversionError } from './codebuddy-documents.mjs';
import { thinkingOptions, thinkingText, ThinkingConversionError } from './codebuddy-thinking.mjs';
import { CodeBuddyThinkingState, CODEBUDDY_STATE_PREFIX, ThinkingStateError } from './codebuddy-thinking-state.mjs';
import { CODEBUDDY_MODEL, codeBuddyModelAlias, resolveCodeBuddyAlias, isCodeBuddyOpus55 } from './codebuddy-models.mjs';
import { codeBuddySourceError } from './codebuddy-source-errors.mjs';

export { CODEBUDDY_MODEL };

const TRANSPORT = 'codebuddy-chat-completions';
const MAX_EVENT = 16 * 1024 * 1024;
const MAX_CONTENT = 32 * 1024 * 1024;
const namePattern = /^[A-Za-z0-9_-]{1,128}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,256}$/;
const isName = value => typeof value === 'string' && namePattern.test(value);
const isId = value => typeof value === 'string' && idPattern.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const aborted = signal => signal?.aborted === true;

class AdapterError extends Error {
  constructor(message, status = 400, code = null) {
    super(message); this.status = status;
    if (codeBuddySourceError(code)) this.code = code;
  }
}

function invalid(message = 'CodeBuddy 适配器不支持此请求。') { throw new AdapterError(message); }
function protocol(message = 'CodeBuddy 上游流不符合预期协议。', code = 'codebuddy_upstream_protocol_error') {
  throw new AdapterError(message, 502, code);
}
function emptyLegacyFunctionCall(value) {
  // HY4 includes this deprecated field beside real tool_calls. An empty
  // envelope carries no call; populated or extended envelopes remain errors.
  return value == null || value === '' || object(value) && Object.keys(value).every(key =>
    ['name', 'arguments'].includes(key) && (value[key] === '' || value[key] === null));
}
function unsupportedDeltaFields(delta, fields) {
  const publicNames = ['name', 'tool_call_id', 'audio', 'reasoning', 'reasoning_details', 'reasoning_signature', 'extra_fields',
    'extra_content', 'thinking', 'signature', 'annotations', 'function_call', 'metadata', 'content_type',
    'type', 'usage', 'logprobs', 'index'];
  const details = fields.slice(0, 8).map(key => {
    const value = delta[key], type = Array.isArray(value) ? 'array' : typeof value;
    const name = publicNames.includes(key) ? `${key}:${type}` : `unknown_key,keyLength=${key.length},valueType=${type}`;
    return name + (typeof value === 'string' || Array.isArray(value) ? `,length=${value.length}` : '');
  });
  protocol(`CodeBuddy 返回了尚未支持的内容类型（${details.join(';')}）。`, 'codebuddy_unsupported_delta');
}
function unsupportedFinishReason(value) {
  const known = ['error', 'content_filter', 'end_turn', 'max_tokens', 'tool_use', 'tool_call',
    'stop_sequence', 'pause_turn', 'refusal'];
  const detail = typeof value === 'string' && known.includes(value) ? `finish_reason=${value}`
    : `type=${Array.isArray(value) ? 'array' : typeof value}${typeof value === 'string' ? `,length=${value.length}` : ''}`;
  protocol(`CodeBuddy 返回了未支持的结束原因（${detail}）。`, 'codebuddy_unsupported_finish');
}
function upstreamFinishError(chunk) {
  const details = ['finish_reason=error'];
  for (const field of ['status_code', 'code']) {
    if (Number.isSafeInteger(chunk[field])) details.push(`${field}=${chunk[field]}`);
  }
  protocol(`CodeBuddy 上游返回了失败结束原因（${details.join(',')}）。`, 'codebuddy_upstream_failed');
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function string(value, max = MAX_CONTENT) {
  if (typeof value !== 'string' || value.length > max) invalid();
  return value;
}
function jsonObject(value) {
  if (!object(value)) invalid();
  try { return JSON.parse(JSON.stringify(value)); } catch { invalid(); }
}
function errorResponse(error) {
  const inputError = error instanceof AdapterError || error instanceof ImageConversionError ||
    error instanceof DocumentConversionError || error instanceof ThinkingConversionError || error instanceof ThinkingStateError;
  const knownStatus = ({ aborted: 499, not_authenticated: 401, employee_account_required: 403,
    identity_changed: 403, timeout: 504 })[error?.code];
  const status = error instanceof AdapterError ? error.status : knownStatus ??
    (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502);
  const type = ({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
    404: 'not_found_error', 429: 'rate_limit_error', 499: 'api_error', 501: 'not_implemented_error' })[status] || 'api_error';
  return Response.json({ type: 'error', error: { type,
    message: inputError ? error.message : 'CodeBuddy 请求失败。',
    ...(codeBuddySourceError(error?.code) ? { code: error.code } : {}) } }, { status });
}

function cacheHint(value, onHint) {
  if (value === undefined) return;
  keys(value, ['type', 'ttl']);
  if (value.type !== 'ephemeral' || value.ttl !== undefined && !['5m', '1h'].includes(value.ttl)) {
    invalid('CodeBuddy 不支持此缓存提示。');
  }
  onHint();
}

function textBlocks(value, onHint = () => {}) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid();
  return value.map(block => {
    keys(block, ['type', 'text', 'cache_control']);
    cacheHint(block.cache_control, onHint);
    if (block.type !== 'text') invalid('CodeBuddy 当前仅支持文本内容。');
    return string(block.text);
  }).join('');
}

function translate(body, upstreamModel, readThinking = thinkingText,
  readCompaction = () => invalid('CodeBuddy 历史摘要状态未提供解封方式。')) {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    try { body = JSON.parse(Buffer.from(body).toString('utf8')); } catch { invalid('请求不是有效 JSON。'); }
  }
  keys(body, ['model', 'messages', 'max_tokens', 'system', 'stream', 'tools', 'tool_choice',
    'temperature', 'top_p', 'stop_sequences', 'metadata', 'thinking', 'output_config', 'cache_control']);
  let ignoredCacheHints = 0;
  const onHint = () => { ignoredCacheHints++; };
  cacheHint(body.cache_control, onHint);
  const alias = resolveCodeBuddyAlias(body.model);
  if (!alias) invalid('未知的 CodeBuddy 模型。');
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) invalid('max_tokens 必须是正整数。');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid();
  const thinking = thinkingOptions(body, alias.upstream === null ? {} : { model: {}, validateOnly: true });
  if (body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.length)) {
    invalid('CodeBuddy 当前未提供可核实的 stop_sequence 返回值。');
  }
  const result = { model: upstreamModel, messages: [], max_tokens: body.max_tokens,
    stream: true, stream_options: { include_usage: true }, ...thinking.body };
  let images = 0;
  const parts = value => {
    if (typeof value === 'string') return [{ type: 'text', text: value }];
    if (!Array.isArray(value)) invalid('消息内容必须是文本或内容块数组。');
    return value.flatMap(block => {
      let converted;
      if (block?.type === 'text') converted = [{ type: 'text', text: textBlocks([block], onHint) }];
      else if (block?.type === 'image') converted = [imagePart(block, { onCacheHint: onHint })];
      else if (block?.type === 'document') converted = documentParts(block, { onCacheHint: onHint });
      else if (['video', 'audio', 'file', 'input_file', 'container_upload'].includes(block?.type)) {
        invalid('当前 CodeBuddy 接口没有原始视频、音频或二进制文件的保真映射；请先将附件解析为文本或图片。');
      } else invalid('CodeBuddy 不支持此消息内容类型。');
      images += converted.filter(part => part.type === 'image_url').length;
      if (images > 100) invalid('单次请求最多包含 100 张图片（包括历史与工具结果）。');
      return converted;
    });
  };
  const content = values => values.every(part => part.type === 'text') ? values.map(part => part.text).join('') : values;
  for (const field of ['temperature', 'top_p']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > 1) invalid();
    result[field] = body[field];
  }
  if (body.metadata !== undefined) {
    keys(body.metadata, ['user_id']);
    if (body.metadata.user_id !== undefined) result.user = string(body.metadata.user_id, 1024);
  }
  if (body.system !== undefined) {
    const blocks = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : body.system;
    if (!Array.isArray(blocks)) invalid();
    for (const block of blocks) result.messages.push({ role: 'system', content: textBlocks([block], onHint) });
  }
  const toolNames = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) invalid();
    result.tools = body.tools.map(tool => {
      keys(tool, ['name', 'description', 'input_schema', 'cache_control']);
      cacheHint(tool.cache_control, onHint);
      if (!isName(tool.name) || toolNames.has(tool.name)) invalid('工具名称无效或重复。');
      toolNames.add(tool.name);
      return { type: 'function', function: { name: tool.name,
        ...(tool.description !== undefined ? { description: string(tool.description, 65536) } : {}),
        parameters: jsonObject(tool.input_schema) } };
    });
  }
  let forbidTools = false, requireTools = false, forcedTool = null;
  if (body.tool_choice !== undefined) {
    keys(body.tool_choice, ['type', 'name', 'disable_parallel_tool_use']);
    const choice = body.tool_choice;
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== 'boolean') invalid();
      result.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
    if (choice.type === 'auto' || choice.type === 'none') {
      if (choice.name !== undefined) invalid();
      result.tool_choice = choice.type; forbidTools = choice.type === 'none';
    } else if (choice.type === 'any' && toolNames.size && choice.name === undefined) {
      result.tool_choice = 'required'; requireTools = true;
    }
    else if (choice.type === 'tool' && toolNames.has(choice.name)) {
      result.tool_choice = { type: 'function', function: { name: choice.name } };
      requireTools = true; forcedTool = choice.name;
    } else invalid('tool_choice 无效。');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages 不能为空。');
  const pending = new Set(), seen = new Set();
  for (const message of body.messages) {
    keys(message, ['role', 'content']);
    if (!['user', 'assistant'].includes(message.role)) invalid();
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) invalid();
    if (message.role === 'assistant') {
      if (pending.size) invalid('工具结果尚未完整返回。');
      let content = '', reasoning = '', extraFields; const calls = [];
      for (const block of blocks) {
        if (block?.type === 'text') content += textBlocks([block], onHint);
        else if (block?.type === 'thinking') {
          const saved = readThinking(block);
          if (typeof saved === 'string') reasoning += saved;
          else {
            reasoning += saved.reasoning;
            if (Object.hasOwn(saved, 'extra_fields')) {
              if (extraFields !== undefined) invalid('同一 assistant 消息包含重复的 CodeBuddy 元数据接续状态。');
              extraFields = saved.extra_fields;
            }
          }
        }
        else if (block?.type === 'redacted_thinking') invalid('CodeBuddy Chat 接口没有加密思考状态的映射，不能丢弃后继续。');
        else if (block?.type === 'tool_use') {
          keys(block, ['type', 'id', 'name', 'input', 'cache_control']);
          cacheHint(block.cache_control, onHint);
          if (!isId(block.id) || !isName(block.name) || seen.has(block.id)) invalid('工具调用无效或重复。');
          seen.add(block.id); pending.add(block.id);
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(jsonObject(block.input)) } });
        } else invalid('CodeBuddy 不支持此 assistant 内容类型。');
      }
      result.messages.push({ role: 'assistant', content: content || (calls.length ? null : ''),
        ...(reasoning ? { reasoning, reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}), ...(extraFields !== undefined ? { extra_fields: extraFields } : {}) });
    } else {
      let userParts = [];
      const flush = () => { if (userParts.length) { result.messages.push({ role: 'user', content: content(userParts) }); userParts = []; } };
      for (const block of blocks) {
        if (['text', 'image', 'document'].includes(block?.type)) {
          if (pending.size) invalid('工具结果须先于新的用户文本返回。');
          userParts.push(...parts([block]));
        } else if (block?.type === 'bifrost_compaction') {
          keys(block, ['type', 'encrypted_content']);
          if (pending.size) invalid('工具结果须先于历史摘要返回。');
          const summary = readCompaction(block.encrypted_content);
          userParts.push({ type: 'text', text: `[Bifrost conversation summary]\n${summary}\n[/Bifrost conversation summary]` });
        } else if (block?.type === 'tool_result') {
          keys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']);
          cacheHint(block.cache_control, onHint);
          if (!pending.delete(block.tool_use_id) || userParts.length) invalid('tool_result 未匹配待返回的工具调用。');
          if (block.is_error !== undefined && typeof block.is_error !== 'boolean') invalid();
          const toolParts = block.content === undefined ? [] : parts(block.content);
          if (block.is_error) toolParts.unshift({ type: 'text', text: '[Tool error]\n' });
          result.messages.push({ role: 'tool', tool_call_id: block.tool_use_id,
            content: content(toolParts) });
        } else if (['video', 'audio', 'file', 'input_file', 'container_upload'].includes(block?.type)) {
          parts([block]);
        } else invalid('CodeBuddy 不支持此用户内容类型。');
      }
      flush();
    }
  }
  if (pending.size || body.messages.at(-1).role !== 'user') invalid('工具结果缺失或 assistant 预填充未受支持。');
  return { body: result, streaming: body.stream === true, toolNames, forbidTools, requireTools, forcedTool,
    ignoredCacheHints, thinking, alias, original: body, images };
}

function catalogModels(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models) || models.length > 512) throw new AdapterError('CodeBuddy 模型目录格式无效。', 502);
  const valid = models.filter(model => codeBuddyModelAlias(model) !== null);
  const candidates = new Set(valid.filter(model => isCodeBuddyOpus55(model) && codeBuddyModelAlias(model).available).map(model => model.id));
  const counts = new Map();
  for (const model of valid) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  const mapped = new Map();
  for (const model of valid) {
    if (mapped.has(model.id)) continue;
    const candidate = isCodeBuddyOpus55(model) && codeBuddyModelAlias(model).available;
    const ambiguous = counts.get(model.id) > 1 || candidate && candidates.size > 1;
    mapped.set(model.id, { source: model, descriptor: codeBuddyModelAlias(model, {
      legacyOpus: candidate && candidates.size === 1, ambiguous }) });
  }
  return [...mapped.values()];
}

function publicCatalog(catalog) {
  const source = catalog?.source === 'native-cache' ? 'native-cache' : 'remote';
  const savedAt = source === 'native-cache' && Number.isSafeInteger(catalog?.savedAt) && catalog.savedAt >= 0
    && Number.isFinite(new Date(catalog.savedAt).getTime()) ? catalog.savedAt : null;
  return { source, savedAt,
    liveVerified: source === 'remote' && (Array.isArray(catalog) || catalog?.liveVerified === true), models: [] };
}

const promotionKeys = new Set(['id', 'name', 'priority', 'startAt', 'endAt', 'startTime', 'endTime',
  'enabled', 'isActive', 'discount', 'discountedCredits', 'factor', 'displayMode', 'badge',
  'label', 'labelZh', 'labelEn', 'color', 'display', 'hover', 'textZh', 'textEn', 'action']);
function publicPromotion(value, depth = 0) {
  if (depth > 5) return undefined;
  if (typeof value === 'string') return value.length <= 2048 ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 16).map(item => publicPromotion(item, depth + 1)).filter(item => item !== undefined);
  if (!object(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => promotionKeys.has(key))
    .map(([key, item]) => [key, publicPromotion(item, depth + 1)]).filter(([, item]) => item !== undefined));
}
function billing(model) {
  const credits = typeof model.credits === 'string' && model.credits.length <= 256 ||
    typeof model.credits === 'number' && Number.isFinite(model.credits) ? model.credits : null;
  return { verified: false, employeeTokenMultiplier: null, sourceCredits: credits,
    sourcePromotion: publicPromotion(model.promotions ?? model.promotion) ?? null };
}

function normalizeUsage(raw, previous) {
  if (!object(raw)) return previous;
  const values = { input_tokens: count(raw.prompt_tokens), output_tokens: count(raw.completion_tokens),
    total_tokens: count(raw.total_tokens),
    input_tokens_details: { cached_tokens: count(raw.prompt_tokens_details?.cached_tokens),
      cache_write_tokens: count(raw.prompt_tokens_details?.cache_write_tokens) },
    output_tokens_details: { reasoning_tokens: count(raw.completion_tokens_details?.reasoning_tokens) } };
  const merged = { input_tokens: values.input_tokens ?? previous?.input_tokens ?? null,
    output_tokens: values.output_tokens ?? previous?.output_tokens ?? null,
    total_tokens: values.total_tokens ?? previous?.total_tokens ?? null,
    input_tokens_details: Object.fromEntries(Object.entries(values.input_tokens_details)
      .map(([key, value]) => [key, value ?? previous?.input_tokens_details?.[key] ?? null])),
    output_tokens_details: { reasoning_tokens: values.output_tokens_details.reasoning_tokens ?? previous?.output_tokens_details?.reasoning_tokens ?? null } };
  if (values.total_tokens === null && (merged.total_tokens === null || values.input_tokens !== null || values.output_tokens !== null)) {
    merged.total_tokens = merged.input_tokens !== null && merged.output_tokens !== null ? count(merged.input_tokens + merged.output_tokens) : null;
  }
  if (merged.input_tokens !== null && (merged.input_tokens_details.cached_tokens ?? 0) +
    (merged.input_tokens_details.cache_write_tokens ?? 0) > merged.input_tokens) {
    merged.input_tokens_details = { cached_tokens: null, cache_write_tokens: null };
  }
  if (merged.output_tokens !== null && merged.output_tokens_details.reasoning_tokens > merged.output_tokens) {
    merged.output_tokens_details.reasoning_tokens = null;
  }
  return [merged.input_tokens, merged.output_tokens, merged.total_tokens,
    ...Object.values(merged.input_tokens_details), merged.output_tokens_details.reasoning_tokens].some(value => value !== null) ? merged : null;
}

function wireUsage(usage) {
  const cached = usage?.input_tokens_details.cached_tokens;
  const written = usage?.input_tokens_details.cache_write_tokens;
  const prompt = usage?.input_tokens;
  const knownCache = (cached ?? 0) + (written ?? 0);
  // Protocol placeholders never enter the ledger; bridgeUsage preserves unknown counts.
  return { input_tokens: prompt !== null && prompt !== undefined && prompt >= knownCache ? prompt - knownCache : 0,
    output_tokens: usage?.output_tokens ?? 0,
    ...(cached !== null && cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    ...(written !== null && written !== undefined ? { cache_creation_input_tokens: written } : {}) };
}

class EventParser {
  decoder = new TextDecoder('utf-8', { fatal: true });
  text = '';
  constructor(onData) { this.onData = onData; }
  push(bytes) {
    this.text += this.decoder.decode(bytes, { stream: true });
    if (this.text.length > MAX_EVENT) protocol('CodeBuddy SSE 事件超过大小限制。');
    let end;
    while ((end = this.text.search(/\r?\n\r?\n/)) !== -1) {
      const event = this.text.slice(0, end), delimiter = /^\r?\n\r?\n/.exec(this.text.slice(end))[0];
      this.text = this.text.slice(end + delimiter.length);
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) this.onData(data);
    }
  }
  end() { this.text += this.decoder.decode(); if (this.text.trim()) protocol('CodeBuddy SSE 事件被截断。'); }
}

class Completion {
  id = `msg_codebuddy_${randomUUID().replaceAll('-', '')}`;
  blocks = [];
  calls = new Map();
  events = [];
  usage = null;
  finishReason = null;
  started = false;
  done = false;
  textIndex = null;
  thinkingIndex = null;
  hiddenThinking = '';
  extraFields = undefined;
  extraFieldsBytes = 0;
  extraFieldsSignature = null;
  // UTF-8 content plus the currently retained metadata snapshot, not every replacement.
  size = 0;
  constructor(request, sealThinking) { this.request = request; this.sealThinking = sealThinking; }
  emit(type, value = {}) { this.events.push({ type, ...value }); }
  start() {
    if (this.started) return;
    this.started = true;
    this.emit('message_start', { message: { id: this.id, type: 'message', role: 'assistant', model: this.request.alias.id,
      content: [], stop_reason: null, stop_sequence: null, usage: wireUsage(this.usage) } });
  }
  closeText() {
    if (this.textIndex !== null) this.emit('content_block_stop', { index: this.textIndex });
    this.textIndex = null;
  }
  closeThinking() {
    if (this.thinkingIndex !== null) {
      if (!this.request.thinking.visible) {
        // This is the bridge's encrypted continuation marker, not an Anthropic
        // signature. The caller can replay it without receiving readable text.
        const signature = this.sealThinking(this.hiddenThinking);
        this.blocks[this.thinkingIndex].signature = signature;
        this.emit('content_block_delta', { index: this.thinkingIndex, delta: { type: 'signature_delta', signature } });
      }
      this.emit('content_block_stop', { index: this.thinkingIndex });
    }
    this.thinkingIndex = null;
    this.hiddenThinking = '';
  }
  captureExtraFields(value) {
    if (value === undefined || value === null) return;
    let bytes;
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') throw new Error();
      bytes = Buffer.byteLength(json, 'utf8');
    } catch { protocol('CodeBuddy extra_fields 接续状态无效或无法序列化（extra_fields:' + (Array.isArray(value) ? 'array' : typeof value) + '）。'); }
    if (this.size - this.extraFieldsBytes + bytes > MAX_CONTENT) protocol('CodeBuddy extra_fields 接续状态超过大小限制。');
    // Validate the original value through the strict codec before retaining it;
    // JSON.stringify alone would silently turn a parsed 1e400 into null.
    const signature = this.sealThinking('', value);
    this.size += bytes - this.extraFieldsBytes;
    this.extraFieldsBytes = bytes;
    this.extraFields = value;
    this.extraFieldsSignature = signature;
  }
  emitExtraFields() {
    if (this.extraFields === undefined) return;
    // Keep opaque upstream metadata separate from readable summaries and already
    // emitted reasoning markers, so replay never duplicates the reasoning text.
    const signature = this.extraFieldsSignature, index = this.blocks.length;
    this.blocks.push({ type: 'thinking', thinking: '', signature });
    this.emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    this.emit('content_block_delta', { index, delta: { type: 'signature_delta', signature } });
    this.emit('content_block_stop', { index });
  }
  data(value) {
    if (this.done) protocol('CodeBuddy 在结束标记后返回了其他数据。');
    if (value === '[DONE]') { this.done = true; return; }
    let chunk;
    try { chunk = JSON.parse(value); } catch { protocol('CodeBuddy 返回了无效 SSE JSON。'); }
    if (!object(chunk) || chunk.error || chunk.type === 'error') {
      if (object(chunk) && Array.isArray(chunk.choices) && chunk.choices.some(choice => choice?.finish_reason === 'error')) {
        upstreamFinishError(chunk);
      }
      protocol('CodeBuddy 上游返回了错误事件。', 'codebuddy_upstream_failed');
    }
    this.usage = normalizeUsage(chunk.usage, this.usage);
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) protocol();
    if (!chunk.choices.length) { if (!object(chunk.usage)) protocol(); return; }
    const choice = chunk.choices[0];
    if (!object(choice) || choice.index !== undefined && choice.index !== 0 || !object(choice.delta)) protocol();
    // CodeBuddy uses an empty string on unfinished chunks; it is not a terminal reason.
    const finishReason = choice.finish_reason === '' ? null : choice.finish_reason;
    if (finishReason === 'error') upstreamFinishError(chunk);
    const delta = choice.delta;
    if (this.finishReason !== null && (Object.keys(delta).some(key => {
      if (key === 'extra_fields') return false;
      if (key === 'function_call') return !emptyLegacyFunctionCall(delta[key]);
      if (key === 'role') return delta.role !== 'assistant';
      if (key === 'tool_calls') return !Array.isArray(delta.tool_calls) || delta.tool_calls.length !== 0;
      if (['content', 'reasoning_content', 'refusal'].includes(key)) return delta[key] !== null && delta[key] !== '';
      return true;
    }) || finishReason !== null && finishReason !== undefined)) protocol();
    const unsupportedFields = Object.keys(delta).filter(key => !['role', 'content', 'tool_calls', 'refusal', 'reasoning_content', 'extra_fields'].includes(key)
      && !(key === 'function_call' && emptyLegacyFunctionCall(delta[key])) && delta[key] !== null && delta[key] !== '');
    if (unsupportedFields.length) unsupportedDeltaFields(delta, unsupportedFields);
    if (delta.role !== undefined && delta.role !== 'assistant' || delta.refusal) protocol('CodeBuddy 上游未返回可用的 assistant 消息。');
    this.captureExtraFields(delta.extra_fields);
    this.start();
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
      if (typeof delta.reasoning_content !== 'string') protocol('CodeBuddy 思考摘要格式无效。');
      this.size += Buffer.byteLength(delta.reasoning_content, 'utf8');
      if (this.size > MAX_CONTENT) protocol('CodeBuddy 输出超过大小限制。');
      if (delta.reasoning_content) {
        this.closeText();
        if (this.thinkingIndex === null) {
          this.thinkingIndex = this.blocks.length;
          // Chat exposes no Anthropic signature. An empty string is an explicit
          // compatibility placeholder, never a generated vendor signature.
          this.blocks.push({ type: 'thinking', thinking: '', signature: '' });
          this.emit('content_block_start', { index: this.thinkingIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' } });
        }
        if (this.request.thinking.visible) {
          this.blocks[this.thinkingIndex].thinking += delta.reasoning_content;
          this.emit('content_block_delta', { index: this.thinkingIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content } });
        } else this.hiddenThinking += delta.reasoning_content;
      }
    }
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') protocol();
      if (delta.content) {
        this.closeThinking();
        this.size += Buffer.byteLength(delta.content, 'utf8'); if (this.size > MAX_CONTENT) protocol('CodeBuddy 输出超过大小限制。');
        if (this.textIndex === null) {
          this.textIndex = this.blocks.length; this.blocks.push({ type: 'text', text: '' });
          this.emit('content_block_start', { index: this.textIndex, content_block: { type: 'text', text: '' } });
        }
        this.blocks[this.textIndex].text += delta.content;
        this.emit('content_block_delta', { index: this.textIndex, delta: { type: 'text_delta', text: delta.content } });
      }
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls) || this.request.forbidTools && delta.tool_calls.length) protocol();
      if (delta.tool_calls.length) { this.closeText(); this.closeThinking(); }
      for (const item of delta.tool_calls) {
        if (!object(item) || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= 128
          || item.type !== undefined && item.type !== 'function' || item.function !== undefined && !object(item.function)) protocol();
        const call = this.calls.get(item.index) ?? { id: '', name: '', arguments: '' };
        if (item.id !== undefined) {
          if (typeof item.id !== 'string') protocol();
          if (call.id !== item.id) call.id += item.id;
        }
        if (item.function?.name !== undefined) { if (typeof item.function.name !== 'string') protocol(); call.name += item.function.name; }
        if (item.function?.arguments !== undefined) {
          if (typeof item.function.arguments !== 'string') protocol();
          call.arguments += item.function.arguments; this.size += Buffer.byteLength(item.function.arguments, 'utf8');
        }
        if (call.id.length > 256 || call.name.length > 128 || this.size > MAX_CONTENT) protocol('CodeBuddy 工具参数超过大小限制。');
        this.calls.set(item.index, call);
      }
    }
    if (finishReason !== undefined && finishReason !== null) {
      if (!['stop', 'length', 'tool_calls'].includes(finishReason)) unsupportedFinishReason(finishReason);
      this.finishReason = finishReason;
    }
  }
  finish() {
    if (!this.done || !this.started || this.finishReason === null) protocol('CodeBuddy 上游未完整结束。', 'codebuddy_upstream_truncated');
    if (this.finishReason === 'tool_calls' && !this.calls.size || this.finishReason === 'stop' && this.calls.size
      || this.request.requireTools && !this.calls.size && this.finishReason !== 'length') protocol('CodeBuddy 工具调用与结束原因不一致。');
    this.closeText(); this.closeThinking(); this.emitExtraFields(); const seen = new Set();
    for (const [expected, [index, call]] of [...this.calls.entries()].sort(([a], [b]) => a - b).entries()) {
      if (index !== expected || !isId(call.id) || seen.has(call.id) || !this.request.toolNames.has(call.name)
        || this.request.forcedTool && call.name !== this.request.forcedTool) protocol('CodeBuddy 返回了未声明或无效的工具调用。');
      let input;
      try { input = JSON.parse(call.arguments); } catch { protocol('CodeBuddy 工具参数不是完整 JSON。'); }
      if (!object(input)) protocol('CodeBuddy 工具参数必须是对象。');
      seen.add(call.id);
      const blockIndex = this.blocks.length;
      this.blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      this.emit('content_block_start', { index: blockIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
      this.emit('content_block_delta', { index: blockIndex, delta: { type: 'input_json_delta', partial_json: call.arguments } });
      this.emit('content_block_stop', { index: blockIndex });
    }
    this.stopReason = this.finishReason === 'tool_calls' ? 'tool_use' : this.finishReason === 'length' ? 'max_tokens' : 'end_turn';
    this.emit('message_delta', { delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: wireUsage(this.usage) });
    this.emit('message_stop');
  }
  message() {
    return { id: this.id, type: 'message', role: 'assistant', model: this.request.alias.id,
      content: this.blocks, stop_reason: this.stopReason, stop_sequence: null, usage: wireUsage(this.usage) };
  }
}

function sse(event) { return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }

export class CodeBuddyProvider {
  #cache = null;
  #catalog = null;
  #readGeneration = 0;
  #catalogGeneration = 0;
  #thinkingState = null;
  constructor({ client, now = Date.now, catalogTtlMs = 30_000,
    loadThinkingState = () => new CodeBuddyThinkingState() } = {}) {
    if (typeof client?.modelCatalog !== 'function' || typeof client?.chatCompletions !== 'function') {
      throw new TypeError('CodeBuddy client.modelCatalog() and chatCompletions() are required.');
    }
    this.client = client; this.now = now; this.catalogTtlMs = Math.min(60_000, Math.max(0, catalogTtlMs));
    if (typeof loadThinkingState !== 'function') throw new TypeError('loadThinkingState() is required.');
    this.loadThinkingState = loadThinkingState;
  }
  async #state() {
    this.#thinkingState ??= Promise.resolve().then(() => this.loadThinkingState());
    try { return await this.#thinkingState; }
    catch { this.#thinkingState = null; throw new AdapterError('CodeBuddy 思考接续密钥暂不可用。', 503); }
  }
  async #metadata(signal, force = false) {
    if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
    const generation = ++this.#readGeneration;
    const status = typeof this.client.status === 'function' ? await this.client.status({ signal }) : null;
    if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
    const account = status?.identity ?? null;
    if (status?.authenticated === false) {
      if (generation >= this.#catalogGeneration) {
        this.#catalogGeneration = generation; this.#cache = null; this.#catalog = null;
      }
      throw new AdapterError('CodeBuddy 员工账号尚未登录。', 401);
    }
    const identity = status?.identity?.uid ?? '';
    if (!force && this.#cache && this.#cache.identity === identity && this.#cache.expires > this.now()) return { models: this.#cache.models, identity: account };
    // Invocation order also covers calls still waiting for auth status. A cache
    // hit must not supersede an explicit refresh that is already in flight.
    this.#catalogGeneration = Math.max(this.#catalogGeneration, generation);
    try {
      const catalog = await this.client.modelCatalog({ signal });
      if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
      const snapshot = publicCatalog(catalog);
      const models = catalogModels(catalog);
      for (const model of models) model.descriptor.source = snapshot.source;
      snapshot.models = models.map(model => structuredClone(model.descriptor));
      if (generation === this.#catalogGeneration) {
        this.#catalog = snapshot;
        this.#cache = { identity, models, expires: this.now() + this.catalogTtlMs };
      }
      return { models, identity: account };
    } catch (error) {
      if (generation === this.#catalogGeneration) { this.#cache = null; this.#catalog = null; }
      throw error;
    }
  }
  async getModels({ signal, force = false } = {}) {
    const { models } = await this.#metadata(signal, force === true);
    return models.map(model => structuredClone(model.descriptor));
  }
  async status() {
    try {
      const { models, identity } = await this.#metadata();
      const available = models.some(model => model.descriptor.available), legacy = models.find(model => model.descriptor.id === CODEBUDDY_MODEL.id && model.descriptor.available);
      return { authenticated: true, ready: available, modelAvailable: available,
        error: available ? null : '当前 CodeBuddy 账号目录没有可用的文本工具对话模型。',
        username: typeof identity?.username === 'string' ? identity.username.slice(0, 256) : null,
        transport: TRANSPORT, upstreamModel: legacy?.source.id ?? null, billing: billing(legacy?.source ?? {}), catalog: structuredClone(this.#catalog),
        cacheControl: { behavior: 'validated_hints_ignored', usage: 'upstream_reported_only' } };
    } catch (error) {
      let state = null;
      try { if (typeof this.client.status === 'function') state = await this.client.status(); } catch {}
      return { authenticated: state?.authenticated === true, ready: false, modelAvailable: false,
        username: typeof state?.identity?.username === 'string' ? state.identity.username.slice(0, 256) : null,
        error: error instanceof AdapterError ? error.message : '无法读取 CodeBuddy 模型目录。', transport: TRANSPORT,
        catalog: { ...(this.#catalog || publicCatalog(null)) },
        billing: { verified: false, employeeTokenMultiplier: null, sourceCredits: null, sourcePromotion: null } };
    }
  }
  async openCompactionForHandoff(token, { clientScope = null, signal } = {}) {
    clientScope = validateClientScope(clientScope);
    if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
    const thinkingState = await this.#state(), saved = thinkingState.openCompaction(token);
    if (typeof this.client.status !== 'function') throw new AdapterError('无法核对 CodeBuddy 历史摘要的原账号。', 503);
    const status = await this.client.status({ signal });
    if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
    if (status?.authenticated !== true) throw new AdapterError('CodeBuddy 员工账号尚未登录。', 401);
    if (saved.identity !== status.identity?.uid || (saved.client_scope ?? null) !== clientScope) {
      throw new AdapterError('历史摘要状态与当前 CodeBuddy 账号或接入用户不匹配，请使用原账号或新建会话。', 403);
    }
    // The source model is authenticated inside this purpose-specific packet.
    // A handoff transfers readable summary context, never hidden model reasoning.
    return saved.summary;
  }
  async continuationModelMatches(blocks, modelId, { clientScope = null, signal } = {}) {
    clientScope = validateClientScope(clientScope);
    if (aborted(signal)) throw new AdapterError('CodeBuddy 请求已取消。', 499);
    const alias = resolveCodeBuddyAlias(modelId);
    if (!alias || !Array.isArray(blocks)) invalid('CodeBuddy 思考接续或目标模型无效。');
    if (!blocks.length) return [];
    const thinkingState = await this.#state(), saved = [];
    for (let index = 0; index < blocks.length; index++) saved.push(thinkingState.open(blocks[index]));
    const metadata = await this.#metadata(signal);
    const selected = metadata.models.find(model => model.descriptor.id === alias.id);
    if (!selected?.descriptor.available) throw new AdapterError(selected?.descriptor.reason || '当前 CodeBuddy 账号目录未提供可用的所选模型。', 503);
    if (saved.some(state => state.identity !== metadata.identity?.uid || (state.client_scope ?? null) !== clientScope)) {
      throw new AdapterError('思考接续状态与当前 CodeBuddy 账号或接入用户不匹配，请使用原账号或新建会话。', 403);
    }
    // Only expose the comparison. Source reasoning and opaque metadata stay private.
    return saved.map(state => state.model === selected.source.id);
  }
  async request({ path, body, headers: _headers, signal, clientScope = null } = {}) {
    let parsedPath;
    try {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error();
      parsedPath = new URL(path, 'http://codebuddy.invalid').pathname;
    } catch { return errorResponse(new AdapterError('请求路径无效。')); }
    if (parsedPath === '/v1/messages/count_tokens') return errorResponse(new AdapterError('CodeBuddy 未提供已验证的 Token 计数接口。', 501));
    if (parsedPath !== '/v1/messages') return errorResponse(new AdapterError('CodeBuddy 未提供此接口。', 404));
    let request, model, identity, thinkingState;
    try {
      clientScope = validateClientScope(clientScope);
      thinkingState = await this.#state();
      const scopes = [], compactionScopes = [];
      // Validate client content before any authenticated catalog or model request.
      request = translate(body, 'pending-catalog-validation', block => {
        if (typeof block.signature === 'string' && block.signature.startsWith(CODEBUDDY_STATE_PREFIX)) {
          const state = thinkingState.open(block); scopes.push(state); return state;
        }
        return thinkingText(block);
      }, token => {
        const state = thinkingState.openCompaction(token); compactionScopes.push(state); return state.summary;
      });
      const metadata = await this.#metadata(signal);
      const selected = metadata.models.find(model => model.descriptor.id === request.alias.id);
      if (!selected?.descriptor.available) throw new AdapterError(selected?.descriptor.reason || '当前 CodeBuddy 账号目录未提供可用的所选模型。', 503);
      model = selected.source; identity = metadata.identity?.uid; request.body.model = model.id;
      if (request.alias.upstream !== null) {
        request.thinking = thinkingOptions(request.original, { model: selected.descriptor });
        Object.assign(request.body, request.thinking.body);
        if (selected.descriptor.maxOutputTokens && request.body.max_tokens > selected.descriptor.maxOutputTokens) invalid('max_tokens 超过当前账号目录的模型上限。');
        if (request.images && selected.descriptor.inputModalities?.includes('image') !== true) invalid('当前 CodeBuddy 模型目录未确认支持图片输入。');
        if (request.toolNames.size && selected.descriptor.supportsToolCall === false) invalid('当前 CodeBuddy 模型明确不支持工具调用。');
      }
      if (scopes.some(state => state.identity !== identity || state.model !== model.id || (state.client_scope ?? null) !== clientScope)) {
        throw new AdapterError('思考接续状态与当前 CodeBuddy 账号或模型不匹配，请使用原账号或新建会话。', 403);
      }
      if (compactionScopes.some(state => state.identity !== identity || state.model !== model.id || (state.client_scope ?? null) !== clientScope)) {
        throw new AdapterError('历史摘要状态与当前 CodeBuddy 账号、模型或接入用户不匹配，请使用原账号或新建会话。', 403);
      }
    } catch (error) { return errorResponse(aborted(signal) ? new AdapterError('CodeBuddy 请求已取消。', 499) : error); }
    const abort = new AbortController();
    const compactionModel = model.id;
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true }); if (aborted(signal)) abort.abort();
    const state = new Completion(request, (reasoning, extraFields) => {
      try { return thinkingState.seal({ reasoning, identity, model: model.id,
        ...(clientScope !== null ? { client_scope: clientScope } : {}),
        ...(extraFields !== undefined ? { extra_fields: extraFields } : {}) }); }
      catch { protocol(extraFields !== undefined ? 'CodeBuddy extra_fields 接续状态无效、超过大小限制或无法生成（extra_fields:'
        + (Array.isArray(extraFields) ? 'array' : typeof extraFields) + '）。' : 'CodeBuddy 思考接续状态超过大小限制或无法生成。'); }
    });
    let settleUsage;
    const bridgeUsage = new Promise(resolve => { settleUsage = () => resolve(structuredClone(state.usage)); });
    const decorate = response => {
      response.bridgeUsage = bridgeUsage; response.bridgeModel = model.id;
      if (response.ok) response.bridgeSealCompaction = summary => {
        if (abort.signal.aborted || !state.done || state.stopReason !== 'end_turn' || state.calls.size
            || typeof summary !== 'string' || summary !== state.blocks.filter(block => block.type === 'text').map(block => block.text).join('')) {
          protocol('CodeBuddy 未完整返回可验证的文本摘要，不能生成历史摘要状态。');
        }
        return thinkingState.sealCompaction({ summary, identity, model: compactionModel,
          ...(clientScope !== null ? { client_scope: clientScope } : {}) });
      };
      // These hints do not map to a verified CodeBuddy parameter. Never promise a cache hit.
      response.bridgeCacheControl = { ignoredHints: request.ignoredCacheHints, usage: 'upstream_reported_only' };
      return response;
    };
    const cleanup = () => { signal?.removeEventListener('abort', onAbort); settleUsage(); };
    let upstream;
    try {
      if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
      upstream = await this.client.chatCompletions({ body: request.body, signal: abort.signal, expectedIdentity: identity });
      if (!upstream?.ok) {
        await upstream?.body?.cancel().catch(() => {}); cleanup();
        return decorate(errorResponse(new AdapterError(`CodeBuddy 上游请求失败（HTTP ${upstream?.status ?? 502}）。`, upstream?.status >= 400 && upstream.status <= 599 ? upstream.status : 502)));
      }
      if (!upstream.body) throw new AdapterError('CodeBuddy 上游未返回内容。', 502);
    } catch (error) { cleanup(); return decorate(errorResponse(abort.signal.aborted ? new AdapterError('CodeBuddy 请求已取消。', 499) : error)); }
    const reader = upstream.body.getReader();
    const cancelRead = () => { void reader.cancel().catch(() => {}); };
    abort.signal.addEventListener('abort', cancelRead, { once: true });
    const events = async function* () {
      const parser = new EventParser(data => state.data(data));
      try {
        while (!state.done) {
          if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
          const { done, value } = await reader.read();
          if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
          if (done) { parser.end(); break; }
          parser.push(value);
          while (state.events.length) {
            if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
            yield state.events.shift();
          }
        }
        if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
        state.finish();
        while (state.events.length) {
          if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
          yield state.events.shift();
        }
      } finally {
        abort.signal.removeEventListener('abort', cancelRead);
        await reader.cancel().catch(() => {}); reader.releaseLock(); cleanup();
      }
    };
    const iterator = events();
    if (!request.streaming) {
      try { for await (const _event of iterator) {} return decorate(Response.json(state.message())); }
      catch (error) { return decorate(errorResponse(abort.signal.aborted ? new AdapterError('CodeBuddy 请求已取消。', 499) : error)); }
    }
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) controller.close(); else controller.enqueue(sse(result.value));
        } catch (error) {
          const source = codeBuddySourceError(abort.signal.aborted ? 'codebuddy_request_interrupted'
            : error instanceof AdapterError ? error.code : 'codebuddy_upstream_connection_error');
          controller.enqueue(sse({ type: 'error', error: { type: 'api_error', message: abort.signal.aborted
            ? 'CodeBuddy 请求已取消。' : error instanceof AdapterError ? error.message : 'CodeBuddy 上游连接已中断。',
          ...(source ? { code: source.code } : {}) } }));
          controller.close();
        }
      },
      async cancel() { abort.abort(); settleUsage(); void iterator.return().catch(() => {}); cleanup(); },
    }, { highWaterMark: 0 });
    return decorate(new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } }));
  }
}
