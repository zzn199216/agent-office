'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {RoomError,atomicWrite}=require('./util.cjs');
const {OFFICE_FILES}=require('./office-assets.cjs');
const PUBLIC_FILES=new Set(['AgentRoom.Desktop.exe','AgentRoom.Desktop.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WEBVIEW2_LICENSE.txt','desktop-web/index.html','desktop-web/app.js','desktop-web/desktop.js','desktop-web/page-activity.js','desktop-web/style.css','desktop-web/office.js','desktop-web/office.css',...OFFICE_FILES.map(name=>'desktop-web/'+name)]);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function desktopManifest(source){
  const root=path.resolve(source),file=path.join(root,'desktop-manifest.json');let value;
  try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new RoomError('桌面组件未完整解压。请将 AgentOffice.exe 和 desktop 文件夹一起保留。',409,'desktop_bundle_missing');}
  if(value.version!==require('./util.cjs').VERSION||!Array.isArray(value.files)||value.files.length!==PUBLIC_FILES.size)throw new RoomError('桌面组件清单或版本不完整。',409,'desktop_bundle_invalid');
  const seen=new Set();
  for(const entry of value.files){
    const relative=String(entry.path||'').replace(/\\/g,'/');if(!PUBLIC_FILES.has(relative)||seen.has(relative)||!(/^[a-f0-9]{64}$/).test(entry.sha256||''))throw new RoomError('桌面组件清单包含无效文件。',409,'desktop_bundle_invalid');
    seen.add(relative);const location=path.join(root,...relative.split('/'));if(!fs.existsSync(location)||!fs.statSync(location).isFile()||hash(location)!==entry.sha256)throw new RoomError('桌面组件校验失败，请重新解压完整安装包。',409,'desktop_bundle_invalid');
    const canonical=fs.realpathSync.native(location),canonicalRoot=fs.realpathSync.native(root),rel=path.relative(canonicalRoot,canonical);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new RoomError('桌面组件超出了安装包。',403,'desktop_bundle_invalid');
  }
  return value;
}
function installDesktop(source,dir,options={}){
  const manifest=desktopManifest(source),bin=path.resolve(dir,'bin'),target=options.executable?path.join(path.dirname(path.resolve(options.executable)),'desktop'):path.join(bin,'desktop'),relative=path.relative(bin,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new RoomError('桌面组件必须安装在本机程序目录内。',403,'desktop_install_collision');
  if(path.resolve(source).toLowerCase()===path.resolve(target).toLowerCase())return target;
  const marker=path.join(target,'installed.json');if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new RoomError('桌面组件目录不能使用未知链接。',403,'desktop_install_collision');
  if(fs.existsSync(target)&&fs.readdirSync(target).length){let owned;try{owned=JSON.parse(fs.readFileSync(marker,'utf8')).app==='AgentRoom.desktop';}catch{}if(!owned)throw new RoomError('桌面安装目录已有其他文件，没有覆盖。',409,'desktop_install_collision');}
  for(const entry of manifest.files){const relative=entry.path.replace(/\\/g,'/'),from=path.join(source,...relative.split('/')),to=path.join(target,...relative.split('/'));if(fs.existsSync(to)&&hash(to)===entry.sha256)continue;
    try{atomicWrite(to,fs.readFileSync(from));}catch{throw new RoomError('桌面窗口仍在使用旧组件。请关闭 AgentRoom 窗口后重新打开新版本。',409,'desktop_install_busy');}
  }
  atomicWrite(path.join(target,'desktop-manifest.json'),JSON.stringify(manifest,null,2));atomicWrite(marker,JSON.stringify({app:'AgentRoom.desktop',version:manifest.version,installed_at:new Date().toISOString()}));return target;
}
function startMenuShortcut(executable){
  if(process.platform!=='win32'||!process.env.APPDATA)return Promise.resolve(false);
  const folder=path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Agent Office'),link=path.join(folder,'Agent Office.lnk');
  const script="$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; New-Item -ItemType Directory -Path $r.folder -Force|Out-Null; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($r.link); $s.TargetPath=$r.executable; $s.Arguments='desktop'; $s.WorkingDirectory=[IO.Path]::GetDirectoryName($r.executable); $s.Description='Agent 办公室 · Agent Office'; $s.IconLocation=[IO.Path]::Combine([IO.Path]::GetDirectoryName($r.executable),'desktop','AgentRoom.Desktop.exe'); $s.Save()";
  return new Promise(resolve=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,stdio:['pipe','ignore','ignore']});child.on('error',()=>resolve(false));child.on('close',code=>resolve(code===0));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({folder,link,executable}));});
}
async function launchDesktop(dir,options={}){
  if(process.platform!=='win32')throw new RoomError('桌面窗口目前支持 Windows x64。',409,'desktop_platform_unsupported');
  const source=options.sourceArgs?.length?path.resolve(__dirname,'../dist/AgentRoom.exe'):options.source||process.execPath;
  if(!fs.existsSync(source))throw new RoomError('请先构建桌面软件包。',409,'desktop_bundle_missing');
  const desktop=path.join(path.dirname(source),'desktop');desktopManifest(desktop);
  const installed=require('./install.cjs').installBinary(source,dir),host=installDesktop(desktop,dir,{executable:installed});
  if(!options.diagnosticsDirectory)await startMenuShortcut(installed);
  const args=['--agentroom',installed,'--data-dir',dir];
  if(options.diagnosticsDirectory){args.push('--diagnostics',path.resolve(options.diagnosticsDirectory));if(options.check===true)args.push('--check');}
  const request={command:path.join(host,'AgentRoom.Desktop.exe'),args,options:{windowsHide:false,shell:false,detached:true,stdio:'ignore',cwd:host}};
  await new Promise((resolve,reject)=>{const child=spawn(request.command,request.args,request.options);child.on('error',reject);child.on('spawn',()=>{child.unref();resolve();});});
}
async function showDesktopError(error){
  if(process.platform!=='win32')return;
  const script="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; [Windows.Forms.MessageBox]::Show([string]$r.message,'Agent Office',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Warning)|Out-Null";
  await new Promise(resolve=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:false,shell:false,stdio:['pipe','ignore','ignore']});child.once('error',resolve);child.once('close',resolve);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({message:require('./util.cjs').readableError(error)}));});
}
module.exports={PUBLIC_FILES,desktopManifest,installDesktop,startMenuShortcut,launchDesktop,showDesktopError};
