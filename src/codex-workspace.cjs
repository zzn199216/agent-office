'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {RoomError,atomicWrite,normalizePath}=require('./util.cjs');
const preparations=new Map(),imports=new Map();
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function nativePath(value){if(process.platform!=='win32')return value;if(value.startsWith('\\\\?\\UNC\\'))return '\\\\'+value.slice(8);return value.startsWith('\\\\?\\')?value.slice(4):value;}
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function inside(root,file){const relative=path.relative(nativePath(root),nativePath(file));return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function regular(file,root){
  if(!inside(root,file)||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile()||!inside(fs.realpathSync.native(root),fs.realpathSync.native(file)))throw new RoomError('Codex 保存路径越出已登记目录，未读取或迁移。',409,'codex_workspace_path');
  return file;
}
function directory(root,folder){if(folder!==root&&!inside(root,folder))throw new RoomError('后台保存路径越界。',409,'codex_workspace_path');let current=root;for(const part of path.relative(root,folder).split(path.sep).filter(Boolean)){current=path.join(current,part);if(fs.existsSync(current)&&(!fs.lstatSync(current).isDirectory()||fs.lstatSync(current).isSymbolicLink()))throw new RoomError('后台保存目录不能是链接。',409,'codex_workspace_path');fs.mkdirSync(current,{recursive:true,mode:0o700});}}
function toml(value){
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return String(value);
  if(Array.isArray(value))return '['+value.filter(v=>v!==null&&v!==undefined).map(toml).join(', ')+']';
  if(value&&typeof value==='object')return '{ '+Object.entries(value).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>JSON.stringify(k)+' = '+toml(v)).join(', ')+' }';
  throw new RoomError('Codex 模型配置无法独立保存，请检查连接设置。',409,'codex_workspace_config');
}
// Copy model routing, not the user's MCP servers, hooks, notifications, plugins,
// profiles or paths that could send workspace state back into the personal home.
const modelKeys=new Set(['model','model_provider','model_providers','model_reasoning_effort','model_reasoning_summary','model_verbosity','service_tier','model_context_window','model_auto_compact_token_limit','model_catalog_json','openai_base_url','chatgpt_base_url','forced_login_method','forced_chatgpt_workspace_id']);
function windowsSandboxMode(config={}){
  const windows=config&&Object.hasOwn(config,'windows')?config.windows:null;
  const mode=windows&&typeof windows==='object'&&!Array.isArray(windows)&&Object.hasOwn(windows,'sandbox')?windows.sandbox:null;
  return ['elevated','unelevated'].includes(mode)?mode:null;
}
function workspaceConfig(config={}){const values=Object.entries(config).filter(([k,v])=>modelKeys.has(k)&&v!==null&&v!==undefined),mode=windowsSandboxMode(config);if(mode)values.push(['windows',{sandbox:mode}]);values.push(['cli_auth_credentials_store','file'],['notify',[]]);return values.map(([k,v])=>k+' = '+toml(v)).join('\n')+'\n';}
// Preserve local Windows tables, dotted/quoted keys and unfamiliar encodings.
// A conservative false positive only leaves the independent config unchanged.
function hasWindowsConfig(source){return /\bwindows\b/i.test(source)||/\\[uU][a-fA-F0-9]{4}/.test(source);}
function workspaceOwner(state,legacyHome){return state?.schema==='agentoffice.codex-workspace'&&state.version===1&&typeof state.prepared==='boolean'&&typeof state.legacy_home==='string'&&path.isAbsolute(state.legacy_home)&&same(state.legacy_home,legacyHome);}
function entryExists(file){try{fs.lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function readWorkspaceMarker(file,home){regular(file,home);try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new RoomError('后台协作目录身份标记无法核对，原记录已保留。',409,'codex_workspace_owner');}}
async function preserveWindowsSandbox(home,marker,state,markerBytes,readConfig,assertHome){
  assertHome();
  const configFile=path.join(home,'config.toml');
  if(!fs.existsSync(configFile))return; // Do not recreate an intentionally absent config.
  regular(configFile,home);
  if(state.windows_sandbox_checked===true)return;
  const original=fs.readFileSync(configFile,'utf8');
  const mode=hasWindowsConfig(original)?null:windowsSandboxMode(await readConfig());
  assertHome();
  regular(marker,home);
  if(fs.readFileSync(marker,'utf8')!==markerBytes)throw new RoomError('后台协作目录在检查期间发生变化，未迁移配置。',409,'codex_workspace_owner');
  regular(configFile,home);
  if(fs.readFileSync(configFile,'utf8')!==original)throw new RoomError('后台配置在检查期间发生变化，未覆盖已有设置。',409,'codex_workspace_config');
  if(mode){
    // Append through an existing file descriptor, without truncating or creating
    // a replacement file. The callback cannot redirect our final write.
    const descriptor=fs.openSync(configFile,fs.constants.O_RDWR|fs.constants.O_APPEND);
    try{
      regular(configFile,home);const opened=fs.fstatSync(descriptor),current=fs.statSync(configFile);
      if(!opened.isFile()||opened.dev!==current.dev||opened.ino!==current.ino||fs.readFileSync(descriptor,'utf8')!==original)throw new RoomError('后台配置已改变，未覆盖已有设置。',409,'codex_workspace_config');
      fs.writeSync(descriptor,(original.endsWith('\n')?'':'\n')+'\n[windows]\nsandbox = '+toml(mode)+'\n');
    }finally{fs.closeSync(descriptor);}
  }
  atomicWrite(marker,JSON.stringify({...state,windows_sandbox_checked:true}));
}
class CodexWorkspace{
  constructor(dir,options={}){
    this.home=path.resolve(dir,'codex');let origin;
    const marker=path.join(this.home,'agentoffice-workspace.json');
    if(!options.legacyHome&&entryExists(marker)){const record=readWorkspaceMarker(marker,this.home);if(record.schema==='agentoffice.codex-workspace'&&record.version===1&&typeof record.legacy_home==='string'&&path.isAbsolute(record.legacy_home))origin=record.legacy_home;}
    // MCP/CLI recovery inherits this private CODEX_HOME. Recover the original
    // source from our marker instead of treating it as a new personal home.
    this.legacyHome=path.resolve(options.legacyHome||origin||process.env.CODEX_HOME||path.join(process.env.USERPROFILE||os.homedir(),'.codex'));
    if(same(this.home,this.legacyHome))throw new RoomError('后台协作目录不能使用个人 Codex 保存目录。',409,'codex_workspace_shared');
  }
  assertAuthenticationOwner(){
    if(!entryExists(this.home))return;
    if(!fs.lstatSync(this.home).isDirectory()||fs.lstatSync(this.home).isSymbolicLink())throw new RoomError('后台协作保存目录不能是链接。',409,'codex_workspace_path');
    if(fs.existsSync(this.legacyHome)&&same(fs.realpathSync.native(this.home),fs.realpathSync.native(this.legacyHome)))throw new RoomError('后台协作目录不能使用个人 Codex 保存目录。',409,'codex_workspace_shared');
    const marker=path.join(this.home,'agentoffice-workspace.json');let state;
    if(entryExists(marker)){
      state=readWorkspaceMarker(marker,this.home);
      if(!workspaceOwner(state,this.legacyHome))throw new RoomError('后台协作目录身份不匹配。',409,'codex_workspace_owner');
    }
    // A copied rotating login is not an independent identity. Do not read its
    // bytes, refresh it, replace it, or infer ownership from timestamps. Until
    // a single-owner authorization flow exists, file-backed logins stay paused.
    if(state?.credential_seeded===true||entryExists(path.join(this.home,'auth.json')))throw new RoomError('为保护已登录的 Codex，AO 已暂停这条后台连接。原聊天和成员已保留；请勿重复登录或复制登录文件。',409,'codex_auth_ownership_required');
  }
  assertSharedCache(){
    // Authentication stays in the original native cache. The old private
    // auth.json is deliberately not inspected, loaded, copied or overwritten.
    if(!fs.existsSync(this.legacyHome)||!fs.statSync(this.legacyHome).isDirectory())throw new RoomError('尚未找到原 Codex 环境。请先打开已安装的 Codex 完成首次设置，再检查连接。',409,'codex_login_required');
    if(entryExists(path.join(this.legacyHome,'agentoffice-workspace.json')))throw new RoomError('选中的 Codex 环境是 AO 的旧工作副本，不能当作原登录缓存。原连接已保留，请检查连接诊断。',409,'codex_auth_ownership_required');
    if(entryExists(this.home)){
      if(!fs.lstatSync(this.home).isDirectory()||fs.lstatSync(this.home).isSymbolicLink())throw new RoomError('后台协作保存目录不能是链接。',409,'codex_workspace_path');
      const realHome=fs.realpathSync.native(this.home),source=fs.realpathSync.native(this.legacyHome);
      if(same(realHome,source)||inside(realHome,source))throw new RoomError('原 Codex 缓存不能指向 AO 的旧认证副本。',409,'codex_auth_ownership_required');
      const marker=path.join(this.home,'agentoffice-workspace.json');
      if(entryExists(marker)){if(!workspaceOwner(readWorkspaceMarker(marker,this.home),this.legacyHome))throw new RoomError('后台协作目录身份不匹配。',409,'codex_workspace_owner');}
      else if(fs.readdirSync(this.home).length)throw new RoomError('后台协作目录已有未登记文件，原记录已保留。',409,'codex_workspace_owner');
    }
  }
  async sharedEnvironment(){
    this.assertSharedCache();fs.mkdirSync(this.home,{recursive:true,mode:0o700});this.assertSharedCache();
    const marker=path.join(this.home,'agentoffice-workspace.json');
    if(!entryExists(marker))try{fs.writeFileSync(marker,JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:this.legacyHome,credential_seeded:false,authentication_policy:'native-shared-cache-v1',created:new Date().toISOString()}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;this.assertSharedCache();}
    return {...process.env,CODEX_HOME:this.legacyHome,CODEX_SQLITE_HOME:this.home};
  }
  sharedArguments(){return ['-c','sqlite_home='+toml(this.home),'-c','notify=[]','-c','features.hooks=false','-c','features.codex_hooks=false','-c','features.plugins=false','-c','features.apps=false'];}
  async prepare(readConfig){
    this.assertAuthenticationOwner();
    const preparationKey=process.platform==='win32'?this.home.toLowerCase():this.home;
    if(preparations.has(preparationKey))return preparations.get(preparationKey);
    const pending=(async()=>{
      const marker=path.join(this.home,'agentoffice-workspace.json');
      if(fs.existsSync(this.home)&&fs.lstatSync(this.home).isSymbolicLink())throw new RoomError('后台协作保存目录不能是链接。',409,'codex_workspace_path');
      fs.mkdirSync(this.home,{recursive:true,mode:0o700});
      const originalHome=fs.lstatSync(this.home),assertHome=()=>{const current=fs.lstatSync(this.home);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==originalHome.dev||current.ino!==originalHome.ino)throw new RoomError('后台协作目录在检查期间发生变化，未迁移配置。',409,'codex_workspace_path');};
      if(fs.existsSync(marker)){regular(marker,this.home);const markerBytes=fs.readFileSync(marker,'utf8'),state=JSON.parse(markerBytes);if(!workspaceOwner(state,this.legacyHome))throw new RoomError('后台协作目录身份不匹配。',409,'codex_workspace_owner');if(state.prepared){await preserveWindowsSandbox(this.home,marker,state,markerBytes,readConfig,assertHome);return this.home;}}
      else{if(fs.readdirSync(this.home).length)throw new RoomError('后台协作目录已有未登记文件，请核对保存位置。',409,'codex_workspace_owner');atomicWrite(marker,JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:false,legacy_home:this.legacyHome}));}
      const markerBytes=fs.readFileSync(marker,'utf8');
      const config=await readConfig();
      this.assertAuthenticationOwner();
      assertHome();regular(marker,this.home);
      if(fs.readFileSync(marker,'utf8')!==markerBytes)throw new RoomError('后台协作目录在检查期间发生变化，未生成配置。',409,'codex_workspace_owner');
      const configFile=path.join(this.home,'config.toml');
      if(fs.existsSync(configFile))regular(configFile,this.home);
      else try{fs.writeFileSync(configFile,workspaceConfig(config),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;regular(configFile,this.home);}
      // Never seed, sync, or replace personal credentials in a private HOME.
      atomicWrite(marker,JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:this.legacyHome,credential_seeded:false,authentication_policy:'no-personal-credential-copy-v1',windows_sandbox_checked:true,created:new Date().toISOString()}));return this.home;
    })();preparations.set(preparationKey,pending);
    try{return await pending;}finally{preparations.delete(preparationKey);}
  }
  environment(){return {...process.env,CODEX_HOME:this.home};}
  receipt(threadId){if(!uuid(threadId))throw new RoomError('会话标识无效。');return path.join(this.home,'imports',threadId+'.json');}
  migrationState(threadId){const file=this.receipt(threadId);if(!fs.existsSync(file))return null;regular(file,this.home);const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.schema!=='agentoffice.codex-import'||value.thread_id!==threadId)throw new RoomError('会话迁移凭据无效，原绑定保留。',409,'codex_migration_identity');return value;}
  legacyVisibleCount(){const folder=path.join(this.home,'imports');if(!fs.existsSync(folder))return 0;return fs.readdirSync(folder).filter(name=>name.endsWith('.json')&&uuid(name.slice(0,-5))).map(name=>this.migrationState(name.slice(0,-5))).filter(value=>value.verified&&!value.source_archived).length;}
  async importThread(client,legacy,project,discussion){
    const key=this.home+':'+discussion.thread_id;if(imports.has(key))return imports.get(key);
    const pending=this.importOnce(client,legacy,project,discussion);imports.set(key,pending);try{return await pending;}finally{imports.delete(key);}
  }
  async importOnce(client,legacy,project,discussion){
    const threadId=discussion.thread_id,receipt=this.receipt(threadId);
    const original=await legacy.read(threadId);
    if(!original||original.id!==threadId||normalizePath(original.cwd)!==project.canonical||original.name!==`AgentRoom · ${project.name} · ${discussion.title}`)throw new RoomError('旧会话尚未确认属于这个协作成员，保留原绑定，请人工核对。',409,'codex_migration_identity');
    if(!Array.isArray(original.turns))throw new RoomError('旧会话没有返回可核对的完整历史，原记录保留。',409,'codex_migration_changed');
    if(original.status?.type==='active'||original.turns.some(t=>['inProgress','in_progress'].includes(t.status)))throw new RoomError('旧 Codex 会话仍在处理任务，迁移等待它空闲。',409,'codex_migration_busy');
    const source=typeof original.path==='string'?nativePath(original.path):null;
    if(!source||!['sessions','archived_sessions'].some(folder=>inside(path.join(this.legacyHome,folder),source)))throw new RoomError('旧版本未提供可核对的会话保存位置，保留原绑定。',409,'codex_migration_path');
    regular(source,this.legacyHome);const bytes=fs.readFileSync(source),digest=sha(bytes),meta=JSON.parse(bytes.toString('utf8').split(/\r?\n/,1)[0]);
    if(meta.type!=='session_meta'||meta.payload?.id!==threadId||normalizePath(meta.payload.cwd)!==project.canonical)throw new RoomError('旧会话文件与绑定身份不匹配，未迁移。',409,'codex_migration_identity');
    const destination=path.join(this.home,'sessions','agentoffice-imports',path.basename(source));
    directory(this.home,path.dirname(destination));directory(this.home,path.dirname(receipt));
    atomicWrite(receipt,JSON.stringify({schema:'agentoffice.codex-import',thread_id:threadId,source_sha256:digest,verified:false,created:new Date().toISOString()}));
    if(fs.existsSync(destination)){regular(destination,this.home);if(sha(fs.readFileSync(destination))!==digest)throw new RoomError('迁移副本与原记录不一致，未覆盖已有上下文。',409,'codex_migration_changed');}
    else atomicWrite(destination,bytes);
    // Register the full copied rollout under the isolated home; no turn starts.
    await client.call('thread/resume',{threadId,path:destination,cwd:project.path,sandbox:project.access,approvalPolicy:'on-request',approvalsReviewer:'auto_review',excludeTurns:true});
    const copied=await client.read(threadId);
    if(copied?.id!==threadId||normalizePath(copied.cwd)!==project.canonical||JSON.stringify(copied.turns)!==JSON.stringify(original.turns)||sha(fs.readFileSync(source))!==digest)throw new RoomError('迁移后的完整历史尚未核对一致，原会话保留，未提交业务任务。',409,'codex_migration_changed');
    await client.call('thread/name/set',{threadId,name:original.name});
    atomicWrite(receipt,JSON.stringify({schema:'agentoffice.codex-import',thread_id:threadId,source_sha256:digest,history_sha256:sha(JSON.stringify(copied.turns)),source_archived:false,verified:true,created:new Date().toISOString()}));
    // Only this named, idle AgentRoom binding is archived, after a verified copy.
    // Archive failure never discards the original or replays a business turn.
    try{const descendants=await legacy.call('thread/list',{ancestorThreadId:threadId,sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'],limit:100,useStateDbOnly:true});if(!Array.isArray(descendants.data)||descendants.data.length||descendants.nextCursor)throw new Error('descendants require separate review');await legacy.call('thread/archive',{threadId});const record=JSON.parse(fs.readFileSync(receipt,'utf8'));record.source_archived=true;atomicWrite(receipt,JSON.stringify(record));}catch{}
    return copied;
  }
}
function missingThread(error){return error?.code==='codex_rpc_error'&&/not found|not loaded|unknown thread|no rollout|does not exist|could not find|unable to find/i.test(error.message);}
module.exports={CodexWorkspace,workspaceConfig,missingThread,nativePath};
