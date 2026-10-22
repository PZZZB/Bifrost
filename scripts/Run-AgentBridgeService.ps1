[CmdletBinding()]
param([string]$ConfigPath, [switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'

function Get-AgentBridgeAbsolutePath([string]$Value) {
    if ($Value -cnotmatch '^[A-Za-z]:[\\/]' -or $Value -match '[\x00-\x1f\x7f"]' -or $Value.Trim() -cne $Value) {
        throw 'AgentBridge requires an absolute local path without control characters.'
    }
    $absolute = [IO.Path]::GetFullPath($Value).TrimEnd('\')
    if ($absolute -ieq [IO.Path]::GetPathRoot($absolute).TrimEnd('\') -or $absolute.Substring(3).Contains(':')) {
        throw 'AgentBridge paths cannot be drive roots or alternate data streams.'
    }
    return $absolute
}

function ConvertTo-AgentBridgeArgument([string]$Value) {
    # CommandLineToArgvW quoting, including backslashes immediately before quotes or the closing quote.
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function ConvertFrom-AgentBridgeCommandLine([string]$Value) {
    if (-not $Value -or $Value -match '[\x00-\x08\x0a-\x1f\x7f]') { throw 'The native process command line is invalid.' }
    if (-not ('AgentBridge.NativeCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace AgentBridge {
    public static class NativeCommandLine {
        [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string value, out int count);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
        public static string[] Parse(string value) {
            int count; IntPtr result = CommandLineToArgvW(value, out count);
            if (result == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                string[] arguments = new string[count];
                for (int i=0; i<count; i++) arguments[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(result, i*IntPtr.Size));
                return arguments;
            } finally { LocalFree(result); }
        }
    }
}
'@
    }
    return [AgentBridge.NativeCommandLine]::Parse($Value)
}

function Test-AgentBridgeCommandLine([string]$Value, [string[]]$Expected) {
    try {
        $arguments = @(ConvertFrom-AgentBridgeCommandLine $Value)
        if ($arguments.Count -ne $Expected.Count -or $arguments[0] -ine $Expected[0]) { return $false }
        for ($index = 1; $index -lt $Expected.Count; $index++) {
            if ($arguments[$index] -cne $Expected[$index]) { return $false }
        }
        return $true
    } catch { return $false }
}

function Get-AgentBridgeTaskArguments([string]$Runner, [string]$Config) {
    return '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
        (ConvertTo-AgentBridgeArgument $Runner) + ' -ConfigPath ' + (ConvertTo-AgentBridgeArgument $Config)
}

function Get-AgentBridgePrincipalSid([string]$User) {
    if ($User -match '^S-1-') { return $User }
    try { return (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'The scheduled task principal cannot be resolved.' }
}

function Assert-AgentBridgeTaskOwner($Task, $Config, [string]$ConfigFile) {
    $definition = $Task.Definition
    $expected = 'AgentBridge.Service/v1/' + $Config.OwnerId
    if ($definition.RegistrationInfo.Description -cne $expected -or (Get-AgentBridgePrincipalSid $definition.Principal.UserId) -cne $Config.UserSid -or
        $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0 -or $definition.Actions.Count -ne 1) {
        throw 'The scheduled task is not owned by this Bifrost project; it was not changed.'
    }
    $actionDefinition = $definition.Actions.Item(1)
    if ($actionDefinition.Type -ne 0 -or $actionDefinition.Path -ine $Config.PowerShellBinary -or
        $actionDefinition.Arguments -cne (Get-AgentBridgeTaskArguments $Config.RunnerPath $ConfigFile) -or
        $actionDefinition.WorkingDirectory -ine $Config.ProjectDirectory) {
        throw 'The Bifrost scheduled task action differs from its recorded owner.'
    }
}

function Get-AgentBridgeOwnerId([string]$Project, [string]$State, [string]$UserSid) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Project.ToLowerInvariant() + "`n" + $State.ToLowerInvariant() + "`n" + $UserSid))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
    } finally { $sha.Dispose() }
}

function Write-AgentBridgeJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Read-AgentBridgeJson([string]$Path) {
    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($file.Length -gt 65536) { throw 'AgentBridge metadata exceeds its size limit.' }
    $options = @{ InputObject = [IO.File]::ReadAllText($Path) }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    return (ConvertFrom-Json @options)
}

function Test-AgentBridgeInteger($Value, [int]$Minimum, [int]$Maximum) {
    return ($Value -is [int] -or $Value -is [long]) -and $Value -ge $Minimum -and $Value -le $Maximum
}

function Assert-AgentBridgeConfig($Config) {
    if ($Config.Product -cne 'AgentBridge.Service' -or $Config.Version -ne 1 -or $Config.OwnerId -cnotmatch '^[0-9A-F]{64}$') {
        throw 'AgentBridge service configuration is invalid.'
    }
    foreach ($name in @('ProjectDirectory', 'StateDirectory', 'CodexHome', 'NodeBinary', 'CodexBinary', 'RunnerPath', 'PowerShellBinary')) {
        if ((Get-AgentBridgeAbsolutePath $Config.$name) -ine $Config.$name) { throw 'AgentBridge service path is not normalized.' }
    }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($Config.UserSid -cne $currentSid -or $Config.OwnerId -cne (Get-AgentBridgeOwnerId $Config.ProjectDirectory $Config.StateDirectory $currentSid)) {
        throw 'AgentBridge service configuration belongs to another user or project.'
    }
    if (-not (Test-AgentBridgeInteger $Config.Port 1024 65535)) { throw 'AgentBridge service port is invalid.' }
    if ($Config.RunnerPath -ine (Join-Path $Config.ProjectDirectory 'scripts\Run-AgentBridgeService.ps1')) {
        throw 'AgentBridge service runner does not match its project.'
    }
    foreach ($path in @($Config.NodeBinary, $Config.CodexBinary, $Config.RunnerPath, $Config.PowerShellBinary, (Join-Path $Config.ProjectDirectory 'src\main.mjs'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'An AgentBridge runtime file is missing.' }
    }
    if ([IO.Path]::GetExtension($Config.NodeBinary) -ine '.exe' -or [IO.Path]::GetExtension($Config.CodexBinary) -ine '.exe') {
        throw 'AgentBridge requires native Node and Codex executables.'
    }
}

function Get-AgentBridgeOwnedNode($Identity, $Config) {
    if ($null -eq $Identity -or $Identity.Product -cne 'AgentBridge.Service.Process' -or $Identity.OwnerId -cne $Config.OwnerId -or
        $Identity.NodeBinary -ine $Config.NodeBinary -or $Identity.EntryScript -ine (Join-Path $Config.ProjectDirectory 'src\main.mjs') -or
        -not (Test-AgentBridgeInteger $Identity.NodePid 1 ([int]::MaxValue)) -or
        -not (Test-AgentBridgeInteger $Identity.RunnerPid 1 ([int]::MaxValue))) { return $null }
    $process = Get-Process -Id $Identity.NodePid -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    try {
        $null = $process.Handle
        $metadata = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $Identity.NodePid) -ErrorAction Stop
        if ($process.HasExited -or $process.Path -ine $Config.NodeBinary -or $metadata.ExecutablePath -ine $Config.NodeBinary -or
            $metadata.ParentProcessId -ne $Identity.RunnerPid -or $process.StartTime.ToUniversalTime().ToString('o') -cne $Identity.StartUtc -or
            -not (Test-AgentBridgeCommandLine $metadata.CommandLine @($Config.NodeBinary, $Identity.EntryScript))) { $process.Dispose(); return $null }
        return $process
    } catch { $process.Dispose(); return $null }
}

function Get-AgentBridgeOwnedRunner($Identity, $Config, $Task, [string]$ConfigFile) {
    if (-not $Task -or $Task.State -ne 4 -or $Identity.OwnerId -cne $Config.OwnerId -or
        $Identity.RunnerBinary -ine $Config.PowerShellBinary -or $Identity.RunnerConfigPath -ine $ConfigFile -or
        $Identity.TaskName -cne $Config.TaskName -or -not $Identity.RunnerStartUtc -or -not $Identity.TaskRunUtc -or
        -not (Test-AgentBridgeInteger $Identity.RunnerPid 1 ([int]::MaxValue))) { return $null }
    $runnerProcess = Get-Process -Id $Identity.RunnerPid -ErrorAction SilentlyContinue
    if (-not $runnerProcess) { return $null }
    try {
        $null = $runnerProcess.Handle
        $metadata = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Identity.RunnerPid) -ErrorAction Stop
        $taskRunUtc = $Task.LastRunTime.ToUniversalTime()
        $expected = @($Config.PowerShellBinary, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass', '-File', $Config.RunnerPath, '-ConfigPath', $ConfigFile)
        if ($runnerProcess.HasExited -or $runnerProcess.Path -ine $Config.PowerShellBinary -or
            $metadata.ExecutablePath -ine $Config.PowerShellBinary -or
            $runnerProcess.StartTime.ToUniversalTime().ToString('o') -cne $Identity.RunnerStartUtc -or
            $taskRunUtc.ToString('o') -cne $Identity.TaskRunUtc -or
            $taskRunUtc -gt $runnerProcess.StartTime.ToUniversalTime().AddSeconds(2) -or
            -not (Test-AgentBridgeCommandLine $metadata.CommandLine $expected)) { $runnerProcess.Dispose(); return $null }
        return $runnerProcess
    } catch { $runnerProcess.Dispose(); return $null }
}

function Get-AgentBridgeOwnedCodexChildren($Node, $Config) {
    $heldChildren = @()
    try {
        foreach ($metadata in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $Node.Id) -ErrorAction Stop)) {
            if ($metadata.ExecutablePath -ine $Config.CodexBinary) { continue }
            $expected = @($Config.CodexBinary, 'app-server', '--listen', 'stdio://')
            if (-not (Test-AgentBridgeCommandLine $metadata.CommandLine $expected) -and
                -not (Test-AgentBridgeCommandLine $metadata.CommandLine ($expected + @('-c', 'cli_auth_credentials_store="auto"')))) { continue }
            $childProcess = Get-Process -Id $metadata.ProcessId -ErrorAction SilentlyContinue
            if (-not $childProcess) { continue }
            try {
                $null = $childProcess.Handle
                $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $childProcess.Id) -ErrorAction Stop
                if ($childProcess.HasExited -or $childProcess.Path -ine $Config.CodexBinary -or
                    $current.ExecutablePath -ine $Config.CodexBinary -or $current.ParentProcessId -ne $Node.Id -or
                    $current.CommandLine -cne $metadata.CommandLine -or $childProcess.StartTime.ToUniversalTime() -lt $Node.StartTime.ToUniversalTime()) {
                    $childProcess.Dispose(); continue
                }
                $heldChildren += $childProcess
            } catch { $childProcess.Dispose(); throw }
        }
        return $heldChildren
    } catch {
        foreach ($heldChild in $heldChildren) { $heldChild.Dispose() }
        throw
    }
}

function Stop-AgentBridgeHeldProcesses($Task, $Node, [object[]]$CodexChildren) {
    try {
        # Task Scheduler can terminate only PowerShell and leave Node outside its process job.
        $Task.Stop(0)
        if ($Node -and -not $Node.HasExited -and -not $Node.WaitForExit(1500)) {
            $Node.Kill()
            if (-not $Node.WaitForExit(5000)) { throw 'The exact held Bifrost Node process has not stopped.' }
        }
        foreach ($childProcess in $CodexChildren) {
            if (-not $childProcess.HasExited -and -not $childProcess.WaitForExit(1000)) {
                $childProcess.Kill()
                if (-not $childProcess.WaitForExit(5000)) { throw 'An exact held Bifrost Codex child has not stopped.' }
            }
        }
    } finally {
        if ($Node) { $Node.Dispose() }
        foreach ($childProcess in $CodexChildren) { $childProcess.Dispose() }
    }
}

function Assert-AgentBridgeNoExistingProcess($Config, [string]$ServicePath) {
    $existingIdentityPath = Join-Path $ServicePath 'process.json'
    if (Test-Path -LiteralPath $existingIdentityPath) {
        $existingNode = Get-AgentBridgeOwnedNode (Read-AgentBridgeJson $existingIdentityPath) $Config
        if ($existingNode) { $existingNode.Dispose(); throw 'An owned Node process remains alive; stop it before starting a new supervisor.' }
    }
    if (@(Get-NetTCPConnection -State Listen -LocalPort $Config.Port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count) { throw 'The management port is occupied; no process identity was overwritten.' }
}

function Get-AgentBridgeRestartRequest($Config, [string]$ServicePath, $Node) {
    $requestPath = Join-Path $ServicePath 'restart-request.json'
    if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { return $false }
    try {
        $request = Read-AgentBridgeJson $requestPath
        if ($request.Product -cne 'Bifrost.Service.Restart' -or $request.Version -ne 1 -or
            $request.OwnerId -cne $Config.OwnerId -or $request.NodePid -ne $Node.Id -or
            $request.Nonce -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { return $false }
        $requestedAt = [datetimeoffset]::Parse([string]$request.RequestedAt).UtcDateTime
        $expiresAt = [datetimeoffset]::Parse([string]$request.ExpiresAt).UtcDateTime
        $currentTime = [datetime]::UtcNow
        if ($requestedAt -lt $Node.StartTime.ToUniversalTime() -or $requestedAt -gt $currentTime.AddSeconds(5) -or
            $expiresAt -le $currentTime -or $expiresAt -gt $requestedAt.AddMinutes(2)) { return $false }
        return $true
    } catch { return $false }
    finally {
        # Consume only this exact marker; a stale request cannot restart a later process.
        if ([IO.File]::Exists($requestPath)) { [IO.File]::Delete($requestPath) }
    }
}

if ($LibraryOnly) { return }
if (-not $ConfigPath) { throw 'A service configuration path is required.' }
$ConfigPath = Get-AgentBridgeAbsolutePath $ConfigPath
$configuration = Read-AgentBridgeJson $ConfigPath
Assert-AgentBridgeConfig $configuration
$serviceDirectory = Join-Path $configuration.StateDirectory 'service'
if ($ConfigPath -ine (Join-Path $serviceDirectory 'service.json')) { throw 'AgentBridge service configuration is outside its state directory.' }
[void][IO.Directory]::CreateDirectory($serviceDirectory)
$mutex = New-Object Threading.Mutex($false, ('Local\AgentBridge-' + $configuration.OwnerId))
$lockHeld = $false; $node = $null; $identity = $null
try {
    try { $lockHeld = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockHeld = $true }
    if (-not $lockHeld) { throw 'AgentBridge service is already supervised.' }
    Assert-AgentBridgeNoExistingProcess $configuration $serviceDirectory
    $runnerScheduler = New-Object -ComObject 'Schedule.Service'
    $runnerScheduler.Connect()
    $runnerTask = $runnerScheduler.GetFolder('\').GetTask($configuration.TaskName)
    Assert-AgentBridgeTaskOwner $runnerTask $configuration $ConfigPath
    $runnerSelf = Get-Process -Id $PID -ErrorAction Stop
    $supervisorIdentity = [pscustomobject]@{ OwnerId = $configuration.OwnerId; RunnerPid = $PID;
        RunnerBinary = $configuration.PowerShellBinary; RunnerConfigPath = $ConfigPath;
        RunnerStartUtc = $runnerSelf.StartTime.ToUniversalTime().ToString('o'); TaskName = $configuration.TaskName;
        TaskRunUtc = $runnerTask.LastRunTime.ToUniversalTime().ToString('o') }
    $runnerSelf.Dispose()
    $verifiedRunner = Get-AgentBridgeOwnedRunner $supervisorIdentity $configuration $runnerTask $ConfigPath
    if (-not $verifiedRunner) { throw 'The supervisor identity does not match the running scheduled task action.' }
    $verifiedRunner.Dispose()
    $env:BRIDGE_STATE_DIR = $configuration.StateDirectory
    $env:BRIDGE_CLIENT_CODEX_HOME = $configuration.CodexHome
    $env:CODEX_HOME = $configuration.CodexHome
    $env:CODEX_BINARY = $configuration.CodexBinary
    $env:BRIDGE_PORT = [string]$configuration.Port
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    $logDirectory = Join-Path $configuration.ProjectDirectory '.state'
    [void][IO.Directory]::CreateDirectory($logDirectory)
    $entry = Join-Path $configuration.ProjectDirectory 'src\main.mjs'
    do {
    $node = Start-Process -FilePath $configuration.NodeBinary -ArgumentList (ConvertTo-AgentBridgeArgument $entry) `
        -WorkingDirectory $configuration.ProjectDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDirectory 'server.log') -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
    $null = $node.Handle
    $identity = [ordered]@{ Product = 'AgentBridge.Service.Process'; RestartProtocol = 1; OwnerId = $configuration.OwnerId;
        NodePid = $node.Id; RunnerPid = $PID; StartUtc = $node.StartTime.ToUniversalTime().ToString('o');
        NodeBinary = $configuration.NodeBinary; EntryScript = $entry;
        RunnerBinary = $supervisorIdentity.RunnerBinary; RunnerConfigPath = $supervisorIdentity.RunnerConfigPath;
        RunnerStartUtc = $supervisorIdentity.RunnerStartUtc; TaskName = $supervisorIdentity.TaskName; TaskRunUtc = $supervisorIdentity.TaskRunUtc }
    Write-AgentBridgeJson (Join-Path $serviceDirectory 'process.json') $identity
    [IO.File]::WriteAllText((Join-Path $logDirectory 'server.pid'), [string]$node.Id)
    $node.WaitForExit()
    $exitCode = $node.ExitCode
    if ($null -eq $exitCode) { $exitCode = 1 }
    $restartRequested = Get-AgentBridgeRestartRequest $configuration $serviceDirectory $node
    if ($restartRequested) { $node.Dispose(); $node = $null }
    } while ($restartRequested)
} catch {
    # Store a short lifecycle error; application stderr remains in server-error.log.
    [IO.File]::WriteAllText((Join-Path $serviceDirectory 'runner-error.log'), $_.Exception.Message)
    $exitCode = 1
} finally {
    if ($node) {
        if (-not $node.HasExited) {
            # This Process object and its already opened native handle refer only to the child we just created.
            $node.Kill(); [void]$node.WaitForExit(5000)
        }
        $node.Dispose()
    }
    if ($lockHeld) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
