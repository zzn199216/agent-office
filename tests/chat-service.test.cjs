'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { toolCall } = require('../src/mcp.cjs');
const { id, sleep } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

// Protocol fixture only: no live model, external webhook or native account is
// used. Handshake success is deliberately an actual ChatManager tool operation,
// independent of the fixture's returned model text.
class NativeChatFixture extends EventEmitter {
  constructor(member, service, options = {}) {
    super(); this.member = member; this.service = service; this.options = options;
    this.calls = []; this.concurrent = 0; this.maxConcurrent = 0; this.threadId = id(); this.closed = false;
  }
  async status() { return { connected: !this.closed, fixture: true }; }
  async run(input) {
    this.concurrent++; this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const handshake = input.request.prompt.includes('真实接入握手');
    this.calls.push({ id: input.request.id, handshake, prior_thread: input.discussion.thread_id, prompt: input.request.prompt });
    try {
      if (!input.discussion.thread_id) { input.onBinding('creating'); input.onBinding('bound', this.threadId); }
      else assert.equal(input.discussion.thread_id, this.threadId);
      input.onTurn(id());
      if (handshake) {
        await sleep(10);
        const values = input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);
        assert.ok(values, 'fixture must parse the issued invitation, never manufacture verification');
        if (this.options.performHandshake !== false) this.service.chat.completeInvite(values[1], values[2], this.member.id);
        return { threadId: this.threadId, turnId: id(), answer: '已加入聊天室' };
      }
      const current = this.service.chat.store.message(input.request.id);
      input.onProgress?.('协议测试正在处理消息。');
      let abort;
      const cancelled = new Promise((resolve, reject) => {
        abort = () => { const error = new Error('fixture cancelled'); error.code = 'cancelled'; reject(error); };
        input.signal.addEventListener('abort', abort, { once: true });
      });
      let answer;
      try { answer = await Promise.race([this.options.answer ? this.options.answer(current, input, this) : Promise.resolve(`fixture回答：${current.text}`), cancelled]); }
      finally { input.signal.removeEventListener('abort', abort); }
      if (input.signal.aborted) { const error = new Error('fixture cancelled'); error.code = 'cancelled'; throw error; }
      return { threadId: this.threadId, turnId: id(), answer };
    } finally { this.concurrent--; }
  }
  async close() { this.closed = true; }
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('Gemini joins through its issued MCP invitation and keeps question replies in the same session', async t => {
  const v=setup(t),member=v.service.chat.addMember({name:'Gemini CLI 协作 fixture',adapter:'gemini-cli'});
  await v.service.chat.connect(member.id,v.room.id);
  await until(()=>v.service.chat.store.member(member.id).status==='ready'&&!v.service.chat.active.size);
  assert.ok(v.service.chat.store.member(member.id).verified_at);
  const thread=v.service.chat.store.binding(v.room.id,member.id).thread_id;
  for(const key of ['gemini-first','gemini-second']){
    const message=v.service.chat.post({room_id:v.room.id,to_member_id:member.id,text:key,idempotency_key:key});
    await until(()=>v.service.chat.store.message(message.id).status==='answered'&&!v.service.chat.active.size);
    const reply=v.service.chat.store.messages(v.room.id).find(item=>item.reply_to===message.id);
    assert.equal(reply.text,'fixture回答：'+key);
    assert.equal(reply.sender_id,member.id);
    assert.equal(v.service.chat.store.binding(v.room.id,member.id).thread_id,thread);
    assert.equal(v.service.runtime.memberState(member.id).worker_online,false,'completed Gemini child must not remain working');
  }
  assert.deepEqual(v.clients.get(member.id).calls.map(call=>call.handshake),[true,false,false]);
  assert.equal(v.clients.get(member.id).calls[2].prior_thread,thread);
});

test('Gemini cannot become ready from a text claim without its actual invitation operation', async t => {
  const v=setup(t,{native:()=>({performHandshake:false})}),member=v.service.chat.addMember({name:'未握手 Gemini fixture',adapter:'gemini-cli'});
  await v.service.chat.connect(member.id,v.room.id);
  await until(()=>v.service.chat.store.member(member.id).status==='connection_failed');
  assert.equal(v.service.chat.store.member(member.id).verified_at,null);
  assert.equal(v.service.runtime.memberState(member.id).worker_online,false);
  assert.equal(v.clients.get(member.id).calls.length,1);
});

for(const [adapter,code,name]of [['qwen-code','qwen_login_required','Qwen'],['claude-code','claude_api_auth_required','Claude']])test(name+': expired native authentication clears availability and blocks queued work until explicit repair', async t => {
  const wait=gate();let expired=true;
  const v=setup(t,{native:()=>({answer:async()=>{await wait.promise;if(expired){const error=new Error('Qwen Code 模型认证已失效');error.code=code;throw error;}return '恢复后的回答';}})});
  const member=v.service.chat.addMember({name,adapter});await v.service.chat.connect(member.id,v.room.id);
  await until(()=>v.service.chat.store.member(member.id).status==='ready'&&!v.service.chat.active.size);
  const thread=v.service.chat.store.binding(v.room.id,member.id).thread_id;
  const first=v.service.chat.post({room_id:v.room.id,to_member_id:member.id,text:'已开始的问题',idempotency_key:'auth-first'});
  const second=v.service.chat.post({room_id:v.room.id,to_member_id:member.id,text:'尚未开始的问题',idempotency_key:'auth-queued'});
  wait.resolve();await until(()=>!v.service.chat.active.size);
  assert.equal(v.service.chat.store.message(first.id).status,'failed');assert.equal(v.service.chat.store.message(second.id).status,'failed');
  assert.equal(v.service.chat.store.member(member.id).status,'connection_failed');assert.equal(v.clients.get(member.id).calls.filter(call=>!call.handshake).length,1);
  assert.equal(v.service.runtime.memberState(member.id).worker_online,false);
  expired=false;await v.service.chat.connect(member.id,v.room.id);await until(()=>v.service.chat.store.member(member.id).status==='ready'&&!v.service.chat.active.size);
  assert.equal(v.service.chat.store.binding(v.room.id,member.id).thread_id,thread);
  assert.equal(v.clients.get(member.id).calls.filter(call=>!call.handshake).length,1,'failed business requests are never replayed by reconnect');
});

test('a business permission denial leaves a native connection available', async t => {
  const v=setup(t,{native:()=>({answer:async()=>{const error=new Error('Qwen Code 拒绝超出权限的操作');error.code='qwen_permission_denied';throw error;}})});
  const member=await nativeMember(v.service,v.room,'受限成员');
  const message=v.service.chat.post({room_id:v.room.id,to_member_id:member.id,text:'执行超出范围的任务',idempotency_key:'business-denied'});
  await until(()=>!v.service.chat.active.size);
  assert.equal(v.service.chat.store.message(message.id).status,'failed');assert.equal(v.service.chat.store.member(member.id).status,'ready');
  assert.equal(v.service.chat.store.member(member.id).error,null);
});

test('a live owned native child reports processing contact before the first periodic heartbeat',async t=>{
  const waiting=gate(),v=setup(t,{native:()=>({answer:()=>waiting.promise})}),member=v.service.chat.addMember({name:'临时 Qwen 工作会话',adapter:'qwen-code'});
  await v.service.chat.connect(member.id,v.room.id);await until(()=>v.service.chat.store.member(member.id).status==='ready'&&!v.service.chat.active.size);
  const client=v.clients.get(member.id);client.child={pid:process.pid};
  const message=v.service.chat.post({room_id:v.room.id,to_member_id:member.id,text:'核实资料',idempotency_key:'immediate-worker-contact'});
  await until(()=>v.service.chat.store.message(message.id).status==='processing');assert.equal(v.service.runtime.memberState(member.id).worker_online,true);
  waiting.resolve('已核实');await until(()=>!v.service.chat.active.size);assert.equal(v.service.runtime.memberState(member.id).worker_online,false,'completed ephemeral worker cannot keep a typing indication');
});
async function until(predicate, message = 'state transition', timeout = 2500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${message}`);
}
function setup(t, options = {}) {
  const f = fixture(), clients = new Map(); let service;
  service = new RoomService(f.data, { codex: new FakeCodex(), vault: new FakeVault(), fetch: options.fetch || (async () => ({ ok: true, status: 200, json: async () => ({ success: true, runUuid: 'fixture-webhook' }) })), chat: { clientFactory(member) {
    const client = new NativeChatFixture(member, service, options.native?.(member) || {}); clients.set(member.id, client); return client;
  } } });
  t.after(async () => { await service.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const project = service.addProject({ path: f.project, name: '聊天室协议测试项目' });
  const room = service.chat.addRoom({ title: '开发运营群', project_id: project.id });
  return { ...f, service, clients, project, room };
}
async function nativeMember(service, room, name = 'Codex 成员') {
  const member = service.chat.addMember({ name, adapter: 'codex' });
  await service.chat.connect(member.id, room.id);
  await until(() => service.chat.store.member(member.id).status === 'ready' && !service.chat.active.has(member.id), 'verified native join');
  return member;
}
async function apiFor(t, service) {
  const token = id(), server = createServer(service, { token, port: 0 });
  const port = await server.listen(); t.after(() => server.close());
  return async (resource, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.status = response.status; error.code = result.code; throw error; }
    return result;
  };
}
function bindIdentity(t, memberId, roomId) {
  const previous = Object.fromEntries(['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER'].map(key => [key, process.env[key]]));
  process.env.AGENTROOM_MEMBER_ID = memberId; process.env.AGENTROOM_ROOM_ID = roomId; process.env.AGENTROOM_CALLER = 'fixture participant';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('a native text claim without the issued handshake fails once and does not loop retry', async t => {
  const { service, clients, room } = setup(t, { native: () => ({ performHandshake: false }) });
  const member = service.chat.addMember({ name: '只声称加入的 fixture', adapter: 'codex' });
  await service.chat.connect(member.id, room.id);
  const message = service.chat.post({ room_id: room.id, to_member_id: member.id, text: '待握手后执行', idempotency_key: 'failed-handshake-question' });
  await until(() => service.chat.store.member(member.id).status === 'connection_failed', 'failed real handshake');
  assert.equal(service.chat.store.member(member.id).verified_at, null);
  assert.equal(service.chat.store.message(message.id).status, 'failed');
  assert.match(service.chat.store.member(member.id).error, /没有完成真实握手/);
  await sleep(100);
  assert.equal(clients.get(member.id).calls.length, 1);
  assert.equal(service.chat.active.size, 0);
});

test('announcements remain visible and never wake every member', async t => {
  const { service, clients, room } = setup(t);
  const first = await nativeMember(service, room, '开发成员');
  const second = await nativeMember(service, room, '运营成员');
  const count = [...clients.values()].reduce((sum, client) => sum + client.calls.length, 0);
  const announcement = service.chat.post({ room_id: room.id, text: '今天更新项目计划。', idempotency_key: 'announcement-only' });
  assert.equal(announcement.status, 'posted');
  await sleep(50);
  assert.equal([...clients.values()].reduce((sum, client) => sum + client.calls.length, 0), count);
  assert.equal(service.chat.store.inbox(first.id).length, 0);
  assert.equal(service.chat.store.inbox(second.id).length, 0);
  assert.equal(service.chat.room(room.id).messages.at(-1).id, announcement.id);
});

test('same-name native members run independently in parallel while each preserves a serial session', async t => {
  const alphaGate = gate(), betaGate = gate(); const gates = new Map();
  const { service, clients, room } = setup(t, { native: member => ({ answer: async (message, input, client) => {
    if (client.calls.filter(call => !call.handshake).length === 1) await gates.get(member.id).promise;
    return `${member.id}回答：${message.text}`;
  } }) });
  t.after(() => { alphaGate.resolve(); betaGate.resolve(); });
  const alpha = await nativeMember(service, room, '同名 Codex');
  const beta = await nativeMember(service, room, '同名 Codex');
  gates.set(alpha.id, alphaGate); gates.set(beta.id, betaGate);
  assert.notEqual(alpha.id, beta.id);
  const a = service.chat.post({ room_id: room.id, to_member_id: alpha.id, text: 'A 第一问', idempotency_key: 'a1' });
  const a2 = service.chat.post({ room_id: room.id, to_member_id: alpha.id, text: 'A 第二问', idempotency_key: 'a2' });
  const b = service.chat.post({ room_id: room.id, to_member_id: beta.id, text: 'B 第一问', idempotency_key: 'b1' });
  await until(() => service.chat.active.size === 2, 'two independent native lanes');
  assert.equal(service.chat.store.message(a2.id).status, 'queued');
  assert.equal(clients.get(alpha.id).concurrent, 1);
  assert.equal(clients.get(beta.id).concurrent, 1);
  betaGate.resolve();
  await until(() => service.chat.store.message(b.id).status === 'answered', 'B result while A still running');
  assert.equal(service.chat.store.message(a.id).status, 'processing');
  assert.equal(service.chat.store.message(a2.id).status, 'queued');
  alphaGate.resolve();
  await until(() => service.chat.store.message(a2.id).status === 'answered', 'serial A follow-up');
  assert.equal(clients.get(alpha.id).maxConcurrent, 1);
  assert.equal(clients.get(beta.id).maxConcurrent, 1);
  const alphaThread = service.chat.store.binding(room.id, alpha.id).thread_id;
  const betaThread = service.chat.store.binding(room.id, beta.id).thread_id;
  assert.notEqual(alphaThread, betaThread);
  assert.ok(clients.get(alpha.id).calls.filter(call => !call.handshake).every(call => call.prior_thread === alphaThread));
  const responses = service.chat.room(room.id).messages.filter(message => message.kind === 'reply');
  assert.equal(responses.length, 3);
  assert.ok(responses.every(message => message.room_id === room.id && message.to_member_id === null));
  assert.equal(responses.find(message => message.reply_to === a2.id).sender_id, alpha.id);
});

test('generic mailbox members use the same inbox and replies return to the originating peer and room', async t => {
  const { service, clients, room } = setup(t);
  const api = await apiFor(t, service);
  const alpha = service.chat.addMember({ name: '未来 Agent Alpha', adapter: 'custom-future-tool' });
  const beta = service.chat.addMember({ name: '未来 Agent Beta', adapter: 'mailbox' });
  const inviteAlpha = await service.chat.connect(alpha.id, room.id);
  bindIdentity(t, alpha.id, room.id);
  await toolCall('agentroom_join', { invite_id: inviteAlpha.invite.id, nonce: inviteAlpha.invite.nonce }, api);
  const inviteBeta = await service.chat.connect(beta.id, room.id);
  process.env.AGENTROOM_MEMBER_ID = beta.id;
  await toolCall('agentroom_join', { invite_id: inviteBeta.invite.id, nonce: inviteBeta.invite.nonce }, api);
  process.env.AGENTROOM_MEMBER_ID = alpha.id;
  const question = await toolCall('agentroom_chat_post', { room_id: room.id, to_member_id: beta.id, text: '你认为方案如何？', idempotency_key: 'peer-question' }, api);
  assert.equal(question.sender_id, alpha.id);
  assert.equal(question.status, 'queued');
  process.env.AGENTROOM_MEMBER_ID = beta.id;
  assert.equal((await toolCall('agentroom_chat_inbox', {}, api))[0].id, question.id);
  const answer = await toolCall('agentroom_chat_reply', { message_id: question.id, text: '这是实际确认后的意见。', idempotency_key: 'peer-answer' }, api);
  assert.equal(answer.sender_id, beta.id);
  assert.equal(answer.to_member_id, alpha.id);
  assert.equal(answer.room_id, room.id);
  assert.equal(answer.reply_to, question.id);
  assert.equal(service.chat.store.message(question.id).status, 'answered');
  assert.equal((await toolCall('agentroom_chat_reply', { message_id: question.id, text: '这是实际确认后的意见。', idempotency_key: 'peer-answer' }, api)).id, answer.id);
  process.env.AGENTROOM_MEMBER_ID = alpha.id;
  assert.equal((await toolCall('agentroom_chat_inbox', {}, api))[0].id, answer.id);
  assert.equal((await toolCall('agentroom_chat_ack', { message_id: answer.id }, api)).status, 'consumed');
  assert.equal(clients.size, 0, 'generic mailbox never silently manufactures a native adapter');
  await assert.rejects(() => toolCall('agentroom_chat_post', { room_id: room.id, to_member_id: alpha.id, text: '自己排给自己', idempotency_key: 'self' }, api), /不能给自己/);
});

test('MCP bound identities cannot reply or acknowledge another member’s delivery', async t => {
  const { service, room } = setup(t), api = await apiFor(t, service);
  const alpha = service.chat.addMember({ name: '成员甲', adapter: 'mailbox' });
  const beta = service.chat.addMember({ name: '成员乙', adapter: 'mailbox' });
  service.chat.join(room.id, alpha.id); service.chat.join(room.id, beta.id);
  const addressed = service.chat.post({ room_id: room.id, to_member_id: beta.id, text: '只发给乙', idempotency_key: 'private-target' });
  bindIdentity(t, alpha.id, room.id);
  await assert.rejects(() => toolCall('agentroom_chat_reply', { message_id: addressed.id, text: '冒名回复', idempotency_key: 'wrong' }, api), error => error.status === 403);
  await assert.rejects(() => toolCall('agentroom_chat_ack', { message_id: addressed.id }, api), error => error.status === 403);
  assert.equal(service.chat.store.message(addressed.id).status, 'queued');
  assert.equal(service.chat.room(room.id).messages.length, 1);
  const betaInvitation = await service.chat.connect(beta.id, room.id);
  await assert.rejects(() => toolCall('agentroom_join', { invite_id: betaInvitation.invite.id, nonce: betaInvitation.invite.nonce }, api), error => error.status === 403);
  assert.equal(service.chat.store.member(beta.id).verified_at, null);
});

test('native peer replies return to the original member and stop after acknowledgment', async t => {
  const { service, clients, room } = setup(t);
  const alpha = await nativeMember(service, room, '原始提问成员');
  const beta = await nativeMember(service, room, '被问成员');
  const question = service.chat.post({ room_id: room.id, sender_id: alpha.id, to_member_id: beta.id, text: '请核实接口定义', idempotency_key: 'native-peer-question' });
  await until(() => {
    const response = service.chat.store.messages(room.id).find(message => message.reply_to === question.id);
    return response?.status === 'consumed' && service.chat.active.size === 0;
  }, 'peer answer acknowledged');
  const messages = service.chat.room(room.id).messages;
  const response = messages.find(message => message.reply_to === question.id);
  const acknowledgment = messages.find(message => message.reply_to === response.id);
  assert.equal(response.sender_id, beta.id);
  assert.equal(response.to_member_id, alpha.id);
  assert.equal(response.room_id, room.id);
  assert.equal(acknowledgment.kind, 'acknowledgment');
  assert.equal(acknowledgment.to_member_id, null);
  assert.equal(acknowledgment.status, 'posted');
  assert.equal(service.chat.store.message(question.id).status, 'answered');
  const counts = [...clients.values()].map(client => client.calls.length);
  await sleep(100);
  assert.deepEqual([...clients.values()].map(client => client.calls.length), counts);
  assert.deepEqual(counts, [2, 2], 'one handshake and one addressed run per native member');
  assert.equal(service.chat.room(room.id).messages.length, 3);
});

test('a member identity works in every room it is seated in and nowhere else', async t => {
  const { service, room, project } = setup(t), api = await apiFor(t, service);
  const otherRoom = service.chat.addRoom({ title: '另一个已加入房间', project_id: project.id });
  const foreignRoom = service.chat.addRoom({ title: '没有加入的房间', project_id: project.id });
  const member = service.chat.addMember({ name: '同一个成员', adapter: 'mailbox' });
  service.chat.join(room.id, member.id); service.chat.join(otherRoom.id, member.id);
  const otherMessage = service.chat.post({ room_id: otherRoom.id, to_member_id: member.id, text: '另一房间消息', idempotency_key: 'other-room' });
  bindIdentity(t, member.id, room.id);
  // Seated in the other room: the same credential works there without a new config.
  assert.equal((await toolCall('agentroom_chat_history', { room_id: otherRoom.id }, api)).room.id, otherRoom.id);
  const inbox = await toolCall('agentroom_chat_inbox', {}, api);
  assert.ok(JSON.stringify(inbox).includes(otherMessage.id), 'inbox without room covers every seated room');
  const posted = await toolCall('agentroom_chat_post', { room_id: otherRoom.id, text: '跨房间发言', idempotency_key: 'other-post' }, api);
  assert.equal(posted.room_id, otherRoom.id);
  const rooms = await toolCall('agentroom_chat_rooms', {}, api);
  assert.deepEqual(rooms.rooms.map(value => value.id).sort(), [room.id, otherRoom.id].sort());
  // Not seated: refused for explicit rooms and for records addressed by id.
  const foreigner = service.chat.addMember({ name: '外部成员', adapter: 'mailbox' }); service.chat.join(foreignRoom.id, foreigner.id);
  const foreignMessage = service.chat.post({ room_id: foreignRoom.id, to_member_id: foreigner.id, text: '别人的房间', idempotency_key: 'foreign' });
  await assert.rejects(() => toolCall('agentroom_chat_history', { room_id: foreignRoom.id }, api));
  await assert.rejects(() => toolCall('agentroom_chat_post', { room_id: foreignRoom.id, text: '不能越过座位', idempotency_key: 'foreign-post' }, api));
  await assert.rejects(() => toolCall('agentroom_chat_wait', { message_id: foreignMessage.id, seconds: 0 }, api));
  await assert.rejects(() => toolCall('agentroom_chat_reply', { message_id: foreignMessage.id, text: '不能回复', idempotency_key: 'foreign-reply' }, api));
  assert.equal(service.chat.store.message(foreignMessage.id).status, 'queued');
  // Leaving a room removes access to it at once.
  service.chat.leave(otherRoom.id, member.id);
  await assert.rejects(() => toolCall('agentroom_chat_history', { room_id: otherRoom.id }, api));
});

test('a Grok bridge webhook acceptance stays delivered until an actual mailbox reply arrives', async t => {
  const posts = [];
  const { service, room } = setup(t, { fetch: async (url, options) => { posts.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ success: true, runUuid: 'fixture-accepted-only' }) }; } });
  const member = service.chat.addMember({ name: 'Grok 群桥接 fixture', adapter: 'grok-bridge' });
  const invitation = await service.chat.connect(member.id, room.id);
  service.chat.completeInvite(invitation.invite.id, invitation.invite.nonce, member.id);
  await service.chat.configureGrok(member.id, 'https://api2.cursor.sh/automations/webhook/chat-fixture-only', 'crsr_fixture_chat_only');
  const question = service.chat.post({ room_id: room.id, to_member_id: member.id, text: '请在原群核实这个问题', idempotency_key: 'grok-delivery' });
  await until(() => service.chat.store.message(question.id).status === 'delivered', 'webhook acceptance');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].message_id, question.id);
  assert.equal(posts[0].room_id, room.id);
  assert.equal((await service.chat.wait(question.id, 0)).responses.length, 0);
  assert.equal(service.chat.store.inbox(member.id)[0].id, question.id);
  const retried = service.chat.post({ room_id: room.id, to_member_id: member.id, text: '请在原群核实这个问题', idempotency_key: 'grok-delivery' });
  assert.equal(retried.id, question.id);
  await sleep(20);
  assert.equal(posts.length, 1, 'an idempotent retry must not send the accepted webhook again');
  const answer = service.chat.reply(question.id, member.id, '已核实后的实际答复', 'grok-actual-answer');
  assert.equal(service.chat.store.message(question.id).status, 'answered');
  assert.equal(answer.reply_to, question.id);
  assert.equal(answer.room_id, room.id);
  assert.equal(answer.to_member_id, null);
  assert.equal(posts.length, 1);
});

test('an uncertain bridge notification is retained for review and not automatically resent', async t => {
  let posts = 0;
  const { service, room } = setup(t, { fetch: async () => { posts++; throw new Error('fixture lost response after upstream may have received request'); } });
  const member = service.chat.addMember({ name: '失去回执的桥接 fixture', adapter: 'grok-bridge' });
  const invitation = await service.chat.connect(member.id, room.id);
  service.chat.completeInvite(invitation.invite.id, invitation.invite.nonce, member.id);
  await service.chat.configureGrok(member.id, 'https://api2.cursor.sh/automations/webhook/uncertain-chat-fixture-only', 'crsr_fixture_uncertain_only');
  const input = { room_id: room.id, to_member_id: member.id, text: '不能重复执行的协作问题', idempotency_key: 'uncertain-grok-message' };
  const question = service.chat.post(input);
  await until(() => service.chat.store.message(question.id).status === 'uncertain', 'uncertain delivery');
  assert.equal(service.chat.post(input).id, question.id);
  await sleep(30);
  assert.equal(posts, 1);
  assert.equal(service.chat.store.message(question.id).status, 'uncertain');
  assert.equal((await service.chat.wait(question.id, 0)).responses.length, 0);
});

test('each client gets the one connection method it can actually use', async t => {
  const { service, room } = setup(t);
  service._localUrl = 'http://127.0.0.1:47831';
  const make = (name, adapter, provider) => { const member = service.chat.addMember({ name, adapter }); if (provider) service.chat.store.updateMember(member.id, { config: { ...service.chat.store.member(member.id).config, launch_provider: provider } }); service.chat.join(room.id, member.id); return member; };
  const qwen = service.chat.setup(make('Qwen 桌面客户端', 'mailbox', 'qwen-desktop').id, room.id).client;
  assert.equal(qwen.kind, 'http_json');
  const config = JSON.parse(qwen.copy).mcpServers.AgentOffice;
  assert.equal(config.type, 'streamable-http'); assert.match(config.url, /^http:\/\/127\.0\.0\.1:47831\/mcp\//);
  assert.ok(qwen.steps.some(step => step.includes('代码解释器')), 'Qwen is warned off its cloud code interpreter');
  const desktop = service.chat.setup(make('Claude 桌面客户端', 'mailbox', 'claude-desktop').id, room.id).client;
  assert.equal(desktop.kind, 'stdio_json');
  const stdio = JSON.parse(desktop.copy).mcpServers.agentoffice;
  assert.ok(stdio.args.includes('--entry')); assert.equal(stdio.env, undefined, 'no member or room id is hardcoded');
  const doubao = service.chat.setup(make('豆包', 'mailbox', 'doubao').id, room.id).client;
  assert.equal(doubao.kind, 'http_fields'); assert.match(doubao.copy, /^http:\/\/127\.0\.0\.1:47831\/mcp\//);
  assert.equal(service.chat.setup(make('Codex', 'codex').id, room.id).client.kind, 'background');
  const grok = service.chat.setup(make('Grok Bot', 'grok-bridge').id, room.id).client;
  assert.equal(grok.kind, 'command'); assert.match(grok.copy, /enter/);
  // The same client keeps one configuration across rooms.
  const member = service.chat.store.members().find(value => value.name === 'Qwen 桌面客户端');
  const other = service.chat.addRoom({ title: '另一间', project_id: room.project_id }); service.chat.join(other.id, member.id);
  service.resume.accept(JSON.parse(require('node:fs').readFileSync(service.entry.issue(member.id, room.id).file, 'utf8')));
  assert.equal(service.chat.setup(member.id, other.id).client.copy, qwen.copy, 'a new room does not need a new import');
});
