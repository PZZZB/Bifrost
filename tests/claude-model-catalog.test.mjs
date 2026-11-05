import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeMetadataReader, claudeCatalogModels, discoverClaudeModels, discoverClaudeMetadata } from '../src/claude-model-catalog.mjs';
const rows = [{ value: 'default', resolvedModel: 'claude-opus-v', displayName: 'Default' },
  { value: 'opus', resolvedModel: 'claude-opus-v', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['high','invalid'] },
  { value: 'sonnet', displayName: 'Sonnet' }, { value: 'haiku', displayName: 'Haiku' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Long context' }];
test('official selectable models retain exact upstream values, legacy IDs and extended variants without duplicating Default', () => {
  const models = claudeCatalogModels(rows);
  assert.deepEqual(models.map(m => m.id), ['claude-opus','claude-sonnet','claude-haiku','claude-fable-5-1-1m']);
  assert.equal(models.at(-1).upstream, 'claude-fable-5-1[1m]'); assert.equal(models[0].upstream, 'opus');
  assert.deepEqual(models[0].efforts, ['high']);
  assert.equal(models[1].supportsReasoning, undefined);
  assert.deepEqual(claudeCatalogModels([{ value: 'https://foreign.invalid', displayName: 'x' },{value:'bad\n',displayName:'bad'}]), []);
  assert.throws(() => claudeCatalogModels([...rows,{value:'claude-fable-5-1-1m',displayName:'Conflict'}]));
});
test('metadata discovery supplies no prompt, native tools, persistent session or inherited credentials and closes the query', async () => {
  let options, input, closed = false;
  const result = await discoverClaudeModels({binary:'/usr/bin/claude',configDir:'/private/identity/config',profileDir:'/private/identity/profile',stateDir:'/private/identity/state',
    env:{HOME:'/user',ANTHROPIC_API_KEY:'must-not-inherit',HTTPS_PROXY:'http://proxy.invalid'},queryImpl(value){options=value.options;input=value.prompt;
      return {supportedModels:async()=>rows,close(){closed=true;}};}});
  assert.equal(result.length,4);assert.equal(closed,true);assert.deepEqual(await input.next(),{done:true,value:undefined});
  assert.deepEqual(options.tools,[]);assert.deepEqual(options.mcpServers,{});assert.equal(options.persistSession,false);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(options.env.HOME,'/private/identity/profile');assert.equal(options.env.HTTPS_PROXY,'http://proxy.invalid');
});
test('cancelled metadata discovery closes a stalled query without sending inference', async () => {
  let closed=false;
  await assert.rejects(discoverClaudeModels({binary:'/cli',configDir:'/profile/config',profileDir:'/profile/user',stateDir:'/profile/state',timeoutMs:10,
    queryImpl(){return{supportedModels:()=>new Promise(()=>{}),close(){closed=true;}};}}));
  assert.equal(closed,true);
});

test('metadata exposes matched runtime context and an opaque account generation without sending identity or session costs', async () => {
  let selected, closed = false, sent = 0;
  const read = (email = 'private@example.invalid') => discoverClaudeMetadata({ binary: '/cli', configDir: '/config', profileDir: '/profile', stateDir: '/state',
    identitySecret: 'relay-private-identity-secret'.repeat(3), queryImpl({ prompt }) {
      void prompt.next().then(value => { if (!value.done) sent++; });
      return { supportedModels: async () => rows, accountInfo: async () => ({ email, organization: 'PRIVATE_ORG', apiProvider: 'firstParty' }),
        setModel: async model => { selected = model; }, getContextUsage: async () => ({ model: selected === 'opus' ? 'claude-opus-v' : 'different', maxTokens: 1000000,
          memoryFiles: ['PRIVATE_FILES'] }), close() { closed = true; },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('PRIVATE'); } };
    } });
  const result = await read(); assert.equal(closed, true); assert.equal(sent, 0);
  assert.equal(result.models[0].contextWindow, 1000000); assert.equal(result.models[0].contextSource, 'official-cli-runtime');
  assert.equal(result.models[1].contextWindow, undefined); assert.equal(result.subscriptionUsage.status, 'unavailable');
  assert.match(result.authorizationVersion, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private@example/);
  assert.equal((await read()).authorizationVersion, result.authorizationVersion);
  assert.notEqual((await read('different@example.invalid')).authorizationVersion, result.authorizationVersion);
});

test('missing or rejected optional SDK metadata does not erase supported models', async () => {
  const result = await discoverClaudeMetadata({ binary: '/cli', configDir: '/config', profileDir: '/profile', stateDir: '/state', includeUsage: false,
    queryImpl: () => ({ supportedModels: async () => rows, setModel: async () => { throw new Error('Unsupported'); }, getContextUsage: async () => ({}), close() {} }) });
  assert.equal(result.models.length, 4); assert.equal(result.subscriptionUsage, null); assert.equal(result.authorizationVersion, null);
  assert.ok(result.models.every(model => model.contextWindow === undefined));
});

const readerOptions = { binary: '/cli', configDir: '/config', profileDir: '/profile', stateDir: '/state' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('relay metadata reuses one live SDK query across refreshes and coalesces overlapping reads without a prompt', async t => {
  let starts = 0, reads = 0, closes = 0, promptFinished = false, nativeSignal;
  const gate = deferred();
  const reader = new ClaudeMetadataReader({ ...readerOptions, queryImpl({ prompt, options }) {
    starts++; nativeSignal = options.abortController.signal;
    void prompt.next().then(value => { assert.equal(value.done, true); promptFinished = true; });
    return { async supportedModels() { reads++; await gate.promise; return rows; }, close() { closes++; } };
  } });
  t.after(() => reader.close());
  const pending = [reader.read({ includeUsage: false }), reader.read({ includeUsage: false })];
  gate.resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(results[0], results[1]); assert.equal(reads, 1);
  for (let i = 0; i < 5; i++) assert.equal((await reader.read({ includeUsage: false })).models.length, 4);
  assert.equal(reads, 6); assert.equal(starts, 1); assert.equal(closes, 0);
  assert.equal(promptFinished, false); assert.equal(nativeSignal.aborted, false);
  await Promise.all([reader.close(), reader.close()]);
  assert.equal(closes, 1); assert.equal(nativeSignal.aborted, true); assert.equal(promptFinished, true);
  await assert.rejects(reader.read(), /closed/);
});

test('a metadata timeout neither kills a renewing CLI nor starts another query, and a late result recovers on the same process', async t => {
  let starts = 0, reads = 0, closes = 0, nativeSignal;
  const gate = deferred();
  const reader = new ClaudeMetadataReader({ ...readerOptions, timeoutMs: 25, queryImpl({ options }) {
    starts++; nativeSignal = options.abortController.signal;
    return { async supportedModels() { reads++; return gate.promise; }, close() { closes++; } };
  } });
  t.after(() => reader.close());
  await assert.rejects(reader.read({ includeUsage: false }), /timed out/);
  await assert.rejects(reader.read({ includeUsage: false }), /timed out/);
  assert.equal(starts, 1); assert.equal(reads, 1); assert.equal(closes, 0); assert.equal(nativeSignal.aborted, false);
  gate.resolve(rows); await new Promise(done => setImmediate(done));
  assert.equal((await reader.read({ includeUsage: false })).models.length, 4);
  assert.equal(starts, 1); assert.equal(closes, 0);
});

test('metadata shutdown cancels pending callers and closes its native query only once', async () => {
  const signal = new AbortController(); let closes = 0;
  const started = deferred();
  const reader = new ClaudeMetadataReader({ ...readerOptions, signal: signal.signal, queryImpl: () => ({
    supportedModels: () => { started.resolve(); return new Promise(() => {}); }, close() { closes++; },
  }) });
  const pending = reader.read(); const rejected = assert.rejects(pending, /cancelled/);
  await started.promise; signal.abort(); await reader.close(); await rejected;
  assert.equal(closes, 1);
  const before = new AbortController(); before.abort();
  const never = new ClaudeMetadataReader({ ...readerOptions, signal: before.signal,
    queryImpl() { throw new Error('A cancelled reader must not start the CLI.'); } });
  await assert.rejects(never.read(), /closed/); await never.close();
});

test('a confirmed native SDK exit allows a new metadata process without retrying inference', async t => {
  const exit = deferred(); let starts = 0, reads = 0;
  const reader = new ClaudeMetadataReader({ ...readerOptions, queryImpl() {
    const generation = ++starts;
    return { supportedModels: async () => { reads++; return rows; }, close() { exit.resolve(); },
      async *[Symbol.asyncIterator]() { if (generation === 1) await exit.promise; else await new Promise(() => {}); } };
  } });
  t.after(() => reader.close());
  assert.equal((await reader.read({ includeUsage: false })).models.length, 4);
  exit.resolve(); await new Promise(done => setImmediate(done));
  assert.equal((await reader.read({ includeUsage: false })).models.length, 4);
  assert.equal(starts, 2); assert.equal(reads, 2);
});
