'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { Store } = require('../src/store.cjs');
const { ChatStore } = require('../src/chat-store.cjs');
const { RuntimeState } = require('../src/runtime-state.cjs');
const { ResumeAccess } = require('../src/resume.cjs');
const { inspectLegacy, legacyCandidates, migrateLegacy } = require('../src/migrate.cjs');
const { readEntry, acceptEntry, diskState } = require('../src/entry.cjs');
const { resolveDataDirectory, dataDirectory } = require('../src/util.cjs');
const { fixture } = require('./helpers.cjs');

function setup(t) {
  const files = fixture(), profile = path.join(files.root, 'test-profile'), local = path.join(profile, 'AppData', 'Local');
  const source = path.join(local, 'AgentRoom'), packaged = path.join(local, 'Packages', 'OpenAI.Codex_fixture', 'LocalCache', 'Local', 'AgentRoom'), target = path.join(files.root, 'shared-instance');
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = profile;
  t.after(() => { if (previous === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous; fs.rmSync(files.root, { recursive: true, force: true }); });
  return { ...files, profile, source, packaged, target };
}
function seed(files, directory, { populated = true } = {}) {
  const store = new Store(directory), chat = new ChatStore(store), runtime = new RuntimeState(chat);
  let result = { instance: runtime.instanceId };
  try {
    if (populated) {
      const project = store.addProject('旧实例项目', files.project), room = chat.addRoom({ title: '旧聊天室', project_id: project.id });
      const member = chat.addMember({ name: '旧桥接成员', adapter: 'mailbox' }); chat.join(room.id, member.id);
      const message = chat.post({ room_id: room.id, to_member_id: member.id, text: '原始待核对问题', idempotency_key: 'legacy-uncertain' });
      chat.updateMessage(message.id, { status: 'uncertain', error: '上一进程已结束，结果待核对。' });
      result = { ...result, project, room, member, message };
    }
  } finally { store.close(); }
  const encrypted = Buffer.from('{"mode":"dpapi","value":"fixture-opaque-ciphertext-do-not-decrypt"}\r\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'grok-vault.json'), encrypted);
  const memberDirectory = path.join(directory, 'members', result.member?.id || 'empty-fixture-member'); fs.mkdirSync(memberDirectory, { recursive: true });
  fs.writeFileSync(path.join(memberDirectory, 'grok-vault.json'), encrypted);
  const exportDirectory = path.join(directory, 'chatrooms', result.room?.id || 'empty-fixture-room'); fs.mkdirSync(exportDirectory, { recursive: true });
  fs.writeFileSync(path.join(exportDirectory, 'history.md'), '原中文记录\n');
  fs.mkdirSync(path.join(directory, 'bin')); fs.writeFileSync(path.join(directory, 'bin', 'AgentRoom.exe'), 'not an executable: isolated fixture');
  fs.writeFileSync(path.join(directory, 'daemon.lock'), '{"pid":999999999}');
  return { ...result, encrypted, memberDirectory, exportDirectory };
}

test('automatic discovery chooses the populated legacy instance and retains its IDs, pending work and encrypted bytes', async t => {
  const files = setup(t); seed(files, files.source, { populated: false }); const before = seed(files, files.packaged);
  assert.equal(inspectLegacy(files.source).populated, false);
  assert.equal(legacyCandidates().length, 2);
  const result = await migrateLegacy(files.target);
  assert.equal(result.migrated, true); assert.equal(result.from, fs.realpathSync.native(files.packaged));
  const store = new Store(files.target, { readOnly: true });
  try {
    const chat = new ChatStore(store, { readOnly: true }), runtime = new RuntimeState(chat, { readOnly: true });
    assert.equal(runtime.instanceId, before.instance);
    assert.equal(chat.rooms()[0].id, before.room.id); assert.equal(store.projects()[0].id, before.project.id);
    assert.equal(chat.member(before.member.id).id, before.member.id);
    assert.equal(chat.message(before.message.id).status, 'uncertain');
    assert.equal(chat.message(before.message.id).text, before.message.text);
    assert.equal(runtime.roomState(before.room.id).dispatchable, 0);
  } finally { store.close(); }
  assert.deepEqual(fs.readFileSync(path.join(files.target, 'grok-vault.json')), before.encrypted);
  assert.deepEqual(fs.readFileSync(path.join(files.target, 'members', before.member.id, 'grok-vault.json')), before.encrypted);
  assert.equal(fs.readFileSync(path.join(files.target, 'chatrooms', before.room.id, 'history.md'), 'utf8'), '原中文记录\n');
  assert.equal(fs.existsSync(path.join(files.target, 'bin')), false);
  assert.equal(fs.existsSync(path.join(files.target, 'daemon.lock')), false);
  assert.equal(fs.existsSync(path.join(files.target, 'control.json')), false);
  assert.equal(fs.existsSync(path.join(files.packaged, 'room.sqlite')), true, 'the source remains recoverable');
});

test('a populated shared target is never overwritten or merged with a discovered legacy instance', async t => {
  const files = setup(t); seed(files, files.source); const targetState = seed(files, files.target);
  const databaseBytes = fs.readFileSync(path.join(files.target, 'room.sqlite'));
  const credentials = Buffer.from('target-owned-encrypted-credential-bytes'); fs.writeFileSync(path.join(files.target, 'grok-vault.json'), credentials);
  const result = await migrateLegacy(files.target);
  assert.equal(result.migrated, false); assert.equal(result.reason, 'existing_shared_instance');
  assert.deepEqual(fs.readFileSync(path.join(files.target, 'room.sqlite')), databaseBytes);
  assert.deepEqual(fs.readFileSync(path.join(files.target, 'grok-vault.json')), credentials);
  const store = new Store(files.target, { readOnly: true });
  try { assert.equal(store.setting('instance_fingerprint'), targetState.instance); }
  finally { store.close(); }
  assert.equal(fs.existsSync(path.join(files.target, 'migration.json')), false);
});

test('multiple populated old instances require explicit selection instead of silent precedence', async t => {
  const files = setup(t); seed(files, files.source); seed(files, files.packaged);
  await assert.rejects(() => migrateLegacy(files.target), error => error.code === 'migration_source_ambiguous');
  assert.equal(fs.existsSync(files.target), false);
  const selected = await migrateLegacy(files.target, { from: files.packaged });
  assert.equal(selected.from, fs.realpathSync.native(files.packaged));
});

test('an old control PID that is still alive blocks copying until an explicit stop callback completes', async t => {
  const files = setup(t), old = seed(files, files.source), control = path.join(files.source, 'control.json');
  fs.writeFileSync(control, JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1', token: 'fixture-control-token' }));
  await assert.rejects(() => migrateLegacy(files.target, { from: files.source }), error => error.code === 'migration_busy');
  assert.equal(fs.existsSync(files.target), false);
  let stopped = 0;
  const result = await migrateLegacy(files.target, { from: files.source, stop: async directory => { stopped++; assert.equal(directory, fs.realpathSync.native(files.source)); fs.unlinkSync(control); } });
  assert.equal(stopped, 1); assert.equal(result.migrated, true);
  assert.equal(fs.existsSync(path.join(files.source, 'room.sqlite')), true);
  assert.deepEqual(fs.readFileSync(path.join(files.source, 'grok-vault.json')), old.encrypted);
  assert.deepEqual(fs.readFileSync(path.join(files.target, 'grok-vault.json')), old.encrypted);
});

test('an uncheckpointed WAL is refused and no incomplete target database or credentials are published', async t => {
  const files = setup(t); seed(files, files.source);
  const writer = new DatabaseSync(path.join(files.source, 'room.sqlite'));
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    writer.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('uncheckpointed-fixture', JSON.stringify('exists only in WAL until checkpoint'));
    assert.ok(fs.statSync(path.join(files.source, 'room.sqlite-wal')).size > 0);
    await assert.rejects(() => migrateLegacy(files.target, { from: files.source }), error => error.code === 'migration_wal_pending');
    assert.equal(fs.existsSync(path.join(files.target, 'room.sqlite')), false);
    assert.equal(fs.existsSync(path.join(files.target, 'migration.json')), false);
    assert.equal(fs.existsSync(path.join(files.target, 'grok-vault.json')), false);
    assert.equal(fs.existsSync(path.join(files.target, 'members')), false);
    assert.equal(writer.prepare('SELECT value FROM settings WHERE key=?').get('uncheckpointed-fixture').value, JSON.stringify('exists only in WAL until checkpoint'));
  } finally { writer.close(); }
  const completed = await migrateLegacy(files.target, { from: files.source });
  assert.equal(completed.migrated, true, 'retry after an explicit checkpoint/close publishes a complete database');
  const migrated = new Store(files.target, { readOnly: true });
  try { assert.equal(migrated.setting('uncheckpointed-fixture'), 'exists only in WAL until checkpoint'); }
  finally { migrated.close(); }
});

test('an explicitly invalid migration source fails instead of becoming a new empty install', async t => {
  const files = setup(t), missing = path.join(files.root, 'missing-legacy');
  await assert.rejects(() => migrateLegacy(files.target, { from: missing }), error => error.code === 'migration_source_missing' && error.status === 404);
  assert.equal(fs.existsSync(files.target), false); assert.equal(fs.existsSync(missing), false);
  const invalid = path.join(files.root, 'foreign-data'); fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, 'room.sqlite'), 'not a SQLite AgentRoom database');
  await assert.rejects(() => migrateLegacy(files.target, { from: invalid }), error => error.code === 'migration_source_missing');
  assert.equal(fs.existsSync(files.target), false);
});

test('a pre-migration entry card keeps its credential and redirects all helper state writes to the single migrated instance', async t => {
  const files = setup(t), before = seed(files, files.source);
  const store = new Store(files.source), chat = new ChatStore(store), runtime = new RuntimeState(chat), resume = new ResumeAccess(chat, { instanceId: runtime.instanceId, dataDirectory: files.source });
  const cardFile = path.join(files.source, 'entries', 'existing-entry.json');
  const issued = resume.issue(before.member.id, before.room.id, { file: cardFile }); store.close();
  const sourceDatabase = fs.readFileSync(path.join(files.source, 'room.sqlite'));
  const result = await migrateLegacy(files.target, { from: files.source });
  assert.equal(result.instance_id, issued.card.instance_id);
  const entry = readEntry(cardFile);
  assert.equal(entry.card.data_directory, files.source, 'the original card is not rewritten or rotated');
  assert.equal(entry.dir, path.resolve(files.target));
  assert.equal(entry.card.credential_id, issued.credential.id);
  assert.equal(resolveDataDirectory(files.source), path.resolve(files.target));
  const previous = process.env.AGENTROOM_DATA_DIR; process.env.AGENTROOM_DATA_DIR = files.source;
  try { assert.equal(dataDirectory(), path.resolve(files.target), 'old explicit helper data paths resolve to the same canonical instance'); }
  finally { if (previous === undefined) delete process.env.AGENTROOM_DATA_DIR; else process.env.AGENTROOM_DATA_DIR = previous; }
  const accepted = acceptEntry(entry);
  assert.equal(accepted.credential.id, issued.credential.id); assert.equal(accepted.credential.status, 'active');
  assert.equal(diskState(entry.dir, entry).instance_id, issued.card.instance_id);
  assert.deepEqual(fs.readFileSync(path.join(files.source, 'room.sqlite')), sourceDatabase, 'the old source database remains an unchanged backup rather than a second helper write target');
  const oldStore = new Store(files.source, { readOnly: true });
  try { assert.equal(oldStore.db.prepare('SELECT status FROM chat_resume_credentials WHERE id=?').get(issued.credential.id).status, 'pending'); }
  finally { oldStore.close(); }
  assert.equal(JSON.parse(fs.readFileSync(cardFile, 'utf8')).credential_id, issued.credential.id);
  const command = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'main.cjs'), 'room-state', '--entry', cardFile, '--data-dir', files.source, '--offline'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(command.status, 0, command.stderr);
  const reported = JSON.parse(command.stdout);
  assert.equal(reported.data_directory, fs.realpathSync.native(files.target));
  assert.equal(reported.instance_id, issued.card.instance_id);
  assert.equal(reported.transport, 'disk');
  assert.equal(fs.existsSync(path.join(files.source, 'daemon.log')), false);
  assert.equal(fs.existsSync(path.join(files.target, 'control.json')), false, 'the real CLI offline command does not launch a daemon');
});

test('invalid migration redirect markers and unavailable targets fail without creating fallback databases', t => {
  const files = setup(t), old = seed(files, files.source), marker = path.join(files.source, 'migrated-to.json'), missing = path.join(files.root, 'missing-target');
  fs.writeFileSync(marker, '{not-json');
  assert.throws(() => resolveDataDirectory(files.source), { code: 'migration_redirect_invalid' });
  fs.writeFileSync(marker, JSON.stringify({ schema: 'agentroom.migration', target: missing, instance_id: old.instance }));
  assert.throws(() => resolveDataDirectory(files.source), { code: 'instance_missing' });
  assert.equal(fs.existsSync(missing), false);
  const foreign = path.join(files.root, 'foreign-instance'); seed(files, foreign);
  fs.writeFileSync(marker, JSON.stringify({ schema: 'agentroom.migration', target: foreign, instance_id: old.instance }));
  assert.throws(() => resolveDataDirectory(files.source), { code: 'migration_redirect_invalid' });
  fs.writeFileSync(marker, JSON.stringify({ schema: 'agentroom.migration', target: files.source, instance_id: old.instance }));
  assert.throws(() => resolveDataDirectory(files.source), { code: 'migration_redirect_invalid' });
  assert.equal(fs.existsSync(path.join(files.source, 'migration.json')), false);
});
