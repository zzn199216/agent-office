'use strict';
const {EventEmitter}=require('node:events');
const {RoomError}=require('./util.cjs');
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
function localEndpoint(value){
  let url;try{url=new URL(value);}catch{throw new RoomError('桌面对话连接地址无效。',400,'desktop_endpoint_invalid');}
  if(url.protocol!=='http:'||!LOOPBACK.has(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new RoomError('桌面对话连接只能使用本机 HTTP 端口。',400,'desktop_endpoint_invalid');
  return url;
}
function targetMatches(target,provider){
  try{
    const url=new URL(target.url);
    if(provider==='qwen-desktop')return target.type==='webview'&&url.protocol==='https:'&&url.hostname==='chat.qwen.ai';
    if(provider==='doubao')return target.type==='page'&&['doubao:','chrome:'].includes(url.protocol)&&url.hostname==='doubao-chat'&&/^\/chat(?:\/|$)/u.test(url.pathname);
    if(provider==='grok-bot')return target.type==='page'&&url.protocol==='file:'&&/\/resources\/app\.asar\/dist\/renderer\/index\.html$/i.test(url.pathname);
  }catch{}
  return false;
}
async function discoverDesktop(endpoint,provider,{fetchImpl=fetch,timeoutMs=3000}={}){
  const url=localEndpoint(endpoint);
  let response;
  try{response=await fetchImpl(new URL('/json/list',url),{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch(cause){
    const client={'qwen-desktop':'Qwen',doubao:'豆包','grok-bot':'Grok Bot'}[provider]||'客户端';
    const error=new RoomError(`未能连接 ${client} 的本机接口。请在接入窗口点击“开启客户端连接”；若客户端已在运行，请先从菜单或托盘完整退出后再开启。原聊天和 MCP 配置保留。`,503,'desktop_bridge_unavailable');error.cause=cause;throw error;
  }
  if(!response.ok)throw new RoomError('桌面对话连接尚未开启。',503,'desktop_bridge_unavailable');
  const targets=await response.json();
  if(!Array.isArray(targets)||targets.length>200)throw new RoomError('桌面对话列表无效。',502,'desktop_target_invalid');
  const matches=targets.filter(target=>targetMatches(target,provider));
  if(matches.length!==1){const error=new RoomError(matches.length?'发现多个桌面对话宿主，请选择对应应用实例。':'没有找到这个应用的原生对话宿主。',409,'desktop_target_ambiguous');if(!matches.length)error.retryable=true;throw error;}
  const target=matches[0];let socket;try{socket=new URL(target.webSocketDebuggerUrl);}catch{throw new RoomError('桌面对话通道无效。',502,'desktop_target_invalid');}
  if(socket.protocol!=='ws:'||!LOOPBACK.has(socket.hostname)||socket.port!==url.port||socket.username||socket.password)throw new RoomError('桌面对话通道不属于已选择的本机端口。',403,'desktop_target_invalid');
  return {id:target.id,provider,url:target.url,socket:socket.href};
}
class DesktopTransport extends EventEmitter{
  constructor(target,{WebSocketImpl=WebSocket,timeoutMs=15000}={}){super();this.target=target;this.WebSocketImpl=WebSocketImpl;this.timeoutMs=timeoutMs;this.pending=new Map();this.sequence=0;this.closed=false;}
  async connect(){
    this.socket=new this.WebSocketImpl(this.target.socket);
    this.socket.addEventListener('message',event=>{
      let message;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message.id===undefined){this.emit('notification',message);return;}
      const wait=this.pending.get(message.id);if(!wait)return;this.pending.delete(message.id);clearTimeout(wait.timer);
      if(message.error)wait.reject(new RoomError('桌面对话请求未被宿主接受。',502,'desktop_rpc_error'));else wait.resolve(message.result);
    });
    this.socket.addEventListener('close',()=>{this.closed=true;this.rejectPending('桌面对话连接已断开，需核对原消息结果。');this.emit('disconnected');});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();reject(new RoomError('桌面对话连接超时。',504,'desktop_bridge_unavailable'));},this.timeoutMs);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      this.socket.addEventListener('error',()=>{clearTimeout(timer);this.close();reject(new RoomError('桌面对话连接失败。',503,'desktop_bridge_unavailable'));},{once:true});
    });return this;
  }
  rejectPending(message){for(const wait of this.pending.values()){clearTimeout(wait.timer);wait.reject(new RoomError(message,503,'desktop_request_uncertain'));}this.pending.clear();}
  send(method,params={},timeoutMs=this.timeoutMs){
    if(this.closed||this.socket?.readyState!==this.WebSocketImpl.OPEN)return Promise.reject(new RoomError('桌面对话连接未开启。',503,'desktop_connection_lost'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new RoomError('桌面对话请求超时，未自动重发。',504,'desktop_request_uncertain'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}));}catch{clearTimeout(timer);this.pending.delete(id);reject(new RoomError('桌面对话请求结果待核对。',503,'desktop_request_uncertain'));}
    });
  }
  async evaluate(expression,timeoutMs){
    const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeoutMs);
    if(result.exceptionDetails){const match=String(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'').match(/\b(?:QWEN|DOUBAO|GROK)_NATIVE_[A-Z0-9_]{1,100}\b/);throw new RoomError('原生桌面对话接口不兼容'+(match?`（${match[0]}）`:'')+'。',502,'desktop_contract_mismatch');}
    return result.result?.value;
  }
  close(){this.closed=true;this.rejectPending('桌面对话连接已关闭，原消息结果待核对。');this.socket?.close();}
}
module.exports={localEndpoint,targetMatches,discoverDesktop,DesktopTransport};
