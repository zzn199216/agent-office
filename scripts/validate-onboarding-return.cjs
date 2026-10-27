'use strict';
// Owned browser and simulated Codex transport; the HTTP, verification, role and
// message paths are production code. Never touch a personal client or account.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id}=require('../src/util.cjs');
const {playwright,outputDirectory}=require('./browser-validation.cjs');

async function validateOnboardingReturn(out=outputDirectory('onboarding-return')){
  fs.mkdirSync(out,{recursive:true});
  const screenshots=[];
  for(const width of [1280,390]){
    const files=fixture(),executable=path.join(files.root,'codex.exe');fs.writeFileSync(executable,'fixture never executed');
    let service,server,browser,page,release;
    const gate=new Promise(resolve=>release=resolve),errors=[],external=[],mutations=[],requests=[];
    class NativeFixture extends EventEmitter{
      constructor(member){super();this.member=member;}
      async status(){return {connected:true,signedIn:true};}
      async handshake(input){const thread=id();input.onBinding('bound',thread);service.chat.completeInvite(input.invitation.id,input.invitation.nonce,this.member.id);return {threadId:thread,turnId:id()};}
      async run(input){
        requests.push(input.request.id);input.onTurn(id());await gate;
        const thread=input.discussion.thread_id||id();if(!input.discussion.thread_id)input.onBinding('bound',thread);
        const nonce=[...input.request.prompt.matchAll(/AO-CONNECT-[a-f0-9-]+/gi)].at(-1)?.[0];
        return {threadId:thread,turnId:id(),answer:input.request.prompt.includes('隔离首条任务')?'隔离回复已完成':nonce};
      }
      async close(){}
    }
    const shot=async name=>{const file=`onboarding-${width}-${name}.png`;await page.screenshot({path:path.join(out,file),animations:'disabled'});screenshots.push(file);};
    try{
      const forbidden=async()=>{throw Error('This acceptance cannot use real clients, installers or upstream models');};
      service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:forbidden,
        chat:{clientFactory:member=>new NativeFixture(member)},
        launch:{discover:()=>({candidates:[{id:'codex',provider:'codex',name:'Codex',adapter:'codex',installed:true,executable,capabilities:{automatic_launch:true}},{id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}]}),installer:forbidden},
        onboarding:{verification:{timeoutMs:120000,pollMs:10},desktopConnector:forbidden,runtimeInstaller:forbidden}});
      server=createServer(service,{port:0,token:id()});const port=await server.listen(),base='http://127.0.0.1:'+port;service._localUrl=base;
      browser=await playwright.chromium.launch({headless:true});const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
      await context.route('**/*',route=>{if(route.request().url().startsWith(base+'/'))return route.continue();external.push(route.request().url());return route.abort();});
      page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST')mutations.push(new URL(request.url()).pathname);});
      await page.goto(base+'/');await page.locator('.setup-cards .current-step #welcome-project').click();await page.locator('#project-path').fill(files.project);await page.locator('#project-form button[type="submit"]').click();
      await page.locator('#secretary-connect-candidates [data-onboarding-provider="codex"]').click();
      const panel=page.locator('#secretary-connect-progress .connection-panel');await panel.waitFor();
      await page.waitForFunction(()=>document.querySelector('#secretary-connect-progress [data-conn-state="waiting"]'));
      await page.locator('#secretary-connect-other').click();
      const progress=page.locator('#secretary-connect-candidates [data-onboarding-provider="codex"]');
      assert.equal(await progress.textContent(),'查看进度');assert.equal(await progress.isEnabled(),true);
      assert.equal(await page.locator('#secretary-connect-candidates [data-onboarding-provider="qwen-desktop"]').isDisabled(),true,'another connection waits for this one');
      await shot('return-link');await progress.click();await panel.waitFor();
      await page.locator('#secretary-connect-dialog .close-dialog').click();await page.locator('#professional-toggle').click();
      await progress.waitFor();assert.equal(await progress.isEnabled(),true);await progress.click();await panel.waitFor();
      assert.equal(mutations.filter(route=>route==='/api/onboarding/start').length,1,'returning only reads the original attempt');
      assert.equal(mutations.filter(route=>route.endsWith('/retry')).length,0);assert.equal(service.chat.store.members().filter(member=>member.adapter!=='grok-proxy').length,1);
      release();await page.locator('#secretary-connect-dialog').waitFor({state:'hidden'});
      const room=service.chat.store.rooms()[0],secretary=service.secretary.get(room.id);assert.equal(secretary.status,'ready');assert.ok(secretary.member_id);
      await page.locator('#prompt').waitFor({state:'visible'});await page.waitForFunction(()=>document.activeElement===document.getElementById('prompt'));
      assert.equal(await page.locator('#recipient').inputValue(),secretary.member_id);assert.equal(await page.locator('#composer').evaluate(node=>node.inert),false);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await shot('ready-to-type');
      // No click on the composer, view switch, or recipient before the first task.
      await page.keyboard.type('隔离首条任务');const sent=page.waitForResponse(response=>response.url()===base+'/api/chat/messages'&&response.request().method()==='POST');await page.locator('#send-button').click();
      const message=await(await sent).json();assert.equal(message.to_member_id,secretary.member_id);
      await page.locator('#chat-view-button').click();await page.locator('#messages').getByText('隔离回复已完成',{exact:true}).waitFor();
      const responses=service.chat.room(room.id).messages.filter(value=>value.reply_to===message.id&&value.kind==='reply');assert.equal(responses.length,1);assert.equal(responses[0].sender_id,secretary.member_id);
      assert.equal(requests.length,2,'one verification and one user task');assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    }catch(error){if(page)await shot('failure').catch(()=>{});throw error;}
    finally{release();await browser?.close();await server?.close();await service?.close();const owned=path.resolve(files.root);assert.equal(path.dirname(owned),path.resolve(os.tmpdir()));assert.match(path.basename(owned),/^agentroom-test-/);fs.rmSync(owned,{recursive:true,force:true});}
  }
  return screenshots;
}
if(require.main===module)validateOnboardingReturn().then(screenshots=>console.log(JSON.stringify({ok:true,isolated:true,real_clients_or_models:false,screenshots}))).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={validateOnboardingReturn};
