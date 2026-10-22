'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {ConnectionAssist,parseConnectionProviders}=require('../src/connection-assist.cjs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,now,sleep}=require('../src/util.cjs');

class HandshakeFixture extends EventEmitter{
  constructor(member,service,calls){super();this.member=member;this.service=service;this.calls=calls;}
  async status(){return {connected:true,signedIn:true};}
  async run(input){this.calls.push(input.request.prompt);const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);input.onTurn(id());
    const verification=[...input.request.prompt.matchAll(/AO-CONNECT-[a-f0-9-]+/gi)].at(-1)?.[0];
    if(verification)return {threadId:thread,turnId:id(),answer:verification};
    const invitation=input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);assert.ok(invitation,'fixture runs only connection handshake');
    this.service.chat.completeInvite(invitation[1],invitation[2],this.member.id);return {threadId:thread,turnId:id(),answer:'fixture 已接通'};}
  async close(){}
}
function setup(t,options={}){
  const files=fixture(),calls={scans:0,desktop:[],native:[],install:0},executable=path.join(files.root,'codex.exe');fs.writeFileSync(executable,'fixture only; never executed');let service;
  const candidates=[{id:'codex',provider:'codex',name:'Codex',adapter:'codex',installed:true,executable,capabilities:{automatic_launch:true}},
    {id:'doubao',provider:'doubao',name:'豆包',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}},
    {id:'qwen-desktop',provider:'qwen-desktop',name:'Qwen',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}},
    {id:'grok-bot',provider:'grok-bot',name:'Grok Bot',adapter:'grok-bridge',installed:true,running:true,capabilities:{manual_connect:true}}];
  service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('no external requests in fixture');},
    chat:{clientFactory:member=>new HandshakeFixture(member,service,calls.native)},
    launch:{discover(){calls.scans++;return {candidates};},installer:async()=>{calls.install++;throw Error('installation not authorized');}},
    onboarding:{defaultDesktopMethod:options.manualOnly?'manual_mcp':'native_desktop',desktopConnector:options.manualOnly?null:async input=>{calls.desktop.push(input);if(options.desktopGate)await options.desktopGate;throw Error(options.nativeError||'fixture 本机接口不可用 https://localhost/mcp/private-token token=fixture-private-token');}},
    connectionAssist:{contextWaitMs:options.contextWaitMs??100}});
  service._localUrl='http://127.0.0.1:47831';
  // These document fixtures explicitly select the optional manual connection;
  // absence of a native connector no longer silently changes delivery mode.
  if(options.manualOnly){const start=service.onboarding.start.bind(service.onboarding);service.onboarding.start=input=>start({...input,connection_method:'manual_mcp'});}
  const project=service.addProject({name:'assist fixture',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'办公室'}),other=service.chat.addRoom({project_id:project.id,title:'另一间'}),recipient=service.chat.addMember({name:'接入助手',adapter:'mailbox'});
  service.chat.join(room.id,recipient.id);service.chat.store.updateMember(recipient.id,{status:'ready',verified_at:now()});
  const manager=service.connectionAssist||new ConnectionAssist(service,{contextWaitMs:options.contextWaitMs??100});
  const message=(text,extra={})=>service.chat.store.post({room_id:room.id,sender_id:'user',to_member_id:recipient.id,text,idempotency_key:id(),...extra});
  const finish=async()=>{await Promise.all([...manager.jobs.values()]);return manager.listRoom(room.id);};
  t.after(async()=>{manager.stop();await service.close();await manager.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {...files,service,project,room,other,recipient,manager,calls,message,finish};
}
function counts(v){const db=v.service.store.db;return {members:db.prepare('SELECT count(*) n FROM chat_members').get().n,credentials:db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,runs:db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,assists:db.prepare('SELECT count(*) n FROM connection_assists').get().n};}
function cloneRun(v,runId,fields={}){const row={...v.service.onboarding.row(runId),id:id(),...fields},keys=Object.keys(row);v.service.store.db.prepare(`INSERT INTO onboarding_runs(${keys.join(',')}) VALUES(${keys.map(key=>':'+key).join(',')})`).run(row);return row;}

test('a Codex authentication protection card cannot turn into a login retry or success when the fixture later reports signed in',async t=>{
  const v=setup(t);let signedIn=false;v.service.chat.options.clientFactory=member=>{const client=new HandshakeFixture(member,v.service,v.calls.native),run=client.run.bind(client);client.authOwnershipStatus=()=>({blocked:!signedIn,code:'codex_auth_ownership_required'});client.run=input=>signedIn?run(input):Promise.reject(Object.assign(Error('当前认证所有权尚未核对。'),{code:'codex_auth_ownership_required'}));return client;};
  const message=v.message('连接 Codex');v.manager.begin(message);const [original]=await v.finish();assert.equal(original.stage,'connection_repair_required');signedIn=true;
  const before=counts(v),calls=v.calls.native.length,retry=v.service.onboarding.retry({run_id:original.run_id});assert.equal(retry.id,original.run_id);v.service.onboarding.advanceVerifications();await Promise.all([...v.service.onboarding.jobs.values()]);
  const revision=v.service.revision,card=v.manager.snapshotForMessage(message.id)[0];assert.equal(card.run_id,original.run_id);assert.equal(card.ready_for_office,false);assert.equal(card.action_kind,'connection_repair');assert.equal(card.recovery_action,null);assert.equal(card.target_member_id,original.target_member_id);assert.equal(v.manager.row(card.id).run_id,original.run_id);
  assert.match(card.summary,/保护已登录的 Codex/);assert.match(card.next_step,/无需重复登录或重新配置 MCP/);assert.match(await v.manager.prepareContext(message.id),/"connection_ready":false/);assert.deepEqual(counts(v),before);assert.equal(v.calls.native.length,calls);assert.equal(v.service.revision,revision);
});

test('a preview12 Codex protection assist exposes safe original-login recheck without automatic mutation',async t=>{
  const v=setup(t),message=v.message('连接 Codex');v.manager.begin(message);const [original]=await v.finish(),memberId=original.target_member_id;
  v.service.store.db.prepare("UPDATE onboarding_runs SET status='needs_action',stage='connection_repair_required',auth_mode=NULL,auth_revision=NULL,error=?,runtime_result=? WHERE id=?").run('旧版保护记录',JSON.stringify({status:'connection_repair_required',error_code:'codex_auth_ownership_required'}),original.run_id);
  const client=v.service.chat.clients.get(memberId);assert.ok(client);client.authOwnershipStatus=()=>({blocked:false,mode:'shared-cache',revision:'native-shared-cache-v1'});
  const before=counts(v),revision=v.service.revision,calls=v.calls.native.length,credentials=v.service.resume.credentials(memberId).map(card=>({...card}));
  for(let i=0;i<2;i++){const card=v.manager.snapshotForMessage(message.id)[0];assert.equal(card.stage,'connection_recheck_available');assert.equal(card.action_kind,'connection_recheck');assert.equal(card.error_code,null);assert.equal(card.auth_mode,'shared-cache');assert.equal(card.recheck_auth_revision,'native-shared-cache-v1');assert.equal(card.ready_for_office,false);assert.equal(card.local_verified,false);assert.equal(card.can_wake,false);assert.equal(card.run_id,original.run_id);assert.equal(card.target_member_id,memberId);assert.deepEqual(card.recovery_action,{operation:'retry',run_id:original.run_id,room_id:v.room.id,provider:'codex',target_member_id:memberId});assert.equal(card.copy_sentence,'');assert.match(card.next_step,/沿用已有登录，重新验证/);}
  v.service.onboarding.advanceVerifications();assert.deepEqual(counts(v),before);assert.equal(v.calls.native.length,calls);assert.equal(v.service.revision,revision);assert.deepEqual(v.service.resume.credentials(memberId),credentials);assert.equal(v.service.onboarding.jobs.size,0);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/"action_kind":"connection_recheck"/);assert.match(context,/"connection_ready":false/);assert.doesNotMatch(context,/login_client/);
});

test('successor cards follow the latest exact identity attempt and reject newer other-room provider or same-name people',async t=>{
  const v=setup(t),message=v.message('连接 Codex');v.manager.begin(message);const [original]=await v.finish(),anchor=v.service.onboarding.row(original.run_id),memberId=original.target_member_id;
  const other=v.service.chat.addMember({name:v.service.chat.store.member(memberId).name,adapter:'codex'});v.service.chat.join(v.room.id,other.id);v.service.chat.join(v.other.id,memberId);
  const later=offset=>new Date(Date.parse(anchor.created)+offset).toISOString(),states=new Map(),state=(run,member,status='ready')=>({id:run.id,run_id:run.id,room_id:run.room_id,provider:run.provider,member_id:member,status,stage:status==='ready'?'ready_automatic':'awaiting_auth',ready_for_office:status==='ready',local_verified:status==='ready',can_wake:status==='ready',next_actions:[]});
  const valid=cloneRun(v,anchor.id,{target_member_id:memberId,created:later(1000),status:'needs_action',stage:'awaiting_auth'});states.set(valid.id,state(valid,memberId,'needs_action'));
  for(const fields of [{room_id:v.other.id,target_member_id:memberId},{provider:'claude-code',target_member_id:memberId},{target_member_id:other.id},{target_member_id:null}]){const foreign=cloneRun(v,anchor.id,{...fields,created:later(2000)});states.set(foreign.id,state(foreign,fields.target_member_id===null?other.id:fields.target_member_id));}
  const old=cloneRun(v,anchor.id,{target_member_id:memberId,created:new Date(Date.parse(anchor.created)-1000).toISOString()});states.set(old.id,state(old,memberId));
  const read=v.service.onboarding.state.bind(v.service.onboarding);v.service.onboarding.state=input=>states.get(input.run_id)||read(input);
  const before=counts(v),revision=v.service.revision,card=v.manager.snapshotForMessage(message.id)[0];assert.equal(card.run_id,valid.id);assert.equal(card.target_member_id,memberId);assert.equal(card.ready_for_office,false);assert.equal(card.recovery_action.run_id,valid.id);assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);
});

test('a revoked no-run card follows only a later explicit reauthorization for its exact original member',async t=>{
  const v=setup(t),first=v.message('连接 Codex');v.manager.begin(first);const [connected]=await v.finish(),memberId=connected.target_member_id;v.service.entry.issue(memberId,v.room.id);v.service.entry.revoke(memberId,v.room.id);
  assert.equal(require('../src/connection-target.cjs').resolveConnectionTarget(v.service,{provider:'codex',room_id:v.room.id}).blocked,true,'the isolated target must really be revoked');
  const message=v.message('连接 Codex');v.manager.begin(message);await v.finish();const [original]=v.manager.snapshotForMessage(message.id);assert.equal(original.run_id,null);assert.equal(original.target_member_id,memberId);
  const anchor=v.service.onboarding.row(connected.run_id),created=new Date(Date.parse(original.created)+1000).toISOString(),states=new Map(),read=v.service.onboarding.state.bind(v.service.onboarding);
  const add=fields=>{const run=cloneRun(v,anchor.id,{target_member_id:memberId,created,...fields});states.set(run.id,{id:run.id,run_id:run.id,room_id:run.room_id,provider:run.provider,member_id:run.target_member_id,status:'ready',stage:'ready_automatic',ready_for_office:true,local_verified:true,can_wake:true,next_actions:[]});return run;};
  const unrelated=add({reauthorize:0});v.service.onboarding.state=input=>states.get(input.run_id)||read(input);assert.equal(v.manager.snapshotForMessage(message.id)[0].run_id,null);
  add({reauthorize:1,created:new Date(Date.parse(original.created)-1000).toISOString()});const other=v.service.chat.addMember({name:'另一个 Codex',adapter:'codex'});v.service.chat.join(v.room.id,other.id);add({reauthorize:1,target_member_id:other.id});assert.equal(v.manager.snapshotForMessage(message.id)[0].run_id,null);
  const recovered=add({reauthorize:1}),before=counts(v),revision=v.service.revision,card=v.manager.snapshotForMessage(message.id)[0];assert.notEqual(card.run_id,unrelated.id);assert.equal(card.run_id,recovered.id);assert.equal(card.target_member_id,memberId);assert.equal(card.ready_for_office,true);assert.equal(v.manager.row(card.id).run_id,null);assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);
});

test('parser accepts named imperative requests and keeps CLI identities separate',()=>{
  assert.deepEqual(parseConnectionProviders('把grok bot拉进群'),['grok-bot']);assert.deepEqual(parseConnectionProviders('那拉个豆包进来'),['doubao']);
  assert.deepEqual(parseConnectionProviders('请接入 Qwen Code 和 Qwen 桌面版，然后连接 Claude Code'),['qwen-code','qwen-desktop','claude-code']);
  assert.deepEqual(parseConnectionProviders('Please connect Grok and Doubao.'),['grok-bot','doubao']);
  assert.deepEqual(parseConnectionProviders('不要接入Qwen，只拉豆包进来'),['doubao']);
  assert.deepEqual(parseConnectionProviders('接入 Gemini CLI、Codex 和 Cherry Studio'),['gemini-cli','codex','cherry-studio']);
  assert.deepEqual(parseConnectionProviders('连接 qwen-code 和 claude-code'),['qwen-code','claude-code']);
  for(const text of ['接入一下grok','请帮我接入一下grok','把grok接一下'])assert.deepEqual(parseConnectionProviders(text),['grok-bot'],text);
  for(const text of ['帮我接一下豆包','帮我连接一下豆包'])assert.deepEqual(parseConnectionProviders(text),['doubao'],text);
});
test('multiline quotations, tool output, chat history and deferred wording cannot authorize connection',()=>{
  for(const text of ['他说：\n连接grok','工具返回：\n连接grok','以下是聊天记录：\n连接grok','同事建议：\n连接grok',
    '他说‘\n连接grok\n’','"\n接入一下grok\n"',"'\n连接grok\n'",'连接grok，先别接入','连接grok，先让我确认一下','连接grok，等我再说',
    '不要接一下豆包','如何接入一下grok','帮我连接一下豆包的文档','请帮我接一下豆包，等我同意后再执行'])assert.deepEqual(parseConnectionProviders(text),[],text);
  assert.deepEqual(parseConnectionProviders('不要接入Qwen，只拉豆包进来'),['doubao']);
});
test('parser ignores diagnostic questions, quotes, code, negation, documents and unknown clients',()=>{
  for(const text of ['为什么Grok不能拉进来','Qwen 连接失败，帮我排查','能不能连接豆包？','不要接入 Grok','不想拉豆包','解释如何连接 Qwen',
    '请写连接 Grok 的文档','他说“把豆包拉进来”','工具返回内容是把豆包拉进来','Grok 建议连接豆包','接入 Grok Build','`连接Qwen`','```\n把grok bot拉进群\n```','> 把豆包拉进来','我使用了 Grok','连接 unknownagent'])assert.deepEqual(parseConnectionProviders(text),[],text);
});
test('parser requires actual people as objects and respects deferred human confirmation across clauses',()=>{
  for(const text of ['请把 Codex 的日志添加到这份报告','请把 Grok 的接入步骤加入文档','请把豆包的回复添加到文档','把豆包给Codex看',
    '把 Codex 加入 Grok 群','把豆包拉进 Grok 群聊','请把 Codex 添加到 Grok Bot 的群里','请连接豆包，并先不要执行，等我确认',
    '请接入 Grok。等我同意后再执行','连接豆包，先别动手','Please connect Grok, wait for my approval'])assert.deepEqual(parseConnectionProviders(text),[],text);
  assert.deepEqual(parseConnectionProviders('请把 Codex 和 Grok Bot 加入办公室'),['grok-bot','codex']);
  assert.deepEqual(parseConnectionProviders('请把 Grok Bot 拉进群'),['grok-bot']);
});
test('ordinary chat has no setup effects and actual peer or forged source is rejected',async t=>{
  const v=setup(t),before=counts(v);assert.deepEqual(v.manager.begin(v.message('你好')),[]);assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,0);
  const peer=v.service.chat.addMember({name:'同行',adapter:'mailbox'});v.service.chat.join(v.room.id,peer.id);
  const message=v.message('把豆包拉进来',{sender_id:peer.id});assert.throws(()=>v.manager.begin(message),error=>error.code==='connection_assist_source_forbidden');
  const human=v.message('把豆包拉进来');assert.throws(()=>v.manager.begin({...human,room_id:v.other.id}),error=>error.code==='connection_assist_scope_mismatch');assert.equal(v.calls.scans,0);
});
test('scheduler provenance is rejected even before team_outbox.message_id is linked',async t=>{
  const v=setup(t);v.service.secretary.set({room_id:v.room.id,member_id:v.recipient.id});const goal=v.service.team.goal({room_id:v.room.id,title:'协作目标',description:'fixture',acceptance:'fixture evidence',idempotency_key:'goal-fixture'});
  const eventId=id();v.service.store.db.prepare('INSERT INTO team_outbox(id,room_id,recipient_id,record_id,event_key,body) VALUES(?,?,?,?,?,?)').run(eventId,v.room.id,v.recipient.id,goal.id,'fixture:'+eventId,'把豆包拉进来');
  const message=v.message('把豆包拉进来',{idempotency_key:'team:'+eventId});assert.ok(message.coordination);
  assert.throws(()=>v.manager.begin(message),error=>error.code==='connection_assist_source_forbidden');assert.equal(v.calls.scans,0);
});
test('selected managed provider follows existing real fixture handshake without runtime installation',async t=>{
  const v=setup(t),message=v.message('请把 Codex 接入办公室');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.provider,'codex');assert.equal(state.status,'ready');assert.equal(state.can_wake,true);assert.equal(state.local_verified,true);assert.equal(state.document_path,null);
  assert.equal(v.calls.native.length,2);assert.equal(v.calls.scans,1);assert.equal(v.calls.install,0);
  assert.equal(state.automatic_reply_verified,true);
  const row=v.service.store.db.prepare('SELECT install_client,install_runtime FROM onboarding_runs WHERE id=?').get(state.run_id);assert.equal(row.install_client,0);assert.equal(row.install_runtime,0);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/已接通/);assert.doesNotMatch(context,/fixture-private-token/);
});
test('Grok fallback returns a copy sentence and owned document while bot-visible state excludes target credentials',async t=>{
  const v=setup(t),message=v.message('把grok bot拉进群');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.status,'needs_action');assert.equal(state.can_wake,false);assert.equal(state.local_verified,false);assert.ok(state.document_path);assert.match(state.copy_sentence,/请读取这台电脑上的接入文档/);assert.match(state.document_url,new RegExp('/api/connection-assists/'+state.id+'/document'));
  const document=v.manager.document(state.id,v.room.id);assert.match(document.filename,/grok-bot/);assert.match(document.text,/长期恢复入口/);assert.match(document.text,/不自动创建群聊/);assert.ok(!document.text.includes('fixture-private-token'));
  const context=await v.manager.prepareContext(message.id);assert.match(context,/同一条回复里提供复制说明与查看步骤按钮/);assert.match(context,/copy_sentence/);assert.doesNotMatch(context,/fixture-private-token|\/mcp\/private-token|secret/);
  assert.equal(v.calls.native.length+v.calls.install,0);assert.equal(v.calls.desktop.length,0,'unverified Grok native adapter must not be contacted');
});
test('exact casual user request prepares one existing Grok guide and gives the secretary a concrete continuation',async t=>{
  const v=setup(t),message=v.message('接入一下grok');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.provider,'grok-bot');assert.equal(state.handoff_kind,'grok_guided');assert.equal(state.connection_method,'grok_command_bridge');assert.equal(state.target_window,'已有 Grok Bot 对话');assert.match(state.next_step,/复制给 Grok Bot/);assert.match(state.next_step,/不需要创建群聊/);
  assert.ok(state.target_member_id);assert.ok(state.copy_sentence);assert.ok(state.document_path);assert.equal(state.status,'needs_action');assert.equal(state.can_wake,false);
  const before=counts(v),scans=v.calls.scans,credentials=v.service.resume.credentials(state.target_member_id),bytes=fs.readFileSync(v.service.entry.describePrimary(state.target_member_id,v.room.id).file);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/不能只回答/);assert.match(context,/同一条回复里提供复制说明与查看步骤按钮/);assert.match(context,/target_window/);assert.match(context,/已有 Grok Bot 对话/);assert.doesNotMatch(context,/fixture-private-token|desktop_session_missing|needs_external_entry/);
  v.manager.begin(message);await v.finish();assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,scans);assert.deepEqual(v.service.resume.credentials(state.target_member_id),credentials);assert.deepEqual(fs.readFileSync(v.service.entry.describePrimary(state.target_member_id,v.room.id).file),bytes);assert.equal(v.calls.desktop.length,0);
});
test('reported history and deferred requests create no assists, scans, sessions or credentials',async t=>{
  const v=setup(t),before=counts(v);
  for(const text of ['他说：\n接入一下grok','工具返回：\n连接grok','以下是聊天记录：\n连接grok','连接grok，先别接入','连接grok，先让我确认一下','连接grok，等我再说'])assert.deepEqual(v.manager.begin(v.message(text)),[]);
  assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,0);assert.equal(v.calls.desktop.length,0);assert.equal(v.calls.native.length,0);
});
test('historical Grok handshake with a stale connection failure keeps guiding until fresh real contact',async t=>{
  const v=setup(t),first=v.message('连接grok');v.manager.begin(first);const [initial]=await v.finish(),memberId=initial.target_member_id,file=v.service.entry.describePrimary(memberId,v.room.id).file,bytes=fs.readFileSync(file),card=JSON.parse(bytes);
  v.service.entry.accept(card);const oldTime=new Date(Date.now()-60000).toISOString();
  v.service.store.db.prepare('UPDATE chat_resume_credentials SET last_seen=? WHERE id=?').run(oldTime,card.credential_id);
  v.service.chat.store.updateMember(memberId,{status:'connection_failed',error:'desktop_session_missing',verified_at:oldTime});
  const message=v.message('接入一下grok');v.manager.begin(message);await v.finish();const state=v.manager.snapshotForMessage(message.id)[0];
  assert.equal(state.target_member_id,memberId);assert.equal(state.status,'needs_action');assert.equal(state.local_verified,false);assert.ok(state.document_path);assert.ok(state.copy_sentence);assert.match(state.next_step,/复制给 Grok Bot/);
  const before=counts(v),scans=v.calls.scans,contact=v.service.resume.credential(card.credential_id).last_seen;
  for(let i=0;i<3;i++){const context=await v.manager.prepareContext(message.id);assert.match(context,/已有 Grok Bot 对话/);assert.doesNotMatch(context,/desktop_session_missing/);assert.equal(v.manager.snapshotForMessage(message.id)[0].status,'needs_action');}
  assert.equal(v.service.resume.credential(card.credential_id).last_seen,contact);assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,scans);assert.deepEqual(fs.readFileSync(file),bytes);
  await sleep(5);v.service.entry.accept(card);const ready=v.manager.snapshotForMessage(message.id)[0];
  assert.equal(ready.status,'ready');assert.equal(ready.local_verified,true);assert.equal(ready.can_wake,false);assert.equal(ready.automatic_reply_verified,false);assert.equal(ready.error,null);assert.deepEqual(counts(v),before);assert.deepEqual(fs.readFileSync(file),bytes);
  assert.doesNotMatch(ready.next_step,/点击|复制/);assert.match(await v.manager.prepareContext(message.id),/"connection_ready":true/);
});
test('mailbox document is private and read-only polling never scans, issues credentials or generates templates again',async t=>{
  const v=setup(t,{manualOnly:true}),message=v.message('那拉个豆包进来');v.manager.begin(message);const [state]=await v.finish(),before=counts(v),scans=v.calls.scans,revision=v.service.revision;
  const cardFile=v.service.entry.describe(state.target_member_id,v.room.id).file,card=JSON.parse(fs.readFileSync(cardFile,'utf8')),bytes=fs.readFileSync(cardFile),doc=v.manager.document(state.id,v.room.id);
  assert.ok(!doc.text.includes(card.secret),'document points to the target private template without embedding its secret');assert.match(doc.text,/STDIO/);assert.match(doc.text,/Streamable HTTP/);
  const first=fs.statSync(state.document_path).mtimeMs;
  for(let i=0;i<4;i++){assert.ok(!JSON.stringify(v.manager.listRoom(v.room.id)).includes(card.secret));assert.ok(!(await v.manager.prepareContext(message.id)).includes(card.secret));v.manager.document(state.id,v.room.id);}
  assert.equal(v.calls.scans,scans);assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);assert.deepEqual(fs.readFileSync(cardFile),bytes);assert.equal(fs.statSync(state.document_path).mtimeMs,first);
  assert.equal(state.local_verified,false);v.service.entry.accept(card);const [ready]=v.manager.snapshotForMessage(message.id);assert.equal(ready.local_verified,true);assert.equal(ready.status,'ready');assert.equal(ready.can_wake,false);assert.equal(ready.automatic_reply_verified,false);
});
test('an unsupported Grok replaces its stale document with an honest capability-check prompt',async t=>{
  const v=setup(t),message=v.message('接入一下grok');v.manager.begin(message);const [first]=await v.finish();assert.ok(first.document_path);assert.ok(first.target_member_id);
  const before=counts(v);v.manager.state=()=>({id:first.run_id,member_id:first.target_member_id,status:'needs_action',stage:'unsupported',local_verified:false,ready_for_office:false});
  const state=v.manager.snapshotForMessage(message.id)[0];assert.equal(state.action_kind,'unsupported');assert.equal(state.handoff_kind,null);assert.equal(state.document_path,null);assert.equal(state.copy_sentence,'');assert.equal(state.guidance.kind,'check_capability');assert.match(state.next_step,/复制给 Grok Bot 检查/);assert.doesNotMatch(state.guidance.prompt,/--entry|https?:\/\/|secret|token=/);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/一条回复内按成员分成简短段落/);assert.match(context,/"action_kind":"unsupported"/);assert.match(context,/"kind":"check_capability"/);assert.doesNotMatch(context,/"copy_sentence":"请读取|"handoff_kind":"grok_guided"/);assert.deepEqual(counts(v),before);
});
test('duplicate posts and recreated manager preserve run, identity and credentials without retry',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [first]=await v.finish(),before=counts(v),scans=v.calls.scans,bytes=fs.readFileSync(v.service.entry.describe(first.target_member_id,v.room.id).file);
  v.manager.begin(message);await v.finish();const restored=new ConnectionAssist(v.service,{contextWaitMs:10});assert.equal(restored.begin(message)[0].id,first.id);assert.equal(restored.snapshotForMessage(message.id)[0].run_id,first.run_id);await restored.close();
  assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,scans);assert.deepEqual(fs.readFileSync(v.service.entry.describe(first.target_member_id,v.room.id).file),bytes);
});

test('secretary never calls a historical ready state connected without current attempt acceptance',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [initial]=await v.finish();
  const original=v.service.onboarding.state.bind(v.service.onboarding),before=counts(v);
  v.service.onboarding.state=input=>input.run_id===initial.run_id?{id:initial.run_id,room_id:v.room.id,provider:'doubao',member_id:initial.target_member_id,status:'ready',stage:'ready_automatic',local_verified:true,can_wake:true,ready_for_office:false,reused_connection:true,next_actions:[{operation:'native_desktop_connect'}]}:original(input);
  const state=v.manager.snapshotForMessage(message.id)[0];
  assert.equal(state.status,'needs_action');assert.equal(state.ready_for_office,false);assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.notEqual(state.action_kind,'ready');assert.doesNotMatch(state.summary,/已接通|已加入办公室/);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/"connection_ready":false/);assert.match(context,/"automatic_ready":false/);assert.deepEqual(counts(v),before);
});

test('failed Doubao native contact remains an actionable failure after the old MCP card is accepted',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [initial]=await v.finish();
  const card=JSON.parse(fs.readFileSync(v.service.entry.describe(initial.target_member_id,v.room.id).file,'utf8'));v.service.entry.accept(card);
  const state=v.manager.snapshotForMessage(message.id)[0];
  assert.equal(state.ready_for_office,false);assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.notEqual(state.status,'ready');assert.equal(state.action_kind,'native_connect');assert.equal(state.document_path,null);assert.match(await v.manager.prepareContext(message.id),/"connection_ready":false/);
});
test('revoked target credential remains revoked and fallback cannot quietly renew it',async t=>{
  const v=setup(t);let release;const gate=new Promise(resolve=>release=resolve);const oldConnector=v.service.onboarding.options.desktopConnector;v.service.onboarding.options.desktopConnector=async input=>{await gate;return oldConnector(input);};
  const message=v.message('连接豆包');v.manager.begin(message);for(let i=0;i<30&&!v.calls.scans;i++)await new Promise(resolve=>setTimeout(resolve,1));
  while(!v.service.store.db.prepare('SELECT id FROM chat_members WHERE adapter=? AND name<>?').get('mailbox',v.recipient.name))await new Promise(resolve=>setTimeout(resolve,1));
  const member=v.service.chat.store.members().find(value=>value.config.launch_provider==='doubao'),file=v.service.entry.describe(member.id,v.room.id).file,bytes=fs.readFileSync(file);v.service.entry.revoke(member.id,v.room.id);const credentials=counts(v).credentials;release();const [state]=await v.finish();
  assert.equal(state.stage,'awaiting_credential');assert.equal(state.action_kind,'reauthorize');assert.equal(state.local_verified,false);assert.equal(state.document_path,null);assert.equal(state.copy_sentence,'');assert.equal(counts(v).credentials,credentials);assert.deepEqual(fs.readFileSync(file),bytes);
});
for(const provider of ['grok-bot','doubao'])test(`already revoked ${provider} identity cannot be renewed by a new chat assistance request`,async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'已有同事',adapter:provider==='grok-bot'?'grok-bridge':'mailbox'});v.service.chat.join(v.room.id,member.id);
  v.service.chat.store.updateMember(member.id,{config:{...v.service.chat.store.member(member.id).config,launch_provider:provider}});
  const entry=v.service.entry.issue(member.id,v.room.id),bytes=fs.readFileSync(entry.file);v.service.entry.revoke(member.id,v.room.id);
  const before=counts(v),message=v.message(provider==='grok-bot'?'把 Grok Bot 拉进群':'连接豆包');v.manager.begin(message);const [state]=await v.finish(),after=counts(v);
  assert.equal(state.status,'needs_action');assert.equal(state.stage,'awaiting_credential');assert.equal(state.run_id,null);assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.match(state.error,/已撤销/);
  assert.equal(after.members,before.members);assert.equal(after.credentials,before.credentials);assert.equal(after.runs,before.runs);assert.equal(after.assists,before.assists+1);assert.deepEqual(fs.readFileSync(entry.file),bytes);
  assert.equal(v.calls.scans+v.calls.native.length+v.calls.desktop.length+v.calls.install,0);assert.equal(state.action_kind,'reauthorize');assert.equal(state.target_member_id,member.id);assert.equal(state.document_path,null);assert.equal(state.copy_sentence,'');assert.equal(state.recovery_action.target_member_id,member.id);
  const restored=new ConnectionAssist(v.service);restored.begin(message);await restored.close();assert.equal(v.calls.scans,0);assert.equal(counts(v).credentials,before.credentials);
});
test('interrupted assistance without a document reports interruption instead of perpetual preparation',async t=>{
  const v=setup(t),message=v.message('连接豆包'),assistId=id();
  v.service.store.db.prepare('INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,run_id,status,error,document_path,created,updated) VALUES(?,?,?,?,?,NULL,?,NULL,NULL,?,?)').run(assistId,v.room.id,message.id,v.recipient.id,'doubao','starting',now(),now());
  const restored=new ConnectionAssist(v.service),[state]=restored.snapshotForMessage(message.id);assert.equal(state.status,'interrupted');assert.match(state.summary,/已中断|失败/);assert.doesNotMatch(state.summary,/正在准备/);assert.equal(v.calls.scans,0);await restored.close();
});
test('unavailable selected provider receives a support action without a misleading window handoff',async t=>{
  const v=setup(t),message=v.message('连接 OpenCode');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.status,'needs_action');assert.equal(state.target_member_id,null);assert.equal(state.action_kind,'unsupported');assert.equal(state.document_path,null);assert.equal(state.copy_sentence,'');assert.equal(v.calls.native.length+v.calls.install+v.calls.desktop.length,0);
});
test('document scope and fixed path checks reject cross-room, tampered path and symlink',async t=>{
  const v=setup(t,{manualOnly:true}),message=v.message('连接豆包');v.manager.begin(message);const [state]=await v.finish();
  assert.throws(()=>v.manager.document(state.id,v.other.id),error=>error.code==='connection_assist_scope_mismatch');
  v.service.store.db.prepare('UPDATE connection_assists SET document_path=? WHERE id=?').run(path.join(v.root,'outside.md'),state.id);assert.throws(()=>v.manager.document(state.id,v.room.id),error=>error.code==='connection_assist_document_scope');
  v.service.store.db.prepare('UPDATE connection_assists SET document_path=? WHERE id=?').run(state.document_path,state.id);
  const outside=path.join(v.root,'outside.md');fs.writeFileSync(outside,'outside fixture');fs.unlinkSync(state.document_path);
  try{fs.symlinkSync(outside,state.document_path);}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Windows symlink privilege unavailable; tampered-path check executed');return;}throw error;}
  assert.throws(()=>v.manager.document(state.id,v.room.id),error=>error.code==='connection_assist_document_scope');
});
test('deleted room and cancelled source cannot create or expose another connection',async t=>{
  const v=setup(t),cancelled=v.message('连接豆包');v.service.chat.store.updateMessage(cancelled.id,{status:'cancelled'});assert.deepEqual(v.manager.begin(cancelled),[]);assert.equal(v.calls.scans,0);
  const message=v.message('连接 Grok');v.manager.begin(message);const [state]=await v.finish();v.service.chat.store.updateMessage(message.id,{status:'cancelled'});v.service.chat.store.deleteRoom(v.room.id);
  for(const read of [()=>v.manager.listRoom(v.room.id),()=>v.manager.snapshotForMessage(message.id),()=>v.manager.document(state.id,v.room.id),()=>v.manager.begin(message)])assert.throws(read,error=>error.code==='room_deleted');
});
test('leaving recipient hides its assist card without breaking room history and rejects document access',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [state]=await v.finish();v.service.chat.store.leave(v.room.id,v.recipient.id);
  assert.deepEqual(v.manager.listRoom(v.room.id),[]);assert.throws(()=>v.manager.document(state.id,v.room.id),error=>error.code==='not_in_room');
});
test('context waiting is bounded and close does not cause a second connection attempt',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),v=setup(t,{desktopGate:gate,contextWaitMs:5}),message=v.message('连接豆包');v.manager.begin(message);const started=Date.now(),context=await v.manager.prepareContext(message.id);assert.ok(Date.now()-started<1000);assert.match(context,/正在接入/);
  v.manager.stop();release();await v.manager.close();assert.equal(v.calls.desktop.length,1);assert.equal(v.calls.scans,1);assert.equal(v.manager.snapshotForMessage(message.id)[0].document_path,null);
});

test('Grok copy guidance contains the real existing Bot command without another identity or leaked credentials',async t=>{
  const v=setup(t),message=v.message('连接grok');v.manager.begin(message);const [card]=await v.finish(),entry=v.service.entry.describePrimary(card.target_member_id,v.room.id),secret=JSON.parse(fs.readFileSync(entry.file,'utf8')).secret;
  assert.equal(card.guidance.kind,'handshake');assert.equal(card.guidance.target_window,'已有 Grok Bot 对话');assert.deepEqual(card.guidance.scope,{room_id:v.room.id,target_member_id:card.target_member_id});
  assert.match(card.guidance.prompt,/先实际执行这份长期恢复入口/);assert.match(card.guidance.prompt,/enter.*--entry/);assert.ok(card.guidance.prompt.includes(entry.file));assert.match(card.guidance.prompt,/不需要创建群聊或新 Bot/);assert.ok(!JSON.stringify(card).includes(secret));
  const before=counts(v),revision=v.service.revision,scans=v.calls.scans,bytes=fs.readFileSync(entry.file);for(let i=0;i<3;i++)assert.deepEqual(v.manager.snapshotForMessage(message.id)[0].guidance,card.guidance);
  assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);assert.equal(v.calls.scans,scans);assert.deepEqual(fs.readFileSync(entry.file),bytes);
});

test('missing Grok discovery offers copyable tool and MCP checks without inventing an endpoint or issuing an entry',async t=>{
  const v=setup(t);v.service.launch.options.discover=()=>{v.calls.scans++;return {candidates:[]};};const before=counts(v),message=v.message('连接grok');v.manager.begin(message);const [card]=await v.finish();
  assert.equal(card.action_kind,'unsupported');assert.equal(card.target_member_id,null);assert.equal(card.guidance.kind,'check_capability');assert.deepEqual(card.guidance.scope,{room_id:v.room.id,target_member_id:null});assert.match(card.guidance.prompt,/本机命令工具、MCP/);assert.match(card.guidance.prompt,/不要猜测本机地址/);assert.doesNotMatch(card.guidance.prompt,/https?:\/\/|--entry|token=/);assert.equal(card.installation_guidance,null);
  assert.equal(counts(v).members,before.members);assert.equal(counts(v).credentials,before.credentials);assert.equal(v.calls.desktop.length+v.calls.install+v.calls.native.length,0);
});

test('an old fixed Grok route gets actionable capability guidance without copying or changing that route',async t=>{
  const v=setup(t),legacy=v.service.chat.addMember({name:'原群 Grok',adapter:'grok-bridge'}),backend=v.service.chat.addMember({name:'原群后台',adapter:'codex'});
  v.service.chat.join(v.other.id,legacy.id);v.service.chat.join(v.other.id,backend.id);v.service.chat.store.updateMember(legacy.id,{status:'ready',verified_at:now(),config:{launch_provider:'grok-bot'}});
  const entry=v.service.entry.issue(legacy.id,v.other.id),bytes=fs.readFileSync(entry.file),route=id();v.service.store.db.prepare("INSERT INTO launch_proxies(id,room_id,provider,name,backend_member_id,proxy_member_id,native_group_status,created,updated) VALUES(?,?,?,?,?,?,'pending',?,?)").run(route,v.other.id,'codex','原群连接',backend.id,legacy.id,now(),now());
  const before=counts(v),original=v.service.store.db.prepare('SELECT * FROM launch_proxies WHERE id=?').get(route),message=v.message('连接grok');v.manager.begin(message);const [card]=await v.finish();
  assert.equal(card.stage,'fixed_proxy_scope');assert.equal(card.action_kind,'unsupported');assert.equal(card.guidance.kind,'check_capability');assert.deepEqual(card.guidance.scope,{room_id:v.room.id,target_member_id:legacy.id});assert.match(card.guidance.prompt,/另一房间的固定群桥接/);assert.match(card.guidance.prompt,/保留原 Bot、原群路由/);assert.doesNotMatch(card.guidance.prompt,/--entry|https?:\/\//);assert.ok(!card.guidance.prompt.includes(entry.file));assert.equal(card.document_path,null);
  assert.deepEqual(v.service.store.db.prepare('SELECT * FROM launch_proxies WHERE id=?').get(route),original);assert.equal(v.service.chat.store.joined(v.room.id,legacy.id),false);assert.equal(counts(v).members,before.members);assert.equal(counts(v).credentials,before.credentials);assert.equal(v.calls.scans,0);assert.deepEqual(fs.readFileSync(entry.file),bytes);
});

for(const [provider,request,error,expected]of [['qwen-desktop','连接 Qwen','connect ECONNREFUSED 127.0.0.1','开启客户端连接'],['doubao','连接豆包','DOUBAO_NATIVE_PREPARATION_UNSUPPORTED_SOURCE','不兼容']])test(`${provider} failed native contact exposes distinct repair, install-update and handshake steps`,async t=>{
  const v=setup(t,{nativeError:error}),message=v.message(request);v.manager.begin(message);const [card]=await v.finish();
  assert.equal(card.action_kind,'native_connect');assert.equal(card.guidance.kind,'native_connect');assert.match(card.guidance.steps[0],new RegExp(expected));assert.match(card.guidance.prompt,/agentroom_chat_rooms/);assert.match(card.guidance.prompt,/agentroom_chat_inbox/);assert.match(card.guidance.note,/不会自动切换连接方式/);
  const install=card.installation_guidance;assert.equal(install.kind,'install_mcp');assert.match(install.target_window,/这台电脑文件/);assert.match(install.prompt,/安装或更新/);assert.match(install.prompt,/不覆盖其他 MCP/);assert.match(install.prompt,/云端工具/);assert.match(install.prompt,/回到 .* 的本人对话/);assert.deepEqual(install.scope,{room_id:v.room.id,target_member_id:card.target_member_id});assert.deepEqual(card.guidance.scope,install.scope);
  const entry=v.service.entry.describePrimary(card.target_member_id,v.room.id),bytes=fs.readFileSync(entry.file),secret=JSON.parse(bytes).secret,templates=path.join(v.data,'client-config','templates'),files=fs.readdirSync(templates).map(name=>path.join(templates,name)),times=files.map(file=>fs.statSync(file).mtimeMs),before=counts(v),revision=v.service.revision,mode=v.service.onboarding.row(card.run_id).connection_method;
  assert.ok(!JSON.stringify(card).includes(secret));assert.doesNotMatch(install.prompt,/https?:\/\//);for(let i=0;i<3;i++)assert.deepEqual(v.manager.snapshotForMessage(message.id)[0].installation_guidance,install);
  assert.equal(v.service.revision,revision);assert.deepEqual(counts(v),before);assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.deepEqual(files.map(file=>fs.statSync(file).mtimeMs),times);assert.equal(v.service.onboarding.row(card.run_id).connection_method,mode);assert.equal(mode,'native_desktop');assert.equal(card.ready_for_office,false);
  for(const file of files)fs.unlinkSync(file);assert.equal(v.manager.snapshotForMessage(message.id)[0].installation_guidance,null);assert.deepEqual(fs.readdirSync(templates),[],'polling never recreates missing MCP templates');
});

test('manual MCP guidance distinguishes first installation from an already loaded connection needing a fresh handshake',async t=>{
  const v=setup(t,{manualOnly:true}),first=v.message('连接豆包');v.manager.begin(first);const [initial]=await v.finish();assert.equal(initial.guidance.kind,'install_mcp');assert.match(initial.guidance.prompt,/安装或更新/);
  const entry=v.service.entry.describePrimary(initial.target_member_id,v.room.id),card=JSON.parse(fs.readFileSync(entry.file,'utf8'));v.service.entry.accept(card);const ready=v.manager.snapshotForMessage(first.id)[0];assert.equal(ready.ready_for_office,true);assert.equal(ready.guidance,null);assert.equal(ready.installation_guidance,null);
  v.service.chat.store.updateMember(initial.target_member_id,{status:'connection_failed',error:'fixture 原 MCP 已配置，但当前对话尚未重新加载'});
  v.service.store.db.prepare('UPDATE chat_resume_credentials SET last_seen=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),card.credential_id);
  await sleep(5);const message=v.message('连接豆包');v.manager.begin(message);const [pending]=v.manager.snapshotForMessage(message.id);await v.finish();const next=v.manager.snapshotForMessage(message.id)[0];assert.equal(next.target_member_id,initial.target_member_id);assert.equal(next.guidance.kind,'handshake');assert.match(next.guidance.note,/无需反复安装/);assert.match(next.guidance.prompt,/当前对话是否实际加载 AO 工具/);assert.equal(next.installation_guidance,null);assert.equal(next.ready_for_office,false);assert.equal(pending.target_member_id,initial.target_member_id);
});

test('a native request awaiting reconciliation suppresses both copy routes and all template regeneration',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [first]=await v.finish(),entry=v.service.entry.describePrimary(first.target_member_id,v.room.id),bytes=fs.readFileSync(entry.file),before=counts(v),revision=v.service.revision;
  const pending=v.message('等待核对的原问题');v.service.store.db.prepare("INSERT INTO desktop_message_runs(message_id,member_id,native_session_id,native_request_id,status,answer,error,created,updated) VALUES(?,?,?,?,'uncertain',NULL,?,?,?)").run(pending.id,first.target_member_id,'saved-session','saved-request','原生请求结果待核对',now(),now());
  const card=v.manager.snapshotForMessage(message.id)[0];assert.equal(card.action_kind,'native_connect');assert.equal(card.guidance,null);assert.equal(card.installation_guidance,null);assert.match(card.next_step,/先查看原消息/);assert.match(card.next_step,/不能通过更新 MCP/);assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);assert.deepEqual(fs.readFileSync(entry.file),bytes);
});
