'use strict';
const {createHash}=require('node:crypto');
const {discoverDesktop,DesktopTransport,localEndpoint}=require('./desktop-transport.cjs');
const {RoomError,now,sleep,readableError}=require('./util.cjs');
const {COMMON_OPERATION_INSTRUCTIONS}=require('./operation-policy.cjs');
const PORTS={'qwen-desktop':19245,doubao:19246,'grok-bot':19247};
const TERMINAL=new Set(['completed','failed','cancelled','uncertain']);
const RECONNECT_TRANSIENT=new Set(['desktop_bridge_unavailable','desktop_connection_lost','desktop_request_uncertain','desktop_service_not_ready','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ETIMEDOUT','ENETUNREACH','EPIPE','UND_ERR_CONNECT_TIMEOUT']);
function reconnectErrorCode(error){return error?.code||error?.cause?.code||error?.name||'desktop_connect_failed';}
function reconnectRetryable(error){return RECONNECT_TRANSIENT.has(reconnectErrorCode(error))||['AbortError','TimeoutError'].includes(error?.name)||error?.code==='desktop_target_ambiguous'&&error.retryable===true;}
class DesktopSessions{
  constructor(service,options={}){
    this.service=service;this.chat=service.chat;this.db=service.store.db;this.options=options;this.clients=new Map();this.connecting=new Map();this.jobs=new Map();this.closing=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS desktop_person_sessions(member_id TEXT PRIMARY KEY REFERENCES chat_members(id) ON DELETE CASCADE,provider TEXT NOT NULL,endpoint TEXT NOT NULL,runtime_key TEXT NOT NULL,native_session_id TEXT,state TEXT NOT NULL,error TEXT,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_message_runs(message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES chat_members(id) ON DELETE CASCADE,native_session_id TEXT,native_request_id TEXT NOT NULL,status TEXT NOT NULL,user_message_id TEXT,response_message_ids TEXT,answer TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS desktop_message_stops(message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,created TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS desktop_reconnect_state(member_id TEXT PRIMARY KEY REFERENCES chat_members(id) ON DELETE CASCADE,attempt INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,error_code TEXT,blocked INTEGER NOT NULL DEFAULT 0)');
    this.db.prepare("UPDATE desktop_message_runs SET status='uncertain',error='处理程序重启，先核对原生原消息结果，没有重发。',updated=? WHERE status IN ('sending','running')").run(now());
    this.db.prepare("UPDATE desktop_person_sessions SET state='offline',updated=? WHERE state IN ('prepared','connected')").run(now());
    this.db.prepare("UPDATE desktop_person_sessions SET state='creation_uncertain',error='处理程序重启，对话创建结果待核对。',updated=? WHERE state='creating' AND native_session_id IS NULL").run(now());
    this.adapter={capabilities:['room-history','inbox','reply','native-desktop-session','automatic-wakeup'],connect:(member,room)=>this.connect({member_id:member.id,room_id:room.id}),message:message=>this.pump(message.to_member_id)};
  }
  row(memberId){return this.db.prepare('SELECT * FROM desktop_person_sessions WHERE member_id=?').get(memberId)||null;}
  configured(memberId){return !!this.row(memberId)?.native_session_id;}
  canWake(memberId){const driver=this.clients.get(memberId);return !!driver&&driver.closed!==true&&driver.transport?.closed!==true&&['prepared','connected'].includes(this.row(memberId)?.state)&&!this.reconnectEligibility(memberId);}
  reconnectEligibility(memberId){
    const row=this.row(memberId);if(!row?.native_session_id)return 'desktop_session_missing';
    const member=this.chat.store.member(memberId);
    if(!['mailbox','grok-bridge'].includes(member.adapter)||member.config.launch_provider&&member.config.launch_provider!==row.provider)return 'desktop_identity_mismatch';
    if(!this.chat.store.rooms().some(room=>this.chat.store.joined(room.id,memberId)))return 'desktop_membership_missing';
    const credentials=this.service.resume.credentials(memberId);if(credentials.length&&credentials.every(credential=>credential.status==='revoked'))return 'resume_revoked';
    return null;
  }
  reconnectState(memberId){
    const row=this.db.prepare('SELECT * FROM desktop_reconnect_state WHERE member_id=?').get(memberId),paused=this.reconnectEligibility(memberId);
    return {status:this.closing?'stopped':this.canWake(memberId)?'connected':this.connecting.has(memberId)?'connecting':paused?'paused':row?.blocked?'needs_action':row?.next_attempt_at?'waiting':'idle',attempt:row?.attempt||0,next_at:row?.next_attempt_at?new Date(row.next_attempt_at).toISOString():null,error_code:paused||row?.error_code||null};
  }
  scheduleReconnect(memberId,error){
    if(this.closing||!this.row(memberId)?.native_session_id)return;
    const previous=this.db.prepare('SELECT attempt FROM desktop_reconnect_state WHERE member_id=?').get(memberId),attempt=Math.min((previous?.attempt||0)+1,50),retryable=reconnectRetryable(error);
    const base=Math.max(1,this.options.reconnectBaseMs||5000),cap=Math.max(base,this.options.reconnectMaxMs||120000),random=this.options.random||Math.random;
    const delay=Math.min(cap,Math.max(1,Math.round(Math.min(cap,base*2**Math.min(attempt-1,20))*(0.8+Math.max(0,Math.min(1,random()))*0.4))));
    const next=retryable?(this.options.clock?.()??Date.now())+delay:null;
    this.db.prepare('INSERT INTO desktop_reconnect_state VALUES(?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET attempt=excluded.attempt,next_attempt_at=excluded.next_attempt_at,error_code=excluded.error_code,blocked=excluded.blocked').run(memberId,attempt,next,reconnectErrorCode(error),retryable?0:1);
  }
  maintainReconnect(){
    if(this.closing)return;
    const stamp=this.options.clock?.()??Date.now();
    for(const row of this.db.prepare('SELECT member_id FROM desktop_person_sessions WHERE native_session_id IS NOT NULL').all()){
      const memberId=row.member_id;if(this.canWake(memberId)||this.connecting.has(memberId)||this.reconnectEligibility(memberId))continue;
      const retry=this.db.prepare('SELECT * FROM desktop_reconnect_state WHERE member_id=?').get(memberId);
      if(retry?.blocked||retry?.next_attempt_at>stamp)continue;
      // Recovery may only reload the saved native conversation. It never
      // creates a replacement conversation or replays a submitted prompt.
      this.connect({member_id:memberId,recovery:true}).then(()=>this.pump(memberId)).catch(()=>{});
    }
  }
  state(memberId){
    const row=this.row(memberId);if(!row)return {configured:false,can_wake:false};
    return {configured:true,provider:row.provider,native_session_id:row.native_session_id,state:row.state,can_wake:this.canWake(memberId),error:row.error,updated:row.updated,reconnect:this.reconnectState(memberId)};
  }
  start(){this.maintainReconnect();}
  pulse(){if(this.closing)return;for(const [memberId,driver]of this.clients){if(driver.transport?.closed){this.transportDisconnected(memberId,driver.transport);continue;}if(this.reconnectEligibility(memberId)){this.clients.delete(memberId);driver.close?.();this.saveSession(memberId,{state:'offline'});this.service.runtime.releaseWorker(`desktop:${memberId}`);this.observe(memberId,'runner_stopped');this.service.changed();continue;}this.observe(memberId,'runner_started');this.service.runtime.workerHeartbeat(`desktop:${memberId}`,{member_id:memberId,pid:process.pid});this.pump(memberId).catch(()=>{});}this.maintainReconnect();}
  saveSession(memberId,fields){const row=this.row(memberId);if(!row)return;this.db.prepare('UPDATE desktop_person_sessions SET native_session_id=?,state=?,error=?,updated=? WHERE member_id=?').run(fields.native_session_id??row.native_session_id,fields.state||row.state,fields.error===undefined?row.error:fields.error,now(),memberId);}
  observe(memberId,event,fields={}){
    const row=this.row(memberId);if(!row)return;
    const input={event,session_ref:`desktop:${memberId}`,executor_kind:'desktop',provider:row.provider,...event==='runner_started'?{pid:process.pid}:{},...row.native_session_id?{native_session_id:row.native_session_id}:{},...fields};
    this.service.runtime.recordConnectionEvidence(memberId,input);
  }
  transportDisconnected(memberId,transport){
    if(this.closing||this.clients.get(memberId)?.transport!==transport)return;
    const row=this.row(memberId),uncertainCreation=row&&!row.native_session_id&&['creating','creation_uncertain'].includes(row.state);
    this.clients.delete(memberId);this.saveSession(memberId,{state:uncertainCreation?'creation_uncertain':'offline',error:'原生客户端连接结束；消息结果需按原引用核对。'});
    if(!this.connecting.has(memberId))this.scheduleReconnect(memberId,{code:'desktop_connection_lost'});
    this.service.runtime.releaseWorker(`desktop:${memberId}`);this.observe(memberId,'runner_stopped');this.service.changed();
  }
  async defaultDriver(row){
    const target=await discoverDesktop(row.endpoint,row.provider,{fetchImpl:this.options.fetchImpl||this.service.fetch});
    const transport=await new DesktopTransport(target).connect();
    transport.on('disconnected',()=>this.transportDisconnected(row.member_id,transport));
    try{
      if(row.provider==='doubao'){
        const {createBridge,prepareDoubaoNativeRuntime}=require('./desktop-doubao.cjs');
        const verified=await prepareDoubaoNativeRuntime(transport);
        const driver=createBridge(transport,{...verified,runtimeKey:row.runtime_key,nativeChatId:row.native_session_id});
        driver.transport=transport;driver.close=()=>transport.close();return driver;
      }
      if(row.provider!=='qwen-desktop')throw new RoomError('这个客户端的原生对话适配器尚未完成实测。',409,'desktop_adapter_unverified');
      const {createBridge,QWEN_NATIVE_CONTRACT}=require('./desktop-qwen.cjs');
      const hash=await transport.evaluate(`(async()=>{const u=${JSON.stringify(QWEN_NATIVE_CONTRACT.moduleUrl)};if(![...document.scripts].some(s=>s.src===u))return null;const b=await(await fetch(u,{cache:'force-cache'})).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');})()`);
      if(hash!==QWEN_NATIVE_CONTRACT.sourceSha256)throw new RoomError('Qwen 原生版本与已验证接口不一致，未修改客户端。',409,'desktop_version_unsupported');
      let mcpConnection=null;
      if(this.options.serverName!==null){
        if(!this.service._localUrl)throw new RoomError('本机服务地址尚未就绪。',503,'desktop_service_not_ready');
        const room=this.chat.store.rooms().find(room=>this.chat.store.joined(room.id,row.member_id));
        if(!room)throw new RoomError('这位成员尚未加入办公室。',409,'desktop_membership_missing');
        const entry=this.service.entry.primary(row.member_id,room.id),card=require('node:fs').readFileSync(entry.file,'utf8');
        const config=require('./mcp-http.cjs').createQwenMcpConfig(this.service._localUrl,JSON.parse(card)).mcpServers.agentroom;
        mcpConnection={serverName:this.options.serverName||`AgentOffice_${row.member_id.slice(0,8)}`,config};
      }
      const driver=createBridge(transport,{runtimeKey:row.runtime_key,moduleUrl:QWEN_NATIVE_CONTRACT.moduleUrl,sourceSha256:hash,nativeChatId:row.native_session_id,mcpConnection,serverName:null});
      driver.transport=transport;driver.close=()=>transport.close();return driver;
    }catch(error){transport.close();throw error;}
  }
  async connect(input={}){
    const {member_id:memberId,room_id:roomId}=input;
    const member=this.chat.store.member(memberId);if(roomId)this.chat.store.requireParticipant(roomId,memberId);
    if(!['mailbox','grok-bridge'].includes(member.adapter))throw new RoomError('请选择这位 AI 的本人桌面窗口。',400,'desktop_identity_mismatch');
    const old=this.row(memberId),provider=input.provider||old?.provider||member.config.launch_provider;
    if(member.config.launch_provider&&provider!==member.config.launch_provider)throw new RoomError('不能替换这位同事已经选定的客户端身份。',409,'desktop_identity_mismatch');
    if(!PORTS[provider]||old&&old.provider!==provider)throw new RoomError('不能用另一种客户端替换这位同事的原生身份。',409,'desktop_identity_mismatch');
    if(this.closing)throw new RoomError('办公室服务正在停止。',503);
    if(this.connecting.has(memberId))return this.connecting.get(memberId);
    const credentials=this.service.resume.credentials(memberId);if(credentials.length&&credentials.every(credential=>credential.status==='revoked'))throw new RoomError('此成员的连接已撤销，未恢复桌面连接。',410,'resume_revoked');
    if(input.recovery===true&&!old?.native_session_id)throw new RoomError('没有可恢复的原生对话，不会自动创建替代窗口。',409,'desktop_session_missing');
    if(old?.native_session_id){const reason=this.reconnectEligibility(memberId);if(reason)throw new RoomError(reason==='resume_revoked'?'此成员的连接已撤销，未自动恢复。':'此成员尚未加入可用的办公室，未恢复桌面连接。',409,reason);}
    const endpoint=localEndpoint(input.endpoint||old?.endpoint||`http://127.0.0.1:${PORTS[provider]}`).href;
    if(old?.state==='creation_uncertain'&&!old.native_session_id)throw new RoomError('本人对话创建结果待核对，不能重复创建。',409,'desktop_request_uncertain');
    if(old?.endpoint===endpoint&&this.canWake(memberId)){this.observe(memberId,'runner_started');return this.state(memberId);}
    if(old&&old.endpoint!==endpoint&&this.jobs.has(memberId))throw new RoomError('成员正在处理消息，无法更换桌面连接。',409,'desktop_busy');
    if(!old)this.db.prepare("INSERT INTO desktop_person_sessions VALUES(?,?,?,?,NULL,'offline',NULL,?)").run(memberId,provider,endpoint,'ao_'+createHash('sha256').update(this.service.runtime.instanceId+':'+memberId).digest('hex'),now());
    else if(old.endpoint!==endpoint){const prior=this.clients.get(memberId);this.clients.delete(memberId);prior?.close?.();this.db.prepare('UPDATE desktop_person_sessions SET endpoint=?,updated=? WHERE member_id=?').run(endpoint,now(),memberId);}
    // Defer the body until the ownership map has been populated, including
    // factories that throw synchronously before their first await.
    const work=Promise.resolve().then(async()=>{
      let creating=false;
      try{
        this.observe(memberId,'runner_started');
        let driver=this.clients.get(memberId);
        if(!driver){const row=this.row(memberId);driver=await (this.options.driverFactory?this.options.driverFactory(row):this.defaultDriver(row));this.clients.set(memberId,driver);}
        if(this.closing)throw new RoomError('办公室服务正在停止。',503,'cancelled');
        if(driver.closed===true||driver.transport?.closed)throw new RoomError('原生桌面连接在恢复期间断开。',503,'desktop_connection_lost');
        const savedId=this.row(memberId).native_session_id;
        if(savedId){const reason=this.reconnectEligibility(memberId);if(reason)throw new RoomError('此成员的授权或办公室席位已变更，未恢复桌面连接。',409,reason);}
        if(input.recovery===true&&!savedId)throw new RoomError('原生对话引用已不存在，未创建替代窗口。',409,'desktop_session_missing');
        if(!savedId){creating=true;this.saveSession(memberId,{state:'creating',error:null});}
        const info=await (typeof driver.createPersonConversation==='function'?driver.createPersonConversation(savedId):driver.initialize({nativeChatId:savedId}));
        if(info?.detached!==true)throw new RoomError('本人对话尚未隔离绑定，未开始后台派发。',409,'desktop_contract_mismatch');
        const nativeId=info.nativeChatId||info.nativeConversationId||null;
        if(savedId&&nativeId!==savedId)throw new RoomError('客户端未恢复这位同事原有的对话，未替换成新窗口。',409,'desktop_identity_mismatch');
        // A confirmed native ID survives later connector verification failure;
        // recovery must load this same person instead of creating another chat.
        if(nativeId)this.saveSession(memberId,{native_session_id:nativeId});
        if(typeof driver.verifyConnection==='function'&&this.options.serverName!==null){const proof=await driver.verifyConnection();if(proof?.member_id!==memberId||proof?.instance_id!==this.service.runtime.instanceId)throw new RoomError('客户端连接器不属于这位同事或当前办公室实例。',403,'desktop_identity_mismatch');}
        if(driver.closed===true||driver.transport?.closed)throw new RoomError('原生桌面连接在验证期间断开。',503,'desktop_connection_lost');
        this.saveSession(memberId,{native_session_id:nativeId,state:nativeId?'connected':'prepared',error:null});
        if(this.closing)throw new RoomError('办公室服务正在停止。',503,'cancelled');
        this.db.prepare('DELETE FROM desktop_reconnect_state WHERE member_id=?').run(memberId);
        this.observe(memberId,'protocol_verified',{source:'native_desktop_transport'});
        if(nativeId)this.observe(memberId,'dialogue_verified',{source:'native_person_session_loaded'});
        this.observe(memberId,'runner_started');this.service.runtime.workerHeartbeat(`desktop:${memberId}`,{member_id:memberId,pid:process.pid});this.service.runtime.heartbeat(memberId,{session_ref:`desktop:${memberId}`});
        this.chat.store.updateMember(memberId,{status:'ready',error:null,verified_at:member.verified_at||now(),config:{...member.config,connection_mode:'managed_desktop'}});
        this.service.changed();return this.state(memberId);
      }catch(error){const driver=this.clients.get(memberId);this.clients.delete(memberId);driver?.close?.();
        const saved=this.row(memberId)?.native_session_id,reported=error.nativeChatId;
        const confirmed=typeof reported==='string'&&reported.length>0&&reported.length<=160&&!reported.includes('\0')&&!reported.startsWith('local')&&(!saved||reported===saved)?reported:undefined;
        const uncertainCreation=creating&&(error.uncertain||/uncertain|connection_lost/.test(error.code||'')||!saved&&!confirmed&&error.creationNotDispatched!==true);
        this.saveSession(memberId,{native_session_id:confirmed,state:uncertainCreation?'creation_uncertain':'offline',error:readableError(error)});this.scheduleReconnect(memberId,error);this.service.runtime.releaseWorker(`desktop:${memberId}`);this.observe(memberId,'runner_stopped');this.observe(memberId,'failed',{error_stage:'dialogue',error_code:error.code||'desktop_connect_failed'});this.service.changed();throw error;}
      finally{this.connecting.delete(memberId);}
    });this.connecting.set(memberId,work);return work;
  }
  updateRun(messageId,fields){
    const allowed=['native_session_id','native_request_id','status','user_message_id','response_message_ids','answer','error'];const keys=Object.keys(fields).filter(key=>allowed.includes(key));
    if(keys.length)this.db.prepare(`UPDATE desktop_message_runs SET ${keys.map(key=>key+'=?').join(',')},updated=? WHERE message_id=?`).run(...keys.map(key=>fields[key]),now(),messageId);
  }
  async cancelOwned(driver,requestId){const result=await driver.cancel(requestId);if(result?.status!=='cancelled'||result.requestId&&result.requestId!==requestId)throw new RoomError('尚未收到这个原生轮次的停止确认，结果待核对。',409,'desktop_request_uncertain');}
  noteStop(messageId){this.db.prepare('INSERT OR IGNORE INTO desktop_message_stops VALUES(?,?)').run(messageId,now());}
  async pump(memberId){
    if(this.closing||this.jobs.has(memberId)||this.chat.active.has(memberId))return;
    if(this.row(memberId)?.native_session_id&&this.reconnectEligibility(memberId))return;
    const unresolved=this.db.prepare("SELECT * FROM desktop_message_runs WHERE member_id=? AND status IN ('sending','running','uncertain') ORDER BY created LIMIT 1").get(memberId);
    if(unresolved){await this.recover(unresolved);if(!['completed','failed','cancelled'].includes(this.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(unresolved.message_id)?.status))return;}
    const next=this.chat.store.inbox(memberId).find(message=>message.status==='queued');if(!next)return;
    const work=this.execute(next).finally(()=>{this.jobs.delete(memberId);if(!this.closing)this.pump(memberId).catch(()=>{});});this.jobs.set(memberId,work);await work;
  }
  async recover(run){
    if(this.closing||this.jobs.has(run.member_id)||!this.canWake(run.member_id))return;
    const driver=this.clients.get(run.member_id),work=(async()=>{
      try{
        const original=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(run.message_id);if(!original)return;
        let result=await driver.snapshot(run.message_id,{includeContent:true});
        if((['unknown_request','not_started'].includes(result?.status)||result?.restoredFromHistory&&result.status==='incomplete')&&run.user_message_id&&typeof driver.restore==='function')result=await driver.restore({requestId:run.message_id,nativeChatId:run.native_session_id,userMessageId:run.user_message_id,responseMessageIds:JSON.parse(run.response_message_ids||'[]'),includeContent:true});
        if(['error','cancelled'].includes(result?.status)&&result.requestId===run.message_id&&(result.nativeChatId||result.nativeConversationId)===run.native_session_id){const status=result.status==='cancelled'?'cancelled':'failed';this.updateRun(run.message_id,{status,error:'已核对原生轮次的结束结果。'});if(!this.chat.roomDeleted(original.room_id))this.chat.store.updateMessage(run.message_id,{status,error:'已核对原生轮次的结束结果。'});this.service.changed();return;}
        if(result?.status!=='completed')return;
        if(run.user_message_id&&result.userMessageId!==run.user_message_id)throw new RoomError('原生恢复结果不属于已保存的问题。',403,'desktop_identity_mismatch');
        this.complete(original,result,run.native_session_id);
      }catch(error){this.updateRun(run.message_id,{status:'uncertain',error:readableError(error)});}
    })();this.jobs.set(run.member_id,work);try{await work;}finally{this.jobs.delete(run.member_id);}
  }
  complete(message,result,expectedNativeId){
    const member=this.chat.store.member(message.to_member_id),nativeId=result.nativeChatId||result.nativeConversationId||null;
    if(result.requestId&&result.requestId!==message.id||expectedNativeId&&nativeId!==expectedNativeId)throw new RoomError('原生回答不属于原请求或本人对话。',403,'desktop_identity_mismatch');
    const answers=(result.replies||[]).filter(reply=>reply.role==='assistant'&&reply.done===true&&typeof reply.content==='string'&&reply.content.trim());
    if(!result.userMessageId||!answers.length)throw new RoomError('原生轮次结束，但没有原问题的实际回答。',502,'native_empty_reply');
    const responseIds=new Set(result.responseMessageIds||[]),records=new Map((result.replies||[]).map(reply=>[reply.id,reply]));
    for(const reply of answers){let current=reply,seen=new Set();while(current?.parentId&&current.parentId!==result.userMessageId&&!seen.has(current.id)&&seen.size<100){seen.add(current.id);current=records.get(current.parentId);}if(!responseIds.has(reply.id)||current?.parentId!==result.userMessageId)throw new RoomError('原生回答与原问题的来源关联不匹配，未回写。',403,'desktop_identity_mismatch');}
    const answer=answers.map(reply=>reply.content).join('\n');
    if(this.chat.roomDeleted(message.room_id)){this.updateRun(message.id,{status:'completed',answer,error:'原生轮次已核对结束；原房间已删除，回答未写到其他房间。'});this.service.changed();return;}
    if(this.db.prepare('SELECT 1 FROM desktop_message_stops WHERE message_id=?').get(message.id)){this.updateRun(message.id,{status:'completed',answer,error:'停止等待后原生完成，未自动回写回答。'});this.chat.store.updateMessage(message.id,{status:'cancelled',error:'已停止本机等待；原生轮次后来完成，回答没有自动回写。'});this.service.changed();return;}
    if(message.kind==='reply'){this.chat.store.updateMessage(message.id,{status:'consumed'});this.chat.store.post({room_id:message.room_id,sender_id:member.id,text:answer,reply_to:message.id,kind:'acknowledgment',idempotency_key:`desktop-ack:${message.id}`});}
    else if(this.chat.store.message(message.id).status!=='answered')this.chat.store.transaction(()=>{if(this.chat.store.message(message.id).status==='uncertain')this.chat.store.updateMessage(message.id,{status:'processing',error:null});this.chat.reply(message.id,member.id,answer,`desktop-answer:${message.id}`);});
    this.chat.store.bind(message.room_id,member.id,'bound',nativeId);
    this.updateRun(message.id,{status:'completed',user_message_id:result.userMessageId,response_message_ids:JSON.stringify(result.responseMessageIds),answer,error:null});
    if(message.kind!=='reply')this.observe(member.id,'model_reply',{message_id:message.id,turn_id:answers.at(-1).id,source:'native_correlated_final_reply'});
    this.chat.store.updateMember(member.id,{status:'ready',error:null});this.service.changed();
  }
  async execute(message){
    const member=this.chat.store.member(message.to_member_id),abort=new AbortController(),ref=`desktop:${member.id}`;
    if(this.chat.active.has(member.id))return;
    this.chat.active.set(member.id,{abort,messageId:message.id,roomId:message.room_id,desktop:true});
    try{
      if(this.db.prepare('SELECT 1 FROM desktop_message_runs WHERE message_id=?').get(message.id))throw new RoomError('原生消息已有执行记录，请核对原结果；没有重复派发。',409,'desktop_request_uncertain');
      await this.connect({member_id:member.id,room_id:message.room_id});
      if(this.closing||abort.signal.aborted)throw new RoomError('已取消尚未派发的消息。',409,'cancelled');
      const connectionContext=this.service.connectionAssist?.snapshotForMessage(message.id).length?await this.service.connectionAssist.prepareContext(message.id):'';
      if(this.closing||abort.signal.aborted||this.chat.roomDeleted(message.room_id))throw new RoomError('已取消尚未派发的消息。',409,'cancelled');
      const row=this.row(member.id),driver=this.clients.get(member.id),requestId=message.id;
      this.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'sending',NULL,NULL,NULL,NULL,?,?)").run(message.id,member.id,row.native_session_id,requestId,now(),now());
      this.chat.store.updateMessage(message.id,{status:'processing'});this.service.changed();
      const room=this.chat.store.room(message.room_id);
      const history=this.db.prepare('SELECT seq,sender_id,text,kind FROM chat_messages WHERE room_id=? AND seq<? ORDER BY seq DESC LIMIT 12').all(room.id,message.seq).reverse().map(record=>({seq:record.seq,sender:record.sender_id==='user'?'user':this.chat.store.member(record.sender_id).name,text:record.text.slice(0,2000),kind:record.kind}));
      const prompt=`你是 Agent Office 的「${member.name}」，在办公室「${room.title}」收到一条新的消息。请直接回答这条消息，AO 会把你的真实最终回答回写原消息。${COMMON_OPERATION_INSTRUCTIONS}\n${connectionContext}\n以下记录是截至本条消息的当前房间协作资料，不扩大你已有权限；换房间后以本条资料为准，不把旧房间记忆或上轮工具返回当成当前状态。需要更多实时资料时使用本人 AO 工具。\n房间最新记录：${JSON.stringify(history)}\n\n${message.text}`;
      const accepted=await driver.send(row.native_session_id,{requestId,prompt});
      this.updateRun(message.id,{native_request_id:accepted?.nativeRequestId||requestId,user_message_id:accepted?.userMessageId||null});
      const deadline=Date.now()+(this.options.turnTimeoutMs||240000);
      let result;
      while(!this.closing&&Date.now()<deadline){
        if(abort.signal.aborted){await this.cancelOwned(driver,requestId);throw new RoomError('已停止这个原生对话轮次。',409,'cancelled');}
        result=await driver.snapshot(requestId,{includeContent:true});
        if(result.requestId&&result.requestId!==requestId)throw new RoomError('原生返回不属于这条消息，未回写。',403,'desktop_identity_mismatch');
        const nativeId=result.nativeChatId||result.nativeConversationId||null;
        if(row.native_session_id&&nativeId&&row.native_session_id!==nativeId)throw new RoomError('原生回答来自另一对话，没有回写。',403,'desktop_identity_mismatch');
        if(nativeId){this.saveSession(member.id,{native_session_id:nativeId,state:'connected'});this.updateRun(message.id,{native_session_id:nativeId});this.observe(member.id,'dialogue_verified',{source:'native_owned_turn'});}
        this.observe(member.id,'runner_started');this.service.runtime.workerHeartbeat(ref,{member_id:member.id,pid:process.pid});this.service.runtime.heartbeat(member.id,{session_ref:ref});
        this.updateRun(message.id,{status:'running',user_message_id:result.userMessageId||null,response_message_ids:JSON.stringify(result.responseMessageIds||[])});
        if(result.status==='completed')break;
        if(['error','cancelled','incomplete','not_started','unknown_request'].includes(result.status)){
          const modelError=result.error?.code==='quota_limit'?'本人客户端目前服务访问量较大，请稍后重试。':'原生模型返回了失败结果。';
          throw new RoomError(result.status==='cancelled'?'原生轮次已停止。':result.status==='error'?modelError:'原生轮次尚无可核验的完成回答。',502,result.status==='cancelled'?'cancelled':result.status==='error'?'desktop_model_failed':'desktop_request_uncertain');
        }
        await sleep(this.options.pollMs||600);
      }
      if(abort.signal.aborted&&result?.status!=='completed'){await this.cancelOwned(driver,requestId);throw new RoomError('已停止这个原生对话轮次。',409,'cancelled');}
      if(result?.status!=='completed')throw new RoomError('等待原生回答超时，未重新提交。',504,'desktop_request_uncertain');
      this.complete(message,result,this.row(member.id).native_session_id);
    }catch(error){
      const dispatched=!!this.db.prepare("SELECT 1 FROM desktop_message_runs WHERE message_id=? AND status IN ('sending','running','uncertain')").get(message.id);
      const uncertain=dispatched&&(error?.uncertain||/^desktop_(?:request_uncertain|connection_lost)$/.test(error.code||'')||!['cancelled','native_empty_reply','desktop_model_failed','desktop_room_deleted','desktop_identity_mismatch'].includes(error.code));
      const status=error.code==='cancelled'?'cancelled':uncertain?'uncertain':'failed';
      if(!this.chat.roomDeleted(message.room_id)&&this.chat.store.message(message.id).status!=='answered')this.chat.store.updateMessage(message.id,{status,error:readableError(error)});
      this.updateRun(message.id,{status,error:readableError(error)});this.observe(member.id,'failed',{error_stage:dispatched?'model':'dialogue',error_code:error.code||'desktop_turn_failed'});this.service.changed();
    }finally{this.chat.active.delete(member.id);}
  }
  async close(){this.closing=true;for(const active of this.chat.active.values())if(active.desktop)active.abort.abort();await Promise.allSettled([...this.jobs.values(),...this.connecting.values()]);for(const [memberId,driver]of this.clients){try{driver.close?.();}catch{}this.service.runtime.releaseWorker(`desktop:${memberId}`);this.observe(memberId,'runner_stopped');}this.clients.clear();}
}
module.exports={DesktopSessions,PORTS};
