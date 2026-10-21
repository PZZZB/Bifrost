[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\ClaudeModeCore.ps1'))
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Claude mode core does not parse.' }
. $source
$script:passed = 0
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('claude-mode-core-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null

function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) { & $Body; $script:passed++; Write-Output "PASS $Name" }
function Write-TestJson([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllBytes($Path, (ConvertTo-ClaudeModeBytes $Value))
}
function Protect-TestDirectory([string]$Path) {
    $access = New-Object Security.AccessControl.DirectorySecurity
    $access.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),
            [Security.AccessControl.FileSystemRights]::FullControl,
            ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$access.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $access
}
function New-Fixture([string]$ActualMode = '1p', [string]$InstalledMode = '1p') {
    $fixtureHome = Join-Path $testRoot ([guid]::NewGuid().ToString('N'))
    $state = Join-Path $fixtureHome 'AppData\Local\CodexWithGateway\with-vm'
    [IO.Directory]::CreateDirectory($state) | Out-Null
    Protect-TestDirectory $state
    $profileId = '8c2be9ad-3973-477e-9550-f3eb09a79fab'
    $package = 'Claude_pzs8sxrjxfjjc'
    $layout = Get-ClaudeModeLayout $fixtureHome $state $package $profileId
    $files = @(); $modePaths = @(); $profilePaths = @()
    foreach ($path in $layout.Paths.Keys) {
        $kind = $layout.Paths[$path]
        $values = switch ($kind) {
            'mode' { [ordered]@{ deploymentMode = $InstalledMode } }
            'profile' { [ordered]@{ inferenceProvider = 'gateway'; inferenceGatewayBaseUrl = 'http://127.0.0.1:43157';
                inferenceGatewayApiKey = 'PRIVATE_FIXTURE_KEY'; inferenceGatewayAuthScheme = 'bearer';
                disableDeploymentModeChooser = $false; inferenceModels = @('claude-codebuddy-opus-5-5'); alwaysStartWithDefaultModel = $true } }
            'meta' { [ordered]@{ entries = @([ordered]@{ id = $profileId; name = 'Gateway' }); appliedId = $profileId } }
        }
        $document = [ordered]@{ unrelated = [ordered]@{ theme = 'dark'; flags = @($true, $false); empty = @(); nullable = @($null, 'keep', $null);
            stamp = '2026-10-19T00:00:00.123+08:00'; nested = [ordered]@{ unchanged = 17 } } }
        $fields = @()
        foreach ($key in $values.Keys) {
            $document[$key] = $values[$key]
            $fields += [ordered]@{ Key = $key; Original = [ordered]@{ Exists = $false };
                Installed = [ordered]@{ Exists = $true; Value = $values[$key] } }
        }
        if ($kind -ceq 'mode') { $document.deploymentMode = $ActualMode; $modePaths += $path }
        if ($kind -ceq 'profile') { $profilePaths += $path }
        Write-TestJson $path $document
        $files += [ordered]@{ Path = $path; Fields = $fields; OriginalExists = $false; OriginalHash = $null; Backup = 'original-installation-backup' }
    }
    Write-TestJson $layout.Manifest ([ordered]@{ Version = 1; Phase = 'installed'; Home = $fixtureHome; ProfileId = $profileId;
        Files = $files; BackupDirectory = 'original-installation-backup'; unrelatedManifest = 'preserved' })
    return [ordered]@{ HomePath = $fixtureHome; StateRoot = $state; Layout = $layout; Modes = $modePaths; Profiles = $profilePaths }
}
function Invoke-FixtureMode($Fixture, [string]$Mode) { Set-ClaudeDesktopMode -Mode $Mode -HomePath $Fixture.HomePath -StateRoot $Fixture.StateRoot }
function Get-FixtureHashes($Fixture) {
    $map = @{}
    foreach ($path in @($Fixture.Layout.Paths.Keys) + @($Fixture.Layout.Manifest)) { $map[$path] = Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $path) }
    return ,$map
}
function Get-Originals($Fixture) {
    $manifest = (Read-ClaudeModeDocument $Fixture.Layout.Manifest).Data
    return ConvertTo-Json -Depth 100 -Compress -InputObject @(foreach ($file in $manifest.Files) {
        [ordered]@{ Path = $file.Path; OriginalHash = $file.OriginalHash; Backup = $file.Backup;
            Fields = @(foreach ($field in $file.Fields) { [ordered]@{ Key = $field.Key; Original = $field.Original } }) }
    })
}
function Assert-SafeFailure([scriptblock]$Body) {
    $caught = $false
    try { & $Body | Out-Null } catch {
        $caught = $true
        Assert-Test (-not $_.Exception.Message.Contains('PRIVATE_')) 'Failure disclosed private fixture data.'
        Assert-Test ($_.Exception.Message -match '^Claude mode switch') 'Failure did not use a safe core message.'
    }
    Assert-Test $caught 'Expected a safe refusal.'
}
function Stage-Interrupted($Fixture, [string]$Phase = 'prepared', [int]$Written = 1) {
    [IO.Directory]::CreateDirectory($Fixture.Layout.Pending) | Out-Null
    $plans = @(); $afterBytes = @()
    for ($index = 0; $index -lt 2; $index++) {
        $path = $Fixture.Modes[$index]; $document = Read-ClaudeModeDocument $path
        $document.Data.deploymentMode = '3p'; $after = ConvertTo-ClaudeModeBytes $document.Data
        [IO.File]::WriteAllBytes((Join-Path $Fixture.Layout.Pending "$index.before"), $document.Bytes)
        $plans += [ordered]@{ Path = $path; BeforeHash = $document.Hash; AfterHash = (Get-ClaudeModeBytesHash $after); Backup = "$index.before" }
        $afterBytes += ,$after
    }
    $journal = [ordered]@{ Version = 1; Home = $Fixture.HomePath; ProfileId = $Fixture.Layout.Profile; PackageFamily = $Fixture.Layout.Package;
        Phase = $Phase; Plans = $plans }
    Save-ClaudeModeJournal $Fixture.Layout.Pending $journal
    for ($index = 0; $index -lt $Written; $index++) { [IO.File]::WriteAllBytes($plans[$index].Path, $afterBytes[$index]) }
    return $journal
}

try {
    Test-Case 'both directions preserve provider settings, Original records, unrelated data and ownership' {
        $fixture = New-Fixture
        $originals = Get-Originals $fixture
        $owners = @{}; foreach ($path in @($fixture.Layout.Paths.Keys) + @($fixture.Layout.Manifest)) { $owners[$path] = (Get-Acl -LiteralPath $path).Owner }
        foreach ($mode in @('CodeBuddy', 'Account')) {
            $result = Invoke-FixtureMode $fixture $mode
            $expected = if ($mode -ceq 'Account') { '1p' } else { '3p' }
            Assert-Test ($result.Success -and $result.Mode -ceq $mode -and $result.DeploymentMode -ceq $expected -and $result.RestartRequired) 'Mode result is incorrect.'
            Assert-Test ($result.FilesChanged -eq 4 -and $result.Changed -and -not $result.RealInference) 'Unexpected changed file count.'
            Assert-Test ((Get-Originals $fixture) -ceq $originals) 'Original recovery records changed.'
            foreach ($path in $fixture.Modes) { Assert-Test ((Read-ClaudeModeDocument $path).Data.deploymentMode -ceq $expected) 'A mode copy did not switch.' }
            foreach ($path in $fixture.Profiles) {
                $data = (Read-ClaudeModeDocument $path).Data
                Assert-Test ($data.disableDeploymentModeChooser -eq $false -and $data.inferenceGatewayApiKey -ceq 'PRIVATE_FIXTURE_KEY' -and
                    $data.inferenceGatewayBaseUrl -ceq 'http://127.0.0.1:43157' -and $data.inferenceModels.Count -eq 1 -and
                    $data.inferenceModels[0] -ceq 'claude-codebuddy-opus-5-5') 'A provider profile changed.'
            }
            foreach ($path in $fixture.Layout.Paths.Keys) {
                $data = (Read-ClaudeModeDocument $path).Data
                Assert-Test ($data.unrelated.theme -ceq 'dark' -and $data.unrelated.empty.Count -eq 0 -and
                    $data.unrelated.stamp -ceq '2026-10-19T00:00:00.123+08:00' -and $data.unrelated.nested.unchanged -eq 17 -and
                    $data.unrelated.nullable.Count -eq 3 -and $null -eq $data.unrelated.nullable[0] -and $null -eq $data.unrelated.nullable[2]) 'Unrelated settings changed.'
                Assert-Test ((Get-Acl -LiteralPath $path).Owner -ceq $owners[$path]) 'File owner changed.'
            }
            $manifest = (Read-ClaudeModeDocument $fixture.Layout.Manifest).Data
            foreach ($file in $manifest.Files) { foreach ($field in $file.Fields) {
                Assert-Test (Test-ClaudeModeField (Get-ClaudeModeField (Read-ClaudeModeDocument $file.Path).Data $field.Key) $field.Installed) 'Installed records were not synchronized.'
            } }
            Assert-Test (-not (ConvertTo-Json -InputObject $result).Contains('PRIVATE_')) 'Result exposed credentials.'
            Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Successful switching retained secret snapshots.'
        }
    }
    Test-Case 'idempotent calls do not rewrite files or accumulate backups' {
        $fixture = New-Fixture
        $before = Get-FixtureHashes $fixture
        1..4 | ForEach-Object { $result = Invoke-FixtureMode $fixture 'Account'; Assert-Test (-not $result.Changed) 'Idempotent switch changed files.' }
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Idempotent switch rewrote a file.' }
        Assert-Test (@(Get-ChildItem -LiteralPath $fixture.StateRoot -Force).Count -eq 1) 'Mode snapshots accumulated.'
    }
    Test-Case 'native 1p and 3p drift remains accepted while installed mode records synchronize' {
        $fixture = New-Fixture '1p' '3p'
        $result = Invoke-FixtureMode $fixture 'Account'
        Assert-Test ($result.Success -and $result.Changed -and $result.FilesChanged -eq 0) 'Native mode drift was blocked or unnecessarily rewritten.'
        Assert-Test (-not (Invoke-FixtureMode $fixture 'Account').Changed) 'Mode record synchronization was not idempotent.'
    }
    Test-Case 'native clear removes mode fields without blocking either shortcut' {
        $fixture = New-Fixture '1p' '3p'
        foreach ($path in $fixture.Modes) { $document = (Read-ClaudeModeDocument $path).Data; $document.Remove('deploymentMode'); Write-TestJson $path $document }
        $result = Invoke-FixtureMode $fixture 'CodeBuddy'
        Assert-Test ($result.Success -and $result.FilesChanged -eq 4) 'Native clear blocked mode selection.'
        foreach ($path in $fixture.Modes) { Assert-Test ((Read-ClaudeModeDocument $path).Data.deploymentMode -ceq '3p') 'Mode was not recreated after native clear.' }
        foreach ($invalid in @($null, [ordered]@{ invalid = 'PRIVATE_MODE_OBJECT' })) {
            $document = (Read-ClaudeModeDocument $fixture.Modes[0]).Data; $document.deploymentMode = $invalid; Write-TestJson $fixture.Modes[0] $document
            Assert-SafeFailure { Invoke-FixtureMode $fixture 'Account' }
        }
    }
    Test-Case 'managed provider changes are refused without revealing secrets' {
        $fixture = New-Fixture
        $document = (Read-ClaudeModeDocument $fixture.Profiles[0]).Data
        $document.inferenceGatewayApiKey = 'PRIVATE_CONCURRENT_KEY'; Write-TestJson $fixture.Profiles[0] $document
        $before = Get-FixtureHashes $fixture
        Assert-SafeFailure { Invoke-FixtureMode $fixture 'CodeBuddy' }
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Refusal changed configuration.' }
    }
    Test-Case 'invalid JSON, invalid mode values and missing managed files fail safely' {
        foreach ($case in @('json', 'mode', 'missing')) {
            $fixture = New-Fixture
            if ($case -ceq 'json') { [IO.File]::WriteAllText($fixture.Modes[0], '{"PRIVATE_BROKEN_JSON":') }
            elseif ($case -ceq 'mode') { $document = (Read-ClaudeModeDocument $fixture.Modes[0]).Data; $document.deploymentMode = 'PRIVATE_BAD_MODE'; Write-TestJson $fixture.Modes[0] $document }
            else { Remove-Item -LiteralPath $fixture.Modes[0] }
            Assert-SafeFailure { Invoke-FixtureMode $fixture 'CodeBuddy' }
            Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Invalid source created a transaction.'
        }
    }
    Test-Case 'manifest paths, duplicate files and package identifiers cannot escape the selected home' {
        foreach ($case in @('outside', 'duplicate', 'package')) {
            $fixture = New-Fixture
            if ($case -ceq 'package') { Assert-SafeFailure { Set-ClaudeDesktopMode -Mode Account -HomePath $fixture.HomePath -StateRoot $fixture.StateRoot -PackageFamily '..\PRIVATE_ESCAPE' }; continue }
            $manifest = (Read-ClaudeModeDocument $fixture.Layout.Manifest).Data
            if ($case -ceq 'outside') { $manifest.Files[0].Path = Join-Path $testRoot 'PRIVATE_OUTSIDE.json' }
            else { $manifest.Files[1].Path = $manifest.Files[0].Path }
            Write-TestJson $fixture.Layout.Manifest $manifest
            Assert-SafeFailure { Invoke-FixtureMode $fixture 'CodeBuddy' }
        }
    }
    Test-Case 'a directory junction cannot redirect a managed file' {
        $fixture = New-Fixture
        $path = $fixture.Modes[0]; $directory = [IO.Path]::GetDirectoryName($path)
        $external = Join-Path $testRoot ('external-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($external) | Out-Null
        Remove-Item -LiteralPath $path; [IO.Directory]::Delete($directory)
        New-Item -ItemType Junction -Path $directory -Target $external | Out-Null
        try { Assert-SafeFailure { Invoke-FixtureMode $fixture 'CodeBuddy' } }
        finally { [IO.Directory]::Delete($directory) }
    }
    Test-Case 'an interrupted partial switch rolls back exact hashes and removes its partial staging file' {
        $fixture = New-Fixture; $before = Get-FixtureHashes $fixture
        $journal = Stage-Interrupted $fixture
        [IO.File]::WriteAllText(($journal.Plans[0].Path + '.claude-mode.tmp'), 'PRIVATE_PARTIAL_STAGING')
        [IO.File]::WriteAllText((Join-Path $fixture.Layout.Pending 'journal.tmp'), 'PRIVATE_PARTIAL_JOURNAL')
        $result = Invoke-FixtureMode $fixture 'Account'
        Assert-Test ($result.RecoveredInterruptedOperation -and -not $result.Changed) 'Interrupted switch was not recovered.'
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Recovery did not restore original bytes.' }
        Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Recovered switch retained snapshots.'
        Assert-Test (-not (Test-Path -LiteralPath ($journal.Plans[0].Path + '.claude-mode.tmp'))) 'Partial staging retained a secret file.'
    }
    Test-Case 'an interrupted all-after switch finishes cleanup instead of rolling back applied files' {
        $fixture = New-Fixture
        [void](Stage-Interrupted $fixture 'prepared' 2)
        $result = Invoke-FixtureMode $fixture 'CodeBuddy'
        Assert-Test ($result.RecoveredInterruptedOperation -and $result.FilesChanged -eq 2) 'Completed writes were incorrectly rolled back.'
        Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Completed recovery retained snapshots.'
    }
    Test-Case 'preparing and committed cleanup resume after incomplete snapshot creation or removal' {
        foreach ($phase in @('preparing', 'committed', 'rolled_back')) {
            $fixture = New-Fixture
            [void](Stage-Interrupted $fixture $phase 0)
            if ($phase -ceq 'preparing') { [IO.File]::WriteAllText((Join-Path $fixture.Layout.Pending '0.before'), 'PRIVATE_PARTIAL_SNAPSHOT') }
            else { Remove-Item -LiteralPath (Join-Path $fixture.Layout.Pending '0.before') }
            $result = Invoke-FixtureMode $fixture 'Account'
            Assert-Test ($result.RecoveredInterruptedOperation -and -not $result.Changed) 'Interrupted snapshot cleanup failed.'
            Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Cleanup left recovery secrets behind.'
        }
    }
    Test-Case 'the initial journal-write interruption is recoverable without touching configuration' {
        $fixture = New-Fixture
        [IO.Directory]::CreateDirectory($fixture.Layout.Pending) | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture.Layout.Pending 'journal.tmp'), 'PRIVATE_PARTIAL_JOURNAL')
        $result = Invoke-FixtureMode $fixture 'Account'
        Assert-Test ($result.RecoveredInterruptedOperation -and -not $result.Changed) 'Initial journal interruption was not cleaned.'
    }
    Test-Case 'preparing cleanup refuses a target edited after snapshot preparation' {
        $fixture = New-Fixture
        $journal = Stage-Interrupted $fixture 'preparing' 0
        $document = (Read-ClaudeModeDocument $journal.Plans[0].Path).Data; $document.nativeEdit = 'PRIVATE_NEW_SETTING'
        Write-TestJson $journal.Plans[0].Path $document
        $before = Get-FixtureHashes $fixture
        Assert-SafeFailure { Invoke-FixtureMode $fixture 'Account' }
        Assert-Test ([IO.File]::Exists((Join-Path $fixture.Layout.Pending '0.before'))) 'Concurrent preparing edit discarded recovery state.'
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Preparing recovery overwrote a concurrent edit.' }
    }
    Test-Case 'unknown transaction files are preserved with existing snapshots' {
        $fixture = New-Fixture
        [void](Stage-Interrupted $fixture 'prepared' 1)
        $unknown = Join-Path $fixture.Layout.Pending 'PRIVATE_UNKNOWN_FILE'
        [IO.File]::WriteAllText($unknown, 'PRIVATE_DATA')
        $before = Get-FixtureHashes $fixture
        Assert-SafeFailure { Invoke-FixtureMode $fixture 'Account' }
        Assert-Test ([IO.File]::Exists($unknown) -and [IO.File]::Exists((Join-Path $fixture.Layout.Pending '0.before'))) 'Unknown-file refusal discarded recovery files.'
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Unexpected recovery contents changed configuration.' }
    }
    Test-Case 'concurrent edits block rollback and retain only one bounded transaction' {
        $fixture = New-Fixture
        $journal = Stage-Interrupted $fixture 'prepared' 1
        $document = (Read-ClaudeModeDocument $journal.Plans[0].Path).Data
        $document.nativeEdit = 'PRIVATE_CONCURRENT_EDIT'; Write-TestJson $journal.Plans[0].Path $document
        $before = Get-FixtureHashes $fixture
        1..2 | ForEach-Object { Assert-SafeFailure { Invoke-FixtureMode $fixture 'Account' } }
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Rollback overwrote a concurrent edit.' }
        Assert-Test (@(Get-ChildItem -LiteralPath $fixture.StateRoot -Directory).Count -eq 1) 'Failed calls accumulated snapshot directories.'
    }
    Test-Case 'a write failure rolls back completed files and does not leak its exception' {
        $fixture = New-Fixture; $before = Get-FixtureHashes $fixture
        $script:realAtomic = ${function:Write-ClaudeModeAtomic}; $script:atomicCalls = 0
        function Write-ClaudeModeAtomic([string]$Path, [byte[]]$Bytes, [string]$ExpectedHash, [string]$TemporaryPath) {
            $script:atomicCalls++
            if ($script:atomicCalls -eq 2) { throw 'PRIVATE_INJECTED_WRITE_FAILURE' }
            & $script:realAtomic @PSBoundParameters
        }
        try { Assert-SafeFailure { Invoke-FixtureMode $fixture 'CodeBuddy' } }
        finally { Set-Item -Path Function:Write-ClaudeModeAtomic -Value $script:realAtomic }
        $after = Get-FixtureHashes $fixture
        foreach ($path in $before.Keys) { Assert-Test ($after[$path] -ceq $before[$path]) 'Exception rollback failed to restore exact bytes.' }
        Assert-Test (-not (Test-Path -LiteralPath $fixture.Layout.Pending)) 'Successful exception rollback retained snapshots.'
    }
    Test-Case 'the named mutex serializes another runspace before any configuration write' {
        $fixture = New-Fixture; $before = Get-FixtureHashes $fixture
        $mutex = [Threading.Mutex]::new($false, (Get-ClaudeModeMutexName $fixture.HomePath)); $taken = $mutex.WaitOne(1000)
        Assert-Test $taken 'Test could not acquire the mode mutex.'
        $worker = [PowerShell]::Create()
        [void]$worker.AddScript({ param($Core, $FixtureHomePath, $FixtureStateRoot)
            . $Core
            Set-ClaudeDesktopMode -Mode CodeBuddy -HomePath $FixtureHomePath -StateRoot $FixtureStateRoot
        }).AddArgument($source).AddArgument($fixture.HomePath).AddArgument($fixture.StateRoot)
        $job = $worker.BeginInvoke()
        try {
            [Threading.Thread]::Sleep(200)
            Assert-Test (-not $job.IsCompleted) 'Concurrent mode call did not wait for the mutex.'
            $current = Get-FixtureHashes $fixture
            foreach ($path in $before.Keys) { Assert-Test ($current[$path] -ceq $before[$path]) 'A blocked call wrote configuration.' }
            $mutex.ReleaseMutex(); $taken = $false
            $output = @($worker.EndInvoke($job))
            Assert-Test (-not $worker.HadErrors -and $output.Count -eq 1 -and $output[0].Success) 'Serialized mode call did not finish.'
        } finally { if ($taken) { $mutex.ReleaseMutex() }; $mutex.Dispose(); $worker.Dispose() }
    }
    Write-Output "Claude mode core: $script:passed fixtures passed; no VM, process control, network, or model calls."
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTestRoot) -like 'claude-mode-core-test-*') { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
