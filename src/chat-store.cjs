'use strict';
const crypto = require('node:crypto');
const { RoomError, id, now, cleanText, redact } = require('./util.cjs');

// These tables deliberately share only the existing project identity. Adapters,
// recipients and native session identifiers are opaque values to the room store.
class ChatStore {
  constructor(store, options = {}) {
    this.store = store;
    this.db = store.db;
    this.savepoint = 0;
    this.readOnly = options.readOnly === true;
    if(options.readOnly){this.hasRoomTombstones=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_room_tombstones'").get();return;}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
        error TEXT, verified_at TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id), created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_room_tombstones (
        room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id), deleted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_participants (
        room_id TEXT NOT NULL REFERENCES chat_rooms(id), member_id TEXT NOT NULL REFERENCES chat_members(id),
        joined INTEGER NOT NULL DEFAULT 1, joined_at TEXT NOT NULL, left_at TEXT,
        PRIMARY KEY(room_id,member_id)
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id), sender_id TEXT NOT NULL,
        to_member_id TEXT REFERENCES chat_members(id), text TEXT NOT NULL,
        reply_to TEXT REFERENCES chat_messages(id), kind TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, request_id TEXT,
        idempotency_key TEXT NOT NULL, body_hash TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
        UNIQUE(room_id,sender_id,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS chat_bindings (
        room_id TEXT NOT NULL REFERENCES chat_rooms(id), member_id TEXT NOT NULL REFERENCES chat_members(id),
        thread_id TEXT, binding_state TEXT NOT NULL DEFAULT 'new', updated TEXT NOT NULL,
        PRIMARY KEY(room_id,member_id)
      );
      CREATE TABLE IF NOT EXISTS chat_invitations (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES chat_members(id),
        room_id TEXT NOT NULL REFERENCES chat_rooms(id), nonce_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', expires TEXT NOT NULL, created TEXT NOT NULL,
        completed TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(room_id,seq);
      CREATE INDEX IF NOT EXISTS chat_messages_inbox ON chat_messages(to_member_id,status,seq);
    `);
    this.hasRoomTombstones = true;
  }
  transaction(fn) {
    // SAVEPOINT also works when a caller already entered Store.transaction().
    const name = `chat_write_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); this.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  decodeMember(row) { return row ? { ...row, config: JSON.parse(row.config) } : null; }
  encodeConfig(config) {
    if (config == null) config = {};
    if (typeof config !== 'object' || Array.isArray(config)) throw new RoomError('成员配置必须为对象。');
    let value;
    try { value = JSON.stringify(config); } catch { throw new RoomError('成员配置无法保存。'); }
    if (value.length > 64000) throw new RoomError('成员配置过大。');
    return value;
  }
  members() { return this.db.prepare('SELECT * FROM chat_members ORDER BY created,id').all().map(row => this.decodeMember(row)); }
  member(memberId) {
    const row = this.db.prepare('SELECT * FROM chat_members WHERE id=?').get(memberId);
    if (!row) throw new RoomError('成员不存在。', 404);
    return this.decodeMember(row);
  }
  addMember(input) {
    const memberId = input.id === undefined ? id() : cleanText(input.id, 200, '成员标识');
    if (memberId === 'user') throw new RoomError('user 是保留身份，请使用其他成员标识。');
    if (this.db.prepare('SELECT id FROM chat_members WHERE id=?').get(memberId)) throw new RoomError('成员标识已经存在。', 409, 'member_conflict');
    const row = { id: memberId, name: cleanText(input.name, 100, '成员名称'), adapter: cleanText(input.adapter, 100, '适配器'), config: this.encodeConfig(input.config), status: 'awaiting_handshake', error: null, verified_at: null, created: now(), updated: now() };
    this.db.prepare('INSERT INTO chat_members VALUES(:id,:name,:adapter,:config,:status,:error,:verified_at,:created,:updated)').run(row);
    return this.decodeMember(row);
  }
  updateMember(memberId, fields) {
    this.member(memberId);
    const entries = Object.entries(fields).filter(([key]) => ['status', 'config', 'error', 'verified_at', 'name'].includes(key)).map(([key, value]) => {
      if (key === 'config') value = this.encodeConfig(value);
      if (['status', 'name'].includes(key)) value = cleanText(value, key === 'name' ? 100 : 60, key);
      if (key === 'error') value = value == null ? null : redact(value).slice(0, 2000);
      if (key === 'verified_at' && value != null) value = this.date(value, '验证时间');
      return [key, value];
    });
    if (entries.length) this.db.prepare(`UPDATE chat_members SET ${entries.map(([key]) => `${key}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([, value]) => value), now(), memberId);
    return this.member(memberId);
  }
  rooms() { return this.db.prepare(`SELECT r.*,p.name AS project_name,p.path AS project_path FROM chat_rooms r JOIN projects p ON p.id=r.project_id ${this.hasRoomTombstones?'WHERE NOT EXISTS(SELECT 1 FROM chat_room_tombstones d WHERE d.room_id=r.id)':''} ORDER BY r.updated DESC,r.id`).all(); }
  room(roomId) {
    const row = this.db.prepare('SELECT r.*,p.name AS project_name,p.path AS project_path FROM chat_rooms r JOIN projects p ON p.id=r.project_id WHERE r.id=?').get(roomId);
    if (!row) throw new RoomError('聊天室不存在。', 404);
    if(this.hasRoomTombstones&&this.db.prepare('SELECT 1 FROM chat_room_tombstones WHERE room_id=?').get(roomId))throw new RoomError('这个聊天室已删除，旧接入入口不能恢复或创建替代聊天室。',410,'room_deleted');
    return row;
  }
  deleteRoom(roomId, checkBusy = () => {}) {
    if(this.readOnly)throw new RoomError('只读检查不能删除聊天室。',403,'read_only_state');
    if(typeof roomId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(roomId))throw new RoomError('聊天室标识无效。',400,'room_delete_input_invalid');
    // An immediate write lock makes checking work and recording the tombstone
    // atomic even when another local entrypoint has opened the same database.
    return this.store.transaction(() => {
      const room=this.db.prepare('SELECT id FROM chat_rooms WHERE id=?').get(roomId);
      if(!room)throw new RoomError('聊天室不存在。',404);
      const previous=this.db.prepare('SELECT deleted_at FROM chat_room_tombstones WHERE room_id=?').get(roomId);
      if(previous)return {ok:true,room_id:roomId,status:'deleted',deleted_at:previous.deleted_at,already_deleted:true};
      const hasTable=name=>!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const busy=()=>{throw new RoomError('聊天室仍有待办、正在处理或结果待核对的任务。请先处理或停止待办任务，并核对不确定的结果，再删除聊天室。',409,'room_busy');};
      if(this.db.prepare("SELECT 1 FROM chat_messages WHERE room_id=? AND (status NOT IN ('posted','answered','completed','failed','cancelled','consumed') OR status='consumed' AND kind NOT IN ('reply','acknowledgment')) LIMIT 1").get(roomId))busy();
      if(this.db.prepare("SELECT 1 FROM chat_bindings WHERE room_id=? AND binding_state IN ('creating','creation_uncertain','outcome_uncertain','resume_uncertain') LIMIT 1").get(roomId))busy();
      if(hasTable('launch_sessions')&&this.db.prepare("SELECT 1 FROM launch_sessions WHERE room_id=? AND status='preparing' LIMIT 1").get(roomId))busy();
      if(hasTable('onboarding_runs')&&this.db.prepare("SELECT 1 FROM onboarding_runs WHERE room_id=? AND status='running' LIMIT 1").get(roomId))busy();
      if(hasTable('bridge_entries')&&this.db.prepare("SELECT 1 FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id WHERE b.room_id=? AND e.status NOT IN ('answered','delivered','failed','cancelled') LIMIT 1").get(roomId))busy();
      if(hasTable('bridge_setup_tests')&&this.db.prepare("SELECT 1 FROM bridge_setup_tests WHERE room_id=? AND status IN ('running','waiting','uncertain') LIMIT 1").get(roomId))busy();
      checkBusy(roomId,busy);
      const stamp=now();
      this.db.prepare('INSERT INTO chat_room_tombstones(room_id,deleted_at) VALUES(?,?)').run(roomId,stamp);
      this.db.prepare('UPDATE chat_participants SET joined=0,left_at=? WHERE room_id=? AND joined=1').run(stamp,roomId);
      this.db.prepare("UPDATE chat_invitations SET status='revoked' WHERE room_id=? AND status IN ('pending','verified')").run(roomId);
      if(hasTable('chat_resume_credentials'))this.db.prepare("UPDATE chat_resume_credentials SET status='revoked',revoked_at=? WHERE room_id=? AND status!='revoked'").run(stamp,roomId);
      if(hasTable('launch_sync_routes'))this.db.prepare("UPDATE launch_sync_routes SET status='pause_requested',updated=? WHERE room_id=?").run(stamp,roomId);
      if(hasTable('launch_watches'))this.db.prepare('UPDATE launch_watches SET enabled=0 WHERE room_id=?').run(roomId);
      return {ok:true,room_id:roomId,status:'deleted',deleted_at:stamp,already_deleted:false};
    });
  }
  addRoom(input) {
    this.store.project(input.project_id);
    const row = { id: id(), title: cleanText(input.title || '聊天室', 100, '聊天室名称'), project_id: input.project_id, created: now(), updated: now() };
    this.db.prepare('INSERT INTO chat_rooms VALUES(:id,:title,:project_id,:created,:updated)').run(row);
    return this.room(row.id);
  }
  participants(roomId) {
    this.room(roomId);
    return this.db.prepare('SELECT m.*,p.joined,p.joined_at,p.left_at FROM chat_participants p JOIN chat_members m ON m.id=p.member_id WHERE p.room_id=? AND p.joined=1 ORDER BY p.joined_at,m.id').all(roomId).map(row => ({ ...this.decodeMember(row), joined: !!row.joined }));
  }
  joined(roomId, memberId) { return !!this.db.prepare('SELECT 1 FROM chat_participants WHERE room_id=? AND member_id=? AND joined=1').get(roomId, memberId); }
  requireParticipant(roomId, memberId) {
    this.room(roomId); this.member(memberId);
    if (!this.joined(roomId, memberId)) throw new RoomError('该成员尚未加入聊天室。', 403, 'not_in_room');
  }
  join(roomId, memberId) {
    this.room(roomId); this.member(memberId);
    this.db.prepare('INSERT INTO chat_participants(room_id,member_id,joined,joined_at,left_at) VALUES(?,?,1,?,NULL) ON CONFLICT(room_id,member_id) DO UPDATE SET joined=1,joined_at=CASE WHEN chat_participants.joined=1 THEN chat_participants.joined_at ELSE excluded.joined_at END,left_at=NULL').run(roomId, memberId, now());
    return this.participants(roomId).find(member => member.id === memberId);
  }
  leave(roomId, memberId) {
    this.room(roomId); this.member(memberId);
    this.db.prepare('UPDATE chat_participants SET joined=0,left_at=? WHERE room_id=? AND member_id=? AND joined=1').run(now(), roomId, memberId);
    return { room_id: roomId, member_id: memberId, joined: false };
  }
  messages(roomId, options = {}) {
    this.room(roomId);
    const after = options.after_seq === undefined ? 0 : Number(options.after_seq);
    const limit = options.limit === undefined ? 200 : Number(options.limit);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RoomError('消息分页参数无效。');
    return this.db.prepare('SELECT * FROM chat_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?').all(roomId, after, limit).map(row => this.publicMessage(row));
  }
  publicMessage(row) { const { idempotency_key, body_hash, ...visible } = row; return visible; }
  message(messageId) {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId);
    if (!row) throw new RoomError('消息不存在。', 404);
    this.room(row.room_id);
    return this.publicMessage(row);
  }
  post(input) {
    const room = this.room(input.room_id);
    const sender = cleanText(input.sender_id || 'user', 200, '发送成员');
    const target = input.to_member_id == null ? null : cleanText(input.to_member_id, 200, '接收成员');
    const text = redact(cleanText(input.text, 20000, '消息')).slice(0, 20000);
    const key = cleanText(input.idempotency_key, 200, '消息标识');
    const kind = cleanText(input.kind || 'message', 60, '消息类型');
    const reply = input.reply_to == null ? null : cleanText(input.reply_to, 200, '回复标识');
    const hash = crypto.createHash('sha256').update(JSON.stringify([target, text, reply, kind])).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM chat_messages WHERE room_id=? AND sender_id=? AND idempotency_key=?').get(room.id, sender, key);
      if (previous) {
        if (previous.body_hash !== hash) throw new RoomError('同一消息标识对应了不同内容。', 409, 'idempotency_conflict');
        return this.publicMessage(previous);
      }
      if (sender !== 'user') this.requireParticipant(room.id, sender);
      if (target !== null) this.requireParticipant(room.id, target);
      if (reply !== null && this.message(reply).room_id !== room.id) throw new RoomError('回复只能引用同一聊天室的消息。', 403, 'cross_room_reply');
      const row = { id: id(), room_id: room.id, sender_id: sender, to_member_id: target, text, reply_to: reply, kind, status: target === null ? 'posted' : 'queued', error: null, request_id: null, idempotency_key: key, body_hash: hash, created: now(), updated: now() };
      this.db.prepare('INSERT INTO chat_messages(id,room_id,sender_id,to_member_id,text,reply_to,kind,status,error,request_id,idempotency_key,body_hash,created,updated) VALUES(:id,:room_id,:sender_id,:to_member_id,:text,:reply_to,:kind,:status,:error,:request_id,:idempotency_key,:body_hash,:created,:updated)').run(row);
      this.db.prepare('UPDATE chat_rooms SET updated=? WHERE id=?').run(row.updated, room.id);
      return this.message(row.id);
    });
  }
  updateMessage(messageId, fields) {
    this.message(messageId);
    const states = ['posted', 'queued', 'processing', 'delivered', 'consumed', 'completed', 'answered', 'waiting_input', 'uncertain', 'failed', 'cancelled'];
    const entries = Object.entries(fields).filter(([key]) => ['status', 'error', 'request_id'].includes(key)).map(([key, value]) => {
      if (key === 'status' && !states.includes(value)) throw new RoomError('消息状态无效。');
      if (key === 'error') value = value == null ? null : redact(value).slice(0, 2000);
      if (key === 'request_id' && value != null) value = cleanText(value, 200, '请求标识');
      return [key, value];
    });
    if (entries.length) this.db.prepare(`UPDATE chat_messages SET ${entries.map(([key]) => `${key}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([, value]) => value), now(), messageId);
    return this.message(messageId);
  }
  inbox(memberId, roomId = undefined) {
    this.member(memberId);
    if (roomId !== undefined && roomId !== null) this.requireParticipant(roomId, memberId);
    return this.db.prepare(`SELECT m.* FROM chat_messages m JOIN chat_participants p ON p.room_id=m.room_id AND p.member_id=m.to_member_id AND p.joined=1 WHERE m.to_member_id=? AND m.status IN ('queued','delivered') ${roomId == null ? '' : 'AND m.room_id=?'} ORDER BY m.seq`).all(...(roomId == null ? [memberId] : [memberId, roomId])).map(row => this.publicMessage(row));
  }
  ack(messageId, memberId) {
    return this.transaction(() => {
      const message = this.message(messageId);
      if (message.to_member_id !== memberId) throw new RoomError('只有接收成员可以确认这条消息。', 403, 'wrong_recipient');
      this.requireParticipant(message.room_id, memberId);
      if (message.status === 'consumed') return message;
      if (!['queued', 'delivered'].includes(message.status)) throw new RoomError('该消息当前不能确认。', 409, 'invalid_message_state');
      return this.updateMessage(messageId, { status: 'consumed' });
    });
  }
  binding(roomId, memberId) {
    this.requireParticipant(roomId, memberId);
    return this.db.prepare('SELECT thread_id,binding_state FROM chat_bindings WHERE room_id=? AND member_id=?').get(roomId, memberId) || { thread_id: null, binding_state: 'new' };
  }
  bind(roomId, memberId, state, threadId = undefined) {
    this.requireParticipant(roomId, memberId);
    const previous = this.binding(roomId, memberId);
    const value = threadId === undefined ? previous.thread_id : threadId === null ? null : cleanText(threadId, 1000, '原生会话标识');
    this.db.prepare('INSERT INTO chat_bindings(room_id,member_id,thread_id,binding_state,updated) VALUES(?,?,?,?,?) ON CONFLICT(room_id,member_id) DO UPDATE SET thread_id=excluded.thread_id,binding_state=excluded.binding_state,updated=excluded.updated').run(roomId, memberId, value, cleanText(state, 60, '会话状态'), now());
    return this.binding(roomId, memberId);
  }
  recovery() {
    return this.transaction(() => {
      const active = this.db.prepare("UPDATE chat_messages SET status='uncertain',error='处理期间程序结束，请先核对原生会话，避免重复执行。',updated=? WHERE status='processing'").run(now());
      this.db.prepare("UPDATE chat_bindings SET binding_state='creation_uncertain',updated=? WHERE binding_state='creating'").run(now());
      return Number(active.changes);
    });
  }
  date(value, label) {
    const date = typeof value === 'number' ? new Date(value) : new Date(cleanText(value, 100, label));
    if (Number.isNaN(date.valueOf())) throw new RoomError(`${label}无效。`);
    return date.toISOString();
  }
  createInvite(input) {
    this.member(input.member_id); this.room(input.room_id);
    const nonce = input.nonce === undefined ? crypto.randomBytes(32).toString('base64url') : cleanText(input.nonce, 256, '握手凭据');
    const row = { id: id(), member_id: input.member_id, room_id: input.room_id, nonce_hash: crypto.createHash('sha256').update(nonce).digest('hex'), status: 'pending', expires: input.expires === undefined ? new Date(Date.now() + 15 * 60000).toISOString() : this.date(input.expires, '邀请有效期'), created: now(), completed: null };
    this.db.prepare('INSERT INTO chat_invitations VALUES(:id,:member_id,:room_id,:nonce_hash,:status,:expires,:created,:completed)').run(row);
    const { nonce_hash, ...visible } = row;
    return { ...visible, nonce };
  }
  invite(inviteId) {
    const row = this.db.prepare('SELECT id,member_id,room_id,status,expires,created,completed FROM chat_invitations WHERE id=?').get(inviteId);
    if (!row) throw new RoomError('邀请不存在。', 404);
    this.room(row.room_id);
    if (row.status === 'pending' && Date.parse(row.expires) <= Date.now()) row.status = 'expired';
    return row;
  }
  completeInvite(inviteId, nonce) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM chat_invitations WHERE id=?').get(inviteId);
      if (!row) throw new RoomError('邀请不存在。', 404);
      this.room(row.room_id);
      const supplied = crypto.createHash('sha256').update(typeof nonce === 'string' ? nonce : '').digest();
      if (!crypto.timingSafeEqual(supplied, Buffer.from(row.nonce_hash, 'hex'))) throw new RoomError('握手凭据无效。', 403, 'invalid_invite_nonce');
      if (row.status === 'verified') return this.invite(inviteId);
      if (row.status !== 'pending' || Date.parse(row.expires) <= Date.now()) throw new RoomError('邀请已过期，请重新添加成员。', 410, 'invite_expired');
      const stamp = now();
      this.join(row.room_id, row.member_id);
      this.updateMember(row.member_id, { status: 'ready', verified_at: stamp, error: null });
      this.db.prepare("UPDATE chat_invitations SET status='verified',completed=? WHERE id=?").run(stamp, inviteId);
      return this.invite(inviteId);
    });
  }
}
module.exports = { ChatStore };
