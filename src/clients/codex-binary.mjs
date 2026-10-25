import { execFile } from 'node:child_process';
import { join, win32 } from 'node:path';

const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$nativeCodex = $null
if ($env:CODEX_BINARY) {
  if ([IO.Path]::GetExtension($env:CODEX_BINARY) -ine '.exe' -or -not (Test-Path -LiteralPath $env:CODEX_BINARY -PathType Leaf)) { throw 'Configured Codex executable is unavailable.' }
  $nativeCodex = (Resolve-Path -LiteralPath $env:CODEX_BINARY).ProviderPath
} else {
  $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
  if ($codexCommand -and [IO.Path]::GetExtension($codexCommand.Source) -ieq '.exe') { $nativeCodex = $codexCommand.Source }
  if (-not $nativeCodex) {
    $candidates = @()
    if ($codexCommand) {
      $npmDirectory = Split-Path -Parent $codexCommand.Source
      $candidates += @(Get-ChildItem -Path (Join-Path $npmDirectory 'node_modules\\@openai\\codex*\\vendor\\*\\codex\\codex.exe') -File -ErrorAction SilentlyContinue)
      $candidates += @(Get-ChildItem -Path (Join-Path $npmDirectory 'node_modules\\@openai\\codex\\node_modules\\@openai\\codex*\\vendor\\*\\codex\\codex.exe') -File -ErrorAction SilentlyContinue)
    }
    $candidates += @(Get-ChildItem -Path "$env:LOCALAPPDATA\\OpenAI\\Codex\\bin\\*\\codex.exe" -File -ErrorAction SilentlyContinue)
    $candidate = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($candidate) { $nativeCodex = $candidate.FullName }
  }
}
if (-not $nativeCodex) { throw 'Install the native Codex CLI or set CODEX_BINARY to codex.exe.' }
[Console]::Out.Write($nativeCodex)
`;

/** Resolve the native executable so cmd/PowerShell shims cannot corrupt TOML argument quoting. */
export async function resolveCodexBinary({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return process.env.CODEX_BINARY || 'codex';
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await new Promise((resolve, reject) => execFileImpl(powershell,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8192 }, (error, stdout) => {
      if (error) reject(new Error('未找到原生 Codex CLI；请安装或将 CODEX_BINARY 指向 codex.exe。')); else resolve(String(stdout).trim());
    }));
  if (!win32.isAbsolute(result) || win32.extname(result).toLowerCase() !== '.exe' || /[\x00-\x1f\x7f]/.test(result)) throw new Error('Codex 可执行文件路径无效。');
  return result;
}
