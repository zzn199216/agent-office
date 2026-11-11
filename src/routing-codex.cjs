'use strict';
const {RoomError,normalizePath,id}=require('./util.cjs');
// Thread-scoped overrides: never change the person's working thread or config.
function routingConfig(current){
  const config={web_search:'disabled',project_doc_max_bytes:0,'apps._default.enabled':false,'features.shell_tool':false,'features.view_image':false,'features.multi_agent':false,'features.memories':false,'features.hooks':false,'features.apps':false,'features.remote_plugin':false,'features.js_repl':false};
  for(const server of Object.keys(current.mcp_servers||{})){if(!/^[a-zA-Z0-9_-]+$/.test(server))throw new RoomError('当前工具配置不能安全隔离，请直接选择负责人。',409,'group_tools_not_disabled');config[`mcp_servers.${server}.enabled`]=false;}
  return config;
}
async function lightweight(client,{directory,session={},prompt,instructions,signal,timeout=45000,onSession=()=>{}}){
  if(signal?.aborted)throw new RoomError('分派已停止。',409,'cancelled');
  await client.ready();const current=(await client.call('config/read',{includeLayers:false})).config||{};
  const config=routingConfig(current);let threadId=session.thread_id;
  if(threadId){const thread=await client.read(threadId);if(normalizePath(thread.cwd)!==normalizePath(directory))throw new RoomError('分派会话目录不匹配，请检查房间分派设置。',409,'group_session_mismatch');await client.call('thread/resume',{threadId,cwd:directory,config,approvalPolicy:'never',sandbox:'read-only',excludeTurns:true});}
  else{const result=await client.call('thread/start',{cwd:directory,config,approvalPolicy:'never',sandbox:'read-only',baseInstructions:instructions,developerInstructions:'',dynamicTools:[],environments:[],selectedCapabilityRoots:[],runtimeWorkspaceRoots:[]});threadId=result.thread.id;onSession({thread_id:threadId});}
  client.transport?.registerThread(threadId);
  let turnId,settled=false,timer;const answers=new Map();let resolve,reject;
  const ended=new Promise((yes,no)=>{resolve=yes;reject=no;});ended.catch(()=>{});
  const finish=(error,value)=>{if(settled)return;settled=true;error?reject(error):resolve(value);};
  const stop=()=>{if(turnId)client.call('turn/interrupt',{threadId,turnId},1000).catch(()=>{});finish(new RoomError('分派未完成，请手动选择负责人。',409,'outcome_uncertain'));};
  const events=m=>{const p=m.params||{};if(p.threadId!==threadId)return;
    if(m.method==='turn/started')turnId=p.turn?.id;
    if(m.method==='item/started'&&!['userMessage','agentMessage','reasoning','compaction','plan'].includes(p.item?.type)){stop();return;}
    if(m.method==='item/completed'&&p.item?.type==='agentMessage')answers.set(p.item.id,p.item.text||'');
    if(m.method==='turn/completed'){if(p.turn.status==='completed')finish(null,[...answers.values()].at(-1)||'');else finish(new RoomError('分派没有完成，请选择负责人。',502,'group_route_failed'));}
  };
  const requests=m=>{if(m.params?.threadId!==threadId)return;client.rejectRequest(m.id,{code:-32601,message:'Routing has no tools or approvals.'});stop();};
  const disconnected=()=>finish(new RoomError('分派连接已断开，请选择负责人。',503,'connection_lost'));
  client.on('notification',events);client.on('request',requests);client.on('disconnected',disconnected);signal?.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,timeout);
  try{
    if(signal?.aborted)stop();if(settled)return await ended;
    const started=client.call('turn/start',{threadId,clientUserMessageId:id(),input:[{type:'text',text:prompt}],approvalPolicy:'never',sandboxPolicy:{type:'readOnly'},environments:[],runtimeWorkspaceRoots:[]},timeout).then(result=>{turnId=result.turn.id;return ended;});
    return await Promise.race([started,ended]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);client.off('notification',events);client.off('request',requests);client.off('disconnected',disconnected);}
}
module.exports={lightweight,routingConfig};
