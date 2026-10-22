'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{prepareNativeClient}=require('../src/desktop-client-launcher.cjs');
const {discoverDesktop}=require('../src/desktop-transport.cjs');
const unavailable=()=>Object.assign(Error('isolated connection unavailable'),{code:'ECONNREFUSED'});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-client-launch-')),executable=path.join(root,'Doubao.exe');fs.writeFileSync(executable,'fixture metadata only, never executed');
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentoffice-client-launch-/);fs.rmSync(root,{recursive:true,force:true});});
  const job={provider:'doubao',id:'selected-attempt'},calls=[],candidate={provider:'doubao',running:false,executable,instances:[],pids:[]};
  const options={platform:'win32',probe:async()=>{throw unavailable();},discover:()=>({process_scan:{available:true},candidates:[candidate]}),spawn:(command,args,values)=>{calls.push({command,args,values});const child=new EventEmitter();child.unref=()=>{};child.kill=()=>assert.fail('This action must not terminate clients');process.nextTick(()=>child.emit('spawn'));return child;}};
  return {root,executable,job,calls,candidate,options,service:{chat:{discover:()=>assert.fail('No actual application scan')},fetch:()=>assert.fail('No actual client calls')}};
}

test('a working native endpoint is reused without opening a program or scanning applications',async t=>{
  const f=fixture(t);f.options.probe=async()=>({provider:'doubao'});f.options.discover=()=>assert.fail('Ready clients do not need a scan');
  const result=await prepareNativeClient(f.service,f.job,f.options);assert.equal(result.available,true);assert.equal(result.launched,false);assert.equal(f.calls.length,0);assert.equal(result.can_wake,undefined);
});

test('an already running app without its endpoint gives a concrete exit step and never launches a duplicate',async t=>{
  const f=fixture(t);f.candidate.running=true;
  await assert.rejects(prepareNativeClient(f.service,f.job,f.options),error=>error.code==='desktop_client_restart_required'&&/托盘.*退出/.test(error.message)&&/MCP/.test(error.message));assert.equal(f.calls.length,0);
  f.candidate.running=false;f.candidate.pids=[123];await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_restart_required'});assert.equal(f.calls.length,0);
});

test('an unavailable process scan cannot authorize opening a second application instance',async t=>{
  const f=fixture(t);f.options.discover=()=>({process_scan:{available:false},candidates:[f.candidate]});await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_process_unconfirmed'});assert.equal(f.calls.length,0);
});

test('only the selected installed vendor executable can be opened',async t=>{
  const f=fixture(t);f.candidate.executable=path.join(f.root,'other.exe');fs.writeFileSync(f.candidate.executable,'not a vendor program');await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_path_unverified'});assert.equal(f.calls.length,0);
  await assert.rejects(prepareNativeClient(f.service,{provider:'grok-bot'},f.options),{code:'desktop_adapter_unverified'});assert.equal(f.calls.length,0);
});

test('opening a client waits for its actual native endpoint and uses only fixed loopback flags',async t=>{
  const f=fixture(t);let probes=0;f.options.probe=async(endpoint,provider)=>{probes++;assert.equal(endpoint,'http://127.0.0.1:19246');assert.equal(provider,'doubao');if(probes<3)throw unavailable();return {provider};};
  const result=await prepareNativeClient(f.service,{...f.job,command:'untrusted.exe',args:['--arbitrary']},f.options);assert.equal(result.available,true);assert.equal(result.launched,true);assert.equal(probes,3);assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,f.executable);assert.deepEqual(f.calls[0].args,['--remote-debugging-port=19246','--remote-debugging-address=127.0.0.1']);assert.equal(f.calls[0].values.shell,false);assert.equal(f.calls[0].values.detached,false);
});

test('an unrelated or incompatible listener cannot be replaced by opening the selected app',async t=>{
  const f=fixture(t);f.options.probe=async()=>{throw Object.assign(Error('Wrong native target'),{code:'desktop_target_invalid'});};await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_target_invalid'});assert.equal(f.calls.length,0);
});

test('a successful process spawn alone cannot claim a connection, and timeout never kills a client',async t=>{
  const f=fixture(t);f.options.timeoutMs=60;const began=Date.now();await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_launch_timeout'});assert.equal(f.calls.length,1);assert.ok(Date.now()-began<600);
});

test('a failed program launch is retryable without caching a false success',async t=>{
  const f=fixture(t);let launches=0;f.options.spawn=()=>{launches++;const child=new EventEmitter();process.nextTick(()=>child.emit('error',Error('fixture denied launch')));return child;};
  for(let i=0;i<2;i++)await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_launch_failed'});assert.equal(launches,2);
});

test('native discovery reports a readable connection step and retains the retryable transport cause',async()=>{
  const original=Object.assign(Error('fetch failed'),{cause:unavailable()});
  await assert.rejects(discoverDesktop('http://127.0.0.1:19246','doubao',{fetchImpl:async()=>{throw original;}}),error=>error.code==='desktop_bridge_unavailable'&&error.cause===original&&/改用 MCP 连接/.test(error.message)&&!/fetch failed/.test(error.message));
});

test('simultaneous attempts share one client launch and do not spawn a duplicate',async t=>{
  const f=fixture(t);let ready=false;f.options.probe=async()=>{if(!ready)throw unavailable();return {};};f.options.spawn=(...args)=>{const child=new EventEmitter();child.unref=()=>{};f.calls.push(args);process.nextTick(()=>{child.emit('spawn');ready=true;});return child;};
  const results=await Promise.all([prepareNativeClient(f.service,f.job,f.options),prepareNativeClient(f.service,{...f.job,id:'second-attempt'},f.options)]);
  assert.equal(f.calls.length,1);assert.equal(results[0].available,true);assert.deepEqual(results[0],results[1]);
});

test('a live endpoint with a still-loading target is awaited without opening another client',async t=>{
  const f=fixture(t);let probes=0;f.options.probe=async()=>{if(++probes<3)throw Object.assign(Error('target is loading'),{code:'desktop_target_ambiguous',retryable:true});return {};};f.options.discover=()=>assert.fail('Do not scan or spawn after seeing a live native endpoint');
  const result=await prepareNativeClient(f.service,f.job,f.options);assert.equal(result.launched,false);assert.equal(f.calls.length,0);assert.equal(probes,3);
});

test('default launch inventory is asynchronous and scans only the selected catalog with bounded metadata',async t=>{
  const f=fixture(t);delete f.options.discover;let scanned=false,inventory=false,ready=false;
  f.service.chat.discovery={catalog:[{id:'doubao'},{id:'codex'}],scan({processes}){scanned=true;assert.deepEqual(this.catalog,[{id:'doubao'}]);assert.equal(processes.available,true);return {process_scan:{available:true},candidates:[f.candidate]};}};
  f.options.inventoryExecFile=(command,args,options,callback)=>{assert.equal(command,'powershell.exe');assert.equal(options.windowsHide,true);assert.ok(options.timeout<=5000);setTimeout(()=>{inventory=true;callback(null,'[]');},5);};
  f.options.probe=async()=>{if(!ready)throw unavailable();return {};};f.options.spawn=(...args)=>{const child=new EventEmitter();child.unref=()=>{};f.calls.push(args);process.nextTick(()=>{ready=true;child.emit('spawn');});return child;};
  const pending=prepareNativeClient(f.service,f.job,f.options);await new Promise(resolve=>setTimeout(resolve,0));assert.equal(inventory,false);await pending;assert.equal(scanned,true);assert.equal(f.service.chat.discovery.catalog.length,2);assert.equal(f.calls.length,1);
});

test('a custom installation observed before exit remains usable without changing the original connection',async t=>{
  const f=fixture(t),settings=new Map();f.service.store={setting(key,...values){if(values.length)settings.set(key,values[0]);return settings.get(key);}};f.candidate.running=true;
  await assert.rejects(prepareNativeClient(f.service,f.job,f.options),{code:'desktop_client_restart_required'});assert.equal(f.calls.length,0);assert.equal(settings.get('desktop_client_path.doubao'),f.executable);
  f.candidate.running=false;f.candidate.executable=null;let ready=false;f.options.probe=async()=>{if(!ready)throw unavailable();return {};};f.options.spawn=(command)=>{assert.equal(command,f.executable);const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>{ready=true;child.emit('spawn');});return child;};
  assert.equal((await prepareNativeClient(f.service,f.job,f.options)).available,true);assert.equal(settings.size,1);
});
