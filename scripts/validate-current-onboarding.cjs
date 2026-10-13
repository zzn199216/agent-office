'use strict';
// Reuse already verified, already grouped members. No discovery, installers,
// model handshake, external messages or native window actions are performed.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {apiCall}=require('../src/main.cjs');const {dataDirectory,VERSION}=require('../src/util.cjs');
async function main(){
  const dir=dataDirectory(),db=new DatabaseSync(path.join(dir,'room.sqlite'),{readOnly:true}),api=(route,input)=>apiCall(dir,route,input);
  try{
    const state=await api('/api/state');assert.equal(state.version,VERSION);
    const proxies=db.prepare("SELECT * FROM launch_proxies WHERE native_group_status='host_reported' ORDER BY created").all();assert.equal(proxies.length,3);
    const invariant=()=>crypto.createHash('sha256').update(JSON.stringify({proxies:db.prepare('SELECT * FROM launch_proxies ORDER BY id').all(),members:db.prepare('SELECT * FROM chat_members ORDER BY id').all(),credentials:db.prepare('SELECT * FROM chat_resume_credentials ORDER BY id').all(),invites:db.prepare('SELECT * FROM chat_invitations ORDER BY id').all(),bindings:db.prepare('SELECT * FROM chat_bindings ORDER BY room_id,member_id').all()})).digest('hex');
    const before=invariant(),checks=[];
    for(const proxy of proxies){
      const job=await api('/api/onboarding/start',{room_id:proxy.room_id,provider:proxy.provider,install_client:false,install_runtime:false});
      assert.equal(job.reused,true);assert.equal(job.status,'ready');assert.equal(job.native_group_status,'host_reported');assert.equal(job.local_verified,true);
      assert.equal(job.can_wake,proxy.provider==='codex');assert.equal(job.next_actions.length,0);
      const repeated=await api('/api/onboarding/start',{room_id:proxy.room_id,provider:proxy.provider,install_client:true,install_runtime:true});assert.equal(repeated.id,job.id);assert.equal(repeated.reused,true);
      for(let i=0;i<2;i++){const read=await api('/api/onboarding/jobs/'+job.id);assert.equal(read.status,'ready');}
      checks.push({provider:job.provider,status:job.status,stage:job.stage,can_wake:job.can_wake,reused:true,native_group_status:job.native_group_status});
    }
    assert.equal(invariant(),before,'reuse changed existing identities, credentials, native references or invitations');
    const final=await api('/api/state');assert.equal(final.chat.members.length,state.chat.members.length);assert.deepEqual(final.activeSetup,{onboarding:0,runtime_installs:0,launch:0});
    const app=await (await fetch('http://127.0.0.1:47831/app.js')).text();assert.equal(app,fs.readFileSync(path.resolve(__dirname,'../web/app.js'),'utf8'));
    const evidence={version:final.version,instance_id:final.instance_id,url:'http://127.0.0.1:47831/',rooms:final.chat.rooms.length,members:final.chat.members.length,existing_state_unchanged:true,embedded_ui_matches_source:true,automatic_scanning:false,model_handshakes_replayed:0,installers_called:0,computer_use:false,checks};
    fs.writeFileSync(path.resolve(__dirname,'../output/validation/onboarding-current.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  }finally{db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
