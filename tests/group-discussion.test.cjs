'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,sleep}=require('../src/util.cjs');
function setup(t,extra={}){
  const files=fixture(),calls=[],clients=new Map();let choices=[];
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),chat:{clientFactory:m=>{const client=new FakeCodex(),run=client.run.bind(client);client.run=async input=>{calls.push({member:m.id,prompt:input.request.prompt});return run(input);};clients.set(m.id,client);return client;}},group:{triage:async(member,input)=>{choices.push({member:member.id,input});return {owner_id:members[1].id,reason:'测试分派'};},...extra}});
  const project=service.addProject({path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'Group fixture'}),members=[];
  function add(adapter='codex'){const m=service.chat.store.addMember({name:'Member '+members.length,adapter});service.chat.store.join(room.id,m.id);service.chat.store.updateMember(m.id,{status:'ready',verified_at:new Date().toISOString()});members.push(m);return m;}
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  return {files,service,room,members,calls,choices,add,post:(text,rest={},human=true)=>service.chat.post({room_id:room.id,sender_id:'user',text,idempotency_key:id(),...rest},{human}),on:()=>service.features.set({room_id:room.id,discussion:true})};
}
async function until(fn){for(let i=0;i<150;i++){if(fn())return;await sleep(10);}assert.fail('fixture operation did not settle');}
test('disabled discussion, announcements and untrusted sender flags cause no routing call',async t=>{
  const v=setup(t);v.add();v.add();v.post('ordinary off');v.on();v.post('announcement',{announcement:true});v.post('not an HTTP controller',{},false);await sleep(30);assert.equal(v.choices.length,0);assert.equal(v.service.group.state(v.room.id).routes.length,0);
});
test('one automatic member handles unaddressed message, task reuses durable records, HTTP retry is not another turn',async t=>{
  const v=setup(t);const member=v.add();v.on();const key=id(),message=v.post('hello',{idempotency_key:key});v.post('hello',{idempotency_key:key});await until(()=>v.service.group.get(message.id)?.status==='review');
  assert.equal(v.calls.length,1);assert.equal(v.choices.length,0);const state=v.service.group.state(v.room.id);assert.equal(state.routes.length,1);assert.equal(state.routes[0].owner_id,member.id);assert.equal(v.service.team.rows(v.room.id,'task').length,1);v.service.team.tick();await sleep(30);assert.equal(v.calls.length,1);assert.equal(v.service.group.today(v.room.id),0);
});
test('explicit @ wins, follow-up returns to its respondent and shared catch-up includes the previous answer',async t=>{
  const v=setup(t),a=v.add(),b=v.add();v.on();const first=v.post('@'+a.name+' first');await until(()=>v.service.chat.store.message(first.id).status==='answered');assert.equal(v.choices.length,0);
  const reply=v.service.chat.room(v.room.id).messages.find(m=>m.reply_to===first.id&&m.kind==='reply');const follow=v.post('please clarify',{reply_to:reply.id});await until(()=>v.service.group.get(follow.id)?.status==='review');assert.equal(v.service.group.get(follow.id).owner_id,a.id);
  const next=v.post('@'+b.name+' continue');await until(()=>v.service.chat.store.message(next.id).status==='answered');assert.ok(v.calls.find(c=>c.member===b.id).prompt.includes(reply.text.slice(0,100)));assert.equal(v.choices.length,0);
});
test('one lightweight call selects owner with bounded input and separate session; metadata is visible without bodies in stats',async t=>{
  const v=setup(t);v.add();v.add();v.on();const m=v.post('a task requiring a choice');await until(()=>v.service.group.get(m.id)?.status==='review');assert.equal(v.choices.length,1);const c=v.choices[0];assert.equal(c.member,v.members[0].id);assert.notEqual(c.input.directory,v.files.project);assert.ok(c.input.prompt.length<12000);assert.equal(c.input.session.thread_id,undefined);assert.equal(v.service.group.today(v.room.id),1);
});
test('daily limit switches discussion off without blocking the selected task and completion is still recorded',async t=>{
  const v=setup(t);v.add();v.add();v.service.features.set({room_id:v.room.id,discussion:true,daily_limit:1});const m=v.post('choose someone');await until(()=>v.service.group.get(m.id)?.status==='review');assert.equal(v.service.features.get(v.room.id).discussion,false);v.post('now stays manual');await sleep(30);assert.equal(v.choices.length,1);
});
test('manual MCP inbox receives catch-up only for its own room, and read does not advance cursor',async t=>{
  const v=setup(t),a=v.add('mailbox');v.on();v.post('room announcement',{announcement:true});const m=v.post('@'+a.name+' read this');const first=v.service.chat.inbox(a.id,v.room.id)[0];assert.ok(first.group_catchup.includes('room announcement'));assert.deepEqual(first,v.service.chat.inbox(a.id,v.room.id)[0]);v.service.chat.reply(m.id,a.id,'I saw the room announcement',id());assert.ok(v.service.group.catchup(v.room.id,a.id).includes('0 条'));
});
test('uncertain original work prevents reassignment and restart does not automatically rerun triage',async t=>{
  const v=setup(t);v.add('mailbox');const b=v.add();v.on();const m=v.post('route');await until(()=>v.service.group.get(m.id)?.status==='review');const route=v.service.group.get(m.id);v.service.chat.store.updateMessage(route.delivery_id,{status:'uncertain'});await assert.rejects(v.service.group.reassign({room_id:v.room.id,message_id:m.id,member_id:b.id}),e=>e.code==='group_reassignment_uncertain');assert.equal(v.calls.length,1);
});
test('reassignment waits for the old managed turn to acknowledge cancellation before starting the next owner',async t=>{
  const v=setup(t),a=v.add(),b=v.add();v.on();const first=v.post('@'+a.name+' initial');await until(()=>v.service.chat.store.message(first.id).status==='answered');
  const m=v.post('follow-up',{reply_to:first.id});await until(()=>!!v.service.group.get(m.id)?.delivery_id);const before=v.service.group.get(m.id),route=await v.service.group.reassign({room_id:v.room.id,message_id:m.id,member_id:b.id});
  assert.equal(v.service.chat.store.message(before.delivery_id).status,'cancelled');assert.equal(route.owner_id,b.id);await until(()=>v.service.group.get(m.id).status==='review');assert.equal(v.service.team.rows(v.room.id,'task').filter(t=>t.group_managed).length,1);
});
