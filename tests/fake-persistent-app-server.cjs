'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{randomUUID}=require('node:crypto');
const authHome=process.env.CODEX_HOME,home=process.env.CODEX_SQLITE_HOME||authHome;
for(const folder of [authHome,home])if(!folder||!path.isAbsolute(folder)||!folder.includes('agentroom-test-'))throw Error('A private fixture home is required');
fs.mkdirSync(home,{recursive:true});const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
fs.appendFileSync(path.join(home,'fixture-startups.jsonl'),JSON.stringify({pid:process.pid,auth_home:authHome,sqlite_home:home,args:process.argv.slice(2)})+'\n');
const file=id=>['sessions','archived_sessions'].map(dir=>path.join(home,dir,'rollout-'+id+'.jsonl')).find(value=>fs.existsSync(value));
const read=id=>{const found=file(id);if(!found)throw Error('thread not found');const lines=fs.readFileSync(found,'utf8').trim().split('\n').map(JSON.parse),thread=lines.find(v=>v.type==='fixture_thread').payload;return {...thread,path:found};};
const write=thread=>{const target=path.join(home,'sessions','rollout-'+thread.id+'.jsonl');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify({type:'session_meta',payload:{id:thread.id,cwd:thread.cwd}})+'\n'+JSON.stringify({type:'fixture_thread',payload:thread})+'\n');};
const heldTurns=new Map();
function complete(threadId,text='中文回答',status='completed'){
  const pending=heldTurns.get(threadId);if(!pending)throw Error('fixture held turn not found');heldTurns.delete(threadId);
  const thread=read(threadId),turn=thread.turns.find(value=>value.id===pending.turnId);turn.status=status;
  if(status==='completed'){const item={id:randomUUID(),type:'agentMessage',phase:'final_answer',text};turn.items.push(item);send({method:'item/completed',params:{threadId,turnId:turn.id,item}});}
  write(thread);send({method:'turn/completed',params:{threadId,turn:{id:turn.id,status}}});return {turn:{id:turn.id,status}};
}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)return;
  if(!m.method){fs.appendFileSync(path.join(home,'fixture-responses.jsonl'),JSON.stringify(m)+'\n');return;}
  fs.appendFileSync(path.join(home,'rpc.jsonl'),JSON.stringify({id:m.id,method:m.method,params:p})+'\n');
  try{let result={};if(m.method==='initialize')result={userAgent:'protocol-fixture'};
    if(m.method==='config/read')result={config:{model:'fixture-model',model_provider:'fixture-provider',model_providers:{'fixture-provider':{name:'Fixture',base_url:'http://127.0.0.1:1',env_key:'FIXTURE_KEY',wire_api:'responses',requires_openai_auth:false}},notify:['personal-popup'],hooks:{Stop:[]},mcp_servers:{personal:{command:'never-run'},agentroom:{url:'https://fixture.invalid/mcp',enabled:false,env:{AGENTROOM_MEMBER_ID:'foreign-fixture',AGENTROOM_ROOM_ID:'foreign-room'}}}}};
    if(m.method==='account/read')result={account:{type:'chatgpt'},requiresOpenaiAuth:true};
    if(m.method==='config/read'&&fs.existsSync(path.join(home,'fixture-config.json')))result={config:JSON.parse(fs.readFileSync(path.join(home,'fixture-config.json'),'utf8'))};
    if(m.method==='account/read'&&fs.existsSync(path.join(home,'fixture-account.json')))result=JSON.parse(fs.readFileSync(path.join(home,'fixture-account.json'),'utf8'));
    if(m.method==='mcpServer/tool/call'){const thread=read(p.threadId),member=thread.config?.[`mcp_servers.${p.server}`]?.env?.AGENTROOM_MEMBER_ID||'fixture-member';result={content:[{type:'text',text:'fixture tool response'}],structuredContent:{ok:p.arguments.nonce!=='invalid',room_id:p.arguments.invite_id,member:{id:member}}};}
    if(m.method==='thread/start'){const thread={id:randomUUID(),cwd:p.cwd,name:null,status:{type:'idle'},turns:[],config:p.config||{}};write(thread);result={thread:read(thread.id)};}
    if(m.method==='thread/name/set'){const thread=read(p.threadId);thread.name=p.name;write(thread);}
    if(m.method==='thread/read')result={thread:read(p.threadId)};
    if(m.method==='thread/list')result={data:[],nextCursor:null};
    if(m.method==='thread/resume'){if(p.path){const data=fs.readFileSync(p.path,'utf8').trim().split('\n').map(JSON.parse),thread=data.find(v=>v.type==='fixture_thread').payload;if(fs.existsSync(path.join(home,'corrupt-resume'))&&thread.turns.length)thread.turns[0].items=[];write(thread);}const thread=read(p.threadId);if(p.config){thread.config=p.config;write(thread);}result={thread:read(p.threadId)};}
    if(m.method==='thread/archive'){const source=file(p.threadId),target=path.join(home,'archived_sessions',path.basename(source));fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(source,target);}
    if(m.method==='turn/start'){const thread=read(p.threadId),turnId=randomUUID(),hold=JSON.stringify(p.input).includes('POOL_HOLD_FIXTURE');thread.turns.push({id:turnId,status:'inProgress',items:[{id:randomUUID(),type:'userMessage',content:p.input}]});write(thread);heldTurns.set(p.threadId,{turnId});send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turnId}}});if(!hold)complete(p.threadId);result={turn:{id:turnId}};}
    if(m.method==='turn/interrupt'){if(heldTurns.has(p.threadId))complete(p.threadId,'','interrupted');}
    if(m.method==='fixture/emit')send(p.message);
    if(m.method==='fixture/complete')result=complete(p.threadId,p.text);
    send({id:m.id,result});
  }catch(error){send({id:m.id,error:{code:-32004,message:error.message}});}
});
