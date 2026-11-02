[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Official', 'Gateway')][string]$Mode,
    [string]$StateDirectory,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Show-CodexModeFeedback([string]$Text, [switch]$Failure) {
    if ($Quiet) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = if ($Failure) { [Windows.Forms.MessageBoxIcon]::Error } else { [Windows.Forms.MessageBoxIcon]::Information }
        [void][Windows.Forms.MessageBox]::Show($Text, 'Codex 模式切换', [Windows.Forms.MessageBoxButtons]::OK, $icon)
    } catch {
        $shell = New-Object -ComObject WScript.Shell
        try { [void]$shell.Popup($Text, 0, 'Codex 模式切换', $(if ($Failure) { 16 } else { 64 })) }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
}

function ConvertTo-CodexModeArgument([string]$Value) {
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

$process = $null
$failureMessage = '切换失败。请在 Bifröst 管理网页检查 Codex 接入和账号状态后重试。'
try {
    if (-not $StateDirectory) {
        $StateDirectory = if ($env:BRIDGE_STATE_DIR) { $env:BRIDGE_STATE_DIR } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-account-bridge' }
    }
    $StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
    $projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    $corePath = Join-Path $PSScriptRoot 'switch-codex-mode.mjs'
    if (-not [IO.File]::Exists($corePath)) {
        $failureMessage = 'Codex 切换程序缺失。请更新 Bifröst 后重新安装快捷方式。'
        throw 'Core missing.'
    }
    $servicePath = Join-Path $StateDirectory 'service\service.json'
    $nodeBinary = $null
    if ([IO.File]::Exists($servicePath)) {
        $service = Get-Content -LiteralPath $servicePath -Raw | ConvertFrom-Json
        $nodeBinary = [string]$service.NodeBinary
    }
    if (-not $nodeBinary) { $nodeBinary = (Get-Command node -CommandType Application -ErrorAction Stop).Source }
    if (-not [IO.Path]::IsPathRooted($nodeBinary) -or -not [IO.File]::Exists($nodeBinary)) {
        $failureMessage = '未找到已配置的 Node.js。请修复 Bifröst 运行环境后重试。'
        throw 'Node missing.'
    }
    $requestedMode = $Mode.ToLowerInvariant()
    $arguments = @($corePath, '--mode', $requestedMode, '--state-dir', $StateDirectory)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $nodeBinary
    $start.Arguments = (($arguments | ForEach-Object { ConvertTo-CodexModeArgument $_ }) -join ' ')
    $start.WorkingDirectory = $projectDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Node could not start.' }
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $output = $outputTask.GetAwaiter().GetResult()
    $errorOutput = $errorTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        try {
            $failure = $errorOutput | ConvertFrom-Json
            if ($failure.success -eq $false -and $failure.error.code -cmatch '^(?:mode_[a-z_]+|INTEGRATION_[A-Z_]+)$' -and
                $failure.error.message -is [string] -and $failure.error.message.Length -le 1200 -and $failure.error.message.Trim()) {
                $failureMessage = $failure.error.message
            }
        } catch { }
        throw 'Mode command failed.'
    }
    $result = $output | ConvertFrom-Json
    if ($result.success -ne $true -or $result.mode -cne $requestedMode -or
        $result.changed -isnot [bool] -or $result.restartRequired -ne $true -or
        $result.transport -cnotin @('management-api', 'local-config')) { throw 'Unexpected result.' }
    $modeName = if ($requestedMode -ceq 'official') { '原生模式' } else { 'Bifröst 网关模式' }
    Show-CodexModeFeedback ('已保存为 ' + $modeName + '。' + "`n`n" + '请完全退出 Codex 后重新打开，新连接才会生效。')
    $result | ConvertTo-Json -Compress
} catch {
    try { Show-CodexModeFeedback $failureMessage -Failure } catch {}
    [Console]::Error.WriteLine($failureMessage)
    exit 1
} finally {
    if ($process) { $process.Dispose() }
}
