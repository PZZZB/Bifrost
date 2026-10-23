import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { createMagpieDelegationServer, loadMagpieDelegation, MAGPIE_DELEGATION_BASE_URL } from '../src/magpie-delegation.mjs';

const key = 'delegation-test-key-000000000000000000000000000';
const aHeaders = { 'X-Account-Bridge-Key': key, Authorization: 'Bearer account-a-fixture-only',
  'ChatGPT-Account-ID': 'fixture-account-a', 'Content-Type': 'application/json' };
const completed = 'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handle, options = {}) {
  const targets = [];
  const upstream = http.createServer(handle);
  const upstreamUrl = await listen(upstream);
  const server = createMagpieDelegationServer({ gatewayKey: key, baseUrl: 'http://127.0.0.1:0',
    requestImpl(target, requestOptions, callback) {
      targets.push(target);
      const address = new URL(target);
      return http.request(`${upstreamUrl}${address.pathname}${address.search}`, requestOptions, callback);
    }, ...options });
  const url = await listen(server);
  t.after(() => { for (const item of [server, upstream]) { item.closeAllConnections(); item.close(); } });
  return { url, targets };
}

async function collect(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks);
}

function rawRequest(address, { headers, method = 'POST', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(address, { method, headers }, async response => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: await collect(response) }); }
      catch (error) { reject(error); }
    });
    request.on('error', reject); request.end(body);
  });
}

test('delegation marker is absent by default and accepts only the fixed local URL and exact version', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-marker-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'magpie-delegation.json');
  assert.equal(await loadMagpieDelegation(path), null);
  const marker = { version: 1, baseUrl: MAGPIE_DELEGATION_BASE_URL };
  await writeFile(path, JSON.stringify(marker)); assert.deepEqual(await loadMagpieDelegation(path), marker);
  for (const bad of [{ ...marker, version: 2 }, { ...marker, baseUrl: 'https://external.invalid' },
    { ...marker, baseUrl: `${marker.baseUrl}?key=private` }, { ...marker, enabled: true }, null, 'private-value']) {
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(loadMagpieDelegation(path), error => error.status === 503 && !error.message.includes('private'));
  }
});

test('both cached B aliases map exactly to groups and carry no A or bridge credentials', async t => {
  const received = [];
  const { url, targets } = await fixture(t, async (req, res) => {
    received.push({ url: req.url, headers: req.headers, body: JSON.parse((await collect(req)).toString()) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-ID': 'fixture-request' });
    res.write(completed.slice(0, 9)); setImmediate(() => res.end(completed.slice(9)));
  });
  for (const [old, group] of [['B-gpt-6-astra', 'group/b-gpt-6-astra'], ['B-gpt-6.1-sol', 'group/b-gpt-6.1-sol']]) {
    const original = { model: old, stream: true, tools: [{ type: 'function', name: 'local_tool' }],
      input: [{ type: 'function_call_output', call_id: 'fixture-call', output: '当前电脑工具结果' }] };
    const response = await fetch(`${url}/backend-api/codex/responses?fixture=1`, { method: 'POST',
      headers: { ...aHeaders, Cookie: 'bridge_session=private-cookie; account_cookie=also-private',
        'X-Bridge-CSRF': 'private-csrf', 'X-Oai-Attestation': 'a-bound-fixture' },
      body: JSON.stringify(original) });
    assert.equal(response.status, 200); assert.equal(await response.text(), completed);
    const last = received.at(-1);
    assert.deepEqual(last.body, { ...original, model: group });
    for (const name of ['authorization', 'chatgpt-account-id', 'cookie', 'x-account-bridge-key', 'x-bridge-csrf', 'x-oai-attestation']) assert.equal(last.headers[name], undefined);
    assert.equal(targets.at(-1), `${MAGPIE_DELEGATION_BASE_URL}/responses?fixture=1`);
  }
});

test('B model replacement preserves large integers and every JSON number spelling', async t => {
  let received;
  const { url } = await fixture(t, async (req, res) => { received = (await collect(req)).toString(); res.end(completed); });
  const numbers = ['9007199254740993', '-0', '1e400', '1.23000000000000000001', '1.00e-005'];
  const body = `{"model":"B-gpt-6.1-sol","input":{"numbers":[${numbers.join(',')}]}}`;
  const response = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers: aHeaders, body });
  assert.equal(response.status, 200); await response.text();
  assert.equal(received, body.replace('B-gpt-6.1-sol', 'group/b-gpt-6.1-sol'));
});

test('the two exact group IDs strip A credentials without changing an already encoded request', async t => {
  const received = [];
  const { url } = await fixture(t, async (req, res) => { received.push({ headers: req.headers, body: await collect(req) }); res.end(completed); });
  for (const model of ['group/b-gpt-6-astra', 'group/b-gpt-6.1-sol']) {
    const body = zlib.gzipSync(Buffer.from(`{ "model" : "${model}", "input" : "fixture" }`));
    const response = await rawRequest(`${url}/backend-api/codex/responses`, { body, headers: {
      ...aHeaders, 'Content-Encoding': 'gzip', 'Content-Length': body.length,
      Cookie: 'a-cookie=private-fixture', 'X-Oai-Attestation': 'a-bound-fixture' } });
    assert.equal(response.status, 200);
    const last = received.at(-1);
    assert.deepEqual(last.body, body); assert.equal(last.headers['content-encoding'], 'gzip');
    assert.equal(Number(last.headers['content-length']), body.length);
    for (const name of ['authorization', 'chatgpt-account-id', 'cookie', 'x-oai-attestation', 'x-account-bridge-key']) assert.equal(last.headers[name], undefined);
  }
});

test('A gzip bytes, identity body, authorization and encoded upstream response remain unchanged', async t => {
  const plain = Buffer.from(' { "model" : "gpt-6.1-sol", "input" : "中文", "number": 9007199254740993 }\n');
  const reply = zlib.gzipSync(Buffer.from(completed));
  const received = [];
  const { url } = await fixture(t, async (req, res) => {
    received.push({ headers: req.headers, body: await collect(req) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Content-Length': reply.length });
    res.end(reply);
  });
  for (const encoding of ['identity', 'gzip']) {
    const body = encoding === 'gzip' ? zlib.gzipSync(plain) : plain;
    const response = await rawRequest(`${url}/backend-api/codex/responses`, { body,
      headers: { ...aHeaders, 'Content-Encoding': encoding, 'Content-Length': body.length,
        Cookie: 'bridge_session=private-management; account_cookie=keep' } });
    assert.equal(response.status, 200); assert.deepEqual(response.body, reply);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.equal(Number(response.headers['content-length']), reply.length);
    const last = received.at(-1);
    assert.deepEqual(last.body, body); assert.equal(last.headers['content-encoding'], encoding);
    assert.equal(last.headers.authorization, aHeaders.Authorization);
    assert.equal(last.headers['chatgpt-account-id'], 'fixture-account-a');
    assert.equal(last.headers.cookie.trim(), 'account_cookie=keep');
    assert.equal(last.headers['x-account-bridge-key'], undefined);
  }
});

test('B gzip and zstd requests are decompressed and changed once before delegation', async t => {
  const received = [];
  const { url } = await fixture(t, async (req, res) => { received.push({ headers: req.headers, body: await collect(req) }); res.end(completed); });
  const original = { model: 'B-gpt-6.1-sol', stream: true, input: [{ role: 'user', content: 'keep fixture' }] };
  const encodings = [['gzip', zlib.gzipSync]];
  if (zlib.zstdCompressSync) encodings.push(['zstd', zlib.zstdCompressSync]);
  for (const [encoding, compress] of encodings) {
    const body = compress(Buffer.from(JSON.stringify(original)));
    const response = await rawRequest(`${url}/backend-api/codex/responses`, { headers: { ...aHeaders,
      'Content-Encoding': encoding, 'Content-Length': body.length }, body });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(received.at(-1).body.toString()), { ...original, model: 'group/b-gpt-6.1-sol' });
    assert.equal(received.at(-1).headers['content-encoding'], undefined);
    assert.equal(Number(received.at(-1).headers['content-length']), received.at(-1).body.length);
  }
});

test('missing or wrong independent key, unknown B alias and invalid Host never reach Magpie', async t => {
  const { url, targets } = await fixture(t, (_req, res) => res.end('must not happen'));
  for (const headers of [{ Authorization: aHeaders.Authorization },
    { ...aHeaders, 'X-Account-Bridge-Key': 'wrong-key' }, { Authorization: `Bearer ${key}` }]) {
    assert.equal((await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol"}' })).status, 401);
  }
  const unknown = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers: aHeaders, body: '{"model":"b-unknown"}' });
  assert.equal(unknown.status, 400); assert.equal((await unknown.json()).error.code, 'unknown_b_model');
  const badHost = await rawRequest(`${url}/backend-api/codex/responses`, { headers: { ...aHeaders, Host: 'rebind.invalid' }, body: '{"model":"gpt-6.1-sol"}' });
  assert.equal(badHost.status, 403); assert.equal(targets.length, 0);
});

test('all Codex backend paths and queries pass through while old management is 410', async t => {
  const received = [];
  const { url } = await fixture(t, async (req, res) => { received.push({ path: req.url, body: await collect(req) }); res.writeHead(418); res.end('upstream status'); });
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.delegation, 'magpie');
  assert.equal((await fetch(`${url}/api/status`)).status, 410);
  assert.equal((await fetch(`${url}/api/logout`, { method: 'POST' })).status, 410);
  assert.equal((await fetch(`${url}/`)).status, 410);
  for (const path of ['/backend-api/codex/models?client_version=fixture', '/backend-api/codex/new-metadata/path?x=1', '/v1/models']) {
    const response = await fetch(`${url}${path}`, { headers: aHeaders });
    assert.equal(response.status, 418); assert.equal(await response.text(), 'upstream status');
  }
  assert.deepEqual(received.map(item => item.path), ['/backend-api/codex/models?client_version=fixture',
    '/backend-api/codex/new-metadata/path?x=1', '/backend-api/codex/models']);
});

test('upstream disconnect fails before or during SSE and is never retried or rerouted', async t => {
  let calls = 0;
  const { url, targets } = await fixture(t, (req, res) => {
    calls++;
    if (calls === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"partial"}\n\n');
    setImmediate(() => res.destroy());
  });
  const options = { method: 'POST', headers: aHeaders, body: '{"model":"B-gpt-6.1-sol"}' };
  const first = await fetch(`${url}/backend-api/codex/responses`, options);
  assert.equal(first.status, 502); assert.match((await first.json()).error.message, /Magpie 委托请求失败/);
  await assert.rejects(async () => { const next = await fetch(`${url}/backend-api/codex/responses`, options); await next.text(); });
  assert.equal(calls, 2); assert.equal(targets.length, 2);
});

test('downstream cancellation aborts Magpie and concurrent calls are bounded', async t => {
  let started; const startedPromise = new Promise(resolve => { started = resolve; });
  let closed; const closedPromise = new Promise(resolve => { closed = resolve; });
  const { url, targets } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"fixture":1}\n\n');
    res.on('close', closed); started();
  }, { maxConcurrent: 1 });
  const abort = new AbortController();
  const first = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers: aHeaders,
    body: '{"model":"gpt-6.1-sol"}', signal: abort.signal });
  await startedPromise;
  const limited = await fetch(`${url}/backend-api/codex/responses`, { method: 'POST', headers: aHeaders, body: '{"model":"gpt-6.1-sol"}' });
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
  abort.abort(); await assert.rejects(first.text());
  await Promise.race([closedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 2000).unref())]);
  assert.equal(targets.length, 1);
});

test('delegated main starts with an unusable Codex binary and never creates A/B homes or reads their auth', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'magpie-main-'));
  let child = null, exited = Promise.resolve();
  t.after(async () => {
    const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
    const waitForExit = async () => {
      let timer;
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('fixture main did not exit during cleanup')), 2000);
        })]);
      } finally { clearTimeout(timer); }
    };
    if (running()) {
      child.kill('SIGTERM');
      try { await waitForExit(); }
      catch {
        if (running()) child.kill('SIGKILL');
        await waitForExit();
      }
    }
    // Stop all background metadata writes before removing this test's directory.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const aHome = join(dir, 'account-a-must-not-exist');
  const marker = { version: 1, baseUrl: MAGPIE_DELEGATION_BASE_URL };
  await writeFile(join(dir, 'magpie-delegation.json'), JSON.stringify(marker));
  const originalState = JSON.stringify({ gatewayKey: key, enabled: true, pinnedAccount: { accountId: 'fixture-only' } });
  await writeFile(join(dir, 'bridge.json'), originalState);
  const reservation = http.createServer(); await listen(reservation);
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    env: { ...process.env, BRIDGE_STATE_DIR: dir, BRIDGE_PORT: String(port), BRIDGE_CLIENT_CODEX_HOME: aHome,
      CODEX_BINARY: join(dir, 'must-never-launch-codex.exe') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  exited = new Promise(resolve => {
    child.once('exit', resolve); child.once('error', resolve);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) resolve();
  });
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture main did not listen')), 10_000);
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('Codex delegation: Magpie')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture main exited ${code}: ${errors}`)); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('fixture main could not spawn')); });
  });
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.delegation, 'magpie');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 410);
  await assert.rejects(stat(aHome), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, 'accounts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(dir, 'bridge.json'), 'utf8'), originalState);
  assert.equal(output.includes('Account B storage'), false);
});
