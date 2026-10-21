param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$product='CodexAccountBridge.OfficialClaudeRelayVm'
$utf8=New-Object Text.UTF8Encoding($false)
$stage='validate-request';$reportPath=$null;$request=$null;$mutex=$null;$mutexOwned=$false;$staging=$null

function Resolve-GuestPath([string]$Path,[string]$Parent) {
    if($Path -cnotmatch '^[A-Za-z]:[\\/]' -or $Path.StartsWith('\\') -or $Path -match '[\x00-\x1f\x7f"]' -or $Path.Trim() -cne $Path){throw 'Use a local deployment path.'}
    $absolute=[IO.Path]::GetFullPath($Path);$prefix=[IO.Path]::GetFullPath($Parent).TrimEnd('\')+'\'
    if($absolute.Substring([IO.Path]::GetPathRoot($absolute).Length).Contains(':')){throw 'A relay path cannot use an alternate data stream.'}
    if(-not $absolute.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'A relay path escaped its selected directory.'}
    $cursor=$absolute
    while($cursor){
        try{$attributes=[IO.File]::GetAttributes($cursor)
            if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'A relay path crossed a reparse point.'}
        }catch [IO.FileNotFoundException]{}catch [IO.DirectoryNotFoundException]{}
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
    return $absolute
}
function File-Hash([string]$Path) {
    if(-not [IO.File]::Exists($Path)){return $null}
    if([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint){throw 'A relay file cannot be redirected.'}
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','')}finally{$sha.Dispose();$stream.Dispose()}
}
function Text-Hash([string]$Text) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','')}finally{$sha.Dispose()}
}
function Private-Directory([string]$Path) {
    $null=Resolve-GuestPath $Path $request.Home
    $directory=[IO.Directory]::CreateDirectory($Path);$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
        [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    };if($PSVersionTable.PSEdition -ceq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl($directory,$acl)}else{$directory.SetAccessControl($acl)}
}
function Write-Atomic([string]$Path,[byte[]]$Bytes,$PreviousHash) {
    $null=Resolve-GuestPath $Path $request.Home
    if((File-Hash $Path) -cne $PreviousHash){throw 'A managed relay file changed concurrently.'}
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try{
        [IO.File]::WriteAllBytes($temporary,$Bytes)
        if((File-Hash $Path) -cne $PreviousHash){throw 'A managed relay file changed concurrently.'}
        if($null -eq $PreviousHash){[IO.File]::Move($temporary,$Path)}else{[IO.File]::Replace($temporary,$Path,[Management.Automation.Language.NullString]::Value)}
    }finally{if([IO.File]::Exists($temporary)){Remove-Item -LiteralPath $temporary -Force}}
}
function Read-Owner {
    if(-not [IO.File]::Exists($manifestPath)){return $null}
    $value=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
    if($value.Product -cne $product -or $value.Version -ne 1 -or $value.Home -ine $request.Home -or $value.Root -ine $root -or
        $value.RuleName -cne $ruleName -or $value.Phase -cnotin @('preparing','prepared','restored') -or $value.Files -isnot [array]){throw 'The relay ownership manifest does not match this installation.'}
    $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $value.Files){
        if($file.SHA256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or -not $seen.Add([string]$file.Path)){throw 'The relay ownership file table is invalid.'}
        $null=Resolve-OwnedPath $file.Path
    }
    return $value
}
function Resolve-OwnedPath([string]$Path) {
    $allowed=@($startShortcut,$stopShortcut)
    if($Path -iin $allowed){$null=Resolve-GuestPath $Path ([IO.Path]::GetDirectoryName($Path));return [IO.Path]::GetFullPath($Path)}
    $absolute=Resolve-GuestPath $Path $root
    $relative=$absolute.Substring($root.Length+1).Replace('\','/')
    if($relative -notlike 'app/*' -and $relative -cnotin @('bin/node.exe','tools/ClaudeRelay.ps1','tools/StartRelay.ps1','tools/StopRelay.ps1','data/relay.json','data/gateway.key')){throw 'An ownership entry is outside the relay asset allowlist.'}
    return $absolute
}
function Assert-OwnedFiles($Owner) {
    if($null -eq $Owner){
        if([IO.Directory]::Exists($root) -and @(Get-ChildItem -LiteralPath $root -Force).Count){throw 'An unowned relay runtime directory is not empty.'}
        foreach($path in @($startShortcut,$stopShortcut)){if(Test-Path -LiteralPath $path){throw 'An unowned relay shortcut already exists.'}}
        return
    }
    foreach($file in $Owner.Files){
        $path=Resolve-OwnedPath $file.Path;$hash=File-Hash $path
        if((Test-Path -LiteralPath $path) -and -not [IO.File]::Exists($path)){throw 'A managed relay file was replaced by a directory.'}
        if($hash -cne $file.SHA256 -and -not($Owner.Phase -ceq 'preparing' -and ($hash -ceq $file.PreviousSHA256 -or $null -eq $hash))){throw 'A managed relay asset changed; update or removal was refused.'}
    }
}
function Index-OwnedFiles($Owner) {
    $index=New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
    foreach($file in $Owner.Files){if($index.ContainsKey([string]$file.Path)){throw 'The owned asset list repeats a target.'};$index.Add([string]$file.Path,$file)}
    return ,$index
}
function New-TargetRecord([string]$Path,[string]$Hash,$Staged,$Owner,$Index=$null) {
    $target=Resolve-OwnedPath $Path;$current=File-Hash $target
    if($null -eq $Index){$owned=@($Owner.Files|Where-Object{$_.Path -ieq $target})}
    elseif($Index.ContainsKey($target)){$owned=@($Index[$target])}else{$owned=@()}
    if($owned.Count -gt 1 -or ($owned.Count -eq 0 -and (Test-Path -LiteralPath $target))){throw 'An existing target is not owned by this relay deployment.'}
    if((Test-Path -LiteralPath $target) -and -not [IO.File]::Exists($target)){throw 'A relay asset target is a directory.'}
    if($owned.Count -eq 1 -and $current -cne $owned[0].SHA256 -and
        -not($Owner.Phase -ceq 'preparing' -and ($null -eq $current -or $current -ceq $owned[0].PreviousSHA256))){throw 'An owned target changed before publication.'}
    return [ordered]@{Path=$target;SHA256=$Hash;PreviousSHA256=$current;Staged=$Staged}
}
function Publish-StagedAsset($File,[string]$StagingRoot) {
    if($null -eq $File.Staged){return 'preserved'}
    $target=Resolve-OwnedPath $File.Path
    $stagingRoot=Resolve-GuestPath $StagingRoot $root
    if([IO.Path]::GetDirectoryName($stagingRoot) -ine $root -or [IO.Path]::GetFileName($stagingRoot) -cnotmatch '^staging-[a-f0-9]{32}$'){
        throw 'The publication staging directory is not owned by this operation.'
    }
    $source=Resolve-GuestPath $File.Staged $stagingRoot
    if($File.SHA256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or [IO.Path]::GetPathRoot($source) -ine [IO.Path]::GetPathRoot($target)){
        throw 'Atomic relay publication requires a verified same-volume source.'
    }
    $current=File-Hash $target
    if($current -ceq $File.SHA256){return 'skipped'}
    if($current -cne $File.PreviousSHA256 -or [IO.Directory]::Exists($target)){throw 'The relay publication target changed.'}
    if((File-Hash $source) -cne $File.SHA256){throw 'The verified staging file changed before publication.'}
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $null=Resolve-OwnedPath $target;$null=Resolve-GuestPath $source $stagingRoot
    $current=File-Hash $target
    if($current -ceq $File.SHA256){return 'skipped'}
    if($current -cne $File.PreviousSHA256 -or [IO.Directory]::Exists($target)){throw 'The relay publication target changed concurrently.'}
    if($null -eq $current){[IO.File]::Move($source,$target)}
    else{[IO.File]::Replace($source,$target,[Management.Automation.Language.NullString]::Value)}
    return 'published'
}
function Initialize-OwnerBeforeAssets($Owner,$Rule) {
    if($null -ne $Owner){return $Owner}
    $owner=[ordered]@{Product=$product;Version=1;Home=$request.Home;Root=$root;RuleName=$ruleName;Phase='preparing';Files=@();FirewallHash=(Rule-Hash $Rule);PendingFirewallRule=$null}
    Write-Atomic $manifestPath $utf8.GetBytes(($owner|ConvertTo-Json -Depth 8)) $null
    return $owner
}
function New-RelayConfiguration {
    return [ordered]@{version=1;listener=@{address=[string]$address;port=[int]$request.GatewayPort;
        allowedHosts=@(([string]$address+':'+$request.GatewayPort),('127.0.0.1:'+ $request.GatewayPort));allowedPeers=@([string]$peer)};
        gatewayKeyFile=$keyPath;mcpPort=[int]$request.McpPort;
        models=@(@{id='claude/opus';name='Claude - Original subscription Opus';upstream='opus'},@{id='claude/sonnet';name='Claude - Original subscription Sonnet';upstream='sonnet'},@{id='claude/haiku';name='Claude - Original subscription Haiku';upstream='haiku'});
        cli=@{binary=$cliBinary;configDir=(Join-Path $cliRoot 'data\profile\.claude');profileDir=(Join-Path $cliRoot 'data\profile');stateDir=(Join-Path $root 'data\sdk-state')}}
}
function Remove-RetiredAssets($Files) {
    foreach($file in $Files){
        $path=Resolve-OwnedPath $file.Path;$hash=File-Hash $path
        if($null -ne $hash){if($hash -cne $file.SHA256 -and $hash -cne $file.PreviousSHA256){throw 'A retired owned asset changed before removal.'};Remove-Item -LiteralPath $path -Force}
    }
}
function Restore-OwnedAssets($Owner) {
    Assert-OwnedFiles $Owner
    foreach($file in $Owner.Files){
        $path=Resolve-OwnedPath $file.Path
        if($path.StartsWith($root+'\data\',[StringComparison]::OrdinalIgnoreCase)){continue}
        $hash=File-Hash $path
        if($null -ne $hash){
            if($hash -cne $file.SHA256 -and -not($Owner.Phase -ceq 'preparing' -and $hash -ceq $file.PreviousSHA256)){throw 'A managed file changed before removal.'}
            Remove-Item -LiteralPath $path -Force
        }
    }
}
function Get-RuleIdentity {
    $rule=Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if(-not $rule){return $null}
    if(@($rule).Count -ne 1){throw 'More than one firewall rule has the relay ownership name.'}
    $port=$rule|Get-NetFirewallPortFilter;$address=$rule|Get-NetFirewallAddressFilter;$program=$rule|Get-NetFirewallApplicationFilter
    return [ordered]@{Name=$rule.Name;Group=$rule.Group;Description=$rule.Description;Enabled=[string]$rule.Enabled;Direction=[string]$rule.Direction;
        Action=[string]$rule.Action;Profile=[string]$rule.Profile;Protocol=([string]$port.Protocol -replace '^6$','TCP');LocalPort=[string]$port.LocalPort;RemotePort=[string]$port.RemotePort;LocalAddress=@($address.LocalAddress);
        RemoteAddress=@($address.RemoteAddress);Program=$program.Program}
}
function Rule-Hash($Rule) {if($null -eq $Rule){return $null};return Text-Hash ($Rule|ConvertTo-Json -Depth 6 -Compress)}
function Assert-OwnedRule($Owner,$Rule) {
    if($null -eq $Owner){if($null -ne $Rule){throw 'The relay firewall rule exists without ownership.'};return}
    if($null -ne $Rule -and (Rule-Hash $Rule) -cne $Owner.FirewallHash){
        if($Owner.Phase -ceq 'preparing' -and $null -ne $Owner.PendingFirewallRule){
            Assert-ScopedRule $Owner.PendingFirewallRule
            if((Rule-Hash $Rule) -ceq (Rule-Hash $Owner.PendingFirewallRule)){return}
        }
        throw 'The owned relay firewall rule changed.'
    }
}
function New-ScopedRule {
    return [ordered]@{Name=$ruleName;Group=$product;Description=$root;Enabled='True';Direction='Inbound';Action='Allow';Profile='Any';
        Protocol='TCP';LocalPort=[string]$request.GatewayPort;RemotePort='Any';LocalAddress=@([string]$address);RemoteAddress=@([string]$peer);Program=(Join-Path $root 'bin\node.exe')}
}
function Assert-ScopedRule($Rule) {
    $local=$null;$remote=$null;$port=0
    if($Rule.Name -cne $ruleName -or $Rule.Group -cne $product -or $Rule.Description -ine $root -or $Rule.Program -ine (Join-Path $root 'bin\node.exe') -or
        $Rule.Enabled -cne 'True' -or $Rule.Direction -cne 'Inbound' -or $Rule.Action -cne 'Allow' -or $Rule.Profile -cne 'Any' -or
        $Rule.Protocol -cne 'TCP' -or $Rule.RemotePort -cne 'Any' -or @($Rule.LocalAddress).Count -ne 1 -or @($Rule.RemoteAddress).Count -ne 1 -or
        -not [int]::TryParse([string]$Rule.LocalPort,[ref]$port) -or $port -lt 1024 -or $port -gt 65535 -or
        -not [Net.IPAddress]::TryParse([string]$Rule.LocalAddress[0],[ref]$local) -or -not [Net.IPAddress]::TryParse([string]$Rule.RemoteAddress[0],[ref]$remote) -or
        $local.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $remote.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        [Net.IPAddress]::IsLoopback($local) -or [Net.IPAddress]::IsLoopback($remote) -or $local.Equals([Net.IPAddress]::Any) -or $remote.Equals([Net.IPAddress]::Any)){
        throw 'A pending relay firewall rule escaped its exact program and host scope.'
    }
}
function Test-CliPrepared {
    $path=Join-Path $cliRoot '.official-claude-cli.json'
    if(-not [IO.File]::Exists($path)){return $false}
    $metadata=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
    if($metadata.Product -cne 'CodexAccountBridge.OfficialClaudeCli' -or $metadata.Root -ine $cliRoot -or $metadata.Phase -cne 'prepared' -or
        $metadata.ClaudeCodeVersion -cne '2.1.304' -or $metadata.Checksum -cnotmatch '^[A-Fa-f0-9]{64}$'){return $false}
    return [IO.File]::Exists($cliBinary) -and (File-Hash $cliBinary) -ceq $metadata.Checksum -and ([IO.FileInfo]$cliBinary).Length -eq $metadata.Size
}
function New-ManagerProcess([Diagnostics.ProcessStartInfo]$Info) {
    $process=New-Object Diagnostics.Process;$process.StartInfo=$Info;return $process
}
function Read-ManagerResult([string]$Path) {
    $null=Resolve-GuestPath $Path $root
    if(-not [IO.File]::Exists($Path)){throw 'MANAGER_OUTPUT_MISSING'}
    $stream=$null;$reader=$null
    try{
        $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
        if($stream.Length -gt 65536){throw 'MANAGER_OUTPUT_INVALID'}
        $reader=New-Object IO.StreamReader($stream,(New-Object Text.UTF8Encoding($false,$true)))
        $characters=New-Object char[] 65537;$count=$reader.ReadBlock($characters,0,$characters.Length)
        if($count -eq 0 -or $count -gt 65536){throw 'MANAGER_OUTPUT_INVALID'}
        $text=New-Object string($characters,0,$count)
        $result=$text|ConvertFrom-Json
        if($result.Success -isnot [bool] -or -not $result.Success -or $result.Value -isnot [pscustomobject]){throw 'MANAGER_OUTPUT_INVALID'}
        return $result.Value
    }catch{throw 'MANAGER_OUTPUT_INVALID'}finally{if($reader){$reader.Dispose()}elseif($stream){$stream.Dispose()}}
}
function Invoke-Manager([string]$Operation,[Diagnostics.Stopwatch]$Budget=$null) {
    if($Operation -cnotin @('Plan','Start','Status','Stop')){throw 'Unknown relay manager operation.'}
    if($null -eq $Budget){$Budget=[Diagnostics.Stopwatch]::StartNew()}
    $manager=Join-Path $root 'tools\ClaudeRelay.ps1'
    $parameters=@{Root=$root;NodeBinary=(Join-Path $root 'bin\node.exe');ConfigPath=$configPath;EntryScript=(Join-Path $root 'app\scripts\run-claude-relay.mjs')}
    $plan=$null
    if($Operation -ceq 'Start'){$plan=Invoke-Manager 'Plan' $Budget}
    $resultDirectory=Join-Path $root 'data\manager-invocations'
    Private-Directory $resultDirectory
    $resultPath=Resolve-GuestPath (Join-Path $resultDirectory ([guid]::NewGuid().ToString('N')+'.result.json')) $resultDirectory
    if(Test-Path -LiteralPath $resultPath){throw 'MANAGER_OUTPUT_EXISTS'}
    $payload=[ordered]@{Manager=$manager;Operation=$Operation;Parameters=$parameters;OutputPath=$resultPath;PlanHash=$null}
    if($plan){$payload.PlanHash=$plan.PlanHash}
    $encodedPayload=[Convert]::ToBase64String($utf8.GetBytes(($payload|ConvertTo-Json -Depth 6 -Compress)))
    $wrapper=@'
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::SetOut([IO.TextWriter]::Null)
[Console]::SetError([IO.TextWriter]::Null)
$payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))|ConvertFrom-Json
$parameters=@{Action=[string]$payload.Operation}
foreach($name in @('Root','NodeBinary','ConfigPath','EntryScript')){$parameters[$name]=[string]$payload.Parameters.$name}
if($payload.PlanHash){$parameters.PlanHash=[string]$payload.PlanHash}
$exitCode=0
try{
    $global:LASTEXITCODE=0
    $text=& ([string]$payload.Manager) @parameters 2>$null|Out-String
    if($LASTEXITCODE -ne 0){throw 'MANAGER_WRAPPER_FAILED'}
    $value=$text|ConvertFrom-Json
    if($value -isnot [pscustomobject]){throw 'MANAGER_WRAPPER_FAILED'}
    $envelope=[ordered]@{Success=$true;Value=$value}
}catch{$envelope=[ordered]@{Success=$false;Code='MANAGER_WRAPPER_FAILED'};$exitCode=1}
$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($envelope|ConvertTo-Json -Depth 14 -Compress))
if($bytes.Length -gt 65536){$bytes=[Text.Encoding]::UTF8.GetBytes('{"Success":false,"Code":"MANAGER_OUTPUT_INVALID"}');$exitCode=1}
# Open only after the manager returns, so its relay descendant cannot inherit this handle.
$output=[IO.File]::Open([string]$payload.OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
exit $exitCode
'@
    $wrapper=$wrapper.Replace('__PAYLOAD__',$encodedPayload)
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapper))
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$false;$info.RedirectStandardError=$false
    $child=$null;$failureCode='MANAGER_WRAPPER_START_FAILED'
    try{
        $child=New-ManagerProcess $info
        if(-not $child.Start()){throw 'MANAGER_WRAPPER_START_FAILED'};$null=$child.Handle
        $failureCode='MANAGER_WRAPPER_TIMEOUT'
        $remaining=60000-$Budget.ElapsedMilliseconds
        if($remaining -le 0 -or -not $child.WaitForExit([int]$remaining)){
            # This is the held PowerShell wrapper only; never stop its relay descendant.
            try{$child.Kill()}catch{}
            throw 'MANAGER_WRAPPER_TIMEOUT'
        }
        $failureCode='MANAGER_WRAPPER_FAILED'
        if($child.ExitCode -ne 0){throw 'MANAGER_WRAPPER_FAILED'}
        if($Budget.ElapsedMilliseconds -ge 60000){$failureCode='MANAGER_WRAPPER_TIMEOUT';throw 'MANAGER_WRAPPER_TIMEOUT'}
        $failureCode='MANAGER_OUTPUT_INVALID'
        return Read-ManagerResult $resultPath
    }catch{throw $failureCode}finally{
        if($child){$child.Dispose()}
        $null=Resolve-GuestPath $resultPath $resultDirectory
        if([IO.File]::Exists($resultPath)){[IO.File]::Delete($resultPath)}
    }
}
function Public-Manager($Value) {
    $public=[ordered]@{}
    foreach($name in @('Running','ProcessOwned','ListenerReady','RealInference','StartPending')){if($Value.$name -is [bool]){$public[$name]=$Value.$name}}
    if(($Value.PendingOwnedPid -is [int] -or $Value.PendingOwnedPid -is [long]) -and $Value.PendingOwnedPid -gt 0 -and $Value.PendingOwnedPid -le [int]::MaxValue){$public.PendingOwnedPid=$Value.PendingOwnedPid}
    foreach($name in @('RuntimeRoot','ListenerAddress','GatewayKeyFile')){if($Value.$name -is [string]){$public[$name]=$Value.$name}}
    $public.Authenticated=$null
    return $public
}
function Stop-InstalledRelay($Owner) {
    if($null -eq $Owner){return}
    $hasIdentity=[IO.File]::Exists((Join-Path $root 'data\relay-process\identity.json')) -or [IO.File]::Exists((Join-Path $root 'data\relay-process\pending-start.json'))
    if($Owner.Phase -ceq 'prepared' -or $hasIdentity){
        $stopped=Invoke-Manager 'Stop'
        if($stopped.Running -isnot [bool] -or $stopped.Running -or $stopped.StartPending -eq $true){throw 'The previous relay ownership is not fully stopped.'}
    }
}
function Remove-RelayStaging([string]$Path) {
    $target=Resolve-GuestPath $Path $root
    if([IO.Path]::GetDirectoryName($target) -ine $root -or [IO.Path]::GetFileName($target) -cnotmatch '^staging-[a-f0-9]{32}$'){throw 'The staging cleanup target is not owned by this invocation.'}
    if(-not [IO.Directory]::Exists($target)){return}
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($target)
    while($pending.Count){foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){
        $null=Resolve-GuestPath $item.FullName $target
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Staging cleanup cannot traverse a redirected entry.'}
        if($item.PSIsContainer){$pending.Push($item.FullName)}
    }}
    Remove-Item -LiteralPath $target -Recurse -Force
}
function Read-Bundle([string]$Archive,[string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression
    $archive=Resolve-GuestPath $Archive $requestDirectory
    if($request.ZipHash -cnotmatch '^[A-Fa-f0-9]{64}$' -or (File-Hash $archive) -cne $request.ZipHash){throw 'The source archive failed its reviewed checksum.'}
    $stream=[IO.File]::OpenRead($archive);$zip=$null
    try{
        $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read,$false)
        $zipNames=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach($item in $zip.Entries){if(-not $zipNames.Add($item.FullName)){throw 'The archive repeats a file name.'}}
        $entry=$zip.GetEntry('manifest.json');if($null -eq $entry -or $entry.Length -gt 16MB){throw 'The source archive manifest is invalid.'}
        $reader=New-Object IO.StreamReader($entry.Open(),(New-Object Text.UTF8Encoding($false,$true)))
        try{$files=$reader.ReadToEnd()|ConvertFrom-Json;$files=@($files)}finally{$reader.Dispose()}
        if($files.Count -ne $request.FileCount -or $files.Count -gt 50000 -or $zip.Entries.Count -ne ($files.Count+1) -or
            (Text-Hash ($files|ConvertTo-Json -Depth 5 -Compress)) -cne $request.BundleHash){throw 'The archive differs from the reviewed dependency inventory.'}
        $seen=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase);$total=0L
        foreach($file in $files){
            if($file.Path -isnot [string] -or $file.Path -match '[\\<>:"|?*\x00-\x1f\x7f]' -or $file.Path.StartsWith('/') -or
                @($file.Path.Split('/')|Where-Object{$_ -cin @('','..','.') -or $_ -match '[. ]$' -or $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)'}).Count -or -not $seen.Add($file.Path) -or
                ($file.Path -notlike 'app/*' -and $file.Path -cnotin @('bin/node.exe','tools/ClaudeRelay.ps1')) -or
                $file.SHA256 -cnotmatch '^[A-Fa-f0-9]{64}$' -or ($file.Size -isnot [int] -and $file.Size -isnot [long]) -or
                $file.Size -lt 0 -or $file.Size -gt 2GB){throw 'An archive entry is outside its asset allowlist.'}
            $entry=$zip.GetEntry($file.Path);$total+=[long]$file.Size
            if($null -eq $entry -or $entry.Length -ne $file.Size -or $total -gt 2GB){throw 'An archive entry exceeded its reviewed size.'}
            $target=Resolve-GuestPath (Join-Path $Destination $file.Path) $Destination
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            $output=[IO.File]::Open($target,[IO.FileMode]::CreateNew);$entryInput=$null
            try{
                $entryInput=$entry.Open()
                $buffer=New-Object byte[] 65536;$copied=0L
                while(($count=$entryInput.Read($buffer,0,$buffer.Length)) -gt 0){
                    $copied+=$count;if($copied -gt $file.Size){throw 'An archive stream exceeded its reviewed size.'};$output.Write($buffer,0,$count)
                }
                if($copied -ne $file.Size){throw 'An archive stream ended before its reviewed size.'}
            }finally{if($entryInput){$entryInput.Dispose()};$output.Dispose()}
            if((File-Hash $target) -cne $file.SHA256){throw 'An extracted relay asset failed verification.'}
        }
        return $files
    }finally{if($zip){$zip.Dispose()};$stream.Dispose()}
}
function New-RelayShortcut([string]$Path,[string]$Script) {
    $shell=New-Object -ComObject WScript.Shell
    try{$shortcut=$shell.CreateShortcut($Path)
        try{$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe';$shortcut.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$Script+'"';$shortcut.WorkingDirectory=$root;$shortcut.WindowStyle=7;$shortcut.Description='Manage the isolated official Claude relay.';$shortcut.Save()}
        finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)}
    }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
}

try{
    $requestFile=Resolve-GuestPath $RequestPath (Join-Path $env:USERPROFILE 'AppData\Local\Temp')
    if([IO.Path]::GetFileName($requestFile) -cnotmatch '^codex-relay-vm-([a-f0-9]{32})\.request\.json$'){throw 'The relay request name is invalid.'}
    $requestId=$Matches[1];$requestDirectory=[IO.Path]::GetDirectoryName($requestFile)
    $reportPath=Join-Path $requestDirectory ('codex-relay-vm-'+$requestId+'.result.json')
    $request=Get-Content -LiteralPath $requestFile -Raw|ConvertFrom-Json
    if($request.Home -ine $env:USERPROFILE -or $request.Action -cnotin @('Plan','Prepare','Start','Status','Stop','Restore') -or $request.ReportPath -ine $reportPath){throw 'The relay request targets an unexpected account.'}
    $base=Resolve-GuestPath (Join-Path $request.Home 'AppData\Local\CodexAccountBridge') $request.Home
    $root=Resolve-GuestPath (Join-Path $base 'ClaudeRelay') $base;$cliRoot=Resolve-GuestPath (Join-Path $base 'OfficialClaudeCli') $base
    $cliBinary=Resolve-GuestPath (Join-Path $cliRoot 'bin\claude.exe') $cliRoot
    $manifestPath=Resolve-GuestPath (Join-Path $base 'claude-relay-vm.json') $base
    $configPath=Resolve-GuestPath (Join-Path $root 'data\relay.json') $root;$keyPath=Resolve-GuestPath (Join-Path $root 'data\gateway.key') $root
    $desktop=[Environment]::GetFolderPath('Desktop');$startShortcut=Join-Path $desktop 'Claude Relay - Start.lnk';$stopShortcut=Join-Path $desktop 'Claude Relay - Stop.lnk'
    $ruleName='CodexAccountBridge-ClaudeRelay-'+(Text-Hash $root.ToLowerInvariant()).Substring(0,12)
    $address=$null;$peer=$null
    if(-not [Net.IPAddress]::TryParse([string]$request.GatewayAddress,[ref]$address) -or -not [Net.IPAddress]::TryParse([string]$request.AllowedPeer,[ref]$peer) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $peer.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        [Net.IPAddress]::IsLoopback($address) -or [Net.IPAddress]::IsLoopback($peer) -or [string]$address -eq '0.0.0.0' -or [string]$peer -eq '0.0.0.0' -or
        $request.GatewayPort -lt 1024 -or $request.GatewayPort -gt 65535 -or $request.McpPort -lt 1024 -or $request.McpPort -gt 65535 -or $request.GatewayPort -eq $request.McpPort){throw 'The relay listener bounds are invalid.'}
    $stage='read-inventory';$owner=Read-Owner;Assert-OwnedFiles $owner;$rule=Get-RuleIdentity;Assert-OwnedRule $owner $rule
    $snapshot=[ordered]@{ManifestHash=(File-Hash $manifestPath);RuleHash=(Rule-Hash $rule);CliPrepared=(Test-CliPrepared)}
    $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if($request.Action -ceq 'Plan'){
        $result=[ordered]@{Success=$true;Action='Plan';RuntimeRoot=$root;Snapshot=$snapshot;CliPrepared=$snapshot.CliPrepared;
            IsAdministrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);RealInference=$false}
    }elseif($request.Action -ceq 'Status'){
        $backend=$null;if($owner -and $owner.Phase -ceq 'prepared'){$backend=Public-Manager (Invoke-Manager 'Status')}
        $result=[ordered]@{Success=$true;Action='Status';Prepared=($owner -and $owner.Phase -ceq 'prepared');RuntimeRoot=$root;Backend=$backend;RealInference=$false}
    }else{
        $stage='acquire-lock';$mutex=New-Object Threading.Mutex($false,('Local\CodexClaudeRelay-'+(Text-Hash $root.ToLowerInvariant())));$mutexOwned=$mutex.WaitOne(0)
        if(-not $mutexOwned){throw 'Another relay deployment action is running.'}
        $owner=Read-Owner;Assert-OwnedFiles $owner;$rule=Get-RuleIdentity;Assert-OwnedRule $owner $rule
        if($request.Action -cin @('Start','Stop')){
            if($null -eq $owner -or $owner.Phase -cne 'prepared'){throw 'Prepare this relay before managing its process.'}
            $stage='manager-'+$request.Action.ToLowerInvariant();$backend=Public-Manager (Invoke-Manager $request.Action)
            $result=[ordered]@{Success=$true;Action=$request.Action;RuntimeRoot=$root;Backend=$backend;RealInference=$false}
        }elseif($request.Action -ceq 'Prepare'){
            $stage='reviewed-inventory'
            $current=[ordered]@{ManifestHash=(File-Hash $manifestPath);RuleHash=(Rule-Hash $rule);CliPrepared=(Test-CliPrepared)}
            if(($current|ConvertTo-Json -Compress) -cne ($request.ExpectedSnapshot|ConvertTo-Json -Compress) -or -not $current.CliPrepared){throw 'The reviewed relay inventory changed or the official CLI is not prepared.'}
            if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'The scoped relay firewall rule requires an administrator.'}
            $stage='stop-old-relay';Stop-InstalledRelay $owner
            $stage='prepare-private-directories';Private-Directory $base
            $owner=Initialize-OwnerBeforeAssets $owner $rule
            Private-Directory $root
            foreach($folder in @('bin','app','tools','data','data\sdk-state')){Private-Directory (Join-Path $root $folder)}
            $staging=Resolve-GuestPath (Join-Path $root ('staging-'+[guid]::NewGuid().ToString('N'))) $root;Private-Directory $staging
            $stage='verify-bundle';$files=Read-Bundle $request.BundlePath $staging
            $newFiles=New-Object Collections.Generic.List[object];$ownerIndex=Index-OwnedFiles $owner
            foreach($file in $files){$target=Join-Path $root $file.Path;$newFiles.Add((New-TargetRecord $target $file.SHA256 (Join-Path $staging $file.Path) $owner $ownerIndex))}
            $stage='prepare-key-config';$oldKey=File-Hash $keyPath
            $keyStaged=$null;$keyHash=$oldKey
            if($null -eq $oldKey){
                $random=New-Object byte[] 48;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($random)}finally{$rng.Dispose()}
                $key=[Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_');$keyStaged=Join-Path $staging 'data\gateway.key'
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($keyStaged));[IO.File]::WriteAllText($keyStaged,$key,$utf8);$key=$null;$keyHash=File-Hash $keyStaged
            }
            $config=New-RelayConfiguration
            $generated=@{ 'data/relay.json'=($config|ConvertTo-Json -Depth 8);'tools/StartRelay.ps1'="`$root=Split-Path -Parent `$PSScriptRoot`r`n`$p=@{Root=`$root;NodeBinary=(Join-Path `$root 'bin\node.exe');ConfigPath=(Join-Path `$root 'data\relay.json');EntryScript=(Join-Path `$root 'app\scripts\run-claude-relay.mjs')}`r`n`$manager=Join-Path `$PSScriptRoot 'ClaudeRelay.ps1'`r`n`$plan=(& `$manager -Action Plan @p|Out-String|ConvertFrom-Json)`r`n& `$manager -Action Start @p -PlanHash `$plan.PlanHash";
                'tools/StopRelay.ps1'="`$root=Split-Path -Parent `$PSScriptRoot`r`n& (Join-Path `$PSScriptRoot 'ClaudeRelay.ps1') -Action Stop -Root `$root -NodeBinary (Join-Path `$root 'bin\node.exe') -ConfigPath (Join-Path `$root 'data\relay.json') -EntryScript (Join-Path `$root 'app\scripts\run-claude-relay.mjs')"}
            foreach($relative in $generated.Keys){$target=Join-Path $root $relative;$staged=Join-Path $staging $relative;[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($staged));[IO.File]::WriteAllText($staged,$generated[$relative],$utf8);$newFiles.Add((New-TargetRecord $target (File-Hash $staged) $staged $owner $ownerIndex))}
            foreach($shortcut in @(@{Path=$startShortcut;Script=(Join-Path $root 'tools\StartRelay.ps1');Name='start.lnk'},@{Path=$stopShortcut;Script=(Join-Path $root 'tools\StopRelay.ps1');Name='stop.lnk'})){
                $staged=Join-Path $staging $shortcut.Name;New-RelayShortcut $staged $shortcut.Script;$newFiles.Add((New-TargetRecord $shortcut.Path (File-Hash $staged) $staged $owner $ownerIndex))
            }
            $newFiles.Add((New-TargetRecord $keyPath $keyHash $keyStaged $owner $ownerIndex))
            $newPaths=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            foreach($file in $newFiles){if(-not $newPaths.Add([string]$file.Path)){throw 'The prepared asset list repeats a target.'}}
            $retired=New-Object Collections.Generic.List[object]
            foreach($file in $owner.Files){if(-not $newPaths.Contains([string]$file.Path)){$record=New-TargetRecord $file.Path $file.SHA256 $null $owner $ownerIndex;$record.Retired=$true;$retired.Add($record)}}
            $journalFiles=New-Object Collections.Generic.List[object]
            foreach($file in $newFiles){$journalFiles.Add([ordered]@{Path=$file.Path;SHA256=$file.SHA256;PreviousSHA256=$file.PreviousSHA256;Retired=$false})}
            foreach($file in $retired){$journalFiles.Add([ordered]@{Path=$file.Path;SHA256=$file.SHA256;PreviousSHA256=$file.PreviousSHA256;Retired=$true})}
            $stage='journal-assets';$journal=[ordered]@{Product=$product;Version=1;Home=$request.Home;Root=$root;RuleName=$ruleName;Phase='preparing';
                Files=$journalFiles.ToArray();
                FirewallHash=(Rule-Hash $rule);PendingFirewallRule=(New-ScopedRule)}
            Write-Atomic $manifestPath $utf8.GetBytes(($journal|ConvertTo-Json -Depth 8)) (File-Hash $manifestPath)
            $stage='publish-assets';foreach($file in $newFiles){$null=Publish-StagedAsset $file $staging}
            Remove-RetiredAssets $retired
            $stage='scoped-firewall'
            $rule=Get-RuleIdentity;Assert-OwnedRule $journal $rule
            if($rule){Remove-NetFirewallRule -Name $ruleName}
            $null=New-NetFirewallRule -Name $ruleName -DisplayName 'CodexAccountBridge official Claude relay' -Group $product -Description $root -Enabled True -Direction Inbound -Action Allow -Protocol TCP -LocalPort ([int]$request.GatewayPort) -LocalAddress ([string]$address) -RemoteAddress ([string]$peer) -Program (Join-Path $root 'bin\node.exe') -Profile Any
            $installedRule=Get-RuleIdentity
            if((Rule-Hash $installedRule) -cne (Rule-Hash $journal.PendingFirewallRule)){throw 'The installed firewall rule differs from its reviewed scope.'}
            $journal.FirewallHash=Rule-Hash $installedRule;$journal.PendingFirewallRule=$null;$journal.Phase='prepared';$journal.Files=@($journal.Files|Where-Object{-not $_.Retired}|ForEach-Object{[ordered]@{Path=$_.Path;SHA256=$_.SHA256}})
            Write-Atomic $manifestPath $utf8.GetBytes(($journal|ConvertTo-Json -Depth 8)) (File-Hash $manifestPath)
            $stage='verify-manager';$null=Invoke-Manager 'Plan'
            $result=[ordered]@{Success=$true;Action='Prepare';Prepared=$true;RuntimeRoot=$root;GatewayKeyFile=$keyPath;StartShortcut=$startShortcut;StopShortcut=$stopShortcut;
                GatewayAddress=[string]$address;AllowedPeer=[string]$peer;GatewayPort=[int]$request.GatewayPort;McpAddress='127.0.0.1';McpPort=[int]$request.McpPort;
                ServiceStarted=$false;LoginStarted=$false;OAuthCopied=$false;DesktopModeChanged=$false;RealInference=$false}
        }else{
            $stage='restore-owned-assets'
            if($owner){
                Stop-InstalledRelay $owner
                Assert-OwnedFiles $owner;$rule=Get-RuleIdentity;Assert-OwnedRule $owner $rule
                if($rule){Remove-NetFirewallRule -Name $ruleName}
                Restore-OwnedAssets $owner
                $owner.Phase='restored';$owner.FirewallHash=$null;$owner|Add-Member NoteProperty PendingFirewallRule $null -Force;$owner.Files=@($owner.Files|Where-Object{$_.Path.StartsWith($root+'\data\',[StringComparison]::OrdinalIgnoreCase)})
                Write-Atomic $manifestPath $utf8.GetBytes(($owner|ConvertTo-Json -Depth 8)) (File-Hash $manifestPath)
            }
            $result=[ordered]@{Success=$true;Action='Restore';Restored=($null -ne $owner);RuntimeRoot=$root;OAuthPreserved=$true;PrivateLogsPreserved=$true;GatewayKeyPreserved=$true;DesktopModeChanged=$false;RealInference=$false}
        }
    }
    [IO.File]::WriteAllText($reportPath,($result|ConvertTo-Json -Depth 10),$utf8)
}catch{
    if($reportPath){[IO.File]::WriteAllText($reportPath,([ordered]@{Success=$false;ErrorCode='OFFICIAL_CLAUDE_RELAY_VM_ACTION_FAILED';Stage=$stage;RealInference=$false}|ConvertTo-Json -Compress),$utf8)}
    exit 1
}finally{
    if($staging){try{Remove-RelayStaging $staging}catch{
        if($reportPath -and [IO.File]::Exists($reportPath)){
            try{$metadata=Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json;$metadata|Add-Member NoteProperty StagingCleanupPending $true -Force;[IO.File]::WriteAllText($reportPath,($metadata|ConvertTo-Json -Depth 10),$utf8)}catch{}
        }
    }}
    if($mutexOwned){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}
}
