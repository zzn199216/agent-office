'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {desktopStart,desktopActivate,desktopState,offlineState}=require('../src/desktop-state.cjs');
const {assertBackgroundAllowed}=require('../src/desktop-lifecycle.cjs');
const {RoomService}=require('../src/service.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
const {id}=require('../src/util.cjs');
const kinds=['corrupt JSON','hardlinked marker','oversized marker'];

function setup(t){
  const f=fixture();fs.mkdirSync(f.data);
  t.after(()=>{const root=path.resolve(f.root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return {...f,marker:path.join(f.data,'desktop-lifecycle.json')};
}
function invalidMarker(f,kind){
  const valid=JSON.stringify({schema:'agentoffice.desktop-lifecycle',version:1,id:id(),state:'active',updated_at:new Date().toISOString()});
  const original=kind==='corrupt JSON'?'{corrupt':valid+(kind==='oversized marker'?' '.repeat(4097):'');
  fs.writeFileSync(f.marker,original);
  const linked=kind==='hardlinked marker'?path.join(f.root,'original-marker.json'):null;
  if(linked){fs.linkSync(f.marker,linked);assert.ok(fs.statSync(f.marker).nlink>1);}
  return {original,linked};
}
async function savedOffice(f){
  const codex=new FakeCodex(),service=new RoomService(f.data,{codex,vault:new FakeVault(),fetch:async()=>assert.fail('Recovery fixtures cannot call upstream services'),chat:{discovery:{env:{},processInventory:()=>({processes:[],available:true})}}});
  let room;
  try{const project=service.addProject({path:f.project,name:'Recovery fixture'});room=service.chat.addRoom({project_id:project.id,title:'Saved office'});}finally{await service.close();}
  assert.equal(codex.calls.length,0);
  return {room,offline:offlineState(f.data,room.id)};
}

for(const operation of [desktopStart,desktopActivate])for(const kind of kinds)test(`${operation.name} recovers ${kind} before its first state read`,async t=>{
  const f=setup(t),{room,offline}=await savedOffice(f),{original,linked}=invalidMarker(f,kind),activation=id(),calls={reads:0,api:0,starts:0};
  const active=()=>{const marker=JSON.parse(fs.readFileSync(f.marker,'utf8'));assert.equal(marker.state,'active');assert.equal(marker.id,activation);return marker;};
  const control={pid:12345,owner_id:id(),instance_id:offline.snapshot.instance_id,url:'http://127.0.0.1:47831'};
  const main={readControl:()=>{calls.reads++;active();return control;},ensureServer:async()=>{calls.starts++;active();},apiCall:async(_dir,route)=>{
    calls.api++;active();
    if(route==='/api/state')return offline.snapshot;
    if(route==='/api/chat/rooms/'+room.id)return offline.history;
    if(route==='/api/team?room_id='+room.id)return offline.team;
    assert.fail('Unexpected fixture route: '+route);
  }};
  const before=fs.readdirSync(f.data).sort();
  await assert.rejects(desktopState(f.data,{room_id:room.id},{main}),{code:'desktop_lifecycle_invalid'});
  assert.deepEqual(calls,{reads:0,api:0,starts:0});assert.deepEqual(fs.readdirSync(f.data).sort(),before);assert.equal(fs.readFileSync(f.marker,'utf8'),original);
  const result=await operation(f.data,{activation_id:activation,room_id:room.id},{main});
  assert.equal(result.running,true);assert.equal(result.desktop_activation_id,activation);assert.equal(calls.starts,operation===desktopStart?1:0);assert.ok(calls.reads>0&&calls.api>0);
  const marker=active();assert.equal(marker.schema,'agentoffice.desktop-lifecycle');assert.equal(marker.version,1);assert.equal(fs.statSync(f.marker).nlink,1);assert.equal(assertBackgroundAllowed(f.data).id,activation);
  const names=fs.readdirSync(f.data),archives=names.filter(name=>/^desktop-lifecycle\.invalid-\d+\.json$/.test(name)),diagnostics=names.filter(name=>/^desktop-lifecycle-recovery-\d+\.json$/.test(name));
  assert.equal(archives.length,1);assert.equal(fs.readFileSync(path.join(f.data,archives[0]),'utf8'),original);assert.equal(diagnostics.length,1);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(f.data,diagnostics[0]),'utf8'));assert.equal(diagnostic.code,'desktop_lifecycle_invalid');assert.equal(diagnostic.reason,'explicit_desktop_activation');assert.equal(diagnostic.preserved_marker,archives[0]);
  if(linked){assert.equal(fs.readFileSync(linked,'utf8'),original);assert.equal(fs.statSync(path.join(f.data,archives[0])).nlink,2);}
});

for(const kind of kinds)test(`desktopState polling stays fail-closed for ${kind} without attempting recovery`,async t=>{
  const f=setup(t),{original,linked}=invalidMarker(f,kind),before=fs.readdirSync(f.data).sort();
  const main={readControl:()=>assert.fail('Polling cannot reach service discovery with an invalid intent'),apiCall:async()=>assert.fail('Polling cannot contact a service with an invalid intent'),ensureServer:async()=>assert.fail('Polling cannot start a service')};
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(desktopState(f.data,{}, {main}),{code:'desktop_lifecycle_invalid'});
  assert.throws(()=>assertBackgroundAllowed(f.data),{code:'desktop_lifecycle_invalid'});assert.deepEqual(fs.readdirSync(f.data).sort(),before);assert.equal(fs.readFileSync(f.marker,'utf8'),original);
  if(linked)assert.equal(fs.readFileSync(linked,'utf8'),original);
});

for(const operation of [desktopStart,desktopActivate])test(`${operation.name} rejects an expired action before recovering or changing its marker`,async t=>{
  const f=setup(t),{original}=invalidMarker(f,'corrupt JSON');
  const main={readControl:()=>assert.fail('Expired actions cannot inspect service control'),ensureServer:async()=>assert.fail('Expired actions cannot start a service')};
  await assert.rejects(operation(f.data,{activation_id:id()},{main,clock:()=>1000,deadline:999}),{code:'desktop_operation_timeout'});
  assert.deepEqual(fs.readdirSync(f.data),['desktop-lifecycle.json']);assert.equal(fs.readFileSync(f.marker,'utf8'),original);
});
