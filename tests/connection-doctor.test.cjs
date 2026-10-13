'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {connectionDoctor}=require('../src/connection-doctor.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,now}=require('../src/util.cjs');
async function setup(t){
  const files=fixture(),model=new FakeCodex(),vault=new FakeVault();
  const service=new RoomService(files.data,{codex:model,vault,fetch:async()=>{throw new Error('diagnostic must not contact a provider');}});clearInterval(service.exportTimer);
  const project=service.addProject({name:'Connection doctor fixture',path:files.project}),room=service.chat.addRoom({title:'选定房间',project_id:project.id}),other=service.chat.addRoom({title:'PRIVATE-OTHER-ROOM',project_id:project.id});
  const member=service.chat.addMember({name:'当前成员',adapter:'mailbox',config:{key:'PRIVATE-MEMBER-CONFIG'}}),hidden=service.chat.addMember({name:'PRIVATE-OTHER-MEMBER',adapter:'mailbox',config:{key:'PRIVATE-OTHER-CONFIG'}});
  service.chat.join(room.id,member.id);service.chat.join(other.id,hidden.id);service.chat.store.post({room_id:room.id,sender_id:'user',text:'PRIVATE-MESSAGE-BODY',idempotency_key:id()});
  const entry=service.entry.issue(member.id,room.id),card=JSON.parse(fs.readFileSync(entry.file,'utf8'));
  service.store.db.prepare('INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,native_group_ref,native_group_status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(),room.id,'fixture-provider','fixture proxy',member.id,member.id,'https://example.test/PRIVATE-GROUP-SECRET','host_reported',now(),now());
  const token=id(),server=createServer(service,{token,port:0}),port=await server.listen(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await server.close();await service.close();assert.equal(path.dirname(path.resolve(files.root)),path.resolve(os.tmpdir()));assert.match(path.basename(files.root),/^agentroom-test-/);fs.rmSync(files.root,{recursive:true,force:true});});
  const request=async(params='',authorization=token,method='GET')=>{const response=await fetch(base+'/api/connection/doctor'+params,{method,headers:{...authorization?{Authorization:`Bearer ${authorization}`}:{},...method==='POST'?{'Content-Type':'application/json'}:{}},...method==='POST'?{body:'{}'}:{}});return {response,body:await response.json()};};
  const route=(memberId=member.id,roomId=room.id)=>`?room_id=${roomId}${memberId?'&member_id='+memberId:''}`;
  const dbHash=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(files.data,'room.sqlite'))).update(fs.existsSync(path.join(files.data,'room.sqlite-wal'))?fs.readFileSync(path.join(files.data,'room.sqlite-wal')):Buffer.alloc(0)).digest('hex');
  return {...files,service,room,other,member,hidden,entry,card,model,vault,request,route,dbHash};
}

test('controller doctor separates actual HTTP service availability from Grok host, group report and notification',async t=>{
  const v=await setup(t),result=await v.request(v.route());assert.equal(result.response.status,200);const body=result.body;
  assert.equal(body.read_only,true);assert.equal(body.local_service.online,true);assert.equal(body.local_service.evidence,'controller_http_response');assert.equal(body.local_service.instance_id,v.service.runtime.instanceId);assert.equal(body.local_service.data_directory,v.data);
  assert.equal(body.room.exists,true);assert.equal(body.room.member_count,1);assert.equal(body.target.joined,true);assert.equal(body.entry.exists,true);assert.equal(body.entry.credential_valid,true);assert.equal(body.target.status,'awaiting_handshake');
  assert.equal(body.grok_notification.configured,true);assert.equal(body.grok_windows_host.status,'check_in_grok');assert.equal(body.grok_windows_host.verified,false);assert.equal(body.grok_group.status,'host_reported');assert.equal(body.grok_group.reference_saved,true);assert.equal(body.grok_group.independently_verified,false);
  const text=JSON.stringify(body);for(const secret of [v.card.secret,'PRIVATE-MEMBER-CONFIG','PRIVATE-MESSAGE-BODY','PRIVATE-OTHER-ROOM','PRIVATE-OTHER-MEMBER','PRIVATE-GROUP-SECRET',v.vault.value.key])assert.equal(text.includes(secret),false,secret);
  assert.equal(body.launch_command,undefined);assert.equal(body.entry.file,undefined);assert.equal(body.current_participants[0].config,undefined);assert.equal(v.model.calls.length,0);
});

test('unknown stale member is an actionable diagnostic and does not mint a replacement or switch rooms',async t=>{
  const v=await setup(t),old=id(),before=v.dbHash(),result=await v.request(v.route(old));assert.equal(result.response.status,200);assert.equal(result.body.status,'missing_member');assert.equal(result.body.target.status,'missing_member');assert.equal(result.body.target.exists,false);assert.equal(result.body.entry.exists,false);
  assert.deepEqual(result.body.current_participants.map(member=>member.id),[v.member.id]);assert.equal(result.body.next_actions[0].operation,'select_current_member');assert.equal(result.body.room.id,v.room.id);assert.match(result.body.target.detail,/重新选择本房间/);
  assert.equal(fs.existsSync(path.join(v.data,'entries',`${old}-${v.room.id}.json`)),false);assert.equal(v.dbHash(),before);
});

test('member from another room is not disclosed or automatically admitted to this room',async t=>{
  const v=await setup(t),result=await v.request(v.route(v.hidden.id));assert.equal(result.response.status,200);assert.equal(result.body.target.exists,true);assert.equal(result.body.target.joined,false);assert.equal(result.body.target.status,'not_in_room');assert.equal(result.body.target.name,undefined);assert.equal(result.body.entry.exists,false);
  const text=JSON.stringify(result.body);assert.equal(text.includes('PRIVATE-OTHER-ROOM'),false);assert.equal(text.includes('PRIVATE-OTHER-MEMBER'),false);assert.equal(v.service.chat.store.joined(v.room.id,v.hidden.id),false);
});

test('read-only repeated GET preserves database bytes, entries, settings, members and messages without scans or wake',async t=>{
  const v=await setup(t),before=v.dbHash(),entryBytes=fs.readFileSync(v.entry.file),revision=v.service.revision;
  const forbidden=()=>{throw new Error('diagnostic mutation or discovery forbidden');};
  for(const method of ['issue','wake','accept','revoke'])v.service.entry[method]=forbidden;
  v.service.chat.discover=forbidden;v.service.launch.state=forbidden;v.service.launch.prepare=forbidden;v.service.runtime.heartbeat=forbidden;v.service.runtime.serviceHeartbeat=forbidden;
  const rows=()=>({settings:v.service.store.db.prepare('SELECT * FROM settings ORDER BY key').all(),members:v.service.store.db.prepare('SELECT * FROM chat_members ORDER BY id').all(),messages:v.service.store.db.prepare('SELECT * FROM chat_messages ORDER BY seq').all(),credentials:v.service.store.db.prepare('SELECT * FROM chat_resume_credentials ORDER BY id').all()});
  const prior=rows();for(let i=0;i<4;i++){const result=await v.request(v.route());assert.equal(result.response.status,200);}
  assert.equal(v.dbHash(),before);assert.deepEqual(fs.readFileSync(v.entry.file),entryBytes);assert.deepEqual(rows(),prior);assert.equal(v.service.revision,revision);assert.equal(v.model.calls.length,0);
});

test('revoked or corrupt existing entries are visible without repair or secret-bearing errors',async t=>{
  const v=await setup(t);v.service.resume.revoke(v.card.credential_id);
  const revoked=await v.request(v.route());assert.equal(revoked.response.status,200);assert.equal(revoked.body.entry.exists,true);assert.equal(revoked.body.entry.credential_status,'revoked');assert.equal(revoked.body.entry.credential_valid,false);assert.equal(revoked.body.target.status,'entry_unavailable');
  fs.writeFileSync(v.entry.file,'{"secret":"PRIVATE-DAMAGED-CARD", broken');const before=fs.readFileSync(v.entry.file,'utf8');
  const corrupt=await v.request(v.route());assert.equal(corrupt.response.status,200);assert.equal(corrupt.body.entry.credential_status,'invalid');assert.equal(JSON.stringify(corrupt.body).includes('PRIVATE-DAMAGED-CARD'),false);assert.equal(fs.readFileSync(v.entry.file,'utf8'),before);
});

test('unknown or unselected room never lists another room and a missing notification remains an independent switch',async t=>{
  const v=await setup(t);v.vault.value=null;
  const missing=await v.request(v.route(null,id()));assert.equal(missing.response.status,200);assert.equal(missing.body.status,'missing_room');assert.deepEqual(missing.body.current_participants,[]);assert.equal(missing.body.grok_notification.configured,false);assert.equal(missing.body.grok_windows_host.verified,false);
  const unselected=await v.request();assert.equal(unselected.body.status,'choose_room');assert.equal(unselected.body.room.exists,false);assert.deepEqual(unselected.body.current_participants,[]);assert.equal(JSON.stringify(unselected.body).includes(v.other.id),false);
  const direct=connectionDoctor(v.service,{room_id:v.room.id});assert.equal(direct.local_service.online,false);assert.equal(direct.local_service.evidence,'not_observed','a database observation does not claim the HTTP server is online');
});

test('ordinary member credentials cannot access the controller diagnostic; invalid IDs and POST do not mutate',async t=>{
  const v=await setup(t),before=v.dbHash();
  for(const auth of [undefined,v.card.secret]){const denied=await v.request(v.route(),auth===undefined?null:auth);assert.equal(denied.response.status,401);}
  const invalid=await v.request('?room_id=../../private&member_id='+v.member.id);assert.equal(invalid.response.status,400);assert.equal(invalid.body.code,'diagnostic_identifier_invalid');
  const post=await v.request(v.route(),undefined,'POST');assert.equal(post.response.status,404);assert.equal(v.dbHash(),before);assert.equal(v.model.calls.length,0);
});
