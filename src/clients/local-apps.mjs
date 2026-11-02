import { execFile, spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { BridgeError } from '../storage.mjs';

const CODEX_APP_ID = 'OpenAI.Codex_2p2nqsd0c76g0!App';
const APPS = Object.freeze([
  { id: 'codex', name: 'Codex' },
  { id: 'codebuddy', name: 'CodeBuddy', executableName: 'CodeBuddy CN.exe', folders: ['CodeBuddy CN', 'CodeBuddy'] },
  { id: 'workbuddy', name: 'WorkBuddy', executableName: 'WorkBuddy.exe', folders: ['WorkBuddy'] },
  { id: 'claude', name: 'Claude' },
  { id: 'cursor', name: 'Cursor', executableName: 'Cursor.exe', folders: ['cursor', 'Cursor'] },
]);
const failure = (message, code = 'client_launch_unavailable', status = 409) => new BridgeError(message, status, code);
const absolute = value => typeof value === 'string' && win32.isAbsolute(value) && !/[\x00-\x1f\x7f"<>|]/.test(value);
const executable = (spec, path) => absolute(path) && win32.basename(path).toLowerCase() === spec.executableName?.toLowerCase();
const powershell = env => win32.join(absolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const discoveryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$codex = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -ceq 'OpenAI.Codex_2p2nqsd0c76g0' })
$claude = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc' -or ($_.Name -ceq 'AnthropicPBC.Claude' -and $_.Publisher -match '(?i)Anthropic') })
$claudeId = $null
if ($claude.Count -eq 1) {
  $manifest = Get-AppxPackageManifest -Package $claude[0].PackageFullName
  $entries = @($manifest.Package.Applications.Application | Where-Object { $_.Executable -match '(?i)(?:^|[\\/])Claude\.exe$' -and $_.Id -match '^[A-Za-z0-9._-]+$' })
  if ($entries.Count -eq 1) { $claudeId = $claude[0].PackageFamilyName + '!' + $entries[0].Id }
}
$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$records = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^(CodeBuddy(?: CN)?(?: \(User\))?|WorkBuddy(?: [0-9.]+)?|Cursor(?: \(User\))?)$' } | Select-Object DisplayName,InstallLocation,DisplayIcon)
[ordered]@{codexInstalled=($codex.Count -eq 1);claudeAppId=$claudeId;records=$records} | ConvertTo-Json -Depth 4 -Compress
`;

function appxAllowed(id, value) {
  return id === 'codex' ? value === CODEX_APP_ID
    : id === 'claude' && typeof value === 'string' && /^(?:Claude_pzs8sxrjxfjjc|AnthropicPBC\.Claude_[A-Za-z0-9]+)![A-Za-z0-9._-]+$/.test(value);
}

/** Read controlled installation metadata. No client config, login or process arguments are inspected. */
export async function discoverLocalApps({ platform = process.platform, env = process.env, execFileImpl = execFile,
  lstatImpl = lstat } = {}) {
  if (platform !== 'win32') return APPS.map(app => ({ id: app.id, name: app.name, installed: false,
    reason: '当前节点尚未实现此系统的桌面启动适配。' }));
  let metadata = {}, discoveryFailed = false;
  try {
    const stdout = await new Promise((resolve, reject) => execFileImpl(powershell(env),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(discoveryScript, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 65536 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    metadata = JSON.parse(String(stdout));
  } catch { discoveryFailed = true; }
  const records = Array.isArray(metadata.records) ? metadata.records : [];
  return Promise.all(APPS.map(async spec => {
    if (spec.id === 'codex' || spec.id === 'claude') {
      const appId = spec.id === 'codex' && metadata.codexInstalled === true ? CODEX_APP_ID : metadata.claudeAppId;
      return { id: spec.id, name: spec.name, installed: appxAllowed(spec.id, appId),
        ...(appxAllowed(spec.id, appId) ? { appId } : { reason: discoveryFailed ? '应用安装状态未能确认。' : '此电脑未找到可启动的官方应用；虚拟机应用由其所在电脑管理。' }) };
    }
    const candidates = [];
    for (const row of records) {
      const label = String(row.DisplayName ?? '');
      const matches = spec.id === 'codebuddy' ? /^CodeBuddy(?: CN)?(?: \(User\))?$/i.test(label)
        : spec.id === 'workbuddy' ? /^WorkBuddy(?: [0-9.]+)?$/i.test(label) : /^Cursor(?: \(User\))?$/i.test(label);
      if (!matches) continue;
      if (absolute(row.InstallLocation)) candidates.push(win32.join(row.InstallLocation, spec.executableName));
      if (typeof row.DisplayIcon === 'string') candidates.push(row.DisplayIcon.replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, ''));
    }
    for (const folder of spec.folders) {
      candidates.push(win32.join('D:\\', folder, spec.executableName));
      for (const base of [env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']]) {
        if (absolute(base)) candidates.push(win32.join(base, folder, spec.executableName));
      }
    }
    for (const path of [...new Set(candidates)]) {
      if (!executable(spec, path)) continue;
      try { const stat = await lstatImpl(path); if (stat.isFile() && !stat.isSymbolicLink()) return { id: spec.id, name: spec.name, installed: true, executable: path }; }
      catch {}
    }
    return { id: spec.id, name: spec.name, installed: false, reason: '此电脑未找到受支持的应用安装。' };
  }));
}

export function createLocalApps({ platform = process.platform, env = process.env, spawnImpl = spawn,
  discoverImpl = options => discoverLocalApps(options), cacheMs = 30000, now = Date.now, ...discoveryOptions } = {}) {
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 300000 || typeof now !== 'function') throw new TypeError('Invalid application inventory cache.');
  let cached = null, expiresAt = 0, pending = null;
  async function discover() {
    let discovered;
    try { discovered = await discoverImpl({ platform, env, ...discoveryOptions }); } catch { discovered = []; }
    return APPS.map(spec => {
      const matches = Array.isArray(discovered) ? discovered.filter(row => row?.id === spec.id) : [];
      const row = matches.length === 1 ? matches[0] : null;
      const target = row?.installed === true && (spec.executableName ? executable(spec, row.executable)
        ? { executable: row.executable } : null : appxAllowed(spec.id, row.appId) ? { appId: row.appId } : null);
      return { id: spec.id, name: spec.name, installed: row?.installed === true, launchSupported: platform === 'win32' && Boolean(target),
        ...(target ? { target } : {}),
        ...(!target || platform !== 'win32' ? { reason: platform !== 'win32' ? '当前节点尚未实现此系统的桌面启动适配。'
          : row?.reason || '尚未发现唯一且受支持的本机应用启动入口。' } : {}) };
    });
  }
  async function inventory(force = false) {
    if (!force && cached && now() < expiresAt) return cached;
    if (pending) {
      await pending;
      if (!force) return cached;
    }
    pending = discover().then(rows => { cached = rows; expiresAt = now() + cacheMs; return rows; });
    try { return await pending; } finally { pending = null; }
  }
  return {
    async snapshot() { return (await inventory()).map(({ target, ...row }) => row); },
    async launch(id) {
      if (!APPS.some(app => app.id === id)) throw failure('客户端类型不存在。', 'client_not_found', 404);
      const row = (await inventory(true)).find(app => app.id === id);
      if (!row.launchSupported) throw failure(row.reason || '此客户端暂不能自动启动。');
      const binary = row.target.executable ?? win32.join(absolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows', 'explorer.exe');
      const args = row.target.appId ? [`shell:AppsFolder${win32.sep}${row.target.appId}`] : [];
      try {
        const child = spawnImpl(binary, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
        child.unref();
      } catch { throw failure('应用未能启动，请检查安装后重试。', 'client_launch_failed', 503); }
      return { id, launched: true, configurationChanged: false, message: '已请求打开应用；现有会话和进程由客户端管理。' };
    },
  };
}

export const launchLocalApp = (id, options = {}) => createLocalApps(options).launch(id);
