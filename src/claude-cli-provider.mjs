import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { keyMatches, readBody } from './gateway.mjs';
import { ClaudeSdkWorker } from './claude-sdk-worker.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const withoutCache = value => object(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control')) : value;
const contentIdentity = content => Array.isArray(content) ? content.map(block => {
  const value = withoutCache(block);
  return value?.type === 'tool_result' && Array.isArray(value.content)
    ? { ...value, content: value.content.map(withoutCache) } : value;
}) : content;
const historyDigest = messages => digest(messages.map(message => ({ ...message, content: contentIdentity(message.content) })));
const failure = (status, message) => Response.json({ type: 'error', error: { type: status < 500
  ? 'invalid_request_error' : 'api_error', message } }, { status });
const sse = value => new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
const SESSION_HEADERS = ['x-claude-code-session-id', 'x-session-id', 'x-conversation-id',
  'x-session-affinity', 'session_id', 'session-id', 'x-opencode-session'];

class Queue {
  values = []; waiter = null; writers = []; bytes = 0; ended = false;
  async push(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    while (!this.ended && this.values.length && (this.values.length >= 256 || this.bytes + bytes > 1_048_576)) {
      await new Promise(done => this.writers.push(done));
    }
    if (this.ended) return;
    if (this.waiter) { const next = this.waiter; this.waiter = null; next(value); }
    else { this.values.push({ value, bytes }); this.bytes += bytes; }
  }
  end(errorEvent = null) {
    this.ended = true;
    if (errorEvent) {
      this.values = [{ value: errorEvent, bytes: 0 }]; this.bytes = 0;
      if (this.waiter) { const next = this.waiter; this.waiter = null; this.values = []; next(errorEvent); }
    } else if (this.waiter) { const next = this.waiter; this.waiter = null; next(null); }
    for (const done of this.writers.splice(0)) done();
  }
  next() { if (this.values.length) {
      const item = this.values.shift(); this.bytes -= item.bytes;
      for (const done of this.writers.splice(0)) done();
      return Promise.resolve(item.value);
    }
    if (this.ended) return Promise.resolve(null);
    return new Promise(resolveNext => { this.waiter = resolveNext; }); }
}

function toolMap(tools = []) {
  if (!Array.isArray(tools) || tools.length > 256) throw new Error('tools 必须是客户端工具数组，最多 256 项。');
  const native = new Map(), originals = new Set();
  for (const tool of tools) {
    if (!object(tool) || typeof tool.name !== 'string' || !tool.name || originals.has(tool.name) ||
        tool.type !== undefined && tool.type !== 'custom' || !object(tool.input_schema) ||
        Object.keys(tool).some(key => !['name', 'description', 'input_schema', 'type', 'cache_control'].includes(key))) {
      throw new Error('CLI 目前仅接受有完整 input_schema 的客户端工具；服务端工具需要单独适配。');
    }
    originals.add(tool.name);
    const simple = tool.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const name = simple === tool.name && simple.length <= 45 ? simple
      : `${simple.slice(0, 32)}_${digest(tool.name).slice(0, 12)}`;
    if (native.has(name)) throw new Error('客户端工具名映射发生冲突。');
    native.set(name, { name, original: tool.name, inputSchema: structuredClone(tool.input_schema),
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}) });
  }
  return native;
}

function validateBody(body, model) {
  if (!object(body) || body.model !== model || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 ||
      !Array.isArray(body.messages) || !body.messages.length ||
      body.messages.some(message => !object(message) || !['user', 'assistant'].includes(message.role) ||
        !(typeof message.content === 'string' || Array.isArray(message.content))) ||
      body.messages.at(-1).role !== 'user') throw new Error('模型、max_tokens 或 messages 无效。');
  const allowed = new Set(['model', 'max_tokens', 'messages', 'system', 'tools', 'stream', 'metadata',
    'thinking', 'output_config', 'cache_control', 'tool_choice']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('请求包含尚未映射到 CLI 的参数。');
  for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content) {
    const types = message.role === 'user' ? ['text', 'image', 'document', 'tool_result']
      : ['text', 'thinking', 'redacted_thinking', 'tool_use'];
    if (!object(block) || !types.includes(block.type)) throw new Error('消息包含 CLI 尚未适配的内容块。');
  }
  if (body.system !== undefined && typeof body.system !== 'string' &&
      (!Array.isArray(body.system) || body.system.some(block => block?.type !== 'text' || typeof block.text !== 'string'))) {
    throw new Error('CLI system 只接受文本或 text 块。');
  }
  if (body.tool_choice !== undefined && (!object(body.tool_choice) || body.tool_choice.type !== 'auto' ||
      Object.keys(body.tool_choice).some(key => key !== 'type'))) {
    throw new Error('CLI 当前仅支持不含额外限制的自动工具选择。');
  }
  if (body.thinking !== undefined && (!object(body.thinking) ||
      !['adaptive', 'disabled'].includes(body.thinking.type) ||
      body.thinking.display !== undefined && !['summarized', 'omitted'].includes(body.thinking.display) ||
      body.thinking.type === 'disabled' && Object.keys(body.thinking).length !== 1 ||
      Object.keys(body.thinking).some(key => !['type', 'display'].includes(key)))) {
    throw new Error('CLI 当前仅映射 adaptive 或 disabled 思考模式。');
  }
  if (body.output_config !== undefined && (!object(body.output_config) ||
      Object.keys(body.output_config).some(key => key !== 'effort') ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.output_config.effort))) {
    throw new Error('CLI output_config 当前仅支持 effort。');
  }
  toolMap(body.tools);
}

function systemText(body) {
  return typeof body.system === 'string' ? body.system : (body.system ?? []).map(block => block.text).join('\n');
}
function initialInput(messages) {
  if (messages.length === 1) return structuredClone(messages[0].content);
  // The SDK accepts user input, not arbitrary assistant-history replacement.
  // Importing a chat therefore requires an explicit history representation once.
  const history = messages.slice(0, -1).flatMap(message => {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    return [{ type: 'text', text: `[Imported ${message.role} history]` }, ...content.map(block =>
      ['text', 'image', 'document'].includes(block.type) ? structuredClone(block)
        : { type: 'text', text: JSON.stringify(block) }), { type: 'text', text: '[/Imported history]' }];
  });
  const latest = messages.at(-1).content;
  return [...history, ...(typeof latest === 'string' ? [{ type: 'text', text: latest }] : structuredClone(latest))];
}
function mcpResult(result) {
  const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content;
  if (!Array.isArray(content)) throw new Error('工具结果必须是文本或内容块。');
  return { content: content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
    if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string' &&
        typeof block.source.media_type === 'string') return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    throw new Error('CLI 工具结果尚未适配这个内容块，未丢弃后继续。');
  }), ...(result.is_error === true ? { isError: true } : {}) };
}

/** Official SDK/CLI sessions. Native tools are disabled; client tools return through MCP. */
export class ClaudeCliHub {
  constructor({ binary, configDir, profileDir, stateDir, mcpPort = 3436,
    workerFactory = options => new ClaudeSdkWorker(options), authStatus,
    idleMs = 60 * 60_000, clock = Date.now } = {}) {
    if (![binary, configDir, profileDir, stateDir].every(value => typeof value === 'string' && value) ||
        !Number.isInteger(mcpPort) || mcpPort < 0 || mcpPort > 65535) throw new Error('CLI 后端路径或端口无效。');
    Object.assign(this, { binary: resolve(binary), configDir: resolve(configDir), profileDir: resolve(profileDir),
      stateDir: resolve(stateDir), mcpPort, workerFactory, idleMs, clock });
    this.authStatus = authStatus ?? (() => this.readAuthStatus());
    this.runs = new Map(); this.saved = new Map(); this.starting = new Set(); this.runReservations = new Set();
    this.closed = false; this.authCache = null;
  }

  async start() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try {
      const records = JSON.parse(await readFile(join(this.stateDir, 'sessions.json'), 'utf8'));
      if (Array.isArray(records)) for (const record of records) if (typeof record?.id === 'string' &&
          /^[a-f0-9-]{36}$/.test(record.id) && typeof record.nativeId === 'string' &&
          typeof record.historyHash === 'string' && record.pending !== true) this.saved.set(record.id, record);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('CLI 会话索引不可读取。'); }
    this.mcpServer = http.createServer((req, res) => { void this.handleMcp(req, res); });
    await new Promise((yes, no) => {
      this.mcpServer.once('error', no);
      this.mcpServer.listen(this.mcpPort, '127.0.0.1', () => { this.mcpServer.off('error', no); yes(); });
    });
    this.mcpPort = this.mcpServer.address().port;
    this.timer = setInterval(() => {
      for (const run of this.runs.values()) if (!run.turn && this.clock() - run.touched > this.idleMs) {
        void this.stopRun(run, run.expected.size ? 'CLI 工具结果等待超时。' : null);
      }
    }, Math.min(this.idleMs, 60_000));
    this.timer.unref();
  }

  async readAuthStatus() {
    const { buildClaudeEnvironment } = await import('./claude-sdk-worker.mjs');
    try {
      const { stdout } = await promisify(execFile)(this.binary, ['auth', 'status', '--json'], {
        cwd: this.stateDir, env: buildClaudeEnvironment({ configDir: this.configDir, profileDir: this.profileDir }),
        windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
      });
      const data = JSON.parse(stdout);
      const canonicalPath = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
      return data.loggedIn === true && data.authMethod === 'claude.ai' &&
        typeof data.configDirectory === 'string' && canonicalPath(data.configDirectory) === canonicalPath(this.configDir);
    } catch { return false; }
  }

  async status() {
    if (this.closed) return { authenticated: false, ready: false, modelAvailable: false, error: 'CLI 后端已停止。' };
    if (!this.authCache || this.authCache.until <= this.clock()) {
      if (!this.authReading) this.authReading = Promise.resolve().then(() => this.authStatus())
        .then(value => value === true, () => false).finally(() => { this.authReading = null; });
      const authenticated = await this.authReading;
      this.authCache = { authenticated, until: this.clock() + (authenticated ? 30_000 : 3000) };
    }
    return { authenticated: this.authCache.authenticated, ready: this.authCache.authenticated,
      modelAvailable: this.authCache.authenticated, transport: 'official-claude-sdk',
      error: this.authCache.authenticated ? null : '请在运行 CLI 的电脑完成独立订阅登录。' };
  }

  provider(model) {
    return { status: () => this.status(), request: request => this.request({ ...request, model }) };
  }

  async saveIndex() {
    const records = [...this.saved.values()];
    for (const run of this.runs.values()) if (run.worker.sessionId && run.historyHash) {
      const record = { id: run.id, nativeId: run.worker.sessionId, historyHash: run.historyHash,
        identity: run.identity, contextHash: run.contextHash, optionsHash: run.optionsHash,
        model: run.model, pending: Boolean(run.turn) || run.expected.size > 0 };
      const index = records.findIndex(item => item.id === record.id);
      if (index < 0) records.push(record); else records[index] = record;
    }
    const path = join(this.stateDir, 'sessions.json'), temporary = `${path}.${randomUUID()}.tmp`;
    // Serialize writes so two completed conversations cannot replace each other's index.
    this.saving = (this.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 }); await rename(temporary, path);
    });
    return this.saving;
  }

  async request({ path, body, headers, signal, model }) {
    if (path.split('?')[0] !== '/v1/messages') return failure(501, 'CLI 没有权威 count_tokens 接口。');
    if (this.closed) return failure(503, 'CLI 后端已停止。');
    try { validateBody(body, model); } catch (error) { return failure(400, error.message); }
    if (!(await this.status()).ready) return failure(503, '请先在 CLI 所在电脑完成订阅登录。');
    if (signal?.aborted) return failure(499, '请求已取消。');
    const incoming = new Headers(headers), session = SESSION_HEADERS.map(name => incoming.get(name)).find(Boolean) ?? null;
    const agent = incoming.get('x-claude-code-agent-id'), parent = incoming.get('x-claude-code-parent-agent-id');
    const identity = session || agent || parent ? digest({ session, agent, parent }) : null;
    const contextHash = digest({ model, system: contentIdentity(body.system ?? null), tools: (body.tools ?? []).map(withoutCache) });
    const optionsHash = digest({ maxTokens: body.max_tokens, effort: body.output_config?.effort,
      thinking: body.thinking });
    const prefixHash = historyDigest(body.messages.slice(0, -1)), last = body.messages.at(-1).content;
    const results = Array.isArray(last) ? last.filter(block => block?.type === 'tool_result') : [];
    const reservation = digest({ identity, contextHash, prefixHash });
    if (this.starting.has(reservation)) return failure(409, '同一 CLI 会话正在提交请求。');
    this.starting.add(reservation);
    try {
    let run, resume;
    if (results.length) {
      run = [...this.runs.values()].find(item => item.expected.has(results[0].tool_use_id));
      if (!run || run.turn || run.historyHash !== prefixHash || run.contextHash !== contextHash ||
          run.optionsHash !== optionsHash || run.identity !== identity || results.length !== last.length ||
          results.length !== run.expected.size || new Set(results.map(item => item.tool_use_id)).size !== results.length ||
          results.some(item => !run.expected.has(item.tool_use_id))) {
        return failure(409, '待返回的 CLI 工具会话不匹配或已中断，未替用户生成工具结果。');
      }
      try { for (const result of results) mcpResult(result); }
      catch (error) { return failure(400, error.message); }
    } else {
      const match = item => item.model === model && item.contextHash === contextHash &&
        item.historyHash === prefixHash && item.identity === identity;
      const candidates = body.messages.length > 1 ? [...this.runs.values()].filter(match) : [];
      if (candidates.some(item => item.turn || item.expected.size) || candidates.length > 1) {
        return failure(409, 'CLI 会话忙碌或缺少唯一会话标识。');
      }
      run = candidates[0];
      if (run && run.optionsHash !== optionsHash) {
        resume = { ...run, nativeId: run.worker.sessionId }; await this.stopRun(run); run = null;
      }
      if (!run && !resume && body.messages.length > 1) {
        const saved = [...this.saved.values()].filter(match);
        if (saved.length > 1) return failure(409, '已保存的 CLI 会话缺少唯一标识。');
        resume = saved[0];
      }
      if (!run) {
        try { run = await this.newRun({ model, identity, contextHash, optionsHash, body, resume }); }
        catch { return failure(503, '官方 CLI 会话未能启动。'); }
      }
    }
    run.touched = this.clock();
    const turn = { queue: new Queue(), body: structuredClone(body), blocks: new Map(), bytes: 0,
      message: null, stopReason: null, messageStopped: false, ended: false, signal };
    run.turn = turn;
    const abort = () => {
      turn.error = '客户端已取消 CLI 请求。';
      turn.queue.end({ type: 'error', error: { type: 'api_error', message: turn.error } });
      void this.stopRun(run, turn.error);
    };
    turn.abort = abort; signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      // An interrupted process must not resume an older, completed prefix against a newer transcript.
      await this.saveIndex();
      if (results.length) {
        for (const result of results) {
          const pending = run.calls.get(result.tool_use_id);
          const value = mcpResult(result);
          if (pending) { pending.resolve(value); run.calls.delete(result.tool_use_id); }
          else run.early.set(result.tool_use_id, { value, expected: run.expected.get(result.tool_use_id) });
        }
        run.expected.clear();
      } else await run.worker.send(resume || body.messages.length === 1 || run.hasInput
        ? structuredClone(last) : initialInput(body.messages));
      run.hasInput = true;
    } catch { await this.stopRun(run, 'CLI 输入未能提交。'); }
    const stream = new ReadableStream({
      async pull(controller) {
        const event = await turn.queue.next();
        if (event === null) controller.close(); else controller.enqueue(sse(event));
      }, cancel: () => {
        // A truncated native message may already have detached its retiring run.
        turn.queue.end();
        return this.stopRun(run, '客户端已取消 CLI 回复。');
      },
    });
    if (body.stream === true) return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    // Drain the same event path so JSON and SSE share interruption semantics.
    const reader = stream.getReader(); while (!(await reader.read()).done) { /* event state is accumulated below */ }
    if (turn.error || !turn.messageStopped) return failure(502, turn.error ?? 'CLI 没有完整结束回复。');
    return Response.json({ ...turn.message, content: [...turn.blocks.values()].map(block => block.value),
      stop_reason: turn.stopReason, stop_sequence: null });
    } finally { this.starting.delete(reservation); }
  }

  async newRun({ model, identity, contextHash, optionsHash, body, resume }) {
    if (this.runs.size + this.runReservations.size >= 6) {
      const idle = [...this.runs.values()].filter(run => !run.turn && !run.expected.size).sort((a, b) => a.touched - b.touched)[0];
      if (!idle) throw new Error('CLI sessions busy'); await this.stopRun(idle);
    }
    const id = resume?.id ?? randomUUID(), token = randomBytes(32).toString('base64url');
    if (this.runs.size + this.runReservations.size >= 6 || this.runReservations.has(id) || this.runs.has(id)) {
      throw new Error('CLI session capacity is reserved');
    }
    this.runReservations.add(id);
    try {
    const workDir = join(this.stateDir, 'runs', id); await mkdir(workDir, { recursive: true, mode: 0o700 });
    const run = { id, token, model, identity, contextHash, optionsHash, workDir,
      tools: toolMap(body.tools), calls: new Map(), early: new Map(), expected: new Map(),
      touched: this.clock(), historyHash: resume?.historyHash ?? null, hasInput: false, turn: null };
    run.worker = this.workerFactory({ binary: this.binary, cwd: workDir, configDir: this.configDir,
      profileDir: this.profileDir, model, systemPrompt: systemText(body), maxTokens: body.max_tokens,
      effort: body.output_config?.effort, thinking: body.thinking,
      mcpUrl: `http://127.0.0.1:${this.mcpPort}/mcp/${id}`, mcpKey: token,
      resumeSessionId: resume?.nativeId });
    this.runs.set(id, run); this.saved.delete(id); this.runReservations.delete(id);
    try { await run.worker.start(); }
    catch (error) { this.runs.delete(id); await run.worker.close().catch(() => {}); throw error; }
    run.pump = (async () => {
      try { for await (const event of run.worker.events) await this.workerEvent(run, event); }
      catch { await this.stopRun(run, '官方 CLI 执行失败。'); }
      finally { await this.stopRun(run, run.turn || run.expected.size ? '官方 CLI 会话已结束。' : null); }
    })();
    return run;
    } finally { this.runReservations.delete(id); }
  }

  async workerEvent(run, packet) {
    if (packet?.type === 'result') {
      if (!run.turn) return;
      if (packet.is_error || packet.subtype !== 'success') { await this.stopRun(run, '官方 CLI 没有成功结束本轮。'); return; }
      if (!run.turn.message || !run.turn.messageStopped || !run.turn.stopReason || run.turn.stopReason === 'tool_use') {
        await this.stopRun(run, 'CLI 结束标记与模型回复不匹配。'); return;
      }
      await run.turn.queue.push({ type: 'message_stop' });
      await this.finishTurn(run); return;
    }
    if (packet?.type !== 'stream_event' || packet.parent_tool_use_id) return;
    const turn = run.turn;
    if (!turn || turn.ended) return;
    const event = structuredClone(packet.event);
    if (!object(event) || typeof event.type !== 'string') { await this.stopRun(run, 'CLI 流事件格式无效。'); return; }
    turn.bytes += Buffer.byteLength(JSON.stringify(event));
    if (turn.bytes > 64 * 1024 * 1024) { await this.stopRun(run, 'CLI 回复超过本地适配器的 64 MiB 上限。'); return; }
    if (event.type !== 'ping' && event.type !== 'message_start' && (!turn.message || turn.messageStopped)) {
      await this.stopRun(run, 'CLI 消息起止顺序无效。'); return;
    }
    if (event.type === 'message_start') {
      if (turn.message || !object(event.message) || typeof event.message.id !== 'string' ||
          event.message.type !== 'message' || event.message.role !== 'assistant') {
        // Keep only schema checks and validated state; never include IDs, message content, or unknown field values.
        const diagnostic = { existing_message: Boolean(turn.message),
          previous_message_stopped: Boolean(turn.messageStopped), previous_stop_reason: turn.stopReason ?? null,
          message_object: object(event.message), id_type: typeof event.message?.id,
          message_type_valid: event.message?.type === 'message', role_valid: event.message?.role === 'assistant' };
        await this.stopRun(run, `CLI 消息起始字段或顺序无效。${JSON.stringify(diagnostic)}`); return;
      }
      turn.message = structuredClone(event.message); turn.message.content = [];
    } else if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (!Number.isSafeInteger(event.index) || event.index !== turn.blocks.size || !object(block) ||
          !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) {
        await this.stopRun(run, 'CLI 内容块类型或顺序无效。'); return;
      }
      if (block?.type === 'tool_use') {
        const prefix = 'mcp__client__', original = block.name?.startsWith(prefix) ? run.tools.get(block.name.slice(prefix.length)) : null;
        if (!original || typeof block.id !== 'string' || !block.id ||
            [...turn.blocks.values()].some(item => item.value.type === 'tool_use' && item.value.id === block.id)) {
          await this.stopRun(run, 'CLI 尝试调用未交给客户端的工具或重复的调用标识。'); return;
        }
        block.name = original.original;
      }
      turn.blocks.set(event.index, { value: structuredClone(block), partial: '', closed: false });
    } else if (event.type === 'content_block_delta') {
      const block = turn.blocks.get(event.index), delta = event.delta;
      if (!block || block.closed) { await this.stopRun(run, 'CLI 内容块顺序无效。'); return; }
      if (delta?.type === 'text_delta') block.value.text = (block.value.text ?? '') + delta.text;
      else if (delta?.type === 'thinking_delta') block.value.thinking = (block.value.thinking ?? '') + delta.thinking;
      else if (delta?.type === 'signature_delta') block.value.signature = (block.value.signature ?? '') + delta.signature;
      else if (delta?.type === 'input_json_delta') block.partial += delta.partial_json;
      else { await this.stopRun(run, 'CLI 返回了尚未适配的流内容。'); return; }
    } else if (event.type === 'content_block_stop') {
      const block = turn.blocks.get(event.index);
      if (!block || block.closed) { await this.stopRun(run, 'CLI 内容块结束顺序无效。'); return; }
      block.closed = true;
      if (block?.value.type === 'tool_use') {
        try { if (block.partial) block.value.input = JSON.parse(block.partial); }
        catch { await this.stopRun(run, 'CLI 工具参数不是有效 JSON。'); return; }
        run.expected.set(block.value.id, structuredClone(block.value));
        const pending = run.calls.get(block.value.id);
        if (pending && (pending.name !== block.value.name || digest(pending.input) !== digest(block.value.input))) {
          await this.stopRun(run, 'CLI 工具身份与 MCP 参数不一致。'); return;
        }
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) {
        if (!['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']
          .includes(event.delta.stop_reason)) { await this.stopRun(run, 'CLI 返回了未知的结束原因。'); return; }
        turn.stopReason = event.delta.stop_reason;
      }
      if (object(event.usage) && turn.message) turn.message.usage = { ...turn.message.usage, ...event.usage };
    } else if (event.type === 'message_stop') {
      if (!turn.stopReason || [...turn.blocks.values()].some(block => !block.closed) ||
          turn.stopReason !== 'tool_use' && run.expected.size) {
        await this.stopRun(run, 'CLI 回复缺少有效结束原因或完整的内容块。'); return;
      }
      turn.messageStopped = true;
      if (turn.stopReason === 'tool_use' && !run.expected.size) {
        await this.stopRun(run, 'CLI 工具结束标记没有匹配的调用。'); return;
      }
    } else if (event.type === 'error') {
      await this.stopRun(run, '官方 CLI 模型流返回错误。'); return;
    } else if (event.type !== 'ping') { await this.stopRun(run, 'CLI 返回了未知的模型流事件。'); return; }
    if (event.type === 'message_stop' && turn.stopReason === 'max_tokens') {
      // The API message is valid but truncated. The SDK may automatically continue it;
      // return this message's real limit status and retire the session to stop SDK continuation.
      turn.ended = true;
      run.historyHash = null;
      run.turn = null;
      const retiring = this.stopRun(run, 'CLI 输出达到 max_tokens；已取消自动续写。');
      try { await turn.queue.push(event); }
      finally {
        turn.queue.end();
        turn.signal?.removeEventListener('abort', turn.abort);
        await retiring;
      }
      return;
    }
    // Delay an ordinary message_stop until the SDK confirms a successful turn.
    if (event.type === 'message_stop' && turn.stopReason !== 'tool_use') return;
    await turn.queue.push(event);
    if (event.type === 'message_stop' && turn.stopReason === 'tool_use') await this.finishTurn(run);
  }

  async finishTurn(run) {
    const turn = run.turn; if (!turn || turn.ended) return;
    turn.ended = true; turn.signal?.removeEventListener('abort', turn.abort);
    run.historyHash = historyDigest([...turn.body.messages,
      { role: 'assistant', content: [...turn.blocks.values()].map(block => block.value) }]);
    run.touched = this.clock(); run.turn = null; turn.queue.end();
    try { await this.saveIndex(); } catch { /* native CLI transcripts remain; do not claim index persistence */ }
  }

  async stopRun(run, message = null) {
    if (run.stopping) return run.stopping;
    if (!message && run.worker.sessionId && run.historyHash && !run.turn && !run.expected.size) {
      this.saved.set(run.id, { id: run.id, nativeId: run.worker.sessionId, historyHash: run.historyHash,
        identity: run.identity, contextHash: run.contextHash, optionsHash: run.optionsHash, model: run.model });
    } else this.saved.delete(run.id);
    this.runs.delete(run.id);
    run.stopping = (async () => {
      if (run.turn) {
        const turn = run.turn; turn.error = message ?? 'CLI 会话已停止。';
        turn.signal?.removeEventListener('abort', turn.abort);
        turn.queue.end({ type: 'error', error: { type: 'api_error', message: turn.error } });
        run.turn = null;
      }
      for (const call of run.calls.values()) call.resolve({ isError: true,
        content: [{ type: 'text', text: message ?? 'Client tool session stopped.' }] });
      run.calls.clear(); run.expected.clear(); run.early.clear();
      await run.worker.close().catch(() => {});
      await this.saveIndex().catch(() => {});
    })();
    return run.stopping;
  }

  async handleMcp(req, res) {
    const send = (status, data) => { if (!res.destroyed && !res.writableEnded) {
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); } };
    let waiting = null;
    try {
      const match = /^\/mcp\/([a-f0-9-]{36})$/.exec(req.url ?? ''), run = match && this.runs.get(match[1]);
      const peer = req.socket.remoteAddress;
      if (!run || peer !== '127.0.0.1' ||
          req.headers.host !== `127.0.0.1:${this.mcpPort}` || req.headers.origin ||
          !keyMatches(req.headers.authorization, `Bearer ${run.token}`)) { send(403, { error: 'MCP access denied.' }); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
      const rpc = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8'));
      const response = value => ({ jsonrpc: '2.0', id: rpc.id, result: value });
      if (rpc.method === 'initialize') { send(200, response({ protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
        serverInfo: { name: 'Bifrost client tools', version: '1.0.0' }, capabilities: { tools: {} } })); return; }
      if (rpc.method?.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      if (rpc.method === 'ping') { send(200, response({})); return; }
      if (rpc.method === 'tools/list') { send(200, response({ tools: [...run.tools.values()]
        .map(({ name, description, inputSchema }) => ({ name, inputSchema, ...(description ? { description } : {}) })) })); return; }
      if (rpc.method !== 'tools/call') { send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found.' } }); return; }
      const args = rpc.params, nativeId = args?._meta?.['claudecode/toolUseId'], tool = run.tools.get(args?.name);
      if (typeof nativeId !== 'string' || !nativeId || !tool || !object(args.arguments) || run.calls.has(nativeId)) {
        send(400, { error: 'MCP tool identity is missing or invalid.' }); await this.stopRun(run, 'CLI 没有传递可核对的工具调用标识。'); return;
      }
      const early = run.early.get(nativeId);
      const expected = run.expected.get(nativeId) ?? early?.expected;
      if (expected && (expected.name !== tool.original || digest(expected.input) !== digest(args.arguments))) {
        send(403, { error: 'MCP tool mismatch.' }); await this.stopRun(run, 'CLI 工具参数不匹配。'); return;
      }
      if (early) { run.early.delete(nativeId); send(200, response(early.value)); return; }
      const value = await new Promise(resolveCall => {
        waiting = nativeId; run.calls.set(nativeId, { name: tool.original, input: args.arguments, resolve: resolveCall });
        res.once('close', () => { if (!res.writableEnded) void this.stopRun(run, 'CLI MCP 连接中断。'); });
      });
      waiting = null; send(200, response(value));
    } catch {
      send(400, { error: 'MCP request failed.' });
      if (waiting) for (const run of this.runs.values()) if (run.calls.has(waiting)) void this.stopRun(run, 'MCP 请求失败。');
    }
  }

  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    await this.saveIndex().catch(() => {});
    await Promise.allSettled([...this.runs.values()].map(run => this.stopRun(run)));
    if (this.mcpServer) await new Promise(done => { this.mcpServer.close(done); this.mcpServer.closeAllConnections(); });
  }
}
