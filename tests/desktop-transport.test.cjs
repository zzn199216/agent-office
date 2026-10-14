'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {localEndpoint,targetMatches,discoverDesktop,DesktopTransport}=require('../src/desktop-transport.cjs');

const endpoint='http://127.0.0.1:19245';
const target={id:'qwen-native-target',type:'webview',url:'https://chat.qwen.ai/',webSocketDebuggerUrl:'ws://127.0.0.1:19245/devtools/page/qwen-native-target'};
function fetchFixture(targets,status=200,calls=[]){return async(url,options)=>{calls.push({url:String(url),options});return {ok:status>=200&&status<300,status,json:async()=>targets};};}
function fakeSocketClass({autoOpen=true,throwSend=false}={}) {
  class FakeWebSocket extends EventTarget {
    static OPEN=1;static instances=[];
    constructor(url){super();this.url=url;this.readyState=0;this.requests=[];FakeWebSocket.instances.push(this);if(autoOpen)queueMicrotask(()=>this.open());}
    open(){if(this.readyState!==0)return;this.readyState=1;this.dispatchEvent(new Event('open'));}
    send(value){if(throwSend)throw Error('fixture send interrupted');this.requests.push(JSON.parse(value));}
    message(value){const event=new Event('message');event.data=typeof value==='string'?value:JSON.stringify(value);this.dispatchEvent(event);}
    respond(id,result){this.message({id,result});}
    fail(){this.dispatchEvent(new Event('error'));}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  return FakeWebSocket;
}
async function connected(options={}){const WebSocketImpl=fakeSocketClass(options),transport=new DesktopTransport({socket:target.webSocketDebuggerUrl},{WebSocketImpl,timeoutMs:100});await transport.connect();return {transport,socket:WebSocketImpl.instances[0]};}

test('endpoint accepts only credential-free loopback HTTP origins',()=>{
  for(const url of [endpoint,'http://localhost:19245/','http://[::1]:19245/'])assert.ok(localEndpoint(url));
  for(const url of ['https://127.0.0.1:19245','http://192.168.1.8:19245','http://127.0.0.1.example.com:19245','http://user:password@127.0.0.1:19245','http://127.0.0.1:19245/json','http://127.0.0.1:19245/?token=fixture','http://127.0.0.1:19245/#hash','not a URL'])assert.throws(()=>localEndpoint(url),{code:'desktop_endpoint_invalid'});
});

test('native identity does not substitute Qwen browser pages, CLI or another provider',()=>{
  assert.equal(targetMatches(target,'qwen-desktop'),true);
  assert.equal(targetMatches({...target,type:'page'},'qwen-desktop'),false);
  assert.equal(targetMatches({...target,url:'https://chat.qwen.ai.attacker.invalid/'},'qwen-desktop'),false);
  assert.equal(targetMatches({...target,url:'https://qwen-code.local/'},'qwen-desktop'),false);
  assert.equal(targetMatches(target,'qwen-code'),false);
  assert.equal(targetMatches(target,'doubao'),false);
  assert.equal(targetMatches({type:'page',url:'doubao://doubao-chat/chat/own'},'doubao'),true);
  assert.equal(targetMatches({type:'page',url:'https://www.doubao.com/chat/'},'doubao'),false);
  assert.equal(targetMatches({type:'page',url:'file:///C:/Grok/resources/app.asar/dist/renderer/index.html'},'grok-bot'),true);
  assert.equal(targetMatches({type:'page',url:'https://grok.com/'},'grok-bot'),false);
});

test('discovery keeps the single provider-native target and never follows redirects',async()=>{
  const calls=[];const chosen=await discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture([{...target,id:'browser-page',type:'page'},target],200,calls)});
  assert.equal(chosen.id,target.id);assert.equal(chosen.socket,target.webSocketDebuggerUrl);assert.equal(calls.length,1);assert.equal(calls[0].url,endpoint+'/json/list');assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('discovery rejects ambiguous, absent, oversized and malformed target lists',async()=>{
  await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture([target,{...target,id:'other'}])}),{code:'desktop_target_ambiguous'});
  await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture([{...target,type:'page'}])}),{code:'desktop_target_ambiguous'});
  await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture(Array.from({length:201},()=>target))}),{code:'desktop_target_invalid'});
  await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture({targets:[target]})}),{code:'desktop_target_invalid'});
  await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture([],503)}),{code:'desktop_bridge_unavailable'});
});

test('discovery refuses debugger sockets outside the selected loopback port',async()=>{
  for(const socket of ['ws://192.168.1.8:19245/devtools/page/x','ws://127.0.0.1:19246/devtools/page/x','wss://127.0.0.1:19245/devtools/page/x','ws://fixture:secret@127.0.0.1:19245/devtools/page/x','invalid'])await assert.rejects(discoverDesktop(endpoint,'qwen-desktop',{fetchImpl:fetchFixture([{...target,webSocketDebuggerUrl:socket}])}),{code:'desktop_target_invalid'});
});

test('CDP evaluation correlates out-of-order replies to exact request IDs',async t=>{
  const {transport,socket}=await connected();t.after(()=>transport.close());
  const one=transport.evaluate('fixture-one'),two=transport.evaluate('fixture-two');assert.equal(socket.requests.length,2);assert.equal(socket.requests[0].params.awaitPromise,true);assert.equal(socket.requests[0].params.returnByValue,true);
  socket.respond(socket.requests[1].id,{result:{value:'second result'}});socket.respond(socket.requests[0].id,{result:{value:'first result'}});
  assert.deepEqual(await Promise.all([one,two]),['first result','second result']);assert.equal(transport.pending.size,0);
});

test('notifications, malformed frames, stale and duplicate responses cannot settle a current call',async t=>{
  const {transport,socket}=await connected();t.after(()=>transport.close());const notifications=[];transport.on('notification',message=>notifications.push(message));
  const answer=transport.evaluate('current');socket.message('not JSON');socket.message({method:'Runtime.consoleAPICalled',params:{fixture:true}});socket.respond(999,{result:{value:'foreign'}});
  assert.equal(transport.pending.size,1);assert.equal(notifications.length,1);socket.respond(socket.requests[0].id,{result:{value:'owned'}});assert.equal(await answer,'owned');socket.respond(socket.requests[0].id,{result:{value:'duplicate'}});assert.equal(transport.pending.size,0);
});

test('a timed-out submission is uncertain and is never resent or settled by a late response',async t=>{
  const {transport,socket}=await connected();t.after(()=>transport.close());const promise=transport.evaluate('one prompt only',15);const id=socket.requests[0].id;
  await assert.rejects(promise,{code:'desktop_request_uncertain'});assert.equal(socket.requests.length,1);assert.equal(transport.pending.size,0);socket.respond(id,{result:{value:'too late'}});assert.equal(socket.requests.length,1);assert.equal(transport.pending.size,0);
});

test('disconnect rejects every pending request and disables further transport sends',async()=>{
  const {transport,socket}=await connected();const first=transport.evaluate('a'),second=transport.evaluate('b');const rejected=Promise.allSettled([first,second]);let disconnected=0;transport.on('disconnected',()=>disconnected++);socket.close();
  const results=await rejected;assert.ok(results.every(result=>result.status==='rejected'&&result.reason.code==='desktop_request_uncertain'));assert.equal(transport.pending.size,0);assert.equal(disconnected,1);assert.equal(transport.closed,true);await assert.rejects(transport.evaluate('cannot send after disconnect'),{code:'desktop_connection_lost'});assert.equal(socket.requests.length,2);
});

test('an explicit close rejects pending work as uncertain and does not send a cancellation to another turn',async()=>{
  const {transport,socket}=await connected();const pending=transport.evaluate('owned in-flight');const rejected=assert.rejects(pending,{code:'desktop_request_uncertain'});transport.close();await rejected;assert.equal(socket.requests.length,1);assert.equal(transport.pending.size,0);
});

test('RPC errors and native exception frames never count as a successful model result',async t=>{
  const {transport,socket}=await connected();t.after(()=>transport.close());
  const rpc=transport.evaluate('rpc fixture');socket.message({id:socket.requests.at(-1).id,error:{message:'private fixture diagnostic must not leak'}});await assert.rejects(rpc,error=>error.code==='desktop_rpc_error'&&!error.message.includes('private fixture'));
  const native=transport.evaluate('native fixture');socket.respond(socket.requests.at(-1).id,{exceptionDetails:{text:'private account payload',exception:{description:'private fixture token'}}});await assert.rejects(native,error=>error.code==='desktop_contract_mismatch'&&!error.message.includes('private'));
});

test('a synchronous socket send failure remains uncertain with no retry',async t=>{
  const {transport,socket}=await connected({throwSend:true});t.after(()=>transport.close());await assert.rejects(transport.evaluate('fixture'),{code:'desktop_request_uncertain'});assert.equal(transport.pending.size,0);assert.equal(socket.requests.length,0);
});

test('connection error and timeout terminate unavailable sockets without starting any RPC',async()=>{
  for(const action of ['error','timeout']){
    const WebSocketImpl=fakeSocketClass({autoOpen:false}),transport=new DesktopTransport({socket:target.webSocketDebuggerUrl},{WebSocketImpl,timeoutMs:15}),connecting=transport.connect(),socket=WebSocketImpl.instances[0];
    if(action==='error')socket.fail();await assert.rejects(connecting,{code:'desktop_bridge_unavailable'});assert.equal(transport.closed,true);assert.equal(socket.requests.length,0);
  }
});
