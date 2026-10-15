param([string]$TaskName = 'AgentOfficeReleaseRunner')
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^AgentOfficeReleaseRunner(?:-[A-Za-z0-9-]{1,40})?$') { throw 'Use an AgentOfficeReleaseRunner task name.' }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (!$task) { Write-Output 'Release runner task is already absent.'; exit 0 }
if (!$task.Description.StartsWith('Agent Office pinned release runner: ')) { throw 'An unrelated task uses this name; it was not changed.' }
if ($task.State -eq 'Running') { throw 'Wait for the current build to finish before uninstalling the runner.' }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output 'Release runner task removed. Requests and reports were preserved.'
