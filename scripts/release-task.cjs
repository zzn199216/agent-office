'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
function taskAction(args){const mode=args[0];let taskName='AgentOfficeReleaseRunner';if(args.length===3&&args[1]==='--task-name')taskName=args[2];else if(args.length!==1)throw new Error('Usage: node scripts/release-task.cjs install|uninstall|status [--task-name AgentOfficeReleaseRunner-NAME]');if(!['install','uninstall','status'].includes(mode)||!/^AgentOfficeReleaseRunner(?:-[A-Za-z0-9-]{1,40})?$/.test(taskName))throw new Error('Invalid release task action or name.');return {mode,taskName};}
function main(){
  if(process.platform!=='win32')throw new Error('Release tasks require Windows.');const {mode,taskName}=taskAction(process.argv.slice(2)),root=path.resolve(__dirname,'..');
  const local=path.join(process.env.LOCALAPPDATA||(()=>{throw new Error('LOCALAPPDATA is unavailable.');})(),'AgentOfficeReleaseRunner',taskName),host=path.join(local,'host.ps1');
  if(mode==='install'){fs.mkdirSync(local,{recursive:true});if(fs.lstatSync(local).isSymbolicLink()||fs.existsSync(host)&&fs.lstatSync(host).isSymbolicLink())throw new Error('The local task host cannot be a link.');fs.writeFileSync(host,fs.readFileSync(path.join(__dirname,'release-task-host.ps1')));}
  const script=`$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;
$repo=(Get-Item -LiteralPath $r.root).FullName;if($repo -match '^[A-Za-z]:\\\\'){$drive=Get-PSDrive -Name $repo.Substring(0,1);if($drive.DisplayRoot -like '\\\\*'){$repo=$drive.DisplayRoot.TrimEnd('\\')+$repo.Substring(2)}};
$description='Agent Office pinned release runner: '+$repo;$task=Get-ScheduledTask -TaskName $r.taskName -ErrorAction SilentlyContinue;
if($task -and $task.Description -ne $description){throw 'An unrelated task uses this name; it was not changed.'};
if($r.mode -eq 'uninstall'){if($task){if($task.State -eq 'Running'){throw 'Wait for the current build to finish before uninstalling.'};Unregister-ScheduledTask -TaskName $r.taskName -Confirm:$false};@{task=$r.taskName;installed=$false}|ConvertTo-Json -Compress;exit};
if($r.mode -eq 'install'){foreach($value in @($repo,$r.node,$r.host)){if($value.Contains('"') -or $value.Contains([char]10) -or $value.Contains([char]13)){throw 'Unsupported task path'}};
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$r.host+'" -NodePath "'+$r.node+'" -Repository "'+$repo+'"';
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Argument $arguments;
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1);
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -StartWhenAvailable;
Register-ScheduledTask -TaskName $r.taskName -Description $description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null;$task=Get-ScheduledTask -TaskName $r.taskName};
if($task){$info=Get-ScheduledTaskInfo -TaskName $r.taskName;@{task=$task.TaskName;installed=$true;state=[string]$task.State;description=$task.Description;last_result=$info.LastTaskResult;action=$task.Actions.Arguments}|ConvertTo-Json -Compress}else{@{task=$r.taskName;installed=$false}|ConvertTo-Json -Compress}`;
  // Store-packaged callers can virtualize LOCALAPPDATA and nvm uses a junction.
  // Task Scheduler runs outside that context: register the actual native paths.
  const physicalHost=mode==='install'?fs.realpathSync.native(host):host;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({mode,taskName,root,node:fs.realpathSync.native(process.execPath),host:physicalHost}),encoding:'utf8',windowsHide:true,timeout:30000});
  if(result.status!==0)throw new Error((result.stderr||result.error?.message||'Task registration failed.').slice(0,2500));console.log(result.stdout.trim());
}
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={taskAction};
