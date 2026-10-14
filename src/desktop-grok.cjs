'use strict';
const {createHash}=require('node:crypto');

// Verified against the extracted installed 0.70.2 renderer, not yet accepted
// against a live CDP endpoint. A matching source bundle alone is no turn proof.
const GROK_NATIVE_CONTRACT=Object.freeze({
  version:'grok-bot-0.70.2-owned-native-v1',installedVersion:'0.70.2',liveVerified:false,
  entryFile:'index-Bo3NzkuN.js',entrySha256:'28dbc86384b9253b39ec9a0db395cae96f158290b090ce5d840946f06a185134',
  appFile:'index.eager-app-CY939ORZ.js',appSha256:'c72e76acf2dc23d8c7ad462f00acd13aff26fb2ff2ba0507bba342f0837fa166'
});

function findGrokNativeClient(){
  const root=document.getElementById('root');if(!root)throw Error('GROK_NATIVE_ROOT_UNAVAILABLE');
  const queue=Object.keys(root).filter(key=>key.startsWith('__reactContainer$')||key.startsWith('__reactFiber$')).map(key=>root[key]),seen=new Set;
  for(let cursor=0;cursor<queue.length&&cursor<2048;cursor++){
    const fiber=queue[cursor];if(!fiber||seen.has(fiber))continue;seen.add(fiber);
    const client=fiber.memoizedProps?.client;
    if(client?.roster?.createAgent&&client?.roster?.agentNow&&client?.roster?.interruptAgentRun&&client?.sendJournal?.sendPrompt&&client?.transcript?.snapshotsFor&&client?.transcript?.retain&&client?.boot?.get)return client;
    if(fiber.stateNode?.current&&fiber.stateNode.current!==fiber)queue.push(fiber.stateNode.current);
    if(fiber.child)queue.push(fiber.child);if(fiber.sibling)queue.push(fiber.sibling);
  }
  throw Error('GROK_NATIVE_LIVE_CLIENT_UNAVAILABLE');
}

function correlateGrokTurn({agentId,clientNonce,baselineSettlementKey,agent,snapshot}){
  if(!agent||agent.id!==agentId)return{status:'identity_mismatch'};
  if(snapshot?.loadState!=='ready'||snapshot.isShowingRestoredTranscript===true)return{status:'awaiting_live_transcript'};
  const entries=Array.isArray(snapshot.entries)?snapshot.entries:[];
  const echoIndex=entries.findIndex(entry=>entry.kind==='message'&&entry.role==='user'&&entry.clientNonce===clientNonce&&typeof entry.id==='string'&&entry.id&&!entry.id.startsWith('optimistic:'));
  if(echoIndex<0)return{status:'awaiting_echo'};
  const userMessageId=entries[echoIndex].id,settlement=agent.lastTurnSettlement;
  // Host and controller clocks need not agree. The host's own settlement key
  // must differ from the pre-send observation and match the exact fresh nonce.
  if(!settlement||settlement.clientNonce!==clientNonce||!Number.isFinite(settlement.settledAtMs)||`${settlement.clientNonce}:${settlement.settledAtMs}`===baselineSettlementKey)return{status:'awaiting_correlated_settlement',userMessageId};
  const basis={userMessageId,clientNonce,settledAtMs:settlement.settledAtMs};
  if(settlement.outcome==='cancelled')return{status:'cancelled',...basis};
  if(settlement.outcome==='error')return{status:'error',errorCode:settlement.errorCode||'native_turn_error',...basis};
  if(settlement.outcome!=='success')return{status:'incomplete',...basis};
  if(agent.awaitingUserResponse!=null||settlement.botBlock?.confidence==='high')return{status:'incomplete',...basis};
  const subsequent=[];
  for(const entry of entries.slice(echoIndex+1)){
    if(entry.kind==='message'&&entry.role==='user'&&entry.clientNonce!==clientNonce)break;
    subsequent.push(entry);
  }
  if(subsequent.some(entry=>entry.kind==='message'&&entry.role==='assistant'&&entry.isStreaming===true)||agent.isRunning===true||agent.isComposingMessage===true)return{status:'awaiting_final_transcript',...basis};
  const answer=subsequent.filter(entry=>entry.kind==='message'&&entry.role==='assistant'&&entry.isStreaming===false&&typeof entry.id==='string'&&entry.id&&!entry.id.startsWith('optimistic:')&&typeof entry.content==='string'&&entry.content.trim()).at(-1);
  // Grok's linear transcript has no raw parent links. Normalize provenance
  // only after the exact native echo and settlement bound this answer segment.
  return answer?{status:'completed',replies:[{id:answer.id,parentId:userMessageId,role:'assistant',done:true,content:answer.content}],...basis}:{status:'awaiting_actual_answer',...basis};
}

function createGrokNativeDetachedBridge(client,options={}){
  if(options.contractVersion!=='grok-bot-0.70.2-owned-native-v1'||typeof options.correlate!=='function')throw Error('GROK_NATIVE_CONTRACT_MISMATCH');
  const turns=new Map,terminal=new Set(['completed','error','cancelled','incomplete']);
  let nativeChatId=options.nativeChatId||null,personName=options.personName||'Agent Office 同事',creation=null,creationUncertain=false,active=null,disposed=false;
  const errorCode=error=>{const value=String(error?.failure?.code||error?.code||'native_send_failed');return /^[a-z0-9_.:/-]{1,100}$/i.test(value)?value:'native_send_failed';};
  function requireClient(){if(disposed)throw Error('GROK_NATIVE_BRIDGE_DISPOSED');if(client.boot.get().status!=='ready')throw Error('GROK_NATIVE_CLIENT_NOT_READY');}
  function ownAgent(){
    const agent=nativeChatId?client.roster.agentNow(nativeChatId):null;
    if(!agent||agent.id!==nativeChatId||agent.viewerIsOwner===false||agent.isGroup===true)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');
    return agent;
  }
  function release(turn){if(turn.release){turn.release();turn.release=null;}}
  function inspect(){return{contract:options.contractVersion,detached:true,nativeChatId,creationUncertain,activeRequestId:active};}
  async function createPersonConversation(ownerPerson={}){
    requireClient();
    if(ownerPerson&&typeof ownerPerson==='object'&&ownerPerson.nativeChatId){
      if(nativeChatId&&nativeChatId!==ownerPerson.nativeChatId)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');nativeChatId=ownerPerson.nativeChatId;
    }
    if(nativeChatId){ownAgent();return inspect();}
    if(creation)return creation;
    if(creationUncertain)throw Error('GROK_NATIVE_CREATION_UNCERTAIN');
    if(typeof ownerPerson==='string'&&ownerPerson.trim())personName=ownerPerson.trim();
    else if(typeof ownerPerson?.personName==='string'&&ownerPerson.personName.trim())personName=ownerPerson.personName.trim();
    if(personName.length>120)throw Error('GROK_NATIVE_PERSON_NAME_INVALID');
    // Temporal creation uses the actual nonce as native identity. Reconcile
    // that exact known ID; never choose another user's Bot by its display name.
    const known=client.roster.agentNow(options.creationNonce);
    if(known?.id===options.creationNonce&&known.viewerIsOwner!==false&&!known.isGroup){nativeChatId=known.id;return inspect();}
    creation=(async()=>{
      try{
        const result=await client.roster.createAgent({name:personName,description:`Agent Office 协作同事：${personName}`,origin:'user',isKickstartRequested:false,clientNonce:options.creationNonce});
        if(typeof result?.agent?.id!=='string'||!result.agent.id)throw Error('GROK_NATIVE_CREATE_RESPONSE_MISSING');
        nativeChatId=result.agent.id;ownAgent();return inspect();
      }catch(error){creationUncertain=true;throw error;}
    })();
    return creation;
  }
  async function initialize({nativeChatId:requestedId}={}){
    requireClient();
    if(requestedId){if(nativeChatId&&nativeChatId!==requestedId)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');nativeChatId=requestedId;}
    return createPersonConversation();
  }
  function query({requestId,includeContent=false}={}){
    requireClient();const turn=turns.get(requestId);if(!turn)return{status:'unknown_request',nativeChatId};
    if(!terminal.has(turn.status)){
      const result=turn.nonce?options.correlate({agentId:turn.nativeChatId,clientNonce:turn.nonce,baselineSettlementKey:turn.baselineSettlementKey,agent:ownAgent(),snapshot:client.transcript.snapshotsFor(turn.nativeChatId,{sessionId:''}).get()}):{status:'awaiting_nonce'};
      turn.userMessageId=result.userMessageId||turn.userMessageId;
      if(result.status==='identity_mismatch'){turn.status='error';turn.error={code:'native_person_identity_mismatch'};}
      else if(terminal.has(result.status)){turn.status=result.status;turn.replies=result.replies||[];turn.error=result.errorCode?{code:errorCode({code:result.errorCode})}:turn.error;turn.settledAtMs=result.settledAtMs;release(turn);}
      else turn.status=turn.userMessageId?'running':'sending';
    }
    const out={contract:options.contractVersion,requestId,nativeChatId:turn.nativeChatId,nativeRequestId:turn.nonce||null,status:turn.status,userMessageId:turn.userMessageId||null,responseMessageIds:(turn.replies||[]).map(reply=>reply.id),sendSettled:turn.sendSettled,settledAtMs:turn.settledAtMs||null,cancelRequested:turn.cancelRequested===true,error:turn.error||null};
    if(includeContent&&turn.status==='completed')out.replies=turn.replies;
    return out;
  }
  async function send({nativeChatId:requestedId,requestId,prompt}={}){
    requireClient();
    if(typeof requestId!=='string'||!requestId||requestId.length>200||typeof prompt!=='string'||!prompt.trim()||prompt.length>30000)throw Error('GROK_NATIVE_REQUEST_INVALID');
    if(requestedId&&nativeChatId&&requestedId!==nativeChatId)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');
    if(turns.has(requestId)){const old=turns.get(requestId);if(old.prompt!==prompt||requestedId&&old.nativeChatId!==requestedId)throw Error('GROK_NATIVE_REQUEST_ID_CONFLICT');return query({requestId});}
    await initialize({nativeChatId:requestedId});
    if(turns.has(requestId)){const old=turns.get(requestId);if(old.prompt!==prompt||requestedId&&old.nativeChatId!==requestedId)throw Error('GROK_NATIVE_REQUEST_ID_CONFLICT');return query({requestId});}
    if(active&&!terminal.has(query({requestId:active}).status))throw Error('GROK_NATIVE_TURN_IN_PROGRESS');
    const agent=ownAgent();if(agent.isRunning||agent.isComposingMessage||agent.awaitingUserResponse!=null)throw Error('GROK_NATIVE_PERSON_BUSY');
    const previous=agent.lastTurnSettlement,baselineSettlementKey=previous?`${previous.clientNonce}:${previous.settledAtMs}`:null;
    const turn={requestId,prompt,nativeChatId,startedAtMs:Date.now(),baselineSettlementKey,status:'sending',nonce:null,userMessageId:null,replies:[],sendSettled:false,release:client.transcript.retain(nativeChatId,{sessionId:''})};
    turns.set(requestId,turn);active=requestId;
    Promise.resolve().then(()=>client.sendJournal.sendPrompt({agentId:turn.nativeChatId,prompt,attachments:[],onNonceAssigned:({nonce})=>{if(typeof nonce!=='string'||!nonce)throw Error('GROK_NATIVE_NONCE_MISSING');turn.nonce=nonce;}})).then(()=>{turn.sendSettled=true;},error=>{turn.sendSettled=true;if(terminal.has(turn.status))return;turn.error={code:errorCode(error)};turn.status='error';release(turn);});
    // Native nonce assignment precedes the send pipeline's first await.
    await Promise.resolve();return query({requestId});
  }
  async function cancel({requestId}={}){
    requireClient();const turn=turns.get(requestId);if(!turn||active!==requestId)throw Error('GROK_NATIVE_CANCEL_IDENTITY_MISMATCH');
    const state=query({requestId});if(terminal.has(state.status))return state;
    const agent=ownAgent(),snapshot=client.transcript.snapshotsFor(nativeChatId,{sessionId:''}).get();
    const lastUser=snapshot.entries?.filter(entry=>entry.kind==='message'&&entry.role==='user'&&!String(entry.id).startsWith('optimistic:')).at(-1);
    if(agent.isRunning!==true||!turn.nonce||lastUser?.clientNonce!==turn.nonce||agent.lastTurnSettlement?.clientNonce===turn.nonce)throw Error('GROK_NATIVE_CANCEL_CORRELATION_MISMATCH');
    turn.cancelRequested=true;await client.roster.interruptAgentRun({agentId:nativeChatId,sessionId:''});return query({requestId});
  }
  function dispose(){disposed=true;for(const turn of turns.values())release(turn);}
  return{initialize,createPersonConversation,send,query,cancel,inspect,dispose};
}

function creationNonce(runtimeKey){const hash=createHash('sha256').update('agentoffice:grok-person:'+runtimeKey).digest('hex');return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
function buildGrokNativeBootstrap({runtimeKey,nativeChatId=null,personName='Agent Office 同事'}={}){
  if(typeof runtimeKey!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(runtimeKey))throw Error('GROK_NATIVE_RUNTIME_KEY_INVALID');
  if(nativeChatId!==null&&(typeof nativeChatId!=='string'||!nativeChatId||nativeChatId.length>200))throw Error('GROK_NATIVE_PERSON_IDENTITY_INVALID');
  if(typeof personName!=='string'||!personName.trim()||personName.length>120)throw Error('GROK_NATIVE_PERSON_NAME_INVALID');
  const args={runtimeKey,nativeChatId,personName,creationNonce:creationNonce(runtimeKey),contractVersion:GROK_NATIVE_CONTRACT.version};
  return `(async()=>{
    const contract=${JSON.stringify(GROK_NATIVE_CONTRACT)},args=${JSON.stringify(args)},url=new URL(location.href);
    if(url.protocol!=='file:'||!/\\/resources\\/app\\.asar\\/dist\\/renderer\\/index\\.html$/i.test(url.pathname)||document.title!=='Grok Bot')throw Error('GROK_NATIVE_HOST_IDENTITY_MISMATCH');
    const entryUrl=new URL('./assets/'+contract.entryFile,url).href,appUrl=new URL('./assets/'+contract.appFile,url).href;
    if(![...document.scripts].some(script=>script.src===entryUrl))throw Error('GROK_NATIVE_LOADED_SOURCE_MISMATCH');
    for(const [source,expected]of [[entryUrl,contract.entrySha256],[appUrl,contract.appSha256]]){
      const response=await fetch(source,{cache:'force-cache'});if(!response.ok)throw Error('GROK_NATIVE_SOURCE_READ_UNAVAILABLE');
      const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
      if([...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')!==expected)throw Error('GROK_NATIVE_SOURCE_VERSION_MISMATCH');
    }
    const client=(${findGrokNativeClient.toString()})();
    const registry=globalThis.__agentOfficeGrokNativeSessions||(globalThis.__agentOfficeGrokNativeSessions=Object.create(null));
    const bridge=registry[args.runtimeKey]||(registry[args.runtimeKey]=(${createGrokNativeDetachedBridge.toString()})(client,{...args,correlate:(${correlateGrokTurn.toString()})}));
    return await bridge.initialize({nativeChatId:args.nativeChatId});
  })()`;
}
class DesktopGrok{
  constructor({evaluate,runtimeKey,nativeChatId=null,personName}={}){
    if(typeof evaluate!=='function')throw Error('GROK_NATIVE_EVALUATOR_REQUIRED');
    this.options={runtimeKey,nativeChatId,personName};buildGrokNativeBootstrap(this.options);this.evaluate=evaluate;this.nativeChatId=nativeChatId;this.ready=false;
  }
  async initialize({nativeChatId=this.nativeChatId}={}){
    const result=await this.evaluate(buildGrokNativeBootstrap({...this.options,nativeChatId}));
    if(result?.contract!==GROK_NATIVE_CONTRACT.version||result.detached!==true||typeof result.nativeChatId!=='string'||!result.nativeChatId)throw Error('GROK_NATIVE_RUNTIME_CONTRACT_MISMATCH');
    if(this.nativeChatId&&result.nativeChatId!==this.nativeChatId)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');
    this.nativeChatId=result.nativeChatId;this.ready=true;return result;
  }
  async call(method,args={}){
    if(!this.ready)throw Error('GROK_NATIVE_NOT_INITIALIZED');
    if(!['createPersonConversation','send','query','cancel','inspect','dispose'].includes(method))throw Error('GROK_NATIVE_METHOD_REJECTED');
    return this.evaluate(`globalThis.__agentOfficeGrokNativeSessions[${JSON.stringify(this.options.runtimeKey)}][${JSON.stringify(method)}](${JSON.stringify(args)})`);
  }
  async createPersonConversation(ownerPerson={}){if(!this.ready)await this.initialize();return this.call('createPersonConversation',ownerPerson);}
  async send(nativeChatId,{requestId,prompt}={}){if(nativeChatId&&this.nativeChatId&&nativeChatId!==this.nativeChatId)throw Error('GROK_NATIVE_PERSON_IDENTITY_MISMATCH');if(!this.ready)await this.initialize({nativeChatId:nativeChatId||this.nativeChatId});return this.call('send',{nativeChatId:this.nativeChatId,requestId,prompt});}
  snapshot(requestId,{includeContent=false}={}){return requestId?this.call('query',{requestId,includeContent}):this.call('inspect');}
  cancel(requestId){return this.call('cancel',{requestId});}
}
function createBridge(cdp,options={}){const evaluate=typeof cdp==='function'?cdp:typeof cdp?.evaluate==='function'?cdp.evaluate.bind(cdp):null;return new DesktopGrok({...options,evaluate});}
module.exports={createBridge,DesktopGrok,GROK_NATIVE_CONTRACT,buildGrokNativeBootstrap,findGrokNativeClient,createGrokNativeDetachedBridge,correlateGrokTurn,creationNonce};
