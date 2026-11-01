param([string]$Url, [string]$Source = 'bifrost')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Url) { $Url = Read-Host 'Mac Bifrost API URL (https://.../v1)' }
$remoteProtectedKey = Read-Host 'Your personal Bifrost user API Key (bfk_...)' -AsSecureString
$remotePointer = [IntPtr]::Zero
try {
    $remotePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($remoteProtectedKey)
    $remotePlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($remotePointer)
    $remotePlainKey | & node (Join-Path $projectRoot 'scripts/server-remote.mjs') --url $Url --source $Source --key-stdin
    if ($LASTEXITCODE -ne 0) { throw 'Remote setup failed. Existing configuration was not replaced.' }
} finally {
    if ($remotePointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($remotePointer) }
    $remotePlainKey = $null
    if ($remoteProtectedKey) { $remoteProtectedKey.Dispose() }
}
