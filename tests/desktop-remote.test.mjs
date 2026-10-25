import test from 'node:test';
import assert from 'node:assert/strict';
import { BifrostRemote, validateBifrostUrl } from '../src/providers/bifrost-remote.mjs';

const apiKey = `bfk_${'t'.repeat(43)}`, baseUrl = 'https://mac.test:47846/v1';
test('remote targets require configured HTTPS user API paths and a personal user Key', () => {
  for (const url of ['http://mac.test/v1', 'https://user:pass@mac.test/v1', 'https://mac.test/admin', 'https://mac.test/v1?target=a', 'https://mac.test/v1#fragment']) assert.throws(() => validateBifrostUrl(url));
  assert.equal(validateBifrostUrl(`${baseUrl}/`), baseUrl);
  assert.throws(() => new BifrostRemote({ baseUrl, apiKey: 'legacy-shared-admin-key' }));
});
test('catalog validation fails closed and inference redirects are never followed or replayed', async t => {
  const calls = []; let duplicate = false;
  const remote = new BifrostRemote({ baseUrl, apiKey, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'Claude-sonnet' }, ...(duplicate ? [{ id: 'Claude-sonnet' }] : [])] });
    return new Response(null, { status: 307, headers: { location: 'https://other-host.test/collect' } });
  } });
  t.after(() => remote.close()); await remote.refreshCatalog();
  await assert.rejects(remote.request('messages', { body: { model: 'Claude-sonnet' }, scope: 'scope' }), error => error.code === 'desktop_remote_redirect');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(calls.every(call => call.options.redirect === 'manual' && call.url.startsWith('https://mac.test:47846/v1/')));
  duplicate = true; await remote.refreshCatalog(); assert.deepEqual(remote.catalogSnapshot(), []);
  assert.equal(remote.status().available, false);
});
test('caller cancellation reaches the only inference request and another personal Key changes the authorization generation', async t => {
  let captured;
  const remote = new BifrostRemote({ baseUrl, apiKey, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'Claude-sonnet' }] });
    captured = options.signal;
    return new Promise((_resolve, reject) => captured.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  t.after(() => remote.close()); await remote.refreshCatalog();
  const abort = new AbortController();
  const pending = remote.request('messages', { body: { model: 'Claude-sonnet' }, scope: 'scope', signal: abort.signal });
  abort.abort(); await assert.rejects(pending, error => error.status === 499); assert.equal(captured.aborted, true);
  const other = new BifrostRemote({ baseUrl, apiKey: `bfk_${'u'.repeat(43)}` }); t.after(() => other.close());
  assert.notEqual(remote.generation, other.generation);
});
