'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const model=require('../web/office-scene.js'),{RoomService}=require('../src/service.cjs'),{fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
test('layout saving rejects overlapping objects, occupied slots and inaccessible workstations',()=>{
  const scene=model.defaultScene(['a','b']);assert.deepEqual(model.validatePlacement(scene),scene);
  const overlap=structuredClone(scene);overlap.stations.b.at=[...overlap.stations.a.at];assert.throws(()=>model.validatePlacement(overlap),/重叠/);
  const slot=structuredClone(scene);slot.furniture[0].slots[0].at=[3,4];assert.throws(()=>model.validatePlacement(slot),/座位被挡/);
  const sealed=structuredClone(scene);for(let i=0;i<4;i++)sealed.furniture.push({id:'wall-'+i,type:'wall',label:'wall',at:[i*6,2],footprint:[6,1],parts:[],slots:[],offers:[]});assert.throws(()=>model.validatePlacement(sealed),/走不到/);
});
test('edited scenes survive reload; new members get nonoverlapping seats without writing during reads',async t=>{
  const f=fixture(),service=new RoomService(f.data,{codex:new FakeCodex(),vault:new FakeVault()});t.after(async()=>{await service.close();fs.rmSync(f.root,{recursive:true,force:true});});const project=service.addProject({path:f.project}),room=service.chat.addRoom({project_id:project.id}),add=()=>{const m=service.chat.store.addMember({name:'fixture',adapter:'mailbox'});service.chat.store.join(room.id,m.id);return m;},a=add();
  service.features.set({room_id:room.id,canvas:true,scene_editor:true});const draft=service.officeScenes.get(room.id);draft.stations[a.id].at=[8,8];draft.furniture.push(model.furniture('plant','plant',[3,3]));const saved=service.officeScenes.set({room_id:room.id,scene:draft,expected_revision:0});assert.equal(saved.revision,1);
  const stored=JSON.stringify(service.store.setting('office-scene.'+room.id)),b=add(),read=service.officeScenes.get(room.id);assert.deepEqual(read.stations[a.id].at,[8,8]);assert.ok(read.stations[b.id]);assert.doesNotThrow(()=>model.validatePlacement(read));assert.deepEqual(service.officeScenes.get(room.id),read);assert.equal(JSON.stringify(service.store.setting('office-scene.'+room.id)),stored);
  assert.throws(()=>service.officeScenes.set({room_id:room.id,scene:saved,expected_revision:1}),e=>e.code==='scene_members_changed');assert.equal(JSON.stringify(service.store.setting('office-scene.'+room.id)),stored);
  service.chat.store.leave(room.id,a.id);assert.equal(service.officeScenes.get(room.id).stations[a.id],undefined);
});
