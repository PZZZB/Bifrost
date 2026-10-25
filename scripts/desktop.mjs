import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { desktopStateDir, initializeDesktop, loadDesktopConfig, loadDesktopIdentity, desktopCredentialStore, validateDesktopConfig } from '../src/runtime/desktop-config.mjs';
import { writeJson } from '../src/storage.mjs';
import { startDesktop } from '../src/runtime/desktop.mjs';
import { fileURLToPath } from 'node:url';
import { createClientRegistry } from '../src/clients/index.mjs';

async function ensureStopped(port) {
  const busy = await new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(true)); socket.once('connect', () => finish(true)); socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
  });
  if (busy) throw new Error('请先停止正在运行的本地网关，再修改来源配置。');
}
async function keyFromStdin() {
  const chunks = []; let size = 0;
  for await (const bytes of process.stdin) { size += bytes.length; if (size > 512) throw new Error('用户 Key 格式无效。'); chunks.push(bytes); }
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (!/^bfk_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('请提供普通 Bifrost 用户的 bfk_ Key。');
  return key;
}
async function run() {
  const args = process.argv.slice(2), separator = args.indexOf('--');
  const { values, positionals } = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), allowPositionals: true,
    options: { url: { type: 'string' }, source: { type: 'string' }, 'key-stdin': { type: 'boolean' }, 'state-dir': { type: 'string' } } });
  const command = positionals[0] ?? 'help', stateDir = values['state-dir'] ? resolve(values['state-dir']) : desktopStateDir();
  if (command === 'help') {
    console.log('Bifrost Desktop (Windows)\ninit | start | key | status | login | logout | refresh | remote --url HTTPS/v1 --key-stdin\nclient-config <client> | client <client> [-- client arguments]\n远端用户 Key 仅通过标准输入接收，不放在命令参数或配置文件中。'); return;
  }
  if (process.platform !== 'win32') throw new Error('Desktop 当前使用 Windows 当前用户 DPAPI；本机测试不能替代 Windows 实际登录验收。');
  if (command === 'init') {
    const { config, identity } = await initializeDesktop(stateDir);
    console.log(`本地 API: http://127.0.0.1:${config.port}/v1\n本地 API Key（仅填到本机客户端）: ${identity.apiKey}\n启动: npm run start:desktop`); return;
  }
  const config = await loadDesktopConfig(stateDir);
  if (command === 'remote') {
    if (!values['key-stdin'] || !values.url) throw new Error('需要 --url HTTPS/v1 和 --key-stdin。');
    await ensureStopped(config.port);
    const id = values.source ?? 'bifrost';
    const source = { id, kind: 'bifrost-remote', baseUrl: values.url, protocols: ['chat-completions', 'messages'] };
    if (config.sources.some(item => item.id === id && item.kind !== source.kind)) throw new Error('来源编号已被本地来源占用。');
    const next = validateDesktopConfig({ ...config, sources: [...config.sources.filter(item => item.id !== id), source] });
    const apiKey = await keyFromStdin();
    await desktopCredentialStore(stateDir, `remote-${id}`).save({ version: 1, apiKey });
    await writeJson(join(stateDir, 'desktop.json'), next);
    console.log('远端来源已保存；启动后可在同一个 /v1/models 列表选择本地和远端模型。'); return;
  }
  const identity = await loadDesktopIdentity(stateDir);
  if (command === 'key') { console.log(identity.apiKey); return; }
  if (['client-config', 'client'].includes(command)) {
    const client = createClientRegistry().profile(positionals[1]);
    if (typeof client.configuration !== 'function') throw new Error('此客户端暂未提供配置生成器。');
    const baseUrl = `http://127.0.0.1:${config.port}/v1`;
    let model;
    if (command === 'client') {
      const response = await fetch(`${baseUrl}/models`, { redirect: 'manual', headers: { authorization: `Bearer ${identity.apiKey}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('请先启动本地网关。');
      const catalog = await response.json();
      model = catalog.data?.find(model => client.protocols.some(protocol => model.protocols.includes(protocol)))?.id;
      if (!model) throw new Error('尚无适用于此客户端的可用模型，请先完成来源授权并刷新目录。');
    }
    const settings = client.configuration({ baseUrl, model,
      tokenCommand: { command: process.execPath, args: [fileURLToPath(import.meta.url), 'key', '--state-dir', stateDir] } });
    if (command === 'client-config') { console.log(settings.text); return; }
    const clientArgs = [...settings.args, ...(separator < 0 ? [] : args.slice(separator + 1))];
    const binary = client.resolveBinary ? await client.resolveBinary() : (client.binaryEnv && process.env[client.binaryEnv]) || settings.command;
    // Direct native execution preserves structured TOML arguments, including paths with spaces.
    // Only non-secret settings are present; Codex obtains its local Key through DPAPI.
    const child = spawn(binary, clientArgs, { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); return;
  }
  if (command === 'start') {
    const runtime = await startDesktop({ stateDir, config, identity });
    console.log(`Bifrost Desktop: ${runtime.baseUrl}\n本地与远端模型合并到同一个列表。按 Ctrl+C 停止。`);
    const stop = () => { void runtime.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (!['status', 'login', 'logout', 'refresh'].includes(command)) throw new Error('未知 Desktop 命令。');
  const source = values.source ?? 'codebuddy';
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(source)) throw new Error('来源编号无效。');
  const path = command === 'status' ? '/desktop/status' : `/desktop/sources/${source}/${command}`;
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method: command === 'status' ? 'GET' : 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${identity.apiKey}`, 'content-type': 'application/json' },
      ...(command === 'status' ? {} : { body: '{}' }), signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error('无法连接本地网关，请先运行 npm run start:desktop。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '本地操作失败。');
  if (command === 'login') {
    const url = new URL(data.url);
    if (url.protocol !== 'https:') throw new Error('登录地址异常。');
    const script = `Start-Process '${url.href.replaceAll("'", "''")}'`;
    const binary = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await new Promise((resolve, reject) => execFile(binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 }, error => error ? reject(new Error('浏览器无法自动打开，请在本机重新发起授权。')) : resolve()));
    console.log('已打开公司 CodeBuddy 授权页。完成登录后，模型列表会自动更新；可运行 npm run desktop -- status 查看。');
  } else console.log(JSON.stringify(data, null, 2));
}
run().catch(error => { console.error(error.code ? `Desktop 操作未完成（${error.code}）。` : error.message); process.exitCode = 1; });
