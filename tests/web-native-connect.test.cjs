'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {present}=require('../src/member-connection.cjs');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function plain(value){return JSON.parse(JSON.stringify(value));}
function fixture({provider='qwen-desktop',adapter='mcp',evidence={},verifiedAt='old-protocol-proof'}={}){
  const elements=new Map,calls=[],notices=[],copied=[],bridges=[],timers=new Map;let refreshes=0,onboardingRefreshes=0,timerId=0;
  const $=id=>{if(!elements.has(id)){const classes=new Set;elements.set(id,{innerHTML:'',textContent:'',value:'',dataset:{},open:false,disabled:false,classList:{toggle(name,value){if(value??!classes.has(name))classes.add(name);else classes.delete(name);},add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)},querySelector:()=>null,querySelectorAll:()=>[],cloneNode(){return{innerHTML:this.innerHTML,querySelector:()=>null,querySelectorAll:()=>[]};},showModal(){this.open=true;},close(){this.open=false;}});}return elements.get(id);};
  const member={id:'member/native',name:'本人同事',adapter,provider,verified_at:verifiedAt,runtime_state:{connection_evidence:evidence}};
  const client={kind:'native_desktop',provider,native_state:{configured:false,can_wake:false},connection_evidence:evidence};
  const context=vm.createContext({$,roomId:'room:one',projectId:'project',legacyId:null,secretaryNavigation:null,secretaryConnectJob:null,secretaryConnectRoom:null,onboardingJobs:new Map(),onboardingFeedback:new Map(),selectedSetupMember:member.id,setupData:{member,client},nativeSetupPending:null,nativeSetupFailure:null,lastSetupSignature:'',webConnected:true,grokSetupWatch:null,grokSetupWatchTimer:null,grokSetupWatchSequence:0,grokSetupWatchError:'',
    setUITimeout:(callback,ms)=>{timers.set(++timerId,{callback,ms});return timerId;},clearUITimeout:id=>timers.delete(id),
    state:{chat:{members:[member]}},toast:value=>notices.push(value),memberStatus:()=>({tone:'online',label:'旧协议已验证'}),memberPresence:()=>({status:'unknown',label:'在线性未知',canWake:false}),time:value=>String(value),
    refresh:async()=>{refreshes++;},refreshOnboarding:async()=>{onboardingRefreshes++;},renderLaunch:()=>{},showBridge:async id=>bridges.push(id),showResume:async()=>{},
    openInspector:()=>{},runConnectionDoctor:async()=>{},clientConfigLabel:()=>'',clientImportKind:()=>'',navigator:{clipboard:{writeText:async value=>copied.push(value)}},action:async callback=>callback(),
    api:async(route,body)=>{calls.push({route,body});return body?{}:{member,client};}
  });
  context.memberById=id=>context.state.chat.members.find(item=>item.id===id);
  vm.runInContext(section('const escape =','const time =')+section('function nativeConnectionUnavailable(', 'function memberPresence(')+section('function onboardingRepairRequired(', 'function onboardingReady(')+section('function nativeDesktopProvider(', 'function launchSelectable(')+
    section('function onboardingView(', 'function onboardingApprovalMarkup(')+section('async function connectMember(', 'function updateRecipientNote(')+
    section("$('member-setup-content').onclick =", "$('member-grok-form').onsubmit")+
    section("$('member-connect-guide').onclick =", "$('member-copy-entry').onclick"),context);
  return{context,$,member,client,calls,notices,copied,bridges,timers,get refreshes(){return refreshes;},get onboardingRefreshes(){return onboardingRefreshes;}};
}
function click(attribute,dataset={}){const button={dataset,hasAttribute:name=>name===attribute};return{target:{closest:()=>button}};}

test('revoked manual setup never displays historical success or asks to copy an unavailable entry',()=>{
  const f=fixture({provider:'claude-desktop'});f.client.kind='reauthorization';f.client.needs_reauthorization=true;f.client.entry_status='revoked';f.client.steps=['请返回原接入记录重新授权。'];f.context.renderSetup();
  assert.match(f.$('member-setup-status').innerHTML,/原连接已撤销/);assert.doesNotMatch(f.$('member-setup-status').innerHTML,/旧协议已验证|验证于/);assert.equal(f.$('member-setup-content').innerHTML,'');assert.equal(f.$('retry-member-connect').classList.contains('hidden'),true);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/data-copy-/);
});

test('protocol verification never claims a loaded native conversation or actual reply',()=>{
  const f=fixture({evidence:{protocol_verified:true}});f.context.renderSetup();
  assert.match(f.$('member-connect-guide').innerHTML,/待连接验证/);assert.match(f.$('member-connect-guide').innerHTML,/待实际任务验证/);
  assert.match(f.$('member-setup-status').innerHTML,/已连上，等待验证/);assert.doesNotMatch(f.$('member-setup-status').innerHTML,/旧协议已验证|old-protocol-proof|验证于/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:true,model_reply_verified:false};f.context.renderSetup();
  assert.match(f.$('member-setup-status').innerHTML,/已连上/);assert.match(f.$('member-connect-guide').innerHTML,/接入时会自动验证回复/);
  assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:true,model_reply_verified:true};f.context.renderSetup();
  assert.match(f.$('member-setup-status').innerHTML,/本人实际回复已核对/);assert.match(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/);
  f.member.runtime_state.connection_evidence={native_conversation_loaded:false,model_reply_verified:false};f.client.connection_evidence={native_conversation_loaded:true,model_reply_verified:true};f.context.renderSetup();
  assert.match(f.$('member-connect-guide').innerHTML,/待连接验证/);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/已核对原问题的真实回答/,'fresh runtime evidence overrides the old guide');
});
test('current disconnected desktop overrides historical native proof in setup and inspector',()=>{
  const proof={native_conversation_loaded:true,model_reply_verified:true,automatic_reply_verified:true};
  const f=fixture({provider:'doubao',evidence:proof});f.member.desktop_connection={configured:true,state:'offline',can_wake:false,error:'fetch failed'};f.member.connection_method='native_desktop';f.client.native_state.error='fetch failed';f.context.renderSetup();
  const html=f.$('member-setup-status').innerHTML+f.$('member-connect-guide').innerHTML;assert.match(html,/还没连上/);assert.match(html,/需要做哪一步/);assert.match(html,/待连接验证/);assert.match(html,/待实际任务验证/);assert.doesNotMatch(html,/已核对原问题的真实回答|本人的实际回复已核对|fetch failed/);
  const inspector=inspectorFixture({provider:'doubao',evidence:proof});inspector.member.desktop_connection=f.member.desktop_connection;inspector.member.connection_method='native_desktop';inspector.context.renderInspector();
  assert.match(inspector.$('inspector-members').innerHTML,/点开查看需要做哪一步/);assert.doesNotMatch(inspector.$('inspector-selected-member').innerHTML,/已核对原问题的真实回答/);
});

test('native primary UI hides private values and preserves explicit compatibility copying without reconnecting',async()=>{
  const f=fixture({verifiedAt:null});const fallback={title:'兼容 MCP',steps:['按需导入客户端'],fields:{room_id:'PRIVATE-ROOM',token:'PRIVATE-TOKEN'},copy:'PRIVATE-CONFIG',bootstrap:'PRIVATE-BOOTSTRAP',installation_prompt:'PRIVATE-INSTALL'};
  f.client.fallback=fallback;f.context.setupData.instructions='PRIVATE-INSTRUCTIONS';f.context.setupData.mcp={token:'PRIVATE-MCP'};f.context.renderSetup();
  const html=f.$('member-connect-guide').innerHTML+f.$('member-setup-content').innerHTML;
  assert.match(html,/data-native-connect/);assert.match(html,/高级：连接诊断与兼容 MCP/);assert.match(html,/data-copy-guide/);assert.doesNotMatch(html,/PRIVATE-|room:one|member\/native/);
  assert.ok(html.indexOf('复制安装 / 更新 MCP 提示词')<html.indexOf('<details'),'installation is directly visible before diagnostics');
  assert.ok(html.indexOf('复制本人窗口握手提示词')<html.indexOf('<details'),'handshake is directly visible before diagnostics');
  assert.match(html,/普通聊天或云端代码解释器不能代装本机 MCP/);
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
  assert.match(f.notices[0],/正在验证它能回复/);assert.match(f.$('member-connect-guide').innerHTML,/待实际任务验证/);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/ACTUAL-NATIVE-ID/);
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
  for(const [code,next] of[['desktop_request_uncertain','重新检查'],['desktop_target_ambiguous','多个'],['GROK_NATIVE_SOURCE_VERSION_MISMATCH','版本'],['native_login_required','登录']])assert.ok(f.context.nativeConnectNextStep('grok-bot',{code}).includes(next));
  f.context.nativeSetupFailure=null;f.client.native_state.error='本人接口版本尚未核对。';f.member.runtime_state.connection_evidence.last_error={code:'desktop_adapter_unverified'};f.context.renderSetup();assert.match(f.$('member-connect-guide').innerHTML,/这个版本的应用暂不支持自动连接/,'persisted evidence retains the actionable failure category when the setup dialog reopens');
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

test('unsupported native source offers visible MCP settings and a separate current-window handshake',()=>{
  for(const provider of['doubao','qwen-desktop']){
    const f=fixture({provider,verifiedAt:null});f.client.native_state={error:'原生接口不兼容',error_code:provider==='doubao'?'DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE':'desktop_version_unsupported'};
    f.client.fallback={kind:'http_json',installation_prompt:'PRIVATE-INSTALL',copy:'PRIVATE-HTTP-CONFIG',copy_label:'复制 MCP 配置',bootstrap:'PRIVATE-HANDSHAKE',steps:['保存并启用此客户端的 MCP。']};
    f.context.renderSetup();const html=f.$('member-connect-guide').innerHTML;
    assert.match(html,/可以按下方步骤改用 MCP 连接/);assert.match(html,/复制安装 \/ 更新 MCP 提示词/);assert.match(html,/复制 MCP 配置/);assert.match(html,/复制本人窗口握手提示词/);assert.match(html,/消息在它自己的窗口里查看/);assert.doesNotMatch(html,/PRIVATE-/);
    assert.ok(html.indexOf('用 MCP 连接')<html.indexOf('<details'));assert.equal(f.calls.length,0);
  }
});

test('native failure titles explain the situation and keep raw source codes in diagnostics',()=>{
  for(const [code,title]of[['DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE','当前客户端版本的本机连接暂不可用'],['ECONNREFUSED','桌面对话连接尚未开启']]){
    const f=fixture({provider:'doubao'});f.client.native_state={error:`原始诊断 ${code}`,error_code:code};f.context.renderSetup();const html=f.$('member-connect-guide').innerHTML;
    assert.ok(html.indexOf(title)<html.indexOf('<details'));assert.ok(html.indexOf(code)>html.indexOf('<details'));
  }
});

test('native setup loads only the saved exact-person progress without starting or retrying setup',async()=>{
  const f=fixture(),job={id:'saved-native',member_id:f.member.id,room_id:'room:one',provider:'qwen-desktop',status:'needs_action',next_actions:[{operation:'open_native_client'},{operation:'manual_mcp',target_member_id:f.member.id}]};
  f.context.history={connection_assists:[{run_id:job.id,target_member_id:f.member.id,room_id:job.room_id,provider:job.provider}]};
  f.context.api=async(route,body)=>{f.calls.push({route,body});return route.startsWith('/api/onboarding/jobs/')?job:{member:f.member,client:f.client};};
  await f.context.showMemberSetup(f.member.id);
  assert.deepEqual(f.calls.map(value=>value.route),['/api/chat/members/member%2Fnative/setup?room_id=room%3Aone','/api/onboarding/jobs/saved-native']);assert.ok(f.calls.every(value=>value.body===undefined));
  assert.match(f.$('member-connect-guide').innerHTML,/data-native-operation="open_native_client"/);assert.equal(f.context.onboardingJobs.get(job.id).member_id,f.member.id);
  for(const property of['member_id','room_id','provider','id']){
    f.context.onboardingJobs.clear();f.context.api=async route=>route.startsWith('/api/onboarding/jobs/')?{...job,[property]:'foreign'}:{member:f.member,client:f.client};await f.context.showMemberSetup(f.member.id);
    assert.equal(f.context.onboardingJobs.size,0);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/data-native-operation="open_native_client"/);
  }
});

test('native connection enable button uses its allowed saved operation and never sends a model request',async()=>{
  const f=fixture(),job={id:'native-open',member_id:f.member.id,room_id:'room:one',provider:'qwen-desktop',status:'needs_action',next_actions:[{operation:'open_native_client'}]};
  f.context.onboardingJobs.set(job.id,job);f.context.returnSecretaryAfterOnboarding=()=>{};
  f.context.api=async(route,body)=>{f.calls.push({route,body});return body?{job,action:{kind:'open_native_client',instruction:'正在核对已有连接'}}:{member:f.member,client:f.client};};
  f.context.renderSetup();assert.match(f.$('member-connect-guide').innerHTML,/开启客户端连接/);
  await f.$('member-connect-guide').onclick(click('data-native-operation',{nativeOperation:'open_native_client',nativeJob:job.id}));
  assert.deepEqual(plain(f.calls.filter(value=>value.body)),[{route:'/api/onboarding/action',body:{run_id:job.id,operation:'open_native_client'}}]);assert.equal(f.calls.some(value=>value.route==='/api/desktop/connect'),false);
  for(const changed of[{member_id:'other'},{room_id:'other'},{provider:'doubao'},{next_actions:[]}]){
    f.context.onboardingJobs.set(job.id,{...job,...changed});await assert.rejects(f.$('member-connect-guide').onclick(click('data-native-operation',{nativeOperation:'open_native_client',nativeJob:job.id})),/连接步骤已变化/);
  }
  assert.equal(f.calls.filter(value=>value.body).length,1);
});

test('manual MCP choice preserves exact identity and is never selected merely by copying instructions',async()=>{
  const f=fixture(),job={id:'manual-choice',member_id:f.member.id,room_id:'room:one',provider:'qwen-desktop',status:'needs_action',next_actions:[{operation:'manual_mcp',target_member_id:f.member.id}]};
  f.context.onboardingJobs.set(job.id,job);f.context.returnSecretaryAfterOnboarding=()=>{};f.client.fallback={installation_prompt:'INSTALL',bootstrap:'HANDSHAKE',copy:'MCP'};
  f.context.api=async(route,body)=>{f.calls.push({route,body});return body?{...job,id:'manual-attempt',connection_method:'manual_mcp'}:{member:f.member,client:f.client};};
  await f.$('member-connect-guide').onclick(click('data-copy-install'));await f.$('member-connect-guide').onclick(click('data-copy-bootstrap'));assert.equal(f.calls.length,0);
  await f.$('member-connect-guide').onclick(click('data-native-operation',{nativeOperation:'manual_mcp',nativeJob:job.id}));
  assert.deepEqual(plain(f.calls.filter(value=>value.body)),[{route:'/api/onboarding/start',body:{room_id:job.room_id,provider:job.provider,target_member_id:job.member_id,connection_method:'manual_mcp'}}]);
});

test('revoked native entry blocks configuration and handshake copying until explicit reauthorization',async()=>{
  const f=fixture();f.client.native_state={error:'原入口已撤销',error_code:'resume_revoked'};f.client.fallback={installation_prompt:'OLD-INSTALL',copy:'OLD-CONFIG',bootstrap:'OLD-HANDSHAKE'};f.context.renderSetup();
  const html=f.$('member-connect-guide').innerHTML;assert.match(html,/重新授权这位成员/);assert.match(html,/data-native-connect disabled/);assert.doesNotMatch(html,/data-copy-install|data-copy-guide|data-copy-bootstrap|OLD-/);assert.equal(f.calls.length,0);
  for(const attribute of['data-copy-install','data-copy-guide','data-copy-bootstrap'])await f.$('member-connect-guide').onclick(click(attribute));assert.equal(f.copied.length,0);
});

test('stale native MCP buttons cannot copy another room, person, provider or newly revoked entry',async()=>{
  for(const change of['room','person','provider','status','entry','reconnect']){
    const f=fixture();f.context.setupData.room={id:'room:one'};f.client.fallback={installation_prompt:'OLD-INSTALL',copy:'OLD-CONFIG',bootstrap:'OLD-HANDSHAKE'};f.context.renderSetup();
    assert.match(f.$('member-connect-guide').innerHTML,/data-copy-install/);
    if(change==='room')f.context.roomId='different-room';else if(change==='person')f.context.selectedSetupMember='another-person';else if(change==='provider')f.client.provider='doubao';else if(change==='status')f.member.status='revoked';else if(change==='entry')f.client.entry_status='revoked';else f.client.native_state.reconnect={error_code:'resume_revoked'};
    for(const attribute of['data-copy-install','data-copy-guide','data-copy-bootstrap'])await f.$('member-connect-guide').onclick(click(attribute));
    assert.equal(f.copied.length,0);assert.equal(f.calls.length,0);
  }
});

test('pending and uncertain native attempts cannot be bypassed by compatibility copy buttons',async()=>{
  for(const state of['running','uncertain','pending','manual_not_allowed']){
    const f=fixture(),job={id:'native-pending',member_id:f.member.id,room_id:'room:one',provider:'qwen-desktop',status:'running',connection_method:'native_desktop',next_actions:[]};
    f.client.fallback={installation_prompt:'PRIVATE-INSTALL',copy:'PRIVATE-CONFIG',bootstrap:'PRIVATE-HANDSHAKE'};
    if(state==='running'||state==='manual_not_allowed')f.context.onboardingJobs.set(job.id,{...job,status:state==='running'?'running':'needs_action'});
    if(state==='uncertain')f.client.native_state={state:'creation_uncertain',error:'原结果待核对',error_code:'desktop_request_uncertain'};
    if(state==='pending')f.context.nativeSetupPending={memberId:f.member.id,roomId:'room:one'};
    f.context.renderSetup();assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/data-copy-install|data-copy-guide|data-copy-bootstrap/);
    for(const attribute of['data-copy-install','data-copy-guide','data-copy-bootstrap'])await f.$('member-connect-guide').onclick(click(attribute));
    assert.equal(f.copied.length,0);assert.equal(f.calls.length,0);
  }
});

test('onboarding native action uses its scoped job and stops after a room switch during setup',async()=>{
  const job={id:'job-owned',member_id:'member/native',room_id:'room:one',provider:'qwen-desktop',status:'needs_action',next_actions:[{operation:'native_desktop_connect'}]};
  const f=fixture();assert.equal(present(job).primary.operation,'native_connect');
  await f.context.connectOnboardingNative(job);assert.equal(f.calls.filter(call=>call.route==='/api/desktop/connect').length,1);assert.equal(f.onboardingRefreshes,1);
  const stale=fixture(),gate=deferred();stale.context.api=async(route,body)=>{stale.calls.push({route,body});return gate.promise;};
  const pending=stale.context.connectOnboardingNative(job);stale.context.roomId='different-room';gate.resolve({member:stale.member,client:stale.client});
  await assert.rejects(pending,/房间已切换/);assert.equal(stale.calls.filter(call=>call.route==='/api/desktop/connect').length,0);
  await assert.rejects(stale.context.connectOnboardingNative(job),/属于另一个房间/);assert.equal(stale.calls.length,1);
});
test('native setup replaces the picker and preserves only its current member completion flow',async()=>{
  const f=fixture(),job={id:'native-run',member_id:f.member.id,room_id:f.context.roomId,provider:'qwen-desktop',status:'needs_action'};
  const flow={source:'picker',roomId:f.context.roomId,projectId:'project',jobId:job.id};f.context.secretaryNavigation=flow;f.context.secretaryConnectJob=job.id;f.context.secretaryConnectRoom=f.context.roomId;f.context.onboardingJobs.set(job.id,job);f.context.secretaryNavigationCurrent=value=>value===f.context.secretaryNavigation&&value.roomId===f.context.roomId;
  const picker=f.$('secretary-connect-dialog'),setup=f.$('member-setup-dialog');picker.open=true;let closePicker,closeSetup;
  picker.addEventListener=(_type,callback)=>{closePicker=callback;};setup.addEventListener=(_type,callback)=>{closeSetup=callback;};
  vm.runInContext(source.split('\n').filter(line=>line.startsWith("$('secretary-connect-dialog').addEventListener('close'")||line.startsWith("$('member-setup-dialog').addEventListener('close'")).join('\n'),f.context);
  picker.close=()=>{picker.open=false;closePicker();};
  await f.context.showMemberSetup(f.member.id);assert.equal(picker.open,false);assert.equal(setup.open,true);assert.equal(f.context.secretaryNavigation,flow);assert.equal(flow.setupMemberId,f.member.id);assert.equal(flow.jobId,job.id);
  closeSetup();assert.equal(f.context.secretaryNavigation,null,'explicitly dismissing the owned setup cancels its pending navigation');
  f.context.secretaryNavigation={source:'picker',roomId:f.context.roomId};closePicker();assert.equal(f.context.secretaryNavigation,null,'normal user closure still cancels the picker');
});
test('ordinary onboarding reauthorization uses its declared exact member instead of a generic retry',async()=>{
  const f=fixture(),job={id:'blocked-run',room_id:'room:one',member_id:f.member.id,provider:'qwen-desktop',status:'needs_action',stage:'awaiting_credential',next_actions:[{operation:'reauthorize',target_member_id:f.member.id}]};f.context.onboardingView=value=>value;f.context.api=async(route,body)=>{f.calls.push({route,body});return{...job,id:'recovery-run',status:'running'};};
  assert.equal(present(job).primary.operation,'reauthorize');assert.equal(present(job).primary.target_member_id,f.member.id);
  const updated=await f.context.reauthorizeOnboarding(job);assert.equal(updated.id,'recovery-run');assert.deepEqual(plain(f.calls),[{route:'/api/onboarding/start',body:{room_id:'room:one',provider:'qwen-desktop',target_member_id:f.member.id,reauthorize:true}}]);
  f.context.roomId='other-room';await assert.rejects(f.context.reauthorizeOnboarding(job),/授权步骤已变化/);assert.equal(f.calls.length,1);
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
  for(const provider of['qwen-desktop','doubao']){
    const f=inspectorFixture({provider,adapter:provider==='grok-bot'?'grok-bridge':'mailbox',verifiedAt:null});f.context.renderInspector();
    assert.match(f.$('inspector-selected-member').innerHTML,/应用里的单独对话/);assert.match(f.$('inspector-selected-member').innerHTML,/待连接验证/);assert.match(f.$('inspector-selected-member').innerHTML,/待实际任务验证/);
    assert.doesNotMatch(f.$('inspector-selected-member').innerHTML,/在它自己的窗口看消息|在自己窗口看消息|旧协议已验证/);assert.match(f.$('inspector-members').innerHTML,/连接待确认/);
    assert.equal(f.$('inspector-member-connect').textContent,'连接');assert.equal(f.$('inspector-member-connect').classList.contains('primary'),true);assert.equal(f.$('inspector-member-connect').disabled,false);
    assert.match(f.$('inspector-connection-note').textContent,/再自动验证它能回复/);assert.doesNotMatch(f.$('inspector-connection-note').textContent,/在自己的窗口里看消息/);
    await f.$('inspector-member-connect').onclick();assert.equal(f.$('member-setup-dialog').open,true);assert.equal(f.bridges.length,0);assert.equal(f.calls.length,1,'viewing setup does not create a native conversation or call a model');assert.ok(f.calls[0].route.includes('/setup?room_id='));
  }
});

test('Grok inspector offers a guided connection without claiming unsupported native control',async()=>{
  const f=inspectorFixture({provider:'grok-bot',adapter:'grok-bridge',verifiedAt:null});f.client.kind='grok_guided';f.client.copy='OWNED-HANDOFF';f.context.renderInspector();
  assert.match(f.$('inspector-selected-member').innerHTML,/Grok 本机入口 · 自动接手另行验证/);assert.doesNotMatch(f.$('inspector-selected-member').innerHTML,/应用里的单独对话/);
  assert.equal(f.$('inspector-member-connect').textContent,'连接 Grok');assert.match(f.$('inspector-connection-note').textContent,/复制一次连接说明/);
  await f.$('inspector-member-connect').onclick();assert.equal(f.$('member-setup-dialog').open,true);assert.match(f.$('member-connect-guide').innerHTML,/data-grok-copy/);assert.equal(f.bridges.length,0);
});

function guidedFixture(){
  const f=fixture({provider:'grok-bot',adapter:'grok-bridge',verifiedAt:null});Object.assign(f.client,{kind:'grok_guided',copy:'OWNED-HANDOFF-WITH-PRIVATE-CREDENTIAL',handshake_verified:false,ready_for_office:false,can_wake:false});
  f.context.history={room:{id:'room:one'},participants:[f.member]};f.context.secretaryNavigation={prior:'unchanged'};f.context.closeSecretaryTutorial=()=>{};f.context.setProfessionalView=()=>{};f.context.selectRoomView=value=>{f.office=value;};f.context.updateRecipientNote=()=>{};return f;
}

test('Grok guided screen exposes one clear handoff and hides configuration and old native failures',async()=>{
  const f=guidedFixture();f.member.error='fetch failed';f.$('member-dialog').open=true;f.$('secretary-connect-dialog').open=true;f.$('bridge-dialog').open=true;
  await f.context.showMemberSetup(f.member.id);
  assert.equal(f.$('member-dialog').open,false);assert.equal(f.$('secretary-connect-dialog').open,false);assert.equal(f.$('bridge-dialog').open,false);assert.equal(f.$('member-setup-dialog').open,true);
  const html=f.$('member-connect-guide').innerHTML;assert.match(html,/data-grok-copy/);assert.match(html,/粘贴到你要连接的 Grok Bot 对话/);assert.match(html,/无需先建群/);assert.match(html,/AO 自动检查连接/);
  assert.doesNotMatch(html,/data-native-connect|19247|OWNED-HANDOFF|兼容 MCP/);assert.ok(html.indexOf('fetch failed')>html.indexOf('<details'));
  assert.equal(f.$('member-setup-content').innerHTML,'');assert.equal(f.$('bridge-webhook-section').classList.contains('hidden'),true);assert.equal(f.calls.length,1);
  await f.$('member-connect-guide').onclick(click('data-grok-copy'));assert.deepEqual(f.copied,['OWNED-HANDOFF-WITH-PRIVATE-CREDENTIAL']);assert.equal(f.context.grokSetupWatch.copied,true);assert.equal(f.calls.length,1,'copying an existing credential does not reissue or retry');
});
test('unchanged Grok polling preserves guide DOM and keeps technical runtime status hidden',async()=>{
  const f=guidedFixture(),guide=f.$('member-connect-guide');let writes=0,html='',observation=0;f.client.connection_evidence={observed_at:'initial',sessions:[]};f.member.runtime_state.connection_evidence={observed_at:'initial',sessions:[]};
  f.context.api=async()=>({member:f.member,client:{...f.client,connection_evidence:{observed_at:String(++observation),sessions:[]}}});f.context.refresh=async()=>{f.member.runtime_state.connection_evidence={observed_at:String(++observation),sessions:[]};f.context.renderSetup();};
  Object.defineProperty(guide,'innerHTML',{get:()=>html,set:value=>{html=value;writes++;}});await f.context.showMemberSetup(f.member.id);const initial=writes;
  for(let i=0;i<3;i++)await f.context.pollGrokSetup();assert.equal(writes,initial,'readonly unchanged polls must preserve focused buttons and manual copy selections');assert.equal(f.$('member-runtime-status').innerHTML,'');
  f.context.api=async()=>{throw Error('fixture status temporarily unavailable');};await f.context.pollGrokSetup();assert.equal(writes,initial+1,'a real changed error still renders');await f.context.pollGrokSetup();assert.equal(writes,initial+1,'the same unchanged error must not replace DOM repeatedly');
});

test('Grok explicit first-copy prepares once, concurrent clicks do not issue additional credentials',async()=>{
  const f=guidedFixture();f.client.copy=null;f.client.needs_prepare=true;await f.context.showMemberSetup(f.member.id);const gate=deferred();
  f.context.api=async(route,body)=>{f.calls.push({route,body});return body?gate.promise:{member:f.member,client:f.client};};
  const first=f.$('member-connect-guide').onclick(click('data-grok-copy'));await f.$('member-connect-guide').onclick(click('data-grok-copy'));assert.equal(f.calls.length,2);assert.equal(f.calls[1].route,'/api/chat/members/member%2Fnative/setup');
  const prepared={...f.client,copy:'FIRST-OWNED',needs_prepare:false};gate.resolve({member:f.member,client:prepared});await first;assert.deepEqual(f.copied,['FIRST-OWNED']);assert.equal(f.context.grokSetupWatch.copying,false);
  await f.$('member-connect-guide').onclick(click('data-grok-copy'));assert.deepEqual(f.copied,['FIRST-OWNED','FIRST-OWNED']);assert.equal(f.calls.filter(call=>call.body).length,1);
});

test('Grok waits for actual handshake and enters office without assigning a secretary or claiming auto wake',async()=>{
  const f=guidedFixture();await f.context.showMemberSetup(f.member.id);await f.$('member-connect-guide').onclick(click('data-grok-copy'));
  await f.context.pollGrokSetup();assert.equal(f.office,undefined);assert.equal(f.$('member-setup-dialog').open,true);assert.equal(f.calls.filter(call=>call.body).length,0);
  f.member.verified_at='REAL-HANDSHAKE';Object.assign(f.client,{handshake_verified:true,ready_for_office:true,handshake_observed_at:'2026-10-15T12:00:01.000Z'});await f.context.pollGrokSetup();
  assert.equal(f.office,true);assert.equal(f.$('member-setup-dialog').open,false);assert.equal(f.context.grokSetupWatch,null);assert.equal(f.context.secretaryNavigation,null);assert.equal(f.calls.filter(call=>call.body).length,0);assert.equal(f.$('recipient').value,f.member.id);assert.match(f.notices.at(-1),/后台自动接手能力会单独核对/);
});

test('Grok readonly polling ignores late room, member and dialog results and preserves credentials',async()=>{
  for(const change of['room','member','dialog']){
    const f=guidedFixture();await f.context.showMemberSetup(f.member.id);const gate=deferred(),original=f.context.setupData;
    f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};const pending=f.context.pollGrokSetup();
    if(change==='room')f.context.roomId='other-room';else if(change==='member')f.context.selectedSetupMember='other-person';else f.$('member-setup-dialog').close();
    gate.resolve({member:f.member,client:{...f.client,copy:'LATE-SECRET',handshake_verified:true,ready_for_office:true}});await pending;
    assert.equal(f.context.setupData,original);assert.equal(f.office,undefined);assert.equal(f.calls.filter(call=>call.body).length,0);assert.equal(f.copied.length,0);
  }
});

test('revoked Grok guidance blocks copying, while clipboard failure exposes selectable owned instructions',async()=>{
  const f=guidedFixture();Object.assign(f.client,{copy:null,entry_status:'revoked',needs_reauthorization:true});await f.context.showMemberSetup(f.member.id);
  assert.match(f.$('member-connect-guide').innerHTML,/data-grok-copy disabled/);assert.match(f.$('member-connect-guide').innerHTML,/这个连接已被撤销/);await f.$('member-connect-guide').onclick(click('data-grok-copy'));assert.equal(f.calls.length,1);assert.equal(f.copied.length,0);
  Object.assign(f.client,{copy:'<OWNED>SECRET',entry_status:'pending',needs_reauthorization:false});f.context.navigator.clipboard.writeText=async()=>{throw Error('clipboard unavailable');};
  await f.$('member-connect-guide').onclick(click('data-grok-copy'));assert.match(f.$('member-connect-guide').innerHTML,/textarea class="grok-handoff-copy" data-grok-copy-fallback readonly/);assert.match(f.$('member-connect-guide').innerHTML,/&lt;OWNED&gt;SECRET/);assert.equal(f.context.grokSetupWatch.copied,false);assert.equal(f.office,undefined);
  f.member.verified_at='REAL-AFTER-MANUAL-COPY';Object.assign(f.client,{handshake_verified:true,ready_for_office:true,handshake_observed_at:'2026-10-15T12:00:01.000Z'});await f.context.pollGrokSetup();assert.equal(f.office,true,'a real pending-to-verified transition enters office even after manual copying');
});

test('historic active offline Grok never auto-enters after copy or readonly polling until authenticated contact advances',async()=>{
  const f=guidedFixture();f.member.verified_at='HISTORICAL-PROOF';f.member.status='offline';Object.assign(f.client,{handshake_verified:true,ready_for_office:true,handshake_observed_at:'2026-10-14T00:00:00.000Z'});
  await f.context.showMemberSetup(f.member.id);assert.match(f.$('member-setup-status').innerHTML,/以前已验证，本次连接待核对/);assert.match(f.$('member-connect-guide').innerHTML,/data-grok-enter-history/);assert.doesNotMatch(f.$('member-connect-guide').innerHTML,/data-grok-enter>/);
  await f.$('member-connect-guide').onclick(click('data-grok-copy'));for(let i=0;i<3;i++)await f.context.pollGrokSetup();
  assert.equal(f.office,undefined);assert.equal(f.$('member-setup-dialog').open,true);assert.equal(f.calls.filter(call=>call.body).length,0);assert.equal(f.context.enterGrokOffice(f.context.grokSetupWatch),false);assert.doesNotMatch(f.notices.join('\n'),/本次真实连接已核对|已进入办公室/);
  f.client.handshake_observed_at='2026-10-14T00:00:00.000Z';assert.equal(f.context.grokSetupFresh(f.context.setupData),false);
  f.client.handshake_observed_at='2026-10-15T12:00:01.000Z';await f.context.pollGrokSetup();assert.equal(f.office,true);assert.match(f.notices.at(-1),/本次真实连接已核对/);
});

test('explicit entry to a historically verified office keeps current connection uncertainty visible',async()=>{
  const f=guidedFixture();f.member.verified_at='HISTORICAL-PROOF';Object.assign(f.client,{handshake_verified:true,ready_for_office:true,handshake_observed_at:'2026-10-14T00:00:00.000Z'});await f.context.showMemberSetup(f.member.id);
  await f.$('member-connect-guide').onclick(click('data-grok-enter-history'));assert.equal(f.office,true);assert.match(f.notices.at(-1),/本次连接仍待核对/);assert.doesNotMatch(f.notices.at(-1),/真实连接已核对/);assert.equal(f.calls.filter(call=>call.body).length,0);
});

test('inspector keeps actual native model evidence separate and preserves manual client guidance',()=>{
  const native=inspectorFixture({evidence:{native_conversation_loaded:true,model_reply_verified:false}});native.context.renderInspector();
  assert.match(native.$('inspector-selected-member').innerHTML,/应用里的对话已连上/);assert.match(native.$('inspector-selected-member').innerHTML,/待实际任务验证/);assert.match(native.$('inspector-members').innerHTML,/等待验证回复/);
  native.member.runtime_state.connection_evidence.model_reply_verified=true;native.context.renderInspector();assert.match(native.$('inspector-selected-member').innerHTML,/已核对原问题的真实回答/);
  const manual=inspectorFixture({provider:'claude-desktop',adapter:'mailbox'});manual.client.kind='stdio_json';manual.context.renderInspector();
  assert.match(manual.$('inspector-selected-member').innerHTML,/在它自己的窗口看消息/);assert.match(manual.$('inspector-connection-note').textContent,/这位成员在自己的窗口里看消息/);
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
