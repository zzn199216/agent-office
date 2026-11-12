'use strict';
// External clients are fixtures; all UI and HTTP paths are the shipped product.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,sleep}=require('../src/util.cjs'),{playwright,outputDirectory}=require('./browser-validation.cjs');
const cases={};
cases.layout=async f=>{
  await f.features({work_layout:true,canvas:true});
  for(const [width,height]of [[1440,900],[1280,720],[1024,600]])for(const expand of [false,true]){
    await f.page.setViewportSize({width,height});const toggle=f.page.locator('[data-canvas-expand]');if((await toggle.getAttribute('aria-expanded')==='true')!==expand)await toggle.click();await sleep(220);
    const size=await f.page.evaluate(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};return {height:innerHeight,prompt:rect('prompt'),send:rect('send-button'),chat:rect('chat-stream'),room:rect('room'),office:rect('officeScene'),expanded:document.querySelector('[data-canvas-expand]').getAttribute('aria-expanded')==='true'};});
    assert.ok(size.prompt.bottom<=height&&size.send.bottom<=height,'Composer must fit '+JSON.stringify({width,expand,...size}));assert.ok(size.chat.height>=160,'Conversation must retain 160px '+JSON.stringify(size));if(size.expanded)assert.ok(size.office.height<=size.room.height/2+2,'Expanded office must share the available space');await f.shot('layout-'+width+'x'+height+'-'+(expand?'expanded':'collapsed')+'.png');
  }
};

async function main(){
  const files=fixture(),out=outputDirectory('p33-fixes'),proof={ok:false,isolated:true,real_clients_or_models:false,checks:{},cases:[],screenshots:[]};fs.mkdirSync(out,{recursive:true});
  let service,server,browser,page,base;const token=id(),errors=[],external=[];
  const forbidden=async()=>{throw Error('No personal clients, model calls or installers in acceptance fixes');};
  try{
    service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:forbidden,chat:{clientFactory:()=>{const client=new FakeCodex(),run=client.run.bind(client);client.run=async input=>({...await run(input),answer:'独立夹具已完成本条检查'});return client;}},launch:{discover:()=>({candidates:[]}),installer:forbidden},onboarding:{replyVerification:false,desktopConnector:forbidden,runtimeInstaller:forbidden}});
    const project=service.addProject({path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'验收修复房间一'}),other=service.chat.addRoom({project_id:project.id,title:'验收修复房间二'}),members=[];
    for(const name of ['甲','乙','丙']){const m=service.chat.store.addMember({name,adapter:'codex'});for(const r of [room,other])service.chat.store.join(r.id,m.id);service.chat.store.updateMember(m.id,{status:'ready',verified_at:new Date().toISOString()});service.runtime.workerHeartbeat('fixture:'+m.id,{member_id:m.id});service.runtime.heartbeat(m.id,{session_ref:'fixture:'+m.id});members.push(m);}
    server=createServer(service,{port:0,token});base='http://127.0.0.1:'+await server.listen();service._localUrl=base;
    const api=async(route,input)=>{const r=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const value=await r.json();assert.ok(r.ok,route+': '+value.error);return value;};
    browser=await playwright.chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:900},timezoneId:'Asia/Taipei',reducedMotion:'no-preference'});
    await context.route('**/*',route=>{if(route.request().url().startsWith(base+'/'))return route.continue();external.push(route.request().url());return route.abort();});
    await context.addInitScript(({project,room})=>{localStorage.setItem('agentroom-project',project);localStorage.setItem('agentroom-chat-room',room);localStorage.setItem('agentoffice-room-view','office');},{project:project.id,room:room.id});page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.waitForFunction(id=>history?.room?.id===id,room.id);
    const shot=async name=>{await page.screenshot({path:path.join(out,name)});proof.screenshots.push(name);};
    const f={files,out,service,page,context,api,project,room,other,members,base,shot,features:async patch=>{await api('/api/room/features',{room_id:room.id,...patch});await page.waitForFunction(patch=>Object.entries(patch).every(([key,value])=>state.features[roomId][key]===value),patch);}};
    const selected=process.argv.includes('--case')?process.argv[process.argv.indexOf('--case')+1].split(','):Object.keys(cases);
    for(const name of selected){assert.ok(cases[name],'Unknown check '+name);try{await cases[name](f);proof.checks[name]=true;proof.cases.push({name,status:'passed'});console.log('PASS '+name);}catch(error){proof.checks[name]=false;proof.cases.push({name,status:'failed',error:error.message});throw error;}}
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{await browser?.close();await server?.close();await service?.close();proof.page_errors=errors;proof.external_request_count=external.length;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));const owned=path.resolve(files.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});console.log(JSON.stringify({ok:proof.ok,error:proof.error,result:path.join(out,'result.json')}));}
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={cases};
