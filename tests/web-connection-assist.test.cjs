'use strict';
// The connection card under a person's connect request, and the shared
// connection panel used by the card, the onboarding list and the member dialog.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first,`missing section ${start}`);return source.slice(first,last);}

function fixture(){
  const message={id:'human-task',room_id:'room',sender_id:'user',to_member_id:'assistant',kind:'message',text:'把豆包拉进来'},members=[{id:'assistant',name:'Codex',adapter:'codex'},{id:'target',name:'豆包',adapter:'mailbox'}];
  const reply={id:'actual-reply',room_id:'room',sender_id:'assistant',kind:'reply',reply_to:message.id,text:'接入进度见下方卡片。'};
  const calls={copy:[],toast:[],api:[],refresh:0,confirm:[],operations:[],native:[],listeners:[],inspector:[],tutorial:0};
  const jobs=new Map();
  const context=vm.createContext({
    roomId:'room',legacyId:null,history:{messages:[message,reply],participants:members,connection_assists:[]},
    memberById:id=>members.find(member=>member.id===id),senderName:id=>id==='user'?'你':members.find(member=>member.id===id)?.name||id,
    desktop:null,messageContent:value=>`<div class="fixture-content">${value.text}</div>`,messageImages:()=>'',messageCanReconcile:()=>false,nativeConnectionMessage:()=>'',pill:()=>'',plainMarkdown:text=>text,
    avatar:()=>'<span class="fixture-avatar"></span>',time:value=>String(value||''),
    navigator:{clipboard:{writeText:async text=>calls.copy.push(text)}},toast:text=>calls.toast.push(text),confirm:text=>{calls.confirm.push(text);return context.__confirm!==false;},
    refresh:async()=>{calls.refresh++;},refreshOnboarding:async()=>{},action:work=>Promise.resolve().then(work).catch(error=>calls.toast.push(`error:${error.message}`)),
    api:async(url,body)=>{calls.api.push([url,body]);if(url.startsWith('/api/onboarding/jobs/'))return jobs.get(decodeURIComponent(url.split('/').pop()))||null;if(url.includes('/setup'))return context.__setup;return {};},
    onboardingJobs:jobs,onboardingView:value=>value?.job||value,onboardingActions:job=>job?.next_actions||[],
    runOnboardingOperation:async(job,operation)=>{calls.operations.push([job.id,operation]);return job;},connectOnboardingNative:async job=>{calls.native.push(job.id);},
    openInspector:(tab,id)=>calls.inspector.push([tab,id]),openSecretaryTutorial:()=>{calls.tutorial++;},
    showMemberSetup:async()=>{},nativeSetupJob:()=>null,setupData:null,selectedSetupMember:null,lastSetupSignature:'',
    $:()=>({open:false}),document:{addEventListener:(type,fn)=>calls.listeners.push([type,fn])}
  });
  vm.runInContext(section('const escape =','const time =')+section('function renderMessage(','function renderTyping('),context);
  const view=(state,extra={})=>({state,headline:'豆包还没连上',primary:{operation:'copy_config',label:'复制配置'},secondary:{operation:'copy_handshake_prompt',label:'复制那句话'},busy:false,provider:'doubao',name:'豆包',details:{error:null,member_id:'target'},...extra});
  const assist=(presentation,extra={})=>({id:'assist',message_id:message.id,room_id:'room',member_id:'assistant',target_member_id:'target',provider:'doubao',name:'豆包',run_id:'run',presentation,...extra});
  const click=async(operation,{source='assist',id='assist',target=null}={})=>{
    const handler=calls.listeners.find(([type])=>type==='click')[1];
    const button={dataset:{connOp:operation,connSource:source,connId:id,...target?{connTarget:target}:{}},disabled:false};
    await handler({target:{closest:selector=>selector==='[data-conn-op]'?button:null}});
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    return button;
  };
  return {context,message,reply,calls,jobs,view,assist,click,render:value=>context.renderMessage(value,context.history.messages)};
}

test('the live card sits inside the addressed reply bubble, not above it',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting'))];
  const own=f.render(f.message),answer=f.render(f.reply);
  assert.doesNotMatch(own,/ao-system-card|data-conn-op/);
  assert.match(answer,/<div class="fixture-content">[^]*<section class="ao-system-card"[^]*<div class="message-footer">/);
  assert.match(answer,/Agent Office · 当前连接状态/);assert.match(answer,/豆包还没连上/);
  f.context.history.connection_assists=[f.assist(f.view('connected',{headline:'豆包已连接',primary:null,secondary:null}))];
  assert.match(f.render(f.reply),/豆包已连接/);assert.doesNotMatch(f.render(f.reply),/豆包还没连上|data-conn-op/);
});

test('pending requests retain the card, then only the first matching reply owns it',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting'))];
  const foreign={...f.reply,id:'foreign',sender_id:'target'},otherRoom={...f.reply,id:'other-room',room_id:'other'};
  f.context.history.messages=[f.message,foreign,otherRoom];
  assert.match(f.render(f.message),/ao-system-card/);assert.doesNotMatch(f.render(foreign),/ao-system-card/);assert.doesNotMatch(f.render(otherRoom),/ao-system-card/);
  const later={...f.reply,id:'later'};f.context.history.messages.push(f.reply,later);
  assert.doesNotMatch(f.render(f.message),/ao-system-card/);assert.match(f.render(f.reply),/ao-system-card/);assert.doesNotMatch(f.render(later),/ao-system-card/);
});

test('one status line, at most two buttons, and errors only inside closed details',()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('attention',{details:{error:'connect ECONNREFUSED 127.0.0.1:19246',member_id:'target'}}))];
  const html=f.render(f.reply);
  assert.equal((html.match(/data-conn-op=/g)||[]).length,2);
  assert.match(html,/class="primary" data-conn-op="copy_config"/);assert.match(html,/class="secondary" data-conn-op="copy_handshake_prompt"/);
  assert.match(html,/<details class="connection-panel-details"><summary>详情<\/summary><p class="small-note">connect ECONNREFUSED/);
  assert.doesNotMatch(html,/<details[^>]* open/);
});

test('connected states have no copy actions and busy states disable their buttons',()=>{
  const f=fixture();
  f.context.history.connection_assists=[f.assist(f.view('auto',{headline:'豆包已连接，有消息会自动处理',primary:null,secondary:null}))];
  assert.doesNotMatch(f.render(f.message),/data-conn-op/);
  f.context.history.connection_assists=[f.assist(f.view('waiting',{busy:true,headline:'正在连接豆包…',primary:{operation:'retry',label:'重试'},secondary:null}))];
  assert.match(f.render(f.reply),/data-conn-op="retry"[^>]* disabled/);
});

test('Doubao connector steps stay visible and escaped in every shared connection card',()=>{
  const f=fixture(),view=require('../src/member-connection.cjs').present({provider:'doubao',status:'needs_action',stage:'awaiting_handshake'});
  f.context.history.connection_assists=[f.assist(view)];const html=f.render(f.reply);
  assert.match(html,/connection-panel-steps/);assert.match(html,/本地电脑/);assert.match(html,/包含的操作/);assert.match(html,/在对话中试用/);assert.match(html,/复制连接地址/);assert.match(html,/复制验证语句/);
  assert.equal((html.match(/data-conn-op=/g)||[]).length,2);
  view.steps=['<img src=x onerror=alert(1)>'];assert.doesNotMatch(f.context.connectionPanelMarkup(view,{source:'member',id:'m'}),/<img/);
});

test('only records for this room, this human request and its actual recipient render, and every field is escaped',()=>{
  const f=fixture(),bad='<img src=x onerror=alert(1)>';
  f.context.history.connection_assists=[f.assist(f.view('waiting',{headline:bad,primary:{operation:'copy_config',label:bad}})),f.assist(f.view('waiting'),{id:'foreign-room',room_id:'other'}),f.assist(f.view('waiting'),{id:'foreign-recipient',member_id:'target'})];
  const html=f.render(f.reply);
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img src=x/);
  assert.equal((html.match(/class="connection-panel"/g)||[]).length,1);
  assert.doesNotMatch(f.render({...f.message,coordination:true}),/ao-system-card/);
  assert.doesNotMatch(f.render({...f.message,room_id:'other'}),/ao-system-card/);
});

test('copy takes text only from the member setup scoped to that person and room',async()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting'))];
  f.context.__setup={client:{kind:'http_fields',copy:'http://127.0.0.1:47831/mcp/fixture',bootstrap:'fixture handshake sentence'}};
  await f.click('copy_config');await f.click('copy_handshake_prompt');
  assert.deepEqual(f.calls.copy,['http://127.0.0.1:47831/mcp/fixture','fixture handshake sentence']);
  assert.ok(f.calls.api.filter(([url])=>url.includes('/setup')).every(([url])=>url==='/api/chat/members/target/setup?room_id=room'));
  assert.match(f.calls.toast[0],/豆包电脑版/);
});

test('a card from another room or a missing record cannot trigger any action',async()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting'),{room_id:'other'})];
  await assert.rejects(()=>f.context.connectionContext('assist','assist'),/已更新/);
  for(const operation of ['copy_config','reauthorize','enable_wake','start','new_member'])await f.click(operation);
  assert.ok(f.calls.toast.every(text=>/^error:/.test(text)));
  assert.equal(f.calls.copy.length,0);assert.equal(f.calls.operations.length,0);assert.ok(!f.calls.api.some(([url])=>url==='/api/onboarding/start'));
});

test('controller operations go through the scoped job; enable_wake and restart ask first',async()=>{
  const f=fixture();f.jobs.set('run',{id:'run',room_id:'room',provider:'doubao',member_id:'target',next_actions:[{operation:'open_native_client'}]});
  f.context.history.connection_assists=[f.assist(f.view('attention'))];
  await f.click('reauthorize');assert.deepEqual(f.calls.operations.at(-1),['run','reauthorize']);
  await f.click('native_connect');assert.deepEqual(f.calls.operations.at(-1),['run','open_native_client']);assert.deepEqual(f.calls.native,['run']);
  f.context.__confirm=false;await f.click('enable_wake');await f.click('open_native_client');
  assert.equal(f.calls.confirm.length,2);assert.ok(!f.calls.api.some(([url])=>url==='/api/onboarding/start'));assert.equal(f.calls.operations.filter(([,operation])=>operation==='open_native_client').length,1);
  f.context.__confirm=true;await f.click('enable_wake');
  assert.deepEqual(plain(f.calls.api.find(([url])=>url==='/api/onboarding/start')[1]),{room_id:'room',provider:'doubao',target_member_id:'target',connection_method:'native_desktop'});
  await f.click('new_member');assert.deepEqual(plain(f.calls.api.filter(([url])=>url==='/api/onboarding/start').at(-1)[1]),{room_id:'room',provider:'doubao',new_member:true});
  await f.click('show_connection_repair');assert.deepEqual(f.calls.inspector,[['connections','target']]);
});

test('a second click while an operation is running is ignored',async()=>{
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting'))];
  let release;f.context.__setup=new Promise(resolve=>{release=resolve;});
  const handler=f.calls.listeners.find(([type])=>type==='click')[1],button={dataset:{connOp:'copy_config',connSource:'assist',connId:'assist'},disabled:false};
  const event={target:{closest:()=>button}};handler(event);await new Promise(resolve=>setImmediate(resolve));
  button.disabled=false;handler(event);release({client:{copy:'once'}});
  for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls.copy,['once']);
});

test('member connection buttons work without a prior onboarding record',async()=>{
  for(const operation of ['retry','reauthorize','native_connect']){
    const f=fixture();f.context.setupData={member:{id:'target'},client:{provider:'claude-desktop'},presentation:f.view('attention')};
    await f.click(operation,{source:'member',id:'target'});
    const requests=f.calls.api.filter(([url])=>url==='/api/onboarding/start');assert.equal(requests.length,1);
    assert.deepEqual(plain(requests[0][1]),{room_id:'room',provider:'claude-desktop',target_member_id:'target',...operation==='reauthorize'?{reauthorize:true}:{}});
    assert.equal(f.calls.refresh,1);assert.ok(!f.calls.toast.some(text=>text.startsWith('error:')));
  }
});

test('OpenCode copy button receives its real provider-specific setup config',async t=>{
  const {RoomService}=require('../src/service.cjs'),{fixture:filesForTest,FakeCodex,FakeVault}=require('./helpers.cjs');
  const files=filesForTest(),service=new RoomService(files.data,{codex:new FakeCodex(),vault:new FakeVault()});
  t.after(async()=>{await service.close();assert.equal(path.dirname(path.resolve(files.root)),path.resolve(require('node:os').tmpdir()));assert.match(path.basename(files.root),/^agentroom-test-/);fs.rmSync(files.root,{recursive:true,force:true});});
  const project=service.addProject({name:'Copy config',path:files.project}),room=service.chat.addRoom({title:'Copy config',project_id:project.id});
  const member=service.chat.store.addMember({name:'OpenCode',adapter:'mailbox',config:{launch_provider:'opencode',desktop_delivery_mode:'manual_mcp'}});service.chat.join(room.id,member.id);
  const f=fixture();f.context.history.connection_assists=[f.assist(f.view('waiting',{provider:'opencode',name:'OpenCode'}),{provider:'opencode',target_member_id:member.id})];
  f.context.__setup=service.chat.setup(member.id,room.id);await f.click('copy_config');
  assert.equal(f.calls.copy.length,1);const config=JSON.parse(f.calls.copy[0]);
  assert.equal(config.mcpServers,undefined);assert.equal(config.mcp.agentoffice.type,'local');assert.equal(config.mcp.agentoffice.enabled,true);
  assert.ok(Array.isArray(config.mcp.agentoffice.command));assert.equal(config.mcp.agentoffice.command.at(-2),'--entry');
  assert.equal(JSON.parse(fs.readFileSync(config.mcp.agentoffice.command.at(-1),'utf8')).member_id,member.id);
});

test('connection-flow copy avoids reassurance and internal terms, and every quoted button exists',()=>{
  const banned=/保留|沿用|没有自动重试|未宣称|不会生成|原生会话|本人对话|握手|兼容 MCP|群桥接/;
  const functions=['function renderConnectionAssists(','function connectionPanelMarkup(','async function connectionCopy(','async function runConnectionOperation(','function applySetupPresentation(','async function runOnboardingOperation('];
  const presentationSource=fs.readFileSync(path.join(__dirname,'../src/member-connection.cjs'),'utf8');
  const labels=new Set([...presentationSource.matchAll(/(?:button\(|pick\(snapshot,\s*)'[a-z_]+',\s*(['`])([^'`]+)\1/g)].map(match=>match[2].replace(/\$\{name\}/g,'').replace(/\s+/g,'')));
  for(const start of functions){
    const first=source.indexOf(start);assert.ok(first>=0,start);
    const body=source.slice(first,source.indexOf('\n}',first));
    const strings=[...body.matchAll(/(['`])((?:(?!\1).)*[一-鿿](?:(?!\1).)*)\1/g)].map(match=>match[2]);
    for(const text of strings){
      assert.doesNotMatch(text,banned,`${start}: ${text}`);
      for(const quoted of text.matchAll(/「([^」]+)」/g))assert.ok(labels.has(quoted[1].replace(/\s+/g,'')),`${start} mentions a button that the panel never shows: ${quoted[1]}`);
    }
  }
});
