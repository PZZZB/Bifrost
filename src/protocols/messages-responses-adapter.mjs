import { createHmac, randomUUID } from 'node:crypto';
import { ClientStateCodec } from '../client-state.mjs';
import { meterClientResponse, getClientMeter } from '../client-meter.mjs';
import { translateResponses, ResponsesConversion, MessagesSseParser, messagesJsonEvents,
  encodeResponsesEvent, AdapterError, errorData, errorResponse } from './responses-messages.mjs';

const MAX = 64 * 1024 * 1024;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
function thinkingBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('思考接续状态无效。', 409);
  if (value.type === 'thinking' && typeof value.thinking === 'string' && typeof value.signature === 'string' && value.signature) return value;
  if (value.type === 'redacted_thinking' && typeof value.data === 'string' && value.data) return value;
  throw new AdapterError('思考接续状态无效。', 409);
}

/** Responses ↔ Messages. Independent of Codex, source identity, URLs and billing. */
export class MessagesResponsesAdapter {
  #request; #codec; #marker = `bifrost-priority-${randomUUID()}`;
  #toolMetadata = new Map(); #digest;
  constructor({ requestMessages, stateSecret } = {}) {
    if (typeof requestMessages !== 'function') throw new TypeError('A scoped Messages transport is required.');
    this.#request = requestMessages; this.#codec = new ClientStateCodec({ secret: stateSecret });
    this.#digest = value => createHmac('sha256', stateSecret).update(JSON.stringify(stable(value))).digest('hex');
  }
  async request({ body, scope, session, signal, capabilities = {} } = {}) {
    const abort = new AbortController(), linked = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    let translated, upstream, reader, metered;
    const profile = { model: body?.model, label: 'Bifrost', idPrefix: 'bifrost_messages', reasoningIdPrefix: 'rs_bifrost_messages_',
      allowedEfforts: capabilities.reasoningEfforts ?? [], defaultReasoning: {}, allowRedactedThinking: true,
      openState: value => {
        let block;
        try { block = JSON.parse(this.#codec.open(value, scope, body.model)); } catch { throw new AdapterError('思考接续状态不属于当前来源、会话或授权。', 409); }
        return [thinkingBlock(block)];
      },
      sealState: block => this.#codec.seal(JSON.stringify(thinkingBlock(block)), scope, body.model) };
    // Responses has no field for Anthropic's direct-caller annotation. Keep only
    // that observed annotation in a bounded, scoped exact-replay map. IDs, names
    // and arguments must still match; no defaults or invented tool results.
    const key = block => this.#digest([scope, body.model, block.id]);
    const identity = block => this.#digest([block.type, block.id, block.name, block.input]);
    profile.observeTool = block => {
      if (block.caller === undefined) return;
      if (!block.caller || block.caller.type !== 'direct' || Object.keys(block.caller).length !== 1) {
        throw new AdapterError('此工具来源注记尚不能完整接续。', 502);
      }
      const id = key(block);
      this.#toolMetadata.delete(id);
      this.#toolMetadata.set(id, { identity: identity(block), expires: Date.now() + 6 * 60 * 60 * 1000 });
      while (this.#toolMetadata.size > 4096) this.#toolMetadata.delete(this.#toolMetadata.keys().next().value);
    };
    profile.restoreTool = block => {
      const row = this.#toolMetadata.get(key(block));
      if (!row) return block;
      if (row.expires <= Date.now()) { this.#toolMetadata.delete(key(block)); throw new AdapterError('工具接续记录已过期，请新建会话。', 409); }
      if (row.identity !== identity(block)) throw new AdapterError('工具接续的名称或参数已变化。', 409);
      return { ...block, caller: { type: 'direct' } };
    };
    let ignoredEffort = false;
    try {
      const input = structuredClone(body);
      // A client may inherit a global hint even when this source exposes no control.
      // Use its default explicitly and never echo that hint as executed reasoning.
      if (!profile.allowedEfforts.length && input?.reasoning?.effort !== undefined) {
        if (!EFFORTS.has(input.reasoning.effort)) throw new AdapterError('未知的 reasoning.effort。', 400, 'reasoning.effort');
        delete input.reasoning.effort; ignoredEffort = true;
      }
      translated = translateResponses(input, this.#marker, profile);
      upstream = await this.#request({ body: translated.upstream, scope, session, signal: linked });
      if (!(upstream instanceof Response)) throw new AdapterError('Messages 来源未返回有效响应。', 502);
      if (!upstream.ok) {
        // Keep a user-visible status; provider bodies/addresses never become adapter errors.
        await upstream.body?.cancel();
        const message = upstream.status === 402 ? '模型来源余额不足或需要充值，请检查远端账号额度（HTTP 402）。'
          : `模型来源拒绝了请求（HTTP ${upstream.status}）。`;
        const response = errorResponse(new AdapterError(message, upstream.status));
        const retry = upstream.headers.get('retry-after'); if (retry) response.headers.set('retry-after', retry);
        return response;
      }
      metered = meterClientResponse(upstream, { protocol: 'messages', signal: linked, onResult: async () => {} });
      reader = metered.body.getReader();
    } catch (error) {
      abort.abort(); await reader?.cancel().catch(() => {});
      return errorResponse(error instanceof AdapterError ? error : new AdapterError('模型来源暂不可用。', signal?.aborted ? 499 : 503));
    }
    const conversion = new ResponsesConversion(translated, profile), parser = new MessagesSseParser();
    const cancelRead = () => { void reader.cancel().catch(() => {}); };
    linked.addEventListener('abort', cancelRead, { once: true });
    if (linked.aborted) cancelRead();
    const dispose = async () => {
      linked.removeEventListener('abort', cancelRead);
      await reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {}
    };
    const events = async function* () {
      const check = () => { if (linked.aborted) throw new AdapterError('请求已取消。', 499); };
      try {
        let json = ''; const jsonResponse = metered.headers.get('content-type')?.includes('application/json');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (true) {
          check(); const next = await reader.read(); check();
          if (jsonResponse) {
            json += decoder.decode(next.value, { stream: !next.done });
            if (Buffer.byteLength(json) > MAX) throw new AdapterError('Messages 内容超过大小限制。', 502);
          } else for (const event of parser.push(next.value, next.done)) yield* conversion.accept(event);
          if (next.done) break;
        }
        if (jsonResponse) {
          let message;
          try { message = JSON.parse(json); } catch { throw new AdapterError('Messages JSON 无效。', 502); }
          for (const event of messagesJsonEvents(message)) yield* conversion.accept(event);
        }
        const { usage } = await getClientMeter(metered).finish; check();
        const wireUsage = usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
          input_tokens_details: { cached_tokens: usage.cachedInputTokens, cache_write_tokens: usage.cacheWriteTokens },
          output_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : null;
        yield conversion.finish(wireUsage);
      } finally { await dispose(); }
    };
    const iterator = events();
    const headers = { 'cache-control': 'no-store', ...(ignoredEffort ? { 'x-bifrost-reasoning-mode': 'upstream-default' } : {}) };
    if (translated.original.stream !== true) {
      try {
        let result;
        for await (const event of iterator) if (['response.completed', 'response.incomplete'].includes(event.type)) result = event.response;
        return Response.json(result, { headers });
      } catch (error) { return errorResponse(error); }
    }
    return new Response(new ReadableStream({
      async pull(controller) {
        try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encodeResponsesEvent(next.value)); }
        catch (error) {
          controller.enqueue(encodeResponsesEvent(conversion.event('response.failed', { response: conversion.response('failed', null, errorData(error)) })));
          controller.close();
        }
      },
      cancel() { abort.abort(); cancelRead(); void iterator.return().catch(() => {}); },
    }, { highWaterMark: 0 }), { headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8' } });
  }
}
