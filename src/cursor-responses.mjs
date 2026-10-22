import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { resolveCursorModel } from './cursor-service.mjs';
import { translateResponses, ResponsesConversion, encodeResponsesEvent } from './codebuddy-responses.mjs';
import { imagePart, ImageConversionError } from './codebuddy-images.mjs';
import { writeJson } from './storage.mjs';

export const CURSOR_RESPONSES_STATE_PREFIX = 'bifrost-cursor-live-v1:';
export const CURSOR_RESPONSES_CAPABILITIES = Object.freeze({
  transport: 'cursor-agent-sdk', statefulAgent: true, clientTools: true, hostedWebSearch: false,
  rawInference: false, maxOutputTokens: false, reasoningSummaries: false,
  forcedToolChoice: false, clientToolExecution: 'serialized-callback-queue',
  reasoningEffort: 'catalog-parameter-or-cursor-default', nativeInteractiveRequests: false,
  continuation: 'live-sdk-run-and-finished-checkpoint', restartRecovery: 'completed-sdk-checkpoints-only', cacheEquivalence: false,
  usage: 'reported-and-attributable-to-current-http-only',
});
const LIMIT = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const STATE = /^bifrost-cursor-live-v1:[A-Za-z0-9_-]{43}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const stable = value => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, order(value[key])])) : value;
}
class CursorError extends Error {
  constructor(message, status = 400, code = 'cursor_invalid_request') { super(message); this.status = status; this.code = code; }
}
const invalid = message => { throw new CursorError(message); };
const fresh = () => new CursorError('Cursor 会话状态已失效、已使用或与历史不匹配。请新建聊天。', 409, 'cursor_session_invalid');
function safeError(error, credential) {
  if (error instanceof CursorError) return error;
  if (error instanceof ImageConversionError) return new CursorError(error.message.replaceAll('CodeBuddy', 'Cursor'), 400, 'cursor_image_invalid');
  const raw = typeof error?.message === 'string' ? error.message : '';
  if (/system.?prompt|permission.?denied|not.authorized|unauthorized|forbidden/i.test(raw)) {
    return new CursorError('Cursor 拒绝自定义 systemPrompt 或当前账号没有此权限；未降级为普通用户提示。', 403, 'cursor_system_prompt_denied');
  }
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  // Never echo SDK errors: they can embed the API key, URLs, local data, or prompts.
  if (credential && raw.includes(credential)) return new CursorError('Cursor SDK 调用失败。', status, 'cursor_sdk_error');
  return new CursorError('Cursor SDK 调用失败，请检查模型权限或重新授权。', status, 'cursor_sdk_error');
}
function denied(error) {
  const status = error instanceof CursorError ? error.status : Number.isInteger(error?.status) ? error.status : 400;
  const message = error instanceof CursorError ? error.message : typeof error?.message === 'string'
    ? error.message.replaceAll('CodeBuddy', 'Cursor').slice(0, 600) : 'Cursor 请求无效。';
  const response = Response.json({ error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error',
    code: error?.code ?? 'cursor_invalid_request', param: error?.param ?? null } }, { status });
  response.bridgeUsage = Promise.resolve(null);
  return response;
}
function rawBody(value) {
  try {
    if (typeof value === 'string' || value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      if (bytes.length > LIMIT) invalid('Cursor 请求超过大小限制。');
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } else value = structuredClone(value);
    if (!object(value)) invalid('Cursor 请求必须是 JSON 对象。');
    return value;
  } catch (error) { if (error instanceof CursorError) throw error; invalid('Cursor 请求不是有效 JSON。'); }
}
function atoms(messages) {
  return messages.flatMap(message => message.content.filter(block => block.type !== 'thinking').map(block => ({ role: message.role, block })));
}
function effortParameter(model) {
  return model?.parameters?.find(parameter => ['reasoning_effort', 'reasoningEffort', 'effort'].includes(parameter.id));
}
function modelMismatch(actual, selected) {
  if (actual?.id && actual.id !== selected.id) return true;
  return (selected.params ?? []).some(parameter => {
    const observed = actual?.params?.find(item => item.id === parameter.id);
    return observed !== undefined && observed.value !== parameter.value;
  });
}
function sdkMessage(blocks) {
  const images = [], texts = [];
  for (const block of blocks) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'image') {
      imagePart(block);
      const source = block.source;
      images.push(source.type === 'base64' ? { data: source.data, mimeType: source.media_type } : { url: source.url });
    } else invalid('Cursor 用户消息中含无法映射的内容。');
  }
  return { text: texts.join('\n\n'), ...(images.length ? { images } : {}) };
}
function sdkResult(blocks) {
  return { content: blocks.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image' && block.source?.type === 'base64') {
      imagePart(block);
      return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    }
    invalid('Cursor 工具结果仅支持文本与内嵌图片，不能静默丢弃其他内容。');
  }) };
}
function usageOf(value) {
  if (!object(value)) return null;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];
  if (!keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const input = value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens;
  if (value.totalTokens !== input + value.outputTokens || value.cacheReadTokens + value.cacheWriteTokens > input) return null;
  return { input_tokens: input, output_tokens: value.outputTokens, total_tokens: value.totalTokens,
    input_tokens_details: { cached_tokens: value.cacheReadTokens, cache_write_tokens: value.cacheWriteTokens },
    output_tokens_details: { reasoning_tokens: Number.isSafeInteger(value.reasoningTokens) && value.reasoningTokens >= 0
      && value.reasoningTokens <= value.outputTokens ? value.reasoningTokens : null } };
}
function sumUsage(values) {
  if (!values.length || values.some(value => value === null)) return null;
  const result = structuredClone(values[0]);
  for (const value of values.slice(1)) {
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) result[key] += value[key];
    for (const key of ['cached_tokens', 'cache_write_tokens']) result.input_tokens_details[key] += value.input_tokens_details[key];
    const current = result.output_tokens_details.reasoning_tokens, next = value.output_tokens_details.reasoning_tokens;
    result.output_tokens_details.reasoning_tokens = current === null || next === null ? null : current + next;
  }
  return result;
}
class Queue {
  items = []; waiter = null; closed = false; bytes = 0;
  push(value) {
    if (this.closed) return;
    const bytes = this.bytes + Buffer.byteLength(stable(value));
    if (bytes > LIMIT) throw new CursorError('Cursor 待发送内容超过大小限制。', 502, 'cursor_output_limit');
    this.bytes = bytes;
    this.items.push(value); this.waiter?.(); this.waiter = null;
  }
  stop() { this.closed = true; this.waiter?.(); this.waiter = null; }
  async next() {
    while (!this.items.length && !this.closed) await new Promise(resolveNext => { this.waiter = resolveNext; });
    const value = this.items.shift();
    if (value) this.bytes -= Buffer.byteLength(stable(value));
    return value;
  }
}

/** A live Cursor agent bridge. Tool callbacks execute exclusively in the Codex client. */
export class CursorResponsesProvider {
  #sessions = new Set(); #handles = new Map(); #closed = false; #sdk = null; #recentRuns = []; #epoch = 0; #ioTail = Promise.resolve();
  constructor({ cursorService, stateDir, sdkLoader = async () => import('@cursor/sdk'),
    idleTimeoutMs = 10 * 60 * 1000, requestTimeoutMs = 120000, maxSessions = 32, checkpointRetentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (typeof cursorService?.credential !== 'function' || typeof cursorService?.getModels !== 'function'
      || typeof cursorService?.status !== 'function' || typeof stateDir !== 'string' || !stateDir
      || typeof sdkLoader !== 'function' || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isSafeInteger(maxSessions) || maxSessions < 1
      || !Number.isSafeInteger(checkpointRetentionMs) || checkpointRetentionMs < 1) throw new TypeError('Invalid Cursor Responses settings.');
    Object.assign(this, { cursorService, stateDir: resolve(stateDir), sdkLoader, idleTimeoutMs, requestTimeoutMs, maxSessions, checkpointRetentionMs });
    this.marker = `bifrost-cursor-priority-${randomUUID()}`;
  }
  async status() {
    const status = await this.cursorService.status();
    return { authenticated: status.authReady === true, ready: !this.#closed && status.enabled === true && status.authReady === true,
      modelAvailable: status.catalog?.models?.length > 0, error: this.#closed ? 'Cursor 推理桥已停止。' : status.error ?? null,
      transport: 'cursor-agent-sdk', responsesCapabilities: CURSOR_RESPONSES_CAPABILITIES,
      activeRuns: this.activeRuns, recoverableSessions: [...this.#sessions].filter(record => record.checkpointFile).length,
      runUsageDiagnostics: structuredClone(this.#recentRuns) };
  }
  get activeRuns() { return [...this.#sessions].filter(record => !record.stopped && record.run && !record.finished).length; }
  #assertCurrent(epoch, signal) {
    if (this.#closed) throw new CursorError('Cursor 推理桥已停止。', 503, 'cursor_closed');
    if (epoch !== this.#epoch) throw new CursorError('Cursor 授权或活跃会话已重置，请新建聊天。', 409, 'cursor_session_cancelled');
    if (signal?.aborted) throw new CursorError('Cursor 请求已取消。', 499, 'request_cancelled');
  }
  #io(job) {
    const result = this.#ioTail.then(job); this.#ioTail = result.catch(() => {}); return result;
  }
  #checkpointPath(handle) { return join(this.stateDir, 'cursor-sdk', 'resume', digest(handle) + '.json'); }
  async #stateRoot(create = false) {
    if (create) await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const base = await realpath(this.stateDir), root = join(this.stateDir, 'cursor-sdk');
    if (create) await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(base, await realpath(root)) !== 'cursor-sdk') {
      throw new CursorError('Cursor 状态目录包含不安全的链接，请修复本地状态路径。', 503, 'cursor_state_path_invalid');
    }
    return root;
  }
  async #resumeRoot(create = false) {
    const root = await this.#stateRoot(create), directory = join(root, 'resume');
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(await realpath(root), await realpath(directory)) !== 'resume') {
      throw new CursorError('Cursor 恢复目录包含不安全的链接，请修复本地状态路径。', 503, 'cursor_state_path_invalid');
    }
    return directory;
  }
  async #deleteCheckpoint(file, { allowMissing = true } = {}) {
    const root = await this.#resumeRoot(), name = relative(root, resolve(file));
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw fresh();
    await unlink(join(root, name)).catch(error => { if (!allowMissing || error.code !== 'ENOENT') throw error; });
  }
  async #directory(sessionId) {
    if (!UUID.test(sessionId)) throw fresh();
    const root = await this.#stateRoot(), directory = join(root, sessionId);
    for (const path of [directory, join(directory, 'cwd'), join(directory, 'store')]) {
      const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw fresh();
      const sub = relative(await realpath(root), await realpath(path));
      if (isAbsolute(sub) || sub.startsWith('..')) throw fresh();
    }
    return directory;
  }
  async #removeDirectory(directory) {
    try {
      const root = await this.#stateRoot(), sessionId = relative(root, resolve(directory));
      if (!UUID.test(sessionId)) return;
      const info = await lstat(directory);
      if (info.isSymbolicLink()) await unlink(directory);
      else { await this.#directory(sessionId); await rm(resolve(root, sessionId), { recursive: true, force: true }); }
    } catch { /* Missing or tampered directories are never followed or deleted elsewhere. */ }
  }
  async #loadCheckpoint(handle, epoch) {
    if (!STATE.test(handle)) throw fresh();
    return this.#io(async () => {
      try {
        await this.#resumeRoot();
        const file = this.#checkpointPath(handle), info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 400000) throw fresh();
        const value = JSON.parse(await readFile(file, 'utf8'));
        const keys = ['version', 'handleHash', 'authHash', 'model', 'systemHash', 'historyHash', 'historyCount', 'storeSession', 'agentId', 'expiresAt', 'stateHashes', 'marker'];
        if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
          || value.version !== 1 || value.handleHash !== digest(handle) || !HASH.test(value.authHash) || !HASH.test(value.systemHash) || !HASH.test(value.historyHash)
          || !resolveCursorModel(value.model) || !Number.isSafeInteger(value.historyCount) || value.historyCount < 1 || value.historyCount > 100000
          || !UUID.test(value.storeSession) || typeof value.agentId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.agentId) || value.agentId.startsWith('bc-')
          || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || !Array.isArray(value.stateHashes) || value.stateHashes.length > 4096
          || value.stateHashes.some(hash => !HASH.test(hash)) || new Set(value.stateHashes).size !== value.stateHashes.length || !value.stateHashes.includes(value.handleHash)
          || typeof value.marker !== 'string' || !value.marker.startsWith('bifrost-cursor-priority-') || !UUID.test(value.marker.slice('bifrost-cursor-priority-'.length))) throw fresh();
        this.#assertCurrent(epoch);
        await this.#directory(value.storeSession); this.#assertCurrent(epoch);
        return { ...value, file };
      } catch (error) { if (error instanceof CursorError && error.code !== 'cursor_session_invalid') throw error; throw fresh(); }
    });
  }
  async #saveCheckpoint(record, lease, handle) {
    if (!record.finished || record.pending.size || !record.store?.agents?.get || !record.store?.checkpoints?.get) return;
    const document = await record.store.agents.get({ agentId: record.agent.agentId });
    const checkpoint = document?.latestCheckpoint;
    if (document?.agentId !== record.agent.agentId || document.status !== 'idle' || document.activeRunId != null
      || resolve(document.cwd) !== resolve(record.directory, 'cwd') || checkpoint?.schemaVersion !== 1 || typeof checkpoint.rootBlobId !== 'string') return;
    const bytes = await record.store.checkpoints.get({ agentId: record.agent.agentId, blobId: checkpoint.rootBlobId });
    if (!(bytes instanceof Uint8Array) || !bytes.length) return;
    const data = { version: 1, handleHash: digest(handle), authHash: record.auth, model: record.model, systemHash: digest(record.system),
      historyHash: lease.historyHash, historyCount: lease.historyCount, storeSession: record.storeSession,
      agentId: record.agent.agentId, expiresAt: Date.now() + this.checkpointRetentionMs, stateHashes: [...record.stateHashes], marker: record.marker };
    const file = this.#checkpointPath(handle);
    await this.#io(async () => {
      this.#assertCurrent(record.epoch); if (record.stopped) throw fresh();
      await this.#resumeRoot(true); this.#assertCurrent(record.epoch); if (record.stopped) throw fresh();
      await writeJson(file, data);
      if (record.stopped || record.epoch !== this.#epoch) { await this.#deleteCheckpoint(file).catch(() => {}); throw fresh(); }
      record.checkpointFile = file;
      await this.#pruneCheckpoints();
    });
  }
  async #consumeCheckpoint(record) {
    if (!record.checkpointFile) return;
    const file = record.checkpointFile;
    await this.#io(async () => {
      try { await this.#deleteCheckpoint(file, { allowMissing: false }); } catch (error) { if (error.code === 'ENOENT') throw fresh(); throw error; }
      record.checkpointFile = null;
    });
  }
  async #pruneCheckpoints() {
    const root = await this.#resumeRoot(), retained = [];
    for (const name of await readdir(root).catch(() => [])) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const file = join(root, name);
      try { const info = await lstat(file); if (info.isSymbolicLink() || info.size > 400000) continue;
        const value = JSON.parse(await readFile(file, 'utf8')); retained.push({ file, value });
      } catch { /* A malformed index never authorizes a resume. */ }
    }
    retained.sort((a, b) => (b.value.expiresAt ?? 0) - (a.value.expiresAt ?? 0));
    for (const [index, { file, value }] of retained.entries()) {
      if (index < 128 && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()) continue;
      if ([...this.#sessions].some(record => record.checkpointFile === file)) continue;
      await unlink(file).catch(() => {});
      if (UUID.test(value.storeSession) && ![...this.#sessions].some(record => record.storeSession === value.storeSession)) {
        await this.#removeDirectory(join(this.stateDir, 'cursor-sdk', value.storeSession));
      }
    }
  }
  async #sdkValue() {
    this.#sdk ??= Promise.resolve().then(this.sdkLoader).then(sdk => {
      if (typeof sdk?.Agent?.create !== 'function' || typeof sdk?.JsonlLocalAgentStore !== 'function') throw new Error();
      return sdk;
    });
    return this.#sdk;
  }
  #expire(record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => { void this.#stop(record, fresh(), { preserveCheckpoint: record.finished }); }, this.idleTimeoutMs);
    record.timer.unref?.();
  }
  async #stop(record, error = fresh(), { preserveCheckpoint = false } = {}) {
    if (record.stopped) return;
    record.stopped = true; record.stopError = error; record.rejectStopped?.(error); clearTimeout(record.timer);
    for (const handle of record.handles) this.#handles.delete(handle);
    this.#sessions.delete(record);
    for (const call of record.pending.values()) call.reject(error);
    record.pending.clear(); record.queue.stop();
    const jobs = [];
    try { if (!record.finished && record.run?.cancel) jobs.push(Promise.resolve(record.run.cancel())); } catch {}
    try { record.agent?.close(); } catch {}
    let cancelTimer;
    await Promise.race([Promise.allSettled(jobs), new Promise(resolveDone => { cancelTimer = setTimeout(resolveDone, 1000); })]);
    clearTimeout(cancelTimer);
    if (!preserveCheckpoint) {
      if (record.checkpointFile) await this.#deleteCheckpoint(record.checkpointFile).catch(() => {});
      if (record.directory) await this.#removeDirectory(record.directory);
    }
  }
  #callback(record, tool, args, context = {}) {
    if (record.stopped || this.#closed) return Promise.reject(fresh());
    if (record.toolsDisabled) {
      const error = new CursorError('Cursor SDK 尝试调用已被 tool_choice=none 禁用的客户端工具。', 502, 'cursor_tool_choice_violation');
      try { record.queue.push({ type: 'error', error }); } catch {}
      return Promise.reject(error);
    }
    if (!object(args)) return Promise.reject(new CursorError('Cursor 工具参数必须是对象。', 502));
    const key = context.toolCallId;
    if (key && record.sdkCalls.has(key)) return record.sdkCalls.get(key);
    const callId = `call_cursor_${randomUUID().replaceAll('-', '')}`;
    const promise = new Promise((resolveResult, reject) => {
      record.pending.set(callId, { tool, args: structuredClone(args), resolve: resolveResult, reject, returned: false });
      try { record.queue.push({ type: 'tool', callId }); } catch (error) { reject(error); void this.#stop(record, error); }
    });
    void promise.catch(() => {});
    if (key) record.sdkCalls.set(key, promise);
    return promise;
  }
  #customTools(record) {
    if (record.toolsDisabled) return {};
    const customTools = Object.fromEntries(record.mapping.declarations.map(tool => [tool.name, {
      description: tool.description, inputSchema: tool.input_schema,
      execute: (args, context) => this.#callback(record, tool.name, args, context),
    }]));
    // SDK custom tools are fixed for one live send. Discovered client schemas
    // use a checked dispatcher; no new SDK API or extra send is fabricated.
    customTools.bifrost_client_dispatch = {
      description: 'Call a client tool returned by client tool discovery. Use its exact type, namespace, name and arguments. Only discovered tools are accepted.',
      inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['function', 'custom', 'tool_search'] },
        namespace: { type: ['string', 'null'] }, name: { type: 'string' }, arguments: { type: 'object' } }, required: ['type', 'name', 'arguments'], additionalProperties: false },
      execute: (args, context) => {
        const tool = object(args) && record.mapping.byKey.get(record.mapping.key(args.type, args.namespace, args.name));
        if (!tool?.declared) return Promise.reject(new CursorError('Cursor 请求了未声明的客户端工具。', 502));
        return this.#callback(record, tool.alias, args.arguments, context);
      },
    };
    return customTools;
  }
  async #send(record, message, selection) {
    this.#assertCurrent(record.epoch);
    if (record.stopped) throw record.stopError ?? fresh();
    record.finished = false; record.crossHttp = false; record.selection = selection;
    record.lastSDKError = null;
    record.staticTools = new Map(record.mapping.declarations.map(tool => [tool.name, stable(tool)]));
    record.sdkCalls.clear(); record.queue = new Queue(); record.reportedUsage = [];
    const sending = Promise.resolve(record.agent.send(message, { model: selection, mcpServers: {}, local: { customTools: this.#customTools(record) } }));
    void sending.then(run => { if (record.stopped) void Promise.resolve(run.cancel()).catch(() => {}); }).catch(() => {});
    record.run = await Promise.race([sending, record.stoppedPromise]);
    const run = record.run;
    void (async () => {
      try {
        for await (const event of run.stream()) {
          if (record.stopped) return;
          if (event.type === 'assistant') {
            if (!Array.isArray(event.message?.content)) throw new CursorError('Cursor SDK 返回了无法识别的 assistant 内容。', 502, 'cursor_content_unsupported');
            for (const block of event.message?.content ?? []) {
              if (block?.type === 'text' && typeof block.text === 'string') {
                if (block.text) record.queue.push({ type: 'text', text: block.text });
              } else if (block?.type !== 'tool_use') throw new CursorError('Cursor SDK 返回了无法映射的 assistant 内容，回合已取消。', 502, 'cursor_content_unsupported');
            }
          } else if (event.type === 'usage') {
            const usage = usageOf(event.usage); record.reportedUsage.push(usage);
            record.queue.push({ type: 'usage', usage });
          } else if (event.type === 'status' && event.status === 'ERROR') record.lastSDKError = safeError({ message: event.message }, record.apiKey);
          else if (event.type === 'request') throw new CursorError('Cursor SDK 请求了原生交互，但公开 SDK 没有回应接口。请通过已声明的 Codex 客户端问答工具交互。', 501, 'cursor_native_interaction_unsupported');
          if (event.type === 'system' && modelMismatch(event.model, record.selection)) throw new CursorError('Cursor SDK 实际模型或参数与所选值不匹配。', 502, 'cursor_model_mismatch');
        }
        const result = await run.wait();
        if (record.stopped) return;
        if (result.status !== 'finished') throw record.lastSDKError ?? safeError(result.error, record.apiKey);
        if (modelMismatch(result.model, selection)) throw new CursorError('Cursor SDK 实际模型或参数与所选值不匹配。', 502, 'cursor_model_mismatch');
        if (record.pending.size) throw new CursorError('Cursor SDK 在客户端工具尚未返回时结束。', 502);
        const runUsage = usageOf(result.usage) ?? sumUsage(record.reportedUsage);
        if (runUsage) {
          this.#recentRuns.push({ model: selection.id, scope: 'sdk-run', usage: runUsage,
            httpAttribution: record.crossHttp ? 'unknown' : 'single-http' });
          if (this.#recentRuns.length > 10) this.#recentRuns.shift();
        }
        record.finished = true; record.queue.push({ type: 'finished', usage: runUsage });
      } catch (error) {
        if (!record.stopped) {
          const safe = safeError(error, record.apiKey);
          try { record.queue.push({ type: 'error', error: safe }); } catch { await this.#stop(record, safe); }
        }
      }
    })();
  }
  async request({ path, body, headers: _headers, signal } = {}) {
    const epoch = this.#epoch;
    let parsed, model, credential, translated, selection, handle, checkpoint, auth;
    try {
      if (this.#closed) throw new CursorError('Cursor 推理桥已停止。', 503, 'cursor_closed');
      if (signal?.aborted) throw new CursorError('Cursor 请求已取消。', 499, 'request_cancelled');
      if (!['/responses', '/v1/responses'].includes(path)) throw new CursorError('Cursor 未提供此接口。', path?.includes('compact') ? 501 : 404);
      parsed = rawBody(body); model = resolveCursorModel(parsed.model);
      if (!model) invalid('未知的 Cursor 模型。');
      parsed.parallel_tool_calls ??= false;
      if (parsed.tool_choice != null && !['auto', 'none'].includes(parsed.tool_choice)) invalid('Cursor SDK 不保证 required 或指定工具调用，只支持 tool_choice=auto 或 none。');
      for (const field of ['max_output_tokens', 'temperature', 'top_p']) if (parsed[field] != null) invalid(`Cursor SDK agent 不提供 ${field} 的 raw inference 保证；请移除此参数。`);
      if (parsed.text?.verbosity != null) invalid('Cursor SDK 不提供 text.verbosity 参数。');
      if (parsed.input?.some?.(item => item?.type === 'reasoning' && !item.encrypted_content)) throw fresh();
      credential = await this.cursorService.credential();
      this.#assertCurrent(epoch, signal);
      if (!credential?.apiKey || !Number.isSafeInteger(credential.apiKeyExpiresAtMs) || credential.apiKeyExpiresAtMs <= Date.now()) throw new CursorError('Cursor 账号尚未授权或已过期。', 401, 'cursor_auth_required');
      const source = (await this.cursorService.getModels()).find(item => item.id === model.upstream);
      this.#assertCurrent(epoch, signal);
      if (!source) throw new CursorError('当前 Cursor 账号没有此模型。', 403, 'cursor_model_unavailable');
      auth = digest(credential.apiKey + '\n' + (credential.teamId ?? ''));
      const incomingStates = Array.isArray(parsed.input) ? parsed.input.filter(item => item?.type === 'reasoning' && item.encrypted_content != null).map(item => item.encrypted_content) : [];
      const lastState = incomingStates.at(-1), liveRecord = this.#handles.get(lastState)?.record;
      if (lastState !== undefined && !liveRecord) checkpoint = await this.#loadCheckpoint(lastState, epoch);
      this.#assertCurrent(epoch, signal);
      const stateHashes = liveRecord?.stateHashes ?? new Set(checkpoint?.stateHashes ?? []);
      const parameter = effortParameter(source);
      // A Codex profile can carry a global effort even when the selected SDK
      // model has no such parameter. This bridge explicitly uses Cursor's
      // default in that case; it must never echo that hint as executed effort.
      if (!parameter && object(parsed.reasoning) && Object.hasOwn(parsed.reasoning, 'effort')) {
        if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].includes(parsed.reasoning.effort)) invalid('reasoning.effort 不是已知的 Codex 档位。');
        delete parsed.reasoning.effort;
      }
      translated = translateResponses(parsed, checkpoint?.marker ?? liveRecord?.marker ?? this.marker, { model: model.id, label: 'Cursor', allowedEfforts: parameter?.values?.map(item => item.value) ?? [],
        reasoningIdPrefix: 'rs_bifrost_cursor_', openState: value => {
          if (typeof value !== 'string' || !STATE.test(value) || !stateHashes.has(digest(value))) throw fresh();
          handle = value;
          return [{ type: 'thinking', thinking: '', signature: value }];
        } });
      selection = { id: model.upstream, ...(parsed.reasoning?.effort !== undefined ? { params: [{ id: parameter.id, value: parsed.reasoning.effort }] } : {}) };
    } catch (error) { return denied(error); }
    let record, lease;
    const inputAtoms = atoms(translated.upstream.messages), system = translated.upstream.system?.map(block => block.text).join('\n\n')
      || 'Follow the user instructions. Use only the provided client tools and respect their permissions.';
    try {
      if (handle) {
        lease = this.#handles.get(handle); record = lease?.record;
        if (!record && checkpoint) {
          if (this.#sessions.size >= this.maxSessions) throw new CursorError('Cursor 活跃会话数量已达上限。', 409, 'cursor_session_limit');
          if (digest(system) !== checkpoint.systemHash) throw new CursorError('Cursor 会话的 systemPrompt 已变更，请新建聊天。', 409, 'cursor_system_prompt_changed');
          record = { epoch, auth: checkpoint.authHash, model: checkpoint.model, apiKey: credential.apiKey, system, marker: checkpoint.marker,
            mapping: translated.tools, pending: new Map(), sdkCalls: new Map(), queue: new Queue(), handles: new Set([handle]), stateHashes: new Set(checkpoint.stateHashes),
            busy: false, stopped: false, finished: true, crossHttp: false, selection, toolsDisabled: parsed.tool_choice === 'none',
            storeSession: checkpoint.storeSession, resumeAgentId: checkpoint.agentId, checkpointFile: checkpoint.file };
          record.stoppedPromise = new Promise((_, reject) => { record.rejectStopped = reject; });
          void record.stoppedPromise.catch(() => {});
          lease = { record, calls: [], historyHash: checkpoint.historyHash, historyCount: checkpoint.historyCount, used: false };
          record.latest = lease;
        }
        if (!record || record.stopped || lease !== record.latest || lease.used || record.busy) throw fresh();
        if (record.auth !== auth || record.model !== model.id) throw new CursorError('Cursor 会话与当前账号或模型不匹配，请新建聊天。', 403, 'cursor_session_scope');
        if (digest(inputAtoms.slice(0, lease.historyCount)) !== lease.historyHash) throw fresh();
        const delta = inputAtoms.slice(lease.historyCount);
        if (!delta.length) throw fresh();
        if (!record.finished) {
          const results = delta.filter(atom => atom.role === 'user' && atom.block.type === 'tool_result');
          if (results.length !== lease.calls.length || delta.length !== results.length
            || results.some(atom => !lease.calls.includes(atom.block.tool_use_id))
            || new Set(results.map(atom => atom.block.tool_use_id)).size !== results.length) throw fresh();
        } else if (delta.some(atom => atom.role !== 'user' || !['text', 'image'].includes(atom.block.type))) throw fresh();
        if (record.system !== system) throw new CursorError('Cursor 活跃会话的 systemPrompt 已变更，请新建聊天。', 409, 'cursor_system_prompt_changed');
        if (!record.finished && stable(record.selection) !== stable(selection)) throw new CursorError('Cursor 活跃工具回合不能改变模型思考参数，请完成回合或新建聊天。', 409, 'cursor_model_parameters_changed');
        if (!record.finished && record.toolsDisabled !== (parsed.tool_choice === 'none')) throw new CursorError('Cursor 活跃工具回合不能改变 tool_choice，请完成回合或新建聊天。', 409, 'cursor_tool_choice_changed');
        if (!record.finished) {
          const nextTools = new Map(translated.tools.declarations.map(tool => [tool.name, stable(tool)]));
          for (const [alias, definition] of record.staticTools ?? []) if (nextTools.get(alias) !== definition) {
            throw new CursorError('Cursor 活跃工具的声明已变更，请新建聊天。', 409, 'cursor_tool_schema_changed');
          }
        }
        if (!record.finished) for (const call of record.pending.values()) {
          const previous = record.mapping.byAlias.get(call.tool), next = translated.tools.byAlias.get(call.tool);
          if (!next || stable(previous?.declaration) !== stable(next.declaration)) throw new CursorError('Cursor 活跃工具的声明已变更，请新建聊天。', 409, 'cursor_tool_schema_changed');
        }
        record.busy = true; lease.used = true; record.mapping = translated.tools; record.toolsDisabled = parsed.tool_choice === 'none';
        this.#sessions.add(record); this.#handles.set(handle, lease);
        clearTimeout(record.timer);
      } else {
        if (inputAtoms.some(atom => atom.role !== 'user') || this.#sessions.size >= this.maxSessions) throw new CursorError('Cursor 需要新建空白聊天，或活跃会话数量已达上限。', 409, 'cursor_session_limit');
        record = { epoch, auth, model: model.id, apiKey: credential.apiKey, system, marker: this.marker, mapping: translated.tools, pending: new Map(), sdkCalls: new Map(),
          queue: new Queue(), handles: new Set(), stateHashes: new Set(), busy: true, stopped: false, finished: false, crossHttp: false,
          selection, toolsDisabled: parsed.tool_choice === 'none' };
        record.stoppedPromise = new Promise((_, reject) => { record.rejectStopped = reject; });
        void record.stoppedPromise.catch(() => {});
        this.#sessions.add(record);
        this.#expire(record);
      }
    } catch (error) { return denied(error); }
    let resolveUsage;
    const bridgeUsage = new Promise(resolveValue => { resolveUsage = resolveValue; });
    let finishedHttp = false, timeout;
    const stop = () => { if (!finishedHttp) void this.#stop(record, new CursorError('Cursor 请求已取消。', 499, 'request_cancelled')); };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', stop); };
    const profile = { idPrefix: 'bifrost_cursor', defaultReasoning: {}, sealState: block => block.signature };
    const conversion = new ResponsesConversion(translated, profile);
    const sourceEvent = event => conversion.accept(event);
    const self = this;
    let terminalError = null;
    const events = async function* () {
      let index = 0, usage = null, finalUsage = null;
      const reported = [], emitted = [];
      try {
        self.#assertCurrent(epoch, signal);
        clearTimeout(record.timer);
        timeout = setTimeout(() => { void self.#stop(record, new CursorError('Cursor 请求超时，回合已取消。', 504, 'cursor_timeout')); }, self.requestTimeoutMs);
        timeout.unref?.();
        await self.#consumeCheckpoint(record); self.#assertCurrent(epoch, signal);
        if (!record.agent) {
          const message = sdkMessage(inputAtoms.slice(record.resumeAgentId ? lease.historyCount : 0).map(atom => atom.block));
          const sdk = await Promise.race([self.#sdkValue(), record.stoppedPromise]);
          self.#assertCurrent(epoch, signal);
          record.storeSession ??= randomUUID();
          const directory = join(await self.#stateRoot(true), record.storeSession); record.directory = directory;
          await self.#resumeRoot(true);
          if (record.resumeAgentId) await self.#directory(record.storeSession);
          else { await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, 'cwd'), { mode: 0o700 }); await mkdir(join(directory, 'store'), { mode: 0o700 }); await self.#directory(record.storeSession); }
          if (record.stopped) throw record.stopError ?? fresh();
          self.#assertCurrent(epoch, signal);
          record.store = new sdk.JsonlLocalAgentStore(join(directory, 'store'));
          const options = { apiKey: credential.apiKey, ...(credential.teamId ? { teamId: credential.teamId } : {}), model: selection,
            systemPrompt: system, tools: ['mcp'], mcpServers: {},
            local: { cwd: join(directory, 'cwd'), store: record.store, settingSources: [], enableAgentRetries: false, customTools: self.#customTools(record) } };
          if (record.resumeAgentId) {
            if (typeof sdk.Agent.resume !== 'function') throw new CursorError('当前 Cursor SDK 不能恢复已完成的会话，请新建聊天。', 501, 'cursor_checkpoint_unsupported');
            const document = await record.store.agents.get({ agentId: record.resumeAgentId });
            const ref = document?.latestCheckpoint;
            if (document?.agentId !== record.resumeAgentId || document.status !== 'idle' || document.activeRunId != null
              || resolve(document.cwd) !== resolve(directory, 'cwd') || ref?.schemaVersion !== 1
              || !(await record.store.checkpoints.get({ agentId: record.resumeAgentId, blobId: ref.rootBlobId }))?.length) throw fresh();
          }
          self.#assertCurrent(epoch, signal); if (record.stopped) throw record.stopError ?? fresh();
          const creating = Promise.resolve(record.resumeAgentId ? sdk.Agent.resume(record.resumeAgentId, options) : sdk.Agent.create(options));
          void creating.then(agent => { if (record.stopped) agent.close(); }).catch(() => {});
          record.agent = await Promise.race([creating, record.stoppedPromise]);
          if (record.stopped) { record.agent.close(); throw fresh(); }
          self.#assertCurrent(epoch, signal);
          await self.#send(record, message, selection);
        } else if (record.finished) {
          await self.#send(record, sdkMessage(inputAtoms.slice(lease.historyCount).map(atom => atom.block)), selection);
        } else {
          for (const atom of inputAtoms.slice(lease.historyCount)) {
            const call = record.pending.get(atom.block.tool_use_id);
            if (!call?.returned) throw fresh();
            record.pending.delete(atom.block.tool_use_id); call.resolve(sdkResult(atom.block.content));
          }
        }
        if (record.stopped) throw fresh();
        for (const event of sourceEvent({ type: 'message_start', message: { type: 'message', role: 'assistant', content: [] } })) yield event;
        let callId = null;
        while (!record.stopped) {
          const item = await record.queue.next();
          if (!item) throw record.stopError ?? fresh();
          if (item.type === 'error') throw item.error;
          if (item.type === 'usage') { reported.push(item.usage); continue; }
          if (item.type === 'text') {
            const block = { type: 'text', text: item.text }; emitted.push({ role: 'assistant', block });
            for (const event of sourceEvent({ type: 'content_block_start', index, content_block: block })) yield event;
            for (const event of sourceEvent({ type: 'content_block_stop', index: index++ })) yield event;
          } else if (item.type === 'tool') { callId = item.callId; break; }
          else if (item.type === 'finished') { finalUsage = item.usage; break; }
        }
        if (record.stopped) throw fresh();
        const nextHandle = CURSOR_RESPONSES_STATE_PREFIX + randomBytes(32).toString('base64url');
        const expected = [...inputAtoms, ...emitted], nextLease = { record, calls: [], used: false };
        if (callId) {
          const call = record.pending.get(callId); if (!call) throw fresh();
          expected.push({ role: 'assistant', block: { type: 'tool_use', id: callId, name: call.tool, input: call.args } });
        }
        nextLease.historyCount = expected.length; nextLease.historyHash = digest(expected);
        if (record.stateHashes.size >= 4096) throw new CursorError('Cursor 会话状态数量已达上限，请新建聊天。', 409, 'cursor_session_limit');
        record.stateHashes.add(digest(nextHandle));
        if (!callId) await self.#saveCheckpoint(record, nextLease, nextHandle);
        self.#assertCurrent(epoch, signal); if (record.stopped) throw record.stopError ?? fresh();
        record.latest = nextLease; record.handles.add(nextHandle); self.#handles.set(nextHandle, nextLease);
        for (const event of sourceEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: nextHandle } })) yield event;
        for (const event of sourceEvent({ type: 'content_block_stop', index: index++ })) yield event;
        if (callId) {
          const call = record.pending.get(callId);
          if (!call) throw fresh();
          const block = { type: 'tool_use', id: callId, name: call.tool, input: call.args };
          call.returned = true; nextLease.calls.push(callId);
          for (const event of sourceEvent({ type: 'content_block_start', index, content_block: block })) yield event;
          for (const event of sourceEvent({ type: 'content_block_stop', index: index++ })) yield event;
        }
        usage = record.crossHttp ? null : finalUsage ?? sumUsage(reported);
        if (callId) record.crossHttp = true;
        for (const event of sourceEvent({ type: 'message_delta', delta: { stop_reason: callId ? 'tool_use' : 'end_turn' } })) yield event;
        for (const event of sourceEvent({ type: 'message_stop' })) yield event;
        record.busy = false; finishedHttp = true; cleanup(); self.#expire(record);
        resolveUsage(usage);
        yield conversion.finish(usage);
      } catch (error) {
        resolveUsage(usage); await self.#stop(record, error);
        const safe = safeError(error, credential.apiKey); terminalError = safe;
        yield conversion.event('response.failed', { response: conversion.response('failed', null,
          { message: safe.message, type: safe.status >= 500 ? 'server_error' : 'invalid_request_error', code: safe.code, param: null }) });
      } finally { cleanup(); if (!finishedHttp) { resolveUsage(usage); await self.#stop(record); } }
    };
    const iterator = events();
    if (parsed.stream !== true) {
      let complete;
      for await (const event of iterator) if (['response.completed', 'response.failed'].includes(event.type)) complete = event.response;
      const response = complete?.status === 'failed' ? denied(terminalError) : Response.json(complete);
      response.bridgeUsage = bridgeUsage; response.bridgeModel = model.upstream; return response;
    }
    const stream = new ReadableStream({
      async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encodeResponsesEvent(next.value)); },
      cancel() { stop(); cleanup(); resolveUsage(null); void iterator.return().catch(() => {}); },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
    response.bridgeUsage = bridgeUsage; response.bridgeModel = model.upstream; return response;
  }
  async close() {
    this.#closed = true;
    this.#epoch++;
    await Promise.allSettled([...this.#sessions].map(record => this.#stop(record, fresh(), { preserveCheckpoint: record.finished && Boolean(record.checkpointFile) })));
    await this.#ioTail;
  }
  async cancelAll() {
    this.#epoch++;
    await Promise.allSettled([...this.#sessions].map(record => this.#stop(record, new CursorError('Cursor 活跃会话已取消，请新建聊天。', 409, 'cursor_session_cancelled'))));
    await this.#io(async () => {
      let root;
      try { root = await this.#resumeRoot(); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of await readdir(root).catch(() => [])) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const file = join(root, name);
        let sessionId;
        try { const info = await lstat(file); if (!info.isSymbolicLink() && info.size <= 400000) sessionId = JSON.parse(await readFile(file, 'utf8')).storeSession; } catch {}
        await unlink(file).catch(() => {});
        if (UUID.test(sessionId)) await this.#removeDirectory(join(this.stateDir, 'cursor-sdk', sessionId));
      }
    });
  }
}
