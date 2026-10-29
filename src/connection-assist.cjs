'use strict';
const {present}=require('./member-connection.cjs');
const fs=require('node:fs'),path=require('node:path');
const {RoomError,id,now,atomicWrite,redact}=require('./util.cjs');
const {MANAGED,resolveConnectionTarget,existingConnectionState}=require('./connection-target.cjs');

const PROVIDERS=[
  ['qwen-code',/\bqwen[\s_-]*code\b/ig,'Qwen Code'],['gemini-cli',/\bgemini(?:[\s_-]*cli)?\b/ig,'Gemini CLI'],
  ['claude-code',/\bclaude[\s_-]*code\b/ig,'Claude Code'],['claude-desktop',/\bclaude(?![a-z0-9_])(?:[\s_-]*(?:desktop|桌面(?:版|客户端)?))?/ig,'Claude 桌面客户端'],
  ['qwen-desktop',/\bqwen(?![a-z0-9_])(?:[\s_-]*(?:desktop|studio|桌面(?:版|客户端)?))?|通义千问|千问/ig,'Qwen 桌面客户端'],
  ['grok-bot',/\bgrok(?:\s*bot)?\b/ig,'Grok Bot'],['doubao',/\bdoubao\b|豆包/ig,'豆包'],
  ['codex',/\bcodex\b/ig,'Codex'],['opencode',/\bopencode\b/ig,'OpenCode'],
  ['cherry-studio',/\bcherry[\s_-]*studio\b/ig,'Cherry Studio'],['cline',/\bcline\b/ig,'Cline'],['roo-code',/\broo[\s_-]*code\b/ig,'Roo Code']
];
const names=new Map(PROVIDERS.map(([provider,,name])=>[provider,name]));
const safe=value=>redact(value).replace(/https?:\/\/[^\s<>"']+/gi,'[地址已隐藏]').replace(/(?:secret|token|key|凭据)\s*[:=]\s*[^\s,;]+/gi,'凭据=[已隐藏]').slice(0,1000);
const terminalSource=new Set(['cancelled','uncertain']);
const noNewSource=new Set([...terminalSource,'failed','answered','completed','consumed']);

// This conservative recognizer is a controller convenience, never a model
// assertion of authority. Ambiguous questions and quoted instructions do not
// trigger setup. Explicit CLI names win over the corresponding desktop alias.
function parseConnectionProviders(input){
  if(typeof input!=='string'||input.length>20000)return [];
  if(/(?:^|[，,；;。！？!?\r\n])\s*(?:[他她它]说|(?:同事|模型|AI|agent)\s*(?:说|建议)|工具(?:返回|输出|结果)(?:内容)?|(?:以下|下面|上面)(?:是|为)?\s*(?:聊天记录|对话记录|历史记录|工具输出|引用))\s*[:：]/i.test(input))return [];
  const text=input.replace(/```[\s\S]*?```/g,' ').replace(/`[^`]*`/g,' ').replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'/g,' ').replace(/^\s*>.*$/gm,' ');
  // A qualification in another clause still governs the whole request. Never
  // connect first and discover "wait for my confirmation" after the fact.
  if(/(?:先|暂时|现在|还)?\s*(?:不要|别|勿|不必|不)\s*(?:执行|操作|开始|动手|动)|(?:等|等待|待)(?:我|用户|本人)(?:确认|同意|授权|批准|说)|(?:确认|同意|批准|授权)(?:之后|以后|后|才)|暂缓|\b(?:wait\s+for\s+(?:my\s+)?(?:confirmation|approval)|after\s+(?:my\s+)?(?:confirmation|approval)|hold\s+off|do\s+not\s+(?:execute|start))\b/i.test(text))return [];
  if(/(?:先|暂时|现在|还)\s*(?:不要|别|勿|不必|不)\s*(?:接入|连接|连上|添加|加入|邀请|接|拉)|先\s*(?:让)?(?:我|用户|本人)\s*(?:先)?(?:确认|决定|同意|授权)|(?:等|等待|待)(?:我|用户|本人)(?:再说|再决定|再通知)/i.test(text))return [];
  const selected=[];
  for(const clause of text.split(/[，,；;。！？!?\r\n]+/)){
    if(/为什么|为何|怎么|如何|能否|能不能|是不是|是否|失败|连不上|不能|不支持|找原因|分析|排查|诊断|解释|介绍|举例|写.*(?:说明|文档)|\b(?:why|how|cannot|can't|failed|failure|debug|diagnos\w*)\b/i.test(clause))continue;
    if(/(?:不要|不想|不用|无需|不必|别|禁止|暂不|勿)|\b(?:don't|do\s+not|never|without)\b/i.test(clause))continue;
    let remaining=clause.trim().replace(/\.$/,'');const matched=[];
    for(const [provider,expression]of PROVIDERS){
      if(provider==='grok-bot'&&/\bgrok[\s_-]*(?:build|cli)\b/i.test(clause))continue;
      expression.lastIndex=0;remaining=remaining.replace(expression,()=>{const token=`AO_TARGET_${matched.length}_`;matched.push({token,provider});return token;});
    }
    if(!matched.length)continue;
    remaining=remaining.replace(/^(?:(?:请你|请|麻烦|帮我|替我|给我|我想要|我想|我需要|然后|那|再|也|继续|直接|现在|先|只|一下|就)\s*)+/,'');
    const person=String.raw`AO_TARGET_\d+_`,people=String.raw`${person}(?:\s*(?:、|和|与|及|以及|and|&|\+)\s*${person})*`;
    const place=String.raw`(?:(?:到|进入|加入|进|入)?\s*(?:这个|当前|本|我的|该)?\s*(?:办公室|聊天室|房间|群聊|群|AO|Agent\s*Office))?`;
    const destination=String.raw`\s*(?:进来|进群|入群|进办公室|加入)?\s*${place}\s*(?:里|中|来)?\s*(?:吧|一下)?`;
    const actualPersonAction=new RegExp(String.raw`^(?:(?:把|将)\s*${people}\s*(?:也)?\s*(?:接入|连接|连上|添加|加入|邀请|接上|拉|加|接)${destination}|(?:接入|连接|连上|添加|加入|邀请|接上|拉|加|接)\s*(?:一下|下)?\s*(?:个|一个|一位)?\s*${people}\s*(?:也)?${destination}|(?:please\s+)?(?:connect|add|invite|bring|join)\s+(?:the\s+)?${people}(?:\s+(?:to|into)\s+(?:the\s+)?(?:office|room|AO|Agent\s*Office))?)$`,'i');
    // The entire clause must describe people being connected. This rejects a
    // provider's logs/docs as objects and another named agent as a destination.
    if(!actualPersonAction.test(remaining))continue;
    for(const {provider}of matched)if(!selected.includes(provider))selected.push(provider);
  }
  return selected;
}

class ConnectionAssist{
  constructor(service,options={}){
    this.service=service;this.db=service.store.db;this.options=options;this.jobs=new Map();this.closing=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS connection_assists(
      id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES chat_rooms(id),message_id TEXT NOT NULL REFERENCES chat_messages(id),
      member_id TEXT NOT NULL REFERENCES chat_members(id),provider TEXT NOT NULL,run_id TEXT,
      status TEXT NOT NULL,error TEXT,document_path TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,
      UNIQUE(message_id,provider));
      CREATE INDEX IF NOT EXISTS connection_assists_room ON connection_assists(room_id,created);`);
    for(const [name,type]of [['target_member_id','TEXT'],['connection_reused','INTEGER NOT NULL DEFAULT 0']])if(!this.db.prepare('PRAGMA table_info(connection_assists)').all().some(column=>column.name===name))this.db.exec(`ALTER TABLE connection_assists ADD COLUMN ${name} ${type}`);
    // A restart never retries setup or creates a replacement person/document.
    this.db.prepare("UPDATE connection_assists SET status='interrupted',error='接入帮助准备期间服务结束；原接入进度保留，没有自动重试。',updated=? WHERE status IN ('starting','preparing_document')").run(now());
  }
  source(messageId){
    const message=this.service.chat.store.message(messageId);
    if(message.sender_id!=='user'||message.kind!=='message'||!message.to_member_id||message.coordination)throw new RoomError('接入帮助只处理用户直接发给这位同事的消息。',403,'connection_assist_source_forbidden');
    this.service.chat.store.requireParticipant(message.room_id,message.to_member_id);return message;
  }
  row(assistId,roomId){
    const row=this.db.prepare('SELECT * FROM connection_assists WHERE id=?').get(assistId);
    if(!row)throw new RoomError('接入帮助不存在。',404,'connection_assist_not_found');
    if(roomId!==undefined&&row.room_id!==roomId)throw new RoomError('接入帮助不属于当前会话。',403,'connection_assist_scope_mismatch');
    this.source(row.message_id);return row;
  }
  update(assistId,fields){
    const keys=Object.keys(fields).filter(key=>['run_id','status','error','document_path'].includes(key));if(!keys.length)return;
    this.db.prepare(`UPDATE connection_assists SET ${keys.map(key=>key+'=?').join(',')},updated=? WHERE id=?`).run(...keys.map(key=>fields[key]),now(),assistId);this.service.changed();
  }
  revokedIdentity(provider,roomId){
    return resolveConnectionTarget(this.service,{provider,room_id:roomId}).blocked;
  }
  begin(input){
    if(this.closing||this.service.closing)throw new RoomError('办公室正在停止，尚未开始新的接入。',503,'service_stopping');
    const message=this.source(input.id);
    if(input.room_id!==message.room_id||input.to_member_id!==message.to_member_id)throw new RoomError('消息与接入帮助范围不一致。',403,'connection_assist_scope_mismatch');
    const providers=parseConnectionProviders(message.text);
    for(const provider of providers){
      if(this.db.prepare('SELECT id FROM connection_assists WHERE message_id=? AND provider=?').get(message.id,provider))continue;
      if(noNewSource.has(message.status))continue;
      const target=resolveConnectionTarget(this.service,{provider,room_id:message.room_id});
      const row={id:id(),room_id:message.room_id,message_id:message.id,member_id:message.to_member_id,provider,run_id:null,status:'starting',error:null,document_path:null,created:now(),updated:now(),target_member_id:target.member_id,connection_reused:target.reused_connection?1:0};
      this.db.prepare('INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,run_id,status,error,document_path,created,updated,target_member_id,connection_reused) VALUES(:id,:room_id,:message_id,:member_id,:provider,:run_id,:status,:error,:document_path,:created,:updated,:target_member_id,:connection_reused)').run(row);
      try{if(target.blocked)this.update(row.id,{status:'needs_reauthorization',error:'这位同事原有入口已撤销。请在 AO 接入成员页面明确重新授权；此次聊天没有重新签发凭据。'});
        else{const state=this.service.onboarding.start({room_id:row.room_id,provider,install_client:false,install_runtime:false,...target.member_id&&(!target.fixed_proxy||target.fixed_proxy.room_id===row.room_id)?{target_member_id:target.member_id}:{}});this.update(row.id,{run_id:state.id||state.run_id,status:'prepared'});}}
      catch(error){this.update(row.id,{status:'error',error:safe(error.message)});}
      const job=Promise.resolve().then(()=>this.finish(row.id)).catch(error=>{try{this.update(row.id,{status:'error',error:safe(error.message)});}catch{}}).finally(()=>this.jobs.delete(row.id));
      this.jobs.set(row.id,job);
    }
    return this.snapshotForMessage(message.id);
  }
  state(row){
    let original;
    if(!row.run_id){
      if(!['needs_reauthorization','document_ready'].includes(row.status))return null;
      const target=resolveConnectionTarget(this.service,{provider:row.provider,room_id:row.room_id,...row.target_member_id?{target_member_id:row.target_member_id}:{}});
      if(!target.member)return null;
      original=existingConnectionState(this.service,row.provider,row.room_id,target);
    }else original=this.service.onboarding.state({run_id:row.run_id,room_id:row.room_id,provider:row.provider});
    // The controller owns current-attempt evidence for every provider. A second
    // readiness rule here previously promoted historical handshakes to success.
    // A retry may have a new durable run. Follow only an already-created attempt
    // for this exact person in this room; reading a card never starts setup.
    const memberId=row.target_member_id||original?.member_id;
    if(row.target_member_id&&original?.member_id&&row.target_member_id!==original.member_id)throw new RoomError('接入记录与原人物不一致，未沿用其他成员的进度。',403,'connection_assist_scope_mismatch');
    if(!memberId)return original;
    const anchor=row.run_id?this.db.prepare('SELECT created FROM onboarding_runs WHERE id=? AND room_id=? AND provider=?').get(row.run_id,row.room_id,row.provider)?.created:row.created;
    if(!Number.isFinite(Date.parse(anchor)))return original;
    const candidates=this.db.prepare('SELECT * FROM onboarding_runs WHERE room_id=? AND provider=? AND created>=? ORDER BY created DESC,rowid DESC').all(row.room_id,row.provider,anchor);
    for(const candidate of candidates){
      if(!Number.isFinite(Date.parse(candidate.created))||Date.parse(candidate.created)<Date.parse(anchor))continue;
      if(candidate.id===row.run_id||!row.run_id&&candidate.reauthorize!==1)continue;
      if(candidate.target_member_id&&candidate.target_member_id!==memberId||candidate.direct_member_id&&candidate.direct_member_id!==memberId)continue;
      let state;try{state=this.service.onboarding.state({run_id:candidate.id,room_id:row.room_id,provider:row.provider});}catch{continue;}
      if(state.id===candidate.id&&state.room_id===row.room_id&&state.provider===row.provider&&state.member_id===memberId)return state;
    }
    return original;
  }
  actionKind(row,state){
    if(state?.stage==='connection_repair_required'||['codex_auth_ownership_required','codex_personal_auth_owner_conflict'].includes(state?.error_code))return 'connection_repair';
    if(state?.stage==='connection_recheck_available')return 'connection_recheck';
    if(state?.stage==='awaiting_credential'||!state&&row.status==='needs_reauthorization')return 'reauthorize';
    if(state?.status==='ready'&&state.ready_for_office===true&&state.local_verified)return 'ready';
    if(state?.status==='running'||row.status==='starting'||row.status==='preparing_document')return 'wait';
    if(['unsupported','fixed_proxy_scope'].includes(state?.stage))return 'unsupported';
    if(MANAGED.has(row.provider))return 'managed';
    if(state?.next_actions?.some(action=>action.operation==='native_desktop_connect'))return 'native_connect';
    if(state?.member_id)return 'manual_handoff';
    return 'unsupported';
  }
  snapshot(row){
    this.source(row.message_id);let state=null,error=row.error;
    try{state=this.state(row);}catch(caught){error=safe(caught.message);}
    const protectedConnection=state?.stage==='connection_repair_required'||['codex_auth_ownership_required','codex_personal_auth_owner_conflict'].includes(state?.error_code),recheck=state?.stage==='connection_recheck_available';
    const runId=state?.run_id||state?.id||row.run_id,accepted=!protectedConnection&&!recheck&&!!runId&&state?.status==='ready'&&state.ready_for_office===true&&state.local_verified===true;
    const status=state?.status==='ready'&&!accepted?'needs_action':state?.status||(['prepared','document_ready','needs_reauthorization'].includes(row.status)?'needs_action':row.status),stage=state?.stage||(row.status==='needs_reauthorization'?'awaiting_credential':row.status);
    const ready=accepted,automatic=ready&&state?.can_wake===true,notifiable=ready&&state?.can_notify===true,actionKind=this.actionKind(row,state),reused=state?.reused_connection===true||!!row.connection_reused;
    const fixed=state?.fixed_proxy||(state?.member_id?require('./connection-target.cjs').fixedProxy(this.service,state.member_id):null);
    const documentPath=actionKind==='manual_handoff'?row.document_path||null:null;
    const summary=protectedConnection?'为保护已登录的 Codex，AO 已暂停这条后台连接。原聊天和成员已保留。':recheck?'已支持沿用原 Codex 登录；请重新验证原人物连接，无需另外登录或重配 MCP。':fixed?'此连接是固定群桥接，原后端路由保留，不能当成独立跨房人物复用。':ready?(automatic?'已接通并验证本次回复，可以直接在 AO 协作。':notifiable?'已连接，有消息会自动通知它；实际回复会回到对应消息。':'本人入口已实际接通；消息由本人窗口处理，AO 自动唤醒尚未验证。'):
      ['interrupted','error','cancelled','failed'].includes(status)?'接入已中断或失败，请查看原有进度继续处理。':
      actionKind==='reauthorize'?'这位同事的原连接已撤销，请在 AO 明确重新授权原人物。':actionKind==='managed'?'这位同事使用 AO 后台接入，请在原接入进度继续处理，无需向外部窗口粘贴配置。':actionKind==='unsupported'?'当前尚无可用的接入入口，请查看这位同事的支持情况。':
      ['interrupted','error','cancelled','failed'].includes(status)?(documentPath?'接入未完成；请查看接入说明和原有进度，没有自动重试。':'接入已中断或失败；请查看原有进度，没有自动重试。'):
      status==='running'?'正在接入选定成员。':documentPath?'需要在对应 AI 窗口完成一步连接，请复制接入句并交给它。':this.jobs.has(row.id)?'正在准备接入帮助；未宣称成员已连接。':'接入需要处理；请查看原有进度，没有自动重试。';
    const guidedGrok=row.provider==='grok-bot'&&actionKind==='manual_handoff'&&!!documentPath,targetWindow=guidedGrok?'已有 Grok Bot 对话':`${names.get(row.provider)||row.provider} 的本人对话`;
    let nextStep=protectedConnection?'无需重复登录或重新配置 MCP。请查看连接保护说明，或使用其他已接通的成员。':recheck?'点击「沿用已有登录，重新验证」。AO 会检查原人物的真实通信，成功后进入办公室。':automatic?'已连接，可以直接在 AO 给这位同事发消息。':notifiable?'直接在 AO 发消息，会自动通知这位成员处理。':ready?'已接通本机入口，可以在 AO 留消息；当前需由本人窗口处理，自动接手尚未验证。':row.status==='needs_reauthorization'||stage==='awaiting_credential'?'请打开原接入步骤，明确重新授权这位同事；原消息和人物保留。':
      actionKind==='unsupported'?'尚未找到这个客户端当前可用的接入入口。请查看支持情况，或选择已适配的成员；原人物和配置保留。':
      actionKind==='native_connect'?'点击「查看连接步骤」，继续连接这位成员的本人对话；原有配置保留。':
      guidedGrok?'点击下方「复制给 Grok Bot」，把说明发到已有 Grok Bot 对话。AO 会继续检查真实连接，不需要创建群聊。':
      documentPath?`将下方接入句发到${targetWindow}，让它按文档完成连接；AO 会继续显示实际进度。`:
      status==='running'?'AO 正在接入选定成员，保留当前进度等待结果，不重复发起。':'请打开这条消息的原有接入进度，处理提示的下一步；原人物和连接保留。';
    const presentation=present({...state,provider:row.provider,status:protectedConnection?'needs_action':status,stage,error_code:state?.error_code||null,ready_for_office:ready,local_verified:ready,can_wake:ready&&state?.can_wake===true,error:ready?null:error||state?.error||null},{action_kind:actionKind});
    return {presentation,id:row.id,room_id:row.room_id,message_id:row.message_id,member_id:row.member_id,provider:row.provider,name:names.get(row.provider)||row.provider,
      provider_name:names.get(row.provider)||row.provider,run_id:runId,status,stage,summary,error_code:state?.error_code||null,ready_for_office:ready,local_verified:ready,can_wake:ready&&state?.can_wake===true,
      auth_mode:state?.auth_mode||null,auth_revision:state?.auth_revision||null,recheck_auth_revision:state?.recheck_auth_revision||null,
      handoff_kind:guidedGrok?'grok_guided':documentPath?'connection_document':null,connection_method:guidedGrok?'grok_command_bridge':state?.response_mode||null,target_window:targetWindow,next_step:nextStep,
      action_kind:actionKind,reused_connection:reused,verification_scope:'current_attempt',can_notify:state?.can_notify===true,
      selection_reason:state?.selection_reason||null,fixed_proxy:fixed,
      recovery_action:actionKind==='reauthorize'&&state?.member_id?{operation:'reauthorize',room_id:row.room_id,provider:row.provider,target_member_id:state.member_id}:['managed','connection_recheck'].includes(actionKind)&&runId?{operation:'retry',run_id:runId,room_id:row.room_id,provider:row.provider,target_member_id:state?.member_id||row.target_member_id||null}:null,
      protocol_verified:state?.protocol_verified===true,automatic_reply_verified:state?.automatic_reply_verified===true,
      target_member_id:state?.member_id||null,document_path:documentPath,document_url:documentPath?`/api/connection-assists/${row.id}/document?room_id=${encodeURIComponent(row.room_id)}`:null,
      copy_sentence:documentPath?`请读取这台电脑上的接入文档「${documentPath}」，按文档接入 Agent Office；保留已有配置，完成后实际验证连接。`:'',
      error:ready?null:error?safe(error):state?.error?safe(state.error):null,created:row.created,updated:row.updated};
  }
  snapshotForMessage(messageId){
    const rows=this.db.prepare('SELECT * FROM connection_assists WHERE message_id=? ORDER BY created,rowid').all(messageId);
    if(!rows.length)return [];return rows.map(row=>this.snapshot(row));
  }
  listRoom(roomId){this.service.chat.store.room(roomId);return this.db.prepare('SELECT * FROM connection_assists WHERE room_id=? ORDER BY created,rowid').all(roomId).filter(row=>this.service.chat.store.joined(roomId,row.member_id)).map(row=>this.snapshot(row));}
  directory(create=false){
    const root=fs.realpathSync.native(this.service.store.dir),directory=path.join(root,'connection-assists');
    let stat;try{stat=fs.lstatSync(directory);}catch(error){if(error.code!=='ENOENT'||!create)throw error;fs.mkdirSync(directory);stat=fs.lstatSync(directory);}
    if(stat.isSymbolicLink()||!stat.isDirectory()||path.relative(root,fs.realpathSync.native(directory))!=='connection-assists')throw new RoomError('接入文档目录不属于 AO。',403,'connection_assist_document_scope');
    return directory;
  }
  async finish(assistId){
    let row=this.row(assistId);const work=row.run_id&&this.service.onboarding.jobs.get(row.run_id);if(work)await work;
    if(this.closing||this.service.closing)return;
    row=this.row(assistId);if(terminalSource.has(this.source(row.message_id).status))return;
    const state=this.state(row);if(state?.status==='ready'||state?.status==='running'||row.document_path)return;
    const kind=this.actionKind(row,state);
    if(kind==='native_connect')return;
    if(kind!=='manual_handoff')return;
    this.update(row.id,{status:'preparing_document'});
    const reauthorizationRequired=row.status==='needs_reauthorization';
    let instruction='',credentialUnavailable=reauthorizationRequired;
    if(state?.member_id){
      this.service.chat.store.requireParticipant(row.room_id,state.member_id);
      const entry=this.service.entry.describePrimary(state.member_id,row.room_id);
      credentialUnavailable=!['active','pending'].includes(entry.status);
      if(!credentialUnavailable){const member=this.service.chat.store.member(state.member_id),guide=this.service.chat.clientGuide(member,row.room_id,{native:false});
        // Templates hold the target's credentials locally. The shared helper
        // document contains only their paths, never another person's URL/token.
        instruction=[guide.installation_prompt,guide.bootstrap,guide.kind==='command'?guide.copy:null,
          Array.isArray(guide.steps)?(row.provider==='doubao'?'仅在工具未加载时，由用户手动完成以下步骤；连接地址在 AO 接入卡片的手动配置中复制。\n':'')+guide.steps.join('\n'):null,guide.note].filter(Boolean).join('\n\n');}
    }
    const title=names.get(row.provider)||row.provider;
    const intro=row.provider==='doubao'?'这份文档只用于连接已有 AO 服务。先使用已加载的 AO 工具；没有工具时请用户回到 AO 接入卡片展开手动配置，不要查找配置文件或操作桌面。':`这份文档交给 ${title} 自己的窗口，使用其已有且获准的本机工具完成；保留已有配置。文档存在不表示连接成功。`;
    const text=`# 连接 ${title} 与 Agent Office\n\n${intro}\n\n`+
      (credentialUnavailable?'原有入口不可用或已撤销。请回 AO 的接入成员页面明确重新授权，不能复用文档自动重发凭据。\n\n':instruction?instruction+'\n\n':
        `当前阶段：${safe(state?.stage||row.status)}。${safe(state?.error||row.error||'尚未发现可用的自动接入入口。')}\n请在该客户端完成自己的安装、登录或本机工具授权，再从 AO 接入成员页面检查进度；此步骤不会自动安装软件、代输账号或新建其他身份。\n\n`)+
      '仅处理这次连接。不要操作用户桌面，不改用云端代码解释器访问本机 localhost，不删除或覆盖已有连接，不自动创建群聊或设置定期任务。找不到 AO 工具时说明当前对话尚未加载连接器，不能把电子邮箱工具当作 AO 信箱。只有实际工具返回或原生对话验证才报告成功；配置存在、接口自测和应用打开均不能代替验证。\n';
    const directory=this.directory(true),file=path.join(directory,row.id+'.md');
    let existing;try{existing=fs.lstatSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing?.isSymbolicLink()||existing&&!existing.isFile())throw new RoomError('接入文档不能指向其他位置。',403,'connection_assist_document_scope');
    atomicWrite(file,text);try{fs.chmodSync(file,0o600);}catch{}
    this.update(row.id,{status:reauthorizationRequired?'needs_reauthorization':'document_ready',document_path:file});
  }
  async prepareContext(messageId){
    const rows=this.db.prepare('SELECT id FROM connection_assists WHERE message_id=?').all(messageId);if(!rows.length)return '';
    const work=Promise.allSettled(rows.map(row=>this.jobs.get(row.id)).filter(Boolean)),timeout=Math.max(0,Math.min(10000,this.options.contextWaitMs??10000));
    let timer;try{await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);}finally{clearTimeout(timer);}
    // The live card moves into the reply bubble when the reply arrives.
    // Avoid freezing a connection state into historical assistant prose.
    const snapshots=this.snapshotForMessage(messageId).map(item=>({name:item.name,provider:item.provider,state:item.presentation?.state||null,headline:item.presentation?.headline||null,connection_ready:item.ready_for_office===true,automatic_ready:item.ready_for_office===true&&item.can_wake===true,can_wake:item.can_wake===true,action_kind:item.action_kind}));
    return '\n用户请求接入成员。Agent Office 会在你的回复气泡内显示接入卡片，卡片实时更新当前状态和操作按钮。'+
      '你只需用一句话回应，例如「请在这条回复里的接入卡片继续操作，连接状态会实时更新。」不要在正文复述待连接或已连接等瞬时状态，以免稍后与卡片矛盾；connection_ready 为 false 时不能说已接通，can_wake 为 false 时不能说会自动处理。不要列步骤、配置、路径、诊断或状态码，也不要重试、扫描、重建人物或索取凭据。其他请求（例如创建镜像群）的完成情况应按实际结果另行说明，接入卡片不代表群已创建。\n'+
      `当前状态（只读）：${JSON.stringify(snapshots)}\n`;
  }
  document(assistId,roomId){
    const row=this.row(assistId,roomId);if(!row.document_path)throw new RoomError('接入文档尚未准备好。',409,'connection_assist_document_pending');
    const file=path.join(this.directory(),row.id+'.md');if(row.document_path!==file)throw new RoomError('接入文档路径不匹配。',403,'connection_assist_document_scope');
    const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>128000||fs.realpathSync.native(file)!==file)throw new RoomError('接入文档超出本次范围。',403,'connection_assist_document_scope');
    return {filename:`AgentOffice-${row.provider}-connect.md`,text:fs.readFileSync(file,'utf8')};
  }
  stop(){this.closing=true;}
  async close(){this.stop();await Promise.allSettled([...this.jobs.values()]);}
}
module.exports={ConnectionAssist,parseConnectionProviders};
