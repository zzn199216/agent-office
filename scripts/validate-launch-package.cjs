'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const {dataDirectory}=require('../src/util.cjs');
const {apiCall}=require('../src/main.cjs');
function cli(exe,args){return new Promise((resolve,reject)=>{const child=spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('本机验证超时；核对已保存请求，不重放。'));},190000);child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);if(code!==0)return reject(new Error((out||err).slice(-1200)));try{resolve(JSON.parse(out));}catch(e){reject(e);}});});}
async function main(){const dir=dataDirectory(),exe=path.join(dir,'bin','AgentRoom.exe'),before=await apiCall(dir,'/api/chat/state');
 const state=await cli(exe,['auto-connect','--providers','codex','--install-clients','--wait','90']);
 const proxy=state.proxies.find(p=>p.provider==='codex');assert(proxy?.local_verified,'Codex must really complete its native handshake');
 const first=await apiCall(dir,'/api/chat/state'),roomBefore=await apiCall(dir,`/api/chat/rooms/${state.room_id}`),threadBefore=roomBefore.participants.find(m=>m.id===proxy.backend_member_id)?.native_thread_id;
 const key='package-fixed-proxy-'+crypto.randomUUID(),file=path.join(dir,'validation',key+'.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'这是用户授权的新版本本机通信验收。只用一句中文确认你通过 AgentRoom 收到了问询。不读取文件、运行工具、修改项目或对外发消息。','utf8');
 const entry=path.join(dir,'entries',`${proxy.proxy_member_id}-${proxy.room_id}.json`);
 const result=await cli(exe,['delegate','--entry',entry,'--file',file,'--key',key,'--wait','150']);assert.equal(result.status,'answered');assert(result.answer.trim());assert(!/\[AgentRoom AR-[^\]]+\]/.test(result.answer),'ordinary proxy answer must not have legacy verification footer');
 const again=await cli(exe,['auto-connect','--providers','codex','--install-clients','--wait','90']);assert.equal(again.room_id,state.room_id);const p=again.proxies.find(p=>p.provider==='codex');assert.equal(p.id,proxy.id);assert.equal(p.backend_member_id,proxy.backend_member_id);assert.equal(p.proxy_member_id,proxy.proxy_member_id);
 const after=await apiCall(dir,'/api/chat/state'),roomAfter=await apiCall(dir,`/api/chat/rooms/${state.room_id}`);assert.equal(after.rooms.length,first.rooms.length);assert.equal(after.members.length,first.members.length);
 for(const old of before.rooms)assert(after.rooms.some(r=>r.id===old.id));for(const old of before.members)assert(after.members.some(m=>m.id===old.id));const thread=roomAfter.participants.find(m=>m.id===proxy.backend_member_id)?.native_thread_id;assert.equal(thread,threadBefore);
 const sync1=await cli(exe,['group-sync','--changes-only','--room',state.room_id]),sync2=await cli(exe,['group-sync','--changes-only','--room',state.room_id]);assert.equal(sync1.status,'automatic_sync_disabled');assert.equal(sync2.status,'automatic_sync_disabled');
 const evidence={version:require('../package.json').version,real_native_codex:true,real_grok_execution:false,computer_use:false,operator_used_existing_proxy:true,status:result.status,answer:result.answer,request_id:result.request_id,room_id:state.room_id,proxy_id:proxy.id,backend_member_id:proxy.backend_member_id,proxy_member_id:proxy.proxy_member_id,native_thread_id:thread,installation:p.installation,repeat_reused:true,no_duplicates_on_repeat:true,old_rooms_and_members_preserved:true,watch_enabled:again.watch?.enabled,native_sync_status:again.native_sync.status,legacy_sync_disabled:sync1.changed===false&&sync2.changed===false,grok_verified:false};
 fs.writeFileSync(path.resolve(__dirname,'../output/validation/package-launch-current.json'),JSON.stringify(evidence,null,2));
 fs.mkdirSync(path.resolve(__dirname,'../.local'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../.local/GROK_SIMPLE_SETUP.md'),again.grok_prompt+'\n');
 console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
