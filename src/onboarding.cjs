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
    this.db.prepare("UPDATE onboarding_runs SET status='interrupted',stage='interrupted',error='接入期间本机处理程序结束。请点击重试；不会重放业务问题。',updated=? WHERE status='running'").run(now());
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
      if(snapshot.status==='running'||snapshot.status==='ready'||input.retry!==true&&!['error','interrupted'].includes(snapshot.status))return {...snapshot,reused:true};
    }
    const row={id:id(),room_id:room.id,...selection,status:'running',stage:'preparing',launch_session_id:null,install_client:input.install_client===true?1:0,install_runtime:input.install_runtime===true?1:0,runtime_result:null,error:null,created:now(),updated:now(),goal};
    this.db.prepare('INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,launch_session_id,install_client,install_runtime,runtime_result,error,created,updated,goal) VALUES(:id,:room_id,:requested_provider,:provider,:mode,:status,:stage,:launch_session_id,:install_client,:install_runtime,:runtime_result,:error,:created,:updated,:goal)').run(row);
    const existing=this.snapshot(row);
    // A working member from an older version has no onboarding history. Keep
    // that real connection rather than reporting ready and then quietly starting
    // another model handshake or modifying its profile behind the same button.
    if(existing.status==='ready'&&existing.native_group_status==='host_reported'){
      const sessions=this.db.prepare('SELECT id,selected_providers FROM launch_sessions WHERE room_id=? ORDER BY rowid DESC').all(room.id);
      const matching=sessions.find(session=>{const providers=json(session.selected_providers,[]);return Array.isArray(providers)&&providers.length===1&&providers[0]===row.provider;});
      this.set(row.id,{status:'ready',stage:existing.stage,launch_session_id:matching?.id||null});
      return {...this.snapshot(this.row(row.id)),reused:true};
    }
    // Defer work until the job map and durable run exist. A rapid second click
    // therefore always finds and reuses this attempt.
    const work=Promise.resolve().then(()=>this.run(row)).catch(error=>{
      const login=AUTH.test(error?.message||'')||/login|auth/.test(error?.code||'');
      const block=providerBlock(row.provider,error);
      this.set(row.id,{status:login||block?'needs_action':'error',stage:login?'awaiting_auth':block||'error',error:safeText(error?.message||'接入失败，请重试。')});
    }).finally(()=>this.jobs.delete(row.id));
    this.jobs.set(row.id,work);this.service.changed();return this.snapshot(row);
  }
  retry(input={}){
    const row=this.row(input.run_id);
    if(input.provider&&input.provider!==row.provider&&input.provider!==row.requested_provider||input.room_id&&input.room_id!==row.room_id)throw new RoomError('重试不能切换到另一个成员或房间。',403,'onboarding_scope_mismatch');
    return this.start({provider:row.requested_provider,mode:row.mode,room_id:row.room_id,goal:row.goal||'',retry:true,
      install_client:input.install_client===undefined?!!row.install_client:input.install_client===true,
      install_runtime:input.install_runtime===undefined?!!row.install_runtime:input.install_runtime===true});
  }
  async run(row){
    if(this.closing)return;
    if(row.mode==='managed'&&DESKTOP.has(row.provider)){
      this.set(row.id,{status:'needs_action',stage:'requires_explicit_backend_selection'});return;
    }
    if(row.install_runtime&&MANAGED.has(row.provider)&&this.options.runtimeInstaller){
      this.set(row.id,{stage:'installing_runtime'});
      // This hook is a trusted provider installer. No command, URL, package or
      // account supplied by a chat participant can become executable input.
      const raw=await this.options.runtimeInstaller({provider:row.provider,requested_provider:row.requested_provider,mode:row.mode,room_id:row.room_id,run_id:row.id});
      const result={status:typeof raw?.status==='string'?raw.status:'needs_setup',installed:raw?.installed===true,
        ...(typeof raw?.signed_in==='boolean'?{signed_in:raw.signed_in}:{}),
        ...(raw?.reason?{reason:safeText(raw.reason)}:{}),...(raw?.detail?{detail:safeText(raw.detail)}:{})};
      this.set(row.id,{runtime_result:JSON.stringify(result)});
      if(['needs_login','awaiting_auth','login_required'].includes(result.status)||result.signed_in===false){this.set(row.id,{status:'needs_action',stage:'awaiting_auth'});return;}
      if(!result.installed||['needs_setup','failed','error','needs_manual_install'].includes(result.status)){this.set(row.id,{status:'needs_action',stage:'awaiting_runtime_install'});return;}
    }
    if(this.closing)return;
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
    this.set(row.id,{status:'needs_action',stage:'awaiting_connection'});
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
  snapshot(row){
    const base={id:row.id,run_id:row.id,room_id:row.room_id,requested_provider:row.requested_provider,provider:row.provider,name:NAMES[row.provider]||row.provider,mode:row.mode,
      status:row.status,stage:row.stage,launch_session_id:row.launch_session_id,install_client:!!row.install_client,install_runtime:!!row.install_runtime,
      created:row.created,updated:row.updated,goal:row.goal||'',error:row.error?safeText(row.error):null,runtime:json(row.runtime_result,null),
      local_verified:false,can_wake:false,response_mode:BRIDGE.has(row.provider)?'manual_bridge':DESKTOP.has(row.provider)?'manual_mailbox':'managed_native',native_group_status:'not_prepared',grok_verified:false,next_actions:[],policy:this.service.launch.policy()};
    // A pure SQLite read deliberately bypasses launch.state(), which historically
    // renews or issues entry cards for unfinished desktop handshakes.
    const session=row.launch_session_id?this.db.prepare('SELECT * FROM launch_sessions WHERE id=? AND room_id=?').get(row.launch_session_id,row.room_id):null;
    const candidate=json(session?.candidates,[]);
    const selected=Array.isArray(candidate)?candidate.find(item=>item.provider===row.provider):null;
    if(BRIDGE.has(row.provider)){
      let member=null;try{if(selected?.prepared_member_id){this.service.chat.store.requireParticipant(row.room_id,selected.prepared_member_id);member=this.service.chat.store.member(selected.prepared_member_id);if(member.adapter!=='grok-bridge')member=null;}}catch{}
      if(member){
        const credentialStatus=this.credentialState(row.room_id,member),verified=!!member.verified_at&&credentialStatus==='active'&&!member.error&&!['connecting','connection_failed','awaiting_handshake'].includes(member.status);
        Object.assign(base,{name:member.name,member_id:member.id,credential_status:credentialStatus,local_verified:verified,native_group_status:'not_requested'});
        if(['interrupted','error'].includes(row.status)||session?.error){base.status='error';base.stage='error';base.error=safeText(session?.error||row.error||'本机桥接入口准备失败。');base.next_actions=[action('verify','重试准备入口',{operation:'retry'})];return base;}
        if(!['active','pending'].includes(credentialStatus)){base.status='needs_action';base.stage='awaiting_credential';base.detail='既有 Grok 成员的长期入口不可用，需你明确重新授权接入。';base.next_actions=[action('verify','重新授权接入',{operation:'retry'})];return base;}
        if(verified){base.status='ready';base.stage='ready_mailbox';base.error=null;base.detail='已验证 Grok 本人窗口的本机入口；已有的 Webhook 和固定路由设置保持原样。应用进程不证明执行宿主在线，原生群状态另行核对。';return base;}
        base.status='needs_action';base.stage='awaiting_bridge_handshake';base.detail='入口已准备；在选定的已有 Grok Bot 窗口执行一次长期本机命令。应用开着不代表执行宿主连通，不能以说明或配置代替实际握手。';base.next_actions=[action('self_handshake','在已有 Grok Bot 窗口启用',{operation:'copy_handshake_prompt'})];return base;
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
      Object.assign(base,{name:proxy.name,proxy_id:proxy.id,member_id:member.id,local_verified:verified,can_wake:runtime.can_wake===true,
        native_group_status:proxy.native_group_status||'pending',response_mode:member.adapter==='mailbox'?'manual_mailbox':'managed_native',
        credential_status:credentialStatus,
        installation:installation?{status:installation.status||'needs_setup',installed:installation.installed===true,needs_reload:installation.needs_reload===true,needs_import:installation.needs_import===true,...['form','json'].includes(installation.import_kind)?{import_kind:installation.import_kind}:{},detail:installation.detail?safeText(installation.detail):null}:null});
    }
    if(['interrupted','error'].includes(row.status)){
      base.next_actions=[action('verify','重试接入',{operation:'retry'})];return base;
    }
    if(row.stage==='requires_explicit_backend_selection'||row.mode==='managed'&&DESKTOP.has(row.provider)){
      const alternative=MANAGED_ALTERNATIVE[row.provider];base.status='needs_action';base.stage=row.stage;
      base.next_actions=alternative?[action('verify',`如需后台回答，请明确选择 ${NAMES[alternative]}`,{operation:'select_provider',provider:alternative})]:[action('verify','使用所选客户端的本人窗口协作入口',{operation:'select_provider',provider:row.provider,mode:'desktop'})];return base;
    }
    if(base.local_verified){
      if(base.can_wake||base.response_mode==='manual_mailbox'){
        base.status='ready';base.stage=base.can_wake?'ready_automatic':'ready_mailbox';base.error=null;
        base.detail=base.can_wake?'已验证，可在后台处理群里的委托。':'已接入消息信箱；需在本人窗口领取和回复，不能后台唤醒。';
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
  async close(){this.closing=true;await Promise.allSettled([...this.jobs.values()]);}
}
module.exports={OnboardingManager};
