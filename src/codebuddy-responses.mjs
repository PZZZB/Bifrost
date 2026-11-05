import { randomUUID } from 'node:crypto';
import { clientScope as validateClientScope } from './client-scope.mjs';
import { CODEBUDDY_MODEL } from './codebuddy-provider.mjs';
import { CODEBUDDY_STATE_PREFIX, CODEBUDDY_COMPACTION_STATE_PREFIX } from './codebuddy-thinking-state.mjs';
import { resolveCodeBuddyAlias } from './codebuddy-models.mjs';
import { codeBuddySourceError } from './codebuddy-source-errors.mjs';
import { normalizeCodeBuddySourceDiagnostics } from './codebuddy-source-diagnostics.mjs';
import { deliverResponses } from './protocols/responses-delivery.mjs';
import { translateResponses as translate, ResponsesConversion as Conversion, encodeResponsesEvent as sse,
  AdapterError, errorResponse, MessagesSseParser as SseParser, messagesJsonEvents as jsonEvents } from './protocols/responses-messages.mjs';

// A bridge-owned, opaque envelope containing real, already encrypted CodeBuddy
// continuation markers. This is not an OpenAI token and must never reach A/B.
export const CODEBUDDY_RESPONSES_STATE_PREFIX = 'bifrost-codebuddy-responses-v1:';
export const CODEBUDDY_RESPONSES_CAPABILITIES = Object.freeze({
  hostedWebSearch: false, clientTools: true, images: true, reasoningSummaries: false,
  continuation: 'bridge-owned-opaque-encrypted-state', previousResponseId: false, remoteCompaction: 'v2',
  conversation: Object.freeze({ fullHistory: true, snapshotState: true, liveExecution: false, completedCheckpoint: false }),
});
export { sse as encodeResponsesEvent };
const LIMIT = 64 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, param) => { throw new AdapterError(message, 400, param); };
const protocol = message => { throw new AdapterError(message, 502); };
function shape(value, allowed, where) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${where} 格式无效。`, where);
}

function envelope(block) {
  if (!object(block) || block.type !== 'thinking' || block.thinking !== '' ||
      typeof block.signature !== 'string' || !block.signature.startsWith(CODEBUDDY_STATE_PREFIX)) {
    protocol('CodeBuddy 返回了无法保真接续的思考状态。');
  }
  return CODEBUDDY_RESPONSES_STATE_PREFIX + Buffer.from(JSON.stringify({ version: 1, blocks: [block] })).toString('base64url');
}
function openEnvelope(value) {
  if (typeof value !== 'string' || !value.startsWith(CODEBUDDY_RESPONSES_STATE_PREFIX)) {
    fail('此思考历史不属于 CodeBuddy。请新建会话，避免将 OpenAI 加密状态发送到其他渠道。', 'input.reasoning.encrypted_content');
  }
  const encoded = value.slice(CODEBUDDY_RESPONSES_STATE_PREFIX.length);
  if (value.length > LIMIT || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail('CodeBuddy 思考封套无效。', 'input.reasoning');
  let saved;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('CodeBuddy 思考封套无效。', 'input.reasoning'); }
  shape(saved, ['version', 'blocks'], 'input.reasoning.state');
  if (saved.version !== 1 || !Array.isArray(saved.blocks) || !saved.blocks.length || saved.blocks.length > 256) {
    fail('CodeBuddy 思考封套无效。', 'input.reasoning');
  }
  for (const block of saved.blocks) {
    shape(block, ['type', 'thinking', 'signature'], 'input.reasoning.state.block');
    if (block.type !== 'thinking' || block.thinking !== '' || typeof block.signature !== 'string' ||
        !block.signature.startsWith(CODEBUDDY_STATE_PREFIX)) fail('CodeBuddy 思考封套包含无效状态。', 'input.reasoning');
  }
  // The existing provider decrypts each marker and validates employee identity
  // and upstream model. The envelope never bypasses those checks.
  return saved.blocks;
}

const legacyProfile = { model: CODEBUDDY_MODEL.id, label: 'CodeBuddy', allowedEfforts: ['low', 'medium', 'high', 'xhigh'],
  idPrefix: 'bifrost_cb', reasoningIdPrefix: 'rs_bifrost_cb_', defaultReasoning: { effort: 'high', summary: 'auto' },
  defaultThinking: { type: 'adaptive', display: 'omitted' }, openState: openEnvelope, sealState: envelope,
  openCompaction: value => {
    if (typeof value !== 'string' || !value.startsWith(CODEBUDDY_COMPACTION_STATE_PREFIX) || value.length > LIMIT) {
      fail('此压缩历史不属于 CodeBuddy，不能跨渠道解码 OpenAI 的压缩密文。', 'input.compaction');
    }
    // Identity, actual upstream model and client scope are checked by the
    // existing native provider before this private block becomes model text.
    return [{ type: 'bifrost_compaction', encrypted_content: value }];
  },
  sealCompaction: () => protocol('CodeBuddy 历史摘要状态尚未就绪。') };

// Preserve the established public helper defaults while the shared engine stays source-neutral.
export function translateResponses(body, marker, profile = {}) { return translate(body, marker, { ...legacyProfile, ...profile }); }
export class ResponsesConversion extends Conversion {
  constructor(request, profile = {}) { super(request, { ...legacyProfile, ...profile }); }
}

export class CodeBuddyResponsesProvider {
  constructor({ provider } = {}) {
    if (typeof provider?.request !== 'function' || typeof provider?.status !== 'function') throw new TypeError('provider.request() and status() are required.');
    this.provider = provider;
    this.profile = { ...legacyProfile };
    this.instructionMarker = `bifrost-priority-${randomUUID()}`;
  }
  async status() { return { ...await this.provider.status(), responsesCapabilities: CODEBUDDY_RESPONSES_CAPABILITIES }; }
  async openCompactionForHandoff(value, options) {
    if (typeof this.provider.openCompactionForHandoff !== 'function') throw new AdapterError('当前 CodeBuddy 来源不能恢复历史摘要。', 409);
    try { return await this.provider.openCompactionForHandoff(value, options); }
    catch (error) { throw new AdapterError('CodeBuddy 历史摘要无效、授权不匹配或来源暂不可用。',
      [400, 401, 403, 409, 499, 503].includes(error?.status) ? error.status : 503, 'input.compaction'); }
  }
  async prepareHistoryForModel(body, { clientScope = null, signal } = {}) {
    if (!Array.isArray(body?.input)) return body;
    const packets = [], indices = [];
    for (const [index, item] of body.input.entries()) {
      if (item?.type !== 'reasoning' || !item.encrypted_content?.startsWith?.(CODEBUDDY_RESPONSES_STATE_PREFIX)) continue;
      const blocks = openEnvelope(item.encrypted_content);
      indices.push({ index, count: blocks.length }); packets.push(...blocks);
    }
    let matches = packets.map(() => true);
    if (packets.length && typeof this.provider.continuationModelMatches === 'function') {
      try { matches = await this.provider.continuationModelMatches(packets, body.model, { clientScope, signal }); }
      catch (error) { throw new AdapterError('CodeBuddy 思考接续状态无效、授权不匹配或来源暂不可用。',
        [400, 401, 403, 409, 499, 503].includes(error?.status) ? error.status : 503, 'input.reasoning'); }
    }
    let at = 0, changed = false;
    const remove = new Set();
    for (const row of indices) {
      if (matches.slice(at, at + row.count).some(value => !value)) {
        const item = body.input[row.index];
        if (item.summary != null && (!Array.isArray(item.summary) || item.summary.length) ||
            item.content != null && (!Array.isArray(item.content) || item.content.length)) fail('跨模型接续不能丢弃额外明文思考内容。', 'input.reasoning');
        remove.add(row.index); changed = true;
      }
      at += row.count;
    }
    const input = [];
    for (const [index, item] of body.input.entries()) {
      if (remove.has(index)) continue;
      if (['compaction', 'context_compaction'].includes(item?.type) &&
          item.encrypted_content?.startsWith?.(CODEBUDDY_COMPACTION_STATE_PREFIX)) {
        const summary = await this.openCompactionForHandoff(item.encrypted_content, { clientScope, signal });
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text',
          text: `[Bifrost conversation summary]\n${summary}\n[/Bifrost conversation summary]` }] }); changed = true;
      } else input.push(item);
    }
    return changed ? { ...body, input } : body;
  }
  async request({ path, body, headers: _headers, signal, clientScope = null } = {}) {
    let request, profile = this.profile;
    try {
      clientScope = validateClientScope(clientScope);
      let url;
      try {
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error();
        url = new URL(path, 'http://codebuddy.invalid');
      } catch { fail('请求路径无效。', 'path'); }
      if (!['/responses', '/v1/responses'].includes(url.pathname)) throw new AdapterError('CodeBuddy Responses 未提供此接口。', url.pathname.includes('compact') ? 501 : 404);
      if (url.search || url.hash) fail('CodeBuddy Responses 不支持此 URL 查询参数或片段。', 'path');
      if (body instanceof Uint8Array && body.byteLength > LIMIT || typeof body === 'string' && Buffer.byteLength(body) > LIMIT) fail('请求超过大小限制。', 'body');
      if (signal?.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499);
      if (typeof this.provider.getModels === 'function') {
        let parsed;
        try { parsed = typeof body === 'string' || body instanceof Uint8Array ? JSON.parse(Buffer.from(body).toString('utf8')) : body; }
        catch { fail('请求不是有效 JSON。', 'body'); }
        const alias = resolveCodeBuddyAlias(parsed?.model);
        if (!alias) fail('未知的模型。', 'model');
        // Reject malformed content and foreign continuation envelopes before
        // reading account metadata, including on the original Opus route.
        const preliminary = { ...this.profile, model: alias.id, ...(alias.upstream !== null ? {
          allowedEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
        } : {}) };
        request = translate(parsed, this.instructionMarker, preliminary);
        const prepared = await this.prepareHistoryForModel(parsed, { clientScope, signal });
        if (prepared !== parsed) request = translate(prepared, this.instructionMarker, preliminary);
        const models = await this.provider.getModels({ signal });
        const model = Array.isArray(models) && models.find(model => model.id === alias.id);
        if (!model?.available) throw new AdapterError(model?.reason || '当前 CodeBuddy 账号目录未提供可用的所选模型。', 503);
        const codexEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
        profile = { ...this.profile, model: model.id, allowedEfforts: (model.efforts ?? []).filter(value => codexEfforts.includes(value)),
          ...(alias.upstream !== null ? { defaultReasoning: {} } : {}) };
        if (alias.upstream !== null && !profile.allowedEfforts.length && Object.hasOwn(request.original.reasoning ?? {}, 'effort')) {
          if (!codexEfforts.includes(request.original.reasoning.effort)) fail('reasoning.effort 不是已知的 Codex 档位。', 'reasoning.effort');
          // Codex can inherit a global hint even when the catalog exposes no
          // corresponding control. Use upstream defaults and never echo it.
          delete request.original.reasoning.effort;
          delete request.upstream.output_config;
        }
        if (request.original.reasoning?.effort !== undefined && !profile.allowedEfforts.includes(request.original.reasoning.effort)) fail('当前模型不支持此思考参数。', 'reasoning.effort');
        if (alias.upstream !== null) {
          delete request.upstream.thinking;
          if (model.maxOutputTokens && parsed.max_output_tokens === undefined) request.upstream.max_tokens = Math.min(request.upstream.max_tokens, model.maxOutputTokens);
          if (model.maxOutputTokens && request.upstream.max_tokens > model.maxOutputTokens) fail('max_output_tokens 超过当前账号目录的模型上限。', 'max_output_tokens');
          if (parsed.reasoning?.summary === 'auto') {
            if (model.supportsReasoningSummary !== true) fail('当前 CodeBuddy 模型目录未确认支持思考摘要参数。', 'reasoning.summary');
            request.upstream.thinking = { type: 'adaptive', display: 'summarized' };
          }
        }
      } else request = translate(body, this.instructionMarker, profile);
    } catch (error) { return errorResponse(error); }
    const abort = new AbortController(), onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) abort.abort();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    let upstream;
    try {
      // Inbound ChatGPT credentials and client metadata never reach CodeBuddy.
      upstream = await this.provider.request({ path: '/v1/messages', body: Buffer.from(JSON.stringify(request.upstream)),
        clientScope,
        headers: new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }), signal: abort.signal });
      if (!upstream?.ok) {
        let message = 'CodeBuddy 上游请求失败。', code = null, sourceDiagnostics;
        try {
          const data = await upstream.json();
          if (typeof data.error?.message === 'string') message = data.error.message.slice(0, 1024);
          const source = codeBuddySourceError(data.error?.code);
          if (source?.status === upstream.status) {
            code = source.code; sourceDiagnostics = normalizeCodeBuddySourceDiagnostics(code, data.error?.sourceDiagnostics);
          }
        } catch {}
        const denied = errorResponse(new AdapterError(message, upstream?.status >= 400 && upstream.status <= 599 ? upstream.status : 502, null, code, sourceDiagnostics));
        denied.bridgeUsage = upstream?.bridgeUsage ?? Promise.resolve(null); denied.bridgeModel = upstream?.bridgeModel;
        cleanup(); return denied;
      }
      if (!upstream.body) throw new AdapterError('CodeBuddy 上游缺少响应内容。', 502);
      if (request.compaction) {
        if (typeof upstream.bridgeSealCompaction !== 'function') throw new AdapterError('当前 CodeBuddy 来源尚未提供历史摘要密封能力。', 501);
        profile = { ...profile, sealCompaction: summary => upstream.bridgeSealCompaction(summary) };
      }
    } catch (error) { cleanup(); return errorResponse(abort.signal.aborted ? new AdapterError('CodeBuddy 请求已取消。', 499) : error); }
    const conversion = new Conversion(request, profile), reader = upstream.body.getReader();
    const cancelRead = () => { void reader.cancel().catch(() => {}); };
    abort.signal.addEventListener('abort', cancelRead, { once: true });
    if (abort.signal.aborted) cancelRead();
    let disposing;
    const dispose = () => disposing ??= (async () => {
      abort.signal.removeEventListener('abort', cancelRead);
      await reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
      cleanup();
    })();
    const decorate = response => {
      response.bridgeUsage = upstream.bridgeUsage ?? Promise.resolve(null); response.bridgeModel = upstream.bridgeModel;
      if (upstream.bridgeCacheControl) response.bridgeCacheControl = upstream.bridgeCacheControl;
      return response;
    };
    const events = async function* () {
      const checkAbort = () => { if (abort.signal.aborted) throw new AdapterError('CodeBuddy 请求已取消。', 499); };
      const isJson = upstream.headers.get('content-type')?.includes('application/json');
      const parser = new SseParser(); let json = '', decoder;
      if (isJson) decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        checkAbort(); const { value, done } = await reader.read(); checkAbort();
        if (isJson) {
          try { json += decoder.decode(value, { stream: !done }); } catch { protocol('CodeBuddy JSON 不是有效 UTF-8。'); }
          if (Buffer.byteLength(json, 'utf8') > LIMIT) protocol('CodeBuddy JSON 超过大小限制。');
        } else for (const source of parser.push(value, done)) for (const converted of conversion.accept(source)) { checkAbort(); yield converted; }
        if (done) break;
      }
      if (isJson) {
        let message;
        try { message = JSON.parse(json); } catch { protocol('CodeBuddy Messages JSON 无效。'); }
        for (const source of jsonEvents(message)) for (const converted of conversion.accept(source)) { checkAbort(); yield converted; }
      }
      checkAbort();
      const usage = await (upstream.bridgeUsage ?? null); checkAbort();
      const commit = [...conversion.finishEvents(usage)]; checkAbort();
      yield commit;
    };
    return deliverResponses({ events: events(), conversion, stream: request.original.stream === true,
      signal: abort.signal, decorate, cancelledError: () => new AdapterError('CodeBuddy 请求已取消。', 499),
      cancel: () => { abort.abort(); cleanup(); cancelRead(); }, dispose });
  }
}
