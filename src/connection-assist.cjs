'use strict';
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
  if(/(?:先|暂时|现在|还)\s*(?:不要|别|勿|不必|不)\s*(?:接入|连接|添加|加入|邀请|接|拉)|先\s*(?:让)?(?:我|用户|本人)\s*(?:先)?(?:确认|决定|同意|授权)|(?:等|等待|待)(?:我|用户|本人)(?:再说|再决定|再通知)/i.test(text))return [];
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
    const actualPersonAction=new RegExp(String.raw`^(?:(?:把|将)\s*${people}\s*(?:也)?\s*(?:接入|连接|添加|加入|邀请|接上|拉|加|接)${destination}|(?:接入|连接|添加|加入|邀请|接上|拉|加|接)\s*(?:一下|下)?\s*(?:个|一个|一位)?\s*${people}\s*(?:也)?${destination}|(?:please\s+)?(?:connect|add|invite|bring|join)\s+(?:the\s+)?${people}(?:\s+(?:to|into)\s+(?:the\s+)?(?:office|room|AO|Agent\s*Office))?)$`,'i');
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
  handshakePrompt(member){
    return `请在当前这个 AI 助手对话中连接 Agent Office 的同事「${member.name}」。沿用此人物已有的 AO / agentroom MCP 配置，不新建身份、不索取房间 ID。先检查当前对话是否实际加载 AO 工具：调用 agentroom_chat_rooms，再调用 agentroom_chat_inbox（参数 {}，不传 room_id）。这是 AO 协作消息，不是电子邮箱。只根据实际工具返回报告自己的身份和收件结果；工具不存在时，明确说明当前对话尚未加载 MCP，并告诉用户在此客户端哪里启用已有 AO 连接器、重新加载后再回到这个对话握手。不要改用云端代码解释器访问用户电脑，不把旧聊天、接口自测或配置存在当成连接成功。`;
  }
  nativePending(state){
    const memberId=state?.member_id;if(!memberId)return false;
    return state?.error_code==='desktop_request_uncertain'||/desktop_request_uncertain|创建结果待核对|原生请求.*待核对/.test(state?.error||'')||this.service.chat.nativeDeliveryPending(memberId)||this.service.desktop?.row(memberId)?.state==='creation_uncertain'||this.service.chat.active?.get(memberId)?.desktop||this.service.desktop?.jobs.has(memberId)||this.service.desktop?.connecting.has(memberId);
  }
  installationGuidance(row,state){
    const memberId=state?.member_id;if(!memberId||this.nativePending(state))return null;
    this.service.chat.store.requireParticipant(row.room_id,memberId);
    const entry=this.service.entry.describePrimary(memberId,row.room_id);if(!entry.available)return null;
    // Only use artifacts prepared by the explicit setup action. Merely reading
    // a progress card must never issue an entry or regenerate MCP templates.
    const templateFiles={},directory=path.join(this.service.store.dir,'client-config','templates');
    for(const [kind,suffix]of [['stdio','stdio'],['streamable_http','http']]){
      const file=path.join(directory,`${memberId}-${suffix}.json`);
      try{const stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=128000&&fs.realpathSync.native(file)===file)templateFiles[kind]=file;}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if(!templateFiles.stdio)return null;
    const member=this.service.chat.store.member(memberId),name=names.get(row.provider)||row.provider;
    return {kind:'install_mcp',target_window:'可读取这台电脑文件并修改客户端配置的安装助手',copy_label:'复制 MCP 安装/更新说明',
      prompt:`请安装或更新 ${name} 原有的 Agent Office MCP 连接，沿用同事「${member.name}」的身份和现有连接，不重复添加 AO 服务，不覆盖其他 MCP。下列文件仅供已经获准访问这台电脑的安装助手读取；如果当前助手只有云端工具，请明确说明不能读取，并引导用户在 ${name} 的 MCP 设置导入 AO 提供的配置。不要要求用户把私密配置、入口卡或认证内容发到聊天。\n\n${require('./agent-install.cjs').agentInstallPrompt({member,provider:row.provider,templateFiles})}\n\n配置完成后，请用户回到 ${name} 的本人对话，启用 AO 连接器并发送以下握手提示词：\n${this.handshakePrompt(member)}`,
      steps:[`把安装/更新说明交给有本机配置权限的安装助手；也可在 ${name} 的 MCP 设置中手动导入 AO 的现有配置。`,`保存并启用后，回到 ${name} 的本人对话发送握手提示词。`],
      note:'安装配置与本人对话握手分别验证；手动 MCP 不代表 AO 已能自动唤醒客户端。',scope:{room_id:row.room_id,target_member_id:memberId}};
  }
  guidance(row,state,kind){
    if(!['manual_handoff','native_connect','unsupported'].includes(kind)||row.status==='needs_reauthorization'||state?.stage==='awaiting_credential')return null;
    const name=names.get(row.provider)||row.provider,memberId=state?.member_id||null,scope={room_id:row.room_id,target_member_id:memberId};
    if(memberId){const credentials=this.service.resume.credentials(memberId);if(credentials.length&&credentials.every(card=>card.status==='revoked'))return null;}
    if(kind==='unsupported'){
      const fixed=state?.stage==='fixed_proxy_scope';
      return {kind:'check_capability',target_window:row.provider==='grok-bot'?'已有 Grok Bot 对话':`${name} 的本人对话`,copy_label:`复制给 ${name} 检查`,scope,
        prompt:`请帮我核对当前这个 ${name} 对话如何接入我电脑上的 Agent Office。${fixed?'AO 发现的是另一房间的固定群桥接，不能把它静默改绑为当前房间的独立成员。请保留原 Bot、原群路由和其他连接。':'AO 尚未发现当前可用的本人接入入口，不能据此断定你不支持 MCP 或本机工具。'}先报告当前对话实际可用的本机命令工具、MCP / 连接器及其启用状态。${row.provider==='grok-bot'?'如果已有获准的 Windows 本机命令工具，请说明可以复用当前 Bot 的本机入口；不自动创建新 Bot、群聊或定时任务。':''}如果支持 MCP，请告诉我此版本在哪里添加或更新 Agent Office 连接器、采用哪种传输，以及是否需要在当前对话启用或重新加载；已有 AO 工具时实际调用 agentroom_chat_rooms 和 agentroom_chat_inbox（参数 {}）核对。没有本机权限或不支持 MCP 时，明确指出缺少的能力和界面里的具体操作步骤。尚未拿到 AO 为所选人物生成的配置时，请让我回 AO 准备该人物的连接说明；不要猜测本机地址、端口、令牌、成员或房间 ID，不读取其他人物配置，不用云端代码解释器访问本机，不声称已经接通。`,
        steps:[`把下方检查提示词复制到${row.provider==='grok-bot'?'已有 Grok Bot 对话':`${name} 的本人对话`}并发送。`,fixed?'保留原房间的固定群路由；按检查结果准备独立成员入口，原连接不会自动改绑。':'按助手指出的实际入口启用本机工具或 MCP，再回 AO 继续连接。'],note:'这一步核对客户端能力，不代表已安装 MCP 或接通办公室。'};
    }
    if(!memberId||this.nativePending(state))return null;
    this.service.chat.store.requireParticipant(row.room_id,memberId);
    const entry=this.service.entry.describePrimary(memberId,row.room_id);if(!entry.available)return null;
    const member=this.service.chat.store.member(memberId);
    if(row.provider==='grok-bot'){
      const guide=this.service.chat.grokGuide(member,row.room_id,{native:false});if(!guide.copy||guide.needs_reauthorization)return null;
      return {kind:'handshake',target_window:'已有 Grok Bot 对话',copy_label:'复制给 Grok Bot',prompt:guide.copy,steps:guide.steps,note:guide.note,scope};
    }
    if(kind==='manual_handoff'&&!row.document_path)return null;
    if(kind==='manual_handoff'&&entry.status!=='active')return this.installationGuidance(row,state);
    const native=kind==='native_connect',incompatible=/UNSUPPORTED_SOURCE|不兼容|尚未通过核对/i.test(state?.error||'');
    return {kind:native?'native_connect':'handshake',target_window:`${name} 的本人对话`,copy_label:`复制给 ${name} 握手`,prompt:this.handshakePrompt(member),scope,
      steps:native?[incompatible?`${name} 的本机对话接口与当前版本不兼容。可更新到支持的客户端版本，或在连接步骤明确选择「改用手动 MCP」。`:`先在 AO 点击「开启客户端连接」，按提示开启 ${name} 的本机连接，再点击「连接本人对话」。`,'如果准备使用 MCP，在当前本人对话启用已有 AO 连接器，复制下方握手提示词；缺少配置时使用安装/更新说明。']:[`回到 ${name} 的本人对话，启用已有 AO 连接器并发送下方握手提示词。`],
      note:native?'本人窗口的 MCP 握手与 AO 原生自动连接分别核对；发送提示词不会自动切换连接方式。':'已有 MCP 无需反复安装；找不到 AO 工具时才检查启用、重新加载或更新配置。'};
  }
  snapshot(row){
    this.source(row.message_id);let state=null,error=row.error;
    try{state=this.state(row);}catch(caught){error=safe(caught.message);}
    const protectedConnection=state?.stage==='connection_repair_required'||['codex_auth_ownership_required','codex_personal_auth_owner_conflict'].includes(state?.error_code),recheck=state?.stage==='connection_recheck_available';
    const runId=state?.run_id||state?.id||row.run_id,accepted=!protectedConnection&&!recheck&&!!runId&&state?.status==='ready'&&state.ready_for_office===true&&state.local_verified===true;
    const status=state?.status==='ready'&&!accepted?'needs_action':state?.status||(['prepared','document_ready','needs_reauthorization'].includes(row.status)?'needs_action':row.status),stage=state?.stage||(row.status==='needs_reauthorization'?'awaiting_credential':row.status);
    const ready=accepted,automatic=ready&&state?.can_wake===true,actionKind=this.actionKind(row,state),reused=state?.reused_connection===true||!!row.connection_reused;
    const fixed=state?.fixed_proxy||(state?.member_id?require('./connection-target.cjs').fixedProxy(this.service,state.member_id):null);
    const documentPath=actionKind==='manual_handoff'?row.document_path||null:null;
    const summary=protectedConnection?'为保护已登录的 Codex，AO 已暂停这条后台连接。原聊天和成员已保留。':recheck?'已支持沿用原 Codex 登录；请重新验证原人物连接，无需另外登录或重配 MCP。':fixed?'此连接是固定群桥接，原后端路由保留，不能当成独立跨房人物复用。':ready?(automatic?'已接通并验证本次回复，可以直接在 AO 协作。':'本人入口已实际接通；消息由本人窗口处理，AO 自动唤醒尚未验证。'):
      ['interrupted','error','cancelled','failed'].includes(status)?'接入已中断或失败，请查看原有进度继续处理。':
      actionKind==='reauthorize'?'这位同事的原连接已撤销，请在 AO 明确重新授权原人物。':actionKind==='managed'?'这位同事使用 AO 后台接入，请在原接入进度继续处理，无需向外部窗口粘贴配置。':actionKind==='unsupported'?'当前尚无可用的接入入口，请查看这位同事的支持情况。':
      ['interrupted','error','cancelled','failed'].includes(status)?(documentPath?'接入未完成；请查看接入说明和原有进度，没有自动重试。':'接入已中断或失败；请查看原有进度，没有自动重试。'):
      status==='running'?'正在接入选定成员。':documentPath?'需要在对应 AI 窗口完成一步连接，请复制接入句并交给它。':this.jobs.has(row.id)?'正在准备接入帮助；未宣称成员已连接。':'接入需要处理；请查看原有进度，没有自动重试。';
    const guidedGrok=row.provider==='grok-bot'&&actionKind==='manual_handoff'&&!!documentPath,targetWindow=guidedGrok?'已有 Grok Bot 对话':`${names.get(row.provider)||row.provider} 的本人对话`;
    let nextStep=protectedConnection?'无需重复登录或重新配置 MCP。请查看连接保护说明，或使用其他已接通的成员。':recheck?'点击「沿用已有登录，重新验证」。AO 会检查原人物的真实通信，成功后进入办公室。':automatic?'已连接，可以直接在 AO 给这位同事发消息。':ready?'已接通本机入口，可以在 AO 留消息；当前需由本人窗口处理，自动接手尚未验证。':row.status==='needs_reauthorization'||stage==='awaiting_credential'?'请打开原接入步骤，明确重新授权这位同事；原消息和人物保留。':
      actionKind==='unsupported'?'尚未找到这个客户端当前可用的接入入口。请查看支持情况，或选择已适配的成员；原人物和配置保留。':
      actionKind==='native_connect'?'点击「查看连接步骤」，继续连接这位成员的本人对话；原有配置保留。':
      guidedGrok?'点击下方「复制给 Grok Bot」，把说明发到已有 Grok Bot 对话。AO 会继续检查真实连接，不需要创建群聊。':
      documentPath?`将下方接入句发到${targetWindow}，让它按文档完成连接；AO 会继续显示实际进度。`:
      status==='running'?'AO 正在接入选定成员，保留当前进度等待结果，不重复发起。':'请打开这条消息的原有接入进度，处理提示的下一步；原人物和连接保留。';
    let guidance=null,installationGuidance=null;
    try{guidance=this.guidance(row,state,actionKind);if(actionKind==='native_connect'&&guidance)installationGuidance=this.installationGuidance(row,state);}catch(caught){error=error||safe(caught.message);}
    if(guidance&&actionKind==='unsupported')nextStep=`点击「${guidance.copy_label}」，把提示词发到${guidance.target_window}，让它核对 MCP 或本机工具并给出具体操作步骤。`;
    else if(guidance&&actionKind==='native_connect')nextStep=guidance.steps[0];
    else if(guidance?.kind==='install_mcp')nextStep=`点击「${guidance.copy_label}」，交给${guidance.target_window}；然后回到 ${names.get(row.provider)||row.provider} 的本人对话握手。`;
    else if(actionKind==='native_connect'&&this.nativePending(state))nextStep='这位同事有正在执行或结果待核对的原生请求。请先查看原消息与本人对话核对结果，不能通过更新 MCP 或重复握手改走其他通路。';
    return {id:row.id,room_id:row.room_id,message_id:row.message_id,member_id:row.member_id,provider:row.provider,name:names.get(row.provider)||row.provider,
      provider_name:names.get(row.provider)||row.provider,run_id:runId,status,stage,summary,error_code:state?.error_code||null,ready_for_office:ready,local_verified:ready,can_wake:ready&&state?.can_wake===true,
      auth_mode:state?.auth_mode||null,auth_revision:state?.auth_revision||null,recheck_auth_revision:state?.recheck_auth_revision||null,
      handoff_kind:guidedGrok?'grok_guided':documentPath?'connection_document':null,connection_method:guidedGrok?'grok_command_bridge':state?.response_mode||null,target_window:targetWindow,next_step:nextStep,
      action_kind:actionKind,reused_connection:reused,verification_scope:'current_attempt',can_notify:state?.can_notify===true,
      selection_reason:state?.selection_reason||null,fixed_proxy:fixed,
      guidance,installation_guidance:installationGuidance,
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
    if(kind==='native_connect'){
      // Preparing optional MCP help is part of this explicit user request; it
      // does not change the saved native delivery mode or issue revoked cards.
      if(state?.member_id&&!this.nativePending(state)){this.service.chat.store.requireParticipant(row.room_id,state.member_id);const entry=this.service.entry.describePrimary(state.member_id,row.room_id);if(entry.available)this.service.chat.clientGuide(this.service.chat.store.member(state.member_id),row.room_id,{native:false});}
      return;
    }
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
          Array.isArray(guide.steps)?guide.steps.join('\n'):null,guide.note].filter(Boolean).join('\n\n');}
    }
    const title=names.get(row.provider)||row.provider;
    const text=`# 连接 ${title} 与 Agent Office\n\n这份文档交给 ${title} 自己的窗口，使用其已有且获准的本机工具完成；保留已有配置。文档存在不表示连接成功。\n\n`+
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
    const snapshots=this.snapshotForMessage(messageId).map(item=>({name:item.name,provider:item.provider,can_wake:item.can_wake,progress:item.summary,connection_ready:item.ready_for_office===true,automatic_ready:item.ready_for_office===true&&item.can_wake===true,
      reused_connection:item.reused_connection,verification_scope:item.verification_scope,action_kind:item.action_kind,target_window:item.guidance?.target_window||item.target_window,next_step:item.next_step,copy_sentence:item.copy_sentence,document_path:item.document_path,document_url:item.document_url,
      guidance:item.guidance?{kind:item.guidance.kind,target_window:item.guidance.target_window,copy_label:item.guidance.copy_label,steps:item.guidance.steps,note:item.guidance.note}:null,installation_guidance_available:!!item.installation_guidance}));
    return '\n以下接入步骤由 AO 控制器处理，你不需要管理工具。请在一条回复内按成员分成简短段落，每位只说明当前结果和用户需要做的下一步；AO 会把对应操作嵌在这条回复里，不要另发多条进度或重复长配置。请帮助用户继续完成接入，不能只回答“工具不支持”“权限不足”或“接入失败”就结束。只根据真实进度回答：\n'+
      '1. connection_ready 为 true 时，简短确认已经接通；can_wake 为 false 时补充消息需要由本人窗口处理，不声称自动接手，也不继续输出安装步骤。\n'+
      '2. 需要本人窗口连接时，用一句话说明还差哪一步和准确的 target_window。AO 会在同一条回复里提供复制说明与查看步骤按钮，不重复输出长安装说明、本地文档路径或配置。不要求用户提供房间 ID、路径或新配置。有 guidance 时按其中的 kind 和 copy_label 说明复制给哪个窗口：install_mcp 交给有本机配置能力的安装助手安装或更新原 MCP，再回本人对话握手；handshake 沿用已有连接在本人窗口实际调用工具；native_connect 先按步骤恢复本机连接，MCP 是需明确选择的兼容方式；check_capability 让对应助手核对实际支持并给出具体步骤，不声称已有可执行连接。没有 guidance 的 unsupported 才引导查看支持情况。\n'+
      '3. 原入口已撤销、服务中断或仍等待时，说明原进度保留，并给出已有接入步骤中的下一步；不自行重复扫描、重试、重建人物或重签凭据。\n'+
      '4. action_kind 为 connection_repair 时，说明 AO 为保护现有桌面登录已暂停后台连接，原人物和聊天保留；不要让用户再次登录、重新配置 MCP、复制认证或重试，可查看保护说明或选择其他已接通成员。\n'+
      '5. action_kind 为 connection_recheck 时，说明新版可以沿用原 Codex 登录，让用户点击「沿用已有登录，重新验证」，原人物和聊天继续使用；还未验证成功，不要求额外登录或复制配置。\n'+
      '不要把内部状态码、成员 ID、端口、堆栈或原始错误当作给普通用户的答案；用户主动询问诊断时再解释。文档生成、应用打开和历史握手不代表当前自动连接成功；仅按真实证据确认，不读取其他成员凭据，不扩大用户授权。\n'+JSON.stringify(snapshots);
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
