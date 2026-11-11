'use strict';
const assert=require('node:assert/strict'),{FakeCodex}=require('../tests/helpers.cjs'),{id,sleep}=require('../src/util.cjs');
module.exports=async function({service,page,api,roomId,shot}){
  const beforeCalls=service.group.today(roomId);await page.locator('#room-feature-options').click();await page.locator('[data-room-feature="ambient"]').check();await page.locator('#room-features-save').click();await page.locator('#room-features-dialog').waitFor({state:'hidden'});
  await sleep(300);const baseline=await page.evaluate(()=>officeScene.getMetrics());await sleep(500);assert.equal((await page.evaluate(()=>officeScene.getMetrics())).draws,baseline.draws,'An idle deadline must not redraw continuously');
  await page.waitForFunction(()=>officeScene.getMetrics().actors.some(a=>a.layer==='ambient'),null,{timeout:25000});const actor=await page.evaluate(()=>officeScene.getMetrics().actors.find(a=>a.layer==='ambient'));assert.equal(actor.state,'idle');assert.equal(service.group.today(roomId),beforeCalls);
  const client=new FakeCodex();let release;client.run=async input=>{const thread=id();input.onBinding('bound',thread);input.onTurn(id());input.onProgress('真实任务打断休息');await new Promise(resolve=>release=resolve);return {threadId:thread,turnId:id(),answer:'休息已让位给任务'};};service.chat.clients.set(actor.id,client);
  await api('/api/chat/messages',{room_id:roomId,to_member_id:actor.id,text:'AMBIENT-INTERRUPT: work now',idempotency_key:id()});await page.waitForFunction(id=>officeScene.getMetrics().actors.some(a=>a.id===id&&a.state==='working'&&a.layer!=='ambient'),actor.id);
  const occupied=await page.evaluate(id=>[...officeScene.director.reservations.values()].includes(id),actor.id);assert.equal(occupied,false);await shot('16-office-ambient-interrupted.png');release();
  await page.locator('#room-feature-options').click();await page.locator('[data-room-feature="ambient"]').uncheck();await page.locator('#room-features-save').click();await page.locator('#room-features-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>officeScene.getMetrics().actors.every(a=>a.layer!=='ambient'));return {ok:true,data_driven:true,real_work_interrupts:true,reservation_released:true,extra_model_calls:0};
};
