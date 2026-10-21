'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {RoomError}=require('./util.cjs');
const MARKER='desktop-lifecycle.json',MUTEX='desktop-lifecycle-mutex.sqlite';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid=cause=>{const error=new RoomError('软件服务状态记录无法核对，已保留原记录；请查看本机诊断，没有启动或关闭其他服务。',409,'desktop_lifecycle_invalid');if(cause)error.cause=cause;return error;};
const changing=cause=>{const error=new RoomError('软件服务状态正在更新，请稍后重试；没有启动或关闭其他服务。',409,'desktop_lifecycle_busy');if(cause)error.cause=cause;return error;};
function rootDirectory(dir,create=false){
  try{
    const absolute=path.resolve(dir);let stat;
    try{stat=fs.lstatSync(absolute);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!stat){if(!create)return null;fs.mkdirSync(absolute,{recursive:true,mode:0o700});}
    if(!fs.statSync(absolute).isDirectory())throw invalid();
    return fs.realpathSync.native(absolute);
  }catch(error){if(error instanceof RoomError)throw error;throw invalid();}
}
function regular(file,root,transient=false){
  let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1)throw invalid();
  let resolved;try{resolved=fs.realpathSync.native(file);}catch(error){
    // SQLite deletes its sidecars on commit. Disappearance after lstat is normal;
    // links, other path failures and the persistent mutex still fail closed.
    if(transient&&error.code==='ENOENT')return null;
    throw error;
  }
  if(path.dirname(resolved)!==root)throw invalid();
  return stat;
}
function readIntent(root){
  if(!root)return null;
  const file=path.join(root,MARKER);let value,observed=false;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const stat=regular(file,root);
      if(!stat){if(!observed)return null;if(attempt<2)continue;throw changing();}
      observed=true;if(stat.size>4096)throw invalid();
      value=JSON.parse(fs.readFileSync(file,'utf8'));break;
    }catch(error){
      // An atomic replacement may race path resolution/read. Reread the new
      // marker; once observed, disappearance must never enable legacy access.
      if(error.code==='ENOENT'){observed=true;if(attempt<2)continue;throw changing(error);}
      if(error instanceof RoomError)throw error;
      throw invalid(error);
    }
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!=='agentoffice.desktop-lifecycle'||value.version!==1||!UUID.test(value.id||'')||!['active','closed'].includes(value.state)||!Number.isFinite(Date.parse(value.updated_at||''))||Object.keys(value).some(key=>!['schema','version','id','state','updated_at','activation_id','control'].includes(key)))throw invalid();
  if(value.state==='active'&&(value.activation_id!==undefined||value.control!==undefined))throw invalid();
  if(value.state==='closed'&&(!UUID.test(value.activation_id||'')||!Object.hasOwn(value,'control')))throw invalid();
  if(value.state==='closed'&&value.control!==null)validateControl(value.control,true);
  return value;
}
function descriptor(value){return value?{id:value.id,state:value.state,...value.activation_id?{activation_id:value.activation_id}:{}}:null;}
function validateControl(value,strict=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Number.isSafeInteger(value.pid)||value.pid<=0||value.owner_id!==null&&!UUID.test(value.owner_id||'')||value.instance_id!==null&&!UUID.test(value.instance_id||''))throw invalid();
  let address;try{address=new URL(value.url);}catch{throw invalid();}
  if(address.protocol!=='http:'||address.hostname!=='127.0.0.1'||address.username||address.password||address.pathname!=='/'||address.search||address.hash||strict&&Object.keys(value).some(key=>!['pid','owner_id','instance_id','url'].includes(key)))throw invalid();
  return {pid:value.pid,owner_id:value.owner_id,instance_id:value.instance_id,url:address.origin};
}
const lockBusy=error=>[5,6].includes((error.errcode||0)&255)||/busy|locked/i.test(error.message||'');
function commitIntent(db){
  const end=Date.now()+3500,waiter=new Int32Array(new SharedArrayBuffer(4));
  for(;;){
    db.exec('PRAGMA busy_timeout='+Math.max(0,Math.min(1000,end-Date.now()))+';');
    try{db.exec('COMMIT');return;}catch(error){
      if(!lockBusy(error))throw error;
      const remaining=end-Date.now();if(remaining<=0)throw error;
      // Keep the same transaction: the CAS callback already changed a file.
      // SQLite may report BUSY immediately, so also bound synchronous retries.
      Atomics.wait(waiter,0,0,Math.min(25,remaining));
    }
  }
}
function writeMarker(root,value){
  const file=path.join(root,MARKER),temp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;let fd,owned=false;
  try{
    fd=fs.openSync(temp,'wx',0o600);owned=true;
    fs.writeFileSync(fd,JSON.stringify(value));fs.closeSync(fd);fd=undefined;
    const end=Date.now()+1500,waiter=new Int32Array(new SharedArrayBuffer(4));
    for(;;){
      try{fs.renameSync(temp,file);owned=false;return;}catch(error){
        // Windows readers can briefly deny replacement. Keep the old marker
        // and retry this one staged rename, never the surrounding CAS callback.
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
        const remaining=end-Date.now();if(remaining<=0)throw error;
        Atomics.wait(waiter,0,0,Math.min(25,remaining));
      }
    }
  }finally{
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    if(owned)try{fs.unlinkSync(temp);}catch{}
  }
}
function writeIntent(root,callback){
  const mutex=path.join(root,MUTEX);let db,begun=false;
  try{
    // Fail before creating a mutex if the existing marker cannot be trusted.
    readIntent(root);
    for(const suffix of ['','-journal','-wal','-shm'])regular(mutex+suffix,root,suffix!=='');
    const {DatabaseSync}=require('node:sqlite');
    db=new DatabaseSync(mutex);db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;');begun=true;
    for(const suffix of ['','-journal','-wal','-shm'])regular(mutex+suffix,root,suffix!=='');
    const result=callback(readIntent(root));commitIntent(db);begun=false;return result;
  }catch(error){
    if(begun)try{db.exec('ROLLBACK');}catch{}
    if(error instanceof RoomError)throw error;
    const wrapped=lockBusy(error)?new RoomError('另一个软件窗口正在更新服务状态，请稍后重试。',409,'desktop_lifecycle_busy'):new RoomError('无法保存软件服务状态，原办公室记录已保留。请检查本机诊断。',503,'desktop_lifecycle_unavailable');
    wrapped.cause=error;throw wrapped;
  }finally{db?.close();}
}
function desktopIntent(dir){return descriptor(readIntent(rootDirectory(dir)));}
function assertBackgroundAllowed(dir){
  const intent=readIntent(rootDirectory(dir));
  if(intent?.state==='closed')throw new RoomError('Agent Office 已关闭。请重新打开软件后继续使用原连接，无需重新配置 MCP。',503,'desktop_application_closed');
  return descriptor(intent);
}
function assertClosedIntent(dir,closedId){
  const current=readIntent(rootDirectory(dir));
  if(!UUID.test(closedId||'')||current?.state!=='closed'||current.id!==closedId)throw new RoomError('软件窗口的关闭状态已变化，没有停止新打开窗口的服务。',409,'desktop_service_changed');
  return descriptor(current);
}
function activateDesktop(dir,requestedId){
  if(requestedId!==undefined&&!UUID.test(requestedId||''))throw invalid();
  const root=rootDirectory(dir,true);
  return writeIntent(root,current=>{
    if(requestedId&&current?.state==='closed'&&current.activation_id===requestedId)throw new RoomError('这个软件窗口已经关闭，没有重新开启旧的启动操作。',503,'desktop_application_closed');
    if(requestedId&&current?.state==='active'&&current.id===requestedId)return descriptor(current);
    const value={schema:'agentoffice.desktop-lifecycle',version:1,id:requestedId||crypto.randomUUID(),state:'active',updated_at:new Date().toISOString()};
    writeMarker(root,value);return descriptor(value);
  });
}
function markDesktopClosed(dir,{expectedActivation,control}={}){
  if(!UUID.test(expectedActivation||''))throw new RoomError('缺少当前软件窗口的服务状态标识，没有关闭其他窗口的服务。',409,'desktop_service_changed');
  const root=rootDirectory(dir);if(!root)throw new RoomError('当前软件窗口的服务状态已变化，没有创建替代状态。',409,'desktop_service_changed');
  const pinned=control==null?null:validateControl(control);
  return writeIntent(root,current=>{
    if(current?.state==='closed'&&current.activation_id===expectedActivation)return descriptor(current);
    if(current?.state!=='active'||current.id!==expectedActivation)throw new RoomError('另一个软件窗口已更新服务状态，没有关闭新的服务。',409,'desktop_service_changed');
    const value={schema:'agentoffice.desktop-lifecycle',version:1,id:crypto.randomUUID(),activation_id:expectedActivation,state:'closed',updated_at:new Date().toISOString(),control:pinned};
    writeMarker(root,value);return descriptor(value);
  });
}
module.exports={desktopIntent,assertBackgroundAllowed,assertClosedIntent,activateDesktop,markDesktopClosed};
