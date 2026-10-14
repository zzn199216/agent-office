'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DiscoveryCatalog,qwenVendorScript,geminiVendorScript}=require('../src/discovery.cjs');
const fixedTime='2026-10-12T05:20:00.000Z';
function scanner(overrides={}){const files=new Set(overrides.files||[]);return new DiscoveryCatalog({platform:'win32',env:{USERPROFILE:'C:\\Users\\Fixture',LOCALAPPDATA:'C:\\Users\\Fixture\\Local',APPDATA:'C:\\Users\\Fixture\\Roaming',PATH:'C:\\Tools'},fileExists:file=>files.has(file),listFiles:()=>[],processInventory:()=>[],now:()=>fixedTime,...overrides});}
const find=(result,provider)=>result.candidates.find(c=>c.provider===provider);

test('desktop presence and native managed entrypoint remain distinct from handshake and live conversations',()=>{
  const desktop='C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\Codex.exe';
  const result=scanner({files:[desktop],processInventory:()=>[{Name:'Codex.exe',ProcessId:101,ExecutablePath:desktop,CommandLine:'"'+desktop+'"'}]}).scan();
  const codex=find(result,'codex');assert.equal(result.scanned_at,fixedTime);assert.equal(codex.running,true);assert.equal(codex.installed,true);assert.equal(codex.executable,null);assert.equal(codex.capabilities.automatic_launch,false);assert.equal(codex.capabilities.attach_existing,false);assert.equal(codex.identity.handshake_verified,false);assert.equal(codex.support,'needs_setup');assert.equal(codex.instances[0].role,'desktop');
  const ready=find(scanner({files:['C:\\Tools\\codex.exe']}).scan(),'codex');assert.equal(ready.capabilities.automatic_launch,true);assert.equal(ready.support,'ready');assert.equal(ready.running,false);assert.equal(ready.identity.handshake_verified,false);
});

test('products aggregate sessions while Electron workers and managed app-server processes are excluded',()=>{
  const exe='C:\\Tools\\codex.exe',cursor='C:\\Apps\\Cursor.exe';
  const result=scanner({files:[exe,cursor],processInventory:()=>[
    {Name:'codex.exe',ProcessId:1,ExecutablePath:exe,CommandLine:'codex'},
    {Name:'codex.exe',ProcessId:2,ExecutablePath:exe,CommandLine:'codex resume'},
    {Name:'codex.exe',ProcessId:3,ExecutablePath:exe,CommandLine:'codex app-server --listen stdio://'},
    {Name:'Cursor.exe',ProcessId:4,ExecutablePath:cursor,CommandLine:'Cursor'},
    {Name:'Cursor.exe',ProcessId:5,ParentProcessId:4,ExecutablePath:cursor,CommandLine:'Cursor --type=renderer'},
    {Name:'Cursor.exe',ProcessId:6,ParentProcessId:4,ExecutablePath:cursor,CommandLine:'Cursor --type=gpu-process'}
  ]}).scan();
  assert.equal(result.candidates.filter(c=>c.provider==='codex').length,1);assert.deepEqual(find(result,'codex').pids,[1,2]);assert.deepEqual(find(result,'cursor').pids,[4]);assert.equal(find(result,'cursor').capabilities.automatic_launch,false);
});

test('node-hosted Claude identity is recognized internally and secrets or unrelated node processes never escape',()=>{
  const secret='fixture-provider-secret-do-not-return';
  const result=scanner({processInventory:()=>[
    {Name:'node.exe',ProcessId:10,ExecutablePath:'C:\\Tools\\node.exe',CommandLine:'node launcher.js --key '+secret},
    {Name:'node.exe',ProcessId:11,ParentProcessId:10,ExecutablePath:'C:\\Tools\\node.exe',CommandLine:'node "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --prompt "'+secret+'"'},
    {Name:'node.exe',ProcessId:12,ExecutablePath:'C:\\Tools\\node.exe',CommandLine:'node unrelated.js --key '+secret},
    {Name:'claude.exe',ProcessId:13,ExecutablePath:'C:\\Users\\Fixture\\.local\\bin\\claude.exe',CommandLine:'claude --model test --prompt '+secret}
  ]}).scan();
  const claude=find(result,'claude-code');assert.deepEqual(claude.pids,[11,13]);assert.equal(claude.instances[0].confidence,'script_path');assert.equal(claude.capabilities.mcp_install,true);assert.equal(claude.capabilities.attach_existing,false);assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('CommandLine'),false);assert.equal(JSON.stringify(result).includes('commandLine'),false);assert.equal(result.candidates.some(c=>c.pids.includes(12)),false);
});

test('Doubao presence offers personal connector preparation without claiming an installed or controllable conversation',()=>{
  const exe='C:\\Apps\\Doubao.exe';const doubao=find(scanner({files:[exe],processInventory:()=>[{Name:'Doubao.exe',ProcessId:20,ExecutablePath:exe}]}).scan(),'doubao');
  assert.equal(doubao.running,true);assert.equal(doubao.support,'needs_setup');assert.equal(doubao.can_connect,true);assert.ok(doubao.actions.some(action=>action.id==='prepare-mcp'));assert.equal(doubao.capabilities.native_group_proxy,true);assert.equal(doubao.capabilities.mcp_prepare,true);assert.equal(doubao.capabilities.automatic_launch,false);assert.equal(doubao.capabilities.mcp_install,false);assert.equal(doubao.identity.handshake_verified,false);
});

test('Qwen desktop is discovered independently from coding CLIs and its MCP does not imply a wake adapter',()=>{
  const exe='W:\\Program Files\\Qwen\\Qwen.exe',secret='private-prompt-fixture';
  const result=scanner({files:[exe],processInventory:()=>[
    {Name:'Qwen.exe',ProcessId:81,ExecutablePath:exe,CommandLine:'"'+exe+'" --user-data-dir "'+secret+'"'},
    {Name:'Qwen.exe',ProcessId:82,ParentProcessId:81,ExecutablePath:exe,CommandLine:'Qwen.exe --type=renderer'},
    {Name:'Qwen.exe',ProcessId:83,ParentProcessId:81,ExecutablePath:exe,CommandLine:'Qwen.exe --type=gpu-process'}
  ]}).scan(),qwen=find(result,'qwen-desktop');
  assert.equal(qwen.running,true);assert.equal(qwen.installed,true);assert.deepEqual(qwen.pids,[81]);assert.equal(qwen.support,'needs_setup');assert.equal(qwen.can_connect,true);assert.equal(qwen.capabilities.automatic_launch,false);assert.equal(qwen.capabilities.mcp_install,false);assert.equal(qwen.capabilities.attach_existing,false);assert.equal(qwen.identity.handshake_verified,false);assert.match(qwen.reason,/MCP/);assert.equal(JSON.stringify(result).includes(secret),false);assert(!find(result,'claude-code').pids.includes(81));
});

test('custom adapter catalog discovers an arbitrary client without executing it or leaking callback objects',()=>{
  const exe='C:\\Custom\\agent.exe';let inspected=0;
  const result=scanner({includeDefaults:false,files:[exe],catalog:[{id:'custom-assistant',provider:'custom-assistant',name:'本机助手',adapter:'mailbox',kind:'mcp',executables:[exe],capabilities:{automatic_launch:false,mcp_install:true,attach_existing:false,native_group_proxy:true},matchProcess:p=>{inspected++;return p.name==='agent.exe'?{role:'desktop',confidence:'verified_path',secret:p.commandLine}:null;}}],processInventory:()=>[{Name:'agent.exe',ProcessId:30,ExecutablePath:exe,CommandLine:'secret-argument'}]}).scan();
  assert.equal(inspected,1);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].name,'本机助手');assert.equal(result.candidates[0].support,'needs_setup');assert.deepEqual(result.candidates[0].pids,[30]);assert.equal(JSON.stringify(result).includes('secret-argument'),false);
});

test('process scanning failures keep installed commands and reveal only bounded public runtime state',()=>{
  const result=scanner({files:['C:\\Tools\\codex.exe'],processInventory:()=>{throw new Error('confidential argv');},queryState:()=>({connected_count:2,online_count:1,status:'connected',token:'secret-token',argv:'secret-argv'})}).scan();
  const codex=find(result,'codex');assert.equal(result.process_scan.available,false);assert.equal(codex.capabilities.automatic_launch,true);assert.deepEqual(codex.connection,{connected_count:2,online_count:1,status:'connected'});assert.equal(codex.identity.handshake_verified,false);assert.equal(JSON.stringify(result).includes('secret-'),false);assert.equal(JSON.stringify(result).includes('confidential'),false);
});

test('known installation probes use injected filesystem and support version folders without touching real files',()=>{
  const root='C:\\Users\\Fixture\\Local\\OpenAI\\Codex\\bin',exe=root+'\\0.88.0\\codex.exe';let listed=[];
  const result=scanner({files:[root,exe],listFiles:folder=>{listed.push(folder);return ['0.88.0','..\\untrusted'];}}).scan();
  assert.deepEqual(listed,[root]);assert.equal(find(result,'codex').executable,exe);assert.equal(find(result,'codex').capabilities.automatic_launch,true);
});

test('cross-platform installation detection and invalid catalog IDs remain deterministic',()=>{
  const result=scanner({platform:'linux',env:{HOME:'/fixture',PATH:'/tools:/bin'},files:['/tools/codex','/fixture/.local/bin/claude']}).scan();
  assert.equal(find(result,'codex').executable,'/tools/codex');assert.equal(find(result,'claude-code').installed,true);assert.equal(find(result,'claude-code').capabilities.automatic_launch,true);
  assert.throws(()=>scanner({catalog:[{id:'../bad'}]}),TypeError);
});

test('native Claude executable supports managed launch without attaching to its running UI conversation',()=>{
  const exe='C:\\Users\\Fixture\\.local\\bin\\claude.exe';const candidate=find(scanner({files:[exe]}).scan(),'claude-code');
  assert.equal(candidate.executable,exe);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.capabilities.attach_existing,false);assert.equal(candidate.identity.handshake_verified,false);assert.equal(candidate.executable_args,undefined);
});

test('known Claude npm shim resolves through Node with only a verified script prefix',()=>{
  const shim='C:\\Users\\Fixture\\Roaming\\npm\\claude.cmd',script='C:\\Users\\Fixture\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',node='C:\\Tools\\node.exe';
  const candidate=find(scanner({files:[shim,script,node]}).scan(),'claude-code');
  assert.equal(candidate.installed,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.support,'ready');assert.equal(candidate.identity.handshake_verified,false);
});

test('Claude npm shim stays MCP-only when Node or sibling vendor script cannot be verified',()=>{
  const shim='C:\\Users\\Fixture\\Roaming\\npm\\claude.cmd',script='C:\\Users\\Fixture\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',node='C:\\Tools\\node.exe';
  for(const files of [[shim],[shim,script],[shim,node]]){const candidate=find(scanner({files}).scan(),'claude-code');assert.equal(candidate.installed,true);assert.equal(candidate.executable,null);assert.equal(candidate.executable_args,undefined);assert.equal(candidate.capabilities.automatic_launch,false);assert.equal(candidate.capabilities.mcp_install,true);assert.equal(candidate.support,'needs_setup');}
});

test('Node-hosted Claude can supply a fixed safe script path while all prompt or token arguments stay private',()=>{
  const node='C:\\Tools\\node.exe',script='C:\\Vendor Files\\node_modules\\@anthropic-ai\\claude-code\\cli.js',secret='fixture-sensitive-argv';
  const candidate=find(scanner({files:[node,script],processInventory:()=>[{Name:'node.exe',ProcessId:61,ExecutablePath:node,CommandLine:'"'+node+'" "'+script+'" --api-key '+secret+' --prompt "'+secret+'"'}]}).scan(),'claude-code');
  assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.deepEqual(candidate.pids,[61]);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(JSON.stringify(candidate).includes(secret),false);assert.equal(JSON.stringify(candidate).includes('--api-key'),false);
});

test('an apparent vendor path inside prompt/import or an unknown Node installation cannot become a launch entry',()=>{
  const node='C:\\Unknown\\node.exe',script='C:\\Vendor\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const entries=[{Name:'node.exe',ProcessId:71,ExecutablePath:node,CommandLine:'node --eval "'+script+'"'},{Name:'node.exe',ProcessId:72,ExecutablePath:node,CommandLine:'node "'+script+'" --prompt test'}];
  const candidate=find(scanner({files:[node,script],processInventory:()=>entries}).scan(),'claude-code');assert.deepEqual(candidate.pids,[72]);assert.equal(candidate.executable,null);assert.equal(candidate.capabilities.automatic_launch,false);assert.equal(candidate.executable_args,undefined);
});

test('Claude Desktop in known install prefixes is separate from Code and can never become a managed CLI',()=>{
  for(const desktop of ['C:\\Users\\Fixture\\Local\\Programs\\Claude\\Claude.exe','C:\\Program Files\\WindowsApps\\Claude_fixture\\Claude.exe','C:\\Users\\Fixture\\Roaming\\Claude\\claude.exe']){
    const result=scanner({env:{USERPROFILE:'C:\\Users\\Fixture',PATH:require('node:path').win32.dirname(desktop)},files:[desktop],processInventory:()=>[{Name:'Claude.exe',ProcessId:81,ExecutablePath:desktop,CommandLine:'"'+desktop+'"'}]}).scan();
    const code=find(result,'claude-code'),app=find(result,'claude-desktop');assert.equal(code.running,false);assert.equal(code.capabilities.automatic_launch,false);assert.equal(code.executable,null);assert.equal(app.running,true);assert.equal(app.capabilities.automatic_launch,false);assert.equal(app.support,'needs_setup');assert.equal(app.capabilities.mcp_prepare,true);assert.equal(app.capabilities.mcp_install,true);assert.equal(app.identity.handshake_verified,false);
  }
});

test('an arbitrary running Claude executable outside known CLI installation is not launchable',()=>{
  const exe='C:\\Somewhere\\claude.exe';const candidate=find(scanner({files:[exe],processInventory:()=>[{Name:'claude.exe',ProcessId:91,ExecutablePath:exe}]}).scan(),'claude-code');
  assert.equal(candidate.running,true);assert.equal(candidate.executable,null);assert.equal(candidate.capabilities.automatic_launch,false);
});

test('installable Qwen Code and Claude Code remain visible when no runtime is installed',()=>{
  const result=scanner().scan();
  for(const provider of ['qwen-code','claude-code']){
    const candidate=find(result,provider);assert.equal(candidate.installed,false);assert.equal(candidate.running,false);assert.equal(candidate.capabilities.runtime_install,true);assert.equal(candidate.capabilities.automatic_launch,false);assert.equal(candidate.can_connect,true);assert.equal(candidate.support,'needs_setup');assert.ok(candidate.actions.some(action=>action.id==='install-runtime'));
  }
  assert.equal(find(result,'codex').capabilities.runtime_install,false);assert.equal(find(result,'codex').can_connect,false);
  assert.doesNotMatch(find(result,'qwen-code').setup_note,/OAuth.*免费|复用.*桌面登录/);
});

test('Qwen native CLI is independent of consumer Qwen Desktop and never attaches an existing chat',()=>{
  const cli='C:\\Users\\Fixture\\.qwen\\bin\\qwen.exe',desktop='W:\\Program Files\\Qwen\\Qwen.exe';
  const result=scanner({files:[cli,desktop],processInventory:()=>[{Name:'qwen.exe',ProcessId:101,ExecutablePath:cli,CommandLine:'qwen --prompt private-question'},{Name:'Qwen.exe',ProcessId:102,ExecutablePath:desktop,CommandLine:'"'+desktop+'"'}]}).scan();
  const code=find(result,'qwen-code'),app=find(result,'qwen-desktop');assert.equal(code.executable,cli);assert.equal(code.capabilities.automatic_launch,true);assert.deepEqual(code.pids,[101]);assert.deepEqual(app.pids,[102]);assert.equal(app.capabilities.automatic_launch,false);assert.equal(code.capabilities.attach_existing,false);assert.equal(code.identity.handshake_verified,false);assert.equal(code.executable_args,undefined);assert.doesNotMatch(JSON.stringify(result),/private-question/);
  const arbitrary='C:\\Apps\\Qwen.exe',untrusted=scanner({files:[arbitrary],processInventory:()=>[{Name:'Qwen.exe',ProcessId:103,ExecutablePath:arbitrary}]}).scan();assert.equal(find(untrusted,'qwen-code').running,false);assert.equal(find(untrusted,'qwen-code').executable,null);assert.deepEqual(find(untrusted,'qwen-desktop').pids,[103]);
});

test('known Qwen npm shim resolves to one verified Node and vendor script prefix',()=>{
  const shim='C:\\Users\\Fixture\\Roaming\\npm\\qwen.cmd',script='C:\\Users\\Fixture\\Roaming\\npm\\node_modules\\@qwen-code\\qwen-code\\cli-entry.js',node='C:\\Tools\\node.exe';
  const candidate=find(scanner({files:[shim,script,node]}).scan(),'qwen-code');assert.equal(candidate.installed,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.identity.handshake_verified,false);
  for(const files of [[shim],[shim,script],[shim,node]]){const missing=find(scanner({files}).scan(),'qwen-code');assert.equal(missing.installed,true);assert.equal(missing.executable,null);assert.equal(missing.capabilities.automatic_launch,false);assert.equal(missing.capabilities.runtime_install,true);}
});

test('official isolated Qwen runtime accepts trusted cached Node and vendor entry only without modifying PATH',()=>{
  const node='C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\node.exe',script='C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\vendor\\cli-entry.js';
  const env={USERPROFILE:'C:\\Users\\Fixture',PATH:'',AGENTROOM_QWEN_CODE_PATH:node,AGENTROOM_QWEN_CODE_SCRIPT:script},candidate=find(scanner({env,files:[node,script]}).scan(),'qwen-code');
  assert.equal(candidate.installed,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(env.PATH,'');
  for(const invalidScript of ['C:\\Temp\\arbitrary.js','relative\\vendor\\cli-entry.js',script+' --eval evil','C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\..\\..\\untrusted\\vendor\\cli-entry.js']){const invalid=find(scanner({env:{...env,AGENTROOM_QWEN_CODE_SCRIPT:invalidScript},files:[node,invalidScript]}).scan(),'qwen-code');assert.equal(invalid.executable,null);assert.equal(invalid.capabilities.automatic_launch,false);}
  const native='C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\0.25.1\\qwen.exe',nativeCandidate=find(scanner({env:{...env,AGENTROOM_QWEN_CODE_PATH:native,AGENTROOM_QWEN_CODE_SCRIPT:''},files:[native]}).scan(),'qwen-code');assert.equal(nativeCandidate.executable,native);assert.equal(nativeCandidate.executable_args,undefined);
  const archiveNode='C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\payload\\qwen-code\\node\\node.exe',archiveScript='C:\\Users\\Fixture\\.agentroom\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\payload\\qwen-code\\cli-entry.js';
  const archive=find(scanner({env:{...env,AGENTROOM_QWEN_CODE_PATH:archiveNode,AGENTROOM_QWEN_CODE_SCRIPT:archiveScript},files:[archiveNode,archiveScript]}).scan(),'qwen-code');assert.equal(archive.executable,archiveNode);assert.deepEqual(archive.executable_args,[archiveScript]);assert.equal(archive.capabilities.automatic_launch,true);
});

test('Qwen Node process is recognized only by its immediate vendor script; prompts and imports cannot turn into launch commands',()=>{
  const node='C:\\Tools\\node.exe',script='C:\\Vendor Files\\node_modules\\@qwen-code\\qwen-code\\cli-entry.js',secret='fixture-qwen-private-key';
  const result=scanner({files:[node,script],processInventory:()=>[
    {Name:'node.exe',ProcessId:121,ExecutablePath:node,CommandLine:'"'+node+'" "'+script+'" --prompt "'+secret+'"'},
    {Name:'node.exe',ProcessId:122,ExecutablePath:node,CommandLine:'node --import "'+script+'"'},
    {Name:'node.exe',ProcessId:123,ExecutablePath:node,CommandLine:'node unrelated.js --prompt "'+script+'"'},
    {Name:'node.exe',ProcessId:124,ExecutablePath:node,CommandLine:'node --eval "'+script+'"'}
  ]}).scan(),candidate=find(result,'qwen-code');assert.deepEqual(candidate.pids,[121]);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(candidate.capabilities.automatic_launch,true);assert.doesNotMatch(JSON.stringify(result),/fixture-qwen-private-key|--prompt|--import|--eval/);
  const unknown='C:\\Unknown\\node.exe',untrusted=find(scanner({files:[unknown,script],processInventory:()=>[{Name:'node.exe',ProcessId:125,ExecutablePath:unknown,CommandLine:'"'+unknown+'" "'+script+'"'}]}).scan(),'qwen-code');assert.deepEqual(untrusted.pids,[125]);assert.equal(untrusted.executable,null);assert.equal(untrusted.capabilities.automatic_launch,false);
});

test('Qwen consumer application on PATH or in a runtime override never becomes an executable CLI',()=>{
  const desktop='W:\\Program Files\\Qwen\\Qwen.exe',result=scanner({env:{USERPROFILE:'C:\\Users\\Fixture',PATH:'W:\\Program Files\\Qwen',AGENTROOM_QWEN_CODE_PATH:desktop},files:[desktop],processInventory:()=>[{Name:'Qwen.exe',ProcessId:131,ExecutablePath:desktop}]}).scan();
  const code=find(result,'qwen-code');assert.equal(code.executable,null);assert.equal(code.capabilities.automatic_launch,false);assert.equal(code.running,false);assert.equal(code.installed,false);assert.deepEqual(find(result,'qwen-desktop').pids,[131]);
});

test('verified managed Claude runtime is supplied explicitly without touching PATH or confusing desktop identity',()=>{
  const executable='C:\\Users\\Fixture\\.agentroom\\runtimes\\claude-code\\fixture-version\\claude.exe';
  const candidate=find(scanner({env:{USERPROFILE:'C:\\Users\\Fixture',PATH:'',AGENTROOM_CLAUDE_CODE_PATH:executable},files:[executable]}).scan(),'claude-code');assert.equal(candidate.executable,executable);assert.equal(candidate.installed,true);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(candidate.identity.handshake_verified,false);
  const desktop='C:\\Users\\Fixture\\Local\\Programs\\Claude\\Claude.exe',unsafe=find(scanner({env:{USERPROFILE:'C:\\Users\\Fixture',PATH:'',AGENTROOM_CLAUDE_CODE_PATH:desktop},files:[desktop]}).scan(),'claude-code');assert.equal(unsafe.executable,null);assert.equal(unsafe.capabilities.automatic_launch,false);
});

test('Qwen runtime validates a real non-default data directory through discovery and member registration',async t=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const {RoomService}=require('../src/service.cjs'),{FakeCodex,FakeVault}=require('./helpers.cjs');let service;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-qwen-custom-dir-')),data=path.join(root,'AgentRoomData');
  const installed=path.join(data,'runtimes','qwen-code','0.25.1-52791a63-0983-4879-a8c2-30fd6376984e','payload','qwen-code');
  const node=path.join(installed,'node','node.exe'),script=path.join(installed,'lib','cli-entry.js');
  fs.mkdirSync(path.dirname(node),{recursive:true});fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(node,'metadata-only fixture; not executed');fs.writeFileSync(script,'metadata-only fixture; not executed');
  t.after(async()=>{await service?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-qwen-custom-dir-/);fs.rmSync(root,{recursive:true,force:true});});
  const candidate=find(new DiscoveryCatalog({platform:process.platform,env:{USERPROFILE:root,HOME:root,PATH:'',AGENTROOM_QWEN_CODE_PATH:node,AGENTROOM_QWEN_CODE_SCRIPT:script},processInventory:()=>[]}).scan(),'qwen-code');
  assert.equal(candidate.installed,true);assert.equal(candidate.executable,node);assert.deepEqual(candidate.executable_args,[script]);assert.equal(candidate.capabilities.automatic_launch,true);assert.equal(qwenVendorScript(script),true);assert.doesNotMatch(script,/[/\\]\.agentroom[/\\]/);
  service=new RoomService(data,{codex:new FakeCodex(),vault:new FakeVault()});
  const member=service.chat.addMember({name:'Custom-directory Qwen fixture',adapter:'qwen-code',config:{executable:candidate.executable,executable_args:candidate.executable_args}});assert.equal(service.chat.store.member(member.id).config.executable,node);assert.deepEqual(service.chat.store.member(member.id).config.executable_args,[script]);
  assert.equal(qwenVendorScript('C:\\AgentRoomData\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\payload\\qwen-code\\lib\\cli-entry.js'),true);
  for(const invalid of [script.replace('0.25.1-52791a63-0983-4879-a8c2-30fd6376984e','0.25.1-unverified'),script.replace('cli-entry.js','arbitrary.js'),path.join(data,'runtimes','qwen-code','0.25.1-52791a63-0983-4879-a8c2-30fd6376984e','payload','qwen-code','..','lib','cli-entry.js'),'relative\\runtimes\\qwen-code\\0.25.1-52791a63-0983-4879-a8c2-30fd6376984e\\payload\\qwen-code\\lib\\cli-entry.js'])assert.equal(qwenVendorScript(invalid),false,invalid);
});

test('a desktop app installed on another drive is recognised from its data, updater or Start-menu shortcut', () => {
  const { DiscoveryCatalog } = require('../src/discovery.cjs');
  const present = new Set(['C:\\Users\\u\\AppData\\Roaming\\Qwen\\Local Storage']);
  const scan = new DiscoveryCatalog({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', USERPROFILE: 'C:\\Users\\u', PATH: '' }, fileExists: file => present.has(file), listFiles: () => [] }).scan({ processes: [] });
  const qwen = scan.candidates.find(candidate => candidate.provider === 'qwen-desktop');
  assert.equal(qwen.installed, true); assert.equal(qwen.running, false);
  const none = new DiscoveryCatalog({ platform: 'win32', env: { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L', USERPROFILE: 'C:\\U', PATH: '' }, fileExists: () => false, listFiles: () => [] }).scan({ processes: [] });
  assert.equal(none.candidates.find(candidate => candidate.provider === 'qwen-desktop').installed, false);
});
