'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');
const { RuntimeState } = require('../src/runtime-state.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture();
  let store = new Store(files.data), chat = new ChatStore(store), milliseconds = Date.parse('2026-10-12T00:00:00Z');
  const alivePids = new Set([42, 43, 444]);
  const isPidAlive = pid => alivePids.has(pid);
  const runtime = new RuntimeState(chat, { clock: () => milliseconds, ttlMs: 10000, isPidAlive });
  const project = store.addProject('持久运行状态测试', files.project), room = chat.addRoom({ title: '开发聊天室', project_id: project.id }), otherRoom = chat.addRoom({ title: '运营聊天室', project_id: project.id });
  const codex = chat.addMember({ name: '开发成员', adapter: 'codex' }), grok = chat.addMember({ name: '群聊成员', adapter: 'grok-bridge' }), peer = chat.addMember({ name: '新客户端', adapter: 'new-client' });
  for (const member of [codex, grok, peer]) chat.join(room.id, member.id);
  t.after(() => { store.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  return { ...files, get store() { return store; }, get chat() { return chat; }, runtime, project, room, otherRoom, codex, grok, peer, alivePids,
    advance: millisecondsToAdd => { milliseconds += millisecondsToAdd; },
    reopen: () => { store.close(); store = new Store(files.data); chat = new ChatStore(store); return new RuntimeState(store, { clock: () => milliseconds, ttlMs: 10000, isPidAlive }); }
  };
}

test('registered and verified members remain unknown until recent contact exists', t => {
  const s = setup(t);
  s.chat.updateMember(s.codex.id, { status: 'ready', verified_at: '2026-10-11T12:00:00.000Z' });
  assert.equal(s.runtime.memberState(s.codex.id).registration, 'verified');
  assert.equal(s.runtime.memberState(s.codex.id).presence, 'unknown');
  assert.equal(s.runtime.memberState(s.codex.id).online, false);
  assert.equal(s.runtime.memberState(s.codex.id).worker_online, false);
  const member = s.runtime.heartbeat(s.grok.id, { session_ref: 'native/group-one' });
  assert.equal(member.registration, 'unverified', 'heartbeats are not join challenges');
  assert.equal(member.presence, 'online');
  assert.equal(member.worker_state, 'unknown', 'contact does not prove a persistent background worker');
  s.advance(10000);
  assert.equal(s.runtime.memberState(s.grok.id).presence, 'stale');
  assert.equal(s.runtime.memberState(s.grok.id).online, false);
  assert.equal(s.chat.member(s.grok.id).verified_at, null);
});

test('independent sessions use bounded leases and explicit disconnect preserves last seen', t => {
  const s = setup(t);
  assert.throws(() => s.runtime.heartbeat(s.grok.id, { ttl_ms: 300001 }));
  assert.throws(() => s.runtime.heartbeat(s.grok.id, { ttl_ms: 999 }));
  s.runtime.heartbeat(s.grok.id, { session_ref: 'a', ttl_ms: 1000 });
  s.runtime.heartbeat(s.grok.id, { session_ref: 'b', ttl_ms: 20000 });
  assert.equal(s.runtime.memberState(s.grok.id).active_sessions, 2);
  s.advance(1000);
  assert.equal(s.runtime.memberState(s.grok.id).active_sessions, 1);
  s.runtime.releaseSession(s.grok.id, 'b');
  assert.equal(s.runtime.memberState(s.grok.id).presence, 'stale');
  const lastSeen = s.runtime.memberState(s.grok.id).last_seen;
  s.runtime.releaseSession(s.grok.id, 'a');
  assert.equal(s.runtime.memberState(s.grok.id).presence, 'offline');
  assert.equal(s.runtime.memberState(s.grok.id).last_seen, lastSeen);
  assert.throws(() => s.runtime.heartbeat('missing'), { status: 404 });
});

test('worker and service evidence are separate from member contact and wake configuration', t => {
  const s = setup(t);
  assert.equal(s.runtime.memberState(s.codex.id).can_wake, false, 'capabilities are explicitly configured');
  s.runtime.configureWakeAdapter('codex', true);
  assert.equal(s.runtime.memberState(s.codex.id).can_wake, true);
  assert.equal(s.runtime.memberState(s.peer.id).can_wake, false, 'unknown agents have no implicit wake adapter');
  s.runtime.serviceHeartbeat('service-a', { pid: 42 });
  assert.equal(s.runtime.offlineSnapshot(s.room.id).service.online, true);
  assert.equal(s.runtime.memberState(s.codex.id).worker_online, false);
  s.runtime.workerHeartbeat('codex-a', { member_id: s.codex.id, pid: 43 });
  assert.equal(s.runtime.memberState(s.codex.id).worker_online, true);
  assert.equal(s.runtime.memberState(s.codex.id).presence, 'unknown');
  assert.throws(() => s.runtime.workerHeartbeat('codex-a', { member_id: s.peer.id }), { code: 'worker_identity_conflict' });
  assert.throws(() => s.runtime.workerHeartbeat('invalid', {}));
  assert.throws(() => s.runtime.workerHeartbeat('invalid', { member_id: s.codex.id, pid: -1 }));
  s.runtime.releaseWorker('codex-a');
  assert.equal(s.runtime.memberState(s.codex.id).worker_state, 'stopped');
  s.runtime.releaseWorker('service-a');
  assert.equal(s.runtime.offlineSnapshot(s.room.id).service.state, 'stopped');
  s.runtime.configureWakeAdapter('codex', false);
  assert.equal(s.runtime.memberState(s.codex.id).can_wake, false);
});

test('known local PIDs that exit become offline immediately even with an unexpired lease', t => {
  const s = setup(t);
  s.runtime.serviceHeartbeat('service-a', { pid: 42 });
  s.runtime.workerHeartbeat('codex-a', { member_id: s.codex.id, pid: 43 });
  assert.equal(s.runtime.offlineSnapshot(s.room.id).service.online, true);
  assert.equal(s.runtime.workerState('codex-a').pid_alive, true);
  s.alivePids.delete(42); s.alivePids.delete(43);
  const snapshot = s.runtime.offlineSnapshot(s.room.id);
  assert.equal(snapshot.service.online, false);
  assert.equal(snapshot.service.state, 'stopped');
  assert.equal(snapshot.service.evidence, 'heartbeat_lease+pid');
  assert.equal(s.runtime.memberState(s.codex.id).worker_online, false);
  assert.equal(s.runtime.workerState('codex-a').state, 'stopped');
  assert.equal(s.runtime.workerState('codex-a').pid_alive, false);
  s.runtime.workerHeartbeat('external-a', { member_id: s.grok.id });
  assert.equal(s.runtime.workerState('external-a').online, true);
  assert.equal(s.runtime.workerState('external-a').pid_alive, null);
  assert.equal(s.runtime.workerState('external-a').evidence, 'heartbeat_lease');
  s.advance(10000);
  assert.equal(s.runtime.workerState('external-a').online, false, 'external contact cannot promise continuous window presence');
});

test('the default PID detector can recognize the actual current local process', t => {
  const s = setup(t), runtime = new RuntimeState(s.store);
  runtime.serviceHeartbeat('current-process', { pid: process.pid });
  assert.equal(runtime.workerState('current-process').pid_alive, true);
  assert.equal(runtime.offlineSnapshot(s.room.id).service.online, true);
});

test('reopening offline preserves identity, messages, replies and uncertain work without replay or recovery', t => {
  const s = setup(t);
  const queued = s.chat.post({ room_id: s.room.id, sender_id: s.grok.id, to_member_id: s.codex.id, text: '持久中文问题', idempotency_key: 'q' });
  const processing = s.chat.post({ room_id: s.room.id, sender_id: s.grok.id, to_member_id: s.codex.id, text: '运行中', idempotency_key: 'processing' });
  const uncertain = s.chat.post({ room_id: s.room.id, sender_id: s.grok.id, to_member_id: s.codex.id, text: '待核对', idempotency_key: 'uncertain' });
  s.chat.updateMessage(processing.id, { status: 'processing' });
  s.chat.updateMessage(uncertain.id, { status: 'uncertain' });
  const fingerprint = s.runtime.instanceId;
  s.runtime.configureWakeAdapter('codex', true);
  s.runtime.heartbeat(s.grok.id);
  s.runtime.serviceHeartbeat('old-service', { pid: 444 });
  s.advance(11000);
  const reopened = s.reopen(), snapshot = reopened.offlineSnapshot(s.room.id, s.grok.id);
  assert.match(fingerprint, /^[a-f0-9-]{36}$/i);
  assert.equal(snapshot.instance_id, fingerprint);
  assert.equal(snapshot.service.online, false);
  assert.equal(snapshot.service.state, 'stale');
  assert.equal(snapshot.rooms[0].state, 'needs_review');
  assert.equal(snapshot.rooms[0].dispatchable, 1, 'uncertain work never becomes dispatchable');
  assert.equal(snapshot.rooms[0].messages.processing, 1, 'offline snapshots do not recover active work owned by another process');
  assert.equal(s.chat.message(queued.id).text, '持久中文问题');
  assert.equal(s.chat.message(uncertain.id).status, 'uncertain');
  assert.equal(snapshot.members.find(m => m.id === s.codex.id).can_wake, true);
  assert.equal(s.chat.messages(s.room.id).length, 3);
});

test('offline snapshots enforce room membership and omit private member configuration', t => {
  const s = setup(t);
  const privateMember = s.chat.addMember({ name: '仅其他房间的成员', adapter: 'mailbox' });
  s.chat.join(s.otherRoom.id, privateMember.id);
  s.chat.updateMember(s.grok.id, { config: { native_group: 'example', access_key: 'must-not-leak' } });
  assert.throws(() => s.runtime.offlineSnapshot(s.otherRoom.id, s.grok.id), { code: 'not_in_room' });
  const snapshot = s.runtime.offlineSnapshot(undefined, s.grok.id);
  assert.equal(snapshot.rooms.length, 1);
  assert.equal(snapshot.rooms[0].id, s.room.id);
  assert.equal(snapshot.members.some(member => member.id === privateMember.id), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-leak/);
  assert.equal(snapshot.durable, true);
  assert.equal(s.runtime.roomState(s.room.id).state, 'idle');
});

function readOnlyChat(state) {
  const db = new DatabaseSync(path.join(state.data, 'room.sqlite'), { readOnly: true });
  const store = Object.assign(Object.create(Store.prototype), { db, dir: state.data });
  const chat = Object.assign(Object.create(ChatStore.prototype), { db, store, savepoint: 0 });
  return { db, chat };
}

test('read-only state inspects an actual read-only SQLite handle without DDL, identity writes or heartbeats', t => {
  const s = setup(t), readonly = readOnlyChat(s);
  try {
    const runtime = new RuntimeState(readonly.chat, { readOnly: true, wakeAdapters: ['unregistered'], clock: () => Date.parse('2026-10-12T00:00:01Z') });
    assert.equal(runtime.instanceId, s.runtime.instanceId);
    assert.equal(runtime.offlineSnapshot(s.room.id).rooms[0].id, s.room.id);
    assert.equal(s.store.db.prepare('SELECT count(*) AS count FROM runtime_adapter_capabilities').get().count, 0, 'constructor does not register supplied wake adapters in read-only mode');
    assert.throws(() => runtime.heartbeat(s.grok.id), { code: 'read_only_state' });
    assert.throws(() => runtime.serviceHeartbeat('forbidden', { pid: process.pid }), { code: 'read_only_state' });
    assert.throws(() => runtime.configureWakeAdapter('codex', true), { code: 'read_only_state' });
    assert.throws(() => runtime.releaseSession(s.grok.id), { code: 'read_only_state' });
    assert.throws(() => runtime.releaseWorker('missing'), { code: 'read_only_state' });
    assert.throws(() => runtime.recordConnectionEvidence(s.codex.id, { event: 'protocol_verified' }), { code: 'read_only_state' });
    assert.equal(runtime.connectionState(s.codex.id).verification_level,'registered_only');
  } finally { readonly.db.close(); }
});

test('older read-only databases expose unknown connection proof without schema writes', t => {
  const s=setup(t);s.store.db.exec('DROP TABLE connection_session_evidence');
  const readonly=readOnlyChat(s);
  try {
    const runtime=new RuntimeState(readonly.chat,{readOnly:true});
    assert.equal(runtime.connectionState(s.codex.id).protocol_verified,false);
    assert.deepEqual(runtime.connectionState(s.codex.id).sessions,[]);
    assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='connection_session_evidence'").get().n,0);
  } finally {readonly.db.close();}
});

test('read-only state refuses an uninitialized instance without inventing a replacement UUID', t => {
  const s = setup(t);
  s.store.db.prepare('DELETE FROM settings WHERE key=?').run('instance_fingerprint');
  const readonly = readOnlyChat(s);
  try { assert.throws(() => new RuntimeState(readonly.chat, { readOnly: true }), { code: 'instance_not_initialized' }); }
  finally { readonly.db.close(); }
  assert.equal(s.store.setting('instance_fingerprint'), null);
});
