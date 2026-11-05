// Only bridge-defined categories cross the protocol boundary. Never copy the
// provider's error text, which can contain prompts, credentials, or addresses.
const ERRORS = new Map([
  ['codebuddy_upstream_failed', [502, 'CodeBuddy 上游在生成途中返回了错误。']],
  ['codebuddy_upstream_connection_error', [502, 'CodeBuddy 上游连接在响应完成前中断。']],
  ['codebuddy_upstream_truncated', [502, 'CodeBuddy 上游响应缺少完整结束标记。']],
  ['codebuddy_unsupported_delta', [502, 'CodeBuddy 返回了尚未适配的内容增量类型。']],
  ['codebuddy_unsupported_finish', [502, 'CodeBuddy 返回了尚未适配的结束原因。']],
  ['codebuddy_upstream_protocol_error', [502, 'CodeBuddy 上游响应未通过协议完整性检查。']],
  ['codebuddy_request_interrupted', [499, 'CodeBuddy 请求已取消或中断。']],
]);

export function codeBuddySourceError(code) {
  const value = typeof code === 'string' ? ERRORS.get(code) : null;
  return value ? { code, status: value[0], message: value[1] } : null;
}
