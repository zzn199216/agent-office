'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {RoomService} = require('../src/service.cjs');
const {connectionStats,since} = require('../src/stats.cjs');
const {fixture,FakeCodex,FakeVault} = require('./helpers.cjs');
const {id,now} = require('../src/util.cjs');

function setup(t) {
  const files=fixture(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault(),launch:{discover:()=>({candidates:[]})}});
  const project=service.addProject({path:files.project,name:'private project'}),room=service.chat.addRoom({project_id:project.id,title:'private room'});
  t.after(async()=>{await service.close();fs.rmSync(files.root,{recursive:true,force:true});});
  const db=service.store.db;
  const run=()=>{const row={id:id(),room_id:room.id,provider:'codex'};db.prepare("INSERT INTO onboarding_runs(id,room_id,requested_provider,provider,mode,status,stage,created,updated) VALUES(?,?,? ,?,'managed','needs_action','awaiting_connection',?,?)").run(row.id,room.id,'codex','codex',now(),now());service.onboarding.attempts.begin(row);return row;};
  return {files,service,db,room,run};
}
test('versioned attempts distinguish retry success and preserve historical rows without backfilling',async t=>{
  const v=setup(t),first=v.run();
  v.service.onboarding.attempts.observe(first,{error:'must never appear',error_code:'codex_login_required'});
  const retry=v.run();v.service.onboarding.attempts.observe(retry,{ready_for_office:true,protocol_verified:true,automatic_reply_verified:true});
  const result=connectionStats(v.files.data);
  assert.equal(result.connections.attempts,2);assert.equal(result.connections.retries,1);assert.equal(result.connections.first_connected,0);assert.equal(result.connections.retry_connected,1);
  assert.equal(result.connections.mcp_connected_attempts,1);assert.equal(result.connections.automatic_reply_verified_attempts,1);
  assert.deepEqual(result.failure_reasons,[{code:'codex_login_required',count:1}]);
  assert.equal(connectionStats(v.files.data,{sinceVersion:'0.15.0-preview.99'}).connections.attempts,0);
  assert.equal(since('0.15.0','0.15.0-preview.99'),true);
  assert.equal(since('0.15.0-preview.9','0.15.0-preview.21'),false);
});
test('stats is deterministic, does not write the database or start a service, and rejects member scope',async t=>{
  const v=setup(t);v.run();
  const hashes=()=>Object.fromEntries(fs.readdirSync(v.files.data).filter(name=>name==='room.sqlite'||name==='room.sqlite-wal').map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(v.files.data,name))).digest('hex')]));
  const before=hashes(),a=connectionStats(v.files.data),b=connectionStats(v.files.data);assert.deepEqual(a,b);assert.deepEqual(hashes(),before);
  const env={...process.env};delete env.AGENTROOM_MEMBER_ID;delete env.AGENTROOM_ROOM_ID;
  const args=['src/main.cjs','stats','--data-dir',v.files.data,'--json'];
  const cli=spawnSync(process.execPath,args,{encoding:'utf8',env});assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),a);
  assert.equal(fs.existsSync(path.join(v.files.data,'control.json')),false);
  assert.equal(spawnSync(process.execPath,args,{env:{...env,AGENTROOM_MEMBER_ID:'not-authorized'}}).status,1);
  assert.equal(JSON.stringify(a).includes(v.files.root),false);
});
test('message ratios require a correlated reply from the recipient and exclude connection probes',async t=>{
  const v=setup(t),store=v.service.chat.store,member=store.addMember({name:'private member',adapter:'mailbox'});
  store.join(v.room.id,member.id);
  const post=(sender,to,text,extra={})=>store.post({room_id:v.room.id,sender_id:sender,to_member_id:to,text,idempotency_key:id(),...extra});
  const a=post('user',member.id,'private request'),b=post('user',member.id,'no reply');
  post(member.id,null,'private reply',{reply_to:a.id,kind:'reply'});
  post('user',member.id,'private probe',{idempotency_key:'onboarding-verification:fixture'});
  const report=connectionStats(v.files.data);
  assert.equal(report.messages[0].requests,2);assert.equal(report.messages[0].reply_ratio,0.5);
  assert.doesNotMatch(JSON.stringify(report),/private|no reply/);
  assert.equal(report.rooms.created,1);assert.ok(b.id);
});

test('terminal failures are separate from waiting and can later become retry success',async t=>{
  const v=setup(t),first=v.run();v.service.onboarding.attempts.observe(first,{status:'error',error:'fixture',error_code:'claude_api_key_missing'});
  const before=connectionStats(v.files.data);assert.equal(before.connections.failed,1);assert.equal(before.connections.waiting,0);
  const retry=v.run();v.service.onboarding.attempts.observe(retry,{ready_for_office:true,protocol_verified:true});const after=connectionStats(v.files.data);assert.equal(after.connections.retry_connected,1);assert.equal(after.connections.failed,0);assert.equal(after.failure_reasons[0].code,'claude_api_key_missing');
});
