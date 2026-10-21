import net from 'node:net';
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BridgeError } from './storage.mjs';

const PIPE_PATTERN = /^\\\\\.\\pipe\\with-\d+(?:-[A-Za-z0-9_-]+)?$/;
const COMMANDS = new Set(['login_status', 'get_agent_models', 'chat_send', 'chat_cancel',
  'session_create', 'mcp_list', 'mcp_status_get', 'mcp_json_get', 'mcp_install_custom',
  'mcp_json_update', 'mcp_set_disabled', 'mcp_uninstall', 'workspace_list', 'background_agent_status_get']);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DISCOVERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$withCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$withOwnedPids = @{}
$withCandidatePids = @(WITH_CANDIDATE_PIDS)
foreach ($withCandidatePid in $withCandidatePids) {
  try {
    $withProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $withCandidatePid)
    if ($withProcess.Name -notin @('With.exe', 'with_daemon.exe')) { continue }
    $withOwner = Invoke-CimMethod -InputObject $withProcess -MethodName GetOwnerSid -ErrorAction Stop
    if ($withOwner.Sid -eq $withCurrentSid) { $withOwnedPids[[string]$withProcess.ProcessId] = $true }
  } catch {}
}
ConvertTo-Json -InputObject @($withOwnedPids.Keys) -Compress
`;

const unavailable = () => new BridgeError('无法连接当前用户的 With 桌面。', 503, 'with_unavailable');
const disconnected = () => new BridgeError('With 桌面连接已断开。', 503, 'with_disconnected');
const aborted = () => new BridgeError('With 请求已取消。', 499, 'with_aborted');
const mcpConflict = () => new BridgeError('With 已存在不同的网关 MCP 配置，未覆盖。', 409, 'with_mcp_conflict');

function singleMcpConfig(value) {
  let config;
  try { config = typeof value === 'string' ? JSON.parse(value) : structuredClone(value); } catch {}
  const entries = config && typeof config === 'object' && !Array.isArray(config) ? Object.entries(config) : [];
  const [name, server] = entries[0] ?? [];
  if (entries.length !== 1 || !/^[A-Za-z0-9_.-]{1,64}$/.test(name ?? '') || !server || typeof server !== 'object'
      || Array.isArray(server) || !(typeof server.url === 'string' && server.url || typeof server.command === 'string' && server.command)) {
    throw new BridgeError('With MCP 配置必须包含一个服务名称及其连接配置。', 400, 'with_invalid_mcp_config');
  }
  return { config, name, server };
}

function withoutMcp(document, name) {
  const copy = { ...document, mcpServers: { ...document.mcpServers } };
  delete copy.mcpServers[name];
  return copy;
}

export async function discoverWithPipes({ execFileImpl = execFile, readdirImpl = readdir, platform = process.platform } = {}) {
  if (platform !== 'win32') throw unavailable();
  let output;
  try {
    const names = await readdirImpl('\\\\.\\pipe\\');
    const candidates = [...new Set(names.flatMap((name) => /^with-(\d+)(?:-[A-Za-z0-9_-]+)?$/.exec(name)?.[1] ?? []))];
    if (!candidates.length) return [];
    output = await new Promise((resolve, reject) => execFileImpl('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DISCOVERY_SCRIPT.replace('WITH_CANDIDATE_PIDS', candidates.join(','))],
      { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => error ? reject(unavailable()) : resolve(stdout)));
    const parsed = JSON.parse(String(output).replace(/^\uFEFF/, '').trim());
    const owners = new Set((Array.isArray(parsed) ? parsed : [parsed]).map(String).filter((pid) => /^\d+$/.test(pid)));
    return [...new Set(names.flatMap((name) => {
      const match = /^with-(\d+)(?:-[A-Za-z0-9_-]+)?$/.exec(name);
      return match && owners.has(match[1]) ? [`\\\\.\\pipe\\${name}`] : [];
    }))].sort();
  } catch { throw unavailable(); }
}

// Same-user native pipe transport. It never opens a TCP listener, exports an
// authorization token, or uses the reserved Electron shell-control segments.
export class WithDaemonClient {
  #socket = null;
  #starting = null;
  #buffer = Buffer.alloc(0);
  #scope = 0;
  #nextId = 1;
  #pending = new Map();
  #channels = new Map();
  #lifecycle = 0;
  #ensuringMcp = Promise.resolve();

  constructor({ discoverPipes = discoverWithPipes, connectImpl = (path) => net.createConnection(path),
    timeoutMs = 12000, streamTimeoutMs = 3600000, maxFrameBytes = MAX_FRAME_BYTES,
    mcpConfigPath = join(homedir(), '.bg-agent', 'config-with-app', 'mcp_config.json'), readFileImpl = readFile } = {}) {
    Object.assign(this, { discoverPipes, connectImpl, timeoutMs, streamTimeoutMs, maxFrameBytes, mcpConfigPath, readFileImpl });
  }

  get connected() { return !!this.#socket && !this.#socket.destroyed && this.#socket.writable; }

  async start() {
    if (this.connected) return;
    if (this.#starting) return this.#starting;
    const starting = this.#start(this.#lifecycle);
    this.#starting = starting;
    try { await starting; } finally { if (this.#starting === starting) this.#starting = null; }
  }

  async #start(lifecycle) {
    let paths;
    try { paths = await this.discoverPipes(); } catch { throw unavailable(); }
    if (!Array.isArray(paths)) throw unavailable();
    for (const path of paths) {
      if (this.#lifecycle !== lifecycle) throw aborted();
      if (!PIPE_PATTERN.test(path)) continue;
      let socket;
      try {
        socket = this.connectImpl(path);
        socket.on('error', () => {});
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(unavailable()), this.timeoutMs);
          const finish = (error) => {
            clearTimeout(timer); socket.off('connect', onConnect); socket.off('error', onError);
            error ? reject(error) : resolve();
          };
          const onConnect = () => finish();
          const onError = () => finish(unavailable());
          socket.once('connect', onConnect); socket.once('error', onError);
        });
        if (this.#lifecycle !== lifecycle) throw aborted();
        this.#socket = socket; this.#buffer = Buffer.alloc(0);
        this.#scope = randomInt(0x20000000, 0x7fffffff);
        socket.on('data', (bytes) => { if (this.#socket === socket) this.#data(bytes); });
        socket.on('error', () => this.#fail(socket, disconnected()));
        socket.on('close', () => this.#fail(socket, disconnected()));
        return;
      } catch {
        if (socket) { socket.on('error', () => {}); socket.destroy(); }
        if (this.#lifecycle !== lifecycle) throw aborted();
      }
    }
    throw unavailable();
  }

  #data(bytes) {
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length < 4 || length > this.maxFrameBytes) {
        const socket = this.#socket;
        this.#fail(socket, new BridgeError('With 返回了无效的数据帧。', 502, 'with_invalid_frame'));
        socket?.destroy(); return;
      }
      if (this.#buffer.length < length + 4) return;
      const frame = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      if (frame.readUInt32LE(0) !== this.#scope) continue;
      let message;
      try { message = JSON.parse(frame.subarray(4).toString('utf8')); } catch { continue; }
      if (!message || typeof message.id !== 'number') continue;
      if (typeof message.channel === 'number') {
        const channel = this.#channels.get(`${message.id}:${message.channel}`);
        if (channel) {
          try {
            for (const event of Array.isArray(message.payload) ? message.payload : [message.payload]) channel.onEvent?.(event);
          } catch { channel.finish(new BridgeError('With 事件处理失败。', 502, 'with_event_error')); }
        }
        continue;
      }
      const request = this.#pending.get(message.id);
      if (request) {
        let data = message.data;
        const businessResult = data && typeof data === 'object' && typeof data.code === 'number' && Object.hasOwn(data, 'data');
        if (message.ok !== true || businessResult && data.code !== 0) {
          request.finish(new BridgeError(`With 接口 ${request.command} 拒绝了请求。`, 502, 'with_rpc_error'));
        } else request.finish(null, businessResult ? data.data : data);
      }
    }
  }

  #send(message) {
    if (!this.connected) throw disconnected();
    const raw = Buffer.from(JSON.stringify(message));
    if (raw.length + 4 > this.maxFrameBytes) throw new BridgeError('With 请求过大。', 413, 'with_request_too_large');
    const frame = Buffer.allocUnsafe(raw.length + 8);
    frame.writeUInt32LE(raw.length + 4, 0); frame.writeUInt32LE(this.#scope, 4); raw.copy(frame, 8);
    this.#socket.write(frame);
  }

  #request(command, args, { signal, timeoutMs = this.timeoutMs, id = this.#nextId++ } = {}) {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => finish(aborted());
      const finish = (error, data) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve(data);
      };
      this.#pending.set(id, { command, finish });
      if (timeoutMs > 0) timer = setTimeout(() => finish(new BridgeError(`With 接口 ${command} 超时。`, 504, 'with_timeout')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.#send({ id, type: 'invoke', cmd: command, args }); } catch (error) { finish(error); }
    });
  }

  async invoke(command, args = {}, options = {}) {
    if (!COMMANDS.has(command) || command === 'chat_send') {
      throw new BridgeError('不支持的 With 接口。', 400, 'with_unsupported_command');
    }
    if (options.signal?.aborted) throw aborted();
    await this.start();
    // Never retry a possibly delivered request: session/MCP mutations and chat
    // cancellation must not be duplicated after a connection failure.
    return this.#request(command, args, options);
  }

  async status(options) {
    let authenticated = false;
    try {
      const data = await this.invoke('login_status', {}, options);
      authenticated = data?.success === true;
      const modelAvailable = authenticated && (await this.models(options)).some((model) => model.id === 'claude-opus-5.5' && model.available);
      return { connected: true, authenticated, modelAvailable, error: null };
    } catch (error) {
      return { connected: this.connected, authenticated, modelAvailable: false,
        error: error instanceof BridgeError ? error.message : '无法读取 With 登录状态。' };
    }
  }

  async models(options) {
    const data = await this.invoke('get_agent_models', {}, options);
    if (!Array.isArray(data?.models)) throw new BridgeError('With 模型目录格式无效。', 502, 'with_invalid_models');
    return data.models.map((model) => ({ id: model.model_name, name: model.display_name || model.model_name,
      available: !model.error })).filter((model) => typeof model.id === 'string');
  }

  // onEvent receives individual AGUI events. Keep the returned channel open
  // beyond the invoke acknowledgement; the daemon can emit later events.
  // close()/AbortSignal only release this subscription. Use cancel() explicitly
  // to stop an actual backend turn once its session/message IDs are known.
  chatSend(params, { onEvent, signal, timeoutMs = this.streamTimeoutMs } = {}) {
    const id = this.#nextId++, channelId = this.#nextId++;
    const key = `${id}:${channelId}`;
    let active = true, registered = false, resolveClosed, rejectClosed;
    const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    closed.catch(() => {});
    const onAbort = () => finish(aborted());
    const finish = (error) => {
      if (!active) return;
      active = false; this.#channels.delete(key); signal?.removeEventListener('abort', onAbort);
      if (registered && this.connected) {
        try { this.#send({ type: 'channel_close', channel: channelId }); } catch {}
      }
      error ? rejectClosed(error) : resolveClosed();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = (async () => {
      if (signal?.aborted) throw aborted();
      await this.start();
      if (!active || signal?.aborted) throw aborted();
      this.#channels.set(key, { onEvent, finish }); registered = true;
      return this.#request('chat_send', { params: { ...params, extra_headers: {
        ...params?.extra_headers, 'X-Internal-Oauth-Type': 'oauth2' } }, onEvent: `__CHANNEL__:${channelId}` },
      { signal, timeoutMs, id });
    })();
    started.catch((error) => finish(error));
    return { started, closed, close: () => finish() };
  }

  cancel(params, options) { return this.invoke('chat_cancel', { params }, options); }
  createSession(args = {}, options) { return this.invoke('session_create', args, options); }
  installMcp(configJson, options) {
    const { config } = singleMcpConfig(configJson);
    return this.invoke('mcp_install_custom', { config_json: JSON.stringify(config) }, options);
  }

  async #mcpDocument() {
    let text;
    try { text = await this.readFileImpl(this.mcpConfigPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return { mcpServers: {} };
      throw new BridgeError('无法核实 With 本地 MCP 配置，未修改。', 503, 'with_mcp_unreadable');
    }
    try {
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('large');
      const document = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      if (!document || typeof document !== 'object' || Array.isArray(document) || !document.mcpServers
          || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers)) throw new Error('shape');
      return document;
    } catch { throw new BridgeError('With 本地 MCP 配置格式无效，未修改。', 503, 'with_mcp_unreadable'); }
  }

  // The desktop's list metadata omits config and local_id for file-only MCPs.
  // Compare the verified owner file in memory, including authorization headers;
  // never return that document or overwrite a different existing entry.
  ensureMcp(expected, options) {
    const parsed = singleMcpConfig(expected);
    const lifecycle = this.#lifecycle;
    const operation = this.#ensuringMcp.then(() => this.#ensureMcp(parsed, options, lifecycle));
    this.#ensuringMcp = operation.catch(() => {});
    return operation;
  }

  async #ensureMcp({ config, name, server }, options, lifecycle) {
    const checkActive = () => {
      if (this.#lifecycle !== lifecycle || options?.signal?.aborted) throw aborted();
    };
    checkActive();
    const existing = (document) => {
      if (!Object.hasOwn(document.mcpServers, name)) return false;
      if (!isDeepStrictEqual(document.mcpServers[name], server)) throw mcpConflict();
      return true;
    };
    const before = await this.#mcpDocument();
    checkActive();
    if (existing(before)) return { installed: true, reused: true };
    const metadata = await this.invoke('mcp_list', { filter: { installed: true, search_keyword: name },
      page_size: 30, page_num: 1, remote: false, workspace_uuid: null, agent_id: null, mcp_common_list: false }, options);
    if (!Array.isArray(metadata?.list)) throw new BridgeError('无法核实 With MCP 目录，未修改。', 503, 'with_mcp_unreadable');
    if (metadata.list.some((item) => item.server_name === name)) throw mcpConflict();
    const latest = await this.#mcpDocument();
    checkActive();
    if (existing(latest)) return { installed: true, reused: true };
    if (!isDeepStrictEqual(before, latest)) {
      throw new BridgeError('With MCP 配置在准备期间发生变化，未修改。', 409, 'with_mcp_config_changed');
    }
    await this.installMcp(config, options);
    const after = await this.#mcpDocument();
    if (!Object.hasOwn(after.mcpServers, name) || !isDeepStrictEqual(after.mcpServers[name], server)
        || !isDeepStrictEqual(withoutMcp(before, name), withoutMcp(after, name))) {
      throw new BridgeError('With MCP 注册读回验证失败。', 502, 'with_mcp_verification_failed');
    }
    return { installed: true, reused: false };
  }

  #fail(socket, error) {
    if (this.#socket !== socket) return;
    this.#socket = null; this.#buffer = Buffer.alloc(0);
    for (const request of [...this.#pending.values()]) request.finish(error);
    for (const channel of [...this.#channels.values()]) channel.finish(error);
  }

  close() {
    this.#lifecycle++; this.#starting = null;
    const socket = this.#socket;
    if (socket) { this.#fail(socket, disconnected()); socket.destroy(); }
  }
}
