import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSdkWorker, CLAUDE_AGENT_SDK_VERSION, CLAUDE_CLIENT_MCP_SERVER,
  CLAUDE_CLIENT_MCP_TIMEOUT_MS, CLAUDE_CLIENT_SYSTEM_PROMPT, buildClaudeEnvironment } from '../src/claude-sdk-worker.mjs';
import { claudeSourceError } from '../src/claude-source-errors.mjs';

const root = join(tmpdir(), 'offline-claude-worker');
const sessionId = 'b6b38769-021a-4931-a050-c54a2f79277b';
const key = 'offline-independent-client-mcp-key-not-for-logging';

function configuration(options = {}) {
  return { binary: join(root, process.platform === 'win32' ? 'claude.exe' : 'claude'),
    cwd: join(root, 'work'), configDir: join(root, 'profile'), model: 'claude-opus-5-5',
    systemPrompt: 'Use the client tools.', mcpUrl: 'http://127.0.0.1:43175/mcp/offline',
    mcpKey: key, maxTokens: 4096, env: {}, ...options };
}

function channel() {
  const values = [], readers = [];
  let ended = false, error = null, readCount = 0;
  return {
    get readCount() { return readCount; },
    push(value) { const reader = readers.shift(); if (reader) reader.resolve({ value, done: false }); else values.push(value); },
    end(failure = null) {
      ended = true; error = failure;
      for (const reader of readers.splice(0)) {
        if (error) reader.reject(error); else reader.resolve({ done: true, value: undefined });
      }
    },
    next() {
      readCount++;
      if (values.length) return Promise.resolve({ done: false, value: values.shift() });
      if (error) return Promise.reject(error);
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve, reject) => readers.push({ resolve, reject }));
    },
    return() { values.length = 0; this.end(); return Promise.resolve({ done: true, value: undefined }); },
    [Symbol.asyncIterator]() { return this; },
  };
}

function fakeQuery({ readInput = true } = {}) {
  const output = channel(), received = [], calls = [];
  let closeCount = 0, inputEnded = false, inputOperation;
  return {
    output, calls, received,
    get closeCount() { return closeCount; },
    get inputEnded() { return inputEnded; },
    get inputOperation() { return inputOperation; },
    queryImpl(parameters) {
      calls.push(parameters);
      const aborted = () => output.end();
      parameters.options.abortController.signal.addEventListener('abort', aborted, { once: true });
      if (readInput) inputOperation = (async () => {
        for await (const message of parameters.prompt) received.push(message);
        inputEnded = true;
      })();
      return {
        [Symbol.asyncIterator]() { return output; },
        close() {
          closeCount++;
          parameters.options.abortController.signal.removeEventListener('abort', aborted);
          output.end();
        },
      };
    },
  };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'offline SDK fixture timed out');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function workerFixture(testContext, options = {}, fakeOptions) {
  const fake = fakeQuery(fakeOptions);
  const worker = new ClaudeSdkWorker(configuration({ ...options, queryImpl: fake.queryImpl }));
  testContext.after(() => worker.close());
  return { fake, worker };
}

test('construction and closing an unused worker never import or invoke the SDK', async () => {
  const worker = new ClaudeSdkWorker(configuration());
  assert.equal(CLAUDE_AGENT_SDK_VERSION, '0.3.304');
  assert.equal(CLAUDE_CLIENT_MCP_SERVER, 'client');
  assert.equal(worker.sessionId, null);
  await worker.close();
  assert.deepEqual(await worker.done, { reason: 'closed', error: null, sessionId: null });
  await assert.rejects(worker.start(), { message: 'Claude SDK worker is closed.' });
});

test('concurrent startup opens one query using only the pinned executable and client MCP tools', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  assert.equal(fake.calls.length, 0);
  await Promise.all([worker.start(), worker.start()]);
  assert.equal(fake.calls.length, 1);
  const { options, prompt } = fake.calls[0];
  assert.equal(options.pathToClaudeCodeExecutable, configuration().binary);
  assert.equal(options.cwd, configuration().cwd);
  assert.equal(options.model, configuration().model);
  assert.equal(options.systemPrompt, 'Use the client tools.');
  assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, { client: { type: 'http', url: configuration().mcpUrl,
    headers: { Authorization: `Bearer ${key}` }, alwaysLoad: true, timeout: CLAUDE_CLIENT_MCP_TIMEOUT_MS } });
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.verbatimPrompts, true);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.persistSession, true);
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.settings.includeGitInstructions, false);
  assert.equal(options.settings.disableClaudeAiConnectors, true);
  assert.equal(options.env.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(options.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
  assert.equal(Object.hasOwn(options, 'disableHooks'), false);
  assert.equal(Object.hasOwn(options, 'allowDangerouslySkipPermissions'), false);
  assert.equal(Object.hasOwn(options, 'allowedTools'), false);
  assert.equal(Object.hasOwn(options, 'maxTokens'), false);
  assert.equal(Object.hasOwn(options, 'maxOutputTokens'), false);
  assert.equal(Object.hasOwn(options, 'thinking'), false);
  assert.equal(Object.hasOwn(options, 'effort'), false);
});

test('empty client instructions use the client-tool permission prompt', async testContext => {
  for (const systemPrompt of [undefined, '', '  \n', [], ['', ' ']]) {
    const { worker, fake } = workerFixture(testContext, { systemPrompt });
    await worker.start();
    assert.equal(fake.calls[0].options.systemPrompt, CLAUDE_CLIENT_SYSTEM_PROMPT);
    assert.ok(CLAUDE_CLIENT_SYSTEM_PROMPT.trim());
  }
});

test('only client MCP permission requests are delegated and built-in execution remains denied', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  const { canUseTool } = fake.calls[0].options;
  const input = { file_path: 'frontend-file', questions: [{ question: 'User choice?' }] };
  for (const name of ['mcp__client__read_file', 'mcp__client__AskUserQuestion', 'mcp__client__mcp__tool__search']) {
    const decision = await canUseTool(name, input);
    assert.equal(decision.behavior, 'allow');
    assert.equal(decision.updatedInput, input);
  }
  for (const name of ['Read', 'Write', 'Bash', 'Agent', 'AskUserQuestion', 'mcp__other__read_file',
    'mcp__client__', 'mcp__client__read/../../Bash', undefined]) {
    const decision = await canUseTool(name, input);
    assert.equal(decision.behavior, 'deny');
    assert.equal(Object.hasOwn(decision, 'updatedInput'), false);
  }
});

test('environment snapshots retain OS and proxy settings while dropping API, OAuth and provider credentials', async testContext => {
  const env = { PATH: 'offline-path', SystemRoot: 'C:\\Windows', HTTP_PROXY: 'http://proxy.invalid:17890',
    https_proxy: 'http://proxy.invalid:17890', NO_PROXY: 'internal.example', NODE_EXTRA_CA_CERTS: 'offline-ca.pem',
    ANTHROPIC_API_KEY: 'private-api-key', anthropic_auth_token: 'private-auth-token',
    ANTHROPIC_BASE_URL: 'http://wrong-gateway.invalid', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: private-token',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'private-oauth-token', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'private-refresh-token',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9999', CLAUDE_CODE_EFFORT_LEVEL: 'low', MAX_THINKING_TOKENS: '1234',
    CLAUDE_CONFIG_DIR: 'wrong-profile', CLAUDE_CODE_SESSION_ID: 'wrong-session',
    AWS_ACCESS_KEY_ID: 'private-cloud-key', GOOGLE_APPLICATION_CREDENTIALS: 'private-cloud-file',
    OPENAI_API_KEY: 'private-other-key', NODE_OPTIONS: '--require=private-preload',
    OTEL_LOG_RAW_API_BODIES: 'file:private-log', ENABLE_PROMPT_CACHING_1H: '1', DISABLE_PROMPT_CACHING: '1',
    CLAUDE_CODE_DISABLE_ATTACHMENTS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' };
  const original = { ...env };
  const { worker, fake } = workerFixture(testContext, { env, maxTokens: 1,
    mcpUrl: 'http://127.0.0.2:43175/mcp/offline' });
  env.ANTHROPIC_API_KEY = 'changed-after-configuration';
  await worker.start();
  const child = fake.calls[0].options.env;
  assert.equal(child.PATH, original.PATH);
  assert.equal(child.SystemRoot, original.SystemRoot);
  assert.equal(child.HTTP_PROXY, original.HTTP_PROXY);
  assert.equal(child.https_proxy, original.https_proxy);
  assert.equal(child.NODE_EXTRA_CA_CERTS, original.NODE_EXTRA_CA_CERTS);
  for (const value of ['internal.example', '127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
    assert.ok(child.NO_PROXY.split(',').includes(value));
  }
  assert.equal(child.CLAUDE_CONFIG_DIR, configuration().configDir);
  assert.equal(child.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '1');
  assert.equal(child.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(child.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(child.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1');
  assert.equal(child.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(child.DISABLE_AUTO_COMPACT, '1');
  assert.equal(child.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS, '0');
  assert.equal(child.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, '0');
  assert.equal(child.MCP_TOOL_TIMEOUT, '3600000');
  for (const name of Object.keys(original).filter(name => !['PATH', 'SystemRoot', 'HTTP_PROXY', 'https_proxy',
    'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_DISABLE_ATTACHMENTS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'].includes(name))) {
    assert.equal(Object.hasOwn(child, name), false, `${name} must not leak into the official CLI environment`);
  }
  assert.doesNotMatch(JSON.stringify(child), /private-api-key|private-auth-token|private-oauth-token|wrong-gateway|private-other-key/);
  assert.equal(original.CLAUDE_CONFIG_DIR, 'wrong-profile');
});

test('auth-status and SDK worker share the installer private profile layout', async testContext => {
  const profileDir = join(root, 'data', 'profile'), configDir = join(profileDir, '.claude');
  const env = { USERPROFILE: 'wrong-home', HOME: 'wrong-home', APPDATA: 'wrong-roaming',
    LOCALAPPDATA: 'wrong-local', TEMP: 'wrong-temp', TMP: 'wrong-temp',
    XDG_CONFIG_HOME: 'wrong-config', CLAUDE_SECURESTORAGE_CONFIG_DIR: 'wrong-storage',
    CODEX_HOME: 'real-codex-home', ANTHROPIC_API_KEY: 'private-api-key', PATH: 'offline-path' };
  const shared = buildClaudeEnvironment({ configDir, profileDir, env });
  assert.equal(shared.USERPROFILE, profileDir); assert.equal(shared.HOME, profileDir);
  assert.equal(shared.APPDATA, join(profileDir, 'AppData', 'Roaming'));
  assert.equal(shared.LOCALAPPDATA, join(profileDir, 'AppData', 'Local'));
  assert.equal(shared.CLAUDE_CONFIG_DIR, configDir);
  assert.equal(shared.CLAUDE_SECURESTORAGE_CONFIG_DIR, configDir);
  assert.equal(shared.XDG_CONFIG_HOME, join(root, 'data', 'config'));
  assert.equal(shared.XDG_CACHE_HOME, join(root, 'data', 'cache'));
  assert.equal(shared.XDG_DATA_HOME, join(root, 'data', 'shared'));
  assert.equal(shared.XDG_STATE_HOME, join(root, 'data', 'state'));
  assert.equal(shared.XDG_RUNTIME_DIR, join(root, 'data', 'runtime'));
  assert.equal(shared.CLAUDE_CODE_TMPDIR, join(root, 'data', 'temp', 'claude'));
  assert.equal(shared.TEMP, join(root, 'data', 'temp')); assert.equal(shared.TMP, shared.TEMP);
  assert.equal(shared.CODEX_HOME, join(root, 'data', 'empty-codex'));
  assert.equal(shared.CODEX_SQLITE_HOME, shared.CODEX_HOME);
  assert.equal(shared.CODEX_LOG_DIR, join(shared.CODEX_HOME, 'logs'));
  assert.equal(Object.hasOwn(shared, 'ANTHROPIC_API_KEY'), false);
  assert.equal(env.HOME, 'wrong-home');
  const { worker, fake } = workerFixture(testContext, { configDir, profileDir, env });
  await worker.start();
  for (const name of Object.keys(shared)) assert.equal(fake.calls[0].options.env[name], shared[name]);
});

test('structured user inputs survive multiple results without closing the persistent input stream', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  const iterator = worker.events[Symbol.asyncIterator]();
  const content = [{ type: 'text', text: '/literal @file should stay unchanged' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'offline-base64' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'offline-pdf' }, title: 'Explicit file' }];
  const sent = worker.send(content);
  content[0].text = 'caller mutation';
  const uuid = await sent;
  await until(() => fake.received.length === 1);
  const first = fake.received[0];
  assert.equal(first.type, 'user'); assert.equal(first.uuid, uuid);
  assert.equal(first.parent_tool_use_id, null); assert.equal(first.client_composed, true);
  assert.equal(first.message.role, 'user');
  assert.equal(first.message.content[0].text, '/literal @file should stay unchanged');
  assert.deepEqual(first.message.content[1], content[1]);
  assert.deepEqual(first.message.content[2], content[2]);
  const result = { type: 'result', subtype: 'success', session_id: sessionId, result: 'offline result' };
  fake.output.push(result);
  assert.equal((await iterator.next()).value, result);
  assert.equal(worker.sessionId, sessionId);
  assert.equal(fake.inputEnded, false);
  await worker.send([{ type: 'tool_result', tool_use_id: 'toolu_offline', content: 'frontend answer' }]);
  await until(() => fake.received.length === 2);
  assert.equal(fake.received[1].message.content[0].tool_use_id, 'toolu_offline');
  assert.notEqual(fake.received[1].uuid, first.uuid);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.inputEnded, false);
});

test('SDK events remain unmodified and buffered events drain after a natural process exit', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  const events = [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'offline' } }, session_id: sessionId },
    { type: 'assistant', message: { id: 'same-message', content: [{ type: 'text', text: 'offline' }] }, session_id: sessionId },
    { type: 'result', subtype: 'success', usage: { cache_read_input_tokens: 120 }, session_id: sessionId },
  ];
  for (const event of events) fake.output.push(event);
  fake.output.end();
  assert.deepEqual(await worker.done, { reason: 'completed', error: null, sessionId });
  const actual = [];
  for await (const event of worker.events) actual.push(event);
  assert.deepEqual(actual, events);
  for (let index = 0; index < events.length; index++) assert.equal(actual[index], events[index]);
  assert.equal(fake.closeCount, 1);
  assert.equal(fake.inputEnded, true);
  await assert.rejects(worker.send('new turn after exit'), { message: 'Claude SDK worker is closed.' });
});

test('resume, output cap, effort and thinking are fixed on the worker configuration', async testContext => {
  const thinking = { type: 'enabled', budgetTokens: 2048, display: 'summarized' };
  const systemPrompt = ['static instructions', 'dynamic context'];
  const { worker, fake } = workerFixture(testContext, { resumeSessionId: sessionId, maxTokens: 8192,
    effort: 'xhigh', thinking, systemPrompt });
  thinking.budgetTokens = 7777; systemPrompt[0] = 'caller mutation';
  assert.equal(worker.sessionId, sessionId);
  await worker.start();
  const options = fake.calls[0].options;
  assert.equal(options.resume, sessionId);
  assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192');
  assert.equal(options.effort, 'xhigh');
  assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 2048, display: 'summarized' });
  assert.deepEqual(options.systemPrompt, ['static instructions', 'dynamic context']);
  await worker.send('first'); await worker.send('second');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options, options);
});

test('close aborts the query, closes waiting input and output, and is idempotent', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.send('waiting fixture');
  await until(() => fake.received.length === 1);
  const iterator = worker.events[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Promise.all([worker.close(), worker.close()]);
  assert.equal((await pending).done, true);
  assert.equal(fake.calls[0].options.abortController.signal.aborted, true);
  assert.equal(fake.closeCount, 1);
  await fake.inputOperation;
  assert.equal(fake.inputEnded, true);
  assert.deepEqual(await worker.done, { reason: 'closed', error: null, sessionId: null });
});

test('breaking the sole event consumer cancels its worker', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  fake.output.push({ type: 'system', subtype: 'init', session_id: sessionId });
  for await (const _event of worker.events) break;
  assert.equal((await worker.done).reason, 'closed');
  assert.equal(fake.closeCount, 1);
  assert.throws(() => worker.events[Symbol.asyncIterator](), /already have a consumer/);
});

test('startup failures expose a fixed error instead of private SDK diagnostics', async () => {
  const worker = new ClaudeSdkWorker(configuration({ queryImpl() { throw new Error(`private failure ${key}`); } }));
  await assert.rejects(worker.start(), { message: 'Claude SDK worker could not start.' });
  const result = await worker.done;
  assert.equal(result.reason, 'failed');
  assert.equal(result.error, 'Claude SDK worker could not start.');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  await worker.close();
});

test('stream failures close the query and propagate only a fixed error', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  fake.output.end(new Error(`private stream failure ${key}`));
  const actual = [];
  await assert.rejects(async () => { for await (const event of worker.events) actual.push(event); },
    { message: 'Claude SDK worker stream failed.' });
  assert.deepEqual(actual, []);
  const result = await worker.done;
  assert.deepEqual(result, { reason: 'failed', error: 'Claude SDK worker stream failed.', sessionId: null });
  assert.equal(fake.closeCount, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
});

for (const [fields, code] of [[{ status: 429 }, 'claude_rate_limited'], [{ type: 'authentication_error' }, 'claude_authentication_failed'],
  [{ code: 'ECONNRESET' }, 'claude_network_error'], [{ name: 'AbortError', status: 429 }, 'claude_request_interrupted']]) {
  test(`SDK exceptions preserve ${code} without private exception text or credentials`, async testContext => {
    const { worker, fake } = workerFixture(testContext);
    await worker.start();
    fake.output.end(Object.assign(new Error(`PRIVATE_SDK_EXCEPTION ${key} /Users/private/config`), fields));
    const source = claudeSourceError(code);
    await assert.rejects(async () => { for await (const _event of worker.events) {} }, error => {
      assert.equal(error.code, code); assert.equal(error.message, source.message);
      assert.equal(error.cause, undefined); return true;
    });
    const result = await worker.done;
    assert.deepEqual(result, { reason: 'failed', error: source.message, sessionId: null });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SDK_EXCEPTION|offline-independent|\/Users\/private/);
    assert.equal(fake.closeCount, 1);
  });
}

test('closing a worker wins over a queued source exception and retains the cancelled outcome', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  const iterator = worker.events[Symbol.asyncIterator](), pending = iterator.next();
  const closing = worker.close();
  fake.output.end(Object.assign(new Error(`PRIVATE_SDK_EXCEPTION ${key}`), { status: 429 }));
  await closing;
  assert.equal((await pending).done, true); assert.deepEqual(await worker.done, { reason: 'closed', error: null, sessionId: null });
});

test('a slow event consumer cannot make the worker read an unbounded SDK stream', async testContext => {
  const { worker, fake } = workerFixture(testContext);
  await worker.start();
  for (let index = 0; index < 1000; index++) fake.output.push({ type: 'fixture', index });
  await until(() => fake.output.readCount >= 257);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(fake.output.readCount <= 258);
  await worker.close();
  assert.equal((await worker.done).reason, 'closed');
  assert.equal(fake.closeCount, 1);
});

test('pending input writers are cancelled when a query stops reading', async testContext => {
  const { worker, fake } = workerFixture(testContext, {}, { readInput: false });
  await worker.start();
  const sends = Array.from({ length: 80 }, (_, index) => worker.send(`queued ${index}`));
  const outcomes = Promise.allSettled(sends);
  await new Promise(resolve => setImmediate(resolve));
  await worker.close();
  const results = await outcomes;
  assert.ok(results.some(result => result.status === 'rejected'));
  assert.equal(fake.closeCount, 1);
});

const invalid = [
  ['relative executable', { binary: 'claude.exe' }],
  ['relative cwd', { cwd: 'work' }],
  ['relative profile', { configDir: 'profile' }],
  ['relative profile home', { profileDir: 'private-profile' }],
  ['profile control character', { configDir: join(root, 'profile\nprivate') }],
  ['network executable', { binary: '\\\\private-server\\share\\claude.exe' }],
  ['alternate executable stream', { binary: `${join(root, 'claude.exe')}:stream` }],
  ['empty model', { model: '' }],
  ['malformed model', { model: 'claude\nprivate' }],
  ['LAN MCP server', { mcpUrl: 'http://192.168.168.1:43175/mcp' }],
  ['public MCP server', { mcpUrl: 'http://remote.invalid/mcp' }],
  ['HTTPS MCP server', { mcpUrl: 'https://127.0.0.1:43175/mcp' }],
  ['MCP URL credentials', { mcpUrl: 'http://user:private@127.0.0.1/mcp' }],
  ['MCP URL query', { mcpUrl: 'http://127.0.0.1/mcp?key=private' }],
  ['MCP URL fragment', { mcpUrl: 'http://127.0.0.1/mcp#private' }],
  ['weak MCP key', { mcpKey: 'short' }],
  ['header injection', { mcpKey: `${key}\r\nX-Private: yes` }],
  ['zero output cap', { maxTokens: 0 }],
  ['fractional output cap', { maxTokens: 1.5 }],
  ['unsupported effort', { effort: 'ultra' }],
  ['unmapped thinking schema', { thinking: { type: 'enabled', budget_tokens: 1024 } }],
  ['invalid thinking budget', { thinking: { type: 'enabled', budgetTokens: -1 } }],
  ['unsupported thinking', { thinking: { type: 'magic' } }],
  ['disabled thinking extras', { thinking: { type: 'disabled', display: 'omitted' } }],
  ['malformed resume id', { resumeSessionId: 'private-session' }],
  ['invalid query callback', { queryImpl: 'private-value' }],
];

for (const [name, options] of invalid) {
  test(`invalid ${name} fails before SDK import or invocation`, () => {
    assert.throws(() => new ClaudeSdkWorker(configuration(options)), { message: 'Claude SDK worker configuration is invalid.' });
  });
}
