'use strict';
const assert=require('node:assert/strict'),{FakeCodex}=require('../tests/helpers.cjs'),{id,sleep}=require('../src/util.cjs');
module.exports=async function({service,page,api,roomId,shot}){
  await page.locator('#room-feature-options').click();await page.locator('[data-room-feature="walking"]').check();await page.locator('#room-features-save').click();await page.locator('#room-features-dialog').waitFor({state:'hidden'});
  if(!await page.locator('.canvas-world').isVisible())await page.locator('[data-canvas-expand]').click();
  const member=service.chat.store.addMember({name:'走到工位的成员',adapter:'codex'});service.chat.store.updateMember(member.id,{status:'ready',verified_at:new Date().toISOString()});service.runtime.workerHeartbeat('fixture:'+member.id,{member_id:member.id});service.runtime.heartbeat(member.id,{session_ref:'fixture:'+member.id});service.chat.clients.set(member.id,new FakeCodex());
  await api('/api/chat/rooms/'+roomId+'/join',{member_id:member.id});await page.waitForFunction(id=>officeScene.getMetrics().actors.some(a=>a.id===id&&a.animation==='walk'),member.id);
  const before=await page.evaluate(id=>officeScene.getMetrics().actors.find(a=>a.id===id),member.id);await sleep(350);const after=await page.evaluate(id=>officeScene.getMetrics().actors.find(a=>a.id===id),member.id);assert.notDeepEqual(after.at,before.at);
  const message=await api('/api/chat/messages',{room_id:roomId,to_member_id:member.id,text:'WALK-NO-WAIT: reply without waiting for the office',idempotency_key:id()});
  for(let i=0;i<100&&service.chat.store.message(message.id).status!=='answered';i++)await sleep(20);assert.equal(service.chat.store.message(message.id).status,'answered');
  await page.waitForFunction(id=>officeScene.getMetrics().actors.some(a=>a.id===id&&a.layer===null),member.id);await sleep(250);const idle=await page.evaluate(()=>officeScene.getMetrics());await sleep(500);assert.equal((await page.evaluate(()=>officeScene.getMetrics())).draws,idle.draws);
  await shot('15-office-walking.png');return {ok:true,member_id:member.id,path_moved:true,response_independent:true,settled_idle_draws:0};
};
