[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Start', 'Status', 'Stop', 'Restart')][string]$Action,
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeBinary,
    [string]$CodexBinary,
    [string]$StateDirectory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-account-bridge'),
    [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')][string]$TaskName = 'Bifrost',
    [ValidateRange(1024, 65535)][int]$Port = 43155,
    [ValidateRange(1, 120)][int]$WaitSeconds = 30,
    [switch]$AsJson
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Run-AgentBridgeService.ps1') -LibraryOnly

function Get-AgentBridgeRegisteredTask($Folder, [string]$Name) {
    try { return $Folder.GetTask($Name) } catch {
        $exception = $_.Exception
        while ($exception) {
            if ($exception.HResult -eq -2147024894) { return $null } # HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
            $exception = $exception.InnerException
        }
        throw
    }
}

function New-AgentBridgeTaskDefinition($Scheduler, $Config, [string]$ConfigFile) {
    $definition = $Scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = 'AgentBridge.Service/v1/' + $Config.OwnerId
    $definition.RegistrationInfo.Author = $Config.UserSid
    $definition.Principal.UserId = $Config.UserSid
    $definition.Principal.LogonType = 3 # InteractiveToken: current user, no stored password.
    $definition.Principal.RunLevel = 0 # Limited, no elevation.
    $definition.Settings.Enabled = $true
    $definition.Settings.Hidden = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.StartWhenAvailable = $true
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.RestartCount = 3
    $definition.Settings.RestartInterval = 'PT1M'
    $definition.Settings.MultipleInstances = 2 # IgnoreNew: one supervisor per task.
    $trigger = $definition.Triggers.Create(9) # Logon trigger.
    $trigger.UserId = $Config.UserSid
    $trigger.Enabled = $true
    $taskAction = $definition.Actions.Create(0)
    $taskAction.Path = $Config.PowerShellBinary
    $taskAction.Arguments = Get-AgentBridgeTaskArguments $Config.RunnerPath $ConfigFile
    $taskAction.WorkingDirectory = $Config.ProjectDirectory
    return $definition
}

function Get-AgentBridgeServiceStatus($Task, $Config, [string]$ServicePath) {
    $ownedNode = $null; $ownedRunner = $null
    $identityPath = Join-Path $ServicePath 'process.json'
    if (Test-Path -LiteralPath $identityPath) {
        try {
            $identity = Read-AgentBridgeJson $identityPath
            $ownedNode = Get-AgentBridgeOwnedNode $identity $Config
            if ($ownedNode) { $ownedRunner = Get-AgentBridgeOwnedRunner $identity $Config $Task (Join-Path $ServicePath 'service.json') }
        } catch {}
    }
    $ready = $false
    if ($ownedNode -and $ownedRunner) {
        try {
            $listener = @(Get-NetTCPConnection -State Listen -LocalPort $Config.Port -ErrorAction Stop |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $ownedNode.Id })
            if ($listener.Count -eq 1) {
                $ready = (Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Config.Port + '/health') -TimeoutSec 2).ok -eq $true
            }
        } catch {}
    }
    $answer = [ordered]@{ Product = 'AgentBridge.Service'; Installed = [bool]$Task; TaskName = $TaskName;
        TaskRunning = [bool]($Task -and $Task.State -eq 4); NodeRunning = [bool]$ownedNode;
        RunnerRunning = [bool]$ownedRunner;
        NodePid = $(if ($ownedNode) { $ownedNode.Id } else { $null }); Ready = $ready;
        ManagementUrl = ('http://127.0.0.1:' + $Config.Port); IndependentOfCodex = [bool]($ownedNode -and $ownedRunner) }
    if ($ownedNode) { $ownedNode.Dispose() }
    if ($ownedRunner) { $ownedRunner.Dispose() }
    return [pscustomobject]$answer
}

$ProjectDirectory = Get-AgentBridgeAbsolutePath $ProjectDirectory
$StateDirectory = Get-AgentBridgeAbsolutePath $StateDirectory
$CodexHome = Get-AgentBridgeAbsolutePath $CodexHome
$servicePath = Join-Path $StateDirectory 'service'
$serviceConfigPath = Join-Path $servicePath 'service.json'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$configuration = $null
if (Test-Path -LiteralPath $serviceConfigPath) {
    $configuration = Read-AgentBridgeJson $serviceConfigPath
    Assert-AgentBridgeConfig $configuration
    if ($configuration.ProjectDirectory -ine $ProjectDirectory -or $configuration.StateDirectory -ine $StateDirectory -or
        $configuration.TaskName -cne $TaskName) { throw 'The existing service configuration belongs to another project or task.' }
}
if (-not $configuration) {
    if (-not $NodeBinary -or -not $CodexBinary) {
        throw 'First installation requires absolute NodeBinary and independent official CodexBinary paths.'
    }
    $configuration = [pscustomobject][ordered]@{ Product = 'AgentBridge.Service'; Version = 1; UserSid = $userSid;
        OwnerId = (Get-AgentBridgeOwnerId $ProjectDirectory $StateDirectory $userSid); TaskName = $TaskName;
        ProjectDirectory = $ProjectDirectory; StateDirectory = $StateDirectory; CodexHome = $CodexHome;
        NodeBinary = (Get-AgentBridgeAbsolutePath $NodeBinary); CodexBinary = (Get-AgentBridgeAbsolutePath $CodexBinary);
        RunnerPath = (Join-Path $ProjectDirectory 'scripts\Run-AgentBridgeService.ps1');
        PowerShellBinary = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Port = $Port }
    Assert-AgentBridgeConfig $configuration
} else {
    foreach ($pair in @(@('NodeBinary', $NodeBinary), @('CodexBinary', $CodexBinary))) {
        if ($pair[1] -and (Get-AgentBridgeAbsolutePath $pair[1]) -ine $configuration.($pair[0])) {
            throw 'The installed service runtime differs. Stop it and explicitly migrate its configuration before changing runtimes.'
        }
    }
}
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\')
$task = Get-AgentBridgeRegisteredTask $folder $TaskName
if ($task) { Assert-AgentBridgeTaskOwner $task $configuration $serviceConfigPath }
if ($Action -eq 'Status') {
    $status = Get-AgentBridgeServiceStatus $task $configuration $servicePath
    if ($AsJson) { $status | ConvertTo-Json -Depth 4 -Compress } else { $status }
    return
}
if ($Action -in @('Stop', 'Restart') -and $task) {
    $heldNode = $null; $heldChildren = @()
    try {
        $identityPath = Join-Path $servicePath 'process.json'
        if (Test-Path -LiteralPath $identityPath) {
            $heldNode = Get-AgentBridgeOwnedNode (Read-AgentBridgeJson $identityPath) $configuration
            if ($heldNode) { $heldChildren = @(Get-AgentBridgeOwnedCodexChildren $heldNode $configuration) }
        }
    } catch { if ($heldNode) { $heldNode.Dispose() }; throw }
    Stop-AgentBridgeHeldProcesses $task $heldNode $heldChildren
    $limit = [datetime]::UtcNow.AddSeconds(10)
    do {
        $task = $folder.GetTask($TaskName)
        $status = Get-AgentBridgeServiceStatus $task $configuration $servicePath
        if (-not $status.TaskRunning -and -not $status.NodeRunning) { break }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $limit)
    if ($status.TaskRunning -or $status.NodeRunning) { throw 'The owned Bifrost task has not stopped; no unrelated process was terminated.' }
}
if ($Action -eq 'Stop') { Get-AgentBridgeServiceStatus $task $configuration $servicePath; return }
if (-not $task -or $Action -eq 'Install') {
    if ($task -and $task.State -eq 4) { throw 'Stop the Bifrost task before reinstalling its definition.' }
    [void][IO.Directory]::CreateDirectory($servicePath)
    Write-AgentBridgeJson $serviceConfigPath $configuration
    $definition = New-AgentBridgeTaskDefinition $scheduler $configuration $serviceConfigPath
    $task = $folder.RegisterTaskDefinition($TaskName, $definition, 6, $userSid, $null, 3, $null)
    Assert-AgentBridgeTaskOwner $task $configuration $serviceConfigPath
}
if ($Action -eq 'Install') { Get-AgentBridgeServiceStatus $task $configuration $servicePath; return }
if ($task.State -ne 4) { $null = $task.Run($null) }
$deadline = [datetime]::UtcNow.AddSeconds($WaitSeconds)
do {
    $task = $folder.GetTask($TaskName)
    $status = Get-AgentBridgeServiceStatus $task $configuration $servicePath
    if ($status.Ready) { $status; return }
    Start-Sleep -Milliseconds 250
} while ([datetime]::UtcNow -lt $deadline)
throw 'Bifrost did not become ready. Check .state/server-error.log and the private service/runner-error.log.'
