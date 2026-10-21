[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\ClaudeRelay.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'The Claude relay manager does not parse.' }
foreach ($name in @('Get-RelayTextHash', 'Assert-RelayLocalPath', 'Assert-RelayOwnedPath', 'Get-RelayFile',
    'Get-RelayOptionalHash', 'Read-RelayJson', 'Read-RelayKey', 'Test-RelayAddress', 'Test-RelayInteger', 'Get-RelayInputs',
    'Read-RelayManifest', 'Read-RelayIdentity', 'Get-RelayPlan', 'Get-RelayArguments', 'Test-RelayCommand',
    'Get-RelayOwnedProcess', 'Write-RelayJson', 'Start-RelayChild', 'Get-RelayReady', 'Get-RelayStatus', 'Stop-RelayOwned',
    'New-RelayHeldIdentity', 'Stop-RelayNewChild', 'Clear-RelayPending', 'Clear-RelayNewIdentity')) {
    $functions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($functions.Count -ne 1) { throw 'The offline relay fixture cannot locate a required function.' }
    . ([scriptblock]::Create($functions[0].Extent.Text))
}

$relayProduct = 'CodexAccountBridge.ClaudeRelay'
$relayUtf8 = New-Object Text.UTF8Encoding($false)
$script:passed = 0
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('claude-relay-process-fixture-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The offline relay fixture escaped the temporary directory.'
}

function Assert-Test([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) { Reset-Fixture; & $Body; $script:passed++; Write-Output ('PASS ' + $Name) }
function Expect-Failure([scriptblock]$Body, [string]$PrivateText = '') {
    $failed = $false
    try { & $Body | Out-Null } catch {
        $failed = $true
        if ($PrivateText) { Assert-Test (-not $_.Exception.Message.Contains($PrivateText)) 'Private error content escaped.' }
    }
    Assert-Test $failed 'An unconfirmed relay lifecycle operation was accepted.'
}

function Write-Fixture([string]$Path, [string]$Value) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Value, $relayUtf8)
}
function Save-Config { Write-Fixture $ConfigPath ($script:fixtureConfig | ConvertTo-Json -Depth 12) }
function New-FixtureManifest {
    return [pscustomobject]@{ Product = $relayProduct; SchemaVersion = 1; Root = $relayLayout.Root; ManagerId = ('a' * 32) }
}
function New-FixtureIdentity($Inputs) {
    return [pscustomobject]@{ Product = $relayProduct; SchemaVersion = 1; Root = $relayLayout.Root; ManagerId = ('a' * 32);
        Pid = 43210; StartUtc = $script:fixtureStart.ToUniversalTime().ToString('o'); CommandLine = $script:fixtureCommand;
        Node = $Inputs.Node; Entry = $Inputs.Entry; Config = $Inputs.Config; GatewayKey = $Inputs.GatewayKey; CliBinary = $Inputs.CliBinary;
        LogName = ('relay-' + ('b' * 32)) }
}
function Set-FixtureOwner($Inputs) {
    $script:fixtureCommand = '"' + $Inputs.Node.Path + '" ' + (Get-RelayArguments $Inputs)
    $script:fixtureMetadata = [pscustomobject]@{ ExecutablePath = $Inputs.Node.Path; CommandLine = $script:fixtureCommand }
    $script:fixtureOwner = [pscustomobject]@{ Id = 43210; Path = $Inputs.Node.Path; StartTime = $script:fixtureStart;
        Handle = [intptr]::Zero; HasExited = $false }
    $script:fixtureOwner | Add-Member ScriptMethod WaitForExit { param($Milliseconds)
        $script:fixtureWait = $Milliseconds; return -not $script:fixtureWaitTimeout
    }
    $script:fixtureOwner | Add-Member ScriptMethod Refresh { }
}
function Reset-Fixture {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    $script:Root = Join-Path $fixtureRoot 'relay'
    $script:NodeBinary = Join-Path $Root 'bin\node.exe'
    $script:EntryScript = Join-Path $Root 'app\scripts\run-claude-relay.mjs'
    $script:ConfigPath = Join-Path $Root 'data\relay.json'
    $script:relayManagerPath = Join-Path $Root 'tools\ClaudeRelay.ps1'
    $script:relayLayout = @{ Root = $Root; State = (Join-Path $Root 'data\relay-process');
        Logs = (Join-Path $Root 'data\relay-process\logs'); Manifest = (Join-Path $Root 'data\relay-process\manager.json');
        Identity = (Join-Path $Root 'data\relay-process\identity.json'); Pending = (Join-Path $Root 'data\relay-process\pending-start.json') }
    $cliRoot = Join-Path $fixtureRoot 'official-cli'
    $script:fixtureKey = 'fixture-dedicated-gateway-key-' + ('z' * 40)
    $script:fixtureConfig = [pscustomobject]@{ version = 1;
        listener = [pscustomobject]@{ address = '192.168.168.10'; port = 3435;
            allowedHosts = @('192.168.168.10:3435'); allowedPeers = @('192.168.168.1') };
        gatewayKeyFile = (Join-Path $Root 'data\gateway.key'); mcpPort = 3436;
        models = @([pscustomobject]@{ id = 'claude/opus-original'; name = 'Original Opus'; upstream = 'opus' });
        cli = [pscustomobject]@{ binary = (Join-Path $cliRoot 'bin\claude.exe');
            configDir = (Join-Path $cliRoot 'data\profile\.claude'); profileDir = (Join-Path $cliRoot 'data\profile');
            stateDir = (Join-Path $Root 'data\sessions') } }
    Write-Fixture $NodeBinary 'Fixture node executable, never executed.'
    Write-Fixture $EntryScript 'Fixture relay entry, never executed.'
    Write-Fixture $relayManagerPath 'Fixture manager source, never executed.'
    Write-Fixture $script:fixtureConfig.cli.binary 'Fixture official CLI, never executed.'
    Write-Fixture $script:fixtureConfig.gatewayKeyFile $script:fixtureKey
    Save-Config
    $script:fixtureOwner = $null; $script:fixtureMetadata = $null; $script:fixtureCimFails = $false
    $script:fixtureStart = [datetime]'2026-01-02T03:04:05.0000000Z'; $script:fixtureWait = 0
    $script:fixtureWaitTimeout = $false; $script:fixtureShutdownCalls = 0; $script:fixtureShutdownFails = $false
    $script:fixtureShutdownFailuresRemaining = 0
    $script:fixtureStartCalls = 0; $script:fixtureChildEnvironment = $null; $script:fixtureStartOptions = $null
}

# These replace every process operation used by extracted functions. No child executable is launched.
function Get-Process { param([int]$Id, $ErrorAction) if ($null -ne $script:fixtureOwner -and $Id -eq $script:fixtureOwner.Id) { return $script:fixtureOwner } }
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($script:fixtureCimFails) { throw 'PRIVATE_CIM_FAILURE' }
    return $script:fixtureMetadata
}
function Send-RelayShutdown {
    param([int]$ProcessId, [string]$KeyPath)
    $script:fixtureShutdownCalls++; $script:fixtureShutdownPid = $ProcessId; $script:fixtureShutdownKeyPath = $KeyPath
    if ($script:fixtureShutdownFailuresRemaining -gt 0) { $script:fixtureShutdownFailuresRemaining--; throw 'Fixture pipe is not ready.' }
    if ($script:fixtureShutdownFails) { throw 'Fixture shutdown was not acknowledged.' }
}
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
    $script:fixtureStartCalls++
    $script:fixtureStartOptions = @{} + $PSBoundParameters
    $script:fixtureChildEnvironment = @{} + [Environment]::GetEnvironmentVariables('Process')
    return $script:fixtureOwner
}

try {
    Test-Case 'only absolute local paths are accepted' {
        foreach ($value in @('.\relay', 'C:relative\relay', 'C:\', '\\server\share\relay', 'C:\relay\file:stream', 'C:\relay"bad')) {
            Expect-Failure { Assert-RelayLocalPath $value }
        }
        Assert-Test ((Assert-RelayLocalPath $Root) -ceq $Root) 'An ordinary absolute root was rejected.'
    }

    Test-Case 'configuration exposes only paths and public model metadata' {
        $inputs = Get-RelayInputs
        $public = $inputs | ConvertTo-Json -Depth 12 -Compress
        Assert-Test ($inputs.ModelIds[0] -ceq 'claude/opus-original' -and $inputs.GatewayKey.Path -ceq $script:fixtureConfig.gatewayKeyFile) 'Valid generic configuration was not recognized.'
        Assert-Test (-not $public.Contains($script:fixtureKey) -and -not (Test-Path -LiteralPath $script:fixtureConfig.cli.configDir)) 'Gateway secrets or account files escaped metadata-only validation.'
    }

    Test-Case 'invalid listener, model, MCP and array fields fail closed' {
        foreach ($change in @('wildcard', 'ipv6-wildcard', 'short-ipv4', 'port', 'peer', 'models', 'mcp', 'host-array', 'version')) {
            Reset-Fixture
            switch ($change) {
                'wildcard' { $script:fixtureConfig.listener.address = '0.0.0.0' }
                'ipv6-wildcard' { $script:fixtureConfig.listener.address = '0:0:0:0:0:0:0:0' }
                'short-ipv4' { $script:fixtureConfig.listener.address = '127.1' }
                'port' { $script:fixtureConfig.listener.port = 80 }
                'peer' { $script:fixtureConfig.listener.allowedPeers = @('example.com') }
                'models' { $script:fixtureConfig.models[0].id = 'invalid model' }
                'mcp' { $script:fixtureConfig.mcpPort = 3435 }
                'host-array' { $script:fixtureConfig.listener.allowedHosts = '192.168.168.10:3435' }
                'version' { $script:fixtureConfig.version = '1' }
            }
            Save-Config
            Expect-Failure { Get-RelayInputs }
        }
    }

    Test-Case 'malformed private metadata never appears in a public exception' {
        Write-Fixture $ConfigPath '{"PRIVATE_CONFIG_FRAGMENT":'
        Expect-Failure { Get-RelayInputs } 'PRIVATE_CONFIG_FRAGMENT'
        Write-Fixture $ConfigPath ('x' * 65537)
        Expect-Failure { Get-RelayInputs }
    }

    Test-Case 'a malformed dedicated key is rejected without returning its value' {
        Write-Fixture $script:fixtureConfig.gatewayKeyFile 'PRIVATE_INVALID_KEY secret with whitespace'
        Expect-Failure { Get-RelayInputs } 'PRIVATE_INVALID_KEY'
    }

    Test-Case 'a plan binds executable, entry, configuration, CLI, manager and dedicated key hashes' {
        $baseline = (Get-RelayPlan (Get-RelayInputs) $null).PlanHash
        Assert-Test ($baseline -ceq (Get-RelayPlan (Get-RelayInputs) $null).PlanHash) 'A stable plan changed without file changes.'
        foreach ($path in @($NodeBinary, $EntryScript, $relayManagerPath, $script:fixtureConfig.cli.binary, $script:fixtureConfig.gatewayKeyFile)) {
            $original = [IO.File]::ReadAllText($path)
            Write-Fixture $path ($original + 'x')
            Assert-Test ($baseline -cne (Get-RelayPlan (Get-RelayInputs) $null).PlanHash) 'A changed reviewed file did not invalidate the plan.'
            Write-Fixture $path $original
        }
        $script:fixtureConfig.models[0].upstream = 'another-opus'; Save-Config
        Assert-Test ($baseline -cne (Get-RelayPlan (Get-RelayInputs) $null).PlanHash) 'A changed model mapping did not invalidate the plan.'
    }

    Test-Case 'an unowned populated control directory cannot be adopted' {
        Write-Fixture (Join-Path $relayLayout.State 'unrelated.txt') 'Unrelated fixture.'
        Expect-Failure { Get-RelayPlan (Get-RelayInputs) $null }
    }

    Test-Case 'control ownership and current identity participate in the reviewed plan' {
        $inputs = Get-RelayInputs
        $before = (Get-RelayPlan $inputs $null).PlanHash
        Write-Fixture $relayLayout.Manifest ((New-FixtureManifest) | ConvertTo-Json)
        $manifest = Read-RelayManifest
        $after = (Get-RelayPlan $inputs $manifest).PlanHash
        Assert-Test ($before -cne $after) 'Ownership changes did not invalidate the plan.'
        Set-FixtureOwner $inputs
        Write-Fixture $relayLayout.Identity ((New-FixtureIdentity $inputs) | ConvertTo-Json -Depth 10)
        Assert-Test ($after -cne (Get-RelayPlan $inputs $manifest).PlanHash) 'Process identity changes did not invalidate the plan.'
    }

    Test-Case 'another root and manager cannot supply a usable ownership record' {
        foreach ($field in @('Product', 'Root', 'ManagerId')) {
            $manifest = New-FixtureManifest; $manifest.$field = 'another-owner'
            Write-Fixture $relayLayout.Manifest ($manifest | ConvertTo-Json)
            Expect-Failure { Read-RelayManifest }
        }
        $manifest = New-FixtureManifest; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $identity = New-FixtureIdentity $inputs; $identity.ManagerId = ('c' * 32)
        Write-Fixture $relayLayout.Identity ($identity | ConvertTo-Json -Depth 10)
        Expect-Failure { Read-RelayIdentity $manifest }
    }

    Test-Case 'ISO process start identity remains an exact string on both PowerShell versions' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $identity = New-FixtureIdentity $inputs
        Write-Fixture $relayLayout.Identity ($identity | ConvertTo-Json -Depth 10)
        $loaded = Read-RelayIdentity (New-FixtureManifest)
        Assert-Test ($loaded.StartUtc -is [string] -and $loaded.StartUtc -ceq $identity.StartUtc) 'Process start identity was coerced into a date.'
    }

    Test-Case 'only the recorded executable, start time and exact command authorize ownership' {
        foreach ($change in @('none', 'pid-reuse', 'process-exe', 'cim-exe', 'extra-args', 'command', 'cim-failure')) {
            Reset-Fixture; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
            switch ($change) {
                'pid-reuse' { $script:fixtureOwner.StartTime = $script:fixtureStart.AddSeconds(1) }
                'process-exe' { $script:fixtureOwner.Path = 'C:\Unrelated\node.exe' }
                'cim-exe' { $script:fixtureMetadata.ExecutablePath = 'C:\Unrelated\node.exe' }
                'extra-args' { $script:fixtureMetadata.CommandLine += ' --extra'; $identity.CommandLine = $script:fixtureMetadata.CommandLine }
                'command' { $script:fixtureMetadata.CommandLine = 'unrelated-command' }
                'cim-failure' { $script:fixtureCimFails = $true }
            }
            if ($change -ceq 'none') { Assert-Test ($null -ne (Get-RelayOwnedProcess $identity $inputs)) 'A matching owned process was rejected.' }
            else { Expect-Failure { Get-RelayOwnedProcess $identity $inputs } 'PRIVATE_CIM_FAILURE' }
        }
    }

    Test-Case 'Windows startup trailing spaces and tabs are accepted only outside the final quote' {
        $inputs = Get-RelayInputs
        $command = '"' + $inputs.Node.Path + '" ' + (Get-RelayArguments $inputs)
        foreach ($tail in @(' ', "`t", " `t  `t")) {
            Assert-Test (Test-RelayCommand ($command + $tail) $inputs) 'Permitted external startup whitespace was rejected.'
        }
        $inside = '"' + $inputs.Node.Path + '" "' + $inputs.Entry.Path + '" "' + $inputs.Config.Path + ' "'
        $insideTab = '"' + $inputs.Node.Path + '" "' + $inputs.Entry.Path + '" "' + $inputs.Config.Path + "`t" + '"'
        foreach ($invalid in @($inside, $insideTab, ($command + ' --extra '), ($command + ' "extra"' + "`t"), ($command + "`n"))) {
            Assert-Test (-not (Test-RelayCommand $invalid $inputs)) 'Changed or additional command arguments were accepted.'
        }
        Set-FixtureOwner $inputs
        $script:fixtureMetadata.CommandLine += ' '
        $identity = New-FixtureIdentity $inputs
        $identity.CommandLine = $script:fixtureMetadata.CommandLine
        Assert-Test ($null -ne (Get-RelayOwnedProcess $identity $inputs)) 'A valid owned process with WinPS5 trailing whitespace was rejected.'
    }

    Test-Case 'changed files cannot authorize stopping even a matching PID' {
        foreach ($field in @('Node', 'Entry', 'Config', 'GatewayKey', 'CliBinary')) {
            $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
            $identity.$field = @{ Path = $inputs.$field.Path; SHA256 = ('0' * 64) }
            Expect-Failure { Stop-RelayOwned $identity $inputs }
            Assert-Test ($script:fixtureShutdownCalls -eq 0) 'An unconfirmed identity reached the shutdown pipe.'
        }
    }

    Test-Case 'graceful stop authenticates the owned PID pipe and waits without killing' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
        $stopped = Stop-RelayOwned $identity $inputs
        Assert-Test ($stopped -and $script:fixtureShutdownPid -eq 43210 -and $script:fixtureWait -eq 15000 -and
            $script:fixtureShutdownKeyPath -ceq $inputs.GatewayKey.Path) 'The owned relay was not stopped through its exact authenticated pipe.'
    }

    Test-Case 'a missing process does not send control or kill an unrelated PID' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
        $script:fixtureOwner = $null
        Assert-Test (-not (Stop-RelayOwned $identity $inputs) -and $script:fixtureShutdownCalls -eq 0) 'A missing PID caused an unsafe stop.'
    }

    Test-Case 'shutdown rejection or timeout fails without a hard-kill fallback' {
        foreach ($kind in @('rejected', 'timeout')) {
            Reset-Fixture; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
            if ($kind -ceq 'rejected') { $script:fixtureShutdownFails = $true } else { $script:fixtureWaitTimeout = $true }
            Expect-Failure { Stop-RelayOwned $identity $inputs }
        }
        $stopSource = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Stop-RelayOwned' }, $true))[0].Extent.Text
        Assert-Test ($stopSource -notmatch '(?i)Stop-Process|taskkill|\.Kill\(') 'Stop introduced a hard-kill fallback.'
    }

    Test-Case 'startup is hidden, keeps secrets out of arguments and restores the parent environment' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $names = @('ANTHROPIC_API_KEY', 'CODEX_HOME', 'NODE_OPTIONS', 'HTTP_PROXY')
        $original = @{}
        try {
            foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
            [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', 'PRIVATE_PARENT_KEY', 'Process')
            [Environment]::SetEnvironmentVariable('CODEX_HOME', 'C:\OriginalCodex', 'Process')
            [Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--require private-module', 'Process')
            [Environment]::SetEnvironmentVariable('HTTP_PROXY', 'http://127.0.0.1:12345', 'Process')
            $child = Start-RelayChild $inputs ('relay-' + ('d' * 32))
            Assert-Test ($script:fixtureStartCalls -eq 1 -and $script:fixtureStartOptions.WindowStyle -ceq 'Hidden') 'Startup did not use one hidden process.'
            Assert-Test ($script:fixtureStartOptions.ArgumentList -ceq (Get-RelayArguments $inputs) -and
                -not $script:fixtureStartOptions.ArgumentList.Contains($script:fixtureKey)) 'A secret was placed on the process command line.'
            foreach ($name in @('ANTHROPIC_API_KEY', 'CODEX_HOME', 'NODE_OPTIONS')) {
                Assert-Test (-not $script:fixtureChildEnvironment.ContainsKey($name)) ('The child inherited an excluded environment key: ' + $name)
            }
            Assert-Test ($script:fixtureChildEnvironment.HTTP_PROXY -ceq 'http://127.0.0.1:12345') 'The child lost its explicit proxy.'
            Assert-Test ([Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Process') -ceq 'PRIVATE_PARENT_KEY' -and
                [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process') -ceq '--require private-module') 'Startup changed the parent account environment.'
        } finally { foreach ($name in $original.Keys) {
            if ($null -eq $original[$name]) { [Environment]::SetEnvironmentVariable($name, [Management.Automation.Language.NullString]::Value, 'Process') }
            else { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
        } }
    }

    Test-Case 'readiness requires the current listener, models, boolean and exact process pipe' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
        foreach ($change in @('none', 'address', 'port', 'model', 'pipe', 'boolean')) {
            $event = [pscustomobject]@{ event = 'ready'; realInference = $false;
                listener = [pscustomobject]@{ address = $inputs.Address; port = $inputs.GatewayPort };
                configuredModels = @($inputs.ModelIds); controlPipe = '\\.\pipe\CodexAccountBridge-ClaudeRelay-43210' }
            switch ($change) {
                'address' { $event.listener.address = '127.0.0.1' }
                'port' { $event.listener.port++ }
                'model' { $event.configuredModels = @('unconfigured-model') }
                'pipe' { $event.controlPipe = '\\.\pipe\CodexAccountBridge-ClaudeRelay-43211' }
                'boolean' { $event.realInference = 'false' }
            }
            Write-Fixture (Join-Path $relayLayout.Logs ($identity.LogName + '.out.log')) ($event | ConvertTo-Json -Depth 8 -Compress)
            Assert-Test ((Get-RelayReady $identity $inputs) -eq ($change -ceq 'none')) 'Stale or malformed metadata became readiness.'
        }
    }

    Test-Case 'readiness can be read while the redirected output writer remains open' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
        $path = Join-Path $relayLayout.Logs ($identity.LogName + '.out.log')
        [void][IO.Directory]::CreateDirectory($relayLayout.Logs)
        $event = [ordered]@{ event = 'ready'; realInference = $false;
            listener = @{ address = $inputs.Address; port = $inputs.GatewayPort };
            configuredModels = @($inputs.ModelIds); controlPipe = '\\.\pipe\CodexAccountBridge-ClaudeRelay-43210' }
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $writer = New-Object IO.StreamWriter($stream, $relayUtf8)
        try {
            $writer.WriteLine(($event | ConvertTo-Json -Depth 8 -Compress)); $writer.Flush()
            Assert-Test (Get-RelayReady $identity $inputs) 'A live redirected writer prevented valid readiness from being recognized.'
            $writer.Write(('x' * 65536)); $writer.Flush()
            Assert-Test (-not (Get-RelayReady $identity $inputs)) 'A shared live log bypassed the readiness file size limit.'
        } finally { $writer.Dispose(); $stream.Dispose() }
    }

    Test-Case 'public running status never claims account authentication or includes a key' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs; $identity = New-FixtureIdentity $inputs
        $status = Get-RelayStatus $inputs $identity $script:fixtureOwner
        $public = $status | ConvertTo-Json -Depth 10 -Compress
        Assert-Test ($status.Running -and $status.ProcessOwned -and $null -eq $status.Authenticated -and -not $status.RealInference) 'Process readiness was confused with model authorization.'
        Assert-Test (-not $public.Contains($script:fixtureKey) -and -not $public.Contains('SHA256') -and
            -not $public.Contains('CommandLine')) 'Private process or gateway metadata escaped public status.'
    }

    Test-Case 'atomic identity writes stay within the private control directory' {
        [void][IO.Directory]::CreateDirectory($relayLayout.State)
        Write-RelayJson $relayLayout.Manifest (New-FixtureManifest)
        Assert-Test ($null -ne (Read-RelayManifest)) 'An ordinary private metadata write failed.'
        Expect-Failure { Write-RelayJson (Join-Path $Root 'unrelated.json') @{ value = 1 } }
    }

    Test-Case 'changed ownership documents cannot be overwritten by a stale operation' {
        [void][IO.Directory]::CreateDirectory($relayLayout.State)
        Write-RelayJson $relayLayout.Manifest (New-FixtureManifest)
        $expected = Get-RelayOptionalHash $relayLayout.Manifest
        $different = New-FixtureManifest; $different.ManagerId = ('d' * 32)
        Write-Fixture $relayLayout.Manifest ($different | ConvertTo-Json)
        Expect-Failure { Write-RelayJson $relayLayout.Manifest (New-FixtureManifest) $expected }
        Assert-Test ((Read-RelayManifest).ManagerId -ceq ('d' * 32)) 'An unrelated ownership change was overwritten.'
    }

    Test-Case 'current ownership hashes permit atomic replacement of existing records' {
        [void][IO.Directory]::CreateDirectory($relayLayout.State)
        $manifest = New-FixtureManifest
        Write-RelayJson $relayLayout.Manifest $manifest
        $manifestHash = Get-RelayOptionalHash $relayLayout.Manifest
        $replacement = New-FixtureManifest; $replacement.ManagerId = ('e' * 32)
        Write-RelayJson $relayLayout.Manifest $replacement $manifestHash
        Assert-Test ((Read-RelayManifest).ManagerId -ceq ('e' * 32)) 'An existing manifest was not atomically replaced.'
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $identity = New-FixtureIdentity $inputs; $identity.ManagerId = $replacement.ManagerId
        Write-RelayJson $relayLayout.Identity $identity
        $identityHash = Get-RelayOptionalHash $relayLayout.Identity
        $identity.Pid = 43211
        Write-RelayJson $relayLayout.Identity $identity $identityHash
        Assert-Test ((Read-RelayIdentity $replacement).Pid -eq 43211) 'An existing identity was not atomically replaced.'
        Assert-Test (@(Get-ChildItem -LiteralPath $relayLayout.State -Filter '*.tmp').Count -eq 0) 'Atomic replacement left a temporary file.'
    }

    Test-Case 'a newly held child can be recovered even while CIM metadata is unavailable' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
        $script:fixtureCimFails = $true
        Assert-Test (Stop-RelayNewChild $script:fixtureOwner $held $inputs) 'A CIM failure lost the newly held child.'
        Assert-Test ($script:fixtureShutdownCalls -eq 1 -and $script:fixtureShutdownPid -eq $held.Pid -and
            $script:fixtureWait -le 15000) 'Recovery did not use the owned pipe within its time budget.'
    }

    Test-Case 'a temporarily unavailable startup pipe is retried only for the newly held child' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
        $script:fixtureShutdownFailuresRemaining = 1
        Assert-Test (Stop-RelayNewChild $script:fixtureOwner $held $inputs 5000) 'A late startup pipe was not recovered.'
        Assert-Test ($script:fixtureShutdownCalls -eq 2 -and $script:fixtureWait -le 5000) 'Startup recovery used the wrong process or timeout.'
    }

    Test-Case 'startup cleanup rejects PID reuse, another executable and changed inputs' {
        foreach ($change in @('pid', 'start', 'exe', 'config')) {
            Reset-Fixture; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
            $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
            switch ($change) {
                'pid' { $held.Pid++ }
                'start' { $script:fixtureOwner.StartTime = $script:fixtureStart.AddSeconds(1) }
                'exe' { $script:fixtureOwner.Path = 'C:\Unrelated\node.exe' }
                'config' { Write-Fixture $ConfigPath '{"changed":"not the reviewed inputs"}' }
            }
            Assert-Test (-not (Stop-RelayNewChild $script:fixtureOwner $held $inputs 100)) 'Cleanup accepted another process or changed inputs.'
            Assert-Test ($script:fixtureShutdownCalls -eq 0) 'Unconfirmed cleanup reached a process control pipe.'
        }
    }

    Test-Case 'a failed cleanup keeps a durable visible pending start rather than enabling a duplicate' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
        Write-Fixture $relayLayout.Manifest ((New-FixtureManifest) | ConvertTo-Json)
        Write-RelayJson $relayLayout.Pending $held
        $script:fixtureWaitTimeout = $true
        Assert-Test (-not (Stop-RelayNewChild $script:fixtureOwner $held $inputs 100)) 'The fixture cleanup unexpectedly succeeded.'
        $plan = Get-RelayPlan $inputs (Read-RelayManifest)
        $status = Get-RelayStatus $inputs $null $null
        Assert-Test ($plan.StartPending -and $status.StartPending -and $status.PendingOwnedPid -eq $held.Pid) 'Pending ownership was lost after cleanup failed.'
        Assert-Test (Test-Path -LiteralPath $relayLayout.Pending -PathType Leaf) 'Failed cleanup removed its duplicate-start barrier.'
    }

    Test-Case 'pending cleanup removes only its exact current journal' {
        [void][IO.Directory]::CreateDirectory($relayLayout.State)
        Write-RelayJson $relayLayout.Pending @{ Product = $relayProduct; Root = $Root; Pid = 43210 }
        $original = Get-RelayOptionalHash $relayLayout.Pending
        Write-Fixture $relayLayout.Pending '{"changed":"outside the current operation"}'
        Expect-Failure { Clear-RelayPending $original }
        Assert-Test (Test-Path -LiteralPath $relayLayout.Pending) 'A changed pending record was deleted.'
        $current = Get-RelayOptionalHash $relayLayout.Pending
        Clear-RelayPending $current
        Assert-Test (-not (Test-Path -LiteralPath $relayLayout.Pending)) 'The exact current pending record was not cleared.'
    }

    Test-Case 'a failed start after identity publication clears only its stopped new child records' {
        $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
        $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
        $identity = New-FixtureIdentity $inputs
        [void][IO.Directory]::CreateDirectory($relayLayout.State)
        Write-RelayJson $relayLayout.Pending $held
        $pendingHash = Get-RelayOptionalHash $relayLayout.Pending
        $expected = [ordered]@{ Pid = $identity.Pid; ManagerId = $identity.ManagerId; StartUtc = $identity.StartUtc;
            SHA256 = (Get-RelayTextHash ($identity | ConvertTo-Json -Depth 12)); Committed = $false }
        $failed = $false
        try {
            Write-RelayJson $relayLayout.Identity $identity
            $expected.Committed = $true
            throw 'Fixture readiness failure after identity publication.'
        } catch {
            $failed = $true
            if (Stop-RelayNewChild $script:fixtureOwner $held $inputs) {
                Clear-RelayNewIdentity $expected
                Clear-RelayPending $pendingHash
            }
        }
        Assert-Test ($failed -and $script:fixtureShutdownCalls -eq 1 -and -not [IO.File]::Exists($relayLayout.Identity) -and
            -not [IO.File]::Exists($relayLayout.Pending)) 'Successful failed-start cleanup left a stale identity for PID reuse.'
    }

    Test-Case 'failed-start cleanup preserves old owners and mismatching child ownership' {
        foreach ($change in @('old-owner', 'pid', 'manager', 'start')) {
            Reset-Fixture; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
            $identity = New-FixtureIdentity $inputs
            [void][IO.Directory]::CreateDirectory($relayLayout.State)
            Write-RelayJson $relayLayout.Identity $identity
            $expected = [ordered]@{ Pid = $identity.Pid; ManagerId = $identity.ManagerId; StartUtc = $identity.StartUtc;
                SHA256 = (Get-RelayOptionalHash $relayLayout.Identity); Committed = $true }
            switch ($change) {
                'old-owner' { $expected.Pid++; $expected.SHA256 = ('0' * 64); $expected.Committed = $false }
                'pid' { $expected.Pid++ }
                'manager' { $expected.ManagerId = ('e' * 32) }
                'start' { $expected.StartUtc = $script:fixtureStart.AddSeconds(1).ToUniversalTime().ToString('o') }
            }
            Expect-Failure { Clear-RelayNewIdentity $expected }
            Assert-Test ([IO.File]::Exists($relayLayout.Identity) -and
                (Read-RelayJson $relayLayout.Identity).Pid -eq $identity.Pid) 'Cleanup removed an old or different child owner.'
        }
    }

    Test-Case 'identity CAS conflicts retain the changed record and diagnostic pending barrier' {
        foreach ($change in @('edited', 'deleted')) {
            Reset-Fixture; $inputs = Get-RelayInputs; Set-FixtureOwner $inputs
            $held = New-RelayHeldIdentity $script:fixtureOwner $inputs
            $identity = New-FixtureIdentity $inputs
            [void][IO.Directory]::CreateDirectory($relayLayout.State)
            Write-RelayJson $relayLayout.Pending $held
            $pendingHash = Get-RelayOptionalHash $relayLayout.Pending
            Write-RelayJson $relayLayout.Identity $identity
            $expected = [ordered]@{ Pid = $identity.Pid; ManagerId = $identity.ManagerId; StartUtc = $identity.StartUtc;
                SHA256 = (Get-RelayOptionalHash $relayLayout.Identity); Committed = $true }
            if ($change -ceq 'edited') {
                $identity.LogName = ('relay-' + ('f' * 32))
                Write-Fixture $relayLayout.Identity ($identity | ConvertTo-Json -Depth 12)
            } else { Remove-Item -LiteralPath $relayLayout.Identity -Force }
            $conflict = $false
            if (Stop-RelayNewChild $script:fixtureOwner $held $inputs) {
                try { Clear-RelayNewIdentity $expected; Clear-RelayPending $pendingHash } catch { $conflict = $true }
            }
            Assert-Test ($conflict -and [IO.File]::Exists($relayLayout.Pending)) 'An identity conflict lost its diagnostic barrier.'
            if ($change -ceq 'edited') {
                Assert-Test ((Read-RelayJson $relayLayout.Identity).LogName -ceq ('relay-' + ('f' * 32))) 'A concurrent identity edit was removed.'
            }
        }
    }

    Write-Output ('Claude relay process offline tests: ' + $script:passed + ' passed.')
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
