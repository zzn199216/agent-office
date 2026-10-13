'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const{CodexClient}=require('../src/codex.cjs');const{fixture}=require('./helpers.cjs');const{id,normalizePath}=require('../src/util.cjs');
test('actual stdio client handles completion before turn/start response and preserves Unicode',async t=>{const f=fixture(),client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs')]});t.after(()=>client.close());let threadId;
  const d={id:id(),title:'中文讨论',binding_state:'new',thread_id:null};
  const result=await client.run({project:{id:id(),name:'项目',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:d,request:{id:id(),sender:'grok',prompt:'中文问题'},onBinding:(state,t)=>{if(t)threadId=t;},onTurn:()=>{},onProgress:()=>{},onApproval:()=>{},signal:new AbortController().signal});assert.equal(result.answer,'中文回答');assert.equal(result.threadId,threadId);});
