'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{archiveRoom,deleteRoom}=require('../src/room-lifecycle.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{openDisk}=require('../src/entry.cjs'),{offlineState}=require('../src/desktop-state.cjs'),{assertMemberRoute}=require('../src/member-policy.cjs');
const {DatabaseSync}=require('node:sqlite');
function harness(t){const files=fixture(),options={codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('Archive tests cannot notify externally');}};let service=new RoomService(files.data,options),closed=false;const close=async()=>{if(!closed){await service.close();closed=true;}};
  const project=service.addProject({name:'Archive fixture',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'Archive me'}),other=service.chat.addRoom({project_id:project.id,title:'Keep active'}),member=service.chat.addMember({name:'Saved member',adapter:'mailbox'});service.chat.join(room.id,member.id);
  t.after(async()=>{await close();const target=path.resolve(files.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});
  return {files,room,other,member,close,get service(){return service;},async reopen(){await close();service=new RoomService(files.data,options);closed=false;}};
}
test('archive organises the list while retaining ongoing work, members, bindings and history',async t=>{
  const h=harness(t),invite=await h.service.chat.connect(h.member.id,h.room.id);h.service.chat.completeInvite(invite.invite.id,invite.invite.nonce,h.member.id);const before=h.service.chat.store.binding(h.room.id,h.member.id),message=h.service.chat.post({room_id:h.room.id,sender_id:'user',to_member_id:h.member.id,text:'An existing pending assignment',idempotency_key:'before-archive'}),messageState=h.service.chat.store.message(message.id).status;
  const saved=archiveRoom(h.service,h.room.id,true);assert.equal(saved.archived,true);assert.equal(archiveRoom(h.service,h.room.id,true).archived_at,saved.archived_at);assert.equal(h.service.chat.store.room(h.other.id).archived,false);
  assert.equal(h.service.chat.store.message(message.id).status,messageState);assert.deepEqual(h.service.chat.store.binding(h.room.id,h.member.id),before);assert.equal(h.service.chat.store.participants(h.room.id)[0].id,h.member.id);
  assert.throws(()=>deleteRoom(h.service,h.room.id),{code:'room_busy'});
  const reply=h.service.chat.reply(message.id,h.member.id,'Archived collaboration can still deliver','archive-reply');assert.equal(reply.room_id,h.room.id);
  await h.reopen();assert.equal(h.service.chat.room(h.room.id).room.archived,true);assert.ok(h.service.chat.room(h.room.id).messages.some(m=>m.text==='Archived collaboration can still deliver'));
  assert.equal(archiveRoom(h.service,h.room.id,false).archived,false);assert.equal(h.service.chat.store.room(h.room.id).id,h.room.id);assert.equal(h.service.chat.store.participants(h.room.id)[0].id,h.member.id);
});
test('cold offline archive projection is read-only and old databases need no migration to open',async t=>{
  const h=harness(t);archiveRoom(h.service,h.room.id,true);await h.close();
  const state=offlineState(h.files.data,h.room.id);assert.equal(state.history.room.archived,true);assert.equal(state.snapshot.chat.rooms.filter(r=>r.archived).length,1);
  const disk=openDisk(h.files.data,{readOnly:true});assert.throws(()=>disk.chat.setArchived(h.room.id,false),{code:'read_only_state'});disk.close();
  const db=new DatabaseSync(path.join(h.files.data,'room.sqlite'));db.exec('DROP TABLE chat_room_archives');db.close();
  assert.equal(offlineState(h.files.data,h.room.id).history.room.archived,false);const legacy=openDisk(h.files.data,{readOnly:true});assert.equal(legacy.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='chat_room_archives'").get(),undefined);legacy.close();
});
test('archived rooms retain deletion guards and deleted rooms cannot be restored',t=>{
  const h=harness(t);archiveRoom(h.service,h.room.id,true);deleteRoom(h.service,h.room.id);assert.throws(()=>archiveRoom(h.service,h.room.id,false),{code:'room_deleted'});assert.ok(!h.service.chat.store.rooms().some(r=>r.id===h.room.id));
});
test('archive and restore are controller-only HTTP operations with an exact room and empty body',async t=>{
  const h=harness(t),server=createServer(h.service,{port:0,token:'archive-controller'}),port=await server.listen();t.after(()=>server.close());
  const url='http://127.0.0.1:'+port+'/api/chat/rooms/'+h.room.id;
  const call=(suffix,body={},authorized=true)=>fetch(url+suffix,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer archive-controller'}:{})},body:JSON.stringify(body)});
  assert.equal((await call('/archive',{},false)).status,401);assert.equal((await call('/archive',{other_room:h.other.id})).status,400);assert.equal((await call('/archive?other=room')).status,400);
  assert.equal((await(await call('/archive')).json()).archived,true);assert.equal((await(await call('/restore')).json()).archived,false);
  const disk={store:h.service.store,chat:h.service.chat.store},scope={room_id:h.room.id,member_id:h.member.id};
  for(const action of ['archive','restore'])assert.throws(()=>assertMemberRoute(disk,scope,'/api/chat/rooms/'+h.room.id+'/'+action,{}),e=>e.status===403);
  assert.equal(h.service.codex.calls.length,0);
});
