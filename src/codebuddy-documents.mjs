import { imagePart } from './codebuddy-images.mjs';

export const MAX_DOCUMENT_TEXT_BYTES = 32 * 1024 * 1024;
const PARSE_FIRST = '此附件格式暂不能保真转换，请先解析为文本或图片后发送。';

export class DocumentConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentConversionError';
    this.status = 400;
  }
}

function invalid(message) { throw new DocumentConversionError(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    invalid('文档字段格式无效或含未支持字段。');
  }
}

function validCacheHint(value) {
  if (value === undefined) return false;
  fields(value, ['type', 'ttl']);
  if (value.type !== 'ephemeral' || value.ttl !== undefined && !['5m', '1h'].includes(value.ttl)) {
    invalid('CodeBuddy 不支持此文档缓存提示。');
  }
  return true;
}

/** Convert an already-extracted attachment without reading files, fetching URLs,
 * decoding document binaries, fabricating citations, or replacing its content.
 * The parent provider retains responsibility for total request/image limits.
 */
export function documentParts(block, { onCacheHint = () => {} } = {}) {
  if (typeof onCacheHint !== 'function') invalid('文档转换选项无效。');
  fields(block, ['type', 'source', 'title', 'context', 'citations', 'cache_control']);
  if (block.type !== 'document') invalid(PARSE_FIRST);
  if (block.citations !== undefined && block.citations !== null) {
    fields(block.citations, ['enabled']);
    if (block.citations.enabled === true) invalid('CodeBuddy 当前不能保留文档引文语义，请关闭 citations 后发送。');
    if (block.citations.enabled !== undefined && block.citations.enabled !== false) invalid('文档 citations.enabled 必须是布尔值。');
  }

  let hints = validCacheHint(block.cache_control) ? 1 : 0;
  let textBytes = 0;
  const parts = [];
  function addText(value, prefix = '', suffix = '') {
    if (typeof value !== 'string') invalid('文档文本必须为字符串，请先解析为文本或图片后发送。');
    const text = prefix + value + suffix;
    textBytes += Buffer.byteLength(text, 'utf8');
    if (textBytes > MAX_DOCUMENT_TEXT_BYTES) invalid('文档文本超过网关单份附件大小限制。');
    parts.push({ type: 'text', text });
  }
  if (block.title !== undefined && block.title !== null) addText(block.title, '[Document title]\n', '\n');
  if (block.context !== undefined && block.context !== null) addText(block.context, '[Document context]\n', '\n');
  if (parts.length) addText('', '[Document content]\n');

  const source = block.source;
  if (!object(source)) invalid(PARSE_FIRST);
  if (source.type === 'text') {
    fields(source, ['type', 'media_type', 'data']);
    if (source.media_type !== 'text/plain') invalid(PARSE_FIRST);
    addText(source.data);
  } else if (source.type === 'content') {
    fields(source, ['type', 'content']);
    if (typeof source.content === 'string') addText(source.content);
    else if (Array.isArray(source.content) && source.content.length) {
      for (const child of source.content) {
        if (!object(child)) invalid(PARSE_FIRST);
        if (child.type === 'text') {
          fields(child, ['type', 'text', 'cache_control']);
          if (validCacheHint(child.cache_control)) hints++;
          addText(child.text);
        } else if (child.type === 'image') {
          parts.push(imagePart(child, { onCacheHint: () => { hints++; } }));
        } else invalid(PARSE_FIRST);
      }
    } else invalid('文档 content 必须为文本或非空的文本、图片内容块数组，请先解析附件后发送。');
  } else invalid(PARSE_FIRST);

  // Do not commit any hint count when a later content block fails validation.
  for (let index = 0; index < hints; index++) onCacheHint();
  return parts;
}
