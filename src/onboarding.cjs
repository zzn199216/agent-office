'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,id,now,redact,cleanText}=require('./util.cjs');

const MANAGED=new Set(['codex','claude-code','qwen-code','gemini-cli']);
const DESKTOP=new Set(['claude-desktop','qwen-desktop','doubao','opencode','cherry-studio','cline','roo-code']);
const BRIDGE=new Set(['grok-bot']);
const MANAGED_ALTERNATIVE={'claude-desktop':'claude-code','qwen-desktop':'qwen-code'};
const NAMES={codex:'Codex','claude-code':'Claude Code','qwen-code':'Qwen Code','gemini-cli':'Gemini CLI','claude-desktop':'Claude 桌面客户端','qwen-desktop':'Qwen 桌面客户端','grok-bot':'Grok Bot · 本人窗口桥接',doubao:'豆包桌面 · 本人窗口协作',opencode:'OpenCode · 本人窗口协作','cherry-studio':'Cherry Studio · 本人窗口协作',cline:'Cline · 本人窗口协作','roo-code':'Roo Code · 本人窗口协作'};
const json=(value,fallback)=>{try{return JSON.parse(value);}catch{return fallback;}};
// Status pages never return configuration bodies, resume cards or URLs carrying
// credentials. The authenticated, scoped import endpoint remains separate.
const safeText=value=>redact(value).replace(/https?:\/\/[^\s<>"']+/gi,'[地址已隐藏]').replace(/(?:secret|token|key)\s*[:=]\s*[^\s,;]+/gi,'凭据=[已隐藏]').slice(0,1000);
const AUTH=/登录|认证|授权|模型服务|API.?key|凭据|login|sign.?in|authentication|auth.?required|unauthenticated/i;
const action=(kind,label,extra={})=>({id:kind,kind,label,...extra});
function providerBlock(provider,error){
  if(provider!=='gemini-cli')return null;
  const code=String(error?.code||''),message=String(error?.message||error||'');
  if(/gemini_(?:missing|upgrade_required|version_unknown|probe_failed)/.test(code)||/Gemini CLI.*(?:需要 \d+\.\d+|稳定版版本|没有找到)/.test(message))return 'awaiting_runtime_install';
  if(/gemini_quota_required/.test(code)||/Gemini CLI.*(?:额度|请求限制)/.test(message))return 'awaiting_quota';
  if(error?.needsAction||/^gemini_/.test(code)||/Gemini CLI.*(?:系统级管理配置|超出.*权限|拒绝.*操作|原.*会话|不可恢复|专用.*MCP)/.test(message))return 'awaiting_provider_action';
  return null;
}

class OnboardingManager{
  constructor(service,options={}){
    this.service=service;this.options=options;this.db=service.store.db;this.jobs=new Map();this.closing=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS onboarding_runs(
      id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES chat_rooms(id),
      requested_provider TEXT NOT NULL,provider TEXT NOT NULL,mode TEXT NOT NULL,
      status TEXT NOT NULL,stage TEXT NOT NULL,launch_session_id TEXT,
      install_client INTEGER NOT NULL DEFAULT 0,install_runtime INTEGER NOT NULL DEFAULT 0,
      runtime_result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,goal TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS onboarding_runs_scope ON onboarding_runs(room_id,provider,mode,created);`);
    if(!this.db.prepare('PRAGMA table_info(onboarding_runs)').all().some(column=>column.name==='goal'))this.db.exec("ALTER TABLE onboarding_runs ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(onboarding_runs)').all().some(column=>column.name==='verify_reply'))this.db.exec('ALTER TABLE onboarding_runs ADD COLUMN verify_reply INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(onboarding_runs)').all().some(column=>column.name==='direct_member_id'))this.db.exec('ALTER TABLE onboarding_runs ADD COLUMN direct_member_id TEXT');
    this.db.prepare("UPDATE onboarding_runs SET status='interrupted',stage='interrupted',error='接入期间本机处理程序结束。请点击重试；不会重放业务问题。',updated=? WHERE status='running' AND stage<>'verifying_reply'").run(now());
    this.verification=options.replyVerification===false?null:new (require('./onboarding-verification.cjs').OnboardingVerification)(service,options.verification||{});
    this.verificationPulse=()=>this.advanceVerifications();this.service.on?.('change',this.verificationPulse);
    this.verificationTimer=setInterval(this.verificationPulse,options.verification?.pollMs||500);this.verificationTimer.unref();
  }
  selection(input={}){
    const requested=input.provider;
    if(typeof requested!=='string'||!(/^[a-z0-9][a-z0-9-]{0,79}$/).test(requested))throw new RoomError('请选择一个要接入的 agent。',400,'choose_agent');
    if(input.providers!==undefined)throw new RoomError('一键接入每次只处理选定的一个 agent。',400,'single_provider_required');
    const mode=input.mode|| (BRIDGE.has(requested)?'bridge':DESKTOP.has(requested)?'desktop':'managed');
    if(!['managed','desktop','bridge'].includes(mode)||mode==='bridge'&&!BRIDGE.has(requested)||BRIDGE.has(requested)&&mode!=='bridge')throw new RoomError('接入模式无效。',400,'onboarding_mode_invalid');
    if(mode==='desktop'&&MANAGED.has(requested))throw new RoomError('命令行 agent 不能作为另一个桌面会话接入。',400,'onboarding_mode_invalid');
    return {requested_provider:requested,provider:requested,mode};
  }
  row(runId){const row=this.db.prepare('SELECT * FROM onboarding_runs WHERE id=?').get(runId);if(!row)throw new RoomError('接入进度不存在。',404,'onboarding_not_found');this.service.chat.store.room(row.room_id);return row;}
  set(runId,fields){
    const current=this.db.prepare('SELECT room_id,status FROM onboarding_runs WHERE id=?').get(runId);
    if(current?.status==='cancelled'||current&&this.service.chat.roomDeleted?.(current.room_id))return;
    const allowed=new Set(['status','stage','launch_session_id','runtime_result','error']);
    const pairs=Object.entries(fields).filter(([key])=>allowed.has(key));
    if(!pairs.length)return;
    this.db.prepare(`UPDATE onboarding_runs SET ${pairs.map(([key])=>`${key}=?`).join(',')},updated=? WHERE id=?`).run(...pairs.map(([,value])=>value),now(),runId);
    this.service.changed();
  }
  start(input={}){
    if(this.closing)throw new RoomError('AgentRoom 正在停止。',503);
    const selection=this.selection(input),goal=input.goal==null||input.goal===''?'':redact(cleanText(input.goal,1200,'协作目标')),room=this.service.launch.chooseRoom(input);
    const previous=this.db.prepare('SELECT * FROM onboarding_runs WHERE room_id=? AND provider=? AND mode=? ORDER BY created DESC,rowid DESC LIMIT 1').get(room.id,selection.provider,selection.mode);
    if(previous){
      const snapshot=this.snapshot(previous);
      // Reading or repeating the same button cannot silently increase install
      // permission, recreate a native session or replay a model handshake.
      if(['waiting','waiting_result','uncertain'].includes(snapshot.reply_verification?.status)||snapshot.status==='running'||snapshot.status==='ready'||input.retry!==true&&!['error','interrupted'].includes(snapshot.status))return {...snapshot,reused:true};
      if(input.retry===true&&snapshot.member_id&&this.connectionSnapshot(previous).stage==='ready_automatic'&&this.verification?.retryFailed(snapshot.member_id,!snapshot.automatic_reply_verified)){
        this.set(previous.id,{status:'needs_action',stage:'awaiting_connection',error:null});this.advanceVerifications();
        return {...this.snapshot(this.row(previous.id)),reused:true};
      }
      if(input.retry===true&&snapshot.member_id)this.verification?.retryFailed(snapshot.member_id);
    }
    const row={id:id(),room_id:room.id,...selection,status:'running',stage:'preparing',launch_session_id:null,install_client:input.install_client===true?1:0,install_runtime:input.install_runtime===true?1:0,runtime_result:null,error:null,created:now(),updated:now(),goal,verify_reply:this.verification?1:0};
    this.db.prepare('INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,launch_session_id,install_client,install_runtime,runtime_result,error,created,updated,goal,verify_reply) VALUES(:id,:room_id,:requested_provider,:provider,:mode,:status,:stage,:launch_session_id,:install_client,:install_runtime,:runtime_result,:error,:created,:updated,:goal,:verify_reply)').run(row);
    const existing=this.connectionSnapshot(row);
    // A working member from an older version has no onboarding history. Keep
    // that real connection rather than reporting ready and then quietly starting
    // another model handshake or modifying its profile behind the same button.
    if(existing.status==='ready'&&existing.native_group_status==='host_reported'){
      const sessions=this.db.prepare('SELECT id,selected_providers FROM launch_sessions WHERE room_id=? ORDER BY rowid DESC').all(room.id);
      const matching=sessions.find(session=>{const providers=json(session.selected_providers,[]);return Array.isArray(providers)&&providers.length===1&&providers[0]===row.provider;});
      this.set(row.id,{status:'ready',stage:existing.stage,launch_session_id:matching?.id||null});
      this.advanceVerifications();
      return {...this.snapshot(this.row(row.id)),reused:true};
    }
    // Defer work until the job map and durable run exist. A rapid second click
    // therefore always finds and reuses this attempt.
    const work=Promise.resolve().then(()=>this.run(row)).catch(error=>{
      const login=AUTH.test(error?.message||'')||/login|auth/.test(error?.code||'');
      const block=providerBlock(row.provider,error);
      this.set(row.id,{status:login||block?'needs_action':'error',stage:login?'awaiting_auth':block||'error',error:safeText(error?.message||'接入失败，请重试。')});
    }).finally(()=>{this.jobs.delete(row.id);this.advanceVerifications();});
    this.jobs.set(row.id,work);this.service.changed();return this.snapshot(row);
  }
  retry(input={}){
    const row=this.row(input.run_id);
    if(input.provider&&input.provider!==row.provider&&input.provider!==row.requested_provider||input.room_id&&input.room_id!==row.room_id)throw new RoomError('重试不能切换到另一个成员或房间。',403,'onboarding_scope_mismatch');
    if(row.direct_member_id){this.verification?.retryFailed(row.direct_member_id,!this.service.runtime.connectionState(row.direct_member_id).automatic_reply_verified);return this.verifyMember({member_id:row.direct_member_id,room_id:row.room_id});}
    return this.start({provider:row.requested_provider,mode:row.mode,room_id:row.room_id,goal:row.goal||'',retry:true,
      install_client:input.install_client===undefined?!!row.install_client:input.install_client===true,
      install_runtime:input.install_runtime===undefined?!!row.install_runtime:input.install_runtime===true});
  }
  verifyMember(input={}){
    if(this.closing)throw new RoomError('AgentRoom 正在停止。',503);
    const member=this.service.chat.store.member(input.member_id),room=this.service.chat.store.room(input.room_id);
    this.service.chat.store.requireParticipant(room.id,member.id);
    const desktop=this.service.desktop?.row(member.id);
    if(!desktop||!this.service.desktop.canWake(member.id))throw new RoomError('本人对话尚未接通，保留已有连接。',409,'desktop_not_connected');
    let row=this.db.prepare('SELECT * FROM onboarding_runs WHERE room_id=? ORDER BY rowid DESC').all(room.id)
      .find(candidate=>this.connectionSnapshot(candidate).member_id===member.id);
    if(row){
      this.db.prepare("UPDATE onboarding_runs SET verify_reply=?,status='needs_action',stage='awaiting_connection',error=NULL,updated=? WHERE id=?")
        .run(this.verification?1:0,now(),row.id);
    }else{
      const stamp=now();row={id:id(),room_id:room.id,requested_provider:desktop.provider,provider:desktop.provider,
        mode:BRIDGE.has(desktop.provider)?'bridge':'desktop',status:'needs_action',stage:'awaiting_connection',created:stamp,updated:stamp,
        verify_reply:this.verification?1:0,direct_member_id:member.id};
      this.db.prepare(`INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,created,updated,verify_reply,direct_member_id)
        VALUES(:id,:room_id,:requested_provider,:provider,:mode,:status,:stage,:created,:updated,:verify_reply,:direct_member_id)`).run(row);
    }
    this.advanceVerifications();return this.snapshot(this.row(row.id));
  }
  async run(row){
    if(this.closing||this.service.chat.roomDeleted?.(row.room_id))return;
    if(row.mode==='managed'&&DESKTOP.has(row.provider)){
      this.set(row.id,{status:'needs_action',stage:'requires_explicit_backend_selection'});return;
    }
    if(row.install_runtime&&MANAGED.has(row.provider)&&this.options.runtimeInstaller){
      this.set(row.id,{stage:'installing_runtime'});
      // This hook is a trusted provider installer. No command, URL, package or
      // account supplied by a chat participant can become executable input.
      const raw=await this.options.runtimeInstaller({provider:row.provider,requested_provider:row.requested_provider,mode:row.mode,room_id:row.room_id,run_id:row.id});
      if(this.service.chat.roomDeleted?.(row.room_id))return;
      const result={status:typeof raw?.status==='string'?raw.status:'needs_setup',installed:raw?.installed===true,
        ...(typeof raw?.signed_in==='boolean'?{signed_in:raw.signed_in}:{}),
        ...(raw?.reason?{reason:safeText(raw.reason)}:{}),...(raw?.detail?{detail:safeText(raw.detail)}:{})};
      this.set(row.id,{runtime_result:JSON.stringify(result)});
      if(['needs_login','awaiting_auth','login_required'].includes(result.status)||result.signed_in===false){this.set(row.id,{status:'needs_action',stage:'awaiting_auth'});return;}
      if(!result.installed||['needs_setup','failed','error','needs_manual_install'].includes(result.status)){this.set(row.id,{status:'needs_action',stage:'awaiting_runtime_install'});return;}
    }
    if(this.closing||this.service.chat.roomDeleted?.(row.room_id))return;
    this.set(row.id,{stage:'preparing_connection'});
    let launch;
    try{launch=this.service.launch.prepare({room_id:row.room_id,providers:[row.provider],install_clients:!!row.install_client,goal:row.goal||''});}
    catch(error){
      if(error?.code==='launch_busy'){this.set(row.id,{status:'needs_action',stage:'waiting_other_setup',error:'另一个成员正在接入，请等待完成后点击重试。'});return;}
      if(error?.code==='provider_not_found'){this.set(row.id,{status:'needs_action',stage:MANAGED.has(row.provider)?'awaiting_runtime_install':'unsupported',error:'没有发现这个 agent 的可用入口。'});return;}
      throw error;
    }
    this.set(row.id,{launch_session_id:launch.id,stage:'connecting'});
    const work=this.service.launch.jobs.get(launch.id);if(work)await work;
    if(this.closing)return;
    if(['qwen-desktop','doubao','grok-bot'].includes(row.provider)&&this.options.desktopConnector&&(row.provider!=='grok-bot'||this.service.desktop?.nativeCapability(row.provider).available)){
      const prepared=this.snapshot(this.row(row.id));
      if(prepared.member_id){
        try{await this.options.desktopConnector({member_id:prepared.member_id,room_id:row.room_id,provider:row.provider});this.set(row.id,{status:'needs_action',stage:'awaiting_connection',error:null});this.advanceVerifications();return;}
        catch(error){this.set(row.id,{status:'needs_action',stage:'awaiting_native_desktop',error:safeText(error.message)});return;}
      }
    }
    this.set(row.id,{status:'needs_action',stage:'awaiting_connection'});this.advanceVerifications();
  }
  state(input={}){
    let row;
    if(input.run_id){row=this.row(input.run_id);if(input.room_id&&row.room_id!==input.room_id||input.provider&&row.provider!==input.provider&&row.requested_provider!==input.provider)throw new RoomError('接入进度不属于所选成员或房间。',403,'onboarding_scope_mismatch');}
    else{
      const clauses=[],values=[];
      if(input.room_id){this.service.chat.store.room(input.room_id);clauses.push('room_id=?');values.push(input.room_id);}
      if(input.provider){const selection=this.selection(input);clauses.push('provider=?');values.push(selection.provider);}
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_room_tombstones'").get())clauses.push('NOT EXISTS (SELECT 1 FROM chat_room_tombstones t WHERE t.room_id=onboarding_runs.room_id)');
      row=this.db.prepare(`SELECT * FROM onboarding_runs ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY created DESC,rowid DESC LIMIT 1`).get(...values);
    }
    return row?this.snapshot(row):{status:'not_started',stage:'not_started',next_actions:[],local_verified:false,can_wake:false,native_group_status:'not_prepared',policy:this.service.launch.policy()};
  }
  credentialState(roomId,member){
    // The original file may still name a deleted room. The credential row is
    // authoritative after rehoming; describe follows it without issuing cards.
    if(this.service.entry?.describePrimary)return this.service.entry.describePrimary(member.id,roomId).status;
    if(this.service.entry?.describe)return this.service.entry.describe(member.id,roomId).status;
    const file=path.join(this.service.store.dir,'entries',`${member.id}-${roomId}.json`);
    try{
      if(fs.statSync(file).size>64000)return 'invalid';
      const card=JSON.parse(fs.readFileSync(file,'utf8'));
      if(card.member_id!==member.id||card.room_id!==roomId||typeof card.credential_id!=='string')return 'invalid';
      // inspect is an authoritative, read-only credential and membership check.
      // Do not call issue/accept here: a revoked card requires user retry.
      const inspected=this.service.resume?.inspect(card);
      const credential=inspected?.credential||this.db.prepare('SELECT status FROM chat_resume_credentials WHERE id=? AND room_id=? AND member_id=?').get(card.credential_id,roomId,member.id);
      return credential?.status||'missing';
    }catch(error){return error?.code==='resume_revoked'?'revoked':error?.code==='ENOENT'?'missing':'invalid';}
  }
  advanceVerifications(){
    if(this.closing||!this.verification||this.advancingVerification)return;
    this.advancingVerification=true;
    try{
      this.verification.refresh();
      const rows=this.db.prepare("SELECT * FROM onboarding_runs WHERE verify_reply=1 AND status NOT IN ('cancelled','error','interrupted') AND stage IN ('awaiting_connection','awaiting_native_desktop','ready_automatic','verifying_reply','verification_pending','verification_failed')").all();
      for(const row of rows){
        if(this.service.chat.roomDeleted?.(row.room_id))continue;
        const connection=this.connectionSnapshot(row);
        if(connection.member_id&&connection.local_verified&&connection.can_wake&&connection.stage==='ready_automatic'){
          if(this.service.chat.store.joined&&!this.service.chat.store.joined(row.room_id,connection.member_id))continue;
          let verification=this.verification.row(connection.member_id);
          if(!verification||verification.room_id!==row.room_id&&verification.status!=='verified')verification=this.verification.begin(row,this.service.chat.store.member(connection.member_id));
          else verification=this.verification.view(verification);
          if(verification?.status==='verified')this.setIfDifferent(row,{status:'ready',stage:'ready_automatic',error:null});
          else if(verification?.status==='waiting')this.setIfDifferent(row,{status:'running',stage:'verifying_reply',error:null});
          else this.setIfDifferent(row,{status:'needs_action',stage:verification?.status==='failed'?'verification_failed':'verification_pending',error:verification?.error||null});
        }
      }
    }finally{this.advancingVerification=false;}
  }
  setIfDifferent(row,fields){if(Object.entries(fields).some(([key,value])=>row[key]!==value))this.set(row.id,fields);}
  snapshot(row){
    const base=this.connectionSnapshot(row);
    if(!row.verify_reply||!this.verification)return base;
    const verification=base.member_id?this.verification.view(this.verification.row(base.member_id)):null;
    base.reply_verification=verification;base.ready_for_office=base.status==='ready'&&base.stage==='ready_mailbox';
    if(base.stage!=='ready_automatic'||!base.can_wake||!base.local_verified)return base;
    base.ready_for_office=verification?.status==='verified'&&base.automatic_reply_verified===true;
    if(base.ready_for_office){base.detail='已自动核对本人对话的实际回复，可以开始协作。';return base;}
    base.next_actions=[];
    base.status=verification&&verification.status!=='waiting'?'needs_action':'running';
    base.stage=verification?.status==='failed'?'verification_failed':verification&&verification.status!=='waiting'?'verification_pending':'verifying_reply';
    base.error=verification?.error||null;
    base.detail=verification?.error||'连接已建立，正在自动验证本人对话的实际回复；无需去客户端发消息。';
    if(verification?.status==='failed')base.next_actions=[action('verify','重新验证连接',{operation:'retry'})];
    if(verification?.status==='verified'&&!base.automatic_reply_verified){
      base.error=base.connection_evidence?.last_error?`原生调用当前未通过（${safeText(base.connection_evidence.last_error.code)}）。`:'本人对话正在恢复，等待原连接重新上线。';
      base.detail=`这位同事此前已通过自动回复验证。${base.error}已有连接与原对话保留。`;
      if(base.connection_evidence?.last_error)base.next_actions=[action('verify','重新验证连接',{operation:'retry'})];
    }
    return base;
  }
  connectionSnapshot(row){
    const base={id:row.id,run_id:row.id,room_id:row.room_id,requested_provider:row.requested_provider,provider:row.provider,name:NAMES[row.provider]||row.provider,mode:row.mode,
      status:row.status,stage:row.stage,launch_session_id:row.launch_session_id,install_client:!!row.install_client,install_runtime:!!row.install_runtime,
      created:row.created,updated:row.updated,goal:row.goal||'',error:row.error?safeText(row.error):null,runtime:json(row.runtime_result,null),
      local_verified:false,can_wake:false,protocol_verified:false,model_reply_verified:false,runner_ready:false,native_conversation_loaded:false,automatic_reply_verified:false,error_stage:null,readiness:'unverified',connection_evidence:null,response_mode:BRIDGE.has(row.provider)?'manual_bridge':DESKTOP.has(row.provider)?'manual_mailbox':'managed_native',native_group_status:'not_prepared',grok_verified:false,next_actions:[],policy:this.service.launch.policy(),
      ...BRIDGE.has(row.provider)?{native_direct_available:this.service.desktop?.nativeCapability(row.provider).available===true,connection_method:'grok_command_bridge'}:{}};
    if(row.direct_member_id){
      let member;try{this.service.chat.store.requireParticipant(row.room_id,row.direct_member_id);member=this.service.chat.store.member(row.direct_member_id);}catch{return {...base,status:'needs_action',stage:'awaiting_connection',detail:'原人物当前不在这个房间，已有连接保留。'};}
      const runtime=this.service.runtime.memberState(member.id),evidence=runtime.connection_evidence||null,canWake=this.service.desktop?.canWake(member.id)===true;
      Object.assign(base,{member_id:member.id,name:member.name,local_verified:canWake,can_wake:canWake,response_mode:'managed_desktop',runner_ready:canWake,
        connection_evidence:evidence,protocol_verified:evidence?.protocol_verified===true,model_reply_verified:evidence?.model_reply_verified===true,
        native_conversation_loaded:evidence?.native_conversation_loaded===true,automatic_reply_verified:evidence?.automatic_reply_verified===true,
        readiness:evidence?.verification_level||'unverified',error_stage:evidence?.last_error?.stage||null});
      return canWake?{...base,status:'ready',stage:'ready_automatic',error:null}:{...base,status:'needs_action',stage:'awaiting_connection',detail:'正在恢复这位同事的原对话，已有连接保留。'};
    }
    // A pure SQLite read deliberately bypasses launch.state(), which historically
    // renews or issues entry cards for unfinished desktop handshakes.
    const session=row.launch_session_id?this.db.prepare('SELECT * FROM launch_sessions WHERE id=? AND room_id=?').get(row.launch_session_id,row.room_id):null;
    const candidate=json(session?.candidates,[]);
    const selected=Array.isArray(candidate)?candidate.find(item=>item.provider===row.provider):null;
    if(BRIDGE.has(row.provider)){
      let member=null;try{if(selected?.prepared_member_id){this.service.chat.store.requireParticipant(row.room_id,selected.prepared_member_id);member=this.service.chat.store.member(selected.prepared_member_id);if(member.adapter!=='grok-bridge')member=null;}}catch{}
      if(member){
        const credentialStatus=this.credentialState(row.room_id,member),verified=!!member.verified_at&&credentialStatus==='active'&&!member.error&&!['connecting','connection_failed','awaiting_handshake'].includes(member.status);
        const evidence=this.service.runtime.memberState(member.id).connection_evidence||null;
        Object.assign(base,{name:member.name,member_id:member.id,credential_status:credentialStatus,local_verified:verified,native_group_status:'not_requested'});
        Object.assign(base,{connection_evidence:evidence,protocol_verified:evidence?.protocol_verified===true,model_reply_verified:evidence?.model_reply_verified===true,
          runner_ready:evidence?.runner_online===true,native_conversation_loaded:evidence?.native_conversation_loaded===true,
          automatic_reply_verified:evidence?.automatic_reply_verified===true,error_stage:evidence?.last_error?.stage||null,
          readiness:evidence?.verification_level|| (verified?'registration_verified':'unverified')});
        if(this.service.desktop?.canWake(member.id)){Object.assign(base,{status:'ready',stage:'ready_automatic',local_verified:true,can_wake:true,response_mode:'managed_desktop',runner_ready:true,error:null,detail:base.automatic_reply_verified?'本人对话已核对实际自动回复。':'本人对话已接通；首条消息将核对实际自动回复。'});return base;}
        if(['interrupted','error'].includes(row.status)||session?.error){base.status='error';base.stage='error';base.error=safeText(session?.error||row.error||'本机桥接入口准备失败。');base.next_actions=[action('verify','重试准备入口',{operation:'retry'})];return base;}
        if(!['active','pending'].includes(credentialStatus)){base.status='needs_action';base.stage='awaiting_credential';base.detail='既有 Grok 成员的长期入口不可用，需你明确重新授权接入。';base.next_actions=[action('verify','重新授权接入',{operation:'retry'})];return base;}
        if(verified){base.status='ready';base.stage='ready_mailbox';base.error=null;base.handshake_verified=true;base.detail='已验证 Grok 本机入口，可以进入办公室。已有 Bot、Webhook 和固定路由保留；尚未验证 AO 自动唤醒 Grok，不需要先创建群聊。';return base;}
        if(row.stage==='awaiting_native_desktop'&&base.native_direct_available){base.detail='本人对话未接通；检查客户端是否开启本机连接，再点击连接本人对话。';base.next_actions=[action('verify','连接本人对话',{operation:'native_desktop_connect'})];return base;}
        base.status='needs_action';base.stage='awaiting_bridge_handshake';base.error=null;base.handshake_verified=false;base.detail='复制连接说明，发到已有 Grok Bot 对话。让它使用已授权的本机命令接通，AO 会自动核对实际握手；不需要先创建群聊。';base.next_actions=[action('self_handshake','复制连接说明',{operation:'copy_handshake_prompt'})];return base;
      }
      if(row.status==='running'&&this.jobs.has(row.id)||session?.status==='preparing'){base.status='running';return base;}
      base.status='needs_action';base.stage='unsupported';base.next_actions=[action('verify','重试准备 Grok Bot 本人入口',{operation:'retry'})];return base;
    }
    const proxy=this.db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(row.room_id,row.provider);
    let member=null,installation=null,credentialStatus=null,nativeConnecting=false;
    if(proxy){
      member=this.service.chat.store.member(proxy.backend_member_id);installation=json(proxy.installation,null);
      nativeConnecting=this.service.chat.active?.get(member.id)?.connecting===true;
      credentialStatus=this.credentialState(row.room_id,member);
      const credentialValid=member.adapter==='mailbox'?credentialStatus==='active':['active','pending'].includes(credentialStatus);
      const verified=!!member.verified_at&&credentialValid&&!nativeConnecting&&!['connection_failed','awaiting_handshake','connecting'].includes(member.status)&&!member.error;
      const runtime=this.service.runtime.memberState(member.id);
      const evidence=runtime.connection_evidence||null;
      Object.assign(base,{name:proxy.name,proxy_id:proxy.id,member_id:member.id,local_verified:verified,can_wake:runtime.can_wake===true,
        protocol_verified:evidence?.protocol_verified===true,model_reply_verified:evidence?.model_reply_verified===true,
        runner_ready:evidence?.runner_online===true,native_conversation_loaded:evidence?.native_conversation_loaded===true,
        automatic_reply_verified:evidence?.automatic_reply_verified===true,connection_evidence:evidence,
        error_stage:evidence?.last_error?.stage||null,
        readiness:evidence?.verification_level|| (verified?'registration_verified':'unverified'),
        native_group_status:proxy.native_group_status||'pending',response_mode:member.adapter==='mailbox'?'manual_mailbox':'managed_native',
        credential_status:credentialStatus,
        installation:installation?{status:installation.status||'needs_setup',installed:installation.installed===true,needs_reload:installation.needs_reload===true,needs_import:installation.needs_import===true,...['form','json'].includes(installation.import_kind)?{import_kind:installation.import_kind}:{},detail:installation.detail?safeText(installation.detail):null}:null});
    }
    if(['interrupted','error'].includes(row.status)){
      base.next_actions=[action('verify','重试接入',{operation:'retry'})];return base;
    }
    if(member&&this.service.desktop?.canWake(member.id)){Object.assign(base,{status:'ready',stage:'ready_automatic',local_verified:true,can_wake:true,response_mode:'managed_desktop',runner_ready:true,error:null,detail:base.automatic_reply_verified?'本人对话已核对实际自动回复。':'本人对话已接通；首条消息将核对实际自动回复。',next_actions:[]});return base;}
    if(row.stage==='requires_explicit_backend_selection'||row.mode==='managed'&&DESKTOP.has(row.provider)){
      const alternative=MANAGED_ALTERNATIVE[row.provider];base.status='needs_action';base.stage=row.stage;
      base.next_actions=alternative?[action('verify',`如需后台回答，请明确选择 ${NAMES[alternative]}`,{operation:'select_provider',provider:alternative})]:[action('verify','使用所选客户端的本人窗口协作入口',{operation:'select_provider',provider:row.provider,mode:'desktop'})];return base;
    }
    if(base.local_verified){
      if(base.can_wake||base.response_mode==='manual_mailbox'){
        base.status='ready';base.stage=base.can_wake?'ready_automatic':'ready_mailbox';base.error=null;
        base.detail=base.can_wake?base.automatic_reply_verified?'已核对实际任务回复，可在后台处理群里的委托。':base.protocol_verified||member.config?.connection_verification==='local_mcp'?'本机 MCP 通信与登录已核对；实际模型回复尚待任务验证，回复时会单独显示等待进度。':'接入记录可用；首次实际任务后核对自动回复能力。':'已接入消息信箱；需在本人窗口领取和回复，不能后台唤醒。';
        if(base.native_group_status==='pending')base.next_actions=[action('open_native_group','加入你指定的 Grok 群',{operation:'native_group_handoff'})];
        return base;
      }
      base.status='needs_action';base.stage='needs_wake_adapter';base.next_actions=[action('unsupported','尚无后台唤醒适配器')];return base;
    }
    if(row.status==='running'&&this.jobs.has(row.id)||session?.status==='preparing'||member?.status==='connecting'||nativeConnecting){
      base.status='running';base.stage=member?.status==='connecting'||nativeConnecting?'connecting':row.stage;const progress=member&&this.service.chat.connectionProgress?.get(member.id);if(progress)base.detail=safeText(progress);return base;
    }
    if(proxy&&!['active','pending'].includes(credentialStatus)){
      base.status='needs_action';base.stage='awaiting_credential';base.detail=credentialStatus==='revoked'?'此成员的通信入口已撤销，需要你明确重新接入。':'此成员的通信入口不可用，需要你明确重新接入。';
      base.next_actions=[action('verify','重新授权接入',{operation:'retry'})];return base;
    }
    if(row.stage==='awaiting_native_desktop'&&member){base.detail='本人对话未接通；检查客户端是否开启本机连接，再点击连接本人对话。';base.next_actions=[action('verify','连接本人对话',{operation:'native_desktop_connect'})];return base;}
    if(row.stage==='awaiting_auth'||member?.error&&AUTH.test(member.error)){
      base.status='needs_action';base.stage='awaiting_auth';base.error=member?.error||row.error?safeText(member?.error||row.error):null;
      if(row.provider==='claude-code'){let config;try{config=require('./claude.cjs').configurationInfo(this.options.env||process.env);}catch{}base.configuration=config?{file:config.file,api_mode:config.api_mode,credential_configured:config.credential_configured}:null;}
      base.next_actions=[DESKTOP.has(row.provider)?action('self_handshake','在本人客户端完成授权和接入',{operation:'copy_handshake_prompt'}):action('login',base.configuration?.api_mode?'配置 Claude API':`登录 ${base.name}`,{operation:'login_client'}),action('verify',base.configuration?.api_mode?'保存后继续接入':'登录后继续接入',{operation:'retry'})];return base;
    }
    const providerStage=['awaiting_quota','awaiting_provider_action'].includes(row.stage)?row.stage:providerBlock(row.provider,member?.error||session?.error);
    if(providerStage&&providerStage!=='awaiting_runtime_install'){
      base.status='needs_action';base.stage=providerStage;base.error=safeText(member?.error||session?.error||row.error||'请核对该客户端自己的配置后继续接入。');
      base.next_actions=[...(providerStage==='awaiting_quota'?[action('login','在 Gemini CLI 检查额度和权限',{operation:'login_client'})]:[]),action('verify','处理客户端配置后继续接入',{operation:'retry'})];return base;
    }
    if(row.stage==='awaiting_runtime_install'||providerStage==='awaiting_runtime_install'||selected&&MANAGED.has(row.provider)&&(selected.installed!==true||!selected.capabilities?.automatic_launch)){
      base.status='needs_action';base.stage='awaiting_runtime_install';base.next_actions=[action('verify',`安装 ${base.name} 后继续接入`,{operation:'install_runtime'})];return base;
    }
    if(row.stage==='waiting_other_setup'){
      base.status='needs_action';base.next_actions=[action('verify','等待其他成员接入后重试',{operation:'retry'})];return base;
    }
    if(row.stage==='unsupported'||!proxy){
      base.status='needs_action';base.stage='unsupported';base.next_actions=[action('unsupported','该客户端尚无可用接入适配器')];return base;
    }
    if(member?.status==='connection_failed'||session?.status==='interrupted'||session?.error){
      base.status=session?.status==='interrupted'?'interrupted':'error';base.stage=base.status;base.error=safeText(member?.error||session?.error||'连接验证失败。');base.next_actions=[action('verify','重试接入',{operation:'retry'})];return base;
    }
    base.status='needs_action';
    if(installation?.needs_import||installation?.status==='awaiting_import'){
      base.stage='awaiting_import';base.next_actions.push(action('import_mcp',installation?.import_kind==='form'?'填写豆包个人连接器':'导入 Agent Office MCP',{operation:'import_client_config'}));
    }else if(installation?.needs_reload){
      base.stage='awaiting_reload';base.next_actions.push(action('reload_client',`重新加载 ${base.name}`,{operation:'reload_client'}));
    }else base.stage='awaiting_handshake';
    base.next_actions.push(action('self_handshake','在本人聊天里确认接入',{operation:'copy_handshake_prompt'}));
    return base;
  }
  async close(){this.closing=true;clearInterval(this.verificationTimer);this.service.off?.('change',this.verificationPulse);await Promise.allSettled([...this.jobs.values()]);}
}
module.exports={OnboardingManager};
