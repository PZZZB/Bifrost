import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { BridgeError, redact } from './storage.mjs';

export class CodexRpc extends EventEmitter {
  constructor({ binary = 'codex', home, cwd, isolated = false, spawnImpl = spawn } = {}) {
    super(); Object.assign(this, { binary, home, cwd, isolated, spawnImpl });
    this.pending = new Map(); this.nextId = 1; this.process = null;
    this.starting = null; this.version = null;
  }

  get running() { return this.process !== null && this.process.exitCode === null && !this.process.killed; }

  async start() {
    if (this.starting) return this.starting;
    if (this.running) return;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    if (this.home) await mkdir(this.home, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    if (this.home) env.CODEX_HOME = this.home;
    if (this.isolated) {
      // B must never inherit an API key, access token, or provider override from A.
      for (const name of ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
        'OPENAI_API_BASE', 'CODEX_API_KEY', 'CODEX_AUTH_TOKEN']) delete env[name];
    }
    const args = ['app-server', '--listen', 'stdio://'];
    if (this.isolated) args.push('-c', 'cli_auth_credentials_store="auto"');
    const child = this.spawnImpl(this.binary, args, {
      env, cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.process = child;
    // Native stderr may contain authorization links. Do not copy it into HTTP logs or UI.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => { if (this.process === child) this.#message(line); });
    const fail = (error) => {
      if (this.process !== child) return;
      this.process = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer); request.reject(error);
      }
      this.pending.clear(); this.emit('stopped');
    };
    child.once('error', () => fail(new BridgeError('无法启动 Codex。请检查 CODEX_BINARY 或 Codex 安装。', 503)));
    child.once('exit', (code) => fail(new BridgeError(`Codex 后端进程已退出（${code ?? 'signal'}）。`, 503)));
    try {
      const result = await this.#request('initialize', {
        clientInfo: { name: 'codex_account_bridge', title: 'Bifrost', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.version = result.userAgent ?? null;
      this.#send({ method: 'initialized' });
    } catch (error) {
      fail(error);
      child.kill();
      throw error;
    }
  }

  #message(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new BridgeError(redact(message.error.message), 502, 'codex_rpc_error'));
      else pending.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      // This process is an auth/config service, never an agent execution host.
      this.#send({ id: message.id, error: { code: -32601, message: 'Unsupported host request' } });
    } else if (message.method) this.emit('notification', message.method, message.params);
  }

  #send(message) {
    if (!this.running) throw new BridgeError('Codex 后端未运行。', 503);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method, params = {}, timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new BridgeError(`Codex 接口 ${method} 超时。`, 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async request(method, params = {}, options = {}) {
    await this.start(); return this.#request(method, params, options.timeoutMs);
  }

  async close() {
    const child = this.process;
    if (!child) return;
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 1500).unref()),
    ]);
  }
}
