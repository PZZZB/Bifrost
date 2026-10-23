import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RequestDiagnostics, classifyDiagnosticFailure, normalizeDiagnosticRecord,
  normalizeDiagnosticUsage, responsesTerminalEvidence } from '../src/request-diagnostics.mjs';

const entry = (overrides = {}) => ({ requestId: randomUUID(), time: '2026-10-23T10:00:00.000Z',
  account: 'B', model: 'B-gpt-6.1-sol', upstreamModel: 'gpt-6.1-sol', status: 'completed', httpStatus: 200,
  durationMs: 125, firstResponseMs: 20, usage: { input_tokens: 10, output_tokens: 2 }, ...overrides });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-request-diagnostics-'));
  const path = join(directory, 'state', 'diagnostics.jsonl');
  const journal = await RequestDiagnostics.open({ path, ...options });
  t.after(async () => { await journal.close(); await rm(directory, { recursive: true, force: true }); });
  return { journal, path, directory };
}

test('diagnostic persistence and exports retain only the public whitelist and fixed error messages', async t => {
  const { journal, path } = await fixture(t);
  const record = entry({ status: 'failed', errorCode: 'upstream_failed', failureStage: 'upstream_response',
    message: 'private upstream body', authorizationVersion: 'private binding', terminalVerified: true,
    body: { prompt: 'private prompt' }, headers: { authorization: 'Bearer private credential' },
    token: 'private token', url: 'https://example.invalid/?secret=private-query', path: 'C:\\private\\credentials.json',
    usage: { input_tokens: 0, output_tokens: 0, access_token: 'private nested credential' } });
  assert.deepEqual(await journal.record(record), { recorded: true, persisted: true });
  const stored = journal.detail(record.requestId);
  assert.deepEqual(Object.keys(stored), ['requestId', 'time', 'account', 'model', 'upstreamModel', 'status',
    'httpStatus', 'durationMs', 'firstResponseMs', 'failureStage', 'errorCode', 'message', 'usage']);
  assert.equal(stored.errorCode, 'upstream_failed'); assert.notEqual(stored.message, record.message);
  assert.equal(stored.usage.totalTokens, 0);
  for (const value of [await readFile(path, 'utf8'), JSON.stringify(journal.snapshot()), JSON.stringify(journal.exportReport(record.requestId))]) {
    assert.doesNotMatch(value, /private|authorizationVersion|terminalVerified|access_token|Bearer|credentials\.json/);
  }
  assert.equal(journal.exportReport(randomUUID()), null);
  assert.equal(journal.detail('not-a-request'), null);
});

test('usage normalization preserves explicit zero, authoritative partial counts and safe canonical replay', () => {
  assert.equal(normalizeDiagnosticUsage(null), null); assert.equal(normalizeDiagnosticUsage({}), null);
  assert.deepEqual(normalizeDiagnosticUsage({ input_tokens: 12, output_tokens: 4,
    input_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }),
  { inputTokens: 12, outputTokens: 4, totalTokens: 16, cachedInputTokens: 8, cacheWriteTokens: 2, reasoningTokens: 3 });
  assert.deepEqual(normalizeDiagnosticUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: null, reasoningTokens: null });
  assert.equal(normalizeDiagnosticUsage({ input_tokens: -1, output_tokens: Infinity, total_tokens: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal(normalizeDiagnosticUsage({ output_tokens: 2 }).inputTokens, null);
});

test('diagnostic identity fields cannot publish an email, credential, URL query or filesystem path', () => {
  const result = normalizeDiagnosticRecord(entry({ account: 'person@example.test', model: 'C:/private/auth.json',
    upstreamModel: 'https://example.invalid/model?token=secret', errorCode: 'private-secret', message: 'private-secret' }));
  assert.equal(result.account, null); assert.equal(result.model, null); assert.equal(result.upstreamModel, null);
  assert.equal(normalizeDiagnosticRecord(entry({ model: 'sk-sensitivecredential', upstreamModel: '/home/person/private' })).model, null);
  assert.equal(normalizeDiagnosticRecord(entry({ requestId: 'Bearer-secret' })), null);
  assert.equal(normalizeDiagnosticRecord(entry({ account: 'CB' })).account, 'CodeBuddy');
  assert.equal(normalizeDiagnosticRecord(entry({ durationMs: NaN, firstResponseMs: -1 })).durationMs, null);
});

test('diagnostic model IDs retain legal long aliases and brackets while channel prefixes cannot hide credentials or paths', () => {
  const source = `vendor-model[fast]-${'m'.repeat(237)}`;
  const alias = `CodeBuddy-${source}`;
  assert.ok(alias.length > 255);
  assert.equal(normalizeDiagnosticRecord(entry({ model: alias, upstreamModel: source })).model, alias);
  assert.equal(normalizeDiagnosticRecord(entry({ model: 'vendor-model[reasoning]' })).model, 'vendor-model[reasoning]');
  for (const credential of ['sk-sensitivecredential', 'rt_sensitivecredential', 'oat_sensitivecredential',
    'oaist_sensitivecredential', 'eyJprivate.payload.signature', 'Bearer-sensitivecredential', 'C:/private/auth.json', 'https://private.invalid/model', '/home/private/auth.json']) {
    for (const prefix of ['', 'Cursor-', 'CodeBuddy-', 'B-', 'Cursor-CodeBuddy-', 'Cursor-'.repeat(20)]) {
      const result = normalizeDiagnosticRecord(entry({ model: `${prefix}${credential}`, upstreamModel: `${prefix}${credential}` }));
      assert.equal(result.model, null, `Unsafe prefixed model: ${prefix}`); assert.equal(result.upstreamModel, null);
    }
  }
  for (const model of ['CodeBuddy-vendor/sk-sensitivecredential', 'Cursor-vendor/eyJprivate.payload.signature',
    'CodeBuddy-vendor:rt_sensitivecredential', 'CodeBuddy-vendor/Cursor-oat_sensitivecredential']) {
    assert.equal(normalizeDiagnosticRecord(entry({ model })).model, null);
  }
});

test('failure classification uses explicit status/code and never infers unsupported models from provider prose', () => {
  assert.equal(classifyDiagnosticFailure({ message: 'unsupported model secret' }).errorCode, 'unknown_error');
  assert.equal(classifyDiagnosticFailure({ status: 400, message: 'unsupported model secret' }, { stage: 'upstream_response' }).errorCode, 'payload_rejected');
  assert.equal(classifyDiagnosticFailure({ code: 'model_not_found' }).errorCode, 'model_unavailable');
  assert.equal(classifyDiagnosticFailure({ status: 400 }, { stage: 'validation' }).errorCode, 'invalid_request');
  assert.equal(classifyDiagnosticFailure({ status: 401 }).errorCode, 'authentication_failed');
  assert.equal(classifyDiagnosticFailure({ status: 403 }).errorCode, 'access_denied');
  assert.equal(classifyDiagnosticFailure({ status: 429 }).errorCode, 'quota_or_rate_limited');
  assert.equal(classifyDiagnosticFailure({ cause: { code: 'ECONNRESET' } }).errorCode, 'network_failed');
  assert.equal(classifyDiagnosticFailure(new Error('secret'), { interrupted: true }).errorCode, 'request_interrupted');
});

test('terminal evidence distinguishes a complete response from pending client tools and a missing output list', () => {
  const answer = { type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture answer' }] };
  assert.deepEqual(responsesTerminalEvidence({ status: 'completed', output: [answer] }), { toolPending: false, terminalVerified: true });
  assert.deepEqual(responsesTerminalEvidence({ status: 'completed', output: [] }), { toolPending: false, terminalVerified: false });
  for (const malformed of [{ ...answer, status: 'incomplete' }, { ...answer, content: [] }, { ...answer, content: [{ type: 'output_text', text: '' }] },
    { ...answer, role: 'user' }]) assert.equal(responsesTerminalEvidence({ status: 'completed', output: [malformed] }).terminalVerified, false);
  assert.equal(responsesTerminalEvidence({ status: 'completed' }).terminalVerified, false);
  for (const type of ['function_call', 'custom_tool_call', 'computer_call', 'shell_call', 'apply_patch_call', 'mcp_approval_request']) {
    assert.deepEqual(responsesTerminalEvidence({ status: 'completed', output: [{ type, status: 'completed' }] }), { toolPending: true, terminalVerified: false });
  }
  assert.equal(responsesTerminalEvidence({ status: 'incomplete', output: [{ type: 'message' }] }).terminalVerified, false);
});

test('concurrent appends are serialized, deduplicated and bounded across reopen', async t => {
  const { journal, path } = await fixture(t, { maxRecords: 8 });
  const records = Array.from({ length: 50 }, () => entry());
  const results = await Promise.all(records.map(record => journal.record(record)));
  assert.ok(results.every(result => result.recorded && result.persisted));
  assert.equal((await journal.record(records.at(-1))).duplicate, true);
  assert.deepEqual(journal.snapshot({ limit: 2 }).recent.map(record => record.requestId), records.slice(-2).reverse().map(record => record.requestId));
  assert.equal(journal.snapshot({ limit: 100 }).recent.length, 8);
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 8);
  const reopened = await RequestDiagnostics.open({ path, maxRecords: 8 });
  assert.deepEqual(reopened.snapshot(), journal.snapshot()); await reopened.close();
  const copy = journal.snapshot(); copy.recent[0].usage.inputTokens = 9999;
  assert.equal(journal.detail(records.at(-1).requestId).usage.inputTokens, 10);
});

test('the byte bound trims old records in memory and on disk', async t => {
  const { journal, path } = await fixture(t, { maxRecords: 100, maxBytes: 4096 });
  for (let index = 0; index < 25; index++) await journal.record(entry({ model: `model-${index}-${'m'.repeat(220)}`, upstreamModel: 'u'.repeat(240) }));
  assert.ok((await stat(path)).size <= 4096);
  assert.ok(journal.snapshot({ limit: 100 }).recent.length < 25);
  assert.ok(journal.snapshot({ limit: 100 }).recent.length > 0);
});

test('reopen safely drops corrupt and oversized lines and rewrites untrusted fields out of the journal', async t => {
  const { journal, path } = await fixture(t);
  await journal.close();
  const first = entry({ body: 'private old prompt', message: 'private reflected error', authorizationVersion: 'private identity' });
  const second = entry({ account: 'Cursor' });
  await writeFile(path, `${JSON.stringify(first)}\n${'x'.repeat(20000)}\n{broken}\n${JSON.stringify(second)}\n{incomplete`, 'utf8');
  const recovered = await RequestDiagnostics.open({ path });
  assert.deepEqual(recovered.snapshot().recent.map(record => record.requestId), [second.requestId, first.requestId]);
  assert.doesNotMatch(await readFile(path, 'utf8'), /private|body|authorizationVersion|broken|incomplete|xxxx/);
  assert.equal(recovered.snapshot().error, null); await recovered.close();
});

test('an oversized existing file loads only its bounded tail and compacts it', async t => {
  const { journal, path } = await fixture(t, { maxBytes: 4096 }); await journal.close();
  const last = entry();
  await writeFile(path, `${'private old content\n'.repeat(30000)}${JSON.stringify(last)}\n`);
  const recovered = await RequestDiagnostics.open({ path, maxBytes: 4096 });
  assert.equal(recovered.detail(last.requestId).model, last.model);
  assert.ok((await stat(path)).size <= 4096); assert.doesNotMatch(await readFile(path, 'utf8'), /private/);
  await recovered.close();
});

test('append and open failures remain safe metadata failures and do not throw into callers', async t => {
  const { journal, path, directory } = await fixture(t);
  await rm(path);
  const record = entry();
  assert.deepEqual(await journal.record(record), { recorded: true, persisted: false });
  assert.equal(journal.detail(record.requestId).model, record.model);
  assert.equal(journal.snapshot().error, 'diagnostics_write_failed');
  assert.deepEqual(await journal.flush(), { ok: false, error: 'diagnostics_write_failed' });
  const unavailable = await RequestDiagnostics.open({ path: directory });
  assert.equal(unavailable.snapshot().error, 'diagnostics_unavailable');
  assert.equal((await unavailable.record(entry())).persisted, false);
  assert.doesNotMatch(JSON.stringify(unavailable.snapshot()), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await unavailable.close();
});

test('linked journal parents are rejected without reading or modifying their target', async t => {
  const { journal, directory } = await fixture(t); await journal.close();
  const target = join(directory, 'outside'), link = join(directory, 'linked'); await mkdir(target);
  const content = `${JSON.stringify(entry({ body: 'private outside content' }))}\n`;
  await writeFile(join(target, 'diagnostics.jsonl'), content);
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable.'); return; } throw error; }
  const blocked = await RequestDiagnostics.open({ path: join(link, 'diagnostics.jsonl') });
  assert.equal(blocked.snapshot().error, 'diagnostics_unavailable'); assert.equal(blocked.snapshot().recent.length, 0);
  assert.equal(await readFile(join(target, 'diagnostics.jsonl'), 'utf8'), content); await blocked.close();
});
