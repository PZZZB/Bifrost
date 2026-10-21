[CmdletBinding()]
param(
    [ValidateSet('Plan','Prepare','Start','Status','Stop','Restore')][string]$Action='Plan',
    [string]$VmInvoker='C:\Users\jiahaoguo\Documents\Codex\2026-09-30\vps-https-www-voyracloud-com-zh\work\vm-build\Invoke-WorkspaceVm.ps1',
    [string]$GuestHome='C:\Users\Developer',
    [string]$SourceDirectory=(Join-Path $PSScriptRoot '..'),
    [string]$NodeBinary=(Get-Command node -ErrorAction Stop).Source,
    [string]$GuestScript=(Join-Path $PSScriptRoot 'ClaudeRelayVmGuest.ps1'),
    [string]$StateDir=(Join-Path $PSScriptRoot '..\.state\claude-relay-vm'),
    [string]$GatewayAddress='192.168.168.10',
    [string]$AllowedPeer='192.168.168.1',
    [int]$GatewayPort=3435,
    [int]$McpPort=3436,
    [string]$PlanHash
)
$ErrorActionPreference='Stop'
$relayProduct='CodexAccountBridge.OfficialClaudeRelayVm'
$relayUtf8=New-Object Text.UTF8Encoding($false)

function Get-RelayHash([string]$Path) {return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash}
function Get-RelayTextHash([string]$Text) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','')}finally{$sha.Dispose()}
}
function Assert-RelayLocalPath([string]$Path) {
    if ($Path -cnotmatch '^[A-Za-z]:[\\/]' -or $Path.StartsWith('\\') -or $Path -match '[\x00-\x1f\x7f"]' -or $Path.Trim() -cne $Path) {throw 'Relay deployment paths must be absolute and local.'}
    $absolute=[IO.Path]::GetFullPath($Path);$cursor=$absolute
    if($absolute.Substring([IO.Path]::GetPathRoot($absolute).Length).Contains(':')){throw 'Relay deployment paths cannot use alternate data streams.'}
    while($cursor){if(Test-Path -LiteralPath $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Relay deployment paths cannot cross reparse points.'}};$cursor=[IO.Path]::GetDirectoryName($cursor)}
    return $absolute
}
function Set-RelayPrivateDirectory([string]$Path) {
    $null=Assert-RelayLocalPath $Path
    $directory=[IO.Directory]::CreateDirectory($Path)
    $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
        [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    }
    if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl($directory,$acl)}else{$directory.SetAccessControl($acl)}
}
function Set-RelayPrivateFile([string]$Path) {
    $null=Assert-RelayLocalPath $Path
    $acl=New-Object Security.AccessControl.FileSecurity;$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
        [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow')))
    }
    $file=New-Object IO.FileInfo($Path)
    if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl)}else{$file.SetAccessControl($acl)}
}
function Get-RelayLockedSdk([string]$Path) {
    $text=[IO.File]::ReadAllText($Path)
    if([Text.Encoding]::UTF8.GetByteCount($text) -gt 16MB){throw 'The public dependency lock file exceeded its size limit.'}
    if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('AsHashtable')){$document=ConvertFrom-Json -InputObject $text -AsHashtable}
    else{Add-Type -AssemblyName System.Web.Extensions;$serializer=New-Object Web.Script.Serialization.JavaScriptSerializer;$serializer.MaxJsonLength=16MB;$document=$serializer.DeserializeObject($text)}
    $value=$document['packages']['node_modules/@anthropic-ai/claude-agent-sdk']
    return [pscustomobject]@{version=$value['version'];resolved=$value['resolved'];integrity=$value['integrity']}
}
function Get-RelayPackage([string]$Directory,[string]$NodePath) {
    $directory=Assert-RelayLocalPath $Directory;$nodePath=Assert-RelayLocalPath $NodePath
    $files=New-Object Collections.Generic.List[object]
    $required=@('scripts/run-claude-relay.mjs','src/claude-cli-provider.mjs','src/claude-sdk-worker.mjs','src/relay-control.mjs','src/anthropic-gateway.mjs','src/gateway.mjs','src/storage.mjs','src/models.mjs','package.json','package-lock.json')
    foreach($relative in $required){$path=Assert-RelayLocalPath (Join-Path $directory $relative);if(-not [IO.File]::Exists($path)){throw 'A required relay source file is missing.'};$files.Add([ordered]@{Path=('app/'+$relative);HostPath=$path;SHA256=(Get-RelayHash $path);Size=([IO.FileInfo]$path).Length})}
    $modules=Assert-RelayLocalPath (Join-Path $directory 'node_modules')
    $pending=New-Object Collections.Generic.Stack[string];$pending.Push($modules)
    while($pending.Count){foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The dependency package cannot contain redirected files.'}
        if($item.PSIsContainer){$pending.Push($item.FullName)}else{
            $relative=$item.FullName.Substring($directory.TrimEnd('\').Length+1).Replace('\','/')
            $files.Add([ordered]@{Path=('app/'+$relative);HostPath=$item.FullName;SHA256=(Get-RelayHash $item.FullName);Size=$item.Length})
        }
    }}
    $sdk=Get-Content -LiteralPath (Join-Path $modules '@anthropic-ai\claude-agent-sdk\package.json') -Raw|ConvertFrom-Json
    $locked=Get-RelayLockedSdk (Join-Path $directory 'package-lock.json')
    if($sdk.name -cne '@anthropic-ai/claude-agent-sdk' -or $sdk.version -cne '0.3.304' -or $locked.version -cne $sdk.version -or
        $locked.resolved -cne 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.304.tgz' -or
        $locked.integrity -cne 'sha512-Ivkt7/UAkATibzvqT31eY71lAp7YdPzfbKDpmbHN9+AQWFh/Ac6tYkL2J1sipJ7tU4IK48w0YxuRW9aI//veFA=='){throw 'The relay needs the pinned official Agent SDK dependency.'}
    $manager=Assert-RelayLocalPath (Join-Path $directory 'scripts\ClaudeRelay.ps1')
    if(-not [IO.File]::Exists($manager) -or -not [IO.File]::Exists($nodePath)){throw 'The relay manager and Node executable must exist.'}
    $files.Add([ordered]@{Path='tools/ClaudeRelay.ps1';HostPath=$manager;SHA256=(Get-RelayHash $manager);Size=([IO.FileInfo]$manager).Length})
    $files.Add([ordered]@{Path='bin/node.exe';HostPath=$nodePath;SHA256=(Get-RelayHash $nodePath);Size=([IO.FileInfo]$nodePath).Length})
    $sorted=New-Object 'Collections.Generic.SortedDictionary[string,object]' ([StringComparer]::Ordinal)
    foreach($file in $files){$sorted.Add([string]$file.Path,$file)}
    $ordered=@($sorted.Values);$public=@($ordered|ForEach-Object{[ordered]@{Path=$_.Path;SHA256=$_.SHA256;Size=$_.Size}})
    $bytes=0L;foreach($file in $ordered){$bytes+=[long]$file.Size}
    if($ordered.Count -gt 50000 -or $bytes -gt 2GB){throw 'The reviewed relay dependency bundle exceeded its size limit.'}
    return [ordered]@{Files=$ordered;Manifest=$public;BundleHash=(Get-RelayTextHash ($public|ConvertTo-Json -Depth 5 -Compress));
        FileCount=$ordered.Count;TotalBytes=$bytes;SdkVersion=$sdk.version;NodeVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($nodePath).ProductVersion}
}
function New-RelayBundle($Package,[string]$Path) {
    Add-Type -AssemblyName System.IO.Compression
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew)
    $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try{
        foreach($file in $Package.Files){
            if((Get-RelayHash (Assert-RelayLocalPath $file.HostPath)) -cne $file.SHA256){throw 'A reviewed relay source changed before packaging.'}
            $entry=$zip.CreateEntry($file.Path,[IO.Compression.CompressionLevel]::Fastest);$output=$entry.Open();$inputStream=[IO.File]::OpenRead($file.HostPath)
            try{$inputStream.CopyTo($output)}finally{$inputStream.Dispose();$output.Dispose()}
        }
        $entry=$zip.CreateEntry('manifest.json');$output=$entry.Open()
        try{$bytes=$relayUtf8.GetBytes(($Package.Manifest|ConvertTo-Json -Depth 5 -Compress));$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
    }finally{$zip.Dispose();$stream.Dispose()}
}
function Invoke-RelayVm([string]$Operation,[string[]]$Arguments) {
    if((Get-RelayHash (Assert-RelayLocalPath $relayInvoker.Path)) -cne $relayInvoker.SHA256){throw 'The reviewed VM wrapper changed.'}
    & $relayInvoker.Path -Operation $Operation -OperationArguments $Arguments|Out-Null
    if($LASTEXITCODE -ne 0){throw ('Relay VM operation failed: '+$Operation+'.')}
}
function Invoke-RelayVmRequest([string]$Operation,$Package,$Reviewed=$null,[string]$BundlePath='') {
    if((Get-RelayHash (Assert-RelayLocalPath $GuestScript)) -cne $relayGuestHash){throw 'The reviewed guest deployment script changed.'}
    $id=[guid]::NewGuid().ToString('N');$staging=Join-Path $StateDir ('staging-'+$id);Set-RelayPrivateDirectory $staging
    $guestTemp=Join-Path $GuestHome 'AppData\Local\Temp';$prefix=Join-Path $guestTemp ('codex-relay-vm-'+$id)
    $guestCode=$prefix+'.ps1';$guestRequest=$prefix+'.request.json';$guestReport=$prefix+'.result.json';$guestBundle=$prefix+'.zip'
    $hostRequest=Join-Path $staging 'request.json';$hostReport=Join-Path $staging 'result.json'
    try{
        $request=[ordered]@{Action=$Operation;Home=$GuestHome;ReportPath=$guestReport;GatewayAddress=$GatewayAddress;AllowedPeer=$AllowedPeer;
            GatewayPort=$GatewayPort;McpPort=$McpPort;BundleHash=$Package.BundleHash;FileCount=$Package.FileCount;SdkVersion=$Package.SdkVersion;NodeVersion=$Package.NodeVersion}
        if($Reviewed){$request.ExpectedSnapshot=$Reviewed.Snapshot}
        if($BundlePath){$request.BundlePath=$guestBundle;$request.ZipHash=Get-RelayHash $BundlePath}
        [IO.File]::WriteAllText($hostRequest,($request|ConvertTo-Json -Depth 8),$relayUtf8)
        Invoke-RelayVm 'copyFileFromHostToGuest' @($GuestScript,$guestCode)
        Invoke-RelayVm 'copyFileFromHostToGuest' @($hostRequest,$guestRequest)
        if($BundlePath){Invoke-RelayVm 'copyFileFromHostToGuest' @($BundlePath,$guestBundle)}
        $command="& '"+$guestCode.Replace("'","''")+"' -RequestPath '"+$guestRequest.Replace("'","''")+"'"
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $failed=$false
        try{Invoke-RelayVm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',$encoded)}catch{$failed=$true}
        Invoke-RelayVm 'copyFileFromGuestToHost' @($guestReport,$hostReport)
        $result=Get-Content -LiteralPath $hostReport -Raw|ConvertFrom-Json
        if($failed -or $result.Success -ne $true){throw ('Relay VM action failed at stage '+[string]$result.Stage+'. Private logs were not copied.')}
        if($Operation -ceq 'Prepare'){
            $expected=Join-Path $GuestHome 'AppData\Local\CodexAccountBridge\ClaudeRelay\data\gateway.key'
            if($result.GatewayKeyFile -ine $expected){throw 'The VM returned an unexpected gateway key path.'}
            $keyFile=Assert-RelayLocalPath (Join-Path $StateDir 'gateway.key')
            $keyTemporary=Assert-RelayLocalPath (Join-Path $staging 'gateway-export.tmp')
            Invoke-RelayVm 'copyFileFromGuestToHost' @($expected,$keyTemporary)
            $key=[IO.File]::ReadAllText($keyTemporary)
            if($key -cnotmatch '^[\x21-\x7e]{40,4096}$'){throw 'The VM dedicated gateway key has an invalid format.'}
            if([IO.File]::Exists($keyFile)){[IO.File]::Replace($keyTemporary,$keyFile,[Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($keyTemporary,$keyFile)}
            Set-RelayPrivateFile $keyFile
            $key=$null
            $result|Add-Member NoteProperty HostGatewayKeyFile $keyFile
        }
        return $result
    }finally{
        $cleanup='foreach($p in @('+((@($guestCode,$guestRequest,$guestReport,$guestBundle)|ForEach-Object{"'"+$_.Replace("'","''")+"'"}) -join ',')+')){if([IO.File]::Exists($p)){Remove-Item -LiteralPath $p -Force}}'
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
        try{Invoke-RelayVm 'runProgramInGuest' @('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$encoded)}catch{Write-Warning 'Public relay deployment temporary files could not be cleaned up.'}
        foreach($file in @($hostRequest,$hostReport,(Join-Path $staging 'gateway-export.tmp'))){if([IO.File]::Exists($file)){Remove-Item -LiteralPath $file -Force}}
        if(@(Get-ChildItem -LiteralPath $staging -Force).Count -eq 0){Remove-Item -LiteralPath $staging -Force}
    }
}
function Get-RelayVmPlan($Package) {
    $guest=Invoke-RelayVmRequest 'Plan' $Package
    $description=[ordered]@{Product=$relayProduct;VmInvoker=$relayInvoker;GuestScriptHash=$relayGuestHash;Home=$GuestHome;
        BundleHash=$Package.BundleHash;GatewayAddress=$GatewayAddress;AllowedPeer=$AllowedPeer;GatewayPort=$GatewayPort;McpPort=$McpPort;Snapshot=$guest.Snapshot}
    return [ordered]@{Action='Plan';PlanHash=(Get-RelayTextHash ($description|ConvertTo-Json -Depth 10 -Compress));RuntimeRoot=$guest.RuntimeRoot;
        VmInvoker=$relayInvoker;GuestScriptHash=$relayGuestHash;Snapshot=$guest.Snapshot;BundleHash=$Package.BundleHash;FileCount=$Package.FileCount;TotalBytes=$Package.TotalBytes;
        SdkVersion=$Package.SdkVersion;NodeVersion=$Package.NodeVersion;CliPrepared=$guest.CliPrepared;IsAdministrator=$guest.IsAdministrator;
        GatewayAddress=$GatewayAddress;AllowedPeer=$AllowedPeer;GatewayPort=$GatewayPort;McpAddress='127.0.0.1';McpPort=$McpPort;
        CopiesGatewayKey=$true;CopiesOAuth=$false;PrepareStartsService=$false;PrepareStartsLogin=$false;DesktopModeChanged=$false;RealInference=$false}
}

$GuestHome=Assert-RelayLocalPath $GuestHome
$VmInvoker=Assert-RelayLocalPath $VmInvoker;$GuestScript=Assert-RelayLocalPath $GuestScript
if(-not [IO.File]::Exists($VmInvoker) -or -not [IO.File]::Exists($GuestScript)){throw 'The VM wrapper and guest deployment source must exist.'}
$relayInvoker=[ordered]@{Path=$VmInvoker;SHA256=(Get-RelayHash $VmInvoker)};$relayGuestHash=Get-RelayHash $GuestScript
$StateDir=Assert-RelayLocalPath $StateDir
if([IO.Path]::GetFileName($StateDir) -cne 'claude-relay-vm'){throw 'Use a dedicated private StateDir named claude-relay-vm.'}
$parsedAddress=$null;$parsedPeer=$null
if(-not [Net.IPAddress]::TryParse($GatewayAddress,[ref]$parsedAddress) -or -not [Net.IPAddress]::TryParse($AllowedPeer,[ref]$parsedPeer) -or
    $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $parsedPeer.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    [Net.IPAddress]::IsLoopback($parsedAddress) -or [Net.IPAddress]::IsLoopback($parsedPeer) -or $GatewayAddress -eq '0.0.0.0' -or
    $AllowedPeer -eq '0.0.0.0' -or $GatewayPort -lt 1024 -or $GatewayPort -gt 65535 -or $McpPort -lt 1024 -or $McpPort -gt 65535 -or $GatewayPort -eq $McpPort){throw 'Use explicit IPv4 addresses and distinct unprivileged relay ports.'}
Set-RelayPrivateDirectory $StateDir
$package=Get-RelayPackage ([IO.Path]::GetFullPath($SourceDirectory)) $NodeBinary
if($Action -ceq 'Plan'){Get-RelayVmPlan $package|ConvertTo-Json -Depth 10;return}
if($Action -ceq 'Prepare'){
    $plan=Get-RelayVmPlan $package
    if(-not $PlanHash -or $PlanHash -cne $plan.PlanHash){throw 'Run Plan and provide its current PlanHash before relay deployment.'}
    $bundle=Join-Path $StateDir ('bundle-'+[guid]::NewGuid().ToString('N')+'.zip')
    try{New-RelayBundle $package $bundle;$result=Invoke-RelayVmRequest 'Prepare' $package $plan $bundle}
    finally{if([IO.File]::Exists($bundle)){Remove-Item -LiteralPath $bundle -Force}}
}else{$result=Invoke-RelayVmRequest $Action $package}
$result|ConvertTo-Json -Depth 10
