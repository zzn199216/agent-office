'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fixture } = require('./helpers.cjs');
const { LaunchWatch, publicCandidates } = require('../src/launch-watch.cjs');

function setup(t, legacy = false) {
  const f = fixture(), db = new DatabaseSync(path.join(f.root, 'watch.sqlite'));
  db.exec("CREATE TABLE launch_sessions(id TEXT PRIMARY KEY,room_id TEXT,status TEXT); CREATE TABLE launch_proxies(id TEXT PRIMARY KEY,room_id TEXT,provider TEXT);");
  if (legacy) db.exec("CREATE TABLE launch_watches(room_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,last_fingerprint TEXT,last_scan TEXT,revision INTEGER NOT NULL DEFAULT 1,notified_revision INTEGER NOT NULL DEFAULT 0,goal TEXT NOT NULL DEFAULT '',auto_install INTEGER NOT NULL DEFAULT 1); CREATE TABLE launch_watch_attempts(room_id TEXT,provider TEXT,status TEXT,created TEXT,error TEXT,PRIMARY KEY(room_id,provider)); INSERT INTO launch_watches VALUES('one',1,'historical-fingerprint','2026-10-12T05:00:00Z',7,4,'user goal',1); INSERT INTO launch_watch_attempts VALUES('one','claude-code','failed','2026-10-12T05:01:00Z','historical failure');");
  let scans = 0, prepares = 0;
  const launch = { db, closing: false, jobs: new Map(), options: { discover() { scans++; throw new Error('must never scan'); } },
    service: { chat: { discover() { scans++; throw new Error('must never scan'); } } },
    prepare() { prepares++; throw new Error('must never prepare'); } };
  const watch = new LaunchWatch(launch, { intervalMs: 25 });
  t.after(async () => { await watch.close(); db.close(); });
  return { db, watch, launch, get scans() { return scans; }, get prepares() { return prepares; } };
}

test('compatibility watchers never start a timer or discovery, even after explicit start and forced tick', async t => {
  const v = setup(t);
  assert.equal(v.watch.timer, null); assert.equal(v.scans, 0);
  v.watch.start(); assert.equal(v.watch.timer, null);
  for (let i = 0; i < 3; i++) assert.equal((await v.watch.tick({ force: true })).status, 'automatic_sync_disabled');
  assert.equal(v.scans, 0); assert.equal(v.prepares, 0); assert.equal(v.watch.status('one').enabled, false);
  assert.throws(() => v.watch.enroll('one', { auto_install: true }), error => error.status === 403 && error.code === 'automatic_sync_disabled');
});

test('upgrade disables old opt-ins before startup and preserves scan and attempt history', async t => {
  const v = setup(t, true), saved = v.db.prepare('SELECT * FROM launch_watches WHERE room_id=?').get('one');
  assert.equal(saved.enabled, 0); assert.equal(saved.auto_install, 0);
  assert.equal(saved.last_fingerprint, 'historical-fingerprint'); assert.equal(saved.last_scan, '2026-10-12T05:00:00Z');
  assert.equal(saved.revision, 7); assert.equal(saved.notified_revision, 4); assert.equal(saved.goal, 'user goal');
  assert.equal(v.db.prepare('SELECT status,error FROM launch_watch_attempts').get().status, 'failed');
  const restored = new LaunchWatch(v.launch); restored.start(); await restored.tick({ force: true }); await restored.close();
  assert.equal(v.scans, 0); assert.equal(v.prepares, 0); assert.equal(restored.timer, null);
});

test('stale persistence cannot re-enable automated work through a compatibility method', async t => {
  const v = setup(t, true);
  v.db.prepare('UPDATE launch_watches SET enabled=1,auto_install=1').run();
  await v.watch.tick({ force: true }); v.watch.start();
  const result = await v.watch.sync('one', { changes_only: false });
  assert.equal(result.status, 'automatic_sync_disabled'); assert.equal(result.changed, false); assert.deepEqual(result.actions, []);
  assert.equal(result.watch.enabled, false); assert.equal(result.watch.native_routine_enabled, false);
  assert.equal(v.scans, 0); assert.equal(v.prepares, 0); assert.equal(v.watch.timer, null);
});

test('local disabled state does not assert that a remote Grok routine was actually paused', t => {
  const v = setup(t, true), state = v.watch.status('one');
  assert.equal(state.notification_mode, 'disabled');
  assert.equal(state.host_notification.status, 'pause_legacy_routine'); assert.match(state.host_notification.detail, /实际暂停/);
  assert.equal(state.interval_seconds, null); assert.equal(state.discovery_mode, 'on_request');
});

test('manual inventory sanitization excludes argv, arbitrary environment and process command lines', () => {
  const result = publicCandidates({ candidates: [{ provider: 'codex', name: 'Codex', installed: true, running: true,
    executable: path.join(process.cwd(), 'codex.exe'), executable_args: ['--key', 'crsr_fake_secret'], pids: [1234],
    capabilities: { automatic_launch: true }, commandLine: 'Bearer crsr_fake_secret', env: { KEY: 'private-fixture' },
    instances: [{ pid: 1234, role: 'desktop', commandLine: 'Bearer crsr_fake_secret' }] }] });
  assert.equal(result[0].provider, 'codex'); assert.equal(result[0].running, true); assert.deepEqual(result[0].executable_args, []);
  const json = JSON.stringify(result); assert.equal(json.includes('crsr_fake_secret'), false);
  assert.equal(json.includes('commandLine'), false); assert.equal(json.includes('private-fixture'), false);
  assert.throws(() => publicCandidates({}), error => error.code === 'discovery_invalid');
});
