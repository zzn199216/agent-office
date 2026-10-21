'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fixture}=require('./helpers.cjs'),{CodexClient}=require('../src/codex.cjs'),{CodexWorkspace,workspaceConfig}=require('../src/codex-workspace.cjs'),{id,normalizePath}=require('../src/util.cjs');
async function setup(t){
  const f=fixture(),legacyHome=path.join(f.root,'personal'),script=path.join(__dirname,'fake-persistent-app-server.cjs');fs.mkdirSync(legacyHome);
  const project={id:id(),name:'项目',path:f.project,canonical:normalizePath(f.project),access:'read-only'},discussion={id:id(),title:'秘书',thread_id:null,binding_state:'new'},client=new CodexClient({executable:process.execPath,args:[script],dataDir:f.data,legacyHome});
  await client.workspace.prepare(async()=>({model:'fixture-model',model_provider:'fixture-provider',model_providers:{'fixture-provider':{name:'Fixture',base_url:'http://127.0.0.1:1',env_key:'FIXTURE_KEY',wire_api:'responses',requires_openai_auth:false}}}));
  // Exercise the migration protocol against synthetic rollouts only. Production
  // legacyClient() refuses to launch the personal authentication owner.
  const protocolLegacy=()=>{const value=new CodexClient({executable:process.execPath,args:[script],legacyHome});value.authOwnershipStatus=()=>({blocked:false});value.authenticationEnvironment=async()=>({...process.env,CODEX_HOME:legacyHome});return value;};
  client.legacyClient=protocolLegacy;const legacy=protocolLegacy();
  t.after(async()=>{await client.close();await legacy.close();});return {...f,legacyHome,project,discussion,client,legacy};
}
async function run(f,client=f.client){return client.run({project:f.project,discussion:f.discussion,request:{id:id(),sender:'user',prompt:'核查项目'},onBinding:(state,thread)=>{f.discussion.binding_state=state;if(thread)f.discussion.thread_id=thread;},onTurn:()=>{},onProgress:()=>{},onApproval:()=>{},signal:new AbortController().signal});}
const methods=home=>fs.existsSync(path.join(home,'rpc.jsonl'))?fs.readFileSync(path.join(home,'rpc.jsonl'),'utf8').trim().split('\n').map(JSON.parse).map(v=>v.method):[];
test('native protocol handshake invokes the scoped MCP tool with no model turn and retains the same binding',async t=>{
  const f=await setup(t);f.client.mcpEnvironment={AGENTROOM_MEMBER_ID:'fixture-member'};
  const handshake=()=>f.client.handshake({project:f.project,discussion:f.discussion,invitation:{id:f.discussion.id,nonce:'one-use-fixture'},onBinding:(state,thread)=>{f.discussion.binding_state=state;if(thread)f.discussion.thread_id=thread;},onProgress:()=>{},signal:new AbortController().signal});
  const first=await handshake(),second=await handshake(),calls=methods(f.client.workspace.home);assert.equal(first.local_protocol_verified,true);assert.equal(first.threadId,second.threadId);assert.equal(calls.filter(value=>value==='thread/start').length,1);assert.equal(calls.filter(value=>value==='mcpServer/tool/call').length,2);assert.equal(calls.includes('turn/start'),false);
  await assert.rejects(f.client.handshake({project:f.project,discussion:f.discussion,invitation:{id:f.discussion.id,nonce:'invalid'},onBinding:()=>{},onProgress:()=>{},signal:new AbortController().signal}),{code:'codex_mcp_setup'});
});
test('isolated stdio work reuses the same durable thread across a process restart without adding personal tasks',async t=>{
  const f=await setup(t);fs.writeFileSync(path.join(f.legacyHome,'auth.json'),'opaque-fixture-auth');const result=await run(f);assert.equal(result.answer,'中文回答');const health=await f.client.status();assert.equal(health.sessionMode,'isolated-background');assert.equal(health.sessionDirectory,path.join(f.data,'codex'));assert.deepEqual(methods(f.legacyHome),[]);assert.equal(fs.existsSync(path.join(f.legacyHome,'sessions')),false);
  const config=fs.readFileSync(path.join(health.sessionDirectory,'config.toml'),'utf8');assert.match(config,/fixture-model/);assert.match(config,/fixture-provider/);assert.doesNotMatch(config,/personal-popup|mcp_servers|hooks/);assert.equal(fs.existsSync(path.join(health.sessionDirectory,'auth.json')),false);
  await f.client.close();f.client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-persistent-app-server.cjs')],dataDir:f.data,legacyHome:f.legacyHome});t.after(()=>f.client.close());const next=await run(f);assert.equal(next.threadId,result.threadId);assert.equal((await f.client.read(next.threadId)).turns.length,2);assert.equal(fs.readFileSync(path.join(f.legacyHome,'auth.json'),'utf8'),'opaque-fixture-auth');assert.equal(methods(health.sessionDirectory).filter(v=>v==='thread/start').length,1);
});
test('an owned legacy thread retains its full history and ID before the personal copy is archived',async t=>{
  const f=await setup(t);const old=await run(f,f.legacy),before=await f.legacy.read(old.threadId);await f.legacy.close();const result=await run(f);assert.equal(result.threadId,old.threadId);const current=await f.client.read(old.threadId);assert.equal(current.turns.length,2);assert.deepEqual(current.turns[0],before.turns[0]);assert.equal(fs.existsSync(path.join(f.legacyHome,'sessions','rollout-'+old.threadId+'.jsonl')),false);assert.equal(fs.existsSync(path.join(f.legacyHome,'archived_sessions','rollout-'+old.threadId+'.jsonl')),true);assert.equal(JSON.parse(fs.readFileSync(f.client.workspace.receipt(old.threadId),'utf8')).source_archived,true);assert.equal(methods(f.client.workspace.home).filter(v=>v==='thread/start').length,0);
  const resumed=fs.readFileSync(path.join(f.client.workspace.home,'rpc.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(call=>call.method==='thread/resume'&&call.params?.path);
  assert.equal(resumed.params.approvalsReviewer,'auto_review');assert.equal(resumed.params.approvalPolicy,'on-request');assert.equal(resumed.params.sandbox,f.project.access);assert.equal(resumed.params.excludeTurns,true);
});
test('viewing a legacy binding is read-only and does not migrate, archive or start a turn',async t=>{
  const f=await setup(t);const result=await run(f,f.legacy);await f.client.ready();const before=methods(f.legacyHome),thread=await f.client.inspectBound(f.project,f.discussion);assert.equal(thread.id,result.threadId);assert.deepEqual(methods(f.legacyHome).slice(before.length),['initialize','thread/read']);assert.equal(fs.existsSync(f.client.workspace.receipt(result.threadId)),false);assert.equal(methods(f.client.workspace.home).includes('thread/resume'),false);assert.equal(methods(f.client.workspace.home).includes('turn/start'),false);
});
test('migration rejects busy or unrelated legacy threads without creating a replacement or archiving the original',async t=>{
  const f=await setup(t);const result=await run(f,f.legacy),source=path.join(f.legacyHome,'sessions','rollout-'+result.threadId+'.jsonl');const modify=patch=>{const rows=fs.readFileSync(source,'utf8').trim().split('\n').map(JSON.parse);Object.assign(rows[1].payload,patch);fs.writeFileSync(source,rows.map(JSON.stringify).join('\n')+'\n');};modify({status:{type:'active'}});await assert.rejects(run(f),e=>e.code==='codex_migration_busy');modify({status:{type:'idle'},name:'个人开发对话'});await assert.rejects(run(f),e=>e.code==='codex_migration_identity');assert.ok(fs.existsSync(source));assert.equal(methods(f.client.workspace.home).includes('thread/start'),false);assert.equal(methods(f.client.workspace.home).includes('turn/start'),false);assert.equal(methods(f.legacyHome).includes('thread/archive'),false);assert.equal(f.discussion.thread_id,result.threadId);
});
test('workspace configuration excludes personal side effects and refuses shared or unowned homes',async t=>{
  const f=fixture();assert.throws(()=>new CodexWorkspace(f.data,{legacyHome:path.join(f.data,'codex')}),e=>e.code==='codex_workspace_shared');fs.mkdirSync(path.join(f.data,'codex'),{recursive:true});fs.writeFileSync(path.join(f.data,'codex','unowned'),'keep');await assert.rejects(new CodexWorkspace(f.data,{legacyHome:path.join(f.root,'personal')}).prepare(async()=>({})),e=>e.code==='codex_workspace_owner');assert.equal(fs.readFileSync(path.join(f.data,'codex','unowned'),'utf8'),'keep');const config=workspaceConfig({model:'a\n"b',notify:['launch'],state_db:'personal',model_provider:'mine'});assert.match(config,/model = "a\\n\\"b"/);assert.doesNotMatch(config,/launch|personal/);
});
test('an incomplete migration remains blocked on retry even if Codex registered the copied thread',async t=>{
  const f=await setup(t);const old=await run(f,f.legacy);await f.client.ready();fs.writeFileSync(path.join(f.client.workspace.home,'corrupt-resume'),'fixture fault');
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(run(f),e=>e.code==='codex_migration_changed');
  assert.equal(f.client.workspace.migrationState(old.threadId).verified,false);assert.equal(methods(f.client.workspace.home).includes('turn/start'),false);assert.equal(methods(f.legacyHome).includes('thread/archive'),false);assert.equal((await f.client.inspectBound(f.project,f.discussion)).turns[0].items.length,2);
});
test('a member CLI can recover the same private workspace while inheriting its CODEX_HOME',async t=>{
  const f=await setup(t);await f.client.ready();const parent=process.env.CODEX_HOME;process.env.CODEX_HOME=f.client.workspace.home;
  try{const recovered=new CodexWorkspace(f.data);assert.equal(recovered.home,f.client.workspace.home);assert.equal(recovered.legacyHome,f.legacyHome);await recovered.prepare(()=>{throw Error('Prepared auth must not be seeded again');});}finally{if(parent===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=parent;}
});

function privateWorkspace(t,{prepared=false,config='model = "private-model"\nnotify = []\n'}={}){
  const f=fixture(),legacyHome=path.join(f.root,'personal');fs.mkdirSync(legacyHome);
  const workspace=new CodexWorkspace(f.data,{legacyHome}),home=workspace.home,marker=path.join(home,'agentoffice-workspace.json'),configFile=path.join(home,'config.toml');
  if(prepared){fs.mkdirSync(home,{recursive:true});fs.writeFileSync(marker,JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:legacyHome,credential_seeded:false,created:'original-timestamp',extra:{preserve:'owner metadata'}}));fs.writeFileSync(configFile,config);}
  t.after(()=>{const target=path.resolve(f.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});
  return {...f,legacyHome,workspace,home,marker,configFile};
}

test('workspace config retains only an explicitly selected supported Windows sandbox implementation',()=>{
  for(const mode of ['elevated','unelevated']){
    const config=workspaceConfig({model:'fixture-model',windows:{sandbox:mode,secret:'do-not-copy',other:{command:'side-effect'}},sandbox_mode:'danger-full-access',approval_policy:'never',mcp_servers:{private:{}},hooks:{Stop:['run']},notify:['personal-popup'],features:{prefer_mxc:true}});
    assert.match(config,new RegExp('windows = \\{ "sandbox" = "'+mode+'" \\}'));
    assert.doesNotMatch(config,/danger-full-access|approval_policy|never|mcp_servers|hooks|personal-popup|do-not-copy|side-effect|prefer_mxc/);assert.match(config,/notify = \[\]/);
  }
  for(const sandbox of ['danger-full-access','mxc','ELEVATED','unknown',true,null])assert.doesNotMatch(workspaceConfig({windows:{sandbox}}),/windows/);
  for(const windows of ['elevated',[],Object.create({sandbox:'elevated'})])assert.doesNotMatch(workspaceConfig({windows}),/windows/);
});

test('a new private workspace keeps its selected mode without reading or copying personal credentials',async t=>{
  const f=privateWorkspace(t);fs.writeFileSync(path.join(f.legacyHome,'auth.json'),'opaque-seed');fs.mkdirSync(path.join(f.legacyHome,'.sandbox-secrets'));fs.writeFileSync(path.join(f.legacyHome,'.sandbox-secrets','private'),'never-read');let reads=0;
  const originalRead=fs.readFileSync;fs.readFileSync=function(file,...args){if(typeof file==='string'&&(file.includes('.sandbox-secrets')||file===path.join(f.legacyHome,'auth.json')))throw Error('Personal credentials must not be read');return originalRead.call(fs,file,...args);};
  try{await f.workspace.prepare(async()=>{reads++;return {model:'fixture-model',windows:{sandbox:'unelevated'},sandbox_mode:'danger-full-access',approval_policy:'never'};});}finally{fs.readFileSync=originalRead;}
  const config=fs.readFileSync(f.configFile,'utf8');assert.match(config,/"sandbox" = "unelevated"/);assert.doesNotMatch(config,/danger-full-access|approval_policy/);assert.equal(fs.existsSync(path.join(f.home,'.sandbox-secrets')),false);assert.equal(fs.existsSync(path.join(f.home,'auth.json')),false);
  await f.workspace.prepare(()=>{throw Error('Prepared settings must not read the personal config again');});assert.equal(reads,1);assert.equal(fs.readFileSync(f.configFile,'utf8'),config);assert.equal(fs.readFileSync(path.join(f.legacyHome,'auth.json'),'utf8'),'opaque-seed');
});

test('an old credential-free owned home appends its mode once and keeps config and session identities',async t=>{
  const original='model = "independent"\nnotify = []\n[model_providers.mine]\nname = "kept provider"\n',f=privateWorkspace(t,{prepared:true,config:original});
  fs.writeFileSync(path.join(f.legacyHome,'auth.json'),'new-personal-auth');fs.mkdirSync(path.join(f.home,'sessions'));fs.mkdirSync(path.join(f.home,'imports'));const thread=id(),rollout=path.join(f.home,'sessions',thread+'.jsonl'),receipt=path.join(f.home,'imports',thread+'.json');fs.writeFileSync(rollout,'original-session');fs.writeFileSync(receipt,'original-receipt');let reads=0;
  await f.workspace.prepare(async()=>{reads++;return {windows:{sandbox:'elevated',secret:'exclude'},sandbox_mode:'danger-full-access',approval_policy:'never',notify:['launch']};});
  assert.equal(fs.readFileSync(f.configFile,'utf8'),original+'\n[windows]\nsandbox = "elevated"\n');assert.equal(fs.readFileSync(path.join(f.legacyHome,'auth.json'),'utf8'),'new-personal-auth');assert.equal(fs.readFileSync(rollout,'utf8'),'original-session');assert.equal(fs.readFileSync(receipt,'utf8'),'original-receipt');
  const marker=JSON.parse(fs.readFileSync(f.marker,'utf8'));assert.equal(marker.legacy_home,f.legacyHome);assert.equal(marker.credential_seeded,false);assert.equal(marker.created,'original-timestamp');assert.deepEqual(marker.extra,{preserve:'owner metadata'});assert.equal(marker.windows_sandbox_checked,true);
  await new CodexWorkspace(f.data,{legacyHome:f.legacyHome}).prepare(()=>{throw Error('Migration cannot repeat');});assert.equal(reads,1);
});

test('existing or unfamiliar private Windows config remains byte-for-byte and never reads a replacement mode',async t=>{
  for(const config of ['[windows]\nsandbox = "unelevated"\n','[windows]\nsandbox = "mxc"\nfuture = true\n','windows = { sandbox = "unknown", nested = { keep = true } }\n','windows.sandbox = "elevated"\n',"'windows'.'sandbox' = 'unelevated'\n",'[windows.future]\ncustom = true\n','["\\u0077indows"]\nsandbox = "unknown"\n']){
    const f=privateWorkspace(t,{prepared:true,config});await f.workspace.prepare(()=>{throw Error('User Windows config must not be overridden');});assert.equal(fs.readFileSync(f.configFile,'utf8'),config);
  }
});

test('unsupported personal modes leave an old private config unchanged and only check once',async t=>{
  for(const mode of ['danger-full-access','mxc','unknown',null]){
    const f=privateWorkspace(t,{prepared:true});const original=fs.readFileSync(f.configFile,'utf8');let reads=0;
    await f.workspace.prepare(async()=>{reads++;return {windows:{sandbox:mode},sandbox_mode:'danger-full-access',approval_policy:'never'};});await f.workspace.prepare(()=>{throw Error('No repeated setup/config request');});
    assert.equal(reads,1);assert.equal(fs.readFileSync(f.configFile,'utf8'),original);
  }
});

test('concurrent preparations share one mode read and never append duplicate Windows tables',async t=>{
  const f=privateWorkspace(t,{prepared:true});let release,reads=0;const gate=new Promise(resolve=>release=resolve),callback=async()=>{reads++;await gate;return {windows:{sandbox:'elevated'}};};
  const second=new CodexWorkspace(f.data,{legacyHome:f.legacyHome});if(process.platform==='win32')second.home=second.home.toUpperCase();const first=f.workspace.prepare(callback),other=second.prepare(callback);assert.equal(reads,1);release();await Promise.all([first,other]);
  assert.equal(reads,1);assert.equal((fs.readFileSync(f.configFile,'utf8').match(/\[windows\]/g)||[]).length,1);
});

test('a changed config or owner during the callback is preserved and stops migration',async t=>{
  const config=privateWorkspace(t,{prepared:true}),marker=fs.readFileSync(config.marker,'utf8');
  await assert.rejects(config.workspace.prepare(async()=>{fs.writeFileSync(config.configFile,'[windows]\nsandbox = "user-selected"\n');return {windows:{sandbox:'elevated'}};}),{code:'codex_workspace_config'});
  assert.equal(fs.readFileSync(config.configFile,'utf8'),'[windows]\nsandbox = "user-selected"\n');assert.equal(fs.readFileSync(config.marker,'utf8'),marker);
  const owner=privateWorkspace(t,{prepared:true}),original=fs.readFileSync(owner.configFile,'utf8'),changed={schema:'another-owner'};
  await assert.rejects(owner.workspace.prepare(async()=>{fs.writeFileSync(owner.marker,JSON.stringify(changed));return {windows:{sandbox:'elevated'}};}),{code:'codex_workspace_owner'});
  assert.deepEqual(JSON.parse(fs.readFileSync(owner.marker,'utf8')),changed);assert.equal(fs.readFileSync(owner.configFile,'utf8'),original);
});

test('failed mode reads and mismatched legacy ownership cannot alter a prepared workspace',async t=>{
  const f=privateWorkspace(t,{prepared:true}),config=fs.readFileSync(f.configFile,'utf8'),marker=fs.readFileSync(f.marker,'utf8');let reads=0;
  await assert.rejects(f.workspace.prepare(async()=>{reads++;throw Error('fixture config unavailable');}),/fixture config unavailable/);assert.equal(reads,1);assert.equal(fs.readFileSync(f.configFile,'utf8'),config);assert.equal(fs.readFileSync(f.marker,'utf8'),marker);
  const another=path.join(f.root,'other-personal');fs.mkdirSync(another);await assert.rejects(new CodexWorkspace(f.data,{legacyHome:another}).prepare(()=>{throw Error('Mismatched owner must not read config');}),{code:'codex_workspace_owner'});assert.equal(fs.readFileSync(f.marker,'utf8'),marker);
});

test('a prepared workspace with a linked home or config is not migrated through that path',async t=>{
  const f=privateWorkspace(t,{prepared:true}),external=path.join(f.root,'external');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'config.toml'),'keep external');fs.rmSync(f.configFile);fs.symlinkSync(external,f.configFile,'junction');
  await assert.rejects(f.workspace.prepare(()=>{throw Error('Linked config cannot read source settings');}),{code:'codex_workspace_path'});assert.equal(fs.readFileSync(path.join(external,'config.toml'),'utf8'),'keep external');
  const linked=privateWorkspace(t),outside=path.join(linked.root,'outside');fs.mkdirSync(outside);fs.mkdirSync(path.dirname(linked.home),{recursive:true});fs.symlinkSync(outside,linked.home,'junction');await assert.rejects(linked.workspace.prepare(()=>{throw Error('Linked home cannot read source settings');}),{code:'codex_workspace_path'});assert.deepEqual(fs.readdirSync(outside),[]);
});

test('replacing the home during a config callback cannot redirect seeding or migration',async t=>{
  for(const prepared of [false,true]){
    const f=privateWorkspace(t,{prepared}),outside=path.join(f.root,'outside'),moved=path.join(f.root,'moved-owned');fs.mkdirSync(outside);
    await assert.rejects(f.workspace.prepare(async()=>{fs.renameSync(f.home,moved);fs.symlinkSync(outside,f.home,'junction');return {windows:{sandbox:'elevated'}};}),{code:'codex_workspace_path'});
    assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(JSON.parse(fs.readFileSync(path.join(moved,'agentoffice-workspace.json'),'utf8')).prepared,prepared);
    if(prepared)assert.equal(fs.readFileSync(path.join(moved,'config.toml'),'utf8'),'model = "private-model"\nnotify = []\n');
  }
});

test('a new seed cannot overwrite ownership changed by its config callback',async t=>{
  const f=privateWorkspace(t),changed={schema:'unrelated owner'};
  await assert.rejects(f.workspace.prepare(async()=>{fs.writeFileSync(f.marker,JSON.stringify(changed));return {windows:{sandbox:'elevated'}};}),{code:'codex_workspace_owner'});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.marker,'utf8')),changed);assert.equal(fs.existsSync(f.configFile),false);assert.equal(fs.existsSync(path.join(f.home,'auth.json')),false);
});
