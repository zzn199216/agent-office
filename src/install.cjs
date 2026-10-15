'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{RoomError,atomicWrite}=require('./util.cjs');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// A long-lived stdio client may still hold an older immutable executable. Keep
// its imported command/entry unchanged; when it next needs a backend, newer
// launchers select the current owned runtime from this data directory.
function activateRuntime(target,dir,sourceHash){
  const bin=path.join(dir,'bin'),relative=path.relative(bin,target).replace(/\\/g,'/');
  if(relative!=='AgentRoom.exe'&&relative!==`versions/${sourceHash}/AgentRoom.exe`)throw new RoomError('程序入口超出本机安装目录。',403,'install_collision');
  atomicWrite(path.join(bin,'active-runtime.json'),JSON.stringify({app:'AgentRoom.runtime',version:1,file:relative,sha256:sourceHash}));
  return target;
}
function activeRuntime(dir){
  const bin=path.resolve(dir,'bin'),file=path.join(bin,'active-runtime.json');
  if(!fs.existsSync(file))return null;
  let record;try{if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>4096)throw Error();record=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new RoomError('本机程序入口记录无效，没有启动其他程序。',409,'runtime_install_invalid');}
  if(record?.app!=='AgentRoom.runtime'||record.version!==1||!(/^[a-f0-9]{64}$/).test(record.sha256||'')||![`AgentRoom.exe`,`versions/${record.sha256}/AgentRoom.exe`].includes(record.file))throw new RoomError('本机程序入口记录无效，没有启动其他程序。',409,'runtime_install_invalid');
  const target=path.join(bin,...record.file.split('/'));
  // Every component is owned local installation state. Never trust a launch
  // command supplied by a resume card or follow a redirected version folder.
  let current=bin;
  for(const part of [null,...record.file.split('/')]){
    if(part)current=path.join(current,part);
    let stat;try{stat=fs.lstatSync(current);}catch{throw new RoomError('已安装的本机程序暂不可用，请重新打开新版。',409,'runtime_install_missing');}
    if(stat.isSymbolicLink())throw new RoomError('本机程序入口不能使用未知链接。',403,'runtime_install_invalid');
  }
  let installed;try{installed=JSON.parse(fs.readFileSync(path.join(path.dirname(target),'installed.json'),'utf8'));}catch{}
  if(installed?.app!=='AgentRoom'||installed.sha256!==record.sha256||!fs.statSync(target).isFile()||hash(target)!==record.sha256)throw new RoomError('本机程序校验失败，请重新打开新版。',409,'runtime_install_invalid');
  return target;
}
function installVersioned(source,bin,sourceHash){
  const folder=path.join(bin,'versions',sourceHash),target=path.join(folder,'AgentRoom.exe');
  for(const directory of [bin,path.join(bin,'versions'),folder])if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw new RoomError('程序安装目录不能使用未知链接。',403,'install_collision');
  fs.mkdirSync(folder,{recursive:true});
  if(fs.existsSync(target)){if(!fs.lstatSync(target).isFile()||hash(target)!==sourceHash)throw new RoomError('版本目录已有其他文件，未覆盖。',409,'install_collision');atomicWrite(path.join(folder,'installed.json'),JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return target;}
  const staging=path.join(folder,`AgentRoom-${process.pid}.tmp`);fs.copyFileSync(source,staging);
  try{fs.renameSync(staging,target);}catch(e){try{fs.unlinkSync(staging);}catch{}if(!fs.existsSync(target)||hash(target)!==sourceHash)throw new RoomError('新版程序安装未完成，请核对安装目录权限。',409,'install_busy');}
  atomicWrite(path.join(folder,'installed.json'),JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return target;
}
function replaceRunningBinary(staging,target,marker,dir,sourceHash){
  // Windows prevents overwriting a mapped executable but normally permits
  // renaming it. Preserve the old image for its process and put the new image
  // at the exact command path already imported by pre-upgrade MCP clients.
  let previous,oldMarker;try{oldMarker=fs.readFileSync(marker,'utf8');previous=JSON.parse(oldMarker);}catch{return null;}
  if(previous.app!=='AgentRoom'||previous.sha256!==hash(target))throw new RoomError('原安装程序与所有权记录不匹配，未替换。',409,'install_collision');
  const bin=path.dirname(target),retiredRoot=path.join(bin,'retired'),folder=path.join(retiredRoot,previous.sha256);
  for(const directory of [retiredRoot,folder])if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw new RoomError('旧版保留目录不能使用未知链接。',403,'install_collision');
  fs.mkdirSync(folder,{recursive:true});
  const retired=path.join(folder,`AgentRoom-${crypto.randomUUID()}.exe`);
  try{fs.renameSync(target,retired);}catch(error){if(['EPERM','EACCES','EBUSY'].includes(error.code))return null;throw error;}
  let replaced=false;
  try{
    fs.renameSync(staging,target);replaced=true;
    atomicWrite(marker,JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));
    return activateRuntime(target,dir,sourceHash);
  }catch(error){
    try{
      if(replaced)fs.renameSync(target,staging);
      fs.renameSync(retired,target);
      atomicWrite(marker,oldMarker);
    }catch{throw new RoomError('新版切换未完成，原程序已保留在本机安装目录；请重新打开安装包核对。',409,'install_rollback_failed');}
    throw new RoomError('新版切换未完成，已恢复原程序和连接入口。请稍后重试。',409,'install_busy');
  }
}
function installBinary(source,dir){
  const bin=path.join(dir,'bin'),target=path.join(bin,'AgentRoom.exe'),marker=path.join(bin,'installed.json');
  for(const candidate of [bin,target])if(fs.existsSync(candidate)&&fs.lstatSync(candidate).isSymbolicLink())throw new RoomError('程序安装入口不能使用未知链接。',403,'install_collision');
  fs.mkdirSync(bin,{recursive:true});
  const sourceHash=hash(source);
  if(path.resolve(source).toLowerCase()===path.resolve(target).toLowerCase()||fs.existsSync(target)&&hash(target)===sourceHash){
    let owned;try{owned=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{}
    if(owned?.app==='AgentRoom'&&owned.sha256===sourceHash)activateRuntime(target,dir,sourceHash);
    return target;
  }
  if(fs.existsSync(target)){
    let own=false;try{own=JSON.parse(fs.readFileSync(marker,'utf8')).app==='AgentRoom';}catch{}
    if(!own)throw new RoomError('安装目录已有其他文件，未覆盖。请使用新的数据目录。',409,'install_collision');
  }
  const staging=path.join(bin,`AgentRoom-${process.pid}.tmp`);fs.copyFileSync(source,staging);
  try{fs.renameSync(staging,target);}catch(e){
    // An idle daemon does not release executable mappings held by MCP clients.
    // Retire only a verified owned image, keeping both its running process and
    // its imported command valid. Explicit no-delete file locks still use an
    // immutable side installation; a later launch can promote it once released.
    try{
      if(['EPERM','EACCES','EBUSY'].includes(e.code)){
        if(fs.existsSync(target)){const swapped=replaceRunningBinary(staging,target,marker,dir,sourceHash);if(swapped)return swapped;}
        return activateRuntime(installVersioned(source,bin,sourceHash),dir,sourceHash);
      }
      throw new RoomError('新版程序安装未完成，请核对安装目录权限。',409,'install_busy');
    }finally{try{fs.unlinkSync(staging);}catch{}}
  }
  atomicWrite(marker,JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return activateRuntime(target,dir,sourceHash);
}
module.exports={installBinary,activeRuntime};
