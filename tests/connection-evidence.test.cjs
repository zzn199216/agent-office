'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');
const { RuntimeState } = require('../src/runtime-state.cjs');
const { ConnectionEvidence } = require('../src/connection-evidence.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture(), store = new Store(files.data), chat = new ChatStore(store);
  let milliseconds = Date.parse('2026-10-14T00:00:00Z');
  const alive = new Set([42, 43]);
  const runtime = new RuntimeState(chat, { clock: () => milliseconds, ttlMs: 10000, isPidAlive: pid => alive.has(pid), ownerId: 'owner:one' });
  const project = store.addProject('连接证据', files.project), room = chat.addRoom({ title: '收信测试', project_id: project.id });
  const member = chat.addMember({ name: '真实回复目标', adapter: 'codex' }); chat.join(room.id, member.id);
  t.after(() => { store.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  const record = (input = {}) => runtime.recordConnectionEvidence(member.id, { session_ref: 'native:one', executor_kind: 'managed_cli', native_session_id: 'thread-one', ...input });
  const reply = (key = 'question-one') => {
    const message = chat.post({ room_id: room.id, sender_id: 'user', to_member_id: member.id, text: '请实际回答', idempotency_key: key });
    chat.post({ room_id: room.id, sender_id: member.id, text: '已核实的实际回答', kind: 'reply', reply_to: message.id, idempotency_key: `answer:${key}` });
    chat.updateMessage(message.id, { status: 'answered' }); return message;
  };
  return { ...files, store, chat, runtime, room, member, alive, record, reply, advance: ms => { milliseconds += ms; } };
}

test('adapter capability and registered identity do not fabricate protocol, model or desktop proof', t => {
  const v = setup(t); v.runtime.configureWakeAdapter('codex', true); v.chat.updateMember(v.member.id, { status: 'ready', verified_at: '2026-10-13T23:00:00Z' });
  v.runtime.heartbeat(v.member.id); v.runtime.workerHeartbeat('legacy-worker', { member_id: v.member.id, pid: 42 });
  const state = v.runtime.memberState(v.member.id);
  assert.equal(state.can_wake, true); assert.equal(state.worker_online, true);
  assert.equal(state.connection_evidence.verification_level, 'registered_only');
  assert.equal(state.connection_evidence.protocol_verified, false); assert.equal(state.connection_evidence.model_reply_verified, false);
  assert.equal(state.connection_evidence.native_conversation_loaded, false);
});

test('protocol-only handshake cannot substitute for an actual durable addressed reply', t => {
  const v = setup(t); v.record({ event: 'protocol_verified', source: 'codex_mcp_tool_call' });
  assert.equal(v.runtime.connectionState(v.member.id).protocol_verified, true);
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, false);
  const unaddressed = v.chat.post({ room_id: v.room.id, sender_id: 'user', text: '接口自测说明', idempotency_key: 'selftest' });
  assert.throws(() => v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: unaddressed.id }), { code: 'connection_reply_missing' });
  const pending = v.chat.post({ room_id: v.room.id, sender_id: 'user', to_member_id: v.member.id, text: '尚未回复', idempotency_key: 'pending' });
  assert.throws(() => v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: pending.id }), { code: 'connection_reply_missing' });
  assert.equal(v.runtime.connectionState(v.member.id).model_reply_verified, false);
});

test('successful CLI task preserves protocol and reply proof while its idle runner stays separate from a desktop conversation', t => {
  const v = setup(t), message = v.reply();
  v.record({ event: 'protocol_verified', source: 'codex_mcp_tool_call' });
  v.record({ event: 'runner_started', pid: 42 });
  v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: message.id, turn_id: 'turn-one' });
  v.record({ event: 'runner_stopped' });
  const state = v.runtime.connectionState(v.member.id), session = state.sessions[0];
  assert.equal(state.automatic_reply_verified, true); assert.equal(state.runner_online, false);
  assert.equal(state.native_conversation_loaded, false); assert.equal(session.runner.state, 'stopped');
  const successAt = session.model.last_success_at; v.advance(20000);
  v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: message.id, turn_id: 'turn-one' });
  assert.equal(v.runtime.connectionState(v.member.id).sessions[0].model.last_success_at, successAt, 're-reading the same reply cannot refresh success evidence');
});

test('live owner is fenced and stale ownership can be reacquired without reviving an old PID', t => {
  const v = setup(t); v.record({ event: 'runner_started', pid: 42 });
  assert.throws(() => v.record({ event: 'runner_started', owner_id: 'owner:two', pid: 43 }), { code: 'connection_owner_conflict' });
  assert.throws(() => v.record({ event: 'runner_stopped', owner_id: 'owner:two' }), { code: 'connection_owner_conflict' });
  v.advance(10000); assert.equal(v.runtime.connectionState(v.member.id).sessions[0].runner.state, 'stale');
  v.record({ event: 'runner_started', owner_id: 'owner:two', pid: 43 });
  assert.equal(v.runtime.connectionState(v.member.id).sessions[0].owner_id, 'owner:two');
  v.alive.delete(43); assert.equal(v.runtime.connectionState(v.member.id).runner_online, false);
  assert.equal(v.runtime.connectionState(v.member.id).sessions[0].runner.state, 'stopped');
});

test('native session replacement clears the previous conversation proof and cannot change executor identity', t => {
  const v = setup(t), message = v.reply();
  v.record({ event: 'protocol_verified', source: 'codex_mcp_tool_call' });
  v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: message.id });
  v.record({ event: 'runner_started', native_session_id: 'thread-two', pid: 42 });
  const state = v.runtime.connectionState(v.member.id);
  assert.equal(state.protocol_verified, false); assert.equal(state.model_reply_verified, false);
  assert.equal(state.sessions[0].native_session_id, 'thread-two');
  assert.throws(() => v.record({ event: 'protocol_verified', source: 'desktop_selftest', executor_kind: 'desktop' }), { code: 'connection_identity_conflict' });
});

test('desktop automation needs protocol, reply, actual dialogue and a live runner in the same session', t => {
  const v = setup(t), message = v.reply(), desktop = input => v.record({ session_ref: 'desktop:one', executor_kind: 'desktop', native_session_id: 'actual-dialogue-one', ...input });
  v.record({ event: 'protocol_verified', source: 'cli_tool_call' });
  desktop({ event: 'model_reply', source: 'desktop_visible_reply', message_id: message.id });
  desktop({ event: 'dialogue_verified', source: 'desktop_executor_observation' });
  desktop({ event: 'runner_started', pid: 42 });
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, false, 'separate sessions cannot combine their protocol and model proof');
  desktop({ event: 'protocol_verified', source: 'desktop_connector_tool_call' });
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, true);
  assert.equal(v.runtime.connectionState(v.member.id).native_conversation_loaded, true);
  v.advance(10000);
  assert.equal(v.runtime.connectionState(v.member.id).native_conversation_loaded, false);
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, false);
});

test('model failures retain the last actual success without declaring the protocol broken', t => {
  const v = setup(t), message = v.reply();
  v.record({ event: 'protocol_verified', source: 'codex_mcp_tool_call' });
  v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: message.id });
  v.advance(1000); v.record({ event: 'failed', error_stage: 'model', error_code: 'quota_required' });
  const state = v.runtime.connectionState(v.member.id);
  assert.equal(state.protocol_verified, true); assert.equal(state.model_reply_verified, false); assert.equal(state.automatic_reply_verified, false);
  assert.equal(state.sessions[0].model.state, 'failed'); assert.ok(state.sessions[0].model.last_success_at);
  assert.equal(state.last_error.stage, 'model');
  v.record({ event: 'protocol_verified', source: 'codex_mcp_tool_call' });
  assert.equal(v.runtime.connectionState(v.member.id).model_reply_verified, false, 'an MCP retry cannot erase a model failure');
  v.record({ event: 'model_reply', source: 'managed_final_answer', message_id: message.id });
  assert.equal(v.runtime.connectionState(v.member.id).model_reply_verified,false,'re-reading an older successful answer cannot erase a later model failure');
  const fresh=v.reply('question-two');v.record({event:'model_reply',source:'managed_final_answer',message_id:fresh.id});
  assert.equal(v.runtime.connectionState(v.member.id).model_reply_verified,true);
});

test('a dialogue failure and successful reconnect cannot resurrect an older failed model reply', t => {
  const v = setup(t), old = v.reply('old-native-question'), desktop = input => v.record({ session_ref: 'desktop:one', executor_kind: 'desktop', native_session_id: 'owned-native-chat', ...input });
  desktop({ event: 'protocol_verified', source: 'native_transport' }); desktop({ event: 'dialogue_verified', source: 'native_load' }); desktop({ event: 'runner_started', pid: 42 });
  desktop({ event: 'model_reply', source: 'native_correlated_reply', message_id: old.id });
  const successAt = v.runtime.connectionState(v.member.id).sessions[0].model.last_success_at;
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, true);
  v.advance(1000); desktop({ event: 'failed', error_stage: 'model', error_code: 'model_failed' });
  v.advance(1000); desktop({ event: 'failed', error_stage: 'dialogue', error_code: 'connect_failed' });
  assert.equal(v.runtime.connectionState(v.member.id).last_error.stage, 'dialogue');
  desktop({ event: 'runner_stopped' });
  v.advance(1000); desktop({ event: 'protocol_verified', source: 'native_transport' }); desktop({ event: 'dialogue_verified', source: 'native_load' }); desktop({ event: 'runner_started', pid: 42 });
  const recovered = v.runtime.connectionState(v.member.id);
  assert.equal(recovered.protocol_verified, true); assert.equal(recovered.native_conversation_loaded, true);
  assert.equal(recovered.model_reply_verified, false); assert.equal(recovered.automatic_reply_verified, false);
  assert.equal(recovered.last_error.stage, 'model'); assert.equal(recovered.last_error.code, 'model_failed'); assert.equal(recovered.sessions[0].model.last_success_at, successAt);
  desktop({ event: 'model_reply', source: 'native_correlated_reply', message_id: old.id });
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, false, 'an older answered message is not new repair evidence');
  const fresh = v.reply('new-native-question'); desktop({ event: 'model_reply', source: 'native_correlated_reply', message_id: fresh.id });
  assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, true); assert.equal(v.runtime.connectionState(v.member.id).last_error, null);
});

test('new model success cannot clear a separate protocol failure and independent failures survive read-only reopen', t => {
  const v = setup(t), old = v.reply('model-before-failures');
  v.record({ event: 'protocol_verified', source: 'cli_protocol' }); v.record({ event: 'model_reply', source: 'cli_answer', message_id: old.id });
  v.advance(1000); v.record({ event: 'failed', error_stage: 'model', error_code: 'model_failed' });
  v.advance(1000); v.record({ event: 'failed', error_stage: 'protocol', error_code: 'protocol_failed' });
  const readonly = readOnlyEvidence(v);
  try {
    const state = readonly.evidence.state(v.member.id); assert.equal(state.protocol_verified, false); assert.equal(state.model_reply_verified, false); assert.equal(state.last_error.stage, 'protocol');
    assert.throws(() => readonly.evidence.record(v.member.id, { event: 'runner_stopped' }), { code: 'read_only_state' });
  } finally { readonly.db.close(); }
  const fresh = v.reply('model-after-failures'); v.record({ event: 'model_reply', source: 'cli_answer', message_id: fresh.id });
  const state = v.runtime.connectionState(v.member.id); assert.equal(state.model_reply_verified, true); assert.equal(state.protocol_verified, false); assert.equal(state.automatic_reply_verified, false); assert.equal(state.last_error.code, 'protocol_failed');
  v.record({ event: 'protocol_verified', source: 'cli_protocol' }); assert.equal(v.runtime.connectionState(v.member.id).automatic_reply_verified, true);
});

function readOnlyEvidence(value) {
  const db = new DatabaseSync(path.join(value.data, 'room.sqlite'), { readOnly: true });
  const store = Object.assign(Object.create(Store.prototype), { db, dir: value.data });
  const chat = new ChatStore(store, { readOnly: true });
  return { db, evidence: new ConnectionEvidence(chat, { readOnly: true, clock: value.runtime.connectionEvidence.clock, isPidAlive: pid => value.alive.has(pid) }) };
}

test('legacy persisted errors stay readable without schema writes and migrate without losing model failure', t => {
  const v = setup(t), old = v.reply('legacy-success');
  v.record({ event: 'protocol_verified', source: 'legacy_protocol' }); v.record({ event: 'model_reply', source: 'legacy_answer', message_id: old.id });
  v.advance(1000); v.record({ event: 'failed', error_stage: 'model', error_code: 'legacy_model_failed' });
  v.store.db.exec('ALTER TABLE connection_session_evidence DROP COLUMN stage_failures');
  const readonly = readOnlyEvidence(v);
  try {
    const state = readonly.evidence.state(v.member.id); assert.equal(state.protocol_verified, true); assert.equal(state.model_reply_verified, false); assert.equal(state.last_error.code, 'legacy_model_failed'); assert.ok(state.sessions[0].model.last_success_at);
    assert.equal(readonly.db.prepare('PRAGMA table_info(connection_session_evidence)').all().some(column => column.name === 'stage_failures'), false);
  } finally { readonly.db.close(); }
  const migrated = new ConnectionEvidence(v.chat, { clock: v.runtime.connectionEvidence.clock, ownerId: 'owner:one', isPidAlive: pid => v.alive.has(pid) });
  assert.equal(v.store.db.prepare('PRAGMA table_info(connection_session_evidence)').all().filter(column => column.name === 'stage_failures').length, 1);
  v.advance(1000); const base = { session_ref: 'native:one', executor_kind: 'managed_cli', native_session_id: 'thread-one' };
  migrated.record(v.member.id, { ...base, event: 'failed', error_stage: 'protocol', error_code: 'new_protocol_failure' });
  migrated.record(v.member.id, { ...base, event: 'protocol_verified', source: 'new_protocol' });
  assert.equal(migrated.state(v.member.id).model_reply_verified, false); assert.equal(migrated.state(v.member.id).last_error.code, 'legacy_model_failed');
  const reopened = new ConnectionEvidence(v.chat, { clock: v.runtime.connectionEvidence.clock, ownerId: 'owner:one' });
  assert.equal(reopened.state(v.member.id).model_reply_verified, false); assert.equal(reopened.state(v.member.id).last_error.stage, 'model');
});

test('evidence errors exclude arbitrary prompt and secret text and reject unbounded leases', t => {
  const v = setup(t);
  assert.throws(() => v.record({ event: 'failed', error_stage: 'model', error_code: 'secret=private token' }), { code: 'connection_evidence_invalid' });
  assert.throws(() => v.record({ event: 'failed', error_stage: 'model', error_code: 'quota', error: 'private secret' }), { code: 'connection_evidence_invalid' });
  assert.throws(() => v.record({ event: 'runner_started', pid: 42, ttl_ms: 300001 }), { code: 'connection_evidence_invalid' });
  assert.deepEqual(v.runtime.connectionState(v.member.id).sessions, []);
});
