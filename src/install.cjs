'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{RoomError,atomicWrite}=require('./util.cjs');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function installVersioned(source,bin,sourceHash){
  const folder=path.join(bin,'versions',sourceHash),target=path.join(folder,'AgentRoom.exe');
  for(const directory of [bin,path.join(bin,'versions'),folder])if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw new RoomError('程序安装目录不能使用未知链接。',403,'install_collision');
  fs.mkdirSync(folder,{recursive:true});
  if(fs.existsSync(target)){if(!fs.lstatSync(target).isFile()||hash(target)!==sourceHash)throw new RoomError('版本目录已有其他文件，未覆盖。',409,'install_collision');return target;}
  const staging=path.join(folder,`AgentRoom-${process.pid}.tmp`);fs.copyFileSync(source,staging);
  try{fs.renameSync(staging,target);}catch(e){try{fs.unlinkSync(staging);}catch{}if(!fs.existsSync(target)||hash(target)!==sourceHash)throw new RoomError('新版程序安装未完成，请核对安装目录权限。',409,'install_busy');}
  atomicWrite(path.join(folder,'installed.json'),JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return target;
}
function installBinary(source,dir){
  const bin=path.join(dir,'bin'),target=path.join(bin,'AgentRoom.exe'),marker=path.join(bin,'installed.json');
  fs.mkdirSync(bin,{recursive:true});
  if(path.resolve(source).toLowerCase()===path.resolve(target).toLowerCase())return target;
  const sourceHash=hash(source);
  if(fs.existsSync(target)&&hash(target)===sourceHash)return target;
  if(fs.existsSync(target)){
    let own=false;try{own=JSON.parse(fs.readFileSync(marker,'utf8')).app==='AgentRoom';}catch{}
    if(!own)throw new RoomError('安装目录已有其他文件，未覆盖。请使用新的数据目录。',409,'install_collision');
  }
  const staging=path.join(bin,`AgentRoom-${process.pid}.tmp`);fs.copyFileSync(source,staging);
  try{fs.renameSync(staging,target);}catch(e){try{fs.unlinkSync(staging);}catch{}
    // An idle daemon does not release executable mappings held by MCP clients.
    // Keep their binary intact; the new host and daemon use this immutable copy
    // with the same data directory instead of killing unrelated clients.
    if(['EPERM','EACCES','EBUSY'].includes(e.code))return installVersioned(source,bin,sourceHash);
    throw new RoomError('新版程序安装未完成，请核对安装目录权限。',409,'install_busy');
  }
  atomicWrite(marker,JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return target;
}
module.exports={installBinary};
