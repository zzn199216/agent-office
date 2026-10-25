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
test('clicking a disconnected station opens that original member connection instead of sending another prompt',async()=>{
  const f=fixture(),opened=[],elements=new Map();let options,updates;
  Object.assign(f.context,{officeView:true,professionalView:true,legacyId:null,officeScene:null,history:{room:{id:'room'},participants:[f.member],messages:[]},state:{office:{}},submitting:false,
    $:id=>{if(!elements.has(id))elements.set(id,{value:'',options:[]});return elements.get(id);},window:{AgentOfficeScene:{mount:(_element,value)=>{options=value;return{update:value=>{updates=value;}};}}},
    admittedMembers:members=>members,currentSecretary:()=>({}),secretaryTutorialVisible:()=>false,toggleOfficeComposer:()=>assert.fail('an unavailable conversation needs connection first'),openSecretaryTutorial(){},showMemberSetup:async id=>opened.push(id),action:callback=>callback()});
  vm.runInContext(section('function updateOfficeScene()', 'function detailRows('),f.context);f.context.updateOfficeScene();options.onSelectMember(f.member);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(opened,['native']);assert.equal(updates.participants[0],f.member);assert.equal(updates.messages.length,0);
});
