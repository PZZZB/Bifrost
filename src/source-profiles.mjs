const PROTOCOLS = Object.freeze([
  ['responses', 'Responses'], ['chat-completions', 'Chat Completions'], ['messages', 'Messages'],
]);
const MODE_LABELS = Object.freeze({ passthrough: '原生协议转发', adapted: '协议适配', cli: 'CLI 会话适配',
  unsupported: '尚未接入', unknown: '转发方式未确认' });

/** Public source capabilities describe a route, never an exported credential. */
export function sourceCredential(kind) {
  if (kind === 'codex-client') return { mode: 'caller', label: '当前调用者认证', reusable: false,
    description: '随本次请求使用调用者的 OpenAI 登录认证；网关不保存可供其他客户端复用的此账号授权。' };
  if (kind === 'bifrost') return { mode: 'remote-key', label: '独立远端用户 Key', reusable: true,
    description: '使用本网关已登记的远端用户授权；客户端仍受本网关和远端的模型权限约束。' };
  return { mode: 'managed', label: '网关独立授权', reusable: true,
    description: '由所属账号适配器保存并维护独立授权；调用者使用获准的网关入口，不接触上游凭证。' };
}

function routeDefinition(row, protocol, metadata) {
  const { kind } = row;
  if (kind === 'codex-client') return protocol === 'responses' ? { mode: 'passthrough', upstreamProtocol: 'responses',
    description: '保留调用者的模型请求正文及 OpenAI 认证，清理网关专用和连接相关请求头后转发。' } : null;
  if (kind === 'codex') return protocol === 'responses' ? { mode: 'passthrough', upstreamProtocol: 'responses',
    description: '保持 Codex 消息、工具和流式响应格式，替换为本账号认证并还原模型别名。' }
    : protocol === 'chat-completions' ? { mode: 'adapted', upstreamProtocol: 'responses',
      description: '将 Chat Completions 请求转换为 Responses，并将文本、工具调用和流式事件转换回入口格式。' } : null;
  if (kind === 'codebuddy') return { mode: 'adapted', upstreamProtocol: 'chat-completions',
    description: protocol === 'messages' ? '将 Messages 消息、工具及流式事件映射到上游 Chat Completions，响应反向转换。'
      : protocol === 'responses' ? '经通用 Messages 表示映射到上游 Chat Completions，响应转换回 Responses。'
        : 'Chat Completions 入口复用现有通用适配层调用上游；工具、思考与流式事件按能力映射。' };
  if (kind === 'cursor') return protocol === 'messages' ? null : { mode: 'adapted', upstreamProtocol: 'cursor-sdk',
    description: '将入口消息和工具调用适配到 Cursor SDK，再将会话事件转换回入口协议。' };
  if (kind === 'bifrost') {
    // Server remotes enter through Responses; their own API may accept Messages.
    const protocols = row.binding.protocols;
    if (protocol === 'messages' || !protocols.some(p => ['responses', 'messages'].includes(p))) return null;
    if (protocols.includes('responses') && protocols.includes('messages')) return {
      mode: protocol === 'responses' ? 'unknown' : 'adapted', upstreamProtocol: null,
      description: protocol === 'responses'
        ? '本节点按所选模型的实际目录选择远端 Responses 或 Messages 适配；账号允许的协议范围不能证明每个模型的实际路径。'
        : '先将 Chat Completions 转为 Responses，再按所选模型的实际目录选择远端 Responses 或 Messages 适配。',
    };
    const upstreamProtocol = protocols.includes('responses') ? 'responses' : 'messages';
    return { mode: protocol === upstreamProtocol ? 'passthrough' : 'adapted', upstreamProtocol,
      description: upstreamProtocol === 'responses' && protocol === 'responses'
        ? '调用远端 Responses 接口；远端内部的模型连接与适配方式由远端管理。'
        : `将入口协议适配为远端 ${upstreamProtocol === 'messages' ? 'Messages' : 'Responses'}；远端内部适配方式由远端管理。` };
  }
  // Managed deployments declare their actual loaded entry points. A provider
  // name alone must not imply that this node exposes every protocol.
  if (!Array.isArray(metadata.supportedProtocols) || !metadata.supportedProtocols.includes(protocol)) return null;
  if (kind === 'claude') {
    if (['claude-cli', 'official-claude-sdk'].includes(metadata.transport)) return { mode: 'cli', upstreamProtocol: 'claude-cli',
      description: protocol === 'messages' ? '将 Messages 请求接入独立 Claude CLI 会话，并映射工具和流式事件。'
        : '先将入口请求转换为 Messages，再接入独立 Claude CLI 会话；响应反向适配。' };
    if (metadata.transport === 'anthropic-messages') return { mode: protocol === 'messages' ? 'passthrough' : 'adapted',
      upstreamProtocol: 'messages', description: protocol === 'messages' ? '调用已配置的 Messages 上游，身份由该来源独立维护。'
        : '将入口请求和响应映射到已配置的 Messages 上游。' };
  }
  return { mode: 'unknown', upstreamProtocol: null, description: '入口已由所属环境声明；具体上游协议和适配方式尚未返回。' };
}

export function sourceRoutes(row, { metadata = {}, usable = false, capabilities = {} } = {}) {
  if (!metadata || typeof metadata !== 'object') metadata = {};
  const credential = sourceCredential(row.kind);
  const publicEntryReady = Object.hasOwn(capabilities, 'userInferenceReady')
    ? capabilities.userInferenceReady === true : capabilities.userManagement === true;
  const ownerEntryReady = capabilities.ownerChatReady === true && ['codex', 'codebuddy', 'cursor', 'bifrost'].includes(row.kind);
  return PROTOCOLS.map(([protocol, label]) => {
    const definition = routeDefinition(row, protocol, metadata), supported = Boolean(definition);
    const entryEnabled = protocol === 'responses' ? capabilities.clientIntegration === true || row.kind !== 'codex-client' && publicEntryReady
      : protocol === 'chat-completions' ? publicEntryReady || ownerEntryReady
        : publicEntryReady || metadata.messageEntryAvailable === true;
    return { protocol, label, supported, available: supported && row.enabled && usable && entryEnabled,
      mode: definition?.mode ?? 'unsupported', modeLabel: MODE_LABELS[definition?.mode ?? 'unsupported'],
      upstreamProtocol: definition?.upstreamProtocol ?? null,
      description: definition?.description ?? (row.kind === 'codex-client'
        ? '当前调用者透传来源只接收携带 OpenAI 登录认证的原生 Responses 请求。'
        : '当前节点未为此来源接入该入口协议。'),
      credentialRequirement: credential.mode === 'caller' ? 'caller-openai' : 'gateway-key',
      reason: !supported ? '当前节点未接入此路径。' : !row.enabled ? '来源已停用。'
        : !entryEnabled ? '当前节点尚未启用此协议入口。'
          : !usable ? '来源尚未就绪；协议已实现不代表当前可以调用。' : null,
      verification: 'not_verified' };
  });
}
