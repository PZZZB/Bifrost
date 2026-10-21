[CmdletBinding()]
param()

# Exercises planning/JSON functions and private ACLs using temporary test files.
# It never invokes VMware, network calls, or firewall mutation commands.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $projectRoot 'scripts\Configure-WithVm.ps1'
$tokens = $null; $errors = $null
$hostAst = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Host script does not parse.' }
$literal = $hostAst.Find({ param($node)
    $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'SingleQuotedHereString'
}, $true)
$guestTokens = $null; $guestErrors = $null
$guestAst = [Management.Automation.Language.Parser]::ParseInput($literal.Value, [ref]$guestTokens, [ref]$guestErrors)
if ($guestErrors.Count) { throw 'Guest payload does not parse.' }
$needed = @('To-Map', 'Hash-File', 'Read-Document', 'Write-Json', 'Field', 'Equal-Field', 'Set-Fields', 'Assert-Fields', 'New-FilePlan', 'Assert-GatewayReady', 'Set-RequestedModels')
foreach ($definition in $guestAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($definition.Name -in $needed) { . ([scriptblock]::Create($definition.Extent.Text)) }
}
foreach ($definition in $hostAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in @('Get-PrivateDirectory', 'Test-SameSet', 'Get-PortException', 'Assert-RuleShape', 'Assert-AllowRule', 'Assert-AllowSnapshot', 'Invoke-FirewallApply', 'Invoke-FirewallRestore', 'Assert-DesktopGatewayUrl', 'Get-RequestedVmModels')) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
}
# Function mocks take precedence over the real Windows firewall cmdlets.
$fakeRules = @{}
function Get-Rule([string]$Name) {
    if (-not $fakeRules.Contains($Name)) { return $null }
    return To-Map ($fakeRules[$Name] | ConvertTo-Json -Depth 30 | ConvertFrom-Json)
}
function Set-RulePorts([string]$Name, [string[]]$Ports) { $fakeRules[$Name].LocalPort = @($Ports) }
function Write-PrivateJson($Path, $Value) { }
function New-NetFirewallRule($Name, $DisplayName, $Description, $Group, $Direction, $Action, $Enabled, $Profile, $InterfaceAlias, $Protocol, $LocalAddress, $LocalPort, $RemoteAddress, $Program) {
    $fakeRules[$Name] = [ordered]@{
        Name = $Name; DisplayName = $DisplayName; Description = $Description; Group = $Group; Enabled = $Enabled; Direction = $Direction; Action = $Action
        Profile = $Profile; InterfaceAlias = @($InterfaceAlias); Protocol = $Protocol; LocalPort = @([string]$LocalPort); RemotePort = @('Any')
        LocalAddress = @($LocalAddress); RemoteAddress = @($RemoteAddress); Program = $Program
    }
}
function Remove-NetFirewallRule($Name, $PolicyStore) { $fakeRules.Remove($Name) }
$readinessCalls = New-Object Collections.Generic.List[string]
$readinessFixture = @{ ok = $true; provider = @{ authenticated = $true; ready = $true } }
$catalogFixture = @{ data = @(@{ id = 'claude-opus-5-5' }) }
function Invoke-RestMethod($Uri, $Method, $Headers, $TimeoutSec) {
    if ($Method -cne 'Get' -or $Headers.Authorization -cne 'Bearer test-readiness-key' -or $TimeoutSec -ne 15) {
        throw 'Unexpected metadata request.'
    }
    $readinessCalls.Add($Uri)
    switch ($Uri) {
        'http://192.168.168.1:43157/health' { return $readinessFixture }
        'http://192.168.168.1:43157/v1/models' { return $catalogFixture }
        'http://127.0.0.1:43157/health' { return $readinessFixture }
        'http://127.0.0.1:43157/v1/models' { return $catalogFixture }
        default { throw 'A configuration check attempted an unapproved endpoint.' }
    }
}
$utf8 = New-Object Text.UTF8Encoding($false)
$testRoot = Join-Path $projectRoot ('.state\with-vm-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$configFile = Join-Path $testRoot 'config.json'
$passed = 0
try {
    if (((Get-RequestedVmModels $false $false) -join ',') -cne 'claude-opus-5-5' -or
        ((Get-RequestedVmModels $true $false) -join ',') -cne 'claude-opus-5-5,claude-codebuddy-opus-5-5' -or
        ((Get-RequestedVmModels $false $true) -join ',') -cne 'claude-codebuddy-opus-5-5') { throw 'Requested model mode does not match the selected switches.' }
    $rejected = $false
    try { Get-RequestedVmModels $true $true | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Conflicting CodeBuddy switches were accepted.' }
    $passed++
    if ('InferenceModels' -cnotin @($hostAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })) {
        throw 'Explicit inference model selection is not exposed by the host adapter.'
    }
    $explicitSelection = @('claude/claude-opus-5-5', 'claude/claude-sonnet-5', 'claude-codebuddy-opus-5-5')
    $selected = Get-RequestedVmModels $false $false -InferenceModels $explicitSelection
    if (($selected -join ',') -cne ($explicitSelection -join ',')) { throw 'Explicit model order or namespace was not preserved.' }
    foreach ($switches in @(@($true, $false), @($false, $true), @($true, $true))) {
        $rejected = $false
        try { Get-RequestedVmModels $switches[0] $switches[1] -InferenceModels $explicitSelection | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Explicit model selection accepted conflicting legacy switches.' }
    }
    $passed++
    foreach ($invalidModels in @(@(), @(''), @('claude model'), @("claude`nmodel"), @('claude/model?key=x'),
        @('claude/model', 'claude/model'), @('/claude/model'))) {
        $rejected = $false
        try { Get-RequestedVmModels $false $false -InferenceModels $invalidModels | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'Invalid explicit inference models were accepted by the host.' }
    }
    $selected = Get-RequestedVmModels $false $false -InferenceModels @('claude/opus', 'Claude/opus')
    if ($selected.Count -ne 2) { throw 'Exact model identifiers were compared without case sensitivity.' }
    $passed++
    $modelGuard = $guestAst.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("throw 'Unexpected VM model set.'") }, $true)
    if (-not $modelGuard) { throw 'Guest model validation was not located.' }
    $guardBlock = [scriptblock]::Create($modelGuard.Extent.Text)
    $explicitModels = $false
    foreach ($validModels in @(@('claude-opus-5-5'), @('claude-opus-5-5', 'claude-codebuddy-opus-5-5'), @('claude-codebuddy-opus-5-5'))) { $models = $validModels; & $guardBlock }
    foreach ($invalidModels in @(@(), @('other-model'), @('claude-codebuddy-opus-5-5', 'claude-codebuddy-opus-5-5'))) {
        $models = $invalidModels; $rejected = $false
        try { & $guardBlock } catch { $rejected = $true }
        if (-not $rejected) { throw 'Guest accepted an invalid model set.' }
    }
    $passed++
    $explicitModels = $true
    foreach ($validModels in @($explicitSelection, @('claude/opus'), @('claude/opus', 'Claude/opus'))) {
        $models = $validModels; & $guardBlock
    }
    foreach ($invalidModels in @(@(), @(''), @('claude model'), @('claude/model', 'claude/model'), @([int]5))) {
        $models = $invalidModels; $rejected = $false
        try { & $guardBlock } catch { $rejected = $true }
        if (-not $rejected) { throw 'Guest accepted an invalid explicit model set.' }
    }
    $selectionGuard = $guestAst.Find({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("throw 'Unexpected model selection mode.'") }, $true)
    if (-not $selectionGuard) { throw 'Guest explicit-model authorization validation was not located.' }
    $request = [ordered]@{ ExplicitModels = 'true' }; $rejected = $false
    try { & ([scriptblock]::Create($selectionGuard.Extent.Text)) } catch { $rejected = $true }
    if (-not $rejected) { throw 'Guest accepted a non-boolean explicit-model authorization marker.' }
    $explicitModels = $false
    $passed++
    Assert-DesktopGatewayUrl 'http://127.0.0.1:43157' 'Apply'
    Assert-DesktopGatewayUrl 'http://192.168.168.1:43157' 'Plan'
    Assert-DesktopGatewayUrl 'http://192.168.168.1:43157' 'Restore'
    foreach ($invalid in @('http://192.168.168.1:43157', 'http://localhost:43157', 'http://127.0.0.1:17890', 'http://127.0.0.1:43157/path', 'http://user:password@127.0.0.1:43157', 'http://127.0.0.1:43157?key=x')) {
        $rejected = $false
        try { Assert-DesktopGatewayUrl $invalid 'Apply' } catch { $rejected = $true }
        if (-not $rejected) { throw 'A non-dedicated or legacy LAN endpoint was accepted for new Desktop configuration.' }
    }
    $passed++
    $ownerBefore = (Get-Acl -LiteralPath $testRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value
    Get-PrivateDirectory $testRoot
    $acl = Get-Acl -LiteralPath $testRoot
    $expectedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object -Unique
    $actualSids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) | Sort-Object -Unique
    if (-not $acl.AreAccessRulesProtected -or -not (Test-SameSet $actualSids $expectedSids)) { throw 'Private staging ACL includes an unexpected principal.' }
    $passed++
    Get-PrivateDirectory $testRoot
    $again = Get-Acl -LiteralPath $testRoot
    if ($again.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $ownerBefore -or @($again.Access).Count -ne @($acl.Access).Count) {
        throw 'Private staging setup changed ownership or duplicated access rules.'
    }
    $passed++
    $ranges = Get-PortException @('1-17889', '17894-65535') 43157
    if (($ranges -join ',') -cne '1-17889,17894-43156,43158-65535') { throw 'Port exception calculation failed.' }
    $passed++

    Write-Json $configFile ([ordered]@{ deploymentMode = 'original'; mcpServers = [ordered]@{ existing = [ordered]@{ command = 'keep' } } })
    $values = [ordered]@{ deploymentMode = '3p'; inferenceModels = @('claude-opus-5-5'); alwaysStartWithDefaultModel = $true; inferenceGatewayApiKey = 'test-placeholder' }
    $plan = New-FilePlan $configFile $values
    $current = Read-Document $configFile
    Assert-Fields $current.Data $plan.Fields 'prepared'
    Set-Fields $current.Data $plan.Fields 'Installed'
    Write-Json $configFile $current.Data $current.Hash -CheckHash
    $current = Read-Document $configFile
    if ($current.Data.mcpServers.existing.command -cne 'keep' -or @($current.Data.inferenceModels).Count -ne 1 -or $current.Data.inferenceModels[0] -cne 'claude-opus-5-5') {
        throw 'JSON merge or single-model array preservation failed.'
    }
    $passed++

    $current.Data['laterUserSetting'] = 'preserved'
    Write-Json $configFile $current.Data $current.Hash -CheckHash
    $current = Read-Document $configFile
    Assert-Fields $current.Data $plan.Fields 'prepared'
    Set-Fields $current.Data $plan.Fields 'Original'
    Write-Json $configFile $current.Data $current.Hash -CheckHash
    $current = Read-Document $configFile
    if ($current.Data.deploymentMode -cne 'original' -or $current.Data.laterUserSetting -cne 'preserved' -or $current.Data.Contains('inferenceGatewayApiKey')) {
        throw 'Restore failed to preserve unrelated settings or remove newly added keys.'
    }
    $passed++

    Set-Fields $current.Data $plan.Fields 'Installed'
    Write-Json $configFile $current.Data $current.Hash -CheckHash
    $current = Read-Document $configFile
    $current.Data.inferenceGatewayApiKey = 'user-edited-placeholder'
    $rejected = $false
    try { Assert-Fields $current.Data $plan.Fields 'prepared' } catch { $rejected = $true }
    if (-not $rejected) { throw 'A concurrent managed-field edit was not rejected.' }
    $passed++

    $current = Read-Document $configFile
    [IO.File]::WriteAllText($configFile, '{"external":true}', $utf8)
    $rejected = $false
    try { Write-Json $configFile $current.Data $current.Hash -CheckHash } catch { $rejected = $true }
    if (-not $rejected -or (Read-Document $configFile).Data.external -ne $true) { throw 'The expected-hash guard did not protect a concurrent file edit.' }
    $passed++

    $newConfig = Join-Path $testRoot 'new-profile.json'
    $newPlan = New-FilePlan $newConfig $values
    $newCurrent = Read-Document $newConfig
    Assert-Fields $newCurrent.Data $newPlan.Fields 'prepared'
    Set-Fields $newCurrent.Data $newPlan.Fields 'Installed'
    Write-Json $newConfig $newCurrent.Data $newCurrent.Hash -CheckHash
    if ((Read-Document $newConfig).Data.inferenceModels[0] -cne 'claude-opus-5-5') {
        throw 'Installing a previously absent profile failed.'
    }
    $passed++
    $absentConfig = Join-Path $testRoot 'concurrent-profile.json'
    $absentCurrent = Read-Document $absentConfig
    [IO.File]::WriteAllText($absentConfig, '{"external":true}', $utf8)
    $rejected = $false
    try { Write-Json $absentConfig $absentCurrent.Data $absentCurrent.Hash -CheckHash } catch { $rejected = $true }
    if (-not $rejected -or (Read-Document $absentConfig).Data.external -ne $true) {
        throw 'A profile created after the absent-file read was overwritten.'
    }
    $passed++

    Assert-GatewayReady 'http://192.168.168.1:43157' 'test-readiness-key'
    if (($readinessCalls -join ',') -cne 'http://192.168.168.1:43157/health,http://192.168.168.1:43157/v1/models') {
        throw 'Ready gateway checks did not read health before the model catalog.'
    }
    $passed++
    foreach ($unready in @(
        @{ ok = $false; provider = @{ authenticated = $true; ready = $true } },
        @{ ok = $true; provider = @{ authenticated = $false; ready = $true } },
        @{ ok = $true; provider = @{ authenticated = $true; ready = $false } },
        @{ ok = $true; provider = @{ authenticated = $true; ready = 'true' } }
    )) {
        $readinessFixture = $unready
        $readinessCalls.Clear()
        $rejected = $false
        try { Assert-GatewayReady 'http://192.168.168.1:43157' 'test-readiness-key' } catch { $rejected = $true }
        if (-not $rejected -or $readinessCalls.Count -ne 1 -or $readinessCalls[0] -cne 'http://192.168.168.1:43157/health') {
            throw 'An unready gateway did not stop configuration before the catalog request.'
        }
    }
    $passed++
    $readinessFixture = @{ ok = $true; provider = @{ authenticated = $true; ready = $true } }
    $catalogFixture = @{ data = @(@{ id = 'claude-opus-5-5' }, @{ id = 'another-model' }) }
    $rejected = $false
    try { Assert-GatewayReady 'http://192.168.168.1:43157' 'test-readiness-key' } catch { $rejected = $true }
    if (-not $rejected) { throw 'A gateway exposing additional models passed configuration preflight.' }
    $passed++

    $readinessFixture = @{ ok = $true; provider = @{ authenticated = $true; ready = $true }; providers = @{ CodeBuddy = @{ authenticated = $true; ready = $true } } }
    $catalogFixture = @{ data = @(@{ id = 'claude-opus-5-5' }, @{ id = 'claude-codebuddy-opus-5-5' }) }
    Assert-GatewayReady 'http://192.168.168.1:43157' 'test-readiness-key' @('claude-opus-5-5', 'claude-codebuddy-opus-5-5')
    $passed++
    $readinessFixture.providers.CodeBuddy.ready = $false
    $rejected = $false
    try { Assert-GatewayReady 'http://192.168.168.1:43157' 'test-readiness-key' @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unauthenticated CodeBuddy passed the VM model upgrade guard.' }
    $passed++

    $readinessFixture = @{ ok = $true; provider = @{ authenticated = $false; ready = $false }; providers = @{ CodeBuddy = @{ authenticated = $true; ready = $true } } }
    $catalogFixture = @{ data = @(@{ id = 'claude-codebuddy-opus-5-5' }) }
    Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' @('claude-codebuddy-opus-5-5')
    $passed++
    $readinessFixture.providers.CodeBuddy.ready = $false
    $rejected = $false
    try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' @('claude-codebuddy-opus-5-5') } catch { $rejected = $true }
    if (-not $rejected) { throw 'CodeBuddy-only selection accepted an unready CodeBuddy provider.' }
    $passed++

    $readinessFixture = @{ ok = $true; provider = @{ authenticated = $null; ready = $true }; providers = @{
        Claude = @{ authenticated = $null; ready = $true; modelAvailable = $true }
        CodeBuddy = @{ authenticated = $true; ready = $true; modelAvailable = $true }
    } }
    $catalogFixture = @{ data = @(@{ id = 'claude/claude-opus-5-5' }, @{ id = 'claude/claude-sonnet-5' },
        @{ id = 'claude-codebuddy-opus-5-5' }, @{ id = 'claude/another-model' }) }
    Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true
    if ($null -ne $readinessFixture.providers.Claude.authenticated) { throw 'Claude metadata discovery was promoted to an account authentication claim.' }
    $passed++
    $readinessFixture.providers.Claude = @{ authenticated = $null; connected = $true }
    Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true
    $passed++
    $catalogFixture = @{ data = @(@{ id = 'claude-opus-5-5' }, @{ id = 'claude-codebuddy-opus-5-5' }) }
    Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') $true
    $rejected = $false
    try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' @('claude-opus-5-5') } catch { $rejected = $true }
    if (-not $rejected) { throw 'A non-explicit With selection bypassed the legacy authentication requirement.' }
    $passed++
    $readinessFixture.providers.With = @{ authenticated = $false; ready = $true }
    $rejected = $false
    try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' @('claude-opus-5-5') $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'A registered With channel bypassed its authentication requirement in explicit mode.' }
    $readinessFixture.providers.Remove('With')
    $catalogFixture = @{ data = @(@{ id = 'claude/claude-opus-5-5' }, @{ id = 'claude/claude-sonnet-5' },
        @{ id = 'claude-codebuddy-opus-5-5' }, @{ id = 'claude/another-model' }) }
    $passed++
    foreach ($unreadyClaude in @(@{}, @{ authenticated = $true; ready = $false; connected = $false },
        @{ authenticated = $null; ready = 'true'; connected = 'true' })) {
        $readinessFixture.providers.Claude = $unreadyClaude; $readinessCalls.Clear(); $rejected = $false
        try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true } catch { $rejected = $true }
        if (-not $rejected -or $readinessCalls.Count -ne 1) { throw 'An unready Claude route passed explicit-model metadata preflight.' }
    }
    $passed++
    $readinessFixture.providers.Claude = @{ authenticated = $null; ready = $true }
    foreach ($invalidAuthentication in @($false, 'true', [int]1)) {
        foreach ($connectionState in @(@{ ready = $true }, @{ connected = $true })) {
            $readinessFixture.providers.Claude = $connectionState
            $readinessFixture.providers.Claude.authenticated = $invalidAuthentication
            $readinessCalls.Clear(); $rejected = $false
            try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true } catch { $rejected = $true }
            if (-not $rejected -or $readinessCalls.Count -ne 1) { throw 'False or malformed Claude authentication passed model metadata preflight.' }
        }
    }
    $readinessFixture.providers.Claude = @{ authenticated = $null; ready = $true }
    $passed++
    foreach ($invalidAuthentication in @($false, $null, 'true')) {
        $readinessFixture.providers.CodeBuddy.authenticated = $invalidAuthentication
        $readinessCalls.Clear(); $rejected = $false
        try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true } catch { $rejected = $true }
        if (-not $rejected -or $readinessCalls.Count -ne 1) { throw 'Explicit model selection bypassed CodeBuddy authentication.' }
    }
    $readinessFixture.providers.CodeBuddy.authenticated = $true
    $passed++
    foreach ($invalidCatalog in @(
        @{ data = @(@{ id = 'claude/Claude-opus-5-5' }, @{ id = 'claude/claude-sonnet-5' }, @{ id = 'claude-codebuddy-opus-5-5' }) },
        @{ data = @(@{ id = 'claude/claude-opus-5-5' }, @{ id = 'claude/claude-opus-5-5' }, @{ id = 'claude/claude-sonnet-5' }, @{ id = 'claude-codebuddy-opus-5-5' }) },
        @{ data = @(@{ id = 'claude/claude-sonnet-5' }, @{ id = 'claude-codebuddy-opus-5-5' }) },
        @{ data = @(@{ id = [int]5 }) },
        @{ data = $null }
    )) {
        $catalogFixture = $invalidCatalog; $rejected = $false
        try { Assert-GatewayReady 'http://127.0.0.1:43157' 'test-readiness-key' $explicitSelection $true } catch { $rejected = $true }
        if (-not $rejected) { throw 'A malformed or incomplete catalog passed exact model validation.' }
    }
    $passed++

    $upgradeProfile = Join-Path $testRoot 'upgrade-profile.json'
    Write-Json $upgradeProfile ([ordered]@{ inferenceModels = @('original-model'); unrelated = 'preserved' })
    $upgradePlan = New-FilePlan $upgradeProfile ([ordered]@{ inferenceModels = @('claude-opus-5-5') })
    $upgradeCurrent = Read-Document $upgradeProfile
    Set-Fields $upgradeCurrent.Data $upgradePlan.Fields 'Installed'
    Write-Json $upgradeProfile $upgradeCurrent.Data $upgradeCurrent.Hash -CheckHash
    $upgradeManifest = [ordered]@{ Phase = 'installed'; Files = @($upgradePlan) }
    if (-not (Set-RequestedModels $upgradeManifest @('claude-opus-5-5', 'claude-codebuddy-opus-5-5'))) { throw 'Existing model set was not upgraded.' }
    $upgradeCurrent = Read-Document $upgradeProfile
    Assert-Fields $upgradeCurrent.Data $upgradePlan.Fields 'upgrading'
    if ($upgradePlan.Fields[0].Original.Value[0] -cne 'original-model') { throw 'Upgrade changed the restore target.' }
    Set-Fields $upgradeCurrent.Data $upgradePlan.Fields 'Installed'
    Write-Json $upgradeProfile $upgradeCurrent.Data $upgradeCurrent.Hash -CheckHash
    $upgradeManifest.Phase = 'installed'
    if (-not (Set-RequestedModels $upgradeManifest @('claude-codebuddy-opus-5-5'))) { throw 'Both-model installation did not narrow to CodeBuddy only.' }
    $upgradeCurrent = Read-Document $upgradeProfile
    Assert-Fields $upgradeCurrent.Data $upgradePlan.Fields 'upgrading'
    Set-Fields $upgradeCurrent.Data $upgradePlan.Fields 'Installed'
    Write-Json $upgradeProfile $upgradeCurrent.Data $upgradeCurrent.Hash -CheckHash
    $upgradeCurrent = Read-Document $upgradeProfile
    if (@($upgradeCurrent.Data.inferenceModels).Count -ne 1 -or $upgradeCurrent.Data.inferenceModels[0] -cne 'claude-codebuddy-opus-5-5' -or
        $upgradePlan.Fields[0].Original.Value[0] -cne 'original-model' -or $upgradeCurrent.Data.unrelated -cne 'preserved') { throw 'CodeBuddy-only migration changed Original or unrelated settings.' }
    $passed++
    $upgradeCurrent = Read-Document $upgradeProfile
    Assert-Fields $upgradeCurrent.Data $upgradePlan.Fields 'prepared'
    Set-Fields $upgradeCurrent.Data $upgradePlan.Fields 'Original'
    if ($upgradeCurrent.Data.inferenceModels[0] -cne 'original-model' -or $upgradeCurrent.Data.unrelated -cne 'preserved') {
        throw 'Upgrade restore did not preserve original and unrelated fields.'
    }
    $passed++

    $explicitProfile = Join-Path $testRoot 'explicit-profile.json'
    Write-Json $explicitProfile ([ordered]@{ deploymentMode = '1p'; inferenceModels = @('original-model');
        claudeAiImport = [ordered]@{ enabled = $false }; unrelated = 'preserved' })
    $explicitPlan = New-FilePlan $explicitProfile ([ordered]@{ inferenceModels = @('claude-codebuddy-opus-5-5');
        inferenceGatewayApiKey = 'test-placeholder'; claudeAiImport = [ordered]@{ enabled = $true }; deploymentMode = '1p' })
    $explicitCurrent = Read-Document $explicitProfile
    Set-Fields $explicitCurrent.Data $explicitPlan.Fields 'Installed'
    Write-Json $explicitProfile $explicitCurrent.Data $explicitCurrent.Hash -CheckHash
    $explicitManifest = [ordered]@{ Phase = 'installed'; Files = @($explicitPlan) }
    $replacementSelection = @('claude/claude-opus-5-5', 'claude/claude-sonnet-5')
    $originalFields = @($explicitPlan.Fields | ForEach-Object { $_.Original }) | ConvertTo-Json -Depth 20 -Compress
    $rejected = $false
    try { Set-RequestedModels $explicitManifest $replacementSelection | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'An implicit upgrade removed an installed model outside the existing CodeBuddy-only mode.' }
    if (-not (Set-RequestedModels $explicitManifest $replacementSelection $true)) { throw 'Explicit replacement did not update the installed model list.' }
    if ((@($explicitPlan.Fields | ForEach-Object { $_.Original }) | ConvertTo-Json -Depth 20 -Compress) -cne $originalFields -or
        $explicitPlan.Fields[0].PreviousInstalled.Value[0] -cne 'claude-codebuddy-opus-5-5') { throw 'Explicit replacement changed original recovery values or lost the previous installation.' }
    if (Set-RequestedModels $explicitManifest $replacementSelection $true) { throw 'Resuming the same explicit upgrade changed the pending recovery record.' }
    $rejected = $false
    try { Set-RequestedModels $explicitManifest @('claude/another-model') $true | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'A different explicit selection replaced a pending upgrade.' }
    $passed++
    $explicitCurrent = Read-Document $explicitProfile
    Assert-Fields $explicitCurrent.Data $explicitPlan.Fields 'upgrading'
    Set-Fields $explicitCurrent.Data $explicitPlan.Fields 'Installed'
    Write-Json $explicitProfile $explicitCurrent.Data $explicitCurrent.Hash -CheckHash
    if ((Read-Document $explicitProfile).Data.deploymentMode -cne '1p') { throw 'An explicit model upgrade changed the installed account mode.' }
    $passed++
    foreach ($field in $explicitPlan.Fields) { $field.Remove('PreviousInstalled') }
    $explicitManifest.Phase = 'installed'
    foreach ($field in $explicitPlan.Fields) {
        $edited = Read-Document $explicitProfile
        $edited.Data[$field.Key] = 'user-edited-placeholder'; $rejected = $false
        try { Assert-Fields $edited.Data $explicitPlan.Fields 'installed' } catch { $rejected = $true }
        if (-not $rejected) { throw 'Explicit model replacement disabled a managed-field conflict check.' }
    }
    $explicitCurrent = Read-Document $explicitProfile
    Assert-Fields $explicitCurrent.Data $explicitPlan.Fields 'prepared'
    Set-Fields $explicitCurrent.Data $explicitPlan.Fields 'Original'
    if ($explicitCurrent.Data.deploymentMode -cne '1p' -or $explicitCurrent.Data.inferenceModels[0] -cne 'original-model' -or $explicitCurrent.Data.claudeAiImport.enabled -ne $false -or
        $explicitCurrent.Data.Contains('inferenceGatewayApiKey') -or $explicitCurrent.Data.unrelated -cne 'preserved') {
        throw 'Explicit model replacement did not restore the initial fields and retain unrelated data.'
    }
    $passed++

    $hostAddress = '192.168.168.1'; $guestAddress = '192.168.168.10'; $interfaceAlias = 'VMware Network Adapter VMnet1'; $port = 43157
    $blockName = 'test-block'; $sourceName = 'test-sources'; $allowName = 'test-allow'
    $common = [ordered]@{
        Group = 'original-group'; Enabled = 'True'; Direction = 'Inbound'; Action = 'Block'; Profile = 'Any';
        InterfaceAlias = @($interfaceAlias); Protocol = 'TCP'; RemotePort = @('Any'); LocalAddress = @('Any'); RemoteAddress = @('non-guest'); Program = 'Any'
    }
    $block = To-Map ($common | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    $block.Name = $blockName; $block.LocalPort = @('1-17889', '17894-65535')
    $sources = To-Map ($common | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    $sources.Name = $sourceName; $sources.LocalPort = @('17890', '17891', '17892', '17893')
    $fakeRules[$blockName] = To-Map ($block | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    $fakeRules[$sourceName] = To-Map ($sources | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
    $manifest = [ordered]@{ GatewayProgram = 'C:\example\gateway.exe'; Firewall = [ordered]@{
        Block = $block; Sources = $sources
        InstalledBlockedPorts = @('1-17889', '17894-43156', '43158-65535')
        InstalledSourcePorts = @('17890', '17891', '17892', '17893', '43157')
        AllowSnapshot = $null
    } }
    Invoke-FirewallApply $manifest
    if (-not (Test-SameSet $fakeRules[$blockName].LocalPort $manifest.Firewall.InstalledBlockedPorts) -or
        -not (Test-SameSet $fakeRules[$sourceName].LocalPort $manifest.Firewall.InstalledSourcePorts) -or
        $fakeRules[$allowName].Program -cne 'C:\example\gateway.exe') { throw 'Mocked firewall installation did not produce the precise exception.' }
    $passed++
    $fakeRules[$allowName].Enabled = 'False'
    $rejected = $false
    try { Invoke-FirewallRestore $manifest } catch { $rejected = $true }
    if (-not $rejected -or -not (Test-SameSet $fakeRules[$blockName].LocalPort $manifest.Firewall.InstalledBlockedPorts)) {
        throw 'Firewall restore did not refuse a concurrent rule edit before mutation.'
    }
    $passed++
    $fakeRules[$allowName].Enabled = 'True'
    $fakeRules[$allowName].Description = 'user-edited-description'
    $rejected = $false
    try { Invoke-FirewallRestore $manifest } catch { $rejected = $true }
    if (-not $rejected) { throw 'The created rule ownership snapshot ignored a later metadata edit.' }
    $passed++
    $fakeRules[$allowName].Description = $manifest.Firewall.AllowSnapshot.Description
    Invoke-FirewallRestore $manifest
    if (-not (Test-SameSet $fakeRules[$blockName].LocalPort $block.LocalPort) -or
        -not (Test-SameSet $fakeRules[$sourceName].LocalPort $sources.LocalPort) -or $fakeRules.Contains($allowName)) {
        throw 'Mocked firewall restore did not return to the original port policy.'
    }
    $passed++

    [pscustomobject]@{ Passed = $passed; HostAstErrors = $errors.Count; GuestAstErrors = $guestErrors.Count; GuestInvoked = $false; FirewallChanged = $false } | ConvertTo-Json -Compress
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $allowedPrefix = $projectRoot.TrimEnd('\') + '\.state\'
    if (-not $resolved.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^with-vm-test-[0-9a-f]{32}$') {
        throw 'Unsafe test cleanup path.'
    }
    # Only these known test files are removed. No recursive deletion or VM operations.
    Get-ChildItem -LiteralPath $resolved -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    Remove-Item -LiteralPath $resolved -Force
}
