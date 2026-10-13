'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {offlineState,desktopState,desktopStart,desktopStop,activity}=require('../src/desktop-state.cjs');
const {apiCall,readControl}=require('../src/main.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,sleep}=require('../src/util.cjs');

function cleanup(files){
  const root=path.resolve(files.root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-test-/);
  fs.rmSync(root,{recursive:true,force:true});
}
function filesState(folder){
  const entries=[];
  function walk(dir,prefix=''){
    for(const item of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      assert.equal(item.isSymbolicLink(),false);const relative=path.join(prefix,item.name),file=path.join(dir,item.name);
      if(item.isDirectory()){entries.push({path:relative,directory:true});walk(file,relative);}
      else{const stat=fs.statSync(file);entries.push({path:relative,size:stat.size,...item.name.endsWith('-shm')?{}:{modified:stat.mtimeMs},sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}
    }
  }
  walk(folder);return entries;
}
function databaseState(dir){
  const db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true});
  try{
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const rows=Object.fromEntries(schema.filter(row=>row.type==='table').map(row=>[row.name,db.prepare('SELECT * FROM "'+row.name.replaceAll('"','""')+'" ORDER BY rowid').all()]));
    return {schema,rows};
  }finally{db.close();}
}
async function seed(files){
  const codex=new FakeCodex(),service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{throw new Error('No upstream calls in the desktop lifecycle fixture.');}});
  const project=service.addProject({name:'Desktop lifecycle fixture',path:files.project});
  const first=service.chat.addRoom({project_id:project.id,title:'One saved room'}),second=service.chat.addRoom({project_id:project.id,title:'Another saved room'});
  const a=service.chat.addMember({name:'Mailbox A',adapter:'mailbox'}),b=service.chat.addMember({name:'Mailbox B',adapter:'mailbox'}),backend=service.chat.addMember({name:'Saved Codex backend',adapter:'codex'});
  service.chat.join(first.id,a.id);service.chat.join(first.id,backend.id);service.chat.join(second.id,b.id);
  service.chat.store.updateMember(a.id,{config:{private_config:'fixture-private-member-config',last_seen:'2026-01-01T00:00:00.000Z'}});
  const thread=id();service.chat.store.bind(first.id,backend.id,'bound',thread);
  const question=service.chat.store.post({room_id:first.id,sender_id:'user',text:'Only the first room contains this question.',idempotency_key:'first-room-message'});
  service.chat.store.post({room_id:second.id,sender_id:'user',text:'Only the second room contains this question.',idempotency_key:'second-room-message'});
  const issued=service.entry.issue(a.id,first.id),card=JSON.parse(fs.readFileSync(issued.file,'utf8'));
  const instance=service.runtime.instanceId;
  await service.close();assert.equal(codex.calls.length,0);
  fs.writeFileSync(path.join(files.data,'control.json'),JSON.stringify({pid:2147483647,url:'http://127.0.0.1:1',token:'fixture-private-controller-token',instance_id:instance}));
  return {project,first,second,a,b,backend,thread,question,card,entry:issued.file,instance};
}

test('first desktop read and stopped control never create a DB, ensure a server, or load provider authentication',async t=>{
  const files=fixture();t.after(()=>cleanup(files));let controls=0,ensures=0,api=0;
  const main={readControl(){controls++;return null;},ensureServer(){ensures++;throw new Error('An implicit start is forbidden.');},apiCall(){api++;throw new Error('No service exists.');}};
  const before=filesState(files.root);
  for(let n=0;n<3;n++){
    const state=await desktopState(files.data,{}, {main});assert.equal(state.running,false);assert.equal(state.initialized,false);assert.equal(state.snapshot.instance_id,null);assert.deepEqual(state.snapshot.chat.rooms,[]);assert.equal(state.history,null);
  }
  const stopped=await desktopStop(files.data,{}, {main});assert.equal(stopped.running,false);assert.equal(stopped.busy.is_busy,false);
  assert.equal(controls,4);assert.equal(ensures,0);assert.equal(api,0);assert.deepEqual(filesState(files.root),before);assert.equal(fs.existsSync(files.data),false);
});

test('offline history is room-specific, read-only, and excludes controller tokens, entry cards and member configuration',async t=>{
  const files=fixture();t.after(()=>cleanup(files));const v=await seed(files),beforeDatabase=databaseState(files.data),beforeFiles=filesState(files.data);
  const main={readControl:()=>null,ensureServer:()=>{throw new Error('read must not start');},apiCall:()=>{throw new Error('read must not call models');}};
  for(let n=0;n<3;n++){
    const state=await desktopState(files.data,{room_id:v.first.id},{main});assert.equal(state.running,false);assert.equal(state.snapshot.instance_id,v.instance);assert.equal(state.history.room.id,v.first.id);
    assert.deepEqual(state.history.messages.map(message=>message.id),[v.question.id]);assert.deepEqual(state.history.participants.map(member=>member.id).sort(),[v.a.id,v.backend.id].sort());
    assert.equal(state.history.participants.find(member=>member.id===v.backend.id).native_thread_id,v.thread);
    const text=JSON.stringify(state);for(const secret of [v.card.secret,'fixture-private-controller-token','fixture-private-member-config'])assert.equal(text.includes(secret),false);
    for(const property of ['secret_hash','launch_command','launch_args','credential_id','idempotency_key','body_hash'])assert.equal(text.includes('"'+property+'"'),false);
  }
  const second=offlineState(files.data,v.second.id);assert.equal(second.history.room.id,v.second.id);assert.equal(second.history.messages.length,1);assert.match(second.history.messages[0].text,/second room/);assert.deepEqual(second.history.participants.map(member=>member.id),[v.b.id]);
  assert.deepEqual(databaseState(files.data),beforeDatabase);assert.deepEqual(filesState(files.data),beforeFiles);
});

test('offline invalid and unknown room identifiers are rejected without starting or changing the saved instance',async t=>{
  const files=fixture();t.after(()=>cleanup(files));const v=await seed(files),before=databaseState(files.data);let starts=0;
  const main={readControl:()=>null,ensureServer:()=>{starts++;},apiCall:()=>{throw new Error('no service');}};
  for(const room of ['../../room','a'.repeat(36),'',{},7])await assert.rejects(desktopState(files.data,{room_id:room},{main}),error=>error.code==='desktop_room_invalid');
  await assert.rejects(desktopState(files.data,{room_id:id()},{main}),error=>error.status===404);
  await assert.rejects(desktopStart(files.data,{room_id:'bad'},{main}),error=>error.code==='desktop_room_invalid');
  assert.equal(starts,0);assert.deepEqual(databaseState(files.data),before);assert.equal(offlineState(files.data,v.first.id).snapshot.instance_id,v.instance);
});

test('a vanished transport falls back to saved history without restarting; mismatched service identity is rejected',async t=>{
  const files=fixture();t.after(()=>cleanup(files));const v=await seed(files);let starts=0,calls=0;
  const main={readControl:()=>({pid:process.pid,url:'http://127.0.0.1:1',instance_id:v.instance}),ensureServer:()=>{starts++;},apiCall:async()=>{calls++;const error=new Error('connection refused');error.code='ECONNREFUSED';throw error;}};
  const offline=await desktopState(files.data,{room_id:v.first.id},{main});assert.equal(offline.running,false);assert.equal(offline.history.room.id,v.first.id);assert.ok(offline.connection_error);assert.equal(starts,0);assert.equal(calls,1);
  main.apiCall=async()=>({...offline.snapshot,instance_id:id()});await assert.rejects(desktopState(files.data,{}, {main}),error=>error.code==='instance_control_mismatch');
  main.apiCall=async()=>{const error=new Error('unauthorized');error.status=401;throw error;};await assert.rejects(desktopState(files.data,{}, {main}),error=>error.code==='instance_control_mismatch');assert.equal(starts,0);
});

async function httpFixture(t,options={}){
  const files=fixture(),saved=await seed(files),codices=[];let service=null,server=null,control=null,online=false,shutdowns=0,startCalls=0;
  async function close(){
    online=false;const currentServer=server,currentService=service;server=null;service=null;control=null;
    if(currentServer)await currentServer.close();if(currentService)await currentService.close();
    try{fs.unlinkSync(path.join(files.data,'control.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async function start(){
    startCalls++;if(online)return control;
    const codex=new FakeCodex();codices.push(codex);service=new RoomService(files.data,{codex,vault:new FakeVault(),fetch:async()=>{throw new Error('No model provider or external HTTP calls.');}});
    const token=id();server=createServer(service,{port:0,token,onShutdown:()=>{shutdowns++;if(options.closeOnShutdown!==false)void close();}});const port=await server.listen();
    control={pid:process.pid,url:`http://127.0.0.1:${port}`,token,instance_id:service.runtime.instanceId};fs.writeFileSync(path.join(files.data,'control.json'),JSON.stringify(control));online=true;service.start();return control;
  }
  const main={readControl,apiCall,ensureServer:start};
  t.after(async()=>{await close();cleanup(files);});
  return {...files,...saved,main,codices,start,close,get service(){return service;},get server(){return server;},get control(){return control;},get online(){return online;},get shutdowns(){return shutdowns;},get startCalls(){return startCalls;},
    isPidAlive:()=>online,sleep:async()=>{await sleep(15);}};
}

test('real isolated HTTP start-stop-start retains instance, rooms, members, history and native binding without a model call',async t=>{
  const v=await httpFixture(t),before=offlineState(v.data,v.first.id),initialCards=databaseState(v.data).rows.chat_resume_credentials.length;
  const start=await desktopStart(v.data,{room_id:v.first.id},{main:v.main});assert.equal(start.running,true);assert.equal(start.url,v.control.url);assert.equal(start.snapshot.instance_id,v.instance);assert.equal(start.history.room.id,v.first.id);assert.equal(v.startCalls,1);
  for(let i=0;i<3;i++){const state=await desktopState(v.data,{room_id:v.second.id},{main:v.main});assert.equal(state.running,true);assert.equal(state.history.room.id,v.second.id);}
  assert.equal(v.startCalls,1);
  const stopped=await desktopStop(v.data,{room_id:v.first.id},{main:v.main,isPidAlive:v.isPidAlive,sleep:v.sleep});assert.equal(stopped.running,false);assert.equal(stopped.snapshot.instance_id,v.instance);assert.equal(v.shutdowns,1);assert.equal(stopped.history.participants.find(member=>member.id===v.backend.id).native_thread_id,v.thread);
  assert.deepEqual(stopped.snapshot.chat.rooms.map(room=>room.id).sort(),before.snapshot.chat.rooms.map(room=>room.id).sort());assert.deepEqual(stopped.snapshot.chat.members.map(member=>member.id).sort(),before.snapshot.chat.members.map(member=>member.id).sort());
  const restarted=await desktopStart(v.data,{room_id:v.first.id},{main:v.main});assert.equal(restarted.snapshot.instance_id,v.instance);assert.deepEqual(restarted.history.messages.map(message=>message.id),[v.question.id]);assert.equal(restarted.history.participants.find(member=>member.id===v.backend.id).native_thread_id,v.thread);assert.equal(v.startCalls,2);
  assert.equal(databaseState(v.data).rows.chat_resume_credentials.length,initialCards);assert.ok(v.codices.every(codex=>codex.calls.length===0));
});

test('busy service refuses desktop and HTTP shutdown and preserves each active work source',async t=>{
  const v=await httpFixture(t);await v.start();const service=v.service;
  const probes=[
    ()=>{service.active={requestId:id(),abort:new AbortController()};return ()=>{service.active=null;};},
    ()=>{service.chat.active.set(v.a.id,{messageId:v.question.id,roomId:v.first.id});return ()=>service.chat.active.clear();},
    ()=>{service.approvals.set(id(),{public:{id:id(),request_id:v.question.id}});return ()=>service.approvals.clear();},
    ()=>{service.chat.store.updateMember(v.a.id,{status:'connecting'});return ()=>service.chat.store.updateMember(v.a.id,{status:'awaiting_handshake'});},
    ()=>{service.onboarding.jobs.set('fixture-active',Promise.resolve());return ()=>service.onboarding.jobs.clear();},
    ()=>{service.runtimeInstaller.jobs.set('fixture-active',Promise.resolve());return ()=>service.runtimeInstaller.jobs.clear();},
    ()=>{service.launch.jobs.set('fixture-active',Promise.resolve());return ()=>service.launch.jobs.clear();}
  ];
  for(const probe of probes){const reset=probe();try{
    const state=await desktopState(v.data,{}, {main:v.main});assert.equal(state.busy.is_busy,true);
    await assert.rejects(desktopStop(v.data,{}, {main:v.main,isPidAlive:v.isPidAlive,sleep:v.sleep}),error=>error.status===409&&error.code==='desktop_service_busy');
    await assert.rejects(apiCall(v.data,'/api/shutdown',{idle_only:true}),error=>error.status===409&&error.code==='desktop_service_busy');assert.equal(service.closing,false);assert.equal(v.shutdowns,0);assert.equal(v.online,true);
  }finally{reset();}}
  assert.equal(activity(service.snapshot()).is_busy,false);assert.ok(v.codices.every(codex=>codex.calls.length===0));
});

test('accepted idle shutdown rejects later POST mutations during the admission gap and keeps reads available',async t=>{
  const v=await httpFixture(t,{closeOnShutdown:false});await v.start();const service=v.service;
  // Keep this isolated fixture listening after its callback so every admission
  // assertion measures the gate rather than a connection-refused side effect.
  const before=service.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n;
  assert.deepEqual(await apiCall(v.data,'/api/shutdown',{idle_only:true}),{ok:true});assert.equal(service.closing,true);
  const response=await fetch(v.control.url+'/api/chat/messages',{method:'POST',headers:{Authorization:`Bearer ${v.control.token}`,'Content-Type':'application/json'},body:JSON.stringify({room_id:v.first.id,sender_id:'user',text:'must not be accepted during shutdown',idempotency_key:'shutdown-gap'})});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'service_stopping');assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n,before);
  const read=await apiCall(v.data,'/api/chat/rooms/'+v.first.id);assert.equal(read.room.id,v.first.id);
});

test('an unfinished POST body cannot admit work after an idle shutdown was accepted',async t=>{
  const v=await httpFixture(t,{closeOnShutdown:false});await v.start();const service=v.service,base=v.control.url,token=v.control.token;
  const payload=JSON.stringify({room_id:v.first.id,sender_id:'user',text:'must not enter after shutdown',idempotency_key:'late-body'}),headersReceived=new Promise(resolve=>v.server.server.prependOnceListener('request',req=>{assert.equal(req.url,'/api/chat/messages');resolve();}));
  const req=http.request(base+'/api/chat/messages',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}});
  t.after(()=>req.destroy());
  const completed=new Promise((resolve,reject)=>{req.once('error',reject);req.once('response',response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});});
  req.flushHeaders();await headersReceived;await sleep(5);
  const before=service.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n;
  await apiCall(v.data,'/api/shutdown',{idle_only:true});assert.equal(service.closing,true);req.end(payload);const result=await completed;
  assert.equal(result.status,503);assert.equal(result.value.code,'service_stopping');assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n,before);
});

test('member entry cards cannot use native desktop or service controls and do not start a helper',async t=>{
  const files=fixture();t.after(()=>cleanup(files));const v=await seed(files),before=databaseState(files.data),source=path.resolve(__dirname,'../src/main.cjs');
  for(const command of ['desktop','desktop-state','desktop-start','desktop-stop']){
    const result=spawnSync(process.execPath,[source,command,'--data-dir',files.data,'--entry',v.entry],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,AGENTROOM_DATA_DIR:files.data}});
    assert.equal(result.status,1);assert.equal(result.stdout.trim(),'');const error=JSON.parse(result.stderr.trim());assert.equal(error.code,'resume_scope_mismatch');assert.equal(fs.existsSync(path.join(files.data,'daemon.lock')),false);
  }
  assert.deepEqual(databaseState(files.data),before);
});
