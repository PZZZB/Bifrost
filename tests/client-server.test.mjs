import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClientAccess } from '../src/client-access.mjs';
import { createClientServer } from '../src/client-server.mjs';

const DAY = 86_400_000;
const PASSWORD = 'Offline portal password 123';
const CB = 'claude-codebuddy-opus-5-5', CURSOR = 'Cursor-gemini-4-argon', B = 'B-gpt-6.1-sol';
const HOST = 'client.test:43159', ORIGIN = `http://${HOST}`;
const textItem = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const responseObject = (model, output = [textItem('offline reply')]) => ({ id: 'resp_offline', object: 'response', status: 'completed', model,
  output, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
function responseSse(model, output, deltas = []) {
  const events = [{ type: 'response.created', response: { status: 'in_progress' } }, ...deltas,
    { type: 'response.completed', response: responseObject(model, output) }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } });
}
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { host: HOST, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, incoming => {
      const chunks = [];
      incoming.on('data', bytes => chunks.push(bytes)); incoming.on('error', reject);
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: incoming.statusCode, headers: incoming.headers, text, data });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bifrost-client-server-'));
  let at = Date.parse('2026-10-23T12:00:00.000Z');
  const models = options.models ?? [
    { id: CB, name: 'CodeBuddy Opus 5.5', channel: 'CodeBuddy', enabled: true, available: true },
    { id: CURSOR, name: 'Cursor Gemini', channel: 'Cursor', enabled: true, available: true },
    { id: B, name: 'B GPT', channel: 'B', enabled: true, available: true },
  ];
  const access = await ClientAccess.open({ path: join(directory, 'clients.json'), now: () => at,
    allowedModelIds: () => models.map(model => model.id) });
  const calls = [], messageCalls = [];
  const server = createClientServer({ access, publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    publicBaseUrl: ORIGIN, allowedHosts: [], getModels: () => models, csrfSecret: 'offline-csrf-secret-'.repeat(4), now: () => at,
    requestResponses: async value => { calls.push(value); return options.responses ? options.responses(value, calls) : Response.json(responseObject(value.body.model)); },
    requestMessages: async value => { messageCalls.push(value); return Response.json({ type: 'message', content: [{ type: 'text', text: 'offline messages' }] }); },
    ...options.server });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await access.close(); await rm(directory, { recursive: true, force: true });
  });
  const send = (path, options) => request(server.address().port, path, options);
  const register = async (username, extra = {}) => {
    const result = await send('/portal/api/register', { method: 'POST', body: { username, password: PASSWORD, ...extra }, headers: { origin: ORIGIN } });
    assert.equal(result.status, 201, result.text);
    return { ...result.data, cookie: result.headers['set-cookie'][0].split(';')[0] };
  };
  const account = async (username = 'assigned-user', allowedModels = [CB]) => {
    const user = await access.createAccount({ username, password: PASSWORD, allowedModels });
    const key = await access.createKey(user.id);
    const login = await send('/portal/api/login', { method: 'POST', body: { username, password: PASSWORD } });
    assert.equal(login.status, 200, login.text);
    return { user, ...key, ...login.data, cookie: login.headers['set-cookie'][0].split(';')[0] };
  };
  return { directory, access, server, send, register, account, calls, messageCalls, models, advance(milliseconds) { at += milliseconds; } };
}
const cookieHeaders = session => ({ cookie: session.cookie, 'x-csrf-token': session.csrfToken, origin: ORIGIN });
const keyHeaders = session => ({ authorization: `Bearer ${session.secret}` });
const sessionHeaders = session => ({ authorization: `Bearer ${session.sessionToken}` });

test('public portal and config are read-only, while the local administrator API is absent', async t => {
  const f = await fixture(t);
  const config = await f.send('/portal/api/config'); assert.equal(config.status, 200);
  assert.deepEqual(config.data.registration, { enabled: true, invitationRequired: false, mode: 'open' });
  assert.equal(config.data.gateway.chatCompletionsUrl, `${ORIGIN}/v1/chat/completions`);
  assert.equal((await f.send('/')).status, 302);
  for (const path of ['/portal', '/portal/', '/register', '/login']) {
    const page = await f.send(path); assert.equal(page.status, 200); assert.match(page.text, /Bifröst/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  for (const path of ['/api/status', '/api/client-access', '/api/service/restart', '/api/codebuddy']) {
    const response = await f.send(path); assert.equal(response.status, 404); assert.equal(response.data.error.code, 'client_route_not_found');
  }
  assert.equal((await f.send('/portal/api/me')).status, 401);
  assert.equal((await f.send('/v1/models')).status, 401);
  assert.equal(f.access.snapshot().accounts.length, 0); assert.equal(f.calls.length, 0);
});

test('registration returns the first key once, sets a scoped HttpOnly cookie, and does not grant models implicitly', async t => {
  const f = await fixture(t), created = await f.register('Portal.User');
  assert.equal(created.user.username, 'portal.user'); assert.deepEqual(created.user.allowedModels, []);
  assert.match(created.secret, /^bfk_[A-Za-z0-9_-]{43}$/); assert.match(created.sessionToken, /^bfs_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.lastFour, created.secret.slice(-4)); assert.equal(created.key.status, 'active');
  assert.equal(created.key.expiresAt, created.user.keyExpiresAtLimit);
  const session = await f.send('/portal/api/session', { headers: { cookie: created.cookie } });
  assert.equal(session.status, 200); assert.equal(session.data.csrfToken, created.csrfToken);
  const info = await f.send('/portal/api/me', { headers: { cookie: created.cookie } });
  assert.equal(info.data.keys.length, 1); assert.deepEqual(info.data.models, []);
  for (const secret of [PASSWORD, created.secret, created.sessionToken, '"password"', '"hash"', '"salt"']) assert.equal(info.text.includes(secret), false);
  assert.equal((await f.send(`/portal/api/keys/${created.key.id}`, { headers: { cookie: created.cookie } })).status, 404);
  const directory = await f.send('/v1/models', { headers: keyHeaders(created) }); assert.deepEqual(directory.data.data, []);
  const saved = await readFile(join(f.directory, 'clients.json'), 'utf8');
  assert.equal(saved.includes(PASSWORD), false); assert.equal(saved.includes(created.secret), false); assert.equal(saved.includes(created.sessionToken), false);
  const loggedIn = await f.send('/portal/api/login', { method: 'POST', body: { username: 'portal.user', password: PASSWORD } });
  assert.equal(loggedIn.status, 200); assert.equal(loggedIn.data.secret, undefined); assert.equal(loggedIn.data.key, undefined);
  const cookie = loggedIn.headers['set-cookie'][0]; assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/portal\/api\//);
});

test('optional invitations inherit only their explicit models and invite-only mode requires one', async t => {
  const f = await fixture(t), invite = await f.access.createInvite({ allowedModels: [CB], maxUses: 2 });
  const created = await f.register('invited-user', { inviteToken: invite.token });
  assert.deepEqual(created.user.allowedModels, [CB]);
  assert.deepEqual((await f.send('/v1/models', { headers: keyHeaders(created) })).data.data.map(model => model.id), [CB]);
  const invalid = await f.send('/portal/api/register', { method: 'POST', body: { username: 'invalid-invite', password: PASSWORD, inviteToken: 'not-valid' } });
  assert.equal(invalid.status, 403); assert.equal(invalid.data.error.code, 'client_invite_invalid');
  await f.access.configureRegistration({ mode: 'invite' });
  assert.equal((await f.send('/portal/api/config')).data.registration.invitationRequired, true);
  const missing = await f.send('/portal/api/register', { method: 'POST', body: { username: 'missing-invite', password: PASSWORD } });
  assert.equal(missing.status, 403);
  const second = await f.register('second-invited', { inviteToken: invite.token }); assert.deepEqual(second.user.allowedModels, [CB]);
  await f.access.configureRegistration({ mode: 'closed' });
  assert.equal((await f.send('/portal/api/config')).data.registration.enabled, false);
});

test('browser cookie writes require the session CSRF and reject cross-site requests', async t => {
  const f = await fixture(t), created = await f.register('browser-user');
  const options = { method: 'POST', body: { name: 'Browser', expiresInDays: 7 } };
  assert.equal((await f.send('/portal/api/keys', { ...options, headers: { cookie: created.cookie } })).status, 403);
  assert.equal((await f.send('/portal/api/keys', { ...options, headers: { ...cookieHeaders(created), 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await f.send('/portal/api/keys', { ...options, headers: { ...cookieHeaders(created), origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.send('/portal/api/keys', { ...options, headers: { ...cookieHeaders(created), 'sec-fetch-site': 'cross-site' } })).status, 403);
  const key = await f.send('/portal/api/keys', { ...options, headers: cookieHeaders(created) });
  assert.equal(key.status, 201); assert.match(key.data.secret, /^bfk_/); assert.equal(f.access.publicAccount(created.user.id).keys.length, 2);
  const logout = await f.send('/portal/api/logout', { method: 'POST', body: {}, headers: cookieHeaders(created) });
  assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.send('/portal/api/me', { headers: { cookie: created.cookie } })).status, 401);
});

test('Mini Program session Bearer can create and revoke keys without browser CSRF and cannot act as an inference key', async t => {
  const f = await fixture(t), created = await f.register('mini-user');
  const info = await f.send('/portal/api/me', { headers: sessionHeaders(created) }); assert.equal(info.status, 200);
  const key = await f.send('/portal/api/keys', { method: 'POST', headers: sessionHeaders(created), body: { name: 'Mini Program', expiresInDays: 3 } });
  assert.equal(key.status, 201);
  assert.equal((await f.send('/v1/models', { headers: sessionHeaders(created) })).status, 401);
  const revoked = await f.send(`/portal/api/keys/${key.data.key.id}`, { method: 'DELETE', headers: sessionHeaders(created) });
  assert.equal(revoked.status, 200); assert.equal(f.access.authenticateKey(key.data.secret), null);
  assert.equal((await f.send('/portal/api/logout', { method: 'POST', headers: sessionHeaders(created), body: {} })).status, 200);
  assert.equal((await f.send('/portal/api/session', { headers: sessionHeaders(created) })).status, 401);
});

test('self-service keys cannot extend the account deadline, while an expired key does not expire login', async t => {
  const f = await fixture(t), created = await f.register('month-user');
  f.advance(29 * DAY);
  const login = await f.send('/portal/api/login', { method: 'POST', body: { username: 'month-user', password: PASSWORD } });
  const auth = { authorization: `Bearer ${login.data.sessionToken}` };
  const later = await f.send('/portal/api/keys', { method: 'POST', headers: auth, body: { name: 'Late Key', expiresInDays: 365 } });
  assert.equal(later.status, 201); assert.equal(later.data.key.effectiveExpiresAt, created.user.keyExpiresAtLimit);
  f.advance(DAY);
  assert.equal((await f.send('/v1/models', { headers: { authorization: `Bearer ${later.data.secret}` } })).status, 401);
  const nextLogin = await f.send('/portal/api/login', { method: 'POST', body: { username: 'month-user', password: PASSWORD } });
  assert.equal(nextLogin.status, 200); assert.equal(nextLogin.data.user.enabled, true);
  const expiredCreate = await f.send('/portal/api/keys', { method: 'POST', headers: { authorization: `Bearer ${nextLogin.data.sessionToken}` }, body: { name: 'Cannot bypass', expiresInDays: 30 } });
  assert.equal(expiredCreate.status, 403); assert.equal(expiredCreate.data.error.code, 'client_key_term_expired');
});

test('portal reads and revocations are scoped to the signed-in user', async t => {
  const f = await fixture(t), alice = await f.register('alice-user'), bob = await f.register('bob-user');
  const info = await f.send('/portal/api/me', { headers: sessionHeaders(alice) });
  assert.equal(info.data.user.id, alice.user.id); assert.equal(info.data.keys.length, 1); assert.equal(info.data.keys[0].id, alice.key.id);
  assert.equal(info.text.includes(bob.key.id), false); assert.equal(info.text.includes(bob.user.id), false);
  const denied = await f.send(`/portal/api/keys/${bob.key.id}`, { method: 'DELETE', headers: sessionHeaders(alice) });
  assert.equal(denied.status, 404); assert.equal(f.access.authenticateKey(bob.secret).keyId, bob.key.id);
  assert.equal((await f.send(`/portal/api/users/${bob.user.id}`, { headers: sessionHeaders(alice) })).status, 404);
  assert.equal((await f.send(`/portal/api/keys/${bob.key.id}`, { headers: sessionHeaders(alice) })).status, 404);
});

test('models list only granted and currently enabled models; ungranted models never dispatch', async t => {
  const f = await fixture(t), assigned = await f.account('model-user', [CB, B]);
  f.models.find(model => model.id === B).enabled = false;
  const directory = await f.send('/v1/models', { headers: keyHeaders(assigned) });
  assert.equal(directory.status, 200); assert.deepEqual(directory.data.data.map(model => model.id), [CB]);
  const denied = await f.send('/v1/responses', { method: 'POST', headers: keyHeaders(assigned), body: { model: CURSOR, input: 'offline only' } });
  assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'client_model_forbidden'); assert.equal(f.calls.length, 0);
  const removed = await f.send('/v1/responses', { method: 'POST', headers: keyHeaders(assigned), body: { model: B, input: 'offline only' } });
  assert.equal(removed.status, 403); assert.equal(f.calls.length, 0);
  await f.access.updateKey(assigned.user.id, assigned.key.id, { enabled: false });
  assert.equal((await f.send('/v1/models', { headers: keyHeaders(assigned) })).status, 401);
  await f.access.updateKey(assigned.user.id, assigned.key.id, { enabled: true });
  await f.access.updateAccount(assigned.user.id, { enabled: false });
  assert.equal((await f.send('/v1/models', { headers: keyHeaders(assigned) })).status, 401);
  assert.equal((await f.send('/portal/api/me', { headers: sessionHeaders(assigned) })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('legal Chat JSON and SSE retain text, usage and tenant scope without transmitting client credentials upstream', async t => {
  const f = await fixture(t, { responses: value => responseSse(value.body.model, [textItem('离线答复')],
    [{ type: 'response.output_text.delta', output_index: 0, delta: '离线答复' }]) });
  const assigned = await f.account('chat-user');
  const body = { model: CB, messages: [{ role: 'user', content: '离线问题' }], max_tokens: 32 };
  const normal = await f.send('/v1/chat/completions', { method: 'POST', headers: keyHeaders(assigned), body });
  assert.equal(normal.status, 200); assert.equal(normal.data.object, 'chat.completion');
  assert.equal(normal.data.choices[0].message.content, '离线答复'); assert.equal(normal.data.choices[0].finish_reason, 'stop');
  assert.equal(normal.data.usage.total_tokens, 6);
  const streamed = await f.send('/v1/chat/completions', { method: 'POST', headers: keyHeaders(assigned), body: { ...body, stream: true, stream_options: { include_usage: true } } });
  assert.equal(streamed.status, 200); assert.match(streamed.headers['content-type'], /text\/event-stream/);
  assert.match(streamed.text, /离线答复/); assert.match(streamed.text, /"finish_reason":"stop"/); assert.match(streamed.text, /data: \[DONE\]\n\n$/);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.scope, assigned.user.id); assert.equal(call.body.model, CB); assert.equal(call.body.stream, true);
    assert.equal(call.body.input[0].content[0].text, '离线问题'); assert.equal(call.body.max_output_tokens, 32);
    assert.equal(Object.keys(call).includes('headers'), false);
    assert.equal(JSON.stringify(call.body).includes(assigned.secret), false);
    assert.equal(JSON.stringify(call.body).includes(assigned.sessionToken), false);
  }
});

test('Chat tool round trips preserve opaque state and reject cross-user continuation before dispatch', async t => {
  const toolCall = { type: 'function_call', id: 'fc_offline', call_id: 'call_offline', name: 'read_file', arguments: '{"path":"sample.txt"}', status: 'completed' };
  const f = await fixture(t, { responses(value, calls) {
    return calls.length === 1 ? responseSse(value.body.model, [{ type: 'reasoning', encrypted_content: 'offline-opaque-state', summary: [] }, toolCall])
      : responseSse(value.body.model, [textItem('文件内容已收到')]);
  } });
  const assigned = await f.account('tool-user'), other = await f.account('other-tool-user');
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const messages = [{ role: 'user', content: '读取文件' }];
  const first = await f.send('/v1/chat/completions', { method: 'POST', headers: keyHeaders(assigned), body: { model: CB, messages, tools } });
  assert.equal(first.status, 200); assert.equal(first.data.choices[0].finish_reason, 'tool_calls');
  const assistant = first.data.choices[0].message;
  assert.equal(assistant.tool_calls[0].id, 'call_offline'); assert.equal(first.text.includes('offline-opaque-state'), false);
  const history = [...messages, assistant, { role: 'tool', tool_call_id: 'call_offline', content: '离线文件内容' }];
  const crossUser = await f.send('/v1/chat/completions', { method: 'POST', headers: keyHeaders(other), body: { model: CB, messages: history, tools } });
  assert.equal(crossUser.status, 409); assert.equal(f.calls.length, 1);
  const second = await f.send('/v1/chat/completions', { method: 'POST', headers: keyHeaders(assigned), body: { model: CB, messages: history, tools } });
  assert.equal(second.status, 200); assert.equal(second.data.choices[0].message.content, '文件内容已收到'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.input.find(item => item.type === 'reasoning').encrypted_content, 'offline-opaque-state');
  assert.deepEqual(f.calls[1].body.input.at(-1), { type: 'function_call_output', call_id: 'call_offline', output: '离线文件内容' });
});

test('Messages authenticates with the same issued key and is restricted to the CodeBuddy channel', async t => {
  const f = await fixture(t), assigned = await f.account('messages-user', [CB, CURSOR]);
  const first = await f.send('/v1/messages', { method: 'POST', headers: { 'x-api-key': assigned.secret }, body: { model: CB, messages: [{ role: 'user', content: 'offline' }], max_tokens: 8 } });
  assert.equal(first.status, 200); assert.equal(first.data.type, 'message'); assert.equal(f.messageCalls.length, 1);
  assert.equal(f.messageCalls[0].scope, assigned.user.id);
  const denied = await f.send('/v1/messages', { method: 'POST', headers: keyHeaders(assigned), body: { model: CURSOR, messages: [], max_tokens: 8 } });
  assert.equal(denied.status, 501); assert.equal(denied.data.error.code, 'client_protocol_unsupported'); assert.equal(f.messageCalls.length, 1);
  const conflicting = await f.send('/v1/models', { headers: { authorization: `Bearer ${assigned.secret}`, 'x-api-key': 'different-key' } });
  assert.equal(conflicting.status, 401);
});

test('Host, Origin, malformed body and draining failures do not reach the fake model', async t => {
  let draining = false;
  const f = await fixture(t, { server: { isDraining: () => draining } }), assigned = await f.account('boundary-user');
  assert.equal((await f.send('/portal/api/config', { headers: { host: 'attacker.example' } })).status, 403);
  const wrongOrigin = await f.send('/portal/api/login', { method: 'POST', body: { username: 'boundary-user', password: PASSWORD }, headers: { origin: 'https://other.example' } });
  assert.equal(wrongOrigin.status, 403);
  const invalid = await f.send('/v1/responses', { method: 'POST', headers: keyHeaders(assigned), body: [] }); assert.equal(invalid.status, 400);
  draining = true;
  const denied = await f.send('/v1/responses', { method: 'POST', headers: keyHeaders(assigned), body: { model: CB, input: 'offline' } });
  assert.equal(denied.status, 503); assert.equal(denied.data.error.code, 'gateway_restarting'); assert.equal(f.calls.length, 0);
  assert.equal((await f.send('/v1/models', { headers: keyHeaders(assigned) })).status, 200);
});
