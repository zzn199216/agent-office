'use strict';
// User-invoked consumer Qwen 1.0.3 persistence, not GUI activation or a model
// handshake. Never log the authorized MCP URL, read chat/cookies, or execute IPC.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {dataDirectory,atomicWrite}=require('../src/util.cjs');
const {apiCall}=require('../src/main.cjs');
async function main(){
 const dir=dataDirectory(),state=await apiCall(dir,'/api/launch/state'),proxy=state.proxies.find(p=>p.provider==='qwen-desktop');
 if(!proxy)throw new Error('请先明确选择 Qwen 桌面端准备成员入口。');
 const installation=proxy.installation,importFile=installation?.configuration_file,expected=path.join(dir,'client-config','qwen-desktop',`${proxy.room_id}-${proxy.backend_member_id}.json`);
 if(typeof importFile!=='string'||path.resolve(importFile)!==path.resolve(expected))throw new Error('Qwen 导入文件与该成员入口不匹配。');
 const config=JSON.parse(fs.readFileSync(importFile,'utf8')),server=config.mcpServers?.agentroom;
 if(server?.type!=='streamable-http')throw new Error('需要已生成的本机 Streamable HTTP MCP 配置。');
 const url=new URL(server.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('只配置本机 AgentRoom 地址。');
 // Protocol checks are not Qwen model calls and cannot accept a member identity.
 async function rpc(payload,session){const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-03-26'}:{}},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error('本机 MCP 协议检查失败，尚未更改 Qwen 配置。');return {res,value:res.status===202?null:await res.json()};}
 const init=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'agentroom-local-config-validation',version:'1'}}}),session=init.res.headers.get('mcp-session-id');
 await rpc({jsonrpc:'2.0',method:'notifications/initialized'},session);
 const list=await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},session),names=list.value?.result?.tools?.map(t=>t.name)||[];
 assert(names.includes('agentroom_room_ensure'));assert(names.includes('agentroom_heartbeat'));
 const qwenDir=path.join(process.env.USERPROFILE,'AppData','Roaming','Qwen'),file=path.join(qwenDir,'settings.json');
 if(!fs.existsSync(qwenDir))throw new Error('Qwen 的实际用户配置目录不存在，没有另建未知配置。');
 const raw=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'{}',before=JSON.parse(raw);
 if(!before||typeof before!=='object'||Array.isArray(before)||before.mcp_config&&(!before.mcp_config||typeof before.mcp_config!=='object'||Array.isArray(before.mcp_config)))throw new Error('Qwen 配置结构无法安全合并。');
 const desired={name:'agentroom',url:server.url,transportType:'httpStream'},old=before.mcp_config?.agentroom;
 if(old&&JSON.stringify(old)!==JSON.stringify(desired))throw new Error('Qwen 已有不同 AgentRoom 配置，已保留，请核对后再更改。');
 let backup=null;
 if(!old){if(fs.existsSync(file)){backup=file+'.agentroom-backup-'+Date.now()+'-'+crypto.randomUUID();fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);if(fs.readFileSync(file,'utf8')!==raw)throw new Error('Qwen 设置在准备期间发生变化，没有覆盖。');}
  atomicWrite(file,JSON.stringify({...before,mcp_config:{...before.mcp_config,agentroom:desired}},null,2)+'\n');
 }
 const after=JSON.parse(fs.readFileSync(file,'utf8'));for(const [key,value]of Object.entries(before)){if(key==='mcp_config'){for(const [name,record]of Object.entries(value))assert.deepEqual(after.mcp_config[name],record);}else assert.deepEqual(after[key],value);}assert.deepEqual(after.mcp_config.agentroom,desired);
 // A friendly local import file avoids copying UUIDs. Its content is a private
 // member credential and is deliberately omitted from this script's output.
 const friendly=path.join(dir,'Qwen-AgentRoom-MCP.json');atomicWrite(friendly,JSON.stringify(config,null,2)+'\n');
 const status={...installation,status:'saved_pending_activation',configured:true,installed:false,connected:false,needs_import:true,needs_host_activation:true,disk_configuration_file:file,can_wake:false,detail:'已备份并保存 Qwen 本机设置。Qwen 1.0.3 不自动加载此项，仍需在设置→MCP 中导入、保存并启用；实际工具调用前不算握手。'};
 const db=new DatabaseSync(path.join(dir,'room.sqlite'));try{db.prepare('UPDATE launch_proxies SET installation=?,updated=? WHERE id=?').run(JSON.stringify(status),new Date().toISOString(),proxy.id);}finally{db.close();}
 const current=await apiCall(dir,'/api/launch/state'),member=current.proxies.find(p=>p.id===proxy.id);
 assert.equal(member.local_verified,proxy.local_verified,'configuration validation must not impersonate the Qwen client');
 const evidence={provider:'qwen-desktop',disk_configuration_saved:true,configuration_file:file,backup_file:backup,unchanged:!!old,other_settings_preserved:true,import_file:friendly,local_mcp_initialize_and_tool_list:true,available_tool_count:names.length,qwen_native_activated:false,qwen_handshake_verified:member.local_verified,requires_settings_import_save_enable:true,computer_use:false,private_ipc:false,model_calls:false};
 fs.mkdirSync(path.resolve(__dirname,'../output/validation'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../output/validation/qwen-config-current.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
