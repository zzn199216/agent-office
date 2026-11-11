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
    constructor(){this.entities=new Map();this.scene=null;this.features={};}
    update(next,scene,features={},now=Date.now()){
      this.scene=scene;this.features=features;const ids=new Set(next.map(f=>f.id));for(const id of this.entities.keys())if(!ids.has(id))this.entities.delete(id);
      next.forEach((fact,index)=>{const seat=model.station(scene,fact.id,index),prior=this.entities.get(fact.id),entity=prior||{id:fact.id,at:[seat.at[0],seat.at[1]+1],frame:0};entity.fact=fact;entity.seat=seat;entity.state=fact.state;entity.anim=fact.state==='working'?'type':fact.state==='attention'?'raise':fact.state==='unconnected'?null:'sit';entity.face=seat.face;entity.at=[seat.at[0],seat.at[1]+1];this.entities.set(fact.id,entity);});return this.entities;
    }
    step(now,reduced=false){let moving=false;for(const e of this.entities.values()){e.frame=!reduced&&['working','attention'].includes(e.state)?Math.floor(now/100)%2:0;if(!reduced&&['working','attention'].includes(e.state))moving=true;}return moving;}
  }
  return {facts,profile,Director};
});
