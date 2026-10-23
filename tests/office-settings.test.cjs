'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{offlineState}=require('../src/desktop-state.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id}=require('../src/util.cjs');
const {DEFAULT_OFFICE,IMAGE_FIELDS}=require('../src/office-settings.cjs');
const PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0v8AAAAASUVORK5CYII=';
function harness(t){
  const f=fixture(),codex=new FakeCodex(),service=new RoomService(f.data,{codex,vault:new FakeVault()});let closed=false;
  t.after(async()=>{if(!closed)await service.close();const resolved=path.resolve(f.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const project=service.addProject({path:f.project,name:'可调办公室'}),room=service.chat.addRoom({title:'办公室一',project_id:project.id}),other=service.chat.addRoom({title:'办公室二',project_id:project.id}),member=service.chat.addMember({name:'已有成员',adapter:'mailbox'});service.chat.join(room.id,member.id);
  return {...f,service,codex,room,other,member,close:async()=>{await service.close();closed=true;}};
}
function businessState(service){
  return {rooms:service.chat.store.rooms(),members:service.chat.store.members(),participants:service.store.db.prepare('SELECT * FROM chat_participants ORDER BY room_id,member_id').all(),bindings:service.store.db.prepare('SELECT * FROM chat_bindings ORDER BY room_id,member_id').all(),messages:service.store.db.prepare('SELECT * FROM chat_messages ORDER BY seq').all(),cards:service.store.db.prepare('SELECT * FROM chat_resume_credentials ORDER BY room_id,member_id').all()};
}

test('night offices default to lit and lights persist independently of time and other rooms',async t=>{
  const h=harness(t);assert.equal(h.service.office.get(h.room.id).lights_on,true);
  h.service.office.set({room_id:h.room.id,time_mode:'night',lights_on:false});
  assert.equal(h.service.office.get(h.room.id).time_mode,'night');assert.equal(h.service.office.get(h.other.id).lights_on,true);
  await h.close();assert.equal(offlineState(h.data,h.room.id).snapshot.office[h.room.id].lights_on,false);
});

test('per-room office presentation survives restart and offline viewing without changing room communication',async t=>{
  const h=harness(t),card=h.service.entry.issue(h.member.id,h.room.id),cardBytes=fs.readFileSync(card.file),before=businessState(h.service);
  assert.deepEqual(h.service.office.get(h.room.id),DEFAULT_OFFICE);
  const config=h.service.office.set({room_id:h.room.id,time_zone:'Asia/Taipei',time_mode:'night',auto_layout:false,columns:2,spacing:1.2,wall_color:'#DADBDD',floor_color:'#EEDDBB',motion:false,show_window:false,...Object.fromEntries(IMAGE_FIELDS.map(key=>[key,PIXEL]))});
  assert.equal(config.auto_layout,false);
  assert.equal(config.wall_color,'#dadbdd');assert.equal(config.floor_color,'#eeddbb');assert.deepEqual(h.service.snapshot().office[h.room.id],config);assert.deepEqual(h.service.snapshot().office[h.other.id],DEFAULT_OFFICE);
  assert.deepEqual(businessState(h.service),before);assert.deepEqual(fs.readFileSync(card.file),cardBytes);assert.equal(h.codex.calls.length,0);assert.equal(h.service.onboarding.jobs.size,0);
  await h.close();const offline=offlineState(h.data,h.room.id);assert.deepEqual(offline.snapshot.office[h.room.id],config);assert.deepEqual(offline.snapshot.office[h.other.id],DEFAULT_OFFICE);assert.equal(offline.snapshot.runtime.service.online,false);
  const reopened=new RoomService(h.data,{codex:new FakeCodex(),vault:new FakeVault()});try{assert.deepEqual(reopened.office.get(h.room.id),config);assert.deepEqual(businessState(reopened),before);}finally{await reopened.close();}
});

test('partial scene edits retain other preferences and reset affects exactly one room setting',t=>{
  const h=harness(t);h.service.office.set({room_id:h.room.id,desk_data:PIXEL,beanbag_data:PIXEL,time_zone:'UTC',columns:1});h.service.office.set({room_id:h.other.id,spacing:0.8,show_clock:false});h.service.appearance.set({member_id:h.member.id,furniture:'beanbag',scale:1.2});
  const appearance=h.service.appearance.get(h.member.id),other=h.service.office.get(h.other.id),patched=h.service.office.set({room_id:h.room.id,desk_data:null,show_plant:false});
  assert.equal(patched.desk_data,undefined);assert.equal(patched.beanbag_data,PIXEL);assert.equal(patched.time_zone,'UTC');assert.equal(patched.columns,1);
  assert.deepEqual(h.service.office.set({room_id:h.room.id,reset:true}),DEFAULT_OFFICE);assert.equal(h.service.store.setting('office.'+h.room.id),null);assert.deepEqual(h.service.office.get(h.other.id),other);assert.deepEqual(h.service.appearance.get(h.member.id),appearance);
});

test('invalid scene values, unknown rooms and external or executable assets reject atomically',t=>{
  const h=harness(t),before=h.service.store.db.prepare('SELECT * FROM settings ORDER BY key').all(),revision=h.service.revision;
  const patches=[{room_id:id(),columns:1},{time_zone:'Madeup/Nowhere'},{time_zone:'+05:00'},{time_zone:null},{time_mode:'sunset'},{time_mode:1},{columns:0},{columns:4},{columns:2.5},{columns:'2'},{spacing:0.79},{spacing:1.31},{spacing:NaN},{wall_color:'url(http://evil/)'},{show_clock:1},{motion:'false'},{version:2},{reset:'yes'},{background_url:'https://evil/'},{window_data:PIXEL},{background_data:'https://evil/scene.png'},{desk_data:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='},{columns:1,beanbag_data:'data:image/png;base64,AAAA'}];
  patches.push({auto_layout:'true'},{auto_layout:1},{auto_layout:null});
  for(const patch of patches)assert.throws(()=>h.service.office.set({room_id:h.room.id,...patch}));
  assert.deepEqual(h.service.store.db.prepare('SELECT * FROM settings ORDER BY key').all(),before);assert.equal(h.service.revision,revision);
});

test('damaged stored scene preferences are sanitized for recovery without rewriting the database',async t=>{
  const h=harness(t);h.service.store.setting('office.'+h.room.id,{columns:2,time_zone:'Asia/Taipei',time_mode:'night',wall_color:'#ABCDEF',show_clock:false,desk_data:PIXEL,beanbag_data:'https://evil/',motion:'false',spacing:20,unrecognized:'discard'});
  const original=h.service.store.db.prepare('SELECT value FROM settings WHERE key=?').get('office.'+h.room.id).value,expected={...DEFAULT_OFFICE,columns:2,time_zone:'Asia/Taipei',time_mode:'night',wall_color:'#abcdef',show_clock:false,desk_data:PIXEL};
  assert.deepEqual(h.service.office.get(h.room.id),expected);assert.equal(h.service.store.db.prepare('SELECT value FROM settings WHERE key=?').get('office.'+h.room.id).value,original);
  await h.close();assert.deepEqual(offlineState(h.data,h.room.id).snapshot.office[h.room.id],expected);
});

test('scene HTTP is controller-only and accepts a bounded scene payload without enabling model scene tools',async t=>{
  const h=harness(t),token=id(),server=createServer(h.service,{token,port:0}),port=await server.listen();t.after(()=>server.close());const url='http://127.0.0.1:'+port,card=JSON.parse(fs.readFileSync(h.service.entry.issue(h.member.id,h.room.id).file));
  const post=(auth,content)=>fetch(url+'/api/office',{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:content});
  for(const auth of ['',card.secret]){assert.equal((await post(auth,JSON.stringify({room_id:h.room.id,columns:2}))).status,401);assert.equal((await fetch(url+'/api/office?room_id='+h.room.id,{headers:{Authorization:'Bearer '+auth}})).status,401);}
  const accepted=await post(token,JSON.stringify({room_id:h.room.id,columns:2,background_data:PIXEL})+' '.repeat(300000));assert.equal(accepted.status,200);assert.equal((await accepted.json()).background_data,PIXEL);
  const current=await fetch(url+'/api/office?room_id='+h.room.id,{headers:{Authorization:'Bearer '+token}});assert.equal((await current.json()).columns,2);
  const rejected=await post(token,JSON.stringify({room_id:h.room.id,columns:1})+' '.repeat(1000000));assert.equal(rejected.status,413);assert.equal(h.service.office.get(h.room.id).columns,2);
  const state=await fetch(url+'/api/state',{headers:{Authorization:'Bearer '+token}});assert.equal((await state.json()).office[h.room.id].background_data,PIXEL);
  const {toolCall,tools}=require('../src/mcp.cjs');assert.equal(tools.some(tool=>/office|appearance|scene/.test(tool.name)),false);
  const list=await toolCall('agentroom_list',{},async()=>h.service.snapshot(),{env:{}});assert.equal(list.office,undefined);assert.equal(JSON.stringify(list).includes(PIXEL),false);
});
