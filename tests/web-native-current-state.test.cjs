'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function fixture(){
  const member={id:'native',name:'豆包',provider:'doubao',status:'ready',verified_at:'old-proof',connection_method:'native_desktop',presence:'online',desktop_connection:{configured:true,state:'offline',can_wake:false,error:'fetch failed'},runtime_state:{presence:'online',worker_online:true,can_wake:true,connection_evidence:{native_conversation_loaded:true,model_reply_verified:true}}};
  const context=vm.createContext({runtime:{members:[]},webConnected:true,memberById:id=>id===member.id?member:null,escape:String,avatar:()=>'',senderName:id=>id,messageContent:message=>message.text,messageImages:()=>'',renderConnectionAssists:()=>'',plainMarkdown:String,time:()=>'',pill:()=>'',desktop:null,messageCanReconcile:()=>false});
  vm.runInContext(section('const presenceLabels =', 'function entryKey(')+section('function memberStatus(', 'function safeRaster(')+section('function renderMessage(', 'function renderConnectionAssists('),context);
  return{member,context};
}
test('member presence and status cannot inherit old native worker evidence after current disconnect',()=>{
  const f=fixture(),value=f.context.memberPresence(f.member);assert.equal(value.status,'offline');assert.equal(value.canWake,false);assert.equal(value.label,'本人对话未连接 · 查看连接');assert.equal(f.context.memberStatus(f.member).tone,'offline');
  assert.equal(f.context.nativeMemberEvidence(f.member).model_reply_verified,false);assert.equal(f.member.runtime_state.connection_evidence.model_reply_verified,true,'historical evidence remains stored');
  f.context.webConnected=false;assert.equal(f.context.memberPresence(f.member).label,'服务已关闭');
});
test('manual mailbox and an unspecified desktop state retain their ordinary presence semantics',()=>{
  const f=fixture();f.member.connection_method='manual';assert.equal(f.context.nativeConnectionUnavailable(f.member),false);assert.equal(f.context.memberPresence(f.member).status,'online');
  f.member.connection_method='native_desktop';delete f.member.desktop_connection;assert.equal(f.context.nativeConnectionUnavailable(f.member),false);assert.equal(f.context.nativeMemberEvidence(null).model_reply_verified,undefined);
});
test('Grok notification routing does not inherit an unavailable native desktop transport',()=>{
  const f=fixture();f.member.provider='grok-bot';f.member.adapter='grok-bridge';f.member.connection_method='configured_notification';
  for(const usable of [null,true,false]){f.member.delivery_capability={notification_usable:usable};assert.equal(f.context.nativeConnectionUnavailable(f.member),false);assert.notEqual(f.context.memberPresence(f.member).label,'本人对话未连接 · 查看连接');}
});
test('only native fetch failed is explained in the message with a scoped connection button',()=>{
  const f=fixture(),message={id:'request',sender_id:'user',to_member_id:f.member.id,status:'failed',kind:'message',error:'fetch failed',text:'hello'};
  const html=f.context.renderMessage(message,[message]);assert.match(html,/本人对话尚未连接/);assert.match(html,/data-open-member="native"/);assert.doesNotMatch(html,/fetch failed/);assert.equal(message.error,'fetch failed');
  f.member.connection_method='manual';assert.match(f.context.renderMessage(message,[message]),/fetch failed/);f.member.connection_method='native_desktop';assert.match(f.context.renderMessage({...message,error:'actual protocol mismatch'},[message]),/actual protocol mismatch/);
});

test('recipient note follows verified notification capability instead of an expired heartbeat',()=>{
  const f=fixture(),elements={recipient:{value:f.member.id},'recipient-note':{textContent:''}};
  Object.assign(f.context,{$:id=>elements[id],recipientRoom:'room',roomId:'room',roomRecipients:new Map()});
  vm.runInContext(section('function updateRecipientNote()', 'function setReply('),f.context);
  Object.assign(f.member,{name:'Grok',connection_method:'configured_notification',presence:'stale',runtime_state:{presence:'stale',worker_online:false,can_wake:false},can_notify:true});
  const note=()=>{f.context.updateRecipientNote();return elements['recipient-note'].textContent;};
  assert.match(note(),/发送后会自动通知它处理/);assert.equal(f.context.memberPresence(f.member).status,'stale','delivery ability must not manufacture a live heartbeat');
  f.context.webConnected=false;assert.match(note(),/服务未连接/);assert.doesNotMatch(note(),/自动通知/);f.context.webConnected=true;
  for(const available of [false,null,undefined]){f.member.can_notify=available;assert.doesNotMatch(note(),/自动通知/);assert.match(note(),/心跳已过期/);}
  f.member.can_notify=true;f.member.status='connection_failed';assert.doesNotMatch(note(),/自动通知/);assert.match(note(),/需重新接入/);
  elements.recipient.value='';assert.match(note(),/公告/);
});
test('clicking a disconnected station opens that original member connection instead of sending another prompt',async()=>{
  const f=fixture(),opened=[],elements=new Map();let options,updates;
  Object.assign(f.context,{officeView:true,professionalView:true,legacyId:null,officeScene:null,history:{room:{id:'room'},participants:[f.member],messages:[]},state:{office:{}},submitting:false,
    $:id=>{if(!elements.has(id))elements.set(id,{value:'',options:[]});return elements.get(id);},window:{AgentOfficeScene:{mount:(_element,value)=>{options=value;return{update:value=>{updates=value;}};}}},
    admittedMembers:members=>members,currentSecretary:()=>({}),secretaryTutorialVisible:()=>false,toggleOfficeComposer:()=>assert.fail('an unavailable conversation needs connection first'),openSecretaryTutorial(){},showMemberSetup:async id=>opened.push(id),action:callback=>callback()});
  vm.runInContext(section('function updateOfficeScene()', 'function detailRows('),f.context);f.context.updateOfficeScene();options.onSelectMember(f.member);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(opened,['native']);assert.equal(updates.participants[0],f.member);assert.equal(updates.messages.length,0);
});
