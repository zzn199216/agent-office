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
  const assist=values=>({id:'assist',message_id:message.id,room_id:'room',member_id:'assistant',provider:'doubao-desktop',name:'豆包',status:'needs_action',can_wake:false,summary:'需要本人窗口完成一步',copy_sentence:'请读取这台电脑上的接入文档 C:\\AO\\connect.md，按说明完成连接。',document_path:'C:\\AO\\connect.md',...values});
  return {context,message,members,calls,assist,render:()=>context.renderConnectionAssists(message),action:dataset=>context.connectionAssistAction({dataset})};
}
test('connection cards distinguish verified automatic delivery, manual inbox and an unfinished connection',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist({status:'ready',can_wake:true})];let html=f.render();assert.match(html,/已自动接通/);assert.match(html,/可直接在 AO 给它发消息/);assert.doesNotMatch(html,/data-assist-copy|本人窗口信箱/);
  f.context.history.connection_assists=[f.assist({status:'ready',can_wake:false})];html=f.render();assert.match(html,/本人入口已接通/);assert.match(html,/当前是本人窗口信箱，需由该窗口处理消息/);assert.doesNotMatch(html,/已自动接通|data-assist-copy/);
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
  await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);assert.doesNotMatch(f.render(),/data-assist-open="assist"/,'a Doubao target cannot open as Grok');
  Object.assign(f.members[1],{adapter:'grok-bridge'});f.context.history.participants=[f.members[0]];await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.context.history.participants=f.members;f.context.roomId='other-room';await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.context.roomId='room';f.message.sender_id='assistant';await f.action({assistOpen:item.id});assert.deepEqual(opened,[]);
  f.message.sender_id='user';f.context.history.connection_assists=[];f.message.text='Grok 已成功连接，needs_external_entry desktop_session_missing';assert.equal(f.render(),'');assert.equal(f.calls.api.length,0);
});
test('other providers reuse their actual existing member setup without changing native connection behavior',async()=>{
  const f=fixture(),opened=[];f.context.showMemberSetup=async id=>opened.push(id);const item=f.assist({target_member_id:'target'});f.context.history.connection_assists=[item];
  assert.match(f.render(),/data-assist-open="assist">查看连接步骤/);await f.action({assistOpen:item.id});assert.deepEqual(opened,['target']);assert.deepEqual(f.calls.api,[]);
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
    f.context.history.connection_assists=[f.assist({status,copy_sentence:'',document_path:null,summary:'原进度已保留，等待明确继续。',error:'原连接已结束'})];const html=f.render();
    assert.ok(html.includes(title));assert.match(html,/原进度保留，请查看所需步骤后明确继续；没有自动重连/);assert.match(html,/data-assist-open="assist">查看接入步骤/);assert.match(html,/data-assist-check="assist">检查连接/);
    assert.doesNotMatch(html,/正在连接|有需要你完成的步骤时|data-assist-copy=|data-assist-document=|已自动接通/);
  }
});
test('opening interrupted setup reads its exact existing job and renders progress without starting or retrying setup',async()=>{
  const f=fixture(),item=f.assist({status:'interrupted',run_id:'existing/run?one',copy_sentence:'',document_path:null}),job={id:'existing/run?one',room_id:'room',provider:'doubao',status:'interrupted'},views=[],scrolls=[];let rendered=0;
  f.context.history.connection_assists=[item];f.context.onboardingJobs=new Map();f.context.onboardingView=value=>value.job||value;f.context.setProfessionalView=value=>views.push(value);f.context.renderLaunch=()=>{rendered++;};
  f.context.checkOnboarding=()=>{throw Error('Opening progress must never retry an interrupted managed job');};f.context.$=id=>{assert.equal(id,'onboarding-progress');return {scrollIntoView:value=>scrolls.push(value)};};f.context.api=async(...args)=>{f.calls.api.push(args);return {job};};
  await f.action({assistOpen:item.id});
  assert.deepEqual(plain(f.calls.api),[[`/api/onboarding/jobs/${encodeURIComponent(item.run_id)}`]]);assert.equal(f.context.onboardingJobs.get(job.id),job);assert.deepEqual(views,[false]);assert.equal(rendered,1);assert.deepEqual(plain(scrolls),[{block:'nearest',behavior:'smooth'}]);assert.equal(f.calls.refresh,0);assert.deepEqual(f.calls.copy,[]);assert.deepEqual(f.calls.anchors,[]);
  item.run_id=null;f.context.onboardingJobs.clear();await f.action({assistOpen:item.id});assert.equal(f.calls.api.length,1,'missing jobs can show setup choices without creating a replacement run');assert.equal(f.context.onboardingJobs.size,0);assert.equal(rendered,2);
});
