'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const childProcess=require('node:child_process');
let spawnAttempts=0;
const forbidSpawn=()=>{spawnAttempts++;throw Error('No process may start in authentication ownership fixtures');};
const actualSpawn=childProcess.spawn,actualSpawnSync=childProcess.spawnSync;
let CodexClient,CodexWorkspace;
try{childProcess.spawn=forbidSpawn;childProcess.spawnSync=forbidSpawn;({CodexClient}=require('../src/codex.cjs'));({CodexWorkspace}=require('../src/codex-workspace.cjs'));}
finally{childProcess.spawn=actualSpawn;childProcess.spawnSync=actualSpawnSync;}
const typed=code=>error=>error?.code===code&&error.status===409;

function fixture(t,{prepared=true,seeded=false,privateAuth,sourceAuth='opaque-personal-fixture-only'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-auth-ownership-')),personal=path.join(root,'personal'),data=path.join(root,'data'),home=path.join(data,'codex'),project=path.join(root,'project'),marker=path.join(home,'agentoffice-workspace.json');
  fs.mkdirSync(personal,{recursive:true});fs.mkdirSync(project);fs.mkdirSync(data);
  const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
  write(path.join(personal,'config.toml'),'model = "personal-fixture-routing"\nnotify = ["never-run"]\n');
  if(sourceAuth!==null)write(path.join(personal,'auth.json'),sourceAuth);
  if(prepared){
    write(marker,JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:personal,credential_seeded:seeded,windows_sandbox_checked:true,created:'original-owned-timestamp',extra:{keep:true}}));
    write(path.join(home,'config.toml'),'model = "independent-fixture-routing"\nnotify = []\n[mcp_servers.existing]\ncommand = "preserve-mcp-command"\n');
    write(path.join(home,'sessions','fixture-session.jsonl'),'original fictional session bytes\n');
    write(path.join(home,'imports','11111111-2222-4333-8444-555555555555.json'),'original fictional import receipt\n');
    write(path.join(data,'bindings.fixture.json'),'original fictional durable member/thread binding\n');
    write(path.join(data,'client-config','fixture-mcp.json'),'original fictional MCP configuration\n');
  }
  if(privateAuth!==undefined)write(path.join(home,'auth.json'),privateAuth);
  t.after(()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentoffice-auth-ownership-/);fs.rmSync(target,{recursive:true,force:true});});
  const client=()=>new CodexClient({executable:path.join(root,'never-executed-codex.exe'),dataDir:data,legacyHome:personal});
  return {root,personal,data,home,project,marker,client,write};
}
function bytes(folder){
  const values=[];
  function walk(current){for(const name of fs.readdirSync(current).sort()){const file=path.join(current,name),stat=fs.lstatSync(file,{bigint:true}),relative=path.relative(folder,file);if(stat.isSymbolicLink()){values.push({path:relative,link:fs.readlinkSync(file)});continue;}if(stat.isDirectory()){values.push({path:relative,directory:true});walk(file);}else values.push({path:relative,size:String(stat.size),modified:String(stat.mtimeNs),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}}
  walk(folder);return values;
}
async function noAuthenticationIO(work){
  const isAuth=file=>typeof file==='string'&&path.basename(file).toLowerCase()==='auth.json',saved={},count={reads:0,writes:0};
  for(const name of ['readFileSync','openSync','writeFileSync','unlinkSync','createReadStream','copyFileSync','renameSync']){
    const original=fs[name];saved[name]=original;
    fs[name]=function(...args){const touched=isAuth(args[0])||['copyFileSync','renameSync'].includes(name)&&isAuth(args[1]);if(touched){count[['readFileSync','openSync','createReadStream','copyFileSync'].includes(name)?'reads':'writes']++;throw Error('Authentication bytes must remain untouched');}return original.apply(fs,args);};
  }
  try{await work();assert.deepEqual(count,{reads:0,writes:0});}
  finally{for(const [name,value] of Object.entries(saved))fs[name]=value;}
}
function request(f){return {project:{id:'fixture-project',name:'Fixture',path:f.project,canonical:f.project,access:'read-only'},discussion:{id:'fixture-room',title:'Fixture person',thread_id:'11111111-2222-4333-8444-555555555555',binding_state:'bound'},invitation:{id:'fixture-invitation',nonce:'fixture-nonce'},request:{id:'fixture-request',sender:'user',prompt:'Must never reach a model'},signal:new AbortController().signal,onBinding:()=>assert.fail('A blocked owner cannot change a binding'),onTurn:()=>assert.fail('A blocked owner cannot start a turn'),onProgress:()=>{},onApproval:()=>assert.fail('A blocked owner cannot request permission')};}

test('workspace diagnostics report only private legacy auth existence for manual removal without authentication IO or process starts',async t=>{
  for(const privateAuth of [undefined,'SYNTHETIC SEEDED AUTH - NEVER READ']){
    const f=fixture(t,{seeded:true,privateAuth}),client=f.client(),before=bytes(f.root),start=spawnAttempts,auth=path.join(f.home,'auth.json'),lstat=fs.lstatSync,observed=[];
    fs.lstatSync=function(file,...args){if(typeof file==='string'&&path.basename(file).toLowerCase()==='auth.json'){assert.equal(file,auth);observed.push(file);}return lstat.call(this,file,...args);};
    try{await noAuthenticationIO(async()=>{assert.deepEqual(client.diagnostics(),{legacySeededAuth:{path:auth,present:privateAuth!==undefined,manualRemovalRequired:privateAuth!==undefined}});});}finally{fs.lstatSync=lstat;}
    assert.deepEqual(observed,[auth]);assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
  }
});

test('workspace diagnostics report unknown for linked homes and inaccessible auth metadata without following credential targets',async t=>{
  const f=fixture(t),auth=path.join(f.home,'auth.json'),lstat=fs.lstatSync;
  fs.lstatSync=function(file,...args){if(file===auth)throw Object.assign(new Error('Synthetic metadata denied'),{code:'EACCES'});return lstat.call(this,file,...args);};
  try{await noAuthenticationIO(async()=>{assert.deepEqual(f.client().diagnostics().legacySeededAuth,{path:auth,present:null,manualRemovalRequired:null,error:'EACCES'});});}finally{fs.lstatSync=lstat;}
  const linked=fixture(t,{prepared:false});fs.symlinkSync(linked.personal,linked.home,'junction');
  await noAuthenticationIO(async()=>{assert.deepEqual(linked.client().diagnostics().legacySeededAuth,{path:path.join(linked.home,'auth.json'),present:null,manualRemovalRequired:null,error:'codex_workspace_path'});});
});

test('a previously seeded workspace is rejected without reading source or private authentication or changing durable files',async t=>{
  const f=fixture(t,{seeded:true}),before=bytes(f.root),start=spawnAttempts,workspace=new CodexWorkspace(f.data,{legacyHome:f.personal});let configReads=0;
  await noAuthenticationIO(async()=>{assert.throws(()=>workspace.assertAuthenticationOwner(),typed('codex_auth_ownership_required'));await assert.rejects(workspace.prepare(async()=>{configReads++;return{};}),typed('codex_auth_ownership_required'));});
  assert.equal(configReads,0);assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
});

test('any existing private auth stays paused including an empty, invalid or independently refreshed file',async t=>{
  for(const privateAuth of ['', 'not-json-fixture', 'independent-refresh-fixture']){
    const f=fixture(t,{privateAuth}),before=bytes(f.root),client=f.client(),start=spawnAttempts;
    await noAuthenticationIO(async()=>{const status=client.authOwnershipStatus();assert.equal(typeof status.then,'undefined');assert.equal(status.blocked,true);assert.equal(status.code,'codex_auth_ownership_required');await assert.rejects(client.ready(),typed('codex_auth_ownership_required'));await assert.rejects(client.authenticationEnvironment({purpose:'login'}),typed('codex_auth_ownership_required'));});
    assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
  }
});

test('ready, status, handshake, run and direct startServer reject before spawn, RPCs or binding changes on every repeat',async t=>{
  const f=fixture(t,{seeded:true,privateAuth:'opaque-copied-fixture'}),before=bytes(f.root),client=f.client(),input=request(f),start=spawnAttempts;let rpcCalls=0;
  client.call=async()=>{rpcCalls++;assert.fail('Ownership rejection precedes all protocol calls');};
  const entries=[()=>client.ready(),()=>client.status(),()=>client.authenticationEnvironment(),()=>client.authenticationEnvironment({purpose:'login'}),()=>client.connect(),()=>client.startServer({CODEX_HOME:f.home}),()=>client.handshake(input),()=>client.run(input),()=>client.read(input.discussion.thread_id),()=>client.list(input.project)];
  await noAuthenticationIO(async()=>{for(let attempt=0;attempt<2;attempt++)for(const entry of entries)await assert.rejects(entry(),typed('codex_auth_ownership_required'));});
  assert.equal(rpcCalls,0);assert.equal(spawnAttempts,start);assert.equal(client.child,null);assert.equal(client.pending.size,0);assert.deepEqual(bytes(f.root),before);
});

test('cached ready transport and authentication invalidation cannot bypass ownership or terminate an active owned child',async t=>{
  const f=fixture(t,{seeded:true}),before=bytes(f.root),client=f.client(),start=spawnAttempts,child={stdin:{end:()=>assert.fail('Do not stop the active child')},kill:()=>assert.fail('Do not kill the active child')};
  client.child=child;client.readyPromise=Promise.resolve({userAgent:'cached fixture'});client.invalidateAuthentication();const listener=()=>{};client.on('notification',listener);
  await noAuthenticationIO(async()=>{await assert.rejects(client.ready(),typed('codex_auth_ownership_required'));await assert.rejects(client.status(),typed('codex_auth_ownership_required'));});
  assert.equal(client.child,child);assert.equal(client.authenticationDirty,true);assert.equal(client.listenerCount('notification'),1);assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
});

test('a new private workspace never copies personal auth or launches a legacy server to discover configuration',async t=>{
  const f=fixture(t,{prepared:false}),client=f.client(),personalBefore=bytes(f.personal),start=spawnAttempts,parent=process.env.CODEX_HOME;
  await noAuthenticationIO(async()=>{assert.deepEqual(client.authOwnershipStatus(),{blocked:false});const env=await client.authenticationEnvironment();assert.equal(env.CODEX_HOME,f.home);assert.equal(process.env.CODEX_HOME,parent);assert.deepEqual(client.authOwnershipStatus(),{blocked:false});});
  assert.equal(fs.existsSync(path.join(f.home,'auth.json')),false);assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.personal),personalBefore);
  const state=JSON.parse(fs.readFileSync(f.marker,'utf8'));assert.equal(state.credential_seeded,false);assert.equal(state.authentication_policy,'no-personal-credential-copy-v1');const config=fs.readFileSync(path.join(f.home,'config.toml'),'utf8');assert.doesNotMatch(config,/personal-fixture-routing|never-run|mcp_servers/);
});

test('even a clean new private home cannot open another login and the synchronous personal-home status is blocked',async t=>{
  const f=fixture(t,{prepared:false}),client=f.client(),before=bytes(f.root),start=spawnAttempts,personal=new CodexClient({executable:path.join(f.root,'never-executed-codex.exe'),isolate:false,legacyHome:f.personal});
  await noAuthenticationIO(async()=>{await assert.rejects(client.authenticationEnvironment({purpose:'login'}),typed('codex_auth_ownership_required'));assert.deepEqual(personal.authOwnershipStatus().blocked,true);assert.equal(personal.authOwnershipStatus().code,'codex_personal_auth_owner_conflict');assert.throws(()=>client.legacyClient(),typed('codex_personal_auth_owner_conflict'));assert.throws(()=>personal.legacyClient(),typed('codex_personal_auth_owner_conflict'));await assert.rejects(personal.ready(),typed('codex_personal_auth_owner_conflict'));await assert.rejects(personal.startServer({CODEX_HOME:f.personal}),typed('codex_personal_auth_owner_conflict'));});
  assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
});

test('unknown or malformed ownership markers fail closed before any auth read or process start',async t=>{
  for(const marker of [JSON.stringify({schema:'unrelated-owner',version:1,prepared:true,legacy_home:'not-owned'}),'{malformed-marker']){
    const f=fixture(t),client=f.client();fs.writeFileSync(f.marker,marker);const before=bytes(f.root),start=spawnAttempts;
    await noAuthenticationIO(async()=>{const status=client.authOwnershipStatus();assert.equal(status.blocked,true);assert.equal(status.code,'codex_workspace_owner');await assert.rejects(client.ready(),typed('codex_workspace_owner'));await assert.rejects(client.workspace.prepare(async()=>assert.fail('An unknown marker cannot request config')),typed('codex_workspace_owner'));});
    assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
  }
});

test('inherited private CODEX_HOME keeps the original owner and cannot convert seeded auth into a personal-server fallback',async t=>{
  const f=fixture(t,{seeded:true}),before=bytes(f.root),parent=process.env.CODEX_HOME,start=spawnAttempts;
  process.env.CODEX_HOME=f.home;
  try{await noAuthenticationIO(async()=>{const client=new CodexClient({executable:path.join(f.root,'never-executed-codex.exe'),dataDir:f.data});assert.equal(client.workspace.legacyHome,f.personal);assert.equal(client.authOwnershipStatus().code,'codex_auth_ownership_required');await assert.rejects(client.status(),typed('codex_auth_ownership_required'));assert.throws(()=>client.legacyClient(),typed('codex_personal_auth_owner_conflict'));});}
  finally{if(parent===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=parent;}
  assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
});

test('linked private homes and canonical aliases cannot authorize the personal authentication owner',async t=>{
  const linked=fixture(t,{prepared:false}),aliasHome=path.join(linked.data,'codex');fs.symlinkSync(linked.personal,aliasHome,'junction');const before=bytes(linked.root),start=spawnAttempts;
  await noAuthenticationIO(async()=>{const client=linked.client();assert.equal(client.authOwnershipStatus().code,'codex_workspace_path');await assert.rejects(client.ready(),typed('codex_workspace_path'));});assert.deepEqual(bytes(linked.root),before);
  const aliased=fixture(t,{sourceAuth:null}),alias=path.join(aliased.root,'personal-alias');fs.symlinkSync(aliased.home,alias,'junction');const client=new CodexClient({executable:path.join(aliased.root,'never-executed-codex.exe'),dataDir:aliased.data,legacyHome:alias}),aliasBefore=bytes(aliased.root);
  await noAuthenticationIO(async()=>{assert.equal(client.authOwnershipStatus().code,'codex_workspace_shared');await assert.rejects(client.authenticationEnvironment(),typed('codex_workspace_shared'));});assert.equal(spawnAttempts,start);assert.deepEqual(bytes(aliased.root),aliasBefore);
});

test('a dangling auth path is still an existing private credential boundary and is never followed or replaced',async t=>{
  const f=fixture(t),outside=path.join(f.root,'removed-target'),target=path.join(f.home,'auth.json');fs.mkdirSync(outside);fs.symlinkSync(outside,target,'junction');fs.rmdirSync(outside);assert.equal(fs.lstatSync(target).isSymbolicLink(),true);assert.equal(fs.existsSync(target),false);const before=bytes(f.root),client=f.client(),start=spawnAttempts;
  await noAuthenticationIO(async()=>{assert.equal(client.authOwnershipStatus().code,'codex_auth_ownership_required');await assert.rejects(client.ready(),typed('codex_auth_ownership_required'));await assert.rejects(client.authenticationEnvironment({purpose:'login'}),typed('codex_auth_ownership_required'));});
  assert.equal(spawnAttempts,start);assert.deepEqual(bytes(f.root),before);
});
