'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const sha=file=>{const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);try{let length;while((length=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,length));}finally{fs.closeSync(fd);}return hash.digest('hex');};
function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
function git(root,args){const r=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});if(r.status!==0)throw new Error('Git source identity is unavailable.');return r.stdout;}
function sourceState(root){
  const head=git(root,['rev-parse','HEAD']).trim(),status=git(root,['status','--porcelain=v1','--untracked-files=all']),files=git(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean).sort(),digest=crypto.createHash('sha256');digest.update(head+'\0');
  for(const name of files){const file=path.resolve(root,name);if(!file.startsWith(path.resolve(root)+path.sep))throw new Error('Source path escapes the repository.');digest.update(name+'\0');if(!fs.existsSync(file)){digest.update('deleted\0');continue;}const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Release source must use regular files: '+name);digest.update(sha(file)+'\0');}
  const clean=!status.trim(),worktree_fingerprint=digest.digest('hex');
  // A clean checkout may use CRLF for PS1/CMD while another uses LF. Git HEAD
  // binds their canonical content; keep the physical byte digest separately.
  return {head,clean,fingerprint:clean?crypto.createHash('sha256').update(head+'\0clean').digest('hex'):worktree_fingerprint,worktree_fingerprint};
}
function acquireLock(file){
  fs.mkdirSync(path.dirname(file),{recursive:true});const value={pid:process.pid,host:os.hostname(),token:crypto.randomUUID(),created:new Date().toISOString()};
  for(let attempt=0;attempt<2;attempt++){
    try{fs.writeFileSync(file,JSON.stringify(value),{flag:'wx'});return()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===value.token)fs.unlinkSync(file);}catch{}};}
    catch(error){if(error.code!=='EEXIST')throw error;let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('Release lock is incomplete; inspect it before retrying.');}
      let alive=true;if(old.host===os.hostname()&&Number.isSafeInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}}
      if(alive||attempt)throw new Error('Another release operation owns the lock.');fs.unlinkSync(file);
    }
  }
}
async function terminateTree(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return;
  if(process.platform==='win32')await new Promise(resolve=>{const child=spawn('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});child.once('error',resolve);child.once('close',resolve);});
  else{try{process.kill(-pid,'SIGKILL');}catch{try{process.kill(pid,'SIGKILL');}catch{}}}
}
async function execute(command,args,{cwd,log,timeout=20*60*1000,signal,env=process.env}={}){
  fs.mkdirSync(path.dirname(log),{recursive:true});const fd=fs.openSync(log,'w'),started=Date.now();let child,timedOut=false,aborted=false,timer;
  try{return await new Promise((resolve,reject)=>{
    if(signal?.aborted){resolve({exit_code:1,aborted:true,duration_ms:0});return;}
    child=spawn(command,args,{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore',fd,fd]});
    const cancel=()=>{aborted=true;terminateTree(child.pid).catch(()=>{});};
    timer=setTimeout(()=>{timedOut=true;terminateTree(child.pid).catch(()=>{});},timeout);signal?.addEventListener('abort',cancel,{once:true});
    child.once('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(error);});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);resolve({exit_code:code===null?1:code,timed_out:timedOut,aborted,duration_ms:Date.now()-started});});
  });}finally{clearTimeout(timer);fs.closeSync(fd);}
}
function safeRelative(name){return typeof name==='string'&&name.length>0&&!name.includes('\\')&&!name.includes(':')&&!name.includes('\0')&&!path.posix.isAbsolute(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');}
function regularFile(root,name){if(!safeRelative(name))throw new Error('Invalid artifact path.');const file=path.resolve(root,...name.split('/')),realRoot=fs.realpathSync(root);let current=root;for(const part of name.split('/')){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Artifact links are not allowed.');}if(!fs.statSync(file).isFile()||!fs.realpathSync(file).startsWith(realRoot+path.sep))throw new Error('Artifact is outside its package.');return file;}
module.exports={sha,atomicJson,sourceState,acquireLock,execute,terminateTree,safeRelative,regularFile};
