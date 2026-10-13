'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {fixture,FakeCodex,FakeVault}=require('./helpers.cjs');
test('offline packaged avatar HTTP preserves actual binary bytes, MIME types and only public resource paths',async t=>{
  const f=fixture(),service=new RoomService(f.data,{codex:new FakeCodex(),vault:new FakeVault()}),server=createServer(service,{token:'local-test-controller',port:0}),port=await server.listen();
  t.after(async()=>{await server.close();await service.close();assert.equal(path.dirname(path.resolve(f.root)),path.resolve(os.tmpdir()));assert.match(path.basename(f.root),/^agentroom-test-/);fs.rmSync(f.root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;
  for(const provider of require('../src/office-assets.cjs').PIXEL_IDS){
    const response=await fetch(base+'/assets/office/pixel-avatar-'+provider+'.png');assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    const bytes=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.resolve(__dirname,'../web/assets/office/pixel-avatar-'+provider+'.png'));assert.deepEqual(bytes,expected);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  }
  const sources=await fetch(base+'/assets/office/AVATAR_SOURCES.json');assert.equal(sources.status,200);assert.match(sources.headers.get('content-type'),/application\/json/);assert.equal((await sources.json()).runtime_network_required,false);
  assert.equal((await fetch(base+'/assets/office/does-not-exist.png')).status,404);
  assert.equal((await fetch(base+'/assets/office/avatar-codex.png')).status,404);
  assert.equal((await fetch(base+'/private/assets/office/pixel-avatar-codex.png')).status,401);
  assert.equal(service.chat.store.members().length,0);assert.equal(service.launch.jobs.size,0);
});
