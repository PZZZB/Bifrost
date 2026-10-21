[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\OfficialClaudeCli.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Official Claude CLI deployment does not parse.' }
foreach ($name in @('Read-OfficialRelease', 'Assert-OfficialBinary', 'Ensure-OfficialBinary', 'Get-OfficialTextHash', 'Get-OfficialEnvironment',
    'Get-OfficialEnvironmentHash', 'Get-OfficialAccountStatus', 'Get-OfficialLoginProcess', 'Stop-OfficialLogin')) {
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definition.Count -ne 1) { throw 'The offline fixture cannot locate one expected CLI function.' }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}

$script:passed = 0
$taskProduct = 'CodexAccountBridge.OfficialClaudeCli'
$taskVersion = '2.1.304'; $Platform = 'win32-x64'
$taskBaseUrl = 'https://downloads.claude.ai/claude-code-releases'
$taskLayout = @{ Root = 'D:\OfflineClaudeFixture'; Bin = 'D:\OfflineClaudeFixture\bin';
    Binary = 'D:\OfflineClaudeFixture\bin\claude.exe'; Data = 'D:\OfflineClaudeFixture\data';
    Profile = 'D:\OfflineClaudeFixture\data\profile'; ConfigDirectory = 'D:\OfflineClaudeFixture\data\profile\.claude';
    Logs = 'D:\OfflineClaudeFixture\data\logs' }
$script:fixtureChecksum = ('A' * 64)
$script:fixtureStart = [datetime]'2026-01-02T03:04:05.0000000Z'
$taskManifest = [pscustomobject]@{ Checksum = $script:fixtureChecksum }

function Assert-Test([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Test-Case([string]$Name, [scriptblock]$Body) { & $Body; $script:passed++; Write-Output "PASS $Name" }
function Expect-Failure([scriptblock]$Body) {
    $failed = $false
    try { & $Body | Out-Null } catch { $failed = $true }
    Assert-Test $failed 'An invalid official CLI operation was accepted.'
}

function New-ManifestDocument {
    return [pscustomobject]@{ version = $taskVersion; platforms = [pscustomobject]@{
        'win32-x64' = [pscustomobject]@{ binary = 'claude.exe'; checksum = $script:fixtureChecksum; size = 123456L }
    } }
}

function New-Metadata {
    return [pscustomobject]@{ loggedIn = $true; authMethod = 'claude.ai'; configDirectory = $taskLayout.ConfigDirectory }
}

function New-Owner {
    $owner = [pscustomobject]@{ Id = 4242; Path = $taskLayout.Binary; StartTime = $script:fixtureStart;
        Handle = 'offline-handle'; Killed = $false; HasExited = $false }
    $owner | Add-Member ScriptMethod Kill { $this.Killed = $true; $this.HasExited = $true }
    $owner | Add-Member ScriptMethod WaitForExit { param($Timeout) return $this.HasExited }
    return $owner
}

function New-LoginIdentity {
    return [pscustomobject]@{ Product = $taskProduct; SchemaVersion = 1; Root = $taskLayout.Root; Pid = 4242;
        StartUtc = $script:fixtureStart.ToUniversalTime().ToString('o'); Executable = $taskLayout.Binary;
        ClaudeCodeVersion = $taskVersion; Checksum = $script:fixtureChecksum;
        EnvironmentHash = (Get-OfficialEnvironmentHash @{}); Interactive = $true }
}

function Reset-Case {
    $script:fixtureMetadata = New-Metadata
    $script:fixtureOwner = New-Owner
    $script:fixtureCommandFails = $false
    $script:fixtureStatusTimesOut = $false
    $script:fixtureStatusExitCode = 0
    $script:fixtureProcessCalls = 0
    $script:fixtureOwnerReads = 0
    $script:fixtureBinaryHash = $script:fixtureChecksum
    $script:fixtureBinaryLength = 123456L
    $script:fixtureStatusChild = $null
}

function Get-OfficialJson([string]$Path) {
    Assert-Test ($Path.StartsWith($taskLayout.Logs + '\', [StringComparison]::OrdinalIgnoreCase) -and $Path.EndsWith('.out.log')) 'The status fixture attempted to read a credential or unexpected file.'
    return $script:fixtureMetadata
}

function Start-OfficialProcess([string[]]$Arguments, [string]$LogName, $Environment) {
    Assert-Test (($Arguments -join ' ') -ceq 'auth status --json') 'The fixture tried a login or inference command.'
    $script:fixtureProcessCalls++
    if ($script:fixtureCommandFails) { throw 'PRIVATE_AUTH_FAILURE must not escape.' }
    $child = [pscustomobject]@{ ExitCode = $script:fixtureStatusExitCode; HasExited = (-not $script:fixtureStatusTimesOut); Killed = $false }
    $child | Add-Member ScriptMethod WaitForExit { param($Timeout) return (-not $script:fixtureStatusTimesOut) }
    $child | Add-Member ScriptMethod Refresh { }
    $child | Add-Member ScriptMethod Kill { $this.Killed = $true; $this.HasExited = $true }
    $script:fixtureStatusChild = $child
    return $child
}

function Get-OfficialHash([string]$Path) { return $script:fixtureBinaryHash }
function Assert-OfficialPath([string]$Path) {
    Assert-Test ($Path.StartsWith($taskLayout.Root + '\', [StringComparison]::OrdinalIgnoreCase)) 'The fixture accessed a different runtime root.'
    return $Path
}
function Get-Item([string]$LiteralPath) { return [pscustomobject]@{ Length = $script:fixtureBinaryLength } }
function Get-Process([int]$Id, [string]$ErrorAction) {
    $script:fixtureOwnerReads++
    if ($null -ne $script:fixtureOwner -and $script:fixtureOwner.Id -eq $Id) { return $script:fixtureOwner }
    return $null
}
function Start-Process { throw 'Real processes are forbidden in this offline fixture.' }
function Stop-Process { throw 'Real processes are forbidden in this offline fixture.' }
function Remove-Item { throw 'Real file deletion is forbidden in this offline fixture.' }
function Invoke-WebRequest { throw 'Network access is forbidden in this offline fixture.' }
function Invoke-RestMethod { throw 'Network access is forbidden in this offline fixture.' }

Test-Case 'official release metadata constructs only the pinned vendor download' {
    Reset-Case
    $release = Read-OfficialRelease (New-ManifestDocument)
    Assert-Test ($release.ClaudeCodeVersion -ceq '2.1.304' -and $release.Platform -ceq 'win32-x64' -and
        $release.BinaryUrl -ceq 'https://downloads.claude.ai/claude-code-releases/2.1.304/win32-x64/claude.exe') 'The release escaped the fixed official download.'
    Assert-Test ($release.Checksum -ceq $script:fixtureChecksum -and $release.Size -eq 123456) 'The manifest verification fields changed.'
}

Test-Case 'untrusted manifest fields cannot select another file or unverified executable' {
    foreach ($change in @('missing-platform', 'checksum', 'path', 'zero-size', 'large-size', 'version')) {
        Reset-Case
        $document = New-ManifestDocument
        switch ($change) {
            'missing-platform' { $document.platforms = [pscustomobject]@{} }
            'checksum' { $document.platforms.'win32-x64'.checksum = 'not-a-checksum' }
            'path' { $document.platforms.'win32-x64'.binary = '..\other.exe' }
            'zero-size' { $document.platforms.'win32-x64'.size = 0 }
            'large-size' { $document.platforms.'win32-x64'.size = 2L * 1024 * 1024 * 1024 }
            'version' { $document.version = '2.1.305' }
        }
        Expect-Failure { Read-OfficialRelease $document }
    }
}

Test-Case 'checksum and length must both match before a binary is accepted' {
    Reset-Case
    $release = Read-OfficialRelease (New-ManifestDocument)
    Assert-OfficialBinary $taskLayout.Binary $release
    $script:fixtureBinaryHash = ('B' * 64)
    Expect-Failure { Assert-OfficialBinary $taskLayout.Binary $release }
    $script:fixtureBinaryHash = $script:fixtureChecksum
    $script:fixtureBinaryLength = 123455L
    Expect-Failure { Assert-OfficialBinary $taskLayout.Binary $release }
}

Test-Case 'child configuration stays private without changing the parent account environment' {
    Reset-Case
    $originalProfile = [Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
    $originalKey = [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Process')
    $environment = Get-OfficialEnvironment
    Assert-Test ($environment.CLAUDE_CONFIG_DIR -ceq $taskLayout.ConfigDirectory -and
        $environment.USERPROFILE -ceq $taskLayout.Profile -and $environment.CODEX_HOME -ceq 'D:\OfflineClaudeFixture\data\empty-codex') 'The child account directories are not isolated.'
    Assert-Test ($null -eq $environment.ANTHROPIC_API_KEY -and $null -eq $environment.ANTHROPIC_AUTH_TOKEN -and
        $null -eq $environment.CLAUDE_CODE_OAUTH_TOKEN -and $null -eq $environment.ANTHROPIC_BASE_URL) 'Inherited API authorization was retained.'
    Assert-Test ([Environment]::GetEnvironmentVariable('USERPROFILE', 'Process') -ceq $originalProfile -and
        [Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'Process') -ceq $originalKey) 'Building a child environment modified the parent.'
}

Test-Case 'a subscription in the private directory is recognized through metadata only' {
    Reset-Case
    $result = Get-OfficialAccountStatus @{}
    Assert-Test ($result.AccountChecked -and $result.AuthMethodKnown -and $result.ConfigDirectoryMatches -and
        $result.SubscriptionAuthenticated -and $script:fixtureProcessCalls -eq 1) 'A private subscription was not recognized.'
}

Test-Case 'unknown and API-key sources never count as subscription access' {
    foreach ($method in @('api_key', 'future-source', '', $null)) {
        Reset-Case
        $script:fixtureMetadata.authMethod = $method
        $result = Get-OfficialAccountStatus @{}
        Assert-Test ($result.AccountChecked -and -not $result.AuthMethodKnown -and
            -not $result.SubscriptionAuthenticated) 'An unrecognized account source became subscription access.'
    }
}

Test-Case 'another profile or a missing directory cannot authenticate this deployment' {
    foreach ($directory in @('C:\OriginalProfile\.claude', 'D:\OfflineClaudeFixture\data\profile\.claude-other', '.claude', $null)) {
        Reset-Case
        $script:fixtureMetadata.configDirectory = $directory
        $result = Get-OfficialAccountStatus @{}
        Assert-Test (-not $result.ConfigDirectoryMatches -and -not $result.SubscriptionAuthenticated) 'A different account directory was accepted.'
    }
}

Test-Case 'logged-out and malformed status fields remain unauthenticated' {
    foreach ($loggedIn in @($false, 'true', 1, $null)) {
        Reset-Case
        $script:fixtureMetadata.loggedIn = $loggedIn
        $result = Get-OfficialAccountStatus @{}
        Assert-Test (-not $result.SubscriptionAuthenticated -and $result.AccountChecked -eq ($loggedIn -is [bool])) 'An unconfirmed login was accepted.'
    }
}

Test-Case 'failed or timed-out metadata returns unknown without exposing private output' {
    foreach ($failure in @('exception', 'exit-code', 'timeout')) {
        Reset-Case
        if ($failure -ceq 'exception') { $script:fixtureCommandFails = $true }
        if ($failure -ceq 'exit-code') { $script:fixtureStatusExitCode = 2 }
        if ($failure -ceq 'timeout') { $script:fixtureStatusTimesOut = $true }
        $result = Get-OfficialAccountStatus @{}
        Assert-Test (-not $result.AccountChecked -and -not $result.SubscriptionAuthenticated) 'Failed metadata became a confirmed account.'
        Assert-Test (($result | ConvertTo-Json -Compress) -notmatch 'PRIVATE_AUTH_FAILURE') 'Private failure output escaped.'
        if ($failure -ceq 'timeout') { Assert-Test $script:fixtureStatusChild.Killed 'A timed-out metadata child was not stopped.' }
    }
}

Test-Case 'Stop ends only the login belonging to this verified private executable' {
    Reset-Case
    $identity = New-LoginIdentity
    $stopped = Stop-OfficialLogin $identity @{}
    Assert-Test ($stopped -and $script:fixtureOwner.Killed) 'The verified private login was not stopped.'
}

Test-Case 'other roots, hashes and environments never authorize stopping a process' {
    foreach ($change in @('root', 'checksum', 'environment', 'version', 'interactive')) {
        Reset-Case
        $identity = New-LoginIdentity
        switch ($change) {
            'root' { $identity.Root = 'D:\AnotherDeployment' }
            'checksum' { $identity.Checksum = ('B' * 64) }
            'environment' { $identity.EnvironmentHash = 'different-environment' }
            'version' { $identity.ClaudeCodeVersion = '2.1.305' }
            'interactive' { $identity.Interactive = $false }
        }
        Expect-Failure { Stop-OfficialLogin $identity @{} }
        Assert-Test (-not $script:fixtureOwner.Killed) 'An unrelated login process was stopped.'
    }
}

Test-Case 'PID reuse and another executable cannot be stopped through a stale identity' {
    foreach ($change in @('start-time', 'executable')) {
        Reset-Case
        $identity = New-LoginIdentity
        if ($change -ceq 'start-time') { $script:fixtureOwner.StartTime = $script:fixtureStart.AddSeconds(1) }
        else { $script:fixtureOwner.Path = 'D:\OtherApplication\claude.exe' }
        Expect-Failure { Stop-OfficialLogin $identity @{} }
        Assert-Test (-not $script:fixtureOwner.Killed) 'A reused PID or different executable was stopped.'
    }
}

Test-Case 'an exited or absent login needs no process termination or credential cleanup' {
    Reset-Case
    $identity = New-LoginIdentity
    $script:fixtureOwner = $null
    Assert-Test (-not (Stop-OfficialLogin $identity @{})) 'An exited login was reported as newly stopped.'
    Assert-Test (-not (Stop-OfficialLogin $null @{})) 'An absent login was reported as newly stopped.'
}

Test-Case 'real metadata creation and replacement both preserve the new JSON on this shell' {
    & {
        $fixtureRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('..\.state\official-cli-json-test-'+[guid]::NewGuid().ToString('N'))))
        $taskLayout=@{Root=$fixtureRoot};$taskUtf8=New-Object Text.UTF8Encoding($false)
        $metadata=Join-Path $fixtureRoot 'metadata.json'
        [void][IO.Directory]::CreateDirectory($fixtureRoot)
        foreach($name in @('Assert-OfficialPath','Write-OfficialJson')){
            $definition=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
            . ([scriptblock]::Create($definition.Extent.Text))
        }
        function Get-Item([string]$LiteralPath,[switch]$Force) {return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force}
        function Remove-Item([string]$LiteralPath,[switch]$Force) {
            if(-not $LiteralPath.StartsWith($fixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Atomic fixture cleanup escaped its private test root.'}
            Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force
        }
        try {
            Write-OfficialJson $metadata @{Phase='preparing';Value=1}
            Write-OfficialJson $metadata @{Phase='prepared';Value=2}
            $result=[IO.File]::ReadAllText($metadata)|ConvertFrom-Json
            Assert-Test ($result.Phase -ceq 'prepared' -and $result.Value -eq 2) 'Atomic replacement kept stale metadata.'
            Assert-Test (@(Get-ChildItem -LiteralPath $fixtureRoot -Force).Count -eq 1) 'Atomic replacement left a temporary file.'
        } finally {
            if([IO.File]::Exists($metadata)){[IO.File]::Delete($metadata)}
            foreach($temporary in Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.tmp' -File){[IO.File]::Delete($temporary.FullName)}
            [IO.Directory]::Delete($fixtureRoot)
        }
    }
}

Test-Case 'verified recovery reuses an existing binary and rejects changed bytes before network access' {
    & {
        function Test-Path([string]$LiteralPath) {
            Assert-Test ($LiteralPath -ceq $taskLayout.Binary) 'Recovery accessed an unexpected temporary path.'
            return $true
        }
        Reset-Case
        $release=Read-OfficialRelease (New-ManifestDocument)
        Assert-Test (Ensure-OfficialBinary $release) 'An already verified binary was downloaded again.'
        $script:fixtureBinaryHash=('C'*64)
        Expect-Failure {Ensure-OfficialBinary $release}
    }
}

Test-Case 'only a missing binary reaches the official downloader' {
    & {
        $script:downloadAttempted=$false
        function Test-Path([string]$LiteralPath) {return $false}
        function Invoke-WebRequest {
            $script:downloadAttempted=$true
            throw 'OFFLINE_DOWNLOAD_STUB'
        }
        Reset-Case
        Expect-Failure {Ensure-OfficialBinary (Read-OfficialRelease (New-ManifestDocument))}
        Assert-Test $script:downloadAttempted 'A missing binary did not reach the official downloader.'
    }
}

[pscustomobject]@{ Passed = $script:passed; Shell = $PSVersionTable.PSVersion.ToString();
    RuntimeTouched = $false; NetworkAccess = $false; RealProcessesStarted = $false; RealInference = $false } | ConvertTo-Json
