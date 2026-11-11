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
test('an unfamiliar furniture offer runs without a type branch, reserves its slot, and yields to real work',()=>{
  const director=new Director({random:()=>0}),scene=model.defaultScene(['a','b']);scene.furniture=[{id:'custom',type:'unseen-lounger',label:'新休息处',at:[1,10],footprint:[2,1],parts:[],slots:[{at:[1,11],face:'left',anim:'lie'}],offers:[{action:'unseen-rest',when:'idle',weight:3,bubble:'在休息处放松'}]}];
  const a=fact('a'),b=fact('b');director.update([a,b],scene,{walking:true,ambient:true});director.step(0);assert.equal(director.nextWake(),12000);
  for(let now=12000;now<=16000;now+=100)director.step(now);
  const entity=director.entities.get('a');assert.equal(entity.script.layer,'ambient');assert.equal(entity.anim,'lie');assert.equal(entity.bubble,'在休息处放松');assert.equal(director.reservations.size,1);assert.equal(director.entities.get('b').script,null);assert.equal(director.step(16100),false,'A static rest should not request redraws');assert.ok(director.nextWake()>0);
  director.update([{...a,state:'working',note:'real task'},b],scene,{walking:true,ambient:true});assert.equal(director.reservations.size,0);assert.notEqual(entity.script?.layer,'ambient');assert.equal(entity.fact.note,'real task');assert.equal(a.state,'idle');
  director.update([a,b],scene,{walking:true,ambient:true,reduced_motion:true});director.step(30000,true);assert.equal(director.reservations.size,0);assert.equal(director.nextWake(true),null);
});
test('only actual new peer messages and actual claim rounds become reactions; predictions and old history stay silent',()=>{
  const {events}=require('../web/office-director.js'),director=new Director(),scene=model.defaultScene(['a','b']),a=fact('a'),b=fact('b');director.update([a,b],scene,{interactions:true,walking:true});
  const input={participants:[a.member,b.member],messages:[{id:'old',seq:1,sender_id:'a',to_member_id:'b',kind:'message',text:'old'}],group:{meetings:[{id:'m',predictions:[{member_id:'a',first_step:'not actual'}],reports:[{member_id:'a',round:1,source:'secretary_prediction',content:{first_step:'fake'}}]}]}};
  director.observe(events(input));director.step(0);assert.equal(director.playedEvents.length,0);
  input.messages.push({id:'new',seq:2,sender_id:'a',to_member_id:'b',kind:'message',text:'real question'});director.observe(events(input));director.step(100);assert.equal(director.playedEvents.length,1);assert.equal(director.entities.get('a').anim,'walk');
  for(let now=200;now<8000;now+=100)director.step(now);assert.equal(director.entities.get('a').script,null);director.observe(events(input));assert.equal(director.eventQueue.length,0);
  input.group.meetings[0].reports.push(...[1,2].map(round=>({member_id:'b',round,source:'member_actual',content:{first_step:'actual approach',choice:'actual nomination'}})));director.observe(events(input));
  for(let now=8000;now<14000;now+=100)director.step(now);assert.deepEqual(director.playedEvents.filter(e=>e.type==='claim').map(e=>e.round),[1,2]);assert.equal(director.step(15000),false);
  director.update([a,b],scene,{interactions:false,walking:true});input.messages.push({id:'off',seq:3,sender_id:'a',to_member_id:'b',kind:'message',text:'off'});director.observe(events(input));assert.equal(director.eventQueue.length,0);
});
