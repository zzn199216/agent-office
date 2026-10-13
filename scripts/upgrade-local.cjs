'use strict';
// Upgrade the single user-owned instance only while idle. Backups and identity
// assertions protect existing conversations; no native Grok identity is acted on.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {apiCall,readControl,ensureServer}=require('../src/main.cjs');
const {dataDirectory,sleep,livePid,VERSION}=require('../src/util.cjs');
const {spawn,spawnSync}=require('node:child_process');
function invariants(dir){const db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true});try{return {instance_id:JSON.parse(db.prepare("SELECT value FROM settings WHERE key='instance_fingerprint'").get().value),rooms:db.prepare('SELECT id,project_id,title FROM chat_rooms ORDER BY id').all(),members:db.prepare('SELECT id,name,adapter FROM chat_members ORDER BY id').all(),bindings:db.prepare('SELECT room_id,member_id,thread_id FROM chat_bindings ORDER BY room_id,member_id').all()};}finally{db.close();}}
function execute(exe,args){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.once('error',reject);p.once('exit',code=>code===0?resolve(out):reject(new Error(err.slice(-1000)||'Upgrade process failed')));});}
async function stopOwnedMcp(installed,dir,instanceId){
 const found=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'AgentRoom.exe'} | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});if(found.status!==0)throw new Error('无法核对通信子进程，没有结束未知进程。');
 let rows=JSON.parse(found.stdout||'[]');if(!Array.isArray(rows))rows=[rows];const owned=[];
 for(const row of rows){if(String(row.ExecutablePath).toLowerCase()!==installed.toLowerCase()||!(/\s+mcp(?:\s|$)/).test(row.CommandLine||''))continue;const matched=String(row.CommandLine).match(/--entry\s+(?:"([^"]+)"|(\S+))/),file=matched?.[1]||matched?.[2];if(!file)continue;
  const resolved=path.resolve(file),entries=path.resolve(dir,'entries');if(path.dirname(resolved).toLowerCase()!==entries.toLowerCase())continue;let card;try{card=JSON.parse(fs.readFileSync(resolved,'utf8'));}catch{continue;}
  const pid=Number(row.ProcessId);if(card.instance_id!==instanceId||path.resolve(card.data_directory).toLowerCase()!==path.resolve(dir).toLowerCase()||!Number.isSafeInteger(pid)||pid<=0)continue;owned.push(pid);
 }
 if(owned.length){const stopped=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Stop-Process -Id '+owned.join(',')+' -ErrorAction Stop'],{encoding:'utf8',windowsHide:true});if(stopped.status!==0)throw new Error('旧通信子进程尚未完成结束，没有强制替换。');for(let i=0;owned.some(livePid)&&i<60;i++)await sleep(100);if(owned.some(livePid))throw new Error('旧通信子进程仍在使用程序。');}
 return owned.length;
}
async function closeOwnedDesktop(dir){
 const executable=path.resolve(dir,'bin','desktop','AgentRoom.Desktop.exe');
 const found=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'AgentRoom.Desktop.exe'} | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});if(found.status!==0)throw new Error('无法核对本实例桌面窗口，未关闭其他窗口。');
 let rows=JSON.parse(found.stdout||'[]');if(!Array.isArray(rows))rows=[rows];const owned=[];
 for(const row of rows){if(path.resolve(String(row.ExecutablePath||'')).toLowerCase()!==executable.toLowerCase())continue;const match=String(row.CommandLine||'').match(/--data-dir\s+(?:"([^"]+)"|(\S+))/);if(!match||path.resolve(match[1]||match[2]).toLowerCase()!==path.resolve(dir).toLowerCase())continue;const pid=Number(row.ProcessId);if(Number.isSafeInteger(pid)&&pid>0)owned.push(pid);}
 if(!owned.length)return 0;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','$r=[Console]::In.ReadToEnd()|ConvertFrom-Json; foreach($pidToClose in $r.pids){$p=Get-Process -Id $pidToClose -ErrorAction Stop; if(-not $p.CloseMainWindow()){throw "本实例窗口未响应关闭，请先关闭它再更新。"}}'],{input:JSON.stringify({pids:owned}),encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error('本实例窗口尚未关闭，没有强制结束窗口。');
 for(let index=0;owned.some(livePid)&&index<100;index++)await sleep(100);if(owned.some(livePid))throw new Error('请先关闭本实例窗口再更新；后台与数据仍保留。');return owned.length;
}
async function main(){const dir=dataDirectory(),old=readControl(dir),state=old?await apiCall(dir,'/api/state'):null;
 if(state&&(state.activeRequest||state.approvals?.length||state.chat?.activeMessages?.length||state.chat?.members?.some(m=>m.status==='connecting')||Object.values(state.activeSetup||{}).some(Boolean)))throw new Error('实例正在处理任务或安装组件，升级等待空闲。');
 const before=invariants(dir),folder=path.join(dir,'backups',`upgrade-${VERSION}-${Date.now()}-${crypto.randomUUID()}`);fs.mkdirSync(folder,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true});try{await backup(db,path.join(folder,'room.sqlite'));}finally{db.close();}
 const installed=path.join(dir,'bin','AgentRoom.exe'),source=path.resolve(__dirname,'../dist/AgentRoom.exe');if(fs.existsSync(installed))fs.copyFileSync(installed,path.join(folder,'AgentRoom.exe'));
 const closedDesktop=await closeOwnedDesktop(dir);
 if(old){await apiCall(dir,'/api/shutdown',{idle_only:true});for(let i=0;livePid(old.pid)&&i<200;i++)await sleep(100);if(livePid(old.pid))throw new Error('原进程尚未退出，已保留备份但没有替换程序。');}
 const stoppedMcp=await stopOwnedMcp(installed,dir,before.instance_id);
 require('../src/install.cjs').installBinary(source,dir);require('../src/desktop-launch.cjs').installDesktop(path.join(path.dirname(source),'desktop'),dir);await require('../src/desktop-launch.cjs').startMenuShortcut(installed);const version=(await execute(installed,['--version'])).trim();if(version!==VERSION)throw new Error('安装版本不匹配。');
 // Updating instructions does not prepare members or call native Grok tools.
 fs.copyFileSync(path.resolve(__dirname,'../integrations/agentroom/GROK_SKILL.md'),path.join(dir,'GROK_SKILL.md'));
 const renameDb=new DatabaseSync(path.join(dir,'room.sqlite'));try{const canonical=require('../src/util.cjs').normalizePath(path.resolve(__dirname,'..'));renameDb.prepare("UPDATE projects SET name='Agent 办公室' WHERE canonical=? AND name='AgentRoom'").run(canonical);}finally{renameDb.close();}
 const updatePrompt=`请读取 ${path.join(dir,'GROK_SKILL.md')}，更新已有 AgentRoom 私有技能：仅在我要求时扫描，只接入我点名的成员；不要主动拉人或定期扫描。接入使用 connect 和 connect-state，复用已有成员；首次登录、桌面启用或导入等必须本人完成时明确下一步。检查 group-sync：旧“AgentRoom 成员同步”例程若尚无暂停报告，使用自己的原生工具真正暂停后，再按 report_command 回报；已有暂停报告就保持停用。保存技能和停用本机扫描不能代替原生例程暂停。保留当前群、Codex 代理和现有会话。\n`;
 fs.mkdirSync(path.resolve(__dirname,'../.local'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../.local/GROK_SIMPLE_SETUP.md'),updatePrompt,'utf8');
 for(const room of before.rooms){const groupFile=path.join(dir,'launch',room.id,'GROUP.md');if(fs.existsSync(groupFile))fs.writeFileSync(groupFile,`# AgentRoom ${VERSION}\n\n`+updatePrompt+'\n目前没有新的成员添加选择。等待用户说“扫描”或明确点名接入成员；不得按旧清单继续拉人。\n','utf8');}
 await execute(installed,['start']);const control=readControl(dir),after=invariants(dir);if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('升级后的原房间或会话身份不一致，请核对备份。');
 const evidence={version,brand:'Agent Office',pid:control.pid,url:control.url,instance_id:after.instance_id,rooms_preserved:after.rooms.length,members_preserved:after.members.length,bindings_preserved:after.bindings.length,identities_unchanged:true,closed_owned_desktop_windows:closedDesktop,restarted_owned_mcp_processes:stoppedMcp,backup_directory:folder,computer_use:false};
 fs.mkdirSync(path.resolve(__dirname,'../output/validation'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../output/validation/upgrade-current.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
