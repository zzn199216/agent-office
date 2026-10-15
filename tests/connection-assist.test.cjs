'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {ConnectionAssist,parseConnectionProviders}=require('../src/connection-assist.cjs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id,now}=require('../src/util.cjs');

class HandshakeFixture extends EventEmitter{
  constructor(member,service,calls){super();this.member=member;this.service=service;this.calls=calls;}
  async status(){return {connected:true,signedIn:true};}
  async run(input){this.calls.push(input.request.prompt);const thread=input.discussion.thread_id||id();input.onBinding('bound',thread);input.onTurn(id());
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
    onboarding:{desktopConnector:async input=>{calls.desktop.push(input);if(options.desktopGate)await options.desktopGate;throw Error('fixture 本机接口不可用 https://localhost/mcp/private-token token=fixture-private-token');}},
    connectionAssist:{contextWaitMs:options.contextWaitMs??100}});
  service._localUrl='http://127.0.0.1:47831';
  const project=service.addProject({name:'assist fixture',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'办公室'}),other=service.chat.addRoom({project_id:project.id,title:'另一间'}),recipient=service.chat.addMember({name:'接入助手',adapter:'mailbox'});
  service.chat.join(room.id,recipient.id);service.chat.store.updateMember(recipient.id,{status:'ready',verified_at:now()});
  const manager=service.connectionAssist||new ConnectionAssist(service,{contextWaitMs:options.contextWaitMs??100});
  const message=(text,extra={})=>service.chat.store.post({room_id:room.id,sender_id:'user',to_member_id:recipient.id,text,idempotency_key:id(),...extra});
  const finish=async()=>{await Promise.all([...manager.jobs.values()]);return manager.listRoom(room.id);};
  t.after(async()=>{manager.stop();await service.close();await manager.close();const absolute=path.resolve(files.root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentroom-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return {...files,service,project,room,other,recipient,manager,calls,message,finish};
}
function counts(v){const db=v.service.store.db;return {members:db.prepare('SELECT count(*) n FROM chat_members').get().n,credentials:db.prepare('SELECT count(*) n FROM chat_resume_credentials').get().n,runs:db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,assists:db.prepare('SELECT count(*) n FROM connection_assists').get().n};}

test('parser accepts named imperative requests and keeps CLI identities separate',()=>{
  assert.deepEqual(parseConnectionProviders('把grok bot拉进群'),['grok-bot']);assert.deepEqual(parseConnectionProviders('那拉个豆包进来'),['doubao']);
  assert.deepEqual(parseConnectionProviders('请接入 Qwen Code 和 Qwen 桌面版，然后连接 Claude Code'),['qwen-code','qwen-desktop','claude-code']);
  assert.deepEqual(parseConnectionProviders('Please connect Grok and Doubao.'),['grok-bot','doubao']);
  assert.deepEqual(parseConnectionProviders('不要接入Qwen，只拉豆包进来'),['doubao']);
  assert.deepEqual(parseConnectionProviders('接入 Gemini CLI、Codex 和 Cherry Studio'),['gemini-cli','codex','cherry-studio']);
  assert.deepEqual(parseConnectionProviders('连接 qwen-code 和 claude-code'),['qwen-code','claude-code']);
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
  assert.equal(v.calls.native.length,1);assert.equal(v.calls.scans,1);assert.equal(v.calls.install,0);
  const row=v.service.store.db.prepare('SELECT install_client,install_runtime FROM onboarding_runs WHERE id=?').get(state.run_id);assert.equal(row.install_client,0);assert.equal(row.install_runtime,0);
  const context=await v.manager.prepareContext(message.id);assert.match(context,/已接通/);assert.doesNotMatch(context,/fixture-private-token/);
});
test('Grok fallback returns a copy sentence and owned document while bot-visible state excludes target credentials',async t=>{
  const v=setup(t),message=v.message('把grok bot拉进群');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.status,'needs_action');assert.equal(state.can_wake,false);assert.equal(state.local_verified,false);assert.ok(state.document_path);assert.match(state.copy_sentence,/请读取这台电脑上的接入文档/);assert.match(state.document_url,new RegExp('/api/connection-assists/'+state.id+'/document'));
  const document=v.manager.document(state.id,v.room.id);assert.match(document.filename,/grok-bot/);assert.match(document.text,/长期恢复入口/);assert.match(document.text,/不自动创建群聊/);assert.ok(!document.text.includes('fixture-private-token'));
  const context=await v.manager.prepareContext(message.id);assert.match(context,/逐字给用户/);assert.match(context,/copy_sentence/);assert.doesNotMatch(context,/fixture-private-token|\/mcp\/private-token|secret/);
  assert.equal(v.calls.native.length+v.calls.install,0);assert.equal(v.calls.desktop.length,1);
});
test('mailbox document is private and read-only polling never scans, issues credentials or generates templates again',async t=>{
  const v=setup(t),message=v.message('那拉个豆包进来');v.manager.begin(message);const [state]=await v.finish(),before=counts(v),scans=v.calls.scans,revision=v.service.revision;
  const cardFile=v.service.entry.describe(state.target_member_id,v.room.id).file,card=JSON.parse(fs.readFileSync(cardFile,'utf8')),bytes=fs.readFileSync(cardFile),doc=v.manager.document(state.id,v.room.id);
  assert.ok(!doc.text.includes(card.secret),'document points to the target private template without embedding its secret');assert.match(doc.text,/STDIO/);assert.match(doc.text,/Streamable HTTP/);
  const first=fs.statSync(state.document_path).mtimeMs;
  for(let i=0;i<4;i++){assert.ok(!JSON.stringify(v.manager.listRoom(v.room.id)).includes(card.secret));assert.ok(!(await v.manager.prepareContext(message.id)).includes(card.secret));v.manager.document(state.id,v.room.id);}
  assert.equal(v.calls.scans,scans);assert.deepEqual(counts(v),before);assert.equal(v.service.revision,revision);assert.deepEqual(fs.readFileSync(cardFile),bytes);assert.equal(fs.statSync(state.document_path).mtimeMs,first);
  assert.equal(state.local_verified,false);v.service.entry.accept(card);const [ready]=v.manager.snapshotForMessage(message.id);assert.equal(ready.local_verified,true);assert.equal(ready.status,'ready');assert.equal(ready.can_wake,false);assert.equal(ready.automatic_reply_verified,false);
});
test('duplicate posts and recreated manager preserve run, identity and credentials without retry',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [first]=await v.finish(),before=counts(v),scans=v.calls.scans,bytes=fs.readFileSync(v.service.entry.describe(first.target_member_id,v.room.id).file);
  v.manager.begin(message);await v.finish();const restored=new ConnectionAssist(v.service,{contextWaitMs:10});assert.equal(restored.begin(message)[0].id,first.id);assert.equal(restored.snapshotForMessage(message.id)[0].run_id,first.run_id);await restored.close();
  assert.deepEqual(counts(v),before);assert.equal(v.calls.scans,scans);assert.deepEqual(fs.readFileSync(v.service.entry.describe(first.target_member_id,v.room.id).file),bytes);
});
test('revoked target credential remains revoked and fallback cannot quietly renew it',async t=>{
  const v=setup(t);let release;const gate=new Promise(resolve=>release=resolve);const oldConnector=v.service.onboarding.options.desktopConnector;v.service.onboarding.options.desktopConnector=async input=>{await gate;return oldConnector(input);};
  const message=v.message('连接豆包');v.manager.begin(message);for(let i=0;i<30&&!v.calls.scans;i++)await new Promise(resolve=>setTimeout(resolve,1));
  while(!v.service.store.db.prepare('SELECT id FROM chat_members WHERE adapter=? AND name<>?').get('mailbox',v.recipient.name))await new Promise(resolve=>setTimeout(resolve,1));
  const member=v.service.chat.store.members().find(value=>value.config.launch_provider==='doubao'),file=v.service.entry.describe(member.id,v.room.id).file,bytes=fs.readFileSync(file);v.service.entry.revoke(member.id,v.room.id);const credentials=counts(v).credentials;release();const [state]=await v.finish();
  assert.equal(state.stage,'awaiting_credential');assert.equal(state.local_verified,false);assert.match(v.manager.document(state.id,v.room.id).text,/已撤销/);assert.equal(counts(v).credentials,credentials);assert.deepEqual(fs.readFileSync(file),bytes);
});
for(const provider of ['grok-bot','doubao'])test(`already revoked ${provider} identity cannot be renewed by a new chat assistance request`,async t=>{
  const v=setup(t),member=v.service.chat.addMember({name:'已有同事',adapter:provider==='grok-bot'?'grok-bridge':'mailbox'});v.service.chat.join(v.room.id,member.id);
  v.service.chat.store.updateMember(member.id,{config:{...v.service.chat.store.member(member.id).config,launch_provider:provider}});
  const entry=v.service.entry.issue(member.id,v.room.id),bytes=fs.readFileSync(entry.file);v.service.entry.revoke(member.id,v.room.id);
  const before=counts(v),message=v.message(provider==='grok-bot'?'把 Grok Bot 拉进群':'连接豆包');v.manager.begin(message);const [state]=await v.finish(),after=counts(v);
  assert.equal(state.status,'needs_action');assert.equal(state.stage,'awaiting_credential');assert.equal(state.run_id,null);assert.equal(state.local_verified,false);assert.equal(state.can_wake,false);assert.match(state.error,/已撤销/);
  assert.equal(after.members,before.members);assert.equal(after.credentials,before.credentials);assert.equal(after.runs,before.runs);assert.equal(after.assists,before.assists+1);assert.deepEqual(fs.readFileSync(entry.file),bytes);
  assert.equal(v.calls.scans+v.calls.native.length+v.calls.desktop.length+v.calls.install,0);assert.match(v.manager.document(state.id,v.room.id).text,/明确重新授权/);
  const restored=new ConnectionAssist(v.service);restored.begin(message);await restored.close();assert.equal(v.calls.scans,0);assert.equal(counts(v).credentials,before.credentials);
});
test('interrupted assistance without a document reports interruption instead of perpetual preparation',async t=>{
  const v=setup(t),message=v.message('连接豆包'),assistId=id();
  v.service.store.db.prepare('INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,run_id,status,error,document_path,created,updated) VALUES(?,?,?,?,?,NULL,?,NULL,NULL,?,?)').run(assistId,v.room.id,message.id,v.recipient.id,'doubao','starting',now(),now());
  const restored=new ConnectionAssist(v.service),[state]=restored.snapshotForMessage(message.id);assert.equal(state.status,'interrupted');assert.match(state.summary,/已中断|失败/);assert.doesNotMatch(state.summary,/正在准备/);assert.equal(v.calls.scans,0);await restored.close();
});
test('unavailable selected provider receives a truthful generic document without fabricated identity or configuration',async t=>{
  const v=setup(t),message=v.message('连接 OpenCode');v.manager.begin(message);const [state]=await v.finish();
  assert.equal(state.status,'needs_action');assert.equal(state.target_member_id,null);assert.ok(state.document_path);const doc=v.manager.document(state.id,v.room.id);assert.match(doc.text,/安装、登录或本机工具授权/);assert.doesNotMatch(doc.text,/mcpServers|127\.0\.0\.1|credential_id/);assert.equal(v.calls.native.length+v.calls.install+v.calls.desktop.length,0);
});
test('document scope and fixed path checks reject cross-room, tampered path and symlink',async t=>{
  const v=setup(t),message=v.message('连接豆包');v.manager.begin(message);const [state]=await v.finish();
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
