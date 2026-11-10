'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {retireUnusedProxies}=require('../src/launch-routes.cjs'),{id,now}=require('../src/util.cjs');
function setup(t){
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),onboarding:{replyVerification:false},launch:{discover:()=>({candidates:[{provider:'claude-desktop',id:'claude-desktop',name:'Claude',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}]})}});
  const project=service.addProject({path:files.project,name:'proxy fixture'}),room=service.chat.addRoom({project_id:project.id,title:'room'});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  return {service,room,db:service.store.db};
}
test('ordinary connection seats exactly one person; explicit mirror preparation creates its proxy on demand',async t=>{
  const v=setup(t),run=v.service.onboarding.start({provider:'claude-desktop',room_id:v.room.id});await Promise.all([...v.service.onboarding.jobs.values()]);
  const member=v.service.onboarding.state({run_id:run.id}).member_id;assert.ok(member);
  assert.equal(v.service.chat.store.participants(v.room.id).length,1);assert.equal(v.db.prepare('SELECT count(*) n FROM launch_proxies').get().n,0);
  const state=await v.service.launch.prepare({room_id:v.room.id,providers:['claude-desktop'],group_name:'explicit fixture mirror'});await Promise.all([...v.service.launch.jobs.values()]);
  const mirror=v.service.launch.state({session_id:state.id});assert.equal(mirror.proxies.length,1);assert.ok(mirror.proxies[0].proxy_member_id);assert.equal(mirror.proxies[0].backend_member_id,member);
});
test('cleanup revokes unused credentials and preserves message, session and used-credential references',async t=>{
  const v=setup(t),backend=v.service.chat.addMember({name:'backend',adapter:'mailbox'});v.service.chat.join(v.room.id,backend.id);
  const add=provider=>{const member=v.service.chat.addMember({name:provider,adapter:'grok-proxy'});v.service.chat.join(v.room.id,member.id);const entry=v.service.entry.issue(member.id,v.room.id);
    v.db.prepare("INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,created,updated) VALUES(?,?,?,?,?,?,?,?)").run(id(),v.room.id,provider,provider,backend.id,member.id,now(),now());return {member,entry};};
  const unused=add('unused'),message=add('with-message'),session=add('with-session'),credential=add('with-used-credential');
  v.service.chat.store.post({room_id:v.room.id,to_member_id:message.member.id,text:'fixture retained history',idempotency_key:id()});
  v.service.chat.store.bind(v.room.id,session.member.id,'bound','fixture-native-session');
  v.db.prepare("UPDATE chat_resume_credentials SET accepted_at=?,status='active' WHERE id=?").run(now(),credential.entry.credential_id);
  assert.equal(v.service.chat.store.transaction(()=>retireUnusedProxies(v.db)),1);assert.equal(retireUnusedProxies(v.db),0);
  assert.equal(v.service.chat.store.joined(v.room.id,unused.member.id),false);assert.equal(v.service.resume.credential(unused.entry.credential_id).status,'revoked');
  assert.equal(v.db.prepare('SELECT count(*) n FROM launch_proxies').get().n,3);
  for(const item of [message,session,credential])assert.equal(v.service.chat.store.joined(v.room.id,item.member.id),true);
});
