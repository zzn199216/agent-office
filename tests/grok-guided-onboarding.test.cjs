'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id}=require('../src/util.cjs');
const {assertEntryScope}=require('../src/entry.cjs');
async function setup(t,options={}){
  const files=fixture(),calls={fetch:0,desktop:0,scan:0},candidate={id:'grok-bot',provider:'grok-bot',name:'Grok Bot',adapter:'grok-bridge',installed:true,running:true,capabilities:{manual_connect:true}};
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{calls.fetch++;throw Error('fixture prohibits external/model HTTP');},desktop:options.desktop||{},
    launch:{discover:()=>{calls.scan++;return {candidates:[candidate]};}},
    onboarding:{replyVerification:false,desktopConnector:async()=>{calls.desktop++;throw Error('native connection should not be called');}}});
  const project=service.addProject({name:'Grok fixture',path:files.project}),room=service.chat.addRoom({title:'Grok connection',project_id:project.id});
  const token=id(),server=createServer(service,{port:0,token}),port=await server.listen(),base=`http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(files.data,'control.json'),JSON.stringify({url:base,token,pid:process.pid,instance_id:service.runtime.instanceId}));
  t.after(async()=>{await server.close();await service.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  const request=async(route,input)=>{const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...input===undefined?{}:{'Content-Type':'application/json'}},...input===undefined?{}:{body:JSON.stringify(input)}});return {response,value:await response.json()};};
  const rawMember=()=>{const member=service.chat.addMember({name:'Existing Grok',adapter:'grok-bridge'});service.chat.join(room.id,member.id);return member;};
  const finish=async()=>{await Promise.all([...service.onboarding.jobs.values()]);return service.onboarding.state({room_id:room.id,provider:'grok-bot'});};
  const credentials=()=>service.store.db.prepare('SELECT * FROM chat_resume_credentials ORDER BY id').all();
  return {...files,service,project,room,calls,request,rawMember,finish,credentials};
}
async function cli(args){
  const executable=process.env.AGENTOFFICE_TEST_EXECUTABLE||process.execPath,prefix=process.env.AGENTOFFICE_TEST_EXECUTABLE?[]:[path.resolve(__dirname,'../src/main.cjs')];
  return new Promise((resolve,reject)=>{let out='',err='';const child=spawn(executable,[...prefix,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.once('error',reject);child.once('exit',code=>{let value;try{value=JSON.parse(code===0?out:err.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));}catch{return reject(Error(`fixture CLI did not return JSON (${code}): ${out} ${err}`));}resolve({code,value});});});
}

test('reusing Grok in a new room snapshots safely before joining, then verifies this attempt',async t=>{
  const v=await setup(t),member=v.rawMember();v.service.chat.prepareGrokHandoff(member.id,v.room.id);
  const entry=v.service.entry.describePrimary(member.id,v.room.id),bytes=fs.readFileSync(entry.file);v.service.entry.accept(JSON.parse(bytes));
  const other=v.service.chat.addRoom({title:'New office',project_id:v.project.id});
  const start=v.service.onboarding.start({provider:'grok-bot',room_id:other.id});
  assert.equal(start.member_id,member.id);assert.equal(start.ready_for_office,false);assert.equal(v.service.chat.store.joined(other.id,member.id),false);
  assert.doesNotThrow(()=>v.service.onboarding.state({run_id:start.id}));
  await Promise.all([...v.service.onboarding.jobs.values()]);
  assert.equal(v.service.chat.store.joined(other.id,member.id),true);
  const pending=v.service.onboarding.state({run_id:start.id});assert.equal(pending.stage,'awaiting_bridge_handshake');assert.equal(pending.ready_for_office,false);
  v.service.entry.accept(JSON.parse(bytes));assert.equal(v.service.onboarding.state({run_id:start.id}).ready_for_office,true);
  assert.equal(v.credentials().length,1);assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.equal(v.calls.fetch+v.calls.desktop,0);
});
test('Grok native connection rejects with an actionable typed reason before network or state mutation',async t=>{
  const v=await setup(t),member=v.rawMember(),before=v.credentials(),revision=v.service.revision;
  const result=await v.request('/api/desktop/connect',{member_id:member.id,room_id:v.room.id,provider:'grok-bot'});
  assert.equal(result.response.status,409);assert.equal(result.value.code,'desktop_adapter_unverified');assert.match(result.value.error,/复制连接说明/);assert.doesNotMatch(result.value.error,/fetch failed/);
  assert.equal(v.calls.fetch,0);assert.equal(v.service.desktop.row(member.id),null);assert.deepEqual(v.credentials(),before);assert.equal(v.service.revision,revision);
});
test('explicit injected Grok native drivers remain supported without advertising an unverified default',async t=>{
  let initializations=0;const v=await setup(t,{desktop:{serverName:null,driverFactory:row=>({initialize:async()=>{initializations++;return {detached:true,nativeChatId:'fixture-native-'+row.member_id};},close(){}})}}),member=v.rawMember();
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'grok-bot'});
  assert.equal(initializations,1);assert.equal(v.service.desktop.canWake(member.id),true);assert.equal(v.calls.fetch,0);
  const guide=v.service.chat.setup(member.id,v.room.id).client;assert.equal(guide.kind,'native_desktop');assert.equal(guide.native_direct_available,true);assert.equal(guide.fallback.kind,'command');
});
test('Grok onboarding gives a primary copy handoff and reads never replace an entry or retry native fetch',async t=>{
  const v=await setup(t),start=v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id}),state=await v.finish();
  assert.equal(state.id,start.id);assert.equal(state.stage,'awaiting_bridge_handshake');assert.equal(state.native_direct_available,false);assert.equal(state.connection_method,'grok_command_bridge');assert.equal(state.next_actions[0].operation,'copy_handshake_prompt');
  assert.equal(v.calls.desktop,0);assert.equal(v.calls.fetch,0);assert.equal(state.can_wake,false);
  const file=v.service.entry.describe(state.member_id,v.room.id).file,bytes=fs.readFileSync(file),credentials=v.credentials(),revision=v.service.revision,scans=v.calls.scan;
  v.service.store.db.prepare("UPDATE onboarding_runs SET stage='awaiting_native_desktop',error='fetch failed' WHERE id=?").run(state.id);
  for(let i=0;i<3;i++){
    const setup=await v.request(`/api/chat/members/${state.member_id}/setup?room_id=${v.room.id}`),guide=setup.value.client;
    assert.equal(guide.kind,'grok_guided');assert.equal(guide.guided_handoff,true);assert.match(guide.copy,/长期恢复入口/);assert.match(guide.copy,/不需要创建群聊/);assert.equal(guide.handshake_verified,false);
    const progress=v.service.onboarding.state({run_id:state.id});assert.equal(progress.stage,'awaiting_bridge_handshake');assert.equal(progress.error,null);assert.equal(progress.next_actions[0].operation,'copy_handshake_prompt');
  }
  assert.deepEqual(v.credentials(),credentials);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(v.service.revision,revision);assert.equal(v.calls.scan,scans);assert.equal(v.calls.fetch+v.calls.desktop,0);
  v.service.entry.accept(JSON.parse(bytes));const ready=v.service.onboarding.state({run_id:state.id}),guide=v.service.chat.setup(state.member_id,v.room.id).client;
  assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.error,null);assert.equal(guide.handshake_verified,true);assert.equal(guide.ready_for_office,true);assert.equal(guide.can_wake,false);assert.equal(guide.connection_evidence.automatic_reply_verified,false);
});
test('missing Grok entry is prepared only by explicit copy action and revoked identity cannot be renewed',async t=>{
  const v=await setup(t),member=v.rawMember(),route=`/api/chat/members/${member.id}/setup`,query=`${route}?room_id=${v.room.id}`;
  for(let i=0;i<3;i++){const result=await v.request(query);assert.equal(result.value.client.needs_prepare,true);assert.equal(result.value.client.copy,null);}
  assert.equal(v.credentials().length,0);
  const prepared=await v.request(route,{room_id:v.room.id});assert.equal(prepared.response.status,200);assert.match(prepared.value.client.copy,/enter/);assert.equal(v.credentials().length,1);
  const before=v.credentials(),file=v.service.entry.describe(member.id,v.room.id).file,bytes=fs.readFileSync(file);
  await v.request(route,{room_id:v.room.id});assert.deepEqual(v.credentials(),before);assert.deepEqual(fs.readFileSync(file),bytes);
  const card=JSON.parse(bytes),disk={store:v.service.store,chat:v.service.chat.store,runtime:v.service.runtime,resume:v.service.resume};
  assert.throws(()=>assertEntryScope(disk,card,route,{room_id:v.room.id}),{code:'resume_scope_mismatch'});
  v.service.resume.revoke(card.credential_id);const revoked=v.credentials(),guide=(await v.request(query)).value.client;
  assert.equal(guide.needs_reauthorization,true);assert.equal(guide.copy,null);assert.equal(guide.ready_for_office,false);
  const attempt=await v.request(route,{room_id:v.room.id});assert.equal(attempt.response.status,410);assert.equal(attempt.value.code,'resume_revoked');assert.deepEqual(v.credentials(),revoked);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('rehomed original Grok entry verifies in a new room without rewriting card or requiring new configuration',async t=>{
  const v=await setup(t);v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id});const original=await v.finish(),member=v.service.chat.store.member(original.member_id),file=v.service.entry.describe(member.id,v.room.id).file,bytes=fs.readFileSync(file),card=JSON.parse(bytes);
  v.service.entry.accept(card);const other=v.service.chat.addRoom({title:'New room',project_id:v.project.id});v.service.chat.join(other.id,member.id);v.service.chat.leave(v.room.id,member.id);
  assert.equal(v.service.resume.credential(card.credential_id).room_id,other.id);assert.equal(v.service.onboarding.credentialState(other.id,member),'active');
  v.service.onboarding.start({provider:'grok-bot',room_id:other.id});await Promise.all([...v.service.onboarding.jobs.values()]);const current=v.service.onboarding.state({room_id:other.id,provider:'grok-bot'});
  assert.equal(current.member_id,member.id);assert.equal(current.stage,'awaiting_bridge_handshake');assert.equal(current.ready_for_office,false);assert.ok(current.next_actions.some(action=>action.operation==='copy_handshake_prompt'));v.service.entry.accept(card);assert.equal(v.service.onboarding.state({run_id:current.id}).stage,'ready_mailbox');assert.equal(current.can_wake,false);assert.equal(v.credentials().length,1);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(v.service.entry.describe(member.id,other.id).file,file);
  const guide=v.service.chat.setup(member.id,other.id).client;assert.equal(guide.handshake_verified,true);assert.match(guide.copy,/升级沿用/);assert.equal(v.calls.fetch+v.calls.desktop,0);
});
test('adding the same Grok to another joined room keeps its active first connection without issuing another credential',async t=>{
  const v=await setup(t);v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id});const first=await v.finish(),member=v.service.chat.store.member(first.member_id),description=v.service.entry.describePrimary(member.id,v.room.id),bytes=fs.readFileSync(description.file);
  v.service.entry.accept(JSON.parse(bytes));const other=v.service.chat.addRoom({title:'Another joined room',project_id:v.project.id});v.service.chat.join(other.id,member.id);
  const before=v.credentials(),guide=v.service.chat.setup(member.id,other.id).client;
  assert.equal(guide.handshake_verified,true);assert.equal(guide.needs_prepare,false);assert.ok(guide.copy.includes(description.file));assert.equal(v.service.onboarding.credentialState(other.id,member),'active');
  v.service.onboarding.start({provider:'grok-bot',room_id:other.id});await Promise.all([...v.service.onboarding.jobs.values()]);const current=v.service.onboarding.state({room_id:other.id,provider:'grok-bot'});
  assert.equal(current.member_id,member.id);assert.equal(current.stage,'awaiting_bridge_handshake');assert.equal(current.ready_for_office,false);assert.deepEqual(v.credentials(),before);v.service.entry.accept(JSON.parse(bytes));assert.equal(v.service.onboarding.state({run_id:current.id}).ready_for_office,true);assert.deepEqual(fs.readFileSync(description.file),bytes);
});
test('Grok old entry CLI inbox spans current joined rooms and explicit room selection remains membership guarded',async t=>{
  const v=await setup(t),member=v.rawMember();v.service.chat.prepareGrokHandoff(member.id,v.room.id);const entry=v.service.entry.describePrimary(member.id,v.room.id),bytes=fs.readFileSync(entry.file);
  v.service.entry.accept(JSON.parse(bytes));const other=v.service.chat.addRoom({title:'Joined second office',project_id:v.project.id}),outside=v.service.chat.addRoom({title:'Not authorized',project_id:v.project.id});v.service.chat.join(other.id,member.id);
  const one=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:member.id,text:'First office question',idempotency_key:'first-office'}),two=v.service.chat.store.post({room_id:other.id,sender_id:'user',to_member_id:member.id,text:'Second office question',idempotency_key:'second-office'});
  const all=await cli(['chat-inbox','--entry',entry.file]);assert.equal(all.code,0);assert.deepEqual(new Set(all.value.map(message=>message.id)),new Set([one.id,two.id]));
  const rooms=await cli(['chat-rooms','--entry',entry.file]);assert.equal(rooms.code,0);assert.deepEqual(new Set(rooms.value.rooms.map(room=>room.id)),new Set([v.room.id,other.id]));
  const filtered=await cli(['chat-inbox','--room',other.id,'--entry',entry.file]);assert.equal(filtered.code,0);assert.deepEqual(filtered.value.map(message=>message.id),[two.id]);
  const history=await cli(['chat-history','--entry',entry.file]);assert.equal(history.code,0);assert.equal(history.value.room.id,v.room.id);
  const denied=await cli(['chat-inbox','--room',outside.id,'--entry',entry.file]);assert.equal(denied.code,1);assert.equal(denied.value.code,'resume_scope_mismatch');
  const wrongMember=await cli(['chat-inbox','--member',id(),'--entry',entry.file]);assert.equal(wrongMember.code,1);assert.equal(wrongMember.value.code,'resume_scope_mismatch');
  assert.equal(v.credentials().length,1);assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.equal(v.calls.fetch+v.calls.desktop,0);
});
test('fixed proxy CLI inbox uses its authoritative fixed room even when its entry names another joined room',async t=>{
  const v=await setup(t),backend=v.service.chat.addMember({name:'Fixed backend fixture',adapter:'mailbox'});v.service.chat.join(v.room.id,backend.id);
  const proxy=v.service.launch.proxy(v.room,{provider:'codex',name:'Fixed proxy fixture'},backend),other=v.service.chat.addRoom({title:'Another joined room',project_id:v.project.id});
  v.service.chat.join(other.id,proxy.proxy_member_id);
  // This controller-issued card deliberately names the other seat. A fixed
  // proxy must derive routing from its saved backend binding, not that hint.
  const entry=v.service.entry.issue(proxy.proxy_member_id,other.id),bytes=fs.readFileSync(entry.file);v.service.entry.accept(JSON.parse(bytes));
  const one=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:proxy.proxy_member_id,text:'Fixed home question',idempotency_key:'fixed-home-question'});
  v.service.chat.store.post({room_id:other.id,sender_id:'user',to_member_id:proxy.proxy_member_id,text:'Different seat question',idempotency_key:'fixed-other-question'});
  const received=await cli(['chat-inbox','--entry',entry.file]);assert.equal(received.code,0);assert.deepEqual(received.value.map(message=>message.id),[one.id]);
  const rooms=await cli(['chat-rooms','--entry',entry.file]);assert.equal(rooms.code,0);assert.deepEqual(rooms.value.rooms,[{id:v.room.id,title:v.room.title}]);assert.equal(JSON.stringify(rooms.value).includes(other.title),false);assert.equal(JSON.stringify(rooms.value).includes(other.id),false);
  const home=await cli(['chat-inbox','--room',v.room.id,'--entry',entry.file]);assert.equal(home.code,0);assert.deepEqual(home.value.map(message=>message.id),[one.id]);
  const denied=await cli(['chat-inbox','--room',other.id,'--entry',entry.file]);assert.equal(denied.code,1);assert.equal(denied.value.code,'resume_scope_mismatch');
  assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.equal(v.credentials().length,1);assert.equal(v.calls.fetch+v.calls.desktop,0);
});
