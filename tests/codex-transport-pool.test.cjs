'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {acquireTransport}=require('../src/codex-transport-pool.cjs');
let sequence=0;
const key=()=>`isolated-pool-fixture-${++sequence}`;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class FakeOwner extends EventEmitter{
  constructor({closeGate,closeError}={}){super();this.closeCalls=0;this.rejections=[];this.closeGate=closeGate;this.closeError=closeError;this.readyCalls=0;}
  ready(){this.readyCalls++;return Promise.resolve();}
  rejectRequest(id,error){this.rejections.push({id,error});}
  async close(){this.closeCalls++;if(this.closeGate)await this.closeGate;if(this.closeError)throw this.closeError;}
}
function facade(name){const client=new EventEmitter();client.mcpEnvironment={AGENTROOM_MEMBER_ID:name};client.extraInstructions=`Instructions for ${name}`;return client;}
async function acquire(t,poolKey,client,createOwner){const handle=await acquireTransport(poolKey,client,createOwner);t.after(()=>handle.release());return handle;}

test('concurrent facades create exactly one owner and retain their separate member instructions',async t=>{
  const poolKey=key(),gate=deferred(),owner=new FakeOwner(),a=facade('a'),b=facade('b');let creations=0;
  const createOwner=async()=>{creations++;await gate.promise;return owner;};
  const first=acquire(t,poolKey,a,createOwner),second=acquire(t,poolKey,b,createOwner);
  await Promise.resolve();assert.equal(creations,1);gate.resolve();const [ha,hb]=await Promise.all([first,second]);
  assert.equal(ha.owner,owner);assert.equal(hb.owner,owner);assert.equal(creations,1);assert.equal(owner.readyCalls,0,'acquisition does not start any model or process');
  assert.deepEqual(a.mcpEnvironment,{AGENTROOM_MEMBER_ID:'a'});assert.deepEqual(b.mcpEnvironment,{AGENTROOM_MEMBER_ID:'b'});
  assert.equal(a.extraInstructions,'Instructions for a');assert.equal(b.extraInstructions,'Instructions for b');
  await ha.release();assert.equal(owner.closeCalls,0);await hb.release();assert.equal(owner.closeCalls,1);
});

test('different canonical pool keys cannot share an owner',async t=>{
  const owners=[new FakeOwner(),new FakeOwner()],a=await acquire(t,key(),facade('a'),()=>owners[0]),b=await acquire(t,key(),facade('b'),()=>owners[1]);
  assert.notEqual(a.owner,b.owner);await a.release();assert.equal(owners[0].closeCalls,1);assert.equal(owners[1].closeCalls,0);
});

test('notifications and disconnects reach each current facade once through one owner listener',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),eventsA=[],eventsB=[];
  const ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>assert.fail('must reuse owner'));
  for(const event of ['notification','disconnected']){a.on(event,payload=>eventsA.push([event,payload]));b.on(event,payload=>eventsB.push([event,payload]));assert.equal(owner.listenerCount(event),1);}
  const message={method:'turn/completed',params:{threadId:'thread-a'}},error=new Error('fixture disconnect');owner.emit('notification',message);owner.emit('disconnected',error);
  assert.deepEqual(eventsA,[['notification',message],['disconnected',error]]);assert.deepEqual(eventsB,eventsA);
  await ha.release();owner.emit('notification',message);assert.equal(eventsA.length,2);assert.equal(eventsB.length,3);assert.equal(owner.closeCalls,0);
  await hb.release();for(const event of ['notification','disconnected','request','transport-progress'])assert.equal(owner.listenerCount(event),0);
});

test('native approval requests route to the registered thread facade only',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),requestsA=[],requestsB=[];
  const ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>owner);ha.registerThread('thread-a');hb.registerThread('thread-b');
  a.on('request',request=>requestsA.push(request));b.on('request',request=>requestsB.push(request));
  const requestA={id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread-a'}},requestB={id:2,method:'item/commandExecution/requestApproval',params:{thread_id:'thread-b'}};
  owner.emit('request',requestA);owner.emit('request',requestB);
  assert.deepEqual(requestsA,[requestA]);assert.deepEqual(requestsB,[requestB]);assert.equal(owner.rejections.length,0);assert.equal(owner.listenerCount('request'),1);
});

test('one facade callback failure cannot hide completion or disconnect from another member',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),seen=[],failures=[];
  await acquire(t,poolKey,a,()=>owner);await acquire(t,poolKey,b,()=>owner);
  const notificationError=new Error('fixture completion callback'),disconnectError=new Error('fixture disconnect callback');
  a.on('notification',()=>{throw notificationError;});a.on('disconnected',()=>{throw disconnectError;});a.on('transport-callback-error',value=>{failures.push(value);throw Error('fixture diagnostic callback');});
  b.on('notification',value=>seen.push(value));b.on('disconnected',value=>seen.push(value));
  const notification={method:'turn/completed',params:{threadId:'b'}},disconnected=new Error('native transport closed');
  assert.doesNotThrow(()=>owner.emit('notification',notification));assert.doesNotThrow(()=>owner.emit('disconnected',disconnected));
  assert.deepEqual(seen,[notification,disconnected]);assert.deepEqual(failures,[{event:'notification',error:notificationError},{event:'disconnected',error:disconnectError}]);
  assert.equal(owner.rejections.length,0);assert.equal(owner.closeCalls,0);
});

test('unknown missing and conflicting native thread identities are each rejected once instead of broadcast',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b');
  const ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>owner);ha.registerThread('a');hb.registerThread('b');
  a.on('request',()=>assert.fail('unowned requests must not reach a'));b.on('request',()=>assert.fail('unowned requests must not reach b'));
  const params=[{threadId:'missing'},{},{threadId:'a',thread_id:'b'},{threadId:1},{threadId:''},{thread_id:null}];
  params.forEach((value,index)=>owner.emit('request',{id:index+1,method:'fixtureApproval',params:value}));
  assert.deepEqual(owner.rejections.map(item=>item.id),[1,2,3,4,5,6]);assert.ok(owner.rejections.every(item=>item.error.code===-32602));
});

test('a registered thread without an approval handler fails closed once',async t=>{
  const owner=new FakeOwner(),handle=await acquire(t,key(),facade('a'),()=>owner);handle.registerThread('a');
  owner.emit('request',{id:'missing-handler',method:'fixtureApproval',params:{threadId:'a'}});
  assert.equal(owner.rejections.length,1);assert.equal(owner.rejections[0].id,'missing-handler');assert.equal(owner.rejections[0].error.code,-32602);
});

test('a second facade cannot overwrite another member thread route',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),seen=[];
  const ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>owner);ha.registerThread('same');ha.registerThread('same');
  assert.throws(()=>hb.registerThread('same'),{code:'codex_transport_thread_conflict'});
  a.on('request',request=>seen.push(request.id));b.on('request',()=>assert.fail('thread ownership must not change'));
  owner.emit('request',{id:7,params:{threadId:'same',thread_id:'same'}});assert.deepEqual(seen,[7]);assert.equal(owner.rejections.length,0);
});

test('releasing one facade removes only its routes and preserves the other owner and requests',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),seen=[];
  const ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>owner);ha.registerThread('a1');ha.registerThread('a2');hb.registerThread('b');
  a.on('request',()=>assert.fail('released member must not receive requests'));b.on('request',request=>seen.push(request.id));await ha.release();
  owner.emit('request',{id:1,params:{threadId:'a1'}});owner.emit('request',{id:2,params:{threadId:'a2'}});owner.emit('request',{id:3,params:{threadId:'b'}});
  assert.equal(owner.closeCalls,0);assert.deepEqual(owner.rejections.map(item=>item.id),[1,2]);assert.deepEqual(seen,[3]);
  hb.registerThread('a1');owner.emit('request',{id:4,params:{threadId:'a1'}});assert.deepEqual(seen,[3,4]);
});

test('transport progress is exposed only when exactly one distinct facade holds the owner',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),seenA=[],seenB=[];
  a.on('transport-progress',value=>seenA.push(value));b.on('transport-progress',value=>seenB.push(value));
  const ha=await acquire(t,poolKey,a,()=>owner);owner.emit('transport-progress','one');const hb=await acquire(t,poolKey,b,()=>owner);owner.emit('transport-progress','private-unknown');
  assert.deepEqual(seenA,['one']);assert.deepEqual(seenB,[]);await ha.release();owner.emit('transport-progress','two');assert.deepEqual(seenB,['two']);await hb.release();
});

test('active work counts facade listeners and excludes the pool owner forwarder',async t=>{
  const owner=new FakeOwner(),poolKey=key(),a=facade('a'),b=facade('b'),ha=await acquire(t,poolKey,a,()=>owner),hb=await acquire(t,poolKey,b,()=>owner),listener=()=>{};
  assert.equal(owner.listenerCount('notification'),1);assert.equal(ha.hasActiveWork(),false);a.on('request',listener);assert.equal(hb.hasActiveWork(),false);
  b.on('notification',listener);assert.equal(ha.hasActiveWork(),true);assert.equal(hb.hasActiveWork(),true);b.off('notification',listener);assert.equal(ha.hasActiveWork(),false);
  a.on('notification',listener);assert.equal(hb.hasActiveWork(),true);await ha.release();assert.equal(hb.hasActiveWork(),false,'released facades cannot keep an idle owner busy');
});

test('duplicate acquisition by the same facade keeps its routes until the last handle is released',async t=>{
  const owner=new FakeOwner(),poolKey=key(),client=facade('a'),seen=[],ha=await acquire(t,poolKey,client,()=>owner),hb=await acquire(t,poolKey,client,()=>assert.fail('must reuse'));
  client.on('request',value=>seen.push(value.id));ha.registerThread('a');await ha.release();owner.emit('request',{id:1,params:{threadId:'a'}});
  assert.deepEqual(seen,[1]);assert.equal(owner.closeCalls,0);hb.registerThread('b');await hb.release();assert.equal(owner.closeCalls,1);
});

test('release is idempotent and returns the same final close promise',async t=>{
  const gate=deferred(),owner=new FakeOwner({closeGate:gate.promise}),handle=await acquire(t,key(),facade('a'),()=>owner);
  const first=handle.release(),second=handle.release();assert.equal(first,second);await Promise.resolve();assert.equal(owner.closeCalls,1);
  assert.throws(()=>handle.registerThread('late'),{code:'codex_transport_released'});gate.resolve();await first;await handle.release();assert.equal(owner.closeCalls,1);
});

test('acquisition during owner close waits before creating a replacement and concurrent waiters coalesce',async t=>{
  const gate=deferred(),oldOwner=new FakeOwner({closeGate:gate.promise}),nextOwner=new FakeOwner(),poolKey=key(),original=await acquire(t,poolKey,facade('old'),()=>oldOwner);let creations=0;
  const closing=original.release();await Promise.resolve();assert.equal(oldOwner.closeCalls,1);
  const createNext=()=>{creations++;return nextOwner;},a=acquire(t,poolKey,facade('new-a'),createNext),b=acquire(t,poolKey,facade('new-b'),createNext);
  await Promise.resolve();await Promise.resolve();assert.equal(creations,0,'no overlapping owner may start before close settles');
  gate.resolve();await closing;const [ha,hb]=await Promise.all([a,b]);assert.equal(creations,1);assert.equal(ha.owner,nextOwner);assert.equal(hb.owner,nextOwner);assert.notEqual(ha.owner,oldOwner);
  await ha.release();assert.equal(nextOwner.closeCalls,0);await hb.release();assert.equal(nextOwner.closeCalls,1);
});

test('an owner construction failure is shared then removed so an explicit later acquire can recover',async t=>{
  const poolKey=key(),gate=deferred(),error=new Error('fixture construction failed');let creations=0;
  const create=async()=>{creations++;await gate.promise;throw error;},a=acquireTransport(poolKey,facade('a'),create),b=acquireTransport(poolKey,facade('b'),create);
  const rejected=Promise.all([assert.rejects(a,value=>value===error),assert.rejects(b,value=>value===error)]);await Promise.resolve();assert.equal(creations,1);gate.resolve();await rejected;
  const owner=new FakeOwner(),recovered=await acquire(t,poolKey,facade('recover'),()=>{creations++;return owner;});assert.equal(creations,2);assert.equal(recovered.owner,owner);
});

test('a failed close rejects a waiting acquire and never silently swaps it onto a new owner',async t=>{
  const poolKey=key(),gate=deferred(),error=new Error('fixture close failed'),owner=new FakeOwner({closeGate:gate.promise,closeError:error}),handle=await acquireTransport(poolKey,facade('old'),()=>owner);
  const closing=handle.release(),closed=assert.rejects(closing,value=>value===error);let creations=0;
  const waiting=acquireTransport(poolKey,facade('waiting'),()=>{creations++;return new FakeOwner();}),rejected=assert.rejects(waiting,value=>value===error);
  gate.resolve();await Promise.all([closed,rejected]);assert.equal(creations,0);assert.equal(owner.listenerCount('request'),0);
  const replacement=new FakeOwner();await acquire(t,poolKey,facade('explicit-retry'),()=>replacement);
});

test('a lost rejection channel does not cause retries or broadcast an unowned approval',async t=>{
  const owner=new FakeOwner(),handle=await acquire(t,key(),facade('a'),()=>owner);let attempts=0;
  owner.rejectRequest=()=>{attempts++;throw Error('fixture channel closed');};assert.doesNotThrow(()=>owner.emit('request',{id:1,params:{}}));assert.equal(attempts,1);
  owner.rejectRequest=()=>{attempts++;return Promise.reject(Error('fixture asynchronous close'));};owner.emit('request',{id:2,params:{}});await Promise.resolve();assert.equal(attempts,2);assert.equal(handle.owner,owner);
});

test('invalid registrations and owner identities fail without attaching recursive event forwarding',async t=>{
  await assert.rejects(acquireTransport('',facade('a'),()=>new FakeOwner()),{code:'codex_transport_invalid'});
  const same=new FakeOwner(),poolKey=key();await assert.rejects(acquireTransport(poolKey,same,()=>same),{code:'codex_transport_owner_conflict'});assert.equal(same.listenerCount('request'),0);
  await assert.rejects(acquireTransport(key(),facade('invalid-owner'),()=>new EventEmitter()),{code:'codex_transport_invalid_owner'});
  const owner=new FakeOwner(),handle=await acquire(t,poolKey,facade('valid'),()=>owner);for(const value of [null,undefined,1,'','  '])assert.throws(()=>handle.registerThread(value),{code:'codex_transport_thread_invalid'});
  await assert.rejects(acquireTransport(poolKey,owner,()=>assert.fail('must not construct')),{code:'codex_transport_owner_conflict'});assert.equal(owner.closeCalls,0);
});
