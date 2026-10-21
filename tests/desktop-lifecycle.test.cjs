'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {desktopIntent,assertBackgroundAllowed,assertClosedIntent,activateDesktop,markDesktopClosed}=require('../src/desktop-lifecycle.cjs');
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-test-desktop-lifecycle-')),dir=path.join(root,'data');fs.mkdirSync(dir);t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^agentroom-test-desktop-lifecycle-/);fs.rmSync(root,{recursive:true,force:true});});return {root,dir,marker:path.join(dir,'desktop-lifecycle.json')};}
const control=()=>({pid:process.pid,owner_id:crypto.randomUUID(),instance_id:crypto.randomUUID(),url:'http://127.0.0.1:47831'});
test('unmanaged legacy CLI stays allowed and lifecycle observations create no files',t=>{
  const f=setup(t);assert.equal(desktopIntent(f.dir),null);assert.equal(assertBackgroundAllowed(f.dir),null);assert.deepEqual(fs.readdirSync(f.dir),[]);
  const absent=path.join(f.root,'not-created');assert.equal(assertBackgroundAllowed(absent),null);assert.equal(fs.existsSync(absent),false);
});
test('explicit activation permits background requests until that exact window closes',t=>{
  const f=setup(t),active=activateDesktop(f.dir);assert.equal(active.state,'active');assert.deepEqual(desktopIntent(f.dir),active);assert.deepEqual(assertBackgroundAllowed(f.dir),active);
  const closed=markDesktopClosed(f.dir,{expectedActivation:active.id,control:control()});assert.equal(closed.state,'closed');assert.equal(closed.activation_id,active.id);assert.notEqual(closed.id,active.id);
  const bytes=fs.readFileSync(f.marker,'utf8');for(let i=0;i<3;i++)assert.throws(()=>assertBackgroundAllowed(f.dir),error=>error.status===503&&error.code==='desktop_application_closed');assert.equal(fs.readFileSync(f.marker,'utf8'),bytes);
});
test('the host activation epoch survives a lost start response and a closed epoch cannot reactivate',t=>{
  const f=setup(t),epoch=crypto.randomUUID(),active=activateDesktop(f.dir,epoch);assert.equal(active.id,epoch);const original=fs.readFileSync(f.marker,'utf8');assert.deepEqual(activateDesktop(f.dir,epoch),active);assert.equal(fs.readFileSync(f.marker,'utf8'),original);
  for(const invalid of ['',null,{},'not-a-window'])assert.throws(()=>activateDesktop(f.dir,invalid),{code:'desktop_lifecycle_invalid'});
  const closed=markDesktopClosed(f.dir,{expectedActivation:epoch});assert.throws(()=>activateDesktop(f.dir,epoch),{code:'desktop_application_closed'});assert.deepEqual(desktopIntent(f.dir),closed);const next=activateDesktop(f.dir,crypto.randomUUID());assert.equal(next.state,'active');assert.notEqual(next.id,epoch);
});
test('opening again creates a new activation and an old window cannot close it',t=>{
  const f=setup(t),first=activateDesktop(f.dir);markDesktopClosed(f.dir,{expectedActivation:first.id});const next=activateDesktop(f.dir);assert.notEqual(next.id,first.id);
  const bytes=fs.readFileSync(f.marker,'utf8');assert.throws(()=>markDesktopClosed(f.dir,{expectedActivation:first.id,control:control()}),{code:'desktop_service_changed'});assert.equal(fs.readFileSync(f.marker,'utf8'),bytes);assert.deepEqual(assertBackgroundAllowed(f.dir),next);
});
test('an in-progress close must keep its exact intent before shutdown or owned-daemon termination',t=>{
  const f=setup(t),active=activateDesktop(f.dir),closed=markDesktopClosed(f.dir,{expectedActivation:active.id});assert.deepEqual(assertClosedIntent(f.dir,closed.id),closed);
  assert.throws(()=>assertClosedIntent(f.dir,crypto.randomUUID()),{code:'desktop_service_changed'});activateDesktop(f.dir);assert.throws(()=>assertClosedIntent(f.dir,closed.id),{code:'desktop_service_changed'});
});
test('closing is idempotent for the same activation and does not overwrite its pinned owner',t=>{
  const f=setup(t),active=activateDesktop(f.dir),original=control(),first=markDesktopClosed(f.dir,{expectedActivation:active.id,control:original}),bytes=fs.readFileSync(f.marker,'utf8');
  assert.deepEqual(markDesktopClosed(f.dir,{expectedActivation:active.id,control:control()}),first);assert.equal(fs.readFileSync(f.marker,'utf8'),bytes);assert.deepEqual(JSON.parse(bytes).control,original);
});
test('close retains only service identity, never controller credentials or extra control fields',t=>{
  const f=setup(t),active=activateDesktop(f.dir),pinned=control();markDesktopClosed(f.dir,{expectedActivation:active.id,control:{...pinned,token:'SYNTHETIC-CONTROLLER-SECRET',secret:'SYNTHETIC-EXTRA'}});
  const text=fs.readFileSync(f.marker,'utf8'),value=JSON.parse(text);assert.doesNotMatch(text,/SYNTHETIC|secret|token/i);assert.deepEqual(value.control,pinned);
});
test('unknown or malformed markers fail closed without replacing their contents',t=>{
  const f=setup(t),active=activateDesktop(f.dir),valid=JSON.parse(fs.readFileSync(f.marker,'utf8'));
  for(const value of ['broken json',null,[],{...valid,schema:'foreign'},{...valid,version:2},{...valid,id:'not-an-id'},{...valid,state:'unknown'},{...valid,updated_at:'invalid'},{...valid,token:'unexpected'},{...valid,state:'closed'},{...valid,state:'closed',activation_id:active.id,control:{...control(),token:'must-not-load'}}]){
    const text=typeof value==='string'?value:JSON.stringify(value);fs.writeFileSync(f.marker,text);
    for(const operation of [()=>desktopIntent(f.dir),()=>assertBackgroundAllowed(f.dir),()=>activateDesktop(f.dir),()=>markDesktopClosed(f.dir,{expectedActivation:active.id})])assert.throws(operation,{code:'desktop_lifecycle_invalid'});
    assert.equal(fs.readFileSync(f.marker,'utf8'),text);
  }
});
test('missing or stale close ownership cannot turn an unmanaged folder into a paused desktop',t=>{
  const f=setup(t);for(const expectedActivation of [undefined,'invalid',crypto.randomUUID()])assert.throws(()=>markDesktopClosed(f.dir,{expectedActivation}),{code:'desktop_service_changed'});assert.equal(desktopIntent(f.dir),null);assert.equal(fs.existsSync(f.marker),false);
});
test('invalid or credential-bearing service URLs cannot be persisted as close authority',t=>{
  const f=setup(t),active=activateDesktop(f.dir),bytes=fs.readFileSync(f.marker,'utf8'),valid=control();
  for(const pinned of [{...valid,pid:0},{...valid,owner_id:'unowned'},{...valid,instance_id:'foreign'},{...valid,url:'https://example.com'},{...valid,url:'http://127.0.0.1:47831/path'},{...valid,url:'http://127.0.0.1:47831/?token=fictional'},{...valid,url:'http://fictional@127.0.0.1:47831'}])assert.throws(()=>markDesktopClosed(f.dir,{expectedActivation:active.id,control:pinned}),{code:'desktop_lifecycle_invalid'});
  assert.equal(fs.readFileSync(f.marker,'utf8'),bytes);assert.deepEqual(assertBackgroundAllowed(f.dir),active);
});
test('a missing daemon may still close its own activation and legacy null owner fields stay bounded',t=>{
  const f=setup(t),active=activateDesktop(f.dir);markDesktopClosed(f.dir,{expectedActivation:active.id,control:null});assert.equal(JSON.parse(fs.readFileSync(f.marker,'utf8')).control,null);assert.throws(()=>assertBackgroundAllowed(f.dir),{code:'desktop_application_closed'});
  const reopened=activateDesktop(f.dir);markDesktopClosed(f.dir,{expectedActivation:reopened.id,control:{...control(),owner_id:null,instance_id:null}});assert.equal(desktopIntent(f.dir).state,'closed');
});
test('linked markers and mutex files cannot redirect lifecycle state writes',t=>{
  const f=setup(t),outside=path.join(f.root,'outside.json');fs.writeFileSync(outside,'preserve external fixture');fs.linkSync(outside,f.marker);
  for(const operation of [()=>assertBackgroundAllowed(f.dir),()=>activateDesktop(f.dir)])assert.throws(operation,{code:'desktop_lifecycle_invalid'});assert.equal(fs.readFileSync(outside,'utf8'),'preserve external fixture');fs.unlinkSync(f.marker);
  fs.linkSync(outside,path.join(f.dir,'desktop-lifecycle-mutex.sqlite'));assert.throws(()=>activateDesktop(f.dir),{code:'desktop_lifecycle_invalid'});assert.equal(fs.readFileSync(outside,'utf8'),'preserve external fixture');assert.equal(fs.existsSync(f.marker),false);
});
test('oversized and directory markers fail closed before native work can start',t=>{
  const f=setup(t);fs.writeFileSync(f.marker,' '.repeat(4097));assert.throws(()=>assertBackgroundAllowed(f.dir),{code:'desktop_lifecycle_invalid'});fs.unlinkSync(f.marker);fs.mkdirSync(f.marker);assert.throws(()=>assertBackgroundAllowed(f.dir),{code:'desktop_lifecycle_invalid'});
});
test('symbolic or reparse marker paths are rejected without following the target',t=>{
  const f=setup(t),target=path.join(f.root,'linked-directory');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'preserved'),'keep');
  try{fs.symlinkSync(target,f.marker,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Fixture symlink permission unavailable');return;}throw error;}
  for(const operation of [()=>assertBackgroundAllowed(f.dir),()=>activateDesktop(f.dir)])assert.throws(operation,{code:'desktop_lifecycle_invalid'});assert.equal(fs.readFileSync(path.join(target,'preserved'),'utf8'),'keep');
});
function worker(dir,activation,operation){
  const source=path.resolve(__dirname,'../src/desktop-lifecycle.cjs'),code="const m=require(process.argv[1]);try{const result=process.argv[4]==='activate'?m.activateDesktop(process.argv[2]):m.markDesktopClosed(process.argv[2],{expectedActivation:process.argv[3]});process.stdout.write(JSON.stringify({result}));}catch(error){process.stdout.write(JSON.stringify({error:error.code}));}";
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',code,source,dir,activation,operation],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned lifecycle worker timed out'));},10000);child.stdout.on('data',part=>out+=part);child.stderr.on('data',part=>err+=part);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',status=>{clearTimeout(timer);try{assert.equal(status,0,err);resolve(JSON.parse(out));}catch(error){reject(error);}});});
}
test('cross-process activation and stale close serialize without overwriting a newly opened window',async t=>{
  const f=setup(t),initial=activateDesktop(f.dir),[opened,closed]=await Promise.all([worker(f.dir,initial.id,'activate'),worker(f.dir,initial.id,'close')]);
  assert.equal(opened.result.state,'active');assert.ok(closed.result?.state==='closed'||closed.error==='desktop_service_changed');assert.deepEqual(desktopIntent(f.dir),opened.result);assert.deepEqual(assertBackgroundAllowed(f.dir),opened.result);
});
