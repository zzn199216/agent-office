'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../web/office-scene.js'),{Director}=require('../web/office-director.js');
const fact=(id,state='idle')=>({id,state,member:{id,name:id},profile:'codex',variant:0,label:state,note:''});
test('A* follows cardinal free cells around geometry and never invents a route through a sealed wall',()=>{
  const scene={schema:1,revision:0,grid:[8,8],stations:{},furniture:[{id:'wall',type:'wall',label:'wall',at:[3,0],footprint:[1,6],parts:[],slots:[],offers:[]}]};
  const route=model.pathfind(scene,[1,1],[6,1]);assert.ok(route.length>6);const walls=model.blocked(scene);
  for(let i=0;i<route.length;i++){assert.equal(walls.has(model.cell(route[i])),false);if(i)assert.equal(Math.abs(route[i][0]-route[i-1][0])+Math.abs(route[i][1]-route[i-1][1]),1);}
  assert.equal(model.pathfind(scene,[1,1],[6,1],new Set(['6,1'])),null);
  scene.furniture.push({id:'wall2',at:[3,6],footprint:[1,2]});assert.equal(model.pathfind(scene,[1,1],[6,1]),null);
  assert.equal(model.pathfind(scene,[-1,1],[6,1]),null);
});
test('new arrivals walk without changing facts; a repeated snapshot preserves movement and real attention interrupts it',()=>{
  const director=new Director(),scene=model.defaultScene(['a','b']),a=fact('a'),b=fact('b');director.update([a],scene,{walking:true});director.step(0);
  director.update([a,b],scene,{walking:true});const entity=director.entities.get('b');assert.deepEqual(entity.at,[1,1]);director.step(100);const first=[...entity.at];assert.notDeepEqual(first,[1,1]);
  director.update([a,b],scene,{walking:true});assert.deepEqual(entity.at,first);director.step(200);assert.notDeepEqual(entity.at,first);assert.equal(entity.anim,'walk');
  director.update([a,{...b,state:'attention',note:'real question'}],scene,{walking:true});assert.equal(entity.script,null);assert.equal(entity.anim,'raise');assert.deepEqual(entity.at,[scene.stations.b.at[0],scene.stations.b.at[1]+1]);
  assert.equal(b.state,'idle');assert.equal(b.note,'');director.step(300,true);assert.equal(entity.frame,0);
});
test('declarative scripts finish and stop ticking; disabling movement settles the actor at its seat',()=>{
  const director=new Director(),scene=model.defaultScene(['a']),a=fact('a');director.update([a],scene,{walking:true});const entity=director.entities.get('a');
  assert.equal(director.startScript('a',[{walkTo:[1,4]},{face:'up'},{animate:'talk'},{bubble:'actual fixture event'},{wait:200}]),true);
  for(let now=0;now<10000;now+=100)director.step(now);assert.equal(entity.script,null);assert.equal(director.step(11000),false);assert.equal(entity.bubble,'');
  director.startScript('a',[{walkTo:[1,1]}]);director.update([a],scene,{walking:false});assert.equal(entity.script,null);assert.deepEqual(entity.at,[3,4]);
  assert.equal(director.startScript('a',[{eval:'bad'}]),false);assert.equal(director.startScript('a',[{wait:Infinity}]),false);assert.doesNotThrow(()=>model.validateScene(model.defaultScene(Array.from({length:200},(_,i)=>'member-'+i))));
});
