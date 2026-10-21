[CmdletBinding()]
param()

# Real temporary config files and ACLs; all VM/network/service/netsh entry points
# are replaced. No guest, firewall, inference or proxy configuration is touched.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $projectRoot 'scripts\Repair-ClaudeVmGateway.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Repair host script does not parse.' }
$literal = $ast.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'SingleQuotedHereString' }, $true)
$gt = $null; $ge = $null
$guestAst = [Management.Automation.Language.Parser]::ParseInput($literal.Value, [ref]$gt, [ref]$ge)
if ($ge.Count) { throw 'Repair guest script does not parse.' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([scriptblock]::Create($definition.Extent.Text)) }
foreach ($definition in $guestAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($definition.Extent.Text)) }
$utf8 = New-Object Text.UTF8Encoding($false)
$loopbackUrl = 'http://127.0.0.1:43157'; $backendUrl = 'http://192.168.168.1:43157'
$profileId = '8c2be9ad-3973-477e-9550-f3eb09a79fab'
$testRoot = Join-Path $projectRoot ('.state\loopback-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$passed = 0; $caseNumber = 0
$realWriteBytes = ${function:Write-Bytes}; $realNewFileChange = ${function:New-FileChange}

function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Block) { $failed = $false; try { & $Block | Out-Null } catch { $failed = $true }; Assert-Test $failed 'Expected refusal did not happen.' }
function Clone-Test($Value) { return To-Map ($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json) }
function Write-Fixture([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 100), $utf8)
}
function Assert-GuestAdministrator { if (-not $script:admin) { throw 'Mock guest is not elevated.' } }
function Get-ForwardState {
    $script:stateReads++
    if ($script:injectMappingAtRead -eq $script:stateReads) { $script:fakeState.Mappings += [ordered]@{ Kind = 'v4tov4'; Listen = '127.0.0.1/43157'; Connect = '192.168.168.1/43157' } }
    return Clone-Test $script:fakeState
}
function Add-Forward {
    $script:adds++
    $script:fakeState.Mappings += [ordered]@{ Kind = 'v4tov4'; Listen = '127.0.0.1/43157'; Connect = '192.168.168.1/43157' }
    $script:fakeState.Listeners = @([ordered]@{ Address = '127.0.0.1'; Process = 4 })
}
function Remove-Forward {
    $script:removes++
    $script:fakeState.Mappings = @($script:fakeState.Mappings | Where-Object { $_.Kind -cne 'v4tov4' -or $_.Listen -cne '127.0.0.1/43157' })
    $script:fakeState.Listeners = @()
}
function Start-Service($Name, $ErrorAction) { Assert-Test ($Name -ceq 'iphlpsvc') 'Unexpected service start.'; $script:starts++; $script:fakeState.Status = 'Running' }
function Stop-Service($Name, $ErrorAction) { Assert-Test ($Name -ceq 'iphlpsvc') 'Unexpected service stop.'; $script:stops++; $script:fakeState.Status = 'Stopped' }
function Get-Service($Name) { return New-Object psobject | Add-Member ScriptMethod WaitForStatus { param($Status, $Timeout) } -PassThru }
function Invoke-RepairVm { throw 'An offline fixture tried to invoke the VM.' }
function Get-GatewayMetadata([string]$Path, [string]$Key) {
    Assert-Test ($Key -ceq 'fixture-private-key') 'Existing profile key was not read locally.'
    Assert-Test ($Path -cin @('/health', '/v1/models')) 'A non-metadata endpoint was requested.'
    $script:metadataCalls.Add($Path)
    if ($script:networkFails) { throw 'Mock metadata is unavailable.' }
    if ($Path -ceq '/health') { return Clone-Test $script:health }
    return [ordered]@{ data = @($script:catalogIds | ForEach-Object { [ordered]@{ id = $_ } }) }
}
function Write-Bytes([string]$Path, [byte[]]$Bytes, $ExpectedHash) {
    if ($script:failWritePath -and $Path -ceq $script:failWritePath) { $script:failWritePath = $null; throw 'Mock atomic write interrupted.' }
    & $realWriteBytes $Path $Bytes $ExpectedHash
}
function New-FileChange([string]$Path, $Value, [int]$Index) {
    if ($script:editManifestAtSnapshot -and $Path -ceq $guestManifestPath) {
        $script:editManifestAtSnapshot = $false
        $edit = Read-Json $Path; $edit.External = 'concurrent'; Write-Fixture $Path $edit
    }
    & $realNewFileChange $Path $Value $Index
}
function New-Case([switch]$NewInstall) {
    $script:caseNumber++
    $fixtureHome = Join-Path $testRoot "case-$caseNumber\home"
    $script:request = [ordered]@{ Action = 'Apply'; Id = ([guid]::NewGuid().ToString('N')); ForwardOnly = [bool]$NewInstall; Home = $fixtureHome; PackageFamily = 'Claude_fixture'; ProfileId = $profileId }
    $script:stateRoot = Join-Path $fixtureHome 'AppData\Local\CodexWithGateway\with-vm\loopback-repair'
    [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
    $script:journalPath = Join-Path $stateRoot 'journal.json'; $script:guestManifestPath = Join-Path $fixtureHome 'AppData\Local\CodexWithGateway\with-vm\manifest.json'
    $script:journal = $null; $script:journalHash = $null
    $script:admin = $true; $script:adds = 0; $script:removes = 0; $script:starts = 0; $script:stops = 0; $script:stateReads = 0; $script:injectMappingAtRead = 0
    $script:failWritePath = $null; $script:editManifestAtSnapshot = $false; $script:networkFails = $false
    $script:metadataCalls = New-Object Collections.Generic.List[string]
    $script:fakeState = [ordered]@{ Mappings = @(); Status = 'Running'; StartMode = 'Auto'; ProcessId = 100; Listeners = @() }
    $script:health = [ordered]@{ ok = $true; provider = @{ authenticated = $true; ready = $true }; providers = @{ CodeBuddy = @{ authenticated = $true; ready = $true } } }
    $script:catalogIds = @('claude-opus-5-5', 'claude-codebuddy-opus-5-5')
    if ($NewInstall) { return }
    $files = @()
    foreach ($path in @(Get-ProfilePaths)) {
        Write-Fixture $path ([ordered]@{ inferenceProvider = 'gateway'; inferenceGatewayBaseUrl = $backendUrl; inferenceGatewayApiKey = 'fixture-private-key'; inferenceGatewayAuthScheme = 'bearer';
            inferenceModels = @('claude-opus-5-5', 'claude-codebuddy-opus-5-5'); theme = 'dark'; deploymentMode = '1p'; mcpServers = @{ existing = @{ command = 'keep' } } })
        $files += [ordered]@{ Path = $path; OriginalExists = $false; OriginalHash = $null; Backup = 'existing-configure-backup'; Fields = @(
            [ordered]@{ Key = 'inferenceGatewayBaseUrl'; Original = @{ Exists = $false }; Installed = @{ Exists = $true; Value = $backendUrl } },
            [ordered]@{ Key = 'inferenceModels'; Original = @{ Exists = $true; Value = @('original-model') }; Installed = @{ Exists = $true; Value = @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') } }
        ) }
    }
    Write-Fixture $guestManifestPath ([ordered]@{ Version = 1; Phase = 'installed'; Home = $fixtureHome; ProfileId = $profileId; Files = $files; BackupDirectory = 'untouched-original-backups'; Other = 'preserve' })
}

try {
    # Default Plan must not stage files or reach the VM, even without an installation.
    $planState = Join-Path $testRoot 'plan\with-vm'
    $plan = & $source -StateDir $planState -VmInvoker (Join-Path $testRoot 'missing-invoker.ps1') | ConvertFrom-Json
    Assert-Test ($plan.ReadOnly -and -not $plan.GuestChecked -and -not (Test-Path -LiteralPath $planState)) 'Plan changed state or needed the VM.'
    $passed++

    New-Case
    $beforeManifest = Read-Json $guestManifestPath
    $result = Invoke-RepairGuest
    Assert-Test ($result.Success -and $result.Phase -ceq 'installed' -and $adds -eq 1 -and ($metadataCalls -join ',') -ceq '/health,/v1/models') 'Apply did not perform the exact forwarding/metadata steps.'
    foreach ($path in @(Get-ProfilePaths)) {
        $profile = Read-Json $path
        Assert-Test ($profile.inferenceGatewayBaseUrl -ceq $loopbackUrl -and $profile.theme -ceq 'dark' -and $profile.deploymentMode -ceq '1p' -and $profile.mcpServers.existing.command -ceq 'keep') 'Repair changed unrelated profile fields.'
    }
    $afterManifest = Read-Json $guestManifestPath
    for ($i=0; $i -lt 2; $i++) {
        Assert-Test (($afterManifest.Files[$i].Fields[0].Original | ConvertTo-Json -Compress) -ceq ($beforeManifest.Files[$i].Fields[0].Original | ConvertTo-Json -Compress)) 'Configure Original was changed.'
        Assert-Test ($afterManifest.Files[$i].Backup -ceq $beforeManifest.Files[$i].Backup -and $afterManifest.Files[$i].Fields[0].Installed.Value -ceq $loopbackUrl) 'Installed URL or backup ownership is wrong.'
    }
    $passed++

    $profileHashes = @((Get-ProfilePaths) | ForEach-Object { Hash-File $_ }); $manifestHash = Hash-File $guestManifestPath
    $result = Invoke-RepairGuest
    Assert-Test ($adds -eq 1 -and $manifestHash -ceq (Hash-File $guestManifestPath) -and ($profileHashes -join ',') -ceq (@((Get-ProfilePaths) | ForEach-Object { Hash-File $_ }) -join ',')) 'Repeated Apply rewrote an installed migration.'
    $passed++

    # Later unrelated edits survive explicit Restore; original Configure recovery is retained.
    foreach ($path in @(Get-ProfilePaths)) { $p = Read-Json $path; $p.theme = 'light'; Write-Fixture $path $p }
    $m = Read-Json $guestManifestPath; $m.Later = 'keep'; Write-Fixture $guestManifestPath $m
    $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test ($result.Phase -ceq 'restored' -and $removes -eq 1 -and (Read-Json $guestManifestPath).Later -ceq 'keep') 'Restore did not remove only its owned mapping.'
    foreach ($path in @(Get-ProfilePaths)) { $p = Read-Json $path; Assert-Test ($p.inferenceGatewayBaseUrl -ceq $backendUrl -and $p.theme -ceq 'light') 'Restore lost an unrelated edit or did not restore URL.' }
    $passed++
    $result = Invoke-RepairGuest
    Assert-Test ($removes -eq 1 -and $result.Phase -ceq 'restored') 'Repeated Restore was not idempotent.'
    $passed++

    foreach ($kind in @('mapping', 'listener', 'administrator', 'disabled')) {
        New-Case
        if ($kind -ceq 'mapping') { $fakeState.Mappings = @(@{ Kind = 'v4tov4'; Listen = '0.0.0.0/43157'; Connect = '192.168.168.2/43157' }) }
        if ($kind -ceq 'listener') { $fakeState.Listeners = @(@{ Address = '127.0.0.1'; Process = 1234 }) }
        if ($kind -ceq 'administrator') { $admin = $false }
        if ($kind -ceq 'disabled') { $fakeState.StartMode = 'Disabled'; $fakeState.Status = 'Stopped' }
        $hash = Hash-File $guestManifestPath; Expect-Failure { Invoke-RepairGuest }
        Assert-Test ($adds -eq 0 -and $removes -eq 0 -and $hash -ceq (Hash-File $guestManifestPath)) 'A conflict changed forwarding or configuration.'
        $passed++
    }

    New-Case
    $injectMappingAtRead = 3
    Expect-Failure { Invoke-RepairGuest }
    Assert-Test ($adds -eq 0 -and $removes -eq 0 -and @($fakeState.Mappings).Count -eq 1) 'An explicitly observed concurrent mapping was adopted/deleted.'
    $passed++

    New-Case
    $fakeState.Mappings = @(@{ Kind = 'v4tov4'; Listen = '127.0.0.1/17890'; Connect = '192.168.168.1/17890' })
    $result = Invoke-RepairGuest; $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test (@($fakeState.Mappings).Count -eq 1 -and $fakeState.Mappings[0].Listen -ceq '127.0.0.1/17890' -and $starts -eq 0 -and $stops -eq 0) 'An unrelated portproxy or running service was changed.'
    $passed++

    New-Case
    $fakeState.Status = 'Stopped'; $fakeState.StartMode = 'Manual'
    $result = Invoke-RepairGuest; $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test ($starts -eq 1 -and $stops -eq 1 -and $fakeState.Status -ceq 'Stopped' -and $fakeState.StartMode -ceq 'Manual') 'Original IP Helper state was not restored.'
    $passed++

    foreach ($notReady in @('network', 'With', 'CodeBuddy')) {
        New-Case
        if ($notReady -ceq 'network') { $networkFails = $true }
        elseif ($notReady -ceq 'With') { $health.provider.ready = $false }
        else { $health.providers.CodeBuddy.authenticated = $false }
        $hash = Hash-File $guestManifestPath; Expect-Failure { Invoke-RepairGuest }
        Assert-Test ($hash -ceq (Hash-File $guestManifestPath) -and @($fakeState.Mappings).Count -eq 0 -and $journal.Phase -ceq 'rolled-back') 'Metadata failure left forwarding or file changes.'
        $passed++
    }

    New-Case
    foreach ($path in @(Get-ProfilePaths)) { $p = Read-Json $path; $p.inferenceModels = @('claude-codebuddy-opus-5-5'); Write-Fixture $path $p }
    $m = Read-Json $guestManifestPath; foreach ($entry in $m.Files) { $entry.Fields[1].Installed.Value = @('claude-codebuddy-opus-5-5') }; Write-Fixture $guestManifestPath $m
    $health.provider.authenticated = $false; $health.provider.ready = $false; $catalogIds = @('claude-codebuddy-opus-5-5')
    $result = Invoke-RepairGuest
    Assert-Test ($result.Phase -ceq 'installed' -and ($metadataCalls -join ',') -ceq '/health,/v1/models') 'CodeBuddy-only repair required disabled With readiness.'
    foreach ($path in @(Get-ProfilePaths)) { $p = Read-Json $path; Assert-Test (@($p.inferenceModels).Count -eq 1 -and $p.inferenceModels[0] -ceq 'claude-codebuddy-opus-5-5' -and $p.theme -ceq 'dark') 'CodeBuddy-only repair changed models or preferences.' }
    $health.providers.CodeBuddy.ready = $false; Expect-Failure { Invoke-RepairGuest }
    Assert-Test ($removes -eq 0 -and @($fakeState.Mappings).Count -eq 1) 'A failed recheck removed an already committed forwarding rule.'
    $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test ($result.Phase -ceq 'restored' -and (Read-Json $guestManifestPath).Files[0].Fields[1].Installed.Value[0] -ceq 'claude-codebuddy-opus-5-5') 'Repair Restore changed the later CodeBuddy-only model selection.'
    $passed++

    New-Case
    $hashes = @((Get-ProfilePaths) | ForEach-Object { Hash-File $_ }); $hash = Hash-File $guestManifestPath
    $failWritePath = @(Get-ProfilePaths)[1]
    Expect-Failure { Invoke-RepairGuest }
    Assert-Test ($hash -ceq (Hash-File $guestManifestPath) -and ($hashes -join ',') -ceq (@((Get-ProfilePaths) | ForEach-Object { Hash-File $_ }) -join ',') -and @($fakeState.Mappings).Count -eq 0) 'A partial profile write was not rolled back exactly.'
    $result = Invoke-RepairGuest
    Assert-Test ($result.Phase -ceq 'installed') 'A rolled-back Apply could not be retried.'
    $passed++

    New-Case
    $editManifestAtSnapshot = $true
    Expect-Failure { Invoke-RepairGuest }
    Assert-Test ((Read-Json $guestManifestPath).External -ceq 'concurrent') 'A concurrent guest manifest edit was overwritten.'
    foreach ($path in @(Get-ProfilePaths)) { Assert-Test ((Read-Json $path).inferenceGatewayBaseUrl -ceq $backendUrl) 'A failed manifest guard left a profile migrated.' }
    $passed++

    # Simulate power loss after every file was written but before phase commit.
    New-Case
    $result = Invoke-RepairGuest
    $journal.Phase = 'applying'; $journal.Pending = $null
    $script:transactionDir = Join-Path $stateRoot 'crash'; Private-Directory $transactionDir
    $changes = @()
    foreach ($profile in $journal.Profiles) { $p = Read-Json $profile.Path; $p.inferenceGatewayBaseUrl = $backendUrl; $changes += New-FileChange $profile.Path $p $changes.Count }
    # Here Before is the installed (loopback) version, After the original (LAN).
    # Swap the records to represent the interrupted initial Apply direction.
    $m = Read-Json $guestManifestPath; foreach ($file in $m.Files) { $file.Fields[0].Installed.Value = $backendUrl }; $changes += New-FileChange $guestManifestPath $m $changes.Count
    foreach ($file in $changes) { $temp=$file.Before; $file.Before=$file.After; $file.After=$temp; $temp=$file.BeforeHash; $file.BeforeHash=$file.AfterHash; $file.AfterHash=$temp }
    $journal.Pending = @{ Operation = 'Apply'; Files = $changes }; Save-Journal
    $result = Invoke-RepairGuest
    Assert-Test ($result.Phase -ceq 'installed' -and -not $journal.Pending -and (Read-Json $guestManifestPath).Files[0].Fields[0].Installed.Value -ceq $loopbackUrl) 'An interrupted Apply did not recover its exact pending transaction.'
    $passed++

    # A complete Configure restore removes its manifest and original URL fields.
    foreach ($path in @(Get-ProfilePaths)) { $p = Read-Json $path; $p.Remove('inferenceGatewayBaseUrl'); Write-Fixture $path $p }
    Remove-Item -LiteralPath $guestManifestPath -Force
    $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test (-not [IO.File]::Exists($guestManifestPath) -and @($fakeState.Mappings).Count -eq 0) 'Helper Restore recreated a completed Configure installation.'
    $passed++

    New-Case -NewInstall
    $result = Invoke-RepairGuest
    Assert-Test ($result.ForwardOnly -and -not $result.MetadataChecked -and $metadataCalls.Count -eq 0 -and $adds -eq 1 -and -not [IO.File]::Exists($guestManifestPath)) 'ForwardOnly created/read configuration or used credentials.'
    $request.Action = 'Restore'; $result = Invoke-RepairGuest
    Assert-Test (@($fakeState.Mappings).Count -eq 0) 'ForwardOnly Restore left its mapping.'
    $passed++

    # Host compare-and-swap retains unrelated fields and refuses stale snapshots.
    $hostManifestPath = Join-Path $testRoot 'host-manifest.json'; $GuestHome = 'C:\Users\Developer'
    Write-Fixture $hostManifestPath (@{ Version=1; Phase='installed'; GuestHome=$GuestHome; ProfileId=$profileId; GatewayBaseUrl=$backendUrl; Firewall=@{ Original='keep'; AllowSnapshot=@{Program='unchanged'} }; Other='keep' })
    $hash = Get-RepairHash $hostManifestPath
    Update-RepairHostManifest @{} $loopbackUrl $hash
    $hostData = Read-RepairJson $hostManifestPath
    Assert-Test ($hostData.GatewayBaseUrl -ceq $loopbackUrl -and $hostData.Other -ceq 'keep' -and $hostData.Firewall.Original -ceq 'keep') 'Host URL commit changed unrelated fields.'
    Expect-Failure { Update-RepairHostManifest @{} $backendUrl $hash }
    Assert-Test ((Read-RepairJson $hostManifestPath).GatewayBaseUrl -ceq $loopbackUrl) 'Stale host hash was accepted.'
    Assert-Test ((Get-RepairValueHash $hostData) -ceq (Get-RepairHash $hostManifestPath)) 'Predicted host commit hash cannot recover the commit/journal window.'
    $passed++

    [pscustomobject]@{ Passed=$passed; HostAstErrors=$parseErrors.Count; GuestAstErrors=$ge.Count; GuestInvoked=$false; NetworkCalled=$false; FirewallChanged=$false; ServiceChanged=$false } | ConvertTo-Json -Compress
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot); $prefix = $projectRoot.TrimEnd('\') + '\.state\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^loopback-test-[0-9a-f]{32}$') { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolved) {
        if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture cleanup encountered a reparse point.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
