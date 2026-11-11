'use strict';
const {id, now, VERSION} = require('./util.cjs');

// Attempts are immutable in identity/start/version. Reading stats never calls
// this recorder or reinterprets old onboarding rows as new attempts.
class OnboardingAttempts {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS onboarding_attempts(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL,room_id TEXT NOT NULL,provider TEXT NOT NULL,
      version TEXT NOT NULL,kind TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,
      outcome TEXT NOT NULL DEFAULT 'waiting',protocol_verified INTEGER NOT NULL DEFAULT 0,
      automatic_reply_verified INTEGER NOT NULL DEFAULT 0,error_code TEXT);
      CREATE INDEX IF NOT EXISTS onboarding_attempt_scope ON onboarding_attempts(room_id,provider,started_at);`);
  }
  begin(row) {
    const prior = this.db.prepare('SELECT 1 FROM onboarding_attempts WHERE room_id=? AND provider=? LIMIT 1').get(row.room_id,row.provider)
      || this.db.prepare('SELECT 1 FROM onboarding_runs WHERE room_id=? AND provider=? AND id<>? LIMIT 1').get(row.room_id,row.provider,row.id);
    const stamp = now();
    this.db.prepare("UPDATE onboarding_attempts SET outcome='superseded',completed_at=? WHERE room_id=? AND provider=? AND outcome='waiting'").run(stamp,row.room_id,row.provider);
    this.db.prepare('INSERT INTO onboarding_attempts(id,run_id,room_id,provider,version,kind,started_at) VALUES(?,?,?,?,?,?,?)')
      .run(id(),row.id,row.room_id,row.provider,VERSION,prior?'retry':'first',stamp);
  }
  observe(row, view) {
    const complete = view.ready_for_office === true, failed=!complete&&['error','failed','interrupted'].includes(view.status);
    this.db.prepare(`UPDATE onboarding_attempts SET outcome=CASE WHEN ? THEN 'connected' WHEN ? THEN 'failed' ELSE outcome END,
      completed_at=CASE WHEN ? THEN ? ELSE completed_at END,
      protocol_verified=max(protocol_verified,?),automatic_reply_verified=max(automatic_reply_verified,?),
      error_code=coalesce(?,error_code) WHERE run_id=? AND outcome='waiting'`)
      .run(complete?1:0,failed?1:0,complete||failed?1:0,now(),view.protocol_verified||view.handshake_verified?1:0,view.automatic_reply_verified?1:0,view.error?view.error_code||'unknown':null,row.id);
  }
  abandon(roomId, provider = null) {
    this.db.prepare("UPDATE onboarding_attempts SET outcome='abandoned',completed_at=? WHERE room_id=? AND outcome='waiting'"+(provider?' AND provider=?':''))
      .run(now(),roomId,...provider?[provider]:[]);
  }
}
module.exports = {OnboardingAttempts};
