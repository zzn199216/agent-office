'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{resolveConnectionTarget}=require('../src/connection-target.cjs'),{memberConnection}=require('../src/member-policy.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id,now}=require('../src/util.cjs');
function setup(t){
  const files=fixture();let scans=0;
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('External requests prohibited');},onboarding:{replyVerification:false},launch:{discover:()=>{scans++;return {candidates:[{id:'codex',provider:'codex',name:'Codex',adapter:'codex',installed:true,capabilities:{automatic_launch:true}},{id:'grok-bot',provider:'grok-bot',name:'Grok Bot',adapter:'grok-bridge',installed:true,capabilities:{manual_connect:true}}]};}}});
  const project=service.addProject({name:'Shared target fixture',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'Current office'}),other=service.chat.addRoom({project_id:project.id,title:'Previous office'}),actor=service.chat.addMember({name:'Assistant',adapter:'mailbox'});service.chat.join(room.id,actor.id);
  t.after(async()=>{await service.close();const target=path.resolve(files.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});
  function member(provider,where=other,{revoked=false}={}){const managed=['codex','claude-code','qwen-code','gemini-cli'].includes(provider),m=service.chat.addMember({name:provider+' '+id().slice(0,4),adapter:provider==='grok-bot'?'grok-bridge':managed?provider:'mailbox'});service.chat.join(where.id,m.id);if(!managed)service.chat.store.updateMember(m.id,{config:{launch_provider:provider,connection_mode:provider==='grok-bot'?'manual_cli':'manual_mcp',...provider==='grok-bot'?{webhook_enabled:true}:{}}});const entry=service.entry.issue(m.id,where.id),bytes=fs.readFileSync(entry.file),card=JSON.parse(bytes);service.entry.accept(card);if(revoked)service.resume.revoke(entry.credential_id);return {member:service.chat.store.member(m.id),entry,bytes,card};}
  function message(text){return service.chat.store.post({room_id:room.id,sender_id:'user',to_member_id:actor.id,text,idempotency_key:id()});}
  const counts=()=>({members:service.chat.store.members().length,cards:service.store.db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,runs:service.store.db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,assists:service.store.db.prepare('SELECT count(*) n FROM connection_assists').get().n});
  return {files,service,project,room,other,actor,member,message,counts,get scans(){return scans;},async finish(){await Promise.all([...service.connectionAssist.jobs.values()]);return service.connectionAssist.listRoom(room.id);}};
}
test('chat and one-click resolve the same valid Codex despite several revoked historical people',async t=>{
  const v=setup(t),old=[v.member('codex',v.other,{revoked:true}),v.member('codex',v.other,{revoked:true}),v.member('codex',v.other,{revoked:true})],active=v.member('codex');
  const before=v.counts(),message=v.message('接入一下codex');v.service.connectionAssist.begin(message);const [assist]=await v.finish();
  assert.equal(assist.target_member_id,active.member.id);assert.equal(assist.action_kind,'managed');assert.equal(assist.ready_for_office,false);assert.equal(assist.reused_connection,true);assert.equal(assist.verification_scope,'current_attempt');assert.equal(assist.copy_sentence,'');assert.equal(assist.document_path,null);assert.match(assist.summary,/原接入进度/);assert.equal(v.scans,0);
  const oneClick=v.service.onboarding.start({room_id:v.room.id,provider:'codex'});assert.equal(oneClick.member_id,active.member.id);assert.equal(oneClick.reused_connection,true);assert.equal(v.counts().members,before.members);assert.equal(v.counts().cards,before.cards);assert.deepEqual(fs.readFileSync(active.entry.file),active.bytes);
  for(const prior of old){assert.equal(v.service.resume.credential(prior.entry.credential_id).status,'revoked');assert.deepEqual(fs.readFileSync(prior.entry.file),prior.bytes);}
});
test('an explicit or bound revoked target cannot be replaced by another same-brand person',async t=>{
  const v=setup(t),revoked=v.member('codex',v.room,{revoked:true}),active=v.member('codex',v.room);
  assert.equal(resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'codex'}).member_id,active.member.id);
  const start=v.service.onboarding.start({room_id:v.room.id,provider:'codex',target_member_id:revoked.member.id});assert.equal(start.member_id,revoked.member.id);assert.equal(start.stage,'awaiting_credential');assert.equal(v.scans,0);
  assert.throws(()=>v.service.onboarding.start({room_id:v.room.id,provider:'codex',reauthorize:true}),{code:'connection_target_required'});
  const proxy=v.service.launch.proxy(v.room,{provider:'codex',name:'Exact route'},revoked.member),before=v.counts();
  assert.equal(resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'codex'}).member_id,revoked.member.id);
  assert.throws(()=>resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'codex',target_member_id:active.member.id}),{code:'connection_target_mismatch'});
  const message=v.message('接入Codex');v.service.connectionAssist.begin(message);const [assist]=await v.finish();assert.equal(assist.target_member_id,revoked.member.id);assert.equal(assist.action_kind,'reauthorize');assert.deepEqual(assist.recovery_action,{operation:'reauthorize',room_id:v.room.id,provider:'codex',target_member_id:revoked.member.id});assert.equal(assist.copy_sentence,'');assert.equal(assist.document_path,null);assert.equal(v.counts().cards,before.cards);assert.equal(v.service.resume.credential(revoked.entry.credential_id).status,'revoked');assert.equal(v.service.launch.db.prepare('SELECT backend_member_id FROM launch_proxies WHERE id=?').get(proxy.id).backend_member_id,revoked.member.id);
});
test('a historical falsely blocked assist synchronizes read-only after the actual Codex is manually joined',async t=>{
  const v=setup(t),active=v.member('codex'),message=v.message('接入Codex'),assistId=id(),stamp=now();
  v.service.store.db.prepare("INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,status,error,created,updated) VALUES(?,?,?,?,?,'needs_reauthorization','historical blocked record',?,?)").run(assistId,v.room.id,message.id,v.actor.id,'codex',stamp,stamp);
  const start=v.service.onboarding.start({room_id:v.room.id,provider:'codex'});await Promise.all([...v.service.onboarding.jobs.values()]);assert.equal(v.service.onboarding.state({run_id:start.id}).member_id,active.member.id);
  const before=v.counts(),revision=v.service.revision,scans=v.scans;
  for(let i=0;i<3;i++){const state=v.service.connectionAssist.snapshotForMessage(message.id)[0];assert.equal(state.run_id,null);assert.equal(state.action_kind,'managed');assert.equal(state.ready_for_office,false);assert.equal(state.target_member_id,active.member.id);assert.equal(state.reused_connection,true);assert.equal(state.error,'historical blocked record');assert.equal(state.copy_sentence,'');}
  assert.deepEqual(v.counts(),before);assert.equal(v.service.revision,revision);assert.equal(v.scans,scans);assert.equal(v.service.store.db.prepare('SELECT status,error FROM connection_assists WHERE id=?').get(assistId).error,'historical blocked record');
});
test('a configured independent Grok joins a new office with the same identity, card and settings',async t=>{
  const v=setup(t),grok=v.member('grok-bot'),config=v.service.chat.store.member(grok.member.id).config,before=v.counts();
  const message=v.message('接入一下grok');v.service.connectionAssist.begin(message);const [assist]=await v.finish();
  assert.equal(assist.target_member_id,grok.member.id);assert.equal(assist.action_kind,'manual_handoff');assert.equal(assist.reused_connection,true);assert.equal(assist.can_wake,false);assert.equal(assist.stage,'awaiting_bridge_handshake');assert.equal(v.scans,0);assert.deepEqual(v.service.chat.store.member(grok.member.id).config,config);assert.equal(v.counts().members,before.members);assert.equal(v.counts().cards,before.cards);assert.deepEqual(fs.readFileSync(grok.entry.file),grok.bytes);
});
test('adding Codex never turns an independent Grok into its fixed proxy',async t=>{
  const v=setup(t),grok=v.member('grok-bot',v.room),codex=v.member('codex',v.room),config=v.service.chat.store.member(grok.member.id).config;
  const proxy=v.service.launch.proxy(v.room,{provider:'codex',name:'Codex'},codex.member);assert.notEqual(proxy.proxy_member_id,grok.member.id);assert.equal(v.service.launch.db.prepare('SELECT 1 FROM launch_proxies WHERE proxy_member_id=?').get(grok.member.id),undefined);
  const connection=memberConnection({store:v.service.store,chat:v.service.chat.store},grok.card);assert.equal(connection.room_scope,'joined_rooms');assert.deepEqual(v.service.chat.store.member(grok.member.id).config,config);assert.deepEqual(fs.readFileSync(grok.entry.file),grok.bytes);
  assert.equal(v.service.launch.proxy(v.room,{provider:'codex',name:'Codex'},codex.member).id,proxy.id,'existing fixed mappings remain unchanged');
});
test('a fixed Grok proxy in another room is never reused as an independent new-room identity',async t=>{
  const v=setup(t),legacy=v.member('grok-bot'),backend=v.member('codex');
  v.service.store.db.prepare('INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,native_group_status,created,updated) VALUES(?,?,?,?,?,?,\'pending\',?,?)').run(id(),v.other.id,'codex','Legacy fixed',backend.member.id,legacy.member.id,now(),now());
  const resolved=resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'grok-bot'});assert.equal(resolved.member_id,legacy.member.id);assert.equal(resolved.reason,'fixed_proxy');assert.equal(resolved.fixed_proxy.room_id,v.other.id);assert.throws(()=>resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'grok-bot',target_member_id:legacy.member.id}),{code:'proxy_not_bound'});
  const before=v.counts(),start=v.service.onboarding.start({room_id:v.room.id,provider:'grok-bot'});assert.equal(start.stage,'fixed_proxy_scope');assert.match(start.detail,/固定群桥接/);assert.equal(v.counts().members,before.members);assert.equal(v.counts().cards,before.cards);assert.equal(v.scans,0);
});
test('database active flags do not reuse a damaged credential file as a ready connection',async t=>{
  const v=setup(t),active=v.member('codex',v.room);fs.writeFileSync(active.entry.file,'damaged card fixture');const before=v.counts();
  const selected=resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'codex',target_member_id:active.member.id});assert.equal(selected.member_id,active.member.id);assert.equal(selected.reused_connection,false);assert.equal(selected.blocked,false);assert.deepEqual(v.counts(),before);assert.equal(fs.readFileSync(active.entry.file,'utf8'),'damaged card fixture');
});
for(const provider of ['qwen-desktop','doubao'])test(`${provider} saved offline native conversation is restored in place instead of becoming mailbox ready`,async t=>{
  const v=setup(t),existing=v.member(provider),calls=[];
  v.service.store.db.prepare("INSERT INTO desktop_person_sessions VALUES(?,?,?,?,?,'offline',NULL,?)").run(existing.member.id,provider,'http://127.0.0.1:19245','saved-runtime-key','saved-person-conversation',now());
  v.service.onboarding.options.desktopConnector=async input=>{calls.push(input);throw Error('Original native client is offline');};
  const before=v.counts(),start=v.service.onboarding.start({room_id:v.room.id,provider});await Promise.all([...v.service.onboarding.jobs.values()]);const state=v.service.onboarding.state({run_id:start.id});
  assert.equal(calls.length,1);assert.deepEqual(calls[0],{member_id:existing.member.id,room_id:v.room.id,provider,recovery:true});assert.equal(state.member_id,existing.member.id);assert.equal(state.stage,'awaiting_native_desktop');assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.equal(state.ready_for_office,false);assert.equal(v.service.desktop.row(existing.member.id).native_session_id,'saved-person-conversation');assert.equal(v.counts().members,before.members);assert.equal(v.counts().cards,before.cards);assert.equal(v.scans,0);assert.deepEqual(fs.readFileSync(existing.entry.file),existing.bytes);
});
test('an existing generic MCP identity reuses its manual connection without a managed or native action',async t=>{
  const v=setup(t),existing=v.member('opencode'),before=v.counts(),message=v.message('接入OpenCode');v.service.connectionAssist.begin(message);const [state]=await v.finish();
  assert.equal(state.target_member_id,existing.member.id);assert.equal(state.action_kind,'manual_handoff');assert.equal(state.stage,'awaiting_handshake');assert.equal(state.reused_connection,true);assert.equal(state.can_wake,false);assert.equal(v.scans,0);assert.equal(v.counts().members,before.members);assert.equal(v.counts().cards,before.cards);
});
test('read-only synchronization of a historical blocked desktop assist never turns an offline native session into manual readiness',async t=>{
  const v=setup(t),existing=v.member('doubao',v.room),message=v.message('接入豆包'),stamp=now();
  v.service.store.db.prepare("INSERT INTO desktop_person_sessions VALUES(?,?,?,?,?,'offline',NULL,?)").run(existing.member.id,'doubao','http://127.0.0.1:19246','saved-runtime','saved-person',stamp);
  v.service.store.db.prepare("INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,status,created,updated) VALUES(?,?,?,?,?,'needs_reauthorization',?,?)").run(id(),v.room.id,message.id,v.actor.id,'doubao',stamp,stamp);
  const before=v.counts(),revision=v.service.revision;
  for(let i=0;i<3;i++){const state=v.service.connectionAssist.snapshotForMessage(message.id)[0];assert.equal(state.target_member_id,existing.member.id);assert.equal(state.action_kind,'native_connect');assert.equal(state.stage,'awaiting_native_desktop');assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.equal(state.copy_sentence,'');}
  assert.deepEqual(v.counts(),before);assert.equal(v.service.revision,revision);assert.equal(v.scans,0);assert.equal(v.service.desktop.row(existing.member.id).state,'offline');assert.deepEqual(fs.readFileSync(existing.entry.file),existing.bytes);
});
test('provider history for a revoked former person cannot override the newly selected valid person',async t=>{
  const v=setup(t),first=v.member('codex',v.room),oldRun=v.service.onboarding.start({room_id:v.room.id,provider:'codex'});await Promise.all([...v.service.onboarding.jobs.values()]);
  v.service.resume.revoke(first.entry.credential_id);const second=v.member('codex',v.room),before=v.counts();
  assert.equal(resolveConnectionTarget(v.service,{room_id:v.room.id,provider:'codex'}).member_id,second.member.id);
  const current=v.service.onboarding.start({room_id:v.room.id,provider:'codex'});await Promise.all([...v.service.onboarding.jobs.values()]);assert.notEqual(current.id,oldRun.id);assert.equal(v.service.onboarding.state({run_id:current.id}).member_id,second.member.id);
  const message=v.message('接入Codex');v.service.connectionAssist.begin(message);const [assist]=await v.finish();assert.equal(assist.target_member_id,second.member.id);assert.equal(assist.action_kind,'managed');assert.equal(assist.ready_for_office,false);assert.equal(assist.run_id,current.id);
  const explicit=v.service.onboarding.start({room_id:v.room.id,provider:'codex',target_member_id:first.member.id});assert.equal(explicit.id,oldRun.id);assert.equal(explicit.member_id,first.member.id);assert.equal(explicit.stage,'awaiting_credential');assert.equal(v.service.resume.credential(first.entry.credential_id).status,'revoked');assert.equal(v.counts().cards,before.cards);assert.equal(v.counts().members,before.members);
});
test('rapid explicit reauthorization clicks reuse the same original-person job without issuing another credential',async t=>{
  const v=setup(t),original=v.member('grok-bot',v.room,{revoked:true}),input={room_id:v.room.id,provider:'grok-bot',target_member_id:original.member.id,reauthorize:true};
  const blocked=v.service.onboarding.start({...input,reauthorize:false});assert.equal(blocked.stage,'awaiting_credential');
  const first=v.service.onboarding.start(input),second=v.service.onboarding.start(input);assert.equal(second.id,first.id);assert.equal(second.reused,true);assert.equal(v.service.onboarding.jobs.size,1);
  await Promise.all([...v.service.onboarding.jobs.values()]);const cards=v.service.resume.credentials(original.member.id),finished=v.service.onboarding.state({run_id:first.id});assert.equal(finished.member_id,original.member.id);assert.equal(cards.length,2);assert.equal(cards.filter(card=>card.status==='revoked').length,1);assert.equal(v.counts().members,2);
  const pending=v.service.onboarding.start(input);assert.equal(pending.id,first.id,'a waiting handshake keeps its same reauthorization run');assert.equal(v.service.resume.credentials(original.member.id).length,2);
});
