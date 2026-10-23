'use strict';
const readline=require('node:readline'),{randomUUID}=require('node:crypto');const threads=new Map();
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const failIndex=process.argv.indexOf('--startup-failure');
if(failIndex>=0){const fs=require('node:fs'),marker=process.argv[failIndex+1],mode=process.argv[failIndex+2],count=fs.existsSync(marker)?Number(fs.readFileSync(marker,'utf8')):0;fs.writeFileSync(marker,String(count+1));if(mode!=='once'||!count){process.stderr.write(mode==='generic'?'Unrelated startup failure\n':'Error: failed to initialize sqlite state runtime under owned-test-home\n');process.exit(1);}}
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
    if(process.argv.includes('--progress-summary')){
      const params={threadId:p.threadId,turnId,itemId:'summary-item',summaryIndex:0};
      send({method:'item/reasoning/summaryTextDelta',params:{...params,threadId:'other-thread',delta:'foreign summary'}});
      send({method:'item/reasoning/textDelta',params:{...params,delta:'raw-private-reasoning'}});
      send({method:'item/reasoning/summaryTextDelta',params:{...params,delta:'正在核对'}});
      send({method:'item/reasoning/summaryTextDelta',params:{...params,delta:'连接状态'}});
      send({method:'item/reasoning/summaryTextDelta',params:{...params,summaryIndex:1,delta:'准备验证结果'}});
    }
    send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId,itemId,delta:'中文回答'}});
    send({method:'item/completed',params:{threadId:p.threadId,turnId,item:{id:itemId,type:'agentMessage',text:'中文回答',phase:'final_answer'}}});
    send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:turnId,status:'completed'}}});
    result={turn:{id:turnId,status:'inProgress'}};
  }
  send({id:m.id,result});
});
