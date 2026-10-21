'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {RoomError,sleep,livePid}=require('./util.cjs');

// A PID is only an address: after a reboot it can belong to an unrelated app.
// Query process birth only during ownership changes, never on state polling.
function probe(command,args){
  return new Promise(resolve=>{
    let child,output='',done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child?.kill();finish(null);},2000);
    try{child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','ignore']});}catch{finish(null);return;}
    child.stdout.on('data',part=>{output+=part;if(output.length>16384){child.kill();finish(null);}});
    child.once('error',()=>finish(null));child.once('close',code=>finish(code===0?output.trim():null));
  });
}
async function processIdentity(pid){
  if(!Number.isSafeInteger(pid)||pid<=0||!livePid(pid))return null;
  if(process.platform==='win32'){
    const script=`$p=Get-Process -Id ${pid} -ErrorAction Stop; $s=$p.StartTime.ToUniversalTime(); @{identity=$s.Ticks.ToString();birth_ms=([DateTimeOffset]$s).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress`;
    try{const value=JSON.parse(await probe('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]));if(typeof value.identity==='string'&&Number.isFinite(value.birth_ms))return value;}catch{}
    return null;
  }
  let identity;
  if(process.platform==='linux')try{const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),stat=raw.slice(raw.lastIndexOf(') ')+2).trim().split(/\s+/);if(!/^\d+$/.test(stat[19]||''))return null;identity=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+stat[19];}catch{return null;}
  const started=await probe('ps',['-p',String(pid),'-o','lstart=']);const birth=Date.parse(started||'');
  return Number.isFinite(birth)?{identity:identity||started,birth_ms:birth}:null;
}
function readRecord(file){try{return {raw:fs.readFileSync(file,'utf8'),stat:fs.statSync(file)};}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function recordAlive(record,file,options={}){
  if(!record||!Number.isSafeInteger(record.pid)||record.pid<=0)return false;
  if(record.host&&record.host!==os.hostname())throw new RoomError('此数据目录的服务记录来自另一台电脑，请先核对原服务。',409,'service_owner_unverified');
  if(!livePid(record.pid))return false;
  const identity=await (options.processIdentity||processIdentity)(record.pid);
  if(!livePid(record.pid))return false;
  if(!identity)return true; // Unknown ownership must not evict a potentially live daemon.
  if(record.process_identity)return record.process_identity===identity.identity;
  // Legacy locks only stored a PID. A newer process cannot own an older lock.
  let modified;try{modified=fs.statSync(file).mtimeMs;}catch{return false;}
  return identity.birth_ms<=modified+1000;
}
async function exclusive(dir,callback,options={}){
  const {DatabaseSync}=require('node:sqlite');
  const file=path.join(dir,'daemon-mutex.sqlite'),end=Date.now()+(options.timeout||3500);
  for(;;){
    let db;
    try{db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY);');}
    catch(e){try{db?.close();}catch{}if(!/locked|busy/i.test(e.message))throw new RoomError('无法写入本机服务启动记录，请检查数据目录权限或磁盘空间。',503,'service_lock_unavailable');if(Date.now()>=end)throw new RoomError('另一次服务启动正在核对，请稍后重试。',409,'service_start_busy');await sleep(50);continue;}
    try{const result=await callback();db.exec('COMMIT');return result;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
  }
}
async function acquireDaemonLock(dir,options={}){
  fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'daemon.lock');
  return exclusive(dir,async()=>{
    const saved=readRecord(file);
    if(saved){
      let old;try{old=JSON.parse(saved.raw);}catch{}
      if(old&&await recordAlive(old,file,options))return null;
      if(!old||!Number.isSafeInteger(old.pid)||old.pid<=0){
        // A damaged lock does not authorize taking over a live service whose
        // independently written control record still identifies its owner.
        if(Date.now()-saved.stat.mtimeMs<5000)throw new RoomError('本机服务正在写入启动记录，请稍后重试。',409,'service_start_busy');
      }
    }
    const controlFile=path.join(dir,'control.json'),control=readRecord(controlFile);
    if(control){let current;try{current=JSON.parse(control.raw);}catch{throw new RoomError('服务启动记录需要核对，请检查本机服务日志后重试。',409,'service_owner_unverified');}if(await recordAlive(current,controlFile,options))return null;}
    const identity=await (options.processIdentity||processIdentity)(process.pid);
    const owner={pid:process.pid,owner_id:crypto.randomUUID(),process_identity:identity?.identity||null,created_at:new Date().toISOString(),host:os.hostname()};
    // The SQLite write lock serializes recovery and normal acquisition across
    // processes; a crash releases it through the OS, without a second stale PID lock.
    fs.writeFileSync(file,JSON.stringify(owner),{mode:0o600});return owner;
  },options);
}
async function releaseDaemonLock(dir,owner){
  return exclusive(dir,()=>{
    const file=path.join(dir,'daemon.lock');let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    if(saved?.owner_id===owner.owner_id&&saved.pid===owner.pid)fs.unlinkSync(file);
    const control=path.join(dir,'control.json');try{const current=JSON.parse(fs.readFileSync(control,'utf8'));if(current.owner_id===owner.owner_id&&current.pid===owner.pid)fs.unlinkSync(control);}catch{}
  });
}
async function isControlProcessAlive(dir,control){
  if(!control)return false;
  const file=path.join(dir,'control.json');let current;try{current=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return false;}
  if(current.pid!==control.pid||current.token!==control.token||current.owner_id!==control.owner_id)return false;
  return recordAlive(control,file);
}
module.exports={processIdentity,recordAlive,acquireDaemonLock,releaseDaemonLock,isControlProcessAlive};
