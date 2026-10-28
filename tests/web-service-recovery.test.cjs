'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),bridgeSource=fs.readFileSync(path.join(__dirname,'../web/desktop.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(options={}){
  const elements=new Map(),calls=[],notices=[];let checks=0,refreshes=0,schedules=0;
  function element(){const classes=new Set(),children=new Map();return {textContent:'',disabled:false,open:false,dataset:{},classList:{toggle(name,enabled){if(enabled===undefined)enabled=!classes.has(name);if(enabled)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},querySelector(selector){if(!children.has(selector))children.set(selector,element());return children.get(selector);},close(){this.open=false;},showModal(){this.open=true;}};}
  const $=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},footer=element();
  const context=vm.createContext({$,document:{querySelectorAll:()=>[],querySelector:()=>footer},Promise,Error,AbortSignal,
    roomId:'saved-room',managedRoomId:'saved-room',managingRoom:false,desktopState:null,desktopBusy:false,desktopReady:false,desktopProbe:null,desktopOperation:null,desktopError:'',desktopErrorSource:null,
    state:{version:'fixture',chat:{rooms:[{id:'saved-room',title:'保存房间'}],members:[],activeMessages:[]},activeSetup:{},approvals:[],activeRequest:null},webConnected:false,authRenewal:null,
    desktop:{offline:true,command:async(operation,values)=>{calls.push({operation,values});return options.command?options.command(operation,values,++checks):{running:false,busy:{is_busy:false},snapshot:{version:'fixture'}};}},
    setWebConnected(value){context.webConnected=value;},renderRuntime(){},renderLaunch(){},renderInspector(){},renderSecretary(){},updateOfficeScene(){},renderResume(){},events:{close(){}},
    toast:value=>notices.push(value),refresh:async()=>{refreshes++;},scheduleRefresh:()=>{schedules++;},fetch:async()=>{throw Error('Unexpected network request');}
  });
  vm.runInContext(section('async function api(', 'function toast(')+section('function checkDesktopTransport(', 'function memberById(')+
    section('function showRoomActions(', 'async function toggleRoomArchive(')+section('function currentServiceBusy()', 'function applyInspector()'),context);
  return {context,$,calls,notices,get refreshes(){return refreshes;},get schedules(){return schedules;}};
}

test('first native state failure remains visible and enables read-only recovery without starting a service',async()=>{
  const f=fixture({command:async(_operation,_values,count)=>{if(count===1)throw Object.assign(Error('无法读取本机状态：启动记录不可用'),{code:'fixture_state_failed'});return {running:false,busy:{is_busy:false},snapshot:{}};}});
  assert.equal(await f.context.checkDesktopTransport({initial:true}),null);assert.equal(f.context.desktopReady,false);assert.equal(f.context.desktopBusy,false);
  assert.equal(f.$('service-toggle').disabled,false);assert.equal(f.$('service-toggle').textContent,'重新检查状态');assert.equal(f.$('service-check').disabled,false);
  assert.match(f.$('service-error').textContent,/启动记录不可用/);assert.equal(f.$('service-error').classList.contains('hidden'),false);assert.equal(f.$('room-actions-service-error').textContent,f.$('service-error').textContent);
  assert.equal(Object.keys(f.calls[0].values).length,0);await f.context.checkServiceState();assert.equal(f.context.desktopReady,true);assert.equal(f.context.desktopError,'');assert.equal(f.refreshes,1);
  assert.deepEqual(f.calls.map(call=>call.operation),['state','state']);assert.equal(f.$('service-toggle').textContent,'开启服务');
});
test('concurrent status checks coalesce and never queue duplicate native operations',async()=>{
  const gate=deferred(),f=fixture({command:()=>gate.promise}),first=f.context.checkDesktopTransport(),second=f.context.checkDesktopTransport();assert.equal(first,second);
  await Promise.resolve();assert.equal(f.calls.length,1);assert.equal(f.$('service-check').disabled,true);assert.equal(f.$('service-toggle').disabled,true);
  gate.resolve({running:false,busy:{is_busy:false}});await first;assert.equal(f.context.desktopProbe,null);assert.equal(f.$('service-check').disabled,false);assert.equal(f.calls[0].operation,'state');
});
test('host auto-update service_error remains visible in offline status and room management',async()=>{
  const f=fixture({command:async()=>({running:false,busy:{is_busy:false},service_error:'原服务启动失败：包装进程已超时',service_error_code:'desktop_operation_timeout'})});
  await f.context.checkDesktopTransport({initial:true});
  assert.equal(f.context.desktopReady,true);assert.equal(f.$('service-toggle').disabled,false);
  assert.equal(f.$('service-error').textContent,'原服务启动失败：包装进程已超时');
  assert.equal(f.$('room-actions-service-error').textContent,f.$('service-error').textContent);
  assert.equal(f.$('service-error').classList.contains('hidden'),false);
  assert.deepEqual(f.calls.map(call=>call.operation),['state']);
});
test('startup result service_error preserves the actual host failure and never announces success',async()=>{
  const f=fixture({command:async()=>({running:false,service_error:'原安装入口校验失败',service_error_code:'runtime_install_invalid'})});f.context.desktopReady=true;
  await assert.rejects(f.context.changeService('start_service'),error=>error.code==='runtime_install_invalid'&&error.message==='原安装入口校验失败');
  assert.equal(f.$('service-error').textContent,'原安装入口校验失败');assert.equal(f.context.desktopBusy,false);
  assert.equal(f.$('service-toggle').disabled,false);assert.equal(f.notices.length,0);assert.equal(f.calls.length,1);
});
test('service startup shows its own phase and retains failure in the service card and room management',async()=>{
  const gate=deferred(),f=fixture({command:operation=>operation==='start_service'?gate.promise:Promise.resolve({running:false,busy:{is_busy:false}})});f.context.desktopReady=true;
  const work=f.context.changeService('start_service');assert.equal(f.context.desktopOperation,'starting');assert.equal(f.$('service-label').textContent,'正在开启服务…');assert.equal(f.$('room-actions-start').disabled,true);
  gate.reject(Object.assign(Error('启动失败：旧服务记录所属进程已变化'),{code:'fixture_owner_mismatch'}));await assert.rejects(work,/所属进程已变化/);
  assert.equal(f.context.desktopBusy,false);assert.equal(f.context.desktopOperation,null);assert.equal(f.$('service-toggle').disabled,false);assert.equal(f.$('room-actions-start').disabled,false);
  assert.match(f.$('service-error').textContent,/所属进程已变化/);assert.equal(f.$('room-actions-service-error').textContent,f.$('service-error').textContent);
  assert.equal(f.$('room-actions-archive').disabled,true);assert.equal(f.$('room-actions-delete').disabled,true);assert.equal(f.notices.length,0);
  await f.context.checkDesktopTransport();assert.match(f.context.desktopError,/所属进程已变化/,'an offline observation does not erase the startup cause');assert.deepEqual(f.calls.map(call=>call.operation),['start_service','state']);
});
test('a startup response that is still offline cannot announce success or enable room mutation',async()=>{
  const f=fixture();f.context.desktopReady=true;await assert.rejects(f.context.changeService('start_service'),error=>error.code==='desktop_start_unconfirmed');
  assert.match(f.$('service-error').textContent,/尚未启动成功/);assert.equal(f.notices.length,0);assert.equal(f.context.desktopBusy,false);assert.equal(f.$('room-actions-delete').disabled,true);assert.equal(f.calls.length,1);
});
test('a failed or disconnected status observation keeps the original startup cause visible',async()=>{
  const f=fixture({command:async()=>{throw Error('状态检查也超时');}});f.context.desktopReady=true;f.context.desktopError='服务启动失败：原进程记录已过期';f.context.desktopErrorSource='start_service';
  await f.context.checkDesktopTransport();assert.equal(f.context.desktopError,'服务启动失败：原进程记录已过期');
  f.context.desktop.command=async()=>({running:false,connection_error:'暂时无法联系本机服务'});await f.context.checkDesktopTransport();assert.match(f.$('service-error').textContent,/原进程记录已过期/);assert.equal(f.$('room-actions-service-error').textContent,f.$('service-error').textContent);
});
test('stop and update phases remain accurate and errors do not silently change online state',async()=>{
  const stop=deferred(),f=fixture({command:()=>stop.promise});f.context.desktopReady=true;f.context.webConnected=true;f.context.desktopState={running:true};
  const work=f.context.changeService('stop_service');assert.equal(f.$('service-label').textContent,'正在关闭服务…');stop.reject(Error('仍有实际任务正在运行'));await assert.rejects(work,/实际任务/);
  assert.equal(f.context.webConnected,true);assert.equal(f.$('room-actions-delete').disabled,false);assert.match(f.$('service-error').textContent,/实际任务/);
  const update=deferred();f.context.desktop.command=async operation=>{f.calls.push({operation});return update.promise;};f.context.desktopState={running:true,update_available:true,snapshot:{version:'old'},client_version:'new',busy:{is_busy:true}};f.context.renderService();
  assert.equal(f.$('service-toggle').disabled,false,'latest idle HTTP snapshot supersedes old cached busy');const upgrading=f.context.changeService('start_service');assert.equal(f.$('service-label').textContent,'正在更新服务…');
  update.resolve({running:true,update_available:true});await assert.rejects(upgrading,error=>error.code==='desktop_update_incomplete');assert.match(f.$('service-error').textContent,/旧版本/);
});
test('busy observation follows latest online state and ignores offline saved connecting members',()=>{
  const f=fixture();f.context.webConnected=true;f.context.desktopState={running:true,busy:{is_busy:true}};assert.equal(f.context.currentServiceBusy(),false);
  f.context.state.chat.activeMessages=['actual-message'];assert.equal(f.context.currentServiceBusy(),true);
  f.context.webConnected=false;f.context.desktopState={running:false,busy:{is_busy:false}};f.context.state.chat.members=[{status:'connecting'}];assert.equal(f.context.currentServiceBusy(),false);
  f.context.desktopState={running:true,busy:{is_busy:true}};assert.equal(f.context.currentServiceBusy(),true,'a currently observed running old service can still block an unsafe update');
});
test('successful startup clears errors and schedules an online observation instead of replaying an operation',async()=>{
  const f=fixture({command:async()=>({running:true,update_available:false})});f.context.desktop.offline=false;f.context.desktopReady=true;f.context.desktopError='earlier failure';f.context.desktopErrorSource='start_service';
  await f.context.changeService('start_service');assert.equal(f.context.desktopError,'');assert.equal(f.context.desktopBusy,false);assert.equal(f.schedules,1);assert.deepEqual(f.calls.map(call=>call.operation),['start_service']);assert.equal(f.notices[0],'协作服务已开启。');
});
test('bounded read failures include response-body timeouts and do not retry a network request',async()=>{
  for(const body of [false,true]){const f=fixture(),requests=[];f.context.desktop=null;f.context.webConnected=true;f.context.fetch=async(route,options)=>{requests.push({route,options});const error=Object.assign(Error('timeout'),{name:'TimeoutError'});if(!body)throw error;return {ok:true,status:200,json:async()=>{throw error;}};};
    await assert.rejects(f.context.api('/api/state'),error=>error.code==='local_read_timeout'&&/没有重发/.test(error.message));assert.equal(requests.length,1);assert.ok(requests[0].options.signal);assert.equal(f.calls.length,0);
  }
});
test('a render exception after a successful service read must not mark the service disconnected',async()=>{
  const f=fixture(),failure=new TypeError("Cannot read properties of null (reading 'room_id')");
  Object.assign(f.context,{viewTimers:{active:true},refreshing:false,refreshAgain:false,refreshWaiters:[],projectId:null,roomId:null,legacyId:null,secretaryNavigation:null,
    api:async()=>({projects:[],chat:{rooms:[],members:[]},runtime:{}}),rememberSelection(){},renderSidebar(){throw failure;}});
  f.context.desktop.offline=false;
  vm.runInContext(section('async function refresh()','function scheduleRefresh()'),f.context);
  await assert.rejects(f.context.refresh(),error=>error===failure);
  assert.equal(f.context.webConnected,true,'a UI exception is not evidence that HTTP disconnected');
  assert.doesNotMatch(f.$('footer-status').textContent,/未连接/);assert.equal(f.context.refreshing,false);
});
test('refresh still marks actual transport failures and read timeouts disconnected',async()=>{
  for(const failure of [Error('Failed to fetch'),Object.assign(Error('read timeout'),{code:'local_read_timeout'})]){
    const f=fixture();Object.assign(f.context,{viewTimers:{active:true},refreshing:false,refreshAgain:false,refreshWaiters:[],webConnected:true,api:async()=>{throw failure;}});
    vm.runInContext(section('async function refresh()','function scheduleRefresh()'),f.context);
    await assert.rejects(f.context.refresh(),error=>error===failure);assert.equal(f.context.webConnected,false);assert.match(f.$('footer-status').textContent,/未连接/);
  }
});
test('business POST has no observation deadline or automatic replay after a transport failure',async()=>{
  const f=fixture(),requests=[];f.context.desktop=null;f.context.webConnected=true;f.context.fetch=async(route,options)=>{requests.push({route,options});throw Error('Failed to fetch');};
  await assert.rejects(f.context.api('/api/chat/messages',{text:'single original message'}),/Failed to fetch/);assert.equal(requests.length,1);assert.equal(requests[0].options.signal,undefined);assert.equal(f.calls.length,0);
});
test('only an explicit authentication rejection permits the original POST to be retried once',async()=>{
  const f=fixture(),requests=[];f.context.desktop=null;f.context.webConnected=true;f.context.fetch=async(route,options)=>{requests.push({route,options});if(route==='/')return {ok:true,status:200};const count=requests.filter(item=>item.route===route).length;return {ok:count>1,status:count===1?401:202,json:async()=>({id:'same-logical-message'})};};
  const result=await f.context.api('/api/chat/messages',{idempotency_key:'original-stable-key'});assert.equal(result.id,'same-logical-message');assert.deepEqual(requests.map(item=>item.route),['/api/chat/messages','/','/api/chat/messages']);assert.equal(requests[0].options.body,requests[2].options.body);
});

function bridgeFixture({throws=false}={}){const sent=[],listeners=[],timers=new Map();let timerId=0;const window={chrome:{webview:{postMessage:value=>{if(throws)throw Error('bridge disappeared');sent.push(value);},addEventListener:(_,listener)=>listeners.push(listener)}}};
  vm.runInNewContext(bridgeSource,{window,location:{hostname:'agentroom.local'},document:{body:{classList:{add(){}}}},setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id)});
  return {window,sent,timers,reply:value=>listeners.forEach(listener=>listener({data:value}))};}
test('desktop bridge retains typed host failures and cleans synchronous transport failures',async()=>{
  const f=bridgeFixture(),work=f.window.AgentRoomDesktop.command('start_service');f.reply({source:'agentroom-desktop',type:'desktop-result',id:f.sent[0].id,error:{message:'原启动记录所有者已变化',code:'daemon_owner_changed'}});
  await assert.rejects(work,error=>error.code==='daemon_owner_changed');assert.equal(f.timers.size,0);
  const broken=bridgeFixture({throws:true});await assert.rejects(broken.window.AgentRoomDesktop.command('state'),error=>error.code==='desktop_bridge_unavailable');assert.equal(broken.timers.size,0);
});
test('unconfirmed desktop operations use a typed timeout and late replies cannot dispatch or settle a replacement',async()=>{
  const f=bridgeFixture(),work=f.window.AgentRoomDesktop.command('start_service'),expired=f.sent[0];[...f.timers.values()][0]();await assert.rejects(work,error=>error.code==='desktop_bridge_timeout');
  f.reply({source:'agentroom-desktop',type:'desktop-result',id:expired.id,result:{running:true}});assert.equal(f.sent.length,1,'a timeout never retries the operation');
});
