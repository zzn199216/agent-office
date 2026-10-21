'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {OnboardingManager}=require('../src/onboarding.cjs');
const {RoomError,id,now}=require('../src/util.cjs');

// No host profiles, accounts, models or network are used. This real SQLite
// protocol fixture makes preparer's scope and pure progress reads observable.
function setup(t,options={}){
  const data=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-onboarding-test-'));fs.mkdirSync(path.join(data,'entries'));
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE chat_rooms(id TEXT PRIMARY KEY,title TEXT);
    CREATE TABLE launch_sessions(id TEXT PRIMARY KEY,room_id TEXT,status TEXT,candidates TEXT,error TEXT,selected_providers TEXT);
    CREATE TABLE launch_proxies(id TEXT PRIMARY KEY,room_id TEXT,provider TEXT,name TEXT,backend_member_id TEXT,installation TEXT,native_group_status TEXT);
    CREATE TABLE chat_resume_credentials(id TEXT PRIMARY KEY,room_id TEXT,member_id TEXT,status TEXT,last_seen TEXT);`);
  const room={id:id(),title:'测试协作群'};db.prepare('INSERT INTO chat_rooms VALUES(?,?)').run(room.id,room.title);
  const members=new Map(),calls=[],runtimes=[],capabilities=new Map();let changes=0,scans=0;
  const service={store:{db,dir:data},changed(){changes++;},chat:{store:{
    room(value){if(value!==room.id)throw new RoomError('房间不存在。',404);return room;},
    member(value){const member=members.get(value);if(!member)throw new RoomError('成员不存在。',404);return member;},joined(){return true;}
  }},runtime:{memberState(memberId){return {can_wake:capabilities.get(memberId)===true};}}};
  service.launch={jobs:new Map(),policy(){return {scan:'on_request',join:'explicit_selection',automatic_sync:false};},
    chooseRoom(input){return service.chat.store.room(input.room_id||room.id);},
    state(){throw new Error('progress reads must not call launch.state or issue cards');},
    discovery(){scans++;throw new Error('only prepare scans');},
    prepare(input){
      scans++;calls.push(input);
      if(options.prepareError)throw options.prepareError;
      const provider=input.providers[0],session={id:id(),room_id:room.id,status:'preparing'},desktop=['claude-desktop','qwen-desktop','doubao','opencode','cherry-studio','cline','roo-code'].includes(provider);
      const candidate={provider,name:provider,adapter:desktop?'mailbox':provider,installed:options.installed!==false,capabilities:{automatic_launch:!desktop&&options.installed!==false,mcp_prepare:desktop}};
      db.prepare('INSERT INTO launch_sessions VALUES(?,?,?,?,NULL,?)').run(session.id,room.id,session.status,JSON.stringify([candidate]),JSON.stringify(input.providers));
      let proxy=db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(room.id,provider);
      if(options.supported!==false&&candidate.installed){
        if(!proxy){const member={id:id(),adapter:candidate.adapter,status:desktop?'awaiting_handshake':'connecting',verified_at:null,error:null};members.set(member.id,member);capabilities.set(member.id,!desktop);
          const installation=options.installation|| (desktop?{status:'configured',installed:true,connected:false,needs_reload:true,configuration_file:'SECRET-FILE',mcp:{secret:'SECRET-CARD'}}:null);
          proxy={id:id(),room_id:room.id,provider,name:provider,backend_member_id:member.id,installation:installation?JSON.stringify(installation):null,native_group_status:'pending'};
          db.prepare('INSERT INTO launch_proxies VALUES(:id,:room_id,:provider,:name,:backend_member_id,:installation,:native_group_status)').run(proxy);
        }
        const file=path.join(data,'entries',`${proxy.backend_member_id}-${room.id}.json`);let card,credential;
        try{card=JSON.parse(fs.readFileSync(file,'utf8'));credential=db.prepare('SELECT * FROM chat_resume_credentials WHERE id=?').get(card.credential_id);}catch{}
        if(!credential||credential.status==='revoked'){
          card={credential_id:id(),room_id:room.id,member_id:proxy.backend_member_id};db.prepare("INSERT INTO chat_resume_credentials VALUES(?,?,?,'pending',NULL)").run(card.credential_id,room.id,proxy.backend_member_id);fs.writeFileSync(file,JSON.stringify(card));
        }
      }
      const work=Promise.resolve().then(async()=>{if(options.gate)await options.gate;
        db.prepare("UPDATE launch_sessions SET status='awaiting_grok' WHERE id=?").run(session.id);
        if(proxy&&!desktop){const member=members.get(proxy.backend_member_id);member.status=options.nativeError?'connection_failed':'ready';member.error=options.nativeError||null;member.verified_at=options.nativeError?null:now();}
      }).finally(()=>service.launch.jobs.delete(session.id));
      service.launch.jobs.set(session.id,work);return session;
    }};
  const managerOptions={replyVerification:false}; // This fixture covers preparation/transport only; real reply checks have a service-level fixture.
  if(options.runtimeInstaller)managerOptions.runtimeInstaller=async input=>{runtimes.push(input);return options.runtimeInstaller(input);};
  const manager=new OnboardingManager(service,managerOptions);
  t.after(async()=>{await manager.close();db.close();const absolute=path.resolve(data);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-onboarding-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {db,data,room,members,calls,runtimes,capabilities,service,manager,get changes(){return changes;},get scans(){return scans;}};
}
async function completed(v,input={}){
  const start=v.manager.start({provider:'codex',room_id:v.room.id,...input});
  await Promise.all([...v.manager.jobs.values()]);return v.manager.state({run_id:start.id});
}
function verifyDesktop(v,state){const member=v.members.get(state.member_id);member.status='ready';member.verified_at=now();v.db.prepare("UPDATE chat_resume_credentials SET status='active',last_seen=? WHERE member_id=? AND room_id=?").run(now(),member.id,state.room_id);}

test('construction and status lookup never discover agents or create sessions and cards',t=>{
  const v=setup(t);assert.equal(v.scans,0);
  const changes=v.changes;const before=v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;
  for(let i=0;i<4;i++)assert.equal(v.manager.state({room_id:v.room.id}).status,'not_started');
  assert.equal(v.scans,0);assert.equal(v.changes,changes);assert.equal(v.calls.length,0);
  assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,before);
});
test('one explicit button prepares exactly the named provider and classifies automatic readiness',async t=>{
  const v=setup(t),state=await completed(v,{install_client:true});
  assert.deepEqual(v.calls,[{room_id:v.room.id,providers:['codex'],install_clients:true,goal:''}]);
  assert.equal(state.status,'ready');assert.equal(state.stage,'ready_automatic');assert.equal(state.local_verified,true);assert.equal(state.can_wake,true);
  assert.equal(state.native_group_status,'pending');assert.equal(state.grok_verified,false);
  assert.equal(state.next_actions[0].kind,'open_native_group');assert.equal(state.policy.automatic_sync,false);
  assert.equal(state.automatic_reply_verified,false);assert.equal(state.model_reply_verified,false);assert.equal(state.native_conversation_loaded,false);
});
test('onboarding distinguishes protocol readiness from actual reply evidence without launching another attempt',async t=>{
  const v=setup(t),first=await completed(v);
  let evidence={protocol_verified:true,model_reply_verified:false,runner_online:false,native_conversation_loaded:false,automatic_reply_verified:false,verification_level:'protocol_verified',last_error:null,sessions:[]};
  v.service.runtime.memberState=memberId=>({can_wake:v.capabilities.get(memberId)===true,connection_evidence:evidence});
  const before=v.calls.length,changes=v.changes,state=v.manager.state({run_id:first.id});
  assert.equal(state.stage,'ready_automatic','existing transport availability status is compatible');
  assert.equal(state.readiness,'protocol_verified');assert.equal(state.protocol_verified,true);assert.equal(state.model_reply_verified,false);
  assert.equal(state.automatic_reply_verified,false);assert.match(state.detail,/实际模型回复尚待任务验证/);
  evidence={...evidence,model_reply_verified:true,automatic_reply_verified:true,verification_level:'reply_verified'};
  const answered=v.manager.state({run_id:first.id});assert.equal(answered.automatic_reply_verified,true);assert.equal(answered.readiness,'reply_verified');
  assert.equal(answered.native_conversation_loaded,false,'a CLI reply does not load a desktop current dialogue');
  evidence={...evidence,model_reply_verified:false,automatic_reply_verified:false,last_error:{stage:'model',code:'quota_required',observed_at:now()}};
  assert.equal(v.manager.state({run_id:first.id}).error_stage,'model');
  assert.equal(v.calls.length,before);assert.equal(v.changes,changes,'evidence reads do not mutate credentials or start an executor');
});
test('fast repeat clicks reuse a durable pending run without widening install permission',async t=>{
  let resolve;const gate=new Promise(r=>{resolve=r;});const v=setup(t,{gate});
  const first=v.manager.start({provider:'codex',room_id:v.room.id,install_client:false});
  const second=v.manager.start({provider:'codex',room_id:v.room.id,install_client:true,install_runtime:true});
  assert.equal(first.id,second.id);assert.equal(second.reused,true);assert.equal(second.install_client,false);assert.equal(second.install_runtime,false);
  resolve();await Promise.all([...v.manager.jobs.values()]);assert.equal(v.calls.length,1);assert.equal(v.calls[0].install_clients,false);
});
test('ready reuse preserves model handshake, transport card and native group report',async t=>{
  const v=setup(t),first=await completed(v);
  v.db.prepare("UPDATE launch_proxies SET native_group_status='host_reported' WHERE id=?").run(first.proxy_id);
  const cards=v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;
  for(let i=0;i<4;i++){
    const state=v.manager.start({provider:'codex',room_id:v.room.id});assert.equal(state.id,first.id);assert.equal(state.status,'ready');assert.deepEqual(state.next_actions,[]);assert.equal(state.native_group_status,'host_reported');assert.equal(state.grok_verified,false);
  }
  assert.equal(v.calls.length,1);assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);
});
test('legacy verified grouped proxies are adopted without launching installing or replaying model handshakes',async t=>{
  const v=setup(t,{runtimeInstaller:async()=>{throw new Error('must not install behind a ready response');}}),first=await completed(v);
  v.db.prepare("UPDATE launch_proxies SET native_group_status='host_reported' WHERE id=?").run(first.proxy_id);v.db.prepare('DELETE FROM onboarding_runs').run();
  v.db.prepare("INSERT INTO launch_sessions VALUES(?,?,'awaiting_grok','null',NULL,NULL)").run(id(),v.room.id);
  const calls=v.calls.length,cards=v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;
  const adopted=v.manager.start({provider:'codex',room_id:v.room.id,install_runtime:true,install_client:true,goal:'只记录协作目标，不执行业务'});
  assert.equal(adopted.status,'ready');assert.equal(adopted.reused,true);assert.equal(adopted.stage,'ready_automatic');assert.equal(adopted.member_id,first.member_id);assert.equal(adopted.proxy_id,first.proxy_id);assert.equal(adopted.launch_session_id,first.launch_session_id);assert.deepEqual(adopted.next_actions,[]);
  assert.equal(adopted.goal,'只记录协作目标，不执行业务');assert.equal(v.manager.row(adopted.id).goal,adopted.goal);
  assert.equal(v.manager.jobs.size,0);await Promise.resolve();assert.equal(v.calls.length,calls);assert.equal(v.runtimes.length,0);assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);
});
test('an invitation callback becoming verified before the native connection finishes cannot report ready',async t=>{
  const v=setup(t),first=await completed(v),member=v.members.get(first.member_id);
  v.service.chat.active=new Map([[member.id,{connecting:true}]]);member.status='ready';
  const connecting=v.manager.state({run_id:first.id});assert.equal(connecting.status,'running');assert.equal(connecting.stage,'connecting');assert.equal(connecting.local_verified,false);
  v.service.chat.active.set(member.id,{messageId:'existing-business-question'});const working=v.manager.state({run_id:first.id});assert.equal(working.status,'ready');assert.equal(working.stage,'ready_automatic');assert.equal(working.local_verified,true);
});
test('verified desktop mailbox readiness never becomes background wake capability',async t=>{
  const v=setup(t),first=await completed(v,{provider:'claude-desktop',install_client:true});
  assert.equal(first.stage,'awaiting_reload');assert.deepEqual(first.next_actions.map(a=>a.kind),['reload_client','self_handshake']);assert.equal(first.can_wake,false);assert.equal(first.local_verified,false);
  verifyDesktop(v,first);const after=v.manager.state({run_id:first.id});
  assert.equal(after.status,'ready');assert.equal(after.stage,'ready_mailbox');assert.equal(after.response_mode,'manual_mailbox');assert.equal(after.can_wake,false);
  assert.match(after.detail,/本人窗口/);
});
test('desktop JSON import action does not disclose configuration paths or credential body',async t=>{
  const v=setup(t,{installation:{status:'awaiting_import',needs_import:true,configuration_file:'SECRET-FILE',mcp:{url:'http://127.0.0.1/mcp/SECRET-CARD'},detail:'本机导入配置'}});
  const first=await completed(v,{provider:'qwen-desktop',connection_method:'manual_mcp'});
  assert.equal(first.stage,'awaiting_import');assert.deepEqual(first.next_actions.map(a=>a.kind),['import_mcp','self_handshake']);
  const body=JSON.stringify(first);assert.equal(body.includes('SECRET'),false);assert.equal(body.includes('configuration_file'),false);assert.equal(body.includes('/mcp/'),false);
  const changes=v.changes,cards=v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;
  for(let i=0;i<5;i++)v.manager.state({run_id:first.id});assert.equal(v.changes,changes);assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);
});
test('desktop to CLI alternative requires explicit provider selection even when mode says managed',async t=>{
  const v=setup(t,{runtimeInstaller:async()=>{throw new Error('must not install another product');}});
  const first=await completed(v,{provider:'qwen-desktop',mode:'managed',install_runtime:true,install_client:true});
  assert.equal(first.provider,'qwen-desktop');assert.equal(first.stage,'requires_explicit_backend_selection');assert.equal(first.status,'needs_action');
  assert.equal(first.next_actions[0].provider,'qwen-code');assert.equal(v.calls.length,0);assert.equal(v.runtimes.length,0);assert.equal(v.members.size,0);
});
test('runtime installation is explicit and cannot receive arbitrary executable fields',async t=>{
  const v=setup(t,{runtimeInstaller:async()=>({status:'installed',installed:true,executable:'SECRET-EXECUTABLE',args:['SECRET-ARG'],stdout:'SECRET-OUTPUT'})});
  const first=await completed(v,{provider:'claude-code',install_runtime:true,install_client:true,command:'malicious',args:['--eval'],url:'https://arbitrary.invalid'});
  assert.equal(first.stage,'ready_automatic');assert.equal(v.runtimes.length,1);assert.deepEqual(Object.keys(v.runtimes[0]).sort(),['mode','provider','requested_provider','room_id','run_id']);
  assert.equal(v.runtimes[0].provider,'claude-code');assert.equal(JSON.stringify(first).includes('SECRET'),false);
  const ordinary=setup(t,{runtimeInstaller:async()=>{throw new Error('no permission');}});await completed(ordinary,{provider:'claude-code',install_runtime:'true'});assert.equal(ordinary.runtimes.length,0);
});
test('runtime authentication requirement stops before session preparation and offers a login action',async t=>{
  const v=setup(t,{runtimeInstaller:async()=>({status:'needs_login',installed:true,detail:'需要登录'})});
  const state=await completed(v,{provider:'qwen-code',install_runtime:true});
  assert.equal(state.stage,'awaiting_auth');assert.equal(state.status,'needs_action');assert.deepEqual(state.next_actions.map(a=>a.kind),['login','verify']);assert.equal(v.calls.length,0);assert.equal(v.members.size,0);
});
test('a blocked installer cannot prepare a runtime even if download metadata says installed',async t=>{
  for(const status of ['needs_setup','failed']){
    const v=setup(t,{runtimeInstaller:async()=>({status,installed:true,detail:'下载存在但元数据校验未完成'})}),state=await completed(v,{provider:'qwen-code',install_runtime:true});
    assert.equal(state.stage,'awaiting_runtime_install');assert.equal(state.local_verified,false);assert.equal(v.calls.length,0);assert.equal(v.members.size,0);
  }
});
test('uninstalled managed runtime and unsupported clients never become ready members',async t=>{
  const missing=setup(t,{installed:false}),state=await completed(missing,{provider:'qwen-code'});
  assert.equal(state.stage,'awaiting_runtime_install');assert.equal(state.local_verified,false);assert.equal(missing.members.size,0);
  const unsupported=setup(t,{supported:false}),doubao=await completed(unsupported,{provider:'doubao',install_runtime:true});
  assert.equal(doubao.stage,'unsupported');assert.equal(doubao.next_actions[0].kind,'unsupported');assert.equal(doubao.can_wake,false);assert.equal(unsupported.members.size,0);
});
test('native login failures distinguish account action from transport verification failures',async t=>{
  const login=setup(t,{nativeError:'Claude Code 尚未登录。'}),first=await completed(login,{provider:'claude-code'});
  assert.equal(first.stage,'awaiting_auth');assert.equal(first.next_actions[0].kind,'login');assert.equal(first.local_verified,false);
  login.manager.set(first.id,{status:'needs_action',stage:'awaiting_auth',error:'本次登录窗口无法打开，请重试。'});assert.equal(login.manager.state({run_id:first.id}).error,'本次登录窗口无法打开，请重试。');
  const bad=setup(t,{nativeError:'transport closed https://host.invalid/mcp/SECRET key=private-secret'}),failed=await completed(bad);
  assert.equal(failed.status,'error');assert.equal(failed.stage,'error');assert.equal(failed.next_actions[0].operation,'retry');assert.equal(failed.error.includes('SECRET'),false);assert.equal(failed.error.includes('private-secret'),false);
});
test('actual Qwen model authentication wording is a user login action and credit failures never appear ready',async t=>{
  const qwen=setup(t,{nativeError:'Qwen Code 尚未配置自己的模型认证。请在 Qwen Code 中配置一次 API 或计划；桌面 Qwen 登录不能代替它。'}),state=await completed(qwen,{provider:'qwen-code'});
  assert.equal(state.stage,'awaiting_auth');assert.equal(state.next_actions[0].kind,'login');assert.equal(state.local_verified,false);
  const credits=setup(t),ready=await completed(credits,{provider:'claude-code'}),member=credits.members.get(ready.member_id);member.error='Credit balance is too low';member.status='connection_failed';
  const failed=credits.manager.state({run_id:ready.id});assert.equal(failed.status,'error');assert.equal(failed.local_verified,false);assert.notEqual(failed.stage,'ready_automatic');
});
test('revoked native credentials prevent readiness without progress reads issuing cards or model calls',async t=>{
  const v=setup(t),first=await completed(v),cards=v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,changes=v.changes;
  v.db.prepare("UPDATE chat_resume_credentials SET status='revoked' WHERE member_id=?").run(first.member_id);
  for(let i=0;i<5;i++){
    const state=v.manager.state({run_id:first.id});assert.equal(state.stage,'awaiting_credential');assert.equal(state.credential_status,'revoked');assert.equal(state.local_verified,false);assert.equal(state.next_actions[0].operation,'reauthorize');assert.equal(state.next_actions[0].target_member_id,first.member_id);
  }
  assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);assert.equal(v.calls.length,1);assert.equal(v.changes,changes);
  const restarted=v.manager.retry({run_id:first.id});assert.notEqual(restarted.id,first.id);await Promise.all([...v.manager.jobs.values()]);
  assert.equal(v.manager.state({run_id:restarted.id}).stage,'ready_automatic');assert.equal(v.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards+1);
});
test('a desktop historical handshake needs an active current credential and a missing entry requires explicit retry',async t=>{
  const v=setup(t),first=await completed(v,{provider:'qwen-desktop',connection_method:'manual_mcp'}),member=v.members.get(first.member_id);
  member.status='ready';member.verified_at=now();
  const pending=v.manager.state({run_id:first.id});assert.equal(pending.local_verified,false);assert.equal(pending.credential_status,'pending');assert.notEqual(pending.stage,'ready_mailbox');
  verifyDesktop(v,first);assert.equal(v.manager.state({run_id:first.id}).stage,'ready_mailbox');
  fs.unlinkSync(path.join(v.data,'entries',`${first.member_id}-${first.room_id}.json`));
  const missing=v.manager.state({run_id:first.id});assert.equal(missing.stage,'awaiting_credential');assert.equal(missing.local_verified,false);assert.equal(missing.next_actions[0].operation,'reauthorize');assert.equal(missing.next_actions[0].target_member_id,first.member_id);assert.equal(v.calls.length,1);
});
test('explicit retry creates a scoped new attempt without executing business prompts',async t=>{
  const v=setup(t,{nativeError:'transport closed'}),first=await completed(v);
  const retried=v.manager.retry({run_id:first.id,install_client:true});assert.notEqual(retried.id,first.id);
  await Promise.all([...v.manager.jobs.values()]);assert.equal(v.calls.length,2);assert.deepEqual(v.calls[1],{room_id:v.room.id,providers:['codex'],install_clients:true,goal:''});
  assert.throws(()=>v.manager.retry({run_id:retried.id,provider:'claude-code'}),e=>e.code==='onboarding_scope_mismatch');
  assert.throws(()=>v.manager.state({run_id:retried.id,room_id:id()}),e=>e.code==='onboarding_scope_mismatch');
  assert.equal(v.calls.some(input=>'text' in input||'prompt' in input),false);
});
test('unfinished durable setup becomes interrupted after process restart and is never auto replayed',async t=>{
  const v=setup(t),stamp=now(),run=id();
  v.db.prepare("INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,launch_session_id,install_client,install_runtime,runtime_result,error,created,updated) VALUES(?,?,?,?,?,'running','connecting',NULL,0,0,NULL,NULL,?,?)").run(run,v.room.id,'codex','codex','managed',stamp,stamp);
  const restarted=new OnboardingManager(v.service,{replyVerification:false});t.after(()=>restarted.close());
  const state=restarted.state({run_id:run});assert.equal(state.status,'interrupted');assert.equal(state.stage,'interrupted');assert.equal(state.next_actions[0].operation,'retry');assert.equal(v.calls.length,0);assert.equal(v.scans,0);
});
test('invalid or broad selections fail before discovery, installation and room mutation',t=>{
  const v=setup(t);
  for(const provider of [undefined,'*','all','CODEx','codex\n',{},['codex']]){
    if(provider==='all')continue;assert.throws(()=>v.manager.start({provider,room_id:v.room.id}),e=>e.code==='choose_agent');
  }
  assert.throws(()=>v.manager.start({provider:'codex',providers:['codex','claude-code'],room_id:v.room.id}),e=>e.code==='single_provider_required');
  assert.throws(()=>v.manager.start({provider:'codex',mode:'desktop',room_id:v.room.id}),e=>e.code==='onboarding_mode_invalid');
  assert.equal(v.calls.length,0);assert.equal(v.scans,0);assert.equal(v.db.prepare('SELECT count(*) AS n FROM onboarding_runs').get().n,0);
});

test('additional manual clients stay awaiting import and require their own active credential handshake',async t=>{
  for(const provider of ['doubao','opencode','cherry-studio','cline','roo-code']){
    const installation={status:'awaiting_import',needs_import:true,import_kind:provider==='doubao'?'form':'json',configuration_file:'PRIVATE-FILE',manual_fields:{url:'http://127.0.0.1/mcp/PRIVATE-CREDENTIAL'},detail:'本人的 MCP 配置已准备'};
    const v=setup(t,{installation}),state=await completed(v,{provider,connection_method:'manual_mcp'});
    assert.equal(state.mode,'desktop');assert.equal(state.status,'needs_action');assert.equal(state.stage,'awaiting_import');assert.equal(state.response_mode,'manual_mailbox');assert.equal(state.can_wake,false);assert.equal(state.local_verified,false);
    assert.equal(state.installation.import_kind,installation.import_kind);assert.deepEqual(state.next_actions.map(a=>a.kind),['import_mcp','self_handshake']);assert.equal(JSON.stringify(state).includes('PRIVATE'),false);
    if(provider==='doubao')assert.match(state.next_actions[0].label,/个人连接器/);
    const member=v.members.get(state.member_id);member.verified_at=now();member.status='ready';assert.equal(v.manager.state({run_id:state.id}).local_verified,false,'pending credential is not a completed desktop handshake');
    verifyDesktop(v,state);const ready=v.manager.state({run_id:state.id});assert.equal(ready.status,'ready');assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.can_wake,false);assert.equal(ready.local_verified,true);
  }
});

test('manual clients cannot silently convert a managed request into an unrelated backend or runtime install',async t=>{
  const v=setup(t,{runtimeInstaller:async()=>{throw new Error('must not install another provider');}}),state=await completed(v,{provider:'doubao',mode:'managed',install_runtime:true});
  assert.equal(state.stage,'requires_explicit_backend_selection');assert.equal(state.next_actions[0].provider,'doubao');assert.equal(state.next_actions[0].mode,'desktop');assert.equal(v.calls.length,0);assert.equal(v.runtimes.length,0);assert.equal(v.members.size,0);
});

test('Gemini quota and provider configuration blockers remain actionable without claiming readiness',async t=>{
  for(const [nativeError,stage] of [['Gemini CLI 当前额度或请求限制阻止本轮，请在 Gemini CLI 检查可用额度。','awaiting_quota'],['Gemini CLI 有现成的系统级管理配置，请由配置管理者接入 AgentRoom。','awaiting_provider_action'],['Gemini CLI 需要 0.63.0 或更新的稳定版本，才能使用经过核对的后台会话协议。','awaiting_runtime_install']]){
    const v=setup(t,{nativeError}),state=await completed(v,{provider:'gemini-cli'});assert.equal(state.status,'needs_action');assert.equal(state.stage,stage);assert.equal(state.local_verified,false);assert.notEqual(state.stage,'ready_automatic');assert.ok(state.next_actions.length);
  }
  const login=setup(t,{nativeError:'Gemini CLI 认证未完成或已失效。请在自己的 Gemini CLI 中登录或配置 API 认证一次。'}),state=await completed(login,{provider:'gemini-cli'});assert.equal(state.stage,'awaiting_auth');assert.equal(state.next_actions[0].operation,'login_client');
});

test('structured Gemini provider errors preserve an actionable phase without executing model requests',async t=>{
  const error=new RoomError('需要检查 Gemini CLI 的操作权限。',403,'gemini_permission_denied');error.needsAction=true;
  const v=setup(t,{prepareError:error}),state=await completed(v,{provider:'gemini-cli'});assert.equal(state.status,'needs_action');assert.equal(state.stage,'awaiting_provider_action');assert.equal(state.local_verified,false);assert.equal(v.members.size,0);assert.equal(state.next_actions.at(-1).operation,'retry');
});
