'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const scene=require('../web/office.js');
const now=Date.parse('2026-10-13T08:00:00Z');
const member={id:'code-one',name:'Codex 开发',adapter:'codex',status:'ready'};
const online={members:[{id:member.id,presence:'online',worker_online:true,lease_expires:'2026-10-13T08:01:00Z'}],service:{online:true}};
test('office shows only participants in the selected room, including offline and unverified members',()=>{
  const model=scene.describe({roomId:'room-a',participants:[member,{...member,name:'duplicate'},{id:'awaiting',name:'等待接入',status:'pending'},{id:'offline',name:'离线成员',presence:'offline'}],messages:[],online:false},now);
  assert.deepEqual(model.members.map(item=>item.member.id),['code-one','awaiting','offline']);
  assert.ok(model.members.every(item=>!item.processing&&item.presence.label==='服务已关闭'));
  assert.equal(model.members[2].presence.status,'offline');
  assert.ok(model.members.every(item=>item.occupied===false),'stopped service keeps seats but no occupants');
});

test('offline and expired agents leave an empty station while preserving identity, messages and queued work',()=>{
  const offline={...member,presence:'offline'},message={id:'previous-answer',sender_id:member.id,text:'原来的实际回答'},request={id:'pending',to_member_id:member.id,status:'queued',text:'新问题'};
  const a=scene.describe({roomId:'a',participants:[offline],messages:[message,request],online:true},now).members[0];
  assert.equal(a.occupied,false);assert.equal(a.member,offline);assert.equal(a.message,message);assert.equal(a.waiting,true);assert.equal(a.showMessage,false);assert.equal(a.recent,false);
  const stale=scene.describe({participants:[member],runtime:{members:[{id:member.id,presence:'online',lease_expires:'2026-10-13T07:59:00Z'}]},online:true},now).members[0];
  assert.equal(stale.presence.status,'stale');assert.equal(stale.occupied,false);
  const restored=scene.describe({participants:[member],runtime:online,online:true},now).members[0];assert.equal(restored.occupied,true);
});
test('queued messages and an open client alone do not animate real work',()=>{
  const input={roomId:'room-a',participants:[member],runtime:online,online:true,messages:[{id:'question',sender_id:'user',to_member_id:member.id,status:'queued',text:'问题'}]};
  const waiting=scene.describe(input,now).members[0];assert.equal(waiting.waiting,true);assert.equal(waiting.processing,false);
  const processing=scene.describe({...input,messages:[{...input.messages[0],status:'processing'}]},now).members[0];assert.equal(processing.processing,true);
  const noWorker=scene.describe({...input,runtime:{members:[{id:member.id,presence:'online',worker_online:false}]},messages:[{...input.messages[0],status:'processing'}]},now).members[0];assert.equal(noWorker.processing,false);
});
test('offline history never portrays workers as actively working',()=>{
  const model=scene.describe({roomId:'room-a',participants:[member],runtime:online,online:false,messages:[{id:'question',to_member_id:member.id,status:'processing',sender_id:'user',text:'旧问题'}]},now);
  assert.equal(model.members[0].processing,false);assert.equal(model.members[0].presence.status,'stale');
  assert.equal(model.online,false);assert.equal(model.lastMessage.id,'question');
});
test('system messages and messages from another room are not invented as member speech',()=>{
  const messages=[{id:'real',room_id:'room-a',sender_id:member.id,text:'实际回答',created:'2026-10-13T07:59:55Z'},{id:'event',sender_id:member.id,kind:'event',text:'启动事件'},{id:'foreign',room_id:'room-b',sender_id:member.id,text:'另一个房间'}];
  const model=scene.describe({roomId:'room-a',participants:[member],messages,online:true},now);
  assert.equal(model.members[0].message.id,'real');assert.equal(model.members[0].recent,true);assert.equal(model.lastMessage.id,'real');
  assert.deepEqual(model.messages.map(item=>item.id),['real','event']);
});
test('historical messages remain visible without being marked as new speech',()=>{
  const model=scene.describe({roomId:'a',participants:[member],messages:[{id:'past',sender_id:member.id,text:'历史发言',created:'2026-10-12T08:00:00Z'}],online:true},now);
  assert.equal(model.members[0].showMessage,true);assert.equal(model.members[0].recent,false);
});
test('member presentation is stable by ID and does not change identity, adapter or messages',()=>{
  const model=scene.describe({participants:[member],appearances:{[member.id]:{preset:'robot',color:'#1A2b3C',avatar_data:'data:image/png;base64,AQID'}},messages:[{id:'say',sender_id:member.id,text:'unchanged'}]},now);
  assert.equal(model.members[0].member,member);assert.equal(model.members[0].appearance.preset,'robot');assert.equal(model.members[0].appearance.color,'#1A2b3C');
  assert.equal(model.members[0].appearance.avatar,'data:image/png;base64,AQID');assert.equal(model.members[0].message.text,'unchanged');
});
test('custom portraits reject active SVG, external URLs, local files and traversal',()=>{
  for(const value of ['data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)','https://tracking.example/avatar.png','file:///C:/secret.png','/assets/office/../private.png','/assets/office/sprite.svg?token=secret'])assert.equal(scene.safeImage(value),'');
  assert.equal(scene.safeImage('/assets/office/logo-codex.svg'),'/assets/office/logo-codex.svg');
  assert.equal(scene.safeImage('data:image/webp;base64,AQID'),'data:image/webp;base64,AQID');
  assert.equal(scene.safeImage('data:image/png;base64,'+'A'.repeat(450000)),'');
  assert.equal(scene.avatarSource({...member,appearance:{avatar_url:'https://external/avatar.png'}}),'/assets/office/avatar-codex.png');
});
test('group proxies retain named agent branding and unknown clients have a replaceable generic badge',()=>{
  assert.equal(scene.provider({adapter:'grok-bridge',name:'Claude 桌面客户端 · Grok群入口'}),'claude');
  assert.equal(scene.provider({adapter:'grok-bridge',name:'Codex'}),'codex');
  assert.equal(scene.provider({adapter:'grok-bridge',name:'Grok 桥接 Bot'}),'grok');
  assert.equal(scene.provider({adapter:'custom-agent',name:'新工具'}),'generic');
  assert.equal(scene.avatarSource({id:'x',appearance:{preset:'unknown',color:'var(--private)'}}),'/assets/office/logo-generic.svg');
});
test('expired presence does not report an idle desktop as online',()=>{
  const model=scene.describe({participants:[member],online:true,runtime:{members:[{id:member.id,presence:'online',lease_expires:'2026-10-13T07:59:00Z',worker_online:false}]}},now);
  assert.equal(model.members[0].presence.status,'stale');
});
test('official provider portraits are packaged offline and custom images still take priority',()=>{
  for(const adapter of ['codex','claude-code','qwen-code','grok','cursor','doubao']){
    const provider=adapter.split('-')[0];assert.equal(scene.avatarSource({id:adapter,adapter}),`/assets/office/avatar-${provider}.png`);
  }
  assert.equal(scene.avatarSource({id:'custom',adapter:'qwen-code',appearance:{avatar_data:'data:image/png;base64,AQID'}}),'data:image/png;base64,AQID');
  assert.equal(scene.avatarSource({id:'proxy',adapter:'grok-bridge',name:'Claude 桌面客户端 · Grok群入口'}),'/assets/office/avatar-claude.png');
});

test('expanded agent identities use original packaged fallback rather than missing or external portraits',()=>{
  for(const [adapter,key]of [['gemini-cli','gemini'],['opencode','opencode'],['cline','cline'],['roo-code','roo'],['cherry-studio','cherry']]){
    const member={id:adapter,adapter};assert.equal(scene.provider(member),key);
    assert.equal(scene.avatarSource(member),'/assets/office/logo-generic.svg');
    assert.equal(scene.characterSource(member),'/assets/office/character-robot.png');
    assert.equal(scene.avatarSource({...member,appearance:{avatar_data:'data:image/png;base64,AQID'}}),'data:image/png;base64,AQID');
    assert.equal(scene.provider({adapter:'grok-bridge',name:adapter}),key);
  }
});
test('the rectangular floor extends down for 7, 36 and 100 agents without squeezing existing desks',()=>{
  const counts=[7,36,100],layouts=counts.map(count=>scene.layoutOffice(950,count));
  assert.equal(layouts[0].columns,3);assert.ok(layouts[0].height<layouts[1].height);assert.ok(layouts[1].height<layouts[2].height);
  for(const layout of layouts){
    assert.deepEqual(layout.position(0),layouts[0].position(0));
    const last=layout.position(counts[layouts.indexOf(layout)]-1);
    assert.ok(last.y+last.height<layout.height);
  }
  assert.equal(scene.layoutOffice(390,100).columns,1);
  assert.equal(scene.layoutOffice(550,100).columns,2);
  assert.equal(scene.layoutOffice(750,100).columns,3);
  assert.equal(scene.layoutOffice(2000,100).columns,3);
});
test('seat slots survive reordered updates and new members fill a free desk without moving their peers',()=>{
  const original=scene.allocateSlots(new Map(),['a','b','c','d']);
  const reordered=scene.allocateSlots(original,['d','b','a','c']);
  for(const id of original.keys())assert.equal(reordered.get(id),original.get(id));
  const added=scene.allocateSlots(reordered,['e','d','b','a','c']);
  for(const id of original.keys())assert.equal(added.get(id),original.get(id));
  assert.equal(added.get('e'),4);
  const removed=scene.allocateSlots(added,['a','c','d','e']);
  const replaced=scene.allocateSlots(removed,['a','c','d','e','f']);
  assert.equal(replaced.get('f'),1);assert.equal(replaced.get('e'),4);
});
test('entry routes start at the upper left door and use the left aisle then the row walkway',()=>{
  const g=scene.GEOMETRY;
  for(const width of [390,550,950]){
    const layout=scene.layoutOffice(width,100);
    for(let slot=0;slot<100;slot++){
      const seat=layout.position(slot),route=scene.routeToSeat(seat);
      assert.deepEqual(route.points[0],{x:g.doorX,y:g.doorY});
      assert.deepEqual(route.points[1],{x:g.aisleX,y:seat.y+g.walkwayY});
      assert.deepEqual(route.points[2],{x:seat.x+g.personX,y:seat.y+g.walkwayY});
      assert.deepEqual(route.points[3],{x:seat.x+g.personX,y:seat.y+g.personY});
      assert.equal(route.keyframes[0].offset,0);assert.equal(route.keyframes[3].offset,1);
      assert.equal(route.keyframes[3].transform,'translate(0px, 0px)');
      assert.ok(route.keyframes.every((frame,index)=>index===0||frame.offset>=route.keyframes[index-1].offset));
      assert.ok(route.duration<=3200);
      for(const point of route.points){
        assert.ok(point.x-g.personHalfWidth>=8&&point.x+g.personHalfWidth<=layout.width-8);
        assert.ok(point.y-g.personHalfHeight>=8&&point.y+g.personHalfHeight<=layout.height-8);
      }
    }
  }
});
test('walking bodies do not pass through other desks even in a 100 member narrow office',()=>{
  function intersects(a,b,rect){return Math.max(a.x,b.x)>rect.left&&Math.min(a.x,b.x)<rect.right&&Math.max(a.y,b.y)>rect.top&&Math.min(a.y,b.y)<rect.bottom;}
  const g=scene.GEOMETRY;
  for(const width of [390,550,950]){
    const layout=scene.layoutOffice(width,100),seats=Array.from({length:100},(_,slot)=>layout.position(slot));
    for(const seat of seats){
      const {points}=scene.routeToSeat(seat);
      for(const other of seats){
        const desk={left:other.x+14-g.personHalfWidth,right:other.x+170+g.personHalfWidth,top:other.y+110-g.personHalfHeight,bottom:other.y+199+g.personHalfHeight};
        for(let segment=0;segment<3;segment++){
          if(seat.slot===other.slot&&segment===2)continue; // The final step seats this member behind their own desk.
          assert.equal(intersects(points[segment],points[segment+1],desk),false,`width=${width}, entrant=${seat.slot}, desk=${other.slot}, segment=${segment}`);
        }
      }
    }
  }
});
test('only a new participant in the already visible online room gets a door entry',()=>{
  const previous={roomId:'a',initialized:true,online:true,memberIds:['one','two']};
  const next={roomId:'a',online:true,memberIds:['two','one','three']};
  assert.deepEqual(scene.joiningMembers(previous,next),['three']);
  assert.deepEqual(scene.joiningMembers({...previous,initialized:false},next),[]);
  assert.deepEqual(scene.joiningMembers({...previous,roomId:'b'},next),[]);
  assert.deepEqual(scene.joiningMembers({...previous,online:false},next),[]);
  assert.deepEqual(scene.joiningMembers(previous,{...next,online:false}),[]);
  assert.deepEqual(scene.joiningMembers(previous,{...next,memberIds:['two','one']}),[]);
  assert.deepEqual(scene.joiningMembers({...previous,memberIds:['two']},{...next,memberIds:['one','two']}),['one']);
});
