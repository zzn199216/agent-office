'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{installBinary,activeRuntime}=require('../src/install.cjs');const{fixture}=require('./helpers.cjs');
const {spawn}=require('node:child_process'),os=require('node:os'),crypto=require('node:crypto');
test('first launch copies to a stable per-user location and identical launch does not overwrite',()=>{const f=fixture(),source=path.join(f.root,'download.exe');fs.writeFileSync(source,'test executable bytes');const installed=installBinary(source,f.data);assert.equal(fs.readFileSync(installed,'utf8'),'test executable bytes');const time=fs.statSync(installed).mtimeMs;assert.equal(installBinary(source,f.data),installed);assert.equal(fs.statSync(installed).mtimeMs,time);});
test('installer preserves an unrelated existing executable',()=>{const f=fixture(),source=path.join(f.root,'download.exe'),bin=path.join(f.data,'bin');fs.writeFileSync(source,'new bytes');fs.mkdirSync(bin,{recursive:true});const target=path.join(bin,'AgentRoom.exe');fs.writeFileSync(target,'unrelated file');assert.throws(()=>installBinary(source,f.data),{code:'install_collision'});assert.equal(fs.readFileSync(target,'utf8'),'unrelated file');});
test('Windows upgrade beside a genuinely locked old binary preserves it and installs a reusable version', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(),source=path.join(f.root,'download.exe');fs.writeFileSync(source,'old executable');const original=installBinary(source,f.data);fs.writeFileSync(source,'new executable');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$r=[Console]::In.ReadLine()|ConvertFrom-Json;$f=[IO.File]::Open($r.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null;$f.Dispose()"],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  t.after(async()=>{child.stdin.end('\n');if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});const resolved=path.resolve(f.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  child.stdin.write(JSON.stringify({path:original})+'\n');
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('File lock fixture timed out')),10000);child.once('error',reject);child.stdout.on('data',data=>{if(data.toString().includes('locked')){clearTimeout(timer);resolve();}});});
  const updated=installBinary(source,f.data),fingerprint=crypto.createHash('sha256').update('new executable').digest('hex');
  assert.equal(updated,path.join(f.data,'bin','versions',fingerprint,'AgentRoom.exe'));assert.equal(fs.readFileSync(original,'utf8'),'old executable');assert.equal(fs.readFileSync(updated,'utf8'),'new executable');
  assert.equal(activeRuntime(f.data),updated,'a persisted stdio launcher can resolve the new backend without changing its imported command');
  const before=fs.statSync(updated).mtimeMs;assert.equal(installBinary(source,f.data),updated);assert.equal(fs.statSync(updated).mtimeMs,before);
});

test('active runtime follows owned upgrades and fails closed on tampering or arbitrary paths',t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  assert.equal(activeRuntime(f.data),null);
  const source=path.join(f.root,'new-download.exe');fs.writeFileSync(source,'release one');
  const original=installBinary(source,f.data);assert.equal(activeRuntime(f.data),original);
  fs.writeFileSync(source,'release two');assert.equal(installBinary(source,f.data),original);assert.equal(activeRuntime(f.data),original);
  const marker=path.join(f.data,'bin','active-runtime.json'),record=JSON.parse(fs.readFileSync(marker,'utf8'));
  fs.writeFileSync(marker,JSON.stringify({...record,file:source}));assert.throws(()=>activeRuntime(f.data),{code:'runtime_install_invalid'});
  fs.writeFileSync(marker,JSON.stringify({...record,file:'../new-download.exe'}));assert.throws(()=>activeRuntime(f.data),{code:'runtime_install_invalid'});
  fs.writeFileSync(marker,JSON.stringify(record));fs.writeFileSync(original,'modified executable');assert.throws(()=>activeRuntime(f.data),{code:'runtime_install_invalid'});
});

test('Windows keeps a running old process alive while promoting the new image at its imported command', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(),source=path.join(f.root,'download.exe');fs.copyFileSync(process.execPath,source);const original=installBinary(source,f.data),oldHash=crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex');
  const child=spawn(original,['-e',"process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  t.after(async()=>{child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>child.kill(),3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});const resolved=path.resolve(f.root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Executable fixture timed out')),10000);child.once('error',reject);child.stdout.on('data',part=>{if(part.toString().includes('ready')){clearTimeout(timer);resolve();}});});
  fs.appendFileSync(source,'new-release-overlay');assert.equal(installBinary(source,f.data),original);assert.equal(child.exitCode,null);assert.equal(activeRuntime(f.data),original);
  assert.deepEqual(fs.readFileSync(original),fs.readFileSync(source));const retired=path.join(f.data,'bin','retired',oldHash),files=fs.readdirSync(retired);assert.equal(files.length,1);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(retired,files[0]))).digest('hex'),oldHash);
});

test('failed running-image promotion restores the old imported command and marker',t=>{
  const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const source=path.join(f.root,'download.exe');fs.writeFileSync(source,'old image');const target=installBinary(source,f.data),marker=path.join(f.data,'bin','installed.json'),before=fs.readFileSync(marker),activeBefore=fs.readFileSync(path.join(f.data,'bin','active-runtime.json'));
  fs.writeFileSync(source,'new image');const rename=fs.renameSync;let promotions=0;
  fs.renameSync=function(from,to){if(to===target&&String(from).endsWith('.tmp')){promotions++;const error=Error('Fixture promotion denied');error.code='EPERM';throw error;}return rename.apply(this,arguments);};
  try{assert.throws(()=>installBinary(source,f.data),{code:'install_busy'});}finally{fs.renameSync=rename;}
  assert.equal(promotions,2);assert.equal(fs.readFileSync(target,'utf8'),'old image');assert.deepEqual(fs.readFileSync(marker),before);assert.deepEqual(fs.readFileSync(path.join(f.data,'bin','active-runtime.json')),activeBefore);assert.equal(activeRuntime(f.data),target);
});
