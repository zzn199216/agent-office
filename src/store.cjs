'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RoomError, id, now, atomicWrite, cleanText, projectPath } = require('./util.cjs');

class Store {
  constructor(dir, options = {}) {
    this.dir = dir;
    if(options.readOnly){this.db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true});this.db.exec('PRAGMA busy_timeout=5000;');return;}
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'room.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, canonical TEXT NOT NULL UNIQUE, access TEXT NOT NULL DEFAULT 'read-only', created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discussions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, thread_id TEXT, binding_state TEXT NOT NULL DEFAULT 'new', created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL REFERENCES discussions(id), sender TEXT NOT NULL, recipient TEXT NOT NULL, prompt TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL, status TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '', error TEXT, turn_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), status TEXT NOT NULL, upstream_run_id TEXT, error TEXT, answer TEXT NOT NULL DEFAULT '', receipt TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports (request_id TEXT PRIMARY KEY REFERENCES requests(id), updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_discussion ON requests(discussion_id, created);
      CREATE INDEX IF NOT EXISTS requests_status ON requests(status, created);`);
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'notify_grok')) this.db.exec('ALTER TABLE requests ADD COLUMN notify_grok INTEGER NOT NULL DEFAULT 0');
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  setting(key, value) {
    if (value === undefined) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); return value;
  }
  addProject(name, value, access = 'read-only') {
    const p = projectPath(value);
    const existing = this.db.prepare('SELECT * FROM projects WHERE canonical=?').get(p.canonical);
    if (existing) return existing;
    if (!['read-only', 'workspace-write'].includes(access)) throw new RoomError('项目权限无效。');
    const row = { id: id(), name: cleanText(name || path.basename(p.display), 80, '项目名称'), path: p.display, canonical: p.canonical, access, created: now() };
    this.db.prepare('INSERT INTO projects VALUES(:id,:name,:path,:canonical,:access,:created)').run(row); return row;
  }
  project(projectId) { const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId); if (!row) throw new RoomError('项目不存在。', 404); return row; }
  projects() { return this.db.prepare('SELECT * FROM projects ORDER BY created').all(); }
  addDiscussion(projectId, title, threadId = null) {
    this.project(projectId);
    if (threadId !== null && !/^[a-f0-9-]{36}$/i.test(threadId)) throw new RoomError('Codex 会话 ID 格式无效。');
    const row = { id: id(), project_id: projectId, title: cleanText(title || '项目讨论', 100, '讨论主题'), thread_id: threadId, binding_state: threadId ? 'bound' : 'new', created: now(), updated: now() };
    this.db.prepare('INSERT INTO discussions VALUES(:id,:project_id,:title,:thread_id,:binding_state,:created,:updated)').run(row); return row;
  }
  discussion(discussionId) { const row = this.db.prepare('SELECT * FROM discussions WHERE id=?').get(discussionId); if (!row) throw new RoomError('讨论不存在。', 404); return row; }
  discussions() { return this.db.prepare('SELECT d.*,p.name AS project_name,p.path AS project_path,(SELECT status FROM requests WHERE discussion_id=d.id ORDER BY rowid DESC LIMIT 1) AS last_status FROM discussions d JOIN projects p ON p.id=d.project_id ORDER BY d.updated DESC').all(); }
  bind(discussionId, state, threadId = undefined) {
    if (threadId === undefined) this.db.prepare('UPDATE discussions SET binding_state=?,updated=? WHERE id=?').run(state, now(), discussionId);
    else this.db.prepare('UPDATE discussions SET binding_state=?,thread_id=?,updated=? WHERE id=?').run(state, threadId, now(), discussionId);
  }
  submit(input) {
    const d = this.discussion(input.discussion_id);
    const sender = cleanText(input.sender || 'user', 60, '来源');
    const recipient = input.recipient || 'codex';
    if (!['codex', 'grok'].includes(recipient)) throw new RoomError('请选择 Codex 或 Grok。');
    const prompt = cleanText(input.message || input.prompt);
    const key = cleanText(input.idempotency_key, 200, '请求标识');
    const dedupe = `${d.id}:${sender}:${key}`;
    const hash = crypto.createHash('sha256').update(JSON.stringify([recipient, prompt, !!input.notify_grok])).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM requests WHERE dedupe_key=?').get(dedupe);
      if (old) { if (old.body_hash !== hash) throw new RoomError('同一请求标识对应了不同内容，请使用新的标识。', 409, 'idempotency_conflict'); return old; }
      const row = { id: id(), discussion_id: d.id, sender, recipient, prompt, dedupe_key: dedupe, body_hash: hash, status: 'queued', answer: '', progress: '', error: null, turn_id: null, created: now(), updated: now(), notify_grok: input.notify_grok ? 1 : 0 };
      this.db.prepare('INSERT INTO requests(id,discussion_id,sender,recipient,prompt,dedupe_key,body_hash,status,answer,progress,error,turn_id,created,updated,notify_grok) VALUES(:id,:discussion_id,:sender,:recipient,:prompt,:dedupe_key,:body_hash,:status,:answer,:progress,:error,:turn_id,:created,:updated,:notify_grok)').run(row);
      this.db.prepare('UPDATE discussions SET updated=? WHERE id=?').run(row.updated, d.id);
      this.markExport(row.id); return row;
    });
  }
  request(requestId) { const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId); if (!row) throw new RoomError('请求不存在。', 404); return row; }
  history(discussionId) { this.discussion(discussionId); return this.db.prepare('SELECT * FROM requests WHERE discussion_id=? ORDER BY rowid').all(discussionId); }
  next() { return this.db.prepare("SELECT * FROM requests WHERE status='queued' AND recipient='codex' ORDER BY rowid LIMIT 1").get() || null; }
  update(requestId, fields) {
    const allowed = ['status', 'answer', 'progress', 'error', 'turn_id'];
    const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
    if (!entries.length) return this.request(requestId);
    this.db.prepare(`UPDATE requests SET ${entries.map(([k]) => `${k}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([,v]) => v), now(), requestId);
    const row = this.request(requestId);
    this.db.prepare('UPDATE discussions SET updated=? WHERE id=?').run(row.updated, row.discussion_id);
    this.markExport(requestId); return row;
  }
  markExport(requestId) { this.db.prepare('INSERT INTO exports VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET updated=excluded.updated').run(requestId, now()); }
  recovery() {
    this.transaction(() => {
      this.db.prepare("UPDATE discussions SET binding_state='creation_uncertain' WHERE binding_state='creating'").run();
      const active = this.db.prepare("SELECT id FROM requests WHERE status IN ('creating','running','waiting_input')").all();
      for (const r of active) this.update(r.id, { status: 'outcome_uncertain', error: '程序在处理期间结束。请先核对已保存会话，避免重复执行。' });
      this.db.prepare("UPDATE deliveries SET status='uncertain',error='发送期间程序结束，请先核对 Grok 记录。' WHERE status='sending'").run();
    });
  }
  addDelivery(requestId) {
    const old = this.db.prepare('SELECT * FROM deliveries WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(requestId);
    if (old) return old;
    const r = { id: id(), request_id: requestId, status: 'pending', upstream_run_id: null, error: null, answer: '', receipt: null, created: now(), updated: now() };
    this.db.prepare('INSERT INTO deliveries VALUES(:id,:request_id,:status,:upstream_run_id,:error,:answer,:receipt,:created,:updated)').run(r); return r;
  }
  delivery(deliveryId) { const r = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId); if (!r) throw new RoomError('回报不存在。', 404); return r; }
  deliveryFor(requestId) { return this.db.prepare('SELECT * FROM deliveries WHERE request_id=? ORDER BY rowid DESC LIMIT 1').get(requestId) || null; }
  updateDelivery(deliveryId, fields) {
    const entries = Object.entries(fields).filter(([k]) => ['status', 'upstream_run_id', 'error', 'answer', 'receipt'].includes(k));
    this.db.prepare(`UPDATE deliveries SET ${entries.map(([k]) => `${k}=?`).join(',')},updated=? WHERE id=?`).run(...entries.map(([,v]) => v), now(), deliveryId);
    this.markExport(this.delivery(deliveryId).request_id); return this.delivery(deliveryId);
  }
  inbox() { return this.db.prepare("SELECT v.*,r.prompt,r.discussion_id,r.answer AS codex_answer,d.title,p.name AS project_name FROM deliveries v JOIN requests r ON r.id=v.request_id JOIN discussions d ON d.id=r.discussion_id JOIN projects p ON p.id=d.project_id WHERE v.status NOT IN ('continued','answered','cancelled') ORDER BY v.created").all(); }
  exportPending() {
    for (const pending of this.db.prepare('SELECT * FROM exports').all()) {
      const r = this.request(pending.request_id); const d = this.discussion(r.discussion_id); const v = this.deliveryFor(r.id);
      const folder = path.join(this.dir, 'rooms', d.id, 'messages');
      const meta = { message_id: r.id, discussion_id: d.id, project_id: d.project_id, sender: r.sender, recipient: r.recipient, status: r.status, created_at: r.created, updated_at: r.updated, codex_thread_id: d.thread_id, turn_id: r.turn_id };
      const md = `---\n${Object.entries(meta).map(([k,val]) => `${k}: ${JSON.stringify(val)}`).join('\n')}\n---\n\n# 问题\n\n${r.prompt}\n\n# 回答\n\n${r.answer || '尚未收到回答。'}${r.error ? `\n\n# 状态说明\n\n${r.error}` : ''}${v ? `\n\n# Grok 回报\n\n状态：${v.status}\n\n${v.answer || ''}` : ''}\n`;
      atomicWrite(path.join(folder, `${r.id}.md`), md);
      this.db.prepare('DELETE FROM exports WHERE request_id=? AND updated=?').run(r.id, pending.updated);
    }
  }
}
module.exports = { Store };
