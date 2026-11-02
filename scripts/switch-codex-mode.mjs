import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Integration } from '../src/integration.mjs';
import { CodexRpc } from '../src/rpc.mjs';
import { readJson, redact } from '../src/storage.mjs';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function settingsFor(stateDir, env) {
  let service;
  try { service = await readJson(join(stateDir, 'service', 'service.json')); }
  catch { throw failure('mode_settings_invalid', 'Bifrost 服务配置无法读取，请检查安装。'); }
  const port = Number(service?.Port ?? env.BRIDGE_PORT ?? 43155);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw failure('mode_settings_invalid', 'Bifrost 管理端口配置无效。');
  }
  const home = env.BRIDGE_CLIENT_CODEX_HOME || service?.CodexHome || env.CODEX_HOME || join(homedir(), '.codex');
  if (!isAbsolute(home)) throw failure('mode_settings_invalid', 'Codex 配置目录必须是绝对路径。');
  return { origin: `http://127.0.0.1:${port}`, home: resolve(home), binary: env.CODEX_BINARY || service?.CodexBinary || 'codex' };
}

async function responseJson(response) {
  let body;
  try { body = await response.json(); }
  catch { throw failure('mode_response_invalid', '网关返回格式无效，请打开 Bifrost 管理页检查。'); }
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string' ? redact(body.error.message) : '网关拒绝切换，请检查管理页。';
    throw failure(body?.error?.code || 'mode_switch_rejected', message);
  }
  return body;
}

async function throughManagementApi(mode, settings, fetchImpl) {
  const options = { redirect: 'error', signal: AbortSignal.timeout(15_000) };
  let page;
  try { page = await fetchImpl(`${settings.origin}/`, options); }
  catch (error) {
    // Only a refused initial connection establishes that the service is absent.
    // Never bypass a running service's rejection, timeout, or in-flight write.
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return null;
    throw failure('mode_connection_failed', '无法连接 Bifrost，请检查服务状态后重试。');
  }
  await page.body?.cancel();
  if (!page.ok) throw failure('mode_connection_failed', 'Bifrost 管理页暂不可用，请检查服务状态。');
  const cookie = page.headers.getSetCookie().map(value => value.split(';')[0])
    .find(value => /^bridge_session=[A-Za-z0-9_-]+$/.test(value));
  if (!cookie) throw failure('mode_session_missing', '无法建立本机管理会话，请检查 Bifrost 服务。');
  const status = await responseJson(await fetchImpl(`${settings.origin}/api/status`, {
    ...options, signal: AbortSignal.timeout(15_000), headers: { cookie },
  }));
  if (status.integration?.routing?.supported !== true) {
    throw failure('mode_api_unavailable', '当前网关尚未加载连接切换功能。请自行重启 Bifrost 后重试。');
  }
  if (typeof status.csrfToken !== 'string' || !/^[A-Za-z0-9_-]+$/.test(status.csrfToken)) {
    throw failure('mode_session_missing', '无法取得管理校验信息，请重试。');
  }
  const result = await responseJson(await fetchImpl(`${settings.origin}/api/integration/mode`, {
    ...options, signal: AbortSignal.timeout(45_000), method: 'POST',
    headers: { cookie, origin: settings.origin, 'x-bridge-csrf': status.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  }));
  if (result.routing?.mode !== mode) {
    throw failure('mode_not_confirmed', '网关未确认目标连接模式。请打开管理页检查当前配置。');
  }
  return { success: true, mode, changed: status.integration.routing.mode !== mode,
    restartRequired: true, transport: 'management-api' };
}

async function officialWithoutService(settings, stateDir, rpcFactory) {
  let state;
  try { state = await readJson(join(stateDir, 'bridge.json')); }
  catch { throw failure('mode_settings_invalid', 'Bifrost 本机配置无法读取，请检查安装。'); }
  if (typeof state?.gatewayKey !== 'string' || state.gatewayKey.length < 40) {
    throw failure('mode_settings_invalid', '未找到既有的 Bifrost 本机配置，请先完成网关接入。');
  }
  const rpc = rpcFactory({ binary: settings.binary, home: settings.home, cwd: homedir() });
  try {
    const integration = new Integration({ rpc, configPath: join(settings.home, 'config.toml'),
      statePath: join(stateDir, 'integration.json'), baseUrl: `${settings.origin}/backend-api/codex`,
      gatewayKey: state.gatewayKey });
    const before = await integration.inspect();
    await integration.switchMode('official');
    return { success: true, mode: 'official', changed: before.routing.mode !== 'official',
      restartRequired: true, transport: 'local-config' };
  } catch (error) {
    if (error?.code?.startsWith('INTEGRATION_')) {
      throw failure(error.code, 'Codex 配置存在冲突或未确认写入，请检查提供方配置后重试。');
    }
    throw failure('mode_local_failed', '无法通过官方 Codex 配置接口切换，请检查独立 Codex CLI 安装。');
  } finally { await rpc.close(); }
}

/** Switches saved configuration only; never starts, stops, or restarts any service. */
export async function switchCodexMode({ mode, stateDir, env = process.env, fetchImpl = fetch,
  rpcFactory = options => new CodexRpc(options) } = {}) {
  if (!['official', 'gateway'].includes(mode)) {
    throw failure('mode_invalid', '请选择 official 或 gateway。');
  }
  stateDir = resolve(stateDir || env.BRIDGE_STATE_DIR || join(homedir(), '.codex-account-bridge'));
  const settings = await settingsFor(stateDir, env);
  const result = await throughManagementApi(mode, settings, fetchImpl);
  if (result) return result;
  if (mode === 'gateway') {
    throw failure('mode_gateway_offline', '网关未启动。请先打开桌面的 Bifrost，再重试“Codex - 网关模式”。');
  }
  return officialWithoutService(settings, stateDir, rpcFactory);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--mode', '--state-dir'].includes(name) || !value || value.startsWith('--')
      || Object.hasOwn(options, name)) throw failure('mode_arguments_invalid', '用法：node scripts/switch-codex-mode.mjs --mode official|gateway [--state-dir 目录]');
    options[name] = value;
  }
  return { mode: options['--mode'], stateDir: options['--state-dir'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await switchCodexMode(parseArguments(process.argv.slice(2))))); }
  catch (error) {
    const known = typeof error?.code === 'string' && /^(?:mode_[a-z_]+|INTEGRATION_[A-Z_]+)$/.test(error.code);
    console.error(JSON.stringify({ success: false, error: { code: known ? error.code : 'mode_switch_failed',
      message: known ? redact(error.message) : '模式切换未完成，请检查 Bifrost 服务及 Codex 配置后重试。' } }));
    process.exitCode = 1;
  }
}
