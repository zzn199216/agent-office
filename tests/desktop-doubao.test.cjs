'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
const {createBridge,DesktopDoubao,DOUBAO_NATIVE_CONTRACT,findDoubaoModule,createDoubaoNativeBridge,buildDoubaoNativeBootstrap}=require('../src/desktop-doubao.cjs');

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
    17:function(){return {createConversation:0,createSendMessageConversationContext:0,getInfoByConversationId:0,MAIN_BOT_ID:0};},
    29:function(){return {getChatService:0,getChatStore:0};},
    41:function(){return {createSendMessage:0,combineBlocks:0};},
    53:function(){return {mapTextToTextBlock:0};},
    67:function(){const x={useMessageStore:0};return 'useMessageStore is not initialized'+x;},
    71:function(){const x={fetchUpdateConversationInfo:0};return 'updateConversationInfo: invalid data from api'+x;},
    83:function(){const x={z:0};return 'PushMessageStatus.Streaming is_finish async_task'+x;},
    97:function(){const x={MessageBreak:0};return 'reply_msg_id break_reason'+x;},
    101:function(){const x={n5:0,bG:0};return 'user_id_str isUserInfoLoaded'+x;},
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

test('source discovery rejects a missing or ambiguous factory before guessed require',()=>{
  const f=fixture();assert.equal(findDoubaoModule(f.req,'conversations').id,17);
  f.req.m[777]=f.req.m[41];const before=f.calls.length;
  assert.throws(()=>findDoubaoModule(f.req,'messages'),/AMBIGUOUS/);assert.equal(f.calls.length,before);
  delete f.req.m[777];
  delete f.req.m[83];assert.throws(()=>createDoubaoNativeBridge(f.req,f.options),/COMPLETE_MISSING/);
  assert.throws(()=>createDoubaoNativeBridge(f.req,{runtimeKey:'p'}),/VERSION_GUARD/);
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
    const before=f.calls.filter(call=>call.create).length;await assert.rejects(bad.initialize(),/SOURCE_IDENTITY_MISMATCH/);
    assert.equal(f.calls.filter(call=>call.create).length,before);
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
