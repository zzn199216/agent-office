'use strict';
const {RoomError,now}=require('./util.cjs');
const crypto=require('node:crypto');
const {ChildProcess,spawnSync}=require('node:child_process');
const confirmations=new WeakMap();
function stopOwnedChildTree(child){
  if(!(child instanceof ChildProcess)||!Number.isSafeInteger(child.pid)||child.pid<1||child.pid===process.pid||child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,timeout:5000,stdio:'ignore'});
  else child.kill();
}
const pendingMessages="(status NOT IN ('posted','answered','completed','failed','cancelled','consumed') OR status='consumed' AND kind NOT IN ('reply','acknowledgment'))";
function activeTeam(kind,value){return !value||kind==='goal'&&value.status==='active'||kind==='task'&&!['completed','cancelled','failed'].includes(value.status)||kind==='meeting'&&['collecting','review'].includes(value.status);}
function deletionTasks(service,roomId){
  const db=service.store.db,items=[],table=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  for(const row of db.prepare(`SELECT id,status,text,to_member_id FROM chat_messages WHERE room_id=? AND ${pendingMessages} ORDER BY seq`).all(roomId))items.push({kind:'message',id:row.id,status:row.status,name:row.to_member_id?service.chat.store.member(row.to_member_id).name:'成员',title:row.text.slice(0,160),external:['delivered','consumed','uncertain'].includes(row.status)});
  for(const [memberId,value]of service.chat.active)if(value.roomId===roomId)items.push({kind:'worker',id:memberId,status:value.connecting?'connecting':'processing',name:service.chat.store.member(memberId).name,title:value.connecting?'接入握手':'后台处理'});
  for(const key of service.chat.connecting.keys())if(key.startsWith(roomId+':')&&!items.some(item=>item.kind==='worker'&&item.id===key.slice(roomId.length+1)))items.push({kind:'worker',id:key.slice(roomId.length+1),status:'connecting',name:'成员',title:'接入握手'});
  for(const row of db.prepare("SELECT member_id,binding_state FROM chat_bindings WHERE room_id=? AND binding_state IN ('creating','creation_uncertain','outcome_uncertain','resume_uncertain')").all(roomId))items.push({kind:'binding',id:row.member_id,status:row.binding_state,name:service.chat.store.member(row.member_id).name,title:'工作记录待核对',external:row.binding_state!=='creating'});
  for(const row of db.prepare("SELECT n.message_id,n.status FROM chat_notifications n JOIN chat_messages m ON m.id=n.message_id WHERE m.room_id=? AND n.status='sending'").all(roomId))items.push({kind:'notification',id:row.message_id,status:row.status,name:'外部通知',title:'正在发送',external:true});
  if(table('team_records'))for(const row of db.prepare("SELECT id,kind,body FROM team_records WHERE room_id=? AND kind IN ('goal','task','meeting')").all(roomId)){let value;try{value=JSON.parse(row.body);}catch{}if(activeTeam(row.kind,value))items.push({kind:'team',id:row.id,status:value?.status||'unknown',name:({goal:'协作目标',task:'协作任务',meeting:'会议'})[row.kind],title:value?.title||'协作任务'});}
  const queries=[['launch_sessions',"SELECT id,status FROM launch_sessions WHERE room_id=? AND status='preparing'",'launch','成员接入准备'],['onboarding_runs',"SELECT id,status,provider AS name,stage AS title FROM onboarding_runs WHERE room_id=? AND status='running'",'onboarding','接入配置'],['team_outbox',"SELECT id,status FROM team_outbox WHERE room_id=? AND status IN ('pending','uncertain')",'outbox','协作派工'],['bridge_entries',"SELECT e.id,e.status FROM bridge_entries e JOIN bridge_bindings b ON b.id=e.binding_id WHERE b.room_id=? AND e.status NOT IN ('answered','delivered','failed','cancelled')",'bridge','外部协作请求'],['bridge_setup_tests',"SELECT id,status FROM bridge_setup_tests WHERE room_id=? AND status IN ('running','waiting','uncertain')",'bridge_test','本机接入测试']];
  for(const [name,sql,kind,label]of queries)if(table(name))for(const row of db.prepare(sql).all(roomId))items.push({kind,id:row.id,status:row.status,name:row.name||label,title:row.title||label,external:kind==='bridge'||row.status==='uncertain'});
  for(const [id,approval]of service.approvals){const requestId=approval.public?.request_id;if(requestId&&(db.prepare('SELECT 1 FROM chat_messages WHERE id=? AND room_id=?').get(requestId,roomId)||requestId.startsWith('connect:')&&service.chat.active.get(requestId.slice(8))?.roomId===roomId))items.push({kind:'approval',id,status:'waiting_input',name:'待确认操作',title:'本机授权请求'});}
  return items;
}
function deletionPreview(service,roomId){
  service.chat.store.room(roomId);
  const tasks=deletionTasks(service,roomId),token=crypto.randomBytes(24).toString('hex');
  let entries=confirmations.get(service);if(!entries){entries=new Map();confirmations.set(service,entries);}
  for(const [key,value]of entries)if(value.expires<Date.now())entries.delete(key);
  while(entries.size>=100)entries.delete(entries.keys().next().value);
  entries.set(token,{roomId,expires:Date.now()+10*60*1000,keys:new Set(tasks.map(task=>task.kind+':'+task.id))});
  return {room_id:roomId,tasks,total:tasks.length,confirmation_token:token,external_warning:tasks.some(task=>task.external)?'已经送达外部窗口或结果不明确的任务无法保证撤回；删除会停止本机处理，保留原始记录供核对。':null};
}
async function forceDeleteRoom(service,roomId,token){
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后删除房间。',503,'service_stopping');
  const confirmation=confirmations.get(service)?.get(token);
  if(!confirmation||confirmation.roomId!==roomId||confirmation.expires<Date.now())throw new RoomError('删除确认已失效，请重新查看当前任务并确认。',409,'room_delete_confirmation_expired');
  const db=service.store.db,stamp=now(),reason='用户确认停止本房间任务并删除；外部已送达或结果不明确的执行未宣称撤回。';
  // Check scope, cancel durable local work and revoke entrances under one write
  // lock, before yielding to stop processes. Late replies cannot revive a room.
  const result=service.chat.store.deleteRoom(roomId,()=>{
    if(deletionTasks(service,roomId).some(task=>!confirmation.keys.has(task.kind+':'+task.id)))throw new RoomError('房间新增了任务，请查看更新后的清单，再确认删除。',409,'room_delete_tasks_changed');
    db.prepare(`UPDATE chat_messages SET status='cancelled',error=? WHERE room_id=? AND ${pendingMessages}`).run(reason,roomId);
    db.prepare("UPDATE chat_notifications SET status='cancelled',error=?,updated=? WHERE message_id IN (SELECT id FROM chat_messages WHERE room_id=?) AND status='sending'").run(reason,stamp,roomId);
    db.prepare("UPDATE launch_sessions SET status='cancelled',error=?,updated=? WHERE room_id=? AND status='preparing'").run(reason,stamp,roomId);
    db.prepare("UPDATE onboarding_runs SET status='cancelled',stage='cancelled',error=?,updated=? WHERE room_id=? AND status='running'").run(reason,stamp,roomId);
    db.prepare("UPDATE bridge_entries SET status='cancelled',error=? WHERE binding_id IN (SELECT id FROM bridge_bindings WHERE room_id=?) AND status NOT IN ('answered','delivered','failed','cancelled')").run(reason,roomId);
    db.prepare("UPDATE bridge_setup_tests SET status='cancelled',error=?,updated=? WHERE room_id=? AND status IN ('running','waiting','uncertain')").run(reason,stamp,roomId);
    db.prepare("UPDATE team_outbox SET status='superseded',error=? WHERE room_id=? AND status IN ('pending','uncertain')").run(reason,roomId);
    for(const row of db.prepare("SELECT kind,body FROM team_records WHERE room_id=? AND kind IN ('goal','task','meeting','schedule')").all(roomId)){let value;try{value=JSON.parse(row.body);}catch{continue;}if(!value||typeof value!=='object'||!value.id)continue;if(row.kind==='schedule'||activeTeam(row.kind,value))service.team.save(value,row.kind==='schedule'?{enabled:false}:{status:'cancelled',cancellation_reason:reason},null,'room_force_delete');}
  },{force:true});
  if(result.already_deleted)return result;
  const stopped=[];
  for(const [memberId,active]of [...service.chat.active])if(active.roomId===roomId){const client=service.chat.clients.get(memberId);stopOwnedChildTree(client?.child);active.abort?.abort();service.chat.clients.delete(memberId);service.chat.connectedMembers.delete(memberId);service.runtime?.releaseWorker(`native:${memberId}`);service.runtime?.releaseSession(memberId,`native:${memberId}`);if(client)stopped.push(Promise.resolve().then(()=>client.close()));}
  for(const [messageId,notification]of service.chat.notifications)if(db.prepare('SELECT 1 FROM chat_messages WHERE id=? AND room_id=?').get(messageId,roomId))notification.abort.abort();
  for(const [id,approval]of service.approvals)if(confirmation.keys.has('approval:'+id)){try{approval.client?.rejectRequest?.(approval.rpcId);}catch{}service.approvals.delete(id);}
  service.bridge.cancelRoomTests?.(roomId);
  service.runtimeInstaller.cancelRoom?.(roomId);
  service.changed();await Promise.allSettled(stopped);
  return {...result,stopped_tasks:confirmation.keys.size,external_warning:reason};
}

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
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后删除房间。',503,'service_stopping');
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
  if(service.closing||service.chat.closing)throw new RoomError('服务正在停止，请稍后管理房间。',503,'service_stopping');
  const room=service.chat.store.setArchived(roomId,archived);service.changed();return room;
}
module.exports={deleteRoom,archiveRoom,deletionBlockers,settleInterruptedWork,deletionPreview,forceDeleteRoom,stopOwnedChildTree};
