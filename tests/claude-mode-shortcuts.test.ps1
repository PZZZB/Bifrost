param()
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherFile = Join-Path $project 'scripts\Switch-ClaudeMode.ps1'
$installerFile = Join-Path $project 'scripts\Install-ClaudeModeShortcuts.ps1'
$root = Join-Path $project ('.state\claude-shortcut-fixture-' + [guid]::NewGuid().ToString('N'))
$encoding = New-Object Text.UTF8Encoding($true)
$passed = 0
function Check([bool]$Value, [string]$Reason) { if (-not $Value) { throw $Reason } }
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function Expect-Failure([scriptblock]$Code) { $refused=$false; try { & $Code | Out-Null } catch { $refused=$true }; Check $refused 'Expected failure was not raised.' }
function Write-Text([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,$encoding) }
$oldLocal = $env:LOCALAPPDATA; $oldTrace = $env:CLAUDE_FIXTURE_TRACE
try {
 [IO.Directory]::CreateDirectory($root) | Out-Null
 $sources = Join-Path $root 'source scripts'; [IO.Directory]::CreateDirectory($sources) | Out-Null
 $desktop = Join-Path $root 'redirected desktop'; [IO.Directory]::CreateDirectory($desktop) | Out-Null
 $env:LOCALAPPDATA = Join-Path $root 'local app data'; [IO.Directory]::CreateDirectory($env:LOCALAPPDATA) | Out-Null
 $env:CLAUDE_FIXTURE_TRACE = Join-Path $root 'core-invoked.txt'
 $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $stub = @"
function Set-ClaudeDesktopMode {
 param([string]`$Mode)
 [IO.File]::WriteAllText(`$env:CLAUDE_FIXTURE_TRACE,`$Mode)
 return [pscustomobject]@{Success=`$true;Mode=`$Mode;DeploymentMode=if(`$Mode -eq 'Account'){'1p'}else{'3p'};Changed=`$true;RestartRequired=`$true}
}
"@
 [IO.File]::Copy($launcherFile,(Join-Path $sources 'Switch-ClaudeMode.ps1'))
 Write-Text (Join-Path $sources 'ClaudeModeCore.ps1') $stub
 $variant = Join-Path $root 'Install-OfflineFixture.ps1'
 $installerText = [IO.File]::ReadAllText($installerFile)
 $needle = '[Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)'
 Check $installerText.Contains($needle) 'Real desktop resolver was not located.'
 Write-Text $variant ($installerText.Replace($needle, ("'" + $desktop.Replace("'", "''") + "'")))
 $reportPath = Join-Path $root 'report.json'
 & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $variant -SourceDirectory $sources -ReportPath $reportPath | Out-Null
 Check ($LASTEXITCODE -eq 0) 'Initial isolated installation failed.'
 $report = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
 Check ($report.Success -and $report.DesktopPath -ceq $desktop -and @($report.Shortcuts).Count -eq 2 -and @($report.InstalledFilesHashes).Count -eq 2) 'Unexpected safe report fields.'
 Check (@($report.Shortcuts.Name|Where-Object{$_ -cmatch '[^\x20-\x7E]'}).Count -eq 0 -and @($report.Shortcuts.Name) -ccontains 'Claude - Account.lnk' -and @($report.Shortcuts.Name) -ccontains 'Claude - CodeBuddy.lnk') 'Shortcut filenames must remain the two ASCII names for guest COM compatibility.'
 Check (-not [IO.File]::Exists($env:CLAUDE_FIXTURE_TRACE)) 'Installer executed the mode core.'
 $tools = Join-Path $env:LOCALAPPDATA 'CodexWithGateway\tools'
 $shell = New-Object -ComObject WScript.Shell
 try {
  foreach ($shortcut in $report.Shortcuts) {
   $lnk = $shell.CreateShortcut((Join-Path $desktop $shortcut.Name))
   try {
    Check ($lnk.TargetPath -ieq $powershellPath -and $lnk.Arguments -ceq $shortcut.Arguments -and $lnk.WorkingDirectory -ieq $tools) 'Shortcut COM readback mismatch.'
    Check ($lnk.Arguments.Contains('-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "')) 'Shortcut flags/quoting missing.'
   } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($lnk) }
  }
 } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
 foreach ($installed in $report.InstalledFilesHashes) { Check ((Hash (Join-Path $tools $installed.Name)) -ceq $installed.SHA256) 'Installed script hash mismatch.' }
 $passed++
 $unrelated = Join-Path $tools 'unrelated.txt'; Write-Text $unrelated 'keep'; $unrelatedHash=Hash $unrelated
 Write-Text (Join-Path $sources 'ClaudeModeCore.ps1') ($stub + "`n# updated fixture")
 & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $variant -SourceDirectory $sources -ReportPath $reportPath | Out-Null
 Check ($LASTEXITCODE -eq 0 -and (Hash $unrelated) -ceq $unrelatedHash) 'Owned update failed or changed an unrelated file.'
 Check ((Hash (Join-Path $tools 'ClaudeModeCore.ps1')) -ceq (Hash (Join-Path $sources 'ClaudeModeCore.ps1'))) 'Owned core update did not install.'
 Check (-not [IO.File]::Exists($env:CLAUDE_FIXTURE_TRACE)) 'Update executed mode core.'
 $passed++
 $manifest = Join-Path $tools 'claude-mode-shortcuts.install.json'; $manifestHash=Hash $manifest
 $links=@(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk'); $tampered=$links[0].FullName; Write-Text $tampered 'unknown replacement'; $tamperedHash=Hash $tampered
 $otherLink=$links[1].FullName; $otherHash=Hash $otherLink
 $ErrorActionPreference = 'Continue'
 & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $variant -SourceDirectory $sources -ReportPath $reportPath 2>$null | Out-Null
 $ErrorActionPreference = 'Stop'
 Check ($LASTEXITCODE -ne 0) 'A modified same-name link was overwritten.'
 $report=[IO.File]::ReadAllText($reportPath)|ConvertFrom-Json
 Check (-not $report.Success -and (Hash $tampered) -ceq $tamperedHash -and (Hash $otherLink) -ceq $otherHash -and (Hash $manifest) -ceq $manifestHash) 'Conflict changed existing files.'
 Check ($report.Stage -ceq 'CheckOwnership' -and $report.ErrorCode -ceq 'OWNERSHIP_CONFLICT') 'Ownership conflict did not retain a fixed diagnostic code/stage.'
 $passed++
 # Return to a fresh fixture directory, then fault after the first committed file.
 $env:LOCALAPPDATA=Join-Path $root 'rollback local'; [IO.Directory]::CreateDirectory($env:LOCALAPPDATA)|Out-Null
 $desktop2=Join-Path $root 'rollback desktop'; [IO.Directory]::CreateDirectory($desktop2)|Out-Null
 $writePoint='Write-ShortcutBytes $change.Path $change.Bytes $change.ExpectedHash'
 Check $installerText.Contains($writePoint) 'Atomic commit site not located.'
 $faulty=$installerText.Replace($needle,("'"+$desktop2.Replace("'","''")+"'"))
 $faulty=$faulty.Replace($writePoint, ($writePoint + "; if (`$change.Path.EndsWith('Switch-ClaudeMode.ps1')) { throw 'fixture post-write failure' }"))
 $faultyPath=Join-Path $root 'Install-FaultFixture.ps1'; Write-Text $faultyPath $faulty
 $ErrorActionPreference = 'Continue'
 & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $faultyPath -SourceDirectory $sources -ReportPath $reportPath 2>$null | Out-Null
 $ErrorActionPreference = 'Stop'
 Check ($LASTEXITCODE -ne 0) 'Post-write fault was ignored.'
 $rollbackTools=Join-Path $env:LOCALAPPDATA 'CodexWithGateway\tools'
 Check (-not [IO.File]::Exists((Join-Path $rollbackTools 'Switch-ClaudeMode.ps1')) -and -not [IO.File]::Exists((Join-Path $rollbackTools 'ClaudeModeCore.ps1')) -and @(Get-ChildItem -LiteralPath $desktop2 -Filter '*.lnk').Count -eq 0) 'Attempted write did not roll back exactly.'
 $report=[IO.File]::ReadAllText($reportPath)|ConvertFrom-Json
 Check ($report.Stage -ceq 'CommitFiles' -and $report.ErrorCode -ceq 'UNEXPECTED_ERROR' -and -not $report.RollbackBlocked -and -not ([IO.File]::ReadAllText($reportPath)).Contains('fixture post-write failure')) 'Rollback lost the failure stage or leaked native text.'
 $passed++
 # Unknown file with no ownership manifest is always retained.
 $unknown=Join-Path $rollbackTools 'Switch-ClaudeMode.ps1'; Write-Text $unknown 'unknown script'; $unknownHash=Hash $unknown
 $normalVariant=Join-Path $root 'Install-NewFixture.ps1'; Write-Text $normalVariant ($installerText.Replace($needle,("'"+$desktop2.Replace("'","''")+"'")))
 $ErrorActionPreference = 'Continue'
 & $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $normalVariant -SourceDirectory $sources -ReportPath $reportPath 2>$null | Out-Null
 $ErrorActionPreference = 'Stop'
 Check ($LASTEXITCODE -ne 0 -and (Hash $unknown) -ceq $unknownHash) 'Unowned same-name script was not preserved.'
 $passed++
 # Native ACL/COM failures retain only fixed stage/code, type, and numeric HResult.
 # Use the current test interpreter so these catch/report paths run on PS5 and PS7.
 $diagnosticPowerShell=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
 $env:LOCALAPPDATA=Join-Path $root 'diagnostic local'; [IO.Directory]::CreateDirectory($env:LOCALAPPDATA)|Out-Null
 $aclPoint="    if (`$PSVersionTable.PSEdition -eq 'Core') {"
 $comPoint='$shell = New-Object -ComObject WScript.Shell'
 $diagnosticCases=@(
  @{Name='acl';Needle=$aclPoint;Replacement=("    throw ([UnauthorizedAccessException]::new('fixture-native-secret-do-not-print'))`n"+$aclPoint);Stage='SecureToolsDirectory';Code='NATIVE_ACCESS_DENIED';Type='System.UnauthorizedAccessException';HResult=-2147024891},
  @{Name='com';Needle=$comPoint;Replacement="throw ([Runtime.InteropServices.COMException]::new('fixture-native-secret-do-not-print', [int]-2147221164))";Stage='CreateShortcutCom';Code='NATIVE_COM_ERROR';Type='System.Runtime.InteropServices.COMException';HResult=-2147221164}
 )
 foreach($diagnosticCase in $diagnosticCases) {
  Check $installerText.Contains($diagnosticCase.Needle) 'Diagnostic fault site not located.'
  $diagnosticText=$installerText.Replace($needle,("'"+$desktop2.Replace("'","''")+"'"))
  $diagnosticText=$diagnosticText.Replace($diagnosticCase.Needle,$diagnosticCase.Replacement)
  $diagnosticPath=Join-Path $root ('Install-Diagnostic-'+$diagnosticCase.Name+'.ps1'); Write-Text $diagnosticPath $diagnosticText
  $ErrorActionPreference='Continue'
  $diagnosticOutput=& $diagnosticPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $diagnosticPath -SourceDirectory $sources -ReportPath $reportPath 2>&1|Out-String
  $ErrorActionPreference='Stop'
  Check ($LASTEXITCODE -ne 0) 'Native diagnostic fault was ignored.'
  $reportText=[IO.File]::ReadAllText($reportPath); $report=$reportText|ConvertFrom-Json
  Check (-not $report.Success -and $report.Stage -ceq $diagnosticCase.Stage -and $report.ErrorCode -ceq $diagnosticCase.Code -and $report.NativeErrorType -ceq $diagnosticCase.Type -and $report.HResult -eq $diagnosticCase.HResult) 'Native failure diagnostic was not safely projected.'
  Check (@($report.PSObject.Properties.Name|Where-Object{$_ -cnotin @('Success','Error','Stage','ErrorCode','NativeErrorType','HResult','RollbackBlocked')}).Count -eq 0) 'Failure report contains non-whitelisted fields.'
  Check (-not ($reportText+$diagnosticOutput).Contains('fixture-native-secret-do-not-print') -and -not $reportText.Contains('StackTrace')) 'Native exception text or stack leaked.'
  $diagnosticTools=Join-Path $env:LOCALAPPDATA 'CodexWithGateway\tools'
  Check (-not [IO.File]::Exists((Join-Path $diagnosticTools 'Switch-ClaudeMode.ps1')) -and @(Get-ChildItem -LiteralPath $desktop2 -Filter '*.lnk').Count -eq 0) 'Diagnostic failure installed a target.'
  $passed++
 }
 # Launcher quiet/no-launch invokes only the test core, never an app.
 foreach($mode in @('Account','CodeBuddy')) {
  $json=& $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $sources 'Switch-ClaudeMode.ps1') -Mode $mode -Quiet -NoLaunch
  Check ($LASTEXITCODE -eq 0) 'Quiet launcher failed.'
  $launchResult=$json|ConvertFrom-Json
  Check ($launchResult.Success -and -not $launchResult.Started -and [IO.File]::ReadAllText($env:CLAUDE_FIXTURE_TRACE) -ceq $mode) 'Quiet/no-launch contract failed.'
 }
 $passed++
 Write-Text (Join-Path $sources 'ClaudeModeCore.ps1') "function Set-ClaudeDesktopMode { throw 'fixture-secret-do-not-print' }"
 $ErrorActionPreference = 'Continue'
 $errorText=& $powershellPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $sources 'Switch-ClaudeMode.ps1') -Mode Account -Quiet -NoLaunch 2>&1|Out-String
 $ErrorActionPreference = 'Stop'
 Check ($LASTEXITCODE -ne 0 -and -not $errorText.Contains('fixture-secret-do-not-print')) 'Launcher leaked arbitrary core exception text.'
 $passed++
 # Discovery and running-state logic with mock metadata only.
 $lt=$null;$le=$null;$launcherAst=[Management.Automation.Language.Parser]::ParseFile($launcherFile,[ref]$lt,[ref]$le)
 foreach($definition in $launcherAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) { . ([scriptblock]::Create($definition.Extent.Text)) }
 $fakePackages=@([pscustomobject]@{Name='Claude';PackageFamilyName='Claude_pzs8sxrjxfjjc';PackageFullName='fixture-package';IsResourcePackage=$false;IsFramework=$false})
 $fakeApps=@([pscustomobject]@{Name='Claude';AppID='Claude_pzs8sxrjxfjjc!Claude'})
 function Get-AppxPackage { return $fakePackages }
 function Get-StartApps { return $fakeApps }
 function Get-AppxPackageManifest { return [pscustomobject]@{Package=[pscustomobject]@{Applications=[pscustomobject]@{Application=@([pscustomobject]@{Id='Claude';Executable='app\Claude.exe'})}}} }
 Check ((Find-ClaudeDesktopAppId) -ceq 'Claude_pzs8sxrjxfjjc!Claude') 'Stable StartApps ID not selected.'
 $fakeApps=@(); Check ((Find-ClaudeDesktopAppId) -ceq 'Claude_pzs8sxrjxfjjc!Claude') 'Manifest fallback failed.'
 $fakePackages=@(); Expect-Failure {Find-ClaudeDesktopAppId}
 $passed++
 $sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
 $fakeProcesses=@([pscustomobject]@{SessionId=$sessionId;Path='C:\Program Files\WindowsApps\Claude_2.9999_x64__pzs8sxrjxfjjc\Claude.exe'})
 function Get-Process { return $fakeProcesses }
 Check (Test-ClaudeDesktopRunning) 'Running official MSIX was not recognized.'
 $fakeProcesses=@([pscustomobject]@{SessionId=$sessionId;Path='C:\cli\claude.exe'})
 Check (-not (Test-ClaudeDesktopRunning)) 'CLI process was mistaken for Desktop.'
 $fakeProcesses=@([pscustomobject]@{SessionId=($sessionId+1);Path='C:\Program Files\WindowsApps\Claude_2_x64__pzs8sxrjxfjjc\Claude.exe'})
 Check (-not (Test-ClaudeDesktopRunning)) 'Another user session was mistaken for current Desktop.'
 $passed++
 $mapped=Get-ClaudeModeFailureMessage 'Claude mode switch could not finish. Private recovery state is retained; concurrent edits will not be overwritten.'
 Check (-not $mapped.Contains('Claude mode switch') -and -not (Get-ClaudeModeFailureMessage 'native-secret').Contains('native-secret')) 'Failure mapping is not safe Chinese feedback.'
 $passed++
 [pscustomobject]@{Passed=$passed;PowerShell=$PSVersionTable.PSVersion.ToString();RealDesktopTouched=$false;CoreModeChanged=$false;ClaudeStarted=$false;VmCalled=$false}|ConvertTo-Json -Compress
} finally {
 $env:LOCALAPPDATA=$oldLocal; $env:CLAUDE_FIXTURE_TRACE=$oldTrace
 $full=[IO.Path]::GetFullPath($root); $prefix=$project.TrimEnd('\')+'\.state\'
 if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -notmatch '^claude-shortcut-fixture-[0-9a-f]{32}$'){throw 'Unsafe fixture cleanup.'}
 if([IO.Directory]::Exists($full)){if((Get-Item -LiteralPath $full).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse fixture cleanup refused.'};Remove-Item -LiteralPath $full -Recurse -Force}
}
