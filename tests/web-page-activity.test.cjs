'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {create}=require('../web/page-activity.js');
function target(){const listeners=new Map();return {listeners,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);},emit(type,event={}){for(const fn of [...listeners.get(type)||[]])fn(event);},count(type){return listeners.get(type)?.size||0;}};}
function fakeClock(){let now=0,next=0;const entries=new Map(),clock={entries,setTimeout(fn,delay=0){const id=++next;entries.set(id,{fn,due:now+Math.max(0,delay),interval:null});return id;},setInterval(fn,delay=0){const id=++next;entries.set(id,{fn,due:now+Math.max(1,delay),interval:Math.max(1,delay)});return id;},clearTimeout(id){entries.delete(id);},clearInterval(id){entries.delete(id);},advance(ms){const end=now+ms;let calls=0;for(;;){let selected;for(const [id,entry]of entries)if(entry.due<=end&&(!selected||entry.due<selected[1].due))selected=[id,entry];if(!selected)break;assert.ok(++calls<10000,'Fixture timer burst');const [id,entry]=selected;now=entry.due;if(entry.interval===null)entries.delete(id);else entry.due+=entry.interval;entry.fn();}now=end;}};return clock;}
function fixture({hidden=false}={}){const document={...target(),hidden},host=target(),clock=fakeClock(),changes=[],page=create({document,host,clock,onChange:value=>changes.push(value)});return {document,host,clock,changes,page,hide(){host.emit('agentoffice-visibility',{detail:{visible:false}});},show(){host.emit('agentoffice-visibility',{detail:{visible:true}});},documentVisible(value){document.hidden=!value;document.emit('visibilitychange');}};}
test('native minimize clears UI timers even while the document still reports visible',()=>{
  const f=fixture(),calls=[];f.page.setTimeout(()=>calls.push('old timeout'),500);f.page.setInterval(()=>calls.push('interval'),100);assert.equal(f.clock.entries.size,2);
  f.hide();assert.equal(f.document.hidden,false);assert.equal(f.page.active,false);assert.equal(f.clock.entries.size,0);f.clock.advance(100000);assert.deepEqual(calls,[]);assert.deepEqual(f.changes,[false]);
});
test('resume requires both document and host visibility and duplicate events are coalesced',()=>{
  const f=fixture();f.hide();f.documentVisible(false);f.show();assert.equal(f.page.active,false);assert.deepEqual(f.changes,[false]);f.documentVisible(true);assert.equal(f.page.active,true);f.show();f.documentVisible(true);assert.deepEqual(f.changes,[false,true]);
  f.documentVisible(false);f.show();assert.equal(f.page.active,false);f.documentVisible(true);assert.deepEqual(f.changes,[false,true,false,true]);
});
test('intervals resume from a new delay without replaying missed ticks or dropped one-shot work',()=>{
  const f=fixture(),calls=[];f.page.setInterval(()=>calls.push('tick'),100);f.page.setTimeout(()=>calls.push('expired one-shot'),500);f.clock.advance(50);f.hide();f.clock.advance(100000);f.show();assert.deepEqual(calls,[]);f.clock.advance(99);assert.deepEqual(calls,[]);f.clock.advance(1);assert.deepEqual(calls,['tick']);f.clock.advance(100);assert.deepEqual(calls,['tick','tick']);
});
test('new hidden one-shots are discarded while newly registered intervals wait for visibility',()=>{
  const f=fixture({hidden:true}),calls=[];const timeout=f.page.setTimeout(()=>calls.push('late one-shot'),5);f.page.clearTimeout(timeout);f.page.setInterval(()=>calls.push('interval'),10);f.clock.advance(1000);assert.deepEqual(calls,[]);f.documentVisible(true);f.clock.advance(10);assert.deepEqual(calls,['interval']);
});
test('cleared intervals cannot return on the next resume and callback arguments are retained',()=>{
  const f=fixture(),calls=[];const interval=f.page.setInterval((a,b)=>calls.push([a,b]),10,'first','second');f.clock.advance(10);assert.deepEqual(calls,[['first','second']]);f.hide();f.page.clearTimeout(interval);f.show();f.clock.advance(100);assert.equal(calls.length,1);
  f.page.setTimeout((...args)=>calls.push(args),1,1,2);f.clock.advance(1);assert.deepEqual(calls[1],[1,2]);
});
test('UI suspension leaves unrelated native deadlines intact',()=>{
  const f=fixture(),calls=[];f.clock.setTimeout(()=>calls.push('native deadline'),45000);f.page.setTimeout(()=>calls.push('ui one-shot'),10);f.page.setInterval(()=>calls.push('ui interval'),100);f.hide();assert.equal(f.clock.entries.size,1);f.clock.advance(45000);assert.deepEqual(calls,['native deadline']);
});
test('invalid host events do not change visibility or clear timers',()=>{
  const f=fixture();f.page.setTimeout(()=>{},100);for(const event of [{},{detail:{}},{detail:{visible:'false'}},{detail:{visible:null}}])f.host.emit('agentoffice-visibility',event);assert.equal(f.page.active,true);assert.equal(f.clock.entries.size,1);assert.deepEqual(f.changes,[]);
});
test('destroy removes timers and listeners and cannot be resumed or schedule future work',()=>{
  const f=fixture();f.page.setInterval(()=>assert.fail('Destroyed interval ran'),10);f.page.destroy();assert.equal(f.page.active,false);assert.equal(f.clock.entries.size,0);assert.equal(f.document.count('visibilitychange'),0);assert.equal(f.host.count('agentoffice-visibility'),0);f.page.destroy();f.show();f.documentVisible(true);f.page.setTimeout(()=>assert.fail('Destroyed timeout ran'),1);f.page.setInterval(()=>assert.fail('Destroyed interval registered'),1);f.clock.advance(100);assert.deepEqual(f.changes,[false]);
});
function bridgeFixture(){
  const clock=fakeClock(),host=target(),messages=target(),sent=[],document={...target(),hidden:false,body:{classList:{add(){}}}},context={...host,document,location:{hostname:'agentroom.local'},Object,Map,Error,Date,console,AgentOfficePageActivity:{create},handleViewActivity(){},chrome:{webview:{postMessage:value=>sent.push(value),addEventListener:messages.addEventListener.bind(messages)}}};
  context.setTimeout=clock.setTimeout.bind(clock);context.clearTimeout=clock.clearTimeout.bind(clock);context.setInterval=clock.setInterval.bind(clock);context.clearInterval=clock.clearInterval.bind(clock);context.window=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/desktop.js'),'utf8'),context);
  const app=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),end=app.indexOf('const $');assert.ok(end>0);vm.runInContext(app.slice(0,end),context);
  return {clock,host:context,messages,sent,context};
}
test('real desktop bridge loaded before app UI timer aliases keeps its 45 second deadline while minimized',async()=>{
  const f=bridgeFixture(),work=f.context.AgentRoomDesktop.command('state'),rejected=assert.rejects(work,error=>error.code==='desktop_bridge_timeout');vm.runInContext('viewTimers.setTimeout(()=>{throw Error("Hidden UI work ran");},10)',f.context);
  f.host.emit('agentoffice-visibility',{detail:{visible:false}});assert.equal(f.clock.entries.size,1);f.clock.advance(45000);await rejected;assert.equal(f.sent.length,1);
});
test('real desktop reply while minimized clears only its native deadline and resolves the original operation',async()=>{
  const f=bridgeFixture(),work=f.context.AgentRoomDesktop.command('state');f.host.emit('agentoffice-visibility',{detail:{visible:false}});f.messages.emit('message',{data:{source:'agentroom-desktop',type:'desktop-result',id:f.sent[0].id,result:{running:true}}});assert.equal((await work).running,true);assert.equal(f.clock.entries.size,0);f.clock.advance(45000);assert.equal(f.sent.length,1);
});
function appFixture({offline=false}={}){
  const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),start=source.indexOf('function connectEvents('),end=source.indexOf('if (desktop) action(',start);assert.ok(start>0&&end>start);
  const streams=[],events=[],actions=[],footer={textContent:''},context={viewTimers:{active:true},desktop:{offline,command(){assert.fail('Visibility must not start or stop service');}},document:{hidden:false,body:{classList:{toggle:(name,value)=>events.push(['class',name,value])}}},officeScene:{setSuspended:value=>events.push(['scene',value])},events:null,refreshAgain:true,launchAgain:true,grokSetupWatch:null,webConnected:true,EventSource:class{constructor(url){this.url=url;this.handlers={};this.closed=false;streams.push(this);}addEventListener(name,callback){this.handlers[name]=callback;}close(){this.closed=true;}},scheduleRefresh:()=>events.push('schedule'),setWebConnected:value=>events.push(['connected',value]),checkDesktopTransport:()=>events.push('check'),$:()=>footer,setUIInterval:()=>1,setUITimeout:()=>1,setInterval:()=>1,setTimeout:()=>1,updatePhase:()=>events.push('phase'),tickOnboardingElapsed:()=>events.push('elapsed'),refresh:async()=>events.push('refresh'),pollGrokSetup:async()=>events.push('watch'),action:callback=>{const result=callback();actions.push(result);return result;}};vm.createContext(context);vm.runInContext(source.slice(start,end),context);return {context,streams,events,actions};
}
test('app suspension closes its event stream and restoring opens one stream with one refresh',async()=>{
  const f=appFixture(),original=f.streams[0];assert.equal(f.streams.length,1);f.context.viewTimers.active=false;f.context.handleViewActivity(false);assert.equal(original.closed,true);assert.equal(f.context.events,null);assert.equal(f.context.refreshAgain,false);assert.equal(f.context.launchAgain,false);original.onerror();assert.equal(f.events.includes('check'),false);f.context.connectEvents();assert.equal(f.streams.length,1);
  f.context.viewTimers.active=true;f.context.grokSetupWatch={};f.context.handleViewActivity(true);await Promise.all(f.actions);assert.equal(f.streams.length,2);f.streams[1].onopen();assert.equal(f.events.filter(event=>event==='refresh').length,1);assert.equal(f.events.filter(event=>event==='watch').length,1);assert.equal(f.events.filter(event=>event==='schedule').length,0,'resume stream open must not duplicate the explicit refresh');assert.deepEqual(f.events.filter(event=>Array.isArray(event)&&event[0]==='scene'),[['scene',true],['scene',false]]);
});
test('offline visibility changes refresh saved history without starting a service or opening an event stream',async()=>{
  const f=appFixture({offline:true});assert.equal(f.streams.length,0);f.context.viewTimers.active=false;f.context.handleViewActivity(false);f.context.viewTimers.active=true;f.context.handleViewActivity(true);await Promise.all(f.actions);assert.equal(f.streams.length,0);assert.equal(f.events.filter(event=>event==='refresh').length,1);assert.equal(f.events.includes('check'),false);
});
