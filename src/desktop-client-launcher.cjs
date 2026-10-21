'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {discoverDesktop}=require('./desktop-transport.cjs');
const {RoomError,sleep}=require('./util.cjs');
const CLIENTS={doubao:{name:'豆包',file:/^(?:Doubao|豆包)\.exe$/i,port:19246},'qwen-desktop':{name:'Qwen',file:/^Qwen\.exe$/i,port:19245}};
const opening=new WeakMap();
function refused(error){for(let value=error,i=0;value&&i<5;i++,value=value.cause)if(value.code==='ECONNREFUSED')return true;return false;}
function installedClient(executable,client){try{return typeof executable==='string'&&path.isAbsolute(executable)&&client.file.test(path.basename(executable))&&fs.statSync(executable).isFile()&&!fs.lstatSync(executable).isSymbolicLink();}catch{return false;}}
async function nativeDiscovery(service,provider,options,deadline){
  // Unlike the general inventory's synchronous CIM fallback, this explicit
  // action cannot block the daemon while Windows is slow to enumerate apps.
  const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -match '^(Doubao|豆包|Qwen)$'} | Select-Object @{n='Name';e={$_.ProcessName+'.exe'}},@{n='ProcessId';e={$_.Id}},@{n='ExecutablePath';e={$_.Path}}) | ConvertTo-Json -Compress";
  const processes=await new Promise(resolve=>{
    (options.inventoryExecFile||execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:Math.max(1,Math.min(5000,deadline-Date.now())),maxBuffer:1024*1024},(error,output)=>{
      if(error)return resolve({available:false,processes:[]});
      try{const rows=JSON.parse(output||'[]');if(!Array.isArray(rows)&&(!rows||typeof rows!=='object'))throw Error('Invalid inventory');resolve({available:true,processes:Array.isArray(rows)?rows:[rows]});}catch{resolve({available:false,processes:[]});}
    });
  });
  if(!service.chat.discovery?.scan)return {process_scan:{available:false},candidates:[]};
  const catalog=Object.create(service.chat.discovery);catalog.catalog=catalog.catalog.filter(value=>(value.provider||value.id)===provider);
  return catalog.scan({processes});
}
async function within(work,deadline){
  const remaining=deadline-Date.now();if(remaining<=0)throw new RoomError('客户端连接仍未就绪，请检查客户端状态后再试；没有重复创建人物。',504,'desktop_client_launch_timeout');
  let timer;try{return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new RoomError('客户端连接仍未就绪，请检查客户端状态后再试；没有重复创建人物。',504,'desktop_client_launch_timeout')),remaining);})]);}finally{clearTimeout(timer);}
}
async function launch(executable,args,options,deadline){
  return within(()=>new Promise((resolve,reject)=>{
    let child;try{child=(options.spawn||spawn)(executable,args,{windowsHide:false,detached:false,shell:false,stdio:'ignore'});}catch{reject(new RoomError('客户端未能打开，请从原安装位置打开后重试。',503,'desktop_client_launch_failed'));return;}
    child.once('error',()=>reject(new RoomError('客户端未能打开，请从原安装位置打开后重试。',503,'desktop_client_launch_failed')));
    child.once('spawn',()=>{child.unref();resolve();});
  }),deadline);
}
async function prepareNativeClient(service,job,options={}){
  let providers=opening.get(service);if(!providers){providers=new Map();opening.set(service,providers);}
  if(providers.has(job.provider))return providers.get(job.provider);
  const work=prepare(service,job,options);providers.set(job.provider,work);try{return await work;}finally{if(providers.get(job.provider)===work)providers.delete(job.provider);}
}
async function prepare(service,job,options={}){
  const client=CLIENTS[job.provider];if(!client)throw new RoomError('这个客户端请按它自己的接入说明继续，没有启动其他应用。',409,'desktop_adapter_unverified');
  if((options.platform||process.platform)!=='win32')throw new RoomError('当前系统请从客户端设置开启本机连接，再回来检查。',409,'desktop_client_launch_unavailable');
  const deadline=Date.now()+(options.timeoutMs||20000),endpoint=`http://127.0.0.1:${client.port}`,probe=options.probe||discoverDesktop;
  const check=()=>within(()=>probe(endpoint,job.provider,{fetchImpl:options.fetchImpl||service.fetch,timeoutMs:Math.max(1,Math.min(1000,deadline-Date.now()))}),deadline);
  const wait=async launched=>{for(;;){try{await check();return {kind:'open_native_client',provider:job.provider,available:true,launched};}catch(error){if(!refused(error)&&!(error.code==='desktop_target_ambiguous'&&error.retryable===true))throw error;}await within(()=>sleep(Math.min(250,Math.max(1,deadline-Date.now()))),deadline);}};
  try{await check();return {kind:'open_native_client',provider:job.provider,available:true,launched:false};}catch(error){if(error.code==='desktop_target_ambiguous'&&error.retryable===true)return wait(false);if(!refused(error))throw error;}
  const discovery=await within(()=>options.discover?options.discover():nativeDiscovery(service,job.provider,options,deadline),deadline);
  if(discovery?.process_scan?.available!==true)throw new RoomError(`暂时无法确认 ${client.name} 是否已退出。请从应用菜单或托盘完整退出后，再检查连接。`,409,'desktop_client_process_unconfirmed');
  const candidate=discovery.candidates?.find(value=>(value.provider||value.id)===job.provider);
  if(!candidate)throw new RoomError(`没有找到 ${client.name} 的本机安装。请先安装或打开它，再检查连接。`,404,'desktop_client_missing');
  const setting=`desktop_client_path.${job.provider}`;
  if(installedClient(candidate.executable,client))service.store?.setting(setting,candidate.executable);
  if(candidate.running===true||candidate.instances?.length||candidate.pids?.length)throw new RoomError(`${client.name} 正在运行，但没有开启 AO 本机连接。请先从 ${client.name} 菜单或托盘选择“退出”，再点击“开启客户端连接”。原聊天、人物和 MCP 配置保留。`,409,'desktop_client_restart_required');
  const executable=candidate.executable||service.store?.setting(setting);
  if(!installedClient(executable,client))throw new RoomError(`未找到可核对的 ${client.name} 正式程序。请先从原安装位置打开它，再点击“开启客户端连接”核对。`,409,'desktop_client_path_unverified');
  // Only this explicit controller action opens the selected app. Process
  // observation and reconnect polling never close a client or launch a duplicate.
  await launch(executable,[`--remote-debugging-port=${client.port}`,'--remote-debugging-address=127.0.0.1'],options,deadline);
  return wait(true);
}
module.exports={prepareNativeClient};
