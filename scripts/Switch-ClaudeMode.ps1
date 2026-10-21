[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Account', 'CodeBuddy')][string]$Mode,
    [switch]$Quiet,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

function Show-ClaudeModeFeedback([string]$Text, [switch]$Failure) {
    if ($Quiet) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = if ($Failure) { [Windows.Forms.MessageBoxIcon]::Error } else { [Windows.Forms.MessageBoxIcon]::Information }
        [void][Windows.Forms.MessageBox]::Show($Text, 'Claude 模式切换', [Windows.Forms.MessageBoxButtons]::OK, $icon)
    } catch {
        # Also works when a hidden PowerShell has no console to display errors.
        $shell = New-Object -ComObject WScript.Shell
        try { [void]$shell.Popup($Text, 0, 'Claude 模式切换', $(if ($Failure) { 16 } else { 64 })) }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
}

function Test-ClaudeDesktopRunning {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    foreach ($process in @(Get-Process -Name Claude -ErrorAction SilentlyContinue)) {
        if ($process.SessionId -ne $session) { continue }
        try { $path = [string]$process.Path } catch { $path = '' }
        # A same-session process whose path cannot be inspected is treated as
        # running. Never terminate it or start another instance speculatively.
        if (-not $path -or $path -match '(?i)\\WindowsApps\\(?:Claude_|AnthropicPBC\.Claude_)') { return $true }
    }
    return $false
}

function Find-ClaudeDesktopAppId {
    $packages = @(Get-AppxPackage -ErrorAction Stop | Where-Object {
        -not $_.IsResourcePackage -and -not $_.IsFramework -and
        ($_.PackageFamilyName -ceq 'Claude_pzs8sxrjxfjjc' -or
         ($_.Name -ceq 'AnthropicPBC.Claude' -and $_.Publisher -match '(?i)Anthropic'))
    })
    if ($packages.Count -ne 1) { throw '未找到唯一的官方 Claude MSIX 应用。请安装或修复 Claude 后重试。' }
    $family = [string]$packages[0].PackageFamilyName
    $apps = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.AppID -like ($family + '!*') -and $_.Name -ceq 'Claude' })
    if ($apps.Count -eq 1 -and $apps[0].AppID -match '^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$') { return [string]$apps[0].AppID }
    $manifest = Get-AppxPackageManifest -Package $packages[0].PackageFullName -ErrorAction Stop
    $ids = @($manifest.Package.Applications.Application | Where-Object {
        $_.Executable -match '(?i)(?:^|[\\/])Claude\.exe$' -and $_.Id -match '^[A-Za-z0-9._-]+$'
    } | ForEach-Object { $family + '!' + [string]$_.Id } | Select-Object -Unique)
    if ($ids.Count -ne 1) { throw '无法确定官方 Claude 的启动入口。模式已保存，请从开始菜单打开 Claude。' }
    return $ids[0]
}

function Get-ClaudeModeFailureMessage([string]$Message) {
    switch -CaseSensitive ($Message) {
        'Claude mode switch could not finish. Private recovery state is retained; concurrent edits will not be overwritten.' { return '切换未完成，恢复记录已保留。请稍后重试；现有并发修改不会被覆盖。' }
        'Claude mode switch was refused or rolled back. Private configuration contents were not logged.' { return '模式切换已停止或回滚。请重新安装快捷方式或联系维护者检查配置。' }
    }
    $known = @('模式切换核心文件缺失，请重新安装这两个快捷方式。', '模式切换核心文件无效，请重新安装快捷方式。',
        '模式未能保存，请重试。', '未找到唯一的官方 Claude MSIX 应用。请安装或修复 Claude 后重试。',
        '无法确定官方 Claude 的启动入口。模式已保存，请从开始菜单打开 Claude。')
    if ($Message -cin $known) { return $Message }
    return '模式切换失败，请重新安装快捷方式或联系维护者。'
}

$saved = $false
try {
    $corePath = Join-Path $PSScriptRoot 'ClaudeModeCore.ps1'
    if (-not [IO.File]::Exists($corePath)) { throw '模式切换核心文件缺失，请重新安装这两个快捷方式。' }
    . $corePath
    if (-not (Get-Command Set-ClaudeDesktopMode -CommandType Function -ErrorAction SilentlyContinue)) { throw '模式切换核心文件无效，请重新安装快捷方式。' }
    $result = Set-ClaudeDesktopMode -Mode $Mode
    if (-not $result -or $result.Success -ne $true) { throw '模式未能保存，请重试。' }
    $saved = $true; $running = $false; $started = $false
    if ($NoLaunch) { $message = '模式已设好。下次打开 Claude 时生效。' }
    elseif (Test-ClaudeDesktopRunning) {
        $running = $true
        $message = '模式已设好，请从托盘退出 Claude 后重开。'
    } else {
        $appId = Find-ClaudeDesktopAppId
        # This visible launch is the action requested by the user's shortcut.
        Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList @('shell:AppsFolder\' + $appId) -WindowStyle Normal -ErrorAction Stop | Out-Null
        $started = $true
        $message = if ($Mode -ceq 'Account') { '已设为原账号模式，正在打开 Claude。' } else { '已设为 CodeBuddy 网关模式，正在打开 Claude。' }
    }
    Show-ClaudeModeFeedback $message
    [ordered]@{ Success = $true; Mode = $Mode; DeploymentMode = [string]$result.DeploymentMode; Changed = [bool]$result.Changed;
        RestartRequired = [bool]$result.RestartRequired; AlreadyRunning = $running; Started = $started } | ConvertTo-Json -Compress
} catch {
    $message = Get-ClaudeModeFailureMessage ([string]$_.Exception.Message)
    if ($saved) { $message = '模式已保存，但 Claude 未能打开。' + "`n" + $message }
    try { Show-ClaudeModeFeedback $message -Failure }
    catch { [Console]::Error.WriteLine('Claude 模式切换失败。请重新安装快捷方式。') }
    [Console]::Error.WriteLine($message)
    exit 1
}
