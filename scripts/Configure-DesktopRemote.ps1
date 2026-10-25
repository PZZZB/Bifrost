$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktopUrl = Read-Host 'Mac Bifrost API URL (https://.../v1)'
$desktopProtectedKey = Read-Host 'Your Bifrost user API Key (bfk_...)' -AsSecureString
$desktopPointer = [IntPtr]::Zero
try {
    $desktopPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($desktopProtectedKey)
    $desktopPlainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($desktopPointer)
    $desktopPlainKey | & node (Join-Path $projectRoot 'scripts/desktop.mjs') remote --url $desktopUrl --key-stdin
    if ($LASTEXITCODE -ne 0) { throw 'Remote setup failed. Existing gateway must be stopped first.' }
} finally {
    if ($desktopPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($desktopPointer) }
    $desktopPlainKey = $null
    if ($desktopProtectedKey) { $desktopProtectedKey.Dispose() }
}
