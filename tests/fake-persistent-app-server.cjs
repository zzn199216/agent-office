'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{randomUUID}=require('node:crypto');
const home=process.env.CODEX_HOME;if(!home||!path.isAbsolute(home)||!home.includes('agentroom-test-'))throw Error('A private fixture home is required');
fs.mkdirSync(home,{recursive:true});const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const file=id=>['sessions','archived_sessions'].map(dir=>path.join(home,dir,'rollout-'+id+'.jsonl')).find(value=>fs.existsSync(value));
const read=id=>{const found=file(id);if(!found)throw Error('thread not found');const lines=fs.readFileSync(found,'utf8').trim().split('\n').map(JSON.parse),thread=lines.find(v=>v.type==='fixture_thread').payload;return {...thread,path:found};};
const write=thread=>{const target=path.join(home,'sessions','rollout-'+thread.id+'.jsonl');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify({type:'session_meta',payload:{id:thread.id,cwd:thread.cwd}})+'\n'+JSON.stringify({type:'fixture_thread',payload:thread})+'\n');};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)return;fs.appendFileSync(path.join(home,'rpc.jsonl'),JSON.stringify({method:m.method,params:p})+'\n');
  try{let result={};if(m.method==='initialize')result={userAgent:'protocol-fixture'};
    if(m.method==='config/read')result={config:{model:'fixture-model',model_provider:'fixture-provider',model_providers:{'fixture-provider':{name:'Fixture',base_url:'http://127.0.0.1:1',env_key:'FIXTURE_KEY',wire_api:'responses',requires_openai_auth:false}},notify:['personal-popup'],hooks:{Stop:[]},mcp_servers:{personal:{command:'never-run'}}}};
    if(m.method==='account/read')result={account:{type:'chatgpt'},requiresOpenaiAuth:true};
    if(m.method==='thread/start'){const thread={id:randomUUID(),cwd:p.cwd,name:null,status:{type:'idle'},turns:[]};write(thread);result={thread:read(thread.id)};}
    if(m.method==='thread/name/set'){const thread=read(p.threadId);thread.name=p.name;write(thread);}
    if(m.method==='thread/read')result={thread:read(p.threadId)};
    if(m.method==='thread/list')result={data:[],nextCursor:null};
    if(m.method==='thread/resume'){if(p.path){const data=fs.readFileSync(p.path,'utf8').trim().split('\n').map(JSON.parse),thread=data.find(v=>v.type==='fixture_thread').payload;if(fs.existsSync(path.join(home,'corrupt-resume'))&&thread.turns.length)thread.turns[0].items=[];write(thread);}result={thread:read(p.threadId)};}
    if(m.method==='thread/archive'){const source=file(p.threadId),target=path.join(home,'archived_sessions',path.basename(source));fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(source,target);}
    if(m.method==='turn/start'){const thread=read(p.threadId),turnId=randomUUID(),item={id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'中文回答'};thread.turns.push({id:turnId,status:'completed',items:[{id:randomUUID(),type:'userMessage',content:p.input},item]});write(thread);send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turnId}}});send({method:'item/completed',params:{threadId:p.threadId,turnId,item}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:turnId,status:'completed'}}});result={turn:{id:turnId}};}
    send({id:m.id,result});
  }catch(error){send({id:m.id,error:{code:-32004,message:error.message}});}
});
