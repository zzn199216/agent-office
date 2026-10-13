'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GeminiClient, detectGemini, MIN_VERSION, ROOM_TOOLS, READ_TOOLS, versionSupported, collaborationPayload, runtimePolicy } = require('../src/gemini.cjs');
const { fixture } = require('./helpers.cjs');
const { id, normalizePath } = require('../src/util.cjs');
const SESSION = 'ef7bcb9c-1871-4e50-8398-dd31b0c21234';
const OTHER_SESSION = '16dd2be3-5a1a-4490-bd38-d3ac81ae2222';
const FAKE = String.raw`
'use strict';
const fs = require('node:fs'), args = process.argv.slice(2), env = process.env;
const at = name => args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1];
const mode = env.FAKE_GEMINI_MODE || 'success';
if(args.includes('--version')) { process.stdout.write(env.FAKE_GEMINI_VERSION || '0.63.0\n'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const config = JSON.parse(fs.readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  const policy = fs.readFileSync(at('--policy'), 'utf8');
  fs.appendFileSync(env.FAKE_GEMINI_LOG, JSON.stringify({args, config, policy, input, cwd:process.cwd(), settingsPath:env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, normalAuthPreserved:env.GEMINI_API_KEY==='AIzaFixtureProviderSecret123456', systemMd:env.GEMINI_SYSTEM_MD, debug:env.DEBUG}) + '\n');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if(mode === 'hang-before-init') { setInterval(() => {}, 1000); return; }
  if(mode === 'no-init') { emit({type:'result',status:'success',stats:{}}); process.exit(0); }
  if(mode === 'login-before-init') { process.stderr.write('Authentication failed: GEMINI_API_KEY=AIzaNeverExposeCredential123456; '+input); process.exit(1); }
  if(mode === 'resume-missing') { process.stderr.write('Invalid session identifier; secret-question-never-forward'); process.exit(1); }
  const session = mode === 'wrong-session' ? '16dd2be3-5a1a-4490-bd38-d3ac81ae2222' : at('--resume') || 'ef7bcb9c-1871-4e50-8398-dd31b0c21234';
  emit({type:'init',timestamp:'2026-10-13T00:00:00Z',session_id:mode==='invalid-session'?'latest':session,model:'fixture-gemini'});
  if(mode === 'hang') { setInterval(() => {}, 1000); return; }
  if(mode === 'no-result') { emit({type:'message',role:'assistant',content:'partial',delta:true}); process.exit(0); }
  if(mode === 'tool-unsafe' || mode === 'tool-unknown' || mode === 'tool-management') {
    emit({type:'tool_use',tool_name:mode==='tool-unsafe'?'run_shell_command':mode==='tool-unknown'?'future_execute_tool':'agentroom_agentroom_group_prepare',tool_id:'danger',parameters:{command:'echo private-command'}}); setInterval(() => {},1000); return;
  }
  if(mode === 'tool-safe') { emit({type:'message',role:'assistant',content:'I will inspect first. ',delta:true}); emit({type:'tool_use',tool_name:'agentroom_agentroom_join',tool_id:'room-join',parameters:{}}); emit({type:'tool_result',tool_id:'room-join',status:'success',output:'fixture'}); }
  if(mode === 'denied') { emit({type:'tool_result',tool_id:'read',status:'error',error:{type:'PERMISSION_DENIED',message:'policy denied private-path secret=never-forward'}}); }
  if(mode === 'quota') { emit({type:'error',severity:'error',message:'RESOURCE_EXHAUSTED: quota API key AIzaNeverExposeCredential123456'}); process.exit(1); }
  if(mode === 'login') { emit({type:'error',severity:'error',message:'UNAUTHENTICATED Bearer secret-login-token'}); process.exit(1); }
  if(mode === 'fatal') { emit({type:'error',severity:'error',message:'provider private-prompt secret=never-forward'}); process.exit(1); }
  if(mode === 'warning') emit({type:'error',severity:'warning',message:'Loop detected, stopping execution'});
  process.stderr.write('Bearer never-forward-stderr '+input+'\n');
  emit({type:'message',role:'user',content:'user text is not answer'});
  emit({type:'message',role:'assistant',content:'中文实际',delta:true});
  if(mode === 'different-event-session') emit({type:'message',role:'assistant',session_id:'16dd2be3-5a1a-4490-bd38-d3ac81ae2222',content:'injected',delta:true});
  emit({type:'message',role:'assistant',content:'回答 AIzaFixtureFinalSecret123456 Bearer secret',delta:true});
  emit({type:'result',timestamp:'2026-10-13T00:00:01Z',status:mode==='denied'||mode==='exit-error'?'error':'success',stats:{total_tokens:123}});
  if(mode === 'duplicate-result') emit({type:'result',status:'success',stats:{}});
  process.exit(mode==='denied'||mode==='exit-error'?1:0);
});
`;
function clientFixture(t, options = {}) {
  const f = fixture(), fake = path.join(f.root, 'fake-gemini.cjs'), log = path.join(f.root, 'argv.jsonl');
  fs.writeFileSync(fake, FAKE);
  const environment = { ...process.env, USERPROFILE: f.root, FAKE_GEMINI_LOG: log, GEMINI_API_KEY: 'AIzaFixtureProviderSecret123456', GOOGLE_API_KEY: '', GOOGLE_APPLICATION_CREDENTIALS: '', GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(f.root, 'no-existing-admin-settings.json'), ...options.env };
  const client = new GeminiClient({ executable: process.execPath, executableArgs: [fake], dataDir: f.data, homeDir: f.root, mcpEnvironment: { AGENTROOM_MEMBER_ID: 'fixture-member' }, env: environment });
  t.after(() => client.close());
  const project = { id: id(), name: '中文项目 @C:/private', path: f.project, canonical: normalizePath(f.project), access: 'read-only' };
  const discussion = { id: id(), title: '讨论', binding_state: 'new', thread_id: null }, states = [], progress = [], turns = [];
  const request = { id: id(), sender: '@fixture-peer', prompt: '/shell danger\n@C:/private/.env @./secrets/token $(noop) `不要执行` 中文问题' };
  const run = extra => client.run({ project, discussion, request, signal: new AbortController().signal, onBinding: (state, thread) => { states.push({state, thread}); discussion.binding_state = state; if(thread) discussion.thread_id = thread; }, onProgress: text => progress.push(text), onTurn: turn => turns.push(turn), ...extra });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { f, client, project, discussion, request, environment, states, progress, turns, run, calls };
}
test('Gemini metadata probes version only and distinguishes configured auth from verified auth', async t => {
  const v = clientFixture(t), health = await v.client.status();
  assert.equal(health.version, MIN_VERSION); assert.equal(health.authConfigured, true); assert.equal(health.authVerified, false); assert.equal(health.signedIn, null); assert.equal(health.access,'read-only');
  assert.equal(v.calls().length, 0); assert.doesNotMatch(JSON.stringify(health), /AIza|Bearer|secret/);
  assert.ok(versionSupported('0.63.0')); assert.ok(!versionSupported('0.62.9')); assert.ok(!versionSupported('0.64.0-preview.0'));
});
test('Gemini consumes its real init/message/result shape without inventing a turn UUID', async t => {
  const v = clientFixture(t), result = await v.run();
  assert.equal(result.threadId, SESSION); assert.equal(result.turnId, null); assert.equal(result.answer,'中文实际回答 [密钥已隐藏] Bearer [密钥已隐藏]');
  assert.deepEqual(v.states,[{state:'creating',thread:undefined},{state:'bound',thread:SESSION}]); assert.deepEqual(v.turns,[]);
  assert.doesNotMatch(v.progress.join('\n'), /FixtureFinalSecret|never-forward|user text/);
});
test('Gemini request JSON neutralizes slash and every literal @ before CLI preprocessing', async t => {
  const v = clientFixture(t); await v.run(); const call = v.calls()[0];
  assert.doesNotMatch(call.input, /@/); assert.match(call.input, /\\u0040C:\/private\/\.env/); assert.ok(!call.input.startsWith('/'));
  const payload = JSON.parse(call.input.split('AgentRoom collaboration request (JSON):\n')[1]);
  assert.equal(payload.prompt, v.request.prompt); assert.equal(payload.peer, v.request.sender); assert.equal(payload.project, v.project.name);
  assert.ok(!call.args.some(arg => arg.includes('中文问题'))); assert.match(payload.prompt,/\$\(noop\)/);
  assert.doesNotMatch(collaborationPayload(v.project,v.discussion,{...v.request,prompt:'\\@one \\\\@two @@three'},'extra @hidden'),/@/);
});
test('Gemini launches with exact MCP filter, bounded core tools, no yolo and disabled ambient execution', async t => {
  const v = clientFixture(t,{env:{GEMINI_SYSTEM_MD:'private-system-file',DEBUG:'true'}}); await v.run(); const call=v.calls()[0];
  const get = name => call.args[call.args.indexOf(name)+1];
  assert.equal(get('--output-format'),'stream-json'); assert.equal(get('--approval-mode'),'default'); assert.equal(get('--allowed-mcp-server-names'),'agentroom'); assert.equal(get('--extensions'),'none');
  for(const forbidden of ['--yolo','--allowed-tools','--admin-policy','--resume','--session-id','--continue','--prompt']) assert.ok(!call.args.includes(forbidden));
  assert.deepEqual(call.config.tools.core,[...READ_TOOLS]); assert.ok(!READ_TOOLS.includes('grep_search')); assert.equal(call.config.tools.discoveryCommand,''); assert.equal(call.config.tools.callCommand,'');
  assert.equal(call.config.hooksConfig.enabled,false); assert.equal(call.config.admin.extensions.enabled,false); assert.equal(call.config.skills.enabled,false); assert.equal(call.config.advanced.ignoreLocalEnv,true);
  assert.deepEqual(call.config.mcp.allowed,['agentroom']); assert.deepEqual(Object.keys(call.config.mcpServers),['agentroom']); assert.deepEqual(call.config.mcpServers.agentroom.includeTools,[...ROOM_TOOLS]);
  assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_CALLER,'gemini-cli'); assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_MEMBER_ID,'fixture-member'); assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_ROOM_ID,v.discussion.id);
  assert.equal(call.normalAuthPreserved,true); assert.equal(call.systemMd,undefined); assert.equal(call.debug,undefined); assert.equal(normalizePath(call.cwd),v.project.canonical);
  assert.equal(fs.existsSync(call.settingsPath),false); assert.equal(fs.existsSync(get('--policy')),false); assert.deepEqual(fs.readdirSync(path.join(v.f.data,'gemini-runtime')),[]);
});
test('Gemini native UUID resume remains pinned to project and never uses latest', async t => {
  const v=clientFixture(t); await v.run(); await v.run(); const calls=v.calls(); assert.equal(calls.length,2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume')+1],SESSION); assert.equal(calls[0].cwd,calls[1].cwd);
  const other=fixture(); await assert.rejects(v.run({project:{...v.project,path:other.project,canonical:normalizePath(other.project)}}),error=>error.code==='project_mismatch'); assert.equal(v.calls().length,2);
});
test('Gemini refuses wrong resumed ID and rejects inconsistent subsequent event IDs', async t => {
  const wrong=clientFixture(t,{env:{FAKE_GEMINI_MODE:'wrong-session'}}); wrong.discussion.thread_id=SESSION; wrong.discussion.binding_state='bound';
  await assert.rejects(wrong.run(),error=>error.code==='outcome_uncertain'); assert.equal(wrong.discussion.thread_id,SESSION); assert.deepEqual(wrong.states,[]); assert.equal(wrong.calls().length,1);
  const changed=clientFixture(t,{env:{FAKE_GEMINI_MODE:'different-event-session'}}); await assert.rejects(changed.run(),error=>error.code==='outcome_uncertain'); assert.equal(changed.discussion.thread_id,SESSION);
});
test('Gemini missing init prevents creation from being reported as success or auto-recreated', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'no-init'}}); await assert.rejects(v.run(),error=>error.code==='creation_uncertain');
  assert.equal(v.discussion.thread_id,null); assert.equal(v.discussion.binding_state,'creation_uncertain'); await assert.rejects(v.run(),error=>error.code==='creation_uncertain'); assert.equal(v.calls().length,1);
});
test('Gemini missing final result and duplicate results are uncertain, preserving session binding', async t => {
  for(const mode of ['no-result','duplicate-result']) {const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:mode}}); await assert.rejects(v.run(),error=>error.code==='outcome_uncertain'); assert.equal(v.discussion.thread_id,SESSION); assert.equal(v.calls().length,1);}
});
test('Gemini timeout before init leaves creation uncertain and never resends', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'hang-before-init'}}); await assert.rejects(v.run({timeout:500}),error=>error.code==='creation_uncertain');
  assert.equal(v.discussion.binding_state,'creation_uncertain'); assert.equal(v.calls().length,1); assert.equal(v.client.child,null); await assert.rejects(v.run(),error=>error.code==='creation_uncertain');
});
test('Gemini cancellation after authoritative init retains bound identity and kills only owned child', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'hang'}}), controller=new AbortController();
  await assert.rejects(v.run({signal:controller.signal,onBinding:(state,thread)=>{v.states.push({state,thread});v.discussion.binding_state=state;if(thread){v.discussion.thread_id=thread;controller.abort();}}}),error=>error.code==='outcome_uncertain');
  assert.equal(v.discussion.thread_id,SESSION); assert.equal(v.calls().length,1); assert.equal(v.client.child,null);
});
test('Gemini refuses concurrent calls and pre-aborted requests without spawning', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'hang-before-init'}}), first=v.run({timeout:500});
  await assert.rejects(v.run(),error=>error.code==='gemini_busy'); await assert.rejects(first,error=>error.code==='creation_uncertain'); assert.equal(v.calls().length,1);
  const aborted=clientFixture(t), controller=new AbortController(); controller.abort(); await assert.rejects(aborted.run({signal:controller.signal}),error=>error.code==='cancelled'); assert.equal(aborted.calls().length,0);
});
test('Gemini rejects unsafe, future unknown and unrestricted room management tools', async t => {
  for(const mode of ['tool-unsafe','tool-unknown','tool-management']) {const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:mode}}); await assert.rejects(v.run(),error=>error.code==='gemini_tool_scope_mismatch'&&error.needsAction===true); assert.equal(v.calls().length,1);}
  const safe=clientFixture(t,{env:{FAKE_GEMINI_MODE:'tool-safe'}}), response=await safe.run(); assert.equal(response.threadId,SESSION); assert.ok(!response.answer.includes('inspect first')); assert.ok(safe.progress.some(text=>text.includes('inspect first')));
});
test('Gemini auth and quota failures request explicit action without leaking diagnostics or prompt', async t => {
  for(const [mode,code] of [['login','gemini_login_required'],['login-before-init','gemini_login_required'],['quota','gemini_quota_required'],['fatal','turn_failed']]) {
    const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:mode}}); await assert.rejects(v.run(),error=>error.code===code&&error.needsAction===true&&!/AIza|Bearer|secret|中文问题|private-prompt/.test(error.message)); assert.equal(v.calls().length,1);
  }
});
test('Gemini resume failure never replaces its native session or retries a request', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'resume-missing'}}); v.discussion.thread_id=SESSION; v.discussion.binding_state='bound';
  await assert.rejects(v.run(),error=>error.code==='gemini_resume_required'&&error.needsAction===true); assert.equal(v.calls().length,1); assert.equal(v.discussion.thread_id,SESSION); assert.deepEqual(v.states,[]);
});
test('Gemini permission denial and nonzero final exit cannot masquerade as success', async t => {
  const denied=clientFixture(t,{env:{FAKE_GEMINI_MODE:'denied'}}); await assert.rejects(denied.run(),error=>error.code==='gemini_permission_denied'&&!/secret|private/.test(error.message));
  const failed=clientFixture(t,{env:{FAKE_GEMINI_MODE:'exit-error'}}); await assert.rejects(failed.run(),error=>error.code==='turn_failed');
});
test('Gemini warning events are not fatal and raw provider diagnostics stay private', async t => {
  const v=clientFixture(t,{env:{FAKE_GEMINI_MODE:'warning'}}); assert.equal((await v.run()).threadId,SESSION); assert.doesNotMatch(v.progress.join('\n'),/Loop detected|never-forward-stderr/);
});
test('Gemini rejects unsupported and prerelease versions before any model request', async t => {
  for(const [version,code] of [['0.62.9','gemini_upgrade_required'],['0.64.0-preview.0','gemini_version_unknown'],['untrusted wrapper','gemini_version_unknown']]) { const v=clientFixture(t,{env:{FAKE_GEMINI_VERSION:version}}); await assert.rejects(v.run(),error=>error.code===code); assert.equal(v.calls().length,0); }
});
test('Gemini independent CLI authentication is required, with OAuth metadata never claiming validity', async t => {
  const v=clientFixture(t,{env:{GEMINI_API_KEY:''}}); await assert.rejects(v.run(),error=>error.code==='gemini_login_required'); assert.equal(v.calls().length,0);
  fs.mkdirSync(path.join(v.f.root,'.gemini')); fs.writeFileSync(path.join(v.f.root,'.gemini','settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));
  const health=await v.client.status(); assert.equal(health.authType,'oauth-personal'); assert.equal(health.authConfigured,true); assert.equal(health.authVerified,false); assert.equal(health.signedIn,null);
});
test('Gemini refuses replacing existing system-managed settings without reading or changing them', async t => {
  const v=clientFixture(t), file=path.join(v.f.root,'managed.json'); const original='{"admin":{"mcp":{"enabled":false}},"never":"read-secret"}'; fs.writeFileSync(file,original); v.environment.GEMINI_CLI_SYSTEM_SETTINGS_PATH=file;
  await assert.rejects(v.run(),error=>error.code==='gemini_managed_settings'&&error.needsAction===true&&!/read-secret/.test(error.message)); assert.equal(fs.readFileSync(file,'utf8'),original); assert.equal(v.calls().length,0);
});
test('Gemini policy compiles with JS regex syntax and blocks Windows/case-varied private paths', () => {
  const policy=runtimePolicy(), pattern=policy.match(/argsPattern = '([^']+)'/)[1], regex=new RegExp(pattern);
  for(const input of ['{"file_path":".env"}','{"file_path":"nested/.ENV.production"}','{"file_path":"secrets/key.json"}','{"file_path":"C:\\\\project\\\\.Gemini\\\\settings.json"}','{"path":".agentroom/"}']) assert.ok(regex.test(input),input);
  for(const input of ['{"file_path":"README.md"}','{"file_path":"src/main.cjs"}','{"path":"docs"}']) assert.ok(!regex.test(input),input);
  assert.match(policy,/toolName = "\*"\ndecision = "deny"/); assert.match(policy,/mcpName = "agentroom"/); assert.doesNotMatch(policy,/mcpName = "\*"|yolo|run_shell_command/);
});
test('Gemini invalid native session and stopped adapter cannot spawn new work', async t => {
  const invalid=clientFixture(t); invalid.discussion.thread_id='latest'; await assert.rejects(invalid.run(),error=>error.code==='gemini_session_invalid'); assert.equal(invalid.calls().length,0);
  const stopped=clientFixture(t); await stopped.client.close(); await assert.rejects(stopped.run(),error=>error.code==='connection_lost'); assert.equal(stopped.calls().length,0);
});
test('Gemini detector avoids shell shims on Windows and supports executable arguments supplied by official package discovery', t => {
  const f=fixture(), exe=path.join(f.root,'gemini.exe'), cmd=path.join(f.root,'gemini.cmd'); fs.writeFileSync(exe,'fixture'); fs.writeFileSync(cmd,'fixture');
  assert.equal(detectGemini({platform:'win32',env:{AGENTROOM_GEMINI_CLI_PATH:cmd,PATH:''}}),null);
  assert.equal(detectGemini({platform:'win32',env:{AGENTROOM_GEMINI_CLI_PATH:exe,PATH:''}}),exe);
  assert.notEqual(SESSION,OTHER_SESSION);
});
test('Gemini explicit Node bundle environment launches only the fixed absolute official entry', async () => {
  const f=fixture(), exe=path.join(f.root,'node.exe'), entry=path.join(f.root,'bundle','gemini.js'); fs.writeFileSync(exe,'fixture'); fs.mkdirSync(path.dirname(entry)); fs.writeFileSync(entry,FAKE);
  const env={AGENTROOM_GEMINI_PATH:exe,AGENTROOM_GEMINI_SCRIPT:entry,PATH:''};
  assert.equal(detectGemini({platform:'win32',env}),exe);
  const client=new GeminiClient({env}); assert.equal(client.executable,exe); assert.deepEqual(client.spawnArgs,[entry]); await client.close();
  assert.equal(detectGemini({platform:'win32',env:{...env,AGENTROOM_GEMINI_SCRIPT:path.join(f.root,'fake.js')}}),null);
});
