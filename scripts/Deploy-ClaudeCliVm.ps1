[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Prepare', 'Start', 'Status', 'Restore')][string]$Action = 'Plan',
    [string]$VmInvoker = 'C:\Users\jiahaoguo\Documents\Codex\2026-09-30\vps-https-www-voyracloud-com-zh\work\vm-build\Invoke-WorkspaceVm.ps1',
    [string]$GuestHome = 'C:\Users\Developer',
    [string]$BackendScript = (Join-Path $PSScriptRoot 'OfficialClaudeCli.ps1'),
    [string]$StateDir = (Join-Path $PSScriptRoot '..\.state\claude-cli-vm'),
    [string]$PlanHash
)
$ErrorActionPreference = 'Stop'
$product = 'CodexAccountBridge.OfficialClaudeCliVm'
$utf8 = New-Object Text.UTF8Encoding($false)

function Get-CliVmHash([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A CLI deployment file cannot be a reparse point.' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-CliVmTextHash([string]$Text) {
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '') }
    finally { $digest.Dispose() }
}

function Get-CliVmInvokerIdentity([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or $absolute.StartsWith('\\')) { throw 'The VM wrapper must use an absolute local path.' }
    $candidate = $absolute
    while ($candidate) {
        $item = Get-Item -LiteralPath $candidate -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The VM wrapper path cannot cross a reparse point.' }
        $candidate = [IO.Path]::GetDirectoryName($candidate)
    }
    $hash = Get-CliVmHash $absolute
    if ($null -eq $hash) { throw 'The VM wrapper must be an existing file.' }
    return [ordered]@{ Path = $absolute; SHA256 = $hash }
}

function Assert-CliVmInvokerIdentity($Expected) {
    if ($null -eq $Expected -or $Expected.SHA256 -cnotmatch '^[A-Fa-f0-9]{64}$') { throw 'The reviewed VM wrapper identity is invalid.' }
    $current = Get-CliVmInvokerIdentity $Expected.Path
    if ($current.Path -ine $Expected.Path -or $current.SHA256 -cne $Expected.SHA256) { throw 'The reviewed VM wrapper changed.' }
}

function Set-CliVmPrivateDirectory([string]$Path) {
    $directory = [IO.Directory]::CreateDirectory($Path)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private staging cannot be a reparse point.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $access = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($access)
    }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl) }
    else { $directory.SetAccessControl($acl) }
}

$GuestAdapterSource = @'
param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding($false)
$product='CodexAccountBridge.OfficialClaudeCliVm'
$stage='read-request'
$request=$null
$reportPath=$null
$mutex=$null
$mutexOwned=$false
$backendFailureStage=$null

function Set-PublicStage([string]$Value) {
    $script:stage=$Value
    if ($reportPath) {
        [IO.File]::WriteAllText($reportPath,([ordered]@{Success=$false;ErrorCode='OFFICIAL_CLAUDE_CLI_VM_ACTION_INCOMPLETE';Stage=$Value;RealInference=$false}|ConvertTo-Json -Compress),$utf8)
    }
}

function Get-FileDigest([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A managed file cannot be a reparse point.' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-LocalPath([string]$Path, [string]$Parent) {
    $absolute=[IO.Path]::GetFullPath($Path)
    $prefix=[IO.Path]::GetFullPath($Parent).TrimEnd('\')+'\'
    if (-not $absolute.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'A deployment path is outside its selected directory.' }
    $candidate=$absolute
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment paths cannot cross a reparse point.' }
        }
        $candidate=[IO.Path]::GetDirectoryName($candidate)
    }
    return $absolute
}

function Private-Directory([string]$Path) {
    $directory=[IO.Directory]::CreateDirectory($Path)
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($identity.Value,'S-1-5-18','S-1-5-32-544')) {
        [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    $directory.SetAccessControl($acl)
}

function Write-AtomicBytes([string]$Path,[byte[]]$Bytes,$ExpectedHash) {
    if ((Get-FileDigest $Path) -cne $ExpectedHash) { throw 'A deployment file changed concurrently.' }
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        [IO.File]::WriteAllBytes($temporary,$Bytes)
        if ((Get-FileDigest $Path) -cne $ExpectedHash) { throw 'A deployment file changed concurrently.' }
        if ($null -eq $ExpectedHash) { [IO.File]::Move($temporary,$Path) }
        else { [IO.File]::Replace($temporary,$Path,[Management.Automation.Language.NullString]::Value) }
    } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force } }
}

function Read-AdapterManifest {
    if (-not [IO.File]::Exists($manifestPath)) { return $null }
    $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
    if ($manifest.Product -cne $product -or $manifest.Version -ne 1 -or $manifest.Home -ine $request.Home -or
        $manifest.RuntimeRoot -ine $runtimeRoot -or $manifest.Script.Path -ine $installedScript -or
        $manifest.Shortcut.Path -ine $loginShortcut -or $manifest.Phase -cnotin @('preparing','installed')) { throw 'The CLI VM deployment manifest does not match this installation.' }
    return $manifest
}

function Assert-ManagedFiles($Manifest) {
    foreach ($item in @(@{Path=$installedScript;Record=$Manifest.Script},@{Path=$loginShortcut;Record=$Manifest.Shortcut})) {
        $hash=Get-FileDigest $item.Path
        if ($null -eq $Manifest) {
            if ($null -ne $hash -or [IO.Directory]::Exists($item.Path)) { throw 'A deployment target already exists without an ownership manifest.' }
        } elseif ($null -ne $hash -and $hash -cne $item.Record.SHA256 -and
            -not ($Manifest.Phase -ceq 'preparing' -and $hash -ceq $item.Record.PreviousSHA256)) {
            throw 'An owned deployment file changed; overwrite or removal was refused.'
        }
    }
}

function Public-Backend($Value) {
    $result=[ordered]@{}
    foreach ($name in @('Prepared','AccountChecked','AuthMethodKnown','ConfigDirectoryMatches','SubscriptionAuthenticated','Authenticated','LoginRunning','LoginStopped')) {
        if ($Value.$name -is [bool]) { $result[$name]=$Value.$name }
    }
    foreach ($name in @('RuntimeRoot','ManifestPhase','ClaudeCodeVersion','CliPath')) {
        if ($Value.$name -is [string]) { $result[$name]=$Value.$name }
    }
    return $result
}

function Get-OfficialFailureStage([string]$Text) {
    $match=[regex]::Match($Text,'Official Claude CLI action did not finish \(stage: ([a-z-]+)\)')
    if($match.Success -and $match.Groups[1].Value -cin @('validate-layout','plan','prepare-plan','prepare-private-directories',
        'prepare-official-manifest','prepare-official-download','prepare-official-verify','prepare-readback','status',
        'verify-prepared','stop-login','login-requires-interactive','login')){return $match.Groups[1].Value}
    return $null
}

function Invoke-OfficialCli([string]$Script,[string]$Operation,[string]$PrepareHash='') {
    if ($Operation -cnotin @('Plan','Prepare','Status','Stop')) { throw 'The adapter cannot start account authorization.' }
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$Script+'" -Action '+$Operation+' -Root "'+$runtimeRoot+'"'
    if ($PrepareHash) {
        if ($PrepareHash -cnotmatch '^[A-Fa-f0-9]{64}$') { throw 'The official CLI plan hash is invalid.' }
        $info.Arguments+=' -PlanHash '+$PrepareHash
    }
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $child=New-Object Diagnostics.Process
    $child.StartInfo=$info
    try {
        if (-not $child.Start()) { throw 'The official CLI preparation process did not start.' }
        $output=$child.StandardOutput.ReadToEndAsync()
        $errors=$child.StandardError.ReadToEndAsync()
        $timer=[Diagnostics.Stopwatch]::StartNew()
        while (-not $child.WaitForExit(1000)) {
            if ($timer.Elapsed.TotalSeconds -ge 660) { $child.Kill();throw 'The official CLI preparation process timed out.' }
        }
        $text=$output.GetAwaiter().GetResult()
        $errorText=$errors.GetAwaiter().GetResult()
        if ($child.ExitCode -ne 0) { $script:backendFailureStage=Get-OfficialFailureStage $errorText; throw 'The official CLI operation did not complete.' }
        try { return $text|ConvertFrom-Json } catch { throw 'The official CLI operation returned invalid public metadata.' }
    } finally { $child.Dispose() }
}

function New-LoginShortcut([string]$Path) {
    $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments='-NoProfile -NoExit -ExecutionPolicy Bypass -File "'+$installedScript+'" -Action Login -Root "'+$runtimeRoot+'" -Interactive'
    $shell=New-Object -ComObject WScript.Shell
    try {
        $shortcut=$shell.CreateShortcut($Path)
        try {
            $shortcut.TargetPath=$powershell;$shortcut.Arguments=$arguments;$shortcut.WorkingDirectory=$tools
            $shortcut.WindowStyle=1;$shortcut.Description='Sign in to the isolated official Claude CLI in this VM.'
            $shortcut.IconLocation=$powershell+',0';$shortcut.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        $readback=$shell.CreateShortcut($Path)
        try {
            if ($readback.TargetPath -ine $powershell -or $readback.Arguments -cne $arguments -or
                $readback.WorkingDirectory -ine $tools -or $readback.WindowStyle -ne 1) { throw 'The interactive login shortcut did not pass readback.' }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($readback) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

try {
    $stage='validate-request-path'
    $requestFile=Assert-LocalPath $RequestPath (Join-Path $env:USERPROFILE 'AppData\Local\Temp')
    $requestName=[IO.Path]::GetFileName($requestFile)
    if ($requestName -cnotmatch '^codex-cli-vm-([a-f0-9]{32})\.request\.json$') {throw 'The public request path is invalid.'}
    $requestId=$Matches[1]
    $requestDirectory=[IO.Path]::GetDirectoryName($requestFile)
    $reportPath=Assert-LocalPath (Join-Path $requestDirectory ('codex-cli-vm-'+$requestId+'.result.json')) $requestDirectory
    Set-PublicStage 'read-request'
    $request=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
    if ([IO.Path]::GetFullPath($request.ReportPath) -ine $reportPath) {throw 'The public report path does not match this request.'}
    if ($request.Action -cnotin @('Plan','Prepare','Status','Restore') -or $request.Home -ine $env:USERPROFILE -or
        [string]$request.Home -match '["\r\n\0]') { throw 'The deployment request targets an unexpected guest account.' }
    $base=Assert-LocalPath (Join-Path $request.Home 'AppData\Local\CodexAccountBridge') $request.Home
    $runtimeRoot=Assert-LocalPath (Join-Path $base 'OfficialClaudeCli') $base
    $tools=Assert-LocalPath (Join-Path $base 'tools') $base
    $installedScript=Assert-LocalPath (Join-Path $tools 'OfficialClaudeCli.ps1') $base
    $manifestPath=Assert-LocalPath (Join-Path $base 'official-claude-cli-vm.json') $base
    $loginShortcut=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude CLI - Login.lnk'
    $source=Assert-LocalPath $request.SourceScript $requestDirectory
    if ([IO.Path]::GetFileName($source) -cnotmatch '^codex-cli-vm-[a-f0-9]{32}\.source\.ps1$' -or
        $request.SourceHash -cnotmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileDigest $source) -cne $request.SourceHash) { throw 'The staged official CLI script failed its hash check.' }
    Set-PublicStage 'read-inventory'
    $manifest=Read-AdapterManifest
    $snapshot=[ordered]@{ManifestHash=Get-FileDigest $manifestPath;ScriptHash=Get-FileDigest $installedScript;ShortcutHash=Get-FileDigest $loginShortcut}
    if ($request.Action -ceq 'Plan') {
        Set-PublicStage 'plan-owned-files'
        Assert-ManagedFiles $manifest
        Set-PublicStage 'official-cli-plan'
        $backend=Invoke-OfficialCli $source 'Plan'
        Set-PublicStage 'plan-network-metadata'
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
        $principal=New-Object Security.Principal.WindowsPrincipal($identity)
        $result=[ordered]@{Success=$true;Action='Plan';Snapshot=$snapshot;OfficialPlanHash=$backend.PlanHash;
            RuntimeRoot=$runtimeRoot;ScriptPath=$installedScript;LoginShortcut=$loginShortcut;ExistingDeployment=($null -ne $manifest);
            IsAdministrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
            Addresses=@(Get-NetIPAddress -AddressFamily IPv4|Where-Object{$_.AddressState -eq 'Preferred'}|ForEach-Object{$_.IPAddress});
            CliVersion=$backend.ClaudeCodeVersion;CliPath=$backend.CliPath;RealInference=$false;ConfigurationChanged=$false}
    } elseif ($request.Action -ceq 'Status') {
        Assert-ManagedFiles $manifest
        $backend=Invoke-OfficialCli $source 'Status'
        $result=[ordered]@{Success=$true;Action='Status';Installed=($null -ne $manifest -and $manifest.Phase -ceq 'installed');
            RuntimeRoot=$runtimeRoot;LoginShortcut=$loginShortcut;LoginShortcutPresent=[IO.File]::Exists($loginShortcut);
            Backend=Public-Backend $backend;RelayImplemented=$false;RelayRunning=$false;RealInference=$false;ConfigurationChanged=$false}
    } else {
        $stage='acquire-deployment-lock'
        $sha=[Security.Cryptography.SHA256]::Create()
        try {$lockId=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($runtimeRoot.ToLowerInvariant())))).Replace('-','')}finally{$sha.Dispose()}
        $mutex=New-Object Threading.Mutex($false,('Local\CodexOfficialCliVm-'+$lockId))
        $mutexOwned=$mutex.WaitOne(0)
        if (-not $mutexOwned) { throw 'Another CLI VM deployment action is already running.' }
        $manifest=Read-AdapterManifest
        Assert-ManagedFiles $manifest
        $snapshot=[ordered]@{ManifestHash=Get-FileDigest $manifestPath;ScriptHash=Get-FileDigest $installedScript;ShortcutHash=Get-FileDigest $loginShortcut}
        if ($request.Action -ceq 'Prepare') {
            if (($snapshot|ConvertTo-Json -Compress) -cne ($request.ExpectedSnapshot|ConvertTo-Json -Compress)) { throw 'The reviewed VM deployment inventory changed.' }
            $backendPlan=Invoke-OfficialCli $source 'Plan'
            if ($backendPlan.PlanHash -cne $request.OfficialPlanHash) { throw 'The reviewed official CLI plan changed.' }
            $stage='prepare-private-tools'
            Private-Directory $base;Private-Directory $tools
            $previousManifestHash=Get-FileDigest $manifestPath
            $previousScriptHash=Get-FileDigest $installedScript
            $previousShortcutHash=Get-FileDigest $loginShortcut
            $manifest=[ordered]@{Product=$product;Version=1;Home=$request.Home;RuntimeRoot=$runtimeRoot;Phase='preparing';
                Script=[ordered]@{Path=$installedScript;SHA256=$request.SourceHash;PreviousSHA256=$previousScriptHash};
                Shortcut=[ordered]@{Path=$loginShortcut;SHA256=$previousShortcutHash;PreviousSHA256=$previousShortcutHash}}
            Write-AtomicBytes $manifestPath $utf8.GetBytes(($manifest|ConvertTo-Json -Depth 8)) $previousManifestHash
            Write-AtomicBytes $installedScript ([IO.File]::ReadAllBytes($source)) $previousScriptHash
            $stage='prepare-official-cli'
            $backend=Invoke-OfficialCli $installedScript 'Prepare' $backendPlan.PlanHash
            if ($backend.Prepared -ne $true) { throw 'The official CLI preparation did not report a verified installation.' }
            $stage='prepare-login-shortcut'
            $temporary=Join-Path $tools ('login-'+[guid]::NewGuid().ToString('N')+'.lnk')
            try {
                New-LoginShortcut $temporary
                $manifest.Shortcut.SHA256=Get-FileDigest $temporary
                Write-AtomicBytes $manifestPath $utf8.GetBytes(($manifest|ConvertTo-Json -Depth 8)) (Get-FileDigest $manifestPath)
                Write-AtomicBytes $loginShortcut ([IO.File]::ReadAllBytes($temporary)) $previousShortcutHash
            } finally {if ([IO.File]::Exists($temporary)) {Remove-Item -LiteralPath $temporary -Force}}
            $manifest.Script.Remove('PreviousSHA256');$manifest.Shortcut.Remove('PreviousSHA256')
            $manifest.Phase='installed'
            Write-AtomicBytes $manifestPath $utf8.GetBytes(($manifest|ConvertTo-Json -Depth 8)) (Get-FileDigest $manifestPath)
            $result=[ordered]@{Success=$true;Action='Prepare';Installed=$true;RuntimeRoot=$runtimeRoot;LoginShortcut=$loginShortcut;
                Backend=Public-Backend $backend;LoginStarted=$false;RelayImplemented=$false;RelayRunning=$false;
                FirewallChanged=$false;DesktopModeChanged=$false;OAuthCopied=$false;RealInference=$false}
        } else {
            $stage='restore-owned-entries'
            if ($null -ne $manifest) {
                $backend=Invoke-OfficialCli $source 'Status'
                if ($backend.LoginRunning -eq $true) {$null=Invoke-OfficialCli $source 'Stop'}
                Assert-ManagedFiles $manifest
                foreach ($item in @($manifest.Shortcut,$manifest.Script)) {
                    if ([IO.File]::Exists($item.Path)) {
                        $currentHash=Get-FileDigest $item.Path
                        if ($currentHash -cne $item.SHA256 -and -not ($manifest.Phase -ceq 'preparing' -and $currentHash -ceq $item.PreviousSHA256)) {throw 'An owned CLI deployment entry changed during restore.'}
                        Remove-Item -LiteralPath $item.Path -Force
                    }
                }
                if ((Get-FileDigest $manifestPath) -cne $snapshot.ManifestHash) {throw 'The CLI VM recovery manifest changed during restore.'}
                Remove-Item -LiteralPath $manifestPath -Force
            }
            $result=[ordered]@{Success=$true;Action='Restore';Restored=($null -ne $manifest);RuntimePreserved=$true;OAuthPreserved=$true;
                FirewallChanged=$false;DesktopModeChanged=$false;RealInference=$false}
        }
    }
    [IO.File]::WriteAllText($reportPath,($result|ConvertTo-Json -Depth 10),$utf8)
} catch {
    if ($reportPath) {[IO.File]::WriteAllText($reportPath,([ordered]@{Success=$false;ErrorCode='OFFICIAL_CLAUDE_CLI_VM_ACTION_FAILED';Stage=$stage;BackendFailureStage=$backendFailureStage;RealInference=$false}|ConvertTo-Json -Compress),$utf8)}
    exit 1
} finally {
    if ($mutexOwned) {$mutex.ReleaseMutex()}
    if ($mutex) {$mutex.Dispose()}
}
'@

function Invoke-CliVm([string]$Operation,[string[]]$Arguments) {
    Assert-CliVmInvokerIdentity $invokerIdentity
    & $invokerIdentity.Path -Operation $Operation -OperationArguments $Arguments|Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('VM CLI management operation failed: '+$Operation+'.') }
}

function Invoke-CliVmRequest([string]$GuestAction,$Source,$Reviewed=$null) {
    $id=[guid]::NewGuid().ToString('N')
    $stage=Join-Path $StateDir ('staging-'+$id)
    Set-CliVmPrivateDirectory $stage
    $hostPayload=Join-Path $stage 'adapter.ps1';$hostRequest=Join-Path $stage 'request.json';$hostReport=Join-Path $stage 'result.json'
    $guestTemp=Join-Path $GuestHome 'AppData\Local\Temp'
    $guestPayload=Join-Path $guestTemp ('codex-cli-vm-'+$id+'.ps1')
    $guestSource=Join-Path $guestTemp ('codex-cli-vm-'+$id+'.source.ps1')
    $guestRequest=Join-Path $guestTemp ('codex-cli-vm-'+$id+'.request.json')
    $guestReport=Join-Path $guestTemp ('codex-cli-vm-'+$id+'.result.json')
    $powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    try {
        [IO.File]::WriteAllText($hostPayload,$GuestAdapterSource,$utf8)
        $request=[ordered]@{Action=$GuestAction;Home=$GuestHome;SourceScript=$guestSource;SourceHash=$Source.Hash;ReportPath=$guestReport}
        if ($null -ne $Reviewed) {$request.ExpectedSnapshot=$Reviewed.Snapshot;$request.OfficialPlanHash=$Reviewed.OfficialPlanHash}
        [IO.File]::WriteAllText($hostRequest,($request|ConvertTo-Json -Depth 8),$utf8)
        Invoke-CliVm 'copyFileFromHostToGuest' @($hostPayload,$guestPayload)
        Invoke-CliVm 'copyFileFromHostToGuest' @($Source.Path,$guestSource)
        Invoke-CliVm 'copyFileFromHostToGuest' @($hostRequest,$guestRequest)
        $guestFailed=$false
        $guestCommand=@'
$ErrorActionPreference='Stop'
$publicReport='__REPORT__'
$encoding=New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($publicReport,'{"Success":false,"ErrorCode":"OFFICIAL_CLAUDE_CLI_VM_LAUNCH_INCOMPLETE","Stage":"launch-adapter"}',$encoding)
try { & '__PAYLOAD__' -RequestPath '__REQUEST__' }
catch {
    [IO.File]::WriteAllText($publicReport,([ordered]@{Success=$false;ErrorCode='OFFICIAL_CLAUDE_CLI_VM_LAUNCH_FAILED';
        Stage='launch-adapter';ErrorType=$_.Exception.GetType().Name;ErrorId=$_.FullyQualifiedErrorId;
        ErrorLine=$_.InvocationInfo.ScriptLineNumber;RealInference=$false}|ConvertTo-Json -Compress),$encoding)
    exit 1
}
'@
        $guestCommand=$guestCommand.Replace('__REPORT__',$guestReport.Replace("'","''")).Replace('__PAYLOAD__',$guestPayload.Replace("'","''")).Replace('__REQUEST__',$guestRequest.Replace("'","''"))
        $guestEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($guestCommand))
        try {Invoke-CliVm 'runProgramInGuest' @($powershell,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',$guestEncoded)}catch{$guestFailed=$true}
        Invoke-CliVm 'copyFileFromGuestToHost' @($guestReport,$hostReport)
        $report=Get-Content -LiteralPath $hostReport -Raw|ConvertFrom-Json
        if ($guestFailed -or $report.Success -ne $true) {throw ('VM CLI action failed at stage '+[string]$report.Stage+'; backend '+[string]$report.BackendFailureStage+' ('+[string]$report.ErrorType+', '+[string]$report.ErrorId+', line '+[string]$report.ErrorLine+'). Only public diagnostics were copied.')}
        return $report
    } finally {
        $cleanup='foreach($item in @('+((@($guestPayload,$guestSource,$guestRequest,$guestReport)|ForEach-Object{"'"+$_.Replace("'","''")+"'"}) -join ',')+')){if([IO.File]::Exists($item)){Remove-Item -LiteralPath $item -Force}}'
        $cleanupEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
        try {Invoke-CliVm 'runProgramInGuest' @($powershell,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$cleanupEncoded)}catch{Write-Warning 'Public temporary CLI audit files could not be cleaned up.'}
        foreach ($path in @($hostPayload,$hostRequest,$hostReport)) {if([IO.File]::Exists($path)){Remove-Item -LiteralPath $path -Force}}
        if ([IO.Directory]::Exists($stage) -and @(Get-ChildItem -LiteralPath $stage -Force).Count -eq 0) {Remove-Item -LiteralPath $stage -Force}
    }
}

function Get-CliVmPlan($Source) {
    $guest=Invoke-CliVmRequest 'Plan' $Source
    $description=[ordered]@{Product=$product;Version=1;Home=$GuestHome;SourceScriptHash=$Source.Hash;
        VmInvoker=$invokerIdentity;
        RuntimeRoot=$guest.RuntimeRoot;ScriptPath=$guest.ScriptPath;LoginShortcut=$guest.LoginShortcut;
        Snapshot=$guest.Snapshot;OfficialPlanHash=$guest.OfficialPlanHash}
    $hash=Get-CliVmTextHash ($description|ConvertTo-Json -Depth 10 -Compress)
    return [ordered]@{Action='Plan';PlanHash=$hash;RuntimeRoot=$guest.RuntimeRoot;ScriptPath=$guest.ScriptPath;
        VmInvoker=$invokerIdentity;
        SourceScriptHash=$Source.Hash;ClaudeCodeVersion=$guest.CliVersion;CliPath=$guest.CliPath;
        LoginShortcut=$guest.LoginShortcut;OfficialPlanHash=$guest.OfficialPlanHash;Snapshot=$guest.Snapshot;
        ExistingDeployment=$guest.ExistingDeployment;IsAdministrator=$guest.IsAdministrator;Addresses=$guest.Addresses;
        Changes=@('Install the pinned official Claude CLI in its isolated VM directory.','Install one visible interactive VM login shortcut.');
        PrepareStartsLogin=$false;RelayImplemented=$false;RelayStarted=$false;FirewallChanged=$false;
        DesktopModeChanged=$false;CopiesOAuth=$false;RealInference=$false}
}

if ($Action -ceq 'Start') {throw 'The self-developed VM CLI relay has not been connected yet. No process was started.'}
if (-not [IO.Path]::IsPathRooted($GuestHome) -or $GuestHome.StartsWith('\\') -or $GuestHome -match '["\r\n\0]' -or
    -not (Test-Path -LiteralPath $VmInvoker -PathType Leaf) -or -not (Test-Path -LiteralPath $BackendScript -PathType Leaf)) {
    throw 'The VM wrapper, official CLI source script and absolute guest home must be available.'
}
$invokerIdentity=Get-CliVmInvokerIdentity $VmInvoker
$VmInvoker=$invokerIdentity.Path
$StateDir=[IO.Path]::GetFullPath($StateDir)
if ($StateDir.StartsWith('\\') -or [IO.Path]::GetFileName($StateDir).ToLowerInvariant() -cne 'claude-cli-vm') {
    throw 'StateDir must be a dedicated local directory named claude-cli-vm.'
}
Set-CliVmPrivateDirectory $StateDir
$source=[ordered]@{Path=[IO.Path]::GetFullPath($BackendScript);Hash=Get-CliVmHash $BackendScript}
if ($Action -ceq 'Plan') {Get-CliVmPlan $source|ConvertTo-Json -Depth 10;return}
if ($Action -ceq 'Prepare') {
    $plan=Get-CliVmPlan $source
    if (-not $PlanHash -or $PlanHash -cne $plan.PlanHash) {throw 'Run Plan and provide its current PlanHash before preparing the VM CLI.'}
    $result=Invoke-CliVmRequest 'Prepare' $source $plan
} else {$result=Invoke-CliVmRequest $Action $source}
$result|ConvertTo-Json -Depth 10
