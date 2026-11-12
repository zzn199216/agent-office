'use strict';
const {RoomError,id,redact}=require('./util.cjs');
const short=(value,max=500)=>redact(String(value||'')).trim().slice(0,max);
class GroupClaims{
  constructor(group){this.group=group;this.service=group.service;this.db=group.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS group_work_items(message_id TEXT PRIMARY KEY,room_id TEXT NOT NULL,origin_id TEXT NOT NULL,task_id TEXT NOT NULL,role TEXT NOT NULL,member_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS group_work_origin ON group_work_items(origin_id);`);
  }
  item(message){if(typeof message!=='string')return null;const row=this.db.prepare('SELECT * FROM group_work_items WHERE message_id=?').get(message);return row?{...row,...JSON.parse(row.body)}:null;}
  items(origin){return this.db.prepare('SELECT message_id FROM group_work_items WHERE origin_id=? ORDER BY rowid').all(origin).map(r=>this.item(r.message_id));}
  link(message,route,task,role,extra={}){this.db.prepare('INSERT INTO group_work_items VALUES(?,?,?,?,?,?,?)').run(message.id,route.room_id,route.message_id,task.id,role,task.assignee_id,JSON.stringify(extra));}
  patch(item,fields){this.db.prepare('UPDATE group_work_items SET body=? WHERE message_id=?').run(JSON.stringify({...JSON.parse(this.db.prepare('SELECT body FROM group_work_items WHERE message_id=?').get(item.message_id).body),...fields}),item.message_id);}
  hidden(room){return this.db.prepare('SELECT message_id,body FROM group_work_items WHERE room_id=?').all(room).flatMap(r=>[r.message_id,JSON.parse(r.body).reply_id].filter(Boolean));}
  instructions(){return '对复杂任务给出两轮认领建议，但不能冒充成员真实发言。JSON 增加 kind="question"或"task"，task_type，proposals=[{member_id,first_step,missing,nomination,helper_scope}]，helpers=[{member_id,subtask}]。主负责人只一位；协助者任务应互不重叠，不能各自完成整个原任务。普通问答 helpers=[]。有不确定分工时 uncertain=true，交由用户选；不能唤醒的成员不参与。';}
  normalize(message,choice){
    const candidates=this.group.candidates(message.room_id),ids=new Set(candidates.map(m=>m.id)),helpers=[],scopes=new Set();
    for(const raw of Array.isArray(choice.helpers)?choice.helpers:[]){if(!raw||!['string','object'].includes(typeof raw))continue;const member=typeof raw==='string'?raw:raw.member_id,subtask=short(raw.subtask,1800),normalized=subtask.replace(/\s/g,'').toLowerCase();
      if(!ids.has(member)||member===choice.owner_id||helpers.some(h=>h.member_id===member))continue;
      if(subtask.length<4||normalized===message.text.replace(/\s/g,'').toLowerCase()||scopes.has(normalized))throw new RoomError('协助范围还不清楚，请先选择一位负责人。',409,'group_scope_unclear');
      scopes.add(normalized);helpers.push({member_id:member,subtask});
    }
    const proposals=(Array.isArray(choice.proposals)?choice.proposals:[]).filter(p=>p&&ids.has(p.member_id)).filter((p,i,all)=>all.findIndex(v=>v.member_id===p.member_id)===i).map(p=>({member_id:p.member_id,first_step:short(p.first_step,250),missing:short(p.missing,250),nomination:ids.has(p.nomination)?p.nomination:choice.owner_id,helper_scope:short(p.helper_scope,250),source:'secretary_prediction',capabilities:this.group.facts(candidates.find(m=>m.id===p.member_id))}));
    return {...choice,task_type:short(choice.task_type,80)||'general',helpers,proposals};
  }
  meeting(message,choice){
    const team=this.service.team,key='group:'+message.id,old=team.keyed(message.room_id,'meeting',key);if(old)return old;
    const participants=this.group.candidates(message.room_id).map(m=>m.id);
    return team.create('meeting',message.room_id,key,{title:message.text.slice(0,120),agenda:'两轮认领：先提出第一步与缺口，再推荐负责人或自己的协助范围',participant_ids:participants,expected_member_ids:participants,status:'completed',round:2,deadline_at:new Date(this.group.clock()+90000).toISOString(),reports:[],predictions:choice.proposals||[],summary:choice.uncertain?'等待用户选择':'秘书建议分工',decisions:[],action_task_ids:[],discussion_keys:[],group_managed:true,claims_pending:[]},null);
  }
  extraAvailable(room,count){const settings=this.service.features.get(room);if(!settings.discussion||settings.daily_limit!==null&&this.group.today(room)+count>settings.daily_limit)throw new RoomError('这次分工需要更多调用，请提高上限或选择一位负责人。',409,'group_daily_limit');}
  begin(message,raw){
    const choice=this.normalize(message,raw),settings=this.service.features.get(message.room_id),trial=settings.trial&&this.group.candidates(message.room_id).length>=2;
    if(!trial&&choice.kind!=='task'&&!choice.helpers.length&&!choice.proposals.length)return false;
    const meeting=this.meeting(message,choice);this.group.save({...this.group.get(message.id),meeting_id:meeting.id,predictions:choice.proposals,task_type:choice.task_type});
    if(choice.uncertain){this.group.save({...this.group.get(message.id),status:'needs_user',reason:'请从建议中选一位负责人',suggestions:choice});this.service.changed();return true;}
    if(trial){this.comparison(message,choice);return true;}
    if(!choice.helpers.length)return false;
    this.extraAvailable(message.room_id,choice.helpers.length);
    const task=this.group.task(message,choice),team=this.service.team,route=this.group.save({...this.group.get(message.id),status:'collaborating',owner_id:choice.owner_id,task_id:task.id,suggestions:choice,reason:'协助者先处理各自部分，负责人统一回复'});
    team.save(task,{status:'blocked',note:'等待协助者交付自己的部分',task_type:choice.task_type},null,'group_helpers');
    for(const helper of choice.helpers){
      const call=this.group.reserve(message.room_id,helper.member_id,'helper_execute',helper.subtask.length);
      const child=team.create('task',message.room_id,'helper:'+task.id+':'+helper.member_id,{goal_id:task.goal_id,parent_task_id:task.id,title:helper.subtask.slice(0,120),description:helper.subtask,assignee_id:helper.member_id,deliverable:helper.subtask,acceptance:'只交付分配的部分，交给负责人整合',depends_on:[],status:'running',result:'',note:'',evidence:[],attempt:1,message_id:null,group_managed:true,group_role:'helper',task_type:choice.task_type,lease_until:new Date(this.group.clock()+300000).toISOString()},null);
      const delivery=this.service.chat.post({room_id:message.room_id,sender_id:'user',to_member_id:helper.member_id,reply_to:message.id,text:`协助任务 ${child.id}。只处理下面这一块，结果交给负责人整合；不要独自完成整个原任务，也不直接对用户另发答案。\n你的部分：${helper.subtask}\n原任务仅供理解：${message.text.slice(0,4000)}`,idempotency_key:'group-helper:'+child.id},{deferDelivery:true});
      this.link(delivery,route,child,'helper',{call_id:call});team.save(child,{message_id:delivery.id},null,'group_helper_dispatch');
      this.service.chat.adapter(this.service.chat.store.member(helper.member_id)).message(delivery)?.catch?.(()=>{});
    }
    const current=team.record(meeting.id,'meeting',message.room_id);team.save(current,{action_task_ids:[task.id,...this.items(message.id).map(i=>i.task_id)]},null,'group_assignments');this.service.changed();return true;
  }
  sideReply(original,member,text,key){
    const item=this.item(original.id);if(!item||!['helper','trial'].includes(item.role))return null;
    const route=this.group.get(item.origin_id),team=this.service.team;
    const reply=this.service.chat.store.post({room_id:original.room_id,sender_id:member,to_member_id:item.role==='helper'?route.owner_id:null,reply_to:original.id,text,kind:'reply',idempotency_key:key});
    this.service.chat.store.updateMessage(reply.id,{status:'consumed'});this.service.chat.store.updateMessage(original.id,{status:'answered',error:null});
    this.patch(item,{reply_id:reply.id,status:'review'});const task=team.record(item.task_id,'task',item.room_id);team.save(task,{status:'review',result:reply.text.slice(0,15000)},member,'group_partial_result');
    if(item.call_id)this.db.prepare("UPDATE group_calls SET status='completed' WHERE id=?").run(item.call_id);
    this.group.markRead(original.room_id,member,reply.seq);this.finish(item.origin_id);this.service.changed();return reply;
  }
  finish(origin){
    const route=this.group.get(origin),items=this.items(origin).filter(i=>['helper','trial'].includes(i.role));
    if(!items.length||!items.every(i=>['review','failed','cancelled'].includes(i.status)))return;
    if(items.some(i=>i.role==='trial')){this.group.save({...route,status:'trial_choice',reason:'两份试用结果已返回，请选用一份',trial_results:items.map(i=>({member_id:i.member_id,task_id:i.task_id,reply_id:i.reply_id||null,result:this.service.team.record(i.task_id,'task',i.room_id).result||'',status:i.status}))});this.service.changed();return;}
    if(route.delivery_id||route.status==='needs_user')return;
    const results=items.map(i=>({member_id:i.member_id,scope:this.service.team.record(i.task_id,'task',i.room_id).description,result:this.service.team.record(i.task_id,'task',i.room_id).result||'该部分没有完成',status:i.status}));
    this.group.save({...route,helper_results:results});this.group.dispatch(this.service.chat.store.message(origin),{...route.suggestions,helpers:[],helper_results:results});
  }
  comparison(message,choice){
    this.extraAvailable(message.room_id,1);const team=this.service.team,main=this.group.task(message,choice),candidates=this.group.candidates(message.room_id),members=[candidates.find(m=>m.id===choice.owner_id),candidates.find(m=>m.id!==choice.owner_id)].filter(Boolean);
    const route=this.group.save({...this.group.get(message.id),mode:'trial',status:'trial',owner_id:choice.owner_id,task_id:main.id,reason:'试用模式：两位只读作答，由你选用',suggestions:choice});team.save(main,{status:'blocked',note:'等待用户比较试用结果'},null,'group_trial');
    members.forEach((m,index)=>{const call=index?this.group.reserve(message.room_id,m.id,'trial_extra',message.text.length):null;
      const task=team.create('task',message.room_id,'trial:'+main.id+':'+m.id,{goal_id:main.goal_id,parent_task_id:main.id,title:main.title,description:message.text,assignee_id:m.id,deliverable:'独立试用答案',acceptance:'由用户比较并选用',depends_on:[],status:'running',attempt:1,result:'',message_id:null,note:'',evidence:[],group_managed:true,group_role:'trial',task_type:choice.task_type,lease_until:new Date(this.group.clock()+300000).toISOString()},null);
      const delivery=this.service.chat.post({room_id:message.room_id,sender_id:'user',to_member_id:m.id,reply_to:message.id,text:message.text,idempotency_key:'group-trial:'+task.id},{deferDelivery:true});this.link(delivery,route,task,'trial',{call_id:call});team.save(task,{message_id:delivery.id},null,'trial_dispatch');this.service.chat.adapter(this.service.chat.store.member(m.id)).message(delivery)?.catch?.(()=>{});
    });this.service.changed();
  }
  async listen(input){
    const route=this.group.get(input.message_id);if(!route||route.room_id!==input.room_id||!route.meeting_id)throw new RoomError('没有可认领的任务单。',404);
    if(route.delivery_id||route.status!=='needs_user')throw new RoomError('任务已经派出，不能继续发起认领。',409,'group_claim_closed');
    if(!this.group.enabled(input.room_id)||!this.service.features.get(input.room_id).claims)throw new RoomError('请开启群内讨论和认领。',409);
    const team=this.service.team,meeting=team.record(route.meeting_id,'meeting',input.room_id),member=this.group.candidates(input.room_id).find(m=>m.id===input.member_id);
    if(meeting.resolution_started)throw new RoomError('正在按已有认领决定负责人，请稍候。',409,'group_claim_deciding');
    if(!member||!meeting.participant_ids.includes(member.id))throw new RoomError('这位成员当前不能参与自动认领。',409);
    if((meeting.claims_pending||[]).includes(member.id)||meeting.claims_failed?.[member.id]||meeting.reports.some(r=>r.member_id===member.id))throw new RoomError('这位成员的本次认领已发起，请按已有结果选择负责人。',409,'group_round_limit');
    team.save(meeting,{claims_pending:[...(meeting.claims_pending||[]),member.id]},null,'group_claim_invited');const abort=new AbortController(),pendingKey='claim:'+meeting.id+':'+member.id,deadline=setTimeout(()=>abort.abort(),90000);
    const work=(async()=>{
      for(let round=1;round<=2;round++){
        const current=team.record(meeting.id,'meeting',input.room_id),prompt=JSON.stringify({round,task:this.service.chat.store.message(route.message_id).text.slice(0,5000),member:this.group.cards(input.room_id,[member])[0],others:current.reports.map(r=>({member_id:r.member_id,round:r.round,content:r.content})),secretary_suggestions:current.predictions});
        const instructions=round===1?'只返回 JSON：{"first_step":"具体第一步","missing":"缺口或不确定性"}。不执行任务，不调用工具，不读文件。':'只返回 JSON：{"choice":"我来|让某某来|某某主做，我负责某一块","owner_id":"候选成员ID","helper_scope":"自己的独立部分或空"}。本轮之后认领结束，不执行任务。';
        const result=await this.group.lightweight(member,input.room_id,prompt,abort.signal,'claim_round_'+round,instructions);let content;try{content=typeof result==='string'?JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g,'')):result;}catch{throw new RoomError('认领返回格式不明确，请按现有建议选择负责人。');}
        if(round===1&&!short(content.first_step)||round===2&&(!short(content.choice)||!meeting.participant_ids.includes(content.owner_id)))throw new RoomError('这位成员的认领还不明确，请按已有建议选择负责人。');
        const fresh=team.record(meeting.id,'meeting',input.room_id);team.save(fresh,{reports:[...fresh.reports,{member_id:member.id,round,content:{first_step:short(content.first_step,300),missing:short(content.missing,300),choice:short(content.choice,200),owner_id:meeting.participant_ids.includes(content.owner_id)?content.owner_id:member.id,helper_scope:short(content.helper_scope,300)},source:'member_actual',capabilities:this.group.facts(member),created_at:this.group.date()}]},member.id,'group_claim_report');this.service.changed();
      }
      const current=team.record(meeting.id,'meeting',input.room_id);team.save(current,{claims_pending:(current.claims_pending||[]).filter(m=>m!==member.id)},null,'group_claim_finished');await this.resolve(route.message_id,abort.signal);return this.group.state(input.room_id);
    })();this.group.pending.set(pendingKey,{abort,work});try{return await work;}catch(error){if(!this.service.chat.roomDeleted(input.room_id)){const current=team.record(meeting.id,'meeting',input.room_id);team.save(current,{claims_pending:(current.claims_pending||[]).filter(m=>m!==member.id),claims_failed:{...(current.claims_failed||{}),[member.id]:redact(error.message).slice(0,500)}},null,'group_claim_failed');this.service.changed();}throw error;}finally{clearTimeout(deadline);this.group.pending.delete(pendingKey);}
  }
  async decide(input){
    const route=this.group.get(input.message_id);if(!route||route.room_id!==input.room_id||!route.meeting_id)throw new RoomError('没有可认领的任务单。',404);
    if(route.delivery_id||route.status!=='needs_user')throw new RoomError('任务已经派出，不能继续裁决认领。',409,'group_claim_closed');
    if(!this.group.enabled(input.room_id)||!this.service.features.get(input.room_id).claims)throw new RoomError('请开启群内讨论和认领。',409);
    await this.resolve(input.message_id,undefined,{explicit:true});return this.group.get(input.message_id);
  }
  async resolve(messageId,signal,{explicit=false}={}){
    const route=this.group.get(messageId);if(route.status!=='needs_user'||route.delivery_id||!route.meeting_id)return;
    const team=this.service.team,meeting=team.record(route.meeting_id,'meeting',route.room_id);if(meeting.resolution_started)return;
    const candidates=this.group.candidates(route.room_id),actual=meeting.reports.filter(r=>r.source==='member_actual'&&meeting.participant_ids.includes(r.member_id)),second=actual.filter(r=>r.round===2).filter((r,i,all)=>all.findIndex(v=>v.member_id===r.member_id)===i),nominations=second.map(r=>r.content?.owner_id).filter(v=>candidates.some(m=>m.id===v));
    if(meeting.claims_pending?.length){if(explicit)throw new RoomError('还有成员正在认领，请等这一轮结束。',409,'group_claim_pending');return;}
    if(!second.length){if(explicit)throw new RoomError('请先邀请至少一位成员完成两轮认领。',409,'group_claim_empty');return;}
    if(!explicit&&!meeting.participant_ids.every(member=>second.some(r=>r.member_id===member))){this.group.save({...route,reason:'已有成员完成认领；可继续邀请其他成员，或按现有认领决定'});this.service.changed();return;}
    team.save(meeting,{resolution_started:true},null,'group_claim_resolution');let choice;
    try{
      if(nominations.length===second.length&&new Set(nominations).size===1){const owner=nominations[0],speaker=candidates.find(m=>m.id===second[0].member_id);choice={owner_id:owner,kind:'task',task_type:route.task_type,reason:second.length===1?'按 '+(speaker?.name||'该成员')+' 的认领决定':'认领意见一致',helpers:second.filter(r=>r.member_id!==owner&&short(r.content?.helper_scope,250)).map(r=>({member_id:r.member_id,subtask:short(r.content.helper_scope,250)}))};}
      else{const secretary=this.group.triager(route.room_id,candidates);if(!secretary)throw new RoomError('请选择一位负责人。',409);choice=this.group.parse(await this.group.lightweight(secretary,route.room_id,JSON.stringify({task:this.service.chat.store.message(messageId).text.slice(0,5000),cards:this.group.cards(route.room_id,candidates),reports:actual,predictions:meeting.predictions}),signal,'claim_decision'));}
    }catch(error){const fresh=team.record(meeting.id,'meeting',route.room_id);team.save(fresh,{resolution_started:false},null,'group_claim_resolution_failed');this.service.changed();throw error;}
    if(!candidates.some(m=>m.id===choice.owner_id)||choice.uncertain){const fresh=team.record(meeting.id,'meeting',route.room_id);team.save(fresh,{resolution_started:false},null,'group_claim_unresolved');this.group.save({...this.group.get(messageId),reason:'认领仍有分歧，请选择负责人'});this.service.changed();return;}
    choice=this.normalize(this.service.chat.store.message(messageId),choice);
    if(!this.begin(this.service.chat.store.message(messageId),choice))this.group.dispatch(this.service.chat.store.message(messageId),choice);
  }
  tick(){
    this.db.prepare("UPDATE group_calls SET status=(SELECT CASE m.status WHEN 'answered' THEN 'completed' ELSE m.status END FROM chat_messages m JOIN group_peer_calls p ON p.message_id=m.id WHERE p.call_id=group_calls.id) WHERE status='running' AND id IN (SELECT p.call_id FROM group_peer_calls p JOIN chat_messages m ON m.id=p.message_id WHERE m.status IN ('answered','failed','cancelled','uncertain'))").run();
    for(const row of this.db.prepare("SELECT message_id FROM group_work_items WHERE role IN ('helper','trial')").all()){
      const item=this.item(row.message_id);if(item.status||this.service.chat.roomDeleted(item.room_id))continue;
      const message=this.service.chat.store.message(item.message_id),route=this.group.get(item.origin_id);
      const owned=this.service.team.record(item.task_id,'task',item.room_id);
      if(!item.stop_requested&&['queued','processing','delivered','consumed'].includes(message.status)&&Date.parse(owned.lease_until)<=this.group.clock()){if(['delivered','consumed'].includes(message.status))this.service.chat.store.updateMessage(message.id,{status:'uncertain',error:'协助任务已送达，实际处理是否结束尚未核对。'});else this.service.chat.cancel(message.id);this.patch(item,{stop_requested:true});}
      if(message.status==='uncertain'){this.group.save({...route,status:'needs_user',reason:'协助任务结果待核对，请先核对原任务'});continue;}
      if(['failed','cancelled'].includes(message.status)){this.patch(item,{status:message.status});const task=this.service.team.record(item.task_id,'task',item.room_id);this.service.team.save(task,{status:message.status,note:message.error||'协助未完成'},null,'group_helper_stopped');if(item.call_id)this.db.prepare("UPDATE group_calls SET status=? WHERE id=?").run(message.status==='failed'?'failed':'cancelled',item.call_id);this.finish(item.origin_id);}
    }
  }
}
module.exports={GroupClaims};
