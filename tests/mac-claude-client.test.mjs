import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadMacClaudeClient } from '../src/mac-claude-client.mjs';
import { claudeSubscriptionUsage } from '../src/claude-subscription-usage.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bifrost-mac-client-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const save = async (name, value) => { const path = join(dir, name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const key = randomBytes(32).toString('hex'), session = randomBytes(32).toString('hex');
  const gatewayKeyFile = await save('gateway', key), sessionKeyFile = await save('session', session);
  await save('csrf.key', randomBytes(32).toString('base64url'));
  const webAccountsFile = await save('web.json', { version: 1, directory: dir, maxAccounts: 50, maxConcurrent: 1, requestsPerMinute: 20 });
  const config = { version: 1, upstreamPort: 43157, gatewayKeyFile, sessionKeyFile, webAccountsFile };
  return { save, config, key };
}

test('an HTTP 200 with no authenticated models does not advertise a ready Claude source', async t => {
  const f = await fixture(t); let authenticated = false;
  const client = await loadMacClaudeClient(await f.save('config.json', f.config), { fetchImpl: async url =>
    url.endsWith('/v1/models') ? Response.json({ data: authenticated ? [{ id: 'claude-opus' }] : [] })
      : Response.json({ ok: authenticated, providers: {} }) });
  t.after(() => client.close());
  assert.equal(client.status().available, false); assert.equal(client.status().modelCount, 0);
  authenticated = true; await client.refresh(); assert.equal(client.status().available, true);
  authenticated = false; await client.refresh(); assert.equal(client.status().available, false);
  assert.deepEqual(client.models(), []);
});

test('Mac Claude bridge discovers only authenticated catalog and namespaces sessions by account', async t => {
  const f = await fixture(t), calls = []; let available = true;
  const client = await loadMacClaudeClient(await f.save('config.json', f.config), { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/models')) return available ? Response.json({ data: [{ id: 'claude-sonnet', display_name: 'Claude Sonnet' }, { id: 'untrusted' }] })
      : Response.json({ error: {} }, { status: 503 });
    return Response.json({ object: 'chat.completion' });
  } });
  t.after(() => client.close());
  assert.deepEqual(client.models().map(model => model.id), ['Claude-sonnet']);
  assert.equal(client.models()[0].channel, 'Claude'); assert.equal(client.models()[0].upstream, undefined);
  const body = { model: 'Claude-sonnet', stream: true, messages: [], stream_options: { include_usage: false } };
  for (const scope of ['first-user', 'second-user', 'first-user']) await client.requestChat({ body, scope, session: 'shared-session' });
  const requests = calls.filter(call => call.url.endsWith('/v1/chat/completions'));
  assert.equal(requests.length, 3); assert.equal(requests[0].url, 'http://127.0.0.1:43157/v1/chat/completions');
  assert.equal(requests[0].options.headers.authorization, `Bearer ${f.key}`);
  const payload = JSON.parse(requests[0].options.body); assert.equal(payload.model, 'claude-sonnet'); assert.equal(payload.stream_options.include_usage, true);
  const sessions = requests.map(request => request.options.headers['x-session-id']);
  assert.notEqual(sessions[0], sessions[1]); assert.equal(sessions[0], sessions[2]); assert.doesNotMatch(sessions[0], /first-user|shared-session/);
  available = false; await client.refresh(); assert.deepEqual(client.models(), []);
  await assert.rejects(client.requestChat({ body, scope: 'first-user' }), error => error.status === 503);
  assert.equal(requests.length, 3);
});

test('Mac Claude upstream never follows redirects or accepts a caller-selected port', async t => {
  const f = await fixture(t);
  const invalid = await f.save('bad.json', { ...f.config, upstreamPort: 80 });
  await assert.rejects(loadMacClaudeClient(invalid));
  const client = await loadMacClaudeClient(await f.save('config.json', f.config), { fetchImpl: async url => url.endsWith('/v1/models')
    ? Response.json({ data: [{ id: 'claude-opus' }] }) : new Response(null, { status: 302, headers: { location: 'https://other.test' } }) });
  t.after(() => client.close());
  await assert.rejects(client.requestMessages({ body: { model: 'Claude-opus' }, scope: 'account' }), error => error.status === 502);
});

test('private health supplies sanitized usage and account generation; health failure does not remove models or invent zero usage', async t => {
  const f = await fixture(t); let healthy = true; const catalogs = [], calls = [];
  const dto = claudeSubscriptionUsage({ subscription_type: 'pro', rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 3, resets_at: new Date(Date.now() + 3600000).toISOString() } } });
  const client = await loadMacClaudeClient(await f.save('config.json', f.config), { onCatalog: (rows, version) => { catalogs.push({ rows, version }); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'claude-opus', contextWindow: 1000000, contextSource: 'official-cli-runtime' },
        { id: 'claude-sonnet', contextWindow: 999999, contextSource: 'untrusted' }] });
      return healthy ? Response.json({ providers: { Claude: { subscriptionUsage: dto, authorizationVersion: 'a'.repeat(64), email: 'PRIVATE' } } })
        : new Response(null, { status: 302 });
    } });
  t.after(() => client.close());
  assert.equal(client.authorizationVersion, 'a'.repeat(64)); assert.equal(catalogs[0].version, 'a'.repeat(64));
  assert.equal(client.models()[0].contextWindow, 1000000); assert.equal(client.models()[1].contextWindow, undefined);
  assert.equal(client.status().subscriptionUsage.windows[0].usedPercent, 3);
  assert.doesNotMatch(JSON.stringify(client.status()), /PRIVATE|email|authorizationVersion/);
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:43157/') && call.options.redirect === 'manual'
    && call.options.headers.authorization === `Bearer ${f.key}`));
  healthy = false; await client.refresh(); assert.equal(client.models().length, 2); assert.equal(client.status().available, true);
  assert.equal(client.authorizationVersion, null); assert.equal(client.status().subscriptionUsage.status, 'unavailable');
  assert.deepEqual(client.status().subscriptionUsage.windows, []);
});
