// Only finite, documented error categories cross the source boundary. Provider
// text, SDK result strings and diagnostic addresses are never copied.
const ERRORS = new Map([
  ['claude_authentication_failed', [401, 'Claude 来源认证失败，请检查该来源的登录状态。']],
  ['claude_oauth_org_not_allowed', [403, 'Claude 来源的订阅工作区不允许此次访问。']],
  ['claude_account_on_hold', [403, 'Claude 来源账号处于暂停状态。']],
  ['claude_verification_required', [403, 'Claude 来源账号需要完成验证。']],
  ['claude_billing_error', [402, 'Claude 来源报告计费错误，请检查该来源的订阅或账单状态。']],
  ['claude_rate_limited', [429, 'Claude 来源返回用量或速率限制，请查看该来源的官方用量。']],
  ['claude_overloaded', [503, 'Claude 来源当前繁忙，暂时无法完成请求。']],
  ['claude_invalid_request', [400, 'Claude 来源拒绝了请求参数，未提供更具体的安全错误类别。']],
  ['claude_model_not_found', [404, 'Claude 来源无法使用所选模型。']],
  ['claude_server_error', [502, 'Claude 来源返回服务端错误。']],
  ['claude_source_unknown', [502, 'Claude 来源报告未识别的错误，未取得更具体的安全错误类别。']],
  ['claude_upstream_error', [502, 'Claude 来源返回错误，未取得可安全公开的具体原因。']],
  ['claude_network_error', [503, '连接 Claude 来源时发生网络错误或超时。']],
  ['claude_request_interrupted', [499, 'Claude 请求已取消或中断。']],
  ['claude_output_limit', [400, 'Claude 来源报告输出 Token 达到限制。']],
  ['claude_cloud_credential_error', [401, 'Claude 来源的云凭证认证失败。']],
  ['claude_permission_denied', [403, 'Claude 来源拒绝了此次访问权限。']],
  ['claude_not_found', [404, 'Claude 来源未提供所请求的资源。']],
  ['claude_request_too_large', [413, 'Claude 来源拒绝了过大的请求。']],
  ['claude_execution_failed', [502, 'Claude CLI 执行失败，未取得更具体的安全错误类别。']],
  ['claude_turn_limit', [400, 'Claude CLI 已达到本次运行设置的轮数上限。']],
  ['claude_budget_limit', [402, 'Claude CLI 已达到本次运行设置的费用上限。']],
  ['claude_output_schema_failed', [502, 'Claude CLI 已达到结构化输出重试上限。']],
  ['claude_tool_session_missing', [409, 'CLI 等待的工具会话已中断或不存在，无法接收这次工具结果。请检查此前的来源错误。']],
  ['claude_tool_session_mismatch', [409, 'CLI 工具结果与等待中的会话不匹配，请求未被继续执行。']],
  ['claude_session_busy', [409, 'CLI 会话正在处理请求，请等待当前请求结束。']],
]);

// SDKAssistantMessageError and SDKResultError from pinned SDK 0.3.304.
const ASSISTANT = new Map([
  ['authentication_failed', 'claude_authentication_failed'], ['oauth_org_not_allowed', 'claude_oauth_org_not_allowed'],
  ['account_on_hold', 'claude_account_on_hold'], ['verification_required', 'claude_verification_required'],
  ['billing_error', 'claude_billing_error'], ['rate_limit', 'claude_rate_limited'], ['overloaded', 'claude_overloaded'],
  ['invalid_request', 'claude_invalid_request'], ['model_not_found', 'claude_model_not_found'],
  ['server_error', 'claude_server_error'], ['unknown', 'claude_source_unknown'],
  ['max_output_tokens', 'claude_output_limit'], ['cloud_credential_error', 'claude_cloud_credential_error'],
]);
const RESULTS = new Map([
  ['error_during_execution', 'claude_execution_failed'], ['error_max_turns', 'claude_turn_limit'],
  ['error_max_budget_usd', 'claude_budget_limit'], ['error_max_structured_output_retries', 'claude_output_schema_failed'],
]);
const MESSAGES = new Map([
  ['authentication_error', 'claude_authentication_failed'], ['permission_error', 'claude_permission_denied'],
  ['rate_limit_error', 'claude_rate_limited'], ['overloaded_error', 'claude_overloaded'],
  ['invalid_request_error', 'claude_invalid_request'], ['not_found_error', 'claude_not_found'],
  ['request_too_large', 'claude_request_too_large'], ['api_error', 'claude_server_error'],
]);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const HTTP_STATUS = new Map([[400, 'claude_invalid_request'], [401, 'claude_authentication_failed'],
  [402, 'claude_billing_error'], [403, 'claude_permission_denied'], [404, 'claude_not_found'],
  [408, 'claude_network_error'], [413, 'claude_request_too_large'], [429, 'claude_rate_limited'],
  [500, 'claude_server_error'], [502, 'claude_server_error'], [503, 'claude_upstream_error'],
  [504, 'claude_network_error'], [529, 'claude_overloaded']]);

export function claudeSourceError(code) {
  const definition = typeof code === 'string' ? ERRORS.get(code) : null;
  return definition ? { code, status: definition[0], message: definition[1] } : null;
}

export function classifyClaudeSourceError(packet) {
  if (packet?.type === 'assistant') return claudeSourceError(ASSISTANT.get(packet.error));
  if (packet?.type === 'result' && (packet.is_error || packet.subtype !== 'success')) {
    return claudeSourceError(RESULTS.get(packet.subtype) ?? (packet.subtype === 'success' && packet.is_error ? 'claude_execution_failed' : null));
  }
  if (packet?.type === 'error') return claudeSourceError(packet.error?.code) ?? claudeSourceError(MESSAGES.get(packet.error?.type));
  return null;
}

export function classifyClaudeSourceException(error) {
  try {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return claudeSourceError('claude_request_interrupted');
    const explicit = claudeSourceError(error.code) ?? claudeSourceError(ASSISTANT.get(error.code) ?? ASSISTANT.get(error.type)
      ?? RESULTS.get(error.code) ?? RESULTS.get(error.type) ?? MESSAGES.get(error.type));
    if (explicit) return explicit;
    if (NETWORK_CODES.has(error.code) || NETWORK_CODES.has(error.cause?.code)) return claudeSourceError('claude_network_error');
    return typeof error.status === 'number' ? claudeSourceError(HTTP_STATUS.get(error.status)) : null;
  } catch { return null; }
}

/** Read one small error response, never arbitrary provider text or an unbounded body. */
export async function readClaudeSourceError(response, { signal } = {}) {
  const maximum = 8192;
  const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* Already consumed. */ } };
  if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    cancel(response.body); return null;
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { cancel(response.body); return null; }
  const reader = response.body.getReader(), guard = AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]);
  const abort = () => cancel(reader);
  guard.addEventListener('abort', abort, { once: true });
  try {
    if (guard.aborted) return null;
    const chunks = []; let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (guard.aborted) return null;
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) return null;
      chunks.push(next.value);
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const source = claudeSourceError(data?.error?.code);
    return source?.status === response.status ? source : null;
  } catch { return null; }
  finally { guard.removeEventListener('abort', abort); cancel(reader); try { reader.releaseLock(); } catch { /* Read cancellation is pending. */ } }
}
