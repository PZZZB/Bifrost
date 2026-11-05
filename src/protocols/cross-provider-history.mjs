import { BridgeError } from '../storage.mjs';
import { CODEBUDDY_RESPONSES_STATE_PREFIX } from '../codebuddy-responses.mjs';
import { CODEBUDDY_COMPACTION_STATE_PREFIX } from '../codebuddy-thinking-state.mjs';
import { CURSOR_RESPONSES_STATE_PREFIX } from '../cursor-responses.mjs';
import { REMOTE_RESPONSES_STATE_PREFIX } from './remote-state.mjs';

const LIMIT = 64 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const native = target => target === 'A' || target === 'B';
const prefixes = [
  ['CodeBuddy', CODEBUDDY_RESPONSES_STATE_PREFIX],
  ['Cursor', CURSOR_RESPONSES_STATE_PREFIX],
  ['Bifrost', REMOTE_RESPONSES_STATE_PREFIX],
  ['Bifrost', 'bifrost-messages-compaction-v1:'],
];
const compactionPrefixes = [CODEBUDDY_COMPACTION_STATE_PREFIX, 'bifrost-messages-compaction-v1:'];
const owner = value => prefixes.find(([, prefix]) => value.startsWith(prefix))?.[0]
  ?? (value.startsWith('bifrost-') ? 'UnknownBridge' : 'OpenAI');
const mismatch = source => `${source === 'CodeBuddy' ? 'codebuddy' : source === 'Cursor' ? 'cursor' : source === 'Bifrost' ? 'remote' : 'provider'}_history_channel_mismatch`;
const invalid = () => { throw new BridgeError('历史中包含无法完整转交的接续条目，请先用原模型生成明文交接摘要。', 400, 'cross_provider_history_unsupported'); };
const aborted = signal => { if (signal?.aborted) throw new BridgeError('模型请求已取消。', 499, 'request_cancelled'); };

function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function summaryText(item) {
  fields(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status', 'internal_chat_message_metadata_passthrough']);
  if (item.status != null && item.status !== 'completed') invalid();
  // A foreign model's opaque continuation is optional bookkeeping. Readable
  // summaries are actual history and must survive; unknown content must fail.
  if (item.content != null && (!Array.isArray(item.content) || item.content.length)) invalid();
  if (item.summary == null) return '';
  if (!Array.isArray(item.summary)) invalid();
  const text = item.summary.map(part => {
    fields(part, ['type', 'text']);
    if (part.type !== 'summary_text' || typeof part.text !== 'string') invalid();
    return part.text;
  }).join('\n');
  if (Buffer.byteLength(text, 'utf8') > LIMIT) invalid();
  return text;
}
function readableSummary(text) {
  return { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text',
    text: `[Bifrost prior-model reasoning summary]\n${text}\n[/Bifrost prior-model reasoning summary]` }] };
}
function conversationSummary(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > LIMIT) invalid();
  return { type: 'message', role: 'user', content: [{ type: 'input_text',
    text: `[Bifrost conversation summary]\n${text}\n[/Bifrost conversation summary]` }] };
}
function hasPlainPayload(item) {
  if (item.type === 'message' || item.type === undefined) {
    return typeof item.content === 'string' && item.content.length > 0 || Array.isArray(item.content) && item.content.length > 0;
  }
  if (item.type === 'custom_tool_call') return typeof item.input === 'string';
  if (item.type === 'tool_search_call' && object(item.arguments)) return true;
  if (item.type === 'function_call' || item.type === 'tool_search_call') {
    try { return typeof item.arguments === 'string' && object(JSON.parse(item.arguments)); } catch { return false; }
  }
  return ['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(item.type)
    && (typeof item.output === 'string' || Array.isArray(item.output));
}

/** Derive a destination request without mutating the client's durable history. */
export async function adaptCrossProviderHistory(body, { target, clientScope = null, session = '', fork = null, signal,
  openCodeBuddyCompaction = null, inspectRemoteState = null, openRemoteCompaction = null } = {}) {
  if (!['A', 'B', 'CodeBuddy', 'Cursor', 'Bifrost'].includes(target)) throw new TypeError('Invalid history destination.');
  aborted(signal);
  if (!Array.isArray(body?.input)) return { body, changed: false };
  // A Cursor live handle describes an exact SDK prefix. It cannot anchor a
  // history that also contains another provider's continuations.
  const mixedCursorHistory = target === 'Cursor' && body.input.some(item =>
    typeof item?.encrypted_content === 'string' && (item.type === 'reasoning' && owner(item.encrypted_content) !== 'Cursor'
      || ['compaction', 'context_compaction'].includes(item.type) && owner(item.encrypted_content) !== 'Cursor'));
  let changed = false, removedSource = null;
  const input = [];
  for (const item of body.input) {
    aborted(signal);
    if (!object(item)) { input.push(item); continue; }
    const encrypted = item.encrypted_content;
    if (['compaction', 'context_compaction'].includes(item.type) && typeof encrypted === 'string') {
      if (encrypted.startsWith(CODEBUDDY_COMPACTION_STATE_PREFIX)) {
        if (target === 'CodeBuddy') { input.push(item); continue; }
        fields(item, ['type', 'id', 'encrypted_content', 'status', 'internal_chat_message_metadata_passthrough']);
        if (item.status != null && item.status !== 'completed') invalid();
        if (typeof openCodeBuddyCompaction !== 'function') throw new BridgeError('CodeBuddy 压缩摘要暂不能转交，请先恢复对应账号授权。', 409, 'history_compaction_unavailable');
        const summary = await openCodeBuddyCompaction(encrypted, { clientScope, signal });
        aborted(signal); input.push(conversationSummary(summary)); changed = true; continue;
      }
      if (encrypted.startsWith(REMOTE_RESPONSES_STATE_PREFIX)) {
        if (typeof inspectRemoteState !== 'function') throw new BridgeError('远端来源尚不能验证此历史摘要，请先使用原模型恢复。', 409, 'history_compaction_unavailable');
        const info = await inspectRemoteState(encrypted, { clientScope, session, fork, signal, kind: item.type,
          model: target === 'Bifrost' ? body.model : null });
        aborted(signal);
        if (target === 'Bifrost' && info?.model === body.model) { input.push(item); continue; }
        fields(item, ['type', 'id', 'encrypted_content', 'status', 'internal_chat_message_metadata_passthrough']);
        if (item.status != null && item.status !== 'completed') invalid();
        if (typeof openRemoteCompaction !== 'function') throw new BridgeError('远端来源暂不能恢复此历史摘要，请先使用原模型恢复。', 409, 'history_compaction_unavailable');
        const summary = await openRemoteCompaction(encrypted, { clientScope, session, fork, signal, kind: item.type,
          model: target === 'Bifrost' ? body.model : null });
        aborted(signal); input.push(conversationSummary(summary)); changed = true; continue;
      }
      // Compaction is the only remaining source of prior conversation state.
      // Never strip an opaque checkpoint simply to make a request acceptable.
      const source = owner(encrypted);
      if (source === 'OpenAI' && native(target) || source === target) { input.push(item); continue; }
      throw new BridgeError('此会话包含当前模型无法解封的压缩历史，请先用原模型生成明文交接摘要。', 400, 'history_compaction_unavailable');
    }
    if (item.type === 'reasoning') {
      if (encrypted != null && typeof encrypted !== 'string') invalid();
      if (typeof encrypted === 'string' && compactionPrefixes.some(prefix => encrypted.startsWith(prefix))) invalid();
      const source = typeof encrypted === 'string' ? owner(encrypted) : 'OpenAI';
      let remoteMatches = true;
      if (source === 'Bifrost' && encrypted.startsWith(REMOTE_RESPONSES_STATE_PREFIX)) {
        if (typeof inspectRemoteState !== 'function') throw new BridgeError('远端接续状态无法定位原模型，请先使用原模型恢复历史。', 400, 'remote_history_channel_mismatch');
        const info = await inspectRemoteState(encrypted, { clientScope, session, fork, signal, kind: 'reasoning',
          model: target === 'Bifrost' ? body.model : null });
        aborted(signal); remoteMatches = info?.model === body.model;
      }
      const preserve = typeof encrypted === 'string' && (source === target && remoteMatches && !(target === 'Cursor' && mixedCursorHistory)
        || source === 'OpenAI' && native(target));
      if (preserve || encrypted == null && native(target)) { input.push(item); continue; }
      const summary = summaryText(item);
      if (summary) input.push(readableSummary(summary));
      changed = true; removedSource ??= source; continue;
    }
    if (typeof encrypted === 'string' && (prefixes.some(([, prefix]) => encrypted.startsWith(prefix))
        || encrypted.startsWith(CODEBUDDY_COMPACTION_STATE_PREFIX))) invalid();
    if (!native(target) && (encrypted != null || item.encrypted_function_args != null && item.encrypted_function_args !== false
        && (!Array.isArray(item.encrypted_function_args) || item.encrypted_function_args.length))) {
      // Newer OpenAI responses can attach private replay data alongside an
      // explicit message or tool payload. Keep the complete readable payload.
      if (!hasPlainPayload(item)) invalid();
      const copy = { ...item };
      delete copy.encrypted_content; delete copy.encrypted_function_args;
      input.push(copy); changed = true; continue;
    }
    input.push(item);
  }
  if (changed && input.length === 0) {
    throw new BridgeError('接续状态中没有可转交的明文历史，请先用原模型生成交接摘要。', 400, mismatch(removedSource));
  }
  return { body: changed ? { ...body, input } : body, changed };
}
