'use strict';

// Projection only. The desktop's cold/offline read uses an already read-only
// SQLite handle and never constructs TeamManager or RoomService (both migrate
// or recover state). Keep this shape in parity with TeamManager.snapshot.
function readTeamSnapshot(disk,roomId){
  disk.chat.room(roomId);
  const hasTable=name=>!!disk.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const records=hasTable('team_records')?disk.store.db.prepare('SELECT kind,record_key,body FROM team_records WHERE room_id=? ORDER BY rowid').all(roomId).map(row=>({...row,value:JSON.parse(row.body)})):[];
  const rows=kind=>records.filter(row=>row.kind===kind).map(row=>row.value);
  const keyed=(kind,key)=>records.find(row=>row.kind===kind&&row.record_key===key)?.value||null;
  const secretary=require('./secretary.cjs').secretaryRole(disk.store,disk.chat,disk.runtime,roomId,{offline:true});
  const cards=disk.chat.participants(roomId).map(member=>{
    const saved=keyed('card',member.id),runtime=disk.runtime.memberState(member.id),binding=disk.chat.binding(roomId,member.id);
    // can_wake is the saved adapter capability, as in the online projection.
    // The enclosing desktop state is running:false and never permits writes.
    return {member_id:member.id,name:member.name,adapter:member.adapter,role:'',skills:[],information:'',sources:[],session_ref:'',version:0,ack_version:0,updated_at:null,...saved,can_wake:runtime.can_wake,presence:runtime.presence,registration:runtime.registration,native_session_ref:binding.thread_id,context_status:saved?'self_or_controller_reported':'not_provided'};
  });
  const meetings=rows('meeting').map(value=>({...value,missing_member_ids:(value.expected_member_ids||value.participant_ids).filter(member=>!(value.reports||[]).some(report=>report.member_id===member&&report.round===value.round&&!report.late))}));
  return {room_id:roomId,secretary_id:secretary.member_id,cards,goals:rows('goal'),tasks:rows('task'),meetings,brief:keyed('brief','current')||{version:0,content:'',updated_at:null},schedule:keyed('schedule','current')||{enabled:false,interval_hours:24,timezone:'Asia/Taipei',next_run_at:null,last_result:''},delivery_issues:hasTable('team_outbox')?disk.store.db.prepare("SELECT id,record_id,error,status FROM team_outbox WHERE room_id=? AND status IN ('failed','uncertain')").all(roomId):[]};
}

module.exports={readTeamSnapshot};
