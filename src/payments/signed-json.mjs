import { paymentError } from './topups.mjs';

/** Preserve the original signed JSON bytes; reject duplicate envelope keys so
 * a second unsigned response cannot shadow the verified object after parsing. */
export function signedJsonEnvelope(raw, responseKey) {
  const invalid = () => { throw paymentError('payment_verification_failed', 400); };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return invalid();
  const values = new Map(); let index = 1;
  raw = raw.trim();
  const whitespace = () => { while (/\s/.test(raw[index] ?? '') && index < raw.length) index++; };
  while (true) {
    whitespace(); if (raw[index] === '}') break;
    if (raw[index] !== '"') return invalid();
    const startKey = index++; let escaped = false;
    while (index < raw.length) {
      const char = raw[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const key = JSON.parse(raw.slice(startKey, index));
    if (values.has(key)) return invalid();
    whitespace(); if (raw[index++] !== ':') return invalid(); whitespace();
    const start = index; let depth = 0, quoted = false; escaped = false;
    while (index < raw.length) {
      const char = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === ',' && depth === 0 || char === '}' && depth === 0) break;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') depth--;
      index++;
    }
    values.set(key, raw.slice(start, index).trim());
    whitespace(); if (raw[index] === '}') break;
    if (raw[index++] !== ',') return invalid();
  }
  if (values.size !== 2 || !values.has(responseKey) || !values.has('sign') || typeof parsed.sign !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.sign) || parsed.sign.length > 1024
    || !parsed[responseKey] || typeof parsed[responseKey] !== 'object' || Array.isArray(parsed[responseKey])) return invalid();
  return { data: parsed[responseKey], signed: values.get(responseKey), signature: parsed.sign };
}
