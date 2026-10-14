'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createBridge,DesktopGrok,GROK_NATIVE_CONTRACT,buildGrokNativeBootstrap,creationNonce,createGrokNativeDetachedBridge:create,correlateGrokTurn}=require('../src/desktop-grok.cjs');

function fixture({existing=true,failCreation=false,failSend=false}={}){
  const rows=new Map,transcripts=new Map,calls={create:[],send:[],read:[],cancel:[],retain:[],release:0};
  const privateConversation={id:'unrelated-current-user-bot',isRunning:true,content:'unrelated private text'};
  let currentId=existing?'actual-owned-bot':null,nonceCounter=0;
  function add(id){rows.set(id,{id,name:'Owned AO Bot',viewerIsOwner:true,isGroup:false,isRunning:false,isComposingMessage:false,awaitingUserResponse:null});transcripts.set(id,{loadState:'ready',isShowingRestoredTranscript:false,entries:[]});currentId=id;return rows.get(id);}
  if(existing)add(currentId);
  const client={boot:{get:()=>({status:'ready'})},roster:{
    agentNow(id){return rows.get(id)||null;},
    async createAgent(input){calls.create.push(input);if(failCreation)throw Object.assign(Error('create transport failed'),{code:'source_creation_uncertain'});const agent=rows.get(input.clientNonce)||add(input.clientNonce);return{agent};},
    async interruptAgentRun(input){calls.cancel.push(input);const row=rows.get(input.agentId),snapshot=transcripts.get(input.agentId),user=snapshot.entries.findLast(entry=>entry.role==='user');row.isRunning=false;row.lastTurnSettlement={clientNonce:user.clientNonce,settledAtMs:Date.now()+100,outcome:'cancelled'};}
  },transcript:{
    snapshotsFor(id,options){assert.ok(rows.has(id),'cannot read unrelated history');assert.equal(options.sessionId,'');calls.read.push(id);return{get:()=>transcripts.get(id)};},
    retain(id,options){assert.ok(rows.has(id));assert.equal(options.sessionId,'');calls.retain.push(id);return()=>{calls.release++;};}
  },sendJournal:{
    async sendPrompt(input){calls.send.push(input);assert.ok(rows.has(input.agentId));assert.ok(Array.isArray(input.attachments));assert.equal(input.attachments.length,0);const nonce=`native-nonce-${++nonceCounter}`;input.onNonceAssigned({nonce});if(failSend)throw Object.assign(Error('must not return arbitrary provider error text SECRET'),{failure:{code:'send/rejected'}});const row=rows.get(input.agentId);row.isRunning=true;transcripts.get(input.agentId).entries.push({id:`optimistic:${nonce}`,kind:'message',role:'user',clientNonce:nonce,content:input.prompt});}
  }};
  const options={contractVersion:GROK_NATIVE_CONTRACT.version,creationNonce:creationNonce('owned_person'),nativeChatId:currentId,personName:'AO 研究员',correlate:correlateGrokTurn};
  const bridge=create(client,options);
  function echo(){const snapshot=transcripts.get(currentId),optimistic=snapshot.entries.findLast(entry=>String(entry.id).startsWith('optimistic:'));assert.ok(optimistic);optimistic.id=`server-user-${nonceCounter}`;return optimistic;}
  function settle({outcome='success',streaming=false,content='Actual native Bot answer',nonce}={}){
    const user=transcripts.get(currentId).entries.findLast(entry=>entry.role==='user');
    rows.get(currentId).isRunning=streaming;rows.get(currentId).lastTurnSettlement={clientNonce:nonce||user.clientNonce,settledAtMs:Date.now()+100,outcome};
    if(outcome==='success')transcripts.get(currentId).entries.push({id:`server-assistant-${nonceCounter}`,kind:'message',role:'assistant',content,isStreaming:streaming});
  }
  return{client,bridge,rows,transcripts,privateConversation,calls,options,echo,settle,get nativeId(){return currentId;}};
}

test('explicit actual Bot is reused without selecting or reading the busy user conversation',async()=>{
  const f=fixture(),before=structuredClone(f.privateConversation),state=await f.bridge.initialize({nativeChatId:f.nativeId});
  assert.equal(state.detached,true);assert.equal(state.nativeChatId,'actual-owned-bot');assert.equal(f.calls.create.length,0);
  await f.bridge.send({nativeChatId:f.nativeId,requestId:'one',prompt:'Read-only AO question'});f.echo();f.settle();
  const done=f.bridge.query({requestId:'one',includeContent:true});assert.equal(done.status,'completed');assert.equal(done.nativeChatId,f.nativeId);assert.equal(done.replies[0].id,'server-assistant-1');
  assert.equal(done.replies[0].parentId,done.userMessageId);assert.equal(done.replies[0].parentId,'server-user-1');assert.equal(f.transcripts.get(f.nativeId).entries.at(-1).parentId,undefined,'parent provenance is normalized from exact native nonce proof, not a raw Grok parent link');
  assert.deepEqual(f.privateConversation,before);assert.equal(f.calls.release,1);assert.ok(f.calls.read.every(id=>id===f.nativeId));
});
test('person creation converges on fixed nonce and never kickstarts or chooses a same-name unrelated Bot',async()=>{
  const f=fixture({existing:false});const [first,second]=await Promise.all([f.bridge.initialize(),f.bridge.createPersonConversation()]);
  assert.equal(first.nativeChatId,second.nativeChatId);assert.equal(first.nativeChatId,f.options.creationNonce);assert.equal(f.calls.create.length,1);
  assert.equal(f.calls.create[0].isKickstartRequested,false);assert.equal(f.calls.create[0].clientNonce,f.options.creationNonce);
  const fresh=create(f.client,{...f.options,nativeChatId:null});assert.equal((await fresh.initialize()).nativeChatId,first.nativeChatId);assert.equal(f.calls.create.length,1);
  assert.equal(creationNonce('owned_person'),creationNonce('owned_person'));assert.notEqual(creationNonce('other_person'),f.options.creationNonce);
});
test('uncertain creation is not automatically reissued',async()=>{
  const f=fixture({existing:false,failCreation:true});await assert.rejects(f.bridge.initialize(),/create transport failed/);await assert.rejects(f.bridge.initialize(),/create transport failed/);assert.equal(f.calls.create.length,1);assert.equal(f.bridge.inspect().creationUncertain,true);
});
test('same request concurrently or after completion never resends and conflicting bodies fail',async()=>{
  const f=fixture();await Promise.all([f.bridge.send({requestId:'same',prompt:'same body'}),f.bridge.send({requestId:'same',prompt:'same body'})]);assert.equal(f.calls.send.length,1);
  f.echo();f.settle();assert.equal(f.bridge.query({requestId:'same'}).status,'completed');await f.bridge.send({requestId:'same',prompt:'same body'});assert.equal(f.calls.send.length,1);
  await assert.rejects(f.bridge.send({requestId:'same',prompt:'different body'}),/REQUEST_ID_CONFLICT/);
});
test('acceptance, optimistic echo, idle and foreign settlement cannot substitute for actual final native reply',async()=>{
  const f=fixture();const send=await f.bridge.send({requestId:'exact',prompt:'one question'});assert.equal(send.nativeRequestId,'native-nonce-1');assert.equal(f.bridge.query({requestId:'exact'}).status,'sending');
  f.rows.get(f.nativeId).isRunning=false;assert.equal(f.bridge.query({requestId:'exact'}).status,'sending');f.echo();f.settle({nonce:'other-conversation-nonce'});assert.equal(f.bridge.query({requestId:'exact'}).status,'running');
  f.rows.get(f.nativeId).lastTurnSettlement.clientNonce='native-nonce-1';f.transcripts.get(f.nativeId).entries.at(-1).isStreaming=true;assert.equal(f.bridge.query({requestId:'exact'}).status,'running');
  f.transcripts.get(f.nativeId).entries.at(-1).isStreaming=false;assert.equal(f.bridge.query({requestId:'exact',includeContent:true}).status,'completed');
});
test('native settlement correlation is independent of controller-host clock skew and rejects the pre-send settlement',async()=>{
  const f=fixture();await f.bridge.send({requestId:'clock-skew',prompt:'exact nonce'});f.echo();f.settle();
  const agent=f.rows.get(f.nativeId);agent.lastTurnSettlement.settledAtMs=Date.now()-60000;
  assert.equal(f.bridge.query({requestId:'clock-skew'}).status,'completed');
  const result=correlateGrokTurn({agentId:f.nativeId,clientNonce:agent.lastTurnSettlement.clientNonce,baselineSettlementKey:`${agent.lastTurnSettlement.clientNonce}:${agent.lastTurnSettlement.settledAtMs}`,agent,snapshot:f.transcripts.get(f.nativeId)});
  assert.equal(result.status,'awaiting_correlated_settlement');
});
test('stale, empty and later-task replies cannot complete the owned original',async()=>{
  const f=fixture();await f.bridge.send({requestId:'first',prompt:'first'});f.echo();f.settle({content:''});assert.equal(f.bridge.query({requestId:'first'}).status,'running');
  const snapshot=f.transcripts.get(f.nativeId);snapshot.entries.push({id:'human-next',kind:'message',role:'user',clientNonce:'human-next-nonce'});snapshot.entries.push({id:'human-reply',kind:'message',role:'assistant',content:'Other task answer',isStreaming:false});assert.equal(f.bridge.query({requestId:'first'}).status,'running');
  snapshot.isShowingRestoredTranscript=true;assert.equal(f.bridge.query({requestId:'first'}).status,'running');assert.equal(f.bridge.query({requestId:'first',includeContent:true}).replies,undefined);
});
test('native failures and action requirements remain failures rather than empty successful replies',async()=>{
  const f=fixture();await f.bridge.send({requestId:'error',prompt:'error'});f.echo();f.settle({outcome:'error'});assert.equal(f.bridge.query({requestId:'error',includeContent:true}).status,'error');assert.equal(f.bridge.query({requestId:'error',includeContent:true}).replies,undefined);
  const rejected=fixture({failSend:true});await rejected.bridge.send({requestId:'rejected',prompt:'rejected'});await new Promise(resolve=>setImmediate(resolve));const result=rejected.bridge.query({requestId:'rejected',includeContent:true});assert.equal(result.status,'error');assert.equal(result.error.code,'send/rejected');assert.doesNotMatch(JSON.stringify(result),/SECRET/);
  const blocked=fixture();await blocked.bridge.send({requestId:'blocked',prompt:'blocked'});blocked.echo();blocked.settle();blocked.rows.get(blocked.nativeId).awaitingUserResponse={kind:'user-form'};assert.equal(blocked.bridge.query({requestId:'blocked'}).status,'incomplete');
});
test('another request cannot steer an in-progress owned Bot or replace its actual identity',async()=>{
  const f=fixture();await f.bridge.send({requestId:'active',prompt:'active'});await assert.rejects(f.bridge.send({requestId:'other',prompt:'other'}),/TURN_IN_PROGRESS/);
  await assert.rejects(f.bridge.send({nativeChatId:'unrelated-current-user-bot',requestId:'wrong',prompt:'wrong'}),/IDENTITY_MISMATCH/);assert.equal(f.calls.send.length,1);
});
test('cancellation is only issued for the latest echoed owned nonce and requires native cancellation settlement',async()=>{
  const f=fixture();await f.bridge.send({requestId:'cancel',prompt:'cancel'});await assert.rejects(f.bridge.cancel({requestId:'foreign'}),/IDENTITY_MISMATCH/);await assert.rejects(f.bridge.cancel({requestId:'cancel'}),/CORRELATION_MISMATCH/);
  f.echo();assert.equal((await f.bridge.cancel({requestId:'cancel'})).status,'cancelled');assert.deepEqual(f.calls.cancel,[{agentId:f.nativeId,sessionId:''}]);
  const other=fixture();await other.bridge.send({requestId:'own',prompt:'own'});other.echo();other.transcripts.get(other.nativeId).entries.push({id:'human-new',kind:'message',role:'user',clientNonce:'human-new'});await assert.rejects(other.bridge.cancel({requestId:'own'}),/CORRELATION_MISMATCH/);assert.equal(other.calls.cancel.length,0);
});
test('an acknowledged interrupt without corresponding native cancelled settlement never claims cancellation',async()=>{
  const f=fixture();f.client.roster.interruptAgentRun=async input=>{f.calls.cancel.push(input);return{};};
  await f.bridge.send({requestId:'unconfirmed-stop',prompt:'stop'});f.echo();
  const result=await f.bridge.cancel({requestId:'unconfirmed-stop'});assert.equal(result.status,'running');assert.equal(result.cancelRequested,true);assert.equal(f.calls.release,0);
});

function remoteFixture({badSource=false,wrongHost=false}={}){
  const f=fixture(),entry=`file:///C:/Grok/resources/app.asar/dist/renderer/assets/${GROK_NATIVE_CONTRACT.entryFile}`;
  const root={'__reactContainer$fixture':{stateNode:{current:{child:{memoizedProps:{client:f.client}}}}}};
  const context=vm.createContext({URL,location:{href:wrongHost?'https://foreign.invalid/renderer/index.html':'file:///C:/Grok/resources/app.asar/dist/renderer/index.html'},document:{title:'Grok Bot',scripts:[{src:entry}],getElementById:id=>id==='root'?root:null},fetch:async url=>({ok:true,arrayBuffer:async()=>Uint8Array.of(url.endsWith(GROK_NATIVE_CONTRACT.entryFile)?1:2).buffer}),crypto:{subtle:{digest:async(_algorithm,bytes)=>Uint8Array.from(Buffer.from(badSource?'00'.repeat(32):new Uint8Array(bytes)[0]===1?GROK_NATIVE_CONTRACT.entrySha256:GROK_NATIVE_CONTRACT.appSha256,'hex')).buffer}}});
  const expressions=[],cdp={async evaluate(expression){expressions.push(expression);return vm.runInContext(expression,context);}};
  return{...f,context,cdp,expressions};
}
test('driver bootstrap verifies loaded local source before binding and matches manager send/snapshot contract',async()=>{
  const f=remoteFixture(),driver=createBridge(f.cdp,{runtimeKey:'owned_person',nativeChatId:f.nativeId,personName:'AO 人物'});
  assert.equal((await driver.initialize()).nativeChatId,f.nativeId);await driver.send(f.nativeId,{requestId:'manager-one',prompt:'Actual request'});f.echo();f.settle();
  const result=await driver.snapshot('manager-one',{includeContent:true});assert.equal(result.status,'completed');assert.equal(result.userMessageId,'server-user-1');assert.equal(result.replies[0].done,true);
  assert.equal(result.replies[0].parentId,result.userMessageId);
  assert.equal((await driver.createPersonConversation()).nativeChatId,f.nativeId);assert.equal(f.calls.create.length,0);
  await assert.rejects(driver.send('another-bot',{requestId:'wrong',prompt:'wrong'}),/IDENTITY_MISMATCH/);assert.equal(f.calls.send.length,1);
});
test('changed source or foreign host fails before any creation or model dispatch',async()=>{
  for(const options of[{badSource:true},{wrongHost:true}]){const f=remoteFixture(options),driver=createBridge(f.cdp,{runtimeKey:'owned_person',nativeChatId:f.nativeId});await assert.rejects(driver.initialize(),/SOURCE_VERSION_MISMATCH|HOST_IDENTITY_MISMATCH/);assert.equal(f.calls.send.length,0);assert.equal(f.calls.create.length,0);}
  assert.throws(()=>buildGrokNativeBootstrap({runtimeKey:'malicious"key'}),/RUNTIME_KEY_INVALID/);assert.throws(()=>new DesktopGrok({runtimeKey:'one'}),/EVALUATOR_REQUIRED/);assert.equal(GROK_NATIVE_CONTRACT.liveVerified,false);
});
