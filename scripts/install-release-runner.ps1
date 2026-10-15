param([string]$Repository = (Split-Path -Parent $PSScriptRoot), [string]$NodePath = (Get-Command node -ErrorAction Stop).Source, [string]$TaskName = 'AgentOfficeReleaseRunner')
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^AgentOfficeReleaseRunner(?:-[A-Za-z0-9-]{1,40})?$') { throw 'Use an AgentOfficeReleaseRunner task name.' }
$repositoryPath = (Get-Item -LiteralPath $Repository).FullName
if ($repositoryPath -match '^[A-Za-z]:\\') {
    $drive = Get-PSDrive -Name $repositoryPath.Substring(0, 1)
    if ($drive.DisplayRoot -like '\\*') { $repositoryPath = $drive.DisplayRoot.TrimEnd('\') + $repositoryPath.Substring(2) }
}
$nodeExecutable = (Get-Item -LiteralPath $NodePath).FullName
if ([IO.Path]::GetExtension($nodeExecutable) -ne '.exe' -or !(Test-Path -LiteralPath (Join-Path $repositoryPath 'scripts\release-runner.cjs'))) { throw 'The repository or Node executable is unavailable.' }
foreach ($value in @($repositoryPath, $nodeExecutable)) { if ($value.Contains('"') -or $value.Contains("`n") -or $value.Contains("`r")) { throw 'Unsupported task path.' } }
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$description = 'Agent Office pinned release runner: ' + $repositoryPath
if ($existing -and $existing.Description -ne $description) { throw 'An unrelated task uses this name; it was not changed.' }
$wrapper = Join-Path $repositoryPath 'scripts\release-task-host.ps1'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $wrapper + '" -NodePath "' + $nodeExecutable + '" -Repository "' + $repositoryPath + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Description $description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State, Description | ConvertTo-Json -Compress
