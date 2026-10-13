'use strict';
const path = require('node:path');
const { RoomError, redact } = require('./util.cjs');

const providerName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value) ? value : null;
const safeText = value => redact(typeof value === 'string' ? value : '').slice(0, 1200);
const array = value => Array.isArray(value) ? value : [];
function publicCandidates(scan) {
  if (!scan || !Array.isArray(scan.candidates)) throw new RoomError('发现结果结构无效。', 503, 'discovery_invalid');
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  return scan.candidates.filter(candidate => providerName(candidate?.provider || candidate?.id)).map(candidate => {
    const capabilities = {};
    for (const name of ['automatic_launch', 'mcp_prepare', 'mcp_install', 'runtime_install', 'manual_connect', 'attach_existing', 'native_group_proxy']) capabilities[name] = candidate.capabilities?.[name] === true;
    const row = { id: safeText(candidate.id || candidate.provider), provider: candidate.provider || candidate.id,
      name: safeText(candidate.name || candidate.provider || candidate.id), adapter: safeText(candidate.adapter || 'mailbox'),
      installed: candidate.installed === true, running: candidate.running === true, capabilities,
      executable: safeText(candidate.executable) || null,
      executable_args: array(candidate.executable_args).filter(value => typeof value === 'string' && path.isAbsolute(value) && /\.(?:js|cjs|mjs)$/i.test(value)).map(safeText),
      support: ['ready', 'needs_setup', 'unsupported'].includes(candidate.support) ? candidate.support : 'needs_setup',
      reason: safeText(candidate.reason), setup_note: safeText(candidate.setup_note), can_connect: candidate.can_connect === true,
      pids: array(candidate.pids).map(positive).filter(Boolean),
      instances: array(candidate.instances).filter(Boolean).map(instance => ({ pid: positive(instance.pid), parent_pid: positive(instance.parent_pid), executable: safeText(instance.executable) || null,
        role: ['cli', 'desktop', 'unknown'].includes(instance.role) ? instance.role : 'unknown',
        confidence: ['process_name', 'script_path', 'verified_path'].includes(instance.confidence) ? instance.confidence : 'process_name' })),
      identity: { confidence: safeText(candidate.identity?.confidence), handshake_verified: candidate.identity?.handshake_verified === true },
      actions: array(candidate.actions).filter(Boolean).map(action => ({ id: safeText(action.id), label: safeText(action.label) })) };
    if (candidate.connection) row.connection = { status: ['connected', 'offline', 'unknown', 'needs_setup'].includes(candidate.connection.status) ? candidate.connection.status : 'unknown',
      connected_count: Math.max(0, Number(candidate.connection.connected_count) || 0), online_count: Math.max(0, Number(candidate.connection.online_count) || 0) };
    return row;
  });
}

// Kept as a compatibility boundary for 0.4.0 callers and its persisted audit
// tables. There is intentionally no timer, discovery, enrollment or launch.
class LaunchWatch {
  constructor(launch) {
    this.launch = launch; this.db = launch.db; this.service = launch.service;
    this.timer = null; this.inflight = null; this.closing = false;
    this.db.exec("CREATE TABLE IF NOT EXISTS launch_watches (room_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, last_fingerprint TEXT, last_scan TEXT, revision INTEGER NOT NULL DEFAULT 1, notified_revision INTEGER NOT NULL DEFAULT 0, goal TEXT NOT NULL DEFAULT '', auto_install INTEGER NOT NULL DEFAULT 0, last_delivery_fingerprint TEXT, last_error TEXT); CREATE TABLE IF NOT EXISTS launch_watch_attempts (room_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL, error TEXT, PRIMARY KEY(room_id,provider));");
    const columns = new Set(this.db.prepare('PRAGMA table_info(launch_watches)').all().map(row => row.name));
    for (const name of ['last_delivery_fingerprint', 'last_error']) if (!columns.has(name)) this.db.exec('ALTER TABLE launch_watches ADD COLUMN ' + name + ' TEXT');
    // Upgrading must disable old opt-ins before service startup. Preserve all
    // scan, attempt, revision and error evidence instead of deleting history.
    this.db.prepare('UPDATE launch_watches SET enabled=0,auto_install=0 WHERE enabled<>0 OR auto_install<>0').run();
  }
  status(roomId) {
    const row = this.db.prepare('SELECT * FROM launch_watches WHERE room_id=?').get(roomId);
    return { room_id: roomId, enabled: false, auto_install: false,
      last_scan: row?.last_scan || null, revision: row?.revision || 0, notified_revision: row?.notified_revision || 0,
      last_error: row?.last_error || null, discovery_mode: 'on_request', interval_seconds: null,
      notification_mode: 'disabled', native_routine_enabled: false,
      host_notification: { status: 'pause_legacy_routine', detail: '仅在用户要求时扫描和接入；旧原生例程须由 Grok 实际暂停。' } };
  }
  enroll() { throw new RoomError('用户已禁用定期扫描和自动接入。', 403, 'automatic_sync_disabled'); }
  async tick() { return { status: 'automatic_sync_disabled', changed: [], prepared: [] }; }
  async sync(roomId) {
    return { status: 'automatic_sync_disabled', room_id: roomId, changed: false, actions: [], watch: this.status(roomId),
      instruction: '请实际暂停旧的原生成员同步例程；不要扫描或接入新成员。' };
  }
  start() { return { status: 'automatic_sync_disabled' }; }
  async close() { this.closing = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
module.exports = { LaunchWatch, publicCandidates };
