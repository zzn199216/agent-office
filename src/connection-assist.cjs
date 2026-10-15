'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,id,now,atomicWrite,redact}=require('./util.cjs');

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
    const managed=new Set(['codex','claude-code','qwen-code','gemini-cli']);
    const matches=member=>member.config?.launch_provider===provider||managed.has(provider)&&member.adapter===provider||provider==='grok-bot'&&member.adapter==='grok-bridge';
    const seated=this.service.chat.store.participants(roomId).filter(matches);
    const candidates=seated.length?seated:provider==='grok-bot'?[]:this.service.chat.store.members().filter(member=>matches(member)&&member.verified_at&&!member.error&&member.status!=='connection_failed');
    return candidates.some(member=>{const credentials=this.service.resume.credentials(member.id);return credentials.length>0&&credentials.every(credential=>credential.status==='revoked');});
  }
  begin(input){
    if(this.closing||this.service.closing)throw new RoomError('办公室正在停止，尚未开始新的接入。',503,'service_stopping');
    const message=this.source(input.id);
    if(input.room_id!==message.room_id||input.to_member_id!==message.to_member_id)throw new RoomError('消息与接入帮助范围不一致。',403,'connection_assist_scope_mismatch');
    const providers=parseConnectionProviders(message.text);
    for(const provider of providers){
      if(this.db.prepare('SELECT id FROM connection_assists WHERE message_id=? AND provider=?').get(message.id,provider))continue;
      if(noNewSource.has(message.status))continue;
      const row={id:id(),room_id:message.room_id,message_id:message.id,member_id:message.to_member_id,provider,run_id:null,status:'starting',error:null,document_path:null,created:now(),updated:now()};
      this.db.prepare('INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,run_id,status,error,document_path,created,updated) VALUES(:id,:room_id,:message_id,:member_id,:provider,:run_id,:status,:error,:document_path,:created,:updated)').run(row);
      try{if(this.revokedIdentity(provider,row.room_id))this.update(row.id,{status:'needs_reauthorization',error:'这位同事原有入口已撤销。请在 AO 接入成员页面明确重新授权；此次聊天没有重新签发凭据。'});
        else{const state=this.service.onboarding.start({room_id:row.room_id,provider,install_client:false,install_runtime:false});this.update(row.id,{run_id:state.id||state.run_id,status:'prepared'});}}
      catch(error){this.update(row.id,{status:'error',error:safe(error.message)});}
      const job=Promise.resolve().then(()=>this.finish(row.id)).catch(error=>{try{this.update(row.id,{status:'error',error:safe(error.message)});}catch{}}).finally(()=>this.jobs.delete(row.id));
      this.jobs.set(row.id,job);
    }
    return this.snapshotForMessage(message.id);
  }
  state(row){
    if(!row.run_id)return null;
    const state=this.service.onboarding.state({run_id:row.run_id,room_id:row.room_id});
    if(row.provider!=='grok-bot'||!state.member_id||state.can_wake===true||row.status==='needs_reauthorization'||state.stage==='awaiting_credential')return state;
    const member=this.service.chat.store.member(state.member_id),freshContact=!!member.verified_at&&this.service.resume.credentials(member.id).some(credential=>credential.status==='active'&&credential.last_seen&&Date.parse(credential.last_seen)>Date.parse(row.created)&&this.service.chat.store.joined(credential.room_id,member.id));
    // Historical registration is not proof that this request reached Grok.
    // Only a real subsequent entry/tool contact can complete the manual path;
    // reads never update last_seen, and stale native failures do not block it.
    if(freshContact)return {...state,status:'ready',stage:'ready_mailbox',local_verified:true,can_wake:false,error:null};
    return {...state,status:'needs_action',stage:'awaiting_bridge_handshake',local_verified:false,can_wake:false,error:null};
  }
  snapshot(row){
    this.source(row.message_id);let state=null,error=row.error;
    try{state=this.state(row);}catch(caught){error=safe(caught.message);}
    const status=state?.status||(['prepared','document_ready','needs_reauthorization'].includes(row.status)?'needs_action':row.status),stage=state?.stage||(row.status==='needs_reauthorization'?'awaiting_credential':row.status);
    const ready=status==='ready',automatic=ready&&state?.can_wake===true;
    const documentPath=row.document_path||null;
    const summary=ready?(automatic?'已接通，可由 AO 自动派发；实际回复证据以连接状态为准。':'本人入口已实际接通；消息由本人窗口处理，AO 自动唤醒尚未验证。'):
      ['interrupted','error','cancelled','failed'].includes(status)?(documentPath?'接入未完成；请查看接入说明和原有进度，没有自动重试。':'接入已中断或失败；请查看原有进度，没有自动重试。'):
      status==='running'?'正在接入选定成员。':documentPath?'需要在对应 AI 窗口完成一步连接，请复制接入句并交给它。':this.jobs.has(row.id)?'正在准备接入帮助；未宣称成员已连接。':'接入需要处理；请查看原有进度，没有自动重试。';
    const guidedGrok=row.provider==='grok-bot'&&!!state?.member_id&&!automatic,targetWindow=guidedGrok?'已有 Grok Bot 对话':`${names.get(row.provider)||row.provider} 的本人对话`;
    const nextStep=automatic?'已连接，可以直接在 AO 给这位同事发消息。':ready?'已接通本机入口，可以在 AO 留消息；当前需由本人窗口处理，自动接手尚未验证。':row.status==='needs_reauthorization'||stage==='awaiting_credential'?'请打开原接入步骤，明确重新授权这位同事；原消息和人物保留。':
      guidedGrok?'点击这条消息下方「查看连接步骤」，复制连接说明并发到已有 Grok Bot 对话。AO 会继续检查真实连接，不需要创建群聊。':
      documentPath?`将下方接入句发到${targetWindow}，让它按文档完成连接；AO 会继续显示实际进度。`:
      status==='running'?'AO 正在接入选定成员，保留当前进度等待结果，不重复发起。':'请打开这条消息的原有接入进度，处理提示的下一步；原人物和连接保留。';
    return {id:row.id,room_id:row.room_id,message_id:row.message_id,member_id:row.member_id,provider:row.provider,name:names.get(row.provider)||row.provider,
      provider_name:names.get(row.provider)||row.provider,run_id:row.run_id,status,stage,summary,local_verified:state?.local_verified===true,can_wake:state?.can_wake===true,
      handoff_kind:guidedGrok?'grok_guided':documentPath?'connection_document':null,connection_method:guidedGrok?'grok_command_bridge':state?.response_mode||null,target_window:targetWindow,next_step:nextStep,
      protocol_verified:state?.protocol_verified===true,automatic_reply_verified:state?.automatic_reply_verified===true,
      target_member_id:state?.member_id||null,document_path:documentPath,document_url:documentPath?`/api/connection-assists/${row.id}/document?room_id=${encodeURIComponent(row.room_id)}`:null,
      copy_sentence:documentPath?`请读取这台电脑上的接入文档「${documentPath}」，按文档接入 Agent Office；保留已有配置，完成后实际验证连接。`:'',
      error:error?safe(error):state?.error?safe(state.error):null,created:row.created,updated:row.updated};
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
    const snapshots=this.snapshotForMessage(messageId).map(item=>({name:item.name,provider:item.provider,can_wake:item.can_wake,progress:item.summary,connection_ready:item.status==='ready'&&item.local_verified,automatic_ready:item.status==='ready'&&item.can_wake===true,
      target_window:item.target_window,next_step:item.next_step,copy_sentence:item.copy_sentence,document_path:item.document_path,document_url:item.document_url}));
    return '\n以下接入步骤由 AO 控制器处理，你不需要管理工具。请帮助用户继续完成接入，不能只回答“工具不支持”“权限不足”或“接入失败”就结束。只根据真实进度回答：\n'+
      '1. connection_ready 为 true 时，简短确认已经接通；can_wake 为 false 时补充消息需要由本人窗口处理，不声称自动接手，也不继续输出安装步骤。\n'+
      '2. 需要本人窗口连接时，先用一句话说明还差哪一步，再告诉用户 next_step 和准确的 target_window；存在 copy_sentence 时逐字给用户这句可复制的内容及接入文档。引导按钮会提供这位同事的专属说明，不要求用户提供房间 ID、路径或新配置。\n'+
      '3. 原入口已撤销、服务中断或仍等待时，说明原进度保留，并给出已有接入步骤中的下一步；不自行重复扫描、重试、重建人物或重签凭据。\n'+
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
