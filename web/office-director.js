(function(root,factory){'use strict';const api=factory(typeof module==='object'&&module.exports?require('./office-scene.js'):root.AgentOfficeModel,typeof module==='object'&&module.exports?require('./office.js'):root.AgentOfficeScene);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.AgentOfficeDirector=Object.freeze(api);})(typeof window==='object'?window:null,function(model,legacy){
  'use strict';
  function profile(member){const key=String(member.provider||member.adapter||member.name||'').toLowerCase();return ['deepseek','doubao','claude','codex','grok','gemini','kimi','qwen','cursor'].find(p=>key.includes(p))||'generic';}
  function facts(input,now=Date.now()){
    const described=legacy.describe(input,now),counts=new Map();return described.members.map(info=>{
      const m=info.member,key=profile(m),variant=counts.get(key)||0;counts.set(key,variant+1);
      const request=info.activity?.message||described.messages.slice().reverse().find(v=>v.to_member_id===m.id&&['processing','waiting_input','uncertain','queued','consumed','delivered'].includes(v.status)&&!['reply','acknowledgment'].includes(v.kind));
      const approval=(input.approvals||[]).find(a=>a.member_id===m.id||a.request_id===request?.id);
      let state='idle',note='',label='空闲';
      if(!described.online||!m.verified_at||info.presence.needsConnection||['connection_failed','failed','disabled','revoked','offline'].includes(m.status)){state='unconnected';note=!described.online?'本机服务未连接':m.connection_presentation?.reason||m.error||info.presence.label||'继续接入';label=!m.verified_at?'未接通':'当前离线';}
      else if(info.needsInput||approval){state='attention';note=approval?.questions?.[0]?.question||approval?.reason||request?.error||'请确认这一步后继续';label='等待你的反馈';}
      else if(info.processing){state='working';note=info.activity?.text||'正在处理消息';label='工作中';}
      else if(info.waiting&&!m.delivery_capability?.can_wake){state='attention';note='请在 '+m.name+' 的窗口处理消息';label='等待你的反馈';}
      else if(info.waiting)label='等待接手';
      return {id:m.id,member:m,profile:key,variant:variant%5,state,label,note:String(note).slice(0,220),message_id:request?.id||null};
    });
  }
  function events(input){
    const ids=new Set((input.participants||[]).map(m=>m.id)),result=[];
    for(const m of (input.messages||[]).slice(-64))if(ids.has(m.sender_id)&&ids.has(m.to_member_id)&&m.sender_id!==m.to_member_id&&!m.connection_verification&&!['failed','cancelled'].includes(m.status)&&['message','reply'].includes(m.kind))result.push({id:'message:'+m.id,type:'pair',from:m.sender_id,to:m.to_member_id,text:String(m.text||'').slice(0,90),seq:m.seq||0});
    for(const meeting of (input.group?.meetings||[]).slice(-16))for(const report of meeting.reports||[])if(report.source==='member_actual'&&[1,2].includes(report.round)&&ids.has(report.member_id)){
      const content=report.content||{};result.push({id:'claim:'+meeting.id+':'+report.member_id+':'+report.round,type:'claim',from:report.member_id,round:report.round,text:String(report.round===1?content.first_step||'':content.choice||content.helper_scope||'').slice(0,90)});
    }
    return result.slice(-96);
  }
  class Director{
    constructor(options={}){this.random=options.random||Math.random;this.reset();}
    reset(){this.entities=new Map();this.reservations=new Map();this.scene=null;this.features={};this.now=0;this.lastStep=null;this.seen=new Set();this.maxSeq=0;this.eventsEnabled=false;this.eventQueue=[];this.playedEvents=[];}
    home(e){return [e.seat.at[0],e.seat.at[1]+1];}
    pose(e){e.anim=e.state==='working'?'type':e.state==='attention'?'raise':e.state==='unconnected'?null:'sit';e.face=e.seat.face;e.raiseStarted=this.now;e.frame=e.state==='attention'&&this.features.reduced_motion?1:0;}
    occupied(except){const cells=new Set();for(const e of this.entities.values())if(e.id!==except){cells.add(model.cell(e.at));if(e.script?.target)cells.add(model.cell(e.script.target));}for(const [key,owner]of this.reservations)if(owner!==except)cells.add(key);return cells;}
    idleLater(e){e.idleDue=this.now+12000+Math.floor(this.random()*8000);}
    cancel(e,linked=true){const partner=this.entities.get(e.partner);if(linked&&e.eventId&&partner?.eventId===e.eventId){this.cancel(partner,false);this.pose(partner);}if(e.reservation&&this.reservations.get(e.reservation)===e.id)this.reservations.delete(e.reservation);e.reservation=null;e.script=null;e.bubble='';e.eventId=null;e.partner=null;this.idleLater(e);}
    settle(e,walk=false){
      this.cancel(e);this.pose(e);const home=this.home(e);
      if(walk&&this.features.walking&&!this.features.reduced_motion&&e.state!=='unconnected'&&e.state!=='attention'&&model.cell(e.at)!==model.cell(home))this.startScript(e.id,[{walkTo:home}],'reaction');
      else e.at=home;
    }
    update(next,scene,features={},now=this.now){
      this.now=now;const initial=this.scene===null,geometryChanged=this.scene&&JSON.stringify(this.scene)!==JSON.stringify(scene),ambientEnabled=features.ambient&&!this.features.ambient;this.scene=scene;this.features=features;
      const ids=new Set(next.map(f=>f.id));for(const id of this.entities.keys())if(!ids.has(id)){this.cancel(this.entities.get(id));this.entities.delete(id);}
      next.forEach((fact,index)=>{
        const seat=model.station(scene,fact.id,index),prior=this.entities.get(fact.id),seatChanged=prior&&model.cell(prior.seat.at)!==model.cell(seat.at),changed=prior&&prior.state!==fact.state;
        const e=prior||{id:fact.id,at:[seat.at[0],seat.at[1]+1],frame:0,script:null,bubble:''};e.fact=fact;e.seat=seat;e.state=fact.state;this.entities.set(fact.id,e);
        if(!prior){this.pose(e);this.idleLater(e);if(!initial&&features.walking&&!features.reduced_motion&&e.state==='idle'){const entry=[1,1];if(!this.occupied(e.id).has(model.cell(entry)))e.at=entry;this.settle(e,true);}}
        else if(changed||seatChanged||geometryChanged||!features.walking&&e.script?.steps.some(s=>s.walkTo)||features.reduced_motion||!features.ambient&&e.script?.layer==='ambient'||!features.interactions&&e.eventId)this.settle(e,!geometryChanged&&(changed||seatChanged));
        if(ambientEnabled)this.idleLater(e);
      });return this.entities;
    }
    startScript(id,steps,layer='reaction'){
      const e=this.entities.get(id);if(!e||e.state==='unconnected'||layer==='ambient'&&e.state!=='idle'||!Array.isArray(steps)||steps.length>40)return false;
      if(steps.some(s=>!s||Object.keys(s).some(k=>!['walkTo','face','animate','bubble','wait'].includes(k))||s.walkTo&&(!Array.isArray(s.walkTo)||s.walkTo.length!==2||s.walkTo.some(v=>!Number.isInteger(v)))||s.face&&!model.DIRECTIONS.includes(s.face)||s.animate&&!model.ACTIONS.includes(s.animate)||s.wait!==undefined&&(!Number.isFinite(s.wait)||s.wait<0||s.wait>60000)||s.bubble!==undefined&&(typeof s.bubble!=='string'||s.bubble.length>140)))return false;
      this.cancel(e);e.script={steps:steps.map(s=>({...s})),index:0,layer,path:null,target:null,until:null};return true;
    }
    observe(list){
      const enabled=this.features.interactions===true,wasEnabled=this.eventsEnabled;this.eventsEnabled=enabled;let added=false;
      for(const event of list){
        const old=this.seen.has(event.id)||event.type==='pair'&&event.seq<=this.maxSeq;this.seen.add(event.id);if(event.type==='pair')this.maxSeq=Math.max(this.maxSeq,event.seq||0);
        if(enabled&&wasEnabled&&!old){this.eventQueue.push({...event,deadline:this.now+15000});added=true;}
      }
      while(this.seen.size>512)this.seen.delete(this.seen.values().next().value);
      if(!enabled)this.eventQueue=[];this.eventQueue=this.eventQueue.slice(-16);return added;
    }
    playEvents(now){
      for(let index=0;index<this.eventQueue.length;){
        const event=this.eventQueue[index],a=this.entities.get(event.from),b=this.entities.get(event.to);
        if(event.deadline<now||!a||['attention','unconnected'].includes(a.state)||event.type==='pair'&&(!b||['attention','unconnected'].includes(b.state))){this.eventQueue.splice(index,1);continue;}
        if(a.script?.layer==='reaction'||b?.script?.layer==='reaction'){index++;continue;}
        this.eventQueue.splice(index,1);
        if(event.type==='claim'){
          if(a.state!=='idle')continue;
          this.startScript(a.id,[{animate:event.round===1?'raise':'talk'},{bubble:'真实认领 · 第 '+event.round+' 轮：'+event.text},{wait:2400}]);a.eventId=event.id;
        }else{
          this.cancel(a);this.cancel(b);b.at=this.home(b);this.pose(b);
          const home=this.home(b),near=[[home[0]+1,home[1]],[home[0],home[1]+1],[home[0]-1,home[1]]].map(at=>({at,path:model.pathfind(this.scene,a.at,at,this.occupied(a.id))})).find(v=>v.path&&v.path.length<=25);
          const walk=this.features.walking&&near,eta=walk?Math.min(10000,near.path.length*340):0;
          const first=walk?[{walkTo:near.at}]:[];
          this.startScript(a.id,[...first,{face:'up'},{animate:'talk'},{bubble:'给 '+b.fact.member.name.slice(0,20)+'：'+event.text},{wait:2800},{bubble:''},...(walk?[{walkTo:this.home(a)}]:[])]);
          this.startScript(b.id,[{wait:eta},{face:'left'},{animate:'talk'},{bubble:a.fact.member.name.slice(0,20)+' 发来：'+event.text},{wait:2800}]);
          a.eventId=b.eventId=event.id;a.partner=b.id;b.partner=a.id;
        }
        this.playedEvents.push({id:event.id,type:event.type,from:event.from,to:event.to||null,round:event.round||null});this.playedEvents=this.playedEvents.slice(-64);
      }
    }
    ambient(e){
      if(!this.features.ambient||!this.features.walking||e.state!=='idle'||e.script)return false;
      if([...this.entities.values()].filter(v=>v.script?.layer==='ambient').length>=3){e.idleDue=this.now+2000;return false;}
      const choices=[];for(const furniture of this.scene.furniture)for(const offer of furniture.offers){
        const slots=furniture.slots.filter(s=>!this.occupied(e.id).has(model.cell(s.at)));
        if(offer.when==='idle'&&offer.weight>0&&slots.length)choices.push({offer,slots});
      }
      // A furniture type and its action name are data, never branches in the director.
      while(choices.length){
        const total=choices.reduce((sum,c)=>sum+c.offer.weight,0);let pick=this.random()*total,index=choices.length-1;
        for(let i=0;i<choices.length;i++){pick-=choices[i].offer.weight;if(pick<0){index=i;break;}}
        const {offer,slots}=choices.splice(index,1)[0],slot=slots.find(s=>model.pathfind(this.scene,e.at,s.at,this.occupied(e.id)));
        if(!slot)continue;
        if(this.startScript(e.id,[{walkTo:[...slot.at]},{face:slot.face},{animate:slot.anim},{bubble:offer.bubble||''},{wait:2500+Math.floor(this.random()*2500)},{bubble:''},{walkTo:this.home(e)}],'ambient')){e.reservation=model.cell(slot.at);this.reservations.set(e.reservation,e.id);return true;}
      }
      this.idleLater(e);return false;
    }
    nextWake(reduced=false){
      if(reduced||this.features.reduced_motion)return null;
      const entities=[...this.entities.values()],due=entities.filter(e=>e.script?.until>this.now).map(e=>e.script.until);
      if(this.features.ambient&&this.features.walking)due.push(...entities.filter(e=>e.state==='idle'&&!e.script).map(e=>e.idleDue));
      return due.length?Math.max(1,Math.min(60000,Math.min(...due)-this.now)):null;
    }
    advance(e,now,dt){
      const script=e.script;if(!script)return false;
      for(let guard=0;guard<40&&e.script;guard++){
        const instruction=script.steps[script.index];if(!instruction){this.cancel(e,false);this.pose(e);return true;}
        if(instruction.walkTo){
          if(!this.features.walking){e.at=[...instruction.walkTo];script.index++;continue;}
          if(!script.path){const path=model.pathfind(this.scene,e.at,instruction.walkTo,this.occupied(e.id));if(!path){this.cancel(e);this.pose(e);return true;}script.path=path.slice(1);script.target=null;}
          if(!script.path.length){script.path=null;script.target=null;script.index++;continue;}
          const target=script.path[0],occupied=this.occupied(e.id);
          if(occupied.has(model.cell(target))){this.cancel(e);this.pose(e);return true;}
          script.target=target;const dx=target[0]-e.at[0],dy=target[1]-e.at[1],distance=Math.hypot(dx,dy),travel=Math.min(distance,dt*.0035);e.face=Math.abs(dx)>Math.abs(dy)?dx>0?'right':'left':dy>0?'down':'up';e.anim='walk';
          if(distance<=travel+.001){e.at=[...target];script.path.shift();script.target=null;}else e.at=[e.at[0]+dx/distance*travel,e.at[1]+dy/distance*travel];return true;
        }
        if(instruction.face)e.face=instruction.face;if(instruction.animate)e.anim=instruction.animate;if(instruction.bubble!==undefined)e.bubble=instruction.bubble;
        if(instruction.wait!==undefined){const fresh=script.until===null;if(fresh)script.until=now+instruction.wait;if(now<script.until)return fresh;script.until=null;}
        script.index++;
      }
      return true;
    }
    step(now,reduced=false){
      const dt=this.lastStep===null?100:Math.max(0,Math.min(180,now-this.lastStep));this.lastStep=now;this.now=now;let moving=false;if(!reduced)this.playEvents(now);else this.eventQueue=[];
      for(const e of this.entities.values()){
        if(reduced){if(e.script){this.settle(e);moving=true;}const frame=e.state==='attention'?1:0;if(e.frame!==frame)moving=true;e.frame=frame;continue;}
        if(e.state==='idle'&&!e.script&&e.idleDue<=now)this.ambient(e);
        if(e.script)moving=this.advance(e,now,dt)||moving;
        const raising=e.state==='attention'&&now-e.raiseStarted<250,animated=e.state==='working'||e.script&&['walk','talk','type'].includes(e.anim),frame=e.anim==='raise'?(e.state==='attention'?Math.min(1,Math.floor(Math.max(0,now-e.raiseStarted)/150)):1):animated?Math.floor(now/100)%2:0;if(e.frame!==frame)moving=true;e.frame=frame;if(animated||raising)moving=true;
      }
      return moving;
    }
  }
  return {facts,events,profile,Director};
});
