'use strict';

const {RoomError} = require('./util.cjs');

const DOUBAO_NATIVE_CONTRACT = Object.freeze({
  version:'doubao-desktop-native-v1',
  researchedProductVersion:'2.32.4',
  runtimeGlobals:Object.freeze(['@flow-web/desktop:stable','webpackChunkflow_web_extension']),
});

// Source discovery precedes require: a guessed missing module poisons Webpack's
// cache. These exports/markers were checked in the installed Windows 2.32.4
// resources; the actual renderer must supply the same unique contracts.
function findDoubaoModule(req, kind, optional = false) {
  const exported = (source,names) => names.every(name => new RegExp('\\b'+name+'\\s*:').test(source));
  const contracts = {
    conversations:source => exported(source,['createConversation','createSendMessageConversationContext','getInfoByConversationId','MAIN_BOT_ID']),
    services:source => exported(source,['getChatService','getChatStore']),
    messages:source => exported(source,['createSendMessage','combineBlocks']),
    text:source => exported(source,['mapTextToTextBlock']) && !exported(source,['createSendMessage']),
    messageStore:source => exported(source,['useMessageStore']) && source.includes('useMessageStore is not initialized'),
    conversationInfo:source => exported(source,['fetchUpdateConversationInfo']) && source.includes('updateConversationInfo: invalid data from api'),
    identity:source => exported(source,['n5','bG']) && source.includes('user_id_str') && source.includes('isUserInfoLoaded'),
    complete:source => source.includes('PushMessageStatus.Streaming') && source.includes('is_finish') && source.includes('async_task') && /\bz\s*:/.test(source),
    cancellation:source => exported(source,['MessageBreak']) && source.includes('reply_msg_id') && source.includes('break_reason'),
  };
  if (!req?.m || !contracts[kind]) throw Error('DOUBAO_NATIVE_MODULE_DISCOVERY_UNAVAILABLE');
  const matches = Object.entries(req.m).filter(([,factory]) => typeof factory === 'function' && contracts[kind](Function.prototype.toString.call(factory)));
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw Error('DOUBAO_NATIVE_MODULE_CONTRACT_'+kind.toUpperCase()+'_'+(matches.length?'AMBIGUOUS':'MISSING'));
  const [id,factory] = matches[0];
  return {id:Number(id),source:Function.prototype.toString.call(factory),exports:req(Number(id))};
}

// This function is serialized into the authenticated native desktop renderer.
// It does not activate a conversation, reset the composer, read cookies, or
// enumerate the user's chats. Every observation stays in one selected bucket.
function createDoubaoNativeBridge(req, options = {}, ownership = new Map()) {
  if (options.contractVersion !== 'doubao-desktop-native-v1') throw Error('DOUBAO_NATIVE_VERSION_GUARD_REQUIRED');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(options.runtimeKey || '')) throw Error('DOUBAO_NATIVE_INVALID_RUNTIME_KEY');
  const modules = {};
  for (const kind of ['conversations','services','messages','text','messageStore','conversationInfo','complete','identity']) modules[kind] = findDoubaoModule(req,kind);
  const conversations = modules.conversations.exports, services = modules.services.exports;
  const messages = modules.messages.exports, text = modules.text.exports;
  const store = modules.messageStore.exports.useMessageStore;
  const fetchInfo = modules.conversationInfo.exports.fetchUpdateConversationInfo;
  const isComplete = modules.complete.exports.z;
  const currentAccount = modules.identity.exports.n5;
  if (![conversations.createConversation,conversations.createSendMessageConversationContext,conversations.getInfoByConversationId,
    services.getChatService,messages.createSendMessage,messages.combineBlocks,text.mapTextToTextBlock,
    store?.getState,fetchInfo,isComplete,currentAccount].every(value => typeof value === 'function')) throw Error('DOUBAO_NATIVE_EXPORT_CONTRACT_MISMATCH');
  if (!conversations.MAIN_BOT_ID && !options.botId) throw Error('DOUBAO_NATIVE_BOT_ID_UNAVAILABLE');
  // Keep account identity inside the renderer closure; it is never returned to
  // AO, logged, or read from a profile/cookie store.
  const account = String(currentAccount() || '');
  if (!account || account==='0') throw Error('DOUBAO_NATIVE_ACCOUNT_UNAVAILABLE');
  const assertAccount = () => {if(String(currentAccount() || '')!==account)throw Error('DOUBAO_NATIVE_ACCOUNT_CHANGED');};
  const turns = new Map(), terminal = new Set(['completed','error','cancelled']);
  let nativeChatId = null, creating = null, createUncertain = false, initializing = null, verified = false;
  const own = id => {
    const owner = ownership.get(id);
    if (owner && owner !== options.runtimeKey) throw Error('DOUBAO_NATIVE_PERSON_CHAT_ALREADY_OWNED');
    ownership.set(id,options.runtimeKey);
  };
  const summary = () => ({contract:options.contractVersion,detached:true,nativeChatId,creating:!!creating,createUncertain});
  const idText = value => typeof value === 'string' && value && value.length <= 160 && !value.includes('\0');
  async function verifyFactories() {
    assertAccount();
    if (verified) return;
    for (const [kind,expected] of Object.entries(options.factorySha256 || {})) {
      if (!modules[kind] || !/^[a-f0-9]{64}$/.test(expected)) throw Error('DOUBAO_NATIVE_INVALID_SOURCE_IDENTITY');
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(modules[kind].source));
      const actual = [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
      if (actual !== expected) throw Error('DOUBAO_NATIVE_SOURCE_IDENTITY_MISMATCH');
    }
    verified = true;
  }
  async function loadConversation(id) {
    assertAccount();
    let info = conversations.getInfoByConversationId(id)?.conversation;
    if (String(info?.conversation_id || '') !== id) {
      const fetched = await fetchInfo(id,'agent_office_native');
      assertAccount();
      if (String(fetched?.conversation_id || '') !== id) throw Error('DOUBAO_NATIVE_PERSON_CHAT_NOT_FOUND');
      info = conversations.getInfoByConversationId(id)?.conversation;
    }
    if (String(info?.conversation_id || '') !== id) throw Error('DOUBAO_NATIVE_PERSON_CHAT_NOT_LOADED');
    const context = conversations.createSendMessageConversationContext(id);
    if (String(context?.conversation_id || '') !== id || !context.bot_id
      || info.bot_id && String(info.bot_id) !== String(context.bot_id)) throw Error('DOUBAO_NATIVE_PERSON_CHAT_CONTEXT_MISMATCH');
    return context;
  }
  async function createPersonConversation(input = {}) {
    const expected = typeof input === 'string' ? input : input.nativeChatId || input.nativeConversationId || null;
    await verifyFactories();
    if (expected && !idText(expected)) throw Error('DOUBAO_NATIVE_INVALID_CHAT_ID');
    if (nativeChatId) {
      if (expected && expected !== nativeChatId) throw Error('DOUBAO_NATIVE_PERSON_CHAT_ID_MISMATCH');
      await loadConversation(nativeChatId);
      createUncertain = false;
      return summary();
    }
    if (expected) {
      const owner = ownership.get(expected);
      if (owner && owner !== options.runtimeKey) throw Error('DOUBAO_NATIVE_PERSON_CHAT_ALREADY_OWNED');
      await loadConversation(expected);
      own(expected);nativeChatId = expected;
      return summary();
    }
    if (creating) return creating;
    if (createUncertain) throw Error('DOUBAO_NATIVE_CREATE_UNCERTAIN');
    creating = (async () => {
      // No prompt is submitted. A failed creation acknowledgement stays
      // uncertain and cannot silently create a second conversation.
      createUncertain = true;
      const created = await conversations.createConversation({botId:String(options.botId || conversations.MAIN_BOT_ID)});
      assertAccount();
      const id = String(created?.conversationId || '');
      if (!idText(id) || id.startsWith('local')) throw Error('DOUBAO_NATIVE_CREATE_NO_SERVER_ID');
      own(id);nativeChatId = id;
      await loadConversation(id);
      createUncertain = false;
      return summary();
    })();
    try { return await creating; } finally { creating = null; }
  }
  async function initialize(input = {}) {
    if (initializing) return initializing;
    initializing = createPersonConversation({nativeChatId:input.nativeChatId || input.nativeConversationId || options.nativeChatId || options.nativeConversationId});
    try { return await initializing; } finally { initializing = null; }
  }
  function rowsForChat() {
    assertAccount();
    const state = store.getState();
    if (!state || typeof state.messageMap !== 'object' || typeof state.localMessageMap !== 'object') throw Error('DOUBAO_NATIVE_MESSAGE_STORE_MISMATCH');
    // The actual Windows store is conversation -> message ID -> message.
    return [...Object.values(state.localMessageMap?.[nativeChatId] || {}),...Object.values(state.messageMap?.[nativeChatId] || {})]
      .filter(row => row && typeof row === 'object' && (!row.conversation_id || String(row.conversation_id) === nativeChatId));
  }
  const messageOrder = row => {
    try { return BigInt(String(row.index || row.message_index || row.index_in_conv || row.create_time || 0)); } catch { return 0n; }
  };
  function correlated(t) {
    const rows = rowsForChat();
    const serverRows = new Set(Object.values(store.getState().messageMap?.[nativeChatId] || {}));
    const users = rows.filter(row => Number(row.user_type) === 1 && (
      row.local_message_id === t.requestId || row.unique_id === t.requestId || row.ext?.agent_office_request_id === t.requestId
      || t.userMessageId && String(row.message_id || '') === t.userMessageId));
    const serverIds = [...new Set(users.filter(row=>serverRows.has(row)).map(row=>String(row.message_id || '')).filter(Boolean))];
    if (serverIds.length > 1 || t.userMessageId && serverIds.some(id=>id!==t.userMessageId)) throw Error('DOUBAO_NATIVE_REQUEST_CORRELATION_CONFLICT');
    if (serverIds[0]) t.userMessageId = serverIds[0];
    if (!t.userMessageId) return {rows,users,serverRows:[...serverRows],replies:[]};
    const replies = new Map();
    for (const row of rows) {
      const parent = String(row.reply_id || row.bot_reply_message_id || row.ext?.chat_id || '');
      if (Number(row.user_type) !== 2 || parent !== t.userMessageId || !row.message_id || row.content_type === 2003) continue;
      replies.set(String(row.message_id),row);
    }
    return {rows,users,serverRows:[...serverRows],replies:[...replies.values()].sort((a,b)=>messageOrder(a)<messageOrder(b)?-1:messageOrder(a)>messageOrder(b)?1:0)};
  }
  function replyText(row) {
    const blocks = row.content_blocks_v2 || row.content_block || row.content_blocks;
    if (Array.isArray(blocks)) return blocks.map(block=>typeof block.content?.text_block?.text==='string'?block.content.text_block.text:'').join('');
    return typeof row.content_obj?.text === 'string' ? row.content_obj.text : '';
  }
  function query(requestId, {includeContent = false} = {}) {
    const t = turns.get(requestId);
    if (!t) return {requestId,status:'unknown_request',nativeChatId,userMessageId:null,responseMessageIds:[]};
    if (t.nativeChatId !== nativeChatId) throw Error('DOUBAO_NATIVE_REQUEST_CHAT_MISMATCH');
    const found = correlated(t);
    const interrupted = found.replies.some(row=>row.ext?.is_interrupted==='true' || row.final_status?.message==='Broken' || row.content_status===120);
    const failed = found.replies.some(row=>row.error_details?.error_code || row.ext?.error_details || row.final_status?.message==='Error' || row.content_status===500);
    for (const row of found.replies) t.responseIds.add(String(row.message_id));
    if (interrupted) t.status = 'cancelled';
    else if (failed || t.error) t.status = 'error';
    else if (found.replies.length && found.replies.every(row=>isComplete(row))) {
      if (found.replies.some(row=>replyText(row).trim())) t.status = 'completed';
      else {t.status='error';t.error='DOUBAO_NATIVE_EMPTY_REPLY';}
    }
    const result = {requestId,status:t.status,nativeChatId,userMessageId:t.userMessageId || null,
      responseMessageIds:[...t.responseIds],sendSettled:t.settled,cancelRequested:!!t.cancelRequested,error:t.error || (failed?'DOUBAO_NATIVE_REPLY_ERROR':null)};
    if (includeContent && t.status === 'completed') result.replies = found.replies.filter(row=>isComplete(row)&&replyText(row).trim())
      .map(row=>({id:String(row.message_id),parentId:t.userMessageId,role:'assistant',done:true,content:replyText(row)}));
    return result;
  }
  async function send(chatId, {requestId,prompt} = {}) {
    if (!idText(requestId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000 || prompt.includes('\0')) throw Error('DOUBAO_NATIVE_INVALID_REQUEST');
    if (!nativeChatId) await initialize({nativeChatId:chatId});
    if (!chatId || chatId !== nativeChatId) throw Error('DOUBAO_NATIVE_PERSON_CHAT_ID_MISMATCH');
    const old = turns.get(requestId);
    if (old) {
      if (old.prompt !== prompt || old.nativeChatId !== chatId) throw Error('DOUBAO_NATIVE_REQUEST_ID_CONFLICT');
      return {...query(requestId),accepted:true,reused:true};
    }
    for (const t of turns.values()) if (!terminal.has(query(t.requestId).status)) throw Error('DOUBAO_NATIVE_PERSON_BUSY');
    // Save ownership before invoking native send. A disconnected/uncertain CDP
    // caller can reconnect to this same renderer record without repeating it.
    const t = {requestId,prompt,nativeChatId,status:'running',responseIds:new Set(),settled:false,userMessageId:null,error:null};
    turns.set(requestId,t);
    let sender,outgoing;
    try {
      const context = await loadConversation(nativeChatId);
      const service = await services.getChatService('chatIMService');
      sender = await service?.getMessageService();
      if (typeof sender?.sendMessage !== 'function') throw Error('DOUBAO_NATIVE_MESSAGE_SERVICE_UNAVAILABLE');
      outgoing = messages.createSendMessage({conversationContext:context,message:{unique_id:requestId,
        content_blocks_v2:messages.combineBlocks({textBlock:text.mapTextToTextBlock(prompt)}),ext:{agent_office_request_id:requestId}}});
      if (outgoing.local_message_id !== requestId || String(outgoing.conversation_id || '') !== nativeChatId) throw Error('DOUBAO_NATIVE_OUTGOING_IDENTITY_MISMATCH');
    } catch(error) {
      t.status='error';t.error='DOUBAO_NATIVE_SEND_PREPARATION_FAILED';throw error;
    }
    t.promise = Promise.resolve().then(()=>{assertAccount();return sender.sendMessage({messages:[outgoing],session:{reportParams:{scene:'agent_office_native'}}});})
      .then(()=>{t.settled=true;},()=>{t.settled=true;t.error='DOUBAO_NATIVE_SEND_FAILED';});
    return {requestId,status:'running',nativeChatId,accepted:true,userMessageId:null,responseMessageIds:[]};
  }
  async function restore(input = {}) {
    const {requestId,userMessageId,nativeChatId:chatId,responseMessageIds=[]} = input;
    if (!idText(requestId) || !idText(userMessageId) || chatId !== nativeChatId || !Array.isArray(responseMessageIds) || responseMessageIds.some(id=>!idText(id))) throw Error('DOUBAO_NATIVE_INVALID_RESTORE_IDENTITY');
    if (turns.has(requestId)) return query(requestId,{includeContent:input.includeContent});
    // A saved server message ID is required. Recovery never infers ownership
    // from prompt equality and never resubmits the original model request.
    await loadConversation(nativeChatId);
    turns.set(requestId,{requestId,nativeChatId,prompt:null,status:'running',userMessageId,responseIds:new Set(),settled:true,error:null});
    return query(requestId,{includeContent:input.includeContent});
  }
  async function cancel(requestId) {
    const t = turns.get(requestId);
    if (!t || t.nativeChatId !== nativeChatId) throw Error('DOUBAO_NATIVE_CANCEL_IDENTITY_MISMATCH');
    const before = query(requestId);
    if (terminal.has(before.status)) return before;
    if (!t.userMessageId) throw Error('DOUBAO_NATIVE_CANCEL_ACCEPTANCE_UNKNOWN');
    const {serverRows} = correlated(t);
    const latest = serverRows.filter(row=>Number(row.user_type)===1&&row.message_id).sort((a,b)=>messageOrder(a)>messageOrder(b)?-1:messageOrder(a)<messageOrder(b)?1:0)[0];
    if (!latest || String(latest.message_id) !== t.userMessageId) throw Error('DOUBAO_NATIVE_CANCEL_NEWER_TURN');
    let entry = findDoubaoModule(req,'cancellation',true);
    if (!entry && options.chunkName === 'webpackChunkflow_web_extension' && typeof req.e === 'function') {
      // The observed Windows 2.32.4 lazy chunk, not a scan or guessed module ID.
      await req.e('65703');entry = findDoubaoModule(req,'cancellation',true);
    }
    if (typeof entry?.exports.MessageBreak !== 'function') throw Error('DOUBAO_NATIVE_CANCEL_CONTRACT_UNAVAILABLE');
    assertAccount();
    const ack = await entry.exports.MessageBreak({conversation_id:nativeChatId,reply_id:t.userMessageId,break_reason:7});
    if (Number(ack?.code) !== 0) throw Error('DOUBAO_NATIVE_CANCEL_REJECTED');
    t.cancelRequested = true;
    // A successful stop API acknowledgement is not a terminal reply record.
    return query(requestId);
  }
  function inspect() { return {...summary(),moduleIds:Object.fromEntries(Object.entries(modules).map(([kind,value])=>[kind,value.id])),requests:turns.size}; }
  return {initialize,createPersonConversation,send,snapshot:query,restore,cancel,inspect};
}

function buildDoubaoNativeBootstrap(options = {}) {
  if(options.contractVersion && options.contractVersion!==DOUBAO_NATIVE_CONTRACT.version)throw new RoomError('原生豆包接口版本不受支持。',409,'desktop_contract_mismatch');
  const {runtimeKey,nativeChatId=null,nativeConversationId=null,botId,factorySha256={}} = options;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runtimeKey || '')) throw new RoomError('原生豆包人物引用无效。',400,'desktop_identity_mismatch');
  const args = {runtimeKey,nativeChatId:nativeChatId || nativeConversationId,botId,factorySha256,contractVersion:DOUBAO_NATIVE_CONTRACT.version};
  return `(async()=>{
    if(!['doubao:','chrome:'].includes(location.protocol)||location.hostname!=='doubao-chat'||!/^\\/chat(?:\\/|$)/.test(location.pathname))throw Error('DOUBAO_NATIVE_TARGET_MISMATCH');
    const findDoubaoModule=${findDoubaoModule.toString()};
    const createDoubaoNativeBridge=${createDoubaoNativeBridge.toString()};
    const args=${JSON.stringify(args)};
    const symbol=Symbol.for('agentoffice.doubao.native.v1');
    let registry=window[symbol];
    if(registry&&registry.contract!==args.contractVersion)throw Error('DOUBAO_NATIVE_REGISTRY_VERSION_MISMATCH');
    if(!registry){registry={contract:args.contractVersion,bridges:new Map(),ownership:new Map()};Object.defineProperty(window,symbol,{value:registry});}
    let bridge=registry.bridges.get(args.runtimeKey);
    if(!bridge){
      const keys=${JSON.stringify(DOUBAO_NATIVE_CONTRACT.runtimeGlobals)}.filter(key=>Array.isArray(window[key]));
      if(keys.length!==1)throw Error('DOUBAO_NATIVE_WEBPACK_RUNTIME_MISSING_OR_AMBIGUOUS');
      let timer;const key=keys[0];
      const req=await Promise.race([new Promise(resolve=>window[key].push([['ao_native_'+crypto.randomUUID()],{},resolve])),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DOUBAO_NATIVE_BOOTSTRAP_TIMEOUT')),3000);})]).finally(()=>clearTimeout(timer));
      bridge=createDoubaoNativeBridge(req,{...args,chunkName:key},registry.ownership);registry.bridges.set(args.runtimeKey,bridge);
    }
    return bridge.initialize({nativeChatId:args.nativeChatId});
  })()`;
}

class DesktopDoubao {
  constructor({evaluate,runtimeKey,nativeChatId=null,nativeConversationId=null,botId,factorySha256={},contractVersion=DOUBAO_NATIVE_CONTRACT.version} = {}) {
    if (typeof evaluate !== 'function') throw new RoomError('需要已连接的原生桌面通道。',400,'desktop_bridge_unavailable');
    if(contractVersion!==DOUBAO_NATIVE_CONTRACT.version)throw new RoomError('原生豆包接口版本不受支持。',409,'desktop_contract_mismatch');
    this.evaluate=evaluate;this.options={runtimeKey,nativeChatId:nativeChatId || nativeConversationId,botId,factorySha256};
    this.nativeChatId=this.options.nativeChatId;this.ready=false;
  }
  async initialize({nativeChatId=this.nativeChatId,nativeConversationId} = {}) {
    const expected=nativeChatId || nativeConversationId || null;
    if(this.ready && expected && expected!==this.nativeChatId)throw new RoomError('不能替换这位同事的原生豆包对话。',409,'desktop_identity_mismatch');
    const state=await this.evaluate(buildDoubaoNativeBootstrap({...this.options,nativeChatId:expected}));
    if(state?.contract!==DOUBAO_NATIVE_CONTRACT.version||state.detached!==true||!state.nativeChatId)throw new RoomError('原生豆包接口尚未完成绑定。',409,'desktop_contract_mismatch');
    if(expected && expected!==state.nativeChatId)throw new RoomError('原生豆包返回了另一对话。',403,'desktop_identity_mismatch');
    this.nativeChatId=state.nativeChatId;this.ready=true;return state;
  }
  async call(method,args) {
    if(!['createPersonConversation','send','snapshot','restore','cancel','inspect'].includes(method))throw new RoomError('原生豆包操作无效。',400,'desktop_method_rejected');
    if(!this.ready)await this.initialize();
    const value=await this.evaluate(`(async()=>{const r=window[Symbol.for('agentoffice.doubao.native.v1')];const b=r?.bridges.get(${JSON.stringify(this.options.runtimeKey)});if(!b)throw Error('DOUBAO_NATIVE_RUNTIME_LOST');return b[${JSON.stringify(method)}](...${JSON.stringify(args)});})()`);
    if(value?.nativeChatId && value.nativeChatId!==this.nativeChatId)throw new RoomError('原生豆包回答来自另一对话。',403,'desktop_identity_mismatch');
    return value;
  }
  async createPersonConversation(input=this.nativeChatId) {
    const id=typeof input==='string'?input:input?.nativeChatId || input?.nativeConversationId;
    if(!this.ready)return this.initialize({nativeChatId:id});
    return this.call('createPersonConversation',[{nativeChatId:id}]);
  }
  async send(nativeChatId,{requestId,prompt} = {}) {
    if(!this.ready)await this.initialize({nativeChatId});
    if(nativeChatId!==this.nativeChatId)throw new RoomError('不能向另一位同事的原生对话发送消息。',403,'desktop_identity_mismatch');
    return this.call('send',[nativeChatId,{requestId,prompt}]);
  }
  snapshot(requestId,options={}) { return requestId?this.call('snapshot',[requestId,options]):this.call('inspect',[]); }
  restore(input) { return this.call('restore',[input]); }
  cancel(requestId) { return this.call('cancel',[requestId]); }
}

function createBridge(cdp,options = {}) {
  if(typeof cdp?.evaluate!=='function')throw new RoomError('需要已连接的桌面对话通道。',400,'desktop_bridge_unavailable');
  return new DesktopDoubao({...options,evaluate:cdp.evaluate.bind(cdp)});
}

module.exports={createBridge,DesktopDoubao,DOUBAO_NATIVE_CONTRACT,findDoubaoModule,createDoubaoNativeBridge,buildDoubaoNativeBootstrap};
