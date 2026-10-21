[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Plan', 'Prepare', 'Login', 'Status', 'Stop')][string]$Action,
    [string]$Root = 'D:\AgentTools\OfficialClaudeCli',
    [ValidateSet('win32-x64', 'win32-arm64')][string]$Platform = 'win32-x64',
    [string]$PlanHash,
    [switch]$Interactive
)
$ErrorActionPreference = 'Stop'
$taskProduct = 'CodexAccountBridge.OfficialClaudeCli'
$taskVersion = '2.1.304'
$taskBaseUrl = 'https://downloads.claude.ai/claude-code-releases'
$taskUtf8 = New-Object Text.UTF8Encoding($false)
$taskStage = 'validate-layout'
$taskManifest = $null

function Get-OfficialJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $options = @{ InputObject = (Get-Content -LiteralPath $Path -Raw) }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    return ConvertFrom-Json @options
}

function Get-OfficialHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-OfficialTextHash([string]$Text) {
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '') }
    finally { $digest.Dispose() }
}

function Assert-OfficialPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute -ine $taskLayout.Root -and -not $absolute.StartsWith($taskLayout.Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CLI path is outside the selected runtime root.'
    }
    $candidate = $absolute
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'CLI paths cannot cross a reparse point.' }
        }
        $parent = [IO.Path]::GetDirectoryName($candidate)
        if ($parent -eq $candidate) { break }
        $candidate = $parent
    }
    return $absolute
}

function Write-OfficialJson([string]$Path, $Value) {
    $destination = Assert-OfficialPath $Path
    $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), $taskUtf8)
        if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Set-OfficialPrivateRoot {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $permissions = New-Object Security.AccessControl.DirectorySecurity
    $permissions.SetOwner($identity)
    $permissions.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($principal)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        [void]$permissions.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $taskLayout.Root -AclObject $permissions
}

function Get-OfficialManifest {
    $manifest = Get-OfficialJson $taskLayout.Manifest
    if ($null -eq $manifest) { return $null }
    if ($manifest.Product -cne $taskProduct -or $manifest.SchemaVersion -ne 1 -or $manifest.Root -ine $taskLayout.Root -or
        $manifest.ClaudeCodeVersion -cne $taskVersion -or $manifest.Platform -cne $Platform -or
        $manifest.Phase -cnotin @('preparing', 'prepared')) { throw 'Existing CLI deployment does not match this root and official release.' }
    return $manifest
}

function Read-OfficialRelease($Document) {
    $entry = $Document.platforms.$Platform
    $size = 0L
    if ($null -eq $entry -or $entry.binary -cne 'claude.exe' -or $entry.checksum -isnot [string] -or
        $entry.checksum -notmatch '^[A-Fa-f0-9]{64}$' -or -not [long]::TryParse([string]$entry.size, [ref]$size) -or
        $size -le 0 -or $size -gt 1024L * 1024 * 1024 -or ($Document.version -and $Document.version -cne $taskVersion)) {
        throw 'The official release manifest does not describe the expected CLI build.'
    }
    return [ordered]@{ ClaudeCodeVersion = $taskVersion; Platform = $Platform; Checksum = $entry.checksum.ToUpperInvariant(); Size = $size;
        ManifestUrl = ($taskBaseUrl + '/' + $taskVersion + '/manifest.json');
        BinaryUrl = ($taskBaseUrl + '/' + $taskVersion + '/' + $Platform + '/claude.exe') }
}

function Assert-OfficialBinary([string]$Path, $Release) {
    $null = Assert-OfficialPath $Path
    if ($Release.Checksum -notmatch '^[A-Fa-f0-9]{64}$' -or $Release.Size -le 0 -or
        (Get-OfficialHash $Path) -ine $Release.Checksum -or (Get-Item -LiteralPath $Path).Length -ne $Release.Size) {
        throw 'The CLI executable does not match the official manifest checksum and size.'
    }
}

function Ensure-OfficialBinary($Release) {
    $script:taskStage = 'prepare-official-verify'
    if (Test-Path -LiteralPath $taskLayout.Binary) {
        Assert-OfficialBinary $taskLayout.Binary $Release
        return $true
    }
    $script:taskStage = 'prepare-official-download'
    $temporary = Assert-OfficialPath ($taskLayout.Binary + '.' + [guid]::NewGuid().ToString('N') + '.download')
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Release.BinaryUrl -OutFile $temporary -UseBasicParsing -TimeoutSec 600 -MaximumRedirection 0
        $script:taskStage = 'prepare-official-verify'
        Assert-OfficialBinary $temporary $Release
        if (Test-Path -LiteralPath $taskLayout.Binary) { Assert-OfficialBinary $taskLayout.Binary $Release }
        else { [IO.File]::Move($temporary, $taskLayout.Binary) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    return $false
}

function Assert-OfficialPrepared {
    $manifest = Get-OfficialManifest
    if ($null -eq $manifest -or $manifest.Phase -cne 'prepared') { throw 'Run the reviewed Prepare action before using this CLI deployment.' }
    $release = Get-OfficialJson $taskLayout.Release
    $manifestUrl = $taskBaseUrl + '/' + $taskVersion + '/manifest.json'
    $binaryUrl = $taskBaseUrl + '/' + $taskVersion + '/' + $Platform + '/claude.exe'
    if ($null -eq $release -or $release.ClaudeCodeVersion -cne $taskVersion -or $release.Platform -cne $Platform -or
        $release.ManifestUrl -cne $manifestUrl -or $release.BinaryUrl -cne $binaryUrl -or
        $manifest.Checksum -ine $release.Checksum -or $manifest.Size -ne $release.Size) {
        throw 'The CLI deployment manifest differs from its official release record.'
    }
    Assert-OfficialBinary $taskLayout.Binary $release
    $null = Assert-OfficialPath $taskLayout.ConfigDirectory
    $script:taskManifest = $manifest
    return $release
}

function Get-OfficialEnvironment {
    $environment = @{}
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ($name -match '^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|MAGPIE_)' -or
            $name -match '(API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$') { $environment[$name] = $null }
    }
    foreach ($name in @('CLAUDECODE', 'BROWSER', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
        'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
        'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER')) { $environment[$name] = $null }
    $environment.USERPROFILE = $taskLayout.Profile
    $environment.HOME = $taskLayout.Profile
    $environment.HOMEDRIVE = [IO.Path]::GetPathRoot($taskLayout.Profile).TrimEnd('\')
    $environment.HOMEPATH = $taskLayout.Profile.Substring($environment.HOMEDRIVE.Length)
    $environment.APPDATA = Join-Path $taskLayout.Profile 'AppData\Roaming'
    $environment.LOCALAPPDATA = Join-Path $taskLayout.Profile 'AppData\Local'
    $environment.XDG_CONFIG_HOME = Join-Path $taskLayout.Data 'config'
    $environment.XDG_CACHE_HOME = Join-Path $taskLayout.Data 'cache'
    $environment.XDG_DATA_HOME = Join-Path $taskLayout.Data 'shared'
    $environment.XDG_STATE_HOME = Join-Path $taskLayout.Data 'state'
    $environment.XDG_RUNTIME_DIR = Join-Path $taskLayout.Data 'runtime'
    $environment.TEMP = Join-Path $taskLayout.Data 'temp'
    $environment.TMP = $environment.TEMP
    $environment.CLAUDE_CONFIG_DIR = $taskLayout.ConfigDirectory
    $environment.CLAUDE_SECURESTORAGE_CONFIG_DIR = $taskLayout.ConfigDirectory
    $environment.CLAUDE_CODE_TMPDIR = Join-Path $taskLayout.Data 'temp\claude'
    $environment.CODEX_HOME = Join-Path $taskLayout.Data 'empty-codex'
    $environment.CODEX_SQLITE_HOME = $environment.CODEX_HOME
    $environment.CODEX_LOG_DIR = Join-Path $environment.CODEX_HOME 'logs'
    $environment.DO_NOT_TRACK = '1'
    $environment.DISABLE_TELEMETRY = '1'
    $environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    $environment.PATH = $taskLayout.Bin + ';' + [Environment]::GetEnvironmentVariable('PATH', 'Process')
    return $environment
}

function Get-OfficialEnvironmentHash($Environment) {
    return Get-OfficialTextHash ((@($Environment.Keys | Sort-Object | ForEach-Object { $_ + '=' + [string]$Environment[$_] })) -join "`n")
}

function Start-OfficialProcess([string[]]$Arguments, [string]$LogName, $Environment, [switch]$InteractiveConsole) {
    if ($LogName -notmatch '^[A-Za-z0-9_-]+$') { throw 'Invalid private CLI log name.' }
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '[\x00\r\n]') { throw 'Invalid CLI command argument.' }
        '"' + (($argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
    }
    $saved = @{}
    try {
        foreach ($name in $Environment.Keys) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $Environment[$name], 'Process')
        }
        $options = @{ FilePath = $taskLayout.Binary; ArgumentList = ($quoted -join ' '); WorkingDirectory = $taskLayout.Root; PassThru = $true }
        if ($InteractiveConsole) { $options.WindowStyle = 'Normal' }
        else {
            $options.WindowStyle = 'Hidden'
            $options.RedirectStandardOutput = Join-Path $taskLayout.Logs ($LogName + '.out.log')
            $options.RedirectStandardError = Join-Path $taskLayout.Logs ($LogName + '.err.log')
        }
        $child = Start-Process @options
        $null = $child.Handle
        return $child
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

function Get-OfficialAccountStatus($Environment) {
    $result = @{ AccountChecked = $false; AuthMethodKnown = $false; ConfigDirectoryMatches = $false; SubscriptionAuthenticated = $false }
    $logName = 'auth-status-' + [guid]::NewGuid().ToString('N')
    try {
        $child = Start-OfficialProcess @('auth', 'status', '--json') $logName $Environment
        if (-not $child.WaitForExit(20000)) { if (-not $child.HasExited) { $child.Kill() }; return $result }
        $child.Refresh()
        if ($child.ExitCode -in @(0, 1)) {
            $metadata = Get-OfficialJson (Join-Path $taskLayout.Logs ($logName + '.out.log'))
            $result.AccountChecked = $metadata.loggedIn -is [bool]
            $result.AuthMethodKnown = $metadata.authMethod -is [string] -and $metadata.authMethod -ceq 'claude.ai'
            if ($metadata.configDirectory -is [string] -and [IO.Path]::IsPathRooted($metadata.configDirectory)) {
                $result.ConfigDirectoryMatches = [IO.Path]::GetFullPath($metadata.configDirectory).TrimEnd('\') -ieq $taskLayout.ConfigDirectory
            }
            $result.SubscriptionAuthenticated = $result.AccountChecked -and $metadata.loggedIn -eq $true -and
                $result.AuthMethodKnown -and $result.ConfigDirectoryMatches
        }
    } catch { }
    return $result
}

function New-OfficialLoginIdentity($Child, [string]$LogName, $Environment) {
    return [ordered]@{ Product = $taskProduct; SchemaVersion = 1; Root = $taskLayout.Root; Pid = $Child.Id;
        StartUtc = $Child.StartTime.ToUniversalTime().ToString('o'); Executable = $taskLayout.Binary;
        ClaudeCodeVersion = $taskVersion; Checksum = $taskManifest.Checksum;
        EnvironmentHash = (Get-OfficialEnvironmentHash $Environment); LogName = $LogName; Interactive = $true }
}

function Get-OfficialLoginProcess($Identity, $Environment) {
    if ($null -eq $Identity -or $Identity.Product -cne $taskProduct -or $Identity.SchemaVersion -ne 1 -or
        $Identity.Root -ine $taskLayout.Root -or $Identity.Executable -ine $taskLayout.Binary -or $Identity.Interactive -ne $true -or
        $Identity.ClaudeCodeVersion -cne $taskVersion -or $Identity.Checksum -ine $taskManifest.Checksum -or
        $Identity.EnvironmentHash -cne (Get-OfficialEnvironmentHash $Environment)) { return $null }
    try {
        $owner = Get-Process -Id $Identity.Pid -ErrorAction SilentlyContinue
        if ($null -ne $owner -and $owner.Path -ieq $taskLayout.Binary -and
            $owner.StartTime.ToUniversalTime().ToString('o') -ceq $Identity.StartUtc) { $null = $owner.Handle; return $owner }
    } catch { }
    return $null
}

function Stop-OfficialLogin($Identity, $Environment) {
    $owner = Get-OfficialLoginProcess $Identity $Environment
    if ($null -eq $owner) {
        if ($null -ne $Identity -and $null -ne (Get-Process -Id $Identity.Pid -ErrorAction SilentlyContinue)) {
            throw 'The recorded login process no longer matches this private CLI deployment.'
        }
        return $false
    }
    $owner.Kill()
    if (-not $owner.WaitForExit(5000)) { throw 'The private login process did not stop.' }
    return $true
}

function Get-OfficialPlan {
    $manifest = Get-OfficialManifest
    $description = [ordered]@{ Product = $taskProduct; Root = $taskLayout.Root; ClaudeCodeVersion = $taskVersion; Platform = $Platform;
        ManifestHash = (Get-OfficialHash $taskLayout.Manifest); ReleaseHash = (Get-OfficialHash $taskLayout.Release);
        BinaryHash = (Get-OfficialHash $taskLayout.Binary) }
    return [ordered]@{ Action = 'Plan'; RuntimeRoot = $taskLayout.Root; CliPath = $taskLayout.Binary;
        ConfigDirectory = $taskLayout.ConfigDirectory; ClaudeCodeVersion = $taskVersion; Platform = $Platform;
        PlanHash = (Get-OfficialTextHash ($description | ConvertTo-Json -Compress)); ExistingDeployment = ($null -ne $manifest);
        OfficialManifestUrl = ($taskBaseUrl + '/' + $taskVersion + '/manifest.json'); StartsLogin = $false; RealInference = $false }
}

try {
    if (-not [IO.Path]::IsPathRooted($Root) -or ($Interactive -and $Action -cne 'Login')) { throw 'Use an absolute root and Interactive only with Login.' }
    $taskRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($taskRoot.StartsWith('\\') -or $taskRoot -eq [IO.Path]::GetPathRoot($taskRoot).TrimEnd('\')) { throw 'Use a dedicated local CLI subdirectory.' }
    $taskData = Join-Path $taskRoot 'data'
    $taskProfile = Join-Path $taskData 'profile'
    $taskBin = Join-Path $taskRoot 'bin'
    $taskLayout = @{ Root = $taskRoot; Bin = $taskBin; Binary = (Join-Path $taskBin 'claude.exe'); Data = $taskData;
        Profile = $taskProfile; ConfigDirectory = (Join-Path $taskProfile '.claude'); Logs = (Join-Path $taskData 'logs');
        Manifest = (Join-Path $taskRoot '.official-claude-cli.json'); Release = (Join-Path $taskData 'official-release.json');
        LoginIdentity = (Join-Path $taskData 'login.json') }
    foreach ($path in $taskLayout.Values) { $null = Assert-OfficialPath $path }
    if ($Action -ceq 'Plan') { $taskStage = 'plan'; Get-OfficialPlan | ConvertTo-Json -Depth 8; return }

    if ($Action -ceq 'Prepare') {
        $taskStage = 'prepare-plan'
        $plan = Get-OfficialPlan
        if (-not $PlanHash -or $PlanHash -cne $plan.PlanHash) { throw 'Run Plan and pass its current PlanHash to Prepare.' }
        if (-not $plan.ExistingDeployment -and (Test-Path -LiteralPath $taskLayout.Root) -and
            @(Get-ChildItem -LiteralPath $taskLayout.Root -Force).Count -gt 0) { throw 'The selected root belongs to another installation.' }
        if ($plan.ExistingDeployment) {
            try {
                $release = Assert-OfficialPrepared
                [ordered]@{ Prepared = $true; Reused = $true; RuntimeRoot = $taskLayout.Root; ManifestPhase = 'prepared';
                    CliPath = $taskLayout.Binary; ConfigDirectory = $taskLayout.ConfigDirectory; ClaudeCodeVersion = $taskVersion;
                    LoginStarted = $false; RealInference = $false } | ConvertTo-Json
                return
            } catch {
                if ((Get-OfficialManifest).Phase -ceq 'prepared') { throw }
            }
        }
        $taskStage = 'prepare-private-directories'
        [void][IO.Directory]::CreateDirectory($taskLayout.Root)
        Set-OfficialPrivateRoot
        foreach ($directory in @($taskLayout.Bin, $taskLayout.Data, $taskLayout.Profile, $taskLayout.ConfigDirectory, $taskLayout.Logs,
            (Join-Path $taskProfile 'AppData\Roaming'), (Join-Path $taskProfile 'AppData\Local'),
            (Join-Path $taskData 'config'), (Join-Path $taskData 'cache'), (Join-Path $taskData 'shared'),
            (Join-Path $taskData 'state'), (Join-Path $taskData 'runtime'), (Join-Path $taskData 'temp\claude'),
            (Join-Path $taskData 'empty-codex\logs'))) {
            $null = Assert-OfficialPath $directory
            [void][IO.Directory]::CreateDirectory($directory)
        }
        $deployment = [ordered]@{ Product = $taskProduct; SchemaVersion = 1; Root = $taskLayout.Root; Phase = 'preparing';
            ClaudeCodeVersion = $taskVersion; Platform = $Platform }
        Write-OfficialJson $taskLayout.Manifest $deployment
        $taskStage = 'prepare-official-manifest'
        $manifestReply = Invoke-WebRequest -Uri ($taskBaseUrl + '/' + $taskVersion + '/manifest.json') -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 0
        if ([Text.Encoding]::UTF8.GetByteCount($manifestReply.Content) -gt 1024 * 1024) { throw 'The official release manifest exceeded its size limit.' }
        $release = Read-OfficialRelease ($manifestReply.Content | ConvertFrom-Json)
        $binaryReused = Ensure-OfficialBinary $release
        $taskStage = 'prepare-readback'
        Write-OfficialJson $taskLayout.Release $release
        $deployment.Phase = 'prepared'; $deployment.Checksum = $release.Checksum; $deployment.Size = $release.Size
        Write-OfficialJson $taskLayout.Manifest $deployment
        $release = Assert-OfficialPrepared
        [ordered]@{ Prepared = $true; Reused = $false; RuntimeRoot = $taskLayout.Root; ManifestPhase = 'prepared';
            CliPath = $taskLayout.Binary; ConfigDirectory = $taskLayout.ConfigDirectory; ClaudeCodeVersion = $taskVersion;
            BinaryReused = $binaryReused; LoginStarted = $false; RealInference = $false } | ConvertTo-Json
        return
    }

    if ($Action -ceq 'Status') {
        $taskStage = 'status'
        $prepared = $false; $phase = 'missing'
        try {
            $record = Get-OfficialManifest
            if ($record) {
                $phase = $record.Phase
                if ($phase -ceq 'prepared') { $null = Assert-OfficialPrepared; $prepared = $true }
            }
        }
        catch { if (Test-Path -LiteralPath $taskLayout.Manifest) { $phase = 'invalid' } }
        $environment = Get-OfficialEnvironment
        $loginRunning = $false
        $account = @{ AccountChecked = $false; AuthMethodKnown = $false; ConfigDirectoryMatches = $false; SubscriptionAuthenticated = $false }
        if ($prepared) {
            $loginRunning = $null -ne (Get-OfficialLoginProcess (Get-OfficialJson $taskLayout.LoginIdentity) $environment)
            $account = Get-OfficialAccountStatus $environment
        }
        [ordered]@{ Prepared = $prepared; RuntimeRoot = $taskLayout.Root; ManifestPhase = $phase; CliPath = $taskLayout.Binary;
            ConfigDirectory = $taskLayout.ConfigDirectory; ClaudeCodeVersion = $taskVersion; LoginRunning = $loginRunning;
            AccountChecked = $account.AccountChecked; AuthMethodKnown = $account.AuthMethodKnown;
            ConfigDirectoryMatches = $account.ConfigDirectoryMatches; SubscriptionAuthenticated = $account.SubscriptionAuthenticated;
            RealInference = $false } | ConvertTo-Json
        return
    }

    $taskStage = 'verify-prepared'
    $null = Assert-OfficialPrepared
    $environment = Get-OfficialEnvironment
    $identity = Get-OfficialJson $taskLayout.LoginIdentity
    if ($Action -ceq 'Stop') {
        $taskStage = 'stop-login'
        $stopped = Stop-OfficialLogin $identity $environment
        [ordered]@{ LoginStopped = $stopped; LoginRunning = $false; RuntimeRoot = $taskLayout.Root; RealInference = $false } | ConvertTo-Json
        return
    }
    if (-not $Interactive) { $taskStage = 'login-requires-interactive'; throw 'Complete Login in the real console with Interactive.' }
    $taskStage = 'login'
    $owner = Get-OfficialLoginProcess $identity $environment
    $reused = $null -ne $owner
    if (-not $reused) {
        $logName = 'login-' + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText((Join-Path $taskLayout.Logs ($logName + '.log')), 'Official interactive Claude subscription login started. Complete the browser and any manual code in its console.', $taskUtf8)
        $owner = Start-OfficialProcess @('auth', 'login', '--claudeai') $logName $environment -InteractiveConsole
        $identity = New-OfficialLoginIdentity $owner $logName $environment
        Write-OfficialJson $taskLayout.LoginIdentity $identity
        Start-Sleep -Milliseconds 250
    }
    $loginRunning = $null -ne (Get-OfficialLoginProcess $identity $environment)
    $account = @{ AccountChecked = $false; AuthMethodKnown = $false; ConfigDirectoryMatches = $false; SubscriptionAuthenticated = $false }
    if (-not $loginRunning) { $account = Get-OfficialAccountStatus $environment }
    [ordered]@{ LoginStarted = (-not $reused); LoginRunning = $loginRunning; Reused = $reused; Interactive = $true;
        RuntimeRoot = $taskLayout.Root; ConfigDirectoryMatches = $account.ConfigDirectoryMatches;
        AccountChecked = $account.AccountChecked; AuthMethodKnown = $account.AuthMethodKnown;
        SubscriptionAuthenticated = $account.SubscriptionAuthenticated; RealInference = $false } | ConvertTo-Json
} catch {
    Write-Error ('Official Claude CLI action did not finish (stage: ' + $taskStage + '). Private account data and log contents were not printed.')
    exit 1
}
