'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');
const { BridgeStore } = require('../src/bridge-store.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture(), store = new Store(files.data), chat = new ChatStore(store), bridge = new BridgeStore(chat);
  t.after(() => { store.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  const project = store.addProject('桥接持久层测试', files.project);
  const room = chat.addRoom({ title: '开发聊天室', project_id: project.id });
  const otherRoom = chat.addRoom({ title: '其他聊天室', project_id: project.id });
  const member = chat.addMember({ name: '群桥接成员', adapter: 'grok-bridge' });
  const target = chat.addMember({ name: '开发成员', adapter: 'codex' });
  const peer = chat.addMember({ name: '运营成员', adapter: 'mailbox' });
  for (const entry of [member, target, peer]) chat.join(room.id, entry.id);
  const binding = bridge.bind({ member_id: member.id, room_id: room.id, provider: 'grok-bot', conversation_ref: 'native/group-a', label: '实际原群引用 fixture' });
  return { ...files, store, chat, bridge, project, room, otherRoom, member, target, peer, binding };
}
function staged(state, externalId = 'native-message-1', text = '请核实发布计划') {
  return state.bridge.submit({ binding_id: state.binding.id, external_message_id: externalId, target_member_id: state.target.id, text });
}
function attach(state, entry) {
  const message = state.chat.post({ room_id: state.room.id, sender_id: state.member.id, to_member_id: entry.target_member_id, text: entry.text, idempotency_key: `bridge:${entry.id}` });
  return state.bridge.setMessage(entry.id, message.id);
}

test('bindings preserve explicit native origin and never imply native verification', t => {
  const state = setup(t), { bridge, binding, member, room, otherRoom, chat } = state;
  assert.equal(binding.status, 'unverified');
  assert.equal(chat.member(member.id).verified_at, null);
  assert.equal(bridge.bind({ member_id: member.id, room_id: room.id, provider: 'grok-bot', conversation_ref: binding.conversation_ref }).id, binding.id);
  chat.join(otherRoom.id, member.id);
  assert.throws(() => bridge.bind({ member_id: member.id, room_id: otherRoom.id, provider: 'grok-bot', conversation_ref: binding.conversation_ref }), { status: 409, code: 'binding_room_conflict' });
  const second = bridge.bind({ member_id: member.id, room_id: otherRoom.id, provider: 'grok-bot', conversation_ref: 'native/group-b' });
  assert.notEqual(second.id, binding.id);
  assert.equal(bridge.bindings(member.id).length, 2);
  assert.equal(bridge.bindings(undefined, room.id).length, 1);
  const sameOriginDifferentProvider = bridge.bind({ member_id: member.id, room_id: room.id, provider: 'generic', conversation_ref: binding.conversation_ref });
  assert.notEqual(sameOriginDifferentProvider.id, binding.id);
  assert.equal(bridge.binding(binding.id).room_id, room.id);
  assert.throws(() => bridge.bind({ member_id: member.id, room_id: room.id, provider: 'invented', conversation_ref: 'x' }));
  chat.leave(otherRoom.id, member.id);
  assert.throws(() => bridge.bind({ member_id: member.id, room_id: otherRoom.id, provider: 'generic', conversation_ref: 'native/not-joined' }), { status: 403, code: 'not_in_room' });
});

test('submitting stages data without execution and deduplicates the full question and target', t => {
  const state = setup(t), { bridge, chat, binding, target, peer, member, room } = state;
  const input = { binding_id: binding.id, external_message_id: 'native-message-a', target_member_id: target.id, text: '中文问题 Authorization: Bearer private-secret', idempotency_key: 'optional-key' };
  const entry = bridge.submit(input);
  assert.equal(entry.status, 'staged');
  assert.equal(entry.chat_message_id, null);
  assert.equal(entry.response_text, '');
  assert.equal(entry.native_delivery_receipt, null);
  assert.equal(chat.messages(room.id).length, 0);
  assert.doesNotMatch(entry.text, /private-secret/);
  assert.equal(Object.hasOwn(entry, 'body_hash'), false);
  assert.equal(bridge.submit(input).id, entry.id);
  assert.throws(() => bridge.submit({ ...input, text: '变化的问题' }), { status: 409, code: 'idempotency_conflict' });
  assert.throws(() => bridge.submit({ ...input, target_member_id: peer.id }), { status: 409, code: 'idempotency_conflict' });
  assert.throws(() => bridge.submit({ ...input, external_message_id: 'self', target_member_id: member.id }), { code: 'bridge_self_target' });
  const otherSource = bridge.bind({ member_id: member.id, room_id: room.id, provider: 'grok-bot', conversation_ref: 'native/another-group' });
  assert.notEqual(bridge.submit({ ...input, binding_id: otherSource.id }).id, entry.id);
  assert.equal(bridge.list(binding.id).length, 1);
  assert.equal(bridge.list().length, 2);
  chat.leave(room.id, target.id);
  assert.throws(() => bridge.submit({ ...input, external_message_id: 'not-joined' }), { code: 'not_in_room' });
});

test('a local-test bridge report never verifies a Grok origin or member', t => {
  const state = setup(t), { bridge, member, room, target, chat } = state;
  const localBinding = bridge.bind({ member_id: member.id, room_id: room.id, provider: 'local-test', conversation_ref: 'local-fixture/conversation-1', label: '隔离本机自测' });
  const entry = bridge.submit({ binding_id: localBinding.id, external_message_id: 'local-message-1', target_member_id: target.id, text: '本机自测资料' });
  attach(state, entry);
  bridge.updateEntry(entry.id, { status: 'answered', response_text: '本机自测回答' });
  bridge.deliver(entry.id, { conversation_ref: localBinding.conversation_ref, external_reply_id: 'local-fixture/reply-1' });
  assert.equal(bridge.binding(localBinding.id).status, 'unverified');
  assert.equal(bridge.entry(entry.id).status, 'delivered', 'delivered here records a caller report only');
  assert.equal(chat.member(member.id).verified_at, null);
  assert.equal(chat.member(member.id).status, 'awaiting_handshake');
});

test('setMessage requires the same room, original bridge sender, exact text and intended target', t => {
  const state = setup(t), { bridge, chat, room, otherRoom, member, target, peer } = state;
  const entry = staged(state);
  const userMessage = chat.post({ room_id: room.id, sender_id: 'user', to_member_id: target.id, text: entry.text, idempotency_key: 'wrong-source' });
  assert.throws(() => bridge.setMessage(entry.id, userMessage.id), { code: 'bridge_message_mismatch' });
  const wrongText = chat.post({ room_id: room.id, sender_id: member.id, to_member_id: target.id, text: '不同的任务', idempotency_key: 'wrong-text' });
  assert.throws(() => bridge.setMessage(entry.id, wrongText.id), { code: 'bridge_message_mismatch' });
  const wrongTarget = chat.post({ room_id: room.id, sender_id: member.id, to_member_id: peer.id, text: entry.text, idempotency_key: 'wrong-target' });
  assert.throws(() => bridge.setMessage(entry.id, wrongTarget.id), { code: 'bridge_message_mismatch' });
  chat.join(otherRoom.id, member.id); chat.join(otherRoom.id, target.id);
  const crossRoom = chat.post({ room_id: otherRoom.id, sender_id: member.id, to_member_id: target.id, text: entry.text, idempotency_key: 'wrong-room' });
  assert.throws(() => bridge.setMessage(entry.id, crossRoom.id), { code: 'bridge_message_mismatch' });
  const attached = attach(state, entry);
  assert.equal(attached.status, 'waiting');
  assert.equal(bridge.entryForMessage(attached.chat_message_id).id, entry.id);
  assert.equal(bridge.setMessage(entry.id, attached.chat_message_id).chat_message_id, attached.chat_message_id);
  const anotherEntry = staged(state, 'native-message-2');
  assert.throws(() => bridge.setMessage(anotherEntry.id, attached.chat_message_id), { code: 'bridge_message_conflict' });
  const duplicateChat = chat.post({ room_id: room.id, sender_id: member.id, to_member_id: target.id, text: entry.text, idempotency_key: 'second-chat' });
  assert.throws(() => bridge.setMessage(entry.id, duplicateChat.id), { code: 'bridge_message_conflict' });
  assert.equal(bridge.entry(anotherEntry.id).chat_message_id, null);
});

test('a bridge report requires a chat answer and origin-matching external reply reference', t => {
  const state = setup(t), { bridge, binding, member, chat } = state;
  const entry = staged(state), receipt = { conversation_ref: binding.conversation_ref, external_reply_id: 'native-reply-123' };
  assert.throws(() => bridge.deliver(entry.id, receipt), { code: 'invalid_bridge_state' });
  assert.throws(() => bridge.updateEntry(entry.id, { status: 'delivered' }), { code: 'delivery_receipt_required' });
  assert.throws(() => bridge.updateEntry(entry.id, { status: 'answered', response_text: '无实际聊天任务的回答' }), { code: 'chat_message_required' });
  attach(state, entry);
  assert.throws(() => bridge.updateEntry(entry.id, { status: 'answered' }), { code: 'bridge_answer_required' });
  bridge.updateEntry(entry.id, { status: 'answered', response_text: '经实际聊天核实的回答' });
  assert.throws(() => bridge.deliver(entry.id, { conversation_ref: 'native/wrong-group', external_reply_id: 'wrong' }), { code: 'wrong_native_conversation' });
  assert.throws(() => bridge.deliver(entry.id, { conversation_ref: binding.conversation_ref, external_reply_id: '' }));
  const delivered = bridge.deliver(entry.id, receipt);
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(delivered.native_delivery_receipt, receipt);
  assert.equal(bridge.deliver(entry.id, receipt).updated, delivered.updated);
  assert.throws(() => bridge.deliver(entry.id, { ...receipt, external_reply_id: 'different-reply' }), { code: 'delivery_receipt_conflict' });
  assert.throws(() => bridge.updateEntry(entry.id, { response_text: '覆盖实际已送达答案' }), { code: 'delivered_entry_immutable' });
  assert.throws(() => bridge.updateEntry(entry.id, { status: 'waiting' }), { code: 'delivered_entry_immutable' });
  assert.equal(bridge.binding(binding.id).status, 'unverified');
  assert.equal(chat.member(member.id).verified_at, null, 'a caller-supplied receipt is not an invitation handshake or independent group verification');
});

test('recovery marks unlinked staged work uncertain and preserves linked waiting work without replay', t => {
  const state = setup(t), { bridge, chat, room } = state;
  const unlinked = staged(state, 'staged-only');
  const waiting = attach(state, staged(state, 'linked-waiting'));
  assert.equal(bridge.recovery(), 1);
  assert.equal(bridge.entry(unlinked.id).status, 'uncertain');
  assert.equal(bridge.entry(waiting.id).status, 'waiting');
  assert.equal(bridge.entry(waiting.id).chat_message_id, waiting.chat_message_id);
  assert.equal(chat.messages(room.id).length, 1);
  assert.equal(bridge.recovery(), 0);
  assert.equal(bridge.submit({ binding_id: unlinked.binding_id, external_message_id: unlinked.external_message_id, target_member_id: unlinked.target_member_id, text: unlinked.text }).status, 'uncertain');
  const newChat = chat.post({ room_id: room.id, sender_id: state.member.id, to_member_id: unlinked.target_member_id, text: unlinked.text, idempotency_key: 'manual-link-attempt' });
  assert.throws(() => bridge.setMessage(unlinked.id, newChat.id), { code: 'invalid_bridge_state' });
});

test('bridge transactions nest safely and SQLite connections retain original and bridge records', t => {
  const state = setup(t), { bridge, store, project, binding } = state;
  const discussion = store.addDiscussion(project.id, '原有讨论');
  const old = store.submit({ discussion_id: discussion.id, message: '原有请求不迁移', idempotency_key: 'legacy' });
  store.transaction(() => staged(state, 'nested'));
  assert.throws(() => store.transaction(() => { staged(state, 'rolled-back'); throw new Error('outer rollback'); }), /outer rollback/);
  assert.equal(bridge.list(binding.id).length, 1);
  const separate = new Store(store.dir);
  try {
    const persisted = new BridgeStore(separate);
    assert.equal(persisted.list(binding.id).length, 1);
    assert.equal(persisted.binding(binding.id).status, 'unverified');
    assert.equal(separate.request(old.id).prompt, '原有请求不迁移');
    assert.equal(separate.projects().length, 1);
    assert.equal(separate.discussions().length, 1);
  } finally { separate.close(); }
});
