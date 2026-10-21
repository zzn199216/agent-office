'use strict';
const {RoomError}=require('./util.cjs');

// Keys are canonicalized by the caller from AO data, executable and auth HOME.
// This pool owns only the transport. Member instructions and MCP identity stay
// on the facade; no authentication or model work is performed here.
const transports=new Map();
const routingError=()=>({code:-32602,message:'This request has no active AgentRoom thread owner.'});
function threadFor(request){
  const camel=request?.params?.threadId,snake=request?.params?.thread_id;
  if(camel!==undefined&&(typeof camel!=='string'||!camel.trim())||snake!==undefined&&(typeof snake!=='string'||!snake.trim()))return null;
  if(camel!==undefined&&snake!==undefined&&camel!==snake)return null;
  return camel||snake||null;
}
function rejectUnowned(entry,request){
  // A disconnected owner can already have lost its writable channel. Rejection
  // is best effort and is never replayed on a later transport.
  try{const result=entry.owner.rejectRequest(request?.id,routingError());result?.catch?.(()=>{});}catch{}
}
function emitFacade(client,event,value){
  try{client.emit(event,value);}catch(error){
    // One consumer callback must not suppress another member's completion or
    // disconnect. Report locally without retrying any native operation.
    try{client.emit('transport-callback-error',{event,error});}catch{}
  }
}
function attach(entry){
  const owner=entry.owner;
  entry.handlers={
    notification:message=>{for(const client of [...entry.clients.keys()])if(entry.clients.has(client))emitFacade(client,'notification',message);},
    disconnected:error=>{for(const client of [...entry.clients.keys()])if(entry.clients.has(client))emitFacade(client,'disconnected',error);},
    'transport-progress':message=>{if(entry.clients.size===1)emitFacade(entry.clients.keys().next().value,'transport-progress',message);},
    request:request=>{
      const threadId=threadFor(request),client=threadId&&entry.threads.get(threadId);
      if(!client||!entry.clients.has(client)||client.listenerCount('request')===0){rejectUnowned(entry,request);return;}
      client.emit('request',request);
    }
  };
  for(const [event,handler]of Object.entries(entry.handlers))owner.on(event,handler);
}
function closeEntry(key,entry){
  if(entry.closing)return entry.closePromise;
  entry.closing=true;
  // Set the closing state before yielding. A new acquire must wait for close,
  // even when owner.close itself waits for process exit or throws.
  entry.closePromise=Promise.resolve().then(()=>entry.owner.close()).finally(()=>{
    for(const [event,handler]of Object.entries(entry.handlers))entry.owner.off(event,handler);
    if(transports.get(key)===entry)transports.delete(key);
  });
  return entry.closePromise;
}
async function acquireTransport(key,client,createOwner){
  if(typeof key!=='string'||!key.trim()||typeof client?.emit!=='function'||typeof client?.listenerCount!=='function'||typeof createOwner!=='function')throw new RoomError('共享 Codex 连接参数无效。',400,'codex_transport_invalid');
  let entry;
  for(;;){
    entry=transports.get(key);
    if(entry?.closing){await entry.closePromise;continue;}
    if(!entry){
      entry={owner:null,clients:new Map(),threads:new Map(),closing:false,closePromise:null,handlers:null};
      transports.set(key,entry);
      const created=entry;
      entry.ready=Promise.resolve().then(createOwner).then(owner=>{
        if(!owner||typeof owner.on!=='function'||typeof owner.off!=='function'||typeof owner.close!=='function'||typeof owner.rejectRequest!=='function')throw new RoomError('共享 Codex 连接宿主无效。',500,'codex_transport_invalid_owner');
        if(owner===client)throw new RoomError('共享 Codex 宿主与成员连接必须分别登记。',409,'codex_transport_owner_conflict');
        created.owner=owner;attach(created);return owner;
      }).catch(error=>{if(transports.get(key)===created)transports.delete(key);throw error;});
    }
    await entry.ready;
    if(entry.closing){await entry.closePromise;continue;}
    if(entry.owner===client)throw new RoomError('共享 Codex 宿主不能作为另一个成员连接。',409,'codex_transport_owner_conflict');
    break;
  }
  entry.clients.set(client,(entry.clients.get(client)||0)+1);
  let released=false,releasePromise;
  return {
    owner:entry.owner,
    registerThread(threadId){
      if(released||entry.closing)throw new RoomError('这个成员已释放共享 Codex 连接。',409,'codex_transport_released');
      if(typeof threadId!=='string'||!threadId.trim())throw new RoomError('Codex 会话标识无效。',400,'codex_transport_thread_invalid');
      const previous=entry.threads.get(threadId);
      if(previous&&previous!==client)throw new RoomError('这个 Codex 会话已由另一位成员持有。',409,'codex_transport_thread_conflict');
      entry.threads.set(threadId,client);
    },
    hasActiveWork(){return [...entry.clients.keys()].some(facade=>facade.listenerCount('notification')>0);},
    release(){
      if(released)return releasePromise;
      released=true;
      const count=entry.clients.get(client)||0;
      if(count>1)entry.clients.set(client,count-1);
      else{
        entry.clients.delete(client);
        for(const [threadId,facade]of entry.threads)if(facade===client)entry.threads.delete(threadId);
      }
      releasePromise=entry.clients.size?Promise.resolve():closeEntry(key,entry);
      return releasePromise;
    }
  };
}
module.exports={acquireTransport};
