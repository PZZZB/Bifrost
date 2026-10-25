import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BridgeError } from './storage.mjs';
import { clientScope } from './client-scope.mjs';

const PREFIX = 'bifrost-client-state-v1:';
const MAX = 48 * 1024 * 1024;
const invalid = () => new BridgeError('会话状态不属于当前接入用户或模型，或已失效。请新建聊天。', 409, 'client_state_invalid');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicError = () => ({ type: 'server_error', code: 'client_upstream_failed',
  message: '所选模型未能完成请求，请联系管理员查看诊断。', param: null });
const failedEvent = value => ['error', 'response.error', 'response.failed'].includes(value?.type);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function publicUsage(value) {
  if (!object(value)) return null;
  const result = { input_tokens: count(value.input_tokens), output_tokens: count(value.output_tokens), total_tokens: count(value.total_tokens) };
  for (const [field, names] of [['input_tokens_details', ['cached_tokens', 'cache_write_tokens']], ['output_tokens_details', ['reasoning_tokens']]]) {
    if (object(value[field])) result[field] = Object.fromEntries(names.filter(name => count(value[field][name]) !== null).map(name => [name, value[field][name]]));
  }
  return result;
}
function redactFailure(value) {
  if (!object(value)) return value;
  const hasError = value.error != null, failed = failedEvent(value) || value.status === 'failed' || value.response?.status === 'failed';
  if (['error', 'response.error'].includes(value.type)) {
    const copy = { type: value.type };
    if (Number.isSafeInteger(value.sequence_number) && value.sequence_number >= 0) copy.sequence_number = value.sequence_number;
    // Both top-level Responses error events and nested error envelopes occur.
    // Rebuild either shape; provider-specific fields never cross this boundary.
    if (hasError) copy.error = publicError();
    else Object.assign(copy, { code: publicError().code, message: publicError().message, param: null });
    if (value.usage != null) copy.usage = publicUsage(value.usage);
    return copy;
  }
  if (hasError && value.type === undefined && value.status === undefined && value.response === undefined && value.object !== 'response') {
    return { error: publicError(), ...(value.usage != null ? { usage: publicUsage(value.usage) } : {}) };
  }
  if (hasError || value.status === 'failed') value.error = publicError();
  if (failed || hasError) {
    for (const field of ['message', 'code', 'param', 'details', 'stack', 'cause']) delete value[field];
    if (value.usage != null) value.usage = publicUsage(value.usage);
  }
  if (object(value.response)) value.response = redactFailure(value.response);
  return value;
}

/** Bind vendor opaque state to a gateway user without retaining conversation text. */
export class ClientStateCodec {
  #key;
  constructor({ secret } = {}) {
    if (typeof secret !== 'string' || secret.length < 40) throw new TypeError('Client state secret is required.');
    this.#key = createHash('sha256').update(`bifrost-client-state-v1\0${secret}`).digest();
  }
  aad(scope, model) {
    if (!clientScope(scope) || typeof model !== 'string' || !model || model.length > 512) throw invalid();
    return Buffer.from(JSON.stringify([scope, model]));
  }
  seal(value, scope, model) {
    if (typeof value !== 'string' || value.length > MAX) throw invalid();
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(this.aad(scope, model));
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  open(value, scope, model) {
    try {
      if (typeof value !== 'string' || !value.startsWith(PREFIX) || value.length > MAX * 2) throw invalid();
      const encoded = value.slice(PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalid();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.length <= 28 || bytes.toString('base64url') !== encoded) throw invalid();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, 12));
      decipher.setAAD(this.aad(scope, model)); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw invalid(); }
  }
  input(body, scope) {
    const copy = structuredClone(body);
    if (copy.previous_response_id != null || copy.conversation != null || copy.prompt != null || copy.background === true || copy.store === true) {
      throw new BridgeError('接入用户请使用显式消息历史及 store=false，不支持共享上游的服务端会话。', 400, 'client_server_state_unsupported');
    }
    copy.store = false;
    const content = blocks => {
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (!['input_text', 'output_text', 'input_image'].includes(block?.type) || block.file_id != null) {
          throw new BridgeError('接入用户仅支持显式文本和图片内容，不支持共享上游文件或资源引用。', 400, 'client_resource_reference_unsupported');
        }
      }
    };
    const tools = declarations => {
      if (!Array.isArray(declarations)) return;
      for (const tool of declarations) {
        if (tool?.type === 'namespace') tools(tool.tools);
        else if (!['function', 'custom'].includes(tool?.type) && !(tool?.type === 'tool_search' && tool.execution === 'client')) {
          throw new BridgeError('接入用户只开放客户端工具，不开放共享账号的托管工具或资源。', 400, 'client_hosted_tool_unsupported');
        }
      }
    };
    tools(copy.tools);
    if (Array.isArray(copy.input)) for (const item of copy.input) {
      if (!['message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', undefined].includes(item?.type)
        || item?.type === undefined && !['system', 'developer', 'user', 'assistant'].includes(item?.role)) {
        throw new BridgeError('此入口不支持上游消息、文件或容器资源引用。', 400, 'client_resource_reference_unsupported');
      }
      content(item?.content); content(item?.output);
      if (item?.encrypted_content != null) item.encrypted_content = this.open(item.encrypted_content, scope, copy.model);
    }
    return copy;
  }
  output(value, scope, model) {
    const copy = redactFailure(structuredClone(value));
    const visit = item => {
      if (item && typeof item === 'object' && typeof item.encrypted_content === 'string') {
        item.encrypted_content = this.seal(item.encrypted_content, scope, model);
      }
    };
    visit(copy.item);
    for (const item of copy.output ?? []) visit(item);
    for (const item of copy.response?.output ?? []) visit(item);
    return copy;
  }
  async response(response, scope, model) {
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const data = await response.json();
      return Response.json(this.output(data, scope, model), { status: response.status });
    }
    if (!response.body || !type.includes('text/event-stream')) throw new BridgeError('上游返回了未适配的响应格式。', 502, 'client_upstream_protocol');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
    const codec = this;
    let pending = '', ended = false;
    function frame(raw) {
      const lines = raw.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return `${raw}\n\n`;
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new BridgeError('上游流响应格式无效。', 502, 'client_upstream_protocol'); }
      const sanitized = codec.output(parsed, scope, model);
      const metadata = failedEvent(parsed) ? [`event: ${sanitized.type}`] : lines.filter(line => !line.startsWith('data:'));
      return `${metadata.length ? metadata.join('\n') + '\n' : ''}data: ${JSON.stringify(sanitized)}\n\n`;
    }
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const match = /\r?\n\r?\n/.exec(pending);
            if (match) {
              const raw = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
              controller.enqueue(encoder.encode(frame(raw))); return;
            }
            if (ended) {
              if (pending.trim()) throw new BridgeError('上游响应在完整事件前结束。', 502, 'client_upstream_protocol');
              reader.releaseLock(); controller.close(); return;
            }
            const next = await reader.read();
            if (next.done) { ended = true; pending += decoder.decode(); }
            else pending += decoder.decode(next.value, { stream: true });
            if (pending.length > MAX) throw new BridgeError('上游响应事件超过大小限制。', 502, 'client_upstream_protocol');
          }
        } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
    }), { status: response.status, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
  }
}
