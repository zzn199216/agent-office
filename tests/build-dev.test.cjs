'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parseArgs,buildDevelopment,publishDevelopment}=require('../scripts/build.cjs');
const {atomicJson,sha}=require('../scripts/release-common.cjs');
const source={head:'a'.repeat(40),fingerprint:'b'.repeat(64),clean:true};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-dev-test-'));
  t.after(()=>{const cleanup=path.resolve(root);assert.equal(path.dirname(cleanup),path.resolve(os.tmpdir()));assert.ok(path.basename(cleanup).startsWith('agentoffice-dev-test-'));fs.rmSync(cleanup,{recursive:true,force:true});});
  return root;
}
function packageFixture(outputRoot,version){
  const directory=path.join(outputRoot,'release','AgentOffice-'+version+'-windows-x64');
  const desktopFiles=['AgentRoom.Desktop.exe','desktop-web/app.js'];
  const files=['AgentOffice.exe','OPEN_TEST.cmd',...desktopFiles.map(name=>'desktop/'+name)];
  for(const name of files){const file=path.join(directory,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,version+' '+name);}
  atomicJson(path.join(directory,'desktop','desktop-manifest.json'),{version,files:desktopFiles.map(name=>{const file=path.join(directory,'desktop',name);return {path:name,bytes:fs.statSync(file).size,sha256:sha(file)};})});
  files.push('desktop/desktop-manifest.json');
  atomicJson(path.join(directory,'release-manifest.json'),{schema:'agentoffice.release',version,source,files:files.map(name=>{const file=path.join(directory,...name.split('/'));return {path:name,bytes:fs.statSync(file).size,sha256:sha(file)};})});
  return {release:directory};
}
function builder(version){return async options=>{assert.equal(options.localOnly,true);return packageFixture(options.outputRoot,version);};}
function version(directory){return JSON.parse(fs.readFileSync(path.join(directory,'release-manifest.json'),'utf8')).version;}
function stagedPackage(root,value){const output=path.join(root,'output');fs.mkdirSync(output,{recursive:true});return packageFixture(fs.mkdtempSync(path.join(output,'dev-build-')),value).release;}
test('daily npm builds use the rolling development mode while formal callers retain the default',()=>{
  const scripts=require('../package.json').scripts;
  assert.equal(scripts.build,'node scripts/build.cjs --dev');assert.equal(scripts['build:dev'],scripts.build);assert.equal(scripts['build:release'],'node scripts/build.cjs');
  assert.equal(parseArgs([]).dev,false);assert.equal(parseArgs(['--local-only']).localOnly,true);assert.equal(parseArgs(['--dev','--output-root','.']).outputRoot,path.resolve('.'));
  for(const args of [['--output-root'],['--output-root','--dev'],['--surprise']])assert.throws(()=>parseArgs(args));
});
test('successful updates publish one fixed directory, retain one prior version, and discard temporary builds',async t=>{
  const root=fixture(t);
  for(const value of ['1.0.0','1.0.1','1.0.2']){
    const result=await buildDevelopment({outputRoot:root,build:builder(value)});
    assert.equal(result.executable,path.join(root,'dev','AgentOffice.exe'));assert.equal(result.version,value);
    assert.deepEqual(fs.readdirSync(path.join(root,'output')),[]);assert.equal(fs.existsSync(path.join(root,'release')),false);
  }
  assert.equal(version(path.join(root,'dev')),'1.0.2');assert.equal(version(path.join(root,'dev.previous')),'1.0.1');
  assert.deepEqual(fs.readdirSync(root).sort(),['dev','dev.previous','output']);
});
test('failed builds and checksum validation leave the current and previous development versions usable',async t=>{
  const root=fixture(t);await buildDevelopment({outputRoot:root,build:builder('1.0.0')});await buildDevelopment({outputRoot:root,build:builder('1.0.1')});
  await assert.rejects(buildDevelopment({outputRoot:root,build:async()=>{throw new Error('Compiler failed');}}),/Compiler failed/);
  await assert.rejects(buildDevelopment({outputRoot:root,build:async options=>{const result=packageFixture(options.outputRoot,'1.0.2');fs.writeFileSync(path.join(result.release,'AgentOffice.exe'),'corrupt');return result;}}),/checksum mismatch/);
  assert.equal(version(path.join(root,'dev')),'1.0.1');assert.equal(version(path.join(root,'dev.previous')),'1.0.0');assert.deepEqual(fs.readdirSync(path.join(root,'output')),[]);
});
test('a locked output during publication restores both prior directories',async t=>{
  const root=fixture(t);await buildDevelopment({outputRoot:root,build:builder('1.0.0')});await buildDevelopment({outputRoot:root,build:builder('1.0.1')});
  const staged=stagedPackage(root,'1.0.2');let calls=0;
  assert.throws(()=>publishDevelopment(root,staged,{rename:(from,to)=>{if(++calls===3)throw new Error('file is locked');fs.renameSync(from,to);}}),/close Agent Office and retry/);
  assert.equal(version(path.join(root,'dev')),'1.0.1');assert.equal(version(path.join(root,'dev.previous')),'1.0.0');assert.equal(version(staged),'1.0.2');
});
test('publication preserves recovery files if restoring a prior directory is blocked',async t=>{
  const root=fixture(t);await buildDevelopment({outputRoot:root,build:builder('1.0.0')});await buildDevelopment({outputRoot:root,build:builder('1.0.1')});
  const staged=stagedPackage(root,'1.0.2');let calls=0;
  assert.throws(()=>publishDevelopment(root,staged,{rename:(from,to)=>{if(++calls>=3)throw new Error('locked');fs.renameSync(from,to);}}),error=>error.preserveStage===true&&/recovery files were kept/.test(error.message));
  assert.equal(version(path.join(root,'dev.previous')),'1.0.1');assert.equal(version(path.join(path.dirname(path.dirname(staged)),'previous-retired')),'1.0.0');
});
test('unrecognized directories and packages outside the owned stage are never replaced',async t=>{
  const root=fixture(t),dev=path.join(root,'dev');fs.mkdirSync(dev);fs.writeFileSync(path.join(dev,'keep.txt'),'keep');
  await assert.rejects(buildDevelopment({outputRoot:root,build:builder('1.0.0')}));assert.equal(fs.readFileSync(path.join(dev,'keep.txt'),'utf8'),'keep');
  const outside=packageFixture(root,'1.0.0').release;assert.throws(()=>publishDevelopment(root,outside),/outside its owned build stage/);
});
test('concurrent development builds cannot replace each other',async t=>{
  const root=fixture(t);let proceed,started;const ready=new Promise(resolve=>{started=resolve;});
  const first=buildDevelopment({outputRoot:root,build:async options=>{started();await new Promise(resolve=>{proceed=resolve;});return packageFixture(options.outputRoot,'1.0.0');}});
  await ready;await assert.rejects(buildDevelopment({outputRoot:root,build:builder('1.0.1')}),/owns the lock/);proceed();await first;
  assert.equal(version(path.join(root,'dev')),'1.0.0');assert.deepEqual(fs.readdirSync(path.join(root,'output')),[]);
});
test('CI prepares the Windows desktop SDK before tests and uploads the fixed development directory',()=>{
  const workflow=fs.readFileSync(path.join(__dirname,'..','.github','workflows','windows-build.yml'),'utf8');
  assert.ok(workflow.indexOf('npm run prepare:desktop')<workflow.indexOf('npm test'));assert.match(workflow,/path: dev\//);assert.doesNotMatch(workflow,/path: release\//);
});
