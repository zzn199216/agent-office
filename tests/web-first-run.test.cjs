'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/app.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
function section(start,end){const first=source.indexOf(start),last=source.indexOf(end,first+start.length);assert.ok(first>=0&&last>first);return source.slice(first,last);}

test('the project name defaults to the folder name on Windows and POSIX paths',()=>{
  const context=vm.createContext({});vm.runInContext(section('function projectNameFromPath(','function showProject('),context);
  assert.equal(context.projectNameFromPath('Y:\\git\\AgentOffice\\'),'AgentOffice');
  assert.equal(context.projectNameFromPath('/home/me/my-app'),'my-app');
  assert.equal(context.projectNameFromPath('  '),'');
});

test('first run is one path: folder, then an AI, with no separate room form',()=>{
  const welcome=html.slice(html.indexOf('<section id="welcome"'),html.indexOf('</section>',html.indexOf('<section id="welcome"')));
  assert.equal((welcome.match(/<button/g)||[]).length,2,'only the folder step and the follow-up AI step have buttons');
  assert.match(welcome,/class="current-step"[^]*id="welcome-project" class="primary"/);
  const submit=section("$('project-form').onsubmit","async function openFirstRoom(");
  assert.doesNotMatch(submit,/showRoom\(\)/);assert.match(submit,/openFirstRoom\(project\.id\)/);
  const open=section('async function openFirstRoom(',"$('check-codex')");
  assert.match(open,/\/api\/chat\/rooms/);assert.match(open,/openSecretaryConnect\(\)/);assert.match(open,/secretaryDismissed\.add\(roomId\)/);
  assert.doesNotMatch(html,/聊天室/,'one name for rooms in the interface');
  assert.doesNotMatch(html,/原生执行成员/);
});

test('every add-AI button opens the same picker, or the folder step when there is no room yet',()=>{
  const calls=[];const context=vm.createContext({professionalView:true,roomId:'room',legacyId:null,projectId:'project',openSecretaryConnect:()=>calls.push('picker'),openFirstRoom:id=>calls.push('room:'+id),showProject:()=>calls.push('folder'),setProfessionalView:()=>calls.push('office'),action:callback=>callback()});
  vm.runInContext(section('function openAddAI(','$(\'professional-toggle\').onclick'),context);
  context.openAddAI();context.roomId=null;context.openAddAI();context.projectId=null;context.openAddAI();
  assert.deepEqual(calls,['picker','room:project','folder']);
  for(const id of ['professional-toggle','room-member-add','empty-add-member','inspector-add-member'])assert.match(source,new RegExp(`(\\$\\('${id}'\\)\\.onclick = openAddAI|'${id}'[^\\]]*\\]\\) \\$\\(id\\)\\.onclick = openAddAI)`),id);
  assert.equal((html.match(/class="icon-button" aria-label="设置"/g)||[]).length,1,'one settings gear');
});

test('the collaboration panel leads with goals and tasks; meetings, brief and the Grok group are folded',()=>{
  const main=html.slice(html.indexOf('<section id="inspector-team-page"'),html.indexOf('</section>',html.indexOf('<section id="inspector-team-page"')));
  assert.ok(main.indexOf('id="team-content"')<main.indexOf('id="team-more"'));assert.ok(main.indexOf('id="team-more"')<main.indexOf('id="mirror-open"'));
  const render=section('function renderTeam() {','function teamEvidence(');
  assert.match(render,/extra \+= `<details class="team-section team-brief"/);assert.match(render,/if \(activeMeeting\) html \+= meetingHtml; else extra = meetingHtml \+ extra/);
});

test('the sidebar never says the service is running while it is stopped',()=>{
  const render=section('function renderService() {','if (!desktop) return;');
  assert.match(render,/webConnected \? '本机运行中/);assert.match(render,/服务已关闭/);
  assert.doesNotMatch(html,/本机运行，记录留在这里/);
});

test('the everyday surfaces use plain words',()=>{
  const BANNED=/本人对话|本人窗口|握手|桥接|原生|沿用|处理程序|信箱|心跳/;
  const block=(start,end)=>{const first=html.indexOf(start);assert.ok(first>=0,start);return html.slice(first,html.indexOf(end,first));};
  const surfaces={welcome:block('<section id="welcome"','</section>'),picker:block('<dialog id="secretary-connect-dialog"','</dialog>'),empty:block('<div id="empty-room"','<div id="messages"'),composer:block('<form id="composer"','</form>'),
    settings:block('<dialog id="settings-dialog"','<details class="settings-advanced">'),sidebar:block('<div class="sidebar-footer">','</aside>'),project:block('<dialog id="project-dialog"','</dialog>')};
  for(const [name,text] of Object.entries(surfaces))assert.doesNotMatch(text.replace(/<[^>]+>/g,' '),BANNED,name);
  for(const [start,end] of [['function renderLaunchCandidates(','function renderLaunch()'],['function updateRecipientNote(','function setReply('],['function renderSettings(','function renderRoom('],['function secretaryStatusText(','function openSecretaryTutorial('],['function memberPresence(','function ']]){
    const code=section(start,end).replace(/\/\/.*$/gm,'');for(const literal of code.match(/'[^'\n]*'|`[^`]*`/g)||[])assert.doesNotMatch(literal,BANNED,`${start} ${literal}`);
  }
});
