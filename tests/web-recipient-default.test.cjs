'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
function load(secretary=null){const context=vm.createContext({currentSecretary:()=>({member_id:secretary})});vm.runInContext(section('function defaultRecipient(','function renderMessage('),context);return context;}

test('a typed message goes to someone who will act on it, not to the announcement',()=>{
  const members=[{id:'a',status:'connecting'},{id:'b',status:'ready'},{id:'c',status:'ready',can_notify:true}];
  assert.equal(load().defaultRecipient([],[]),'','an empty room can only post an announcement');
  assert.equal(load('a').defaultRecipient(members,[]),'a','the secretary comes first');
  assert.equal(load('gone').defaultRecipient(members,[]),'c','a member that is notified automatically comes next');
  assert.equal(load().defaultRecipient(members.slice(0,2),[]),'b','then any connected member');
  assert.equal(load().defaultRecipient(members.slice(0,1),[]),'a','a lone member still receives the message instead of nobody');
  assert.equal(load('a').defaultRecipient(members,[{sender_id:'user',to_member_id:'b'},{sender_id:'b',to_member_id:null}]),'b','the last person the user addressed wins');
  assert.equal(load('a').defaultRecipient(members,[{sender_id:'user',to_member_id:'left'}]),'a','a member who left is skipped');
});

test('only an announcement the person picked is remembered; one left over from an empty room is not',()=>{
  const render=section('function renderRoom(','function defaultRecipient(');
  assert.match(render,/selectedRecipient === '' && !broadcastRooms\.has\(room\.id\)/);
  const change=section("$('recipient').onchange =","$('cancel-reply')");
  assert.match(change,/broadcastRooms\.add\(roomId\)/);assert.match(change,/broadcastRooms\.delete\(roomId\)/);
});
