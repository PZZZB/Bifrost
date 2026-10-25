import { BridgeError } from './storage.mjs';

export function clientScope(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)) {
    throw new BridgeError('接入用户会话范围无效。', 400, 'client_scope_invalid');
  }
  return value;
}
