'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const scene=require('../web/office.js');

test('one instant gives independent local dates and daylight in user time zones',()=>{
  const now=Date.parse('2026-10-13T03:00:00Z');
  const taipei=scene.clockState('Asia/Taipei','auto',now),la=scene.clockState('America/Los_Angeles','auto',now);
  assert.equal(taipei.time,'11:00');assert.equal(taipei.phase,'day');assert.equal(taipei.date,'2026-10-13');
  assert.equal(la.time,'20:00');assert.equal(la.phase,'night');assert.equal(la.date,'2026-10-12');
});
test('local clock follows DST jumps and fractional time zone offsets',()=>{
  const before=scene.clockState('America/New_York','auto',Date.parse('2026-03-08T06:59:00Z'));
  const after=scene.clockState('America/New_York','auto',Date.parse('2026-03-08T07:01:00Z'));
  assert.equal(before.time,'01:59');assert.equal(after.time,'03:01');
  assert.equal(scene.clockState('Asia/Kathmandu','auto',Date.parse('2026-10-13T00:00:00Z')).time,'05:45');
});
test('daylight transitions are continuous and theme overrides do not falsify local clock',()=>{
  const at=time=>scene.clockState('UTC','auto',Date.parse(`2026-10-13T${time}:00Z`));
  assert.equal(at('05:30').phase,'dawn');assert.equal(at('05:30').daylight,0);
  assert.equal(at('06:45').daylight,.5);assert.equal(at('08:00').daylight,1);
  assert.equal(at('18:15').daylight,.5);assert.equal(at('19:30').daylight,0);
  const noon=Date.parse('2026-10-13T12:00:00Z');
  assert.equal(scene.clockState('UTC','night',noon).time,'12:00');assert.equal(scene.clockState('UTC','night',noon).phase,'night');
  assert.equal(scene.clockState('UTC','day',noon).daylight,1);
});
test('invalid time zone safely falls back to the user zone and midnight uses zero hours',()=>{
  assert.equal(scene.clockState('UTC','auto',Date.parse('2026-10-13T00:00:00Z')).hour,0);
  assert.doesNotThrow(()=>scene.clockState('invalid/private','auto',Date.now()));
  assert.equal(scene.clockState('auto','auto',Date.now()).timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
});
test('world settings cannot insert external backgrounds, active SVG or unsafe CSS',()=>{
  const value=scene.normalizeScene({columns:20,spacing:-5,time_zone:'not-a-zone',wall_color:'url(https://private)',floor_color:'#123456',show_clock:false,motion:false,background_data:'https://tracking.example/back.png',desk_data:'data:image/svg+xml;base64,AAA'});
  assert.equal(value.columns,3);assert.equal(value.spacing,.8);assert.equal(value.time_zone,'auto');assert.equal(value.wall_color,scene.SCENE_DEFAULTS.wall_color);assert.equal(value.floor_color,'#123456');assert.equal(value.show_clock,false);assert.equal(value.motion,false);assert.equal(value.background_data,undefined);assert.equal(value.desk_data,undefined);
});
test('chosen columns and spacing extend modular desks with a clear entry corridor',()=>{
  const mobile=scene.layoutOffice(348,9);assert.equal(mobile.width,348);assert.equal(mobile.columns,1);assert.ok(mobile.position(0).x+mobile.position(0).width<=348);
  for(const columns of [1,2,3])for(const spacing of [.8,1,1.3]){
    const layout=scene.layoutOffice(950,100,{columns,spacing});
    assert.equal(layout.columns,columns);assert.ok(layout.height>scene.layoutOffice(950,10,{columns,spacing}).height);
    const p=layout.position(99),route=scene.routeToSeat(p);assert.equal(route.points[1].x,scene.GEOMETRY.aisleX);
    assert.ok(p.y+p.height<layout.height);assert.ok(layout.rowPitch>=248);
  }
});
test('complete custom characters keep their own face and furniture and scale remain presentation fields',()=>{
  const member={id:'m',adapter:'codex',appearance:{preset:'auto',character_data:'data:image/png;base64,AQID',furniture:'beanbag',scale:1.2}};
  const item=scene.describe({participants:[member]}).members[0];
  assert.equal(item.appearance.character,'data:image/png;base64,AQID');assert.equal(item.appearance.furniture,'beanbag');assert.equal(item.appearance.scale,1.2);assert.equal(item.member,member);
  assert.equal(scene.characterSource(member),'data:image/png;base64,AQID');
  assert.equal(scene.characterSource({adapter:'new-agent'}),'/assets/office/character-robot.png');
  assert.equal(scene.characterSource({adapter:'qwen-desktop'}),'/assets/office/character-qwen-mascot.png');
  assert.equal(scene.characterSource({adapter:'qwen-desktop',appearance:{preset:'robot'}}),'/assets/office/character-robot.png');
  assert.equal(scene.describe({participants:[{id:'m'}]}).members[0].appearance.preset,'auto');
});
test('secretary role identifies only the selected room member without claiming background activity',()=>{
  const members=[{id:'a',name:'Claude',presence:'offline'},{id:'b',name:'Codex',presence:'unknown'}];
  const state=scene.describe({members,secretary:{member_id:'a',status:'ready'},online:true});
  assert.equal(state.members[0].secretary,true);assert.equal(state.members[1].secretary,false);
  assert.equal(state.members[0].presence.status,'offline');assert.equal(state.members[0].processing,false);
  const unassigned=scene.describe({members,secretary:{member_id:'removed'}});
  assert.ok(unassigned.members.every(member=>!member.secretary));
});
