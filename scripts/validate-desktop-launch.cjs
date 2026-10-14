'use strict';
// The shipped launcher, not a direct invocation of the desktop host. Keep a
// real old MCP executable running in an owned fixture to reproduce install_busy.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),version=require('../package.json').version;
const {sleep}=require('../src/util.cjs');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(file,args){return new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned launcher timed out'));},30000);child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error(err||out||'Launcher exited '+code));});});}
async function main(){
  if(process.platform!=='win32')throw Error('Windows launcher acceptance requires Windows.');
  const flag=process.argv.indexOf('--previous'),previous=path.resolve(flag>=0?process.argv[flag+1]:path.join(ROOT,'release/AgentOffice-0.14.1-windows-x64/AgentOffice.exe'));
  const current=path.join(ROOT,'release',`AgentOffice-${version}-windows-x64/AgentOffice.exe`),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-launch-test-')),data=path.join(fixture,'data'),bin=path.join(data,'bin'),out=path.join(ROOT,'output/validation','desktop-launch-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(bin,{recursive:true});fs.mkdirSync(out,{recursive:true});const target=path.join(bin,'AgentRoom.exe');fs.copyFileSync(previous,target);fs.writeFileSync(path.join(bin,'installed.json'),JSON.stringify({app:'AgentRoom',sha256:hash(target)}));
  const runningPrevious=process.argv.includes('--running-previous'),proof={version,fixture,ok:false,checks:{},started_at:new Date().toISOString()};let holding,previousDaemon;
  try{
    const {RoomService}=require('../src/service.cjs'),{FakeCodex,FakeVault}=require('../tests/helpers.cjs');const projectDir=path.join(fixture,'project');fs.mkdirSync(projectDir);
    const seed=new RoomService(data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw Error('Launcher fixture cannot use external services');}}),project=seed.addProject({name:'旧客户端占用升级验收',path:projectDir}),room=seed.chat.addRoom({project_id:project.id,title:'保存的办公室'}),member=seed.chat.addMember({name:'旧 MCP 客户端',adapter:'mailbox'});seed.chat.join(room.id,member.id);const entry=seed.entry.issue(member.id,room.id);await seed.close();
    const oldHash=hash(target),currentHash=hash(current);assert.notEqual(oldHash,currentHash,'Previous and current fixture executables must differ');
    if(runningPrevious){previousDaemon=spawn(target,['serve','--data-dir',data,'--port','0'],{windowsHide:true,stdio:['ignore','ignore','ignore']});const until=Date.now()+15000;while(!require('../src/main.cjs').readControl(data)&&Date.now()<until)await sleep(200);assert.ok(require('../src/main.cjs').readControl(data),'Previous service did not start');proof.checks.previous_service_started=true;}
    holding=spawn(target,runningPrevious?['mcp','--entry',entry.file]:['mcp','--setup','--data-dir',data],{windowsHide:true,stdio:['pipe','pipe','pipe']});holding.stderr.resume();
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Previous MCP fixture did not initialize')),10000);holding.once('error',reject);holding.stdout.on('data',d=>{if(d.toString().includes('"id":1')){clearTimeout(timer);resolve();}});holding.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'owned-launch-validation',version:'1'}}})+'\n');});
    for(const pass of ['first','repeat']){
      const diagnostics=path.join(out,pass);fs.mkdirSync(diagnostics);
      // Omit a positional command, matching the double-click default.
      await run(current,['--data-dir',data,'--diagnostics',diagnostics,'--check']);
      const receipt=path.join(diagnostics,'result.json'),end=Date.now()+30000;while(!fs.existsSync(receipt)&&Date.now()<end)await sleep(250);
      assert.ok(fs.existsSync(receipt),'Desktop host did not report a visible window');const native=JSON.parse(fs.readFileSync(receipt,'utf8'));assert.equal(native.ok,true,native.error);
      assert.equal(hash(target),oldHash);assert.equal(holding.exitCode,null,'The old client must continue running');proof.checks[pass+'_default_launcher_window']=true;
    }
    const updated=path.join(bin,'versions',currentHash,'AgentRoom.exe');assert.equal(hash(updated),currentHash);require('../src/desktop-launch.cjs').desktopManifest(path.join(path.dirname(updated),'desktop'));
    const offline=JSON.parse(await run(updated,['desktop-state','--data-dir',data]));assert.ok(offline.snapshot.chat.rooms.some(r=>r.id===room.id));assert.equal(offline.running,runningPrevious);
    if(runningPrevious){assert.equal(offline.snapshot.version,version);assert.equal(offline.update_available,false);assert.notEqual(require('../src/main.cjs').readControl(data).pid,previousDaemon.pid);proof.checks.older_service_replaced_by_current_version=true;proof.checks.saved_instance_preserved=offline.snapshot.instance_id===seed.runtime.instanceId;}else proof.checks.no_service_or_model_started=true;
    if(runningPrevious){
      const answer=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error('Legacy MCP inbox timed out')),15000);const receive=chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))!==-1){const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(message.id===2){clearTimeout(timer);holding.stdout.off('data',receive);resolve(message);}}};holding.stdout.on('data',receive);holding.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentroom_chat_inbox',arguments:{}}})+'\n');});
      assert.equal(answer.result?.isError,undefined,JSON.stringify(answer));assert.equal(Array.isArray(answer.result.structuredContent),false);assert.deepEqual(answer.result.structuredContent.items,[]);proof.checks.actual_old_binary_inbox_works_without_client_restart=true;
    }
    proof.checks.old_binary_preserved=true;proof.checks.old_mcp_not_stopped=true;proof.checks.versioned_host_complete=true;proof.checks.same_saved_room=true;proof.ok=true;
  }catch(e){proof.error=e.stack;process.exitCode=1;}
  finally{if(runningPrevious&&require('../src/main.cjs').readControl(data))await require('../src/main.cjs').apiCall(data,'/api/shutdown',{idle_only:true}).catch(()=>{});if(previousDaemon&&previousDaemon.exitCode===null)previousDaemon.kill();if(holding){holding.stdin.end();if(holding.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>holding.kill(),5000);holding.once('exit',()=>{clearTimeout(timer);resolve();});});}proof.ended_at=new Date().toISOString();fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({...proof,receipt:path.join(out,'validation.json')}));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
