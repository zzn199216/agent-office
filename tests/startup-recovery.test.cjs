'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events'),{spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {acquireDaemonLock,releaseDaemonLock,processIdentity,isControlProcessAlive}=require('../src/daemon-owner.cjs');
const {serve,ensureServer,readControl,apiCall}=require('../src/main.cjs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
function files(t){const f=fixture();f.cleanups=[];fs.mkdirSync(f.data);t.after(async()=>{for(const close of f.cleanups)await close();const target=path.resolve(f.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});return f;}
const write=(dir,file,value)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(value));
const read=(dir,file)=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
const known=async pid=>({identity:'fixture-'+pid,birth_ms:Date.now()-10000});
function failedChild(action){const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>action(child));return child;}
function contention(f){
  const file=path.join(f.data,'daemon-mutex.sqlite'),initial=new DatabaseSync(file);initial.exec('CREATE TABLE fixture_reader (id INTEGER PRIMARY KEY); INSERT INTO fixture_reader VALUES (1);');initial.close();let reader,timer;
  const release=()=>{clearTimeout(timer);if(reader){reader.exec('ROLLBACK');reader.close();reader=null;}};f.cleanups.push(release);
  return {hold(delay){reader=new DatabaseSync(file);reader.exec('BEGIN; SELECT * FROM fixture_reader;');if(delay!==undefined)timer=setTimeout(release,delay);},release};
}
async function closeOwnedChild(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  let force,deadline;
  try{await new Promise((resolve,reject)=>{
    child.once('close',resolve);child.stdin.end();force=setTimeout(()=>child.kill(),500);deadline=setTimeout(()=>reject(Error('Owned startup fixture did not exit after termination')),3000);
  });}finally{clearTimeout(force);clearTimeout(deadline);}
}
async function localController(f,handler){
  const server=require('node:http').createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  f.cleanups.push(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));return 'http://127.0.0.1:'+server.address().port;
}

test('legacy control remains compatible only until a modern daemon owns the publication generation',t=>{
  const f=files(t),legacy={pid:process.pid,url:'http://127.0.0.1:1',token:'fixture-legacy-controller'};write(f.data,'control.json',legacy);
  assert.deepEqual(readControl(f.data),legacy);write(f.data,'daemon.lock',{pid:process.pid});assert.deepEqual(readControl(f.data),legacy);
  write(f.data,'daemon.lock',{pid:process.pid,owner_id:'new-generation'});assert.equal(readControl(f.data),null);
  const modern={...legacy,owner_id:'new-generation'};write(f.data,'control.json',modern);assert.deepEqual(readControl(f.data),modern);
  write(f.data,'daemon.lock',{pid:process.pid});assert.equal(readControl(f.data),null);
  write(f.data,'daemon.lock',{pid:process.pid,owner_id:'other-generation'});assert.equal(readControl(f.data),null);
  write(f.data,'daemon.lock',{pid:999999999,owner_id:modern.owner_id});assert.equal(readControl(f.data),null);
  fs.unlinkSync(path.join(f.data,'daemon.lock'));assert.equal(readControl(f.data),null);
  write(f.data,'control.json',legacy);assert.deepEqual(readControl(f.data),legacy);
  for(const damaged of ['{','null','[]','{}']){fs.writeFileSync(path.join(f.data,'daemon.lock'),damaged);assert.equal(readControl(f.data),null);}
  const original=fs.readFileSync;fs.readFileSync=function(file,...args){if(file===path.join(f.data,'daemon.lock'))throw Object.assign(Error('Synthetic lock read denied'),{code:'EACCES'});return original.call(this,file,...args);};
  try{assert.equal(readControl(f.data),null);}finally{fs.readFileSync=original;}
});

test('recovery waits for modern control publication instead of sending a legacy token to the new listener',async t=>{
  const f=files(t),requests=[],instance='fixture-published-instance',current={pid:process.pid,owner_id:'new-generation',token:'fixture-current-controller',instance_id:instance};
  current.url=await localController(f,(request,response)=>{requests.push(request.headers.authorization);const authenticated=request.headers.authorization==='Bearer '+current.token;response.writeHead(authenticated?200:401,{'Content-Type':'application/json'});response.end(JSON.stringify(authenticated?{instance_id:instance}:{error:'fixture wrong controller',code:'unauthorized'}));});
  write(f.data,'daemon.lock',{pid:current.pid,owner_id:current.owner_id});write(f.data,'control.json',{pid:current.pid,url:current.url,token:'fixture-legacy-controller',instance_id:instance});let spawns=0;
  const result=await ensureServer(f.data,{timeout:1500,spawn:()=>{spawns++;assert.equal(readControl(f.data),null);return failedChild(child=>{write(f.data,'control.json',current);child.emit('exit',0);});}});
  assert.deepEqual(result,current);assert.equal(spawns,1);assert.deepEqual(requests,['Bearer '+current.token]);
});

test('a matching published generation still rejects real authentication and instance mismatches without spawning a replacement',async t=>{
  const f=files(t),current={pid:process.pid,owner_id:'verified-generation',token:'fixture-current-controller',instance_id:'fixture-original-instance'};let status=401,value={error:'fixture rejected authentication',code:'unauthorized'},requests=0;
  current.url=await localController(f,(_request,response)=>{requests++;response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(value));});write(f.data,'daemon.lock',{pid:current.pid,owner_id:current.owner_id});write(f.data,'control.json',current);
  for(status of [401,403])await assert.rejects(ensureServer(f.data,{timeout:500,spawn:()=>assert.fail('Authentication rejection must not start another daemon')}),{code:'instance_control_mismatch'});
  status=200;value={instance_id:'fixture-foreign-instance'};await assert.rejects(ensureServer(f.data,{timeout:500,spawn:()=>assert.fail('An instance mismatch must not start another daemon')}),{code:'instance_control_mismatch'});assert.equal(requests,3);
});

test('a transient COMMIT reader lock retries only COMMIT and preserves the acquired owner',async t=>{
  const f=files(t),shared=contention(f),original=DatabaseSync.prototype.exec;let attempts=0,busy=0,identities=0;
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'){attempts++;try{return original.call(this,sql,...args);}catch(error){if(error.errcode===5)busy++;throw error;}}return original.call(this,sql,...args);};
  let owner;try{owner=await acquireDaemonLock(f.data,{timeout:1000,processIdentity:async pid=>{identities++;shared.hold(120);return known(pid);}});}finally{DatabaseSync.prototype.exec=original;shared.release();}
  assert.ok(busy>0);assert.ok(attempts>1);assert.equal(identities,1);assert.equal(read(f.data,'daemon.lock').owner_id,owner.owner_id);await releaseDaemonLock(f.data,owner);
});

test('persistent COMMIT contention has a bounded typed failure without replaying filesystem ownership changes',async t=>{
  const f=files(t),shared=contention(f),original=fs.writeFileSync;let identities=0,writes=0;
  fs.writeFileSync=function(file,...args){if(typeof file==='string'&&path.resolve(file)===path.join(f.data,'daemon.lock'))writes++;return original.call(this,file,...args);};
  const started=Date.now();let failure;
  try{await assert.rejects(acquireDaemonLock(f.data,{timeout:120,processIdentity:async pid=>{identities++;shared.hold();return known(pid);}}),error=>{failure=error;return error.code==='service_start_busy'&&error.cause?.errcode===5;});}finally{fs.writeFileSync=original;shared.release();}
  assert.ok(Date.now()-started<1500);assert.ok(failure);assert.equal(identities,1);assert.equal(writes,1);const owner=read(f.data,'daemon.lock');assert.equal(owner.pid,process.pid);await releaseDaemonLock(f.data,owner);
});

test('non-busy COMMIT failures are not retried and do not replay the completed owner callback',async t=>{
  const f=files(t),original=DatabaseSync.prototype.exec;let attempts=0,identities=0;
  const failure=Object.assign(Error('synthetic commit I/O failure'),{code:'ERR_SQLITE_ERROR',errcode:10});
  DatabaseSync.prototype.exec=function(sql,...args){if(sql==='COMMIT'){attempts++;throw failure;}return original.call(this,sql,...args);};
  try{await assert.rejects(acquireDaemonLock(f.data,{processIdentity:async pid=>{identities++;return known(pid);}}),error=>error===failure);}finally{DatabaseSync.prototype.exec=original;}
  assert.equal(attempts,1);assert.equal(identities,1);await releaseDaemonLock(f.data,read(f.data,'daemon.lock'));
});

test('actual OS process birth distinguishes a reused legacy PID and retains the unrelated process',async t=>{
  const f=files(t),identity=await processIdentity(process.pid);assert.ok(identity?.identity);assert.ok(identity.birth_ms>0);
  write(f.data,'daemon.lock',{pid:process.pid});const old=new Date(identity.birth_ms-60000);fs.utimesSync(path.join(f.data,'daemon.lock'),old,old);
  const owner=await acquireDaemonLock(f.data);assert.ok(owner?.owner_id);assert.equal(owner.process_identity,identity.identity);process.kill(process.pid,0);
  await releaseDaemonLock(f.data,owner);assert.equal(fs.existsSync(path.join(f.data,'daemon.lock')),false);process.kill(process.pid,0);
});

test('a current owner and an unknown live process cannot be evicted by a second startup',async t=>{
  const f=files(t),owner=await acquireDaemonLock(f.data,{processIdentity:known});
  assert.equal(await acquireDaemonLock(f.data,{processIdentity:known}),null);
  assert.equal(await acquireDaemonLock(f.data,{processIdentity:async()=>null}),null);
  assert.deepEqual(read(f.data,'daemon.lock'),owner);await releaseDaemonLock(f.data,owner);
});

test('PID birth identity mismatch recovers a lock without terminating its current PID',async t=>{
  const f=files(t);write(f.data,'daemon.lock',{pid:process.pid,owner_id:'previous-boot',process_identity:'previous-process'});
  const owner=await acquireDaemonLock(f.data,{processIdentity:known});assert.notEqual(owner.owner_id,'previous-boot');process.kill(process.pid,0);await releaseDaemonLock(f.data,owner);
});

test('stale cleanup never removes a replacement owner or another control generation',async t=>{
  const f=files(t),owner=await acquireDaemonLock(f.data,{processIdentity:known}),replacement={...owner,owner_id:'different-owner'};
  write(f.data,'daemon.lock',replacement);write(f.data,'control.json',{...replacement,token:'other-controller'});
  await releaseDaemonLock(f.data,owner);assert.equal(read(f.data,'daemon.lock').owner_id,replacement.owner_id);assert.equal(read(f.data,'control.json').token,'other-controller');
});

test('damaged startup records preserve independent live control and fresh partial writes',async t=>{
  const f=files(t);fs.writeFileSync(path.join(f.data,'daemon.lock'),'{');await assert.rejects(acquireDaemonLock(f.data,{processIdentity:known}),{code:'service_start_busy'});
  const old=new Date(Date.now()-60000);fs.utimesSync(path.join(f.data,'daemon.lock'),old,old);write(f.data,'control.json',{pid:process.pid});
  assert.equal(await acquireDaemonLock(f.data,{processIdentity:known}),null);assert.equal(fs.readFileSync(path.join(f.data,'daemon.lock'),'utf8'),'{');
  fs.unlinkSync(path.join(f.data,'control.json'));const owner=await acquireDaemonLock(f.data,{processIdentity:known});assert.ok(owner.owner_id);await releaseDaemonLock(f.data,owner);
});

test('a missing lock cannot override a live control owner or an unknown damaged control',async t=>{
  const f=files(t);write(f.data,'control.json',{pid:process.pid});assert.equal(await acquireDaemonLock(f.data,{processIdentity:known}),null);assert.equal(fs.existsSync(path.join(f.data,'daemon.lock')),false);
  fs.writeFileSync(path.join(f.data,'control.json'),'{');await assert.rejects(acquireDaemonLock(f.data,{processIdentity:known}),{code:'service_owner_unverified'});assert.equal(fs.existsSync(path.join(f.data,'daemon.lock')),false);
});

test('a daemon recorded on another machine cannot be reclaimed through local PID checks',async t=>{
  const f=files(t);write(f.data,'daemon.lock',{pid:999999999,host:'different-fixture-machine'});
  await assert.rejects(acquireDaemonLock(f.data,{processIdentity:known}),{code:'service_owner_unverified'});assert.equal(read(f.data,'daemon.lock').host,'different-fixture-machine');
});

test('concurrent recovery processes acquire one daemon owner',async t=>{
  const f=files(t),children=[];write(f.data,'daemon.lock',{pid:999999999});
  const script=`const fs=require('node:fs'),path=require('node:path');const mod=require(process.argv[1]);(async()=>{const owner=await mod.acquireDaemonLock(process.argv[2],{processIdentity:async pid=>({identity:'fixture-'+pid,birth_ms:Date.now()-10000})});console.log(JSON.stringify({owned:!!owner}));if(owner){process.stdin.resume();await new Promise(r=>process.stdin.once('end',r));await mod.releaseDaemonLock(process.argv[2],owner);}})().catch(e=>{console.error(e);process.exitCode=1;});`;
  f.cleanups.push(()=>Promise.all(children.map(closeOwnedChild)));
  const results=await Promise.all([0,1,2].map(()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',script,path.resolve(__dirname,'../src/daemon-owner.cjs'),f.data],{windowsHide:true,stdio:['pipe','pipe','pipe']});children.push(child);let output='',errors='',settled=false;const timer=setTimeout(()=>{child.kill();reject(Error('concurrent startup fixture timeout'));},10000);
    child.stdout.on('data',part=>{output+=part;const line=output.split('\n')[0];try{const result=JSON.parse(line);settled=true;clearTimeout(timer);resolve(result);}catch{}});child.stderr.on('data',part=>errors+=part);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(!settled)reject(Error(errors||'Startup fixture exited without an ownership result ('+code+')'));});
  })));
  assert.equal(results.filter(result=>result.owned).length,1);
  await Promise.all(children.map(closeOwnedChild));
});

test('constructor failure removes its own lock and leaves an attempt-specific startup error',async t=>{
  const f=files(t);await assert.rejects(serve(f.data,{'startup-id':'owned-attempt',serviceFactory:()=>{throw Object.assign(Error('fixture initialization failed'),{code:'fixture_initialization_failed'});}}),{code:'fixture_initialization_failed'});
  assert.equal(fs.existsSync(path.join(f.data,'daemon.lock')),false);assert.equal(read(f.data,'startup-error.json').attempt_id,'owned-attempt');
  const owner=await acquireDaemonLock(f.data,{processIdentity:known});assert.ok(owner);await releaseDaemonLock(f.data,owner);
});

test('launcher errors and early service failures are reported without waiting for the deadline',async t=>{
  const f=files(t),start=Date.now();await assert.rejects(ensureServer(f.data,{timeout:2000,spawn:()=>failedChild(child=>child.emit('error',Object.assign(Error('missing binary'),{code:'ENOENT'})))}),{code:'service_spawn_failed'});
  await assert.rejects(ensureServer(f.data,{timeout:2000,spawn:(_command,args)=>failedChild(child=>{const attempt=args[args.indexOf('--startup-id')+1];write(f.data,'startup-error.json',{attempt_id:attempt,error:'Original MCP address is occupied',code:'mcp_port_in_use'});child.emit('exit',1);})}),{code:'mcp_port_in_use'});
  assert.ok(Date.now()-start<1500);
});

test('service readiness uses a total deadline including HTTP probes',async t=>{
  const f=files(t),start=Date.now(),timeouts=[];
  const control={pid:process.pid,url:'http://127.0.0.1:1',instance_id:'fixture'};
  await assert.rejects(ensureServer(f.data,{timeout:180,readControl:()=>control,call:async(_dir,_route,_input,timeout)=>{timeouts.push(timeout);await new Promise(resolve=>setTimeout(resolve,timeout));throw Error('not ready');},spawn:()=>assert.fail('The exhausted budget must not spawn a service')}),{code:'start_timeout'});
  assert.ok(timeouts.every(timeout=>timeout<=180));assert.ok(Date.now()-start<650);
});

test('obsolete startup errors cannot be mistaken for this attempt',async t=>{
  const f=files(t);write(f.data,'startup-error.json',{attempt_id:'other-attempt',error:'unrelated stale failure',code:'unrelated_failure'});
  await assert.rejects(ensureServer(f.data,{timeout:2000,spawn:()=>failedChild(child=>child.emit('exit',1))}),error=>error.code==='service_start_failed'&&!error.message.includes('unrelated stale failure'));
});

test('control checks reject replacement generations and reused process identities',async t=>{
  const f=files(t),identity=await processIdentity(process.pid),control={pid:process.pid,token:'owned-controller',owner_id:'original-owner',process_identity:identity.identity};write(f.data,'control.json',control);
  assert.equal(await isControlProcessAlive(f.data,control),true);write(f.data,'control.json',{...control,owner_id:'replacement-owner'});assert.equal(await isControlProcessAlive(f.data,control),false);
  const reused={...control,process_identity:'old-boot'};write(f.data,'control.json',reused);assert.equal(await isControlProcessAlive(f.data,reused),false);
});

test('shutdown cannot move to a replacement control between ownership observation and request dispatch',async t=>{
  const f=files(t),original={pid:process.pid,url:'http://127.0.0.1:1',token:'original-controller',instance_id:'fixture'},replacement={...original,token:'replacement-controller'};write(f.data,'control.json',replacement);
  await assert.rejects(apiCall(f.data,'/api/shutdown',{idle_only:true},500,original),{code:'desktop_service_changed'});assert.equal(read(f.data,'control.json').token,replacement.token);
});

test('stale-PID recovery keeps existing rooms and connections and restores deletion through real HTTP',async t=>{
  const f=files(t),factory=dir=>new RoomService(dir,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>assert.fail('No external calls in startup validation')}),initial=factory(f.data);
  const project=initial.addProject({name:'Saved project',path:f.project}),keep=initial.chat.addRoom({project_id:project.id,title:'Retain room'}),remove=initial.chat.addRoom({project_id:project.id,title:'Disposable room'}),member=initial.chat.addMember({name:'Saved member',adapter:'mailbox'});initial.chat.join(keep.id,member.id);
  const {card}=initial.resume.issue(member.id,keep.id);const instance=initial.runtime.instanceId;await initial.close();
  write(f.data,'daemon.lock',{pid:process.pid});fs.utimesSync(path.join(f.data,'daemon.lock'),new Date(0),new Date(0));
  const running=await serve(f.data,{port:0,serviceFactory:factory});assert.ok(running);f.cleanups.push(()=>running.stop());
  const state=await apiCall(f.data,'/api/state');assert.equal(state.instance_id,instance);assert.ok(state.chat.rooms.some(room=>room.id===keep.id));assert.ok(readControl(f.data).owner_id);
  assert.equal(running.service.resume.inspect(card).member_id,member.id);
  const control=readControl(f.data),response=await fetch(control.url+`/api/chat/rooms/${remove.id}`,{method:'DELETE',headers:{Authorization:'Bearer '+control.token},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,'deleted');assert.equal(running.service.chat.store.room(keep.id).id,keep.id);assert.equal(running.service.resume.inspect(card).member_id,member.id);assert.equal(running.service.codex.calls.length,0);
});
