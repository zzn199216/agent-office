'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CodexClient}=require('../src/codex.cjs'),{fixture}=require('./helpers.cjs');
function setup(t){const files=fixture(),legacyHome=path.join(files.root,'personal');fs.mkdirSync(legacyHome);const client=new CodexClient({executable:process.execPath,args:[path.join(__dirname,'fake-auth-cache-app-server.cjs')],dataDir:files.data,legacyHome});t.after(async()=>{await client.close();const root=path.resolve(files.root);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-test-/);fs.rmSync(root,{recursive:true,force:true});});return{...files,legacyHome,client,home:client.workspace.home};}
test('login environment preparation does not start the private app-server or rewrite an existing independent login',async t=>{
  const f=setup(t),environment=await f.client.authenticationEnvironment();assert.equal(environment.CODEX_HOME,f.home);assert.equal(f.client.child,null);assert.equal(fs.existsSync(path.join(f.home,'auth-rpc.jsonl')),false);
  fs.writeFileSync(path.join(f.home,'auth.json'),'independent-fixture-login');fs.writeFileSync(path.join(f.legacyHome,'auth.json'),'new-personal-fixture-login');await f.client.authenticationEnvironment();assert.equal(fs.readFileSync(path.join(f.home,'auth.json'),'utf8'),'independent-fixture-login');
});
test('completed independent login invalidation reloads an idle app-server account cache without claiming signed in early',async t=>{
  const f=setup(t);assert.equal((await f.client.status()).signedIn,false);const original=f.client.child.pid;fs.writeFileSync(path.join(f.home,'auth.json'),'opaque-fixture-login');assert.equal((await f.client.status()).signedIn,false);
  f.client.invalidateAuthentication();assert.equal(f.client.child.pid,original);assert.equal((await f.client.status()).signedIn,true);assert.notEqual(f.client.child.pid,original);assert.equal(fs.readFileSync(path.join(f.home,'auth.json'),'utf8'),'opaque-fixture-login');
});
test('login cache invalidation defers transport replacement while a native turn or pending RPC still owns it',async t=>{
  const f=setup(t);await f.client.status();const original=f.client.child.pid,activeTurn=()=>{};f.client.on('notification',activeTurn);fs.writeFileSync(path.join(f.home,'auth.json'),'opaque-fixture-login');f.client.invalidateAuthentication();assert.equal((await f.client.status()).signedIn,false);assert.equal(f.client.child.pid,original);f.client.off('notification',activeTurn);
  const held=f.client.call('hold',{},100);const rejected=assert.rejects(held,{code:'rpc_timeout'});await f.client.ready();assert.equal(f.client.child.pid,original);await rejected;assert.equal((await f.client.status()).signedIn,true);assert.notEqual(f.client.child.pid,original);
});
test('authentication invalidation during workspace preparation cannot open a second concurrent app-server',async()=>{
  const client=new CodexClient({executable:process.execPath,isolate:false});let release,calls=0;const gate=new Promise(resolve=>release=resolve);client.connect=async()=>{calls++;await gate;return{userAgent:'connecting-fixture'};};
  const first=client.ready();client.invalidateAuthentication();const second=client.ready();assert.equal(calls,1);release();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(client.authenticationDirty,true);await client.ready();assert.equal(calls,2);await client.close();
});
