'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {connectionStats}=require('../src/stats.cjs');
const {id,now}=require('../src/util.cjs');
function setup(t){
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),onboarding:{replyVerification:false},launch:{discover:()=>({candidates:[{id:'claude-desktop',provider:'claude-desktop',name:'Claude',adapter:'mailbox',installed:true,capabilities:{mcp_prepare:true}}]})}});
  const project=service.addProject({path:files.project,name:'lifecycle'}),room=service.chat.addRoom({project_id:project.id,title:'room'});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  return {files,service,room,db:service.store.db,start:async()=>{const run=service.onboarding.start({room_id:room.id,provider:'claude-desktop'});await Promise.all([...service.onboarding.jobs.values()]);return service.onboarding.state({run_id:run.id});}};
}
test('retry closes its predecessor; leaving and deleting close every unfinished row and attempt',async t=>{
  const v=setup(t),first=await v.start(),second=v.service.onboarding.retry({run_id:first.id});await Promise.all([...v.service.onboarding.jobs.values()]);
  assert.notEqual(first.id,second.id);assert.equal(v.service.onboarding.row(first.id).status,'superseded');
  assert.equal(v.db.prepare("SELECT count(*) n FROM onboarding_runs WHERE status IN ('running','needs_action')").get().n,1);
  const current=v.service.onboarding.state({run_id:second.id});v.service.chat.leave(v.room.id,current.member_id);
  assert.equal(v.service.onboarding.row(second.id).status,'cancelled');assert.equal(connectionStats(v.files.data).connections.abandoned,1);
  v.service.chat.store.deleteRoom(v.room.id);
  assert.equal(v.db.prepare("SELECT count(*) n FROM onboarding_runs WHERE status IN ('running','needs_action')").get().n,0);
  v.service.onboarding.set(second.id,{status:'needs_action',error:'late callback'});assert.equal(v.db.prepare('SELECT status FROM onboarding_runs WHERE id=?').get(second.id).status,'cancelled');
});
test('startup reconciliation closes deleted-room history without creating successful versioned attempts',async t=>{
  const v=setup(t);v.service.chat.store.deleteRoom(v.room.id);
  for(let i=0;i<62;i++)v.db.prepare("INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,created,updated) VALUES(?,?, 'codex','codex','managed','needs_action','awaiting_connection',?,?)").run(id(),v.room.id,now(),now());
  v.service.onboarding.reconcileRuns();v.service.onboarding.reconcileRuns();
  assert.equal(v.db.prepare("SELECT count(*) n FROM onboarding_runs WHERE status IN ('running','needs_action')").get().n,0);
  const stats=connectionStats(v.files.data);assert.equal(stats.connections.attempts,0);assert.equal(stats.connections.first_connected,0);assert.equal(stats.historical.unversioned_onboarding_records,62);
});
test('uncertain verification keeps the original attempt and never schedules another run',async t=>{
  const v=setup(t),first=await v.start(),snapshot=v.service.onboarding.snapshot.bind(v.service.onboarding);
  v.service.onboarding.snapshot=row=>({...snapshot(row),reply_verification:{status:'uncertain'}});
  const next=v.service.onboarding.retry({run_id:first.id});assert.equal(next.id,first.id);assert.equal(next.reused,true);
  assert.equal(v.service.onboarding.jobs.size,0);assert.equal(connectionStats(v.files.data).connections.attempts,1);
});
