'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,sleep}=require('../src/util.cjs');

async function until(predicate,timeout=2500){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('verification fixture timed out');await sleep(5);}}
class NativeFixture extends EventEmitter {
  constructor(member,service,options,ledger){super();Object.assign(this,{member,service,options,ledger});}
  async status(){return {connected:true,signedIn:true};}
  async handshake(input){
    this.ledger.handshakes++;const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);
    this.service.chat.completeInvite(input.invitation.id,input.invitation.nonce,this.member.id);
    return {threadId:thread,turnId:id()};
  }
  async run(input){
    this.ledger.messages.push(input.request.id);input.onTurn(id());
    if(this.options.hold)await this.options.hold;
    if(this.options.failure)throw Object.assign(Error('fixture original result unknown'),{code:this.options.failure});
    const nonce=[...input.request.prompt.matchAll(/AO-CONNECT-[a-f0-9-]+/gi)].at(-1)?.[0];assert.ok(nonce,'fixture receives the persisted challenge');
    return {threadId:input.discussion.thread_id,turnId:id(),answer:this.options.wrong?'已连接':nonce};
  }
  async close(){}
}
function setup(t,options={}){
  const files=fixture(),ledger={messages:[],handshakes:0,sends:[]},executable=path.join(files.root,'codex.exe');fs.writeFileSync(executable,'fixture never executed');
  const candidates=[{id:'codex',provider:'codex',name:'Codex',adapter:'codex',installed:true,executable,capabilities:{automatic_launch:true}},
    {id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true,automatic_launch:false}}];
  let service;
  function open(){
    service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('external network prohibited');},
      chat:{clientFactory:member=>new NativeFixture(member,service,options,ledger)},
      desktop:{serverName:null,pollMs:1,driverFactory:row=>({closed:false,
        async initialize(){return {nativeChatId:row.native_session_id||`native-${row.member_id}`,detached:true};},
        async send(nativeId,{requestId,prompt}){ledger.sends.push({nativeId,requestId,prompt});return {userMessageId:`u-${requestId}`};},
        async snapshot(requestId){const nonce=[...(ledger.sends.find(send=>send.requestId===requestId)?.prompt.matchAll(/AO-CONNECT-[a-f0-9-]+/gi)||[])].at(-1)?.[0];
          return {requestId,nativeChatId:row.native_session_id||`native-${row.member_id}`,status:'completed',userMessageId:`u-${requestId}`,responseMessageIds:[`r-${requestId}`],replies:[{id:`r-${requestId}`,parentId:`u-${requestId}`,role:'assistant',done:true,content:nonce}]};},close(){this.closed=true;}})},
      onboarding:{verification:{timeoutMs:options.timeoutMs||1000,pollMs:5},desktopConnector:options.desktop===true?undefined:async()=>{throw Error('fixture native client unavailable');}},
      launch:{discover:()=>({candidates}),installer:async()=>({status:'configured',installed:true,needs_reload:true})}});
    return service;
  }
  open();const project=service.addProject({name:'Verification fixture',path:files.project}),room=service.chat.addRoom({title:'automatic setup',project_id:project.id});
  t.after(async()=>{await service.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {files,ledger,room,project,get service(){return service;},async reopen(){await service.close();open();},
    async start(input={}){const result=service.onboarding.start({provider:'codex',room_id:room.id,...input});await Promise.all([...service.onboarding.jobs.values()]);return result;}};
}

test('fresh automatic setup sends one owned challenge, verifies the actual native answer and becomes ready for office',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;}),v=setup(t,{hold});
  const start=await v.start();await until(()=>v.ledger.messages.length===1);
  const pending=v.service.onboarding.state({run_id:start.id});assert.equal(pending.stage,'verifying_reply');assert.equal(pending.status,'running');assert.equal(pending.ready_for_office,false);assert.equal(pending.automatic_reply_verified,false);
  for(let n=0;n<5;n++){v.service.onboarding.state({run_id:start.id});assert.equal(v.service.onboarding.start({provider:'codex',room_id:v.room.id}).id,start.id);}
  assert.equal(v.ledger.messages.length,1);assert.equal(v.ledger.handshakes,1);
  release();await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);
  const verified=v.service.onboarding.state({run_id:start.id});assert.equal(verified.stage,'ready_automatic');assert.equal(verified.automatic_reply_verified,true);assert.equal(verified.reply_verification.status,'verified');
  const proof=v.service.store.db.prepare('SELECT * FROM onboarding_reply_verifications').get();
  assert.equal(verified.reply_verification.message_id,v.ledger.messages[0]);assert.equal(v.service.chat.store.message(proof.reply_id).reply_to,proof.message_id);
  assert.equal(v.service.chat.store.message(proof.reply_id).text,proof.nonce);assert.equal(v.service.runtime.connectionState(verified.member_id).sessions[0].model.message_id,proof.message_id);
  const revision=v.service.revision;for(let n=0;n<5;n++)v.service.onboarding.state({run_id:start.id});assert.equal(v.service.revision,revision);assert.equal(v.ledger.messages.length,1);
});

test('a text claim with the wrong challenge cannot become ready; only explicit retry starts one new check on same person',async t=>{
  const options={wrong:true},v=setup(t,options),start=await v.start();
  await until(()=>v.service.onboarding.state({run_id:start.id}).reply_verification?.status==='failed');
  const failed=v.service.onboarding.state({run_id:start.id});assert.equal(failed.ready_for_office,false);assert.equal(failed.stage,'verification_failed');assert.equal(failed.next_actions[0].operation,'retry');
  for(let n=0;n<3;n++)v.service.onboarding.advanceVerifications();assert.equal(v.ledger.messages.length,1);
  options.wrong=false;const retry=v.service.onboarding.retry({run_id:start.id});await Promise.all([...v.service.onboarding.jobs.values()]);
  await until(()=>v.service.onboarding.state({run_id:retry.id}).ready_for_office);
  assert.equal(v.service.onboarding.state({run_id:retry.id}).member_id,failed.member_id);assert.equal(v.ledger.messages.length,2);
  assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_verification_history').get().n,1);
});

test('manual MCP acceptance remains mailbox only and never starts an automatic model check',async t=>{
  const v=setup(t),start=await v.start({provider:'qwen-desktop'}),first=v.service.onboarding.state({run_id:start.id});
  assert.equal(first.stage,'awaiting_native_desktop');const card=v.service.entry.primary(first.member_id,v.room.id);v.service.entry.accept(JSON.parse(fs.readFileSync(card.file,'utf8')));
  const ready=v.service.onboarding.state({run_id:start.id});assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.ready_for_office,true);assert.equal(ready.can_wake,false);assert.equal(ready.automatic_reply_verified,false);assert.equal(ready.reply_verification,null);
  assert.equal(v.ledger.messages.length,0);assert.equal(v.ledger.sends.length,0);assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_reply_verifications').get().n,0);
});

test('a correct mailbox-style tool reply and an unrelated native proof cannot substitute for this owned native check',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;}),v=setup(t,{hold}),start=await v.start();await until(()=>v.ledger.messages.length===1);
  const pending=v.service.onboarding.state({run_id:start.id}),row=v.service.store.db.prepare('SELECT * FROM onboarding_reply_verifications').get();
  const other=v.service.chat.addMember({name:'unrelated sender',adapter:'mailbox'});v.service.chat.join(v.room.id,other.id);
  v.service.chat.store.post({room_id:v.room.id,sender_id:other.id,text:row.nonce,reply_to:row.message_id,kind:'reply',idempotency_key:'wrong-person-answer'});
  v.service.onboarding.advanceVerifications();assert.equal(v.service.onboarding.state({run_id:start.id}).ready_for_office,false);
  // An own-member MCP response can be legitimate mailbox communication but
  // cannot attest that the automatic executor actually completed this turn.
  const proof=v.service.chat.reply(row.message_id,pending.member_id,row.nonce,'mailbox-tool-answer');
  v.service.onboarding.advanceVerifications();const mailbox=v.service.onboarding.state({run_id:start.id});assert.equal(mailbox.ready_for_office,false);assert.equal(mailbox.automatic_reply_verified,false);assert.equal(mailbox.reply_verification.status,'waiting');
  release();await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);assert.equal(v.ledger.messages.length,1);assert.equal(v.service.chat.store.message(proof.id).sender_id,pending.member_id);
});

test('an unknown native result survives restart and repeated setup without a duplicate verification turn',async t=>{
  const v=setup(t,{failure:'outcome_uncertain'}),start=await v.start();
  await until(()=>v.service.onboarding.state({run_id:start.id}).reply_verification?.status==='uncertain');
  const original=v.service.onboarding.state({run_id:start.id});assert.equal(original.ready_for_office,false);const messageId=original.reply_verification.message_id;
  await v.reopen();for(let n=0;n<4;n++){v.service.onboarding.advanceVerifications();v.service.onboarding.state({run_id:start.id});}
  const reused=v.service.onboarding.start({provider:'codex',room_id:v.room.id});assert.equal(reused.id,start.id);assert.equal(reused.reused,true);assert.equal(reused.reply_verification.message_id,messageId);
  assert.equal(v.ledger.messages.length,1);assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_reply_verifications').get().n,1);
  const retry=v.service.onboarding.retry({run_id:start.id});await Promise.all([...v.service.onboarding.jobs.values()]);
  assert.equal(v.service.onboarding.state({run_id:retry.id}).reply_verification.message_id,messageId);assert.equal(v.ledger.messages.length,1);assert.equal(v.ledger.handshakes,1);
});

test('verification deadline exposes waiting status without cancelling or resubmitting the original turn',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;}),v=setup(t,{hold,timeoutMs:15}),start=await v.start();
  await until(()=>v.service.onboarding.state({run_id:start.id}).reply_verification?.status==='waiting_result');
  const waiting=v.service.onboarding.state({run_id:start.id});assert.equal(waiting.status,'needs_action');assert.equal(waiting.ready_for_office,false);assert.equal(waiting.stage,'verification_pending');assert.equal(v.ledger.messages.length,1);
  release();await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);assert.equal(v.ledger.messages.length,1);
});

test('an existing-person explicit desktop connect verifies through HTTP without creating another member and recovers after restart',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'existing Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  // This API test covers the direct setup path with no launch/onboarding record.
  const token=id(),server=createServer(v.service,{port:0,token}),port=await server.listen();t.after(()=>server.close());
  const response=await fetch(`http://127.0.0.1:${port}/api/desktop/connect`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'})});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.configured,true);assert.equal(result.onboarding.member_id,member.id);
  await until(()=>v.service.onboarding.state({run_id:result.onboarding.id}).ready_for_office);assert.equal(v.ledger.sends.length,1);assert.equal(v.service.chat.store.members().length,1);
  const originalMessage=result.onboarding.reply_verification.message_id;await server.close();await v.reopen();
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id});const again=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});
  assert.equal(again.id,result.onboarding.id);assert.equal(again.ready_for_office,true);assert.equal(again.reply_verification.message_id,originalMessage);assert.equal(v.ledger.sends.length,1);
  const second=v.service.chat.addRoom({title:'new office room',project_id:v.project.id});v.service.chat.join(second.id,member.id);
  const moved=v.service.onboarding.verifyMember({member_id:member.id,room_id:second.id});assert.equal(moved.ready_for_office,true);assert.equal(moved.member_id,member.id);assert.equal(moved.reply_verification.message_id,originalMessage);assert.equal(v.ledger.sends.length,1);
});

for(const lifecycle of ['deleted','left'])test(`a provably unsent check in a ${lifecycle} room does not strand the same person in a new room`,async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'moving Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const dispatch=v.service.desktop.adapter.message;v.service.desktop.adapter.message=()=>{};
  const first=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id}),original=first.reply_verification.message_id;
  assert.equal(v.service.chat.store.message(original).status,'queued');assert.equal(v.ledger.sends.length,0);
  if(lifecycle==='deleted')v.service.chat.store.deleteRoom(v.room.id,()=>{},{force:true});else v.service.chat.store.leave(v.room.id,member.id);
  const second=v.service.chat.addRoom({title:'replacement room',project_id:v.project.id});v.service.chat.join(second.id,member.id);v.service.desktop.adapter.message=dispatch;
  const next=v.service.onboarding.verifyMember({member_id:member.id,room_id:second.id});
  await until(()=>v.service.onboarding.state({run_id:next.id}).ready_for_office);
  const ready=v.service.onboarding.state({run_id:next.id});assert.equal(ready.member_id,member.id);assert.notEqual(ready.reply_verification.message_id,original);assert.equal(v.ledger.sends.length,1);
  assert.equal(v.service.store.db.prepare('SELECT status FROM chat_messages WHERE id=?').get(original).status,'cancelled');
  assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_verification_history').get().n,1);
});

test('deleting the old room never retries a check whose native submission is still uncertain',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'uncertain Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});v.service.desktop.adapter.message=()=>{};
  const first=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id}),original=first.reply_verification.message_id,stamp=new Date().toISOString();
  v.service.store.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'uncertain',NULL,NULL,NULL,NULL,?,?)").run(original,member.id,v.service.desktop.row(member.id).native_session_id,original,stamp,stamp);
  v.service.chat.store.updateMessage(original,{status:'cancelled',error:'forced room removal'});v.service.chat.store.deleteRoom(v.room.id,()=>{},{force:true});
  const second=v.service.chat.addRoom({title:'new room with same person',project_id:v.project.id});v.service.chat.join(second.id,member.id);
  const next=v.service.onboarding.verifyMember({member_id:member.id,room_id:second.id});assert.equal(next.ready_for_office,false);assert.equal(next.reply_verification.message_id,original);assert.equal(next.reply_verification.status,'uncertain');
  const repeated=v.service.onboarding.retry({run_id:next.id});assert.equal(repeated.reply_verification.message_id,original);assert.equal(v.ledger.sends.length,0);
  assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_verification_history').get().n,0);
});

test('a historical model answer with a later model failure is not adopted as a fresh automatic verification',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'stale-proof Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const old=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:member.id,text:'old task',idempotency_key:'old-proof'});
  v.service.chat.reply(old.id,member.id,'old actual answer','old-answer');v.service.desktop.observe(member.id,'model_reply',{message_id:old.id,turn_id:'old-turn',source:'native_correlated_final_reply'});
  v.service.desktop.observe(member.id,'failed',{error_stage:'model',error_code:'model_failed'});
  const start=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});assert.notEqual(start.reply_verification.message_id,old.id);assert.equal(start.ready_for_office,false);
  await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);assert.equal(v.ledger.sends.length,1);
});

test('a prior verified check with a later failure offers explicit recovery without background model retries',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'retry Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const start=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);
  v.service.desktop.observe(member.id,'failed',{error_stage:'model',error_code:'model_failed'});v.service.changed();
  for(let n=0;n<4;n++)v.service.onboarding.advanceVerifications();const blocked=v.service.onboarding.state({run_id:start.id});
  assert.equal(blocked.ready_for_office,false);assert.equal(blocked.next_actions[0].operation,'retry');assert.match(blocked.detail,/此前已通过/);assert.equal(v.ledger.sends.length,1);
  const retry=v.service.onboarding.retry({run_id:start.id});await until(()=>v.service.onboarding.state({run_id:retry.id}).ready_for_office);assert.equal(v.ledger.sends.length,2);assert.equal(v.service.chat.store.members().length,1);
});

test('a controller-confirmed completed uncertain check can be retried explicitly without changing identity',async t=>{
  const options={failure:'outcome_uncertain'},v=setup(t,options),start=await v.start();await until(()=>v.service.onboarding.state({run_id:start.id}).reply_verification?.status==='uncertain');
  const uncertain=v.service.onboarding.state({run_id:start.id});v.service.chat.store.updateMessage(uncertain.reply_verification.message_id,{status:'completed'});v.service.onboarding.advanceVerifications();
  assert.equal(v.service.onboarding.state({run_id:start.id}).reply_verification.status,'failed');options.failure=null;
  const retry=v.service.onboarding.retry({run_id:start.id});await until(()=>v.service.onboarding.state({run_id:retry.id}).ready_for_office);assert.equal(v.ledger.messages.length,2);
});

test('public verification markers identify the owned request and reply while preserving raw native text',async t=>{
  const v=setup(t),start=await v.start();await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);
  const verification=v.service.store.db.prepare('SELECT * FROM onboarding_reply_verifications').get();
  const request=v.service.chat.store.message(verification.message_id),reply=v.service.chat.store.message(verification.reply_id);
  assert.deepEqual(request.connection_verification,{request_id:request.id,member_id:verification.member_id,phase:'request',status:'verified'});
  assert.deepEqual(reply.connection_verification,{request_id:request.id,member_id:verification.member_id,phase:'reply',status:'verified'});
  assert.ok(request.text.endsWith('请只回复这一行：'+verification.nonce));assert.equal(reply.text,verification.nonce);
  assert.equal(v.service.store.db.prepare('SELECT text FROM chat_messages WHERE id=?').get(request.id).text,request.text);
  const page=v.service.chat.store.messagePage(v.room.id).messages;assert.equal(page.find(message=>message.id===request.id).connection_verification.phase,'request');assert.equal(page.find(message=>message.id===reply.id).connection_verification.phase,'reply');
});

test('copied verification words or client-supplied marker objects cannot hide ordinary user or agent messages',async t=>{
  const v=setup(t),start=await v.start();await until(()=>v.service.onboarding.state({run_id:start.id}).ready_for_office);
  const verification=v.service.store.db.prepare('SELECT * FROM onboarding_reply_verifications').get(),original=v.service.chat.store.message(verification.message_id);
  const other=v.service.chat.addMember({name:'ordinary agent',adapter:'mailbox'});v.service.chat.join(v.room.id,other.id);
  for(const input of [
    {sender_id:'user',to_member_id:verification.member_id,text:original.text},
    {sender_id:other.id,text:original.text},
    {sender_id:'user',reply_to:original.id,kind:'reply',text:verification.nonce},
    {sender_id:other.id,reply_to:original.id,kind:'reply',text:verification.nonce}
  ]){
    const message=v.service.chat.store.post({room_id:v.room.id,idempotency_key:id(),connection_verification:{phase:'request',status:'verified'},...input});
    assert.equal(message.connection_verification,undefined);assert.equal(v.service.chat.store.message(message.id).connection_verification,undefined);assert.equal(message.text,input.text);
  }
});

test('adopting an actual historical business reply preserves both messages as ordinary visible conversation',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'existing business Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const question=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:member.id,text:'保留这条真实业务问题。',idempotency_key:'business-proof'});
  const answer=v.service.chat.reply(question.id,member.id,'保留这条真实业务回答。','business-answer');
  v.service.desktop.observe(member.id,'model_reply',{message_id:question.id,turn_id:'business-turn',source:'native_correlated_final_reply'});
  const adopted=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});assert.equal(adopted.ready_for_office,true);assert.equal(adopted.reply_verification.message_id,question.id);assert.equal(v.ledger.sends.length,0);
  for(const message of [question,answer]){const visible=v.service.chat.store.message(message.id);assert.equal(visible.connection_verification,undefined);assert.equal(visible.text,message.text);}
});
