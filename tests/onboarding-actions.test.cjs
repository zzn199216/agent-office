'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {OnboardingActions}=require('../src/onboarding-actions.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-login-action-')),node=path.join(root,'node.exe'),script=path.join(root,'node_modules','@google','gemini-cli','bundle','gemini.js');
  fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(node,'metadata fixture; never executed');fs.writeFileSync(script,'metadata fixture; never executed');
  const job={id:'fixture-run',provider:'gemini-cli',room_id:'fixture-room',next_actions:[{operation:'login_client'}]},launched=[];
  const service={onboarding:{state(){return job;}},store:{setting(){return {executable:node,executable_args:[script]};},project(){return {path:root};}},chat:{store:{room(){return {project_id:'fixture-project'};}},discover(){throw new Error('installed runtime must be reused');}}};
  const actions=new OnboardingActions(service,{launcher:async request=>{launched.push(request);return {pid:process.pid};}});
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentoffice-login-action-/);fs.rmSync(root,{recursive:true,force:true});});
  return {root,node,script,job,service,actions,launched};
}

test('Gemini login opens only a user-selected official Node entry and preserves all arguments as quoted literals',async t=>{
  const f=fixture(t);assert.equal(f.launched.length,0);
  const result=await f.actions.perform({run_id:f.job.id,operation:'login_client',command:'untrusted.exe',args:['--eval','malicious']});
  assert.equal(result.action.launched,true);assert.equal(f.launched.length,1);const request=f.launched[0];assert.equal(request.options.shell,false);assert.equal(request.options.windowsHide,false);
  const code=Buffer.from(request.args.at(-1),'base64').toString('utf16le');assert.ok(code.includes(f.node));assert.ok(code.includes(f.script));assert.equal(code.includes('untrusted.exe'),false);assert.equal(code.includes('malicious'),false);
  const repeated=await f.actions.perform({run_id:f.job.id,operation:'login_client'});assert.equal(repeated.action.reused,true);assert.equal(f.launched.length,1);
});

test('manual clients and arbitrary scripts cannot be used as background login entrypoints',async t=>{
  const f=fixture(t);f.job.provider='doubao';await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='client_login_unavailable');assert.equal(f.launched.length,0);
  f.job.provider='gemini-cli';const bad=path.join(f.root,'unknown.js');fs.writeFileSync(bad,'never executed');f.service.store.setting=()=>({executable:f.node,executable_args:[bad]});
  await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='client_runtime_missing');assert.equal(f.launched.length,0);
  f.job.next_actions=[];await assert.rejects(f.actions.perform({operation:'login_client',run_id:f.job.id}),error=>error.code==='onboarding_action_unavailable');assert.equal(f.launched.length,0);
});
