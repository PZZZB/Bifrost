[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Plan', 'Apply', 'Restore')][string]$Action = 'Plan',
    [string]$GatewayBaseUrl = 'http://127.0.0.1:43157',
    [string]$GatewayKeyFile,
    [string]$GatewayProgram,
    [string]$VmInvoker = 'C:\Users\jiahaoguo\Documents\Codex\2026-09-30\vps-https-www-voyracloud-com-zh\work\vm-build\Invoke-WorkspaceVm.ps1',
    [string]$StateDir = (Join-Path $PSScriptRoot '..\.state\with-vm'),
    [string]$GuestHome = 'C:\Users\Developer',
    [string]$PackageFamily = 'Claude_pzs8sxrjxfjjc',
    [switch]$SkipFirewall,
    [switch]$IncludeCodeBuddy,
    [switch]$CodeBuddyOnly,
    [object[]]$InferenceModels,
    [string]$ModelsJsonFile,
    [switch]$ModelsOnly
)

# Plan is read-only. Apply/Restore are explicit and use the existing VM credential wrapper.
# Never pass a gateway key on a command line. The private request file is deleted by the guest.
$ErrorActionPreference = 'Stop'
$hostAddress = '192.168.168.1'
$guestAddress = '192.168.168.10'
$interfaceAlias = 'VMware Network Adapter VMnet1'
$port = 43157
$ruleGroup = 'Codex VM Host Proxy 20261009'
$blockName = 'Codex-VM-HostProxy-BlockOtherTcp'
$sourceName = 'Codex-VM-HostProxy-BlockOtherSources'
$allowName = 'Codex-WithVm-AllowGuest'
$profileId = '8c2be9ad-3973-477e-9550-f3eb09a79fab'
$StateDir = [IO.Path]::GetFullPath($StateDir)
$manifestPath = Join-Path $StateDir 'host-manifest.json'
$utf8 = New-Object Text.UTF8Encoding($false)

function Get-PrivateDirectory([string]$Directory) {
    $directoryInfo = [IO.Directory]::CreateDirectory($Directory)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowedOwners = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')
    $existingOwner = (Get-Acl -LiteralPath $Directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($existingOwner -cnotin $allowedOwners) { throw 'Private directory has an unexpected owner.' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in $allowedOwners) {
        $sid = New-Object Security.Principal.SecurityIdentifier($id)
        $access = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($access)
    }
    # Persist only the DACL. Resetting an already correct owner unnecessarily
    # requests ownership privileges in a non-elevated ModelsOnly upgrade.
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $acl) }
    else { $directoryInfo.SetAccessControl($acl) }
}

function Write-PrivateJson([string]$Path, $Value) {
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100), $utf8)
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Test-SameSet($Left, $Right) {
    return ((@($Left | ForEach-Object { [string]$_ } | Sort-Object) -join "`n") -ceq
        (@($Right | ForEach-Object { [string]$_ } | Sort-Object) -join "`n"))
}

function Get-Rule([string]$Name) {
    $rule = Get-NetFirewallRule -Name $Name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
    if (-not $rule) { return $null }
    $ports = $rule | Get-NetFirewallPortFilter
    $addresses = $rule | Get-NetFirewallAddressFilter
    $interfaces = $rule | Get-NetFirewallInterfaceFilter
    $interfaceTypes = $rule | Get-NetFirewallInterfaceTypeFilter
    $application = $rule | Get-NetFirewallApplicationFilter
    $service = $rule | Get-NetFirewallServiceFilter
    $security = $rule | Get-NetFirewallSecurityFilter
    return [ordered]@{
        Name = $rule.Name; DisplayName = $rule.DisplayName; Description = $rule.Description; Group = $rule.Group
        Enabled = [string]$rule.Enabled; Direction = [string]$rule.Direction; Action = [string]$rule.Action
        Profile = [string]$rule.Profile; InterfaceAlias = @($interfaces.InterfaceAlias)
        Protocol = [string]$ports.Protocol; LocalPort = @($ports.LocalPort); RemotePort = @($ports.RemotePort)
        LocalAddress = @($addresses.LocalAddress); RemoteAddress = @($addresses.RemoteAddress)
        Program = [string]$application.Program; Package = [string]$application.Package; Service = [string]$service.Service
        InterfaceType = [string]$interfaceTypes.InterfaceType; EdgeTraversalPolicy = [string]$rule.EdgeTraversalPolicy
        Authentication = [string]$security.Authentication; Encryption = [string]$security.Encryption
        OverrideBlockRules = [string]$security.OverrideBlockRules; LocalUser = [string]$security.LocalUser
        RemoteUser = [string]$security.RemoteUser; RemoteMachine = [string]$security.RemoteMachine
    }
}

function Assert-RuleShape($Current, $Original) {
    if (-not $Current) { throw 'A protected VM firewall rule disappeared.' }
    foreach ($key in @('Name', 'Group', 'Enabled', 'Direction', 'Action', 'Profile', 'InterfaceAlias', 'Protocol', 'RemotePort', 'LocalAddress', 'RemoteAddress', 'Program')) {
        if (-not (Test-SameSet $Current[$key] $Original.$key)) { throw "Protected firewall rule changed: $($Original.Name) ($key)." }
    }
}

function Get-PortException([string[]]$Ranges, [int]$PortNumber) {
    $found = $false
    $result = @()
    foreach ($range in $Ranges) {
        if ($range -notmatch '^(\d+)(?:-(\d+))?$') { throw 'Unsupported protected firewall port syntax.' }
        $first = [int]$Matches[1]
        $last = if ($Matches[2]) { [int]$Matches[2] } else { $first }
        if ($PortNumber -lt $first -or $PortNumber -gt $last) { $result += $range; continue }
        $found = $true
        if ($first -lt $PortNumber) { $result += if ($first -eq ($PortNumber - 1)) { "$first" } else { "$first-$($PortNumber - 1)" } }
        if ($last -gt $PortNumber) { $result += if ($last -eq ($PortNumber + 1)) { "$last" } else { "$($PortNumber + 1)-$last" } }
    }
    if (-not $found) { throw 'The requested gateway port is already excluded without this installation manifest.' }
    return ,$result
}

function Assert-BaseFirewall($Block, $Sources) {
    foreach ($rule in @($Block, $Sources)) {
        if (-not $rule -or $rule.Group -cne $ruleGroup -or $rule.Enabled -cne 'True' -or $rule.Action -cne 'Block' -or $rule.Direction -cne 'Inbound' -or $rule.Protocol -cne 'TCP' -or
            -not (Test-SameSet $rule.InterfaceAlias @($interfaceAlias))) { throw 'The existing VM isolation firewall does not match the owned policy.' }
    }
    if (-not (Test-SameSet $Block.LocalPort @('1-17889', '17894-65535')) -or
        -not (Test-SameSet $Sources.LocalPort @('17890', '17891', '17892', '17893'))) {
        throw 'The existing VM port ranges changed. Review them before preparing a new exception.'
    }
}

function Set-RulePorts([string]$Name, [string[]]$Ports) {
    Get-NetFirewallRule -Name $Name -PolicyStore PersistentStore | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -LocalPort $Ports | Out-Null
}

function Get-Plan {
    $block = Get-Rule $blockName
    $sources = Get-Rule $sourceName
    $existing = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
    if ($existing) {
        if ($existing.Version -ne 1) { throw 'Unsupported VM configuration manifest.' }
        Assert-RuleShape $block $existing.Firewall.Block
        Assert-RuleShape $sources $existing.Firewall.Sources
        $newBlocked = @($existing.Firewall.InstalledBlockedPorts)
        $newSources = @($existing.Firewall.InstalledSourcePorts)
    } else {
        Assert-BaseFirewall $block $sources
        $newBlocked = Get-PortException $block.LocalPort $port
        $newSources = @($sources.LocalPort) + @([string]$port)
        if (Get-Rule $allowName) { throw 'The gateway allow rule already exists without this installation manifest.' }
    }
    return [ordered]@{
        Action = $Action; DryRun = ($Action -eq 'Plan' -or [bool]$WhatIfPreference)
        GatewayBaseUrl = $GatewayBaseUrl; Models = @($requestedModels); ModelsOnly = [bool]$ModelsOnly; ExplicitModels = $explicitModels
        Guest = $guestAddress; Host = $hostAddress; Port = $port; InterfaceAlias = $interfaceAlias
        ExistingManifest = [bool]$existing; StateDir = $StateDir
        Firewall = [ordered]@{
            Block = $block; Sources = $sources; Allow = (Get-Rule $allowName)
            AllowSnapshot = if ($existing) { $existing.Firewall.AllowSnapshot } else { $null }
            InstalledBlockedPorts = $newBlocked; InstalledSourcePorts = $newSources
            AllowRuleName = $allowName; GatewayProgram = $GatewayProgram; Skipped = [bool]$SkipFirewall
        }
        GuestFirewall = 'Authenticated readiness and model-catalog checks only; no guest firewall, route, or inference changes.'
        Desktop = [ordered]@{
            Home = $GuestHome; PackageFamily = $PackageFamily; ProfileId = $profileId
            Mode = '3p'; Authentication = 'bearer'; GatewayKey = '[read from KeyFile only during Apply]'
            InferenceModels = @($requestedModels); AlwaysStartWithDefaultModel = $true
            RestartRequired = $true; RealInference = $false
            ProcessHandling = 'Prepare configuration while tasks continue; user restarts Desktop when ready.'
        }
    }
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply/Restore firewall changes require an elevated PowerShell.' }
}

function Assert-DesktopGatewayUrl([string]$BaseUrl, [string]$Operation) {
    $parsed = $null
    if (-not [uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -cne 'http' -or
        $parsed.Host -cnotin @('127.0.0.1', '192.168.168.1') -or $parsed.Port -ne 43157 -or $parsed.UserInfo -or
        $parsed.Query -or $parsed.Fragment -or $parsed.AbsolutePath -notin @('', '/')) { throw 'GatewayBaseUrl must be the dedicated loopback endpoint (or the legacy LAN endpoint for Plan/Restore).' }
    if ($Operation -ceq 'Apply' -and $parsed.Host -cne '127.0.0.1') { throw 'Claude Desktop requires loopback HTTP. Run Repair-ClaudeVmGateway.ps1 -Action Apply for an existing installation; use -ForwardOnly before a new installation.' }
}

function Get-InferenceModelName($Model) {
    if ($Model -is [string]) { return $Model }
    return $Model.name
}

function Assert-InferenceModelEntries([object[]]$Models, [bool]$ExplicitModels = $true) {
    if ($Models.Count -lt 1 -or $Models.Count -gt 256) { throw 'Unexpected VM model set.' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $defaults = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($model in $Models) {
        if ($model -isnot [string]) {
            if (-not $ExplicitModels -or ($model -isnot [Collections.IDictionary] -and $model -isnot [pscustomobject])) { throw 'Unexpected VM model set.' }
            $keys = if ($model -is [Collections.IDictionary]) { @($model.Keys) } else { @($model.PSObject.Properties.Name) }
            if ('name' -cnotin $keys -or @($keys | Where-Object { $_ -cnotin @('name', 'labelOverride', 'supports1m', 'prefer1m', 'anthropicFamilyTier', 'isFamilyDefault', 'maxEffort') }).Count -gt 0) { throw 'Unexpected VM model set.' }
            if ('labelOverride' -cin $keys -and ($model.labelOverride -isnot [string] -or
                [string]::IsNullOrWhiteSpace($model.labelOverride) -or $model.labelOverride.Length -gt 256 -or $model.labelOverride -match '[\x00-\x1f\x7f]')) { throw 'Unexpected VM model set.' }
            foreach ($key in @('supports1m', 'prefer1m', 'isFamilyDefault')) {
                if ($key -cin $keys -and $model.$key -isnot [bool]) { throw 'Unexpected VM model set.' }
            }
            if ('anthropicFamilyTier' -cin $keys -and ($model.anthropicFamilyTier -isnot [string] -or
                $model.anthropicFamilyTier -cnotin @('opus', 'sonnet', 'haiku', 'fable', 'mythos'))) { throw 'Unexpected VM model set.' }
            if ('maxEffort' -cin $keys -and ($model.maxEffort -isnot [string] -or
                $model.maxEffort -cnotin @('low', 'medium', 'high', 'xhigh', 'max'))) { throw 'Unexpected VM model set.' }
            if ($model.prefer1m -eq $true -and $model.supports1m -ne $true) { throw 'Unexpected VM model set.' }
            if ($model.isFamilyDefault -eq $true -and (-not $model.anthropicFamilyTier -or -not $defaults.Add($model.anthropicFamilyTier))) { throw 'Unexpected VM model set.' }
        }
        $name = Get-InferenceModelName $model
        if ($name -isnot [string] -or $name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' -or
            -not $seen.Add($name) -or (-not $ExplicitModels -and $name -cnotin @('claude-opus-5-5', 'claude-codebuddy-opus-5-5'))) { throw 'Unexpected VM model set.' }
    }
    if (-not $ExplicitModels -and $Models.Count -gt 2) { throw 'Unexpected VM model set.' }
}

function Read-InferenceModelsFile([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'ModelsJsonFile must name an existing JSON array file.' }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -gt 65536) { throw 'ModelsJsonFile must be at most 64 KiB.' }
    try {
        $text = [IO.File]::ReadAllText($file.FullName).TrimStart([char]0xFEFF).Trim()
        if (-not $text.StartsWith('[') -or -not $text.EndsWith(']')) { throw 'Expected array.' }
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('NoEnumerate')) {
            $models = ConvertFrom-Json -InputObject $text -NoEnumerate
        } else { $models = ConvertFrom-Json -InputObject $text }
        if ($models -isnot [array]) { throw 'Expected array.' }
    } catch { throw 'ModelsJsonFile must contain a valid JSON array.' }
    Assert-InferenceModelEntries $models
    return ,$models
}

function Get-RequestedVmModels([bool]$IncludeCodeBuddy, [bool]$CodeBuddyOnly, [object[]]$InferenceModels, [string]$ModelsJsonFile) {
    if ($IncludeCodeBuddy -and $CodeBuddyOnly) { throw 'IncludeCodeBuddy and CodeBuddyOnly cannot be used together.' }
    if ($PSBoundParameters.ContainsKey('ModelsJsonFile')) {
        if ($PSBoundParameters.ContainsKey('InferenceModels') -or $IncludeCodeBuddy -or $CodeBuddyOnly) { throw 'ModelsJsonFile cannot be combined with InferenceModels, IncludeCodeBuddy or CodeBuddyOnly.' }
        return ,(Read-InferenceModelsFile $ModelsJsonFile)
    }
    if ($PSBoundParameters.ContainsKey('InferenceModels')) {
        if ($IncludeCodeBuddy -or $CodeBuddyOnly) { throw 'InferenceModels cannot be combined with IncludeCodeBuddy or CodeBuddyOnly.' }
        Assert-InferenceModelEntries $InferenceModels
        return ,@($InferenceModels)
    }
    if ($CodeBuddyOnly) { return ,@('claude-codebuddy-opus-5-5') }
    if ($IncludeCodeBuddy) { return ,@('claude-opus-5-5', 'claude-codebuddy-opus-5-5') }
    return ,@('claude-opus-5-5')
}

function Assert-AllowRule($Rule, [string]$Program) {
    if (-not $Rule) { return }
    if ($Rule.Program -ine $Program -or $Rule.Group -cne 'Codex With VM Gateway' -or $Rule.Enabled -cne 'True' -or
        $Rule.Direction -cne 'Inbound' -or $Rule.Action -cne 'Allow' -or $Rule.Protocol -cne 'TCP' -or $Rule.Profile -cne 'Any' -or
        -not (Test-SameSet $Rule.LocalPort @([string]$port)) -or -not (Test-SameSet $Rule.RemotePort @('Any')) -or
        -not (Test-SameSet $Rule.LocalAddress @($hostAddress)) -or -not (Test-SameSet $Rule.RemoteAddress @($guestAddress)) -or
        -not (Test-SameSet $Rule.InterfaceAlias @($interfaceAlias))) { throw 'The gateway allow rule was edited; overwrite refused.' }
}

function Assert-AllowSnapshot($Current, $Snapshot) {
    if (-not $Current) { return }
    if (-not $Snapshot) { throw 'The existing gateway allow rule has no committed ownership snapshot; manual review is required.' }
    $keys = if ($Snapshot -is [Collections.IDictionary]) { @($Snapshot.Keys) } else { @($Snapshot.PSObject.Properties.Name) }
    foreach ($key in $keys) {
        if (-not (Test-SameSet $Current[$key] $Snapshot.$key)) { throw 'The gateway allow rule changed after installation; restore refused.' }
    }
}

function Invoke-FirewallApply($Manifest) {
    $block = Get-Rule $blockName; $sources = Get-Rule $sourceName
    Assert-RuleShape $block $Manifest.Firewall.Block
    Assert-RuleShape $sources $Manifest.Firewall.Sources
    foreach ($pair in @(@($block, $Manifest.Firewall.Block.LocalPort, $Manifest.Firewall.InstalledBlockedPorts), @($sources, $Manifest.Firewall.Sources.LocalPort, $Manifest.Firewall.InstalledSourcePorts))) {
        if (-not (Test-SameSet $pair[0].LocalPort $pair[1]) -and -not (Test-SameSet $pair[0].LocalPort $pair[2])) { throw 'Protected firewall ports changed after preparation.' }
    }
    $allow = Get-Rule $allowName
    Assert-AllowRule $allow $Manifest.GatewayProgram
    Assert-AllowSnapshot $allow $Manifest.Firewall.AllowSnapshot
    # Protect every other source first; remove only the selected port from the blanket block last.
    Set-RulePorts $sourceName @($Manifest.Firewall.InstalledSourcePorts)
    if (-not $allow) {
        $arguments = @{
            Name = $allowName; DisplayName = 'With gateway: selected VMware guest only'; Group = 'Codex With VM Gateway'
            Description = 'Codex With VM Gateway; restore through its private host manifest.'
            Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Profile = 'Any'; InterfaceAlias = $interfaceAlias; Protocol = 'TCP'
            LocalAddress = $hostAddress; LocalPort = $port; RemoteAddress = $guestAddress; Program = $Manifest.GatewayProgram
        }
        New-NetFirewallRule @arguments | Out-Null
        $Manifest.Firewall.AllowSnapshot = Get-Rule $allowName
        Write-PrivateJson $manifestPath $Manifest
    }
    Set-RulePorts $blockName @($Manifest.Firewall.InstalledBlockedPorts)
}

function Invoke-FirewallRestore($Manifest) {
    $block = Get-Rule $blockName; $sources = Get-Rule $sourceName
    Assert-RuleShape $block $Manifest.Firewall.Block
    Assert-RuleShape $sources $Manifest.Firewall.Sources
    foreach ($pair in @(@($block, $Manifest.Firewall.Block.LocalPort, $Manifest.Firewall.InstalledBlockedPorts), @($sources, $Manifest.Firewall.Sources.LocalPort, $Manifest.Firewall.InstalledSourcePorts))) {
        if (-not (Test-SameSet $pair[0].LocalPort $pair[1]) -and -not (Test-SameSet $pair[0].LocalPort $pair[2])) { throw 'Protected firewall ports changed; restore refused.' }
    }
    $allow = Get-Rule $allowName
    Assert-AllowRule $allow $Manifest.GatewayProgram
    Assert-AllowSnapshot $allow $Manifest.Firewall.AllowSnapshot
    Set-RulePorts $blockName @($Manifest.Firewall.Block.LocalPort)
    if ($allow) { Remove-NetFirewallRule -Name $allowName -PolicyStore PersistentStore }
    Set-RulePorts $sourceName @($Manifest.Firewall.Sources.LocalPort)
}

$GuestPayload = @'
param([Parameter(Mandatory = $true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$request = $null
$reportPath = $null

function To-Map($Value) {
    if ($Value -is [Collections.IDictionary]) { return ,$Value }
    # ConvertFrom-Json can wrap scalar array entries in PSObject; keep their JSON type.
    if ($null -ne $Value -and $Value.GetType() -eq [System.Management.Automation.PSCustomObject]) {
        $map = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = To-Map $property.Value }
        return ,$map
    }
    if ($Value -is [array]) { return ,@(foreach ($item in $Value) { To-Map $item }) }
    return $Value
}

# The host injects its model-entry helpers here so both sides enforce one schema.

function Private-Directory([string]$Directory) {
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($owner)
    foreach ($id in @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($id)
        $access = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($access)
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Hash-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Read-Document([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [ordered]@{ Data = [ordered]@{}; Hash = $null; Exists = $false } }
    $bytes = [IO.File]::ReadAllBytes($Path)
    try { $data = To-Map ([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json) }
    catch { throw 'A Claude configuration file is not valid JSON. No document contents were logged.' }
    if ($data -isnot [Collections.IDictionary]) { throw 'A Claude configuration must contain a JSON object.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '') } finally { $hash.Dispose() }
    return [ordered]@{ Data = $data; Hash = $digest; Exists = $true }
}

function Write-Json([string]$Path, $Value, $ExpectedHash = $null, [switch]$CheckHash) {
    if ($CheckHash -and (Hash-File $Path) -cne $ExpectedHash) { throw 'A Claude configuration changed during the operation.' }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100), $utf8)
        if ($CheckHash -and (Hash-File $Path) -cne $ExpectedHash) { throw 'A Claude configuration changed during the operation.' }
        if ($CheckHash -and $null -ne $ExpectedHash) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        elseif ($CheckHash) { [IO.File]::Move($temporary, $Path) }
        elseif ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Field($Document, [string]$Key) {
    if ($Document.Contains($Key)) { return [ordered]@{ Exists = $true; Value = $Document[$Key] } }
    return [ordered]@{ Exists = $false }
}

function Test-JsonEqual($Left, $Right) {
    $leftValue = To-Map $Left
    $rightValue = To-Map $Right
    if ($leftValue -is [Collections.IDictionary] -or $rightValue -is [Collections.IDictionary]) {
        if ($leftValue -isnot [Collections.IDictionary] -or $rightValue -isnot [Collections.IDictionary] -or $leftValue.Count -ne $rightValue.Count) { return $false }
        foreach ($key in $leftValue.Keys) {
            if ($key -cnotin @($rightValue.Keys) -or -not (Test-JsonEqual $leftValue[$key] $rightValue[$key])) { return $false }
        }
        return $true
    }
    if ($leftValue -is [array] -or $rightValue -is [array]) {
        if ($leftValue -isnot [array] -or $rightValue -isnot [array] -or $leftValue.Count -ne $rightValue.Count) { return $false }
        for ($index = 0; $index -lt $leftValue.Count; $index++) {
            if (-not (Test-JsonEqual $leftValue[$index] $rightValue[$index])) { return $false }
        }
        return $true
    }
    return ((ConvertTo-Json -InputObject $leftValue -Depth 100 -Compress) -ceq (ConvertTo-Json -InputObject $rightValue -Depth 100 -Compress))
}

function Equal-Field($Actual, $Expected) {
    if ([bool]$Actual.Exists -ne [bool]$Expected.Exists) { return $false }
    if (-not $Actual.Exists) { return $true }
    return (Test-JsonEqual $Actual.Value $Expected.Value)
}

function Set-Fields($Document, $Fields, [string]$Side) {
    foreach ($item in $Fields) {
        $value = $item[$Side]
        if ($value.Exists) { $Document[$item.Key] = $value.Value }
        else { $Document.Remove($item.Key) }
    }
}

function Assert-Fields($Document, $Fields, [string]$Phase) {
    foreach ($item in $Fields) {
        $actual = Field $Document $item.Key
        $original = Equal-Field $actual $item.Original
        $installed = Equal-Field $actual $item.Installed
        $previous = $item.Contains('PreviousInstalled') -and (Equal-Field $actual $item.PreviousInstalled)
        if (-not $installed -and -not ($Phase -eq 'prepared' -and $original) -and
            -not ($Phase -in @('prepared', 'upgrading') -and $previous)) {
            throw 'Managed Claude configuration fields changed; overwrite refused.'
        }
    }
}

function Set-RequestedModels($Manifest, [object[]]$Models, [bool]$ExplicitModels = $false) {
    Assert-InferenceModelEntries $Models $ExplicitModels
    $requestedIds = @($Models | ForEach-Object { Get-InferenceModelName $_ })
    $changed = $false
    foreach ($file in $Manifest.Files) {
        foreach ($field in $file.Fields) {
            if ($field.Key -cne 'inferenceModels') { continue }
            $current = @($field.Installed.Value)
            if (Equal-Field $field.Installed ([ordered]@{ Exists = $true; Value = @($Models) })) { continue }
            $currentIds = @($current | ForEach-Object { Get-InferenceModelName $_ })
            $codeBuddyOnly = $requestedIds.Count -eq 1 -and $requestedIds[0] -ceq 'claude-codebuddy-opus-5-5'
            if ($Manifest.Phase -ceq 'upgrading' -or (-not $ExplicitModels -and -not $codeBuddyOnly -and @($currentIds | Where-Object { $_ -cnotin $requestedIds }).Count -gt 0)) {
                throw 'A model upgrade is pending or the requested set would remove an installed model outside CodeBuddyOnly mode.'
            }
            $field.PreviousInstalled = $field.Installed
            $field.Installed = [ordered]@{ Exists = $true; Value = @($Models) }
            $changed = $true
        }
    }
    if ($changed) { $Manifest.Phase = 'upgrading' }
    return $changed
}

function New-FilePlan([string]$Path, $Values) {
    $current = Read-Document $Path
    return [ordered]@{
        Path = $Path; OriginalExists = $current.Exists; OriginalHash = $current.Hash; Backup = $null
        Fields = @(foreach ($key in $Values.Keys) { [ordered]@{
            Key = $key; Original = (Field $current.Data $key); Installed = [ordered]@{ Exists = $true; Value = $Values[$key] }
        } })
    }
}

function Assert-GatewayReady([string]$BaseUrl, [string]$Key, [object[]]$Models = @('claude-opus-5-5'), [bool]$ExplicitModels = $false) {
    Assert-InferenceModelEntries $Models $ExplicitModels
    $requestedIds = @($Models | ForEach-Object { Get-InferenceModelName $_ })
    $arguments = @{
        Uri = ($BaseUrl.TrimEnd('/') + '/health'); Method = 'Get'
        Headers = @{ Authorization = 'Bearer ' + $Key }; TimeoutSec = 15
    }
    try { $health = Invoke-RestMethod @arguments }
    catch { throw 'Gateway readiness is unavailable. The previous configuration was retained.' }
    if ($health.ok -isnot [bool] -or -not $health.ok) { throw 'The gateway is not ready. The previous configuration was retained.' }
    $withRequested = 'claude-opus-5-5' -cin $requestedIds -and
        (-not $ExplicitModels -or $null -ne $health.providers.With -or $null -eq $health.providers.Claude)
    $withProvider = if ($null -ne $health.providers.With) { $health.providers.With } else { $health.provider }
    if ($withRequested -and
        ($withProvider.authenticated -isnot [bool] -or -not $withProvider.authenticated -or
         $withProvider.ready -isnot [bool] -or -not $withProvider.ready)) {
        throw 'The With provider is not authenticated and ready. The previous configuration was retained.'
    }
    if ('claude-codebuddy-opus-5-5' -cin $requestedIds -and
        ($health.providers.CodeBuddy.authenticated -isnot [bool] -or -not $health.providers.CodeBuddy.authenticated -or
         $health.providers.CodeBuddy.ready -isnot [bool] -or -not $health.providers.CodeBuddy.ready)) {
        throw 'The CodeBuddy provider is not authenticated and ready. The previous configuration was retained.'
    }
    $claudeModels = @($requestedIds | Where-Object { $_ -cne 'claude-codebuddy-opus-5-5' -and
        -not ($_ -ceq 'claude-opus-5-5' -and $withRequested) })
    $claudeAuthentication = $health.providers.Claude.authenticated
    if ($claudeModels.Count -gt 0 -and $null -ne $claudeAuthentication -and
        ($claudeAuthentication -isnot [bool] -or -not $claudeAuthentication)) {
        throw 'The Claude upstream authentication is unavailable. The previous configuration was retained.'
    }
    if ($claudeModels.Count -gt 0 -and
        (($health.providers.Claude.ready -isnot [bool] -or -not $health.providers.Claude.ready) -and
         ($health.providers.Claude.connected -isnot [bool] -or -not $health.providers.Claude.connected))) {
        throw 'The Claude upstream is not connected and ready. The previous configuration was retained.'
    }
    $arguments.Uri = $BaseUrl.TrimEnd('/') + '/v1/models'
    try { $catalog = Invoke-RestMethod @arguments }
    catch { throw 'Gateway model catalog is unavailable. The previous configuration was retained.' }
    $modelIds = @($catalog.data | ForEach-Object { $_.id })
    if ($catalog.data -isnot [array] -or
        @($modelIds | Select-Object -Unique).Count -ne $modelIds.Count -or
        @($modelIds | Where-Object { $_ -isnot [string] -or $_ -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' }).Count -gt 0 -or
        (-not $ExplicitModels -and @($modelIds | Where-Object { $_ -cnotin @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') }).Count -gt 0) -or
        @($requestedIds | Where-Object { $_ -cnotin $modelIds }).Count -gt 0) {
        throw 'The gateway model catalog does not match the requested models.'
    }
}

function Assert-LoopbackForward([string]$BaseUrl) {
    if ($BaseUrl -cne 'http://127.0.0.1:43157' -and $BaseUrl -cne 'http://127.0.0.1:43157/') { throw 'New Desktop configuration must use the dedicated loopback endpoint.' }
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp')
    try { $target = if ($key) { [string]$key.GetValue('127.0.0.1/43157') } else { $null } } finally { if ($key) { $key.Dispose() } }
    if ($target -cne '192.168.168.1/43157' -or (Get-Service iphlpsvc).Status -cne 'Running') {
        throw 'Prepare the guest loopback forwarding first: Repair-ClaudeVmGateway.ps1 -Action Apply -ForwardOnly for a new installation, or -Action Apply to repair an existing installation.'
    }
}

try {
    $request = To-Map ([IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json)
    if ($request.Contains('ExplicitModels') -and $request.ExplicitModels -isnot [bool]) { throw 'Unexpected model selection mode.' }
    $explicitModels = $request.Contains('ExplicitModels') -and $request.ExplicitModels -eq $true
    $models = if ($request.Contains('Models')) { @($request.Models) } else { @('claude-opus-5-5') }
    Assert-InferenceModelEntries $models $explicitModels
    $reportPath = $request.ReportPath
    Remove-Item -LiteralPath $RequestFile -Force
    if ($env:COMPUTERNAME -cne 'CLAUDE-DEV-VM' -or $request.Home -cne 'C:\Users\Developer') { throw 'This configuration targets only the existing Claude Workspace VM.' }
    if (([Security.Principal.WindowsIdentity]::GetCurrent().Name -split '\\')[-1] -ine 'Developer') { throw 'Run the guest installer through the existing Developer management channel.' }
    $stateRoot = Join-Path $request.Home 'AppData\Local\CodexWithGateway\with-vm'
    $manifestPath = Join-Path $stateRoot 'manifest.json'
    $running = @(Get-Process -Name Claude -ErrorAction SilentlyContinue)
    Private-Directory $stateRoot
    $manifest = if (Test-Path -LiteralPath $manifestPath) { To-Map ([IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json) } else { $null }
    if ($manifest -and ($manifest.Version -ne 1 -or $manifest.ProfileId -cne $request.ProfileId -or $manifest.Home -cne $request.Home)) { throw 'The guest recovery manifest does not match this installation.' }
    if ($request.Action -eq 'Apply') {
        Assert-LoopbackForward $request.GatewayBaseUrl
        if ($manifest) {
            foreach ($file in $manifest.Files) { foreach ($field in $file.Fields) {
                if (($field.Key -ceq 'inferenceGatewayApiKey' -and $field.Installed.Value -cne $request.GatewayKey) -or
                    ($field.Key -ceq 'inferenceGatewayBaseUrl' -and $field.Installed.Value -cne $request.GatewayBaseUrl)) {
                    throw 'Gateway parameters changed. Restore the previous installation before replacing them.'
                }
            } }
        }
        # Health only reads prepared metadata. Neither check creates a session or sends inference.
        Assert-GatewayReady $request.GatewayBaseUrl $request.GatewayKey $models $explicitModels
        if ($manifest) {
            foreach ($file in $manifest.Files) {
                $current = Read-Document $file.Path
                Assert-Fields $current.Data $file.Fields $manifest.Phase
            }
            if (Set-RequestedModels $manifest $models $explicitModels) { Write-Json $manifestPath $manifest }
        }
        if (-not $manifest) {
            $files = @()
            $sets = @(
                (Join-Path $request.Home 'AppData\Local'),
                (Join-Path $request.Home "AppData\Local\Packages\$($request.PackageFamily)\LocalCache\Local")
            )
            foreach ($base in $sets) {
                $modePath = Join-Path $base 'Claude\claude_desktop_config.json'
                $threePPath = Join-Path $base 'Claude-3p\claude_desktop_config.json'
                $library = Join-Path $base 'Claude-3p\configLibrary'
                $profilePath = Join-Path $library "$($request.ProfileId).json"
                $metaPath = Join-Path $library '_meta.json'
                if (Test-Path -LiteralPath $profilePath) { throw 'The selected private With profile already exists without its recovery manifest.' }
                $meta = Read-Document $metaPath
                $entries = if ($meta.Data.Contains('entries')) { @($meta.Data.entries) } else { @() }
                if (@($entries | Where-Object { $_.id -ceq $request.ProfileId }).Count -gt 0) { throw 'The With profile entry already exists without its recovery manifest.' }
                $entries += [ordered]@{ id = $request.ProfileId; name = 'With - Opus 5.5' }
                $profileValues = [ordered]@{
                    inferenceProvider = 'gateway'; inferenceGatewayBaseUrl = $request.GatewayBaseUrl
                    inferenceGatewayApiKey = $request.GatewayKey; inferenceGatewayAuthScheme = 'bearer'
                    disableDeploymentModeChooser = $true; inferenceModels = @($models)
                    alwaysStartWithDefaultModel = $true
                }
                # Official third-party Desktop configuration accepts IDs and model objects.
                # The gateway independently restricts each alias to its selected provider.
                $files += New-FilePlan $profilePath $profileValues
                $files += New-FilePlan $metaPath ([ordered]@{ entries = $entries; appliedId = $request.ProfileId })
                $files += New-FilePlan $threePPath ([ordered]@{ deploymentMode = '3p' })
                $files += New-FilePlan $modePath ([ordered]@{ deploymentMode = '3p' })
            }
            $backup = Join-Path $stateRoot ("backup-" + [guid]::NewGuid().ToString('N'))
            Private-Directory $backup
            for ($i = 0; $i -lt $files.Count; $i++) {
                if ((Hash-File $files[$i].Path) -cne $files[$i].OriginalHash) { throw 'Claude configuration changed before backup.' }
                if ($files[$i].OriginalExists) {
                    $files[$i].Backup = Join-Path $backup ("{0:D2}.json" -f $i)
                    Copy-Item -LiteralPath $files[$i].Path -Destination $files[$i].Backup
                }
            }
            $manifest = [ordered]@{ Version = 1; Home = $request.Home; ProfileId = $request.ProfileId; Phase = 'prepared'; Files = $files; BackupDirectory = $backup }
            Write-Json $manifestPath $manifest
        }
        foreach ($file in $manifest.Files) {
            $current = Read-Document $file.Path
            Assert-Fields $current.Data $file.Fields $manifest.Phase
            Set-Fields $current.Data $file.Fields 'Installed'
            Write-Json $file.Path $current.Data $current.Hash -CheckHash
        }
        foreach ($file in $manifest.Files) { foreach ($field in $file.Fields) { $field.Remove('PreviousInstalled') } }
        $manifest.Phase = 'installed'; Write-Json $manifestPath $manifest
        $result = [ordered]@{ Success = $true; Action = 'Apply'; Files = $manifest.Files.Count; Models = @($models); CatalogChecked = $true; DesktopRunning = ($running.Count -gt 0); RestartRequired = $true; RealInference = $false; StateDir = $stateRoot }
    } elseif ($request.Action -eq 'Restore') {
        if ($manifest) {
            # Validate every field before changing any file. Unrelated JSON keys remain untouched.
            foreach ($file in $manifest.Files) {
                $current = Read-Document $file.Path
                Assert-Fields $current.Data $file.Fields 'prepared'
            }
            foreach ($file in $manifest.Files) {
                $current = Read-Document $file.Path
                Assert-Fields $current.Data $file.Fields 'prepared'
                Set-Fields $current.Data $file.Fields 'Original'
                if (-not $file.OriginalExists -and $current.Data.Count -eq 0) {
                    if ((Hash-File $file.Path) -cne $current.Hash) { throw 'Claude configuration changed during restore.' }
                    Remove-Item -LiteralPath $file.Path -Force -ErrorAction SilentlyContinue
                } else { Write-Json $file.Path $current.Data $current.Hash -CheckHash }
            }
            Remove-Item -LiteralPath $manifestPath -Force
        }
        $result = [ordered]@{ Success = $true; Action = 'Restore'; Restored = [bool]$manifest; DesktopRunning = ($running.Count -gt 0); RestartRequired = $true; RealInference = $false; StateDir = $stateRoot }
    } else { throw 'Unsupported guest action.' }
    Write-Json $reportPath $result
} catch {
    # No configuration document or key is included in error output.
    $message = $_.Exception.Message
    if ($request -and $request.GatewayKey -and $message.Contains([string]$request.GatewayKey)) { $message = 'Guest configuration failed; sensitive details were suppressed.' }
    if ($reportPath) { Write-Json $reportPath ([ordered]@{ Success = $false; Error = $message; RealInference = $false }) }
    exit 1
} finally {
    if ($request) { $request.GatewayKey = $null }
    if (Test-Path -LiteralPath $RequestFile) { Remove-Item -LiteralPath $RequestFile -Force -ErrorAction SilentlyContinue }
    if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
}
'@
$modelHelpers = foreach ($name in @('Get-InferenceModelName', 'Assert-InferenceModelEntries')) {
    'function ' + $name + ' {' + (Get-Item -LiteralPath ('Function:\' + $name)).Definition + '}'
}
$GuestPayload = $GuestPayload.Replace('# The host injects its model-entry helpers here so both sides enforce one schema.', ($modelHelpers -join "`n"))

function Invoke-Vm([string]$Operation, [string[]]$OperationArguments, [switch]$AllowFailure) {
    & $VmInvoker -Operation $Operation -OperationArguments $OperationArguments | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "VM management operation failed: $Operation." }
}

function Invoke-GuestConfiguration([string]$GuestAction, [string]$GatewayKey) {
    $id = [guid]::NewGuid().ToString('N')
    $stage = Join-Path $StateDir "staging-$id"
    Get-PrivateDirectory $stage
    $hostScript = Join-Path $stage 'configure.ps1'
    $hostRequest = Join-Path $stage 'request.json'
    $hostReport = Join-Path $stage 'result.json'
    $guestTemp = Join-Path $GuestHome 'AppData\Local\Temp'
    $guestScript = Join-Path $guestTemp "codex-with-vm-$id.ps1"
    $guestRequest = Join-Path $guestTemp "codex-with-vm-$id.request.json"
    $guestReport = Join-Path $guestTemp "codex-with-vm-$id.result.json"
    try {
        [IO.File]::WriteAllText($hostScript, $GuestPayload, $utf8)
        Write-PrivateJson $hostRequest ([ordered]@{
            Action = $GuestAction; Home = $GuestHome; PackageFamily = $PackageFamily; ProfileId = $profileId
            GatewayBaseUrl = $GatewayBaseUrl; GatewayKey = $GatewayKey; ReportPath = $guestReport
            Models = @($requestedModels); ExplicitModels = $explicitModels
        })
        Invoke-Vm 'copyFileFromHostToGuest' @($hostScript, $guestScript)
        Invoke-Vm 'copyFileFromHostToGuest' @($hostRequest, $guestRequest)
        Invoke-Vm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $guestScript, '-RequestFile', $guestRequest) -AllowFailure
        Invoke-Vm 'copyFileFromGuestToHost' @($guestReport, $hostReport)
        $result = Get-Content -LiteralPath $hostReport -Raw | ConvertFrom-Json
        if (-not $result.Success) { throw ([string]$result.Error) }
        return $result
    } finally {
        $GatewayKey = $null
        # Also clean a request copied before a failed guest launch. No key is part of this command.
        $cleanup = 'Remove-Item -LiteralPath @(' + ((@($guestRequest, $guestScript, $guestReport) | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ',') + ') -Force -ErrorAction SilentlyContinue'
        try { Invoke-Vm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoProfile', '-NonInteractive', '-Command', $cleanup) -AllowFailure } catch {}
        # Resolve and check the exact private staging path before recursive deletion.
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        $allowedPrefix = $StateDir.TrimEnd('\') + '\'
        if (-not $resolvedStage.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedStage) -notmatch '^staging-[0-9a-f]{32}$') {
            throw 'Unsafe staging cleanup path; recursive deletion refused.'
        }
        if (Test-Path -LiteralPath $resolvedStage) {
            if ((Get-Item -LiteralPath $resolvedStage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staging cleanup encountered a reparse point; recursive deletion refused.' }
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}

$explicitModels = $PSBoundParameters.ContainsKey('InferenceModels') -or $PSBoundParameters.ContainsKey('ModelsJsonFile')
$modelOptions = @{ IncludeCodeBuddy = [bool]$IncludeCodeBuddy; CodeBuddyOnly = [bool]$CodeBuddyOnly }
if ($PSBoundParameters.ContainsKey('InferenceModels')) { $modelOptions.InferenceModels = $InferenceModels }
if ($PSBoundParameters.ContainsKey('ModelsJsonFile')) { $modelOptions.ModelsJsonFile = $ModelsJsonFile }
$requestedModels = Get-RequestedVmModels @modelOptions
Assert-DesktopGatewayUrl $GatewayBaseUrl $Action
if ($GuestHome -cne 'C:\Users\Developer' -or $PackageFamily -notmatch '^(Claude|AnthropicPBC\.Claude)_[A-Za-z0-9]+$') { throw 'Unexpected guest profile or package family.' }
if ([IO.Path]::GetFileName($StateDir).ToLowerInvariant() -cne 'with-vm') { throw 'StateDir must be a dedicated directory named with-vm.' }
if (-not (Test-Path -LiteralPath $VmInvoker -PathType Leaf)) { throw 'The existing VM management wrapper was not found.' }
$plan = Get-Plan
if ($Action -eq 'Plan' -or -not $PSCmdlet.ShouldProcess('Claude Workspace VM and its dedicated host firewall exception', $Action)) {
    $plan | ConvertTo-Json -Depth 12
    return
}
$manifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
if ($ModelsOnly -and ($Action -cne 'Apply' -or -not $manifest -or $manifest.Phase -cne 'installed')) {
    throw 'ModelsOnly requires an installed VM gateway and Action Apply.'
}
$firewallSkipped = if ($manifest) { [bool]$manifest.FirewallSkipped } else { [bool]$SkipFirewall }
if (-not $firewallSkipped -and -not $ModelsOnly) { Assert-Administrator }
Get-PrivateDirectory $StateDir
if ($Action -eq 'Apply') {
    if (-not $GatewayKeyFile -or -not (Test-Path -LiteralPath $GatewayKeyFile -PathType Leaf)) { throw 'Apply requires GatewayKeyFile.' }
    $key = [IO.File]::ReadAllText([IO.Path]::GetFullPath($GatewayKeyFile)).Trim()
    if (-not $key -or $key.Length -gt 8192 -or $key -match '[\r\n\0]') { throw 'GatewayKeyFile must contain one nonempty key.' }
    if ($ModelsOnly -and -not $GatewayProgram) { $GatewayProgram = $manifest.GatewayProgram }
    if (-not $SkipFirewall -and (-not $GatewayProgram -or -not (Test-Path -LiteralPath $GatewayProgram -PathType Leaf))) { throw 'Apply requires the gateway executable path for the scoped firewall allow rule.' }
    if ($GatewayProgram) { $GatewayProgram = (Resolve-Path -LiteralPath $GatewayProgram).ProviderPath }
    if (-not $manifest) {
        $manifest = [ordered]@{
            Version = 1; Phase = 'prepared'; GatewayBaseUrl = $GatewayBaseUrl; GuestHome = $GuestHome; ProfileId = $profileId
            GatewayProgram = $GatewayProgram; FirewallSkipped = [bool]$SkipFirewall; Firewall = $plan.Firewall
        }
        Write-PrivateJson $manifestPath $manifest
    }
    $wasInstalled = $manifest.Phase -ceq 'installed'
    try {
        if (-not $manifest.FirewallSkipped -and -not $ModelsOnly) { Invoke-FirewallApply $manifest }
        $result = Invoke-GuestConfiguration 'Apply' $key
        $manifest.Phase = 'installed'; Write-PrivateJson $manifestPath $manifest
        $result | ConvertTo-Json -Depth 5
    } catch {
        if (-not $wasInstalled) {
            try { [void](Invoke-GuestConfiguration 'Restore' $null) } catch {}
        }
        if (-not $manifest.FirewallSkipped -and -not $wasInstalled) {
            try { Invoke-FirewallRestore $manifest }
            catch { throw 'Configuration failed and firewall rollback was blocked by a concurrent change. Private recovery state was retained.' }
        }
        throw
    } finally { $key = $null }
} elseif ($Action -eq 'Restore') {
    if (-not $manifest) { throw 'No host recovery manifest exists for this VM configuration.' }
    $result = Invoke-GuestConfiguration 'Restore' $null
    if (-not $manifest.FirewallSkipped) { Invoke-FirewallRestore $manifest }
    Remove-Item -LiteralPath $manifestPath -Force
    $result | ConvertTo-Json -Depth 5
}
