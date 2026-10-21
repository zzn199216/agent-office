'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,id,now,redact,cleanText}=require('./util.cjs');
const {resolveConnectionTarget,existingConnectionState}=require('./connection-target.cjs');

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
    for(const [name,type]of [['target_member_id','TEXT'],['connection_reused','INTEGER NOT NULL DEFAULT 0'],['reauthorize','INTEGER NOT NULL DEFAULT 0'],['selection_reason','TEXT'],['connection_method','TEXT'],['started_at','TEXT']])if(!this.db.prepare('PRAGMA table_info(onboarding_runs)').all().some(column=>column.name===name))this.db.exec(`ALTER TABLE onboarding_runs ADD COLUMN ${name} ${type}`);
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
    const method=input.connection_method;
    if(method!==undefined&&(!['native_desktop','manual_mcp'].includes(method)||!DESKTOP.has(requested)))throw new RoomError('接入方式无效。',400,'onboarding_method_invalid');
    if(method==='native_desktop'&&!this.service.desktop?.nativeCapability(requested).available)throw new RoomError('这个客户端尚无已验证的原生接入方式。',409,'desktop_adapter_unverified');
    return {requested_provider:requested,provider:requested,mode,connection_method:method||this.connectionMethod({provider:requested})};
  }
  connectionMethod(row){return row.connection_method||(['qwen-desktop','doubao'].includes(row.provider)?'native_desktop':DESKTOP.has(row.provider)?'manual_mcp':BRIDGE.has(row.provider)?'grok_command_bridge':'managed_native');}
  setDeliveryMethod(memberId,method){
    if(!memberId||!this.service.resume||!['native_desktop','manual_mcp'].includes(method))return;
    let changed=false;
    this.service.chat.store.transaction(()=>{
      // Serialize the pending-run check with native dispatch before selecting a
      // different transport. No credential or native session is replaced.
      this.db.prepare('UPDATE chat_members SET config=config WHERE id=?').run(memberId);
      const member=this.service.chat.store.member(memberId);
      if(method==='manual_mcp'&&(this.service.chat.nativeDeliveryPending(memberId)||this.service.chat.active?.get(memberId)?.desktop||this.service.desktop?.jobs.has(memberId)||this.service.desktop?.connecting.has(memberId)))throw new RoomError('这位同事有正在执行或结果待核对的原生请求。请先核对原请求，不能改走手动信箱重复执行。',409,'desktop_request_uncertain');
      if(member.config.desktop_delivery_mode!==method){this.service.chat.store.updateMember(memberId,{config:{...member.config,desktop_delivery_mode:method}});changed=true;}
    });
    if(method==='manual_mcp')this.service.desktop?.pauseForManual(memberId);
    if(changed)this.service.changed();
  }
  managedBindingNeeded(row,memberId){
    if(!this.verification||!MANAGED.has(row.provider))return false;
    const binding=this.service.chat.store.binding(row.room_id,memberId);
    return !binding.thread_id||binding.binding_state!=='bound'||!this.service.runtime.connectionState(memberId).sessions.some(session=>session.native_session_id===binding.thread_id&&session.protocol.state==='verified');
  }
  managedBindingBlocked(memberId){
    if(this.service.chat.active.has(memberId))return true;
    const previous=this.verification?.row(memberId);if(!previous)return false;
    const message=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(previous.message_id);
    return !['verified','failed'].includes(previous.status)||this.verification.dispatchState(previous,message)!=='terminal';
  }
  async prepareManagedBinding(row,memberId){
    if(!this.managedBindingNeeded(row,memberId))return true;
    if(this.managedBindingBlocked(memberId))return false;
    this.set(row.id,{status:'running',stage:'connecting',error:null});
    await this.service.chat.connectNative(this.service.chat.store.member(memberId),this.service.chat.store.room(row.room_id));
    const work=this.service.chat.connecting.get(`${row.room_id}:${memberId}`);if(work)await work;
    const member=this.service.chat.store.member(memberId);
    if(member.status!=='ready'||this.managedBindingNeeded(row,memberId))throw new RoomError(member.error||'本房间的原生连接尚未通过真实握手，已有连接保留。',409,'managed_handshake_required');
    return true;
  }
  resumeManagedBinding(row,memberId){
    if(this.jobs.has(row.id)||this.managedBindingBlocked(memberId))return;
    const work=Promise.resolve().then(async()=>{if(await this.prepareManagedBinding(row,memberId))this.set(row.id,{status:'needs_action',stage:'awaiting_connection',error:null});})
      .catch(error=>this.set(row.id,{status:'needs_action',stage:AUTH.test(error.message)?'awaiting_auth':'error',error:safeText(error.message)}))
      .finally(()=>{this.jobs.delete(row.id);this.advanceVerifications();});this.jobs.set(row.id,work);
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
    const target=this.service.chat.store.participants&&this.service.resume?resolveConnectionTarget(this.service,{provider:selection.provider,room_id:room.id,target_member_id:input.target_member_id}):{member_id:null,blocked:false,reused_connection:false};
    if(input.reauthorize===true&&(!input.target_member_id||input.target_member_id!==target.member_id))throw new RoomError('重新授权必须明确指定原人物。',403,'connection_target_required');
    const switchingMethod=!!target.member?.config.desktop_delivery_mode&&target.member.config.desktop_delivery_mode!==selection.connection_method;
    if(!target.blocked&&!target.fixed_proxy)this.setDeliveryMethod(target.member_id,selection.connection_method);
    const previous=!switchingMethod&&this.db.prepare('SELECT * FROM onboarding_runs WHERE room_id=? AND provider=? AND mode=? ORDER BY created DESC,rowid DESC').all(room.id,selection.provider,selection.mode).find(candidate=>{
      if(!this.service.resume)return true;
      const memberId=candidate.target_member_id||candidate.direct_member_id||this.connectionSnapshot(candidate).member_id||null;
      return memberId===(target.member_id||null)&&this.connectionMethod(candidate)===selection.connection_method;
    });
    if(previous){
      const snapshot=this.snapshot(previous);
      if(previous.stage==='awaiting_previous_result'){this.advanceVerifications();return {...this.snapshot(this.row(previous.id)),reused:true};}
      // Reading or repeating the same button cannot silently increase install
      // permission, recreate a native session or replay a model handshake.
      if(['waiting','waiting_result','uncertain'].includes(snapshot.reply_verification?.status)||snapshot.status==='running'||this.jobs.has(previous.id)||snapshot.status==='ready'&&!target.blocked||input.reauthorize===true&&previous.reauthorize&&!target.blocked&&!['error','interrupted'].includes(snapshot.status)||input.reauthorize!==true&&(snapshot.status==='ready'||input.retry!==true&&!['error','interrupted'].includes(snapshot.status)))return {...snapshot,reused:true};
      if(input.retry===true&&snapshot.member_id&&this.connectionSnapshot(previous).stage==='ready_automatic'&&this.verification?.retryFailed(snapshot.member_id,!snapshot.automatic_reply_verified)){
        this.db.prepare('UPDATE onboarding_runs SET started_at=? WHERE id=?').run(now(),previous.id);
        this.set(previous.id,{status:'needs_action',stage:'awaiting_connection',error:null});this.advanceVerifications();
        return {...this.snapshot(this.row(previous.id)),reused:true};
      }
      if(input.retry===true&&snapshot.member_id)this.verification?.retryFailed(snapshot.member_id);
    }
    const fixedElsewhere=target.fixed_proxy&&target.fixed_proxy.room_id!==room.id;
    const stamp=now(),row={id:id(),room_id:room.id,...selection,status:fixedElsewhere||target.blocked&&input.reauthorize!==true?'needs_action':'running',stage:fixedElsewhere?'fixed_proxy_scope':target.blocked&&input.reauthorize!==true?'awaiting_credential':'preparing',launch_session_id:null,install_client:input.install_client===true?1:0,install_runtime:input.install_runtime===true?1:0,runtime_result:null,error:null,created:stamp,updated:stamp,started_at:stamp,goal,verify_reply:this.verification?1:0,target_member_id:target.member_id,connection_reused:target.reused_connection?1:0,reauthorize:input.reauthorize===true?1:0,selection_reason:target.reason||null};
    this.db.prepare('INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,launch_session_id,install_client,install_runtime,runtime_result,error,created,updated,goal,verify_reply,target_member_id,connection_reused,reauthorize,selection_reason,connection_method,started_at) VALUES(:id,:room_id,:requested_provider,:provider,:mode,:status,:stage,:launch_session_id,:install_client,:install_runtime,:runtime_result,:error,:created,:updated,:goal,:verify_reply,:target_member_id,:connection_reused,:reauthorize,:selection_reason,:connection_method,:started_at)').run(row);
    if(fixedElsewhere){this.service.changed();return this.snapshot(row);}
    if(target.blocked&&!row.reauthorize){this.service.changed();return this.snapshot(row);}
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
    if(row.direct_member_id){if(this.verification?.retryFailed(row.direct_member_id,!this.service.runtime.connectionState(row.direct_member_id).automatic_reply_verified))this.db.prepare('UPDATE onboarding_runs SET started_at=? WHERE id=?').run(now(),row.id);return this.verifyMember({member_id:row.direct_member_id,room_id:row.room_id});}
    return this.start({provider:row.requested_provider,mode:row.mode,room_id:row.room_id,goal:row.goal||'',retry:true,
      target_member_id:row.target_member_id||undefined,connection_method:DESKTOP.has(row.provider)?this.connectionMethod(row):undefined,
      install_client:input.install_client===undefined?!!row.install_client:input.install_client===true,
      install_runtime:input.install_runtime===undefined?!!row.install_runtime:input.install_runtime===true});
  }
  verifyMember(input={}){
    if(this.closing)throw new RoomError('AgentRoom 正在停止。',503);
    const member=this.service.chat.store.member(input.member_id),room=this.service.chat.store.room(input.room_id);
    this.service.chat.store.requireParticipant(room.id,member.id);
    const desktop=this.service.desktop?.row(member.id);
    if(!desktop||!this.service.desktop.canWake(member.id))throw new RoomError('本人对话尚未接通，保留已有连接。',409,'desktop_not_connected');
    const latest=this.db.prepare('SELECT * FROM onboarding_runs WHERE room_id=? ORDER BY rowid DESC').all(room.id)
      .find(candidate=>this.connectionSnapshot(candidate).member_id===member.id);
    let row=latest&&this.connectionMethod(latest)==='native_desktop'?latest:null;
    if(row){
      this.db.prepare("UPDATE onboarding_runs SET connection_method='native_desktop',verify_reply=?,status='needs_action',stage='awaiting_connection',error=NULL,updated=? WHERE id=?")
        .run(this.verification?1:0,now(),row.id);
    }else{
      const stamp=now();row={id:id(),room_id:room.id,requested_provider:desktop.provider,provider:desktop.provider,
        mode:BRIDGE.has(desktop.provider)?'bridge':'desktop',status:'needs_action',stage:'awaiting_connection',created:stamp,updated:stamp,
        verify_reply:this.verification?1:0,direct_member_id:member.id,connection_method:'native_desktop',started_at:stamp};
      this.db.prepare(`INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,created,updated,verify_reply,direct_member_id,connection_method,started_at)
        VALUES(:id,:room_id,:requested_provider,:provider,:mode,:status,:stage,:created,:updated,:verify_reply,:direct_member_id,:connection_method,:started_at)`).run(row);
    }
    this.advanceVerifications();return this.snapshot(this.row(row.id));
  }
  async run(row){
    if(this.closing||this.service.chat.roomDeleted?.(row.room_id))return;
    if(row.target_member_id&&!row.reauthorize){
      const target=resolveConnectionTarget(this.service,{provider:row.provider,room_id:row.room_id,target_member_id:row.target_member_id});
      const manualExisting=['manual_mcp','grok_command_bridge'].includes(this.connectionMethod(row))&&target.credential_active;
      if(!target.blocked&&(target.reused_connection||manualExisting)){
        if(!target.joined)this.service.chat.join(row.room_id,target.member_id);
        if(!await this.prepareManagedBinding(row,target.member_id)){this.set(row.id,{status:'needs_action',stage:'awaiting_previous_result',error:'正在观察这位同事的原请求，核对结束前不会发起新的握手或验证。'});return;}
        const native=this.service.desktop?.row(target.member_id);
        if(this.connectionMethod(row)==='native_desktop'&&!this.service.desktop.canWake(target.member_id)){
          this.set(row.id,{status:'running',stage:'restoring_native',error:null});
          try{if(!this.options.desktopConnector)throw new RoomError('已有原生对话暂不可恢复，请查看原连接。',409,'desktop_not_connected');await this.options.desktopConnector({member_id:target.member_id,room_id:row.room_id,provider:row.provider,...native?.native_session_id?{recovery:true}:{}});}
          catch(error){this.set(row.id,{status:'needs_action',stage:'awaiting_native_desktop',error:safeText(error.message)});return;}
        }
        this.set(row.id,{status:'needs_action',stage:'awaiting_connection',error:null});return;
      }
    }
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
    try{launch=this.service.launch.prepare({room_id:row.room_id,providers:[row.provider],install_clients:!!row.install_client,goal:row.goal||'',...row.target_member_id?{target_member_id:row.target_member_id}:{},...row.reauthorize?{reauthorize:true}:{}});}
    catch(error){
      if(error?.code==='launch_busy'){this.set(row.id,{status:'needs_action',stage:'waiting_other_setup',error:'另一个成员正在接入，请等待完成后点击重试。'});return;}
      if(error?.code==='provider_not_found'){this.set(row.id,{status:'needs_action',stage:MANAGED.has(row.provider)?'awaiting_runtime_install':'unsupported',error:'没有发现这个 agent 的可用入口。'});return;}
      throw error;
    }
    this.set(row.id,{launch_session_id:launch.id,stage:'connecting'});
    const work=this.service.launch.jobs.get(launch.id);if(work)await work;
    if(this.closing)return;
    this.setDeliveryMethod(this.connectionSnapshot(this.row(row.id)).member_id,this.connectionMethod(row));
    if((this.connectionMethod(row)==='native_desktop'||row.provider==='grok-bot'&&this.service.desktop?.nativeCapability(row.provider).available)&&this.options.desktopConnector){
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
      const rows=this.db.prepare("SELECT * FROM onboarding_runs WHERE verify_reply=1 AND status NOT IN ('cancelled','error','interrupted') AND stage IN ('awaiting_connection','awaiting_native_desktop','awaiting_previous_result','ready_automatic','verifying_reply','verification_pending','verification_failed') ORDER BY created DESC,rowid DESC").all(),seen=new Set();
      for(const row of rows){
        if(this.service.chat.roomDeleted?.(row.room_id))continue;
        const connection=this.connectionSnapshot(row);
        if(connection.member_id){if(seen.has(connection.member_id))continue;seen.add(connection.member_id);}
        if(row.stage==='awaiting_previous_result'&&connection.member_id){this.resumeManagedBinding(row,connection.member_id);continue;}
        if(connection.member_id&&connection.local_verified&&connection.can_wake&&connection.stage==='ready_automatic'){
          if(this.service.chat.store.joined&&!this.service.chat.store.joined(row.room_id,connection.member_id))continue;
          let verification=this.verification.row(connection.member_id);
          if(!this.verification.belongsToRun(verification,row))verification=this.verification.begin(row,this.service.chat.store.member(connection.member_id));
          else verification=this.verification.view(verification,row);
          if(verification?.status==='verified'&&verification.current_attempt)this.setIfDifferent(row,{status:'ready',stage:'ready_automatic',error:null});
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
    const verification=base.member_id?this.verification.view(this.verification.row(base.member_id),row):null;
    base.reply_verification=verification;base.ready_for_office=['manual_mcp','grok_command_bridge'].includes(base.connection_method)&&base.status==='ready'&&base.stage==='ready_mailbox';
    base.automatic_reply_verified=base.automatic_reply_verified===true&&verification?.current_attempt===true&&verification.status==='verified';
    base.model_reply_verified=base.model_reply_verified===true&&verification?.current_attempt===true&&verification.status==='verified';
    if(!base.automatic_reply_verified&&base.readiness==='reply_verified')base.readiness=base.protocol_verified?'protocol_verified':'registered_only';
    if(base.stage!=='ready_automatic'||!base.can_wake||!base.local_verified)return base;
    base.ready_for_office=verification?.status==='verified'&&verification.current_attempt===true&&base.automatic_reply_verified===true;
    if(base.ready_for_office){base.detail='已自动核对本人对话的实际回复，可以开始协作。';return base;}
    base.next_actions=[];
    base.status=verification&&verification.status!=='waiting'?'needs_action':'running';
    base.stage=verification?.status==='failed'?'verification_failed':verification&&verification.status!=='waiting'?'verification_pending':'verifying_reply';
    base.error=verification?.error||null;
    base.detail=verification?.error||'连接已建立，正在自动验证本人对话的实际回复；无需去客户端发消息。';
    if(verification?.status==='failed')base.next_actions=[action('verify','重新验证连接',{operation:'retry'})];
    if(verification?.status==='verified'&&(!verification.current_attempt||!base.automatic_reply_verified)){
      base.error=base.connection_evidence?.last_error?`原生调用当前未通过（${safeText(base.connection_evidence.last_error.code)}）。`:'本人对话正在恢复，等待原连接重新上线。';
      base.detail=`这位同事此前已通过自动回复验证。${base.error}已有连接与原对话保留。`;
      if(base.connection_evidence?.last_error)base.next_actions=[action('verify','重新验证连接',{operation:'retry'})];
    }
    return base;
  }
  connectionSnapshot(row){
    const base=this.rawConnectionSnapshot(row),method=this.connectionMethod(row),started=row.started_at||row.created;
    Object.assign(base,{connection_method:method,started_at:started});
    if(method==='managed_native'&&row.stage==='awaiting_previous_result')return {...base,status:'needs_action',stage:'awaiting_previous_result',ready_for_office:false,local_verified:false,error:row.error,detail:'正在观察这位同事的原请求。结果核对结束后继续当前接入，不会重复提交原问题。',next_actions:[action('verify','核对原请求后检查连接',{operation:'retry'})]};
    if(base.stage==='fixed_proxy_scope'&&base.fixed_proxy?.room_id)base.next_actions=[action('open_fixed_room','查看原房间连接',{operation:'open_fixed_room',room_id:base.fixed_proxy.room_id,target_member_id:base.member_id})];
    if(!base.member_id||['fixed_proxy_scope','awaiting_credential','requires_explicit_backend_selection'].includes(base.stage)||row.mode==='managed'&&DESKTOP.has(row.provider))return base;
    if(base.can_wake&&!base.connection_evidence){const evidence=this.service.runtime.memberState(base.member_id).connection_evidence;Object.assign(base,{connection_evidence:evidence,protocol_verified:evidence?.protocol_verified===true,model_reply_verified:evidence?.model_reply_verified===true,automatic_reply_verified:evidence?.automatic_reply_verified===true,readiness:evidence?.verification_level||'unverified'});}
    if(method==='native_desktop'){
      const connected=this.service.desktop?.canWake(base.member_id)===true,native=this.service.desktop?.state(base.member_id);
      if(!connected){
        Object.assign(base,{local_verified:false,can_wake:false,protocol_verified:false,model_reply_verified:false,runner_ready:false,native_conversation_loaded:false,automatic_reply_verified:false,ready_for_office:false,response_mode:'managed_desktop'});
        if(!['running','error','interrupted','cancelled'].includes(base.status)||['ready_mailbox','existing_connection','awaiting_native_desktop'].includes(base.stage))Object.assign(base,{status:'needs_action',stage:'awaiting_native_desktop'});
        base.error=safeText(row.error||native?.error||base.error||'本人原生对话尚未接通，已有连接保留。');
        base.detail=base.error;base.next_actions=[action('open_native_client','开启客户端连接',{operation:'open_native_client'}),action('verify','连接本人对话',{operation:'native_desktop_connect'}),action('manual','改用手动 MCP',{operation:'manual_mcp',target_member_id:base.member_id})];
      }
    }else if(method==='manual_mcp'||method==='grok_command_bridge'){
      const credentials=this.service.resume?.credentials(base.member_id)||this.db.prepare('SELECT * FROM chat_resume_credentials WHERE member_id=?').all(base.member_id),credential=credentials.find(value=>value.status==='active'&&Date.parse(value.last_seen||'')>=Date.parse(started)),member=this.service.chat.store.member(base.member_id),entryActive=this.credentialState(row.room_id,member)==='active';
      const verified=!!credential&&entryActive&&!!member.verified_at&&!['disabled','revoked'].includes(member.status)&&this.service.chat.store.joined(row.room_id,member.id);
      Object.assign(base,{local_verified:verified,can_wake:false,protocol_verified:verified,model_reply_verified:false,runner_ready:false,native_conversation_loaded:false,automatic_reply_verified:false,response_mode:method==='manual_mcp'?'manual_mailbox':'manual_bridge',handshake_verified:verified,ready_for_office:verified});
      if(verified){Object.assign(base,{status:'ready',stage:'ready_mailbox',error:null});base.next_actions=[];}
      else if(!['running','error','interrupted','cancelled'].includes(base.status)&&(entryActive||!['awaiting_import','awaiting_reload'].includes(base.stage)))Object.assign(base,{status:'needs_action',stage:method==='manual_mcp'?'awaiting_handshake':'awaiting_bridge_handshake',error:null,detail:'已有配置与凭据保留。请在本人窗口实际调用接入工具，等待本次握手；无需重新导入。',next_actions:[action('self_handshake','复制本人接入说明',{operation:'copy_handshake_prompt'})]});
    }
    return base;
  }
  rawConnectionSnapshot(row){
    const base={id:row.id,run_id:row.id,room_id:row.room_id,requested_provider:row.requested_provider,provider:row.provider,name:NAMES[row.provider]||row.provider,mode:row.mode,
      status:row.status,stage:row.stage,launch_session_id:row.launch_session_id,ready_for_office:false,install_client:!!row.install_client,install_runtime:!!row.install_runtime,
      created:row.created,updated:row.updated,goal:row.goal||'',error:row.error?safeText(row.error):null,runtime:json(row.runtime_result,null),
      local_verified:false,can_wake:false,protocol_verified:false,model_reply_verified:false,runner_ready:false,native_conversation_loaded:false,automatic_reply_verified:false,error_stage:null,readiness:'unverified',connection_evidence:null,response_mode:BRIDGE.has(row.provider)?'manual_bridge':DESKTOP.has(row.provider)?'manual_mailbox':'managed_native',native_group_status:'not_prepared',grok_verified:false,next_actions:[],policy:this.service.launch.policy(),
      ...BRIDGE.has(row.provider)?{native_direct_available:this.service.desktop?.nativeCapability(row.provider).available===true,connection_method:'grok_command_bridge'}:{}};
    if(row.target_member_id&&!row.launch_session_id){
      const member=this.service.chat.store.member(row.target_member_id),fixed=require('./connection-target.cjs').fixedProxy(this.service,member.id);
      Object.assign(base,{member_id:member.id,name:member.name,reused_connection:!!row.connection_reused,verification_scope:row.connection_reused?'existing_connection':'current_attempt',selection_reason:row.selection_reason||'explicit',fixed_proxy:fixed});
      if(fixed&&fixed.room_id!==row.room_id)return {...base,status:'needs_action',stage:'fixed_proxy_scope',detail:'此连接是固定群桥接，原后端路由保留，不能作为独立跨房人物复用。没有创建替代人物。',next_actions:[]};
      const target=resolveConnectionTarget(this.service,{provider:row.provider,room_id:row.room_id,target_member_id:member.id});
      if(target.blocked&&!row.reauthorize)return {...base,status:'needs_action',stage:'awaiting_credential',error:'此人物的原连接已撤销，需要明确重新授权。',next_actions:[action('verify','重新授权这位同事',{operation:'reauthorize',target_member_id:member.id})]};
      if(row.connection_reused&&target.joined&&target.reused_connection){const state=existingConnectionState(this.service,row.provider,row.room_id,target);if(state.stage==='awaiting_native_desktop'&&row.stage==='restoring_native')Object.assign(state,{status:'running',stage:'restoring_native'});return {...base,...state};}
      if(row.connection_reused&&!target.joined&&row.status==='running')return base;
    }
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
        if(!['active','pending'].includes(credentialStatus)){base.status='needs_action';base.stage='awaiting_credential';base.detail='既有 Grok 成员的长期入口不可用，需你明确重新授权接入。';base.next_actions=[action('verify','重新授权接入',{operation:'reauthorize',target_member_id:member.id})];return base;}
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
      base.next_actions=[action('verify','重新授权接入',{operation:'reauthorize',target_member_id:member.id})];return base;
    }
    if(row.stage==='awaiting_native_desktop'&&member){base.detail='本人对话未接通；检查客户端是否开启本机连接，再点击连接本人对话。';base.next_actions=[action('verify','连接本人对话',{operation:'native_desktop_connect'})];return base;}
    if(row.stage==='awaiting_auth'||member?.error&&AUTH.test(member.error)){
      base.status='needs_action';base.stage='awaiting_auth';base.error=row.error||member?.error?safeText(row.error||member?.error):null;
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
