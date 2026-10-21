[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Plan', 'Apply', 'Restore')][string]$Action = 'Plan',
    [switch]$ForwardOnly,
    [string]$VmInvoker = 'C:\Users\jiahaoguo\Documents\Codex\2026-09-30\vps-https-www-voyracloud-com-zh\work\vm-build\Invoke-WorkspaceVm.ps1',
    [string]$StateDir = (Join-Path $PSScriptRoot '..\.state\with-vm'),
    [string]$GuestHome = 'C:\Users\Developer',
    [string]$PackageFamily = 'Claude_pzs8sxrjxfjjc'
)

# Plan reads host metadata only. Apply/Restore use the existing VM management
# channel. Neither action changes firewall, Mihomo/TUN, deployment mode or models.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$loopbackUrl = 'http://127.0.0.1:43157'
$backendUrl = 'http://192.168.168.1:43157'
$profileId = '8c2be9ad-3973-477e-9550-f3eb09a79fab'
$StateDir = [IO.Path]::GetFullPath($StateDir)
$hostManifestPath = Join-Path $StateDir 'host-manifest.json'
$hostJournalPath = Join-Path $StateDir 'loopback-repair.json'

function ConvertTo-RepairMap($Value) {
    if ($Value -is [Collections.IDictionary]) { return ,$Value }
    if ($Value -is [pscustomobject]) {
        $result = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = ConvertTo-RepairMap $property.Value }
        return ,$result
    }
    if ($Value -is [array]) { return ,@(foreach ($item in $Value) { ConvertTo-RepairMap $item }) }
    return $Value
}

function Get-RepairHash([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-RepairValueHash($Value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes(($Value | ConvertTo-Json -Depth 100))))).Replace('-', '') }
    finally { $hash.Dispose() }
}

function Read-RepairJson([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    try { $data = ConvertTo-RepairMap ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
    catch { throw 'A repair metadata file is not valid JSON; contents were suppressed.' }
    if ($data -isnot [Collections.IDictionary]) { throw 'Repair metadata must be a JSON object.' }
    return $data
}

function Write-RepairJson([string]$Path, $Value, $ExpectedHash) {
    if ((Get-RepairHash $Path) -cne $ExpectedHash) { throw 'Repair metadata changed concurrently; overwrite refused.' }
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 100), $utf8)
        if ((Get-RepairHash $Path) -cne $ExpectedHash) { throw 'Repair metadata changed concurrently; overwrite refused.' }
        if ($null -ne $ExpectedHash) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force } }
}

function Set-RepairPrivateDirectory([string]$Directory) {
    $item = [IO.Directory]::CreateDirectory($Directory)
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A repair directory is a reparse point.' }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ((Get-Acl -LiteralPath $Directory).GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $allowed) { throw 'A repair directory has an unexpected owner.' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in $allowed) {
        $sid = New-Object Security.Principal.SecurityIdentifier($id)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) }
    else { $item.SetAccessControl($acl) }
}

$RepairGuestPayload = @'
param([Parameter(Mandatory = $true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$loopbackUrl = 'http://127.0.0.1:43157'
$backendUrl = 'http://192.168.168.1:43157'
$request = $null; $reportPath = $null; $lock = $null; $journal = $null; $journalHash = $null

function To-Map($Value) {
    if ($Value -is [Collections.IDictionary]) { return ,$Value }
    if ($Value -is [pscustomobject]) {
        $map = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = To-Map $property.Value }
        return ,$map
    }
    if ($Value -is [array]) { return ,@(foreach ($item in $Value) { To-Map $item }) }
    return $Value
}
function Hash-File([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}
function Read-Json([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    try { $value = To-Map ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
    catch { throw 'Invalid configuration JSON; document contents were suppressed.' }
    if ($value -isnot [Collections.IDictionary]) { throw 'A configuration must contain a JSON object.' }
    return $value
}
function Private-Directory([string]$Path) {
    $item = [IO.Directory]::CreateDirectory($Path)
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A private repair directory is a reparse point.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    if ((Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $allowed) { throw 'Unexpected repair directory owner.' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($id in $allowed) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))) }
    if ($PSVersionTable.PSEdition -eq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($item, $acl) } else { $item.SetAccessControl($acl) }
}
function Write-Bytes([string]$Path, [byte[]]$Bytes, $ExpectedHash) {
    if ((Hash-File $Path) -cne $ExpectedHash) { throw 'A configuration changed concurrently; overwrite refused.' }
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        if ((Hash-File $Path) -cne $ExpectedHash) { throw 'A configuration changed concurrently; overwrite refused.' }
        if ($null -ne $ExpectedHash) { [IO.File]::Replace($temporary, $Path, [Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force } }
}
function Save-Journal {
    Write-Bytes $journalPath $utf8.GetBytes(($journal | ConvertTo-Json -Depth 100)) $script:journalHash
    $script:journalHash = Hash-File $journalPath
}
function Assert-GuestAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The existing guest management channel must run elevated for portproxy.' }
}
function Get-ForwardState {
    $mappings = @()
    foreach ($kind in @('v4tov4', 'v4tov6', 'v6tov4', 'v6tov6')) {
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SYSTEM\CurrentControlSet\Services\PortProxy\$kind\tcp")
        if (-not $key) { continue }
        try { foreach ($name in $key.GetValueNames()) { $mappings += [ordered]@{ Kind = $kind; Listen = $name; Connect = [string]$key.GetValue($name) } } } finally { $key.Dispose() }
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='iphlpsvc'"
    if (-not $service) { throw 'IP Helper service is unavailable.' }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 43157 } | ForEach-Object { [ordered]@{ Address = [string]$_.LocalAddress; Process = [int]$_.OwningProcess } })
    return [ordered]@{ Mappings = $mappings; Status = [string]$service.State; StartMode = [string]$service.StartMode; ProcessId = [int]$service.ProcessId; Listeners = $listeners }
}
function Assert-ForwardState($State, [bool]$Owned) {
    $matches = @($State.Mappings | Where-Object { $_.Listen -match '/43157$' })
    if ($matches.Count -gt 1 -or ($matches.Count -eq 1 -and
        ($matches[0].Kind -cne 'v4tov4' -or $matches[0].Listen -cne '127.0.0.1/43157' -or $matches[0].Connect -cne '192.168.168.1/43157'))) { throw 'A conflicting portproxy mapping uses port 43157; no mapping was changed.' }
    if ($matches.Count -and -not $Owned) { throw 'The loopback mapping already exists without this repair journal; adoption refused.' }
    foreach ($listener in $State.Listeners) {
        if (-not $Owned -or $matches.Count -ne 1 -or $listener.Address -cne '127.0.0.1' -or
            $listener.Process -notin @(4, $State.ProcessId)) { throw 'An unknown listener uses port 43157; no listener was changed.' }
    }
    if ($State.Status -cnotin @('Running', 'Stopped') -or $State.StartMode -ceq 'Disabled') { throw 'IP Helper must be running or startable; its startup configuration is not changed.' }
    return ($matches.Count -eq 1)
}
function Add-Forward {
    & "$env:SystemRoot\System32\netsh.exe" interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=43157 connectaddress=192.168.168.1 connectport=43157 protocol=tcp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Creating the dedicated loopback mapping failed.' }
}
function Remove-Forward {
    & "$env:SystemRoot\System32\netsh.exe" interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=43157 protocol=tcp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Removing the dedicated loopback mapping failed.' }
}
function Ensure-Forward {
    $state = Get-ForwardState
    $exists = Assert-ForwardState $state ([bool]$journal.MappingOwned)
    if ($state.Status -ceq 'Stopped') {
        if (@($state.Mappings).Count) { throw 'Starting IP Helper would activate unrelated mappings; start it explicitly before repair.' }
        $journal.ServiceStarted = $true; Save-Journal
        Start-Service iphlpsvc -ErrorAction Stop
        (Get-Service iphlpsvc).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    }
    if (-not $exists) {
        # Recheck before claiming ownership. An observed concurrent mapping must
        # never become ours merely because rollback follows this refusal.
        $latest = Get-ForwardState
        if (Assert-ForwardState $latest $false) { throw 'A loopback mapping appeared concurrently.' }
        # Record ownership intent before netsh, so a crash after add is recoverable.
        $journal.MappingOwned = $true; Save-Journal
        Add-Forward
    }
    if (-not (Assert-ForwardState (Get-ForwardState) $true)) { throw 'The dedicated mapping was not installed.' }
}
function Restore-Forward {
    $state = Get-ForwardState
    for ($attempt = 0; $attempt -lt 10 -and @($state.Listeners).Count -gt 0 -and -not @($state.Mappings | Where-Object { $_.Listen -match '/43157$' }).Count; $attempt++) {
        Start-Sleep -Milliseconds 100; $state = Get-ForwardState
    }
    $exists = Assert-ForwardState $state ([bool]$journal.MappingOwned)
    if ($exists) { Remove-Forward }
    $state = Get-ForwardState
    if (Assert-ForwardState $state $true) { throw 'The dedicated loopback mapping still exists.' }
    if ($journal.ServiceStarted -and $journal.ServiceOriginal.Status -ceq 'Stopped' -and $state.Status -ceq 'Running') {
        if (@($state.Mappings).Count) { throw 'IP Helper restoration is deferred because another portproxy now depends on it; other mappings were preserved.' }
        if ($state.StartMode -cne $journal.ServiceOriginal.StartMode) { throw 'IP Helper startup mode changed concurrently; service restoration refused.' }
        Stop-Service iphlpsvc -ErrorAction Stop
        (Get-Service iphlpsvc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
    }
}
function Get-ProfilePaths {
    return @((Join-Path $request.Home "AppData\Local\Claude-3p\configLibrary\$($request.ProfileId).json"),
        (Join-Path $request.Home "AppData\Local\Packages\$($request.PackageFamily)\LocalCache\Local\Claude-3p\configLibrary\$($request.ProfileId).json"))
}
function Get-Migration($Manifest) {
    if (-not $Manifest -or $Manifest.Version -ne 1 -or $Manifest.Phase -cne 'installed' -or $Manifest.Home -cne $request.Home -or $Manifest.ProfileId -cne $request.ProfileId) { throw 'Repair requires the existing installed Configure-WithVm guest manifest.' }
    $paths = @(Get-ProfilePaths); $profiles = @(); $key = $null; $models = @()
    foreach ($path in $paths) {
        $entries = @($Manifest.Files | Where-Object { $_.Path -ceq $path })
        if ($entries.Count -ne 1) { throw 'The recovery manifest does not own both expected UUID profiles.' }
        $fields = @($entries[0].Fields | Where-Object { $_.Key -ceq 'inferenceGatewayBaseUrl' })
        if ($fields.Count -ne 1 -or -not $fields[0].Installed.Exists) { throw 'The profile URL has no installed ownership record.' }
        $profile = Read-Json $path
        if (-not $profile -or $profile.inferenceProvider -cne 'gateway' -or $profile.inferenceGatewayAuthScheme -cne 'bearer' -or
            $profile.inferenceGatewayBaseUrl -cne $fields[0].Installed.Value -or $profile.inferenceGatewayBaseUrl -cnotin @($backendUrl, $loopbackUrl)) { throw 'A profile provider or managed URL changed; repair refused.' }
        $candidate = $profile.inferenceGatewayApiKey
        if ($candidate -isnot [string] -or -not $candidate -or $candidate.Length -gt 8192 -or $candidate -match '[\r\n\0]' -or ($null -ne $key -and $candidate -cne $key)) { throw 'The UUID profiles do not contain one matching gateway credential.' }
        $key = $candidate
        $models += @($profile.inferenceModels)
        $profiles += [ordered]@{ Path = $path; Url = $profile.inferenceGatewayBaseUrl; ConfigureOriginal = $fields[0].Original }
    }
    $models = @($models | Select-Object -Unique)
    if ($models.Count -lt 1 -or @($models | Where-Object { $_ -cnotin @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') }).Count) { throw 'The profiles contain an unexpected model set.' }
    return [ordered]@{ Profiles = $profiles; Models = $models; Key = $key }
}
function Get-GatewayMetadata([string]$Path, [string]$Key) {
    $http = [Net.HttpWebRequest]::Create($loopbackUrl + $Path)
    $http.Method = 'GET'; $http.Proxy = $null; $http.AllowAutoRedirect = $false; $http.Timeout = 15000; $http.ReadWriteTimeout = 15000
    $http.Headers['Authorization'] = 'Bearer ' + $Key
    $response = $null; $reader = $null
    try {
        $response = $http.GetResponse()
        if ([int]$response.StatusCode -ne 200) { throw 'Unexpected metadata status.' }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        return To-Map ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch { throw 'Authenticated loopback health/model metadata is unavailable; no inference was sent.' }
    finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Dispose() }; $http.Abort() }
}
function Assert-GatewayMetadata($Migration) {
    $health = Get-GatewayMetadata '/health' $Migration.Key
    if ($health.ok -isnot [bool] -or -not $health.ok) { throw 'The loopback gateway is not ready.' }
    if ('claude-opus-5-5' -cin $Migration.Models -and
        ($health.provider.authenticated -isnot [bool] -or -not $health.provider.authenticated -or
         $health.provider.ready -isnot [bool] -or -not $health.provider.ready)) { throw 'The With provider is not authenticated and ready through loopback.' }
    if ('claude-codebuddy-opus-5-5' -cin $Migration.Models -and
        ($health.providers.CodeBuddy.authenticated -isnot [bool] -or -not $health.providers.CodeBuddy.authenticated -or
        $health.providers.CodeBuddy.ready -isnot [bool] -or -not $health.providers.CodeBuddy.ready)) { throw 'The CodeBuddy provider is not authenticated and ready through loopback.' }
    $catalog = Get-GatewayMetadata '/v1/models' $Migration.Key
    $ids = @($catalog.data | ForEach-Object { $_.id })
    if (@($ids | Select-Object -Unique).Count -ne $ids.Count -or @($Migration.Models | Where-Object { $_ -cnotin $ids }).Count -or
        @($ids | Where-Object { $_ -cnotin @('claude-opus-5-5', 'claude-codebuddy-opus-5-5') }).Count) { throw 'Loopback model metadata does not contain the configured Opus aliases.' }
}
function New-FileChange([string]$Path, $Value, [int]$Index) {
    $before = Join-Path $transactionDir "$Index.before.json"; $after = Join-Path $transactionDir "$Index.after.json"
    $hash = Hash-File $Path
    if ($null -eq $hash) { throw 'A managed profile or manifest disappeared.' }
    [IO.File]::WriteAllBytes($before, [IO.File]::ReadAllBytes($Path))
    if ((Hash-File $before) -cne $hash -or (Hash-File $Path) -cne $hash) { throw 'A configuration changed while its rollback snapshot was read.' }
    [IO.File]::WriteAllText($after, ($Value | ConvertTo-Json -Depth 100), $utf8)
    return [ordered]@{ Path = $Path; Before = $before; After = $after; BeforeHash = $hash; AfterHash = (Hash-File $after) }
}
function Undo-PendingFiles {
    if (-not $journal.Pending) { return }
    foreach ($file in $journal.Pending.Files) {
        $hash = Hash-File $file.Path
        if ($hash -cne $file.BeforeHash -and $hash -cne $file.AfterHash) { throw 'Rollback blocked by a concurrent profile/manifest edit; private journal retained.' }
        if ((Hash-File $file.Before) -cne $file.BeforeHash) { throw 'A private rollback snapshot changed.' }
    }
    foreach ($file in @($journal.Pending.Files | Select-Object -Last 999 | Sort-Object Path -Descending)) {
        if ((Hash-File $file.Path) -ceq $file.AfterHash) { Write-Bytes $file.Path ([IO.File]::ReadAllBytes($file.Before)) $file.AfterHash }
    }
    $journal.Pending = $null; Save-Journal
}
function Invoke-FileChanges($Changes, [string]$Operation) {
    $journal.Pending = [ordered]@{ Operation = $Operation; Files = @($Changes) }; Save-Journal
    foreach ($file in $Changes) { if ((Hash-File $file.Path) -cne $file.BeforeHash) { throw 'A profile or manifest changed before commit.' } }
    foreach ($file in $Changes) { Write-Bytes $file.Path ([IO.File]::ReadAllBytes($file.After)) $file.BeforeHash }
    # Pending remains durable until the caller commits its completion phase in
    # the same journal write. A crash in between rolls these files back first.
}
function Set-ProfileUrls([string]$Operation) {
    $manifestHash = Hash-File $guestManifestPath
    $manifest = Read-Json $guestManifestPath
    if ((Hash-File $guestManifestPath) -cne $manifestHash) { throw 'The guest manifest changed while read.' }
    if (-not $manifest) {
        if ($Operation -cne 'Restore') { throw 'The Configure-WithVm manifest is missing.' }
        foreach ($profile in $journal.Profiles) {
            $current = Read-Json $profile.Path
            if ($current -and (($profile.ConfigureOriginal.Exists -and $current.inferenceGatewayBaseUrl -cne $profile.ConfigureOriginal.Value) -or
                (-not $profile.ConfigureOriginal.Exists -and $current.Contains('inferenceGatewayBaseUrl')))) { throw 'Configure restore is incomplete; a managed profile still depends on this forwarding rule.' }
        }
        return
    }
    if ($journal.ForwardOnly) { throw 'This forward-only preparation now has an installation; run Configure-WithVm Restore before removing its forwarding rule.' }
    $migration = Get-Migration $manifest
    try {
        $changes = @(); $script:transactionDir = Join-Path $stateRoot ([guid]::NewGuid().ToString('N')); Private-Directory $transactionDir
        foreach ($profile in $journal.Profiles) {
            $currentHash = Hash-File $profile.Path; $current = Read-Json $profile.Path
            if ((Hash-File $profile.Path) -cne $currentHash) { throw 'A profile changed while read.' }
            $expected = if ($Operation -ceq 'Apply') { $profile.Url } else { $loopbackUrl }
            $target = if ($Operation -ceq 'Apply') { $loopbackUrl } else { $profile.Url }
            if ($current.inferenceGatewayBaseUrl -cne $expected) { throw 'A managed profile URL changed; update refused.' }
            $current.inferenceGatewayBaseUrl = $target
            $change = New-FileChange $profile.Path $current $changes.Count
            if ($change.BeforeHash -cne $currentHash) { throw 'A profile changed before its transaction was prepared.' }
            $changes += $change
            foreach ($entry in $manifest.Files) { if ($entry.Path -ceq $profile.Path) { foreach ($field in $entry.Fields) { if ($field.Key -ceq 'inferenceGatewayBaseUrl') { $field.Installed.Value = $target } } } }
        }
        $change = New-FileChange $guestManifestPath $manifest $changes.Count
        if ($change.BeforeHash -cne $manifestHash) { throw 'The guest manifest changed before its transaction was prepared.' }
        $changes += $change
        Invoke-FileChanges $changes $Operation
    } finally { $migration.Key = $null }
}
function Invoke-RepairGuest {
    Assert-GuestAdministrator
    $script:journalHash = Hash-File $journalPath; $script:journal = Read-Json $journalPath
    if ($journal -and ($journal.Version -ne 1 -or $journal.Id -cne $request.Id -or $journal.Home -cne $request.Home -or $journal.ProfileId -cne $request.ProfileId)) { throw 'The private repair journal belongs to another operation.' }
    if ($journal.Pending) { Undo-PendingFiles }
    if ($request.Action -ceq 'Apply') {
        if ($journal -and $journal.Phase -ceq 'restoring') { throw 'A restore is in progress; resume Restore first.' }
        if (-not $journal -or $journal.Phase -cin @('restored', 'rolled-back')) {
            $state = Get-ForwardState; [void](Assert-ForwardState $state $false)
            $migration = $null
            if ($request.ForwardOnly) {
                if (Read-Json $guestManifestPath) { throw 'ForwardOnly is for a new installation without a Configure-WithVm manifest.' }
            } else { $migration = Get-Migration (Read-Json $guestManifestPath) }
            $script:journal = [ordered]@{ Version = 1; Id = $request.Id; Home = $request.Home; ProfileId = $request.ProfileId; Phase = 'applying'; ForwardOnly = [bool]$request.ForwardOnly;
                ServiceOriginal = [ordered]@{ Status = $state.Status; StartMode = $state.StartMode }; ServiceStarted = $false; MappingOwned = $false; Pending = $null;
                Profiles = if ($migration) { @($migration.Profiles) } else { @() } }
            if ($migration) { $migration.Key = $null }
            Save-Journal
        }
        if ([bool]$journal.ForwardOnly -ne [bool]$request.ForwardOnly) { throw 'ForwardOnly does not match the existing repair journal.' }
        try {
            Ensure-Forward
            if (-not $journal.ForwardOnly) {
                $migration = Get-Migration (Read-Json $guestManifestPath)
                try { Assert-GatewayMetadata $migration } finally { $migration.Key = $null }
                if ($journal.Phase -cne 'installed') { Set-ProfileUrls 'Apply' }
            }
            $journal.Pending = $null; $journal.Phase = 'installed'; Save-Journal
        } catch {
            if ($journal.Phase -cne 'installed') {
                Undo-PendingFiles
                Restore-Forward
                $journal.Phase = 'rolled-back'; Save-Journal
            }
            throw
        }
    } elseif ($request.Action -ceq 'Restore') {
        if (-not $journal) { throw 'No guest loopback repair journal exists.' }
        if ($journal.Phase -cne 'restored') {
            if ($journal.Phase -ceq 'installed') { $journal.Phase = 'restoring'; Save-Journal; Set-ProfileUrls 'Restore'; $journal.Pending = $null; $journal.ProfilesRestored = $true; Save-Journal }
            elseif ($journal.Phase -ceq 'restoring' -and -not $journal.ProfilesRestored) { Set-ProfileUrls 'Restore'; $journal.Pending = $null; $journal.ProfilesRestored = $true; Save-Journal }
            Restore-Forward
            $journal.Phase = 'restored'; Save-Journal
        }
    } else { throw 'Unsupported guest repair action.' }
    return [ordered]@{ Success = $true; Action = $request.Action; Id = $journal.Id; Phase = $journal.Phase; ForwardOnly = [bool]$journal.ForwardOnly; Profiles = @($journal.Profiles).Count;
        GatewayBaseUrl = if ($request.Action -ceq 'Apply') { $loopbackUrl } else { $backendUrl }; MetadataChecked = ($request.Action -ceq 'Apply' -and -not $journal.ForwardOnly); RealInference = $false; RestartRequired = (-not $journal.ForwardOnly) }
}
try {
    $request = To-Map ([IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json); $reportPath = $request.ReportPath
    Remove-Item -LiteralPath $RequestFile -Force
    if ($env:COMPUTERNAME -cne 'CLAUDE-DEV-VM' -or $request.Home -cne 'C:\Users\Developer' -or
        ([Security.Principal.WindowsIdentity]::GetCurrent().Name -split '\\')[-1] -ine 'Developer' -or $request.Id -notmatch '^[0-9a-f]{32}$' -or
        $request.ProfileId -cne '8c2be9ad-3973-477e-9550-f3eb09a79fab' -or $request.PackageFamily -notmatch '^(Claude|AnthropicPBC\.Claude)_[A-Za-z0-9]+$') { throw 'Repair targets only the existing Claude Workspace VM.' }
    $guestManifestPath = Join-Path $request.Home 'AppData\Local\CodexWithGateway\with-vm\manifest.json'
    $stateRoot = Join-Path $request.Home 'AppData\Local\CodexWithGateway\with-vm\loopback-repair'
    Private-Directory $stateRoot; $journalPath = Join-Path $stateRoot 'journal.json'
    $lock = [IO.File]::Open((Join-Path $stateRoot 'operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $result = Invoke-RepairGuest
    [IO.File]::WriteAllText($reportPath, ($result | ConvertTo-Json -Depth 8), $utf8)
} catch {
    # Exceptions from system/network/file APIs can contain user data. Return a
    # bounded diagnostic only; never return a profile, auth header or key.
    $message = [string]$_.Exception.Message
    if ($_.InvocationInfo.MyCommand.Name -notin @('Invoke-RepairGuest', 'Set-ProfileUrls', 'Get-Migration', 'Assert-ForwardState', 'Restore-Forward', 'Ensure-Forward', 'Undo-PendingFiles', 'Invoke-FileChanges', 'Write-Bytes', 'Assert-GatewayMetadata', 'Get-GatewayMetadata', 'Assert-GuestAdministrator')) { $message = 'Guest loopback repair failed; private recovery journal retained.' }
    if ($reportPath) { [IO.File]::WriteAllText($reportPath, (([ordered]@{ Success = $false; Error = $message; RealInference = $false }) | ConvertTo-Json), $utf8) }
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
    if ([IO.File]::Exists($RequestFile)) { Remove-Item -LiteralPath $RequestFile -Force -ErrorAction SilentlyContinue }
    if ($PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
}
'@

function Invoke-RepairVm([string]$Operation, [string[]]$Arguments, [switch]$AllowFailure) {
    & $VmInvoker -Operation $Operation -OperationArguments $Arguments | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "VM management operation failed: $Operation." }
}

function Invoke-RepairGuestAction([string]$GuestAction, $Journal) {
    $stage = Join-Path $StateDir ('repair-stage-' + [guid]::NewGuid().ToString('N')); Set-RepairPrivateDirectory $stage
    $guestPrefix = Join-Path $GuestHome ('AppData\Local\Temp\claude-loopback-' + [guid]::NewGuid().ToString('N'))
    $hostScript = Join-Path $stage 'repair.ps1'; $hostRequest = Join-Path $stage 'request.json'; $hostReport = Join-Path $stage 'result.json'
    try {
        [IO.File]::WriteAllText($hostScript, $RepairGuestPayload, $utf8)
        Write-RepairJson $hostRequest ([ordered]@{ Action = $GuestAction; Id = $Journal.Id; ForwardOnly = [bool]$Journal.ForwardOnly; Home = $GuestHome; PackageFamily = $PackageFamily; ProfileId = $profileId; ReportPath = "$guestPrefix.result.json" }) $null
        Invoke-RepairVm 'copyFileFromHostToGuest' @($hostScript, "$guestPrefix.ps1")
        Invoke-RepairVm 'copyFileFromHostToGuest' @($hostRequest, "$guestPrefix.request.json")
        Invoke-RepairVm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$guestPrefix.ps1", '-RequestFile', "$guestPrefix.request.json") -AllowFailure
        Invoke-RepairVm 'copyFileFromGuestToHost' @("$guestPrefix.result.json", $hostReport)
        $report = Read-RepairJson $hostReport
        if ($report -and $report.Success -ne $true -and $report.Error -is [string]) { throw ([string]$report.Error) }
        if (-not $report -or $report.Success -ne $true -or $report.Id -cne $Journal.Id) { throw 'Guest repair did not complete; its private journal allows retry or Restore.' }
        return $report
    } finally {
        $cleanup = 'Remove-Item -LiteralPath @(' + ((@("$guestPrefix.ps1", "$guestPrefix.request.json", "$guestPrefix.result.json") | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ',') + ') -Force -ErrorAction SilentlyContinue'
        try { Invoke-RepairVm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', '-NoProfile', '-NonInteractive', '-Command', $cleanup) -AllowFailure } catch {}
        $resolved = [IO.Path]::GetFullPath($stage)
        if (-not $resolved.StartsWith(($StateDir.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^repair-stage-[0-9a-f]{32}$' -or ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe staging cleanup path.' }
        foreach ($path in @($hostScript, $hostRequest, $hostReport)) { if ([IO.File]::Exists($path)) { Remove-Item -LiteralPath $path -Force } }
        Remove-Item -LiteralPath $resolved -Force
    }
}

function Update-RepairHostManifest($Journal, [string]$Target, $ExpectedHash) {
    if ((Get-RepairHash $hostManifestPath) -cne $ExpectedHash) { throw 'Host manifest changed concurrently; its URL was not overwritten.' }
    $manifest = Read-RepairJson $hostManifestPath
    if (-not $manifest -or $manifest.Version -ne 1 -or $manifest.Phase -cne 'installed' -or $manifest.ProfileId -cne $profileId -or $manifest.GuestHome -cne $GuestHome) { throw 'The installed host manifest does not match this repair.' }
    $manifest.GatewayBaseUrl = $Target
    Write-RepairJson $hostManifestPath $manifest $ExpectedHash
}

if ($GuestHome -cne 'C:\Users\Developer' -or $PackageFamily -notmatch '^(Claude|AnthropicPBC\.Claude)_[A-Za-z0-9]+$' -or [IO.Path]::GetFileName($StateDir) -ine 'with-vm') { throw 'Unexpected repair target or state directory.' }
$hostManifestHash = Get-RepairHash $hostManifestPath
$hostManifest = Read-RepairJson $hostManifestPath
$hostJournal = Read-RepairJson $hostJournalPath
if ($Action -ceq 'Plan' -or -not $PSCmdlet.ShouldProcess('Claude VM loopback portproxy and two gateway profile URLs', $Action)) {
    [ordered]@{ Action = 'Plan'; ReadOnly = $true; GuestChecked = $false; ForwardOnly = [bool]$ForwardOnly; ExistingInstallation = [bool]$hostManifest;
        ExistingRepair = [bool]$hostJournal; GatewayBaseUrl = $loopbackUrl; Forward = '127.0.0.1:43157 TCP -> 192.168.168.1:43157';
        ProfileId = $profileId; StateDir = $StateDir; RealInference = $false; Next = 'Apply checks guest administrator, IP Helper, conflicts and metadata. ForwardOnly prepares a new installation without reading credentials.' } | ConvertTo-Json -Depth 5
    return
}
if (-not [IO.File]::Exists($VmInvoker)) { throw 'The existing VM management wrapper was not found.' }
Set-RepairPrivateDirectory $StateDir
$hostLock = [IO.File]::Open((Join-Path $StateDir 'loopback-repair.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if ((Get-RepairHash $hostManifestPath) -cne $hostManifestHash) { throw 'Host manifest changed before repair started.' }
    $hostJournalHash = Get-RepairHash $hostJournalPath
    $hostJournal = Read-RepairJson $hostJournalPath
    if ($hostJournal -and ($hostJournal.Version -ne 1 -or $hostJournal.Id -notmatch '^[0-9a-f]{32}$')) { throw 'Unsupported host repair journal.' }
    if ($Action -ceq 'Apply') {
        if (-not $hostJournal -or $hostJournal.Phase -cin @('restored', 'rolled-back')) {
            if ($ForwardOnly) { if ($hostManifest) { throw 'ForwardOnly requires a new installation without a host manifest.' } }
            elseif (-not $hostManifest -or $hostManifest.Version -ne 1 -or $hostManifest.Phase -cne 'installed' -or
                $hostManifest.ProfileId -cne $profileId -or $hostManifest.GuestHome -cne $GuestHome -or $hostManifest.GatewayBaseUrl -cnotin @($backendUrl, $loopbackUrl)) { throw 'URL migration requires the existing installed host manifest.' }
            $targetHash = $null
            if ($hostManifest) { $targetManifest = Read-RepairJson $hostManifestPath; $targetManifest.GatewayBaseUrl = $loopbackUrl; $targetHash = Get-RepairValueHash $targetManifest }
            $hostJournal = [ordered]@{ Version = 1; Id = if ($hostJournal) { $hostJournal.Id } else { [guid]::NewGuid().ToString('N') }; Phase = 'prepared'; ForwardOnly = [bool]$ForwardOnly;
                OriginalUrl = if ($hostManifest) { $hostManifest.GatewayBaseUrl } else { $null }; OriginalHostHash = $hostManifestHash; TargetHostHash = $targetHash; InstalledHostHash = $null }
            Write-RepairJson $hostJournalPath $hostJournal $hostJournalHash; $hostJournalHash = Get-RepairHash $hostJournalPath
        }
        if ($hostJournal.Phase -ceq 'restoring') { throw 'Host Restore is in progress; resume Restore first.' }
        if ([bool]$ForwardOnly -ne [bool]$hostJournal.ForwardOnly) { throw 'ForwardOnly does not match this repair journal.' }
        if (-not $ForwardOnly -and $hostManifest.GatewayBaseUrl -cnotin @($hostJournal.OriginalUrl, $loopbackUrl)) { throw 'The host gateway URL changed after repair preparation.' }
        if (-not $ForwardOnly -and $hostJournal.Phase -ceq 'prepared' -and $hostManifestHash -cnotin @($hostJournal.OriginalHostHash, $hostJournal.TargetHostHash)) { throw 'Host manifest changed before repair commit; recovery state retained.' }
        $report = Invoke-RepairGuestAction 'Apply' $hostJournal
        if (-not $ForwardOnly -and $hostManifest.GatewayBaseUrl -cne $loopbackUrl) {
            try { Update-RepairHostManifest $hostJournal $loopbackUrl $hostJournal.OriginalHostHash }
            catch {
                [void](Invoke-RepairGuestAction 'Restore' $hostJournal)
                $hostJournal.Phase = 'rolled-back'; Write-RepairJson $hostJournalPath $hostJournal $hostJournalHash
                throw 'Host URL commit failed; guest repair was rolled back and host metadata was not overwritten.'
            }
        }
        $hostJournal.Phase = 'installed'; $hostJournal.InstalledHostHash = Get-RepairHash $hostManifestPath
        Write-RepairJson $hostJournalPath $hostJournal $hostJournalHash
        $report | ConvertTo-Json -Depth 5
    } elseif ($Action -ceq 'Restore') {
        if (-not $hostJournal) { throw 'No host loopback repair journal exists.' }
        $hostJournal.Phase = 'restoring'; Write-RepairJson $hostJournalPath $hostJournal $hostJournalHash; $hostJournalHash = Get-RepairHash $hostJournalPath
        $report = Invoke-RepairGuestAction 'Restore' $hostJournal
        # A complete Configure-WithVm Restore removes its manifest. Never recreate it.
        if ($hostManifest -and -not $hostJournal.ForwardOnly -and $hostManifest.GatewayBaseUrl -ceq $loopbackUrl) { Update-RepairHostManifest $hostJournal $hostJournal.OriginalUrl $hostManifestHash }
        $hostJournal.Phase = 'restored'; Write-RepairJson $hostJournalPath $hostJournal $hostJournalHash
        $report | ConvertTo-Json -Depth 5
    }
} finally { $hostLock.Dispose() }
