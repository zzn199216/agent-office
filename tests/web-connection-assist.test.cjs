'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const message={id:'human-task',room_id:'room',sender_id:'user',to_member_id:'assistant',kind:'message',text:'把豆包拉进来'},members=[{id:'assistant',name:'负责接入的秘书',adapter:'codex'},{id:'target',name:'豆包',adapter:'doubao-desktop'}];
  const calls={copy:[],toast:[],api:[],refresh:0,avatars:[],blobs:[],revoked:[],anchors:[]};
  const context=vm.createContext({roomId:'room',history:{messages:[message],participants:members,connection_assists:[]},memberById:id=>members.find(member=>member.id===id),
    avatar:(...args)=>{calls.avatars.push(args);return '<span class="fixture-avatar"></span>';},time:value=>String(value||''),
    navigator:{clipboard:{writeText:async text=>calls.copy.push(text)}},toast:text=>calls.toast.push(text),refresh:async()=>{calls.refresh++;},
    api:async(...args)=>{calls.api.push(args);return {text:'# Scoped connection instructions',filename:'agent-office-connect.md'};},
    Blob:class{constructor(parts,options){calls.blobs.push({parts,options});}},URL:{createObjectURL:()=> 'blob:fixture-document',revokeObjectURL:url=>calls.revoked.push(url)},
    document:{body:{append:link=>{link.appended=true;}},createElement:tag=>{assert.equal(tag,'a');const link={click(){this.clicked=true;},remove(){this.removed=true;}};calls.anchors.push(link);return link;}}
  });
  vm.runInContext(section('const escape =','const time =')+section('function renderConnectionAssists(', 'function renderTyping('),context);
  const assist=values=>({id:'assist',message_id:message.id,room_id:'room',member_id:'assistant',target_member_id:'target',provider:'doubao-desktop',name:'豆包',status:'needs_action',ready_for_office:values?.status==='ready',action_kind:values?.status==='ready'?'ready':values?.status==='running'?'wait':'manual_handoff',can_wake:false,summary:'需要本人窗口完成一步',copy_sentence:'请读取这台电脑上的接入文档 C:\\AO\\connect.md，按说明完成连接。',document_path:'C:\\AO\\connect.md',...values});
  return {context,message,members,calls,assist,render:()=>context.renderConnectionAssists(message),action:dataset=>context.connectionAssistAction({dataset})};
}
test('connection cards distinguish verified automatic delivery, manual inbox and an unfinished connection',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist({status:'ready',can_wake:true})];let html=f.render();assert.match(html,/已自动接通/);assert.match(html,/可以直接在 AO 给它发消息/);assert.doesNotMatch(html,/data-assist-copy|本人窗口信箱/);
  f.context.history.connection_assists=[f.assist({status:'ready',can_wake:false})];html=f.render();assert.match(html,/本人入口已接通/);assert.match(html,/消息会保留，由它在本人窗口处理/);assert.doesNotMatch(html,/已自动接通|data-assist-copy/);
  f.context.history.connection_assists=[f.assist({status:'ready',can_wake:'true'})];assert.doesNotMatch(f.render(),/已自动接通/);
  f.context.history.connection_assists=[f.assist({status:'running',copy_sentence:null})];html=f.render();assert.match(html,/正在连接/);assert.doesNotMatch(html,/已自动接通|本人入口已接通|data-assist-copy/);
});
test('manual fallback escapes every display field and attributes the dialogue to the actual recipient agent',()=>{
  const f=fixture();f.members[0].name='秘书 <script>';const name='豆包 <img src=x>',sentence='读取 "C:\\个人资料\\A&B<connect>.md" 后继续',documentPath='C:\\个人资料\\A&B<connect>.md';
  f.context.history.connection_assists=[f.assist({id:'assist/"one',name,summary:'需要 <approval>',error:'failed <unsafe>',copy_sentence:sentence,document_path:documentPath})];const html=f.render();
  assert.match(html,/秘书 &lt;script&gt;/);assert.match(html,/豆包 &lt;img src=x&gt;/);assert.match(html,/需要 &lt;approval&gt;/);assert.match(html,/failed &lt;unsafe&gt;/);assert.match(html,/A&amp;B&lt;connect&gt;\.md/);assert.match(html,/&quot;C:/);assert.match(html,/data-assist-copy="assist\/&quot;one"/);assert.doesNotMatch(html,/<script>|<img src=x>|<approval>|<unsafe>|<connect>/);
  assert.equal(f.calls.avatars[0][0],'秘书 <script>');assert.equal(f.calls.avatars[0][1],'codex');assert.equal(f.calls.avatars[0][3],'assistant');
  assert.equal((html.match(/data-assist-copy=/g)||[]).length,1);assert.equal((html.match(/data-assist-document=/g)||[]).length,1);assert.equal((html.match(/data-assist-check=/g)||[]).length,1);
});
test('historical ready assist metadata cannot announce connection before current attempt acceptance',()=>{
  const f=fixture();for(const value of [false,undefined]){f.context.history.connection_assists=[f.assist({status:'ready',can_wake:true,ready_for_office:value})];assert.doesNotMatch(f.render(),/已自动接通|本人入口已接通|已加入办公室，沿用已有连接/);}
});
test('connection repair overrides old ready, managed, handoff and reauthorization cards with one protected progress action',()=>{
  for(const action_kind of ['ready','managed','manual_handoff','reauthorize','connection_repair']){
    const f=fixture(),item=f.assist({provider:'codex',status:'ready',stage:'connection_repair_required',action_kind,ready_for_office:true,can_wake:true,reused_connection:true,run_id:'protected-run',recovery_action:{operation:'retry'},summary:'OLD SUCCESS',next_step:'OPEN LOGIN AGAIN',error:'OLD LOGIN ERROR'});f.context.history.connection_assists=[item];
    const html=f.render();assert.match(html,/连接已暂停 · 保护桌面登录/);assert.match(html,/原人物、聊天和 MCP 配置都保留/);assert.match(html,/data-assist-open="assist">查看保护进度/);
    assert.doesNotMatch(html,/data-assist-(?:copy|document|check|continue|reauthorize)|已自动接通|本人入口已接通|已加入办公室|由 AO 自动接入|OLD SUCCESS|OPEN LOGIN AGAIN|OLD LOGIN ERROR|C:\\AO|请读取/);
    assert.equal((html.match(/<button /g)||[]).length,1);
  }
  for(const extra of [{action_kind:'connection_repair'},{error_code:'codex_auth_ownership_required'},{error_code:'codex_personal_auth_owner_conflict'}]){
    const f=fixture();f.context.history.connection_assists=[f.assist({status:'ready',stage:'awaiting_auth',can_wake:true,action_kind:'ready',...extra})];assert.match(f.render(),/连接已暂停 · 保护桌面登录/);assert.doesNotMatch(f.render(),/已自动接通/);
  }
});
test('stale repair-card controls cannot copy, refresh, reauthorize, retry or download any data',async()=>{
  for(const action_kind of ['ready','managed','reauthorize','manual_handoff','connection_repair']){
    const f=fixture(),item=f.assist({provider:'codex',stage:'connection_repair_required',action_kind,run_id:'protected-run',status:'ready',ready_for_office:true,can_wake:true,recovery_action:{operation:'reauthorize',provider:'codex',room_id:'room',target_member_id:'target'}});f.context.history.connection_assists=[item];
    for(const field of ['assistCopy','assistDocument','assistCheck','assistContinue','assistReauthorize']){
      await f.action({[field]:item.id});await f.action({[field]:item.id,assistOpen:item.id});
    }
    assert.deepEqual(f.calls.api,[]);assert.deepEqual(f.calls.copy,[]);assert.equal(f.calls.refresh,0);assert.deepEqual(f.calls.anchors,[]);
  }
});
test('real Grok metadata offers the selected person guide and keeps errors and local paths inside closed diagnostics',async()=>{
  const f=fixture(),opened=[];Object.assign(f.members[1],{name:'指定的 Grok Bot',adapter:'grok-bridge',provider:'grok-bot'});f.context.showMemberSetup=async id=>opened.push(id);
  const item=f.assist({provider:'grok-bot',name:'Grok Bot',target_member_id:'target',target_window:'已有 Grok Bot 对话',next_step:'把说明发给这位 Bot，确认一次电脑授权。',error:'needs_external_entry desktop_session_missing',document_path:'C:\\AO\\private-path.md'});f.context.history.connection_assists=[item];
  const html=f.render(),main=html.slice(0,html.indexOf('<details'));
  assert.match(main,/还差一步，让 Grok 确认连接/);assert.match(main,/已有 Grok Bot 对话/);assert.match(main,/在 Grok 中确认它提示的电脑授权/);assert.match(main,/data-assist-open="assist">查看连接步骤/);assert.doesNotMatch(main,/needs_external_entry|desktop_session_missing|private-path|接入文档 C:/);
  assert.match(html,/<details class="connection-assist-diagnostics"><summary>查看诊断/);assert.match(html,/needs_external_entry desktop_session_missing/);assert.doesNotMatch(html,/<details[^>]*\sopen(?:\s|>)/);
  await f.action({assistOpen:item.id,target_member_id:'assistant'});assert.deepEqual(opened,['target']);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,0);
});
test('guide actions validate live target membership and Grok identity instead of model prose or button overrides',async()=>{
  const f=fixture(),opened=[];f.context.showMemberSetup=async id=>opened.push(id);const item=f.assist({provider:'grok-bot',target_member_id:'target'});f.context.history.connection_assists=[item];
  await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);assert.doesNotMatch(f.render(),/data-assist-copy="assist"/,'a Doubao target cannot receive a Grok handoff');
  Object.assign(f.members[1],{adapter:'grok-bridge'});f.context.history.participants=[f.members[0]];await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.context.history.participants=f.members;f.context.roomId='other-room';await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.context.roomId='room';f.message.sender_id='assistant';await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.message.sender_id='user';f.context.history.connection_assists=[];f.message.text='Grok 已成功连接，needs_external_entry desktop_session_missing';assert.equal(f.render(),'');assert.equal(f.calls.api.length,0);
});
test('other providers reuse their actual existing member setup without changing native connection behavior',async()=>{
  const f=fixture(),opened=[];f.context.showMemberSetup=async id=>opened.push(id);const item=f.assist({target_member_id:'target'});f.context.history.connection_assists=[item];
  assert.match(f.render(),/data-assist-open="assist">查看连接步骤/);await f.action({assistOpen:item.id});assert.deepEqual(opened,['target']);assert.deepEqual(f.calls.api,[]);
});
test('all managed CLI providers reject stale generic window handoffs in rendering and click handlers',async()=>{
  for(const provider of ['codex','claude-code','qwen-code','gemini-cli','native'])for(const kind of ['managed','manual_handoff']){
    const f=fixture(),item=f.assist({provider,action_kind:kind,connection_method:'managed_native'});f.context.history.connection_assists=[item];
    const html=f.render();assert.doesNotMatch(html,/data-assist-copy|data-assist-document|接入说明发给/);await f.action({assistCopy:item.id});await f.action({assistDocument:item.id});assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.api,[]);
  }
});
test('reauthorization, unavailable clients, native adapters and unknown legacy cards never offer generic copy',async()=>{
  for(const action_kind of ['reauthorize','unsupported','native_connect','unknown']){
    const f=fixture(),item=f.assist({action_kind,stage:action_kind==='reauthorize'?'awaiting_credential':'unsupported'});f.context.history.connection_assists=[item];assert.doesNotMatch(f.render(),/data-assist-copy|data-assist-document/);
    await f.action({assistCopy:item.id});await f.action({assistDocument:item.id});assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.api,[]);
  }
  const f=fixture(),item=f.assist({action_kind:'manual_handoff',stage:'awaiting_credential'});f.context.history.connection_assists=[item];await f.action({assistCopy:item.id});assert.doesNotMatch(f.render(),/data-assist-copy/);assert.deepEqual(f.calls.copy,[]);
});
test('reused connections describe preserved configuration without claiming a new verification',()=>{
  for(const can_wake of [true,false]){const f=fixture();f.context.history.connection_assists=[f.assist({action_kind:'ready',status:'ready',can_wake,reused_connection:true,verification_scope:'existing_connection',summary:'原配置保留'})];const html=f.render();assert.match(html,/已加入办公室，沿用已有连接/);assert.match(html,/无需重新配置/);assert.doesNotMatch(html.slice(0,html.indexOf('<details')),/重新验证|实际接收/);assert.doesNotMatch(html,/已自动接通|data-assist-copy|本次真实连接/);}
});
function recoveryFixture(){
  const f=fixture();Object.assign(f.members[1],{provider:'codex',adapter:'codex'});Object.assign(f.context,{onboardingJobs:new Map(),onboardingView:value=>value.job||value,beginSecretaryNavigation:()=>({}),returnSecretaryAfterOnboarding(){},refreshOnboarding:async()=>{},action:callback=>callback()});vm.runInContext(section('function onboardingRunning(', 'function onboardingOfficeReady('),f.context);return f;
}
function recheckCard(f,overrides={}){return f.assist({provider:'codex',action_kind:'connection_recheck',stage:'connection_recheck_available',auth_mode:'shared-cache',recheck_auth_revision:'native-shared-cache-v1',run_id:'legacy-run',recovery_action:{operation:'retry',run_id:'legacy-run',room_id:'room',provider:'codex',target_member_id:'target'},...overrides});}
test('cached-login assistant recheck is explicit, preserves the person and never renders old success or extra login',async()=>{
  const f=recoveryFixture(),item=recheckCard(f,{status:'ready',ready_for_office:true,can_wake:true,reused_connection:true,next_step:'OLD SUCCESS',summary:'OLD SUCCESS'});f.context.history.connection_assists=[item];
  const html=f.render();assert.match(html,/已有登录可复用 · 等待重新验证/);assert.match(html,/data-assist-continue="assist">沿用已有登录，重新验证/);assert.match(html,/原人物、聊天和 MCP 配置都保留/);assert.doesNotMatch(html,/已自动接通|本人入口已接通|已加入办公室|OLD SUCCESS|data-assist-(?:copy|document|check|reauthorize)/);assert.deepEqual(f.calls.api,[]);
  f.context.api=async(...args)=>{f.calls.api.push(args);return args.length===1?{id:item.run_id,room_id:'room',provider:'codex',member_id:'target',status:'ready',ready_for_office:true,can_wake:true,stage:item.stage,auth_mode:item.auth_mode,recheck_auth_revision:item.recheck_auth_revision}:{id:'fresh-run',room_id:'room',provider:'codex',member_id:'target',status:'running'};};
  await f.action({assistContinue:item.id});assert.deepEqual(plain(f.calls.api),[['/api/onboarding/jobs/legacy-run'],['/api/onboarding/jobs/legacy-run/retry',{}]]);assert.equal(f.context.onboardingJobs.get('fresh-run').member_id,'target');assert.deepEqual(f.calls.copy,[]);
});
test('cached-login assistant controls require positive cache evidence and fresh exact-job confirmation',async()=>{
  for(const invalid of [{auth_mode:null},{recheck_auth_revision:null},{error_code:'codex_auth_ownership_required'},{recovery_action:{operation:'retry',run_id:'other',room_id:'room',provider:'codex',target_member_id:'target'}}]){
    const f=recoveryFixture(),item=recheckCard(f,invalid);f.context.history.connection_assists=[item];assert.doesNotMatch(f.render(),/data-assist-continue/);await f.action({assistContinue:item.id});assert.deepEqual(f.calls.api,[]);
  }
  for(const live of [{stage:'connection_repair_required',error_code:'codex_auth_ownership_required'},{stage:'connection_recheck_available',auth_mode:null},{stage:'ready_automatic',status:'ready'},{member_id:'other'}]){
    const f=recoveryFixture(),item=recheckCard(f);f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return{id:item.run_id,room_id:'room',provider:'codex',member_id:'target',status:'needs_action',stage:item.stage,auth_mode:item.auth_mode,recheck_auth_revision:item.recheck_auth_revision,...live};};
    await f.action({assistContinue:item.id});assert.deepEqual(plain(f.calls.api),[['/api/onboarding/jobs/legacy-run']]);assert.equal(f.context.onboardingJobs.size,0);
  }
  const stale=recoveryFixture(),item=stale.assist({provider:'codex',action_kind:'managed',run_id:'old-managed',recovery_action:{operation:'retry'}});stale.context.history.connection_assists=[item];stale.context.api=async(...args)=>{stale.calls.api.push(args);return{id:item.run_id,room_id:'room',provider:'codex',member_id:'target',status:'needs_action',stage:'connection_recheck_available',auth_mode:'shared-cache',recheck_auth_revision:'native-shared-cache-v1'};};await stale.action({assistContinue:item.id});assert.equal(stale.calls.api.length,1);
});
test('explicit reauthorization submits only the exact canonical original target to the common controller',async()=>{
  const f=recoveryFixture(),item=f.assist({provider:'codex',action_kind:'reauthorize',stage:'awaiting_credential',recovery_action:{operation:'reauthorize',room_id:'room',provider:'codex',target_member_id:'target'}});f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return {id:'owned-run',room_id:'room',provider:'codex',member_id:'target',status:'running'};};
  assert.match(f.render(),/data-assist-reauthorize="assist">重新授权这位成员/);assert.doesNotMatch(f.render(),/data-assist-copy/);await f.action({assistReauthorize:item.id,target_member_id:'assistant',provider:'grok-bot'});
  assert.deepEqual(plain(f.calls.api),[['/api/onboarding/start',{room_id:'room',provider:'codex',target_member_id:'target',reauthorize:true}]]);assert.equal(f.context.onboardingJobs.get('owned-run').member_id,'target');assert.deepEqual(f.calls.copy,[]);
  item.recovery_action.target_member_id='assistant';await f.action({assistReauthorize:item.id});assert.equal(f.calls.api.length,1,'a mismatched recovery target cannot be authorized');
});
test('a revoked original person outside this room is reachable only by the canonical exact reauthorization action',()=>{
  const f=fixture();f.context.history.participants=[f.members[0]];const item=f.assist({provider:'doubao-desktop',action_kind:'reauthorize',recovery_action:{operation:'reauthorize',room_id:'room',provider:'doubao-desktop',target_member_id:'target'}});f.context.history.connection_assists=[item];assert.match(f.render(),/data-assist-reauthorize/);assert.doesNotMatch(f.render(),/data-assist-copy/);item.recovery_action.room_id='foreign-room';assert.doesNotMatch(f.render(),/data-assist-reauthorize/);
});
test('managed recovery uses the same scoped onboarding run and refuses foreign jobs or an already-running job',async()=>{
  for(const returned of [{member_id:'other'},{room_id:'other'},{provider:'grok-bot'},{status:'running'}]){
    const f=recoveryFixture(),item=f.assist({provider:'codex',action_kind:'managed',run_id:'owned-run',recovery_action:{operation:'retry'}});f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return{id:'owned-run',room_id:'room',provider:'codex',member_id:'target',status:'needs_action',...returned};};
    await f.action({assistContinue:item.id});assert.equal(f.calls.api.length,1);assert.equal(f.calls.api[0][0],'/api/onboarding/jobs/owned-run');assert.deepEqual(f.calls.copy,[]);
  }
  const f=recoveryFixture(),item=f.assist({provider:'codex',action_kind:'managed',run_id:'owned-run',recovery_action:{operation:'retry'}});f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return{id:'owned-run',room_id:'room',provider:'codex',member_id:'target',status:args.length===1?'needs_action':'running'};};
  assert.match(f.render(),/data-assist-continue/);await f.action({assistContinue:item.id});assert.deepEqual(plain(f.calls.api),[['/api/onboarding/jobs/owned-run'],['/api/onboarding/jobs/owned-run/retry',{}]]);assert.equal(f.context.onboardingJobs.get('owned-run').member_id,'target');
});
test('a managed card cannot retry when its read-only job observation reveals connection ownership protection',async()=>{
  const f=recoveryFixture(),item=f.assist({provider:'codex',action_kind:'managed',run_id:'protected-run',recovery_action:{operation:'retry'}});f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return{id:item.run_id,room_id:'room',provider:'codex',member_id:'target',status:'needs_action',stage:'connection_repair_required',error_code:'codex_auth_ownership_required'};};
  await f.action({assistContinue:item.id});assert.deepEqual(plain(f.calls.api),[['/api/onboarding/jobs/protected-run']]);assert.equal(f.calls.refresh,1);assert.equal(f.context.onboardingJobs.size,0);
});
test('notification receipt wording distinguishes actual delivery from model execution and manual-only connections',()=>{
  const f=fixture();Object.assign(f.context,{state:{chat:{activeMessages:[]}},webConnected:true,roomApprovals:()=>[]});Object.assign(f.members[1],{provider:'grok-bot',adapter:'grok-bridge',can_notify:true,manual_wake:true});
  vm.runInContext(section('function renderTyping(', '// One-line previews'),f.context);const message={id:'queued',to_member_id:'target',status:'queued',notification:{status:'accepted'}};
  let html=f.context.renderTyping([message]);assert.match(html,/已通知，等待 Grok 处理/);assert.doesNotMatch(html,/不会自己接手|正在思考|请到它的窗口/);
  for(const [status,expected]of [['sending','正在通知 Grok'],['uncertain','通知结果待核对'],[null,'等待通知 Grok']]){message.notification=status?{status}:null;html=f.context.renderTyping([message]);assert.ok(html.includes(expected));assert.doesNotMatch(html,/不会自己接手/);}
  f.members[1].can_notify=false;html=f.context.renderTyping([message]);assert.match(html,/不会自己接手/);
});
test('only records belonging to the same human source, current room and actual recipient render',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist({id:'included'}),f.assist({id:'wrong-message',message_id:'other-message'}),f.assist({id:'wrong-room',room_id:'elsewhere'}),f.assist({id:'wrong-recipient',member_id:'target'})];
  let html=f.render();assert.match(html,/data-connection-assist="included"/);assert.doesNotMatch(html,/data-connection-assist="wrong-/);
  for(const change of [{room_id:'elsewhere'},{sender_id:'assistant'},{kind:'reply'},{coordination:{title:'安排'}}]){
    const original={...f.message};Object.assign(f.message,change);assert.equal(f.render(),'');Object.keys(f.message).forEach(key=>delete f.message[key]);Object.assign(f.message,original);
  }
});
test('copy resolves the current scoped card sentence, never a caller-supplied sentence or another room',async()=>{
  const f=fixture(),item=f.assist();f.context.history.connection_assists=[item];await f.action({assistCopy:item.id,copy_sentence:'untrusted override',documentUrl:'https://example.invalid'});
  assert.deepEqual(f.calls.copy,[item.copy_sentence]);assert.equal(f.calls.refresh,0);assert.equal(f.calls.api.length,0);
  item.copy_sentence='current instructions after refresh';await f.action({assistCopy:item.id});assert.equal(f.calls.copy[1],item.copy_sentence);
  f.context.history.connection_assists=[{...item,room_id:'other-room'}];await f.action({assistCopy:item.id});await f.action({assistCopy:'stale-card'});assert.equal(f.calls.copy.length,2);
});
test('stale source, foreign recipient and non-human records cannot trigger any connection card action',async()=>{
  const f=fixture(),item=f.assist();
  for(const change of [{message_id:'missing-source'},{member_id:'target'},{room_id:'elsewhere'}]){
    f.context.history.connection_assists=[{...item,...change}];for(const field of ['assistCopy','assistCheck','assistDocument','assistOpen'])await f.action({[field]:item.id});
  }
  f.context.history.connection_assists=[item];f.message.sender_id='assistant';for(const field of ['assistCopy','assistCheck','assistDocument','assistOpen'])await f.action({[field]:item.id});
  assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.api,[]);assert.equal(f.calls.refresh,0);assert.deepEqual(f.calls.anchors,[]);
});
test('checking a connection refreshes observations once without invoking a start, grant or retry route',async()=>{
  const f=fixture(),item=f.assist();f.context.history.connection_assists=[item];await f.action({assistCheck:item.id});
  assert.equal(f.calls.refresh,1);assert.deepEqual(f.calls.api,[]);assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.anchors,[]);assert.match(f.calls.toast[0],/没有重新发起接入/);
});
test('document download uses only the scoped fixed route, ignoring arbitrary URL and path metadata',async()=>{
  const f=fixture(),item=f.assist({id:'assist/one?"',document_url:'https://external.invalid/private',document_path:'C:\\outside\\arbitrary.md'});f.context.roomId='room /"';f.message.room_id=f.context.roomId;item.room_id=f.context.roomId;f.context.history.connection_assists=[item];
  await f.action({assistDocument:item.id,documentUrl:'file:///C:/outside/another.md'});
  assert.deepEqual(plain(f.calls.api),[[`/api/connection-assists/${encodeURIComponent(item.id)}/document?room_id=${encodeURIComponent(f.context.roomId)}`]]);
  assert.deepEqual(plain(f.calls.blobs),[{parts:['# Scoped connection instructions'],options:{type:'text/markdown;charset=utf-8'}}]);assert.equal(f.calls.anchors.length,1);const anchor=f.calls.anchors[0];assert.equal(anchor.href,'blob:fixture-document');assert.equal(anchor.download,'agent-office-connect.md');assert.equal(anchor.appended,true);assert.equal(anchor.clicked,true);assert.equal(anchor.removed,true);assert.deepEqual(f.calls.revoked,['blob:fixture-document']);assert.equal(f.calls.refresh,0);
});
test('a failed document read does not create or click a download link or silently retry',async()=>{
  const f=fixture(),item=f.assist();f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);throw Error('document scope expired');};
  await assert.rejects(f.action({assistDocument:item.id}),/document scope expired/);assert.equal(f.calls.api.length,1);assert.deepEqual(f.calls.blobs,[]);assert.deepEqual(f.calls.anchors,[]);assert.deepEqual(f.calls.copy,[]);assert.equal(f.calls.refresh,0);
});

test('interrupted and failed cards without documents expose an explicit continuation view instead of endless preparation',()=>{
  const f=fixture();
  for(const [status,title]of [['interrupted','接入已中断'],['error','接入未完成'],['failed','接入未完成']]){
    f.context.history.connection_assists=[f.assist({status,action_kind:'wait',target_member_id:null,copy_sentence:'',document_path:null,summary:'原进度已保留，等待明确继续。',error:'原连接已结束'})];const html=f.render();
    assert.ok(html.includes(title));assert.match(html,/原进度保留，请查看所需步骤后明确继续；没有自动重连/);assert.match(html,/data-assist-open="assist">查看接入步骤/);assert.match(html,/data-assist-check="assist">检查连接/);
    assert.doesNotMatch(html,/正在连接|有需要你完成的步骤时|data-assist-copy=|data-assist-document=|已自动接通/);
  }
});
test('opening interrupted setup reads its exact existing job and renders progress without starting or retrying setup',async()=>{
  const f=fixture(),item=f.assist({status:'interrupted',action_kind:'wait',target_member_id:null,run_id:'existing/run?one',copy_sentence:'',document_path:null}),job={id:'existing/run?one',room_id:'room',provider:'doubao',status:'interrupted'},views=[],scrolls=[];let rendered=0;
  f.context.history.connection_assists=[item];f.context.onboardingJobs=new Map();f.context.onboardingView=value=>value.job||value;f.context.setProfessionalView=value=>views.push(value);f.context.renderLaunch=()=>{rendered++;};
  f.context.checkOnboarding=()=>{throw Error('Opening progress must never retry an interrupted managed job');};f.context.$=id=>{assert.equal(id,'onboarding-progress');return {scrollIntoView:value=>scrolls.push(value)};};f.context.api=async(...args)=>{f.calls.api.push(args);return {job};};
  await f.action({assistOpen:item.id});
  assert.deepEqual(plain(f.calls.api),[[`/api/onboarding/jobs/${encodeURIComponent(item.run_id)}`]]);assert.equal(f.context.onboardingJobs.get(job.id),job);assert.deepEqual(views,[false]);assert.equal(rendered,1);assert.deepEqual(plain(scrolls),[{block:'nearest',behavior:'smooth'}]);assert.equal(f.calls.refresh,0);assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.anchors,[]);
  item.run_id=null;f.context.onboardingJobs.clear();await f.action({assistOpen:item.id});assert.equal(f.calls.api.length,1,'missing jobs can show setup choices without creating a replacement run');assert.equal(f.context.onboardingJobs.size,0);assert.equal(rendered,2);
});
test('opening protected progress reads only its owned run and keeps stale ready data behind the repair gate',async()=>{
  const f=fixture(),item=f.assist({provider:'codex',status:'ready',action_kind:'ready',stage:'connection_repair_required',error_code:'codex_personal_auth_owner_conflict',run_id:'protected/run'}),views=[],scrolls=[],job={id:item.run_id,room_id:'room',provider:'codex',member_id:'target',status:'ready',stage:'ready_automatic',can_wake:true,ready_for_office:true,next_actions:[{operation:'login_client'},{operation:'retry'}]};let renders=0,memberSetups=0;
  Object.assign(f.context,{onboardingJobs:new Map(),onboardingView:value=>value.job||value,setProfessionalView:value=>views.push(value),renderLaunch:()=>{renders++;},showMemberSetup:()=>{memberSetups++;},$:id=>{assert.equal(id,'onboarding-progress');return{scrollIntoView:value=>scrolls.push(value)};}});
  f.context.history.connection_assists=[item];f.context.api=async(...args)=>{f.calls.api.push(args);return{job};};await f.action({assistOpen:item.id});
  assert.deepEqual(plain(f.calls.api),[['/api/onboarding/jobs/protected%2Frun']]);assert.equal(memberSetups,0);assert.equal(f.calls.refresh,0);assert.deepEqual(views,[false]);assert.equal(renders,1);assert.equal(scrolls.length,1);
  const displayed=f.context.onboardingJobs.get(job.id);assert.equal(displayed.stage,'connection_repair_required');assert.equal(displayed.ready_for_office,false);assert.equal(displayed.can_wake,false);assert.deepEqual(plain(displayed.next_actions),[]);assert.equal(job.stage,'ready_automatic','the observed server payload is not mutated');
  f.context.onboardingJobs.clear();job.room_id='foreign';await f.action({assistOpen:item.id});assert.equal(f.context.onboardingJobs.size,0);assert.equal(renders,1,'a foreign observation cannot replace protected progress');
});
