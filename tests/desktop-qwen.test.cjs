'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm=require('node:vm');
const {DesktopQwen,QWEN_NATIVE_CONTRACT,buildQwenNativeBootstrap,createQwenNativeDetachedBridge:create} = require('../src/desktop-qwen.cjs');
const guard = {contractVersion:'qwen-chat-fe-0.3.17-detached-v1'};
const assignedUrl='http://127.0.0.1:47831/mcp/person_a/fixture-private-a';
const otherAssignedUrl='http://127.0.0.1:47831/mcp/person_b/fixture-private-b';
function fixture(mode = 'normal', persisted = new Map()) {
  let instance = 0, sends = 0;
  const detached = [],nativeOperations={loads:[],resumes:[],asyncTasks:0,stops:0};
  class NativeSession {
    constructor(config, active) {
      this.id = `fixture-${++instance}`; this.active = active; this.isActiveInPool = active(); this.isChat = false; this.sessionState = 'idle';
      this.chatId = ''; this.chatLoaded = false; this.history = {messages:{},currentId:null,currentResponseIds:[]}; this.models = []; this.settings = {}; this.config = config;
      if (!active()) detached.push(this);
    }
    createContext(){}
    async handleMcpLoop(_context,_handler,_model,id){const response=this.history.messages[id];if(mode==='mcp'&&response){response.done=true;response.content='';response.content_list=[{phase:'local_tool',extra:{local_mcp:{AgentRoom:[{tool_name:'agentroom_chat_rooms'}]}}},{phase:'local_tool',mcp_results:{AgentRoom:[{agentroom_chat_rooms:'private fixture result not exposed'}]}},{phase:'answer',content:`fixture reply ${sends}`}];}}
    getCanonicalResponseId(id){return this.aliases?.[id] || id;}
    setSessionParams(p){Object.assign(this,p);} setChatId(id){this.chatId=id;} configureDomainState(p){Object.assign(this,p);}
    async loadChat(id){nativeOperations.loads.push({session:this.id,id});this.sessionState='loading';this.chatId=id;const data=await this.config.services.loader.load({},id);if(!data?.success){this.sessionState='error';await this.resumePendingAsyncTasks();return;}Object.assign(this,data);this.chatLoaded=true;this.sessionState='ready';for(const responseId of data.continuedResponseIds)await this.config.services.streamHandler.resumeStream({},responseId);if(data.asyncTaskMessages.length)await this.resumePendingAsyncTasks();}
    async resumePendingAsyncTasks(){nativeOperations.asyncTasks++;}
    async submitPrompt(p) {
      sends++;this.isChat=true;this.sessionState='streaming';
      if (!this.chatId) this.chatId=`native-${instance}`;
      const u=p.userMessageId,r=p.responseMessages[0].messageId;
      this.history.messages[u]={...p.userMessage};this.history.messages[r]={...p.responseMessages[0].message};this.history.currentId=r;
      await new Promise(resolve=>setTimeout(resolve,5));
      if(mode==='error'){this.history.messages[r].error={errorCode:'fixture_error',errorMessage:'failed'};this.history.messages[r].done=true;this.isChat=false;this.sessionState='ready';return;}
      if(mode==='stall'){this.sessionState='ready';this.isChat=false;await new Promise(resolve=>this.release=resolve);}
      if(mode==='cancel'){await new Promise(resolve=>this.release=resolve);return;}
      const ur=`user-server-${sends}`,rr=`reply-server-${sends}`;
      this.history.messages[ur]={...this.history.messages[u],id:ur};delete this.history.messages[u];
      this.history.messages[rr]={...this.history.messages[r],id:rr,parentId:ur,content:`fixture reply ${sends}`,done:true};delete this.history.messages[r];
      this.history.currentResponseIds=[rr];
      if(mode==='cancel-server'){this.history.messages[rr].done=false;this.history.currentId=rr;this.chatLoaded=true;await new Promise(resolve=>this.release=resolve);return;}
      if(['error-server','error-pending'].includes(mode)){
        this.history.messages[rr].content='';this.history.messages[rr].error={errorCode:'quota_limit',errorMessage:'fixture provider limit'};this.history.currentId=rr;this.isChat=false;this.sessionState='ready';this.chatLoaded=true;persisted.set(this.chatId,structuredClone({chatId:this.chatId,history:this.history,models:this.models}));
        if(mode==='error-pending')await new Promise(resolve=>this.release=resolve);return;
      }
      if(mode==='phased'){this.history.messages[rr].content='';this.history.messages[rr].content_list=[{phase:'answer',content:`fixture reply ${sends}`}];}
      if(mode==='mcp'){this.history.messages[rr].done=false;this.aliases={[r]:rr};await this.handleMcpLoop({},this.config.services.mcpHandler,p.responseMessages[0].model,r);}
      this.history.currentId=rr;this.isChat=false;this.sessionState='ready';this.chatLoaded=true;
      persisted.set(this.chatId,structuredClone({chatId:this.chatId,history:this.history,models:this.models}));
    }
    async stopResponse(){nativeOperations.stops++;if(['cancel','cancel-server'].includes(mode))for(const message of Object.values(this.history.messages))if(message.role==='assistant'){message.done=true;message.is_stop=true;}this.isChat=false;this.sessionState='ready';if(mode==='cancel-server')persisted.set(this.chatId,structuredClone({chatId:this.chatId,history:this.history,models:this.models}));this.release?.();} destroy(){this.destroyed=true;}
  }
  const visible=new NativeSession({},()=>true);visible.chatId='user-current-chat';visible.history.messages.private={role:'assistant',content:'unrelated private text'};
  const servers=[{id:'ao',name:'AgentRoom',type:'httpStream',enabled:true,connectionStatus:'available',tools:[{name:'agentroom_chat_inbox',inputSchema:{type:'object'}}],params:{url:assignedUrl}},{id:'other',name:'other',type:'stdio',enabled:false,params:{command:'npx',args:['fixture-only']}}];
  let runtimeConfig={AgentRoom:{transportType:'httpStream',url:assignedUrl},runtimeOnly:{transportType:'stdio',command:'fixture-only-command',env:{FIXTURE:'preserve'}}};
  const mcpOperations={updates:[],lists:[],calls:[]};
  const mcpApi={
    mcp_client_get_config:async()=>structuredClone(runtimeConfig),
    mcp_client_update_config:async value=>{mcpOperations.updates.push(structuredClone(value));runtimeConfig=structuredClone(value);},
    mcp_client_tool_list:async name=>{mcpOperations.lists.push(name);return {tools:[{name:'agentroom_chat_rooms',inputSchema:{type:'object'}}]};},
    mcp_client_tool_call:async input=>{mcpOperations.calls.push({...input,resolvedUrl:runtimeConfig[input.serverName]?.url});return {content:[{type:'text',text:'fixture tool result'}]};}
  };
  const config=()=>({notifier:{error(){}},services:{sender:{createChat:async()=>({chatId:'native-empty-created'})},streamHandler:{resumeStream:async(_context,id)=>nativeOperations.resumes.push(id)},loader:{load:async(_context,id)=>{const data=persisted.get(id);return data?{success:true,continuedResponseIds:[],asyncTaskMessages:[],...structuredClone(data)}:{success:false};}},messageService:{},mcpHandler:{mcpClient:{getFormatAvailableServerMap:()=>({AgentRoom:{agentroom_chat_inbox:{}}})}}}});
  const mod={av:{pool:{currentSession:visible,sessions:new Map([[visible.id,visible]]),config:{sessionConfigFactory:config}},getChatOptions(){},createChat(){throw Error('foreground creation prohibited');}},_:{getState:()=>({models:[{id:'fixture-model',name:'Fixture',info:{}}],selectedModelIds:['fixture-model']})},y:{getState:()=>({settings:{params:{stream_response:true}}})},d9:{getMCPServers:()=>servers,addMCPServer:entry=>servers.push(structuredClone(entry)),updateMCPServer:(id,patch)=>Object.assign(servers.find(s=>s.id===id),patch)}};
  return {bridge:create(mod,{...guard,mcpApi}),newBridge:runtimeKey=>create(mod,{...guard,mcpApi,runtimeKey}),mod,visible,detached,servers,mcpApi,mcpOperations,nativeOperations,get runtimeConfig(){return runtimeConfig;},set runtimeConfig(value){runtimeConfig=value;},get sends(){return sends;},setMode(next){mode=next;},persisted};
}
test('creates a detached session and preserves a busy user conversation',async()=>{const f=fixture();f.visible.isChat=true;const s=await f.bridge.start({requestId:'one',inputText:'fixture one'});assert.equal(s.status,'sending');const done=await f.bridge.awaitCompletion({requestId:'one',includeContent:true});assert.equal(done.status,'completed');assert.equal(done.replies[0].role,'assistant');assert.equal(f.visible.chatId,'user-current-chat');assert.equal(f.visible.history.messages.private.content,'unrelated private text');assert.equal(f.visible.isChat,true);assert.equal(f.bridge.inspect().detached,true);});
test('terminal-looking state without settled native promise does not complete',async()=>{const f=fixture('stall');await f.bridge.start({requestId:'stall',inputText:'fixture stall'});const timed=await f.bridge.awaitCompletion({requestId:'stall',timeoutMs:20});assert.equal(timed.status,'sending');assert.equal(timed.timedOut,true);assert.equal(timed.sendSettled,false);f.detached[0].release();assert.equal((await f.bridge.awaitCompletion({requestId:'stall'})).status,'completed');});
test('same request never resends and conflicting reuse fails',async()=>{const f=fixture();await f.bridge.start({requestId:'id',inputText:'same'});await f.bridge.awaitCompletion({requestId:'id'});await f.bridge.start({requestId:'id',inputText:'same'});assert.equal(f.sends,1);await assert.rejects(f.bridge.start({requestId:'id',inputText:'different'}),/REQUEST_ID_CONFLICT/);});
test('second turn and a fresh bridge use the exact persisted native chat',async()=>{const f=fixture();await f.bridge.start({requestId:'one',inputText:'first'});const one=await f.bridge.awaitCompletion({requestId:'one'});await f.bridge.start({requestId:'two',inputText:'second',nativeChatId:one.nativeChatId});const two=await f.bridge.awaitCompletion({requestId:'two'});assert.equal(two.nativeChatId,one.nativeChatId);const resumed=fixture('normal',f.persisted);await resumed.bridge.ensureConversation({nativeChatId:one.nativeChatId});await resumed.bridge.start({requestId:'three',inputText:'third',nativeChatId:one.nativeChatId});assert.equal((await resumed.bridge.awaitCompletion({requestId:'three'})).nativeChatId,one.nativeChatId);});
test('native assistant error is error and unrelated replies are never returned',async()=>{const f=fixture('error');await f.bridge.start({requestId:'err',inputText:'error'});const result=await f.bridge.awaitCompletion({requestId:'err',includeContent:true});assert.equal(result.status,'error');assert.equal(result.error.code,'fixture_error');assert.equal(result.replies,undefined);});
test('MCP enable preserves original URLs and other services',async()=>{const f=fixture();const before=JSON.stringify(f.servers);await f.bridge.enableMcp({existingServerName:'AgentRoom',expectedUrl:assignedUrl});assert.equal(JSON.stringify(f.servers),before);assert.equal(f.mcpOperations.updates.length,0);await assert.rejects(f.bridge.enableMcp({existingServerName:'absent',expectedUrl:assignedUrl}),/EXISTING_MCP_NOT_FOUND/);});
test('cancel addresses only the exact owned request',async()=>{const f=fixture('cancel');await f.bridge.start({requestId:'cancel',inputText:'cancel'});await new Promise(r=>setTimeout(r,10));await assert.rejects(f.bridge.cancel({requestId:'wrong'}),/IDENTITY_MISMATCH/);assert.equal((await f.bridge.cancel({requestId:'cancel'})).status,'cancelled');assert.equal(f.visible.chatId,'user-current-chat');});
test('a swallowed native stop request never claims cancellation without terminal records',async()=>{const f=fixture('cancel');await f.bridge.start({requestId:'no-ack',inputText:'no ack'});await new Promise(r=>setTimeout(r,10));const stop=f.detached[0].stopResponse.bind(f.detached[0]);f.detached[0].stopResponse=async()=>{};const result=await f.bridge.cancel({requestId:'no-ack'});assert.equal(result.status,'sending');assert.equal(result.cancelRequested,true);assert.equal(result.sendSettled,false);f.detached[0].stopResponse=stop;assert.equal((await f.bridge.cancel({requestId:'no-ack'})).status,'cancelled');});
test('missing version guard fails closed',()=>{const f=fixture();assert.throws(()=>create(f.mod,{}),/VERSION_GUARD_REQUIRED/);});
test('creates a real native chat identity once without model invocation',async()=>{const f=fixture();await f.bridge.ensureConversation();const a=await f.bridge.createConversation();const b=await f.bridge.createConversation();assert.equal(a.nativeChatId,'native-empty-created');assert.equal(a.nativeChatId,b.nativeChatId);assert.equal(f.sends,0);assert.equal(f.visible.chatId,'user-current-chat');});
test('legacy MCP enable does not reenable a server the user disabled',async()=>{const f=fixture();f.servers[0].enabled=false;await assert.rejects(f.bridge.enableMcp({existingServerName:'AgentRoom',expectedUrl:assignedUrl}),/EXISTING_MCP_DISABLED/);assert.equal(f.servers[0].enabled,false);});
test('native answer phase is extracted when top-level content is empty',async()=>{const f=fixture('phased');await f.bridge.start({requestId:'phase',inputText:'phase'});const done=await f.bridge.awaitCompletion({requestId:'phase',includeContent:true});assert.equal(done.replies[0].content,'fixture reply 1');});
test('native MCP loop resolves temporary response ID after server remapping',async()=>{const f=fixture('mcp');await f.bridge.start({requestId:'mcp',inputText:'mcp'});const done=await f.bridge.awaitCompletion({requestId:'mcp',includeContent:true});assert.equal(done.status,'completed');assert.equal(done.replies[0].content,'fixture reply 1');assert.deepEqual(done.replies[0].toolPhases[1].results,[{service:'AgentRoom',toolName:'agentroom_chat_rooms'}]);assert.equal(JSON.stringify(done).includes('private fixture result'),false);});
test('source identity and runtime key reject a changed bundle or unsafe key',()=>{const args={runtimeKey:'person-1',moduleUrl:QWEN_NATIVE_CONTRACT.moduleUrl,sourceSha256:QWEN_NATIVE_CONTRACT.sourceSha256};assert.match(buildQwenNativeBootstrap(args),/LOADED_MODULE_MISMATCH/);assert.throws(()=>buildQwenNativeBootstrap({...args,sourceSha256:'wrong'}),/SOURCE_IDENTITY_MISMATCH/);assert.throws(()=>buildQwenNativeBootstrap({...args,moduleUrl:'https:\/\/example.invalid\/main.js'}),/SOURCE_IDENTITY_MISMATCH/);assert.throws(()=>buildQwenNativeBootstrap({...args,runtimeKey:'injected";'}),/INVALID_RUNTIME_KEY/);});
test('driver preserves native chat identity and encodes prompt literally',async()=>{const expressions=[];const nativeId='native-owned';const driver=new DesktopQwen({evaluate:async code=>{expressions.push(code);return code.includes('const args=')?{contract:QWEN_NATIVE_CONTRACT.version,detached:true,nativeChatId:nativeId}:{nativeChatId:nativeId,status:'sending'};},runtimeKey:'person_1',...QWEN_NATIVE_CONTRACT});await driver.initialize();const prompt='literal `template` ${value} "quoted"\nline';await driver.start({requestId:'id',inputText:prompt});assert.equal(driver.nativeChatId,nativeId);assert.match(expressions[1],/native-owned/);assert.match(expressions[1],/\\nline/);assert.equal(expressions[1].includes('beforeSendMessage('),false);await assert.rejects(driver.call('unrestricted',{token:'hidden'}),/METHOD_REJECTED/);});

test('assigned MCP material reuses an equivalent existing URL under another name',async()=>{
  const f=fixture(),before=JSON.stringify(f.servers);const info=await f.bridge.registerMcpConnection({serverName:'NewPersonLabel',config:{type:'streamable-http',url:assignedUrl}});
  assert.equal(info.serverName,'AgentRoom');assert.equal(f.servers.length,2);assert.equal(JSON.stringify(f.servers),before);assert.equal(f.mcpOperations.updates.length,0);assert.equal(f.mcpOperations.lists.length,0);assert.equal(JSON.stringify(info).includes('fixture-private'),false);
});

test('another person with a colliding name receives a separate native connection and preserves all other configurations',async()=>{
  const f=fixture(),original=structuredClone(f.servers),runtimeOnly=structuredClone(f.runtimeConfig.runtimeOnly);const info=await f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:otherAssignedUrl}});
  assert.notEqual(info.serverName,'AgentRoom');assert.deepEqual(f.servers.slice(0,2),original);assert.deepEqual(f.runtimeConfig.runtimeOnly,runtimeOnly);assert.equal(f.runtimeConfig.AgentRoom.url,assignedUrl);assert.equal(f.runtimeConfig[info.serverName].url,otherAssignedUrl);assert.equal(f.runtimeConfig.other.command,'npx');assert.equal(f.servers[1].enabled,false);assert.deepEqual(f.mcpOperations.lists,[info.serverName]);
  const client=f.detached[0].config.services.mcpHandler.mcpClient;assert.deepEqual(Object.keys(client.getFormatAvailableServerMap()),[info.serverName]);await client.callTool({serverName:info.serverName,toolName:'agentroom_chat_rooms',toolArguments:{}});assert.equal(f.mcpOperations.calls[0].resolvedUrl,otherAssignedUrl);await assert.rejects(client.callTool({serverName:'AgentRoom',toolName:'agentroom_chat_inbox',toolArguments:{}}),/IDENTITY_MISMATCH/);assert.equal(f.mcpOperations.calls.length,1);
});

test('registration also preserves colliding names held only in the native proxy',async()=>{
  const f=fixture();f.runtimeConfig.nativeOnlyName={transportType:'httpStream',url:assignedUrl};const info=await f.bridge.registerMcpConnection({serverName:'nativeOnlyName',config:{type:'streamable-http',url:otherAssignedUrl}});assert.notEqual(info.serverName,'nativeOnlyName');assert.equal(f.runtimeConfig.nativeOnlyName.url,assignedUrl);assert.equal(f.runtimeConfig[info.serverName].url,otherAssignedUrl);
});

test('native RPC registration unavailable fails before writing any frontend configuration',async()=>{
  const f=fixture(),before=JSON.stringify(f.servers),api={...f.mcpApi,mcp_client_update_config:undefined};const bridge=create(f.mod,{...guard,mcpApi:api});await assert.rejects(bridge.registerMcpConnection({serverName:'PersonB',config:{type:'streamable-http',url:otherAssignedUrl}}),/REGISTRATION_UNAVAILABLE/);assert.equal(JSON.stringify(f.servers),before);assert.equal(f.mcpOperations.updates.length,0);
});

test('an existing service name without assigned URL authority cannot enable MCP',async()=>{
  const f=fixture();await assert.rejects(f.bridge.enableMcp({existingServerName:'AgentRoom'}),/ASSIGNED_MCP_REQUIRED/);await assert.rejects(f.bridge.enableMcp({existingServerName:'AgentRoom',expectedUrl:otherAssignedUrl}),/IDENTITY_MISMATCH/);assert.equal(f.mcpOperations.calls.length,0);assert.equal(f.mcpOperations.updates.length,0);
});

test('per-person MCP scope refuses store or runtime retargeting without dispatching tools',async()=>{
  const f=fixture();await f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:assignedUrl}});const client=f.detached[0].config.services.mcpHandler.mcpClient;f.runtimeConfig.AgentRoom.url=otherAssignedUrl;await assert.rejects(client.callTool({serverName:'AgentRoom',toolName:'agentroom_chat_inbox',toolArguments:{}}),/IDENTITY_MISMATCH/);assert.equal(f.mcpOperations.calls.length,0);f.runtimeConfig.AgentRoom.url=assignedUrl;f.servers[0].params.url=otherAssignedUrl;assert.throws(()=>client.getFormatAvailableServerMap(),/IDENTITY_MISMATCH/);await assert.rejects(client.callTool({serverName:'AgentRoom',toolName:'agentroom_chat_inbox',toolArguments:{}}),/IDENTITY_MISMATCH/);assert.equal(f.mcpOperations.calls.length,0);
});

test('concurrent detached persons serialize global registry updates and keep distinct tool scopes',async()=>{
  const f=fixture(),one=f.newBridge('person-one'),two=f.newBridge('person-two');const get=f.mcpApi.mcp_client_get_config;f.mcpApi.mcp_client_get_config=async()=>{await new Promise(resolve=>setTimeout(resolve,5));return get();};
  const [a,b]=await Promise.all([one.registerMcpConnection({serverName:'PersonOne',config:{type:'streamable-http',url:'http://127.0.0.1:47831/mcp/person_c/fixture-private-c'}}),two.registerMcpConnection({serverName:'PersonTwo',config:{type:'streamable-http',url:otherAssignedUrl}})]);
  assert.ok(f.runtimeConfig[a.serverName]);assert.ok(f.runtimeConfig[b.serverName]);assert.equal(f.runtimeConfig.AgentRoom.url,assignedUrl);assert.equal(f.servers[1].enabled,false);assert.deepEqual(Object.keys(f.detached[1].config.services.mcpHandler.mcpClient.getFormatAvailableServerMap()),[a.serverName]);assert.deepEqual(Object.keys(f.detached[2].config.services.mcpHandler.mcpClient.getFormatAvailableServerMap()),[b.serverName]);
});

test('registration never returns native URLs even when the native RPC exception contains one',async()=>{
  const f=fixture();f.mcpApi.mcp_client_update_config=async()=>{throw Error('fixture rejected '+otherAssignedUrl);};await assert.rejects(f.bridge.registerMcpConnection({serverName:'PersonB',config:{type:'streamable-http',url:otherAssignedUrl}}),error=>error.message==='QWEN_NATIVE_MCP_RUNTIME_UPDATE_FAILED'&&!error.message.includes('fixture-private'));assert.equal(JSON.stringify(f.bridge.inspect()).includes('fixture-private'),false);
});

test('bootstrap sends assigned private material only inside evaluation and defaults to no generic MCP binding',async()=>{
  const expressions=[],connection={serverName:'PersonB',config:{type:'streamable-http',url:otherAssignedUrl}};const driver=new DesktopQwen({evaluate:async expression=>{expressions.push(expression);return {contract:QWEN_NATIVE_CONTRACT.version,detached:true,nativeChatId:'native-person-b',mcpServerName:'PersonB'};},runtimeKey:'person_b',...QWEN_NATIVE_CONTRACT,mcpConnection:connection});const ready=await driver.initialize();assert.ok(expressions[0].includes(JSON.stringify(connection)));assert.equal(JSON.stringify(ready).includes('fixture-private'),false);const plain=new DesktopQwen({evaluate:async()=>{},runtimeKey:'plain',...QWEN_NATIVE_CONTRACT});assert.equal(plain.options.serverName,null);assert.equal(plain.options.mcpConnection,null);
});

test('an assigned connection cannot be silently rotated or changed to a remote URL',async()=>{
  const f=fixture();await f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:assignedUrl}});const before=JSON.stringify(f.servers);
  await assert.rejects(f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:otherAssignedUrl}}),/IDENTITY_MISMATCH/);
  await assert.rejects(f.bridge.registerMcpConnection({serverName:'Remote',config:{type:'streamable-http',url:'https://example.invalid/mcp/person/fixture'}}),/MCP_URL_INVALID/);
  await assert.rejects(f.bridge.registerMcpConnection({serverName:'__proto__',config:{type:'streamable-http',url:assignedUrl}}),/CONNECTION_INVALID/);assert.equal(JSON.stringify(f.servers),before);assert.equal(f.mcpOperations.calls.length,0);
});

test('native proxy reset restores every connection while retaining per-person tool scope',async()=>{
  const f=fixture();const info=await f.bridge.registerMcpConnection({serverName:'PersonB',config:{type:'streamable-http',url:otherAssignedUrl}});f.runtimeConfig={runtimeOnly:{transportType:'stdio',command:'keep-runtime'}};
  const client=f.detached[0].config.services.mcpHandler.mcpClient;await client.connect();assert.equal(f.runtimeConfig.AgentRoom.url,assignedUrl);assert.equal(f.runtimeConfig[info.serverName].url,otherAssignedUrl);assert.equal(f.runtimeConfig.other.command,'npx');assert.equal(f.runtimeConfig.runtimeOnly.command,'keep-runtime');assert.deepEqual(Object.keys(client.getFormatAvailableServerMap()),[info.serverName]);
});

test('serialized bootstrap replaces an idle legacy bridge but preserves its native conversation',async()=>{
  const f=fixture();await f.bridge.start({requestId:'before-upgrade',inputText:'owned before upgrade'});const done=await f.bridge.awaitCompletion({requestId:'before-upgrade'});let disposed=0;
  const runtimeKey='legacy_person',registry={[runtimeKey]:{inspect:()=>({nativeChatId:done.nativeChatId,state:'ready'}),dispose:()=>disposed++}},sandbox={fixtureMod:f.mod,document:{scripts:[{src:QWEN_NATIVE_CONTRACT.moduleUrl}]},crypto:globalThis.crypto,URL,setTimeout,__agentOfficeQwenNativeSessions:registry};
  const expression=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT}).replace('await import(args.moduleUrl)','fixtureMod');const state=await vm.runInNewContext(expression,sandbox);
  assert.equal(disposed,1);assert.equal(state.nativeChatId,done.nativeChatId);assert.equal(state.adapterRevision,'mcp-person-terminal-v3');assert.equal(state.mcpServerName,null);assert.equal(f.visible.chatId,'user-current-chat');
});

test('serialized bootstrap refuses to replace a legacy bridge with an active native turn',async()=>{
  const f=fixture();let disposed=0;const runtimeKey='legacy_busy',sandbox={fixtureMod:f.mod,document:{scripts:[{src:QWEN_NATIVE_CONTRACT.moduleUrl}]},crypto:globalThis.crypto,URL,setTimeout,__agentOfficeQwenNativeSessions:{[runtimeKey]:{inspect:()=>({nativeChatId:'owned-native',state:'streaming'}),dispose:()=>disposed++}}};
  const expression=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT}).replace('await import(args.moduleUrl)','fixtureMod');await assert.rejects(vm.runInNewContext(expression,sandbox),/ADAPTER_UPGRADE_BUSY/);assert.equal(disposed,0);assert.equal(f.detached.length,1);
});

function savedTurn({done=true,content='restored exact answer',error=null,stopped=false} = {}) {
  return {chatId:'saved-owned-chat',models:['fixture-model'],history:{currentId:'saved-answer',currentResponseIds:['saved-answer'],messages:{
    'saved-user':{id:'saved-user',fid:'saved-user-local',role:'user',parentId:null,content:'saved question',extra:{meta:{agent_office_request_id:'saved-request'}}},
    'saved-answer':{id:'saved-answer',fid:'saved-answer-local',role:'assistant',parentId:'saved-user',content,done,is_stop:stopped,error}
  }}};
}
const restoreArgs={requestId:'saved-request',nativeChatId:'saved-owned-chat',userMessageId:'saved-user',responseMessageIds:['saved-answer-local','saved-answer'],includeContent:true};

test('fresh renderer restores the exact persisted answer without sending, resuming or cancelling',async()=>{
  const record=savedTurn(),f=fixture('normal',new Map([[record.chatId,record]]));f.visible.isChat=true;
  const result=await f.bridge.restore(restoreArgs);assert.equal(result.status,'completed');assert.equal(result.restoredFromHistory,true);assert.equal(result.userMessageId,'saved-user');assert.deepEqual(result.responseMessageIds,['saved-answer']);assert.equal(result.replies[0].content,'restored exact answer');assert.equal(f.sends,0);assert.deepEqual(f.nativeOperations,{loads:[{session:'fixture-2',id:record.chatId}],resumes:[],asyncTasks:0,stops:0});assert.equal(f.visible.chatId,'user-current-chat');assert.equal(f.visible.isChat,true);
  assert.equal((await f.bridge.query({requestId:'saved-request',includeContent:true})).replies[0].content,'restored exact answer');
});

test('restored answer stops at an intervening user turn and excludes sibling branches',async()=>{
  const record=savedTurn();Object.assign(record.history.messages,{
    sibling:{id:'sibling',role:'assistant',parentId:'saved-user',content:'another branch',done:true},
    laterUser:{id:'laterUser',role:'user',parentId:'saved-answer',content:'same person next question'},
    laterAnswer:{id:'laterAnswer',role:'assistant',parentId:'laterUser',content:'later unrelated answer',done:true}
  });record.history.currentId='laterAnswer';const f=fixture('normal',new Map([[record.chatId,record]])),result=await f.bridge.restore(restoreArgs);assert.deepEqual(result.replies.map(reply=>reply.id),['saved-answer']);assert.equal(JSON.stringify(result).includes('unrelated'),false);assert.equal(f.sends,0);
  await assert.rejects(f.bridge.restore({...restoreArgs,responseMessageIds:[]}),/RESPONSE_IDENTITY_MISMATCH/);
});

test('MCP answer chain is restored only through its saved exact response ancestor',async()=>{
  const record=savedTurn({content:''});record.history.messages['saved-answer'].content_list=[{phase:'local_tool',extra:{local_mcp:{AgentRoom:[{tool_name:'agentroom_chat_rooms'}]}}}];record.history.messages['saved-final']={id:'saved-final',role:'assistant',parentId:'saved-answer',content:'',content_list:[{phase:'answer',content:'MCP final answer'}],done:true};const f=fixture('normal',new Map([[record.chatId,record]])),result=await f.bridge.restore(restoreArgs);assert.equal(result.status,'completed');assert.deepEqual(result.replies.map(reply=>reply.id),['saved-answer','saved-final']);assert.equal(result.replies.at(-1).content,'MCP final answer');assert.equal(f.mcpOperations.calls.length,0);assert.equal(f.sends,0);
});

test('restore refuses a different conversation, server user ID, request tag or response parent',async()=>{
  const record=savedTurn(),f=fixture('normal',new Map([[record.chatId,record]]));await f.bridge.restore(restoreArgs);
  await assert.rejects(f.bridge.restore({...restoreArgs,nativeChatId:'other-chat'}),/PERSON_CHAT_ID_MISMATCH/);
  await assert.rejects(f.bridge.restore({...restoreArgs,userMessageId:'saved-user-local'}),/USER_IDENTITY_MISMATCH/);
  await assert.rejects(f.bridge.restore({...restoreArgs,requestId:'another-request'}),/REQUEST_IDENTITY_MISMATCH/);
  record.history.messages['other-user']={id:'other-user',role:'user',content:'other'};record.history.messages['other-response']={id:'other-response',role:'assistant',parentId:'other-user',content:'private other answer',done:true};f.persisted.set(record.chatId,record);
  await assert.rejects(f.bridge.restore({...restoreArgs,responseMessageIds:['other-response']}),/RESPONSE_IDENTITY_MISMATCH/);assert.equal(f.sends,0);assert.equal(f.nativeOperations.stops,0);
});

test('readonly initialization and restore suppress native automatic stream and async task continuation',async()=>{
  const record=savedTurn({done:false});record.continuedResponseIds=['saved-answer'];record.asyncTaskMessages=[{messageId:'saved-answer',taskId:'pending-task'}];const f=fixture('normal',new Map([[record.chatId,record]]));await f.bridge.ensureConversation({nativeChatId:record.chatId});const result=await f.bridge.restore(restoreArgs);assert.equal(result.status,'incomplete');assert.equal(result.sendSettled,false);assert.equal(result.replies,undefined);assert.deepEqual(f.nativeOperations.resumes,[]);assert.equal(f.nativeOperations.asyncTasks,0);assert.equal(f.nativeOperations.stops,0);assert.equal(f.sends,0);assert.equal(f.detached[0].history.messages['saved-answer'].done,false);
  record.history.messages['saved-answer'].done=true;f.persisted.set(record.chatId,record);assert.equal((await f.bridge.restore(restoreArgs)).status,'completed');assert.equal(f.sends,0);
});

test('restoring blank, failed or stopped native records cannot claim a final model answer',async()=>{
  for(const [patch,status] of [[{content:''},'incomplete'],[{error:{errorCode:'native_saved_error',errorMessage:'failed'}},'error'],[{stopped:true},'cancelled']]) {
    const record=savedTurn(patch),f=fixture('normal',new Map([[record.chatId,record]])),result=await f.bridge.restore(restoreArgs);assert.equal(result.status,status);assert.equal(result.replies,undefined);assert.equal(f.sends,0);assert.equal(f.nativeOperations.stops,0);
  }
});

test('restore prefers the live request cache and never reloads a busy owned turn',async()=>{
  const f=fixture('cancel');await f.bridge.start({requestId:'live-owned',inputText:'live'});await new Promise(resolve=>setTimeout(resolve,10));const first=f.bridge.query({requestId:'live-owned'}),result=await f.bridge.restore({requestId:'live-owned',nativeChatId:first.nativeChatId,userMessageId:first.userMessageId,responseMessageIds:first.responseMessageIds,includeContent:true});assert.equal(result.status,'sending');assert.equal(result.sendSettled,false);assert.equal(f.nativeOperations.loads.length,0);assert.equal(f.nativeOperations.stops,0);assert.equal(f.sends,1);
  await assert.rejects(f.bridge.restore({requestId:'missing-cache',nativeChatId:first.nativeChatId,userMessageId:'saved-user',responseMessageIds:[]}),/TURN_IN_PROGRESS/);assert.equal(f.detached[0].sessionState,'streaming');assert.equal(f.nativeOperations.loads.length,0);await f.bridge.cancel({requestId:'live-owned'});
});

test('a missing readonly loader contract fails closed before history load',async()=>{
  const record=savedTurn(),f=fixture('normal',new Map([[record.chatId,record]]));delete f.detached[0].config.services.loader.load;await assert.rejects(f.bridge.restore(restoreArgs),/READONLY_LOAD_CONTRACT_UNAVAILABLE/);assert.equal(f.nativeOperations.loads.length,0);assert.equal(f.sends,0);
});

test('bootstrap reattaches to an owned busy request without loading or resetting its MCP scope',async()=>{
  const f=fixture('cancel'),connection={serverName:'AgentRoom',config:{type:'streamable-http',url:assignedUrl}};await f.bridge.registerMcpConnection(connection);await f.bridge.start({requestId:'busy-existing',inputText:'busy'});await new Promise(resolve=>setTimeout(resolve,10));const before=f.bridge.inspect(),runtimeKey='busy-current',sandbox={fixtureMod:f.mod,document:{scripts:[{src:QWEN_NATIVE_CONTRACT.moduleUrl}]},crypto:globalThis.crypto,URL,setTimeout,__agentOfficeQwenNativeSessions:{[runtimeKey]:f.bridge}};
  const expression=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT,nativeChatId:before.nativeChatId,mcpConnection:connection}).replace('await import(args.moduleUrl)','fixtureMod');const state=await vm.runInNewContext(expression,sandbox);assert.equal(state.nativeSessionId,before.nativeSessionId);assert.equal(state.state,'streaming');assert.equal(f.nativeOperations.loads.length,0);assert.equal(f.nativeOperations.stops,0);assert.equal(f.mcpOperations.updates.length,0);
  const wrong=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT,nativeChatId:before.nativeChatId,mcpConnection:{...connection,config:{type:'streamable-http',url:otherAssignedUrl}}}).replace('await import(args.moduleUrl)','fixtureMod');await assert.rejects(vm.runInNewContext(wrong,sandbox),/MCP_IDENTITY_MISMATCH/);await f.bridge.cancel({requestId:'busy-existing'});
});

test('ready-looking native state still reattaches to the unsettled original request',async()=>{
  const f=fixture('stall');await f.bridge.start({requestId:'not-settled',inputText:'still owns native promise'});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.bridge.inspect().state,'ready');assert.equal(f.bridge.inspect().ownedTurnPending,true);
  const runtimeKey='pending_ready',sandbox={fixtureMod:f.mod,document:{scripts:[{src:QWEN_NATIVE_CONTRACT.moduleUrl}]},crypto:globalThis.crypto,URL,setTimeout,__agentOfficeQwenNativeSessions:{[runtimeKey]:f.bridge}};const expression=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT,nativeChatId:f.bridge.inspect().nativeChatId}).replace('await import(args.moduleUrl)','fixtureMod');const state=await vm.runInNewContext(expression,sandbox);assert.equal(state.ownedRequestId,'not-settled');assert.equal(state.ownedTurnPending,true);f.bridge.dispose();assert.equal(f.detached[0].destroyed,undefined);assert.equal(f.nativeOperations.loads.length,0);f.detached[0].release();assert.equal((await f.bridge.awaitCompletion({requestId:'not-settled'})).status,'completed');
});

test('native connection verification returns only assigned live identity metadata',async()=>{
  const f=fixture();await f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:assignedUrl}});f.mcpApi.mcp_client_tool_call=async input=>{f.mcpOperations.calls.push(input);return {content:[{type:'text',text:JSON.stringify({member_id:'wrong-untrusted-summary',connection:{member_id:'person_a',instance_id:'office-runtime',server_version:'0.14.16',rooms:[{id:'room1',title:'private title'}]},members:[{token:'private token'}]})}]};};
  const proof=await f.bridge.verifyConnection();assert.deepEqual(proof,{member_id:'person_a',instance_id:'office-runtime',server_version:'0.14.16',room_count:1});assert.deepEqual(f.mcpOperations.calls,[{serverName:'AgentRoom',toolName:'agentroom_chat_rooms',toolArguments:{}}]);assert.equal(JSON.stringify(proof).includes('private'),false);assert.equal(f.sends,0);assert.equal(f.visible.chatId,'user-current-chat');
});

test('old rooms verification uses only a scoped readonly inbox fallback and discards messages',async()=>{
  const f=fixture();await f.bridge.registerMcpConnection({serverName:'NewPerson',config:{type:'streamable-http',url:otherAssignedUrl}});const target=f.bridge.inspect().mcpServerName;f.mcpApi.mcp_client_tool_call=async input=>{f.mcpOperations.calls.push(input);return {content:[{type:'text',text:JSON.stringify(input.toolName==='agentroom_chat_rooms'?{member_id:'person_b',rooms:[]}:{items:[{text:'private message',credential:'never return'}],connection:{member_id:'person_b',instance_id:'office-runtime',server_version:'0.14.15',rooms:[]}})}]};};
  assert.deepEqual(await f.bridge.verifyConnection(),{member_id:'person_b',instance_id:'office-runtime',server_version:'0.14.15',room_count:0});assert.deepEqual(f.mcpOperations.calls.map(call=>call.toolName),['agentroom_chat_rooms','agentroom_chat_inbox']);assert.ok(f.mcpOperations.calls.every(call=>call.serverName===target&&Object.keys(call.toolArguments).length===0));assert.equal(f.sends,0);
});

test('connection proof fails closed on missing metadata, tool error or reassigned runtime',async()=>{
  const f=fixture();await assert.rejects(f.bridge.verifyConnection(),/ASSIGNED_MCP_REQUIRED/);await f.bridge.registerMcpConnection({serverName:'AgentRoom',config:{type:'streamable-http',url:assignedUrl}});await assert.rejects(f.bridge.verifyConnection(),/CONNECTION_PROOF_MISSING/);
  f.mcpApi.mcp_client_tool_call=async()=>({isError:true,content:[{type:'text',text:JSON.stringify({member_id:'person_a',instance_id:'office-runtime',server_version:'0.14.16'})}]});await assert.rejects(f.bridge.verifyConnection(),/CONNECTION_PROOF_FAILED/);
  f.runtimeConfig.AgentRoom.url=otherAssignedUrl;await assert.rejects(f.bridge.verifyConnection(),/MCP_IDENTITY_MISMATCH/);assert.equal(f.sends,0);
});

test('public driver exposes exact restore and readonly connection verification methods',async()=>{
  const expressions=[],driver=new DesktopQwen({evaluate:async code=>{expressions.push(code);return code.includes('const args=')?{contract:QWEN_NATIVE_CONTRACT.version,detached:true,nativeChatId:'saved-owned-chat'}:{nativeChatId:'saved-owned-chat',status:'completed'};},runtimeKey:'person_restore',...QWEN_NATIVE_CONTRACT,nativeChatId:'saved-owned-chat'});await driver.restore(restoreArgs);await driver.verifyConnection();assert.match(expressions[1],/\["restore"\]/);assert.ok(expressions[1].includes(JSON.stringify(restoreArgs)));assert.match(expressions[2],/\["verifyConnection"\]/);await assert.rejects(driver.restore({...restoreArgs,nativeChatId:'other-chat'}),/PERSON_CHAT_ID_MISMATCH/);
});

test('a settled native provider failure permits a new request at the same server parent without retrying the failed request',async()=>{
  const f=fixture('error-server');await f.bridge.start({requestId:'failed-owned',inputText:'first attempt'});const failed=await f.bridge.awaitCompletion({requestId:'failed-owned'});assert.equal(failed.status,'error');assert.equal(failed.error.code,'quota_limit');assert.equal(failed.sendSettled,true);const failedId=f.detached[0].history.currentId;assert.equal(failedId,'reply-server-1');
  f.setMode('normal');await f.bridge.start({requestId:'new-after-error',inputText:'new authorized message',nativeChatId:failed.nativeChatId});const next=await f.bridge.awaitCompletion({requestId:'new-after-error'});assert.equal(next.status,'completed');assert.equal(next.nativeChatId,failed.nativeChatId);assert.equal(f.detached[0].history.messages[next.userMessageId].parentId,failedId);assert.equal(f.detached[0].history.messages[failedId].error.errorCode,'quota_limit');assert.equal(f.sends,2);
  const original=await f.bridge.start({requestId:'failed-owned',inputText:'first attempt'});assert.equal(original.status,'error');assert.equal(original.userMessageId,failed.userMessageId);assert.equal(f.sends,2);assert.equal(f.visible.chatId,'user-current-chat');
});

test('an acknowledged and settled stopped response permits a distinct new request in the same native conversation',async()=>{
  const f=fixture('cancel-server');await f.bridge.start({requestId:'stopped-owned',inputText:'cancel this'});await new Promise(resolve=>setTimeout(resolve,10));const stopped=await f.bridge.cancel({requestId:'stopped-owned'});assert.equal(stopped.status,'cancelled');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.bridge.query({requestId:'stopped-owned'}).sendSettled,true);const stoppedId=f.detached[0].history.currentId;
  f.setMode('normal');await f.bridge.start({requestId:'new-after-stop',inputText:'new authorized message',nativeChatId:stopped.nativeChatId});const next=await f.bridge.awaitCompletion({requestId:'new-after-stop'});assert.equal(next.status,'completed');assert.equal(next.nativeChatId,stopped.nativeChatId);assert.equal(f.detached[0].history.messages[next.userMessageId].parentId,stoppedId);assert.equal(f.detached[0].history.messages[stoppedId].is_stop,true);assert.equal(f.sends,2);assert.equal(f.nativeOperations.stops,1);
  await f.bridge.start({requestId:'stopped-owned',inputText:'cancel this'});assert.equal(f.sends,2);
});

test('terminal error flags and ready state cannot bypass an unsettled original native promise',async()=>{
  const f=fixture('error-pending');await f.bridge.start({requestId:'pending-failure',inputText:'pending'});await new Promise(resolve=>setTimeout(resolve,10));const failed=f.bridge.query({requestId:'pending-failure'});assert.equal(failed.status,'error');assert.equal(failed.sendSettled,false);assert.equal(failed.nativeState,'ready');assert.equal(f.bridge.inspect().ownedTurnPending,true);
  await assert.rejects(f.bridge.start({requestId:'must-not-start',inputText:'new message',nativeChatId:failed.nativeChatId}),/TURN_IN_PROGRESS/);f.bridge.dispose();assert.equal(f.detached[0].destroyed,undefined);assert.equal(f.sends,1);
  f.detached[0].release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.bridge.query({requestId:'pending-failure'}).sendSettled,true);f.setMode('normal');await f.bridge.start({requestId:'now-new',inputText:'distinct new message',nativeChatId:failed.nativeChatId});assert.equal((await f.bridge.awaitCompletion({requestId:'now-new'})).status,'completed');assert.equal(f.sends,2);
});

test('a swallowed stop does not allow another request past the still unacknowledged response',async()=>{
  const f=fixture('cancel-server');await f.bridge.start({requestId:'unacknowledged-stop',inputText:'cancel this'});await new Promise(resolve=>setTimeout(resolve,10));const stop=f.detached[0].stopResponse.bind(f.detached[0]);f.detached[0].stopResponse=async()=>{};const result=await f.bridge.cancel({requestId:'unacknowledged-stop'});assert.equal(result.status,'sending');assert.equal(result.sendSettled,false);await assert.rejects(f.bridge.start({requestId:'must-not-jump',inputText:'new'}),/TURN_IN_PROGRESS/);assert.equal(f.sends,1);f.detached[0].stopResponse=stop;await f.bridge.cancel({requestId:'unacknowledged-stop'});
});

test('readonly loaded terminal failed or cancelled AO history permits a new request without resurrecting the old turn',async()=>{
  for(const patch of [{error:{errorCode:'quota_limit',errorMessage:'saved limit'}},{stopped:true}]) {
    const record=savedTurn(patch),f=fixture('normal',new Map([[record.chatId,record]]));await f.bridge.ensureConversation({nativeChatId:record.chatId});assert.equal(f.bridge.query({requestId:'saved-request'}).status,'unknown_request');await f.bridge.start({requestId:'new-after-restart',inputText:'new message only',nativeChatId:record.chatId});const next=await f.bridge.awaitCompletion({requestId:'new-after-restart'});assert.equal(next.status,'completed');assert.equal(next.nativeChatId,record.chatId);assert.equal(f.detached[0].history.messages[next.userMessageId].parentId,'saved-answer');assert.equal(f.sends,1);assert.equal(f.nativeOperations.stops,0);assert.deepEqual(f.nativeOperations.resumes,[]);
  }
});

test('restored confirmed error is settled and can be followed by a new distinct native request',async()=>{
  const record=savedTurn({error:{errorCode:'quota_limit',errorMessage:'saved limit'}}),f=fixture('normal',new Map([[record.chatId,record]]));const restored=await f.bridge.restore(restoreArgs);assert.equal(restored.status,'error');assert.equal(restored.sendSettled,true);await f.bridge.start({requestId:'after-restored-error',inputText:'new only',nativeChatId:record.chatId});const next=await f.bridge.awaitCompletion({requestId:'after-restored-error'});assert.equal(next.status,'completed');assert.equal(f.detached[0].history.messages[next.userMessageId].parentId,'saved-answer');assert.equal(f.sends,1);
});

test('unknown local, unowned loaded, unfinished and placeholder failure parents stay blocked',async()=>{
  const record=savedTurn({error:{errorCode:'quota_limit',errorMessage:'limit'}});
  const local=fixture();await local.bridge.ensureConversation();Object.assign(local.detached[0],structuredClone(record),{chatLoaded:true,sessionState:'ready'});await assert.rejects(local.bridge.start({requestId:'unknown-local',inputText:'do not send'}),/TERMINAL_UNCONFIRMED/);assert.equal(local.sends,0);
  for(const variant of ['unowned','unfinished','placeholder','pending-sibling']) {
    const saved=structuredClone(record);
    if(variant==='unowned')delete saved.history.messages['saved-user'].extra;
    if(variant==='unfinished')saved.history.messages['saved-answer'].done=false;
    if(variant==='placeholder')saved.history.messages['saved-answer'].id=null;
    if(variant==='pending-sibling')saved.history.messages.pending={id:'pending',role:'assistant',parentId:'saved-user',done:false};
    const f=fixture('normal',new Map([[saved.chatId,saved]]));await f.bridge.ensureConversation({nativeChatId:saved.chatId});await assert.rejects(f.bridge.start({requestId:'must-not-jump',inputText:'do not send',nativeChatId:saved.chatId}),/PARENT_(?:TERMINAL_UNCONFIRMED|NOT_TERMINAL_ASSISTANT|SERVER_ID_MISSING)/);assert.equal(f.sends,0);assert.equal(f.nativeOperations.stops,0);
  }
});

test('upgrade refuses an old ready-looking error bridge whose submit promise is not settled',async()=>{
  const f=fixture(),runtimeKey='legacy_error_pending';let disposed=0;const old={inspect:()=>({adapterRevision:'mcp-person-restore-v2',nativeChatId:'owned-chat',state:'ready',ownedRequestId:'pending-original',ownedTurnPending:false}),query:()=>({status:'error',sendSettled:false}),dispose:()=>disposed++};const sandbox={fixtureMod:f.mod,document:{scripts:[{src:QWEN_NATIVE_CONTRACT.moduleUrl}]},crypto:globalThis.crypto,URL,setTimeout,__agentOfficeQwenNativeSessions:{[runtimeKey]:old}},expression=buildQwenNativeBootstrap({runtimeKey,...QWEN_NATIVE_CONTRACT}).replace('await import(args.moduleUrl)','fixtureMod');await assert.rejects(vm.runInNewContext(expression,sandbox),/ADAPTER_UPGRADE_BUSY/);assert.equal(disposed,0);assert.equal(f.detached.length,1);
});
