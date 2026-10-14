'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function plain(value){return JSON.parse(JSON.stringify(value));}
function fixture({provider='qwen-desktop',adapter='mcp',evidence={},verifiedAt='old-protocol-proof'}={}){
  const elements=new Map,calls=[],notices=[],copied=[],bridges=[];let refreshes=0,onboardingRefreshes=0;
  const $=id=>{if(!elements.has(id)){const classes=new Set;elements.set(id,{innerHTML:'',textContent:'',value:'',dataset:{},open:false,disabled:false,classList:{toggle(name,value){if(value??!classes.has(name))classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},querySelector:()=>null,querySelectorAll:()=>[],cloneNode(){return{innerHTML:this.innerHTML,querySelector:()=>null,querySelectorAll:()=>[]};},showModal(){this.open=true;},close(){this.open=false;}});}return elements.get(id);};
  const member={id:'member/native',name:'本人同事',adapter,provider,verified_at:verifiedAt,runtime_state:{connection_evidence:evidence}};
  const client={kind:'native_desktop',provider,native_state:{configured:false,can_wake:false},connection_evidence:evidence};
  const context=vm.createContext({$,roomId:'room:one',legacyId:null,selectedSetupMember:member.id,setupData:{member,client},nativeSetupPending:null,nativeSetupFailure:null,lastSetupSignature:'',webConnected:true,
    state:{chat:{members:[member]}},toast:value=>notices.push(value),memberStatus:()=>({tone:'online',label:'旧协议已验证'}),memberPresence:()=>({status:'unknown',label:'在线性未知',canWake:false}),time:value=>String(value),
    refresh:async()=>{refreshes++;},refreshOnboarding:async()=>{onboardingRefreshes++;},renderLaunch:()=>{},showBridge:async id=>bridges.push(id),showResume:async()=>{},
    openInspector:()=>{},runConnectionDoctor:async()=>{},clientConfigLabel:()=>'',clientImportKind:()=>'',navigator:{clipboard:{writeText:async value=>copied.push(value)}},action:async callback=>callback(),
    api:async(route,body)=>{calls.push({route,body});return body?{}:{member,client};}
  });
  context.memberById=id=>context.state.chat.members.find(item=>item.id===id);
  vm.runInContext(section('const escape =','const time =')+section('function nativeDesktopProvider(', 'function launchSelectable(')+
    section('function onboardingActions(', 'function roomUsesGrok(')+section('async function connectMember(', 'function updateRecipientNote(')+
    section("$('member-setup-content').onclick =", "$('member-grok-form').onsubmit")+
    section("$('member-connect-guide').onclick =", "$('member-copy-entry').onclick"),context);
  return{context,$,member,client,calls,notices,copied,bridges,get refreshes(){return refreshes;},get onboardingRefreshes(){return onboardingRefreshes;}};
}
function click(attribute,dataset={}){const button={dataset,hasAttribute:name=>name===attribute};return{target:{closest:()=>button}};}

test('protocol verification never claims a loaded native conversation or actual reply',()=>{
  const f=fixture({evidence:{protocol_verified:true}});f.context.renderSetup();
  assert.match(f.$('member-connect-guide').innerHTML,/待连接验证/);assert.match(f.$('member-connect-guide').innerHTML,/待实际任务验证/);
  assert.match(f.$('member-setup-status').innerHTML,/本人对话待验证/);assert.doesNotMatch(f.$('member-setup-status').innerHTML,/旧协议已验证|old-protocol-proof|验证于/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:true,model_reply_verified:false};f.context.renderSetup();
  assert.match(f.$('member-setup-status').innerHTML,/本人对话已加载/);assert.match(f.$('member-connect-guide').innerHTML,/发一条消息后核对实际回复/);
  assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:true,model_reply_verified:true};f.context.renderSetup();
  assert.match(f.$('member-setup-status').innerHTML,/本人实际回复已核对/);assert.match(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:false,model_reply_verified:false};f.client.connection_evidence={native_conversation_loaded:true,model_reply_verified:true};f.context.renderSetup();
  assert.match(f.$('member-connect-guide').innerHTML,/待连接验证/);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/,'fresh runtime evidence overrides the old guide');
});

test('native primary UI hides private values and preserves explicit compatibility copying without reconnecting',async()=>{
  const f=fixture({verifiedAt:null});const fallback={title:'兼容 MCP',steps:['按需导入客户端'],fields:{room_id:'PRIVATE-ROOM',token:'PRIVATE-TOKEN'},copy:'PRIVATE-CONFIG',bootstrap:'PRIVATE-BOOTSTRAP',installation_prompt:'PRIVATE-INSTALL'};
  f.client.fallback=fallback;f.context.setupData.instructions='PRIVATE-INSTRUCTIONS';f.context.setupData.mcp={token:'PRIVATE-MCP'};f.context.renderSetup();
  const html=f.$('member-connect-guide').innerHTML+f.$('member-setup-content').innerHTML;
  assert.match(html,/data-native-connect/);assert.match(html,/高级：连接诊断与兼容 MCP/);assert.match(html,/data-copy-guide/);assert.doesNotMatch(html,/PRIVATE-|room:one|member\/native/);
  await f.$('member-connect-guide').onclick(click('data-copy-guide'));await f.$('member-connect-guide').onclick(click('data-copy-bootstrap'));await f.$('member-connect-guide').onclick(click('data-copy-install'));
  f.$('member-setup-content').onclick(click('data-copy-setup',{copySetup:'instructions'}));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.copied,['PRIVATE-CONFIG','PRIVATE-BOOTSTRAP','PRIVATE-INSTALL','PRIVATE-INSTRUCTIONS']);assert.equal(f.calls.length,0,'copying a native compatibility guide never starts the legacy connector');
});

test('primary click sends exactly the selected native identity and refreshes actual scoped state',async()=>{
  const f=fixture();f.context.api=async(route,body)=>{f.calls.push({route,body});return body?{native_session_id:'ACTUAL-NATIVE-ID'}:{member:f.member,client:f.client};};
  f.context.refresh=async()=>{f.member.runtime_state.connection_evidence={native_conversation_loaded:true,model_reply_verified:false};};
  await f.$('member-connect-guide').onclick(click('data-native-connect'));
  assert.deepEqual(plain(f.calls[0]),{route:'/api/desktop/connect',body:{member_id:'member/native',room_id:'room:one',provider:'qwen-desktop'}});
  assert.equal(f.calls[1].route,'/api/chat/members/member%2Fnative/setup?room_id=room%3Aone');assert.equal(f.calls.length,2);
  assert.match(f.notices[0],/实际回复将在发消息后单独核对/);assert.match(f.$('member-connect-guide').innerHTML,/待实际任务验证/);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/ACTUAL-NATIVE-ID/);
  assert.equal(f.context.nativeSetupPending,null);
});

test('concurrent native clicks have one in-flight POST and do not retry',async()=>{
  const f=fixture(),gate=deferred();f.context.api=async(route,body)=>{f.calls.push({route,body});return body?gate.promise:{member:f.member,client:f.client};};
  const first=f.context.connectNativeDesktop();await f.context.connectNativeDesktop();assert.equal(f.calls.length,1);assert.match(f.$('member-connect-guide').innerHTML,/data-native-connect disabled/);
  gate.resolve({});await first;assert.equal(f.calls.filter(call=>call.route==='/api/desktop/connect').length,1);assert.equal(f.context.nativeSetupPending,null);
});

test('failed native endpoint retains the exact API reason and actionable step without success proof',async()=>{
  const f=fixture({provider:'doubao'});f.context.api=async(route,body)=>{f.calls.push({route,body});throw Object.assign(Error('桌面对话连接尚未开启。'),{code:'desktop_bridge_unavailable'});};
  await f.context.connectNativeDesktop();const html=f.$('member-connect-guide').innerHTML;
  assert.equal(f.calls.length,1);assert.match(html,/role="alert"/);assert.match(html,/桌面对话连接尚未开启/);assert.match(html,/请先打开 豆包/);assert.match(html,/待连接验证/);assert.match(html,/待实际任务验证/);
  assert.doesNotMatch(html,/本人的实际回复已核对/);assert.equal(f.context.nativeSetupPending,null);
  for(const [code,next] of[['desktop_request_uncertain','沿用原记录'],['desktop_target_ambiguous','多个'],['GROK_NATIVE_SOURCE_VERSION_MISMATCH','版本'],['native_login_required','登录']])assert.ok(f.context.nativeConnectNextStep('grok-bot',{code}).includes(next));
  f.context.nativeSetupFailure=null;f.client.native_state.error='本人接口版本尚未核对。';f.member.runtime_state.connection_evidence.last_error={code:'desktop_adapter_unverified'};f.context.renderSetup();assert.match(f.$('member-connect-guide').innerHTML,/版本或本人接口尚未通过核对/,'persisted evidence retains the actionable failure category when the setup dialog reopens');
});

test('late native results cannot overwrite a newly selected room or member',async()=>{
  for(const change of['room','member']){
    const f=fixture(),gate=deferred();f.context.api=async(route,body)=>{f.calls.push({route,body});return body?gate.promise:{member:f.member,client:f.client,late:true};};
    const first=f.context.connectNativeDesktop(),newData={client:{kind:'native_desktop',provider:'doubao'},newSelection:true};
    if(change==='room')f.context.roomId='new-room';else f.context.selectedSetupMember='new-member';f.context.setupData=newData;
    gate.resolve({});await first;assert.equal(f.context.setupData,newData);assert.equal(f.context.nativeSetupFailure,null);assert.equal(f.notices.length,0);assert.equal(f.context.nativeSetupPending,null);
    assert.equal(f.calls[0].body.room_id,'room:one');assert.ok(f.calls[1].route.endsWith('room_id=room%3Aone'));
  }
});

test('onboarding native action uses its scoped job and stops after a room switch during setup',async()=>{
  const job={id:'job-owned',member_id:'member/native',room_id:'room:one',provider:'qwen-desktop',status:'needs_action',next_actions:[{operation:'native_desktop_connect'}]};
  const f=fixture();assert.match(f.context.onboardingActionMarkup(job),/data-onboarding-operation="native_desktop_connect"/);assert.doesNotMatch(f.context.onboardingActionMarkup(job),/我已完成，检查连接/);
  await f.context.connectOnboardingNative(job);assert.equal(f.calls.filter(call=>call.route==='/api/desktop/connect').length,1);assert.equal(f.onboardingRefreshes,1);
  const stale=fixture(),gate=deferred();stale.context.api=async(route,body)=>{stale.calls.push({route,body});return gate.promise;};
  const pending=stale.context.connectOnboardingNative(job);stale.context.roomId='different-room';gate.resolve({member:stale.member,client:stale.client});
  await assert.rejects(pending,/当前房间已切换/);assert.equal(stale.calls.filter(call=>call.route==='/api/desktop/connect').length,0);
  await assert.rejects(stale.context.connectOnboardingNative(job),/不属于当前房间/);assert.equal(stale.calls.length,1);
});

test('Grok native guide reaches the owned dialogue action while legacy Grok retains its bridge',async()=>{
  const f=fixture({provider:'grok-bot',adapter:'grok-bridge'});await f.context.showMemberSetup(f.member.id);
  assert.equal(f.bridges.length,0);assert.equal(f.$('member-setup-dialog').open,true);assert.match(f.$('member-connect-guide').innerHTML,/data-native-connect/);
  await f.context.connectMember(f.member.id,f.member);assert.ok(f.calls.some(call=>call.route==='/api/desktop/connect'));assert.equal(f.bridges.length,0);assert.equal(f.calls.some(call=>/\/connect$/.test(call.route)&&call.route!=='/api/desktop/connect'),false);
  const legacy=fixture({provider:'grok-bot',adapter:'grok-bridge'});legacy.client.kind='manual_bridge';await legacy.context.showMemberSetup(legacy.member.id);assert.deepEqual(legacy.bridges,[legacy.member.id]);
});

test('joining a member does not connect it to a different room selected during join',async()=>{
  const f=fixture(),gate=deferred();f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};
  const pending=f.context.connectMember(f.member.id);f.context.roomId='new-room';gate.resolve({});await pending;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].route,'/api/chat/rooms/room%3Aone/join');assert.equal(f.calls.some(call=>call.route==='/api/desktop/connect'),false);
});

function inspectorFixture(options={}){
  const f=fixture(options),c=f.context;
  Object.assign(c,{history:{room:{id:c.roomId,title:'本人办公室'},participants:[f.member],messages:[]},projectId:'project',inspectorMemberId:f.member.id,appearanceDraft:null,appearanceDirty:false,appearanceUploadVersion:0,launchSession:null,
    currentSecretary:()=>({member_id:null}),staleMembers:()=>[],detailRows:()=>'',avatar:()=>'',renderAppearance:()=>{},renderScene:()=>{},applyInspector:()=>{},renderSecretary:()=>{},renderConnectionDoctor:()=>{},renderTeam:()=>{},showSettings:()=>{}});
  c.state.projects=[];c.visibleMembers=members=>(members||[]).filter(member=>member.adapter!=='grok-proxy');
  vm.runInContext(section('function renderInspector()', 'function teamValue(')+section("$('inspector-member-connect').onclick=", "$('connection-doctor-run').onclick="),c);
  return f;
}

test('inspector recognizes unattached native people from public provider and opens their existing setup',async()=>{
  for(const provider of['qwen-desktop','doubao','grok-bot']){
    const f=inspectorFixture({provider,adapter:provider==='grok-bot'?'grok-bridge':'mailbox',verifiedAt:null});f.context.renderInspector();
    assert.match(f.$('inspector-selected-member').innerHTML,/独立原生对话/);assert.match(f.$('inspector-selected-member').innerHTML,/待连接验证/);assert.match(f.$('inspector-selected-member').innerHTML,/待实际任务验证/);
    assert.doesNotMatch(f.$('inspector-selected-member').innerHTML,/本人窗口领取|旧协议已验证/);assert.match(f.$('inspector-members').innerHTML,/本人对话连接待核对/);
    assert.equal(f.$('inspector-member-connect').textContent,'连接本人对话');assert.equal(f.$('inspector-member-connect').classList.contains('primary'),true);assert.equal(f.$('inspector-member-connect').disabled,false);
    assert.match(f.$('inspector-connection-note').textContent,/会话加载与实际问题的回答分别验证/);assert.doesNotMatch(f.$('inspector-connection-note').textContent,/本人窗口领取/);
    await f.$('inspector-member-connect').onclick();assert.equal(f.$('member-setup-dialog').open,true);assert.equal(f.bridges.length,0);assert.equal(f.calls.length,1,'viewing setup does not create a native conversation or call a model');assert.ok(f.calls[0].route.includes('/setup?room_id='));
  }
});

test('inspector keeps actual native model evidence separate and preserves manual client guidance',()=>{
  const native=inspectorFixture({evidence:{native_conversation_loaded:true,model_reply_verified:false}});native.context.renderInspector();
  assert.match(native.$('inspector-selected-member').innerHTML,/已加载本人对话/);assert.match(native.$('inspector-selected-member').innerHTML,/待实际任务验证/);assert.match(native.$('inspector-members').innerHTML,/实际回复待验证/);
  native.member.runtime_state.connection_evidence.model_reply_verified=true;native.context.renderInspector();assert.match(native.$('inspector-selected-member').innerHTML,/已核对原问题的真实回答/);
  const manual=inspectorFixture({provider:'claude-desktop',adapter:'mailbox'});manual.client.kind='stdio_json';manual.context.renderInspector();
  assert.match(manual.$('inspector-selected-member').innerHTML,/本人窗口领取消息/);assert.match(manual.$('inspector-connection-note').textContent,/桌面信箱成员需要在本人窗口领取消息/);
  assert.equal(manual.$('inspector-member-connect').textContent,'查看成员连接');assert.equal(manual.$('inspector-member-connect').classList.contains('secondary'),true);assert.equal(manual.$('inspector-member-connect').classList.contains('primary'),false);
});

test('unready secretary tutorial routes to existing member connections without relying on absent avatars',()=>{
  const f=inspectorFixture({verifiedAt:null}),c=f.context,opened=[];
  Object.assign(c,{professionalView:true,secretaryOpenRoom:c.roomId,secretaryPickingRoom:null,secretaryBusy:false,secretaryStartBusy:false,secretaryError:'',secretaryDrafts:new Map,secretaryDismissed:new Set,secretaryGoalVersion:0,secretaryDefaultGoal:'整理目标',secretaryConnectRoom:null,secretaryConnectJob:null,onboardingJobs:new Map,launchScanning:false,launchError:'',
    document:{body:{classList:{contains:()=>false}},activeElement:null},localStorage:{setItem(){}},updateOfficeScene:()=>{},setProfessionalView:()=>{},showRoom:()=>{},currentOnboardingJobs:()=>[],onboardingRunning:()=>false,openInspector:tab=>opened.push(tab),chooseSecretary:()=>assert.fail('pending person cannot be chosen before connection')});
  c.admittedMembers=members=>(members||[]).filter(member=>!!member.verified_at);c.state.secretaries={};
  vm.runInContext(section('function setApprovalMarkup(', 'function renderApprovals(')+section('function currentSecretary(', 'function secretaryResponse(')+section("$('secretary-member-options').onclick =", "$('secretary-selected-person').onclick ="),c);
  c.renderSecretary();const html=f.$('secretary-member-options').innerHTML;
  assert.match(html,/已有成员列表/);assert.match(html,/data-secretary-member-connections/);assert.doesNotMatch(html,/顶部.*头像/);assert.equal(f.calls.length,0);
  f.$('secretary-member-options').onclick(click('data-secretary-member-connections'));assert.deepEqual(opened,['members']);assert.equal(c.secretaryOpenRoom,null);assert.equal(c.secretaryDismissed.has(c.roomId),true);assert.equal(f.calls.length,0);
  c.history.participants=[];c.renderSecretary();assert.match(f.$('secretary-member-options').innerHTML,/办公室还没有成员/);assert.doesNotMatch(f.$('secretary-member-options').innerHTML,/data-secretary-member-connections/);
});
