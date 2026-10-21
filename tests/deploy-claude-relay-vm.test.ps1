[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source=Join-Path $project 'scripts\Deploy-ClaudeRelayVm.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The relay VM host script does not parse.'}
foreach($definition in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
    . ([scriptblock]::Create($definition.Extent.Text))
}
$invokeRequest=(Get-Item Function:\Invoke-RelayVmRequest).ScriptBlock
$relayUtf8=New-Object Text.UTF8Encoding($false)
$relayProduct='CodexAccountBridge.OfficialClaudeRelayVm'
$testRoot=Join-Path $project ('.state\relay-vm-host-test-'+[guid]::NewGuid().ToString('N'))
$fixture=Join-Path $testRoot 'source';$StateDir=Join-Path $testRoot 'claude-relay-vm'
$GuestHome='C:\Users\Developer';$GatewayAddress='192.168.168.10';$AllowedPeer='192.168.168.1';$GatewayPort=3435;$McpPort=3436
$relayModels=Read-RelayModels
$passed=0
function Require([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Must-Fail([scriptblock]$Body){$failed=$false;try{& $Body|Out-Null}catch{$failed=$true};Require $failed 'An invalid relay deployment input was accepted.'}
function Write-Fixture([string]$Path,[string]$Text){[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path));[IO.File]::WriteAllText($Path,$Text,$relayUtf8)}
function Invoke-RelayVmRequest([string]$Operation,$Package,$Reviewed=$null,[string]$BundlePath=''){
    Require ($Operation -ceq 'Plan') 'A pure plan fixture requested a mutation.'
    return [pscustomobject]@{RuntimeRoot='C:\Users\Developer\AppData\Local\CodexAccountBridge\ClaudeRelay';Snapshot=@{ManifestHash=$null;RuleHash=$null;CliPrepared=$true};CliPrepared=$true;IsAdministrator=$true}
}
try{
    foreach($relative in @('scripts/run-claude-relay.mjs','src/claude-cli-provider.mjs','src/claude-sdk-worker.mjs','src/relay-control.mjs','src/anthropic-gateway.mjs','src/gateway.mjs','src/storage.mjs','src/models.mjs','package.json','scripts/ClaudeRelay.ps1')){
        Write-Fixture (Join-Path $fixture $relative) '# offline public source'
    }
    $sdk=Join-Path $fixture 'node_modules\@anthropic-ai\claude-agent-sdk\package.json'
    Write-Fixture $sdk '{"name":"@anthropic-ai/claude-agent-sdk","version":"0.3.304"}'
    $lock=Join-Path $fixture 'package-lock.json'
    $lockText='{"packages":{"":{"name":"public project root"},"node_modules/@anthropic-ai/claude-agent-sdk":{"version":"0.3.304","resolved":"https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.304.tgz","integrity":"sha512-Ivkt7/UAkATibzvqT31eY71lAp7YdPzfbKDpmbHN9+AQWFh/Ac6tYkL2J1sipJ7tU4IK48w0YxuRW9aI//veFA=="}}}'
    Write-Fixture $lock $lockText
    Write-Fixture (Join-Path $fixture '.state\account.json') 'must-not-copy'
    Write-Fixture (Join-Path $fixture '.env') 'must-not-copy'
    $node=Join-Path $testRoot 'node.exe';Write-Fixture $node 'offline executable metadata fixture'
    $GuestScript=Join-Path $testRoot 'Guest.ps1';Write-Fixture $GuestScript 'param($RequestPath) # offline guest'
    $relayGuestHash=Get-RelayHash $GuestScript
    $wrapperA=Join-Path $testRoot 'wrapper-a.ps1';$wrapperB=Join-Path $testRoot 'wrapper-b.ps1'
    Write-Fixture $wrapperA '# offline wrapper';Write-Fixture $wrapperB '# offline wrapper'
    $relayInvoker=@{Path=$wrapperA;SHA256=(Get-RelayHash $wrapperA)}
    Require ($relayModels -is [array] -and $relayModels.Count -eq 3 -and
        ($relayModels.id -join ',') -ceq 'claude/opus,claude/sonnet,claude/haiku' -and
        ($relayModels.upstream -join ',') -ceq 'opus,sonnet,haiku') 'The default relay model aliases changed.'
    $passed++

    $catalogA=Join-Path $testRoot 'models-a.json';$catalogB=Join-Path $testRoot 'models-b.json'
    Write-Fixture $catalogA '[{"upstream":"claude-opus-future","name":"Original Opus","id":"native/opus"}]'
    Write-Fixture $catalogB '[{"id":"native/opus","name":"Original Opus","upstream":"claude-opus-future"}]'
    $custom=Read-RelayModels $catalogA
    Require ($custom -is [array] -and $custom.Count -eq 1 -and
        ($custom[0].Keys -join ',') -ceq 'id,name,upstream' -and $custom[0].upstream -ceq 'claude-opus-future') 'A single custom model lost its array shape or stable property order.'
    Write-Fixture $catalogB '[{"id":"native/opus","name":"Original Opus","upstream":"opus[1m]"},{"id":"claude/opus","name":"Legacy Opus","upstream":"opus[1m]"}]'
    $aliases=Read-RelayModels $catalogB
    Require ($aliases.Count -eq 2 -and $aliases[1].id -ceq 'claude/opus' -and $aliases[0].upstream -ceq $aliases[1].upstream) 'Distinct model aliases cannot share a valid upstream.'
    $passed++

    $catalogCase=0
    foreach($invalid in @('null','{}','[]','[null]','["model"]','[[{"id":"native/opus","name":"Original Opus","upstream":"opus"}]]',
        '[{"id":"native/opus","name":"Original Opus"}]',
        '[{"id":"native/opus","name":"Original Opus","upstream":"opus","extra":true}]',
        '[{"Id":"native/opus","name":"Original Opus","upstream":"opus"}]',
        '[{"id":1,"name":"Original Opus","upstream":"opus"}]',
        '[{"id":"native/opus","name":"","upstream":"opus"}]',
        '[{"id":"native/opus","name":" Original Opus","upstream":"opus"}]',
        '[{"id":"native/opus","name":"Original\nOpus","upstream":"opus"}]',
        '[{"id":"native/opus","name":"Original Opus","upstream":false}]',
        '[{"id":"native/opus","name":"Original Opus","upstream":"opus --flag"}]',
        '[{"id":"native/opus","name":"Original Opus","upstream":"opus"},{"id":"native/opus","name":"Duplicate","upstream":"sonnet"}]',
        '[{"id":"native/opus","name":"Original Opus","upstream":"opus"}')){
        $catalogCase++;Write-Fixture $catalogB $invalid
        try{Must-Fail {Read-RelayModels $catalogB}}catch{throw ('Model catalog rejection case '+$catalogCase+' failed: '+$_.Exception.Message)}
    }
    $many=@(for($i=0;$i -lt 65;$i++){[ordered]@{id=('model-'+$i);name='Model';upstream='opus'}})
    Write-Fixture $catalogB (ConvertTo-Json -InputObject $many -Depth 5);Must-Fail {Read-RelayModels $catalogB}
    Write-Fixture $catalogB ('x'*65537);Must-Fail {Read-RelayModels $catalogB}
    foreach($field in @('id','name','upstream')){
        $tooLong=[ordered]@{id='model';name='Model';upstream='opus'};$tooLong[$field]='x'*257
        Write-Fixture $catalogB (ConvertTo-Json -InputObject @($tooLong) -Depth 5);Must-Fail {Read-RelayModels $catalogB}
    }
    Must-Fail {Read-RelayModels 'relative-models.json'};Must-Fail {Read-RelayModels (Join-Path $testRoot 'absent.json')}
    $passed++

    $package=Get-RelayPackage $fixture $node
    Require ((Get-RelayPackage ($fixture+'\') $node).BundleHash -ceq $package.BundleHash) 'A trailing source directory separator changed dependency paths.'
    Require (@($package.Manifest|Where-Object{$_.Path -cin @('app/src/relay-control.mjs','app/src/models.mjs')}).Count -eq 2) 'The transitive relay source closure was incomplete.'
    Require (@($package.Manifest|Where-Object{$_.Path -match '\.state|\.env'}).Count -eq 0) 'Unrelated account or environment files entered the relay package.'
    $passed++

    $bundle=Join-Path $testRoot 'bundle.zip';New-RelayBundle $package $bundle
    $stream=[IO.File]::OpenRead($bundle);$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Read,$false)
    try{
        Require ($zip.Entries.Count -eq ($package.FileCount+1) -and $null -ne $zip.GetEntry('app/src/relay-control.mjs')) 'The reviewed dependency bundle did not preserve all source entries.'
        $reader=New-Object IO.StreamReader($zip.GetEntry('manifest.json').Open())
        try{$manifest=$reader.ReadToEnd()|ConvertFrom-Json;$manifest=@($manifest)}finally{$reader.Dispose()}
        Require ((Get-RelayTextHash ($manifest|ConvertTo-Json -Depth 5 -Compress)) -ceq $package.BundleHash) 'Archive metadata no longer matched its reviewed digest.'
    }finally{$zip.Dispose();$stream.Dispose()}
    $passed++

    Write-Fixture $lock ($lockText.Replace('0.3.304','0.3.999'))
    Must-Fail {Get-RelayPackage $fixture $node};Write-Fixture $lock $lockText
    Write-Fixture (Join-Path $fixture 'src\models.mjs') '# changed public source'
    Must-Fail {New-RelayBundle $package (Join-Path $testRoot 'changed.zip')}
    $passed++

    $junction=Join-Path $fixture 'node_modules\redirected'
    New-Item -ItemType Junction -Path $junction -Target (Join-Path $fixture '.state')|Out-Null
    Must-Fail {Get-RelayPackage $fixture $node};[IO.Directory]::Delete($junction);$junction=$null
    foreach($badPath in @('relative.ps1','C:\fixture\file:stream','C:\fixture\bad"name.ps1')){Must-Fail {Assert-RelayLocalPath $badPath}}
    $passed++

    $package=Get-RelayPackage $fixture $node
    $planA=Get-RelayVmPlan $package
    $relayInvoker=@{Path=$wrapperB;SHA256=(Get-RelayHash $wrapperB)};$planB=Get-RelayVmPlan $package
    Require ($planA.PlanHash -cne $planB.PlanHash -and $planA.CopiesGatewayKey -and -not $planA.CopiesOAuth) 'A reviewed plan lost its VM target or account export boundary.'
    $relayGuestHash=('F'*64);$planC=Get-RelayVmPlan $package
    Require ($planB.PlanHash -cne $planC.PlanHash) 'Editing the guest deployment helper did not invalidate the reviewed plan.'
    $relayGuestHash=Get-RelayHash $GuestScript;$passed++

    $relayModels=Read-RelayModels $catalogA;$modelPlanA=Get-RelayVmPlan $package
    Write-Fixture $catalogB '[{"id":"native/opus","name":"Original Opus","upstream":"claude-opus-future"}]'
    $relayModels=Read-RelayModels $catalogB;$modelPlanB=Get-RelayVmPlan $package
    Require ($modelPlanA.PlanHash -ceq $modelPlanB.PlanHash -and $modelPlanB.Models[0].upstream -ceq 'claude-opus-future') 'Catalog property order or source path changed a normalized plan.'
    foreach($field in @('id','name','upstream')){
        $changed=[ordered]@{id='native/opus';name='Original Opus';upstream='claude-opus-future'};$changed[$field]+='-changed'
        $relayModels=ConvertTo-RelayModels @($changed)
        Require ((Get-RelayVmPlan $package).PlanHash -cne $modelPlanB.PlanHash) 'A model catalog change did not invalidate the reviewed plan.'
    }
    $relayModels=Read-RelayModels;$passed++

    $relayInvoker=@{Path=$wrapperA;SHA256=(Get-RelayHash $wrapperA)}
    Write-Fixture $wrapperA '$script:unexpectedWrapperRan=$true'
    $script:unexpectedWrapperRan=$false;Must-Fail {Invoke-RelayVm 'runProgramInGuest' @('never-run')}
    Require (-not $script:unexpectedWrapperRan) 'A stale VM wrapper was executed.';$passed++

    Set-RelayPrivateDirectory $StateDir
    $script:transportCount=0;$script:exportCount=0;$script:wrongKeyPath=$false;$script:invalidKey=$false
    $runTransport={
        param([string]$Operation)
        function Invoke-RelayVm([string]$Operation,[string[]]$Arguments){
            $script:transportCount++
            if($Operation -ceq 'copyFileFromHostToGuest'){
                Require ([IO.File]::Exists($Arguments[0])) 'The transfer source was not a real reviewed file.'
                if($Arguments[0] -like '*\request.json'){$script:transferredModels=(Get-Content -LiteralPath $Arguments[0] -Raw|ConvertFrom-Json).Models}
            }elseif($Operation -ceq 'copyFileFromGuestToHost'){
                if($Arguments[0] -like '*.result.json'){
                    $keyPath=Join-Path $GuestHome 'AppData\Local\CodexAccountBridge\ClaudeRelay\data\gateway.key'
                    if($script:wrongKeyPath){$keyPath='C:\Users\Developer\.claude\.credentials.json'}
                    [IO.File]::WriteAllText($Arguments[1],(@{Success=$true;GatewayKeyFile=$keyPath}|ConvertTo-Json),$relayUtf8)
                }else{
                    Require ($Arguments[0] -ceq (Join-Path $GuestHome 'AppData\Local\CodexAccountBridge\ClaudeRelay\data\gateway.key')) 'The adapter tried to export an account credential.'
                    $script:exportCount++;$key=('K'*64);if($script:invalidKey){$key='invalid'}
                    [IO.File]::WriteAllText($Arguments[1],$key,$relayUtf8)
                }
            }elseif($Operation -cne 'runProgramInGuest'){throw 'An unexpected VM operation reached the transport fixture.'}
        }
        & $invokeRequest $Operation $package
    }
    $null=& $runTransport 'Plan'
    Require ($script:transportCount -gt 0 -and $script:exportCount -eq 0) 'Plan exported a secret or skipped its public metadata transport.';$passed++
    Require ($script:transferredModels.Count -eq 3 -and $script:transferredModels[2].id -ceq 'claude/haiku') 'The default catalog did not enter the guest request.'
    $relayModels=Read-RelayModels $catalogA;$null=& $runTransport 'Plan'
    Require ($script:transferredModels -is [array] -and $script:transferredModels.Count -eq 1 -and
        $script:transferredModels[0].id -ceq 'native/opus' -and $script:transferredModels[0].upstream -ceq 'claude-opus-future') 'A custom single-model catalog was not transferred as an array.'
    $relayModels=Read-RelayModels;$passed++
    $script:wrongKeyPath=$true;Must-Fail {& $runTransport 'Prepare'}
    Require ($script:exportCount -eq 0) 'An unexpected account key path was copied before validation.';$script:wrongKeyPath=$false;$passed++
    $result=& $runTransport 'Prepare'
    $keyAcl=New-Object Security.AccessControl.FileSecurity;$keyAcl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
        [void]$keyAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow')))
    }
    [void]$keyAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Read','Allow')))
    $keyInfo=New-Object IO.FileInfo($result.HostGatewayKeyFile)
    if($PSVersionTable.PSEdition -eq 'Core'){[IO.FileSystemAclExtensions]::SetAccessControl($keyInfo,$keyAcl)}else{$keyInfo.SetAccessControl($keyAcl)}
    $result=& $runTransport 'Prepare'
    Require ($script:exportCount -eq 2 -and [IO.File]::ReadAllText($result.HostGatewayKeyFile) -ceq ('K'*64)) 'Gateway key creation or atomic replacement failed.';$passed++
    $keyAcl=Get-Acl -LiteralPath $result.HostGatewayKeyFile
    $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    Require ($keyAcl.AreAccessRulesProtected -and @($keyAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -cnotin $allowed}).Count -eq 0) 'A replaced gateway key retained a broad explicit access rule.';$passed++
    $script:invalidKey=$true;Must-Fail {& $runTransport 'Prepare'}
    Require ([IO.File]::ReadAllText((Join-Path $StateDir 'gateway.key')) -ceq ('K'*64)) 'A malformed export replaced the previous private gateway key.';$script:invalidKey=$false;$passed++
    $savedCount=$script:transportCount;$relayGuestHash=('E'*64);Must-Fail {& $runTransport 'Plan'}
    Require ($script:transportCount -eq $savedCount) 'An unreviewed guest script reached the VM transport.';$passed++
    [ordered]@{Passed=$passed;Shell=[string]$PSVersionTable.PSVersion;VmInvoked=$false;NetworkAccess=$false;RealInference=$false}|ConvertTo-Json -Compress
}finally{
    $absolute=[IO.Path]::GetFullPath($testRoot);$prefix=$project.TrimEnd('\')+'\.state\'
    if(-not $absolute.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($absolute) -cnotmatch '^relay-vm-host-test-[a-f0-9]{32}$'){throw 'Unsafe relay fixture cleanup target.'}
    if($junction -and [IO.Directory]::Exists($junction)){[IO.Directory]::Delete($junction)}
    if([IO.Directory]::Exists($absolute)){
        if((Get-Item -LiteralPath $absolute -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The fixture root became a reparse point.'}
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}
