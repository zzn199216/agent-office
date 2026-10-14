'use strict';
// Opt-in native acceptance: one owned private home, real MCP handshake and a
// resumed reply. Never touches a user's room or emits configuration/secrets.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {serve,apiCall}=require('../src/main.cjs'),{id,sleep}=require('../src/util.cjs');
const digest=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
(async()=>{
  const parent=path.join(os.homedir(),'.agentoffice-validation');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'codex-http-')),data=path.join(root,'data'),projectPath=path.join(root,'project');fs.mkdirSync(projectPath);
  const personal=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),files=['config.toml','auth.json'].map(name=>path.join(personal,name)),before=files.map(digest);
  const start=Date.now(),host=await serve(data,{port:0}),api=(route,input)=>apiCall(data,route,input);let receipt;
  try{
    const project=await api('/api/projects',{name:'Native HTTP acceptance',path:projectPath}),room=await api('/api/chat/rooms',{project_id:project.id,title:'Owned HTTP fixture'}),member=await api('/api/chat/members',{name:'Native Codex fixture',adapter:'codex'});
    await api('/api/chat/members/'+member.id+'/connect',{room_id:room.id});let state;const deadline=Date.now()+90000;
    do{await sleep(300);state=await api('/api/chat/members/'+member.id);}while(state.status==='connecting'&&Date.now()<deadline);
    assert.equal(state.status,'ready',state.error);assert.ok(state.verified_at);const handshakeMs=Date.now()-start;
    const history=await api('/api/chat/rooms/'+room.id),thread=history.participants.find(value=>value.id===member.id).native_thread_id;
    const client=host.service.chat.clients.get(member.id);assert.equal((await client.read(thread)).turns.length,0,'Handshake must not start a model turn');
    const reconnectStart=Date.now();await api('/api/chat/members/'+member.id+'/connect',{room_id:room.id});
    do{await sleep(50);state=await api('/api/chat/members/'+member.id);}while(state.status==='connecting'&&Date.now()<deadline);
    assert.equal(state.status,'ready');const reconnectMs=Date.now()-reconnectStart;assert.equal((await client.read(thread)).turns.length,0);
    const message=await api('/api/chat/messages',{room_id:room.id,to_member_id:member.id,text:'Reply only HTTP_TRANSPORT_OK. Do not call tools or read files.',idempotency_key:id()});let reply;
    do{reply=await api('/api/chat/messages/'+message.id+'/wait?seconds=10');}while(!reply.responses.length&&Date.now()<deadline);
    assert.equal(reply.responses.at(-1)?.text,'HTTP_TRANSPORT_OK');
    assert.equal((await api('/api/chat/rooms/'+room.id)).participants.find(value=>value.id===member.id).native_thread_id,thread);
    receipt={root,handshake_ms:handshakeMs,reconnect_ms:reconnectMs,handshake_model_turns:0,verified:true,resumed_reply:true,thread_id:thread,personal_config_unchanged:files.map(digest).every((value,i)=>value===before[i])};assert.ok(receipt.personal_config_unchanged);
  }finally{await host.stop();}
  const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(data,'codex','logs_2.sqlite'),{readOnly:true});
  try{const count=db.prepare("SELECT count(*) n FROM logs WHERE thread_id=? AND (feedback_log_body LIKE '%falling back to HTTP%' OR feedback_log_body LIKE '%websocket error%')").get(receipt.thread_id).n;assert.equal(count,0);receipt.websocket_retries=0;}finally{db.close();}
  const output=path.resolve('output/validation/codex-http');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
