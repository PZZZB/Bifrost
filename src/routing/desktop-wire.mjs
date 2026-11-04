import { ClientStateCodec } from '../client-state.mjs';
import { BridgeError } from '../storage.mjs';

const MAX = 64 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = new Set(['reasoning', 'compaction', 'context_compaction', 'thinking', 'redacted_thinking']);
const modelHint = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,511}$/.test(value) && !value.includes('..');
const mismatch = () => new BridgeError('会话状态不属于当前模型来源、授权或会话，请先用原模型恢复历史。', 409, 'desktop_state_mismatch');
const protocolError = () => new BridgeError('模型来源返回了无法完整转发的内容。', 502, 'desktop_upstream_protocol');
const headersFor = response => {
  const headers = new Headers({ 'content-type': response.headers.get('content-type'), 'cache-control': 'no-store' });
  const retry = response.headers.get('retry-after');
  if (retry && /^(?:\d{1,6}|[A-Za-z0-9,: -]{1,80})$/.test(retry)) headers.set('retry-after', retry);
  return headers;
};

/** Wrap opaque state without decoding provider state, and map only protocol model fields. */
export class DesktopWire {
  #codec;
  #prefix;
  #selfDescribing;
  constructor({ secret, prefix = '', selfDescribingState = false } = {}) {
    if (typeof prefix !== 'string' || prefix && !/^[a-z][a-z0-9-]{0,79}:$/.test(prefix)) throw new TypeError('Invalid state prefix.');
    if (typeof selfDescribingState !== 'boolean') throw new TypeError('Invalid state envelope mode.');
    this.#codec = new ClientStateCodec({ secret }); this.#prefix = prefix; this.#selfDescribing = selfDescribingState;
  }
  #packet(value) {
    if (typeof value !== 'string' || value.length > MAX || !value.startsWith(this.#prefix)) throw mismatch();
    const raw = value.slice(this.#prefix.length);
    if (!raw.startsWith('v2.')) return null;
    try {
      const encoded = raw.slice(3);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw new Error();
      const packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(packet) || Object.keys(packet).length !== 5 || packet.version !== 2 || !modelHint(packet.model)
          || !['responses', 'messages', 'chat-completions'].includes(packet.protocol) || !kinds.has(packet.kind)
          || typeof packet.state !== 'string' || !packet.state) throw new Error();
      return packet;
    } catch { throw mismatch(); }
  }
  /** Untrusted routing hints only; openState must authenticate the located context. */
  stateHint(value) {
    const packet = this.#packet(value);
    return packet ? { version: 2, model: packet.model, protocol: packet.protocol, kind: packet.kind } : null;
  }
  openState(value, context, { kind } = {}) {
    return this.#state(value, context, 'open', kind);
  }
  #state(value, context, direction, kind) {
    if (direction === 'open') {
      const packet = this.#packet(value);
      if (!packet) return this.#codec.open(value.slice(this.#prefix.length), context.scope, `${context.id}:${context.protocol}`);
      if (packet.model !== context.id || packet.protocol !== context.protocol || kind != null && packet.kind !== kind) throw mismatch();
      let saved;
      try {
        saved = JSON.parse(this.#codec.open(packet.state, context.scope, `${context.id}:${context.protocol}`));
        if (!object(saved) || Object.keys(saved).length !== 3 || saved.version !== 2 || saved.kind !== packet.kind || typeof saved.value !== 'string') throw new Error();
      } catch { throw mismatch(); }
      return saved.value;
    }
    if (this.#selfDescribing) {
      if (typeof value !== 'string' || !modelHint(context.id) || !kinds.has(kind)) throw protocolError();
      const state = this.#codec.seal(JSON.stringify({ version: 2, kind, value }), context.scope, `${context.id}:${context.protocol}`);
      const packet = { version: 2, model: context.id, protocol: context.protocol, kind, state };
      const result = this.#prefix + 'v2.' + Buffer.from(JSON.stringify(packet)).toString('base64url');
      if (result.length > MAX) throw protocolError();
      return result;
    }
    return this.#prefix + this.#codec.seal(value, context.scope, `${context.id}:${context.protocol}`);
  }
  input(body, context) {
    const copy = structuredClone(body);
    if (context.protocol === 'messages') {
      for (const message of Array.isArray(copy.messages) ? copy.messages : []) {
        for (const block of Array.isArray(message?.content) ? message.content : []) {
          if (block?.type === 'thinking' && block.signature) block.signature = this.#state(block.signature, context, 'open', 'thinking');
          if (block?.type === 'redacted_thinking' && block.data) block.data = this.#state(block.data, context, 'open', 'redacted_thinking');
        }
      }
    } else if (context.protocol === 'responses') {
      for (const item of Array.isArray(copy.input) ? copy.input : []) {
        if (['reasoning', 'compaction', 'context_compaction'].includes(item?.type) && item.encrypted_content != null) {
          item.encrypted_content = this.#state(item.encrypted_content, context, 'open', item.type);
        }
      }
    }
    return copy;
  }
  #output(value, context) {
    if (!object(value)) throw protocolError();
    const rewriteModel = item => { if (object(item) && typeof item.model === 'string') item.model = context.id; };
    rewriteModel(value);
    if (context.protocol === 'messages') {
      if (value.type === 'message_start') rewriteModel(value.message);
      const block = item => {
        if (item?.type === 'thinking' && item.signature) item.signature = this.#state(item.signature, context, 'seal', 'thinking');
        if (item?.type === 'redacted_thinking' && item.data) item.data = this.#state(item.data, context, 'seal', 'redacted_thinking');
      };
      for (const item of Array.isArray(value.content) ? value.content : []) block(item);
      if (value.type === 'content_block_start') block(value.content_block);
    } else if (context.protocol === 'responses') {
      rewriteModel(value.response);
      const item = value => {
        if (['reasoning', 'compaction', 'context_compaction'].includes(value?.type) && value.encrypted_content != null) {
          value.encrypted_content = this.#state(value.encrypted_content, context, 'seal', value.type);
        }
      };
      item(value.item);
      for (const entry of Array.isArray(value.output) ? value.output : []) item(entry);
      for (const entry of Array.isArray(value.response?.output) ? value.response.output : []) item(entry);
    }
    return value;
  }
  async response(response, context) {
    if (!(response instanceof Response) || !response.body) throw protocolError();
    const type = response.headers.get('content-type') ?? '';
    const headers = headersFor(response);
    if (type.includes('application/json')) {
      const chunks = []; let size = 0;
      for await (const bytes of response.body) {
        size += bytes.byteLength;
        if (size > MAX) throw protocolError();
        chunks.push(bytes);
      }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw protocolError(); }
      return new Response(JSON.stringify(this.#output(data, context)), { status: response.status, headers });
    }
    if (!type.includes('text/event-stream')) { await response.body.cancel(); throw protocolError(); }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
    const signatures = new Map();
    let pending = '', ended = false;
    const encode = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
    const frame = raw => {
      const lines = raw.split(/\r?\n/), text = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!text || text === '[DONE]') {
        if (text === '[DONE]' && signatures.size) throw protocolError();
        return `${raw}\n\n`;
      }
      let data;
      try { data = JSON.parse(text); } catch { throw protocolError(); }
      let prefix = '';
      if (context.protocol === 'messages') {
        if (data.type === 'content_block_start' && data.content_block?.type === 'thinking') {
          if (!Number.isSafeInteger(data.index) || signatures.has(data.index)) throw protocolError();
          signatures.set(data.index, data.content_block.signature || ''); data.content_block.signature = '';
        } else if (data.type === 'content_block_delta' && data.delta?.type === 'signature_delta') {
          if (!signatures.has(data.index) || typeof data.delta.signature !== 'string') throw protocolError();
          const signature = signatures.get(data.index) + data.delta.signature;
          if (signature.length > MAX / 2) throw protocolError();
          signatures.set(data.index, signature); return '';
        } else if (data.type === 'content_block_stop' && signatures.has(data.index)) {
          const signature = signatures.get(data.index); signatures.delete(data.index);
          if (signature) prefix = encode({ type: 'content_block_delta', index: data.index,
            delta: { type: 'signature_delta', signature: this.#state(signature, context, 'seal', 'thinking') } });
        } else if (data.type === 'message_stop' && signatures.size) throw protocolError();
      }
      const metadata = lines.filter(line => !line.startsWith('data:'));
      return prefix + `${metadata.length ? metadata.join('\n') + '\n' : ''}data: ${JSON.stringify(this.#output(data, context))}\n\n`;
    };
    return new Response(new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const match = /\r?\n\r?\n/.exec(pending);
            if (match) {
              const raw = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
              const rewritten = frame(raw);
              if (rewritten) { controller.enqueue(encoder.encode(rewritten)); return; }
              continue;
            }
            if (ended) {
              if (pending.trim() || signatures.size) throw protocolError();
              reader.releaseLock(); controller.close(); return;
            }
            const next = await reader.read();
            if (next.done) { ended = true; pending += decoder.decode(); }
            else pending += decoder.decode(next.value, { stream: true });
            if (Buffer.byteLength(pending) > MAX) throw protocolError();
          }
        } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); },
    }), { status: response.status, headers });
  }
}
