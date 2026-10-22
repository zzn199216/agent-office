'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id,now,sleep}=require('../src/util.cjs');
const OLD='2026-10-15T00:00:00.000Z';
async function until(predicate){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('isolated readiness check timed out');await sleep(5);}}
function setup(t){
  const files=fixture(),calls={connect:0,sends:[]},control={fail:false};
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('external requests prohibited');},
    desktop:{serverName:null,pollMs:1,driverFactory:row=>({closed:false,async initialize(){if(control.fail)throw Object.assign(Error('fixture fetch failed ECONNREFUSED'),{code:'ECONNREFUSED'});return {nativeChatId:row.native_session_id||`native-${row.member_id}`,detached:true};},
      async send(nativeId,{requestId,prompt}){calls.sends.push({nativeId,requestId,prompt});return {userMessageId:`u-${requestId}`};},
      async snapshot(requestId){const nonce=calls.sends.find(item=>item.requestId===requestId).prompt.match(/AO-CONNECT-[a-f0-9-]+/i)[0];return {requestId,nativeChatId:row.native_session_id||`native-${row.member_id}`,status:'completed',userMessageId:`u-${requestId}`,responseMessageIds:[`r-${requestId}`],replies:[{id:`r-${requestId}`,parentId:`u-${requestId}`,role:'assistant',done:true,content:nonce}]};},close(){this.closed=true;}})},
    onboarding:{defaultDesktopMethod:'native_desktop',verification:{pollMs:5,timeoutMs:1000},desktopConnector:async input=>{calls.connect++;return service.desktop.connect(input);}},
    launch:{discover:()=>({candidates:['qwen-desktop','doubao'].map(provider=>({id:provider,provider,name:provider,adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}))})}});
  const project=service.addProject({name:'isolated readiness',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'original room'});
  t.after(async()=>{await service.close();const target=path.resolve(files.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});
  async function start(input={}){const job=service.onboarding.start({provider:'doubao',room_id:room.id,...input});await Promise.all([...service.onboarding.jobs.values()]);return service.onboarding.state({run_id:job.id});}
  function legacy(){const member=service.chat.addMember({name:'same person',adapter:'mailbox'});service.chat.store.updateMember(member.id,{config:{launch_provider:'doubao',connection_mode:'managed_desktop'}});service.chat.join(room.id,member.id);const entry=service.entry.issue(member.id,room.id),card=JSON.parse(fs.readFileSync(entry.file,'utf8'));service.entry.accept(card);service.chat.store.updateMember(member.id,{verified_at:OLD});service.store.db.prepare('UPDATE chat_resume_credentials SET accepted_at=?,last_seen=? WHERE id=?').run(OLD,OLD,entry.credential_id);service.store.db.prepare("INSERT INTO desktop_person_sessions VALUES(?,?,?,?,?,'offline',NULL,?)").run(member.id,'doubao','http://127.0.0.1:19246','fixture-owned-runtime','same-native-person',OLD);return {member,entry,card,bytes:fs.readFileSync(entry.file)};}
  return {service,project,room,calls,control,start,legacy};
}
test('a failed native attempt cannot become mailbox ready from historical registration and verified reply',async t=>{
  const v=setup(t),old=v.legacy();v.control.fail=true;
  const oldQuestion=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:old.member.id,text:'old connection check',idempotency_key:id()}),oldReply=v.service.chat.reply(oldQuestion.id,old.member.id,'old answer','old-answer');
  v.service.desktop.observe(old.member.id,'protocol_verified',{source:'fixture_old_protocol'});v.service.desktop.observe(old.member.id,'model_reply',{message_id:oldQuestion.id,turn_id:'old-turn',source:'fixture_old_reply'});
  v.service.store.db.prepare("INSERT INTO onboarding_reply_verifications VALUES(?,?,?,?,?,'verified',?,NULL,?,?,?,?)").run(old.member.id,'old-run',v.room.id,oldQuestion.id,'old-nonce',oldReply.id,OLD,OLD,OLD,OLD);
  const room=v.service.chat.addRoom({project_id:v.project.id,title:'new attempt room'}),result=await v.start({room_id:room.id});
  assert.equal(result.member_id,old.member.id);assert.equal(result.connection_method,'native_desktop');assert.equal(result.status,'needs_action');assert.equal(result.stage,'awaiting_native_desktop');assert.equal(result.ready_for_office,false);assert.equal(result.local_verified,false);assert.equal(result.automatic_reply_verified,false);assert.match(result.error,/ECONNREFUSED/);assert.equal(result.reply_verification.current_attempt,false);assert.equal(result.reply_verification.run_id,'old-run');
  assert.ok(result.next_actions.some(action=>action.operation==='open_native_client'));assert.ok(result.next_actions.some(action=>action.operation==='manual_mcp'));assert.equal(v.calls.sends.length,0);assert.equal(v.service.desktop.row(old.member.id).native_session_id,'same-native-person');assert.deepEqual(fs.readFileSync(old.entry.file),old.bytes);
});
test('a launch-backed native failure keeps the actual error after a credential handshake',async t=>{
  const v=setup(t);v.control.fail=true;const failed=await v.start(),entry=v.service.entry.primary(failed.member_id,v.room.id);v.service.entry.accept(JSON.parse(fs.readFileSync(entry.file,'utf8')));
  const result=v.service.onboarding.state({run_id:failed.id});assert.ok(result.launch_session_id);assert.equal(result.stage,'awaiting_native_desktop');assert.equal(result.ready_for_office,false);assert.equal(result.can_wake,false);assert.match(result.error,/ECONNREFUSED/);assert.equal(v.calls.sends.length,0);
});
test('explicit manual MCP uses the unchanged credential and waits for this attempt handshake',async t=>{
  const v=setup(t),old=v.legacy();v.control.fail=true;const failed=await v.start();v.service.chat.store.updateMember(old.member.id,{status:'connection_failed',error:'old native member failure'});const manual=await v.start({target_member_id:old.member.id,connection_method:'manual_mcp'});
  assert.notEqual(manual.id,failed.id);assert.equal(manual.member_id,old.member.id);assert.equal(manual.connection_method,'manual_mcp');assert.equal(manual.stage,'awaiting_handshake');assert.equal(manual.launch_session_id,null);assert.equal(manual.ready_for_office,false);assert.equal(manual.reply_verification,null);assert.equal(v.calls.connect,1);assert.equal(v.calls.sends.length,0);assert.ok(!manual.next_actions.some(action=>['import_client_config','reload_client'].includes(action.operation)));
  assert.equal(v.service.resume.credentials(old.member.id).length,1);assert.deepEqual(fs.readFileSync(old.entry.file),old.bytes);v.service.entry.accept(old.card);
  const result=v.service.onboarding.state({run_id:manual.id});assert.equal(result.stage,'ready_mailbox');assert.equal(result.ready_for_office,true);assert.equal(result.can_wake,false);assert.equal(result.automatic_reply_verified,false);assert.equal(v.service.desktop.row(old.member.id).native_session_id,'same-native-person');assert.deepEqual(fs.readFileSync(old.entry.file),old.bytes);
  assert.equal(v.service.chat.deliveryCapability(old.member.id).connection_method,'manual');assert.equal(v.service.desktop.canWake(old.member.id),false);assert.equal(v.service.desktop.reconnectEligibility(old.member.id),'desktop_manual_mode');
  const message=v.service.chat.post({room_id:v.room.id,sender_id:'user',to_member_id:old.member.id,text:'manual mailbox task',idempotency_key:id()});v.service.desktop.maintainReconnect();await sleep(20);
  assert.equal(v.service.chat.store.message(message.id).status,'queued');assert.equal(v.service.store.db.prepare('SELECT 1 FROM desktop_message_runs WHERE message_id=?').get(message.id),undefined);assert.equal(v.calls.sends.length,0);
  v.service.chat.reply(message.id,old.member.id,'actual fixture manual answer','manual-answer');assert.equal(v.service.chat.store.message(message.id).status,'answered');
  v.control.fail=false;await v.service.desktop.connect({member_id:old.member.id,room_id:v.room.id,provider:'doubao'});const restored=v.service.onboarding.verifyMember({member_id:old.member.id,room_id:v.room.id});assert.notEqual(restored.id,failed.id);assert.notEqual(restored.id,manual.id);await until(()=>v.service.onboarding.state({run_id:restored.id}).ready_for_office);assert.equal(v.service.chat.deliveryCapability(old.member.id).connection_method,'native_desktop');assert.equal(v.service.desktop.row(old.member.id).native_session_id,'same-native-person');assert.equal(v.calls.sends.length,1);
});
test('a new room attempt verifies its own native turn instead of inheriting the previous verified check',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'same Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const first=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});await until(()=>v.service.onboarding.state({run_id:first.id}).ready_for_office);const firstProof=v.service.onboarding.state({run_id:first.id}).reply_verification;
  const second=v.service.chat.addRoom({project_id:v.project.id,title:'new room'});v.service.chat.join(second.id,member.id);const next=v.service.onboarding.verifyMember({member_id:member.id,room_id:second.id});
  assert.notEqual(next.id,first.id);assert.equal(next.ready_for_office,false);assert.notEqual(next.reply_verification.message_id,firstProof.message_id);assert.equal(next.reply_verification.current_attempt,true);assert.equal(next.reply_verification.run_id,next.id);await until(()=>v.service.onboarding.state({run_id:next.id}).ready_for_office);
  assert.equal(v.calls.sends.length,2);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM onboarding_verification_history').get().n,1);assert.equal(v.service.chat.store.members().filter(value=>value.adapter==='mailbox').length,1);
});
test('an uncertain earlier native turn stays owned across a new attempt without sending another check',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'uncertain Qwen',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}});v.service.chat.join(v.room.id,member.id);await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});v.service.desktop.adapter.message=()=>{};
  const first=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id}),original=first.reply_verification.message_id,stamp=now();v.service.store.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'uncertain',NULL,NULL,NULL,NULL,?,?)").run(original,member.id,v.service.desktop.row(member.id).native_session_id,original,stamp,stamp);v.service.chat.store.updateMessage(original,{status:'uncertain'});v.service.onboarding.advanceVerifications();
  const second=v.service.chat.addRoom({project_id:v.project.id,title:'new uncertain room'});v.service.chat.join(second.id,member.id);const next=v.service.onboarding.verifyMember({member_id:member.id,room_id:second.id});
  for(let i=0;i<4;i++)v.service.onboarding.advanceVerifications();const state=v.service.onboarding.state({run_id:next.id});assert.equal(state.ready_for_office,false);assert.equal(state.reply_verification.message_id,original);assert.equal(state.reply_verification.current_attempt,false);assert.equal(state.reply_verification.status,'uncertain');assert.equal(v.calls.sends.length,0);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM onboarding_reply_verifications').get().n,1);
});
test('a matching run id cannot reuse a reply created before the current attempt boundary',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'boundary Qwen',adapter:'mailbox'});v.service.chat.join(v.room.id,member.id);await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'qwen-desktop'});
  const first=v.service.onboarding.verifyMember({member_id:member.id,room_id:v.room.id});await until(()=>v.service.onboarding.state({run_id:first.id}).ready_for_office);const original=v.service.onboarding.state({run_id:first.id}).reply_verification.message_id;
  v.service.store.db.prepare('UPDATE onboarding_reply_verifications SET created=?,verified_at=? WHERE member_id=?').run(OLD,OLD,member.id);
  const historical=v.service.onboarding.state({run_id:first.id});assert.equal(historical.ready_for_office,false);assert.equal(historical.reply_verification.current_attempt,false);assert.equal(historical.model_reply_verified,false);
  v.service.onboarding.advanceVerifications();const fresh=v.service.onboarding.state({run_id:first.id});assert.notEqual(fresh.reply_verification.message_id,original);assert.equal(fresh.reply_verification.current_attempt,true);assert.equal(fresh.ready_for_office,false);
});
test('sending, running and uncertain native requests reject a manual route switch without mutating ownership',async t=>{
  const v=setup(t),old=v.legacy();v.control.fail=true;await v.start();const config=v.service.chat.store.member(old.member.id).config,runs=v.service.store.db.prepare('SELECT count(*) n FROM onboarding_runs').get().n;
  const message=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:old.member.id,text:'owned native task',idempotency_key:id()}),stamp=now();v.service.store.db.prepare("INSERT INTO desktop_message_runs VALUES(?,?,?,?,'uncertain',NULL,NULL,NULL,NULL,?,?)").run(message.id,old.member.id,'same-native-person',message.id,stamp,stamp);
  for(const status of ['sending','running','uncertain']){v.service.store.db.prepare('UPDATE desktop_message_runs SET status=? WHERE message_id=?').run(status,message.id);assert.throws(()=>v.service.onboarding.start({provider:'doubao',room_id:v.room.id,target_member_id:old.member.id,connection_method:'manual_mcp'}),{code:'desktop_request_uncertain'});assert.deepEqual(v.service.chat.store.member(old.member.id).config,config);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,runs);assert.equal(v.service.store.db.prepare('SELECT status FROM desktop_message_runs WHERE message_id=?').get(message.id).status,status);}
  assert.equal(v.calls.sends.length,0);assert.equal(v.service.desktop.row(old.member.id).native_session_id,'same-native-person');assert.deepEqual(fs.readFileSync(old.entry.file),old.bytes);
});
test('a current Grok entry handshake can establish manual readiness while preserving a stale native member error as history',async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'existing Grok',adapter:'grok-bridge'});v.service.chat.store.updateMember(member.id,{config:{launch_provider:'grok-bot',connection_mode:'manual_cli'}});v.service.chat.join(v.room.id,member.id);const entry=v.service.entry.issue(member.id,v.room.id),bytes=fs.readFileSync(entry.file),card=JSON.parse(bytes);v.service.entry.accept(card);v.service.chat.store.updateMember(member.id,{status:'connection_failed',error:'old native connection failure',verified_at:OLD});v.service.store.db.prepare('UPDATE chat_resume_credentials SET last_seen=? WHERE id=?').run(OLD,entry.credential_id);
  const pending=await v.start({provider:'grok-bot',target_member_id:member.id});assert.equal(pending.ready_for_office,false);assert.equal(pending.stage,'awaiting_bridge_handshake');assert.ok(pending.next_actions.some(action=>action.operation==='copy_handshake_prompt'));
  v.service.entry.accept(card);const ready=v.service.onboarding.state({run_id:pending.id});assert.equal(ready.ready_for_office,true);assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.can_wake,false);assert.equal(ready.model_reply_verified,false);assert.equal(ready.automatic_reply_verified,false);assert.equal(ready.error,null);assert.equal(v.service.chat.store.member(member.id).error,'old native connection failure');assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.equal(v.calls.connect,0);assert.equal(v.calls.sends.length,0);
});
test('an unreachable debug-port member is offered MCP first and reconnect second',async t=>{
  const v=setup(t);v.control.fail=true;
  const empty=v.service.onboarding.state({room_id:v.room.id,provider:'doubao'});
  assert.equal(empty.presentation.state,'not_connected');assert.ok(empty.presentation.primary);
  const result=await v.start();
  assert.equal(result.stage,'awaiting_native_desktop');
  assert.equal(result.presentation.state,'waiting');
  assert.equal(result.presentation.primary.operation,'manual_mcp');
  assert.equal(result.presentation.primary.target_member_id,result.member_id);
  assert.equal(result.presentation.secondary.operation,'native_connect');
  assert.doesNotMatch(result.presentation.headline,/ECONNREFUSED|保留|本人对话/);
  assert.match(result.presentation.details.error,/ECONNREFUSED/);
});
