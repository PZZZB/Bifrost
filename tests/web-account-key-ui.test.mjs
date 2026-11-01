import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/accounts/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/accounts/index.html', import.meta.url), 'utf8');
const KEY = 'bfk_' + 'k'.repeat(43), BASE = 'https://gateway.example.test/v1';
const account = { id: 'owner', username: 'owner@example.test', apiKeyConfigured: true,
  apiKeyRevealSupported: true, apiKeyRecoverable: true, limits: { maxConcurrent: 2, requestsPerMinute: 60 } };
const response = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
const tick = () => new Promise(done => setImmediate(done));

async function page({ reveal = async () => response({ account, apiKey: KEY, apiBaseUrl: BASE }), clipboard = true, fallback = true } = {}) {
  const nodes = new Map(), events = new Map(), windowEvents = new Map(), calls = [], copies = [];
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attributes = new Map(), listeners = new Map();
    for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) attributes.set(attribute[1], attribute[2]);
    const node = { tag: match[1], type: attributes.get('type') ?? '', value: '', textContent: '', hidden: /\bhidden\b/.test(match[2]), disabled: false,
      addEventListener: (event, action) => listeners.set(event, action), setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: name => attributes.get(name), focus() {}, select() {}, setSelectionRange() {}, reportValidity: () => true,
      fire: event => listeners.get(event)?.({ preventDefault() {} }) };
    nodes.set(match[3], node);
  }
  const document = { hidden: false, getElementById: id => { assert.ok(nodes.has(id), `Unknown element ${id}`); return nodes.get(id); },
    querySelectorAll: () => [...nodes.values()].filter(node => node.tag === 'button'),
    addEventListener: (name, action) => events.set(name, action), execCommand: () => fallback };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/session')) return response({ account, apiBaseUrl: BASE, csrfToken: 'csrf-test' });
    if (url.endsWith('/api-key/reveal')) return reveal();
    throw new Error('Unexpected endpoint: ' + url);
  };
  runInNewContext(source, { document, window: { addEventListener: (name, action) => windowEvents.set(name, action) },
    location: { hash: '', pathname: '/account/', search: '' }, history: { replaceState() {} }, URLSearchParams, fetch,
    navigator: { ...(clipboard ? { clipboard: { writeText: async value => { copies.push(value); } } } : {}) },
    confirm: () => { throw new Error('Key viewing must never request rotation'); } });
  const settled = async () => { for (let n = 0; n < 100; n++) { await tick(); if (!nodes.get('view-key').disabled) return; } throw new Error('UI remained busy'); };
  await settled();
  return { nodes, calls, copies, settled, click: async id => { nodes.get(id).fire('click'); await settled(); },
    start: id => nodes.get(id).fire('click'),
    background: () => { document.hidden = true; events.get('visibilitychange')(); },
    foreground: () => { document.hidden = false; }, leave: () => windowEvents.get('pagehide')() };
}

test('refresh starts masked; viewing, hiding and copying retrieve the same key without rotation', async () => {
  const p = await page();
  assert.equal(p.nodes.get('api-key').value, ''); assert.equal(p.nodes.get('key-reveal').hidden, false);
  assert.equal(p.calls.length, 1);
  await p.click('view-key'); assert.equal(p.nodes.get('error').textContent, ''); assert.equal(p.nodes.get('api-key').value, KEY); assert.equal(p.nodes.get('api-key').type, 'text');
  assert.equal(p.nodes.get('base-url').value, BASE);
  await p.click('view-key'); assert.equal(p.nodes.get('api-key').value, ''); assert.equal(p.nodes.get('api-key').type, 'password');
  await p.click('copy-key'); assert.deepEqual(p.copies, [KEY]); assert.equal(p.nodes.get('api-key').type, 'password');
  assert.equal(p.calls.filter(call => call.url.endsWith('/api-key/reveal')).length, 2);
  for (const call of p.calls.slice(1)) {
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.headers['x-bifrost-csrf'], 'csrf-test');
    assert.equal(call.options.cache, 'no-store');
  }
  p.leave(); assert.equal(p.nodes.get('api-key').value, '');
  const refreshed = await page(); await refreshed.click('view-key'); assert.equal(refreshed.nodes.get('api-key').value, KEY);
});

test('a delayed reveal cannot put a key back into a background page', async () => {
  let finish;
  const p = await page({ reveal: () => new Promise(done => { finish = done; }) });
  p.start('view-key'); await tick(); p.background(); p.foreground();
  finish(response({ account, apiKey: KEY, apiBaseUrl: BASE })); await p.settled();
  assert.equal(p.nodes.get('api-key').value, ''); assert.equal(p.nodes.get('api-key').type, 'password');
});

test('expired sessions clear the account and never reveal a key', async () => {
  const p = await page({ reveal: async () => response({ error: { code: 'session_expired', message: '请重新登录。' } }, 401) });
  await p.click('view-key'); assert.equal(p.nodes.get('api-key').value, '');
  assert.equal(p.nodes.get('account-view').hidden, true); assert.equal(p.nodes.get('auth-view').hidden, false);
  assert.match(p.nodes.get('error').textContent, /重新登录/);
});

test('copy fallback restores masking and an invalid owner response is never displayed', async () => {
  const p = await page({ clipboard: false }); await p.click('copy-key'); assert.equal(p.nodes.get('error').textContent, '');
  assert.equal(p.nodes.get('api-key').type, 'password'); assert.equal(p.nodes.get('status').textContent, '已复制。');
  p.background(); assert.equal(p.nodes.get('api-key').value, '');
  const bad = await page({ reveal: async () => response({ account: { ...account, id: 'someone-else' }, apiKey: KEY }) });
  await bad.click('view-key'); assert.equal(bad.nodes.get('api-key').value, ''); assert.match(bad.nodes.get('error').textContent, /响应异常/);
});
