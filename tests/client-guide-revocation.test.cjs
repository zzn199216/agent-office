'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');

async function setup(t,provider){
  const files=fixture(),codex=new FakeCodex(),calls={fetch:0,desktop:0,scan:0};
  const service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{calls.fetch++;throw Error('fixture prohibits model/network access');},chat:{discovery:{env:{}}},onboarding:{replyVerification:false,desktopConnector:async()=>{calls.desktop++;throw Error('fixture prohibits desktop connection');}},launch:{discover:()=>{calls.scan++;throw Error('fixture prohibits discovery');}}});
  const project=service.addProject({name:'Revocation fixture',path:files.project}),room=service.chat.addRoom({title:'Existing office',project_id:project.id}),member=service.chat.addMember({name:'Existing '+provider,adapter:'mailbox'});
  service.chat.store.updateMember(member.id,{config:{launch_provider:provider}});
  service.chat.join(room.id,member.id);
  const token='revocation-fixture-controller',server=createServer(service,{port:0,token}),base='http://127.0.0.1:'+await server.listen();
  const entry=service.entry.issue(member.id,room.id);service.chat.setup(member.id,room.id);service.entry.revoke(member.id,room.id);
  const credentials=()=>service.store.db.prepare('SELECT * FROM chat_resume_credentials ORDER BY id').all();
  const templates=()=>fs.readdirSync(path.join(files.data,'client-config','templates')).sort().map(name=>{const file=path.join(files.data,'client-config','templates',name),stat=fs.statSync(file);return {name,mtimeMs:stat.mtimeMs,bytes:fs.readFileSync(file,'utf8')};});
  t.after(async()=>{await server.close();await service.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {service,room,member,entry,codex,calls,credentials,templates,read:async()=>{const response=await fetch(`${base}/api/chat/members/${member.id}/setup?room_id=${room.id}`,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);return response.json();}};
}
function assertBlocked(value,provider){
  assert.equal(value.client.needs_reauthorization,true);assert.equal(value.client.entry_status,'revoked');assert.equal(value.client.ready_for_office,false);
  assert.equal(value.mcp,null);assert.equal(value.invite,null);assert.equal(value.instructions,'');assert.equal(value.bridgeInstructions,'');assert.deepEqual(value.local_commands,{});
  if(provider!=='claude-desktop'){assert.equal(value.client.kind,'native_desktop');assert.equal(value.client.fallback,null);assert.ok(value.client.native_state);}
  for(const key of['copy','bootstrap','installation_prompt'])assert.ok(!value.client[key],key);
}

for(const provider of['claude-desktop','doubao','qwen-desktop'])for(const access of['chat.setup','HTTP GET']){
  test(`${provider} ${access} preserves a revoked entry and emits no reusable connection material`,async t=>{
    const v=await setup(t,provider),bytes=fs.readFileSync(v.entry.file),credentials=v.credentials(),templates=v.templates(),revision=v.service.revision;
    const value=access==='HTTP GET'?await v.read():v.service.chat.setup(v.member.id,v.room.id);
    assertBlocked(value,provider);assert.deepEqual(v.credentials(),credentials);assert.deepEqual(fs.readFileSync(v.entry.file),bytes);assert.deepEqual(v.templates(),templates);assert.equal(v.service.revision,revision);assert.equal(v.codex.calls.length,0);assert.deepEqual(v.calls,{fetch:0,desktop:0,scan:0});
  });
}

for(const provider of['claude-desktop','doubao','qwen-desktop'])test(`${provider} missing revoked card cannot mint a replacement while viewing setup`,async t=>{
  const v=await setup(t,provider),credentials=v.credentials(),templates=v.templates();fs.unlinkSync(v.entry.file);
  assertBlocked(await v.read(),provider);assert.equal(fs.existsSync(v.entry.file),false);assert.deepEqual(v.credentials(),credentials);assert.deepEqual(v.templates(),templates);
});

for(const provider of['claude-desktop','doubao','qwen-desktop'])for(const status of['pending','active'])test(`${provider} reuses a ${status} card in another joined room after the old room was revoked`,async t=>{
  const v=await setup(t,provider),oldBytes=fs.readFileSync(v.entry.file),other=v.service.chat.addRoom({title:'Another joined office',project_id:v.room.project_id});v.service.chat.join(other.id,v.member.id);
  const usable=v.service.entry.issue(v.member.id,other.id),bytes=fs.readFileSync(usable.file);if(status==='active')v.service.entry.accept(JSON.parse(bytes));
  const credentials=v.credentials(),value=await v.read(),guide=value.client.kind==='native_desktop'?value.client.fallback:value.client;
  assert.notEqual(value.client.needs_reauthorization,true);assert.ok(guide.copy);assert.ok(guide.bootstrap);assert.equal(v.service.entry.describePrimary(v.member.id,v.room.id).file,usable.file);
  assert.deepEqual(v.credentials(),credentials);assert.deepEqual(fs.readFileSync(v.entry.file),oldBytes);assert.deepEqual(fs.readFileSync(usable.file),bytes);assert.equal(v.service.resume.credential(JSON.parse(oldBytes).credential_id).status,'revoked');
});
