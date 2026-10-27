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
  const context=vm.createContext({$,state:{projects:[{id:'project'}],secretaries:{room:unassigned}},history:{room:{id:'room'},participants:[{id:'member',verified_at:'verified',status:'ready'}]},roomId:'room',projectId:'project',legacyId:null,professionalView:true,webConnected:true,selectedSetupMember:'member',secretaryNavigation:null,secretaryConnectRoom:'room',secretaryConnectJob:null,secretaryFinishing:false,secretaryBusy:false,secretaryStartBusy:false,secretaryPickingRoom:'room',secretaryOpenRoom:'room',secretaryError:'',secretaryDismissed:new Set(),refreshing:false,refreshWaiters:[],onboardingJobs:new Map(),onboardingFeedback:new Map(),onboardingStarting:new Set(),launchError:'',launchCandidates:[{id:'qwen-desktop',installed:true,capabilities:{mcp_prepare:true}}],
    admittedMembers:members=>members.filter(member=>member.verified_at&&!['connection_failed','failed','disabled','revoked','unavailable'].includes(member.status)),
    renderSecretary(){},updateOfficeScene(){},renderLaunch(){},updateRecipientNote(){},rememberSelection(){},showProject(){},showRoom(){},localStorage:{setItem(){}},toast:value=>notices.push(value),toggleOfficeComposer:value=>{context.composerOpen=value;},
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
function connectFlow(f,sourceName='picker',job={id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'ready_automatic',can_wake:true,ready_for_office:true}){
  const flow=f.context.beginSecretaryNavigation(sourceName);flow.jobId=job.id;f.context.onboardingJobs.set(job.id,job);f.context.secretaryConnectJob=job.id;f.$('secretary-connect-dialog').open=sourceName==='picker';f.$('member-setup-dialog').open=true;return flow;
}

test('automatic onboarding cannot leave setup until actual reply verification permits office navigation',async()=>{
  const f=fixture();connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'ready',stage:'ready_automatic',can_wake:true,ready_for_office:false});
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);assert.equal(f.$('secretary-connect-dialog').open,true);
  Object.assign(f.context.onboardingJobs.get('job'),{ready_for_office:true,automatic_reply_verified:true});await f.context.returnSecretaryAfterOnboarding();
  assert.equal(f.calls.length,1);assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);
  assert.equal(f.context.composerOpen,true,'the first secretary opens the shared composer');
  f.context.composerOpen=false;await f.context.returnSecretaryAfterOnboarding();assert.equal(f.context.composerOpen,false,'later refresh must not reopen a dismissed composer');
});

test('a newly connected member enters the office without replacing or assigning the secretary',async()=>{
  const f=fixture();connectFlow(f,'member',{id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'ready',stage:'ready_automatic',can_wake:true,ready_for_office:true,automatic_reply_verified:true});
  f.$('recipient').value='chosen-person';f.context.refresh=async()=>{};
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.context.state.secretaries.room.member_id,null);assert.equal(f.$('recipient').value,'chosen-person');
  assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);assert.equal(f.$('member-setup-dialog').open,false);
  assert.notEqual(f.context.composerOpen,true,'adding an ordinary member does not take over the composer');
});

test('automatic verification progress remains in setup and never assigns a secretary',async()=>{
  const f=fixture();connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'running',stage:'verifying_reply',can_wake:true,ready_for_office:false});
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);assert.equal(f.$('secretary-connect-dialog').open,true);
});

test('cached-login recheck never closes setup or assigns a secretary using historical ready flags',async()=>{
  const f=fixture();connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'codex',status:'ready_automatic',stage:'connection_recheck_available',auth_mode:'shared-cache',recheck_auth_revision:'native-shared-cache-v1',can_wake:true,ready_for_office:true,automatic_reply_verified:true});
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.context.state.secretaries.room.member_id,null);
});
test('native historical success and missing attempt acceptance cannot close setup',async()=>{
  for(const invalid of [{ready_for_office:undefined,status:'ready_automatic',can_wake:true},{ready_for_office:false,status:'ready_mailbox',can_wake:false},{ready_for_office:true,status:'ready_mailbox',can_wake:false},{ready_for_office:true,status:'ready_automatic',can_wake:false}]){
    const f=fixture();connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'doubao',connection_method:'native_desktop',...invalid});await f.context.returnSecretaryAfterOnboarding();assert.equal(f.$('secretary-connect-dialog').open,true);assert.equal(f.navigation.length,0);assert.equal(f.calls.length,0);
  }
});
test('explicit manual connection can enter as a member but cannot become an automatic secretary',async()=>{
  const job={id:'job',room_id:'room',member_id:'member',provider:'qwen-desktop',status:'ready_mailbox',connection_method:'manual_mcp',can_wake:false,ready_for_office:true};
  // Chosen in the AI picker, it joins as a member instead of stopping at an error; no secretary is assigned.
  const picker=fixture();picker.context.refresh=async()=>{};picker.$('secretary-connect-progress').querySelector=()=>null;connectFlow(picker,'picker',job);await picker.context.returnSecretaryAfterOnboarding();assert.equal(picker.calls.length,0);assert.equal(picker.context.state.secretaries.room.member_id,null);assert.deepEqual(picker.navigation,[['workspace',true],['office',true]]);assert.equal(picker.$('secretary-connect-dialog').open,false);assert.match(picker.notices.at(-1),/没有设为秘书/);
  // A native route that ended without automatic handling is still not trusted.
  const native=fixture();native.$('secretary-connect-progress').querySelector=()=>null;connectFlow(native,'picker',{...job,connection_method:'native_desktop'});await native.context.returnSecretaryAfterOnboarding();assert.equal(native.navigation.length,0);assert.equal(native.$('secretary-connect-dialog').open,true);assert.equal(native.calls.length,0);
  const member=fixture();member.context.refresh=async()=>{};connectFlow(member,'member',job);await member.context.returnSecretaryAfterOnboarding();assert.equal(member.calls.length,0);assert.deepEqual(member.navigation,[['workspace',true],['office',true]]);assert.equal(member.$('member-setup-dialog').open,false);
});
test('Grok pending and mailbox-ready picker flows open one owned guide without assigning a secretary',async()=>{
  for(const status of ['needs_action','ready_mailbox']){
    const f=fixture(),opened=[];f.context.showMemberSetup=async(id,flow)=>opened.push({id,flow});const flow=connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'grok-bot',native_direct_available:false,status,stage:status==='needs_action'?'awaiting_bridge_handshake':'ready_mailbox',can_wake:false});
    await f.context.returnSecretaryAfterOnboarding();await f.context.returnSecretaryAfterOnboarding();assert.equal(opened.length,1);assert.equal(opened[0].id,'member');assert.equal(opened[0].flow,flow);assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);
  }
  const foreign=fixture();foreign.context.showMemberSetup=async()=>assert.fail('foreign room guide must stay closed');connectFlow(foreign,'picker',{id:'job',room_id:'different',member_id:'member',provider:'grok-bot',status:'needs_action',can_wake:false});await foreign.context.returnSecretaryAfterOnboarding();assert.equal(foreign.calls.length,0);
});
test('Grok authorization and unsupported fixed routes remain in their declared steps instead of opening a copy modal',async()=>{
  for(const stage of ['awaiting_credential','unsupported','fixed_proxy_scope']){const f=fixture();f.context.showMemberSetup=async()=>assert.fail('a blocked route must not open a generic handoff');connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'grok-bot',native_direct_available:false,status:'needs_action',stage,can_wake:false});await f.context.returnSecretaryAfterOnboarding();assert.equal(f.calls.length,0);assert.equal(f.navigation.length,0);}
});
test('adding an existing connected Grok reuses configuration and enters office without another copy modal',async()=>{
  const f=fixture();f.context.showMemberSetup=async()=>assert.fail('valid reused connection must not ask for another window handoff');
  connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'member',provider:'grok-bot',native_direct_available:false,status:'ready_mailbox',can_wake:false,connection_reused:true,ready_for_office:true});f.context.refresh=async()=>{};
  await f.context.returnSecretaryAfterOnboarding();assert.equal(f.$('secretary-connect-dialog').open,false);assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);assert.equal(f.calls.length,0);assert.equal(f.context.state.secretaries.room.member_id,null);assert.match(f.notices.at(-1),/用的是原来的连接/);assert.doesNotMatch(f.notices.at(-1),/本次真实连接|自动接通/);
});
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
  Object.assign(f.context.onboardingJobs.get('job'),{status:'ready_automatic',can_wake:true,ready_for_office:true});await f.context.returnSecretaryAfterOnboarding();
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

test('taking over the text view cancels a pending guided flow, but entering the office does not',()=>{
  const f=fixture(),stubs={legacyId:null,roomId:'room',officeView:true,textScroll:new Map(),localStorage:{setItem(){}},applyRoomView(){},updateOfficeScene(){},rememberTextScroll(){},requestAnimationFrame(){}};
  const context=vm.createContext({$:f.$,...stubs,secretaryNavigation:null});vm.runInContext(section('function selectRoomView(','// Late layout'),context);
  context.secretaryNavigation=f.context.beginSecretaryNavigation('picker');context.selectRoomView(true);assert.ok(context.secretaryNavigation,'office view keeps the flow');
  context.selectRoomView(false);assert.equal(context.secretaryNavigation,null,'text view cancels it');
});
test('connecting a different member to a ready room never replaces the person’s chosen recipient',async()=>{
  const f=fixture();f.context.history.participants.push({id:'other',verified_at:'verified',status:'ready'});f.context.state.secretaries.room={...f.ready};f.$('recipient').value='keep-me';
  connectFlow(f,'picker',{id:'job',room_id:'room',member_id:'other',provider:'qwen-desktop',status:'ready_automatic',can_wake:true,ready_for_office:true});
  await f.context.returnSecretaryAfterOnboarding();
  assert.equal(f.$('recipient').value,'keep-me');assert.equal(f.calls.filter(call=>call.route==='/api/secretary').length,0);assert.deepEqual(f.navigation,[['workspace',true],['office',true]]);assert.ok(f.notices.includes('成员已真实接通，已进入办公室。'));
});
