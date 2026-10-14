'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const{RoomService}=require('../src/service.cjs');const{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
function setup(t){const f=fixture(),codex=new FakeCodex();codex.responses=[];codex.respond=(id,value)=>codex.responses.push({id,value});const service=new RoomService(f.data,{codex,vault:new FakeVault()});t.after(()=>service.close());const p=service.addProject({path:f.project}),d=service.store.addDiscussion(p.id,'确认测试'),r=service.store.submit({discussion_id:d.id,message:'检查',idempotency_key:'a'});return{service,codex,r};}
test('MCP form confirmation is visible and sends typed explicit input',t=>{const{service,codex,r}=setup(t);service.onApproval(r.id,{id:7,method:'mcpServer/elicitation/request',params:{mode:'form',message:'确认查询',requestedSchema:{type:'object',properties:{approved:{type:'boolean'}},required:['approved']}}},'read-only');const approval=service.snapshot().approvals[0];assert.equal(approval.type,'form');assert.equal(service.store.request(r.id).status,'waiting_input');service.respondApproval(approval.id,{content:{approved:true}});assert.deepEqual(codex.responses[0],{id:7,value:{action:'accept',content:{approved:true}}});});
test('read-only project refuses write escalation, and device verification is not forged',t=>{const{service,codex,r}=setup(t);service.onApproval(r.id,{id:8,method:'item/permissions/requestApproval',params:{permissions:{fileSystem:{write:['C:\\']}}}},'read-only');assert.deepEqual(codex.responses[0].value,{permissions:{},scope:'turn'});service.onApproval(r.id,{id:9,method:'mcpServer/elicitation/request',params:{mode:'openai/userVerification',challenge:'not-a-real-secret'}},'read-only');assert.deepEqual(codex.responses[1].value,{action:'cancel'});assert.equal(service.snapshot().approvals.length,0);});

test('native advertised session decision is optional and never becomes a blanket application rule',t=>{
  const {service,codex,r}=setup(t);
  const request=(rpcId,availableDecisions)=>({id:rpcId,method:'item/commandExecution/requestApproval',params:{threadId:'owned-thread',command:'fixture read',...availableDecisions?{availableDecisions}:{}}});
  service.onApproval(r.id,request(10,['accept','acceptForSession','decline']),'read-only');
  const first=service.snapshot().approvals[0];assert.equal(first.session_allowed,true);
  service.respondApproval(first.id,{decision:'acceptForSession'});assert.deepEqual(codex.responses.at(-1),{id:10,value:{decision:'acceptForSession'}});
  service.onApproval(r.id,request(11),'read-only');const next=service.snapshot().approvals[0];assert.equal(next.session_allowed,false);
  assert.throws(()=>service.respondApproval(next.id,{decision:'acceptForSession'}));assert.equal(service.snapshot().approvals.length,1);
  service.respondApproval(next.id,{decision:'decline'});assert.deepEqual(codex.responses.at(-1),{id:11,value:{decision:'decline'}});
});

test('permission grants and read-only file requests cannot inherit a command session decision',t=>{
  const {service,codex,r}=setup(t);
  service.onApproval(r.id,{id:12,method:'item/permissions/requestApproval',params:{permissions:{network:{enabled:true}},availableDecisions:['acceptForSession']}},'read-only');
  const permission=service.snapshot().approvals[0];assert.equal(permission.session_allowed,false);assert.throws(()=>service.respondApproval(permission.id,{decision:'acceptForSession'}));
  service.respondApproval(permission.id,{decision:'decline'});assert.deepEqual(codex.responses.at(-1).value,{permissions:{},scope:'turn'});
  service.onApproval(r.id,{id:13,method:'item/fileChange/requestApproval',params:{threadId:'owned-thread',availableDecisions:['acceptForSession']}},'read-only');
  assert.equal(service.snapshot().approvals.length,0);assert.deepEqual(codex.responses.at(-1).value,{decision:'decline'});
});

test('native resolver clears only the exact client and thread without resurrecting a completed task',t=>{
  const {service,codex,r}=setup(t),other={responses:[],respond(id,value){this.responses.push({id,value});}};
  const request={id:20,method:'item/commandExecution/requestApproval',params:{threadId:'owned-thread',command:'fixture'}};
  service.onApproval(r.id,request,'read-only');service.onApproval(r.id,request,'read-only');assert.equal(service.snapshot().approvals.length,1);
  service.onApproval(r.id,request,'read-only',{client:other});assert.equal(service.snapshot().approvals.length,2);
  service.resolveApproval({params:{threadId:'different-thread',requestId:20}},{client:codex});assert.equal(service.snapshot().approvals.length,2);
  service.resolveApproval({params:{threadId:'owned-thread',requestId:20}},{client:codex});assert.equal(service.snapshot().approvals.length,1);assert.equal(service.store.request(r.id).status,'waiting_input');
  service.store.update(r.id,{status:'completed'});service.resolveApproval({params:{threadId:'owned-thread',requestId:20}},{client:other});
  assert.equal(service.snapshot().approvals.length,0);assert.equal(service.store.request(r.id).status,'completed');assert.equal(other.responses.length,0);
});

test('review denials preserve exact person and room attribution without pretending to grant permission',t=>{
  const {service,codex}=setup(t),room=service.chat.addRoom({project_id:service.store.projects()[0].id,title:'Review room'}),member=service.chat.addMember({name:'Review member',adapter:'mailbox'});
  service.chat.join(room.id,member.id);const message=service.chat.store.post({room_id:room.id,to_member_id:member.id,text:'Inspect the project',idempotency_key:'review-fixture'});
  const event=status=>({params:{threadId:'owned-thread',turnId:'turn',reviewId:'review',completedAtMs:1000,action:{type:'command',command:'fixture command'},review:{status,riskLevel:'high',rationale:'authorization required'}}});
  service.onApprovalReview(message.id,event('approved'));assert.equal(service.snapshot().approval_reviews.length,0);
  service.onApprovalReview(message.id,event('denied'));service.onApprovalReview(message.id,event('denied'));
  const reviews=service.snapshot().approval_reviews;assert.equal(reviews.length,1);assert.equal(reviews[0].room_id,room.id);assert.equal(reviews[0].member_id,member.id);assert.equal(reviews[0].request_id,message.id);assert.equal(reviews[0].source,'native_auto_review');
  assert.equal(service.snapshot().approvals.length,0);assert.equal(codex.responses.length,0);assert.equal(service.chat.store.message(message.id).status,'queued');
  service.onApprovalReview(message.id,event('approved'));assert.equal(service.snapshot().approval_reviews.length,0);
});

test('answering one of several pending choices does not mark the whole task running',t=>{
  const {service,r}=setup(t);for(const rpcId of [31,32])service.onApproval(r.id,{id:rpcId,method:'item/commandExecution/requestApproval',params:{threadId:'owned-thread',command:'fixture action'}},'read-only');
  const [first,last]=service.snapshot().approvals;service.respondApproval(first.id,{decision:'decline'});assert.equal(service.store.request(r.id).status,'waiting_input');
  service.respondApproval(last.id,{decision:'decline'});assert.equal(service.store.request(r.id).status,'running');
});

test('denial notes expire instead of becoming permanent to-do items, and a bare CLI denial is not shown as a command',t=>{
  const {service}=setup(t),room=service.chat.addRoom({project_id:service.store.projects()[0].id,title:'Expiry room'}),member=service.chat.addMember({name:'Expiry member',adapter:'mailbox'});
  service.chat.join(room.id,member.id);const message=service.chat.store.post({room_id:room.id,to_member_id:member.id,text:'Inspect',idempotency_key:'expiry-fixture'});
  const start=Date.now();service.onPermissionDenials(message.id,[{tool_name:'denied'}],{room_id:room.id,member_id:member.id});
  const [review]=service.snapshot().approval_reviews;assert.equal(review.command,'受限操作');assert.equal(review.source,'native_permissions');
  t.mock.method(Date,'now',()=>start+23*3600*1000);assert.equal(service.snapshot().approval_reviews.length,1);
  t.mock.method(Date,'now',()=>start+25*3600*1000);assert.equal(service.snapshot().approval_reviews.length,0);
  service.onPermissionDenials(message.id,[{tool_name:'Bash'}],{room_id:room.id,member_id:member.id});assert.equal(service.snapshot().approval_reviews[0].command,'Bash');
});
