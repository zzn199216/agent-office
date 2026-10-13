'use strict';
// Real public artifact / metadata acceptance. No production service, provider
// prompt, auth/login command, npm installation, or account config is involved.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {RuntimeInstaller,GEMINI_VERSION,NODE_VERSION,GEMINI_RELEASE,validOfficialUrl}=require('../src/runtime-installer.cjs');
const {RoomError,now}=require('../src/util.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inside=(root,target)=>{const relative=path.relative(path.resolve(root),path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
async function main(){
  const repository=path.resolve(__dirname,'..'),output=path.join(repository,'output','validation');fs.mkdirSync(output,{recursive:true});
  const reportFile=path.join(output,`gemini-runtime-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-gemini-runtime-validation-')),dataDir=path.join(scratch,'data'),homeDir=path.join(scratch,'home');fs.mkdirSync(dataDir);fs.mkdirSync(homeDir);
  const env={...process.env};
  for(const key of Object.keys(env))if(/API[_-]?KEY|(?:^|_)TOKEN(?:_|$)|SECRET|CREDENTIAL|^GEMINI_|^GOOGLE_|^GCLOUD_|^AGENTROOM_|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^DEBUG(?:_|$)|^VITEST$/.test(key))delete env[key];
  Object.assign(env,{USERPROFILE:homeDir,HOME:homeDir,APPDATA:path.join(homeDir,'AppData','Roaming'),LOCALAPPDATA:path.join(homeDir,'AppData','Local'),XDG_CONFIG_HOME:path.join(homeDir,'config'),XDG_CACHE_HOME:path.join(homeDir,'cache'),XDG_DATA_HOME:path.join(homeDir,'share'),TEMP:path.join(homeDir,'temp'),TMP:path.join(homeDir,'temp'),GEMINI_API_KEY:'',GOOGLE_API_KEY:'',GOOGLE_APPLICATION_CREDENTIALS:'',GOOGLE_GENAI_USE_VERTEXAI:'false'});
  for(const folder of [env.APPDATA,env.LOCALAPPDATA,env.XDG_CONFIG_HOME,env.XDG_CACHE_HOME,env.XDG_DATA_HOME,env.TEMP])fs.mkdirSync(folder,{recursive:true});
  const commands=[],downloads=[],settings=new Map();
  const report={started_at:now(),status:'running',isolated_home:true,production_service_started:false,provider_prompts_sent:0,login_commands:0,cache_source:null,commands,downloads};
  const service={store:{dir:dataDir,setting(key,value){if(value===undefined)return settings.get(key)||null;settings.set(key,value);return value;}},chat:{discovery:{env:{}}},changed(){}};
  const cachedPackage=path.join(output,`gemini-cli-${GEMINI_VERSION}.tgz`),packageUrl=`https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${GEMINI_VERSION}.tgz`;
  const runner=(command,args,options={})=>new Promise((resolve,reject)=>{
    const isPowerShell=command==='powershell.exe';
    if(isPowerShell){
      if(!args.includes('-NoProfile')||!args.includes('-NonInteractive'))return reject(new Error('unapproved validation helper'));
      let request;try{request=JSON.parse(options.input||'{}');}catch{return reject(new Error('invalid helper input'));}
      if(request.url){validOfficialUrl(request.url);if(!inside(path.join(dataDir,'runtimes'),request.file))return reject(new Error('helper path outside validation data'));downloads.push({url:request.url,transport:'windows-system-proxy'});}
      else if(!inside(path.join(dataDir,'runtimes'),request.archive)||!inside(path.join(dataDir,'runtimes'),request.target))return reject(new Error('extractor path outside validation data'));
    }else{
      if(!inside(path.join(dataDir,'runtimes'),command)||!/^node\.exe$/i.test(path.basename(command)))return reject(new Error('unapproved validation executable'));
      if(!(args.length===1&&args[0]==='--version')&&!(args.length===2&&args[1]==='--version'&&inside(path.join(dataDir,'runtimes'),args[0])&&/[\\/]payload[\\/]package[\\/]bundle[\\/]gemini\.js$/.test(args[0])))return reject(new Error('validation permits version metadata only'));
    }
    const entry={kind:isPowerShell?'static-install-helper':args.length===1?'node-version':'gemini-version',command:command,args:isPowerShell?['-NoProfile','-NonInteractive','static-helper']:args};commands.push(entry);
    const child=spawn(command,args,{cwd:options.cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('validation metadata/helper timeout'));},options.timeout||20000);
    child.once('error',()=>finish(new Error('validation executable start failed')));
    child.stdout.on('data',bytes=>{stdout+=bytes.toString('utf8');if(stdout.length>1048576){child.kill();finish(new Error('validation output exceeded bound'));}});
    child.stderr.on('data',bytes=>{stderr+=bytes.toString('utf8');if(stderr.length>1048576){child.kill();finish(new Error('validation output exceeded bound'));}});
    child.once('close',exitCode=>{entry.exit_code=exitCode;if(!isPowerShell)entry.version_output=/^v?\d+\.\d+\.\d+$/.test(stdout.trim())?stdout.trim():'unrecognized';finish(null,{exitCode,stdout,stderr});});
    child.stdin.on('error',()=>{});child.stdin.end(options.input||'');
  });
  const fetch=async(url,options)=>{
    validOfficialUrl(url);
    if(url===packageUrl&&fs.existsSync(cachedPackage)){
      const bytes=fs.readFileSync(cachedPackage),digest='sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');
      if(bytes.length!==GEMINI_RELEASE.size||digest!==GEMINI_RELEASE.integrity||sha(bytes)!==GEMINI_RELEASE.sha256)throw new RoomError('缓存的官方 Gemini 包完整性不匹配。',409,'runtime_checksum_mismatch');
      report.cache_source=cachedPackage;downloads.push({url,transport:'verified-public-artifact-cache'});return new Response(bytes,{status:200});
    }
    downloads.push({url,transport:'node-fetch'});return globalThis.fetch(url,options);
  };
  const installer=new RuntimeInstaller(service,{fetch,runner,env,systemFallback:true});
  try{
    const first=await installer.install({provider:'gemini-cli'});
    if(!first.installed)throw new RoomError(first.detail||'官方 Gemini 运行时安装未完成。',503,first.reason||'runtime_install_failed');
    const packagePrefix=first.content_roots[0]+path.sep,nodePrefix=first.content_roots[1]+path.sep;
    const packageFiles=first.files.filter(file=>file.path.startsWith(packagePrefix)),nodeFiles=first.files.filter(file=>file.path.startsWith(nodePrefix));
    if(packageFiles.length!==449||!nodeFiles.length||first.version!==GEMINI_VERSION||first.node_version!==NODE_VERSION||first.verified_integrity!==GEMINI_RELEASE.integrity)throw new RoomError('真实官方运行时清单与预期不一致。',409,'runtime_validation_failed');
    for(const file of first.files)if(!inside(path.join(dataDir,'runtimes'),file.path)||sha(fs.readFileSync(file.path))!==file.sha256)throw new RoomError('真实官方运行时文件摘要核对失败。',409,'runtime_validation_failed');
    const requestsBeforeReuse=downloads.length,reused=await installer.install({provider:'gemini-cli'});
    if(!reused.installed||!reused.unchanged||reused.executable!==first.executable||reused.executable_args[0]!==first.executable_args[0]||downloads.length!==requestsBeforeReuse)throw new RoomError('真实运行时复用未保持原路径或发生额外下载。',409,'runtime_validation_failed');
    Object.assign(report,{status:'passed',package_files_verified:packageFiles.length,node_files_verified:nodeFiles.length,file_hashes_verified:first.files.length,metadata_versions_verified:true,reused_same_path:true,reuse_extra_downloads:0,runtime_receipt:first,oauth_credentials_created:fs.existsSync(path.join(homeDir,'.gemini','oauth_creds.json'))});
  }catch(error){report.status='failed';report.reason=error.code||'runtime_validation_failed';report.detail=error instanceof RoomError?error.message:'真实运行时元数据验收未完成。';process.exitCode=1;}
  finally{
    await installer.close();
    // Exact, freshly allocated test tree only. Preserve the public artifact
    // cache and the JSON acceptance receipt in the repository.
    const absolute=path.resolve(scratch),canonical=fs.realpathSync.native(absolute),tempCanonical=fs.realpathSync.native(os.tmpdir());
    if(inside(tempCanonical,canonical)&&/^agentoffice-gemini-runtime-validation-/.test(path.basename(absolute)))fs.rmSync(absolute,{recursive:true,force:true});
    report.finished_at=now();report.validation_tree_cleaned=!fs.existsSync(scratch);fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify({status:report.status,report:reportFile,package_files_verified:report.package_files_verified,node_files_verified:report.node_files_verified,file_hashes_verified:report.file_hashes_verified,reused_same_path:report.reused_same_path,reason:report.reason})+'\n');
  }
}
main().catch(()=>{process.stderr.write('Gemini 运行时元数据验收脚本未能启动。\n');process.exitCode=1;});
