'use strict';
const {now} = require('./util.cjs');
const has = (db,table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function backendRoute(db,roomId,provider) {
  const proxy=db.prepare('SELECT * FROM launch_proxies WHERE room_id=? AND provider=?').get(roomId,provider);
  if(proxy)return proxy;
  if(!has(db,'launch_backends'))return null;
  const backend=db.prepare('SELECT * FROM launch_backends WHERE room_id=? AND provider=?').get(roomId,provider);
  return backend?{...backend,id:null,proxy_member_id:null,native_bot_ref:null,native_group_ref:null,native_group_status:'not_requested'}:null;
}
function backendRoutes(db,roomId) {
  const proxies=db.prepare('SELECT * FROM launch_proxies WHERE room_id=? ORDER BY created,rowid').all(roomId);
  const backends=db.prepare('SELECT provider FROM launch_backends b WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM launch_proxies p WHERE p.room_id=b.room_id AND p.provider=b.provider) ORDER BY created,rowid').all(roomId);
  return [...proxies,...backends.map(row=>backendRoute(db,roomId,row.provider))];
}
function saveBackend(db,roomId,candidate,member) {
  const stamp=now();
  db.prepare(`INSERT INTO launch_backends(room_id,provider,name,backend_member_id,created,updated) VALUES(?,?,?,?,?,?)
    ON CONFLICT(room_id,provider) DO UPDATE SET name=excluded.name,backend_member_id=excluded.backend_member_id,updated=excluded.updated`)
    .run(roomId,candidate.provider,candidate.name,member.id,stamp,stamp);
}
// Retire only never-used placeholders. An issued but never accepted credential
// is revoked before dropping its fixed route; identities/history stay on disk.
function retireUnusedProxies(db) {
  let retired=0;
  const reference=(table,sql,...args)=>has(db,table)&&!!db.prepare(sql).get(...args);
  for(const proxy of db.prepare('SELECT p.* FROM launch_proxies p JOIN chat_members m ON m.id=p.proxy_member_id WHERE m.verified_at IS NULL').all()) {
    const memberId=proxy.proxy_member_id;
    if(db.prepare('SELECT adapter FROM chat_members WHERE id=?').get(memberId).adapter!=='grok-proxy'||proxy.native_bot_ref||proxy.native_group_ref)continue;
    if(reference('chat_messages','SELECT 1 FROM chat_messages WHERE sender_id=? OR to_member_id=? LIMIT 1',memberId,memberId)
      ||reference('chat_resume_credentials',"SELECT 1 FROM chat_resume_credentials WHERE member_id=? AND (status='active' OR accepted_at IS NOT NULL OR last_seen IS NOT NULL) LIMIT 1",memberId)
      ||reference('chat_bindings',"SELECT 1 FROM chat_bindings WHERE member_id=? AND (thread_id IS NOT NULL OR binding_state IN ('creating','creation_uncertain','outcome_uncertain','resume_uncertain')) LIMIT 1",memberId)
      ||reference('connection_session_evidence','SELECT 1 FROM connection_session_evidence WHERE member_id=? LIMIT 1',memberId)
      ||reference('runtime_member_presence','SELECT 1 FROM runtime_member_presence WHERE member_id=? LIMIT 1',memberId)
      ||reference('runtime_workers','SELECT 1 FROM runtime_workers WHERE member_id=? LIMIT 1',memberId)
      ||reference('launch_sessions','SELECT 1 FROM launch_sessions WHERE dispatch_member_id=? LIMIT 1',memberId)
      ||reference('launch_sessions',"SELECT 1 FROM launch_sessions WHERE room_id=? AND (group_name IS NOT NULL OR dispatch_requested=1) AND EXISTS(SELECT 1 FROM json_each(selected_providers) WHERE value=?) LIMIT 1",proxy.room_id,proxy.provider)
      ||reference('desktop_person_sessions','SELECT 1 FROM desktop_person_sessions WHERE member_id=? LIMIT 1',memberId)
      ||reference('bridge_bindings','SELECT 1 FROM bridge_bindings WHERE member_id=? LIMIT 1',memberId)
      ||reference('bridge_entries','SELECT 1 FROM bridge_entries WHERE target_member_id=? LIMIT 1',memberId)
      ||reference('launch_sync_routes',"SELECT 1 FROM launch_sync_routes WHERE room_id=? AND status NOT IN ('paused','disabled') LIMIT 1",proxy.room_id)
      ||db.prepare('SELECT 1 FROM launch_proxies WHERE backend_member_id=? LIMIT 1').get(memberId))continue;
    if(has(db,'settings')&&db.prepare("SELECT value FROM settings WHERE key LIKE 'secretary.%'").all().some(row=>{try{return JSON.parse(row.value)?.member_id===memberId;}catch{return false;}}))continue;
    if(has(db,'team_records')&&db.prepare('SELECT body FROM team_records').all().some(row=>{try{const value=JSON.parse(row.body);return value.member_id===memberId||value.secretary_id===memberId||value.assignee_id===memberId;}catch{return false;}}))continue;
    saveBackend(db,proxy.room_id,proxy,{id:proxy.backend_member_id});
    db.prepare('UPDATE launch_backends SET installation=coalesce(installation,?) WHERE room_id=? AND provider=?').run(proxy.installation,proxy.room_id,proxy.provider);
    const stamp=now();
    if(has(db,'chat_resume_credentials'))db.prepare("UPDATE chat_resume_credentials SET status='revoked',revoked_at=? WHERE member_id=? AND status<>'revoked'").run(stamp,memberId);
    if(has(db,'chat_invitations'))db.prepare("UPDATE chat_invitations SET status='revoked' WHERE member_id=? AND status='pending'").run(memberId);
    db.prepare('UPDATE chat_participants SET joined=0,left_at=? WHERE member_id=?').run(stamp,memberId);
    db.prepare("UPDATE chat_members SET status='disabled',updated=? WHERE id=?").run(stamp,memberId);
    db.prepare('DELETE FROM launch_proxies WHERE id=?').run(proxy.id);retired++;
  }
  return retired;
}
module.exports={backendRoute,backendRoutes,saveBackend,retireUnusedProxies};
