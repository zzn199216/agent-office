'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}
const plain=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(){
  const elements=new Map(),calls=[],members=[{id:'agent',name:'Alice <script>',adapter:'qwen-desktop',appearance:{color:'blue'}}],messages=[{id:'task',request_id:'native-request',sender_id:'user',to_member_id:'agent',text:'**Review** <unsafe> task'}],notices=[];
  const $=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',value:'',options:[],querySelectorAll:()=>[],classList:{toggle(){}},focus(){this.focused=true;}});return elements.get(id);};
  const context=vm.createContext({$,state:{approvals:[],approval_reviews:[],chat:{members}},history:{room:{id:'room'},participants:members,messages,approvals:[]},webConnected:true,roomId:'room',legacyId:null,lastApprovalSignature:'',approvalResponding:new Set(),document:{activeElement:null,body:{classList:{contains:()=>false}}},
    time:value=>String(value||''),avatar:(name,adapter,appearance,id)=>`<span data-avatar="${id||''}">${String(name).replaceAll('<','&lt;')}</span>`,memberById:id=>members.find(member=>member.id===id),updateOfficeApprovalAlert(){},
    api:async(route,body)=>{calls.push({route,body});return{};},refresh:async()=>{},action:async callback=>callback(),toast:value=>notices.push(value),openInspector(){},updateRecipientNote(){},setReply:message=>{context.replyTo=message;}
  });
  vm.runInContext(section('const escape =','const time =')+section('function renderTyping(', '// One-line previews')+section('function plainMarkdown(', 'function inlineMarkdown(')+section('function approvalSessionAllowed(', 'function showProject()')+
    section('function onboardingApprovalMarkup(', 'function tickOnboardingElapsed(')+section("$('messages').onclick =", "document.addEventListener('click', event => { if (event.target.closest('#cleanup-stale-members'))"),context);
  return{context,$,calls,members,messages,notices};
}
function approval(overrides={}){return{id:'approval/one',request_id:'task',member_id:'agent',room_id:'room',created:'2026-10-15T00:00:00Z',type:'command',command:'echo <unsafe>',reason:'Need <permission>',...overrides};}
function button(dataset,inputs=[]){return{dataset,disabled:false,closest:()=>({querySelectorAll:()=>inputs}),hasAttribute:name=>name==='data-open-team'&&false};}
function questionGroup(id,labels,value=''){
  const group={dataset:{approvalQuestion:id}},input={dataset:{question:id},value,closest:()=>group},choices=labels.map(label=>{
    const attributes={'aria-pressed':'false'},classes=new Set(['secondary']);return{dataset:{questionChoice:id,choiceValue:label},disabled:false,attributes,classes,closest:()=>group,setAttribute:(key,value)=>attributes[key]=value,classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}}};
  });
  group.querySelectorAll=selector=>selector==='[data-question]'?[input]:selector==='[data-question-choice]'?choices:[];return{group,input,choices};
}
test('session permission appears only for the exact advertised boolean on operation approvals',()=>{
  const f=fixture();for(const value of[undefined,false,1,'true'])assert.doesNotMatch(f.context.approvalContentMarkup(approval({session_allowed:value})),/acceptForSession|本会话允许/);
  const html=f.context.approvalContentMarkup(approval({session_allowed:true}));assert.match(html,/data-decision="acceptForSession"/);assert.match(html,/本会话允许此操作/);assert.match(html,/data-decision="accept"/);assert.match(html,/data-decision="decline"/);
  for(const type of['input','form','url'])assert.doesNotMatch(f.context.approvalContentMarkup(approval({type,session_allowed:true})),/acceptForSession|本会话允许/);
});
test('onboarding and legacy retain real approval IDs, one-time permission, and supported session action',()=>{
  const f=fixture(),a=approval({request_id:'connect:agent',session_allowed:true});f.context.state.approvals=[a];
  const html=f.context.onboardingApprovalMarkup({member_id:'agent',name:'Alice'});assert.match(html,/data-onboarding-approve="approval\/one" data-decision="acceptForSession"/);assert.match(html,/data-onboarding-approve="approval\/one" data-decision="accept"/);
  f.context.legacyId='legacy';f.context.renderApprovals([a]);assert.match(f.$('approval-panel').innerHTML,/data-approval="approval\/one"/);assert.match(f.$('approval-panel').innerHTML,/acceptForSession/);
});
test('room approvals use canonical pending IDs, isolate other rooms and reject unrelated unscoped tasks',()=>{
  const f=fixture(),a=approval();f.context.history.approvals=[approval({id:'obsolete'})];
  f.context.state.approvals=[a,{...a},approval({id:'other-room',room_id:'other'}),approval({id:'unrelated',room_id:null,request_id:'foreign-task'}),approval({id:'legacy-task',room_id:null,request_id:'native-request'})];
  assert.deepEqual(plain(f.context.roomApprovals(f.messages)).map(item=>item.id),['approval/one','legacy-task']);
  f.context.state.approvals=[];assert.equal(f.context.roomApprovals(f.messages).length,0,'canonical resolution removes an old history snapshot card');
});
test('tail approval cards show the actual member, real task, and escaped operation reason exactly once',()=>{
  const f=fixture(),a=approval({session_allowed:true});const html=f.context.approvalTimelineMarkup([a,a],f.messages);
  assert.equal((html.match(/data-approval="approval\/one"/g)||[]).length,1);assert.match(html,/class="chat-message approval-message"/);assert.match(html,/data-avatar="agent"/);assert.match(html,/Alice &lt;script&gt;/);assert.match(html,/data-open-member="agent"/);assert.match(html,/当前任务/);assert.match(html,/Review &lt;unsafe&gt; task/);assert.match(html,/data-approval-task="task"/);assert.match(html,/Need &lt;permission&gt;/);assert.doesNotMatch(html,/<unsafe>|<script>/);
});
test('raw commands are escaped inside closed operation details while reasons, questions and choices stay visible',()=>{
  const f=fixture(),a=approval({session_allowed:true,type:'input',questions:[{id:'q',question:'Which safe alternative?'}]}),approvalHtml=f.context.approvalContentMarkup(a),reviewHtml=f.context.renderApprovalReviewMessage({...a,status:'denied'},f.messages);
  for(const html of[approvalHtml,reviewHtml]){
    assert.match(html,/<details class="approval-operation"><summary>查看具体操作<\/summary><pre>echo &lt;unsafe&gt;<\/pre><\/details>/);
    assert.doesNotMatch(html,/<details[^>]*\bopen\b/);assert.match(html,/Need &lt;permission&gt;/);
    assert.doesNotMatch(html.replace(/<details[\s\S]*?<\/details>/g,''),/echo &lt;unsafe&gt;/);
  }
  assert.match(approvalHtml.replace(/<details[\s\S]*?<\/details>/g,''),/Which safe alternative\?[\s\S]*提交回答/);assert.match(reviewHtml.replace(/<details[\s\S]*?<\/details>/g,''),/补充要求/);
});
test('a real approval suppresses only its matching member and request waiting bubble',()=>{
  const f=fixture(),a=approval();f.messages[0].status='waiting_input';f.context.state.approvals=[a];
  assert.equal(f.context.renderTyping(f.messages),'');
  f.context.state.approvals=[{...a,request_id:'native-request'}];assert.equal(f.context.renderTyping(f.messages),'','native request alias identifies the same task');
  for(const change of[{member_id:'someone-else'},{request_id:'different-task'},{room_id:'other-room'}]){
    f.context.state.approvals=[{...a,...change}];assert.match(f.context.renderTyping(f.messages),/data-typing-member="agent"/);
  }
  f.context.state.approvals=[];f.context.history.approvals=[a];assert.match(f.context.renderTyping(f.messages),/确认状态待核对/,'resolved canonical approval must not hide an unresolved waiting status');
});
test('hiding a duplicate waiting bubble still shows other processing tasks and other members',()=>{
  const f=fixture();f.context.state.approvals=[approval()];f.messages[0].status='waiting_input';f.members.push({id:'other',name:'Bob'});
  const messages=[...f.messages,{id:'another-agent-task',sender_id:'user',to_member_id:'other',status:'running'},{id:'another-task',sender_id:'user',to_member_id:'agent',status:'processing'}];
  f.context.state.chat.activeMessages=['another-agent-task','another-task'];const html=f.context.renderTyping(messages);
  assert.match(html,/data-typing-member="other"/);assert.match(html,/data-typing-member="agent"/);assert.equal((html.match(/正在思考/g)||[]).length,2);assert.doesNotMatch(html,/在等你确认/);
});
test('normal room cards are appended after chat and typing, clear the legacy top panel and preserve old-history scroll',()=>{
  const f=fixture(),a=approval();f.context.state.approvals=[a];f.context.state.chat.activeMessages=[];f.context.history.room.title='Room';f.members[0].verified_at='yes';f.context.history.messages=f.messages;
  Object.assign(f.context,{renderImageDrafts(){},admittedMembers:members=>members,renderMemberChips(){},roomRecipients:new Map(),currentSecretary:()=>({member_id:null}),recipientRoom:null,renderTyping:()=>'<div>typing</div>',renderMessage:()=>'<article>original chat</article>',lastTimeline:'["room",old]',textScroll:new Map(),officeView:false,rememberTextScroll(){},renderService(){},renderInspector(){},renderSidebar(){},applyRoomView(){},updateOfficeScene(){}});
  const stream=f.$('chat-stream');Object.assign(stream,{scrollTop:120,scrollHeight:3000,clientHeight:500});for(const id of['native-thread','composer','legacy-note','room-members-bar','empty-room','empty-add-member','suggestions'])f.$(id).classList={toggle(){},remove(){},add(){}};
  f.$('approval-panel').innerHTML='obsolete top card';vm.runInContext(section('function renderRoom(', 'function renderMessage('),f.context);f.context.renderRoom({name:'Project'});
  const html=f.$('messages').innerHTML;assert.ok(html.indexOf('original chat')<html.indexOf('typing'));assert.ok(html.indexOf('typing')<html.indexOf('approval-message'));assert.equal(f.$('approval-panel').innerHTML,'');assert.equal(stream.scrollTop,120,'new approvals do not scroll a reader away from older messages');
  f.context.state.approvals=[];f.context.renderRoom({name:'Project'});assert.doesNotMatch(f.$('messages').innerHTML,/approval-message/);
});
test('a pending decision sends one exact native payload across duplicate UI locations, with no rule',async()=>{
  const f=fixture(),gate=deferred(),a=approval({session_allowed:true});f.context.state.approvals=[a];f.context.api=async(route,body)=>{f.calls.push({route,body});return gate.promise;};
  const first=button({approve:a.id,decision:'acceptForSession'}),second=button({onboardingApprove:a.id,decision:'decline'}),pending=f.context.respondToApproval(first);await f.context.respondToApproval(second);
  assert.equal(f.calls.length,1);assert.equal(first.disabled,true);assert.deepEqual(plain(f.calls[0]),{route:'/api/approvals/approval%2Fone',body:{decision:'acceptForSession'}});gate.resolve({});await pending;assert.equal(first.disabled,false);assert.equal(f.context.approvalResponding.size,0);
});
test('a failed request restores the button and can be retried explicitly; stale capability is rejected locally',async()=>{
  const f=fixture(),a=approval({session_allowed:false});f.context.history.approvals=[{...a,session_allowed:true}];f.context.state.approvals=[a];
  const session=button({approve:a.id,decision:'acceptForSession'});await assert.rejects(f.context.respondToApproval(session),/未提供本会话授权/);assert.equal(f.calls.length,0);assert.equal(session.disabled,false);
  const once=button({approve:a.id,decision:'accept'});f.context.api=async()=>{throw Error('offline');};await assert.rejects(f.context.respondToApproval(once),/offline/);assert.equal(once.disabled,false);assert.equal(f.context.approvalResponding.size,0);
  f.context.api=async(route,body)=>{f.calls.push({route,body});};await f.context.respondToApproval(once);assert.deepEqual(plain(f.calls[0].body),{decision:'accept'});
});
test('input and form submissions retain their existing payloads without a session decision',async()=>{
  const f=fixture();await f.context.respondToApproval(button({inputSubmit:'input'},[{dataset:{question:'q'},value:'answer'}]));
  await f.context.respondToApproval(button({formSubmit:'form'},[{dataset:{formField:'flag',fieldType:'boolean'},checked:true},{dataset:{formField:'items',fieldType:'array'},value:'a, b,, '},{dataset:{formField:'token',fieldType:'string'},value:'private'}]));
  assert.deepEqual(plain(f.calls.map(call=>call.body)),[{answers:{q:'answer'}},{content:{flag:true,items:['a','b'],token:'private'}}]);
});
test('native input suggestions render selectable labels and descriptions with one custom answer field per question',()=>{
  const f=fixture(),html=f.context.approvalContentMarkup(approval({type:'input',session_allowed:true,questions:[{id:'risk/"one"',header:'Next step',question:'Choose a <safe> action',options:[{label:'Read only',description:'Inspect <project> files'},{label:'Stop',description:'Leave the task unchanged'}]},{id:'other:id',question:'Extra context'}]}));
  assert.match(html,/data-question-choice="risk\/&quot;one&quot;" data-choice-value="Read only" aria-pressed="false"/);assert.match(html,/Inspect &lt;project&gt; files/);assert.match(html,/Leave the task unchanged/);assert.match(html,/Choose a &lt;safe&gt; action/);
  assert.equal((html.match(/<input data-question="risk\/&quot;one&quot;"/g)||[]).length,1);assert.equal((html.match(/<input data-question="other:id"/g)||[]).length,1);assert.match(html,/回答（也可自定义）/);assert.match(html,/提交回答/);assert.doesNotMatch(html,/data-decision|acceptForSession|<safe>|<project>/);
});
test('choosing a native suggestion only fills its question; custom edits and submission keep the answers protocol',async()=>{
  const f=fixture(),first=questionGroup('risk/"one"',['Read only','Stop']),other=questionGroup('other:id',['Later'],'untouched');
  f.context.selectApprovalQuestionChoice(first.choices[0]);assert.equal(first.input.value,'Read only');assert.equal(first.choices[0].attributes['aria-pressed'],'true');assert.equal(first.choices[0].classes.has('primary'),true);assert.equal(other.input.value,'untouched');assert.equal(f.calls.length,0);
  await f.context.respondToApproval(first.choices[0]);assert.equal(f.calls.length,0,'an option never becomes an approval decision or submits by itself');
  f.context.selectApprovalQuestionChoice(first.choices[1]);assert.equal(first.input.value,'Stop');assert.equal(first.choices[0].attributes['aria-pressed'],'false');assert.equal(first.choices[1].attributes['aria-pressed'],'true');
  first.input.value='Inspect a smaller scope instead';f.context.syncApprovalQuestionChoices(first.input);assert.ok(first.choices.every(choice=>choice.attributes['aria-pressed']==='false'));assert.equal(other.input.value,'untouched');assert.equal(f.calls.length,0);
  await f.context.respondToApproval(button({inputSubmit:'native/questions'},[first.input,other.input]));assert.deepEqual(plain(f.calls),[{route:'/api/approvals/native%2Fquestions',body:{answers:{'risk/"one"':'Inspect a smaller scope instead','other:id':'untouched'}}}]);
});
test('delegated option click and custom input handlers are local and disabled choices do nothing',()=>{
  const f=fixture(),listeners=new Map(),q=questionGroup('question',['Safe choice']);f.context.document.addEventListener=(type,handler)=>listeners.set(type,handler);
  vm.runInContext(section("document.addEventListener('click',event=>{const button=event.target.closest('[data-question-choice]');", "document.addEventListener('click', event => {const button=event.target.closest('.onboarding-approval"),f.context);
  q.choices[0].disabled=true;listeners.get('click')({target:{closest:()=>q.choices[0]}});assert.equal(q.input.value,'');
  q.choices[0].disabled=false;listeners.get('click')({target:{closest:()=>q.choices[0]}});assert.equal(q.input.value,'Safe choice');assert.equal(q.choices[0].attributes['aria-pressed'],'true');
  q.input.value='Custom answer';listeners.get('input')({target:{closest:()=>q.input}});assert.equal(q.choices[0].attributes['aria-pressed'],'false');assert.equal(f.calls.length,0);
});
test('refresh retains a selected native answer, its option state and focused custom field',()=>{
  const f=fixture(),q=questionGroup('question',['Safe choice']),a=approval({type:'input',questions:[{id:'question',question:'Choose',options:[{label:'Safe choice',description:'Read only'}]}]}),host=f.$('messages'),focuses=[];
  f.context.selectApprovalQuestionChoice(q.choices[0]);q.input.focus=options=>focuses.push(options);f.context.document.activeElement=q.input;
  const previous={dataset:{approval:a.id},approvalSignature:JSON.stringify(a),contains:active=>active===q.input};let cards=[previous],replacement;Object.defineProperty(host,'innerHTML',{set(){cards=[{dataset:{approval:a.id},replaceWith:node=>{replacement=node;cards=[node];}}];}});host.querySelectorAll=()=>cards;
  f.context.setRoomTimeline('new messages and the same question',[a]);assert.equal(replacement,previous);assert.equal(q.input.value,'Safe choice');assert.equal(q.choices[0].attributes['aria-pressed'],'true');assert.deepEqual(plain(focuses),[{preventScroll:true}]);assert.equal(f.calls.length,0);
});
test('denied and incomplete review events are status cards without fabricated allow actions; approved and foreign reviews stay absent',()=>{
  const f=fixture(),base=approval({id:'review',status:'denied',session_allowed:true});f.context.state.approval_reviews=[base,base,approval({id:'approved',status:'approved'}),approval({id:'foreign',status:'denied',room_id:'other'}),approval({id:'timeout',status:'timedOut'}),approval({id:'aborted',status:'aborted'})];
  const reviews=f.context.roomApprovalReviews(f.messages),html=f.context.approvalTimelineMarkup([],f.messages,reviews);assert.equal(reviews.length,3);assert.match(html,/操作检查未通过/);assert.match(html,/操作检查未完成/);assert.match(html,/data-review-member="agent"/);assert.match(html,/补充要求/);assert.doesNotMatch(html,/data-decision|data-approve=|acceptForSession|approved|foreign/);
});
test('review follow-up focuses the named member with its original task without sending or retrying',()=>{
  const f=fixture();f.$('recipient').options=[{value:'agent'}];f.$('prompt').value='existing draft';const target=button({reviewMember:'agent',reviewTask:'task'});
  f.$('messages').onclick({target:{closest:()=>target}});assert.equal(f.$('recipient').value,'agent');assert.equal(f.$('prompt').focused,true);assert.equal(f.$('prompt').value,'existing draft');assert.equal(f.context.replyTo,f.messages[0]);assert.equal(f.calls.length,0);
});
test('refreshing the timeline retains an unchanged approval form node and its focus but discards resolved cards',()=>{
  const f=fixture(),a=approval({type:'form'}),host=f.$('messages'),focuses=[],field={value:'draft',focus:options=>focuses.push(options)},previous={dataset:{approval:a.id},approvalSignature:JSON.stringify(a),contains:active=>active===field};f.context.document.activeElement=field;
  let cards=[previous],replacement;Object.defineProperty(host,'innerHTML',{set(){cards=[{dataset:{approval:a.id},replaceWith:node=>{replacement=node;cards=[node];}}];},configurable:true});host.querySelectorAll=()=>cards;
  f.context.setRoomTimeline('new timeline',[a]);assert.equal(replacement,previous);assert.equal(field.value,'draft');assert.deepEqual(plain(focuses),[{preventScroll:true}]);
  Object.defineProperty(host,'innerHTML',{set(){cards=[];},configurable:true});f.context.setRoomTimeline('resolved',[]);assert.equal(cards.length,0);assert.equal(focuses.length,1);
});
test('a changed onboarding stage retains the pending form draft and focus in the connection page',()=>{
  const f=fixture(),a=approval({type:'form',request_id:'connect:agent'}),host=f.$('onboarding-jobs'),focuses=[],field={value:'typed answer',focus:options=>focuses.push(options)},previous={dataset:{approval:a.id},approvalSignature:JSON.stringify(a),contains:active=>active===field};f.context.document.activeElement=field;f.context.state.approvals=[a];
  let cards=[previous],replacement;Object.defineProperty(host,'innerHTML',{set(){cards=[{dataset:{approval:a.id},replaceWith:node=>{replacement=node;cards=[node];}}];}});host.querySelectorAll=()=>cards;
  Object.assign(f.context,{webConnected:true,onboardingSignature:'previous-stage',currentOnboardingJobs:()=>[{id:'job',member_id:'agent',status:'running',stage:'waiting_input'}],onboardingJobMarkup:()=>'<div data-approval="approval/one">form</div>',tickOnboardingElapsed(){}});
  vm.runInContext(section('function renderOnboarding()', 'async function refreshOnboarding('),f.context);f.context.renderOnboarding();
  assert.equal(replacement,previous);assert.equal(field.value,'typed answer');assert.deepEqual(plain(focuses),[{preventScroll:true}]);
});

test('a denial note asks for attention only while its task is unfinished, and the session choice explains its reach',()=>{
  const f=fixture();
  for(const [status,active] of [['processing',true],['queued',true],['answered',false],['completed',false],['failed',false],['cancelled',false]]){
    f.messages[0].status=status;const html=f.context.renderApprovalReviewMessage(approval({id:'r-'+status,status:'denied'}),f.messages);
    assert.equal(/data-review-active="1"/.test(html),active,status);assert.match(html,/data-approval-review=/);
  }
  assert.equal(/data-review-active/.test(f.context.renderApprovalReviewMessage(approval({id:'orphan',status:'denied',request_id:'gone'}),f.messages)),false);
  const withSession=f.context.approvalContentMarkup(approval({session_allowed:true})),without=f.context.approvalContentMarkup(approval({session_allowed:false}));
  assert.match(withSession,/approval-note/);assert.match(withSession,/只想放行这一次/);assert.doesNotMatch(without,/approval-note|acceptForSession/);
});

test('office attention count and navigation select the same actionable cards and tolerate resolution before the click',()=>{
  const targets=[],selectors=[],panelCards=[],roomCards=[],frame=[];
  const card=id=>({id,scrollIntoView:()=>targets.push(id),querySelector:()=>null});
  const approval=card('pending'),finished=card('finished-denial'),activeReview=card('active-review'),alert={classList:{toggle(){}}};
  const elements={'office-approval-alert':alert,'approval-panel':{querySelectorAll:()=>panelCards},messages:{querySelectorAll:selector=>{selectors.push(selector);return selector.includes('data-review-active="1"')?roomCards:[...roomCards,finished];}}};
  const context=vm.createContext({$:id=>elements[id],document:{body:{classList:{contains:()=>true}}},selectRoomView(){},requestAnimationFrame:fn=>frame.push(fn)});
  vm.runInContext(section('function officeApprovalCards()', 'function currentSecretary(')+source.split('\n').find(line=>line.startsWith("$('office-approval-alert').onclick=")),context);
  roomCards.push(approval);context.updateOfficeApprovalAlert();assert.equal(alert.textContent,'1 项需要确认 ↗');
  alert.onclick();frame.shift()();assert.deepEqual(targets,['pending']);
  roomCards.push(activeReview);context.updateOfficeApprovalAlert();alert.onclick();frame.shift()();assert.equal(targets.at(-1),'active-review');assert.equal(alert.textContent,'2 项需要确认 ↗');
  alert.onclick();roomCards.length=0;frame.shift()();assert.equal(targets.length,2,'resolved cards do not redirect to a historical denial');
  panelCards.push(card('legacy-pending'));context.updateOfficeApprovalAlert();alert.onclick();frame.shift()();assert.equal(targets.at(-1),'legacy-pending');
  assert.ok(selectors.every(selector=>selector.includes('data-review-active="1"')));
});
