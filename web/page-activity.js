'use strict';
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.AgentOfficePageActivity=factory();})(typeof window!=='undefined'?window:globalThis,()=>{
  // UI timers only. Native bridge deadlines and server work remain independent.
  function create({document,host=globalThis,onChange=()=>{},clock=host}){
    let hostVisible=true,active=document.hidden!==true,destroyed=false,sequence=0;
    const timers=new Map();
    const notify=()=>{const next=!destroyed&&hostVisible&&document.hidden!==true;if(next===active)return;active=next;
      for(const [id,entry]of timers){if(entry.native!==null)clock[entry.interval?'clearInterval':'clearTimeout'](entry.native);entry.native=null;if(!entry.interval)timers.delete(id);else if(active)arm(id,entry);}
      onChange(active);
    };
    function arm(id,entry){if(!active||destroyed)return;entry.native=clock[entry.interval?'setInterval':'setTimeout'](()=>{if(!entry.interval)timers.delete(id);if(active&&!destroyed)entry.callback(...entry.args);},entry.delay);}
    function add(interval,callback,delay,args){const id=++sequence;if(destroyed||!interval&&!active)return id;const entry={interval,callback,delay,args,native:null};timers.set(id,entry);arm(id,entry);return id;}
    const visibility=()=>notify(),nativeVisibility=event=>{if(typeof event.detail?.visible!=='boolean')return;hostVisible=event.detail.visible;notify();};
    document.addEventListener('visibilitychange',visibility);host.addEventListener('agentoffice-visibility',nativeVisibility);
    return Object.freeze({get active(){return active;},
      setTimeout:(callback,delay,...args)=>add(false,callback,delay,args),setInterval:(callback,delay,...args)=>add(true,callback,delay,args),
      clearTimeout(id){const entry=timers.get(id);if(!entry)return;if(entry.native!==null)clock[entry.interval?'clearInterval':'clearTimeout'](entry.native);timers.delete(id);},
      destroy(){if(destroyed)return;destroyed=true;notify();for(const entry of timers.values())if(entry.native!==null)clock[entry.interval?'clearInterval':'clearTimeout'](entry.native);timers.clear();document.removeEventListener('visibilitychange',visibility);host.removeEventListener('agentoffice-visibility',nativeVisibility);}
    });
  }
  return {create};
});
