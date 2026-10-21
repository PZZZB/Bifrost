# Persistent, noninteractive mode switching. No process, UI, or network access.

function ConvertTo-ClaudeModeMap($Value, [int]$Depth = 0) {
    if ($Depth -gt 64) { throw 'Claude configuration nesting is unsupported.' }
    if ($Value -is [Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in $Value.Keys) { $map[$key] = ConvertTo-ClaudeModeMap $Value[$key] ($Depth + 1) }
        return ,$map
    }
    if ($Value -is [pscustomobject]) {
        $map = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = ConvertTo-ClaudeModeMap $property.Value ($Depth + 1) }
        return ,$map
    }
    if ($Value -is [array]) {
        $items = New-Object 'Collections.Generic.List[object]'
        foreach ($item in $Value) { $items.Add((ConvertTo-ClaudeModeMap $item ($Depth + 1))) }
        return ,$items.ToArray()
    }
    return $Value
}

function Get-ClaudeModeBytesHash([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '') }
    finally { $hash.Dispose() }
}

function Assert-ClaudeModePath([string]$Path, [string]$AllowedHomePath) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($AllowedHomePath.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
        -not $full.Equals($AllowedHomePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Claude mode path is outside the selected home.' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Claude mode paths must not contain links.' }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Read-ClaudeModeBytes([string]$Path) {
    if (-not [IO.File]::Exists($Path) -or (Get-Item -LiteralPath $Path -Force).Length -gt 16MB) { throw 'A managed Claude file is missing or too large.' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt 16MB) { throw 'A managed Claude file is too large.' }
    return ,$bytes
}

function Read-ClaudeModeDocument([string]$Path) {
    $bytes = Read-ClaudeModeBytes $Path
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $text = $encoding.GetString($bytes).TrimStart([char]0xFEFF)
    $options = @{ InputObject = $text; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    $data = ConvertTo-ClaudeModeMap (ConvertFrom-Json @options)
    if ($data -isnot [Collections.IDictionary]) { throw 'A managed Claude document must be a JSON object.' }
    return [ordered]@{ Data = $data; Bytes = $bytes; Hash = (Get-ClaudeModeBytesHash $bytes) }
}

function ConvertTo-ClaudeModeBytes($Value) {
    $text = ConvertTo-Json -InputObject $Value -Depth 100 -Compress -ErrorAction Stop
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
    if ($bytes.Length -gt 16MB) { throw 'A managed Claude document is too large.' }
    return ,$bytes
}

function Get-ClaudeModeField($Document, [string]$Key) {
    if ($Document.Contains($Key)) { return [ordered]@{ Exists = $true; Value = $Document[$Key] } }
    return [ordered]@{ Exists = $false }
}

function Test-ClaudeModeField($Actual, $Expected) {
    if ($Expected -isnot [Collections.IDictionary] -or $Expected.Exists -isnot [bool] -or $Actual.Exists -ne $Expected.Exists) { return $false }
    if (-not $Actual.Exists) { return $true }
    if (-not $Expected.Contains('Value')) { return $false }
    return (ConvertTo-Json -InputObject $Actual.Value -Depth 100 -Compress) -ceq
        (ConvertTo-Json -InputObject $Expected.Value -Depth 100 -Compress)
}

function Copy-ClaudeModeAccess([string]$Source, [string]$Destination) {
    # Copy access rules only. Setting Owner would require unnecessary privileges.
    $sections = [Security.AccessControl.AccessControlSections]::Access
    $access = New-Object Security.AccessControl.FileSecurity
    $access.SetSecurityDescriptorSddlForm((Get-Acl -LiteralPath $Source).GetSecurityDescriptorSddlForm($sections), $sections)
    Set-Acl -LiteralPath $Destination -AclObject $access -ErrorAction Stop
}

function Assert-ClaudeModePrivateState([string]$Path) {
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
    foreach ($rule in (Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowed) {
            throw 'Claude mode recovery state must already have private access rules.'
        }
    }
}

function Write-ClaudeModeAtomic([string]$Path, [byte[]]$Bytes, [string]$ExpectedHash, [string]$TemporaryPath) {
    if ([IO.File]::Exists($TemporaryPath)) { throw 'A Claude mode temporary file already exists.' }
    $wanted = Get-ClaudeModeBytesHash $Bytes
    $created = $false
    try {
        if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $Path)) -cne $ExpectedHash) { throw 'A Claude file changed concurrently.' }
        $empty = [IO.File]::Open($TemporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $empty.Dispose()
        $created = $true
        Copy-ClaudeModeAccess $Path $TemporaryPath
        [IO.File]::WriteAllBytes($TemporaryPath, $Bytes)
        if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $Path)) -cne $ExpectedHash) { throw 'A Claude file changed concurrently.' }
        [IO.File]::Replace($TemporaryPath, $Path, [Management.Automation.Language.NullString]::Value)
        if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $Path)) -cne $wanted) { throw 'A Claude mode write could not be verified.' }
    } finally {
        if ($created -and [IO.File]::Exists($TemporaryPath)) {
            Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction Stop
        }
    }
}

function Save-ClaudeModeJournal([string]$Directory, $Journal) {
    $path = Join-Path $Directory 'journal.json'
    $temporary = Join-Path $Directory 'journal.tmp'
    $bytes = ConvertTo-ClaudeModeBytes $Journal
    if ([IO.File]::Exists($temporary)) { throw 'Claude mode journal staging is incomplete.' }
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop } }
}

function Get-ClaudeModeLayout([string]$HomePath, [string]$StatePath, [string]$PackageFamily, [string]$ProfileId) {
    $paths = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($base in @((Join-Path $HomePath 'AppData\Local'), (Join-Path $HomePath "AppData\Local\Packages\$PackageFamily\LocalCache\Local"))) {
        $paths.Add((Join-Path $base 'Claude\claude_desktop_config.json'), 'mode')
        $paths.Add((Join-Path $base 'Claude-3p\claude_desktop_config.json'), 'mode')
        $paths.Add((Join-Path $base "Claude-3p\configLibrary\$ProfileId.json"), 'profile')
        $paths.Add((Join-Path $base 'Claude-3p\configLibrary\_meta.json'), 'meta')
    }
    return [ordered]@{ Home = $HomePath; State = $StatePath; Profile = $ProfileId; Package = $PackageFamily; Paths = $paths;
        Manifest = (Join-Path $StatePath 'manifest.json'); Pending = (Join-Path $StatePath 'mode-switch.pending') }
}

function Get-ClaudeModeMutexName([string]$ModeHomePath) {
    return 'Local\CodexWithGateway.ClaudeMode.' + (Get-ClaudeModeBytesHash ((New-Object Text.UTF8Encoding($false)).GetBytes($ModeHomePath.ToUpperInvariant())))
}

function Remove-ClaudeModeTransaction($Layout, $Journal) {
    $expected = @('journal.json', 'journal.tmp')
    foreach ($plan in $Journal.Plans) { $expected += $plan.Backup }
    foreach ($entry in Get-ChildItem -LiteralPath $Layout.Pending -Force) {
        if ($entry.PSIsContainer -or $entry.Name -cnotin $expected -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Claude mode recovery contains unexpected files.' }
    }
    if ($journal.Phase -ceq 'preparing') {
        foreach ($plan in $journal.Plans) {
            if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $plan.Path)) -cne $plan.BeforeHash) { throw 'Concurrent edits prevent Claude mode preparation cleanup.' }
        }
    }
    foreach ($plan in $Journal.Plans) {
        $backup = Join-Path $Layout.Pending $plan.Backup
        if ($Journal.Phase -cne 'preparing' -and [IO.File]::Exists($backup) -and
            (Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $backup)) -cne $plan.BeforeHash) { throw 'Claude mode recovery snapshot changed.' }
    }
    foreach ($plan in $Journal.Plans) {
        $backup = Join-Path $Layout.Pending $plan.Backup
        if ([IO.File]::Exists($backup)) { Remove-Item -LiteralPath $backup -Force -ErrorAction Stop }
        $temporary = $plan.Path + '.claude-mode.tmp'
        [void](Assert-ClaudeModePath $temporary $Layout.Home)
        if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop }
    }
    foreach ($name in @('journal.tmp', 'journal.json')) {
        $path = Join-Path $Layout.Pending $name
        if ([IO.File]::Exists($path)) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
    }
    Remove-Item -LiteralPath $Layout.Pending -Force -ErrorAction Stop
}

function Restore-ClaudeModeTransaction($Layout) {
    if (-not [IO.Directory]::Exists($Layout.Pending)) { return $false }
    [void](Assert-ClaudeModePath $Layout.Pending $Layout.Home)
    Assert-ClaudeModePrivateState $Layout.Pending
    $journalPath = Join-Path $Layout.Pending 'journal.json'
    if (-not [IO.File]::Exists($journalPath)) {
        $entries = @(Get-ChildItem -LiteralPath $Layout.Pending -Force)
        if (-not $entries.Count -or ($entries.Count -eq 1 -and -not $entries[0].PSIsContainer -and $entries[0].Name -ceq 'journal.tmp' -and
            -not ($entries[0].Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            if ($entries.Count) { Remove-Item -LiteralPath $entries[0].FullName -Force }
            Remove-Item -LiteralPath $Layout.Pending -Force; return $true
        }
        throw 'Claude mode recovery journal is incomplete.'
    }
    $journal = (Read-ClaudeModeDocument $journalPath).Data
    if ($journal.Version -ne 1 -or $journal.Home -cne $Layout.Home -or $journal.ProfileId -cne $Layout.Profile -or
        $journal.PackageFamily -cne $Layout.Package -or $journal.Phase -cnotin @('preparing', 'prepared', 'committed', 'rolled_back') -or
        $journal.Plans -isnot [array] -or $journal.Plans.Count -lt 1 -or $journal.Plans.Count -gt 7) { throw 'Claude mode recovery journal is invalid.' }
    $seen = @{}
    for ($index = 0; $index -lt $journal.Plans.Count; $index++) {
        $plan = $journal.Plans[$index]
        $path = Assert-ClaudeModePath $plan.Path $Layout.Home
        if (($path -cne $Layout.Manifest -and (-not $Layout.Paths.ContainsKey($path) -or $Layout.Paths[$path] -ceq 'meta')) -or $seen.ContainsKey($path) -or
            $plan.Backup -cne "$index.before" -or $plan.BeforeHash -cnotmatch '^[A-F0-9]{64}$' -or $plan.AfterHash -cnotmatch '^[A-F0-9]{64}$') { throw 'Claude mode recovery plan is invalid.' }
        $seen[$path] = $true
        [void](Assert-ClaudeModePath (Join-Path $Layout.Pending $plan.Backup) $Layout.Home)
        [void](Assert-ClaudeModePath ($path + '.claude-mode.tmp') $Layout.Home)
        $backup = Join-Path $Layout.Pending $plan.Backup
        if (($journal.Phase -ceq 'prepared' -or ($journal.Phase -cne 'preparing' -and [IO.File]::Exists($backup))) -and
            (Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $backup)) -cne $plan.BeforeHash) { throw 'Claude mode recovery snapshot is invalid.' }
    }
    $expected = @('journal.json', 'journal.tmp') + @($journal.Plans | ForEach-Object { $_.Backup })
    foreach ($entry in Get-ChildItem -LiteralPath $Layout.Pending -Force) {
        if ($entry.PSIsContainer -or $entry.Name -cnotin $expected -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Claude mode recovery contains unexpected files.' }
    }
    if ($journal.Phase -ceq 'prepared') {
        $current = @{}
        foreach ($plan in $journal.Plans) {
            $hash = Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $plan.Path)
            if ($hash -cnotin @($plan.BeforeHash, $plan.AfterHash)) { throw 'Concurrent edits prevent Claude mode recovery.' }
            $current[$plan.Path] = $hash
        }
        $stagingJournal = Join-Path $Layout.Pending 'journal.tmp'
        if ([IO.File]::Exists($stagingJournal)) { Remove-Item -LiteralPath $stagingJournal -Force -ErrorAction Stop }
        foreach ($plan in $journal.Plans) {
            $temporary = $plan.Path + '.claude-mode.tmp'
            if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop }
        }
        # All-after means the atomic writes finished before interruption. Otherwise
        # restore only exact installed hashes; never overwrite a concurrent edit.
        if (@($journal.Plans | Where-Object { $current[$_.Path] -cne $_.AfterHash }).Count) {
            for ($index = $journal.Plans.Count - 1; $index -ge 0; $index--) {
                $plan = $journal.Plans[$index]
                if ($current[$plan.Path] -ceq $plan.AfterHash) {
                    Write-ClaudeModeAtomic $plan.Path (Read-ClaudeModeBytes (Join-Path $Layout.Pending $plan.Backup)) $plan.AfterHash ($plan.Path + '.claude-mode.tmp')
                }
            }
            foreach ($plan in $journal.Plans) { if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $plan.Path)) -cne $plan.BeforeHash) { throw 'Claude mode rollback changed concurrently.' } }
            $journal.Phase = 'rolled_back'
        } else {
            $journal.Phase = 'committed'
        }
        Save-ClaudeModeJournal $Layout.Pending $journal
    }
    Remove-ClaudeModeTransaction $Layout $journal
    return $true
}

function Set-ClaudeDesktopMode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Mode,
        [string]$HomePath = $env:USERPROFILE,
        [string]$StateRoot,
        [string]$PackageFamily = 'Claude_pzs8sxrjxfjjc',
        [string]$ProfileId = '8c2be9ad-3973-477e-9550-f3eb09a79fab'
    )
    $ErrorActionPreference = 'Stop'
    $mutex = $null; $locked = $false; $layout = $null; $started = $false; $recovered = $false; $pending = $false
    try {
        if ($Mode -notin @('Account', 'CodeBuddy') -or $PackageFamily -cnotmatch '^(Claude|AnthropicPBC\.Claude)_[A-Za-z0-9]+$' -or
            $ProfileId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { throw 'Claude mode arguments are invalid.' }
        $modeHomePath = [IO.Path]::GetFullPath($HomePath).TrimEnd('\')
        if ($modeHomePath -notmatch '^[A-Za-z]:\\.+' -or -not [IO.Directory]::Exists($modeHomePath)) { throw 'Claude home is invalid.' }
        [void](Assert-ClaudeModePath $modeHomePath $modeHomePath)
        if (-not $StateRoot) { $StateRoot = Join-Path $modeHomePath 'AppData\Local\CodexWithGateway\with-vm' }
        $state = Assert-ClaudeModePath $StateRoot $modeHomePath
        if (-not [IO.Directory]::Exists($state)) { throw 'The installed Claude recovery state is missing.' }
        Assert-ClaudeModePrivateState $state
        $layout = Get-ClaudeModeLayout $modeHomePath $state $PackageFamily $ProfileId
        [void](Assert-ClaudeModePath $layout.Manifest $modeHomePath)
        $mutex = [Threading.Mutex]::new($false, (Get-ClaudeModeMutexName $modeHomePath))
        try { $locked = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Claude mode switching is busy.' }
        $recovered = Restore-ClaudeModeTransaction $layout
        $manifestDocument = Read-ClaudeModeDocument $layout.Manifest
        $manifest = $manifestDocument.Data
        if ($manifest.Version -ne 1 -or $manifest.Phase -cne 'installed' -or $manifest.Home -cne $modeHomePath -or
            $manifest.ProfileId -cne $ProfileId -or $manifest.Files -isnot [array] -or $manifest.Files.Count -ne 8) { throw 'The installed Claude recovery manifest does not match.' }
        $deployment = if ($Mode -ieq 'Account') { '1p' } else { '3p' }
        $safeMode = if ($deployment -ceq '1p') { 'Account' } else { 'CodeBuddy' }
        $plans = New-Object 'Collections.Generic.List[object]'
        $seen = @{}; $targets = 0
        foreach ($file in $manifest.Files) {
            $path = Assert-ClaudeModePath $file.Path $modeHomePath
            if (-not $layout.Paths.ContainsKey($path) -or $seen.ContainsKey($path) -or $file.Fields -isnot [array]) { throw 'The managed Claude file list is invalid.' }
            $seen[$path] = $true
            $document = Read-ClaudeModeDocument $path
            $keys = @{}; $targetFound = $false; $kind = $layout.Paths[$path]
            foreach ($field in $file.Fields) {
                if ($field.Key -isnot [string] -or $keys.ContainsKey($field.Key) -or -not $field.Contains('Original')) { throw 'The managed Claude field list is invalid.' }
                $keys[$field.Key] = $true
                $actual = Get-ClaudeModeField $document.Data $field.Key
                if ($kind -ceq 'mode' -and $field.Key -ceq 'deploymentMode') {
                    if (($actual.Exists -and $actual.Value -cnotin @('1p', '3p')) -or -not $field.Installed.Exists -or $field.Installed.Value -cnotin @('1p', '3p')) { throw 'A managed Claude mode field is invalid.' }
                } elseif (-not (Test-ClaudeModeField $actual $field.Installed)) { throw 'A managed Claude provider setting changed.' }
                if (($kind -ceq 'mode' -and $field.Key -ceq 'deploymentMode') -or ($kind -ceq 'profile' -and $field.Key -ceq 'disableDeploymentModeChooser')) {
                    if (-not $field.Installed.Exists) { throw 'A managed mode field has no installed value.' }
                    $value = if ($kind -ceq 'mode') { $deployment } else { $false }
                    $document.Data[$field.Key] = $value; $field.Installed.Value = $value
                    $targetFound = $true
                }
            }
            if ($kind -cne 'meta') {
                if (-not $targetFound) { throw 'A managed Claude mode or chooser field is missing.' }
                $targets++
                $after = ConvertTo-ClaudeModeBytes $document.Data
                if ((Get-ClaudeModeBytesHash $after) -cne $document.Hash -and
                    (ConvertTo-Json -InputObject (Read-ClaudeModeDocument $path).Data -Depth 100 -Compress) -cne
                    (ConvertTo-Json -InputObject $document.Data -Depth 100 -Compress)) {
                    $plans.Add([ordered]@{ Path = $path; BeforeHash = $document.Hash; Before = $document.Bytes; After = $after })
                }
            }
        }
        if ($targets -ne 6 -or $seen.Count -ne 8) { throw 'The six installed Claude configuration files are required.' }
        $manifestAfter = ConvertTo-ClaudeModeBytes $manifest
        if ((ConvertTo-Json -InputObject $manifestDocument.Data -Depth 100 -Compress) -cne
            (ConvertTo-Json -InputObject (Read-ClaudeModeDocument $layout.Manifest).Data -Depth 100 -Compress)) {
            $plans.Add([ordered]@{ Path = $layout.Manifest; BeforeHash = $manifestDocument.Hash; Before = $manifestDocument.Bytes; After = $manifestAfter })
        }
        $changedFiles = @($plans | Where-Object { $_.Path -cne $layout.Manifest }).Count
        if ($plans.Count) {
            foreach ($plan in $plans) {
                [void](Assert-ClaudeModePath ($plan.Path + '.claude-mode.tmp') $modeHomePath)
                if ([IO.File]::Exists($plan.Path + '.claude-mode.tmp') -or (Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $plan.Path)) -cne $plan.BeforeHash) { throw 'A Claude file changed during preparation.' }
            }
            [IO.Directory]::CreateDirectory($layout.Pending) | Out-Null
            $journal = [ordered]@{ Version = 1; Home = $modeHomePath; ProfileId = $ProfileId; PackageFamily = $PackageFamily; Phase = 'preparing'; Plans = @() }
            for ($index = 0; $index -lt $plans.Count; $index++) {
                $plan = $plans[$index]
                $journal.Plans += [ordered]@{ Path = $plan.Path; BeforeHash = $plan.BeforeHash; AfterHash = (Get-ClaudeModeBytesHash $plan.After); Backup = "$index.before" }
            }
            $started = $true
            Save-ClaudeModeJournal $layout.Pending $journal
            for ($index = 0; $index -lt $plans.Count; $index++) { [IO.File]::WriteAllBytes((Join-Path $layout.Pending "$index.before"), $plans[$index].Before) }
            $journal.Phase = 'prepared'; Save-ClaudeModeJournal $layout.Pending $journal
            foreach ($plan in $plans) { Write-ClaudeModeAtomic $plan.Path $plan.After $plan.BeforeHash ($plan.Path + '.claude-mode.tmp') }
            foreach ($plan in $journal.Plans) { if ((Get-ClaudeModeBytesHash (Read-ClaudeModeBytes $plan.Path)) -cne $plan.AfterHash) { throw 'Claude mode readback changed.' } }
            $journal.Phase = 'committed'; Save-ClaudeModeJournal $layout.Pending $journal
            Remove-ClaudeModeTransaction $layout $journal
        }
        return [pscustomobject]@{ Success = $true; Mode = $safeMode; DeploymentMode = $deployment; Changed = ($plans.Count -gt 0);
            FilesChanged = $changedFiles; RestartRequired = $true; RecoveredInterruptedOperation = [bool]$recovered;
            OriginalRecoveryValuesPreserved = $true; GatewayProfilePreserved = $true; RealInference = $false }
    } catch {
        if ($started -and $locked -and $layout) { try { [void](Restore-ClaudeModeTransaction $layout) } catch { $pending = $true } }
        elseif ($layout -and [IO.Directory]::Exists($layout.Pending)) { $pending = $true }
        $message = if ($pending) { 'Claude mode switch could not finish. Private recovery state is retained; concurrent edits will not be overwritten.' }
            else { 'Claude mode switch was refused or rolled back. Private configuration contents were not logged.' }
        throw [InvalidOperationException]::new($message)
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
    }
}
