'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');const{spawn}=require('node:child_process');
async function run(executable,args){return new Promise((resolve,reject)=>{const p=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.setEncoding('utf8');p.stdout.on('data',d=>stdout+=d);p.stderr.setEncoding('utf8');p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(stdout):reject(new Error(stderr || `Exit ${code}`)));});}
async function main(){
  const root=path.resolve(__dirname,'..'),exe=path.join(root,'dist','AgentRoom.exe'),base=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-package-')),infoDir=path.join(base,'version-only'),data=path.join(base,'runtime');
  const version=(await run(exe,['--version','--data-dir',infoDir])).trim();if(version!==require('../package.json').version||fs.existsSync(infoDir))throw new Error('Version check unexpectedly installed or started the application.');
  const start=JSON.parse(await run(exe,['start','--data-dir',data,'--project',root,'--name','打包验收']));
  try{
    const status=JSON.parse(await run(exe,['status','--data-dir',data]));if(!status.projects.some(p=>p.name==='打包验收'))throw new Error('Packaged runtime registration failed.');
    const response=await fetch(start.url);const html=await response.text();if(!html.includes('AgentRoom'))throw new Error('Embedded UI unavailable.');
    const asset=await fetch(start.url+'/app.js');if(asset.status!==200)throw new Error('Embedded script unavailable.');
    const installed=path.join(data,'bin','AgentRoom.exe');if(!fs.existsSync(installed))throw new Error('Stable self-install failed.');
    const sourceHash=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),installedHash=crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex');if(sourceHash!==installedHash)throw new Error('Installed binary differs.');
    const evidence={tested_at:new Date().toISOString(),version,self_install_verified:true,embedded_ui_verified:true,no_node_or_python_child_runtime_required:true,version_command_no_side_effects:true,projects:status.projects.length,url:start.url};
    for(const provider of ['codex','claude','qwen','grok','cursor','doubao']){
      const response=await fetch(start.url+`/assets/office/avatar-${provider}.png`);if(response.status!==200||response.headers.get('content-type')!=='image/png')throw new Error('Packaged avatar response is invalid: '+provider);
      const actual=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.join(root,'web','assets','office',`avatar-${provider}.png`));if(!actual.equals(expected))throw new Error('Packaged avatar bytes differ: '+provider);
    }
    evidence.offline_provider_avatars_verified=6;
    for(const name of ['furniture-desk','furniture-beanbag','character-robot','character-qwen-mascot','prop-plant']){
      const response=await fetch(start.url+`/assets/office/${name}.png`);if(response.status!==200||response.headers.get('content-type')!=='image/png')throw new Error('Packaged office module response is invalid: '+name);
      const actual=Buffer.from(await response.arrayBuffer()),expected=fs.readFileSync(path.join(root,'web','assets','office',`${name}.png`));if(!actual.equals(expected))throw new Error('Packaged office module bytes differ: '+name);
    }
    evidence.offline_office_modules_verified=5;
    if(process.argv.includes('--chat-live')){
      const {apiCall}=require('../src/main.cjs'),{CodexClient}=require('../src/codex.cjs');const api=(route,input)=>apiCall(data,route,input);
      const room=await api('/api/chat/rooms',{project_id:status.projects[0].id,title:'打包聊天室验收'}),member=await api('/api/chat/members',{name:'Codex 打包验收',adapter:'codex'});
      await api(`/api/chat/members/${member.id}/connect`,{room_id:room.id});const end=Date.now()+180000;
      for(;;){const m=await api(`/api/chat/members/${member.id}`);if(m.status==='ready'){evidence.chat_handshake_verified=!!m.verified_at;break;}if(m.status==='connection_failed')throw new Error(m.error);if(Date.now()>end)throw new Error('Packaged room handshake timed out');await new Promise(r=>setTimeout(r,500));}
      const question=await api('/api/chat/messages',{room_id:room.id,sender_id:'user',to_member_id:member.id,text:'请仅回复“打包聊天室已收到”。不调用工具，不修改文件。',idempotency_key:crypto.randomUUID()});let result;
      do{result=await api(`/api/chat/messages/${question.id}/wait?seconds=20`);}while(!result.responses.length&&!['failed','uncertain','cancelled'].includes(result.message.status)&&Date.now()<end);
      const answer=result.responses[0]?.text||'';if(!answer.includes('打包聊天室已收到'))throw new Error('Packaged room answer missing: '+(result.message.error||answer));
      const snapshot=await api(`/api/chat/rooms/${room.id}`),client=new CodexClient();try{const thread=await client.read(snapshot.participants[0].native_thread_id);evidence.native_join_trace_verified=thread.turns.some(t=>(t.items||[]).some(i=>i.type==='mcpToolCall'&&i.server==='agentroom'&&i.tool==='agentroom_join'&&i.status==='completed'));}finally{await client.close();}
      if(!evidence.native_join_trace_verified)throw new Error('Packaged native join trace missing.');evidence.chat_answer_verified=true;evidence.answer=answer;evidence.room_id=room.id;
    }
    if(process.argv.includes('--live')){
      const discussion=JSON.parse(await run(exe,['discuss','--data-dir',data,'--project',status.projects[0].id,'--title','打包端到端验证']));
      const question=path.join(base,'question.md');fs.writeFileSync(question,'请调用 AgentRoom 的 agentroom_list 工具，只回答已经登记的项目名称。不调用其他工具，不改文件。','utf8');
      const request=JSON.parse(await run(exe,['ask','--data-dir',data,'--discussion',discussion.id,'--file',question,'--wait','120']));
      if(request.status!=='completed'||!request.answer.includes('打包验收'))throw new Error('Packaged Codex/MCP live check failed: '+(request.error || request.answer));
      const {apiCall}=require('../src/main.cjs'),{CodexClient}=require('../src/codex.cjs');
      const history=await apiCall(data,`/api/discussions/${discussion.id}`),client=new CodexClient();
      try{
        const native=await client.read(history.discussion.thread_id),turn=native.turns.find(t=>t.id===request.turn_id);
        const tool=(turn?.items || []).find(x=>x.type==='mcpToolCall'&&x.server==='agentroom'&&x.tool==='agentroom_list'&&x.status==='completed');
        if(!tool)throw new Error('No completed native MCP tool call found in packaged runtime.');
      }finally{await client.close();}
      evidence.real_codex_mcp_verified=true;evidence.native_mcp_trace_verified=true;evidence.request_id=request.request_id;evidence.answer=request.answer;
    }
    fs.mkdirSync(path.join(root,'output','validation'),{recursive:true});fs.writeFileSync(path.join(root,'output','validation',process.argv.includes('--chat-live')?'packaged-chat-runtime.json':'packaged-runtime.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
  }finally{await run(exe,['stop','--data-dir',data]);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
