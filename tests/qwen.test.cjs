'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { QwenClient, detectQwen, MIN_VERSION, ROOM_TOOLS, READ_TOOLS, BLOCKED_TOOLS, versionSupported } = require('../src/qwen.cjs');
const { COMMON_OPERATION_INSTRUCTIONS } = require('../src/operation-policy.cjs');
const { fixture, providerTestEnv } = require('./helpers.cjs');
const { id, normalizePath } = require('../src/util.cjs');
const SESSION = '4ca2b4d5-8a9f-4f54-a9aa-ec5ad0b44d43';
const EXPECTED_ROOM_TOOLS = [
  'agentroom_join', 'agentroom_chat_rooms', 'agentroom_chat_history',
  'agentroom_chat_post', 'agentroom_chat_wait', 'agentroom_chat_inbox',
  'agentroom_chat_reply', 'agentroom_chat_ack', 'agentroom_room_state',
  'agentroom_room_ensure', 'agentroom_member_wake', 'agentroom_heartbeat',
  'agentroom_team_state', 'agentroom_member_card', 'agentroom_task_update',
  'agentroom_meeting_report', 'agentroom_brief_ack', 'agentroom_task_create',
  'agentroom_goal_complete', 'agentroom_meeting_start', 'agentroom_meeting_discuss',
  'agentroom_meeting_close'
];
function assertBoundedInvocation(call) {
  const get = name => call.args[call.args.indexOf(name) + 1];
  assert.equal(get('--approval-mode'), 'default');
  assert.equal(get('--allowed-mcp-server-names'), 'agentroom');
  assert.deepEqual(get('--allowed-tools').split(','), EXPECTED_ROOM_TOOLS.map(name => `mcp__agentroom__${name}`));
  assert.deepEqual(call.config.mcpServers.agentroom.includeTools, EXPECTED_ROOM_TOOLS);
  assert.deepEqual(Object.keys(call.config.mcpServers), ['agentroom']);
  assert.equal(call.safeMode, 'true'); assert.equal(call.retry, '0');
  assert.ok(call.args.includes('--safe-mode'));
  for (const forbidden of ['--yolo', '--continue', '--approval-policy', '--permission-mode']) assert.ok(!call.args.includes(forbidden));
  const excluded = new Set(get('--exclude-tools').split(','));
  for (const tool of ['exec', 'edit', 'write_file', 'run_shell_command', 'agent', 'skill', 'web_fetch', 'web_search', 'cron_create', 'send_message']) assert.ok(excluded.has(tool), tool);
  assert.equal(typeof COMMON_OPERATION_INSTRUCTIONS, 'string'); assert.ok(COMMON_OPERATION_INSTRUCTIONS.trim());
  assert.ok(get('--append-system-prompt').includes(COMMON_OPERATION_INSTRUCTIONS));
}
const FAKE = String.raw`
'use strict';
const fs=require('node:fs'); const args=process.argv.slice(2), env=process.env;
const at=name=>args.indexOf(name)<0?undefined:args[args.indexOf(name)+1];
const mode=env.FAKE_QWEN_MODE||'success';
if(args.includes('--version')){process.stdout.write(env.FAKE_QWEN_VERSION||'0.25.1');process.exit(0);}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
const config=JSON.parse(fs.readFileSync(at('--mcp-config'),'utf8'));
fs.appendFileSync(env.FAKE_QWEN_LOG,JSON.stringify({args,cwd:process.cwd(),config,input,safeMode:env.QWEN_CODE_SAFE_MODE,retry:env.QWEN_CODE_UNATTENDED_RETRY,normalAuthPreserved:env.OPENAI_API_KEY==='sk-provider-test-secret'})+'\n');
if(mode==='no-init'){console.log('not a protocol event');process.exit(0);}
if(mode==='hang-before-init'){setInterval(()=>{},1000);return;}
const session=mode==='wrong-session'?'34e8a2f4-2535-495b-b60a-6fdf334bb01a':(at('--resume')||'4ca2b4d5-8a9f-4f54-a9aa-ec5ad0b44d43');
const tools=['read_file','glob','grep_search','list_directory',...config.mcpServers.agentroom.includeTools.map(t=>'mcp__agentroom__'+t)];
if(mode==='unsafe-tool')tools.push('run_shell_command');
if(mode==='unknown-tool')tools.push('future_execute_tool');
if(mode==='unsafe-mcp')tools.push('mcp__agentroom__agentroom_group_prepare');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,cwd:mode==='wrong-cwd'?env.FAKE_QWEN_OTHER_PATH:process.cwd(),tools,permission_mode:mode==='unsafe-permissions'?'yolo':'default',mcp_servers:[{name:'agentroom',status:mode==='mcp-failed'?'disconnected':'connected'}]}));
if(mode==='no-result'){process.exit(0);}
if(mode==='hang'){setInterval(()=>{},1000);return;}
process.stderr.write('sk-provider-test-secret Bearer private-stderr\n');
console.log(JSON.stringify({type:'stream_event',session_id:session,event:{delta:{type:'text_delta',text:'检查中文 sk-progress-secret'}}}));
console.log(JSON.stringify({type:'assistant',session_id:session,parent_tool_use_id:'child',message:{content:[{type:'text',text:'subagent answer is not final'}]}}));
console.log(JSON.stringify({type:'result',subtype:mode==='denied'?'error_during_execution':'success',is_error:mode==='denied',session_id:session,uuid:'06fbd02b-3e61-4ba8-8e90-0249880706a3',result:mode==='denied'?'provider auth token=never-forward-this':'中文实际回答 sk-final-secret Bearer secret crsr_test-secret',permission_denials:mode==='denied'?[{tool_name:'run_shell_command',tool_input:{command:'private-command'}}]:[]}));
process.exit(mode==='denied'?1:0);
});
`;
function clientFixture(t, options = {}) {
  const f = fixture(), fake = path.join(f.root, 'fake-qwen.cjs'), log = path.join(f.root, 'argv.jsonl');
  fs.writeFileSync(fake, FAKE);
  const environment = { ...providerTestEnv(), FAKE_QWEN_LOG: log, USERPROFILE: f.root, OPENAI_API_KEY: 'sk-provider-test-secret', ...options.env };
  const client = new QwenClient({ executable: process.execPath, args: [fake], dataDir: f.data, homeDir: f.root, mcpEnvironment: { AGENTROOM_MEMBER_ID: 'fixture-member' }, env: environment });
  t.after(() => client.close());
  const project = { id: id(), name: '中文测试项目', path: f.project, canonical: normalizePath(f.project), access: 'read-only' };
  const discussion = { id: id(), title: '中文讨论', binding_state: 'new', thread_id: null };
  const states = [], progress = [], turns = [];
  const run = extra => client.run({ project, discussion, request: { id: id(), sender: 'fixture-peer', prompt: '请回答中文问题；$(noop) `不执行`' }, onBinding: (state, thread) => { states.push({ state, thread }); discussion.binding_state = state; if (thread) discussion.thread_id = thread; }, onTurn: turn => turns.push(turn), onProgress: text => progress.push(text), signal: new AbortController().signal, ...extra });
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { f, client, project, discussion, environment, states, progress, turns, run, calls };
}
test('Qwen metadata does not call model or falsely claim verified authentication', async t => {
  const v = clientFixture(t), health = await v.client.status();
  assert.equal(health.version, MIN_VERSION); assert.equal(health.authConfigured, true); assert.equal(health.authVerified, false); assert.equal(health.signedIn, null);
  assert.equal(health.access, 'read-only'); assert.equal(v.calls().length, 0); assert.doesNotMatch(JSON.stringify(health), /sk-provider|Bearer|token/);
  assert.equal(versionSupported(MIN_VERSION), true); assert.equal(versionSupported('0.25.0'), false); assert.equal(versionSupported('unknown'), false);
});
test('Qwen preserves configured provider auth while excluding ambient hooks and dangerous tools', async t => {
  const v = clientFixture(t), answer = await v.run(), call = v.calls()[0];
  assertBoundedInvocation(call);
  assert.equal(answer.threadId, SESSION); assert.equal(answer.answer, '中文实际回答 [密钥已隐藏] Bearer [密钥已隐藏] [密钥已隐藏]');
  assert.deepEqual(v.states, [{ state: 'creating', thread: undefined }, { state: 'bound', thread: SESSION }]);
  const get = name => call.args[call.args.indexOf(name) + 1];
  assert.equal(get('--approval-mode'), 'default'); assert.equal(get('--allowed-mcp-server-names'), 'agentroom');
  assert.equal(get('--allowed-tools'), ROOM_TOOLS.map(name => `mcp__agentroom__${name}`).join(','));
  for (const dangerous of BLOCKED_TOOLS) assert.ok(get('--exclude-tools').split(',').includes(dangerous));
  assert.match(get('--exclude-tools'), /Read\(\/\/\*\*\/\.qwen\/\*\*\)/); assert.equal(call.safeMode, 'true'); assert.equal(call.retry, '0');
  assert.equal(call.normalAuthPreserved, true); assert.ok(call.args.includes('--safe-mode'));
  assert.ok(!call.args.includes('--core-tools')); assert.ok(!call.args.includes('--bare')); assert.ok(!call.args.includes('--yolo')); assert.ok(!call.args.includes('--continue'));
  assert.deepEqual(Object.keys(call.config.mcpServers), ['agentroom']); assert.deepEqual(call.config.mcpServers.agentroom.includeTools, [...ROOM_TOOLS]);
  assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_CALLER, 'qwen-code'); assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_MEMBER_ID, 'fixture-member');
  assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_ROOM_ID, v.discussion.id);
  assert.equal(normalizePath(call.cwd), v.project.canonical); assert.match(call.input, /中文问题/); assert.ok(!call.args.some(arg => arg.includes('中文问题')));
  assert.doesNotMatch(v.progress.join('\n'), /progress-secret|stderr|subagent answer/); assert.equal(fs.existsSync(get('--mcp-config')), false);
});
test('Qwen keeps the same person session and bounded policy when its assigned room changes', async t => {
  const v = clientFixture(t); let disconnected = false; v.client.on('disconnected', () => { disconnected = true; });
  const firstRoom = v.discussion.id;
  await v.run(); v.discussion.id = id(); await v.run(); const calls = v.calls(); assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], SESSION); assert.equal(calls[0].cwd, calls[1].cwd); assert.equal(disconnected, false);
  assert.ok(!calls[0].args.includes('--resume')); assert.equal(v.discussion.thread_id, SESSION);
  assert.equal(v.states.filter(state => state.state === 'creating').length, 1);
  for (const call of calls) { assertBoundedInvocation(call); assert.equal(call.config.mcpServers.agentroom.env.AGENTROOM_MEMBER_ID, 'fixture-member'); }
  assert.equal(calls[0].config.mcpServers.agentroom.env.AGENTROOM_ROOM_ID, firstRoom);
  assert.equal(calls[1].config.mcpServers.agentroom.env.AGENTROOM_ROOM_ID, v.discussion.id);
  assert.match(calls[1].input, /中文问题/);
  const other = fixture(); await assert.rejects(v.run({ project: { ...v.project, path: other.project, canonical: normalizePath(other.project) } }), error => error.code === 'project_mismatch');
  assert.equal(v.calls().length, 2);
});
test('Qwen refuses dangerous unknown or management tools and altered permission mode', async t => {
  for (const mode of ['unsafe-tool', 'unknown-tool', 'unsafe-mcp', 'unsafe-permissions']) {
    const v = clientFixture(t, { env: { FAKE_QWEN_MODE: mode } }); await assert.rejects(v.run(), error => error.code === 'qwen_tool_scope_mismatch');
    assert.equal(v.calls().length, 1);
  }
  assert.deepEqual(READ_TOOLS, ['read_file', 'grep_search', 'glob', 'list_directory']);
});
test('missing authoritative Qwen output makes creation uncertain and prevents automatic recreation', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'no-init' } });
  await assert.rejects(v.run(), error => error.code === 'creation_uncertain'); assert.equal(v.discussion.thread_id, null); assert.equal(v.discussion.binding_state, 'creation_uncertain');
  await assert.rejects(v.run(), error => error.code === 'creation_uncertain'); assert.equal(v.calls().length, 1);
});
test('Qwen missing result preserves bound identity and reports uncertain outcome', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'no-result' } });
  await assert.rejects(v.run(), error => error.code === 'outcome_uncertain'); assert.equal(v.discussion.thread_id, SESSION); assert.equal(v.calls().length, 1);
});
test('Qwen timeout before init retains creation uncertainty and kills only its owned child', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'hang-before-init' } });
  // Allow the fixture to start under the full Windows suite before its bounded timeout.
  await assert.rejects(v.run({ timeout: 2000 }), error => error.code === 'creation_uncertain'); assert.equal(v.discussion.binding_state, 'creation_uncertain'); assert.equal(v.calls().length, 1); assert.equal(v.client.child, null);
});
test('Qwen cancellation after native binding never reruns the question', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'hang' } }), controller = new AbortController();
  await assert.rejects(v.run({ signal: controller.signal, onBinding: (state, thread) => { v.states.push({ state, thread }); if (state === 'bound') { v.discussion.thread_id = thread; controller.abort(); } } }), error => error.code === 'outcome_uncertain');
  assert.equal(v.discussion.thread_id, SESSION); assert.equal(v.calls().length, 1); assert.equal(v.client.child, null);
});
test('Qwen rejects a changed resume identity without rebinding another session', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'wrong-session' } }); v.discussion.thread_id = SESSION; v.discussion.binding_state = 'bound';
  await assert.rejects(v.run(), error => error.code === 'outcome_uncertain'); assert.equal(v.discussion.thread_id, SESSION); assert.equal(v.states.length, 0);
});
test('Qwen verifies native cwd and connected dedicated MCP before claiming completion', async t => {
  const failed = clientFixture(t, { env: { FAKE_QWEN_MODE: 'mcp-failed' } }); await assert.rejects(failed.run(), error => error.code === 'qwen_mcp_setup');
  const other = fixture(), wrong = clientFixture(t, { env: { FAKE_QWEN_MODE: 'wrong-cwd', FAKE_QWEN_OTHER_PATH: other.project } });
  await assert.rejects(wrong.run(), error => error.code === 'project_mismatch');
});
test('Qwen permission denial is explicit and provider diagnostics stay private', async t => {
  const v = clientFixture(t, { env: { FAKE_QWEN_MODE: 'denied' } }); let approval = false;
  await assert.rejects(v.run({ onApproval: () => { approval = true; } }), error => error.code === 'qwen_permission_denied' && !/token|never-forward/.test(error.message));
  assert.equal(approval, false); assert.equal(v.calls().length, 1);
  assertBoundedInvocation(v.calls()[0]);
});
test('unsupported Qwen version and absent independent authentication stop before model launch', async t => {
  const old = clientFixture(t, { env: { FAKE_QWEN_VERSION: '0.25.0' } }); await assert.rejects(old.run(), error => error.code === 'qwen_upgrade_required'); assert.equal(old.calls().length, 0);
  const unknown = clientFixture(t, { env: { FAKE_QWEN_VERSION: 'some wrapper' } }); await assert.rejects(unknown.run(), error => error.code === 'qwen_version_unknown'); assert.equal(unknown.calls().length, 0);
  const keys = Object.fromEntries(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY', 'BAILIAN_TOKEN_PLAN_API_KEY', 'OPENROUTER_API_KEY', 'REQUESTY_API_KEY'].map(key => [key, '']));
  const login = clientFixture(t, { env: keys }); await assert.rejects(login.run(), error => error.code === 'qwen_login_required'); assert.equal(login.calls().length, 0); assert.equal((await login.client.status()).authConfigured, false);
  fs.mkdirSync(path.join(login.f.root, '.qwen'), { recursive: true }); fs.writeFileSync(path.join(login.f.root, '.qwen', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'qwen-oauth' } } }));
  await assert.rejects(login.run(), error => error.code === 'qwen_login_required'); assert.equal(login.calls().length, 0);
});
test('Qwen configured CLI metadata is distinct from consumer desktop account and never exports keys', async t => {
  const v = clientFixture(t, { env: { OPENAI_API_KEY: '' } });
  fs.mkdirSync(path.join(v.f.root, '.qwen'), { recursive: true }); fs.writeFileSync(path.join(v.f.root, '.qwen', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai', apiKey: 'sk-private-config-value' } }, modelProviders: { openai: [{ id: 'private-model', envKey: 'PRIVATE_KEY' }] } }));
  const health = await v.client.status(); assert.equal(health.authType, 'openai'); assert.equal(health.authConfigured, true); assert.equal(health.authVerified, false);
  assert.doesNotMatch(JSON.stringify(health), /private-model|PRIVATE_KEY|private-config/); assert.equal(v.calls().length, 0);
  fs.writeFileSync(path.join(v.f.root, '.qwen', 'settings.json'), '\uFEFF{ // locally configured provider\n"security": { "auth": { "selectedType": "anthropic", }, }, "example": "https://provider.invalid/", }');
  assert.equal((await v.client.status()).authType, 'anthropic');
});
test('Qwen executable metadata never treats shell shims as executable transports', () => {
  const f = fixture(), executable = path.join(f.root, 'qwen.exe'), shim = path.join(f.root, 'qwen.cmd'); fs.writeFileSync(executable, 'fixture'); fs.writeFileSync(shim, 'fixture');
  assert.equal(detectQwen({ platform: 'win32', env: { AGENTROOM_QWEN_CODE_PATH: executable, PATH: '' } }), executable);
  assert.equal(detectQwen({ platform: 'win32', env: { AGENTROOM_QWEN_CODE_PATH: shim, USERPROFILE: f.root, PATH: '' } }), null);
});
test('Qwen serializes preparation and shutdown blocks a late provider spawn', async t => {
  const v = clientFixture(t), first = v.run(); await assert.rejects(v.run(), error => error.code === 'qwen_busy'); await first; assert.equal(v.calls().length, 1);
  const closing = clientFixture(t), preparing = closing.run(); await closing.client.close(); await assert.rejects(preparing, error => error.code === 'connection_lost'); assert.equal(closing.calls().length, 0); assert.deepEqual(closing.states, []);
});
