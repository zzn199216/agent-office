'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RoomService } = require('../src/service.cjs');
const { LaunchManager } = require('../src/launch.cjs');
const { createServer } = require('../src/http.cjs');
const { toolCall } = require('../src/mcp.cjs');
const { assertEntryScope } = require('../src/entry.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');
const { id, sleep } = require('../src/util.cjs');

// These are local protocol fixtures, not native Claude/Grok/model acceptance.
// Native readiness depends on an actual issued invitation operation in SQLite,
// and proxy readiness depends on presenting its real fixture resume card.
class NativeFixture extends EventEmitter {
  constructor(member, service) { super(); this.member = member; this.service = service; this.threads = new Map(); this.calls = []; }
  async status() { return { connected: true, signedIn: true, fixture: true }; }
  async run(input) {
    let thread = this.threads.get(input.discussion.id);
    if (!thread) { thread = input.discussion.thread_id || id(); this.threads.set(input.discussion.id, thread); }
    if (input.discussion.thread_id) assert.equal(input.discussion.thread_id, thread);
    else { input.onBinding('creating'); input.onBinding('bound', thread); }
    const handshake = input.request.prompt.startsWith('请完成聊天室成员的真实接入握手');
    this.calls.push({ thread, handshake, request: input.request.id, prompt: input.request.prompt });
    input.onTurn(id()); await sleep(8);
    if (handshake) {
      const invite = input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);
      assert.ok(invite); this.service.chat.completeInvite(invite[1], invite[2], this.member.id);
      return { threadId: thread, turnId: id(), answer: '已加入聊天室' };
    }
    const message = this.service.chat.store.message(input.request.id);
    return { threadId: thread, turnId: id(), answer: `${this.member.name}核实：${message.text}` };
  }
  async close() {}
}
function catalog(overrides = []) {
  return { candidates: overrides.length ? overrides : [
    { id: 'codex', provider: 'codex', name: 'Codex', adapter: 'codex', installed: true, running: true, executable: process.execPath, executable_args: [], capabilities: { automatic_launch: true } },
    { id: 'claude-code', provider: 'claude-code', name: 'Claude Code', adapter: 'claude-code', installed: true, running: false, executable: process.execPath, executable_args: [], capabilities: { automatic_launch: true } },
    { id: 'doubao', provider: 'doubao', name: '豆包', adapter: 'mailbox', installed: true, running: true, executable: 'unavailable-fixture-provider', capabilities: { automatic_launch: false }, setup_note: '需要官方接口' }
  ] };
}
async function until(predicate, detail = 'transition', timeout = 4000) {
  const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return; await sleep(10); }
  assert.fail(`timed out: ${detail}`);
}
function setup(t, overrides = {}) {
  const f = fixture(), clients = new Map(), installations = []; let service, scans = 0;
  const scan = catalog(overrides.candidates);
  for (const candidate of scan.candidates) if (['codex', 'claude-code'].includes(candidate.provider)) {
    if (candidate.provider === 'claude-code') {
      const cli = path.join(f.root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'metadata-only fixture; never executed');
      candidate.executable = process.execPath; candidate.executable_args = [cli];
    } else {
      candidate.executable = path.join(f.root, 'codex.exe'); candidate.executable_args = [];
      fs.writeFileSync(candidate.executable, 'metadata-only native fixture; never executed');
    }
  }
  const options = {
    codex: new FakeCodex(), vault: new FakeVault(),
    ...(overrides.desktop ? { desktop: overrides.desktop } : {}),
    chat: { clientFactory(member) { const client = new NativeFixture(member, service); clients.set(member.id, client); return client; } },
    launch: { discover: () => { scans++; return scan; }, installer: async input => { installations.push(input); return { status: 'installed', installed: true, connected: false, needs_reload: true, fixture: true }; } }
  };
  service = new RoomService(f.data, options);
  assert.ok(service.launch instanceof LaunchManager, 'RoomService must construct the real launch manager');
  t.after(async () => {
    await service.launch.close(); await service.close();
    const target = path.resolve(f.root);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.match(path.basename(target), /^agentroom-test-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const project = service.addProject({ name: '自动接入协议项目', path: f.project });
  const room = service.chat.addRoom({ title: '自动协作群', project_id: project.id });
  return { ...f, service, room, project, clients, installations, catalog: scan, providers: scan.candidates.filter(candidate => candidate.capabilities.automatic_launch).map(candidate => candidate.provider), get scans() { return scans; } };
}
async function prepared(v, input = {}) {
  const start = (await v.service.launch.prepare({ room_id: v.room.id, providers: v.providers, ...input }));
  await Promise.all([...v.service.launch.jobs.values()]);
  await until(() => !v.service.chat.active.size, 'native fixture handshakes');
  return v.service.launch.state({ session_id: start.id });
}
function proxyCard(v, proxy) { return JSON.parse(fs.readFileSync(v.service.entry.issue(proxy.proxy_member_id, proxy.room_id).file, 'utf8')); }
function acceptProxy(v, proxy) { const card = proxyCard(v, proxy); v.service.entry.accept(card); return card; }
async function nativeMember(v, name) {
  const member = v.service.chat.addMember({ name, adapter: 'codex' });
  v.service.chat.join(v.room.id, member.id); await v.service.chat.connect(member.id, v.room.id);
  await until(() => v.service.chat.store.member(member.id).status === 'ready' && !v.service.chat.active.has(member.id));
  return member;
}

test('explicit mirror group intent is shared by setup tools and durable handoff, existing group wins', async t => {
  const v=setup(t), state=await prepared(v,{group_name:'我的手机办公室'});
  assert.equal(state.group_name,'我的手机办公室');
  assert.match(fs.readFileSync(state.handoff_file,'utf8'),/明确授权新建镜像群/);
  const p=state.proxies[0];
  v.service.launch.report({session_id:state.id,proxy_id:p.id,name:p.name,bot_ref:'real-bot',group_ref:'real-group',joined:true});
  v.service.launch.handoff(state.id);
  const text=fs.readFileSync(state.handoff_file,'utf8');assert.match(text,/已经绑定实际群 real-group/);assert.doesNotMatch(text,/明确授权新建镜像群/);
  const added=await prepared(v,{providers:['doubao'],group_name:'不应重复创建'});
  const addText=fs.readFileSync(added.handoff_file,'utf8');assert.match(addText,/已经绑定实际群 real-group/);assert.doesNotMatch(addText,/明确授权新建镜像群/);
});

test('AO dispatch requires a participating Grok bridge and never queues an unwakeable mailbox', async t => {
  const v=setup(t), state=await prepared(v,{group_name:'手机办公室'});
  const g=v.service.chat.addMember({name:'Grok',adapter:'grok-bridge'});
  assert.throws(()=>v.service.launch.dispatch({session_id:state.id,member_id:g.id}),{code:'not_in_room'});
  v.service.chat.join(v.room.id,g.id);
  const before=v.service.chat.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n;
  assert.equal(v.service.launch.dispatch({session_id:state.id,member_id:g.id}).dispatch.status,'needs_grok_activation');
  assert.equal(v.service.chat.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n,before);
  assert.throws(()=>v.service.launch.dispatch({session_id:state.id,member_id:state.proxies[0].backend_member_id}),{code:'grok_bridge_required'});
});

test('an existing group requires fresh reports for each update and dispatch survives closing the page',async t=>{
  const v=setup(t),first=await prepared(v,{providers:['codex'],group_name:'手机办公室'}),proxy=first.proxies[0];
  v.service.launch.report({session_id:first.id,proxy_id:proxy.id,name:proxy.name,bot_ref:'native-codex',group_ref:'native-room',joined:true});
  const bridge=v.service.chat.addMember({name:'Grok',adapter:'grok-bridge'});v.service.chat.join(v.room.id,bridge.id);
  const capability=v.service.chat.deliveryCapability.bind(v.service.chat);
  v.service.chat.deliveryCapability=m=>(typeof m==='string'?m:m.id)===bridge.id?{can_notify:true,notification_eligible:false}:capability(m);
  const update=await prepared(v,{providers:['codex'],group_name:'手机办公室',dispatch:true,dispatch_member_id:bridge.id});
  assert.equal(update.group_operation.status,'prepared');assert.equal(update.proxies[0].native_group_ref,'native-room');assert.notEqual(update.status,'host_reported');
  v.service.launch.dispatchPending();v.service.launch.dispatchPending();
  const sent=v.service.launch.state({session_id:update.id});assert.equal(sent.group_operation.status,'pending');assert.ok(sent.group_operation.message_id);
  assert.equal(v.service.store.db.prepare("SELECT count(*) n FROM chat_messages WHERE idempotency_key=?").get('mirror:'+update.id).n,1);
  v.service.chat.store.updateMessage(sent.group_operation.message_id,{status:'answered'});
  assert.equal(v.service.launch.state({session_id:update.id}).group_operation.status,'needs_review','a Bot answer without the native operation report is not success');
  assert.equal((await v.service.launch.prepare({room_id:v.room.id,providers:['codex'],group_name:'我的手机办公室',dispatch:true})).id,update.id,'an interim Bot reply must not allow a duplicate native operation');
  v.service.launch.report({session_id:first.id,proxy_id:proxy.id,name:proxy.name,bot_ref:'native-codex',group_ref:'native-room',joined:true});
  assert.equal(v.service.launch.state({session_id:update.id}).group_operation.status,'needs_review','late reports for an earlier request must not complete this update');
  const done=v.service.launch.report({session_id:update.id,proxy_id:proxy.id,name:proxy.name,bot_ref:'native-codex',group_ref:'native-room',joined:true});
  assert.equal(done.group_operation.status,'reported');assert.deepEqual(done.group_operation.reported_proxy_ids,[proxy.id]);
});

test('AO group dispatch is idempotent and a notification receipt is not group success', async t => {
  const v=setup(t), state=await prepared(v,{group_name:'手机办公室'});
  const g=v.service.chat.addMember({name:'Grok',adapter:'grok-bridge'});v.service.chat.join(v.room.id,g.id);
  const capability=v.service.chat.deliveryCapability.bind(v.service.chat);
  v.service.chat.deliveryCapability=m=>(typeof m==='string'?m:m.id)===g.id?{can_notify:true,notification_eligible:false}:capability(m);
  const a=v.service.launch.dispatch({session_id:state.id,member_id:g.id}),b=v.service.launch.dispatch({session_id:state.id,member_id:g.id});
  assert.equal(a.dispatch.message_id,b.dispatch.message_id);assert.equal(a.dispatch.status,'queued');assert.equal(a.status,'awaiting_grok');
  assert.ok(a.proxies.every(p=>!p.native_group_ref));
  const repeated=await v.service.launch.prepare({room_id:v.room.id,providers:state.selected_providers,group_name:'手机办公室',dispatch:true});
  assert.equal(repeated.id,state.id,'pending native creation must not be submitted twice');
  await assert.rejects(v.service.launch.prepare({room_id:v.room.id,providers:['codex'],group_name:'手机办公室',dispatch:true}),{code:'group_operation_pending'});
});

test('native Doubao in another room uses its automatic session rather than a room MCP handshake',async t=>{
  const candidate={id:'doubao',provider:'doubao',name:'豆包',adapter:'mailbox',installed:true,running:true,capabilities:{mcp_prepare:true}};
  const v=setup(t,{candidates:[candidate],desktop:{serverName:null,driverFactory:row=>({closed:false,async initialize(){return {nativeChatId:row.native_session_id||'fixture-owned-doubao',detached:true};},close(){this.closed=true;}})}});
  const member=v.service.chat.addMember({name:'豆包',adapter:'mailbox'});
  v.service.chat.store.updateMember(member.id,{config:{launch_provider:'doubao'}});
  v.service.chat.join(v.room.id,member.id);
  await v.service.desktop.connect({member_id:member.id,room_id:v.room.id,provider:'doubao'});
  // Existing verified colleague is the precondition; the real adapter above
  // supplies automatic delivery, independently of any room MCP credential.
  v.service.chat.store.updateMember(member.id,{status:'ready',verified_at:new Date().toISOString()});
  const second=v.service.chat.addRoom({title:'Native second room',project_id:v.project.id});
  const ready=await prepared(v,{room_id:second.id,providers:['doubao'],group_name:'Native second group'});
  const proxy=ready.proxies[0];
  assert.equal(proxy.backend_member_id,member.id);assert.equal(proxy.local_verified,true);assert.equal(proxy.can_wake,true);
  assert.equal(proxy.response_mode,'managed_native');assert.deepEqual(ready.selected_handshakes,[]);assert.equal(ready.status,'awaiting_grok');
  assert.notEqual(v.service.entry.describe(member.id,second.id).status,'active','room-scoped MCP credentials are not the native transport');
  v.service.desktop.clients.get(member.id).closed=true;
  const offline=v.service.launch.state({session_id:ready.id});
  assert.equal(offline.proxies[0].local_verified,false);assert.equal(offline.status,'needs_setup');assert.deepEqual(offline.selected_handshakes,[]);
  assert.doesNotMatch(offline.proxies[0].reason,/MCP|领取|本人窗口/);
  assert.throws(()=>v.service.launch.dispatch({session_id:ready.id,member_id:'unused-bridge'}),{code:'group_members_not_ready'});
});

test('reusing a Grok Bot in a second room retains both exact group-to-entry routes',async t=>{
  const v=setup(t),first=await prepared(v,{providers:['codex'],group_name:'First'}),a=first.proxies[0];
  v.service.launch.report({session_id:first.id,proxy_id:a.id,name:a.name,bot_ref:'shared-native-codex',group_ref:'group-one',joined:true});
  const other=v.service.chat.addRoom({project_id:v.project.id,title:'Second'}),second=await prepared(v,{room_id:other.id,providers:['codex'],group_name:'Second'}),b=second.proxies[0];
  assert.equal(a.backend_member_id,b.backend_member_id);assert.notEqual(a.proxy_member_id,b.proxy_member_id);
  assert.match(fs.readFileSync(second.handoff_file,'utf8'),/shared-native-codex/);
  v.service.launch.report({session_id:second.id,proxy_id:b.id,name:b.name,bot_ref:'shared-native-codex',group_ref:'group-two',joined:true});
  for(const proxy of [a,b]){
    const role=fs.readFileSync(v.service.launch.role(v.service.store.db.prepare('SELECT * FROM launch_proxies WHERE id=?').get(proxy.id)),'utf8');
    assert.match(role,/group-one/);assert.match(role,/group-two/);assert.match(role,new RegExp(a.proxy_member_id));assert.match(role,new RegExp(b.proxy_member_id));assert.match(role,/不能按群名或最后活跃房间猜测/);
  }
  assert.equal(v.service.launch.state({session_id:first.id}).proxies[0].native_group_ref,'group-one');
});
for(const denied of [false,true])test(`AO mirror dispatch checks cold saved notification credentials once, denied=${denied}`,async t=>{
  const v=setup(t),state=await prepared(v,{providers:['codex'],group_name:'恢复后的群'});
  let unlocks=0,posts=0;v.service.fetch=async()=>{posts++;return {ok:true,json:async()=>({success:true})};};
  const g=v.service.chat.addMember({name:'Cold Grok',adapter:'grok-bridge'});v.service.chat.join(v.room.id,g.id);
  v.service.chat.store.updateMember(g.id,{status:'ready',verified_at:new Date().toISOString(),config:{webhook_enabled:true}});
  const vault=new (require('../src/vault.cjs').Vault)(path.join(v.data,'members',g.id),{platform:'win32',dpapi:()=>{unlocks++;if(denied)throw Error('fixture unlock denied');return JSON.stringify({url:'https://api2.cursor.sh/automations/webhook/cold-mirror-fixture',key:'fixture-only-secret'});}});
  fs.mkdirSync(path.dirname(vault.file),{recursive:true});fs.writeFileSync(vault.file,JSON.stringify({mode:'dpapi',value:'fixture-ciphertext'}));
  v.service.chat.memberVaults.set(g.id,{vault,stamp:v.service.chat.memberVaultStamp(vault.file)});
  assert.equal(v.service.chat.deliveryCapability(g.id).can_notify,false);assert.equal(unlocks,0);
  const input={session_id:state.id,member_id:g.id};
  if(denied){assert.throws(()=>v.service.launch.dispatch(input),{code:'vault_unavailable'});assert.equal(v.service.chat.store.db.prepare('SELECT count(*) AS n FROM chat_messages WHERE to_member_id=?').get(g.id).n,0);assert.equal(posts,0);}
  else {const first=v.service.launch.dispatch(input);assert.equal(first.dispatch.status,'queued');const second=v.service.launch.dispatch(input);assert.equal(first.dispatch.message_id,second.dispatch.message_id);await until(()=>v.service.chat.store.notification(first.dispatch.message_id)?.status==='accepted');assert.equal(posts,1);}
  assert.equal(unlocks,1);
});
function environment(t, values = {}) {
  const keys = ['AGENTROOM_SETUP_MODE', 'AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER', 'AGENTROOM_PROXY_ID'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function apiFor(t, service, scope) {
  const token = id(), server = createServer(service, { token, port: 0 });
  const port = await server.listen(); t.after(() => server.close());
  return async (route, input) => {
    if (scope) assertEntryScope({ store: service.store, chat: service.chat.store, runtime: service.runtime, resume: service.resume }, scope, route, input);
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.status = response.status; error.code = result.code; throw error; }
    return result;
  };
}

test('a selected setup prepares managed backends without treating Grok role documents as membership', async t => {
  const v = setup(t), state = await prepared(v);
  assert.equal(state.status, 'awaiting_grok', state.error || 'expected completed local preparation'); assert.equal(state.proxies.length, 2); assert.equal(state.grok_verified, false);
  assert.deepEqual(state.proxies.map(p => p.provider).sort(), ['claude-code', 'codex']);
  for (const proxy of state.proxies) {
    assert.equal(proxy.local_verified, true); assert.equal(proxy.status, 'ready_local'); assert.equal(proxy.native_group_status, 'pending'); assert.equal(proxy.grok_verified, false);
    assert.equal(v.service.chat.store.member(proxy.proxy_member_id).verified_at, null);
    assert.equal(v.service.chat.store.member(proxy.backend_member_id).status, 'ready');
    const card = proxyCard(v, proxy); assert.equal(v.service.resume.credential(card.credential_id).status, 'pending');
    assert.equal(v.clients.get(proxy.backend_member_id).calls.filter(c => c.handshake).length, 1);
    const role = path.join(v.data, 'launch', v.room.id, `role-${proxy.id}.md`); assert.match(fs.readFileSync(role, 'utf8'), new RegExp(proxy.name));
    const prefix = v.service.chat.store.member(proxy.backend_member_id).config.executable_args;
    assert.equal(prefix.length, proxy.provider === 'codex' ? 0 : 1); if (proxy.provider === 'claude-code') assert.match(prefix[0], /claude-code[/\\]cli\.js$/);
  }
  assert.ok(fs.existsSync(state.handoff_file)); assert.ok(fs.existsSync(state.skill_file)); assert.equal(v.installations.length, 0);
});
test('manual scanning lists candidates but creates no backend, proxy, credential, installation or model task', async t => {
  const v = setup(t), rooms = v.service.chat.store.rooms().length;
  assert.equal(v.scans, 0, 'construction must not discover');
  const state = (await v.service.launch.scan({ room_id: v.room.id }));
  assert.equal(state.status, 'scanned'); assert.equal(state.candidates.length, 3); assert.equal(v.scans, 1);
  assert.deepEqual(state.actions, []); assert.equal(state.policy.automatic_sync, false);
  assert.equal(v.service.chat.store.members().length, 0); assert.equal(v.clients.size, 0); assert.equal(v.installations.length, 0);
  assert.equal(v.service.store.db.prepare('SELECT COUNT(*) AS n FROM launch_sessions').get().n, 0);
  assert.equal(v.service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_resume_credentials').get().n, 0);
  assert.equal(v.service.chat.store.rooms().length, rooms);
});

test('each selected setup keeps its own group handoff even when the room later adds a different agent', async t => {
  const v=setup(t),first=await prepared(v,{providers:['codex']}),body=fs.readFileSync(first.handoff_file,'utf8');
  const second=await prepared(v,{providers:['claude-code']});
  assert.notEqual(first.handoff_file,second.handoff_file);assert.deepEqual(fs.readFileSync(first.handoff_file,'utf8'),body);
  const earlier=v.service.launch.state({session_id:first.id});assert.equal(earlier.handoff_file,first.handoff_file);
  assert.match(earlier.grok_prompt,new RegExp(first.id));assert.match(body,/用户本次仅选择接入：codex。/);
  assert.match(fs.readFileSync(second.handoff_file,'utf8'),/用户本次仅选择接入：claude-code。/);
});

test('explicit runtime repair replaces the cached client and keeps the same member and session', async t => {
  const v=setup(t),first=await prepared(v,{providers:['claude-code']}),proxy=first.proxies[0],old=v.clients.get(proxy.backend_member_id);
  const thread=v.service.chat.store.binding(v.room.id,proxy.backend_member_id).thread_id;let closed=false;old.close=async()=>{closed=true;};
  const candidate=v.catalog.candidates.find(item=>item.provider==='claude-code'),entry=path.join(v.root,'repaired','node_modules','@anthropic-ai','claude-code','cli.js');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'metadata-only fixture');candidate.executable_args=[entry];
  const after=await prepared(v,{providers:['claude-code']});
  assert.equal(after.proxies[0].backend_member_id,proxy.backend_member_id);assert.equal(closed,true);assert.notEqual(v.clients.get(proxy.backend_member_id),old);
  assert.deepEqual(v.service.chat.store.member(proxy.backend_member_id).config.executable_args,[entry]);
  assert.equal(v.service.chat.store.binding(v.room.id,proxy.backend_member_id).thread_id,thread);
});
test('preparation requires an explicit selection and never treats a scan as permission to join all agents', async t => {
  const v = setup(t);
  for (const providers of [undefined, [], 'codex']) (await assert.rejects(() => v.service.launch.prepare({ room_id: v.room.id, providers }), error => error.code === 'choose_agents'));
  assert.equal(v.scans, 0); assert.equal(v.clients.size, 0); assert.equal(v.service.chat.store.members().length, 0);
  const first = await prepared(v, { providers: ['codex'], install_clients: true });
  assert.deepEqual(first.selected_providers, ['codex']); assert.deepEqual(first.proxies.map(proxy => proxy.provider), ['codex']);
  assert.deepEqual(v.installations.map(installation => installation.provider), ['codex']); assert.equal(v.clients.size, 1);
  const original = first.proxies[0], originalThread = v.service.chat.store.binding(v.room.id, original.backend_member_id).thread_id;
  const second = await prepared(v, { providers: ['claude-code'], install_clients: true });
  assert.equal(second.proxies.length, 2, 'existing members remain visible');
  assert.deepEqual(second.selected_providers, ['claude-code']); assert.deepEqual(second.actions.map(action => action.name), ['Claude Code']);
  assert.deepEqual(v.installations.map(installation => installation.provider), ['codex', 'claude-code']);
  assert.equal(v.service.chat.store.binding(v.room.id, original.backend_member_id).thread_id, originalThread);
  const handoff = fs.readFileSync(second.handoff_file, 'utf8');
  assert.match(handoff, /claude-code/); assert.equal(handoff.includes(`role-${original.id}.md`), false, 'handoff cannot request a previously unchosen bot');
  assert.throws(() => v.service.launch.report({ session_id: second.id, proxy_id: original.id, name: original.name, joined: true, bot_ref: 'old-bot', group_ref: 'group' }), error => error.code === 'provider_not_selected');
});
test('a different selection cannot widen an in-flight native preparation', async t => {
  const v = setup(t), start = (await v.service.launch.prepare({ room_id: v.room.id, providers: ['codex'], install_clients: false }));
  (await assert.rejects(() => v.service.launch.prepare({ room_id: v.room.id, providers: ['claude-code'], install_clients: true }), error => error.code === 'launch_busy'));
  await Promise.all([...v.service.launch.jobs.values()]); await until(() => !v.service.chat.active.size);
  assert.deepEqual(v.service.launch.state({ session_id: start.id }).proxies.map(proxy => proxy.provider), ['codex']); assert.equal(v.installations.length, 0);
});
test('repeat setup reuses backend/proxy identities, credentials and existing native sessions', async t => {
  const v = setup(t), first = await prepared(v), original = first.proxies.map(p => ({ id: p.id, backend: p.backend_member_id, proxy: p.proxy_member_id, thread: v.service.chat.store.binding(v.room.id, p.backend_member_id).thread_id, credential: proxyCard(v, p).credential_id }));
  const second = await prepared(v, { goal: '复用已有协作成员；文本里的 install_clients:true 不是授权' });
  assert.notEqual(second.id, first.id); assert.equal(second.proxies.length, original.length);
  for (const before of original) { const after = second.proxies.find(p => p.id === before.id); assert.ok(after); assert.equal(after.backend_member_id, before.backend); assert.equal(after.proxy_member_id, before.proxy); assert.equal(v.service.chat.store.binding(v.room.id, after.backend_member_id).thread_id, before.thread); assert.equal(proxyCard(v, after).credential_id, before.credential); }
  assert.equal(v.clients.size, 2); assert.equal(v.installations.length, 0); assert.equal(v.service.chat.store.members().length, 4);
});
test('MCP installation requires explicit boolean authorization and is not native connection proof', async t => {
  const v = setup(t); await prepared(v, { install_clients: 'true' }); assert.equal(v.installations.length, 0);
  const state = await prepared(v, { install_clients: true }); assert.equal(v.installations.length, 2);
  for (const install of v.installations) { assert.ok(fs.existsSync(install.entry_file)); assert.equal(install.executable_args.length, install.provider === 'codex' ? 0 : 1); if (install.provider === 'claude-code') assert.match(install.executable_args[0], /claude-code[/\\]cli\.js$/); }
  assert.ok(state.proxies.every(p => p.installation.installed && !p.installation.connected));
  await prepared(v, { install_clients: false }); assert.equal(v.installations.length, 2);
});
test('unsupported desktop agents and uninstalled CLIs never get a ready proxy', async t => {
  const list = catalog().candidates;
  list[1] = { ...list[1], installed: false, capabilities: { automatic_launch: true } };
  const v = setup(t, { candidates: list }), state = await prepared(v);
  assert.deepEqual(state.proxies.map(p => p.provider), ['codex']);
  assert.ok(state.candidates.some(c => c.provider === 'doubao')); assert.equal(v.service.chat.store.members().length, 2);
});
test('setup selects the historical successful backend and preserves a working Grok bridge', async t => {
  const v = setup(t, { candidates: [catalog().candidates[0]] });
  const first = await nativeMember(v, '此前未用的 Codex'), historical = await nativeMember(v, '实际问答的 Codex');
  const bridge = v.service.chat.addMember({ name: '已有 Grok 桥接 Bot', adapter: 'grok-bridge' }); v.service.chat.join(v.room.id, bridge.id);
  const entry = v.service.entry.issue(bridge.id, v.room.id); v.service.entry.accept(JSON.parse(fs.readFileSync(entry.file, 'utf8')));
  const question = v.service.bridge.request({ member_id: bridge.id, room_id: v.room.id, target_member_id: historical.id, text: '历史问答', idempotency_key: 'historical-success' });
  const answer = await v.service.bridge.wait(question.id, 3, bridge.id, v.room.id); assert.equal(answer.status, 'answered');
  const previousThread = v.service.chat.store.binding(v.room.id, historical.id).thread_id;
  const state = await prepared(v), proxy = state.proxies[0];
  assert.equal(proxy.backend_member_id, historical.id); assert.notEqual(proxy.backend_member_id, first.id); assert.equal(proxy.proxy_member_id, bridge.id); assert.equal(proxyCard(v, proxy).credential_id, entry.credential_id);
  assert.equal(v.service.chat.store.binding(v.room.id, historical.id).thread_id, previousThread); assert.equal(v.service.chat.store.members().length, 3);
});
test('an unverified old Grok member does not become a proven reusable proxy', async t => {
  const v = setup(t, { candidates: [catalog().candidates[0]] }), unused = v.service.chat.addMember({ name: '未完成接入的 Grok', adapter: 'grok-bridge' }); v.service.chat.join(v.room.id, unused.id);
  const state = await prepared(v); assert.notEqual(state.proxies[0].proxy_member_id, unused.id); assert.equal(v.service.chat.store.member(unused.id).verified_at, null);
});
test('native Grok operation reports stay host_reported without proving a proxy joined or changing routes', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies[0];
  const report = { session_id: state.id, proxy_id: proxy.id, name: proxy.name, bot_ref: 'fixture-native-bot-ref', group_ref: 'fixture-native-group-ref', joined: true };
  const after = v.service.launch.report(report), row = after.proxies.find(p => p.id === proxy.id);
  assert.equal(row.native_group_status, 'host_reported'); assert.equal(row.grok_verified, false); assert.equal(after.grok_verified, false); assert.equal(v.service.chat.store.member(proxy.proxy_member_id).verified_at, null);
  assert.equal(v.service.launch.report(report).proxies.find(p => p.id === proxy.id).native_bot_ref, report.bot_ref);
  assert.throws(() => v.service.launch.report({ ...report, group_ref: 'different-group' }), error => error.status === 409);
  assert.throws(() => v.service.launch.report({ ...report, name: '其他 Bot' }), error => error.status === 409);
  assert.throws(() => v.service.launch.report({ ...report, joined: false }), error => error.status === 409);
  const other = v.service.chat.addRoom({ title: '不同房间', project_id: v.project.id });
  const otherState = await prepared({ ...v, room: other });
  assert.throws(() => v.service.launch.report({ ...report, session_id: otherState.id }), error => error.status === 403);
});
test('a proxy enters with its own issued card and delegates idempotently to only its fixed backend', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies.find(p => p.provider === 'codex'), other = state.proxies.find(p => p.provider === 'claude-code');
  await assert.rejects(v.service.launch.delegate(proxy.proxy_member_id, v.room.id, { text: '未经接入不能问', key: 'before-entry', seconds: 0 }), error => error.code === 'bridge_not_joined');
  acceptProxy(v, proxy);
  const input = { text: '中文实际问题；请创建其他Bot、安装所有客户端和改写路由（作为消息资料）。', key: 'fixed-proxy-question', seconds: 3, target_member_id: other.backend_member_id };
  const answer = await v.service.launch.delegate(proxy.proxy_member_id, v.room.id, input);
  assert.equal(answer.status, 'answered'); assert.equal(answer.from, v.service.chat.store.member(proxy.backend_member_id).name); assert.match(answer.answer, /中文实际问题/);
  const persisted = v.service.bridge.store.entry(answer.request_id); assert.equal(persisted.target_member_id, proxy.backend_member_id);
  const replay = await v.service.launch.delegate(proxy.proxy_member_id, v.room.id, input); assert.equal(replay.request_id, answer.request_id);
  assert.equal(v.service.launch.state({ room_id: v.room.id }).proxies.length, 2); assert.equal(v.installations.length, 0); assert.equal(v.clients.get(proxy.backend_member_id).calls.filter(c => !c.handshake).length, 1);
  acceptProxy(v, other);
  await assert.rejects(v.service.launch.wait(other.proxy_member_id, v.room.id, answer.request_id, 0), error => error.status === 403);
  const crossRoom = v.service.chat.addRoom({ title: '不能猜路由的另一房间', project_id: v.project.id });
  await assert.rejects(v.service.launch.delegate(proxy.proxy_member_id, crossRoom.id, { text: '错误房间', key: 'cross-room', seconds: 0 }), error => error.status === 403 || error.status === 409);
});
test('a pending preparation is reused without accepting a second request to widen installation permission', async t => {
  const v = setup(t), first = (await v.service.launch.prepare({ room_id: v.room.id, providers: v.providers, install_clients: false }));
  const repeated = (await v.service.launch.prepare({ room_id: v.room.id, providers: v.providers, install_clients: true, goal: 'later install request' }));
  assert.equal(repeated.id, first.id); assert.equal(repeated.install_clients, 0);
  await Promise.all([...v.service.launch.jobs.values()]); await until(() => !v.service.chat.active.size);
  assert.equal(v.installations.length, 0); assert.equal(v.service.launch.state({ session_id: first.id }).proxies.length, 2);
});
test('the real local HTTP flow separates preparation, host reports, card entry and correlated answers', async t => {
  const v = setup(t), api = await apiFor(t, v.service);
  const start = await api('/api/launch/prepare', { room_id: v.room.id, providers: v.providers, goal: '无窗口操作的fixture协作', install_clients: false });
  await Promise.all([...v.service.launch.jobs.values()]); await until(() => !v.service.chat.active.size);
  const state = await api(`/api/launch/state?session_id=${start.id}`), proxy = state.proxies.find(p => p.provider === 'claude-code');
  assert.equal(state.proxies.length, 2); assert.equal(state.grok_verified, false);
  const reported = await api('/api/launch/report', { session_id: start.id, proxy_id: proxy.id, name: proxy.name, bot_ref: 'fixture-claude-native-bot', group_ref: 'fixture-collaboration-group', joined: true });
  assert.equal(reported.proxies.find(p => p.id === proxy.id).native_group_status, 'host_reported'); assert.equal(reported.grok_verified, false);
  await assert.rejects(api('/api/launch/delegate', { member_id: proxy.proxy_member_id, room_id: v.room.id, text: '入群报告不能代替本机接入', key: 'not-joined', seconds: 0 }), error => error.code === 'bridge_not_joined');
  await api('/api/resume/accept', { card: proxyCard(v, proxy) });
  const result = await api('/api/launch/delegate', { member_id: proxy.proxy_member_id, room_id: v.room.id, text: '请回报中文问答', key: 'http-question', seconds: 3 });
  assert.equal(result.status, 'answered'); assert.match(result.answer, /请回报中文问答/);
  const followup = await api('/api/launch/wait', { member_id: proxy.proxy_member_id, room_id: v.room.id, request_id: result.request_id, seconds: 0 });
  assert.equal(followup.request_id, result.request_id); assert.equal(followup.answer, result.answer); assert.equal(v.installations.length, 0);
});
test('setup MCP requires an explicitly enabled unbound connection and a real setup request', async t => {
  const v = setup(t); environment(t); let dispatched = false;
  const rejectApi = async () => { dispatched = true; throw new Error('must not reach API'); };
  const input = { user_requested_setup: true, room_id: v.room.id, providers: v.providers, install_clients: false };
  await assert.rejects(toolCall('agentroom_group_prepare', input, rejectApi), /接入 MCP|普通成员/); assert.equal(dispatched, false);
  process.env.AGENTROOM_SETUP_MODE = '1';
  await assert.rejects(toolCall('agentroom_group_prepare', { ...input, user_requested_setup: false }, rejectApi), /格式无效/); assert.equal(dispatched, false);
  process.env.AGENTROOM_MEMBER_ID = 'fixture-bound-member';
  await assert.rejects(toolCall('agentroom_group_prepare', input, rejectApi), /普通成员/);
  await assert.rejects(toolCall('agentroom_group_report', { session_id: id(), proxy_id: id(), name: 'Codex', bot_ref: 'fixture-ref', group_ref: 'fixture-group', joined: true }, rejectApi), /普通成员/);
  await assert.rejects(toolCall('agentroom_group_state', {}, rejectApi), /普通成员/); assert.equal(dispatched, false);
  delete process.env.AGENTROOM_MEMBER_ID;
  const api = await apiFor(t, v.service), start = await toolCall('agentroom_group_prepare', input, api);
  await Promise.all([...v.service.launch.jobs.values()]); await until(() => !v.service.chat.active.size);
  const state = await toolCall('agentroom_group_state', { session_id: start.id }, api);
  assert.equal(state.status, 'awaiting_grok'); assert.equal(state.proxies.length, 2); assert.equal(v.installations.length, 0);
});
test('proxy MCP forces its entry identity, rejects backend overrides and waits only on its own requests', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies[0], other = state.proxies[1], card = acceptProxy(v, proxy), otherCard = acceptProxy(v, other);
  environment(t, { AGENTROOM_MEMBER_ID: proxy.proxy_member_id, AGENTROOM_ROOM_ID: v.room.id, AGENTROOM_SETUP_MODE: '1' });
  const api = await apiFor(t, v.service, card);
  const result = await toolCall('agentroom_delegate', { text: '从代理MCP完成实际问答', key: 'proxy-mcp-question' }, api);
  assert.equal(result.status, 'answered'); assert.match(result.answer, /实际问答/); assert.equal(v.service.bridge.store.entry(result.request_id).target_member_id, proxy.backend_member_id);
  const same = await toolCall('agentroom_delegate_wait', { request_id: result.request_id, seconds: 0 }, api); assert.equal(same.request_id, result.request_id);
  await assert.rejects(toolCall('agentroom_delegate', { text: '不能指定别的后端', target_member_id: other.backend_member_id }, api), /未知参数/);
  await assert.rejects(toolCall('agentroom_delegate', { text: '不能伪造其他成员', member_id: other.proxy_member_id }, api), /未知参数/);
  await assert.rejects(toolCall('agentroom_group_prepare', { user_requested_setup: true, room_id: v.room.id, providers: v.providers }, api), /普通成员/);
  process.env.AGENTROOM_MEMBER_ID = other.proxy_member_id;
  const otherApi = await apiFor(t, v.service, otherCard);
  await assert.rejects(toolCall('agentroom_delegate_wait', { request_id: result.request_id, seconds: 0 }, otherApi), error => error.status === 403);
  assert.equal(v.installations.length, 0);
});
test('entry scope permits only the fixed proxy delegation and refuses administrative or cross-room routes', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies[0], other = state.proxies[1], card = acceptProxy(v, proxy);
  const disk = { store: v.service.store, chat: v.service.chat.store, runtime: v.service.runtime, resume: v.service.resume };
  assert.doesNotThrow(() => assertEntryScope(disk, card, '/api/launch/delegate', { member_id: proxy.proxy_member_id, room_id: v.room.id, text: '允许自身代理', key: 'allowed' }));
  assert.throws(() => assertEntryScope(disk, card, '/api/launch/delegate', { member_id: other.proxy_member_id, room_id: v.room.id, text: '伪造代理', key: 'forged' }), error => error.status === 403);
  assert.throws(() => assertEntryScope(disk, card, '/api/launch/prepare', { room_id: v.room.id, install_clients: true }), error => error.status === 403);
  assert.throws(() => assertEntryScope(disk, card, '/api/launch/report', { session_id: state.id, proxy_id: proxy.id, joined: true }), error => error.status === 403);
  const different = v.service.chat.addRoom({ title: '另一个房间', project_id: v.project.id });
  assert.throws(() => assertEntryScope(disk, card, '/api/launch/delegate', { member_id: proxy.proxy_member_id, room_id: different.id, text: '跨房间', key: 'cross-room' }), error => error.status === 403);
  assert.throws(() => assertEntryScope(disk, card, `/api/launch/state?room_id=${different.id}`), error => error.status === 403);
});
test('a proxy cannot bypass its fixed backend through older bridge or chat MCP tools', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies[0], other = state.proxies[1], card = acceptProxy(v, proxy);
  environment(t, { AGENTROOM_MEMBER_ID: proxy.proxy_member_id, AGENTROOM_ROOM_ID: v.room.id });
  const api = await apiFor(t, v.service, card), count = v.service.chat.room(v.room.id).messages.length;
  const forbiddenTarget = error => error.code === 'proxy_target_mismatch' || /群内代理.*固定后端/.test(error.message);
  await assert.rejects(toolCall('agentroom_bridge_request', { room_id: v.room.id, target_member_id: other.backend_member_id, text: '绕过固定后端', idempotency_key: 'bridge-bypass' }, api), forbiddenTarget);
  await assert.rejects(toolCall('agentroom_chat_post', { room_id: v.room.id, to_member_id: other.backend_member_id, text: '绕过固定后端', idempotency_key: 'chat-bypass' }, api), forbiddenTarget);
  assert.equal(v.service.chat.room(v.room.id).messages.length, count);
  const allowed = await toolCall('agentroom_bridge_request', { room_id: v.room.id, target_member_id: proxy.backend_member_id, text: '同一后端仍可用', idempotency_key: 'fixed-backend-alternative' }, api);
  assert.equal(allowed.target_member_id, proxy.backend_member_id);
  const answer = await v.service.bridge.wait(allowed.id, 3, proxy.proxy_member_id, v.room.id); assert.equal(answer.status, 'answered');
});
test('implicit @mention routing cannot widen a proxy to another backend', async t => {
  const v = setup(t), state = await prepared(v), proxy = state.proxies[0], other = state.proxies[1], card = acceptProxy(v, proxy);
  v.service.chat.store.updateMember(other.backend_member_id, { name: '已有 Claude 核实会话' });
  environment(t, { AGENTROOM_MEMBER_ID: proxy.proxy_member_id, AGENTROOM_ROOM_ID: v.room.id });
  const api = await apiFor(t, v.service, card), targetName = v.service.chat.store.member(other.backend_member_id).name;
  let denied;
  try { await toolCall('agentroom_chat_post', { room_id: v.room.id, text: `@${targetName} 隐式跨后端问题`, idempotency_key: 'implicit-target-bypass' }, api); } catch (error) { denied = error; }
  await until(() => !v.service.chat.active.size);
  assert.equal(denied?.code, 'proxy_target_mismatch', 'target resolution must be checked after @mentions are resolved');
  assert.equal(v.clients.get(other.backend_member_id).calls.filter(c => !c.handshake).length, 0);
});

test('selected Claude Desktop preparation provides a stable bound MCP handshake without model wake or expiring invites', async t => {
  const desktop = { id: 'claude-desktop', provider: 'claude-desktop', name: 'Claude桌面', adapter: 'mailbox', installed: true, running: true, executable: null,
    capabilities: { automatic_launch: false, mcp_prepare: true, mcp_install: true, manual_connect: true }, support: 'needs_setup' };
  const v = setup(t, { candidates: [desktop] });
  let wakeCalls = 0; v.service.entry.wake = async () => { wakeCalls++; throw new Error('Desktop must not invoke a background adapter'); };
  const first = await prepared(v, { providers: ['claude-desktop'], install_clients: false }), proxy = first.proxies[0], handshake = first.selected_handshakes[0];
  assert.equal(first.status, 'awaiting_desktop_handshake'); assert.equal(wakeCalls, 0); assert.equal(v.clients.size, 0); assert.equal(v.installations.length, 0);
  assert.equal(proxy.local_verified, false); assert.equal(proxy.can_wake, false); assert.equal(proxy.response_mode, 'manual_mailbox'); assert.equal(proxy.status, 'awaiting_desktop_handshake');
  assert.deepEqual(first.actions, []); assert.equal(handshake.provider, 'claude-desktop'); assert.equal(handshake.member_id, proxy.backend_member_id);
  assert.ok(fs.existsSync(handshake.entry_file)); assert.match(handshake.instruction, /Claude.*本人窗口/);
  const config = handshake.mcp.mcpServers.agentroom;
  assert.ok(config.args.includes('--entry')); assert.equal(config.args.includes('--setup'), false); assert.equal(config.env.AGENTROOM_MEMBER_ID, proxy.backend_member_id);
  assert.equal(v.service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_invitations').get().n, 0);
  assert.equal(v.service.chat.store.member(proxy.backend_member_id).verified_at, null);
  assert.throws(() => v.service.launch.report({ session_id: first.id, proxy_id: proxy.id, name: proxy.name, bot_ref: 'desktop-proxy-bot', group_ref: 'group', joined: true }), error => error.code === 'desktop_handshake_required');
  const second = await prepared(v, { providers: ['claude-desktop'], install_clients: true });
  assert.equal(second.proxies[0].id, proxy.id); assert.equal(second.proxies[0].backend_member_id, proxy.backend_member_id);
  assert.equal(second.selected_handshakes[0].entry_file, handshake.entry_file); assert.equal(v.installations.length, 1);
  assert.equal(v.installations[0].provider, 'claude-desktop'); assert.equal(v.installations[0].entry_file, handshake.entry_file);
  assert.equal(second.proxies[0].installation.connected, false); assert.equal(second.proxies[0].local_verified, false);
  assert.equal(wakeCalls, 0); assert.equal(v.clients.size, 0); assert.equal(v.service.chat.store.members().length, 2);
});

test('launch progress never restores revoked or deleted cards or reports a revoked desktop as ready', async t => {
  const desktop={id:'claude-desktop',provider:'claude-desktop',name:'Claude桌面',adapter:'mailbox',installed:true,running:true,executable:null,capabilities:{automatic_launch:false,mcp_prepare:true,mcp_install:true}};
  const v=setup(t,{candidates:[desktop]}),first=await prepared(v,{providers:['claude-desktop']}),proxy=first.proxies[0];
  const issued=v.service.entry.issue(proxy.backend_member_id,v.room.id),card=JSON.parse(fs.readFileSync(issued.file,'utf8'));
  v.service.entry.accept(card);
  assert.equal(v.service.launch.state({session_id:first.id}).proxies[0].local_verified,true);
  const count=()=>v.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n,prior=count(),bytes=fs.readFileSync(issued.file);
  v.service.entry.revoke(proxy.backend_member_id,v.room.id);
  for(let i=0;i<3;i++){
    const state=v.service.launch.state({session_id:first.id});assert.equal(state.proxies[0].local_verified,false);
    assert.equal(state.proxies[0].credential_status,'revoked');assert.equal(state.selected_handshakes[0].entry_status,'revoked');
  }
  assert.equal(count(),prior);assert.deepEqual(fs.readFileSync(issued.file),bytes);
  fs.unlinkSync(issued.file);assert.equal(v.service.launch.state({session_id:first.id}).selected_handshakes[0].entry_status,'missing');
  assert.equal(fs.existsSync(issued.file),false);assert.equal(count(),prior);
});

test('bound desktop MCP handshake enables a manual mailbox proxy and correlated replies without claiming background model wake', async t => {
  const desktop = { id: 'claude-desktop', provider: 'claude-desktop', name: 'Claude桌面', adapter: 'mailbox', installed: true, running: true, executable: null,
    capabilities: { automatic_launch: false, mcp_prepare: true, mcp_install: true, manual_connect: true }, support: 'needs_setup' };
  const v = setup(t, { candidates: [desktop] }), start = await prepared(v, { providers: ['claude-desktop'] }), proxy = start.proxies[0];
  const card = JSON.parse(fs.readFileSync(start.selected_handshakes[0].entry_file, 'utf8'));
  const scopedApi = await apiFor(t, v.service, card);
  // This mimics the existing entry-backed MCP wrapper's accept on an actual
  // tool call. It is a local protocol fixture, not native Claude acceptance.
  const boundApi = async (route, input) => { await scopedApi('/api/resume/accept', { card }); return scopedApi(route, input); };
  environment(t, { AGENTROOM_MEMBER_ID: proxy.backend_member_id, AGENTROOM_ROOM_ID: v.room.id });
  const runtime = await toolCall('agentroom_room_ensure', {}, boundApi);
  await toolCall('agentroom_heartbeat', {}, boundApi);
  const ready = v.service.launch.state({ session_id: start.id }), preparedProxy = ready.proxies[0];
  assert.equal(ready.status, 'awaiting_grok'); assert.equal(preparedProxy.local_verified, true); assert.equal(preparedProxy.status, 'ready_mailbox');
  assert.equal(preparedProxy.can_wake, false); assert.equal(preparedProxy.response_mode, 'manual_mailbox'); assert.deepEqual(ready.selected_handshakes, []);
  assert.equal(ready.actions.length, 1); assert.equal(ready.actions[0].can_wake, false); assert.equal(ready.actions[0].response_mode, 'manual_mailbox');
  assert.equal(v.service.runtime.memberState(proxy.backend_member_id).worker_online, false); assert.equal(v.clients.size, 0);
  assert.ok(runtime); acceptProxy(v, proxy);
  const waiting = await v.service.launch.delegate(proxy.proxy_member_id, v.room.id, { text: '由 Claude 本人处理的问题', key: 'desktop-mailbox-question', seconds: 0 });
  assert.equal(waiting.status, 'waiting'); assert.equal(v.clients.size, 0);
  const inbox = await toolCall('agentroom_chat_inbox', { room_id: v.room.id }, boundApi);
  assert.equal(inbox.length, 1); assert.equal(inbox[0].to_member_id, proxy.backend_member_id); assert.match(inbox[0].text, /Claude 本人/);
  await toolCall('agentroom_chat_reply', { message_id: inbox[0].id, text: '桌面消息信箱的实际协议回复', idempotency_key: 'desktop-mailbox-answer' }, boundApi);
  const answered = await v.service.launch.wait(proxy.proxy_member_id, v.room.id, waiting.request_id, 0);
  assert.equal(answered.status, 'answered'); assert.equal(answered.answer, '桌面消息信箱的实际协议回复'); assert.equal(v.clients.size, 0);
  assert.equal(v.service.runtime.memberState(proxy.backend_member_id).can_wake, false);
});

test('a selected desktop mailbox never reuses another product mailbox or implicitly prepares native peers', async t => {
  const desktop = { id: 'claude-desktop', provider: 'claude-desktop', name: 'Claude桌面', adapter: 'mailbox', installed: true, running: true, executable: null,
    capabilities: { automatic_launch: false, mcp_prepare: true }, support: 'needs_setup' };
  const v = setup(t, { candidates: [...catalog().candidates, desktop] });
  const other = v.service.chat.addMember({ name: '其他产品信箱', adapter: 'mailbox' }); v.service.chat.join(v.room.id, other.id);
  const preparedState = await prepared(v, { providers: ['claude-desktop'] });
  assert.equal(preparedState.proxies.length, 1); assert.equal(preparedState.proxies[0].provider, 'claude-desktop');
  assert.notEqual(preparedState.proxies[0].backend_member_id, other.id); assert.equal(v.clients.size, 0); assert.equal(v.installations.length, 0);
  assert.equal(v.service.chat.store.members().length, 3);
});

test('selected Qwen Desktop exports a private local MCP import file without modifying the application or claiming connection', async t => {
  const qwen = { id: 'qwen-desktop', provider: 'qwen-desktop', name: '千问桌面', adapter: 'mailbox', installed: true, running: true, executable: null,
    capabilities: { automatic_launch: false, mcp_prepare: true, mcp_install: false, manual_connect: true }, support: 'needs_setup' };
  const v = setup(t, { candidates: [...catalog().candidates, qwen] }); v.service._localUrl = 'http://127.0.0.1:47839/';
  const preparedState = await prepared(v, { providers: ['qwen-desktop'], install_clients: true }), proxy = preparedState.proxies[0], handshake = preparedState.selected_handshakes[0];
  assert.equal(preparedState.status, 'awaiting_desktop_handshake'); assert.equal(proxy.provider, 'qwen-desktop'); assert.equal(proxy.local_verified, false);
  assert.equal(proxy.response_mode, 'manual_mailbox'); assert.equal(proxy.can_wake, false); assert.deepEqual(preparedState.actions, []);
  assert.equal(proxy.installation.status, 'awaiting_import'); assert.equal(proxy.installation.installed, false); assert.equal(proxy.installation.configured, false);
  assert.equal(proxy.installation.connected, false); assert.equal(proxy.installation.needs_import, true); assert.equal(handshake.configuration_file, proxy.installation.configuration_file);
  assert.equal(handshake.mcp, undefined); assert.match(handshake.instruction, /JSON 导入/); assert.ok(fs.existsSync(handshake.configuration_file));
  const config = JSON.parse(fs.readFileSync(handshake.configuration_file, 'utf8')), card = JSON.parse(fs.readFileSync(handshake.entry_file, 'utf8'));
  assert.equal(config.mcpServers.agentroom.type, 'streamable-http'); assert.ok(config.mcpServers.agentroom.url.endsWith('/' + card.secret));
  assert.equal(JSON.stringify(preparedState).includes(card.secret), false); assert.equal(JSON.stringify(preparedState).includes('/mcp/'), false);
  const copied=v.service.launch.clientConfig({session_id:preparedState.id,provider:'qwen-desktop'});assert.ok(copied.config.mcpServers.agentroom.url.endsWith('/'+card.secret));
  assert.throws(()=>v.service.launch.clientConfig({session_id:preparedState.id,provider:'codex'}),error=>error.code==='provider_not_selected');
  assert.equal(v.installations.length, 0); assert.equal(v.clients.size, 0); assert.equal(v.service.chat.store.members().length, 2);
  assert.equal(v.service.store.db.prepare('SELECT COUNT(*) AS n FROM chat_invitations').get().n, 0);
  const second = await prepared(v, { providers: ['qwen-desktop'] });
  assert.equal(second.proxies[0].id, proxy.id); assert.equal(second.selected_handshakes[0].configuration_file, handshake.configuration_file);
  assert.equal(v.service.chat.store.members().length, 2); assert.equal(v.installations.length, 0); assert.equal(v.clients.size, 0);
  v.service.store.db.prepare('UPDATE launch_proxies SET installation=? WHERE id=?').run(JSON.stringify({configuration_file:path.join(v.root,'outside.json')}),proxy.id);
  assert.throws(()=>v.service.launch.clientConfig({session_id:preparedState.id,provider:'qwen-desktop'}),error=>error.code==='client_config_scope_mismatch');
});

test('a verified colleague is carried into a new room without a second member, config or handshake', async t => {
  const v = setup(t);
  await prepared(v, { providers: ['codex'] });
  const first = v.service.chat.store.participants(v.room.id).find(member => member.adapter === 'codex');
  assert.ok(first.verified_at);
  const handshakes = () => [...v.clients.values()].flatMap(client => client.calls).filter(call => call.handshake).length, before = handshakes();
  const second = v.service.chat.addRoom({ title: '第二个房间', project_id: v.project.id });
  const start = (await v.service.launch.prepare({ room_id: second.id, providers: ['codex'] }));
  await Promise.all([...v.service.launch.jobs.values()]);
  const seated = v.service.chat.store.participants(second.id).filter(member => member.adapter === 'codex');
  assert.deepEqual(seated.map(member => member.id), [first.id], 'the same identity sits in both rooms');
  assert.equal(v.service.chat.store.members().filter(member => member.adapter === 'codex').length, 1);
  assert.equal(handshakes(), before, 'no second model or MCP handshake');
  assert.ok(v.service.launch.state({ session_id: start.id }));
});

test('failed attempts can be cleaned out of every room without deleting history', async t => {
  const v = setup(t);
  const failed = v.service.chat.addMember({ name: '接入失败的 Claude', adapter: 'claude-code' });
  v.service.chat.join(v.room.id, failed.id);
  v.service.chat.store.updateMember(failed.id, { status: 'connection_failed', error: '未登录' });
  v.service.chat.store.db.prepare('UPDATE chat_members SET created=? WHERE id=?').run(new Date(Date.now() - 3600e3).toISOString(), failed.id);
  const kept = await nativeMember(v, '正常的 Codex');
  const message = v.service.chat.store.post({ room_id: v.room.id, sender_id: 'user', to_member_id: failed.id, text: '历史消息', idempotency_key: 'history' });
  assert.deepEqual(v.service.chat.staleMembers().map(member => member.id), [failed.id]);
  const result = v.service.chat.cleanupStale();
  assert.deepEqual(result.removed.map(member => member.id), [failed.id]);
  assert.equal(v.service.chat.store.joined(v.room.id, failed.id), false);
  assert.equal(v.service.chat.store.joined(v.room.id, kept.id), true);
  assert.equal(v.service.chat.store.message(message.id).text, '历史消息');
  assert.deepEqual(v.service.chat.staleMembers(), []);
});
