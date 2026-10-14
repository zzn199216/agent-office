'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const{CodexClient}=require('../src/codex.cjs');const{fixture}=require('./helpers.cjs');const{id,normalizePath}=require('../src/util.cjs');
test('actual stdio client handles completion before turn/start response and preserves Unicode',async t=>{const f=fixture(),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs')]});t.after(()=>client.close());let threadId;
  const d={id:id(),title:'中文讨论',binding_state:'new',thread_id:null};
  const result=await client.run({project:{id:id(),name:'项目',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:d,request:{id:id(),sender:'grok',prompt:'中文问题'},onBinding:(state,t)=>{if(t)threadId=t;},onTurn:()=>{},onProgress:()=>{},onApproval:()=>{},signal:new AbortController().signal});assert.equal(result.answer,'中文回答');assert.equal(result.threadId,threadId);});
test('Codex transports images as native blocks and emits only fixed network progress',async t=>{
  const f=fixture(),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs')]}),progress=[];t.after(()=>client.close());
  const result=await client.run({project:{id:id(),name:'图像',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'图像',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'看图',images:[{mime:'image/png',data:'fixture-image'}]},onBinding:()=>{},onTurn:()=>{},onProgress:text=>progress.push(text),onApproval:()=>{},signal:new AbortController().signal});assert.equal(result.answer,'中文回答');assert.ok(progress.some(text=>text.includes('模型网络连接超时')));assert.doesNotMatch(progress.join('\n'),/private-fixture-key|Bearer/);assert.equal(client.listenerCount('transport-progress'),0);
});
