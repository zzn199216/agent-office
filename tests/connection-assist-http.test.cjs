'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {assertMemberRoute}=require('../src/member-policy.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id,now,sleep}=require('../src/util.cjs');

async function setup(t){
  const files=fixture(),prompts=[],calls=[],states=new Map();
  class Actor extends FakeCodex{async run(input){prompts.push(input.request.prompt);return super.run(input);}}
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),chat:{clientFactory:()=>new Actor()}});
  const project=service.addProject({path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'Human connections'}),actor=service.chat.addMember({name:'Current assistant',adapter:'codex'}),peer=service.chat.addMember({name:'Peer',adapter:'mailbox'});
  for(const member of[actor,peer])service.chat.join(room.id,member.id);
  service.chat.store.updateMember(actor.id,{status:'ready',verified_at:now()});
  service.onboarding.start=input=>{calls.push(input);const row={id:id(),room_id:input.room_id,provider:input.provider,status:'ready',stage:'ready_automatic',can_wake:true,local_verified:true,ready_for_office:true};states.set(row.id,row);return row;};
  service.onboarding.state=({run_id,room_id})=>{const state=states.get(run_id);assert.equal(state.room_id,room_id);return state;};
  const server=createServer(service,{port:0,token:'fixture-controller'}),base='http://127.0.0.1:'+await server.listen();
  t.after(async()=>{await server.close();await service.close();});
  const send=async(input,token='fixture-controller')=>{const response=await fetch(base+'/api/chat/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({room_id:room.id,to_member_id:actor.id,text:'那拉个豆包进来',idempotency_key:id(),...input})});return {response,data:await response.json()};};
  return {service,room,actor,peer,prompts,calls,base,send};
}
async function answered(service,messageId){const end=Date.now()+4000;while(Date.now()<end){const message=service.chat.store.message(messageId);if(['answered','failed','uncertain'].includes(message.status))return message;await sleep(10);}throw Error('Fixture actor did not finish');}

test('a real controller chat message prepares the selected connection before the actor receives its authoritative context',async t=>{
  const v=await setup(t),key=id(),posted=await v.send({idempotency_key:key});assert.equal(posted.response.status,202);
  assert.equal((await answered(v.service,posted.data.id)).status,'answered');
  assert.equal(v.calls.length,1);assert.deepEqual(v.calls[0],{room_id:v.room.id,provider:'doubao',install_client:false,install_runtime:false});
  assert.match(v.prompts[0],/下方显示接入卡片/);assert.match(v.prompts[0],/"provider":"doubao"/);assert.match(v.prompts[0],/"can_wake":true/);
  const history=v.service.chat.room(v.room.id);assert.equal(history.connection_assists.length,1);assert.equal(history.connection_assists[0].member_id,v.actor.id);assert.equal(history.connection_assists[0].message_id,posted.data.id);
  const repeated=await v.send({idempotency_key:key});assert.equal(repeated.data.id,posted.data.id);assert.equal(v.calls.length,1);
});

test('HTTP peer messages, internal scheduler-style calls and JSON human claims do not start onboarding',async t=>{
  const v=await setup(t);
  const peer=await v.send({sender_id:v.peer.id,human:true});await answered(v.service,peer.data.id);assert.equal(v.calls.length,0);
  const internal=v.service.chat.post({room_id:v.room.id,sender_id:'user',to_member_id:v.actor.id,text:'把 Grok 拉进来',idempotency_key:id()});await answered(v.service,internal.id);assert.equal(v.calls.length,0);
  const diagnostic=await v.send({text:'Grok 连不上，找一下原因'});await answered(v.service,diagnostic.data.id);assert.equal(v.calls.length,0);
  const unauthorized=await v.send({},'not-the-controller');assert.equal(unauthorized.response.status,401);assert.equal(v.calls.length,0);
});
test('replaying an old queued message under the same key cannot retroactively authorize connection help',async t=>{
  const v=await setup(t),key=id(),text='接入一下grok',message=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:v.peer.id,text,idempotency_key:key});
  assert.equal(message.status,'queued');const before=v.service.store.db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n;
  for(let i=0;i<2;i++){const repeated=await v.send({text,to_member_id:v.peer.id,idempotency_key:key});assert.equal(repeated.response.status,202);assert.equal(repeated.data.id,message.id);assert.equal(repeated.data.status,'queued');}
  assert.equal(v.calls.length,0);assert.deepEqual(v.service.connectionAssist.snapshotForMessage(message.id),[]);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,before);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,0);
});

test('connection documents stay controller-only and use the exact room-scoped lookup',async t=>{
  const v=await setup(t),assistId=id(),seen=[];
  v.service.connectionAssist.document=(documentId,roomId)=>{seen.push({documentId,roomId});if(roomId!==v.room.id){const error=new Error('scope');error.status=403;throw error;}return {filename:'connect.md',text:'Read the owned local connection document'};};
  const route=`/api/connection-assists/${assistId}/document?room_id=${v.room.id}`;
  const denied=await fetch(v.base+route);assert.equal(denied.status,401);assert.deepEqual(seen,[]);
  const read=await fetch(v.base+route,{headers:{Authorization:'Bearer fixture-controller'}});assert.equal(read.status,200);assert.equal((await read.json()).filename,'connect.md');assert.deepEqual(seen,[{documentId:assistId,roomId:v.room.id}]);
  const disk={store:v.service.store,chat:v.service.chat.store};
  assert.throws(()=>assertMemberRoute(disk,{member_id:v.peer.id,room_id:v.room.id},route),error=>error.code==='resume_scope_mismatch');
  const foreign=await fetch(v.base+`/api/connection-assists/${assistId}/document?room_id=${id()}`,{headers:{Authorization:'Bearer fixture-controller'}});assert.equal(foreign.status,403);
});
