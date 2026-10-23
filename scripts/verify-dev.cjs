'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {sourceState,atomicJson,execute,acquireLock}=require('./release-common.cjs');
const {readManifest}=require('./release-artifacts.cjs');
const coreFlows=require('./core-flows.cjs');

function unitEvidence(log){
  const count=name=>{const match=log.match(new RegExp('^# '+name+' (\\d+)\\r?$','m'));assert.ok(match,'Missing test total: '+name);return Number(match[1]);};
  const result=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(name=>[name,count(name)]));
  assert.ok(result.tests>0&&result.pass===result.tests&&result.fail+result.cancelled+result.skipped+result.todo===0,'Regression suite must pass without missing, skipped or cancelled tests');
  return result;
}
function coreEvidence(value){
  assert.equal(value.ok,true,'Core-flow suite did not finish successfully');
  assert.equal(value.isolated,true);assert.equal(value.real_clients_or_models,false);
  assert.deepEqual(value.flows.map(flow=>flow.id).sort(),coreFlows.map(flow=>flow.id).sort(),'Every core flow must appear exactly once');
  assert.ok(value.flows.every(flow=>flow.status==='passed'),'Every core flow must pass');
  return value.flows;
}
function browserEvidence(value){
  assert.equal(value.ok,true,'Browser suite did not finish successfully');
  assert.ok(Object.keys(value.checks||{}).length>0&&Object.values(value.checks).every(result=>result===true),'Browser checks must be present and all pass');
  return Object.keys(value.checks).length;
}
function summary(result){
  return ['# Agent Office development verification','', 'Status: **'+result.status+'**', 'Commit: `'+(result.source?.head||'unavailable')+'`',
    'Source fingerprint: `'+(result.source?.fingerprint||'unavailable')+'`','',
    'Isolated test clients only; no real model or personal client qualification.','',
    '| Step | Result |','| --- | --- |',...result.steps.map(step=>'| '+step.name+' | '+step.status+' |'),'',
    '| Core journey | Result |','| --- | --- |',...coreFlows.map(flow=>'| '+flow.name+' | '+(result.core_flows?.find(value=>value.id===flow.id)?.status||'not completed')+' |'),
    '',...(result.error?['Error: '+result.error,'']:[])].join('\n');
}

async function verify(options={}){
  const root=options.root||path.resolve(__dirname,'..'),getSource=options.sourceState||sourceState,run=options.execute||execute;
  const runId=new Date().toISOString().replace(/[^0-9]/g,'')+'-'+process.pid;
  const output=path.join(root,'output','verify-dev',runId),result={schema:'agentoffice.dev-verification',status:'running',source:null,started:new Date().toISOString(),real_clients_or_models:false,steps:[],core_flows:[]};
  fs.mkdirSync(output,{recursive:true});let unlock,temporary;
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),25*60*1000);
  const save=()=>{atomicJson(path.join(output,'result.json'),result);if(unlock){atomicJson(path.join(root,'output','verify-dev','latest.json'),{...result,result_path:path.join(output,'result.json')});fs.writeFileSync(path.join(root,'output','verify-dev','summary.md'),summary(result));}};
  const stage=async(name,args,inspect)=>{
    const row={name,status:'running',log:path.join(output,name+'.log')};result.steps.push(row);save();console.log('[verify:dev] '+name);
    try{
      const outcome=await run(process.execPath,args,{cwd:root,log:row.log,timeout:15*60*1000,signal:controller.signal,env:{...process.env,TEMP:temporary,TMP:temporary,TMPDIR:temporary,AGENTOFFICE_VALIDATION_OUTPUT:path.join(output,'browser')}});
      row.duration_ms=outcome.duration_ms;
      assert.ok(outcome.exit_code===0&&!outcome.timed_out&&!outcome.aborted,name+' failed; see '+row.log);
      if(inspect)await inspect(row);
      row.status='passed';
    }catch(error){row.status='failed';throw error;}finally{save();}
  };
  try{
    assert.equal(options.platform||process.platform,'win32','Full development verification requires Windows');
    unlock=acquireLock(path.join(root,'output','verify-dev.lock'));result.source=getSource(root);
    // Avoid network-mounted TEMP for SQLite/browser fixtures on a developer PC.
    const tempParent=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Temp'):os.tmpdir();fs.mkdirSync(tempParent,{recursive:true});temporary=fs.mkdtempSync(path.join(tempParent,'agentoffice-verify-'));
    await stage('syntax',['scripts/check.cjs']);
    await stage('desktop-sdk',['scripts/build-desktop.cjs']);
    await stage('regression',['--test','--test-concurrency=4','--test-reporter=tap','tests/*.test.cjs'],row=>{result.tests=unitEvidence(fs.readFileSync(row.log,'utf8'));});
    await stage('browser-install',['node_modules/playwright/cli.js','install','chromium']);
    await stage('core-flows',['scripts/validate-core-flows.cjs'],()=>{result.core_flows=coreEvidence(JSON.parse(fs.readFileSync(path.join(output,'browser','core-flows','result.json'),'utf8')));});
    for(const [name,script] of [['connection-assist','validate-connection-assist-ui.cjs'],['office-activity','validate-office-activity.cjs'],['office-fullscene','validate-office-fullscene.cjs']]){
      await stage(name,['scripts/'+script],row=>{row.checks=browserEvidence(JSON.parse(fs.readFileSync(path.join(output,'browser',name,'result.json'),'utf8')));});
    }
    await stage('build',['scripts/build.cjs','--dev']);
    const executable=path.join(root,'dev','AgentOffice.exe');
    await stage('packaged-mcp',['scripts/validate-packaged-mcp.cjs','--executable',executable,'--output',path.join(output,'packaged-mcp.json')]);
    await stage('package-smoke',['scripts/package-smoke.cjs','--executable',executable,'--output',path.join(output,'package-smoke.json')]);
    await stage('startup-recovery',['scripts/validate-startup-recovery.cjs',executable]);
    assert.equal(getSource(root).fingerprint,result.source.fingerprint,'Source changed during verification; rerun for the new source');
    const manifest=readManifest(path.join(root,'dev'),require('../package.json').version,result.source);
    result.artifact_files=manifest.files.length;result.status='passed';
  }catch(error){result.status='failed';result.error=error.message;}
  finally{
    clearTimeout(deadline);
    result.finished=new Date().toISOString();
    const coreResult=path.join(output,'browser','core-flows','result.json');
    if(fs.existsSync(coreResult))try{result.core_flows=JSON.parse(fs.readFileSync(coreResult,'utf8')).flows||[];}catch{}
    result.temporary_directory=temporary||null;
    try{
      if(temporary&&result.status==='passed'){
        const owned=path.resolve(temporary),parent=process.env.LOCALAPPDATA?path.resolve(process.env.LOCALAPPDATA,'Temp'):path.resolve(os.tmpdir());
        assert.equal(path.dirname(owned),parent);assert.match(path.basename(owned),/^agentoffice-verify-/);fs.rmSync(owned,{recursive:true,force:true,maxRetries:10,retryDelay:200});result.temporary_directory=null;
      }
    }catch(error){result.status='failed';result.error='Fixture cleanup failed: '+error.message;}
    finally{try{save();}finally{unlock?.();}}
  }
  console.log('[verify:dev] '+result.status+' — '+path.join(output,'result.json'));
  if(result.error)console.error(result.error);
  return result;
}
if(require.main===module){
  if(process.argv.length>2){console.error('Usage: npm run verify:dev (all gates are required)');process.exitCode=1;}
  else verify().then(result=>{if(result.status!=='passed')process.exitCode=1;}).catch(error=>{console.error(error.stack);process.exitCode=1;});
}
module.exports={verify,unitEvidence,coreEvidence,browserEvidence};
