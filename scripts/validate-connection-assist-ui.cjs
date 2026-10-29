'use strict';
// End-to-end check of the connection card in a real browser.
// Owned headless browser, temporary data and fixture clients only: no real
// client window, model or personal configuration is touched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,now,VERSION}=require('../src/util.cjs');

const {playwright,outputDirectory}=require('./browser-validation.cjs');

(async()=>{
  const f=fixture(),out=outputDirectory('connection-assist'),proof={isolated:true,real_clients_or_models:false,checks:{}},errors=[];
  fs.mkdirSync(out,{recursive:true});let service,server,browser,page,releaseSetup;
  try{
    let releaseReply;const replyGate=new Promise(resolve=>{releaseReply=resolve;});
    class Actor extends FakeCodex{constructor(member){super();this.member=member;}async run(input){const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);input.onTurn(id());await replyGate;return {threadId:thread,turnId:id(),answer:'请在这条回复里的接入卡片继续操作，连接状态会实时更新。'};}}
    const candidates=['doubao','qwen-desktop','claude-desktop'].map(provider=>({id:provider,provider,name:provider==='doubao'?'豆包':provider==='claude-desktop'?'Claude':'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}));
    candidates.push({id:'unsupported',name:'Unsupported AI',installed:true,support:'unsupported',capabilities:{}});
    candidates.push({id:'cherry-studio',provider:'cherry-studio',name:'Cherry Studio',adapter:'mailbox',installed:false,support:'needs_setup',capabilities:{mcp_prepare:true}});
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
    // A closed picker still refreshes when a chat request starts another AI.
    await page.locator('#professional-toggle').click();
    await page.locator('#secretary-connect-candidates [data-onboarding-requirements]').waitFor({state:'attached'});
    await page.locator('#secretary-connect-dialog .close-dialog').click();
    const setupGate=new Promise(resolve=>{releaseSetup=resolve;}),prepare=service.launch.prepare.bind(service.launch);
    service.launch.prepare=async input=>{await setupGate;return prepare(input);};
    await page.locator('#recipient').selectOption(actor.id);await page.locator('#prompt').fill('把豆包也连上吧。把qwen和claude也连上吧');await page.locator('#send-button').click();
    const card=page.locator('.ao-system-card').first();await card.waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.ao-system-card .connection-panel').length===3);
    await page.waitForFunction(()=>[...onboardingJobs.values()].some(job=>job.status==='running'));
    assert.equal(await page.locator('#secretary-connect-dialog').isVisible(),false);
    await page.locator('#prompt').fill('后续消息');
    assert.equal(await page.evaluate(()=>webConnected),true);
    assert.equal(await page.locator('#send-button').isEnabled(),true);
    assert.doesNotMatch(await page.locator('#footer-status').textContent(),/未连接/);
    assert.deepEqual(errors,[]);proof.checks.chat_connection_with_closed_picker_stays_online=true;
    releaseSetup();
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
    const claudePanel=card.locator('.connection-panel').filter({hasText:'Claude'});
    assert.equal(await claudePanel.locator('[data-conn-op]').count(),1);
    await claudePanel.locator('[data-conn-op="copy_setup"]').click();
    await page.waitForFunction(()=>window.fixtureClipboard?.includes('配置启用后'));
    const combined=await page.evaluate(()=>window.fixtureClipboard);
    assert.match(combined,/"mcpServers"/);assert.match(combined,/agentroom_chat_rooms/);assert.match(combined,/agentroom_chat_inbox/);
    proof.checks.claude_one_button_copies_complete_setup=true;
    // The user's exact wording starts setup; unavailable automatic setup offers a prompt route.
    const doubaoPanel=card.locator('.connection-panel').filter({hasText:'豆包'});
    const originalDoubao=service.connectionAssist.listRoom(room.id).find(item=>item.provider==='doubao').target_member_id;
    await doubaoPanel.getByRole('button',{name:'用提示词连接',exact:true}).click();
    await doubaoPanel.getByRole('button',{name:'复制接入提示词',exact:true}).click();
    await page.waitForFunction(()=>window.fixtureClipboard?.includes('连接地址：'));
    const doubaoPrompt=await page.evaluate(()=>window.fixtureClipboard);
    assert.ok(doubaoPrompt.includes(base+'/mcp/'));assert.match(doubaoPrompt,/本地电脑/);assert.match(doubaoPrompt,/包含的操作/);assert.match(doubaoPrompt,/agentroom_chat_rooms/);assert.match(doubaoPrompt,/agentroom_chat_inbox/);
    const fallback=service.connectionAssist.listRoom(room.id).find(item=>item.provider==='doubao');
    assert.equal(fallback.target_member_id,originalDoubao);assert.equal(fallback.ready_for_office,false);assert.equal(fallback.can_wake,false);
    assert.equal(service.chat.store.member(originalDoubao).config.desktop_delivery_mode,'manual_mcp');
    proof.checks.doubao_chat_prompt_fallback_preserves_member=true;
    await page.screenshot({path:path.join(out,'doubao-prompt-fallback.png')});
    // Other MCP clients also receive configuration and verification in one prompt.
    const qwenPanel=card.locator('.connection-panel').filter({hasText:'Qwen'});
    assert.equal(await qwenPanel.locator('[data-conn-op]').count(),1);
    await qwenPanel.locator('[data-conn-op="copy_setup"]').click();
    await page.waitForFunction(base=>window.fixtureClipboard?.includes(base+'/mcp/')&&window.fixtureClipboard?.includes('qwen-desktop'),base);
    assert.match(await page.evaluate(()=>window.fixtureClipboard),/agentroom_chat_inbox/);proof.checks.qwen_complete_setup_prompt=true;
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
    await page.locator('#professional-toggle').click();
    await page.locator('#secretary-connect-candidates .launch-other-candidates > summary').click();
    await page.locator('#secretary-connect-candidates [data-onboarding-provider="cherry-studio"]').click();
    const promptPanel=page.locator('#secretary-connect-progress');
    await promptPanel.getByRole('button',{name:'复制接入提示词',exact:true}).click();
    await page.waitForFunction(()=>window.fixtureClipboard?.includes('cherry-studio'));
    const installPrompt=await page.evaluate(()=>window.fixtureClipboard);
    assert.match(installPrompt,/mcpServers/);assert.match(installPrompt,/保留其他连接/);assert.match(installPrompt,/agentroom_chat_rooms/);assert.match(installPrompt,/agentroom_chat_inbox/);
    const cherry=service.store.db.prepare("SELECT * FROM onboarding_runs WHERE provider='cherry-studio'").get();
    assert.equal(cherry.install_client,0);assert.equal(cherry.install_runtime,0);assert.equal(cherry.connection_method,'manual_mcp');
    assert.equal(service.onboarding.state({run_id:cherry.id}).ready_for_office,false);
    await page.screenshot({path:path.join(out,'undetected-client-prompt.png')});proof.checks.undetected_client_gets_install_prompt=true;
    assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{releaseSetup?.();await browser?.close();await server?.close();await service?.close();proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));const owned=path.resolve(f.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});console.log(JSON.stringify(proof));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
