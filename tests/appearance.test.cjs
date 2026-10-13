'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{offlineState}=require('../src/desktop-state.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');const {rasterData,MAX_IMAGE_BYTES}=require('../src/appearance.cjs');const {id}=require('../src/util.cjs');
const PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0v8AAAAASUVORK5CYII=';
function harness(t){const f=fixture(),codex=new FakeCodex(),service=new RoomService(f.data,{codex,vault:new FakeVault()});let closed=false;
  t.after(async()=>{if(!closed)await service.close();const resolved=path.resolve(f.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const project=service.addProject({path:f.project,name:'外观测试'}),room=service.chat.addRoom({title:'既有房间',project_id:project.id}),member=service.chat.addMember({name:'Claude',adapter:'mailbox'});service.chat.join(room.id,member.id);
  return {...f,service,member,room,codex,close:async()=>{await service.close();closed=true;}};
}
test('member appearance persists across restart and offline viewing without changing membership, credentials or messages',async t=>{
  const h=harness(t),entry=h.service.entry.issue(h.member.id,h.room.id),original=fs.readFileSync(entry.file),prior=h.service.chat.store.member(h.member.id);
  const presentation=h.service.appearance.set({member_id:h.member.id,preset:'robot',color:'#517BD4',furniture:'beanbag',scale:1.2,avatar_data:PIXEL,character_data:PIXEL});
  assert.equal(presentation.color,'#517bd4');assert.deepEqual(h.service.chat.publicMember(prior).appearance,presentation);assert.deepEqual(h.service.chat.store.member(h.member.id),prior);
  assert.deepEqual(fs.readFileSync(entry.file),original);assert.equal(h.codex.calls.length,0);assert.equal(h.service.chat.room(h.room.id).messages.length,0);assert.equal(h.service.onboarding.jobs.size,0);
  await h.close();const state=offlineState(h.data,h.room.id);assert.equal(state.running,false);assert.deepEqual(state.history.participants[0].appearance,presentation);assert.deepEqual(state.snapshot.chat.members[0].appearance,presentation);
  const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{assert.deepEqual(reopened.appearance.get(h.member.id),presentation);}finally{await reopened.close();}
});
test('partial edits retain unrelated image fields and reset removes only this member presentation',t=>{
  const h=harness(t),other=h.service.chat.addMember({name:'Other',adapter:'mailbox'});h.service.appearance.set({member_id:h.member.id,avatar_data:PIXEL,character_data:PIXEL,preset:'sprite'});
  h.service.appearance.set({member_id:other.id,color:'#abcdef'});
  const edited=h.service.appearance.set({member_id:h.member.id,color:'#123456',avatar_data:null});assert.equal(edited.avatar_data,undefined);assert.equal(edited.character_data,PIXEL);assert.equal(edited.preset,'sprite');
  const reset=h.service.appearance.set({member_id:h.member.id,reset:true});assert.equal(reset.preset,'auto');assert.equal(reset.furniture,'desk');assert.equal(reset.scale,1);assert.equal(reset.character_data,undefined);assert.equal(h.service.appearance.get(other.id).color,'#abcdef');
});
test('only bounded actual raster containers can become avatars, with no remote URLs or executable image types',()=>{
  assert.equal(rasterData(PIXEL),PIXEL);assert.equal(rasterData(null),null);
  for(const value of ['https://example.com/a.png','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=','data:text/html;base64,PHNjcmlwdD4=','data:image/png;base64,PHN2Zz48L3N2Zz4=','data:image/png;base64,AAAA'])assert.throws(()=>rasterData(value),e=>e.code==='appearance_image_invalid');
  assert.throws(()=>rasterData('data:image/png;base64,'+Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')),e=>e.code==='appearance_image_too_large');
  const bytes=Buffer.from(PIXEL.split(',')[1],'base64');bytes.writeUInt32BE(5000,16);assert.throws(()=>rasterData('data:image/png;base64,'+bytes.toString('base64')),e=>e.code==='appearance_image_invalid');
});
test('unknown members, unsafe fields and invalid appearance values cannot modify stored settings',t=>{
  const h=harness(t),before=h.service.store.db.prepare('SELECT * FROM settings ORDER BY key').all();
  for(const input of [{member_id:id(),preset:'person'},{member_id:h.member.id,preset:'javascript'},{member_id:h.member.id,color:'red;url(https://evil)'},{member_id:h.member.id,avatar_url:'https://evil/'},{member_id:h.member.id,executable:'bad'},{member_id:h.member.id,furniture:'http://evil/'},{member_id:h.member.id,scale:'1'},{member_id:h.member.id,scale:0.64},{member_id:h.member.id,scale:1.36},{member_id:h.member.id,scale:NaN},{member_id:h.member.id,reset:'yes'}])assert.throws(()=>h.service.appearance.set(input));
  assert.deepEqual(h.service.store.db.prepare('SELECT * FROM settings ORDER BY key').all(),before);
});

test('automatic mascot choice is the default while existing explicit character choices remain intact',t=>{
  const h=harness(t);assert.deepEqual(h.service.appearance.get(h.member.id),{preset:'auto',color:'#557f9a',furniture:'desk',scale:1});
  h.service.store.setting('appearance.'+h.member.id,{preset:'person',color:'#123456',furniture:'beanbag',scale:0.65,character_data:PIXEL});
  const before=h.service.appearance.get(h.member.id),changed=h.service.appearance.set({member_id:h.member.id,preset:'auto',scale:1.35});
  assert.equal(before.preset,'person');assert.equal(changed.preset,'auto');assert.equal(changed.furniture,'beanbag');assert.equal(changed.character_data,PIXEL);assert.equal(changed.scale,1.35);
  h.service.store.setting('appearance.'+h.member.id,{preset:'robot',furniture:'sofa',scale:10,avatar_data:'https://evil/a.svg'});
  assert.deepEqual(h.service.appearance.get(h.member.id),{preset:'robot',color:'#557f9a',furniture:'desk',scale:1});
});
test('appearance HTTP requires controller authentication and publishes saved appearance into room state',async t=>{
  const h=harness(t),token=id(),server=createServer(h.service,{token,port:0}),port=await server.listen();t.after(()=>server.close());const url='http://127.0.0.1:'+port;
  const entry=JSON.parse(fs.readFileSync(h.service.entry.issue(h.member.id,h.room.id).file));
  const post=async auth=>fetch(url+'/api/appearance',{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({member_id:h.member.id,preset:'robot',avatar_data:PIXEL})});
  assert.equal((await post('')).status,401);assert.equal((await post(entry.secret)).status,401);
  const accepted=await post(token);assert.equal(accepted.status,200);assert.equal((await accepted.json()).avatar_data,PIXEL);
  const response=await fetch(url+'/api/appearance?member_id='+h.member.id,{headers:{Authorization:'Bearer '+token}});assert.equal((await response.json()).preset,'robot');
  const room=await fetch(url+'/api/chat/rooms/'+h.room.id,{headers:{Authorization:'Bearer '+token}});assert.equal((await room.json()).participants[0].appearance.avatar_data,PIXEL);
});

test('MCP communication omits graphical appearance data without changing message text or member identity',async()=>{
  const {toolCall}=require('../src/mcp.cjs'),memberId=id(),roomId=id(),value={room:{id:roomId},participants:[{id:memberId,name:'Qwen',appearance:{avatar_data:PIXEL}}],messages:[{id:id(),text:'讨论 appearance 字段仍是原始正文。'}]};
  const result=await toolCall('agentroom_chat_history',{room_id:roomId},async()=>value,{env:{AGENTROOM_MEMBER_ID:memberId,AGENTROOM_ROOM_ID:roomId}});
  assert.equal(result.participants[0].id,memberId);assert.equal(result.participants[0].appearance,undefined);assert.deepEqual(result.messages,value.messages);assert.equal(value.participants[0].appearance.avatar_data,PIXEL);
});
test('accessory colour is automatic by default, can be pinned to a variant and returned to automatic',t=>{
  const h=harness(t);assert.equal(h.service.appearance.get(h.member.id).accent,undefined);
  assert.equal(h.service.appearance.set({member_id:h.member.id,accent:3}).accent,3);assert.equal(h.service.appearance.get(h.member.id).accent,3);
  for(const accent of [5,-1,1.5,'2',null])assert.throws(()=>h.service.appearance.set({member_id:h.member.id,accent}),/有效/);
  assert.equal(h.service.appearance.set({member_id:h.member.id,accent:'auto'}).accent,undefined);
});
