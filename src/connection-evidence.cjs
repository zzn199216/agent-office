'use strict';
const { RoomError, cleanText, livePid } = require('./util.cjs');

const EVENTS = new Set(['protocol_verified', 'model_reply', 'dialogue_verified', 'runner_started', 'runner_stopped', 'failed']);
const EXECUTORS = new Set(['managed_cli', 'desktop', 'mailbox', 'bridge']);
const STAGES = new Set(['protocol', 'auth', 'model', 'runner', 'dialogue', 'identity']);
const FIELDS = new Set(['event', 'session_ref', 'executor_kind', 'provider', 'owner_id', 'native_session_id', 'message_id', 'turn_id', 'source', 'pid', 'ttl_ms', 'error_stage', 'error_code']);
const token = (value, label) => {
  const result = cleanText(value, 100, label);
  if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(result)) throw new RoomError(`${label}无效。`, 400, 'connection_evidence_invalid');
  return result;
};

// Controller-recorded observations are independent of adapter capabilities and
// registration. A reply is evidence only after its addressed message and real
// response are durable. No constructor or read starts an agent or calls a model.
class ConnectionEvidence {
  constructor(chat, options = {}) {
    this.chat = chat; this.db = chat.db; this.readOnly = !!options.readOnly;
    this.clock = options.clock || (() => Date.now()); this.isPidAlive = options.isPidAlive || livePid;
    this.ownerId = options.ownerId || `process:${process.pid}`; this.leaseMs = options.ttlMs || 60000;
    if (!this.readOnly) this.db.exec(`CREATE TABLE IF NOT EXISTS connection_session_evidence (
      member_id TEXT NOT NULL REFERENCES chat_members(id), session_ref TEXT NOT NULL,
      executor_kind TEXT NOT NULL, provider TEXT NOT NULL, owner_id TEXT,
      native_session_id TEXT, protocol_verified_at TEXT, protocol_source TEXT,
      model_reply_verified_at TEXT, model_message_id TEXT, model_turn_id TEXT, model_source TEXT,
      dialogue_verified_at TEXT, dialogue_source TEXT,
      runner_seen_at TEXT, runner_lease_expires TEXT, runner_stopped_at TEXT, runner_pid INTEGER,
      error_stage TEXT, error_code TEXT, error_at TEXT, stage_failures TEXT, updated TEXT NOT NULL,
      PRIMARY KEY(member_id,session_ref)
    ); CREATE INDEX IF NOT EXISTS connection_evidence_member ON connection_session_evidence(member_id,updated);`);
    this.hasTable = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='connection_session_evidence'").get();
    if (!this.readOnly) this.chat.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(connection_session_evidence)').all().some(column => column.name === 'stage_failures')) this.db.exec('ALTER TABLE connection_session_evidence ADD COLUMN stage_failures TEXT');
    });
  }
  failures(row) {
    if (row.stage_failures != null) {
      try {
        const values = JSON.parse(row.stage_failures);
        if (values && typeof values === 'object' && !Array.isArray(values) && Object.entries(values).every(([stage, value]) => STAGES.has(stage) && value && typeof value === 'object' && typeof value.code === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,99}$/i.test(value.code) && typeof value.observed_at === 'string' && Number.isFinite(Date.parse(value.observed_at)))) return values;
      } catch {}
    }
    // Legacy databases retain their known single failure until a writable
    // observation migrates it. Read-only inspection never adds a column.
    return STAGES.has(row.error_stage) && row.error_at ? { [row.error_stage]: { code: row.error_code, observed_at: row.error_at } } : {};
  }
  latestFailure(failures, preferredStage) {
    const entries = Object.entries(failures);
    if (!entries.length) return null;
    const latest = entries.reduce((best, entry) => Date.parse(entry[1].observed_at) > Date.parse(best[1].observed_at) || entry[1].observed_at === best[1].observed_at && entry[0] === preferredStage ? entry : best);
    return { stage: latest[0], ...latest[1] };
  }
  milliseconds() {
    const value = this.clock(), result = value instanceof Date ? value.valueOf() : Number(value);
    if (!Number.isFinite(result)) throw new RoomError('连接证据时钟无效。');
    return result;
  }
  pidAlive(row) {
    if (row.runner_pid == null) return null;
    try { return !!this.isPidAlive(row.runner_pid); } catch { return false; }
  }
  runnerOnline(row, milliseconds) {
    return !!row.runner_seen_at && !row.runner_stopped_at && Date.parse(row.runner_lease_expires) > milliseconds && this.pidAlive(row) !== false;
  }
  record(memberId, input = {}) {
    if (this.readOnly) throw new RoomError('离线检查不能写入连接证据。', 403, 'read_only_state');
    // Keep the lease check and update in one SQLite snapshot. A competing
    // controller must fail or observe the live owner rather than overwrite it.
    return this.chat.transaction(() => this.recordObservation(memberId, input));
  }
  recordObservation(memberId, input) {
    if (this.readOnly) throw new RoomError('离线检查不能写入连接证据。', 403, 'read_only_state');
    const member = this.chat.member(memberId);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.has(key)) || !EVENTS.has(input.event)) throw new RoomError('连接证据事件无效。', 400, 'connection_evidence_invalid');
    const sessionRef = cleanText(input.session_ref, 200, '会话标识');
    const previous = this.db.prepare('SELECT * FROM connection_session_evidence WHERE member_id=? AND session_ref=?').get(memberId, sessionRef);
    const kind = input.executor_kind || previous?.executor_kind;
    if (!EXECUTORS.has(kind)) throw new RoomError('连接执行器类型无效。', 400, 'connection_evidence_invalid');
    const provider = input.provider === undefined ? previous?.provider || member.config?.launch_provider || member.adapter : token(input.provider, '产品标识');
    if (previous && (previous.executor_kind !== kind || previous.provider !== provider)) throw new RoomError('会话标识已经属于另一执行器。', 409, 'connection_identity_conflict');
    const ownerId = input.owner_id === undefined ? this.ownerId : cleanText(input.owner_id, 200, '执行器所有者');
    const milliseconds = this.milliseconds(), stamp = new Date(milliseconds).toISOString();
    if (previous?.owner_id && previous.owner_id !== ownerId && this.runnerOnline(previous, milliseconds)) throw new RoomError('这个会话仍由另一在线执行器负责。', 409, 'connection_owner_conflict');
    const nativeId = input.native_session_id === undefined ? previous?.native_session_id || null : cleanText(input.native_session_id, 200, '原生会话标识');
    const changedSession = previous?.native_session_id && nativeId !== previous.native_session_id;
    const row = previous && !changedSession ? { ...previous } : {
      member_id: memberId, session_ref: sessionRef, executor_kind: kind, provider,
      native_session_id: null, protocol_verified_at: null, protocol_source: null,
      model_reply_verified_at: null, model_message_id: null, model_turn_id: null, model_source: null,
      dialogue_verified_at: null, dialogue_source: null, runner_seen_at: null,
      runner_lease_expires: null, runner_stopped_at: null, runner_pid: null,
      error_stage: null, error_code: null, error_at: null, stage_failures: null
    };
    Object.assign(row, { owner_id: ownerId, native_session_id: nativeId, updated: stamp });
    const failures = this.failures(row), clearError = stages => { for (const stage of stages) delete failures[stage]; };
    if (input.event === 'failed') {
      if (!STAGES.has(input.error_stage)) throw new RoomError('连接错误阶段无效。', 400, 'connection_evidence_invalid');
      Object.assign(row, { error_stage: input.error_stage, error_code: token(input.error_code || 'unknown', '错误标识'), error_at: stamp });
      failures[input.error_stage] = { code: row.error_code, observed_at: stamp };
    } else if (input.event === 'runner_started') {
      const ttl = input.ttl_ms === undefined ? this.leaseMs : Number(input.ttl_ms);
      if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300000) throw new RoomError('执行器租约无效。', 400, 'connection_evidence_invalid');
      const pid = input.pid === undefined ? row.runner_pid : input.pid === null ? null : Number(input.pid);
      if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) throw new RoomError('执行器 PID 无效。', 400, 'connection_evidence_invalid');
      Object.assign(row, { runner_seen_at: stamp, runner_lease_expires: new Date(milliseconds + ttl).toISOString(), runner_stopped_at: null, runner_pid: pid });
      clearError(['runner']);
    } else if (input.event === 'runner_stopped') {
      Object.assign(row, { runner_stopped_at: stamp, runner_lease_expires: stamp });
    } else {
      const source = token(input.source, '证据来源');
      if (input.event === 'protocol_verified') {
        Object.assign(row, { protocol_verified_at: stamp, protocol_source: source }); clearError(['protocol', 'auth', 'identity']);
      } else if (input.event === 'dialogue_verified') {
        if (kind !== 'desktop' || !nativeId) throw new RoomError('本人桌面对话证据必须关联实际桌面会话。', 400, 'connection_evidence_invalid');
        Object.assign(row, { dialogue_verified_at: stamp, dialogue_source: source }); clearError(['dialogue', 'identity']);
      } else {
        if (!nativeId) throw new RoomError('模型回答证据必须关联实际原生会话。', 400, 'connection_evidence_invalid');
        const messageId = cleanText(input.message_id, 200, '问题消息标识'), message = this.chat.message(messageId);
        const reply = this.db.prepare("SELECT id FROM chat_messages WHERE reply_to=? AND sender_id=? AND kind='reply' AND length(trim(text))>0 LIMIT 1").get(messageId, memberId);
        if (message.to_member_id !== memberId || message.status !== 'answered' || !reply) throw new RoomError('没有这个成员对原问题的实际持久回复。', 409, 'connection_reply_missing');
        const sameReply = row.model_message_id === messageId && row.model_reply_verified_at;
        Object.assign(row, { model_reply_verified_at: sameReply || stamp, model_message_id: messageId, model_turn_id: input.turn_id === undefined || input.turn_id === null ? null : cleanText(input.turn_id, 200, '模型轮次标识'), model_source: source });
        if (!sameReply) clearError(['model', 'auth']);
      }
    }
    const lastError = this.latestFailure(failures, row.error_stage);
    Object.assign(row, { stage_failures: JSON.stringify(failures), error_stage: lastError?.stage || null, error_code: lastError?.code || null, error_at: lastError?.observed_at || null });
    const columns = Object.keys(row);
    this.db.prepare(`INSERT INTO connection_session_evidence(${columns.join(',')}) VALUES(${columns.map(key => ':' + key).join(',')}) ON CONFLICT(member_id,session_ref) DO UPDATE SET ${columns.filter(key => !['member_id', 'session_ref'].includes(key)).map(key => `${key}=excluded.${key}`).join(',')}`).run(row);
    return this.sessionView(row, milliseconds);
  }
  sessionView(row, milliseconds) {
    const runnerOnline = this.runnerOnline(row, milliseconds), pidAlive = this.pidAlive(row);
    const runnerState = runnerOnline ? 'online' : row.runner_stopped_at || pidAlive === false ? 'stopped' : row.runner_seen_at ? 'stale' : 'unknown';
    const failures = this.failures(row), blocked = stage => !!(failures[stage] || failures.auth || failures.identity);
    const protocol = { state: blocked('protocol') ? 'failed' : row.protocol_verified_at ? 'verified' : 'unverified', last_success_at: row.protocol_verified_at, source: row.protocol_source };
    const model = { state: blocked('model') ? 'failed' : row.model_reply_verified_at ? 'verified' : 'unverified', last_success_at: row.model_reply_verified_at, message_id: row.model_message_id, turn_id: row.model_turn_id, source: row.model_source };
    const dialogue = { state: blocked('dialogue') ? 'failed' : row.dialogue_verified_at ? 'verified' : 'unverified', last_success_at: row.dialogue_verified_at, source: row.dialogue_source, loaded: row.executor_kind === 'desktop' && !!row.dialogue_verified_at && !blocked('dialogue') && runnerOnline };
    return {
      session_ref: row.session_ref, executor_kind: row.executor_kind, provider: row.provider,
      owner_id: row.owner_id, native_session_id: row.native_session_id, updated: row.updated,
      protocol, model, dialogue,
      runner: { state: runnerState, online: runnerOnline, last_seen: row.runner_seen_at, lease_expires: row.runner_lease_expires, pid: row.runner_pid, pid_alive: pidAlive, ownership: runnerOnline ? 'leased' : row.owner_id ? 'inactive' : 'unknown' },
      last_error: this.latestFailure(failures, row.error_stage),
      automatic_reply_verified: protocol.state === 'verified' && model.state === 'verified' && (row.executor_kind === 'managed_cli' || row.executor_kind === 'desktop' && dialogue.loaded)
    };
  }
  state(memberId) {
    this.chat.member(memberId);
    const milliseconds = this.milliseconds(), rows = this.hasTable ? this.db.prepare('SELECT * FROM connection_session_evidence WHERE member_id=? ORDER BY updated DESC,session_ref').all(memberId) : [];
    const sessions = rows.map(row => this.sessionView(row, milliseconds));
    return {
      observed_at: new Date(milliseconds).toISOString(), sessions,
      protocol_verified: sessions.some(session => session.protocol.state === 'verified'),
      model_reply_verified: sessions.some(session => session.model.state === 'verified'),
      runner_online: sessions.some(session => session.runner.online),
      native_conversation_loaded: sessions.some(session => session.dialogue.loaded),
      automatic_reply_verified: sessions.some(session => session.automatic_reply_verified),
      verification_level: !sessions.length ? 'registered_only' : sessions.some(session => session.automatic_reply_verified) ? 'reply_verified' : sessions.some(session => session.protocol.state === 'verified') ? 'protocol_verified' : 'observed',
      last_error: sessions.find(session => session.last_error)?.last_error || null
    };
  }
}
module.exports = { ConnectionEvidence };
