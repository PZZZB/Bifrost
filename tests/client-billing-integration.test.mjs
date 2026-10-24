import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientAccess } from '../src/client-access.mjs';
import { ClientBilling } from '../src/client-billing.mjs';
import { ClientAdmin } from '../src/client-admin.mjs';
import { createClientServer } from '../src/client-server.mjs';
import { BridgeError } from '../src/storage.mjs';

const MODEL = 'claude-codebuddy-opus-5-5';
const price = { model: MODEL, enabled: true, inputRateMicros: 1000000, cachedInputRateMicros: 500000,
  outputRateMicros: 2000000, reserveInputTokens: 200, reserveOutputTokens: 100 };
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 };
const completion = (includeUsage = true) => ({ id: 'resp_bill', object: 'response', model: MODEL, status: 'completed',
  output: [{ id: 'msg_bill', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
  usage: includeUsage ? usage : null });
const sse = data => new Response(`event: response.created\ndata: {"type":"response.created","response":{"id":"resp_bill","status":"in_progress"}}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: data })}\n\ndata: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream' } });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-billing-entry-'));
  const access = await ClientAccess.open({ path: join(dir, 'access.json'), allowedModelIds: [MODEL] });
  const billing = await ClientBilling.open({ path: join(dir, 'billing.json') });
  const user = await access.createAccount({ username: 'billing-user', password: 'Offline billing secret 123', allowedModels: [MODEL] });
  const key = await access.createKey(user.id);
  await billing.setPrice(price);
  await billing.configureAccount(user.id, { enforceBalance: true });
  await billing.adjustBalance(user.id, { operationId: randomUUID(), amountMicros: options.credit ?? 1000, note: 'Offline credit' });
  const calls = [];
  const source = async value => { calls.push(value); return options.source ? options.source(value, { access, billing, user, key }) : Response.json(completion()); };
  const server = createClientServer({ access, billing, getModels: () => [{ id: MODEL, name: 'Offline model', channel: 'CodeBuddy' }],
    publicDir: fileURLToPath(new URL('../public', import.meta.url)), publicBaseUrl: 'http://billing.test', allowedHosts: [],
    csrfSecret: 'offline-client-billing-csrf-secret-'.repeat(3), requestResponses: source, requestMessages: source,
    ...options.server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await access.close(); await billing.close();
    assert.equal(resolve(dirname(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('bifrost-billing-entry-'));
    await rm(dir, { recursive: true, force: true });
  });
  const send = (path, body, authorization = key.secret) => new Promise((done, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST',
      headers: { host: 'billing.test', authorization: `Bearer ${authorization}`, connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('error', reject);
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = JSON.parse(text); } catch {}
        done({ status: response.statusCode, text, data }); });
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { access, billing, user, key, calls, send, server };
}

test('prepaid HTTP request reserves first, then deducts authoritative cached-token price once before completion', async t => {
  const f = await fixture(t, { source: (_value, { billing, user }) => {
    assert.equal(billing.account(user.id).reservedMicros, 400);
    return Response.json(completion());
  } });
  const result = await f.send('/v1/responses', { model: MODEL, input: 'test' });
  assert.equal(result.status, 200, result.text);
  const account = f.billing.account(f.user.id);
  assert.equal(account.balanceMicros, 880); assert.equal(account.reservedMicros, 0); assert.equal(account.usedTokens, 120);
  assert.equal(f.billing.history(f.user.id).rows.filter(row => row.type === 'settled').length, 1);
});

test('insufficient balance and Token reservation limit reject before any upstream call', async t => {
  const f = await fixture(t, { credit: 399 });
  const denied = await f.send('/v1/responses', { model: MODEL, input: 'test' });
  assert.equal(denied.status, 402, denied.text); assert.equal(f.calls.length, 0);
  await f.billing.configureAccount(f.user.id, { enforceBalance: false, tokenLimit: 299 });
  const quota = await f.send('/v1/responses', { model: MODEL, input: 'test' });
  assert.equal(quota.status, 429, quota.text); assert.equal(f.calls.length, 0);
});

test('Chat is billed at the source Responses layer even without a Chat usage chunk', async t => {
  const f = await fixture(t, { source: () => sse(completion()) });
  const result = await f.send('/v1/chat/completions', { model: MODEL, stream: true, messages: [{ role: 'user', content: 'test' }] });
  assert.equal(result.status, 200); assert.match(result.text, /\[DONE\]/);
  assert.doesNotMatch(result.text, /"prompt_tokens"/);
  assert.equal(f.billing.account(f.user.id).balanceMicros, 880);
});

test('Messages uses authoritative bridgeUsage instead of protocol placeholder zeroes', async t => {
  const f = await fixture(t, { source: () => {
    const response = Response.json({ id: 'msg_offline', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } });
    response.bridgeUsage = Promise.resolve(usage); return response;
  } });
  const result = await f.send('/v1/messages', { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'test' }] });
  assert.equal(result.status, 200, result.text); assert.equal(f.billing.account(f.user.id).balanceMicros, 880);
});

test('local preflight failure releases without starting or charging an upstream request', async t => {
  const f = await fixture(t, { server: { prepareResponses: () => { throw new BridgeError('Rejected local resource.', 400); } } });
  assert.equal((await f.send('/v1/responses', { model: MODEL, input: 'test' })).status, 400);
  assert.equal(f.calls.length, 0); assert.equal(f.billing.account(f.user.id).reservedMicros, 0);
  assert.equal(f.billing.account(f.user.id).balanceMicros, 1000);
});

test('missing usage retains a reviewable hold; administrator release is idempotent', async t => {
  const f = await fixture(t, { source: () => Response.json(completion(false)) });
  assert.equal((await f.send('/v1/responses', { model: MODEL, input: 'test' })).status, 200);
  const pending = f.billing.account(f.user.id);
  assert.equal(pending.unresolvedCount, 1); assert.equal(pending.reservedMicros, 400); assert.equal(pending.balanceMicros, 1000);
  const row = f.billing.snapshot().recent.find(row => row.status === 'unresolved');
  const operation = { operationId: randomUUID(), action: 'release' };
  await f.billing.resolve(row.requestId, operation); await f.billing.resolve(row.requestId, operation);
  assert.equal(f.billing.account(f.user.id).reservedMicros, 0);
});

test('Key revoked during durable reservation cannot reach a model or retain an unused hold', async t => {
  const f = await fixture(t);
  const originalReserve = f.billing.reserve.bind(f.billing);
  f.billing.reserve = async options => { const result = await originalReserve(options); await f.access.revokeKey(f.user.id, f.key.key.id); return result; };
  assert.equal((await f.send('/v1/responses', { model: MODEL, input: 'test' })).status, 401);
  assert.equal(f.calls.length, 0); assert.equal(f.billing.account(f.user.id).reservedMicros, 0);
});

test('admin finance routes and portal ledger are scoped to existing users', async t => {
  const f = await fixture(t);
  const models = [{ id: MODEL }];
  const admin = new ClientAdmin({ access: f.access, billing: f.billing, getModels: () => models, getEndpoint: () => ({}) });
  await assert.rejects(admin.mutate('/api/client-admin/billing/prices', { ...price, model: 'A-secret-model' }), error => error.status === 400);
  await assert.rejects(admin.mutate(`/api/client-admin/accounts/${randomUUID()}/balance`, { operationId: randomUUID(), amountMicros: 1 }), error => error.status === 404);
  const operation = { operationId: randomUUID(), amountMicros: 123 };
  await admin.mutate(`/api/client-admin/accounts/${f.user.id}/balance`, operation);
  await admin.mutate(`/api/client-admin/accounts/${f.user.id}/balance`, operation);
  assert.equal((await admin.snapshot()).accounts[0].billing.balanceMicros, 1123);
  const logged = await f.access.login({ username: 'billing-user', password: 'Offline billing secret 123' });
  const page = await f.send('/portal/api/billing', undefined, logged.sessionToken);
  assert.equal(page.status, 200, page.text); assert.equal(page.data.accountId, f.user.id);
  assert.ok(page.data.history.every(row => row.accountId === f.user.id));
  assert.equal((await f.send('/portal/api/billing', undefined, f.key.secret)).status, 401);
});
