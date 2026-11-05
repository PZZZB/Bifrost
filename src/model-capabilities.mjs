import { cursorEffortParameter, cursorImageCapability } from './cursor-service.mjs';
import { contextDeclaration } from './model-context.mjs';

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
const CHANNELS = new Set(['A', 'B', 'CodeBuddy', 'Cursor', 'Bifrost', 'Claude']);
const SOURCES = new Set(['remote', 'native-cache', 'account-catalog']);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flag = values => values.includes(false) ? false : values.includes(true) ? true : null;
const capability = (support, source, note, fields = {}) => ({ support, source, note, ...fields });
const modalities = value => Array.isArray(value) && value.length <= 8
  && value.every(item => ['text', 'image', 'audio', 'video'].includes(item)) ? value : null;

function compatibility(channel, promptMode) {
  if (channel === 'A' || channel === 'B') return { mode: 'passthrough', label: '原生协议转发',
    note: '使用原生 Codex 请求协议；账号和模型别名按所选路由处理。' };
  if (channel === 'CodeBuddy') return { mode: 'protocol-adapter', label: '协议适配',
    note: '转换 Responses、Messages 与 Chat 格式，工具由客户端执行；目录存在不代表已完成真实验证。' };
  if (channel === 'Bifrost') return { mode: 'protocol-adapter', label: '远端用户协议适配',
    note: '本地 Responses 转为远端用户接口；工具在客户端执行，权限和余额由远端 Bifrost 校验。' };
  if (channel === 'Claude') return { mode: 'protocol-adapter', label: '受管 Claude 接入',
    note: '通过当前节点配置的受管 Claude 接口调用；工具由客户端执行，上游登录在所属环境维护。' };
  if (channel === 'Cursor' && promptMode === 'project-rules') return { mode: promptMode, label: '项目规则兼容模式',
    note: '保留 Cursor 内置系统提示，Codex 指令通过隔离目录的项目规则读取，不保留原 system/developer 优先级。' };
  if (channel === 'Cursor' && promptMode === 'system') return { mode: promptMode, label: '系统指令模式',
    note: '使用 Cursor SDK systemPrompt；配置此模式不代表当前账号已获该参数权限。' };
  return { mode: 'unknown', label: '接入模式未确认', note: '尚未取得当前服务实际使用的接入模式。' };
}

/** Fixed schema only. No names, instructions, raw capability objects or errors escape. */
export function capabilitiesFromCatalog(value, { channel, promptMode } = {}) {
  const source = object(value) ? value : {}, native = channel === 'A' || channel === 'B';
  const origin = SOURCES.has(source.source) ? source.source : native ? 'native-catalog' : 'account-catalog';
  const nested = object(source.capabilities) ? source.capabilities : {};
  const legacy = channel === 'CodeBuddy' && source.id === 'claude-codebuddy-opus-5-5';
  const profileOrigin = legacy ? 'adapter-profile' : origin;
  const tools = native ? flag([source.supports_tools, source.supports_tool_calls])
    : flag([source.supportsToolCall, source.supportsTools, source.supportsToolCalls,
      nested.supportsTools, nested.supportsToolCalls, nested.tools, nested.toolCalls]);
  let images;
  if (channel === 'Cursor') images = cursorImageCapability(source);
  else {
    const input = modalities(native ? source.input_modalities : source.inputModalities);
    images = flag([native ? source.supports_images : source.supportsImages,
      source.disabledMultimodal === true ? false : undefined,
      input ? input.includes('image') : undefined]);
  }
  let efforts;
  if (native) efforts = Array.isArray(source.supported_reasoning_levels)
    ? source.supported_reasoning_levels.map(item => item?.effort) : [];
  else if (channel === 'Cursor') efforts = cursorEffortParameter(source)?.values.map(item => item.value) ?? [];
  else efforts = Array.isArray(source.efforts) ? source.efforts : [];
  efforts = [...new Set(efforts.filter(item => EFFORTS.has(item)))];
  const reasoningFlags = native ? [source.supports_reasoning]
    : [source.supportsReasoning, nested.supportsReasoning, nested.reasoning];
  const reasoning = flag([...reasoningFlags, efforts.length ? true : undefined]);
  if (reasoning === false) efforts = [];
  const preferred = native ? source.default_reasoning_level : channel === 'Cursor'
    ? source.variants?.find(item => item?.isDefault === true)?.params?.find(item => item?.id === cursorEffortParameter(source)?.id)?.value
    : source.defaultEffort;
  const context = contextDeclaration(source, { native }), tokens = context.tokens;
  const mode = compatibility(CHANNELS.has(channel) ? channel : null, promptMode);
  const declared = (support, label, origin = profileOrigin) => capability(support, support === null ? 'unknown' : origin,
    support === null ? `目录未明确返回${label}能力。` : legacy && origin === 'adapter-profile'
      ? `现有网关适配配置声明${label}；当前账号仍需真实验证。` : `来自目录的明确${label}声明；不等同于真实调用验证。`);
  return {
    capabilities: {
      tools: channel === 'Claude' && tools === null ? capability(null, 'bridge-configuration',
        '适配器已支持客户端工具调用和结果回传；当前模型是否完成工具回合另看实测记录。', { adapterSupport: true }) : declared(tools, '工具调用', origin),
      images: channel === 'Claude' && images === null ? capability(null, 'bridge-configuration',
        '适配器已支持图片输入；当前模型的图片识别效果仍需真实请求验证。', { adapterSupport: true }) : declared(images, '图片输入'),
      reasoning: { ...declared(reasoning, '思考'), efforts, defaultEffort: efforts.includes(preferred) ? preferred : null },
      contextWindow: capability(positive(tokens) ? true : null, positive(tokens) ? channel === 'Claude' && source.contextSource === 'official-cli-runtime' ? 'official-cli-runtime' : origin : 'unknown',
        positive(tokens) ? channel === 'Claude' && source.contextSource === 'official-cli-runtime'
          ? '官方 CLI 对当前所选模型返回的上下文上限；未进行满窗口压力测试，客户端实际预算可能更小。'
          : '目录声明的上下文长度；客户端实际保留预算可能更小。' : '目录未明确返回可验证的上下文长度。',
        context),
      cache: capability(null, channel === 'Claude' ? 'response-usage' : 'unknown', channel === 'CodeBuddy'
        ? '缓存提示不能保证保真转换；实际缓存命中仅以服务商返回的用量为准。'
        : '目录不能证明本次缓存是否生效；仅以服务商返回的实际用量为准。'),
      promptMode: capability(mode.mode === 'unknown' ? null : true,
        mode.mode === 'unknown' ? 'unknown' : 'bridge-configuration', mode.note, { mode: mode.mode }),
    },
    compatibility: mode,
  };
}

/** Bare seed names and client aliases must not erase source capability metadata. */
export function hasCatalogCapabilityData(source, { channel } = {}) {
  if (!object(source)) return false;
  if (channel === 'Claude') return true;
  if (channel === 'CodeBuddy' || channel === 'Cursor' || channel === 'Bifrost' || channel === 'Claude') return ['supportsToolCall', 'supportsTools', 'supportsToolCalls',
    'supportsImages', 'supportsVision', 'supportsImageInput', 'supportsReasoning', 'inputModalities', 'contextWindow',
    'efforts', 'defaultEffort', 'parameters', 'variants', 'capabilities'].some(field => Object.hasOwn(source, field));
  return ['context_window', 'input_modalities', 'supported_reasoning_levels', 'supports_tools', 'supports_tool_calls',
    'supports_images', 'supports_reasoning', 'model_messages', 'shell_type', 'supported_in_api', 'visibility', 'priority']
    .some(field => Object.hasOwn(source, field));
}

export function unverifiedModel(reason = '当前账号尚无本网关记录的完整成功调用。') {
  return { state: 'unverified', checkedAt: null, source: 'none', reason };
}

const FAILURE_NOTES = Object.freeze({ network: '最近一次调用遇到网络错误，未据此改变模型能力。',
  timeout: '最近一次调用超时，未据此改变模型能力。', authentication: '最近一次调用认证失败，未据此改变模型能力。',
  permission: '最近一次调用被拒绝，未据此改变模型能力。', quota: '最近一次调用遇到额度或限流问题，未据此改变模型能力。',
  capability: '最近一次调用的参数或功能被拒绝，尚不据此修改目录能力。', protocol: '最近一次调用未完成协议处理，未据此改变模型能力。',
  cancelled: '最近一次调用已取消，未据此改变模型能力。', unknown: '最近一次真实调用失败，未据此改变模型能力。' });

/** Callers must attest terminal completion; a tool call awaiting results is not a pass. */
export function verificationFromRecord(record) {
  if (!object(record) || !['passed', 'failed'].includes(record.outcome)) return null;
  if (record.outcome === 'passed' && (record.completed !== true || record.pendingTools === true)) return null;
  const time = record.time ?? record.checkedAt;
  if (!(typeof time === 'string' && time.length <= 64 || typeof time === 'number' && Number.isFinite(time))) return null;
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return null;
  const category = Object.hasOwn(FAILURE_NOTES, record.category) ? record.category : 'unknown';
  return { state: record.outcome, checkedAt: date.toISOString(), source: 'gateway-observed-call',
    reason: record.outcome === 'passed' ? '记录到当前账号的完整成功调用；不代表所有功能均已验证。' : FAILURE_NOTES[category],
    ...(record.outcome === 'failed' ? { category } : {}),
    ...(record.outcome === 'passed' && object(record.observed) ? { observed: {
      images: record.observed.images === true, tools: record.kind === 'tool', cache: record.observed.cache === true } } : {}),
    ...(['plain', 'tool'].includes(record.kind) ? { kind: record.kind } : {}) };
}
