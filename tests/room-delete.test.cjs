'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {deleteRoom}=require('../src/room-lifecycle.cjs');
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

test('controller deletes only one local room atomically, revokes its entrances and keeps shared identities and history',async t=>{
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
  assert.deepEqual(db.prepare('SELECT * FROM chat_resume_credentials WHERE room_id=?').all(v.other.id),otherResume);
  assert.equal(db.prepare('SELECT status FROM chat_resume_credentials WHERE id=?').get(oldCard.credential_id).status,'revoked');
  assert.equal(db.prepare('SELECT status FROM chat_invitations WHERE id=?').get(invite.id).status,'revoked');
  assert.equal(c.invite(otherInvite.id).status,'pending');assert.equal(c.message(keep.id).text,'keep other-room history');assert.equal(c.binding(v.other.id,v.shared.id).thread_id,'other-native-session');
  assert.equal(db.prepare('SELECT id FROM bridge_bindings WHERE id=?').get(native.id).id,native.id);assert.equal(s.bridge.store.binding(otherNative.id).room_id,v.other.id);
  assert.deepEqual(fs.readFileSync(card.file),cardRaw);assert.deepEqual(fs.readFileSync(otherCard.file),otherRaw);assert.equal(s.closing,false);assert.equal(fs.readFileSync(path.join(v.project.path,'README.md'),'utf8'),'A local test project.');
  for(const run of [()=>c.room(v.room.id),()=>c.messages(v.room.id),()=>c.message(old.id),()=>c.join(v.room.id,v.shared.id),()=>c.completeInvite(invite.id,invite.nonce),()=>c.invite(invite.id),()=>c.post({room_id:v.room.id,text:'no resurrection',idempotency_key:'replay'}),()=>s.entry.issue(v.shared.id,v.room.id)])assert.throws(run,{status:410,code:'room_deleted'});
  for(const run of [()=>s.resume.inspect(oldCard),()=>s.resume.accept(oldCard),()=>readEntry(card.file)])assert.throws(run,{status:410,code:'resume_revoked'});
  assert.equal(s.resume.inspect(JSON.parse(otherRaw)).valid,true);
  const repeated=deleteRoom(s,v.room.id);assert.equal(repeated.already_deleted,true);assert.equal(repeated.deleted_at,result.deleted_at);assert.equal(s.revision,revision+1);
  const restarted=await v.restart(),disk=openDisk(v.data,{readOnly:true});
  try{assert.deepEqual(restarted.chat.store.rooms().map(r=>r.id),[v.other.id]);assert.deepEqual(disk.chat.rooms().map(r=>r.id),[v.other.id]);assert.throws(()=>disk.chat.room(v.room.id),{code:'room_deleted'});assert.throws(()=>disk.resume.inspect(oldCard),{code:'resume_revoked'});assert.equal(disk.resume.inspect(JSON.parse(otherRaw)).valid,true);assert.equal(disk.runtime.instanceId,restarted.runtime.instanceId);}finally{disk.close();}
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
  db.exec("CREATE TRIGGER fixture_deny_revocation BEFORE UPDATE OF status ON chat_resume_credentials BEGIN SELECT RAISE(ABORT,'fixture revocation denied'); END;");
  assert.throws(()=>deleteRoom(s,v.room.id),/fixture revocation denied/);
  assert.equal(s.chat.store.room(v.room.id).id,v.room.id);assert.equal(s.chat.store.joined(v.room.id,v.shared.id),true);assert.equal(db.prepare('SELECT count(*) n FROM chat_room_tombstones').get().n,0);assert.equal(s.resume.inspect(card).valid,true);
  db.exec('DROP TRIGGER fixture_deny_revocation');assert.equal(deleteRoom(s,v.room.id).ok,true);
});

test('last room may be deleted, leaving an empty local office without deleting the project',t=>{
  const v=setup(t),s=v.service;
  deleteRoom(s,v.room.id);deleteRoom(s,v.other.id);
  assert.deepEqual(s.chat.store.rooms(),[]);assert.deepEqual(s.snapshot().chat.rooms,[]);assert.deepEqual(s.office.snapshot(),{});assert.deepEqual(s.secretary.snapshot(),{});assert.equal(s.store.projects().length,1);assert.equal(s.chat.store.members().length,1);
});

test('an already initialized HTTP MCP session and CLI recovering guard cannot wake or revive a deleted room',async t=>{
  const v=setup(t),s=v.service,token=id(),server=createServer(s,{port:0,token}),port=await server.listen(),base='http://127.0.0.1:'+port;
  t.after(()=>server.close());const own=s.entry.issue(v.shared.id,v.room.id),card=JSON.parse(fs.readFileSync(own.file,'utf8'));
  const url=createQwenMcpConfig(base,card).mcpServers.agentroom.url;
  const initialized=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',clientInfo:{name:'isolated deletion fixture',version:'1'},capabilities:{}}})});
  assert.equal(initialized.status,200);const session=initialized.headers.get('mcp-session-id');assert.ok(session);assert.ok((await initialized.json()).result);
  const credentialBefore=s.resume.credential(card.credential_id);assert.equal(credentialBefore.status,'pending');
  deleteRoom(s,v.room.id);
  const oldSession=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','mcp-session-id':session,'mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentroom_room_ensure',arguments:{}}})});
  assert.equal(oldSession.status,410);assert.ok((await oldSession.json()).error);
  let starts=0,dispatches=0;const recovering=createRecoveringApi(v.data,{guard:()=>readEntry(own.file),ensure:async()=>{starts++;},call:async()=>{dispatches++;}});
  await assert.rejects(recovering('/api/runtime'),{code:'resume_revoked'});assert.equal(starts,0);assert.equal(dispatches,0);assert.equal(s.codex.calls.length,0);assert.equal(s.store.db.prepare('SELECT count(*) n FROM chat_rooms').get().n,2);assert.equal(s.store.db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,1);
});
