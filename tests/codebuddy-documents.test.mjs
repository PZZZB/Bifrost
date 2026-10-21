import test from 'node:test';
import assert from 'node:assert/strict';
import { documentParts, DocumentConversionError, MAX_DOCUMENT_TEXT_BYTES } from '../src/codebuddy-documents.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
const textDocument = data => ({ type: 'document', source: { type: 'text', media_type: 'text/plain', data } });
const contentDocument = content => ({ type: 'document', source: { type: 'content', content } });
function rejected(block, options, expected) {
  assert.throws(() => documentParts(block, options), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.status, 400);
    assert.equal(error.message.includes('PRIVATE_ATTACHMENT'), false);
    if (expected) assert.match(error.message, expected);
    return true;
  });
}

test('plain-text attachment bytes of text, whitespace and Unicode are preserved without diagnostics or file lookup', () => {
  const text = '\uFEFF章节一\r\n\talpha β 🙂\n{"path":"C:\\\\offline\\\\fixture.txt"}\n';
  const block = textDocument(text), original = structuredClone(block);
  Object.freeze(block.source); Object.freeze(block);
  assert.deepEqual(documentParts(block), [{ type: 'text', text }]);
  assert.deepEqual(block, original);
  assert.deepEqual(documentParts(textDocument('')), [{ type: 'text', text: '' }]);
});

test('title and context have explicit prefixes followed by complete original attachment content', () => {
  const block = { ...textDocument('正文一\n正文二\n'), title: 'design-notes.txt', context: '本地附件的上下文\n第二行' };
  const result = documentParts(block);
  assert.deepEqual(result, [
    { type: 'text', text: '[Document title]\ndesign-notes.txt\n' },
    { type: 'text', text: '[Document context]\n本地附件的上下文\n第二行\n' },
    { type: 'text', text: '[Document content]\n' },
    { type: 'text', text: '正文一\n正文二\n' },
  ]);
  assert.deepEqual(documentParts({ ...contentDocument('same content'), title: null, context: null }), [{ type: 'text', text: 'same content' }]);
});

test('content source supports an exact string and ordered text/image parts without merging or changing input', () => {
  assert.deepEqual(documentParts(contentDocument('a\nb\t中')), [{ type: 'text', text: 'a\nb\t中' }]);
  const blocks = [{ type: 'text', text: 'before\n' }, structuredClone(image), { type: 'text', text: 'between' },
    { type: 'image', source: { type: 'url', url: 'https://images.example.com/diagram.png' } }, { type: 'text', text: '\nafter' }];
  const block = contentDocument(blocks), original = structuredClone(block);
  for (const child of blocks) { if (child.source) Object.freeze(child.source); Object.freeze(child); }
  Object.freeze(blocks); Object.freeze(block.source); Object.freeze(block);
  const result = documentParts(block);
  assert.deepEqual(result, [
    { type: 'text', text: 'before\n' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    { type: 'text', text: 'between' }, { type: 'image_url', image_url: { url: 'https://images.example.com/diagram.png' } },
    { type: 'text', text: '\nafter' },
  ]);
  result[0].text = 'mutated output';
  assert.deepEqual(block, original);
});

test('valid document and nested cache hints are counted once each only after complete conversion', () => {
  let hints = 0;
  const block = { ...contentDocument([
    { type: 'text', text: 'first', cache_control: { type: 'ephemeral', ttl: '5m' } },
    { ...structuredClone(image), cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]), cache_control: { type: 'ephemeral' } };
  const result = documentParts(block, { onCacheHint: () => hints++ });
  assert.equal(hints, 3);
  assert.equal(JSON.stringify(result).includes('cache_control'), false);
  rejected({ ...block, source: { type: 'content', content: [...block.source.content, { type: 'video', data: 'PRIVATE_ATTACHMENT' }] } }, { onCacheHint: () => hints++ });
  assert.equal(hints, 3);
  for (const hint of [null, [], {}, { type: 'persistent' }, { type: 'ephemeral', ttl: '24h' },
    { type: 'ephemeral', secret: 'PRIVATE_ATTACHMENT' }]) {
    rejected({ ...textDocument('content'), cache_control: hint });
    rejected(contentDocument([{ type: 'text', text: 'content', cache_control: hint }]));
  }
});

test('citations can be disabled but enabled or invalid citation semantics fail without counting hints', () => {
  for (const citations of [undefined, null, {}, { enabled: false }]) {
    assert.deepEqual(documentParts({ ...textDocument('actual content'), citations }), [{ type: 'text', text: 'actual content' }]);
  }
  let hints = 0;
  rejected({ ...textDocument('actual content'), citations: { enabled: true }, cache_control: { type: 'ephemeral' } },
    { onCacheHint: () => hints++ }, /citations/);
  assert.equal(hints, 0);
  for (const citations of [true, [], { enabled: 'false' }, { enabled: false, secret: 'PRIVATE_ATTACHMENT' }]) {
    rejected({ ...textDocument('actual content'), citations });
  }
});

test('binary PDF, Office, video, URL and file references explicitly require prior parsing', () => {
  for (const source of [
    { type: 'base64', media_type: 'application/pdf', data: 'PRIVATE_ATTACHMENT' },
    { type: 'base64', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: 'PRIVATE_ATTACHMENT' },
    { type: 'text', media_type: 'application/pdf', data: 'PRIVATE_ATTACHMENT' },
    { type: 'text', media_type: 'application/msword', data: 'PRIVATE_ATTACHMENT' },
    { type: 'url', url: 'https://example.com/PRIVATE_ATTACHMENT.pdf' },
    { type: 'file', file_id: 'PRIVATE_ATTACHMENT' },
    { type: 'video', data: 'PRIVATE_ATTACHMENT' },
  ]) rejected({ type: 'document', title: 'file-name-is-not-content', source }, undefined, /先解析为文本或图片/);
  rejected({ type: 'video', source: { type: 'url', url: 'https://example.com/PRIVATE_ATTACHMENT' } }, undefined, /先解析为文本或图片/);
  rejected({ ...textDocument(Buffer.from('PRIVATE_ATTACHMENT')) }, undefined, /先解析为文本或图片/);
});

test('strict document and text schemas reject missing content instead of producing a filename placeholder', () => {
  for (const block of [null, [], {}, { ...textDocument('content'), unknown: 'PRIVATE_ATTACHMENT' },
    { ...textDocument('content'), title: 1 }, { ...textDocument('content'), context: {} },
    { type: 'document', title: 'name-only.txt' }, textDocument(null), textDocument(undefined),
    { type: 'document', source: { type: 'text', data: 'PRIVATE_ATTACHMENT' } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x', url: 'https://example.com' } },
    contentDocument([]), contentDocument(null), contentDocument(12), contentDocument(['plain string block']),
    contentDocument([{ type: 'text' }]), contentDocument([{ type: 'text', text: 'x', source: 'PRIVATE_ATTACHMENT' }]),
    contentDocument([{ type: 'document', source: textDocument('x').source }]),
  ]) rejected(block);
  rejected(textDocument('content'), { onCacheHint: 1 });
});

test('nested images retain image module validation and do not commit earlier document hints on failure', () => {
  let hints = 0;
  for (const child of [
    { type: 'image', source: { type: 'url', url: 'https://127.0.0.1/PRIVATE_ATTACHMENT.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_ATTACHMENT' } },
    { ...image, cache_control: { type: 'ephemeral', ttl: '24h' } },
  ]) rejected({ ...contentDocument([{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }, child]),
    cache_control: { type: 'ephemeral' } }, { onCacheHint: () => hints++ });
  assert.equal(hints, 0);
});

test('a document text budget applies across separate metadata/content parts without truncation', () => {
  const content = 'x'.repeat(MAX_DOCUMENT_TEXT_BYTES);
  assert.equal(documentParts(textDocument(content))[0].text.length, MAX_DOCUMENT_TEXT_BYTES);
  rejected({ ...textDocument(content), title: 'one more part' });
  rejected(contentDocument([{ type: 'text', text: content }, { type: 'text', text: '中' }]));
  assert.throws(() => documentParts(textDocument(null)), DocumentConversionError);
});
