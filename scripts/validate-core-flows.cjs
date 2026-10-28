'use strict';
// Only the external MCP client is simulated. Buttons, HTTP, persistence,
// onboarding, scoped MCP tools and the rendered office use production code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {RoomService} = require('../src/service.cjs');
const {createServer} = require('../src/http.cjs');
const {fixture, FakeCodex, FakeVault} = require('../tests/helpers.cjs');
const {id} = require('../src/util.cjs');
const {playwright, outputDirectory} = require('./browser-validation.cjs');
const flows = require('./core-flows.cjs');

async function main() {
  const files = fixture(), out = outputDirectory('core-flows');
  const proof = {ok:false, isolated:true, real_clients_or_models:false, flows:flows.map(flow=>({...flow,status:'pending'})), screenshots:[]};
  fs.mkdirSync(out, {recursive:true});
  let service, server, browser, page, base, port, endpoint, session, member, firstRoom, secondRoom;
  let token = id(), rpcId = 0;
  const errors = [], external = [], codex = new FakeCodex();
  const forbidden = async()=>{throw Error('Core acceptance cannot use a personal client, installer or upstream model');};
  const options = {
    codex, vault:new FakeVault(), fetch:forbidden,
    chat:{clientFactory:()=>{throw Error('Only the fixture MCP member may process messages');}},
    launch:{discover:()=>({candidates:[{id:'doubao',provider:'doubao',name:'豆包',adapter:'mailbox',installed:true,running:true,capabilities:{mcp_prepare:true}}]}), installer:forbidden},
    onboarding:{replyVerification:false, desktopConnector:forbidden, runtimeInstaller:forbidden}
  };
  const api = async(route, input, method)=>{
    const response = await fetch(base+route, {method:method||(input===undefined?'GET':'POST'), headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}, ...(input===undefined?{}:{body:JSON.stringify(input)}), signal:AbortSignal.timeout(15000)});
    const result = await response.json();
    assert.ok(response.ok, route+' failed: '+(result.code||response.status));
    return result;
  };
  const rpc = async(method, params, notification=false)=>{
    const response = await fetch(endpoint, {method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream', ...(session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-06-18'}:{})}, body:JSON.stringify({jsonrpc:'2.0',...notification?{}:{id:++rpcId},method,params}), signal:AbortSignal.timeout(15000)});
    assert.ok(response.ok, 'Fixture MCP '+method+' returned '+response.status);
    if(method==='initialize')session=response.headers.get('mcp-session-id');
    if(notification)return;
    const value=await response.json();
    assert.ok(!value.error, 'Fixture MCP RPC error');
    assert.ok(!value.result.isError, 'Fixture MCP tool failed: '+(params?.name||method));
    return value.result;
  };
  const initialize = async()=>{
    session=null;
    await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'AO isolated acceptance client',version:'1'}});
    assert.ok(session);
    await rpc('notifications/initialized',{},true);
  };
  const tool = async(name, args={})=>{
    const result=await rpc('tools/call',{name,arguments:args});
    return result.structuredContent||JSON.parse(result.content[0].text);
  };
  const inbox = async()=>{const result=await tool('agentroom_chat_inbox');return Array.isArray(result)?result:result.items;};
  const shot = async(name)=>{await page.screenshot({path:path.join(out,name),animations:'disabled'});proof.screenshots.push(name);};
  const closeDialog = async(selector)=>{const dialog=page.locator(selector);if(await dialog.isVisible())await dialog.locator('.close-dialog').first().click();};
  const closeTutorial = async()=>{if(await page.locator('#secretary-look-around').isVisible())await page.locator('#secretary-look-around').click();};
  const connect = async()=>{
    await page.locator('#secretary-add-ai').click();
    await page.locator('#secretary-connect-candidates [data-onboarding-provider="doubao"]').click();
  };
  const selectRoom = async(room)=>{
    await page.locator('#rooms [data-room="'+room.id+'"]').click();
    await page.waitForFunction(room=>document.querySelector('#room-heading')?.textContent===room.title, room);
    await closeTutorial();
  };
  const post = async(text)=>{
    await page.locator('#chat-view-button').click();
    await page.locator('#recipient').selectOption(member.id);
    await page.locator('#prompt').fill(text);
    const sent=page.waitForResponse(response=>response.url()===base+'/api/chat/messages'&&response.request().method()==='POST');
    await page.locator('#send-button').click();
    const response=await sent;
    assert.ok(response.ok());
    const message=await response.json();
    await page.locator('#message-'+message.id).waitFor();
    return message;
  };
  const reply = async(message, text, consumed=false)=>{
    if(consumed){const current=await api('/api/chat/messages/'+message.id);assert.equal(current.status,'consumed');assert.equal(current.to_member_id,member.id);}
    else {const pending=await inbox();assert.ok(pending.some(value=>value.id===message.id));}
    await tool('agentroom_chat_reply',{message_id:message.id,text,idempotency_key:'fixture-reply-'+message.id});
    await page.locator('#chat-view-button').click();
    await page.locator('#messages').getByText(text,{exact:true}).waitFor();
    const history=await api('/api/chat/rooms/'+message.room_id);
    const answers=history.messages.filter(value=>value.reply_to===message.id&&value.kind==='reply');
    assert.equal(answers.length,1);assert.equal(answers[0].sender_id,member.id);
    assert.equal(history.messages.find(value=>value.id===message.id).status,'answered');
  };
  const run = async(flowId, work)=>{
    const row=proof.flows.find(flow=>flow.id===flowId), started=Date.now();
    row.status='running';
    try{await work();row.status='passed';console.log('PASS '+row.id+' '+row.name);}
    catch(error){row.status='failed';row.error=error.message;throw error;}
    finally{row.duration_ms=Date.now()-started;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));}
  };
  try {
    service=new RoomService(files.data,options);
    server=createServer(service,{port:0,token});port=await server.listen();base='http://127.0.0.1:'+port;service._localUrl=base;
    browser=await playwright.chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
    await context.route('**/*',route=>{
      if(route.request().url().startsWith(base+'/'))return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await context.addInitScript(()=>{
      Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureClipboard=text;}}});
    });
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/');

    await run('first-connection',async()=>{
      // Include the automatic secretary path and return-to-progress controls in
      // the mandatory gate, with a separate fresh instance at desktop/phone widths.
      proof.screenshots.push(...await require('./validate-onboarding-return.cjs').validateOnboardingReturn(out));
      // Start where a new person starts. A seeded project/room bypasses the
      // first-run controls and cannot catch a broken project picker or form.
      // One path: folder -> AI -> talk. The room is created for the person and the AI picker opens next.
      await page.locator('.setup-cards .current-step #welcome-project').click();
      await page.locator('#project-dialog').waitFor();
      await page.locator('#project-path').fill(files.project);
      assert.equal(await page.locator('#project-name').inputValue(),path.basename(files.project),'The project name defaults to the folder name');
      const created=page.waitForResponse(response=>response.url()===base+'/api/chat/rooms'&&response.request().method()==='POST');
      await page.locator('#project-form button[type="submit"]').click();firstRoom=await(await created).json();
      assert.equal(service.store.projects().length,1);assert.equal(service.store.projects()[0].name,path.basename(files.project));
      await page.locator('#secretary-connect-dialog').waitFor({state:'visible'});
      assert.equal(await page.locator('#room-dialog').isVisible(),false,'No separate room form on first run');
      assert.equal(await page.locator('#secretary-tutorial').isVisible(),false,'The AI picker replaces the secretary tutorial');
      await page.locator('#secretary-connect-candidates [data-onboarding-provider="doubao"]').click();
      const panel=page.locator('#secretary-connect-progress .connection-panel');
      // Doubao now defaults to automatic delivery. This isolated journey also
      // verifies the explicit MCP fallback; a real desktop is never invoked.
      await panel.locator('[data-conn-op="manual_mcp"]').click();
      await panel.locator('[data-conn-op="copy_setup"]').click();
      await page.waitForFunction(()=>typeof window.fixtureClipboard==='string');
      const prompt=await page.evaluate(()=>window.fixtureClipboard);
      endpoint=prompt.match(/^连接地址：\n(https?:\/\/\S+)$/m)?.[1];
      assert.ok(endpoint?.startsWith(base+'/mcp/'));
      assert.match(prompt,/agentroom_chat_rooms/);assert.match(prompt,/agentroom_chat_inbox/);assert.match(prompt,/本地电脑/);
      assert.match(await panel.textContent(),/本地电脑/);assert.equal(await panel.locator('[data-conn-op]').count(),1);
      const members=service.chat.store.members().filter(value=>value.adapter!=='grok-proxy');assert.equal(members.length,1);member=members[0];
      assert.ok(!member.verified_at,'Copying instructions must not claim a connection');
      await initialize();
      const listed=await rpc('tools/list',{});
      for(const name of ['agentroom_chat_rooms','agentroom_chat_inbox','agentroom_chat_reply'])assert.ok(listed.tools.some(value=>value.name===name));
      assert.ok(!service.chat.store.member(member.id).verified_at,'Tool discovery must not claim a connection');
      const rooms=await tool('agentroom_chat_rooms');
      assert.equal(rooms.member_id,member.id);assert.ok(rooms.rooms.some(value=>value.id===firstRoom.id));
      assert.deepEqual(await inbox(),[]);
      // Once the handshake proves the connection, the picker closes by itself and the room opens.
      await page.locator('#secretary-connect-dialog').waitFor({state:'hidden'});
      assert.equal(await page.locator('#member-setup-dialog').isVisible(),false);assert.equal(await page.locator('#secretary-tutorial').isVisible(),false);
      await page.locator('#chat-view-button').click();
      await page.locator('#recipient option[value="'+member.id+'"]').waitFor({state:'attached'});
      // The first connected member receives a typed message; the room announcement wakes nobody.
      await page.waitForFunction(id=>document.getElementById('recipient').value===id,member.id);
      assert.ok(service.chat.store.member(member.id).verified_at);
      await shot('01-first-connected.png');
    });

    await run('existing-member-new-room',async()=>{
      const identities=service.chat.store.members().map(value=>value.id).sort();
      const credentials=service.store.db.prepare('SELECT id FROM chat_resume_credentials ORDER BY id').all();
      await page.locator('#add-room').click();await page.locator('#room-name').fill('同一成员的新办公室');
      const created=page.waitForResponse(response=>response.url()===base+'/api/chat/rooms'&&response.request().method()==='POST');
      await page.locator('#room-form button[type="submit"]').click();secondRoom=await(await created).json();
      await connect();
      await page.locator('#secretary-connect-progress [data-conn-op="copy_setup"]').waitFor();
      // An existing address must work in the new room, but the new attempt
      // still needs fresh tool evidence, not the previous room's timestamp.
      const rooms=await tool('agentroom_chat_rooms');assert.equal(rooms.member_id,member.id);
      // A member connected by hand cannot be the secretary; it joins the room and the picker closes by itself.
      await page.locator('#secretary-connect-dialog').waitFor({state:'hidden'});await closeTutorial();
      await page.waitForFunction(id=>document.getElementById('recipient').value===id,member.id);
      assert.deepEqual(service.chat.store.members().map(value=>value.id).sort(),identities);
      assert.equal(service.chat.store.joined(secondRoom.id,member.id),true);
      assert.equal(service.chat.store.joined(firstRoom.id,member.id),true);
      assert.deepEqual(service.store.db.prepare('SELECT id FROM chat_resume_credentials ORDER BY id').all(),credentials);
      assert.deepEqual(new Set(rooms.rooms.map(room=>room.id)),new Set([firstRoom.id,secondRoom.id]));
      await shot('02-reused-in-new-room.png');
    });

    await run('task-progress-reply',async()=>{
      const message=await post('隔离任务：检查这个房间的连接');
      assert.ok((await inbox()).some(value=>value.id===message.id));
      await tool('agentroom_chat_ack',{message_id:message.id});
      await page.locator('#office-view-button').click();
      const bubble=page.locator('.ao-seat[data-member-id="'+member.id+'"] .ao-bubble');
      await bubble.waitFor({state:'visible'});
      await page.waitForFunction(memberId=>document.querySelector('.ao-seat[data-member-id="'+memberId+'"] .ao-bubble')?.textContent.includes('已读取，等待回复'),member.id);
      assert.match(await bubble.textContent(),/已读取，等待回复/);
      await shot('03-task-progress.png');await bubble.click();
      await page.locator('#chat-stream').waitFor({state:'visible'});await page.locator('#message-'+message.id).waitFor();
      await reply(message,'隔离回复：这个房间的连接已核对',true);
      await page.locator('#office-view-button').click();
      await page.waitForFunction(()=>!document.querySelector('.ao-seat.ao-has-progress'));
      await shot('03-task-replied.png');
    });

    await run('restart-recovery',async()=>{
      const pending=await post('隔离任务：重启之后继续回复');
      await page.locator('#office-view-button').click();
      const credentials=service.store.db.prepare('SELECT id FROM chat_resume_credentials ORDER BY id').all();
      await server.close();server=null;await service.close();service=null;
      await page.locator('.ao-scene.ao-offline-room').waitFor();assert.equal(await page.locator('.ao-light-switch').isDisabled(),true);
      // Every place on the page tells the same story, and says how to get back.
      await page.waitForFunction(()=>!document.getElementById('web-offline-banner').classList.contains('hidden'));assert.match(await page.locator('#sidebar-service-status').textContent(),/服务已关闭/);
      await shot('04-service-disconnected.png');
      token=id();service=new RoomService(files.data,options);server=createServer(service,{port,token});
      assert.equal(await server.listen(),port);service._localUrl=base;
      // The open page must recover its controller cookie; no reload/token injection.
      await page.waitForFunction(()=>document.querySelector('.ao-scene')&&!document.querySelector('.ao-scene.ao-offline-room'));
      await page.waitForFunction(()=>document.getElementById('web-offline-banner').classList.contains('hidden'));assert.match(await page.locator('#sidebar-service-status').textContent(),/本机运行中/);
      await initialize();const rooms=await tool('agentroom_chat_rooms');assert.equal(rooms.member_id,member.id);
      assert.deepEqual(service.store.db.prepare('SELECT id FROM chat_resume_credentials ORDER BY id').all(),credentials);
      await reply(pending,'隔离回复：重启前的同一条消息已完成');
      assert.equal(service.chat.store.members().filter(value=>value.adapter!=='grok-proxy').length,1);
      await shot('04-recovered-original-request.png');
    });

    await run('room-isolation',async()=>{
      await page.locator('#inspector-toggle').click();
      await page.locator('[data-inspector-tab="members"]').click();
      await page.locator('[data-inspector-member="'+member.id+'"]').click();
      await page.locator('#inspector-member-connect').click();await page.locator('#leave-member').click();
      await page.locator('#member-setup-dialog').waitFor({state:'hidden'});
      assert.equal(service.chat.store.joined(secondRoom.id,member.id),false);
      assert.equal(service.chat.store.joined(firstRoom.id,member.id),true);
      if(await page.locator('#inspector-close').isVisible())await page.locator('#inspector-close').click();
      await closeTutorial();await selectRoom(firstRoom);
      await reply(await post('隔离任务：另一间办公室仍可工作'),'隔离回复：成员退出其他房间后仍可回复');
      await selectRoom(secondRoom);await page.locator('#secretary-room-entry').click();
      await page.locator('#secretary-add-ai').click();await page.locator('#secretary-connect-manual').click();
      await page.locator('[data-join-member="'+member.id+'"]').click();
      await page.locator('#member-setup-dialog').waitFor();await closeDialog('#member-setup-dialog');await closeTutorial();
      assert.equal(service.chat.store.joined(secondRoom.id,member.id),true);
      await page.locator('[data-room-actions="'+secondRoom.id+'"]').click();await page.locator('#room-actions-delete').click();
      await page.locator('#delete-room-confirm').click();await page.locator('#delete-room-dialog').waitFor({state:'hidden'});
      await page.locator('#rooms [data-room="'+secondRoom.id+'"]').waitFor({state:'detached'});
      await selectRoom(firstRoom);
      const rooms=await tool('agentroom_chat_rooms');assert.equal(rooms.member_id,member.id);
      assert.deepEqual(rooms.rooms.map(room=>room.id),[firstRoom.id]);
      await reply(await post('隔离任务：删除另一间办公室后继续'),'隔离回复：房间删除未影响共享成员和消息');
      await shot('05-other-room-still-works.png');
    });

    await run('night-narrow-window',async()=>{
      await api('/api/office',{room_id:firstRoom.id,time_mode:'night'});
      await page.locator('#office-view-button').click();await page.locator('.ao-scene[data-phase="night"][data-lights="on"]').waitFor();
      const shade=()=>page.locator('.ao-floor').evaluate(node=>Number(getComputedStyle(node,'::after').opacity));
      assert.equal(await shade(),0);await shot('06-night-lit.png');
      // Page scrollWidth alone misses controls clipped by a nested toolbar.
      // Exercise wider glyphs too, independent of the host's Chinese fonts.
      for (const width of [320,390,760]) {
        await page.setViewportSize({width,height:844});
        const largerType=await page.evaluate(()=>{
          const sheet=[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/style.css'));
          return sheet.insertRule('.topbar-actions button{font-size:16px!important;letter-spacing:1px!important}',sheet.cssRules.length);
        });
        const layout=await page.locator('.topbar').evaluate(bar=>{
          const actions=bar.querySelector('.topbar-actions'),bounds=bar.getBoundingClientRect();
          const buttons=[...bar.querySelectorAll('button')].filter(button=>button.getClientRects().length);
          return {noScroll:actions.scrollWidth<=actions.clientWidth+1,controls:buttons.map(button=>{
            const rect=button.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
            return {id:button.id,visible:rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=bounds.top&&rect.bottom<=bounds.bottom+1,reachable:hit===button||button.contains(hit)};
          })};
        });
        assert.ok(layout.noScroll,'Toolbar needs horizontal scrolling at '+width);
        for(const control of layout.controls)assert.ok(control.visible&&control.reachable,`${control.id} clipped or covered at ${width}px`);
        await page.locator('#team-open').click();if(!await page.locator('#team-more').evaluate(details=>details.open))await page.locator('#team-more > summary').click();
        await page.locator('#mirror-open').click();
        await page.locator('#mirror-dialog').waitFor({state:'visible'});
        await shot(`06-mirror-${width}-large-type.png`);
        await closeDialog('#mirror-dialog');
        await page.locator('#inspector-close').click();
        await shot(`06-toolbar-${width}-large-type.png`);
        await page.evaluate(index=>[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/style.css')).deleteRule(index),largerType);
      }
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.ao-floor').getBoundingClientRect().top>=document.querySelector('.ao-toolbar-right').getBoundingClientRect().bottom);
      // Taller glyphs (another host's fonts) wrap or grow the office toolbar; the floor must still start below it.
      const officeType=await page.evaluate(()=>{const sheet=[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/office.css'));return sheet.insertRule('.ao-toolbar button{font-size:16px!important;letter-spacing:1px!important}',sheet.cssRules.length);});
      await page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.ao-floor').getBoundingClientRect().top>=document.querySelector('.ao-toolbar').getBoundingClientRect().bottom);
      await shot('06-office-390-large-type.png');
      await page.evaluate(index=>[...document.styleSheets].find(sheet=>sheet.href?.endsWith('/office.css')).deleteRule(index),officeType);
      await page.getByRole('button',{name:'关闭办公室灯光',exact:true}).click();
      await page.locator('.ao-scene[data-lights="off"]').waitFor();assert.ok(await shade()>.5);
      await page.reload();await page.locator('.ao-scene[data-lights="off"]').waitFor();
      await page.getByRole('button',{name:'打开办公室灯光',exact:true}).click();
      await page.locator('.ao-scene[data-lights="on"]').waitFor();assert.equal(await shade(),0);
      await shot('06-narrow-night-lit.png');
      await reply(await post('隔离任务：窄窗口也能发消息'),'隔离回复：窄窗口操作完成');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await shot('06-narrow-replied.png');
    });
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(codex.calls.length,0);
    proof.ok=true;
  } catch(error) {
    proof.error=error.stack;process.exitCode=1;
    if(page)await shot('failure.png').catch(()=>{});
  } finally {
    await browser?.close();await server?.close();await service?.close();
    proof.page_errors=errors;proof.external_request_count=external.length;
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2)+'\n');
    // Delete only the fixture directory created above, never a user profile.
    const owned=path.resolve(files.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);
    fs.rmSync(owned,{recursive:true,force:true});
    console.log(JSON.stringify({ok:proof.ok,flows:proof.flows,result:path.join(out,'result.json'),error:proof.error},null,2));
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
