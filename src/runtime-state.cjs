'use strict';
const crypto = require('node:crypto');
const { ChatStore } = require('./chat-store.cjs');
const { RoomError, cleanText, livePid } = require('./util.cjs');

const DEFAULT_LEASE_MS = 60000;
const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 300000;
const MESSAGE_STATES = ['posted', 'queued', 'processing', 'delivered', 'consumed', 'completed', 'answered', 'waiting_input', 'uncertain', 'failed', 'cancelled'];

// Registration, recent contact and a live local worker are different evidence.
// This class only reads/writes durable state; constructing it never starts an
// adapter, opens a window, or recovers/replays a partially executed message.
class RuntimeState {
  constructor(storeOrChat, options = {}) {
    this.readOnly = !!options.readOnly;
    this.chat = typeof storeOrChat.member === 'function' && typeof storeOrChat.participants === 'function' ? storeOrChat : new ChatStore(storeOrChat, { readOnly: this.readOnly });
    this.store = this.chat.store;
    this.db = this.chat.db;
    this.clock = options.clock || (() => Date.now());
    this.isPidAlive = options.isPidAlive || livePid;
    if (typeof this.isPidAlive !== 'function') throw new RoomError('后台进程检测器无效。');
    this.leaseMs = this.lease(options.ttlMs === undefined ? DEFAULT_LEASE_MS : options.ttlMs);
    if (!this.readOnly) this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_member_presence (
        member_id TEXT NOT NULL REFERENCES chat_members(id), session_ref TEXT NOT NULL,
        last_seen TEXT NOT NULL, lease_expires TEXT NOT NULL, ended_at TEXT,
        PRIMARY KEY(member_id,session_ref)
      );
      CREATE TABLE IF NOT EXISTS runtime_workers (
        worker_ref TEXT PRIMARY KEY, role TEXT NOT NULL,
        member_id TEXT REFERENCES chat_members(id), pid INTEGER,
        last_seen TEXT NOT NULL, lease_expires TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runtime_adapter_capabilities (
        adapter TEXT PRIMARY KEY, can_wake INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_workers_member ON runtime_workers(member_id);
    `);
    // INSERT OR IGNORE makes two simultaneous local entrypoints converge on
    // one identity rather than overwriting the other's identity.
    if (!this.readOnly) this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('instance_fingerprint', JSON.stringify(crypto.randomUUID()));
    try { this.instanceId = this.store.setting('instance_fingerprint'); } catch { throw new RoomError('本机聊天室实例尚未初始化，不能使用其他空实例替代。', 409, 'instance_not_initialized'); }
    if (typeof this.instanceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(this.instanceId)) throw new RoomError('本机聊天室实例尚未初始化或标识无效。', 409, 'instance_not_initialized');
    if (!this.readOnly && options.wakeAdapters !== undefined) {
      if (!Array.isArray(options.wakeAdapters)) throw new RoomError('唤醒适配器列表无效。');
      for (const adapter of options.wakeAdapters) this.configureWakeAdapter(adapter, true);
    }
  }

  milliseconds() {
    const value = this.clock();
    const milliseconds = value instanceof Date ? value.valueOf() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new RoomError('运行状态时钟无效。');
    return milliseconds;
  }
  date() { return new Date(this.milliseconds()).toISOString(); }
  lease(value) {
    const milliseconds = Number(value);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_LEASE_MS || milliseconds > MAX_LEASE_MS) throw new RoomError(`心跳租约必须为 ${MIN_LEASE_MS} 到 ${MAX_LEASE_MS} 毫秒。`);
    return milliseconds;
  }
  interval(input) { return input.ttl_ms === undefined ? this.leaseMs : this.lease(input.ttl_ms); }
  requireWritable() { if (this.readOnly) throw new RoomError('离线检查使用只读状态，不能写入心跳或适配器配置。', 403, 'read_only_state'); }
  configureWakeAdapter(adapter, enabled) {
    this.requireWritable();
    adapter = cleanText(adapter, 100, '适配器');
    if (typeof enabled !== 'boolean') throw new RoomError('唤醒能力必须为布尔值。');
    this.db.prepare('INSERT INTO runtime_adapter_capabilities VALUES(?,?,?) ON CONFLICT(adapter) DO UPDATE SET can_wake=excluded.can_wake,updated=excluded.updated').run(adapter, enabled ? 1 : 0, this.date());
    return { adapter, can_wake: enabled };
  }

  heartbeat(memberId, input = {}) {
    this.requireWritable();
    this.chat.member(memberId);
    const session = input.session_ref === undefined ? 'default' : cleanText(input.session_ref, 200, '会话标识');
    const milliseconds = this.milliseconds(), seen = new Date(milliseconds).toISOString(), expires = new Date(milliseconds + this.interval(input)).toISOString();
    this.db.prepare('INSERT INTO runtime_member_presence VALUES(?,?,?,?,NULL) ON CONFLICT(member_id,session_ref) DO UPDATE SET last_seen=excluded.last_seen,lease_expires=excluded.lease_expires,ended_at=NULL').run(memberId, session, seen, expires);
    return { ok: true, instance_id: this.instanceId, session_ref: session, ...this.memberState(memberId) };
  }
  releaseSession(memberId, sessionRef = 'default') {
    this.requireWritable();
    this.chat.member(memberId);
    sessionRef = cleanText(sessionRef, 200, '会话标识');
    const ended = this.date();
    this.db.prepare('UPDATE runtime_member_presence SET ended_at=?,lease_expires=? WHERE member_id=? AND session_ref=?').run(ended, ended, memberId, sessionRef);
    return this.memberState(memberId);
  }
  workerHeartbeat(workerRef, input = {}) {
    this.requireWritable();
    workerRef = cleanText(workerRef, 200, '后台进程标识');
    const role = input.role || 'agent';
    if (!['agent', 'service'].includes(role)) throw new RoomError('后台进程类型无效。');
    const member = input.member_id == null ? null : cleanText(input.member_id, 200, '成员标识');
    if (member) this.chat.member(member);
    if (role === 'agent' && !member) throw new RoomError('Agent 后台进程必须关联成员。');
    if (role === 'service' && member) throw new RoomError('本机服务不能冒充成员进程。');
    const pid = input.pid == null ? null : Number(input.pid);
    if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new RoomError('后台进程 PID 无效。');
    const previous = this.db.prepare('SELECT role,member_id FROM runtime_workers WHERE worker_ref=?').get(workerRef);
    if (previous && (previous.role !== role || previous.member_id !== member)) throw new RoomError('后台进程标识已经属于另一种进程或成员。', 409, 'worker_identity_conflict');
    const milliseconds = this.milliseconds(), seen = new Date(milliseconds).toISOString(), expires = new Date(milliseconds + this.interval(input)).toISOString();
    this.db.prepare('INSERT INTO runtime_workers VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(worker_ref) DO UPDATE SET pid=excluded.pid,last_seen=excluded.last_seen,lease_expires=excluded.lease_expires,ended_at=NULL').run(workerRef, role, member, pid, seen, expires);
    return this.workerState(workerRef);
  }
  serviceHeartbeat(serviceRef, input = {}) { return this.workerHeartbeat(serviceRef, { ...input, role: 'service', member_id: null }); }
  releaseWorker(workerRef) {
    this.requireWritable();
    workerRef = cleanText(workerRef, 200, '后台进程标识');
    const ended = this.date();
    this.db.prepare('UPDATE runtime_workers SET ended_at=?,lease_expires=? WHERE worker_ref=?').run(ended, ended, workerRef);
    return this.workerState(workerRef);
  }
  pidAlive(row) {
    if (row.pid == null) return null;
    try { return !!this.isPidAlive(row.pid); } catch { return false; }
  }
  live(row, milliseconds) { return !row.ended_at && Date.parse(row.lease_expires) > milliseconds && this.pidAlive(row) !== false; }
  workerView(row, milliseconds) {
    const pidAlive = this.pidAlive(row), online = !row.ended_at && Date.parse(row.lease_expires) > milliseconds && pidAlive !== false;
    return { ...row, pid_alive: pidAlive, online, state: online ? 'online' : row.ended_at || pidAlive === false ? 'stopped' : 'stale', evidence: row.pid == null ? 'heartbeat_lease' : 'heartbeat_lease+pid' };
  }
  workerState(workerRef) {
    const row = this.db.prepare('SELECT * FROM runtime_workers WHERE worker_ref=?').get(workerRef);
    if (!row) return { worker_ref: workerRef, state: 'unknown', online: false };
    return this.workerView(row, this.milliseconds());
  }
  memberState(memberId) {
    const member = this.chat.member(memberId), milliseconds = this.milliseconds();
    const sessions = this.db.prepare('SELECT * FROM runtime_member_presence WHERE member_id=? ORDER BY last_seen DESC,session_ref').all(memberId);
    const liveSessions = sessions.filter(row => this.live(row, milliseconds));
    const workers = this.db.prepare("SELECT * FROM runtime_workers WHERE member_id=? AND role='agent' ORDER BY last_seen DESC,worker_ref").all(memberId);
    const workerViews = workers.map(row => this.workerView(row, milliseconds));
    const liveWorkers = workerViews.filter(row => row.online);
    const capability = this.db.prepare('SELECT can_wake FROM runtime_adapter_capabilities WHERE adapter=?').get(member.adapter);
    const recent = sessions[0] || null;
    const online = liveSessions.length > 0;
    return {
      member_id: member.id, registration: member.verified_at ? 'verified' : 'unverified',
      verified_at: member.verified_at, presence: online ? 'online' : recent ? (sessions.every(row => !!row.ended_at) ? 'offline' : 'stale') : 'unknown',
      online, last_seen: recent?.last_seen || null,
      presence_evidence: 'recent_contact_lease',
      lease_expires: liveSessions.length ? liveSessions.map(row => row.lease_expires).sort().at(-1) : recent?.lease_expires || null,
      active_sessions: liveSessions.length, worker_online: liveWorkers.length > 0,
      worker_state: liveWorkers.length ? 'online' : workerViews.length ? (workerViews.every(row => row.state === 'stopped') ? 'stopped' : 'stale') : 'unknown',
      worker_last_seen: workers[0]?.last_seen || null,
      worker_evidence: workers.some(row => row.pid != null) ? 'heartbeat_lease+pid' : 'heartbeat_lease',
      can_wake: !!capability?.can_wake,
      wake_reason: capability?.can_wake ? 'configured_local_adapter' : 'no_local_wake_adapter'
    };
  }

  counts(roomId) {
    const result = Object.fromEntries(MESSAGE_STATES.map(state => [state, 0]));
    for (const row of this.db.prepare('SELECT status,count(*) AS count FROM chat_messages WHERE room_id=? GROUP BY status').all(roomId)) result[row.status] = Number(row.count);
    return result;
  }
  roomState(roomId) {
    const room = this.chat.room(roomId), messages = this.counts(roomId);
    return { ...room, state: messages.uncertain || messages.waiting_input ? 'needs_review' : messages.processing ? 'processing' : messages.queued || messages.delivered ? 'waiting' : 'idle', messages, dispatchable: messages.queued, requires_review: messages.uncertain + messages.waiting_input };
  }
  offlineSnapshot(roomId, callerMemberId) {
    if (callerMemberId != null) this.chat.member(callerMemberId);
    if (roomId != null && callerMemberId != null) this.chat.requireParticipant(roomId, callerMemberId);
    const rooms = roomId == null ? this.chat.rooms().filter(room => callerMemberId == null || this.chat.joined(room.id, callerMemberId)) : [this.chat.room(roomId)];
    const members = roomId != null ? this.chat.participants(roomId) : callerMemberId == null ? this.chat.members() : [...new Map(rooms.flatMap(room => this.chat.participants(room.id)).map(member => [member.id, member])).values()];
    const workerRows = this.db.prepare("SELECT * FROM runtime_workers WHERE role='service' ORDER BY last_seen DESC,worker_ref").all();
    const milliseconds = this.milliseconds(), services = workerRows.map(row => this.workerView(row, milliseconds));
    const online = services.some(row => row.online);
    return {
      instance_id: this.instanceId, observed_at: new Date(milliseconds).toISOString(), durable: true,
      service: { online, state: online ? 'online' : services.length ? (services.every(row => row.state === 'stopped') ? 'stopped' : 'stale') : 'unknown', evidence: services.some(row => row.pid != null) ? 'heartbeat_lease+pid' : 'heartbeat_lease', last_seen: services[0]?.last_seen || null },
      rooms: rooms.map(room => this.roomState(room.id)),
      members: members.map(member => ({ id: member.id, name: member.name, adapter: member.adapter, registered_status: member.status, ...this.memberState(member.id) })),
      caller_member_id: callerMemberId || null,
      note: '成员在线表示有效期内的近期通信证据，不证明外部窗口持续运行；本机进程有 PID 时会同时检查进程存活。聊天室和消息独立持久保存；已处理中断且结果待核对的消息不会自动重跑。'
    };
  }
}
module.exports = { RuntimeState, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS };
