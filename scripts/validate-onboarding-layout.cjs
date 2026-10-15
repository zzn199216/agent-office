'use strict';
// An owned browser and empty fixture room. No models or existing user data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{fixture,FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,VERSION}=require('../src/util.cjs');
function playwright(){for(const name of ['playwright',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')]){try{return require(name);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}}throw Error('Playwright missing');}
async function main(){
  const f=fixture(),out=path.resolve('output/playwright/onboarding-layout'),proof={ok:false,version:VERSION,isolated:true,models_called:false,viewports:[]},codex=new FakeCodex();fs.mkdirSync(out,{recursive:true});let service,server,browser,page;
  try{
    service=new RoomService(f.data,{codex,vault:new FakeVault(),fetch:async()=>{throw Error('No upstream requests');}});clearInterval(service.team.timer);
    const project=service.addProject({name:'布局验收',path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'新办公室'}),token=id();server=createServer(service,{token,port:0});const port=await server.listen();browser=await playwright().chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext();await context.addInitScript(({project,room})=>{localStorage.setItem('agentroom-project',project);localStorage.setItem('agentroom-chat-room',room);localStorage.setItem('agentoffice-room-view','chat');},{project:project.id,room:room.id});page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    for(const viewport of [{width:1227,height:784},{width:1366,height:768},{width:1024,height:600},{width:390,height:740},{width:1400,height:950}]){
      await page.setViewportSize(viewport);await page.goto('http://127.0.0.1:'+port+'/?layout='+viewport.width+'x'+viewport.height+'#token='+token);await page.locator('#send-button').waitFor();await page.evaluate(()=>openSecretaryTutorial());await page.locator('#secretary-tutorial').waitFor();
      const layout=await page.evaluate(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};const send=rect('send-button'),composer=rect('composer'),tutorial=rect('secretary-tutorial'),footer=document.querySelector('footer').getBoundingClientRect(),hit=document.elementFromPoint((send.left+send.right)/2,(send.top+send.bottom)/2);return {send,composer,tutorial,footer_top:footer.top,send_hit:!!hit?.closest('#send-button')};});
      proof.viewports.push({viewport,layout});assert.ok(layout.send.bottom<=viewport.height,`Send button clipped at ${viewport.width}x${viewport.height}`);assert.ok(layout.composer.bottom<=layout.footer_top+1,'Composer overlaps footer');assert.ok(layout.tutorial.bottom<=layout.composer.top+1,'Tutorial overlaps composer');assert.equal(layout.send_hit,true,'Send button is obstructed');
      await page.locator('#secretary-look-around').scrollIntoViewIfNeeded();await page.locator('#secretary-look-around').click();await page.locator('#officeScene .ao-scene').waitFor();assert.equal(await page.locator('#secretary-tutorial').isVisible(),false);await page.screenshot({path:path.join(out,`office-${viewport.width}x${viewport.height}.png`)});
    }
    assert.equal(codex.calls.length,0);assert.deepEqual(errors,[]);proof.ok=true;
  }catch(error){proof.error=error.stack;if(page)await page.screenshot({path:path.join(out,'failure.png')});process.exitCode=1;}finally{if(browser)await browser.close();if(server)await server.close();if(service)await service.close();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
