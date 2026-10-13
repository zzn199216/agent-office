'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{RoomError,atomicWrite}=require('./util.cjs');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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
  try{fs.renameSync(staging,target);}catch(e){try{fs.unlinkSync(staging);}catch{}throw new RoomError('旧版本仍在使用。请先停止后台程序，再启动新版。',409,'install_busy');}
  atomicWrite(marker,JSON.stringify({app:'AgentRoom',sha256:sourceHash,installed_at:new Date().toISOString()}));return target;
}
module.exports={installBinary};
