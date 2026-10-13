'use strict';
// A disposable real service + browser. No user windows, adapters or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id}=require('../src/util.cjs');
const ROOT=path.resolve(__dirname,'..'),OUTPUT=path.join(ROOT,'output','playwright','office-modular');
function playwright(){
  for(const location of [process.env.AGENTOFFICE_PLAYWRIGHT,'playwright',path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)){
    try{return require(location);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
  }
  throw new Error('Playwright runtime unavailable. Set AGENTOFFICE_PLAYWRIGHT to the installed module path.');
}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function main(){
  fs.mkdirSync(OUTPUT,{recursive:true});
  const files=fixture(),codex=new FakeCodex(),proof={ok:false,isolated:true,started_at:new Date().toISOString(),checks:{},screenshots:[],fixture:files.root};
  let service,server,browser,context,page,releaseSave;
  const errors=[],external=[],mutations=[];
  try{
    service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{throw new Error('Office validation prohibits upstream HTTP.');}});
    const project=service.addProject({name:'可调 Agent 办公室验证',path:files.project}),first=service.chat.addRoom({title:'设计工作室',project_id:project.id}),second=service.chat.addRoom({title:'另一间办公室',project_id:project.id});
    const names=['Codex','Claude','Qwen','Grok','Cursor','豆包','Nova','Echo','Mimo'];
    const members=names.map((name,index)=>{
      const member=service.chat.addMember({name,adapter:'mailbox'});
      for(const room of [first,second])service.chat.join(room.id,member.id);
      service.appearance.set({member_id:member.id,preset:'auto',furniture:[1,7].includes(index)?'beanbag':'desk',scale:index===1?1.1:1});
      return member;
    });
    service.chat.store.post({room_id:first.id,sender_id:'user',text:'这里显示同一个房间的真实本机记录。',idempotency_key:'office-modular-user'});
    service.chat.store.post({room_id:first.id,sender_id:members[1].id,text:'在懒人沙发上聊，也能共用同一份聊天记录。',idempotency_key:'office-modular-member'});
    const token=id();server=createServer(service,{port:0,token});const port=await server.listen(),base='http://127.0.0.1:'+port;
    proof.port=port;proof.rooms=[first.id,second.id];proof.members=members.map(member=>member.id);
    const chromium=playwright().chromium,browserPaths=[process.env.AGENTOFFICE_BROWSER,chromium.executablePath(),process.platform==='win32'&&path.join(process.env.ProgramFiles||'C:/Program Files','Google','Chrome','Application','chrome.exe'),process.platform==='win32'&&path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft','Edge','Application','msedge.exe')].filter(Boolean),executablePath=browserPaths.find(location=>fs.existsSync(location));
    if(!executablePath)throw new Error('No local Chromium browser found. Set AGENTOFFICE_BROWSER to its executable.');
    proof.browser_executable=executablePath;
    browser=await chromium.launch({headless:true,executablePath});context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Taipei',reducedMotion:'no-preference'});
    await context.route('**/*',async route=>{
      const url=route.request().url();if(url.startsWith(base+'/'))return route.continue();external.push(url);return route.abort('blockedbyclient');
    });
    await context.addInitScript(({projectId,roomId})=>{localStorage.setItem('agentroom-project',projectId);localStorage.setItem('agentroom-chat-room',roomId);localStorage.setItem('agentoffice-room-view','chat');}, {projectId:project.id,roomId:first.id});
    page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='POST')mutations.push({url:new URL(request.url()).pathname,input:request.postDataJSON()});});
    await page.clock.install({time:new Date('2026-10-13T04:05:00Z')});
    const api=async(route,input)=>{
      const response=await context.request[ input===undefined?'get':'post' ](base+route,{headers:{Authorization:'Bearer '+token},...(input===undefined?{}:{data:input})});
      assert.equal(response.status(),200,'Real fixture API rejected '+route);return response.json();
    };
    const roomConfig=room=>api('/api/office?room_id='+room.id);
    const screenshot=async name=>{await page.screenshot({path:path.join(OUTPUT,name),fullPage:true,animations:'disabled'});proof.screenshots.push(name);};
    const waitRoom=async room=>{
      await page.waitForFunction(title=>document.getElementById('discussion-heading').textContent===title,room.title);
      await page.waitForFunction(roomId=>document.querySelector('.ao-scene')?.dataset.roomId===roomId&&document.querySelector('.room-button.active')?.dataset.room===roomId,room.id);
      await page.waitForFunction(()=>document.querySelectorAll('.ao-seat').length===9);
    };
    const selectRoom=async room=>{if(await page.locator('#inspector-close').isVisible())await page.locator('#inspector-close').click();await page.locator(`[data-room="${room.id}"]`).click();await waitRoom(room);await openScene();};
    const openScene=async()=>{if(!await page.locator('#room-inspector').isVisible())await page.locator('.ao-scene-settings').click();await page.locator('[data-inspector-tab="scene"]').click();await page.locator('#scene-form').waitFor({state:'visible'});};
    const setRange=(selector,value)=>page.locator(selector).evaluate((element,value)=>{element.value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));},value);
    const saveScene=async()=>{
      const responsePromise=page.waitForResponse(response=>response.url()===base+'/api/office'&&response.request().method()==='POST');
      await page.locator('#scene-save').click();const response=await responsePromise;assert.equal(response.status(),200);const value=await response.json();
      await page.waitForFunction(()=>document.getElementById('scene-status').textContent==='场景已保存在本机。');return value;
    };
    const imageInventory=()=>page.evaluate(()=>Array.from(document.querySelectorAll('.ao-scene img')).filter(image=>image.getAttribute('src')).map(image=>({source:image.getAttribute('src').startsWith('data:')?'local-data-image':image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0,width:image.naturalWidth})));
    const assertImages=async()=>{await page.waitForFunction(()=>Array.from(document.querySelectorAll('.ao-scene img')).filter(image=>image.getAttribute('src')).every(image=>image.complete&&image.naturalWidth>0));const result=await imageInventory();assert.ok(result.length>=20);assert.ok(result.every(image=>image.loaded));return result;};
    const overflow=()=>page.evaluate(()=>{const scroll=document.querySelector('.ao-scroll');return{window:innerWidth,body:document.body.scrollWidth,document:document.documentElement.scrollWidth,office:scroll.clientWidth,officeContent:scroll.scrollWidth};});
    await page.goto(base+'/',{waitUntil:'domcontentloaded'});await page.locator('#chat-view-button').waitFor({state:'visible'});
    assert.equal(await page.locator('#chat-stream').isVisible(),true);await page.locator('#office-view-button').click();await waitRoom(first);
    assert.equal(await page.locator('.ao-seat[data-furniture="beanbag"]').count(),2);proof.checks.text_office_switch=true;proof.checks.nine_incremental_seats=true;proof.checks.desk_and_beanbag=true;
    proof.images=await assertImages();proof.desktop_overflow=await overflow();assert.ok(proof.desktop_overflow.document<=proof.desktop_overflow.window+1);assert.ok(proof.desktop_overflow.officeContent<=proof.desktop_overflow.office+1);
    await openScene();await page.locator('#scene-time-zone').fill('Asia/Taipei');await page.locator('#scene-time-mode').selectOption('day');const day=await saveScene();assert.equal(day.time_mode,'day');assert.equal((await roomConfig(first)).time_zone,'Asia/Taipei');
    await page.waitForFunction(()=>document.querySelector('.ao-scene')?.dataset.phase==='day');assert.equal(await page.locator('.ao-clock-time').textContent(),'12:05');assert.equal(await page.locator('.ao-clock-zone').textContent(),'Asia/Taipei');proof.checks.real_day_save=true;proof.checks.timezone_clock=true;
    await screenshot('settings.png');await page.locator('#inspector-close').click();await screenshot('daytime.png');await screenshot('beanbag.png');
    await openScene();await page.locator('#scene-time-mode').selectOption('night');await saveScene();await page.waitForFunction(()=>document.querySelector('.ao-scene')?.dataset.phase==='night');assert.equal((await roomConfig(first)).time_mode,'night');proof.checks.real_night_save=true;
    await page.locator('#inspector-close').click();await screenshot('nighttime.png');await openScene();
    // Each room owns its own dirty presentation draft; periodic state refresh cannot overwrite it.
    await page.locator('#scene-auto-layout').uncheck();await page.locator('#scene-columns').selectOption('2');await setRange('#scene-spacing',1.25);await page.locator('#scene-time-zone').fill('UTC');
    await selectRoom(second);assert.equal(await page.locator('#scene-columns').inputValue(),'3');assert.equal(await page.locator('#scene-time-zone').inputValue(),'auto');await page.locator('#scene-auto-layout').uncheck();await page.locator('#scene-columns').selectOption('1');
    await selectRoom(first);assert.equal(await page.locator('#scene-columns').inputValue(),'2');assert.equal(await page.locator('#scene-spacing').inputValue(),'1.25');assert.equal(await page.locator('#scene-time-zone').inputValue(),'UTC');
    await page.evaluate(()=>refresh());assert.equal(await page.locator('#scene-columns').inputValue(),'2');await saveScene();assert.equal((await roomConfig(first)).columns,2);assert.equal((await roomConfig(second)).columns,3);proof.checks.room_isolated_dirty_drafts=true;
    // Hold the actual POST until after navigation. Only the original room may be written.
    await page.locator('#scene-columns').selectOption('3');await page.locator('#scene-time-mode').selectOption('day');
    const gated=deferred(),saveSeen=deferred();releaseSave=gated.resolve;
    const holdSave=async route=>{if(route.request().method()==='POST'){saveSeen.resolve(route.request().postDataJSON());await gated.promise;}await route.continue();};
    await page.route('**/api/office',holdSave);await page.locator('#scene-save').click();const sent=await saveSeen.promise;assert.equal(sent.room_id,first.id);
    await selectRoom(second);assert.equal(await page.locator('#scene-columns').inputValue(),'1');
    const savedResponse=page.waitForResponse(response=>response.url()===base+'/api/office'&&response.request().method()==='POST');gated.resolve();const lateResponse=await savedResponse;assert.equal(lateResponse.status(),200);
    await page.waitForFunction(()=>document.getElementById('scene-columns').value==='1');assert.equal((await roomConfig(first)).columns,3);assert.equal((await roomConfig(second)).columns,3);assert.equal(await page.locator('#scene-columns').inputValue(),'1');await page.unroute('**/api/office',holdSave);releaseSave=null;proof.checks.save_navigation_safe=true;
    // Create a real raster fixture in the browser, then pause bitmap decoding while navigating.
    const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=96;canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle='#c99773';ctx.beginPath();ctx.roundRect(14,10,68,78,24);ctx.fill();ctx.fillStyle='#203830';ctx.fillRect(34,38,7,8);ctx.fillRect(57,38,7,8);return canvas.toDataURL('image/png');});
    const payload={name:'local-character-fixture.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')};
    await selectRoom(first);await page.evaluate(()=>{window.__officeBitmapOriginal=createImageBitmap.bind(window);window.__officeBitmapGate=new Promise(resolve=>window.__officeBitmapRelease=resolve);window.createImageBitmap=async function(...args){await window.__officeBitmapGate;return window.__officeBitmapOriginal(...args);};});
    await page.locator('#scene-background_data').setInputFiles(payload);await page.waitForFunction(()=>document.getElementById('scene-status').textContent==='正在处理本机图片…');await selectRoom(second);
    await page.evaluate(()=>window.__officeBitmapRelease());await page.waitForFunction(()=>document.getElementById('scene-background_data-note').textContent==='使用内置素材');assert.equal((await roomConfig(second)).background_data,undefined);
    await selectRoom(first);await page.waitForFunction(()=>document.getElementById('scene-background_data-note').textContent==='已选择本机素材');assert.equal((await roomConfig(first)).background_data,undefined);await saveScene();assert.ok((await roomConfig(first)).background_data.startsWith('data:image/png;base64,'));assert.equal((await roomConfig(second)).background_data,undefined);await page.evaluate(()=>window.createImageBitmap=window.__officeBitmapOriginal);proof.checks.upload_navigation_safe=true;
    await page.locator('[data-clear-scene-asset="background_data"]').click();await saveScene();assert.equal((await roomConfig(first)).background_data,undefined);proof.checks.asset_clear=true;
    // A complete uploaded character is the entire figure, with no provider logo covering its face.
    await page.locator('[data-inspector-tab="appearance"]').click();await page.locator('#appearance-member').selectOption(members[0].id);await page.locator('#appearance-character').setInputFiles(payload);
    await page.waitForFunction(()=>document.getElementById('appearance-status').textContent==='图片已准备，点击保存外观生效。');await page.locator('#appearance-furniture').selectOption('beanbag');await setRange('#appearance-scale',1.1);
    const appearanceResponse=page.waitForResponse(response=>response.url()===base+'/api/appearance'&&response.request().method()==='POST');await page.locator('#appearance-save').click();assert.equal((await appearanceResponse).status(),200);
    const look=await api('/api/appearance?member_id='+members[0].id);assert.equal(look.furniture,'beanbag');assert.equal(look.scale,1.1);assert.ok(look.character_data.startsWith('data:image/png;base64,'));
    await page.waitForFunction(memberId=>{const seat=document.querySelector(`.ao-seat[data-member-id="${memberId}"]`),image=seat?.querySelector('.ao-custom-character');return seat?.classList.contains('ao-custom-body')&&image?.complete&&image.naturalWidth>0;},members[0].id);
    const face=await page.locator(`.ao-seat[data-member-id="${members[0].id}"]`).evaluate(seat=>{const head=seat.querySelector('.ao-head'),styles=getComputedStyle(head),rect=head.getBoundingClientRect(),figure=seat.querySelector('.ao-custom-character').getBoundingClientRect(),overlapWidth=Math.max(0,Math.min(rect.right,figure.right)-Math.max(rect.left,figure.left)),overlapHeight=Math.max(0,Math.min(rect.bottom,figure.bottom)-Math.max(rect.top,figure.top));return{display:styles.display,visibility:styles.visibility,opacity:styles.opacity,width:rect.width,height:rect.height,overlapArea:overlapWidth*overlapHeight};});
    assert.ok(face.display==='none'||face.visibility==='hidden'||face.opacity==='0'||face.width===0||face.height===0||face.overlapArea<=1,'Provider badge must not cover a complete custom character.');proof.checks.complete_character_no_logo_overlay=true;proof.custom_character_badge=face;
    await openScene();await page.locator('#scene-time-zone').fill('Asia/Taipei');await page.locator('#scene-motion').uncheck();await saveScene();await page.waitForFunction(()=>document.querySelector('.ao-scene')?.classList.contains('ao-still'));
    const cloudState=()=>page.locator('.ao-cloud-one').evaluate(element=>({animation:getComputedStyle(element).animationName,playState:getComputedStyle(element).animationPlayState,transform:getComputedStyle(element).transform}));
    let cloud=await cloudState();assert.ok(cloud.animation==='none'||cloud.playState==='paused');const clockBefore=await page.locator('.ao-clock-time').textContent();await page.clock.fastForward(61000);const clockAfter=await page.locator('.ao-clock-time').textContent();assert.notEqual(clockAfter,clockBefore);assert.equal((await cloudState()).transform,cloud.transform);proof.checks.motion_off_clock_continues=true;
    await page.locator('#scene-motion').check();await saveScene();await page.waitForFunction(()=>!document.querySelector('.ao-scene')?.classList.contains('ao-still'));cloud=await cloudState();assert.notEqual(cloud.animation,'none');assert.equal(cloud.playState,'running');
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.ao-scene')?.classList.contains('ao-still'));cloud=await cloudState();assert.ok(cloud.animation==='none'||cloud.playState==='paused');proof.checks.reduced_motion_stops_background=true;
    await page.clock.fastForward(61000);assert.notEqual(await page.locator('.ao-clock-time').textContent(),clockAfter);proof.checks.reduced_motion_clock_continues=true;
    await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('#inspector-close').click();await page.setViewportSize({width:390,height:844});await assertImages();
    proof.mobile_overflow=await overflow();assert.ok(proof.mobile_overflow.document<=391,'390 px page overflow.');assert.ok(proof.mobile_overflow.officeContent<=proof.mobile_overflow.office+1,'390 px office overflow.');await screenshot('mobile.png');proof.checks.mobile_390_no_overflow=true;
    await page.locator('.ao-scene-settings').click();assert.equal(await page.locator('#scene-form').isVisible(),true);assert.ok((await overflow()).document<=391);await screenshot('mobile-settings.png');
    assert.equal(codex.calls.length,0);assert.equal(service.onboarding.jobs.size,0);assert.equal(external.length,0);assert.deepEqual(errors,[]);
    proof.checks.no_upstream_calls=true;proof.checks.no_model_calls=true;proof.checks.no_page_errors=true;proof.checks.actual_api_storage=true;
    proof.request_counts={posts:mutations.length,scene:mutations.filter(item=>item.url==='/api/office').length,appearance:mutations.filter(item=>item.url==='/api/appearance').length};proof.final_scene=await roomConfig(first);
    // A real disconnect pauses environmental motion, retains saved art/settings,
    // and leaves the local clock working. No simulated green connectivity.
    await server.close();server=null;await service.close();service=null;proof.service_closed=true;
    await page.waitForFunction(()=>document.querySelector('.ao-scene')?.classList.contains('ao-offline-room'));
    assert.equal(await page.locator('#scene-save').isDisabled(),true);assert.equal(await page.locator('#scene-time-zone').inputValue(),'Asia/Taipei');
    const offlineClock=await page.locator('.ao-clock-time').textContent();await page.clock.fastForward(61000);assert.notEqual(await page.locator('.ao-clock-time').textContent(),offlineClock);cloud=await cloudState();assert.ok(cloud.animation==='none'||cloud.playState==='paused');proof.checks.real_disconnect_readonly_clock_continues=true;
    assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack||error.message;if(page){try{await page.screenshot({path:path.join(OUTPUT,'failure.png'),fullPage:true,animations:'disabled'});proof.screenshots.push('failure.png');}catch{}}process.exitCode=1;}
  finally{
    releaseSave?.();if(page){try{await page.evaluate(()=>window.__officeBitmapRelease?.());}catch{}}
    try{await browser?.close();proof.browser_closed=true;}catch(error){proof.cleanup_error=error.message;}
    try{await server?.close();await service?.close();proof.service_closed=true;}catch(error){proof.cleanup_error=error.message;}
    // Only the explicitly-created fixture directory can be removed.
    const resolved=path.resolve(files.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);
    try{fs.rmSync(resolved,{recursive:true,force:true});proof.fixture_removed=true;}catch(error){proof.cleanup_error=error.message;}
    if(proof.cleanup_error){proof.ok=false;process.exitCode=1;}proof.ended_at=new Date().toISOString();proof.page_errors=errors;proof.external_requests=external;
    fs.writeFileSync(path.join(OUTPUT,'result.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({ok:proof.ok,checks:proof.checks,screenshots:proof.screenshots,result:path.join(OUTPUT,'result.json'),...(proof.error?{error:proof.error}:{})},null,2));
  }
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
