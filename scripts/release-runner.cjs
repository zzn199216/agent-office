'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {atomicJson,sourceState,acquireLock,execute,regularFile,sha}=require('./release-common.cjs'),{verifyArtifacts,publishArtifacts}=require('./release-artifacts.cjs');
const ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
const validId=value=>typeof value==='string'&&ID.test(value)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
function validateRequest(value,fileId,context){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['id','created','steps','expected_version','expected_head'].includes(key)))throw new Error('Unknown or invalid request fields.');
  if(!validId(value.id)||value.id!==fileId)throw new Error('Invalid or mismatched request id.');
  const created=typeof value.created==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.created)?Date.parse(value.created):NaN;
  if(!Number.isFinite(created)||created>context.now+30000)throw new Error('Invalid or future request timestamp.');
  if(context.now-created>10*60*1000)throw new Error('Request expired; it will not be replayed.');
  if(!Array.isArray(value.steps)||value.steps.length!==1||!['check','release'].includes(value.steps[0]))throw new Error('Steps must be exactly ["check"] or ["release"].');
  if(value.expected_version!==context.version)throw new Error('Expected version differs from package.json.');
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.expected_head)||value.expected_head!==context.source.head)throw new Error('Expected Git HEAD differs from the source.');
  if(!context.source.clean)throw new Error('The source must be committed and clean before queueing a build.');
  return value;
}
function cleanStage(directory){const target=path.resolve(directory);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('agentoffice-runner-'))throw new Error('Refusing cleanup outside the runner stage.');fs.rmSync(target,{recursive:true,force:true});}
function copyDependencies(root,snapshot){
  const lock=JSON.parse(fs.readFileSync(path.join(snapshot,'package-lock.json'),'utf8'));
  for(const [name,value]of Object.entries(lock.packages||{})){
    if(!name.startsWith('node_modules/')||name.includes('/../')||name.includes('\\'))continue;
    const source=path.join(root,...name.split('/'));if(!fs.existsSync(source)){if(value.optional)continue;throw new Error('Build dependency is missing; install the locked dependencies on the host.');}
    if(fs.lstatSync(source).isSymbolicLink()||JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version!==value.version)throw new Error('Installed dependency differs from package-lock.json: '+name);
    const destination=path.join(snapshot,...name.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(source,destination,{recursive:true,errorOnExist:true,force:false,filter:file=>{if(fs.lstatSync(file).isSymbolicLink())throw new Error('Dependency links are not accepted.');return true;}});
  }
}
function copySdkCache(root,snapshot){
  const {SDK_VERSION,SDK_SHA256}=require(path.join(snapshot,'scripts','build-desktop.cjs')),relative=path.join('dist','webview2-sdk',SDK_VERSION,'webview2.nupkg'),cached=path.join(root,relative);
  if(fs.existsSync(cached)&&!fs.lstatSync(cached).isSymbolicLink()&&sha(cached)===SDK_SHA256){const target=path.join(snapshot,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(cached,target);}
}
async function executeRequest(request,{root,signal,statusDirectory,logDirectory}){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-runner-')),snapshot=path.join(temporary,'source'),before=sourceState(root);let unlock;
  const command=async(name,command,args,cwd=root)=>{const result=await execute(command,args,{cwd,signal,log:path.join(logDirectory,name+'.log')});if(result.exit_code!==0||result.aborted||result.timed_out)throw new Error(name+' failed; see the runner log.');};
  try{
    unlock=acquireLock(path.join(root,'output','release.lock'));
    if(before.head!==request.expected_head||!before.clean)throw new Error('Source changed before execution.');
    await command('snapshot','git',['clone','--no-local','--no-checkout','--quiet',root,snapshot]);
    await command('checkout','git',['-c','core.hooksPath='+path.join(temporary,'no-hooks'),'checkout','--detach','--quiet',request.expected_head],snapshot);
    const pinned=sourceState(snapshot);if(pinned.head!==request.expected_head||!pinned.clean)throw new Error('The isolated source snapshot is not clean.');
    if(request.steps[0]==='check'){
      await command('check',process.execPath,['scripts/check.cjs'],snapshot);
      if(sourceState(root).fingerprint!==before.fingerprint)throw new Error('Shared source changed while checking the pinned snapshot.');
      const resultPath=path.join(statusDirectory,request.id+'-result.json');atomicJson(resultPath,{status:'ok',steps:['check'],source:pinned,models_called:false});return {result_path:resultPath,source:pinned};
    }
    copyDependencies(root,snapshot);copySdkCache(root,snapshot);
    await command('release',process.execPath,['scripts/release.cjs','--json'],snapshot);
    const result=JSON.parse(fs.readFileSync(path.join(snapshot,'output',`release-${request.expected_version}.json`),'utf8'));
    if(result.status!=='ok'||!result.fully_verified||sourceState(root).fingerprint!==before.fingerprint)throw new Error('Release failed or the shared source changed; no delivery was published.');
    const verified=verifyArtifacts(result.package_directory,result.zip_path,request.expected_version,result.source),published=publishArtifacts(root,result.package_directory,result.zip_path,verified,request.id+'-'+result.run_id),reportDirectory=path.join(root,'output','release-runs',request.id);fs.mkdirSync(reportDirectory,{recursive:true});
    for(const name of fs.readdirSync(path.dirname(result.result_path))){if(!/^[a-z0-9.-]+\.(?:json|log)$/.test(name)||name==='result.json')continue;fs.copyFileSync(regularFile(path.dirname(result.result_path),name),path.join(reportDirectory,name));}
    const imported={...result,...published,result_path:path.join(reportDirectory,'result.json'),request_id:request.id,steps:result.steps.map(row=>({...row,log:path.join(reportDirectory,path.basename(row.log))})),temporary_directory:null};
    atomicJson(imported.result_path,imported);atomicJson(path.join(root,'output',`release-${request.expected_version}.json`),imported);return {result_path:imported.result_path,source:result.source,package_directory:published.package_directory};
  }finally{try{cleanStage(temporary);}finally{unlock?.();}}
}
async function processQueue(options={},dependencies={}){
  const root=path.resolve(options.root||path.join(__dirname,'..')),requests=path.join(root,'output','release-requests'),statuses=path.join(root,'output','release-status'),now=dependencies.now||Date.now,executor=dependencies.executor||executeRequest,state=dependencies.sourceState||sourceState,version=dependencies.version||JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  fs.mkdirSync(requests,{recursive:true});fs.mkdirSync(statuses,{recursive:true});let unlock;try{unlock=(dependencies.acquireLock||acquireLock)(path.join(root,'output','release-runner.lock'));}catch(error){return {busy:true,processed:0,reason:error.message};}
  let processed=0;const results=[];
  try{
    for(const name of fs.readdirSync(statuses).filter(name=>/^[a-z0-9-]+\.json$/.test(name))){const file=path.join(statuses,name);let previous;try{previous=JSON.parse(fs.readFileSync(regularFile(statuses,name),'utf8'));}catch{continue;}if(previous.status==='running')atomicJson(file,{...previous,status:'failed',error:'Previous host execution was interrupted; it was not replayed.',finished:new Date(now()).toISOString()});}
    const jobs=fs.readdirSync(requests).filter(name=>name.endsWith('.json')).map(name=>({name,created:0}));
    for(const job of jobs){try{const file=regularFile(requests,job.name);if(fs.statSync(file).size>16384)throw new Error('Request exceeds 16 KiB.');job.value=JSON.parse(fs.readFileSync(file,'utf8'));job.created=Date.parse(job.value?.created)||0;}catch(error){job.error=error.message;}}
    jobs.sort((a,b)=>a.created-b.created||a.name.localeCompare(b.name));
    for(const job of jobs){
      const fileId=job.name.slice(0,-5),id=validId(fileId)?fileId:'rejected-'+crypto.createHash('sha256').update(job.name).digest('hex').slice(0,24),statusFile=path.join(statuses,id+'.json');
      if(fs.existsSync(statusFile)){let existing;try{existing=JSON.parse(fs.readFileSync(regularFile(statuses,id+'.json'),'utf8'));}catch{continue;}if(existing.status!=='queued')continue;}
      let request;try{if(job.error)throw new Error(job.error);request=validateRequest(job.value,fileId,{version,source:state(root),now:now()});}catch(error){atomicJson(statusFile,{id,status:'rejected',error:error.message,finished:new Date(now()).toISOString()});results.push({id,status:'rejected'});continue;}
      atomicJson(statusFile,{id,status:'queued',created:request.created,expected_head:request.expected_head});
      const logDirectory=path.join(root,'output','release-runs',id);fs.mkdirSync(logDirectory,{recursive:true});
      const controller=new AbortController();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs||20*60*1000),running={id,status:'running',created:request.created,started:new Date(now()).toISOString(),expected_head:request.expected_head,log_path:logDirectory};atomicJson(statusFile,running);
      try{const result=await executor(request,{root,signal:controller.signal,statusDirectory:statuses,logDirectory});if(timedOut)throw new Error('Host execution timed out; it was not replayed.');atomicJson(statusFile,{...running,...result,status:'ok',finished:new Date(now()).toISOString()});results.push({id,status:'ok'});}
      catch(error){atomicJson(statusFile,{...running,status:'failed',timed_out:timedOut,error:error.message,finished:new Date(now()).toISOString()});results.push({id,status:'failed'});}
      finally{clearTimeout(timer);processed++;}
    }
  }finally{unlock();}
  return {busy:false,processed,results};
}
function parseArgs(args){let root;for(let i=0;i<args.length;i++){if(args[i]==='--once')continue;if(args[i]==='--root'&&args[i+1]&&!args[i+1].startsWith('--')){root=path.resolve(args[++i]);continue;}throw new Error('Usage: node scripts/release-runner.cjs --once [--root REPOSITORY]');}return {root};}
if(require.main===module){let options;try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}if(options)processQueue(options).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});}
module.exports={processQueue,validateRequest,executeRequest,parseArgs,copyDependencies};
