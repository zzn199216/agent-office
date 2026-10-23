'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DiscoveryCatalog}=require('../src/discovery.cjs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id}=require('../src/util.cjs');

// Local protocol fixtures only: no account, model, native chat, browser or
// webhook is invoked by discovery or by preparing a Grok window's entry.
function catalog(processes=[],files=[]){const known=new Set(files);return new DiscoveryCatalog({platform:'win32',env:{USERPROFILE:'C:\\Users\\Fixture',LOCALAPPDATA:'C:\\Local',APPDATA:'C:\\Roaming',PATH:''},processInventory:()=>processes,fileExists:value=>known.has(value),listFiles:()=>[]});}
test('Grok Bot desktop is discovered once without claiming MCP import, native host or wake readiness',async ()=>{
  const exe='W:\\Programs\\Grok Bot\\Grok Bot.exe',secret='fixture-private-chat-argument';
  const result=(await catalog([{Name:'Grok Bot.exe',ProcessId:10,ExecutablePath:exe,CommandLine:secret},{Name:'Grok Bot.exe',ProcessId:11,ParentProcessId:10,ExecutablePath:exe,CommandLine:'--type=renderer '+secret},{Name:'Grok Bot.exe',ProcessId:12,ParentProcessId:10,ExecutablePath:exe}], [exe]).scan());
  const grok=result.candidates.find(value=>value.provider==='grok-bot');
  assert.equal(grok.running,true);assert.equal(grok.installed,true);assert.deepEqual(grok.pids,[10]);assert.equal(grok.capabilities.manual_connect,true);assert.equal(grok.capabilities.mcp_prepare,false);assert.equal(grok.capabilities.mcp_install,false);assert.equal(grok.capabilities.automatic_launch,false);assert.equal(grok.identity.handshake_verified,false);assert.equal(grok.support,'needs_setup');assert.equal(JSON.stringify(result).includes(secret),false);
});
test('official Grok Build CLI installation and process never become a Grok Bot desktop identity',async ()=>{
  const cli='C:\\Users\\Fixture\\.grok\\bin\\grok.exe',desktop='C:\\Apps\\GrokBot\\GrokBot.exe';
  const result=(await catalog([{Name:'grok.exe',ProcessId:20,ExecutablePath:cli},{Name:'GrokBot.exe',ProcessId:21,ExecutablePath:desktop}], [cli,desktop]).scan());
  const code=result.candidates.find(value=>value.provider==='grok-cli'),bot=result.candidates.find(value=>value.provider==='grok-bot');
  assert.equal(code.installed,true);assert.deepEqual(code.pids,[20]);assert.equal(code.instances[0].role,'cli');assert.equal(code.support,'unsupported');assert.equal(code.can_connect,false);assert.equal(code.capabilities.automatic_launch,false);assert.deepEqual(bot.pids,[21]);assert.equal(bot.instances[0].role,'desktop');
});
test('legacy known Grok desktop path is recognized while arbitrary grok executables do not identify a controllable product',async ()=>{
  const known='C:\\Programs\\Grok\\Grok.exe',unknown='C:\\Unrelated\\grok.exe';
  const result=(await catalog([{Name:'Grok.exe',ProcessId:30,ExecutablePath:known},{Name:'grok.exe',ProcessId:31,ExecutablePath:unknown}],[known,unknown]).scan());
  assert.deepEqual(result.candidates.find(value=>value.provider==='grok-bot').pids,[30]);assert.deepEqual(result.candidates.find(value=>value.provider==='grok-cli').pids,[]);
});

function setup(t){
  const f=fixture(),codex=new FakeCodex(),calls={scan:0,install:0,model:0,fetch:0};
  const candidates=[{id:'grok-bot',provider:'grok-bot',name:'Grok Bot · 本人窗口桥接',adapter:'grok-bridge',running:true,installed:true,executable:'W:\\Programs\\Grok Bot\\Grok Bot.exe',support:'needs_setup',capabilities:{manual_connect:true,automatic_launch:false,mcp_prepare:false,mcp_install:false}}];
  const service=new RoomService(f.data,{codex,vault:new FakeVault(),fetch:async()=>{calls.fetch++;throw new Error('no fixture network allowed');},onboarding:{desktopConnector:async()=>{throw Error('fixture native desktop unavailable');}},chat:{clientFactory(){calls.model++;throw new Error('no model allowed');}},launch:{discover(){calls.scan++;return {candidates};},installer:async()=>{calls.install++;throw new Error('no client install allowed');}}});
  const project=service.addProject({name:'Grok protocol fixture',path:f.project}),room=service.chat.addRoom({title:'已有办公室',project_id:project.id});
  t.after(async()=>{await service.close();const owned=path.resolve(f.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});});
  return {...f,service,project,room,calls};
}
async function prepared(v,extra={}){const result=v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id,mode:'bridge',install_client:true,...extra});await Promise.all([...v.service.onboarding.jobs.values()]);return v.service.onboarding.state({run_id:result.id});}
function card(v,memberId,roomId=v.room.id){const file=path.join(v.data,'entries',`${memberId}-${roomId}.json`);return {file,value:JSON.parse(fs.readFileSync(file,'utf8')),bytes:fs.readFileSync(file)};}
function counts(v){const db=v.service.store.db;return {members:db.prepare('SELECT count(*) n FROM chat_members').get().n,proxies:db.prepare('SELECT count(*) n FROM launch_proxies').get().n,credentials:db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,messages:db.prepare('SELECT count(*) n FROM chat_messages').get().n};}

test('explicit Grok window preparation creates one local identity and durable entry without a self proxy or external execution',async t=>{
  const v=setup(t);assert.throws(()=>v.service.onboarding.selection({provider:'grok-bot',mode:'managed'}),error=>error.code==='onboarding_mode_invalid');assert.throws(()=>v.service.onboarding.selection({provider:'codex',mode:'bridge'}),error=>error.code==='onboarding_mode_invalid');
  const job=await prepared(v),state=v.service.launch.state({session_id:job.launch_session_id}),handshake=state.selected_handshakes.find(value=>value.provider==='grok-bot');
  assert.equal(job.status,'needs_action');assert.equal(job.stage,'awaiting_bridge_handshake');assert.equal(job.mode,'bridge');assert.equal(job.local_verified,false);assert.equal(job.can_wake,false);assert.equal(job.response_mode,'manual_bridge');assert.equal(job.next_actions[0].operation,'copy_handshake_prompt');assert.equal(state.proxies.length,0);assert.equal(state.bridge_members.length,1);assert.equal(state.actions.length,0);assert.equal(state.mcp_setup,null);assert.equal(handshake.import_kind,'command');assert.equal(handshake.needs_import,false);assert.match(handshake.instruction,/enter.*--entry/);assert.match(handshake.instruction,/connected=false/);assert.match(handshake.instruction,/复用当前 Bot/);assert.doesNotMatch(handshake.instruction,/'chat-join'|invite_id=|"mcpServers"/);assert.equal(counts(v).members,1);assert.equal(counts(v).credentials,1);assert.equal(counts(v).messages,0);assert.equal(v.calls.install+v.calls.model+v.calls.fetch,0);assert.equal(v.service.codex.calls.length,0);
});
test('real entry acceptance is required for Grok readiness and never proves a native group or wake ability',async t=>{
  const v=setup(t),job=await prepared(v),resume=card(v,job.member_id);
  assert.equal(v.service.onboarding.state({run_id:job.id}).local_verified,false);const accepted=v.service.entry.accept(resume.value);assert.equal(accepted.accepted,true);
  const ready=v.service.onboarding.state({run_id:job.id});assert.equal(ready.status,'ready');assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.local_verified,true);assert.equal(ready.can_wake,false);assert.equal(ready.grok_verified,false);assert.equal(ready.native_group_status,'not_requested');assert.deepEqual(ready.next_actions,[]);assert.equal(v.service.launch.state({session_id:ready.launch_session_id}).status,'ready_mailbox');assert.equal(v.calls.model+v.calls.fetch,0);
});
test('existing Grok bridge, entry bytes, webhook configuration and fixed proxy routing are preserved',async t=>{
  const v=setup(t),chat=v.service.chat,original=chat.addMember({name:'我已有的 Grok 桥接 Bot',adapter:'grok-bridge'});chat.join(v.room.id,original.id);chat.store.updateMember(original.id,{config:{...chat.store.member(original.id).config,webhook_enabled:true,native_group:'原群',custom_fixture:'preserve'}});
  const issued=v.service.entry.issue(original.id,v.room.id);v.service.entry.accept(JSON.parse(fs.readFileSync(issued.file,'utf8')));const before=card(v,original.id),config=chat.store.member(original.id).config,first=counts(v);
  const backend=chat.addMember({name:'固定后端',adapter:'mailbox'});chat.join(v.room.id,backend.id);const candidate={provider:'codex',name:'Codex'},proxy=v.service.launch.proxy(v.room,candidate,chat.store.member(backend.id));assert.equal(proxy.proxy_member_id,original.id);
  const vaultFile=path.join(v.data,'members',original.id,'grok-vault.json');fs.mkdirSync(path.dirname(vaultFile),{recursive:true});fs.writeFileSync(vaultFile,'fixture vault bytes, never decrypted');const vaultBytes=fs.readFileSync(vaultFile),job=await prepared(v);
  assert.equal(job.member_id,original.id);assert.equal(job.name,original.name);assert.equal(job.status,'needs_action');assert.equal(job.stage,'awaiting_bridge_handshake');assert.equal(job.ready_for_office,false);assert.ok(job.next_actions.some(action=>action.operation==='copy_handshake_prompt'));assert.deepEqual(card(v,original.id).bytes,before.bytes);assert.deepEqual(chat.store.member(original.id).config,config);assert.deepEqual(fs.readFileSync(vaultFile),vaultBytes);assert.equal(counts(v).members,first.members+1);assert.equal(counts(v).credentials,first.credentials);assert.equal(counts(v).proxies,1);assert.equal(v.service.launch.lookup(original.id,v.room.id).backend_member_id,backend.id);assert.equal(v.calls.install+v.calls.model+v.calls.fetch,0);
});
test('repeat clicks and an explicit metadata rescan keep the prepared Grok identity and credential',async t=>{
  const v=setup(t),job=await prepared(v),before=card(v,job.member_id),initial=counts(v),scans=v.calls.scan;
  const repeated=v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id});assert.equal(repeated.id,job.id);assert.equal(repeated.reused,true);assert.equal(v.calls.scan,scans);
  (await v.service.launch.scan({room_id:v.room.id}));const after=v.service.onboarding.state({run_id:job.id});assert.equal(after.member_id,job.member_id);assert.equal(after.stage,'awaiting_bridge_handshake');assert.deepEqual(counts(v),initial);assert.deepEqual(card(v,job.member_id).bytes,before.bytes);
});
test('read-only onboarding and generic retry preserve revoked Grok entry until exact reauthorization',async t=>{
  const v=setup(t),job=await prepared(v),before=card(v,job.member_id);v.service.entry.accept(before.value);v.service.entry.revoke(job.member_id,v.room.id);const initial=counts(v),scans=v.calls.scan;
  const blocked=v.service.onboarding.state({run_id:job.id});assert.equal(blocked.stage,'awaiting_credential');assert.equal(blocked.local_verified,false);assert.equal(v.calls.scan,scans);assert.deepEqual(counts(v),initial);assert.deepEqual(card(v,job.member_id).bytes,before.bytes);
  const retry=v.service.onboarding.retry({run_id:job.id});await Promise.all([...v.service.onboarding.jobs.values()]);const blockedRetry=v.service.onboarding.state({run_id:retry.id});assert.equal(blockedRetry.member_id,job.member_id);assert.equal(blockedRetry.stage,'awaiting_credential');assert.deepEqual(card(v,job.member_id).bytes,before.bytes);assert.deepEqual(counts(v),initial);
  const authorized=v.service.onboarding.start({provider:'grok-bot',room_id:v.room.id,target_member_id:job.member_id,reauthorize:true});await Promise.all([...v.service.onboarding.jobs.values()]);const pending=v.service.onboarding.state({run_id:authorized.id});assert.equal(pending.member_id,job.member_id);assert.equal(pending.stage,'awaiting_bridge_handshake');assert.equal(pending.local_verified,false);assert.notEqual(card(v,job.member_id).value.credential_id,before.value.credential_id);assert.equal(counts(v).members,initial.members);assert.equal(v.calls.install+v.calls.model+v.calls.fetch,0);
});
test('preparation and progress cannot silently reuse a Grok identity from another room',async t=>{
  const v=setup(t),other=v.service.chat.addRoom({project_id:v.project.id,title:'另一个房间'}),member=v.service.chat.addMember({name:'别的群 Bot',adapter:'grok-bridge'});v.service.chat.join(other.id,member.id);v.service.entry.issue(member.id,other.id);
  const job=await prepared(v);assert.notEqual(job.member_id,member.id);assert.equal(v.service.chat.store.joined(v.room.id,member.id),false);
  const session=v.service.launch.session(job.launch_session_id),selected=session.candidates.find(value=>value.provider==='grok-bot');selected.prepared_member_id=member.id;v.service.store.db.prepare('UPDATE launch_sessions SET candidates=? WHERE id=?').run(JSON.stringify(session.candidates),session.id);
  const invalid=v.service.onboarding.state({run_id:job.id});assert.equal(invalid.local_verified,false);assert.equal(invalid.member_id,undefined);assert.equal(v.service.launch.state({session_id:session.id}).bridge_members.length,0);
});
test('deleted room onboarding and launch sessions stay inaccessible while global progress selects an active room',async t=>{
  const v=setup(t),deleted=await prepared(v),entry=card(v,deleted.member_id),other=v.service.chat.addRoom({project_id:v.project.id,title:'继续使用的房间'}),active=await prepared(v,{room_id:other.id});
  v.service.chat.store.deleteRoom(v.room.id);
  for(const read of [()=>v.service.onboarding.row(deleted.id),()=>v.service.onboarding.state({run_id:deleted.id}),()=>v.service.launch.session(deleted.launch_session_id),()=>v.service.launch.state({session_id:deleted.launch_session_id}),()=>v.service.launch.state({room_id:v.room.id})])assert.throws(read,error=>error.code==='room_deleted');
  assert.equal(v.service.launch.state().room_id,other.id);assert.equal(v.service.onboarding.state().room_id,other.id);assert.equal(v.service.onboarding.state().id,active.id);assert.deepEqual(fs.readFileSync(entry.file),entry.bytes);assert.equal(v.calls.model+v.calls.fetch,0);
});
