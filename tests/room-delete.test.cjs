'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {deleteRoom,deletionPreview,forceDeleteRoom}=require('../src/room-lifecycle.cjs');
const {openDisk,readEntry,assertEntryScope}=require('../src/entry.cjs');
const {createRecoveringApi}=require('../src/main.cjs');
const {createQwenMcpConfig}=require('../src/mcp-http.cjs');
const {id,now}=require('../src/util.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');

function setup(t){
  const files=fixture(),options={codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw new Error('fixture prohibits external traffic');}};
  let service=new RoomService(files.data,options);
  const project=service.addProject({name:'room deletion fixture',path:files.project});
  const room=service.chat.addRoom({title:'delete only this local room',project_id:project.id});
  const other=service.chat.addRoom({title:'keep this room',project_id:project.id});
  const shared=service.chat.addMember({name:'shared fixture member',adapter:'mailbox'});
  service.chat.join(room.id,shared.id);service.chat.join(other.id,shared.id);
  t.after(async()=>{await service.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {...files,project,room,other,shared,get service(){return service;},async restart(){await service.close();service=new RoomService(files.data,{...options,codex:new FakeCodex()});return service;}};
}
function immutableRows(db,table){return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();}
test('confirmed Windows stop terminates only the owned process tree, including a spawned task', {skip:process.platform!=='win32'},async t=>{
  const {spawn}=require('node:child_process'),{stopOwnedChildTree}=require('../src/room-lifecycle.cjs'),{livePid,sleep}=require('../src/util.cjs');
  const parent=spawn(process.execPath,['-e',"const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']}),other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  t.after(()=>{stopOwnedChildTree(parent);stopOwnedChildTree(other);});
  const grandchild=await new Promise(resolve=>parent.stdout.once('data',data=>resolve(Number(String(data).trim()))));assert.ok(livePid(grandchild));assert.ok(livePid(other.pid));stopOwnedChildTree(parent);
  for(let i=0;i<20&&(livePid(parent.pid)||livePid(grandchild));i++)await sleep(50);
  assert.equal(livePid(parent.pid),false);assert.equal(livePid(grandchild),false);assert.equal(livePid(other.pid),true);
});

test('preview is read-only; confirmed force deletion cancels all room work atomically and retains external uncertainty',async t=>{
  const v=setup(t),s=v.service,c=s.chat.store,db=s.store.db,stamp=now();
  const queued=c.post({room_id:v.room.id,to_member_id:v.shared.id,text:'排队任务',idempotency_key:'queued'}),uncertain=c.post({room_id:v.room.id,to_member_id:v.shared.id,text:'外部结果待核对',idempotency_key:'uncertain'});
  c.updateMessage(uncertain.id,{status:'uncertain',request_id:'retained-turn'});c.bind(v.room.id,v.shared.id,'outcome_uncertain','retained-native-thread');
  const keep=c.post({room_id:v.other.id,to_member_id:v.shared.id,text:'其他房间任务',idempotency_key:'keep'});
  const active=new AbortController();let closed=0;s.chat.active.set(v.shared.id,{abort:active,roomId:v.room.id,connecting:true});s.chat.clients.set(v.shared.id,{close:async()=>{closed++;}});
  const launch=id(),onboarding=id(),check=id();
  db.prepare("INSERT INTO launch_sessions(id,room_id,status,goal,candidates,created,updated) VALUES(?,?,'preparing','fixture','[]',?,?)").run(launch,v.room.id,stamp,stamp);
  db.prepare("INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,created,updated) VALUES(?,?,'codex','codex','managed','running','connecting',?,?)").run(onboarding,v.room.id,stamp,stamp);
  db.prepare("INSERT INTO bridge_setup_tests(id,member_id,room_id,status,summary,created,updated) VALUES(?,?,?,'waiting','fixture',?,?)").run(check,v.shared.id,v.room.id,stamp,stamp);
  const goal=s.team.create('goal',v.room.id,'fixture-goal',{title:'待完成目标',status:'active'},null);
  const card=s.entry.issue(v.shared.id,v.room.id),old=JSON.parse(fs.readFileSync(card.file,'utf8'));
  const before=immutableRows(db,'chat_messages'),preview=deletionPreview(s,v.room.id);
  assert.deepEqual(immutableRows(db,'chat_messages'),before);assert.equal(active.signal.aborted,false);assert.ok(preview.tasks.some(value=>value.kind==='worker'&&value.status==='connecting'));assert.ok(preview.tasks.some(value=>value.kind==='onboarding'));assert.match(preview.external_warning,/无法保证撤回/);
  const result=await forceDeleteRoom(s,v.room.id,preview.confirmation_token);assert.equal(result.status,'deleted');assert.equal(active.signal.aborted,true);assert.equal(closed,1);s.chat.active.clear();
  for(const msg of [queued,uncertain])assert.equal(db.prepare('SELECT status FROM chat_messages WHERE id=?').get(msg.id).status,'cancelled');
  assert.equal(db.prepare('SELECT request_id FROM chat_messages WHERE id=?').get(uncertain.id).request_id,'retained-turn');assert.equal(db.prepare('SELECT binding_state FROM chat_bindings WHERE room_id=?').get(v.room.id).binding_state,'outcome_uncertain');
  assert.equal(JSON.parse(db.prepare('SELECT body FROM team_records WHERE id=?').get(goal.id).body).status,'cancelled');
  for(const [table,key]of [['launch_sessions',launch],['onboarding_runs',onboarding],['bridge_setup_tests',check]])assert.equal(db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(key).status,'cancelled');
  s.onboarding.set(onboarding,{status:'ready',stage:'completed'});s.bridge.finishTest(check,'passed','late result');assert.equal(db.prepare('SELECT status FROM onboarding_runs WHERE id=?').get(onboarding).status,'cancelled');assert.equal(s.bridge.test(check).status,'cancelled');
  assert.equal(c.message(keep.id).status,'queued');assert.equal(c.joined(v.other.id,v.shared.id),true);assert.equal(s.resume.inspect(old).room_id,v.other.id);
  assert.equal((await forceDeleteRoom(s,v.room.id,preview.confirmation_token)).already_deleted,true);
});

test('force confirmation is room scoped and requires another confirmation only for new tasks',async t=>{
  const v=setup(t),s=v.service,c=s.chat.store,preview=deletionPreview(s,v.room.id);
  await assert.rejects(forceDeleteRoom(s,v.other.id,preview.confirmation_token),{code:'room_delete_confirmation_expired'});
  const message=c.post({room_id:v.room.id,to_member_id:v.shared.id,text:'new work after preview',idempotency_key:'new'});
  await assert.rejects(forceDeleteRoom(s,v.room.id,preview.confirmation_token),{code:'room_delete_tasks_changed'});assert.equal(c.message(message.id).status,'queued');assert.equal(c.room(v.room.id).id,v.room.id);
  const fresh=deletionPreview(s,v.room.id);c.updateMessage(message.id,{status:'answered'});assert.equal((await forceDeleteRoom(s,v.room.id,fresh.confirmation_token)).status,'deleted');
});

test('preview and forced DELETE require controller authority and a matching issued confirmation',async t=>{
  const v=setup(t),s=v.service,token=id(),server=createServer(s,{port:0,token}),port=await server.listen(),base='http://127.0.0.1:'+port,route='/api/chat/rooms/'+v.room.id;t.after(()=>server.close());
  const card=s.resume.issue(v.shared.id,v.room.id).card;for(const credential of [null,card.secret]){const response=await fetch(base+route+'/deletion',{headers:credential?{Authorization:'Bearer '+credential}:{}});assert.equal(response.status,401);}
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'},preview=await(await fetch(base+route+'/deletion',{headers})).json();
  assert.equal(preview.room_id,v.room.id);const message=s.chat.store.post({room_id:v.room.id,to_member_id:v.shared.id,text:'queued after preview',idempotency_key:'new-http'});
  const remove=async(path,value)=>{const response=await fetch(base+path,{method:'DELETE',headers,body:JSON.stringify(value)});return {status:response.status,value:await response.json()};};
  assert.equal((await remove(route,{force:true,confirmation_token:'0'.repeat(48)})).value.code,'room_delete_confirmation_expired');assert.equal((await remove('/api/chat/rooms/'+v.other.id,{force:true,confirmation_token:preview.confirmation_token})).value.code,'room_delete_confirmation_expired');
  assert.equal((await remove(route,{force:true,confirmation_token:preview.confirmation_token})).value.code,'room_delete_tasks_changed');assert.equal(s.chat.store.message(message.id).status,'queued');
  const fresh=await(await fetch(base+route+'/deletion',{headers})).json();assert.equal((await remove(route,{force:true,confirmation_token:fresh.confirmation_token})).status,200);assert.equal(s.chat.store.room(v.other.id).id,v.other.id);
});

test('failed force revocation rolls back cancellation and never aborts the owned worker',async t=>{
  const v=setup(t),s=v.service,c=s.chat.store,db=s.store.db,abort=new AbortController();s.entry.issue(v.shared.id,v.room.id);
  const message=c.post({room_id:v.room.id,to_member_id:v.shared.id,text:'keep on rollback',idempotency_key:'rollback'});s.chat.active.set(v.shared.id,{roomId:v.room.id,abort});const preview=deletionPreview(s,v.room.id);
  db.exec("CREATE TRIGGER fixture_deny_force BEFORE UPDATE ON chat_resume_credentials BEGIN SELECT RAISE(ABORT,'fixture force denied'); END;");
  await assert.rejects(forceDeleteRoom(s,v.room.id,preview.confirmation_token),/fixture force denied/);assert.equal(abort.signal.aborted,false);assert.equal(c.message(message.id).status,'queued');assert.equal(c.room(v.room.id).id,v.room.id);db.exec('DROP TRIGGER fixture_deny_force');s.chat.active.clear();
});

test('late native handshake after confirmed deletion cannot restore availability or publish progress',async t=>{
  const v=setup(t),s=v.service;let release,work;
  s.chat.options.clientFactory=()=>({run:async input=>{work=input;await new Promise(resolve=>release=resolve);input.onBinding('bound','late-thread');input.onProgress('late progress');return {answer:'late answer'};},close:async()=>{release();}});
  const member=s.chat.addMember({name:'late native fixture',adapter:'codex'});await s.chat.connect(member.id,v.room.id);
  const pending=s.chat.connecting.get(v.room.id+':'+member.id),preview=deletionPreview(s,v.room.id);await forceDeleteRoom(s,v.room.id,preview.confirmation_token);await pending;
  assert.ok(work.signal.aborted);assert.equal(s.chat.active.size,0);assert.equal(s.chat.connecting.size,0);assert.equal(s.chat.connectionProgress.size,0);assert.equal(s.chat.connectedMembers.has(member.id),false);assert.notEqual(s.chat.store.member(member.id).status,'ready');assert.deepEqual(s.chat.store.rooms().map(value=>value.id),[v.other.id]);
});

test('force deletion stops the owned running turn and ignores late output while another room keeps running',async t=>{
  const v=setup(t),s=v.service,c=s.chat.store;let release,input,closes=0;const member=s.chat.addMember({name:'running native fixture',adapter:'codex'});s.chat.join(v.room.id,member.id);c.updateMember(member.id,{status:'ready',verified_at:now()});
  s.chat.options.clientFactory=()=>({run:async value=>{input=value;value.onTurn('original-running-turn');await new Promise(resolve=>release=resolve);value.onProgress('late output');value.onApproval({id:123,method:'fixture'},'read-only');return {answer:'late result must not publish'};},close:async()=>{closes++;release();}});
  const otherAbort=new AbortController();s.chat.active.set(v.shared.id,{roomId:v.other.id,abort:otherAbort});
  const message=s.chat.post({room_id:v.room.id,to_member_id:member.id,text:'running fixture task',idempotency_key:'running'});assert.equal(c.message(message.id).status,'processing');
  const result=await forceDeleteRoom(s,v.room.id,deletionPreview(s,v.room.id).confirmation_token);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result.status,'deleted');assert.ok(input.signal.aborted);assert.equal(closes,1);assert.equal(otherAbort.signal.aborted,false);assert.equal(s.chat.active.get(v.shared.id).roomId,v.other.id);assert.equal(s.chat.progress.size,0);assert.equal(s.approvals.size,0);assert.equal(s.chat.connectedMembers.has(member.id),false);
  assert.equal(s.store.db.prepare('SELECT status FROM chat_messages WHERE id=?').get(message.id).status,'cancelled');assert.equal(s.store.db.prepare("SELECT count(*) n FROM chat_messages WHERE room_id=? AND kind='reply'").get(v.room.id).n,0);s.chat.active.clear();
});

test('controller deletes only one local room atomically, moves its entrances to each member’s remaining rooms and keeps shared identities and history',async t=>{
  const v=setup(t),s=v.service,db=s.store.db,c=s.chat.store;
  const old=c.post({room_id:v.room.id,text:'retained deleted-room history',idempotency_key:'old'});
  const keep=c.post({room_id:v.other.id,text:'keep other-room history',idempotency_key:'keep'});
  c.bind(v.room.id,v.shared.id,'bound','deleted-room-native-session');c.bind(v.other.id,v.shared.id,'bound','other-native-session');
  const invite=c.createInvite({member_id:v.shared.id,room_id:v.room.id}),otherInvite=c.createInvite({member_id:v.shared.id,room_id:v.other.id});
  const card=s.entry.issue(v.shared.id,v.room.id),otherCard=s.entry.issue(v.shared.id,v.other.id);
  const oldCard=JSON.parse(fs.readFileSync(card.file,'utf8')),otherRaw=fs.readFileSync(otherCard.file),cardRaw=fs.readFileSync(card.file);
  s.resume.accept(oldCard);s.resume.accept(JSON.parse(otherRaw));
  const native=s.bridge.store.bind({member_id:v.shared.id,room_id:v.room.id,provider:'grok-bot',conversation_ref:'fixture-native-old'});
  const otherNative=s.bridge.store.bind({member_id:v.shared.id,room_id:v.other.id,provider:'grok-bot',conversation_ref:'fixture-native-keep'});
  const unchanged=Object.fromEntries(['projects','chat_members','chat_bindings','chat_messages','bridge_bindings','settings'].map(table=>[table,immutableRows(db,table)]));
  const otherResume=db.prepare('SELECT * FROM chat_resume_credentials WHERE room_id=?').all(v.other.id),revision=s.revision;
  const result=deleteRoom(s,v.room.id);
  assert.equal(result.ok,true);assert.equal(result.status,'deleted');assert.equal(result.already_deleted,false);assert.equal(s.revision,revision+1);
  assert.deepEqual(c.rooms().map(r=>r.id),[v.other.id]);
  assert.equal(db.prepare('SELECT joined FROM chat_participants WHERE room_id=? AND member_id=?').get(v.room.id,v.shared.id).joined,0);
  assert.equal(c.joined(v.other.id,v.shared.id),true);
  for(const [table,rows] of Object.entries(unchanged))assert.deepEqual(immutableRows(db,table),rows,table+' must preserve identities and history');
  assert.deepEqual(db.prepare('SELECT * FROM chat_resume_credentials WHERE room_id=? AND id!=?').all(v.other.id,oldCard.credential_id),otherResume);
  assert.deepEqual({...db.prepare('SELECT room_id,status FROM chat_resume_credentials WHERE id=?').get(oldCard.credential_id)},{room_id:v.other.id,status:'active'});
  assert.equal(db.prepare('SELECT status FROM chat_invitations WHERE id=?').get(invite.id).status,'revoked');
  assert.equal(c.invite(otherInvite.id).status,'pending');assert.equal(c.message(keep.id).text,'keep other-room history');assert.equal(c.binding(v.other.id,v.shared.id).thread_id,'other-native-session');
  assert.equal(db.prepare('SELECT id FROM bridge_bindings WHERE id=?').get(native.id).id,native.id);assert.equal(s.bridge.store.binding(otherNative.id).room_id,v.other.id);
  assert.deepEqual(fs.readFileSync(card.file),cardRaw);assert.deepEqual(fs.readFileSync(otherCard.file),otherRaw);assert.equal(s.closing,false);assert.equal(fs.readFileSync(path.join(v.project.path,'README.md'),'utf8'),'A local test project.');
  for(const run of [()=>c.room(v.room.id),()=>c.messages(v.room.id),()=>c.message(old.id),()=>c.join(v.room.id,v.shared.id),()=>c.completeInvite(invite.id,invite.nonce),()=>c.invite(invite.id),()=>c.post({room_id:v.room.id,text:'no resurrection',idempotency_key:'replay'}),()=>s.entry.issue(v.shared.id,v.room.id)])assert.throws(run,{status:410,code:'room_deleted'});
  for(const run of [()=>s.resume.inspect(oldCard),()=>s.resume.accept(oldCard),()=>readEntry(card.file).card])assert.equal(run().room_id,v.other.id);
  assert.equal(s.resume.inspect(JSON.parse(otherRaw)).valid,true);
  const repeated=deleteRoom(s,v.room.id);assert.equal(repeated.already_deleted,true);assert.equal(repeated.deleted_at,result.deleted_at);assert.equal(s.revision,revision+1);
  const restarted=await v.restart(),disk=openDisk(v.data,{readOnly:true});
  try{assert.deepEqual(restarted.chat.store.rooms().map(r=>r.id),[v.other.id]);assert.deepEqual(disk.chat.rooms().map(r=>r.id),[v.other.id]);assert.throws(()=>disk.chat.room(v.room.id),{code:'room_deleted'});assert.equal(disk.resume.inspect(oldCard).room_id,v.other.id);assert.equal(disk.resume.inspect(JSON.parse(otherRaw)).valid,true);assert.equal(disk.runtime.instanceId,restarted.runtime.instanceId);}finally{disk.close();}
  assert.equal(restarted.chat.snapshot().activeMessages.length,0);assert.equal(restarted.codex.calls.length,0);assert.equal(db.isOpen,false);
});

test('room deletion refuses pending, executing and uncertain work without mutating any table',t=>{
  const v=setup(t),s=v.service,c=s.chat.store,db=s.store.db;
  const task=c.post({room_id:v.room.id,to_member_id:v.shared.id,text:'never execute fixture work',idempotency_key:'waiting'});
  for(const status of ['queued','processing','delivered','consumed','waiting_input','uncertain']){
    c.updateMessage(task.id,{status});const before=Object.fromEntries(['chat_room_tombstones','chat_participants','chat_messages','chat_invitations','chat_resume_credentials'].map(table=>[table,immutableRows(db,table)]));
    assert.throws(()=>deleteRoom(s,v.room.id),{status:409,code:'room_busy'});
    for(const [table,rows]of Object.entries(before))assert.deepEqual(immutableRows(db,table),rows,table);
  }
  c.updateMessage(task.id,{status:'cancelled'});s.chat.active.set(v.shared.id,{roomId:v.room.id,connecting:true});assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});s.chat.active.clear();
  s.chat.connecting.set(v.room.id+':'+v.shared.id,Promise.resolve());assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});s.chat.connecting.clear();
  c.bind(v.room.id,v.shared.id,'creation_uncertain');assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});c.bind(v.room.id,v.shared.id,'bound','known-fixture');
  s.chat.active.set(v.shared.id,{roomId:v.other.id,messageId:id()});assert.equal(deleteRoom(s,v.room.id).ok,true);s.chat.active.clear();
});

test('running setup and bridge states deny deletion; completed rows are historical and do not block',t=>{
  const v=setup(t),s=v.service,db=s.store.db,stamp=now(),launch=id(),onboard=id(),check=id();
  db.prepare("INSERT INTO launch_sessions(id,room_id,status,goal,candidates,created,updated) VALUES(?,?,'preparing','fixture','[]',?,?)").run(launch,v.room.id,stamp,stamp);
  assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});db.prepare("UPDATE launch_sessions SET status='awaiting_grok' WHERE id=?").run(launch);
  db.prepare("INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,install_client,install_runtime,created,updated,goal) VALUES(?,?,'fixture','fixture','mailbox','running','connecting',0,0,?,?,'fixture')").run(onboard,v.room.id,stamp,stamp);
  assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});db.prepare("UPDATE onboarding_runs SET status='ready' WHERE id=?").run(onboard);
  db.prepare("INSERT INTO bridge_setup_tests(id,member_id,room_id,status,summary,evidence,created,updated) VALUES(?,?,?,'waiting','fixture','{}',?,?)").run(check,v.shared.id,v.room.id,stamp,stamp);
  assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});db.prepare("UPDATE bridge_setup_tests SET status='passed' WHERE id=?").run(check);
  const second=s.chat.addMember({name:'target fixture',adapter:'mailbox'});s.chat.join(v.room.id,second.id);
  const binding=s.bridge.store.bind({member_id:v.shared.id,room_id:v.room.id,conversation_ref:'local-fixture'});
  const entry=s.bridge.store.submit({binding_id:binding.id,external_message_id:'fixture question',target_member_id:second.id,text:'never dispatch'});
  assert.throws(()=>deleteRoom(s,v.room.id),{code:'room_busy'});db.prepare("UPDATE bridge_entries SET status='failed' WHERE id=?").run(entry.id);
  assert.equal(deleteRoom(s,v.room.id).ok,true);assert.equal(db.prepare('SELECT count(*) n FROM launch_sessions').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,1);
});

test('DELETE API authenticates controller, rejects extra scope and is idempotent without affecting another room',async t=>{
  const v=setup(t),s=v.service,token=id(),server=createServer(s,{port:0,token}),port=await server.listen(),base='http://127.0.0.1:'+port;
  t.after(()=>server.close());const card=s.resume.issue(v.shared.id,v.room.id).card;
  const request=async(route,authorization=token,body)=>{const response=await fetch(base+route,{method:'DELETE',headers:{...authorization?{Authorization:'Bearer '+authorization}:{},...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,value:await response.json()};};
  const route='/api/chat/rooms/'+v.room.id;
  for(const auth of [null,card.secret])assert.equal((await request(route,auth)).response.status,401);
  for(const [url,input]of [[route+'?room_id='+v.other.id,{}],[route,{room_id:v.other.id}],[route,{force:true}],['/api/chat/rooms/not-a-uuid',{}],[route+'/join',{}],[route,[]]]){const r=await request(url,token,input);assert.equal(r.response.status,400);assert.equal(r.value.code,'room_delete_input_invalid');}
  assert.throws(()=>assertEntryScope({store:s.store,chat:s.chat.store,runtime:s.runtime,resume:s.resume},card,route,{}),{status:403,code:'resume_scope_mismatch'});
  assert.equal((await request('/api/chat/rooms/'+id())).response.status,404);
  const first=await request(route);assert.equal(first.response.status,200);assert.equal(first.value.already_deleted,false);
  const second=await request(route,token,{});assert.equal(second.response.status,200);assert.equal(second.value.deleted_at,first.value.deleted_at);assert.equal(second.value.already_deleted,true);
  const get=await fetch(base+route,{headers:{Authorization:'Bearer '+token}});assert.equal(get.status,410);assert.equal((await get.json()).code,'room_deleted');
  const state=await fetch(base+'/api/state',{headers:{Authorization:'Bearer '+token}});assert.deepEqual((await state.json()).chat.rooms.map(r=>r.id),[v.other.id]);
});

test('failed revocation rolls back the tombstone and participants in the same transaction',t=>{
  const v=setup(t),s=v.service,db=s.store.db,card=s.resume.issue(v.shared.id,v.room.id).card;
  db.exec("CREATE TRIGGER fixture_deny_revocation BEFORE UPDATE ON chat_resume_credentials BEGIN SELECT RAISE(ABORT,'fixture revocation denied'); END;");
  assert.throws(()=>deleteRoom(s,v.room.id),/fixture revocation denied/);
  assert.equal(s.chat.store.room(v.room.id).id,v.room.id);assert.equal(s.chat.store.joined(v.room.id,v.shared.id),true);assert.equal(db.prepare('SELECT count(*) n FROM chat_room_tombstones').get().n,0);assert.equal(s.resume.inspect(card).valid,true);
  db.exec('DROP TRIGGER fixture_deny_revocation');assert.equal(deleteRoom(s,v.room.id).ok,true);
});

test('last room may be deleted, leaving an empty local office without deleting the project',t=>{
  const v=setup(t),s=v.service;
  deleteRoom(s,v.room.id);deleteRoom(s,v.other.id);
  assert.deepEqual(s.chat.store.rooms(),[]);assert.deepEqual(s.snapshot().chat.rooms,[]);assert.deepEqual(s.office.snapshot(),{});assert.deepEqual(s.secretary.snapshot(),{});assert.equal(s.store.projects().length,1);assert.equal(s.chat.store.members().length,1);
});

test('an already initialized HTTP MCP session and CLI recovering guard cannot wake or revive a deleted room, but keep the member’s other rooms',async t=>{
  const v=setup(t),s=v.service,token=id(),server=createServer(s,{port:0,token}),port=await server.listen(),base='http://127.0.0.1:'+port;
  t.after(()=>server.close());const own=s.entry.issue(v.shared.id,v.room.id),card=JSON.parse(fs.readFileSync(own.file,'utf8'));
  const url=createQwenMcpConfig(base,card).mcpServers.agentroom.url;
  const initialized=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',clientInfo:{name:'isolated deletion fixture',version:'1'},capabilities:{}}})});
  assert.equal(initialized.status,200);const session=initialized.headers.get('mcp-session-id');assert.ok(session);assert.ok((await initialized.json()).result);
  const credentialBefore=s.resume.credential(card.credential_id);assert.equal(credentialBefore.status,'pending');
  deleteRoom(s,v.room.id);
  const oldSession=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','mcp-session-id':session,'mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentroom_chat_history',arguments:{room_id:v.room.id}}})});
  const refused=await oldSession.json();assert.ok(refused.error||refused.result?.isError,JSON.stringify(refused));assert.equal(s.chat.store.rooms().some(room=>room.id===v.room.id),false);
  assert.equal(s.resume.credential(card.credential_id).room_id,v.other.id);assert.equal(readEntry(own.file).card.room_id,v.other.id);
  let starts=0,dispatches=0;const recovering=createRecoveringApi(v.data,{guard:()=>{readEntry(own.file);throw Object.assign(new Error('fixture stop'),{code:'fixture_stop'});},ensure:async()=>{starts++;},call:async()=>{dispatches++;}});
  await assert.rejects(recovering('/api/runtime'),{code:'fixture_stop'});assert.equal(starts,0);assert.equal(dispatches,0);assert.equal(s.codex.calls.length,0);assert.equal(s.store.db.prepare('SELECT count(*) n FROM chat_rooms').get().n,2);assert.equal(s.store.db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,1);
});
