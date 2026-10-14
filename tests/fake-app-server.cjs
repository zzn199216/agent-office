'use strict';
const readline=require('node:readline'),{randomUUID}=require('node:crypto');const threads=new Map();
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line),p=m.params || {};if(m.id===undefined)return;
  let result={};
  if(m.method==='initialize')result={userAgent:'fake-protocol-test-only'};
  if(m.method==='account/read')result={account:{type:'chatgpt'}};
  if(m.method==='thread/start'){const t={id:randomUUID(),cwd:p.cwd,turns:[]};threads.set(t.id,t);result={thread:t};}
  if(m.method==='thread/read')result={thread:threads.get(p.threadId)};
  if(m.method==='thread/resume')result={thread:threads.get(p.threadId)};
  if(m.method==='turn/start'){
    if(p.input.some(item=>item.type==='image')){const image=p.input.find(item=>item.type==='image');if(image.source?.url!=='data:image/png;base64,fixture-image'){send({id:m.id,error:{message:'Invalid image protocol'}});return;}process.stderr.write('request timed out Bearer private-fixture-key\n');await new Promise(resolve=>setTimeout(resolve,30));}
    const turnId=randomUUID(),itemId=randomUUID();
    send({method:'turn/started',params:{threadId:p.threadId,turn:{id:turnId}}});
    send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId,itemId,delta:'中文回答'}});
    send({method:'item/completed',params:{threadId:p.threadId,turnId,item:{id:itemId,type:'agentMessage',text:'中文回答',phase:'final_answer'}}});
    send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:turnId,status:'completed'}}});
    result={turn:{id:turnId,status:'inProgress'}};
  }
  send({id:m.id,result});
});
