'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeClient, detectClaude, MIN_VERSION, ROOM_TOOLS, versionSupported } = require('../src/claude.cjs');
const { fixture } = require('./helpers.cjs');
const { id, normalizePath } = require('../src/util.cjs');
const SESSION = '4ca2b4d5-8a9f-4f54-a9aa-ec5ad0b44d43';
const OTHER_SESSION = '34e8a2f4-2535-495b-b60a-6fdf334bb01a';
const FAKE = String.raw`
'use strict';
const fs=require('node:fs'); const args=process.argv.slice(2), env=process.env;
const at=name=>args.indexOf(name)<0?undefined:args[args.indexOf(name)+1];
const mode=env.FAKE_CLAUDE_MODE||'success';
if(args.includes('--version')){process.stdout.write(env.FAKE_CLAUDE_VERSION||'2.1.300 (Claude Code)');process.exit(0);}
const credentialMatches=!env.FAKE_CLAUDE_EXPECT_KEY||(env.ANTHROPIC_AUTH_TOKEN||env.ANTHROPIC_API_KEY)===env.FAKE_CLAUDE_EXPECT_KEY;
if(args[0]==='auth'&&args[1]==='status'){const authenticated=env.FAKE_CLAUDE_AUTH!=='false'&&credentialMatches;console.log(JSON.stringify({loggedIn:authenticated,authMethod:'claude.ai',email:'private@example.invalid',token:'sk-ant-never-return-status'}));process.exit(authenticated?0:1);}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const config=JSON.parse(fs.readFileSync(at('--mcp-config'),'utf8'));
fs.appendFileSync(env.FAKE_CLAUDE_LOG,JSON.stringify({args,cwd:process.cwd(),config,input,resumeInterrupted:env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN,credentialMatches,baseUrl:env.ANTHROPIC_BASE_URL,model:env.ANTHROPIC_MODEL,opus:env.ANTHROPIC_DEFAULT_OPUS_MODEL,unexpectedUserEnv:env.CLAUDE_TEST_UNTRUSTED_ENV})+'\n');
if(!credentialMatches){console.log('missing runtime credential');process.exit(1);}
if(mode==='requires-upfront'&&config.mcpServers.agentroom.alwaysLoad!==true){console.log('join tool not loaded in restricted session');process.exit(1);}
if(mode==='no-init'){console.log('not a protocol event');process.exit(0);}
if(mode==='hang-before-init'){setInterval(()=>{},1000);return;}
const session=mode==='wrong-session'?'34e8a2f4-2535-495b-b60a-6fdf334bb01a':(at('--resume')||'4ca2b4d5-8a9f-4f54-a9aa-ec5ad0b44d43');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,cwd:mode==='wrong-cwd'?env.FAKE_CLAUDE_OTHER_PATH:process.cwd(),mcp_servers:[{name:'agentroom',status:mode==='mcp-failed'?'failed':'connected'}],mcp_server_errors:mode==='mcp-failed'?[{name:'agentroom',message:'private details'}]:[]}));
if(mode==='no-result'){process.exit(0);}
if(mode==='hang'){setInterval(()=>{},1000);return;}
if(mode==='api-auth'){console.log(JSON.stringify({type:'system',subtype:'api_error',error:{status:401,message:'private upstream secret'}}));setInterval(()=>{},1000);return;}
process.stderr.write('sk-ant-never-return-stderr Bearer private-stderr\n');
console.log(JSON.stringify({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:'检查中文 sk-ant-progress-secret'}}}));
console.log(JSON.stringify({type:'assistant',session_id:session,parent_tool_use_id:'tool-child',message:{content:[{type:'text',text:'subagent answer is not final'}]}}));
if(mode==='echo-key'){console.log(JSON.stringify({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:env.FAKE_CLAUDE_EXPECT_KEY}}}));}
const keyError=mode==='key-error';
console.log(JSON.stringify({type:'result',subtype:mode==='denied'||keyError?'error_during_execution':'success',is_error:mode==='denied'||keyError,session_id:session,uuid:'06fbd02b-3e61-4ba8-8e90-0249880706a3',result:mode==='echo-key'||keyError?env.FAKE_CLAUDE_EXPECT_KEY:mode==='denied'?'操作被拒绝':'中文实际回答 sk-ant-final-secret Bearer secret crsr_test-secret',permission_denials:mode==='denied'?[{tool_name:'Bash',tool_input:{command:'private-command'}}]:[]}));
process.exit(mode==='denied'?1:0);
});
`;
function clientFixture(t, options = {}) {
  const f = fixture(), fake = path.join(f.root, 'fake-claude.cjs'), log = path.join(f.root, 'argv.jsonl');
  fs.writeFileSync(fake, FAKE);
  const environment = { ...process.env, CLAUDE_CONFIG_DIR: path.join(f.root, '.claude'), FAKE_CLAUDE_LOG: log, ...options.env };
  const client = new ClaudeClient({ executable: process.execPath, args: [fake], dataDir: f.data, mcpEnvironment: { AGENTROOM_MEMBER_ID: 'fixture-member' }, env: environment });
  t.after(() => client.close());
  const project = { id: id(), name: '中文测试项目', path: f.project, canonical: normalizePath(f.project), access: 'read-only' };
  const discussion = { id: id(), title: '中文讨论', binding_state: 'new', thread_id: null };
  const states = [], progress = [], turns = [];
  const run = extra => client.run({ project, discussion, request: { id: id(), sender: 'fixture-peer', prompt: '请回答中文问题；$(noop) `不执行`' }, onBinding: (state, thread) => { states.push({ state, thread }); discussion.binding_state = state; if (thread) discussion.thread_id = thread; }, onTurn: turn => turns.push(turn), onProgress: text => progress.push(text), signal: new AbortController().signal, ...extra });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { f, client, project, discussion, environment, states, progress, turns, run, calls };
}
test('Claude metadata checks do not start a model session or disclose auth data', async t => {
  const v = clientFixture(t), health = await v.client.status();
  assert.equal(health.signedIn, true); assert.equal(health.version, '2.1.300'); assert.equal(health.access, 'read-only');
  assert.equal(v.calls().length, 0); assert.doesNotMatch(JSON.stringify(health), /private@example|sk-ant|token/);
  assert.equal(versionSupported(MIN_VERSION), true); assert.equal(versionSupported('2.1.258'), false); assert.equal(versionSupported('unknown'), false);
});

function userSettings(v, settings) {
  const directory = v.environment.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings));
}
test('placeholder API credentials never start a Claude model and saving a key unlocks the same client',async t=>{
  const v=clientFixture(t);userSettings(v,{env:{ANTHROPIC_BASE_URL:'https://fixture.invalid',ANTHROPIC_AUTH_TOKEN:'PASTE_YOUR_API_KEY_HERE'}});
  await assert.rejects(v.run(),error=>error.code==='claude_login_required');assert.equal(v.calls().length,0);
  userSettings(v,{env:{ANTHROPIC_BASE_URL:'https://fixture.invalid',ANTHROPIC_AUTH_TOKEN:'saved-fixture-key'}});const original=fs.readFileSync(path.join(v.environment.CLAUDE_CONFIG_DIR,'settings.json'),'utf8');await v.run();assert.equal(v.calls().length,1);assert.equal(fs.readFileSync(path.join(v.environment.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'),original);
});
test('Claude API rejection stops the owned child promptly with actionable redacted status',async t=>{
  const v=clientFixture(t,{env:{FAKE_CLAUDE_MODE:'api-auth'}}),start=Date.now();await assert.rejects(v.run({timeout:15000}),error=>error.code==='claude_api_auth_required'&&/401/.test(error.message)&&!error.message.includes('private upstream'));
  assert.ok(Date.now()-start<10000);assert.equal(v.calls().length,1);assert.equal(v.client.child,null);
});
test('Claude vision input sends actual base64 image blocks over stdin and preserves session resume',async t=>{
  const v=clientFixture(t),images=[{mime:'image/png',data:'fixture-image'}];await v.run();await v.run({request:{id:id(),sender:'fixture-peer',prompt:'看图',images}});
  const call=v.calls()[1],input=JSON.parse(call.input);assert.equal(call.args[call.args.indexOf('--input-format')+1],'stream-json');assert.equal(input.type,'user');assert.deepEqual(input.message.content[1],{type:'image',source:{type:'base64',media_type:'image/png',data:'fixture-image'}});assert.equal(input.parent_tool_use_id,null);assert.equal(call.args[call.args.indexOf('--resume')+1],SESSION);assert.equal(call.args.some(arg=>arg.includes('fixture-image')),false);
});

test('restricted Claude forwards user gateway credentials and models without loading other settings', async t => {
  const key = 'gateway-fixture-private-key', v = clientFixture(t, { env: { FAKE_CLAUDE_EXPECT_KEY: key, ANTHROPIC_AUTH_TOKEN: 'stale-shell-key' } });
  userSettings(v, { env: { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: 'https://gateway.invalid', ANTHROPIC_MODEL: 'gateway-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'gateway-opus', CLAUDE_TEST_UNTRUSTED_ENV: 'must-not-load', NODE_OPTIONS: '--require untrusted.js' }, hooks: { SessionStart: [{ command: 'must-not-run' }] }, permissions: { defaultMode: 'bypassPermissions' }, enabledPlugins: { untrusted: true } });
  fs.mkdirSync(path.join(v.project.path, '.claude'));
  fs.writeFileSync(path.join(v.project.path, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'project-controlled-key', ANTHROPIC_BASE_URL: 'https://project.invalid' } }));
  const health = await v.client.status(); await v.run(); const call = v.calls()[0];
  assert.equal(health.signedIn, true); assert.equal(call.credentialMatches, true);
  assert.equal(call.baseUrl, 'https://gateway.invalid'); assert.equal(call.model, 'gateway-sonnet'); assert.equal(call.opus, 'gateway-opus'); assert.equal(call.unexpectedUserEnv, undefined);
  assert.ok(call.args.includes('--restricted')); assert.ok(call.args.includes('--strict-mcp-config'));
  assert.doesNotMatch(JSON.stringify({ call, health }), /gateway-fixture-private-key|stale-shell-key|project-controlled-key|must-not-run|untrusted/);
  const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true); assert.equal(settings.env, undefined); assert.equal(settings.permissions.defaultMode, undefined);
});

test('Claude reloads API keys between turns and redacts arbitrary gateway keys in progress and results', async t => {
  const key = 'opaque-fixture-key-first', v = clientFixture(t, { env: { FAKE_CLAUDE_EXPECT_KEY: key, FAKE_CLAUDE_MODE: 'echo-key' } });
  userSettings(v, { env: { ANTHROPIC_API_KEY: key } });
  const first = await v.run(); assert.equal(first.answer, '[密钥已隐藏]'); assert.doesNotMatch(v.progress.join('\n'), /opaque-fixture-key/);
  v.environment.FAKE_CLAUDE_EXPECT_KEY = 'opaque-fixture-key-rotated';
  userSettings(v, { env: { ANTHROPIC_API_KEY: v.environment.FAKE_CLAUDE_EXPECT_KEY } });
  const second = await v.run(); assert.equal(second.answer, '[密钥已隐藏]'); assert.equal(v.calls().length, 2);
  v.environment.FAKE_CLAUDE_MODE = 'key-error';
  await assert.rejects(v.run(), error => error.code === 'turn_failed' && !error.message.includes('opaque-fixture-key') && error.message.includes('[密钥已隐藏]'));
});

test('Claude reads the default home profile and keeps inherited credentials when settings are absent', async t => {
  const key = 'home-profile-key', v = clientFixture(t, { env: { FAKE_CLAUDE_EXPECT_KEY: key } });
  delete v.environment.CLAUDE_CONFIG_DIR; v.environment.USERPROFILE = v.f.root; v.environment.HOME = v.f.root;
  fs.mkdirSync(path.join(v.f.root, '.claude')); fs.writeFileSync(path.join(v.f.root, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: key } }));
  await v.run(); assert.equal(v.calls()[0].credentialMatches, true);
  const inherited = clientFixture(t, { env: { ANTHROPIC_AUTH_TOKEN: key, FAKE_CLAUDE_EXPECT_KEY: key } });
  await inherited.run(); assert.equal(inherited.calls()[0].credentialMatches, true);
});

test('invalid user API settings stop before spawning a model without exposing parser text or credentials', async t => {
  for (const text of ['{"env":{"ANTHROPIC_AUTH_TOKEN":"private-key-that-parser-may-quote"}, BROKEN}', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 42 } })]) {
    const v = clientFixture(t); fs.mkdirSync(v.environment.CLAUDE_CONFIG_DIR); fs.writeFileSync(path.join(v.environment.CLAUDE_CONFIG_DIR, 'settings.json'), text);
    await assert.rejects(v.run(), error => error.code === 'claude_auth_unknown' && !error.message.includes('private-key-that-parser-may-quote'));
    assert.equal(v.calls().length, 0); assert.deepEqual(v.states, []);
  }
});
test('Claude uses actual stream session identity, isolated MCP and exact read-only permissions', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'requires-upfront' } }), answer = await v.run(), call = v.calls()[0];
  assert.equal(answer.threadId, SESSION); assert.equal(answer.answer, '中文实际回答 [密钥已隐藏] Bearer [密钥已隐藏] [密钥已隐藏]');
  assert.deepEqual(v.states, [{ state: 'creating', thread: undefined }, { state: 'bound', thread: SESSION }]);
  const get = name => call.args[call.args.indexOf(name) + 1];
  assert.equal(get('--tools'), 'Read,Glob,Grep'); assert.equal(get('--permission-mode'), 'dontAsk'); assert.equal(get('--permission-prompts'), 'none');
  assert.equal(get('--allowedTools'), ROOM_TOOLS.map(name => `mcp__agentroom__${name}`).join(','));
  assert.ok(call.args.includes('--restricted')); assert.ok(call.args.includes('--strict-mcp-config')); assert.ok(call.args.includes('--disable-slash-commands'));
  assert.ok(!call.args.includes('--bare')); assert.ok(!call.args.includes('--dangerously-skip-permissions')); assert.ok(!call.args.includes('--session-id')); assert.ok(!call.args.includes('--continue'));
  assert.equal(normalizePath(call.cwd), v.project.canonical); assert.equal(call.resumeInterrupted, '0');
  assert.deepEqual(Object.keys(call.config.mcpServers), ['agentroom']); assert.equal(call.config.mcpServers.agentroom.alwaysLoad, true); assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_MEMBER_ID, 'fixture-member');
  assert.match(call.input, /中文问题/); assert.ok(!call.args.some(arg => arg.includes('中文问题')));
  assert.doesNotMatch(v.progress.join('\n'), /progress-secret|stderr|subagent answer/);
  assert.equal(fs.existsSync(get('--mcp-config')), false);
});
test('Claude resumes only the captured session in the same project and never claims print exit is disconnection', async t => {
  const v = clientFixture(t); let disconnected = false; v.client.on('disconnected', () => { disconnected = true; });
  await v.run(); await v.run();
  const calls = v.calls(); assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], SESSION); assert.equal(calls[0].cwd, calls[1].cwd); assert.equal(disconnected, false);
  const other = fixture();
  await assert.rejects(v.run({ project: { ...v.project, path: other.project, canonical: normalizePath(other.project) } }), error => error.code === 'project_mismatch');
  assert.equal(v.calls().length, 2);
});
test('missing authoritative Claude output leaves creation uncertain and cannot create again', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'no-init' } });
  await assert.rejects(v.run(), error => error.code === 'creation_uncertain'); assert.equal(v.discussion.thread_id, null); assert.equal(v.discussion.binding_state, 'creation_uncertain');
  await assert.rejects(v.run(), error => error.code === 'creation_uncertain'); assert.equal(v.calls().length, 1);
});
test('lost result after native binding is uncertain without replay or fabricated completion', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'no-result' } });
  await assert.rejects(v.run(), error => error.code === 'outcome_uncertain'); assert.equal(v.discussion.thread_id, SESSION); assert.equal(v.calls().length, 1);
});
test('timeout before Claude init preserves uncertain creation and kills only owned child', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'hang-before-init' } });
  await assert.rejects(v.run({ timeout: 150 }), error => error.code === 'creation_uncertain');
  // A loaded CI host can terminate the spawned CLI before its JS fixture logs
  // stdin. Either zero or one observed execution is valid; no replay is allowed.
  assert.ok(v.calls().length <= 1); assert.equal(v.states.filter(item => item.state === 'creating').length, 1); assert.equal(v.discussion.binding_state, 'creation_uncertain'); assert.equal(v.client.child, null);
});
test('cancellation after binding preserves native identity and marks execution outcome uncertain', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'hang' } }), controller = new AbortController();
  await assert.rejects(v.run({ signal: controller.signal, onBinding: (state, thread) => { v.states.push({ state, thread }); if (state === 'bound') { v.discussion.thread_id = thread; controller.abort(); } } }), error => error.code === 'outcome_uncertain');
  assert.equal(v.discussion.thread_id, SESSION); assert.equal(v.calls().length, 1); assert.equal(v.client.child, null);
});
test('resumed Claude identity mismatch cannot silently create or bind another session', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'wrong-session' } }); v.discussion.thread_id = SESSION; v.discussion.binding_state = 'bound';
  await assert.rejects(v.run(), error => error.code === 'outcome_uncertain'); assert.equal(v.discussion.thread_id, SESSION); assert.ok(!v.states.some(state => state.thread === OTHER_SESSION));
});
test('Claude verifies initialized cwd and AgentRoom MCP before accepting completion', async t => {
  const failed = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'mcp-failed' } }); await assert.rejects(failed.run(), error => error.code === 'claude_mcp_setup');
  const other = fixture(), wrong = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'wrong-cwd', FAKE_CLAUDE_OTHER_PATH: other.project } });
  await assert.rejects(wrong.run(), error => error.code === 'project_mismatch');
});
test('Claude permission denial is explicit, does not call generic approvals or rerun', async t => {
  const v = clientFixture(t, { env: { FAKE_CLAUDE_MODE: 'denied' } }); let approval = false;
  await assert.rejects(v.run({ onApproval: () => { approval = true; } }), error => error.code === 'claude_permission_denied');
  assert.equal(approval, false); assert.equal(v.calls().length, 1);
});
test('unsupported version and missing login stop before model launch', async t => {
  const old = clientFixture(t, { env: { FAKE_CLAUDE_VERSION: '2.1.258 (Claude Code)' } }); await assert.rejects(old.run(), error => error.code === 'claude_upgrade_required'); assert.equal(old.calls().length, 0); assert.deepEqual(old.states, []);
  const unknown = clientFixture(t, { env: { FAKE_CLAUDE_VERSION: 'some wrapper' } }); await assert.rejects(unknown.run(), error => error.code === 'claude_version_unknown'); assert.equal(unknown.calls().length, 0);
  const login = clientFixture(t, { env: { FAKE_CLAUDE_AUTH: 'false' } }); await assert.rejects(login.run(), error => error.code === 'claude_login_required'); assert.equal(login.calls().length, 0);
});
test('Claude discovery reads installed executable metadata and never executes shell shims', () => {
  const f = fixture(), executable = path.join(f.root, 'claude.exe'), shim = path.join(f.root, 'claude.cmd'); fs.writeFileSync(executable, 'fixture'); fs.writeFileSync(shim, 'fixture');
  assert.equal(detectClaude({ platform: 'win32', env: { AGENTROOM_CLAUDE_PATH: executable, PATH: '' } }), executable);
  assert.equal(detectClaude({ platform: 'win32', env: { AGENTROOM_CLAUDE_PATH: shim, USERPROFILE: f.root, PATH: '' } }), null);
});
test('Claude serializes concurrent preparations and shutdown prevents a late model spawn', async t => {
  const v = clientFixture(t), first = v.run();
  await assert.rejects(v.run(), error => error.code === 'claude_busy'); await first; assert.equal(v.calls().length, 1);
  const closing = clientFixture(t), preparing = closing.run(); await closing.client.close();
  await assert.rejects(preparing, error => error.code === 'connection_lost'); assert.equal(closing.calls().length, 0); assert.deepEqual(closing.states, []);
});
