import { AdapterError, encodeResponsesEvent, errorData, errorResponse } from './responses-messages.mjs';

const TERMINAL = new Set(['response.completed', 'response.incomplete']);
const protocolError = () => new AdapterError('响应未按完整提交协议结束。', 502);
const defaultFailure = error => ({ data: errorData(error), response: errorResponse(error) });
const quiet = action => {
  try { void Promise.resolve(action?.()).catch(() => {}); } catch { /* Cleanup cannot change delivered output. */ }
};

function checkPacket(value) {
  if (!Array.isArray(value)) {
    if (!value || typeof value.type !== 'string' || value.type === 'response.output_item.done'
        || value.type === 'response.failed' || TERMINAL.has(value.type)) throw protocolError();
    return null;
  }
  const terminal = value.at(-1), response = terminal?.response;
  if (!TERMINAL.has(terminal?.type) || response?.status !== terminal.type.slice('response.'.length)
      || !Array.isArray(response.output) || value.slice(0, -1).some(event => TERMINAL.has(event?.type)
        || event?.type === 'response.failed')) throw protocolError();
  const done = value.filter(event => event?.type === 'response.output_item.done');
  if (done.length !== response.output.length || done.some((event, index) => event.output_index !== index
      || event.item?.id !== response.output[index]?.id || event.item?.type !== response.output[index]?.type
      || event.item?.status === 'in_progress')) throw protocolError();
  return response;
}

/** Owns HTTP delivery only; source authentication, native sessions and billing stay with providers. */
export async function deliverResponses({ events, conversion, stream, signal,
  headers = {}, decorate = response => response, formatFailure = defaultFailure,
  cancelledError = () => new AdapterError('请求已取消。', 499),
  cancel, dispose, committed, preflight = false } = {}) {
  const iterator = events[Symbol.asyncIterator]();
  let phase = 'open', disposed = false, sourceCancelled = false, firstPromise, firstConsumed = false;
  let rejectAbort, preflightPromise, sequence = 0;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const check = () => { if (signal?.aborted || phase === 'cancelled') throw cancelledError(); };
  const cancelSource = () => {
    if (sourceCancelled) return;
    sourceCancelled = true; quiet(cancel);
  };
  const finish = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', onAbort);
    // Run disposal independently: return() may wait forever behind a stalled
    // source next(), and a slow cleanup must not delay a terminal response.
    quiet(dispose); quiet(() => iterator.return?.());
  };
  const onAbort = () => {
    if (phase !== 'open') return;
    rejectAbort(cancelledError()); cancelSource(); finish();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const failure = error => {
    let formatted;
    try { formatted = formatFailure(error); }
    catch { formatted = defaultFailure(protocolError()); }
    return { failed: true, error, formatted };
  };
  const failureEvent = packet => conversion.event('response.failed', {
    response: conversion.response('failed', null, packet.formatted.data) });
  const encode = value => encodeResponsesEvent(Array.isArray(value)
    ? value.map(event => ({ ...event, sequence_number: sequence++ }))
    : { ...value, sequence_number: sequence++ });
  const read = async () => {
    try {
      check();
      const next = await Promise.race([iterator.next(), aborted]);
      check();
      if (next.done) throw protocolError();
      return { value: next.value, response: checkPacket(next.value), failed: false };
    } catch (error) { return failure(error); }
  };
  const first = () => firstPromise ??= read();
  const take = async () => {
    if (firstConsumed) return read();
    firstConsumed = true; return first();
  };
  const markCommitted = response => {
    phase = 'committed';
    // Called only after the complete batch has entered the HTTP response. A
    // native run finishing earlier does not itself attest HTTP delivery.
    quiet(() => committed?.(response)); finish();
  };
  const markFailed = () => { phase = 'failed'; cancelSource(); finish(); };
  if (!stream) {
    while (true) {
      const packet = await take();
      if (packet.failed) { markFailed(); return decorate(packet.formatted.response); }
      if (!packet.response) continue;
      try {
        check();
        const response = Response.json(packet.response, { headers });
        markCommitted(packet.response); return decorate(response);
      } catch (error) { markFailed(); return decorate(failure(error).formatted.response); }
    }
  }
  const body = new ReadableStream({
    async pull(controller) {
      const packet = await take();
      if (phase !== 'open') return;
      try {
        if (packet.failed) {
          controller.enqueue(encode(failureEvent(packet)));
          markFailed(); controller.close(); return;
        }
        check();
        const bytes = encode(packet.value);
        check();
        controller.enqueue(bytes);
        if (packet.response) { markCommitted(packet.response); controller.close(); }
      } catch (error) {
        if (phase !== 'open') return;
        controller.enqueue(encode(failureEvent(failure(error))));
        markFailed(); controller.close();
      }
    },
    cancel() {
      if (phase !== 'open') return;
      phase = 'cancelled'; rejectAbort(cancelledError()); cancelSource(); finish();
    },
  }, { highWaterMark: 0 });
  const response = decorate(new Response(body, { headers: { ...headers,
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } }));
  if (preflight) response.bridgePreflight = () => preflightPromise ??= (async () => {
    if (firstConsumed || response.bodyUsed || response.body.locked) return response;
    const packet = await first();
    // A body reader can take ownership while preflight waits for the source.
    // Leave that reader responsible for delivering and closing its SSE error.
    if (phase !== 'cancelled' && (firstConsumed || response.bodyUsed || response.body.locked)) return response;
    if (!packet.failed && !signal?.aborted && phase === 'open') return response;
    const rejected = packet.failed ? packet : failure(cancelledError());
    markFailed();
    if (!response.body.locked) quiet(() => response.body.cancel());
    return decorate(rejected.formatted.response);
  })();
  return response;
}
