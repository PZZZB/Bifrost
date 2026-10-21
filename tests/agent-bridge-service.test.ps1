[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$runnerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\Run-AgentBridgeService.ps1'))
$controllerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\AgentBridgeService.ps1'))
foreach ($path in @($runnerPath, $controllerPath)) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'AgentBridge service scripts must parse.' }
    foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        . ([scriptblock]::Create($function.Extent.Text))
    }
}
$script:passed = 0
function Assert-Test([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) { & $Body; $script:passed++; Write-Output ('PASS ' + $Name) }
function Expect-Failure([scriptblock]$Body) { $failed = $false; try { & $Body | Out-Null } catch { $failed = $true }; Assert-Test $failed 'Expected rejection.' }

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('agent-bridge-service-fixture-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($fixtureRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The fixture escaped the temporary directory.'
}
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$project = Join-Path $fixtureRoot 'Project with spaces'
$state = Join-Path $fixtureRoot 'State with spaces'
foreach ($folder in @($project, $state, (Join-Path $project 'scripts'), (Join-Path $project 'src'), (Join-Path $project 'runtime'))) {
    [void][IO.Directory]::CreateDirectory($folder)
}
$config = [pscustomobject]@{ Product = 'AgentBridge.Service'; Version = 1; UserSid = $sid;
    OwnerId = (Get-AgentBridgeOwnerId $project $state $sid); TaskName = 'Fixture-AgentBridge';
    ProjectDirectory = $project; StateDirectory = $state; CodexHome = (Join-Path $fixtureRoot '.codex');
    NodeBinary = (Join-Path $project 'runtime\node.exe'); CodexBinary = (Join-Path $project 'runtime\codex.exe');
    RunnerPath = (Join-Path $project 'scripts\Run-AgentBridgeService.ps1');
    PowerShellBinary = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'); Port = 43155 }
foreach ($path in @($config.NodeBinary, $config.CodexBinary, $config.RunnerPath, (Join-Path $project 'src\main.mjs'))) {
    [IO.File]::WriteAllText($path, 'Offline fixture. Never executed.')
}
$configFile = Join-Path $state 'service.json'
function New-FixtureDefinition {
    $action = [pscustomobject]@{ Type = 0; Path = ''; Arguments = ''; WorkingDirectory = '' }
    $actions = [pscustomobject]@{ Count = 1; Action = $action }
    $actions | Add-Member ScriptMethod Item { param($Index) if ($Index -ne 1) { throw 'Bad index.' }; return $this.Action }
    $actions | Add-Member ScriptMethod Create { param($Type) $this.Action.Type = $Type; return $this.Action }
    $triggers = [pscustomobject]@{ Trigger = [pscustomobject]@{ Type = 0; UserId = ''; Enabled = $false } }
    $triggers | Add-Member ScriptMethod Create { param($Type) $this.Trigger.Type = $Type; return $this.Trigger }
    return [pscustomobject]@{ RegistrationInfo = [pscustomobject]@{ Description = ''; Author = '' };
        Principal = [pscustomobject]@{ UserId = ''; LogonType = 0; RunLevel = 1 };
        Settings = [pscustomobject]@{ Enabled = $false; Hidden = $false; AllowDemandStart = $false;
            StartWhenAvailable = $false; DisallowStartIfOnBatteries = $true; StopIfGoingOnBatteries = $true;
            ExecutionTimeLimit = ''; RestartCount = 0; RestartInterval = ''; MultipleInstances = 0 };
        Triggers = $triggers; Actions = $actions }
}

function New-FixtureHeldProcess([int]$Id, [string]$Path, [datetime]$StartTime) {
    $process = [pscustomobject]@{ Id = $Id; Path = $Path; StartTime = $StartTime; Handle = [intptr]::Zero;
        HasExited = $false; KillCount = 0; DisposeCount = 0; WaitCount = 0 }
    $process | Add-Member ScriptMethod Dispose { $this.DisposeCount++ }
    $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) $this.WaitCount++; return $this.HasExited }
    $process | Add-Member ScriptMethod Kill { $this.KillCount++; $this.HasExited = $true }
    return $process
}
$scheduler = [pscustomobject]@{}
$scheduler | Add-Member ScriptMethod NewTask { param($Flags) return New-FixtureDefinition }
try {
    Test-Case 'Native Windows arguments preserve spaces, embedded quotes, and terminal backslashes' {
        Assert-Test ((ConvertTo-AgentBridgeArgument 'C:\Some Folder\') -ceq '"C:\Some Folder\\"') 'Terminal slash was not escaped.'
        Assert-Test ((ConvertTo-AgentBridgeArgument 'before\"after') -ceq '"before\\\"after"') 'Quote was not escaped.'
        Assert-Test ((ConvertTo-AgentBridgeArgument 'a b') -ceq '"a b"') 'Spaces were not protected.'
    }
    Test-Case 'Unsafe local paths are rejected before execution' {
        foreach ($path in @('relative\node.exe', '\\server\share\file', 'C:\', 'C:\test:stream', "C:\test`nfile", 'C:\bad"path')) {
            Expect-Failure { Get-AgentBridgeAbsolutePath $path }
        }
    }
    Test-Case 'Configuration binds project, state and current user' {
        Assert-AgentBridgeConfig $config
        $saved = $config.OwnerId; $config.OwnerId = '0' * 64
        Expect-Failure { Assert-AgentBridgeConfig $config }; $config.OwnerId = $saved
        $saved = $config.UserSid; $config.UserSid = 'S-1-5-18'
        Expect-Failure { Assert-AgentBridgeConfig $config }; $config.UserSid = $saved
    }
    Test-Case 'Native executable validation rejects shell wrappers and missing binaries' {
        $saved = $config.CodexBinary; $config.CodexBinary = Join-Path $project 'runtime\missing.exe'
        Expect-Failure { Assert-AgentBridgeConfig $config }; $config.CodexBinary = $saved
        $wrapper = Join-Path $project 'runtime\codex.cmd'; [IO.File]::WriteAllText($wrapper, 'Never executed.')
        $config.CodexBinary = $wrapper
        Expect-Failure { Assert-AgentBridgeConfig $config }; $config.CodexBinary = $saved
    }
    Test-Case 'Task definition runs hidden, limited, current user with login and failure restart' {
        $script:definition = New-AgentBridgeTaskDefinition $scheduler $config $configFile
        Assert-Test ($definition.Principal.UserId -ceq $sid -and $definition.Principal.LogonType -eq 3 -and $definition.Principal.RunLevel -eq 0) 'Wrong task principal.'
        Assert-Test ($definition.Settings.Hidden -and $definition.Settings.ExecutionTimeLimit -ceq 'PT0S' -and
            -not $definition.Settings.DisallowStartIfOnBatteries -and -not $definition.Settings.StopIfGoingOnBatteries -and
            $definition.Settings.MultipleInstances -eq 2 -and $definition.Settings.RestartCount -eq 3 -and
            $definition.Settings.RestartInterval -ceq 'PT1M') 'Lifetime settings were not retained.'
        Assert-Test ($definition.Triggers.Trigger.Type -eq 9 -and $definition.Triggers.Trigger.UserId -ceq $sid) 'Wrong login trigger.'
        Assert-Test ($definition.Actions.Action.Arguments.Contains(' -WindowStyle Hidden ') -and
            $definition.Actions.Action.Arguments.Contains(' -File "') -and $definition.Actions.Action.Arguments.Contains(' -ConfigPath "')) 'Task arguments lost quoting or hiding.'
    }
    Test-Case 'Existing task collision cannot be overwritten or stopped' {
        $task = [pscustomobject]@{ Definition = $definition }
        Assert-AgentBridgeTaskOwner $task $config $configFile
        $saved = $definition.RegistrationInfo.Description; $definition.RegistrationInfo.Description = 'Another application'
        Expect-Failure { Assert-AgentBridgeTaskOwner $task $config $configFile }; $definition.RegistrationInfo.Description = $saved
        $saved = $definition.Actions.Action.Arguments; $definition.Actions.Action.Arguments += ' -Extra ignored'
        Expect-Failure { Assert-AgentBridgeTaskOwner $task $config $configFile }; $definition.Actions.Action.Arguments = $saved
        $saved = $definition.Principal.RunLevel; $definition.Principal.RunLevel = 1
        Expect-Failure { Assert-AgentBridgeTaskOwner $task $config $configFile }; $definition.Principal.RunLevel = $saved
    }
    Test-Case 'Missing task HRESULT is recognized through a PowerShell invocation wrapper' {
        $folder = [pscustomobject]@{}
        $folder | Add-Member ScriptMethod GetTask { param($Name)
            throw (New-Object Runtime.InteropServices.COMException('Fixture missing task.', -2147024894))
        }
        Assert-Test ($null -eq (Get-AgentBridgeRegisteredTask $folder 'Fixture')) 'Missing task was not recognized.'
        $deniedFolder = [pscustomobject]@{}
        $deniedFolder | Add-Member ScriptMethod GetTask { param($Name)
            throw (New-Object Runtime.InteropServices.COMException('Fixture access denied.', -2147024891))
        }
        Expect-Failure { Get-AgentBridgeRegisteredTask $deniedFolder 'Fixture' }
    }
    Test-Case 'Service metadata writes atomically on initial write and replacement' {
        Write-AgentBridgeJson $configFile $config
        Assert-Test ((Read-AgentBridgeJson $configFile).OwnerId -ceq $config.OwnerId) 'Initial JSON write failed.'
        $config.Port = 43156; Write-AgentBridgeJson $configFile $config
        Assert-Test ((Read-AgentBridgeJson $configFile).Port -eq 43156) 'Atomic replacement failed.'; $config.Port = 43155
        Assert-Test (@(Get-ChildItem -LiteralPath $state -Filter '*.tmp').Count -eq 0) 'Temporary metadata was left behind.'
    }
    Test-Case 'Oversize metadata is rejected' {
        $large = Join-Path $state 'large.json'; [IO.File]::WriteAllText($large, ('a' * 65537))
        Expect-Failure { Read-AgentBridgeJson $large }
    }
    Test-Case 'Process timestamps stay strings on both PowerShell editions' {
        $record = Join-Path $state 'timestamp.json'
        Write-AgentBridgeJson $record ([ordered]@{ StartUtc = '2026-10-20T12:39:55.1094270Z' })
        $readback = Read-AgentBridgeJson $record
        Assert-Test ($readback.StartUtc -is [string] -and $readback.StartUtc -ceq '2026-10-20T12:39:55.1094270Z') 'Timestamp conversion breaks process identity.'
    }
    Test-Case 'Actual JSON roundtrip config accepts native int32 and int64 ports' {
        Write-AgentBridgeJson $configFile $config
        $roundtrip = Read-AgentBridgeJson $configFile
        Assert-AgentBridgeConfig $roundtrip
        $roundtrip.Port = [long]43155
        Assert-AgentBridgeConfig $roundtrip
        foreach ($bad in @([long]0, [long]65536, [long]2147483648, [double]43155, '43155')) {
            $roundtrip.Port = $bad
            Expect-Failure { Assert-AgentBridgeConfig $roundtrip }
        }
    }
    Test-Case 'Actual JSON process identity reaches ownership checks with int64 PIDs' {
        $record = Join-Path $state 'process.json'
        $processRecord = [ordered]@{ Product = 'AgentBridge.Service.Process'; OwnerId = $config.OwnerId;
            NodeBinary = $config.NodeBinary; EntryScript = (Join-Path $config.ProjectDirectory 'src\main.mjs');
            NodePid = [long]43210; RunnerPid = [long]43200; StartUtc = '2026-10-20T12:39:55.1094270Z' }
        Write-AgentBridgeJson $record $processRecord
        $roundtrip = Read-AgentBridgeJson $record
        $roundtrip.NodePid = [long]$roundtrip.NodePid
        $roundtrip.RunnerPid = [long]$roundtrip.RunnerPid
        $script:fixtureProcessQueries = 0
        $script:fixtureProcess = [pscustomobject]@{ Id = 43210; Path = $config.NodeBinary;
            Handle = [intptr]::Zero; HasExited = $false; StartTime = [datetime]'2026-10-20T12:39:55.1094270Z' }
        $script:fixtureProcess | Add-Member ScriptMethod Dispose { }
        function Get-Process {
            param([int]$Id, $ErrorAction)
            $script:fixtureProcessQueries++
            if ($Id -eq 43210) { return $script:fixtureProcess }
        }
        function Get-CimInstance {
            param($ClassName, $Filter, $ErrorAction)
            return [pscustomobject]@{ ExecutablePath = $config.NodeBinary; ParentProcessId = 43200;
                CommandLine = ((ConvertTo-AgentBridgeArgument $config.NodeBinary) + ' ' + (ConvertTo-AgentBridgeArgument $roundtrip.EntryScript)) }
        }
        Assert-Test ($null -ne (Get-AgentBridgeOwnedNode $roundtrip $config)) 'Roundtripped identity was rejected before its valid ownership checks.'
        Assert-Test ($script:fixtureProcessQueries -eq 1) 'Ownership validation did not query the fixture process.'
        foreach ($field in @('NodePid', 'RunnerPid')) {
            $saved = $roundtrip.$field
            foreach ($bad in @([long]0, [long]-1, [long]2147483648, [double]43210, '43210')) {
                $roundtrip.$field = $bad
                Assert-Test ($null -eq (Get-AgentBridgeOwnedNode $roundtrip $config)) 'An invalid process ID was accepted.'
            }
            $roundtrip.$field = $saved
        }
        Assert-Test ($script:fixtureProcessQueries -eq 1) 'Invalid process IDs reached the process API.'
    }
    Test-Case 'Unowned process records are rejected before querying any process' {
        $bad = [pscustomobject]@{ Product = 'AnotherProduct'; OwnerId = $config.OwnerId; NodePid = $PID }
        Assert-Test ($null -eq (Get-AgentBridgeOwnedNode $bad $config)) 'An unowned process was accepted.'
    }
    Test-Case 'Native argument parsing recognizes exact libuv Codex tool arguments' {
        $expected = @($config.CodexBinary, 'app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="auto"')
        $command = ($expected | ForEach-Object { ConvertTo-AgentBridgeArgument $_ }) -join ' '
        Assert-Test (Test-AgentBridgeCommandLine $command $expected) 'Native argument parsing lost literal Codex quotes.'
        Assert-Test (-not (Test-AgentBridgeCommandLine ($command + ' --another') $expected)) 'Extra process arguments were accepted.'
        Assert-Test (-not (Test-AgentBridgeCommandLine ($command + "`n") $expected)) 'A control character was accepted.'
    }
    Test-Case 'Stop terminates only held Node and held Codex children after scheduler leaves them alive' {
        $node = New-FixtureHeldProcess 43210 $config.NodeBinary ([datetime]'2026-10-20T12:39:55Z')
        $child = New-FixtureHeldProcess 43211 $config.CodexBinary ([datetime]'2026-10-20T12:39:56Z')
        $task = [pscustomobject]@{ StopCount = 0 }
        $task | Add-Member ScriptMethod Stop { param($Flags) $this.StopCount++ }
        Stop-AgentBridgeHeldProcesses $task $node @($child)
        Assert-Test ($task.StopCount -eq 1 -and $node.KillCount -eq 1 -and $child.KillCount -eq 1) 'The surviving held processes were not stopped.'
        Assert-Test ($node.DisposeCount -eq 1 -and $child.DisposeCount -eq 1) 'Held process handles were not disposed.'
    }
    Test-Case 'Stop preserves already exited processes without issuing Kill' {
        $node = New-FixtureHeldProcess 43210 $config.NodeBinary ([datetime]'2026-10-20T12:39:55Z'); $node.HasExited = $true
        $child = New-FixtureHeldProcess 43211 $config.CodexBinary ([datetime]'2026-10-20T12:39:56Z'); $child.HasExited = $true
        $task = [pscustomobject]@{}
        $task | Add-Member ScriptMethod Stop { param($Flags) }
        Stop-AgentBridgeHeldProcesses $task $node @($child)
        Assert-Test ($node.KillCount -eq 0 -and $child.KillCount -eq 0) 'An exited process was killed by PID.'
    }
    Test-Case 'Codex cleanup captures only exact native direct app-server children' {
        $node = New-FixtureHeldProcess 43210 $config.NodeBinary ([datetime]'2026-10-20T12:39:55Z')
        $script:childA = New-FixtureHeldProcess 43211 $config.CodexBinary ([datetime]'2026-10-20T12:39:56Z')
        $script:childB = New-FixtureHeldProcess 43212 $config.CodexBinary ([datetime]'2026-10-20T12:39:56Z')
        $script:fixtureChildMetadata = @(
            [pscustomobject]@{ ProcessId = 43211; ParentProcessId = 43210; ExecutablePath = $config.CodexBinary;
                CommandLine = ((ConvertTo-AgentBridgeArgument $config.CodexBinary) + ' app-server --listen stdio://') },
            [pscustomobject]@{ ProcessId = 43212; ParentProcessId = 43210; ExecutablePath = $config.CodexBinary;
                CommandLine = ((ConvertTo-AgentBridgeArgument $config.CodexBinary) + ' app-server --listen stdio:// -c ' + (ConvertTo-AgentBridgeArgument 'cli_auth_credentials_store="auto"')) },
            [pscustomobject]@{ ProcessId = 43213; ParentProcessId = 43210; ExecutablePath = $config.CodexBinary;
                CommandLine = ((ConvertTo-AgentBridgeArgument $config.CodexBinary) + ' app-server --listen stdio:// --another') },
            [pscustomobject]@{ ProcessId = 43214; ParentProcessId = 43210; ExecutablePath = 'C:\Other\codex.exe';
                CommandLine = 'C:\Other\codex.exe app-server --listen stdio://' }
        )
        function Get-CimInstance {
            param($ClassName, $Filter, $ErrorAction)
            if ($Filter -eq 'ParentProcessId=43210') { return $script:fixtureChildMetadata }
            if ($Filter -match '^ProcessId=(\d+)$') { return $script:fixtureChildMetadata | Where-Object ProcessId -eq ([int]$Matches[1]) }
        }
        function Get-Process {
            param([int]$Id, $ErrorAction)
            if ($Id -eq 43211) { return $script:childA }
            if ($Id -eq 43212) { return $script:childB }
            throw 'A non-owned process reached handle acquisition.'
        }
        $held = @(Get-AgentBridgeOwnedCodexChildren $node $config)
        Assert-Test ($held.Count -eq 2 -and $held[0].Id -eq 43211 -and $held[1].Id -eq 43212) 'Codex child capture was not exact.'
        foreach ($process in $held) { $process.Dispose() }
    }
    Test-Case 'Supervisor identity binds native binary, action, config, process start, and task run' {
        $script:runnerProcess = New-FixtureHeldProcess 43200 $config.PowerShellBinary ([datetime]'2026-10-20T12:39:55.1000000Z')
        $task = [pscustomobject]@{ State = 4; LastRunTime = [datetime]'2026-10-20T12:39:55.0000000Z' }
        $record = [pscustomobject]@{ OwnerId = $config.OwnerId; RunnerPid = [long]43200;
            RunnerBinary = $config.PowerShellBinary; RunnerConfigPath = $configFile; TaskName = $config.TaskName;
            RunnerStartUtc = $script:runnerProcess.StartTime.ToUniversalTime().ToString('o'); TaskRunUtc = $task.LastRunTime.ToUniversalTime().ToString('o') }
        $script:runnerCommand = (ConvertTo-AgentBridgeArgument $config.PowerShellBinary) + ' ' + (Get-AgentBridgeTaskArguments $config.RunnerPath $configFile)
        function Get-Process { param([int]$Id, $ErrorAction) if ($Id -eq 43200) { return $script:runnerProcess } }
        function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
            return [pscustomobject]@{ ExecutablePath = $config.PowerShellBinary; CommandLine = $script:runnerCommand }
        }
        Assert-Test ($null -ne (Get-AgentBridgeOwnedRunner $record $config $task $configFile)) 'The exact scheduled supervisor was rejected.'
        $saved = $script:runnerCommand; $script:runnerCommand += ' -AnotherArgument'
        Assert-Test ($null -eq (Get-AgentBridgeOwnedRunner $record $config $task $configFile)) 'A different supervisor action was accepted.'; $script:runnerCommand = $saved
        $task.LastRunTime = $task.LastRunTime.AddMinutes(1)
        Assert-Test ($null -eq (Get-AgentBridgeOwnedRunner $record $config $task $configFile)) 'An old supervisor was attached to a new task run.'
        $task.LastRunTime = $task.LastRunTime.AddMinutes(-1)
        $script:runnerProcess.StartTime = $script:runnerProcess.StartTime.AddSeconds(1)
        Assert-Test ($null -eq (Get-AgentBridgeOwnedRunner $record $config $task $configFile)) 'A reused runner PID was accepted.'
    }
    Test-Case 'Running task plus healthy orphan Node cannot report ready or independent' {
        $processRecord = [ordered]@{ Product = 'AgentBridge.Service.Process'; OwnerId = $config.OwnerId;
            NodeBinary = $config.NodeBinary; EntryScript = (Join-Path $config.ProjectDirectory 'src\main.mjs');
            NodePid = [long]43210; RunnerPid = [long]43200; StartUtc = '2026-10-20T12:39:55.1094270Z';
            RunnerBinary = $config.PowerShellBinary; RunnerConfigPath = $configFile; TaskName = $config.TaskName;
            RunnerStartUtc = '2026-10-20T12:39:55.0000000Z'; TaskRunUtc = '2026-10-20T12:39:54.0000000Z' }
        Write-AgentBridgeJson (Join-Path $state 'process.json') $processRecord
        $script:orphanNode = New-FixtureHeldProcess 43210 $config.NodeBinary ([datetime]'2026-10-20T12:39:55.1094270Z')
        function Get-Process { param([int]$Id, $ErrorAction) if ($Id -eq 43210) { return $script:orphanNode } }
        function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
            return [pscustomobject]@{ ExecutablePath = $config.NodeBinary; ParentProcessId = 43200;
                CommandLine = ((ConvertTo-AgentBridgeArgument $config.NodeBinary) + ' ' + (ConvertTo-AgentBridgeArgument $processRecord.EntryScript)) }
        }
        function Get-NetTCPConnection { throw 'An orphan supervisor must not reach HTTP/listener readiness.' }
        function Invoke-RestMethod { throw 'An orphan supervisor must not reach HTTP/listener readiness.' }
        $task = [pscustomobject]@{ State = 4; LastRunTime = [datetime]'2026-10-20T12:40:00Z' }
        $status = Get-AgentBridgeServiceStatus $task $config $state
        Assert-Test ($status.NodeRunning -and -not $status.RunnerRunning -and -not $status.Ready -and -not $status.IndependentOfCodex) 'An orphan was reported as supervised and ready.'
        $before = (Get-FileHash -LiteralPath (Join-Path $state 'process.json')).Hash
        Expect-Failure { Assert-AgentBridgeNoExistingProcess $config $state }
        Assert-Test ((Get-FileHash -LiteralPath (Join-Path $state 'process.json')).Hash -ceq $before) 'Startup rewrote an alive orphan identity.'
    }
    Write-Output ('Passed ' + $script:passed + ' AgentBridge service offline checks. No tasks registered or processes launched.')
} finally {
    if ([IO.Path]::GetFullPath($fixtureRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
