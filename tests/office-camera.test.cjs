'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const scene=require('../web/office.js');

test('automatic camera fills a rectangle and keeps every workstation within scrollable room bounds',()=>{
  for(const [width,height] of [[2560,1349],[1000,800],[750,520],[390,640]])for(const count of [0,7,9,36,100]){
    const camera=scene.cameraLayout(width,height,count);
    assert.equal(camera.auto,true);
    assert.ok(camera.scale>0&&Number.isFinite(camera.scale));
    assert.ok(camera.scaledWidth/width>=.9);
    assert.ok(camera.scaledHeight>=height-camera.y-16-.001);
    assert.ok(camera.x+camera.scaledWidth<=width+.001);
    assert.ok(camera.boundsWidth<=width+.001);
    assert.ok(camera.y+camera.scaledHeight<=camera.boundsHeight+.001);
    for(let slot=0;slot<count;slot++){
      const seat=camera.world.position(slot);
      assert.ok(seat.x>=0&&seat.y>=0);
      assert.ok(seat.x+seat.width<=camera.world.width+.001);
      assert.ok(seat.y+248<=camera.world.height+.001,'saved name is inside the room');
    }
  }
});

test('additional members extend the grid down without reducing readable desk sizes',()=>{
  for(const [width,height] of [[1000,800],[750,520],[390,640]]){
    const small=scene.cameraLayout(width,height,7),many=scene.cameraLayout(width,height,100);
    assert.equal(small.scale,many.scale);
    assert.ok(many.boundsHeight>height);
    assert.equal(many.world.position(99).width,scene.GEOMETRY.seatWidth);
    assert.equal(many.world.position(99).height,scene.GEOMETRY.seatHeight);
    assert.ok(scene.GEOMETRY.seatWidth*many.scale>=150);
    assert.ok(many.world.position(99).y>height);
  }
});

test('a small office uses a balanced grid rather than stretching desks across a wide room',()=>{
  const camera=scene.cameraLayout(2400,1200,7);
  assert.ok(camera.world.columns>=3&&camera.world.columns<7);
  const first=camera.world.position(0),second=camera.world.position(1);
  assert.equal(first.width,scene.GEOMETRY.seatWidth);
  assert.equal(second.x-first.x,246);
  assert.equal(camera.scale,1);
});

test('fixed layout preferences preserve columns with automatic camera and natural furniture',()=>{
  for(const columns of [1,2,3]){
    const camera=scene.cameraLayout(1000,800,36,{auto_layout:false,columns});
    assert.equal(camera.world.columns,columns);
    assert.equal(camera.auto,true);assert.equal(camera.scale,1);
    assert.ok(camera.boundsHeight>camera.height);
  }
});

test('resizing the available pane reflows the grid while retaining natural scale',()=>{
  const wide=scene.cameraLayout(1000,800,36),narrow=scene.cameraLayout(550,800,36);
  assert.ok(narrow.world.columns<wide.world.columns);
  assert.equal(narrow.scale,wide.scale);
  assert.ok(narrow.x+narrow.scaledWidth<=550+.001);
  const phone=scene.cameraLayout(300,640,7);
  assert.equal(phone.world.columns,1);assert.ok(phone.scale<1&&phone.scale>0);
  assert.ok(phone.x+phone.scaledWidth<=300+.001);
});

test('legacy manual zoom arguments cannot leave the new automatic viewport locked small',()=>{
  const expected=scene.cameraLayout(1000,800,7);
  for(const zoom of [.015,.49,1,5,99]){
    const actual=scene.cameraLayout(1000,800,7,{},zoom,1);
    assert.equal(actual.auto,true);assert.equal(actual.scale,expected.scale);
    assert.equal(actual.world.columns,expected.world.columns);
    assert.deepEqual(actual.world.position(6),expected.world.position(6));
  }
});

test('hidden and extremely small viewport measurements produce finite positive transforms',()=>{
  for(const size of [[0,0],[NaN,Infinity],[-1,-1],[1,1]]){
    const camera=scene.cameraLayout(...size,100);
    for(const key of ['width','height','scale','scaledWidth','scaledHeight','boundsWidth','boundsHeight','x','y'])assert.ok(Number.isFinite(camera[key]),key);
    assert.ok(camera.scale>0&&camera.scale<=1);
  }
});

test('automatically reflowed rooms preserve the actual doorway and clear walking aisles',()=>{
  const camera=scene.cameraLayout(1000,800,100),g=scene.GEOMETRY;
  for(let slot=0;slot<100;slot++){
    const route=scene.routeToSeat(camera.world.position(slot));
    assert.deepEqual(route.points[0],{x:g.doorX,y:g.doorY});
    assert.equal(route.points[1].x,g.aisleX);
    assert.ok(route.points[1].y>=g.top);
    assert.ok(route.points[2].x<=camera.world.width-g.personHalfWidth);
    assert.equal(route.keyframes.at(-1).transform,'translate(0px, 0px)');
  }
});
