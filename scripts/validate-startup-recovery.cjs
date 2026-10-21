'use strict';
// Packaged startup regression in an owned temporary instance. No personal
// client, model, production database, or production process is changed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {RoomService}=require('../src/service.cjs'),{FakeCodex,FakeVault}=require('../tests/helpers.cjs');
const {apiCall,readControl}=require('../src/main.cjs'),{sleep,VERSION}=require('../src/util.cjs');
function run(executable,args){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned startup validation command exceeded 35 seconds'));},35000);child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>error+=part);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(error||'Owned command failed'));try{resolve(JSON.parse(output));}catch(e){reject(e);}});});}
async function main(){
  const executable=path.resolve(process.argv[2]),root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-startup-')),data=path.join(root,'data'),projectPath=path.join(root,'project');fs.mkdirSync(projectPath);
  const service=new RoomService(data,{codex:new FakeCodex(),vault:new FakeVault()}),project=service.addProject({name:'Startup fixture',path:projectPath}),keep=service.chat.addRoom({project_id:project.id,title:'Keep original'}),remove=service.chat.addRoom({project_id:project.id,title:'Disposable'}),member=service.chat.addMember({name:'Existing mailbox',adapter:'mailbox'});service.chat.join(keep.id,member.id);
  const {card}=service.resume.issue(member.id,keep.id),instance=service.runtime.instanceId;
  const port=await new Promise((resolve,reject)=>{const listener=require('node:net').createServer();listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>{const port=listener.address().port;listener.close(()=>resolve(port));});});
  service.store.setting('local_http_port',port);service.store.setting('codex_path',path.join(root,'no-provider-executable.exe'));await service.close();
  let unrelated,owned;
  try{
    unrelated=spawn(process.execPath,['-e','process.stdin.resume();'],{windowsHide:true,stdio:['pipe','ignore','ignore']});await new Promise((resolve,reject)=>{unrelated.once('spawn',resolve);unrelated.once('error',reject);});
    fs.writeFileSync(path.join(data,'daemon.lock'),JSON.stringify({pid:unrelated.pid}));fs.writeFileSync(path.join(data,'control.json'),JSON.stringify({pid:unrelated.pid,url:'http://127.0.0.1:'+port,token:'old-controller',instance_id:instance,version:'0.15.0-preview.9'}));for(const name of ['daemon.lock','control.json'])fs.utimesSync(path.join(data,name),new Date(0),new Date(0));
    const started=Date.now(),state=await run(executable,['desktop-start','--data-dir',data]);const duration=Date.now()-started;owned=readControl(data);assert.equal(state.running,true);assert.equal(state.snapshot.version,VERSION);assert.equal(state.snapshot.instance_id,instance);assert.ok(owned.owner_id);assert.notEqual(owned.pid,unrelated.pid);assert.equal(unrelated.exitCode,null);process.kill(unrelated.pid,0);assert.ok(duration<30000);
    const pid=owned.pid,origin=owned.url,again=await run(executable,['desktop-start','--data-dir',data]);assert.equal(again.running,true);assert.equal(readControl(data).pid,pid);
    const deleted=await fetch(origin+'/api/chat/rooms/'+remove.id,{method:'DELETE',headers:{Authorization:'Bearer '+owned.token},signal:AbortSignal.timeout(5000)});assert.equal(deleted.status,200);assert.equal((await deleted.json()).status,'deleted');const saved=await apiCall(data,'/api/state');assert.ok(saved.chat.rooms.some(room=>room.id===keep.id));assert.ok(saved.chat.members.some(value=>value.id===member.id));
    const url=origin+'/mcp/'+card.credential_id+'/'+card.secret,rpc=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'startup-fixture',version:'1'}}}),signal:AbortSignal.timeout(5000)});assert.equal(rpc.status,200);await rpc.json();
    const stopped=await run(executable,['desktop-stop','--data-dir',data]);assert.equal(stopped.running,false);owned=null;
    const restarted=await run(executable,['desktop-start','--data-dir',data]);owned=readControl(data);assert.equal(restarted.running,true);assert.equal(owned.url,origin);assert.equal(owned.instance_id,instance);assert.equal(unrelated.exitCode,null);
    const proof={version:VERSION,ok:true,packaged_backend:true,startup_ms:duration,stale_pid_recovered:true,unrelated_process_preserved:true,repeated_start_same_daemon:true,room_deletion_restored:true,other_room_and_member_preserved:true,original_mcp_credential_accepted:true,restart_same_address:true,restart_same_instance:true,user_data_changed:false,user_windows_changed:false,model_calls:0};
    const output=path.resolve(__dirname,'../output/validation/startup-recovery-'+VERSION+'.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
  }finally{
    const current=readControl(data);if(current?.owner_id&&current.instance_id===instance)await apiCall(data,'/api/shutdown',{idle_only:true}).catch(()=>{});
    if(unrelated?.exitCode===null){const ended=new Promise(resolve=>unrelated.once('exit',resolve));unrelated.stdin.end();await Promise.race([ended,sleep(2000)]);if(unrelated.exitCode===null)unrelated.kill();}
    for(let i=0;i<40&&readControl(data);i++)await sleep(100);
    if(readControl(data))throw Error('Owned test service is still cleaning up; fixture retained for inspection');
    const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^agentoffice-startup-/);fs.rmSync(target,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(String(error.message).replace(/https?:\/\/\S+/g,'[address]').slice(0,500));process.exitCode=1;});
