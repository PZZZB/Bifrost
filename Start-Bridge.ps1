param([switch]$Open, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$stateDirectory = if ($env:BRIDGE_STATE_DIR) { [IO.Path]::GetFullPath($env:BRIDGE_STATE_DIR) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex-account-bridge' }
$serviceArguments = @{ Action = 'Start'; ProjectDirectory = $projectDirectory; StateDirectory = $stateDirectory }
if ($Restart) { $serviceArguments.Action = 'Restart' }
if ($env:BRIDGE_PORT) { $serviceArguments.Port = [int]$env:BRIDGE_PORT }
if ($env:BRIDGE_CLIENT_CODEX_HOME) { $serviceArguments.CodexHome = $env:BRIDGE_CLIENT_CODEX_HOME }
elseif ($env:CODEX_HOME) { $serviceArguments.CodexHome = $env:CODEX_HOME }

# Reuse installed runtimes and the recorded task name across product renames.
$serviceConfigPath = Join-Path $stateDirectory 'service\service.json'
if (Test-Path -LiteralPath $serviceConfigPath -PathType Leaf) {
    $installedService = Get-Content -LiteralPath $serviceConfigPath -Raw | ConvertFrom-Json
    $serviceArguments.TaskName = [string]$installedService.TaskName
} else {
    $serviceArguments.NodeBinary = (Get-Command node -ErrorAction Stop).Source
    $runtimeRoot = Join-Path $projectDirectory '.state\runtime\codex'
    $manifestPath = Join-Path $runtimeRoot 'runtime.json'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $runtime = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $absoluteRuntime = [IO.Path]::GetFullPath([string]$runtime.Path)
        if ($runtime.Product -cne 'AgentBridge.CodexRuntime' -or $runtime.SHA256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or
            -not $absoluteRuntime.StartsWith(([IO.Path]::GetFullPath($runtimeRoot) + '\'), [StringComparison]::OrdinalIgnoreCase) -or
            (Get-FileHash -LiteralPath $absoluteRuntime -Algorithm SHA256).Hash -cne $runtime.SHA256) {
            throw 'The independent Codex runtime changed. Check .state/runtime/codex/runtime.json.'
        }
        $serviceArguments.CodexBinary = $absoluteRuntime
    } else {
        $sourceBinary = $null
        if ($env:CODEX_BINARY -and [IO.Path]::GetExtension($env:CODEX_BINARY) -ieq '.exe' -and (Test-Path -LiteralPath $env:CODEX_BINARY -PathType Leaf)) {
            $sourceBinary = (Resolve-Path -LiteralPath $env:CODEX_BINARY).ProviderPath
        } else {
            $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
            if ($codexCommand -and [IO.Path]::GetExtension($codexCommand.Source) -ieq '.exe') { $sourceBinary = $codexCommand.Source }
            if (-not $sourceBinary) {
                $candidates = @()
                if ($codexCommand) {
                    $npmDirectory = Split-Path -Parent $codexCommand.Source
                    $candidates += @(Get-ChildItem -Path (Join-Path $npmDirectory 'node_modules\@openai\codex*\vendor\*\codex\codex.exe') -File -ErrorAction SilentlyContinue)
                }
                $candidates += @(Get-ChildItem -Path "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe" -File -ErrorAction SilentlyContinue)
                $candidate = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
                if ($candidate) { $sourceBinary = $candidate.FullName }
            }
        }
        if (-not $sourceBinary) { throw 'Cannot find the native official Codex CLI. Install it or set CODEX_BINARY to codex.exe.' }
        $sourceHash = (Get-FileHash -LiteralPath $sourceBinary -Algorithm SHA256).Hash
        $destinationDirectory = Join-Path $runtimeRoot $sourceHash.ToLowerInvariant()
        [void][IO.Directory]::CreateDirectory($destinationDirectory)
        $destination = Join-Path $destinationDirectory 'codex.exe'
        if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $sourceBinary -Destination $destination }
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne $sourceHash -or
            (Get-FileHash -LiteralPath $sourceBinary -Algorithm SHA256).Hash -cne $sourceHash) { throw 'The independent Codex runtime failed verification.' }
        $runtime = [ordered]@{ Product = 'AgentBridge.CodexRuntime'; Path = $destination; Source = $sourceBinary; SHA256 = $sourceHash; ContainsCredentials = $false }
        [IO.File]::WriteAllText($manifestPath, ($runtime | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
        $serviceArguments.CodexBinary = $destination
    }
}

$status = & (Join-Path $projectDirectory 'scripts\AgentBridgeService.ps1') @serviceArguments
if (-not $status -or -not $status.Ready) { throw 'Bifrost did not become ready. Check .state/server-error.log.' }
Write-Output ('Bifrost: ' + $status.ManagementUrl)
if ($Open) { Start-Process $status.ManagementUrl }
