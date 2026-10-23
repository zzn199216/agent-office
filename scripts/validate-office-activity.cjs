'use strict';
// Disposable service and headless browser; no personal clients or model calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,now}=require('../src/util.cjs');
const {playwright,outputDirectory}=require('./browser-validation.cjs');
(async()=>{
  const files=fixture(),out=outputDirectory('office-activity'),proof={isolated:true,real_clients_or_models:false,checks:{},screenshots:[]},errors=[],codex=new FakeCodex();
  fs.mkdirSync(out,{recursive:true});let service,server,browser,page;
  try{
    service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{throw Error('No upstream calls');}});clearInterval(service.team.timer);
    const project=service.addProject({name:'办公室进展与灯光隔离验收',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'夜间办公室'}),other=service.chat.addRoom({project_id:project.id,title:'另一间办公室'});
    const member=service.chat.addMember({name:'Codex',adapter:'mailbox'});service.chat.join(room.id,member.id);service.chat.join(other.id,member.id);service.chat.store.updateMember(member.id,{status:'ready',verified_at:now()});
    service.runtime.heartbeat(member.id,{ttl_ms:300000});service.runtime.workerHeartbeat('fixture-worker',{member_id:member.id,pid:process.pid,ttl_ms:300000});
    const question=service.chat.store.post({room_id:room.id,sender_id:'user',to_member_id:member.id,text:'隔离测试：检查成员连接',idempotency_key:'fixture-question'});
    service.chat.store.updateMessage(question.id,{status:'processing'});service.chat.progress.set(question.id,'正在检查成员的连接状态');service.office.set({room_id:room.id,time_mode:'night'});
    const token=id();server=createServer(service,{port:0,token});const base='http://127.0.0.1:'+await server.listen();service._localUrl=base;
    browser=await playwright.chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
    await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
    await context.addInitScript(({project,room})=>{localStorage.setItem('agentroom-project',project);localStorage.setItem('agentroom-chat-room',room);localStorage.setItem('agentoffice-room-view','office');},{project:project.id,room:room.id});
    page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/#token='+token);await page.evaluate(()=>{closeSecretaryTutorial();document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());});
    await page.locator('#office-view-button').click();const seat=page.locator('.ao-seat').first(),bubble=seat.locator('.ao-bubble');
    await page.waitForFunction(()=>document.querySelector('.ao-scene')?.dataset.phase==='night');await bubble.waitFor({state:'visible'});
    assert.match(await bubble.textContent(),/工作进展.*正在检查成员的连接状态/);assert.equal(await seat.locator('.ao-work-indicator').evaluate(el=>getComputedStyle(el).display),'none');proof.checks.actual_progress_above_member=true;
    const shade=()=>page.locator('.ao-floor').evaluate(el=>Number(getComputedStyle(el,'::after').opacity));assert.equal(await shade(),0);assert.equal(await page.locator('.ao-scene').getAttribute('data-lights'),'on');proof.checks.night_default_lit=true;
    await page.waitForFunction(()=>[...document.querySelectorAll('.ao-scene img')].filter(img=>img.getAttribute('src')).every(img=>img.complete&&img.naturalWidth>0));
    const shot=async name=>{await page.screenshot({path:path.join(out,name),animations:'disabled'});proof.screenshots.push(name);};await shot('night-lit.png');
    await page.getByRole('button',{name:'关闭办公室灯光',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ao-scene')?.dataset.lights==='off');assert.ok(await shade()>.5);assert.equal(service.office.get(room.id).lights_on,false);assert.equal(service.office.get(other.id).lights_on,true);proof.checks.lights_off_scoped_and_saved=true;await shot('night-lights-off.png');
    await page.reload();await page.locator('.ao-scene[data-lights="off"]').waitFor();assert.ok(await shade()>.5);proof.checks.light_mode_survives_reload=true;
    await page.getByRole('button',{name:'打开办公室灯光',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ao-scene')?.dataset.lights==='on');
    service.chat.progress.set(question.id,'已找到连接入口，正在核对可用工具');service.changed();await page.waitForFunction(()=>document.querySelector('.ao-bubble-text')?.textContent==='已找到连接入口，正在核对可用工具');proof.checks.progress_updates_without_reload=true;
    await bubble.click();await page.locator('#chat-stream').waitFor({state:'visible'});assert.equal(await page.locator('#message-'+question.id).count(),1);proof.checks.progress_opens_original_task=true;await page.locator('#office-view-button').click();
    await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.ao-floor').getBoundingClientRect().top>=document.querySelector('.ao-toolbar-right').getBoundingClientRect().bottom);
    assert.ok(await page.locator('.ao-seats').evaluate(el=>Number(getComputedStyle(el).zIndex)>Number(getComputedStyle(document.querySelector('.ao-plant')).zIndex)));await shot('mobile-progress.png');assert.ok(await page.locator('.ao-light-switch').isVisible());proof.checks.mobile_no_overflow=true;
    service.chat.store.updateMessage(question.id,{status:'answered'});service.chat.progress.delete(question.id);service.chat.store.post({room_id:room.id,sender_id:member.id,text:'连接检查完成',kind:'reply',reply_to:question.id,idempotency_key:'fixture-reply'});service.changed();await page.waitForFunction(()=>document.querySelector('.ao-bubble-text')?.textContent==='连接检查完成');assert.equal(await seat.evaluate(el=>el.classList.contains('ao-has-progress')),false);proof.checks.completion_clears_progress=true;
    await server.close();server=null;await service.close();service=null;await page.waitForFunction(()=>document.querySelector('.ao-scene')?.classList.contains('ao-offline-room'));assert.equal(await bubble.isVisible(),false);assert.equal(await page.locator('.ao-light-switch').isDisabled(),true);proof.checks.disconnect_hides_activity=true;
    assert.equal(codex.calls.length,0);assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{await browser?.close();await server?.close();await service?.close();proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));const owned=path.resolve(files.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});console.log(JSON.stringify(proof));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
