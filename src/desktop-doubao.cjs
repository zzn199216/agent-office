'use strict';

const {RoomError} = require('./util.cjs');
const {createHash} = require('node:crypto');

const DOUBAO_NATIVE_CONTRACT = Object.freeze({
  version:'doubao-desktop-native-v1',
  adapterRevision:'doubao-native-adapter-v4',
  researchedProductVersion:'2.33.3',
  runtimeGlobals:Object.freeze(['@flow-web/desktop:stable','webpackChunkflow_web_extension']),
});

// Qualified against the installed Windows resources and two real consecutive
// native SDK turns. This is a source qualification, not MCP/tool evidence.
const DOUBAO_NATIVE_PREPARATION = Object.freeze({
  contractVersion:DOUBAO_NATIVE_CONTRACT.version,
  runtimeGlobal:'@flow-web/desktop:stable',
  chunks:Object.freeze([
    Object.freeze({id:'93166',path:'static/js/async/93166.9fd1cd0c29.js',sha256:'437e5d6d56f0a24a982624e359041f9b7532b46bbda5e13d6bec4def4034380f',kind:'services'}),
    Object.freeze({id:'9365',path:'static/js/async/9365.691800dd08.js',sha256:'43654b79deb1546bf04608be18ec2d32c0340b7baa893930b9dc4c08f4d6cb36',kind:'conversations'}),
  ]),
  factorySha256:Object.freeze({
    conversations:'c83d4ccb1d9a8848dd727178fc1b338f97e2a423b0220a07abfaa9065a0275ec',
    services:'ee9cc4431e2228b07e8bc858692cbeb00bcf6b691fcf4196c149593c7301aedf',
    messages:'e5c218d5befe2dac4e5552b1c1dde26884055f3c4f6aba7727b6e66cedb675d8',
    text:'c766c785f75f212234a79fc7478d476a8ca2dd5de6110421746bd0d368fd8b45',
    messageStore:'1d15c6fad0f12412cf47d8d9ba867610296c0ef760bb3a039052addc1683bea6',
    // The normal message-error lazy chunk changes only minifier bindings.
    conversationInfo:Object.freeze(['2da587c4e01a8b7b5bcbaea93f8172fab4d3b7f0e9a45e00d58f4160fecd984f','b6f5b2318a59a2f4615d09b95c4ca401ec6af6070b0668cce9c199313bb248f9']),
    complete:'6c8a33e8bbf6680cbdadb74b76b17f3c220d9d5cb82917ab64287c4ab0b5ef4b',
    identity:'b9c0379cee8f359435147242fab33498be90ea8fe76518c42a53e5a81a866178',
  }),
  externalModuleIds:Object.freeze([71197,71834,98027,135193,201183,201753,246058,253349,325457,367173,368415,376999,378437,386196,456462,460932,470476,540864,542525,544349,557526,600919,609347,632649,656207,687323,708078,718587,737937,744331,761336,788925,834523,860268,894119,879807,521109,196183,491575,37476,198837,17344]),
});

const DOUBAO_NATIVE_PROFILES = Object.freeze({legacy:DOUBAO_NATIVE_PREPARATION,current:require('./doubao-native-2.33.3.json')});

// Empty Webpack chunks capture only the runtime; no business factory is called.
// The cache keeps each runtime namespace separate and rejects replaced arrays.
async function captureDoubaoRuntime(runtimeGlobal) {
  const chunks = window[runtimeGlobal];
  if (!Array.isArray(chunks)) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
  const symbol = Symbol.for('agentoffice.doubao.webpack.v1');
  let cache = window[symbol];
  if (!cache) {cache=new Map();Object.defineProperty(window,symbol,{value:cache});}
  if (!(cache instanceof Map)) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
  let entry = cache.get(runtimeGlobal);
  if (entry && entry.chunks !== chunks) throw Error('DOUBAO_NATIVE_PREPARATION_RUNTIME_CHANGED');
  if (!entry) {
    entry = {chunks,promise:null};
    let timer;
    entry.promise = Promise.race([
      new Promise(resolve=>chunks.push([['ao_native_'+crypto.randomUUID()],{},resolve])),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DOUBAO_NATIVE_BOOTSTRAP_TIMEOUT')),3000);}),
    ]).finally(()=>clearTimeout(timer));
    cache.set(runtimeGlobal,entry);
  }
  try {
    const req = await entry.promise;
    if (typeof req !== 'function' || !req.m || window[runtimeGlobal] !== chunks) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
    return {req,chunks,runtimeGlobal};
  } catch(error) {if(cache.get(runtimeGlobal)===entry)cache.delete(runtimeGlobal);throw error;}
}

// Serialized into the renderer with the fixed qualification above. The
// qualification argument allows isolated fixtures; public preparation cannot
// override it. This phase does not require modules, accounts, stores, or chats.
async function verifyDoubaoNativeFactories(req, qualification, allowMissing = false) {
  const missing=[],observed=[];
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  for (const [kind,expected] of Object.entries(qualification.factorySha256)) {
    let entry;try{entry=findDoubaoModule(req,kind,allowMissing && qualification.chunks.some(chunk=>chunk.kind===kind));}
    catch{throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');}
    if (!entry) {missing.push(kind);continue;}
    if (!(Array.isArray(expected)?expected:[expected]).includes(await digest(new TextEncoder().encode(entry.source)))) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
    observed.push(entry);
  }
  for (const entry of observed) if (typeof req.m[entry.id]!=='function' || Function.prototype.toString.call(req.m[entry.id])!==entry.source) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
  return missing;
}

async function prepareDoubaoNativeFactories(req, qualification, assertRuntime = ()=>{}) {
  if (!req?.m || typeof req.u !== 'function' || req.p !== '/') throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
  const mapper=req.u;
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  const checkMapping = () => {
    assertRuntime();
    if (req.u!==mapper || req.p!=='/' || qualification.chunks.some(chunk=>mapper(chunk.id)!==chunk.path)) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
  };
  checkMapping();
  // Reject unknown already-loaded variants instead of overwriting their
  // factories: cached exports might still have come from that old source.
  await verifyDoubaoNativeFactories(req,qualification,true);
  if ((qualification.externalModuleIds || []).some(id=>typeof req.m[id]!=='function')) throw Error('DOUBAO_NATIVE_PREPARATION_DEPENDENCY_MISSING');
  const sources=await Promise.all(qualification.chunks.map(async chunk=>{
    let response;try{response=await fetch('/'+chunk.path,{credentials:'omit',redirect:'error'});}catch{throw Error('DOUBAO_NATIVE_PREPARATION_SOURCE_UNAVAILABLE');}
    if (!response.ok || response.redirected) throw Error('DOUBAO_NATIVE_PREPARATION_SOURCE_UNAVAILABLE');
    const bytes=await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength>1000000 || await digest(bytes)!==chunk.sha256) throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(await digest(new TextEncoder().encode(source))!==chunk.sha256)throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
    return {id:chunk.id,source};
  }));
  checkMapping();
  const missing=await verifyDoubaoNativeFactories(req,qualification,true);
  return {contractVersion:qualification.contractVersion,runtimeGlobal:qualification.runtimeGlobal,factorySha256:{...qualification.factorySha256},
    sources:sources.filter(source=>missing.includes(qualification.chunks.find(chunk=>chunk.id===source.id).kind))};
}

async function applyDoubaoNativeFactories(req, qualification, registrations, assertRuntime = ()=>{}) {
  const mapper=req.u;
  const checkMapping=()=>{assertRuntime();if(req.p!=='/'||typeof mapper!=='function'||req.u!==mapper||qualification.chunks.some(chunk=>mapper(chunk.id)!==chunk.path))throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');};
  checkMapping();
  const missing=await verifyDoubaoNativeFactories(req,qualification,true);
  checkMapping();
  for (const chunk of qualification.chunks) if (missing.includes(chunk.kind)) {
    const register=registrations[chunk.id];
    if(typeof register!=='function')throw Error('DOUBAO_NATIVE_PREPARATION_SOURCE_UNAVAILABLE');
    // These callbacks contain the exact host-verified bytes. Registration only
    // supplies missing factories; no business factory or chunk runtime runs.
    register();checkMapping();
  }
  await verifyDoubaoNativeFactories(req,qualification,false);checkMapping();
  return {contractVersion:qualification.contractVersion,runtimeGlobal:qualification.runtimeGlobal,factorySha256:{...qualification.factorySha256}};
}

function buildDoubaoNativePreparation() {
  return `(async()=>{
    if(!['doubao:','chrome:'].includes(location.protocol)||location.hostname!=='doubao-chat'||!/^\\/chat(?:\\/|$)/.test(location.pathname))throw Error('DOUBAO_NATIVE_TARGET_MISMATCH');
    const findDoubaoModule=${findDoubaoModule.toString()};
    const captureDoubaoRuntime=${captureDoubaoRuntime.toString()};
    const verifyDoubaoNativeFactories=${verifyDoubaoNativeFactories.toString()};
    const prepareDoubaoNativeFactories=${prepareDoubaoNativeFactories.toString()};
    const profiles=${JSON.stringify(DOUBAO_NATIVE_PROFILES)};
    const captured=await captureDoubaoRuntime(profiles.current.runtimeGlobal);
    const selected=Object.entries(profiles).filter(([,q])=>q.chunks.every(c=>captured.req.u(c.id)===c.path));
    if(selected.length!==1)throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE');
    const [profileId,qualification]=selected[0];
    const assertRuntime=()=>{if(window[qualification.runtimeGlobal]!==captured.chunks)throw Error('DOUBAO_NATIVE_PREPARATION_RUNTIME_CHANGED');};
    const symbol=Symbol.for('agentoffice.doubao.preparation.v1');
    let state=window[symbol];
    if(state&&(state.req!==captured.req||state.chunks!==captured.chunks))throw Error('DOUBAO_NATIVE_PREPARATION_RUNTIME_CHANGED');
    if(!state){state={req:captured.req,chunks:captured.chunks,pending:null};Object.defineProperty(window,symbol,{value:state});}
    if(!state.pending)state.pending=prepareDoubaoNativeFactories(captured.req,qualification,assertRuntime).finally(()=>{state.pending=null;});
    const result=await state.pending;assertRuntime();return {...result,profileId};
  })()`;
}

function buildDoubaoNativeRegistration(sources,profileId='legacy') {
  const profile=DOUBAO_NATIVE_PROFILES[profileId];
  if(!profile)throw new RoomError('原生豆包版本尚未通过源码校验。',409,'desktop_adapter_unsupported');
  if(!Array.isArray(sources)||sources.length>2)throw new RoomError('原生豆包资源未通过源码校验。',409,'desktop_adapter_unsupported');
  const ids=new Set();
  for(const entry of sources){
    const chunk=profile.chunks.find(chunk=>chunk.id===entry?.id);
    if(!chunk||ids.has(entry.id)||typeof entry.source!=='string'||createHash('sha256').update(entry.source,'utf8').digest('hex')!==chunk.sha256)throw new RoomError('原生豆包资源未通过源码校验。',409,'desktop_adapter_unsupported');
    ids.add(entry.id);
  }
  return `(async()=>{
    if(!['doubao:','chrome:'].includes(location.protocol)||location.hostname!=='doubao-chat'||!/^\\/chat(?:\\/|$)/.test(location.pathname))throw Error('DOUBAO_NATIVE_TARGET_MISMATCH');
    const findDoubaoModule=${findDoubaoModule.toString()};
    const captureDoubaoRuntime=${captureDoubaoRuntime.toString()};
    const verifyDoubaoNativeFactories=${verifyDoubaoNativeFactories.toString()};
    const applyDoubaoNativeFactories=${applyDoubaoNativeFactories.toString()};
    const qualification=${JSON.stringify(profile)};
    const captured=await captureDoubaoRuntime(qualification.runtimeGlobal);
    const assertRuntime=()=>{if(window[qualification.runtimeGlobal]!==captured.chunks)throw Error('DOUBAO_NATIVE_PREPARATION_RUNTIME_CHANGED');};
    const symbol=Symbol.for('agentoffice.doubao.preparation.apply.v1');let state=window[symbol];
    if(state&&(state.req!==captured.req||state.chunks!==captured.chunks))throw Error('DOUBAO_NATIVE_PREPARATION_RUNTIME_CHANGED');
    if(!state){state={req:captured.req,chunks:captured.chunks,pending:null};Object.defineProperty(window,symbol,{value:state});}
    // Register missing, hash-qualified factories only. Never run a chunk's
    // optional runtime callback or mark its normal application loading complete.
    const registrations={${sources.map(entry=>`${JSON.stringify(entry.id)}:()=>{\nconst window={[qualification.runtimeGlobal]:{push:entry=>{for(const [id,factory] of Object.entries(entry[1]))if(!captured.req.m[id])captured.req.m[id]=factory;}}};\n${entry.source}\n}`).join(',')}};
    if(!state.pending)state.pending=applyDoubaoNativeFactories(captured.req,qualification,registrations,assertRuntime).finally(()=>{state.pending=null;});
    const result=await state.pending;assertRuntime();return result;
  })()`;
}

async function prepareDoubaoNativeRuntime(transport) {
  if(typeof transport?.evaluate!=='function')throw new RoomError('需要已连接的原生桌面通道。',400,'desktop_bridge_unavailable');
  const fetched=await transport.evaluate(buildDoubaoNativePreparation(),30000);
  const profile=DOUBAO_NATIVE_PROFILES[fetched?.profileId];
  const valid=state=>!!profile&&state?.contractVersion===DOUBAO_NATIVE_CONTRACT.version&&state.runtimeGlobal===profile.runtimeGlobal
    &&JSON.stringify(state.factorySha256)===JSON.stringify(profile.factorySha256);
  if(!valid(fetched))throw new RoomError('原生豆包资源尚未通过源码校验。',409,'desktop_adapter_unsupported');
  const prepared=await transport.evaluate(buildDoubaoNativeRegistration(fetched.sources,fetched.profileId),30000);
  if(!valid(prepared))throw new RoomError('原生豆包资源尚未通过源码校验。',409,'desktop_adapter_unsupported');
  return {contractVersion:prepared.contractVersion,runtimeGlobal:prepared.runtimeGlobal,factorySha256:{...profile.factorySha256}};
}

// Source discovery precedes require: a guessed missing module poisons Webpack's
// cache. These exports/markers were checked in the installed Windows 2.32.4
// resources; the actual renderer must supply the same unique contracts.
function findDoubaoModule(req, kind, optional = false) {
  const exported = (source,names) => {
    // Only the factory's Webpack require.d(exports, {...}) table declares its
    // exports. A caller can destructure identical names in its function body.
    const parameters = source.match(/^(?:function(?:\s+[$\w]+)?\s*)?\(\s*[$\w]+\s*,\s*([$\w]+)\s*,\s*([$\w]+)\s*\)/);
    if (!parameters) return false;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern = new RegExp('(?:^|[^\\w$])'+escape(parameters[2])+'\\.d\\(\\s*'+escape(parameters[1])+'\\s*,\\s*\\{([^{}]*)\\}\\s*\\)','g');
    const tables = [...source.matchAll(pattern)].map(match=>match[1]);
    return names.every(name=>tables.some(table=>new RegExp('(?:^|,)\\s*'+escape(name)+'\\s*:\\s*\\(\\s*\\)\\s*=>').test(table)));
  };
  const contracts = {
    conversations:source => exported(source,['createConversation','createSendMessageConversationContext','getInfoByConversationId','MAIN_BOT_ID']),
    services:source => exported(source,['getChatService','getChatStore']),
    messages:source => exported(source,['createSendMessage','combineBlocks']),
    text:source => exported(source,['mapTextToTextBlock']) && !exported(source,['createSendMessage']),
    messageStore:source => exported(source,['useMessageStore']) && source.includes('useMessageStore is not initialized'),
    conversationInfo:source => exported(source,['fetchUpdateConversationInfo']) && source.includes('updateConversationInfo: invalid data from api'),
    identity:source => exported(source,['n5','bG']) && source.includes('user_id_str') && source.includes('isUserInfoLoaded'),
    complete:source => exported(source,['z']) && source.includes('PushMessageStatus.Streaming') && source.includes('is_finish') && source.includes('async_task'),
    cancellation:source => exported(source,['MessageBreak']) && source.includes('reply_msg_id') && source.includes('break_reason'),
  };
  if (!req?.m || !contracts[kind]) throw Error('DOUBAO_NATIVE_MODULE_DISCOVERY_UNAVAILABLE');
  const matches = Object.entries(req.m).filter(([,factory]) => typeof factory === 'function' && contracts[kind](Function.prototype.toString.call(factory)));
  if (!matches.length && optional) return null;
  if (matches.length !== 1) throw Error('DOUBAO_NATIVE_MODULE_CONTRACT_'+kind.toUpperCase()+'_'+(matches.length?'AMBIGUOUS':'MISSING'));
  const [id,factory] = matches[0];
  return {id:Number(id),source:Function.prototype.toString.call(factory)};
}

// This function is serialized into the authenticated native desktop renderer.
// It does not activate a conversation, reset the composer, read cookies, or
// enumerate the user's chats. Every observation stays in one selected bucket.
function createDoubaoNativeBridge(req, options = {}, ownership = new Map()) {
  if (options.contractVersion !== 'doubao-desktop-native-v1') throw Error('DOUBAO_NATIVE_VERSION_GUARD_REQUIRED');
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(options.runtimeKey || '')) throw Error('DOUBAO_NATIVE_INVALID_RUNTIME_KEY');
  const modules = {};
  for (const kind of ['conversations','services','messages','text','messageStore','conversationInfo','complete','identity']) modules[kind] = findDoubaoModule(req,kind);
  const normalizePins = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('DOUBAO_NATIVE_INVALID_SOURCE_IDENTITY');
    const entries = Object.entries(value).sort(([a],[b])=>a.localeCompare(b));
    const infoVariants=['2da587c4e01a8b7b5bcbaea93f8172fab4d3b7f0e9a45e00d58f4160fecd984f','b6f5b2318a59a2f4615d09b95c4ca401ec6af6070b0668cce9c199313bb248f9'];
    return Object.fromEntries(entries.map(([kind,expected])=>{
      if(!Object.hasOwn(modules,kind))throw Error('DOUBAO_NATIVE_INVALID_SOURCE_IDENTITY');
      if(Array.isArray(expected)){
        if(kind!=='conversationInfo'||!expected.length||expected.length>2||expected.some(hash=>!infoVariants.includes(hash)))throw Error('DOUBAO_NATIVE_INVALID_SOURCE_IDENTITY');
        return [kind,[...new Set(expected)].sort()];
      }
      if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))throw Error('DOUBAO_NATIVE_INVALID_SOURCE_IDENTITY');
      return [kind,expected];
    }));
  };
  const sourceIdentity = normalizePins(options.factorySha256 === undefined ? {} : options.factorySha256);
  function assertSourceIdentity(value = {}) {
    if (JSON.stringify(normalizePins(value)) !== JSON.stringify(sourceIdentity)) throw Error('DOUBAO_NATIVE_SOURCE_IDENTITY_CONFIG_CHANGED');
  }
  let conversations,services,messages,text,store,fetchInfo,isComplete,currentAccount,account;
  // Keep account identity inside the renderer closure; it is never returned to
  // AO, logged, or read from a profile/cookie store.
  const assertAccount = () => {if(String(currentAccount() || '')!==account)throw Error('DOUBAO_NATIVE_ACCOUNT_CHANGED');};
  const turns = new Map(), terminal = new Set(['completed','error','cancelled']);
  let nativeChatId = null, creating = null, createUncertain = false, initializing = null, verified = false, verifying = null;
  const own = id => {
    const owner = ownership.get(id);
    if (owner && owner !== options.runtimeKey) throw Error('DOUBAO_NATIVE_PERSON_CHAT_ALREADY_OWNED');
    ownership.set(id,options.runtimeKey);
  };
  const summary = () => ({contract:options.contractVersion,detached:true,nativeChatId,creating:!!creating,createUncertain,initializing:!!initializing,verifying:!!verifying});
  const idText = value => typeof value === 'string' && value && value.length <= 160 && !value.includes('\0');
  async function verifyFactories() {
    if (verified) {assertAccount();return;}
    if (verifying) return verifying;
    verifying = (async()=>{
      // Factory discovery and every supplied pin are checked before any native
      // business module is instantiated. Rejected sources cannot run effects.
      for (const [kind,expected] of Object.entries(sourceIdentity)) {
        const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(modules[kind].source));
        const actual = [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
        if (!(Array.isArray(expected)?expected:[expected]).includes(actual)) throw Error('DOUBAO_NATIVE_SOURCE_IDENTITY_MISMATCH');
      }
      for (const entry of Object.values(modules)) if (typeof req.m[entry.id] !== 'function'
        || Function.prototype.toString.call(req.m[entry.id]) !== entry.source) throw Error('DOUBAO_NATIVE_SOURCE_IDENTITY_MISMATCH');
      for (const entry of Object.values(modules)) entry.exports = req(entry.id);
      conversations = modules.conversations.exports;services = modules.services.exports;
      messages = modules.messages.exports;text = modules.text.exports;
      store = modules.messageStore.exports.useMessageStore;fetchInfo = modules.conversationInfo.exports.fetchUpdateConversationInfo;
      isComplete = modules.complete.exports.z;currentAccount = modules.identity.exports.n5;
      if (![conversations.createConversation,conversations.createSendMessageConversationContext,conversations.getInfoByConversationId,
        services.getChatService,messages.createSendMessage,messages.combineBlocks,text.mapTextToTextBlock,
        store?.getState,fetchInfo,isComplete,currentAccount].every(value => typeof value === 'function')) throw Error('DOUBAO_NATIVE_EXPORT_CONTRACT_MISMATCH');
      if (!conversations.MAIN_BOT_ID && !options.botId) throw Error('DOUBAO_NATIVE_BOT_ID_UNAVAILABLE');
      account = String(currentAccount() || '');
      if (!account || account==='0') throw Error('DOUBAO_NATIVE_ACCOUNT_UNAVAILABLE');
      verified = true;
    })();
    try {await verifying;} finally {verifying = null;}
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
    if (Array.isArray(blocks)) {
      const value = blocks.map(block=>typeof block.content?.text_block?.text==='string'?block.content.text_block.text:'').join('');
      if (value.trim()) return value;
    }
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
    const cancellation = entry && req(entry.id);
    if (typeof cancellation?.MessageBreak !== 'function') throw Error('DOUBAO_NATIVE_CANCEL_CONTRACT_UNAVAILABLE');
    assertAccount();
    const ack = await cancellation.MessageBreak({conversation_id:nativeChatId,reply_id:t.userMessageId,break_reason:7});
    if (Number(ack?.code) !== 0) throw Error('DOUBAO_NATIVE_CANCEL_REJECTED');
    t.cancelRequested = true;
    // A successful stop API acknowledgement is not a terminal reply record.
    return query(requestId);
  }
  function inspect() { return {...summary(),adapterRevision:'doubao-native-adapter-v4',
    moduleIds:Object.fromEntries(Object.entries(modules).map(([kind,value])=>[kind,value.id])),requests:turns.size,
    pendingRequestIds:[...turns.values()].filter(t=>!terminal.has(t.status)).map(t=>t.requestId),
    unsettledRequestIds:[...turns.values()].filter(t=>!t.settled).map(t=>t.requestId)}; }
  return {adapterRevision:'doubao-native-adapter-v4',runtimeGlobal:options.chunkName||null,initialize,createPersonConversation,send,snapshot:query,restore,cancel,inspect,assertSourceIdentity,verifySourceIdentity:verifyFactories};
}

function buildDoubaoNativeBootstrap(options = {}) {
  if(options.contractVersion && options.contractVersion!==DOUBAO_NATIVE_CONTRACT.version)throw new RoomError('原生豆包接口版本不受支持。',409,'desktop_contract_mismatch');
  const {runtimeKey,nativeChatId=null,nativeConversationId=null,botId,factorySha256={},runtimeGlobal=null} = options;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runtimeKey || '')) throw new RoomError('原生豆包人物引用无效。',400,'desktop_identity_mismatch');
  if(runtimeGlobal&&!DOUBAO_NATIVE_CONTRACT.runtimeGlobals.includes(runtimeGlobal))throw new RoomError('原生豆包运行时不受支持。',409,'desktop_adapter_unsupported');
  const args = {runtimeKey,nativeChatId:nativeChatId || nativeConversationId,botId,factorySha256,runtimeGlobal,contractVersion:DOUBAO_NATIVE_CONTRACT.version,adapterRevision:DOUBAO_NATIVE_CONTRACT.adapterRevision};
  return `(async()=>{
    if(!['doubao:','chrome:'].includes(location.protocol)||location.hostname!=='doubao-chat'||!/^\\/chat(?:\\/|$)/.test(location.pathname))throw Error('DOUBAO_NATIVE_TARGET_MISMATCH');
    const findDoubaoModule=${findDoubaoModule.toString()};
    const captureDoubaoRuntime=${captureDoubaoRuntime.toString()};
    const createDoubaoNativeBridge=${createDoubaoNativeBridge.toString()};
    const args=${JSON.stringify(args)};
    const symbol=Symbol.for('agentoffice.doubao.native.v1');
    let registry=window[symbol];
    if(registry&&registry.contract!==args.contractVersion)throw Error('DOUBAO_NATIVE_REGISTRY_VERSION_MISMATCH');
    if(!registry){registry={contract:args.contractVersion,bridges:new Map(),ownership:new Map()};Object.defineProperty(window,symbol,{value:registry});}
    let bridge=registry.bridges.get(args.runtimeKey);
    if(args.runtimeGlobal&&(!Array.isArray(window[args.runtimeGlobal])||bridge?.runtimeGlobal&&bridge.runtimeGlobal!==args.runtimeGlobal))throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
    if(typeof bridge?.assertSourceIdentity==='function')bridge.assertSourceIdentity(args.factorySha256);
    let legacy=null,restoreId=null;
    const emptyOwnedLegacy=state=>state?.contract===args.contractVersion&&state.detached===true&&state.requests===0
      &&state.creating===false&&state.createUncertain===false&&typeof state.nativeChatId==='string'
      &&state.nativeChatId.length>0&&state.nativeChatId.length<=160&&!state.nativeChatId.includes('\\0')&&!state.nativeChatId.startsWith('local')
      &&registry.ownership?.get(state.nativeChatId)===args.runtimeKey&&(!args.nativeChatId||args.nativeChatId===state.nativeChatId);
    if(bridge&&(bridge.adapterRevision!==args.adapterRevision||typeof bridge.assertSourceIdentity!=='function')){
      let state;try{state=typeof bridge.inspect==='function'?await bridge.inspect():null;}catch{}
      if(!emptyOwnedLegacy(state)||typeof bridge.initialize!=='function')throw Error('DOUBAO_NATIVE_ADAPTER_REVISION_INCOMPATIBLE');
      legacy=bridge;restoreId=state.nativeChatId;bridge=null;
    }
    if(bridge&&args.runtimeGlobal&&bridge.runtimeGlobal!==args.runtimeGlobal)throw Error('DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_RUNTIME');
    if(!bridge){
      const keys=(args.runtimeGlobal?[args.runtimeGlobal]:${JSON.stringify(DOUBAO_NATIVE_CONTRACT.runtimeGlobals)}).filter(key=>Array.isArray(window[key]));
      if(keys.length!==1)throw Error('DOUBAO_NATIVE_WEBPACK_RUNTIME_MISSING_OR_AMBIGUOUS');
      const key=keys[0];const {req}=await captureDoubaoRuntime(key);
      bridge=createDoubaoNativeBridge(req,{...args,nativeChatId:restoreId||args.nativeChatId,chunkName:key},registry.ownership);
      if(legacy){
        // Upgrade only an empty, already-owned conversation. Keep the old slot
        // until source verification and read-only restoration both succeed.
        await bridge.verifySourceIdentity();
        let oldProof;try{oldProof=await legacy.initialize({nativeChatId:restoreId});}catch{throw Error('DOUBAO_NATIVE_ADAPTER_REVISION_INCOMPATIBLE');}
        if(oldProof?.contract!==args.contractVersion||oldProof.detached!==true||oldProof.nativeChatId!==restoreId)throw Error('DOUBAO_NATIVE_ADAPTER_REVISION_INCOMPATIBLE');
        const state=await bridge.initialize({nativeChatId:restoreId});
        let previous;try{previous=await legacy.inspect();}catch{}
        if(registry.bridges.get(args.runtimeKey)!==legacy||!emptyOwnedLegacy(previous)||previous.nativeChatId!==restoreId)throw Error('DOUBAO_NATIVE_ADAPTER_REVISION_INCOMPATIBLE');
        registry.bridges.set(args.runtimeKey,bridge);return state;
      }
      registry.bridges.set(args.runtimeKey,bridge);
    }
    bridge.assertSourceIdentity(args.factorySha256);
    return bridge.initialize({nativeChatId:args.nativeChatId});
  })()`;
}

class DesktopDoubao {
  constructor({evaluate,runtimeKey,nativeChatId=null,nativeConversationId=null,botId,factorySha256={},runtimeGlobal=null,contractVersion=DOUBAO_NATIVE_CONTRACT.version} = {}) {
    if (typeof evaluate !== 'function') throw new RoomError('需要已连接的原生桌面通道。',400,'desktop_bridge_unavailable');
    if(contractVersion!==DOUBAO_NATIVE_CONTRACT.version)throw new RoomError('原生豆包接口版本不受支持。',409,'desktop_contract_mismatch');
    this.evaluate=evaluate;this.options={runtimeKey,nativeChatId:nativeChatId || nativeConversationId,botId,factorySha256,runtimeGlobal};
    this.nativeChatId=this.options.nativeChatId;this.ready=false;
  }
  async initialize({nativeChatId=this.nativeChatId,nativeConversationId} = {}) {
    const expected=nativeChatId || nativeConversationId || null;
    if(this.ready && expected && expected!==this.nativeChatId)throw new RoomError('不能替换这位同事的原生豆包对话。',409,'desktop_identity_mismatch');
    try {
      const state=await this.evaluate(buildDoubaoNativeBootstrap({...this.options,nativeChatId:expected}));
      if(state?.contract!==DOUBAO_NATIVE_CONTRACT.version||state.detached!==true||!state.nativeChatId)throw new RoomError('原生豆包接口尚未完成绑定。',409,'desktop_contract_mismatch');
      if(expected && expected!==state.nativeChatId)throw new RoomError('原生豆包返回了另一对话。',403,'desktop_identity_mismatch');
      this.nativeChatId=state.nativeChatId;this.ready=true;return state;
    } catch(error) {
      // Runtime.evaluate may have lost its acknowledgement while creation kept
      // running. Inspect only this runtime's metadata; never initialize again.
      let proof;
      try {proof=await this.evaluate(`(async()=>{const key=${JSON.stringify(this.options.runtimeKey)},r=window[Symbol.for('agentoffice.doubao.native.v1')];if(r?.contract!==${JSON.stringify(DOUBAO_NATIVE_CONTRACT.version)})return null;const b=r.bridges?.get(key);if(typeof b?.inspect!=='function')return null;const s=await b.inspect();return {runtimeKey:key,runtimeGlobal:b.runtimeGlobal,state:{contract:s?.contract,detached:s?.detached,nativeChatId:s?.nativeChatId,creating:s?.creating,createUncertain:s?.createUncertain,initializing:s?.initializing,verifying:s?.verifying,requests:s?.requests},owned:typeof s?.nativeChatId==='string'&&r.ownership?.get(s.nativeChatId)===key};})()`);}catch{}
      const state=proof?.state,known=proof?.runtimeKey===this.options.runtimeKey&&state?.contract===DOUBAO_NATIVE_CONTRACT.version&&state.detached===true
        &&(!this.options.runtimeGlobal||proof.runtimeGlobal===this.options.runtimeGlobal)&&typeof state.creating==='boolean'&&typeof state.createUncertain==='boolean'&&Number.isInteger(state.requests)&&state.requests>=0;
      const id=state?.nativeChatId,serverId=typeof id==='string'&&id.length>0&&id.length<=160&&!id.includes('\0')&&!id.startsWith('local');
      if(known&&serverId&&proof.owned===true&&(!expected||expected===id))error.nativeChatId=id;
      if(error.code==='desktop_contract_mismatch'&&known&&state.requests===0&&state.nativeChatId===null&&state.creating===false&&state.createUncertain===false&&state.initializing===false&&state.verifying===false)error.creationNotDispatched=true;
      else error.uncertain=true;
      throw error;
    }
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

module.exports={createBridge,DesktopDoubao,DOUBAO_NATIVE_CONTRACT,DOUBAO_NATIVE_PREPARATION,findDoubaoModule,createDoubaoNativeBridge,buildDoubaoNativeBootstrap,
  prepareDoubaoNativeRuntime,buildDoubaoNativePreparation,buildDoubaoNativeRegistration,captureDoubaoRuntime,verifyDoubaoNativeFactories,prepareDoubaoNativeFactories,applyDoubaoNativeFactories};
