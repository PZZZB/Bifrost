import { BlockList, isIP } from 'node:net';

// Local gateway limits, not a claim about CodeBuddy's upstream image allowance.
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_URL_LENGTH = 8192;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
]) nonPublic.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export class ImageConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageConversionError';
    this.status = 400;
  }
}

function invalid(message) { throw new ImageConversionError(message); }
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) invalid('图片字段格式无效或含未支持字段。');
}

function validCacheHint(value) {
  if (value === undefined) return false;
  fields(value, ['type', 'ttl']);
  if (value.type !== 'ephemeral' || value.ttl !== undefined && !['5m', '1h'].includes(value.ttl)) {
    invalid('CodeBuddy 不支持此图片缓存提示。');
  }
  return true;
}

function matchesMediaType(bytes, mediaType) {
  if (mediaType === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mediaType === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'));
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

function base64Url(source, maxBytes) {
  fields(source, ['type', 'media_type', 'data']);
  if (!MEDIA_TYPES.has(source.media_type)) invalid('图片仅支持 JPEG、PNG、GIF、WebP。');
  const data = source.data;
  if (typeof data !== 'string' || !data.length) invalid('图片 base64 数据不能为空。');
  // Bound before decoding; Buffer.from alone accepts malformed and noncanonical base64.
  if (data.length > 4 * Math.ceil(maxBytes / 3)) invalid('图片超过网关单图大小限制。');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const core = padding ? data.slice(0, -padding) : data;
  if (data.length % 4 || !core.length || /[^A-Za-z0-9+/]/.test(core)) invalid('图片 base64 编码无效。');
  const decodedBytes = data.length / 4 * 3 - padding;
  if (!decodedBytes) invalid('图片数据不能为空。');
  if (decodedBytes > maxBytes) invalid('图片超过网关单图大小限制。');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length !== decodedBytes || bytes.toString('base64') !== data) invalid('图片 base64 编码无效。');
  if (!matchesMediaType(bytes, source.media_type)) invalid('图片内容与声明格式不匹配。');
  return `data:${source.media_type};base64,${data}`;
}

function publicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const version = isIP(host);
  if (version === 4) return !nonPublic.check(host, 'ipv4');
  // Only ordinary global unicast IPv6 literals are accepted; mapped/transition
  // addresses are not used to bypass the IPv4 restrictions.
  if (version === 6) return globalV6.check(host, 'ipv6') && !nonPublic.check(host, 'ipv6');
  if (!host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return !/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host);
}

function httpsUrl(source, maxLength) {
  fields(source, ['type', 'url']);
  const value = source.url;
  if (typeof value !== 'string' || !value || value.length > maxLength
    || !/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) invalid('图片 URL 必须为有效的公网 HTTPS 地址。');
  let url;
  try { url = new URL(value); } catch { invalid('图片 URL 无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !publicHost(url.hostname)
    || value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0].includes('@')) {
    invalid('图片 URL 不允许本机、私网、保留地址、非默认端口或账号密码。');
  }
  return url.href;
}

/** Pure Anthropic image -> Chat Completions content part. Never reads a file,
 * resolves DNS, downloads a URL, resizes an image, or promises a cache hit.
 * URL validation covers explicit literals and local names; upstream resolves DNS.
 * Schema: https://platform.claude.com/docs/en/build-with-claude/vision
 * Output: https://developers.openai.com/api/docs/guides/images-vision
 */
export function imagePart(block, { onCacheHint = () => {}, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxUrlLength = DEFAULT_MAX_IMAGE_URL_LENGTH } = {}) {
  if (typeof onCacheHint !== 'function' || !Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1
    || !Number.isSafeInteger(maxUrlLength) || maxUrlLength < 1) invalid('图片转换选项无效。');
  fields(block, ['type', 'source', 'cache_control']);
  if (block.type !== 'image') invalid('内容块必须为 image。');
  fields(block.source, ['type', 'media_type', 'data', 'url']);
  const hint = validCacheHint(block.cache_control);
  let url;
  if (block.source.type === 'base64') url = base64Url(block.source, maxImageBytes);
  else if (block.source.type === 'url') url = httpsUrl(block.source, maxUrlLength);
  else invalid('图片仅支持 base64 或公网 HTTPS URL，暂不支持文件引用。');
  if (hint) onCacheHint();
  return { type: 'image_url', image_url: { url } };
}
