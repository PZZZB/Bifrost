import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexNativeEntry } from '../src/codex-native-entry.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { Gateway } from '../src/gateway.mjs';
import { redact } from '../src/storage.mjs';

const key = 'native-fixture-gateway-key-000000000000000000000';
const aCredential = 'native-fixture-caller-a';
const bCredential = { value: 'native-fixture-caller-b', accountId: 'workspace-b' };
const terminal = 'data: {"type":"response.completed","response":{"id":"resp-offline","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}\n\n';
const headers = { authorization: `Bearer ${aCredential}`, 'chatgpt-account-id': 'workspace-a', 'content-type': 'application/json' };

async function fixture(t, extra = {}) {
  const calls = [], credentials = [];
  const entry = createCodexNativeEntry({ baseUrl: 'http://127.0.0.1:0/backend-api/codex', gatewayKey: key });
  const gateway = new Gateway({ gatewayKey: key,
    backend: { credentials: async (...args) => { credentials.push(args); return bCredential; } },
    getAProvider: async ({ native }) => ({ config: { base_url: `https://${native ? 'native-a' : 'custom-a'}.example.invalid/codex` } }),
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url.includes('/models')) return Response.json({ models: [
        { slug: 'gpt-6.1-sol', display_name: 'Original Sol', base_instructions: 'keep upstream instructions', priority: 0 },
        { slug: 'gpt-6-astra', display_name: 'Original Astra', priority: 1 },
      ] });
      return new Response(terminal, { headers: { 'content-type': 'text/event-stream' } });
    }, ...extra });
  const server = createBridgeServer({ gateway, codexNativeEntry: entry, state: { gatewayKey: key },
    integration: { inspect: async () => ({ installed: true }) }, baseUrl: 'http://127.0.0.1:0/backend-api/codex',
    publicDir: fileURLToPath(new URL('../public', import.meta.url)) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = new URL(entry.baseUrl); url.port = String(server.address().port);
  return { entry, server, gateway, origin, url: url.href, calls, credentials };
}

test('old built-in threads get the A/B catalog and keep separate upstream credentials when switching models', async t => {
  const f = await fixture(t);
  const catalog = await fetch(f.url + '/models?client_version=0.166.0', { headers });
  assert.equal(catalog.status, 200);
  const models = (await catalog.json()).models;
  assert.deepEqual(models.map(m => m.slug), ['gpt-6.1-sol', 'gpt-6-astra', 'B-gpt-6.1-sol', 'B-gpt-6-astra']);
  assert.equal(models[0].base_instructions, 'keep upstream instructions');
  assert.equal(f.calls[0].url, 'https://native-a.example.invalid/codex/models?client_version=0.166.0');
  assert.equal(f.calls[0].headers.get('authorization'), `Bearer ${aCredential}`);
  f.calls.length = 0; const beforeB = f.credentials.length;
  const original = '{ "model": "gpt-6.1-sol", "input": "local fake only", "tools": [{"type":"function","name":"read_file","parameters":{"type":"object"}}], "stream": true }';
  const a = await fetch(f.url + '/responses', { method: 'POST', headers, body: original });
  assert.equal(await a.text(), terminal);
  assert.equal(f.credentials.length, beforeB);
  assert.equal(f.calls[0].url, 'https://native-a.example.invalid/codex/responses');
  assert.equal(f.calls[0].body.toString(), original);
  assert.equal(f.calls[0].headers.get('authorization'), `Bearer ${aCredential}`);
  assert.equal(f.calls[0].headers.get('chatgpt-account-id'), 'workspace-a');
  assert.equal(f.calls[0].headers.has('x-account-bridge-key'), false);
  const requested = { ...JSON.parse(original), model: 'B-gpt-6.1-sol' };
  const b = await fetch(f.url + '/responses', { method: 'POST', headers, body: JSON.stringify(requested) });
  assert.equal(await b.text(), terminal);
  assert.equal(f.calls[1].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(JSON.parse(f.calls[1].body), { ...requested, model: 'gpt-6.1-sol' });
  assert.equal(f.calls[1].headers.get('authorization'), `Bearer ${bCredential.value}`);
  assert.equal(f.calls[1].headers.get('chatgpt-account-id'), bCredential.accountId);
  assert.equal(f.calls[1].headers.has('x-account-bridge-key'), false);
  assert.equal(f.gateway.metrics.accounts.A.completed, 1);
  assert.equal(f.gateway.metrics.accounts.B.completed, 1);
});

test('custom threads retain their own original A route and cannot select the built-in route by forging a header', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/backend-api/codex/responses', { method: 'POST',
    headers: { ...headers, 'x-account-bridge-key': key, 'x-bifrost-native': 'true' },
    body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'local fake only' }) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls[0].url, 'https://custom-a.example.invalid/codex/responses');
});

test('the native URL capability does not replace caller authorization or the existing gateway key', async t => {
  const f = await fixture(t), token = new URL(f.url).pathname.split('/')[3];
  for (const authorization of [undefined, `Bearer ${key}`, `Bearer ${token}`, 'Bearer ', 'Basic abc']) {
    const response = await fetch(f.url + '/responses', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      body: '{"model":"B-gpt-6.1-sol"}' });
    assert.equal(response.status, 401); await response.text();
  }
  const standard = await fetch(f.origin + '/backend-api/codex/responses', { method: 'POST', headers,
    body: '{"model":"B-gpt-6.1-sol"}' });
  assert.equal(standard.status, 401); await standard.text();
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('the private URL cannot authorize another path, account API, browser origin, or disabled source', async t => {
  const f = await fixture(t);
  for (const suffix of ['/api/status', '/models/extra', '/responses%2fcompact']) {
    const response = await fetch(f.url + suffix, { headers }); assert.equal(response.status, 404); await response.text();
  }
  const badToken = f.url.replace(/bfn_[A-Za-z0-9_-]+/, 'bfn_untrusted');
  assert.equal((await fetch(badToken + '/models', { headers })).status, 401);
  for (const extra of [{ origin: 'https://attacker.example.invalid' }, { origin: f.origin }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await fetch(f.url + '/models', { headers: { ...headers, ...extra } });
    assert.equal(response.status, 403); await response.text();
  }
  assert.equal(f.calls.length, 0);
  f.gateway.sourceEnabled = account => account !== 'B';
  const disabled = await fetch(f.url + '/responses', { method: 'POST', headers, body: '{"model":"B-gpt-6.1-sol"}' });
  assert.equal(disabled.status, 503); await disabled.text();
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
});

test('native entry rejects non-loopback peers and duplicate authorization before injecting any bridge key', () => {
  const entry = createCodexNativeEntry({ baseUrl: 'http://127.0.0.1:43155/backend-api/codex', gatewayKey: key });
  for (const [peer, extra, expected] of [['192.168.168.10', {}, 'native_codex_loopback_required'],
    ['127.0.0.1', { host: 'evil.example.invalid' }, 'native_codex_host_rejected']]) {
    const req = { socket: { remoteAddress: peer }, headers: { ...headers, host: '127.0.0.1:43155', ...extra } };
    assert.throws(() => entry.authorize(req, new URL(entry.baseUrl + '/models')), { code: expected });
    assert.equal(req.headers['x-account-bridge-key'], undefined);
  }
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { ...headers, host: '127.0.0.1:43155' },
    rawHeaders: ['Authorization', `Bearer ${aCredential}`, 'authorization', 'Bearer other'] };
  assert.throws(() => entry.authorize(req, new URL(entry.baseUrl + '/models')), { code: 'native_codex_duplicate_authorization' });
});

test('native WebSocket attempts receive an explicit HTTP fallback without dispatching inference', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const request = http.request(f.url + '/responses', { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'MDEyMzQ1Njc4OWFiY2RlZg==', 'sec-websocket-version': '13' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(result, 426); assert.equal(f.calls.length, 0);
});

test('private native URLs are domain separated, non-enumerable and redacted from errors and public status', async t => {
  const f = await fixture(t), token = new URL(f.url).pathname.split('/')[3];
  assert.ok(token.startsWith('bfn_')); assert.equal(token.includes(key), false);
  assert.equal(JSON.stringify(f.entry), '{}');
  assert.equal(redact(`request failed: ${f.url}/responses` ).includes(token), false);
  const changed = createCodexNativeEntry({ baseUrl: 'http://127.0.0.1:43155/backend-api/codex', gatewayKey: key + '-rotated' });
  assert.equal(changed.baseUrl.includes(token), false);
  const page = await fetch(f.origin + '/');
  const cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const status = await (await fetch(f.origin + '/api/status', { headers: { cookie } })).text();
  assert.equal(status.includes(token), false); assert.equal(status.includes(key), false);
});
