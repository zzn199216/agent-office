'use strict';
const fs=require('node:fs');
const {RoomError,redact}=require('./util.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safe=value=>redact(value).replace(/https?:\/\/[^\s<>"']+/gi,'[地址已隐藏]').replace(/(?:secret|token|key)\s*[:=]\s*[^\s,;]+/gi,'凭据=[已隐藏]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300);
function identifier(value,label){if(value==null||value==='')return null;if(typeof value!=='string'||!UUID.test(value))throw new RoomError(`${label}格式无效。`,400,'diagnostic_identifier_invalid');return value;}
function table(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}

// Observation only: never scan, issue a credential, renew a heartbeat, create a
// proxy, retry a request or contact Grok. The HTTP caller is the local controller.
function connectionDoctor(service,input={},context={}){
  const roomId=identifier(input.room_id,'房间标识'),memberId=identifier(input.member_id,'成员标识'),db=service.store.db;
  const room=roomId?db.prepare('SELECT id,title FROM chat_rooms r WHERE id=? AND NOT EXISTS (SELECT 1 FROM chat_room_tombstones t WHERE t.room_id=r.id)').get(roomId):null;
  const participants=room?db.prepare('SELECT m.id,m.name,m.adapter,m.status,m.verified_at FROM chat_participants p JOIN chat_members m ON m.id=p.member_id WHERE p.room_id=? AND p.joined=1 ORDER BY p.joined_at,m.id').all(roomId).map(row=>({id:row.id,name:safe(row.name),adapter:safe(row.adapter),registered_status:safe(row.status),handshake_recorded:!!row.verified_at})):[];
  const joined=memberId?participants.find(member=>member.id===memberId):null;
  // An ID from another room must not reveal that room or member's private data.
  const memberExists=room&&memberId?!!db.prepare('SELECT 1 FROM chat_members WHERE id=?').get(memberId):false;
  const entry={exists:false,credential_status:memberId?'missing':'not_selected',credential_valid:false};
  let observed=null;
  if(room&&joined){
    const description=service.entry.describe(memberId,roomId);
    entry.exists=!!description.file&&fs.existsSync(description.file);
    entry.credential_status=['pending','active','revoked','missing','invalid'].includes(description.status)?description.status:'invalid';
    entry.credential_valid=entry.exists&&description.available===true&&['pending','active'].includes(entry.credential_status);
    const runtime=service.runtime.memberState(memberId);
    observed={presence:['online','stale','offline','unknown'].includes(runtime.presence)?runtime.presence:'unknown',worker_online:runtime.worker_online===true,can_wake:runtime.can_wake===true};
  }
  let notification={configured:false,status:'not_configured'};
  try{const status=service.vault.status();notification={configured:status.configured===true,status:status.configured===true?'configured':'not_configured'};}catch{notification={configured:false,status:'unavailable'};}
  notification.detail='Webhook 只用于本机主动通知 Grok 的指定例程，不能证明 Grok 的 Windows 本机宿主已连接。';
  let reported=0,referenceSaved=false;
  if(room&&table(db,'launch_proxies')){
    const rows=db.prepare('SELECT native_group_status,native_group_ref FROM launch_proxies WHERE room_id=?').all(roomId);
    reported=rows.filter(row=>row.native_group_status==='host_reported').length;
    referenceSaved=rows.some(row=>typeof row.native_group_ref==='string'&&row.native_group_ref.length>0);
  }
  const targetStatus=!memberId?'not_selected':!room?'room_unavailable':!memberExists?'missing_member':!joined?'not_in_room':!entry.credential_valid?'entry_unavailable':joined.handshake_recorded?'handshake_recorded':'awaiting_handshake';
  const targetDetail={not_selected:'可选择本房间成员，或核对旧接入说明中的成员标识。',room_unavailable:'先选择存在的房间，再核对成员入口。',missing_member:'这份说明中的成员不在当前实例中。请重新选择本房间的真实成员，再打开它的恢复或接入说明；不会创建替代房间。',not_in_room:'这个成员没有加入所选房间；诊断不会切换到它的其他房间或替你加入。',entry_unavailable:'成员在本房间，但长期入口缺失、已撤销或无效。请从这个成员的恢复或接入页面核对。',handshake_recorded:'本机有真实接入记录；近期通信和后台工作状态仍分别核对，不能据此证明 Grok 宿主在线。',awaiting_handshake:'本机入口可用，但仍需要这个成员在本人窗口实际调用工具完成握手。'}[targetStatus];
  const result={read_only:true,observed_at:new Date().toISOString(),status:!roomId?'choose_room':!room?'missing_room':targetStatus==='missing_member'?'missing_member':'observed',
    local_service:{online:context.online===true,status:context.online===true?(service.closing?'stopping':'online'):'unknown',evidence:context.online===true?'controller_http_response':'not_observed',instance_id:service.runtime.instanceId,data_directory:service.store.dir},
    room:{requested_id:roomId,exists:!!room,...room?{id:room.id,title:safe(room.title)}:{},member_count:participants.length},
    target:{requested_member_id:memberId,exists:memberExists,joined:!!joined,status:targetStatus,detail:targetDetail,...joined?{id:joined.id,name:joined.name,adapter:joined.adapter,handshake_recorded:joined.handshake_recorded,observation:observed}:{}},
    current_participants:participants,entry,
    grok_notification:notification,
    grok_windows_host:{status:'check_in_grok',verified:false,detail:'请在 Grok 内核对注册的 Windows 电脑是否连接并获授权。本机服务无法读取或修复 Grok 的宿主状态。'},
    grok_group:{status:reported?'host_reported':'not_reported',reference_saved:referenceSaved,host_reported_count:reported,independently_verified:false,detail:reported?'这里只保存了宿主报告的加群记录，实际目标群、Bot 身份和加群工具仍须在 Grok 内核对。':'本机没有保存这个房间的加群成功报告。请在 Grok 指定真实目标群，并核对原生建群或加群工具是否可用。'},
    next_actions:room&&joined?[{operation:'open_resume',label:'查看该成员恢复入口',member_id:memberId,room_id:roomId},{operation:'open_member_setup',label:'查看该成员接入说明',member_id:memberId,room_id:roomId}]:room?[{operation:'select_current_member',label:'重新选择本房间成员',room_id:roomId}]:[{operation:'choose_room',label:'先选择一个聊天室'}]};
  result.summary=[`本机服务：${result.local_service.online?'在线':'未核实'}；实例 ${result.local_service.instance_id}。`,room?`房间：${safe(room.title)}（${roomId}），${participants.length} 位实际成员。`:'房间：'+(roomId?'当前实例中不存在，请核对原房间。':'尚未选择。'),memberId?`目标成员：${joined?joined.name:targetStatus==='missing_member'?'当前实例中不存在':'未加入所选房间'}（${memberId}）。`:'目标成员：尚未选择。',`长期入口：${entry.exists?'文件存在':'未找到或尚未选择'}；凭据 ${entry.credential_status}。`,`Grok Windows 宿主：需要在 Grok 内核对。`,`Grok 群：${reported?'只有宿主报告，未独立核验':'未保存加群成功报告'}。`,`通知 Webhook：${notification.status==='unavailable'?'无法读取':notification.configured?'已配置':'未配置'}；与 Windows 宿主连接是两条链路。`].join('\n');
  return result;
}
module.exports={connectionDoctor};
