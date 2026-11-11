(function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let rail=null,context=null,expanded=false;
  function install(){
    rail=document.createElement('aside');rail.id='work-rail';rail.className='work-rail';rail.setAttribute('aria-label','需要你与正在进行');
    rail.innerHTML='<button type="button" id="work-rail-close" class="text-button">关闭待办</button><section><h2>需要你 <span id="work-attention-count"></span></h2><div id="work-approvals"></div><div id="work-connections"></div><div id="work-other-attention"></div></section><section id="work-running-section"><h2>正在进行</h2><div id="work-running"></div></section>';
    document.querySelector('.shell').append(rail);
    rail.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;
      if(button.dataset.layoutMember){context.openMember(button.dataset.layoutMember);return;}
      if(button.dataset.layoutResume){context.openResume(button.dataset.layoutResume);return;}
      if(button.dataset.layoutMessage){document.getElementById('message-'+button.dataset.layoutMessage)?.scrollIntoView({block:'center',behavior:'smooth'});return;}
      if(button.dataset.approve||button.dataset.inputSubmit||button.dataset.formSubmit||button.dataset.reviewMember||button.dataset.approvalTask)context.onMessageClick(event);
    });
    rail.querySelector('#work-rail-close').onclick=()=>document.body.classList.remove('work-rail-open');
    const needs=document.createElement('button');needs.id='work-attention-toggle';needs.type='button';needs.className='secondary';needs.textContent='需要你';needs.onclick=()=>document.body.classList.toggle('work-rail-open');document.getElementById('group-controls').append(needs);
    const expand=document.createElement('button');expand.type='button';expand.id='work-office-expand';expand.className='text-button';expand.textContent='展开办公室';expand.onclick=()=>{expanded=!expanded;document.body.classList.toggle('work-office-expanded',expanded);expand.textContent=expanded?'收起办公室':'展开办公室';};document.getElementById('officeScene').before(expand);
    const roomSettings=document.createElement('button');roomSettings.type='button';roomSettings.id='work-room-settings';roomSettings.className='secondary';roomSettings.textContent='成员、连接与场景设置';roomSettings.onclick=()=>{document.getElementById('room-features-dialog')?.close();context.openSettings();};document.getElementById('room-features-dialog').append(roomSettings);
    const empty=document.createElement('button');empty.type='button';empty.id='work-empty-station';empty.className='work-empty-station';empty.innerHTML='<span aria-hidden="true">＋</span>接入一位 AI';empty.onclick=()=>context.addAI();document.getElementById('officeScene').append(empty);
  }
  function retainedApprovals(){return rail?[...rail.querySelectorAll('[data-approval]')]:[];}
  function update(value){
    context=value;const on=value.enabled===true;document.body.classList.toggle('work-layout',on);
    if(!on){document.body.classList.remove('has-work-rail','work-office-expanded','work-rail-open');for(const badge of document.querySelectorAll('.work-room-badge'))badge.remove();if(rail){for(const card of rail.querySelectorAll('[data-approval]')){if(value.approvalIds.includes(card.dataset.approval))document.getElementById('messages').append(card);else card.remove();}for(const card of rail.querySelectorAll('.approval-review-message'))card.remove();rail.hidden=true;}return;}
    if(!rail)install();document.body.classList.toggle('work-office-expanded',expanded);
    const name=id=>value.members.find(m=>m.id===id)?.name||'成员',approvalHost=rail.querySelector('#work-approvals'),active=document.activeElement;
    const approvals=[...document.querySelectorAll('#messages .approval-message,#messages .approval-review-message[data-review-active="1"]')];
    for(const card of approvals){const key=card.dataset.approval||card.dataset.approvalReview;for(const old of [...approvalHost.children])if(old!==card&&(old.dataset.approval||old.dataset.approvalReview)===key)old.remove();card.dataset.layoutMoved='1';approvalHost.append(card);}
    for(const card of [...approvalHost.children]){const key=card.dataset.approval||card.dataset.approvalReview;if(!value.approvalIds.includes(key))card.remove();}
    if(active&&approvalHost.contains(active))active.focus({preventScroll:true});
    const connectionMarkup=value.connections.map(item=>'<article class="work-attention-card"><h3>'+esc(item.name)+'</h3>'+item.markup+'</article>').join('');
    const connections=rail.querySelector('#work-connections');if(connections.dataset.signature!==connectionMarkup){connections.innerHTML=connectionMarkup;connections.dataset.signature=connectionMarkup;}
    const manual=value.messages.filter(m=>m.to_member_id&&['queued','delivered','consumed'].includes(m.status)&&!['reply','acknowledgment'].includes(m.kind)&&!value.members.find(x=>x.id===m.to_member_id)?.delivery_capability?.can_wake);
    const uncertain=value.history.group?.routes.filter(r=>r.status==='needs_user')||[];
    rail.querySelector('#work-other-attention').innerHTML=manual.map(m=>'<article class="work-attention-card"><h3>'+esc(name(m.to_member_id))+' 需要在窗口中处理</h3><p>'+esc(m.text.slice(0,140))+'</p><button type="button" data-layout-resume="'+esc(m.to_member_id)+'">查看这位成员的进入方式</button></article>').join('')+uncertain.map(r=>'<article class="work-attention-card"><h3>选择下一步</h3><p>'+esc(r.reason)+'</p><button type="button" data-layout-message="'+esc(r.message_id)+'">查看任务单</button></article>').join('');
    const running=value.messages.filter(m=>m.to_member_id&&['queued','processing','consumed'].includes(m.status)&&!['reply','acknowledgment'].includes(m.kind)&&!manual.some(v=>v.id===m.id));
    rail.querySelector('#work-running').innerHTML=running.map(m=>'<article class="work-progress-card"><strong>'+esc(name(m.to_member_id))+'</strong><p>'+esc(m.progress||m.text.slice(0,100))+'</p><button type="button" data-layout-message="'+esc(value.history.group?.work?.find(w=>w.message_id===m.id)?.origin_id||m.id)+'">查看任务</button></article>').join('');
    rail.querySelector('#work-running-section').hidden=!running.length;
    const count=approvalHost.children.length+value.connections.length+manual.length+uncertain.length;rail.querySelector('#work-attention-count').textContent=count||'';
    document.getElementById('work-attention-toggle').textContent=count?'需要你 '+count:'正在进行 '+running.length;
    rail.hidden=!count&&!running.length;document.body.classList.toggle('has-work-rail',!rail.hidden);
    const roomButton=document.querySelector('#rooms [data-room="'+CSS.escape(value.roomId)+'"]');if(roomButton){let badge=roomButton.querySelector('.work-room-badge');if(count){if(!badge){badge=document.createElement('b');badge.className='work-room-badge';roomButton.append(badge);}badge.textContent=String(count);badge.setAttribute('aria-label',count+' 项需要你');}else badge?.remove();}
  }
  function focusAttention(messageId){if(!context?.enabled||!rail)return false;const member=context.messages.find(m=>m.id===messageId)?.to_member_id,card=[...rail.querySelectorAll('[data-approval]')].find(c=>c.querySelector('[data-open-member]')?.dataset.openMember===member),target=card?.querySelector('input,textarea,button')||[...rail.querySelectorAll('[data-layout-resume]')].find(b=>b.dataset.layoutResume===member);if(!target)return false;document.body.classList.add('work-rail-open');target.scrollIntoView({block:'nearest'});target.focus();return true;}
  window.AgentOfficeLayout={update,retainedApprovals,focusAttention};
})();
