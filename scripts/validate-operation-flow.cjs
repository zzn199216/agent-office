'use strict';
// Owned headless browser, isolated data and simulated native permission events.
// No real model, user browser, installed client, or permission grant is touched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id}=require('../src/util.cjs');
const out=path.resolve('output/playwright/operation-flow');
const playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{
  fs.mkdirSync(out,{recursive:true});const f=fixture(),codex=new FakeCodex(),responses=[],errors=[];
  const service=new RoomService(f.data,{codex,vault:new FakeVault(),fetch:async()=>{throw Error('Upstream requests prohibited');},launch:{discover:()=>({candidates:[]})}});let server,browser;
  const proof={isolated:true,real_models_called:false,checks:{}};
  try{
    const project=service.addProject({name:'流程隔离测试',path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'确认流程测试'}),otherRoom=service.chat.addRoom({project_id:project.id,title:'另一个办公室'});
    const members=['测试秘书','测试研究助手'].map(name=>service.chat.addMember({name,adapter:'mailbox'}));
    for(const member of members){service.chat.join(room.id,member.id);const prepared=service.chat.connect(member.id,room.id);service.chat.completeInvite(prepared.invite.id,prepared.invite.nonce,member.id);}
    const token=id();server=createServer(service,{port:0,token});const base='http://127.0.0.1:'+await server.listen();
    const chromium=playwright.chromium,executablePath=[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file=>fs.existsSync(file));assert.ok(executablePath);
    browser=await chromium.launch({headless:true,executablePath});const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
    await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort('blockedbyclient'));
    await context.addInitScript(({projectId,roomId})=>{localStorage.setItem('agentroom-project',projectId);localStorage.setItem('agentroom-chat-room',roomId);localStorage.setItem('agentoffice-room-view','chat');},{projectId:project.id,roomId:room.id});
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/#token='+token);
    await page.locator('#secretary-room-entry').click();await page.locator(`[data-secretary-select="${members[0].id}"]`).click();
    await page.waitForFunction(()=>document.querySelector('#secretary-tutorial').classList.contains('hidden')&&document.body.classList.contains('office-view'));
    assert.equal(service.secretary.get(room.id).member_id,members[0].id);proof.checks.ready_secretary_enters_office=true;await page.screenshot({path:path.join(out,'secretary-entered-office.png')});
    await page.locator('#chat-view-button').click();
    for(let i=0;i<70;i++)service.chat.store.post({room_id:room.id,text:'之前的工作记录 '+i,idempotency_key:'history-'+i});
    const message=service.chat.store.post({room_id:room.id,to_member_id:members[0].id,text:'模拟：发布测试报告前核对具体操作。',idempotency_key:'permission-task'});
    const client={respond:(rpcId,value)=>responses.push({rpcId,value})},contextInfo={client,member_id:members[0].id,room_id:room.id,update:fields=>{if(fields.status)service.chat.store.updateMessage(message.id,{status:fields.status==='running'?'processing':fields.status});}};
    service.onApproval(message.id,{id:7,method:'item/commandExecution/requestApproval',params:{threadId:'fixture-thread',turnId:'fixture-turn',command:'模拟外部发布命令 '+('path-with-many-characters/').repeat(80),reason:'这是模拟的外部发布，需要确认目的与范围。',availableDecisions:['accept','acceptForSession','decline']}},'read-only',contextInfo);
    const pending=service.snapshot().approvals[0];await page.evaluate(()=>refresh());
    assert.equal(await page.locator('#approval-panel [data-approval]').count(),0);const card=page.locator(`#messages [data-approval="${pending.id}"]`);await card.waitFor({state:'visible'});
    assert.match(await card.textContent(),/测试秘书/);assert.equal(await page.locator('#messages > :last-child').getAttribute('data-approval'),pending.id);
    await card.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'approval-latest-agent-message.png')});proof.checks.approval_at_latest_member_message=true;
    await card.locator('[data-decision="decline"]').click();await page.waitForFunction(()=>document.querySelectorAll('#messages [data-approval]').length===0);
    assert.deepEqual(responses,[{rpcId:7,value:{decision:'decline'}}]);proof.checks.actual_scoped_choice_clears_card=true;
    service.onApproval(message.id,{id:8,method:'item/tool/requestUserInput',params:{threadId:'fixture-thread',turnId:'fixture-turn',questions:[{id:'strategy',question:'请选择下一步方案',options:[{label:'仅整理本机草稿',description:'保留内容供你核对'},{label:'停止此任务',description:'不继续执行'}]},{id:'scope',question:'请补充范围'}]}},'read-only',contextInfo);
    await page.evaluate(()=>refresh());const inputCard=page.locator('#messages [data-approval]');await inputCard.waitFor({state:'visible'});
    await inputCard.locator('[data-question-choice="strategy"][data-choice-value="仅整理本机草稿"]').click();
    assert.equal(await inputCard.locator('input[data-question="strategy"]').inputValue(),'仅整理本机草稿');assert.equal(responses.length,1,'choosing an option does not submit or execute');
    await inputCard.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'native-question-choices.png')});
    await inputCard.locator('input[data-question="strategy"]').fill('仅整理本机草稿，先核对内容');await inputCard.locator('input[data-question="scope"]').fill('当前项目');
    await page.evaluate(async()=>{lastTimeline='';await refresh();});assert.equal(await inputCard.locator('input[data-question="strategy"]').inputValue(),'仅整理本机草稿，先核对内容');
    await inputCard.locator('[data-input-submit]').click();await page.waitForFunction(()=>document.querySelectorAll('#messages [data-approval]').length===0);
    assert.deepEqual(responses[1],{rpcId:8,value:{answers:{strategy:{answers:['仅整理本机草稿，先核对内容']},scope:{answers:['当前项目']}}}});assert.equal(responses.length,2);proof.checks.suggested_choice_allows_custom_answer_and_submits_once=true;
    service.onPermissionDenials(message.id,[{tool_name:'模拟受限工具'}],{room_id:room.id,member_id:members[1].id});await page.evaluate(()=>refresh());
    const review=page.locator('#messages [data-approval-review]');await review.waitFor({state:'visible'});assert.match(await review.textContent(),/测试研究助手/);assert.equal(await review.locator('[data-approve]').count(),0);
    const before=service.chat.room(room.id).messages.length;await review.locator('[data-review-member]').click();assert.equal(await page.locator('#recipient').inputValue(),members[1].id);assert.equal(service.chat.room(room.id).messages.length,before);proof.checks.denial_supplement_does_not_execute_or_replay=true;
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'mobile-risk-message.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));proof.checks.mobile_no_horizontal_overflow=true;
    await page.setViewportSize({width:1440,height:1000});await page.locator(`[data-room="${otherRoom.id}"]`).click();await page.waitForFunction(()=>document.querySelectorAll('#messages [data-approval-review],[data-approval]').length===0);proof.checks.other_room_does_not_receive_choice=true;
    assert.deepEqual(errors,[]);assert.equal(codex.calls.length,0);proof.ok=true;
  }catch(error){proof.error=error.stack;process.exitCode=1;}
  finally{await browser?.close();await server?.close();await service.close();proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
