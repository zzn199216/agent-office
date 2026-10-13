'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs');
const {deleteRoom}=require('../src/room-lifecycle.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,now,sleep}=require('../src/util.cjs');

function setup(t,options={}){
  const files=fixture();let service;
  const open=()=>new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:options.fetch||asyncNoNetwork,chat:options.chat||{}});
  service=open();const project=service.addProject({path:files.project,name:'isolated reliability fixture'});
  const room=service.chat.addRoom({project_id:project.id,title:'reliability fixture'}),member=service.chat.addMember({name:'mailbox fixture',adapter:'mailbox'});service.chat.join(room.id,member.id);
  t.after(async()=>{await service.close();const root=path.resolve(files.root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return {...files,project,room,member,get service(){return service;},async restart(){await service.close();service=open();return service;}};
}
async function asyncNoNetwork(){assert.fail('this isolated test must not access a real webhook');}
function evidence(summary='Checked the original fixture session and its final result'){return {summary,source:'fixture://original-session/turn',observed_at:now()};}
function post(v,key='question'){return v.service.chat.post({room_id:v.room.id,to_member_id:v.member.id,text:key,idempotency_key:key});}
function gate(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function until(check){for(let i=0;i<200;i++){if(check())return;await sleep(10);}assert.fail('fixture state did not settle');}
async function webhookMember(v){
  const chat=v.service.chat,m=chat.addMember({name:'webhook fixture',adapter:'grok-bridge'}),invite=await chat.connect(m.id,v.room.id);
  chat.completeInvite(invite.invite.id,invite.invite.nonce,m.id);await chat.configureGrok(m.id,'https://api2.cursor.sh/automations/webhook/isolated-fixture','crsr_fixture_never_sent');return m;
}

test('restart moves both processing and orphaned approvals to review without replaying a native turn',async t=>{
  const v=setup(t),processing=post(v,'processing'),approval=post(v,'approval');
  v.service.chat.store.updateMessage(processing.id,{status:'processing',request_id:'original-turn'});
  v.service.chat.store.updateMessage(approval.id,{status:'waiting_input',request_id:'original-approval-turn'});
  v.service.approvals.set('lost-on-restart',{public:{request_id:approval.id}});
  await v.restart();
  for(const m of [processing,approval]){assert.equal(v.service.chat.store.message(m.id).status,'uncertain');assert.match(v.service.chat.store.message(m.id).error,/核对/);}
  assert.equal(v.service.chat.store.message(processing.id).request_id,'original-turn');assert.equal(v.service.approvals.size,0);
  assert.equal(v.service.codex.calls.length,0);assert.equal(v.service.chat.clients.size,0);assert.equal(v.service.chat.store.inbox(v.member.id).length,0);
});

test('an orphaned approval can be reviewed and durably closed with attributed evidence, never rerun',async t=>{
  const v=setup(t),m=post(v);v.service.chat.store.updateMessage(m.id,{status:'waiting_input'});
  const cancelled=v.service.chat.cancel(m.id);assert.equal(cancelled.status,'uncertain');assert.match(cancelled.error,/无法确认外部/);
  const input={outcome:'completed',evidence:evidence(),answer:'The verified original result'};
  const result=v.service.chat.reconcile(m.id,input);assert.equal(result.message.status,'completed');assert.equal(result.reconciliation.actor,'controller');assert.equal(result.reconciliation.method,'manual_evidence');assert.equal(result.reconciliation.answer,input.answer);
  assert.deepEqual(v.service.chat.reconcile(m.id,input),result);assert.throws(()=>v.service.chat.reconcile(m.id,{...input,evidence:evidence('different evidence')}),{code:'reconciliation_conflict'});
  assert.equal(v.service.chat.store.messages(v.room.id).length,1,'manual evidence must not impersonate a member reply');
  await v.restart();assert.deepEqual(v.service.chat.room(v.room.id).reconciliations[0],result.reconciliation);assert.equal(v.service.codex.calls.length,0);assert.equal(v.service.chat.clients.size,0);
  assert.equal(deleteRoom(v.service,v.room.id).ok,true);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM chat_reconciliations').get().n,1,'deletion retains the audit trail');
});

test('reconciliation refuses missing evidence, future evidence, active executions and known terminal results',t=>{
  const v=setup(t),m=post(v);v.service.chat.store.updateMessage(m.id,{status:'uncertain'});
  for(const input of [{outcome:'completed'},{outcome:'queued',evidence:evidence()},{outcome:'failed',evidence:evidence(),answer:'not a completion'},{outcome:'completed',evidence:{...evidence(),observed_at:'2999-01-01T00:00:00Z'}},{outcome:'completed',evidence:evidence(),force:true}])assert.throws(()=>v.service.chat.reconcile(m.id,input));
  v.service.chat.active.set(v.member.id,{messageId:m.id,roomId:v.room.id});assert.throws(()=>v.service.chat.reconcile(m.id,{outcome:'failed',evidence:evidence()}),{code:'reconciliation_active'});v.service.chat.active.clear();
  const result=v.service.chat.reconcile(m.id,{outcome:'failed',evidence:evidence()});assert.equal(result.message.status,'failed');
  const ordinary=post(v,'ordinary');v.service.chat.store.updateMessage(ordinary.id,{status:'answered'});assert.throws(()=>v.service.chat.reconcile(ordinary.id,{outcome:'cancelled',evidence:evidence()}),{code:'reconciliation_state_invalid'});
  assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM chat_reconciliations').get().n,1);
});

test('creation uncertainty requires explicit audited binding reconciliation and never creates or wakes a session',async t=>{
  const v=setup(t),chat=v.service.chat;chat.store.bind(v.room.id,v.member.id,'creation_uncertain');
  const input={outcome:'not_created',evidence:evidence(),idempotency_key:'verify-no-session'};
  const result=chat.reconcileBinding(v.room.id,v.member.id,input);assert.deepEqual({...result.binding},{thread_id:null,binding_state:'new'});assert.deepEqual(chat.reconcileBinding(v.room.id,v.member.id,input),result);
  chat.store.bind(v.room.id,v.member.id,'creation_uncertain');
  const known=id(),bound=chat.reconcileBinding(v.room.id,v.member.id,{outcome:'bound',thread_id:known,evidence:evidence(),idempotency_key:'verify-original'});assert.equal(bound.binding.thread_id,known);
  chat.store.bind(v.room.id,v.member.id,'resume_uncertain');assert.throws(()=>chat.reconcileBinding(v.room.id,v.member.id,{outcome:'not_created',evidence:evidence(),idempotency_key:'cannot-clear-known'}),{code:'reconciliation_binding_mismatch'});
  assert.throws(()=>chat.reconcileBinding(v.room.id,v.member.id,{outcome:'bound',thread_id:id(),evidence:evidence(),idempotency_key:'cannot-swap-known'}),{code:'reconciliation_binding_mismatch'});
  chat.reconcileBinding(v.room.id,v.member.id,{outcome:'bound',thread_id:known,evidence:evidence(),idempotency_key:'verify-resume'});
  await v.restart();assert.equal(v.service.chat.store.binding(v.room.id,v.member.id).thread_id,known);assert.equal(v.service.chat.clients.size,0);assert.equal(v.service.codex.calls.length,0);assert.equal(deleteRoom(v.service,v.room.id).ok,true);
});

test('manual bridge reconciliation closes the correlated uncertain entry while preserving native return verification',t=>{
  const v=setup(t),s=v.service,origin=s.chat.addMember({name:'origin',adapter:'mailbox'});s.chat.join(v.room.id,origin.id);
  const binding=s.bridge.store.bind({member_id:origin.id,room_id:v.room.id,provider:'grok-bot',conversation_ref:'fixture-original-group'});
  const entry=s.bridge.store.submit({binding_id:binding.id,external_message_id:'source-message',target_member_id:v.member.id,text:'original bridge question'});
  const m=s.chat.store.post({room_id:v.room.id,sender_id:origin.id,to_member_id:v.member.id,text:'original bridge question',idempotency_key:'bridge-original'});s.bridge.store.setMessage(entry.id,m.id);s.bridge.store.updateEntry(entry.id,{status:'uncertain'});s.chat.store.updateMessage(m.id,{status:'uncertain'});
  assert.throws(()=>s.chat.reconcile(m.id,{outcome:'completed',evidence:evidence()}),{code:'reconciliation_answer_required'});
  const checked=s.chat.reconcile(m.id,{outcome:'completed',evidence:evidence(),answer:'Verified original native answer'}),recovered=s.bridge.entry(entry.id);
  assert.equal(recovered.status,'answered');assert.equal(recovered.response_text,checked.reconciliation.answer);assert.equal(recovered.native_delivery_receipt,null);assert.equal(recovered.return_verification,'unverified');assert.equal(s.chat.store.messages(v.room.id).length,1);assert.equal(deleteRoom(s,v.room.id).ok,true);
});

test('room approvals are independent of history pagination and connection approvals retain their exact room',t=>{
  const v=setup(t),s=v.service,first=post(v,'requires approval');s.chat.store.updateMessage(first.id,{status:'waiting_input'});
  s.approvals.set('first',{public:{id:'first',request_id:first.id,type:'input'}});
  const all=[first];for(let i=0;i<205;i++)all.push(s.chat.store.post({room_id:v.room.id,text:'history '+i,idempotency_key:'history-'+i}));
  const other=s.chat.addRoom({project_id:v.project.id,title:'other room'});s.chat.join(other.id,v.member.id);s.chat.active.set(v.member.id,{roomId:other.id,connecting:true});s.approvals.set('connect',{public:{id:'connect',request_id:'connect:'+v.member.id}});
  const latest=s.chat.room(v.room.id);assert.equal(latest.messages.length,200);assert.equal(latest.messages.some(x=>x.id===first.id),false);assert.deepEqual(latest.approvals.map(x=>x.id),['first']);assert.equal(latest.pagination.has_more,true);
  const previous=s.chat.room(v.room.id,{before_seq:latest.pagination.next_before_seq});assert.deepEqual([...previous.messages,...latest.messages].map(x=>x.id),all.map(x=>x.id));assert.equal(previous.pagination.has_more,false);assert.deepEqual(s.chat.room(other.id).approvals.map(x=>x.id),['connect']);
  assert.deepEqual(s.chat.store.messages(v.room.id,{before_seq:latest.pagination.next_before_seq}).map(x=>x.id),previous.messages.map(x=>x.id));
  for(const options of [{before_seq:0},{before_seq:1.5},{limit:1001},{limit:0}])assert.throws(()=>s.chat.room(v.room.id,options));
  s.chat.active.clear();s.approvals.clear();
});

test('webhook recipients can immediately read and reply before HTTP acceptance without duplicate notification',async t=>{
  let v,calls=0,observed;
  v=setup(t,{fetch:async(_url,options)=>{calls++;const payload=JSON.parse(options.body),chat=v.service.chat;observed=chat.inbox(payload.member_id,payload.room_id).map(m=>m.id);chat.ack(payload.message_id,payload.member_id);chat.reply(payload.message_id,payload.member_id,'immediate actual reply','early-reply');return {ok:true,json:async()=>({success:true})};}});
  const m=await webhookMember(v),input={room_id:v.room.id,to_member_id:m.id,text:'read immediately',idempotency_key:'immediate'};
  const q=v.service.chat.post(input);await until(()=>!v.service.chat.notifications.size);
  assert.deepEqual(observed,[q.id]);assert.equal(v.service.chat.store.message(q.id).status,'answered');assert.equal(v.service.chat.store.notification(q.id).status,'accepted');assert.equal(v.service.chat.post(input).id,q.id);assert.equal(calls,1);
  await v.restart();v.service.chat.post(input);assert.equal(calls,1);assert.equal(v.service.chat.store.message(q.id).status,'answered');
});

test('concurrent retries claim only one webhook and deletion waits for the outstanding HTTP result',async t=>{
  const release=gate();let calls=0;const v=setup(t,{fetch:async()=>{calls++;await release.promise;return {ok:true,json:async()=>({success:true})};}}),m=await webhookMember(v);
  const input={room_id:v.room.id,to_member_id:m.id,text:'single notification',idempotency_key:'single-notify'},q=v.service.chat.post(input);
  for(let i=0;i<5;i++)assert.equal(v.service.chat.post(input).id,q.id);assert.equal(calls,1);assert.equal(v.service.chat.store.inbox(m.id)[0].id,q.id);
  v.service.chat.reply(q.id,m.id,'finished before HTTP response','early-answer');assert.throws(()=>deleteRoom(v.service,v.room.id),{code:'room_busy'});
  release.resolve();await until(()=>!v.service.chat.notifications.size);assert.equal(v.service.chat.store.message(q.id).status,'answered');assert.equal(deleteRoom(v.service,v.room.id).ok,true);
});

test('a persisted interrupted notification is uncertain after restart and is never sent again',async t=>{
  let calls=0;const v=setup(t,{fetch:async()=>{calls++;assert.fail('interrupted notifications must not be replayed');}}),m=await webhookMember(v);
  const input={room_id:v.room.id,to_member_id:m.id,text:'crash before notification outcome',idempotency_key:'persisted-notify'},q=v.service.chat.store.post(input);assert.equal(v.service.chat.store.claimNotification(q.id),true);assert.equal(v.service.chat.store.claimNotification(q.id),false);
  await v.restart();assert.equal(v.service.chat.store.notification(q.id).status,'uncertain');assert.equal(v.service.chat.store.message(q.id).status,'uncertain');assert.equal(v.service.chat.post(input).id,q.id);assert.equal(calls,0);
  const checked=v.service.chat.reconcile(q.id,{outcome:'cancelled',evidence:evidence()});assert.equal(checked.message.status,'cancelled');assert.equal(deleteRoom(v.service,v.room.id).ok,true);
});

test('stopping an in-flight notification keeps the outcome uncertain rather than claiming external execution stopped',async t=>{
  const release=gate(),v=setup(t,{fetch:async()=>{await release.promise;return {ok:true,json:async()=>({success:true})};}}),m=await webhookMember(v);
  const q=v.service.chat.post({room_id:v.room.id,to_member_id:m.id,text:'external state not yet known',idempotency_key:'cancel-notify'});
  assert.equal(v.service.chat.cancel(q.id).status,'uncertain');assert.throws(()=>v.service.chat.reconcile(q.id,{outcome:'cancelled',evidence:evidence()}),{code:'reconciliation_active'});
  release.resolve();await until(()=>!v.service.chat.notifications.size);assert.equal(v.service.chat.store.message(q.id).status,'uncertain');assert.equal(v.service.chat.store.notification(q.id).status,'accepted');
});

test('direct and indirect collaboration cycles are rejected before insertion while replies and completed dependencies remain usable',t=>{
  const v=setup(t),chat=v.service.chat,a=v.member,b=chat.addMember({name:'B',adapter:'mailbox'}),c=chat.addMember({name:'C',adapter:'mailbox'});chat.join(v.room.id,b.id);chat.join(v.room.id,c.id);
  const ab=chat.post({room_id:v.room.id,sender_id:a.id,to_member_id:b.id,text:'A needs B',idempotency_key:'ab'});
  assert.throws(()=>chat.post({room_id:v.room.id,sender_id:b.id,to_member_id:a.id,text:'B needs A clarification',idempotency_key:'ba'}),{code:'collaboration_cycle'});
  chat.post({room_id:v.room.id,sender_id:b.id,to_member_id:c.id,text:'B needs C',idempotency_key:'bc'});
  assert.throws(()=>chat.post({room_id:v.room.id,sender_id:c.id,to_member_id:a.id,text:'C needs A',idempotency_key:'ca'}),{code:'collaboration_cycle'});assert.equal(chat.store.messages(v.room.id).length,2);
  assert.equal(chat.post({room_id:v.room.id,sender_id:a.id,to_member_id:b.id,text:'A needs B',idempotency_key:'ab'}).id,ab.id,'original request retries remain idempotent');
  chat.reply(ab.id,b.id,'B answered A','answer-ab');assert.equal(chat.post({room_id:v.room.id,sender_id:b.id,to_member_id:a.id,text:'new independent question',idempotency_key:'ba-after-answer'}).status,'queued');
});

test('waiting on a legacy circular dependency fails immediately instead of holding an active native turn',async t=>{
  const v=setup(t),chat=v.service.chat,b=chat.addMember({name:'B',adapter:'mailbox'});chat.join(v.room.id,b.id);
  const ab=chat.store.post({room_id:v.room.id,sender_id:v.member.id,to_member_id:b.id,text:'old A to B',idempotency_key:'old-ab'});
  chat.store.post({room_id:v.room.id,sender_id:b.id,to_member_id:v.member.id,text:'old B to A',idempotency_key:'old-ba'});
  await assert.rejects(chat.wait(ab.id,25,v.member.id),{code:'collaboration_cycle'});assert.equal(chat.clients.size,0);assert.equal(chat.store.message(ab.id).status,'queued');
});

test('retrying an original question cannot acquire a new active parent or bypass input validation',t=>{
  const v=setup(t),chat=v.service.chat,b=chat.addMember({name:'B',adapter:'mailbox'});chat.join(v.room.id,b.id);
  const input={room_id:v.room.id,sender_id:v.member.id,to_member_id:b.id,text:'independent question',idempotency_key:'original-no-parent'},original=chat.post(input),other=post(v,'later user question');
  chat.active.set(v.member.id,{messageId:other.id,roomId:v.room.id});
  try{const retry=chat.post({...input,idempotency_key:'  original-no-parent  '});assert.equal(retry.id,original.id);assert.equal(retry.reply_to,null);assert.throws(()=>chat.post({...input,idempotency_key:undefined}),{code:'invalid_request'});}finally{chat.active.clear();}
});

test('unchanged exports do no full-history rewrites, while direct store changes and failures remain durable',async t=>{
  const v=setup(t),chat=v.service.chat,other=chat.addRoom({project_id:v.project.id,title:'unchanged export'}),file=path.join(v.data,'chatrooms',v.room.id,'conversation.md'),otherFile=path.join(v.data,'chatrooms',other.id,'conversation.md');
  const old=new Date('2020-01-01T00:00:00Z');fs.utimesSync(file,old,old);fs.utimesSync(otherFile,old,old);chat.changed();chat.exportRooms();assert.equal(fs.statSync(file).mtimeMs,old.valueOf());assert.equal(fs.statSync(otherFile).mtimeMs,old.valueOf());
  chat.store.post({room_id:v.room.id,sender_id:v.member.id,text:'durable direct write',idempotency_key:'export-direct'});assert.deepEqual(chat.store.pendingExports().map(x=>x.room_id),[v.room.id]);
  const originalRename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===file)throw new Error('isolated export write failure');return originalRename(from,to);};try{chat.exportRooms();}finally{fs.renameSync=originalRename;}
  assert.match(chat.exportError,/暂未写入/);assert.equal(chat.store.pendingExports().length,1);chat.exportRooms();assert.equal(chat.exportError,null);assert.equal(chat.store.pendingExports().length,0);assert.match(fs.readFileSync(file,'utf8'),/durable direct write/);assert.equal(fs.statSync(otherFile).mtimeMs,old.valueOf());
  chat.store.updateMember(v.member.id,{name:'renamed historical author'});chat.exportRooms();assert.match(fs.readFileSync(file,'utf8'),/renamed historical author/);
  fs.utimesSync(file,old,old);await v.restart();v.service.chat.exportRooms();assert.equal(fs.statSync(file).mtimeMs,old.valueOf(),'unchanged restart does not rewrite exports');
});

test('room deletion refuses live team goals, tasks, meetings and outbox work while retaining completed evidence',t=>{
  const v=setup(t),db=v.service.store.db;
  db.exec('CREATE TABLE IF NOT EXISTS team_records(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS team_outbox(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,recipient_id TEXT NOT NULL,record_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,body TEXT NOT NULL,message_id TEXT,status TEXT NOT NULL,error TEXT);');
  for(const [kind,status]of [['goal','active'],['task','queued'],['task','uncertain'],['meeting','collecting'],['meeting','review']]){
    const recordId=id();db.prepare('INSERT INTO team_records VALUES(?,?,?,?,?,?,?)').run(recordId,v.room.id,kind,recordId,JSON.stringify({status,evidence:['preserve']}),1,now());assert.throws(()=>deleteRoom(v.service,v.room.id),{code:'room_busy'});db.prepare('UPDATE team_records SET body=? WHERE id=?').run(JSON.stringify({status:'completed',evidence:['preserve']}),recordId);
  }
  const outbox=id();db.prepare('INSERT INTO team_outbox VALUES(?,?,?,?,?,?,?,?,?)').run(outbox,v.room.id,v.member.id,'fixture-record','fixture-event','fixture',null,'pending',null);assert.throws(()=>deleteRoom(v.service,v.room.id),{code:'room_busy'});db.prepare("UPDATE team_outbox SET status='failed' WHERE id=?").run(outbox);
  assert.equal(deleteRoom(v.service,v.room.id).ok,true);assert.equal(db.prepare('SELECT count(*) n FROM team_records').get().n,5);assert.equal(db.prepare('SELECT count(*) n FROM team_outbox').get().n,1);
});
