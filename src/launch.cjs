'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,id,now,cleanText,redact,atomicWrite,asset,ownCommand,shellCommand}=require('./util.cjs');
const {installClient,prepareManualClient}=require('./install-clients.cjs');
const manualProviders=new Set(['claude-desktop','qwen-desktop','doubao','opencode','cherry-studio','cline','roo-code']);
const preparedManualProviders=new Set(['doubao','opencode','cherry-studio','cline','roo-code']);
// Discovery runs only on request. Preparation affects only explicitly selected
// providers; native Grok bot creation remains a separate host operation.
class LaunchManager{
  constructor(service,options={}){
    this.service=service;this.options=options;this.db=service.store.db;this.jobs=new Map();this.closing=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS launch_sessions(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES chat_rooms(id),status TEXT NOT NULL,goal TEXT NOT NULL,candidates TEXT NOT NULL,install_clients INTEGER NOT NULL DEFAULT 0,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS launch_proxies(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES chat_rooms(id),provider TEXT NOT NULL,name TEXT NOT NULL,backend_member_id TEXT NOT NULL REFERENCES chat_members(id),proxy_member_id TEXT NOT NULL REFERENCES chat_members(id),installation TEXT,native_bot_ref TEXT,native_group_ref TEXT,native_group_status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(room_id,provider));
      CREATE TABLE IF NOT EXISTS launch_sync_routes(room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id),routine_ref TEXT NOT NULL,group_ref TEXT NOT NULL,interval_minutes INTEGER NOT NULL,next_run TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'host_reported',updated TEXT NOT NULL);`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(launch_sessions)').all().map(row=>row.name));
    if(!columns.has('selected_providers'))this.db.exec('ALTER TABLE launch_sessions ADD COLUMN selected_providers TEXT');
    this.db.prepare("UPDATE launch_sessions SET status='interrupted',error='准备期间处理程序结束；请重新指定要接入的成员，不会自动重放业务任务。',updated=? WHERE status='preparing'").run(now());
    // This requests a native pause; it does not pretend that the remote Grok
    // routine has already stopped. Keep its actual refs/history for reporting.
    this.db.prepare("UPDATE launch_sync_routes SET status='pause_requested',updated=? WHERE status='host_reported'").run(now());
    const {LaunchWatch}=require('./launch-watch.cjs');this.watch=new LaunchWatch(this,options.watch||{});
  }
  policy(){return {scan:'on_request',join:'explicit_selection',automatic_sync:false};}
  discovery(){const raw=this.options.discover?this.options.discover():this.service.chat.discover();const {publicCandidates}=require('./launch-watch.cjs');return {...raw,candidates:publicCandidates(raw)};}
  scan(input={}){
    if(this.closing)throw new RoomError('AgentRoom 正在停止。',503);
    if(input.room_id)this.service.chat.store.room(input.room_id);
    const scan=this.discovery();
    // A manual inventory update cannot create a room, backend, proxy, model
    // task or profile installation, and cannot change a preparation's scope.
    if(input.room_id){
      const prior=this.db.prepare('SELECT id,candidates FROM launch_sessions WHERE room_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(input.room_id);
      // A metadata refresh cannot discard the durable bridge member selected by
      // the explicit prepare action or turn a running app into a new identity.
      const grok=prior?JSON.parse(prior.candidates).find(item=>item.provider==='grok-bot'):null;
      const stored=scan.candidates.map(candidate=>candidate.provider==='grok-bot'&&grok?.prepared_member_id?{...candidate,prepared_member_id:grok.prepared_member_id}:candidate);
      if(prior)this.db.prepare('UPDATE launch_sessions SET candidates=? WHERE id=?').run(JSON.stringify(stored),prior.id);
    }
    this.service.changed();return {status:'scanned',room_id:input.room_id||null,scanned_at:now(),candidates:scan.candidates,actions:[],policy:this.policy()};
  }
  selectedProviders(input){
    if(!Array.isArray(input.providers)||input.providers.length===0)throw new RoomError('请明确选择要接入的 agent。扫描不会自动接入任何成员。',409,'choose_agents');
    if(input.providers.length>32||input.providers.some(provider=>typeof provider!=='string'||!(/^[a-z0-9][a-z0-9-]{0,79}$/).test(provider)))throw new RoomError('所选 agent 格式无效。');
    return [...new Set(input.providers)];
  }
  chooseRoom(input={}){
    if(input.room_id)return this.service.chat.store.room(input.room_id);
    let project;if(input.project_id)project=this.service.store.project(input.project_id);else if(input.project_path)project=this.service.addProject({name:input.project_name||path.basename(input.project_path),path:input.project_path});else{const p=this.service.store.projects();if(p.length!==1)throw new RoomError('请选择一次要协作的项目文件夹。',409,'choose_project');project=p[0];}
    const rooms=this.service.chat.store.rooms().filter(r=>r.project_id===project.id),last=this.db.prepare('SELECT l.room_id FROM launch_sessions l JOIN chat_rooms r ON r.id=l.room_id WHERE r.project_id=? ORDER BY l.created DESC LIMIT 1').get(project.id);
    if(last&&rooms.some(r=>r.id===last.room_id))return this.service.chat.store.room(last.room_id);
    const used=this.db.prepare("SELECT b.room_id FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id JOIN chat_rooms r ON r.id=b.room_id WHERE r.project_id=? AND e.status IN ('answered','delivered') ORDER BY e.created DESC LIMIT 1").get(project.id);
    if(used&&rooms.some(r=>r.id===used.room_id))return this.service.chat.store.room(used.room_id);
    if(rooms.length>1)throw new RoomError('该项目已有多个房间，请在首页选择一次要协作的房间。',409,'choose_room');
    return rooms[0]||this.service.chat.addRoom({project_id:project.id,title:'项目协作'});
  }
  prepare(input={}){
    if(this.closing)throw new RoomError('AgentRoom 正在停止。',503);
    const providers=this.selectedProviders(input),room=this.chooseRoom(input),pending=this.db.prepare("SELECT id,selected_providers FROM launch_sessions WHERE room_id=? AND status='preparing' ORDER BY created DESC LIMIT 1").get(room.id);
    if(pending){const previous=JSON.parse(pending.selected_providers||'[]');if(previous.length!==providers.length||providers.some(provider=>!previous.includes(provider)))throw new RoomError('上一次指定成员的接入仍在进行，请等待完成后再选择其他成员。',409,'launch_busy');return this.state({session_id:pending.id});}
    const scan=this.discovery(),unknown=providers.filter(provider=>!scan.candidates.some(candidate=>candidate.provider===provider));
    if(unknown.length)throw new RoomError('所选 agent 没有在本次扫描中发现，请先扫描并选择实际成员。',409,'provider_not_found');
    const session={id:id(),room_id:room.id,status:'preparing',goal:input.goal?redact(cleanText(input.goal,1200,'协作目标')):'',candidates:JSON.stringify(scan.candidates),install_clients:input.install_clients===true?1:0,error:null,created:now(),updated:now(),selected_providers:JSON.stringify(providers)};
    this.db.prepare('INSERT INTO launch_sessions(id,room_id,status,goal,candidates,install_clients,error,created,updated,selected_providers) VALUES(:id,:room_id,:status,:goal,:candidates,:install_clients,:error,:created,:updated,:selected_providers)').run(session);
    const selected=scan.candidates.filter(candidate=>providers.includes(candidate.provider));
    const work=this.run(session,selected).catch(e=>{this.db.prepare("UPDATE launch_sessions SET status='needs_setup',error=?,updated=? WHERE id=?").run(redact(e.message).slice(0,1200),now(),session.id);this.service.changed();}).finally(()=>this.jobs.delete(session.id));this.jobs.set(session.id,work);this.service.changed();return this.state({session_id:session.id});
  }
  backend(room,candidate){
    const chat=this.service.chat,participants=chat.store.participants(room.id);let existing;
    if(manualProviders.has(candidate.provider)){
      // Mailboxes are identities, not interchangeable product processes.
      existing=participants.find(member=>member.adapter==='mailbox'&&member.config.launch_provider===candidate.provider);
      if(existing)return existing;
      const member=chat.addMember({name:candidate.name,adapter:'mailbox'});chat.join(room.id,member.id);
      chat.store.updateMember(member.id,{status:'awaiting_handshake',config:{...chat.store.member(member.id).config,launch_provider:candidate.provider,connection_mode:'manual_mcp'}});
      return chat.store.member(member.id);
    }
    // Prefer an already used real backend over creating another same-brand bot.
    const prior=this.db.prepare('SELECT e.target_member_id FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id WHERE b.room_id=? AND e.status IN (\'answered\',\'delivered\') ORDER BY e.created DESC').all(room.id);
    for(const row of prior){const m=participants.find(m=>m.id===row.target_member_id&&m.adapter===candidate.adapter);if(m){existing=m;break;}}
    existing||=participants.find(m=>m.adapter===candidate.adapter&&m.verified_at)||participants.find(m=>m.adapter===candidate.adapter);
    if(existing)return existing;
    const member=chat.addMember({name:candidate.name,adapter:candidate.adapter,config:{executable:candidate.executable,executable_args:candidate.executable_args||[]}});chat.join(room.id,member.id);return chat.store.member(member.id);
  }
  proxy(room,candidate,backend){
    const old=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(room.id,candidate.provider);if(old){this.service.chat.store.requireParticipant(room.id,old.proxy_member_id);this.service.chat.store.requireParticipant(room.id,old.backend_member_id);return old;}
    const chat=this.service.chat;
    // Reuse the user's first working Grok bridge for Codex, rather than forcing
    // another bot or invalidating its already active credential.
    let proxy=candidate.provider==='codex'?chat.store.participants(room.id).find(m=>m.adapter==='grok-bridge'&&m.verified_at&&!this.db.prepare('SELECT 1 FROM launch_proxies WHERE proxy_member_id=?').get(m.id)):null;
    if(!proxy){proxy=chat.addMember({name:`${candidate.name} · Grok群入口`,adapter:'grok-proxy'});chat.join(room.id,proxy.id);}
    const row={id:id(),room_id:room.id,provider:candidate.provider,name:candidate.name,backend_member_id:backend.id,proxy_member_id:proxy.id,installation:null,native_bot_ref:null,native_group_ref:null,native_group_status:'pending',created:now(),updated:now()};
    this.db.prepare('INSERT INTO launch_proxies VALUES(:id,:room_id,:provider,:name,:backend_member_id,:proxy_member_id,:installation,:native_bot_ref,:native_group_ref,:native_group_status,:created,:updated)').run(row);return row;
  }
  async run(session,candidates){
    const room=this.service.chat.store.room(session.room_id);
    for(const candidate of candidates){
      if(this.closing)return;
      if(candidate.provider==='grok-bot'&&candidate.adapter==='grok-bridge'&&candidate.capabilities?.manual_connect===true){
        const member=this.prepareGrok(room),stored=JSON.parse(this.db.prepare('SELECT candidates FROM launch_sessions WHERE id=?').get(session.id).candidates);
        const selected=stored.find(item=>item.provider==='grok-bot');if(selected)selected.prepared_member_id=member.id;
        this.db.prepare('UPDATE launch_sessions SET candidates=?,updated=? WHERE id=?').run(JSON.stringify(stored),now(),session.id);this.service.changed();continue;
      }
      const managed=!!candidate.capabilities?.automatic_launch&&!!candidate.executable&&this.service.chat.adapters.get(candidate.adapter)?.capabilities.includes('native-session');
      const manual=manualProviders.has(candidate.provider)&&candidate.adapter==='mailbox'&&candidate.capabilities?.mcp_prepare===true;
      if(!managed&&!manual||managed&&candidate.installed!==true)continue;
      const old=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(room.id,candidate.provider);
      let backend=old?this.service.chat.store.member(old.backend_member_id):this.backend(room,candidate);
      // An explicit installation repair may publish a new owned CLI path. Keep
      // the member and native session while replacing only its executable.
      if(managed&&(backend.config.executable!==candidate.executable||JSON.stringify(backend.config.executable_args||[])!==JSON.stringify(candidate.executable_args||[]))){
        if(this.service.chat.active.has(backend.id))throw new RoomError('该成员正在工作，等待本轮结束后重试接入。',409,'launch_busy');
        const client=this.service.chat.clients.get(backend.id);this.service.chat.clients.delete(backend.id);if(client)await client.close();
        this.service.chat.store.updateMember(backend.id,{config:{...backend.config,executable:candidate.executable,executable_args:candidate.executable_args||[]}});backend=this.service.chat.store.member(backend.id);
      }
      const proxy=this.proxy(room,candidate,backend),backendEntry=this.service.entry.issue(backend.id,room.id,{repair_invalid:true});
      this.service.entry.issue(proxy.proxy_member_id,room.id,{repair_invalid:true});
      if(candidate.provider==='qwen-desktop'){
        let result;
        if(!this.service._localUrl)result={status:'needs_setup',installed:false,connected:false,can_wake:false,reason:'local_transport_not_started',detail:'请启动本机 AgentRoom 后重新生成 Qwen MCP 导入配置。'};
        else{
          const {createQwenMcpConfig}=require('./mcp-http.cjs'),card=JSON.parse(fs.readFileSync(backendEntry.file,'utf8'));
          const file=path.join(this.service.store.dir,'client-config','qwen-desktop',`${room.id}-${backend.id}.json`);
          atomicWrite(file,JSON.stringify(createQwenMcpConfig(this.service._localUrl,card),null,2)+'\n');
          result={status:'awaiting_import',installed:false,configured:false,connected:false,can_wake:false,needs_import:true,configuration_file:file,detail:'请在 Qwen 本人窗口的 MCP 设置中通过 JSON 导入该本机配置，再实际调用接入工具。'};
        }
        this.db.prepare('UPDATE launch_proxies SET installation=?,updated=? WHERE id=?').run(JSON.stringify(result),now(),proxy.id);
      }
      if(preparedManualProviders.has(candidate.provider)){
        const own=ownCommand();let result;
        try{result=prepareManualClient({provider:candidate.provider,data_dir:this.service.store.dir,command:own.command,args:own.args,entry_file:backendEntry.file,local_url:this.service._localUrl});}
        catch(error){result={status:'needs_setup',installed:false,connected:false,can_wake:false,detail:redact(error.message).slice(0,1000)};}
        this.db.prepare('UPDATE launch_proxies SET installation=?,updated=? WHERE id=?').run(JSON.stringify(result),now(),proxy.id);
      }
      if(session.install_clients&&['codex','claude-code','claude-desktop'].includes(candidate.provider)){
        const own=ownCommand();let result;
        try{if(candidate.provider==='codex'&&!this.options.installer)result={status:'managed_session',installed:false,needs_reload:false,connected:false,configuration_file:null,reason:'成员通信随专属后台会话加载，真实握手另行验证；无需修改个人 Codex MCP 配置。'};else result=await (this.options.installer||installClient)({provider:candidate.provider,executable:candidate.executable,executable_args:candidate.executable_args||[],command:own.command,args:own.args,entry_file:backendEntry.file},this.options.installerOptions||{});}catch(e){result={status:'needs_setup',installed:false,connected:false,reason:redact(e.message).slice(0,1000)};}
        this.db.prepare('UPDATE launch_proxies SET installation=?,updated=? WHERE id=?').run(JSON.stringify(result),now(),proxy.id);
      }
      if(this.closing)return;
      if(managed)await this.service.entry.wake(room.id,backend.id);
      this.role(proxy);this.service.changed();
    }
    this.db.prepare("UPDATE launch_sessions SET status='awaiting_grok',updated=? WHERE id=?").run(now(),session.id);this.handoff(session.id);this.service.changed();
  }
  prepareGrok(room){
    const chat=this.service.chat,participants=chat.store.participants(room.id),existing=participants.filter(member=>member.adapter==='grok-bridge');
    // A Grok Bot is an entry into the office, not a proxy pointing at itself.
    // Keep any existing fixed proxy mapping and original webhook unchanged.
    let member=existing.find(value=>value.config.launch_provider==='grok-bot')||existing.find(value=>value.verified_at)||existing[0];
    if(!member){
      const added=chat.addMember({name:'Grok Bot',adapter:'grok-bridge'});chat.join(room.id,added.id);
      chat.store.updateMember(added.id,{status:'awaiting_handshake',config:{...chat.store.member(added.id).config,launch_provider:'grok-bot',connection_mode:'manual_cli'}});member=chat.store.member(added.id);
    }
    this.service.entry.issue(member.id,room.id,{repair_invalid:true});return member;
  }
  grokEntryState(session){
    if(!session.selected_providers.includes('grok-bot'))return null;
    const selected=session.candidates.find(item=>item.provider==='grok-bot'),memberId=selected?.prepared_member_id;
    if(!memberId)return null;
    let member;try{this.service.chat.store.requireParticipant(session.room_id,memberId);member=this.service.chat.store.member(memberId);}catch{return null;}
    if(member.adapter!=='grok-bridge')return null;
    const entry=this.service.entry.describe(member.id,session.room_id),valid=entry.status==='active',ready=!!member.verified_at&&valid&&!member.error&&!['connecting','connection_failed','awaiting_handshake'].includes(member.status),own=ownCommand();
    const command=shellCommand(own.command,[...own.args,'enter','--entry',entry.file])+(process.platform==='win32'?' | Out-String -Width 4096':'');
    const history=shellCommand(own.command,[...own.args,'chat-history','--entry',entry.file])+(process.platform==='win32'?' | Out-String -Width 4096':'');
    const fixed=this.db.prepare('SELECT backend_member_id FROM launch_proxies WHERE room_id=? AND proxy_member_id=?').get(session.room_id,member.id);
    const detail='Grok Bot 需要在本人窗口调用已授权的 Windows 本机命令工具。应用进程、Webhook 配置和执行宿主连通是不同状态；Agent Office 不控制已有聊天窗口。';
    const instruction=`在你准备接入的已有 Grok Bot 本人窗口，使用已授权的 Windows 本机命令工具实际执行以下长期入口，并把流程保存为私有技能。不要使用 computer use，也不要改用云端 computer 的 localhost 或文件路径。\n\n${command}\n\n核对实际进入结果：restored=true，caller_member_id=${member.id}，members 中本人 registration=verified、registered_status=ready。只有真实执行并核对结果才完成本机握手，不能以应用开着、说明已保存或配置存在代替执行。然后查看本房间的真实成员与历史：\n${history}\n\n后续命令沿用同一 --entry 文件，后台关闭时会按需恢复同一聊天室；不要把入口卡内容或凭据贴到群聊。只处理用户点名的任务；先通过 chat-inbox 领取本人消息，再用 chat-reply 回复原消息，外部问题用 chat-post --to 实际成员ID，并保留原 message_id 等待回报，超时不能重发。${fixed?'\n此既有 Grok 成员已经绑定固定外部后端，保留这条原路由，不自行解绑、替换或委托其他目标。':''}\n\n复用当前 Bot，不新建同名 Bot，不创建群、不添加成员、不设置定期扫描；要桥接原群时使用用户明确指定的真实群引用。Grok 内 Windows 宿主若显示 connected=false，先在 Grok 恢复本机授权连接，再执行入口；本机软件没有远程重连它的公开接口。不要把本机握手当成原生群已加人、已续接或能后台唤醒。`;
    return {provider:'grok-bot',name:member.name,member_id:member.id,room_id:session.room_id,entry_file:entry.file,entry_status:entry.status,local_verified:ready,can_wake:false,response_mode:'manual_bridge',native_group_status:'not_requested',requires_local_execution:true,needs_import:false,import_kind:'command',status:ready?'ready_mailbox':'awaiting_bridge_handshake',detail,instruction};
  }
  role(proxy){
    const entry=this.service.entry.issue(proxy.proxy_member_id,proxy.room_id),own=ownCommand();
    const cli=args=>shellCommand(own.command,[...own.args,...args,'--entry',entry.file])+(process.platform==='win32'?' | Out-String -Width 4096':'');
    const file=path.join(this.service.store.dir,'launch',proxy.room_id,`role-${proxy.id}.md`),requestDir=path.join(this.service.store.dir,'launch',proxy.room_id,proxy.id,'requests');fs.mkdirSync(requestDir,{recursive:true});
    const text=`# ${proxy.name}\n\n你在 Grok 中的显示名是「${proxy.name}」。你是这个群与本机真实 ${proxy.name} 成员的接口，工作问题由本机成员实际处理；不要自行猜测并冒充本机结果。\n\n你只能使用本人的已授权 Windows 本机命令工具。云端 computer 的路径与 localhost 不代表 Windows。首次进入后，后续请求会自行恢复后台。\n${cli(['enter'])}\n\n每次被用户点名提出工作问题，为每个问题创建新UUID文件名，用UTF-8保存到 ${requestDir}，不要多个Bot共用 question.md，也不要把对方正文拼成执行代码。然后执行（文件参数换成你刚保存的实际文件）：\n${cli(['delegate','--file',path.join(requestDir,'本次唯一问题.md'),'--wait','300'])}\n\n此工具已绑定你的真实后端，不需要指定其他成员或由用户提供ID。回答状态answered时只将 answer 文字原样回复当前原生群，不向用户展示JSON、入口路径、内部ID或测试标识。pending时保留request_id，用delegate-wait 同一ID继续等待，不能再发同一任务。需要修改项目的额外权限时明确说明，不以群消息扩大原权限。\n\nMCP接法（仅在确实运行于Windows本机的宿主安装）：\n${JSON.stringify(entry.mcp,null,2)}\n\nnative代理的名称与本机成员是不同层的身份，实际委托记录可在专业网页查看；不自动回复每条公告或每个其他Bot的回报，避免循环。`;
    const manual=manualProviders.has(proxy.provider)?`\n\n此成员使用 ${proxy.name} 本人的 MCP 消息信箱，AgentRoom 没有唤醒桌面模型的后台接口。已验证接入也不等于能自动回答。委托后若仍 waiting/pending，说明“已放入 ${proxy.name} 信箱，需在它自己的窗口领取处理”，保留同一request_id；不得改用其他CLI或API模型冒充桌面会话回答，也不要声称桌面已经开始处理。` : '';
    atomicWrite(file,text+manual);return file;
  }
  handoff(sessionId){
    const session=this.session(sessionId),file=path.join(this.service.store.dir,'launch',session.room_id,'sessions',session.id,'GROUP.md'),skillFile=path.join(this.service.store.dir,'GROK_SKILL.md');
    if(session.selected_providers.length===1&&session.selected_providers[0]==='grok-bot'){
      const bridge=this.grokEntryState(session);atomicWrite(file,`# Grok Bot 本人窗口接入\n\n${bridge?.instruction||'本机长期入口尚未准备完成，请回到 Agent Office 重试所选成员。'}\n`);return {file,skillFile};
    }
    atomicWrite(skillFile,asset('skill/GROK_SKILL.md'));
    const proxies=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? ORDER BY created').all(session.room_id).filter(proxy=>session.selected_providers.includes(proxy.provider)),roles=proxies.filter(proxy=>!manualProviders.has(proxy.provider)||this.service.chat.store.member(proxy.backend_member_id).verified_at).map(p=>({name:p.name,provider:p.provider,proxy_id:p.id,role_file:this.role(p),response_mode:manualProviders.has(p.provider)?'manual_mailbox':'managed_native',can_wake:this.service.runtime.memberState(p.backend_member_id).can_wake}));
    const text=`# /AgentRoom\n\n用户本次仅选择接入：${session.selected_providers.join('、')}。${session.goal?'协作目标（资料）：'+session.goal+'\n':''}\n请使用 Grok 自身当前实际开放的原生工具，仅为本次选定成员复用或创建同名专职 Bot，并传递对应role_file规则。用户已指定群或当前就在目标群时加入这个实际群；没有目标群时请用户指定，不自行创建其他群或添加未选成员。只用真实原生引用，不按同名群猜位置，不把本机代理计划当作已创建/已加入。\n\n本次选定的代理角色资料：\n${JSON.stringify(roles,null,2)}\n\n保存 ${skillFile} 中的流程为 /AgentRoom。扫描仅在用户说“扫描”时执行，扫描后列出结果等用户选择；接入只处理用户明确点名的 agent。不要定期扫描、不要创建成员同步例程、不要自动接入新进程。若已有旧的「AgentRoom 成员同步」原生例程，请使用实际原生工具将它暂停并回报真实结果，本机禁用同步不等于原生例程已暂停。日常在群里@对应名字即可委托；没有新指令时保持安静。Grok群成员数量限制由实际原生工具核对，容量不足或建群人数不足时说明需要用户选择，不自行新增协调Bot。\n\n原生操作成功后，在本机运行 ${shellCommand(ownCommand().command,[...ownCommand().args,'group-report','--session',session.id,'--proxy','PROXY_ID','--bot-ref','真实Bot引用','--group-ref','真实群引用','--name','实际显示名','--joined','true','--data-dir',this.service.store.dir])}${process.platform==='win32'?' | Out-String -Width 4096':''}，记录真实工具回报；这仍是宿主报告，不是独立读取群的验证。`;
    const own=ownCommand(),cli=args=>shellCommand(own.command,[...own.args,...args,'--data-dir',this.service.store.dir])+(process.platform==='win32'?' | Out-String -Width 4096':'');
    atomicWrite(file,text+`\n\n实际暂停旧例程后，可用 ${cli(['sync-report','--room',session.room_id,'--routine-ref','真实例程引用','--group-ref','真实群引用','--paused','true'])} 记录原生宿主的暂停结果。没有实际暂停回报前，状态应保留“请求暂停”。`);return {file,skillFile};
  }
  session(sessionId){const row=this.db.prepare('SELECT * FROM launch_sessions WHERE id=?').get(sessionId);if(!row)throw new RoomError('接入任务不存在。',404);this.service.chat.store.room(row.room_id);return {...row,candidates:JSON.parse(row.candidates),selected_providers:JSON.parse(row.selected_providers||'[]')};}
  clientConfig(input){
    const session=this.session(input.session_id);
    if(!session.selected_providers.includes(input.provider))throw new RoomError('本次接入没有选择这个客户端。',403,'provider_not_selected');
    const proxy=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(session.room_id,input.provider);
    if(!proxy||!manualProviders.has(proxy.provider))throw new RoomError('该客户端没有本次桌面 MCP 导入配置。',409,'client_config_missing');
    if(proxy.provider==='claude-desktop')return {config:this.service.entry.issue(proxy.backend_member_id,session.room_id).mcp};
    const installation=proxy.installation?JSON.parse(proxy.installation):null,file=installation?.configuration_file;
    const base=path.join(this.service.store.dir,'client-config'),expected=path.join(base,proxy.provider,`${session.room_id}-${proxy.backend_member_id}.json`);
    if(typeof file!=='string'||path.resolve(file)!==path.resolve(expected))throw new RoomError('客户端导入文件不属于当前成员。',403,'client_config_scope_mismatch');
    let canonical,root;
    try{canonical=fs.realpathSync.native(file);root=fs.realpathSync.native(base);}catch{throw new RoomError('本机 MCP 导入文件不存在，请重新生成所选成员配置。',409,'client_config_missing');}
    const relative=path.relative(root,canonical);
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new RoomError('客户端导入文件超出了 AgentRoom 本机配置目录。',403,'client_config_scope_mismatch');
    const stat=fs.statSync(canonical);if(!stat.isFile()||stat.size>64000)throw new RoomError('客户端导入配置不是有效的小型 JSON 文件。',409,'client_config_invalid');
    let config;try{config=JSON.parse(fs.readFileSync(canonical,'utf8'));}catch{throw new RoomError('客户端导入配置不是有效 JSON。',409,'client_config_invalid');}
    if(preparedManualProviders.has(proxy.provider)){
      if(proxy.provider==='doubao'&&(!config.manual_fields||config.config))throw new RoomError('豆包连接器材料不符合当前成员的字段合同。',409,'client_config_invalid');
      if(proxy.provider!=='doubao'&&!config.config)throw new RoomError('客户端材料缺少已生成的 MCP 配置。',409,'client_config_invalid');
      return config;
    }
    return {config};
  }
  state(input={}){
    let session;if(input.session_id)session=this.session(input.session_id);else{const room=input.room_id;if(room)this.service.chat.store.room(room);const active=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_room_tombstones'").get()?'NOT EXISTS (SELECT 1 FROM chat_room_tombstones t WHERE t.room_id=launch_sessions.room_id)':'1=1';const row=room?this.db.prepare(`SELECT id FROM launch_sessions WHERE room_id=? AND ${active} ORDER BY created DESC,rowid DESC LIMIT 1`).get(room):this.db.prepare(`SELECT id FROM launch_sessions WHERE ${active} ORDER BY created DESC,rowid DESC LIMIT 1`).get();if(!row)return {status:'not_prepared',proxies:[],members:[],candidates:[],selected_providers:[],actions:[],grok_verified:false,policy:this.policy(),native_sync:{status:'disabled',verified:false}};session=this.session(row.id);}
    const rows=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? ORDER BY created').all(session.room_id),members=[];
    const proxies=rows.map(p=>{const backend=this.service.chat.store.member(p.backend_member_id),manual=manualProviders.has(p.provider),entry=this.service.entry.describe(backend.id,p.room_id),connecting=backend.status==='connecting'||this.service.chat.active.get(backend.id)?.connecting===true;
      const credentialValid=manual?entry.status==='active':entry.available,ready=!!backend.verified_at&&credentialValid&&!connecting&&!backend.error&&!['connection_failed','awaiting_handshake'].includes(backend.status),canWake=this.service.runtime.memberState(backend.id).can_wake;
      members.push(this.service.chat.publicMember(backend));return {...p,installation:p.installation?JSON.parse(p.installation):null,credential_status:entry.status,status:ready?(manual?'ready_mailbox':'ready_local'):connecting?'connecting':manual?'awaiting_desktop_handshake':'needs_setup',reason:backend.error||(!credentialValid?'通信入口不可用，需要明确重新接入。':manual?(ready?`已接入 ${p.name} 消息信箱；需要它在本人窗口领取和回复，不能后台唤醒模型。`:`MCP 配置不代表接入；请在 ${p.name} 本人窗口实际调用工具完成握手。`):null),local_verified:ready,grok_verified:false,can_wake:canWake,response_mode:manual?'manual_mailbox':'managed_native'};});
    const handoff=path.join(this.service.store.dir,'launch',session.room_id,'sessions',session.id,'GROUP.md'),skill=path.join(this.service.store.dir,'GROK_SKILL.md'),own=ownCommand();
    const selected=proxies.filter(proxy=>session.selected_providers.includes(proxy.provider)),grokEntry=this.grokEntryState(session);
    if(grokEntry)members.push(this.service.chat.publicMember(this.service.chat.store.member(grokEntry.member_id)));
    const selectedHandshakes=selected.filter(proxy=>manualProviders.has(proxy.provider)&&!proxy.local_verified).map(proxy=>{
      const entry=this.service.entry.describe(proxy.backend_member_id,session.room_id);
      const introduction=proxy.provider==='qwen-desktop'?'在 Qwen 本人窗口的 MCP 设置中选择添加并通过 JSON 导入专属本机配置。':proxy.provider==='claude-desktop'?'重新加载 Claude 桌面的 AgentRoom MCP。':proxy.provider==='doubao'?'在豆包本地电脑模式填写专属个人连接器字段，启用工具；这不是 JSON 自动导入。':`在 ${proxy.name} 本人窗口按官方格式导入专属 MCP 配置并启用工具。`;
      return {provider:proxy.provider,name:proxy.name,member_id:proxy.backend_member_id,room_id:session.room_id,entry_file:entry.file,entry_status:entry.status,...proxy.provider==='claude-desktop'?{mcp:entry.mcp}:{},configuration_file:proxy.installation?.configuration_file||null,needs_import:proxy.installation?.needs_import===true,import_kind:proxy.installation?.import_kind||'json',can_wake:false,status:'awaiting_desktop_handshake',instruction:`${introduction}不要把配置凭据贴到群聊。在 ${proxy.name} 本人窗口实际调用 agentroom_room_ensure，再调用 agentroom_heartbeat。随后使用 agentroom_chat_inbox 领取发给本人的问题并用 agentroom_chat_reply 回复。配置文件或进程存在都不能代替真实握手。`};
    });
    if(grokEntry&&!grokEntry.local_verified)selectedHandshakes.push(grokEntry);
    const onlyGrok=session.selected_providers.length===1&&session.selected_providers[0]==='grok-bot';
    const prompt=fs.existsSync(handoff)?onlyGrok?`请在当前已有 Grok Bot 本人窗口，用已授权的 Windows 本机命令工具读取 ${handoff}，实际执行长期入口并核对握手结果；复用当前 Bot，不新建 Bot、不创建群或加人、不定期扫描，也不使用 computer use。`:`请读取 ${skill} 并更新 /AgentRoom 私有技能：仅在我要求时扫描，且只接入我明确选择的 agent，不定期扫描、不主动加群。使用已授权的 Windows 本机工具读取 ${handoff}，本次仅处理其中选定成员，在我指定的实际群中复用或创建对应名字的 Bot。若已有旧的 AgentRoom 成员同步例程，请用原生工具暂停并回报实际结果。日常直接 @对应成员即可。`:'正在准备本次选定成员，完成后会生成接入说明。';
    let status=session.status==='awaiting_grok'&&selected.some(p=>p.status==='connecting')?'preparing':session.status;
    if(status==='awaiting_grok'&&!selected.length&&!grokEntry)status='needs_setup';
    if(status==='awaiting_grok'&&selectedHandshakes.length)status='awaiting_desktop_handshake';
    if(onlyGrok&&grokEntry&&status==='awaiting_grok')status=grokEntry.local_verified?'ready_mailbox':'awaiting_bridge_handshake';
    if(onlyGrok&&grokEntry&&status==='awaiting_desktop_handshake')status='awaiting_bridge_handshake';
    if(status==='awaiting_grok'&&selected.length&&selected.every(p=>p.native_group_status==='host_reported'))status='host_reported';
    const syncRoute=this.db.prepare('SELECT * FROM launch_sync_routes WHERE room_id=?').get(session.room_id)||null;
    const cli=args=>shellCommand(own.command,[...own.args,...args,'--data-dir',this.service.store.dir])+(process.platform==='win32'?' | Out-String -Width 4096':'');
    return {...session,status,candidates:session.candidates,members,proxies,bridge_members:grokEntry?[{provider:grokEntry.provider,member_id:grokEntry.member_id,name:grokEntry.name,local_verified:grokEntry.local_verified,can_wake:false,response_mode:grokEntry.response_mode,native_group_status:grokEntry.native_group_status,entry_status:grokEntry.entry_status}]:[],selected_handshakes:selectedHandshakes,grok_prompt:prompt,handoff_file:fs.existsSync(handoff)?handoff:null,skill_file:onlyGrok?null:skill,skill_command:onlyGrok?null:'/AgentRoom',grok_verified:false,policy:this.policy(),watch:this.watch?.status(session.room_id)||null,native_sync:syncRoute?{...syncRoute,verified:false}:{status:'disabled',verified:false},sync_command:cli(['group-sync','--changes-only','--room',session.room_id]),sync_report_command:cli(['sync-report','--room',session.room_id,'--routine-ref','真实例程引用','--group-ref','真实群引用','--paused','true']),actions:selected.filter(p=>p.local_verified&&p.native_group_status==='pending').slice(0,5).map(p=>({operation:'create_or_reuse_native_bot',name:p.name,proxy_id:p.id,role_file:path.join(this.service.store.dir,'launch',p.room_id,`role-${p.id}.md`),group_operation:'join_user_requested_group',can_wake:p.can_wake,response_mode:p.response_mode})),mcp_setup:onlyGrok?null:{mcpServers:{agentroom:{command:own.command,args:[...own.args,'mcp','--setup']}}}};
  }
  report(input){
    const session=this.session(input.session_id),proxy=this.db.prepare('SELECT * FROM launch_proxies WHERE id=? AND room_id=?').get(input.proxy_id,session.room_id);if(!proxy)throw new RoomError('原生报告与该接入任务不匹配。',403);
    if(!session.selected_providers.includes(proxy.provider))throw new RoomError('本次请求没有选择这个 agent，不能扩大加群范围。',403,'provider_not_selected');
    if(manualProviders.has(proxy.provider)&&!this.service.chat.store.member(proxy.backend_member_id).verified_at)throw new RoomError('桌面 agent 需先在本人窗口完成实际 MCP 握手，配置安装不能代替接入。',409,'desktop_handshake_required');
    const name=cleanText(input.name,100,'原生Bot名称');if(name.toLocaleLowerCase()!==proxy.name.toLocaleLowerCase())throw new RoomError('原生名称与请求的成员名称不匹配。',409);
    if(input.joined!==true)throw new RoomError('只有实际原生工具成功加群后才能记录报告。',409);
    const bot=cleanText(input.bot_ref,2000,'真实Bot引用'),group=cleanText(input.group_ref,2000,'真实群引用');
    if(proxy.native_bot_ref&&(proxy.native_bot_ref!==bot||proxy.native_group_ref!==group))throw new RoomError('这个代理已属于不同原生Bot或群，不能静默改路由。',409);
    const route=this.db.prepare('SELECT group_ref FROM launch_sync_routes WHERE room_id=?').get(session.room_id),other=this.db.prepare('SELECT native_group_ref FROM launch_proxies WHERE room_id=? AND native_group_ref IS NOT NULL AND native_group_ref<>? LIMIT 1').get(session.room_id,group);
    if(route&&route.group_ref!==group||other)throw new RoomError('这个房间已绑定不同原生群，不能静默改路由。',409);
    this.db.prepare("UPDATE launch_proxies SET native_bot_ref=?,native_group_ref=?,native_group_status='host_reported',updated=? WHERE id=?").run(bot,group,now(),proxy.id);this.service.changed();return this.state({session_id:session.id});
  }
  syncReport(input){
    if(input.paused!==true)throw new RoomError('用户已禁用定期扫描和自动接入；只能回报实际暂停旧例程的结果。',403,'automatic_sync_disabled');
    this.service.chat.store.room(input.room_id);
    const routine=cleanText(input.routine_ref,2000,'已实际暂停的例程引用'),group=cleanText(input.group_ref,2000,'真实群引用');
    const groups=this.db.prepare('SELECT DISTINCT native_group_ref FROM launch_proxies WHERE room_id=? AND native_group_ref IS NOT NULL').all(input.room_id);if(groups.length&&!groups.some(g=>g.native_group_ref===group))throw new RoomError('同步例程不能静默切换到另一原生群。',409);
    const prior=this.db.prepare('SELECT * FROM launch_sync_routes WHERE room_id=?').get(input.room_id);if(prior&&(prior.group_ref!==group||prior.routine_ref!==routine))throw new RoomError('暂停报告必须属于之前记录的实际原生例程和群。',409);
    this.db.prepare("INSERT INTO launch_sync_routes VALUES(?,?,?,?,?,'host_reported_paused',?) ON CONFLICT(room_id) DO UPDATE SET status='host_reported_paused',updated=excluded.updated").run(input.room_id,routine,group,prior?.interval_minutes||0,prior?.next_run||'',now());this.service.changed();return this.state({room_id:input.room_id});
  }
  sync(input={}){
    const roomId=input.room_id||this.db.prepare('SELECT room_id FROM launch_sessions ORDER BY created DESC,rowid DESC LIMIT 1').get()?.room_id||null;
    if(roomId)this.service.chat.store.room(roomId);
    const route=roomId?this.db.prepare('SELECT * FROM launch_sync_routes WHERE room_id=?').get(roomId):null;
    const paused=route?.status==='host_reported_paused',own=ownCommand();
    const reportCommand=route&&!paused?shellCommand(own.command,[...own.args,'sync-report','--room',roomId,'--routine-ref',route.routine_ref,'--group-ref',route.group_ref,'--paused','true','--data-dir',this.service.store.dir])+(process.platform==='win32'?' | Out-String -Width 4096':''):null;
    return {status:'automatic_sync_disabled',room_id:roomId,changed:false,actions:[],policy:this.policy(),grok_verified:false,
      pause_routine:{status:paused?'host_reported_paused':'pause_requested',routine_ref:route?.routine_ref||null,group_ref:route?.group_ref||null,host_reported:paused,requires_pause:!paused,verified:false},report_command:reportCommand,
      instruction:paused?'旧原生例程已有宿主暂停报告，请保持停用，不要重复暂停、扫描、建群、加人、安装或执行模型任务。':'用户要求停止定期扫描和自动接入。请暂停当前或已记录的原生 AgentRoom 成员同步例程，并在实际成功后用 report_command 回报；不要执行扫描、建群、加人、安装或模型任务。'};
  }
  ownProxy(memberId,roomId){this.service.chat.store.requireParticipant(roomId,memberId);const p=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND proxy_member_id=?').get(roomId,memberId);if(!p)throw new RoomError('当前成员没有已绑定的本机代理目标。',403,'proxy_not_bound');return p;}
  lookup(memberId,roomId){this.service.chat.store.requireParticipant(roomId,memberId);const p=this.db.prepare('SELECT id,provider,name,backend_member_id,proxy_member_id FROM launch_proxies WHERE room_id=? AND proxy_member_id=?').get(roomId,memberId);return p||null;}
  async delegate(memberId,roomId,input){const proxy=this.ownProxy(memberId,roomId),key=input.key||id();const e=this.service.bridge.request({member_id:memberId,room_id:roomId,target_member_id:proxy.backend_member_id,text:input.text,idempotency_key:key,conversation_ref:input.origin,external_message_id:input.source_message});return this.result(await this.service.bridge.wait(e.id,Math.min(25,input.seconds??25),memberId,roomId));}
  async wait(memberId,roomId,requestId,seconds=25){const p=this.ownProxy(memberId,roomId),e=this.service.bridge.requireOwner(requestId,memberId,roomId);if(e.target_member_id!==p.backend_member_id)throw new RoomError('请求不属于此代理后端。',403);return this.result(await this.service.bridge.wait(requestId,seconds,memberId,roomId));}
  result(e){return {status:e.status,request_id:e.id,answer:e.response_text||'',error:e.error||null,from:e.target_member_name,return_to_origin:true};}
  async close(){this.closing=true;await this.watch.close();await Promise.allSettled([...this.jobs.values()]);}
}
module.exports={LaunchManager};
