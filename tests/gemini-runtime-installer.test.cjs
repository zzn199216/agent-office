'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {RuntimeInstaller,tarEntries,zipEntries,validOfficialUrl,GEMINI_VERSION,NODE_VERSION}=require('../src/runtime-installer.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const integrity=bytes=>'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');
function tar(files,options={}){
  const blocks=[];
  for(const file of files){
    const header=Buffer.alloc(512),content=Buffer.from(file.content||''),name=file.name;
    header.write(file.prefix?name.slice(name.lastIndexOf('/')+1):name,0,100,'utf8');
    if(file.prefix)header.write(name.slice(0,name.lastIndexOf('/')),345,155,'utf8');
    header.write('0000644\0',100,'ascii');header.write('0000000\0',108,'ascii');header.write('0000000\0',116,'ascii');
    header.write((file.declaredSize??content.length).toString(8).padStart(11,'0')+'\0',124,'ascii');header.write('00000000000\0',136,'ascii');header.fill(32,148,156);
    header[156]=(file.type||'0').charCodeAt(0);if(file.link)header.write(file.link,157,100,'utf8');header.write('ustar\0',257,'ascii');header.write('00',263,'ascii');
    let checksum=0;for(const byte of header)checksum+=byte;header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
    blocks.push(header,content,Buffer.alloc((512-content.length%512)%512));
  }
  blocks.push(Buffer.alloc(options.noEnding?0:1024));return zlib.gzipSync(Buffer.concat(blocks));
}
function zip(files){
  const locals=[],central=[];let offset=0;
  for(const file of files){const name=Buffer.from(file.name),content=Buffer.from(file.content||''),local=Buffer.alloc(30),directory=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(content.length,18);local.writeUInt32LE(file.declaredSize??content.length,22);local.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(content.length,20);directory.writeUInt32LE(file.declaredSize??content.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE((file.attributes||0)>>>0,38);directory.writeUInt32LE(offset,42);
    const body=Buffer.concat([local,name,content]);locals.push(body);central.push(Buffer.concat([directory,name]));offset+=body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-gemini-install-')),data=path.join(root,'data');fs.mkdirSync(data);
  const packageMetadata={name:'@google/gemini-cli',version:GEMINI_VERSION,type:'module',bin:{gemini:'bundle/gemini.js'},engines:{node:'>=20'}};
  const packageFiles=overrides.packageFiles||[
    {name:'package/package.json',content:JSON.stringify(packageMetadata)},
    {name:'package/bundle/gemini.js',content:'import "./chunk.js";'},
    {name:'package/bundle/chunk.js',content:'fixture vendor chunk'},
    {name:'package/bundle/bundled/third_party/a-very-long-path-name-for-official-bundle-assets/deep-notice.md',content:'fixture notice',prefix:true},
    {name:'package/README.md',content:'fixture readme'}
  ];
  const packageBytes=overrides.packageBytes||tar(packageFiles),nodeFiles=overrides.nodeFiles||[{name:`node-v${NODE_VERSION}-win-x64/node.exe`,content:'verified fake node executable'},{name:`node-v${NODE_VERSION}-win-x64/NOTICE.txt`,content:'verified dependency file'}],nodeBytes=overrides.nodeBytes||zip(nodeFiles);
  const release={version:GEMINI_VERSION,sha256:sha(packageBytes),integrity:integrity(packageBytes),size:packageBytes.length},nodeRelease={version:NODE_VERSION,sha256:sha(nodeBytes)};
  const settings=new Map(),requests=[],commands=[],extracts=[],env={};let changes=0;
  const service={store:{dir:data,setting(key,value){if(value===undefined)return settings.get(key)||null;settings.set(key,value);return value;}},chat:{discovery:{env}},changed(){changes++;}};
  const registry=`https://registry.npmjs.org/@google/gemini-cli/${GEMINI_VERSION}`,tarball=`https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${GEMINI_VERSION}.tgz`,nodeName=`node-v${NODE_VERSION}-win-x64.zip`;
  const manifest={...packageMetadata,dist:{tarball,integrity:release.integrity,fileCount:packageFiles.length,unpackedSize:packageFiles.reduce((n,file)=>n+Buffer.byteLength(file.content||''),0)}};
  const fetch=async(url,options)=>{requests.push({url,options});if(overrides.fetch)return overrides.fetch(url,options,{packageBytes,nodeBytes,manifest,nodeRelease});
    if(url===registry)return new Response(JSON.stringify(overrides.manifest||manifest),{status:200});
    if(url===tarball)return new Response(overrides.downloadPackage||packageBytes,{status:200});
    if(url.endsWith('/SHASUMS256.txt'))return new Response(`${overrides.nodeChecksum||nodeRelease.sha256}  ${nodeName}\n`,{status:200});
    if(url.endsWith('/'+nodeName))return new Response(overrides.downloadNode||nodeBytes,{status:200});throw new Error('unexpected fixture URL');};
  const runner=async(command,args,options)=>{commands.push({command,args,options});if(overrides.runner)return overrides.runner(command,args,options);return{exitCode:0,stdout:args.length===1?`v${NODE_VERSION}\n`:`${GEMINI_VERSION}\n`,stderr:''};};
  const extractor=async(archive,target,options)=>{extracts.push({archive,target,options});if(overrides.extractor)return overrides.extractor(archive,target,options);
    for(const file of nodeFiles){const out=path.join(target,...file.name.split('/'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,file.content||'');}};
  const installer=new RuntimeInstaller(service,{fetch,runner,extractor,platform:'win32',arch:'x64',geminiRelease:release,nodeRelease,...overrides.options});
  t.after(async()=>{await installer.close();const absolute=path.resolve(root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^agentoffice-gemini-install-/);fs.rmSync(absolute,{recursive:true,force:true});});
  return{root,data,service,settings,requests,commands,extracts,env,installer,packageBytes,nodeBytes,nodeFiles,manifest,release,nodeRelease,registry,tarball,get changes(){return changes;}};
}
test('Gemini owned install verifies npm SHA-512 and Node SHA-256 then probes only metadata',async t=>{
  const v=fixture(t),result=await v.installer.install({provider:'gemini-cli',url:'https://evil.invalid',command:'npm install malicious',version:'999.0.0'});
  assert.equal(result.status,'installed');assert.equal(result.installed,true);assert.equal(result.connected,false);assert.equal(result.version,GEMINI_VERSION);assert.equal(result.runtime_owned,true);
  assert.deepEqual(v.requests.map(call=>call.url),[v.registry,`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,v.tarball,`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`]);
  assert.ok(v.requests.every(call=>call.options.redirect==='manual'&&call.options.signal));assert.equal(v.extracts.length,1);
  assert.match(result.executable,new RegExp(`node-v${NODE_VERSION.replace(/\./g,'\\.')}-win-x64[\\\\/]node\\.exe$`));assert.ok(result.executable_args[0].endsWith(path.join('payload','package','bundle','gemini.js')));
  assert.deepEqual(v.commands.map(call=>call.args),[['--version'],[result.executable_args[0],'--version']]);assert.ok(v.commands.every(call=>call.options.shell===false&&call.options.windowsHide===true));
  assert.equal(result.verified_integrity,v.release.integrity);assert.equal(result.verified_sha256,sha(v.packageBytes));assert.equal(result.node_sha256,sha(v.nodeBytes));assert.equal(result.files_complete,true);assert.equal(result.files.length,7);assert.equal(result.artifacts.length,2);
  assert.ok(result.files.some(file=>file.path.endsWith('chunk.js')));assert.ok(result.files.some(file=>file.path.endsWith('NOTICE.txt')));
  assert.equal(v.env.AGENTROOM_GEMINI_PATH,result.executable);assert.equal(v.env.AGENTROOM_GEMINI_SCRIPT,result.executable_args[0]);assert.equal(v.env.PATH,undefined);assert.equal(result.signed_in,undefined);
});
test('Gemini simultaneous install requests share one job and reuse validates all bundle and Node files',async t=>{
  const v=fixture(t),first=v.installer.install({provider:'gemini-cli'}),same=v.installer.install({provider:'gemini-cli'});assert.equal(first,same);
  const initial=await first,reused=await v.installer.install({provider:'gemini-cli'});assert.equal(reused.unchanged,true);assert.equal(reused.executable,initial.executable);assert.equal(v.requests.length,4);assert.equal(v.extracts.length,1);assert.equal(v.commands.length,4);
});
test('Gemini changed dependent chunk and Node asset cause new isolated installs without erasing previous bytes',async t=>{
  const v=fixture(t),first=await v.installer.install({provider:'gemini-cli'}),chunk=first.files.find(file=>file.path.endsWith('chunk.js')).path;fs.writeFileSync(chunk,'user changed chunk');
  const second=await v.installer.install({provider:'gemini-cli'});assert.notEqual(second.executable,first.executable);assert.equal(fs.readFileSync(chunk,'utf8'),'user changed chunk');
  const dependency=second.files.find(file=>file.path.endsWith('NOTICE.txt')).path;fs.unlinkSync(dependency);
  const third=await v.installer.install({provider:'gemini-cli'});assert.notEqual(third.executable,second.executable);assert.equal(v.extracts.length,3);
});
test('Gemini changed file inventory cannot be hidden by removing a file from the stored receipt',async t=>{
  const v=fixture(t),first=await v.installer.install({provider:'gemini-cli'}),record=v.settings.get('runtime.gemini-cli');record.files=record.files.filter(file=>!file.path.endsWith('chunk.js'));
  const second=await v.installer.install({provider:'gemini-cli'});assert.notEqual(second.executable,first.executable);assert.equal(v.extracts.length,2);
});
test('Gemini artifact integrity and Node digest failures stop before extraction or execution',async t=>{
  const badPackage=fixture(t,{downloadPackage:Buffer.from('tampered npm tarball')}),p=await badPackage.installer.install({provider:'gemini-cli'});assert.equal(p.reason,'runtime_checksum_mismatch');assert.equal(p.stage,'verify_package');assert.equal(badPackage.extracts.length,0);assert.equal(badPackage.commands.length,0);
  const badNode=fixture(t,{downloadNode:Buffer.from('tampered node zip')}),n=await badNode.installer.install({provider:'gemini-cli'});assert.equal(n.reason,'runtime_checksum_mismatch');assert.equal(n.stage,'verify_node');assert.equal(badNode.extracts.length,0);assert.equal(badNode.commands.length,0);
});
test('Gemini npm metadata mismatch, extra dependency and ambiguous Node checksums stop safely',async t=>{
  const v=fixture(t,{fetch:async(url,_options,values)=>new Response(url.endsWith('/SHASUMS256.txt')?'':JSON.stringify({...values.manifest,dependencies:{'untrusted-dependency':'*'}}),{status:200})}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_manifest_invalid');assert.equal(result.stage,'download_package_metadata');assert.equal(v.requests.length,1);assert.equal(v.commands.length,0);
  const node=fixture(t,{nodeChecksum:'a'.repeat(64)}),failed=await node.installer.install({provider:'gemini-cli'});assert.equal(failed.reason,'runtime_manifest_invalid');assert.equal(failed.stage,'download_node_manifest');assert.equal(node.requests.length,2);assert.equal(node.commands.length,0);
});
test('Gemini fails with actionable stage and keeps old runtime and sensitive diagnostics private',async t=>{
  const v=fixture(t,{fetch:async()=>{throw new Error('secret-provider-key-and-private-prompt');}}),old={provider:'gemini-cli',version:'old',executable:'existing untouched'};v.settings.set('runtime.gemini-cli',old);
  const result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.installed,false);assert.equal(result.stage,'download_package_metadata');assert.doesNotMatch(result.detail,/secret|private-prompt/);assert.deepEqual(v.settings.get('runtime.gemini-cli'),old);assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','gemini-cli')),[]);
});
test('Gemini does not publish if Node or CLI metadata disagrees with pinned package version',async t=>{
  for(const variant of ['node','cli']){const v=fixture(t,{runner:async(_command,args)=>({exitCode:0,stdout:args.length===1?(variant==='node'?'v18.0.0':`v${NODE_VERSION}`):(variant==='cli'?'0.1.0':GEMINI_VERSION),stderr:'ignored private failure'})}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_version_mismatch');assert.equal(result.stage,'probe_version');assert.equal(v.settings.size,0);assert.equal(v.env.AGENTROOM_GEMINI_PATH,undefined);assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','gemini-cli')),[]);}
});
test('Gemini Node extraction must match every central-directory filename and size',async t=>{
  const v=fixture(t,{extractor:async(_archive,target)=>{fs.writeFileSync(path.join(target,'arbitrary.cmd'),'must not run');}}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_layout_invalid');assert.equal(result.stage,'extract_node');assert.equal(v.commands.length,0);assert.equal(v.settings.size,0);
});
test('unexpected frozen extraction errors still expose the failed stage and clean only the fresh UUID tree',async t=>{
  const v=fixture(t,{extractor:async()=>{throw Object.freeze(new Error('private-provider-token'));}}),result=await v.installer.install({provider:'gemini-cli'});
  assert.equal(result.reason,'runtime_install_failed');assert.equal(result.stage,'extract_node');assert.doesNotMatch(result.detail,/private-provider-token/);assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','gemini-cli')),[]);assert.equal(v.commands.length,0);
});
test('official runtime URL list rejects remote scripts, unrelated npm packages, credentials and arbitrary redirect hosts',async t=>{
  for(const value of ['https://registry.npmjs.org/@google/other-package/0.63.0','https://registry.npmjs.org/@google/gemini-cli/0.63.0?token=secret','https://registry.npmjs.org/@google/gemini-cli/-/install.js','http://nodejs.org/dist/v22.22.2/SHASUMS256.txt','https://nodejs.org/dist/v99.0.0/SHASUMS256.txt','https://user:pass@registry.npmjs.org/@google/gemini-cli/0.63.0','https://release-assets.githubusercontent.com/123/fixture?sig=x'])assert.throws(()=>validOfficialUrl(value),error=>error.code==='runtime_source_invalid');
  const v=fixture(t,{fetch:async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid/package.tgz'}})}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_source_invalid');assert.equal(v.requests.length,1);assert.equal(v.commands.length,0);
});
test('oversized response headers and stream payloads are bounded before processing npm metadata',async t=>{
  const v=fixture(t,{fetch:async()=>new Response('{}',{status:200,headers:{'content-length':String(3*1024*1024)}})}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_download_too_large');assert.equal(v.commands.length,0);
});
test('TAR accepts verified USTAR prefix paths but rejects traversal, Windows reserved paths and aliases',()=>{
  const allowed=tarEntries(tar([{name:'package/bundle/long-directory-name/long-file.js',prefix:true,content:'source'}]));assert.equal(allowed[0].name,'package/bundle/long-directory-name/long-file.js');assert.equal(allowed[0].data.toString(),'source');
  for(const name of ['../outside','package/../outside','package\\..\\outside','/package/entry','C:/package/file','package/key:stream','package/con.js','package/trim.','other/file'])assert.throws(()=>tarEntries(tar([{name,content:'bad'}])),error=>error.code==='runtime_archive_unsafe',name);
  assert.throws(()=>tarEntries(tar([{name:'package/FILE.js'},{name:'package/file.js'}])),error=>error.code==='runtime_archive_unsafe');
  assert.throws(()=>tarEntries(tar([{name:'package/bundle',content:'file'},{name:'package/bundle/entry.js',content:'nested'}])),error=>error.code==='runtime_archive_unsafe');
});
test('TAR rejects symlinks, hardlinks, PAX/GNU headers, invalid checksum and truncated archives',()=>{
  for(const type of ['1','2','3','4','6','x','g','L','K'])assert.throws(()=>tarEntries(tar([{name:'package/link',type,link:type==='1'||type==='2'?'outside':''}])),error=>error.code==='runtime_archive_unsafe');
  const bytes=zlib.gunzipSync(tar([{name:'package/file',content:'file'}]));bytes[0]^=1;assert.throws(()=>tarEntries(zlib.gzipSync(bytes)),error=>error.code==='runtime_archive_invalid');
  assert.throws(()=>tarEntries(tar([{name:'package/file',content:'body'}],{noEnding:true})),error=>error.code==='runtime_archive_invalid');
  assert.throws(()=>tarEntries(Buffer.from('not gzip')),error=>error.code==='runtime_archive_invalid');
});
test('TAR and ZIP decompression limits reject forged sizes before writing or running code',()=>{
  assert.throws(()=>tarEntries(tar([{name:'package/file',content:'x',declaredSize:129*1024*1024}])),error=>error.code==='runtime_archive_invalid');
  assert.throws(()=>tarEntries(tar([{name:'package/file',content:'x'.repeat(4096)}]),{maxOutputBytes:1024}),error=>error.code==='runtime_archive_invalid');
  assert.throws(()=>zipEntries(zip([{name:`node-v${NODE_VERSION}-win-x64/node.exe`,content:'x',declaredSize:8*1024*1024}]),{allowedRoots:[`node-v${NODE_VERSION}-win-x64`]}),error=>error.code==='runtime_archive_invalid');
  assert.throws(()=>zipEntries(zip([{name:`node-v${NODE_VERSION}-win-x64/link`,attributes:0xa1ff0000}]),{allowedRoots:[`node-v${NODE_VERSION}-win-x64`]}),error=>error.code==='runtime_archive_unsafe');
});
test('explicit Node ZIP root list remains restrictive and default Qwen root compatibility is retained',()=>{
  const archive=zip([{name:`node-v${NODE_VERSION}-win-x64/node.exe`,content:'node'}]);assert.equal(zipEntries(archive,{allowedRoots:[`node-v${NODE_VERSION}-win-x64`]}).length,1);assert.throws(()=>zipEntries(archive),error=>error.code==='runtime_archive_unsafe');
  assert.equal(zipEntries(zip([{name:'qwen-code/node/node.exe',content:'node'}])).length,1);
});
test('already trusted official local npm CLI is version-probed and reused without downloads or PATH changes',async t=>{
  const v=fixture(t),script=path.join(v.root,'node_modules','@google','gemini-cli','bundle','gemini.js'),node=path.join(v.root,'node.exe');fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'owned test script');fs.writeFileSync(node,'owned test executable');fs.writeFileSync(path.join(path.dirname(path.dirname(script)),'package.json'),JSON.stringify({name:'@google/gemini-cli',version:GEMINI_VERSION,bin:{gemini:'bundle/gemini.js'}}));
  v.service.chat.discovery.scan=options=>{assert.deepEqual(options,{processes:[]});return{candidates:[{provider:'gemini-cli',executable:node,executable_args:[script],capabilities:{automatic_launch:true}}]};};
  const result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.installed,true);assert.equal(result.unchanged,true);assert.equal(result.runtime_owned,false);assert.equal(result.origin,'existing-official-package');assert.equal(result.executable,node);assert.equal(result.verified_sha256,undefined);assert.equal(v.requests.length,0);assert.equal(v.commands.length,2);assert.equal(v.env.PATH,undefined);assert.equal(fs.existsSync(path.join(v.data,'runtimes')),false);
});
test('lookalike local npm package cannot be executed and falls back to the verified owned runtime',async t=>{
  const v=fixture(t),script=path.join(v.root,'node_modules','@google','gemini-cli','bundle','gemini.js'),node=path.join(v.root,'node.exe');fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(script,'unknown script');fs.writeFileSync(node,'unknown executable');fs.writeFileSync(path.join(path.dirname(path.dirname(script)),'package.json'),JSON.stringify({name:'untrusted-lookalike',version:GEMINI_VERSION,bin:{gemini:'bundle/gemini.js'}}));
  v.service.chat.discovery.scan=()=>({candidates:[{provider:'gemini-cli',executable:node,executable_args:[script],capabilities:{automatic_launch:true}}]});
  const result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.runtime_owned,true);assert.ok(v.commands.every(call=>call.command!==node));assert.equal(v.requests.length,4);
});
test('unsupported platform stops Gemini installation without touching files or probing accounts',async t=>{
  const v=fixture(t,{options:{platform:'linux'}}),result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.reason,'runtime_platform_unsupported');assert.equal(v.requests.length,0);assert.equal(v.commands.length,0);assert.equal(fs.existsSync(path.join(v.data,'runtimes')),false);
});
test('Windows proxy fallback installs Gemini from the same bounded official npm and Node sources',async t=>{
  let v;const downloads=[];
  v=fixture(t,{options:{systemFallback:true},fetch:async()=>{const error=new TypeError('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT'};throw error;},runner:async(command,args,options)=>{
    if(command!=='powershell.exe')return{exitCode:0,stdout:args.length===1?`v${NODE_VERSION}`:GEMINI_VERSION,stderr:''};
    const request=JSON.parse(options.input);downloads.push(request);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(request.file.startsWith(path.join(v.data,'runtimes','.downloads')+path.sep));assert.ok(request.max_bytes<=80*1024*1024);
    assert.doesNotMatch(args.at(-1),/Invoke-Expression|SkipCertificateCheck|ServerCertificateValidationCallback/);assert.equal(args.at(-1).includes(request.url),false);
    const bytes=request.url===v.registry?Buffer.from(JSON.stringify(v.manifest)):request.url===v.tarball?v.packageBytes:request.url.endsWith('/SHASUMS256.txt')?Buffer.from(`${v.nodeRelease.sha256}  node-v${NODE_VERSION}-win-x64.zip\n`):v.nodeBytes;
    fs.writeFileSync(request.file,bytes);return{exitCode:0,stdout:JSON.stringify({status:200,length:bytes.length}),stderr:''};
  }});
  const result=await v.installer.install({provider:'gemini-cli'});assert.equal(result.status,'installed');assert.equal(downloads.length,4);assert.equal(v.requests.length,2);assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','.downloads')),[]);assert.deepEqual([...new Set(downloads.map(item=>new URL(item.url).hostname))].sort(),['nodejs.org','registry.npmjs.org']);
});
