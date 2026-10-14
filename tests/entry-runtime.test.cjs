'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { readEntry, diskState, acceptEntry, openDisk, assertEntryScope } = require('../src/entry.cjs');
const { apiCall, createRecoveringApi } = require('../src/main.cjs');
const { runMcp, toolCall } = require('../src/mcp.cjs');
const { id, sleep, VERSION, RoomError } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

// A local protocol fixture, not a real Codex process or external account. The
// fixture invokes the issued join challenge and reuses the persisted thread.
class NativeEntryFixture extends EventEmitter {
  constructor(member, service) { super(); this.member = member; this.service = service; this.calls = []; this.child = { pid: process.pid }; }
  async run(input) {
    const thread = input.discussion.thread_id || id();
    if (!input.discussion.thread_id) { input.onBinding('creating'); input.onBinding('bound', thread); }
    input.onTurn?.(id());
    const handshake = input.request.prompt.includes('真实接入握手');
    this.calls.push({ handshake, prior_thread: input.discussion.thread_id });
    if (handshake) {
      const values = input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);
      assert.ok(values);
      this.service.chat.completeInvite(values[1], values[2], this.member.id);
      return { threadId: thread, turnId: id(), answer: '已完成本地测试握手。' };
    }
    return { threadId: thread, turnId: id(), answer: `fixture实际回答：${this.service.chat.store.message(input.request.id).text}` };
  }
  async close() { this.emit('disconnected'); }
}
async function until(predicate, description) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (predicate()) return; await sleep(10); }
  assert.fail(`timed out: ${description}`);
}
async function harness(t) {
  const files = fixture(); let service, server, control, starts = 0;
  const clients = [];
  async function ensure(dir) {
    assert.equal(dir, files.data);
    if (service && !service.closing) return control;
    starts++;
    let next;
    next = new RoomService(dir, { codex: new FakeCodex(), vault: new FakeVault(), fetch: async () => { throw new Error('External requests are prohibited in this fixture'); }, chat: { clientFactory(member) { const client = new NativeEntryFixture(member, next); clients.push(client); return client; } } });
    const token = id(); const endpoint = createServer(next, { token, port: 0 }); const port = await endpoint.listen();
    service = next; server = endpoint;
    control = { pid: process.pid, url: `http://127.0.0.1:${port}`, token, version: VERSION, instance_id: next.runtime.instanceId };
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(control));
    next.start();
    return control;
  }
  async function close() {
    if (server) { const current = server; server = null; await current.close(); }
    if (service) { const current = service; service = null; await current.close(); }
  }
  t.after(async () => { await close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  await ensure(files.data);
  const project = service.addProject({ path: files.project, name: '后台恢复协议测试' }), room = service.chat.addRoom({ title: '持久聊天室', project_id: project.id });
  return { ...files, room, project, clients, ensure, close, get service() { return service; }, get starts() { return starts; } };
}
function participant(service, room, adapter = 'mailbox') {
  const member = service.chat.addMember({ name: `本机入口 ${adapter}`, adapter });
  service.chat.join(room.id, member.id);
  return member;
}
function bind(t, memberId, roomId) {
  const previous = Object.fromEntries(['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER'].map(key => [key, process.env[key]]));
  process.env.AGENTROOM_MEMBER_ID = memberId; process.env.AGENTROOM_ROOM_ID = roomId; process.env.AGENTROOM_CALLER = 'bound entry fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('entry description is read-only for missing, revoked and wrong-scope cards', async t => {
  const h = await harness(t), member = participant(h.service, h.room), other = participant(h.service, h.room);
  const count = () => h.service.store.db.prepare('SELECT count(*) AS n FROM chat_resume_credentials').get().n;
  const absent = h.service.entry.describe(member.id, h.room.id);
  assert.equal(absent.status, 'missing'); assert.equal(absent.available, false);
  assert.equal(count(), 0); assert.equal(fs.existsSync(absent.file), false);
  const issued = h.service.entry.issue(member.id, h.room.id), original = fs.readFileSync(issued.file);
  h.service.entry.revoke(member.id, h.room.id);
  for (let i = 0; i < 3; i++) assert.equal(h.service.entry.describe(member.id, h.room.id).status, 'revoked');
  assert.equal(count(), 1); assert.deepEqual(fs.readFileSync(issued.file), original);
  const otherFile = h.service.entry.issue(other.id, h.room.id).file;
  fs.copyFileSync(otherFile, issued.file);
  assert.equal(h.service.entry.describe(member.id, h.room.id).status, 'invalid');
  assert.equal(count(), 2);
});

test('explicit setup can repair a corrupt card with a backup while reads and ordinary issue fail closed', async t => {
  const h=await harness(t),member=participant(h.service,h.room),original=h.service.entry.issue(member.id,h.room.id);
  fs.writeFileSync(original.file,'{broken-entry');
  assert.equal(h.service.entry.describe(member.id,h.room.id).status,'invalid');
  assert.throws(()=>h.service.entry.issue(member.id,h.room.id),SyntaxError);
  assert.equal(h.service.resume.credential(original.credential_id).status,'pending');
  const repaired=h.service.entry.issue(member.id,h.room.id,{repair_invalid:true});assert.notEqual(repaired.credential_id,original.credential_id);
  assert.equal(h.service.resume.credential(original.credential_id).status,'revoked');assert.equal(h.service.entry.describe(member.id,h.room.id).status,'pending');
  const backups=fs.readdirSync(path.join(h.data,'backups','entries'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(h.data,'backups','entries',backups[0]),'utf8'),'{broken-entry');
});

test('an external agent can inspect a stopped room and enter the same instance without replacing the room or requesting another invitation', async t => {
  const h = await harness(t), member = participant(h.service, h.room, 'future-agent');
  const setup = h.service.entry.issue(member.id, h.room.id), entry = readEntry(setup.file);
  const question = h.service.chat.post({ room_id: h.room.id, to_member_id: member.id, text: '断开后仍保留的问题', idempotency_key: 'persisted-queued' });
  const invitationCount = h.service.chat.store.db.prepare('SELECT count(*) AS count FROM chat_invitations').get().count;
  const first = acceptEntry(entry), acceptedAt = first.credential.accepted_at, instance = h.service.runtime.instanceId;
  await h.close();
  const offline = diskState(h.data, entry);
  assert.equal(offline.transport, 'disk'); assert.equal(offline.ui_required, false);
  assert.equal(offline.service.online, false); assert.equal(offline.instance_id, instance);
  assert.equal(offline.rooms[0].id, h.room.id); assert.equal(offline.rooms[0].messages.queued, 1);
  assert.equal(readEntry(setup.file).card.credential_id, entry.card.credential_id);
  assert.equal(acceptEntry(entry).credential.accepted_at, acceptedAt);
  await h.ensure(h.data);
  assert.equal(h.service.runtime.instanceId, instance);
  assert.equal(h.service.chat.store.rooms().length, 1);
  assert.equal(h.service.chat.store.message(question.id).status, 'queued');
  assert.equal(h.service.chat.store.db.prepare('SELECT count(*) AS count FROM chat_invitations').get().count, invitationCount);
  assert.equal(h.service.entry.issue(member.id, h.room.id).credential_id, entry.card.credential_id);
  assert.equal(h.clients.length, 0);
});

test('a card pointing at a different or missing instance fails closed and never creates an empty replacement', async t => {
  const h = await harness(t), member = participant(h.service, h.room), setup = h.service.entry.issue(member.id, h.room.id);
  const card = JSON.parse(fs.readFileSync(setup.file, 'utf8'));
  const wrongFile = path.join(h.root, 'wrong-entry.json');
  fs.writeFileSync(wrongFile, JSON.stringify({ ...card, instance_id: id() }));
  assert.throws(() => readEntry(wrongFile), { code: 'resume_instance_mismatch' });
  const missing = path.join(h.root, 'must-not-be-created');
  fs.writeFileSync(wrongFile, JSON.stringify({ ...card, data_directory: missing }));
  assert.throws(() => readEntry(wrongFile), { code: 'instance_missing' });
  assert.equal(fs.existsSync(missing), false);
  const otherDir = path.join(h.root, 'other-data');
  const other = new RoomService(otherDir, { codex: new FakeCodex(), vault: new FakeVault() });
  try {
    fs.writeFileSync(wrongFile, JSON.stringify({ ...card, data_directory: otherDir }));
    assert.throws(() => readEntry(wrongFile), { code: 'resume_instance_mismatch' });
    assert.equal(other.chat.store.rooms().length, 0);
    assert.equal(other.resume.credentials().length, 0);
  } finally { await other.close(); }
  assert.equal(h.service.chat.store.rooms().length, 1);
  assert.equal(h.service.resume.credentials().length, 1);
});

test('unknown tools retain their inbox and report needs_external_entry rather than claiming window wakeup', async t => {
  const h = await harness(t), member = participant(h.service, h.room, 'unknown-product'), caller = participant(h.service, h.room);
  const queued = h.service.chat.post({ room_id: h.room.id, to_member_id: member.id, text: '等待外部会话进入', idempotency_key: 'unknown-wake' });
  const result = await h.service.entry.wake(h.room.id, member.id, caller.id);
  assert.equal(result.status, 'needs_external_entry');
  assert.equal(h.service.runtime.memberState(member.id).can_wake, false);
  assert.equal(h.service.runtime.memberState(member.id).worker_online, false);
  assert.equal(h.service.chat.store.message(queued.id).status, 'queued');
  assert.equal(h.clients.length, 0);
});

test('a native worker can be relaunched using the persisted thread and uncertain requests remain excluded', async t => {
  const h = await harness(t), member = participant(h.service, h.room, 'codex');
  await h.service.chat.connect(member.id, h.room.id);
  await until(() => h.service.chat.store.member(member.id).status === 'ready' && !h.service.chat.active.size, 'native fixture handshake');
  const nativeThread = h.service.chat.store.binding(h.room.id, member.id).thread_id;
  const uncertain = h.service.chat.store.post({ room_id: h.room.id, to_member_id: member.id, text: '上一轮结果待核对', idempotency_key: 'never-rerun' });
  h.service.chat.store.updateMessage(uncertain.id, { status: 'uncertain' });
  await h.close();
  assert.equal(diskState(h.data).members.find(m => m.id === member.id).worker_online, false);
  await h.ensure(h.data);
  const result = await h.service.entry.wake(h.room.id, member.id);
  assert.ok(['connecting', 'already_running', 'ready'].includes(result.status));
  await until(() => h.service.chat.store.member(member.id).status === 'ready' && !h.service.chat.active.size, 'resumed native fixture');
  assert.equal(h.service.chat.store.binding(h.room.id, member.id).thread_id, nativeThread);
  assert.equal(h.service.chat.store.message(uncertain.id).status, 'uncertain');
  assert.equal(h.clients.some(client => client.calls.some(call => !call.handshake)), false);
  assert.equal(h.service.runtime.memberState(member.id).worker_online, true);
});

test('recovering API checks its daemon for each call and only retries a definitely refused POST once', async () => {
  let ensures = 0, calls = 0;
  const api = createRecoveringApi('fixture-dir', { ensure: async () => { ensures++; }, call: async (dir, route, input) => {
    calls++; assert.equal(dir, 'fixture-dir'); assert.equal(route, '/api/fixture');
    if (calls === 1) { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNREFUSED' }; throw error; }
    return { accepted: input.key };
  } });
  assert.deepEqual(await api('/api/fixture', { key: 'same-logical-request' }), { accepted: 'same-logical-request' });
  assert.equal(calls, 2); assert.equal(ensures, 2);
  await api('/api/fixture', { key: 'next' });
  assert.equal(ensures, 3, 'a successful earlier call does not permanently bind the MCP to a dead daemon');
});

test('an interrupted POST is reported uncertain without replay and application errors are preserved', async () => {
  let calls = 0;
  const api = createRecoveringApi('fixture-dir', { ensure: async () => {}, call: async () => { calls++; const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNRESET' }; throw error; } });
  await assert.rejects(() => api('/api/fixture', { key: 'no-blind-replay' }), error => error.code === 'outcome_uncertain');
  assert.equal(calls, 1);
  const conflict = new RoomError('请求内容发生冲突。', 409, 'idempotency_conflict');
  const application = createRecoveringApi('fixture-dir', { ensure: async () => {}, call: async () => { throw conflict; } });
  await assert.rejects(() => application('/api/fixture', { key: 'conflict' }), error => error === conflict);
});

test('MCP can inspect a stopped room without waking its daemon and bound peers can explicitly recover it', async t => {
  const h = await harness(t), caller = participant(h.service, h.room), peer = participant(h.service, h.room, 'unknown-adapter');
  const setup = h.service.entry.issue(caller.id, h.room.id), entry = readEntry(setup.file); acceptEntry(entry);
  bind(t, caller.id, h.room.id);
  const api = createRecoveringApi(h.data, { ensure: h.ensure, call: apiCall, guard: () => readEntry(setup.file) });
  api.diskState = () => diskState(h.data, entry);
  await h.close();
  const stopped = await toolCall('agentroom_room_state', {}, api);
  assert.equal(stopped.service.online, false); assert.equal(stopped.transport, 'disk');
  assert.equal(h.starts, 1, 'offline inspection must not launch the daemon or a model');
  await assert.rejects(() => toolCall('agentroom_room_state', { room_id: id() }, api), /原聊天室/);
  assert.equal(h.starts, 1, 'wrong scope fails before any daemon startup');
  const recovered = await toolCall('agentroom_room_ensure', {}, api);
  assert.equal(recovered.service.online, true); assert.equal(h.starts, 2);
  const heartbeat = await toolCall('agentroom_heartbeat', {}, api);
  assert.equal(heartbeat.runtime_state.member_id, caller.id);
  const wake = await toolCall('agentroom_member_wake', { member_id: peer.id }, api);
  assert.equal(wake.status, 'needs_external_entry');
  const otherRoom = h.service.chat.addRoom({ project_id: h.project.id, title: '其他作用域' });
  const outside = participant(h.service, otherRoom, 'unknown-adapter');
  await assert.rejects(() => toolCall('agentroom_member_wake', { member_id: outside.id }, api), error => error.status === 403 && error.code === 'not_in_room');
  await assert.rejects(() => toolCall('agentroom_heartbeat', { member_id: peer.id }, api), /未知参数/);
  assert.equal(h.clients.length, 0);
});

test('a revoked entry guard fails before daemon startup or operation dispatch', async t => {
  const h = await harness(t), member = participant(h.service, h.room), setup = h.service.entry.issue(member.id, h.room.id);
  h.service.entry.revoke(member.id, h.room.id);
  await h.close();
  let starts = 0, dispatches = 0;
  const api = createRecoveringApi(h.data, { guard: () => readEntry(setup.file), ensure: async () => { starts++; }, call: async () => { dispatches++; } });
  await assert.rejects(() => api('/api/runtime'), error => error.code === 'resume_revoked');
  assert.equal(starts, 0); assert.equal(dispatches, 0);
});

test('an entry guard resolves record IDs before startup and refuses records in rooms the member is not seated in, and management writes', async t => {
  const h = await harness(t), member = participant(h.service, h.room), peer = participant(h.service, h.room);
  const setup = h.service.entry.issue(member.id, h.room.id), entry = readEntry(setup.file); acceptEntry(entry);
  const otherRoom = h.service.chat.addRoom({ title: '另一个聊天室', project_id: h.project.id });
  h.service.chat.join(otherRoom.id, member.id); h.service.chat.join(otherRoom.id, peer.id);
  const inside = h.service.chat.store.post({ room_id: h.room.id, sender_id: member.id, to_member_id: peer.id, text: '自己房间的记录', idempotency_key: 'scope-inside' });
  const outside = h.service.chat.store.post({ room_id: otherRoom.id, sender_id: peer.id, to_member_id: member.id, text: '其他房间同成员的记录', idempotency_key: 'scope-outside' });
  const invitation = h.service.chat.store.createInvite({ room_id: otherRoom.id, member_id: member.id });
  const bindInside = h.service.bridge.store.bind({ member_id: member.id, room_id: h.room.id, provider: 'generic', conversation_ref: 'scope/own' });
  const bindOutside = h.service.bridge.store.bind({ member_id: member.id, room_id: otherRoom.id, provider: 'generic', conversation_ref: 'scope/other-room' });
  const bindPeer = h.service.bridge.store.bind({ member_id: peer.id, room_id: h.room.id, provider: 'generic', conversation_ref: 'scope/other-member' });
  const ownBridge = h.service.bridge.store.submit({ binding_id: bindInside.id, target_member_id: peer.id, external_message_id: 'own', text: '房间内自己的桥接请求' });
  const outsideBridge = h.service.bridge.store.submit({ binding_id: bindOutside.id, target_member_id: peer.id, external_message_id: 'other-room', text: '另一个房间的桥接请求' });
  const peerBridge = h.service.bridge.store.submit({ binding_id: bindPeer.id, target_member_id: member.id, external_message_id: 'other-member', text: '同房间其他成员的桥接请求' });
  // The member leaves the other room, so every record there is outside its seats.
  h.service.chat.store.leave(otherRoom.id, member.id);
  await h.close();
  let starts = 0, dispatched = 0;
  const api = createRecoveringApi(h.data, { ensure: async () => { starts++; }, call: async () => { dispatched++; return { allowed: true }; }, guard: (route, input) => {
    const disk = openDisk(h.data, { readOnly: true });
    try { disk.resume.inspect(entry.card); assertEntryScope(disk, entry.card, route, input); }
    finally { disk.close(); }
  } });
  const denied = [
    ['/api/chat/rooms/' + h.room.id, {}],
    ['/api/connection/doctor?room_id=' + h.room.id + '&member_id=' + member.id],
    [`/api/chat/rooms/${otherRoom.id}`],
    [`/api/chat/messages/${outside.id}/wait?seconds=0`],
    [`/api/chat/messages/${outside.id}/reply`, { member_id: member.id, text: '越过入口范围的回答' }],
    [`/api/chat/invitations/${invitation.id}`],
    [`/api/bridge/entries/${outsideBridge.id}`],
    [`/api/bridge/entries/${peerBridge.id}`],
    ['/api/runtime?room_id=' + otherRoom.id],
    ['/api/chat/messages', { room_id: otherRoom.id, sender_id: member.id, text: '越过房间' }],
    ['/api/chat/messages', { room_id: h.room.id, sender_id: peer.id, text: '冒用成员' }],
    ['/api/runtime/wake', { room_id: h.room.id, member_id: peer.id, caller_member_id: peer.id }],
    ['/api/projects', { path: h.project }],
    ['/api/requests', { discussion_id: 'not-current-room' }],
    ['/api/resume/issue', { member_id: peer.id, room_id: h.room.id }],
    ['/api/bridge/setup', { member_id: member.id, room_id: h.room.id }],
    ['/api/chat/rooms', { project_id: h.project.id, title: '未经本机管理界面创建' }],
    ['/api/chat/members', { name: '未经本机管理界面添加', adapter: 'mailbox' }],
    [`/api/chat/members/${peer.id}/connect`, { room_id: h.room.id }],
    [`/api/chat/members/${peer.id}/heartbeat`, {}],
    [`/api/chat/members/${member.id}/grok-configure`, { url: 'https://fixture.invalid', key: 'fixture-provider-configuration' }],
    ['/api/grok/configure', { url: 'https://fixture.invalid', key: 'fixture-provider-configuration' }],
    ['/api/shutdown', {}],
    ['/api/resume/accept', { card: { ...entry.card, member_id: peer.id } }]
  ];
  for (const [route, input] of denied) await assert.rejects(() => api(route, input), error => error.code === 'resume_scope_mismatch', route);
  assert.equal(starts, 0, 'scope violations are rejected before daemon recovery'); assert.equal(dispatched, 0);
  assert.deepEqual(await api(`/api/chat/messages/${inside.id}/wait?seconds=0`), { allowed: true });
  assert.deepEqual(await api(`/api/bridge/entries/${ownBridge.id}/wait?seconds=0`), { allowed: true });
  assert.deepEqual(await api('/api/runtime/wake', { room_id: h.room.id, member_id: peer.id, caller_member_id: member.id }), { allowed: true });
  assert.equal(starts, 3); assert.equal(dispatched, 3);
});

test('one persistent MCP connection continues after daemon shutdown and restores the original room', async t => {
  const h = await harness(t), member = participant(h.service, h.room), setup = h.service.entry.issue(member.id, h.room.id);
  const entry = readEntry(setup.file); acceptEntry(entry);
  const originalInstance = h.service.runtime.instanceId;
  const previous = Object.fromEntries(['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER'].map(key => [key, process.env[key]]));
  process.env.AGENTROOM_MEMBER_ID = member.id; process.env.AGENTROOM_ROOM_ID = h.room.id; process.env.AGENTROOM_CALLER = 'persistent MCP fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const input = new PassThrough(), output = new PassThrough(); let raw = ''; output.on('data', chunk => { raw += chunk; });
  const api = createRecoveringApi(h.data, { ensure: h.ensure, call: apiCall });
  const connection = runMcp(api, input, output); t.after(() => { connection.close(); input.end(); });
  async function request(requestId, method, params) {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    let found;
    await until(() => { found = raw.trim().split('\n').filter(Boolean).map(JSON.parse).find(response => response.id === requestId); return !!found; }, `MCP response ${requestId}`);
    assert.equal(found.error, undefined);
    assert.equal(found.result?.isError, undefined);
    return found.result;
  }
  await request(1, 'initialize', { protocolVersion: '2025-06-18' });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const first = await request(2, 'tools/call', { name: 'agentroom_chat_history', arguments: { room_id: h.room.id } });
  assert.match(first.content[0].text, new RegExp(h.room.id));
  await h.close();
  assert.equal(diskState(h.data, entry).service.online, false);
  const next = await request(3, 'tools/call', { name: 'agentroom_chat_post', arguments: { room_id: h.room.id, text: '同一个MCP连接恢复后的公告', idempotency_key: 'after-cold-restart' } });
  assert.match(next.content[0].text, /同一个MCP连接恢复后的公告/);
  assert.equal(h.starts, 2); assert.equal(h.service.runtime.instanceId, originalInstance);
  assert.equal(h.service.chat.store.rooms().length, 1);
  assert.equal(h.service.chat.store.messages(h.room.id).length, 1);
  assert.equal(h.service.entry.issue(member.id, h.room.id).credential_id, setup.credential_id);
  assert.equal(h.service.chat.store.db.prepare('SELECT count(*) AS count FROM chat_invitations').get().count, 0);
});

test('the real stdio entry follows its credential after deletion without restarting the MCP process', async t => {
  const h = await harness(t), member = participant(h.service, h.room);
  const setup = h.service.entry.issue(member.id, h.room.id), entry = readEntry(setup.file);
  const executable = process.env.AGENTOFFICE_TEST_EXECUTABLE || process.execPath;
  const prefix = process.env.AGENTOFFICE_TEST_EXECUTABLE ? [] : [path.resolve(__dirname, '../src/main.cjs')];
  const child = spawn(executable, [...prefix, 'mcp', '--entry', setup.file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let raw = '', errors = ''; child.stdout.on('data', value => { raw += value; }); child.stderr.on('data', value => { errors += value; });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); } });
  let sequence = 0;
  async function request(method, params, allowError = false) {
    const requestId = ++sequence;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    let found;
    await until(() => { found = raw.trim().split('\n').filter(Boolean).map(JSON.parse).find(value => value.id === requestId); return !!found || child.exitCode !== null; }, 'stdio response');
    assert.ok(found, errors); assert.equal(found.error, undefined); if (!allowError) assert.equal(found.result?.isError, undefined, JSON.stringify(found));
    return found.result;
  }
  await request('initialize', { protocolVersion: '2025-06-18' });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await request('tools/call', { name: 'agentroom_room_state', arguments: {} });
  h.service.chat.store.deleteRoom(h.room.id, () => {}, { force: true });
  const empty = await request('tools/call', { name: 'agentroom_chat_rooms', arguments: {} });
  assert.deepEqual(empty.structuredContent.rooms, []);
  await request('tools/list', {});
  assert.deepEqual(diskState(h.data, entry).rooms, []);
  const fresh = h.service.chat.addRoom({ project_id: h.project.id, title: '重新加入的房间' });
  h.service.chat.join(fresh.id, member.id);
  const state = await request('tools/call', { name: 'agentroom_room_state', arguments: {} });
  assert.deepEqual(state.structuredContent.rooms.map(room => room.id), [fresh.id]);
  const rooms = await request('tools/call', { name: 'agentroom_chat_rooms', arguments: {} });
  assert.equal(rooms.structuredContent.current_room_id, fresh.id);
  assert.deepEqual(diskState(h.data, entry).rooms.map(room => room.id), [fresh.id]);
  const denied = h.service.chat.addRoom({ project_id: h.project.id, title: '未授权的房间' });
  const refused = await request('tools/call', { name: 'agentroom_chat_history', arguments: { room_id: denied.id } }, true);
  assert.equal(refused.isError, true);
  h.service.resume.revoke(setup.credential_id);
  h.service.chat.store.leave(fresh.id, member.id); h.service.chat.join(fresh.id, member.id);
  assert.equal(h.service.resume.credential(setup.credential_id).status, 'revoked');
});

test('connection instructions reuse the moved entry file and credential instead of issuing another URL', async t => {
  const h = await harness(t), member = participant(h.service, h.room), setup = h.service.entry.issue(member.id, h.room.id);
  acceptEntry(readEntry(setup.file));
  const bytes = fs.readFileSync(setup.file);
  h.service.chat.store.deleteRoom(h.room.id, () => {}, { force: true });
  const fresh = h.service.chat.addRoom({ project_id: h.project.id, title: '新房间' }); h.service.chat.join(fresh.id, member.id);
  const current = h.service.entry.primary(member.id, fresh.id);
  assert.equal(current.credential_id, setup.credential_id);
  assert.equal(current.file, setup.file);
  assert.deepEqual(fs.readFileSync(setup.file), bytes);
  assert.equal(h.service.resume.credentials(member.id).length, 1);
});
