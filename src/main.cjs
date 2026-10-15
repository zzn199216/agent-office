#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {isSea}=require('node:sea');
const {dataDirectory,atomicWrite,sleep,RoomError,readableError,ownCommand,livePid,VERSION}=require('./util.cjs');

function argumentsOf(args){const options={},pos=[];for(let i=0;i<args.length;i++){const a=args[i];if(a.startsWith('--')){const name=a.slice(2);options[name]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}else pos.push(a);}return {options,pos};}
function readControl(dir){try{const r=JSON.parse(fs.readFileSync(path.join(dir,'control.json'),'utf8'));const u=new URL(r.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!livePid(r.pid))return null;return r;}catch{return null;}}
async function apiCall(dir,endpoint,input,timeout=35000){
  const control=readControl(dir);if(!control)throw new RoomError('AgentRoom 尚未启动。',503,'not_running');
  const res=await fetch(control.url+endpoint,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${control.token}`,...input===undefined?{}:{'Content-Type':'application/json'}},...input===undefined?{}:{body:JSON.stringify(input)},signal:AbortSignal.timeout(timeout),redirect:'error'});
  const value=await res.json();if(!res.ok)throw new RoomError(value.error || '请求失败。',res.status,value.code);return value;
}
async function ensureServer(dir){
  if(readControl(dir)){try{const state=await apiCall(dir,'/api/state',undefined,3000);let expected;const file=path.join(dir,'room.sqlite');if(fs.existsSync(file)){const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare("SELECT value FROM settings WHERE key='instance_fingerprint'").get();expected=row?JSON.parse(row.value):null;}finally{db.close();}}if(expected&&state.instance_id!==expected)throw new RoomError('处理程序与磁盘实例不匹配，没有连接另一空聊天室。',409,'instance_control_mismatch');return readControl(dir);}catch(e){if(e.code==='instance_control_mismatch')throw e;if(e.status===401||e.status===403)throw new RoomError('已有处理程序身份不匹配，没有另建替代实例。',409,'instance_control_mismatch');}}
  fs.mkdirSync(dir,{recursive:true});const own=ownCommand();
  if(isSea()){const current=require('./install.cjs').activeRuntime(dir);if(current)own.command=current;}
  const log=fs.openSync(path.join(dir,'daemon.log'),'a');
  const child=spawn(own.command,[...own.args,'serve','--data-dir',dir],{detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,AGENTROOM_DATA_DIR:dir}});child.unref();fs.closeSync(log);
  for(let i=0;i<80;i++){await sleep(250);if(readControl(dir)){try{await apiCall(dir,'/api/state',undefined,2000);return readControl(dir);}catch{}}}
  throw new RoomError(`启动未完成，请查看 ${path.join(dir,'daemon.log')}。`,503,'start_timeout');
}
function createRecoveringApi(dir,options={}){
  const ensure=options.ensure||ensureServer,call=options.call||apiCall;
  return async(route,input)=>{
    await options.guard?.(route,input);await ensure(dir);
    try{return await call(dir,route,input);}catch(e){
      const code=e.cause?.code||e.code;
      if(code==='ECONNREFUSED'||code==='not_running'){await ensure(dir);return call(dir,route,input);}
      if(!input&&['ECONNRESET','UND_ERR_SOCKET'].includes(code)){await ensure(dir);return call(dir,route,input);}
      if(input&&['ECONNRESET','UND_ERR_SOCKET','ETIMEDOUT'].includes(code))throw new RoomError('连接在请求期间结束，结果需要核对。保留原消息标识和幂等键，不要换成新请求。',503,'outcome_uncertain');
      throw e;
    }
  };
}
function openBrowser(url){
  if(process.platform==='win32'){const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','$u=[Console]::In.ReadToEnd();Start-Process -FilePath $u'],{windowsHide:true,stdio:['pipe','ignore','ignore']});p.stdin.end(url);p.unref();}
  else{const p=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});p.unref();}
}
async function serve(dir,options={}){
  fs.mkdirSync(dir,{recursive:true});const lock=path.join(dir,'daemon.lock');
  let fd;
  try{fd=fs.openSync(lock,'wx');}catch(e){
    if(e.code!=='EEXIST')throw e;
    let old;try{old=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw new RoomError('已有程序正在启动，请稍后重试。',409);}
    if(livePid(old.pid))return;
    fs.unlinkSync(lock);fd=fs.openSync(lock,'wx');
  }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);
  const {RoomService}=require('./service.cjs');
  const service=new RoomService(dir);let server;let stopped=false;
  const stop=async()=>{
    if(stopped)return;stopped=true;
    try{await server?.close();await service.close();}finally{
      try{const c=JSON.parse(fs.readFileSync(path.join(dir,'control.json'),'utf8'));if(c.pid===process.pid)fs.unlinkSync(path.join(dir,'control.json'));}catch{}
      try{fs.unlinkSync(lock);}catch{}
    }
  };
  try{
    const token=crypto.randomBytes(32).toString('hex');
    const listener=await require('./http-listener.cjs').listenLocal(service,{token,port:options.port,onShutdown:()=>stop().then(()=>process.exit(0))});
    server=listener.server;const port=listener.port;
    atomicWrite(path.join(dir,'control.json'),JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${port}`,token,version:VERSION,instance_id:service.runtime.instanceId}));
    if(options.project)service.addProject({path:options.project,name:options.name});
    if(options['import-grok']){service.vault.import(path.resolve(options['import-grok']));service.changed();}
    service.start();console.log(`Agent Office ${VERSION} · http://127.0.0.1:${port}`);
    process.once('SIGINT',()=>stop().then(()=>process.exit(0)));process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));
    return {service,server,stop};
  }catch(e){await stop();throw e;}
}
async function stdinText(){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>150000)throw new RoomError('输入过长。');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
function fileText(file){
  if(!/\.(md|txt)$/i.test(file))throw new RoomError('请选择 UTF-8 的 .md 或 .txt 文本文件。');
  const bytes=fs.readFileSync(path.resolve(file));if(bytes.length>150000)throw new RoomError('输入文件过长。');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new RoomError('文件不是有效 UTF-8，请转换编码后重试。');}
}
const print=v=>console.log(JSON.stringify(v,null,2));
async function main(args=process.argv.slice(2)){
  const {options,pos}=argumentsOf(args);const command=pos[0] || (isSea()&&process.platform==='win32'?'desktop':'start');
  if(options['data-dir'])process.env.AGENTROOM_DATA_DIR=path.resolve(options['data-dir']);let dir=dataDirectory(),entry;
  if(command==='mcp'&&options.setup){if(options.entry)throw new RoomError('初始化 MCP 与成员代理入口不能混用。');process.env.AGENTROOM_SETUP_MODE='1';}
  if(command==='--version'||options.version){console.log(VERSION);return;}
  if(command==='approvals'||command==='selftest'){
    if(options.entry||process.env.AGENTROOM_MEMBER_ID)throw new RoomError('诊断命令属于本机用户操作，成员入口不能读取全部待办。',403,'resume_scope_mismatch');
    const diagnostics=require('./diagnostics.cjs'),result=command==='selftest'?await diagnostics.selftest():await diagnostics.approvals(dir,{readControl,apiCall});print(result);if(result.ok===false)process.exitCode=1;return;
  }
  if(command==='help'||options.help)console.log('Diagnostics: selftest --json (isolated fake clients), approvals --json (read-only; never starts a service).');
  if(command==='work-record'){
    if(options.entry||process.env.AGENTROOM_MEMBER_ID)throw new RoomError('完整工作记录属于本机用户查看操作。',403,'resume_scope_mismatch');
    const result=await require('./work-records.cjs').offlineWorkRecord(dir,{room_id:options.room,member_id:options.member,discussion_id:options.discussion});print({path:result.path,thread_id:result.thread_id,turn_count:result.turns.length,read_only:true});return;
  }
  if(command==='help'||options.help){console.log('Agent Office (agentroom compatible): work-record --room ID --member ID [--data-dir PATH] (read-only; no service or inference), desktop, desktop-state [--room ID], desktop-start, desktop-stop, scan-agents, connect --provider codex --install-client --wait 90 [--install-runtime], connect-state RUN_ID, connect-retry RUN_ID [--wait 90], auto-connect --providers codex --install-clients --wait 90, group-state, group-sync (disabled), sync-report --paused true, mcp --setup, delegate --entry FILE --file question.md --wait 300, delegate-wait REQUEST_ID --entry FILE; enter --entry FILE, room-state --entry FILE --offline, room-ensure --entry FILE, wake --entry FILE --to PEER_ID; start [--open], status, check, add-project --path PATH, chat-status, chat-room --project ID --title TITLE, chat-member --name NAME --adapter TYPE, chat-connect --room ID --member ID, chat-join --invite ID --nonce VALUE --member ID, chat-history --room ID, chat-post --room ID --member ID --to PEER_ID --file question.md --key UNIQUE [--wait 300], chat-wait MESSAGE_ID, chat-reply MESSAGE_ID --member ID --file answer.md --key UNIQUE, chat-inbox --member ID, chat-ack MESSAGE_ID --member ID, bridge-request --room ID --member ID --to PEER_ID --file question.md --key UNIQUE [--origin REAL_REF --source-message REAL_MSG] [--wait 300], bridge-result ENTRY_ID --member ID, bridge-wait ENTRY_ID --member ID, bridge-report ENTRY_ID --member ID --origin REAL_REF --reply-ref REAL_REPLY, mcp, stop; legacy: discuss, ask, result, wait, delivery, inbox, reply, ack');return;}
  if(['desktop-state','desktop-start','desktop-stop'].includes(command)){
    if(options.entry)throw new RoomError('桌面服务控制属于本机用户操作，成员入口不能管理服务。',403,'resume_scope_mismatch');
    const module=require('./desktop-state.cjs'),input={room_id:options.room};print(await module[command==='desktop-state'?'desktopState':command==='desktop-start'?'desktopStart':'desktopStop'](dir,input,{main:{readControl,ensureServer,apiCall}}));return;
  }
  if(command==='desktop'){
    if(options.entry)throw new RoomError('成员入口不用于打开桌面管理窗口。',403,'resume_scope_mismatch');
    const desktop=require('./desktop-launch.cjs');try{await desktop.launchDesktop(dir,{source:process.execPath,sourceArgs:isSea()?[]:[__filename],diagnosticsDirectory:options.diagnostics,check:options.check===true});}catch(error){try{atomicWrite(path.join(dir,'desktop-launch-error.json'),JSON.stringify({version:VERSION,at:new Date().toISOString(),error:readableError(error),code:error.code||'operation_failed'}));}catch{}if(isSea())await desktop.showDesktopError(error);throw error;}return;
  }
  if(options.entry){entry=require('./entry.cjs').readEntry(options.entry);if(options['data-dir']&&path.resolve(dir).toLowerCase()!==entry.dir.toLowerCase())throw new RoomError('入口卡与显式数据目录不匹配，没有创建替代实例。',409,'resume_instance_mismatch');dir=entry.dir;process.env.AGENTROOM_DATA_DIR=dir;process.env.AGENTROOM_MEMBER_ID=entry.card.member_id;process.env.AGENTROOM_ROOM_ID=entry.card.room_id;process.env.AGENTROOM_INSTANCE_ID=entry.card.instance_id;
    if(options.room&&options.room!==entry.card.room_id||options.member&&options.member!==entry.card.member_id)throw new RoomError('命令与入口卡的成员或房间不匹配。',403,'resume_scope_mismatch');options.room=entry.card.room_id;options.member=entry.card.member_id;
  }
  if(command==='room-state'){print(require('./entry.cjs').diskState(dir,entry));return;}
  if(command==='enter'){if(!entry)throw new RoomError('请使用 --entry 指定已授权的长期本机入口卡。');require('./entry.cjs').acceptEntry(entry);if(options.offline){print(require('./entry.cjs').diskState(dir,entry));return;}}
  if(command==='start'&&!options['data-dir']&&!options.entry){await require('./migrate.cjs').migrateLegacy(dir,{stop:async source=>{const c=readControl(source);if(!c)return;const s=await apiCall(source,'/api/state');if(s.activeRequest||s.chat?.activeMessages?.length||s.approvals?.length||s.chat?.members?.some(m=>m.status==='connecting')||Object.values(s.activeSetup||{}).some(Boolean))throw new RoomError('原聊天室正在处理任务，迁移等待它空闲；未停止工作。',409,'migration_busy');await apiCall(source,'/api/shutdown',{});for(let i=0;readControl(source)&&i<100;i++)await sleep(100);}});}
  if(isSea() && command==='start'){
    const {installBinary}=require('./install.cjs');const installed=installBinary(process.execPath,dir);
    const desktopSource=path.join(path.dirname(process.execPath),'desktop');if(fs.existsSync(path.join(desktopSource,'desktop-manifest.json')))require('./desktop-launch.cjs').installDesktop(desktopSource,dir,{executable:installed});
    if(installed.toLowerCase()!==process.execPath.toLowerCase()){
      const forwarded=args.length?args:['start','--open'];
      await new Promise((resolve,reject)=>{const child=spawn(installed,forwarded,{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>process.stdout.write(d));child.stderr.on('data',d=>process.stderr.write(d));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new RoomError('启动未完成，请重新打开。',503)));});return;
    }
  }
  if(command==='serve')return serve(dir,options);
  if(command==='stop'){if(entry)throw new RoomError('停止整个处理程序属于本机管理操作，请不用成员入口卡执行。',403,'resume_scope_mismatch');await apiCall(dir,'/api/shutdown',{idle_only:true});print({stopping:true});return;}
  const memberScope=entry?.card||(command==='mcp'&&(process.env.AGENTROOM_MEMBER_ID||process.env.AGENTROOM_ROOM_ID)?{member_id:process.env.AGENTROOM_MEMBER_ID,room_id:process.env.AGENTROOM_ROOM_ID}:null);
  if(memberScope&&(!memberScope.member_id||!memberScope.room_id))throw new RoomError('成员 MCP 必须同时绑定成员和房间。',403,'resume_scope_mismatch');
  const inspectScope=(route,input)=>{
    const mod=require('./entry.cjs'),policy=require('./member-policy.cjs'),disk=mod.openDisk(dir,{readOnly:true});
    try{
      if(entry)memberScope.room_id=disk.resume.inspect(entry.card).room_id;else disk.chat.requireParticipant(memberScope.room_id,memberScope.member_id);
      if(route)policy.assertMemberRoute(disk,memberScope,route,input,{allowJoin:!entry});
      const proxy=policy.proxyFor(disk,memberScope),roomId=proxy?.room_id||memberScope.room_id;
      return {env:{...process.env,AGENTROOM_MEMBER_ID:memberScope.member_id,AGENTROOM_ROOM_ID:roomId},proxy:!!proxy,allowJoin:!entry,secretary:disk.store.setting('secretary.'+roomId)?.member_id===memberScope.member_id,connection:policy.memberConnection(disk,memberScope)};
    }finally{disk.close();}
  };
  const guard=memberScope?inspectScope:undefined;
  const baseApi=createRecoveringApi(dir,{guard});const api=async(route,input)=>{if(entry){await guard(route,input);await baseApi('/api/resume/accept',{card:entry.card});}return baseApi(route,input);};
  api.diskState=args=>{if(memberScope)inspectScope();return require('./entry.cjs').diskState(dir,entry,{roomId:args?.room_id||memberScope?.room_id||options.room,memberId:memberScope?.member_id||options.member});};
  api.mcpContext=()=>memberScope?inspectScope():{env:process.env};
  if(command==='room-ensure'||command==='enter'){const runtime=await api(`/api/runtime${options.room?'?room_id='+encodeURIComponent(options.room):''}`);print({...runtime,restored:true,url:readControl(dir).url,ui_required:false});return;}
  if(command==='wake'){print(await api('/api/runtime/wake',{room_id:options.room,member_id:options.to,caller_member_id:options.member}));return;}
  if(command==='mcp'){const {runMcp}=require('./mcp.cjs');runMcp(api);return;}
  const control=await ensureServer(dir);
  if(command==='auto-connect'){
    if(entry)throw new RoomError('接入成员是用户初始化操作，不能从成员业务入口执行。',403);
    const providers=typeof options.providers==='string'?options.providers.split(',').map(p=>p.trim()).filter(Boolean):[];
    if(!providers.length)throw new RoomError('请明确指定用户点名的成员，例如 --providers codex。扫描请用 scan-agents，不会自动接入。',400,'selection_required');
    let state=await api('/api/launch/prepare',{room_id:options.room,project_id:options.project,project_path:options['project-path'],project_name:options['project-name'],goal:options.goal,providers,install_clients:!!options['install-clients']});
    if(options.wait){const end=Date.now()+Math.min(300,Math.max(0,Number(options.wait)||0))*1000;while(state.status==='preparing'&&Date.now()<end){await sleep(800);state=await api(`/api/launch/state?session_id=${encodeURIComponent(state.id)}`);}}
    print(state);return;
  }
  if(command==='scan-agents'){if(entry)throw new RoomError('扫描本机应用需要用户初始化入口。',403);print(await api('/api/launch/scan',{room_id:options.room}));return;}
  if(command==='connect'){
    if(entry)throw new RoomError('一键接入是用户管理操作，不从成员业务入口执行。',403);
    let job=await api('/api/onboarding/start',{provider:options.provider,room_id:options.room,project_id:options.project,project_path:options['project-path'],project_name:options['project-name'],mode:options.mode,goal:options.goal,install_client:!!options['install-client'],install_runtime:!!options['install-runtime']});
    if(options.wait)job=await waitConnect(api,job,Number(options.wait));print(job);return;
  }
  if(command==='connect-state'){if(entry)throw new RoomError('接入任务属于用户初始化管理。',403);print(await api('/api/onboarding/jobs/'+encodeURIComponent(pos[1])));return;}
  if(command==='connect-retry'){if(entry)throw new RoomError('接入重试属于用户初始化管理。',403);let job=await api('/api/onboarding/jobs/'+encodeURIComponent(pos[1])+'/retry',{...options['install-client']?{install_client:true}:{},...options['install-runtime']?{install_runtime:true}:{}});if(options.wait)job=await waitConnect(api,job,Number(options.wait));print(job);return;}
  if(command==='group-state'){print(await api(`/api/launch/state?${options.session?'session_id='+encodeURIComponent(options.session):'room_id='+encodeURIComponent(options.room||'')}`));return;}
  if(command==='group-sync'){if(entry)throw new RoomError('自动成员同步需要用户初始化入口。',403);print(await api('/api/launch/sync',{room_id:options.room,changes_only:!!options['changes-only']}));return;}
  if(command==='sync-report'){if(entry)throw new RoomError('原生例程管理需要用户初始化入口。',403);print(await api('/api/launch/sync-report',{room_id:options.room,routine_ref:options['routine-ref'],group_ref:options['group-ref'],paused:options.paused===true||options.paused==='true',interval_minutes:Number(options['interval-minutes']),next_run:options['next-run']}));return;}
  if(command==='group-report'){if(entry)throw new RoomError('群管理报告需要用户初始化入口。',403);print(await api('/api/launch/report',{session_id:options.session,proxy_id:options.proxy,name:options.name,bot_ref:options['bot-ref'],group_ref:options['group-ref'],joined:options.joined==='true'||options.joined===true}));return;}
  if(command==='delegate'){
    if(!entry)throw new RoomError('请使用该群成员的固定代理入口。');let r=await api('/api/launch/delegate',{member_id:options.member,room_id:options.room,text:options.file?fileText(options.file):options.stdin?await stdinText():options.message,key:options.key,origin:options.origin,source_message:options['source-message'],seconds:25});
    if(options.wait)r=await waitDelegate(api,r,Number(options.wait),options);print(r);return;
  }
  if(command==='delegate-wait'){if(!entry)throw new RoomError('请使用该群成员的固定代理入口。');print(await waitDelegate(api,{request_id:pos[1],status:'waiting'},Number(options.timeout||300),options));return;}
  if(command==='start'){
    if(options.project)await api('/api/projects',{path:options.project,name:options.name});
    if(options['import-grok']){
      const c=JSON.parse(fs.readFileSync(path.resolve(options['import-grok']),'utf8').replace(/^\uFEFF/,''));await api('/api/grok/configure',{url:c.webhook_url,key:c.webhook_key});
    }
    if(options.open || !args.length)openBrowser(control.url);print({running:true,url:control.url});return;
  }
  if(command==='status'){const s=await api('/api/state');print({url:control.url,projects:s.projects,discussions:s.discussions,grok:s.grok,codex:s.codex});return;}
  if(command==='chat-status'){print(await api('/api/chat/state'));return;}
  if(command==='chat-room'){print(await api('/api/chat/rooms',{project_id:options.project,title:options.title}));return;}
  if(command==='chat-member'){print(await api('/api/chat/members',{name:options.name,adapter:options.adapter||'mailbox',config:options.executable?{executable:options.executable}:undefined}));return;}
  if(command==='chat-connect'){print(await api(`/api/chat/members/${options.member}/connect`,{room_id:options.room}));return;}
  if(command==='chat-join'){print(await api('/api/chat/join',{invite_id:options.invite,nonce:options.nonce,member_id:options.member}));return;}
  if(command==='chat-history'){print(await api(`/api/chat/rooms/${options.room}`));return;}
  if(command==='chat-post'){
    const text=options.file?fileText(options.file):options.stdin?await stdinText():options.message;
    const m=await api('/api/chat/messages',{room_id:options.room,sender_id:options.member||'user',to_member_id:options.to||null,text,reply_to:options.reply||null,idempotency_key:options.key||crypto.randomUUID()});print(options.wait?await waitChat(api,m.id,Number(options.wait),options.member):m);return;
  }
  if(command==='chat-wait'){print(await waitChat(api,pos[1],Number(options.timeout||300),options.member));return;}
  if(command==='chat-inbox'){const result=await api(`/api/chat/inbox?member_id=${encodeURIComponent(options.member)}${options.room?'&room_id='+encodeURIComponent(options.room):''}`);print(Array.isArray(result?.items)?result.items:result);return;}
  if(command==='chat-reply'){print(await api(`/api/chat/messages/${pos[1]}/reply`,{member_id:options.member,text:options.file?fileText(options.file):options.stdin?await stdinText():options.message,idempotency_key:options.key||crypto.randomUUID()}));return;}
  if(command==='chat-ack'){print(await api(`/api/chat/messages/${pos[1]}/ack`,{member_id:options.member}));return;}
  if(command==='bridge-request'){
    const e=await api('/api/bridge/request',{room_id:options.room,member_id:options.member,target_member_id:options.to,text:options.file?fileText(options.file):options.stdin?await stdinText():options.message,idempotency_key:options.key,conversation_ref:options.origin,external_message_id:options['source-message'],label:options.label,provider:options.provider});
    print(options.wait?await waitBridge(api,e.id,Number(options.wait),options.member):e);return;
  }
  if(command==='bridge-result'){print(await api(`/api/bridge/entries/${pos[1]}?member_id=${encodeURIComponent(options.member)}`));return;}
  if(command==='bridge-wait'){print(await waitBridge(api,pos[1],Number(options.timeout||300),options.member));return;}
  if(command==='bridge-report'){print(await api(`/api/bridge/entries/${pos[1]}/report`,{member_id:options.member,conversation_ref:options.origin,external_reply_id:options['reply-ref']}));return;}
  if(command==='check'){print(await api('/api/codex/check',{}));return;}
  if(command==='add-project'){print(await api('/api/projects',{name:options.name,path:options.path}));return;}
  if(command==='discuss'){print(await api('/api/discussions',{project_id:options.project,title:options.title,thread_id:options.thread}));return;}
  if(command==='ask'){
    let discussion=options.discussion;
    if(!discussion){if(!options.project)throw new RoomError('请提供 --project 或 --discussion。');discussion=(await api('/api/discussions',{project_id:options.project,title:options.title || 'Agent 协作'})).id;}
    const message=options.file?fileText(options.file):options.stdin?await stdinText():options.message;
    const r=await api('/api/requests',{discussion_id:discussion,recipient:options.to || 'codex',sender:options.sender || 'agent',message,idempotency_key:options.key || crypto.randomUUID(),notify_grok:!!options['notify-grok']});
    print(options.wait?await waitLong(api,r.id,Number(options.wait)):r);return;
  }
  if(command==='result'){print(await api(`/api/requests/${pos[1]}`));return;}
  if(command==='wait'){print(await waitLong(api,pos[1],Number(options.timeout || 300)));return;}
  if(command==='cancel'){print(await api(`/api/requests/${pos[1]}/cancel`,{}));return;}
  if(command==='inbox'){print(await api('/api/inbox'));return;}
  if(command==='delivery'){print(await api(`/api/deliveries/${pos[1]}`));return;}
  if(command==='reply'){print(await api(`/api/deliveries/${pos[1]}/reply`,{message:options.file?fileText(options.file):options.stdin?await stdinText():options.message}));return;}
  if(command==='ack'){print(await api(`/api/deliveries/${pos[1]}/ack`,{stage:options.stage || 'consumed'}));return;}
  throw new RoomError('未知命令，请运行 agentroom help。');
}
async function waitLong(api,requestId,seconds){const end=Date.now()+Math.min(Math.max(seconds || 0,0),3600)*1000;for(;;){const r=await api(`/api/requests/${requestId}/wait?seconds=${Math.min(25,Math.max(0,(end-Date.now())/1000))}`);if(['completed','failed','cancelled','outcome_uncertain'].includes(r.status)||Date.now()>=end)return r;}}
async function waitChat(api,messageId,seconds,memberId){const end=Date.now()+Math.min(Math.max(seconds||0,0),3600)*1000;for(;;){const r=await api(`/api/chat/messages/${messageId}/wait?seconds=${Math.min(25,Math.max(0,(end-Date.now())/1000))}${memberId?'&member_id='+encodeURIComponent(memberId):''}`);if(require('./chat.cjs').done(r.message.status)||r.responses.length||Date.now()>=end)return r;}}
async function waitBridge(api,entryId,seconds,memberId){if(!memberId)throw new RoomError('请提供桥接成员 --member。');const end=Date.now()+Math.min(Math.max(seconds||0,0),3600)*1000;for(;;){const r=await api(`/api/bridge/entries/${encodeURIComponent(entryId)}/wait?member_id=${encodeURIComponent(memberId)}&seconds=${Math.min(25,Math.max(0,(end-Date.now())/1000))}`);if(require('./bridge.cjs').terminal(r.status)||Date.now()>=end)return r;}}
async function waitDelegate(api,result,seconds,options){const end=Date.now()+Math.min(3600,Math.max(0,seconds||0))*1000;while(!['answered','delivered','failed','uncertain','cancelled'].includes(result.status)&&Date.now()<end)result=await api('/api/launch/wait',{request_id:result.request_id,member_id:options.member,room_id:options.room,seconds:Math.min(25,Math.max(0,(end-Date.now())/1000))});return result;}
async function waitConnect(api,job,seconds){const end=Date.now()+Math.min(300,Math.max(0,seconds||0))*1000;while(job.status==='running'&&Date.now()<end){await sleep(700);job=await api('/api/onboarding/jobs/'+encodeURIComponent(job.id));}return job;}
if(isSea() || require.main===module)main().catch(e=>{console.error(JSON.stringify({error:readableError(e),code:e.code || 'operation_failed'}));process.exitCode=1;});
module.exports={main,serve,apiCall,ensureServer,createRecoveringApi,readControl,argumentsOf,waitLong,fileText};
