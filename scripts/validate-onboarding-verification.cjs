'use strict';
// Owned headless browser and isolated data. Native model replies are controlled
// fixtures; no installed client, user profile, credentials or real model is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,VERSION}=require('../src/util.cjs');
function playwright(){for(const name of ['playwright',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')])try{return require(name);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}throw Error('Playwright missing');}
async function main(){
  const files=fixture(),out=path.resolve(__dirname,'../output/playwright/onboarding-verification'),proof={version:VERSION,isolated:true,real_models_called:false,checks:{}},sends=[],errors=[];let service,server,browser,page,released=false;
  fs.mkdirSync(out,{recursive:true});
  try{
    const drivers=new Map(),candidate={id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen',adapter:'mailbox',installed:true,running:true,capabilities:{mcp_prepare:true}};
    service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('External requests forbidden');},
      launch:{discover:()=>({candidates:[candidate]}),installerOptions:{home:files.root}},
      onboarding:{verification:{pollMs:20,timeoutMs:30000},desktopConnector:input=>service.desktop.connect(input)},
      desktop:{pollMs:10,turnTimeoutMs:30000,driverFactory:row=>{
        const nativeId=row.native_session_id||'owned-'+row.member_id,runs=new Map();
        const driver={async initialize(){return {detached:true,nativeChatId:nativeId};},async createPersonConversation(){return {detached:true,nativeChatId:nativeId};},
          async send(nativeChatId,{requestId,prompt}){assert.equal(nativeChatId,nativeId);const nonce=[...prompt.matchAll(/AO-CONNECT-[a-f0-9-]+/gi)].at(-1)?.[0];assert.ok(nonce,'expected automatic verification');sends.push({member_id:row.member_id,requestId});runs.set(requestId,nonce);return {status:'sending',nativeChatId:nativeId};},
          async snapshot(requestId){return {requestId,nativeChatId:nativeId,status:released?'completed':'running',userMessageId:'user-'+requestId,responseMessageIds:['reply-'+requestId],replies:released?[{id:'reply-'+requestId,parentId:'user-'+requestId,role:'assistant',done:true,content:runs.get(requestId)}]:[]};},close(){}};
        drivers.set(row.member_id,driver);return driver;
      }}});clearInterval(service.team.timer);
    const project=service.addProject({name:'自动接入隔离验收',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'验证后进入办公室'});
    const token=id();server=createServer(service,{token,port:0});const base='http://127.0.0.1:'+await server.listen();browser=await playwright().chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:1366,height:900}});await context.addInitScript(({project,room})=>{localStorage.setItem('agentroom-project',project);localStorage.setItem('agentroom-chat-room',room);localStorage.setItem('agentoffice-room-view','chat');},{project:project.id,room:room.id});
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/#token='+token);await page.locator('#send-button').waitFor();
    await page.evaluate(()=>openSecretaryTutorial());await page.locator('#secretary-add-ai').click();
    await page.locator('#secretary-connect-candidates [data-onboarding-provider="qwen-desktop"]').click();
    await page.waitForFunction(()=>document.querySelector('#secretary-connect-progress').textContent.includes('自动验证实际回复'));
    assert.equal(await page.locator('#secretary-connect-dialog').isVisible(),true);assert.equal(service.secretary.get(room.id).member_id,null);assert.equal(sends.length,1);
    const row=service.store.db.prepare('SELECT * FROM onboarding_reply_verifications').get();assert.ok(row);for(let n=0;n<3;n++)await page.evaluate(()=>refreshOnboarding());assert.equal(sends.length,1);
    proof.checks.pending_reply_keeps_guide_open=true;proof.checks.progress_reads_never_resend=true;
    await page.screenshot({path:path.join(out,'verifying-reply.png')});released=true;
    await page.locator('#officeScene .ao-scene').waitFor();await page.waitForFunction(()=>!document.querySelector('#secretary-connect-dialog').open);
    const job=service.onboarding.state({run_id:row.run_id});assert.equal(job.ready_for_office,true);assert.equal(job.automatic_reply_verified,true);assert.equal(service.secretary.get(room.id).member_id,row.member_id);assert.equal(sends.length,1);
    proof.checks.actual_correlated_reply_opens_office=true;proof.checks.secretary_selected_after_verification=true;
    assert.equal((await page.locator('#messages').innerText()).includes('AO-CONNECT-'),false);proof.checks.verification_details_do_not_fill_chat=true;
    await page.screenshot({path:path.join(out,'verified-office.png')});
    await page.evaluate(()=>selectRoomView(false));await page.reload();await page.locator('#send-button').waitFor();assert.equal(await page.locator('#chat-stream').isVisible(),true);assert.equal(sends.length,1);proof.checks.reload_does_not_repeat_test_or_navigation=true;
    const other=service.chat.addMember({name:'第二位本人同事',adapter:'mailbox'});service.chat.store.updateMember(other.id,{config:{launch_provider:'qwen-desktop'}});service.chat.join(room.id,other.id);released=false;
    await page.evaluate(()=>refresh());await page.evaluate(memberId=>showMemberSetup(memberId),other.id);await page.locator('#member-connect-guide [data-native-connect]').click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('自动验证实际回复'));
    assert.equal(sends.length,2);assert.equal(await page.locator('#member-setup-dialog').isVisible(),true);released=true;
    await page.waitForFunction(()=>!document.querySelector('#member-setup-dialog').open);await page.locator('#officeScene .ao-scene').waitFor();assert.equal(service.secretary.get(room.id).member_id,row.member_id);assert.equal(sends.length,2);
    proof.checks.direct_member_connect_verifies_and_opens_office=true;proof.checks.adding_member_preserves_secretary=true;
    assert.deepEqual(errors,[]);proof.ok=true;proof.verification_model_fixture_turns=sends.length;
  }catch(error){proof.ok=false;proof.error=error.stack;process.exitCode=1;if(page){proof.navigation=await page.evaluate(()=>({flow:secretaryNavigation,room:roomId,setup:selectedSetupMember,jobs:[...onboardingJobs.values()].map(job=>({id:job.id,member_id:job.member_id,status:job.status,stage:job.stage,ready_for_office:job.ready_for_office})),participants:(history?.participants||[]).map(member=>({id:member.id,status:member.status,verified:!!member.verified_at})),secretary:currentSecretary(),error:secretaryError})).catch(()=>null);await page.screenshot({path:path.join(out,'failure.png')});}}
  finally{await browser?.close();await server?.close();await service?.close();const target=path.resolve(files.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});proof.page_errors=errors;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
