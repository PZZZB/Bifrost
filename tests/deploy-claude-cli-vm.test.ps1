[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source=Join-Path $projectRoot 'scripts\Deploy-ClaudeCliVm.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) {throw 'The VM CLI adapter does not parse.'}
$literal=$ast.Find({param($node)$node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'SingleQuotedHereString'},$true)
$guestTokens=$null;$guestErrors=$null
$guestAst=[Management.Automation.Language.Parser]::ParseInput($literal.Value,[ref]$guestTokens,[ref]$guestErrors)
if ($guestErrors.Count) {throw 'The VM CLI adapter guest payload does not parse.'}
foreach ($definition in $guestAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
    if ($definition.Name -cin @('Assert-LocalPath','Get-FileDigest','Write-AtomicBytes','Assert-ManagedFiles','Public-Backend','New-LoginShortcut')) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
}
foreach ($definition in $ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
    if ($definition.Name -cin @('Get-CliVmHash','Get-CliVmTextHash','Get-CliVmInvokerIdentity','Assert-CliVmInvokerIdentity','Invoke-CliVm','Invoke-CliVmRequest','Get-CliVmPlan')) {
        . ([scriptblock]::Create($definition.Extent.Text))
    }
}
$invokeTransfer=(Get-Item Function:\Invoke-CliVmRequest).ScriptBlock
function Invoke-CliVmRequest([string]$GuestAction,$Source,$Reviewed=$null) {
    if ($GuestAction -cne 'Plan') {throw 'An offline VM test cannot invoke an operation.'}
    return [pscustomobject]@{RuntimeRoot='C:\Users\Developer\private-cli';ScriptPath='C:\Users\Developer\tools\OfficialClaudeCli.ps1';
        LoginShortcut='C:\Users\Developer\Desktop\Claude CLI - Login.lnk';Snapshot=@{ManifestHash=$null;ScriptHash=$null;ShortcutHash=$null};
        OfficialPlanHash=('A'*64);CliVersion='2.1.304';CliPath='C:\Users\Developer\private-cli\bin\claude.exe';
        ExistingDeployment=$false;IsAdministrator=$false;Addresses=@('192.168.168.10')}
}
$utf8=New-Object Text.UTF8Encoding($false)
$testRoot=Join-Path $projectRoot ('.state\cli-vm-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
$passed=0
try {
    $inside=Join-Path $testRoot 'owned.ps1'
    if ((Assert-LocalPath $inside $testRoot) -cne $inside) {throw 'An owned child path was rejected.'}
    foreach ($path in @($testRoot,(Join-Path $testRoot '..\outside.ps1'))) {
        $rejected=$false
        try {Assert-LocalPath $path $testRoot|Out-Null}catch{$rejected=$true}
        if (-not $rejected) {throw 'An out-of-scope deployment path was accepted.'}
    }
    $passed++
    Write-AtomicBytes $inside $utf8.GetBytes('first') $null
    $originalHash=Get-FileDigest $inside
    Write-AtomicBytes $inside $utf8.GetBytes('second') $originalHash
    $rejected=$false
    try {Write-AtomicBytes $inside $utf8.GetBytes('must-not-overwrite') $originalHash}catch{$rejected=$true}
    if (-not $rejected -or [IO.File]::ReadAllText($inside) -cne 'second') {throw 'The deployment write did not preserve a concurrent file change.'}
    $passed++
    $installedScript=$inside
    $loginShortcut=Join-Path $testRoot 'Claude CLI - Login.lnk'
    $rejected=$false
    try {Assert-ManagedFiles $null}catch{$rejected=$true}
    if (-not $rejected) {throw 'An existing script was accepted without ownership.'}
    $manifest=[pscustomobject]@{Phase='installed';Script=[pscustomobject]@{SHA256=(Get-FileDigest $inside)};Shortcut=[pscustomobject]@{SHA256=$null}}
    Assert-ManagedFiles $manifest
    [IO.File]::WriteAllText($inside,'external edit',$utf8)
    $rejected=$false
    try {Assert-ManagedFiles $manifest}catch{$rejected=$true}
    if (-not $rejected) {throw 'An edited owned script was accepted for replacement or restore.'}
    $passed++
    $manifest.Phase='preparing'
    $manifest.Script|Add-Member NoteProperty PreviousSHA256 (Get-FileDigest $inside)
    Assert-ManagedFiles $manifest
    $manifest.Phase='installed';$rejected=$false
    try {Assert-ManagedFiles $manifest}catch{$rejected=$true}
    if (-not $rejected) {throw 'A previous script hash remained valid after the prepare journal was committed.'}
    $passed++
    $public=Public-Backend ([pscustomobject]@{Prepared=$true;LoginRunning=$false;SubscriptionAuthenticated=$false;
        RuntimeRoot='C:\private-cli';CliPath='C:\private-cli\bin\claude.exe';ClaudeCodeVersion='2.1.304';
        email='must-not-copy';access_token='must-not-copy';RawConfig=@{secret='must-not-copy'}})
    if (($public|ConvertTo-Json -Depth 8 -Compress) -match 'must-not-copy' -or $public.Prepared -ne $true) {throw 'Public VM CLI metadata included private source fields.'}
    $passed++
    $runtimeRoot=Join-Path $testRoot 'OfficialClaudeCli'
    $tools=$testRoot
    New-LoginShortcut $loginShortcut
    $shell=New-Object -ComObject WScript.Shell
    try {
        $shortcut=$shell.CreateShortcut($loginShortcut)
        try {
            if ($shortcut.WindowStyle -ne 1 -or $shortcut.Arguments -notlike '*-Action Login*' -or
                $shortcut.Arguments -notlike '*-Interactive*' -or $shortcut.Arguments -notlike '*-NoExit*') {throw 'The VM login shortcut does not open a visible interactive official login.'}
        }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)}
    }finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}
    $passed++
    $startGuard=$ast.Find({param($node)$node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains('The self-developed VM CLI relay has not been connected yet.')},$true)
    if (-not $startGuard) {throw 'The VM adapter does not explicitly refuse its unimplemented relay start.'}
    $Action='Start';$rejected=$false
    try {& ([scriptblock]::Create($startGuard.Extent.Text))}catch{$rejected=$true}
    if (-not $rejected) {throw 'The VM adapter reported a relay start before the relay was implemented.'}
    $passed++
    if ($literal.Value -match '(?i)magpie|Get-NetFirewall|Set-NetFirewall|New-NetFirewall|copyFileFromGuestToHost') {throw 'The official CLI-only guest adapter retained an unrelated runtime, firewall mutation, or private-file copy path.'}
    $passed++
    $wrapperDirectory=Join-Path $testRoot 'wrapper-files'
    [void][IO.Directory]::CreateDirectory($wrapperDirectory)
    $wrapperA=Join-Path $wrapperDirectory 'first.ps1'
    $wrapperB=Join-Path $wrapperDirectory 'second.ps1'
    [IO.File]::WriteAllText($wrapperA,'# offline wrapper fixture',$utf8)
    [IO.File]::WriteAllText($wrapperB,'# offline wrapper fixture',$utf8)
    $identityA=Get-CliVmInvokerIdentity (Join-Path $wrapperDirectory '.\first.ps1')
    if ($identityA.Path -cne $wrapperA -or $identityA.SHA256 -cne (Get-FileHash -LiteralPath $wrapperA -Algorithm SHA256).Hash) {throw 'The VM wrapper identity is not an absolute, hashed file.'}
    Assert-CliVmInvokerIdentity $identityA
    $rejected=$false
    try {Get-CliVmInvokerIdentity $wrapperDirectory|Out-Null}catch{$rejected=$true}
    if (-not $rejected) {throw 'A directory was accepted as an executable VM wrapper.'}
    $passed++
    $product='CodexAccountBridge.OfficialClaudeCliVm';$GuestHome='C:\Users\Developer'
    $fixtureSource=@{Hash=('B'*64)}
    $invokerIdentity=$identityA
    $planA=Get-CliVmPlan $fixtureSource
    $invokerIdentity=Get-CliVmInvokerIdentity $wrapperB
    $planB=Get-CliVmPlan $fixtureSource
    if ($planA.PlanHash -ceq $planB.PlanHash -or $planA.VmInvoker.Path -cne $wrapperA -or $planA.VmInvoker.SHA256 -cne $identityA.SHA256) {throw 'A reviewed plan did not bind the selected wrapper path and checksum.'}
    [IO.File]::WriteAllText($wrapperA,'$script:offlineWrapperRan=$true',$utf8)
    $invokerIdentity=Get-CliVmInvokerIdentity $wrapperA
    $changedPlan=Get-CliVmPlan $fixtureSource
    if ($planA.PlanHash -ceq $changedPlan.PlanHash) {throw 'Editing the VM target wrapper did not invalidate the reviewed plan.'}
    $passed++
    $invokerIdentity=$identityA;$offlineWrapperRan=$false
    $rejected=$false
    try {Invoke-CliVm 'runProgramInGuest' @('must-not-run')}catch{$rejected=$true}
    if (-not $rejected -or $offlineWrapperRan) {throw 'A changed wrapper ran after its reviewed identity became stale.'}
    $passed++
    $wrapperJunction=Join-Path $testRoot 'wrapper-junction'
    New-Item -ItemType Junction -Path $wrapperJunction -Target $wrapperDirectory|Out-Null
    $rejected=$false
    try {Get-CliVmInvokerIdentity (Join-Path $wrapperJunction 'first.ps1')|Out-Null}catch{$rejected=$true}
    if (-not $rejected -or -not [IO.File]::Exists($wrapperA)) {throw 'A wrapper below a redirected directory was accepted or its target changed.'}
    $passed++
    $GuestAdapterSource=$literal.Value
    $StateDir=Join-Path $testRoot 'transfer-state'
    [void][IO.Directory]::CreateDirectory($StateDir)
    $script:transportedAdapter=$false
    $transferResult=& {
        function Set-CliVmPrivateDirectory([string]$Path) {[void][IO.Directory]::CreateDirectory($Path)}
        function Invoke-CliVm([string]$Operation,[string[]]$Arguments) {
            if ($Operation -ceq 'copyFileFromHostToGuest' -and [IO.Path]::GetFileName($Arguments[0]) -ceq 'adapter.ps1') {
                $rendered=[IO.File]::ReadAllText($Arguments[0])
                $renderTokens=$null;$renderErrors=$null
                $renderAst=[Management.Automation.Language.Parser]::ParseInput($rendered,[ref]$renderTokens,[ref]$renderErrors)
                if ($rendered -cne $GuestAdapterSource -or $renderErrors.Count -or $null -eq $renderAst.ParamBlock -or
                    $renderAst.ParamBlock.Parameters[0].Name.VariablePath.UserPath -cne 'RequestPath') {
                    throw 'The transferred VM adapter contains a target path instead of its reviewed script body.'
                }
                $script:transportedAdapter=$true
            } elseif ($Operation -ceq 'copyFileFromGuestToHost') {
                [IO.File]::WriteAllText($Arguments[1],'{"Success":true,"Action":"Plan"}',$utf8)
            } elseif ($Operation -cnotin @('copyFileFromHostToGuest','runProgramInGuest')) {
                throw 'The offline transport fixture requested an unexpected VM operation.'
            }
        }
        & $invokeTransfer 'Plan' @{Path=$wrapperB;Hash=(Get-CliVmHash $wrapperB)}
    }
    if (-not $script:transportedAdapter -or $transferResult.Success -ne $true) {throw 'The offline VM transport did not preserve the complete adapter source.'}
    $passed++
    [ordered]@{Passed=$passed;HostAstErrors=$parseErrors.Count;GuestAstErrors=$guestErrors.Count;GuestInvoked=$false;FirewallChanged=$false;RealInference=$false}|ConvertTo-Json -Compress
}finally{
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $prefix=$projectRoot.TrimEnd('\')+'\.state\'
    if (-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -cnotmatch '^cli-vm-test-[a-f0-9]{32}$') {throw 'Unsafe offline test cleanup path.'}
    if ($wrapperJunction -and [IO.Directory]::Exists($wrapperJunction)) {[IO.Directory]::Delete($wrapperJunction)}
    foreach ($path in @($inside,$loginShortcut,$wrapperA,$wrapperB)) {if ([IO.File]::Exists($path)){Remove-Item -LiteralPath $path -Force}}
    if ($wrapperDirectory -and [IO.Directory]::Exists($wrapperDirectory) -and @(Get-ChildItem -LiteralPath $wrapperDirectory -Force).Count -eq 0) {Remove-Item -LiteralPath $wrapperDirectory -Force}
    if ($StateDir -and [IO.Directory]::Exists($StateDir) -and @(Get-ChildItem -LiteralPath $StateDir -Force).Count -eq 0) {Remove-Item -LiteralPath $StateDir -Force}
    if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -eq 0) {Remove-Item -LiteralPath $resolved -Force}
}
