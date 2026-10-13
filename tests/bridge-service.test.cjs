'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RoomService } = require('../src/service.cjs');
const { createServer } = require('../src/http.cjs');
const { toolCall, tools } = require('../src/mcp.cjs');
const { id, sleep } = require('../src/util.cjs');
const { fixture, FakeCodex, FakeVault } = require('./helpers.cjs');

// Isolated native protocol fixture. It calls the issued handshake operation and
// answers addressed requests; it does not access a real Codex or Grok account.
class BridgeNativeFixture {
  constructor(member, service) { this.member = member; this.service = service; this.calls = []; this.thread = id(); }
  async status() { return { fixture: true, connected: true }; }
  async run(input) {
    const handshake = input.request.prompt.includes('真实接入握手');
    this.calls.push({ id: input.request.id, handshake, prompt: input.request.prompt });
    if (!input.discussion.thread_id) { input.onBinding('creating'); input.onBinding('bound', this.thread); }
    input.onTurn(id());
    await sleep(5);
    if (handshake) {
      const match = input.request.prompt.match(/invite_id=([a-z0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i);
      assert.ok(match);
      this.service.chat.completeInvite(match[1], match[2], this.member.id);
      return { threadId: this.thread, turnId: id(), answer: '已加入聊天室' };
    }
    const message = this.service.chat.store.message(input.request.id);
    return { threadId: this.thread, turnId: id(), answer: `fixture已核实：${message.text}` };
  }
  async close() {}
}
function createService(data, options = {}) {
  const clients = new Map(); let service;
  service = new RoomService(data, { codex: new FakeCodex(), vault: new FakeVault(), fetch: options.fetch || (async () => { assert.fail('bridge tests must never send an external webhook'); }), bridge: { allowLocalTest: options.allowLocalTest !== false }, chat: { clientFactory(member) { const client = new BridgeNativeFixture(member, service); clients.set(member.id, client); return client; } } });
  return { service, clients };
}
function setup(t, options = {}) {
  const files = fixture(), state = { ...files, ...createService(files.data, options) };
  t.after(async () => { await state.service.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  state.project = state.service.addProject({ path: files.project, name: '桥接服务协议测试' });
  state.room = state.service.chat.addRoom({ title: '群桥接聊天室', project_id: state.project.id });
  state.bridgeMember = state.service.chat.addMember({ name: 'Grok 桥接 fixture', adapter: 'grok-bridge' });
  state.target = state.service.chat.addMember({ name: '开发 fixture', adapter: 'codex' });
  state.service.chat.join(state.room.id, state.bridgeMember.id);
  state.service.chat.join(state.room.id, state.target.id);
  return state;
}
async function until(predicate, label, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${label}`);
}
async function joinBridge(state) {
  const invitation = await state.service.chat.connect(state.bridgeMember.id, state.room.id);
  state.service.chat.completeInvite(invitation.invite.id, invitation.invite.nonce, state.bridgeMember.id);
}
function input(state, fields = {}) {
  return { member_id: state.bridgeMember.id, room_id: state.room.id, target_member_id: state.target.id, text: '请核实群里的开发问题', idempotency_key: 'logical-question-1', conversation_ref: 'fixture-native/group-original', external_message_id: 'fixture-native/message-1', ...fields };
}
async function answered(state, fields = {}) {
  const e = state.service.bridge.request(input(state, fields));
  await until(() => state.service.bridge.entry(e.id).status === 'answered', 'actual fixture answer');
  return state.service.bridge.entry(e.id, state.bridgeMember.id, state.room.id, { forBridge: true });
}
async function apiFor(t, state) {
  const token = id(), server = createServer(state.service, { port: 0, token }), port = await server.listen();
  t.after(() => server.close());
  return async (resource, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${resource}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error); error.status = response.status; error.code = result.code; throw error; }
    return result;
  };
}
function identity(t, memberId, roomId) {
  const previous = Object.fromEntries(['AGENTROOM_MEMBER_ID', 'AGENTROOM_ROOM_ID', 'AGENTROOM_CALLER'].map(key => [key, process.env[key]]));
  process.env.AGENTROOM_MEMBER_ID = memberId; process.env.AGENTROOM_ROOM_ID = roomId; process.env.AGENTROOM_CALLER = 'bridge fixture';
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test('preparing bridge setup creates instructions while actual handshake and native return remain pending', t => {
  const state = setup(t), { service, bridgeMember, room } = state;
  const setupResult = service.bridge.setup(bridgeMember.id, room.id, { group_label: '待实际引用的群' });
  assert.match(setupResult.setup_prompt, /缺少本机执行授权/);
  assert.match(setupResult.setup_prompt, /没有明确目标先让我选定群/);
  assert.equal(setupResult.stages.find(stage => stage.id === 'prompt').state, 'complete');
  assert.equal(setupResult.stages.find(stage => stage.id === 'handshake').state, 'pending');
  assert.equal(setupResult.stages.find(stage => stage.id === 'native_return').state, 'pending');
  assert.equal(setupResult.connection.verified, false);
  assert.equal(state.clients.size, 0);
  assert.equal(service.bridge.entries().length, 0);
  assert.throws(() => service.bridge.request(input(state)), { status: 409, code: 'bridge_not_joined' });
  assert.equal(state.clients.size, 0);
});

test('a chat answer, a bridge report and a human origin check are three separate states', async t => {
  const state = setup(t), api = await apiFor(t, state);
  await joinBridge(state);
  const answer = await answered(state);
  assert.equal(answer.status, 'answered');
  assert.equal(answer.return_verification, 'unverified');
  assert.match(answer.native_return_text, /\[来自 开发 fixture\]/);
  assert.match(answer.native_return_text, /\[AgentRoom AR-[A-F0-9]{10}\]/);
  const ui = await api(`/api/bridge/entries/${answer.id}`);
  assert.equal(Object.hasOwn(ui, 'native_return_text'), false, 'UI must not prefill its own human confirmation code');
  assert.equal(Object.hasOwn(ui, 'verification_code'), false);
  const report = await api(`/api/bridge/entries/${answer.id}/report`, { member_id: state.bridgeMember.id, room_id: state.room.id, conversation_ref: answer.origin.conversation_ref, external_reply_id: 'fixture-native/reply-1' });
  assert.equal(report.status, 'delivered');
  assert.equal(report.return_verification, 'bridge_reported');
  assert.equal(state.service.bridge.store.binding(answer.binding_id).status, 'unverified');
  await assert.rejects(() => api(`/api/bridge/entries/${answer.id}/confirm-return`, { verification_code: 'wrong-code' }), error => error.status === 409);
  const code = answer.native_return_text.match(/\[AgentRoom (AR-[A-F0-9]{10})\]/)[1];
  const confirmed = await api(`/api/bridge/entries/${answer.id}/confirm-return`, { verification_code: code });
  assert.equal(confirmed.return_verification, 'human_confirmed');
  assert.equal(state.service.bridge.setup(state.bridgeMember.id, state.room.id).stages.find(stage => stage.id === 'native_return').state, 'complete');
});

test('repeated source messages preserve one entry and one native question; changed bodies conflict', async t => {
  const state = setup(t); await joinBridge(state);
  const first = state.service.bridge.request(input(state));
  assert.equal(state.service.bridge.request(input(state)).id, first.id);
  await until(() => state.service.bridge.entry(first.id).status === 'answered', 'deduplicated answer');
  const result = state.service.bridge.request(input(state, { idempotency_key: 'new-local-key-for-same-native-message' }));
  assert.equal(result.id, first.id);
  assert.equal(state.service.bridge.store.list().length, 1);
  assert.equal(state.clients.get(state.target.id).calls.filter(call => !call.handshake).length, 1);
  assert.throws(() => state.service.bridge.request(input(state, { text: '改变后的源问题' })), { status: 409, code: 'idempotency_conflict' });
  const peer = state.service.chat.addMember({ name: '第二个处理成员', adapter: 'mailbox' });
  state.service.chat.join(state.room.id, peer.id);
  assert.throws(() => state.service.bridge.request(input(state, { target_member_id: peer.id })), { status: 409, code: 'idempotency_conflict' });
  assert.equal(state.clients.size, 1);
});

test('a correlated bridge answer avoids a new Routine and immediate bridge wait consumes the target reply', async t => {
  const notifications = [];
  const state = setup(t, { fetch: async (url, options) => {
    notifications.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ success: true, runUuid: 'fixture-unlinked-routine-only' }) };
  } });
  await joinBridge(state);
  await state.service.chat.configureGrok(state.bridgeMember.id, 'https://api2.cursor.sh/automations/webhook/correlated-fixture-only', 'crsr_fixture_correlated_only');
  const result = await answered(state);
  const reply = state.service.chat.store.messages(state.room.id).find(message => message.reply_to === result.chat_message_id && message.kind === 'reply');
  assert.ok(reply);
  assert.equal(reply.to_member_id, state.bridgeMember.id);
  assert.equal(reply.status, 'queued', 'the reply stays available to the original synchronous bridge caller');
  assert.equal(notifications.length, 0, 'the correlated response must not open a separate Routine context');
  const before = Date.now();
  const waited = await state.service.bridge.wait(result.id, 25, state.bridgeMember.id, state.room.id);
  assert.ok(Date.now() - before < 500, 'an already answered bridge result must return immediately');
  assert.equal(waited.status, 'answered');
  assert.equal(state.service.chat.store.message(reply.id).status, 'consumed');
  assert.equal(state.service.chat.store.inbox(state.bridgeMember.id).some(message => message.id === reply.id), false);
  assert.equal(notifications.length, 0);
  assert.equal(state.clients.get(state.target.id).calls.filter(call => !call.handshake).length, 1);
  const direct = state.service.chat.post({ room_id: state.room.id, to_member_id: state.bridgeMember.id, text: '无关联的单独通知', idempotency_key: 'unlinked-direct-notice' });
  await until(() => state.service.chat.store.message(direct.id).status === 'delivered', 'configured direct notification');
  assert.equal(notifications.length, 1, 'the configured fixture webhook works for unrelated addressed questions');
  assert.equal(notifications[0].message_id, direct.id);
  assert.equal(JSON.stringify(state.service.snapshot()).includes('crsr_fixture_correlated_only'), false);
});

test('bridge wait consumes its exact reply even after more than 200 earlier room messages', async t => {
  const state = setup(t); await joinBridge(state);
  state.service.store.transaction(() => {
    for (let i = 0; i < 205; i++) state.service.chat.store.post({ room_id: state.room.id, text: `已有公告 ${i}`, idempotency_key: `history:${i}` });
  });
  const question = state.service.bridge.request(input(state));
  await until(() => state.service.chat.store.message(question.chat_message_id).status === 'answered', 'answer after existing history');
  const answer = state.service.bridge.entry(question.id);
  assert.equal(answer.status, 'answered');
  const reply = state.service.chat.store.db.prepare("SELECT * FROM chat_messages WHERE reply_to=? AND kind='reply'").get(question.chat_message_id);
  assert.equal(reply.status, 'queued');
  await state.service.bridge.wait(answer.id, 0, state.bridgeMember.id, state.room.id);
  assert.equal(state.service.chat.store.message(reply.id).status, 'consumed', 'response lookup must use the addressed message, not the earliest timeline page');
  const visible = state.service.chat.room(state.room.id).messages;
  assert.equal(visible.length, 200);
  assert.ok(visible.some(message => message.id === question.chat_message_id));
  assert.ok(visible.some(message => message.id === reply.id));
  assert.equal(visible.some(message => message.text === '已有公告 0'), false);
  assert.ok(visible[0].seq < visible.at(-1).seq, 'the latest timeline page is displayed chronologically');
  const nativePrompt = state.clients.get(state.target.id).calls.find(call => !call.handshake).prompt;
  assert.ok(nativePrompt.includes('已有公告 204'));
  assert.equal(nativePrompt.includes('已有公告 0"'), false, 'native context uses recent messages rather than the first room page');
});

test('bridge answers remain discoverable beyond the first 1000 room messages', async t => {
  const state = setup(t); await joinBridge(state);
  state.service.store.transaction(() => {
    for (let i = 0; i < 1005; i++) state.service.chat.store.post({ room_id: state.room.id, text: `长期房间公告 ${i}`, idempotency_key: `history:${i}` });
  });
  const question = state.service.bridge.request(input(state));
  await until(() => state.service.chat.store.message(question.chat_message_id).status === 'answered', 'answer beyond early history page');
  const result = state.service.bridge.entry(question.id, state.bridgeMember.id, state.room.id, { forBridge: true });
  assert.equal(result.status, 'answered', 'the bridge must find the exact correlated reply regardless of timeline pagination');
  assert.match(result.response_text, /fixture已核实/);
  assert.match(result.native_return_text, /\[AgentRoom AR-[A-F0-9]{10}\]/);
  state.service.chat.exportRooms();
  const exported = fs.readFileSync(path.join(state.data, 'chatrooms', state.room.id, 'conversation.md'), 'utf8');
  assert.match(exported, /长期房间公告 0\n/);
  assert.match(exported, /长期房间公告 1004\n/);
  assert.ok(exported.includes(result.response_text), 'Markdown retains the full history and latest answer');
});

test('wrong native group references and member/room ownership cannot report a return', async t => {
  const state = setup(t); await joinBridge(state); const answer = await answered(state);
  const receipt = { member_id: state.bridgeMember.id, room_id: state.room.id, conversation_ref: 'fixture-native/wrong-group', external_reply_id: 'fixture-native/reply-1' };
  assert.throws(() => state.service.bridge.report(answer.id, receipt), { status: 409, code: 'wrong_native_conversation' });
  assert.throws(() => state.service.bridge.report(answer.id, { ...receipt, member_id: state.target.id }), { status: 403 });
  const other = state.service.chat.addRoom({ title: '另一个已加入的房间', project_id: state.project.id });
  state.service.chat.join(other.id, state.bridgeMember.id);
  assert.throws(() => state.service.bridge.report(answer.id, { ...receipt, room_id: other.id }), { status: 403 });
  assert.throws(() => state.service.bridge.entry(answer.id, state.target.id), { status: 403 });
  assert.throws(() => state.service.bridge.bind({ member_id: state.bridgeMember.id, room_id: other.id, provider: 'grok-bot', conversation_ref: answer.origin.conversation_ref }), { status: 409, code: 'binding_room_conflict' });
  assert.equal(state.service.bridge.entry(answer.id).return_verification, 'unverified');
});

test('current-context requests do not fabricate a native group binding or delivery receipt', async t => {
  const state = setup(t); await joinBridge(state);
  const answer = await answered(state, { conversation_ref: undefined, external_message_id: undefined });
  assert.equal(answer.origin.mode, 'current-context');
  assert.match(answer.origin.conversation_ref, /^context:/);
  assert.equal(answer.native_delivery_receipt, null);
  assert.equal(state.service.bridge.store.binding(answer.binding_id).status, 'unverified');
  assert.throws(() => state.service.bridge.report(answer.id, { member_id: state.bridgeMember.id, conversation_ref: answer.origin.conversation_ref, external_reply_id: 'made-up-native-id' }), error => error.status === 409 && /不能编造/.test(error.message));
});

test('local-test answers cannot report or pass the human Grok return confirmation', async t => {
  const state = setup(t), api = await apiFor(t, state); await joinBridge(state);
  const answer = await answered(state, { provider: 'local-test', conversation_ref: 'local-test:isolated-fixture', external_message_id: 'local-test:message-1' });
  const code = answer.native_return_text.match(/\[AgentRoom (AR-[A-F0-9]{10})\]/)[1];
  await assert.rejects(() => api(`/api/bridge/entries/${answer.id}/confirm-return`, { verification_code: code }), error => error.status === 409);
  assert.throws(() => state.service.bridge.report(answer.id, { member_id: state.bridgeMember.id, conversation_ref: answer.origin.conversation_ref, external_reply_id: 'local-test:reply' }), error => error.status === 403);
  assert.equal(state.service.bridge.entry(answer.id).return_verification, 'unverified');
  assert.equal(state.service.bridge.setup(state.bridgeMember.id, state.room.id).stages.find(stage => stage.id === 'native_return').state, 'needs_action');
  const production = setup(t, { allowLocalTest: false }); await joinBridge(production);
  assert.throws(() => production.service.bridge.request(input(production, { provider: 'local-test' })), error => error.status === 403);
  assert.equal(production.service.bridge.entries().length, 0);
});

test('restart makes an unlinked staged source uncertain and never creates a replacement task', async t => {
  const state = setup(t); await joinBridge(state);
  const binding = state.service.bridge.bind({ member_id: state.bridgeMember.id, room_id: state.room.id, provider: 'grok-bot', conversation_ref: 'fixture-native/group-original' });
  const entry = state.service.bridge.store.submit({ binding_id: binding.id, external_message_id: 'fixture-native/message-1', target_member_id: state.target.id, text: '请核实群里的开发问题', idempotency_key: 'logical-question-1' });
  assert.equal(entry.status, 'staged');
  assert.equal(state.service.chat.store.messages(state.room.id).length, 0);
  await state.service.close();
  const restarted = createService(state.data); state.service = restarted.service; state.clients = restarted.clients;
  const duplicate = state.service.bridge.request(input(state));
  assert.equal(duplicate.id, entry.id);
  assert.equal(duplicate.status, 'uncertain');
  assert.equal(state.service.chat.store.messages(state.room.id).length, 0);
  assert.equal(state.clients.size, 0);
});

test('MCP bridge tools bind identity and room scope and expose no human confirmation tool', async t => {
  const state = setup(t), api = await apiFor(t, state); await joinBridge(state);
  identity(t, state.bridgeMember.id, state.room.id);
  assert.ok(tools.some(tool => tool.name === 'agentroom_bridge_request'), 'bridge MCP tools must be installed');
  assert.equal(tools.some(tool => /confirm.*return|return.*confirm/.test(tool.name)), false);
  const question = await toolCall('agentroom_bridge_request', { room_id: state.room.id, target_member_id: state.target.id, text: 'MCP原群问题', idempotency_key: 'mcp-source-key', conversation_ref: 'fixture-native/mcp-group', external_message_id: 'fixture-native/mcp-message' }, api);
  await until(() => state.service.bridge.entry(question.id).status === 'answered', 'MCP fixture answer');
  const answer = await toolCall('agentroom_bridge_wait', { entry_id: question.id, seconds: 0 }, api);
  assert.equal(answer.member_id, state.bridgeMember.id);
  assert.equal(answer.room_id, state.room.id);
  process.env.AGENTROOM_MEMBER_ID = state.target.id;
  await assert.rejects(() => toolCall('agentroom_bridge_wait', { entry_id: question.id, seconds: 0 }, api), error => error.status === 403);
  await assert.rejects(() => toolCall('agentroom_bridge_report', { entry_id: question.id, conversation_ref: answer.origin.conversation_ref, external_reply_id: 'fixture-native/mcp-reply' }, api), error => error.status === 403);
  process.env.AGENTROOM_MEMBER_ID = state.bridgeMember.id;
  const other = state.service.chat.addRoom({ title: 'MCP另一房间', project_id: state.project.id });
  state.service.chat.join(other.id, state.bridgeMember.id);
  process.env.AGENTROOM_ROOM_ID = other.id;
  await assert.rejects(() => toolCall('agentroom_bridge_wait', { entry_id: question.id, seconds: 0 }, api), error => error.status === 403);
  await assert.rejects(() => toolCall('agentroom_bridge_report', { entry_id: question.id, conversation_ref: answer.origin.conversation_ref, external_reply_id: 'fixture-native/mcp-reply' }, api), error => error.status === 403);
  assert.equal(state.service.bridge.entry(question.id).return_verification, 'unverified');
});
