'use strict';
// End-to-end check of the connection card in a real browser.
// Owned headless browser, temporary data and fixture clients only: no real
// client window, model or personal configuration is touched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,now,VERSION}=require('../src/util.cjs');

const {playwright,outputDirectory}=require('./browser-validation.cjs');

(async()=>{
  const f=fixture(),out=outputDirectory('connection-assist'),proof={isolated:true,real_clients_or_models:false,checks:{}},errors=[];
  fs.mkdirSync(out,{recursive:true});let service,server,browser,page;
  try{
    class Actor extends FakeCodex{constructor(member){super();this.member=member;}async run(input){const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);input.onTurn(id());return {threadId:thread,turnId:id(),answer:'接入进度见接入卡片。'};}}
    const candidates=['doubao','qwen-desktop'].map(provider=>({id:provider,provider,name:provider==='doubao'?'豆包':'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}));
    service=new RoomService(f.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('No external requests');},chat:{clientFactory:member=>new Actor(member)},launch:{discover:()=>({candidates})}});clearInterval(service.team.timer);
    const project=service.addProject({name:'接入流程隔离验收',path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'聊天接入'}),other=service.chat.addRoom({project_id:project.id,title:'其他房间'}),actor=service.chat.addMember({name:'Codex',adapter:'codex'});
    service.chat.join(room.id,actor.id);service.chat.store.updateMember(actor.id,{status:'ready',verified_at:now()});
    const token=id();server=createServer(service,{token,port:0});const base='http://127.0.0.1:'+await server.listen();service._localUrl=base;
    browser=await playwright.chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
    await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
    await context.addInitScript(({project,room})=>{localStorage.setItem('agentroom-project',project);localStorage.setItem('agentroom-chat-room',room);localStorage.setItem('agentoffice-room-view','chat');Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text;}}});},{project:project.id,room:room.id});
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/#token='+token);await page.evaluate(()=>{try{closeSecretaryTutorial();}catch{}document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());});
    assert.equal(await page.locator('#app-version').textContent(),'服务 v'+VERSION);proof.checks.observed_version_visible=true;
    await page.locator('#recipient').selectOption(actor.id);await page.locator('#prompt').fill('把豆包和qwen接入');await page.locator('#send-button').click();
    const card=page.locator('.ao-system-card').first();await card.waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.ao-system-card .connection-panel').length===2);
    // The card belongs to the person's request, labelled Agent Office, not inside the agent's reply.
    const placement=await page.evaluate(()=>{const node=document.querySelector('.ao-system-card');return {previous:node.previousElementSibling?.id||'',insideArticle:!!node.closest('article')};});
    const request=service.chat.store.db.prepare("SELECT id FROM chat_messages WHERE room_id=? AND sender_id='user' ORDER BY seq DESC LIMIT 1").get(room.id);
    assert.equal(placement.previous,'message-'+request.id);assert.equal(placement.insideArticle,false);assert.match(await card.textContent(),/Agent Office/);proof.checks.card_under_request=true;
    // One status line and at most two buttons per member.
    for(const panel of await card.locator('.connection-panel').all())assert.ok(await panel.locator('[data-conn-op]').count()<=2);
    assert.doesNotMatch(await card.textContent(),/保留|沿用|本人对话|握手|没有自动重试/);proof.checks.plain_copy=true;
    await page.screenshot({path:path.join(out,'connection-card.png')});
    // Copy config returns this member's real local MCP address.
    await card.locator('[data-conn-op="copy_config"]').first().click();await page.waitForFunction(()=>typeof window.fixtureClipboard==='string');
    assert.match(await page.evaluate(()=>window.fixtureClipboard),new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/mcp/'));proof.checks.copy_config=true;
    await card.locator('[data-conn-op="copy_handshake_prompt"]').first().click();await page.waitForFunction(()=>/agentroom_chat_inbox/.test(window.fixtureClipboard||''));proof.checks.copy_sentence=true;
    // Narrow screens do not scroll sideways.
    await page.setViewportSize({width:390,height:844});await card.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'connection-card-mobile.png')});proof.checks.mobile_no_overflow=true;
    await page.setViewportSize({width:1440,height:1000});
    // Another room never shows this room's cards.
    await page.locator(`[data-room="${other.id}"]`).click();await page.waitForFunction(()=>document.querySelectorAll('.ao-system-card').length===0);proof.checks.other_room_isolated=true;
    assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{await browser?.close();await server?.close();await service?.close();proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));const owned=path.resolve(f.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});console.log(JSON.stringify(proof));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
