'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs'),{id,now}=require('../src/util.cjs');

function setup(t){
  const files=fixture(),posts=[],service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async(url,input)=>{posts.push({url,input});return {ok:true,status:200,json:async()=>({success:true})};}});clearInterval(service.team.timer);
  const project=service.addProject({name:'Delivery fixture',path:files.project}),room=service.chat.addRoom({project_id:project.id,title:'Existing office'});
  const member=service.chat.addMember({name:'Existing Grok',adapter:'grok-bridge'});service.chat.join(room.id,member.id);service.chat.store.updateMember(member.id,{config:{launch_provider:'grok-bot'}});
  const entry=service.entry.issue(member.id,room.id),bytes=fs.readFileSync(entry.file);service.entry.accept(JSON.parse(bytes));
  t.after(async()=>{await service.close();const target=path.resolve(files.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});
  const configure=()=>{const credential={url:'https://api2.cursor.sh/automations/webhook/fixture-only',key:'fixture-private-webhook-key'},vault={get:()=>credential,status:()=>({configured:true,usable:true})};service.chat.memberVaults.set(member.id,{stamp:'missing',vault});service.chat.store.updateMember(member.id,{config:{...service.chat.store.member(member.id).config,webhook_enabled:true}});return {credential,vault};};
  const legacyNative=(provider='grok-bot')=>{service.store.db.prepare('INSERT INTO desktop_person_sessions VALUES(?,?,?,?,?,?,?,?)').run(member.id,provider,'http://127.0.0.1:19247','fixture-owned-runtime','existing-native-conversation','offline','historical native failure',now());return service.desktop.row(member.id);};
  const post=(key='delivery-'+id())=>service.chat.post({room_id:room.id,to_member_id:member.id,text:'fixture question',idempotency_key:key});
  const settle=()=>Promise.all([...service.chat.notifications.values()].map(row=>row.work));
  return {...files,service,room,member,entry,bytes,posts,configure,legacyNative,post,settle};
}

test('configured notification is distinct from native wake, and notification receipt is public without secrets',async t=>{
  const v=setup(t),{credential}=v.configure(),capability=v.service.chat.deliveryCapability(v.member.id);
  assert.equal(capability.connection_method,'configured_notification');assert.equal(capability.can_notify,true);assert.equal(capability.can_wake,false);assert.equal(capability.native_usable,false);
  const person=v.service.chat.publicMember(v.service.chat.store.member(v.member.id));assert.equal(person.manual_wake,false);assert.equal(person.can_notify,true);assert.equal(person.runtime_state.can_wake,false);
  assert.equal(JSON.stringify(person).includes(credential.url),false);assert.equal(JSON.stringify(person).includes(credential.key),false);
  const wake=await v.service.entry.wake(v.room.id,v.member.id);assert.equal(wake.status,'available_notification');assert.equal(wake.can_notify,true);assert.equal(v.posts.length,0,'a capability check does not invoke the webhook');
  const message=v.post();await v.settle();assert.equal(v.posts.length,1);assert.equal(v.service.chat.store.message(message.id).status,'delivered');
  const shown=v.service.chat.room(v.room.id).messages.find(row=>row.id===message.id);assert.deepEqual(shown.notification,{status:'accepted'});assert.equal(JSON.stringify(shown).includes(credential.key),false);
  v.service.chat.post({room_id:v.room.id,to_member_id:v.member.id,text:'fixture question',idempotency_key:'duplicate-fixture'});await v.settle();const before=v.posts.length;v.service.chat.post({room_id:v.room.id,to_member_id:v.member.id,text:'fixture question',idempotency_key:'duplicate-fixture'});await v.settle();assert.equal(v.posts.length,before);
});

test('unverified historical native binding cannot shadow an existing configured Grok notification',async t=>{
  const v=setup(t);v.configure();const original=v.legacyNative();assert.equal(v.service.desktop.nativeCapability('grok-bot').available,false);
  const capability=v.service.chat.deliveryCapability(v.member.id);assert.equal(capability.native_configured,true);assert.equal(capability.native_supported,false);assert.equal(capability.connection_method,'configured_notification');
  assert.equal(v.service.chat.adapter(v.service.chat.store.member(v.member.id)),v.service.chat.adapters.get('grok-bridge'));
  const message=v.post();await v.settle();assert.equal(v.posts.length,1);assert.equal(v.service.chat.store.message(message.id).status,'delivered');assert.deepEqual(v.service.desktop.row(v.member.id),original);assert.deepEqual(fs.readFileSync(v.entry.file),v.bytes);assert.equal(v.service.codex.calls.length,0);
});

test('usable native transport remains preferred and unsupported bindings without notification remain manual',async t=>{
  const v=setup(t);v.legacyNative();let capability=v.service.chat.deliveryCapability(v.member.id);assert.equal(capability.connection_method,'manual');assert.equal(v.service.chat.publicMember(v.service.chat.store.member(v.member.id)).manual_wake,true);
  v.configure();v.service.desktop.options.driverFactory=()=>assert.fail('fixture never constructs a real driver');v.service.desktop.clients.set(v.member.id,{closed:false,close(){}});v.service.desktop.saveSession(v.member.id,{state:'connected',error:null});
  capability=v.service.chat.deliveryCapability(v.member.id);assert.equal(capability.native_usable,true);assert.equal(capability.connection_method,'native_desktop');assert.equal(capability.can_wake,true);assert.equal(v.service.chat.adapter(v.service.chat.store.member(v.member.id)),v.service.desktop.adapter);assert.equal(v.posts.length,0);
});

test('pending native outcomes and previously dispatched messages never cross over to notification',async t=>{
  const v=setup(t);v.configure();v.legacyNative();const first=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:v.member.id,text:'old submitted question',idempotency_key:'old-native'});
  const stamp=now();v.service.store.db.prepare('INSERT INTO desktop_message_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(first.id,v.member.id,'existing-native-conversation',first.id,'uncertain',null,null,null,'original result pending',stamp,stamp);
  await v.service.chat.notifyMailbox(first);assert.equal(v.posts.length,0);const another=v.post();await v.settle();assert.equal(v.posts.length,0);assert.equal(v.service.chat.store.message(another.id).status,'queued');
  assert.equal(v.service.chat.deliveryCapability(v.member.id).routing_blocked,'native_outcome_uncertain');assert.equal((await v.service.entry.wake(v.room.id,v.member.id)).status,'needs_result_review');
  v.service.store.db.prepare("UPDATE desktop_message_runs SET status='completed' WHERE message_id=?").run(first.id);await v.service.chat.notifyMailbox(first);assert.equal(v.posts.length,0,'same native message is never sent again through another transport');
  v.service.chat.store.updateMessage(first.id,{status:'answered'});const fresh=v.post();await v.settle();assert.equal(v.posts.length,1);assert.equal(v.service.chat.store.message(fresh.id).status,'delivered');
});

test('legacy processing without a finished native record stays pending, and revoked notification cannot dispatch',async t=>{
  const v=setup(t);v.configure();v.legacyNative();const pending=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:v.member.id,text:'old processing question',idempotency_key:'old-processing'});v.service.chat.store.updateMessage(pending.id,{status:'processing'});
  const newer=v.post();await v.settle();assert.equal(v.posts.length,0);assert.equal(v.service.chat.store.message(newer.id).status,'queued');
  v.service.chat.store.updateMessage(pending.id,{status:'failed'});v.service.entry.revoke(v.member.id,v.room.id);assert.equal(v.service.chat.deliveryCapability(v.member.id).can_notify,false);v.post();await v.settle();assert.equal(v.posts.length,0);assert.deepEqual(fs.readFileSync(v.entry.file),v.bytes);
});

test('notification read status uses a stable vault instance and file changes invalidate the cache without sending',t=>{
  const v=setup(t),first=v.service.chat.memberVault(v.member.id);assert.equal(v.service.chat.memberVault(v.member.id),first);
  fs.mkdirSync(path.dirname(first.file),{recursive:true});fs.writeFileSync(first.file,JSON.stringify({mode:'invalid-fixture-no-decryption'}));const changed=v.service.chat.memberVault(v.member.id);assert.notEqual(changed,first);assert.equal(v.service.chat.memberVault(v.member.id),changed);
  v.service.chat.store.updateMember(v.member.id,{config:{...v.service.chat.store.member(v.member.id).config,webhook_enabled:true}});assert.equal(v.service.chat.deliveryCapability(v.member.id).notification_configured,false);assert.equal(v.posts.length,0);
});

test('notification errors do not expose the saved webhook URL or key and never retry an uncertain delivery',async t=>{
  const v=setup(t),{credential}=v.configure();v.service.fetch=async()=>{throw Error('fixture failure '+credential.url+' '+credential.key);};
  const message=v.post('uncertain-error');await v.settle();const shown=v.service.chat.room(v.room.id).messages.find(row=>row.id===message.id);assert.equal(shown.notification.status,'uncertain');assert.equal(shown.status,'uncertain');
  assert.equal(JSON.stringify(shown).includes(credential.key),false);assert.equal(JSON.stringify(shown).includes(credential.url),false);assert.equal(v.posts.length,0);
  v.service.fetch=async()=>assert.fail('uncertain delivery must not be retried');v.post('uncertain-error');await v.settle();
});

test('own inbox and HTTP inbox include only scoped controller assistance summaries, never handoff documents',async t=>{
  const v=setup(t),peer=v.service.chat.addMember({name:'Other recipient',adapter:'mailbox'});v.service.chat.join(v.room.id,peer.id);
  const message=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:v.member.id,text:'接入一下Codex',idempotency_key:'owned-connect'}),other=v.service.chat.store.post({room_id:v.room.id,sender_id:'user',to_member_id:peer.id,text:'other question',idempotency_key:'foreign-connect'});
  const assist={id:id(),room_id:v.room.id,message_id:message.id,member_id:v.member.id,provider:'codex',run_id:null,status:'needs_reauthorization',error:'original connection revoked',document_path:'C:\\private-credentials\\do-not-read.md',created:now(),updated:now()};
  v.service.store.db.prepare('INSERT INTO connection_assists(id,room_id,message_id,member_id,provider,run_id,status,error,document_path,created,updated) VALUES(:id,:room_id,:message_id,:member_id,:provider,:run_id,:status,:error,:document_path,:created,:updated)').run(assist);
  const original=v.service.connectionAssist.snapshotForMessage.bind(v.service.connectionAssist);v.service.connectionAssist.snapshotForMessage=messageId=>{const rows=original(messageId);return rows.length?[...rows,{...rows[0],id:'wrong-member',member_id:peer.id},{...rows[0],id:'wrong-message',message_id:other.id},{...rows[0],id:'wrong-room',room_id:id()}]:[];};v.service.connectionAssist.document=()=>assert.fail('inbox must not read any handoff document');
  const own=v.service.chat.inbox(v.member.id).find(row=>row.id===message.id);assert.equal(own.connection_assists.length,1);assert.equal(own.connection_assists[0].authority,'ao_controller');assert.match(own.connection_assists[0].next_step,/重新授权/);assert.equal(own.connection_assists[0].read_only,true);
  for(const forbidden of ['private-credentials','document_path','copy_sentence','wrong-member','wrong-message','wrong-room'])assert.equal(JSON.stringify(own).includes(forbidden),false,forbidden);
  assert.equal(v.service.chat.inbox(peer.id)[0].connection_assists,undefined);assert.equal(v.service.store.db.prepare('SELECT count(*) n FROM onboarding_runs').get().n,0);
  const server=createServer(v.service,{port:0,token:'fixture-inbox-controller'}),base='http://127.0.0.1:'+await server.listen();try{const response=await fetch(base+'/api/chat/inbox?member_id='+v.member.id,{headers:{Authorization:'Bearer fixture-inbox-controller'}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.items[0].connection_assists[0].message_id,message.id);assert.equal(JSON.stringify(body).includes('private-credentials'),false);}finally{await server.close();}
});
