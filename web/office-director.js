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
      else if(info.needsInput||approval){state='attention';note=approval?.questions?.[0]?.question||approval?.reason||request?.error||'请确认这一步后继续';label='等你';}
      else if(info.processing){state='working';note=info.activity?.text||'正在处理消息';label='工作中';}
      else if(info.waiting&&!m.delivery_capability?.can_wake){state='attention';note='请在 '+m.name+' 的窗口处理消息';label='等你';}
      else if(info.waiting)label='等待接手';
      return {id:m.id,member:m,profile:key,variant:variant%5,state,label,note:String(note).slice(0,220),message_id:request?.id||null};
    });
  }
  class Director{
    constructor(){this.reset();}
    reset(){this.entities=new Map();this.scene=null;this.features={};this.now=0;this.lastStep=null;}
    home(e){return [e.seat.at[0],e.seat.at[1]+1];}
    pose(e){e.anim=e.state==='working'?'type':e.state==='attention'?'raise':e.state==='unconnected'?null:'sit';e.face=e.seat.face;e.frame=0;}
    occupied(except){const cells=new Set();for(const e of this.entities.values())if(e.id!==except){cells.add(model.cell(e.at));if(e.script?.target)cells.add(model.cell(e.script.target));}return cells;}
    cancel(e){e.script=null;e.bubble='';}
    settle(e,walk=false){
      this.cancel(e);this.pose(e);const home=this.home(e);
      if(walk&&this.features.walking&&!this.features.reduced_motion&&e.state!=='unconnected'&&e.state!=='attention'&&model.cell(e.at)!==model.cell(home))this.startScript(e.id,[{walkTo:home}],'reaction');
      else e.at=home;
    }
    update(next,scene,features={}){
      const initial=this.scene===null;this.scene=scene;this.features=features;
      const ids=new Set(next.map(f=>f.id));for(const id of this.entities.keys())if(!ids.has(id))this.entities.delete(id);
      next.forEach((fact,index)=>{
        const seat=model.station(scene,fact.id,index),prior=this.entities.get(fact.id),seatChanged=prior&&model.cell(prior.seat.at)!==model.cell(seat.at),changed=prior&&prior.state!==fact.state;
        const e=prior||{id:fact.id,at:[seat.at[0],seat.at[1]+1],frame:0,script:null,bubble:''};e.fact=fact;e.seat=seat;e.state=fact.state;this.entities.set(fact.id,e);
        if(!prior){this.pose(e);if(!initial&&features.walking&&!features.reduced_motion&&e.state==='idle'){const entry=[1,1];if(!this.occupied(e.id).has(model.cell(entry)))e.at=entry;this.settle(e,true);}}
        else if(changed||seatChanged||!features.walking||features.reduced_motion)this.settle(e,changed||seatChanged);
      });return this.entities;
    }
    startScript(id,steps,layer='reaction'){
      const e=this.entities.get(id);if(!e||e.state==='unconnected'||layer==='ambient'&&e.state!=='idle'||!Array.isArray(steps)||steps.length>40)return false;
      if(steps.some(s=>!s||Object.keys(s).some(k=>!['walkTo','face','animate','bubble','wait'].includes(k))||s.walkTo&&(!Array.isArray(s.walkTo)||s.walkTo.length!==2||s.walkTo.some(v=>!Number.isInteger(v)))||s.face&&!model.DIRECTIONS.includes(s.face)||s.animate&&!model.ACTIONS.includes(s.animate)||s.wait!==undefined&&(!Number.isFinite(s.wait)||s.wait<0||s.wait>60000)||s.bubble!==undefined&&(typeof s.bubble!=='string'||s.bubble.length>140)))return false;
      this.cancel(e);e.script={steps:steps.map(s=>({...s})),index:0,layer,path:null,target:null,until:null};return true;
    }
    advance(e,now,dt){
      const script=e.script;if(!script)return false;
      for(let guard=0;guard<40&&e.script;guard++){
        const instruction=script.steps[script.index];if(!instruction){e.script=null;e.bubble='';this.pose(e);return true;}
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
        if(instruction.wait!==undefined){if(script.until===null)script.until=now+instruction.wait;if(now<script.until)return true;script.until=null;}
        script.index++;
      }
      return true;
    }
    step(now,reduced=false){
      const dt=this.lastStep===null?100:Math.max(0,Math.min(180,now-this.lastStep));this.lastStep=now;this.now=now;let moving=false;
      for(const e of this.entities.values()){
        if(reduced){if(e.script){this.settle(e);moving=true;}e.frame=0;continue;}
        if(e.script)moving=this.advance(e,now,dt)||moving;
        const animated=['working','attention'].includes(e.state)||e.script&&['walk','talk','type','raise'].includes(e.anim);e.frame=animated?Math.floor(now/100)%2:0;if(animated)moving=true;
      }
      return moving;
    }
  }
  return {facts,profile,Director};
});
