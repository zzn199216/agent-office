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
