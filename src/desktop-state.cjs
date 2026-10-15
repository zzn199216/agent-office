'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,VERSION,livePid,sleep}=require('./util.cjs');
const {openDisk}=require('./entry.cjs');
const {readTeamSnapshot}=require('./desktop-team.cjs');
const ROOM_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function olderVersion(actual,expected=VERSION){
  const parse=value=>/^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?(?:\+[A-Za-z0-9.-]+)?$/.exec(value||'');
  const a=parse(actual),b=parse(expected);if(!a||!b)return false;
  for(let i=1;i<=3;i++){if(!Number.isSafeInteger(Number(a[i]))||!Number.isSafeInteger(Number(b[i])))return false;if(Number(a[i])!==Number(b[i]))return Number(a[i])<Number(b[i]);}
  if(!a[4]||!b[4])return !!a[4]&&!b[4];
  const x=a[4].split('.'),y=b[4].split('.');for(let i=0;i<Math.max(x.length,y.length);i++){if(x[i]===y[i])continue;if(x[i]===undefined||y[i]===undefined)return x[i]===undefined;const xn=/^\d+$/.test(x[i]),yn=/^\d+$/.test(y[i]);if(xn&&yn)return BigInt(x[i])<BigInt(y[i]);if(xn!==yn)return xn;return x[i]<y[i];}return false;
}
function roomInput(value){if(value!=null&&!ROOM_ID.test(value))throw new RoomError('聊天室标识无效。',400,'desktop_room_invalid');return value||null;}
function activity(state){
  const setup=state.activeSetup||{},busy={active_requests:state.activeRequest?1:0,active_messages:state.chat?.activeMessages?.length||0,approvals:state.approvals?.length||0,connecting:state.chat?.members?.filter(member=>member.status==='connecting').length||0,onboarding:setup.onboarding||0,runtime_installs:setup.runtime_installs||0,launch:setup.launch||0};
  return {...busy,is_busy:Object.values(busy).some(value=>value>0)};
}
function emptySnapshot(){return {version:VERSION,instance_id:null,runtime:{durable:true,service:{online:false,state:'not_initialized'},rooms:[],members:[]},chat:{rooms:[],members:[],activeMessages:[]},office:{},secretaries:{},activeSetup:{onboarding:0,runtime_installs:0,launch:0},projects:[],discussions:[],activeRequest:null,approvals:[],grok:{configured:false},codex:{connected:false},revision:0,exportError:null};}
function offlineState(dir,roomId){
  roomId=roomInput(roomId);
  if(!fs.existsSync(path.join(dir,'room.sqlite')))return {running:false,url:null,initialized:false,client_version:VERSION,busy:activity({}),snapshot:emptySnapshot(),history:null,team:null,selected_room_id:null};
  const disk=openDisk(dir,{readOnly:true});
  try{
    const runtime=disk.runtime.offlineSnapshot(),rooms=disk.chat.rooms(),members=disk.chat.members();
    // UI availability follows the transport observation; the persisted worker
    // and member evidence is retained independently in runtime.members.
    runtime.service={...runtime.service,online:false,state:'stopped'};
    const publicMember=member=>({id:member.id,name:member.name,adapter:member.adapter,status:member.status,error:member.error,verified_at:member.verified_at,created:member.created,updated:member.updated,last_seen:member.config.last_seen||null,runtime_state:disk.runtime.memberState(member.id),appearance:require('./appearance.cjs').storedAppearance(disk.store,member),capabilities:['room-history','inbox','reply',...(disk.runtime.memberState(member.id).can_wake?['native-session','automatic-wakeup']:[])]});
    const selected=roomId||rooms[0]?.id||null;
    let history=null;
    if(selected){const room=disk.chat.room(selected),participants=disk.chat.participants(selected).map(member=>({...publicMember(member),native_thread_id:disk.chat.binding(selected,member.id).thread_id})),messages=disk.store.db.prepare('SELECT * FROM chat_messages WHERE room_id=? ORDER BY seq DESC LIMIT 200').all(selected).reverse().map(row=>disk.chat.publicMessage(row));history={room,participants,messages,approvals:[]};}
    const snapshot={...emptySnapshot(),instance_id:runtime.instance_id,runtime,chat:{rooms,members:members.map(publicMember),activeMessages:[]},office:require('./office-settings.cjs').officeSnapshot(disk.store,rooms),secretaries:require('./secretary.cjs').secretarySnapshot(disk.store,disk.chat,disk.runtime,rooms,{offline:true}),projects:disk.store.projects(),discussions:disk.store.discussions(),dataDirectory:dir};
    return {running:false,url:null,initialized:true,client_version:VERSION,busy:activity({}),snapshot,history,team:selected?readTeamSnapshot(disk,selected):null,selected_room_id:selected};
  }finally{disk.close();}
}
async function desktopState(dir,input={},options={}){
  const offline=offlineState(dir,input.room_id),main=options.main||require('./main.cjs'),control=main.readControl(dir);
  if(!control)return offline;
  let snapshot;
  try{snapshot=await main.apiCall(dir,'/api/state',undefined,5000);}catch(error){
    if([401,403].includes(error.status))throw new RoomError('本机服务身份与桌面入口不一致，未连接另一个实例。',409,'instance_control_mismatch');
    return {...offline,connection_error:'暂时无法联系本机服务。已保存的聊天仍可查看。'};
  }
  if(!offline.initialized||snapshot.instance_id!==offline.snapshot.instance_id||control.instance_id!==snapshot.instance_id)throw new RoomError('本机服务与原聊天室身份不一致，未打开替代实例。',409,'instance_control_mismatch');
  const selected=roomInput(input.room_id)||snapshot.chat.rooms[0]?.id||null;
  const [history,team]=selected?await Promise.all([main.apiCall(dir,'/api/chat/rooms/'+selected,undefined,5000),main.apiCall(dir,'/api/team?room_id='+encodeURIComponent(selected),undefined,5000)]):[null,null];
  const busy=activity(snapshot),update=olderVersion(snapshot.version);
  return {running:true,url:control.url,initialized:true,busy,snapshot,history,team,selected_room_id:selected,client_version:VERSION,update_available:update,can_update:update&&!busy.is_busy};
}
async function desktopStart(dir,input={},options={}){
  roomInput(input.room_id);const main=options.main||require('./main.cjs'),before=await desktopState(dir,input,{...options,main});
  if(before.update_available){
    if(before.busy.is_busy)throw new RoomError('旧后台正在处理任务。先完成或停止当前工作，再更新后台；没有中断任务。',409,'desktop_update_busy');
    await desktopStop(dir,input,{...options,main});
  }
  await main.ensureServer(dir);const after=await desktopState(dir,input,{...options,main});
  if(after.update_available)throw new RoomError('后台仍是旧版本，更新尚未完成。请保留房间记录并重试更新后台。',409,'desktop_update_incomplete');
  return after;
}
async function desktopStop(dir,input={},options={}){
  const main=options.main||require('./main.cjs'),state=await desktopState(dir,input,{...options,main});if(!state.running)return state;
  if(state.busy.is_busy)throw new RoomError('仍有任务或安装正在进行。请先结束或取消这些任务，再停止服务。',409,'desktop_service_busy');
  const control=main.readControl(dir);await main.apiCall(dir,'/api/shutdown',{idle_only:true},5000);
  const alive=options.isPidAlive||livePid,pause=options.sleep||sleep;
  for(let i=0;i<100&&alive(control.pid);i++)await pause(100);
  if(alive(control.pid))throw new RoomError('服务正在结束本轮清理，请稍后检查状态。',409,'desktop_stop_pending');
  return offlineState(dir,input.room_id);
}
module.exports={activity,offlineState,desktopState,desktopStart,desktopStop,olderVersion};
