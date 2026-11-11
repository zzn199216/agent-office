(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.AgentOfficeModel=Object.freeze(api);})(typeof window==='object'?window:null,function(){
  'use strict';
  const ACTIONS=Object.freeze(['stand','walk','sit','type','talk','lie','raise']),DIRECTIONS=Object.freeze(['down','left','up','right']);
  const color=value=>typeof value==='string'&&/^#[a-f0-9]{6}$/i.test(value),point=(v,w,h)=>Array.isArray(v)&&v.length===2&&v.every(Number.isInteger)&&v[0]>=0&&v[0]<w&&v[1]>=0&&v[1]<h;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function defaultScene(memberIds=[]){
    const columns=Math.max(3,Math.min(14,Math.ceil(Math.sqrt(memberIds.length)))),rows=Math.ceil(memberIds.length/columns),width=Math.min(64,Math.max(24,columns*4+8)),height=Math.min(64,Math.max(18,rows*4+8)),stations={};
    memberIds.forEach((id,i)=>stations[id]={at:[3+i%columns*4,3+Math.floor(i/columns)*4],face:'down'});
    return {schema:1,revision:0,grid:[width,height],stations,furniture:[
      {id:'sofa',type:'sofa',label:'沙发',at:[width-6,height-6],footprint:[3,1],parts:[{at:[0,0,0],size:[3,1,.5],color:'#3A4668',top:'#8A96BA'},{at:[0,0,.5],size:[3,.25,.6],color:'#3A4668',top:'#687799'}],slots:[{at:[width-6,height-4],face:'down',anim:'sit'},{at:[width-5,height-4],face:'left',anim:'lie'}],offers:[{action:'rest',when:'idle',weight:3,bubble:'休息一下'}]},
      {id:'coffee',type:'coffee',label:'咖啡角',at:[width-5,4],footprint:[2,1],parts:[{at:[0,0,0],size:[2,1,.8],color:'#3A4668',top:'#8A96BA'},{at:[.3,.1,.8],size:[.7,.6,.6],color:'#15181E',top:'#5B6472'}],slots:[{at:[width-5,6],face:'up',anim:'stand'}],offers:[{action:'drink',when:'idle',weight:1,bubble:'喝杯咖啡'}]}
    ]};
  }
  function validateScene(value){
    const bad=()=>{throw new TypeError('场景数据无效：检查网格、工位、家具位置和动作。');};
    if(!value||value.schema!==1||!Array.isArray(value.grid)||value.grid.length!==2||value.grid.some(n=>!Number.isInteger(n)||n<8||n>64)||!Number.isInteger(value.revision)||value.revision<0)bad();
    const [w,h]=value.grid;if(!value.stations||typeof value.stations!=='object'||Array.isArray(value.stations)||Object.keys(value.stations).length>200||!Array.isArray(value.furniture)||value.furniture.length>80)bad();
    for(const [id,s]of Object.entries(value.stations)){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!s||!point(s.at,w,h)||!DIRECTIONS.includes(s.face)||s.at[0]+1>=w||s.at[1]+1>=h)bad();}
    const ids=new Set();for(const f of value.furniture){if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(f.id)||ids.has(f.id)||typeof f.type!=='string'||f.type.length>50||typeof f.label!=='string'||f.label.length>80||!point(f.at,w,h)||!Array.isArray(f.footprint)||f.footprint.length!==2||f.footprint.some(n=>!Number.isInteger(n)||n<1||n>6)||f.at[0]+f.footprint[0]>w||f.at[1]+f.footprint[1]>h)bad();ids.add(f.id);
      if(!Array.isArray(f.parts)||f.parts.length>20||!Array.isArray(f.slots)||f.slots.length>12||!Array.isArray(f.offers)||f.offers.length>12)bad();
      for(const p of f.parts){if(!p||!Array.isArray(p.at)||p.at.length!==3||p.at.some(n=>!Number.isFinite(n)||n<0||n>6)||!Array.isArray(p.size)||p.size.length!==3||p.size.some(n=>!Number.isFinite(n)||n<=0||n>6)||!color(p.color)||!color(p.top))bad();}
      for(const s of f.slots)if(!point(s.at,w,h)||!DIRECTIONS.includes(s.face)||!ACTIONS.includes(s.anim))bad();
      for(const o of f.offers)if(typeof o.action!=='string'||o.action.length>50||o.when!=='idle'||!Number.isFinite(o.weight)||o.weight<0||o.weight>100||o.bubble!==undefined&&(typeof o.bubble!=='string'||o.bubble.length>100))bad();
    }
    const result=clone(value);return {schema:1,revision:result.revision,grid:result.grid,stations:result.stations,furniture:result.furniture};
  }
  function station(scene,member,index=0){return scene.stations[member]||{at:[3+index%3*4,3+Math.floor(index/3)*4],face:'down'};}
  function project(x,y,z=0){return {x:(x-y)*18,y:(x+y)*9-z*18};}
  const cell=at=>Math.round(at[0])+','+Math.round(at[1]);
  function blocked(scene){
    const result=new Set();
    for(const s of Object.values(scene.stations))for(let x=0;x<2;x++)result.add(cell([s.at[0]+x,s.at[1]]));
    for(const f of scene.furniture)for(let x=0;x<f.footprint[0];x++)for(let y=0;y<f.footprint[1];y++)result.add(cell([f.at[0]+x,f.at[1]+y]));
    return result;
  }
  // Four-neighbour A*: bounded by the scene's 64x64 grid; no corner cutting.
  function pathfind(scene,from,to,occupied=new Set()){
    const [w,h]=scene.grid,start=from.map(Math.round),goal=to.map(Math.round);
    if(!point(start,w,h)||!point(goal,w,h))return null;
    const walls=blocked(scene),startKey=cell(start),goalKey=cell(goal);
    for(const key of occupied)walls.add(key);walls.delete(startKey);
    if(walls.has(goalKey))return null;
    const distance=at=>Math.abs(at[0]-goal[0])+Math.abs(at[1]-goal[1]),open=[{at:start,g:0,f:distance(start)}],cost=new Map([[startKey,0]]),parents=new Map(),closed=new Set();
    while(open.length){
      let best=0;for(let i=1;i<open.length;i++)if(open[i].f<open[best].f)best=i;
      const node=open.splice(best,1)[0],key=cell(node.at);if(closed.has(key))continue;closed.add(key);
      if(key===goalKey){const route=[goal];let cursor=key;while(cursor!==startKey){const previous=parents.get(cursor);route.push(previous);cursor=cell(previous);}return route.reverse();}
      for(const [dx,dy]of [[1,0],[0,1],[-1,0],[0,-1]]){const next=[node.at[0]+dx,node.at[1]+dy],nk=cell(next),g=node.g+1;if(!point(next,w,h)||walls.has(nk)||closed.has(nk)||g>=(cost.get(nk)??Infinity))continue;cost.set(nk,g);parents.set(nk,node.at);open.push({at:next,g,f:g+distance(next)});}
    }
    return null;
  }
  return {ACTIONS,DIRECTIONS,defaultScene,validateScene,station,project,cell,blocked,pathfind};
});
