'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {OnboardingActions,launchInteractive}=require('../src/onboarding-actions.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-login-action-')),node=path.join(root,'node.exe'),script=path.join(root,'node_modules','@google','gemini-cli','bundle','gemini.js');
  fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(node,'metadata fixture; never executed');fs.writeFileSync(script,'metadata fixture; never executed');
  const job={id:'fixture-run',provider:'gemini-cli',room_id:'fixture-room',next_actions:[{operation:'login_client'}]},launched=[];
  const service={onboarding:{state(){return job;}},store:{setting(){return {executable:node,executable_args:[script]};},project(){return {path:root};}},chat:{store:{room(){return {project_id:'fixture-project'};}},discover(){throw new Error('installed runtime must be reused');}}};
  const actions=new OnboardingActions(service,{processIdentity:async()=>({identity:'fixture-birth'}),launcher:async request=>{launched.push(request);return {pid:process.pid,nonce:request.nonce,process_identity:'fixture-birth',phase:'ready',exit_code:null};}});
  t.after(()=>{service.closing=true;assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentoffice-login-action-/);fs.rmSync(root,{recursive:true,force:true});});
  return {root,node,script,job,service,actions,launched};
}

test('Gemini login opens only a user-selected official Node entry and preserves all arguments as quoted literals',async t=>{
  const f=fixture(t);assert.equal(f.launched.length,0);
  const result=await f.actions.perform({run_id:f.job.id,operation:'login_client',command:'untrusted.exe',args:['--eval','malicious']});
  assert.equal(result.action.launched,true);assert.equal(f.launched.length,1);const request=f.launched[0];assert.equal(request.options.shell,false);assert.equal(request.options.windowsHide,false);
  const code=Buffer.from(request.args.at(-1),'base64').toString('utf16le');assert.ok(code.includes(f.node));assert.ok(code.includes(f.script));assert.equal(code.includes('untrusted.exe'),false);assert.equal(code.includes('malicious'),false);
  const repeated=await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(repeated.action.reused,true);assert.equal(f.launched.length,1);
});

test('manual clients and arbitrary scripts cannot be used as background login entrypoints',async t=>{
  const f=fixture(t);f.job.provider='doubao';await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='client_login_unavailable');assert.equal(f.launched.length,0);
  f.job.provider='gemini-cli';const bad=path.join(f.root,'unknown.js');fs.writeFileSync(bad,'never executed');f.service.store.setting=()=>({executable:f.node,executable_args:[bad]});
  await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='client_runtime_missing');assert.equal(f.launched.length,0);
  f.job.next_actions=[];await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='onboarding_action_unavailable');assert.equal(f.launched.length,0);
});
test('Codex first login uses the isolated home without changing the parent environment',async t=>{
  const f=fixture(t),executable=path.join(f.root,'codex.exe'),home=path.join(f.root,'private-codex'),parent=process.env.CODEX_HOME;fs.writeFileSync(executable,'metadata only');f.job.provider='codex';f.service.store.setting=()=>({executable,executable_args:[]});let prepared=0,invalidated=0;f.service.codex={authenticationEnvironment:async()=>{prepared++;return {...process.env,CODEX_HOME:home};},invalidateAuthentication:()=>{invalidated++;},workspace:{home}};
  f.actions.options.launcher=async request=>{f.launched.push(request);return {pid:process.pid,nonce:request.nonce,process_identity:'fixture-birth',phase:'completed',exit_code:0};};
  await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(prepared,1);assert.equal(invalidated,1);assert.equal(f.launched[0].options.env.CODEX_HOME,home);assert.equal(process.env.CODEX_HOME,parent);assert.match(Buffer.from(f.launched[0].args.at(-1),'base64').toString('utf16le'),/login/);
});

test('login success requires a nonce and process birth receipt, never a spawn-only PID',async t=>{
  const f=fixture(t);let attempts=0;
  f.actions.options.launcher=async request=>{attempts++;if(attempts===1)return{pid:process.pid};return{pid:process.pid,nonce:request.nonce,process_identity:'fixture-birth',phase:'completed',exit_code:0};};
  await assert.rejects(f.actions.perform({run_id:f.job.id,operation:'login_client'}),{code:'client_login_open_failed'});assert.equal(f.actions.terminals.size,0);
  assert.equal((await f.actions.perform({run_id:f.job.id,operation:'login_client'})).action.launched,true);assert.equal(attempts,2);
});

test('a reused terminal PID cannot suppress opening the selected login after its process birth changes',async t=>{
  const f=fixture(t);await f.actions.perform({run_id:f.job.id,operation:'login_client'});let checks=0;
  f.actions.options.processIdentity=async()=>({identity:++checks===1?'replacement-process':'fixture-birth'});
  const result=await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(result.action.reused,undefined);assert.equal(f.launched.length,2);
});

test('concurrent first-configuration clicks share one verified launch and reject a mismatched receipt',async t=>{
  const f=fixture(t);let release,calls=0;const gate=new Promise(resolve=>release=resolve);
  f.actions.options.launcher=async request=>{calls++;await gate;return{pid:process.pid,nonce:request.nonce,process_identity:'fixture-birth',phase:'completed',exit_code:0};};
  const first=f.actions.perform({run_id:f.job.id,operation:'login_client'}),second=f.actions.perform({run_id:f.job.id,operation:'login_client'});release();await Promise.all([first,second]);assert.equal(calls,1);
  f.actions.terminals.clear();f.actions.options.launcher=async()=>({pid:process.pid,nonce:'foreign-attempt',process_identity:'fixture-birth',phase:'completed',exit_code:0});await assert.rejects(f.actions.perform({run_id:f.job.id,operation:'login_client'}),{code:'client_login_open_failed'});assert.equal(f.actions.terminals.size,0);
});

test('the interactive script confirms a console before its receipt and completed login invalidates only matching Codex homes',async t=>{
  const f=fixture(t),executable=path.join(f.root,'codex.exe'),home=path.join(f.root,'private-codex');fs.writeFileSync(executable,'metadata only');f.job.provider='codex';f.service.store.setting=()=>({executable,executable_args:[]});
  const calls=[];f.service.codex={workspace:{home},authenticationEnvironment:async()=>({...process.env,CODEX_HOME:home}),invalidateAuthentication:()=>calls.push('global')};f.service.chat.clients=new Map([['same',{workspace:{home},invalidateAuthentication:()=>calls.push('same')}],['other',{workspace:{home:path.join(f.root,'other')},invalidateAuthentication:()=>calls.push('other')}] ]);
  f.actions.options.launcher=async request=>{f.launched.push(request);return {pid:process.pid,nonce:request.nonce,process_identity:'fixture-birth',phase:'completed',exit_code:0};};
  await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.deepEqual(calls,['global','same']);const request=f.launched[0],code=Buffer.from(request.args.at(-1),'base64').toString('utf16le');
  assert.equal(request.options.detached,false);assert.equal(request.options.stdio,'inherit');assert.ok(code.indexOf('IsInputRedirected')<code.indexOf("Write-LoginReceipt 'ready'"));assert.match(code,/Write-LoginReceipt 'failed'/);assert.match(code,/Write-LoginReceipt 'completed'/);assert.match(code,/LASTEXITCODE/);
});

test('a completed or failed login command never reuses its surviving empty PowerShell window',async t=>{
  const f=fixture(t);await f.actions.perform({run_id:f.job.id,operation:'login_client'});const first=f.launched[0],receipt=f.actions.terminals.get(f.job.id);
  fs.writeFileSync(first.receipt_file,JSON.stringify({...receipt,phase:'failed',exit_code:1}));const retried=await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(retried.action.reused,undefined);assert.equal(f.launched.length,2);
  const second=f.launched[1],current=f.actions.terminals.get(f.job.id);fs.writeFileSync(second.receipt_file,JSON.stringify({...current,phase:'completed',exit_code:0}));const completed=await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(completed.action.reused,undefined);assert.equal(f.launched.length,3);
});

test('waiting for interactive login polls receipts without spawning a process identity probe every tick',async t=>{
  const f=fixture(t);let probes=0;f.actions.options.processIdentity=async()=>{probes++;return{identity:'fixture-birth'};};await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(probes,1);
  await new Promise(resolve=>setTimeout(resolve,800));assert.equal(probes,1);const request=f.launched[0],receipt=f.actions.terminals.get(f.job.id);fs.writeFileSync(request.receipt_file,JSON.stringify({...receipt,phase:'failed',exit_code:7}));
  const end=Date.now()+2000;while(f.actions.terminals.has(f.job.id)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.actions.terminals.has(f.job.id),false);assert.equal(probes,2);
});

test('login failure notices update only the original latest awaiting-auth run, never a completed or successor attempt',t=>{
  const f=fixture(t),writes=[];let current={...f.job,status:'needs_action',stage:'awaiting_auth'},latest=current;f.service.onboarding.state=input=>input.run_id?current:latest;f.service.onboarding.set=(run,fields)=>writes.push({run,fields});
  f.actions.loginNotice(f.job,'本次配置没有完成。');assert.deepEqual(writes,[{run:f.job.id,fields:{error:'本次配置没有完成。'}}]);
  latest={...current,id:'successor-run'};f.actions.loginNotice(f.job,'stale notice');current={...current,status:'ready',ready_for_office:true};latest=current;f.actions.loginNotice(f.job,'must not overwrite success');current={...current,status:'cancelled',ready_for_office:false};f.actions.loginNotice(f.job,'must not overwrite cancellation');assert.equal(writes.length,1);
});

test('the hidden launcher waits for stdout close after process exit before accepting a PID-bound interactive receipt',async t=>{
  const f=fixture(t),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');const request={command:'powershell.exe',args:['-NoProfile','-NoExit','-EncodedCommand','fixture-encoded'],nonce:'fixture-nonce',receipt_file:path.join(f.root,'receipt.json'),options:{cwd:f.root,env:{}}};let spawned=0;
  const receipt=await launchInteractive(request,{spawn(command,args,options){spawned++;assert.equal(command,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.detached,undefined);const bootstrap=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.match(bootstrap,/Start-Process/);assert.match(bootstrap,/-WindowStyle Normal/);const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};child.stdin=new Writable({write(_chunk,_encoding,done){done();},final(done){done();queueMicrotask(()=>{fs.writeFileSync(request.receipt_file,JSON.stringify({nonce:request.nonce,pid:12345,process_identity:'fixture-birth',phase:'ready',exit_code:null}));child.emit('exit',0);setTimeout(()=>{child.stdout.write('12345');child.stdout.end();child.emit('close',0);},10);});}});return child;}});
  assert.equal(receipt.pid,12345);assert.equal(spawned,1);
});

test('opening a native client retries the original job only after its own loopback connector is available',async t=>{
  const f=fixture(t),retries=[];f.job.provider='qwen-desktop';f.job.next_actions=[{operation:'open_native_client'}];f.service.onboarding.retry=input=>{retries.push(input);return{id:'new-current-attempt',status:'running',ready_for_office:false};};
  f.actions.options.nativeLauncher={platform:'win32',probe:async(endpoint,provider)=>{assert.equal(endpoint,'http://127.0.0.1:19245');assert.equal(provider,'qwen-desktop');}};
  const result=await f.actions.perform({run_id:f.job.id,operation:'open_native_client'});assert.deepEqual(retries,[{run_id:f.job.id}]);assert.equal(result.action.available,true);assert.equal(result.job.ready_for_office,false);assert.equal(result.job.id,'new-current-attempt');assert.equal(f.launched.length,0);
  f.actions.options.nativeLauncher.probe=async()=>{throw Object.assign(new Error('fixture connection refused'),{code:'ECONNREFUSED'});};f.actions.options.nativeLauncher.discover=()=>({process_scan:{available:true},candidates:[{provider:'qwen-desktop',running:true}]});await assert.rejects(f.actions.perform({run_id:f.job.id,operation:'open_native_client'}),{code:'desktop_client_restart_required'});assert.equal(retries.length,1);
});

test('generated first-configuration PowerShell parses without executing any login or client', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);await f.actions.perform({run_id:f.job.id,operation:'login_client'});const script=Buffer.from(f.launched[0].args.at(-1),'base64').toString('utf16le');
  const parser="[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$code=[Console]::In.ReadToEnd();$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{[Console]::WriteLine($_.Message+' ['+$_.Extent.StartOffset+']')};exit 1}";
  const result=require('node:child_process').spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',parser],{input:script,encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout);
});
test('Claude gateway configuration opens the saved file without auth login or credential rewrites',async t=>{
  const f=fixture(t),directory=path.join(f.root,'.claude'),file=path.join(directory,'settings.json');fs.mkdirSync(directory);const original=JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://fixture.invalid',ANTHROPIC_AUTH_TOKEN:'private-fixture-key'}});fs.writeFileSync(file,original);
  f.job.provider='claude-code';f.actions.options.env={CLAUDE_CONFIG_DIR:directory};
  const result=await f.actions.perform({run_id:f.job.id,operation:'login_client'});
  assert.equal(result.action.kind,'open_api_config');assert.equal(result.action.file,file);assert.equal(f.launched[0].command,'notepad.exe');assert.deepEqual(f.launched[0].args,[file]);assert.equal(f.launched[0].options.shell,false);assert.equal(fs.readFileSync(file,'utf8'),original);assert.doesNotMatch(JSON.stringify(result),/private-fixture-key/);
  await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(fs.readFileSync(file,'utf8'),original);
});
