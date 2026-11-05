import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseClaudeRelay } from '../scripts/diagnose-claude-relay.mjs';

const secret = 'PRIVATE_OAUTH_AND_PROMPT_FIXTURE_DO_NOT_REPORT';
const since = '2026-11-04T12:57:00Z', until = '2026-11-04T13:01:00Z';
async function fixture(t) {
  const temporaryRoot = await import('node:fs/promises').then(fs => fs.realpath(tmpdir()));
  const root = await mkdtemp(join(temporaryRoot, 'claude-diagnostic-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), temporaryRoot); assert.ok(basename(root).startsWith('claude-diagnostic-'));
    await rm(root, { recursive: true, force: true }); });
  const configDir = join(root, 'profile'), folder = join(configDir, 'projects', '-isolated-relay'), configPath = join(root, 'relay.json');
  const transcript = join(folder, '11111111-1111-4111-8111-111111111111.jsonl');
  await mkdir(folder, { recursive: true });
  const config = JSON.stringify({ version: 1, cli: { configDir }, privateKey: secret });
  await writeFile(configPath, config);
  return { root, configDir, configPath, transcript, config };
}

test('relay diagnostics select safe SDK error categories without publishing prompts, raw messages, credentials or paths', async t => {
  const f = await fixture(t);
  const rows = [
    { timestamp: '2026-11-04T12:58:00Z', type: 'assistant', error: 'rate_limit', message: { content: secret } },
    { timestamp: '2026-11-04T12:59:00Z', type: 'assistant', message: { content: secret } },
    { timestamp: '2026-11-04T12:59:20Z', type: 'assistant', error: secret, message: { content: secret } },
    { timestamp: '2026-11-04T12:59:30Z', type: 'error', error: { type: 'overloaded_error', message: secret } },
    { timestamp: '2026-11-04T13:02:00Z', type: 'assistant', error: 'billing_error', message: { content: secret } },
  ];
  const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(f.transcript, bytes);
  const result = await diagnoseClaudeRelay({ configPath: f.configPath, since, until });
  assert.equal(result.readOnly, true); assert.equal(result.realInference, false); assert.equal(result.status, 'errors_found');
  assert.equal(result.events.length, 2); assert.equal(result.events[0].status, 429); assert.equal(result.events[1].status, 503);
  assert.equal(result.unclassifiedErrors, 1); assert.equal(result.scannedFiles, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret)); assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(await readFile(f.configPath, 'utf8'), f.config); assert.equal(await readFile(f.transcript, 'utf8'), bytes);
});

test('diagnostics never guess a context limit from an unclassified invalid-request message', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, JSON.stringify({ timestamp: '2026-11-04T12:59:00Z', type: 'error',
    error: { type: 'invalid_request_error', message: 'prompt is too long ' + secret } }) + '\n');
  const result = await diagnoseClaudeRelay({ configPath: f.configPath, since, until });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].status, 400);
  assert.doesNotMatch(JSON.stringify(result), /context_limit|prompt is too long|PRIVATE_/);
});

test('bounded tail scanning reports incomplete evidence without treating a partial row as a failure', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, JSON.stringify({ timestamp: '2026-11-04T12:58:00Z', type: 'user', content: 'x'.repeat(3 * 1024 * 1024) }) + '\n'
    + JSON.stringify({ timestamp: '2026-11-04T12:59:00Z', type: 'assistant', error: 'authentication_failed' }) + '\n');
  const result = await diagnoseClaudeRelay({ configPath: f.configPath, since, until });
  assert.equal(result.incomplete, true); assert.equal(result.malformedLines, 0);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].status, 401);
});

test('diagnostics classify explicit transport failures without treating user data as a provider error', async t => {
  const f = await fixture(t);
  await writeFile(f.transcript, [
    { timestamp: '2026-11-04T12:58:00Z', type: 'user', error: { status: 401, message: secret } },
    { timestamp: '2026-11-04T12:59:00Z', type: 'error', error: { code: 'ECONNRESET', message: secret } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await diagnoseClaudeRelay({ configPath: f.configPath, since, until });
  assert.equal(result.events.length, 1); assert.equal(result.events[0].code, 'claude_network_error');
  assert.equal(result.events[0].session, 'session-1'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('directory scanning reports an incomplete result when its bounded traversal stops', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 128 }, (_, index) => mkdir(join(f.configDir, 'projects', `empty-${index}`))));
  const result = await diagnoseClaudeRelay({ configPath: f.configPath, since, until });
  assert.equal(result.incomplete, true); assert.equal(result.events.length, 0);
});

test('diagnostic command rejects invalid paths without echoing private input', () => {
  const result = spawnSync(process.execPath, ['scripts/diagnose-claude-relay.mjs', 'PRIVATE_NOT_ABSOLUTE_PATH'], { encoding: 'utf8' });
  assert.equal(result.status, 1); const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'diagnostic_unavailable'); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_NOT_ABSOLUTE_PATH/);
});
