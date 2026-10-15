'use strict';
const fs=require('node:fs'),readline=require('node:readline'),{randomUUID}=require('node:crypto');
const log=process.argv[2];if(!log||!log.includes('agentroom-test-'))throw Error('Only an isolated fixture log is allowed');
const threads=new Map(),send=v=>process.stdout.write(JSON.stringify(v)+'\n');let held=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};if(m.id===undefined)return;fs.appendFileSync(log,JSON.stringify(m)+'\n');let result={};
  if(!m.method){if(held&&m.id===(held.stale?92:71)){const {threadId,turnId,stale}=held;send({method:'serverRequest/resolved',params:{threadId,requestId:m.id}});send({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',text:stale?'fixture answer':'fixture approved answer',phase:'final_answer'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});held=null;}return;}
  if(m.method==='initialize')result={userAgent:'review-wire-fixture'};
  if(m.method==='thread/start'){const thread={id:randomUUID(),cwd:p.cwd,turns:[]};threads.set(thread.id,thread);result={thread};}
  if(m.method==='thread/read'||m.method==='thread/resume')result={thread:threads.get(p.threadId)};
  if(m.method==='turn/start'){
    const turnId=randomUUID(),notify=(method,params)=>send({method,params:{threadId:p.threadId,turnId,...params}});
    notify('turn/started',{turn:{id:turnId}});
    if(process.argv.includes('--stale-approvals')){held={threadId:p.threadId,turnId,stale:true};send({id:91,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId:'previous-turn',command:'old action'}});send({id:92,method:'item/commandExecution/requestApproval',params:{command:'unscoped action'}});send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});return;}
    if(process.argv.includes('--wait-approval')){held={threadId:p.threadId,turnId};send({id:71,method:'item/commandExecution/requestApproval',params:{threadId:p.threadId,turnId,command:'fixture action',availableDecisions:['accept','decline']}});const ack={id:m.id,result:{turn:{id:turnId,status:'inProgress'}}};if(process.argv.includes('--hold-start-ack'))setTimeout(()=>send(ack),1500);else send(ack);return;}
    const review=(threadId,status)=>send({method:'item/autoApprovalReview/completed',params:{threadId,turnId,reviewId:status,completedAtMs:1000,action:{type:'command',command:'fixture read'},review:{status,rationale:status==='denied'?'Exact action requires authorization':'fixture review'}}});
    review('another-conversation','denied');review(p.threadId,'approved');review(p.threadId,'denied');
    notify('serverRequest/resolved',{requestId:17});
    notify('item/completed',{item:{id:'answer',type:'agentMessage',text:'fixture answer',phase:'final_answer'}});
    notify('turn/completed',{turn:{id:turnId,status:'completed'}});result={turn:{id:turnId,status:'inProgress'}};
  }
  send({id:m.id,result});
});
