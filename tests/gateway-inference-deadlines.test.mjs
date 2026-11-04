import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeVmGateway } from '../src/claude-vm-gateway.mjs';
import { createExternalClaudeGateway } from '../src/external-claude-gateway.mjs';

const privateKey = 'private-deadline-fixture-'.repeat(3);
const relayKey = 'relay-deadline-fixture-'.repeat(3);
const externalKey = 'external-deadline-fixture-'.repeat(3);
const encoder = new TextEncoder();

function gateway(kind, options) {
  const common = { gatewayKey: privateKey, upstreamPort: 3435, allowedHosts: ['fixture'], ...options };
  return kind === 'vm' ? createClaudeVmGateway({ ...common, relayKey })
    : createExternalClaudeGateway({ ...common, sessionKey: relayKey,
      getClients: () => [{ id: 'deadline-fixture', keySha256: createHash('sha256').update(externalKey).digest('hex'),
        maxConcurrent: 1, requestsPerMinute: 30 }] });
}

async function fixture(t, kind, options) {
  const server = gateway(kind, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, body) => http.request(`http://127.0.0.1:${server.address().port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: 'fixture', authorization: `Bearer ${kind === 'vm' ? privateKey : externalKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  });
  const send = (path = '/v1/models', body) => new Promise((resolve, reject) => {
    const outgoing = request(path, body);
    outgoing.once('response', incoming => resolve(new Response(Readable.toWeb(incoming), {
      status: incoming.statusCode, headers: incoming.headers,
    })));
    outgoing.once('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { send, request };
}

for (const kind of ['vm', 'external']) {
  for (const path of ['/v1/messages', '/v1/chat/completions']) for (const stream of [false, true]) {
    test(`${kind}: delayed inference headers use the generation deadline (${path}, stream=${stream})`, async t => {
      let calls = 0, dispatchedSignal;
      const content = stream ? 'data: fixture-completed\n\n' : JSON.stringify({ fixture: 'completed', usage: { input_tokens: 12, output_tokens: 3 } });
      const { send } = await fixture(t, kind, { headerTimeoutMs: 10, requestTimeoutMs: 1000,
        fetchImpl: async (_url, { signal }) => {
          calls++; dispatchedSignal = signal;
          await delay(60, undefined, { signal });
          return new Response(content, { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
        } });
      const response = await send(path, { model: 'fixture', messages: [], stream });
      assert.equal(response.status, 200); assert.equal(await response.text(), content);
      assert.equal(calls, 1); assert.equal(dispatchedSignal.aborted, false);
    });
  }

  for (const path of ['/v1/models', '/v1/messages/count_tokens']) {
    test(`${kind}: control requests retain the short header deadline (${path})`, async t => {
      let calls = 0, dispatchedSignal;
      const { send } = await fixture(t, kind, { headerTimeoutMs: 10, requestTimeoutMs: 1000,
        fetchImpl: async (_url, { signal }) => {
          calls++; dispatchedSignal = signal;
          await delay(1000, undefined, { signal }); return Response.json({});
        } });
      const response = await send(path, path.endsWith('count_tokens') ? { model: 'fixture' } : undefined);
      assert.equal(response.status, 503); await response.text();
      assert.equal(calls, 1); assert.equal(dispatchedSignal.aborted, true);
    });
  }

  test(`${kind}: generation deadline cancels a request awaiting headers without retrying`, async t => {
    let calls = 0, dispatchedSignal;
    const { send } = await fixture(t, kind, { headerTimeoutMs: 5, requestTimeoutMs: 30,
      fetchImpl: async (_url, { signal }) => {
        calls++; if (calls > 1) return Response.json({ recovered: true });
        dispatchedSignal = signal;
        await delay(1000, undefined, { signal }); return Response.json({});
      } });
    const response = await send('/v1/messages', { stream: false });
    assert.equal(response.status, 503); await response.text();
    assert.equal(calls, 1); assert.equal(dispatchedSignal.aborted, true);
    assert.deepEqual(await (await send()).json(), { recovered: true });
  });

  test(`${kind}: generation deadline cancels a stalled body and releases the request slot`, { timeout: 3000 }, async t => {
    let calls = 0, cancels = 0, dispatchedSignal;
    const { send } = await fixture(t, kind, { headerTimeoutMs: 5, requestTimeoutMs: 100,
      fetchImpl: async (_url, { signal }) => {
        calls++; if (calls > 1) return Response.json({ recovered: true });
        dispatchedSignal = signal;
        // Deliberately do not link the mock response body to fetch's signal.
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(encoder.encode('data: started\n\n')); },
          cancel() { cancels++; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      } });
    const response = await send('/v1/messages', { stream: true });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    assert.equal(calls, 1); assert.equal(cancels, 1); assert.equal(dispatchedSignal.aborted, true);
    assert.deepEqual(await (await send()).json(), { recovered: true });
  });

  test(`${kind}: disconnect while awaiting model headers cancels the same upstream call`, { timeout: 3000 }, async t => {
    let calls = 0, started, cancelled;
    const began = new Promise(resolve => { started = resolve; });
    const ended = new Promise(resolve => { cancelled = resolve; });
    const { request } = await fixture(t, kind, { headerTimeoutMs: 1000, requestTimeoutMs: 2000,
      fetchImpl: async (_url, { signal }) => {
        calls++; started();
        try { await delay(10_000, undefined, { signal }); }
        finally { if (signal.aborted) cancelled(); }
        return Response.json({});
      } });
    const outgoing = request('/v1/messages', {});
    outgoing.on('error', () => {}); outgoing.end('{}');
    await began; outgoing.destroy(); await ended;
    assert.equal(calls, 1);
  });

  test(`${kind}: invalid timer values cannot overflow into immediate timeouts or disable deadlines`, () => {
    for (const name of ['headerTimeoutMs', 'requestTimeoutMs']) for (const value of [0, -1, 1.5, NaN, Infinity, 2 ** 31]) {
      assert.throws(() => gateway(kind, { [name]: value }), TypeError);
    }
  });
}
