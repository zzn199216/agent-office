'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,VERSION,livePid,sleep}=require('./util.cjs');
const {openDisk}=require('./entry.cjs');
const ROOM_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function roomInput(value){if(value!=null&&!ROOM_ID.test(value))throw new RoomError('聊天室标识无效。',400,'desktop_room_invalid');return value||null;}
function activity(state){
  const setup=state.activeSetup||{},busy={active_requests:state.activeRequest?1:0,active_messages:state.chat?.activeMessages?.length||0,approvals:state.approvals?.length||0,connecting:state.chat?.members?.filter(member=>member.status==='connecting').length||0,onboarding:setup.onboarding||0,runtime_installs:setup.runtime_installs||0,launch:setup.launch||0};
  return {...busy,is_busy:Object.values(busy).some(value=>value>0)};
}
function emptySnapshot(){return {version:VERSION,instance_id:null,runtime:{durable:true,service:{online:false,state:'not_initialized'},rooms:[],members:[]},chat:{rooms:[],members:[],activeMessages:[]},office:{},secretaries:{},activeSetup:{onboarding:0,runtime_installs:0,launch:0},projects:[],discussions:[],activeRequest:null,approvals:[],grok:{configured:false},codex:{connected:false},revision:0,exportError:null};}
function offlineState(dir,roomId){
  roomId=roomInput(roomId);
  if(!fs.existsSync(path.join(dir,'room.sqlite')))return {running:false,url:null,initialized:false,busy:activity({}),snapshot:emptySnapshot(),history:null,selected_room_id:null};
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
    return {running:false,url:null,initialized:true,busy:activity({}),snapshot,history,selected_room_id:selected};
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
  const selected=roomInput(input.room_id)||snapshot.chat.rooms[0]?.id||null,history=selected?await main.apiCall(dir,'/api/chat/rooms/'+selected,undefined,5000):null;
  return {running:true,url:control.url,initialized:true,busy:activity(snapshot),snapshot,history,selected_room_id:selected};
}
async function desktopStart(dir,input={},options={}){roomInput(input.room_id);const main=options.main||require('./main.cjs');await main.ensureServer(dir);return desktopState(dir,input,{...options,main});}
async function desktopStop(dir,input={},options={}){
  const main=options.main||require('./main.cjs'),state=await desktopState(dir,input,{...options,main});if(!state.running)return state;
  if(state.busy.is_busy)throw new RoomError('仍有任务或安装正在进行。请先结束或取消这些任务，再停止服务。',409,'desktop_service_busy');
  const control=main.readControl(dir);await main.apiCall(dir,'/api/shutdown',{idle_only:true},5000);
  const alive=options.isPidAlive||livePid,pause=options.sleep||sleep;
  for(let i=0;i<100&&alive(control.pid);i++)await pause(100);
  if(alive(control.pid))throw new RoomError('服务正在结束本轮清理，请稍后检查状态。',409,'desktop_stop_pending');
  return offlineState(dir,input.room_id);
}
module.exports={activity,offlineState,desktopState,desktopStart,desktopStop};
