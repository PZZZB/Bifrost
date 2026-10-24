import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { ClientBilling } from '../src/client-billing.mjs';
import { ClientStateCodec } from '../src/client-state.mjs';
import { meterClientResponse, getClientMeter } from '../src/client-meter.mjs';
import { createClientServer } from '../src/client-server.mjs';

const model = 'claude-codebuddy-opus-5-5';
const price = { model, inputRateMicros: 1_000_000, cachedInputRateMicros: 500_000, outputRateMicros: 2_000_000,
  reserveInputTokens: 100, reserveOutputTokens: 20, enabled: true };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-billing-review-'));
  t.after(() => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bifrost-billing-review-'));
    return rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'billing.json'), billing = await ClientBilling.open({ path });
  const accountId = randomUUID(), keyId = randomUUID();
  await billing.setPrice(price); await billing.configureAccount(accountId, { enforceBalance: true });
  await billing.adjustBalance(accountId, { operationId: randomUUID(), amountMicros: 1000 });
  const reserve = async () => { const requestId = randomUUID(); await billing.reserve({ accountId, keyId, model, requestId }); return requestId; };
  return { billing, path, accountId, keyId, reserve };
}

test('review: cache read and cache write subsets cannot exceed the measured input total', async t => {
  const { billing, accountId, reserve } = await fixture(t), requestId = await reserve();
  await billing.begin(requestId);
  const revision = billing.snapshot().revision;
  for (const usage of [
    { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 11 },
    { inputTokens: 10, outputTokens: 5, cachedInputTokens: 8, cacheWriteTokens: 3 },
  ]) await assert.rejects(billing.settle(requestId, usage), error => error.status === 400);
  assert.equal(billing.snapshot().revision, revision); assert.equal(billing.account(accountId).balanceMicros, 1000);
});

test('review: settlement, concurrent duplicate callbacks and later stale callbacks never debit twice', async t => {
  const { billing, accountId, reserve } = await fixture(t), requestId = await reserve();
  await billing.begin(requestId);
  const usage = { inputTokens: 80, cachedInputTokens: 20, outputTokens: 10 };
  await Promise.all([billing.settle(requestId, usage), billing.settle(requestId, usage), billing.settle(requestId, usage)]);
  const rows = billing.history(accountId).rows;
  assert.equal(rows.filter(row => row.type === 'settled').length, 1); assert.equal(billing.account(accountId).balanceMicros, 910);
  await billing.markUnresolved(requestId); await assert.rejects(billing.reject(requestId));
  assert.equal(billing.account(accountId).balanceMicros, 910); assert.equal(billing.account(accountId).usedTokens, 90);
});

test('review: recovery holds both queued and started work without duplicating existing debit', async t => {
  const { billing, path, accountId, reserve } = await fixture(t);
  const settled = await reserve(), queued = await reserve(), started = await reserve();
  await billing.begin(settled); await billing.settle(settled, { inputTokens: 80, outputTokens: 10 });
  await billing.begin(started); await billing.close();
  const reopened = await ClientBilling.open({ path });
  t.after(() => reopened.close());
  assert.equal(reopened.account(accountId).balanceMicros, 900); assert.equal(reopened.account(accountId).unresolvedCount, 2);
  assert.equal(reopened.account(accountId).reservedMicros, 280);
  const rows = reopened.history(accountId).rows;
  assert.equal(rows.filter(row => row.type === 'settled').length, 1);
  assert.equal(rows.filter(row => row.type === 'unresolved' && [queued, started].includes(row.requestId)).length, 2);
});

async function productionResponses(fakeFetch) {
  // Isolate the exact callback installed by main.mjs. Importing main would
  // launch real services, and copying its logic would not test the wiring.
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('    requestResponses: async ({ body, scope, signal }) => {', source.indexOf('prepareResponses:'));
  const end = source.indexOf('\n    requestMessages:', begin);
  assert.ok(begin >= 0 && end > begin, 'production user Responses callback must remain identifiable');
  const callback = source.slice(begin, end).trim().replace(/^requestResponses: /, '').replace(/,$/, '');
  const factory = new Function('fetch', 'baseUrl', 'state', 'clientVersion', 'codec', `return (${callback});`);
  return factory(fakeFetch, 'http://127.0.0.1:59999/backend-api/codex', { gatewayKey: 'offline-private-secret-'.repeat(3) },
    'offline-test', new ClientStateCodec({ secret: 'offline-private-secret-'.repeat(3) }));
}

test('review: actual main Responses wiring preserves usage from failed JSON and SSE while redacting errors', async t => {
  const { billing, accountId, reserve } = await fixture(t);
  const reported = { input_tokens: 80, output_tokens: 10, total_tokens: 90, input_tokens_details: { cached_tokens: 20 } };
  const privateMessage = 'private provider text Bearer bfk_' + 'x'.repeat(43);
  for (const status of [400, 500]) for (const format of ['json', 'sse']) {
    const requestId = await reserve(); await billing.begin(requestId);
    let calls = 0;
    const request = await productionResponses(async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:59999/backend-api/codex/responses');
      assert.equal(options.headers['x-bifrost-client-scope'], accountId);
      if (format === 'json') return Response.json({ error: { message: privateMessage }, usage: reported }, { status });
      const value = { type: 'response.failed', response: { id: 'resp_failure', status: 'failed',
        error: { message: privateMessage }, usage: reported } };
      return new Response(`event: response.failed\ndata: ${JSON.stringify(value)}\n\n`, { status,
        headers: { 'content-type': 'text/event-stream' } });
    });
    const response = await request({ body: { model, input: 'offline' }, scope: accountId });
    assert.equal(response.status, status);
    const metered = meterClientResponse(response, { protocol: 'responses', onResult: async result => {
      assert.equal(result.status, 'completed'); await billing.settle(requestId, result.usage);
    } });
    const text = await metered.text();
    assert.doesNotMatch(text, /private provider text|bfk_/); assert.match(text, /input_tokens/);
    assert.equal((await getClientMeter(metered).finish).usage.totalTokens, 90); assert.equal(calls, 1);
  }
  assert.equal(billing.account(accountId).balanceMicros, 640);
  assert.equal(billing.history(accountId).rows.filter(row => row.type === 'settled').length, 4);
});

test('review: actual main unknown HTTP failure hides raw text and retains a reviewable hold', async t => {
  const { billing, accountId, reserve } = await fixture(t), requestId = await reserve();
  await billing.begin(requestId);
  const request = await productionResponses(async () => new Response('private provider HTML failure', { status: 502,
    headers: { 'content-type': 'text/html' } }));
  const response = await request({ body: { model, input: 'offline' }, scope: accountId });
  const metered = meterClientResponse(response, { protocol: 'responses', onResult: async result => {
    assert.equal(result.status, 'unresolved'); assert.equal(result.usage, null); await billing.markUnresolved(requestId);
  } });
  assert.doesNotMatch(await metered.text(), /private provider HTML/);
  assert.equal(billing.account(accountId).balanceMicros, 1000); assert.equal(billing.account(accountId).reservedMicros, 140);
});

test('review: Chat cancellation of HTTP error bodies cannot skip billed usage or release unknown failures', async t => {
  const { billing, accountId, keyId } = await fixture(t);
  const secret = 'bfk_' + 'r'.repeat(43), allowedModels = [model];
  const access = { authenticateKey: value => value === secret ? { accountId, keyId, username: 'review-user', allowedModels } : null };
  const cases = [
    { status: 400, usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90, input_tokens_details: { cached_tokens: 20 } } },
    { status: 404 }, { status: 502 },
  ];
  let calls = 0;
  const server = createClientServer({ access, billing, publicBaseUrl: 'http://billing-review.test', allowedHosts: [],
    getModels: () => [{ id: model, channel: 'CodeBuddy', enabled: true, available: true }],
    csrfSecret: 'offline-review-csrf-secret-'.repeat(3), requestResponses: async () => {
      const next = cases[calls++];
      assert.ok(next, 'each Chat request invokes its source only once');
      return Response.json({ error: { message: 'offline provider failure' }, ...(next.usage ? { usage: next.usage } : {}) }, { status: next.status });
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = () => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST',
      headers: { host: 'billing-review.test', authorization: `Bearer ${secret}`, 'content-type': 'application/json', connection: 'close' } }, response => {
      const chunks = [];
      response.on('data', value => chunks.push(value)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model, messages: [{ role: 'user', content: 'offline' }] }));
  });
  assert.equal((await send()).status, 400);
  assert.equal(billing.account(accountId).balanceMicros, 910); assert.equal(billing.account(accountId).reservedMicros, 0);
  assert.equal((await send()).status, 404);
  assert.equal(billing.account(accountId).balanceMicros, 910); assert.equal(billing.account(accountId).reservedMicros, 0);
  assert.equal((await send()).status, 502);
  assert.equal(billing.account(accountId).balanceMicros, 910); assert.equal(billing.account(accountId).reservedMicros, 140);
  assert.equal(billing.account(accountId).unresolvedCount, 1); assert.equal(calls, 3);
  const rows = billing.history(accountId).rows;
  assert.equal(rows.filter(row => row.type === 'settled').length, 1);
  assert.equal(rows.filter(row => row.type === 'released').length, 1);
});
