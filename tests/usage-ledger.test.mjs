import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger } from '../src/usage-ledger.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(directory, 'private', 'usage.jsonl');
  const options = { path, timeZone: 'America/Los_Angeles' };
  return { directory, path, options, ledger: await UsageLedger.open(options) };
}

function entry(id, overrides = {}) {
  return {
    requestId: id,
    time: '2026-10-18T08:15:00.000Z',
    account: 'B', model: 'B-gpt-6-astra', upstreamModel: 'gpt-6-astra',
    threadId: 'thread-1', responseId: `response-${id}`, status: 'completed', httpStatus: 200,
    usage: {
      input_tokens: 1000, output_tokens: 200, total_tokens: 1200,
      input_tokens_details: { cached_tokens: 500, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 50 },
    },
    ...overrides,
  };
}

test('With usage replays independently from existing Codex account records', async t => {
  const { ledger, options } = await setup(t);
  await ledger.record(entry('codex-before'));
  await ledger.record(entry('with-after', {
    account: 'With', model: 'claude-opus-5-5', upstreamModel: 'claude-opus-5.5',
    usage: { input_tokens: 120, output_tokens: 13,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } },
  }));
  await ledger.flush();
  const snapshot = (await UsageLedger.open(options)).snapshot();
  assert.equal(snapshot.accounts.A.requests, 0);
  assert.equal(snapshot.accounts.B.inputTokens, 1000);
  assert.equal(snapshot.accounts.With.inputTokens, 120);
  assert.equal(snapshot.accounts.With.totalTokens, 133);
  assert.equal(snapshot.accounts.With.cachedInputTokens, 80);
  assert.equal(snapshot.totals.totalTokens, 1333);
  assert.equal(snapshot.models.find(row => row.account === 'With').upstreamModel, 'claude-opus-5.5');
});

test('CodeBuddy usage has its own durable channel even when upstream models match With', async t => {
  const { ledger, options } = await setup(t);
  await ledger.record(entry('a', { account: 'A' }));
  await ledger.record(entry('b'));
  const shared = { model: 'claude-opus-5.5', upstreamModel: 'claude-opus-5.5' };
  await ledger.record(entry('with', { ...shared, account: 'With', usage: { input_tokens: 90, output_tokens: 10 } }));
  await ledger.record(entry('codebuddy', { ...shared, account: 'CodeBuddy', usage: {
    input_tokens: 100, output_tokens: 20,
    input_tokens_details: { cached_tokens: 50, cache_write_tokens: 15 },
    output_tokens_details: { reasoning_tokens: 5 },
  } }));
  await ledger.flush();
  const snapshot = (await UsageLedger.open(options)).snapshot();
  assert.equal(snapshot.accounts.A.totalTokens, 1200);
  assert.equal(snapshot.accounts.B.totalTokens, 1200);
  assert.equal(snapshot.accounts.With.totalTokens, 100);
  assert.equal(snapshot.accounts.CodeBuddy.totalTokens, 120);
  assert.equal(snapshot.accounts.CodeBuddy.cachedInputTokens, 50);
  assert.equal(snapshot.accounts.CodeBuddy.cacheWriteTokens, 15);
  assert.equal(snapshot.accounts.CodeBuddy.reasoningTokens, 5);
  assert.equal(snapshot.totals.totalTokens, 2620);
  const modelRows = snapshot.models.filter(row => row.model === shared.model);
  assert.deepEqual(modelRows.map(row => [row.account, row.totalTokens]), [['CodeBuddy', 120], ['With', 100]]);
  assert.equal(snapshot.recent[0].account, 'CodeBuddy');
  assert.deepEqual(snapshot, ledger.snapshot());
});

test('CodeBuddy missing usage remains unknown while explicit zero remains known after replay', async t => {
  const { ledger, options } = await setup(t);
  const channel = { account: 'CodeBuddy', model: 'claude-codebuddy-opus-5-5', upstreamModel: 'claude-opus-5.5' };
  await ledger.record(entry('codebuddy-unknown', { ...channel, usage: null }));
  await ledger.record(entry('codebuddy-zero', { ...channel, usage: { input_tokens: 0, output_tokens: 0 } }));
  const snapshot = (await UsageLedger.open(options)).snapshot();
  assert.equal(snapshot.accounts.With.requests, 0);
  assert.equal(snapshot.accounts.CodeBuddy.requests, 2);
  assert.equal(snapshot.accounts.CodeBuddy.withUsage, 1);
  assert.equal(snapshot.accounts.CodeBuddy.missingUsage, 1);
  assert.equal(snapshot.accounts.CodeBuddy.inputTokens, 0);
  assert.equal(snapshot.recent[0].usage.totalTokens, 0);
  assert.equal(snapshot.recent[1].usage, null);
});

test('Claude subscription usage and cache counts replay independently from CodeBuddy and Codex', async t => {
  const { ledger, options } = await setup(t);
  await ledger.record(entry('codex-before-cli'));
  await ledger.record(entry('claude-cli', { account: 'Claude', model: 'claude-opus-5-5',
    upstreamModel: 'claude/claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 } } }));
  const replayed = (await UsageLedger.open(options)).snapshot();
  assert.equal(replayed.accounts.B.totalTokens, 1200);
  assert.equal(replayed.accounts.CodeBuddy.requests, 0);
  assert.equal(replayed.accounts.Claude.totalTokens, 120);
  assert.equal(replayed.accounts.Claude.cachedInputTokens, 80);
  assert.equal(replayed.accounts.Claude.cacheWriteTokens, 10);
  assert.equal(replayed.recent[0].account, 'Claude');
});

test('records authoritative token fields without counting cached input or reasoning twice', async t => {
  const { ledger, path } = await setup(t);
  assert.equal(ledger.snapshot().startedAt, null);
  assert.deepEqual(await ledger.record(entry('one')), { recorded: true, duplicate: false });
  const state = ledger.snapshot();
  assert.equal(state.timeZone, 'America/Los_Angeles');
  assert.equal(state.startedAt, '2026-10-18T08:15:00.000Z');
  assert.deepEqual(state.totals, {
    requests: 1, withUsage: 1, missingUsage: 0,
    inputTokens: 1000, outputTokens: 200, totalTokens: 1200,
    cachedInputTokens: 500, cacheWriteTokens: 100, reasoningTokens: 50,
    usageFieldsMissing: {
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    },
  });
  assert.deepEqual(state.accounts.B, state.totals);
  assert.equal(state.accounts.A.requests, 0);
  assert.equal(state.models.length, 1);
  assert.equal(state.models[0].model, 'B-gpt-6-astra');
  assert.equal(state.models[0].totalTokens, 1200);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('the JSONL file contains only whitelisted metadata and normalized tokens', async t => {
  const { ledger, path, options } = await setup(t);
  const record = entry('privacy');
  record.prompt = 'NEVER_STORE_PROMPT';
  record.response = { content: 'NEVER_STORE_RESPONSE' };
  record.Authorization = 'NEVER_STORE_CREDENTIAL';
  record.usage.attribution = { messages: ['NEVER_STORE_ATTRIBUTION'] };
  record.usage.input_tokens_details.messages = ['NEVER_STORE_NESTED_CONTENT'];
  await ledger.record(record);
  await ledger.flush();
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('NEVER_STORE'), false);
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored), [
    'version', 'requestId', 'time', 'account', 'model', 'upstreamModel',
    'threadId', 'responseId', 'status', 'httpStatus', 'usage',
  ]);
  assert.deepEqual(stored.usage, {
    inputTokens: 1000, outputTokens: 200, totalTokens: 1200,
    cachedInputTokens: 500, cacheWriteTokens: 100, reasoningTokens: 50,
  });
  assert.deepEqual((await UsageLedger.open(options)).snapshot().totals, ledger.snapshot().totals);
});

test('missing usage stays unknown and partial usage exposes unknown fields', async t => {
  const { ledger } = await setup(t);
  await ledger.record(entry('none', { usage: null }));
  await ledger.record(entry('empty', { usage: {} }));
  await ledger.record(entry('partial', { usage: { input_tokens: 17 } }));
  const { totals, recent } = ledger.snapshot();
  assert.equal(totals.requests, 3);
  assert.equal(totals.withUsage, 1);
  assert.equal(totals.missingUsage, 2);
  assert.equal(totals.inputTokens, 17);
  assert.equal(totals.outputTokens, 0);
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.usageFieldsMissing.inputTokens, 2);
  assert.equal(totals.usageFieldsMissing.outputTokens, 3);
  assert.equal(totals.usageFieldsMissing.totalTokens, 3);
  assert.equal(recent[0].usage.inputTokens, 17);
  assert.equal(recent[0].usage.outputTokens, null);
  assert.equal(recent[0].usage.totalTokens, null);
  assert.equal(recent[1].usage, null);
  assert.equal(recent[2].usage, null);
});

test('an absent total is derived only from known input and output, without adding details', async t => {
  const { ledger } = await setup(t);
  await ledger.record(entry('derived', { usage: {
    input_tokens: 12, output_tokens: 5,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 4 },
  } }));
  const { totals, recent } = ledger.snapshot();
  assert.equal(totals.totalTokens, 17);
  assert.equal(recent[0].usage.totalTokens, 17);
  await ledger.record(entry('reported', { usage: { input_tokens: 12, output_tokens: 5, total_tokens: 18 } }));
  assert.equal(ledger.snapshot().totals.totalTokens, 35);
});

test('invalid usage counts are unknown, while explicit zero usage is known', async t => {
  const { ledger } = await setup(t);
  await ledger.record(entry('invalid', { usage: {
    input_tokens: '15', output_tokens: -3, total_tokens: Number.MAX_SAFE_INTEGER + 1,
    input_tokens_details: { cached_tokens: 2.4 }, output_tokens_details: { reasoning_tokens: Infinity },
  } }));
  await ledger.record(entry('zero', { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
  const { totals, recent } = ledger.snapshot();
  assert.equal(totals.withUsage, 1);
  assert.equal(totals.missingUsage, 1);
  assert.equal(recent[0].usage.inputTokens, 0);
  assert.equal(recent[1].usage, null);
});

test('failed and interrupted requests retain any server-reported usage', async t => {
  const { ledger } = await setup(t);
  await ledger.record(entry('failed', { status: 'failed', httpStatus: 502, usage: { input_tokens: 100, output_tokens: 3, total_tokens: 103 } }));
  await ledger.record(entry('aborted', { status: 'aborted', httpStatus: null, usage: { input_tokens: 50, output_tokens: 2, total_tokens: 52 } }));
  const { totals, recent } = ledger.snapshot();
  assert.equal(totals.requests, 2);
  assert.equal(totals.totalTokens, 155);
  assert.equal(totals.withUsage, 2);
  assert.equal(recent[0].status, 'aborted');
  assert.equal(recent[1].status, 'failed');
});

test('concurrent duplicate IDs append and count only once, including after restart', async t => {
  const { ledger, path, options } = await setup(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => ledger.record(entry('same'))));
  assert.equal(results.filter(result => result.recorded).length, 1);
  await ledger.flush();
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 1);
  const reopened = await UsageLedger.open(options);
  assert.deepEqual(reopened.snapshot().totals, ledger.snapshot().totals);
  assert.deepEqual(await reopened.record(entry('same', { usage: { input_tokens: 9999 } })), { recorded: false, duplicate: true });
  assert.equal(reopened.snapshot().totals.inputTokens, 1000);
});

test('replay ignores historical duplicate IDs and reports how many were ignored', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('same'));
  const line = await readFile(path, 'utf8');
  await appendFile(path, line);
  const reopened = await UsageLedger.open(options);
  assert.equal(reopened.snapshot().totals.requests, 1);
  assert.equal(reopened.snapshot().recovery.duplicateRecords, 1);
});

test('recent history is bounded at 100 while all accounts and models retain full totals', async t => {
  const { ledger, options } = await setup(t);
  await Promise.all(Array.from({ length: 150 }, (_, index) => ledger.record(entry(`request-${index}`, {
    account: index % 2 ? 'A' : 'B',
    model: index % 2 ? 'gpt-6.1-sol' : 'B-gpt-6-astra',
    upstreamModel: index % 2 ? 'gpt-6.1-sol' : 'gpt-6-astra',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }))));
  await ledger.flush();
  const state = ledger.snapshot();
  assert.equal(state.totals.requests, 150);
  assert.equal(state.totals.totalTokens, 1800);
  assert.equal(state.accounts.A.requests, 75);
  assert.equal(state.accounts.B.requests, 75);
  assert.equal(state.models.length, 2);
  assert.equal(state.models[0].account, 'A');
  assert.equal(state.models[0].requests, 75);
  assert.equal(state.recent.length, 100);
  assert.equal(state.recent[0].requestId, 'request-149');
  assert.equal(state.recent.at(-1).requestId, 'request-50');
  assert.deepEqual((await UsageLedger.open(options)).snapshot(), state);
});

test('an unfinished final JSON line is truncated without losing preceding records', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('complete', { model: '模型' }));
  const before = await readFile(path);
  const tail = Buffer.from('{"version":1,"requestId":"unfinished');
  await appendFile(path, tail);
  const reopened = await UsageLedger.open(options);
  assert.equal(reopened.snapshot().totals.requests, 1);
  assert.equal(reopened.snapshot().recovery.truncatedBytes, tail.length);
  assert.deepEqual(await readFile(path), before);
  await reopened.record(entry('next'));
  assert.equal((await UsageLedger.open(options)).snapshot().totals.requests, 2);
});

test('a valid final record without a newline is preserved and separated before the next append', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('complete'));
  const before = (await readFile(path, 'utf8')).trimEnd();
  await writeFile(path, before);
  const reopened = await UsageLedger.open(options);
  assert.equal(reopened.snapshot().totals.requests, 1);
  assert.equal(reopened.snapshot().recovery.appendedNewline, true);
  assert.equal(await readFile(path, 'utf8'), `${before}\n`);
  await reopened.record(entry('next'));
  assert.equal((await UsageLedger.open(options)).snapshot().totals.requests, 2);
});

test('middle corruption is reported without truncating the file or exposing raw contents', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('first'));
  const valid = await readFile(path, 'utf8');
  const corrupted = `${valid}NEVER_ECHO_PRIVATE_CONTENT\n${valid}`;
  await writeFile(path, corrupted);
  await assert.rejects(UsageLedger.open(options), error => {
    assert.equal(error.code, 'USAGE_LEDGER_CORRUPT');
    assert.equal(error.line, 2);
    assert.equal(error.message.includes('NEVER_ECHO_PRIVATE_CONTENT'), false);
    return true;
  });
  assert.equal(await readFile(path, 'utf8'), corrupted);
});

test('complete malformed lines and valid JSON with an invalid schema are not silently removed', async t => {
  const { path, options } = await setup(t);
  await writeFile(path, 'not JSON\n');
  await assert.rejects(UsageLedger.open(options), { code: 'USAGE_LEDGER_CORRUPT', line: 1 });
  assert.equal(await readFile(path, 'utf8'), 'not JSON\n');
  await writeFile(path, '{"version":1}');
  await assert.rejects(UsageLedger.open(options), { code: 'USAGE_LEDGER_CORRUPT', line: 1 });
  assert.equal(await readFile(path, 'utf8'), '{"version":1}');
});

test('invalid UTF-8 inside a complete record is corruption, rather than replacement text', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('first'));
  const original = await readFile(path);
  const marker = Buffer.from('first');
  const position = original.indexOf(marker);
  const corrupted = Buffer.from(original);
  corrupted[position] = 0xff;
  await writeFile(path, corrupted);
  await assert.rejects(UsageLedger.open(options), { code: 'USAGE_LEDGER_CORRUPT', line: 1 });
  assert.deepEqual(await readFile(path), corrupted);
});

test('an oversized unfinished tail is repaired with bounded replay memory', async t => {
  const { ledger, path, options } = await setup(t);
  await ledger.record(entry('first'));
  const before = await readFile(path);
  const tail = Buffer.alloc(150_000, 0x78);
  await appendFile(path, tail);
  const reopened = await UsageLedger.open(options);
  assert.equal(reopened.snapshot().totals.requests, 1);
  assert.equal(reopened.snapshot().recovery.truncatedBytes, tail.length);
  assert.deepEqual(await readFile(path), before);
});

test('snapshots cannot mutate the internal aggregates or recent records', async t => {
  const { ledger } = await setup(t);
  await ledger.record(entry('first'));
  const external = ledger.snapshot();
  external.totals.inputTokens = -1;
  external.accounts.B.requests = -1;
  external.models[0].requests = -1;
  external.recent[0].usage.inputTokens = -1;
  external.recent.length = 0;
  const state = ledger.snapshot();
  assert.equal(state.totals.inputTokens, 1000);
  assert.equal(state.accounts.B.requests, 1);
  assert.equal(state.models[0].requests, 1);
  assert.equal(state.recent[0].usage.inputTokens, 1000);
});

test('append failures do not update counters and stop future writes until reopen', async t => {
  const { ledger, path } = await setup(t);
  await rm(path);
  await mkdir(path);
  await assert.rejects(ledger.record(entry('failure')), { code: 'USAGE_LEDGER_WRITE_FAILED' });
  assert.equal(ledger.snapshot().totals.requests, 0);
  await rm(path, { recursive: true });
  await writeFile(path, '');
  await assert.rejects(ledger.record(entry('later')), { code: 'USAGE_LEDGER_WRITE_FAILED' });
  await assert.rejects(ledger.flush(), { code: 'USAGE_LEDGER_WRITE_FAILED' });
  assert.equal(await readFile(path, 'utf8'), '');
});

test('invalid source metadata is rejected before append and does not block the next valid record', async t => {
  const { ledger, path } = await setup(t);
  for (const override of [
    { requestId: '' }, { account: 'C' }, { time: 'not a timestamp' }, { time: null },
    { model: 'contains\nnewline' }, { status: '' }, { httpStatus: 999 },
  ]) {
    await assert.rejects(ledger.record(entry('invalid', override)), { code: 'USAGE_LEDGER_INVALID_RECORD' });
  }
  assert.equal(await readFile(path, 'utf8'), '');
  await ledger.record(entry('valid'));
  assert.equal(ledger.snapshot().totals.requests, 1);
  await ledger.flush();
});

test('unsupported time zones are rejected before creating the ledger', async t => {
  const { directory } = await setup(t);
  await assert.rejects(UsageLedger.open({ path: join(directory, 'new.jsonl'), timeZone: 'Not/A_Zone' }), TypeError);
  await assert.rejects(stat(join(directory, 'new.jsonl')), { code: 'ENOENT' });
});
