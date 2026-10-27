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
    let releaseReply;const replyGate=new Promise(resolve=>{releaseReply=resolve;});
    class Actor extends FakeCodex{constructor(member){super();this.member=member;}async run(input){const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);input.onTurn(id());await replyGate;return {threadId:thread,turnId:id(),answer:'请在这条回复里的接入卡片继续操作，连接状态会实时更新。'};}}
    const candidates=['doubao','qwen-desktop'].map(provider=>({id:provider,provider,name:provider==='doubao'?'豆包':'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}));
    service=new RoomService(f.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('No external requests');},chat:{clientFactory:member=>new Actor(member)},launch:{discover:()=>({candidates})}});clearInterval(service.team.timer);
    const project=service.addProject({name:'接入流程隔离验收',path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'聊天接入'}),other=service.chat.addRoom({project_id:project.id,title:'其他房间'}),actor=service.chat.addMember({name:'Codex',adapter:'codex'});
    service.chat.join(room.id,actor.id);service.chat.store.updateMember(actor.id,{status:'ready',verified_at:now()});
    const bridge=service.chat.addMember({name:'Grok 验收',adapter:'grok-bridge'});service.chat.join(room.id,bridge.id);
    let bridgeCanNotify=false;const capability=service.chat.deliveryCapability.bind(service.chat);
    service.chat.deliveryCapability=member=>(typeof member==='string'?member:member.id)===bridge.id?{...capability(member),can_notify:bridgeCanNotify,notification_eligible:false}:capability(member);
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
    const request=service.chat.store.db.prepare("SELECT id FROM chat_messages WHERE room_id=? AND sender_id='user' ORDER BY seq DESC LIMIT 1").get(room.id);
    assert.equal(await card.evaluate(node=>node.closest('article')?.id),'message-'+request.id);proof.checks.pending_card_in_request=true;
    releaseReply();await page.waitForFunction(()=>!!document.querySelector('.chat-message:not(.own-message) .message-body .ao-system-card'));
    const reply=service.chat.store.db.prepare("SELECT id FROM chat_messages WHERE reply_to=? AND kind='reply' AND sender_id=? ORDER BY seq LIMIT 1").get(request.id,actor.id);
    assert.equal(await card.evaluate(node=>node.closest('article')?.id),'message-'+reply.id);assert.equal(await page.locator('.ao-system-card').count(),1);
    assert.match(await card.textContent(),/Agent Office · 当前连接状态/);proof.checks.card_inside_reply=true;
    await page.reload();await card.waitFor();assert.equal(await card.evaluate(node=>node.closest('article')?.id),'message-'+reply.id);assert.equal(await page.locator('.ao-system-card').count(),1);proof.checks.reload_preserves_card_owner=true;
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
    await page.locator('#team-open').click();if(!await page.locator('#team-more').evaluate(details=>details.open))await page.locator('#team-more > summary').click();await page.locator('#mirror-open').click();
    await page.locator('#mirror-name').fill('验收手机群');
    await page.locator('#mirror-members input[value="doubao"]').check();
    await page.locator('#mirror-create').click();
    await page.waitForFunction(()=>document.querySelector('#mirror-prompt').textContent.includes('验收手机群'));
    assert.match(await page.locator('#mirror-members-status').textContent(),/自动连接未就绪/);
    const mirror=service.launch.state({room_id:room.id});assert.equal(mirror.group_name,'验收手机群');assert.deepEqual(mirror.selected_providers,['doubao']);
    proof.checks.mirror_explicit_selection=true;
    assert.ok(await page.locator('#mirror-handoff').isHidden());
    assert.match(await page.locator('#mirror-status').textContent(),/接通所选 AI/);
    assert.ok(!mirror.proxies.some(p=>p.native_group_ref));proof.checks.mirror_handoff_not_false_success=true;
    await page.locator('#mirror-check').click();
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE to_member_id=?').get(bridge.id).n,0);
    const proxy=mirror.proxies.find(p=>p.provider==='doubao'),entry=service.entry.issue(proxy.backend_member_id,room.id);
    const call=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));return result;};
    await call('/api/resume/accept',{card:JSON.parse(fs.readFileSync(entry.file,'utf8'))});
    await page.locator('#mirror-check').click();
    await page.locator('#mirror-copy').click();await page.waitForFunction(()=>window.fixtureClipboard.includes('验收手机群'));
    bridgeCanNotify=true;await page.locator('#mirror-check').click();
    await page.waitForFunction(()=>document.querySelector('#mirror-status').textContent.includes('建群请求已发送'));
    await page.locator('#mirror-check').click();
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE to_member_id=?').get(bridge.id).n,1);
    assert.match(await page.locator('#mirror-status').textContent(),/等待实际建群回报/);assert.ok(await page.locator('#mirror-handoff').isHidden());
    proof.checks.mirror_activation_recovers_without_duplicate=true;
    // A later update must be sent even though every selected member joined before.
    await call('/api/launch/report',{session_id:mirror.id,proxy_id:proxy.id,name:proxy.name,bot_ref:'fixture-grok-doubao',group_ref:'fixture-existing-group',joined:true});
    await page.locator('#mirror-check').click();await page.waitForFunction(()=>document.querySelector('#mirror-create').textContent==='更新所选成员');
    await page.locator('#mirror-create').click();
    await page.locator('#mirror-dialog .close-dialog').click();
    await page.waitForFunction(()=>!document.querySelector('#mirror-dialog').open);
    const deadline=Date.now()+10000;
    while(service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE to_member_id=?').get(bridge.id).n<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE to_member_id=?').get(bridge.id).n,2);
    const update=service.launch.state({room_id:room.id});assert.notEqual(update.id,mirror.id);assert.equal(update.group_operation.status,'pending');
    assert.equal(update.proxies.find(p=>p.id===proxy.id).native_group_ref,'fixture-existing-group');proof.checks.mirror_existing_group_updates_in_background=true;
    await page.locator('#team-open').click();if(!await page.locator('#team-more').evaluate(details=>details.open))await page.locator('#team-more > summary').click();await page.locator('#mirror-open').click();await page.waitForFunction(()=>document.querySelector('#mirror-status').textContent.includes('等待实际建群回报'));
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(out,'mirror-mobile.png')});proof.checks.mirror_mobile_no_overflow=true;
    await page.locator('#mirror-dialog .close-dialog').click();await page.setViewportSize({width:1440,height:1000});
    // Another room never shows this room's cards.
    await page.locator(`[data-room="${other.id}"]`).click();await page.waitForFunction(()=>document.querySelectorAll('.ao-system-card').length===0);proof.checks.other_room_isolated=true;
    assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{await browser?.close();await server?.close();await service?.close();proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));const owned=path.resolve(f.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});console.log(JSON.stringify(proof));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
