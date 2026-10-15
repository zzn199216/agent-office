'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {RoomService}=require('../src/service.cjs');
const {createServer}=require('../src/http.cjs');
const {toolCall}=require('../src/mcp.cjs');
const {assertEntryScope}=require('../src/entry.cjs');
const {createQwenMcpConfig}=require('../src/mcp-http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,sleep,RoomError}=require('../src/util.cjs');

class NativeProtocolFixture extends EventEmitter{
  constructor(member,service,options,calls){super();this.member=member;this.service=service;this.options=options;this.calls=calls;}
  async status(){return {connected:true,signedIn:true,fixture:true};}
  async run(input){
    this.calls.push({member:this.member.id,prompt:input.request.prompt});
    if(this.options.nativeError)throw new RoomError(this.options.nativeError,503,'fixture_native_error');
    if(this.options.gate)await this.options.gate;
    const thread=input.discussion.thread_id||id();if(!input.discussion.thread_id){input.onBinding('creating');input.onBinding('bound',thread);}input.onTurn(id());
    const invitation=input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);assert.ok(invitation,'only actual invitation handshake is allowed');
    this.service.chat.completeInvite(invitation[1],invitation[2],this.member.id);return {threadId:thread,turnId:id(),answer:'fixture已握手'};
  }
  async close(){}
}
async function setup(t,options={}){
  const files=fixture(),clients=[],installations=[],runtimeCalls=[],terminals=[];let service,scans=0;
  const executable=path.join(files.root,'codex.exe');fs.writeFileSync(executable,'fixture metadata path; never executed');
  const candidates=[{id:'codex',provider:'codex',name:'Codex',adapter:'codex',installed:true,executable,capabilities:{automatic_launch:true}},
    {id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen 桌面客户端',adapter:'mailbox',installed:true,capabilities:{automatic_launch:false,mcp_prepare:true}},
    {id:'doubao',provider:'doubao',name:'豆包',adapter:'mailbox',installed:true,capabilities:{automatic_launch:false}}];
  service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw new Error('fixture prohibits external HTTP');},
    chat:{clientFactory(member){return new NativeProtocolFixture(member,service,options,clients);}},
    launch:{discover:()=>{scans++;return {candidates};},installer:async input=>{installations.push(input);return {status:'installed',installed:true,connected:false,needs_reload:true};}},
    onboarding:{replyVerification:false,runtimeInstaller:async input=>{runtimeCalls.push(input);return {status:'needs_login',installed:true};}},
    onboardingActions:{env:{USERPROFILE:files.root,HOME:files.root,CLAUDE_CONFIG_DIR:path.join(files.root,'.claude')},launcher:async request=>{terminals.push(request);return {pid:process.pid,fixture:true};}}});
  const project=service.addProject({name:'One-click HTTP fixture',path:files.project}),room=service.chat.addRoom({title:'HTTP onboarding fixture',project_id:project.id});
  const token=id(),server=createServer(service,{port:0,token}),port=await server.listen(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await server.close();await service.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  async function request(route,input,authorization=token){const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{...authorization?{Authorization:`Bearer ${authorization}`}:{},...input===undefined?{}:{'Content-Type':'application/json'}},...input===undefined?{}:{body:JSON.stringify(input)}});const value=await response.json();return {response,value};}
  async function api(route,input){const result=await request(route,input);if(!result.response.ok){const error=new Error(result.value.error);error.status=result.response.status;error.code=result.value.code;throw error;}return result.value;}
  async function finish(start){await Promise.all([...service.onboarding.jobs.values()]);const end=Date.now()+3000;while(service.chat.active.size&&Date.now()<end)await sleep(10);assert.equal(service.chat.active.size,0);return api(`/api/onboarding/jobs/${start.id}`);}
  return {...files,service,project,room,base,token,clients,installations,runtimeCalls,terminals,request,api,finish,get scans(){return scans;}};
}

test('one-click HTTP prepares only the selected agent and public polling reuses its real fixture handshake',async t=>{
  const v=await setup(t),start=await v.request('/api/onboarding/start',{provider:'codex',room_id:v.room.id,install_client:true});
  assert.equal(start.response.status,202);const state=await v.finish(start.value);assert.equal(state.stage,'ready_automatic');assert.equal(state.local_verified,true);assert.equal(state.can_wake,true);assert.equal(state.grok_verified,false);
  assert.deepEqual(v.installations.map(item=>item.provider),['codex']);assert.equal(v.clients.length,1);assert.equal(v.scans,1);
  const cards=v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,changes=v.service.revision;
  for(let i=0;i<4;i++){
    const list=await v.api(`/api/onboarding/jobs?room_id=${v.room.id}`);assert.ok(list.jobs.some(item=>item.id===state.id));assert.equal((await v.api(`/api/onboarding/jobs/${state.id}`)).id,state.id);
  }
  assert.equal(v.scans,1);assert.equal(v.clients.length,1);assert.equal(v.service.revision,changes);assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);
  const repeated=await v.api('/api/onboarding/start',{provider:'codex',room_id:v.room.id,install_client:true});assert.equal(repeated.id,state.id);assert.equal(repeated.reused,true);assert.equal(v.clients.length,1);
});
test('HTTP progress lists filter project or room scope and never expose another room through a specific run query',async t=>{
  const v=await setup(t),first=await v.api('/api/onboarding/start',{provider:'codex',room_id:v.room.id});await v.finish(first);
  const second=v.service.chat.addRoom({title:'another room fixture',project_id:v.project.id});
  const roomList=await v.api(`/api/onboarding/jobs?room_id=${second.id}`);assert.deepEqual(roomList.jobs,[]);
  const projectList=await v.api(`/api/onboarding/jobs?project_id=${v.project.id}`);assert.ok(projectList.jobs.some(item=>item.id===first.id));
  const wrong=await v.request(`/api/onboarding/jobs/${first.id}?room_id=${second.id}`);assert.equal(wrong.response.status,403);assert.equal(wrong.value.code,'onboarding_scope_mismatch');
});
test('one-click persists the sanitized collaboration goal in real sessions and retry cannot replace it or begin business',async t=>{
  const v=await setup(t,{nativeError:'尚未登录，需要本人配置模型认证。'}),goal='  只做协作准备，不开始运营。 crsr_fixture_private_key  ';
  const start=await v.api('/api/onboarding/start',{provider:'codex',room_id:v.room.id,goal}),state=await v.finish(start),expected='只做协作准备，不开始运营。 [密钥已隐藏]';
  assert.equal(state.goal,expected);assert.equal(v.service.store.db.prepare('SELECT goal FROM onboarding_runs WHERE id=?').get(state.id).goal,expected);assert.equal(v.service.store.db.prepare('SELECT goal FROM launch_sessions WHERE id=?').get(state.launch_session_id).goal,expected);
  const retry=await v.api(`/api/onboarding/jobs/${state.id}/retry`,{goal:'改成主动发布'}),second=await v.finish(retry);
  assert.equal(second.goal,expected);assert.equal(v.service.store.db.prepare('SELECT goal FROM launch_sessions WHERE id=?').get(second.launch_session_id).goal,expected);
  assert.ok(v.clients.every(call=>call.prompt.startsWith('请完成聊天室成员的真实接入握手')));assert.ok(v.clients.every(call=>!call.prompt.includes('开始运营')&&!call.prompt.includes('主动发布')));
});
test('ordinary resume secrets cannot authenticate onboarding control endpoints',async t=>{
  const v=await setup(t),member=v.service.chat.addMember({name:'Qwen card fixture',adapter:'mailbox'});v.service.chat.join(v.room.id,member.id);const card=v.service.resume.issue(member.id,v.room.id).card;
  for(const [route,input] of [['/api/onboarding/start',{provider:'codex',room_id:v.room.id}],['/api/onboarding/jobs',undefined],[`/api/onboarding/jobs/${id()}/retry`,{}],['/api/onboarding/action',{run_id:id(),kind:'login'}]]){
    const result=await v.request(route,input,card.secret);assert.equal(result.response.status,401);assert.equal(JSON.stringify(result.value).includes(card.secret),false);
  }
  assert.equal(v.scans,0);assert.equal(v.clients.length,0);assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM onboarding_runs').get().n,0);
});
test('member-scoped CLI entry cannot invoke any onboarding start retry or action',async t=>{
  const v=await setup(t),member=v.service.chat.addMember({name:'ordinary fixture member',adapter:'mailbox'});v.service.chat.join(v.room.id,member.id);const card=v.service.resume.issue(member.id,v.room.id).card;
  const disk={store:v.service.store,chat:v.service.chat.store,runtime:v.service.runtime,resume:v.service.resume};
  for(const [route,input] of [['/api/onboarding/start',{provider:'codex',room_id:v.room.id}],[`/api/onboarding/jobs/${id()}/retry`,{run_id:id()}],['/api/onboarding/action',{run_id:id(),kind:'login'}]])assert.throws(()=>assertEntryScope(disk,card,route,input),error=>error.status===403&&error.code==='resume_scope_mismatch');
  assert.equal(v.scans,0);assert.equal(v.clients.length,0);
});
test('setup MCP connect requires explicit user setup and rejects bound member calls before dispatch',async t=>{
  const v=await setup(t);let calls=0;
  const input={user_requested_setup:true,provider:'codex',room_id:v.room.id};
  const api=async(route,body)=>{calls++;assert.equal(route,'/api/onboarding/start');assert.equal(body.provider,'codex');return v.api(route,body);};
  await assert.rejects(toolCall('agentroom_connect',input,api,{env:{}}),/接入 MCP|普通成员/);assert.equal(calls,0);
  await assert.rejects(toolCall('agentroom_connect',{...input,user_requested_setup:false},api,{env:{AGENTROOM_SETUP_MODE:'1'}}),/格式无效/);assert.equal(calls,0);
  await assert.rejects(toolCall('agentroom_connect',input,api,{env:{AGENTROOM_SETUP_MODE:'1',AGENTROOM_MEMBER_ID:id(),AGENTROOM_ROOM_ID:v.room.id}}),/普通成员/);assert.equal(calls,0);
  const start=await toolCall('agentroom_connect',input,api,{env:{AGENTROOM_SETUP_MODE:'1'}});assert.equal(calls,1);assert.equal((await v.finish(start)).stage,'ready_automatic');assert.equal(v.clients.length,1);
});
test('HTTP desktop onboarding reports import and mailbox readiness without claiming a background model',async t=>{
  const v=await setup(t),start=await v.api('/api/onboarding/start',{provider:'qwen-desktop',room_id:v.room.id,install_client:true});
  const state=await v.finish(start);assert.equal(state.stage,'awaiting_native_desktop');assert.equal(state.can_wake,false);assert.equal(state.local_verified,false);assert.equal(v.clients.length,0);
  const config=await v.api('/api/launch/client-config',{session_id:state.launch_session_id,provider:'qwen-desktop'}),url=config.config.mcpServers.agentroom.url;
  const parts=new URL(url).pathname.split('/'),card=v.service.resume.credential(parts[2]),raw=fs.readFileSync(path.join(v.data,'entries',`${card.member_id}-${card.room_id}.json`),'utf8');
  assert.equal(JSON.stringify(state).includes(parts[3]),false);assert.equal(JSON.stringify(state).includes('/mcp/'),false);
  v.service.entry.accept(JSON.parse(raw));const ready=await v.api(`/api/onboarding/jobs/${start.id}`);assert.equal(ready.stage,'ready_mailbox');assert.equal(ready.local_verified,true);assert.equal(ready.can_wake,false);assert.equal(ready.grok_verified,false);
  assert.equal(v.service.chat.store.member(ready.member_id).adapter,'mailbox');assert.equal(v.clients.length,0);
});
test('HTTP revoked backend is shown unavailable and only explicit retry can issue its replacement',async t=>{
  const v=await setup(t),start=await v.api('/api/onboarding/start',{provider:'codex',room_id:v.room.id}),ready=await v.finish(start);
  const entry=v.service.entry.issue(ready.member_id,v.room.id),cards=v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;v.service.resume.revoke(entry.credential_id);
  for(let i=0;i<3;i++){const state=await v.api(`/api/onboarding/jobs/${start.id}`);assert.equal(state.stage,'awaiting_credential');assert.equal(state.local_verified,false);}
  assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);assert.equal(v.clients.length,1);
  const blockedRetry=await v.api(`/api/onboarding/jobs/${start.id}/retry`,{});assert.equal((await v.finish(blockedRetry)).stage,'awaiting_credential');assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards);
  const retried=await v.api('/api/onboarding/start',{room_id:v.room.id,provider:'codex',target_member_id:ready.member_id,reauthorize:true});assert.notEqual(retried.id,start.id);const second=await v.finish(retried);
  assert.equal(second.stage,'ready_automatic');assert.equal(v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,cards+1);
});
test('HTTP explicit login action uses only the selected trusted CLI and ignores browser executable fields',async t=>{
  const v=await setup(t),executable=path.join(v.root,'claude.exe');fs.writeFileSync(executable,'trusted CLI path fixture, never executed');
  v.service.store.setting('runtime.claude-code',{executable,executable_args:[],version:'2.1.296'});
  const start=await v.api('/api/onboarding/start',{provider:'claude-code',room_id:v.room.id,install_runtime:true}),state=await v.finish(start);
  assert.equal(state.stage,'awaiting_auth');assert.equal(v.terminals.length,0);assert.equal(v.clients.length,0);
  const input={run_id:start.id,operation:'login_client',command:'untrusted-browser-executable',args:['--eval','malicious-browser-code']};
  const result=await v.api('/api/onboarding/action',input);assert.equal(result.action.launched,true);assert.equal(v.terminals.length,1);
  const terminal=v.terminals[0];assert.equal(terminal.command,'powershell.exe');assert.equal(terminal.options.shell,false);assert.equal(terminal.options.windowsHide,false);
  const script=Buffer.from(terminal.args.at(-1),'base64').toString('utf16le');assert.ok(script.includes(executable));assert.ok(script.includes("'auth' 'login'"));assert.equal(script.includes('untrusted-browser-executable'),false);assert.equal(script.includes('malicious-browser-code'),false);
  const again=await v.api('/api/onboarding/action',input);assert.equal(again.action.reused,true);assert.equal(v.terminals.length,1);assert.equal(v.clients.length,0);
});
test('HTTP cannot execute a login or install action outside the selected job phase',async t=>{
  const v=await setup(t),start=await v.api('/api/onboarding/start',{provider:'codex',room_id:v.room.id});await v.finish(start);
  for(const operation of ['login_client','install_runtime','arbitrary_command']){
    const result=await v.request('/api/onboarding/action',{run_id:start.id,operation,command:'not-authorized'});assert.equal(result.response.status,409);assert.equal(result.value.code,'onboarding_action_unavailable');
  }
  assert.equal(v.terminals.length,0);assert.equal(v.clients.length,1);assert.equal(v.runtimeCalls.length,0);
});
test('card-authenticated HTTP MCP never exposes setup connect and cannot execute it by name',async t=>{
  const v=await setup(t),member=v.service.chat.addMember({name:'card-only fixture',adapter:'mailbox'});v.service.chat.join(v.room.id,member.id);const card=v.service.resume.issue(member.id,v.room.id).card,url=createQwenMcpConfig(v.base,card).mcpServers.agentroom.url;
  const send=async(message,session)=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-06-18'}:{}},body:JSON.stringify(message)});const raw=await response.text();return {response,value:raw?JSON.parse(raw):null};};
  const initialized=await send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}}),session=initialized.response.headers.get('mcp-session-id');await send({jsonrpc:'2.0',method:'notifications/initialized'},session);
  const list=await send({jsonrpc:'2.0',id:2,method:'tools/list'},session);assert.equal(list.value.result.tools.some(tool=>tool.name==='agentroom_connect'),false);
  const call=await send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'agentroom_connect',arguments:{user_requested_setup:true,provider:'codex',room_id:v.room.id}}},session);assert.equal(call.value.result.isError,true);
  assert.equal(v.service.resume.credential(card.credential_id).status,'pending');assert.equal(v.scans,0);assert.equal(v.clients.length,0);
});
