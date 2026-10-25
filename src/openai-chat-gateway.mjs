import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { AnthropicGateway } from './anthropic-gateway.mjs';
import { readBody } from './gateway.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
class ChatError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function invalid(message) { throw new ChatError(message); }
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function errorBody(message, status) {
  return { error: { message, type: status === 401 ? 'authentication_error'
    : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
  code: status >= 500 ? 'claude_unavailable' : 'invalid_request' } };
}
function content(value, role) {
  if (value === null || value === undefined) return [];
  const parts = typeof value === 'string' ? [{ type: 'text', text: value }] : value;
  if (!Array.isArray(parts)) invalid('Message content must be text or content parts.');
  const result = [];
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (!part.text) continue;
      if (result.at(-1)?.type === 'text') result.at(-1).text += part.text;
      else result.push({ type: 'text', text: part.text });
    } else if (role === 'user' && part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      const url = part.image_url.url;
      const embedded = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (embedded) result.push({ type: 'image', source: { type: 'base64', media_type: embedded[1], data: embedded[2] } });
      else {
        let address;
        try { address = new URL(url); } catch { invalid('Invalid image URL.'); }
        if (address.protocol !== 'https:' || address.username || address.password) invalid('Image URLs must use HTTPS.');
        result.push({ type: 'image', source: { type: 'url', url } });
      }
    } else invalid('This message content type is not supported by the Claude CLI adapter.');
  }
  return result;
}
function normalizeMessage(message) {
  if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) invalid('Invalid message role.');
  const normalized = { role: message.role, content: content(message.content, message.role) };
  if (message.role === 'tool') {
    if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) invalid('Tool results require tool_call_id.');
    normalized.tool_call_id = message.tool_call_id;
  }
  if (message.tool_calls !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) invalid('Invalid tool_calls.');
    normalized.tool_calls = message.tool_calls.map(call => {
      if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id ||
          typeof call.function?.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') invalid('Invalid function call.');
      let input;
      try { input = JSON.parse(call.function.arguments); } catch { invalid('Tool arguments must be valid JSON.'); }
      if (!object(input)) invalid('Tool arguments must be a JSON object.');
      return { id: call.id, name: call.function.name, input };
    });
  }
  return normalized;
}
function publicAssistant(blocks) {
  const message = { role: 'assistant', content: blocks.filter(block => block.type === 'text').map(block => block.text).join('') || null };
  const calls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input) } }));
  if (calls.length) message.tool_calls = calls;
  const thinking = blocks.filter(block => block.type === 'thinking').map(block => block.thinking).join('');
  if (thinking) message.reasoning_content = thinking;
  return message;
}
function usage(value) {
  const number = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0;
  const prompt = number('input_tokens') + number('cache_read_input_tokens') + number('cache_creation_input_tokens');
  const output = number('output_tokens');
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: number('cache_read_input_tokens') } };
}
function finishReason(reason) {
  const mapped = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' }[reason];
  if (!mapped) throw new ChatError('Claude returned an unsupported stop reason.', 502);
  return mapped;
}

/** Canonical assistant blocks (including thinking signatures) stay inside the VM.
 * Replaying the public OpenAI history restores the exact native CLI history.
 * This also preserves text/tool block ordering across parallel tool rounds. */
export class ChatHistoryStore {
  constructor({ path, maxBytes = 32 * 1024 * 1024, maxEntries = 256 } = {}) {
    this.path = path; this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.records = new Map();
  }
  async load() {
    if (!this.path) return;
    try {
      const raw = await readFile(this.path);
      if (raw.length > this.maxBytes) throw new Error();
      const value = JSON.parse(raw);
      if (!Array.isArray(value) || value.some(record => !/^[a-f0-9]{64}$/.test(record?.key) || !Array.isArray(record.messages))) throw new Error();
      for (const record of value.slice(-this.maxEntries)) this.records.set(record.key, record.messages);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('The private chat history index could not be loaded.'); }
  }
  keys(context, messages) {
    const hash = createHash('sha256').update(digest(context));
    return messages.map(message => { hash.update('\n' + JSON.stringify(stable(message))); return hash.copy().digest('hex'); });
  }
  restore(keys, messages) {
    for (let index = keys.length - 2; index >= 0; index--) {
      if (this.records.has(keys[index])) return { messages: structuredClone(this.records.get(keys[index])), rest: messages.slice(index + 1) };
    }
    return { messages: [], rest: messages };
  }
  async save(key, messages) {
    this.records.delete(key); this.records.set(key, structuredClone(messages));
    while (this.records.size > this.maxEntries) this.records.delete(this.records.keys().next().value);
    let data = JSON.stringify([...this.records].map(([key, messages]) => ({ key, messages })));
    while (Buffer.byteLength(data) > this.maxBytes && this.records.size > 1) {
      this.records.delete(this.records.keys().next().value);
      data = JSON.stringify([...this.records].map(([key, messages]) => ({ key, messages })));
    }
    if (Buffer.byteLength(data) > this.maxBytes) { this.records.delete(key); throw new ChatError('Chat history exceeds the private index limit.', 413); }
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    this.saving = (this.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, this.path);
    });
    await this.saving;
  }
}

export function translateChatRequest(body, store, identity = null) {
  if (!object(body)) invalid('The request must be a JSON object.');
  const allowed = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens',
    'max_completion_tokens', 'reasoning_effort', 'n', 'parallel_tool_calls', 'user', 'temperature', 'top_p',
    'frequency_penalty', 'presence_penalty', 'logprobs', 'logit_bias', 'stop', 'response_format', 'store', 'metadata']);
  if (Object.keys(body).some(key => !allowed.has(key))) invalid('The request contains a parameter not supported by the Claude CLI adapter.');
  for (const key of ['temperature', 'top_p', 'stop']) if (body[key] !== undefined && body[key] !== null) invalid(`${key} is not configurable through the Claude CLI subscription backend.`);
  for (const key of ['frequency_penalty', 'presence_penalty']) if (body[key] !== undefined && body[key] !== 0 && body[key] !== null) invalid(`${key} is not supported.`);
  if (body.logprobs || body.logit_bias && Object.keys(body.logit_bias).length || body.n !== undefined && body.n !== 1 ||
      body.parallel_tool_calls === false || body.response_format && body.response_format.type !== 'text') invalid('The requested generation mode is not supported by the Claude CLI adapter.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') ||
      body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean')) invalid('Invalid stream_options.');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 4096) invalid('messages must contain between 1 and 4096 messages.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined && body.max_tokens !== body.max_completion_tokens) invalid('Conflicting token limits.');
  const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 8192;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) invalid('The token limit must be a positive integer.');
  const normalized = body.messages.map(normalizeMessage);
  const system = normalized.filter(m => m.role === 'system' || m.role === 'developer').flatMap(m => m.content);
  if (system.some(part => part.type !== 'text')) invalid('System instructions must be text.');
  let tools;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 256) invalid('Invalid tools.');
    tools = body.tools.map(tool => {
      if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name) || tool.function.parameters !== undefined && !object(tool.function.parameters) ||
          tool.function.strict === true) invalid('Only standard function tools without strict mode are supported.');
      return { name: tool.function.name, ...(typeof tool.function.description === 'string' ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters ?? { type: 'object', properties: {} } };
    });
  }
  if (body.tool_choice !== undefined && !['auto', 'none'].includes(body.tool_choice)) invalid('Only auto and none tool_choice are supported.');
  if (body.tool_choice === 'none') tools = [];
  if (body.user !== undefined && (typeof body.user !== 'string' || body.user.length > 1024)) invalid('Invalid user identifier.');
  const effort = body.reasoning_effort;
  if (effort !== undefined && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) invalid('Unsupported reasoning_effort.');
  const translated = { model: body.model, max_tokens: maxTokens, stream: true,
    ...(system.length ? { system } : {}), ...(tools?.length ? { tools } : {}),
    thinking: { type: effort && effort !== 'none' ? 'adaptive' : 'disabled' },
    ...(effort && effort !== 'none' ? { output_config: { effort } } : {}) };
  const context = { model: body.model, system, tools: tools ?? [], maxTokens, effort: effort ?? 'none', identity, user: body.user ?? null };
  const keys = store.keys(context, normalized);
  const restored = store.restore(keys, normalized);
  const messages = restored.messages;
  for (const message of restored.rest) {
    if (['system', 'developer'].includes(message.role)) continue;
    let role = message.role, blocks = structuredClone(message.content);
    if (role === 'tool') { role = 'user'; blocks = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: blocks }]; }
    if (message.tool_calls) blocks.push(...message.tool_calls.map(call => ({ type: 'tool_use', ...call }))
      .map(({ type, id, name, input }) => ({ type, id, name, input })));
    if (!blocks.length) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  if (!messages.length || messages.at(-1).role !== 'user') invalid('The last message must contain user input or tool results.');
  translated.messages = messages;
  return { body: translated, normalized, context };
}

async function* events(body, signal) {
  if (!body) throw new ChatError('Claude returned an empty response.', 502);
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], frameBytes = 0, ended = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { ended = true; break; }
      buffer += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffer) + frameBytes > 8 * 1024 * 1024) throw new ChatError('Claude stream frame exceeds the size limit.', 502);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) { let event; try { event = JSON.parse(data.join('\n')); } catch { throw new ChatError('Claude returned an invalid stream event.', 502); } yield event; }
          data = []; frameBytes = 0;
        } else if (line.startsWith('data:')) { const value = line.slice(5).replace(/^ /, ''); data.push(value); frameBytes += Buffer.byteLength(value); }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() || data.length) throw new ChatError('Claude stream ended with an incomplete event.', 502);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OpenAIChatGateway {
  constructor({ gateway, history = new ChatHistoryStore() }) { this.gateway = gateway; this.history = history; }
  async handle(req, res) {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(new Error('Client disconnected.')); };
    req.once('aborted', disconnect); res.once('close', disconnect);
    try {
      this.gateway.authorize(req);
      if (req.method !== 'POST') throw new ChatError('This endpoint requires POST.', 405);
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new ChatError('Compressed requests are not supported.', 415);
      let source;
      try { source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(req, this.gateway.maxBodyBytes))); }
      catch (error) { if (error.status) throw error; invalid('Invalid JSON request.'); }
      const route = this.gateway.routes.get(source?.model);
      if (!route) invalid('The requested model is not configured.');
      const identity = req.headers['x-session-id'] ?? req.headers['x-claude-code-session-id'] ?? req.headers['session_id'] ?? null;
      const translated = translateChatRequest(source, this.history, identity);
      const response = await route.provider.request({ path: '/v1/messages', body: { ...translated.body, model: route.model.upstream ?? route.model.id },
        headers: { ...(identity ? { 'x-session-id': identity } : {}) }, signal: abort.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChatError(response.status === 503 ? 'Claude is unavailable. Complete Claude login inside the virtual machine first.'
          : 'The Claude relay rejected the request.', response.status);
      }
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000), blocks = new Map(), open = new Set();
      let started = false, stopped = false, stopReason = null, rawUsage = {}, toolIndex = 0;
      const write = async value => {
        abort.signal.throwIfAborted();
        if (!res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)) await once(res, 'drain', { signal: abort.signal });
      };
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: source.model,
        choices: [{ index: 0, delta, finish_reason: finish }] });
      if (source.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        res.flushHeaders();
      }
      for await (const event of events(response.body, abort.signal)) {
        if (stopped) throw new ChatError('Claude sent data after message_stop.', 502);
        if (event.type === 'error') throw new ChatError('Claude returned an error during streaming.', 502);
        if (event.type === 'ping') continue;
        if (event.type === 'message_start') {
          if (started || event.message?.role !== 'assistant' || event.message?.content?.length) throw new ChatError('Invalid Claude message_start.', 502);
          started = true; rawUsage = { ...event.message.usage };
          if (source.stream === true) await write(chunk({ role: 'assistant', content: '' }));
        } else if (event.type === 'content_block_start') {
          if (!started || !Number.isSafeInteger(event.index) || event.index < 0 || event.index > 4095 || blocks.has(event.index) ||
              !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(event.content_block?.type)) throw new ChatError('Invalid Claude content block.', 502);
          const block = { value: structuredClone(event.content_block), partial: '', toolIndex: null };
          blocks.set(event.index, block); open.add(event.index);
          if (block.value.type === 'tool_use') {
            block.toolIndex = toolIndex++;
            if (source.stream === true) await write(chunk({ tool_calls: [{ index: block.toolIndex, id: block.value.id,
              type: 'function', function: { name: block.value.name, arguments: '' } }] }));
          } else if (source.stream === true && block.value.type === 'text' && block.value.text) await write(chunk({ content: block.value.text }));
          else if (source.stream === true && block.value.type === 'thinking' && block.value.thinking) await write(chunk({ reasoning_content: block.value.thinking }));
        } else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index), delta = event.delta;
          if (!block || !open.has(event.index)) throw new ChatError('Claude delta has no open block.', 502);
          if (delta?.type === 'text_delta' && block.value.type === 'text' && typeof delta.text === 'string') {
            block.value.text = (block.value.text ?? '') + delta.text;
            if (source.stream === true) await write(chunk({ content: delta.text }));
          } else if (delta?.type === 'thinking_delta' && block.value.type === 'thinking' && typeof delta.thinking === 'string') {
            block.value.thinking = (block.value.thinking ?? '') + delta.thinking;
            if (source.stream === true) await write(chunk({ reasoning_content: delta.thinking }));
          } else if (delta?.type === 'signature_delta' && block.value.type === 'thinking' && typeof delta.signature === 'string') block.value.signature = (block.value.signature ?? '') + delta.signature;
          else if (delta?.type === 'input_json_delta' && block.value.type === 'tool_use' && typeof delta.partial_json === 'string') {
            block.partial += delta.partial_json;
            if (Buffer.byteLength(block.partial) > 8 * 1024 * 1024) throw new ChatError('Tool arguments exceed the size limit.', 502);
            if (source.stream === true) await write(chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] }));
          } else throw new ChatError('Unsupported Claude content delta.', 502);
        } else if (event.type === 'content_block_stop') {
          if (!open.delete(event.index)) throw new ChatError('Claude closed an unknown block.', 502);
          const block = blocks.get(event.index);
          if (block.value.type === 'tool_use') {
            if (block.partial) { try { block.value.input = JSON.parse(block.partial); } catch { throw new ChatError('Claude returned invalid tool arguments.', 502); } }
            if (!object(block.value.input)) throw new ChatError('Claude returned invalid tool arguments.', 502);
            if (!block.partial && source.stream === true) await write(chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: JSON.stringify(block.value.input) } }] }));
          }
        } else if (event.type === 'message_delta') {
          if (!started) throw new ChatError('Claude message_delta arrived before message_start.', 502);
          rawUsage = { ...rawUsage, ...event.usage }; stopReason = event.delta?.stop_reason ?? stopReason;
        } else if (event.type === 'message_stop') {
          if (!started || open.size || !stopReason) throw new ChatError('Claude response was incomplete.', 502);
          stopped = true;
        } else throw new ChatError('Unsupported Claude stream event.', 502);
      }
      if (!stopped) throw new ChatError('Claude stream ended before message_stop.', 502);
      const reason = finishReason(stopReason);
      const canonical = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block.value);
      const assistant = publicAssistant(canonical);
      const keys = this.history.keys(translated.context, [...translated.normalized, normalizeMessage(assistant)]);
      await this.history.save(keys.at(-1), [...translated.body.messages, { role: 'assistant', content: canonical }]);
      if (source.stream === true) {
        await write(chunk({}, reason));
        if (source.stream_options?.include_usage) await write({ id, object: 'chat.completion.chunk', created, model: source.model, choices: [], usage: usage(rawUsage) });
        await write('[DONE]'); res.end();
      } else json(res, 200, { id, object: 'chat.completion', created, model: source.model,
        choices: [{ index: 0, message: assistant, finish_reason: reason }], usage: usage(rawUsage) });
    } catch (error) {
      if (res.destroyed) return;
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      const message = error instanceof ChatError ? error.message : 'The Claude gateway request could not be completed.';
      if (res.headersSent) res.end(`data: ${JSON.stringify(errorBody(message, status))}\n\n`);
      else json(res, status, errorBody(message, status));
    } finally { req.removeListener('aborted', disconnect); res.removeListener('close', disconnect); }
  }
}

export function createClaudeGatewayServer(options, { history = new ChatHistoryStore() } = {}) {
  const gateway = new AnthropicGateway(options), chat = new OpenAIChatGateway({ gateway, history });
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') void chat.handle(req, res);
    else void gateway.handle(req, res);
  });
  server.gateway = gateway; server.chat = chat;
  return server;
}
