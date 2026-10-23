'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
const {DiscoveryCatalog,windowsProcessInventory}=require('../src/discovery.cjs');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');

test('slow process queries and their fallback leave the event loop responsive',async()=>{
  let calls=0,beats=0;const timer=setInterval(()=>beats++,10);
  try{
    const result=await windowsProcessInventory({timeout:2000,execFile:(_command,args,options,callback)=>{
      calls++;assert.equal(options.windowsHide,true);assert.equal(args[0],'-NoProfile');
      const script=calls===1?'setTimeout(()=>process.exit(1),90)':'setTimeout(()=>console.log(JSON.stringify([{Name:"Qwen.exe",ProcessId:12}])),90)';
      return execFile(process.execPath,['-e',script],options,callback);
    }});
    assert.equal(calls,2);assert.equal(result.available,true);assert.equal(result.partial,true);assert.equal(result.processes[0].ProcessId,12);assert.ok(beats>=2);
  }finally{clearInterval(timer);}
});

test('overlapping scans share one inventory and shutdown cancels it',async()=>{
  let calls=0,signal;const catalog=new DiscoveryCatalog({includeDefaults:false,processInventory:input=>{
    calls++;signal=input.signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({processes:[],available:false}),{once:true}));
  }});
  const pending=Promise.allSettled([catalog.scan(),catalog.scan()]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);await catalog.close();assert.equal(signal.aborted,true);
  assert.ok((await pending).every(result=>result.status==='rejected'));
  await assert.rejects(catalog.scan(),/扫描已停止/);
});

test('an aborted Windows query does not start the fallback process',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=windowsProcessInventory({signal:controller.signal,execFile:(_command,_args,options,callback)=>{
    calls++;options.signal.addEventListener('abort',()=>callback(new Error('aborted'),''),{once:true});
  }});
  controller.abort();const result=await pending;assert.equal(calls,1);assert.equal(result.available,false);
});

test('HTTP state remains usable during discovery and concurrent scans return resolved snapshots',async t=>{
  const files=fixture();let release,entered,calls=0;
  const started=new Promise(resolve=>{entered=resolve;}),inventory=new Promise(resolve=>{release=resolve;});
  const service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),chat:{discovery:{env:{PATH:''},fileExists:()=>false,listFiles:()=>[],processInventory:()=>{calls++;entered();return inventory;}}}});
  const server=createServer(service,{port:0,token:'fixture-controller'}),base='http://127.0.0.1:'+await server.listen();
  let secondEntered;const secondStarted=new Promise(resolve=>{secondEntered=resolve;}),discovery=service.launch.discovery.bind(service.launch);
  service.launch.discovery=()=>{secondEntered();return discovery();};
  t.after(async()=>{release([]);await server.close();await service.close();assert.equal(path.dirname(path.resolve(files.root)),path.resolve(os.tmpdir()));assert.match(path.basename(files.root),/^agentroom-test-/);fs.rmSync(files.root,{recursive:true,force:true});});
  const headers={Authorization:'Bearer fixture-controller'},scan=fetch(base+'/api/chat/discover',{headers});await started;
  const otherScan=fetch(base+'/api/launch/scan',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});
  await secondStarted;
  const state=await fetch(base+'/api/chat/state',{headers,signal:AbortSignal.timeout(2000)});assert.equal(state.status,200);await state.json();
  release([]);const response=await scan,otherResponse=await otherScan;
  assert.equal(response.status,200);assert.equal(otherResponse.status,200);
  assert.ok(Array.isArray((await response.json()).candidates));assert.ok(Array.isArray((await otherResponse.json()).candidates));assert.equal(calls,1);
});
