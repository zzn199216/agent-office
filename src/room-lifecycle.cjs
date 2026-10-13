'use strict';
const {RoomError}=require('./util.cjs');

// Local room deletion is a controller operation. Native Grok groups, projects,
// shared accounts and native session history remain outside this operation.
function deleteRoom(service,roomId){
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后删除聊天室。',503,'service_stopping');
  const result=service.chat.store.deleteRoom(roomId,(_roomId,busy)=>{
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
  });
  if(!result.already_deleted)service.changed();
  return result;
}
module.exports={deleteRoom};
