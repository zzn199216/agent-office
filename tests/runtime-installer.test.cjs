'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {RuntimeInstaller,zipEntries,validOfficialUrl}=require('../src/runtime-installer.cjs');
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');

function zip(files){
  const locals=[],central=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),content=Buffer.from(file.content||''),local=Buffer.alloc(30),directory=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(content.length,20);directory.writeUInt32LE(content.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE((file.attributes||0)>>>0,38);directory.writeUInt32LE(offset,42);
    const item=Buffer.concat([local,name,content]);locals.push(item);central.push(Buffer.concat([directory,name]));offset+=item.length;
  }
  const body=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(body.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,body,end]);
}
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-runtime-test-')),data=path.join(root,'data');fs.mkdirSync(data);
  const settings=new Map(),requests=[],metadata=[],extracts=[],env={};let changes=0;
  const service={store:{dir:data,setting(key,value){if(value===undefined)return settings.get(key)||null;settings.set(key,value);return value;}},chat:{discovery:{env}},changed(){changes++;}};
  const files=[{name:'qwen-code/node/node.exe',content:'verified fake native node'},{name:'qwen-code/dist/cli-entry.js',content:'verified fake vendor cli'}],archive=overrides.archive||zip(files),binary=Buffer.from('verified fake Claude binary');
  const fetch=async(url,options)=>{
    requests.push({url,options});if(overrides.fetch)return overrides.fetch(url,options);
    if(url.endsWith('/SHA256SUMS'))return new Response(`${overrides.checksum||hash(archive)}  qwen-code-win-x64.zip\n`,{status:200});
    if(url.endsWith('.zip'))return new Response(archive,{status:200});
    if(url.endsWith('/latest'))return new Response('2.1.296\n',{status:200});
    if(url.endsWith('/manifest.json'))return new Response(JSON.stringify({platforms:{'win32-x64':{checksum:overrides.checksum||hash(binary)}}}),{status:200});
    if(url.endsWith('/claude.exe'))return new Response(binary,{status:200});throw new Error(`unexpected URL ${url}`);
  };
  const runner=async(command,args,options)=>{metadata.push({command,args,options});if(overrides.runner)return overrides.runner(command,args,options);return {exitCode:0,stdout:command.endsWith('claude.exe')?'2.1.296 (Claude Code)':'0.25.1',stderr:''};};
  const extractor=async(archiveFile,target,options)=>{extracts.push({archiveFile,target,options});if(overrides.extractor)return overrides.extractor(archiveFile,target,options);
    for(const file of files){const location=path.join(target,...file.name.split('/'));fs.mkdirSync(path.dirname(location),{recursive:true});fs.writeFileSync(location,file.content);}};
  const installer=new RuntimeInstaller(service,{fetch,runner,extractor,platform:'win32',arch:'x64',...overrides.options});
  t.after(async()=>{await installer.close();const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^agentroom-runtime-test-/);fs.rmSync(resolved,{recursive:true,force:true});});
  return {root,data,settings,requests,metadata,extracts,env,service,installer,archive,binary,get changes(){return changes;}};
}

test('installing Qwen downloads only official pinned files, verifies digest and runs metadata without a shell',async t=>{
  const v=fixture(t),result=await v.installer.install({provider:'qwen-code',url:'https://bad.invalid',command:'malicious'});
  assert.equal(result.status,'installed');assert.equal(result.installed,true);assert.equal(result.connected,false);assert.equal(result.version,'0.25.1');assert.equal(result.verified_sha256,hash(v.archive));
  assert.deepEqual(v.requests.map(r=>r.url),['https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v0.25.1/SHA256SUMS','https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v0.25.1/qwen-code-win-x64.zip']);
  assert.equal(v.extracts.length,1);assert.ok(result.executable.endsWith(path.join('qwen-code','node','node.exe')));assert.equal(result.executable_args.length,1);assert.ok(result.executable_args[0].endsWith(path.join('qwen-code','dist','cli-entry.js')));
  assert.equal(v.metadata.length,1);assert.deepEqual(v.metadata[0].args,[result.executable_args[0],'--version']);assert.equal(v.metadata[0].options.shell,false);assert.equal(v.metadata[0].options.windowsHide,true);
  assert.equal(v.settings.get('runtime.qwen-code').executable,result.executable);assert.equal(v.env.AGENTROOM_QWEN_CODE_PATH,result.executable);assert.equal(v.env.AGENTROOM_QWEN_CODE_SCRIPT,result.executable_args[0]);assert.equal(v.env.PATH,undefined);
});
test('Claude official manifest yields an isolated native binary without invoking global install or login',async t=>{
  const v=fixture(t),result=await v.installer.install({provider:'claude-code'});
  assert.equal(result.status,'installed');assert.equal(result.version,'2.1.296');assert.equal(result.verified_sha256,hash(v.binary));assert.deepEqual(result.executable_args,[]);
  assert.deepEqual(v.requests.map(r=>r.url),['https://downloads.claude.ai/claude-code-releases/latest','https://downloads.claude.ai/claude-code-releases/2.1.296/manifest.json','https://downloads.claude.ai/claude-code-releases/2.1.296/win32-x64/claude.exe']);
  assert.deepEqual(v.metadata.map(m=>m.args),[['--version']]);assert.equal(v.extracts.length,0);assert.equal(v.env.AGENTROOM_CLAUDE_CODE_PATH,result.executable);assert.equal(result.signed_in,undefined);
});
test('same version reuses verified owned files and overlapping install calls share one operation',async t=>{
  const v=fixture(t),first=v.installer.install({provider:'qwen-code'}),second=v.installer.install({provider:'qwen-code'});assert.equal(first,second);
  const initial=await first,after=await v.installer.install({provider:'qwen-code'});
  assert.equal(after.unchanged,true);assert.equal(after.executable,initial.executable);assert.equal(v.extracts.length,1);assert.equal(v.requests.length,2);assert.equal(v.metadata.length,2);
});
test('digest failures reject payload before extraction or native execution and preserve previous runtime',async t=>{
  const v=fixture(t,{checksum:'a'.repeat(64)}),old={provider:'qwen-code',version:'0.24.0',executable:'previous-unchanged'};v.settings.set('runtime.qwen-code',old);
  const result=await v.installer.install({provider:'qwen-code'});assert.equal(result.status,'needs_setup');assert.equal(result.reason,'runtime_checksum_mismatch');assert.equal(v.extracts.length,0);assert.equal(v.metadata.length,0);assert.deepEqual(v.settings.get('runtime.qwen-code'),old);
  const providerDir=path.join(v.data,'runtimes','qwen-code');assert.deepEqual(fs.readdirSync(providerDir),[]);
});
test('unsafe ZIP paths and links are rejected before extraction despite a matching manifest digest',async t=>{
  for(const name of ['../outside.exe','qwen-code/../outside.exe','qwen-code\\..\\outside.exe','qwen-code/evil:payload','C:/qwen-code/outside','qwen-code/con.exe','qwen-code/trim.','/qwen-code/node.exe']){
    const v=fixture(t,{archive:zip([{name,content:'unsafe'}])}),result=await v.installer.install({provider:'qwen-code'});
    assert.equal(result.reason,'runtime_archive_unsafe',name);assert.equal(v.extracts.length,0);assert.equal(v.metadata.length,0);
  }
  const links=fixture(t,{archive:zip([{name:'qwen-code/link',attributes:0xa1ff0000,content:'outside'}])}),result=await links.installer.install({provider:'qwen-code'});assert.equal(result.reason,'runtime_archive_unsafe');assert.equal(links.extracts.length,0);
});
test('archive duplicate paths, file directory conflicts and changed local headers are rejected',()=>{
  assert.throws(()=>zipEntries(zip([{name:'qwen-code/DIST/file.js'},{name:'qwen-code/dist/file.js'}])),e=>e.code==='runtime_archive_unsafe');
  assert.throws(()=>zipEntries(zip([{name:'qwen-code/dist',content:'file'},{name:'qwen-code/dist/entry.js'}])),e=>e.code==='runtime_archive_unsafe');
  const broken=zip([{name:'qwen-code/file'}]);broken[30]='x'.charCodeAt(0);assert.throws(()=>zipEntries(broken),e=>e.code==='runtime_archive_invalid');
  assert.throws(()=>zipEntries(Buffer.from('not a ZIP')),e=>e.code==='runtime_archive_invalid');
});
test('official URL validation prevents arbitrary sources and untrusted redirect hosts',async t=>{
  for(const url of ['http://downloads.claude.ai/claude-code-releases/latest','https://evil.invalid/claude-code-releases/latest','https://downloads.claude.ai/claude-code-releases/latest?token=x','https://downloads.claude.ai:8443/claude-code-releases/latest','https://user:pass@downloads.claude.ai/claude-code-releases/latest'])assert.throws(()=>validOfficialUrl(url),e=>e.code==='runtime_source_invalid');
  const v=fixture(t,{fetch:async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid/binary'}})}),result=await v.installer.install({provider:'qwen-code'});assert.equal(result.reason,'runtime_source_invalid');assert.equal(v.requests.length,1);assert.equal(v.metadata.length,0);
});
test('invalid official metadata never publishes a runtime or changes previous files',async t=>{
  const v=fixture(t,{runner:async()=>({exitCode:0,stdout:'0.1.0',stderr:''})}),result=await v.installer.install({provider:'qwen-code'});
  assert.equal(result.reason,'runtime_version_mismatch');assert.equal(v.settings.has('runtime.qwen-code'),false);assert.equal(v.env.AGENTROOM_QWEN_CODE_PATH,undefined);
  assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','qwen-code')),[]);
});
test('unsupported providers and platforms fail without downloads, execution or global configuration',async t=>{
  const v=fixture(t);await assert.rejects(v.installer.install({provider:'doubao'}),e=>e.code==='runtime_provider_unsupported');assert.equal(v.requests.length,0);assert.equal(fs.existsSync(path.join(v.data,'runtimes')),false);
  const other=fixture(t,{options:{platform:'linux'}}),result=await other.installer.install({provider:'qwen-code'});assert.equal(result.reason,'runtime_platform_unsupported');assert.equal(other.requests.length,0);assert.equal(other.settings.size,0);
});
test('a changed previously verified runtime is replaced in a new namespace and old bytes are preserved',async t=>{
  const v=fixture(t),first=await v.installer.install({provider:'qwen-code'});fs.writeFileSync(first.executable_args[0],'modified existing script');
  const second=await v.installer.install({provider:'qwen-code'});assert.equal(second.status,'installed');assert.notEqual(first.executable,second.executable);assert.equal(fs.readFileSync(first.executable_args[0],'utf8'),'modified existing script');assert.equal(v.extracts.length,2);
});
test('runtime layout mismatch cannot execute an arbitrary file selected by archive contents',async t=>{
  const v=fixture(t,{extractor:async(_archive,target)=>{fs.writeFileSync(path.join(target,'arbitrary.cmd'),'do not execute');}}),result=await v.installer.install({provider:'qwen-code'});
  assert.equal(result.reason,'runtime_layout_invalid');assert.equal(v.metadata.length,0);assert.equal(v.settings.size,0);
});
test('Windows system proxy fallback keeps official sources, checks digest and uses a static helper with bounded stdin data',async t=>{
  const windows=[],binary=Buffer.from('verified fake Claude binary');let v;
  v=fixture(t,{options:{systemFallback:true},fetch:async()=>{const error=new TypeError('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT'};throw error;},runner:async(command,args,options)=>{
    if(command!=='powershell.exe')return {exitCode:0,stdout:'2.1.296 (Claude Code)',stderr:''};
    const request=JSON.parse(options.input);windows.push(request);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(args.includes('-NonInteractive'));
    const script=args.at(-1);assert.ok(script.includes('AllowAutoRedirect=$false'));assert.equal(/Invoke-Expression|\biex\b|ServerCertificateValidationCallback|SkipCertificateCheck/i.test(script),false);assert.equal(script.includes(request.url),false);assert.equal(script.includes(request.file),false);
    assert.ok(request.file.startsWith(path.join(v.data,'runtimes','.downloads')+path.sep));assert.ok(request.max_bytes<=600*1024*1024);
    const bytes=request.url.endsWith('/latest')?Buffer.from('2.1.296\n'):request.url.endsWith('/manifest.json')?Buffer.from(JSON.stringify({platforms:{'win32-x64':{checksum:hash(binary)}}})):binary;
    fs.writeFileSync(request.file,bytes);return {exitCode:0,stdout:JSON.stringify({status:200,length:bytes.length}),stderr:''};
  }});
  const result=await v.installer.install({provider:'claude-code'});assert.equal(result.status,'installed');assert.equal(result.verified_sha256,hash(binary));
  assert.equal(v.requests.length,1,'after one successful fallback this official host uses the system network directly');assert.equal(windows.length,3);assert.ok(windows.every(request=>new URL(request.url).hostname==='downloads.claude.ai'));assert.deepEqual(fs.readdirSync(path.join(v.data,'runtimes','.downloads')),[]);
});
test('injected fetches never cause real system fallback unless the trusted fixture explicitly enables it',async t=>{
  const v=fixture(t,{fetch:async()=>{const error=new TypeError('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT'};throw error;},runner:async()=>{throw new Error('system helper must not be invoked');}}),result=await v.installer.install({provider:'claude-code'});
  assert.equal(result.installed,false);assert.equal(v.metadata.length,0);assert.equal(v.requests.length,1);assert.equal(fs.existsSync(path.join(v.data,'runtimes','.downloads')),false);
});
test('Windows system network rejects redirect hosts and oversized or inconsistent downloads before native execution',async t=>{
  const failed=async()=>{const error=new TypeError('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT'};throw error;};
  const redirect=fixture(t,{options:{systemFallback:true},fetch:failed,runner:async()=>({exitCode:0,stdout:JSON.stringify({status:302,location:'https://evil.invalid/binary',length:0}),stderr:''})}),invalid=await redirect.installer.install({provider:'claude-code'});
  assert.equal(invalid.reason,'runtime_source_invalid');assert.equal(redirect.metadata.length,1);assert.equal(redirect.settings.size,0);
  const oversized=fixture(t,{options:{systemFallback:true},fetch:failed,runner:async(_command,_args,options)=>{const request=JSON.parse(options.input);fs.writeFileSync(request.file,Buffer.alloc(request.max_bytes+1));return {exitCode:0,stdout:JSON.stringify({status:200,length:request.max_bytes+1}),stderr:''};}}),large=await oversized.installer.install({provider:'claude-code'});
  assert.equal(large.reason,'runtime_download_too_large');assert.equal(oversized.metadata.length,1);assert.equal(oversized.settings.size,0);assert.deepEqual(fs.readdirSync(path.join(oversized.data,'runtimes','.downloads')),[]);
});
test('Windows network fallback still enforces the official checksum before executing the downloaded binary',async t=>{
  const v=fixture(t,{options:{systemFallback:true},fetch:async()=>{const error=new TypeError('fetch failed');error.cause={code:'UND_ERR_CONNECT_TIMEOUT'};throw error;},runner:async(_command,_args,options)=>{const request=JSON.parse(options.input);const bytes=request.url.endsWith('/latest')?Buffer.from('2.1.296'):request.url.endsWith('/manifest.json')?Buffer.from(JSON.stringify({platforms:{'win32-x64':{checksum:'a'.repeat(64)}}})):Buffer.from('does not match official checksum');fs.writeFileSync(request.file,bytes);return {exitCode:0,stdout:JSON.stringify({status:200,length:bytes.length}),stderr:''};}});
  const result=await v.installer.install({provider:'claude-code'});assert.equal(result.reason,'runtime_checksum_mismatch');assert.equal(v.metadata.every(call=>call.command==='powershell.exe'),true);assert.equal(v.settings.size,0);
});
