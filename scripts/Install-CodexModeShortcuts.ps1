[CmdletBinding()]
param(
    [string]$DesktopPath,
    [string]$StateDirectory
)

# This installer only creates shortcuts. It never runs a mode switch.
$ErrorActionPreference = 'Stop'
$shell = $null
$prepared = @()

function ConvertTo-CodexShortcutArgument([string]$Value) {
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Read-CodexShortcut([string]$Path) {
    $link = $shell.CreateShortcut($Path)
    try { return [ordered]@{ Target = [string]$link.TargetPath; Arguments = [string]$link.Arguments; WorkingDirectory = [string]$link.WorkingDirectory } }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
}

function Get-CodexShortcutHash([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

try {
    if (-not $DesktopPath) { $DesktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop) }
    if (-not $DesktopPath) { throw '桌面目录不可用。请指定 -DesktopPath。' }
    $desktop = [IO.Path]::GetFullPath($DesktopPath)
    if (-not $StateDirectory) {
        $StateDirectory = if ($env:BRIDGE_STATE_DIR) { $env:BRIDGE_STATE_DIR } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-account-bridge' }
    }
    $StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
    $project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    $launcher = Join-Path $PSScriptRoot 'Switch-CodexMode.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not [IO.File]::Exists($launcher) -or -not [IO.File]::Exists($powershell)) { throw '模式切换脚本或 Windows PowerShell 不可用。' }
    if (($desktop + $StateDirectory + $launcher) -match '["\x00-\x1f]') { throw '安装路径包含不支持的字符。' }
    [void][IO.Directory]::CreateDirectory($desktop)
    $shell = New-Object -ComObject WScript.Shell
    $icon = (Join-Path $env:SystemRoot 'System32\imageres.dll') + ',102'
    try {
        $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1
        if ($package) {
            $codex = Join-Path $package.InstallLocation 'app\Codex.exe'
            if ([IO.File]::Exists($codex)) { $icon = $codex + ',0' }
        }
    } catch { }
    $specs = @(
        @{ Name = 'Codex - 原生模式.lnk'; Mode = 'Official' },
        @{ Name = 'Codex - 网关模式.lnk'; Mode = 'Gateway' }
    )
    foreach ($spec in $specs) {
        $path = Join-Path $desktop $spec.Name
        if ([IO.Directory]::Exists($path) -or ([IO.File]::Exists($path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw ('发现同名非普通文件，已保留：' + $spec.Name)
        }
        $prefix = '-NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
            (ConvertTo-CodexShortcutArgument $launcher) + ' -Mode ' + $spec.Mode + ' -StateDirectory '
        $arguments = $prefix + (ConvertTo-CodexShortcutArgument $StateDirectory)
        $hash = Get-CodexShortcutHash $path
        if ($null -ne $hash) {
            $existing = Read-CodexShortcut $path
            $ownedPattern = '^' + [regex]::Escape($prefix) + '"[^"\x00-\x1f]+"$'
            if ($existing.Target -ine $powershell -or $existing.Arguments -notmatch $ownedPattern) {
                throw ('发现陌生同名快捷方式，未覆盖：' + $spec.Name)
            }
        }
        $prepared += [ordered]@{ Name = $spec.Name; Path = $path; Target = $powershell; Arguments = $arguments; ExpectedHash = $hash; Temporary = $null }
    }
    foreach ($record in $prepared) {
        $record.Temporary = Join-Path $desktop ('.codex-mode-' + [guid]::NewGuid().ToString('N') + '.lnk')
        $link = $shell.CreateShortcut($record.Temporary)
        try {
            $link.TargetPath = $record.Target
            $link.Arguments = $record.Arguments
            $link.WorkingDirectory = $project
            $link.WindowStyle = 7
            $link.Description = '保存 Codex 连接模式；完全退出 Codex 后重开生效。'
            $link.IconLocation = $icon
            $link.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
        $check = Read-CodexShortcut $record.Temporary
        if ($check.Target -ine $record.Target -or $check.Arguments -cne $record.Arguments -or $check.WorkingDirectory -ine $project) {
            throw '快捷方式读回校验失败，未安装。'
        }
    }
    foreach ($record in $prepared) {
        if ((Get-CodexShortcutHash $record.Path) -cne $record.ExpectedHash) { throw '快捷方式已被其他程序修改，未覆盖。' }
    }
    foreach ($record in $prepared) {
        if ((Get-CodexShortcutHash $record.Path) -cne $record.ExpectedHash) { throw '快捷方式已被其他程序修改，未覆盖。' }
        if ($null -eq $record.ExpectedHash) { [IO.File]::Move($record.Temporary, $record.Path) }
        else { [IO.File]::Replace($record.Temporary, $record.Path, [Management.Automation.Language.NullString]::Value) }
    }
    [ordered]@{ success = $true; desktopPath = $desktop; stateDirectory = $StateDirectory;
        shortcuts = @($prepared | ForEach-Object { [ordered]@{ name = $_.Name; path = $_.Path; target = $_.Target; arguments = $_.Arguments } }) } | ConvertTo-Json -Depth 5
} finally {
    foreach ($record in $prepared) {
        if ($record.Temporary -and [IO.File]::Exists($record.Temporary)) { Remove-Item -LiteralPath $record.Temporary -Force }
    }
    if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
