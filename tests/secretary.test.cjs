'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{offlineState}=require('../src/desktop-state.cjs');
const {assertEntryScope,openDisk}=require('../src/entry.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id}=require('../src/util.cjs');
const {firstTaskKey,SECRETARY_INSTRUCTIONS}=require('../src/secretary.cjs');

function removeFixture(root){const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});}
function harness(t){
  const f=fixture(),codex=new FakeCodex(),service=new RoomService(f.data,{codex,vault:new FakeVault(),fetch:async()=>{throw new Error('No upstream request is authorized by this test fixture.');}});let closed=false;
  t.after(async()=>{if(!closed)await service.close();removeFixture(f.root);});
  const project=service.addProject({path:f.project,name:'AI secretary protocol fixture'}),room=service.chat.addRoom({title:'First office',project_id:project.id}),other=service.chat.addRoom({title:'Second office',project_id:project.id});
  const member=service.chat.addMember({name:'Mailbox secretary',adapter:'mailbox'});service.chat.join(room.id,member.id);
  return {...f,service,codex,room,other,member,close:async()=>{if(!closed){await service.close();closed=true;}}};
}
function businessState(service){return Object.fromEntries(['projects','discussions','requests','deliveries','chat_rooms','chat_members','chat_participants','chat_bindings','chat_messages','chat_resume_credentials','runtime_adapter_capabilities'].map(table=>[table,service.store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));}
function allRows(dir){const db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>[row.name,db.prepare('SELECT * FROM "'+row.name+'" ORDER BY rowid').all()]));}finally{db.close();}}
async function verifiedMailbox(h,member=h.member,room=h.room){const setup=await h.service.chat.connect(member.id,room.id),result=h.service.chat.completeInvite(setup.invite.id,setup.invite.nonce,member.id);assert.equal(result.ok,true);assert.equal(result.member.status,'ready');return result.member;}

test('secretary selection is a persisted room role, never an implicit handshake, scan, installation or model task',async t=>{
  const h=harness(t),entry=h.service.entry.issue(h.member.id,h.room.id),entryBytes=fs.readFileSync(entry.file),before=businessState(h.service);
  h.service.chat.discover=()=>{throw new Error('GET or selection must not scan');};h.service.launch.scan=()=>{throw new Error('GET or selection must not scan');};
  h.service.runtimeInstaller.install=()=>{throw new Error('Role selection must not install');};h.service.chat.connect=()=>{throw new Error('Role selection must not connect');};
  assert.deepEqual(h.service.secretary.get(h.room.id),{room_id:h.room.id,member_id:null,assignment_id:null,status:'unassigned',can_wake:false});
  const role=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});assert.deepEqual(role,{room_id:h.room.id,member_id:h.member.id,assignment_id:role.assignment_id,status:'awaiting_connection',name:h.member.name,can_wake:false});assert.match(role.assignment_id,/^[a-f0-9-]{36}$/i);
  for(let n=0;n<3;n++){assert.deepEqual(h.service.secretary.get(h.room.id),role);assert.deepEqual(h.service.snapshot().secretaries[h.room.id],role);}
  assert.equal(h.service.secretary.get(h.other.id).status,'unassigned');assert.deepEqual(businessState(h.service),before);assert.deepEqual(fs.readFileSync(entry.file),entryBytes);assert.equal(h.codex.calls.length,0);assert.equal(h.service.onboarding.jobs.size,0);
  await h.close();const savedRows=allRows(h.data),offline=offlineState(h.data,h.room.id);assert.deepEqual(offline.snapshot.secretaries[h.room.id],role);assert.equal(offline.snapshot.secretaries[h.other.id].status,'unassigned');assert.deepEqual(allRows(h.data),savedRows);
  const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{assert.deepEqual(reopened.secretary.get(h.room.id),role);assert.equal(reopened.chat.room(h.room.id).messages.length,0);}finally{await reopened.close();}
});

test('only a ready verified participant can receive a first task; textual readiness alone does not suffice',async t=>{
  const h=harness(t);assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'Plan the office'}),e=>e.code==='secretary_unassigned');
  h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});
  for(const state of ['awaiting_handshake','connecting','ready']){h.service.chat.store.updateMember(h.member.id,{status:state,verified_at:null});assert.equal(h.service.secretary.get(h.room.id).status,'awaiting_connection');assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'Plan the office'}),e=>e.code==='secretary_not_ready');}
  assert.equal(h.service.chat.room(h.room.id).messages.length,0);await verifiedMailbox(h);assert.equal(h.service.secretary.get(h.room.id).status,'ready');assert.equal(h.service.secretary.get(h.room.id).can_wake,false);
  const result=h.service.secretary.start({room_id:h.room.id,goal:'  Help organize my existing project  '});assert.equal(result.message.sender_id,'user');assert.equal(result.message.to_member_id,h.member.id);assert.equal(result.message.status,'queued');assert.equal(result.secretary.request_id,result.message.id);assert.equal(result.secretary.goal,'Help organize my existing project');assert.equal(result.secretary.message_status,'queued');assert.deepEqual(result.secretary.response_ids,[]);
  assert.equal(h.service.chat.store.inbox(h.member.id,h.room.id)[0].id,result.message.id);assert.match(result.message.text,/用户的办公室目标：\nHelp organize/);assert.ok(result.message.text.startsWith(SECRETARY_INSTRUCTIONS));assert.match(result.message.text,/不因秘书身份获得安装或群管理权限/);assert.match(result.message.text,/由用户点选实际操作/);assert.equal(h.codex.calls.length,0);
});

test('duplicate first tasks reuse their accepted message across retries and restarts, including uncertain outcomes',async t=>{
  const h=harness(t);await verifiedMailbox(h);h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});
  let dispatches=0;const originalPost=h.service.chat.post.bind(h.service.chat);h.service.chat.post=input=>{dispatches++;return originalPost(input);};
  const first=h.service.secretary.start({room_id:h.room.id,goal:'Organize the release'}),retry=h.service.secretary.start({room_id:h.room.id,goal:'  Organize the release  '});assert.equal(retry.message.id,first.message.id);assert.equal(dispatches,1);assert.equal(h.service.chat.room(h.room.id).messages.length,1);
  h.service.chat.store.updateMessage(first.message.id,{status:'uncertain',error:'fixture delivery outcome unknown'});assert.equal(h.service.secretary.start({room_id:h.room.id,goal:'Organize the release'}).message.status,'uncertain');assert.equal(dispatches,1);
  await h.close();const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{reopened.chat.post=()=>{throw new Error('Retry must read the existing task, not dispatch it.');};const after=reopened.secretary.start({room_id:h.room.id,goal:'Organize the release'});assert.equal(after.message.id,first.message.id);assert.equal(after.message.status,'uncertain');assert.equal(reopened.chat.room(h.room.id).messages.length,1);}finally{await reopened.close();}
});

test('actual correlated secretary replies are exposed without attributing other messages or room announcements as answers',async t=>{
  const h=harness(t);await verifiedMailbox(h);h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});const task=h.service.secretary.start({room_id:h.room.id,goal:'Decide AI roles'}),peer=h.service.chat.addMember({name:'Another mailbox',adapter:'mailbox'});h.service.chat.join(h.room.id,peer.id);
  h.service.chat.post({room_id:h.room.id,sender_id:'user',text:'response_ids: [made-up]',reply_to:task.message.id,kind:'reply',idempotency_key:'not-secretary-user-reply'});
  h.service.chat.post({room_id:h.room.id,sender_id:peer.id,text:'This is a peer response',reply_to:task.message.id,kind:'reply',idempotency_key:'not-secretary-peer-reply'});
  h.service.chat.post({room_id:h.room.id,sender_id:h.member.id,text:'An unrelated announcement',idempotency_key:'not-secretary-announcement'});
  assert.deepEqual(h.service.secretary.get(h.room.id).response_ids,[]);
  const answer=h.service.chat.reply(task.message.id,h.member.id,'Start by defining a development role and review role.','actual-secretary-answer');assert.deepEqual(h.service.secretary.get(h.room.id).response_ids,[answer.id]);assert.equal(h.service.secretary.get(h.room.id).message_status,'answered');
});

test('changing or clearing secretary never removes members, switches another room role or cancels an accepted task',async t=>{
  const h=harness(t);await verifiedMailbox(h);h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});h.service.chat.join(h.other.id,h.member.id);h.service.secretary.set({room_id:h.other.id,member_id:h.member.id});
  const task=h.service.secretary.start({room_id:h.room.id,goal:'Prepare a project outline'}),before=businessState(h.service),other=h.service.secretary.get(h.other.id);
  const reset=h.service.secretary.set({room_id:h.room.id,reset:true});assert.equal(reset.member_id,null);assert.equal(reset.status,'unassigned');assert.equal(reset.can_wake,false);assert.equal(reset.request_id,task.message.id);assert.equal(reset.message_status,'queued');assert.deepEqual(businessState(h.service),before);assert.deepEqual(h.service.secretary.get(h.other.id),other);
  const next=h.service.chat.addMember({name:'Next secretary',adapter:'mailbox'});h.service.chat.join(h.room.id,next.id);const selected=h.service.secretary.set({room_id:h.room.id,member_id:next.id});assert.equal(selected.member_id,next.id);assert.equal(selected.request_id,undefined);assert.equal(h.service.chat.store.message(task.message.id).to_member_id,h.member.id);assert.equal(h.service.chat.store.message(task.message.id).status,'queued');
});

test('capabilities reflect real runtime state and offline reading never advertises wake; leaving makes the role unavailable',async t=>{
  const h=harness(t);await verifiedMailbox(h);h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});assert.equal(h.service.secretary.get(h.room.id).can_wake,false);
  h.service.runtime.configureWakeAdapter('mailbox',true);assert.equal(h.service.secretary.get(h.room.id).can_wake,true);const ready=h.service.secretary.get(h.room.id);await h.close();const before=allRows(h.data),offline=offlineState(h.data,h.room.id);assert.deepEqual(offline.snapshot.secretaries[h.room.id],{...ready,can_wake:false});assert.deepEqual(allRows(h.data),before);
  const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{reopened.chat.leave(h.room.id,h.member.id);assert.equal(reopened.secretary.get(h.room.id).status,'unavailable');assert.equal(reopened.secretary.get(h.room.id).can_wake,false);assert.throws(()=>reopened.secretary.start({room_id:h.room.id,goal:'A task after leaving'}),e=>e.code==='secretary_not_ready');assert.equal(reopened.chat.room(h.room.id).messages.length,0);}finally{await reopened.close();}
});

test('unknown identities, outsiders and executable or privilege fields reject without any partial writes',async t=>{
  const h=harness(t),outside=h.service.chat.addMember({name:'Not in this room',adapter:'mailbox'}),before=allRows(h.data),revision=h.service.revision;
  for(const patch of [{room_id:id(),member_id:h.member.id},{member_id:id()},{member_id:outside.id},{member_id:null},{member_id:h.member.id,reset:true},{member_id:h.member.id,reset:'yes'},{member_id:h.member.id,can_wake:true},{member_id:h.member.id,install:true},{member_id:h.member.id,executable:'C:\\unknown.exe'},{member_id:h.member.id,goal:'Implicit task'}])assert.throws(()=>h.service.secretary.set({room_id:h.room.id,...patch}));
  for(const input of [{goal:''},{goal:' '.repeat(2)},{goal:'a'.repeat(4001)},{goal:'nul\0text'},{goal:'Plan',sender_id:'trusted-agent'},{goal:'Plan',member_id:h.member.id},{goal:'Plan',install_clients:true},{goal:'Plan',expected_member_id:null},{goal:'Plan',expected_assignment_id:7}])assert.throws(()=>h.service.secretary.start({room_id:h.room.id,...input}));
  assert.deepEqual(allRows(h.data),before);assert.equal(h.service.revision,revision);assert.equal(h.codex.calls.length,0);
});

test('secretary HTTP is controller-only and member recovery cards do not grant secretary configuration or delegation',async t=>{
  const h=harness(t);await verifiedMailbox(h);const token=id(),server=createServer(h.service,{token,port:0}),port=await server.listen();t.after(()=>server.close());const url='http://127.0.0.1:'+port,entry=h.service.entry.issue(h.member.id,h.room.id),card=JSON.parse(fs.readFileSync(entry.file,'utf8'));
  const request=(route,auth,input)=>fetch(url+route,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...input===undefined?{}:{body:JSON.stringify(input)}});
  for(const auth of ['',card.secret])for(const [route,input]of [['/api/secretary?room_id='+h.room.id,undefined],['/api/secretary',{room_id:h.room.id,member_id:h.member.id}],['/api/secretary/start',{room_id:h.room.id,goal:'Untrusted task'}]])assert.equal((await request(route,auth,input)).status,401);
  const selected=await request('/api/secretary',token,{room_id:h.room.id,member_id:h.member.id});assert.equal(selected.status,200);assert.equal((await selected.json()).status,'ready');
  const first=await request('/api/secretary/start',token,{room_id:h.room.id,goal:'Help me define priorities'});assert.equal(first.status,202);const result=await first.json();assert.equal(result.message.sender_id,'user');assert.equal(result.message.id,result.secretary.request_id);
  const state=await request('/api/state',token);assert.equal((await state.json()).secretaries[h.room.id].request_id,result.message.id);
  const disk=openDisk(h.data,{readOnly:true});try{for(const route of ['/api/secretary','/api/secretary/start'])assert.throws(()=>assertEntryScope(disk,card,route,{room_id:h.room.id,goal:'not authorized'}),e=>e.code==='resume_scope_mismatch');}finally{disk.close();}
  assert.equal(require('../src/mcp.cjs').tools.some(tool=>/secretary/.test(tool.name)),false);
});

test('corrupt saved role pointers recover as pure metadata without exposing unrelated message text or credential fields',async t=>{
  const h=harness(t);h.service.store.setting('secretary.'+h.room.id,{member_id:h.member.id,request_id:id(),goal:'Bearer test-secret',credential:'never expose',executable:'never expose'});const before=allRows(h.data);
  const role=h.service.secretary.get(h.room.id);assert.equal(role.status,'awaiting_connection');assert.equal(role.request_id,undefined);assert.equal(role.goal,'Bearer [密钥已隐藏]');assert.equal(role.credential,undefined);assert.equal(role.executable,undefined);assert.deepEqual(allRows(h.data),before);
  h.service.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run('not valid JSON','secretary.'+h.room.id);assert.deepEqual(h.service.secretary.get(h.room.id),{room_id:h.room.id,member_id:null,assignment_id:null,status:'unassigned',can_wake:false});
  assert.equal(firstTaskKey(h.room.id,h.member.id,'goal').length<200,true);
});

test('a stale window cannot delegate to a secretary changed by another window',async t=>{
  const h=harness(t),next=h.service.chat.addMember({name:'Secretary chosen in window B',adapter:'mailbox'});await verifiedMailbox(h);await verifiedMailbox(h,next);
  const inA=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id}),inB=h.service.secretary.set({room_id:h.room.id,member_id:next.id});assert.notEqual(inA.assignment_id,inB.assignment_id);
  const before=allRows(h.data);let posts=0;h.service.chat.post=()=>{posts++;throw new Error('A stale assignment must not reach message dispatch.');};
  assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'A intended to ask the previous secretary',expected_member_id:inA.member_id,expected_assignment_id:inA.assignment_id}),e=>e.status===409&&e.code==='secretary_selection_changed');
  assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'An old member expectation',expected_member_id:inA.member_id}),e=>e.code==='secretary_selection_changed');
  assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'An old assignment expectation',expected_assignment_id:inA.assignment_id}),e=>e.code==='secretary_selection_changed');
  assert.equal(posts,0);assert.equal(h.service.chat.room(h.room.id).messages.length,0);assert.deepEqual(allRows(h.data),before);
});

test('reset then reselecting the same member changes the assignment and rejects stale requests without resending',async t=>{
  const h=harness(t);await verifiedMailbox(h);const selected=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id}),task=h.service.secretary.start({room_id:h.room.id,goal:'An accepted goal',expected_member_id:selected.member_id,expected_assignment_id:selected.assignment_id});
  const reset=h.service.secretary.set({room_id:h.room.id,reset:true});assert.notEqual(reset.assignment_id,selected.assignment_id);assert.equal(reset.request_id,task.message.id);
  assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'An accepted goal',expected_member_id:selected.member_id,expected_assignment_id:selected.assignment_id}),e=>e.code==='secretary_selection_changed');
  const again=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});assert.notEqual(again.assignment_id,selected.assignment_id);assert.notEqual(again.assignment_id,reset.assignment_id);
  const before=allRows(h.data);assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'An accepted goal',expected_member_id:selected.member_id,expected_assignment_id:selected.assignment_id}),e=>e.code==='secretary_selection_changed');assert.deepEqual(allRows(h.data),before);
  let posts=0;h.service.chat.post=()=>{posts++;throw new Error('Same goal must reuse its already accepted message.');};const reused=h.service.secretary.start({room_id:h.room.id,goal:'An accepted goal',expected_member_id:again.member_id,expected_assignment_id:again.assignment_id});assert.equal(reused.message.id,task.message.id);assert.equal(reused.secretary.assignment_id,again.assignment_id);assert.equal(posts,0);
});

test('matching assignments persist across tasks, same-member selection and restart with one dispatch',async t=>{
  const h=harness(t);await verifiedMailbox(h);const selected=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id}),same=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});assert.equal(same.assignment_id,selected.assignment_id);
  let posts=0;const post=h.service.chat.post.bind(h.service.chat);h.service.chat.post=input=>{posts++;return post(input);};const input={room_id:h.room.id,goal:'Start planning',expected_member_id:selected.member_id,expected_assignment_id:selected.assignment_id},first=h.service.secretary.start(input),again=h.service.secretary.start(input);assert.equal(posts,1);assert.equal(again.message.id,first.message.id);assert.equal(again.secretary.assignment_id,selected.assignment_id);
  await h.close();const offline=offlineState(h.data,h.room.id);assert.equal(offline.snapshot.secretaries[h.room.id].assignment_id,selected.assignment_id);
  const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{reopened.chat.post=()=>{throw new Error('Matching retry after restart must not dispatch again.');};assert.equal(reopened.secretary.start(input).message.id,first.message.id);assert.equal(reopened.secretary.get(h.room.id).assignment_id,selected.assignment_id);}finally{await reopened.close();}
});

test('legacy assignments have a stable read-only identity and receive a fresh UUID only on explicit selection',async t=>{
  const h=harness(t);await verifiedMailbox(h);h.service.store.setting('secretary.'+h.room.id,{member_id:h.member.id});const before=allRows(h.data),legacy=h.service.secretary.get(h.room.id);assert.match(legacy.assignment_id,/^legacy:[a-f0-9]{64}$/);assert.equal(h.service.secretary.get(h.room.id).assignment_id,legacy.assignment_id);assert.equal(h.service.snapshot().secretaries[h.room.id].assignment_id,legacy.assignment_id);assert.deepEqual(allRows(h.data),before);
  const migrated=h.service.secretary.set({room_id:h.room.id,member_id:h.member.id});assert.match(migrated.assignment_id,/^[a-f0-9-]{36}$/i);assert.notEqual(migrated.assignment_id,legacy.assignment_id);assert.throws(()=>h.service.secretary.start({room_id:h.room.id,goal:'Old UI selection',expected_member_id:legacy.member_id,expected_assignment_id:legacy.assignment_id}),e=>e.code==='secretary_selection_changed');assert.equal(h.service.chat.room(h.room.id).messages.length,0);
});
