'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const elements=new Map(),calls=[],notices=[],navigation=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{open:false,value:'',innerHTML:'',closeCount:0,showModal(){this.open=true;},close(){this.open=false;this.closeCount++;},scrollIntoView(){},classList:{toggle(){}}});return elements.get(id);};
  const unassigned={room_id:'room',member_id:null,status:'unassigned',assignment_id:null};
  const ready={room_id:'room',member_id:'member',status:'ready',assignment_id:'assignment',can_wake:true};
  const context=vm.createContext({$,state:{projects:[{id:'project'}],secretaries:{room:unassigned}},history:{room:{id:'room'},participants:[{id:'member',verified_at:'verified',status:'ready'}]},roomId:'room',projectId:'project',legacyId:null,professionalView:true,webConnected:true,selectedSetupMember:'member',secretaryNavigation:null,secretaryConnectRoom:'room',secretaryConnectJob:null,secretaryFinishing:false,secretaryBusy:false,secretaryStartBusy:false,secretaryPickingRoom:'room',secretaryOpenRoom:'room',secretaryError:'',secretaryDismissed:new Set(),refreshing:false,refreshWaiters:[],onboardingJobs:new Map(),onboardingStarting:new Set(),launchError:'',launchCandidates:[{id:'qwen-desktop',installed:true,capabilities:{mcp_prepare:true}}],
    admittedMembers:members=>members.filter(member=>member.verified_at&&!['connection_failed','failed','disabled','revoked','unavailable'].includes(member.status)),
    renderSecretary(){},updateOfficeScene(){},renderLaunch(){},updateRecipientNote(){},rememberSelection(){},showProject(){},showRoom(){},localStorage:{setItem(){}},toast:value=>notices.push(value),
    setProfessionalView:value=>{context.professionalView=value;navigation.push(['workspace',value]);},selectRoomView:value=>navigation.push(['office',value]),
    action:async callback=>{try{return await callback();}catch(error){notices.push(error.message);}},
    refresh:async()=>{context.state.secretaries.room={...ready};},refreshLaunch:async()=>{},refreshOnboarding:async()=>{},setTimeout:()=>0,clearTimeout(){},
    api:async(route,body)=>{calls.push({route,body});if(route==='/api/secretary')return{secretary:{...ready}};throw Error('Unexpected '+route);}
  });
  vm.runInContext(section('function launchProvider(', 'const providerDocs')+section('function onboardingCanInstall(', 'function renderLaunch()')+section('function onboardingView(', 'function onboardingAction(')+
    section('function onboardingProgressTarget()', 'function renderRuntime()')+section('function currentSecretary(', 'function secretaryMember(')+
    section('function closeSecretaryTutorial()', 'function renderSecretary()')+section('function beginSecretaryNavigation(', 'async function clearSecretary()'),context);
  return{context,$,calls,notices,navigation,ready};
}
function connectFlow(f,sourceName='picker',job={id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'ready_automatic',can_wake:true}){
  const flow=f.context.beginSecretaryNavigation(sourceName);flow.jobId=job.id;f.context.onboardingJobs.set(job.id,job);f.context.secretaryConnectJob=job.id;f.$('secretary-connect-dialog').open=sourceName==='picker';f.$('member-setup-dialog').open=true;return flow;
}
test('choosing a ready secretary closes its tutorial and owned setup without starting a goal',async()=>{
  const f=fixture();f.$('member-setup-dialog').open=true;await f.context.chooseSecretary('member');
  assert.equal(f.context.secretaryOpenRoom,null);assert.equal(f.context.secretaryNavigation,null);assert.equal(f.$('member-setup-dialog').open,false);assert.equal(f.$('recipient').value,'member');assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);
  assert.deepEqual(f.calls.map(call=>call.route),['/api/secretary']);
});
test('a saved but unready secretary stays in the tutorial until a fresh canonical ready snapshot',async()=>{
  const f=fixture();f.context.refresh=async()=>{f.context.state.secretaries.room={...f.ready,status:'awaiting_connection'};};await f.context.chooseSecretary('member');
  assert.equal(f.context.secretaryOpenRoom,'room');assert.equal(f.navigation.length,0);
  f.context.returnSecretaryAfterOnboarding();assert.equal(f.navigation.length,0);
  f.context.state.secretaries.room={...f.ready};f.context.returnSecretaryAfterOnboarding();assert.equal(f.navigation.length,2);
  f.context.secretaryOpenRoom='room';f.context.returnSecretaryAfterOnboarding();assert.equal(f.context.secretaryOpenRoom,'room');assert.equal(f.navigation.length,2,'later refresh never replays consumed navigation');
});
test('ready picker onboarding waits for authoritative refresh, then closes both owned dialogs once',async()=>{
  const f=fixture();connectFlow(f);f.context.refreshing=true;const pending=f.context.returnSecretaryAfterOnboarding();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.navigation.length,0);assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.context.state.secretaries.room.status,'unassigned');
  f.context.refreshing=false;f.context.refreshWaiters.splice(0).forEach(resolve=>resolve());await pending;
  assert.equal(f.$('secretary-connect-dialog').open,false);assert.equal(f.$('member-setup-dialog').open,false);assert.equal(f.context.secretaryOpenRoom,null);assert.equal(f.calls.length,1);
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,1);assert.equal(f.navigation.length,2);
});
test('the launch home starts the same completion flow and enters the created office',async()=>{
  const f=fixture();f.context.professionalView=false;f.context.roomId=null;f.context.history={room:{id:'new-room'},participants:[{id:'member',verified_at:'verified',status:'ready'}]};
  f.context.api=async(route,body)=>{f.calls.push({route,body});if(route==='/api/onboarding/start')return{id:'job',room_id:'new-room',member_id:'member',provider:'qwen-desktop',status:'running'};if(route==='/api/secretary')return{...f.ready,room_id:'new-room'};throw Error(route);};
  f.context.refresh=async()=>{f.context.state.secretaries['new-room']=f.calls.some(call=>call.route==='/api/secretary')?{...f.ready,room_id:'new-room'}:{room_id:'new-room',member_id:null,status:'unassigned'};};
  await f.context.startOnboarding('qwen-desktop');assert.equal(f.context.roomId,'new-room');assert.equal(f.context.secretaryNavigation.source,'launch');assert.equal(f.context.secretaryNavigation.jobId,'job');
  f.context.onboardingJobs.get('job').status='ready_automatic';f.context.onboardingJobs.get('job').can_wake=true;await f.context.returnSecretaryAfterOnboarding();
  assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);assert.equal(f.context.secretaryOpenRoom,null);assert.equal(f.calls.filter(call=>call.route==='/api/secretary/start').length,0);
});
test('late launch preparation never selects a room after the user selected another room or project',async()=>{
  for(const change of ['room','project']){
    const f=fixture(),gate=deferred();f.context.professionalView=false;f.context.roomId=null;f.context.api=async()=>gate.promise;
    const pending=f.context.startOnboarding('qwen-desktop');if(change==='room')f.context.roomId='later-room';else f.context.projectId='later-project';
    gate.resolve({id:'job',room_id:'created-room',member_id:'member',provider:'qwen-desktop',status:'ready_automatic',can_wake:true});await pending;
    assert.equal(f.context.roomId,change==='room'?'later-room':null);assert.equal(f.navigation.length,0);
  }
});
test('a room switch while assignment is pending leaves the later room and its dialogs untouched',async()=>{
  const f=fixture(),gate=deferred();connectFlow(f);f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};const pending=f.context.returnSecretaryAfterOnboarding();
  f.context.roomId='later-room';f.context.secretaryOpenRoom='later-room';gate.resolve({secretary:f.ready});await pending;
  assert.equal(f.context.secretaryOpenRoom,'later-room');assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.navigation.length,0);
});
test('the final current job must still be ready for the same member and room after asynchronous assignment',async()=>{
  for(const changed of [{status:'failed'},{status:'needs_action'},{member_id:'different'},{room_id:'different'},{can_wake:false}]){
    const f=fixture(),gate=deferred();connectFlow(f);f.context.api=async()=>gate.promise;const pending=f.context.returnSecretaryAfterOnboarding();
    f.context.onboardingJobs.set('job',{...f.context.onboardingJobs.get('job'),...changed});gate.resolve({secretary:f.ready});await pending;
    assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.$('member-setup-dialog').open,true);assert.equal(f.navigation.length,0);
  }
});
test('a background refresh selecting the just-created room before the acknowledgement keeps its original launch flow',async()=>{
  const f=fixture(),gate=deferred();f.context.professionalView=false;f.context.roomId=null;f.context.api=async()=>gate.promise;const pending=f.context.startOnboarding('qwen-desktop');
  f.context.roomId='new-room';gate.resolve({id:'job',room_id:'new-room',member_id:'member',provider:'qwen-desktop',status:'running'});await pending;
  assert.equal(f.context.secretaryNavigation.roomId,'new-room');assert.equal(f.context.secretaryNavigation.jobId,'job');assert.equal(f.navigation.length,0);
});
test('an old launch acknowledgement cannot select its created room for a newer empty-room flow',async()=>{
  const f=fixture(),gate=deferred();f.context.professionalView=false;f.context.roomId=null;f.context.api=async()=>gate.promise;const pending=f.context.startOnboarding('qwen-desktop');
  const newer=f.context.beginSecretaryNavigation('launch');gate.resolve({id:'old-job',room_id:'old-created-room',member_id:'member',provider:'qwen-desktop',status:'ready_automatic',can_wake:true});await pending;
  assert.equal(f.context.roomId,null);assert.equal(f.context.secretaryNavigation,newer);assert.equal(newer.roomId,null);assert.equal(f.navigation.length,0);
});
test('only an automatic room fallback may be replaced by the pending flow own created room',async()=>{
  const f=fixture(),gate=deferred();f.context.professionalView=false;f.context.roomId=null;f.context.api=async()=>gate.promise;const pending=f.context.startOnboarding('qwen-desktop');
  f.context.roomId='auto-selected-room';f.context.secretaryNavigation.autoRoomId='auto-selected-room';gate.resolve({id:'job',room_id:'own-created-room',member_id:'member',provider:'qwen-desktop',status:'running'});await pending;
  assert.equal(f.context.roomId,'own-created-room');assert.equal(f.context.secretaryNavigation.roomId,'own-created-room');assert.equal(f.context.secretaryNavigation.jobId,'job');assert.equal(f.navigation.length,0);
});
test('an old completion cannot clear a newer same-room flow or close its wizard',async()=>{
  const f=fixture(),gate=deferred();connectFlow(f);f.context.api=async()=>gate.promise;const pending=f.context.returnSecretaryAfterOnboarding();
  const newer=f.context.beginSecretaryNavigation('picker');newer.jobId='later-job';f.context.secretaryConnectJob='later-job';gate.resolve({secretary:f.ready});await pending;
  assert.equal(f.context.secretaryNavigation,newer);assert.equal(f.context.secretaryConnectJob,'later-job');assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.navigation.length,0);
});
test('a changed canonical secretary after assignment is never replaced by the old recipient',async()=>{
  const f=fixture();connectFlow(f);f.$('recipient').value='later-member';f.context.refresh=async()=>{f.context.state.secretaries.room={...f.ready,member_id:'later-member',assignment_id:'later-assignment'};};await f.context.returnSecretaryAfterOnboarding();
  assert.equal(f.$('recipient').value,'later-member');assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.navigation.length,0);assert.match(f.context.secretaryError,/其他窗口变更/);
});
test('failed or incomplete onboarding never closes the guide or assigns a secretary',async()=>{
  for(const status of ['failed','needs_action','running','cancelled']){const f=fixture();connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',status,can_wake:true});await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);assert.equal(f.$('secretary-connect-dialog').open,true);}
  const f=fixture();connectFlow(f);f.context.api=async()=>{throw Error('connection rejected');};await f.context.returnSecretaryAfterOnboarding();await f.context.returnSecretaryAfterOnboarding();assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.navigation.length,0);assert.match(f.context.secretaryError,/connection rejected/);
});
test('canonical ready without this room member, or a different setup selection, cannot close that setup',async()=>{
  const f=fixture();connectFlow(f);f.context.history.participants[0].status='connection_failed';await f.context.returnSecretaryAfterOnboarding();assert.equal(f.navigation.length,0);assert.equal(f.$('member-setup-dialog').open,true);
  f.context.history.participants[0].status='ready';f.context.selectedSetupMember='other-member';await f.context.returnSecretaryAfterOnboarding();assert.equal(f.navigation.length,2);assert.equal(f.$('member-setup-dialog').open,true);
});
test('a ready room loaded without an active user flow never navigates',()=>{
  const f=fixture();f.context.state.secretaries.room={...f.ready};f.context.onboardingJobs.set('old-job',{status:'ready_automatic',room_id:'room',member_id:'member',can_wake:true});f.context.secretaryConnectJob='old-job';f.context.returnSecretaryAfterOnboarding();assert.equal(f.navigation.length,0);assert.equal(f.context.secretaryOpenRoom,'room');
});
