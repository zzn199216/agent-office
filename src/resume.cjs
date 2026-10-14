'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RoomError, id, now, cleanText, atomicWrite, ownCommand } = require('./util.cjs');

const CARD_SCHEMA = 'agentroom.resume';
const CARD_VERSION = 1;

// A resume card is a local, member-scoped credential. It can outlive a process
// and a one-use invitation, but never grants authority over another instance.
// The paths in a presented card are hints only: no path or command from it is
// opened or executed while inspecting or accepting the credential.
class ResumeAccess {
  constructor(chatStore, options = {}) {
    this.chat = chatStore;
    this.db = chatStore.db;
    this.instanceId = cleanText(options.instanceId, 200, '聊天室实例');
    this.dataDirectory = fs.realpathSync.native(path.resolve(options.dataDirectory || chatStore.store.dir));
    const launch = ownCommand();
    this.command = cleanText(options.command || launch.command, 4096, '本机入口');
    this.args = this.argumentList(options.args === undefined ? launch.args : options.args);
    this.readOnly = options.readOnly === true;
    if (this.readOnly) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_resume_credentials (
        id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES chat_rooms(id),
        member_id TEXT NOT NULL REFERENCES chat_members(id),
        secret_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created TEXT NOT NULL, accepted_at TEXT, last_seen TEXT, revoked_at TEXT, revocation_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_resume_credentials_member
        ON chat_resume_credentials(member_id,room_id,status);
    `);
    if (!this.db.prepare('PRAGMA table_info(chat_resume_credentials)').all().some(column => column.name === 'revocation_reason')) this.db.exec('ALTER TABLE chat_resume_credentials ADD COLUMN revocation_reason TEXT');
  }
  argumentList(value) {
    if (!Array.isArray(value) || value.length > 100 || value.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new RoomError('本机入口参数无效。');
    return [...value];
  }
  publicCredential(row) {
    if (!row) return null;
    const { secret_hash, ...visible } = row;
    return visible;
  }
  requireWritable() {
    if (this.readOnly) throw new RoomError('离线只读检查不能发放、接入或撤销恢复入口。', 403, 'resume_read_only');
  }
  credential(credentialId) {
    const row = this.db.prepare('SELECT * FROM chat_resume_credentials WHERE id=?').get(cleanText(credentialId, 200, '恢复入口标识'));
    if (!row) throw new RoomError('恢复入口不存在，请从原聊天室获取新的入口卡。', 404, 'resume_not_found');
    return this.publicCredential(row);
  }
  credentials(memberId = undefined, roomId = undefined) {
    const clauses = ['instance_id=?'], values = [this.instanceId];
    if (memberId !== undefined) { this.chat.member(memberId); clauses.push('member_id=?'); values.push(memberId); }
    if (roomId !== undefined) { this.chat.room(roomId); clauses.push('room_id=?'); values.push(roomId); }
    return this.db.prepare(`SELECT * FROM chat_resume_credentials WHERE ${clauses.join(' AND ')} ORDER BY created,id`).all(...values).map(row => this.publicCredential(row));
  }
  issue(memberId, roomId, options = {}) {
    this.requireWritable();
    this.chat.requireParticipant(roomId, memberId);
    const file = options.file === undefined || options.file === null ? null : path.resolve(cleanText(options.file, 4096, '入口卡文件'));
    const secret = crypto.randomBytes(32).toString('base64url');
    const row = { id: id(), instance_id: this.instanceId, room_id: roomId, member_id: memberId, secret_hash: crypto.createHash('sha256').update(secret).digest('hex'), status: 'pending', created: now(), accepted_at: null, last_seen: null, revoked_at: null };
    const card = {
      schema: CARD_SCHEMA, version: CARD_VERSION,
      credential_id: row.id, instance_id: this.instanceId, room_id: roomId, member_id: memberId,
      data_directory: this.dataDirectory, launch_command: this.command, launch_args: [...this.args],
      secret
    };
    // This operation must be called only by the local user control plane. A
    // model-facing MCP must not be able to mint or rotate its own credential.
    this.chat.transaction(() => {
      this.db.prepare('INSERT INTO chat_resume_credentials(id,instance_id,room_id,member_id,secret_hash,status,created,accepted_at,last_seen,revoked_at) VALUES(:id,:instance_id,:room_id,:member_id,:secret_hash,:status,:created,:accepted_at,:last_seen,:revoked_at)').run(row);
      if (file) atomicWrite(file, `${JSON.stringify(card, null, 2)}\n`);
    });
    return { card, credential: this.publicCredential(row), file };
  }
  parse(card) {
    if (typeof card === 'string') {
      if (card.length > 64000) throw new RoomError('恢复入口卡过大。', 400, 'invalid_resume_card');
      try { card = JSON.parse(card); } catch { throw new RoomError('恢复入口卡不是有效 JSON。', 400, 'invalid_resume_card'); }
    }
    if (!card || typeof card !== 'object' || Array.isArray(card) || card.schema !== CARD_SCHEMA || card.version !== CARD_VERSION) throw new RoomError('恢复入口卡格式或版本无效。', 400, 'invalid_resume_card');
    for (const field of ['credential_id', 'instance_id', 'room_id', 'member_id']) cleanText(card[field], 200, '恢复入口标识');
    if (typeof card.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(card.secret)) throw new RoomError('恢复入口凭据无效。', 403, 'invalid_resume_secret');
    cleanText(card.data_directory, 4096, '入口卡数据路径');
    cleanText(card.launch_command, 4096, '入口卡程序路径');
    this.argumentList(card.launch_args);
    return card;
  }
  validate(card) {
    const parsed = this.parse(card);
    if (parsed.instance_id !== this.instanceId) throw new RoomError('连接到了另一个聊天室实例；请按入口卡定位原数据目录，不要创建替代聊天室。', 409, 'resume_instance_mismatch');
    const row = this.db.prepare('SELECT * FROM chat_resume_credentials WHERE id=?').get(parsed.credential_id);
    if (!row || row.instance_id !== this.instanceId) throw new RoomError('原实例中没有这张入口卡；请向原聊天室获取恢复入口。', 404, 'resume_not_found');
    // The card's room is only where it was first issued; the credential may
    // have moved with its member when that room was deleted or left.
    if (row.member_id !== parsed.member_id) throw new RoomError('入口卡与授权的成员或聊天室不匹配。', 403, 'resume_scope_mismatch');
    const hash = crypto.createHash('sha256').update(parsed.secret).digest();
    if (!crypto.timingSafeEqual(hash, Buffer.from(row.secret_hash, 'hex'))) throw new RoomError('恢复入口凭据无效。', 403, 'invalid_resume_secret');
    if (row.status === 'revoked') throw new RoomError('恢复入口已撤销，请从原聊天室获取新的入口卡。', 410, 'resume_revoked');
    this.chat.requireParticipant(row.room_id, row.member_id);
    return { row, card: { ...parsed, room_id: row.room_id } };
  }
  inspect(card) {
    const { row, card: parsed } = this.validate(card);
    return {
      valid: true, instance_id: this.instanceId, room_id: row.room_id, member_id: row.member_id,
      credential: this.publicCredential(row),
      member: { id: row.member_id, name: this.chat.member(row.member_id).name, adapter: this.chat.member(row.member_id).adapter },
      room: { id: row.room_id, title: this.chat.room(row.room_id).title },
      data_directory: this.dataDirectory,
      location_hint_matches: path.resolve(parsed.data_directory) === path.resolve(this.dataDirectory)
    };
  }
  accept(card) {
    this.requireWritable();
    return this.chat.transaction(() => {
      const { row } = this.validate(card);
      const stamp = now();
      this.db.prepare("UPDATE chat_resume_credentials SET status='active',accepted_at=COALESCE(accepted_at,?),last_seen=? WHERE id=?").run(stamp, stamp, row.id);
      // Resuming is presence evidence, not a replacement for a native adapter's
      // state. Preserve the original verification and any connecting/error state
      // once a member has already completed a real handshake.
      if (!this.chat.member(row.member_id).verified_at) this.chat.updateMember(row.member_id, { status: 'ready', verified_at: stamp, error: null });
      return { ...this.inspect(card), accepted: true, last_seen: stamp };
    });
  }
  revoke(credentialId) {
    this.requireWritable();
    const row = this.credential(credentialId);
    if (row.instance_id !== this.instanceId) throw new RoomError('不能撤销其他聊天室实例的入口。', 403, 'resume_instance_mismatch');
    // Record user intent even when an old version already revoked this row.
    // A timestamp alone can collide with room deletion in the same millisecond.
    this.db.prepare("UPDATE chat_resume_credentials SET status='revoked',revoked_at=COALESCE(revoked_at,?),revocation_reason='explicit' WHERE id=?").run(now(), row.id);
    return this.credential(row.id);
  }
}
module.exports = { ResumeAccess, CARD_SCHEMA, CARD_VERSION };
