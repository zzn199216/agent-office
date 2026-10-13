'use strict';
// Actual official Qwen CLI, isolated account/configuration, local fake model.
// This proves protocol/routing/session behavior, not model account availability
// or control over the consumer Qwen desktop window.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs'),{QwenClient}=require('../src/qwen.cjs');
const {FakeCodex,FakeVault}=require('../tests/helpers.cjs'),{id,sleep,atomicWrite}=require('../src/util.cjs');

const out=path.resolve(__dirname,'../output/validation/qwen-official-runtime.json');
const root=process.argv[2]?path.resolve(process.argv[2]):path.join(os.tmpdir(),`agentroom-qwen-validation-${id()}`);
const data=path.join(root,'.agentroom'),home=path.join(root,'isolated-home'),projectPath=path.join(root,'project');
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(home,{recursive:true});fs.mkdirSync(projectPath,{recursive:true});
fs.writeFileSync(path.join(projectPath,'README.md'),'AgentRoom local dummy-model protocol validation. No real upstream model.\n');
const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','LANG'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
Object.assign(env,{USERPROFILE:home,HOME:home,HOMEDRIVE:path.parse(home).root.replace(/\\$/,''),HOMEPATH:home.slice(path.parse(home).root.length-1),APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),NO_COLOR:'1',CI:'true'});fs.mkdirSync(env.TEMP,{recursive:true});
function probe(executable,args){return new Promise((resolve,reject)=>{let stdout='',stderr='';const child=spawn(executable,args,{env,cwd:projectPath,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(new Error('official metadata probe timed out'));},30000);child.stdout.on('data',part=>stdout+=part);child.stderr.on('data',part=>stderr+=part);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',exitCode=>{clearTimeout(timer);resolve({exitCode,stdout,stderr});});});}
async function until(predicate,seconds=45){const end=Date.now()+seconds*1000;while(Date.now()<end){if(predicate())return;await sleep(100);}throw new Error('local Qwen protocol transition timed out');}
const requests=[];let service,server,model;
const evidence={actual_official_cli:true,fake_model:true,real_upstream_model:false,consumer_desktop_tested:false,no_computer_use:true,global_configuration_unchanged:true,validation_root:root};
async function main(){
  service=new RoomService(data,{codex:new FakeCodex(),vault:new FakeVault(),fetch:async()=>{throw new Error('validation service must not call external hosts');},runtimeInstaller:{env},chat:{clientFactory(member){assert.equal(member.adapter,'qwen-code');return new QwenClient({executable:member.config.executable,args:member.config.executable_args,dataDir:data,homeDir:home,env,mcpEnvironment:{AGENTROOM_MEMBER_ID:member.id,AGENTROOM_CALLER:member.name},developerInstructions:'This validation uses only a local dummy model endpoint, never a real provider.'});}}});
  const previousFile=path.join(data,'runtime-record.json');if(fs.existsSync(previousFile))service.store.setting('runtime.qwen-code',JSON.parse(fs.readFileSync(previousFile,'utf8')));
  console.log(JSON.stringify({stage:'official-download',root}));
  const runtime=await service.runtimeInstaller.install({provider:'qwen-code'});assert.equal(runtime.status,'installed',runtime.detail||runtime.reason);
  atomicWrite(previousFile,JSON.stringify(service.store.setting('runtime.qwen-code'),null,2));
  Object.assign(evidence,{runtime:{version:runtime.version,executable:runtime.executable,executable_args:runtime.executable_args,verified_sha256:runtime.verified_sha256}});
  const version=await probe(runtime.executable,[...runtime.executable_args,'--version']),help=await probe(runtime.executable,[...runtime.executable_args,'--help']);
  assert.equal(version.exitCode,0);assert.equal(version.stdout.trim(),'0.25.1');assert.equal(help.exitCode,0);
  const required=['--safe-mode','--mcp-config','--allowed-mcp-server-names','--allowed-tools','--exclude-tools','--resume','--output-format'];for(const flag of required)assert(help.stdout.includes(flag),`official CLI is missing ${flag}`);
  evidence.official_version_verified=true;evidence.official_help_flags_verified=required;
  console.log(JSON.stringify({stage:'official-metadata-passed',version:runtime.version}));
  model=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4*1024*1024)throw new Error('local model payload exceeds limit');}
    if(req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'agentroom-local-fixture',object:'model'}]}));return;}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const input=JSON.parse(body),messages=input.messages||[],lastUser=[...messages].reverse().find(m=>m.role==='user'),prompt=typeof lastUser?.content==='string'?lastUser.content:JSON.stringify(lastUser?.content||'');
    const toolNames=(input.tools||[]).map(tool=>tool.function?.name||''),handshake=/invite_id=([a-f0-9-]+)[,，]\s*nonce=([A-Za-z0-9_-]+)/i.exec(prompt);
    const lastTool=messages.at(-1)?.role==='tool';requests.push({route:req.url,tool_names:toolNames,has_tool_reply:lastTool,message_count:messages.length});
    let choice;
    if(handshake&&!lastTool){const toolName=toolNames.find(name=>name==='mcp__agentroom__agentroom_join');assert(toolName,'actual CLI must expose bounded MCP join');choice={delta:{role:'assistant',tool_calls:[{index:0,id:'call_local_join_'+id(),type:'function',function:{name:toolName,arguments:JSON.stringify({invite_id:handshake[1],nonce:handshake[2]})}}]},finish_reason:'tool_calls'};}
    else choice={delta:{role:'assistant',content:handshake?'已加入聊天室':/第二次/.test(prompt)?'本机模拟模型回答：第二次':'本机模拟模型回答：第一次'},finish_reason:'stop'};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const envelope={id:'chatcmpl-local-'+id(),object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'agentroom-local-fixture',choices:[{index:0,...choice}]};
    res.end('data: '+JSON.stringify(envelope)+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  Object.assign(env,{OPENAI_API_KEY:'agentroom-local-fixture-only',OPENAI_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`,OPENAI_MODEL:'agentroom-local-fixture'});
  fs.mkdirSync(path.join(home,'.qwen'),{recursive:true});atomicWrite(path.join(home,'.qwen','settings.json'),JSON.stringify({security:{auth:{selectedType:'openai'}},model:{name:'agentroom-local-fixture'}}));
  const token=id();server=createServer(service,{token,port:0});const port=await server.listen();atomicWrite(path.join(data,'control.json'),JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${port}`,token}));
  const project=service.addProject({name:'官方 Qwen CLI 本机模拟验收',path:projectPath,access:'read-only'}),room=service.chat.addRoom({title:'隔离 Qwen 模拟聊天室',project_id:project.id});
  const member=service.chat.addMember({name:'Qwen Code 本机模拟',adapter:'qwen-code',config:{executable:runtime.executable,executable_args:runtime.executable_args}});
  service.chat.join(room.id,member.id);await service.chat.connect(member.id,room.id);await until(()=>!service.chat.active.has(member.id));
  const connected=service.chat.store.member(member.id);assert.equal(connected.status,'ready',connected.error);assert(connected.verified_at,'actual MCP handshake missing');const binding=service.chat.store.binding(room.id,member.id);assert(binding.thread_id);
  evidence.real_mcp_handshake=true;evidence.real_session_id=binding.thread_id;
  for(const number of ['第一次','第二次']){const message=service.chat.post({room_id:room.id,sender_id:'user',to_member_id:member.id,text:'请给出'+number+'回答。',idempotency_key:'local-fixture-'+id()});await until(()=>!['queued','processing'].includes(service.chat.store.message(message.id).status));const answer=service.chat.store.db.prepare('SELECT text FROM chat_messages WHERE reply_to=? ORDER BY seq DESC LIMIT 1').get(message.id);assert.equal(service.chat.store.message(message.id).status,'answered',service.chat.store.message(message.id).error);assert(answer?.text.includes('本机模拟模型回答：'+number));assert.equal(service.chat.store.binding(room.id,member.id).thread_id,binding.thread_id);}
  evidence.local_fake_question_answers=2;evidence.same_real_session_resumed=true;evidence.model_requests=requests;
  const health=await service.chat.nativeClient(service.chat.store.member(member.id)).status();assert.equal(health.version,'0.25.1');assert.equal(health.authVerified,false);evidence.metadata_auth_is_hint_only=true;
  evidence.success=true;fs.mkdirSync(path.dirname(out),{recursive:true});atomicWrite(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
main().catch(error=>{evidence.success=false;evidence.error=error.message;fs.mkdirSync(path.dirname(out),{recursive:true});atomicWrite(out,JSON.stringify(evidence,null,2));console.error(JSON.stringify({error:error.message,evidence:out,root}));process.exitCode=1;}).finally(async()=>{await service?.close();await server?.close();if(model)await new Promise(resolve=>model.close(resolve));});
