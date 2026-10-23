'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {unitEvidence,coreEvidence,browserEvidence,verify,temporaryParent}=require('../scripts/verify-dev.cjs');
const flows=require('../scripts/core-flows.cjs');
test('CI fixtures use runner scratch space while local runs avoid network TEMP',()=>{
  const runner=path.resolve(os.tmpdir(),'fixture-runner'),profile=path.resolve(os.tmpdir(),'fixture-profile');
  assert.equal(temporaryParent({CI:'true',RUNNER_TEMP:runner,LOCALAPPDATA:profile}),runner);
  assert.equal(temporaryParent({CI:'false',RUNNER_TEMP:runner,LOCALAPPDATA:profile}),path.join(profile,'Temp'));
  assert.equal(temporaryParent({LOCALAPPDATA:profile}),path.join(profile,'Temp'));
});
test('development acceptance rejects empty, skipped, cancelled and incomplete regression evidence',()=>{
  const tap='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(unitEvidence(tap).pass,2);
  for(const bad of ['',tap.replace('# tests 2','# tests 0'),tap.replace('# pass 2','# pass 1'),tap.replace('# skipped 0','# skipped 1'),tap.replace('# cancelled 0','# cancelled 1'),tap.replace('# todo 0','# todo 1')])assert.throws(()=>unitEvidence(bad));
});
test('success flags alone cannot qualify missing or duplicated core journeys or empty browser checks',()=>{
  const value={ok:true,isolated:true,real_clients_or_models:false,flows:flows.map(flow=>({...flow,status:'passed'}))};
  assert.equal(coreEvidence(value).length,6);
  for(const bad of [{...value,flows:value.flows.slice(1)},{...value,flows:[...value.flows.slice(0,5),value.flows[0]]},{...value,flows:value.flows.map((flow,index)=>index?flow:{...flow,status:'pending'})},{...value,ok:false}])assert.throws(()=>coreEvidence(bad));
  assert.throws(()=>browserEvidence({ok:true,checks:{}}));assert.throws(()=>browserEvidence({ok:true,checks:{copy:true,reply:false}}));
  assert.equal(browserEvidence({ok:true,checks:{copy:true,reply:true}}),2);
});
for(const fault of ['sdk','skipped-regression','missing-core-flow'])test('acceptance stops before build on '+fault+' and records the failed gate',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-verify-runner-test-')),calls=[];let result;
  t.after(()=>{
    for(const directory of [root,result?.temporary_directory].filter(Boolean)){
      const target=path.resolve(directory);assert.match(path.basename(target),/^(ao-verify-runner-test-|agentoffice-verify-)/);
      const expected=target===path.resolve(root)?path.resolve(os.tmpdir()):temporaryParent();
      assert.equal(path.dirname(target),expected);fs.rmSync(target,{recursive:true,force:true});
    }
  });
  result=await verify({root,platform:'win32',sourceState:()=>({head:'fixture',fingerprint:'fixture'}),execute:async(command,args,options)=>{
    calls.push(args);fs.writeFileSync(options.log,'fixture only');
    if(args.includes('--test')){
      assert.ok(calls.slice(0,-1).some(previous=>previous.includes('scripts/build-desktop.cjs')),'Compile SDK before any regression');
      fs.writeFileSync(options.log,'# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped '+(fault==='skipped-regression'?1:0)+'\n# todo 0\n');
    }
    if(args.includes('scripts/validate-core-flows.cjs')){
      const directory=path.join(options.env.AGENTOFFICE_VALIDATION_OUTPUT,'core-flows');fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({ok:true,isolated:true,real_clients_or_models:false,flows:flows.slice(1).map(flow=>({...flow,status:'passed'}))}));
    }
    return {exit_code:fault==='sdk'&&calls.length===2?1:0,duration_ms:1};
  }});
  assert.equal(result.status,'failed');assert.equal(calls.length,{sdk:2,'skipped-regression':3,'missing-core-flow':5}[fault]);
  assert.equal(result.steps.at(-1).status,'failed');assert.ok(result.steps.slice(0,-1).every(step=>step.status==='passed'));
  assert.ok(!calls.some(args=>args.includes('scripts/build.cjs')));
  const saved=JSON.parse(fs.readFileSync(path.join(root,'output','verify-dev','latest.json'),'utf8'));
  assert.equal(saved.status,'failed');assert.ok(saved.error);assert.ok(!fs.existsSync(path.join(root,'output','verify-dev.lock')));
});
