[CmdletBinding()]
param(
    [string]$StateDir = (Join-Path $env:USERPROFILE '.codex-account-bridge'),
    [string]$VmStateDir = (Join-Path $PSScriptRoot '..\.state\with-vm')
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$configPath = Join-Path $StateDir 'with.json'
$keyPath = Join-Path $VmStateDir 'gateway.key'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Private-Path([string]$Path, [switch]$Directory) {
    $rights = if ($Directory) { '(OI)(CI)F' } else { 'F' }
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    & icacls.exe $Path /inheritance:r /grant:r "*${sid}:$rights" "*S-1-5-18:$rights" "*S-1-5-32-544:$rights" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect With gateway configuration.' }
    foreach ($rule in @((Get-Acl -LiteralPath $Path).Access)) {
        $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($ruleSid -notin $allowed -or $rule.AccessControlType -eq 'Deny') {
            $remove = if ($rule.AccessControlType -eq 'Deny') { '/remove:d' } else { '/remove:g' }
            & icacls.exe $Path $remove "*$ruleSid" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not remove an unrelated gateway access rule.' }
        }
    }
}
function New-Key {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

[IO.Directory]::CreateDirectory($StateDir) | Out-Null
[IO.Directory]::CreateDirectory($VmStateDir) | Out-Null
Private-Path $VmStateDir -Directory
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else {
    [pscustomobject]@{ version = 1; enabled = $false; vmConfigured = $false; gatewayKey = (New-Key); mcpKey = (New-Key) }
}
if ($config.version -ne 1 -or $config.gatewayKey -notmatch '^[A-Za-z0-9_-]{43}$' -or
    $config.mcpKey -notmatch '^[A-Za-z0-9_-]{43}$' -or $config.gatewayKey -ceq $config.mcpKey) { throw 'Invalid existing With gateway configuration.' }
$config.enabled = $true
$temporary = "$configPath.$([guid]::NewGuid().ToString('N')).tmp"
try {
    [IO.File]::WriteAllText($temporary, '', $utf8)
    Private-Path $temporary
    [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Depth 10), $utf8)
    Move-Item -LiteralPath $temporary -Destination $configPath -Force
    if (-not (Test-Path -LiteralPath $keyPath)) { [IO.File]::WriteAllText($keyPath, '', $utf8) }
    Private-Path $keyPath
    [IO.File]::WriteAllText($keyPath, $config.gatewayKey, $utf8)
} finally {
    $config = $null
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
[pscustomobject]@{ Prepared = $true; Configuration = $configPath; GatewayKeyFile = [IO.Path]::GetFullPath($keyPath)
    Gateway = 'http://192.168.168.1:43157'; Model = 'claude-opus-5-5'; RealInference = $false } | ConvertTo-Json
