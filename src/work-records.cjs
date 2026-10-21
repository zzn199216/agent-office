'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RoomError,atomicWrite,normalizePath,redact}=require('./util.cjs');
const UUID=/^[a-f0-9-]{36}$/i;
function safe(value){
  if(typeof value==='string')return redact(value).replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[凭据已隐藏]');
  if(Array.isArray(value))return value.map(safe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(?:access_?token|refresh_?token|api_?key|authorization|password|secret|nonce)$/i.test(key)?'[凭据已隐藏]':safe(item)]));
  return value;
}
function publicItem(item){
  const type=item.type;
  if(type==='agentMessage')return {type,text:safe(item.text||''),phase:item.phase||null};
  if(type==='userMessage')return {type,text:safe((item.content||[]).filter(v=>v.type==='text').map(v=>v.text||'').join('\n'))};
  if(type==='commandExecution')return safe({type,command:item.command||'',cwd:item.cwd||'',status:item.status,exitCode:item.exitCode,output:item.aggregatedOutput||''});
  if(type==='mcpToolCall')return safe({type,server:item.server,tool:item.tool,status:item.status,arguments:item.arguments,result:item.result,error:item.error});
  if(type==='fileChange')return safe({type,status:item.status,changes:item.changes||[]});
  if(type==='webSearch')return safe({type,query:item.query,action:item.action});
  return null;
}
function markdown(record){
  const lines=['# '+record.title,'',`项目：${record.project_name}`,`成员：${record.member_name}`,`保存会话：${record.thread_id}`,'','此文件是已有工作记录的只读导出。查看没有启动模型或重新执行任务。',''];
  for(const turn of record.turns){lines.push(`## 工作轮次 ${turn.id}`,`状态：${turn.status}`,'');for(const item of turn.items){lines.push(`### ${item.type}`,'');const text=item.text??JSON.stringify(item,null,2);let fence='```';while(text.includes(fence))fence+='`';lines.push(fence+'text',text,fence,'');}}
  return lines.join('\n');
}
function binding(store,chat,input){
  if(input.discussion_id){if(!UUID.test(input.discussion_id)||input.room_id||input.member_id)throw new RoomError('工作记录查询范围无效。');const discussion=store.discussion(input.discussion_id);return {project:store.project(discussion.project_id),discussion,member:null};}
  if(!UUID.test(input.room_id||'')||!UUID.test(input.member_id||''))throw new RoomError('请选择房间和成员。');
  const room=chat.room(input.room_id),member=chat.member(input.member_id);chat.requireParticipant(room.id,member.id);
  if(!['codex','native'].includes(member.adapter))throw new RoomError('这个成员没有 Codex 原生工作记录；可以查看房间中的回复。',409,'work_record_adapter');
  return {project:store.project(room.project_id),discussion:{id:room.id,title:`${room.title} · ${member.name}`,...chat.binding(room.id,member.id)},member};
}
async function exportWorkRecord(store,chat,input,options={}){
  const selected=binding(store,chat,input),{project,discussion,member}=selected;
  if(!discussion.thread_id)throw new RoomError('这个成员还没有保存的 Codex 工作记录。',404,'work_record_missing');
  let client=options.client,owned=false;
  if(!client){const {CodexClient}=require('./codex.cjs');client=new CodexClient({dataDir:store.dir,executable:member?.config?.executable||store.setting('codex_path')||undefined,args:member?.config?.executable_args||[],legacyHome:options.legacyHome,authenticationMode:'shared-cache'});owned=true;}
  try{
    const thread=client.inspectBound?await client.inspectBound(project,discussion):await client.read(discussion.thread_id);
    if(!thread||thread.id!==discussion.thread_id||!thread.cwd||normalizePath(thread.cwd)!==project.canonical)throw new RoomError('工作记录与已登记项目或会话不匹配。',409,'project_mismatch');
    const record={title:discussion.title,project_name:project.name,member_name:member?.name||'Codex',thread_id:thread.id,read_only:true,turns:(thread.turns||[]).map(turn=>({id:turn.id,status:turn.status,items:(turn.items||[]).map(publicItem).filter(Boolean)}))};
    const folder=path.join(store.dir,'work-records',discussion.id),file=path.join(folder,(member?.id||discussion.id)+'.md');
    for(const directory of [path.join(store.dir,'work-records'),folder]){if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw new RoomError('工作记录保存目录不能是链接。',409,'work_record_path');fs.mkdirSync(directory,{recursive:true});}
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new RoomError('工作记录文件不能是链接。',409,'work_record_path');
    atomicWrite(file,markdown(record));return {...record,path:file};
  }finally{if(owned)await client.close();}
}
async function offlineWorkRecord(dir,input){const {Store}=require('./store.cjs'),{ChatStore}=require('./chat-store.cjs');const store=new Store(dir,{readOnly:true});try{return await exportWorkRecord(store,new ChatStore(store,{readOnly:true}),input);}finally{store.close();}}
module.exports={exportWorkRecord,offlineWorkRecord,publicItem,markdown};
