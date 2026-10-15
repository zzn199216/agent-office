'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {atomicJson,sourceState,acquireLock,execute}=require('./release-common.cjs'),{verifyArtifacts,publishArtifacts}=require('./release-artifacts.cjs');
function parseArgs(args){const flags=new Set(['--skip-tests','--skip-build','--json','--help']);if(args.some(arg=>!flags.has(arg)))throw new Error('Usage: node scripts/release.cjs [--skip-tests] [--skip-build] [--json]');return {skipTests:args.includes('--skip-tests'),skipBuild:args.includes('--skip-build'),json:args.includes('--json'),help:args.includes('--help')};}
async function runRelease(options={},dependencies={}){
  const root=dependencies.root||path.resolve(__dirname,'..'),version=dependencies.version||JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,runId=dependencies.runId||new Date().toISOString().replace(/[^0-9]/g,'')+'-'+crypto.randomBytes(4).toString('hex'),output=path.join(root,'output','releases',runId),resultFile=path.join(output,'result.json');
  fs.mkdirSync(output,{recursive:true});const result={schema:'agentoffice.release-result',run_id:runId,version,started:new Date().toISOString(),status:'running',fully_verified:false,mode:options.skipBuild?'validation_only':'build',steps:[],source:null,result_path:resultFile,package_directory:null,zip_path:null,artifacts:[]},started=Date.now();let releaseLock,temporary;
  const state=dependencies.sourceState||sourceState,run=dependencies.execute||execute,verify=dependencies.verify||verifyArtifacts,publish=dependencies.publish||publishArtifacts;
  const save=()=>atomicJson(resultFile,result);
  const step=async(name,callback,skipped=false)=>{const row={name,status:skipped?'skipped':'running',duration_ms:0,log:path.join(output,name+'.log')};result.steps.push(row);save();if(skipped)return;const start=Date.now();try{await callback(row);row.status='ok';}catch(error){row.status='failed';row.error=error.message;throw error;}finally{row.duration_ms=Date.now()-start;save();}};
  const command=async(row,args)=>{const execution=await run(process.execPath,args,{cwd:root,log:row.log,signal:dependencies.signal});if(execution.exit_code!==0||execution.timed_out||execution.aborted)throw new Error(`${row.name} failed${execution.timed_out?' (timeout)':execution.aborted?' (cancelled)':''}; see ${row.log}`);};
  try{
    if((dependencies.platform||process.platform)!=='win32'||(dependencies.arch||process.arch)!=='x64')throw new Error('Release verification requires Windows x64; cross-building is not attempted.');
    releaseLock=(dependencies.acquireLock||acquireLock)(path.join(root,'output','release.lock'));result.source=state(root);save();
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-release-'));let directory=path.join(temporary,'release',`AgentOffice-${version}-windows-x64`),zip=directory+'.zip';
    if(options.skipBuild){const latest=JSON.parse(fs.readFileSync(path.join(root,'output',`release-${version}.json`),'utf8'));if(latest.version!==version||latest.source?.fingerprint!==result.source.fingerprint||!['ok','partial'].includes(latest.status)||!latest.package_directory||!latest.zip_path)throw new Error('No matching package for the current source; build first.');directory=latest.package_directory;zip=latest.zip_path;const releaseRoot=path.resolve(root,'release')+path.sep;if(!path.resolve(directory).startsWith(releaseRoot)||!path.resolve(zip).startsWith(releaseRoot))throw new Error('Saved package paths are outside release/.');}
    await step('check',row=>command(row,['scripts/check.cjs']));
    await step('tests',row=>command(row,['--test','tests/*.test.cjs']),options.skipTests||options.skipBuild);
    await step('build',row=>command(row,['scripts/build.cjs','--output-root',temporary]),options.skipBuild);
    const executable=path.join(directory,'AgentOffice.exe');
    await step('packaged-mcp',row=>command(row,['scripts/validate-packaged-mcp.cjs','--executable',executable,'--output',path.join(output,'mcp.json')]));
    await step('package-smoke',row=>command(row,['scripts/package-smoke.cjs','--executable',executable,'--output',path.join(output,'runtime.json')]));
    await step('artifacts',async row=>{if(state(root).fingerprint!==result.source.fingerprint)throw new Error('Source changed during release verification.');const checked=verify(directory,zip,version,result.source);fs.writeFileSync(row.log,JSON.stringify({files:checked.files.length,source:result.source},null,2));Object.assign(result,options.skipBuild?{package_directory:directory,zip_path:zip,artifacts:checked.artifacts}:publish(root,directory,zip,checked,runId));});
    result.status=options.skipTests||options.skipBuild?'partial':'ok';result.fully_verified=result.status==='ok';
  }catch(error){result.status='failed';result.error=error.message;}
  finally{result.duration_ms=Date.now()-started;result.finished=new Date().toISOString();result.temporary_directory=temporary||null;
    if(temporary&&result.status!=='failed'){const target=path.resolve(temporary);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('agentoffice-release-'))throw new Error('Refusing cleanup outside the local release stage.');fs.rmSync(target,{recursive:true,force:true});result.temporary_directory=null;}
    save();if(releaseLock){try{atomicJson(path.join(root,'output',`release-${version}.json`),result);}finally{releaseLock();}}}
  return result;
}
async function main(){const options=parseArgs(process.argv.slice(2));if(options.help){console.log('node scripts/release.cjs [--skip-tests] [--skip-build] [--json]\nBuild and validate a local package. No deployment or model calls.');return;}const result=await runRelease(options);console.log(JSON.stringify({status:result.status,fully_verified:result.fully_verified,result_path:result.result_path,package_directory:result.package_directory,error:result.error},null,2));if(result.status==='failed')process.exitCode=1;}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={parseArgs,runRelease};
