'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {CodexWorkspace}=require('../src/codex-workspace.cjs');
const {CodexClient}=require('../src/codex.cjs');
const {id,normalizePath,RoomError}=require('../src/util.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ao-rollout-recovery-')),data=path.join(root,'data'),native=path.join(root,'native'),home=path.join(data,'codex'),project={path:path.join(root,'project')};
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(project.path);project.canonical=normalizePath(project.path);fs.mkdirSync(home,{recursive:true});fs.mkdirSync(path.join(native,'archived_sessions'),{recursive:true});
  fs.writeFileSync(path.join(home,'agentoffice-workspace.json'),JSON.stringify({schema:'agentoffice.codex-workspace',version:1,prepared:true,legacy_home:native}));
  const threadId=id(),name='rollout-2026-10-26T01-00-00-'+threadId+'.jsonl',old=path.join(native,'sessions','2026','10','26',name),current=path.join(native,'archived_sessions',name);
  fs.writeFileSync(current,JSON.stringify({type:'session_meta',payload:{id:threadId,cwd:project.path}})+'\n'+JSON.stringify({type:'event_msg',payload:{text:'synthetic preserved history'}})+'\n');
  function database(folder,rollout,archived){const file=path.join(folder,'state_5.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,archived INTEGER,archived_at INTEGER,permission_marker TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(threadId,rollout,project.path,archived,archived?123:null,'keep permissions');db.close();return file;}
  const source=database(native,current,1),local=database(home,old,0),workspace=new CodexWorkspace(data,{legacyHome:native});
  const query=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return {...db.prepare('SELECT * FROM threads WHERE id=?').get(threadId)};}finally{db.close();}};
  const change=(file,column,value)=>{assert.ok(['cwd','rollout_path'].includes(column));const db=new DatabaseSync(file);try{db.prepare('UPDATE threads SET '+column+'=? WHERE id=?').run(value,threadId);}finally{db.close();}};
  return {root,data,native,home,project,threadId,old,current,source,local,workspace,query,change};
}
test('reconcile only the bound private index after native archival without moving or copying history',t=>{
  const f=fixture(t),source=fs.readFileSync(f.source),history=fs.readFileSync(f.current),before=f.query(f.local);
  assert.equal(f.workspace.refreshBoundRollout(f.threadId,f.project),true);
  assert.deepEqual(f.query(f.local),{...before,rollout_path:f.current,archived:1,archived_at:123});
  assert.deepEqual(fs.readFileSync(f.source),source);assert.deepEqual(fs.readFileSync(f.current),history);assert.equal(fs.existsSync(f.old),false);
  assert.equal(f.workspace.refreshBoundRollout(f.threadId,f.project),false,'an existing current path is never rewritten');
});
test('reject a foreign, missing or misidentified rollout and preserve the private index',async t=>{
  for(const mode of ['wrong-id','wrong-header-cwd','wrong-native-cwd','wrong-local-cwd','outside','missing','existing-old'])await t.test(mode,t=>{
    const f=fixture(t);
    if(mode==='wrong-id'||mode==='wrong-header-cwd')fs.writeFileSync(f.current,JSON.stringify({type:'session_meta',payload:{id:mode==='wrong-id'?id():f.threadId,cwd:mode==='wrong-header-cwd'?f.root:f.project.path}})+'\n');
    if(mode==='wrong-native-cwd')f.change(f.source,'cwd',f.root);
    if(mode==='wrong-local-cwd')f.change(f.local,'cwd',f.root);
    if(mode==='outside'){const outside=path.join(f.root,path.basename(f.current));fs.copyFileSync(f.current,outside);f.change(f.source,'rollout_path',outside);}
    if(mode==='missing')fs.renameSync(f.current,f.current+'.unavailable');
    if(mode==='existing-old'){fs.mkdirSync(path.dirname(f.old),{recursive:true});fs.copyFileSync(f.current,f.old);}
    const before=f.query(f.local);assert.equal(f.workspace.refreshBoundRollout(f.threadId,f.project),false);assert.deepEqual(f.query(f.local),before);
  });
});
function client(f){
  const c=new CodexClient({dataDir:f.data,legacyHome:f.native,authenticationMode:'shared-cache'}),calls=[];
  c.ready=async()=>({});c.read=async threadId=>{calls.push({method:'thread/read',threadId});const row=f.query(f.local);if(!fs.existsSync(row.rollout_path))throw new RoomError('invalid paginated history lineage for '+threadId+': missing source rollout',502,'codex_rpc_error');return {id:threadId,cwd:f.project.path,path:row.rollout_path,turns:[{id:'retained-turn'}]};};
  c.call=async(method,params)=>{calls.push({method,params});if(method==='config/read')return {config:{}};if(method==='thread/resume')return {thread:{id:f.threadId}};throw Error('Unexpected RPC: '+method);};
  return {c,calls};
}
test('execution recovers a relocated active binding and resumes once without creating or replaying a turn',async t=>{
  const f=fixture(t),{c,calls}=client(f),discussion={id:id(),thread_id:f.threadId,binding_state:'bound'};
  const active=path.join(f.native,'sessions','relocated',path.basename(f.current));fs.mkdirSync(path.dirname(active),{recursive:true});fs.renameSync(f.current,active);
  const db=new DatabaseSync(f.source);db.prepare('UPDATE threads SET rollout_path=?,archived=0,archived_at=NULL WHERE id=?').run(active,f.threadId);db.close();
  assert.equal(await c.bind(f.project,discussion,()=>assert.fail('binding must not change')),f.threadId);
  assert.equal(calls.filter(x=>x.method==='thread/read').length,2);assert.equal(calls.filter(x=>x.method==='thread/resume').length,1);
  assert.equal(calls.some(x=>['thread/start','turn/start'].includes(x.method)),false);assert.equal(discussion.thread_id,f.threadId);
});
test('an explicitly archived native thread is not silently unarchived or replaced',async t=>{
  const f=fixture(t),{c,calls}=client(f),original=c.call;
  c.call=async(method,params)=>{if(method==='thread/resume'){calls.push({method,params});throw new RoomError('session '+f.threadId+' is archived. Run codex unarchive first.',502,'codex_rpc_error');}return original(method,params);};
  await assert.rejects(c.bind(f.project,{id:id(),thread_id:f.threadId,binding_state:'bound'},()=>assert.fail('binding must not change')),e=>e.code==='codex_thread_archived'&&/恢复该会话/.test(e.message));
  assert.equal(calls.some(x=>['thread/start','thread/unarchive','turn/start'].includes(x.method)),false);assert.equal(fs.existsSync(f.current),true);
});
test('read-only work-record inspection never repairs an index or resumes a thread',async t=>{
  const f=fixture(t),{c,calls}=client(f),before=f.query(f.local);
  await assert.rejects(c.inspectBound(f.project,{thread_id:f.threadId}),e=>e.code==='codex_work_record_unavailable');
  assert.deepEqual(f.query(f.local),before);assert.deepEqual(calls.map(x=>x.method),['thread/read']);
});
