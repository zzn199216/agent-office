'use strict';
const {RoomError,now}=require('./util.cjs');

function deletionBlockers(service,roomId){
  const db=service.store.db,items=[];
  for(const row of db.prepare("SELECT m.id,m.status,m.created,p.name FROM chat_messages m LEFT JOIN chat_members p ON p.id=m.to_member_id WHERE m.room_id=? AND (m.status NOT IN ('posted','answered','completed','failed','cancelled','consumed') OR m.status='consumed' AND m.kind NOT IN ('reply','acknowledgment')) ORDER BY m.seq LIMIT 20").all(roomId))items.push({kind:'message',id:row.id,status:row.status,name:row.name||'成员',created:row.created});
  for(const row of db.prepare("SELECT b.member_id,b.binding_state,p.name FROM chat_bindings b JOIN chat_members p ON p.id=b.member_id WHERE b.room_id=? AND b.binding_state IN ('creating','creation_uncertain','outcome_uncertain','resume_uncertain') LIMIT 20").all(roomId))items.push({kind:'binding',id:row.member_id,status:row.binding_state,name:row.name});
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_records'").get())for(const row of db.prepare("SELECT id,kind,body FROM team_records WHERE room_id=? AND kind IN ('goal','task','meeting') LIMIT 100").all(roomId)){let value;try{value=JSON.parse(row.body);}catch{}if(!value||row.kind==='goal'&&value.status==='active'||row.kind==='task'&&!['completed','cancelled','failed'].includes(value.status)||row.kind==='meeting'&&['collecting','review'].includes(value.status))items.push({kind:'team',id:row.id,status:value?.status||'unknown',name:value?.title||'协作任务'});}
  return {room_id:roomId,blockers:items.slice(0,20)};
}
// A user deletion request may settle an already interrupted owned Codex turn.
// Inspect the exact saved thread/turn only; never resume a turn or infer success.
async function settleInterruptedWork(service,roomId){
  if(service.closing||service.chat.closing||[...service.chat.active.values()].some(value=>value.roomId===roomId))return;
  const db=service.store.db;
  if(db.prepare('SELECT 1 FROM chat_room_tombstones WHERE room_id=?').get(roomId))return;
  const room=service.chat.store.room(roomId),project=service.store.project(room.project_id),threads=new Map();
  const rows=db.prepare("SELECT m.id,m.to_member_id,m.request_id,b.thread_id FROM chat_messages m JOIN chat_members p ON p.id=m.to_member_id JOIN chat_bindings b ON b.room_id=m.room_id AND b.member_id=m.to_member_id WHERE m.room_id=? AND m.status='uncertain' AND m.request_id IS NOT NULL AND p.adapter='codex' AND b.binding_state='bound' AND b.thread_id IS NOT NULL ORDER BY m.seq LIMIT 10").all(roomId);
  for(const row of rows){
    try{
      if(!threads.has(row.thread_id)){const client=service.chat.nativeClient(service.chat.store.member(row.to_member_id));threads.set(row.thread_id,await client.inspectBound(project,{...room,thread_id:row.thread_id}));}
      const turn=threads.get(row.thread_id)?.turns?.find(value=>value.id===row.request_id);
      if(!turn||!['interrupted','failed'].includes(turn.status))continue;
      service.chat.reconcile(row.id,{outcome:turn.status==='interrupted'?'cancelled':'failed',evidence:{summary:`删除前读取了绑定的 Codex 原生工作记录；对应轮次状态为 ${turn.status}，没有重新执行。`,source:`Codex thread ${row.thread_id}, turn ${row.request_id}`,observed_at:now()}},{nativeObserved:true});
    }catch{/* Missing records or a concurrent worker keep the deletion blocked. */}
  }
}

// Local room deletion is a controller operation. Native Grok groups, projects,
// shared accounts and native session history remain outside this operation.
function deleteRoom(service,roomId){
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后删除聊天室。',503,'service_stopping');
  let result;try{result=service.chat.store.deleteRoom(roomId,(_roomId,busy)=>{
    if(service.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_records'").get()){
      for(const row of service.store.db.prepare("SELECT kind,body FROM team_records WHERE room_id=? AND kind IN ('goal','task','meeting')").all(roomId)){
        let value;try{value=JSON.parse(row.body);}catch{busy();}
        if(!value||row.kind==='goal'&&value.status==='active'||row.kind==='task'&&!['completed','cancelled','failed'].includes(value.status)||row.kind==='meeting'&&['collecting','review'].includes(value.status))busy();
      }
    }
    if(service.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_outbox'").get()&&service.store.db.prepare("SELECT 1 FROM team_outbox WHERE room_id=? AND status IN ('pending','uncertain') LIMIT 1").get(roomId))busy();
    for(const active of service.chat.active.values())if(active.roomId===roomId)busy();
    // A connecting entry can exist just before its active worker is registered.
    for(const key of service.chat.connecting.keys())if(key.endsWith(':'+roomId)||key.startsWith(roomId+':'))busy();
    for(const approval of service.approvals.values()){
      const requestId=approval.public?.request_id;
      if(requestId&&service.store.db.prepare('SELECT 1 FROM chat_messages WHERE id=? AND room_id=?').get(requestId,roomId))busy();
    }
  });}catch(error){if(error.code==='room_busy')error.details=deletionBlockers(service,roomId);throw error;}
  if(!result.already_deleted)service.changed();
  return result;
}
// Archiving only organises the local list. It preserves ongoing work, messages,
// participant entries and schedules. Deletion keeps its separate busy checks.
function archiveRoom(service,roomId,archived){
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后管理聊天室。',503,'service_stopping');
  const room=service.chat.store.setArchived(roomId,archived);service.changed();return room;
}
module.exports={deleteRoom,archiveRoom,deletionBlockers,settleInterruptedWork};
