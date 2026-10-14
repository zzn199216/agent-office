'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{now,sleep}=require('../src/util.cjs');
test('all bounded CLI participants report native denials through the same attributed notice without granting or replaying',async t=>{
  const f=fixture(),clients=new Map();
  class DeniedClient extends FakeCodex {constructor(){super();this.responses=[];}respond(id,value){this.responses.push({id,value});}async run(v){const result=await super.run(v);return {...result,permissionDenials:[{tool_name:'restricted_tool'}]};}}
  const service=new RoomService(f.data,{codex:new FakeCodex(),vault:new FakeVault(),chat:{clientFactory:member=>{const client=new DeniedClient();clients.set(member.id,client);return client;}}});t.after(()=>service.close());
  const project=service.addProject({path:f.project}),messages=[];
  for(const adapter of ['claude-code','qwen-code','gemini-cli']){const room=service.chat.addRoom({project_id:project.id,title:adapter}),member=service.chat.addMember({name:adapter,adapter});service.chat.join(room.id,member.id);service.chat.store.updateMember(member.id,{status:'ready',verified_at:now()});const message=service.chat.post({room_id:room.id,to_member_id:member.id,text:'Inspect the allowed project',idempotency_key:adapter});messages.push({message,member,room});}
  const end=Date.now()+3000;while(Date.now()<end&&messages.some(({message})=>service.chat.store.message(message.id).status!=='answered'))await sleep(10);
  const notices=service.snapshot().approval_reviews;assert.equal(notices.length,3);assert.equal(service.snapshot().approvals.length,0);
  for(const {message,member,room}of messages){const notice=notices.find(n=>n.request_id===message.id);assert.equal(notice.member_id,member.id);assert.equal(notice.room_id,room.id);assert.equal(notice.source,'native_permissions');assert.equal(notice.status,'denied');assert.equal(service.chat.store.message(message.id).status,'answered');assert.deepEqual(clients.get(member.id).calls,[message.id]);assert.equal(clients.get(member.id).responses.length,0);assert.equal(service.chat.publicMember(service.chat.store.member(member.id)).operation_policy.routine_mode,'automatic_authorized');}
});

test('an already-denied native permission has a notice rather than an invented pending Allow button',t=>{
  const f=fixture(),codex=new FakeCodex(),service=new RoomService(f.data,{codex,vault:new FakeVault()});t.after(()=>service.close());const project=service.addProject({path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'Read-only'}),member=service.chat.addMember({name:'Scoped member',adapter:'mailbox'});service.chat.join(room.id,member.id);
  const message=service.chat.store.post({room_id:room.id,to_member_id:member.id,text:'Inspect',idempotency_key:'read-only'});const responses=[];const client={respond:(id,value)=>responses.push({id,value})};
  service.onApproval(message.id,{id:3,method:'item/fileChange/requestApproval',params:{threadId:'owned-thread'}},'read-only',{client});
  assert.deepEqual(responses,[{id:3,value:{decision:'decline'}}]);assert.equal(service.snapshot().approvals.length,0);assert.equal(service.snapshot().approval_reviews[0].member_id,member.id);assert.equal(service.snapshot().approval_reviews[0].room_id,room.id);assert.equal(service.chat.store.message(message.id).status,'queued');
});
