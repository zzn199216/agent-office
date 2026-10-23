'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const{CodexClient}=require('../src/codex.cjs');const{fixture}=require('./helpers.cjs');const{id,normalizePath}=require('../src/util.cjs');
test('private HTTP transport keeps custom provider identity and preserves built-in endpoint overrides',()=>{
  const {backgroundTransport}=require('../src/codex.cjs'),custom={model_provider:'company_proxy',model_providers:{company_proxy:{base_url:'https://fixture.invalid',env_key:'FIXTURE_KEY',supports_websockets:true}}},before=JSON.stringify(custom);
  assert.deepEqual(backgroundTransport(custom),{'model_providers.company_proxy.supports_websockets':false});assert.equal(JSON.stringify(custom),before);
  for(const provider of ['ollama','lmstudio'])assert.deepEqual(backgroundTransport({model_provider:provider}),{});
  const builtIn=backgroundTransport({openai_base_url:'https://fixture.invalid'});assert.equal(builtIn.model_provider,'agentoffice_http');assert.equal(builtIn['model_providers.agentoffice_http'].supports_websockets,false);assert.equal(builtIn['model_providers.agentoffice_http'].requires_openai_auth,true);assert.equal(builtIn['model_providers.agentoffice_http'].base_url,'https://fixture.invalid');assert.equal(builtIn['model_providers.agentoffice_http'].env_key,undefined);
});
test('cold state initialization retries once before any model turn; concurrent ready calls share it',async t=>{
  const fs=require('node:fs'),f=fixture(),marker=path.join(f.root,'start-count'),client=new CodexClient({dataDir:f.data,executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs'),'--startup-failure',marker,'once']});t.after(()=>client.close());
  const results=await Promise.all([client.ready(),client.ready()]);assert.equal(results[0].userAgent,'fake-protocol-test-only');assert.deepEqual(results[0],results[1]);assert.equal(fs.readFileSync(marker,'utf8'),'2');assert.equal(client.nextId,3);assert.equal(client.pending.size,0);
});
test('persistent SQLite startup failure is bounded; unrelated failures are never retried',async t=>{
  const fs=require('node:fs');for(const [mode,expected,count]of [['always','codex_state_init_failed',2],['generic','connection_lost',1]]){const f=fixture(),marker=path.join(f.root,'start-count'),client=new CodexClient({dataDir:f.data,executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs'),'--startup-failure',marker,mode]});t.after(()=>client.close());await assert.rejects(client.ready(),{code:expected});assert.equal(Number(fs.readFileSync(marker,'utf8')),count);assert.equal(client.pending.size,0);}
});
test('actual stdio client handles completion before turn/start response and preserves Unicode',async t=>{const f=fixture(),client=new CodexClient({dataDir:f.data,executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs')]});t.after(()=>client.close());let threadId;
  const d={id:id(),title:'中文讨论',binding_state:'new',thread_id:null};
  const result=await client.run({project:{id:id(),name:'项目',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:d,request:{id:id(),sender:'grok',prompt:'中文问题'},onBinding:(state,t)=>{if(t)threadId=t;},onTurn:()=>{},onProgress:()=>{},onApproval:()=>{},signal:new AbortController().signal});assert.equal(result.answer,'中文回答');assert.equal(result.threadId,threadId);});
test('Codex transports images as native blocks and emits only fixed network progress',async t=>{
  const f=fixture(),client=new CodexClient({dataDir:f.data,executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs')]}),progress=[];t.after(()=>client.close());
  const result=await client.run({project:{id:id(),name:'图像',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'图像',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'看图',images:[{mime:'image/png',data:'fixture-image'}]},onBinding:()=>{},onTurn:()=>{},onProgress:text=>progress.push(text),onApproval:()=>{},signal:new AbortController().signal});assert.equal(result.answer,'中文回答');assert.ok(progress.some(text=>text.includes('模型网络连接超时')));assert.doesNotMatch(progress.join('\n'),/private-fixture-key|Bearer/);assert.equal(client.listenerCount('transport-progress'),0);
});

test('public reasoning summaries stream as progress without raw reasoning or answer contamination',async t=>{
  const f=fixture(),client=new CodexClient({dataDir:f.data,executable:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs'),'--progress-summary']}),progress=[];t.after(()=>client.close());
  const result=await client.run({project:{id:id(),name:'进展',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion:{id:id(),title:'进展',binding_state:'new',thread_id:null},request:{id:id(),sender:'user',prompt:'测试公开摘要'},onBinding:()=>{},onTurn:()=>{},onProgress:text=>progress.push(text),onApproval:()=>{},signal:new AbortController().signal});
  assert.ok(progress.includes('正在核对连接状态'));assert.ok(progress.includes('准备验证结果'));assert.doesNotMatch(progress.join('\n'),/raw-private|foreign summary/);assert.equal(result.answer,'中文回答');
});
