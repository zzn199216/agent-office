'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');
const { ResumeAccess } = require('../src/resume.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture();
  let store = new Store(files.data), chat = new ChatStore(store);
  const instanceId = 'persisted-instance-fixture';
  const options = { instanceId, dataDirectory: files.data, command: process.execPath, args: ['source-entry-fixture.cjs'] };
  let access = new ResumeAccess(chat, options);
  const project = store.addProject('恢复入口测试', files.project);
  const room = chat.addRoom({ title: '原聊天室', project_id: project.id });
  const member = chat.addMember({ name: '本机桥接成员', adapter: 'mailbox', config: { authorization: 'Bearer control-provider-secret-fixture', webhook_key: 'crsr_hidden_fixture' } });
  chat.join(room.id, member.id);
  t.after(() => { store.close(); fs.rmSync(files.root, { recursive: true, force: true }); });
  return {
    ...files, project, room, member, options,
    get store() { return store; }, get chat() { return chat; }, get access() { return access; },
    restart() { store.close(); store = new Store(files.data); chat = new ChatStore(store); access = new ResumeAccess(chat, options); }
  };
}

test('a user-issued long-lived card stays pending until a real accept and survives restart', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id);
  assert.equal(issued.card.schema, 'agentroom.resume');
  assert.equal(issued.card.version, 1);
  assert.equal(issued.credential.status, 'pending');
  assert.equal(issued.file, null);
  assert.equal(state.chat.member(state.member.id).verified_at, null);
  assert.equal(state.chat.member(state.member.id).status, 'awaiting_handshake');
  assert.equal(state.access.inspect(issued.card).valid, true);
  assert.equal(state.chat.member(state.member.id).verified_at, null, 'inspect never marks the member online or verified');
  state.restart();
  const accepted = state.access.accept(JSON.stringify(issued.card));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.credential.status, 'active');
  assert.equal(accepted.credential.last_seen, accepted.last_seen);
  assert.equal(state.chat.member(state.member.id).status, 'ready');
  assert.equal(state.chat.member(state.member.id).verified_at, accepted.last_seen);
  assert.equal(Object.hasOwn(accepted, 'secret'), false);
  state.restart();
  assert.equal(state.access.accept(issued.card).credential.accepted_at, accepted.credential.accepted_at);
  assert.equal(state.chat.db.prepare('SELECT count(*) AS count FROM chat_invitations').get().count, 0);
});

test('cards contain only member credentials and launcher hints, and SQLite persists only a hash', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id, { file: path.join(state.root, 'private', 'entry.json') });
  const written = JSON.parse(fs.readFileSync(issued.file, 'utf8'));
  assert.deepEqual(written, issued.card);
  assert.equal(written.data_directory, fs.realpathSync.native(state.data));
  assert.equal(written.launch_command, process.execPath);
  assert.deepEqual(written.launch_args, ['source-entry-fixture.cjs']);
  assert.doesNotMatch(JSON.stringify(written), /control-provider-secret-fixture|crsr_hidden_fixture|control_token|webhook_key/);
  const stored = state.chat.db.prepare('SELECT * FROM chat_resume_credentials WHERE id=?').get(issued.credential.id);
  assert.equal(stored.secret_hash.length, 64);
  assert.equal(Object.hasOwn(stored, 'secret'), false);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(issued.card.secret));
  assert.equal(Object.hasOwn(state.access.credentials()[0], 'secret_hash'), false);
  assert.equal(Object.hasOwn(state.access.inspect(written).credential, 'secret_hash'), false);
  assert.equal(fs.readdirSync(path.dirname(issued.file)).filter(name => name.endsWith('.tmp')).length, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(issued.file).mode & 0o777, 0o600);
});

test('wrong instances, members, rooms, versions and secrets cannot be accepted or alter membership', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id), card = issued.card;
  assert.throws(() => state.access.accept({ ...card, instance_id: 'different-existing-instance' }), { status: 409, code: 'resume_instance_mismatch' });
  assert.throws(() => state.access.accept({ ...card, member_id: 'different-member' }), { status: 403, code: 'resume_scope_mismatch' });
  assert.throws(() => state.access.accept({ ...card, room_id: 'different-room' }), { status: 403, code: 'resume_scope_mismatch' });
  assert.throws(() => state.access.accept({ ...card, credential_id: 'unknown-credential' }), { status: 404, code: 'resume_not_found' });
  assert.throws(() => state.access.accept({ ...card, secret: 'a'.repeat(43) }), { status: 403, code: 'invalid_resume_secret' });
  assert.throws(() => state.access.accept({ ...card, version: 2 }), { code: 'invalid_resume_card' });
  assert.throws(() => state.access.accept('{invalid-json'), { code: 'invalid_resume_card' });
  assert.equal(state.access.credential(card.credential_id).status, 'pending');
  assert.equal(state.chat.member(state.member.id).verified_at, null);
});

test('launcher hints are never executed or used to silently create or switch databases', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id);
  const nonexistentData = path.join(state.root, 'must-not-be-created');
  const modified = { ...issued.card, data_directory: nonexistentData, launch_command: 'must-never-execute-fixture', launch_args: ['--anything'] };
  const inspected = state.access.inspect(modified);
  assert.equal(inspected.valid, true);
  assert.equal(inspected.location_hint_matches, false);
  assert.equal(inspected.data_directory, fs.realpathSync.native(state.data));
  state.access.accept(modified);
  assert.equal(fs.existsSync(nonexistentData), false);
});

test('accepting an already verified member preserves native verification and runtime errors', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id);
  const originalVerification = '2026-10-01T03:00:00.000Z';
  state.chat.updateMember(state.member.id, { verified_at: originalVerification, status: 'connecting', error: '原生会话仍在恢复中' });
  state.access.accept(issued.card);
  let member = state.chat.member(state.member.id);
  assert.equal(member.verified_at, originalVerification);
  assert.equal(member.status, 'connecting');
  assert.equal(member.error, '原生会话仍在恢复中');
  state.chat.updateMember(state.member.id, { status: 'error', error: '原生会话连接失败，请核对' });
  state.restart();
  const accepted = state.access.accept(issued.card);
  member = state.chat.member(state.member.id);
  assert.equal(member.verified_at, originalVerification);
  assert.equal(member.status, 'error');
  assert.equal(member.error, '原生会话连接失败，请核对');
  assert.equal(accepted.credential.last_seen, accepted.last_seen);
});

test('revocation persists across restart and leaving the room prevents credential resurrection', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id);
  state.access.accept(issued.card);
  const first = state.access.revoke(issued.credential.id), second = state.access.revoke(issued.credential.id);
  assert.deepEqual(first, second, 'revoke is idempotent');
  state.restart();
  assert.throws(() => state.access.inspect(issued.card), { status: 410, code: 'resume_revoked' });
  assert.throws(() => state.access.accept(issued.card), { status: 410, code: 'resume_revoked' });
  const other = state.access.issue(state.member.id, state.room.id);
  state.chat.leave(state.room.id, state.member.id);
  assert.throws(() => state.access.accept(other.card), { status: 403, code: 'not_in_room' });
  assert.equal(state.chat.joined(state.room.id, state.member.id), false);
  assert.equal(state.access.credential(other.credential.id).status, 'pending');
  assert.throws(() => state.access.issue(state.member.id, state.room.id), { code: 'not_in_room' });
});

test('a failed atomic file save cannot issue a usable database credential', t => {
  const state = setup(t), fileAsParent = path.join(state.root, 'not-a-directory');
  fs.writeFileSync(fileAsParent, 'fixture');
  assert.throws(() => state.access.issue(state.member.id, state.room.id, { file: path.join(fileAsParent, 'entry.json') }));
  assert.equal(state.access.credentials().length, 0);
  assert.equal(state.chat.member(state.member.id).verified_at, null);
});

test('a read-only connection can inspect existing cards without DDL, accepting or creating files', t => {
  const state = setup(t), issued = state.access.issue(state.member.id, state.room.id);
  const readonlyStore = new Store(state.data, { readOnly: true });
  try {
    const readonlyChat = new ChatStore(readonlyStore, { readOnly: true });
    const readonlyAccess = new ResumeAccess(readonlyChat, { ...state.options, readOnly: true });
    assert.equal(readonlyAccess.inspect(issued.card).valid, true);
    assert.equal(readonlyAccess.credential(issued.credential.id).status, 'pending');
    assert.throws(() => readonlyAccess.accept(issued.card), { status: 403, code: 'resume_read_only' });
    assert.throws(() => readonlyAccess.revoke(issued.credential.id), { status: 403, code: 'resume_read_only' });
    const unwantedFile = path.join(state.root, 'never-issued.json');
    assert.throws(() => readonlyAccess.issue(state.member.id, state.room.id, { file: unwantedFile }), { status: 403, code: 'resume_read_only' });
    assert.equal(fs.existsSync(unwantedFile), false);
    assert.equal(state.access.credentials().length, 1);
    assert.equal(state.chat.member(state.member.id).verified_at, null);
    assert.equal(state.access.credential(issued.credential.id).last_seen, null);
  } finally { readonlyStore.close(); }
});
