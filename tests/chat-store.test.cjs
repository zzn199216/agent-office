'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentroom-chat-store-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const store = new Store(path.join(root, 'data'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const chat = new ChatStore(store);
  const p = store.addProject('项目甲', project);
  const room = chat.addRoom({ title: '开发与运营', project_id: p.id });
  const alpha = chat.addMember({ name: 'Claude 开发', adapter: 'claude-code', config: { path: 'custom executable' } });
  const beta = chat.addMember({ name: '其他 Bot', adapter: 'future-adapter' });
  return { root, store, chat, p, room, alpha, beta };
}

test('room members are adapter-neutral and leave preserves history and native binding', t => {
  const { chat, room, alpha, beta, p } = setup(t);
  assert.equal(chat.rooms()[0].project_name, p.name);
  assert.equal(chat.member(beta.id).adapter, 'future-adapter');
  assert.deepEqual(chat.member(alpha.id).config, { path: 'custom executable' });
  assert.equal(alpha.status, 'awaiting_handshake');
  assert.equal(chat.join(room.id, alpha.id).joined, true);
  chat.join(room.id, beta.id);
  assert.equal(chat.participants(room.id).length, 2);
  assert.deepEqual(chat.binding(room.id, alpha.id), { thread_id: null, binding_state: 'new' });
  chat.bind(room.id, alpha.id, 'bound', 'opaque-vendor-session');
  const message = chat.post({ room_id: room.id, sender_id: alpha.id, text: '所有人可以看到', idempotency_key: 'announcement' });
  assert.equal(message.status, 'posted');
  chat.leave(room.id, alpha.id);
  assert.equal(chat.participants(room.id).length, 1);
  assert.equal(chat.message(message.id).text, '所有人可以看到');
  assert.throws(() => chat.binding(room.id, alpha.id), { code: 'not_in_room' });
  chat.join(room.id, alpha.id);
  assert.equal(chat.binding(room.id, alpha.id).thread_id, 'opaque-vendor-session');
});

test('targeted messages enforce room membership, same-room replies and recipient acknowledgements', t => {
  const { chat, room, alpha, beta, p } = setup(t);
  chat.join(room.id, alpha.id);
  const input = { room_id: room.id, sender_id: alpha.id, to_member_id: beta.id, text: '请确认运营计划', idempotency_key: 'question' };
  assert.throws(() => chat.post(input), { status: 403, code: 'not_in_room' });
  chat.join(room.id, beta.id);
  const message = chat.post(input);
  assert.equal(message.status, 'queued');
  assert.equal(chat.inbox(beta.id)[0].id, message.id);
  assert.equal(chat.inbox(alpha.id).length, 0);
  assert.throws(() => chat.ack(message.id, alpha.id), { code: 'wrong_recipient' });
  chat.updateMessage(message.id, { status: 'delivered' });
  assert.equal(chat.ack(message.id, beta.id).status, 'consumed');
  assert.equal(chat.ack(message.id, beta.id).status, 'consumed');
  assert.equal(chat.inbox(beta.id).length, 0);
  const other = chat.addRoom({ title: '另一房间', project_id: p.id });
  chat.join(other.id, alpha.id);
  assert.throws(() => chat.post({ ...input, room_id: other.id, to_member_id: null, reply_to: message.id, idempotency_key: 'cross' }), { code: 'cross_room_reply' });
  const reply = chat.post({ room_id: room.id, sender_id: beta.id, text: '已经确认', reply_to: message.id, idempotency_key: 'reply' });
  assert.equal(reply.reply_to, message.id);
  assert.throws(() => chat.ack(reply.id, beta.id), { code: 'wrong_recipient' });
  chat.updateMessage(message.id, { status: 'failed' });
  assert.throws(() => chat.ack(message.id, beta.id), { code: 'invalid_message_state' });
});

test('message deduplication verifies the complete body, keeps global sequence and redacts secrets', t => {
  const { chat, room, alpha, beta, p } = setup(t);
  chat.join(room.id, alpha.id); chat.join(room.id, beta.id);
  const input = { room_id: room.id, sender_id: 'user', to_member_id: alpha.id, text: '中文问题 crsr_secretvalue Authorization: Bearer private-token', idempotency_key: 'same' };
  const message = chat.post(input);
  assert.equal(chat.post(input).id, message.id);
  assert.doesNotMatch(message.text, /secretvalue|private-token/);
  for (const change of [{ text: '修改的问题' }, { to_member_id: beta.id }, { kind: 'event' }]) {
    assert.throws(() => chat.post({ ...input, ...change }), { status: 409, code: 'idempotency_conflict' });
  }
  const other = chat.addRoom({ title: '第二房间', project_id: p.id });
  const second = chat.post({ room_id: other.id, text: '独立消息', idempotency_key: 'same' });
  assert.ok(second.seq > message.seq);
  const third = chat.post({ room_id: room.id, text: '后续消息', idempotency_key: 'next' });
  assert.ok(third.seq > second.seq);
  assert.deepEqual(chat.messages(room.id, { after_seq: message.seq }).map(row => row.id), [third.id]);
  assert.equal(chat.messages(room.id, { limit: 1 }).length, 1);
  assert.equal(Object.hasOwn(message, 'body_hash'), false);
  assert.throws(() => chat.messages(room.id, { after_seq: -1 }));
  assert.throws(() => chat.messages(room.id, { limit: 1001 }));
  assert.throws(() => chat.post({ ...input, idempotency_key: 'oversize', text: 'x'.repeat(20001) }));
});

test('pending messages for departed members are hidden until rejoining; recovery never repeats work', t => {
  const { chat, room, alpha } = setup(t);
  chat.join(room.id, alpha.id);
  const queued = chat.post({ room_id: room.id, text: '待处理', to_member_id: alpha.id, idempotency_key: 'queued' });
  chat.leave(room.id, alpha.id);
  assert.deepEqual(chat.inbox(alpha.id), []);
  assert.throws(() => chat.ack(queued.id, alpha.id), { code: 'not_in_room' });
  chat.join(room.id, alpha.id);
  assert.equal(chat.inbox(alpha.id)[0].id, queued.id);
  chat.updateMessage(queued.id, { status: 'processing', request_id: 'known-native-request' });
  chat.bind(room.id, alpha.id, 'creating');
  assert.equal(chat.recovery(), 1);
  assert.equal(chat.message(queued.id).status, 'uncertain');
  assert.equal(chat.message(queued.id).request_id, 'known-native-request');
  assert.equal(chat.binding(room.id, alpha.id).binding_state, 'creation_uncertain');
  assert.equal(chat.inbox(alpha.id).length, 0);
  assert.equal(chat.recovery(), 0);
  assert.throws(() => chat.updateMessage(queued.id, { status: 'typo' }));
});

test('only a valid, unexpired invitation completion verifies and joins a member', t => {
  const { chat, room, alpha, beta } = setup(t);
  const invitation = chat.createInvite({ member_id: alpha.id, room_id: room.id });
  assert.ok(invitation.nonce.length >= 32);
  assert.equal(Object.hasOwn(chat.invite(invitation.id), 'nonce'), false);
  assert.equal(chat.member(alpha.id).verified_at, null);
  assert.equal(chat.participants(room.id).length, 0);
  assert.throws(() => chat.completeInvite(invitation.id, 'wrong'), { status: 403, code: 'invalid_invite_nonce' });
  assert.equal(chat.member(alpha.id).status, 'awaiting_handshake');
  const completed = chat.completeInvite(invitation.id, invitation.nonce);
  assert.equal(completed.status, 'verified');
  assert.equal(chat.member(alpha.id).status, 'ready');
  assert.ok(chat.member(alpha.id).verified_at);
  assert.equal(chat.participants(room.id)[0].id, alpha.id);
  assert.equal(chat.completeInvite(invitation.id, invitation.nonce).completed, completed.completed);
  assert.throws(() => chat.completeInvite(invitation.id, 'wrong'), { code: 'invalid_invite_nonce' });
  const expired = chat.createInvite({ member_id: beta.id, room_id: room.id, expires: Date.now() - 1000 });
  assert.equal(chat.invite(expired.id).status, 'expired');
  assert.throws(() => chat.completeInvite(expired.id, expired.nonce), { status: 410, code: 'invite_expired' });
  assert.equal(chat.member(beta.id).verified_at, null);
  assert.equal(chat.participants(room.id).length, 1);
});

test('chat writes are safe within Store transactions and leave legacy data intact', t => {
  const { chat, store, room, alpha, p } = setup(t);
  const discussion = store.addDiscussion(p.id, '旧讨论');
  const legacy = store.submit({ discussion_id: discussion.id, message: '旧请求', idempotency_key: 'old' });
  store.transaction(() => {
    chat.join(room.id, alpha.id);
    chat.post({ room_id: room.id, text: '外层事务', idempotency_key: 'nested' });
  });
  assert.equal(chat.messages(room.id).length, 1);
  assert.throws(() => store.transaction(() => {
    chat.post({ room_id: room.id, text: '回滚消息', idempotency_key: 'rollback' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(chat.messages(room.id).length, 1);
  assert.equal(store.request(legacy.id).prompt, '旧请求');
  assert.equal(store.history(discussion.id).length, 1);
  const reopened = new ChatStore(store);
  assert.equal(reopened.messages(room.id)[0].text, '外层事务');
  const secondConnection = new Store(store.dir);
  try {
    const persisted = new ChatStore(secondConnection);
    assert.equal(persisted.messages(room.id)[0].text, '外层事务');
    assert.equal(persisted.members().length, 2);
  } finally { secondConnection.close(); }
  assert.throws(() => chat.addRoom({ title: '坏项目', project_id: 'missing' }), { status: 404 });
  assert.throws(() => chat.addMember({ id: 'user', name: '冒充用户', adapter: 'custom' }));
});
