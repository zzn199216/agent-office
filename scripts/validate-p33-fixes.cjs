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
cases.drafts=async f=>{
  const {page,room,other,members}=f,select=async r=>{await page.locator('#rooms [data-room="'+r.id+'"]').click();await page.waitForFunction(id=>history?.room?.id===id, r.id);};
  await f.api('/api/room/features',{room_id:other.id,work_layout:true,canvas:true});await f.features({work_layout:true,canvas:true});await select(room);await page.locator('#recipient').selectOption(members[1].id);await page.locator('#prompt').fill('房间一尚未发送的草稿');await page.locator('#image-input').setInputFiles({name:'draft.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(__dirname,'../web/assets/office/pixel-avatar-codex.png'))});await page.locator('#image-drafts .image-draft').waitFor();
  await select(other);assert.equal(await page.locator('#prompt').inputValue(),'','A different room starts with its own empty draft');assert.equal(await page.locator('#image-drafts .image-draft').count(),0);await page.locator('#recipient').selectOption(members[2].id);await page.locator('#prompt').fill('房间二独立的草稿');
  await select(room);assert.equal(await page.locator('#prompt').inputValue(),'房间一尚未发送的草稿');assert.equal(await page.locator('#recipient').inputValue(),members[1].id);assert.equal(await page.locator('#image-drafts .image-draft').count(),1);await page.locator('#send-button').click();await page.waitForFunction(()=>!submitting&&document.getElementById('prompt').value==='');assert.equal(await page.locator('#image-drafts .image-draft').count(),0);
  await select(other);assert.equal(await page.locator('#prompt').inputValue(),'房间二独立的草稿');assert.equal(await page.locator('#recipient').inputValue(),members[2].id);await select(room);assert.equal(await page.locator('#prompt').inputValue(),'');
  let release,done;const held=new Promise(resolve=>release=resolve),handled=new Promise(resolve=>done=resolve),pattern='**/api/chat/messages',hold=async route=>{if(route.request().postDataJSON().text==='发送途中切房间'){await held;await route.continue();done();}else await route.continue();};await page.route(pattern,hold);await page.locator('#prompt').fill('发送途中切房间');const posted=page.waitForRequest(r=>r.url().endsWith('/api/chat/messages')&&r.postDataJSON().text==='发送途中切房间');await page.locator('#send-button').click();await posted;
  try{await select(other);await page.locator('#prompt').fill('新房间后来输入的草稿');}finally{release();await handled;await page.unroute(pattern,hold);}await page.waitForFunction(()=>!submitting);assert.equal(await page.locator('#prompt').inputValue(),'新房间后来输入的草稿');await select(room);assert.equal(await page.locator('#prompt').inputValue(),'');
};
cases.claims=async f=>{
  const {service,page,room,members:[a,b,c]}=f;await f.features({discussion:true,claims:true,work_layout:true,canvas:true});
  service.group.options.triage=async(_member,input)=>{const value=JSON.parse(input.prompt);if(value.round===1)return {first_step:'先验证自己的部分',missing:'独立来源'};if(value.round===2)return {choice:'让甲来',owner_id:a.id,helper_scope:''};return {owner_id:a.id,kind:'task',uncertain:true,proposals:[{member_id:b.id,first_step:'乙的建议',nomination:a.id},{member_id:c.id,first_step:'丙的预测',nomination:a.id}]};};
  const message=await f.api('/api/chat/messages',{room_id:room.id,text:'认领必须等待实际意见',idempotency_key:id()}),card=page.locator('[data-group-card="'+message.id+'"]');await card.locator('.group-claims summary').click();await card.locator('[data-group-listen="'+b.id+'"]').click();await card.locator('[data-group-decision="resolve_claims"]').waitFor();assert.equal(service.group.get(message.id).status,'needs_user');assert.equal(service.store.db.prepare("SELECT count(*) n FROM group_calls WHERE room_id=? AND purpose='claim_decision'").get(room.id).n,0);assert.equal(await card.locator('[data-group-listen="'+c.id+'"]').count(),1);
  await card.locator('[data-group-decision="resolve_claims"]').click();await page.waitForFunction(id=>history.group.routes.find(r=>r.message_id===id)?.status==='review',message.id);assert.match(service.group.get(message.id).reason,/按 乙 的认领决定/);assert.equal(await card.locator('[data-group-listen]').count(),0);const count=service.group.today(room.id),response=await f.context.request.post(f.base+'/api/group/claim',{data:{room_id:room.id,message_id:message.id,member_id:c.id}});assert.equal(response.status(),409);assert.equal(service.group.today(room.id),count);
};
cases.images=async f=>{
  const requests=[];f.page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/assets/'))requests.push(request.url());});
  for(const canvas of [false,true]){
    await f.features({work_layout:canvas,canvas});if(canvas){await f.page.locator('[data-canvas-expand]').click();await f.page.waitForFunction(()=>officeScene.getMetrics().bitmap_count>=5);}
    await f.page.waitForFunction(()=>[...document.images].every(img=>img.complete));await sleep(150);await f.page.evaluate(()=>window.__stableAvatar=document.querySelector('#room-members img'));requests.length=0;
    for(let i=0;i<5;i++)await f.page.evaluate(()=>refreshAfterMutation());await sleep(100);assert.deepEqual(requests,[],'Five status refreshes must not request public images in '+(canvas?'Canvas':'legacy')+' mode');assert.equal(await f.page.evaluate(()=>window.__stableAvatar===document.querySelector('#room-members img')),true,'Unchanged avatars retain their DOM node');
  }
  const response=await f.context.request.get(f.base+'/assets/office/atlas-body.png'),tag=response.headers().etag;assert.ok(tag);assert.equal((await f.context.request.get(f.base+'/assets/office/atlas-body.png',{headers:{'If-None-Match':tag}})).status(),304);assert.equal((await f.context.request.get(f.base+'/')).headers()['cache-control'],'no-store');assert.equal((await f.context.request.get(f.base+'/api/state')).headers()['cache-control'],'no-store');
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
    context.on('request',request=>{if(!request.url().startsWith(base+'/')&&!request.url().startsWith('data:'))external.push(request.url());});
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
