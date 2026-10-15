'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {VERSION,RoomError}=require('./util.cjs');
async function approvals(dir,options={}){
  const {readControl,apiCall}=options,control=readControl(dir);
  const unavailable=reason=>({schema:'agentoffice.approvals',available:false,running:false,reason,approvals:null,approval_reviews:null,read_only:true});
  if(!control)return unavailable('not_running');
  let state;try{state=await apiCall(dir,'/api/state',undefined,3000);}catch(error){if(['not_running','ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','TimeoutError'].includes(error.cause?.code||error.code||error.name))return unavailable('service_unreachable');throw error;}
  if(control.instance_id&&state.instance_id!==control.instance_id)throw new RoomError('服务与保存的实例身份不匹配，未读取另一个实例。',409,'instance_control_mismatch');
  return {schema:'agentoffice.approvals',available:true,running:true,instance_id:state.instance_id,approvals:state.approvals||[],approval_reviews:state.approval_reviews||[],read_only:true};
}
async function selftest(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-selftest-')),projectPath=path.join(root,'project'),checks=[],responses=[];let service;
  const check=async(name,callback)=>{const started=Date.now();try{await callback();checks.push({name,status:'ok',duration_ms:Date.now()-started});}catch(error){checks.push({name,status:'failed',error:error.message,duration_ms:Date.now()-started});throw error;}};
  const codex={executable:'selftest-fake-client',respond:(id,value)=>responses.push({id,value}),close:async()=>{},run:async()=>{throw new Error('Selftest cannot start a model turn.');}},vault={status:()=>({configured:false}),get:()=>{throw new Error('Selftest cannot read provider credentials.');}};
  let outcome;
  try{
    fs.mkdirSync(projectPath);fs.writeFileSync(path.join(projectPath,'README.md'),'Isolated Agent Office selftest.');
    const {RoomService}=require('./service.cjs');service=new RoomService(path.join(root,'data'),{codex,vault,fetch:async()=>{throw new Error('Selftest upstream traffic is disabled.');},launch:{discover:()=>{throw new Error('Selftest client discovery is disabled.');}}});
    const project=service.addProject({path:projectPath,name:'Selftest'}),room=service.chat.addRoom({project_id:project.id,title:'Fake client office'}),member=service.chat.addMember({name:'Selftest fake mailbox',adapter:'mailbox'});service.chat.join(room.id,member.id);
    const connection=await service.chat.connect(member.id,room.id);service.chat.completeInvite(connection.invite.id,connection.invite.nonce,member.id);
    const task=service.chat.store.post({room_id:room.id,sender_id:'user',to_member_id:member.id,text:'Fake approval request',idempotency_key:'selftest-approval'}),context={client:codex,room_id:room.id,member_id:member.id,update:fields=>{if(fields.status)service.chat.store.updateMessage(task.id,{status:fields.status==='running'?'processing':fields.status});}};
    await check('approval',()=>{service.onApproval(task.id,{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'selftest-thread',command:'fake action',availableDecisions:['accept','decline']}},'read-only',context);const pending=service.snapshot().approvals;assert.equal(pending.length,1);assert.equal(service.chat.store.message(task.id).status,'waiting_input');service.respondApproval(pending[0].id,{decision:'decline'});assert.deepEqual(responses.at(-1),{id:1,value:{decision:'decline'}});assert.equal(service.approvals.size,0);});
    await check('permission-review',()=>{service.onApproval(task.id,{id:2,method:'item/fileChange/requestApproval',params:{threadId:'selftest-thread'}},'read-only',context);assert.equal(responses.at(-1).value.decision,'decline');const review=service.snapshot().approval_reviews[0];assert.equal(review.member_id,member.id);assert.equal(review.room_id,room.id);assert.equal(review.status,'denied');});
    await check('secretary-dispatch',()=>{const role=service.secretary.set({room_id:room.id,member_id:member.id});assert.equal(role.status,'ready');const input={room_id:room.id,goal:'Inspect this isolated fake office',expected_member_id:member.id,expected_assignment_id:role.assignment_id},first=service.secretary.start(input),second=service.secretary.start(input);assert.equal(first.message.id,second.message.id);assert.equal(first.message.to_member_id,member.id);assert.equal(first.message.status,'queued');service.secretary.set({room_id:room.id,reset:true});});
    await check('room-deletion',()=>{const empty=service.chat.addRoom({project_id:project.id,title:'Disposable selftest office'}),{deletionPreview,deleteRoom}=require('./room-lifecycle.cjs');assert.equal(deletionPreview(service,empty.id).tasks.length,0);assert.equal(deleteRoom(service,empty.id).status,'deleted');assert.ok(service.chat.store.rooms().some(value=>value.id===room.id));});
    outcome={schema:'agentoffice.selftest',version:VERSION,ok:true,isolated:true,real_models_called:false,checks};
  }catch(error){outcome={schema:'agentoffice.selftest',version:VERSION,ok:false,isolated:true,real_models_called:false,error:error.message,checks};}
  finally{try{await service?.close();}finally{const target=path.resolve(root);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('agentoffice-selftest-'))throw new Error('Refusing cleanup outside the selftest fixture.');fs.rmSync(target,{recursive:true,force:true});}}
  return outcome;
}
module.exports={approvals,selftest};
