'use strict';
const {RoomError,id,redact,sleep}=require('./util.cjs');
class GroupOwnership{
  constructor(group){this.group=group;this.service=group.service;this.team=this.service.team;this.leases=new Map();this.running=false;}
  outcomes(room){return this.team.rows(room,'outcome').filter(o=>o.group_managed);}
  history(room,member){
    const grouped=new Map();for(const row of this.outcomes(room).filter(o=>o.member_id===member)){
      if(!grouped.has(row.task_type))grouped.set(row.task_type,{task_type:row.task_type,accepted:0,rework:0,reassigned:0,weighted_accepted:0,weighted_rework:0,weighted_reassigned:0});
      const value=grouped.get(row.task_type),weight=Math.pow(.5,Math.max(0,this.group.clock()-Date.parse(row.created_at))/(30*86400000));if(Object.hasOwn(value,row.outcome)){value[row.outcome]++;value['weighted_'+row.outcome]+=weight;}
    }return [...grouped.values()].map(v=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,typeof x==='number'?Math.round(x*1000)/1000:x])));
  }
  record(task,outcome,extra={}){
    const key=task.id+':'+task.attempt+':'+outcome,old=this.team.keyed(task.room_id,'outcome',key);if(old)return old;
    const value=this.team.create('outcome',task.room_id,key,{task_id:task.id,member_id:task.assignee_id,attempt:task.attempt,task_type:task.task_type||'general',outcome,group_managed:true,...extra},null);
    if(outcome==='accepted')this.propose(task,value);return value;
  }
  propose(task,outcome){
    let card=this.team.keyed(task.room_id,'card',task.assignee_id);
    if(!card)card=this.team.create('card',task.room_id,task.assignee_id,{member_id:task.assignee_id,role:'',skills:[],stance:'',pins:[],proposals:[],information:'',sources:[],session_ref:'',ack_version:0},null);
    const skill=task.task_type||'general';if(card.skills.includes(skill)||card.pins?.includes('skills')||card.proposals?.some(p=>p.field==='skills'&&p.value.includes(skill)))return;
    this.team.save(card,{proposals:[...(card.proposals||[]),{id:id(),field:'skills',value:[...card.skills,skill].slice(-20),reason:'这类任务有一次被用户采纳的结果，请确认是否加入技能栏',based_on:outcome.id,created_at:this.group.date()}]},null,'card_skill_proposed');
  }
  cardDecision(input){
    this.service.chat.store.requireParticipant(input.room_id,input.member_id);let card=this.team.keyed(input.room_id,'card',input.member_id);if(!card)throw new RoomError('名片还没有保存。',404);
    if(input.proposal_id){const proposal=card.proposals?.find(p=>p.id===input.proposal_id);if(!proposal)throw new RoomError('这条名片建议已处理，请刷新。',409);if(!['accept','decline'].includes(input.decision))throw new RoomError('请选择采用或忽略。');
      const patch={proposals:card.proposals.filter(p=>p.id!==proposal.id)};
      if(input.decision==='accept'){if(card.pins?.includes(proposal.field))throw new RoomError('这一栏已经钉住，先取消固定才能采用建议。',409);patch[proposal.field]=proposal.field==='skills'?[...new Set([...(card.skills||[]).filter(s=>card.pins?.includes('skills:'+s)),...proposal.value])]:proposal.value;}
      card=this.team.save(card,patch,null,'card_proposal_'+input.decision,input.expected_version);
    }else if(input.pin){if(typeof input.pin!=='string'||!['role','skills','stance'].includes(input.pin)&&!(input.pin.startsWith('skills:')&&card.skills.includes(input.pin.slice(7))))throw new RoomError('固定的名片栏无效。');const pins=new Set(card.pins||[]);if(input.pinned===false)pins.delete(input.pin);else pins.add(input.pin);card=this.team.save(card,{pins:[...pins]},null,'card_pin',input.expected_version);}
    else throw new RoomError('名片操作无效。');this.service.changed();return card;
  }
  coldStart(message,choice){
    if(!this.service.features.get(message.room_id).claims||message.reply_to||choice.uncertain||choice.helpers?.length)return choice;
    const candidates=this.group.candidates(message.room_id);if(candidates.length<2)return choice;
    const cards=this.team.cards(message.room_id);if(candidates.some(m=>cards.find(c=>c.member_id===m.id)?.role)||this.outcomes(message.room_id).length)return choice;
    const done=this.group.state(message.room_id).routes.filter(r=>r.task_id).length,member=candidates[done%candidates.length];
    return {...choice,owner_id:member.id,helpers:(choice.helpers||[]).filter(h=>h.member_id!==member.id),reason:'尚无既定分工和战绩，轮流接手'};
  }
  heartbeat(member,message){
    const item=this.group.claims.item(message);if(!item||item.member_id!==member)return;
    const stamp=this.group.clock();if(stamp-(this.leases.get(item.task_id)||0)<10000)return;
    const task=this.team.record(item.task_id,'task',item.room_id);if(!['queued','running'].includes(task.status))return;
    this.leases.set(task.id,stamp);this.team.save(task,{lease_until:new Date(stamp+300000).toISOString(),last_progress_at:new Date(stamp).toISOString()},member,'group_heartbeat');
  }
  async settle(task){
    const chat=this.service.chat,until=Date.now()+11000;
    while(chat.active.get(task.assignee_id)?.messageId===task.message_id&&Date.now()<until)await sleep(25);
    if(chat.active.get(task.assignee_id)?.messageId===task.message_id)throw new RoomError('处理尚未结束，请稍后确认结果。',409,'task_execution_active');
  }
  async decide(input){
    const route=this.group.get(input.message_id);if(!route||route.room_id!==input.room_id||!route.task_id)throw new RoomError('任务单不存在。',404);
    let task=this.team.record(route.task_id,'task',route.room_id);
    if(input.action==='choose_trial')return this.chooseTrial(route,input);
    if(input.action==='accept'&&route.status==='completed')return route;
    await this.settle(task);
    if(input.action==='accept'){
      const children=this.team.rows(route.room_id,'task').filter(t=>t.parent_task_id===task.id);
      for(const child of children){await this.settle(child);if(child.status==='review'){this.team.updateTask(child.id,{room_id:route.room_id,action:'approve',note:'用户采纳了负责人整合的结果'});this.record(child,'accepted');}else if(['failed','blocked','queued','running'].includes(child.status))this.team.updateTask(child.id,{room_id:route.room_id,action:'cancel',note:'用户已接受当前整合结果，该部分结束'});}
      task=this.team.updateTask(task.id,{room_id:route.room_id,action:'approve',note:'用户在任务单中采纳了结果'});this.record(task,'accepted');
      this.team.completeGoal(task.goal_id,{room_id:route.room_id,result:task.result,evidence:[{reference:'chat:'+task.message_id,note:'用户已采纳的实际关联回答'}]});this.group.save({...route,status:'completed',reason:'结果已采纳'});
    }else if(input.action==='rework'){
      if(typeof input.note!=='string'||!input.note.trim()||input.note.length>3000)throw new RoomError('请写一句需要重做的部分。');
      task=this.team.updateTask(task.id,{room_id:route.room_id,action:'request_changes',note:input.note});this.record({...task,attempt:task.attempt-1},'rework');this.group.dispatch(this.service.chat.store.message(route.message_id),{owner_id:task.assignee_id,reason:'按用户的补充要求重做'});
    }else throw new RoomError('任务单操作无效。');this.service.changed();return this.group.get(route.message_id);
  }
  async chooseTrial(route,input){
    if(route.status==='completed')return route;
    const selected=(route.trial_results||[]).find(r=>r.member_id===input.member_id&&r.status==='review');if(!selected||route.status!=='trial_choice')throw new RoomError('请从已完成的试用结果里选择。',409);
    const primary=this.team.record(route.task_id,'task',route.room_id),items=this.group.claims.items(route.message_id).filter(i=>i.role==='trial');
    for(const item of items){let task=this.team.record(item.task_id,'task',item.room_id);await this.settle(task);if(task.status==='review'){task=this.team.updateTask(task.id,{room_id:route.room_id,action:item.member_id===selected.member_id?'approve':'cancel',note:item.member_id===selected.member_id?'用户比较后采用':'比较已结束，用户选择另一份'});this.record(task,item.member_id===selected.member_id?'accepted':'comparison_not_selected');}}
    const reply=this.service.chat.store.post({room_id:route.room_id,sender_id:selected.member_id,text:selected.result,reply_to:route.message_id,kind:'reply',idempotency_key:'group-trial-selected:'+route.message_id});
    this.team.save(primary,{assignee_id:selected.member_id,status:'completed',result:selected.result,message_id:reply.id},null,'group_trial_selected');
    const goal=this.team.record(primary.goal_id,'goal',route.room_id);this.team.save(goal,{status:'completed',result:selected.result,evidence:[{reference:'chat:'+reply.id}]},null,'group_trial_accepted');
    this.group.save({...route,status:'completed',owner_id:selected.member_id,reason:'已采用这份试用结果',selected_reply_id:reply.id});this.service.changed();return this.group.get(route.message_id);
  }
  async tick(){
    if(this.running||this.group.closed)return;this.running=true;
    try{
      this.group.claims.tick();
      for(const room of this.service.chat.store.rooms()){
        if(!this.group.enabled(room.id)||!this.service.features.get(room.id).claims)continue;
        for(const task of this.team.rows(room.id,'task').filter(t=>t.group_managed&&!t.group_role&&t.status==='running'&&t.message_id)){
          const route=this.group.state(room.id).routes.find(r=>r.task_id===task.id);if(!route||route.status!=='assigned')continue;
          const message=this.service.chat.store.message(task.message_id);
          if(message.status==='waiting_input')continue;
          if(!['failed','uncertain','cancelled'].includes(message.status)&&Date.parse(task.lease_until)>this.group.clock())continue;
          const candidate=this.group.candidates(room.id).find(m=>m.id!==task.assignee_id);
          if(!candidate||message.status==='uncertain'){this.team.save(task,{status:message.status==='uncertain'?'uncertain':'blocked',note:message.status==='uncertain'?'执行结果待核对':'负责人暂时不可用，请选择新的负责人'},null,'group_lease_blocked');this.group.save({...route,status:'needs_user',reason:message.status==='uncertain'?'原任务结果待核对，请先核对再改派':'负责人需要更换，请选一位成员'});this.service.changed();continue;}
          try{await this.group.reassign({room_id:room.id,message_id:route.message_id,member_id:candidate.id,automatic:true});}catch(error){const current=this.team.record(task.id,'task',room.id);this.team.save(current,{status:'uncertain',note:redact(error.message)},null,'group_lease_uncertain');this.group.save({...this.group.get(route.message_id),status:'needs_user',reason:redact(error.message)});this.service.changed();}
        }
      }
    }finally{this.running=false;}
  }
}
module.exports={GroupOwnership};
