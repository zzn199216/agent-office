'use strict';
const {RoomError}=require('./util.cjs');
const MANAGED=new Set(['codex','claude-code','qwen-code','gemini-cli']);
function matches(member,provider){return member.config?.launch_provider===provider||MANAGED.has(provider)&&member.adapter===provider||provider==='grok-bot'&&member.adapter==='grok-bridge';}
function credentials(service,member){const rows=service.resume?.credentials(member.id)||[],usableRows=rows.filter(row=>row.status!=='revoked'&&service.chat.store.joined(row.room_id,member.id));let available=usableRows.length>0,active=usableRows.some(row=>row.status==='active');
  if(available&&service.entry?.describePrimary){const preferred=usableRows[0].room_id,description=service.entry.describePrimary(member.id,preferred);available=description.available;active=available&&description.status==='active';}
  return {rows,blocked:rows.length>0&&rows.every(row=>row.status==='revoked'),active,available};}
function fixedProxy(service,memberId){return service.store.db.prepare('SELECT room_id,backend_member_id FROM launch_proxies WHERE proxy_member_id=? ORDER BY created,id LIMIT 1').get(memberId)||null;}
function usable(service,member){const credential=credentials(service,member);return !credential.blocked&&!!member.verified_at&&!member.error&&!['connection_failed','disabled','revoked','unavailable'].includes(member.status);}
function resolveConnectionTarget(service,{provider,room_id:roomId,target_member_id:explicit}={}){
  const chat=service.chat.store;chat.room(roomId);
  const bound=service.store.db.prepare('SELECT backend_member_id FROM launch_proxies WHERE room_id=? AND provider=?').get(roomId,provider);
  let member,reason;
  if(explicit){member=chat.member(explicit);if(!matches(member,provider))throw new RoomError('所选人物与接入客户端不一致。',409,'connection_target_mismatch');if(bound&&bound.backend_member_id!==member.id)throw new RoomError('当前接入已有固定人物，不能静默替换。',409,'connection_target_mismatch');const fixed=fixedProxy(service,member.id);if(fixed&&fixed.room_id!==roomId)throw new RoomError('固定代理不能改绑到另一个房间。',403,'proxy_not_bound');reason='explicit';}
  else if(bound){member=chat.member(bound.backend_member_id);reason='bound_route';}
  else{
    const rank=(a,b)=>(usable(service,b)-usable(service,a))||(credentials(service,b).active-credentials(service,a).active)||String(b.verified_at||b.updated||'').localeCompare(String(a.verified_at||a.updated||''))||String(a.id).localeCompare(String(b.id));
    const seated=chat.participants(roomId).filter(value=>matches(value,provider));
    member=seated.filter(value=>usable(service,value)).sort(rank)[0];reason='current';
    if(!member){member=chat.members().filter(value=>matches(value,provider)&&!chat.joined(roomId,value.id)&&!fixedProxy(service,value.id)&&usable(service,value)).sort(rank)[0];reason='reusable';}
    if(!member){member=seated.sort(rank)[0];reason='current';}
    // A verified revoked identity is retained when it is the only known
    // person, rather than silently creating a replacement for explicit intent.
    if(!member){member=chat.members().filter(value=>matches(value,provider)&&value.verified_at&&!fixedProxy(service,value.id)).sort(rank)[0];reason='historical';}
    if(!member){member=chat.members().filter(value=>matches(value,provider)&&fixedProxy(service,value.id)).sort(rank)[0];reason='fixed_proxy';}
  }
  if(!member)return {member:null,member_id:null,reason:'new',blocked:false,reused_connection:false};
  const credential=credentials(service,member),joined=chat.joined(roomId,member.id);
  return {member,member_id:member.id,reason,blocked:credential.blocked,credential_active:credential.active,credential_available:credential.available,
    joined,fixed_proxy:fixedProxy(service,member.id),reused_connection:usable(service,member)&&(credential.active||MANAGED.has(provider)&&credential.available)};
}
function existingConnectionState(service,provider,roomId,target){
  const member=target.member,base={member_id:target.member_id,name:member?.name,reused_connection:target.reused_connection===true,verification_scope:'existing_connection',selection_reason:target.reason,fixed_proxy:target.fixed_proxy||null,local_verified:false,can_wake:false};
  if(target.fixed_proxy&&target.fixed_proxy.room_id!==roomId)return {...base,status:'needs_action',stage:'fixed_proxy_scope',detail:'此连接是固定群桥接，原后端路由保留，不能作为独立跨房人物复用。没有创建替代人物。'};
  if(target.blocked)return {...base,status:'needs_action',stage:'awaiting_credential'};
  if(!target.joined||!target.reused_connection)return {...base,status:'needs_action',stage:'awaiting_connection'};
  const native=service.desktop?.row(member.id);
  if(['qwen-desktop','doubao'].includes(provider)&&native?.native_session_id&&!service.desktop.canWake(member.id))return {...base,status:'needs_action',stage:'awaiting_native_desktop',response_mode:'managed_desktop',detail:'保留原生对话，等待恢复实际连接；没有降级成手动信箱或创建替代窗口。',next_actions:[{operation:'native_desktop_connect',target_member_id:member.id}]};
  const runtime=service.runtime.memberState(member.id),delivery=service.chat.deliveryCapability?.(member),canWake=delivery?delivery.can_wake:runtime.can_wake===true;
  return {...base,status:'ready',stage:canWake?'ready_automatic':'ready_mailbox',local_verified:true,can_wake:canWake,can_notify:delivery?.can_notify===true,connection_method:delivery?.connection_method||null,response_mode:MANAGED.has(provider)?'managed_native':delivery?.connection_method==='native_desktop'?'managed_desktop':'manual_bridge',error:null,detail:'已加入办公室，沿用已有连接与配置；没有重新验证。',next_actions:[]};
}
module.exports={MANAGED,matches,credentials,fixedProxy,usable,resolveConnectionTarget,existingConnectionState};
