'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(overrides={}){
  const elements=new Map(),calls=[],completions=[],events=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{open:id==='secretary-connect-dialog',innerHTML:'',value:'',querySelector:()=>null,querySelectorAll:()=>[],close(){this.open=false;},classList:{toggle(){}}});return elements.get(id);};
  const job={id:'original',provider:'codex',name:'Codex',room_id:'room',member_id:'member',status:'needs_action',stage:'awaiting_auth',ready_for_office:false,next_actions:[{kind:'login',operation:'login_client',instruction:'在弹出的专用配置窗口完成账号授权'},{operation:'retry'}],...overrides};
  const flow={source:'picker',roomId:'room',projectId:'project',jobId:job.id,memberId:job.member_id};
  const context=vm.createContext({$,Map,Error,roomId:'room',projectId:'project',legacyId:null,secretaryNavigation:flow,secretaryConnectJob:job.id,secretaryConnectRoom:'room',onboardingJobs:new Map([[job.id,job]]),onboardingFeedback:new Map(),onboardingSignature:'',onboardingTimer:null,webConnected:true,
    state:{approvals:[],chat:{rooms:[{id:'room',project_id:'project'},{id:'fixed',project_id:'original-project'}]}},history:{participants:[]},launchCandidates:[],launchSelection:new Set(),launchScanning:false,launchBusy:false,onboardingStarting:new Set(),lastLaunchCandidates:'',
    avatar:()=>'',escape:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),clientConfigLabel:()=>'',clientImportKind:()=>'',nativeConnectNextStep:()=>'',roomUsesGrok:()=>false,nativeReadinessMarkup:()=>'',onboardingApprovalMarkup:()=>'',tickOnboardingElapsed(){},
    secretaryNavigationCurrent:value=>!!value&&value===context.secretaryNavigation&&value.roomId===context.roomId&&value.projectId===context.projectId&&!context.legacyId,
    beginSecretaryNavigation:source=>context.secretaryNavigation={source,roomId:context.roomId,projectId:context.projectId,jobId:null},
    renderLaunch(){context.renderOnboarding();const active=context.onboardingJobs.get(context.secretaryConnectJob);$('secretary-connect-progress').innerHTML=active?context.onboardingJobMarkup(active):'';},
    setApprovalMarkup:(element,html)=>{element.innerHTML=html;},refresh:async()=>events.push('refresh'),refreshOnboarding:async()=>events.push('poll'),refreshLaunch:async()=>context.renderLaunch(),
    returnSecretaryAfterOnboarding:()=>{completions.push(context.secretaryNavigation?.jobId);},action:callback=>callback(),setTimeout:()=>0,
    rememberSelection:()=>events.push('remember'),setReply:value=>events.push(['reply',value]),setProfessionalView:value=>events.push(['workspace',value]),showMemberSetup:async id=>events.push(['setup',id]),
    api:async(route,body)=>{calls.push({route,body});return{...job};}
  });
  vm.runInContext(section('function launchProvider(', 'const providerDocs')+section('function onboardingCanInstall(', 'function renderLaunch()')+section('function onboardingView(', 'function roomUsesGrok(')+section('function onboardingJobMarkup(', 'async function refreshOnboarding()')+section('async function checkOnboarding(', 'function onboardingProgressTarget()'),context);
  return{context,$,job,flow,calls,completions,events};
}

test('retry replaces the tracked attempt before completion and does not issue a second onboarding start',async()=>{
  const f=fixture();f.context.api=async(route,body)=>{f.calls.push({route,body});return{...f.job,id:'replacement',status:'running',stage:'verifying_reply'};};
  await f.context.runOnboardingOperation(f.job,'retry');
  assert.equal(f.flow.jobId,'replacement');assert.equal(f.context.secretaryConnectJob,'replacement');assert.equal(f.completions[0],'replacement');
  assert.deepEqual(plain(f.calls),[{route:'/api/onboarding/jobs/original/retry',body:{}}]);assert.equal(f.context.onboardingFeedback.has('original'),false);
  assert.equal(f.context.onboardingFeedback.get('replacement').pending,false);
});
test('a visible saved progress action owns its navigation without requiring another candidate click',async()=>{
  const f=fixture();f.context.secretaryNavigation=null;f.context.secretaryConnectJob=null;f.context.api=async()=>({...f.job,id:'new-attempt',status:'running'});
  await f.context.runOnboardingOperation(f.job,'retry');assert.equal(f.context.secretaryNavigation.source,'picker');assert.equal(f.context.secretaryNavigation.jobId,'new-attempt');assert.equal(f.context.secretaryConnectJob,'new-attempt');assert.equal(f.completions[0],'new-attempt');
});

test('check follows a replacement managed run and a simple continue selection can check without retrying',async()=>{
  for(const retry of [true,false]){
    const f=fixture();f.context.api=async(route,body)=>{f.calls.push({route,body});return route.endsWith('/retry')?{...f.job,id:'retry-run',status:'running'}:{...f.job};};
    await f.context.checkOnboarding(f.job.id,{retry});assert.equal(f.calls.length,retry?2:1);assert.equal(f.flow.jobId,retry?'retry-run':'original');
    assert.equal(f.context.secretaryConnectJob,f.flow.jobId);
  }
});

test('late retry results never replace a newer picker flow or another room',async()=>{
  for(const change of ['flow','room']){
    const f=fixture(),gate=deferred();f.context.api=async()=>gate.promise;const pending=f.context.runOnboardingOperation(f.job,'retry');
    const newer={...f.flow,jobId:'newer'};if(change==='flow')f.context.secretaryNavigation=newer;else f.context.roomId='another-room';f.context.secretaryConnectJob='newer';
    gate.resolve({...f.job,id:'late',status:'running'});await pending;
    assert.equal(f.context.secretaryConnectJob,'newer');assert.equal(f.context.secretaryNavigation.jobId,change==='flow'?'newer':'original');
  }
});

test('a room switch during read-only check prevents the subsequent retry mutation',async()=>{
  const f=fixture(),gate=deferred();f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};
  const pending=f.context.checkOnboarding(f.job.id);f.context.roomId='later-room';gate.resolve({...f.job});await pending;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,undefined);assert.equal(f.flow.jobId,'original');
});

test('foreign room, provider and member acknowledgement cannot replace any tracked attempt',async()=>{
  for(const foreign of [{room_id:'other'},{provider:'doubao'},{member_id:'other'}]){
    const f=fixture();f.context.api=async()=>({...f.job,id:'foreign',...foreign});await assert.rejects(f.context.runOnboardingOperation(f.job,'retry'),/不匹配/);
    assert.equal(f.flow.jobId,'original');assert.equal(f.context.secretaryConnectJob,'original');assert.equal(f.context.onboardingJobs.has('foreign'),false);
    assert.match(f.$('secretary-connect-progress').innerHTML,/role="alert"/);
  }
});

test('login is a real action despite an instruction, stays pending in the modal and rejects duplicate clicks',async()=>{
  const f=fixture(),gate=deferred();f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};
  const pending=f.context.runOnboardingOperation(f.job,'login_client');await f.context.runOnboardingOperation(f.job,'login_client');
  let html=f.$('secretary-connect-progress').innerHTML;
  assert.match(html,/正在打开账号配置入口/);assert.match(html,/data-onboarding-operation="login_client"/);assert.match(html,/<button disabled/);assert.doesNotMatch(html,/data-onboarding-copy=/);assert.equal(f.calls.length,1);
  gate.resolve({job:f.job,action:{launched:true,instruction:'专用配置窗口已打开，完成授权后再继续接入'}});await pending;
  html=f.$('secretary-connect-progress').innerHTML;assert.match(html,/专用配置窗口已打开/);assert.doesNotMatch(html,/onboarding-job ready/);assert.equal(f.flow.jobId,'original');
  f.context.renderOnboarding();assert.match(f.$('onboarding-jobs').innerHTML,/专用配置窗口已打开/,'polls with identical server state retain the action feedback');
});

test('login failure and unconfirmed launch stay as errors inside the current attempt after polling',async()=>{
  for(const failure of [Object.assign(Error('无法打开首次配置窗口'),{code:'login_launch_failed'}),null]){
    const f=fixture();f.context.api=async()=>{if(failure)throw failure;return{job:f.job,action:{launched:false}};};
    await assert.rejects(f.context.runOnboardingOperation(f.job,'login_client'),/配置/);f.context.renderOnboarding();
    assert.match(f.$('onboarding-jobs').innerHTML,/role="alert"/);assert.match(f.$('secretary-connect-progress').innerHTML,/配置/);assert.equal(f.context.onboardingFeedback.get('original').pending,false);
    assert.equal(f.context.onboardingOfficeReady(f.job),false);
  }
});

test('native client start explains one full exit and keeps a typed restart failure visible',async()=>{
  const f=fixture({provider:'doubao',stage:'awaiting_native_desktop',next_actions:[{kind:'open_native_client',operation:'open_native_client'},{operation:'native_desktop_connect'},{operation:'manual_mcp',target_member_id:'member'}]});
  f.context.renderLaunch();const before=f.$('secretary-connect-progress').innerHTML;assert.match(before,/开启客户端连接/);assert.match(before,/菜单或托盘完整退出/);assert.match(before,/不用填写端口或命令/);
  f.context.api=async(route,body)=>{f.calls.push({route,body});throw Object.assign(Error('客户端仍在运行。请从菜单或托盘完整退出，再开启连接。'),{code:'desktop_client_restart_required'});};
  await assert.rejects(f.context.runOnboardingOperation(f.job,'open_native_client'),/完整退出/);
  assert.deepEqual(plain(f.calls),[{route:'/api/onboarding/action',body:{run_id:'original',operation:'open_native_client'}}]);assert.match(f.$('secretary-connect-progress').innerHTML,/role="alert"/);assert.match(f.$('secretary-connect-progress').innerHTML,/客户端仍在运行/);
});

test('manual compatibility is explicit, scoped to the original member and adopts its own attempt',async()=>{
  const f=fixture({provider:'qwen-desktop',connection_method:'native_desktop',stage:'awaiting_native_desktop',next_actions:[{operation:'manual_mcp',target_member_id:'member'}]});
  f.context.api=async(route,body)=>{f.calls.push({route,body});return{...f.job,id:'manual',connection_method:'manual_mcp',status:'needs_action',stage:'awaiting_handshake'};};
  await f.context.runOnboardingOperation(f.job,'manual_mcp');assert.deepEqual(plain(f.calls),[{route:'/api/onboarding/start',body:{room_id:'room',provider:'qwen-desktop',target_member_id:'member',connection_method:'manual_mcp'}}]);
  assert.equal(f.flow.jobId,'manual');assert.equal(f.context.secretaryConnectJob,'manual');assert.equal(f.context.onboardingOfficeReady(f.context.onboardingJobs.get('manual')),false);
  const foreign=fixture({provider:'qwen-desktop',next_actions:[{operation:'manual_mcp',target_member_id:'other'}]});await assert.rejects(foreign.context.runOnboardingOperation(foreign.job,'manual_mcp'),/步骤已变化/);assert.equal(foreign.calls.length,0);assert.doesNotMatch(foreign.context.onboardingActionMarkup(foreign.job),/data-onboarding-operation="manual_mcp"/);
});

test('reauthorization shares run adoption and preserves the exact declared person',async()=>{
  const f=fixture({stage:'awaiting_credential',next_actions:[{operation:'reauthorize',target_member_id:'member'}]});f.context.api=async(route,body)=>{f.calls.push({route,body});return{...f.job,id:'authorized',status:'running'};};
  await f.context.runOnboardingOperation(f.job,'reauthorize');assert.deepEqual(plain(f.calls),[{route:'/api/onboarding/start',body:{room_id:'room',provider:'codex',target_member_id:'member',reauthorize:true}}]);assert.equal(f.flow.jobId,'authorized');assert.equal(f.context.secretaryConnectJob,'authorized');
});

test('current attempt readiness is mandatory and native mailbox success cannot masquerade as automatic connection',()=>{
  const f=fixture();for(const job of [{status:'ready_automatic',can_wake:true},{status:'ready_automatic',can_wake:true,ready_for_office:false},{provider:'doubao',status:'ready_mailbox',can_wake:false,ready_for_office:true},{provider:'qwen-desktop',status:'ready_automatic',can_wake:false,ready_for_office:true}]){
    const value={...f.job,...job};if(!Object.hasOwn(job,'ready_for_office'))delete value.ready_for_office;assert.equal(f.context.onboardingOfficeReady(value),false);assert.doesNotMatch(f.context.onboardingJobMarkup(value),/onboarding-job ready|已接通 · 要在/);
  }
  assert.equal(f.context.onboardingOfficeReady({...f.job,provider:'doubao',status:'ready_mailbox',connection_method:'manual_mcp',can_wake:false,ready_for_office:true}),true);
});

test('running discovery states are subordinate to actual authorization and attempt progress',()=>{
  const f=fixture();f.context.launchCandidates=[{id:'codex',name:'Codex',installed:true,running:true,capabilities:{automatic_launch:true}}];f.context.renderLaunchCandidates();
  let html=f.$('launch-candidates').innerHTML;assert.match(html,/需要后台账号授权 · 尚未接通/);assert.match(html,/继续账号授权/);assert.doesNotMatch(html,/正在运行|本次连接已验证/);
  f.context.onboardingJobs.clear();f.context.renderLaunchCandidates();html=f.$('launch-candidates').innerHTML;assert.match(html,/已发现本机进程 · 尚未验证 AO 连接/);assert.doesNotMatch(html,/本次连接已验证/);
});
test('the explicit current attempt wins over historical jobs with newer observation timestamps',()=>{
  const f=fixture();const current={...f.job,id:'current',status:'running',stage:'verifying_reply',created:'2026-10-21T10:00:00Z'};f.context.onboardingJobs.set('current',current);f.job.updated='2099-01-01';f.flow.jobId='current';f.context.secretaryConnectJob='current';
  assert.equal(f.context.onboardingForProvider('codex').id,'current');assert.equal(f.context.currentOnboardingJobs()[0].id,'current');
});

test('fixed Grok scope offers the existing room without rebinding or producing credentials',async()=>{
  const f=fixture({provider:'grok-bot',stage:'fixed_proxy_scope',next_actions:[{operation:'open_fixed_room',room_id:'fixed',target_member_id:'member'}]});assert.match(f.context.onboardingActionMarkup(f.job),/查看原房间连接/);
  await f.context.runOnboardingOperation(f.job,'open_fixed_room');assert.equal(f.context.roomId,'fixed');assert.equal(f.context.projectId,'original-project');assert.equal(f.calls.length,0);assert.equal(f.$('secretary-connect-dialog').open,false);assert.ok(f.events.some(value=>Array.isArray(value)&&value[0]==='setup'&&value[1]==='member'));
  const missing=fixture({provider:'grok-bot',next_actions:[{operation:'open_fixed_room',room_id:'removed',target_member_id:'member'}]});await assert.rejects(missing.context.runOnboardingOperation(missing.job,'open_fixed_room'),/原房间暂不可用/);assert.equal(missing.$('secretary-connect-dialog').open,true);assert.equal(missing.calls.length,0);
});
