'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {apiCall}=require('../src/main.cjs');
async function main(){
  const dir=process.env.AGENTROOM_DATA_DIR;if(!dir)throw new Error('Set AGENTROOM_DATA_DIR to the isolated test runtime.');
  const api=(route,input)=>apiCall(dir,route,input);const state=await api('/api/state');const project=state.projects.find(p=>p.name==='AgentRoom');if(!project)throw new Error('Register the test project first.');
  const discussion=await api('/api/discussions',{project_id:project.id,title:'功能验证 · 中文持续问答'});
  const prompts=['请仅回复“第一轮已收到”。不要调用工具，不要修改文件。','上轮你回复了哪句话？只回复那句话，不调用工具、不修改文件。','请只读查看项目 package.json，回答应用名称与版本。不要读取 .local，不修改文件。'];
  const records=[];
  for(const prompt of prompts){
    const request=await api('/api/requests',{discussion_id:discussion.id,sender:'user',recipient:'codex',message:prompt,idempotency_key:crypto.randomUUID()});
    let r;const end=Date.now()+300000;
    do{r=await api(`/api/requests/${request.id}/wait?seconds=20`);if(['completed','failed','cancelled','outcome_uncertain'].includes(r.status))break;}while(Date.now()<end);
    records.push({request_id:r.id,status:r.status,answer:r.answer,error:r.error,turn_id:r.turn_id});console.log(JSON.stringify(records.at(-1)));
    if(r.status!=='completed')break;
  }
  const snapshot=await api(`/api/discussions/${discussion.id}`);
  const evidence={tested_at:new Date().toISOString(),mode:'Real installed Codex App Server; no UI automation',discussion_id:discussion.id,codex_thread_id:snapshot.discussion.thread_id,requests:records,unicode_roundtrip:records[0]?.answer.includes('第一轮已收到'),followup_context_preserved:records[1]?.answer.includes('第一轮已收到'),project_read_verified:records[2]?.answer.includes('agentroom-local')&&records[2]?.answer.includes('0.1.0')};
  const out=path.join(__dirname,'..','output','validation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'live-codex.json'),JSON.stringify(evidence,null,2));
  if(records.length!==3||records.some(r=>r.status!=='completed')||!evidence.unicode_roundtrip||!evidence.followup_context_preserved||!evidence.project_read_verified)throw new Error('Live Codex check incomplete; inspect saved evidence.');
  console.log('Live Codex smoke passed.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
