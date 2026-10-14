'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {sleep,now}=require('../src/util.cjs');

class FakeDesktopDriver {
  constructor(row,ledger,options={}){this.row=row;this.ledger=ledger;this.options=options;this.nativeChatId=row.native_session_id || `native-${row.member_id}`;this.runs=new Map();this.closed=false;this.cancelled=[];}
  async initialize(input){this.ledger.initializations.push({memberId:this.row.member_id,nativeChatId:input.nativeChatId});return {detached:this.options.detached!==false,nativeChatId:this.options.initializeNativeId || this.nativeChatId};}
  async createPersonConversation(input){return this.initialize({nativeChatId:typeof input==='string'?input:input?.nativeChatId || this.nativeChatId});}
  async send(nativeChatId,{requestId,prompt}){
    this.ledger.sends.push({memberId:this.row.member_id,nativeChatId,requestId,prompt});
    if(this.options.sendError)throw Object.assign(new Error('fixture uncertain submission'),{code:this.options.sendError});
    this.runs.set(requestId,{requestId,nativeChatId:this.nativeChatId,status:this.options.hold?'sending':'completed',userMessageId:'user-'+requestId,responseMessageIds:['response-'+requestId],replies:[{id:'response-'+requestId,parentId:'user-'+requestId,role:'assistant',done:true,content:'native fixture: '+prompt.split('\n\n').at(-1)}]});
    return {status:'sending',nativeChatId:this.nativeChatId};
  }
  async snapshot(requestId){const state=this.runs.get(requestId);if(!state)return {status:'unknown_request'};return this.options.result?this.options.result(structuredClone(state)):structuredClone(state);}
  async cancel(requestId){this.cancelled.push(requestId);this.ledger.cancels.push({memberId:this.row.member_id,requestId});const run=this.runs.get(requestId);if(!this.options.cancelUnacknowledged&&run)run.status='cancelled';return run?structuredClone(run):{status:'unknown_request'};}
  close(){this.closed=true;}
}
async function until(predicate,timeout=1500){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>=end)throw Error('fixture condition did not complete');await sleep(5);}}
function setup(t,options={}){
  const files=fixture(),ledger={sends:[],initializations:[],cancels:[],drivers:[]};let service;
  const desktop={pollMs:1,turnTimeoutMs:options.turnTimeoutMs || 1000,driverFactory:row=>{const driver=new FakeDesktopDriver(row,ledger,options.driver || {});ledger.drivers.push(driver);return driver;}};
  const open=()=>new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('External/model HTTP forbidden in fixture');},desktop});
  service=open();const project=service.addProject({name:'Desktop fixture',path:files.project}),room=service.chat.addRoom({title:'First room',project_id:project.id});
  const member=service.chat.addMember({name:'Qwen Chat fixture',adapter:'mailbox'});
  service.chat.store.updateMember(member.id,{config:{launch_provider:'qwen-desktop'}});service.chat.join(room.id,member.id);
  t.after(async()=>{await service.close();const resolved=path.resolve(files.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return {files,ledger,room,member,project,get service(){return service;},async reopen(){await service.close();service=open();return service;},post(text,key,roomId=room.id){return service.chat.post({room_id:roomId,to_member_id:member.id,text,idempotency_key:key});},rawPost(text,key,roomId=room.id){return service.chat.store.post({room_id:roomId,sender_id:'user',to_member_id:member.id,text,idempotency_key:key});}};
}

test('desktop automatically answers two queued messages in the same person conversation',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const first=f.post('first','first'),second=f.post('second','second');
  await until(()=>[first,second].every(m=>f.service.chat.store.message(m.id).status==='answered'));
  assert.deepEqual(f.ledger.sends.map(send=>send.requestId),[first.id,second.id]);
  assert.equal(new Set(f.ledger.sends.map(send=>send.nativeChatId)).size,1);
  for(const message of [first,second]){const replies=f.service.chat.store.messages(f.room.id).filter(reply=>reply.reply_to===message.id&&reply.kind==='reply');assert.equal(replies.length,1);assert.equal(replies[0].sender_id,f.member.id);assert.equal(replies[0].text,'native fixture: '+message.text);}
  assert.equal(f.service.codex.calls.length,0,'desktop identity must never invoke a CLI fallback');
  assert.equal(f.service.runtime.connectionState(f.member.id).automatic_reply_verified,true);
});

test('new room and service restart reuse the durable native conversation identity',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const one=f.post('before restart','before');await until(()=>f.service.chat.store.message(one.id).status==='answered');
  const nativeId=f.service.desktop.row(f.member.id).native_session_id;
  const other=f.service.chat.addRoom({title:'Other room',project_id:f.project.id});f.service.chat.join(other.id,f.member.id);
  const two=f.post('new room','room-two',other.id);await until(()=>f.service.chat.store.message(two.id).status==='answered');
  assert.equal(f.service.chat.store.binding(f.room.id,f.member.id).thread_id,nativeId);assert.equal(f.service.chat.store.binding(other.id,f.member.id).thread_id,nativeId);
  await f.reopen();assert.equal(f.service.desktop.canWake(f.member.id),false);assert.equal(f.service.desktop.row(f.member.id).native_session_id,nativeId);
  await f.service.desktop.connect({member_id:f.member.id,room_id:other.id});const three=f.post('after restart','after',other.id);await until(()=>f.service.chat.store.message(three.id).status==='answered');
  assert.equal(f.ledger.initializations.at(-1).nativeChatId,nativeId);assert.equal(f.ledger.sends.at(-1).nativeChatId,nativeId);assert.equal(f.service.desktop.row(f.member.id).native_session_id,nativeId);
});

test('persistent native person turns receive recent context only from the addressed room before their own message',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const other=f.service.chat.addRoom({title:'Second context room',project_id:f.project.id});f.service.chat.join(other.id,f.member.id);
  const announce=(roomId,text,key)=>f.service.chat.store.post({room_id:roomId,sender_id:'user',text,idempotency_key:key});
  announce(other.id,'OTHER_ROOM_RECORD','other-context');
  announce(f.room.id,'OLD_CONTEXT_OUTSIDE_WINDOW','old-context');
  for(let i=0;i<12;i++)announce(f.room.id,'RECENT_ROOM_RECORD_'+i,'context-'+i);
  const first=f.rawPost('read this room','context-first');announce(f.room.id,'FUTURE_ROOM_RECORD','future-context');
  await f.service.desktop.execute(first);
  const firstSend=f.ledger.sends.at(-1);assert.ok(firstSend.prompt.includes('RECENT_ROOM_RECORD_11'));
  for(const unrelated of ['OTHER_ROOM_RECORD','OLD_CONTEXT_OUTSIDE_WINDOW','FUTURE_ROOM_RECORD'])assert.equal(firstSend.prompt.includes(unrelated),false,unrelated);
  assert.equal(firstSend.prompt.split('\n\n').at(-1),first.text);
  const second=f.rawPost('read this room','context-second',other.id);await f.service.desktop.execute(second);
  const secondSend=f.ledger.sends.at(-1);assert.equal(secondSend.nativeChatId,firstSend.nativeChatId);assert.ok(secondSend.prompt.includes('OTHER_ROOM_RECORD'));
  assert.equal(secondSend.prompt.includes('RECENT_ROOM_RECORD_11'),false);
  announce(other.id,'UPDATED_OTHER_ROOM_RECORD','updated-other-context');
  const third=f.rawPost('read this room','context-third',other.id);await f.service.desktop.execute(third);
  assert.ok(f.ledger.sends.at(-1).prompt.includes('UPDATED_OTHER_ROOM_RECORD'));
});

test('native load and protocol contact do not count as an actual model reply',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const evidence=f.service.runtime.connectionState(f.member.id);
  assert.equal(evidence.protocol_verified,true);assert.equal(evidence.native_conversation_loaded,true);assert.equal(evidence.model_reply_verified,false);assert.equal(evidence.automatic_reply_verified,false);assert.equal(f.ledger.sends.length,0);
});

test('a native quota failure remains a failed request and reports the provider limit without an automatic resend',async t=>{
  const f=setup(t,{driver:{result:state=>({...state,status:'error',error:{code:'quota_limit'}})}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const message=f.post('limited request','quota-limit');await until(()=>f.service.chat.store.message(message.id).status==='failed');
  assert.match(f.service.chat.store.message(message.id).error,/服务访问量较大/);
  await f.service.desktop.pump(f.member.id);assert.equal(f.ledger.sends.length,1);
  assert.equal(f.service.chat.store.messages(f.room.id).filter(m=>m.reply_to===message.id&&m.kind==='reply').length,0);
  assert.equal(f.service.runtime.connectionState(f.member.id).model_reply_verified,false);
});

test('a separately owned active turn blocks desktop dispatch until it is released',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.rawPost('wait for owner','owned-busy');
  f.service.chat.active.set(f.member.id,{messageId:'other-owned-request',roomId:f.room.id,abort:new AbortController(),desktop:false});
  try{await f.service.desktop.pump(f.member.id);assert.equal(f.ledger.sends.length,0);assert.equal(f.service.desktop.jobs.size,0);assert.equal(f.service.chat.store.message(message.id).status,'queued');}
  finally{f.service.chat.active.delete(f.member.id);}
  await f.service.desktop.pump(f.member.id);assert.equal(f.service.chat.store.message(message.id).status,'answered');assert.equal(f.ledger.sends.length,1);
});

test('uncertain submission is durable and never automatically resends across restart',async t=>{
  const f=setup(t,{driver:{sendError:'desktop_request_uncertain'}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.post('uncertain','uncertain');await until(()=>f.service.chat.store.message(message.id).status==='uncertain');
  await f.service.desktop.pump(f.member.id);assert.equal(f.ledger.sends.length,1);await f.reopen();await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});await f.service.desktop.pump(f.member.id);
  assert.equal(f.ledger.sends.length,1);assert.equal(f.service.chat.store.message(message.id).status,'uncertain');assert.equal(f.service.desktop.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(message.id).status,'uncertain');
});

test('an interrupted durable run is kept uncertain instead of replayed after service recovery',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.rawPost('interrupted','interrupted'),stamp=now();f.service.chat.store.updateMessage(message.id,{status:'processing'});
  f.service.desktop.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'running',NULL,NULL,NULL,NULL,?,?)").run(message.id,f.member.id,f.service.desktop.row(f.member.id).native_session_id,message.id,stamp,stamp);
  await f.reopen();await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});await f.service.desktop.pump(f.member.id);assert.equal(f.ledger.sends.length,0);assert.equal(f.service.chat.store.message(message.id).status,'uncertain');assert.equal(f.service.desktop.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(message.id).status,'uncertain');
});

test('cancelling queued work never cancels the separate active native request',async t=>{
  const f=setup(t,{driver:{hold:true}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const first=f.post('active','active'),second=f.post('queued','queued');await until(()=>f.ledger.sends.length===1);
  f.service.chat.cancel(second.id);assert.equal(f.service.chat.store.message(second.id).status,'cancelled');assert.equal(f.ledger.cancels.length,0);assert.equal(f.service.chat.active.get(f.member.id).messageId,first.id);
  f.service.chat.cancel(first.id);await until(()=>f.service.chat.store.message(first.id).status==='cancelled');assert.deepEqual(f.ledger.cancels.map(c=>c.requestId),[first.id]);assert.equal(f.ledger.sends.length,1);
});

test('an unacknowledged native cancellation remains uncertain instead of claiming cancelled',async t=>{
  const f=setup(t,{driver:{hold:true,cancelUnacknowledged:true}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.post('unacknowledged stop','unack');await until(()=>f.ledger.sends.length===1);f.service.chat.cancel(message.id);
  await until(()=>!f.service.desktop.jobs.size);assert.equal(f.service.chat.store.message(message.id).status,'uncertain');assert.equal(f.ledger.cancels[0].requestId,message.id);assert.equal(f.service.runtime.connectionState(f.member.id).model_reply_verified,false);
});

for(const content of ['', '  \n '])test('a terminal native state without a nonempty assistant response cannot be written back: '+JSON.stringify(content),async t=>{
  const f=setup(t,{driver:{result:state=>({...state,replies:[{...state.replies[0],content}]})}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.post('empty answer','empty');await until(()=>['failed','uncertain'].includes(f.service.chat.store.message(message.id).status));
  assert.equal(f.service.chat.store.messages(f.room.id).filter(m=>m.reply_to===message.id&&m.kind==='reply').length,0);assert.equal(f.service.runtime.connectionState(f.member.id).model_reply_verified,false);
});

for(const [boundary,corrupt]of [
  ['request',state=>({...state,requestId:'foreign-request'})],
  ['assistant parent',state=>({...state,replies:[{...state.replies[0],parentId:'foreign-user'}]})],
  ['assistant response',state=>({...state,replies:[{...state.replies[0],id:'foreign-response'}]})]
])test('native answers reject a foreign '+boundary+' identity',async t=>{
  const f=setup(t,{driver:{result:corrupt}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const message=f.post('owned question','owned');await until(()=>!f.service.desktop.jobs.size&&f.service.chat.store.message(message.id).status!=='queued');
  assert.notEqual(f.service.chat.store.message(message.id).status,'answered');assert.equal(f.service.chat.store.messages(f.room.id).filter(m=>m.reply_to===message.id&&m.kind==='reply').length,0);assert.equal(f.service.runtime.connectionState(f.member.id).model_reply_verified,false);
});

test('desktop connection rejects CLI members instead of substituting their identity',async t=>{
  const f=setup(t),cli=f.service.chat.addMember({name:'Qwen Code fixture',adapter:'qwen-code'});f.service.chat.join(f.room.id,cli.id);await assert.rejects(f.service.desktop.connect({member_id:cli.id,room_id:f.room.id,provider:'qwen-desktop'}),{code:'desktop_identity_mismatch'});assert.equal(f.ledger.drivers.length,0);assert.equal(f.service.codex.calls.length,0);
});

test('a failed detached contract clears availability rather than claiming automatic wake',async t=>{
  const f=setup(t,{driver:{detached:false}});await assert.rejects(f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id}),{code:'desktop_contract_mismatch'});assert.equal(f.service.desktop.canWake(f.member.id),false);assert.equal(f.service.desktop.state(f.member.id).state,'offline');assert.equal(f.ledger.drivers[0].closed,true);assert.equal(f.service.runtime.connectionState(f.member.id).automatic_reply_verified,false);assert.equal(f.service.runtime.connectionState(f.member.id).runner_online,false,'a failed and closed native driver cannot retain online runner evidence');
});

test('closing the desktop connection withdraws wake and loaded conversation evidence',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});assert.equal(f.service.desktop.canWake(f.member.id),true);await f.service.desktop.close();assert.equal(f.service.desktop.canWake(f.member.id),false);assert.equal(f.service.desktop.state(f.member.id).can_wake,false);assert.equal(f.service.runtime.connectionState(f.member.id).native_conversation_loaded,false);assert.equal(f.service.runtime.connectionState(f.member.id).runner_online,false);assert.equal(f.ledger.drivers[0].closed,true);
});

test('a persisted person conversation cannot silently change during initialize',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});const owned=f.service.desktop.row(f.member.id).native_session_id;await f.reopen();f.service.desktop.options.driverFactory=row=>new FakeDesktopDriver(row,f.ledger,{initializeNativeId:'foreign-native-conversation'});
  await assert.rejects(f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id}),{code:'desktop_identity_mismatch'});assert.equal(f.service.desktop.row(f.member.id).native_session_id,owned);assert.equal(f.service.desktop.canWake(f.member.id),false);
});

test('a first failed desktop transport attempt preserves the existing manual adapter',async t=>{
  const f=setup(t),manual=f.service.chat.adapter(f.service.chat.store.member(f.member.id));
  f.service.desktop.options.driverFactory=async()=>{throw Object.assign(new Error('fixture unsupported native bundle'),{code:'desktop_version_unsupported'});};
  await assert.rejects(f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id}),{code:'desktop_version_unsupported'});
  assert.equal(f.service.desktop.canWake(f.member.id),false);
  assert.equal(f.service.chat.adapter(f.service.chat.store.member(f.member.id)),manual,'a failed first attempt must not replace the working mailbox route');
  assert.equal(f.service.chat.publicMember(f.service.chat.store.member(f.member.id)).manual_wake,true);
  assert.equal(f.ledger.sends.length,0);
});

test('reconnecting the already connected person does not initialize or close its active native driver',async t=>{
  const f=setup(t,{driver:{hold:true}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const message=f.post('keep the original active turn','reconnect-active');await until(()=>f.ledger.sends.length===1);
  const driver=f.service.desktop.clients.get(f.member.id),before=f.ledger.initializations.length;
  driver.createPersonConversation=async()=>{throw Object.assign(new Error('fixture native chat is already streaming'),{code:'desktop_busy'});};
  let failure;
  try {
    try{await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});}catch(error){failure=error;}
    assert.equal(failure,undefined,'a healthy owned active driver must be reused without another initialization');
    assert.equal(driver.closed,false);assert.equal(f.service.desktop.clients.get(f.member.id),driver);
    assert.equal(f.ledger.initializations.length,before);assert.equal(f.ledger.sends.length,1);
  } finally {
    f.service.chat.cancel(message.id);await until(()=>!f.service.desktop.jobs.size);
  }
});

test('an uncertain native creation cannot silently create again after a service restart',async t=>{
  const f=setup(t);let nativeCreations=0;
  f.service.desktop.options.driverFactory=row=>{
    const driver=new FakeDesktopDriver(row,f.ledger);f.ledger.drivers.push(driver);
    driver.createPersonConversation=async()=>{nativeCreations++;throw Object.assign(new Error('fixture native creation accepted but acknowledgement lost'),{code:'desktop_request_uncertain',uncertain:true});};
    return driver;
  };
  await assert.rejects(f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id}),{code:'desktop_request_uncertain'});
  assert.equal(nativeCreations,1);assert.equal(f.service.desktop.row(f.member.id).native_session_id,null);
  await f.reopen();
  await assert.rejects(f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id}),error=>/uncertain/.test(error.code||''));
  assert.equal(nativeCreations,1,'the missing native ID is unresolved creation evidence, not permission to create a second chat');
});

test('an unresolved submitted turn blocks the next queued native turn instead of automatically overlapping it',async t=>{
  const f=setup(t,{driver:{sendError:'desktop_request_uncertain'}});await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const first=f.post('first submission remains unknown','blocking-uncertain'),second=f.post('wait for its result','after-uncertain');
  await until(()=>f.service.chat.store.message(first.id).status==='uncertain'&&!f.service.desktop.jobs.size);
  assert.equal(f.ledger.sends.length,1,'only the original native request may have been submitted while its result is unresolved');
  assert.equal(f.service.chat.store.message(second.id).status,'queued');
  await f.service.desktop.pump(f.member.id);
  assert.equal(f.ledger.sends.length,1);assert.equal(f.service.chat.store.message(second.id).status,'queued');
});

test('service recovery reads the original correlated completed native turn and writes it back without resending',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const chatId=f.service.desktop.row(f.member.id).native_session_id,message=f.rawPost('original before interruption','recover-correlated'),stamp=now();
  f.service.chat.store.updateMessage(message.id,{status:'processing'});
  const result={requestId:message.id,nativeChatId:chatId,status:'completed',userMessageId:'native-saved-user',responseMessageIds:['native-saved-response'],
    replies:[{id:'native-saved-response',parentId:'native-saved-user',role:'assistant',done:true,content:'completed while AO was offline'}]};
  f.service.desktop.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'running',?,?,NULL,NULL,?,?)").run(message.id,f.member.id,chatId,message.id,result.userMessageId,JSON.stringify(result.responseMessageIds),stamp,stamp);
  const nativeReads=[];
  f.service.desktop.options.driverFactory=row=>{
    const driver=new FakeDesktopDriver(row,f.ledger);f.ledger.drivers.push(driver);
    driver.snapshot=async requestId=>{nativeReads.push({requestId});return requestId===message.id?structuredClone(result):{requestId,status:'unknown_request'};};
    driver.restore=async input=>{nativeReads.push({restore:input.requestId,userMessageId:input.userMessageId});return driver.snapshot(input.requestId);};
    return driver;
  };
  await f.reopen();await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});await f.service.desktop.pump(f.member.id);
  await until(()=>f.service.chat.store.message(message.id).status==='answered');
  assert.equal(f.ledger.sends.length,0,'recovery must observe saved native identities, never resubmit the original prompt');
  assert.ok(nativeReads.some(read=>read.requestId===message.id||read.restore===message.id));
  const replies=f.service.chat.store.messages(f.room.id).filter(row=>row.reply_to===message.id&&row.kind==='reply');
  assert.equal(replies.length,1);assert.equal(replies[0].text,'completed while AO was offline');
  assert.equal(f.service.desktop.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(message.id).status,'completed');
});

test('an unacknowledged user stop survives restart and suppresses a later native answer while unblocking subsequent work',async t=>{
  const f=setup(t,{driver:{hold:true,cancelUnacknowledged:true}});
  await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const nativeId=f.service.desktop.row(f.member.id).native_session_id;
  const first=f.post('stop this original turn','durable-user-stop');
  await until(()=>f.ledger.sends.length===1&&f.service.desktop.db.prepare('SELECT user_message_id FROM desktop_message_runs WHERE message_id=?').get(first.id)?.user_message_id==='user-'+first.id);
  const oldDriver=f.service.desktop.clients.get(f.member.id),nativeRuns=oldDriver.runs;

  f.service.chat.cancel(first.id);
  await until(()=>f.service.chat.store.message(first.id).status==='uncertain'&&!f.service.desktop.jobs.size);
  assert.deepEqual(f.ledger.cancels.map(call=>call.requestId),[first.id]);
  assert.ok(f.service.desktop.db.prepare('SELECT 1 FROM desktop_message_stops WHERE message_id=?').get(first.id));
  const second=f.rawPost('next turn after terminal confirmation','after-durable-stop');
  await f.service.desktop.pump(f.member.id);
  assert.equal(f.ledger.sends.length,1);assert.equal(f.service.chat.store.message(second.id).status,'queued');

  // The native app retains the real original request while AO's transport and
  // service restart. New native turns complete normally after reattachment.
  f.service.desktop.options.driverFactory=row=>{
    const driver=new FakeDesktopDriver(row,f.ledger);driver.runs=nativeRuns;f.ledger.drivers.push(driver);return driver;
  };
  await f.reopen();
  assert.equal(f.service.desktop.canWake(f.member.id),false);
  assert.ok(f.service.desktop.db.prepare('SELECT 1 FROM desktop_message_stops WHERE message_id=?').get(first.id));
  const original=nativeRuns.get(first.id);
  original.status='completed';original.replies[0].content='late native completion after user stop';
  await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  await f.service.desktop.pump(f.member.id);
  await until(()=>f.service.chat.store.message(second.id).status==='answered');

  assert.equal(f.service.desktop.row(f.member.id).native_session_id,nativeId);
  assert.deepEqual(f.ledger.sends.map(call=>call.requestId),[first.id,second.id],'reattachment may submit only the new queued turn, never the stopped original');
  assert.equal(f.service.chat.store.message(first.id).status,'cancelled');
  assert.equal(f.service.chat.store.messages(f.room.id).filter(row=>row.reply_to===first.id&&['reply','acknowledgment'].includes(row.kind)).length,0);
  const known=f.service.desktop.db.prepare('SELECT status,answer FROM desktop_message_runs WHERE message_id=?').get(first.id);
  assert.equal(known.status,'completed');assert.equal(known.answer,'late native completion after user stop');
  const nextReplies=f.service.chat.store.messages(f.room.id).filter(row=>row.reply_to===second.id&&row.kind==='reply');
  assert.equal(nextReplies.length,1);assert.equal(nextReplies[0].text,'native fixture: '+second.text);
});

test('a healthy desktop pulse autonomously recovers a late completed uncertain turn without another message or send',async t=>{
  const f=setup(t,{turnTimeoutMs:30,driver:{hold:true}});
  await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const message=f.post('finish this original turn in the background','pulse-original');
  await until(()=>f.service.chat.store.message(message.id).status==='uncertain'&&!f.service.desktop.jobs.size);
  assert.equal(f.ledger.sends.length,1);
  assert.equal(f.service.desktop.db.prepare('SELECT 1 FROM desktop_message_stops WHERE message_id=?').get(message.id),undefined,'a wait timeout must not become a user stop');
  const driver=f.service.desktop.clients.get(f.member.id),native=driver.runs.get(message.id);
  const reads=[],snapshot=driver.snapshot.bind(driver);
  driver.snapshot=async requestId=>{reads.push(requestId);return snapshot(requestId);};
  native.status='completed';native.replies[0].content='late native answer read by the background pulse';

  // No connect, restart, pump, additional chat message, or model send is used
  // to wake recovery. This is the same pulse hook used by the service timer.
  f.service.desktop.pulse();
  await until(()=>f.service.chat.store.message(message.id).status==='answered');

  assert.deepEqual(reads,[message.id]);assert.deepEqual(f.ledger.sends.map(call=>call.requestId),[message.id]);
  const replies=f.service.chat.store.messages(f.room.id).filter(row=>row.reply_to===message.id&&row.kind==='reply');
  assert.equal(replies.length,1);assert.equal(replies[0].text,'late native answer read by the background pulse');
  assert.equal(f.service.desktop.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(message.id).status,'completed');
});

test('a completed uncertain native turn from a force deleted room settles its ledger and unblocks the same person in a new room',async t=>{
  const {deletionPreview,forceDeleteRoom}=require('../src/room-lifecycle.cjs');
  const f=setup(t,{turnTimeoutMs:30,driver:{hold:true}});
  await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const nativeId=f.service.desktop.row(f.member.id).native_session_id;
  const original=f.post('old room request with an unknown result','deleted-original');
  await until(()=>f.service.chat.store.message(original.id).status==='uncertain'&&!f.service.desktop.jobs.size);
  const driver=f.service.desktop.clients.get(f.member.id),native=driver.runs.get(original.id);
  const deleted=await forceDeleteRoom(f.service,f.room.id,deletionPreview(f.service,f.room.id).confirmation_token);
  assert.equal(deleted.status,'deleted');assert.equal(f.service.chat.roomDeleted(f.room.id),true);
  assert.equal(f.service.desktop.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(original.id).status,'uncertain');

  const other=f.service.chat.addRoom({title:'New room after deletion',project_id:f.project.id});
  f.service.chat.join(other.id,f.member.id);
  const next=f.rawPost('new room work after the original ends','new-room-after-delete',other.id);
  await f.service.desktop.pump(f.member.id);
  assert.equal(f.ledger.sends.length,1);assert.equal(f.service.chat.store.message(next.id).status,'queued');
  const modelProofs=[],observe=f.service.desktop.observe.bind(f.service.desktop);
  f.service.desktop.observe=(memberId,event,fields={})=>{if(event==='model_reply')modelProofs.push(fields.message_id);return observe(memberId,event,fields);};
  const sendsBeforeRecovery=f.ledger.sends.length;
  native.status='completed';native.replies[0].content='late completed result belonging only to the deleted room';
  driver.options.hold=false;
  await f.service.desktop.pump(f.member.id);
  await until(()=>f.service.chat.store.message(next.id).status==='answered');

  const historical=f.service.desktop.db.prepare('SELECT status,answer FROM desktop_message_runs WHERE message_id=?').get(original.id);
  assert.equal(historical.status,'completed');assert.equal(historical.answer,'late completed result belonging only to the deleted room');
  assert.equal(f.service.desktop.db.prepare('SELECT status FROM chat_messages WHERE id=?').get(original.id).status,'cancelled');
  assert.equal(f.service.desktop.db.prepare('SELECT count(*) AS n FROM chat_messages WHERE reply_to=?').get(original.id).n,0,'a deleted request cannot acquire a reply in any room');
  assert.deepEqual(f.ledger.sends.slice(sendsBeforeRecovery).map(call=>call.requestId),[next.id]);
  assert.equal(f.service.desktop.row(f.member.id).native_session_id,nativeId);
  assert.deepEqual(modelProofs,[next.id],'the old deleted-room result must not become model-reply proof');
  assert.deepEqual(f.service.chat.store.rooms().map(room=>room.id),[other.id]);
  assert.throws(()=>f.service.chat.store.room(f.room.id),{code:'room_deleted'});
  assert.equal(f.service.desktop.db.prepare('SELECT count(*) AS n FROM chat_rooms').get().n,2,'recovery must not recreate the deleted room or a replacement');
  const replies=f.service.chat.store.messages(other.id).filter(row=>row.reply_to===next.id&&row.kind==='reply');
  assert.equal(replies.length,1);assert.equal(replies[0].text,'native fixture: '+next.text);
});

test('a configured native desktop rejects unsupported images before creating a message, sending, or recording reply proof',async t=>{
  const f=setup(t);await f.service.desktop.connect({member_id:f.member.id,room_id:f.room.id});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=';
  const before=f.service.chat.store.messages(f.room.id).length;
  assert.throws(()=>f.service.chat.post({room_id:f.room.id,to_member_id:f.member.id,text:'please inspect this image',idempotency_key:'unsupported-native-image',
    attachments:[{name:'fixture.png',data_url:'data:image/png;base64,'+png}]}),{code:'image_adapter_unsupported'});
  await f.service.desktop.pump(f.member.id);
  assert.equal(f.service.chat.store.messages(f.room.id).length,before);
  assert.equal(f.service.desktop.db.prepare('SELECT count(*) AS n FROM chat_images').get().n,0);
  assert.equal(f.service.desktop.db.prepare('SELECT count(*) AS n FROM desktop_message_runs').get().n,0);
  assert.equal(f.ledger.sends.length,0);assert.equal(f.service.codex.calls.length,0);
  const proof=f.service.runtime.connectionState(f.member.id);
  assert.equal(proof.model_reply_verified,false);assert.equal(proof.automatic_reply_verified,false);
});
