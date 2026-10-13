'use strict';
const {RoomError}=require('./util.cjs');

// Local room deletion is a controller operation. Native Grok groups, projects,
// shared accounts and native session history remain outside this operation.
function deleteRoom(service,roomId){
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后删除聊天室。',503,'service_stopping');
  const result=service.chat.store.deleteRoom(roomId,(_roomId,busy)=>{
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
