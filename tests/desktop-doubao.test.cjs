'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {createBridge,DesktopDoubao,DOUBAO_NATIVE_CONTRACT,DOUBAO_NATIVE_PREPARATION,findDoubaoModule,createDoubaoNativeBridge,buildDoubaoNativeBootstrap,
  prepareDoubaoNativeRuntime,buildDoubaoNativePreparation,buildDoubaoNativeRegistration,captureDoubaoRuntime,verifyDoubaoNativeFactories,prepareDoubaoNativeFactories,applyDoubaoNativeFactories}=require('../src/desktop-doubao.cjs');
const {RoomError}=require('../src/util.cjs');

function fixture({createFailure=false,sendFailure=false,swallowStop=false}={}) {
  const calls=[],infos=new Map(),ownership=new Map();
  const visible={chatId:'human-visible-chat',composer:'human unsent draft'};
  const state={messageMap:{private:{secret:{conversation_id:'private',user_type:2,message_id:'secret',content_obj:{text:'private content'}}}},localMessageMap:{}};
  let serial=0,account='fixture-native-account';
  const api={
    createConversation:async({botId})=>{
      calls.push({create:botId});
      if(createFailure)throw Error('private fixture error');
      const conversationId='native-'+ ++serial;
      infos.set(conversationId,{conversation_id:conversationId,bot_id:botId,conversation_type:2});
      return {conversationId};
    },
    createSendMessageConversationContext:id=>({...infos.get(id)}),
    getInfoByConversationId:id=>({conversation:infos.get(id)}),MAIN_BOT_ID:'native-default-bot',
  };
  const exports={
    17:api,
    29:{getChatService:async name=>({getMessageService:()=>({sendMessage:async data=>{
      calls.push({send:name,data});if(sendFailure)throw Error('raw private native error');
      const outgoing=data.messages[0],chat=outgoing.conversation_id;
      const local=state.localMessageMap[chat]||(state.localMessageMap[chat]={});
      const remote=state.messageMap[chat]||(state.messageMap[chat]={});
      const messageId='user-'+outgoing.local_message_id;
      local[outgoing.local_message_id]={...outgoing,user_type:1,message_id:messageId,local:{},create_time:serial};
      remote[messageId]={...outgoing,user_type:1,message_id:messageId,index:String(Object.keys(remote).length+1)};
    }})}),getChatStore:()=>{}},
    41:{createSendMessage:({conversationContext,message})=>({...conversationContext,...message,local_message_id:message.unique_id}),combineBlocks:({textBlock})=>[textBlock]},
    53:{mapTextToTextBlock:value=>({content:{text_block:{text:value}}})},
    67:{useMessageStore:{getState:()=>state}},
    71:{fetchUpdateConversationInfo:async id=>{
      calls.push({fetch:id});if(!infos.has(id))infos.set(id,{conversation_id:id,bot_id:'native-default-bot',conversation_type:2});return infos.get(id);
    }},
    83:{z:row=>row.ext?.is_finish==='1'&&row.nativeStreaming!==true&&row.async_task?.status!==1},
    97:{MessageBreak:async args=>{
      calls.push({cancel:args});
      if(!swallowStop){const bucket=state.messageMap[args.conversation_id]||{};for(const row of Object.values(bucket))if(row.reply_id===args.reply_id){row.ext={...row.ext,is_interrupted:'true'};row.final_status={message:'Broken'};}}
      return {code:0,msg:'fixture success'};
    }},
    101:{n5:()=>account,bG:()=>({})},
  };
  const req=id=>{calls.push({require:id});if(!(id in exports))throw Error('fixture missing require');return exports[id];};
  req.m={
    17:function(module,exports,req){req.d(exports,{createConversation:()=>0,createSendMessageConversationContext:()=>0,getInfoByConversationId:()=>0,MAIN_BOT_ID:()=>0});},
    29:function(module,exports,req){req.d(exports,{getChatService:()=>0,getChatStore:()=>0});},
    41:function(module,exports,req){req.d(exports,{createSendMessage:()=>0,combineBlocks:()=>0});},
    53:function(module,exports,req){req.d(exports,{mapTextToTextBlock:()=>0});},
    67:function(module,exports,req){req.d(exports,{useMessageStore:()=>0});return 'useMessageStore is not initialized';},
    71:function(module,exports,req){req.d(exports,{fetchUpdateConversationInfo:()=>0});return 'updateConversationInfo: invalid data from api';},
    83:function(module,exports,req){req.d(exports,{z:()=>0});return 'PushMessageStatus.Streaming is_finish async_task';},
    97:function(module,exports,req){req.d(exports,{MessageBreak:()=>0});return 'reply_msg_id break_reason';},
    101:function(module,exports,req){req.d(exports,{n5:()=>0,bG:()=>0});return 'user_id_str isUserInfoLoaded';},
  };
  const options={contractVersion:DOUBAO_NATIVE_CONTRACT.version,runtimeKey:'person_fixture'};
  const bridge=createDoubaoNativeBridge(req,options,ownership);
  function reply(requestId,{done=true,content='fixture answer',chatId='native-1',id='assistant-'+requestId,interrupted=false,streaming=false,asyncRunning=false,error=false,parent='user-'+requestId}={}) {
    const bucket=state.messageMap[chatId]||(state.messageMap[chatId]={});
    bucket[id]={conversation_id:chatId,user_type:2,message_id:id,reply_id:parent,index:String(Object.keys(bucket).length+1),
      content_obj:{text:content},ext:{is_finish:done?'1':'0',...interrupted?{is_interrupted:'true'}:{}},nativeStreaming:streaming,
      ...asyncRunning?{async_task:{status:1}}:{},...error?{error_details:{error_code:'fixture_failure',private:'private error details'}}:{}};
    return bucket[id];
  }
  return {bridge,calls,infos,state,visible,exports,req,ownership,reply,options,setAccount:value=>{account=value;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const sends=f=>f.calls.filter(call=>call.send);
function rendererFixture(f,registry) {
  let captured=0;const chunks=[];chunks.push=([,,resolve])=>{captured++;resolve(f.req);};
  const window={webpackChunkflow_web_extension:chunks};
  if(registry)window[Symbol.for('agentoffice.doubao.native.v1')]=registry;
  const context=vm.createContext({window,location:{protocol:'doubao:',hostname:'doubao-chat',pathname:'/chat/'},
    crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  return {cdp:{evaluate:code=>vm.runInContext(code,context)},window,captured:()=>captured};
}
async function legacyFixture(patch={}) {
  const f=fixture();await f.bridge.initialize();const state=f.bridge.inspect();
  const legacyState={...state,requests:0};
  const legacy={inspect:()=>({...legacyState,...patch}),initialize:input=>f.bridge.initialize(input)};
  const registry={contract:DOUBAO_NATIVE_CONTRACT.version,bridges:new Map([[f.options.runtimeKey,legacy]]),ownership:f.ownership};
  return {f,state,legacy,registry,...rendererFixture(f,registry)};
}

function preparationFixture({ready=false}={}) {
  const f=fixture(),events=[],factories={...f.req.m};
  const kinds=['conversations','services','messages','text','messageStore','conversationInfo','complete','identity'];
  const factorySha256=Object.fromEntries(kinds.map(kind=>[kind,createHash('sha256').update(findDoubaoModule(f.req,kind).source).digest('hex')]));
  const resources=DOUBAO_NATIVE_PREPARATION.chunks.map(chunk=>{
    const id=chunk.kind==='services'?29:17;
    const source=`"use strict";window['@flow-web/desktop:stable'].push([[${JSON.stringify(chunk.id)}],{${id}:${factories[id].toString()}}]);`;
    return {...chunk,source,sha256:createHash('sha256').update(source).digest('hex')};
  });
  const qualification={contractVersion:DOUBAO_NATIVE_CONTRACT.version,runtimeGlobal:DOUBAO_NATIVE_PREPARATION.runtimeGlobal,
    chunks:resources.map(({source,...chunk})=>chunk),factorySha256,externalModuleIds:[]};
  f.req.p='/';f.req.u=id=>resources.find(chunk=>chunk.id===id)?.path;
  f.req.e=async()=>{events.push('unverified-second-read');throw Error('req.e must not read another resource');};
  if(!ready){delete f.req.m[17];delete f.req.m[29];}
  const chunks=[];chunks.push=([ids,modules,resolve])=>{
    if(resolve){events.push('capture');resolve(f.req);return;}
    events.push('register-'+ids[0]);Object.assign(f.req.m,modules);
  };
  let fetchImpl=async(path,options)=>{
    const resource=resources.find(chunk=>'/'+chunk.path===path);events.push('fetch-'+resource.id);
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const bytes=Uint8Array.from(Buffer.from(resource.source));
    return {ok:true,redirected:false,arrayBuffer:async()=>bytes.buffer};
  };
  const context=vm.createContext({window:{'@flow-web/desktop:stable':chunks},req:f.req,qualification,
    location:{protocol:'chrome:',hostname:'doubao-chat',pathname:'/chat/'},crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout,
    fetch:(...args)=>fetchImpl(...args)});
  const shared=`const findDoubaoModule=${findDoubaoModule.toString()};const verifyDoubaoNativeFactories=${verifyDoubaoNativeFactories.toString()};`;
  const read=()=>vm.runInContext(`(async()=>{${shared}const prepareDoubaoNativeFactories=${prepareDoubaoNativeFactories.toString()};return prepareDoubaoNativeFactories(req,qualification);})()`,context);
  const apply=proof=>vm.runInContext(`(async()=>{${shared}const applyDoubaoNativeFactories=${applyDoubaoNativeFactories.toString()};const registrations={${proof.sources.map(entry=>`${JSON.stringify(entry.id)}:()=>{${entry.source}\n}`).join(',')}};return applyDoubaoNativeFactories(req,qualification,registrations);})()`,context);
  return {f,events,resources,qualification,context,read,apply,setFetch:fn=>{fetchImpl=fn;}};
}

function settledRenderer(cdp) {
  return {evaluate:async code=>{try{return await cdp.evaluate(code);}catch{throw new RoomError('native evaluation ended with an exception',502,'desktop_contract_mismatch');}}};
}

// Exact installed 773581 source from s2-plugins-message-lifecycle. Both approved
// hashes differ only in minifier binding names, not fields, imports, or calls.
const nativeInfoFactory=function(e,t,n){n.d(t,{fetchUpdateConversationInfo:()=>d});var i=n(341889),r=n(935264),a=n(277645),o=n(497965),s=n(71834),c=n(706179),l=n(201944);async function d(e,t,n){let{prevActiveConversationId:d,mainConversationLink:u,localConversationMap:_}=s.NW.getState(),g=(0,o.zQ)({eventName:"load_conversation_info",meta:{cold_start:!d,conversation_id:e,main_conversation_id:u?.conversationId,scene:t}});if(_[e]?.local){g.error({reason:"local_conversation_id",error:Error("local_conversation_id")});return}try{let{data:t}=await (0,a.xK)(async()=>(0,c.Y)({conversation_id:e,ext:{...d?{}:{cold_start:"true"},...n}}).then(e=>{if(!e.data?.conversation?.conversation_id)throw Error("invalid conversationInfo");return e}),3,e=>500*e,e=>{if((0,r.k)(e)&&"710012002"===String(e?.errorOption?.code))throw i.v.emit("chat.user.logoutToSignIn"),e}),{conversation:o}=t||{};if(!t)throw Error("updateConversationInfo: invalid data from api");return g.addDurationPoint("success"),g.success(),await (0,l.r)(t),o}catch(t){throw g.error({reason:"load_conversation_info_failed",error:t,meta:{latest_main_conversation_id:s.NW.getState().mainConversationLink?.conversationId,is_in_conversation_map:s.NW.getState().conversationMap[e]?"1":"0"}}),t}}};
function nativeInfoVariant() {
  const names={i:'r',r:'i',a:'o',o:'a',l:'u',d:'l',u:'d'},source=nativeInfoFactory.toString();let renamed='',at=0;
  while(at<source.length){const char=source[at],code=char.charCodeAt(0);
    if(code===34||code===39){let end=at+1;while(end<source.length){if(source.charCodeAt(end)===92){end+=2;continue;}if(source.charCodeAt(end++)===code)break;}
      renamed+=source.slice(at,end);at=end;continue;}
    if(/[A-Za-z_$]/.test(char)){let end=at+1;while(end<source.length&&/[A-Za-z0-9_$]/.test(source[end]))end++;const word=source.slice(at,end);
      renamed+=source[at-1]==='.'&&source.slice(at-3,at)!=='...'?word:(names[word]||word);at=end;continue;}
    renamed+=char;at++;
  }
  return vm.runInNewContext('('+renamed+')');
}

test('the two qualified native info variants keep one canonical preparation map across cold and warm loading',async()=>{
  const variants=[nativeInfoFactory,nativeInfoVariant()],approved=DOUBAO_NATIVE_PREPARATION.factorySha256.conversationInfo;
  assert.deepEqual(variants.map(factory=>createHash('sha256').update(factory.toString()).digest('hex')).sort(),Array.from(approved));
  const p=preparationFixture({ready:true});p.qualification.factorySha256.conversationInfo=Array.from(approved);
  p.f.req.m[71]=variants[0];const cold=await p.apply(await p.read());
  p.f.req.m[71]=variants[1];const warm=await p.apply(await p.read());
  assert.equal(JSON.stringify(cold.factorySha256),JSON.stringify(warm.factorySha256));assert.deepEqual(p.f.calls,[]);
});

test('info allowlists normalize order but cannot expand or shrink a cached source identity',async()=>{
  const f=fixture();f.req.m[71]=nativeInfoFactory;const approved=Array.from(DOUBAO_NATIVE_PREPARATION.factorySha256.conversationInfo);
  const bridge=createDoubaoNativeBridge(f.req,{...f.options,factorySha256:{conversationInfo:approved}});
  const oldCrypto=global.crypto;Object.defineProperty(global,'crypto',{configurable:true,value:webcrypto});
  try {await bridge.initialize();}finally{Object.defineProperty(global,'crypto',{configurable:true,value:oldCrypto});}
  bridge.assertSourceIdentity({conversationInfo:[...approved].reverse()});
  assert.throws(()=>bridge.assertSourceIdentity({conversationInfo:[approved[0]]}),/SOURCE_IDENTITY_CONFIG_CHANGED/);
  assert.throws(()=>bridge.assertSourceIdentity({conversationInfo:[approved[0],'0'.repeat(64)]}),/INVALID_SOURCE_IDENTITY/);
  assert.throws(()=>bridge.assertSourceIdentity({}),/SOURCE_IDENTITY_CONFIG_CHANGED/);
  assert.equal(f.calls.filter(call=>call.create).length,1);
});

test('unknown info factory and noncatalog hash in an array reject before business module execution',async()=>{
  const f=fixture(),approved=Array.from(DOUBAO_NATIVE_PREPARATION.factorySha256.conversationInfo);
  assert.throws(()=>createDoubaoNativeBridge(f.req,{...f.options,factorySha256:{conversationInfo:[approved[0],'0'.repeat(64)]}}),/INVALID_SOURCE_IDENTITY/);
  const bridge=createDoubaoNativeBridge(f.req,{...f.options,factorySha256:{conversationInfo:approved}});
  const oldCrypto=global.crypto;Object.defineProperty(global,'crypto',{configurable:true,value:webcrypto});
  try {await assert.rejects(bridge.initialize(),/SOURCE_IDENTITY_MISMATCH/);}finally{Object.defineProperty(global,'crypto',{configurable:true,value:oldCrypto});}
  assert.deepEqual(f.calls,[]);
});

test('native preparation executes only the exact hashed bytes and never requests a second resource or model',async()=>{
  const p=preparationFixture();const proof=await p.read();
  assert.equal(proof.sources.length,2);assert.equal(p.events.some(event=>event.startsWith('register-')),false);
  // A second fetch would return a different, side-effecting resource. Applying
  // the first verified bytes must not call that fetch or req.e at all.
  p.setFetch(async()=>{throw Error('unverified second fetch');});
  const prepared=await p.apply(proof);
  assert.equal(prepared.runtimeGlobal,'@flow-web/desktop:stable');
  assert.deepEqual(p.events,['fetch-93166','fetch-9365','register-93166','register-9365']);
  assert.deepEqual(p.f.calls,[]);assert.equal(p.f.bridge.inspect().nativeChatId,null);
  assert.equal(findDoubaoModule(p.f.req,'services').id,29);assert.equal(findDoubaoModule(p.f.req,'conversations').id,17);
});

test('bad chunk bytes and changed asset paths fail before any native chunk registration',async()=>{
  const p=preparationFixture();p.setFetch(async()=>({ok:true,redirected:false,arrayBuffer:async()=>new TextEncoder().encode('changed resource').buffer}));
  await assert.rejects(p.read(),/PREPARATION_UNSUPPORTED_SOURCE/);
  assert.equal(p.events.some(event=>event.startsWith('register-')),false);assert.deepEqual(p.f.calls,[]);
  const path=preparationFixture();path.f.req.u=()=> 'https://unknown.example/chunk.js';
  await assert.rejects(path.read(),/PREPARATION_UNSUPPORTED_SOURCE/);assert.deepEqual(path.events,[]);assert.deepEqual(path.f.calls,[]);
});

test('unknown already-loaded sources and post-registration core changes cannot be qualified',async()=>{
  const p=preparationFixture({ready:true});p.f.req.m[29]=function(m,e,r){r.d(e,{getChatService:()=>1,getChatStore:()=>1});};
  await assert.rejects(p.read(),/PREPARATION_UNSUPPORTED_SOURCE/);assert.deepEqual(p.events,[]);assert.deepEqual(p.f.calls,[]);
  const changed=preparationFixture(),proof=await changed.read();
  const chunks=changed.context.window['@flow-web/desktop:stable'],push=chunks.push;
  chunks.push=record=>{push(record);changed.f.req.m[41]=function(m,e,r){r.d(e,{createSendMessage:()=>1,combineBlocks:()=>1});};};
  await assert.rejects(changed.apply(proof),/PREPARATION_UNSUPPORTED_SOURCE/);assert.deepEqual(changed.f.calls,[]);
});

test('an already-qualified runtime skips registration and still rejects a later source change',async()=>{
  const p=preparationFixture({ready:true});const proof=await p.read();assert.equal(proof.sources.length,0);
  await p.apply(proof);assert.deepEqual(p.events,['fetch-93166','fetch-9365']);
  p.f.req.m[41]=function(m,e,r){r.d(e,{createSendMessage:()=>2,combineBlocks:()=>2});};
  await assert.rejects(p.read(),/PREPARATION_UNSUPPORTED_SOURCE/);assert.deepEqual(p.f.calls,[]);
});

test('missing known dependencies refuse preparation without guessing a business require',async()=>{
  const p=preparationFixture();p.qualification.externalModuleIds=[999999];
  await assert.rejects(p.read(),/PREPARATION_DEPENDENCY_MISSING/);assert.deepEqual(p.events,[]);assert.deepEqual(p.f.calls,[]);
});

test('runtime capture reuses only its namespace and preparation refuses an extension-only target',async()=>{
  const f=fixture(),{cdp,window}=rendererFixture(f);
  await assert.rejects(cdp.evaluate(buildDoubaoNativePreparation()),/PREPARATION_UNSUPPORTED_RUNTIME/);assert.deepEqual(f.calls,[]);
  let captures=0;const chunks=[];chunks.push=([,,resolve])=>{captures++;resolve(f.req);};window['@flow-web/desktop:stable']=chunks;
  const expression=`(async()=>{const captureDoubaoRuntime=${captureDoubaoRuntime.toString()};return (await captureDoubaoRuntime('@flow-web/desktop:stable')).runtimeGlobal;})()`;
  assert.equal(await cdp.evaluate(expression),'@flow-web/desktop:stable');await cdp.evaluate(expression);assert.equal(captures,1);
  window['@flow-web/desktop:stable']=[];await assert.rejects(cdp.evaluate(expression),/PREPARATION_RUNTIME_CHANGED/);assert.deepEqual(f.calls,[]);
});

test('public preparation fixes all eight pins and rejects source substitution before its execution phase',async()=>{
  const state={contractVersion:DOUBAO_NATIVE_CONTRACT.version,runtimeGlobal:DOUBAO_NATIVE_PREPARATION.runtimeGlobal,factorySha256:{...DOUBAO_NATIVE_PREPARATION.factorySha256}};
  const calls=[];const transport={evaluate:async code=>{calls.push(code);return calls.length===1?{...state,profileId:'legacy',sources:[]}:state;}};
  const prepared=await prepareDoubaoNativeRuntime(transport);assert.deepEqual(prepared,state);assert.equal(calls.length,2);
  assert.equal(calls[1].includes('req.e('),false);assert.equal(prepared.runtimeKey,undefined);assert.equal(prepared.nativeChatId,undefined);
  const badCalls=[];await assert.rejects(prepareDoubaoNativeRuntime({evaluate:async code=>{badCalls.push(code);return {...state,profileId:'legacy',sources:[{id:'9365',source:'throw Error("untrusted resource")'}]};}}),{code:'desktop_adapter_unsupported'});
  assert.equal(badCalls.length,1);
  assert.throws(()=>buildDoubaoNativeRegistration([{id:'unknown',source:'x'}]),{code:'desktop_adapter_unsupported'});
});

for(const [profileId,file] of [['current','doubao-native-2.33.3.json'],['currentRefresh','doubao-native-2.33.3-refresh.json']])test(`${profileId} Doubao profile pins reach the native bridge and reject an unknown or mixed profile`,async()=>{
  const q=require('../src/'+file);
  const state={contractVersion:q.contractVersion,runtimeGlobal:q.runtimeGlobal,factorySha256:q.factorySha256};
  let calls=0;
  const value=await prepareDoubaoNativeRuntime({evaluate:async()=>++calls===1?{...state,profileId,sources:[]}:state});
  assert.deepEqual(value,state);assert.equal(calls,2);
  const f=fixture(),bridge=createDoubaoNativeBridge(f.req,{...f.options,...value});
  bridge.assertSourceIdentity(q.factorySha256);
  await assert.rejects(bridge.initialize(),/SOURCE_IDENTITY_MISMATCH/,'fixture factories must still fail the real source hash check');
  for(const bad of [{profileId:'unknown'},{profileId:'legacy'},{profileId:'current',factorySha256:{...q.factorySha256,messages:'unqualified'}}]){
    calls=0;await assert.rejects(prepareDoubaoNativeRuntime({evaluate:async()=>{calls++;return {...state,sources:[],...bad};}}),{code:'desktop_adapter_unsupported'});assert.equal(calls,1);
  }
  assert.throws(()=>buildDoubaoNativeRegistration([{id:q.chunks[0].id,source:'window.runBusinessSideEffect()'}],profileId),{code:'desktop_adapter_unsupported'});
});

test('prepared drivers select stable with a simultaneous extension and preserve the cached namespace',async()=>{
  const f=fixture(),other=fixture();const main=[],extension=[];
  main.push=([,,resolve])=>resolve(f.req);extension.push=([,,resolve])=>resolve(other.req);
  const context=vm.createContext({window:{'@flow-web/desktop:stable':main,webpackChunkflow_web_extension:extension},
    location:{protocol:'chrome:',hostname:'doubao-chat',pathname:'/chat/'},crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  const cdp={evaluate:code=>vm.runInContext(code,context)};
  const driver=createBridge(cdp,{runtimeKey:'native-prepared',runtimeGlobal:'@flow-web/desktop:stable'});await driver.initialize();
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.deepEqual(other.calls,[]);
  await assert.rejects(createBridge(cdp,{runtimeKey:'native-prepared',runtimeGlobal:'webpackChunkflow_web_extension'}).initialize(),/PREPARATION_UNSUPPORTED_RUNTIME/);
  assert.deepEqual(other.calls,[]);
  delete context.window['@flow-web/desktop:stable'];
  await assert.rejects(createBridge(cdp,{runtimeKey:'other-key',runtimeGlobal:'@flow-web/desktop:stable'}).initialize(),/PREPARATION_UNSUPPORTED_RUNTIME/);assert.deepEqual(other.calls,[]);
});

test('native creation acknowledgement loss carries uncertainty without retrying or inventing a server ID',async()=>{
  const f=fixture();f.exports[17].createConversation=async({botId})=>{
    f.calls.push({create:botId});f.infos.set('server-created-with-lost-ack',{conversation_id:'server-created-with-lost-ack',bot_id:botId});
    throw Error('acknowledgement lost after server creation');
  };
  const {cdp}=rendererFixture(f),driver=createBridge(settledRenderer(cdp),{runtimeKey:f.options.runtimeKey});
  await assert.rejects(driver.initialize(),error=>error.uncertain===true&&error.nativeChatId===undefined&&error.creationNotDispatched!==true);
  await assert.rejects(driver.initialize(),error=>error.uncertain===true);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
});

test('a confirmed owned server ID survives a conversation loading failure for durable recovery',async()=>{
  const f=fixture();f.exports[17].getInfoByConversationId=()=>({conversation:null});
  f.exports[71].fetchUpdateConversationInfo=async id=>{f.calls.push({fetch:id});throw Error('metadata unavailable after successful create');};
  const {cdp,window}=rendererFixture(f),driver=createBridge(settledRenderer(cdp),{runtimeKey:f.options.runtimeKey});
  await assert.rejects(driver.initialize(),error=>error.uncertain===true&&error.nativeChatId==='native-1'&&error.creationNotDispatched!==true);
  assert.equal(window[Symbol.for('agentoffice.doubao.native.v1')].ownership.get('native-1'),f.options.runtimeKey);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
});

test('only a settled exception with exact empty and idle renderer metadata proves no creation dispatch',async()=>{
  const f=fixture();f.setAccount('');const {cdp}=rendererFixture(f);
  await assert.rejects(createBridge(settledRenderer(cdp),{runtimeKey:f.options.runtimeKey}).initialize(),error=>error.creationNotDispatched===true&&error.uncertain!==true);
  assert.equal(f.calls.filter(call=>call.create).length,0);
  for (const code of ['desktop_request_uncertain','desktop_connection_lost','desktop_rpc_error']) {
    let calls=0;const driver=createBridge({evaluate:async()=>{if(++calls===1)throw new RoomError('result unknown',503,code);
      return {runtimeKey:'pending',owned:false,state:{contract:DOUBAO_NATIVE_CONTRACT.version,detached:true,nativeChatId:null,
        requests:0,creating:false,createUncertain:false,initializing:false,verifying:false}};}},{runtimeKey:'pending'});
    await assert.rejects(driver.initialize(),error=>error.uncertain===true&&error.creationNotDispatched!==true);
  }
});

test('a timed out initialization awaiting its digest stays uncertain and may still create after inspection',async()=>{
  const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
  const chunks=[];chunks.push=([,,resolve])=>resolve(f.req);
  const crypto={randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:async(...args)=>{await gate;return webcrypto.subtle.digest(...args);}}};
  const context=vm.createContext({window:{webpackChunkflow_web_extension:chunks},location:{protocol:'doubao:',hostname:'doubao-chat',pathname:'/chat/'},
    crypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  let first=true,originalEvaluation;const transport={evaluate:code=>{const running=vm.runInContext(code,context);if(!first)return running;first=false;originalEvaluation=running;
    return Promise.race([running,new Promise((_,reject)=>setImmediate(()=>reject(new RoomError('evaluation is still running',504,'desktop_request_uncertain'))))]);}};
  const pin=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const driver=createBridge(transport,{runtimeKey:f.options.runtimeKey,factorySha256:{conversations:pin}});
  await assert.rejects(driver.initialize(),error=>error.uncertain===true&&error.creationNotDispatched!==true);
  const bridge=context.window[Symbol.for('agentoffice.doubao.native.v1')].bridges.get(f.options.runtimeKey);
  assert.equal(bridge.inspect().initializing,true);assert.equal(bridge.inspect().verifying,true);
  assert.equal(f.calls.filter(call=>call.create).length,0);
  release();await originalEvaluation;assert.equal(f.calls.filter(call=>call.create).length,1);
});

test('failure metadata does not adopt foreign or mismatched native identities or treat missing flags as idle',async()=>{
  const good={runtimeKey:'person',runtimeGlobal:'@flow-web/desktop:stable',owned:true,state:{contract:DOUBAO_NATIVE_CONTRACT.version,
    detached:true,nativeChatId:'own-server',requests:0,creating:false,createUncertain:false,initializing:false,verifying:false}};
  for (const proof of [{...good,runtimeKey:'other'}, {...good,owned:false}, {...good,runtimeGlobal:'webpackChunkflow_web_extension'},
    {...good,state:{...good.state,nativeChatId:'other-server'}}, {...good,state:{...good.state,nativeChatId:'local-alias'}}]) {
    let calls=0;const driver=createBridge({evaluate:async()=>{if(++calls===1)throw new RoomError('failed',502,'desktop_contract_mismatch');return proof;}},
      {runtimeKey:'person',runtimeGlobal:'@flow-web/desktop:stable',nativeChatId:'own-server'});
    await assert.rejects(driver.initialize(),error=>error.uncertain===true&&error.nativeChatId===undefined&&error.creationNotDispatched!==true);
  }
  let calls=0;await assert.rejects(createBridge({evaluate:async()=>{if(++calls===1)throw new RoomError('failed',502,'desktop_contract_mismatch');
    return {...good,state:{...good.state,nativeChatId:null,initializing:undefined,verifying:undefined}};}},{runtimeKey:'person'}).initialize(),error=>error.uncertain===true&&error.creationNotDispatched!==true);
});

test('source discovery rejects a missing or ambiguous factory before guessed require',()=>{
  const f=fixture();assert.equal(findDoubaoModule(f.req,'conversations').id,17);
  assert.equal(f.calls.filter(call=>call.require).length,0);
  f.req.m[777]=f.req.m[41];const before=f.calls.length;
  assert.throws(()=>findDoubaoModule(f.req,'messages'),/AMBIGUOUS/);assert.equal(f.calls.length,before);
  delete f.req.m[777];
  delete f.req.m[83];assert.throws(()=>createDoubaoNativeBridge(f.req,f.options),/COMPLETE_MISSING/);
  assert.throws(()=>createDoubaoNativeBridge(f.req,{runtimeKey:'p'}),/VERSION_GUARD/);
});

test('native Webpack exports are distinct from a caller destructuring the same message contracts',()=>{
  const f=fixture();
  // The live native sender exports UseSubmitRefHolder and later destructures
  // createSendMessage/combineBlocks from an async import. It is not the SDK.
  f.req.m[777]=function(e,t,a){a.d(t,{UseSubmitRefHolder:()=>submit});async function submit(){const {createSendMessage:s,combineBlocks:c}=await Promise.resolve({});return {s,c};}};
  assert.equal(findDoubaoModule(f.req,'messages').id,41);
  assert.equal(f.calls.length,0);
  delete f.req.m[41];
  assert.throws(()=>findDoubaoModule(f.req,'messages'),/MESSAGES_MISSING/);
  f.req.m[888]=function(e,t,a){a.d(t,{combineBlocks:()=>d,createSendMessage:()=>u});const d=0,u=0;};
  assert.equal(findDoubaoModule(f.req,'messages').id,888);
  f.req.m[999]=f.req.m[888];assert.throws(()=>findDoubaoModule(f.req,'messages'),/MESSAGES_AMBIGUOUS/);
  assert.equal(f.calls.length,0);
});

test('creates a native person conversation once, including concurrent initialization, without a model or UI switch',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.bridge.initialize(),f.bridge.initialize()]);
  assert.equal(a.nativeChatId,'native-1');assert.equal(a.nativeChatId,b.nativeChatId);assert.equal(a.detached,true);
  assert.equal((await f.bridge.createPersonConversation()).nativeChatId,a.nativeChatId);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
  assert.deepEqual(f.visible,{chatId:'human-visible-chat',composer:'human unsent draft'});
});

test('resumes a persisted native person and refuses a different person or native chat',async()=>{
  const f=fixture();await f.bridge.initialize({nativeChatId:'saved-person-chat'});
  assert.equal(f.calls.filter(call=>call.create).length,0);assert.deepEqual(f.calls.filter(call=>call.fetch),[{fetch:'saved-person-chat'}]);
  await assert.rejects(f.bridge.createPersonConversation({nativeChatId:'different'}),/ID_MISMATCH/);
  const other=createDoubaoNativeBridge(f.req,{...f.options,runtimeKey:'person_other'},f.ownership);
  await assert.rejects(other.initialize({nativeChatId:'saved-person-chat'}),/ALREADY_OWNED/);
});

test('an uncertain creation failure cannot create a second conversation automatically',async()=>{
  const f=fixture({createFailure:true});await assert.rejects(f.bridge.initialize());
  await assert.rejects(f.bridge.initialize(),/CREATE_UNCERTAIN/);
  assert.equal(f.calls.filter(call=>call.create).length,1);
});

test('account change stops native sends and observations without exposing account identity',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'original',prompt:'hello'});await settle();f.reply('original');
  f.setAccount('another-native-account');
  assert.throws(()=>f.bridge.snapshot('original',{includeContent:true}),/ACCOUNT_CHANGED/);
  await assert.rejects(f.bridge.send(chat,{requestId:'new-account',prompt:'hello'}),/ACCOUNT_CHANGED/);
  assert.equal(sends(f).length,1);assert.equal(JSON.stringify(f.bridge.inspect()).includes('fixture-native-account'),false);
});

test('literal prompt goes through native message service once and keeps request IDs',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  const prompt='literal `template` ${value} "quoted"\nsecond line';
  const accepted=await f.bridge.send(chat,{requestId:'request-1',prompt});await settle();
  assert.equal(accepted.accepted,true);assert.equal(sends(f)[0].send,'chatIMService');
  const outgoing=sends(f)[0].data.messages[0];assert.equal(outgoing.local_message_id,'request-1');assert.equal(outgoing.conversation_id,chat);
  assert.equal(outgoing.content_blocks_v2[0].content.text_block.text,prompt);
  assert.equal(outgoing.ext.agent_office_request_id,'request-1');
  await f.bridge.send(chat,{requestId:'request-1',prompt});assert.equal(sends(f).length,1);
  await assert.rejects(f.bridge.send(chat,{requestId:'request-1',prompt:'changed'}),/ID_CONFLICT/);
});

test('snapshot observes the nested owned bucket and exact reply parent without exporting unrelated content',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'request-1',prompt:'hello'});await settle();
  f.reply('another',{parent:'other-user',content:'unrelated owned chat text'});f.reply('request-1',{content:'actual answer'});
  const result=f.bridge.snapshot('request-1',{includeContent:true});
  assert.equal(result.status,'completed');assert.equal(result.userMessageId,'user-request-1');
  assert.deepEqual(result.responseMessageIds,['assistant-request-1']);
  assert.deepEqual(result.replies,[{id:'assistant-request-1',parentId:'user-request-1',role:'assistant',done:true,content:'actual answer'}]);
  assert.equal(JSON.stringify(result).includes('private content'),false);assert.equal(JSON.stringify(result).includes('unrelated'),false);
  assert.equal(f.bridge.snapshot('request-1').replies,undefined);
});

test('empty or non-text native blocks preserve the verified final content object text',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  for (const [requestId,blocks] of [['empty',[]],['non-text',[{content:{image:{}}}]],['blank',[{content:{text_block:{text:'  '}}}]]]) {
    await f.bridge.send(chat,{requestId,prompt:'hello'});await settle();
    const row=f.reply(requestId,{content:'actual '+requestId+' answer'});row.content_blocks_v2=blocks;
    f.reply('foreign-'+requestId,{parent:'unowned-user',content:'unrelated fallback text'});
    const result=f.bridge.snapshot(requestId,{includeContent:true});
    assert.equal(result.status,'completed');
    assert.deepEqual(result.replies,[{id:'assistant-'+requestId,parentId:'user-'+requestId,role:'assistant',done:true,content:'actual '+requestId+' answer'}]);
  }
  await f.bridge.send(chat,{requestId:'blocks',prompt:'hello'});await settle();
  const row=f.reply('blocks',{content:'legacy duplicate text'});row.content_blocks_v2=[{content:{text_block:{text:'actual block answer'}}}];
  assert.equal(f.bridge.snapshot('blocks',{includeContent:true}).replies[0].content,'actual block answer');
});

test('native completion predicate blocks streaming and asynchronous intermediate messages',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'request-1',prompt:'hello'});await settle();
  const row=f.reply('request-1',{done:true,streaming:true});
  assert.equal(f.bridge.snapshot('request-1',{includeContent:true}).status,'running');
  row.nativeStreaming=false;row.async_task={status:1};assert.equal(f.bridge.snapshot('request-1').status,'running');
  row.async_task.status=2;assert.equal(f.bridge.snapshot('request-1').status,'completed');
});

test('local message aliases cannot replace the server user identity',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'request-1',prompt:'hello'});await settle();
  f.state.localMessageMap[chat]['request-1'].message_id='local-message-alias';
  f.reply('request-1');const result=f.bridge.snapshot('request-1',{includeContent:true});
  assert.equal(result.status,'completed');assert.equal(result.userMessageId,'user-request-1');
});

test('two turns keep the same person conversation and concurrent new requests do not overlap',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await Promise.all([f.bridge.send(chat,{requestId:'one',prompt:'first'}),assert.rejects(f.bridge.send(chat,{requestId:'two',prompt:'second'}),/BUSY/)]);await settle();
  f.reply('one');assert.equal(f.bridge.snapshot('one').status,'completed');
  await f.bridge.send(chat,{requestId:'two',prompt:'second'});await settle();f.reply('two');
  assert.equal(f.bridge.snapshot('two').status,'completed');assert.equal(f.bridge.snapshot('two').nativeChatId,chat);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,2);
});

test('native errors and interrupted replies cannot be returned as completed answers',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'err',prompt:'hello'});await settle();f.reply('err',{error:true});
  const error=f.bridge.snapshot('err',{includeContent:true});assert.equal(error.status,'error');assert.equal(error.replies,undefined);
  assert.equal(JSON.stringify(error).includes('private error'),false);
  await f.bridge.send(chat,{requestId:'stop',prompt:'hello'});await settle();f.reply('stop',{interrupted:true});
  assert.equal(f.bridge.snapshot('stop',{includeContent:true}).status,'cancelled');
});

test('native send failure is retained and never resubmitted on repeated request',async()=>{
  const f=fixture({sendFailure:true});const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'err',prompt:'hello'});await settle();
  assert.equal(f.bridge.snapshot('err').status,'error');
  await f.bridge.send(chat,{requestId:'err',prompt:'hello'});assert.equal(sends(f).length,1);
});

test('cancel only addresses the owned server question and requires terminal evidence',async()=>{
  const f=fixture({swallowStop:true});const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'stop',prompt:'hello'});await settle();const row=f.reply('stop',{done:false});
  await assert.rejects(f.bridge.cancel('unowned'),/IDENTITY_MISMATCH/);
  const ack=await f.bridge.cancel('stop');assert.equal(ack.status,'running');assert.equal(ack.cancelRequested,true);
  assert.deepEqual(f.calls.find(call=>call.cancel).cancel,{conversation_id:chat,reply_id:'user-stop',break_reason:7});
  row.ext.is_interrupted='true';assert.equal(f.bridge.snapshot('stop').status,'cancelled');
  await f.bridge.cancel('stop');assert.equal(f.calls.filter(call=>call.cancel).length,1);
});

test('cancel refuses a newer human question even in the owned conversation',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'stop',prompt:'hello'});await settle();f.reply('stop',{done:false});
  f.state.messageMap[chat].manual={message_id:'manual-user',user_type:1,index:'999',conversation_id:chat};
  await assert.rejects(f.bridge.cancel('stop'),/NEWER_TURN/);assert.equal(f.calls.filter(call=>call.cancel).length,0);
});

test('restore requires saved server identity and verifies parent correlation without model calls',async()=>{
  const f=fixture();const chat=(await f.bridge.initialize()).nativeChatId;
  f.state.messageMap[chat]={user:{message_id:'saved-user',conversation_id:chat,user_type:1,index:'1'}};
  f.reply('saved',{chatId:chat,parent:'saved-user',content:'saved actual reply'});
  const restored=await f.bridge.restore({requestId:'saved',nativeChatId:chat,userMessageId:'saved-user',responseMessageIds:['foreign-saved-id'],includeContent:true});
  assert.equal(restored.status,'completed');assert.equal(restored.replies[0].content,'saved actual reply');assert.equal(sends(f).length,0);
  assert.equal(restored.replies[0].parentId,restored.userMessageId);
  assert.equal(restored.responseMessageIds.includes('foreign-saved-id'),false);
  await assert.rejects(f.bridge.restore({requestId:'guess',nativeChatId:chat}),/RESTORE_IDENTITY/);
  assert.equal(f.bridge.snapshot('never-sent').status,'unknown_request');
});

test('optional exact source identity fails before conversation creation',async()=>{
  const f=fixture();const good=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const oldCrypto=global.crypto;Object.defineProperty(global,'crypto',{configurable:true,value:webcrypto});
  try {
    const bridge=createDoubaoNativeBridge(f.req,{...f.options,factorySha256:{conversations:good}});await bridge.initialize();
    const bad=createDoubaoNativeBridge(f.req,{...f.options,runtimeKey:'bad-source',factorySha256:{conversations:'0'.repeat(64)}});
    const before=f.calls.length;await assert.rejects(bad.initialize(),/SOURCE_IDENTITY_MISMATCH/);
    assert.equal(f.calls.length,before);
  } finally {Object.defineProperty(global,'crypto',{configurable:true,value:oldCrypto});}
});

test('all pinned sources are validated before any native business require executes',async()=>{
  const f=fixture();const good=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const oldCrypto=global.crypto;Object.defineProperty(global,'crypto',{configurable:true,value:webcrypto});
  try {
    const bad=createDoubaoNativeBridge(f.req,{...f.options,factorySha256:{conversations:good,text:'0'.repeat(64)}});
    await assert.rejects(bad.initialize(),/SOURCE_IDENTITY_MISMATCH/);
    assert.deepEqual(f.calls,[]);
  } finally {Object.defineProperty(global,'crypto',{configurable:true,value:oldCrypto});}
});

test('production bootstrap keeps its renderer bridge across reconnects and rejects other targets',async()=>{
  const f=fixture();const chunks=[];chunks.push=([,,resolve])=>resolve(f.req);
  const window={webpackChunkflow_web_extension:chunks};
  const context=vm.createContext({window,location:{protocol:'doubao:',hostname:'doubao-chat',pathname:'/chat/'},
    crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  const cdp={evaluate:code=>vm.runInContext(code,context)};
  const first=createBridge(cdp,{runtimeKey:'person_persisted'});const created=await first.initialize();
  await first.send(created.nativeChatId,{requestId:'persisted',prompt:'literal ${value}\nhello'});await settle();f.reply('persisted');
  const second=createBridge(cdp,{runtimeKey:'person_persisted',nativeChatId:created.nativeChatId});await second.initialize();
  assert.equal((await second.snapshot('persisted',{includeContent:true})).status,'completed');
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,1);
  context.location.hostname='other';await assert.rejects(cdp.evaluate(buildDoubaoNativeBootstrap({runtimeKey:'other'})),/TARGET_MISMATCH/);
});

test('cached bootstrap rejects changed source pins and keeps the original conversation and active request',async()=>{
  const f=fixture();const chunks=[];chunks.push=([,,resolve])=>resolve(f.req);
  const context=vm.createContext({window:{webpackChunkflow_web_extension:chunks},
    location:{protocol:'doubao:',hostname:'doubao-chat',pathname:'/chat/'},crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  const cdp={evaluate:code=>vm.runInContext(code,context)};
  const pin=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const factorySha256={conversations:pin};
  const original=createBridge(cdp,{runtimeKey:'person_pinned',factorySha256});const created=await original.initialize();
  await original.send(created.nativeChatId,{requestId:'inflight',prompt:'hello'});await settle();
  const before=f.calls.length;
  for (const value of [{conversations:'0'.repeat(64)},{}]) {
    const changed=createBridge(cdp,{runtimeKey:'person_pinned',nativeChatId:created.nativeChatId,factorySha256:value});
    await assert.rejects(changed.initialize(),/SOURCE_IDENTITY_CONFIG_CHANGED/);
    assert.equal(f.calls.length,before);
  }
  f.reply('inflight');
  const same=createBridge(cdp,{runtimeKey:'person_pinned',nativeChatId:created.nativeChatId,factorySha256:{...factorySha256}});
  assert.equal((await same.initialize()).nativeChatId,created.nativeChatId);
  assert.equal((await same.snapshot('inflight',{includeContent:true})).status,'completed');
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,1);
});

test('an unpinned cached bridge cannot silently accept a newly supplied pin',async()=>{
  const f=fixture();const chunks=[];chunks.push=([,,resolve])=>resolve(f.req);
  const context=vm.createContext({window:{webpackChunkflow_web_extension:chunks},
    location:{protocol:'doubao:',hostname:'doubao-chat',pathname:'/chat/'},crypto:webcrypto,TextEncoder,Uint8Array,setTimeout,clearTimeout});
  const cdp={evaluate:code=>vm.runInContext(code,context)};
  const original=createBridge(cdp,{runtimeKey:'person_initially_unpinned'});const created=await original.initialize();
  const before=f.calls.length;
  const good=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const changed=createBridge(cdp,{runtimeKey:'person_initially_unpinned',factorySha256:{conversations:good}});
  await assert.rejects(changed.initialize(),/SOURCE_IDENTITY_CONFIG_CHANGED/);assert.equal(f.calls.length,before);
  assert.equal((await original.initialize()).nativeChatId,created.nativeChatId);
  assert.equal(f.calls.filter(call=>call.create).length,1);
});

test('an empty legacy bridge upgrades by restoring its owned native ID without creating or sending',async()=>{
  const {f,state,legacy,registry,cdp}=await legacyFixture();
  const pin=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  const driver=createBridge(cdp,{runtimeKey:f.options.runtimeKey,factorySha256:{conversations:pin}});
  assert.equal((await driver.initialize()).nativeChatId,state.nativeChatId);
  const upgraded=registry.bridges.get(f.options.runtimeKey);
  assert.notEqual(upgraded,legacy);assert.equal(upgraded.adapterRevision,DOUBAO_NATIVE_CONTRACT.adapterRevision);
  assert.equal(registry.ownership.get(state.nativeChatId),f.options.runtimeKey);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
  assert.deepEqual(Array.from(upgraded.inspect().pendingRequestIds),[]);
  assert.deepEqual(Array.from(upgraded.inspect().unsettledRequestIds),[]);
});

test('unknown or nonempty legacy state rejects upgrade without clearing the slot or touching native modules',async()=>{
  for (const patch of [{requests:1},{requests:undefined},{creating:true},{creating:undefined},{createUncertain:true},
    {createUncertain:undefined},{nativeChatId:null},{contract:'unverified'},{detached:false}]) {
    const {f,legacy,registry,cdp,captured}=await legacyFixture(patch);const before=f.calls.length;
    const driver=createBridge(cdp,{runtimeKey:f.options.runtimeKey});
    await assert.rejects(driver.initialize(),/DOUBAO_NATIVE_ADAPTER_REVISION_INCOMPATIBLE/);
    assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);
    assert.equal(f.calls.length,before);assert.equal(captured(),0);assert.equal(sends(f).length,0);
  }
});

test('legacy upgrade refuses ownership and native ID changes and keeps a slot when pin verification fails',async()=>{
  for (const change of ['owner','chat','pin']) {
    const {f,state,legacy,registry,cdp}=await legacyFixture();const before=f.calls.length;
    const options={runtimeKey:f.options.runtimeKey};
    if(change==='owner')registry.ownership.set(state.nativeChatId,'another-person');
    if(change==='chat')options.nativeChatId='another-native-chat';
    if(change==='pin')options.factorySha256={conversations:'0'.repeat(64)};
    await assert.rejects(createBridge(cdp,options).initialize(),change==='pin'?/SOURCE_IDENTITY_MISMATCH/:/ADAPTER_REVISION_INCOMPATIBLE/);
    assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);assert.equal(f.calls.length,before);
    assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
  }
});

test('upgrading an empty prior revision cannot bypass its canonical pin lock',async()=>{
  const {f,legacy,registry,cdp,captured}=await legacyFixture();
  legacy.adapterRevision='doubao-native-adapter-v2';legacy.assertSourceIdentity=f.bridge.assertSourceIdentity;
  const before=f.calls.length,pin=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  await assert.rejects(createBridge(cdp,{runtimeKey:f.options.runtimeKey,factorySha256:{conversations:pin}}).initialize(),/SOURCE_IDENTITY_CONFIG_CHANGED/);
  assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);assert.equal(captured(),0);assert.equal(f.calls.length,before);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
});

test('a legacy request arriving during restoration prevents replacement of its renderer record',async()=>{
  const {f,state,legacy,registry,cdp}=await legacyFixture();let inspections=0;
  legacy.inspect=()=>({...state,requests:++inspections===1?0:1});
  await assert.rejects(createBridge(cdp,{runtimeKey:f.options.runtimeKey}).initialize(),/ADAPTER_REVISION_INCOMPATIBLE/);
  assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
});

test('legacy account continuity rejects migration even when a fresh bridge can see the old conversation cache',async()=>{
  const {f,state,legacy,registry,cdp}=await legacyFixture();
  // Legacy initialize retains its original account closure. Metadata cached
  // under the old server ID does not establish ownership for a new account.
  f.setAccount('different-native-account');
  await assert.rejects(legacy.initialize({nativeChatId:state.nativeChatId}),/ACCOUNT_CHANGED/);
  const pin=createHash('sha256').update(f.req.m[17].toString()).digest('hex');
  await assert.rejects(createBridge(cdp,{runtimeKey:f.options.runtimeKey,factorySha256:{conversations:pin}}).initialize(),/ADAPTER_REVISION_INCOMPATIBLE/);
  assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);
  assert.equal(f.calls.filter(call=>call.create).length,1);assert.equal(sends(f).length,0);
});

test('source verification precedes legacy account validation and an absent old guard rejects without native modules',async()=>{
  const {f,legacy,registry,cdp,captured}=await legacyFixture();let validations=0;
  const initialize=legacy.initialize;legacy.initialize=input=>{validations++;return initialize(input);};
  const before=f.calls.length;
  await assert.rejects(createBridge(cdp,{runtimeKey:f.options.runtimeKey,factorySha256:{conversations:'0'.repeat(64)}}).initialize(),/SOURCE_IDENTITY_MISMATCH/);
  assert.equal(validations,0);assert.equal(f.calls.length,before);assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);
  delete legacy.initialize;const capturedBefore=captured();
  await assert.rejects(createBridge(cdp,{runtimeKey:f.options.runtimeKey}).initialize(),/ADAPTER_REVISION_INCOMPATIBLE/);
  assert.equal(f.calls.length,before);assert.equal(captured(),capturedBefore);assert.equal(registry.bridges.get(f.options.runtimeKey),legacy);
});

test('new revision inspect distinguishes model pending from unsettled native dispatch',async()=>{
  const f=fixture();let release;const dispatch=new Promise(resolve=>{release=resolve;});
  const originalService=f.exports[29].getChatService;
  f.exports[29].getChatService=async name=>{const service=await originalService(name),sender=service.getMessageService();
    return {getMessageService:()=>({sendMessage:async data=>{await sender.sendMessage(data);await dispatch;}})};};
  const chat=(await f.bridge.initialize()).nativeChatId;
  await f.bridge.send(chat,{requestId:'pending',prompt:'hello'});
  assert.equal(f.bridge.inspect().adapterRevision,DOUBAO_NATIVE_CONTRACT.adapterRevision);
  assert.deepEqual(f.bridge.inspect().pendingRequestIds,['pending']);
  assert.deepEqual(f.bridge.inspect().unsettledRequestIds,['pending']);
  release();await settle();assert.deepEqual(f.bridge.inspect().unsettledRequestIds,[]);
  assert.deepEqual(f.bridge.inspect().pendingRequestIds,['pending']);
  f.reply('pending');assert.equal(f.bridge.snapshot('pending').status,'completed');
  assert.deepEqual(f.bridge.inspect().pendingRequestIds,[]);assert.equal(f.bridge.inspect().requests,1);
});

test('driver validates allowed methods and returned native identity before reporting success',async()=>{
  const expressions=[];
  const driver=new DesktopDoubao({runtimeKey:'person-driver',evaluate:async code=>{expressions.push(code);return expressions.length===1
    ? {contract:DOUBAO_NATIVE_CONTRACT.version,detached:true,nativeChatId:'owned'}
    : {nativeChatId:'wrong',status:'completed'};}});
  await driver.initialize();await assert.rejects(driver.send('other',{requestId:'x',prompt:'hello'}),{code:'desktop_identity_mismatch'});
  await assert.rejects(driver.call('unrestricted',[]),{code:'desktop_method_rejected'});
  await assert.rejects(driver.snapshot('x'),{code:'desktop_identity_mismatch'});
  assert.throws(()=>buildDoubaoNativeBootstrap({runtimeKey:'injected";'}),{code:'desktop_identity_mismatch'});
  assert.throws(()=>buildDoubaoNativeBootstrap({runtimeKey:'valid',contractVersion:'unsupported'}),{code:'desktop_contract_mismatch'});
});
