import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePart, ImageConversionError, DEFAULT_MAX_IMAGE_BYTES } from '../src/codebuddy-images.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// Opaque offline fixtures exercise MIME signatures; no decoder or image processing runs.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString('base64');
const webp = Buffer.from('524946460c000000574542505650384c00000000', 'hex').toString('base64');
const embedded = (data = png, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });
const remote = url => ({ type: 'image', source: { type: 'url', url } });
function rejected(block, options) {
  assert.throws(() => imagePart(block, options), error => {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ImageConversionError);
    assert.equal(error.status, 400);
    assert.equal(error.message.includes('PRIVATE_PAYLOAD'), false);
    return true;
  });
}

test('four supported base64 image formats map to new image_url parts without changing input', () => {
  for (const [data, mediaType] of [[png, 'image/png'], [gif, 'image/gif'], [jpeg, 'image/jpeg'], [webp, 'image/webp']]) {
    const block = embedded(data, mediaType), before = structuredClone(block);
    Object.freeze(block.source); Object.freeze(block);
    assert.deepEqual(imagePart(block), { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
    assert.deepEqual(block, before);
  }
});

test('HTTPS image references preserve signed URL query and accept public IP literals without fetching', () => {
  for (const url of ['https://images.example.com/picture.png?signature=opaque%2Bvalue&expires=123',
    'https://8.8.8.8/picture.png', 'https://[2606:4700:4700::1111]/image.webp']) {
    assert.deepEqual(imagePart(remote(url)), { type: 'image_url', image_url: { url } });
  }
  assert.equal(imagePart(remote('HTTPS://IMAGES.EXAMPLE.COM:443/p.png')).image_url.url, 'https://images.example.com/p.png');
});

test('cache hints are validated, counted once and omitted from the converted part', () => {
  let hints = 0;
  for (const hint of [{ type: 'ephemeral' }, { type: 'ephemeral', ttl: '5m' }, { type: 'ephemeral', ttl: '1h' }]) {
    const result = imagePart({ ...embedded(), cache_control: hint }, { onCacheHint: () => hints++ });
    assert.deepEqual(Object.keys(result), ['type', 'image_url']);
  }
  imagePart(embedded(), { onCacheHint: () => hints++ });
  assert.equal(hints, 3);
  rejected({ ...embedded(), source: { type: 'url', url: 'https://localhost/a' }, cache_control: { type: 'ephemeral' } }, { onCacheHint: () => hints++ });
  assert.equal(hints, 3);
  for (const hint of [null, true, [], {}, { type: 'persistent' }, { type: 'ephemeral', ttl: '24h' }, { type: 'ephemeral', token: 'PRIVATE_PAYLOAD' }]) {
    rejected({ ...embedded(), cache_control: hint });
  }
});

test('strict schemas reject file references, unsupported transformations and mixed or extra source fields', () => {
  for (const block of [null, [], {}, { ...embedded(), type: 'text' },
    { ...embedded(), token: 'PRIVATE_PAYLOAD' }, { ...embedded(), transformations: { oversized_image: 'error' } },
    { type: 'image', source: { type: 'file', file_id: 'PRIVATE_PAYLOAD' } },
    { type: 'image', source: 'PRIVATE_PAYLOAD' }, { type: 'image', source: null },
    { ...embedded(), source: { ...embedded().source, url: 'https://images.example.com/p.png' } },
    { type: 'image', source: { type: 'url', url: 'https://images.example.com/p.png', media_type: 'image/png' } },
    { type: 'image', source: { type: 'base64', data: png } },
  ]) rejected(block);
});

test('malformed, empty, noncanonical and mislabeled base64 data fail explicitly', () => {
  for (const data of ['', null, [], ' ', 'PRIVATE_PAYLOAD', png + '\n', 'AA', 'AA=', 'AA===', 'AAAA====', 'AB==', 'AAB=', 'AA-_', 'data:image/png;base64,' + png]) {
    rejected(embedded(data));
  }
  rejected(embedded(Buffer.from('not an image').toString('base64')));
  rejected(embedded(png, 'image/jpeg'));
  rejected(embedded(png, 'image/svg+xml'));
  rejected(embedded(png, 'image/jpg'));
  rejected(embedded(Buffer.from('GIF89a').map(byte => byte | 0x80).toString('base64'), 'image/gif'));
});

test('decoded image limit is exact and checked before oversized data can be decoded', () => {
  const size = Buffer.from(png, 'base64').length;
  assert.equal(imagePart(embedded(), { maxImageBytes: size }).image_url.url.endsWith(png), true);
  rejected(embedded(), { maxImageBytes: size - 1 });
  // Same encoded length as a 3-byte value, but the padding makes the actual size 1.
  rejected(embedded('AAAA'), { maxImageBytes: 1 });
  const huge = Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES + 1);
  Buffer.from(png, 'base64').copy(huge);
  rejected(embedded(huge.toString('base64')));
  for (const options of [{ maxImageBytes: 0 }, { maxImageBytes: Infinity }, { maxImageBytes: 1.5 },
    { maxUrlLength: 0 }, { onCacheHint: true }]) rejected(embedded(), options);
});

test('local, private, reserved, encoded and IPv6 transition destinations are rejected', () => {
  const hosts = ['localhost', 'LOCALHOST.', 'host.local', 'host.internal', 'host.lan', 'host.corp', 'host',
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.168.1', '192.0.2.3', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '%31%32%37.0.0.1',
    '[::]', '[::1]', '[fc00::1]', '[fd00::1]', '[fe80::1]', '[ff02::1]', '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]', '[64:ff9b::a00:1]', '[2002:a00:1::]', '[2001:db8::1]', '[3fff::1]'];
  for (const host of hosts) rejected(remote(`https://${host}/PRIVATE_PAYLOAD`));
});

test('file paths, credentials, non-HTTPS schemes, control characters and oversized URLs are rejected', () => {
  for (const url of ['file:///C:/PRIVATE_PAYLOAD.png', 'C:\\PRIVATE_PAYLOAD.png', '//images.example.com/p.png',
    'http://images.example.com/p.png', 'data:image/png;base64,' + png, 'javascript:PRIVATE_PAYLOAD',
    'https://user:PRIVATE_PAYLOAD@images.example.com/p.png', 'https://@images.example.com/p.png',
    'https://images.example.com:8443/p.png', 'https://images.example.com/has space.png',
    'https://images.example.com\\@127.0.0.1/p.png', 'https://images.example.com/p\n.png']) rejected(remote(url));
  const url = 'https://images.example.com/p.png';
  assert.equal(imagePart(remote(url), { maxUrlLength: url.length }).image_url.url, url);
  rejected(remote(url), { maxUrlLength: url.length - 1 });
});
