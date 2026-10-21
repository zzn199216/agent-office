'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const zlib=require('node:zlib');
const {spawn}=require('node:child_process');
const {AsyncLocalStorage}=require('node:async_hooks');
const installationContext=new AsyncLocalStorage();
const {RoomError,id,now,atomicWrite,readableError}=require('./util.cjs');
const QWEN_HOST='qwen-code-assets.oss-cn-hangzhou.aliyuncs.com';
const CLAUDE_HOST='downloads.claude.ai';
const GEMINI_VERSION='0.63.0',NODE_VERSION='22.22.2';
const GEMINI_RELEASE=Object.freeze({version:GEMINI_VERSION,size:20810043,integrity:'sha512-mmhqMmAdsoplCzrLQQC4yJBqr4uSKXghnrLspgUU6N9drmsaq7pi7oF09skRYzEq2dYK6eMT4UpFQP6rG2o/ew==',sha256:'97a6edfc10645463b517f0518d46a8c72efbdc12558a9a948607f726284a0420'});
const NODE_RELEASE=Object.freeze({version:NODE_VERSION,sha256:'7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c'});
const VERSION=/^\d+\.\d+\.\d+$/;
const MAX_BINARY=600*1024*1024,MAX_TEXT=2*1024*1024;
const UTF8_IO="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ";
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
function inside(root,target){const relative=path.relative(path.resolve(root),path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
function versionAtLeast(value,minimum){const left=value.split('.').map(Number),right=minimum.split('.').map(Number);for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]>right[i];}return true;}
function validOfficialUrl(value){
  let url;try{url=new URL(value);}catch{throw new RoomError('运行时下载地址无效。',400,'runtime_source_invalid');}if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw new RoomError('运行时下载地址不是受支持的官方 HTTPS 来源。',400,'runtime_source_invalid');
  const allowed=url.hostname===QWEN_HOST&&/^\/releases\/qwen-code\/v\d+\.\d+\.\d+\/(?:SHA256SUMS|qwen-code-win-x64\.zip)$/.test(url.pathname)||url.hostname===CLAUDE_HOST&&/^\/claude-code-releases\/(?:latest|\d+\.\d+\.\d+\/(?:manifest\.json|win32-x64\/claude\.exe))$/.test(url.pathname)||url.hostname==='registry.npmjs.org'&&/^\/@google\/gemini-cli\/(?:\d+\.\d+\.\d+|-\/gemini-cli-\d+\.\d+\.\d+\.tgz)$/.test(url.pathname)||url.hostname==='nodejs.org'&&/^\/dist\/v22\.22\.2\/(?:SHASUMS256\.txt|node-v22\.22\.2-win-x64\.zip)$/.test(url.pathname);
  if(!allowed)throw new RoomError('运行时下载地址超出了受支持的官方来源。',400,'runtime_source_invalid');return url.toString();
}
function archiveName(name,allowedRoots){
  name=name.replace(/\\/g,'/');while(name.startsWith('./'))name=name.slice(2);
  const parts=name.replace(/\/$/,'').split('/'),directory=name.endsWith('/');
  if(!name||name.startsWith('/')||/[\u0000-\u001f\u007f:]/.test(name)||parts.some(part=>!part||part==='..'||part==='.'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||!allowedRoots.includes(parts[0]))throw new RoomError('运行时压缩包含不安全的文件路径。',409,'runtime_archive_unsafe');
  return{name,parts,directory,key:parts.join('/').toLowerCase()};
}
function checkNames(names){
  for(const key of names.keys()){const segments=key.split('/');for(let i=1;i<segments.length;i++){const parent=names.get(segments.slice(0,i).join('/'));if(parent&&!parent.directory)throw new RoomError('运行时文件与目录冲突。',409,'runtime_archive_unsafe');}}
}
function zipEntries(buffer,options={}){
  if(!Buffer.isBuffer(buffer)||buffer.length<22)throw new RoomError('运行时 ZIP 缺少完整目录。',409,'runtime_archive_invalid');
  const allowedRoots=options.allowedRoots||['qwen-code'];
  let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){if(buffer.readUInt32LE(i)===0x06054b50&&i+22+buffer.readUInt16LE(i+20)===buffer.length){end=i;break;}}
  if(end<0)throw new RoomError('运行时 ZIP 缺少完整目录。',409,'runtime_archive_invalid');
  const count=buffer.readUInt16LE(end+10),size=buffer.readUInt32LE(end+12),offset=buffer.readUInt32LE(end+16);
  if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==count||!count||count>50000||offset===0xffffffff||size===0xffffffff||offset+size!==end)throw new RoomError('运行时 ZIP 目录格式不受支持。',409,'runtime_archive_invalid');
  const entries=[],names=new Map(),ranges=[];let cursor=offset,total=0;
  for(let index=0;index<count;index++){
    if(cursor+46>end||buffer.readUInt32LE(cursor)!==0x02014b50)throw new RoomError('运行时 ZIP 目录损坏。',409,'runtime_archive_invalid');
    const flags=buffer.readUInt16LE(cursor+8),method=buffer.readUInt16LE(cursor+10),compressed=buffer.readUInt32LE(cursor+20),uncompressed=buffer.readUInt32LE(cursor+24),nameLength=buffer.readUInt16LE(cursor+28),extraLength=buffer.readUInt16LE(cursor+30),commentLength=buffer.readUInt16LE(cursor+32),attributes=buffer.readUInt32LE(cursor+38),local=buffer.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extraLength+commentLength;if(next>end||flags&1||![0,8].includes(method)||compressed===0xffffffff||uncompressed===0xffffffff||local===0xffffffff)throw new RoomError('运行时 ZIP 条目不受支持。',409,'runtime_archive_invalid');
    const raw=buffer.subarray(cursor+46,cursor+46+nameLength);let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw new RoomError('运行时 ZIP 文件名编码无效。',409,'runtime_archive_invalid');}
    const checked=archiveName(name,allowedRoots);name=checked.name;const {parts,directory}=checked;
    const fileType=(attributes>>>16)&0xf000;if(fileType===0xa000||attributes&0x400||fileType&&! [0x8000,0x4000].includes(fileType))throw new RoomError('运行时 ZIP 含链接或特殊文件。',409,'runtime_archive_unsafe');
    const key=parts.join('/').toLowerCase();if(names.has(key))throw new RoomError('运行时 ZIP 含冲突的文件路径。',409,'runtime_archive_unsafe');names.set(key,{directory});
    if(local+30>offset||buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+6)!==flags||buffer.readUInt16LE(local+8)!==method)throw new RoomError('运行时 ZIP 本地条目与目录不一致。',409,'runtime_archive_invalid');
    const localName=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28),start=local+30+localName+localExtra;
    if(start+compressed>offset||!buffer.subarray(local+30,local+30+localName).equals(raw))throw new RoomError('运行时 ZIP 文件边界无效。',409,'runtime_archive_invalid');
    ranges.push({start:local,end:start+compressed});
    total+=uncompressed;if(total>2*1024*1024*1024||uncompressed>1024*1024*1024||uncompressed>4*1024*1024&&uncompressed>Math.max(compressed,1)*1000)throw new RoomError('运行时 ZIP 展开后超过本机限制。',409,'runtime_archive_invalid');
    entries.push({name,directory,size:uncompressed});cursor=next;
  }
  if(cursor!==end)throw new RoomError('运行时 ZIP 目录长度无效。',409,'runtime_archive_invalid');
  ranges.sort((a,b)=>a.start-b.start);for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new RoomError('运行时 ZIP 文件边界重叠。',409,'runtime_archive_invalid');checkNames(names);
  return entries;
}
function tarEntries(compressed,options={}){
  const maximum=options.maxOutputBytes||256*1024*1024,allowedRoots=options.allowedRoots||['package'];
  let buffer;try{buffer=zlib.gunzipSync(compressed,{maxOutputLength:maximum});}catch{throw new RoomError('官方 npm 压缩包损坏或展开大小超过限制。',409,'runtime_archive_invalid');}
  if(buffer.length%512||buffer.length<1024)throw new RoomError('官方 npm TAR 边界不完整。',409,'runtime_archive_invalid');
  const entries=[],names=new Map();let cursor=0,total=0,ended=false;
  const field=(header,start,length)=>{const bytes=header.subarray(start,start+length),nul=bytes.indexOf(0),actual=nul<0?bytes:bytes.subarray(0,nul);if(nul>=0&&bytes.subarray(nul).some(byte=>byte!==0))throw new RoomError('官方 npm TAR 字段格式无效。',409,'runtime_archive_invalid');try{return new TextDecoder('utf-8',{fatal:true}).decode(actual);}catch{throw new RoomError('官方 npm TAR 文件名编码无效。',409,'runtime_archive_invalid');}};
  const octal=(header,start,length)=>{const value=header.subarray(start,start+length).toString('ascii').replace(/[\0 ]+$/,'').trim();if(!/^[0-7]+$/.test(value))throw new RoomError('官方 npm TAR 数值格式不受支持。',409,'runtime_archive_invalid');const number=parseInt(value,8);if(!Number.isSafeInteger(number))throw new RoomError('官方 npm TAR 数值超出限制。',409,'runtime_archive_invalid');return number;};
  while(cursor+512<=buffer.length){
    const header=buffer.subarray(cursor,cursor+512);
    if(header.every(byte=>byte===0)){if(cursor+1024>buffer.length||buffer.subarray(cursor).some(byte=>byte!==0))throw new RoomError('官方 npm TAR 结束标记无效。',409,'runtime_archive_invalid');ended=true;break;}
    if(entries.length>=50000)throw new RoomError('官方 npm TAR 文件数量超过限制。',409,'runtime_archive_invalid');
    const expected=octal(header,148,8);let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==expected)throw new RoomError('官方 npm TAR 头部校验失败。',409,'runtime_archive_invalid');
    const type=header[156],magic=field(header,257,6),prefix=field(header,345,155),filename=field(header,0,100),link=field(header,157,100),size=octal(header,124,12);
    if(![0,48,53].includes(type)||link)throw new RoomError('官方 npm TAR 含链接或不支持的扩展条目。',409,'runtime_archive_unsafe');
    if(magic&&magic!=='ustar'||prefix&&magic!=='ustar')throw new RoomError('官方 npm TAR 格式不受支持。',409,'runtime_archive_invalid');
    const checked=archiveName((prefix?prefix+'/':'')+filename,allowedRoots),directory=type===53;
    if(checked.directory&&!directory||directory&&size!==0)throw new RoomError('官方 npm TAR 文件类型无效。',409,'runtime_archive_invalid');
    if(names.has(checked.key))throw new RoomError('官方 npm TAR 含冲突路径。',409,'runtime_archive_unsafe');names.set(checked.key,{directory});
    const start=cursor+512,end=start+size,next=start+Math.ceil(size/512)*512;
    total+=size;if(end>buffer.length||next>buffer.length||size>128*1024*1024||total>maximum)throw new RoomError('官方 npm TAR 文件大小超过限制。',409,'runtime_archive_invalid');
    entries.push({name:checked.name,directory,size,data:buffer.subarray(start,end)});cursor=next;
  }
  if(!ended||!entries.length)throw new RoomError('官方 npm TAR 缺少完整结束标记。',409,'runtime_archive_invalid');checkNames(names);return entries;
}
function defaultRunner(command,args,options={}){
  if(options.signal?.aborted)return Promise.reject(new RoomError('本房间的安装已停止。',409,'cancelled'));
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:options.env||process.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',finished=false;
    const timer=setTimeout(()=>{child.kill();done(new RoomError('官方运行时元数据检查超时。',503,'runtime_metadata_timeout'));},options.timeout||20000);
    const abort=()=>{child.kill();done(new RoomError('本房间的安装已停止。',409,'cancelled'));};options.signal?.addEventListener('abort',abort,{once:true});
    const done=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result);};
    child.on('error',error=>done(error));child.stdout.on('data',data=>{stdout+=data.toString('utf8');if(stdout.length>1024*1024){child.kill();done(new Error('metadata output too large'));}});child.stderr.on('data',data=>{stderr+=data.toString('utf8');if(stderr.length>1024*1024){child.kill();done(new Error('metadata output too large'));}});
    child.on('close',exitCode=>done(null,{exitCode,stdout,stderr}));child.stdin.on('error',()=>{});child.stdin.end(options.input||'');
  });
}
async function defaultExtractor(archive,target,options={}){
  if(process.platform!=='win32')throw new RoomError('自动运行时安装目前支持 Windows x64。',409,'runtime_platform_unsupported');
  const script="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; [IO.Compression.ZipFile]::ExtractToDirectory([string]$request.archive,[string]$request.target)";
  const result=await (options.runner||defaultRunner)('powershell.exe',['-NoProfile','-NonInteractive','-Command',UTF8_IO+script],{windowsHide:true,shell:false,timeout:120000,input:JSON.stringify({archive,target})});
  if(result.exitCode!==0)throw new RoomError('官方运行时 ZIP 展开失败。',503,'runtime_extract_failed');
}
class RuntimeInstaller{
  constructor(service,options={}){this.service=service;this.options=options;this.fetch=options.fetch||globalThis.fetch;const runner=options.runner||defaultRunner;this.runner=async(command,args,input={})=>{this.checkCancelled();const result=await runner(command,args,{...input,signal:installationContext.getStore()?.abort.signal});this.checkCancelled();return result;};this.extractor=options.extractor||defaultExtractor;this.jobs=new Map();this.jobOwners=new Map();this.root=path.resolve(service.store.dir,'runtimes');this.systemHosts=new Set();
    // Injected fetches are self-contained by default. A trusted fixture can
    // explicitly enable this path with its own runner; browser inputs cannot.
    this.systemFallback=(options.systemFallback===true||options.fetch===undefined&&options.systemFallback!==false)&&(options.platform||process.platform)==='win32';}
  async bytes(url,maxBytes){
    this.checkCancelled();
    const official=validOfficialUrl(url),host=new URL(official).hostname;
    if(this.systemFallback&&this.systemHosts.has(host))return this.systemBytes(official,maxBytes);
    try{return await this.nodeBytes(official,maxBytes);}catch(error){
      this.checkCancelled();
      const code=error?.cause?.code||error?.code;
      const network=['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code)||['AbortError','TimeoutError'].includes(error?.name)||error instanceof TypeError&&error.message==='fetch failed';
      if(!this.systemFallback||!network)throw error;
      const buffer=await this.systemBytes(official,maxBytes);this.systemHosts.add(host);return buffer;
    }
  }
  async nodeBytes(url,maxBytes){
    let current=validOfficialUrl(url);const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
    try{
      for(let redirect=0;redirect<4;redirect++){
        const signal=installationContext.getStore()?.abort.signal;
        const response=await this.fetch(current,{redirect:'manual',signal:signal?AbortSignal.any([controller.signal,signal]):controller.signal});
        this.checkCancelled();
        if(response.status>=300&&response.status<400){const location=response.headers?.get('location');if(!location)throw new RoomError('官方下载返回了无效跳转。',503,'runtime_download_failed');current=validOfficialUrl(new URL(location,current).toString());continue;}
        if(!response.ok)throw new RoomError('暂时无法下载官方运行时，请稍后重试。',503,'runtime_download_failed');
        const length=Number(response.headers?.get('content-length')||0);if(length>maxBytes)throw new RoomError('官方运行时下载超过大小限制。',409,'runtime_download_too_large');
        if(response.body&&typeof response.body[Symbol.asyncIterator]==='function'){
          const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>maxBytes){controller.abort();throw new RoomError('官方运行时下载超过大小限制。',409,'runtime_download_too_large');}chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks,total);
        }
        const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>maxBytes)throw new RoomError('官方运行时下载超过大小限制。',409,'runtime_download_too_large');return buffer;
      }throw new RoomError('官方运行时下载跳转过多。',503,'runtime_download_failed');
    }finally{clearTimeout(timeout);}
  }
  async systemBytes(url,maxBytes){
    let current=validOfficialUrl(url);
    for(let redirect=0;redirect<4;redirect++){
      const folder=this.assertOwned(path.join(this.root,'.downloads'));fs.mkdirSync(folder,{recursive:true});
      const file=this.assertOwned(path.join(folder,`${id()}.download`));
      // Windows' standard .NET network stack honors the user's system proxy.
      // The static helper receives only validated URLs and an owned file path;
      // it never evaluates a downloaded script or disables TLS verification.
      const script="$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; $response=$null; $stream=$null; $output=$null; try { $web=[Net.HttpWebRequest]::Create([string]$request.url); $web.AllowAutoRedirect=$false; $web.Timeout=30000; $web.ReadWriteTimeout=30000; $web.UserAgent='AgentRoom official-runtime installer'; try { $response=$web.GetResponse() } catch [Net.WebException] { if ($null -eq $_.Exception.Response) { throw }; $response=$_.Exception.Response }; $status=[int]$response.StatusCode; if ($status -ge 300 -and $status -lt 400) { @{status=$status;location=[string]$response.Headers['Location'];length=0} | ConvertTo-Json -Compress } elseif ($status -ge 200 -and $status -lt 300) { $limit=[long]$request.max_bytes; if ($response.ContentLength -gt $limit) { throw 'runtime_download_too_large' }; $stream=$response.GetResponseStream(); $output=[IO.File]::Open([string]$request.file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $buffer=New-Object byte[] 65536; $total=[long]0; while (($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0) { $total+=$read; if ($total -gt $limit) { throw 'runtime_download_too_large' }; $output.Write($buffer,0,$read) }; $output.Dispose(); $output=$null; @{status=$status;length=$total} | ConvertTo-Json -Compress } else { @{status=$status;length=0} | ConvertTo-Json -Compress } } finally { if ($null -ne $output) { $output.Dispose() }; if ($null -ne $stream) { $stream.Dispose() }; if ($null -ne $response) { $response.Dispose() } }";
      try{
        const result=await this.runner('powershell.exe',['-NoProfile','-NonInteractive','-Command',UTF8_IO+script],{windowsHide:true,shell:false,timeout:120000,input:JSON.stringify({url:current,file,max_bytes:maxBytes})});
        if(result.exitCode!==0)throw new RoomError('Windows 系统网络未能下载官方运行时。',503,String(result.stderr||'').includes('runtime_download_too_large')?'runtime_download_too_large':'runtime_download_failed');
        let metadata;try{metadata=JSON.parse(String(result.stdout||'').trim());}catch{throw new RoomError('Windows 官方下载的元数据无效。',503,'runtime_download_failed');}
        if(!Number.isInteger(metadata.status)||metadata.status<200||metadata.status>599)throw new RoomError('Windows 官方下载的状态无效。',503,'runtime_download_failed');
        if(metadata.status>=300&&metadata.status<400){if(typeof metadata.location!=='string'||!metadata.location)throw new RoomError('官方下载返回了无效跳转。',503,'runtime_download_failed');current=validOfficialUrl(new URL(metadata.location,current).toString());continue;}
        if(metadata.status<200||metadata.status>=300)throw new RoomError('暂时无法下载官方运行时，请稍后重试。',503,'runtime_download_failed');
        const stat=fs.statSync(file);if(!stat.isFile()||stat.size>maxBytes||!Number.isSafeInteger(metadata.length)||metadata.length!==stat.size)throw new RoomError('Windows 官方下载的文件大小无效。',409,'runtime_download_too_large');
        return fs.readFileSync(file);
      }finally{
        // Single-file cleanup only, using the exact UUID path checked above.
        try{fs.unlinkSync(this.assertOwned(file));}catch{}
      }
    }throw new RoomError('官方运行时下载跳转过多。',503,'runtime_download_failed');
  }
  install(input={}){
    if(this.closing)return Promise.reject(new RoomError('本机服务正在停止，没有开始新的安装。',503,'service_stopping'));
    if(!['qwen-code','claude-code','gemini-cli'].includes(input.provider))return Promise.reject(new RoomError('这个 agent 没有受支持的官方运行时安装器。',409,'runtime_provider_unsupported'));
    if(this.jobs.has(input.provider)){this.jobOwners.get(input.provider)?.rooms.add(input.room_id||'*');return this.jobs.get(input.provider);}
    const owner={abort:new AbortController(),rooms:new Set([input.room_id||'*'])};this.jobOwners.set(input.provider,owner);
    const work=installationContext.run(owner,()=>this.perform(input.provider)).catch(error=>({status:owner.abort.signal.aborted?'cancelled':'needs_setup',installed:false,reason:owner.abort.signal.aborted?'cancelled':error.code||'runtime_install_failed',...(error.stage?{stage:error.stage}:{}),detail:input.provider==='gemini-cli'&&!(error instanceof RoomError)?'官方 Gemini 运行时安装未完成，请重试该步骤。':readableError(error)})).finally(()=>{this.jobs.delete(input.provider);this.jobOwners.delete(input.provider);});
    this.jobs.set(input.provider,work);return work;
  }
  checkCancelled(){if(installationContext.getStore()?.abort.signal.aborted)throw new RoomError('本房间的安装已停止。',409,'cancelled');}
  cancelRoom(roomId){for(const owner of this.jobOwners.values())if(owner.rooms.delete(roomId)&&!owner.rooms.size)owner.abort.abort();}
  assertOwned(target){
    const absolute=path.resolve(target);if(!inside(this.root,absolute))throw new RoomError('运行时路径超出了本机专用目录。',403,'runtime_path_invalid');
    let current=absolute;
    while(inside(this.root,current)){
      if(fs.existsSync(current)){const stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw new RoomError('运行时目录不能使用链接。',403,'runtime_path_invalid');}
      current=path.dirname(current);
    }
    if(fs.existsSync(this.root)&&fs.lstatSync(this.root).isSymbolicLink())throw new RoomError('运行时根目录不能使用链接。',403,'runtime_path_invalid');
    return absolute;
  }
  publish(record){
    this.checkCancelled();
    this.service.store.setting(`runtime.${record.provider}`,record);
    const env=this.service.chat?.discovery?.env;
    if(env){if(record.provider==='qwen-code'){env.AGENTROOM_QWEN_CODE_PATH=record.executable;env.AGENTROOM_QWEN_CODE_SCRIPT=record.executable_args[0];}else if(record.provider==='gemini-cli'){env.AGENTROOM_GEMINI_PATH=record.executable;env.AGENTROOM_GEMINI_SCRIPT=record.executable_args[0];}else env.AGENTROOM_CLAUDE_CODE_PATH=record.executable;}
    this.service.changed?.();return {status:'installed',installed:true,connected:false,...record};
  }
  async metadata(record){
    this.assertOwned(record.executable);for(const item of record.executable_args||[])this.assertOwned(item);
    if(record.provider==='gemini-cli'){
      const node=await this.runner(record.executable,['--version'],{cwd:path.dirname(record.executable),env:this.options.env||process.env,windowsHide:true,shell:false,timeout:20000});
      if(node.exitCode!==0||String(node.stdout||'').trim()!==`v${record.node_version}`)throw new RoomError('官方 Node 版本与下载清单不一致。',409,'runtime_version_mismatch');
    }
    const result=await this.runner(record.executable,[...(record.executable_args||[]),'--version'],{cwd:path.dirname(record.executable),env:this.options.env||process.env,windowsHide:true,shell:false,timeout:20000});
    const actual=String(result.stdout||'').match(/\b\d+\.\d+\.\d+\b/)?.[0];if(result.exitCode!==0||actual!==record.version)throw new RoomError('官方运行时的版本与下载清单不一致。',409,'runtime_version_mismatch');
  }
  async reusable(provider,version){
    const record=this.service.store.setting(`runtime.${provider}`);
    if(!record||record.version!==version||record.provider!==provider||!(/^[a-f0-9]{64}$/).test(record.verified_sha256||'')||!Array.isArray(record.files)||!record.files.length)return null;
    try{
      if(provider==='gemini-cli'){
        const expected=this.options.geminiRelease||GEMINI_RELEASE,nodeExpected=this.options.nodeRelease||NODE_RELEASE;
        if(record.files_complete!==true||record.node_version!==NODE_VERSION||record.verified_sha256!==expected.sha256||record.verified_integrity!==expected.integrity||record.node_sha256!==nodeExpected.sha256||!Array.isArray(record.content_roots)||record.content_roots.length!==2)return null;
        const workspace=path.dirname(record.content_roots[0]);if(record.content_roots[0]!==path.join(workspace,'payload')||record.content_roots[1]!==path.join(workspace,'node')||!new RegExp(`^${version.replace(/\./g,'\\.')}-[0-9a-f-]{36}$`).test(path.basename(workspace))||record.executable!==path.join(workspace,'node',`node-v${NODE_VERSION}-win-x64`,'node.exe')||record.executable_args?.[0]!==path.join(workspace,'payload','package','bundle','gemini.js'))return null;
        const files=record.content_roots.flatMap(folder=>this.filesIn(folder)).sort(),listed=record.files.map(file=>file.path).sort();if(files.length!==listed.length||files.some((file,index)=>file!==listed[index]))return null;
        if(!record.files.some(file=>file.path===record.executable)||!record.files.some(file=>file.path===record.executable_args?.[0]))return null;
      }
      for(const file of record.files){const location=this.assertOwned(file.path);if(!fs.statSync(location).isFile()||sha(fs.readFileSync(location))!==file.sha256)return null;}await this.metadata(record);return this.publish({...record,unchanged:true});
    }catch{return null;}
  }
  filesIn(folder){
    const result=[],pending=[this.assertOwned(folder)];let total=0,count=0;
    while(pending.length){const current=pending.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true})){if(++count>50000)throw new RoomError('运行时文件数量超过限制。',409,'runtime_archive_invalid');const file=this.assertOwned(path.join(current,entry.name)),stat=fs.lstatSync(file);if(stat.isDirectory())pending.push(file);else if(stat.isFile()){total+=stat.size;if(total>2*1024*1024*1024)throw new RoomError('运行时文件大小超过限制。',409,'runtime_archive_invalid');result.push(file);}else throw new RoomError('运行时展开结果含链接或特殊文件。',409,'runtime_archive_unsafe');}}
    return result;
  }
  checkExtracted(target,entries){
    const expected=entries.filter(entry=>!entry.directory).map(entry=>({file:this.assertOwned(path.join(target,...entry.name.split('/'))),size:entry.size}));
    const actual=this.filesIn(target).sort(),listed=expected.map(entry=>entry.file).sort();
    if(actual.length!==listed.length||actual.some((file,index)=>file!==listed[index]))throw new RoomError('官方运行时展开结果与清单不一致。',409,'runtime_layout_invalid');
    for(const entry of expected)if(fs.statSync(entry.file).size!==entry.size)throw new RoomError('官方运行时展开文件大小与清单不一致。',409,'runtime_layout_invalid');
  }
  extractTar(entries,target){
    for(const entry of entries){const file=this.assertOwned(path.join(target,...entry.name.split('/')));if(entry.directory){fs.mkdirSync(file,{recursive:true});continue;}fs.mkdirSync(this.assertOwned(path.dirname(file)),{recursive:true});fs.writeFileSync(file,entry.data,{flag:'wx',mode:0o600});}
    this.checkExtracted(target,entries);
  }
  async existingGemini(){
    // User-requested installation may reuse a separately installed official
    // npm package. Discovery supplies the trusted fixed launch, not a command
    // from browser input. Do not run npm, auth, login or a model prompt.
    let candidate;try{candidate=this.service.chat?.discovery?.scan?.({processes:[]})?.candidates?.find(item=>item.provider==='gemini-cli'&&item.capabilities?.automatic_launch);}catch{return null;}
    if(!candidate||typeof candidate.executable!=='string'||!path.isAbsolute(candidate.executable)||!/^node(?:\.exe)?$/i.test(path.basename(candidate.executable))||!Array.isArray(candidate.executable_args)||candidate.executable_args.length!==1)return null;
    const script=candidate.executable_args[0];if(typeof script!=='string'||!path.isAbsolute(script)||!/[\\/]node_modules[\\/]@google[\\/]gemini-cli[\\/]bundle[\\/]gemini\.js$/i.test(script))return null;
    try{
      const packageFile=path.join(path.dirname(path.dirname(script)),'package.json');if(fs.statSync(packageFile).size>MAX_TEXT)return null;
      const pkg=JSON.parse(fs.readFileSync(packageFile,'utf8'));
      if(pkg.name!=='@google/gemini-cli'||!VERSION.test(pkg.version)||!versionAtLeast(pkg.version,GEMINI_VERSION)||pkg.bin?.gemini!=='bundle/gemini.js')return null;
      const node=await this.runner(candidate.executable,['--version'],{cwd:path.dirname(script),env:this.options.env||process.env,windowsHide:true,shell:false,timeout:20000});
      const nodeVersion=String(node.stdout||'').trim().match(/^v(\d+\.\d+\.\d+)$/)?.[1];if(node.exitCode!==0||!nodeVersion||!versionAtLeast(nodeVersion,'20.0.0'))return null;
      const result=await this.runner(candidate.executable,[script,'--version'],{cwd:path.dirname(script),env:this.options.env||process.env,windowsHide:true,shell:false,timeout:20000});
      if(result.exitCode!==0||String(result.stdout||'').trim()!==pkg.version)return null;
      // Existing package provenance comes from the user's installation; do not
      // mislabel it as a newly downloaded/cryptographically pinned artifact.
      return this.publish({provider:'gemini-cli',version:pkg.version,executable:candidate.executable,executable_args:[script],runtime_owned:false,node_version:nodeVersion,origin:'existing-official-package',unchanged:true,installed_at:now()});
    }catch{return null;}
  }
  rejectLinks(folder){
    const root=this.assertOwned(folder),pending=[root];let count=0;
    while(pending.length){const current=pending.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true})){if(++count>50000)throw new RoomError('运行时文件数量超过限制。',409,'runtime_archive_invalid');const file=this.assertOwned(path.join(current,entry.name)),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw new RoomError('运行时展开结果含链接。',409,'runtime_archive_unsafe');if(stat.isDirectory())pending.push(file);else if(!stat.isFile())throw new RoomError('运行时展开结果含特殊文件。',409,'runtime_archive_unsafe');}}
  }
  async perform(provider){
    const platform=this.options.platform||process.platform,arch=this.options.arch||process.arch;
    if(platform!=='win32'||arch!=='x64')throw new RoomError('一键运行时安装目前支持 Windows x64。',409,'runtime_platform_unsupported');
    if(provider==='gemini-cli')return this.performGemini();
    let version=this.options.versions?.[provider]|| (provider==='qwen-code'?'0.25.1':null);
    if(!version)version=(await this.bytes(`https://${CLAUDE_HOST}/claude-code-releases/latest`,MAX_TEXT)).toString('utf8').trim();
    if(!VERSION.test(version)||!versionAtLeast(version,provider==='qwen-code'?'0.25.1':'2.1.259'))throw new RoomError('官方运行时版本格式或最低版本不符合适配要求。',409,'runtime_version_unsupported');
    const old=await this.reusable(provider,version);if(old)return old;
    fs.mkdirSync(this.root,{recursive:true});this.assertOwned(path.join(this.root,provider));
    const workspace=this.assertOwned(path.join(this.root,provider,`${version}-${id()}`));fs.mkdirSync(workspace,{recursive:true});
    try{
      let checksum,buffer,executable,args=[];
      if(provider==='qwen-code'){
        const base=`https://${QWEN_HOST}/releases/qwen-code/v${version}`,name='qwen-code-win-x64.zip';
        const sums=(await this.bytes(`${base}/SHA256SUMS`,MAX_TEXT)).toString('utf8'),matches=sums.split(/\r?\n/).map(line=>line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)\s*$/i)).filter(match=>match&&match[2]===name);
        if(matches.length!==1)throw new RoomError('官方 Qwen 清单缺少唯一的 Windows 校验值。',409,'runtime_manifest_invalid');checksum=matches[0][1].toLowerCase();buffer=await this.bytes(`${base}/${name}`,MAX_BINARY);
        if(sha(buffer)!==checksum)throw new RoomError('官方运行时 SHA-256 校验失败。',409,'runtime_checksum_mismatch');
        const entries=zipEntries(buffer),archive=path.join(workspace,name),payload=path.join(workspace,'payload');atomicWrite(archive,buffer);fs.mkdirSync(payload);
        await this.extractor(archive,payload,{runner:this.runner,entries});this.rejectLinks(payload);
        executable=path.join(payload,'qwen-code','node','node.exe');
        const scripts=entries.filter(entry=>!entry.directory&&/(?:^|\/)cli-entry\.js$/.test(entry.name)).map(entry=>path.join(payload,...entry.name.replace(/\\/g,'/').split('/')));
        if(scripts.length!==1||!fs.existsSync(executable)||!fs.existsSync(scripts[0]))throw new RoomError('官方 Qwen 包缺少可验证的 Node 和命令入口。',409,'runtime_layout_invalid');args=[scripts[0]];
        fs.unlinkSync(this.assertOwned(archive));
      }else{
        const base=`https://${CLAUDE_HOST}/claude-code-releases/${version}`;
        let manifest;try{manifest=JSON.parse((await this.bytes(`${base}/manifest.json`,MAX_TEXT)).toString('utf8'));}catch(error){if(error instanceof RoomError)throw error;throw new RoomError('官方 Claude 清单不是有效 JSON。',409,'runtime_manifest_invalid');}
        checksum=manifest?.platforms?.['win32-x64']?.checksum;if(!(/^[a-f0-9]{64}$/i).test(checksum||''))throw new RoomError('官方 Claude 清单缺少 Windows 校验值。',409,'runtime_manifest_invalid');checksum=checksum.toLowerCase();buffer=await this.bytes(`${base}/win32-x64/claude.exe`,MAX_BINARY);
        if(sha(buffer)!==checksum)throw new RoomError('官方运行时 SHA-256 校验失败。',409,'runtime_checksum_mismatch');
        executable=path.join(workspace,'claude.exe');atomicWrite(executable,buffer);
      }
      const record={provider,version,executable,executable_args:args,verified_sha256:checksum,installed_at:now(),files:[executable,...args].map(file=>({path:file,sha256:sha(fs.readFileSync(file))}))};
      await this.metadata(record);atomicWrite(path.join(workspace,'agentroom-runtime.json'),JSON.stringify(record,null,2)+'\n');return this.publish(record);
    }catch(error){
      // Only the fresh UUID workspace owned by this attempt can be removed.
      // Previous versions and any unknown directories are preserved.
      const target=this.assertOwned(workspace),canonical=fs.realpathSync.native(target),rootCanonical=fs.realpathSync.native(this.root);
      if(!inside(rootCanonical,canonical))throw new RoomError('失败的运行时目录不能安全清理。',403,'runtime_path_invalid');
      try{fs.rmSync(target,{recursive:true,force:true});}catch{}throw error;
    }
  }
  async performGemini(){
    const version=this.options.versions?.['gemini-cli']||GEMINI_VERSION;
    const release=this.options.geminiRelease||GEMINI_RELEASE,nodeRelease=this.options.nodeRelease||NODE_RELEASE;
    if(!VERSION.test(version)||version!==release.version||version!==GEMINI_VERSION||nodeRelease.version!==NODE_VERSION||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.integrity||'')||!/^[a-f0-9]{64}$/.test(release.sha256||'')||!/^[a-f0-9]{64}$/.test(nodeRelease.sha256||'')||!Number.isSafeInteger(release.size)||release.size<1||release.size>32*1024*1024)throw new RoomError('Gemini 官方运行时清单不符合受支持版本。',409,'runtime_manifest_invalid');
    const reusable=await this.reusable('gemini-cli',version);if(reusable)return reusable;
    const existing=await this.existingGemini();if(existing)return existing;
    this.assertOwned(path.join(this.root,'gemini-cli'));fs.mkdirSync(this.root,{recursive:true});
    const workspace=this.assertOwned(path.join(this.root,'gemini-cli',`${version}-${id()}`));fs.mkdirSync(workspace,{recursive:true});
    const registry=`https://registry.npmjs.org/@google/gemini-cli/${version}`,tarball=`https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${version}.tgz`,nodeName=`node-v${NODE_VERSION}-win-x64.zip`,nodeBase=`https://nodejs.org/dist/v${NODE_VERSION}`;
    let stage='download_package_metadata';
    try{
      let manifest;try{manifest=JSON.parse((await this.bytes(registry,MAX_TEXT)).toString('utf8'));}catch(error){if(error instanceof RoomError)throw error;throw new RoomError('Gemini 官方 npm 元数据不可用，请稍后重试。',503,'runtime_manifest_invalid');}
      if(manifest.name!=='@google/gemini-cli'||manifest.version!==version||manifest.bin?.gemini!=='bundle/gemini.js'||manifest.dist?.tarball!==tarball||manifest.dist?.integrity!==release.integrity||Object.keys(manifest.dependencies||{}).length)throw new RoomError('Gemini 官方 npm 元数据与固定清单不一致。',409,'runtime_manifest_invalid');
      stage='download_node_manifest';
      const sums=(await this.bytes(`${nodeBase}/SHASUMS256.txt`,MAX_TEXT)).toString('utf8'),matches=sums.split(/\r?\n/).map(line=>line.match(/^([a-f0-9]{64})\s+\*?([^\s]+)\s*$/i)).filter(match=>match&&match[2]===nodeName);
      if(matches.length!==1||matches[0][1].toLowerCase()!==nodeRelease.sha256)throw new RoomError('Node 官方 Windows 校验清单不一致。',409,'runtime_manifest_invalid');
      stage='download_package';const packageBytes=await this.bytes(tarball,32*1024*1024);
      stage='verify_package';
      if(packageBytes.length!==release.size||sha(packageBytes)!==release.sha256||`sha512-${crypto.createHash('sha512').update(packageBytes).digest('base64')}`!==release.integrity)throw new RoomError('Gemini 官方 npm 包完整性校验失败。',409,'runtime_checksum_mismatch');
      stage='download_node';const nodeBytes=await this.bytes(`${nodeBase}/${nodeName}`,80*1024*1024);
      stage='verify_node';if(sha(nodeBytes)!==nodeRelease.sha256)throw new RoomError('Node 官方运行时 SHA-256 校验失败。',409,'runtime_checksum_mismatch');
      stage='parse_archives';const packageEntries=tarEntries(packageBytes),nodeEntries=zipEntries(nodeBytes,{allowedRoots:[`node-v${NODE_VERSION}-win-x64`]});
      const packageEntry=packageEntries.find(entry=>entry.name==='package/package.json'&&!entry.directory),cliEntry=packageEntries.find(entry=>entry.name==='package/bundle/gemini.js'&&!entry.directory);
      let packageMetadata;try{packageMetadata=packageEntry&&packageEntry.size<=MAX_TEXT&&JSON.parse(packageEntry.data.toString('utf8'));}catch{}
      if(!cliEntry||packageMetadata?.name!=='@google/gemini-cli'||packageMetadata.version!==version||packageMetadata.bin?.gemini!=='bundle/gemini.js'||Object.keys(packageMetadata.dependencies||{}).length)throw new RoomError('Gemini 官方包缺少受支持的独立命令入口。',409,'runtime_layout_invalid');
      const payload=this.assertOwned(path.join(workspace,'payload')),nodeTarget=this.assertOwned(path.join(workspace,'node'));fs.mkdirSync(payload);fs.mkdirSync(nodeTarget);
      stage='extract_package';this.extractTar(packageEntries,payload);
      stage='extract_node';const nodeArchive=this.assertOwned(path.join(workspace,nodeName));atomicWrite(nodeArchive,nodeBytes);await this.extractor(nodeArchive,nodeTarget,{runner:this.runner,entries:nodeEntries});this.rejectLinks(nodeTarget);this.checkExtracted(nodeTarget,nodeEntries);fs.unlinkSync(nodeArchive);
      const executable=this.assertOwned(path.join(nodeTarget,`node-v${NODE_VERSION}-win-x64`,'node.exe')),script=this.assertOwned(path.join(payload,'package','bundle','gemini.js'));
      if(!fs.existsSync(executable)||!fs.statSync(executable).isFile()||!fs.existsSync(script)||!fs.statSync(script).isFile())throw new RoomError('官方包缺少 Node 或 Gemini 命令入口。',409,'runtime_layout_invalid');
      stage='record_files';const files=[...this.filesIn(payload),...this.filesIn(nodeTarget)].map(file=>({path:file,sha256:sha(fs.readFileSync(file))}));
      const record={provider:'gemini-cli',version,executable,executable_args:[script],runtime_owned:true,origin:'official-npm-package',node_version:NODE_VERSION,verified_sha256:release.sha256,verified_integrity:release.integrity,node_sha256:nodeRelease.sha256,installed_at:now(),files_complete:true,content_roots:[payload,nodeTarget],files,artifacts:[{name:`gemini-cli-${version}.tgz`,source:tarball,size:packageBytes.length,sha256:release.sha256,integrity:release.integrity},{name:nodeName,source:`${nodeBase}/${nodeName}`,size:nodeBytes.length,sha256:nodeRelease.sha256}]};
      stage='probe_version';await this.metadata(record);atomicWrite(path.join(workspace,'agentroom-runtime.json'),JSON.stringify(record,null,2)+'\n');return this.publish(record);
    }catch(error){
      // Only the newly allocated UUID tree is cleaned. Existing installations,
      // previous owned versions and user npm/PATH/account state stay intact.
      const failure=error instanceof Error&&Object.isExtensible(error)?error:new RoomError('官方 Gemini 运行时安装未完成，请重试该步骤。',503,'runtime_install_failed');failure.stage=stage;
      const target=this.assertOwned(workspace),canonical=fs.realpathSync.native(target),rootCanonical=fs.realpathSync.native(this.root);
      if(!inside(rootCanonical,canonical))throw new RoomError('失败的 Gemini 运行时目录不能安全清理。',403,'runtime_path_invalid');
      try{fs.rmSync(target,{recursive:true,force:true});}catch{}throw failure;
    }
  }
  async close(){this.closing=true;for(const owner of this.jobOwners.values())owner.abort.abort();await Promise.allSettled([...this.jobs.values()]);}
}
module.exports={RuntimeInstaller,zipEntries,tarEntries,validOfficialUrl,GEMINI_VERSION,NODE_VERSION,GEMINI_RELEASE,NODE_RELEASE};
