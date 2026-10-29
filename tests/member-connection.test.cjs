'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {STATES,SHORT_NAMES,present}=require('../src/member-connection.cjs');

const PROVIDERS=Object.keys(SHORT_NAMES);
// Every stage literal the backend can emit, read from source so a new stage
// cannot be added without a presentation.
function backendStages(){
  const files=['onboarding.cjs','onboarding-verification.cjs','connection-assist.cjs','connection-target.cjs'].map(file=>fs.readFileSync(path.join(__dirname,'..','src',file),'utf8')).join('\n');
  const found=new Set();
  for(const match of files.matchAll(/stage\s*[:=]\s*'([a-z_]+)'/g))found.add(match[1]);
  for(const match of files.matchAll(/stage==='([a-z_]+)'/g))found.add(match[1]);
  return [...found].sort();
}
const STATUSES=['not_started','running','needs_action','ready','error','interrupted','cancelled'];
const width=text=>[...text].reduce((sum,ch)=>sum+(/[\u0000-\u00ff]/.test(ch)?1:2),0);
const BANNED=/保留|沿用|没有自动重试|未宣称|不会生成|原生会话|本人对话|握手|兼容 MCP|群桥接|协议/;

test('every backend stage and status maps to one of five states with a short headline',()=>{
  const stages=backendStages();
  assert.ok(stages.length>=15,`expected the backend stage catalogue, got ${stages.length}`);
  for(const provider of PROVIDERS)for(const stage of [...stages,null])for(const status of STATUSES){
    const view=present({provider,stage,status,next_actions:[]});
    const label=`${provider}/${stage}/${status}`;
    assert.ok(STATES.includes(view.state),label);
    assert.equal(typeof view.headline,'string',label);
    assert.ok(view.headline.length>0&&width(view.headline)<=48,`${label}: ${view.headline}`);
    assert.doesNotMatch(view.headline,BANNED,label);
    for(const action of [view.primary,view.secondary].filter(Boolean)){
      assert.equal(typeof action.operation,'string',label);
      assert.ok(action.label.length>0&&width(action.label)<=24,`${label}: ${action.label}`);
      assert.doesNotMatch(action.label,BANNED,label);
    }
    // Only finished or in-flight connections may lack a primary action.
    if(!['connected','auto'].includes(view.state)&&!view.busy)assert.ok(view.primary,`${label} has no way forward`);
  }
});

test('ready connections are connected or auto, and only wake-capable desktop clients offer automatic wake',()=>{
  assert.equal(present({provider:'codex',status:'ready',stage:'ready_automatic',ready_for_office:true,can_wake:true}).state,'auto');
  const doubao=present({provider:'doubao',status:'ready',stage:'ready_mailbox',local_verified:true,can_wake:false});
  assert.equal(doubao.state,'connected');assert.equal(doubao.primary,null);assert.equal(doubao.secondary.operation,'enable_wake');
  assert.equal(present({provider:'claude-desktop',status:'ready',stage:'ready_mailbox',local_verified:true}).secondary,null);
});

test('the four tested dead ends each get a direct action',()=>{
  // Qwen/Doubao not reachable: one button that opens and connects.
  const qwen=present({provider:'qwen-desktop',status:'needs_action',stage:'awaiting_native_desktop',next_actions:[{operation:'open_native_client'},{operation:'native_desktop_connect'},{operation:'manual_mcp',target_member_id:'m1'}]});
  assert.equal(qwen.primary.operation,'manual_mcp');assert.equal(qwen.primary.target_member_id,'m1');assert.equal(qwen.secondary.operation,'native_connect');
  assert.equal(present({provider:'qwen-desktop',status:'needs_action',stage:'awaiting_native_desktop',next_actions:[{operation:'native_desktop_connect'}]}).primary.operation,'native_connect');
  // Grok bound to another room: go there or create a new member.
  const grok=present({provider:'grok-bot',status:'needs_action',stage:'fixed_proxy_scope',next_actions:[{operation:'open_fixed_room',target_member_id:'g1'}]});
  assert.equal(grok.state,'attention');assert.equal(grok.primary.operation,'open_fixed_room');assert.equal(grok.secondary.operation,'new_member');
  // Revoked Claude: reauthorize directly.
  const claude=present({provider:'claude-desktop',status:'needs_action',stage:'awaiting_credential',next_actions:[{operation:'reauthorize',target_member_id:'c1'}]});
  assert.equal(claude.primary.operation,'reauthorize');assert.equal(claude.primary.target_member_id,'c1');
  // Client running without the debug port: restart offer.
  const running=present({provider:'doubao',status:'needs_action',stage:'awaiting_native_desktop',error_code:'desktop_client_restart_required',next_actions:[{operation:'open_native_client'}]});
  assert.equal(running.state,'attention');assert.equal(running.primary.operation,'open_native_client');assert.match(running.primary.label,/重启/);
});

test('Codex protection overrides readiness and never offers a login',()=>{
  const view=present({provider:'codex',status:'ready',stage:'connection_repair_required',ready_for_office:true,can_wake:true});
  assert.equal(view.state,'attention');assert.equal(view.primary.operation,'show_connection_repair');
  assert.equal(present({provider:'codex',status:'needs_action',stage:'awaiting_auth',next_actions:[{operation:'retry'}]}).primary.operation,'retry');
});

test('presentation is projection only: input snapshots are not mutated',()=>{
  const input={provider:'doubao',status:'needs_action',stage:'awaiting_handshake',next_actions:[{operation:'copy_handshake_prompt'}]};
  const before=JSON.stringify(input);present(input);assert.equal(JSON.stringify(input),before);
});

test('new Doubao setup requires automatic connection and does not report mailbox readiness',async t=>{
  const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('No real client');},launch:{discover:()=>({candidates:[{id:'doubao',provider:'doubao',name:'豆包',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}]})}});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  const project=service.addProject({name:'automatic',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'room'});
  const job=service.onboarding.start({provider:'doubao',room_id:room.id});await Promise.all([...service.onboarding.jobs.values()]);
  const state=service.onboarding.state({run_id:job.id});assert.equal(state.connection_method,'native_desktop');assert.equal(state.can_wake,false);assert.equal(state.ready_for_office,false);
  assert.ok(state.next_actions.some(a=>a.operation==='open_native_client'));
});

test('explicit MCP keeps config-first setup and an existing automatic member keeps its route',async t=>{
  const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('external requests prohibited');},
    launch:{discover:()=>({candidates:['qwen-desktop','doubao'].map(provider=>({id:provider,provider,name:provider,adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}))})}});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  const project=service.addProject({name:'defaults',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'room'});
  for(const provider of ['doubao','qwen-desktop']){
    const job=service.onboarding.start({provider,room_id:room.id,connection_method:'manual_mcp'});await Promise.all([...service.onboarding.jobs.values()]);
    const state=service.onboarding.state({run_id:job.id});
    assert.equal(state.connection_method,'manual_mcp',provider);
    assert.equal(state.presentation.state,'waiting');
    assert.equal(state.presentation.primary.operation,'copy_setup');
    assert.equal(state.presentation.secondary,null);
    assert.doesNotMatch(state.presentation.headline,/ 豆包|豆包 /);
    if(provider==='doubao'){
      service._localUrl='http://127.0.0.1:47831';const guide=service.chat.setup(state.member_id,room.id).client;
      assert.equal(guide.kind,'http_fields');assert.match(guide.copy,/^http:\/\/127\.0\.0\.1:47831\/mcp\//);
      assert.match(guide.bootstrap,/本地电脑/);assert.match(guide.bootstrap,/连接器菜单勾选 Agent Office/);assert.doesNotMatch(guide.bootstrap,/127\.0\.0\.1|\/mcp\//);
      assert.match(guide.steps.join('\n'),/服务器 URL/);assert.match(guide.steps.join('\n'),/包含的操作/);assert.match(guide.steps.join('\n'),/在对话中试用/);
      assert.equal(service.onboarding.state({run_id:job.id}).ready_for_office,false);
    }
  }
  const member=service.chat.addMember({name:'existing doubao',adapter:'mailbox'});
  service.chat.store.updateMember(member.id,{config:{launch_provider:'doubao',desktop_delivery_mode:'native_desktop'}});service.chat.join(room.id,member.id);
  const other=service.chat.addRoom({project_id:project.id,title:'other'});
  const job=service.onboarding.start({provider:'doubao',room_id:other.id,target_member_id:member.id});await Promise.all([...service.onboarding.jobs.values()]);
  assert.equal(service.onboarding.state({run_id:job.id}).connection_method,'native_desktop');
});

test('an MCP member gets the MCP config guide, the dialog gets the same presentation, and new_member never reuses a person',async t=>{
  const {RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('external requests prohibited');},
    launch:{discover:()=>({candidates:['doubao'].map(provider=>({id:provider,provider,name:provider,adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}))})}});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  service._localUrl='http://127.0.0.1:47831';
  const project=service.addProject({name:'guide',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'room'});
  const job=service.onboarding.start({provider:'doubao',room_id:room.id,connection_method:'manual_mcp'});await Promise.all([...service.onboarding.jobs.values()]);
  const state=service.onboarding.state({run_id:job.id}),setup=service.chat.setup(state.member_id,room.id);
  assert.equal(setup.client.kind,'http_fields');assert.match(setup.client.copy,/^http:\/\/127\.0\.0\.1:47831\/mcp\//);assert.ok(setup.client.bootstrap.length>0);
  assert.deepEqual(setup.presentation,state.presentation);
  assert.throws(()=>service.onboarding.start({provider:'doubao',room_id:room.id,new_member:true,target_member_id:state.member_id}),error=>error.code==='onboarding_target_conflict');
  assert.throws(()=>service.onboarding.start({provider:'doubao',room_id:room.id,new_member:true}),error=>error.code==='onboarding_member_exists');
  // In another room, a normal request reuses the person; an explicit new member does not.
  const other=service.chat.addRoom({project_id:project.id,title:'other'});
  const separate=service.onboarding.start({provider:'doubao',room_id:other.id,new_member:true});await Promise.all([...service.onboarding.jobs.values()]);
  const created=service.onboarding.state({run_id:separate.id});
  assert.ok(created.member_id);assert.notEqual(created.member_id,state.member_id);
  assert.notEqual(service.chat.store.member(created.member_id).name,service.chat.store.member(state.member_id).name);
});

test('Claude manual setup offers one complete copy action at each handoff stage',()=>{
  for(const stage of ['awaiting_import','awaiting_handshake','awaiting_reload']){
    const view=present({provider:'claude-desktop',status:'needs_action',stage});
    assert.equal(view.primary.operation,'copy_setup');assert.equal(view.primary.label,'复制接入内容');assert.equal(view.secondary,null);
  }
});
