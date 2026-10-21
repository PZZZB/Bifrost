const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_TEXT = 32 * 1024 * 1024;
export const CODEBUDDY_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

export class ThinkingConversionError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
function fail(message) { throw new ThinkingConversionError(message); }
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('思考参数格式无效。');
}

/** CodeBuddy exposes effort and readable summaries, not Anthropic token budgets. */
export function thinkingOptions({ thinking, output_config: outputConfig } = {}) {
  let effort = 'high';
  if (outputConfig !== undefined) {
    keys(outputConfig, ['effort']);
    if (outputConfig.effort !== undefined) {
      if (!CODEBUDDY_EFFORTS.includes(outputConfig.effort)) {
        fail('CodeBuddy 当前支持 low、medium、high、xhigh 思考强度，不提供 max 的等价映射。');
      }
      effort = outputConfig.effort;
    }
  }
  let display = 'omitted';
  if (thinking !== undefined) {
    if (!object(thinking)) fail('thinking 必须是对象。');
    if (thinking.type === 'enabled' || Object.hasOwn(thinking, 'budget_tokens')) {
      fail('CodeBuddy Opus 5.5 使用自适应思考，不提供精确 budget_tokens。请使用 thinking.type=adaptive 和 output_config.effort。');
    }
    if (thinking.type === 'disabled') {
      fail('CodeBuddy Opus 5.5 始终启用思考；可用 thinking.display=omitted 隐藏摘要，不能关闭内部思考。');
    }
    keys(thinking, ['type', 'display']);
    if (thinking.type !== 'adaptive' || thinking.display !== undefined && !['summarized', 'omitted'].includes(thinking.display)) {
      fail('当前支持 thinking.type=adaptive，display 为 summarized 或 omitted。');
    }
    display = thinking.display ?? 'omitted';
  }
  return { body: { reasoning_effort: effort, reasoning_summary: 'auto' }, visible: display === 'summarized',
    mode: 'adaptive', display };
}

/** Empty signatures denote this bridge's readable Chat-compatible summaries. */
export function thinkingText(block) {
  keys(block, ['type', 'thinking', 'signature']);
  if (block.type !== 'thinking' || typeof block.thinking !== 'string' || block.thinking.length > MAX_TEXT) {
    fail('思考历史格式无效。');
  }
  if (block.signature !== undefined && block.signature !== '') {
    fail('CodeBuddy Chat 接口不能保真传递原生 Anthropic 思考签名；请使用本网关生成的空签名摘要历史。');
  }
  return block.thinking;
}
