'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {CodexClient}=require('../src/codex.cjs'),{fixture}=require('./helpers.cjs'),{id,normalizePath}=require('../src/util.cjs');
test('native automatic review survives resuming a person while retaining filesystem boundaries and scoped events',async t=>{
  const f=fixture(),log=path.join(f.root,'review-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log]});t.after(()=>client.close());
  const project={id:id(),name:'Review fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion={id:id(),title:'Review person',binding_state:'new',thread_id:null},events=[],progress=[],resolved=[];
  const run=()=>client.run({project,discussion,request:{id:id(),sender:'user',prompt:'Inspect project'},onBinding:(state,thread)=>{discussion.binding_state=state;if(thread)discussion.thread_id=thread;},onTurn:()=>{},onProgress:p=>progress.push(p),onApproval:()=>{},onReview:m=>events.push(m),onApprovalResolved:m=>resolved.push(m),signal:new AbortController().signal});
  const first=await run(),second=await run();assert.equal(first.threadId,second.threadId);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),bindings=calls.filter(m=>['thread/start','thread/resume','turn/start'].includes(m.method));
  assert.equal(bindings.filter(m=>m.method==='thread/start').length,1);assert.equal(bindings.filter(m=>m.method==='thread/resume').length,1);
  for(const m of bindings){assert.equal(m.params.approvalPolicy,'on-request');assert.equal(m.params.approvalsReviewer,'auto_review');if(m.method==='turn/start')assert.deepEqual(m.params.sandboxPolicy,{type:'readOnly'});else assert.equal(m.params.sandbox,'read-only');}
  assert.equal(events.length,4);assert.ok(events.every(m=>m.params.threadId===first.threadId));assert.equal(resolved.length,2);
  assert.equal(progress.filter(p=>p.includes('操作检查未通过')).length,2);assert.ok(!progress.some(p=>p.includes('another-conversation')));
  assert.equal(calls.some(m=>m.method==='thread/approveGuardianDeniedAction'),false);assert.equal(client.listenerCount('notification'),0);
});

test('waiting for a real manual choice does not consume the model execution deadline or replay the task',async t=>{
  const f=fixture(),log=path.join(f.root,'waiting-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log,'--wait-approval']});t.after(()=>client.close());
  const waiting=[];
  const answer=await client.run({project:{id:id(),name:'Wait fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'Person',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'Inspect'},timeout:150,onBinding:()=>{},onTurn:()=>{},onProgress:()=>{},onApproval:m=>{waiting.push(m.id);setTimeout(()=>client.respond(m.id,{decision:'accept'}),400);},signal:new AbortController().signal});
  assert.equal(answer.answer,'fixture approved answer');assert.deepEqual(waiting,[71]);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(m=>m.method==='turn/start').length,1);assert.equal(calls.some(m=>m.method==='turn/interrupt'),false);assert.equal(client.listenerCount('approval-response'),0);
});

test('cancelling during a paused manual choice is bounded even when native completion never arrives',async t=>{
  const f=fixture(),log=path.join(f.root,'cancel-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log,'--wait-approval']});t.after(()=>client.close());const abort=new AbortController();
  await assert.rejects(client.run({project:{id:id(),name:'Cancel fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'Person',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'Inspect'},timeout:150,onBinding:()=>{},onTurn:()=>{},onProgress:()=>{},onApproval:()=>abort.abort(),signal:abort.signal}),{code:'outcome_uncertain'});
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(m=>m.method==='turn/start').length,1);assert.equal(calls.filter(m=>m.method==='turn/interrupt').length,1);assert.equal(client.listenerCount('approval-response'),0);
});

test('stale-turn and unscoped native approvals cannot ask the current person or suspend its deadline',async t=>{
  const f=fixture(),log=path.join(f.root,'stale-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log,'--stale-approvals']});t.after(()=>client.close());let asked=0;
  const result=await client.run({project:{id:id(),name:'Scope fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'Person',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'Inspect'},timeout:150,onBinding:()=>{},onTurn:()=>{},onProgress:()=>{},onApproval:()=>asked++,signal:new AbortController().signal});
  assert.equal(result.answer,'fixture answer');assert.equal(asked,0);assert.equal(client.listenerCount('approval-response'),0);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),rejection=calls.filter(m=>m.id===92&&!m.method);
  assert.equal(rejection.length,1);assert.equal(rejection[0].error.code,-32602);assert.equal(rejection[0].result,undefined);
});

test('a failed manual approval callback stops safely instead of crashing or waiting forever',async t=>{
  const f=fixture(),log=path.join(f.root,'callback-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log,'--wait-approval']});t.after(()=>client.close());
  await assert.rejects(client.run({project:{id:id(),name:'Callback fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'Person',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'Inspect'},timeout:150,onBinding:()=>{},onTurn:()=>{},onProgress:()=>{},onApproval:()=>{throw Error('private callback fixture');},signal:new AbortController().signal}),error=>error.code==='outcome_uncertain'&&!error.message.includes('private callback fixture'));
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(m=>m.method==='turn/start').length,1);assert.equal(calls.some(m=>m.id===71&&m.result?.decision==='accept'),false);assert.equal(client.listenerCount('request'),0);
});

test('cancellation settles before a delayed turn acknowledgement and never applies that acknowledgement later',async t=>{
  const f=fixture(),log=path.join(f.root,'late-ack-rpc.jsonl'),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-review-app-server.cjs'),log,'--wait-approval','--hold-start-ack']});t.after(()=>client.close());const abort=new AbortController(),turns=[],start=Date.now();
  await assert.rejects(client.run({project:{id:id(),name:'Ack fixture',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'Person',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'Inspect'},timeout:150,onBinding:()=>{},onTurn:turn=>turns.push(turn),onProgress:()=>{},onApproval:()=>abort.abort(),signal:abort.signal}),{code:'outcome_uncertain'});
  assert.ok(Date.now()-start<1200,'Cancellation waited for the late RPC acknowledgement');assert.equal(turns.length,1);assert.equal(client.pending.size,0);
});

test('a human choice before the start acknowledgement can outlast the RPC deadline without interrupting or replaying',async t=>{
  const client=new CodexClient({executable:process.execPath,isolate:false}),sent=[];
  client.bind=async()=> 'owned-thread';
  client.child={stdin:{writable:true,write:line=>sent.push(JSON.parse(line))}};
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let outcome='pending';const run=client.run({project:{access:'read-only',path:process.cwd()},discussion:{},request:{id:'task',prompt:'fixture'},onBinding(){},onTurn(){},onProgress(){},onApproval(){},signal:new AbortController().signal,timeout:150}).then(value=>{outcome='completed';return value;},error=>{outcome=error.code;throw error;});
  run.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
  client.emit('notification',{method:'turn/started',params:{threadId:'owned-thread',turn:{id:'turn'}}});
  client.emit('request',{id:71,method:'item/commandExecution/requestApproval',params:{threadId:'owned-thread',turnId:'turn'}});
  t.mock.timers.tick(31000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(outcome,'pending');assert.equal(client.pending.size,1);
  client.respond(71,{decision:'decline'});
  client.emit('notification',{method:'item/completed',params:{threadId:'owned-thread',turnId:'turn',item:{id:'answer',type:'agentMessage',text:'Safely stopped',phase:'final_answer'}}});
  client.emit('notification',{method:'turn/completed',params:{threadId:'owned-thread',turn:{id:'turn',status:'completed'}}});
  assert.equal((await run).answer,'Safely stopped');assert.equal(outcome,'completed');assert.equal(client.pending.size,0);
  assert.equal(sent.filter(m=>m.method==='turn/start').length,1);assert.equal(sent.some(m=>m.method==='turn/interrupt'),false);
  assert.equal(client.listenerCount('approval-response'),0);
});

test('a missing turn acknowledgement without a human wait still reaches the execution deadline',async t=>{
  const client=new CodexClient({executable:process.execPath,isolate:false}),sent=[];
  client.bind=async()=> 'owned-thread';client.child={stdin:{writable:true,write:line=>sent.push(JSON.parse(line))}};
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const run=client.run({project:{access:'read-only',path:process.cwd()},discussion:{},request:{id:'task',prompt:'fixture'},onBinding(){},onTurn(){},onProgress(){},onApproval(){},signal:new AbortController().signal,timeout:150});
  const rejected=assert.rejects(run,{code:'outcome_uncertain'});await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(151);await rejected;
  assert.equal(client.pending.size,0);assert.equal(sent.filter(m=>m.method==='turn/start').length,1);assert.equal(client.listenerCount('request'),0);
});
