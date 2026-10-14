'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const SDK_VERSION='1.0.4258.31';
const SDK_SHA256='56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9';
const SDK_URL=`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${SDK_VERSION}/microsoft.web.webview2.${SDK_VERSION}.nupkg`;
const REQUIRED_FILES=['AgentRoom.Desktop.exe','AgentRoom.Desktop.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WEBVIEW2_LICENSE.txt'];
const OFFICE_ASSETS=require('../src/office-assets.cjs').OFFICE_FILES.map(name=>name.replace('assets/office/',''));
const ASSETS=['desktop-web/index.html','desktop-web/app.js','desktop-web/style.css','desktop-web/desktop.js','desktop-web/office.js','desktop-web/office.css',...OFFICE_ASSETS.map(name=>'desktop-web/assets/office/'+name)];
function sha(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function applicationIcon(file){
  // Original AO office mark, stored in the executable; no downloaded artwork.
  const size=64,pixels=Buffer.alloc(size*size*4),mask=Buffer.alloc(size*size/8),bitmap=Buffer.alloc(40);
  bitmap.writeUInt32LE(40,0);bitmap.writeInt32LE(size,4);bitmap.writeInt32LE(size*2,8);bitmap.writeUInt16LE(1,12);bitmap.writeUInt16LE(32,14);bitmap.writeUInt32LE(pixels.length,20);
  const letters=['01110','11011','11011','11111','11011','11011','11011','01110','11011','11011','11011','11011','11011','01110'];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const corner=Math.hypot(Math.max(12-x,0,x-51),Math.max(12-y,0,y-51)),alpha=corner>12?0:255,i=((size-1-y)*size+x)*4;
    pixels[i]=86+Math.round(y/8);pixels[i+1]=108+Math.round(y/8);pixels[i+2]=31+Math.round(y/9);pixels[i+3]=alpha;
    if(alpha===0)mask[(size-1-y)*8+Math.floor(x/8)]|=1<<(7-x%8);
    const row=Math.floor((y-23)/4),column=Math.floor((x-10)/4);let white=(y>=9&&y<=18&&Math.abs(Math.abs(x-32)-(y-9)*2)<=1)||(y===18&&x>=14&&x<=50);
    if(row>=0&&row<7&&column>=0&&column<5)white=letters[row][column]==='1';
    const oColumn=Math.floor((x-35)/4);if(row>=0&&row<7&&oColumn>=0&&oColumn<5)white=white||letters[7+row][oColumn]==='1';
    if(white&&alpha){pixels[i]=pixels[i+1]=pixels[i+2]=255;}
  }
  const payload=Buffer.concat([bitmap,pixels,mask]),header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=size;header[7]=size;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(payload.length,14);header.writeUInt32LE(22,18);fs.writeFileSync(file,Buffer.concat([header,payload]));
}
function run(command,args,options={}){const result=spawnSync(command,args,{cwd:ROOT,encoding:'utf8',windowsHide:true,...options});if(result.status!==0)throw new Error((result.stderr||result.stdout||'Desktop build failed').slice(0,2500));return result.stdout;}
async function sdkPackage(){
  const dir=path.join(ROOT,'dist','webview2-sdk',SDK_VERSION),file=path.join(dir,'webview2.nupkg');fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(file)||sha(file)!==SDK_SHA256){
    const response=await fetch(SDK_URL,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Official WebView2 SDK download failed: '+response.status);
    const length=Number(response.headers.get('content-length'));if(length>16*1024*1024)throw new Error('Unexpected WebView2 SDK package size.');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>16*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==SDK_SHA256)throw new Error('WebView2 SDK SHA256 mismatch.');
    fs.writeFileSync(file,bytes);
  }
  return file;
}
async function buildDesktop({outputDir=path.join(ROOT,'dist','desktop'),version=require('../package.json').version}={}){
  const match=/^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?$/.exec(version);if(!match||match.slice(1).some(value=>Number(value)>65535))throw new Error('Desktop package version is invalid.');
  const assemblyVersion=match.slice(1).join('.')+'.0';
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Desktop build requires Windows x64.');
  outputDir=path.resolve(outputDir);fs.mkdirSync(outputDir,{recursive:true});const sdk=await sdkPackage();
  const entries=[['lib/net462/Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Core.dll'],['lib/net462/Microsoft.Web.WebView2.WinForms.dll','Microsoft.Web.WebView2.WinForms.dll'],['runtimes/win-x64/native/WebView2Loader.dll','WebView2Loader.dll'],['LICENSE.txt','WEBVIEW2_LICENSE.txt']];
  run('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead($r.package);try{foreach($item in $r.entries){$e=$z.GetEntry($item[0]);if($null -eq $e){throw 'SDK entry missing'};$target=[IO.Path]::GetFullPath((Join-Path $r.destination $item[1]));if([IO.Path]::GetDirectoryName($target) -ne [IO.Path]::GetFullPath($r.destination)){throw 'SDK extraction target outside build directory'};[IO.Compression.ZipFileExtensions]::ExtractToFile($e,$target,$true)}}finally{$z.Dispose()}"],{input:JSON.stringify({package:sdk,destination:outputDir,entries})});
  const assembly=path.join(outputDir,'AssemblyInfo.cs');fs.writeFileSync(assembly,`using System.Reflection;\n[assembly:AssemblyTitle("Agent Office")]\n[assembly:AssemblyDescription("Agent Office Local — Agent 办公室")]\n[assembly:AssemblyCompany("Agent Office Local")]\n[assembly:AssemblyProduct("Agent Office")]\n[assembly:AssemblyVersion("${assemblyVersion}")]\n[assembly:AssemblyFileVersion("${assemblyVersion}")]\n`,{encoding:'utf8'});
  const compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  if(!fs.existsSync(compiler))throw new Error('Windows .NET Framework C# compiler is unavailable.');
  const executable=path.join(outputDir,'AgentRoom.Desktop.exe');
  const icon=path.join(outputDir,'AgentRoom.ico');applicationIcon(icon);
  run(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/langversion:5',`/out:${executable}`,`/win32icon:${icon}`,`/win32manifest:${path.join(ROOT,'desktop','app.manifest')}`,'/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',`/r:${path.join(outputDir,'Microsoft.Web.WebView2.Core.dll')}`,`/r:${path.join(outputDir,'Microsoft.Web.WebView2.WinForms.dll')}`,path.join(ROOT,'desktop','Program.cs'),assembly]);
  fs.copyFileSync(path.join(ROOT,'desktop','AgentRoom.Desktop.exe.config'),path.join(outputDir,'AgentRoom.Desktop.exe.config'));
  const webRoot=fs.realpathSync(path.join(ROOT,'web')).toLowerCase()+path.sep;
  for(const asset of ASSETS){
    const source=path.join(ROOT,'web',...asset.slice('desktop-web/'.length).split('/')),target=path.join(outputDir,...asset.split('/'));
    if(!fs.lstatSync(source).isFile()||!fs.realpathSync(source).toLowerCase().startsWith(webRoot))throw new Error('Desktop public asset is not a regular file within web/: '+asset);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
  }
  const manifest={directory:outputDir,requiredFiles:REQUIRED_FILES.slice(),assets:ASSETS.slice(),version,sdk_version:SDK_VERSION,sdk_sha256:SDK_SHA256,sdk_source:SDK_URL,files:[...REQUIRED_FILES,...ASSETS].map(name=>({path:name,sha256:sha(path.join(outputDir,name)),bytes:fs.statSync(path.join(outputDir,name)).size}))};
  fs.writeFileSync(path.join(outputDir,'desktop-build.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
module.exports={buildDesktop,SDK_VERSION,SDK_SHA256,REQUIRED_FILES,ASSETS,OFFICE_ASSETS};
if(require.main===module)buildDesktop().then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
