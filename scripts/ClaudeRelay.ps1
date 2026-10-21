[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Plan', 'Start', 'Status', 'Stop')][string]$Action,
    [string]$Root = 'D:\AgentTools\ClaudeRelay',
    [Parameter(Mandatory = $true)][string]$NodeBinary,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$EntryScript,
    [string]$PlanHash
)
$ErrorActionPreference = 'Stop'
$relayProduct = 'CodexAccountBridge.ClaudeRelay'
$relayUtf8 = New-Object Text.UTF8Encoding($false)
$relayManagerPath = $PSCommandPath

function Get-RelayTextHash([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '') }
    finally { $algorithm.Dispose() }
}

function Assert-RelayLocalPath([string]$Path) {
    if ($Path -cnotmatch '^[A-Za-z]:[\\/]' -or $Path.StartsWith('\\') -or $Path -match '[\x00-\x1f\x7f"]' -or $Path.Trim() -cne $Path) {
        throw 'A relay path must be an absolute local path without control characters.'
    }
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($absolute -ieq [IO.Path]::GetPathRoot($absolute).TrimEnd('\') -or $absolute.Substring([IO.Path]::GetPathRoot($absolute).Length).Contains(':')) {
        throw 'A relay path cannot be a drive root or alternate data stream.'
    }
    $candidate = $absolute
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Relay paths cannot cross a reparse point.'
            }
        }
        $candidate = [IO.Path]::GetDirectoryName($candidate)
    }
    return $absolute
}

function Assert-RelayOwnedPath([string]$Path) {
    $absolute = Assert-RelayLocalPath $Path
    if (-not $absolute.StartsWith($relayLayout.State + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A relay control file is outside its private state directory.'
    }
    return $absolute
}

function Get-RelayFile([string]$Path) {
    $absolute = Assert-RelayLocalPath $Path
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { throw 'A required relay file does not exist.' }
    return [ordered]@{ Path = $absolute; SHA256 = (Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash }
}

function Get-RelayOptionalHash([string]$Path) {
    $null = Assert-RelayOwnedPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Read-RelayJson([string]$Path, [int]$Limit = 65536) {
    try {
        $bytes = [IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -gt $Limit) { throw 'Document limit.' }
        $decoder = New-Object Text.UTF8Encoding($false, $true)
        $options = @{ InputObject = $decoder.GetString($bytes) }
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
        return ConvertFrom-Json @options
    } catch { throw 'A relay metadata document could not be read safely.' }
}

function Read-RelayKey([string]$Path) {
    if ((Get-Item -LiteralPath $Path).Length -gt 4098) { throw 'The dedicated relay key file is invalid.' }
    $key = [IO.File]::ReadAllText($Path, $relayUtf8) -replace '\r?\n$', ''
    if ($key -cnotmatch '^[\x21-\x7e]{40,4096}$') { throw 'The dedicated relay key file is invalid.' }
    return $key
}

function Test-RelayAddress([string]$Value) {
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$address) -or $address.Equals([Net.IPAddress]::Any) -or
        $address.Equals([Net.IPAddress]::IPv6Any)) { return $false }
    if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) { return $address.ToString() -ceq $Value }
    return $Value.Contains(':')
}

function Test-RelayInteger($Value, [long]$Minimum, [long]$Maximum) {
    return ($Value -is [int] -or $Value -is [long]) -and $Value -ge $Minimum -and $Value -le $Maximum
}

function Get-RelayInputs {
    $node = Get-RelayFile $NodeBinary
    $entry = Get-RelayFile $EntryScript
    $configFile = Get-RelayFile $ConfigPath
    $config = Read-RelayJson $configFile.Path
    if (-not (Test-RelayInteger $config.version 1 1) -or $config.listener.address -isnot [string] -or
        -not (Test-RelayAddress $config.listener.address) -or
        -not (Test-RelayInteger $config.listener.port 1024 65535) -or
        $config.listener.allowedHosts -isnot [array] -or $config.listener.allowedPeers -isnot [array] -or $config.models -isnot [array] -or
        @($config.listener.allowedHosts).Count -lt 1 -or @($config.listener.allowedPeers).Count -lt 1 -or
        @($config.listener.allowedPeers | Where-Object { -not (Test-RelayAddress $_) }).Count -gt 0 -or
        @($config.listener.allowedHosts | Where-Object { $_ -isnot [string] -or $_ -match '[\x00-\x20\x7f]' }).Count -gt 0 -or
        @($config.models).Count -lt 1 -or @($config.models | Where-Object {
            $_.id -isnot [string] -or $_.id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' -or
            $_.name -isnot [string] -or -not $_.name -or $_.name -match '[\x00-\x1f\x7f]' -or
            $_.upstream -isnot [string] -or $_.upstream -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
        }).Count -gt 0) { throw 'The relay configuration has invalid listener or model metadata.' }
    $mcp = 3436
    if ($null -ne $config.mcpPort) { $mcp = $config.mcpPort }
    if (-not (Test-RelayInteger $mcp 1024 65535) -or $mcp -eq $config.listener.port) {
        throw 'The relay MCP loopback port is invalid.'
    }
    foreach ($path in @($config.cli.configDir, $config.cli.profileDir, $config.cli.stateDir)) { $null = Assert-RelayLocalPath $path }
    $cli = Get-RelayFile $config.cli.binary
    $keyFile = Get-RelayFile $config.gatewayKeyFile
    $null = Read-RelayKey $keyFile.Path
    return [ordered]@{ Node = $node; Entry = $entry; Config = $configFile; GatewayKey = $keyFile; CliBinary = $cli;
        Manager = (Get-RelayFile $relayManagerPath); Address = ([Net.IPAddress]::Parse($config.listener.address).ToString()); GatewayPort = [int]$config.listener.port;
        McpPort = $mcp; AllowedPeers = @($config.listener.allowedPeers); ModelIds = @($config.models | ForEach-Object { $_.id }) }
}

function Read-RelayManifest {
    if (-not (Test-Path -LiteralPath $relayLayout.Manifest -PathType Leaf)) { return $null }
    $null = Assert-RelayOwnedPath $relayLayout.Manifest
    $manifest = Read-RelayJson $relayLayout.Manifest
    if ($manifest.Product -cne $relayProduct -or $manifest.SchemaVersion -ne 1 -or $manifest.Root -ine $relayLayout.Root -or
        $manifest.ManagerId -cnotmatch '^[a-f0-9]{32}$') { throw 'The relay state directory has another owner.' }
    return $manifest
}

function Read-RelayIdentity($Manifest) {
    if (-not (Test-Path -LiteralPath $relayLayout.Identity -PathType Leaf)) { return $null }
    $null = Assert-RelayOwnedPath $relayLayout.Identity
    $identity = Read-RelayJson $relayLayout.Identity
    if ($null -eq $Manifest -or $identity.Product -cne $relayProduct -or $identity.SchemaVersion -ne 1 -or
        $identity.Root -ine $relayLayout.Root -or $identity.ManagerId -cne $Manifest.ManagerId -or
        -not (Test-RelayInteger $identity.Pid 1 ([int]::MaxValue)) -or $identity.LogName -cnotmatch '^relay-[a-f0-9]{32}$') {
        throw 'The relay process identity does not belong to this state directory.'
    }
    return $identity
}

function Get-RelayPlan($Inputs, $Manifest) {
    if ($null -eq $Manifest -and (Test-Path -LiteralPath $relayLayout.State -PathType Container) -and
        @(Get-ChildItem -LiteralPath $relayLayout.State -Force).Count -gt 0) {
        throw 'The relay control directory is nonempty without an ownership manifest.'
    }
    $description = [ordered]@{ Product = $relayProduct; SchemaVersion = 1; Root = $relayLayout.Root; Inputs = $Inputs;
        ManifestSHA256 = (Get-RelayOptionalHash $relayLayout.Manifest); IdentitySHA256 = (Get-RelayOptionalHash $relayLayout.Identity);
        PendingStartSHA256 = (Get-RelayOptionalHash $relayLayout.Pending) }
    return [ordered]@{ PlanHash = (Get-RelayTextHash ($description | ConvertTo-Json -Depth 10 -Compress));
        RuntimeRoot = $relayLayout.Root; NodeBinary = $Inputs.Node.Path; EntryScript = $Inputs.Entry.Path;
        ConfigPath = $Inputs.Config.Path; GatewayKeyFile = $Inputs.GatewayKey.Path; CliBinary = $Inputs.CliBinary.Path;
        ListenerAddress = $Inputs.Address; GatewayPort = $Inputs.GatewayPort; McpPort = $Inputs.McpPort;
        AllowedPeers = $Inputs.AllowedPeers; ConfiguredModels = $Inputs.ModelIds;
        StartPending = (Test-Path -LiteralPath $relayLayout.Pending -PathType Leaf);
        CreatesPrivateState = ($null -eq $Manifest); RealInference = $false;
        Effects = @('Start one hidden Node process using the reviewed files and dedicated key.',
            'Write private process ownership and readiness logs.', 'Stop only through the authenticated pipe of the verified owned process.') }
}

function Get-RelayArguments($Inputs) { return '"' + $Inputs.Entry.Path + '" "' + $Inputs.Config.Path + '"' }

function Test-RelayCommand([string]$CommandLine, $Inputs) {
    if ($CommandLine -cmatch '^"([^"]+)" (.*)\z') { $executable = $Matches[1]; $arguments = $Matches[2] }
    elseif ($CommandLine -cmatch '^([^\s"]+) (.*)\z') { $executable = $Matches[1]; $arguments = $Matches[2] }
    else { return $false }
    # WinPS5 Start-Process can append whitespace after the final quoted argument.
    return $executable -ieq $Inputs.Node.Path -and $arguments.TrimEnd([char[]]@(' ', "`t")) -ceq (Get-RelayArguments $Inputs)
}

function Get-RelayOwnedProcess($Identity, $Inputs) {
    if ($null -eq $Identity) { return $null }
    foreach ($pair in @(@('Node', 'Node'), @('Entry', 'Entry'), @('Config', 'Config'), @('GatewayKey', 'GatewayKey'), @('CliBinary', 'CliBinary'))) {
        $record = $Identity.($pair[0]); $current = $Inputs.($pair[1])
        if ($record.Path -ine $current.Path -or $record.SHA256 -cne $current.SHA256) { throw 'The recorded relay files changed; process ownership is unconfirmed.' }
    }
    $owner = Get-Process -Id $Identity.Pid -ErrorAction SilentlyContinue
    if ($null -eq $owner) { return $null }
    try {
        $metadata = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$Identity.Pid) -ErrorAction Stop
        if ($owner.Path -ine $Inputs.Node.Path -or $owner.StartTime.ToUniversalTime().ToString('o') -cne $Identity.StartUtc -or
            $metadata.ExecutablePath -ine $Inputs.Node.Path -or $metadata.CommandLine -cne $Identity.CommandLine -or
            -not (Test-RelayCommand $metadata.CommandLine $Inputs)) { throw 'Unconfirmed process.' }
        $null = $owner.Handle
        return $owner
    } catch { throw 'The recorded PID no longer matches the owned relay process.' }
}

function Write-RelayJson([string]$Path, $Value, $ExpectedHash = $null) {
    $destination = Assert-RelayOwnedPath $Path
    if ((Get-RelayOptionalHash $destination) -cne $ExpectedHash) { throw 'A relay ownership record changed; overwrite was refused.' }
    $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), $relayUtf8)
        if ((Get-RelayOptionalHash $destination) -cne $ExpectedHash) { throw 'A relay ownership record changed; overwrite was refused.' }
        if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Set-RelayPrivateDirectory([string]$Path) {
    $null = Assert-RelayLocalPath $Path
    $directory = [IO.Directory]::CreateDirectory($Path)
    $account = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $permissions = New-Object Security.AccessControl.DirectorySecurity
    $permissions.SetOwner($account); $permissions.SetAccessRuleProtection($true, $false)
    foreach ($value in @($account.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($value)
        [void]$permissions.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    if ($PSVersionTable.PSEdition -ceq 'Core') { [IO.FileSystemAclExtensions]::SetAccessControl($directory, $permissions) }
    else { $directory.SetAccessControl($permissions) }
}

function Start-RelayChild($Inputs, [string]$LogName) {
    if ($LogName -cnotmatch '^relay-[a-f0-9]{32}$') { throw 'The relay log identity is invalid.' }
    $allowed = @('PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH',
        'APPDATA','LOCALAPPDATA','LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
        'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','NODE_USE_SYSTEM_CA')
    $saved = @{}; $child = $null
    try {
        foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
            if ($name.ToUpperInvariant() -notin $allowed) {
                $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                [Environment]::SetEnvironmentVariable($name, [Management.Automation.Language.NullString]::Value, 'Process')
            }
        }
        $child = Start-Process -FilePath $Inputs.Node.Path -ArgumentList (Get-RelayArguments $Inputs) -WorkingDirectory $relayLayout.Root -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $relayLayout.Logs ($LogName + '.out.log')) -RedirectStandardError (Join-Path $relayLayout.Logs ($LogName + '.err.log'))
        $null = $child.Handle
        return $child
    } catch {
        $failure = New-Object InvalidOperationException('The hidden relay process could not be started; no request was sent.')
        if ($null -ne $child) { $failure.Data['RelayNewChild'] = $child }
        throw $failure
    }
    finally { foreach ($name in $saved.Keys) {
        if ($null -eq $saved[$name]) { [Environment]::SetEnvironmentVariable($name, [Management.Automation.Language.NullString]::Value, 'Process') }
        else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    } }
}

function Get-RelayReady($Identity, $Inputs) {
    if ($null -eq $Identity) { return $false }
    $path = Assert-RelayOwnedPath (Join-Path $relayLayout.Logs ($Identity.LogName + '.out.log'))
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -gt 65536) { return $false }
    $stream = $null; $reader = $null
    try {
        # The hidden process keeps its redirected stdout writer open while serving.
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        if ($stream.Length -gt 65536) { return $false }
        $reader = New-Object IO.StreamReader($stream, $relayUtf8)
        $characters = New-Object char[] 65537
        $count = $reader.ReadBlock($characters, 0, $characters.Length)
        if ($count -gt 65536 -or $stream.Length -gt 65536) { return $false }
        $text = New-Object string($characters, 0, $count)
        foreach ($line in ($text -split '\r?\n')) {
            $event = $line | ConvertFrom-Json
            if ($event.event -ceq 'ready' -and $event.realInference -is [bool] -and -not $event.realInference -and
                $event.listener.address -ceq $Inputs.Address -and $event.listener.port -eq $Inputs.GatewayPort -and
                $event.controlPipe -ceq ('\\.\pipe\CodexAccountBridge-ClaudeRelay-' + $Identity.Pid) -and
                (($event.configuredModels | ConvertTo-Json -Compress) -ceq ($Inputs.ModelIds | ConvertTo-Json -Compress))) { return $true }
        }
    } catch { }
    finally { if ($null -ne $reader) { $reader.Dispose() }; if ($null -ne $stream) { $stream.Dispose() } }
    return $false
}

function Get-RelayStatus($Inputs, $Identity, $Owner) {
    $pendingPid = $null
    $pending = Test-Path -LiteralPath $relayLayout.Pending -PathType Leaf
    if ($pending) {
        try {
            $null = Assert-RelayOwnedPath $relayLayout.Pending
            $record = Read-RelayJson $relayLayout.Pending
            if ($record.Product -ceq $relayProduct -and $record.Root -ieq $relayLayout.Root -and
                (Test-RelayInteger $record.Pid 1 ([int]::MaxValue))) { $pendingPid = $record.Pid }
        } catch { }
    }
    return [ordered]@{ RuntimeRoot = $relayLayout.Root; Running = ($null -ne $Owner); ProcessOwned = ($null -ne $Owner);
        ListenerReady = ($null -ne $Owner -and (Get-RelayReady $Identity $Inputs)); Authenticated = $null;
        StartPending = $pending; PendingOwnedPid = $pendingPid;
        ListenerAddress = $Inputs.Address; GatewayPort = $Inputs.GatewayPort; McpPort = $Inputs.McpPort;
        GatewayKeyFile = $Inputs.GatewayKey.Path; ConfiguredModels = $Inputs.ModelIds; RealInference = $false }
}

function Send-RelayShutdown([int]$ProcessId, [string]$KeyPath) {
    $pipe = $null; $reader = $null; $writer = $null
    try {
        $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', ('CodexAccountBridge-ClaudeRelay-' + $ProcessId),
            [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
        $pipe.Connect(1000)
        $reader = New-Object IO.StreamReader($pipe, $relayUtf8, $false, 4096, $true)
        $writer = New-Object IO.StreamWriter($pipe, $relayUtf8, 4096, $true)
        $writer.NewLine = "`n"
        $writer.WriteLine((@{ command = 'shutdown'; key = (Read-RelayKey $KeyPath) } | ConvertTo-Json -Compress))
        $writer.Flush()
        $reply = $reader.ReadLineAsync()
        if (-not $reply.Wait(2000)) { throw 'Control timeout.' }
        $acknowledged = $reply.GetAwaiter().GetResult() | ConvertFrom-Json
        if ($acknowledged.stopping -isnot [bool] -or -not $acknowledged.stopping) { throw 'Control was not acknowledged.' }
    } catch { throw 'The verified relay did not acknowledge authenticated shutdown; no process was killed.' }
    finally { if ($null -ne $writer) { $writer.Dispose() }; if ($null -ne $reader) { $reader.Dispose() }; if ($null -ne $pipe) { $pipe.Dispose() } }
}

function Stop-RelayOwned($Identity, $Inputs) {
    $owner = Get-RelayOwnedProcess $Identity $Inputs
    if ($null -eq $owner) { return $false }
    Send-RelayShutdown ([int]$Identity.Pid) $Inputs.GatewayKey.Path
    if (-not $owner.WaitForExit(15000)) { throw 'The owned relay has not exited after authenticated shutdown; no process was killed.' }
    return $true
}

function New-RelayHeldIdentity($Child, $Inputs) {
    return [ordered]@{ Product = $relayProduct; Root = $relayLayout.Root; Pid = [int]$Child.Id;
        StartUtc = $Child.StartTime.ToUniversalTime().ToString('o'); NodePath = $Child.Path;
        Node = $Inputs.Node; Entry = $Inputs.Entry; Config = $Inputs.Config; GatewayKey = $Inputs.GatewayKey; CliBinary = $Inputs.CliBinary }
}

function Stop-RelayNewChild($Child, $Held, $Inputs, [int]$TimeoutMilliseconds = 15000) {
    # Only this invocation's held child is eligible. Existing owners never enter this recovery path.
    if ($null -eq $Child -or $null -eq $Held -or $Child.Id -ne $Held.Pid -or $Held.NodePath -ine $Inputs.Node.Path) { return $false }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
            $Child.Refresh()
            if ($Child.HasExited) { return $true }
            $owner = Get-Process -Id $Held.Pid -ErrorAction SilentlyContinue
            if ($null -eq $owner -or $owner.Path -ine $Held.NodePath -or
                $owner.StartTime.ToUniversalTime().ToString('o') -cne $Held.StartUtc) { return $false }
            foreach ($name in @('Node', 'Entry', 'Config', 'GatewayKey', 'CliBinary')) {
                $current = Get-RelayFile $Inputs.$name.Path
                if ($Held.$name.Path -ine $current.Path -or $Held.$name.SHA256 -cne $current.SHA256) { return $false }
            }
            $remaining = $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds
            # A control attempt can consume 1 s connect plus 2 s acknowledgement time.
            if ($remaining -lt 3000) { return $Child.WaitForExit([Math]::Max(0, $remaining)) }
            try {
                Send-RelayShutdown ([int]$Held.Pid) $Inputs.GatewayKey.Path
                return $Child.WaitForExit([Math]::Max(0, $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds))
            } catch { Start-Sleep -Milliseconds 100 }
        }
    } catch { }
    return $false
}

function Clear-RelayPending([string]$ExpectedHash) {
    $null = Assert-RelayOwnedPath $relayLayout.Pending
    if ((Get-RelayOptionalHash $relayLayout.Pending) -cne $ExpectedHash) { throw 'The pending relay start record changed; removal was refused.' }
    Remove-Item -LiteralPath $relayLayout.Pending -Force
}

function Clear-RelayNewIdentity($Expected) {
    if ($null -eq $Expected) { return }
    $path = Assert-RelayOwnedPath $relayLayout.Identity
    $current = Get-RelayOptionalHash $path
    if ($null -eq $current -and -not $Expected.Committed) { return }
    if ($current -cne $Expected.SHA256) { throw 'The failed-start identity changed; its record was retained.' }
    $record = Read-RelayJson $path
    if ($record.Product -cne $relayProduct -or $record.Root -ine $relayLayout.Root -or
        $record.Pid -ne $Expected.Pid -or $record.ManagerId -cne $Expected.ManagerId -or $record.StartUtc -cne $Expected.StartUtc) {
        throw 'The failed-start identity ownership did not match this child; its record was retained.'
    }
    if ((Get-RelayOptionalHash $path) -cne $Expected.SHA256) { throw 'The failed-start identity changed concurrently; its record was retained.' }
    Remove-Item -LiteralPath $path -Force
}

$relayMutex = $null; $relayMutexOwned = $false
$relayStartedChild = $null; $relayHeld = $null; $relayPendingActive = $false; $relayPendingHash = $null
$relayIdentityCleanup = $null
try {
    $absoluteRoot = Assert-RelayLocalPath $Root
    $state = Join-Path $absoluteRoot 'data\relay-process'
    $relayLayout = @{ Root = $absoluteRoot; State = (Assert-RelayLocalPath $state); Logs = (Join-Path $state 'logs');
        Manifest = (Join-Path $state 'manager.json'); Identity = (Join-Path $state 'identity.json'); Pending = (Join-Path $state 'pending-start.json') }
    $relayMutex = New-Object Threading.Mutex($false, ('Local\CodexAccountBridge.ClaudeRelay.' + (Get-RelayTextHash $absoluteRoot.ToLowerInvariant())))
    try { $relayMutexOwned = $relayMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $relayMutexOwned = $true }
    if (-not $relayMutexOwned) { throw 'Another relay lifecycle action is active for this root.' }
    $inputs = Get-RelayInputs
    $manifest = Read-RelayManifest
    $identity = Read-RelayIdentity $manifest
    $identityHash = Get-RelayOptionalHash $relayLayout.Identity
    $plan = Get-RelayPlan $inputs $manifest
    if ($Action -ceq 'Plan') { $plan | ConvertTo-Json -Depth 10; return }
    $owner = Get-RelayOwnedProcess $identity $inputs
    if ($Action -ceq 'Start') {
        if (-not $PlanHash -or $PlanHash -cne $plan.PlanHash) { throw 'The relay Start action requires the current reviewed PlanHash.' }
        if ($plan.StartPending) { throw 'An earlier relay start is still pending; inspect Status and resolve its recorded owned PID before starting again.' }
        if ($null -eq $owner) {
            Set-RelayPrivateDirectory $relayLayout.State
            Set-RelayPrivateDirectory $relayLayout.Logs
            if ($null -eq $manifest) {
                $manifest = [ordered]@{ Product = $relayProduct; SchemaVersion = 1; Root = $relayLayout.Root; ManagerId = [guid]::NewGuid().ToString('N') }
                Write-RelayJson $relayLayout.Manifest $manifest
            }
            $logName = 'relay-' + [guid]::NewGuid().ToString('N')
            Write-RelayJson $relayLayout.Pending ([ordered]@{ Product = $relayProduct; Root = $relayLayout.Root; Pid = $null; Phase = 'starting' })
            $relayPendingActive = $true
            $relayPendingHash = Get-RelayOptionalHash $relayLayout.Pending
            $child = Start-RelayChild $inputs $logName
            $relayStartedChild = $child
            $relayHeld = New-RelayHeldIdentity $child $inputs
            Write-RelayJson $relayLayout.Pending $relayHeld $relayPendingHash
            $relayPendingHash = Get-RelayOptionalHash $relayLayout.Pending
            $metadata = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + [int]$child.Id) -ErrorAction Stop
            if ($child.Path -ine $inputs.Node.Path -or $metadata.ExecutablePath -ine $inputs.Node.Path -or -not (Test-RelayCommand $metadata.CommandLine $inputs)) {
                throw 'The started relay process identity could not be confirmed.'
            }
            $identity = [ordered]@{ Product = $relayProduct; SchemaVersion = 1; Root = $relayLayout.Root; ManagerId = $manifest.ManagerId;
                Pid = [int]$child.Id; StartUtc = $child.StartTime.ToUniversalTime().ToString('o'); CommandLine = $metadata.CommandLine;
                Node = $inputs.Node; Entry = $inputs.Entry; Config = $inputs.Config; GatewayKey = $inputs.GatewayKey; CliBinary = $inputs.CliBinary; LogName = $logName }
            $relayIdentityCleanup = [ordered]@{ Pid = $identity.Pid; ManagerId = $identity.ManagerId; StartUtc = $identity.StartUtc;
                SHA256 = (Get-RelayTextHash ($identity | ConvertTo-Json -Depth 12)); Committed = $false }
            Write-RelayJson $relayLayout.Identity $identity $identityHash
            $relayIdentityCleanup.Committed = $true
            $owner = Get-RelayOwnedProcess $identity $inputs
            $timer = [Diagnostics.Stopwatch]::StartNew()
            while (-not (Get-RelayReady $identity $inputs)) {
                $child.Refresh()
                if ($child.HasExited -or $timer.Elapsed.TotalSeconds -gt 15) { throw 'The owned relay did not publish matching readiness metadata; inspect its private logs.' }
                Start-Sleep -Milliseconds 100
            }
            Clear-RelayPending $relayPendingHash
            $relayPendingActive = $false
        }
    } elseif ($Action -ceq 'Stop') {
        if ($plan.StartPending) { throw 'A failed relay start requires its recorded owned PID to be reconciled before lifecycle Stop or another Start.' }
        $stopped = Stop-RelayOwned $identity $inputs
        if ($null -ne $identity) {
            $null = Assert-RelayOwnedPath $relayLayout.Identity
            if ((Get-RelayOptionalHash $relayLayout.Identity) -cne $identityHash) { throw 'The relay stopped but its ownership record changed; removal was refused.' }
            Remove-Item -LiteralPath $relayLayout.Identity -Force
        }
        $result = Get-RelayStatus $inputs $null $null
        $result.Stopped = $stopped
        $result | ConvertTo-Json -Depth 10
        return
    }
    Get-RelayStatus $inputs $identity $owner | ConvertTo-Json -Depth 10
} catch {
    $relayFailure = $_
    if ($relayPendingActive) {
        if ($null -eq $relayStartedChild -and $null -ne $_.Exception.Data['RelayNewChild']) { $relayStartedChild = $_.Exception.Data['RelayNewChild'] }
        if ($null -ne $relayStartedChild -and $null -eq $relayHeld) {
            try { $relayHeld = New-RelayHeldIdentity $relayStartedChild $inputs } catch { }
        }
        $cleaned = Stop-RelayNewChild $relayStartedChild $relayHeld $inputs
        if ($cleaned) {
            try { Clear-RelayNewIdentity $relayIdentityCleanup; Clear-RelayPending $relayPendingHash; $relayPendingActive = $false } catch { }
        }
        if ($relayPendingActive) {
            $pendingProcess = 'unconfirmed'
            if ($null -ne $relayStartedChild) { $pendingProcess = [string]$relayStartedChild.Id }
            $pendingState = 'Process cleanup is unconfirmed.'
            if ($cleaned) { $pendingState = 'Its process stopped, but its identity record needs reconciliation.' }
            [Console]::Error.WriteLine('Claude relay startup cleanup is pending for owned PID ' + $pendingProcess + '. ' + $pendingState + ' The private pending-start record blocks another Start; no other process was stopped.')
            exit 1
        }
    }
    [Console]::Error.WriteLine('Claude relay lifecycle failed: ' + $relayFailure.Exception.Message)
    exit 1
} finally {
    if ($relayMutexOwned) { $relayMutex.ReleaseMutex() }
    if ($null -ne $relayMutex) { $relayMutex.Dispose() }
}
