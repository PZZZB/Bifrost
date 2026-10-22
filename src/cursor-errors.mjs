// SDK errors may contain prompts, URLs, paths or credentials. Only fixed
// public descriptions leave this module; upstream text is classification input.
export function describeCursorError(error) {
  const chain = [], seen = new Set();
  for (let value = error; value && typeof value === 'object' && chain.length < 4 && !seen.has(value); value = value.cause) {
    seen.add(value); chain.push(value);
  }
  const messages = chain.flatMap(value => typeof value.message === 'string' ? [value.message.slice(0, 8192)] : []).join('\n');
  const codes = chain.map(value => typeof value.code === 'string' ? value.code.toLowerCase().replaceAll('-', '_') : value.code);
  const status = chain.map(value => value.status).find(value => Number.isInteger(value) && value >= 400 && value <= 599);
  const named = name => chain.some(value => value.name === name);
  const result = (status, code, message) => ({ status, code, message });
  // An explicit SDK status takes precedence over incidental field names in
  // error text, such as an expired access token on a systemPrompt request.
  if (status === 401 || codes.some(code => code === 'unauthenticated' || code === 16) || named('AuthenticationError')) {
    return result(401, 'cursor_auth_rejected', 'Cursor 授权被拒绝或已失效，请重新进行 Cursor 官方授权。');
  }
  if (status === 429 || codes.some(code => ['resource_exhausted', 'rate_limit', 'rate_limit_exceeded'].includes(code) || code === 8) || named('RateLimitError')) {
    return result(429, 'cursor_rate_limited', 'Cursor 返回额度或请求频率限制，请查看 Cursor 用量及限制。');
  }
  if (status === 504 || codes.some(code => code === 'deadline_exceeded' || code === 4)) {
    return result(504, 'cursor_upstream_timeout', 'Cursor 上游请求超时，请稍后重试。');
  }
  if (status === 503 || codes.some(code => code === 'unavailable' || code === 14) || named('NetworkError')) {
    return result(status ?? 503, 'cursor_upstream_unavailable', 'Cursor 上游连接暂不可用，请稍后重试。');
  }
  const systemPrompt = /(?:\b(?:custom)?system[\s_-]?prompt\b|--system-prompt)/i.test(messages);
  const promptDenied = /unknown\s+(?:option|argument)|not[\s_-]+authori[sz]ed|permission[\s_-]*denied|access[\s_-]*denied|forbidden|(?:requires?|needs?)[^\n]{0,40}permission|not[\s_-]+(?:available|enabled|supported|open)[^\n]{0,40}(?:account|users?)/i.test(messages);
  if (systemPrompt && promptDenied) {
    return result(403, 'cursor_system_prompt_denied', 'Cursor 拒绝自定义 systemPrompt；当前严格接入需要这项权限，不能保留原指令级别后继续。');
  }
  if (status !== 403 && /unauthenticated|unauthorized|not[\s_-]+logged[\s_-]+in|invalid[\s_-]+(?:api[\s_-]*)?key|authentication[\s_-]+failed/i.test(messages)) {
    return result(401, 'cursor_auth_rejected', 'Cursor 授权被拒绝或已失效，请重新进行 Cursor 官方授权。');
  }
  if (status === 403 || codes.some(code => code === 'permission_denied' || code === 7)
    || /permission[\s_-]*denied|forbidden|not[\s_-]+authori[sz]ed/i.test(messages)) {
    return result(403, 'cursor_permission_denied', 'Cursor 拒绝当前操作，请检查账号、团队及模型访问权限。');
  }
  if (status === 400 || codes.some(code => code === 'invalid_argument' || code === 3) || named('ConfigurationError')) {
    return result(400, 'cursor_configuration_error', 'Cursor 拒绝当前 SDK 参数或模型配置，请检查本网关接入兼容性。');
  }
  return result(status ?? 502, 'cursor_sdk_error', 'Cursor SDK 调用失败，请检查模型权限或重新授权。');
}
