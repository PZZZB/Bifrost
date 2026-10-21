[CmdletBinding()]
param(
    [string]$SourceDirectory = $PSScriptRoot,
    [string]$ReportPath
)

# Deploys scripts and shortcuts only. It never imports/invokes the mode core.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($true)
$product = 'CodexWithGateway.ClaudeModeShortcuts'
$toolNames = @('Switch-ClaudeMode.ps1', 'ClaudeModeCore.ps1')
$shortcutSpecs = @(@{ Name = 'Claude - Account.lnk'; Mode = 'Account' }, @{ Name = 'Claude - CodeBuddy.lnk'; Mode = 'CodeBuddy' })
$changes = @(); $committed = @(); $shell = $null; $lock = $null; $report = $null; $reportTarget = $null
$installStage = 'Initialize'

# These fields are safe to copy out of a failed guest installation. Native
# exception messages, paths, script text, and stacks never enter the report.
function Get-ShortcutFailureDiagnostic($Failure, [string]$Stage) {
    $stages = @('Initialize', 'ResolvePaths', 'ValidateReportPath', 'ValidateSources', 'CreateToolsDirectory',
        'ValidateToolsOwner', 'SecureToolsDirectory', 'AcquireLock', 'ReadManifest', 'CheckOwnership',
        'PrepareScriptFiles', 'CreateShortcutCom', 'WriteShortcut', 'ReadbackPreparedShortcut',
        'PrepareShortcutFiles', 'PrepareManifest', 'CheckCommit', 'CommitFiles', 'VerifyInstalledFiles',
        'ReadbackInstalledShortcuts', 'WriteReport', 'Unknown')
    if ($Stage -cnotin $stages) { $Stage = 'Unknown' }
    $codes = @{
        '工具目录是重解析点，安装已停止。' = 'TOOLS_DIRECTORY_REPARSE'
        '工具目录所有者不匹配，安装已停止。' = 'TOOLS_OWNER_MISMATCH'
        '安装目标在读取时发生变化，未覆盖。' = 'TARGET_CHANGED_DURING_READ'
        '安装目标被其他程序修改，未覆盖。' = 'TARGET_CHANGED_BEFORE_WRITE'
        '同名目标不是普通文件，已保留。' = 'TARGET_NOT_REGULAR_FILE'
        '发现未知或已修改的同名文件，已保留；请先重命名该文件。' = 'OWNERSHIP_CONFLICT'
        '当前用户的桌面目录不可用。' = 'DESKTOP_UNAVAILABLE'
        '结果文件路径无效。' = 'REPORT_PATH_INVALID'
        '系统 Windows PowerShell 不可用。' = 'POWERSHELL_UNAVAILABLE'
        '安装路径包含不受支持的字符。' = 'PATH_CHARACTERS_UNSUPPORTED'
        '来源目录缺少有效的模式切换脚本。' = 'SOURCE_SCRIPT_MISSING'
        '来源脚本存在语法错误，未安装。' = 'SOURCE_SCRIPT_SYNTAX'
        '来源脚本在读取时发生变化，未安装。' = 'SOURCE_CHANGED'
        '快捷方式安装清单不是普通文件。' = 'MANIFEST_NOT_REGULAR_FILE'
        '快捷方式安装清单损坏，现有文件已保留。' = 'MANIFEST_INVALID_JSON'
        '已有安装清单不匹配，现有文件已保留。' = 'MANIFEST_MISMATCH'
        '安装目标在归属验证后发生变化，未覆盖。' = 'TARGET_CHANGED_AFTER_OWNERSHIP'
        '快捷方式读回验证失败，未安装。' = 'SHORTCUT_READBACK_FAILED'
        '快捷方式在归属验证后发生变化，未覆盖。' = 'SHORTCUT_CHANGED_AFTER_OWNERSHIP'
        '安装清单已变化，未覆盖。' = 'MANIFEST_CHANGED'
        '安装目标已变化，未覆盖。' = 'TARGET_CHANGED_BEFORE_COMMIT'
        '安装写入验证失败。' = 'WRITE_VERIFICATION_FAILED'
        '已安装快捷方式读回不匹配。' = 'INSTALLED_SHORTCUT_MISMATCH'
    }
    $exception = $Failure.Exception
    $code = $codes[[string]$exception.Message]
    for ($depth = 0; $depth -lt 8 -and $null -ne $exception.InnerException; $depth++) { $exception = $exception.InnerException }
    if (-not $code) {
        $code = if ($exception -is [UnauthorizedAccessException] -or $exception -is [Security.SecurityException]) { 'NATIVE_ACCESS_DENIED' }
            elseif ($exception -is [Runtime.InteropServices.COMException]) { 'NATIVE_COM_ERROR' }
            elseif ($exception -is [IO.IOException]) { 'NATIVE_IO_ERROR' }
            else { 'UNEXPECTED_ERROR' }
    }
    $type = $exception.GetType().FullName
    if ($type -cnotmatch '^[A-Za-z0-9_.+`]{1,160}$') { $type = 'System.Exception' }
    return [ordered]@{ Stage = $Stage; ErrorCode = $code; NativeErrorType = $type; HResult = [int]$exception.HResult }
}

function Get-ShortcutHash([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}
function Get-ShortcutBytesHash([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '') }
    finally { $hash.Dispose() }
}
function Set-ShortcutPrivateDirectory([string]$Path) {
    $script:installStage = 'CreateToolsDirectory'
    $item = [IO.Directory]::CreateDirectory($Path)
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '工具目录是重解析点，安装已停止。' }
    $script:installStage = 'ValidateToolsOwner'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ((Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $allowed) { throw '工具目录所有者不匹配，安装已停止。' }
    $script:installStage = 'SecureToolsDirectory'
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in $allowed) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))) }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }
}
function New-ShortcutChange([string]$Path, [byte[]]$Bytes) {
    $hash = Get-ShortcutHash $Path
    $before = if ($null -ne $hash) { [IO.File]::ReadAllBytes($Path) } else { $null }
    if ((Get-ShortcutHash $Path) -cne $hash -or ($null -ne $hash -and (Get-ShortcutBytesHash $before) -cne $hash)) { throw '安装目标在读取时发生变化，未覆盖。' }
    return [ordered]@{ Path = $Path; ExpectedHash = $hash; Before = $before; Bytes = $Bytes; WrittenHash = $null }
}
function Write-ShortcutBytes([string]$Path, [byte[]]$Bytes, $ExpectedHash) {
    if ((Get-ShortcutHash $Path) -cne $ExpectedHash) { throw '安装目标被其他程序修改，未覆盖。' }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.claude-mode-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        if ((Get-ShortcutHash $Path) -cne $ExpectedHash) { throw '安装目标被其他程序修改，未覆盖。' }
        if ($null -ne $ExpectedHash) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force } }
}
function Assert-ShortcutOwner([string]$Path, [string]$Name, $Records, [bool]$Owned) {
    if ([IO.Directory]::Exists($Path) -or ([IO.File]::Exists($Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw '同名目标不是普通文件，已保留。' }
    if (-not [IO.File]::Exists($Path)) { return $null }
    $record = @($Records | Where-Object { $_.Name -ceq $Name })
    $hash = Get-ShortcutHash $Path
    if (-not $Owned -or $record.Count -ne 1 -or $record[0].SHA256 -notmatch '^[A-Fa-f0-9]{64}$' -or $hash -ine $record[0].SHA256) { throw '发现未知或已修改的同名文件，已保留；请先重命名该文件。' }
    return $hash
}
function Read-ShortcutRecord([string]$Path) {
    $link = $shell.CreateShortcut($Path)
    try { return [ordered]@{ Target = [string]$link.TargetPath; Arguments = [string]$link.Arguments; WorkingDirectory = [string]$link.WorkingDirectory } }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
}
function Write-ShortcutReport($Value) {
    if ($reportTarget) {
        Write-ShortcutBytes $reportTarget $utf8.GetBytes(($Value | ConvertTo-Json -Depth 8)) (Get-ShortcutHash $reportTarget)
    }
}

try {
    $installStage = 'ResolvePaths'
    $SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
    $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
    if (-not $desktop -or -not [IO.Directory]::Exists($desktop)) { throw '当前用户的桌面目录不可用。' }
    $tools = Join-Path $env:LOCALAPPDATA 'CodexWithGateway\tools'
    $launcher = Join-Path $tools 'Switch-ClaudeMode.ps1'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($ReportPath) {
        $installStage = 'ValidateReportPath'
        $candidate = [IO.Path]::GetFullPath($ReportPath)
        $protected = @((Join-Path $tools 'claude-mode-shortcuts.install.json'), (Join-Path $tools 'claude-mode-install.lock')) +
            @($toolNames | ForEach-Object { Join-Path $tools $_ }) + @($shortcutSpecs | ForEach-Object { Join-Path $desktop $_.Name })
        if ([IO.Path]::GetExtension($candidate) -ine '.json' -or $candidate -iin $protected -or
            -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($candidate)) -or [IO.Directory]::Exists($candidate) -or
            ([IO.File]::Exists($candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw '结果文件路径无效。' }
        $reportTarget = $candidate
    }
    $installStage = 'ResolvePaths'
    if (-not [IO.File]::Exists($powershell)) { throw '系统 Windows PowerShell 不可用。' }
    if (($launcher + $powershell + $desktop) -match '["\r\n\0]') { throw '安装路径包含不受支持的字符。' }
    $sources = @()
    $installStage = 'ValidateSources'
    foreach ($name in $toolNames) {
        $path = Join-Path $SourceDirectory $name
        if (-not [IO.File]::Exists($path) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '来源目录缺少有效的模式切换脚本。' }
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
        if ($errors.Count) { throw '来源脚本存在语法错误，未安装。' }
        $hash = Get-ShortcutHash $path; $bytes = [IO.File]::ReadAllBytes($path)
        if ((Get-ShortcutHash $path) -cne $hash -or (Get-ShortcutBytesHash $bytes) -cne $hash) { throw '来源脚本在读取时发生变化，未安装。' }
        $sources += [ordered]@{ Name = $name; SHA256 = $hash; Bytes = $bytes }
    }
    Set-ShortcutPrivateDirectory $tools
    $installStage = 'AcquireLock'
    $lock = [IO.File]::Open((Join-Path $tools 'claude-mode-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $installStage = 'ReadManifest'
    $manifestPath = Join-Path $tools 'claude-mode-shortcuts.install.json'
    if ([IO.Directory]::Exists($manifestPath) -or ([IO.File]::Exists($manifestPath) -and ((Get-Item -LiteralPath $manifestPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw '快捷方式安装清单不是普通文件。' }
    $manifestHash = Get-ShortcutHash $manifestPath; $previous = $null
    if ($manifestHash) {
        try { $previous = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json } catch { throw '快捷方式安装清单损坏，现有文件已保留。' }
        if ($previous.Product -cne $product -or $previous.Version -ne 1 -or $previous.DesktopPath -ine $desktop -or
            @($previous.InstalledFilesHashes).Count -ne 2 -or @($previous.Shortcuts).Count -ne 2) { throw '已有安装清单不匹配，现有文件已保留。' }
    }
    $installStage = 'CheckOwnership'
    $ownedHashes = @{}
    foreach ($source in $sources) { $path = Join-Path $tools $source.Name; $ownedHashes[$path] = Assert-ShortcutOwner $path $source.Name $previous.InstalledFilesHashes ([bool]$previous) }
    foreach ($spec in $shortcutSpecs) { $path = Join-Path $desktop $spec.Name; $ownedHashes[$path] = Assert-ShortcutOwner $path $spec.Name $previous.Shortcuts ([bool]$previous) }
    $installStage = 'PrepareScriptFiles'
    foreach ($source in $sources) {
        $path = Join-Path $tools $source.Name; $change = New-ShortcutChange $path $source.Bytes
        if ($change.ExpectedHash -cne $ownedHashes[$path]) { throw '安装目标在归属验证后发生变化，未覆盖。' }
        $changes += $change
    }
    $installStage = 'CreateShortcutCom'
    $shell = New-Object -ComObject WScript.Shell
    $shortcutRecords = @()
    foreach ($spec in $shortcutSpecs) {
        $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1}' -f $launcher, $spec.Mode
        $temporary = Join-Path $desktop ('.claude-mode-' + [guid]::NewGuid().ToString('N') + '.lnk')
        try {
            $installStage = 'WriteShortcut'
            $link = $shell.CreateShortcut($temporary)
            try {
                $link.TargetPath = $powershell; $link.Arguments = $arguments; $link.WorkingDirectory = $tools
                $link.Description = if ($spec.Mode -ceq 'Account') { '切换为 Claude 原账号模式' } else { '切换为 CodeBuddy 网关模式' }
                $link.WindowStyle = 7; $link.IconLocation = $powershell + ',0'; $link.Save()
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
            $installStage = 'ReadbackPreparedShortcut'
            $readback = Read-ShortcutRecord $temporary
            if ($readback.Target -ine $powershell -or $readback.Arguments -cne $arguments -or $readback.WorkingDirectory -ine $tools) { throw '快捷方式读回验证失败，未安装。' }
            $installStage = 'PrepareShortcutFiles'
            $path = Join-Path $desktop $spec.Name; $change = New-ShortcutChange $path ([IO.File]::ReadAllBytes($temporary))
            if ($change.ExpectedHash -cne $ownedHashes[$path]) { throw '快捷方式在归属验证后发生变化，未覆盖。' }
            $changes += $change
            $shortcutRecords += [ordered]@{ Name = $spec.Name; Target = $powershell; Arguments = $arguments; SHA256 = (Get-ShortcutHash $temporary) }
        } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force } }
    }
    $installStage = 'PrepareManifest'
    $installedHashes = @($sources | ForEach-Object { [ordered]@{ Name = $_.Name; SHA256 = $_.SHA256 } })
    $manifest = [ordered]@{ Product = $product; Version = 1; DesktopPath = $desktop; InstalledFilesHashes = $installedHashes; Shortcuts = $shortcutRecords }
    $manifestChange = New-ShortcutChange $manifestPath $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 8))
    if ($manifestChange.ExpectedHash -cne $manifestHash) { throw '安装清单已变化，未覆盖。' }
    $changes += $manifestChange
    $installStage = 'CheckCommit'
    foreach ($change in $changes) { if ((Get-ShortcutHash $change.Path) -cne $change.ExpectedHash) { throw '安装目标已变化，未覆盖。' } }
    foreach ($change in $changes) {
        $installStage = 'CommitFiles'
        $change.WrittenHash = Get-ShortcutBytesHash $change.Bytes; $committed += $change
        Write-ShortcutBytes $change.Path $change.Bytes $change.ExpectedHash
        $installStage = 'VerifyInstalledFiles'
        if ((Get-ShortcutHash $change.Path) -cne $change.WrittenHash) { throw '安装写入验证失败。' }
    }
    $installStage = 'ReadbackInstalledShortcuts'
    foreach ($record in $shortcutRecords) {
        $readback = Read-ShortcutRecord (Join-Path $desktop $record.Name)
        if ($readback.Target -ine $record.Target -or $readback.Arguments -cne $record.Arguments) { throw '已安装快捷方式读回不匹配。' }
    }
    $report = [ordered]@{ Success = $true; Changed = $true; DesktopPath = $desktop;
        Shortcuts = @($shortcutRecords | ForEach-Object { [ordered]@{ Name = $_.Name; Target = $_.Target; Arguments = $_.Arguments } }); InstalledFilesHashes = $installedHashes }
    $installStage = 'WriteReport'
    Write-ShortcutReport $report
    $report | ConvertTo-Json -Depth 8
} catch {
    # Capture the original operation before rollback/reporting can fail too.
    $diagnostic = Get-ShortcutFailureDiagnostic $_ $installStage
    $rollbackBlocked = $false
    for ($index = $committed.Count - 1; $index -ge 0; $index--) {
        $change = $committed[$index]
        try {
            $currentHash = Get-ShortcutHash $change.Path
            if ($currentHash -ceq $change.ExpectedHash) { continue }
            if ($currentHash -cne $change.WrittenHash) { throw '目标已变化。' }
            if ($null -eq $change.ExpectedHash) { Remove-Item -LiteralPath $change.Path -Force }
            else { Write-ShortcutBytes $change.Path $change.Before $change.WrittenHash }
        } catch { $rollbackBlocked = $true }
    }
    $message = if ($rollbackBlocked) { '安装未完成，部分目标发生并发变化，已保留；请检查现有快捷方式。' } else { '安装未完成；未知或已修改的同名文件已保留。请核对来源文件和安装清单。' }
    $report = [ordered]@{ Success = $false; Error = $message; Stage = $diagnostic.Stage; ErrorCode = $diagnostic.ErrorCode;
        NativeErrorType = $diagnostic.NativeErrorType; HResult = $diagnostic.HResult; RollbackBlocked = $rollbackBlocked }
    try { Write-ShortcutReport $report } catch { [Console]::Error.WriteLine('结果报告无法写入。') }
    $report | ConvertTo-Json -Depth 4
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    if ($lock) { $lock.Dispose() }
}
