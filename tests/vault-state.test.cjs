'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Vault}=require('../src/vault.cjs'),{RoomService}=require('../src/service.cjs'),{fixture,FakeCodex}=require('./helpers.cjs'),{now}=require('../src/util.cjs');
const credential={url:'https://api2.cursor.sh/automations/webhook/isolated-vault-fixture',key:'fixture-private-key'};
function files(t){const f=fixture();t.after(async()=>{if(f.service)await f.service.close();const target=path.resolve(f.root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentroom-test-/);fs.rmSync(target,{recursive:true,force:true});});return f;}
function save(file,value='encrypted-fixture'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({mode:'dpapi',value}));}
test('cold encrypted status is metadata only and never invokes DPAPI or reports unknown credentials usable',t=>{
  const f=files(t);let decrypts=0;const vault=new Vault(f.data,{platform:'win32',dpapi:()=>{decrypts++;return JSON.stringify(credential);}});save(vault.file);
  for(let n=0;n<5;n++)assert.deepEqual(vault.status(),{configured:true,host:null,protection:'Windows DPAPI',usable:null});
  assert.equal(decrypts,0);assert.equal(JSON.stringify(vault.status()).includes('encrypted-fixture'),false);
  assert.deepEqual(vault.get(),credential);assert.equal(decrypts,1);assert.equal(vault.status().usable,true);assert.equal(vault.status().host,'api2.cursor.sh');assert.equal(decrypts,1);
});
test('a failed credential unlock is cached for its record and status remains safe until explicit retry or replacement',t=>{
  const f=files(t);let decrypts=0,fail=true;const vault=new Vault(f.data,{platform:'win32',dpapi:()=>{decrypts++;if(fail)throw Error('private diagnostic must not escape');return JSON.stringify(credential);}});save(vault.file);
  assert.throws(()=>vault.get(),{code:'vault_unavailable'});assert.throws(()=>vault.get(),{code:'vault_unavailable'});
  for(let n=0;n<10;n++){const state=vault.status();assert.equal(state.configured,true);assert.equal(state.usable,false);assert.equal(state.code,'vault_unavailable');assert.doesNotMatch(JSON.stringify(state),/private diagnostic|encrypted-fixture|fixture-private-key/);}
  assert.equal(decrypts,1);fail=false;assert.deepEqual(vault.get({retry:true}),credential);assert.equal(decrypts,2);assert.equal(vault.status().usable,true);
  save(vault.file,'different-longer-encrypted-fixture');assert.equal(vault.status().usable,null);assert.deepEqual(vault.get(),credential);assert.equal(decrypts,3);
});
test('invalid saved metadata does not break status and explicit save restores checked state without disclosing secrets',t=>{
  const f=files(t);let calls=0;const vault=new Vault(f.data,{platform:'win32',dpapi:()=>{calls++;return 'new-ciphertext';}});fs.mkdirSync(f.data,{recursive:true});fs.writeFileSync(vault.file,'not json');
  assert.equal(vault.status().configured,false);assert.equal(vault.status().usable,false);assert.throws(()=>vault.get(),{code:'vault_unavailable'});assert.equal(calls,0);
  const status=vault.set(credential.url,credential.key);assert.equal(status.configured,true);assert.equal(status.usable,true);assert.equal(status.host,'api2.cursor.sh');assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(status),/fixture-private-key|new-ciphertext/);
});
test('service and member snapshots never unlock cold credentials; only an explicit notification unlocks and sends once',async t=>{
  const f=files(t);let globalUnlocks=0,memberUnlocks=0,posts=0;const globalVault=new Vault(f.data,{platform:'win32',dpapi:()=>{globalUnlocks++;throw Error('status must not unlock');}});save(globalVault.file);
  const service=f.service=new RoomService(f.data,{codex:new FakeCodex(),vault:globalVault,fetch:async()=>{posts++;return{ok:true,json:async()=>({success:true})};}});
  const project=service.addProject({path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'Vault isolation'}),member=service.chat.addMember({name:'Cold notification',adapter:'grok-bridge'});service.chat.join(room.id,member.id);service.chat.store.updateMember(member.id,{status:'ready',verified_at:now(),config:{webhook_enabled:true}});
  const vault=new Vault(path.join(f.data,'members',member.id),{platform:'win32',dpapi:()=>{memberUnlocks++;return JSON.stringify(credential);}});save(vault.file);service.chat.memberVaults.set(member.id,{vault,stamp:service.chat.memberVaultStamp(vault.file)});
  for(let n=0;n<4;n++){const state=service.snapshot(),person=state.chat.members.find(item=>item.id===member.id);assert.equal(state.grok.usable,null);assert.equal(person.delivery_capability.notification_configured,true);assert.equal(person.delivery_capability.notification_usable,null);assert.equal(person.can_notify,false);}
  assert.equal(globalUnlocks,0);assert.equal(memberUnlocks,0);assert.equal(posts,0);
  const message=service.chat.store.post({room_id:room.id,to_member_id:member.id,text:'One authorized fixture wake',idempotency_key:'single-notification'});await service.chat.notifyMailbox(message);
  assert.equal(memberUnlocks,1);assert.equal(posts,1);assert.equal(service.chat.store.message(message.id).status,'delivered');assert.equal(service.chat.deliveryCapability(member.id).can_notify,true);await service.chat.notifyMailbox(message);assert.equal(posts,1);assert.equal(globalUnlocks,0);
});
test('a real notification cannot bypass a failed unlock and later snapshots never retry or fake readiness',async t=>{
  const f=files(t);let unlocks=0,posts=0;const service=f.service=new RoomService(f.data,{codex:new FakeCodex(),vault:new Vault(f.data),fetch:async()=>{posts++;assert.fail('unavailable credentials must never send');}});
  const project=service.addProject({path:f.project}),room=service.chat.addRoom({project_id:project.id,title:'Denied credential'}),member=service.chat.addMember({name:'Unavailable notification',adapter:'grok-bridge'});service.chat.join(room.id,member.id);service.chat.store.updateMember(member.id,{status:'ready',verified_at:now(),config:{webhook_enabled:true}});
  const vault=new Vault(path.join(f.data,'members',member.id),{platform:'win32',dpapi:()=>{unlocks++;throw Error('fixture failure');}});save(vault.file);service.chat.memberVaults.set(member.id,{vault,stamp:service.chat.memberVaultStamp(vault.file)});
  const message=service.chat.store.post({room_id:room.id,to_member_id:member.id,text:'Explicit fixture attempt',idempotency_key:'failed-unlock'});await assert.rejects(service.chat.notifyMailbox(message),{code:'vault_unavailable'});
  for(let n=0;n<5;n++){assert.equal(service.snapshot().chat.members.find(item=>item.id===member.id).can_notify,false);assert.equal(service.chat.deliveryCapability(member.id).notification_usable,false);}
  await assert.rejects(service.chat.notifyMailbox(message),{code:'vault_unavailable'});assert.equal(unlocks,1);assert.equal(posts,0);assert.equal(service.chat.store.notification(message.id),null);
});
