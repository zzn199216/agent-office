'use strict';
// Explicit native acceptance: three new Codex collaboration sessions in one
// isolated project. Never joins, changes or dispatches into the user's rooms.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {RoomService}=require('../src/service.cjs'),{createServer}=require('../src/http.cjs');
const {CodexClient}=require('../src/codex.cjs'),{id,atomicWrite,sleep}=require('../src/util.cjs');
async function until(predicate,timeout=180000){const end=Date.now()+timeout;for(;;){const result=predicate();if(result)return result;if(Date.now()>end)throw Error('Native coordination acceptance timed out');await sleep(750);}}
async function main(){
  if(!process.argv.includes('--run-native'))throw Error('Use --run-native for explicitly requested native integration acceptance.');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentoffice-team-live-')),project=path.join(root,'project'),data=path.join(root,'data'),out=path.resolve(__dirname,'../output/validation/team-live-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(project);fs.mkdirSync(out,{recursive:true});
  const feature='FEATURE-'+crypto.randomBytes(5).toString('hex'),feedback='FEEDBACK-'+crypto.randomBytes(5).toString('hex');
  fs.writeFileSync(path.join(project,'features.txt'),`Current fixture product supports offline reports. Audit token: ${feature}. This is a synthetic acceptance project, not a released product.\n`);
  fs.writeFileSync(path.join(project,'feedback.txt'),`Fixture customers request exportable evidence. Audit token: ${feedback}. This is a synthetic acceptance project.\n`);
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Read-only acceptance project. Read only files in this folder. No file changes, installation, external network actions, or other conversations. Use AgentRoom task and meeting tools for the assigned workflow.\n');
  let service,server;const proof={mode:'native_codex',isolated:true,started_at:new Date().toISOString(),directory:root,version:require('../package.json').version,checks:{}};
  try{
    service=new RoomService(data,{fetch:async()=>{throw Error('No external notifications permitted in this validation.');}});
    const token=crypto.randomBytes(32).toString('hex');server=createServer(service,{token,port:0});const port=await server.listen();atomicWrite(path.join(data,'control.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+port,token,instance_id:service.runtime.instanceId}));
    const p=service.addProject({name:'Native team acceptance',path:project}),room=service.chat.addRoom({title:'Secretary and two workers',project_id:p.id});
    const members=['验收秘书','功能事实窗口','用户反馈窗口'].map(name=>service.chat.addMember({name,adapter:'codex'}));
    for(const member of members){service.chat.join(room.id,member.id);await service.chat.connect(member.id,room.id);await until(()=>{const current=service.chat.store.member(member.id);if(current.status==='connection_failed')throw Error(current.error);return current.status==='ready'&&!service.chat.active.has(member.id);});console.log(JSON.stringify({stage:'handshake',member:member.name,verified:true}));}
    const [secretary,dev,research]=members;service.secretary.set({room_id:room.id,member_id:secretary.id});
    for(const [member,role,file]of [[dev,'只读核实产品功能','features.txt'],[research,'只读核实用户反馈','feedback.txt']])service.team.card({room_id:room.id,member_id:member.id,role,skills:[role],information:'这个窗口负责读取并核实 '+file+'；请实际读文件，不猜测其中信息。',sources:[{reference:path.join(project,file),note:'本次独立验收资料'}]});
    service.team.card({room_id:room.id,member_id:secretary.id,role:'协调秘书',skills:['任务分配','会议主持','证据验收'],information:'只能通过两位工作成员收回事实；不要自己读 features.txt 或 feedback.txt。'});
    service.start();
    const goal=service.team.goal({room_id:room.id,title:'两窗口协作验收',description:`请真正执行完整工具流程：1.分别给 ${dev.name}（${dev.id}）和 ${research.name}（${research.id}）创建只读任务，读取各自信息卡所列文件，交付事实、文件中的完整审计token和引用。不得自己读这些文件，不用聊天等待。2.收到两份交付后使用 task_update approve 验收。3.创建一次关联本goal_id的会议，仅邀请两位工作成员，议题是相互了解功能与反馈并形成后续建议。4.两份报告收齐后 meeting_close 保存纪要，action_task_ids 关联两项已完成任务，不创建新业务任务。5.最后 goal_complete，result必须引用两份事实和两个完整token，并包含会议结论。不要仅给建议；每阶段执行对应MCP工具，等待时结束本轮。`,acceptance:'两个独立原生工作会话实际读不同文件并交付；两项任务经秘书验收；会议收齐两方报告并保存纪要与简报；最终目标交付引用两个文件审计token。',idempotency_key:'native-team-acceptance'});
    proof.room_id=room.id;proof.goal_id=goal.id;let signature='';
    await until(()=>{const state=service.team.snapshot(room.id),current=state.goals.find(g=>g.id===goal.id),summary=JSON.stringify({goal:current.status,tasks:state.tasks.map(t=>({title:t.title,status:t.status})),meetings:state.meetings.map(m=>({status:m.status,reports:m.reports.length}))});if(summary!==signature){signature=summary;console.log(summary);}if(service.team.error)throw Error(service.team.error);if(state.tasks.some(t=>['failed','uncertain'].includes(t.status)))throw Error('Native task failed: '+JSON.stringify(state.tasks.map(t=>({status:t.status,note:t.note}))));if(state.delivery_issues.length)throw Error('Coordination notification failed');return current.status==='completed';},720000);
    await until(()=>!service.chat.active.size&&service.team.cards(room.id).filter(c=>c.member_id!==secretary.id).every(c=>c.ack_version>=service.team.brief(room.id).version),180000);
    const state=service.team.snapshot(room.id),final=state.goals.find(g=>g.id===goal.id),tasks=state.tasks.filter(t=>t.goal_id===goal.id),meeting=state.meetings.find(m=>m.goal_id===goal.id);
    proof.checks={goal_completed:final.status==='completed',two_tasks_accepted:tasks.length===2&&tasks.every(t=>t.status==='completed'),independent_assignees:new Set(tasks.map(t=>t.assignee_id)).size===2,actual_source_tokens:final.result.includes(feature)&&final.result.includes(feedback),meeting_completed:meeting?.status==='completed',two_actual_reports:new Set(meeting?.reports.map(r=>r.member_id)).size===2,brief_published:state.brief.version>0};
    const reader=new CodexClient(),traces=[];
    try{for(const member of members){const binding=service.chat.store.binding(room.id,member.id),thread=await reader.read(binding.thread_id);traces.push({member_id:member.id,name:member.name,thread_id:binding.thread_id,turns:thread.turns.map(turn=>({id:turn.id,status:turn.status,tools:(turn.items||[]).filter(i=>i.type==='mcpToolCall').map(i=>({tool:i.tool,status:i.status})),commands:(turn.items||[]).filter(i=>i.type==='commandExecution').map(i=>({command:i.command,exit_code:i.exitCode}))}))});}}finally{await reader.close();}
    proof.checks.three_independent_native_sessions=new Set(traces.map(x=>x.thread_id)).size===3;
    const toolsOf=member=>traces.find(t=>t.member_id===member.id)?.turns.flatMap(t=>t.tools).filter(t=>t.status==='completed').map(t=>t.tool)||[];
    proof.checks.secretary_native_tools=['agentroom_task_create','agentroom_task_update','agentroom_meeting_start','agentroom_meeting_close','agentroom_goal_complete'].every(name=>toolsOf(secretary).includes(name));
    proof.checks.workers_native_tools=[dev,research].every(member=>['agentroom_task_update','agentroom_meeting_report'].every(name=>toolsOf(member).includes(name)));
    proof.checks.brief_acknowledged_by_workers=[dev,research].every(member=>state.cards.find(c=>c.member_id===member.id).ack_version===state.brief.version&&toolsOf(member).includes('agentroom_brief_ack'));
    proof.checks.workers_read_actual_files=[[dev,'features.txt'],[research,'feedback.txt']].every(([member,file])=>traces.find(t=>t.member_id===member.id).turns.some(t=>t.commands.some(c=>c.exit_code===0&&c.command.includes(file))));
    proof.state=state;proof.traces=traces;assert.ok(Object.values(proof.checks).every(Boolean),'Native evidence is incomplete');proof.ok=true;
  }catch(error){proof.ok=false;proof.error=error.stack||error.message;if(service&&proof.room_id)proof.state=service.team.snapshot(proof.room_id);process.exitCode=1;}
  finally{await server?.close();await service?.close();proof.ended_at=new Date().toISOString();fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({ok:proof.ok,checks:proof.checks,error:proof.error,result:path.join(out,'result.json')}));}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
