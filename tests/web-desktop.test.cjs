'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/desktop.js'),'utf8');
function fixture(hostname='agentroom.local',enabled=true){
  const sent=[],listeners=[],classes=[],timers=new Map();let timerId=0;
  const window=enabled?{chrome:{webview:{postMessage:value=>sent.push(value),addEventListener:(_,listener)=>listeners.push(listener)}}}:{};
  vm.runInNewContext(source,{window,location:{hostname},document:{body:{classList:{add:value=>classes.push(value)}}},setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id)});
  return {window,sent,listeners,classes,timers,reply:message=>listeners.forEach(listener=>listener({data:message}))};
}
test('desktop bridge is absent from ordinary browsers and foreign origins',()=>{
  for(const item of [fixture('127.0.0.1',false),fixture('foreign.example')]){assert.equal(item.window.AgentRoomDesktop,undefined);assert.equal(item.sent.length,0);assert.equal(item.listeners.length,0);}
});
test('desktop bridge does not start or stop anything on initialization',()=>{
  const item=fixture();assert.equal(item.window.AgentRoomDesktop.offline,true);assert.equal(Object.isFrozen(item.window.AgentRoomDesktop),true);assert.equal(item.sent.length,0);assert.deepEqual(item.classes,['desktop-app']);
  assert.equal(fixture('127.0.0.1').window.AgentRoomDesktop.offline,false);
});
test('desktop command fields are limited and only matching host replies settle requests',async()=>{
  const item=fixture(),request=item.window.AgentRoomDesktop.command('state',{room_id:'room-fixture',operation:'stop_service',command:'private.exe',token:'never-forward'}),message=item.sent[0];
  assert.deepEqual(Object.keys(message).sort(),['id','operation','room_id','source','type']);assert.equal(message.operation,'state');assert.equal(message.room_id,'room-fixture');
  let resolved=false;request.then(()=>resolved=true);
  item.reply({source:'other',type:'desktop-result',id:message.id,result:{running:true}});item.reply({source:'agentroom-desktop',type:'desktop-result',id:'unmatched',result:{running:true}});await Promise.resolve();assert.equal(resolved,false);
  item.reply({source:'agentroom-desktop',type:'desktop-result',id:message.id,result:{running:false,snapshot:{}}});assert.equal((await request).running,false);assert.equal(item.timers.size,0);
});
test('desktop bridge rejects unsupported actions and reports failed or unconfirmed operations',async()=>{
  const item=fixture();await assert.rejects(item.window.AgentRoomDesktop.command('run_shell'),/不支持/);assert.equal(item.sent.length,0);
  const denied=item.window.AgentRoomDesktop.command('stop_service'),message=item.sent[0];item.reply({source:'agentroom-desktop',type:'desktop-result',id:message.id,error:{message:'服务有工作进行中'}});await assert.rejects(denied,/工作进行中/);
  const missing=item.window.AgentRoomDesktop.command('start_service');[...item.timers.values()][0]();await assert.rejects(missing,/未确认/);
});
