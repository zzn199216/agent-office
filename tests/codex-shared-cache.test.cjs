'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CodexClient}=require('../src/codex.cjs');
const {id,normalizePath,sleep}=require('../src/util.cjs');

// Only synthetic credentials, fixture files and the Node protocol fixture are
// used. No installed Codex executable, account, model or personal HOME is used.
const validationBase=os.tmpdir();
function lines(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
async function within(promise,ms=3000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture operation did not settle within its bound')),ms);})]);}finally{clearTimeout(timer);}}
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>=deadline)throw Error('Fixture event did not arrive');await sleep(5);}}
function setup(t,{legacy=false}={}){
  fs.mkdirSync(validationBase,{recursive:true});const root=fs.mkdtempSync(path.join(validationBase,'agentroom-test-shared-cache-'));
  const authHome=path.join(root,'native-home'),data=path.join(root,'data'),sqliteHome=path.join(data,'codex'),projectPath=path.join(root,'project'),clients=[],controllers=[];
  fs.mkdirSync(authHome);fs.mkdirSync(projectPath);const nativeConfig='model = "fixture-model"\nmodel_provider = "fixture-provider"\ncli_auth_credentials_store = "keyring"\n';
  fs.writeFileSync(path.join(authHome,'config.toml'),nativeConfig);fs.writeFileSync(path.join(authHome,'auth.json'),'SYNTHETIC NATIVE LOGIN - NEVER LOAD');
  if(legacy){fs.mkdirSync(sqliteHome,{recursive:true});fs.writeFileSync(path.join(sqliteHome,'agentoffice-workspace.json'),JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:authHome,credential_seeded:true}));fs.writeFileSync(path.join(sqliteHome,'auth.json'),'SYNTHETIC STALE COPY - NEVER LOAD');fs.writeFileSync(path.join(sqliteHome,'config.toml'),'model = "old-private-model"\n');}
  const project={id:id(),name:'共享缓存隔离测试',path:projectPath,canonical:normalizePath(projectPath),access:'read-only'};
  function member(memberId=id(),extra={}){
    const client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-persistent-app-server.cjs')],dataDir:data,legacyHome:authHome,authenticationMode:'shared-cache',mcpEnvironment:{AGENTROOM_MEMBER_ID:memberId,AGENTROOM_CALLER:memberId},developerInstructions:`Instructions only for ${memberId}`,...extra});
    clients.push(client);return {client,memberId,discussion:{id:id(),title:memberId,thread_id:null,binding_state:'new'}};
  }
  const binding=person=>(state,threadId)=>{person.discussion.binding_state=state;if(threadId)person.discussion.thread_id=threadId;};
  const bind=person=>person.client.bind(project,person.discussion,binding(person));
  function run(person,{hold=false,onApproval=()=>{},timeout=3000}={}){
    const controller=new AbortController();controllers.push(controller);
    return person.client.run({project,discussion:person.discussion,request:{id:id(),sender:'user',prompt:hold?'POOL_HOLD_FIXTURE':'ordinary fixture request'},onBinding:binding(person),onTurn:turnId=>{person.turnId=turnId;},onProgress:()=>{},onApproval,signal:controller.signal,timeout});
  }
  t.after(async()=>{for(const controller of controllers)controller.abort();await Promise.allSettled(clients.map(client=>client.close()));const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(validationBase));assert.match(path.basename(target),/^agentroom-test-shared-cache-/);fs.rmSync(target,{recursive:true,force:true});});
  return {root,authHome,data,sqliteHome,project,nativeConfig,member,bind,run,calls:()=>lines(path.join(sqliteHome,'rpc.jsonl')),startups:()=>lines(path.join(sqliteHome,'fixture-startups.jsonl')),responses:()=>lines(path.join(sqliteHome,'fixture-responses.jsonl'))};
}

test('shared-cache health and two members coalesce one process with native auth HOME and private SQLite',async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b'),health=f.member('health');
  const states=await Promise.all([health.client.status(),a.client.status(),b.client.status()]);
  assert.equal(f.startups().length,1);const startup=f.startups()[0];assert.equal(startup.auth_home,f.authHome);assert.equal(startup.sqlite_home,f.sqliteHome);
  assert.equal(a.client.child.pid,b.client.child.pid);assert.equal(health.client.child.pid,a.client.child.pid);assert.equal(a.client.transport.owner,b.client.transport.owner);
  assert.ok(states.every(state=>state.connected&&state.readyForRequests&&state.authenticationMode==='shared-cache'&&state.sessionMode==='shared-login-background'));
  const flags=startup.args.join('\n');assert.match(flags,/sqlite_home=/);assert.match(flags,/notify=\[\]/);assert.match(flags,/features\.hooks=false/);assert.match(flags,/features\.plugins=false/);
  assert.equal(f.calls().filter(call=>call.method==='initialize').length,1);const accounts=f.calls().filter(call=>call.method==='account/read');assert.equal(accounts.length,3);assert.ok(accounts.every(call=>call.params.refreshToken===false));
  assert.equal(f.calls().some(call=>/login|logout|refresh/.test(call.method)),false);assert.equal(fs.existsSync(path.join(f.authHome,'rpc.jsonl')),false);
  assert.equal(fs.existsSync(path.join(f.sqliteHome,'auth.json')),false);assert.equal(fs.existsSync(path.join(f.sqliteHome,'config.toml')),false);
});

test('Windows path casing cannot create a second owner for the same executable native HOME and SQLite', {skip:process.platform!=='win32'},async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b',{executable:process.execPath.toUpperCase(),legacyHome:f.authHome.toUpperCase(),dataDir:f.data.toUpperCase()});
  await Promise.all([a.client.status(),b.client.status()]);
  assert.equal(fs.realpathSync.native(a.client.executable).toLowerCase(),fs.realpathSync.native(b.client.executable).toLowerCase());
  assert.equal(a.client.transport.owner,b.client.transport.owner);assert.equal(a.client.child.pid,b.client.child.pid);assert.equal(f.startups().length,1);
  await a.client.close();assert.equal((await b.client.status()).connected,true);assert.equal(f.startups().length,1);
});

test('shared-cache startup never reads copies or overwrites either synthetic authentication file',async t=>{
  const f=setup(t,{legacy:true}),a=f.member('a'),read=fs.readFileSync,write=fs.writeFileSync,copy=fs.copyFileSync,open=fs.openSync,authCalls=[];
  const isAuth=file=>typeof file==='string'&&path.basename(file).toLowerCase()==='auth.json';
  const guard=(name,original)=>(...args)=>{if(isAuth(args[0])||name==='copy'&&isAuth(args[1])){authCalls.push(name);throw Error('AO must not access authentication fixture contents');}return original(...args);};
  t.mock.method(fs,'readFileSync',guard('read',read));t.mock.method(fs,'writeFileSync',guard('write',write));t.mock.method(fs,'copyFileSync',guard('copy',copy));t.mock.method(fs,'openSync',guard('open',open));
  const beforeMarker=read(path.join(f.sqliteHome,'agentoffice-workspace.json'),'utf8');
  try{assert.deepEqual(a.client.authOwnershipStatus(),{blocked:false,mode:'shared-cache',revision:'native-shared-cache-v1'});await a.client.status();await f.bind(a);await a.client.close();assert.deepEqual(authCalls,[]);}
  finally{t.mock.restoreAll();}
  assert.equal(read(path.join(f.authHome,'auth.json'),'utf8'),'SYNTHETIC NATIVE LOGIN - NEVER LOAD');assert.equal(read(path.join(f.sqliteHome,'auth.json'),'utf8'),'SYNTHETIC STALE COPY - NEVER LOAD');
  assert.equal(read(path.join(f.authHome,'config.toml'),'utf8'),f.nativeConfig);assert.equal(read(path.join(f.sqliteHome,'config.toml'),'utf8'),'model = "old-private-model"\n');assert.equal(read(path.join(f.sqliteHome,'agentoffice-workspace.json'),'utf8'),beforeMarker);
});

test('thread-specific MCP namespaces preserve member scope and disable inherited personal servers without merging them',async t=>{
  const f=setup(t),a=f.member('member-a'),b=f.member('member-b');await Promise.all([f.bind(a),f.bind(b)]);
  const nameA=a.client.mcpServerName(),nameB=b.client.mcpServerName();assert.match(nameA,/^agentoffice_[a-f0-9]+$/);assert.notEqual(nameA,nameB);
  const starts=f.calls().filter(call=>call.method==='thread/start');assert.equal(starts.length,2);
  for(const person of [a,b]){
    const server=person.client.mcpServerName(),start=starts.find(call=>call.params.config[`mcp_servers.${server}`]),config=start.params.config,entry=config[`mcp_servers.${server}`];
    assert.equal(entry.enabled,true);assert.equal(entry.env.AGENTROOM_MEMBER_ID,person.memberId);assert.equal(entry.env.AGENTROOM_ROOM_ID,person.discussion.id);assert.equal(entry.url,undefined);assert.ok(entry.command);assert.equal(config['mcp_servers.personal.enabled'],false);assert.equal(config['mcp_servers.agentroom.enabled'],false);assert.equal(config['mcp_servers.agentroom'],undefined);
    assert.equal(config.model,'fixture-model');assert.equal(config.model_provider,'fixture-provider');assert.equal(config['model_providers.fixture-provider.supports_websockets'],false);assert.match(start.params.developerInstructions,new RegExp(person.memberId));
    assert.equal(entry.env.AGENTROOM_MEMBER_ID==='foreign-fixture',false);
  }
  assert.equal(fs.readFileSync(path.join(f.authHome,'config.toml'),'utf8'),f.nativeConfig);
});

test('shared-cache protocol handshake verifies each member through its own deterministic MCP namespace',async t=>{
  const f=setup(t),a=f.member('member-a'),b=f.member('member-b');
  const handshake=person=>person.client.handshake({project:f.project,discussion:person.discussion,invitation:{id:person.discussion.id,nonce:'fixture-nonce'},onBinding:(state,threadId)=>{person.discussion.binding_state=state;if(threadId)person.discussion.thread_id=threadId;},onProgress:()=>{},signal:new AbortController().signal});
  const replies=await Promise.all([handshake(a),handshake(b)]);assert.ok(replies.every(reply=>reply.local_protocol_verified));
  const calls=f.calls().filter(call=>call.method==='mcpServer/tool/call');assert.equal(calls.length,2);
  for(const person of [a,b]){const call=calls.find(call=>call.params.threadId===person.discussion.thread_id);assert.equal(call.params.server,person.client.mcpServerName());assert.equal(call.params.arguments.invite_id,person.discussion.id);}
  assert.equal(f.calls().some(call=>call.method==='turn/start'),false);assert.equal(f.startups().length,1);
});

test('concurrent member turns and native approval responses remain on their registered threads',async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b'),approvalsA=[],approvalsB=[];
  const resultA=f.run(a,{hold:true,onApproval:message=>approvalsA.push(message.id)}),resultB=f.run(b,{hold:true,onApproval:message=>approvalsB.push(message.id)});
  resultA.catch(()=>{});resultB.catch(()=>{});await until(()=>f.calls().filter(call=>call.method==='turn/start').length===2);
  const emit=message=>a.client.call('fixture/emit',{message});
  await emit({id:'approval-a',method:'item/commandExecution/requestApproval',params:{threadId:a.discussion.thread_id,command:'fixture-a'}});
  await emit({id:'approval-b',method:'item/commandExecution/requestApproval',params:{threadId:b.discussion.thread_id,command:'fixture-b'}});
  await emit({id:'approval-foreign',method:'item/commandExecution/requestApproval',params:{threadId:id()}});
  await emit({id:'approval-missing',method:'item/commandExecution/requestApproval',params:{}});
  assert.deepEqual(approvalsA,['approval-a']);assert.deepEqual(approvalsB,['approval-b']);a.client.respond('approval-a',{decision:'accept'});b.client.respond('approval-b',{decision:'decline'});
  await b.client.call('fixture/complete',{threadId:b.discussion.thread_id,text:'only-b'});await a.client.call('fixture/complete',{threadId:a.discussion.thread_id,text:'only-a'});
  const [answerA,answerB]=await within(Promise.all([resultA,resultB]));assert.equal(answerA.answer,'only-a');assert.equal(answerB.answer,'only-b');assert.notEqual(answerA.threadId,answerB.threadId);
  const responses=f.responses();for(const requestId of ['approval-foreign','approval-missing']){const matches=responses.filter(response=>response.id===requestId);assert.equal(matches.length,1);assert.equal(matches[0].error.code,-32602);}
  assert.deepEqual(responses.find(response=>response.id==='approval-a').result,{decision:'accept'});assert.deepEqual(responses.find(response=>response.id==='approval-b').result,{decision:'decline'});assert.equal(f.startups().length,1);
});

test('closing an idle member leaves the other facade and its durable conversation usable',async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b');await Promise.all([f.bind(a),f.bind(b)]);const pid=b.client.child.pid,threadId=b.discussion.thread_id;
  await a.client.close();assert.equal(b.client.child.pid,pid);const reply=await f.run(b);assert.equal(reply.answer,'中文回答');assert.equal(reply.threadId,threadId);assert.equal(f.startups().length,1);
  await assert.rejects(a.client.ready(),{code:'cancelled'});assert.equal((await b.client.status()).connected,true);
});

test('closing a member settles and interrupts only its held turn without killing another member owner',async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b');
  const pendingA=f.run(a,{hold:true}).then(result=>({result}),error=>({error})),pendingB=f.run(b,{hold:true});pendingB.catch(()=>{});
  await until(()=>a.turnId&&b.turnId);const pid=b.client.child.pid;
  await within(a.client.close());const stopped=await within(pendingA);assert.equal(stopped.error?.code,'outcome_uncertain');assert.equal(b.client.child.pid,pid);
  await until(()=>f.calls().some(call=>call.method==='turn/interrupt'));
  const interrupts=f.calls().filter(call=>call.method==='turn/interrupt');assert.equal(interrupts.length,1);assert.equal(interrupts[0].params.threadId,a.discussion.thread_id);assert.ok(interrupts[0].params.turnId);
  await b.client.call('fixture/complete',{threadId:b.discussion.thread_id,text:'b-continues'});assert.equal((await within(pendingB)).answer,'b-continues');assert.equal(f.startups().length,1);
});

test('concurrent facade closes await the same owner shutdown instead of returning before it exits',async t=>{
  const f=setup(t),a=f.member('a');await a.client.ready();const owner=a.client.transport.owner,original=owner.close.bind(owner);let release;const gate=new Promise(resolve=>{release=resolve;});let closeCalls=0;
  owner.close=async()=>{closeCalls++;await gate;return original();};let firstDone=false,secondDone=false;
  const first=a.client.close().then(()=>{firstDone=true;}),second=a.client.close().then(()=>{secondDone=true;});
  try{await sleep(20);assert.equal(closeCalls,1);assert.equal(firstDone,false);assert.equal(secondDone,false);}
  finally{release();await within(Promise.all([first,second]));}
});

test('a shared native index remains authoritative when an old migration receipt is unverified',async t=>{
  const f=setup(t,{legacy:true}),a=f.member('a');await f.run(a);const threadId=a.discussion.thread_id,before=await a.client.read(threadId);
  fs.mkdirSync(path.join(f.sqliteHome,'imports'),{recursive:true});fs.writeFileSync(path.join(f.sqliteHome,'imports',threadId+'.json'),JSON.stringify({schema:'agentoffice.codex-import',thread_id:threadId,verified:false}));
  a.client.legacyClient=()=>assert.fail('shared native state must not reopen the legacy authentication owner');
  assert.equal((await a.client.inspectBound(f.project,a.discussion)).id,threadId);assert.equal(await f.bind(a),threadId);assert.deepEqual((await a.client.read(threadId)).turns,before.turns);
  assert.equal(f.calls().filter(call=>call.method==='thread/start').length,1);assert.equal(f.calls().some(call=>call.method==='thread/archive'),false);
});

test('an unverified migration copy or missing native path cannot resume or execute the saved shared-cache thread',async t=>{
  const f=setup(t,{legacy:true}),a=f.member('a');await f.run(a);const threadId=a.discussion.thread_id,native=await a.client.read(threadId);
  fs.mkdirSync(path.join(f.sqliteHome,'imports'),{recursive:true});fs.writeFileSync(path.join(f.sqliteHome,'imports',threadId+'.json'),JSON.stringify({schema:'agentoffice.codex-import',thread_id:threadId,verified:false}));
  const imported=path.join(f.sqliteHome,'sessions','agentoffice-imports','rollout-'+threadId+'.jsonl'),paths=[imported,undefined,'','sessions/agentoffice-imports/rollout-'+threadId+'.jsonl'];
  if(process.platform==='win32')paths.push('\\\\?\\'+imported);
  const before=f.calls().length;a.client.legacyClient=()=>assert.fail('a failed copy must not load the old authentication owner');
  for(const nativePath of paths){
    a.client.read=async()=>({...native,path:nativePath});
    await assert.rejects(a.client.inspectBound(f.project,a.discussion),{code:'codex_work_record_unavailable'});
    await assert.rejects(f.bind(a),{code:'codex_work_record_unavailable'});await assert.rejects(f.run(a),{code:'codex_work_record_unavailable'});
    assert.equal(a.discussion.thread_id,threadId);assert.equal(a.discussion.binding_state,'bound');
  }
  assert.equal(f.calls().slice(before).some(call=>['thread/start','thread/resume','thread/archive','turn/start'].includes(call.method)),false);
});

test('a native record with a different ID cannot resume a saved binding merely because its project matches',async t=>{
  const f=setup(t),a=f.member('a');await f.run(a);const saved=a.discussion.thread_id,native=await a.client.read(saved),before=f.calls().length;
  a.client.read=async()=>({...native,id:id()});
  await assert.rejects(a.client.inspectBound(f.project,a.discussion),{code:'project_mismatch'});await assert.rejects(f.bind(a),{code:'project_mismatch'});await assert.rejects(f.run(a),{code:'project_mismatch'});
  assert.equal(a.discussion.thread_id,saved);assert.equal(a.discussion.binding_state,'bound');assert.equal(f.calls().slice(before).some(call=>['thread/start','thread/resume','turn/start'].includes(call.method)),false);
});

test('a missing saved shared-cache thread preserves its binding and fails without creating a replacement',async t=>{
  const f=setup(t),a=f.member('a');a.discussion.thread_id=id();a.discussion.binding_state='bound';const saved=a.discussion.thread_id;
  a.client.legacyClient=()=>assert.fail('shared missing record must not launch an old authentication owner');
  await assert.rejects(f.bind(a),{code:'codex_work_record_unavailable'});await assert.rejects(a.client.inspectBound(f.project,a.discussion),{code:'codex_work_record_unavailable'});
  assert.equal(a.discussion.thread_id,saved);assert.equal(a.discussion.binding_state,'bound');assert.equal(f.calls().some(call=>['thread/start','thread/resume','thread/archive','turn/start'].includes(call.method)),false);
});

test('a full owner restart reopens the same private SQLite thread without creating personal history',async t=>{
  const f=setup(t,{legacy:true}),a=f.member('a');await f.run(a);const originalThread=a.discussion.thread_id,pid=a.client.child.pid;await a.client.close();
  const next=f.member('a');next.discussion={...a.discussion};const reply=await f.run(next);assert.equal(reply.threadId,originalThread);assert.notEqual(next.client.child.pid,pid);assert.equal((await next.client.read(originalThread)).turns.length,2);
  assert.equal(f.calls().filter(call=>call.method==='thread/start').length,1);assert.equal(f.startups().length,2);assert.equal(fs.existsSync(path.join(f.authHome,'sessions')),false);assert.equal(fs.existsSync(path.join(f.authHome,'rpc.jsonl')),false);
});

test('another AO private credential copy cannot become the origin of a fresh shared-cache client',async t=>{
  const f=setup(t,{legacy:true}),a=f.member('a',{dataDir:path.join(f.root,'other-data'),legacyHome:f.sqliteHome});
  assert.equal(a.client.authOwnershipStatus().blocked,true);await assert.rejects(a.client.ready(),{code:'codex_auth_ownership_required'});assert.equal(f.startups().length,0);assert.equal(a.client.child,null);
});

test('an authenticated provider route without an OpenAI account remains usable without a login or forced refresh',async t=>{
  const f=setup(t),a=f.member('a');await a.client.ready();fs.writeFileSync(path.join(f.sqliteHome,'fixture-account.json'),JSON.stringify({account:null,requiresOpenaiAuth:false}));
  const status=await a.client.status();assert.equal(status.signedIn,false);assert.equal(status.requiresOpenaiAuth,false);assert.equal(status.readyForRequests,true);
  const reply=await f.run(a);assert.equal(reply.answer,'中文回答');assert.ok(f.calls().filter(call=>call.method==='account/read').every(call=>call.params.refreshToken===false));assert.equal(f.calls().some(call=>/login|logout/.test(call.method)),false);
});

test('a personal MCP server colliding with the internal namespace fails before creating a new conversation',async t=>{
  const f=setup(t),a=f.member('a');await a.client.ready();const server=a.client.mcpServerName();
  fs.writeFileSync(path.join(f.sqliteHome,'fixture-config.json'),JSON.stringify({model_provider:'fixture-provider',mcp_servers:{[server]:{command:'foreign-fixture-command',env:{AGENTROOM_MEMBER_ID:'foreign'}}}}));
  await assert.rejects(f.bind(a),{code:'codex_mcp_config'});assert.equal(a.discussion.thread_id,null);assert.equal(f.calls().some(call=>call.method==='thread/start'),false);
});

test('authentication cache invalidation waits for every active member before replacing the shared process',async t=>{
  const f=setup(t),health=f.member('health'),b=f.member('b');await health.client.status();const pending=f.run(b,{hold:true});pending.catch(()=>{});await until(()=>b.turnId);const original=health.client.child.pid;
  health.client.invalidateAuthentication();assert.equal((await health.client.status()).connected,true);assert.equal(health.client.child.pid,original);assert.equal(f.startups().length,1);
  await health.client.call('fixture/complete',{threadId:b.discussion.thread_id,text:'before-reload'});assert.equal((await pending).answer,'before-reload');await health.client.status();assert.notEqual(health.client.child.pid,original);assert.equal(f.startups().length,2);
  const threadId=b.discussion.thread_id,continued=await f.run(b);assert.equal(continued.threadId,threadId);assert.equal(continued.answer,'中文回答');assert.equal(f.calls().filter(call=>call.method==='thread/start').length,1);
});

test('a real manual approval pauses only its facade deadline and its response resumes without replay',async t=>{
  const f=setup(t),a=f.member('a'),b=f.member('b'),approvals=[];let settled=false;
  const pending=f.run(a,{hold:true,timeout:1000,onApproval:message=>approvals.push(message.id)});pending.then(()=>{settled=true;},()=>{settled=true;});await b.client.ready();await until(()=>a.turnId);
  await b.client.call('fixture/emit',{message:{id:'manual-a',method:'item/commandExecution/requestApproval',params:{threadId:a.discussion.thread_id,turnId:a.turnId,command:'fixture-only'}}});assert.deepEqual(approvals,['manual-a']);
  await sleep(1100);assert.equal(settled,false,'waiting for a user must not expire the active execution deadline');
  a.client.respond('manual-a',{decision:'decline'});await b.client.call('fixture/complete',{threadId:a.discussion.thread_id,text:'after-choice'});assert.equal((await within(pending)).answer,'after-choice');
  assert.equal(f.calls().filter(call=>call.method==='turn/start').length,1);assert.equal(f.responses().filter(response=>response.id==='manual-a').length,1);assert.equal(b.client.closed,false);
});
