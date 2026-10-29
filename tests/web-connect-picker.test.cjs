'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function fixture(candidates = []) {
  const elements = new Map(), calls = [], notices = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], showModal() { this.open = true; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, launchScanning: false, launchBusy: false, launchCandidates: candidates,
    launchSelection: new Set(), launchScannedAt: null, launchError: '', lastLaunchCandidates: '', webConnected: true,
    projectId: 'project', roomId: 'room', onboardingStarting: new Set(), onboardingJobs: new Map(),
    secretaryConnectRoom: null, secretaryConnectJob: null, secretaryError: '',
    escape: value => String(value), avatar: () => '', renderSecretary: () => {}, renderLaunch: () => {},
    toast: value => notices.push(value), api: async (route, body) => { calls.push({route,body}); return {candidates,scanned_at:'fixture'}; }
  });
  vm.runInContext(section('function launchProvider(', 'const providerDocs') +
    section('function onboardingCanInstall(', 'function renderLaunch()') +
    section('async function scanLaunch(', 'async function prepareLaunch()') +
    section('function openSecretaryConnect()', 'function updateOfficeScene()'), context);
  return {context, $, calls, notices};
}
test('the picker leads with an AI that can be the secretary, lists what is on this computer and folds the rest', () => {
  const state = fixture([
    {id:'qwen-code',name:'Uninstalled CLI',installable:true,capabilities:{automatic_launch:true}},
    {id:'doubao',name:'Running Doubao',installed:true,running:true,capabilities:{mcp_prepare:true}},
    {id:'qwen-desktop',name:'Running Qwen',installed:true,running:true,capabilities:{mcp_prepare:true}},
    {id:'grok-bot',name:'Running Grok',installed:true,running:true,capabilities:{manual_connect:true}},
    {id:'claude-code',name:'Closed Claude',installed:true,running:false,capabilities:{automatic_launch:true}}
  ]);
  state.context.renderLaunchCandidates();
  const html = state.$('launch-candidates').innerHTML, boundary = html.indexOf('<details'), shown = html.slice(0,boundary);
  assert.ok(boundary > 0);
  assert.ok(shown.indexOf('Closed Claude') >= 0 && shown.indexOf('Closed Claude') < shown.indexOf('Running Doubao'), 'a background AI that can be the secretary comes first');
  assert.match(shown.slice(0, shown.indexOf('Running Doubao')), /推荐当秘书/);
  assert.equal((html.match(/推荐/g) || []).length, 1, 'one recommendation');
  for (const name of ['Running Doubao','Running Qwen','Running Grok']) assert.ok(shown.includes(name));
  assert.equal(shown.includes('Uninstalled CLI'), false);assert.ok(html.slice(boundary).includes('Uninstalled CLI'));
  assert.doesNotMatch(html.slice(boundary).split('>')[0], /\bopen\b/);
  // One label to start, one blue button, and no internal terms.
  assert.deepEqual([...new Set([...shown.matchAll(/data-onboarding-provider="[^"]+"[^>]*>([^<]+)</g)].map(match => match[1]))], ['接入']);
  assert.equal((shown.match(/class="primary onboarding-start"/g) || []).length, 1);
  assert.doesNotMatch(html, /本人对话|桥接|握手|后台 CLI|独立会话|MCP|沿用|一键接入|尚未验证 AO/);
  assert.equal(state.calls.length, 0, 'rendering never installs or starts an agent');
});
test('opening the picker requests one quiet inventory scan and never onboards a member', async () => {
  const state = fixture();
  state.context.openSecretaryConnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.$('secretary-connect-dialog').open, true);
  assert.equal(state.context.secretaryConnectRoom, 'room');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].route, '/api/launch/scan');
  assert.equal(state.notices.length, 0);
  state.context.webConnected = false;
  state.context.openSecretaryConnect();
  assert.equal(state.calls.length, 1);
});

test('an undetected MCP client can prepare its prompt without promising an automatic install',()=>{
  const state=fixture([
    {id:'claude-desktop',name:'Claude desktop',installed:false,support:'needs_setup',capabilities:{mcp_prepare:true}},
    {id:'unsupported',name:'Unsupported',installed:false,support:'unsupported',capabilities:{mcp_prepare:true}}
  ]);
  state.context.renderLaunchCandidates();const html=state.$('launch-candidates').innerHTML;
  assert.match(html,/data-onboarding-provider="claude-desktop"/);
  assert.match(html,/可先复制接入提示词/);assert.doesNotMatch(html,/接入时会自动安装/);
  assert.match(html,/data-onboarding-requirements="unsupported"/);
  assert.equal(state.context.onboardingPromptOnly(state.context.launchCandidates[0]),true);
  assert.equal(state.calls.length,0);
});
test('an AI already connected in this room is marked as such and is not recommended again', () => {
  const state = fixture([{id:'codex',name:'Codex',installed:true,capabilities:{automatic_launch:true}},{id:'claude-code',name:'Claude Code',installed:true,capabilities:{automatic_launch:true}}]);
  state.context.onboardingJobs.set('job',{id:'job',provider:'codex',room_id:'room',status:'ready',stage:'ready_automatic',ready_for_office:true,can_wake:true});
  state.context.renderLaunchCandidates();
  const html = state.$('launch-candidates').innerHTML, codex = html.slice(0, html.indexOf('Claude Code'));
  assert.match(codex, /已在房间里/);assert.match(codex, /disabled>已在房间里/);assert.doesNotMatch(codex, /推荐/);
  assert.match(html.slice(html.indexOf('Claude Code')), /推荐/);
});

test('a requirements-only button has no provider and cannot dereference an absent active connection',()=>{
  const state=fixture();
  state.context.onboardingJobs.set('pending',{id:'pending',provider:'codex',room_id:'room',status:'running',stage:'verifying_reply'});
  for(const provider of [undefined,null,''])assert.equal(state.context.onboardingForProvider(provider),null);
  assert.equal(state.context.onboardingForProvider('codex').id,'pending');
});
