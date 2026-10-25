const MAX_FRAME = 16 * 1024 * 1024;
const MAX_JSON = 64 * 1024 * 1024;
const MAX_TAIL = 32 * 1024 * 1024;
const REJECTED = new Set([400, 401, 403, 404, 422, 429]);
const METERS = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const protocolError = () => new Error('Client usage stream is malformed or incomplete.');
const abortError = () => new DOMException('Client usage stream was cancelled.', 'AbortError');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function optionalCount(value) {
  if (value === undefined || value === null) return 0;
  return count(value) ? value : null;
}

/** Public counts use the same canonical fields as UsageLedger. */
function normalizedUsage(value, format = 'responses') {
  if (!object(value)) return null;
  const input = value[format === 'chat' ? 'prompt_tokens' : 'input_tokens'];
  const output = value[format === 'chat' ? 'completion_tokens' : 'output_tokens'];
  if (!count(input) || !count(output) || !count(input + output)) return null;
  const inputDetails = value[format === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details'];
  const outputDetails = value[format === 'chat' ? 'completion_tokens_details' : 'output_tokens_details'];
  if (inputDetails != null && !object(inputDetails) || outputDetails != null && !object(outputDetails)) return null;
  const cached = optionalCount(inputDetails?.cached_tokens), written = optionalCount(inputDetails?.cache_write_tokens);
  const reasoning = optionalCount(outputDetails?.reasoning_tokens);
  const total = value.total_tokens ?? input + output;
  if (![cached, written, reasoning].every(count) || !count(total) || total !== input + output
    || cached + written > input || reasoning > output) return null;
  // Some protocol adapters emit zero-filled envelopes before real usage exists.
  // Such an envelope cannot establish that a model invocation was free.
  if (total === 0) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total,
    cachedInputTokens: cached, cacheWriteTokens: written, reasoningTokens: reasoning };
}

function messageUsage(value) {
  if (!object(value) || !count(value.input_tokens) || !count(value.output_tokens)) return null;
  const cached = optionalCount(value.cache_read_input_tokens), written = optionalCount(value.cache_creation_input_tokens);
  if (![cached, written].every(count) || !count(value.input_tokens + cached + written)) return null;
  return normalizedUsage({ input_tokens: value.input_tokens + cached + written, output_tokens: value.output_tokens,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: written } });
}

function stopReason(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Keep original bytes, including line endings, while bounding each SSE frame. */
class Frames {
  parts = [];
  bytes = 0;
  lineBytes = 0;
  afterCR = false;
  boundary = false;
  first = true;
  append(value) {
    if (!value.byteLength) return;
    this.bytes += value.byteLength;
    if (this.bytes > MAX_FRAME) throw protocolError();
    this.parts.push(value);
  }
  take() {
    const bytes = Buffer.concat(this.parts, this.bytes);
    this.parts = []; this.bytes = 0; this.lineBytes = 0; this.afterCR = false; this.boundary = false;
    return bytes;
  }
  *push(value) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (this.bytes + index - start > MAX_FRAME) throw protocolError();
      const byte = bytes[index];
      if (this.afterCR) {
        if (byte === 10) {
          this.afterCR = false;
          if (this.boundary) { this.append(bytes.subarray(start, index + 1)); start = index + 1; yield this.take(); }
          continue;
        }
        this.afterCR = false;
        if (this.boundary) { this.append(bytes.subarray(start, index)); start = index; yield this.take(); }
      }
      if (byte === 13) {
        this.boundary = this.lineBytes === 0; this.lineBytes = 0; this.afterCR = true;
      } else if (byte === 10) {
        if (this.lineBytes === 0) { this.append(bytes.subarray(start, index + 1)); start = index + 1; yield this.take(); }
        else this.lineBytes = 0;
      } else this.lineBytes += 1;
    }
    this.append(bytes.subarray(start));
  }
  *end() {
    // A bare CR also terminates a line in SSE.
    if (this.boundary && this.afterCR) yield this.take();
    if (this.bytes) throw protocolError();
  }
  parse(bytes) {
    let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (this.first) { this.first = false; text = text.replace(/^\uFEFF/, ''); }
    let event = '', data = [], hasData = false;
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':'), key = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'event') event = value;
      else if (key === 'data') { data.push(value); hasData = true; }
    }
    if (!hasData) return null;
    const content = data.join('\n');
    if (content === '[DONE]') return { done: true, event };
    let value;
    try { value = JSON.parse(content); } catch { throw protocolError(); }
    if (!object(value)) throw protocolError();
    return { value, event };
  }
}

class Protocol {
  constructor(protocol) {
    this.protocol = protocol; this.terminal = null; this.done = false; this.hold = false;
    this.usage = null; this.invalidUsage = false; this.started = false; this.modelSeen = false;
    this.choices = new Map(); this.messageCounts = {}; this.messageStopped = false;
    this.blocks = new Set(); this.finalOutput = false;
  }
  candidate(value, format = this.protocol) {
    const usage = format === 'messages' ? messageUsage(value) : normalizedUsage(value, format);
    if (!usage) this.invalidUsage = true;
    else if (this.usage && Object.keys(usage).some(key => usage[key] < this.usage[key])) this.invalidUsage = true;
    else this.usage = usage;
    return usage;
  }
  finish(kind, signature, usage) {
    if (this.terminal) {
      if (this.terminal.kind !== kind || !same(this.terminal.signature, signature)) throw protocolError();
      return;
    }
    this.terminal = { kind, signature }; this.hold = true;
    if (usage !== undefined) this.candidate(usage);
  }
  accept(frame) {
    if (!frame) return;
    if (frame.done) {
      if (this.protocol === 'chat' && !this.terminal) {
        if (!this.choices.size || [...this.choices.values()].some(value => !value)) throw protocolError();
        this.finish('completed', null);
      } else if (!this.terminal) throw protocolError();
      this.done = true; this.hold = true; return;
    }
    if (this.done) throw protocolError();
    const value = frame.value;
    if (frame.event && typeof value.type === 'string' && frame.event !== value.type) throw protocolError();
    if (this.protocol === 'responses') this.responses(value);
    else if (this.protocol === 'chat') this.chat(value);
    else this.messages(value);
  }
  error(value) {
    if (this.terminal) throw protocolError();
    this.finish('failed', value, value.usage);
  }
  responses(value) {
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) {
      const status = value.type.slice('response.'.length);
      if (!object(value.response) || value.response.status !== status) throw protocolError();
      this.modelSeen = true;
      this.finish(status, value.response, value.response.usage); return;
    }
    if (['error', 'response.error'].includes(value.type) || value.error != null) { this.error(value); return; }
    if (this.terminal || typeof value.type !== 'string') throw protocolError();
    this.modelSeen ||= value.type !== 'response.created';
  }
  chat(value) {
    if (value.error != null) { this.error(value); return; }
    if (this.terminal || !Array.isArray(value.choices)) throw protocolError();
    this.modelSeen = true;
    for (const choice of value.choices) {
      if (!object(choice) || !Number.isSafeInteger(choice.index) || choice.index < 0) throw protocolError();
      const finished = this.choices.get(choice.index);
      if (finished && !same(finished, choice.finish_reason)) throw protocolError();
      if (choice.finish_reason != null && !stopReason(choice.finish_reason)) throw protocolError();
      if (finished && object(choice.delta) && Object.values(choice.delta).some(value => value != null && value !== '')) throw protocolError();
      this.choices.set(choice.index, choice.finish_reason ?? false);
    }
    const finished = this.choices.size && [...this.choices.values()].every(Boolean);
    if (finished) {
      this.hold = true;
      // Early streaming usage often contains placeholders. Only terminal usage
      // and the final choices=[] usage envelope can establish billable counts.
      if (value.usage != null) this.candidate(value.usage, 'chat');
    } else if (value.choices.length === 0 && value.usage != null) throw protocolError();
  }
  mergeMessageUsage(value, final = false) {
    if (value == null) return;
    if (!object(value)) { this.invalidUsage = true; return; }
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (value[key] == null) continue;
      if (!count(value[key]) || this.messageCounts[key] !== undefined && value[key] < this.messageCounts[key]) this.invalidUsage = true;
      else this.messageCounts[key] = value[key];
    }
    if (final && count(value.output_tokens)) this.finalOutput = true;
  }
  messages(value) {
    if (value.type === 'error' || value.error != null) { this.error(value); return; }
    if (value.type === 'message_stop') {
      if (!this.started || !this.messageStopped || this.blocks.size) throw protocolError();
      this.finish('completed', null);
      if (this.finalOutput) this.candidate(this.messageCounts, 'messages');
      return;
    }
    if (this.terminal) throw protocolError();
    if (value.type === 'ping') return;
    if (value.type === 'message_start') {
      if (this.started || !object(value.message)) throw protocolError();
      this.started = true; this.modelSeen = true; this.mergeMessageUsage(value.message.usage); return;
    }
    if (!this.started) throw protocolError();
    if (value.type === 'message_delta') {
      if (!object(value.delta) || this.blocks.size || value.delta.stop_reason != null && !stopReason(value.delta.stop_reason)) throw protocolError();
      if (this.messageStopped && value.delta.stop_reason !== this.messageStopReason) throw protocolError();
      if (value.delta.stop_reason != null) {
        this.messageStopped = true; this.messageStopReason = value.delta.stop_reason; this.hold = true;
      }
      this.mergeMessageUsage(value.usage, true); return;
    }
    if (this.messageStopped) throw protocolError();
    if (['content_block_start', 'content_block_delta', 'content_block_stop'].includes(value.type)) {
      if (!Number.isSafeInteger(value.index) || value.index < 0) throw protocolError();
      if (value.type === 'content_block_start') {
        if (this.blocks.has(value.index)) throw protocolError(); this.blocks.add(value.index);
      } else if (!this.blocks.has(value.index)) throw protocolError();
      else if (value.type === 'content_block_stop') this.blocks.delete(value.index);
      return;
    }
    throw protocolError();
  }
  json(value) {
    if (!object(value)) throw protocolError();
    if (value.error != null || value.type === 'error') { this.error(value); return; }
    if (this.protocol === 'responses') {
      if (!['completed', 'incomplete', 'failed'].includes(value.status)) throw protocolError();
      this.modelSeen = true; this.finish(value.status, value, value.usage);
    } else if (this.protocol === 'chat') {
      if (!Array.isArray(value.choices) || !value.choices.length
        || value.choices.some(choice => !object(choice) || !stopReason(choice.finish_reason))) throw protocolError();
      this.modelSeen = true; this.finish('completed', null, undefined); this.candidate(value.usage, 'chat'); this.done = true;
    } else {
      if (value.type !== 'message' || !stopReason(value.stop_reason)) throw protocolError();
      this.modelSeen = true; this.finish('completed', null, undefined); this.candidate(value.usage, 'messages');
    }
  }
  complete() {
    return Boolean(this.terminal) && (this.protocol !== 'chat' || this.done || this.terminal.kind === 'failed');
  }
}

/** Obtain settlement completion and an idempotent cancellation fallback. */
export function getClientMeter(response) { return METERS.get(response) ?? null; }

/**
 * Observe usage without rewriting protocol bytes or adding completion markers.
 * Terminal SSE frames and all JSON bytes wait for durable onResult completion.
 * bridgeUsage, when present, is authoritative: null never falls back to wire
 * placeholders. A failed or interrupted stream always remains unresolved.
 */
export function meterClientResponse(response, { protocol, onResult, signal } = {}) {
  if (!(response instanceof Response) || !['responses', 'chat', 'messages'].includes(protocol) || typeof onResult !== 'function') {
    throw new TypeError('A Response, supported protocol and onResult callback are required.');
  }
  const parser = new Protocol(protocol), reader = response.body?.getReader();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const isSse = contentType.includes('text/event-stream'), isJson = contentType.includes('application/json');
  const hasAuthority = Object.hasOwn(response, 'bridgeUsage');
  const authority = hasAuthority ? Promise.resolve(response.bridgeUsage).then(value => normalizedUsage(value), () => null) : null;
  let settlePromise = null, stopped = false, controller = null, sourceDone = false, resolveFinish, rejectFinish;
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const finish = new Promise((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
  // A caller may only consume the body. Persist errors still surface there.
  finish.catch(() => {});
  const rejected = () => REJECTED.has(response.status) && !parser.modelSeen && !parser.usage;
  const settle = result => {
    if (settlePromise) return settlePromise;
    signal?.removeEventListener('abort', onAbort);
    settlePromise = Promise.resolve().then(() => onResult(structuredClone(result))).then(() => {
      resolveFinish(result); return result;
    }, error => { rejectFinish(error); throw error; });
    settlePromise.catch(() => {});
    return settlePromise;
  };
  const cancel = async reason => {
    if (settlePromise) return;
    stopped = true;
    resolveCancelled(null);
    const cancelling = reader?.cancel(reason).catch(() => {});
    controller?.error(reason instanceof Error ? reason : abortError());
    try { await settle({ usage: null, status: rejected() ? 'rejected' : 'unresolved' }); }
    finally { void cancelling?.finally(() => { try { reader.releaseLock(); } catch {} }); }
  };
  const onAbort = () => { void cancel(abortError()).catch(() => {}); };
  const finalResult = async () => {
    if (stopped) return { usage: null, status: rejected() ? 'rejected' : 'unresolved' };
    if (!parser.complete()) return { usage: null, status: rejected() ? 'rejected' : 'unresolved' };
    let usage = parser.invalidUsage ? null : parser.usage;
    if (hasAuthority) usage = await Promise.race([authority, cancelled]);
    if (stopped) return { usage: null, status: rejected() ? 'rejected' : 'unresolved' };
    return { usage, status: usage ? 'completed' : rejected() ? 'rejected' : 'unresolved' };
  };
  const stream = async function* () {
    try {
      if (!reader) { await settle({ usage: null, status: rejected() ? 'rejected' : 'unresolved' }); return; }
      if (isSse) {
        const frames = new Frames(), held = [];
        let heldBytes = 0;
        const accept = frame => {
          parser.accept(frames.parse(frame));
          if (!parser.hold) return false;
          heldBytes += frame.byteLength;
          if (heldBytes > MAX_TAIL) throw protocolError();
          held.push(frame); return true;
        };
        while (true) {
          if (stopped) throw abortError();
          const next = await reader.read();
          if (stopped) throw abortError();
          if (next.done) { sourceDone = true; break; }
          if (!(next.value instanceof Uint8Array)) throw protocolError();
          for (const frame of frames.push(next.value)) if (!accept(frame)) yield frame;
        }
        for (const frame of frames.end()) if (!accept(frame)) yield frame;
        if (!parser.complete() && !rejected()) throw protocolError();
        await settle(await finalResult());
        if (stopped) return;
        for (const frame of held) yield frame;
      } else {
        const parts = []; let bytes = 0;
        while (true) {
          if (stopped) throw abortError();
          const next = await reader.read();
          if (stopped) throw abortError();
          if (next.done) { sourceDone = true; break; }
          if (!(next.value instanceof Uint8Array)) throw protocolError();
          bytes += next.value.byteLength; if (bytes > MAX_JSON) throw protocolError(); parts.push(next.value);
        }
        if (isJson && bytes) {
          let value;
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes))); }
          catch { throw protocolError(); }
          parser.json(value);
        } else if (!rejected()) throw protocolError();
        await settle(await finalResult());
        if (stopped) return;
        for (const part of parts) yield part;
      }
    } catch (error) {
      await settle({ usage: null, status: rejected() ? 'rejected' : 'unresolved' });
      throw error;
    } finally {
      if (!sourceDone) await reader?.cancel().catch(() => {});
      try { reader?.releaseLock(); } catch {}
    }
  }();
  let output;
  if ([204, 205, 304].includes(response.status) || response.status === 0) {
    // Model endpoints do not return these statuses; callers can await finish
    // before relaying a bodyless transport rejection.
    output = response;
    void cancel().catch(() => {});
  } else {
    output = new Response(new ReadableStream({
      start(value) { controller = value; },
      async pull(value) {
        try { const next = await stream.next(); if (next.done) value.close(); else value.enqueue(next.value); }
        catch (error) { value.error(error); }
      },
      async cancel(reason) { await cancel(reason); void stream.return().catch(() => {}); },
    }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  METERS.set(output, Object.freeze({ finish, cancel }));
  if (!settlePromise) {
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  }
  return output;
}
