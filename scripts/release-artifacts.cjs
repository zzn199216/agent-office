'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {sha,regularFile,safeRelative}=require('./release-common.cjs');
function readManifest(directory,version,source){
  const manifest=JSON.parse(fs.readFileSync(regularFile(directory,'release-manifest.json'),'utf8'));
  if(manifest.schema!=='agentoffice.release'||manifest.version!==version||manifest.source?.fingerprint!==source.fingerprint||manifest.source?.head!==source.head||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Package provenance does not match the current source.');
  const names=new Set();for(const item of manifest.files){if(!safeRelative(item.path)||names.has(item.path.toLowerCase())||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<0)throw new Error('Package manifest is invalid.');names.add(item.path.toLowerCase());const file=regularFile(directory,item.path);if(fs.statSync(file).size!==item.bytes||sha(file)!==item.sha256)throw new Error('Artifact checksum mismatch: '+item.path);}
  for(const name of ['AgentOffice.exe','OPEN_TEST.cmd','desktop/desktop-manifest.json','desktop/AgentRoom.Desktop.exe','desktop/desktop-web/app.js'])if(!names.has(name.toLowerCase()))throw new Error('Required package artifact is absent: '+name);
  const desktop=JSON.parse(fs.readFileSync(regularFile(directory,'desktop/desktop-manifest.json'),'utf8'));
  if(desktop.version!==version||!Array.isArray(desktop.files))throw new Error('Desktop manifest version is incorrect.');
  for(const item of desktop.files){const file=regularFile(directory,'desktop/'+item.path.replaceAll('\\','/'));if(sha(file)!==item.sha256||fs.statSync(file).size!==item.bytes)throw new Error('Desktop checksum mismatch: '+item.path);}
  return manifest;
}
function zipEntries(zip){
  if(!fs.lstatSync(zip).isFile()||fs.lstatSync(zip).isSymbolicLink())throw new Error('ZIP must be a regular file.');
  const script="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$file=[Console]::In.ReadToEnd();Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($file);$rows=@();try{foreach($entry in $zip.Entries){if($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\\')){continue};$stream=$entry.Open();$hash=[Security.Cryptography.SHA256]::Create();try{$rows+=@{path=$entry.FullName.Replace('\\','/');bytes=$entry.Length;sha256=([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}}finally{$hash.Dispose();$stream.Dispose()}};ConvertTo-Json -Depth 4 -InputObject @($rows)}finally{$zip.Dispose()}";
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:path.resolve(zip),encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024,timeout:120000});
  if(result.status!==0)throw new Error('ZIP verification failed: '+(result.stderr||result.error?.message||'unknown').slice(0,1000));const entries=JSON.parse(result.stdout.replace(/^\uFEFF/,''));return Array.isArray(entries)?entries:[entries];
}
function verifyArtifacts(directory,zip,version,source,entries=zipEntries){
  const manifest=readManifest(directory,version,source),expected=[...manifest.files,{path:'release-manifest.json',bytes:fs.statSync(path.join(directory,'release-manifest.json')).size,sha256:sha(path.join(directory,'release-manifest.json'))}],actual=entries(zip),seen=new Set();
  if(actual.length!==expected.length)throw new Error('ZIP public file list differs from the package.');
  for(const item of actual){if(!safeRelative(item.path)||seen.has(item.path.toLowerCase()))throw new Error('ZIP contains an unsafe or duplicate entry.');seen.add(item.path.toLowerCase());const file=expected.find(file=>file.path===item.path);if(!file||file.sha256!==item.sha256||file.bytes!==item.bytes)throw new Error('ZIP differs from the verified package: '+item.path);}
  return {manifest,files:expected,artifacts:[...['AgentOffice.exe','desktop/AgentRoom.Desktop.exe','release-manifest.json'].map(name=>({path:path.join(directory,...name.split('/')),sha256:sha(path.join(directory,...name.split('/'))),bytes:fs.statSync(path.join(directory,...name.split('/'))).size})),{path:zip,sha256:sha(zip),bytes:fs.statSync(zip).size}]};
}
function publishArtifacts(root,directory,zip,verified,runId){
  const releaseRoot=path.join(root,'release');fs.mkdirSync(releaseRoot,{recursive:true});let destination=path.join(releaseRoot,path.basename(directory));
  if(fs.existsSync(destination)||fs.existsSync(destination+'.zip'))destination+='-'+runId;
  fs.mkdirSync(destination);for(const item of verified.files){const target=path.join(destination,...item.path.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(regularFile(directory,item.path),target,fs.constants.COPYFILE_EXCL);if(sha(target)!==item.sha256)throw new Error('Published artifact checksum mismatch.');}
  const targetZip=destination+'.zip';fs.copyFileSync(zip,targetZip,fs.constants.COPYFILE_EXCL);if(sha(targetZip)!==sha(zip))throw new Error('Published ZIP checksum mismatch.');
  return {package_directory:destination,zip_path:targetZip,artifacts:verified.artifacts.map(item=>({...item,path:item.path===zip?targetZip:path.join(destination,path.relative(directory,item.path))}))};
}
module.exports={readManifest,zipEntries,verifyArtifacts,publishArtifacts};
