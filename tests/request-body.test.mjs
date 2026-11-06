import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once, getEventListeners } from 'node:events';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { Gateway } from '../src/gateway.mjs';
import { decodeModelRequestBody, readModelRequestBody, normalizeRequestBodyDiagnostics,
  MODEL_REQUEST_BODY_LIMIT } from '../src/request-body.mjs';

const MiB = 1024 * 1024;
const gatewayKey = 'offline-request-body-gateway-key-000000000000';

async function gatewayFixture(t, fetchImpl) {
  const backend = { async credentials() { return { value: 'offline-b-credential', accountId: 'offline-b' }; } };
  const gateway = new Gateway({ backend, gatewayKey, fetchImpl,
    getAProvider: async () => ({ config: { base_url: 'https://offline-a.invalid/backend-api/codex' } }) });
  const server = http.createServer(async (req, res) => {
    try { await gateway.proxy(req, res, new URL(req.url, 'http://127.0.0.1')); }
    catch (error) {
      if (res.headersSent) res.destroy();
      else { res.writeHead(error.status ?? 500); res.end(error.message); }
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { gateway, url: `http://127.0.0.1:${server.address().port}` };
}

test('model transport defaults allow 128 MiB while an unchanged native A identity body exceeds 64 MiB', async t => {
  assert.equal(MODEL_REQUEST_BODY_LIMIT, 128 * MiB);
  const plain = imageHistory('gpt-6.1-sol');
  let calls = 0;
  const { url } = await gatewayFixture(t, async (address, options) => {
    calls++;
    assert.equal(address.startsWith('https://offline-a.invalid/'), true);
    assert.equal(options.headers.get('content-encoding'), null);
    assert.deepEqual(options.body, plain);
    return Response.json({ status: 'completed', output: [] });
  });
  const response = await fetch(url + '/responses', { method: 'POST', body: plain, headers: {
    'x-account-bridge-key': gatewayKey, authorization: 'Bearer offline-client-a', 'content-type': 'application/json',
  } });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls, 1);
});

test('B keeps its own credential and changes only its model alias after decoding gzip', async t => {
  const source = { model: 'B-gpt-6.1-sol', input: [{ role: 'user', content: [
    { type: 'input_text', text: 'offline exact text' },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
  ] }], tools: [{ type: 'function', name: 'offline_tool', parameters: { type: 'object' } }] };
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(source)));
  let calls = 0;
  const { url } = await gatewayFixture(t, async (address, options) => {
    if (address.includes('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol' }] });
    calls++;
    assert.equal(address, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.get('authorization'), 'Bearer offline-b-credential');
    assert.equal(options.headers.get('chatgpt-account-id'), 'offline-b');
    assert.equal(options.headers.get('cookie'), null);
    assert.equal(options.headers.get('content-encoding'), null);
    assert.deepEqual(JSON.parse(options.body), { ...source, model: 'gpt-6.1-sol' });
    return Response.json({ status: 'completed', output: [] });
  });
  const response = await fetch(url + '/responses', { method: 'POST', body: packed, headers: {
    'x-account-bridge-key': gatewayKey, authorization: 'Bearer offline-client-a', cookie: 'a=private',
    'content-encoding': 'gzip', 'content-type': 'application/json',
  } });
  assert.equal(response.status, 200, await response.text()); assert.equal(calls, 1);
});

const codecs = [['identity', value => value], ['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync],
  ['br', zlib.brotliCompressSync], ...(typeof zlib.zstdCompressSync === 'function' ? [['zstd', zlib.zstdCompressSync]] : [])];

test('all supported codecs decode without changing the wire buffer and report exact successful byte counts', async () => {
  const source = Buffer.from('{"model":"gpt-6.1-sol","input":"offline codec fixture"}');
  for (const [encoding, encode] of codecs) {
    const wire = encode(source), snapshot = Buffer.from(wire);
    const result = await decodeModelRequestBody(wire, { 'content-encoding': encoding });
    assert.equal(result.wireBody, wire); assert.deepEqual(wire, snapshot); assert.deepEqual(result.body, source);
    assert.deepEqual(result.diagnostics, { version: 1, encodings: [encoding], wireBytes: wire.length,
      decodedBytes: source.length, wireLimitBytes: 128 * MiB, decodedLimitBytes: 128 * MiB,
      stage: 'complete', errorKind: null });
  }
});

test('multiple encodings decode in reverse order and identity can be interleaved', async () => {
  const source = Buffer.from('offline ordered encoding chain');
  const wire = zlib.brotliCompressSync(zlib.gzipSync(source));
  const result = await decodeModelRequestBody(wire, { 'content-encoding': ' GZip , identity , BR ' });
  assert.deepEqual(result.body, source); assert.deepEqual(result.diagnostics.encodings, ['gzip', 'identity', 'br']);
  await assert.rejects(decodeModelRequestBody(wire, { 'content-encoding': 'br,gzip' }),
    { code: 'request_body_invalid_compression', status: 400 });
});

test('wire and decoded boundaries accept the exact limit and reject the first byte over it distinctly', async () => {
  const source = Buffer.alloc(65, 0x61);
  const atLimit = await decodeModelRequestBody(source, {}, { wireLimitBytes: 65, decodedLimitBytes: 65 });
  assert.equal(atLimit.body.length, 65);
  await assert.rejects(decodeModelRequestBody(source, {}, { wireLimitBytes: 64 }), error => {
    assert.equal(error.status, 413); assert.equal(error.code, 'request_body_wire_too_large');
    assert.equal(error.requestBodyDiagnostics.stage, 'wire'); assert.equal(error.requestBodyDiagnostics.wireBytes, 65);
    assert.equal(error.requestBodyDiagnostics.decodedBytes, null); return true;
  });
  for (const [encoding, encode] of codecs) {
    await assert.rejects(decodeModelRequestBody(encode(source), { 'content-encoding': encoding }, { decodedLimitBytes: 64 }), error => {
      assert.equal(error.status, 413); assert.equal(error.code, 'request_body_decoded_too_large');
      assert.equal(error.requestBodyDiagnostics.stage, 'decode');
      assert.equal(error.requestBodyDiagnostics.decodedBytes, null); return true;
    });
  }
});

test('broken and truncated compression produce typed 400 errors without exposing data or decoder text', async () => {
  const secret = 'PRIVATE_INVALID_COMPRESSED_PAYLOAD';
  for (const [encoding, encode] of codecs.filter(([name]) => name !== 'identity')) {
    const packed = encode(Buffer.from('offline compression completeness fixture '.repeat(8)));
    for (const wire of [Buffer.from(secret), packed.subarray(0, Math.floor(packed.length / 2))]) {
      await assert.rejects(decodeModelRequestBody(wire, { 'content-encoding': encoding }), error => {
        assert.equal(error.code, 'request_body_invalid_compression'); assert.equal(error.status, 400);
        assert.equal(error.requestBodyDiagnostics.decodedBytes, null);
        assert.equal(error.message.includes(secret), false); assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(Object.hasOwn(error, 'cause'), false); return true;
      });
    }
  }
});

test('valid codec streams followed by ignored garbage are rejected instead of dropping trailing bytes', async () => {
  for (const [encoding, encode] of codecs.filter(([name]) => name !== 'identity')) {
    const wire = Buffer.concat([encode(Buffer.from('offline trailing-byte fixture')), Buffer.from('PRIVATE_TRAILING_BYTES')]);
    await assert.rejects(decodeModelRequestBody(wire, { 'content-encoding': encoding }), error => {
      assert.equal(error.code, 'request_body_invalid_compression');
      assert.equal(JSON.stringify(error).includes('PRIVATE_TRAILING_BYTES'), false); return true;
    });
  }
});

test('unsupported names, inherited object names and excessive encoding chains fail closed without reflection', async () => {
  for (const value of ['private-unsupported-secret', 'constructor', 'toString', '', 'gzip,', 'identity,identity,identity,identity,identity']) {
    await assert.rejects(decodeModelRequestBody(Buffer.from('offline'), { 'content-encoding': value }), error => {
      assert.equal(error.code, 'request_body_unsupported_encoding'); assert.equal(error.status, 415);
      assert.deepEqual(error.requestBodyDiagnostics.encodings, []);
      assert.equal(JSON.stringify(error).includes('private-unsupported-secret'), false); return true;
    });
  }
});

test('zstd window and dictionary rejections have explicit finite numeric diagnostics',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
    const packed = zlib.zstdCompressSync(Buffer.from('offline'));
    assert.equal(packed[4], 0x20);
    const tooLargeWindow = Buffer.concat([packed.subarray(0, 4), Buffer.from([0, 0xff]), packed.subarray(6)]);
    const wrongDictionary = Buffer.concat([packed.subarray(0, 4), Buffer.from([0x21, 1]), packed.subarray(5)]);
    for (const [wire, errorKind, numeric] of [[tooLargeWindow, 'zstd_window_limit', 16], [wrongDictionary, 'zstd_dictionary_error', 32]]) {
      await assert.rejects(decodeModelRequestBody(wire, { 'content-encoding': 'zstd' }), error => {
        assert.equal(error.status, 400); assert.equal(error.code, `request_body_${errorKind}`);
        assert.equal(error.requestBodyDiagnostics.errorKind, errorKind);
        assert.equal(error.requestBodyDiagnostics.zstdErrorCode, numeric); return true;
      });
    }
  });

test('zstd accepts complete concatenated, checksummed, empty and skippable frames while rejecting truncated tails',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
    const first = zlib.zstdCompressSync(Buffer.from('first'));
    const second = zlib.zstdCompressSync(Buffer.from('second'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    const empty = zlib.zstdCompressSync(Buffer.alloc(0));
    const skip = Buffer.alloc(11); skip.writeUInt32LE(0x184d2a50); skip.writeUInt32LE(3, 4); skip.fill(0x41, 8);
    const combined = Buffer.concat([skip, first, empty, second]);
    const result = await decodeModelRequestBody(combined, { 'content-encoding': 'zstd' });
    assert.equal(result.body.toString(), 'firstsecond');
    for (const wire of [Buffer.alloc(0), first.subarray(0, first.length - 1),
      combined.subarray(0, combined.length - 1), Buffer.concat([first, Buffer.from([0x28])])]) {
      await assert.rejects(decodeModelRequestBody(wire, { 'content-encoding': 'zstd' }), { code: 'request_body_invalid_compression' });
    }
  });

test('zstd framing accepts Node content-size variants, unknown-size windows, 64-bit FCS and RLE blocks',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
    for (const length of [0, 7, 256, 70_000]) {
      const source = Buffer.alloc(length, 0x41);
      for (const contentSize of [0, 1]) {
        const wire = zlib.zstdCompressSync(source, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: contentSize } });
        assert.deepEqual((await decodeModelRequestBody(wire, { 'content-encoding': 'zstd' })).body, source);
      }
    }
    const short = zlib.zstdCompressSync(Buffer.from('offline'));
    const size = Buffer.alloc(8); size.writeBigUInt64LE(7n);
    const wideSize = Buffer.concat([short.subarray(0, 4), Buffer.from([0xe0]), size, short.subarray(6)]);
    assert.equal((await decodeModelRequestBody(wideSize, { 'content-encoding': 'zstd' })).body.toString(), 'offline');
    const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x2b, 0, 0, 0x41]);
    assert.equal((await decodeModelRequestBody(rle, { 'content-encoding': 'zstd' })).body.toString(), 'AAAAA');
    for (let length = 0; length < wideSize.length; length++) {
      await assert.rejects(decodeModelRequestBody(wideSize.subarray(0, length), { 'content-encoding': 'zstd' }),
        { code: 'request_body_invalid_compression' });
    }
  });

test('concatenated zstd frames share one decoded budget including an empty frame at the boundary',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
    const part = zlib.zstdCompressSync(Buffer.alloc(32, 0x41));
    const empty = zlib.zstdCompressSync(Buffer.alloc(0));
    const wire = Buffer.concat([part, part, empty]);
    const headers = { 'content-encoding': 'zstd' };
    assert.equal((await decodeModelRequestBody(wire, headers, { decodedLimitBytes: 64 })).body.length, 64);
    await assert.rejects(decodeModelRequestBody(wire, headers, { decodedLimitBytes: 63 }), error => {
      assert.equal(error.code, 'request_body_decoded_too_large'); assert.equal(error.status, 413);
      assert.equal(error.requestBodyDiagnostics.decodedBytes, null); return true;
    });
    await assert.rejects(decodeModelRequestBody(Buffer.concat([wire, zlib.zstdCompressSync(Buffer.from('x'))]),
      headers, { decodedLimitBytes: 64 }), { code: 'request_body_decoded_too_large' });
  });

test('diagnostics normalization retains only finite metadata and whitelisted codec errors', () => {
  assert.equal(normalizeRequestBodyDiagnostics(null), null);
  const raw = { version: 1, encodings: ['zstd'], wireBytes: 12, decodedBytes: null, wireLimitBytes: 100,
    decodedLimitBytes: 200, stage: 'decode', errorKind: 'zstd_dictionary_error', zstdErrorCode: 32,
    message: 'PRIVATE_DECODER_MESSAGE', body: 'PRIVATE_BODY', headers: { authorization: 'PRIVATE_AUTH' } };
  const safe = normalizeRequestBodyDiagnostics(raw);
  assert.equal(safe.zstdErrorCode, 32); assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
  assert.equal(Object.hasOwn(normalizeRequestBodyDiagnostics({ ...raw, zstdErrorCode: 999 }), 'zstdErrorCode'), false);
  const malformed = normalizeRequestBodyDiagnostics({ ...raw, encodings: ['PRIVATE_CODEC'], wireBytes: -1,
    decodedBytes: Number.POSITIVE_INFINITY, stage: 'PRIVATE_STAGE', errorKind: 'PRIVATE_ERROR' });
  assert.deepEqual(malformed.encodings, []); assert.equal(malformed.wireBytes, null);
  assert.equal(malformed.decodedBytes, null); assert.equal(malformed.stage, null); assert.equal(malformed.errorKind, null);
  assert.equal(JSON.stringify(malformed).includes('PRIVATE'), false);
});

test('an oversized real HTTP upload receives 413 instead of losing its socket', async t => {
  let observed;
  const server = http.createServer(async (req, res) => {
    try { await readModelRequestBody(req, { wireLimitBytes: 16, decodedLimitBytes: 32 }); res.end('unexpected'); }
    catch (error) { observed = error; res.writeHead(error.status); res.end(error.code); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', body: Buffer.alloc(17) });
  assert.equal(response.status, 413); assert.equal(await response.text(), 'request_body_wire_too_large');
  assert.equal(observed.requestBodyDiagnostics.wireBytes, 17);
});

test('pre-cancelled requests do not begin reading or decode and do not expose the cancellation reason', async () => {
  const controller = new AbortController(); controller.abort(new Error('PRIVATE_ABORT_REASON'));
  let reads = 0;
  const req = { headers: {}, [Symbol.asyncIterator]() { reads++; throw new Error('must not read'); } };
  await assert.rejects(readModelRequestBody(req, { signal: controller.signal }), error => {
    assert.equal(error.code, 'request_body_aborted'); assert.equal(JSON.stringify(error).includes('PRIVATE_ABORT_REASON'), false); return true;
  });
  await assert.rejects(decodeModelRequestBody(Buffer.from('offline'), {}, { signal: controller.signal }), { code: 'request_body_aborted' });
  assert.equal(reads, 0);
});

test('cancellation interrupts a pending body read without waiting for another chunk', async () => {
  const controller = new AbortController();
  const req = new Readable({ read() {} }); req.headers = {};
  try {
    const pending = readModelRequestBody(req, { signal: controller.signal });
    setImmediate(() => controller.abort());
    await assert.rejects(pending, { code: 'request_body_aborted' });
  } finally { req.destroy(); }
});

test('cancellation during asynchronous zstd decoding rejects before any model dispatch',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async () => {
    const packed = zlib.zstdCompressSync(Buffer.alloc(70 * MiB, 0x41));
    const controller = new AbortController(); let dispatches = 0;
    const pending = decodeModelRequestBody(packed, { 'content-encoding': 'zstd' }, { signal: controller.signal })
      .then(() => { dispatches++; });
    setImmediate(() => controller.abort());
    await assert.rejects(pending, { code: 'request_body_aborted' });
    assert.equal(dispatches, 0);
  });

test('invalid transport is rejected before any A or B upstream call', async t => {
  let calls = 0;
  const { url } = await gatewayFixture(t, async () => { calls++; throw new Error('must not dispatch'); });
  for (const [encoding, wire, status] of [['zstd', Buffer.from('PRIVATE_BAD_COMPRESSED_BODY'), 400],
    ['PRIVATE_UNSUPPORTED_ENCODING', Buffer.from('{"model":"B-gpt-6.1-sol"}'), 415]]) {
    const response = await fetch(url + '/responses', { method: 'POST', body: wire, headers: {
      'x-account-bridge-key': gatewayKey, authorization: 'Bearer offline-client-a', 'content-encoding': encoding,
    } });
    assert.equal(response.status, status); assert.equal((await response.text()).includes('PRIVATE'), false);
  }
  assert.equal(calls, 0);
});

function imageHistory(model, length = 70 * MiB) {
  const prefix = Buffer.from(JSON.stringify({ model, stream: true,
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: '' }] }] }).replace('"image_url":""',
    '"image_url":"data:image/png;base64,'));
  const end = Buffer.from('"}]}]}');
  const body = Buffer.alloc(length, 0x41);
  // Construct a large JSON image envelope without retaining a second large string.
  const beginning = prefix.subarray(0, prefix.indexOf('data:image/png;base64,') + 'data:image/png;base64,'.length);
  beginning.copy(body); end.copy(body, body.length - end.length);
  return body;
}

test('native A forwards an unchanged zstd image envelope above 64 MiB through responses and compact',
  { skip: typeof zlib.zstdCompressSync !== 'function' }, async t => {
    const plain = imageHistory('gpt-6.1-sol');
    const wire = zlib.zstdCompressSync(plain);
    const calls = [];
    const { url } = await gatewayFixture(t, async (address, options) => {
      calls.push({ address, options });
      assert.equal(address.startsWith('https://offline-a.invalid/'), true);
      assert.equal(options.headers.get('authorization'), 'Bearer offline-client-a');
      assert.equal(options.headers.get('content-encoding'), 'zstd');
      assert.deepEqual(options.body, wire);
      return Response.json({ id: 'offline-response', status: 'completed', output: [] });
    });
    for (const path of ['/responses', '/responses/compact']) {
      const response = await fetch(url + path, { method: 'POST', body: wire, headers: {
        'x-account-bridge-key': gatewayKey, authorization: 'Bearer offline-client-a',
        'content-encoding': 'zstd', 'content-type': 'application/json',
      } });
      assert.equal(response.status, 200, await response.text());
    }
    assert.equal(calls.length, 2);
  });

test('body reads preserve existing data observers without requiring pause, including with a cancellation signal', async t => {
  const payload = Buffer.from('{"model":"offline","input":"synthetic"}');
  const observations = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [], controller = new AbortController();
    req.on('data', part => chunks.push(part));
    try {
      const options = req.url === '/signal' ? { signal: controller.signal } : {};
      const result = await readModelRequestBody(req, options);
      observations.push({ wire: result.wireBody, decoded: result.body, observed: Buffer.concat(chunks),
        abortListeners: getEventListeners(controller.signal, 'abort').length });
      res.end('complete');
    } catch (error) { res.writeHead(error.status ?? 500); res.end(error.code); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const path of ['/without-signal', '/signal']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: payload });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'complete');
  }
  assert.equal(observations.length, 2);
  for (const observed of observations) {
    assert.deepEqual(observed.wire, payload); assert.deepEqual(observed.decoded, payload);
    assert.deepEqual(observed.observed, payload); assert.equal(observed.abortListeners, 0);
  }
});

test('synchronous iterator errors remove the cancellation listener and close the iterator without exposing the error', async () => {
  const controller = new AbortController(); let returns = 0;
  const req = { headers: {}, [Symbol.asyncIterator]() { return {
    next() { throw new Error('PRIVATE_SYNCHRONOUS_ITERATOR_ERROR'); },
    return() { returns++; return Promise.resolve({ done: true }); },
  }; } };
  await assert.rejects(readModelRequestBody(req, { signal: controller.signal }), error => {
    assert.equal(error.code, 'request_body_read_failed');
    assert.equal(JSON.stringify(error).includes('PRIVATE_SYNCHRONOUS_ITERATOR_ERROR'), false); return true;
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(returns, 1);
});
