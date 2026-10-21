[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [ValidateSet('Plan','Apply')][string]$Action='Plan',
    [string]$VmInvoker='C:\Users\jiahaoguo\Documents\Codex\2026-09-30\vps-https-www-voyracloud-com-zh\work\vm-build\Invoke-WorkspaceVm.ps1',
    [string]$GuestHome='C:\Users\Developer'
)

# Deployment copies public scripts only. It neither switches mode nor starts Claude.
$ErrorActionPreference='Stop'
$sourceNames=@('ClaudeModeCore.ps1','Switch-ClaudeMode.ps1','Install-ClaudeModeShortcuts.ps1')
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($GuestHome -cne 'C:\Users\Developer'){throw 'This installer targets the existing Claude Workspace VM only.'}
$plan=[ordered]@{
    GuestHome=$GuestHome
    InstallDirectory=(Join-Path $GuestHome 'AppData\Local\CodexWithGateway\tools')
    Sources=$sourceNames
    Modes=@('Account','CodeBuddy')
    LaunchClaude=$false
    SwitchMode=$false
    RealInference=$false
}
if($Action -ceq 'Plan' -or -not $PSCmdlet.ShouldProcess('Claude Workspace VM desktop mode shortcuts','Install')){
    $plan|ConvertTo-Json -Depth 6
    return
}
if(-not (Test-Path -LiteralPath $VmInvoker -PathType Leaf)){throw 'The existing VM wrapper is unavailable.'}
foreach($name in $sourceNames){
    $source=Join-Path $PSScriptRoot $name
    if(-not (Test-Path -LiteralPath $source -PathType Leaf)){throw 'A public shortcut source file is missing.'}
    $tokens=$null;$errors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'A shortcut script has a syntax error.'}
}
function Invoke-ModeVm([string]$Operation,[string[]]$Arguments){
    & $VmInvoker -Operation $Operation -OperationArguments $Arguments
    if($LASTEXITCODE -ne 0){throw 'VM shortcut deployment did not complete. No retry or application launch was attempted.'}
}
function Quote-ModeLiteral([string]$Value){return "'"+$Value.Replace("'","''")+"'"}

$stageId=[guid]::NewGuid().ToString('N')
$guestStage=Join-Path $GuestHome ('AppData\Local\Temp\ClaudeModeShortcuts-'+$stageId)
$guestReport=Join-Path $guestStage 'install-result.json'
$hostState=Join-Path $projectRoot '.state'
[IO.Directory]::CreateDirectory($hostState)|Out-Null
$hostReport=Join-Path $hostState ('claude-mode-shortcuts-'+$stageId+'.json')
$guestPowerShell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$staged=$false
try {
    $create="`$ErrorActionPreference='Stop';if(`$env:COMPUTERNAME -cne 'CLAUDE-DEV-VM' -or `$env:USERPROFILE -cne "+(Quote-ModeLiteral $GuestHome)+"){throw 'Unexpected guest.'};[IO.Directory]::CreateDirectory("+(Quote-ModeLiteral $guestStage)+")|Out-Null"
    Invoke-ModeVm 'runProgramInGuest' @($guestPowerShell,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',$create)
    $staged=$true
    foreach($name in $sourceNames){Invoke-ModeVm 'copyFileFromHostToGuest' @((Join-Path $PSScriptRoot $name),(Join-Path $guestStage $name))}
    $guestExecutionFailed=$false
    try {Invoke-ModeVm 'runProgramInGuest' @($guestPowerShell,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $guestStage 'Install-ClaudeModeShortcuts.ps1'),'-SourceDirectory',$guestStage,'-ReportPath',$guestReport)}
    catch {$guestExecutionFailed=$true}
    Invoke-ModeVm 'copyFileFromGuestToHost' @($guestReport,$hostReport)
    $result=Get-Content -LiteralPath $hostReport -Raw|ConvertFrom-Json
    if($guestExecutionFailed -or $result.Success -ne $true){throw 'Shortcut installation failed. Sanitized report retained in the project state directory.'}
    [IO.File]::WriteAllText((Join-Path $hostState 'claude-mode-shortcuts-installed.json'),([IO.File]::ReadAllText($hostReport)),(New-Object Text.UTF8Encoding($false)))
    $result
} finally {
    if($staged){
        # Remove only the named staging files. Unknown files keep the directory intact.
        $expectedPrefix=Join-Path $GuestHome 'AppData\Local\Temp\ClaudeModeShortcuts-'
        if($guestStage -cne ($expectedPrefix+$stageId) -or $stageId -cnotmatch '^[0-9a-f]{32}$'){throw 'Unexpected VM staging path; cleanup refused.'}
        $knownPaths=@($sourceNames|ForEach-Object{Join-Path $guestStage $_})+@($guestReport)
        $quoted=@($knownPaths|ForEach-Object{Quote-ModeLiteral $_}) -join ','
        $cleanup="`$ErrorActionPreference='Stop';foreach(`$entry in @("+$quoted+")){if([IO.File]::Exists(`$entry)){Remove-Item -LiteralPath `$entry -Force}};if([IO.Directory]::Exists("+(Quote-ModeLiteral $guestStage)+") -and @(Get-ChildItem -LiteralPath "+(Quote-ModeLiteral $guestStage)+" -Force).Count -eq 0){Remove-Item -LiteralPath "+(Quote-ModeLiteral $guestStage)+" -Force}"
        try {Invoke-ModeVm 'runProgramInGuest' @($guestPowerShell,'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',$cleanup)}catch{Write-Warning 'Public staging files could not be cleaned up; the installed shortcuts are unaffected.'}
    }
}
