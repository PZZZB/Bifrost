[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\scripts\ClaudeRelayVmGuest.ps1'))
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'The relay guest adapter does not parse.'}
foreach($name in @('Resolve-GuestPath','File-Hash','Text-Hash','Private-Directory','Write-Atomic','Read-Owner','Resolve-OwnedPath','Assert-OwnedFiles',
    'Index-OwnedFiles','New-TargetRecord','Publish-StagedAsset','Initialize-OwnerBeforeAssets','New-RelayConfiguration','Remove-RetiredAssets','Restore-OwnedAssets',
    'Rule-Hash','Assert-OwnedRule','New-ScopedRule','Assert-ScopedRule','New-ManagerProcess','Read-ManagerResult','Invoke-Manager','Public-Manager','Stop-InstalledRelay','Remove-RelayStaging','Read-Bundle')){
    $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
    if($definitions.Count -ne 1){throw 'An expected guest helper was not found.'}
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$script:actualInvokeManager=${function:Invoke-Manager};$script:actualNewManagerProcess=${function:New-ManagerProcess}
$product='CodexAccountBridge.OfficialClaudeRelayVm';$utf8=New-Object Text.UTF8Encoding($false)
$fixtureDirectory=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('relay-vm-guest-fixture-'+[guid]::NewGuid().ToString('N'))))
if(-not $fixtureDirectory.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){throw 'The guest fixture escaped temporary storage.'}
$script:passed=0
function Assert-Test([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Expect-Failure([scriptblock]$Body){$failed=$false;try{& $Body|Out-Null}catch{$failed=$true};Assert-Test $failed 'An unsafe guest deployment operation was accepted.'}
function Expect-Code([string]$Code,[scriptblock]$Body){$message=$null;try{& $Body|Out-Null}catch{$message=$_.Exception.Message};Assert-Test ($message -ceq $Code) 'A manager failure escaped its fixed diagnostic code.'}
function Test-Case([string]$Name,[scriptblock]$Body){Reset-Fixture;& $Body;$script:passed++;Write-Output ('PASS '+$Name)}
function Write-Fixture([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path));[IO.File]::WriteAllText($Path,$Text,$utf8)}
function New-Owner($Files=@(),[string]$Phase='prepared'){
    return [pscustomobject]@{Product=$product;Version=1;Home=$request.Home;Root=$root;RuleName=$ruleName;Phase=$Phase;Files=@($Files);FirewallHash=$null;PendingFirewallRule=$null}
}
function New-FileRecord([string]$Path){return [pscustomobject]@{Path=$Path;SHA256=(File-Hash $Path);PreviousSHA256=$null}}
function Reset-Fixture{
    if(Test-Path -LiteralPath $fixtureDirectory){Remove-Item -LiteralPath $fixtureDirectory -Recurse -Force}
    [void][IO.Directory]::CreateDirectory($fixtureDirectory)
    $script:request=[pscustomobject]@{Home=(Join-Path $fixtureDirectory 'user');GatewayPort=3435;McpPort=3436}
    $script:base=Join-Path $request.Home 'AppData\Local\CodexAccountBridge'
    $script:root=Join-Path $base 'ClaudeRelay';$script:cliRoot=Join-Path $base 'OfficialClaudeCli'
    $script:cliBinary=Join-Path $cliRoot 'bin\claude.exe';$script:manifestPath=Join-Path $base 'claude-relay-vm.json'
    $script:configPath=Join-Path $root 'data\relay.json';$script:keyPath=Join-Path $root 'data\gateway.key'
    $script:startShortcut=Join-Path $request.Home 'Desktop\Claude Relay - Start.lnk';$script:stopShortcut=Join-Path $request.Home 'Desktop\Claude Relay - Stop.lnk'
    $script:requestDirectory=Join-Path $request.Home 'AppData\Local\Temp'
    [void][IO.Directory]::CreateDirectory($base);[void][IO.Directory]::CreateDirectory($requestDirectory)
    $script:address=[Net.IPAddress]::Parse('192.168.168.10');$script:peer=[Net.IPAddress]::Parse('192.168.168.1')
    $script:ruleName='CodexAccountBridge-ClaudeRelay-fixture'
    $script:managerOperations=New-Object Collections.Generic.List[string]
    $script:managerStopped=[pscustomobject]@{Running=$false;StartPending=$false}
    $script:useRealManager=$false;$script:nativeManagerProcess=$false;$script:managerProcessMode='success'
    $script:managerChildren=New-Object Collections.Generic.List[object]
}
function Invoke-Manager([string]$Operation,[Diagnostics.Stopwatch]$Budget=$null){
    if($script:useRealManager){return & $script:actualInvokeManager $Operation $Budget}
    $script:managerOperations.Add($Operation);return $script:managerStopped
}
function New-ManagerProcess([Diagnostics.ProcessStartInfo]$Info){
    if($script:nativeManagerProcess){return & $script:actualNewManagerProcess $Info}
    $encoded=[regex]::Match($Info.Arguments,' -EncodedCommand ([A-Za-z0-9+/=]+)\z').Groups[1].Value
    Assert-Test ($encoded.Length -gt 0) 'The manager did not use an encoded wrapper.'
    $wrapper=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    $encodedPayload=[regex]::Match($wrapper,"FromBase64String\('([A-Za-z0-9+/=]+)'\)").Groups[1].Value
    $payload=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))|ConvertFrom-Json
    $process=[pscustomobject]@{StartInfo=$Info;Wrapper=$wrapper;Payload=$payload;Mode=$script:managerProcessMode;Handle=1;ExitCode=0;Killed=$false;Disposed=$false;WaitMilliseconds=0}
    $process|Add-Member ScriptProperty StandardOutput {throw 'A descendant still holds stdout open.'}
    $process|Add-Member ScriptProperty StandardError {throw 'A descendant still holds stderr open.'}
    $process|Add-Member ScriptMethod Start {
        if($this.Mode -ceq 'start-failure'){throw 'PRIVATE_START_FAILURE_FIXTURE'}
        if($this.Mode -cin @('missing','timeout')){return $true}
        $value=[ordered]@{FixtureOperation=$this.Payload.Operation;Running=($this.Payload.Operation -ceq 'Start');StartPending=$false;PlanHash=('a'*64)}
        $text=[ordered]@{Success=$true;Value=$value}|ConvertTo-Json -Depth 5 -Compress
        switch($this.Mode){
            'invalid'{$text='not-json PRIVATE_OUTPUT_FIXTURE'}
            'oversize'{$text='x'*65537}
            'failure'{$this.ExitCode=1;$text='PRIVATE_FAILURE_FIXTURE'}
        }
        [IO.File]::WriteAllText([string]$this.Payload.OutputPath,$text,(New-Object Text.UTF8Encoding($false)))
        return $true
    }
    $process|Add-Member ScriptMethod WaitForExit {param([int]$Milliseconds)$this.WaitMilliseconds=$Milliseconds;return $this.Mode -cne 'timeout'}
    $process|Add-Member ScriptMethod Kill {$this.Killed=$true}
    $process|Add-Member ScriptMethod Dispose {$this.Disposed=$true}
    $script:managerChildren.Add($process)
    return $process
}
function New-Archive($Files,$Entries=$null){
    Add-Type -AssemblyName System.IO.Compression
    if($null -eq $Entries){$Entries=$Files}
    $path=Join-Path $requestDirectory ('fixture-'+[guid]::NewGuid().ToString('N')+'.zip')
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew)
    $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
    try{
        foreach($file in $Entries){$entry=$zip.CreateEntry($file.Path);$output=$entry.Open();try{$bytes=$utf8.GetBytes([string]$file.Text);$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}}
        $manifest=@($Files|ForEach-Object{[ordered]@{Path=$_.Path;SHA256=$_.SHA256;Size=$_.Size}})
        $text=$manifest|ConvertTo-Json -Depth 5 -Compress
        $entry=$zip.CreateEntry('manifest.json');$output=$entry.Open();try{$bytes=$utf8.GetBytes($text);$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
    }finally{$zip.Dispose();$stream.Dispose()}
    $request|Add-Member NoteProperty FileCount @($Files).Count -Force
    $request|Add-Member NoteProperty BundleHash (Text-Hash $text) -Force
    $request|Add-Member NoteProperty ZipHash (File-Hash $path) -Force
    return $path
}
function Archive-File([string]$Path,[string]$Text='fixture'){
    return [pscustomobject]@{Path=$Path;Text=$Text;Size=[long]$utf8.GetByteCount($Text);SHA256=(Text-Hash $Text)}
}
function New-Staging{return Join-Path $root ('staging-'+[guid]::NewGuid().ToString('N'))}

try{
    Test-Case 'manager results use private unique files without reading inherited process pipes' {
        $script:useRealManager=$true
        $result=Invoke-Manager 'Status';$first=$script:managerChildren[0]
        Assert-Test ($result.FixtureOperation -ceq 'Status' -and -not $first.StartInfo.RedirectStandardOutput -and
            -not $first.StartInfo.RedirectStandardError -and $first.StartInfo.CreateNoWindow -and -not $first.StartInfo.UseShellExecute) 'The manager still depends on inherited output pipe EOF.'
        Assert-Test ($first.StartInfo.Arguments.StartsWith('-NoProfile -NonInteractive -WindowStyle Hidden ') -and
            $first.WaitMilliseconds -gt 0 -and $first.WaitMilliseconds -le 60000 -and $first.Disposed) 'The hidden wrapper lost its bounded wait or disposal.'
        Assert-Test ($first.Wrapper.IndexOf('$text=& ') -lt $first.Wrapper.IndexOf('[IO.FileMode]::CreateNew')) 'The result handle opened before a relay descendant could be created.'
        $sibling=Join-Path ([IO.Path]::GetDirectoryName($first.Payload.OutputPath)) 'unrelated.json';Write-Fixture $sibling 'Unrelated local result.'
        $null=Invoke-Manager 'Status';$second=$script:managerChildren[1]
        Assert-Test ($first.Payload.OutputPath -cne $second.Payload.OutputPath -and -not [IO.File]::Exists($first.Payload.OutputPath) -and
            -not [IO.File]::Exists($second.Payload.OutputPath) -and [IO.File]::ReadAllText($sibling) -ceq 'Unrelated local result.') 'Result cleanup reused a path or removed another invocation file.'
    }

    Test-Case 'Start obtains its current PlanHash within the same timeout budget' {
        $script:useRealManager=$true
        $result=Invoke-Manager 'Start'
        Assert-Test ($result.Running -and $script:managerChildren.Count -eq 2 -and
            $script:managerChildren[0].Payload.Operation -ceq 'Plan' -and $script:managerChildren[1].Payload.Operation -ceq 'Start' -and
            $script:managerChildren[1].Payload.PlanHash -ceq ('a'*64) -and
            $script:managerChildren[1].WaitMilliseconds -le $script:managerChildren[0].WaitMilliseconds) 'Start lost its fresh plan or renewed the 60-second budget.'
    }

    Test-Case 'manager startup, exit and invalid output failures retain fixed codes and clean exact files' {
        $script:useRealManager=$true
        foreach($mode in @('start-failure','failure','missing','invalid','oversize')){
            $script:managerProcessMode=$mode
            $code='MANAGER_OUTPUT_INVALID'
            if($mode -ceq 'start-failure'){$code='MANAGER_WRAPPER_START_FAILED'}
            if($mode -ceq 'failure'){$code='MANAGER_WRAPPER_FAILED'}
            Expect-Code $code {Invoke-Manager 'Status'}
            $child=$script:managerChildren[$script:managerChildren.Count-1]
            Assert-Test ($child.Disposed -and -not $child.Killed -and -not [IO.File]::Exists($child.Payload.OutputPath)) 'A failed result left its file or killed a relay descendant.'
        }
    }

    Test-Case 'manager timeout stops only its held wrapper and never waits for pipe EOF' {
        $script:useRealManager=$true;$script:managerProcessMode='timeout'
        Expect-Code 'MANAGER_WRAPPER_TIMEOUT' {Invoke-Manager 'Status'}
        $child=$script:managerChildren[0]
        Assert-Test ($child.Killed -and $child.Disposed -and $child.WaitMilliseconds -gt 0 -and $child.WaitMilliseconds -le 60000) 'Timeout did not stay scoped to its held wrapper.'
    }

    Test-Case 'encoded wrapper invokes only a harmless fake manager and returns Plan then Start JSON' {
        $script:useRealManager=$true;$script:nativeManagerProcess=$true
        $fakeManager=@'
param([string]$Action,[string]$Root,[string]$NodeBinary,[string]$ConfigPath,[string]$EntryScript,[string]$PlanHash)
if($Action -ceq 'Plan'){@{PlanHash=('b'*64)}|ConvertTo-Json -Compress;return}
if($Action -cne 'Start' -or $PlanHash -cne ('b'*64)){throw 'PRIVATE_FAKE_MANAGER_FAILURE'}
@{Running=$true;StartPending=$false;FixtureOnly=$true}|ConvertTo-Json -Compress
'@
        Write-Fixture (Join-Path $root 'tools\ClaudeRelay.ps1') $fakeManager
        $result=Invoke-Manager 'Start'
        Assert-Test ($result.Running -and $result.FixtureOnly -and -not $result.StartPending) 'The real hidden encoded wrapper failed its offline fake manager round trip.'
        Assert-Test (@(Get-ChildItem -LiteralPath (Join-Path $root 'data\manager-invocations') -Force).Count -eq 0) 'A native wrapper result was not removed.'
    }

    Test-Case 'generated configuration accepts forwarded loopback Host while retaining the sole real peer' {
        $config=New-RelayConfiguration
        Assert-Test (@($config.listener.allowedHosts).Count -eq 2 -and
            $config.listener.allowedHosts -ccontains '192.168.168.10:3435' -and $config.listener.allowedHosts -ccontains '127.0.0.1:3435') 'The host TCP forward would fail exact Host validation.'
        Assert-Test (@($config.listener.allowedPeers).Count -eq 1 -and $config.listener.allowedPeers[0] -ceq '192.168.168.1') 'Forwarded Host support widened the peer allowlist.'
        Assert-Test ($config.cli.configDir.StartsWith($cliRoot+'\',[StringComparison]::OrdinalIgnoreCase)) 'The relay uses another account profile.'
    }

    Test-Case 'first ownership is durable before the runtime acquires any content' {
        Assert-Test (-not [IO.Directory]::Exists($root)) 'The fixture root was unexpectedly populated.'
        $owner=Initialize-OwnerBeforeAssets $null $null
        Assert-Test ([IO.File]::Exists($manifestPath) -and $owner.Phase -ceq 'preparing' -and $owner.Files.Count -eq 0) 'Initial recovery ownership was not recorded.'
        Write-Fixture (Join-Path $root 'interrupted-publication.tmp') 'Interrupted fixture.'
        $loaded=Read-Owner;Assert-OwnedFiles $loaded
        Assert-Test ($loaded.Phase -ceq 'preparing') 'An interrupted first install became an unowned directory.'
    }

    Test-Case 'new targets cannot adopt existing unknown files or directories' {
        $path=Join-Path $root 'app\unknown.mjs';Write-Fixture $path 'Unrelated local file.'
        $owner=New-Owner @()
        Expect-Failure {New-TargetRecord $path ('a'*64) $null $owner}
        Assert-Test ([IO.File]::ReadAllText($path) -ceq 'Unrelated local file.') 'An unrelated file was overwritten.'
        $directory=Join-Path $root 'app\directory.mjs';[void][IO.Directory]::CreateDirectory($directory)
        Expect-Failure {New-TargetRecord $directory ('a'*64) $null $owner}
        Assert-Test ($null -ne (New-TargetRecord (Join-Path $root 'app\new.mjs') ('a'*64) $null $owner)) 'An absent new target was rejected.'
    }

    Test-Case 'target publication rechecks old managed hashes after staging' {
        $path=Join-Path $root 'app\old.mjs';Write-Fixture $path 'Owned old file.'
        $owner=New-Owner @((New-FileRecord $path))
        Write-Fixture $path 'Changed outside deployment.'
        Expect-Failure {New-TargetRecord $path ('a'*64) $null $owner}
    }

    Test-Case 'verified staged assets publish by atomic move and replace' {
        $staging=New-Staging;$source=Join-Path $staging 'app\fixture.mjs';$target=Join-Path $root 'app\fixture.mjs'
        Write-Fixture $source 'First approved content.'
        $record=[pscustomobject]@{Path=$target;SHA256=(File-Hash $source);PreviousSHA256=$null;Staged=$source}
        Assert-Test ((Publish-StagedAsset $record $staging) -ceq 'published') 'A new staged asset was not published.'
        Assert-Test (-not [IO.File]::Exists($source) -and [IO.File]::ReadAllText($target) -ceq 'First approved content.') 'Publication copied or lost the verified source.'
        $previous=File-Hash $target;Write-Fixture $source 'Second approved content.'
        $record.SHA256=File-Hash $source;$record.PreviousSHA256=$previous
        Assert-Test ((Publish-StagedAsset $record $staging) -ceq 'published') 'An existing asset was not atomically replaced.'
        Assert-Test (-not [IO.File]::Exists($source) -and [IO.File]::ReadAllText($target) -ceq 'Second approved content.') 'Atomic replacement did not preserve approved content.'
    }

    Test-Case 'partial publication skips approved destinations even after their staged source moved' {
        $staging=New-Staging;$source=Join-Path $staging 'app\fixture.mjs';$target=Join-Path $root 'app\fixture.mjs'
        Write-Fixture $source 'Approved resumable content.'
        $record=[pscustomobject]@{Path=$target;SHA256=(File-Hash $source);PreviousSHA256=$null;Staged=$source}
        $null=Publish-StagedAsset $record $staging
        $before=[IO.File]::GetLastWriteTimeUtc($target)
        Assert-Test ((Publish-StagedAsset $record $staging) -ceq 'skipped') 'Resume rewrote a correctly published destination.'
        Assert-Test ([IO.File]::GetLastWriteTimeUtc($target) -eq $before -and -not [IO.File]::Exists($source)) 'Resume changed approved bytes or required the consumed staged source.'
    }

    Test-Case 'fast publication rejects target conflicts, staged changes and path escapes' {
        $staging=New-Staging;$source=Join-Path $staging 'app\fixture.mjs';$target=Join-Path $root 'app\fixture.mjs'
        Write-Fixture $target 'Owned previous content.';Write-Fixture $source 'Approved staged content.'
        $previous=File-Hash $target;$approved=File-Hash $source
        $record=[pscustomobject]@{Path=$target;SHA256=$approved;PreviousSHA256=$previous;Staged=$source}
        Write-Fixture $target 'Changed outside this deployment.'
        Expect-Failure {Publish-StagedAsset $record $staging}
        Assert-Test ([IO.File]::ReadAllText($target) -ceq 'Changed outside this deployment.') 'A target conflict was overwritten.'
        Write-Fixture $target 'Owned previous content.';Write-Fixture $source 'Unapproved staged changes.'
        Expect-Failure {Publish-StagedAsset $record $staging}
        Assert-Test ([IO.File]::ReadAllText($target) -ceq 'Owned previous content.') 'A changed source was published.'
        $record.Staged=Join-Path $root 'outside-staging.mjs';Write-Fixture $record.Staged 'Approved staged content.'
        Expect-Failure {Publish-StagedAsset $record $staging}
        $record.Staged=$source;$record.Path=Join-Path $request.Home 'unowned-target.mjs'
        Expect-Failure {Publish-StagedAsset $record $staging}
    }

    Test-Case 'indexed recovery preserves ownership checks without repeatedly scanning the file table' {
        $target=Join-Path $root 'app\fixture.mjs';Write-Fixture $target 'Already published partial content.'
        $owner=New-Owner @((New-FileRecord $target)) 'preparing';$index=Index-OwnedFiles $owner
        $record=New-TargetRecord $target ('a'*64) $null $owner $index
        Assert-Test ($record.PreviousSHA256 -ceq (File-Hash $target)) 'The indexed owner did not retain its exact previous hash.'
        Write-Fixture $target 'Changed after ownership indexing.'
        Expect-Failure {New-TargetRecord $target ('a'*64) $null $owner $index}
    }

    Test-Case 'fast publication still rejects redirected target and staged ancestors' {
        $staging=New-Staging;$outside=Join-Path $fixtureDirectory 'outside-publication';Write-Fixture (Join-Path $outside 'fixture.mjs') 'Unrelated fixture content.'
        $targetLink=Join-Path $root 'app\redirected';[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($targetLink))
        $source=Join-Path $staging 'app\approved.mjs';Write-Fixture $source 'Approved staged content.'
        $record=[pscustomobject]@{Path=(Join-Path $targetLink 'fixture.mjs');SHA256=(File-Hash $source);PreviousSHA256=$null;Staged=$source}
        $null=New-Item -ItemType Junction -Path $targetLink -Target $outside
        try{Expect-Failure {Publish-StagedAsset $record $staging}}finally{[IO.Directory]::Delete($targetLink)}
        $sourceLink=Join-Path $staging 'redirected';$null=New-Item -ItemType Junction -Path $sourceLink -Target $outside
        $record.Path=Join-Path $root 'app\new-target.mjs';$record.Staged=Join-Path $sourceLink 'fixture.mjs'
        try{Expect-Failure {Publish-StagedAsset $record $staging}}finally{[IO.Directory]::Delete($sourceLink)}
        Assert-Test ([IO.File]::ReadAllText((Join-Path $outside 'fixture.mjs')) -ceq 'Unrelated fixture content.' -and
            -not [IO.File]::Exists($record.Path)) 'Publication traversed a redirected ancestor.'
    }

    Test-Case 'prepared installations always Stop the old manager including stale exited ownership' {
        Stop-InstalledRelay (New-Owner)
        Assert-Test ($script:managerOperations.Count -eq 1 -and $script:managerOperations[0] -ceq 'Stop') 'A stale exited process identity was left behind before update.'
    }

    Test-Case 'preparing installations with process state also Stop before mutation' {
        Write-Fixture (Join-Path $root 'data\relay-process\identity.json') '{}'
        Stop-InstalledRelay (New-Owner @() 'preparing')
        Assert-Test ($script:managerOperations.Count -eq 1 -and $script:managerOperations[0] -ceq 'Stop') 'An interrupted update could bypass old process cleanup.'
        $script:managerStopped.StartPending=$true
        Expect-Failure {Stop-InstalledRelay (New-Owner)}
    }

    Test-Case 'a pending exact firewall rule is recoverable before its final hash is written' {
        $old=New-ScopedRule;$old.LocalPort='3434'
        $next=New-ScopedRule
        $owner=New-Owner @() 'preparing';$owner.FirewallHash=Rule-Hash $old;$owner.PendingFirewallRule=$next
        Assert-OwnedRule $owner $old;Assert-OwnedRule $owner $next;Assert-OwnedRule $owner $null
        $owner.Phase='prepared'
        Expect-Failure {Assert-OwnedRule $owner $next}
    }

    Test-Case 'firewall recovery refuses modified peers, programs, ports, groups and profiles' {
        foreach($field in @('RemoteAddress','Program','LocalPort','Group','Description','Profile','RemotePort')){
            $owner=New-Owner @() 'preparing';$owner.PendingFirewallRule=New-ScopedRule
            $actual=New-ScopedRule
            switch($field){
                'RemoteAddress'{$actual.RemoteAddress=@('Any')}
                'Program'{$actual.Program='C:\Unrelated\node.exe'}
                'LocalPort'{$actual.LocalPort='Any'}
                'Group'{$actual.Group='Unrelated'}
                'Description'{$actual.Description='C:\Unrelated'}
                'Profile'{$actual.Profile='Public'}
                'RemotePort'{$actual.RemotePort='443'}
            }
            Expect-Failure {Assert-OwnedRule $owner $actual}
            $owner.PendingFirewallRule=$actual
            Expect-Failure {Assert-OwnedRule $owner $actual}
        }
    }

    Test-Case 'restore removes only owned executable assets and preserves account, key and data' {
        $app=Join-Path $root 'app\old.mjs';Write-Fixture $app 'Owned application.'
        Write-Fixture $configPath '{"fixture":"config"}';Write-Fixture $keyPath 'Fixture dedicated gateway key.'
        $log=Join-Path $root 'data\relay-process\logs\session.out.log';Write-Fixture $log 'Private fixture log.'
        Write-Fixture $cliBinary 'Independent official CLI fixture.'
        $owner=New-Owner @((New-FileRecord $app),(New-FileRecord $configPath),(New-FileRecord $keyPath))
        Restore-OwnedAssets $owner
        Assert-Test (-not [IO.File]::Exists($app) -and [IO.File]::Exists($configPath) -and [IO.File]::Exists($keyPath) -and
            [IO.File]::Exists($log) -and [IO.File]::Exists($cliBinary)) 'Restore removed unowned account data or preserved owned application code.'
    }

    Test-Case 'restore detects changed ownership before removing any application asset' {
        $first=Join-Path $root 'app\first.mjs';$second=Join-Path $root 'app\second.mjs'
        Write-Fixture $first 'Owned first.';Write-Fixture $second 'Owned second.'
        $owner=New-Owner @((New-FileRecord $first),(New-FileRecord $second))
        Write-Fixture $second 'Externally changed second.'
        Expect-Failure {Restore-OwnedAssets $owner}
        Assert-Test ([IO.File]::Exists($first) -and [IO.File]::ReadAllText($second) -ceq 'Externally changed second.') 'Restore partially removed an unconfirmed installation.'
    }

    Test-Case 'retired and partially published assets retain hash ownership through removal' {
        $old=Join-Path $root 'app\obsolete.mjs';Write-Fixture $old 'Previous owned version.'
        $previous=File-Hash $old
        $record=[pscustomobject]@{Path=$old;SHA256=('a'*64);PreviousSHA256=$previous;Retired=$true}
        $owner=New-Owner @($record) 'preparing';Assert-OwnedFiles $owner
        Remove-RetiredAssets @($record)
        Assert-Test (-not [IO.File]::Exists($old)) 'A retired previous version was left untracked.'
        Write-Fixture $old 'Changed by another operation.'
        Expect-Failure {Remove-RetiredAssets @($record)}
    }

    Test-Case 'staging cleanup is recursive only inside its exact generated directory' {
        $staging=New-Staging;Write-Fixture (Join-Path $staging 'app\nested\file.mjs') 'Extracted fixture.'
        $neighbor=Join-Path $root 'keep.txt';Write-Fixture $neighbor 'Unrelated neighbor.'
        Remove-RelayStaging $staging
        Assert-Test (-not [IO.Directory]::Exists($staging) -and [IO.File]::Exists($neighbor)) 'Staging cleanup escaped or failed.'
        Expect-Failure {Remove-RelayStaging $root}
        Expect-Failure {Remove-RelayStaging (Join-Path $root 'staging-not-a-guid')}
    }

    Test-Case 'ordinary bundles preserve inventory and content across PowerShell versions' {
        $files=@((Archive-File 'app/src/fixture.mjs' 'module fixture'),(Archive-File 'bin/node.exe' 'never execute fixture'))
        $archive=New-Archive $files;$staging=New-Staging
        $read=@(Read-Bundle $archive $staging)
        Assert-Test ($read.Count -eq 2 -and [IO.File]::ReadAllText((Join-Path $staging 'app\src\fixture.mjs')) -ceq 'module fixture') 'Cross-version manifest serialization changed the reviewed bundle.'
        Remove-RelayStaging $staging
    }

    Test-Case 'failed extraction leaves only its bounded staging tree for safe cleanup' {
        $first=Archive-File 'app/first.mjs' 'First verified file.'
        $second=Archive-File 'app/second.mjs' 'Second rejected file.';$second.SHA256=('0'*64)
        $archive=New-Archive @($first,$second);$staging=New-Staging
        Expect-Failure {Read-Bundle $archive $staging}
        Assert-Test ([IO.File]::Exists((Join-Path $staging 'app\first.mjs'))) 'The fixture never reached partial extraction.'
        Remove-RelayStaging $staging
        Assert-Test (-not [IO.Directory]::Exists($staging)) 'Failed extraction could not be cleaned up.'
    }

    Test-Case 'bundle paths reject traversal, alternate streams and Windows aliases' {
        foreach($path in @('../escape','app/../escape','app/x:stream','app/file.','app/file ','app/NUL.txt','app/CON/child','app/a?b')){
            $archive=New-Archive @((Archive-File $path))
            Expect-Failure {Read-Bundle $archive (New-Staging)}
        }
    }

    Test-Case 'duplicate case-insensitive zip entries are rejected' {
        $files=@((Archive-File 'app/fixture.mjs'))
        $entries=@($files[0],(Archive-File 'APP/FIXTURE.MJS'))
        $archive=New-Archive $files $entries
        Expect-Failure {Read-Bundle $archive (New-Staging)}
    }

    Test-Case 'archive checksum, reviewed content hash and uncompressed size are all mandatory' {
        foreach($change in @('archive','hash','size','oversize')){
            $file=Archive-File 'app/fixture.mjs'
            if($change -ceq 'hash'){$file.SHA256=('0'*64)}
            if($change -ceq 'size'){$file.Size++}
            if($change -ceq 'oversize'){$file.Size=3GB}
            $archive=New-Archive @($file)
            if($change -ceq 'archive'){$request.ZipHash=('0'*64)}
            Expect-Failure {Read-Bundle $archive (New-Staging)}
        }
    }

    Test-Case 'a rejected invalid zip releases its file handle for cleanup' {
        $archive=Join-Path $requestDirectory 'invalid.zip';Write-Fixture $archive 'Not a zip fixture.'
        $request|Add-Member NoteProperty ZipHash (File-Hash $archive) -Force
        Expect-Failure {Read-Bundle $archive (New-Staging)}
        Remove-Item -LiteralPath $archive -Force
        Assert-Test (-not [IO.File]::Exists($archive)) 'Invalid zip handling leaked a live file handle.'
    }

    Test-Case 'guest public manager metadata retains pending PID but strips private fields' {
        $value=[pscustomobject]@{Running=$false;ProcessOwned=$false;ListenerReady=$false;StartPending=$true;PendingOwnedPid=43210;
            Authenticated=$true;GatewayKey='PRIVATE_KEY_FIXTURE';CommandLine='PRIVATE_COMMAND_FIXTURE';RealInference=$false}
        $public=Public-Manager $value;$text=$public|ConvertTo-Json -Compress
        Assert-Test ($public.StartPending -and $public.PendingOwnedPid -eq 43210 -and $null -eq $public.Authenticated -and
            $text -notmatch 'PRIVATE_') 'Private manager fields escaped the guest report.'
    }

    Write-Output ('Claude relay VM guest offline tests: '+$script:passed+' passed.')
}finally{if(Test-Path -LiteralPath $fixtureDirectory){Remove-Item -LiteralPath $fixtureDirectory -Recurse -Force}}
