import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describeCodeBuddyDeltaFields, normalizeCodeBuddySourceDiagnostics } from '../src/codebuddy-source-diagnostics.mjs';
import { CodeBuddyProvider } from '../src/codebuddy-provider.mjs';
import { CodeBuddyResponsesProvider } from '../src/codebuddy-responses.mjs';
import { CodeBuddyThinkingState } from '../src/codebuddy-thinking-state.mjs';
import { Gateway } from '../src/gateway.mjs';
import { createAnthropicGatewayServer } from '../src/anthropic-gateway.mjs';
import { RequestDiagnostics, classifyDiagnosticFailure, normalizeDiagnosticRecord } from '../src/request-diagnostics.mjs';

const code = 'codebuddy_unsupported_delta';
const model = 'CodeBuddy-hy4std';
const privateField = 'PRIVATE_DYNAMIC_FIELD_Bearer_credential';
const delta = { function_call: { name: 'PRIVATE_TOOL_NAME', arguments: 'PRIVATE_ARGUMENTS', [privateField]: 'PRIVATE_NESTED_VALUE' },
  reasoning_details: [{ text: 'PRIVATE_REASONING' }], [privateField]: 'PRIVATE_VALUE' };
const diagnostic = () => describeCodeBuddyDeltaFields(delta, Object.keys(delta));
const metadataEntry = (overrides = {}) => ({ requestId: randomUUID(), time: '2026-11-05T06:23:35.126Z',
  account: 'CodeBuddy', model, status: 'failed', httpStatus: 200, durationMs: 30, firstResponseMs: 2,
  errorCode: code, failureStage: 'stream', sourceDiagnostics: diagnostic(), ...overrides });
const assertPrivateFree = value => assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /PRIVATE_|Bearer|credential|valueTypePayload/);

test('delta diagnostics retain the rejected envelope shape without its values or dynamic names', () => {
  const result = diagnostic();
  assert.deepEqual(result, { version: 1, kind: 'codebuddy_delta_shape', fieldCount: 3, fields: [
    { field: 'function_call', type: 'object', children: [
      { field: 'name', type: 'string', length: delta.function_call.name.length },
      { field: 'arguments', type: 'string', length: delta.function_call.arguments.length },
      { field: 'unknown_key', type: 'string', keyLength: privateField.length, length: delta.function_call[privateField].length },
    ], childCount: 3 },
    { field: 'reasoning_details', type: 'array', length: 1 },
    { field: 'unknown_key', type: 'string', keyLength: privateField.length, length: delta[privateField].length },
  ] });
  assertPrivateFree(result);
  assert.deepEqual(normalizeCodeBuddySourceDiagnostics(code, result), result);
});

test('replayed shape metadata is rebuilt, bounded and ignores prototype keys, extra content and recursive children', () => {
  const fields = Array.from({ length: 100 }, () => ({ field: 'function_call', type: 'object',
    children: Array.from({ length: 50 }, () => ({ field: privateField, type: 'PRIVATE_TYPE',
      keyLength: -1, length: Infinity, value: 'PRIVATE_VALUE', children: [{ field: 'name', type: 'PRIVATE_RECURSION' }] })),
    childCount: 50, privatePayload: 'PRIVATE_VALUE' }));
  const raw = { version: 1, kind: 'codebuddy_delta_shape', fieldCount: 100, fields, privatePayload: 'PRIVATE_VALUE' };
  const result = normalizeCodeBuddySourceDiagnostics(code, raw);
  assert.equal(result.fields.length, 8);
  assert.ok(result.fields.every(item => item.children.length === 3));
  assert.ok(result.fields.every(item => item.children.every(child => child.field === 'unknown_key' && child.type === 'unknown' && !('children' in child))));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assertPrivateFree(result);
  const owned = normalizeCodeBuddySourceDiagnostics(code, { version: 1, kind: 'codebuddy_delta_shape', fields: [
    Object.create({ field: 'name', type: 'string', length: 8 }),
    { field: '__proto__', type: 'object', __proto__: { value: 'PRIVATE_PROTOTYPE' } },
    { field: 'constructor', type: 'string', length: 4, value: 'PRIVATE_STRING' },
  ] });
  assert.deepEqual(owned.fields, [{ field: 'unknown_key', type: 'object', keyLength: 9 },
    { field: 'unknown_key', type: 'string', keyLength: 11, length: 4 }]);
  assertPrivateFree(owned);
  for (const incompatible of [null, [], 'PRIVATE_VALUE', { ...raw, version: 2 }, { ...raw, kind: 'PRIVATE_KIND' },
    { ...raw, fields: null }, Object.create({ version: 1, kind: 'codebuddy_delta_shape', fields: raw.fields })]) {
    assert.equal(normalizeCodeBuddySourceDiagnostics(code, incompatible), null);
  }
  const throwing = { version: 1, kind: 'codebuddy_delta_shape', get fields() { throw new Error('PRIVATE_GETTER'); } };
  assert.equal(normalizeCodeBuddySourceDiagnostics(code, throwing), null);
});

test('shape diagnostics cannot change an error category, status, or a successful record', () => {
  for (const other of ['claude_upstream_error', 'codebuddy_upstream_failed', 'invalid_request', 'PRIVATE_CODE', 'constructor', '__proto__', null]) {
    assert.equal(normalizeCodeBuddySourceDiagnostics(other, diagnostic()), null);
    assert.equal('sourceDiagnostics' in classifyDiagnosticFailure({ code: other, sourceDiagnostics: diagnostic() }), false);
    assert.equal('sourceDiagnostics' in normalizeDiagnosticRecord(metadataEntry({ errorCode: other })), false);
  }
  assert.equal('sourceDiagnostics' in classifyDiagnosticFailure({ code, sourceDiagnostics: diagnostic() }, { interrupted: true }), false);
  for (const status of ['completed', 'tool_pending', 'interrupted', 'incomplete']) {
    assert.equal('sourceDiagnostics' in normalizeDiagnosticRecord(metadataEntry({ status })), false);
  }
  const failure = classifyDiagnosticFailure({ code, sourceDiagnostics: { ...diagnostic(), status: 401, message: 'PRIVATE_MESSAGE' } },
    { httpStatus: 200, stage: 'stream' });
  assert.equal(failure.errorCode, code); assert.equal(failure.failureStage, 'stream');
  assertPrivateFree(failure);
});

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function upstream() {
  const frames = [chunk({ role: 'assistant', content: 'Inspecting.' }), chunk(delta)];
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index === frames.length) { controller.close(); return; }
    controller.enqueue(Buffer.from(`data: ${JSON.stringify(frames[index++])}\n\n`));
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
function providers() {
  const client = { status: async () => ({ authenticated: true, identity: { uid: 'offline-diagnostics-employee' } }),
    modelCatalog: async () => [{ id: 'hy4std', name: 'HY4', supportsToolCall: true }], chatCompletions: async () => upstream() };
  const messages = new CodeBuddyProvider({ client, loadThinkingState: () => new CodeBuddyThinkingState({ key: Buffer.alloc(32, 17) }) });
  return { messages, responses: new CodeBuddyResponsesProvider({ provider: messages }) };
}
const parseEvents = wire => wire.split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/)
  .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')));

for (const stream of [false, true]) {
  test(`CodeBuddy Messages ${stream ? 'SSE' : 'JSON'} exposes only safe rejected-field shapes`, async () => {
    const { messages } = providers();
    const response = await messages.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify({ model,
      max_tokens: 32, stream, messages: [{ role: 'user', content: 'Offline fixture.' }] })) });
    const wire = await response.text();
    const error = stream ? parseEvents(wire).at(-1).error : JSON.parse(wire).error;
    assert.equal(response.status, stream ? 200 : 502);
    assert.equal(error.code, code); assert.deepEqual(error.sourceDiagnostics, diagnostic());
    assertPrivateFree(wire);
  });

  test(`CodeBuddy Responses ${stream ? 'SSE' : 'JSON'} retains shapes across the protocol boundary`, async () => {
    const { responses } = providers();
    const response = await responses.request({ path: '/responses', body: Buffer.from(JSON.stringify({ model,
      store: false, stream, input: [{ role: 'user', content: 'Offline fixture.' }] })) });
    const wire = await response.text(), error = stream ? parseEvents(wire).at(-1).response.error : JSON.parse(wire).error;
    assert.equal(response.status, stream ? 200 : 502); assert.equal(error.code, code);
    assert.deepEqual(error.sourceDiagnostics, diagnostic()); assertPrivateFree(wire);
  });
}

async function journalFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-safe-source-diagnostics-')));
  const path = join(root, 'diagnostics.jsonl'), journal = await RequestDiagnostics.open({ path });
  t.after(async () => { await journal.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, journal };
}

test('shape metadata survives journal reopening and export without retaining source messages or values', async t => {
  const { path, journal } = await journalFixture(t), entry = metadataEntry({ message: 'PRIVATE_SOURCE_MESSAGE', headers: { Authorization: 'Bearer PRIVATE_TOKEN' } });
  await journal.record(entry);
  entry.sourceDiagnostics.fields[0].children[0].length = 9999;
  assert.notEqual(journal.detail(entry.requestId).sourceDiagnostics.fields[0].children[0].length, 9999);
  await journal.close();
  const reopened = await RequestDiagnostics.open({ path }); t.after(() => reopened.close());
  assert.deepEqual(reopened.detail(entry.requestId).sourceDiagnostics, diagnostic());
  assertPrivateFree(await readFile(path, 'utf8'));
  assertPrivateFree(reopened.exportReport(entry.requestId));
  assert.deepEqual(reopened.exportReport(entry.requestId).request.sourceDiagnostics, diagnostic());
});

test('reopening untrusted persisted metadata rebuilds the same bounded diagnostic contract', async t => {
  const { path, journal } = await journalFixture(t); await journal.close();
  const entry = metadataEntry();
  entry.sourceDiagnostics.fields[0].children[0].value = 'PRIVATE_FIELD_VALUE';
  entry.sourceDiagnostics.fields.push({ field: privateField, type: 'PRIVATE_VALUE_TYPE', valueTypePayload: 'PRIVATE_FIELD_VALUE' });
  entry.sourceDiagnostics.privatePayload = 'PRIVATE_PROVIDER_BODY';
  await writeFile(path, JSON.stringify(entry) + '\n');
  const reopened = await RequestDiagnostics.open({ path }); t.after(() => reopened.close());
  const restored = reopened.detail(entry.requestId);
  assert.equal(restored.sourceDiagnostics.fields.at(-1).field, 'unknown_key');
  assert.equal(restored.sourceDiagnostics.fields.at(-1).type, 'unknown');
  assertPrivateFree(await readFile(path, 'utf8')); assertPrivateFree(reopened.exportReport());
});

for (const protocol of ['responses', 'messages']) for (const stream of [false, true]) {
  test(`${protocol} ${stream ? 'SSE' : 'JSON'} gateway diagnostics retain safe shape metadata through persistence`, async t => {
    const { messages, responses } = providers(), { path, journal } = await journalFixture(t);
    const records = [], writes = [];
    const onDiagnostic = record => { records.push(record); const operation = journal.record(record); writes.push(operation); return operation; };
    const key = 'offline-source-shape-gateway-key';
    let server;
    if (protocol === 'responses') {
      const gateway = new Gateway({ gatewayKey: key, backend: { credentials: async () => ({ value: 'offline-b-token', accountId: 'offline-b' }) },
        getAProvider: async () => ({ config: { base_url: 'https://never-requested.invalid/' } }), codeBuddyProvider: responses, onDiagnostic });
      server = http.createServer(async (req, res) => {
        try { await gateway.proxy(req, res, new URL(req.url, 'http://offline.invalid')); }
        catch (error) { if (res.headersSent) res.destroy(); else { res.writeHead(error.status ?? 502); res.end('Offline gateway failed.'); } }
      });
    } else {
      server = createAnthropicGatewayServer({ gatewayKey: key, allowedPeers: ['127.0.0.1'], onDiagnostic,
        routes: [{ account: 'CodeBuddy', model: { id: model, name: 'Offline HY4' }, provider: messages }] });
    }
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = `127.0.0.1:${server.address().port}`;
    if (protocol === 'messages') server.gateway.allowedHosts.add(address);
    const body = protocol === 'responses' ? { model, stream, store: false, input: [{ role: 'user', content: 'Offline fixture.' }] }
      : { model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'Offline fixture.' }] };
    const response = await fetch(`http://${address}/${protocol === 'messages' ? 'v1/messages' : 'responses'}`, { method: 'POST',
      headers: protocol === 'messages' ? { 'x-api-key': key } : { 'x-account-bridge-key': key,
        authorization: 'Bearer offline-account-a-token', 'chatgpt-account-id': 'offline-account-a' }, body: JSON.stringify(body) });
    const wire = await response.text(); await Promise.all(writes);
    assert.equal(response.status, stream ? 200 : 502); assertPrivateFree(wire);
    assert.equal(records.length, 1); assert.equal(records[0].errorCode, code);
    assert.deepEqual(records[0].sourceDiagnostics, diagnostic());
    assert.deepEqual(journal.detail(records[0].requestId).sourceDiagnostics, diagnostic());
    assertPrivateFree(await readFile(path, 'utf8')); assertPrivateFree(journal.exportReport(records[0].requestId));
  });
}
