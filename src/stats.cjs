'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {RoomError} = require('./util.cjs');
const BASELINE = '0.15.0-preview.21';
const {SHORT_NAMES} = require('./member-connection.cjs');

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(value || '');
  if (!match) throw new RoomError('版本应为 x.y.z 或 x.y.z-preview.n。',400,'stats_version_invalid');
  return [Number(match[1]),Number(match[2]),Number(match[3]),match[4]===undefined?Infinity:Number(match[4])];
}
function since(version, baseline) {
  if (!version) return false;
  const parts = versionParts(version), target = versionParts(baseline);
  for (let i=0;i<parts.length;i++) if (parts[i]!==target[i]) return parts[i]>target[i];
  return true;
}
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b), size = sorted.length;
  return size ? (sorted[Math.floor((size-1)/2)]+sorted[Math.floor(size/2)])/2 : null;
};
const providerName = value => Object.hasOwn(SHORT_NAMES,value)?value:'other';
const errorName = value => /^(?:(?:codex|claude|qwen|gemini|desktop|connection|runtime|client|verification)_[a-z0-9_]+|ENOENT|EACCES|unknown)$/.test(value||'')?value:'unknown';
function week(value) {
  const date = new Date(value); date.setUTCHours(0,0,0,0);
  date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
  return date.toISOString().slice(0,10);
}
function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.room_id+'\0'+row.provider;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  const result = {attempts:rows.length,first_attempts:rows.filter(row=>row.kind==='first').length,retries:rows.filter(row=>row.kind==='retry').length,
    connected_attempts:rows.filter(row=>row.outcome==='connected').length,cohorts:groups.size,first_connected:0,retry_connected:0,abandoned:0,failed:0,waiting:0,
    mcp_connected_attempts:rows.filter(row=>row.protocol_verified).length,
    automatic_reply_verified_attempts:rows.filter(row=>row.automatic_reply_verified).length,
    median_connect_ms:median(rows.filter(row=>row.outcome==='connected').map(row=>Date.parse(row.completed_at)-Date.parse(row.started_at)))};
  for (const attempts of groups.values()) {
    const success = attempts.find(row=>row.outcome==='connected');
    if (success) result[success.kind==='first'?'first_connected':'retry_connected']++;
    else if (attempts.at(-1).outcome==='abandoned') result.abandoned++;
    else if(attempts.at(-1).outcome==='failed')result.failed++;
    else result.waiting++;
  }
  return result;
}
function connectionStats(dir, {sinceVersion = BASELINE} = {}) {
  versionParts(sinceVersion);
  const file = path.join(dir,'room.sqlite');
  if (!fs.existsSync(file)) return {read_only:true,since_version:sinceVersion,available:false};
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; BEGIN;');
    const has = table => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const all = has('onboarding_attempts')?db.prepare('SELECT * FROM onboarding_attempts ORDER BY started_at,rowid').all():[];
    const rows = all.filter(row=>since(row.version,sinceVersion));
    const providers = [...new Set(rows.map(row=>providerName(row.provider)))].sort();
    const weeks = [...new Set(rows.map(row=>week(row.started_at)))].sort();
    const reasons = new Map();
    for (const row of rows.filter(row=>row.error_code)) {const code=errorName(row.error_code);reasons.set(code,(reasons.get(code)||0)+1);}
    const metadata = has('stats_versions')?db.prepare('SELECT * FROM stats_versions').all().filter(row=>since(row.version,sinceVersion)):[];
    const messages = [], types = new Map();
    if (has('chat_members')) for (const member of db.prepare('SELECT id,adapter FROM chat_members').all()) types.set(member.id,['mailbox','grok-bridge','grok-proxy'].includes(member.adapter)?member.adapter:providerName(member.adapter));
    if (has('chat_messages')) for (const tracked of metadata.filter(row=>row.kind==='message')) {
      const request = db.prepare("SELECT id,to_member_id,created,idempotency_key FROM chat_messages WHERE id=? AND sender_id='user' AND to_member_id IS NOT NULL AND kind='message'").get(tracked.entity_id);
      if (!request || request.idempotency_key?.startsWith('onboarding-verification:')) continue;
      const reply = db.prepare("SELECT created FROM chat_messages WHERE reply_to=? AND sender_id=? AND kind='reply' ORDER BY seq LIMIT 1").get(request.id,request.to_member_id);
      messages.push({type:types.get(request.to_member_id)||'other',replied:!!reply,ms:reply?Date.parse(reply.created)-Date.parse(request.created):null});
    }
    const messageTypes = [...new Set(messages.map(row=>row.type))].sort();
    const result = {read_only:true,available:true,since_version:sinceVersion,
      connections:summarize(rows),
      by_provider:providers.map(provider=>({provider,...summarize(rows.filter(row=>providerName(row.provider)===provider))})),
      by_week:weeks.map(start=>({week_start_utc:start,...summarize(rows.filter(row=>week(row.started_at)===start))})),
      failure_reasons:[...reasons].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,10).map(([code,count])=>({code,count})),
      messages:messageTypes.map(type=>{const selected=messages.filter(row=>row.type===type),replied=selected.filter(row=>row.replied);return {member_type:type,requests:selected.length,replied:replied.length,reply_ratio:replied.length/selected.length,median_reply_ms:median(replied.map(row=>row.ms))};}),
      rooms:{created:metadata.filter(row=>row.kind==='room').length,deleted:metadata.filter(row=>row.kind==='room_deleted').length},
      historical:{excluded_tracked_attempts:all.length-rows.length,
        unversioned_onboarding_records:has('onboarding_runs')?db.prepare('SELECT count(*) n FROM onboarding_runs r '+(has('onboarding_attempts')?'WHERE NOT EXISTS(SELECT 1 FROM onboarding_attempts a WHERE a.run_id=r.id)':'')).get().n:0,
        unversioned_messages:has('chat_messages')?db.prepare('SELECT count(*) n FROM chat_messages m '+(has('stats_versions')?"WHERE NOT EXISTS(SELECT 1 FROM stats_versions v WHERE v.kind='message' AND v.entity_id=m.id)":'')).get().n:0}};
    if(has('group_calls')){
      const calls=db.prepare('SELECT purpose,input_chars,status,version FROM group_calls ORDER BY started_at,id').all().filter(c=>since(c.version,sinceVersion));
      result.group_discussion={calls:calls.length,completed:calls.filter(c=>c.status==='completed').length,uncertain:calls.filter(c=>c.status==='uncertain').length,total_input_chars:calls.reduce((sum,c)=>sum+c.input_chars,0),median_input_chars:median(calls.map(c=>c.input_chars)),by_purpose:[...new Set(calls.map(c=>c.purpose))].sort().map(purpose=>({purpose,calls:calls.filter(c=>c.purpose===purpose).length}))};
    }
    db.exec('COMMIT;'); return result;
  } finally {db.close();}
}
module.exports = {connectionStats,versionParts,since,median};
