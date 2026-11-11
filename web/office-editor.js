(function(root){
  'use strict';
  const model=root.AgentOfficeModel,copy=value=>JSON.parse(JSON.stringify(value));
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const poses={stand:'站立',sit:'坐下',talk:'说话',lie:'躺下',raise:'举手',type:'打字',walk:'走动'},faces={down:'向下',left:'向左',up:'向上',right:'向右'};
  let opened=null;
  async function open(options){
    if(opened?.open){opened.focus();return;}
    const initial=await options.api('/api/office/scene?room_id='+encodeURIComponent(options.roomId));if(opened?.open||options.isCurrent&&!options.isCurrent())return;
    let draft=model.validateScene(initial),selected=Object.keys(draft.stations)[0]?'s:'+Object.keys(draft.stations)[0]:draft.furniture[0]?'f:'+draft.furniture[0].id:'',busy=false;
    const dialog=document.createElement('dialog');dialog.id='office-scene-editor';dialog.className='office-editor';dialog.setAttribute('aria-labelledby','office-editor-title');opened=dialog;
    dialog.innerHTML='<div class="dialog-heading"><h2 id="office-editor-title">布置办公室</h2><button type="button" data-editor-close aria-label="关闭布局编辑">×</button></div><p>选择物件，再点空白处移动。也可用位置输入框或方向键微调。保存后生效。</p><div class="office-editor-palette">'+Object.entries(model.FURNITURE).map(([key,p])=>'<button type="button" data-editor-add="'+key+'">＋ '+esc(p.label)+'</button>').join('')+'</div><div class="office-editor-body"><div><canvas id="office-editor-map" width="640" height="480" tabindex="0" role="img" aria-label="办公室布局图；方向键移动选中物件"></canvas><p class="office-editor-legend">蓝色：工位　灰色：家具　描边：选中　空心点：家具座位</p></div><div><label>选择物件<select id="office-editor-selection"></select></label><div id="office-editor-fields"></div><div class="office-editor-size"><label>办公室宽度<input id="office-editor-width" type="number" min="8" max="64"></label><label>办公室深度<input id="office-editor-height" type="number" min="8" max="64"></label></div></div></div><p id="office-editor-result" role="status" aria-live="polite"></p><div class="dialog-actions"><button type="button" data-editor-close>取消</button><button type="button" class="primary" id="office-editor-save">保存布局</button></div>';
    document.body.append(dialog);const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d'),selection=dialog.querySelector('#office-editor-selection'),fields=dialog.querySelector('#office-editor-fields'),result=dialog.querySelector('#office-editor-result'),save=dialog.querySelector('#office-editor-save');
    const name=id=>options.members.find(m=>m.id===id)?.name||'成员',item=()=>selected.startsWith('s:')?draft.stations[selected.slice(2)]:draft.furniture.find(f=>f.id===selected.slice(2)),isStation=()=>selected.startsWith('s:');
    function message(text,error=false){result.textContent=text;result.classList.toggle('error-note',error);}
    function list(){selection.innerHTML='<optgroup label="工位">'+Object.keys(draft.stations).map(id=>'<option value="s:'+esc(id)+'">'+esc(name(id))+'</option>').join('')+'</optgroup><optgroup label="家具">'+draft.furniture.map(f=>'<option value="f:'+esc(f.id)+'">'+esc(f.label)+'</option>').join('')+'</optgroup>';selection.value=selected;}
    function map(){
      const [w,h]=draft.grid,s=Math.min((canvas.width-32)/w,(canvas.height-32)/h),ox=(canvas.width-w*s)/2,oy=(canvas.height-h*s)/2;
      ctx.fillStyle='#EEF0F4';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#CED5E1';ctx.lineWidth=1;
      for(let x=0;x<=w;x++){ctx.beginPath();ctx.moveTo(ox+x*s,oy);ctx.lineTo(ox+x*s,oy+h*s);ctx.stroke();}for(let y=0;y<=h;y++){ctx.beginPath();ctx.moveTo(ox,oy+y*s);ctx.lineTo(ox+w*s,oy+y*s);ctx.stroke();}
      const box=(at,size,label,active,color)=>{ctx.fillStyle=color;ctx.fillRect(ox+at[0]*s+1,oy+at[1]*s+1,size[0]*s-2,size[1]*s-2);if(active){ctx.strokeStyle='#15181E';ctx.lineWidth=3;ctx.strokeRect(ox+at[0]*s,oy+at[1]*s,size[0]*s,size[1]*s);}ctx.fillStyle='#15181E';ctx.font='12px system-ui';ctx.fillText(label.slice(0,12),ox+at[0]*s+3,Math.max(12,oy+at[1]*s-4));};
      for(const [id,station]of Object.entries(draft.stations))box(station.at,[2,2],name(id),selected==='s:'+id,'#9CB9F5');
      for(const f of draft.furniture){box(f.at,f.footprint,f.label,selected==='f:'+f.id,'#8A96BA');for(const slot of f.slots){ctx.strokeStyle='#3A4668';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ox+(slot.at[0]+.5)*s,oy+(slot.at[1]+.5)*s,Math.max(2,s*.22),0,Math.PI*2);ctx.stroke();}}
      ctx.fillStyle='#2F5FD0';ctx.fillText('入口',ox,oy+s);return {s,ox,oy};
    }
    const selectHTML=(values,value,attribute)=>'<select '+attribute+'>'+Object.entries(values).map(([id,label])=>'<option value="'+id+'"'+(value===id?' selected':'')+'>'+label+'</option>').join('')+'</select>';
    function panel(){
      const value=item();fields.innerHTML=value?(!isStation()?'<label>名称<input data-editor-label maxlength="80" value="'+esc(value.label)+'"></label>':'')+'<div class="office-editor-position"><label>第几列<input data-editor-x type="number" min="0" max="63" value="'+value.at[0]+'"></label><label>第几行<input data-editor-y type="number" min="0" max="63" value="'+value.at[1]+'"></label></div>'+(isStation()?'<label>朝向'+selectHTML(faces,value.face,'data-editor-face')+'</label>':value.slots.map((s,i)=>'<fieldset><legend>座位 '+(i+1)+'</legend><label>姿势'+selectHTML(poses,s.anim,'data-editor-slot="'+i+'" data-slot-field="anim"')+'</label><label>朝向'+selectHTML(faces,s.face,'data-editor-slot="'+i+'" data-slot-field="face"')+'</label></fieldset>').join('')+(value.offers[0]?'<label>空闲使用频率（0 为停用）<input data-editor-weight type="number" min="0" max="100" value="'+value.offers[0].weight+'"></label><label>空闲活动提示<input data-editor-bubble maxlength="100" value="'+esc(value.offers[0].bubble||'')+'"></label>':'<p>这件家具只作布置。</p>')+'<button type="button" data-editor-remove>移除这件家具</button>'):'<p>先添加一件家具。</p>';
      dialog.querySelector('#office-editor-width').value=draft.grid[0];dialog.querySelector('#office-editor-height').value=draft.grid[1];map();
    }
    function move(at){
      const value=item();if(!value||busy)return;const candidate=copy(draft),target=isStation()?candidate.stations[selected.slice(2)]:candidate.furniture.find(f=>f.id===selected.slice(2)),delta=at.map((n,i)=>n-target.at[i]);target.at=at;
      if(!isStation())for(const slot of target.slots)slot.at=slot.at.map((n,i)=>n+delta[i]);
      try{draft=model.validatePlacement(candidate);message('位置已调整，保存后生效。');}catch(error){message(error.message,true);}panel();
    }
    selection.onchange=()=>{selected=selection.value;panel();};
    canvas.onclick=event=>{if(busy)return;const {s,ox,oy}=map(),rect=canvas.getBoundingClientRect(),x=Math.floor(((event.clientX-rect.left)*canvas.width/rect.width-ox)/s),y=Math.floor(((event.clientY-rect.top)*canvas.height/rect.height-oy)/s);if(x<0||y<0||x>=draft.grid[0]||y>=draft.grid[1])return;
      const contains=(at,size)=>x>=at[0]&&x<at[0]+size[0]&&y>=at[1]&&y<at[1]+size[1],station=Object.entries(draft.stations).find(([,v])=>contains(v.at,[2,2])),f=draft.furniture.find(v=>contains(v.at,v.footprint));if(station||f){selected=station?'s:'+station[0]:'f:'+f.id;list();panel();}else move([x,y]);};
    canvas.onkeydown=event=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key],value=item();if(delta&&value){event.preventDefault();move(value.at.map((n,i)=>n+delta[i]));}};
    dialog.onchange=event=>{
      const el=event.target,value=item();if(el===selection||busy)return;
      if(el.matches('[data-editor-x],[data-editor-y]'))return move([Number(fields.querySelector('[data-editor-x]').value),Number(fields.querySelector('[data-editor-y]').value)]);
      if(el.matches('[data-editor-label]')){value.label=el.value;list();map();}
      if(el.matches('[data-editor-face]'))value.face=el.value;
      if(el.matches('[data-editor-slot]'))value.slots[Number(el.dataset.editorSlot)][el.dataset.slotField]=el.value;
      if(el.matches('[data-editor-weight]'))value.offers[0].weight=Number(el.value);
      if(el.matches('[data-editor-bubble]'))value.offers[0].bubble=el.value;
      if(el.matches('#office-editor-width,#office-editor-height')){const candidate=copy(draft);candidate.grid=[Number(dialog.querySelector('#office-editor-width').value),Number(dialog.querySelector('#office-editor-height').value)];try{draft=model.validatePlacement(candidate);message('办公室大小已调整。');}catch(error){message(error.message,true);}panel();}
    };
    dialog.onclick=event=>{
      if(event.target.closest('[data-editor-close]')){if(!busy)dialog.close();return;}
      const add=event.target.closest('[data-editor-add]');if(add&&!busy){
        const id='furniture-'+crypto.randomUUID();let added=false;
        for(let y=2;y<draft.grid[1]-3&&!added;y++)for(let x=1;x<draft.grid[0]-3;x++){const candidate=copy(draft);candidate.furniture.push(model.furniture(add.dataset.editorAdd,id,[x,y]));try{draft=model.validatePlacement(candidate);selected='f:'+id;added=true;break;}catch{}}
        message(added?'家具已加入，保存后生效。':'空位不足，请先调整办公室大小。',!added);list();panel();return;
      }
      if(event.target.closest('[data-editor-remove]')&&!busy&&!isStation()){draft.furniture=draft.furniture.filter(f=>f.id!==selected.slice(2));selected=Object.keys(draft.stations)[0]?'s:'+Object.keys(draft.stations)[0]:draft.furniture[0]?'f:'+draft.furniture[0].id:'';list();panel();message('已从本次布局移除，保存后生效。');}
    };
    save.onclick=async()=>{
      if(busy)return;try{draft=model.validatePlacement(draft);}catch(error){message(error.message,true);return;}
      busy=true;save.disabled=true;message('正在保存布局…');
      try{await options.api('/api/office/scene',{room_id:options.roomId,expected_revision:initial.revision,scene:draft});await options.onSaved?.();dialog.close();}
      catch(error){message(error.code==='scene_revision_conflict'?'另一处已保存新布局。本次修改仍在这里；取消并重新打开可读取最新布局。':error.message,true);}
      finally{busy=false;save.disabled=false;}
    };
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',()=>{canvas.width=canvas.height=1;dialog.remove();if(opened===dialog)opened=null;},{once:true});list();panel();dialog.showModal();
  }
  root.AgentOfficeEditor=Object.freeze({open});
})(window);
