'use strict';
// Original art, generated from grids like pixel-art.js. Runtime reads only the
// exported PNG layers and JSON frame table, never this drawing implementation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ACTIONS,DIRECTIONS}=require('./office-scene.js');
const IDS=['deepseek','doubao','claude','codex','grok','gemini','kimi','qwen','cursor','generic'];
const HAIR=['#263958','#5B383B','#78483A','#243245','#30343B','#4C4774','#283E45','#584879','#37484E','#4C4448'];
const ACCENTS=['#6EA0FF','#A7D7CD','#A59AC5','#C4D6EC','#9EC2B7'];
function frame(id,variant,layer,action,direction,index){
  const g=Array.from({length:40},()=>Array(40).fill(null)),profile=Math.max(0,IDS.indexOf(id)),up=direction==='up',side=direction==='left'||direction==='right',shift=action==='walk'?(index?1:0):0;
  const rect=(x,y,w,h,c)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)if(yy>=0&&yy<40&&xx>=0&&xx<40)g[yy][xx]=c;};
  if(layer==='body'){
    rect(14,4+shift,13,15,'#15181E');rect(15,5+shift,11,13,'#F3CFB6');rect(18,18+shift,5,3,'#E2AF91');
    if(!up){rect(side?16:16,10+shift,2,2,'#15181E');if(!side)rect(23,10+shift,2,2,'#15181E');rect(19,15+shift,3,action==='talk'&&index?2:1,'#8C534D');}
    rect(13,21+shift,15,11,'#293951');rect(14,21+shift,13,9,'#45597C');rect(19,22+shift,3,6,'#8A96BA');
    const seated=['sit','type'].includes(action),leg=action==='walk'?(index?2:-2):0;
    rect(15+leg,31,seated?5:4,seated?3:6,'#293951');rect(23-leg,31,seated?5:4,seated?3:6,'#293951');rect(14+leg,seated?34:37,6,2,'#15181E');rect(22-leg,seated?34:37,6,2,'#15181E');
    rect(10,22+shift,4,9,'#45597C');rect(27,22+shift,4,9,'#45597C');rect(10,30+shift,4,3,'#F3CFB6');rect(27,30+shift,4,3,'#F3CFB6');
    if(action==='type'){rect(10,26+index,7,3,'#F3CFB6');rect(24,27-index,7,3,'#F3CFB6');}
    if(action==='raise'){rect(28,13-index,4,13,'#45597C');rect(28,10-index,4,4,'#F3CFB6');}
  }else if(layer==='hair'){
    const c=HAIR[profile];rect(13,3+shift,15,5,c);rect(12,6+shift,4,10,c);rect(25,6+shift,4,10,c);rect(16,7+shift,4+(profile%3),2,c);if(up)rect(14,6+shift,13,12,c);rect(15,4+shift,7,1,'#8A96BA');
  }else{
    const c=ACCENTS[(profile+variant)%ACCENTS.length],shape=profile%5;
    if(shape===0){rect(12,5+shift,17,2,c);rect(12,7+shift,3,5,c);rect(27,7+shift,3,5,c);}
    if(shape===1){rect(13,9+shift,4,6,c);rect(25,9+shift,4,6,c);rect(15,2+shift,12,2,c);}
    if(shape===2){rect(12,4+shift,6,3,c);rect(14,7+shift,2,2,'#fffefa');}
    if(shape===3){rect(24,5+shift,5,2,c);rect(25,3+shift,2,6,c);}
    if(shape===4){rect(12,16+shift,17,3,c);rect(24,19+shift,3,6,c);}
  }
  let result=g;if(direction==='right')result=result.map(row=>row.slice().reverse());if(action==='lie')result=Array.from({length:40},(_,y)=>Array.from({length:40},(_,x)=>result[39-x][y]));return result;
}
function layout(layer){
  const columns=layer==='body'?8:4,positions=new Map(),actions={};
  for(const action of ACTIONS){actions[action]={};for(const direction of DIRECTIONS){actions[action][direction]=[];for(let i=0;i<2;i++){
    const key=layer==='body'?action+':'+direction+':'+i:direction+':'+(action==='walk'&&i===1?'step':action==='lie'?'lie':'still');
    if(!positions.has(key)){const n=positions.size;positions.set(key,{x:n%columns*40,y:Math.floor(n/columns)*40,width:40,height:40,action,direction,index:i});}const p=positions.get(key);actions[action][direction].push({x:p.x,y:p.y,width:40,height:40});
  }}}
  return {width:columns*40,height:Math.ceil(positions.size/columns)*40,positions:[...positions.values()],actions};
}
function sheet(id,variant,layer){const l=layout(layer),grid=Array.from({length:l.height},()=>Array(l.width).fill(null));for(const p of l.positions){const tile=frame(id,variant,layer,p.action,p.direction,p.index);for(let y=0;y<40;y++)for(let x=0;x<40;x++)grid[p.y+y][p.x+x]=tile[y][x];}return grid;}
function generateAtlas({png,dir}){
  const manifest={schema:'agentoffice.action-atlas.v1',frame:{width:40,height:40},sheet:{width:320,height:280},layers:['body','hair','accessory'],actions:{},characters:{},assets:{},license:'Original Agent Office code-drawn characters. No official product marks or mascots.'};let n=0;
  manifest.actions=layout('body').actions;manifest.layer_actions={body:manifest.actions,hair:layout('hair').actions,accessory:layout('accessory').actions};
  const write=(name,grid)=>{const bytes=png(grid,1);fs.writeFileSync(path.join(dir,name),bytes);manifest.assets[name]={bytes:bytes.length,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};return '/assets/office/'+name;};
  const body=write('atlas-body.png',sheet('generic',0,'body'));
  for(const id of IDS){const hair=write('atlas-hair-'+id+'.png',sheet(id,0,'hair')),accessories=[];for(let v=0;v<5;v++)accessories.push(write('atlas-accessory-'+id+'-'+v+'.png',sheet(id,v,'accessory')));manifest.characters[id]={body,hair,accessories};}
  fs.writeFileSync(path.join(dir,'action-atlas.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({sprites:Object.keys(manifest.assets).length,bytes:Object.values(manifest.assets).reduce((sum,a)=>sum+a.bytes,0)}));return manifest;
}
module.exports={frame,sheet,generateAtlas};
