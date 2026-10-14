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

test('starting a newer desktop replaces only an idle older service and preserves room identity',async t=>{
  const files=fixture(),v=await seed(files);t.after(()=>cleanup(files));const {VERSION}=require('../src/util.cjs');let running=true,version='0.14.3',stops=0,starts=0;
  const snapshot=()=>({...offlineState(files.data,v.first.id).snapshot,version,activeSetup:{}});
  const main={readControl:()=>running?{pid:12345,url:'http://127.0.0.1:1234',instance_id:v.instance}:null,apiCall:async(_dir,route,input)=>{if(route==='/api/state')return snapshot();if(route==='/api/shutdown'){assert.deepEqual(input,{idle_only:true});stops++;running=false;return {ok:true};}if(route.startsWith('/api/chat/rooms/'))return offlineState(files.data,v.first.id).history;if(route.startsWith('/api/team'))return offlineState(files.data,v.first.id).team;throw Error(route);},ensureServer:async()=>{starts++;version=VERSION;running=true;}};
  const before=await desktopState(files.data,{room_id:v.first.id},{main});assert.equal(before.can_update,true);
  const after=await desktopStart(files.data,{room_id:v.first.id},{main,isPidAlive:()=>false});assert.equal(after.update_available,false);assert.equal(after.snapshot.version,VERSION);assert.equal(after.selected_room_id,v.first.id);assert.equal(stops,1);assert.equal(starts,1);
});
test('busy and newer backends cannot be interrupted or downgraded by a desktop start',async t=>{
  const files=fixture(),v=await seed(files);t.after(()=>cleanup(files));let version='0.14.3',busy=true,stops=0,starts=0;const main={readControl:()=>({pid:12345,url:'http://127.0.0.1:1234',instance_id:v.instance}),apiCall:async(_dir,route)=>{if(route==='/api/state')return {...offlineState(files.data,v.first.id).snapshot,version,activeRequest:busy?'active-turn':null};if(route==='/api/shutdown'){stops++;throw Error('must not stop');}if(route.startsWith('/api/chat/rooms/'))return offlineState(files.data,v.first.id).history;if(route.startsWith('/api/team'))return offlineState(files.data,v.first.id).team;throw Error(route);},ensureServer:async()=>{starts++;}};
  await assert.rejects(desktopStart(files.data,{room_id:v.first.id},{main}),{code:'desktop_update_busy'});assert.equal(stops,0);assert.equal(starts,0);version='99.0.0';busy=false;assert.equal((await desktopStart(files.data,{room_id:v.first.id},{main})).update_available,false);assert.equal(stops,0);assert.equal(starts,1);
});

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
    const state=await desktopState(files.data,{}, {main});assert.equal(state.running,false);assert.equal(state.initialized,false);assert.equal(state.snapshot.instance_id,null);assert.deepEqual(state.snapshot.chat.rooms,[]);assert.equal(state.history,null);assert.equal(state.team,null);
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
  assert.deepEqual(start.team,JSON.parse(JSON.stringify(v.service.team.snapshot(v.first.id))));
  for(let i=0;i<3;i++){const state=await desktopState(v.data,{room_id:v.second.id},{main:v.main});assert.equal(state.running,true);assert.equal(state.history.room.id,v.second.id);}
  assert.equal(v.startCalls,1);
  const stopped=await desktopStop(v.data,{room_id:v.first.id},{main:v.main,isPidAlive:v.isPidAlive,sleep:v.sleep});assert.equal(stopped.running,false);assert.equal(stopped.snapshot.instance_id,v.instance);assert.equal(v.shutdowns,1);assert.equal(stopped.history.participants.find(member=>member.id===v.backend.id).native_thread_id,v.thread);
  assert.deepEqual(stopped.snapshot.chat.rooms.map(room=>room.id).sort(),before.snapshot.chat.rooms.map(room=>room.id).sort());assert.deepEqual(stopped.snapshot.chat.members.map(member=>member.id).sort(),before.snapshot.chat.members.map(member=>member.id).sort());
  const restarted=await desktopStart(v.data,{room_id:v.first.id},{main:v.main});assert.equal(restarted.snapshot.instance_id,v.instance);assert.deepEqual(restarted.history.messages.map(message=>message.id),[v.question.id]);assert.equal(restarted.history.participants.find(member=>member.id===v.backend.id).native_thread_id,v.thread);assert.equal(v.startCalls,2);
  assert.equal(databaseState(v.data).rows.chat_resume_credentials.length,initialCards);assert.ok(v.codices.every(codex=>codex.calls.length===0));
});

test('cold offline desktop retains complete team data with online projection parity and no recovery, scheduling or writes',async t=>{
  const files=fixture();let service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{assert.fail('offline fixture must never notify a real provider');}});
  t.after(async()=>{if(service)await service.close();cleanup(files);});
  const project=service.addProject({path:files.project,name:'Offline team project'}),room=service.chat.addRoom({project_id:project.id,title:'Offline team'}),other=service.chat.addRoom({project_id:project.id,title:'Other team'});
  const secretary=service.chat.addMember({name:'Saved secretary',adapter:'mailbox'}),worker=service.chat.addMember({name:'Saved research window',adapter:'mailbox'}),native=service.chat.addMember({name:'Saved native backend',adapter:'codex'});
  for(const member of [secretary,worker,native])service.chat.join(room.id,member.id);service.chat.join(other.id,worker.id);service.secretary.set({room_id:room.id,member_id:secretary.id});
  const nativeThread=id();service.chat.store.bind(room.id,native.id,'bound',nativeThread);
  const source=[{reference:'fixture://research/notes',note:'Saved window evidence',observed_at:new Date().toISOString()}];
  service.team.card({room_id:room.id,member_id:worker.id,role:'Research',skills:['fact checking'],information:'Has the prior research findings',sources:source,session_ref:'the-selected-existing-window'});
  service.team.card({room_id:other.id,member_id:worker.id,role:'Other room role',information:'Only this other room should contain this information',sources:[]});
  const goal=service.team.goal({room_id:room.id,title:'Saved goal',description:'Assemble evidence',acceptance:'Verified sources',idempotency_key:'offline-goal'});
  const task=service.team.createTask({room_id:room.id,goal_id:goal.id,title:'Saved task',assignee_id:worker.id,deliverable:'Research report',acceptance:'Source-linked report',idempotency_key:'offline-task'});
  const closed=service.team.meeting({room_id:room.id,title:'Completed meeting',agenda:'First round results',participant_ids:[worker.id,secretary.id],idempotency_key:'closed-meeting'});
  service.team.report(closed.id,{room_id:room.id,member_id:worker.id,summary:'Original report',sources:source,idempotency_key:'first-report'});
  service.team.save(service.team.record(closed.id,'meeting',room.id),{status:'review'},null,'fixture_collection_deadline_elapsed');
  service.team.closeMeeting(closed.id,{room_id:room.id,summary:'Original saved minutes',decisions:['Continue the saved task'],action_task_ids:[task.id],idempotency_key:'close-meeting'});
  service.team.report(closed.id,{room_id:room.id,member_id:secretary.id,summary:'Late report remains distinct',sources:source,idempotency_key:'late-report'});
  service.team.ack({room_id:room.id,member_id:worker.id,version:1});
  const collecting=service.team.meeting({room_id:room.id,title:'Unfinished meeting',agenda:'Await the missing report',participant_ids:[secretary.id,worker.id],idempotency_key:'collecting-meeting'});
  service.team.report(collecting.id,{room_id:room.id,member_id:secretary.id,summary:'Only one window reported',sources:source,idempotency_key:'partial-report'});
  const schedule=service.team.schedule({room_id:room.id,enabled:true,interval_hours:24,timezone:'Asia/Taipei'});
  service.team.save(schedule,{next_run_at:'2020-01-01T00:00:00.000Z'},null,'fixture_due_while_offline');
  const inFlight=service.chat.store.post({room_id:room.id,to_member_id:worker.id,text:'Persisted execution awaiting outcome',idempotency_key:'offline-processing'});service.chat.store.updateMessage(inFlight.id,{status:'processing'});
  service.team.save(task,{message_id:inFlight.id,status:'running'},null,'fixture_crash_state');
  service.store.db.prepare("UPDATE team_outbox SET status='uncertain',error='Saved delivery outcome needs review' WHERE record_id=?").run(goal.id);
  const expected=service.team.snapshot(room.id),otherExpected=service.team.snapshot(other.id),instance=service.runtime.instanceId;
  await service.close();service=null;
  const beforeDatabase=databaseState(files.data),beforeFiles=filesState(files.data);let apiCalls=0,starts=0;
  const main={readControl:()=>null,apiCall:()=>{apiCalls++;throw new Error('No service API on cold offline load');},ensureServer:()=>{starts++;throw new Error('No implicit service start');}};
  for(let i=0;i<3;i++){
    const restored=await desktopState(files.data,{room_id:room.id},{main});assert.equal(restored.running,false);assert.equal(restored.snapshot.instance_id,instance);assert.deepEqual(restored.team,expected);
    assert.equal(restored.team.cards.find(card=>card.member_id===native.id).native_session_ref,nativeThread);assert.equal(restored.team.cards.find(card=>card.member_id===worker.id).ack_version,1);
    assert.equal(restored.team.tasks[0].status,'running');assert.equal(restored.history.messages.find(message=>message.id===inFlight.id).status,'processing','offline reads must not run crash recovery');
    assert.deepEqual(restored.team.meetings.find(meeting=>meeting.id===collecting.id).missing_member_ids,[worker.id]);assert.equal(restored.team.meetings.find(meeting=>meeting.id===closed.id).late_revision,1);assert.match(restored.team.brief.content,/Original saved minutes/);
    assert.equal(restored.team.schedule.next_run_at,'2020-01-01T00:00:00.000Z','an overdue meeting remains unexecuted offline');assert.ok(restored.team.delivery_issues.length>0);
    const switched=await desktopState(files.data,{room_id:other.id},{main});assert.deepEqual(switched.team,otherExpected);assert.equal(switched.team.goals.length,0);assert.equal(switched.team.meetings.length,0);assert.equal(switched.team.cards[0].role,'Other room role');
  }
  assert.equal(apiCalls,0);assert.equal(starts,0);assert.deepEqual(databaseState(files.data),beforeDatabase);assert.deepEqual(filesState(files.data),beforeFiles);
});

test('offline viewing an older instance without team tables returns empty defaults and does not migrate its database',async t=>{
  const files=fixture();t.after(()=>cleanup(files));const saved=await seed(files),db=new DatabaseSync(path.join(files.data,'room.sqlite'));
  try{db.exec('DROP TABLE team_outbox; DROP TABLE team_events; DROP TABLE team_records;');}finally{db.close();}
  const before=databaseState(files.data),beforeFiles=filesState(files.data),state=offlineState(files.data,saved.first.id);
  assert.equal(state.team.room_id,saved.first.id);assert.equal(state.team.secretary_id,null);assert.equal(state.team.cards.length,2);assert.ok(state.team.cards.every(card=>card.context_status==='not_provided'));
  assert.deepEqual(state.team.goals,[]);assert.deepEqual(state.team.tasks,[]);assert.deepEqual(state.team.meetings,[]);assert.deepEqual(state.team.delivery_issues,[]);assert.deepEqual(state.team.brief,{version:0,content:'',updated_at:null});assert.equal(state.team.schedule.enabled,false);
  assert.deepEqual(databaseState(files.data),before);assert.deepEqual(filesState(files.data),beforeFiles);
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
