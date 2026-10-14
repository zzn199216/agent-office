'use strict';

// Self-contained native-webview adapter. No controller send, pool switch or
// foreground input reset. The caller must verify its loaded bundle beforehand.
function createQwenNativeDetachedBridge(mod, options = {}) {
  if (options.contractVersion !== 'qwen-chat-fe-0.3.17-detached-v1') throw Error('QWEN_NATIVE_VERSION_GUARD_REQUIRED');
  const c = mod.av, models = mod._, settings = mod.y, mcp = mod.d9;
  const original = c?.pool?.currentSession || [...c?.pool?.sessions?.values?.() || []][0];
  const NativeSession = original?.constructor;
  if (!NativeSession || typeof c.pool.config.sessionConfigFactory !== 'function' || !['submitPrompt','loadChat','stopResponse','createContext','handleMcpLoop','getCanonicalResponseId'].every(k => typeof NativeSession.prototype[k] === 'function')) throw Error('QWEN_NATIVE_DETACHED_CONTRACT_UNAVAILABLE');
  const config = c.pool.config.sessionConfigFactory();
  if (!['sender','streamHandler','loader','messageService','mcpHandler'].every(k => config.services?.[k])) throw Error('QWEN_NATIVE_SERVICES_UNAVAILABLE');
  config.loggerOptions = {...config.loggerOptions,enableConsole:false};
  const quiet = {debug(){},info(){},log(){},warn(){},error(){}};
  config.logger = quiet;
  // The factory creates a fresh notifier shared by this session's services.
  // Suppress its error toasts so background failures cannot interrupt the UI.
  if (config.notifier) for (const key of ['success','info','warning','error']) config.notifier[key] = () => {};
  for (const service of Object.values(config.services)) {
    if (service && 'logger' in service) service.logger = quiet;
    if (service?.config?.logger) service.config.logger = quiet;
  }
  const native = new NativeSession(config, () => false);
  // This frontend calls handleMcpLoop with its temporary response ID even after
  // the stream has moved the history record to the server ID. Resolve it only
  // on this detached instance, through Qwen's own canonical-ID method.
  const nativeMcpLoop = native.handleMcpLoop.bind(native);
  native.handleMcpLoop = (context,handler,model,responseId,...args) => nativeMcpLoop(context,handler,model,native.getCanonicalResponseId(responseId),...args);
  const turns = new Map(), terminalStatuses = new Set(['completed','error','cancelled','not_started','incomplete']);
  let active = null, preparing = false, server = null, assignedUrl = null, initialized = false,loadedHistoryProof = false;
  const nativeMcpApi=options.mcpApi || globalThis.electronAPI;
  const mcpClient=config.services.mcpHandler.mcpClient;
  const summary = () => ({nativeChatId:native.chatId || null,nativeSessionId:native.id,state:native.sessionState,loaded:!!native.chatLoaded,detached:native.isActiveInPool === false});
  const busy = () => native.isChat || ['sending','streaming','loading'].includes(native.sessionState);
  const safeError = e => ({code:String(e?.errorCode || e?.code || 'QWEN_NATIVE_ERROR'),message:String(e?.errorMessage || e?.message || 'Native turn failed').slice(0,300)});
  const responseText = m => typeof m.content === 'string' && m.content.trim() ? m.content : (m.content_list || []).filter(p => p.phase === 'answer' && typeof p.content === 'string').map(p => p.content).join('');
  const toolSummary = m => (m.content_list || []).filter(p=>p.phase==='local_tool').map(p=>({
    calls:Object.entries(p.extra?.local_mcp || {}).flatMap(([service,calls])=>(Array.isArray(calls)?calls:[]).map(call=>({service,toolName:call.tool_name}))),
    results:Object.entries(p.mcp_results || {}).flatMap(([service,results])=>(Array.isArray(results)?results:[]).flatMap(result=>Object.keys(result).map(toolName=>({service,toolName}))))
  }));
  function descends(m, userIds, history) {
    let id = m.parentId || m.parent_id;
    const seen = new Set();
    while (id && !seen.has(id) && seen.size < 100) {
      if (userIds.has(id)) return true;
      seen.add(id); const parent = history[id] || Object.values(history).find(message=>message.id===id);
      // A later user turn can point at this answer. Its descendants belong to
      // that later turn even though the complete history forms one parent tree.
      if(parent?.role==='user')return false;
      id = parent?.parentId || parent?.parent_id;
    }
    return false;
  }
  function refresh(t) {
    if (terminalStatuses.has(t.status)) return;
    if (native.chatId) t.nativeChatId = native.chatId;
    const history = native.history?.messages || {}, entries = Object.entries(history);
    const users = entries.filter(([key,m]) => m.role === 'user' && !t.baseline.has(key) && (m.extra?.meta?.agent_office_request_id === t.requestId || m.content === t.text));
    if (users.length === 1) {
      const [key,u] = users[0]; t.userMessageId = u.id || u.fid || key;
      for (const id of [key,u.id,u.fid].filter(Boolean)) t.userIds.add(id);
    }
    const replies = entries.filter(([key,m]) => m.role === 'assistant' && !t.baseline.has(key) && descends(m,t.userIds,history));
    for (const [key,m] of replies) for (const id of [key,m.id].filter(Boolean)) t.responseIds.add(id);
    const error = replies.map(([,m]) => m.error).find(Boolean);
    if (error) {t.error = safeError(error); t.status = 'error'; return;}
    t.started = users.length === 1 && replies.length > 0;
    if(t.cancelRequested && t.started && replies.every(([,message])=>message.done===true&&message.is_stop===true) && !busy()) {t.status='cancelled';return;}
    const complete = replies.filter(([,m]) => m.done === true && m.is_stop !== true);
    // Inactive native sessions suppress foreground hooks; require the complete
    // submit/MCP promise and exact terminal assistant descendants instead.
    if (t.settled && t.started && complete.length === replies.length && complete.length > 0 && native.sessionState === 'ready' && !busy()) {
      t.status = 'completed'; t.replies = complete.map(([key,m]) => ({id:m.id || m.fid || key,role:'assistant',parentId:m.parentId || m.parent_id || null,content:responseText(m),done:true,toolPhases:toolSummary(m)}));
    } else if (t.settled && !busy()) t.status = native.sessionState === 'error' ? 'error' : t.started ? 'incomplete' : 'not_started';
  }
  function query({requestId,includeContent = false} = {}) {
    const t = turns.get(requestId); if (!t) return {status:'unknown_request'};
    refresh(t);
    const out = {requestId,status:t.status,nativeChatId:t.nativeChatId || null,nativeSessionId:native.id,userMessageId:t.userMessageId || null,responseMessageIds:[...t.responseIds],started:t.started,sendSettled:t.settled,cancelRequested:!!t.cancelRequested,nativeState:native.sessionState,error:t.error || null};
    if (includeContent && t.status === 'completed') out.replies = t.replies;
    if(t.restored)out.restoredFromHistory=true;
    return out;
  }
  function ownedTurnPending() {
    if(!active)return false;
    const turn=turns.get(active);
    return !turn || !turn.settled || !terminalStatuses.has(query({requestId:active}).status);
  }
  async function loadConversationReadOnly(nativeChatId) {
    const loader=config.services.loader,load=loader.load,resume=native.resumePendingAsyncTasks;
    if(typeof load!=='function' || typeof resume!=='function')throw Error('QWEN_NATIVE_READONLY_LOAD_CONTRACT_UNAVAILABLE');
    // Qwen's loadChat otherwise resumes unfinished streams automatically. Its
    // fresh loader belongs only to this detached session; retain the real
    // history flags while removing load-time dispatch instructions.
    loader.load=async(...args)=>{const result=await load.apply(loader,args);return {...result,continuedResponseIds:[],asyncTaskMessages:[]};};
    native.resumePendingAsyncTasks=async()=>{};
    try {await native.loadChat(nativeChatId);}
    finally {loader.load=load;native.resumePendingAsyncTasks=resume;}
    if(native.chatId!==nativeChatId || !native.chatLoaded || native.sessionState!=='ready')throw Error('QWEN_NATIVE_RESUME_FAILED');
    loadedHistoryProof=true;
  }
  async function ensureConversation({nativeChatId = null,modelId = options.modelId} = {}) {
    if (busy() || ownedTurnPending()) throw Error('QWEN_NATIVE_TURN_IN_PROGRESS');
    if (initialized && nativeChatId && native.chatId && native.chatId !== nativeChatId) throw Error('QWEN_NATIVE_PERSON_CHAT_ID_MISMATCH');
    if (nativeChatId && (!native.chatLoaded || native.chatId !== nativeChatId)) {
      await loadConversationReadOnly(nativeChatId);
    }
    if (!native.models?.length) {
      const ids = modelId ? [modelId] : models?.getState()?.selectedModelIds || [];
      if (ids.length !== 1) throw Error('QWEN_NATIVE_SINGLE_MODEL_REQUIRED');
      native.setSessionParams({models:ids,settings:settings?.getState()?.settings || {}});
      native.configureDomainState({currentInputFeature:'t2t',currentInputSubType:'t2t',chatMode:'normal'});
    }
    if (!initialized) native.setSessionParams({settings:settings?.getState()?.settings || {}});
    initialized = true; return summary();
  }
  async function restore({requestId,nativeChatId,userMessageId,responseMessageIds = [],includeContent = false} = {}) {
    if(typeof requestId!=='string' || !requestId || typeof nativeChatId!=='string' || !nativeChatId || typeof userMessageId!=='string' || !userMessageId || !Array.isArray(responseMessageIds) || responseMessageIds.some(id=>typeof id!=='string'||!id))throw Error('QWEN_NATIVE_RESTORE_INVALID_REQUEST');
    if(options.nativeChatId && options.nativeChatId!==nativeChatId || native.chatId && native.chatId!==nativeChatId)throw Error('QWEN_NATIVE_PERSON_CHAT_ID_MISMATCH');
    const cached=turns.get(requestId);
    if(cached && !cached.restored) {
      const state=query({requestId,includeContent});
      if(cached.nativeChatId && cached.nativeChatId!==nativeChatId || cached.userIds.size && !cached.userIds.has(userMessageId))throw Error('QWEN_NATIVE_RESTORE_USER_IDENTITY_MISMATCH');
      if(responseMessageIds.length && !responseMessageIds.some(id=>cached.responseIds.has(id)))throw Error('QWEN_NATIVE_RESTORE_RESPONSE_IDENTITY_MISMATCH');
      return state;
    }
    if(busy() || preparing || ownedTurnPending())throw Error('QWEN_NATIVE_TURN_IN_PROGRESS');
    preparing=true;
    try {
      await loadConversationReadOnly(nativeChatId);initialized=true;
      const history=native.history?.messages || {},entries=Object.entries(history);
      const users=entries.filter(([,message])=>message.role==='user'&&message.id===userMessageId);
      if(users.length!==1)throw Error('QWEN_NATIVE_RESTORE_USER_IDENTITY_MISMATCH');
      const [userKey,user]=users[0],tag=user.extra?.meta?.agent_office_request_id;
      if(tag && tag!==requestId)throw Error('QWEN_NATIVE_RESTORE_REQUEST_IDENTITY_MISMATCH');
      const userIds=new Set([userKey,user.id,user.fid].filter(Boolean));
      const candidates=entries.filter(([,message])=>message.role==='assistant'&&message.id&&descends(message,userIds,history));
      const saved=new Set(responseMessageIds),matched=candidates.filter(([key,message])=>[key,message.id,message.fid].some(id=>saved.has(id)));
      if(saved.size && !matched.length)throw Error('QWEN_NATIVE_RESTORE_RESPONSE_IDENTITY_MISMATCH');
      const anchors=new Set(matched.flatMap(([key,message])=>[key,message.id,message.fid].filter(Boolean)));
      const replies=saved.size?candidates.filter(([key,message])=>anchors.has(key)||anchors.has(message.id)||descends(message,anchors,history)||matched.some(([,anchor])=>descends(anchor,new Set([key,message.id]),history))):candidates;
      // A single-model owned turn must remain one exact response chain, even
      // when a saved intermediate response later gains multiple branches.
      if(replies.some(([,message],index)=>replies.slice(index+1).some(([,other])=>!descends(message,new Set([other.id]),history)&&!descends(other,new Set([message.id]),history))))throw Error('QWEN_NATIVE_RESTORE_RESPONSE_IDENTITY_MISMATCH');
      const t={requestId,text:user.content,nativeChatId,status:'incomplete',baseline:new Set(),userIds,responseIds:new Set(replies.map(([,message])=>message.id)),userMessageId,started:replies.length>0,settled:false,restored:true};
      const error=replies.map(([,message])=>message.error).find(Boolean);
      if(error){t.status='error';t.error=safeError(error);t.settled=replies.length>0&&replies.every(([,message])=>message.done===true);}
      else if(replies.length && replies.every(([,message])=>message.done===true&&message.is_stop===true)){t.status='cancelled';t.cancelRequested=true;t.settled=true;}
      else if(replies.length && replies.every(([,message])=>message.done===true&&message.is_stop!==true) && replies.some(([,message])=>responseText(message).trim())) {
        t.status='completed';t.settled=true;
        t.replies=replies.map(([key,message])=>({id:message.id || key,role:'assistant',parentId:message.parentId || message.parent_id || null,content:responseText(message),done:true,toolPhases:toolSummary(message)}));
      }
      turns.set(requestId,t);return query({requestId,includeContent});
    } finally {preparing=false;}
  }
  function connectionUrl(value) {
    let url;try{url=new URL(value);}catch{throw Error('QWEN_NATIVE_MCP_URL_INVALID');}
    if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/^\/mcp\/[^/]+\/[^/]+$/.test(url.pathname))throw Error('QWEN_NATIVE_MCP_URL_INVALID');
    return url.href;
  }
  function storedUrl(entry) {try{return connectionUrl(entry?.params?.url);}catch{return null;}}
  function assignedTarget() {
    const entry=mcp?.getMCPServers?.().find(entry=>entry.name===server);
    if(!entry || !assignedUrl || storedUrl(entry)!==assignedUrl || entry.type!=='httpStream')throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
    return entry;
  }
  function mcpRegistrationAvailable() {
    return !!mcp && typeof mcp.getMCPServers==='function' && typeof mcp.addMCPServer==='function' && typeof mcp.updateMCPServer==='function' && ['mcp_client_get_config','mcp_client_update_config','mcp_client_tool_list','mcp_client_tool_call'].every(key=>typeof nativeMcpApi?.[key]==='function');
  }
  function withMcpMutation(work) {
    const previous=globalThis.__agentOfficeQwenNativeMcpMutation || Promise.resolve();
    const next=previous.catch(()=>{}).then(work);
    globalThis.__agentOfficeQwenNativeMcpMutation=next.then(()=>{},()=>{});
    return next;
  }
  function runtimeUrl(config) {try{return connectionUrl(config?.url);}catch{return null;}}
  async function synchronizeAssignedMcp({discover=false} = {}) {
    if(!mcpRegistrationAvailable())throw Error('QWEN_NATIVE_MCP_REGISTRATION_UNAVAILABLE');
    const target=assignedTarget();
    let current;try{current=await nativeMcpApi.mcp_client_get_config();}catch{throw Error('QWEN_NATIVE_MCP_RUNTIME_READ_FAILED');}
    if(!current || typeof current!=='object' || Array.isArray(current))throw Error('QWEN_NATIVE_MCP_RUNTIME_CONFIG_INVALID');
    if(current[server] && (runtimeUrl(current[server])!==assignedUrl || current[server].transportType!=='httpStream'))throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
    if(!current[server]) {
      const merged={...current};
      // Native update_config replaces the complete proxy map. Preserve actual
      // runtime services and every stored user service; never use nu.connect or
      // isAvailable, which write only their selected subset.
      for(const entry of mcp.getMCPServers())if(entry?.name && entry.params && !Object.prototype.hasOwnProperty.call(merged,entry.name))merged[entry.name]={...entry.params,name:entry.name,transportType:entry.type};
      merged[server]={...target.params,name:server,transportType:'httpStream'};
      try{await nativeMcpApi.mcp_client_update_config(merged);}catch{throw Error('QWEN_NATIVE_MCP_RUNTIME_UPDATE_FAILED');}
    }
    if(discover || target.connectionStatus!=='available' || !target.tools?.length) {
      let result;try{result=await nativeMcpApi.mcp_client_tool_list(server);}catch{throw Error('QWEN_NATIVE_MCP_DISCOVERY_FAILED');}
      if(!Array.isArray(result?.tools) || !result.tools.length)throw Error('QWEN_NATIVE_MCP_TOOLS_UNAVAILABLE');
      mcp.updateMCPServer(target.id,{tools:result.tools,connectionStatus:'available',errorMessage:''});
    }
    return [];
  }
  function scopeAssignedMcp() {
    if(!mcpClient)throw Error('QWEN_NATIVE_MCP_CONTRACT_UNAVAILABLE');
    mcpClient.connect=()=>withMcpMutation(()=>synchronizeAssignedMcp());
    mcpClient.getFormatAvailableServerMap=()=>{
      const target=assignedTarget();
      if(target.connectionStatus!=='available' || !target.tools?.length)throw Error('QWEN_NATIVE_MCP_TOOLS_UNAVAILABLE');
      return {[server]:Object.fromEntries(target.tools.map(tool=>[tool.name,{description:tool.description,input_schema:tool.inputSchema}]))};
    };
    mcpClient.callTool=async input=>{
      if(input?.serverName!==server)throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
      assignedTarget();
      // Repair a lost proxy registration under the shared mutation lock. Other
      // persons' configurations are retained and never become this tool scope.
      await withMcpMutation(()=>synchronizeAssignedMcp());
      let result;try{result=await nativeMcpApi.mcp_client_tool_call({serverName:server,toolName:input.toolName,toolArguments:input.toolArguments});}catch{throw Error('QWEN_NATIVE_MCP_CALL_FAILED');}
      return result?{content:result.content,isError:result.isError===true}:null;
    };
  }
  async function registerMcpConnection(connection) {
    if(busy() || preparing)throw Error('QWEN_NATIVE_TURN_IN_PROGRESS');
    if(!connection || typeof connection.serverName!=='string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(connection.serverName) || ['__proto__','constructor','prototype'].includes(connection.serverName) || connection.config?.type!=='streamable-http' || Object.keys(connection.config).some(key=>!['type','url'].includes(key)))throw Error('QWEN_NATIVE_MCP_CONNECTION_INVALID');
    const url=connectionUrl(connection.config.url);
    if(assignedUrl && assignedUrl!==url)throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
    if(!mcpRegistrationAvailable())throw Error('QWEN_NATIVE_MCP_REGISTRATION_UNAVAILABLE');
    return withMcpMutation(async()=>{
      const entries=mcp.getMCPServers();
      let runtime;try{runtime=await nativeMcpApi.mcp_client_get_config();}catch{throw Error('QWEN_NATIVE_MCP_RUNTIME_READ_FAILED');}
      if(!runtime || typeof runtime!=='object' || Array.isArray(runtime))throw Error('QWEN_NATIVE_MCP_RUNTIME_CONFIG_INVALID');
      let target=entries.find(entry=>entry.type==='httpStream' && storedUrl(entry)===url && entry.name===connection.serverName) || entries.find(entry=>entry.type==='httpStream' && storedUrl(entry)===url);
      if(!target) {
        const equivalent=Object.entries(runtime).find(([name,value])=>name===connection.serverName && value?.transportType==='httpStream' && runtimeUrl(value)===url) || Object.entries(runtime).find(([,value])=>value?.transportType==='httpStream' && runtimeUrl(value)===url);
        let name=equivalent?.[0] || connection.serverName;
        const usedNames=new Set([...entries.map(entry=>entry.name),...Object.keys(runtime)]);
        if(!equivalent && usedNames.has(name)) {
          const suffix=(options.runtimeKey || globalThis.crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g,'').slice(-20);
          name=name.slice(0,70)+'_ao_'+suffix;
          let index=1;const base=name;while(usedNames.has(name))name=base+'_'+index++;
        }
        target={id:globalThis.crypto.randomUUID(),name,type:'httpStream',params:{url},enabled:true,default:false,connectionStatus:'connecting',errorMessage:'',tools:[]};
        mcp.addMCPServer(target);
      } else if(!target.enabled) {
        // Only the URL-exact assigned connection is being authorized here.
        mcp.updateMCPServer(target.id,{enabled:true});
      }
      server=target.name;assignedUrl=url;
      await synchronizeAssignedMcp({discover:target.connectionStatus!=='available' || !target.tools?.length});
      scopeAssignedMcp();
      const actual=assignedTarget();
      return {serverName:server,enabled:true,configuredToolCount:actual.tools.length,connectionStatus:actual.connectionStatus};
    });
  }
  async function enableMcp({existingServerName,expectedUrl} = {}) {
    if(!expectedUrl && !assignedUrl)throw Error('QWEN_NATIVE_ASSIGNED_MCP_REQUIRED');
    const target=mcp?.getMCPServers?.().find(entry=>entry.name===existingServerName);
    if(!target)throw Error('QWEN_NATIVE_EXISTING_MCP_NOT_FOUND');
    if(storedUrl(target)!==connectionUrl(expectedUrl || assignedUrl))throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
    if(!target.enabled)throw Error('QWEN_NATIVE_EXISTING_MCP_DISABLED');
    return registerMcpConnection({serverName:existingServerName,config:{type:'streamable-http',url:expectedUrl || assignedUrl}});
  }
  function validateAttachment({nativeChatId,mcpConnection = null} = {}) {
    if(!nativeChatId || nativeChatId!==native.chatId)throw Error('QWEN_NATIVE_PERSON_CHAT_ID_MISMATCH');
    if(mcpConnection) {
      if(mcpConnection.config?.type!=='streamable-http' || connectionUrl(mcpConnection.config.url)!==assignedUrl)throw Error('QWEN_NATIVE_MCP_IDENTITY_MISMATCH');
      assignedTarget();
    } else if(server)throw Error('QWEN_NATIVE_ASSIGNED_MCP_REQUIRED');
    return summary();
  }
  async function verifyConnection() {
    if(!server || !assignedUrl || typeof mcpClient?.callTool!=='function')throw Error('QWEN_NATIVE_ASSIGNED_MCP_REQUIRED');
    assignedTarget();
    const parse=async toolName=>{
      const result=await mcpClient.callTool({serverName:server,toolName,toolArguments:{}});
      if(result?.isError)throw Error('QWEN_NATIVE_MCP_CONNECTION_PROOF_FAILED');
      for(const block of result?.content || []) {
        if(block.type!=='text' || typeof block.text!=='string')continue;
        let value;try{value=JSON.parse(block.text);}catch{continue;}
        const connection=value?.connection || value;
        if(!connection || ['member_id','instance_id','server_version'].some(key=>typeof connection[key]!=='string'||!connection[key]||connection[key].length>200))continue;
        if(!/^[A-Za-z0-9_-]+$/.test(connection.member_id) || !/^[A-Za-z0-9_-]+$/.test(connection.instance_id) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(connection.server_version))continue;
        const rooms=Array.isArray(connection.rooms)?connection.rooms:Array.isArray(value.rooms)?value.rooms:[];
        return {member_id:connection.member_id,instance_id:connection.instance_id,server_version:connection.server_version,room_count:rooms.length};
      }
      return null;
    };
    // Older AO rooms responses omit instance identity. Their readonly inbox
    // response carries current authenticated connection metadata; discard all
    // message content and never acknowledge or consume an inbox item here.
    const result=await parse('agentroom_chat_rooms') || await parse('agentroom_chat_inbox');
    if(!result)throw Error('QWEN_NATIVE_MCP_CONNECTION_PROOF_MISSING');
    return result;
  }
  async function createConversation() {
    await ensureConversation();
    if(native.chatId)return summary();
    if(typeof config.services.sender.createChat!=='function')throw Error('QWEN_NATIVE_CREATE_CONTRACT_UNAVAILABLE');
    const created=await config.services.sender.createChat(native.createContext(),{chatId:'',models:native.models,project_id:native.projectId || '',timestamp:Date.now(),chat_type:'t2t',chat_mode:'normal'});
    if(!created?.chatId)throw Error('QWEN_NATIVE_CREATE_RESPONSE_MISSING');
    native.setChatId(created.chatId);
    native.configureDomainState({chatLoaded:true});
    return summary();
  }
  function submitParams(t) {
    const ids = native.models;
    if (ids.length !== 1) throw Error('QWEN_NATIVE_SINGLE_MODEL_REQUIRED');
    const model = models?.getState()?.models.find(m => m.id === ids[0]);
    if (!model) throw Error('QWEN_NATIVE_MODEL_CONTRACT_UNAVAILABLE');
    const history=native.history?.messages || {},parent = history[native.history.currentId];
    if (parent && (parent.role !== 'assistant' || parent.done !== true)) throw Error('QWEN_NATIVE_PARENT_NOT_TERMINAL_ASSISTANT');
    const parentId = parent?.id || null;
    if (parent && !parentId) throw Error('QWEN_NATIVE_PARENT_SERVER_ID_MISSING');
    if(parent && (parent.error || parent.is_stop)) {
      if(native.sessionState!=='ready')throw Error('QWEN_NATIVE_PARENT_TERMINAL_UNCONFIRMED');
      const owner=[...turns.values()].find(turn=>turn.responseIds.has(parentId));
      const confirmed=owner && owner.settled && ['error','cancelled'].includes(query({requestId:owner.requestId}).status) && owner.nativeChatId===native.chatId && descends(parent,owner.userIds,history) && Object.values(history).filter(value=>value.role==='assistant'&&descends(value,owner.userIds,history)).every(value=>value.done===true);
      let loadedTerminal=false;
      if(!confirmed && loadedHistoryProof) {
        // After a renderer restart, a readonly native server-history load is
        // authoritative terminal evidence. Require the AO-owned user's server
        // identity and every response in that exact turn to be done; never
        // treat a placeholder, another user branch or a local error as proof.
        let message=parent;const seen=new Set();
        while(message?.role==='assistant' && message.parentId && !seen.has(message.parentId) && seen.size<100){seen.add(message.parentId);message=history[message.parentId] || Object.values(history).find(value=>value.id===message.parentId);}
        if(message?.role==='user' && message.id && message.extra?.meta?.agent_office_request_id) {
          const ids=new Set([message.id,message.fid].filter(Boolean)),responses=Object.values(history).filter(value=>value.role==='assistant'&&descends(value,ids,history));
          loadedTerminal=responses.length>0&&responses.every(value=>value.id&&value.done===true);
        }
      }
      if(!confirmed && !loadedTerminal)throw Error('QWEN_NATIVE_PARENT_TERMINAL_UNCONFIRMED');
    }
    const userId = globalThis.crypto.randomUUID(), responseId = globalThis.crypto.randomUUID();
    t.userIds.add(userId); t.responseIds.add(responseId);
    const features = {thinking_enabled:false,output_schema:'phase',research_mode:'normal',...(server ? {mcp:[],local_mcp:{}} : {})};
    const common = {id:null,childrenIds:[],chat_type:'t2t',sub_chat_type:'t2t',user_action:'chat',feature_config:features,extra:{meta:{agent_office_request_id:t.requestId}},timestamp:Math.floor(Date.now()/1000)};
    const user = {...common,fid:userId,parentId,role:'user',content:t.text,models:ids,model:''};
    const response = {...common,fid:responseId,parentId:userId,role:'assistant',content:'',models:[],model:ids[0],modelName:model.name,modelIdx:0,userContext:null};
    return {inputText:t.text,files:[],models:ids,settings:{...native.settings,local_mcp_permission:'granted'},projectId:native.projectId || '',action:'chat',userMessage:user,userMessageId:userId,responseMessages:[{messageId:responseId,message:response,model:{id:ids[0],info:model.info || {}}}],sendContext:{emitSendPromptType:'chat',inputFeature:'t2t',models:[{id:ids[0],info:model.info || {}}],chatMode:'normal',branchInfo:null},isNewChat:!native.chatId,submitOptions:{branchInfo:null}};
  }
  async function start({requestId,inputText,nativeChatId = null} = {}) {
    if (!requestId || typeof inputText !== 'string' || !inputText.trim()) throw Error('QWEN_NATIVE_INVALID_REQUEST');
    if (turns.has(requestId)) {if (turns.get(requestId).text !== inputText) throw Error('QWEN_NATIVE_REQUEST_ID_CONFLICT'); return query({requestId});}
    if (preparing) throw Error('QWEN_NATIVE_START_IN_PROGRESS'); preparing = true;
    try {
      await ensureConversation({nativeChatId});
      const t = {requestId,text:inputText,nativeChatId:native.chatId,status:'sending',baseline:new Set(Object.keys(native.history?.messages || {})),userIds:new Set(),responseIds:new Set(),started:false,settled:false};
      const params = submitParams(t); turns.set(requestId,t); active = requestId;loadedHistoryProof=false;
      Promise.resolve().then(() => native.submitPrompt(params)).then(() => {t.settled=true;refresh(t);},e => {t.settled=true;t.status='error';t.error=safeError(e);});
      return query({requestId});
    } finally {preparing=false;}
  }
  async function awaitCompletion({requestId,timeoutMs = 30000,includeContent = false} = {}) {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs,0),60000);
    do {
      const out = query({requestId,includeContent}); if (out.status !== 'sending') return out;
      if (Date.now() >= deadline) return {...out,timedOut:true};
      await new Promise(resolve => setTimeout(resolve,Math.min(100,deadline-Date.now())));
    } while (true);
  }
  async function cancel({requestId} = {}) {
    const t = turns.get(requestId); if (!t || active !== requestId) throw Error('QWEN_NATIVE_CANCEL_IDENTITY_MISMATCH');
    if (query({requestId}).status === 'completed') return query({requestId});
    t.cancelRequested=true;
    await native.stopResponse(); return query({requestId});
  }
  async function resumePendingMcp({requestId,userMessageId,responseMessageId,allowedToolNames = []} = {}) {
    if(busy() || ownedTurnPending())throw Error('QWEN_NATIVE_TURN_IN_PROGRESS');
    const message=native.history?.messages?.[responseMessageId],user=native.history?.messages?.[userMessageId];
    if(!initialized || !server || message?.role!=='assistant' || message.parentId!==userMessageId || message.done===true || user?.role!=='user')throw Error('QWEN_NATIVE_PENDING_MCP_IDENTITY_MISMATCH');
    const phase=message.content_list?.at(-1),calls=Object.values(phase?.extra?.local_mcp || {}).flat();
    if(phase?.phase!=='local_tool' || !calls.length || calls.some(call=>!allowedToolNames.includes(call.tool_name)))throw Error('QWEN_NATIVE_PENDING_MCP_TOOLS_REJECTED');
    if((message.content_list || []).some(phase=>phase.mcp_results && Object.keys(phase.mcp_results).length))throw Error('QWEN_NATIVE_PENDING_MCP_ALREADY_EXECUTED');
    const model=models?.getState()?.models.find(model=>model.id===message.model);
    if(!model)throw Error('QWEN_NATIVE_MODEL_CONTRACT_UNAVAILABLE');
    const t={requestId,text:user.content,nativeChatId:native.chatId,status:'sending',baseline:new Set(Object.keys(native.history.messages).filter(key=>key!==responseMessageId&&key!==userMessageId)),userIds:new Set([userMessageId]),responseIds:new Set([responseMessageId]),started:true,settled:false};
    turns.set(requestId,t);active=requestId;
    native.setSessionParams({settings:{...native.settings,local_mcp_permission:'granted'}});
    const context=native.createContext({responseMessageId}),sendContext={emitSendPromptType:'chat',inputFeature:'t2t',models:[{id:model.id,info:model.info || {}}],chatMode:'normal',branchInfo:null};
    Promise.resolve().then(()=>native.handleMcpLoop(context,config.services.mcpHandler,{id:model.id,info:model.info || {}},responseMessageId,sendContext,{branchInfo:null})).then(()=>{t.settled=true;refresh(t);},error=>{t.settled=true;t.status='error';t.error=safeError(error);});
    return query({requestId});
  }
  function readReply({nativeChatId,userMessageId,responseMessageId} = {}) {
    if (!initialized || nativeChatId !== native.chatId) throw Error('QWEN_NATIVE_REPLY_CHAT_MISMATCH');
    const message = native.history?.messages?.[responseMessageId], user = native.history?.messages?.[userMessageId];
    if (message?.id !== responseMessageId || message.role !== 'assistant' || message.parentId !== userMessageId || user?.role !== 'user') throw Error('QWEN_NATIVE_REPLY_IDENTITY_MISMATCH');
    const local=user.feature_config?.local_mcp || {};
    return {nativeChatId,userMessageId,responseMessageId,role:'assistant',done:message.done === true,error:message.error ? safeError(message.error) : null,content:responseText(message),phases:(message.content_list || []).map(p=>p.phase),toolPhases:toolSummary(message),userFeatures:{hasMcp:!!user.feature_config?.mcp,localServices:Object.keys(local),localToolCounts:Object.fromEntries(Object.entries(local).map(([name,tools])=>[name,Object.keys(tools || {}).length]))}};
  }
  function inspect() {return {contract:'qwen-chat-fe-0.3.17-detached-v1',adapterRevision:'mcp-person-terminal-v3',...summary(),ownedRequestId:active,ownedTurnPending:ownedTurnPending(),currentUiChatId:c.pool.currentSession?.chatId || null,currentUiBusy:!!c.pool.currentSession?.isChat,mcpAvailable:!!mcp,mcpServerName:server};}
  return {inspect,ensureConversation,restore,validateAttachment,verifyConnection,enableMcp,registerMcpConnection,createConversation,start,query,awaitCompletion,cancel,readReply,resumePendingMcp,dispose:()=>{if(!busy()&&!ownedTurnPending())native.destroy();}};
}
const QWEN_NATIVE_CONTRACT = Object.freeze({
  version:'qwen-chat-fe-0.3.17-detached-v1',
  moduleUrl:'https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.17/js/main.js',
  sourceSha256:'e6bdd3948f4f29917bf9662a5d23661ea5d38f14314d514c6242ad568fb49ee5'
});

function assertRuntimeKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw Error('QWEN_NATIVE_INVALID_RUNTIME_KEY');
}

function buildQwenNativeBootstrap({runtimeKey,moduleUrl,sourceSha256,nativeChatId = null,serverName = null,mcpConnection = null,modelId} = {}) {
  assertRuntimeKey(runtimeKey);
  if (moduleUrl !== QWEN_NATIVE_CONTRACT.moduleUrl || sourceSha256 !== QWEN_NATIVE_CONTRACT.sourceSha256) throw Error('QWEN_NATIVE_SOURCE_IDENTITY_MISMATCH');
  const args = {runtimeKey,moduleUrl,nativeChatId,serverName,mcpConnection,modelId,contractVersion:QWEN_NATIVE_CONTRACT.version};
  return `(async()=>{
    const args=${JSON.stringify(args)};
    const loaded=[...document.scripts].some(script=>script.src===args.moduleUrl);
    if(!loaded)throw Error('QWEN_NATIVE_LOADED_MODULE_MISMATCH');
    const mod=await import(args.moduleUrl);
    const registry=globalThis.__agentOfficeQwenNativeSessions || (globalThis.__agentOfficeQwenNativeSessions=Object.create(null));
    const previous=registry[args.runtimeKey];
    if(previous && previous.inspect().adapterRevision!=='mcp-person-terminal-v3'){
      const prior=previous.inspect();
      if(['loading','sending','streaming'].includes(prior.state)||prior.ownedTurnPending||prior.ownedRequestId&&previous.query?.({requestId:prior.ownedRequestId})?.sendSettled===false)throw Error('QWEN_NATIVE_ADAPTER_UPGRADE_BUSY');
      if(!args.nativeChatId)args.nativeChatId=prior.nativeChatId;
      previous.dispose?.();delete registry[args.runtimeKey];
    }
    const bridge=registry[args.runtimeKey] || (registry[args.runtimeKey]=(${createQwenNativeDetachedBridge.toString()})(mod,args));
    const current=bridge.inspect();
    if(['loading','sending','streaming'].includes(current.state)||current.ownedTurnPending){
      bridge.validateAttachment({nativeChatId:args.nativeChatId,mcpConnection:args.mcpConnection});
      return bridge.inspect();
    }
    await bridge.ensureConversation({nativeChatId:args.nativeChatId,modelId:args.modelId});
    if(args.mcpConnection)await bridge.registerMcpConnection(args.mcpConnection);
    else if(args.serverName)await bridge.enableMcp({existingServerName:args.serverName});
    else if(bridge.inspect().mcpServerName)throw Error('QWEN_NATIVE_ASSIGNED_MCP_REQUIRED');
    return bridge.inspect();
  })()`;
}

class DesktopQwen {
  constructor({evaluate,runtimeKey,moduleUrl,sourceSha256,nativeChatId = null,serverName = null,mcpConnection = null,modelId} = {}) {
    if (typeof evaluate !== 'function') throw Error('QWEN_NATIVE_EVALUATOR_REQUIRED');
    // The driver must bind this evaluator to an explicitly discovered native
    // Qwen webview, and verify the loaded immutable public bundle's hash.
    this.options={runtimeKey,moduleUrl,sourceSha256,nativeChatId,serverName,mcpConnection,modelId};
    buildQwenNativeBootstrap(this.options);
    this.evaluate=evaluate;
    this.nativeChatId=nativeChatId;
    this.ready=false;
  }
  async initialize({nativeChatId = this.nativeChatId} = {}) {
    const result=await this.evaluate(buildQwenNativeBootstrap({...this.options,nativeChatId}));
    if (result?.contract !== QWEN_NATIVE_CONTRACT.version || result.detached !== true) throw Error('QWEN_NATIVE_RUNTIME_CONTRACT_MISMATCH');
    this.ready=true;
    if(result.nativeChatId)this.nativeChatId=result.nativeChatId;
    return result;
  }
  async call(method,args = {}) {
    if(!this.ready)throw Error('QWEN_NATIVE_NOT_INITIALIZED');
    if(!['inspect','ensureConversation','restore','validateAttachment','verifyConnection','enableMcp','registerMcpConnection','createConversation','start','query','awaitCompletion','cancel','readReply','resumePendingMcp','dispose'].includes(method))throw Error('QWEN_NATIVE_METHOD_REJECTED');
    const result=await this.evaluate(`globalThis.__agentOfficeQwenNativeSessions[${JSON.stringify(this.options.runtimeKey)}][${JSON.stringify(method)}](${JSON.stringify(args)})`);
    if(result?.nativeChatId)this.nativeChatId=result.nativeChatId;
    return result;
  }
  inspect(){return this.call('inspect');}
  start({requestId,inputText} = {}){return this.call('start',{requestId,inputText,nativeChatId:this.nativeChatId});}
  query(requestId,{includeContent = false} = {}){return this.call('query',{requestId,includeContent});}
  awaitCompletion(requestId,{timeoutMs = 30000,includeContent = false} = {}){return this.call('awaitCompletion',{requestId,timeoutMs,includeContent});}
  cancel(requestId){return this.call('cancel',{requestId});}
  async restore(args = {}) {
    const nativeChatId=args.nativeChatId || this.nativeChatId;
    if(nativeChatId && this.nativeChatId && nativeChatId!==this.nativeChatId)throw Error('QWEN_NATIVE_PERSON_CHAT_ID_MISMATCH');
    if(!this.ready)await this.initialize({nativeChatId});
    return this.call('restore',{...args,nativeChatId});
  }
  verifyConnection(){return this.call('verifyConnection');}
  async createPersonConversation(nativeChatId = this.nativeChatId){const state=await this.initialize({nativeChatId});return state.nativeChatId?state:this.call('createConversation');}
  async send(nativeChatId,{requestId,prompt} = {}) {
    if(nativeChatId && this.nativeChatId && nativeChatId!==this.nativeChatId)throw Error('QWEN_NATIVE_PERSON_CHAT_ID_MISMATCH');
    if(!this.ready)await this.initialize({nativeChatId:nativeChatId || this.nativeChatId});
    else if(nativeChatId && !this.nativeChatId)await this.call('ensureConversation',{nativeChatId});
    return this.start({requestId,inputText:prompt});
  }
  snapshot(requestId,options){return requestId?this.query(requestId,options):this.inspect();}
  async run({nativeChatId = this.nativeChatId,requestId,prompt,timeoutMs = 30000} = {}) {
    await this.send(nativeChatId,{requestId,prompt});
    return this.awaitCompletion(requestId,{timeoutMs,includeContent:true});
  }
}

function createBridge(cdp,options = {}) {
  const evaluate=typeof cdp==='function'?cdp:typeof cdp?.evaluate==='function'?cdp.evaluate.bind(cdp):null;
  return new DesktopQwen({...options,evaluate});
}

module.exports = {createBridge,DesktopQwen,QWEN_NATIVE_CONTRACT,buildQwenNativeBootstrap,createQwenNativeDetachedBridge};
