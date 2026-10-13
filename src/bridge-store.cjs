'use strict';
const crypto = require('node:crypto');
const { ChatStore } = require('./chat-store.cjs');
const { RoomError, id, now, cleanText, redact } = require('./util.cjs');

// Host references and delivery receipts are caller reports, not independent
// native verification. Saving either never marks a Grok bot/group verified.
class BridgeStore {
  constructor(chatOrStore) {
    this.chat = typeof chatOrStore.requireParticipant === 'function' ? chatOrStore : new ChatStore(chatOrStore);
    this.db = this.chat.db;
    this.savepoint = 0;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_bindings (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES chat_members(id),
        room_id TEXT NOT NULL REFERENCES chat_rooms(id), provider TEXT NOT NULL,
        conversation_ref TEXT NOT NULL, label TEXT, status TEXT NOT NULL DEFAULT 'unverified',
        created TEXT NOT NULL, updated TEXT NOT NULL,
        UNIQUE(member_id,provider,conversation_ref)
      );
      CREATE TABLE IF NOT EXISTS bridge_entries (
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bridge_bindings(id),
        external_message_id TEXT NOT NULL, chat_message_id TEXT UNIQUE REFERENCES chat_messages(id),
        status TEXT NOT NULL DEFAULT 'staged', text TEXT NOT NULL,
        target_member_id TEXT NOT NULL REFERENCES chat_members(id), response_text TEXT NOT NULL DEFAULT '',
        native_delivery_receipt TEXT, error TEXT, idempotency_key TEXT, body_hash TEXT NOT NULL,
        created TEXT NOT NULL, updated TEXT NOT NULL,
        UNIQUE(binding_id,external_message_id),
        CHECK(status!='delivered' OR native_delivery_receipt IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS bridge_entries_binding ON bridge_entries(binding_id,created,id);
      CREATE INDEX IF NOT EXISTS bridge_entries_status ON bridge_entries(status,created);
    `);
  }
  transaction(fn) {
    const name = `bridge_write_${++this.savepoint}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); this.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  bind(input) {
    this.chat.requireParticipant(input.room_id, input.member_id);
    const provider = input.provider || 'generic';
    if (!['grok-bot', 'generic', 'local-test'].includes(provider)) throw new RoomError('桥接宿主类型无效。');
    const reference = cleanText(input.conversation_ref, 2000, '原生会话引用');
    const label = input.label == null ? null : redact(cleanText(input.label, 120, '原生会话名称'));
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM bridge_bindings WHERE member_id=? AND provider=? AND conversation_ref=?').get(input.member_id, provider, reference);
      if (existing) {
        if (existing.room_id !== input.room_id) throw new RoomError('这个原生会话已绑定其他聊天室，不能悄悄更换来源。', 409, 'binding_room_conflict');
        if (input.label !== undefined && existing.label !== label) this.db.prepare('UPDATE bridge_bindings SET label=?,updated=? WHERE id=?').run(label, now(), existing.id);
        return this.binding(existing.id);
      }
      const row = { id: id(), member_id: input.member_id, room_id: input.room_id, provider, conversation_ref: reference, label, status: 'unverified', created: now(), updated: now() };
      this.db.prepare('INSERT INTO bridge_bindings VALUES(:id,:member_id,:room_id,:provider,:conversation_ref,:label,:status,:created,:updated)').run(row);
      return row;
    });
  }
  binding(bindingId) {
    const row = this.db.prepare('SELECT * FROM bridge_bindings WHERE id=?').get(bindingId);
    if (!row) throw new RoomError('桥接来源不存在。', 404);
    this.chat.room(row.room_id);
    return row;
  }
  bindings(memberId = undefined, roomId = undefined) {
    const conditions = ['NOT EXISTS (SELECT 1 FROM chat_room_tombstones t WHERE t.room_id=bridge_bindings.room_id)'], values = [];
    if (memberId != null) { this.chat.member(memberId); conditions.push('member_id=?'); values.push(memberId); }
    if (roomId != null) { this.chat.room(roomId); conditions.push('room_id=?'); values.push(roomId); }
    return this.db.prepare(`SELECT * FROM bridge_bindings ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY created,id`).all(...values);
  }
  publicEntry(row) {
    const { body_hash, idempotency_key, ...visible } = row;
    return { ...visible, native_delivery_receipt: row.native_delivery_receipt == null ? null : JSON.parse(row.native_delivery_receipt) };
  }
  submit(input) {
    const binding = this.binding(input.binding_id);
    const externalId = cleanText(input.external_message_id, 2000, '原生消息标识');
    const target = cleanText(input.target_member_id, 200, '处理成员');
    const text = redact(cleanText(input.text, 20000, '桥接问题')).slice(0, 20000);
    const key = input.idempotency_key == null ? null : cleanText(input.idempotency_key, 200, '桥接请求标识');
    const hash = crypto.createHash('sha256').update(JSON.stringify([target, text])).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM bridge_entries WHERE binding_id=? AND external_message_id=?').get(binding.id, externalId);
      if (existing) {
        if (existing.body_hash !== hash) throw new RoomError('同一原生消息对应了不同问题或处理成员。', 409, 'idempotency_conflict');
        return this.publicEntry(existing);
      }
      this.chat.requireParticipant(binding.room_id, binding.member_id);
      this.chat.requireParticipant(binding.room_id, target);
      if (target === binding.member_id) throw new RoomError('桥接成员不能把问题排给自己。', 400, 'bridge_self_target');
      const row = { id: id(), binding_id: binding.id, external_message_id: externalId, chat_message_id: null, status: 'staged', text, target_member_id: target, response_text: '', native_delivery_receipt: null, error: null, idempotency_key: key, body_hash: hash, created: now(), updated: now() };
      this.db.prepare('INSERT INTO bridge_entries VALUES(:id,:binding_id,:external_message_id,:chat_message_id,:status,:text,:target_member_id,:response_text,:native_delivery_receipt,:error,:idempotency_key,:body_hash,:created,:updated)').run(row);
      return this.publicEntry(row);
    });
  }
  entry(entryId) {
    const row = this.db.prepare('SELECT * FROM bridge_entries WHERE id=?').get(entryId);
    if (!row) throw new RoomError('桥接请求不存在。', 404);
    this.binding(row.binding_id);
    return this.publicEntry(row);
  }
  entryForMessage(messageId) {
    const row = this.db.prepare('SELECT * FROM bridge_entries WHERE chat_message_id=?').get(messageId);
    if(row)this.chat.message(messageId);
    return row ? this.publicEntry(row) : null;
  }
  list(bindingId = undefined) {
    if (bindingId != null) this.binding(bindingId);
    return this.db.prepare(`SELECT * FROM bridge_entries e WHERE NOT EXISTS (SELECT 1 FROM bridge_bindings b JOIN chat_room_tombstones t ON t.room_id=b.room_id WHERE b.id=e.binding_id) ${bindingId == null ? '' : 'AND binding_id=?'} ORDER BY created,id`).all(...(bindingId == null ? [] : [bindingId])).map(row => this.publicEntry(row));
  }
  setMessage(entryId, messageId) {
    return this.transaction(() => {
      const entry = this.entry(entryId), binding = this.binding(entry.binding_id), message = this.chat.message(messageId);
      if (message.room_id !== binding.room_id || message.sender_id !== binding.member_id || message.to_member_id !== entry.target_member_id || message.text !== entry.text) throw new RoomError('聊天消息与原桥接问题、来源或处理成员不匹配。', 403, 'bridge_message_mismatch');
      if (entry.chat_message_id) {
        if (entry.chat_message_id !== message.id) throw new RoomError('桥接请求已关联其他聊天消息。', 409, 'bridge_message_conflict');
        return entry;
      }
      if (entry.status !== 'staged') throw new RoomError('这条桥接请求需先核对状态，不能自动重新执行。', 409, 'invalid_bridge_state');
      const owner = this.entryForMessage(message.id);
      if (owner && owner.id !== entry.id) throw new RoomError('聊天消息已关联另一条桥接请求。', 409, 'bridge_message_conflict');
      this.db.prepare("UPDATE bridge_entries SET chat_message_id=?,status='waiting',updated=? WHERE id=?").run(message.id, now(), entry.id);
      return this.entry(entry.id);
    });
  }
  updateEntry(entryId, fields) {
    const original = this.entry(entryId);
    const states = ['staged', 'waiting', 'answered', 'delivered', 'uncertain', 'failed', 'cancelled'];
    const entries = Object.entries(fields).filter(([key]) => ['status', 'response_text', 'error'].includes(key)).map(([key, value]) => {
      if (key === 'status' && !states.includes(value)) throw new RoomError('桥接状态无效。');
      if (key === 'response_text') {
        if (typeof value !== 'string' || value.length > 40000 || value.includes('\0')) throw new RoomError('桥接回答格式无效或过长。');
        value = redact(value).trim();
      }
      if (key === 'error') value = value == null ? null : redact(value).slice(0, 2000);
      return [key, value];
    });
    const next = { ...original, ...Object.fromEntries(entries) };
    if (next.status === 'delivered' && (original.status !== 'delivered' || !original.native_delivery_receipt)) throw new RoomError('需要外部回复引用后，才能记录桥接回报。', 409, 'delivery_receipt_required');
    if (original.status === 'delivered' && (next.status !== 'delivered' || next.response_text !== original.response_text)) throw new RoomError('已送达记录不能覆盖原回答或撤销送达证据。', 409, 'delivered_entry_immutable');
    if (['waiting', 'answered'].includes(next.status) && !next.chat_message_id) throw new RoomError('请先关联实际聊天请求，不能把草稿当作已执行任务。', 409, 'chat_message_required');
    if (next.status === 'answered' && !next.response_text) throw new RoomError('需要实际回答后，才能记录已回答。', 409, 'bridge_answer_required');
    if (entries.length) this.db.prepare(`UPDATE bridge_entries SET ${entries.map(([key]) => `${key}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([, value]) => value), now(), entryId);
    return this.entry(entryId);
  }
  deliver(entryId, receipt) {
    const conversation = cleanText(receipt?.conversation_ref, 2000, '桥接回报会话引用');
    const replyId = cleanText(receipt?.external_reply_id, 2000, '桥接回报回复标识');
    return this.transaction(() => {
      const entry = this.entry(entryId), binding = this.binding(entry.binding_id);
      if (conversation !== binding.conversation_ref) throw new RoomError('桥接回报的会话引用与这条请求的来源不一致。', 409, 'wrong_native_conversation');
      const value = { conversation_ref: conversation, external_reply_id: replyId };
      if (entry.status === 'delivered') {
        if (entry.native_delivery_receipt.conversation_ref !== conversation || entry.native_delivery_receipt.external_reply_id !== replyId) throw new RoomError('这条请求已有不同的原生送达回执。', 409, 'delivery_receipt_conflict');
        return entry;
      }
      if (entry.status !== 'answered') throw new RoomError('尚未得到实际回答，不能记录已送达。', 409, 'invalid_bridge_state');
      this.db.prepare("UPDATE bridge_entries SET status='delivered',native_delivery_receipt=?,error=NULL,updated=? WHERE id=?").run(JSON.stringify(value), now(), entry.id);
      return this.entry(entry.id);
    });
  }
  recovery() {
    const result = this.db.prepare("UPDATE bridge_entries SET status='uncertain',error='程序在建立聊天室请求期间结束，请先核对房间记录，避免重复转发。',updated=? WHERE status='staged' AND chat_message_id IS NULL").run(now());
    return Number(result.changes);
  }
}
module.exports = { BridgeStore };
