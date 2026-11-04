import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateServerRemotes, configureServerRemote, loadServerRemotesConfig } from '../src/runtime/server-remotes-config.mjs';
import { startServerRemotes, REMOTE_RESPONSES_STATE_PREFIX } from '../src/runtime/server-remotes.mjs';
import { Gateway } from '../src/gateway.mjs';
import { ModelPolicy } from '../src/model-policy.mjs';
import { UsageLedger } from '../src/usage-ledger.mjs';
import { normalizeDiagnosticRecord } from '../src/request-diagnostics.mjs';
import { DesktopWire } from '../src/routing/desktop-wire.mjs';
import { ModelRouter } from '../src/routing/model-router.mjs';

const secret = 'server-remote-fixture-secret-'.repeat(3), apiKey = `bfk_${'R'.repeat(43)}`;
const baseUrl = 'https://mac.example.invalid:47846/v1';
const source = () => ({ id: 'bifrost', kind: 'bifrost-remote', baseUrl, protocols: ['chat-completions', 'messages'], credentialRef: randomUUID() });
const config = () => ({ version: 1, sources: [source()] });
const opus = 'remote/bifrost/Claude-opus', sonnet = 'remote/bifrost/Claude-sonnet';
const codexIncludes = ['reasoning.encrypted_content', 'output.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results',
  'file_search_call.results', 'code_interpreter_call.outputs', 'computer_call_output.output.image_url', 'message.input_image.image_url'];
async function directory(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'bifrost-server-remotes-')));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const message = (model = 'Claude-opus', content = [{ type: 'text', text: 'REMOTE_OK' }]) => Response.json({
  id: 'msg_fixture', type: 'message', role: 'assistant', model, content, stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 4 },
});
const completed = () => Response.json({ id: 'resp_local', object: 'response', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'LOCAL_OK' }] }], usage: { input_tokens: 2, output_tokens: 1 } });

test('remote configuration is metadata only, validates fixed HTTPS, IDs and protocols', () => {
  const original = config(); assert.deepEqual(validateServerRemotes(original), original);
  assert.deepEqual(validateServerRemotes({ version: 1, sources: [] }), { version: 1, sources: [] });
  for (const value of [null, { ...original, apiKey }, { ...original, version: 2 },
    { version: 1, sources: [...original.sources, ...original.sources] },
    { version: 1, sources: Array.from({ length: 9 }, (_, id) => ({ ...source(), id: `r${id}` })) }]) assert.throws(() => validateServerRemotes(value));
  for (const patch of [{ apiKey }, { id: '../target' }, { id: true }, { credentialRef: '../key' },
    { kind: 'codebuddy-local' }, { baseUrl: 'http://mac.test/v1' }, { baseUrl: 'https://user:pass@mac.test/v1' },
    { baseUrl: `${baseUrl}?target=other` }, { protocols: ['unknown'] }, { protocols: [] }]) {
    assert.throws(() => validateServerRemotes({ version: 1, sources: [{ ...source(), ...patch }] }));
  }
});

test('no remote configuration means no credential access, no network or new gateway', async t => {
  const stateDir = await directory(t); let touched = 0;
  const runtime = await startServerRemotes({ stateDir, loadKey: () => { touched++; }, fetchImpl: () => { touched++; } });
  assert.equal(runtime, null); assert.equal(touched, 0);
});

test('protected credential and config publication preserve the prior source on failure', async t => {
  const stateDir = await directory(t), records = new Map(); let saved, failSave = false, failWrite = false;
  const storeFactory = (_dir, entry) => ({ async save(record) {
    if (failSave) throw new Error('DPAPI unavailable'); saved = entry.credentialRef; records.set(saved, record);
  }, async clear() { records.delete(entry.credentialRef); } });
  await configureServerRemote({ stateDir, baseUrl, apiKey, storeFactory });
  const original = await loadServerRemotesConfig(stateDir), previousRef = original.sources[0].credentialRef;
  assert.equal(records.get(previousRef).apiKey, apiKey);
  assert.doesNotMatch(await readFile(join(stateDir, 'upstream-accounts.json'), 'utf8'), /bfk_/);
  for (const fault of ['save', 'config']) {
    failSave = fault === 'save'; failWrite = fault === 'config';
    await assert.rejects(configureServerRemote({ stateDir, baseUrl: 'https://new.test/v1', apiKey, storeFactory,
      ...(failWrite ? { writeConfig: async () => { throw new Error('disk full'); } } : {}) }));
    assert.deepEqual(await loadServerRemotesConfig(stateDir), original);
    assert.equal(records.size, 1); assert.equal(records.get(previousRef).apiKey, apiKey);
  }
  failSave = false;
  await configureServerRemote({ stateDir, id: 'second', baseUrl, apiKey, storeFactory });
  const next = await loadServerRemotesConfig(stateDir);
  assert.equal(next.sources.length, 2); assert.notEqual(saved, previousRef);
  await mkdir(join(stateDir, 'remote-sources.lock'));
  await assert.rejects(configureServerRemote({ stateDir, baseUrl, apiKey, storeFactory }), error => error.code === 'EEXIST');
  assert.deepEqual(await loadServerRemotesConfig(stateDir), next);
});

async function fixture(t, { configured = true, policy = true } = {}) {
  const stateDir = await directory(t), calls = { local: [], remote: [], b: 0, codebuddy: 0 }, usage = [], diagnostics = [];
  const controls = { online: true, status: 200, post: null, models: [{ id: 'Claude-opus' }, { id: 'Claude-sonnet' }] };
  const remotes = configured ? await startServerRemotes({ stateDir, config: config(), secret, loadKey: async () => apiKey,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${apiKey}`); assert.equal(options.redirect, 'manual');
      assert.ok(url.startsWith(baseUrl + '/'));
      if (url.endsWith('/models')) return controls.online ? Response.json({ data: controls.models }) : Response.json({}, { status: 503 });
      calls.remote.push({ url, options, body: JSON.parse(options.body) });
      if (controls.post) return controls.post(url, options);
      if (controls.status !== 200) return new Response('secret-provider-error-and-address', { status: controls.status,
        headers: { 'content-type': 'text/plain', 'retry-after': '12' } });
      return message(JSON.parse(options.body).model);
    } }) : null;
  if (remotes) { t.after(() => remotes.close()); await remotes.refresh(); }
  const modelPolicy = policy ? await ModelPolicy.open({ path: join(stateDir, 'policy.json') }) : null;
  modelPolicy?.setAuthorizationVersionGetter('Bifrost', () => remotes?.generation ?? null);
  const gateway = new Gateway({ gatewayKey: secret, modelPolicy, remoteSources: remotes, catalogWaitMs: 100,
    backend: { async credentials() { calls.b++; throw new Error('B not configured'); } },
    getAProvider: async () => ({ config: { base_url: 'https://company.example.invalid/codex' } }),
    fetchImpl: async (url, options) => { calls.local.push({ url, options });
      return url.includes('/models') ? Response.json({ models: [{ slug: 'company-native', display_name: 'Company native' }] }) : completed(); },
    codeBuddyProvider: { async status() { return { authenticated: true, ready: true, modelAvailable: true }; },
      async request() { calls.codebuddy++; return completed(); } },
    onUsage: async record => usage.push(record), onDiagnostic: record => diagnostics.push(record),
  });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) { if (res.headersSent) res.destroy(); else { res.writeHead(error.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: error.code, message: error.message } })); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/backend-api/codex`;
  const headers = { 'x-account-bridge-key': secret, authorization: 'Bearer company-token', 'chatgpt-account-id': 'company-id',
    cookie: 'company-cookie=secret', 'content-type': 'application/json' };
  const post = (model, input = 'Reply OK', extra = {}, path = '/responses', extraHeaders = {}) => fetch(url + path, {
    method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ model, input, ...extra }),
  });
  return { stateDir, gateway, remotes, modelPolicy, url, headers, calls, controls, usage, diagnostics, post };
}

test('existing Server merges native, CodeBuddy and remote models at its original URL', async t => {
  const f = await fixture(t), response = await fetch(f.url + '/models', { headers: f.headers });
  assert.equal(response.status, 200); const data = await response.json(), ids = data.models.map(row => row.slug);
  assert.deepEqual(ids, ['company-native', 'claude-codebuddy-opus-5-5', opus, sonnet]);
  assert.ok(data.models.find(row => row.slug === opus).model_messages.instructions_template);
  assert.equal(f.calls.remote.length, 0, 'catalog never starts inference');
  const record = f.modelPolicy.snapshot().models.find(row => row.id === opus);
  assert.equal(record.channel, 'Bifrost'); assert.equal(record.enabled, true); assert.equal(record.available, true);
  assert.doesNotMatch(JSON.stringify(record), /bfk_|mac\.example/);
});

test('remote direct POST works without a catalog visit and sends only the personal user credential', async t => {
  const f = await fixture(t), response = await f.post(opus, 'Say REMOTE_OK', { stream: false });
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.model, opus); assert.equal(data.status, 'completed');
  assert.equal(f.calls.remote.length, 1); assert.equal(f.calls.remote[0].body.model, 'Claude-opus');
  assert.deepEqual(f.calls.remote[0].body.tool_choice, { type: 'auto' }, 'default parallel behavior adds no unsupported CLI constraint');
  assert.equal(f.calls.local.length, 0); assert.equal(f.calls.b, 0); assert.equal(f.calls.codebuddy, 0);
  const upstream = f.calls.remote[0].options;
  assert.doesNotMatch(JSON.stringify(upstream), /company-token|company-id|company-cookie|server-remote-fixture-secret/);
  assert.equal(f.usage[0].account, 'Bifrost'); assert.equal(f.usage[0].status, 'completed');
  assert.equal(f.gateway.metrics.accounts.Bifrost.completed, 1);
  assert.equal(f.diagnostics[0].account, 'Bifrost');
  assert.equal(normalizeDiagnosticRecord(f.diagnostics[0]).account, 'Bifrost');
  const ledger = await UsageLedger.open({ path: join(f.stateDir, 'usage.jsonl') });
  await ledger.record(f.usage[0]); await ledger.flush();
  assert.match(await readFile(join(f.stateDir, 'usage.jsonl'), 'utf8'), /"account":"Bifrost"/);
});

for (const stream of [false, true]) for (const include of [null, codexIncludes]) test(`remote Claude handles ${include === null ? 'null' : 'optional output includes'} over ${stream ? 'SSE' : 'JSON'} with scoped credentials and reported usage`, async t => {
  const f = await fixture(t), callerScope = randomUUID(), thread = randomUUID();
  const clientTool = { type: 'function', name: 'local_echo', parameters: { type: 'object', properties: { value: { type: 'string' } } } };
  const response = await f.post(opus, 'Keep this prompt intact.', { stream, store: false, include,
    tools: [clientTool, { type: stream ? 'web_search_preview' : 'web_search' }], tool_choice: 'auto' }, '/responses',
  { 'x-bifrost-client-scope': callerScope, 'thread-id': thread });
  assert.equal(response.status, 200);
  let data;
  if (stream) {
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const events = (await response.text()).trim().split(/\r?\n\r?\n/).map(frame =>
      JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5)));
    assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.filter(event => event.type === 'response.completed').length, 1);
    assert.ok(events.every(event => event.type !== 'response.failed'));
    data = events.at(-1).response;
  } else data = await response.json();
  assert.equal(data.model, opus); assert.equal(data.status, 'completed');
  assert.equal(data.output[0].content[0].text, 'REMOTE_OK'); assert.deepEqual(data.tools, [clientTool]);
  assert.equal(data.usage.input_tokens, 8); assert.equal(data.usage.output_tokens, 4);
  assert.ok(data.output.every(item => item.type !== 'web_search_call')); assert.doesNotMatch(JSON.stringify(data), /"sources"\s*:/);
  assert.equal(f.calls.remote.length, 1); assert.equal(f.calls.local.length, 0); assert.equal(f.calls.b, 0); assert.equal(f.calls.codebuddy, 0);
  const upstream = f.calls.remote[0];
  assert.equal(upstream.url, `${baseUrl}/messages`); assert.equal(upstream.body.model, 'Claude-opus');
  assert.equal(upstream.options.headers.authorization, `Bearer ${apiKey}`); assert.equal(upstream.options.headers['anthropic-version'], '2023-06-01');
  const session = upstream.options.headers['x-session-id'];
  assert.match(session, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(session, callerScope); assert.notEqual(session, thread);
  assert.equal(upstream.body.include, undefined); assert.equal(upstream.body.tools.length, 1);
  assert.ok(upstream.body.tools.every(tool => !['web_search', 'web_search_preview'].includes(tool.type)));
  assert.deepEqual(upstream.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Keep this prompt intact.' }] }]);
  assert.ok(upstream.body.system.some(block => block.text.includes('web search is unavailable')));
  assert.doesNotMatch(JSON.stringify(upstream), /company-token|company-id|company-cookie|server-remote-fixture-secret/);
  assert.equal(f.usage.length, 1); assert.equal(f.usage[0].account, 'Bifrost'); assert.equal(f.usage[0].status, 'completed');
  assert.equal(f.usage[0].usage.input_tokens, 8); assert.equal(f.usage[0].usage.output_tokens, 4);
});

test('remote malformed includes and forced or historical hosted search fail locally without inference', async t => {
  const f = await fixture(t);
  for (const include of ['reasoning.encrypted_content', {}, [12], [{ private: 'PRIVATE_INCLUDE_VALUE' }],
    ['PRIVATE_INCLUDE_VALUE'], ['message.output_text.logprobs'], ['web_search_call.action.sources', 'PRIVATE_INCLUDE_VALUE']]) {
    const response = await f.post(opus, 'hello', { stream: false, include });
    assert.equal(response.status, 400); const data = await response.json();
    assert.equal(data.error.param, 'include'); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_INCLUDE_VALUE/);
  }
  for (const [input, extra, param] of [
    ['hello', { tools: [{ type: 'web_search' }], tool_choice: 'required' }, 'tool_choice'],
    ['hello', { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } }, 'tool_choice'],
    [[{ role: 'user', content: 'hello' }, { type: 'web_search_call', id: 'ws_fixture', action: { query: 'PRIVATE_WEB_QUERY' } }], {}, 'input'],
  ]) {
    const response = await f.post(opus, input, { stream: false, include: codexIncludes, ...extra });
    assert.equal(response.status, 400); const data = await response.json();
    assert.equal(data.error.param, param); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_WEB_QUERY/);
  }
  assert.equal(f.calls.remote.length, 0); assert.equal(f.calls.local.length, 0); assert.equal(f.calls.b, 0); assert.equal(f.calls.codebuddy, 0);
});

test('native and CodeBuddy inference never sends content or credentials to the Mac', async t => {
  const f = await fixture(t, { policy: false });
  assert.equal((await f.post('company-native')).status, 200);
  assert.equal((await f.post('claude-codebuddy-opus-5-5')).status, 200);
  assert.equal(f.calls.remote.length, 0); assert.equal(f.calls.local.length, 1); assert.equal(f.calls.codebuddy, 1);
});

for (const status of [401, 402, 429, 503]) test(`remote HTTP ${status} preserves status, cancels raw error and never falls back`, async t => {
  const f = await fixture(t); f.controls.status = status;
  const response = await f.post(opus); assert.equal(response.status, status);
  assert.equal(response.headers.get('retry-after'), '12'); const body = await response.text();
  assert.doesNotMatch(body, /secret-provider-error-and-address|mac\.example|bfk_/);
  if (status === 402) assert.match(body, /余额不足/);
  assert.equal(f.calls.remote.length, 1); assert.equal(f.calls.local.length, 0); assert.equal(f.calls.b, 0);
  assert.equal(f.gateway.metrics.accounts.Bifrost.failed, 1);
});

test('unconfigured or arbitrary remote IDs cannot route to A or choose a URL', async t => {
  const f = await fixture(t, { configured: false });
  for (const id of [opus, 'remote/attacker/https://other.test', 'REMOTE/bifrost/Claude-opus']) {
    const response = await f.post(id); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'remote_model_unavailable');
  }
  assert.equal(f.calls.local.length, 0); assert.equal(f.calls.b, 0);
});

test('policy disabled or withdrawn remote model refuses inference without local fallback', async t => {
  const f = await fixture(t); await f.gateway.observeRemotes();
  const snapshot = f.modelPolicy.snapshot(); await f.modelPolicy.update({ revision: snapshot.revision, disabledModels: [opus] });
  assert.equal((await f.post(opus)).status, 400); assert.equal(f.calls.remote.length, 0);
  f.controls.online = false; await f.remotes.refresh();
  assert.equal((await f.post(sonnet)).status, 503); assert.equal(f.calls.local.length, 0);
  const response = await fetch(f.url + '/models', { headers: f.headers }), data = await response.json();
  assert.ok(data.models.some(row => row.slug === 'company-native'));
  assert.ok(data.models.every(row => !row.slug.startsWith('remote/')));
});

test('compaction and unregistered query options cannot silently consume remote credit', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(opus, 'test', {}, '/responses/compact')).status, 501);
  assert.equal((await f.post(opus, 'test', {}, '/responses?unsupported=yes')).status, 501);
  assert.equal(f.calls.remote.length, 0); assert.equal(f.calls.local.length, 0);
});

test('opaque remote reasoning survives its source turn and authenticated visible history can switch models or local channels', async t => {
  const f = await fixture(t, { policy: false }), thread = randomUUID();
  f.controls.post = (_url, options) => message(JSON.parse(options.body).model, [
    { type: 'thinking', thinking: 'summary', signature: 'secret-native-signature' }, { type: 'text', text: 'OK' },
  ]);
  const first = await f.post(opus, 'think', { stream: false }, '/responses', { 'thread-id': thread });
  const output = (await first.json()).output, state = output.find(row => row.type === 'reasoning');
  assert.ok(state.encrypted_content.startsWith(REMOTE_RESPONSES_STATE_PREFIX));
  assert.doesNotMatch(JSON.stringify(output), /secret-native-signature/);
  const history = [{ role: 'user', content: 'think' }, ...output, { role: 'user', content: 'continue' }];
  const replay = await f.post(opus, history, { stream: false }, '/responses', { 'thread-id': thread });
  assert.equal(replay.status, 200); await replay.text();
  assert.match(JSON.stringify(f.calls.remote.at(-1).body), /secret-native-signature/);
  for (const id of [sonnet, 'company-native', 'claude-codebuddy-opus-5-5']) {
    const response = await f.post(id, history, { stream: false }, '/responses', { 'thread-id': thread });
    const error = response.status === 200 ? '' : await response.text();
    assert.equal(response.status, 200, `${id}: ${error}`); await response.text();
  }
  assert.doesNotMatch(JSON.stringify(f.calls.remote.at(-1).body), /secret-native-signature|bifrost-remote-responses/);
  assert.doesNotMatch(f.calls.local.at(-1).options.body.toString(), /secret-native-signature|bifrost-remote-responses/);
  const wrongThread = await f.post(opus, history, { stream: false }, '/responses', { 'thread-id': randomUUID() });
  assert.equal(wrongThread.status, 409); await wrongThread.text();
  assert.equal(f.calls.remote.length, 3); assert.equal(f.calls.local.length, 1); assert.equal(f.calls.codebuddy, 1);
});

test('remote compaction is wrapped, resumable and transferable across registered models and local channels', async t => {
  const f = await fixture(t, { policy: false }), thread = randomUUID(), caller = randomUUID(), summary = 'REMOTE_COMPACTED_TASK\nObserved tests: 3 passed. Next: inspect fixture.txt.';
  const headers = { 'thread-id': thread, 'x-bifrost-client-scope': caller };
  f.controls.post = (_url, options) => message(JSON.parse(options.body).model, [{ type: 'text', text: summary }]);
  const compacted = await f.post(opus, [{ role: 'user', content: 'Preserve the exact task.' }, { type: 'compaction_trigger' }],
    { stream: false }, '/responses', headers);
  assert.equal(compacted.status, 200);
  const data = await compacted.json(); assert.equal(data.output.length, 1); assert.equal(data.output[0].type, 'compaction');
  const checkpoint = data.output[0].encrypted_content;
  assert.ok(checkpoint.startsWith(REMOTE_RESPONSES_STATE_PREFIX + 'v2.'));
  assert.doesNotMatch(JSON.stringify(data), /REMOTE_COMPACTED_TASK|bifrost-messages-compaction-v1/);
  assert.equal(await f.remotes.openCompactionForHandoff(checkpoint, { clientScope: caller, session: thread }), summary);
  const history = [...data.output, { role: 'user', content: 'Continue without losing the task.' }], before = structuredClone(history);
  f.controls.post = (_url, options) => message(JSON.parse(options.body).model);
  for (const id of [opus, sonnet]) {
    const response = await f.post(id, history, { stream: false }, '/responses', headers);
    assert.equal(response.status, 200); await response.text();
    const upstream = f.calls.remote.at(-1).body;
    assert.ok(upstream.messages.some(row => row.role === 'user' && row.content.some(block => block.type === 'text' && block.text.includes(summary))));
    assert.doesNotMatch(JSON.stringify(upstream), /bifrost-remote-responses|bifrost-messages-compaction/);
  }
  const toA = await f.post('company-native', history, { stream: false }, '/responses', headers);
  assert.equal(toA.status, 200); await toA.text();
  const native = JSON.parse(f.calls.local.at(-1).options.body);
  assert.equal(native.input[0].role, 'user'); assert.ok(native.input[0].content[0].text.includes(summary));
  assert.doesNotMatch(JSON.stringify(native), /bifrost-remote-responses|bifrost-messages-compaction/);
  let received;
  f.gateway.codeBuddyProvider.request = async ({ body }) => { received = JSON.parse(body); return completed(); };
  const toCodeBuddy = await f.post('claude-codebuddy-opus-5-5', history, { stream: false }, '/responses', headers);
  assert.equal(toCodeBuddy.status, 200); await toCodeBuddy.text();
  assert.equal(received.input[0].role, 'user'); assert.ok(received.input[0].content[0].text.includes(summary));
  assert.doesNotMatch(JSON.stringify(received), /bifrost-remote-responses|bifrost-messages-compaction/);
  assert.deepEqual(history, before);
});

test('remote checkpoints reject routing-hint, kind, ciphertext, owner, session and authorization changes before inference', async t => {
  const f = await fixture(t, { policy: false }), thread = randomUUID(), caller = randomUUID();
  const headers = { 'thread-id': thread, 'x-bifrost-client-scope': caller };
  f.controls.post = (_url, options) => message(JSON.parse(options.body).model, [{ type: 'text', text: 'AUTHENTICATED_REMOTE_SUMMARY' }]);
  const output = (await (await f.post(opus, [{ role: 'user', content: 'Summarize.' }, { type: 'compaction_trigger' }],
    { stream: false }, '/responses', headers)).json()).output;
  const token = output[0].encrypted_content, marker = REMOTE_RESPONSES_STATE_PREFIX + 'v2.';
  const packet = JSON.parse(Buffer.from(token.slice(marker.length), 'base64url'));
  const history = token => [{ ...output[0], encrypted_content: token }, { role: 'user', content: 'Continue.' }];
  for (const changes of [{ model: sonnet }, { kind: 'reasoning' }, { protocol: 'messages' },
    { state: packet.state.slice(0, -5) + 'abcde' }, { version: 3 }]) {
    const edited = marker + Buffer.from(JSON.stringify({ ...packet, ...changes })).toString('base64url');
    const reply = await f.post('company-native', history(edited), { stream: false }, '/responses', headers);
    assert.equal(reply.status, 409); await reply.text();
  }
  for (const changed of [{ 'thread-id': randomUUID() }, { 'x-bifrost-client-scope': randomUUID() }]) {
    const reply = await f.post(sonnet, history(token), { stream: false }, '/responses', { ...headers, ...changed });
    assert.equal(reply.status, 409); await reply.text();
  }
  const newKey = `bfk_${'N'.repeat(43)}`; let externalCalls = 0;
  const reauthorized = await startServerRemotes({ stateDir: f.stateDir, config: config(), secret, loadKey: async () => newKey,
    fetchImpl: async (_url, options) => { assert.equal(options.headers.authorization, `Bearer ${newKey}`);
      if (options.method === 'POST') externalCalls++;
      return Response.json({ data: [{ id: 'Claude-opus' }, { id: 'Claude-sonnet' }] }); } });
  t.after(() => reauthorized.close()); await reauthorized.refresh();
  await assert.rejects(reauthorized.openCompactionForHandoff(token, { clientScope: caller, session: thread }), error => error.status === 409);
  assert.equal(externalCalls, 0);
  f.controls.models = [{ id: 'Claude-sonnet' }]; await f.remotes.refresh();
  const withdrawn = await f.post(sonnet, history(token), { stream: false }, '/responses', headers);
  assert.equal(withdrawn.status, 503); await withdrawn.text();
  assert.equal(f.calls.remote.length, 1); assert.equal(f.calls.local.length, 0); assert.equal(f.calls.codebuddy, 0);
});

test('legacy anonymous remote reasoning resumes only its explicitly selected source model without guessing routes', async t => {
  const f = await fixture(t, { policy: false }), thread = randomUUID();
  f.controls.post = (_url, options) => message(JSON.parse(options.body).model, [
    { type: 'thinking', thinking: 'legacy thought', signature: 'LEGACY_PRIVATE_SIGNATURE' }, { type: 'text', text: 'Legacy reply.' },
  ]);
  const output = (await (await f.post(opus, 'Start legacy fixture.', { stream: false }, '/responses', { 'thread-id': thread })).json()).output;
  const provider = { id: 'bifrost', kind: 'bifrost-remote', generation: createHash('sha256').update(JSON.stringify([baseUrl, apiKey])).digest('hex'),
    catalogSnapshot: () => [{ id: 'Claude-opus', protocols: ['responses'] }], async refreshCatalog() {}, async request() {}, status: () => ({}), async close() {} };
  const context = new ModelRouter({ providers: [provider], secret }).resolve('responses', {
    body: { model: opus }, owner: 'server-owner', session: thread, trackSession: false,
  });
  const modern = new DesktopWire({ secret, prefix: REMOTE_RESPONSES_STATE_PREFIX, selfDescribingState: true });
  const inner = modern.input({ input: output }, context).input;
  const oldWire = new DesktopWire({ secret, prefix: REMOTE_RESPONSES_STATE_PREFIX });
  const legacy = (await (await oldWire.response(Response.json({ output: inner }), context)).json()).output;
  assert.equal(modern.stateHint(legacy.find(row => row.type === 'reasoning').encrypted_content), null);
  const history = [{ role: 'user', content: 'Start legacy fixture.' }, ...legacy, { role: 'user', content: 'Continue.' }];
  const same = await f.post(opus, history, { stream: false }, '/responses', { 'thread-id': thread });
  assert.equal(same.status, 200); await same.text(); assert.match(JSON.stringify(f.calls.remote.at(-1).body), /LEGACY_PRIVATE_SIGNATURE/);
  for (const target of [sonnet, 'company-native']) {
    const reply = await f.post(target, history, { stream: false }, '/responses', { 'thread-id': thread });
    assert.equal(reply.status, 409); await reply.text();
  }
  assert.equal(f.calls.remote.length, 2); assert.equal(f.calls.local.length, 0);
});

test('cancelling a Server remote request reaches its single transport', async t => {
  const f = await fixture(t); let signal; const entered = Promise.withResolvers();
  f.controls.post = (_url, options) => { signal = options.signal; entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); };
  const abort = new AbortController(), pending = f.remotes.request({ path: '/responses', body: { model: opus, input: 'test' }, signal: abort.signal });
  await entered.promise; abort.abort(); const response = await pending;
  assert.equal(response.status, 499); await response.text(); assert.equal(signal.aborted, true); assert.equal(f.calls.remote.length, 1);
});

test('native direct-caller metadata survives Responses tools and altered arguments cannot reuse it', async t => {
  const f = await fixture(t), callId = 'toolu_direct_fixture';
  const tools = [{ type: 'function', name: 'read_fixture', description: 'Read a test file.', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
  } }];
  f.controls.post = (_url, options) => {
    const body = JSON.parse(options.body);
    if (f.calls.remote.length === 1) return Response.json({ id: 'msg_tool', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'tool_use', id: callId, name: body.tools[0].name, input: { path: 'proof.txt' }, caller: { type: 'direct' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 } });
    const tool = body.messages.find(row => row.role === 'assistant').content.find(block => block.type === 'tool_use');
    assert.deepEqual(tool.caller, { type: 'direct' }); assert.deepEqual(tool.input, { path: 'proof.txt' });
    assert.equal(body.messages.at(-1).content[0].tool_use_id, callId);
    return message();
  };
  const first = await f.post(opus, 'read proof.txt', { tools, stream: false, parallel_tool_calls: true, include: codexIncludes });
  assert.equal(first.status, 200); const output = (await first.json()).output;
  assert.doesNotMatch(JSON.stringify(output), /"caller"/);
  const history = [{ role: 'user', content: 'read proof.txt' }, ...output, { type: 'function_call_output', call_id: callId, output: 'fixture' }];
  const modified = structuredClone(history); modified.find(row => row.type === 'function_call').arguments = JSON.stringify({ path: 'different.txt' });
  assert.equal((await f.post(opus, modified, { tools, stream: false, include: codexIncludes })).status, 409);
  assert.equal(f.calls.remote.length, 1, 'tampering is rejected before another remote request');
  const continuation = await f.post(opus, history, { tools, stream: false, include: codexIncludes });
  assert.equal(continuation.status, 200); await continuation.text(); assert.equal(f.calls.remote.length, 2);
  assert.equal(f.calls.remote[0].body.include, undefined); assert.equal(f.calls.remote[1].body.include, undefined);
  assert.equal(f.calls.remote[0].options.headers['x-session-id'], f.calls.remote[1].options.headers['x-session-id']);
});

test('explicit single-tool requests keep their restriction', async t => {
  const f = await fixture(t);
  await (await f.post(opus, 'test', { stream: false, parallel_tool_calls: false })).text();
  assert.equal(f.calls.remote[0].body.tool_choice.disable_parallel_tool_use, true);
});

test('unsupported upstream caller metadata is refused before exposing a tool call', async t => {
  const f = await fixture(t);
  f.controls.post = (_url, options) => {
    const body = JSON.parse(options.body);
    return Response.json({ id: 'msg_unsupported', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'tool_use', id: 'call_unsupported', name: body.tools[0].name, input: {}, caller: { type: 'unsupported-origin' } }],
      stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 1 } });
  };
  const response = await f.post(opus, 'test', { stream: false, tools: [{ type: 'function', name: 'test', parameters: { type: 'object' } }] });
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /"function_call"|call_unsupported/);
  assert.equal(f.calls.remote.length, 1);
});

test('old model policy files reload Bifrost entries without losing disabled switches', async t => {
  const f = await fixture(t); await f.gateway.observeRemotes();
  const snapshot = f.modelPolicy.snapshot(); await f.modelPolicy.update({ revision: snapshot.revision, disabledModels: [opus] });
  const reloaded = await ModelPolicy.open({ path: join(f.stateDir, 'policy.json') });
  assert.equal(reloaded.snapshot().available, true); assert.throws(() => reloaded.assertEnabled(opus), error => error.code === 'model_disabled');
});
