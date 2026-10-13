'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{installBinary}=require('../src/install.cjs');const{fixture}=require('./helpers.cjs');
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
  const before=fs.statSync(updated).mtimeMs;assert.equal(installBinary(source,f.data),updated);assert.equal(fs.statSync(updated).mtimeMs,before);
});
