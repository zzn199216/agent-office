'use strict';
// Real previous-package -> current-package migration in an owned temporary
// instance. Neither personal client configuration nor user windows are used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {fixture}=require('../tests/helpers.cjs'),{installBinary,activeRuntime}=require('../src/install.cjs');
const {createQwenMcpConfig}=require('../src/mcp-http.cjs'),{sleep,VERSION,id,now}=require('../src/util.cjs');
async function validateUpgrade(executable,previous,setStage=()=>{}){
  const f=fixture();let child,stdio,control,recoveredPid=null,raw='',sequence=0,stdioError=false;
  const stage=value=>setStage('upgrade-'+value);
  async function waitFor(predicate,label){for(let i=0;i<100;i++){if(predicate())return;await sleep(100);}throw Error(label+' timed out');}
  async function start(runtime,first=false){
    child=spawn(runtime,['serve','--data-dir',f.data,...first?['--port','0']:[]],{windowsHide:true,stdio:'ignore'});
    const started=child;let failed=false;started.once('error',()=>{failed=true;});
    await waitFor(()=>{if(failed||started.exitCode!==null)throw Error('Owned backend exited');try{const c=JSON.parse(fs.readFileSync(path.join(f.data,'control.json'),'utf8'));if(c.pid===started.pid){control=c;return true;}}catch{}return false;},'Owned backend');
  }
  async function api(route,input,method=input===undefined?'GET':'POST'){
    const r=await fetch(control.url+route,{method,headers:{Authorization:'Bearer '+control.token,'Content-Type':'application/json',Connection:'close'},...input===undefined?{}:{body:JSON.stringify(input)},redirect:'error',signal:AbortSignal.timeout(5000)});
    assert.ok(r.ok,'Owned controller returned '+r.status);return r.json();
  }
  async function stop(){await api('/api/shutdown',{idle_only:true});await waitFor(()=>child.exitCode!==null,'Owned backend stop');child=null;}
  async function closeOwned(p){
    if(!p||p.exitCode!==null)return;
    p.stdin?.end();for(let i=0;i<20&&p.exitCode===null;i++)await sleep(50);
    if(p.exitCode===null)p.kill();await waitFor(()=>p.exitCode!==null,'Owned process stop');
  }
  async function stdioCall(method,params){
    const requestId=++sequence;stdio.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');let value;
    await waitFor(()=>{value=raw.trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.id===requestId);if(!value&&(stdioError||stdio.exitCode!==null))throw Error('Imported stdio process exited');return !!value;},'Imported stdio MCP');
    assert.equal(value.error,undefined,'Imported stdio protocol failed');assert.equal(value.result?.isError,undefined,'Imported stdio tool failed');return value.result;
  }
  try{
    stage('seed-old-schema');fs.mkdirSync(f.data,{recursive:true});const seed=new DatabaseSync(path.join(f.data,'room.sqlite'));
    seed.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');seed.prepare('INSERT INTO settings VALUES(?,?)').run('codex_path',JSON.stringify(path.join(f.root,'no-model-runtime.exe')));seed.close();
    const oldInstalled=installBinary(previous,f.data);await start(oldInstalled,true);const previousVersion=control.version,origin=control.url,instance=control.instance_id;
    assert.notEqual(previousVersion,VERSION,'Upgrade fixture must use a different previous package');
    const project=await api('/api/projects',{name:'Cross-version fixture',path:f.project}),room=await api('/api/chat/rooms',{title:'Old package room',project_id:project.id});
    const member=await api('/api/chat/members',{name:'Persistent old MCP fixture',adapter:'mailbox'});await api('/api/chat/rooms/'+room.id+'/join',{member_id:member.id});
    const entry=await api('/api/resume/issue',{member_id:member.id,room_id:room.id}),bytes=fs.readFileSync(entry.file),card=JSON.parse(bytes);
    const revoked=await api('/api/chat/members',{name:'User revoked fixture',adapter:'mailbox'});await api('/api/chat/rooms/'+room.id+'/join',{member_id:revoked.id});
    const revokedEntry=await api('/api/resume/issue',{member_id:revoked.id,room_id:room.id}),revokedCard=JSON.parse(fs.readFileSync(revokedEntry.file));await api('/api/resume/revoke',{member_id:revoked.id,room_id:room.id});
    const native=await api('/api/chat/members',{name:'Dormant native person fixture',adapter:'mailbox',config:{launch_provider:'qwen-desktop'}}),nativeSession=id();
    const url=createQwenMcpConfig(origin,card).mcpServers.agentroom.url;
    const profile=path.join(f.root,'private-client-profile.json'),profileBytes=JSON.stringify({custom:{preserve:true},mcpServers:{agentroom:{url,type:'streamable-http'},other:{command:'keep-other-server',args:['unchanged']}}});fs.writeFileSync(profile,profileBytes);
    async function rpc(message,session,expected=message.id===undefined?202:200,endpoint=url){
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Connection:'close',...session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-06-18'}:{}},body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(5000)});
      assert.equal(r.status,expected,'Old MCP URL operation failed');return {response:r,value:r.status===202?null:await r.json()};
    }
    stage('old-clients-initialize');stdio=spawn(oldInstalled,['mcp','--entry',entry.file],{windowsHide:true,stdio:['pipe','pipe','pipe']});stdio.once('error',()=>{stdioError=true;});stdio.stdout.on('data',part=>{raw+=part;});stdio.stderr.resume();
    await stdioCall('initialize',{protocolVersion:'2025-06-18'});stdio.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');await stdioCall('tools/call',{name:'agentroom_chat_rooms',arguments:{}});
    const init=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'upgrade-protocol-fixture',version:'1'}}}),session=init.response.headers.get('mcp-session-id');await rpc({jsonrpc:'2.0',method:'notifications/initialized'},session);
    const history=await api('/api/chat/messages',{room_id:room.id,text:'Historical user data survives upgrade',idempotency_key:'old-package-history'});
    stage('switch-build-folder');await stop();
    const db=new DatabaseSync(path.join(f.data,'room.sqlite'));try{db.prepare('INSERT INTO desktop_person_sessions VALUES(?,?,?,?,?,?,?,?)').run(native.id,'qwen-desktop','http://127.0.0.1:1','fixture-runtime',nativeSession,'offline',null,now());}finally{db.close();}
    const updated=installBinary(executable,f.data);assert.equal(activeRuntime(f.data),updated);assert.equal(updated,oldInstalled,'The imported stable command must launch the current package even while its old stdio image remains running');
    await start(updated);assert.equal(control.version,VERSION);assert.equal(control.instance_id,instance);assert.equal(control.url,origin);
    stage('old-clients-after-upgrade');const rooms=await rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentroom_chat_rooms',arguments:{}}},session);assert.equal(rooms.value.result.structuredContent.rooms[0].id,room.id);
    assert.ok((await api('/api/chat/rooms/'+room.id)).messages.some(message=>message.id===history.id));
    await api('/api/chat/rooms/'+room.id,{},'DELETE');const fresh=await api('/api/chat/rooms',{title:'Upgraded room',project_id:project.id});await api('/api/chat/rooms/'+fresh.id+'/join',{member_id:member.id});
    const message=await api('/api/chat/messages',{room_id:fresh.id,to_member_id:member.id,text:'Old MCP receives the new package message',idempotency_key:'upgraded-inbox'});
    const inbox=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'agentroom_chat_inbox',arguments:{}}},session);assert.equal(inbox.value.result.isError,undefined);assert.deepEqual(inbox.value.result.structuredContent.items.map(item=>item.id),[message.id]);
    const oldStdio=await stdioCall('tools/call',{name:'agentroom_chat_inbox',arguments:{}});assert.deepEqual(oldStdio.structuredContent.items.map(item=>item.id),[message.id]);
    stage('preserved-identities');await rpc({jsonrpc:'2.0',id:4,method:'initialize',params:{protocolVersion:'2025-06-18'}},null,410,createQwenMcpConfig(origin,revokedCard).mcpServers.agentroom.url);
    const inspect=new DatabaseSync(path.join(f.data,'room.sqlite'),{readOnly:true});try{assert.equal(inspect.prepare('SELECT native_session_id FROM desktop_person_sessions WHERE member_id=?').get(native.id).native_session_id,nativeSession);assert.equal(inspect.prepare('SELECT revocation_reason FROM chat_resume_credentials WHERE id=?').get(revokedCard.credential_id).revocation_reason,'explicit');assert.equal(inspect.prepare('SELECT count(*) AS n FROM chat_resume_credentials WHERE member_id=?').get(member.id).n,1);}finally{inspect.close();}
    assert.deepEqual(fs.readFileSync(entry.file),bytes);assert.equal(fs.readFileSync(profile,'utf8'),profileBytes);await stop();
    stage('old-stdio-cold-recovery');
    const coldInbox=await stdioCall('tools/call',{name:'agentroom_chat_inbox',arguments:{}});assert.deepEqual(coldInbox.structuredContent.items.map(item=>item.id),[message.id]);
    control=JSON.parse(fs.readFileSync(path.join(f.data,'control.json'),'utf8'));recoveredPid=control.pid;
    assert.equal(control.version,VERSION,'The same old stdio process must cold-start the current backend after the upgraded AO stops');assert.equal(control.instance_id,instance);assert.equal(control.url,origin);
    await api('/api/shutdown',{idle_only:true});await waitFor(()=>{try{process.kill(recoveredPid,0);return false;}catch{return true;}},'Cold-recovered backend stop');recoveredPid=null;
    return {previous_version:previousVersion,cross_version_upgrade:true,previous_schema_seeded_by_package:true,same_stdio_process:true,locked_binary_upgrade:true,stable_command_promoted:true,old_stdio_cold_starts_current_backend:true,native_binding_preserved:true,unrelated_mcp_config_preserved:true,explicit_revocation_preserved:true,historical_data_preserved:true};
  }finally{
    await closeOwned(stdio);await closeOwned(child);if(recoveredPid){try{process.kill(recoveredPid);}catch{}await waitFor(()=>{try{process.kill(recoveredPid,0);return false;}catch{return true;}},'Owned recovered backend cleanup');}
    const target=path.resolve(f.root);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('agentroom-test-'))throw Error('Unsafe upgrade fixture cleanup path');fs.rmSync(target,{recursive:true,force:true});
  }
}
module.exports={validateUpgrade};
